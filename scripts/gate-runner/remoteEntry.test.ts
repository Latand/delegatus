// The direct comparator dispatches before isolating its samples.
import { afterEach, expect, test } from "bun:test";
import { LOAD_PROBE } from "./load";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { git, makeHarness, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }
const remoteRuns = (h: Harness) => h.calls().filter(call => call.command.includes("serve.ts run"));
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;

function comparator(h: Harness, file: string, extra: Parameters<Harness["env"]>[0] = {}) {
  return spawnSync(process.execPath, ["scripts/local-gate-tests.ts", "--base", "HEAD", file], {
    cwd: h.fixture, env: h.env(extra), encoding: "utf8", timeout: 200_000,
  });
}

test.if(linux)("a direct comparator sends head and baseline work to one runner and preserves both verdicts", () => {
  const h = harness();
  const file = testFile(h, "comparison.test.ts", `test("existing", () => expect(1).toBe(2));`);
  git(h.fixture, "add", file);
  git(h.fixture, "commit", "--quiet", "--no-verify", "-m", "comparison baseline");
  const existing = comparator(h, file);
  expect(existing.status, existing.stderr).toBe(0);
  expect(existing.stderr).toMatch(RUNNING);
  expect(existing.stdout).toContain("PRE-EXISTING");
  expect(existing.stdout).toContain("0 new failures, 1 pre-existing failures");
  fs.appendFileSync(path.join(h.fixture, file), '\ntest("introduced", () => expect(2).toBe(3));\n');
  const introduced = comparator(h, file);
  expect(introduced.status, introduced.stderr).toBe(1);
  expect(introduced.stderr).toMatch(RUNNING);
  expect(introduced.stdout).toContain("1 new failures, 1 pre-existing failures");
  expect(remoteRuns(h)).toHaveLength(2);
  expect(fs.readdirSync(path.join(h.runnerHome, "runs"))).toEqual([]);
}, E2E_TIMEOUT);

test.if(linux)("a direct comparator retains explicit local runs and announces an unreachable runner's fallback", () => {
  const h = harness();
  const file = testFile(h, "comparison.test.ts", `test("one", () => expect(1).toBe(1));`);
  for (const extra of [{ LLV_GATE_RUNNER: "off" }, { NODE_ENV: "test" }, { LLV_GATE_RUNNER_CONFIG: path.join(h.root, "absent.json") }]) {
    const result = comparator(h, file, extra);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("green head");
  }
  expect(h.calls()).toEqual([]);
  h.settings({ failProbe: true });
  const fallback = comparator(h, file);
  expect(fallback.status, fallback.stderr).toBe(0);
  expect(fallback.stderr).toContain("gate-runner: running here: the runner is unavailable:");
  expect(fallback.stdout).toContain("green head");
  expect(remoteRuns(h)).toHaveLength(0);
}, E2E_TIMEOUT);

test.if(linux)("a direct comparator preserves a lost verdict and never retries started work locally", () => {
  const h = harness();
  const file = testFile(h, "comparison.test.ts", `test("one", () => expect(1).toBe(1));`);
  h.settings({ killOn: "touched-tests: base commit" });
  const lost = comparator(h, file);
  expect(lost.status, lost.stderr).toBe(75);
  expect(lost.stderr).toMatch(RUNNING);
  expect(lost.stderr).toContain("gate-runner: no verdict:");
  expect(lost.stderr).not.toContain("running here:");
  expect(lost.stdout).not.toContain("green head");
  expect(remoteRuns(h)).toHaveLength(1);
  expect(fs.readdirSync(path.join(h.runnerHome, "runs"))).toEqual([]);
}, E2E_TIMEOUT);

test.if(linux)("a direct comparator keeps a tree refused by privacy on this machine", () => {
  const h = harness();
  const file = testFile(h, "comparison.test.ts", `test("one", () => expect(1).toBe(1));`);
  const known = path.join(h.root, "known-values.txt"), value = "private-comparator-fixture-value";
  fs.writeFileSync(known, value + "\n");
  fs.writeFileSync(path.join(h.fixture, "private-note.txt"), value + "\n");
  const result = comparator(h, file, { LLV_PRIVACY_KNOWN_VALUES_FILE: known });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("gate-runner: running here: the privacy scan refused the tree:");
  expect(result.stdout).toContain("green head");
  expect(result.stderr).not.toContain(value);
  expect(h.calls().filter(call => !call.command.includes("manager=ok") && call.command !== LOAD_PROBE)).toEqual([]);
}, E2E_TIMEOUT);
