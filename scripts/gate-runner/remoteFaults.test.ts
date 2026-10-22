// Stub-runner runs: an unreachable runner and a lost session (T6, T7).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run ([0-9a-f]{12}), tree [0-9a-f]{12}\)$/m;
const remoteRuns = (h: Harness) => h.calls().filter(call => call.command.includes("serve.ts run"));

// T6
test.if(linux)("an unreachable runner runs the command here once, and the answer is cached for a minute", () => {
  const h = harness();
  h.settings({ failProbe: true });
  const file = testFile(h, "pass.test.ts", `test("one", () => console.log("ran-once"));`);
  const first = h.run(["bun", "test", file]);
  expect(first.code).toBe(0);
  expect(first.stderr).toMatch(/^gate-runner: running here: the runner is unavailable: ssh exited 255$/m);
  expect(first.stdout.match(/ran-once/g)).toHaveLength(1);
  const second = h.run(["bun", "test", file]);
  expect(second.code).toBe(0);
  expect(h.calls()).toHaveLength(1);
}, E2E_TIMEOUT);

// T7
test.if(linux)("a session lost after started gives no verdict, and the next calls run here until the mark expires", () => {
  const h = harness();
  h.settings({ killAfterStartedMs: 1500 });
  const file = testFile(h, "slow.test.ts", `test("slow", async () => { console.log("remote-started"); await Bun.sleep(8000); console.log("remote-finished"); }, 20000);`);
  const first = h.run(["bun", "test", file]);
  expect(first.code).toBe(75);
  expect(first.stderr).toMatch(/^gate-runner: no verdict: the connection to the runner was lost after \d+ s; nothing was judged$/m);
  expect(first.stdout).not.toContain("remote-finished");
  const calls = h.calls().length;
  h.settings({});
  const second = h.run(["bun", "test", file]);
  expect(second.code).toBe(0);
  expect(second.stderr).toMatch(/^gate-runner: running here: the runner is unavailable: marked unhealthy after a failed run/m);
  expect(second.stdout).toContain("remote-finished");
  expect(h.calls()).toHaveLength(calls);
  const healthFile = path.join(h.cache, "runner-health.json");
  const health = JSON.parse(fs.readFileSync(healthFile, "utf8"));
  fs.writeFileSync(healthFile, JSON.stringify({ ...health, unhealthyUntil: Date.now() - 1, checkedAt: Date.now() - 31 * 60_000 }));
  const third = h.run(["bun", "test", file]);
  expect(third.stderr).toMatch(RUNNING);
  expect(third.code).toBe(0);
  expect(remoteRuns(h)).toHaveLength(2);
}, E2E_TIMEOUT);
