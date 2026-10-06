import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareTests, confirmFailures, FLAKY_RERUNS, FLAKY_BUDGET_MS, parseReport, prepareCache, touchedTests, type TestSite, type TestRun } from "./local-gate-tests";
import { gateTemporaryRoot, isolatedEnvironment } from "./local-gate";
import { captureProcessIdentity } from "../src/lib/processIdentity";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = path.resolve(import.meta.dir, "..");
function fixture(source: string) {
  const dir = mkdtempSync(path.join(gateTemporaryRoot(), "gate-comparison-fixture-")); roots.push(dir);
  const env = isolatedEnvironment(path.join(dir, "env"), process.env);
  Object.assign(env, { GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null"); git("remote", "add", "origin", "https://example.invalid/repository.git");
  writeFileSync(path.join(dir, "example.test.ts"), source);
  git("add", "example.test.ts"); git("commit", "-m", "baseline");
  const base = git("rev-parse", "HEAD"), logs: string[] = [], cache = path.join(dir, "cache");
  const run = (files = ["./example.test.ts"]) => touchedTests(dir, base, files, { cache, env, log: line => logs.push(line) });
  return { dir, env, base, git, run, logs, cache };
}
const source = (pass: boolean) => `import { test, expect, describe } from "bun:test"; describe("contract", () => test("same name & Unicode Ω", () => expect(${pass}).toBe(true)));`;

test("a new failure blocks by file and full test identity", () => {
  const f = fixture(source(true)); writeFileSync(path.join(f.dir, "example.test.ts"), source(false));
  const result = f.run();
  expect(result.introduced).toHaveLength(1); expect(result.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("NEW example.test.ts: contract > same name & Unicode Ω");
  expect(f.logs.at(-1)).toContain("1 new failures, 0 pre-existing failures");
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", f.base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(1); expect(cli.stdout).toContain("NEW example.test.ts");
});
test("a failure on both first samples is PRE-EXISTING from the CLI, costs no reruns and is never cached", () => {
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
  const again = f.run(); expect(again.preexisting).toHaveLength(1); expect(again.flaky).toHaveLength(0); expect(again.introduced).toHaveLength(0);
  expect(samples()).toBe(4);
  expect(f.logs.join("\n")).toContain("baseline run");
  expect(readdirSync(f.cache)).toHaveLength(0);
});
test("a failure fixed by the push is reported; a skipped assertion is kept separate", () => {
  const f = fixture(source(false)); writeFileSync(path.join(f.dir, "example.test.ts"), source(true));
  expect(f.run().fixed).toHaveLength(1); expect(f.logs.join("\n")).toContain("FIXED example.test.ts");
  writeFileSync(path.join(f.dir, "example.test.ts"), source(false).replace('test("same', 'test.skip("same'));
  const skipped = f.run(); expect(skipped.fixed).toHaveLength(0); expect(skipped.absent).toHaveLength(1);
});
test("changing the baseline origin invalidates cache before a same-named regression can hide", () => {
  const check = (extra = "true") => `import { test, expect } from "bun:test"; import { execFileSync } from "node:child_process"; const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim(); test("origin contract", () => expect(origin.endsWith("green.git") && ${extra}).toBe(true));`;
  const f = fixture(check());
  f.git("remote", "set-url", "origin", "https://example.invalid/red.git");
  const red = f.run(); expect(red.preexisting).toHaveLength(1); expect(red.flaky).toHaveLength(0);
  f.git("remote", "set-url", "origin", "https://example.invalid/green.git");
  writeFileSync(path.join(f.dir, "example.test.ts"), check("false"));
  f.logs.length = 0;
  const warm = f.run();
  expect(warm.introduced.map(site => site.name)).toEqual(["origin contract"]);
  expect(warm.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline run");
  rmSync(f.cache, { recursive: true, force: true });
  const cold = f.run();
  expect(cold.introduced).toEqual(warm.introduced);
  expect(cold.preexisting).toHaveLength(0);
});
test("a new test file is judged alone, even if an existing test with the same name failed", () => {
  const f = fixture(source(false)); writeFileSync(path.join(f.dir, "new.test.ts"), source(false));
  f.git("remote", "remove", "origin");
  const result = f.run(["./new.test.ts"]);
  expect(result.introduced).toHaveLength(1); expect(result.introduced[0]!.file).toBe("new.test.ts");
  expect(f.logs.join("\n")).toContain("1 new file(s), judged on head alone");
});
test("a baseline that exits without a complete report blocks and is never cached", () => {
  const f = fixture('process.exit(0);'); writeFileSync(path.join(f.dir, "example.test.ts"), source(true));
  expect(() => f.run()).toThrow("baseline: example.test.ts");
  expect(readdirSync(f.cache)).toHaveLength(0);
});
test("a head crash is named and blocks without hiding results from other files", () => {
  const f = fixture(source(true)); writeFileSync(path.join(f.dir, "example.test.ts"), "process.exit(0);");
  writeFileSync(path.join(f.dir, "z.test.ts"), source(false));
  const result = f.run(["./example.test.ts", "./z.test.ts"]);
  expect(result.introduced).toHaveLength(2); expect(result.introduced[0]!.name).toStartWith("<runner error>");
  expect(f.logs.at(-1)).toContain("2 new failures, 0 pre-existing failures");
});
test("per-file processes isolate globals and distinct state/HOME/TMPDIR before imports", () => {
  const f = fixture('import { test } from "bun:test"; globalThis.sharedFixture = 1; test("first", () => {});');
  const second = `import { expect, test } from "bun:test"; import { stateDir } from ${JSON.stringify(path.join(root, "src/lib/configDir.ts"))}; test("isolated", () => { expect(globalThis.sharedFixture).toBeUndefined(); for (const key of ["LLV_STATE_DIR", "HOME", "TMPDIR"]) expect(process.env[key]).toStartWith(${JSON.stringify(path.join(gateTemporaryRoot(), "delegatus-test-comparison-"))}); expect(stateDir()).toBe(process.env.LLV_STATE_DIR); });`;
  writeFileSync(path.join(f.dir, "second.test.ts"), second);
  const result = f.run(["./example.test.ts", "./second.test.ts"]);
  expect(result.introduced).toHaveLength(0);
});
test("duplicate names match occurrences and keep suite ancestry", () => {
  const site: TestSite = { file: "f.test.ts", name: "same", suite: "suite", kind: "test" };
  const base = { failures: [site], passed: [], elapsedMs: 0, completed: [site.file] };
  const result = compareTests(base, { ...base, failures: [site, site, { ...site, suite: "other" }] });
  expect(result.preexisting).toHaveLength(1); expect(result.introduced).toHaveLength(2);
});
test("swapped duplicate outcomes report the stable head occurrence NEW and the recovered occurrence FIXED", () => {
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
test("report errors are retained; incomplete reports and unidentifiable errors are refused", () => {
  const xml = '<testsuites tests="1" failures="0"><testsuite><testcase file="f.test.ts" name="Ω &amp; &quot;quoted&quot;&#10;next" classname="outer &gt; inner" /></testsuite></testsuites>';
  const output = '# Unhandled error between tests\n----------------\nerror: failure in /checkout/file.ts\n----------------\n 1 error\n';
  const parsed = parseReport(xml, output, "f.test.ts", "/checkout");
  expect(parsed.passed[0]!.name).toBe('Ω & "quoted"\nnext'); expect(parsed.passed[0]!.suite).toBe("outer > inner");
  expect(parsed.failures[0]!.name).toContain("<checkout>/file.ts");
  expect(() => parseReport(xml.slice(0, -12), "", "f.test.ts", "/checkout")).toThrow();
  expect(() => parseReport(xml.replace('tests="1"', 'tests="2"'), "", "f.test.ts", "/checkout")).toThrow();
  expect(() => parseReport(xml, " 1 error\n", "f.test.ts", "/checkout")).toThrow();
});

test("an unnamed teardown failure remains a named blocking diagnostic without a filtered retry", () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), source(true) + '\nimport { afterAll } from "bun:test"; afterAll(() => { throw new Error("synthetic owned child survived teardown"); });');
  const result = f.run();
  expect(result.introduced).toHaveLength(1);
  expect(result.introduced[0]!.kind).toBe("error");
  expect(result.introduced[0]!.name).toContain("synthetic owned child survived teardown");
  expect(result.flaky).toHaveLength(0);
  expect(f.logs.join("\n")).not.toContain("flaky confirmation");
});

test.skipIf(process.platform !== "linux")("a green JUnit report cannot hide the owned runner's survivor diagnostic", () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), `import { test } from "bun:test";
test("detached worker", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); process.exit(0);'], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
});`);
  const result = f.run();
  expect(result.introduced).toHaveLength(1);
  expect(result.introduced[0]!.kind).toBe("error");
  expect(result.introduced[0]!.name).toContain("owned runner: surviving owned processes:");
  expect(result.introduced[0]!.name).toMatch(/\d+ \(\d+:\d+\)/);
});
test("cache prunes owned bounded entries, preserves unrelated files, and refuses linked roots", () => {
  const dir = mkdtempSync(path.join(gateTemporaryRoot(), "gate-cache-test-")); roots.push(dir);
  const cache = path.join(dir, "cache"); mkdirSync(cache, { mode: 0o700 });
  for (let i = 0; i < 35; i++) writeFileSync(path.join(cache, `${i.toString(16).padStart(64, "0")}.json`), "{}");
  writeFileSync(path.join(cache, "keep.txt"), "unrelated");
  prepareCache(cache); expect(readdirSync(cache).filter(file => file.endsWith(".json"))).toHaveLength(32);
  const oldest = path.join(cache, readdirSync(cache).find(file => file.endsWith(".json"))!); utimesSync(oldest, 0, 0);
  prepareCache(cache); expect(existsSync(oldest)).toBeFalse(); expect(existsSync(path.join(cache, "keep.txt"))).toBeTrue();
  const pending = path.join(cache, `${"e".repeat(64)}.00000000-0000-0000-0000-000000000000.pending`);
  writeFileSync(pending, "{}"); utimesSync(pending, 0, 0);
  const oversized = path.join(cache, `${"f".repeat(64)}.json`); writeFileSync(oversized, Buffer.alloc(4 * 1024 * 1024 + 1));
  prepareCache(cache); expect(existsSync(pending)).toBeFalse(); expect(existsSync(oversized)).toBeFalse();
  const linked = path.join(dir, "linked"); symlinkSync(cache, linked, "dir"); expect(() => prepareCache(linked)).toThrow("owned private directory");
});
test.skipIf(process.platform === "win32")("a surviving test helper fails the run and cannot keep the slot alive", () => {
  const marker = path.join(gateTemporaryRoot(), `gate-helper-${process.pid}-${Math.random()}`); roots.push(marker);
  const f = fixture(`import { test } from "bun:test"; import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs"; const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); appendFileSync(${JSON.stringify(marker)}, String(child.pid) + "\\n"); child.unref(); test("helper", () => {});`);
  expect(f.run().preexisting.length).toBeGreaterThan(0);
  if (process.platform === "linux") expect(f.logs.join("\n")).toMatch(/PRE-EXISTING .+surviving owned processes: \d+ \(\d+:\d+\)/);
  for (const pid of readFileSync(marker, "utf8").trim().split("\n").map(Number)) {
    const probe = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    expect(probe.status !== 0 || probe.stdout.trim().startsWith("Z")).toBeTrue();
  }
});
test("real pre-push entry permits PRE-EXISTING and refuses NEW after privacy/types/lint", () => {
  const f = fixture(source(false));
  for (const leaf of [".githooks", ".github/workflows", "shims"]) mkdirSync(path.join(f.dir, leaf), { recursive: true });
  mkdirSync(path.join(f.dir, "scripts"));
  for (const name of ["local-gate.ts", "local-gate-tests.ts", "gate-slot.sh", "owned-runner.ts", "verify-native-codex-runtime.ts"]) symlinkSync(path.join(root, "scripts", name), path.join(f.dir, "scripts", name));
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
  const env = { ...f.env, PATH: `${path.join(f.dir, "shims")}:${f.env.PATH}`, FIXTURE_BUN: process.execPath, LLV_GATE_BUN: process.execPath, FIXTURE_CALLS: calls, LLV_SKIP_HOOKS: "0", LLV_GATE_LOCK_DIR: f.dir };
  const hook = () => spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env, encoding: "utf8" });
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

