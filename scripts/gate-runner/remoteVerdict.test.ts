// Stub-runner runs: a verdict the command cannot forge, and history that never
// leaves this machine unscanned (T24, T25).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { git, makeHarness, privateValue, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;

// T24
test.if(linux)("a planted completion record never passes, whether the command kills its supervisor or only signals it", () => {
  const h = harness();
  // The command plants `exit` = 0 beside its tree, signals the exact
  // `serve.ts exec` of its own run, then fails an assertion.
  const forge = (signal: string) => testFile(h, `forge-${signal}.test.ts`, `
import fs from "node:fs";
test("forge without the nonce", () => {
  const id = JSON.parse(fs.readFileSync("../manifest.json", "utf8")).id;
  fs.writeFileSync("../exit", "0\\n");
  for (const pid of fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
    let argv: string[] = [];
    try { argv = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0"); } catch { continue; }
    // The supervisor itself (bun serve.ts exec <dir>), not systemd-run, whose argv names it too.
    if (argv[1]?.endsWith("/serve.ts") && argv[2] === "exec" && argv[3]?.endsWith("/" + id)) process.kill(Number(pid), "${signal}");
  }
  expect("forged").toBe("judged");
});`);
  const killed = h.run(["bun", "test", forge("SIGKILL")]);
  expect(killed.stderr).toMatch(RUNNING);
  expect(killed.code).toBe(75);
  expect(killed.stderr).toMatch(/^gate-runner: no verdict: the run's completion record disagrees with its unit \(unit exit \d+\); nothing was judged$/m);
  expect(fs.readdirSync(path.join(h.runnerHome, "runs"))).toEqual([]);

  fs.rmSync(path.join(h.cache, "runner-health.json"));
  // SIGPIPE would end an unprepared supervisor cleanly, which systemd-run reports as 0.
  const piped = h.run(["bun", "test", forge("SIGPIPE")]);
  expect(piped.stderr).toMatch(RUNNING);
  expect(piped.code).toBe(1);
  expect(piped.stderr).toContain("(fail) forge without the nonce");
}, E2E_TIMEOUT);

// T25
test.if(linux)("a private value one lane commit added and a later one deleted keeps every byte here", () => {
  const h = harness();
  const known = path.join(h.root, "known-values.txt");
  const value = privateValue();
  fs.writeFileSync(known, `${value}\n`);
  fs.writeFileSync(path.join(h.fixture, "history-note.txt"), `text with ${value} inside\n`);
  git(h.fixture, "add", "history-note.txt");
  git(h.fixture, "commit", "--quiet", "--no-verify", "-m", "add a note");
  git(h.fixture, "rm", "--quiet", "history-note.txt");
  git(h.fixture, "commit", "--quiet", "--no-verify", "-m", "remove the note");
  const file = testFile(h, "pass.test.ts", `test("one", () => expect(1).toBe(1));`);
  const result = h.run(["bun", "test", file], { env: h.env({ LLV_PRIVACY_KNOWN_VALUES_FILE: known }) });
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/^gate-runner: running here: the privacy scan refused the tree: /m);
  expect(result.stderr).not.toMatch(RUNNING);
  expect(h.calls().filter(call => !call.command.includes("manager=ok"))).toEqual([]);
  // Without the known value the same history goes.
  fs.rmSync(path.join(h.cache, "runner-health.json"));
  const clean = h.run(["bun", "test", file]);
  expect(clean.stderr).toMatch(RUNNING);
  expect(clean.code).toBe(0);
}, E2E_TIMEOUT);
