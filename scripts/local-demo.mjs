#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/app.js";
import { createFileStore } from "../src/store.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const requestedDirectory = flag("--data-dir");
const pairingCode = flag("--pairing-code") || "LORO-DEMO";
if (args.includes("--data-dir") && !requestedDirectory)
  throw new Error("--data-dir requires an existing or new absolute directory path.");
if (requestedDirectory && !isAbsolute(requestedDirectory))
  throw new Error("--data-dir must be an absolute path.");
if (!/^[A-Za-z0-9_-]{4,128}$/.test(pairingCode))
  throw new Error("--pairing-code must use 4-128 letters, numbers, _ or -.");
const directory = requestedDirectory
  ? resolve(requestedDirectory)
  : await mkdtemp(join(tmpdir(), "loro-demo-"));
const config = {
  publicBaseUrl: "http://127.0.0.1:3107",
  targetPhoneNumber: "+15555550101",
  twilioPhoneNumber: "+15555550102",
  twilioAuthToken: "demo-only",
  forwardingSourceNumbers: [],
  ringTimeoutSeconds: 25,
  enableAppAnswer: false,
  clientIdentity: "",
  pairingCode,
  pairingWindowMs: 60000,
  pairingMaxAttempts: 20,
  maxDevices: 3,
  maxCalls: 50,
  maxTurnsPerCall: 500,
  maxQueuedAudioBytes: 1_000_000,
  providerCloseTimeoutMs: 100,
  authTimeoutMs: 5000,
  deepgramApiKey: "demo",
  anthropicApiKey: "demo",
  webAllowedOrigins: ["http://localhost:8081", "http://127.0.0.1:8081"],
  maxPendingTranslations: 50,
};
const providers = {
  translate: async (text) => `Traduccion: ${text}`,
  summarize: async () =>
    "La persona llamo para confirmar la cita del martes a las diez.",
  notify: async () => {},
  openTranscriber: () => ({
    ready: true,
    send() {},
    onReady() {},
    async finish() {},
  }),
};
const app = await createServer({
  config,
  store: createFileStore(join(directory, "state.json")),
  providers,
});
app.post("/_demo/call", async (request) => {
  if (request.ip !== "127.0.0.1" && request.ip !== "::1") return { ok: false };
  const now = new Date();
  const call = await app.loro.repository.startCall("+13055550123", now);
  app.loro.broadcast({
    type: "call_start",
    callId: call.callId,
    from: call.from,
    startedAt: call.startedAt,
  });
  const duration = Math.min(
    30000,
    Math.max(0, Number(request.query?.duration || 0)),
  );
  const pause = () =>
    duration
      ? new Promise((resolve) => setTimeout(resolve, duration / 3))
      : Promise.resolve();
  const turns = [
    {
      id: `${call.callId}:1`,
      speaker: "caller",
      en: "Hello, I am calling to confirm your appointment Tuesday at ten.",
      es: "Hola, llamo para confirmar su cita el martes a las diez.",
      translationStatus: "complete",
      timestamp: new Date(now.getTime() + 1000).toISOString(),
    },
    {
      id: `${call.callId}:2`,
      speaker: "dad",
      en: "Yes, I will be there. Thank you.",
      es: "Si, estare alli. Gracias.",
      translationStatus: "complete",
      timestamp: new Date(now.getTime() + 2000).toISOString(),
    },
  ];
  for (const turn of turns) {
    await pause();
    await app.loro.repository.addTurn(call.callId, turn);
    app.loro.broadcast({ type: "turn", callId: call.callId, ...turn });
  }
  await pause();
  const ended = await app.loro.repository.endCall(
    call.callId,
    new Date(now.getTime() + 3000),
  );
  app.loro.broadcast({
    type: "call_end",
    callId: call.callId,
    endedAt: ended.endedAt,
  });
  const text = "La persona llamo para confirmar la cita del martes a las diez.";
  await app.loro.repository.setSummary(call.callId, text, "complete");
  app.loro.broadcast({
    type: "summary",
    callId: call.callId,
    text,
    status: "complete",
  });
  return { ok: true, callId: call.callId };
});
await app.listen({ host: "127.0.0.1", port: 3107 });
console.log(`Loro demo: http://127.0.0.1:3107  pairing code: ${pairingCode}`);
console.log(
  "Trigger a sample call: curl.exe -X POST http://127.0.0.1:3107/_demo/call",
);
console.log(
  'Slow call for reconnect QA: curl.exe -X POST "http://127.0.0.1:3107/_demo/call?duration=15000"',
);