test("an incomplete cached baseline is rebuilt before it can certify a comparison", () => {
  const f = fixture(source(true)); f.run();
  const entry = path.join(f.cache, readdirSync(f.cache)[0]!);
  const contents = JSON.parse(readFileSync(entry, "utf8")); contents.run.completed = [];
  writeFileSync(entry, JSON.stringify(contents)); f.logs.length = 0;
  expect(f.run().introduced).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline run");
});

test("fresh kernel ownership descriptors preserve a warm baseline", () => {
  const f = fixture(source(true));
  expect(f.run().introduced).toHaveLength(0);
  Object.assign(f.env, {
    LLV_OWNED_TEST_RUNNER_PID: "synthetic-next-runner",
    LLV_OWNED_TEST_RUN_CGROUP: "/synthetic-next-service",
    LLV_OWNED_RUN_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)),
    LLV_FIXTURE_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)),
  });
  f.logs.length = 0;
  expect(f.run().introduced).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline cache hit");
});

test.each(["changed failure identity", "missing integrity"])("a cached baseline with %s cannot hide a newly failing test", corruption => {
  const cases = (a: boolean, b: boolean) => `import { test, expect } from "bun:test"; test("case A", () => expect(${a}).toBe(true)); test("case B", () => expect(${b}).toBe(true));`;
  const f = fixture(cases(true, true));
  expect(f.run().introduced).toHaveLength(0);
  const entry = path.join(f.cache, readdirSync(f.cache)[0]!);
  const contents = JSON.parse(readFileSync(entry, "utf8"));
  if (corruption === "changed failure identity") contents.run.failures = [{ file: "example.test.ts", suite: "", name: "case B", kind: "test" }];
  else delete contents.integrity;
  writeFileSync(entry, JSON.stringify(contents));
  writeFileSync(path.join(f.dir, "example.test.ts"), cases(true, false));
  f.logs.length = 0;
  const result = f.run();
  expect(result.introduced.map(site => site.name)).toEqual(["case B"]);
  expect(result.preexisting).toHaveLength(0);
  expect(result.fixed).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline run");
  expect(f.logs.at(-1)).toContain("1 new failures, 0 pre-existing failures, 0 fixed");
});

