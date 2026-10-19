import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeXML } from "entities";
import { gateTemporaryRoot, isolatedEnvironment } from "./local-gate";
import { cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";

export interface TestSite { file: string; suite: string; name: string; kind: "test" | "error"; occurrence?: number }
export interface TestRun { failures: TestSite[]; passed: TestSite[]; elapsedMs: number; completed: string[] }
const escapedTemporaryRoot = path.join(gateTemporaryRoot(), "delegatus-test-comparison-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const privateTestRoot = new RegExp(`${escapedTemporaryRoot}[a-zA-Z0-9]{6}[/\\\\]test-[a-zA-Z0-9]{6}`, "g");
const diagnosticName = (site: TestSite) => site.kind === "error" ? site.name.replace(privateTestRoot, "<sandbox>") : site.name;
// Keep the concrete identities in displayed evidence. A head/base comparison
// of the same survivor failure must not depend on the different PIDs allocated
// to those two isolated runs.
const key = (site: TestSite) => JSON.stringify([site.file, site.suite,
  site.kind === "error" ? diagnosticName(site)
    .replace(/(owned runner: surviving owned processes: ).*$/, "$1<run-owned identities>")
    .replace(/(owned test children survived teardown: )[\d, ]*(; guardian=)/, "$1<run-owned identities>$2")
    .replace(/(owned test scope children survived teardown: )\d+ \((?:\d+:\d+|null)\)(?:, \d+ \((?:\d+:\d+|null)\))*$/, "$1<run-owned identities>")
    : diagnosticName(site), site.kind]);
const occurrenceKey = (site: TestSite) => JSON.stringify([key(site), site.occurrence ?? 0]);
const comparisonKey = (site: TestSite) => site.kind === "test" && site.occurrence !== undefined ? occurrenceKey(site) : key(site);
const mergeObservedSites = (first: readonly TestSite[], retry: readonly TestSite[]) => {
  const merged = [...first];
  const counts = new Map<string, number>();
  for (const site of first) counts.set(comparisonKey(site), (counts.get(comparisonKey(site)) ?? 0) + 1);
  const retryCounts = new Map<string, number>();
  for (const site of retry) retryCounts.set(comparisonKey(site), (retryCounts.get(comparisonKey(site)) ?? 0) + 1);
  for (const [identity, count] of retryCounts) {
    const missing = count - (counts.get(identity) ?? 0);
    if (missing > 0) merged.push(...retry.filter(site => comparisonKey(site) === identity).slice(0, missing));
  }
  return merged;
};
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const RUN_BUDGET_MS = 15 * 60 * 1000;
const FILE_BUDGET_MS = 5 * 60 * 1000;
const HEAD_FILE_WORKERS = 4;
export const FLAKY_RERUNS = 3;
export const FLAKY_BUDGET_MS = 5 * 60 * 1000;
const RUNNER_ERROR = "<runner error> ";
interface Counts { pass: number; fail: number }
interface FlakySite extends TestSite { base: Counts; head: Counts }
const occurrenceCount = (sites: readonly TestSite[], site: TestSite) => sites.filter(other => occurrenceKey(other) === occurrenceKey(site)).length;

/** Confirm assertions that failed the first head sample and did not fail the
 * first base sample: those alone can refuse the push. A failure the base sample
 * already showed stays PRE-EXISTING on that one sample per side and costs no
 * reruns, since neither label it could end with blocks. Mixed results on either
 * side make a confirmed assertion non-blocking FLAKY and retire that occurrence
 * from later rounds; runner and between-tests errors keep their comparison by
 * identity. Never treat absence as a pass.
 */
export async function confirmFailures(base: TestRun, head: TestRun, rerun: (side: "base" | "head", sites: readonly TestSite[]) => TestRun | Promise<TestRun>) {
  const comparison = compareTests(base, head);
  const flaky: FlakySite[] = [];
  // A completed file can still report an unhandled rejection after a timed-out
  // test. Re-run that entire file once before a transient diagnostic parks a
  // lane. Ownership, incomplete reports and failed cleanup remain decisive.
  const diagnostics = comparison.introduced.filter(site => site.kind === "error" && site.name.startsWith("<between-tests error> "));
  if (diagnostics.length) {
    const retry = await rerun("head", diagnostics);
    const files = new Set(diagnostics.map(site => site.file));
    if ([...files].some(file => !retry.completed.includes(file))) throw new Error("head diagnostic retry: incomplete file");
    const recovered = new Set<string>();
    for (const site of diagnostics) {
      if (retry.failures.some(other => key(other) === key(site))) continue;
      recovered.add(key(site));
      flaky.push({ ...site, base: { pass: base.completed.includes(site.file) ? 1 : 0, fail: 0 }, head: { pass: 1, fail: 1 } });
    }
    comparison.introduced = comparison.introduced.filter(site => !recovered.has(key(site)));
    // Compare the complete retry against the base so base occurrences are
    // consumed once. Merge the two samples by maximum multiplicity: repeated
    // observations do not inflate evidence, while an extra retry occurrence
    // remains visible even when its identity appeared in the first sample.
    const retried = compareTests(base, retry);
    comparison.introduced = mergeObservedSites(comparison.introduced, retried.introduced);
    comparison.preexisting = mergeObservedSites(comparison.preexisting, retried.preexisting);
    comparison.fixed = mergeObservedSites(comparison.fixed, retried.fixed);
    comparison.absent = mergeObservedSites(comparison.absent, retried.absent);
  }
  // Only assertions in the initial sample have the occurrence counts required
  // for filtered confirmation. New retry failures above remain blocking.
  const candidates = [...new Map(comparison.introduced.filter(site => site.kind === "test" && head.failures.some(other => comparisonKey(other) === comparisonKey(site))).map(site => [occurrenceKey(site), site])).values()];
  if (!candidates.length) return { ...comparison, flaky };
  const evidence = candidates.map(site => ({ site,
    base: { pass: occurrenceCount(base.passed, site), fail: occurrenceCount(base.failures, site) },
    head: { pass: occurrenceCount(head.passed, site), fail: occurrenceCount(head.failures, site) },
    baseRetryFailed: false,
    headRetryPassed: false,
  }));
  for (let round = 0; round < FLAKY_RERUNS; round++) {
    // One complete recovery proves intermittency under the existing verdict
    // rule. Spend later rounds only on occurrences still able to refuse.
    const pending = evidence.filter(item => !item.baseRetryFailed && !item.headRetryPassed);
    if (!pending.length) break;
    const sites = pending.map(item => item.site);
    const sides = ["base", "head"] as const;
    // The two isolated sides owe the same samples and share one deadline.
    // Await both even on refusal so no owned runner outlives this round.
    const samples = await Promise.allSettled(sides.map(async side => rerun(side, sites)));
    for (const [index, side] of sides.entries()) {
      const sample = samples[index]!;
      if (sample.status === "rejected") throw sample.reason;
      const run = sample.value;
      // A between-tests error the same side already showed in its first sample
      // is that file's known state; only a diagnostic the first sample lacked
      // leaves the retry without usable evidence.
      const known = new Set((side === "base" ? base : head).failures.filter(site => site.kind === "error").map(key));
      if (run.failures.some(site => site.kind === "error" && !known.has(key(site)))) throw new Error(`${side} rerun: incomplete runner or between-tests error`);
      for (const item of pending) {
        const fail = occurrenceCount(run.failures, item.site), pass = occurrenceCount(run.passed, item.site);
        if (side === "base" && fail + pass !== occurrenceCount(base.passed, item.site) + occurrenceCount(base.failures, item.site)) throw new Error(`base rerun: missing or skipped test ${item.site.file}: ${item.site.name}`);
        if (side === "base" && fail) item.baseRetryFailed = true;
        if (side === "head") {
          if (fail + pass !== occurrenceCount(head.failures, item.site) + occurrenceCount(head.passed, item.site)) throw new Error(`head rerun: missing or skipped test ${item.site.file}: ${item.site.name}`);
          if (pass) item.headRetryPassed = true;
        }
        item[side].pass += pass; item[side].fail += fail;
      }
    }
  }
  const flakyOccurrences = new Set<string>();
  for (const item of evidence) {
    // Keep evidence attached to its duplicate assertion. A base retry failure
    // and a different occurrence's head recovery cannot cancel each other.
    if (!item.baseRetryFailed && !item.headRetryPassed) continue;
    flakyOccurrences.add(occurrenceKey(item.site));
    flaky.push({ ...item.site, base: item.base, head: item.head });
  }
  const keepNonFlaky = (sites: TestSite[]) => sites.filter(site => !flakyOccurrences.has(occurrenceKey(site)));
  return { ...comparison, introduced: keepNonFlaky(comparison.introduced), preexisting: keepNonFlaky(comparison.preexisting), flaky };
}

/** Match occurrences, so a duplicate test name cannot hide an additional failure. */
export function compareTests(base: TestRun, head: TestRun) {
  const remaining = new Map<string, number>();
  for (const site of base.failures) remaining.set(comparisonKey(site), (remaining.get(comparisonKey(site)) ?? 0) + 1);
  const introduced: TestSite[] = [], preexisting: TestSite[] = [];
  for (const site of head.failures) {
    const identity = comparisonKey(site), count = remaining.get(identity) ?? 0;
    if (count) { preexisting.push(site); remaining.set(identity, count - 1); }
    else introduced.push(site);
  }
  const passes = new Map<string, number>();
  for (const site of head.passed) passes.set(comparisonKey(site), (passes.get(comparisonKey(site)) ?? 0) + 1);
  const fixed: TestSite[] = [], absent: TestSite[] = [];
  for (const site of base.failures) {
    const identity = comparisonKey(site), count = remaining.get(identity) ?? 0;
    if (!count) continue;
    remaining.set(identity, count - 1);
    const passed = passes.get(identity) ?? 0;
    if (passed || (site.kind === "error" && head.completed.includes(site.file))) { fixed.push(site); passes.set(identity, passed - 1); }
    else absent.push(site);
  }
  return { introduced, preexisting, fixed, absent };
}

/** Bun's JUnit format retains describe ancestry and handles multiline/escaped names.
 * Validate totals; a truncated report must never certify a baseline.
 */
export function parseReport(xml: string, output: string, file: string, root: string, filtered = false): Omit<TestRun, "elapsedMs" | "completed"> {
  const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1]!, decodeXML(m[2]!)]));
  const opening = xml.match(/<testsuites\b[^>]*>/)?.[0];
  if (!opening || !xml.trimEnd().endsWith("</testsuites>")) throw new Error("missing or incomplete JUnit report");
  const totals = attributes(opening);
  const failures: TestSite[] = [], passed: TestSite[] = [];
  let tests = 0, namedFailures = 0;
  const testcaseOccurrences = new Map<string, number>();
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(match[1]!);
    if (attrs.name === undefined || attrs.file !== file) throw new Error("JUnit testcase has an invalid identity");
    tests++;
    const identity = JSON.stringify([attrs.classname ?? "", attrs.name]);
    const occurrence = testcaseOccurrences.get(identity) ?? 0;
    testcaseOccurrences.set(identity, occurrence + 1);
    const site: TestSite = { file, suite: attrs.classname ?? "", name: attrs.name, kind: "test", occurrence };
    if (/<(?:failure|error)\b/.test(match[2] ?? "")) {
      // Bun gives failing lifecycle hooks a line-less "(unnamed)" testcase.
      // It cannot be selected by a test-name filter. Keep the real diagnostic
      // blocking, including the survivor names from the ownership afterAll.
      if (attrs.name === "(unnamed)" && attrs.line === undefined) {
        const tag = match[2]!.match(/<(?:failure|error)\b[^>]*>/)?.[0];
        const message = tag ? attributes(tag).message : undefined;
        if (!message) throw new Error("unidentified JUnit hook failure");
        failures.push({ file, suite: site.suite, name: `<hook error> ${message.split(root).join("<checkout>")}`, kind: "error" });
      } else failures.push(site);
      namedFailures++;
    }
    else if (!/<skipped\b/.test(match[2] ?? "")) passed.push(site);
  }
  if (tests !== Number(totals.tests) || namedFailures !== Number(totals.failures) || (!tests && !filtered)) throw new Error("JUnit totals incomplete or no tests executed");
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

