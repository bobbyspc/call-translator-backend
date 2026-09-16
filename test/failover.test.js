import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (target, sources = "") =>
  spawnSync(
    process.execPath,
    ["scripts/twilio-failover.mjs", "--target", target, "--check"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        TWILIO_ACCOUNT_SID: "ACdemo",
        TWILIO_AUTH_TOKEN: "demo",
        TWILIO_PHONE_NUMBER: "+15555550100",
        FORWARDING_SOURCE_NUMBERS: sources,
        DOTENV_CONFIG_PATH: "test/fixtures/no-runtime-env",
      },
    },
  );

test("offline failover preflight accepts a safe target without network access", () => {
  const result = run("+15555550101");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No network request was made/);
});
test("offline failover preflight rejects a forwarding-loop target", () => {
  const result = run("+15555550101", "+15555550101");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forwarding loop/);
});