test("shared cache pruning tolerates six simultaneous gate processes", async () => {
  const dir = mkdtempSync(path.join(gateTemporaryRoot(), "gate-cache-race-")); roots.push(dir);
  const cache = path.join(dir, "cache"); mkdirSync(cache, { mode: 0o700 });
  for (let i = 0; i < 1000; i++) writeFileSync(path.join(cache, `${i.toString(16).padStart(64, "0")}.json`), "{}");
  const env = isolatedEnvironment(path.join(dir, "env"), process.env);
  const code = `import { prepareCache } from ${JSON.stringify(path.join(root, "scripts/local-gate-tests.ts"))}; prepareCache(${JSON.stringify(cache)});`;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code], { env, stdio: "ignore" });
    child.once("error", reject); child.once("exit", resolve);
  })));
  expect(results).toEqual([0, 0, 0, 0, 0, 0]);
  expect(readdirSync(cache).length).toBeLessThanOrEqual(32);
});


test("a changed dependency patch cannot contaminate or reuse the baseline", () => {
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
  const run = () => touchedTests(f.dir, base, ["./example.test.ts"], { cache: f.cache, env: f.env, log: line => f.logs.push(line) });
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("false")); install("--frozen-lockfile");
  expect(readFileSync(path.join(f.dir, "package.json"), "utf8")).toBe(manifest); expect(readFileSync(path.join(f.dir, "bun.lock"), "utf8")).toBe(lock);
  expect(run().introduced).toHaveLength(1);
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("Boolean(1)")); install("--frozen-lockfile");
  expect(run().introduced).toHaveLength(0);
  expect(readdirSync(f.cache).filter(file => file.endsWith(".json"))).toHaveLength(2);
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("false")); install("--frozen-lockfile");
  f.logs.length = 0;
  const warm = run(); expect(warm.introduced).toHaveLength(1); expect(warm.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline cache hit");
});