/** The preload and service can report the same surviving tree. Keep one
 * ownership failure for that exact identity set; other hook errors still block.
 */
export function appendOwnershipFailure(failures: TestSite[], file: string, diagnostic: string): void {
  const runnerPrefix = "owned runner: surviving owned processes: ";
  const hookPrefix = "<hook error> owned test scope children survived teardown: ";
  const identities = (value: string) => value.split(", ").sort().join(", ");
  const members = identities(diagnostic.slice(runnerPrefix.length));
  const duplicate = failures.findIndex(site => site.file === file && site.kind === "error"
    && site.name.startsWith(hookPrefix) && identities(site.name.slice(hookPrefix.length)) === members);
  if (duplicate >= 0) failures.splice(duplicate, 1);
  failures.push({ file, suite: "", name: `<ownership error> ${diagnostic}`, kind: "error" });
}

/** Bun arguments that run only the named cases of one file. */
export function testNameFilter(sites: readonly TestSite[]): string[] {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bun filters the outer-to-inner describe names joined by spaces. Its JUnit
  // classname records the same ancestry in reverse, separated by " > ".
  const names = sites.flatMap(site => {
    const parts = site.suite ? site.suite.split(" > ") : [];
    // JUnit uses the same delimiter for reverse ancestry and literal suite
    // text. Enumerate possible boundaries, reversing groups while preserving
    // the text and order inside each group.
    const forms: string[] = [];
    for (let mask = 0; mask < 2 ** Math.max(0, parts.length - 1); mask++) {
      const groups: string[] = [];
      let group = parts[0] ?? "";
      for (let index = 1; index < parts.length; index++) {
        if (mask & (1 << (index - 1))) { groups.push(group); group = parts[index]!; }
        else group += ` > ${parts[index]}`;
      }
      if (group) groups.push(group);
      forms.push([...groups.reverse(), site.name].join(" "));
    }
    return [...new Set(forms.map(escape))];
  });
  return [`--test-name-pattern=^(?:${names.join("|")})$`, "--pass-with-no-tests"];
}

