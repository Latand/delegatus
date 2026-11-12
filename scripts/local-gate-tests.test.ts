import { appendOwnershipFailure, compareTests, execFileSync, expect, fixture, gateTemporaryRoot, mkdirSync, parseReport, path, readFileSync, root, roots, source, spawnSync, spyOn, symlinkSync, test, type TestRun, type TestSite, touchedTests, writeFileSync } from "./local-gate-tests.fixture";
import { existsSync } from "node:fs";
import { GATE_TASKS_MAX } from "./gate-tasks";
import { BudgetExhausted, comparatorEnding } from "./local-gate-tests";

test("only an exhausted comparator budget returns no verdict", () => {
  const message = "head: test run exceeded its 15 minute budget; 8 of 12 files completed";
  expect(comparatorEnding(new BudgetExhausted(message))).toEqual({
    line: `touched-tests: no verdict: ${message}; nothing was judged`, code: 75,
  });
  for (const error of [new Error(message), new Error("baseline setup failed"), "unknown failure"]) {
    expect(comparatorEnding(error)).toEqual({
      line: `touched-tests: ${error instanceof Error ? error.message : error}; gate error (blocking)`, code: 1,
    });
  }
});


test("review evidence names the exact base and head without changing repository refs", async () => {
  const f = fixture(source(false));
  // The fixture's private run environment may acquire Bun cache files.
  mkdirSync(path.join(f.dir, ".git/info"), { recursive: true });
  writeFileSync(path.join(f.dir, ".git/info/exclude"), "env/\n");
  writeFileSync(path.join(f.dir, "example.test.ts"), `${source(false)}\ntest("added passing case", () => {});`);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "reviewed change");
  const head = f.git("rev-parse", "HEAD");
  const refs = f.git("for-each-ref"), worktrees = f.git("worktree", "list", "--porcelain");
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", f.base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain(`touched-tests: base commit ${f.base}`);
  expect(cli.stdout).toContain(`touched-tests: reviewed head commit ${head}`);
  expect(cli.stdout).toContain("PRE-EXISTING example.test.ts: contract > same name & Unicode Ω");
  expect(cli.stdout).toContain("0 new failures, 1 pre-existing failures");
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(f.git("for-each-ref")).toBe(refs);
  expect(f.git("worktree", "list", "--porcelain")).toBe(worktrees);
  expect(f.git("status", "--porcelain")).toBe("");
});