test.each(["relative directory", "local override"])("%s dependencies keep a green baseline and block cold and warm CLI runs", kind => {
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
  for (const temperature of ["run", "cache hit"]) {
    const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    expect(cli.stdout).toContain(`baseline ${temperature}`);
    expect(cli.stdout).toContain("NEW example.test.ts: dependency returns true");
    expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures");
    expect(cli.status).toBe(1);
  }
}, 60000);

test("between-test errors match across private roots without hiding a changed path", () => {
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


// Persistent counters outside the per-process HOME let a fake test follow an
// exact schedule without CPU pressure, timers or random failure injection.
function scheduledSource(marker: string, baseFailures: number[], headFailures: number[]) {
  return `import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const marker = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(run));
describe("outer", () => describe("inner", () => {
  test("target [Ω]", () => expect((side === "base" ? ${JSON.stringify(baseFailures)} : ${JSON.stringify(headFailures)}).includes(run)).toBe(false));
  test("unrelated", () => appendFileSync(${JSON.stringify(marker)} + "-unrelated", side + "\\n"));
}));`;
}
function scheduledFixture(baseFailures: number[], headFailures: number[]) {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "schedule");
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduledSource(marker, baseFailures, headFailures));
  f.git("add", "example.test.ts"); f.git("commit", "-m", "scheduled baseline");
  const base = f.git("rev-parse", "HEAD");
  const run = () => touchedTests(f.dir, base, ["./example.test.ts"], { cache: f.cache, env: f.env, log: line => f.logs.push(line) });
  const cli = () => spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  return { ...f, marker, run, cli };
}

