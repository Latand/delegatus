import { afterEach, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { appendOwnershipFailure, compareTests, confirmFailures, FLAKY_RERUNS, FLAKY_BUDGET_MS, parseReport, touchedTests, type TestSite, type TestRun } from "./local-gate-tests";
import { gateTemporaryRoot, isolatedEnvironment } from "./local-gate";
import { fixtureCheckAdmissionEnv } from "./local-gate.fixture";

setDefaultTimeout(60_000);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = path.resolve(import.meta.dir, "..");
function fixture(source: string) {
  const dir = mkdtempSync(path.join(gateTemporaryRoot(), "gate-comparison-fixture-")); roots.push(dir);
  const env = isolatedEnvironment(path.join(dir, "env"), process.env);
  Object.assign(env, fixtureCheckAdmissionEnv(dir), { GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null"); git("remote", "add", "origin", "https://example.invalid/repository.git");
  writeFileSync(path.join(dir, "example.test.ts"), source);
  git("add", "example.test.ts"); git("commit", "-m", "baseline");
  const base = git("rev-parse", "HEAD"), logs: string[] = [];
  const run = (files = ["./example.test.ts"]) => touchedTests(dir, base, files, { env, log: line => logs.push(line) });
  return { dir, env, base, git, run, logs };
}
const source = (pass: boolean) => `import { test, expect, describe } from "bun:test"; describe("contract", () => test("same name & Unicode Ω", () => expect(${pass}).toBe(true)));`;


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
  const run = () => touchedTests(f.dir, base, ["./example.test.ts"], { env: f.env, log: line => f.logs.push(line) });
  const cli = () => spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  return { ...f, marker, run, cli };
}

// A throw inside a describe callback is Bun's "Unhandled error between tests":
// the report stays complete and the error appears on every run, filtered or not.
const betweenTests = (message: string | null, extra = "") => `import { test, expect, describe } from "bun:test";
test("steady red", () => expect(false).toBe(true));
${extra}
${message === null ? "" : `describe("broken", () => { test("inner", () => {}); throw new Error(${JSON.stringify(message)}); });`}`;
const cliAt = (f: ReturnType<typeof fixture>, base: string, files = ["./example.test.ts"]) => spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, ...files], { cwd: f.dir, env: f.env, encoding: "utf8" });
const SAME_WAY = "(the base run of this file is broken the same way)";

export { appendOwnershipFailure, betweenTests, cliAt, compareTests, confirmFailures, cpSync, createServer, execFileSync, expect, fixture, FLAKY_BUDGET_MS, FLAKY_RERUNS, gateTemporaryRoot, mkdirSync, mkdtempSync, parseReport, path, readFileSync, rmSync, root, roots, SAME_WAY, scheduledFixture, scheduledSource, source, spawn, spawnSync, spyOn, symlinkSync, test, type TestRun, type TestSite, touchedTests, writeFileSync };
