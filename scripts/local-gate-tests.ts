import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeXML } from "entities";
import { gateTemporaryRoot, isolatedEnvironment } from "./local-gate";

export interface TestSite { file: string; suite: string; name: string; kind: "test" | "error"; occurrence?: number }
export interface TestRun { failures: TestSite[]; passed: TestSite[]; elapsedMs: number; completed: string[] }
const escapedTemporaryRoot = path.join(gateTemporaryRoot(), "delegatus-test-comparison-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const privateTestRoot = new RegExp(`${escapedTemporaryRoot}[a-zA-Z0-9]{6}[/\\\\]test-[a-zA-Z0-9]{6}`, "g");
const diagnosticName = (site: TestSite) => site.kind === "error" ? site.name.replace(privateTestRoot, "<sandbox>") : site.name;
const key = (site: TestSite) => JSON.stringify([site.file, site.suite, diagnosticName(site), site.kind]);
const occurrenceKey = (site: TestSite) => JSON.stringify([key(site), site.occurrence ?? 0]);
const comparisonKey = (site: TestSite) => site.kind === "test" && site.occurrence !== undefined ? occurrenceKey(site) : key(site);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const MAX_CACHE_ENTRIES = 32;
const RESULT_NAME = /^[a-f0-9]{64}\.json$/;
const PENDING_NAME = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.pending$/;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_BUDGET_MS = 15 * 60 * 1000;
const FILE_BUDGET_MS = 5 * 60 * 1000;
export const FLAKY_RERUNS = 3;
export const FLAKY_BUDGET_MS = 5 * 60 * 1000;
interface Counts { pass: number; fail: number }
interface FlakySite extends TestSite { base: Counts; head: Counts }
const occurrenceCount = (sites: readonly TestSite[], site: TestSite) => sites.filter(other => occurrenceKey(other) === occurrenceKey(site)).length;

/** Confirm assertions that failed the first head sample and did not fail the
 * first base sample: those alone can refuse the push. A failure the base sample
 * already showed stays PRE-EXISTING on that one sample per side and costs no
 * reruns, since neither label it could end with blocks. Mixed results on either
 * side make a confirmed assertion non-blocking FLAKY; runner errors retain
 * their existing comparison. Never treat absence as a pass.
 */
export function confirmFailures(base: TestRun, head: TestRun, rerun: (side: "base" | "head", sites: readonly TestSite[]) => TestRun) {
  const comparison = compareTests(base, head);
  const candidates = [...new Map(comparison.introduced.filter(site => site.kind === "test").map(site => [occurrenceKey(site), site])).values()];
  const flaky: FlakySite[] = [];
  if (!candidates.length) return { ...comparison, flaky };
  const evidence = candidates.map(site => ({ site,
    base: { pass: occurrenceCount(base.passed, site), fail: occurrenceCount(base.failures, site) },
    head: { pass: occurrenceCount(head.passed, site), fail: occurrenceCount(head.failures, site) },
    baseRetryFailed: false,
    headRetryPassed: false,
  }));
  for (let round = 0; round < FLAKY_RERUNS; round++) {
    for (const side of ["base", "head"] as const) {
      const run = rerun(side, candidates);
      if (run.failures.some(site => site.kind === "error")) throw new Error(`${side} rerun: incomplete runner or between-tests error`);
      for (const item of evidence) {
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
    if (/<(?:failure|error)\b/.test(match[2] ?? "")) { failures.push(site); namedFailures++; }
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

function runFiles(root: string, files: readonly string[], sandbox: string, inherited: NodeJS.ProcessEnv, label: string, options: { sites?: readonly TestSite[]; deadline?: number; onFailure?: () => void } = {}): TestRun {
  const started = performance.now(), failures: TestSite[] = [], passed: TestSite[] = [], completed: string[] = [];
  for (const file of files) {
    const remaining = Math.floor(Math.min(RUN_BUDGET_MS - (performance.now() - started), (options.deadline ?? Infinity) - performance.now()));
    if (remaining <= 0) throw new Error(`${label}: test run exceeded its ${options.deadline ? "flaky rerun" : "15 minute"} budget`);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Bun filters the outer-to-inner describe names joined by spaces. Its JUnit
    // classname records the same ancestry in reverse, separated by " > ".
    const names = options.sites?.filter(site => site.file === file).flatMap(site => {
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
    const filter = names ? [`--test-name-pattern=^(?:${names.join("|")})$`, "--pass-with-no-tests"] : [];
    const privateRoot = mkdtempSync(path.join(sandbox, "test-"));
    const env = isolatedEnvironment(privateRoot, inherited);
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
    env.NO_COLOR = "1"; env.FORCE_COLOR = "0";
    const report = path.join(privateRoot, "junit.xml"), log = path.join(privateRoot, "output.log");
    const fd = openSync(log, "w");
    let result: Bun.SyncSubprocess;
    try {
      result = Bun.spawnSync({ cmd: [process.execPath, "test", `./${file}`, "--reporter=junit", `--reporter-outfile=${report}`, ...filter],
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
      const parsed = parseReport(readFileSync(report, "utf8"), output, file, root, !!options.sites);
      if ((result.exitCode === 0) !== (parsed.failures.length === 0)) throw new Error("runner exit disagrees with its report");
      failures.push(...parsed.failures); passed.push(...parsed.passed); completed.push(file);
      if (parsed.failures.length) options.onFailure?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (label === "baseline" || options.sites) throw new Error(`${label}: ${file}: ${message}; elapsed ${(performance.now() - started).toFixed(0)}ms`);
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
    const graph = dependencyGraph(root);
    const remote = oldFiles.length ? git("config", "--get", "remote.origin.url").trim() : "";
    // Scope ids and journal descriptors change on each gate-slot invocation;
    // they do not change the test inputs. Keep semantic environment in the key.
    const environment = Object.entries(env).filter(([k]) => !["PWD", "OLDPWD", "_", "SHLVL", "LLV_GATE_LOCK_DIR", "INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v?.split(sandbox).join("<sandbox>")]);
    const identity = digest(JSON.stringify(["per-file-junit-v5-occurrence-aware-green-only", base, files, remote, Bun.version, process.execPath, process.platform, process.arch, graph, environment]));
    const cache = options.cache ?? path.join(gateTemporaryRoot(), `delegatus-test-baselines-${process.getuid?.() ?? "user"}`);
    prepareCache(cache);
    const entry = path.join(cache, `${identity}.json`);
    let baseline: TestRun | undefined;
    const baselineStarted = performance.now();
    if (existsSync(entry)) {
      try {
        const value = JSON.parse(readFileSync(entry, "utf8"));
        if (value.identity !== identity || !validRun(value.run) || value.run.failures.length || value.integrity !== digest(JSON.stringify({ identity, run: value.run })) || JSON.stringify(value.run.completed) !== JSON.stringify(oldFiles) || ![...value.run.failures, ...value.run.passed].every((site: TestSite) => baseFiles.has(site.file))) throw new Error("invalid baseline cache payload");
        baseline = value.run;
      } catch { log("touched-tests: invalid baseline cache; rebuilding"); }
    }
    const cached = !!baseline;
    let checkout: string | undefined;
    const prepareBaseline = (deadline = Infinity) => {
      if (checkout) return checkout;
      const target = path.join(sandbox, "baseline");
      const execute = (args: string[], cwd = root) => {
        const remaining = Math.floor(Math.min(FILE_BUDGET_MS, deadline - performance.now()));
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
      if (sameGraph && existsSync(path.join(root, "node_modules"))) symlinkSync(path.join(root, "node_modules"), path.join(target, "node_modules"), "dir");
      else if (existsSync(path.join(target, "bun.lock"))) execute([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], target);
      checkout = target;
      return target;
    };
    if (!baseline) {
      baseline = oldFiles.length ? runFiles(prepareBaseline(), oldFiles, sandbox, inherited, "baseline")
        : { failures: [], passed: [], completed: [], elapsedMs: 0 };
      const payload = { identity, run: baseline };
      const serialized = JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) });
      if (!baseline.failures.length && Buffer.byteLength(serialized) <= MAX_CACHE_BYTES) {
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
    const retryStarted = performance.now(), deadline = retryStarted + FLAKY_BUDGET_MS;
    let reruns = 0;
    const comparison = confirmFailures(baseline, head, (side, sites) => {
      reruns++;
      const retryFiles = [...new Set(sites.map(site => site.file))].filter(file => side === "head" || baseFiles.has(file));
      if (!retryFiles.length) return { failures: [], passed: [], completed: [], elapsedMs: 0 };
      try {
        return runFiles(side === "head" ? root : prepareBaseline(deadline), retryFiles, sandbox, inherited, `${side} rerun`, {
          sites, deadline,
          // Evict on the first parsed base failure, before a later file can
          // abort this retry batch and discard its partial result.
          onFailure: side === "base" ? () => rmSync(entry, { force: true }) : undefined,
        });
      } catch (error) {
        // An aborted base retry cannot certify the cached green sample either.
        if (side === "base") rmSync(entry, { force: true });
        throw error;
      }
    });
    if (reruns) log(`touched-tests: flaky confirmation ${FLAKY_RERUNS} reruns per side, ${(performance.now() - retryStarted).toFixed(0)}ms (shared budget ${FLAKY_BUDGET_MS}ms)`);
    for (const site of comparison.flaky) log(`FLAKY ${site.file}: ${site.suite ? `${site.suite} > ` : ""}${diagnosticName(site)} (base ${site.base.pass} pass/${site.base.fail} fail; head ${site.head.pass} pass/${site.head.fail} fail)`);
    for (const [label, sites] of [["NEW", comparison.introduced], ["PRE-EXISTING", comparison.preexisting], ["FIXED", comparison.fixed], ["REMOVED/SKIPPED", comparison.absent]] as const) {
      for (const site of sites) log(`${label} ${site.file}: ${site.suite ? `${site.suite} > ` : ""}${diagnosticName(site)}`);
    }
    log(`touched-tests: ${comparison.introduced.length} new failures, ${comparison.preexisting.length} pre-existing failures, ${comparison.fixed.length} fixed, ${comparison.absent.length} removed/skipped, ${comparison.flaky.length} flaky`);
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