test("a base-only scheduled failure is FLAKY with both counts and no unrelated reruns", () => {
  const f = scheduledFixture([3], [1, 2, 3, 4]);
  const result = f.run();
  expect(result.introduced).toHaveLength(0); expect(result.flaky).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("FLAKY example.test.ts: inner > outer > target [Ω] (base 3 pass/1 fail; head 0 pass/4 fail)");
  expect(readFileSync(f.marker + "-unrelated", "utf8").trim().split("\n")).toEqual(["base", "head"]);
  expect(readdirSync(f.cache)).toHaveLength(0);
});

test("a base that failed its first sample needs no reruns even when later samples would differ", () => {
  const f = scheduledFixture([1], [1, 2, 3, 4]);
  const accepted = f.cli();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("PRE-EXISTING example.test.ts: inner > outer > target [Ω]");
  expect(accepted.stdout).toContain("0 new failures, 1 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  expect(readFileSync(f.marker + "-base", "utf8")).toBe("1");
  expect(readFileSync(f.marker + "-head", "utf8")).toBe("1");
});

// A throw inside a describe callback is Bun's "Unhandled error between tests":
// the report stays complete and the error appears on every run, filtered or not.
const betweenTests = (message: string | null, extra = "") => `import { test, expect, describe } from "bun:test";
test("steady red", () => expect(false).toBe(true));
${extra}
${message === null ? "" : `describe("broken", () => { test("inner", () => {}); throw new Error(${JSON.stringify(message)}); });`}`;
const cliAt = (f: ReturnType<typeof fixture>, base: string, files = ["./example.test.ts"]) => spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, ...files], { cwd: f.dir, env: f.env, encoding: "utf8" });
const SAME_WAY = "(the base run of this file is broken the same way)";

