import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareTests, parseReport, prepareCache, touchedTests, type TestSite } from "./local-gate-tests";
import { gateTemporaryRoot, isolatedEnvironment } from "./local-gate";

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
test("pre-existing failures pass, remain listed, and a warm cache never reruns baseline", () => {
  const marker = path.join(gateTemporaryRoot(), `gate-marker-${process.pid}-${Math.random()}`); roots.push(marker);
  const f = fixture(`import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify("run\n")}); test("old red", () => expect(false).toBe(true));`);
  expect(f.run().introduced).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("PRE-EXISTING example.test.ts: old red");
  const before = readFileSync(marker, "utf8").trim().split("\n").length;
  expect(before).toBe(2);
  f.logs.length = 0; expect(f.run().preexisting).toHaveLength(1);
  expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(3);
  expect(f.logs.join("\n")).toContain("baseline cache hit");
  expect(f.logs.at(-1)).toContain("0 new failures, 1 pre-existing failures");
});
test("a failure fixed by the push is reported; a skipped assertion is kept separate", () => {
  const f = fixture(source(false)); writeFileSync(path.join(f.dir, "example.test.ts"), source(true));
  expect(f.run().fixed).toHaveLength(1); expect(f.logs.join("\n")).toContain("FIXED example.test.ts");
  writeFileSync(path.join(f.dir, "example.test.ts"), source(false).replace('test("same', 'test.skip("same'));
  const skipped = f.run(); expect(skipped.fixed).toHaveLength(0); expect(skipped.absent).toHaveLength(1);
});
test("a new test file is judged alone, even if an existing test with the same name failed", () => {
  const f = fixture(source(false)); writeFileSync(path.join(f.dir, "new.test.ts"), source(false));
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
  const second = `import { expect, test } from "bun:test"; import { stateDir } from ${JSON.stringify(path.join(root, "src/lib/configDir.ts"))}; test("isolated", () => { expect(globalThis.sharedFixture).toBeUndefined(); for (const key of ["LLV_STATE_DIR", "HOME", "TMPDIR"]) expect(process.env[key]).toStartWith("/var/tmp/delegatus-test-comparison-"); expect(stateDir()).toBe(process.env.LLV_STATE_DIR); });`;
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
test.skipIf(process.platform === "win32")("test helpers in the recorded process group cannot keep the slot alive", () => {
  const marker = path.join(gateTemporaryRoot(), `gate-helper-${process.pid}-${Math.random()}`); roots.push(marker);
  const f = fixture(`import { test } from "bun:test"; import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs"; const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); appendFileSync(${JSON.stringify(marker)}, String(child.pid) + "\\n"); child.unref(); test("helper", () => {});`);
  expect(f.run().introduced).toHaveLength(0);
  for (const pid of readFileSync(marker, "utf8").trim().split("\n").map(Number)) {
    const probe = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    expect(probe.status !== 0 || probe.stdout.trim().startsWith("Z")).toBeTrue();
  }
});
test("real pre-push entry permits an old failure and refuses a new one after privacy/types/lint", () => {
  const f = fixture(source(false));
  for (const leaf of [".githooks", ".github/workflows", "shims"]) mkdirSync(path.join(f.dir, leaf), { recursive: true });
  mkdirSync(path.join(f.dir, "scripts"));
  for (const name of ["local-gate.ts", "local-gate-tests.ts", "gate-slot.sh", "verify-native-codex-runtime.ts"]) symlinkSync(path.join(root, "scripts", name), path.join(f.dir, "scripts", name));
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
  const env = { ...f.env, PATH: `${path.join(f.dir, "shims")}:${f.env.PATH}`, FIXTURE_BUN: process.execPath, FIXTURE_CALLS: calls, LLV_SKIP_HOOKS: "0", LLV_GATE_LOCK_DIR: f.dir };
  const hook = () => spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env, encoding: "utf8" });
  const accepted = hook(); if (accepted.status !== 0) throw new Error(accepted.stdout + accepted.stderr); expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("0 new failures, 1 pre-existing failures");
  expect(readFileSync(calls, "utf8")).toContain("--check-commits");
  expect(readFileSync(calls, "utf8")).toContain("tsc --noEmit");
  expect(readFileSync(calls, "utf8")).toContain("scripts/eslint-changes.ts");
  writeFileSync(path.join(f.dir, "example.test.ts"), `${source(false)}\ntest("new red", () => expect(false).toBe(true));`);
  const refused = hook(); expect(refused.status).toBe(1);
  expect(refused.stdout).toContain("NEW example.test.ts: new red");
  expect(refused.stdout).toContain("1 new failures, 1 pre-existing failures");
}, 60000);

test("an incomplete cached baseline is rebuilt before it can certify a comparison", () => {
  const f = fixture(source(false)); f.run();
  const entry = path.join(f.cache, readdirSync(f.cache)[0]!);
  const contents = JSON.parse(readFileSync(entry, "utf8")); contents.run.completed = [];
  writeFileSync(entry, JSON.stringify(contents)); f.logs.length = 0;
  expect(f.run().preexisting).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("baseline run");
});
