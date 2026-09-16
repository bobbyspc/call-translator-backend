import test from "node:test";
import assert from "node:assert/strict";
import twilio from "twilio";
import WebSocket from "ws";
import { createServer } from "../src/app.js";
import { createMemoryStore } from "../src/store.js";

const config = {
  publicBaseUrl: "https://example.test",
  targetPhoneNumber: "+17865550101",
  twilioPhoneNumber: "+17865550102",
  forwardingSourceNumbers: [],
  ringTimeoutSeconds: 25,
  enableAppAnswer: false,
  clientIdentity: "",
  pairingCode: "LORO-TEST",
  pairingWindowMs: 60000,
  pairingMaxAttempts: 5,
  maxDevices: 3,
  maxCalls: 50,
  maxTurnsPerCall: 500,
  maxQueuedAudioBytes: 1000,
  providerCloseTimeoutMs: 20,
  authTimeoutMs: 100,
  twilioAuthToken: "auth-secret",
  deepgramApiKey: "configured",
  anthropicApiKey: "configured",
};
const providers = {
  translate: async (text) => `ES:${text}`,
  summarize: async () => "Resumen",
  notify: async () => {},
  openTranscriber: () => ({
    ready: true,
    send() {},
    onReady() {},
    async finish() {},
  }),
};
async function setup(overrides = {}, seed) {
  return createServer({
    config: { ...config, ...overrides },
    store: createMemoryStore(seed),
    providers,
  });
}

