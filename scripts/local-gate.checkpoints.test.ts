import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedEnvironment, plan, type PlanEnvironment } from "./local-gate";
import { headFileCache } from "./local-gate-tests";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const serviceTest = test.skipIf(process.platform !== "linux"
  || spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status !== 0);

test("shared comparator inputs retain every split test group in publication selection", () => {
  const groups = ["scripts/local-gate-tests.test.ts", "scripts/local-gate-tests.retry.test.ts",
    "scripts/local-gate-tests.rendezvous.test.ts", "scripts/local-gate-tests.baseline.test.ts"];
  const publication = ["scripts/local-gate.hooks.test.ts", "scripts/local-gate.publication.test.ts", "scripts/local-gate.transport.test.ts"];
  const context: PlanEnvironment = { base: "base", existing: new Set(["scripts/local-gate-tests.fixture.ts", "scripts/local-gate-tests.ts", "scripts/gate-cache.ts"]),
    tests: [...groups, ...publication, "scripts/local-gate.checkpoints.test.ts", "scripts/unrelated.test.ts"], skippedMedia: [],
    linux: false, runtime: false, native: false, linuxTests: [], runtimeTests: [], codexVersions: [] };
  const selected = (file: string) => plan("pre-push", [file], context).find(step => step.name === "touched tests")!.command.slice(4).sort();
  expect(selected("scripts/local-gate-tests.fixture.ts")).toEqual(groups.map(file => `./${file}`).sort());
  for (const shared of ["scripts/gate-cache.ts", "scripts/local-gate.fixture.ts", "scripts/gateTest.fixture.ts", "scripts/publicationHook.fixture.ts"]) {
    expect(selected(shared)).toEqual([...groups, ...publication, "scripts/local-gate.checkpoints.test.ts"].map(file => `./${file}`).sort());
  }
  expect(selected("scripts/local-gate-tests.ts")).toEqual([...groups, "scripts/local-gate.checkpoints.test.ts"].map(file => `./${file}`).sort());
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "gate-head-checkpoint-")); roots.push(root);
  const repo = path.join(root, "repo"); mkdirSync(repo);
  const env = isolatedEnvironment(path.join(root, "environment"), process.env);
  Object.assign(env, { GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null");
  git("remote", "add", "origin", "https://example.invalid/fixture.git");
  const marker = path.join(root, "samples.txt");
  const source = (name: string, interrupted = false) => `import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + "\n")});
test("fixture contract", () => { ${interrupted ? "process.exit(124);" : "expect(1).toBe(1);"} });\n`;
  writeFileSync(path.join(repo, "a.test.ts"), source("a"));
  git("add", "."); git("commit", "-m", "Baseline");
  const base = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", base);
  writeFileSync(path.join(repo, "b.test.ts"), source("b", true));
  git("add", "."); git("commit", "-m", "Add incomplete check fixture");
  const run = (extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "local-gate-tests.ts"), "--base", base, "./a.test.ts", "./b.test.ts"],
      { cwd: repo, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const samples = () => readFileSync(marker, "utf8").trim().split("\n").reduce((counts, name) => {
    counts[name] = (counts[name] ?? 0) + 1; return counts;
  }, {} as Record<string, number>);
  return { root, repo, git, source, run, samples };
}

serviceTest("an incomplete head run retains only complete green files across fresh processes", () => {
  const f = fixture();
  const first = f.run();
  expect(first.status, first.output).toBe(1);
  expect(f.samples()).toEqual({ a: 1, b: 1 });
  const repeated = f.run();
  expect(repeated.status, repeated.output).toBe(1);
  expect(repeated.output).toContain("reused complete green head file a.test.ts");
  expect(repeated.output).not.toContain("reused complete green head file b.test.ts");
  expect(f.samples()).toEqual({ a: 1, b: 2 });
  writeFileSync(path.join(f.repo, "b.test.ts"), f.source("b"));
  f.git("add", "b.test.ts"); f.git("commit", "-m", "Complete fixture check");
  const changed = f.run(); expect(changed.status, changed.output).toBe(0);
  expect(f.samples()).toEqual({ a: 2, b: 3 });
  const green = f.run(); expect(green.status, green.output).toBe(0);
  expect(f.samples()).toEqual({ a: 2, b: 3 });
}, 60_000);

serviceTest("green head files outlast the files other lanes of the repository complete before the retry", () => {
  const f = fixture();
  writeFileSync(path.join(f.repo, "b.test.ts"), f.source("b"));
  f.git("add", "b.test.ts"); f.git("commit", "-m", "Complete fixture check");
  expect(f.run().status).toBe(0);
  expect(f.samples()).toEqual({ a: 1, b: 1 });
  // Six engine-family pushes of other lanes, each a different tree.
  const others = headFileCache(f.repo);
  for (let index = 0; index < 400; index++) {
    const file = `other-lane-${index}.test.ts`;
    others.write(`other lane tree ${index}`, { failures: [], passed: [{ file, suite: "", name: "fixture contract", kind: "test", occurrence: 0 }], completed: [file], elapsedMs: 1 });
  }
  const retry = f.run();
  expect(retry.status, retry.output).toBe(0);
  expect(retry.output).toContain("reused complete green head file a.test.ts");
  expect(retry.output).toContain("reused complete green head file b.test.ts");
  expect(f.samples()).toEqual({ a: 1, b: 1 });
}, 60_000);

serviceTest("head checkpoints invalidate environment and ignored inputs, and refuse corrupt receipts", () => {
  const f = fixture();
  writeFileSync(path.join(f.repo, "b.test.ts"), f.source("b"));
  f.git("add", "b.test.ts"); f.git("commit", "-m", "Complete fixture check");
  expect(f.run().status).toBe(0); expect(f.run().status).toBe(0);
  expect(f.samples()).toEqual({ a: 1, b: 1 });
  expect(f.run({ LANG: "C" }).status).toBe(0);
  expect(f.samples()).toEqual({ a: 2, b: 2 });
  mkdirSync(path.join(f.repo, ".git/info"), { recursive: true });
  writeFileSync(path.join(f.repo, ".git/info/exclude"), "generated.json\n");
  writeFileSync(path.join(f.repo, "generated.json"), '{"version":1}');
  expect(f.run().status).toBe(0); expect(f.run().status).toBe(0);
  expect(f.samples()).toEqual({ a: 3, b: 3 });
  writeFileSync(path.join(f.repo, "generated.json"), '{"version":2}');
  expect(f.run().status).toBe(0);
  expect(f.samples()).toEqual({ a: 4, b: 4 });
  const cache = path.join(f.repo, ".git/delegatus-gate/head-files");
  for (const name of readdirSync(cache)) writeFileSync(path.join(cache, name), "incomplete receipt");
  expect(f.run().status).toBe(0);
  expect(f.samples()).toEqual({ a: 5, b: 5 });
}, 60_000);

serviceTest("an aggregate deadline preserves completed files without certifying the interrupted run", () => {
  const f = fixture();
  rmSync(path.join(f.repo, "a.test.ts")); rmSync(path.join(f.repo, "b.test.ts"));
  const files = Array.from({ length: 12 }, (_, index) => `sample-${String(index).padStart(2, "0")}.test.ts`);
  for (const file of files) writeFileSync(path.join(f.repo, file), f.source(file).replace('test("fixture contract", () => {',
    `test("fixture contract", async () => { while (require("node:fs").readFileSync(${JSON.stringify(path.join(f.root, "samples.txt"))}, "utf8").trim().split("\\n").length < 8) await Bun.sleep(5);`));
  f.git("add", "."); f.git("commit", "-m", "Aggregate deadline fixture");
  const base = f.git("rev-parse", "origin/main"), marker = path.join(f.root, "samples.txt");
  const driver = path.join(f.root, "deadline-driver.ts");
  writeFileSync(driver, `import * as comparator from ${JSON.stringify(path.join(import.meta.dir, "local-gate-tests.ts"))};
import { existsSync, readFileSync } from "node:fs";
const expires = process.argv.at(-1) === "expire";
// A deterministic parent clock expires only after the first eight owned
// children have started. Child checks retain their real clocks and budgets.
Object.defineProperty(performance, "now", { value: () => expires && existsSync(${JSON.stringify(marker)})
  && readFileSync(${JSON.stringify(marker)}, "utf8").trim().split("\\n").length >= 8 ? 1000000 : 0 });
try { await comparator.touchedTests(${JSON.stringify(f.repo)}, ${JSON.stringify(base)}, ${JSON.stringify(files)},
  { budgets: { fileMs: 300000, runMs: 15000 } }); } catch (error) {
  const ending = comparator.comparatorEnding?.(error);
  console.error(ending?.line ?? String(error)); process.exitCode = ending?.code ?? 1;
}
`);
  const run = (mode: string) => spawnSync(process.execPath, [driver, mode],
    { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 30_000 });
  const stopped = run("expire");
  expect(stopped.status, stopped.stdout + stopped.stderr).toBe(75);
  expect(stopped.stderr).toContain("touched-tests: no verdict: head: test run exceeded");
  expect(stopped.stderr).toContain("test run exceeded");
  expect(Object.keys(f.samples())).toHaveLength(8);
  const resumed = run("continue");
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  expect(resumed.stdout.match(/reused complete green head file/g)).toHaveLength(8);
  expect(f.samples()).toEqual(Object.fromEntries(files.map(file => [file, 1])));
}, 60_000);

serviceTest("an observed cleanup refusal stays decisive when the next file exhausts the aggregate", () => {
  const f = fixture();
  rmSync(path.join(f.repo, "a.test.ts")); rmSync(path.join(f.repo, "b.test.ts"));
  const files = Array.from({ length: 9 }, (_, index) => `sample-${index}.test.ts`);
  const marker = path.join(f.root, "samples.txt");
  for (const [index, file] of files.entries()) writeFileSync(path.join(f.repo, file), `
import { test, expect } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(file + "\n")});
test("fixture contract", async () => {
  while (process.env.CLEANUP_CONTROL_MODE === "aggregate" && readFileSync(${JSON.stringify(marker)}, "utf8").trim().split("\\n").length < 8) await Bun.sleep(5);
  ${index === 0 ? `const child = Bun.spawn([process.execPath, "-e", 'require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); process.exit(0);'], { stdout: "ignore", stderr: "ignore" });
  await child.exited;` : ""}
  expect(1).toBe(1);
});`);
  f.git("add", "."); f.git("commit", "-m", "Mixed cleanup and aggregate deadline fixture");
  const base = f.git("rev-parse", "origin/main");
  const driver = path.join(f.root, "cleanup-driver.ts");
  writeFileSync(driver, `import { touchedTests, comparatorEnding } from ${JSON.stringify(path.join(import.meta.dir, "local-gate-tests.ts"))};
import { publicationDeadlineOnly } from ${JSON.stringify(path.join(import.meta.dir, "../src/lib/pipelines/publication.ts"))};
import { existsSync, readFileSync } from "node:fs";
const aggregate = process.env.CLEANUP_CONTROL_MODE === "aggregate";
Object.defineProperty(performance, "now", { value: () => aggregate && existsSync(${JSON.stringify(marker)})
  && readFileSync(${JSON.stringify(marker)}, "utf8").trim().split("\\n").length >= 8 ? 1000000 : 0 });
const lines: string[] = [];
try {
  const result = await touchedTests(${JSON.stringify(f.repo)}, ${JSON.stringify(base)}, aggregate ? ${JSON.stringify(files)} : [${JSON.stringify(files[0])}],
    { budgets: { fileMs: 300000, runMs: 15000 }, log: line => lines.push(line) });
  process.exitCode = result.introduced.length ? 1 : 0;
} catch (error) {
  const ending = comparatorEnding(error); lines.push(ending.line); process.exitCode = ending.code;
}
console.log(lines.join("\\n"));
// Include an execution timeout as the publisher can observe from a peer phase.
console.log("retryable=" + publicationDeadlineOnly(lines.join("\\n") + "\\nowned runner: deadline expired"));
`);
  for (const mode of ["single", "aggregate"]) {
    rmSync(marker, { force: true });
    const result = spawnSync(process.execPath, [driver], { cwd: f.repo,
      env: { ...process.env, CLEANUP_CONTROL_MODE: mode }, encoding: "utf8", timeout: 30_000 });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain("<ownership error> owned runner: surviving owned processes:");
    expect(output).toContain("retryable=false");
    expect(output).not.toContain("touched-tests: no verdict:");
    expect(Object.keys(f.samples())).toHaveLength(mode === "aggregate" ? 8 : 1);
  }
}, 60_000);

test("portable file samples remain fresh even when their assertions pass", () => {
  const f = fixture();
  writeFileSync(path.join(f.repo, "b.test.ts"), f.source("b"));
  f.git("add", "b.test.ts"); f.git("commit", "-m", "Portable check fixture");
  const noManager = { XDG_RUNTIME_DIR: path.join(f.root, "no-manager"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(f.root, "no-manager", "bus")}` };
  const first = f.run(noManager), again = f.run(noManager);
  expect(first.status, first.output).toBe(0); expect(again.status, again.output).toBe(0);
  expect(again.output).not.toContain("reused complete green head file");
  expect(f.samples()).toEqual({ a: 2, b: 2 });
}, 60_000);

serviceTest.each(["CHECKPOINT_TEST_MODE", "GIT_AUTHOR_NAME", "LLV_PRIVACY_TEST_MODE", "HTTPS_PROXY"])(
  "a consumed caller environment value invalidates warm checkpoints: %s", name => {
    const f = fixture();
    for (const file of ["a", "b"]) writeFileSync(path.join(f.repo, `${file}.test.ts`),
      f.source(file).replace("expect(1).toBe(1);", `expect(process.env[${JSON.stringify(name)}]).toBe("green");`));
    f.git("add", "."); f.git("commit", "-m", "Consumed environment fixture");
    const first = f.run({ [name]: "green" });
    expect(first.status, first.output).toBe(0);
    const changed = f.run({ [name]: "red" });
    expect(changed.status, changed.output).toBe(1);
    expect(changed.output).not.toContain("reused complete green head file");
    expect(changed.output).toContain("NEW a.test.ts");
    expect(changed.output).toContain("NEW b.test.ts");
  }, 60_000);

serviceTest("service checkpoints are not consumed after switching to portable execution", () => {
  const f = fixture();
  for (const file of ["a", "b"]) writeFileSync(path.join(f.repo, `${file}.test.ts`), f.source(file).replace("expect(1).toBe(1);",
    'expect(require("node:child_process").spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status).toBe(0);'));
  f.git("add", "."); f.git("commit", "-m", "Service boundary fixture");
  const first = f.run(); expect(first.status, first.output).toBe(0);
  const portable = f.run({ XDG_RUNTIME_DIR: path.join(f.root, "missing-manager"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(f.root, "missing-manager", "bus")}` });
  expect(portable.status, portable.output).toBe(1);
  expect(portable.output).not.toContain("reused complete green head file");
  expect(portable.output).toContain("NEW a.test.ts");
  expect(portable.output).toContain("NEW b.test.ts");
}, 60_000);

