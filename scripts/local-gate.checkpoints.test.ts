import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "./local-gate";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const serviceTest = test.skipIf(process.platform !== "linux"
  || spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status !== 0);

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
  const run = (extra: NodeJS.ProcessEnv = {}) => {
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
  writeFileSync(driver, `import { touchedTests } from ${JSON.stringify(path.join(import.meta.dir, "local-gate-tests.ts"))};
import { existsSync, readFileSync } from "node:fs";
const expires = process.argv.at(-1) === "expire";
// A deterministic parent clock expires only after the first eight owned
// children have started. Child checks retain their real clocks and budgets.
Object.defineProperty(performance, "now", { value: () => expires && existsSync(${JSON.stringify(marker)})
  && readFileSync(${JSON.stringify(marker)}, "utf8").trim().split("\\n").length >= 8 ? 1000000 : 0 });
try { await touchedTests(${JSON.stringify(f.repo)}, ${JSON.stringify(base)}, ${JSON.stringify(files)},
  { budgets: { fileMs: 300000, runMs: 15000 } }); } catch (error) { console.error(String(error)); process.exitCode = 1; }
`);
  const run = (mode: string) => spawnSync(process.execPath, [driver, mode],
    { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 30_000 });
  const stopped = run("expire");
  expect(stopped.status, stopped.stdout + stopped.stderr).toBe(1);
  expect(stopped.stderr).toContain("test run exceeded");
  expect(Object.keys(f.samples())).toHaveLength(8);
  const resumed = run("continue");
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  expect(resumed.stdout.match(/reused complete green head file/g)).toHaveLength(8);
  expect(f.samples()).toEqual(Object.fromEntries(files.map(file => [file, 1])));
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