test("health exposes the protocol migration gate", async (t) => {
  const app = await setup();
  t.after(() => app.close());
  const response = await app.inject("/health");
  assert.deepEqual(response.json(), {
    ok: true,
    service: "call-translator-backend",
    protocolVersion: 2,
  });
});
test("pairing is one-time and status requires the issued bearer token", async (t) => {
  const app = await setup();
  t.after(() => app.close());
  const paired = await app.inject({
    method: "POST",
    url: "/pair",
    payload: { code: "LORO-TEST" },
  });
  assert.equal(paired.statusCode, 201);
  const { token } = paired.json();
  assert.ok(token.length >= 40);
  assert.equal((await app.inject("/status")).statusCode, 401);
  const status = await app.inject({
    url: "/status",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().service, "ready");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/pair",
        payload: { code: "LORO-TEST" },
      })
    ).statusCode,
    409,
  );
});
test("pairing rejects an unconfigured server and limits bad attempts", async (t) => {
  const unavailable = await setup({ pairingCode: "" });
  t.after(() => unavailable.close());
  assert.equal(
    (
      await unavailable.inject({
        method: "POST",
        url: "/pair",
        payload: { code: "x" },
      })
    ).statusCode,
    503,
  );
  const limited = await setup({ pairingMaxAttempts: 1 });
  t.after(() => limited.close());
  await limited.inject({
    method: "POST",
    url: "/pair",
    payload: { code: "bad" },
  });
  assert.equal(
    (
      await limited.inject({
        method: "POST",
        url: "/pair",
        payload: { code: "bad" },
      })
    ).statusCode,
    429,
  );
});
test("push registrations are scoped to the paired device", async (t) => {
  const app = await setup();
  t.after(() => app.close());
  const token = (
    await app.inject({
      method: "POST",
      url: "/pair",
      payload: { code: "LORO-TEST" },
    })
  ).json().token;
  const pushToken = "fcm_paired_device_token_123456";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/devices/push",
        payload: { token: pushToken, provider: "fcm" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/devices/push",
        headers: { authorization: `Bearer ${token}` },
        payload: { token: pushToken, provider: "fcm" },
      })
    ).statusCode,
    204,
  );
  assert.deepEqual(await app.loro.repository.pushTokens(), [pushToken]);
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/devices/push", headers: { authorization: `Bearer ${token}` } })).statusCode,
    204,
  );
  assert.deepEqual(await app.loro.repository.pushTokens(), []);
  assert.equal(
    (await app.inject({ method: "POST", url: "/devices/push", headers: { authorization: `Bearer ${token}` }, payload: { token: pushToken, provider: "expo" } })).statusCode,
    400,
  );
});
test("voice rejects unsigned requests and accepts a canonical signed webhook", async (t) => {
  const app = await setup();
  t.after(() => app.close());
  const payload = { From: "+13055550123" };
  assert.equal(
    (await app.inject({ method: "POST", url: "/voice", payload })).statusCode,
    403,
  );
  const signature = twilio.getExpectedTwilioSignature(
    config.twilioAuthToken,
    `${config.publicBaseUrl}/voice`,
    payload,
  );
  const response = await app.inject({
    method: "POST",
    url: "/voice",
    payload,
    headers: { "x-twilio-signature": signature },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /wss:\/\/example\.test\/media/);
  assert.match(response.body, /\+17865550101/);
});
test("loop guards drop both the Twilio number and a forwarding source target", async (t) => {
  const app = await setup({
    targetPhoneNumber: "+17865550103",
    forwardingSourceNumbers: ["+17865550103"],
  });
  t.after(() => app.close());
  const payload = { From: "+13055550123" };
  const signature = twilio.getExpectedTwilioSignature(
    config.twilioAuthToken,
    `${config.publicBaseUrl}/voice`,
    payload,
  );
  const response = await app.inject({
    method: "POST",
    url: "/voice",
    payload,
    headers: { "x-twilio-signature": signature },
  });
  assert.match(response.body, /not available/);
});

test("incoming notification is created before media, deduplicated, and cannot delay TwiML", async (t) => {
  const sent = [];
  const neverResolvingPush = { ...providers, notify: async (tokens, payload) => { sent.push({ tokens, payload }); return new Promise(() => {}); } };
  const app = await createServer({ config: { ...config, pushTimeoutMs: 10 }, store: createMemoryStore(), providers: neverResolvingPush });
  t.after(() => app.close());
  const device = (await app.inject({ method: "POST", url: "/pair", payload: { code: "LORO-TEST" } })).json().token;
  const fcmToken = "fcm_incoming_device_token_123456";
  await app.inject({ method: "POST", url: "/devices/push", headers: { authorization: `Bearer ${device}` }, payload: { token: fcmToken, provider: "fcm" } });
  const payload = { From: "+13055550123", CallSid: "CAincoming123" };
  const signature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${config.publicBaseUrl}/voice`, payload);
  const started = Date.now();
  const response = await app.inject({ method: "POST", url: "/voice", payload, headers: { "x-twilio-signature": signature } });
  assert.equal(response.statusCode, 200);
  assert.ok(Date.now() - started < 100, "push network work must not block TwiML");
  assert.match(response.body, /<Number[^>]*statusCallback=/);
  assert.doesNotMatch(response.body, /<Dial[^>]*statusCallback=/);
  assert.match(response.body, /<Dial[^>]*action=/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await app.loro.repository.incomingCalls(Date.now()), [{
    callSid: "CAincoming123", from: "+13055550123",
    receivedAt: (await app.loro.repository.incomingCalls(Date.now()))[0].receivedAt,
    expiresAt: (await app.loro.repository.incomingCalls(Date.now()))[0].expiresAt,
  }]);
  await app.inject({ method: "POST", url: "/voice", payload, headers: { "x-twilio-signature": signature } });
  assert.equal((await app.loro.repository.incomingCalls(Date.now())).length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { tokens: [fcmToken], payload: { type: "incoming_call", callSid: "CAincoming123", from: "+13055550123", receivedAt: sent[0].payload.receivedAt, expiresAt: sent[0].payload.expiresAt, ttlMs: 30000 } });
  assert.match(sent[0].payload.receivedAt, /^\d+$/);
  assert.match(sent[0].payload.expiresAt, /^\d+$/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok((await app.inject({ url: "/status", headers: { authorization: `Bearer ${device}` } })).json().issues.some((issue) => issue.code === "PUSH_DELIVERY_FAILED"));
});

test("service status reports push readiness honestly instead of assuming it", async (t) => {
  // Absent credentials, a broken credential, and a working one must be three different
  // answers, because the app decides whether to offer the alerts control from this.
  const absent = await setup();
  t.after(() => absent.close());
  const absentToken = (await absent.inject({ method: "POST", url: "/pair", payload: { code: "LORO-TEST" } })).json().token;
  const absentStatus = (await absent.inject({ url: "/status", headers: { authorization: `Bearer ${absentToken}` } })).json();
  assert.deepEqual(absentStatus.push, { configured: false, deliveryReady: false });
  assert.equal(absentStatus.issues.some((issue) => issue.code === "PUSH_UNAVAILABLE"), false);

  const broken = await createServer({
    config: { ...config, pairingCode: "BROKEN-PUSH" },
    store: createMemoryStore(),
    providers: { ...providers, pushStatus: () => ({ configured: true, deliveryReady: false, error: "FCM initialization failed" }) },
  });
  t.after(() => broken.close());
  const brokenToken = (await broken.inject({ method: "POST", url: "/pair", payload: { code: "BROKEN-PUSH" } })).json().token;
  const brokenStatus = (await broken.inject({ url: "/status", headers: { authorization: `Bearer ${brokenToken}` } })).json();
  assert.equal(brokenStatus.push.deliveryReady, false);
  assert.equal(brokenStatus.service, "degraded");
  assert.ok(brokenStatus.issues.some((issue) => issue.code === "PUSH_UNAVAILABLE"));

  const working = await createServer({
    config: { ...config, pairingCode: "READY-PUSH" },
    store: createMemoryStore(),
    providers: { ...providers, pushStatus: () => ({ configured: true, deliveryReady: true }) },
  });
  t.after(() => working.close());
  const workingToken = (await working.inject({ method: "POST", url: "/pair", payload: { code: "READY-PUSH" } })).json().token;
  const workingStatus = (await working.inject({ url: "/status", headers: { authorization: `Bearer ${workingToken}` } })).json();
  assert.deepEqual(workingStatus.push, { configured: true, deliveryReady: true });
  assert.equal(workingStatus.service, "ready");
});

test("a dismissed call notifies the phone and drops a token Firebase rejected", async (t) => {
  const sent = [];
  const rejectingPush = {
    ...providers,
    notify: async (tokens, payload) => {
      sent.push(payload);
      return { invalidTokens: payload.type === "call_ended" ? tokens : [] };
    },
  };
  const app = await createServer({ config, store: createMemoryStore(), providers: rejectingPush });
  t.after(() => app.close());
  const device = (await app.inject({ method: "POST", url: "/pair", payload: { code: "LORO-TEST" } })).json().token;
  const fcmToken = "fcm_rotated_device_token_1234567";
  await app.inject({ method: "POST", url: "/devices/push", headers: { authorization: `Bearer ${device}` }, payload: { token: fcmToken, provider: "fcm" } });
  const payload = { From: "+13055550123", CallSid: "CAdismiss123" };
  const voiceSignature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${config.publicBaseUrl}/voice`, payload);
  await app.inject({ method: "POST", url: "/voice", payload, headers: { "x-twilio-signature": voiceSignature } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const completePayload = { CallSid: "CAdismiss123" };
  const completeSignature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${config.publicBaseUrl}/voice/dial-complete`, completePayload);
  await app.inject({ method: "POST", url: "/voice/dial-complete", payload: completePayload, headers: { "x-twilio-signature": completeSignature } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent.map((message) => message.type), ["incoming_call", "call_ended"]);
  assert.equal(sent[1].callSid, "CAdismiss123");
  // A token the push provider reported as unregistered must not survive, or the next
  // call notifies a phone that can never receive it and the failure stays invisible.
  assert.deepEqual(await app.loro.repository.pushTokens("fcm"), []);
  assert.deepEqual(await app.loro.repository.incomingCalls(Date.now()), []);
});

test("signed status clears a pending incoming alert without allowing a retry to resurrect it", async (t) => {
  const app = await setup();
  t.after(() => app.close());
  const payload = { From: "+13055550123", CallSid: "CAparent123" };
  const voiceSignature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${config.publicBaseUrl}/voice`, payload);
  await app.inject({ method: "POST", url: "/voice", payload, headers: { "x-twilio-signature": voiceSignature } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const statusPayload = { CallSid: "CAchild123", ParentCallSid: "CAparent123", DialCallStatus: "completed" };
  const statusSignature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${config.publicBaseUrl}/voice/status`, statusPayload);
  assert.equal((await app.inject({ method: "POST", url: "/voice/status", payload: statusPayload, headers: { "x-twilio-signature": statusSignature } })).statusCode, 204);
  assert.equal((await app.loro.repository.incomingCalls(Date.now())).length, 0);
  await app.inject({ method: "POST", url: "/voice", payload, headers: { "x-twilio-signature": voiceSignature } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await app.loro.repository.incomingCalls(Date.now())).length, 0);
});

test("a signed terminal callback before the incoming write leaves a tombstone", async (t) => {
  const app = await setup();
  t.after(() => app.close());
  const statusPayload = { CallSid: "CArace123", DialCallStatus: "completed" };
  const statusSignature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${config.publicBaseUrl}/voice/status`, statusPayload);
  await app.inject({ method: "POST", url: "/voice/status", payload: statusPayload, headers: { "x-twilio-signature": statusSignature } });
  const payload = { From: "+13055550123", CallSid: "CArace123" };
  const signature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${config.publicBaseUrl}/voice`, payload);
  await app.inject({ method: "POST", url: "/voice", payload, headers: { "x-twilio-signature": signature } });
  assert.deepEqual(await app.loro.repository.incomingCalls(Date.now()), []);
});

test("an authenticated websocket snapshot includes an unexpired incoming call", async (t) => {
  const mutableConfig = { ...config, publicBaseUrl: "http://127.0.0.1", pairingCode: "SNAPSHOT-TEST" };
  const app = await createServer({ config: mutableConfig, store: createMemoryStore(), providers });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();
  mutableConfig.publicBaseUrl = `http://127.0.0.1:${port}`;
  const token = (await app.inject({ method: "POST", url: "/pair", payload: { code: "SNAPSHOT-TEST" } })).json().token;
  const payload = { From: "+13055550123", CallSid: "CAsnapshot123" };
  const signature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, `${mutableConfig.publicBaseUrl}/voice`, payload);
  await app.inject({ method: "POST", url: "/voice", payload, headers: { "x-twilio-signature": signature } });
  const snapshot = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/app`);
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.type === "hello") socket.send(JSON.stringify({ type: "auth", token }));
      if (message.type === "snapshot") {
        socket.close();
        resolve(message);
      }
    });
  });
  assert.deepEqual(snapshot.incomingCalls.map((call) => call.callSid), ["CAsnapshot123"]);
});

test("media finalization waits for late provider finals and reconnect replays the ended call", async (t) => {
  const transcribers = [];
  const delayedProviders = {
    translate: async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `ES:${text}`;
    },
    summarize: async (turns) => `summary:${turns.length}`,
    notify: async () => {},
    openTranscriber(onTranscript) {
      const item = {
        ready: true,
        send() {},
        onReady() {},
        async finish() {
          onTranscript("late final", true);
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      };
      transcribers.push(item);
      return item;
    },
  };
  const mutableConfig = {
    ...config,
    publicBaseUrl: "http://127.0.0.1",
    pairingCode: "WS-TEST",
  };
  const app = await createServer({
    config: mutableConfig,
    store: createMemoryStore(),
    providers: delayedProviders,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  mutableConfig.publicBaseUrl = `http://127.0.0.1:${address.port}`;
  const paired = await app.inject({
    method: "POST",
    url: "/pair",
    payload: { code: "WS-TEST" },
  });
  const token = paired.json().token;
  const connectApp = () =>
    new Promise((resolve, reject) => {
      const messages = [];
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app`);
      socket.on("error", reject);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw);
        messages.push(message);
        if (message.type === "hello")
          socket.send(JSON.stringify({ type: "auth", token }));
        if (message.type === "service_status") resolve({ socket, messages });
      });
    });
  const display = await connectApp();
  const pong = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pong timed out")), 500);
    display.socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.type === "pong") {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  display.socket.send(JSON.stringify({ type: "ping" }));
  assert.equal((await pong).type, "pong");
  const mediaUrl = `${mutableConfig.publicBaseUrl}/media`;
  const signature = twilio.getExpectedTwilioSignature(
    config.twilioAuthToken,
    mediaUrl,
    {},
  );
  const media = new WebSocket(mediaUrl.replace("http:", "ws:"), {
    headers: { "x-twilio-signature": signature },
  });
  await new Promise((resolve, reject) => {
    media.once("open", resolve);
    media.once("error", reject);
  });
  media.send(
    JSON.stringify({
      event: "start",
      start: { customParameters: { from: "+13055550000" } },
    }),
  );
  media.send(JSON.stringify({ event: "stop" }));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("summary timed out")),
      1000,
    );
    display.socket.on("message", (raw) => {
      if (JSON.parse(raw).type === "summary") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  display.socket.close();
  media.close();
  const replay = await connectApp();
  const snapshot = replay.messages.find(
    (message) => message.type === "snapshot",
  );
  replay.socket.close();
  assert.equal(snapshot.calls[0].status, "ended");
  assert.equal(snapshot.calls[0].turns.length, 2);
  assert.equal(snapshot.calls[0].turns[0].translationStatus, "complete");
  assert.equal(snapshot.calls[0].summary, "summary:2");
});

test("a stop received while call creation is still saving cannot leave an active call", async (t) => {
  const slowStore = createMemoryStore();
  const save = slowStore.save;
  slowStore.save = async (state) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await save(state);
  };
  const mutableConfig = { ...config, publicBaseUrl: "http://127.0.0.1" };
  const app = await createServer({
    config: mutableConfig,
    store: slowStore,
    providers,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();
  mutableConfig.publicBaseUrl = `http://127.0.0.1:${port}`;
  const mediaUrl = `${mutableConfig.publicBaseUrl}/media`;
  const signature = twilio.getExpectedTwilioSignature(
    config.twilioAuthToken,
    mediaUrl,
    {},
  );
  const media = new WebSocket(mediaUrl.replace("http:", "ws:"), {
    headers: { "x-twilio-signature": signature },
  });
  await new Promise((resolve, reject) => {
    media.once("open", resolve);
    media.once("error", reject);
  });
  media.send(JSON.stringify({ event: "start", start: { customParameters: {} } }));
  media.send(JSON.stringify({ event: "stop" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  media.close();
  const [call] = await app.loro.repository.snapshot();
  assert.equal(call.status, "ended");
  assert.ok(call.endedAt);
});

test("a transcription provider failure remains visible after app reconnect", async (t) => {
  const brokenProviders = {
    ...providers,
    openTranscriber(onTranscript, onError) {
      queueMicrotask(onError);
      return { ready: false, send() {}, onReady() {}, async finish() {} };
    },
  };
  const mutableConfig = {
    ...config,
    publicBaseUrl: "http://127.0.0.1",
    pairingCode: "FAIL-TEST",
  };
  const app = await createServer({
    config: mutableConfig,
    store: createMemoryStore(),
    providers: brokenProviders,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();
  mutableConfig.publicBaseUrl = `http://127.0.0.1:${port}`;
  const token = (
    await app.inject({
      method: "POST",
      url: "/pair",
      payload: { code: "FAIL-TEST" },
    })
  ).json().token;
  const mediaUrl = `${mutableConfig.publicBaseUrl}/media`;
  const signature = twilio.getExpectedTwilioSignature(
    config.twilioAuthToken,
    mediaUrl,
    {},
  );
  const media = new WebSocket(mediaUrl.replace("http:", "ws:"), {
    headers: { "x-twilio-signature": signature },
  });
  await new Promise((resolve) => media.once("open", resolve));
  media.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/app`);
    const messages = [];
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      messages.push(message);
      if (message.type === "hello")
        socket.send(JSON.stringify({ type: "auth", token }));
      if (message.type === "service_status") {
        socket.close();
        resolve(message);
      }
    });
  });
  assert.equal(result.service, "degraded");
  assert.equal(result.translationReady, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "TRANSCRIPTION_INTERRUPTED"),
  );
});

test("media websocket rejects a bad Twilio signature", async (t) => {
  const mutableConfig = { ...config, publicBaseUrl: "http://127.0.0.1" };
  const app = await createServer({
    config: mutableConfig,
    store: createMemoryStore(),
    providers,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();
  mutableConfig.publicBaseUrl = `http://127.0.0.1:${port}`;
  const status = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/media`, {
      headers: { "x-twilio-signature": "bad" },
    });
    socket.once("unexpected-response", (_, response) =>
      resolve(response.statusCode),
    );
    socket.once("open", () => reject(new Error("bad signature connected")));
    socket.once("error", () => {});
  });
  assert.equal(status, 403);
});