test("a between-tests error present on both sides is PRE-EXISTING from the CLI and never blocks", () => {
  const f = fixture(betweenTests("describe boom"));
  const accepted = cliAt(f, f.base);
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain(`PRE-EXISTING example.test.ts: <between-tests error> error: describe boom ${SAME_WAY}`);
  expect(accepted.stdout).toContain("PRE-EXISTING example.test.ts: steady red\n");
  expect(accepted.stdout).toContain("0 new failures, 2 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  expect(accepted.stdout).not.toContain("gate error"); expect(accepted.stderr).not.toContain("gate error");
});

test("a retry in a file whose base is broken the same way still confirms its candidates", () => {
  const f = fixture(source(true));
  const counter = path.join(f.dir, "between-schedule");
  const recovering = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const run = existsSync(${JSON.stringify(counter)} + side) ? Number(readFileSync(${JSON.stringify(counter)} + side, "utf8")) + 1 : 1;
writeFileSync(${JSON.stringify(counter)} + side, String(run));
test("recovers", () => expect(side === "base" || run > 1).toBe(true));
test("stays red", () => expect(side === "base").toBe(true));`;
  writeFileSync(path.join(f.dir, "example.test.ts"), betweenTests("describe boom", recovering));
  f.git("add", "example.test.ts"); f.git("commit", "-m", "broken base with a head-only schedule");
  const refused = cliAt(f, f.git("rev-parse", "HEAD"));
  expect(refused.stderr).not.toContain("gate error");
  expect(refused.stdout).toContain("FLAKY example.test.ts: recovers (base 4 pass/0 fail; head 3 pass/1 fail)");
  expect(refused.stdout).toContain("NEW example.test.ts: stays red");
  expect(refused.stdout).toContain(`PRE-EXISTING example.test.ts: <between-tests error> error: describe boom ${SAME_WAY}`);
  expect(refused.stdout).toContain("1 new failures, 2 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
  expect(refused.status).toBe(1);
});

test("a file that cannot finish on either side in the same way is PRE-EXISTING from the CLI and is never cached", () => {
  const f = fixture("process.exit(0);");
  writeFileSync(path.join(f.dir, "example.test.ts"), "// harmless edit\nprocess.exit(0);");
  const accepted = cliAt(f, f.base);
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toMatch(/PRE-EXISTING example\.test\.ts: <runner error> .+ \(the base run of this file is broken the same way\)/);
  expect(accepted.stdout).toContain("0 new failures, 1 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  expect(f.run().preexisting).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("baseline run");
  expect(readdirSync(f.cache)).toHaveLength(0);
});

test("a between-tests error only on the head, or a different one, is NEW from the CLI and blocks", () => {
  const f = fixture(betweenTests(null));
  writeFileSync(path.join(f.dir, "example.test.ts"), betweenTests("describe boom"));
  const headOnly = cliAt(f, f.base);
  expect(headOnly.status).toBe(1);
  expect(headOnly.stdout).toContain("NEW example.test.ts: <between-tests error> error: describe boom\n");
  expect(headOnly.stdout).not.toContain(SAME_WAY);
  expect(headOnly.stdout).toContain("1 new failures, 1 pre-existing failures");
  f.git("add", "example.test.ts"); f.git("commit", "-m", "broken base");
  writeFileSync(path.join(f.dir, "example.test.ts"), betweenTests("another boom"));
  const different = cliAt(f, f.git("rev-parse", "HEAD"));
  expect(different.status).toBe(1);
  expect(different.stdout).toContain("NEW example.test.ts: <between-tests error> error: another boom\n");
  expect(different.stdout).toContain("1 new failures, 1 pre-existing failures, 1 fixed");
});

test("a head that cannot finish a file the base finished is NEW from the CLI and blocks", () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), "process.exit(0);");
  const refused = cliAt(f, f.base);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toMatch(/NEW example\.test\.ts: <runner error> /);
  expect(refused.stdout).not.toContain(SAME_WAY);
});

test("a head scheduled recovery passes CLI and never caches a head pass", () => {
  const f = scheduledFixture([], [1]);
  const accepted = f.cli();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("FLAKY example.test.ts: inner > outer > target [Ω] (base 4 pass/0 fail; head 3 pass/1 fail)");
  // Keep the baseline key and turn only the head into a stable regression.
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduledSource(f.marker, [], [5, 6, 7, 8]));
  const refused = f.cli();
  expect(refused.status).toBe(1); expect(refused.stdout).toContain("baseline cache hit");
  expect(refused.stdout).toContain("NEW example.test.ts: inner > outer > target [Ω]");
});

test("a warm green baseline still gets fresh base retries and flaky evidence is evicted", () => {
  const f = scheduledFixture([2], []);
  expect(f.run().flaky).toHaveLength(0);
  expect(readFileSync(f.marker + "-base", "utf8")).toBe("1");
  expect(readFileSync(f.marker + "-head", "utf8")).toBe("1");
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduledSource(f.marker, [], [2, 3, 4, 5]));
  f.logs.length = 0;
  expect(f.run().flaky).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("baseline cache hit");
  expect(readdirSync(f.cache)).toHaveLength(0);
  // The retry failure must not turn into a cached PRE-EXISTING on the next run.
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduledSource(f.marker, [], [6, 7, 8, 9]));
  f.logs.length = 0;
  const next = f.run();
  expect(next.introduced).toHaveLength(1); expect(next.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline run");
});

test("the stable regression control fails every head sample and refuses CLI", () => {
  const f = scheduledFixture([], [1, 2, 3, 4]);
  const refused = f.cli();
  expect(refused.status).toBe(1); expect(refused.stdout).toContain("NEW example.test.ts: inner > outer > target [Ω]");
  expect(refused.stdout).not.toContain("FLAKY example.test.ts");
  expect(readFileSync(f.marker + "-base", "utf8")).toBe("4");
  expect(readFileSync(f.marker + "-head", "utf8")).toBe("4");
});

test("recovering one duplicate-name occurrence leaves the stable occurrence NEW", () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "duplicate-schedule");
  const trace = path.join(f.dir, "duplicate-trace");
  const duplicate = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const counter = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(run));
let occurrence = 0;
const check = () => { const index = occurrence++; appendFileSync(${JSON.stringify(trace)}, side + ":" + run + ":" + index + "\\n"); expect(index === 0 ? side === "base" : side === "base" || run > 1).toBe(true); };
test("same name", check);
test("same name", check);`;
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicate);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "duplicate identity baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicate);
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(1);
  expect(cli.stdout).toContain("FLAKY example.test.ts: same name");
  expect(cli.stdout).toContain("NEW example.test.ts: same name");
  expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
  expect(readFileSync(trace, "utf8").trim().split("\n").filter(line => line.startsWith("head:")).length).toBe(8);
});