test("a new failure blocks by file and full test identity", async () => {
  const f = fixture(source(true)); writeFileSync(path.join(f.dir, "example.test.ts"), source(false));
  const result = await f.run();
  expect(result.introduced).toHaveLength(1); expect(result.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("NEW example.test.ts: contract > same name & Unicode Ω");
  expect(f.logs.at(-1)).toContain("1 new failures, 0 pre-existing failures");
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", f.base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(1); expect(cli.stdout).toContain("NEW example.test.ts");
});
test("a failure on both first samples is PRE-EXISTING and its first observation cannot be reused", async () => {
  const marker = path.join(gateTemporaryRoot(), `gate-marker-${process.pid}-${Math.random()}`); roots.push(marker);
  const f = fixture(`import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify("run\n")}); test("old red", () => expect(false).toBe(true));`);
  const samples = () => readFileSync(marker, "utf8").trim().split("\n").length;
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", f.base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain("PRE-EXISTING example.test.ts: old red");
  expect(cli.stdout).not.toContain("FLAKY"); expect(cli.stdout).not.toContain("flaky confirmation");
  expect(cli.stdout).toContain("0 new failures, 1 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  // One process per side: the base sample and the head sample, nothing more.
  expect(samples()).toBe(2);
  f.env.INVOCATION_ID = "another-systemd-scope";
  const again = await f.run(); expect(again.preexisting).toHaveLength(1); expect(again.flaky).toHaveLength(0); expect(again.introduced).toHaveLength(0);
  expect(samples()).toBe(4);
  expect(f.logs.join("\n")).toContain("baseline run");
});
test("a green head needs no main-side evidence, including fixed or skipped assertions", async () => {
  const f = fixture(source(false)); writeFileSync(path.join(f.dir, "example.test.ts"), source(true));
  expect((await f.run()).fixed).toHaveLength(0); expect(f.logs.join("\n")).toContain("green head; no baseline");
  writeFileSync(path.join(f.dir, "example.test.ts"), source(false).replace('test("same', 'test.skip("same'));
  const skipped = await f.run(); expect(skipped.fixed).toHaveLength(0); expect(skipped.absent).toHaveLength(0);
});
test("a fresh main sample uses the current origin before classifying a regression", async () => {
  const check = (extra = "true") => `import { test, expect } from "bun:test"; import { execFileSync } from "node:child_process"; const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim(); test("origin contract", () => expect(origin.endsWith("green.git") && ${extra}).toBe(true));`;
  const f = fixture(check());
  f.git("remote", "set-url", "origin", "https://example.invalid/red.git");
  const red = await f.run(); expect(red.preexisting).toHaveLength(1); expect(red.flaky).toHaveLength(0);
  f.git("remote", "set-url", "origin", "https://example.invalid/green.git");
  writeFileSync(path.join(f.dir, "example.test.ts"), check("false"));
  f.logs.length = 0;
  const warm = await f.run();
  expect(warm.introduced.map(site => site.name)).toEqual(["origin contract"]);
  expect(warm.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline run");
  const cold = await f.run();
  expect(cold.introduced).toEqual(warm.introduced);
  expect(cold.preexisting).toHaveLength(0);
});
test("a new test file is judged alone, even if an existing test with the same name failed", async () => {
  const f = fixture(source(false)); writeFileSync(path.join(f.dir, "new.test.ts"), source(false));
  f.git("remote", "remove", "origin");
  const result = await f.run(["./new.test.ts"]);
  expect(result.introduced).toHaveLength(1); expect(result.introduced[0]!.file).toBe("new.test.ts");
  expect(f.logs.join("\n")).toContain("1 new file(s), judged on head alone");
});
test("a broken baseline cannot block a green head", async () => {
  const f = fixture('process.exit(0);'); writeFileSync(path.join(f.dir, "example.test.ts"), source(true));
  expect((await f.run()).introduced).toHaveLength(0);
  expect(f.logs.join("\n")).not.toContain("baseline run");
});
test("a head crash is named and blocks without hiding results from other files", async () => {
  const f = fixture(source(true)); writeFileSync(path.join(f.dir, "example.test.ts"), "process.exit(0);");
  writeFileSync(path.join(f.dir, "z.test.ts"), source(false));
  const result = await f.run(["./example.test.ts", "./z.test.ts"]);
  expect(result.introduced).toHaveLength(2); expect(result.introduced[0]!.name).toStartWith("<runner error>");
  expect(f.logs.at(-1)).toContain("2 new failures, 0 pre-existing failures");
});
const taskControl = process.platform === "linux" && Bun.which("python3") && Bun.which("systemd-run")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status === 0
  && readFileSync("/proc/self/cgroup", "utf8").split("\n").some(line => line.startsWith("0::") && existsSync(path.join("/sys/fs/cgroup", line.slice(3), "pids.max")));
const taskPeakLine = (denied: boolean) => new RegExp(
  `pids\\.peak=(\\d+)(?: \\(sampled lower bound\\))? pids\\.max=${GATE_TASKS_MAX} pids\\.events:max=${denied ? "[1-9]\\d*" : "0"}`,
);
function expectTaskPeak(output: string, denied: boolean) {
  const match = output.match(taskPeakLine(denied));
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThan(0);
  expect(Number(match![1])).toBeLessThanOrEqual(GATE_TASKS_MAX);
}
test.skipIf(!taskControl)("per-file summaries retain the owning unit's task peak", async () => {
  const f = fixture(source(true));
  expect((await f.run()).introduced).toHaveLength(0);
  const line = f.logs.find(line => line.startsWith("touched-tests: head file "))!;
  expectTaskPeak(line, false);
});
test.skipIf(!taskControl)("a real bounded task-limit refusal keeps its name and unit through the comparator", async () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "storm.test.ts"), `import { test } from "bun:test";
    import { spawnSync } from "node:child_process";
    test("bounded task control", () => { spawnSync("python3", [${JSON.stringify(path.join(root, "scripts/fixtures/gateForkStorm.py"))}, "--exit-on-denial"]); });`);
  const result = await f.run(["./storm.test.ts"]);
  expect(result.introduced).toHaveLength(1);
  expect(result.introduced[0]!.name).toMatch(/GATE_TASK_LIMIT_REACHED: task limit reached in delegatus-gate-[a-f0-9-]+\.service/);
  expectTaskPeak(f.logs.join("\n"), true);
  expect(f.logs.join("\n")).toMatch(new RegExp(`GATE_TASK_LIMIT_REACHED: task limit reached in delegatus-gate-[a-f0-9-]+\\.service \\(pids\\.max=${GATE_TASKS_MAX}, pids\\.events:max=[1-9]\\d*\\)`));
  expect(f.logs.join("\n")).not.toContain("runner did not finish (70)");
}, 30_000);
test("per-file processes isolate globals and distinct state/HOME/TMPDIR before imports", async () => {
  const f = fixture('import { test } from "bun:test"; globalThis.sharedFixture = 1; test("first", () => {});');
  const second = `import { expect, test } from "bun:test"; import { stateDir } from ${JSON.stringify(path.join(root, "src/lib/configDir.ts"))}; test("isolated", () => { expect(globalThis.sharedFixture).toBeUndefined(); for (const key of ["LLV_STATE_DIR", "HOME", "TMPDIR"]) expect(process.env[key]).toStartWith(${JSON.stringify(path.join(gateTemporaryRoot(), "delegatus-test-comparison-"))}); expect(stateDir()).toBe(process.env.LLV_STATE_DIR); });`;
  writeFileSync(path.join(f.dir, "second.test.ts"), second);
  const result = await f.run(["./example.test.ts", "./second.test.ts"]);
  expect(result.introduced).toHaveLength(0);
});

