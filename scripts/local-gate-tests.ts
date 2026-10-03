import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeXML } from "entities";
import { gateTemporaryRoot, isolatedEnvironment } from "./local-gate";

export interface TestSite { file: string; suite: string; name: string; kind: "test" | "error" }
interface TestRun { failures: TestSite[]; passed: TestSite[]; elapsedMs: number; completed: string[] }
const key = (site: TestSite) => JSON.stringify([site.file, site.suite, site.name, site.kind]);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const MAX_CACHE_ENTRIES = 32;
const RESULT_NAME = /^[a-f0-9]{64}\.json$/;
const PENDING_NAME = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.pending$/;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_BUDGET_MS = 15 * 60 * 1000;
const FILE_BUDGET_MS = 5 * 60 * 1000;

/** Match occurrences, so a duplicate test name cannot hide an additional failure. */
export function compareTests(base: TestRun, head: TestRun) {
  const remaining = new Map<string, number>();
  for (const site of base.failures) remaining.set(key(site), (remaining.get(key(site)) ?? 0) + 1);
  const introduced: TestSite[] = [], preexisting: TestSite[] = [];
  for (const site of head.failures) {
    const count = remaining.get(key(site)) ?? 0;
    if (count) { preexisting.push(site); remaining.set(key(site), count - 1); }
    else introduced.push(site);
  }
  const passes = new Map<string, number>();
  for (const site of head.passed) passes.set(key(site), (passes.get(key(site)) ?? 0) + 1);
  const fixed: TestSite[] = [], absent: TestSite[] = [];
  for (const site of base.failures) {
    const count = remaining.get(key(site)) ?? 0;
    if (!count) continue;
    remaining.set(key(site), count - 1);
    const passed = passes.get(key(site)) ?? 0;
    if (passed || (site.kind === "error" && head.completed.includes(site.file))) { fixed.push(site); passes.set(key(site), passed - 1); }
    else absent.push(site);
  }
  return { introduced, preexisting, fixed, absent };
}

/** Bun's JUnit format retains describe ancestry and handles multiline/escaped names.
 * Validate totals; a truncated report must never certify a baseline.
 */
export function parseReport(xml: string, output: string, file: string, root: string): Omit<TestRun, "elapsedMs" | "completed"> {
  const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1]!, decodeXML(m[2]!)]));
  const opening = xml.match(/<testsuites\b[^>]*>/)?.[0];
  if (!opening || !xml.trimEnd().endsWith("</testsuites>")) throw new Error("missing or incomplete JUnit report");
  const totals = attributes(opening);
  const failures: TestSite[] = [], passed: TestSite[] = [];
  let tests = 0, namedFailures = 0;
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(match[1]!);
    if (attrs.name === undefined || attrs.file !== file) throw new Error("JUnit testcase has an invalid identity");
    tests++;
    const site: TestSite = { file, suite: attrs.classname ?? "", name: attrs.name, kind: "test" };
    if (/<(?:failure|error)\b/.test(match[2] ?? "")) { failures.push(site); namedFailures++; }
    else if (!/<skipped\b/.test(match[2] ?? "")) passed.push(site);
  }
  if (tests !== Number(totals.tests) || namedFailures !== Number(totals.failures) || !tests) throw new Error("JUnit totals incomplete or no tests executed");
  // Bun omits out-of-test exceptions from JUnit. Keep these visible as named
  // file-level diagnostics instead of losing them beside an existing assertion.
  let errors = 0;
  for (const match of output.matchAll(/# Unhandled error between tests\s*\n-+\n([\s\S]*?)\n-+/g)) {
    const message = match[1]!.match(/^(?:[\w.]*Error|error): (.*)$/m)?.[0];
    if (!message) throw new Error("unidentified error between tests");
    errors++;
    failures.push({ file, suite: "", name: `<between-tests error> ${message.split(root).join("<checkout>")}`, kind: "error" });
  }
  const reportedErrors = Number(output.match(/^\s*(\d+) errors?\s*$/m)?.[1] ?? 0);
  if (errors !== reportedErrors) throw new Error("incomplete between-tests error diagnostics");
  return { failures, passed };
}

function command(command: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = FILE_BUDGET_MS): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, env, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command[0]} ${command[1]} failed (${result.status ?? result.signal}): ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}

