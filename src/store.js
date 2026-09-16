import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

export function createMemoryStore(seed = {}) {
  let state = {
    tokens: [],
    calls: [],
    pushTokens: [],
    incomingCalls: [],
    incomingCallSids: {},
    incomingTombstones: {},
    ...structuredClone(seed),
  };
  return {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
}

export function createFileStore(path) {
  let writeChain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT")
          return { tokens: [], calls: [], pushTokens: [], incomingCalls: [], incomingCallSids: {}, incomingTombstones: {} };
        throw error;
      }
    },
    async save(state) {
      const snapshot = JSON.stringify(structuredClone(state));
      const write = async () => {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, snapshot, { mode: 0o600 });
        await rename(temp, path);
      };
      writeChain = writeChain.then(write, write);
      return writeChain;
    },
  };
}

export function createRepository(
  store,
  { maxCalls = 50, maxTurnsPerCall = 500, maxDevices = 3 } = {},
) {
  let state;
  const ready = store.load().then(async (loaded) => {
    state = { tokens: [], calls: [], pushTokens: [], incomingCalls: [], incomingCallSids: {}, incomingTombstones: {}, ...loaded };
    let changed = false;
    // Pre-v2 stores kept bare Expo tokens. They cannot be safely tied to a
    // paired device, so discard them instead of notifying an unknown phone.
    const boundPushTokens = state.pushTokens.filter(
      (item) => item && typeof item === "object" && item.token && item.deviceHash && item.provider === "fcm",
    );
    if (boundPushTokens.length !== state.pushTokens.length) {
      state.pushTokens = boundPushTokens;
      changed = true;
    }
    for (const call of state.calls) {
      if (call.status === "active") {
        call.status = "ended";
        call.endedAt ||= new Date().toISOString();
        call.summaryStatus = call.summary ? "complete" : "failed";
        call.interrupted = true;
        changed = true;
      }
    }
    if (changed) await store.save(state);
  });
  const persist = async () => {
    await ready;
    await store.save(state);
  };
  const boundIncomingMarkers = () => {
    state.incomingCallSids = Object.fromEntries(
      Object.entries(state.incomingCallSids).slice(-maxCalls),
    );
    state.incomingTombstones = Object.fromEntries(
      Object.entries(state.incomingTombstones).slice(-maxCalls),
    );
  };
  return {
    ready,
    async consumePairingCode(code, deviceId = "") {
      await ready;
      const fingerprint = hash(code);
      const deviceHash = deviceId ? hash(deviceId) : "";
      const retainedTokens = deviceHash
        ? state.tokens.filter((item) => item.deviceHash !== deviceHash)
        : state.tokens;
      if (state.consumedPairingCodes?.includes(fingerprint) || retainedTokens.length >= maxDevices)
        return null;
      const token = randomBytes(32).toString("base64url");
      const before = structuredClone(state);
      state.tokens = [...retainedTokens, {
        tokenHash: hash(token),
        deviceHash: deviceHash || hash(token),
        createdAt: new Date().toISOString(),
      }];
      if (deviceHash)
        state.pushTokens = state.pushTokens.filter(
          (item) => item.deviceHash !== deviceHash,
        );
      state.consumedPairingCodes = [
        ...(state.consumedPairingCodes || []),
        fingerprint,
      ];
      try {
        await persist();
      } catch (error) {
        state = before;
        throw error;
      }
      return token;
    },
    async hasToken(token) {
      await ready;
      if (!token) return false;
      const candidate = Buffer.from(hash(token));
      return state.tokens.some((item) => {
        const stored = Buffer.from(item.tokenHash || hash(item.token || ""));
        return (
          stored.length === candidate.length &&
          timingSafeEqual(stored, candidate)
        );
      });
    },
    async snapshot() {
      await ready;
      return structuredClone(state.calls);
    },
    async incomingCalls(now = Date.now()) {
      await ready;
      const current = state.incomingCalls.filter((call) => Number(call.expiresAt) > now);
      const seen = Object.fromEntries(Object.entries(state.incomingCallSids).filter(([, expiresAt]) => Number(expiresAt) > now));
      const tombstones = Object.fromEntries(Object.entries(state.incomingTombstones).filter(([, expiresAt]) => Number(expiresAt) > now));
      if (current.length !== state.incomingCalls.length || Object.keys(seen).length !== Object.keys(state.incomingCallSids).length || Object.keys(tombstones).length !== Object.keys(state.incomingTombstones).length) {
        state.incomingCalls = current;
        state.incomingCallSids = seen;
        state.incomingTombstones = tombstones;
        await persist();
      }
      return structuredClone(current);
    },
    async beginIncoming(callSid, from, receivedAt, expiresAt) {
      await ready;
      const existing = state.incomingCalls.find((call) => call.callSid === callSid);
      if (existing) return { created: false, call: structuredClone(existing) };
      if (Number(state.incomingCallSids[callSid]) > Number(receivedAt) || Number(state.incomingTombstones[callSid]) > Number(receivedAt))
        return { created: false, call: null };
      const call = { callSid, from, receivedAt, expiresAt };
      state.incomingCalls = [call, ...state.incomingCalls].slice(0, maxCalls);
      state.incomingCallSids[callSid] = expiresAt;
      boundIncomingMarkers();
      await persist();
      return { created: true, call: structuredClone(call) };
    },
    async clearIncoming(callSid) {
      await ready;
      const found = state.incomingCalls.some((call) => call.callSid === callSid);
      state.incomingCalls = state.incomingCalls.filter((call) => call.callSid !== callSid);
      state.incomingTombstones[callSid] = Math.max(Number(state.incomingTombstones[callSid]) || 0, Date.now() + 45_000);
      boundIncomingMarkers();
      await persist();
      return found;
    },
    async startCall(from, now = new Date()) {
      await ready;
      const call = {
        callId: randomUUID(),
        from,
        startedAt: now.toISOString(),
        status: "active",
        turns: [],
        summary: "",
        summaryStatus: "pending",
      };
      state.calls.unshift(call);
      state.calls = state.calls.slice(0, maxCalls);
      await persist();
      return structuredClone(call);
    },
    async addTurn(callId, turn) {
      await ready;
      const call = state.calls.find((c) => c.callId === callId);
      if (!call) return;
      call.turns.push(turn);
      call.turns = call.turns.slice(-maxTurnsPerCall);
      await persist();
    },
    async updateTurn(callId, turnId, patch) {
      await ready;
      const turn = state.calls
        .find((c) => c.callId === callId)
        ?.turns.find((t) => t.id === turnId);
      if (turn) {
        Object.assign(turn, patch);
        await persist();
      }
    },
    async endCall(callId, now = new Date()) {
      await ready;
      const call = state.calls.find((c) => c.callId === callId);
      if (call) {
        call.status = "ended";
        call.endedAt = now.toISOString();
        await persist();
      }
      return call && structuredClone(call);
    },
    async setSummary(callId, text, status) {
      await ready;
      const call = state.calls.find((c) => c.callId === callId);
      if (call) {
        call.summary = text;
        call.summaryStatus = status;
        await persist();
      }
    },
    async registerPushToken(token, provider, deviceToken) {
      await ready;
      const tokenHash = hash(deviceToken);
      const device = state.tokens.find((item) => item.tokenHash === tokenHash);
      if (!device) return false;
      const deviceHash = device.deviceHash || tokenHash;
      const current = state.pushTokens.find(
        (item) => item.deviceHash === deviceHash,
      );
      if (!current || current.token !== token || current.provider !== provider) {
        state.pushTokens = state.pushTokens.filter(
          (item) => item.deviceHash !== deviceHash && item.token !== token,
        );
        state.pushTokens.push({ token, provider, deviceHash });
        await persist();
      }
      return true;
    },
    async removePushToken(deviceToken) {
      await ready;
      const tokenHash = hash(deviceToken);
      const device = state.tokens.find((item) => item.tokenHash === tokenHash);
      if (!device) return false;
      const deviceHash = device.deviceHash || tokenHash;
      state.pushTokens = state.pushTokens.filter((item) => item.deviceHash !== deviceHash);
      await persist();
      return true;
    },
    async removePushTokens(tokens) {
      await ready;
      const invalid = new Set(tokens);
      state.pushTokens = state.pushTokens.filter((item) => !invalid.has(item.token));
      await persist();
    },
    async pushTokens(provider) {
      await ready;
      return state.pushTokens.filter((item) => !provider || item.provider === provider).map((item) => item.token);
    },
  };
}
