// Stub-runner runs: cleanup that the runner does not confirm (T26).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 280_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run ([0-9a-f]{12}), tree [0-9a-f]{12}\)$/m;

// T26
test.if(linux)("an unconfirmed cleanup never reports a pass, keeps the run for the sweep, and the sweep later removes only those runs", () => {
  const h = harness();
  const runs = path.join(h.runnerHome, "runs");
  const healthFile = path.join(h.cache, "runner-health.json");
  const pass = testFile(h, "pass.test.ts", `test("one", () => {});`);
  const fail = testFile(h, "fail.test.ts", `test("one", () => { throw new Error("no"); });`);
  const left: string[] = [];
  const kept = (stderr: string) => {
    const id = RUNNING.exec(stderr)![1]!;
    left.push(id);
    expect(fs.existsSync(path.join(runs, id, "lease"))).toBeTrue();
    expect(JSON.parse(fs.readFileSync(healthFile, "utf8"))).toMatchObject({ healthy: false, reason: "cleanup on the runner failed" });
    fs.rmSync(healthFile);
  };

  // 1. The removal's connection fails.
  h.settings({ failOn: "serve.ts remove" });
  const lost = h.run(["bun", "test", pass]);
  expect(lost.code).toBe(75);
  expect(lost.stderr).toMatch(/^gate-runner: cleanup on the runner was not confirmed \(it exited 255\); run [0-9a-f]{12} stays there until the runner's sweep removes it$/m);
  expect(lost.stderr).toMatch(/^gate-runner: no verdict: the run passed, but its cleanup on the runner was not confirmed \(it exited 255\)$/m);
  kept(lost.stderr);

  // 2. The removal never answers; a failing verdict stays decisive.
  h.settings({ hangOn: "serve.ts remove" });
  const hung = h.run(["bun", "test", fail], { env: h.env({ LLV_GATE_RUNNER_REMOVE_TIMEOUT_MS: "3000" }) });
  expect(hung.code).toBe(1);
  expect(hung.stderr).toContain("(fail) one");
  expect(hung.stderr).toMatch(/^gate-runner: cleanup on the runner was not confirmed \(it did not finish in time\);/m);
  kept(hung.stderr);

  // 3. The runner cannot stop the run's unit: serve.ts remove keeps the directory.
  const bin = path.join(h.root, "runner-bin"), stuck = path.join(h.root, "stuck");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash
if [[ -e ${stuck} && " $* " == *" is-active gate-run-"* ]]; then echo active; exit 0; fi
if [[ -e ${stuck} && " $* " == *" stop gate-run-"* ]]; then echo "refused" >&2; exit 1; fi
exec /usr/bin/systemctl "$@"
`, { mode: 0o755 });
  fs.writeFileSync(stuck, "");
  h.settings({ remotePath: [bin] });
  const unstopped = h.run(["bun", "test", pass]);
  expect(unstopped.code).toBe(75);
  expect(unstopped.stderr).toMatch(/^gate-runner: no verdict: the run passed, but its cleanup on the runner was not confirmed \(it exited 3\)$/m);
  kept(unstopped.stderr);

  // Recovery: the runner answers again and the three leases go stale. The next
  // run's sweep removes exactly those three; a live run and a foreign
  // directory stay.
  fs.rmSync(stuck);
  h.settings({});
  const old = new Date(Date.now() - 31 * 60_000);
  for (const id of left) { fs.utimesSync(path.join(runs, id, "lease"), old, old); fs.utimesSync(path.join(runs, id), old, old); }
  const live = randomBytes(6).toString("hex"), foreign = "e2e-manual";
  for (const name of [live, foreign]) fs.mkdirSync(path.join(runs, name));
  fs.writeFileSync(path.join(runs, live, "lease"), "");
  fs.utimesSync(path.join(runs, foreign), old, old);
  const next = h.run(["bun", "test", pass]);
  expect(next.stderr).toMatch(RUNNING);
  expect(next.code).toBe(0);
  expect(fs.readdirSync(runs).sort()).toEqual([live, foreign].sort());
}, E2E_TIMEOUT);