function runFiles(root: string, files: readonly string[], sandbox: string, inherited: NodeJS.ProcessEnv, label: string): TestRun {
  const started = performance.now(), failures: TestSite[] = [], passed: TestSite[] = [], completed: string[] = [];
  for (const file of files) {
    const remaining = RUN_BUDGET_MS - (performance.now() - started);
    if (remaining <= 0) throw new Error(`${label}: test run exceeded its 15 minute budget`);
    const privateRoot = mkdtempSync(path.join(sandbox, "test-"));
    const env = isolatedEnvironment(privateRoot, inherited);
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
    env.NO_COLOR = "1"; env.FORCE_COLOR = "0";
    const report = path.join(privateRoot, "junit.xml"), log = path.join(privateRoot, "output.log");
    const fd = openSync(log, "w");
    let result: Bun.SyncSubprocess;
    try {
      result = Bun.spawnSync({ cmd: [process.execPath, "test", `./${file}`, "--reporter=junit", `--reporter-outfile=${report}`],
        cwd: root, env, stdio: ["ignore", fd, fd], timeout: Math.min(FILE_BUDGET_MS, remaining), killSignal: "SIGKILL",
        detached: process.platform !== "win32",
      });
    } finally { closeSync(fd); }
    // Reap only the process group created for this file, including helpers that
    // inherited the gate slot descriptor. No port/name based process cleanup.
    if (process.platform !== "win32" && result.pid) {
      try { process.kill(-result.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    try {
      if (result.signalCode || result.exitedDueToTimeout || ![0, 1].includes(result.exitCode)) throw new Error(`runner did not finish (${result.signalCode ?? result.exitCode}${result.exitedDueToTimeout ? "; timed out" : ""})`);
      const output = readFileSync(log, "utf8");
      const parsed = parseReport(readFileSync(report, "utf8"), output, file, root);
      if ((result.exitCode === 0) !== (parsed.failures.length === 0)) throw new Error("runner exit disagrees with its report");
      failures.push(...parsed.failures); passed.push(...parsed.passed); completed.push(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (label === "baseline") throw new Error(`${label}: ${file}: ${message}; elapsed ${(performance.now() - started).toFixed(0)}ms`);
      failures.push({ file, suite: "", name: `<runner error> ${message.split(root).join("<checkout>")}`, kind: "error" });
    } finally { rmSync(privateRoot, { recursive: true, force: true }); }
  }
  return { failures, passed, completed, elapsedMs: performance.now() - started };
}

/** Private, disposable result cache: no checkouts, state, credentials or logs. */
export function prepareCache(directory: string, now = Date.now()): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("baseline cache must be an owned private directory");
  const entries = readdirSync(directory).filter(name => RESULT_NAME.test(name) || PENDING_NAME.test(name)).flatMap(name => {
    try { return [{ name, info: lstatSync(path.join(directory, name)) }]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  });
  entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const [index, entry] of entries.entries()) if (index >= MAX_CACHE_ENTRIES || now - entry.info.mtimeMs > MAX_AGE_MS || entry.info.size > MAX_CACHE_BYTES || !entry.info.isFile()) {
    rmSync(path.join(directory, entry.name), { force: true });
  }
}
function validRun(value: unknown): value is TestRun {
  if (!value || typeof value !== "object") return false;
  const run = value as TestRun;
  const sites = (list: unknown) => Array.isArray(list) && list.every(s => s && typeof s.file === "string" && typeof s.suite === "string" && typeof s.name === "string" && ["test", "error"].includes(s.kind));
  return Array.isArray(run.completed) && run.completed.every(file => typeof file === "string") && sites(run.failures) && sites(run.passed) && Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0;
}

export function touchedTests(root: string, baseRef: string, selected: readonly string[], options: { cache?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}) {
  const sandbox = mkdtempSync(path.join(gateTemporaryRoot(), "delegatus-test-comparison-"));
  const log = options.log ?? console.log;
  const inherited = options.env ?? process.env;
  const env = isolatedEnvironment(sandbox, inherited);
  const git = (...args: string[]) => command(["git", ...args], root, env);
  try {
    const base = git("rev-parse", "--verify", `${baseRef}^{commit}`).trim();
    const files = [...new Set(selected.map(file => path.relative(root, path.resolve(root, file))))].sort();
    if (!files.length) throw new Error("refusing an empty test list");
    for (const file of files) if (file.startsWith("../") || path.isAbsolute(file) || !/\.test\.[cm]?[jt]sx?$/.test(file) || file.includes(".browser.test.") || !statSync(path.join(root, file)).isFile()) throw new Error(`missing or invalid test path: ${file}`);
    const baseFiles = new Set(git("ls-tree", "-r", "--name-only", "-z", base, "--", ...files).split("\0"));
    const oldFiles = files.filter(file => baseFiles.has(file));
    const dependencyInputs = ["package.json", "bun.lock"];
    const graph = dependencyInputs.map(file => existsSync(path.join(root, file)) ? digest(readFileSync(path.join(root, file))) : "missing");
    // Scope ids and journal descriptors change on each gate-slot invocation;
    // they do not change the test inputs. Keep semantic environment in the key.
    const environment = Object.entries(env).filter(([k]) => !["PWD", "OLDPWD", "_", "SHLVL", "LLV_GATE_LOCK_DIR", "INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v?.split(sandbox).join("<sandbox>")]);
    const identity = digest(JSON.stringify(["per-file-junit-v2", base, files, Bun.version, process.execPath, process.platform, process.arch, graph, environment]));
    const cache = options.cache ?? path.join(gateTemporaryRoot(), `delegatus-test-baselines-${process.getuid?.() ?? "user"}`);
    prepareCache(cache);
    const entry = path.join(cache, `${identity}.json`);
    let baseline: TestRun | undefined;
    const baselineStarted = performance.now();
    if (existsSync(entry)) {
      try {
        const value = JSON.parse(readFileSync(entry, "utf8"));
        if (value.identity === identity && validRun(value.run) && JSON.stringify(value.run.completed) === JSON.stringify(oldFiles) && [...value.run.failures, ...value.run.passed].every((site: TestSite) => baseFiles.has(site.file))) baseline = value.run;
      } catch { log("touched-tests: invalid baseline cache; rebuilding"); }
    }
    const cached = !!baseline;
    if (!baseline) {
      baseline = { failures: [], passed: [], completed: [], elapsedMs: 0 };
      if (oldFiles.length) {
        const checkout = path.join(sandbox, "baseline");
        // A detached clone retains Git metadata for repository-identity tests.
        // It registers no worktree/ref in the pushing repo and runs no hooks.
        command(["git", "clone", "--quiet", "--shared", "--no-checkout", "--", root, checkout], root, env);
        command(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", base], checkout, env);
        const remote = git("config", "--get", "remote.origin.url").trim();
        command(["git", "config", "remote.origin.url", remote], checkout, env);
        const sameGraph = dependencyInputs.every((file, i) => (existsSync(path.join(checkout, file)) ? digest(readFileSync(path.join(checkout, file))) : "missing") === graph[i]);
        if (sameGraph && existsSync(path.join(root, "node_modules"))) symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"), "dir");
        else if (existsSync(path.join(checkout, "bun.lock"))) command([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], checkout, env);
        baseline = runFiles(checkout, oldFiles, sandbox, inherited, "baseline");
      }
      const serialized = JSON.stringify({ identity, run: baseline });
      if (Buffer.byteLength(serialized) <= MAX_CACHE_BYTES) {
        const pending = path.join(cache, `${identity}.${randomUUID()}.pending`);
        try { writeFileSync(pending, serialized, { mode: 0o600, flag: "wx" }); renameSync(pending, entry); }
        catch { log("touched-tests: could not save baseline cache; comparison still runs"); }
        finally { rmSync(pending, { force: true }); }
        prepareCache(cache);
      }
    }
    log(`touched-tests: baseline ${cached ? "cache hit" : "run"} ${(performance.now() - baselineStarted).toFixed(0)}ms (tests ${baseline.elapsedMs.toFixed(0)}ms)`);
    log(`touched-tests: ${files.length - oldFiles.length} new file(s), judged on head alone`);
    const head = runFiles(root, files, sandbox, inherited, "head");
    log(`touched-tests: head ${head.elapsedMs.toFixed(0)}ms`);
    const comparison = compareTests(baseline, head);
    for (const [label, sites] of [["NEW", comparison.introduced], ["PRE-EXISTING", comparison.preexisting], ["FIXED", comparison.fixed], ["REMOVED/SKIPPED", comparison.absent]] as const) {
      for (const site of sites) log(`${label} ${site.file}: ${site.suite ? `${site.suite} > ` : ""}${site.name}`);
    }
    log(`touched-tests: ${comparison.introduced.length} new failures, ${comparison.preexisting.length} pre-existing failures, ${comparison.fixed.length} fixed, ${comparison.absent.length} removed/skipped`);
    return comparison;
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const [, , flag, base, ...files] = process.argv;
    if (flag !== "--base" || !base) throw new Error("usage: local-gate-tests.ts --base <merge-base> <files...>");
    if (touchedTests(process.cwd(), base, files).introduced.length) process.exitCode = 1;
  } catch (error) {
    console.error(`touched-tests: ${error instanceof Error ? error.message : error}; gate error (blocking)`);
    process.exitCode = 1;
  }
}
