import WebSocket from "ws";
import { existsSync } from "node:fs";
import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

async function anthropic(config, model, system, text, maxTokens, timeoutMs) {
  if (!config.anthropicApiKey) return "";
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
    const body = await response.json();
    return body?.content?.[0]?.text?.trim() || "";
  } catch (error) {
    if (error.name === "TimeoutError") return "";
    throw error;
  }
}

export function createProviders(config, log) {
  let messaging;
  let fcmInitializationError = "";
  const fcmConfigured = !!(config.firebaseServiceAccountJson || config.googleApplicationCredentials);
  const credentialPathMissing = !!(
    config.googleApplicationCredentials && !existsSync(config.googleApplicationCredentials)
  );
  const getFcmMessaging = () => {
    if (!fcmConfigured) throw new Error("FCM credentials are not configured");
    if (credentialPathMissing) {
      fcmInitializationError = "FCM credentials file is unavailable";
      throw new Error(fcmInitializationError);
    }
    if (messaging) return messaging;
    try {
      const credential = config.firebaseServiceAccountJson
        ? cert(JSON.parse(config.firebaseServiceAccountJson))
        : applicationDefault();
      messaging = getMessaging(getApps()[0] || initializeApp({ credential }));
      return messaging;
    } catch (error) {
      fcmInitializationError = error.message || "FCM initialization failed";
      throw error;
    }
  };
  if (fcmConfigured) {
    try {
      getFcmMessaging();
    } catch {}
  }
  return {
    pushStatus: () => ({ configured: fcmConfigured, deliveryReady: !!messaging, error: fcmInitializationError || undefined }),
    translate: (text) =>
      anthropic(
        config,
        config.translateModel,
        "Translate the caller's English into natural conversational Latin American Spanish. Return only the translation.",
        text,
        300,
        config.translationTimeoutMs,
      ),
    summarize: (turns) =>
      anthropic(
        config,
        config.summaryModel,
        "Resume esta llamada en 2 a 4 frases claras en espanol, incluyendo acciones, fechas, horas y numeros. Solo responde con el resumen.",
        turns
          .map(
            (t) =>
              `${t.speaker === "caller" ? "La otra persona" : "Usted"}: ${t.en}`,
          )
          .join("\n"),
        400,
        config.summaryTimeoutMs,
      ),
    openTranscriber(onTranscript, onError = () => {}) {
      if (!config.deepgramApiKey) {
        queueMicrotask(onError);
        return { ready: false, send() {}, onReady() {}, async finish() {} };
      }
      const params = new URLSearchParams({
        encoding: "mulaw",
        sample_rate: "8000",
        channels: "1",
        model: "nova-2-phonecall",
        language: "en",
        punctuate: "true",
        smart_format: "true",
        interim_results: "true",
        endpointing: "250",
      });
      const socket = new WebSocket(
        `wss://api.deepgram.com/v1/listen?${params}`,
        { headers: { Authorization: `Token ${config.deepgramApiKey}` } },
      );
      socket.on("message", (data) => {
        try {
          const m = JSON.parse(data.toString());
          const text = m?.channel?.alternatives?.[0]?.transcript?.trim();
          if (text) onTranscript(text, !!m.is_final);
        } catch {}
      });
      let finishing = false;
      let failed = false;
      const fail = () => {
        if (!failed) {
          failed = true;
          onError();
        }
      };
      socket.on("error", (error) => {
        log.warn({ error: error.message }, "transcription provider error");
        fail();
      });
      socket.on("close", () => {
        if (!finishing) fail();
      });
      return {
        get ready() {
          return socket.readyState === WebSocket.OPEN;
        },
        send(data) {
          socket.send(data);
        },
        async finish(timeoutMs) {
          finishing = true;
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "CloseStream" }));
          let timer;
          await Promise.race([
            new Promise((resolve) => {
              socket.once("close", resolve);
              socket.once("error", resolve);
            }),
            new Promise((resolve) => {
              timer = setTimeout(resolve, timeoutMs);
            }),
          ]);
          clearTimeout(timer);
          try {
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
          } catch {}
        },
        onReady(fn) {
          socket.once("open", fn);
        },
      };
    },
    async notify(pushTokens, payload) {
      if (!pushTokens.length) return;
      const response = await getFcmMessaging().sendEachForMulticast({
        tokens: pushTokens,
        data: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "ttlMs").map(([key, value]) => [key, String(value)])),
        android: { priority: "high", ttl: Math.min(45_000, Math.max(1_000, Number(payload.ttlMs) || 45_000)) },
      });
      const invalidTokens = response.responses.flatMap((result, index) =>
        result.success || !["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(result.error?.code) ? [] : [pushTokens[index]],
      );
      if (response.failureCount) log.warn({ failed: response.failureCount }, "FCM push delivery failed");
      return { invalidTokens };
    },
  };
}
