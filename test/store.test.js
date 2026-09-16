import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, createRepository } from "../src/store.js";
test("repository keeps stable calls and bounded ordered history", async () => {
  const repo = createRepository(createMemoryStore(), {
    maxCalls: 1,
    maxTurnsPerCall: 2,
  });
  const first = await repo.startCall("one", new Date("2026-01-01"));
  await repo.addTurn(first.callId, { id: "1" });
  await repo.addTurn(first.callId, { id: "2" });
  await repo.addTurn(first.callId, { id: "3" });
  await repo.endCall(first.callId, new Date("2026-01-02"));
  const second = await repo.startCall("two", new Date("2026-01-03"));
  const calls = await repo.snapshot();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callId, second.callId);
});
test("repository marks calls interrupted by a backend restart as ended", async () => {
  const repo = createRepository(
    createMemoryStore({
      calls: [
        {
          callId: "old",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "active",
          turns: [],
          summary: "",
          summaryStatus: "pending",
        },
      ],
    }),
  );
  await repo.ready;
  const [call] = await repo.snapshot();
  assert.equal(call.status, "ended");
  assert.equal(call.interrupted, true);
  assert.ok(call.endedAt);
});
test("concurrent starts always receive different stable identifiers", async () => {
  const repo = createRepository(createMemoryStore());
  const calls = await Promise.all([
    repo.startCall("one"),
    repo.startCall("two"),
  ]);
  assert.notEqual(calls[0].callId, calls[1].callId);
  assert.equal((await repo.snapshot()).length, 2);
});
test("legacy unbound push tokens are not retained after migration", async () => {
  const repo = createRepository(
    createMemoryStore({ pushTokens: ["ExponentPushToken[old]"] }),
  );
  await repo.ready;
  assert.deepEqual(await repo.pushTokens(), []);
});
test("re-pairing a known device replaces its old token without using another slot", async () => {
  const repo = createRepository(createMemoryStore(), { maxDevices: 1 });
  const first = await repo.consumePairingCode("first-code", "known_device_0001");
  const replacement = await repo.consumePairingCode(
    "second-code",
    "known_device_0001",
  );
  assert.ok(first);
  assert.ok(replacement);
  assert.notEqual(first, replacement);
  assert.equal(await repo.hasToken(first), false);
  assert.equal(await repo.hasToken(replacement), true);
});
test("a failed pairing write rolls back its one-time-code consumption", async () => {
  const store = createMemoryStore();
  const originalSave = store.save;
  let failOnce = true;
  store.save = async (state) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("disk unavailable");
    }
    return originalSave(state);
  };
  const repo = createRepository(store);
  await assert.rejects(() => repo.consumePairingCode("retry-code"));
  assert.ok(await repo.consumePairingCode("retry-code"));
});