test("gate samples allow tests beyond five seconds and retain explicit timeouts", async () => {
  const f = fixture(`import { test } from "bun:test";
    test("default exceeds five seconds", async () => { await Bun.sleep(6_000); });
    test("explicit deadline still refuses", async () => { await new Promise(() => {}); }, 50);
  `);
  const result = await f.run();
  expect(result.introduced).toHaveLength(0);
  expect(result.preexisting.map(site => site.name)).toEqual(["explicit deadline still refuses"]);
  expect(f.logs.join("\n")).toContain("0 new failures, 1 pre-existing failures");
});

test.each([150_000, 150_001])("head file growth hint uses half the file budget: %i ms", async elapsedMs => {
  const f = fixture(source(true));
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const spawn = Bun.spawn;
  const launch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const child = spawn(...args);
    // Advance the parent's clock only after its real test runner settles.
    void child.exited.then(() => { now = elapsedMs; });
    return child;
  }) as typeof Bun.spawn);
  try {
    expect((await f.run()).introduced).toHaveLength(0);
    const line = f.logs.find(line => line.startsWith("touched-tests: head file "))!;
    expect(line).toContain(`${elapsedMs}ms wall; 0 failures; complete`);
    expect(line.includes("over half the 300 s file budget; split it")).toBe(elapsedMs > 150_000);
  } finally { launch.mockRestore(); clock.mockRestore(); }
});

