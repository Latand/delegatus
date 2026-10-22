// Stub-runner runs of scripts/gate-slot.sh: no configuration, ineligible calls, verdict parity (T1-T3, T21).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, testFile, withoutRunnerLines, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(options?: Parameters<typeof makeHarness>[0]): Harness { const h = makeHarness(options); harnesses.push(h); return h; }
// Timings and the local CPU queue's waiting lines differ between any two runs.
const normalized = (text: string) => withoutRunnerLines(text).replace(/\[[\d.]+m?s\]/g, "[t]").replace(/^bun test v.*$/m, "").replace(/^gate-slot: Waiting for the CPU queue.*\n/gm, "");
const remoteRuns = (h: Harness) => h.calls().filter(call => call.command.includes("serve.ts run"));
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;


// T1
test.if(linux)("without a configured runner nothing is contacted and the command runs as today", () => {
  const h = harness();
  const file = testFile(h, "plain.test.ts", `test("one", () => expect(1).toBe(1));`);
  const unconfigured = h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER_CONFIG: path.join(h.root, "absent.json") }) });
  const today = h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER: "off" }) });
  expect(h.calls()).toEqual([]);
  expect(unconfigured.code).toBe(0);
  expect(unconfigured.stderr).not.toContain("gate-runner:");
  expect(normalized(unconfigured.stdout + unconfigured.stderr)).toBe(normalized(today.stdout + today.stderr));
}, E2E_TIMEOUT);

// T2
test.if(linux)("off, a test run, an ineligible shape, an isolated check and an outside path never contact the runner", () => {
  const h = harness();
  const file = testFile(h, "plain.test.ts", `test("one", () => expect(1).toBe(1));`);
  expect(h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER: "off" }) }).code).toBe(0);
  expect(h.run(["bun", "test", file], { env: h.env({ NODE_ENV: "test" }) }).code).toBe(0);
  expect(h.run(["/bin/true"]).code).toBe(0);
  expect(h.run(["bun", "--version"]).code).toBe(0);
  // T21, second half: an absolute path outside the tree keeps the command here.
  const outside = path.join(h.root, "outside.test.ts");
  fs.writeFileSync(outside, `import { test } from "bun:test"; test("x", () => {});`);
  expect(h.run(["bun", "test", outside]).code).toBe(0);
  expect(h.calls()).toEqual([]);
  const log = fs.readFileSync(path.join(h.cache, "runner-decisions.log"), "utf8");
  expect(log).toContain("\tineligible\tnot a command shape the runner takes\t");
  expect(log).toContain("\tineligible\tan argument names a path outside the checkout\t");
}, E2E_TIMEOUT);

// T3 and T21
test.if(linux)("a passing and a failing test file give the same verdict and output remotely as here, once", () => {
  const h = harness();
  const pass = testFile(h, "pass.test.ts", `test("adds", () => { console.log("visible"); expect(1 + 1).toBe(2); });`);
  const fail = testFile(h, "fail.test.ts", `test("breaks", () => { expect(1 + 1).toBe(3); });`);
  for (const file of [pass, fail]) {
    const remote = h.run(["bun", "test", file]);
    const local = h.run(["bun", "test", file], { env: h.env({ LLV_GATE_RUNNER: "off" }) });
    expect(remote.stderr).toMatch(RUNNING);
    expect(remote.code).toBe(local.code);
    // A stack trace names the file where it ran: the runner's copy of the tree.
    const here = (text: string) => normalized(text).replace(new RegExp(`${path.join(h.runnerHome, "runs")}/[0-9a-f]{12}/tree`, "g"), h.fixture);
    expect(here(remote.stdout)).toBe(normalized(local.stdout));
    expect(here(remote.stderr)).toBe(normalized(local.stderr));
  }
  expect(remoteRuns(h)).toHaveLength(2);
  // An absolute in-tree argument names the same file there.
  const absolute = h.run(["bun", "test", path.join(h.fixture, fail.slice(2))]);
  expect(absolute.stderr).toMatch(RUNNING);
  expect(absolute.code).toBe(1);
  expect(absolute.stderr).toContain("(fail) breaks");
  expect(fs.readdirSync(path.join(h.runnerHome, "runs"))).toEqual([]);
}, E2E_TIMEOUT);
