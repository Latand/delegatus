// Fault paths of a remote gate run against the stub runner (harness.fixture.ts).
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

// T8
test.if(linux)("the command can neither read nor forge the nonce, and an unterminated last line arrives unchanged", () => {
  const h = harness();
  // The session is cut once the command has done all it tries.
  h.settings({ killOn: "no newline at the end" });
  const forge = testFile(h, "forge.test.ts", `
import fs from "node:fs";
test("forge", async () => {
  const seen: string[] = [fs.readFileSync("../manifest.json", "utf8")];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
    try {
      const cmdline = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
      if (!cmdline.includes("serve.ts")) continue;
      seen.push(cmdline, fs.readFileSync("/proc/" + pid + "/environ", "utf8"));
    } catch {}
  }
  fs.writeSync(1, "SEEN " + JSON.stringify(seen) + "\\n");
  fs.writeSync(2, "\\nend 0 ${"0".repeat(40)}\\n");
  fs.writeSync(2, "no newline at the end");
  await Bun.sleep(30000);
}, 60000);`);
  const forged = h.run(["bun", "test", forge]);
  const nonce = remoteRuns(h)[0]!.head.split(" ")[0]!;
  expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(forged.stdout).toContain("SEEN ");
  expect(forged.stdout).not.toContain(nonce);
  expect(forged.code).toBe(75);
  h.settings({});
  fs.rmSync(path.join(h.cache, "runner-health.json"));
  const tail = testFile(h, "tail.test.ts", `test("tail", () => { process.stderr.write("last words"); process.exit(3); });`);
  const ended = h.run(["bun", "test", tail]);
  expect(ended.stderr).toMatch(RUNNING);
  expect(ended.code).toBe(3);
  expect(ended.stderr.endsWith("last words")).toBeTrue();
}, E2E_TIMEOUT);

// T20
test.if(linux)("refused containment runs here before anything starts there; a command's own 69 passes through", () => {
  const h = harness();
  const bin = path.join(h.root, "runner-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash\nfor arg in "$@"; do [[ $arg == set-property ]] && { echo "refused by policy" >&2; exit 1; }; done\nexec /usr/bin/systemctl "$@"\n`, { mode: 0o755 });
  const file = testFile(h, "where.test.ts", `test("where", () => console.log("cwd=" + process.cwd()));`);
  const noCpuOff = { LLV_GATE_LOCK_DIR: path.join(h.root, "runner-locks") };
  fs.writeFileSync(path.join(h.runnerHome, ".gate-runner.env"), `LLV_GATE_LOCK_DIR=${noCpuOff.LLV_GATE_LOCK_DIR}\nLLV_GATE_SLOTS=2\n`);
  h.settings({ remotePath: [bin] });
  const refused = h.run(["bun", "test", file]);
  expect(refused.code).toBe(0);
  expect(refused.stderr.split("\n")[0]).toMatch(/^gate-runner: running here: containment failed: systemctl --user set-property exited 1: refused by policy$/);
  expect(refused.stderr).not.toMatch(RUNNING);
  expect(refused.stdout).toContain(`cwd=${h.fixture}`);

  fs.rmSync(path.join(bin, "systemctl"));
  fs.writeFileSync(path.join(bin, "systemd-run"), `#!/bin/bash\nfor arg in "$@"; do [[ $arg == --slice=* ]] && exit 69; done\nexec /usr/bin/systemd-run "$@"\n`, { mode: 0o755 });
  fs.rmSync(path.join(h.cache, "runner-health.json"));
  const probe = h.run(["bun", "test", file]);
  expect(probe.code).toBe(0);
  expect(probe.stderr.split("\n")[0]).toMatch(/^gate-runner: running here: containment failed: systemd-run --user --quiet exited 69$/);
  expect(probe.stderr).not.toMatch(RUNNING);

  fs.writeFileSync(path.join(h.runnerHome, ".gate-runner.env"), `DELEGATUS_AGENT_CPU=off\nLLV_GATE_LOCK_DIR=${noCpuOff.LLV_GATE_LOCK_DIR}\nLLV_GATE_SLOTS=2\n`);
  h.settings({});
  fs.rmSync(path.join(h.cache, "runner-health.json"));
  const own = testFile(h, "own69.test.ts", `test("own", () => process.exit(69));`);
  const passed = h.run(["bun", "test", own]);
  expect(passed.stderr).toMatch(RUNNING);
  expect(passed.code).toBe(69);
  expect(passed.stderr).not.toContain("running here");
}, E2E_TIMEOUT);