test("duplicate names match occurrences and keep suite ancestry", async () => {
  const site: TestSite = { file: "f.test.ts", name: "same", suite: "suite", kind: "test" };
  const base = { failures: [site], passed: [], elapsedMs: 0, completed: [site.file] };
  const result = compareTests(base, { ...base, failures: [site, site, { ...site, suite: "other" }] });
  expect(result.preexisting).toHaveLength(1); expect(result.introduced).toHaveLength(2);
});
test("scope and service guards report an identical surviving tree once across the baseline", async () => {
  const file = "fixture.test.ts";
  const failures: TestSite[] = [{ file, suite: "", kind: "error",
    name: "<hook error> owned test scope children survived teardown: 22 (22:2), 21 (21:1)" }];
  appendOwnershipFailure(failures, file, "owned runner: surviving owned processes: 21 (21:1), 22 (22:2)");
  const base: TestRun = { failures: [{ file, suite: "", kind: "error",
    name: "<ownership error> owned runner: surviving owned processes: 31 (31:3)" }], passed: [], completed: [file], elapsedMs: 0 };
  const result = compareTests(base, { ...base, failures });
  expect(result.introduced).toEqual([]);
  expect(result.preexisting).toHaveLength(1);
  expect(result.preexisting[0]!.name).toContain("21 (21:1), 22 (22:2)");
});
test.each([
  ["owned test children survived teardown: 21, 22; guardian=0", "owned test children survived teardown: 31; guardian=0"],
  ["owned test children survived teardown: ; guardian=1", "owned test children survived teardown: 31; guardian=1"],
  ["owned test scope children survived teardown: 21 (21:1), 22 (null)", "owned test scope children survived teardown: 31 (31:3)"],
])("teardown comparison ignores run identities and preserves evidence: %s", (oldMessage, newMessage) => {
  const site = (message: string): TestSite => ({ file: "fixture.test.ts", suite: "", kind: "error", name: `<hook error> ${message}` });
  const base: TestRun = { failures: [site(oldMessage)], passed: [], completed: ["fixture.test.ts"], elapsedMs: 0 };
  const head = { ...base, failures: [site(newMessage)] };
  expect(compareTests(base, head)).toEqual({ introduced: [], preexisting: head.failures, fixed: [], absent: [] });
  expect(head.failures[0]!.name).toBe(`<hook error> ${newMessage}`);
  const changed = site("owned test child survived the final identity check");
  expect(compareTests(base, { ...head, failures: [changed] })).toEqual({ introduced: [changed], preexisting: [], fixed: base.failures, absent: [] });
});
test("teardown comparison retains the guardian outcome", () => {
  const site = (guardian: number): TestSite => ({ file: "fixture.test.ts", suite: "", kind: "error",
    name: `<hook error> owned test children survived teardown: 21; guardian=${guardian}` });
  const base: TestRun = { failures: [site(0)], passed: [], completed: ["fixture.test.ts"], elapsedMs: 0 };
  const head = { ...base, failures: [site(1)] };
  expect(compareTests(base, head)).toEqual({ introduced: head.failures, preexisting: [], fixed: base.failures, absent: [] });
});
test("distinct scope identities and unrelated hook failures remain blocking", async () => {
  const file = "fixture.test.ts";
  const failures: TestSite[] = [{ file, suite: "", kind: "error",
    name: "<hook error> owned test scope children survived teardown: 21 (21:9)" },
  { file, suite: "", kind: "error", name: "<hook error> fixture failed to close" }];
  appendOwnershipFailure(failures, file, "owned runner: surviving owned processes: 21 (21:1)");
  expect(failures).toHaveLength(3);
  const empty: TestRun = { failures: [], passed: [], completed: [file], elapsedMs: 0 };
  expect(compareTests(empty, { ...empty, failures }).introduced).toHaveLength(3);
});
test("swapped duplicate outcomes report the stable head occurrence NEW and the recovered occurrence FIXED", async () => {
  const f = fixture(source(true));
  const duplicateSource = (firstFails: boolean, secondFails: boolean) => `import { test, expect } from "bun:test";
test("same name", () => expect(${!firstFails}).toBe(true));
test("same name", () => expect(${!secondFails}).toBe(true));`;
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicateSource(true, false));
  f.git("add", "example.test.ts"); f.git("commit", "-m", "duplicate outcome baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicateSource(false, true));
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(1);
  expect(cli.stdout).toContain("NEW example.test.ts: same name");
  expect(cli.stdout).toContain("FIXED example.test.ts: same name");
  expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures, 1 fixed, 0 removed/skipped, 0 flaky");
});
test("report errors are retained; incomplete reports and unidentifiable errors are refused", async () => {
  const xml = '<testsuites tests="1" failures="0"><testsuite><testcase file="f.test.ts" name="Ω &amp; &quot;quoted&quot;&#10;next" classname="outer &gt; inner" /></testsuite></testsuites>';
  const output = '# Unhandled error between tests\n----------------\nerror: failure in /checkout/file.ts\n----------------\n 1 error\n';
  const parsed = parseReport(xml, output, "f.test.ts", "/checkout");
  expect(parsed.passed[0]!.name).toBe('Ω & "quoted"\nnext'); expect(parsed.passed[0]!.suite).toBe("outer > inner");
  expect(parsed.failures[0]!.name).toContain("<checkout>/file.ts");
  expect(() => parseReport(xml.slice(0, -12), "", "f.test.ts", "/checkout")).toThrow();
  expect(() => parseReport(xml.replace('tests="1"', 'tests="2"'), "", "f.test.ts", "/checkout")).toThrow();
  expect(() => parseReport(xml, " 1 error\n", "f.test.ts", "/checkout")).toThrow();
});