serviceTest("declared transport inputs invalidate warm receipts like a fresh comparator", () => {
  const f = fixture();
  for (const file of ["a", "b"]) writeFileSync(path.join(f.repo, `${file}.test.ts`), f.source(file).replace("expect(1).toBe(1);",
    'expect(process.env.LLV_GATE_REVIEW_MODE).toBe("green");'));
  f.git("add", "."); f.git("commit", "-m", "Declared environment fixture");
  const declared = { LLV_GATE_CHECK_ENV: "LLV_GATE_REVIEW_MODE", LLV_GATE_REVIEW_MODE: "green" };
  const first = f.run(declared); expect(first.status, first.output).toBe(0);
  const unchanged = f.run(declared); expect(unchanged.status, unchanged.output).toBe(0);
  expect(unchanged.output.match(/reused complete green head file/g)).toHaveLength(2);
  expect(f.samples()).toEqual({ a: 1, b: 1 });
  const red = { ...declared, LLV_GATE_REVIEW_MODE: "red" };
  const warm = f.run(red);
  const cache = path.join(f.repo, ".git", "delegatus-gate", "head-files");
  renameSync(cache, `${cache}.warm-saved`);
  const cold = f.run(red);
  expect(cold.status, cold.output).toBe(1);
  expect(warm.status, warm.output).toBe(cold.status);
  for (const result of [warm, cold]) {
    expect(result.output).not.toContain("reused complete green head file");
    expect(result.output).toContain("NEW a.test.ts");
    expect(result.output).toContain("NEW b.test.ts");
  }
}, 60_000);