test("overlapping base and head retry evidence belongs to separate duplicate occurrences", () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "overlapping-duplicate-schedule");
  const duplicate = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const counter = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(run));
let occurrence = 0;
const check = () => { const index = occurrence++; expect(index === 0 ? side === "base" : side === "base" ? run !== 2 : run > 1).toBe(true); };
test("same name", check);
test("same name", check);`;
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicate);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "overlapping duplicate schedule");
  const base = f.git("rev-parse", "HEAD");
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(1);
  expect(cli.stdout).toContain("NEW example.test.ts: same name");
  expect(cli.stdout).toContain("FLAKY example.test.ts: same name (base 3 pass/1 fail; head 3 pass/1 fail)");
  expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
});

test("any passing head retry makes an occurrence FLAKY", () => {
  const f = scheduledFixture([], [1, 2, 4]);
  const accepted = f.cli();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("FLAKY example.test.ts: inner > outer > target [Ω] (base 4 pass/0 fail; head 1 pass/3 fail)");
  expect(accepted.stdout).toContain("0 new failures, 0 pre-existing failures");
});

test("a later base retry file error evicts the cache after an earlier failure", () => {
  const f = scheduledFixture([2, 6], []);
  const marker = path.join(f.dir, "second-file-runs");
  const second = `import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const file = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