test("an unnamed teardown failure remains a named blocking diagnostic without a filtered retry", async () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), source(true) + '\nimport { afterAll } from "bun:test"; afterAll(() => { throw new Error("synthetic owned child survived teardown"); });');
  const result = await f.run();
  expect(result.introduced).toHaveLength(1);
  expect(result.introduced[0]!.kind).toBe("error");
  expect(result.introduced[0]!.name).toContain("synthetic owned child survived teardown");
  expect(result.flaky).toHaveLength(0);
  expect(f.logs.join("\n")).not.toContain("flaky confirmation");
});

test.skipIf(process.platform !== "linux")("a green JUnit report cannot hide the owned runner's survivor diagnostic", async () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), `import { test } from "bun:test";
test("detached worker", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); process.exit(0);'], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
});`);
  const result = await f.run();
  expect(result.introduced).toHaveLength(1);
  expect(result.introduced[0]!.kind).toBe("error");
  expect(result.introduced[0]!.name).toContain("owned runner: surviving owned processes:");
  expect(result.introduced[0]!.name).toMatch(/\d+ \(\d+:\d+\)/);
});
test.skipIf(process.platform !== "linux")("a green head skips an old surviving-helper baseline", async () => {
  const f = fixture(source(true) + `\nimport { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref();`);
  writeFileSync(path.join(f.dir, "example.test.ts"), source(true));
  const result = await f.run();
  expect(result.introduced).toHaveLength(0);
  expect(result.fixed).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("green head; no baseline");
});
test.skipIf(process.platform === "win32")("a surviving test helper fails the run and cannot keep the slot alive", async () => {
  const marker = path.join(gateTemporaryRoot(), `gate-helper-${process.pid}-${Math.random()}`); roots.push(marker);
  const f = fixture(`import { test } from "bun:test"; import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs"; const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); appendFileSync(${JSON.stringify(marker)}, String(child.pid) + "\\n"); child.unref(); test("helper", () => {});`);
  expect((await f.run()).preexisting.length).toBeGreaterThan(0);
  if (process.platform === "linux") expect(f.logs.join("\n")).toMatch(/PRE-EXISTING .+surviving owned processes: \d+ \(\d+:\d+\)/);
  for (const pid of readFileSync(marker, "utf8").trim().split("\n").map(Number)) {
    const probe = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    expect(probe.status !== 0 || probe.stdout.trim().startsWith("Z")).toBeTrue();
  }
});
test("real pre-push entry permits PRE-EXISTING and refuses NEW after privacy/types/lint", async () => {
  const f = fixture(source(false));
  for (const leaf of [".githooks", ".github/workflows", "shims"]) mkdirSync(path.join(f.dir, leaf), { recursive: true });
  mkdirSync(path.join(f.dir, "scripts"));
  for (const name of ["local-gate.ts", "local-gate-tests.ts", "gate-slot.sh", "cpu-admission.ts", "owned-runner.ts", "verify-native-codex-runtime.ts"]) symlinkSync(path.join(root, "scripts", name), path.join(f.dir, "scripts", name));
  writeFileSync(path.join(f.dir, ".githooks/pre-push"), readFileSync(path.join(root, ".githooks/pre-push")));
  for (const name of ["platform-tests.yml", "bun-runtime.yml"]) writeFileSync(path.join(f.dir, ".github/workflows", name), readFileSync(path.join(root, ".github/workflows", name)));
  const calls = path.join(f.dir, "phases.log");
  for (const name of ["bun", "bunx"]) writeFileSync(path.join(f.dir, "shims", name), `#!/bin/bash\nif [[ "$1" == scripts/local-gate.ts || "$1" == scripts/local-gate-tests.ts ]]; then exec "$FIXTURE_BUN" "$@"; fi\nprintf '%s\\n' "$*" >> "$FIXTURE_CALLS"\n`, { mode: 0o700 });
  writeFileSync(path.join(f.dir, ".gitignore"), "env/\nshims/\nphases.log\ncache/\n");
  f.git("add", ".githooks", ".github", "scripts", ".gitignore"); f.git("commit", "-m", "hook fixture");
  const hookBase = f.git("rev-parse", "HEAD");
  const remote = path.join(f.dir, "env", "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { env: f.env, stdio: "pipe" });
  execFileSync("git", ["--git-dir", remote, "fetch", f.dir, "HEAD:main"], { env: f.env, stdio: "pipe" });
  f.git("remote", "set-url", "origin", remote); f.git("update-ref", "refs/remotes/origin/main", hookBase);
  writeFileSync(path.join(f.dir, "example.test.ts"), `// harmless\n${source(false)}`);
  const env = { ...f.env, PATH: `${path.join(f.dir, "shims")}:${f.env.PATH}`, FIXTURE_BUN: process.execPath, LLV_GATE_BUN: process.execPath, FIXTURE_CALLS: calls, LLV_SKIP_HOOKS: "0", LLV_GATE_LOCK_DIR: f.dir,
    LLV_GATE_CHECK_ENV: "FIXTURE_BUN,FIXTURE_CALLS" };
  const hook = () => { const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env, encoding: "utf8" }); return { ...result, stdout: result.stdout + result.stderr }; };
  const accepted = hook(); if (accepted.status !== 0) throw new Error(accepted.stdout + accepted.stderr); expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("PRE-EXISTING example.test.ts: contract > same name & Unicode Ω");
  expect(accepted.stdout).toContain("0 new failures, 1 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  expect(readFileSync(calls, "utf8")).toContain("--check-commits");
  expect(readFileSync(calls, "utf8")).toContain("tsc --noEmit");
  expect(readFileSync(calls, "utf8")).toContain("scripts/eslint-changes.ts");
  writeFileSync(path.join(f.dir, "example.test.ts"), `${source(false)}\ntest("new red", () => expect(false).toBe(true));`);
  const refused = hook(); expect(refused.status).toBe(1);
  if (!refused.stdout.includes("NEW")) throw new Error(refused.stdout + refused.stderr);
  expect(refused.stdout).toContain("NEW example.test.ts: new red");
  expect(refused.stdout).toContain("1 new failures, 1 pre-existing failures");
}, 60000);


