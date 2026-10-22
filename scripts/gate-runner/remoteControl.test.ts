// Stub-runner runs: control records and containment refusals (T8, T20).
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
