// Stub-runner runs: a tree changed on the runner, and secrets that stay here (T9, T12).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, privateValue, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(options?: Parameters<typeof makeHarness>[0]): Harness { const h = makeHarness(options); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;


// T9
test.if(linux)("a tree that changes on the runner after install starts nothing there and runs here", () => {
  const h = harness();
  h.settings({ remoteEnv: { LLV_GATE_RUNNER_TEST_AFTER_INSTALL: "echo changed >> README.md" } });
  const file = testFile(h, "where.test.ts", `test("where", () => console.log("cwd=" + process.cwd()));`);
  const result = h.run(["bun", "test", file]);
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/^gate-runner: running here: tree check failed: the runner checked out tree [0-9a-f]{40} for [0-9a-f]{40}$/m);
  expect(result.stderr).not.toMatch(RUNNING);
  expect(result.stdout).toContain(`cwd=${h.fixture}`);
  expect(result.stdout).not.toContain("/runner/runs/");
}, E2E_TIMEOUT);

// T12
test.if(linux)("secrets stay here, driver switches travel, and the push deadline keeps its remaining budget", () => {
  const h = harness();
  const known = path.join(h.root, "known-values.txt");
  fs.writeFileSync(known, `${privateValue()}\n`);
  const file = testFile(h, "env.test.ts", `test("env", () => console.log("ENV " + JSON.stringify(process.env)));`);
  const deadline = Date.now() + 600_000;
  const result = h.run(["bun", "test", file], { env: h.env({
    GH_TOKEN: "gh-secret", LLV_TOKEN: "llv-secret", LLV_PRIVACY_KNOWN_VALUES_FILE: known, OPENROUTER_API_KEY: "or-secret",
    LLV_KANBAN_BROWSER_TEST: "1", LLV_GATE_PUSH_DEADLINE: String(deadline),
  }) });
  expect(result.stderr).toMatch(RUNNING);
  const remote = JSON.parse(/^ENV (.*)$/m.exec(result.stdout)![1]!) as Record<string, string>;
  const seen = JSON.stringify(remote);
  for (const secret of ["gh-secret", "llv-secret", "or-secret", known, h.root + "/home"]) expect(seen).not.toContain(secret);
  expect(remote.GH_TOKEN).toBeUndefined();
  expect(remote.LLV_PRIVACY_KNOWN_VALUES_FILE).toBeUndefined();
  expect(remote.LLV_KANBAN_BROWSER_TEST).toBe("1");
  expect(remote.HOME).toStartWith(path.join(h.runnerHome, "runs"));
  expect(Math.abs(Number(remote.LLV_GATE_PUSH_DEADLINE) - deadline)).toBeLessThan(2_000);
}, E2E_TIMEOUT);