writeFileSync(file, String(run));
if (side === "base" && run === 2) process.exit(0);
test("second file", () => expect(side === "base" || run !== 2).toBe(true));`;
  writeFileSync(path.join(f.dir, "b.test.ts"), second);
  f.git("add", "b.test.ts"); f.git("commit", "-m", "second retry fixture");
  const base = f.git("rev-parse", "HEAD");
  const run = () => touchedTests(f.dir, base, ["./example.test.ts", "./b.test.ts"], { cache: f.cache, env: f.env, log: line => f.logs.push(line) });
  run();
  expect(readdirSync(f.cache).some(file => file.endsWith(".json"))).toBe(true);
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduledSource(f.marker, [2, 6], [1, 2, 3, 4]));
  expect(() => run()).toThrow("base rerun: b.test.ts");
  expect(readdirSync(f.cache).some(file => file.endsWith(".json"))).toBe(false);
  f.logs.length = 0;
  const next = run();
  expect(f.logs.join("\n")).toContain("baseline run");
  // The aborted batch never reached this file, so its scheduled base failure
  // lands on the rebuilt first sample: a failure on both first samples.
  expect(next.preexisting.map(site => site.name)).toEqual(["target [Ω]"]);
  expect(next.flaky).toHaveLength(0); expect(next.introduced).toHaveLength(0);
});

test("a literal describe separator is filtered inside nested suite ancestry", () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "literal-separator");
  const literal = `import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const file = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
writeFileSync(file, String(run));
describe("outer", () => describe("one > two", () => {
  test("case", () => expect(side === "base" || run > 1).toBe(true));
  test("unrelated", () => appendFileSync(${JSON.stringify(marker)} + "-unrelated", side + "\\n"));
}));`;
  writeFileSync(path.join(f.dir, "example.test.ts"), literal);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "literal suite baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), literal);
  const result = touchedTests(f.dir, base, ["./example.test.ts"], { cache: f.cache, env: f.env, log: line => f.logs.push(line) });
  expect(result.introduced).toHaveLength(0);
  expect(result.flaky).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("FLAKY example.test.ts: one > two > outer > case (base 4 pass/0 fail; head 3 pass/1 fail)");
  expect(readFileSync(marker + "-unrelated", "utf8").trim().split("\n")).toEqual(["base", "head"]);
});

test("the retry bound stays small and incomplete samples cannot become FLAKY", () => {
  expect(FLAKY_RERUNS).toBe(3); expect(FLAKY_BUDGET_MS).toBe(300000);
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test" };
  const run = (failures: TestSite[], passed: TestSite[]): TestRun => ({ failures, passed, completed: [site.file], elapsedMs: 0 });
  const base = run([], [site]), head = run([site], []);
  expect(() => confirmFailures(base, head, side => side === "base" ? base : run([], []))).toThrow("missing or skipped test");
  expect(() => confirmFailures(base, head, () => run([{ ...site, kind: "error" }], []))).toThrow("incomplete runner");
  expect(() => confirmFailures(base, head, () => { throw new Error("flaky rerun budget exhausted"); })).toThrow("budget exhausted");
  // A passing duplicate cannot certify recovery of another stable failing copy.
  const first = { ...site, occurrence: 0 }, second = { ...site, occurrence: 1 };
  const duplicate = run([first, second], []);
  expect(confirmFailures(run([], [first, second]), duplicate, side => side === "base" ? run([], [first, second]) : duplicate).introduced).toHaveLength(2);
});


test("the shared retry deadline blocks before another child starts", () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), source(false));
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    expect(() => touchedTests(f.dir, f.base, ["./example.test.ts"], { cache: f.cache, env: f.env, log: line => {
      if (line.startsWith("touched-tests: head ")) {
        // The budget starts at zero, then advances past the shared deadline.
        clock = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(FLAKY_BUDGET_MS + 1);
      }
    } })).toThrow("flaky rerun budget");
  } finally { clock?.mockRestore(); }
});