interface TestBudgets { fileMs: number; runMs: number }
const DEFAULT_TEST_BUDGETS: TestBudgets = { fileMs: FILE_BUDGET_MS, runMs: RUN_BUDGET_MS };
async function runFiles(root: string, files: readonly string[], sandbox: string, inherited: NodeJS.ProcessEnv, label: string, options: { sites?: readonly TestSite[]; deadline?: number; onFailure?: () => void; now?: () => number; budgets?: TestBudgets; log?: (line: string) => void; workers?: number } = {}): Promise<TestRun> {
  const started = performance.now(), failures: TestSite[] = [], passed: TestSite[] = [], completed: string[] = [];
  const now = options.now ?? (() => performance.now());
  const budgetStart = now(), budgets = options.budgets ?? DEFAULT_TEST_BUDGETS;
  const results: TestRun[] = new Array(files.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(options.workers ?? 3, files.length) }, async () => {
  while (next < files.length) {
    const index = next++, file = files[index]!;
    const fileStarted = performance.now();
    const failures: TestSite[] = [], passed: TestSite[] = [], completed: string[] = [];
    const remaining = Math.floor(Math.min(budgets.runMs - (now() - budgetStart), (options.deadline ?? Infinity) - now()));
    if (remaining <= 0) throw new Error(`${label}: test run exceeded its ${options.deadline ? "flaky rerun" : "15 minute"} budget`);
    const filter = options.sites ? testNameFilter(options.sites.filter(site => site.file === file)) : [];
    const privateRoot = mkdtempSync(path.join(sandbox, "test-"));
    const env = isolatedEnvironment(privateRoot, inherited);
    // The outer heavy gate retains its shared machine admission. Synthetic
    // stage tickets created inside a test belong only to that test's sandbox.
    env.LLV_GATE_LOCK_DIR = path.join(privateRoot, "cpu-gate");
    mkdirSync(env.LLV_GATE_LOCK_DIR, { recursive: true });
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
    env.NO_COLOR = "1"; env.FORCE_COLOR = "0";
    const report = path.join(privateRoot, "junit.xml"), log = path.join(privateRoot, "output.log");
    const fd = openSync(log, "w");
    let result: Bun.Subprocess;
    let exitCode: number;
    try {
      result = Bun.spawn({ cmd: [process.execPath, path.join(import.meta.dir, "owned-runner.ts"), "--budget", String(Math.min(budgets.fileMs, remaining) + 5_000), process.execPath, path.join(import.meta.dir, "owned-runner.ts"), ...(process.platform === "linux" ? [] : ["--portable"]), process.execPath, "test", `./${file}`, "--reporter=junit", `--reporter-outfile=${report}`, ...filter],
        // Keep the independent five-second cleanup allowance, measured as
        // execution time by the outer guard. A fixed wall timeout here would
        // kill a healthy supervisor during a nested CPU queue wait.
        cwd: root, env: { ...env, LLV_OWNED_RUN_TIMEOUT_MS: String(Math.min(budgets.fileMs, remaining)) }, stdio: ["ignore", fd, fd],
      });
      exitCode = await result.exited;
    } finally { closeSync(fd); }
    // The owned runner ends the service cgroup. A group number after the root
    // exits is neither a bound handle nor proof against PID reuse.
    try {
      if (result.signalCode || ![0, 1].includes(exitCode)) throw new Error(`runner did not finish (${result.signalCode ?? exitCode})`);
      const output = readFileSync(log, "utf8");
      const parsed = parseReport(readFileSync(report, "utf8"), output, file, root, !!options.sites);
      const survivors = output.split("\n").find(line => line.startsWith("owned runner: surviving owned processes:"));
      // A complete report still needs the service's ownership verdict.
      // Retain it so cleanup fixed on head can recover a broken baseline.
      if (survivors && exitCode !== 0) {
        appendOwnershipFailure(parsed.failures, file, survivors);
      }
      if ((exitCode === 0) !== (parsed.failures.length === 0)) {
        throw new Error(`runner exit disagrees with its report${survivors ? `; ${survivors}` : ""}`);
      }
      failures.push(...parsed.failures); passed.push(...parsed.passed); completed.push(file);
      if (parsed.failures.length) options.onFailure?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.sites) throw new Error(`${label}: ${file}: ${message}; elapsed ${(performance.now() - started).toFixed(0)}ms`);
      failures.push({ file, suite: "", name: `${RUNNER_ERROR}${message.split(root).join("<checkout>")}`, kind: "error" });
    } finally { rmSync(privateRoot, { recursive: true, force: true }); }
    options.log?.(`touched-tests: ${label} file ${file}: ${(performance.now() - fileStarted).toFixed(0)}ms wall; ${failures.length} failures; ${completed.length ? "complete" : "incomplete"}`);
    results[index] = { failures, passed, completed, elapsedMs: 0 };
  }
  }));
  const rejected = workers.find(worker => worker.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  for (const run of results) { failures.push(...run.failures); passed.push(...run.passed); completed.push(...run.completed); }
  return { failures, passed, completed, elapsedMs: performance.now() - started };
}