test("a changed dependency patch cannot contaminate or reuse the baseline", async () => {
  const f = fixture('import { test, expect } from "bun:test"; import value from "fixture-dependency"; test("dependency returns true", () => expect(value).toBe(true));');
  const pack = path.join(f.dir, "pack", "package"); mkdirSync(pack, { recursive: true });
  writeFileSync(path.join(pack, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }));
  writeFileSync(path.join(pack, "index.js"), "module.exports = true;\n");
  execFileSync("tar", ["-czf", path.join(f.dir, "dependency.tgz"), "-C", path.dirname(pack), "package"]);
  writeFileSync(path.join(f.dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: { "fixture-dependency": "file:./dependency.tgz" }, patchedDependencies: { "fixture-dependency@./dependency.tgz": "dependency.patch" } }));
  const patch = (value: string) => `diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = true;\n+module.exports = ${value};\n`;
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("Boolean(1)"));
  const install = (...flags: string[]) => execFileSync(process.execPath, ["install", "--ignore-scripts", ...flags], { cwd: f.dir, env: f.env, stdio: "pipe" });
  install();
  f.git("add", "package.json", "bun.lock", "dependency.tgz", "dependency.patch"); f.git("commit", "-m", "patched baseline");
  const base = f.git("rev-parse", "HEAD"), manifest = readFileSync(path.join(f.dir, "package.json"), "utf8"), lock = readFileSync(path.join(f.dir, "bun.lock"), "utf8");
  const run = () => touchedTests(f.dir, base, ["./example.test.ts"], { env: f.env, log: line => f.logs.push(line) });
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("false")); install("--frozen-lockfile");
  expect(readFileSync(path.join(f.dir, "package.json"), "utf8")).toBe(manifest); expect(readFileSync(path.join(f.dir, "bun.lock"), "utf8")).toBe(lock);
  expect((await run()).introduced).toHaveLength(1);
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("Boolean(1)")); install("--frozen-lockfile");
  expect((await run()).introduced).toHaveLength(0);
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("false")); install("--frozen-lockfile");
  f.logs.length = 0;
  const warm = await run(); expect(warm.introduced).toHaveLength(1); expect(warm.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline run");
});


