import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import twilio from "twilio";
import { timingSafeEqual } from "node:crypto";
import { createRepository } from "./store.js";

const digits = (value) => String(value || "").replace(/\D/g, "");
const sameNumber = (a, b) => !!digits(a) && digits(a) === digits(b);
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const bearer = (request) =>
  String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] ||
  "";

export async function createServer({
  config,
  store,
  providers,
  clock = () => new Date(),
}) {
  const app = Fastify({
    logger: false,
    trustProxy: config.trustedProxyHops || false,
  });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.webAllowedOrigins?.includes(origin))
        callback(null, true);
      else callback(null, false);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"],
  });
  await app.register(formbody);
  await app.register(websocket);
  const repository = createRepository(store, config);
  await repository.ready;
  const appClients = new Set();
  const pairingAttempts = new Map();
  const runtimeIssues = new Map();

  const send = (socket, message) => {
    try {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    } catch {}
  };
  const broadcast = (message) => {
    for (const socket of appClients) send(socket, message);
  };
  app.decorate("loro", { repository, broadcast });
  const status = () => {
    const issues = [];
    if (!config.publicBaseUrl)
      issues.push({
        code: "PUBLIC_URL_MISSING",
        message: "The server public URL is not configured.",
      });
    const targetLoops =
      sameNumber(config.targetPhoneNumber, config.twilioPhoneNumber) ||
      config.forwardingSourceNumbers.some((number) =>
        sameNumber(number, config.targetPhoneNumber),
      );
    if (!config.targetPhoneNumber)
      issues.push({
        code: "PHONE_ROUTE_MISSING",
        message: "The reliable phone answering line is not configured.",
      });
    else if (targetLoops)
      issues.push({
        code: "PHONE_ROUTE_LOOP",
        message: "The answering line would forward back into this service.",
      });
    if (!config.twilioPhoneNumber || !config.twilioAuthToken)
      issues.push({
        code: "TWILIO_NOT_READY",
        message: "Call routing credentials are incomplete.",
      });
    if (!config.deepgramApiKey)
      issues.push({
        code: "TRANSCRIPTION_NOT_READY",
        message: "Live English transcription is not configured.",
      });
    if (!config.anthropicApiKey)
      issues.push({
        code: "TRANSLATION_NOT_READY",
        message: "Spanish translation is not configured.",
      });
    const push = providers.pushStatus?.() || {
      configured: !!(config.firebaseServiceAccountJson || config.googleApplicationCredentials),
      deliveryReady: false,
    };
    if (push.error)
      issues.push({ code: "PUSH_UNAVAILABLE", message: "Android push delivery is unavailable." });
    issues.push(...runtimeIssues.values());
    return {
      type: "service_status",
      service: issues.length ? "degraded" : "ready",
      routingReady: !!(
        config.publicBaseUrl &&
        config.targetPhoneNumber &&
        !targetLoops &&
        config.twilioPhoneNumber &&
        config.twilioAuthToken
      ),
      translationReady:
        !!(config.deepgramApiKey && config.anthropicApiKey) &&
        !runtimeIssues.has("TRANSCRIPTION_INTERRUPTED"),
      appAnswerEnabled: config.enableAppAnswer,
      push,
      issues,
    };
  };
  const reportRuntimeIssue = (code, message, callId) => {
    runtimeIssues.set(code, { code, message, ...(callId ? { callId } : {}) });
    broadcast(status());
  };
  const clearRuntimeIssue = (code) => {
    if (runtimeIssues.delete(code)) broadcast(status());
  };
  const clearCallRuntimeIssues = () => {
    let changed = false;
    for (const [code, issue] of runtimeIssues) {
      if (issue.callId) {
        runtimeIssues.delete(code);
        changed = true;
      }
    }
    if (changed) broadcast(status());
  };
  const dismissIncoming = async (callSid) => {
    if (!callSid || !(await repository.clearIncoming(callSid))) return false;
    broadcast({ type: "call_ended", callSid });
    void repository.pushTokens("fcm")
      .then((tokens) => notifyWithTimeout(tokens, { type: "call_ended", callSid, ttlMs: 45_000 }))
      .then(async (result) => {
        if (result?.invalidTokens?.length) await repository.removePushTokens(result.invalidTokens);
        clearRuntimeIssue("PUSH_DELIVERY_FAILED");
      })
      .catch(() => reportRuntimeIssue("PUSH_DELIVERY_FAILED", "Android incoming-call dismissal failed.", undefined));
    return true;
  };
  const notifyWithTimeout = async (tokens, payload) => {
    let timer;
    try {
      return await Promise.race([
        providers.notify(tokens, payload),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("push provider timed out")), config.pushTimeoutMs || 2500); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const requireAuth = async (request, reply) => {
    if (!(await repository.hasToken(bearer(request))))
      return reply
        .code(401)
        .send({
          error: { code: "UNAUTHORIZED", message: "Pair this device again." },
        });
  };
  const externalUrl = (path) => `${config.publicBaseUrl}${path}`;
  const validTwilio = (request, params = {}) =>
    !!(
      config.publicBaseUrl &&
      config.twilioAuthToken &&
      twilio.validateRequest(
        config.twilioAuthToken,
        String(request.headers["x-twilio-signature"] || ""),
        externalUrl(request.raw.url),
        params,
      )
    );
  const validTwilioWebSocket = (request) => {
    if (!config.publicBaseUrl || !config.twilioAuthToken) return false;
    const signature = String(request.headers["x-twilio-signature"] || "");
    const path = request.raw.url.endsWith("/")
      ? request.raw.url.slice(0, -1)
      : request.raw.url;
    const httpsUrl = externalUrl(path);
    const streamUrl = new URL(httpsUrl);
    streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
    const candidates = [
      httpsUrl,
      `${httpsUrl}/`,
      streamUrl.toString().replace(/\/$/, ""),
      streamUrl.toString().replace(/\/$/, "") + "/",
    ];
    return [...new Set(candidates)].some((url) =>
      twilio.validateRequest(config.twilioAuthToken, signature, url, {}),
    );
  };

  app.get("/health", async () => ({
    ok: true,
    service: "call-translator-backend",
    protocolVersion: 2,
  }));
  app.post("/pair", async (request, reply) => {
    if (!config.pairingCode)
      return reply
        .code(503)
        .send({
          error: {
            code: "PAIRING_NOT_CONFIGURED",
            message:
              "Pairing is not available. Ask the app owner to configure a new setup code.",
          },
        });
    const now = clock().getTime();
    const recent = (pairingAttempts.get(request.ip) || []).filter(
      (value) => now - value < config.pairingWindowMs,
    );
    if (pairingAttempts.size > 1000)
      for (const [ip, attempts] of pairingAttempts) {
        if (!attempts.some((value) => now - value < config.pairingWindowMs))
          pairingAttempts.delete(ip);
      }
    if (!pairingAttempts.has(request.ip) && pairingAttempts.size >= 1000)
      return reply
        .code(429)
        .send({
          error: {
            code: "PAIRING_RATE_LIMITED",
            message:
              "Pairing is temporarily busy. Wait a minute and try again.",
          },
        });
    if (recent.length >= config.pairingMaxAttempts)
      return reply
        .code(429)
        .send({
          error: {
            code: "PAIRING_RATE_LIMITED",
            message: "Too many attempts. Wait a minute and try again.",
          },
        });
    recent.push(now);
    pairingAttempts.set(request.ip, recent);
    const code = String(request.body?.code || "");
    if (!safeEqual(code, config.pairingCode))
      return reply
        .code(401)
        .send({
          error: {
            code: "PAIRING_CODE_INVALID",
            message: "That setup code is not valid.",
          },
        });
    const deviceId = String(request.body?.deviceId || "");
    if (deviceId && !/^[A-Za-z0-9_-]{16,128}$/.test(deviceId))
      return reply.code(400).send({
        error: {
          code: "DEVICE_ID_INVALID",
          message: "This device identifier is not valid.",
        },
      });
    let token;
    try {
      token = await repository.consumePairingCode(code, deviceId);
    } catch {
      return reply.code(503).send({
        error: {
          code: "PAIRING_STORAGE_UNAVAILABLE",
          message: "Pairing could not be saved. Try again shortly.",
        },
      });
    }
    if (!token)
      return reply
        .code(409)
        .send({
          error: {
            code: "PAIRING_CODE_USED",
            message:
              "That one-time setup code has already been used. Configure a new code to pair another device.",
          },
        });
    return reply.code(201).send({ token });
  });
  app.get("/status", { preHandler: requireAuth }, async () => status());
  app.post(
    "/devices/push",
    { preHandler: requireAuth },
    async (request, reply) => {
      const token = String(request.body?.token || "");
      const provider = String(request.body?.provider || "");
      if (provider !== "fcm" || !/^[A-Za-z0-9:_-]{20,4096}$/.test(token))
        return reply
          .code(400)
          .send({
            error: {
              code: "PUSH_TOKEN_INVALID",
              message: "The notification token is not valid.",
            },
          });
      await repository.registerPushToken(token, provider, bearer(request));
      return reply.code(204).send();
    },
  );
  app.delete("/devices/push", { preHandler: requireAuth }, async (request, reply) => {
    await repository.removePushToken(bearer(request));
    return reply.code(204).send();
  });

  app.get("/app", { websocket: true }, (socket) => {
    send(socket, { type: "hello", protocolVersion: 2, authRequired: true });
    const timer = setTimeout(() => {
      send(socket, {
        type: "auth_error",
        code: "AUTH_TIMEOUT",
        message: "Authentication timed out.",
      });
      socket.close(4401, "authentication required");
    }, config.authTimeoutMs);
    let authenticated = false;
    const handleAppMessage = async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        message = {};
      }
      if (authenticated) {
        if (message.type === "ping")
          send(socket, { type: "pong", timestamp: clock().toISOString() });
        return;
      }
      if (
        message.type !== "auth" ||
        !(await repository.hasToken(message.token))
      ) {
        clearTimeout(timer);
        send(socket, {
          type: "auth_error",
          code: "UNAUTHORIZED",
          message: "Pair this device again.",
        });
        return socket.close(4401, "unauthorized");
      }
      authenticated = true;
      clearTimeout(timer);
      appClients.add(socket);
      send(socket, { type: "snapshot", calls: await repository.snapshot(), incomingCalls: await repository.incomingCalls(clock().getTime()) });
      send(socket, status());
    };
    socket.on("message", (raw) => {
      void handleAppMessage(raw).catch(() => {
        clearTimeout(timer);
        appClients.delete(socket);
        send(socket, {
          type: "auth_error",
          code: "AUTH_FAILED",
          message: "The connection could not be authenticated.",
        });
        socket.close(1011, "authentication failed");
      });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      appClients.delete(socket);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      appClients.delete(socket);
    });
  });

  app.post("/voice", async (request, reply) => {
    const body = request.body || {};
    if (!validTwilio(request, body))
      return reply.code(403).send({ error: "invalid Twilio signature" });
    const from = String(body.From || "");
    const response = new twilio.twiml.VoiceResponse();
    if (sameNumber(from, config.twilioPhoneNumber)) {
      response.hangup();
      return reply.type("text/xml").send(response.toString());
    }
    const badTarget =
      !config.targetPhoneNumber ||
      sameNumber(config.targetPhoneNumber, config.twilioPhoneNumber) ||
      config.forwardingSourceNumbers.some((number) =>
        sameNumber(number, config.targetPhoneNumber),
      );
    const legs = [];
    if (!badTarget) legs.push(["number", config.targetPhoneNumber]);
    if (config.enableAppAnswer && config.clientIdentity)
      legs.push(["client", config.clientIdentity]);
    if (!legs.length) {
      response.say("This line is not available right now. Goodbye.");
      response.hangup();
      return reply.type("text/xml").send(response.toString());
    }
    const callSid = String(body.CallSid || "");
    const receivedAt = String(clock().getTime());
    const ttlMs = Math.min(45_000, Math.max(1_000, (config.ringTimeoutSeconds + 5) * 1000));
    const expiresAt = String(Number(receivedAt) + ttlMs);
    if (callSid) {
      try {
        const { created, call } = await repository.beginIncoming(callSid, from, receivedAt, expiresAt);
        if (created) {
          // This happens before Twilio receives the media/dial instructions.
          broadcast({ type: "incoming_call", ...call });
          void repository.pushTokens("fcm")
            .then((tokens) => notifyWithTimeout(tokens, { type: "incoming_call", ...call, ttlMs }))
            .then(async (result) => {
              if (result?.invalidTokens?.length) await repository.removePushTokens(result.invalidTokens);
              clearRuntimeIssue("PUSH_DELIVERY_FAILED");
            })
            .catch(() => reportRuntimeIssue("PUSH_DELIVERY_FAILED", "Android incoming-call delivery failed. Phone routing continues.", undefined));
        }
      } catch {
        reportRuntimeIssue("PUSH_STATE_FAILED", "Incoming call state could not be saved. Phone routing continues.", undefined);
      }
    }
    const streamUrl = new URL(config.publicBaseUrl);
    streamUrl.protocol = "wss:";
    streamUrl.pathname = `${streamUrl.pathname.replace(/\/$/, "")}/media`;
    const stream = response
      .start()
      .stream({ url: streamUrl.toString(), track: "both_tracks" });
    stream.parameter({ name: "from", value: from });
    stream.parameter({ name: "callSid", value: callSid });
    const dial = response.dial({
      callerId: config.twilioPhoneNumber || from,
      answerOnBridge: true,
      timeout: config.ringTimeoutSeconds,
      action: externalUrl("/voice/dial-complete"),
    });
    for (const [kind, value] of legs)
      kind === "number"
        ? dial.number({ statusCallback: externalUrl("/voice/status"), statusCallbackEvent: ["completed"] }, value)
        : dial.client(value);
    return reply.type("text/xml").send(response.toString());
  });

  app.post("/voice/status", async (request, reply) => {
    const body = request.body || {};
    if (!validTwilio(request, body)) return reply.code(403).send({ error: "invalid Twilio signature" });
    if (["completed", "busy", "failed", "no-answer", "canceled"].includes(String(body.CallStatus || body.DialCallStatus || "").toLowerCase()))
      await dismissIncoming(String(body.ParentCallSid || body.CallSid || ""));
    return reply.code(204).send();
  });
  app.post("/voice/dial-complete", async (request, reply) => {
    const body = request.body || {};
    if (!validTwilio(request, body)) return reply.code(403).send({ error: "invalid Twilio signature" });
    await dismissIncoming(String(body.CallSid || ""));
    return reply.type("text/xml").send(new twilio.twiml.VoiceResponse().toString());
  });

  app.get(
    "/media",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!validTwilioWebSocket(request)) return reply.code(403).send();
      },
    },
    (socket) => {
      let call;
      let incomingCallSid = "";
      let startPromise;
      let finishing;
      let stopRequested = false;
      let acceptingTranscripts = true;
      let nextTurn = 1;
      let orderedFlush = Promise.resolve();
      let translating = 0;
      const callbacks = new Set();
      const handleTranscript = (speaker, text, final) => {
        if (!acceptingTranscripts || !call || !final) {
          if (acceptingTranscripts && call && text)
            broadcast({
              type: "interim",
              callId: call.callId,
              speaker,
              en: text,
            });
          return;
        }
        const job = (async () => {
          const turn = {
            id: `${call.callId}:${nextTurn++}`,
            speaker,
            en: text,
            es: "",
            translationStatus: "pending",
            timestamp: clock().toISOString(),
          };
          await repository.addTurn(call.callId, turn);
          broadcast({ type: "turn", callId: call.callId, ...turn });
          let result;
          if (translating >= config.maxPendingTranslations)
            result = Promise.resolve({ es: "", translationStatus: "failed" });
          else {
            translating++;
            result = providers
              .translate(text)
              .then(
                (es) => ({ es, translationStatus: es ? "complete" : "failed" }),
                () => ({ es: "", translationStatus: "failed" }),
              )
              .finally(() => {
                translating--;
              });
          }
          orderedFlush = orderedFlush
            .catch(() => {})
            .then(async () => {
              const patch = await result;
              await repository.updateTurn(call.callId, turn.id, patch);
              broadcast({
                type: "turn",
                callId: call.callId,
                ...turn,
                ...patch,
              });
            })
            .catch(() =>
              reportRuntimeIssue(
                "STORAGE_WRITE_FAILED",
                "Call history could not be saved. The phone call can continue.",
                call.callId,
              ),
            );
          await orderedFlush;
        })();
        callbacks.add(job);
        void job.finally(() => callbacks.delete(job)).catch(() => {});
      };
      const sides = ["caller", "dad"].map((speaker) => {
        const queued = [];
        let queuedBytes = 0;
        let translationChain = Promise.resolve();
        const transcriber = providers.openTranscriber(
          (text, final) => handleTranscript(speaker, text, final),
          () =>
            reportRuntimeIssue(
              "TRANSCRIPTION_INTERRUPTED",
              "Live captions stopped for this call. The phone call can continue.",
              call?.callId,
            ),
        );
        transcriber.onReady(() => {
          clearRuntimeIssue("TRANSCRIPTION_INTERRUPTED");
          while (queued.length && transcriber.ready) {
            const chunk = queued.shift();
            queuedBytes -= chunk.length;
            transcriber.send(chunk);
          }
        });
        return {
          speaker,
          transcriber,
          send(chunk) {
            if (transcriber.ready) transcriber.send(chunk);
            else if (queuedBytes + chunk.length <= config.maxQueuedAudioBytes) {
              queued.push(chunk);
              queuedBytes += chunk.length;
            }
          },
        };
      });
      const finish = () =>
        (finishing ||= (async () => {
          await startPromise;
          await Promise.allSettled(
            sides.map((side) =>
              side.transcriber.finish(config.providerCloseTimeoutMs),
            ),
          );
          acceptingTranscripts = false;
          while (callbacks.size) await Promise.allSettled([...callbacks]);
          await orderedFlush;
          if (!call) return;
          let ended;
          try {
            ended = await repository.endCall(call.callId, clock());
          } catch {
            reportRuntimeIssue(
              "STORAGE_WRITE_FAILED",
              "Call history could not be saved. The phone call can continue.",
              call.callId,
            );
            return;
          }
          broadcast({
            type: "call_end",
            callId: call.callId,
            endedAt: ended.endedAt,
          });
          await dismissIncoming(incomingCallSid);
          let summary = "";
          try {
            summary = await providers.summarize(ended.turns);
          } catch {}
          const summaryStatus = summary ? "complete" : "failed";
          try {
            await repository.setSummary(call.callId, summary, summaryStatus);
          } catch {
            reportRuntimeIssue(
              "STORAGE_WRITE_FAILED",
              "The call summary could not be saved.",
              call.callId,
            );
          }
          broadcast({
            type: "summary",
            callId: call.callId,
            text: summary,
            status: summaryStatus,
          });
        })().catch(() =>
          reportRuntimeIssue(
            "CALL_PROCESSING_FAILED",
            "Live call processing stopped. The phone call can continue.",
            call?.callId,
          ),
        ));
      const handleMediaMessage = async (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.event === "start" && !startPromise) {
          startPromise = repository
            .startCall(message.start?.customParameters?.from || "", clock())
            .then((created) => {
              call = created;
              const streamCallSid = String(message.start?.customParameters?.callSid || "");
              incomingCallSid = streamCallSid;
              clearCallRuntimeIssues();
              broadcast({
                type: "call_start",
                callId: call.callId,
                ...(incomingCallSid ? { callSid: incomingCallSid } : {}),
                from: call.from,
                startedAt: call.startedAt,
              });
              return call;
            });
          await startPromise;
          if (stopRequested) void finish();
        } else if (message.event === "media") {
          if (!startPromise) return;
          await startPromise;
          const chunk = Buffer.from(message.media?.payload || "", "base64");
          sides[message.media?.track === "outbound" ? 1 : 0].send(chunk);
        } else if (message.event === "stop") {
          stopRequested = true;
          if (startPromise) void finish();
        }
      };
      socket.on("message", (raw) => {
        void handleMediaMessage(raw).catch(() =>
          reportRuntimeIssue(
            "CALL_PROCESSING_FAILED",
            "Live call processing stopped. The phone call can continue.",
            call?.callId,
          ),
        );
      });
      socket.on("close", () => {
        stopRequested = true;
        if (startPromise) void finish();
      });
      socket.on("error", () => {
        stopRequested = true;
        if (startPromise) void finish();
      });
    },
  );

  app.get("/token", { preHandler: requireAuth }, async (request, reply) => {
    if (!config.enableAppAnswer)
      return reply
        .code(404)
        .send({
          error: {
            code: "APP_ANSWER_DISABLED",
            message: "Answering in the app is not enabled.",
          },
        });
    if (
      !config.twilioAccountSid ||
      !config.twilioApiKeySid ||
      !config.twilioApiKeySecret ||
      !config.twilioTwimlAppSid ||
      !config.clientIdentity
    )
      return reply
        .code(503)
        .send({
          error: {
            code: "APP_ANSWER_NOT_READY",
            message: "Answering in the app is not fully configured.",
          },
        });
    const grant = new twilio.jwt.AccessToken.VoiceGrant({
      outgoingApplicationSid: config.twilioTwimlAppSid,
      incomingAllow: true,
      ...(config.twilioPushCredentialSid
        ? { pushCredentialSid: config.twilioPushCredentialSid }
        : {}),
    });
    const token = new twilio.jwt.AccessToken(
      config.twilioAccountSid,
      config.twilioApiKeySid,
      config.twilioApiKeySecret,
      { identity: config.clientIdentity },
    );
    token.addGrant(grant);
    return {
      token: token.toJwt(),
      identity: config.clientIdentity,
      hasPushCredential: !!config.twilioPushCredentialSid,
    };
  });
  return app;
}