function dependencyGraph(root: string) {
  const manifestFile = path.join(root, "package.json");
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {};
  const inputs = ["package.json", "bun.lock", ...Object.values(manifest.patchedDependencies ?? {}) as string[]].sort();
  const fingerprint = inputs.map(file => {
    if (typeof file !== "string" || path.isAbsolute(file) || path.relative(root, path.resolve(root, file)).startsWith("..")) throw new Error("dependency patch must be a repository-relative file");
    const target = path.join(root, file);
    return [file, existsSync(target) ? digest(readFileSync(target)) : "missing"];
  });
  // Local/workspace installs can contain links back into the candidate tree.
  // Install these graphs in the baseline rather than borrowing those links.
  const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies];
  const local = (value: unknown) => typeof value === "string" && /^(?:(?:file|link|workspace):|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|~[\\/])/.test(value);
  const lockfile = path.join(root, "bun.lock");
  const lock = existsSync(lockfile) ? readFileSync(lockfile, "utf8") : "";
  // Bun records directory resolutions as name@file:path, including bare
  // relative paths and resolutions reached through overrides or dependencies.
  // Read tuple identities without requiring the newer Bun.JSONC API.
  const resolutions = [...lock.matchAll(/"(?:[^"\\]|\\.)+"\s*:\s*\[\s*("(?:[^"\\]|\\.)*")/g)].map(match => JSON.parse(match[1]!));
  const localResolution = resolutions.some(value => /@(?:file|link|workspace):/.test(value));
  const shareable = !manifest.workspaces && !localResolution && !dependencies.some(group => Object.values(group ?? {}).some(local));
  return { fingerprint, shareable };
}