test.each(["relative directory", "local override"])("%s dependencies keep a green baseline and block cold and warm CLI runs", async kind => {
  const check = 'import { test, expect } from "bun:test"; import value from "fixture-dependency"; test("dependency returns true", () => expect(value).toBe(true));';
  const f = fixture(check);
  const dependency = path.join(f.dir, "dependency"); mkdirSync(dependency);
  writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }));
  writeFileSync(path.join(dependency, "index.js"), "module.exports = true;\n");
  writeFileSync(path.join(f.dir, "package.json"), JSON.stringify(kind === "local override"
    ? { name: "fixture", dependencies: { "fixture-dependency": "1.0.0" }, overrides: { "fixture-dependency": "./dependency" } }
    : { name: "fixture", dependencies: { "fixture-dependency": "./dependency" } }));
  const install = (cwd: string) => execFileSync(process.execPath, ["install", "--ignore-scripts"], { cwd, env: f.env, stdio: "pipe" });
  install(f.dir);
  f.git("add", "package.json", "bun.lock", "dependency"); f.git("commit", "-m", "local dependency baseline");
  const base = f.git("rev-parse", "HEAD");
  const manifest = readFileSync(path.join(f.dir, "package.json"), "utf8"), lock = readFileSync(path.join(f.dir, "bun.lock"), "utf8");
  writeFileSync(path.join(dependency, "index.js"), "module.exports = false;\n");
  writeFileSync(path.join(f.dir, "example.test.ts"), `// harmless edit\n${check}`);
  f.git("add", "dependency/index.js", "example.test.ts"); f.git("commit", "-m", "dependency regression");
  expect(readFileSync(path.join(f.dir, "node_modules/fixture-dependency/index.js"), "utf8")).toContain("false");
  expect(readFileSync(path.join(f.dir, "package.json"), "utf8")).toBe(manifest);
  expect(readFileSync(path.join(f.dir, "bun.lock"), "utf8")).toBe(lock);
  const control = path.join(f.dir, "env", "control");
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", f.dir, control], { env: f.env, stdio: "pipe" });
  execFileSync("git", ["checkout", "--quiet", "--detach", base], { cwd: control, env: f.env, stdio: "pipe" });
  install(control);
  expect(spawnSync(process.execPath, ["test", "./example.test.ts"], { cwd: control, env: f.env }).status).toBe(0);
  expect(spawnSync(process.execPath, ["test", "./example.test.ts"], { cwd: f.dir, env: f.env }).status).toBe(1);
  for (const temperature of ["run", "run"]) {
    const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    expect(cli.stdout).toContain(`baseline ${temperature}`);
    expect(cli.stdout).toContain("NEW example.test.ts: dependency returns true");
    expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures");
    expect(cli.status).toBe(1);
  }
}, 60000);

test("between-test errors match across private roots without hiding a changed path", async () => {
  const xml = '<testsuites tests="1" failures="0"><testcase file="f.test.ts" name="passing" /></testsuites>';
  const run = (suffix: string, file = "missing") => {
    const home = path.join(gateTemporaryRoot(), `delegatus-test-comparison-${suffix}`, `test-${suffix}`, "home", file);
    const output = `# Unhandled error between tests\n----------------\nerror: ENOENT: ${home}\n----------------\n 1 error\n`;
    return { ...parseReport(xml, output, "f.test.ts", "/checkout"), elapsedMs: 0, completed: ["f.test.ts"] };
  };
  const old = run("ABCDEF"), head = run("GHIJKL");
  expect(compareTests(old, head).introduced).toHaveLength(0);
  expect(compareTests(old, head).preexisting).toHaveLength(1);
  expect(compareTests(old, run("GHIJKL", "different")).introduced).toHaveLength(1);
});