export async function touchedTests(root: string, baseRef: string, selected: readonly string[], options: { env?: NodeJS.ProcessEnv; log?: (line: string) => void; budgets?: TestBudgets } = {}) {
  const started = performance.now();
  const sandbox = mkdtempSync(path.join(gateTemporaryRoot(), "delegatus-test-comparison-"));
  const log = options.log ?? console.log;
  const budget = cpuWaitBudget(options.env ?? process.env);
  const inherited = budget.env;
  const budgets = options.budgets ?? DEFAULT_TEST_BUDGETS;
  const now = () => performance.now() - budget.elapsed();
  const runOptions = { now, budgets, log };
  const logTiming = () => {
    const wall = performance.now() - started, wait = budget.elapsed();
    log(`touched-tests: timing ${wall.toFixed(0)}ms wall; ${wait.toFixed(0)}ms CPU admission; ${Math.max(0, wall - wait).toFixed(0)}ms execution`);
  };
  const env = isolatedEnvironment(sandbox, inherited);
  const git = (...args: string[]) => command(["git", ...args], root, env);
  try {
    const base = git("rev-parse", "--verify", `${baseRef}^{commit}`).trim();
    const headCommit = git("rev-parse", "--verify", "HEAD^{commit}").trim();
    log(`touched-tests: base commit ${base}`);
    log(`touched-tests: reviewed head commit ${headCommit} (head sample runs the working tree)`);
    const files = [...new Set(selected.map(file => path.relative(root, path.resolve(root, file))))].sort();
    if (!files.length) throw new Error("refusing an empty test list");
    for (const file of files) if (file.startsWith("../") || path.isAbsolute(file) || !/\.test\.[cm]?[jt]sx?$/.test(file) || file.includes(".browser.test.") || !statSync(path.join(root, file)).isFile()) throw new Error(`missing or invalid test path: ${file}`);
    const head = await runFiles(root, files, sandbox, inherited, "head", { ...runOptions, workers: HEAD_FILE_WORKERS });
    log(`touched-tests: head ${head.elapsedMs.toFixed(0)}ms`);
    if (!head.failures.length) {
      logTiming();
      log("touched-tests: green head; no baseline checkout or sample needed");
      return { ...compareTests({ failures: [], passed: [], completed: [], elapsedMs: 0 }, head), flaky: [] as FlakySite[] };
    }
    const baseFiles = new Set(git("ls-tree", "-r", "--name-only", "-z", base, "--", ...files).split("\0"));
    const failingFiles = files.filter(file => head.failures.some(site => site.file === file));
    const oldFiles = failingFiles.filter(file => baseFiles.has(file));
    const graph = dependencyGraph(root);
    const remote = oldFiles.length ? git("config", "--get", "remote.origin.url").trim() : "";
    const baselineStarted = performance.now();
    let checkout: string | undefined;
    const prepareBaseline = (deadline = Infinity) => {
      if (checkout) return checkout;
      const setupStarted = performance.now();
      const target = path.join(sandbox, "baseline");
      const execute = (args: string[], cwd = root) => {
        const remaining = Math.floor(Math.min(budgets.fileMs, deadline - now()));
        if (remaining <= 0) throw new Error("baseline: flaky rerun budget exhausted during setup");
        return command(args, cwd, env, remaining);
      };
      // A detached clone retains Git metadata without changing the pushing
      // repository's worktrees/refs. Both initial and retry samples use it.
      execute(["git", "clone", "--quiet", "--shared", "--no-checkout", "--", root, target]);
      execute(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", base], target);
      execute(["git", "config", "remote.origin.url", remote], target);
      const baseGraph = dependencyGraph(target);
      const sameGraph = graph.shareable && baseGraph.shareable && JSON.stringify(baseGraph.fingerprint) === JSON.stringify(graph.fingerprint);
      const sharedDependencies = sameGraph && existsSync(path.join(root, "node_modules"));
      if (sharedDependencies) symlinkSync(path.join(root, "node_modules"), path.join(target, "node_modules"), "dir");
      else if (existsSync(path.join(target, "bun.lock"))) execute([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], target);
      checkout = target;
      log(`touched-tests: baseline setup ${(performance.now() - setupStarted).toFixed(0)}ms (${sharedDependencies ? "shared dependencies" : "separate dependencies"})`);
      return target;
    };
    // Runner diagnostics require the whole file; assertions need only their
    // names. A missing base assertion remains absent during confirmation.
    const wholeFiles = oldFiles.filter(file => head.failures.some(site => site.file === file && site.kind === "error"));
    const assertionFiles = oldFiles.filter(file => !wholeFiles.includes(file));
    const empty: TestRun = { failures: [], passed: [], completed: [], elapsedMs: 0 };
    const whole = wholeFiles.length ? await runFiles(prepareBaseline(), wholeFiles, sandbox, inherited, "baseline", runOptions) : empty;
    const assertions = assertionFiles.length ? await runFiles(prepareBaseline(), assertionFiles, sandbox, inherited, "baseline", { ...runOptions, sites: head.failures }) : empty;
    const baseline = { failures: [...whole.failures, ...assertions.failures], passed: [...whole.passed, ...assertions.passed], completed: [...whole.completed, ...assertions.completed], elapsedMs: whole.elapsedMs + assertions.elapsedMs };
    log(`touched-tests: baseline run ${(performance.now() - baselineStarted).toFixed(0)}ms (tests ${baseline.elapsedMs.toFixed(0)}ms; ${oldFiles.length} failing file(s))`);
    log(`touched-tests: ${files.filter(file => !baseFiles.has(file)).length} new file(s), judged on head alone`);
    // A base file that did not finish certifies nothing, unless the head fails
    // to finish the same file with the same diagnostic: then the push changed
    // nothing there and the comparison below lists it as PRE-EXISTING.
    const headErrors = new Set(head.failures.filter(site => site.kind === "error").map(key));
    for (const site of baseline.failures) if (site.kind === "error" && site.name.startsWith(RUNNER_ERROR) && !headErrors.has(key(site))) throw new Error(`baseline: ${site.file}: ${diagnosticName(site).slice(RUNNER_ERROR.length)}`);
    const retryStarted = performance.now(), deadline = retryStarted - budget.elapsed() + FLAKY_BUDGET_MS;
    let reruns = 0, diagnosticReruns = 0;
    const comparison = await confirmFailures(baseline, head, async (side, sites) => {
      if (sites.some(site => site.kind === "error")) diagnosticReruns++;
      else reruns++;
      const retryFiles = [...new Set(sites.map(site => site.file))].filter(file => side === "head" || baseFiles.has(file));
      if (!retryFiles.length) return { failures: [], passed: [], completed: [], elapsedMs: 0 };
      return await runFiles(side === "head" ? root : prepareBaseline(deadline), retryFiles, sandbox, inherited, `${side} rerun`, { ...runOptions, ...(sites.some(site => site.kind === "error") ? {} : { sites }), deadline });
    });
    if (diagnosticReruns) log(`touched-tests: between-tests diagnostic retry: ${diagnosticReruns} isolated full-file run (shared budget ${FLAKY_BUDGET_MS}ms)`);
    if (reruns) log(`touched-tests: flaky confirmation ${reruns / 2} round${reruns === 2 ? "" : "s"} per side (maximum ${FLAKY_RERUNS}), ${(performance.now() - retryStarted).toFixed(0)}ms (shared budget ${FLAKY_BUDGET_MS}ms)`);
    for (const site of comparison.flaky) log(`FLAKY ${site.file}: ${site.suite ? `${site.suite} > ` : ""}${diagnosticName(site)} (base ${site.base.pass} pass/${site.base.fail} fail; head ${site.head.pass} pass/${site.head.fail} fail)`);
    for (const [label, sites] of [["NEW", comparison.introduced], ["PRE-EXISTING", comparison.preexisting], ["FIXED", comparison.fixed], ["REMOVED/SKIPPED", comparison.absent]] as const) {
      for (const site of sites) log(`${label} ${site.file}: ${site.suite ? `${site.suite} > ` : ""}${diagnosticName(site)}${label === "PRE-EXISTING" && site.kind === "error" ? " (the base run of this file is broken the same way)" : ""}`);
    }
    logTiming();
    log(`touched-tests: ${comparison.introduced.length} new failures, ${comparison.preexisting.length} pre-existing failures, ${comparison.fixed.length} fixed, ${comparison.absent.length} removed/skipped, ${comparison.flaky.length} flaky`);
    return comparison;
  } finally { budget.close(); rmSync(sandbox, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const [, , flag, base, ...files] = process.argv;
    if (flag !== "--base" || !base) throw new Error("usage: local-gate-tests.ts --base <merge-base> <files...>");
    if ((await touchedTests(process.cwd(), base, files)).introduced.length) process.exitCode = 1;
  } catch (error) {
    console.error(`touched-tests: ${error instanceof Error ? error.message : error}; gate error (blocking)`);
    process.exitCode = 1;
  }
}
