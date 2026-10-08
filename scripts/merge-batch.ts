import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync, unlinkSync, lstatSync, rmdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { decodeXML } from "entities";
import type { GithubRunner } from "../src/lib/monitor/githubEvidence";
import { parseReport, testNameFilter, type TestRun, type TestSite } from "./local-gate-tests";
import { isolatedEnvironment } from "./local-gate";

// A between-test error, a runner disagreement and a file that produced no
// usable report are one file-level fault: their messages vary between runs,
// and native main's own fault in a file makes the candidate's pre-existing.
const testIdentity = (site: TestSite) => site.kind === "error" ? JSON.stringify([site.file, "<file fault>"])
  : JSON.stringify([site.file, site.suite, site.name, site.occurrence ?? 0]);
export const INCOMPLETE_FILE = "<incomplete file: no usable report>";
export const fileFault = (file: string, name: string): TestSite => ({ file, suite: "", name, kind: "error" });
/** A complete focused report without the requested case proves absence, even
 * when the full file aborts. Skipped and unreported cases prove nothing. */
type BatchTestRun = TestRun & { absent?: TestSite[] };

/** Native main's failures and file faults are pre-existing. A file main could
 * not complete is compared on completed cases and cases proven absent from
 * main's registered inventory by a focused rerun (see `mainCases`). */
export function compareBatchTests(base: BatchTestRun, candidate: TestRun) {
  const failed = new Set(base.failures.map(testIdentity));
  const passed = new Set(base.passed.map(testIdentity));
  const absent = new Set(base.absent?.map(testIdentity));
  const incomplete = new Set(base.failures.filter(site => site.name === INCOMPLETE_FILE).map(site => site.file));
  const result = { preExisting: [] as TestSite[], introduced: [] as TestSite[], uncompared: [] as TestSite[] };
  for (const site of candidate.failures) {
    if (failed.has(testIdentity(site))) result.preExisting.push(site);
    else if (site.kind === "test" && incomplete.has(site.file) && !passed.has(testIdentity(site)) && !absent.has(testIdentity(site))) result.uncompared.push(site);
    else result.introduced.push(site);
  }
  return result;
}

export const MAX_TEST_CONFIRMATIONS = 3;
export const MAX_TEST_CONFIRMATION_RUNS = MAX_TEST_CONFIRMATIONS * 2;
type TestObservation = { removed: number[]; outcome: "pass" | "fail" };
export type TestAttribution = {
  test: TestSite; prs: number[]; reason: string; confirmation: ("pass" | "fail")[]; removals: TestObservation[];
};
export type BatchTestDecision = {
  preExisting: TestSite[]; intermittent: TestSite[]; attributed: TestAttribution[]; uncompared?: TestSite[];
  /** Failures no removal clears in a reviewed copy of a file its PR never
   * changed and main changed since: they defer that PR alone. */
  stale?: TestAttribution[];
};
/** A reviewed copy of a test file its PR did not change, which main changed
 * after the PR's base, judges main's change with the branch's old assertions. */
export type StaleDetector = (test: TestSite) => { pr: number; reason: string } | undefined;
export const UNATTRIBUTABLE_RULE = "rule: no removal clears it and it is no stale reviewed detector, so nothing narrows it to a PR";
/** Missing, skipped and unreported assertions provide no passing evidence. */
function observed(run: TestRun, test: TestSite): "pass" | "fail" {
  if (run.failures.some(site => testIdentity(site) === testIdentity(test))) return "fail";
  if (test.kind === "error") return run.completed.includes(test.file) ? "pass" : "fail";
  return run.passed.some(site => testIdentity(site) === testIdentity(test)) ? "pass" : "fail";
}
const addUnique = (sites: TestSite[], additions: TestSite[]) => {
  for (const site of additions) if (!sites.some(other => testIdentity(other) === testIdentity(site))) sites.push(site);
};

type ConfirmedFailure = { test: TestSite; confirmation: ("pass" | "fail")[] };
/** Both batch attribution and resolution publication use this comparison and
 * bounded confirmation against a fresh, native-main per-file sample. */
async function confirmBatchTests(base: BatchTestRun, candidate: TestRun,
  rerun: (files: string[]) => Promise<TestRun>, mainCases?: (sites: TestSite[]) => Promise<BatchTestRun>
): Promise<{ decision: BatchTestDecision; confirmed: ConfirmedFailure[] }> {
  const probed = new Set<string>();
  const compare = async (run: TestRun) => {
    const sites = compareBatchTests(base, run).uncompared.filter(site => !probed.has(testIdentity(site)));
    if (!mainCases || !sites.length) return compareBatchTests(base, run);
    for (const site of sites) probed.add(testIdentity(site));
    const focused = await mainCases(sites);
    base = { ...base, failures: [...base.failures, ...focused.failures], passed: [...base.passed, ...focused.passed],
      absent: [...base.absent ?? [], ...focused.absent ?? []] };
    return compareBatchTests(base, run);
  };
  const comparison = await compare(candidate);
  const decision: BatchTestDecision = { preExisting: [], intermittent: [], attributed: [], uncompared: [] };
  addUnique(decision.preExisting, comparison.preExisting);
  addUnique(decision.uncompared!, comparison.uncompared);
  const pending = new Map(comparison.introduced.map(test => [testIdentity(test), { test, confirmation: [] as ("pass" | "fail")[] }]));
  const files = [...new Set(comparison.introduced.map(test => test.file))];
  if (!files.length) return { decision, confirmed: [] };
  for (let round = 0; round < MAX_TEST_CONFIRMATION_RUNS; round++) {
    const run = await rerun(files);
    const discovered = await compare(run);
    addUnique(decision.preExisting, discovered.preExisting);
    addUnique(decision.uncompared!, discovered.uncompared);
    for (const entry of pending.values()) entry.confirmation.push(observed(run, entry.test));
    for (const test of discovered.introduced) {
      if (!pending.has(testIdentity(test))) pending.set(testIdentity(test), { test, confirmation: [] });
    }
    if ([...pending.values()].every(entry => entry.confirmation.length >= MAX_TEST_CONFIRMATIONS)) break;
  }
  if ([...pending.values()].some(entry => entry.confirmation.length < MAX_TEST_CONFIRMATIONS)) {
    throw new Error("Candidate confirmation budget exhausted with unclassified failures; batch not gated");
  }
  const confirmed = [...pending.values()].filter(({ test, confirmation }) => {
    if (confirmation.includes("pass")) { decision.intermittent.push(test); return false; }
    return true;
  });
  return { decision, confirmed };
}

/** Recorded results drive the decision; callbacks supply fresh file samples.
 * `without` receives the cases it must report even when the file aborts, and
 * `mainCases` runs only the named cases on native main for files main could
 * not complete, so their completed cases still name a culprit. */
export async function attributeBatchTests(base: BatchTestRun, candidate: TestRun, prs: number[],
  rerun: (files: string[]) => Promise<TestRun>, without: (removed: number[], files: string[], focus: TestSite[]) => Promise<TestRun>,
  mainCases?: (sites: TestSite[]) => Promise<BatchTestRun>, stale?: StaleDetector): Promise<BatchTestDecision> {
  const { decision, confirmed: failures } = await confirmBatchTests(base, candidate, rerun, mainCases);
  const confirmed = failures.map(entry => entry.test);
  if (!confirmed.length) return decision;
  const affected = [...new Set(confirmed.map(test => test.file))];
  const removals: { removed: number[]; run: TestRun }[] = [];
  for (const pr of prs) removals.push({ removed: [pr], run: await without([pr], affected, confirmed) });
  const evidence = new Map(confirmed.map(test => [testIdentity(test),
    removals.map((entry): TestObservation => ({ removed: entry.removed, outcome: observed(entry.run, test) }))]));
  const cleared = (test: TestSite) => evidence.get(testIdentity(test))!.some(entry => entry.outcome === "pass");
  // Several independent changes can keep the same assertion red after each
  // single removal. One all-removed sample serves every such failure; one that
  // clears there finds a minimal clearing removal set, retaining unrelated PRs.
  const uncleared = confirmed.filter(test => !cleared(test));
  const all = uncleared.length ? await without([...prs], [...new Set(uncleared.map(test => test.file))], uncleared) : undefined;
  const held = uncleared.filter(test => observed(all!, test) !== "pass");
  const unattributable = held.filter(test => !stale?.(test));
  if (unattributable.length) {
    throw new Error(`Cannot establish attribution for ${unattributable.map(site => `${site.file} > ${site.suite} > ${site.name}`).join("; ")}; detectors retained; batch not gated (${UNATTRIBUTABLE_RULE})`);
  }
  for (const { test, confirmation } of failures) {
    const samples = evidence.get(testIdentity(test))!;
    let responsible = samples.filter(entry => entry.outcome === "pass").map(entry => entry.removed[0]!);
    const reason = responsible.length === 1 ? "test regression" : "integration: needs both";
    if (!responsible.length) {
      responsible = [...prs];
      samples.push({ removed: [...responsible], outcome: observed(all!, test) });
      if (held.includes(test)) {
        const classified = stale!(test)!;
        (decision.stale ??= []).push({ test, prs: [classified.pr], reason: classified.reason, confirmation, removals: samples });
        continue;
      }
      for (const pr of prs) {
        const removed = responsible.filter(number => number !== pr);
        const outcome = observed(await without(removed, [test.file], [test]), test);
        samples.push({ removed, outcome });
        if (outcome === "pass") responsible = removed;
      }
    }
    decision.attributed.push({ test, prs: responsible, reason, confirmation, removals: samples });
  }
  return decision;
}

export type ReviewedPr = { number: number; reviewed: string };
export type Candidate = { main: string; prs: { number: number; head: string }[] };
export function candidateOf(state: Pick<RunState, "base" | "rows">): Candidate {
  return { main: state.base, prs: state.rows.filter(row => row.status === "clean").map(row => ({ number: row.number, head: row.head })) };
}
const sameCandidate = (a: Candidate, b: Candidate) => JSON.stringify(a) === JSON.stringify(b);
/** `stale` names the corpus files that are stale reviewed copies, with the reason its PR is deferred. */
type Detector = { source: string; pr?: number; corpus: Record<string, string>; stale?: Record<string, string> };
type NotApplicable = { source: string; file: string; reason: string };
type AttributionRecord = TestAttribution & { candidate: Candidate; source: string; stale?: true };
type Validation = { candidate: Candidate; tip: string; decisions: BatchTestDecision[]; notApplicable: NotApplicable[] };

export function parseReviewedPrs(input: string): ReviewedPr[] {
  const seen = new Set<number>();
  return input.split(",").map((item) => {
    const match = /^\s*([1-9]\d*)@([a-f0-9]{7,40})\s*$/.exec(item);
    if (!match || !Number.isSafeInteger(Number(match[1])) || seen.has(Number(match[1]))) {
      throw new Error("Expected unique N@reviewedSha pairs (7–40 lowercase hexadecimal characters)");
    }
    const number = Number(match[1]);
    seen.add(number);
    return { number, reviewed: match[2]! };
  });
}

type Credit = { name: string; email: string; message: string };
function machineEmail(email: string): boolean {
  return /^(?:noreply|no-reply)@[a-z0-9.-]+$/i.test(email)
    && !/@(?:users\.noreply\.github\.com|github\.com)$/i.test(email);
}

export function batchMessage(number: number, title: string, body: string, authors: Credit[]): string {
  const trailers = new Set<string>();
  for (const author of authors) {
    if (machineEmail(author.email)) {
      if (/[\r\n<>]/.test(author.name)) throw new Error("Invalid machine display name");
      trailers.add(`Co-Authored-By: ${author.name} <${author.email}>`);
    }
    for (const line of author.message.split("\n")) {
      if (!/^(?:Co-Authored-By|Signed-Off-By):/i.test(line)) continue;
      const match = /^(Co-Authored-By|Signed-Off-By):\s*([^<>\r\n]+)\s+<([^<>\s]+)>\s*$/i.exec(line);
      if (!match || !machineEmail(match[3]!)) throw new Error("Non-machine attribution trailer refused");
      const kind = /^signed-off-by$/i.test(match[1]!) ? "Signed-Off-By" : "Co-Authored-By";
      trailers.add(`${kind}: ${match[2]!.trim()} <${match[3]}>`);
    }
  }
  // PR prose also goes through the privacy gate before publication.
  if (/\r|\n/.test(title) || /^Co-Authored-By:/im.test(body)) throw new Error("Invalid PR summary or attribution");
  const summary = body.trim().split(/\n\s*\n/)[0]!.slice(0, 600);
  return [`${title} (#${number})`, ...(summary ? [summary] : []), ...(trailers.size ? [[...trailers].sort().join("\n")] : [])].join("\n\n") + "\n";
}

export function touchedTests(paths: string[], regularFile: (path: string) => boolean): string[] {
  const result = new Set<string>();
  for (const path of paths) {
    if (path.startsWith("-") || path.split("/").includes("..")) throw new Error("Unsafe changed path");
    const candidates = /\.test\.[cm]?[jt]sx?$/.test(path) ? [path]
      : /\.[cm]?[jt]sx?$/.test(path) ? [path.replace(/\.[cm]?[jt]sx?$/, ".test.ts"), path.replace(/\.[cm]?[jt]sx?$/, ".test.tsx")] : [];
    for (const candidate of candidates) if (regularFile(candidate)) result.add(candidate);
  }
  return [...result].sort();
}

type BatchCommit = { number: number; commit: string; paths: string[] };
const privacyFindingClass = "(?:configuration_error|credential|email_address|home_path|inspection_error|known_value|media_live_source|private_network|provenance_invalid|provenance_missing|resource_identifier|tool_unavailable|transcript_content|unsafe_path)";
export function noticePrs(log: string, commits: BatchCommit[], lineOwner?: (path: string, line: number) => string | undefined): number[] {
  // Accept only the privacy gate's complete, known notice shapes. Parsing
  // arbitrary log lines lets a filename containing a newline forge blame.
  const lines = log.split("\n").map((line) => {
    const envelope = /^[^\t\r\n]+\t[^\t\r\n]+\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) +(.*)$/.exec(line);
    return envelope?.[1] ?? line;
  });
  const commitNotices = lines.filter((line) => new RegExp(
    `^(?:commit_message: [a-f0-9]{12} message (?:unreadable|${privacyFindingClass}(?:, ${privacyFindingClass})*)`
      + `|merge_boundary: [a-f0-9]{12} (?:author|committer) identity composes an attributable Co-Authored-By trailer \\(address withheld\\))$`,
  ).test(line));
  const fileNotices = lines.filter((line) => new RegExp(
    `^file-sha256:[a-f0-9]{64}(?::\\d+)? ${privacyFindingClass}$`,
  ).test(line));
  const notices = [...commitNotices, ...fileNotices];
  const hashes = new Set(commitNotices.flatMap((line) => {
    const match = /^(?:commit_message|merge_boundary): ([a-f0-9]{12}) /.exec(line);
    return match ? [match[1]!] : [];
  }));
  const attributed = new Set(commits.filter((entry) => [...hashes].some((hash) => entry.commit.startsWith(hash)))
    .map((entry) => entry.number));
  const pathsByDigest = new Map<string, string[]>();
  for (const entry of commits) for (const path of entry.paths) {
    const digest = createHash("sha256").update(path).digest("hex");
    pathsByDigest.set(digest, [...(pathsByDigest.get(digest) ?? []), path]);
  }
  for (const line of notices) {
    const diagnostic = /^file-sha256:([a-f0-9]{64}):(\d+) ([a-z_]+)$/.exec(line);
    const pathNotice = /^file-sha256:([a-f0-9]{64}) ([a-z_]+)$/.exec(line);
    const fileNotice = diagnostic ?? pathNotice;
    if (fileNotice) {
      const paths = pathsByDigest.get(fileNotice[1]!) ?? [];
      if (diagnostic && lineOwner) {
        const owners = new Set(paths.map((path) => lineOwner(path, Number(diagnostic[2]))).filter((owner): owner is string => Boolean(owner)));
        for (const owner of owners) {
          const row = commits.find((entry) => entry.commit === owner);
          if (row) attributed.add(row.number);
        }
      } else if (!diagnostic && paths.length === 1) {
        const writers = commits.filter((entry) => entry.paths.includes(paths[0]!));
        if (writers.length === 1) attributed.add(writers[0]!.number);
      }
      continue;
    }
  }
  return [...attributed];
}

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string };
export function requiredVerdict(required: string[], checks: Check[]): "green" | "red" | "pending" {
  if (!required.length) throw new Error("Required checks could not be established");
  let pending = false;
  for (const name of required) {
    const matches = checks.filter((check) => (check.name ?? check.context) === name);
    if (!matches.length) pending = true;
    for (const check of matches) {
      const result = check.conclusion ?? check.state;
      if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result ?? "")) return "red";
      if (!(check.status === undefined || check.status === "COMPLETED") || !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result ?? "")) pending = true;
    }
  }
  return pending ? "pending" : "green";
}

export const MAX_MAIN_REFRESHES = 3;
export const MAX_REQUIRED_CHECK_POLLS = 240;
export function nextRefresh(count: number): number {
  if (count >= MAX_MAIN_REFRESHES) throw new Error("Main moved more than three times");
  return count + 1;
}

export function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, input, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).trimEnd();
}

export function patchId(cwd: string, base: string, head: string): string {
  return git(cwd, ["patch-id", "--stable"], git(cwd, ["diff", "--binary", "-U0", base, head, "--"]) + "\n").split(" ")[0]!;
}

type PrView = {
  number: number; title: string; body: string; state: string; isDraft: boolean;
  baseRefName: string; headRefOid: string; headRefName: string;
  closingIssuesReferences: { number: number }[];
  headRepository: { name: string } | null;
};
export type BatchRow = ReviewedPr & {
  head: string; reviewBase: string; view: PrView; patch: string; status: "clean" | "deferred" | "culprit" | "head-moved" | "merged" | "needs-review";
  commit: string; paths: string[]; detail: string; resolution?: string;
  resolutionTests?: { main: string; tip: string; files: string[]; decision: BatchTestDecision; confirmed: ConfirmedFailure[] };
};
export type Gate = { id: string; args: string[]; report?: boolean; filter?: string[] };
export type RunState = {
  version: 3; repo: string; work: string; branch: string; base: string; tip: string;
  rows: BatchRow[]; gated: Validation | null; batch: { number: number; url: string } | null;
  published: string | null; refreshes: number; landed: boolean; gates: Gate[];
  resolving?: { number: number; work: string; main: string };
  mergeIntent?: string;
  /** Full browser campaigns are opt-in (`gate --browser`); review ran them per PR. */
  browser?: boolean;
  attributionLog: AttributionRecord[];
};
export type CommandResult = { code: number; output: string; report?: string };
export type CommandRunner = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>;

export const commandRunner: CommandRunner = (cwd, args, env = process.env) => new Promise((done, reject) => {
  const child = spawn(args[0]!, args.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-1024 * 1024); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", reject);
  child.on("close", (code) => done({ code: code ?? 1, output }));
});

/** Every gate command runs inside one machine-wide slot, CPU-pressure
 * admission and its own scope (docs/design/cpu-placement.md), never inside the
 * merger agent's scope. The copy beside this script is used, so a bisect
 * subject or a trusted base checkout cannot swap it. */
export const GATE_SLOT = join(import.meta.dir, "gate-slot.sh");
export const isBrowserTest = (path: string) => path.includes(".browser.test.");
/** Test processes reach no live Viewer: port 9 (discard) is closed. */
const CLOSED_VIEWER_CONTROL_URL = "http://127.0.0.1:9";

/** Replace this one function when the CI/local-hooks lane supplies its wrapper. */
export function localGateCommands(cwd: string, base: string, browser = false): Gate[] {
  const paths = git(cwd, ["diff", "--name-only", "-z", base, "HEAD", "--"]).split("\0").filter(Boolean);
  const file = (path: string) => existsSync(join(cwd, path)) && statSync(join(cwd, path)).isFile();
  const tests = touchedTests(paths, file).filter(path => browser || !isBrowserTest(path));
  const lint = paths.filter((path) => /\.[cm]?[jt]sx?$/.test(path) && file(path));
  return [
    { id: "dependencies", args: ["bun", "install", "--frozen-lockfile"] },
    { id: "tsc", args: ["bunx", "tsc", "--noEmit"] },
    ...(lint.length ? [{ id: "eslint", args: ["bun", "scripts/eslint-changes.ts", "--base", base, ...lint] }] : []),
    ...(tests.length ? [{ id: "tests", args: ["bun", "test", ...tests.map((path) => `./${path}`)] }] : []),
    { id: "privacy", args: ["bun", "scripts/privacy-publication-gate.ts", "--base", base, "--check-commits"] },
  ];
}

function testEnvironment(stateDir: string): NodeJS.ProcessEnv {
  const env = isolatedEnvironment(stateDir, process.env);
  for (const key of ["LLV_SPAWN_CAPABILITY", "LLV_STRUCTURED_HOST", "LLV_VIEWER_CONTROL_TOKEN", "LLV_VIEWER_DEPLOY_TARGET", "LLV_VIEWER_PORT"]) delete env[key];
  env.LLV_VIEWER_CONTROL_URL = CLOSED_VIEWER_CONTROL_URL;
  return env;
}

function prepareCorpusPath(cwd: string, path: string, createdDirectories: string[]): string {
  const segments = path.split(/[\\/]/);
  if (path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Unsafe regression test path in batch gate");
  }
  let current = cwd;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const final = index === segments.length - 1;
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || (final ? !metadata.isFile() : !metadata.isDirectory())) {
        throw new Error("Regression test path changed type during bisect");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (final) continue;
      mkdirSync(current);
      createdDirectories.push(current);
    }
  }
  return current;
}

const PR_FIELDS = "number,title,body,state,isDraft,baseRefName,headRefOid,headRefName,closingIssuesReferences,headRepository";
const BATCH_FIELDS = "number,url,state,headRefOid,mergeStateStatus,statusCheckRollup,mergeCommit";

export class MergeBatch {
  readonly gh: GithubRunner;
  constructor(readonly repo: string, readonly stateFile: string, readonly run: CommandRunner = commandRunner, gh?: GithubRunner,
    readonly sleep: () => Promise<void> = () => new Promise((done) => setTimeout(done, 10_000))) {
    this.gh = gh ?? (async (args) => {
      const result = await this.run(repo, ["gh", ...args]);
      if (result.code) throw new Error("GitHub command failed; no merge verdict can be established");
      return result.output.trim();
    });
  }

  private queue: Promise<unknown> = Promise.resolve();
  /** Heavy commands run one at a time: concurrent installs, type checks and
   * test files twice exhausted a merger's memory cap. */
  private gateRun(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
    const result = this.queue.then(() => this.run(cwd, [GATE_SLOT, ...args], env));
    this.queue = result.catch(() => undefined);
    return result;
  }

  read(): RunState {
    const state = JSON.parse(readFileSync(this.stateFile, "utf8")) as RunState;
    if (state.version !== 3 || realpathSync(state.repo) !== realpathSync(this.repo)
      || !/^merge-batch\/[a-f0-9-]{36}$/.test(state.branch)
      || git(state.work, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== git(this.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
      throw new Error("Batch state does not belong to this repository");
    }
    return state;
  }

  save(state: RunState): void {
    const temporary = `${this.stateFile}.${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.stateFile);
  }

  private assertTip(state: RunState): void {
    if (git(state.work, ["symbolic-ref", "--short", "HEAD"]) !== state.branch
      || git(state.work, ["rev-parse", "HEAD"]) !== state.tip
      || git(state.work, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Batch worktree changed outside this run");
  }

  private assertValidated(state: RunState): void {
    this.assertTip(state);
    if (!state.gated || state.gated.tip !== state.tip || !sameCandidate(state.gated.candidate, candidateOf(state))) {
      throw new Error("Run gate before land: exact candidate has not completed full validation");
    }
  }

  private identity(cwd: string): void {
    for (const kind of ["AUTHOR", "COMMITTER"]) {
      const identity = git(cwd, ["var", `GIT_${kind}_IDENT`]);
      const email = /<([^<>]+)>/.exec(identity)?.[1];
      if (!email || !machineEmail(email)) throw new Error("Batch commits require a machine noreply identity");
    }
  }

  private async assertMachineForgePrincipal(repository: string): Promise<void> {
    // GitHub's rebase merge replaces the committer on the server. Local Git
    // identity and hooks cannot protect that write. This endpoint authenticates
    // an App installation; PATs and App user tokens cannot use it. /user cannot
    // prove this because installation tokens cannot access that endpoint.
    try {
      const accessible = await this.gh([
        "api", "installation/repositories?per_page=100", "--hostname", "github.com", "--paginate",
        "--jq", `.repositories[] | select(.full_name == "${repository}") | .full_name`,
      ]);
      if (accessible.trim() === repository) return;
    } catch { /* An unreadable principal must refuse the server-side write. */ }
    throw new Error("Forge rebase merge requires a verified machine principal; personal or unverified credentials refused");
  }

  private async view(number: number): Promise<PrView> {
    const view = JSON.parse(await this.gh(["pr", "view", String(number), "--json", PR_FIELDS])) as PrView;
    if (view.number !== number || !/^[a-f0-9]{40}$/.test(view.headRefOid)) throw new Error("Invalid PR response");
    return view;
  }

  private async unchanged(row: BatchRow): Promise<boolean> {
    const view = await this.view(row.number);
    return view.state === "OPEN" && !view.isDraft && view.baseRefName === "main"
      && view.headRefOid === row.head && view.headRefName === row.view.headRefName;
  }

  private async stale(state: RunState): Promise<boolean> {
    let changed = false;
    for (const row of state.rows.filter(row => row.status === "clean")) {
      if (!await this.unchanged(row)) { row.status = "head-moved"; changed = true; }
    }
    git(state.work, ["fetch", "origin", "main"]);
    const main = git(state.work, ["rev-parse", "origin/main"]);
    if (main !== state.base) {
      state.gated = null; this.save(state);
      state.refreshes = nextRefresh(state.refreshes);
      state.base = main; changed = true;
    }
    if (changed) { state.gated = null; this.save(state); }
    return changed;
  }

  async build(input: string): Promise<RunState> {
    if (existsSync(this.stateFile)) throw new Error("A batch already exists in this TMPDIR; use a fresh run directory");
    const pairs = parseReviewedPrs(input);
    this.identity(this.repo);
    git(this.repo, ["fetch", "origin", "main"]);
    const base = git(this.repo, ["rev-parse", "origin/main"]);
    const root = mkdtempSync(join(dirname(this.stateFile), "merge-batch-"));
    const branch = `merge-batch/${randomUUID()}`;
    const work = join(root, "checkout");
    git(this.repo, ["worktree", "add", "-b", branch, work, base]);
    const state: RunState = { version: 3, repo: realpathSync(this.repo), work, branch, base, tip: base,
      rows: [], gated: null, batch: null, published: null, refreshes: 0, landed: false, gates: [], attributionLog: [] };
    // Save ownership before any batch mutation, so failures remain inspectable.
    this.save(state);
    for (const pair of pairs) {
      const view = await this.view(pair.number);
      git(work, ["fetch", "origin", `refs/pull/${pair.number}/head`]);
      // Even an ineligible PR supplies detectors from its reviewed commit.
      // Resolve abbreviations once; the reviewed head never follows the forge.
      const head = git(work, ["rev-parse", `${pair.reviewed}^{commit}`]);
      const reviewBase = git(work, ["merge-base", base, head]);
      const row: BatchRow = { ...pair, head, reviewBase, view, patch: "", status: "head-moved", commit: "", paths: [], detail: "" };
      state.rows.push(row);
      if (view.state !== "OPEN" || view.isDraft || view.baseRefName !== "main" || !view.headRefOid.startsWith(pair.reviewed)) continue;
      if (git(work, ["rev-parse", "FETCH_HEAD"]) !== view.headRefOid) continue;
      row.patch = patchId(work, reviewBase, row.head);
      row.status = "clean";
    }
    await this.rebuild(state);
    return state;
  }

  private async rebuild(state: RunState): Promise<void> {
    this.assertTip(state);
    state.gated = null;
    state.gates = [];
    this.save(state);
    git(state.work, ["reset", "--hard", state.base]); // Only this run's owned worktree.
    for (const row of state.rows) {
      if (row.status !== "clean") continue;
      row.commit = "";
      row.paths = [];
      if (!await this.unchanged(row)) { row.status = "head-moved"; continue; }
      const previous = git(state.work, ["rev-parse", "HEAD"]);
      try { git(state.work, ["merge", "--squash", "--", row.head]); }
      catch (error) {
        const conflicts = git(state.work, ["diff", "--name-only", "--diff-filter=U"]);
        git(state.work, ["reset", "--hard", previous]);
        if (!conflicts) throw error;
        row.status = "deferred"; row.detail = "conflict";
        continue;
      }
      const applied = git(state.work, ["patch-id", "--stable"], git(state.work, ["diff", "--cached", "--binary", "-U0"]) + "\n").split(" ")[0];
      if (!row.patch || applied !== row.patch) {
        git(state.work, ["reset", "--hard", previous]);
        row.status = "deferred"; row.detail = "changed patch";
        continue;
      }
      const authors = git(state.work, ["rev-list", `${git(state.work, ["merge-base", state.base, row.head])}..${row.head}`])
        .split("\n").filter(Boolean).map((sha) => {
          const [name, email, message] = git(state.work, ["show", "-s", "--format=%an%x00%ae%x00%B", sha]).split("\0");
          return { name: name!, email: email!, message: message! };
        });
      let message: string;
      try { message = batchMessage(row.number, row.view.title, row.view.body, authors); }
      catch {
        git(state.work, ["reset", "--hard", previous]);
        row.status = "culprit";
        row.detail = "privacy: batch attribution refused";
        continue;
      }
      this.identity(state.work);
      git(state.work, ["commit", "-F", "-"], message);
      row.commit = git(state.work, ["rev-parse", "HEAD"]);
      row.paths = git(state.work, ["diff", "--name-only", "-z", previous, row.commit]).split("\0").filter(Boolean);
      row.status = "clean"; row.detail = "";
    }
    state.tip = git(state.work, ["rev-parse", "HEAD"]);
    this.save(state);
  }

  private async gateCommand(cwd: string, gate: Gate, testCorpus: false | Record<string, string> = false): Promise<CommandResult> {
    if (gate.id === "privacy") {
      const state = this.read();
      const baseIndex = gate.args.indexOf("--base");
      const base = baseIndex >= 0 ? gate.args[baseIndex + 1]! : state.base;
      return this.trustedPrivacy(state, ["--check-commits", "--require-known-values"], cwd, base);
    }
    let args = gate.args;
    // Stored runs may still have the former bunx command. Upgrade it without
    // dropping its first path. Use the driver's helper during bisect too:
    // the baseline commit may predate eslint-changes.ts entirely.
    if (gate.id === "eslint") {
      const modern = args[1] === "scripts/eslint-changes.ts";
      args = ["bun", join(import.meta.dir, "eslint-changes.ts"), "--base", modern ? args[3]! : this.read().base, ...args.slice(modern ? 4 : 3)];
    }
    const corpus = gate.id === "tests" && testCorpus ? testCorpus : undefined;
    if (gate.id === "tests" || gate.id === "eslint") {
      const prefix = gate.id === "tests" ? 2 : 4;
      let files = args.slice(prefix).filter((path) => existsSync(join(cwd, path)) && statSync(join(cwd, path)).isFile());
      if (corpus) files = args.slice(prefix).filter(path => Object.hasOwn(corpus, path.replace(/^\.\//, "")));
      if (!files.length) return gate.id === "tests" && args.length > prefix
        ? { code: 1, output: "Stable regression test corpus is unavailable at this bisect subject" }
        : { code: 0, output: "" };
      args = [...args.slice(0, prefix), ...files];
    }
    const stateDir = mkdtempSync(join("/var/tmp", "merge-gate-state-"));
    const backups = new Map<string, Buffer | null>();
    const createdDirectories: string[] = [];
    try {
      if (corpus) for (const path of args.slice(2).map(path => path.replace(/^\.\//, ""))) {
        const contents = corpus[path]!;
        const absolute = prepareCorpusPath(cwd, path, createdDirectories);
        backups.set(path, existsSync(absolute) ? readFileSync(absolute) : null);
        writeFileSync(absolute, Buffer.from(contents, "base64"));
      }
      const reportFile = join(stateDir, "tests.xml");
      if (gate.report) args = [...args, "--reporter=junit", "--reporter-outfile", reportFile];
      if (gate.filter) args = [...args, ...gate.filter];
      const env = gate.id === "tests" ? testEnvironment(stateDir) : process.env;
      const result = await this.gateRun(cwd, args, { ...env, LLV_STATE_DIR: stateDir });
      return gate.report ? { ...result, report: existsSync(reportFile) ? readFileSync(reportFile, "utf8") : result.report } : result;
    } finally {
      for (const [path, contents] of backups) {
        const absolute = join(cwd, path);
        if (contents === null) unlinkSync(absolute);
        else writeFileSync(absolute, contents);
      }
      for (const directory of createdDirectories.reverse()) rmdirSync(directory);
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  async bisectSubject(gate: Gate): Promise<CommandResult> {
    return this.gateCommand(this.read().work, gate);
  }

  private async culprit(state: RunState, gate: Gate): Promise<BatchRow> {
    git(state.work, ["checkout", "--detach", state.base]);
    try {
      if ((await this.gateCommand(state.work, gate)).code !== 0) throw new Error(`Baseline fails ${gate.id}; cannot attribute to a PR`);
    } finally { git(state.work, ["checkout", state.branch]); }
    const commandFile = join(dirname(this.stateFile), `merge-bisect-${randomUUID()}.json`);
    writeFileSync(commandFile, JSON.stringify({ stateFile: this.stateFile, repo: this.repo, gate }), { mode: 0o600 });
    try {
      git(state.work, ["bisect", "start", state.tip, state.base]);
      const result = await this.run(state.work, ["git", "bisect", "run", process.execPath, import.meta.path, "_bisect", commandFile]);
      if (result.code !== 0) throw new Error(`Bisect could not attribute ${gate.id}: ${result.output.slice(-4_000)}`);
      const bad = git(state.work, ["rev-parse", "refs/bisect/bad"]);
      const row = state.rows.find((entry) => entry.status === "clean" && entry.commit === bad);
      if (!row) throw new Error(`Bisect found no batch PR for ${gate.id}`);
      return row;
    } finally {
      git(state.work, ["bisect", "reset", state.branch]);
      rmSync(commandFile);
    }
  }

  /** Each file runs alone. A between-test error, a runner disagreement or a
   * missing report is recorded as that file's fault, never thrown: whether it
   * stops anything depends on what native main produced for the same file.
   * When a file cannot complete, the named `focus` cases run again by
   * themselves, together and then one by one if that aborts too, so a case
   * the file reached keeps its result whatever another named case does,
   * a namesake included (`only` skips the full run). Neither marks the file
   * completed. */
  private async testSample(cwd: string, files: string[], corpus: false | Record<string, string>,
    focus: { sites: TestSite[]; only?: boolean } = { sites: [] }): Promise<BatchTestRun> {
    const started = performance.now();
    const sample: BatchTestRun = { failures: [], passed: [], completed: [], elapsedMs: 0 };
    for (const file of files) {
      if (!focus.only) {
        const result = await this.gateCommand(cwd, { id: "tests", args: ["bun", "test", `./${file}`], report: true }, corpus);
        let parsed: ReturnType<typeof parseReport> | undefined;
        try { parsed = parseReport(result.report ?? "", result.output, file, cwd); }
        catch {
          // A complete JUnit report keeps its cases when only the console's
          // between-test diagnostics could not be read.
          try {
            parsed = parseReport(result.report ?? "", "", file, cwd);
            parsed.failures.push(fileFault(file, "<between-tests error> unidentified diagnostics"));
          } catch { sample.failures.push(fileFault(file, INCOMPLETE_FILE)); }
        }
        if (parsed) {
          if ((result.code === 0) !== (parsed.failures.length === 0)) parsed.failures.push(fileFault(file, `<runner exit ${result.code} disagrees with report>`));
          sample.failures.push(...parsed.failures); sample.passed.push(...parsed.passed); sample.completed.push(file);
          continue;
        }
      }
      const sites = focus.sites.filter(site => site.file === file && site.kind === "test");
      if (!sites.length) continue;
      // One named case that aborts must not erase another's result: when the
      // named cases cannot report together, each runs by itself.
      if (sites.length > 1 && await this.focusedSample(cwd, file, sites, corpus, sample)) continue;
      for (const site of sites) await this.focusedSample(cwd, file, [site], corpus, sample, true);
    }
    sample.elapsedMs = performance.now() - started;
    return sample;
  }

  /** Records the named cases' results only from a consistent report of them;
   * returns whether there was one. `alone` runs one case without its
   * namesakes: Bun filters by name only, so every occurrence of the name runs,
   * and a preload fails each one before its body except the case's own. */
  private async focusedSample(cwd: string, file: string, sites: TestSite[], corpus: false | Record<string, string>, sample: BatchTestRun,
    alone = false): Promise<boolean> {
    const run = async (executedIndex?: number) => {
      const guard = executedIndex === undefined ? undefined : join(dirname(this.stateFile), `merge-occurrence-${randomUUID()}.ts`);
      if (guard) writeFileSync(guard, `const { beforeEach } = require("bun:test");\nlet executed = 0;\n`
        + `beforeEach(() => { if (executed++ !== ${executedIndex}) throw new Error("merge-batch: a namesake of the case under test"); });\n`, { mode: 0o600 });
      try {
        const filter = [...testNameFilter(sites), ...guard ? [`--preload=${guard}`] : []];
        const result = await this.gateCommand(cwd, { id: "tests", args: ["bun", "test", `./${file}`], report: true, filter }, corpus);
        const parsed = parseReport(result.report ?? "", result.output, file, cwd, true);
        // Bun exits 1 when a filter matches nothing. Its complete JUnit still
        // lists registered cases, including skipped ones; retain their identities.
        const noMatch = result.code === 1 && !parsed.failures.length && !parsed.passed.length
          && /^error: regex "[^\n]*" matched 0 tests\. Searched 1 file \(skipping \d+ tests?\)/m.test(result.output);
        if ((!noMatch && (result.code === 0) !== (parsed.failures.length === 0)) || parsed.failures.some(site => site.kind !== "test")) return undefined;
        const occurrences = new Map<string, number>();
        const registered = [...result.report!.matchAll(/<testcase\b([^>]*?)(?:\/>|>)/g)].map(match => {
          const attrs = Object.fromEntries([...match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(attr => [attr[1]!, decodeXML(attr[2]!)]));
          const identity = JSON.stringify([attrs.classname ?? "", attrs.name]);
          const occurrence = occurrences.get(identity) ?? 0;
          occurrences.set(identity, occurrence + 1);
          return { file, suite: attrs.classname ?? "", name: attrs.name!, kind: "test" as const, occurrence };
        });
        return { ...parsed, registered };
      } finally { if (guard) rmSync(guard, { force: true }); }
    };
    try {
      if (alone) {
        const [site] = sites;
        const occurrence = site!.occurrence ?? 0;
        const executedCases = (parsed: { failures: TestSite[]; passed: TestSite[] }) => {
          const executed = [...parsed.failures, ...parsed.passed].sort((a, b) => (a.occurrence ?? 0) - (b.occurrence ?? 0));
          return executed.some(other => other.suite !== site!.suite || other.name !== site!.name) ? undefined : executed;
        };
        // JUnit numbers a skipped namesake while the preload counts only
        // executed cases. A probe that lets no body run tells them apart.
        const probe = await run(-1);
        if (probe && !probe.registered.some(other => testIdentity(other) === testIdentity(site!))) {
          (sample.absent ??= []).push(site!);
          return true;
        }
        const probed = probe && !probe.passed.length ? executedCases(probe) : undefined;
        const index = probed?.findIndex(other => other.occurrence === occurrence) ?? -1;
        if (index < 0) return false;
        const parsed = await run(index);
        const executed = parsed && executedCases(parsed);
        if (executed?.[index]?.occurrence !== occurrence) return false;
        (parsed!.failures.includes(executed[index]!) ? sample.failures : sample.passed).push(executed[index]!);
        return true;
      }
      const parsed = await run();
      if (!parsed) return false;
      const named = new Set(sites.map(testIdentity));
      sample.failures.push(...parsed.failures.filter(site => named.has(testIdentity(site))));
      sample.passed.push(...parsed.passed.filter(site => named.has(testIdentity(site))));
      // Missing cases need their own inventory probe: a skipped or aborting
      // namesake cannot certify absence for another requested case.
      return sites.every(site => [...parsed.failures, ...parsed.passed].some(other => testIdentity(other) === testIdentity(site)));
    } catch { return false; /* the named cases cannot complete: they stay unreported */ }
  }

  private async testSubject(state: RunState, files: string[], removed?: number[], stable: false | Record<string, string> = false,
    focus: { sites: TestSite[]; only?: boolean } = { sites: [] }): Promise<BatchTestRun> {
    const work = join(dirname(this.stateFile), `test-subject-${randomUUID()}`);
    git(state.work, ["worktree", "add", "--detach", work, state.base]);
    try {
      if (removed) for (const row of state.rows) {
        if (row.status !== "clean" || removed.includes(row.number)) continue;
        try { git(work, ["cherry-pick", row.commit], undefined, { ...process.env, LLV_SKIP_HOOKS: "1" }); }
        catch { throw new Error("Behaviour conflict while removing a PR; batch not gated"); }
      }
      const install = await this.gateCommand(work, { id: "dependencies", args: ["bun", "install", "--frozen-lockfile"] }, false);
      if (install.code) throw new Error(`${removed ? "PR removal" : "Baseline"} dependency gate cannot run; batch not gated`);
      const selected = stable ? files : files.filter(file => existsSync(join(work, file)) && statSync(join(work, file)).isFile());
      return await this.testSample(work, selected, stable, focus);
    } finally { git(state.work, ["worktree", "remove", "--force", work]); }
  }

  private treeTests(state: RunState, revision: string, paths: string[]): Record<string, string> {
    const entries = git(state.work, ["ls-tree", "-r", "-z", revision]).split("\0").filter(Boolean);
    const tree = new Map(entries.map(entry => {
      const tab = entry.indexOf("\t");
      return [entry.slice(tab + 1), entry.slice(0, tab)];
    }));
    const corpus: Record<string, string> = {};
    for (const file of touchedTests(paths, path => tree.has(path))) {
      const metadata = tree.get(file)!;
      if (!/^100(?:644|755) blob /.test(metadata)) throw new Error("Test file must be a regular tracked file");
      const blob = metadata.split(" ")[2]!;
      corpus[file] = execFileSync("git", ["cat-file", "blob", blob], { cwd: state.work, maxBuffer: 16 * 1024 * 1024 }).toString("base64");
    }
    return corpus;
  }

  private detectors(state: RunState, validation: Validation): Detector[] {
    // Scope comes from immutable reviewed patches plus this candidate's diff.
    // Never use row.paths: omissions reset them and can restore native tests.
    const changed = (base: string, head: string) => git(state.work, ["diff", "--name-only", "-z", base, head, "--"]).split("\0").filter(Boolean);
    const paths = [...new Set([...changed(state.base, state.tip),
      ...state.rows.flatMap(row => changed(row.reviewBase, row.head))])];
    const prs = validation.candidate.prs.map(pr => pr.number);
    const all: Detector[] = [{ source: "native candidate", corpus: this.treeTests(state, state.tip, paths) },
      ...state.rows.map(row => ({ source: `#${row.number}@${row.head}`, pr: row.number, corpus: this.treeTests(state, row.head, paths) }))];
    // Contents come only from immutable Git objects. Deduplication is local to
    // this validation; a rebuilt candidate starts with an empty set again.
    const seen = new Set<string>();
    const unseen = (detector: Detector) => Object.fromEntries(Object.entries(detector.corpus).filter(([file, contents]) => {
      const key = JSON.stringify([file, contents]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }));
    const member = (detector: Detector) => detector.pr === undefined || prs.includes(detector.pr);
    const active = all.filter(member).map(detector => ({ ...detector, corpus: unseen(detector) }));
    // A PR outside this candidate judges nothing in it: its test can import
    // code the candidate does not carry. Its native files still run above.
    for (const detector of all.filter(detector => !member(detector))) {
      for (const file of Object.keys(unseen(detector))) validation.notApplicable.push({ source: detector.source, file,
        reason: `#${detector.pr} is not in this candidate; its reviewed detector is skipped` });
    }
    if (!state.browser) for (const detector of active) for (const file of Object.keys(detector.corpus).filter(isBrowserTest)) {
      delete detector.corpus[file];
      validation.notApplicable.push({ source: detector.source, file, reason: "full browser campaign: opt in with gate --browser" });
    }
    for (const detector of active) {
      const row = state.rows.find(entry => entry.number === detector.pr);
      if (!row) continue;
      detector.stale = {};
      for (const file of Object.keys(detector.corpus)) {
        const reason = this.staleReason(state, row, file);
        if (reason) detector.stale[file] = reason;
      }
    }
    return active.filter(detector => Object.keys(detector.corpus).length);
  }

  /** A PR's reviewed tree carries every selected test file, including ones its
   * patch never touched. Such a copy is the PR's review base version; when main
   * changed the file after that base, it is stale. Files the PR changed keep
   * their reviewed rules. */
  private staleReason(state: RunState, row: BatchRow, file: string): string | undefined {
    const blob = (revision: string) => {
      try { return git(state.work, ["rev-parse", "--verify", "--quiet", `${revision}:${file}`]); } catch { return undefined; }
    };
    const reviewed = blob(row.head);
    if (reviewed === undefined || reviewed !== blob(row.reviewBase) || reviewed === blob(state.base)) return undefined;
    const [commit, subject = ""] = git(state.work, ["log", "--first-parent", "--reverse", "--format=%H%x00%s", `${row.reviewBase}..${state.base}`, "--", file])
      .split("\n")[0]!.split("\0");
    const number = /\(#(\d+)\)$/.exec(subject)?.[1];
    const named = commit ? `${commit.slice(0, 12)}${number ? ` (#${number})` : ""}` : "main";
    return `stale reviewed detector: branch predates ${named} that changed ${file}; merge main into the branch`;
  }

  private async validateTests(state: RunState, validation: Validation): Promise<boolean> {
    const detectors = this.detectors(state, validation);
    const files = [...new Set(detectors.flatMap(detector => Object.keys(detector.corpus)))];
    // Native main only: candidate-only files and assertions have no baseline
    // observations. This sample has no lifetime beyond this candidate tuple.
    const baseline = await this.testSubject(state, files);
    const prs = validation.candidate.prs.map(pr => pr.number);
    for (const detector of detectors) {
      const candidate = await this.testSample(state.work, Object.keys(detector.corpus), detector.corpus);
      const stale = (test: TestSite) => {
        const reason = detector.stale?.[test.file];
        return reason && detector.pr !== undefined ? { pr: detector.pr, reason } : undefined;
      };
      const decision = await attributeBatchTests(baseline, candidate, prs,
        files => this.testSample(state.work, files, detector.corpus),
        (removed, files, sites) => this.testSubject(state, files, removed, detector.corpus, { sites }),
        sites => this.testSubject(state, [...new Set(sites.map(site => site.file))], undefined, false, { sites, only: true }), stale);
      validation.decisions.push(decision);
      for (const entry of decision.attributed) state.attributionLog.push({ ...entry, candidate: validation.candidate, source: detector.source });
      for (const entry of decision.stale ?? []) state.attributionLog.push({ ...entry, candidate: validation.candidate, source: detector.source, stale: true });
      for (const row of state.rows) {
        if (row.status !== "clean") continue;
        const failures = decision.attributed.filter(entry => entry.prs.includes(row.number));
        if (failures.length) {
          row.status = "culprit";
          row.detail = failures.map(entry => `${entry.reason}: ${entry.test.file} > ${entry.test.suite} > ${entry.test.name}`).join("; ");
          continue;
        }
        // A stale copy indicts no change of the PR: it waits for main to be merged into its branch.
        const reasons = [...new Set((decision.stale ?? []).filter(entry => entry.prs.includes(row.number)).map(entry => entry.reason))];
        if (!reasons.length) continue;
        row.status = "deferred";
        row.detail = reasons.join("; ");
      }
      this.save(state);
      if (decision.attributed.length || decision.stale?.length) return false;
    }
    return true;
  }

  async gate(options?: { browser?: boolean }): Promise<RunState> {
    const state = this.read();
    this.assertTip(state);
    if (options) state.browser = options.browser === true;
    while (true) {
      // Nothing from an earlier iteration can certify this tuple. The only
      // durable evidence is a receipt written after every gate completes.
      state.gated = null;
      state.gates = localGateCommands(state.work, state.base);
      this.save(state);
      const validation: Validation = { candidate: candidateOf(state), tip: state.tip, decisions: [], notApplicable: [] };
      let retry = false;
      for (const gate of state.gates) {
        if (gate.id === "tests") continue;
        const result = await this.gateCommand(state.work, gate);
        if (!result.code) continue;
        if (gate.id === "dependencies" || gate.id === "tsc") throw new Error(`${gate.id} gate cannot run; batch not gated`);
        const row = await this.culprit(state, gate);
        row.status = "culprit"; row.detail = `${gate.id}: first failing batch commit`;
        retry = true; break;
      }
      if (retry || !await this.validateTests(state, validation)) {
        await this.rebuild(state); continue;
      }
      // Heads can move while a gate runs. The snapshot remains reviewed, but
      // this tuple is void when any member becomes ineligible.
      if (await this.stale(state)) { await this.rebuild(state); continue; }
      this.assertTip(state);
      if (!sameCandidate(validation.candidate, candidateOf(state))) throw new Error("Candidate changed during validation");
      state.gated = validation;
      this.save(state); return state;
    }
  }

  private body(state: RunState): string {
    const rows = state.rows.filter((row) => row.status === "clean");
    const issues = [...new Set(rows.flatMap((row) => row.view.closingIssuesReferences.map((issue) => issue.number)))];
    return ["Reviewed patches, one commit per pull request.", ...rows.map((row) => `- #${row.number} at ${row.head}`),
      "", ...issues.map((number) => `Closes #${number}`)].join("\n");
  }

  private async trustedPrivacy(state: RunState, args: string[], candidate = state.work, base = state.base): Promise<CommandResult> {
    const trustedWork = join(dirname(this.stateFile), `privacy-main-${randomUUID()}`);
    const stateDir = mkdtempSync(join("/var/tmp", "merge-privacy-state-"));
    let worktreeAdded = false;
    try {
      git(state.work, ["worktree", "add", "--detach", trustedWork, base]);
      worktreeAdded = true;
      const modules = join(this.repo, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, join(trustedWork, "node_modules"), "dir");
      const catalog = join(trustedWork, "scripts/privacy-known-value-fingerprints.json");
      return await this.gateRun(trustedWork, ["bun", "scripts/privacy-publication-gate.ts",
        "--repository", candidate, "--base", base, ...args], {
        ...process.env,
        LLV_STATE_DIR: stateDir,
        LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: catalog,
      });
    } finally {
      try {
        if (worktreeAdded) git(state.work, ["worktree", "remove", "--force", trustedWork]);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }

  private async publish(state: RunState): Promise<boolean> {
    this.assertValidated(state);
    const title = `Merge batch: ${state.rows.filter((row) => row.status === "clean").map((row) => `#${row.number}`).join(", ")}`;
    const bodyFile = join(dirname(this.stateFile), "merge-batch-body.md");
    writeFileSync(bodyFile, this.body(state), { mode: 0o600 });
    // Recheck the exact candidate and public body with the pinned main scanner
    // immediately before any push or PR edit.
    const candidatePrivacy = await this.trustedPrivacy(state, ["--check-commits", "--require-known-values"]);
    if (candidatePrivacy.code) throw new Error("Batch failed the trusted publication gate");
    const bodyPrivacy = await this.trustedPrivacy(state, ["--require-known-values", "--paths", bodyFile]);
    if (bodyPrivacy.code) throw new Error("Batch PR body failed the publication gate");
    if (await this.stale(state)) return false;
    this.assertValidated(state);
    const push = ["push", ...(state.published ? [`--force-with-lease=refs/heads/${state.branch}:${state.published}`] : []),
      "origin", `${state.tip}:refs/heads/${state.branch}`];
    // Main's trusted scanner has already checked the exact candidate and body.
    git(state.work, push, undefined, { ...process.env, LLV_SKIP_HOOKS: "1" });
    state.published = state.tip;
    this.save(state);
    if (!state.batch) {
      const url = (await this.gh(["pr", "create", "--base", "main", "--head", state.branch, "--title", title, "--body-file", bodyFile])).trim();
      if (!/^https:\/\/[^\s]+\/pull\/[1-9]\d*$/.test(url)) throw new Error("Invalid batch PR URL");
      state.batch = { number: Number(url.split("/").at(-1)), url };
    } else {
      await this.gh(["pr", "edit", String(state.batch.number), "--title", title, "--body-file", bodyFile]);
    }
    this.save(state);
    return true;
  }

  private async refresh(state: RunState): Promise<RunState> {
    state.refreshes = nextRefresh(state.refreshes);
    this.assertTip(state);
    git(state.work, ["fetch", "origin", "main"]);
    const base = git(state.work, ["rev-parse", "origin/main"]);
    state.base = base;
    // Reclassify against the original reviewed patches, including clean rebases.
    await this.rebuild(state);
    return this.gate();
  }

  private async traceRequiredFailure(state: RunState, required: string[], checks: Check[]): Promise<void> {
    const red = checks.filter((check) => required.includes(check.name ?? check.context ?? "")
      && requiredVerdict([check.name ?? check.context!], [check]) === "red");
    const culprits = new Set<number>();
    for (const check of red) {
      const run = /\/actions\/runs\/(\d+)/.exec(check.detailsUrl ?? "");
      if (!run) throw new Error("Red required check has no readable workflow log; nothing merged");
      const log = await this.gh(["run", "view", run[1]!, "--log-failed"]);
      const attributed = noticePrs(log, state.rows.filter((row) => row.status === "clean"), (path, line) => {
        if (path.startsWith("/") || path.split("/").includes("..")) return undefined;
        try {
          const blame = git(state.work, ["blame", "--line-porcelain", "-L", `${line},${line}`, "--", path]);
          return /^([a-f0-9]{40})\s/.exec(blame)?.[1];
        } catch { return undefined; }
      });
      if (!attributed.length) throw new Error("Red required check names no batch commit or path; nothing merged");
      for (const number of attributed) {
        culprits.add(number);
        const row = state.rows.find((entry) => entry.number === number)!;
        row.detail = `${check.name ?? check.context}: log names its commit or changed path`;
      }
    }
    if (!culprits.size) throw new Error("Required failure could not be attributed; nothing merged");
    for (const row of state.rows) if (culprits.has(row.number)) row.status = "culprit";
    await this.rebuild(state);
  }

  async land(): Promise<RunState> {
    let state = this.read();
    if (state.landed) { await this.closeOriginals(state); return state; }
    this.assertValidated(state);
    if (state.mergeIntent === state.tip && state.batch) {
      const outcome = JSON.parse(await this.gh(["pr", "view", String(state.batch.number), "--json", BATCH_FIELDS])) as { state: string; headRefOid: string };
      if (outcome.state === "MERGED" && outcome.headRefOid === state.tip) return this.recordLanding(state);
    }
    const repository = (await this.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository response");
    const protection = JSON.parse(await this.gh(["api", `repos/${repository}/branches/main`])) as {
      protection?: { required_status_checks?: { contexts?: string[]; checks?: { context: string }[] } };
    };
    const required = [...new Set([...(protection.protection?.required_status_checks?.contexts ?? []),
      ...(protection.protection?.required_status_checks?.checks ?? []).map((check) => check.context)])];
    if (!required.length) throw new Error("Cannot establish required checks from branch protection");
    for (let poll = 0; poll < MAX_REQUIRED_CHECK_POLLS; poll++) {
      const clean = state.rows.filter((row) => row.status === "clean");
      if (!clean.length) {
        if (state.batch) await this.gh(["pr", "close", String(state.batch.number), "--comment", "Batch empty after attribution; nothing merged."]);
        state.landed = true; this.save(state); return state;
      }
      if (await this.stale(state)) { await this.rebuild(state); state = await this.gate(); continue; }
      await this.assertMachineForgePrincipal(repository);
      if (state.published !== state.tip || !state.batch) {
        if (!await this.publish(state)) { await this.rebuild(state); state = await this.gate(); continue; }
      }
      const view = JSON.parse(await this.gh(["pr", "view", String(state.batch!.number), "--json", BATCH_FIELDS])) as {
        state: string; headRefOid: string; mergeStateStatus: string; statusCheckRollup: Check[];
      };
      if (view.state === "MERGED" && view.headRefOid === state.tip && state.mergeIntent === state.tip) {
        return this.recordLanding(state);
      }
      if (view.headRefOid !== state.tip || view.state !== "OPEN") throw new Error("Batch PR changed outside this run");
      if (view.mergeStateStatus === "BEHIND") { state = await this.refresh(state); continue; }
      const verdict = requiredVerdict(required, view.statusCheckRollup ?? []);
      if (verdict === "red") { await this.traceRequiredFailure(state, required, view.statusCheckRollup); state = await this.gate(); continue; }
      if (verdict === "green" && ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(view.mergeStateStatus)) {
        // Last read of originals immediately precedes the exact-head merge.
        await this.assertMachineForgePrincipal(repository);
        if (await this.stale(state)) { await this.rebuild(state); state = await this.gate(); continue; }
        this.assertValidated(state);
        state.mergeIntent = state.tip; this.save(state);
        try { await this.gh(["pr", "merge", String(state.batch!.number), "--repo", `https://github.com/${repository}`, "--rebase", "--match-head-commit", state.tip]); }
        catch (error) {
          const outcome = JSON.parse(await this.gh(["pr", "view", String(state.batch!.number), "--json", BATCH_FIELDS])) as { state: string; headRefOid: string };
          if (outcome.state === "MERGED" && outcome.headRefOid === state.tip) return this.recordLanding(state);
          git(state.work, ["fetch", "origin", "main"]);
          if (git(state.work, ["rev-parse", "origin/main"]) !== state.base) { state = await this.refresh(state); continue; }
          throw error;
        }
        return this.recordLanding(state);
      }
      await this.sleep();
    }
    throw new Error("Required checks did not settle within the polling bound");
  }

  private async recordLanding(state: RunState): Promise<RunState> {
    const clean = state.rows.filter((row) => row.status === "clean");
    // GitHub rebases identities and SHAs; map the contiguous landed chain
    // from the batch mergeCommit, verifying every original patch again.
    const merged = JSON.parse(await this.gh(["pr", "view", String(state.batch!.number), "--json", "state,mergeCommit"])) as {
      state: string; mergeCommit: { oid: string } | null;
    };
    if (merged.state !== "MERGED" || !merged.mergeCommit?.oid) throw new Error("Batch merge did not settle");
    git(state.work, ["fetch", "origin", "main"]);
    const tip = merged.mergeCommit.oid;
    git(state.work, ["merge-base", "--is-ancestor", tip, "origin/main"]);
    const commits = git(state.work, ["rev-list", "--first-parent", "--max-count", String(clean.length), tip]).split("\n").reverse();
    for (let index = 0; index < clean.length; index++) {
      const sha = commits[index]!;
      if (patchId(state.work, `${sha}^`, sha) !== clean[index]!.patch) throw new Error("Landed patch cannot be mapped to the original PR");
    }
    clean.forEach((row, index) => { row.status = "merged"; row.commit = commits[index]!; });
    state.landed = true; this.save(state);
    await this.closeOriginals(state);
    return state;
  }

  private async closeOriginals(state: RunState): Promise<void> {
    for (const row of state.rows.filter((row) => row.status === "merged" && row.detail !== "closed")) {
      // A moved original contains new work; its landing receipt stays in the
      // report, but that PR must remain open for its next review.
      if (!await this.unchanged(row)) { row.detail = "head moved after landing; original kept open"; this.save(state); continue; }
      await this.gh(["pr", "close", String(row.number), "--comment", `Landed on main as ${row.commit} through #${state.batch!.number}. ${state.batch!.url}`]);
      row.detail = "closed"; this.save(state);
    }
  }

  async resolve(number: number): Promise<RunState> {
    const state = this.read();
    if (!state.landed) throw new Error("Resolve deferred PRs only after the batch has landed or become empty");
    const row = state.rows.find((entry) => entry.number === number);
    if (!row || row.status !== "deferred") throw new Error("PR is not a deferred member of this batch");
    if (!await this.unchanged(row)) { row.status = "head-moved"; this.save(state); return state; }
    if (state.resolving && state.resolving.number !== number) throw new Error("Finish the current resolution first");
    if (row.resolution && state.resolving) {
      if (git(state.resolving.work, ["rev-parse", "HEAD"]) !== row.resolution) throw new Error("Resolution head changed outside this run");
      if (git(state.resolving.work, ["diff", "--name-only"])) throw new Error("Stage resolution repairs before continuing");
      if (git(state.resolving.work, ["diff", "--cached", "--name-only"])) {
        // This resolution has never been pushed. Original history and its
        // reviewed parent remain intact while the merger repairs its own work.
        this.identity(state.resolving.work);
        git(state.resolving.work, ["commit", "--amend", "--no-edit"]);
        row.resolution = git(state.resolving.work, ["rev-parse", "HEAD"]);
        this.save(state);
      }
      return this.finishResolution(state, row, state.resolving.work, state.resolving.main);
    }
    if (!state.resolving) {
      git(state.work, ["fetch", "origin", "main"]);
      const main = git(state.work, ["rev-parse", "origin/main"]);
      const root = mkdtempSync(join(dirname(this.stateFile), "merge-resolution-"));
      const work = join(root, "checkout");
      git(this.repo, ["worktree", "add", "--detach", work, row.head]);
      state.resolving = { number, work, main };
      this.save(state);
      try { git(work, ["merge", "--no-commit", "--no-ff", main]); }
      catch (error) {
        if (!git(work, ["diff", "--name-only", "--diff-filter=U"])) throw error;
        return state; // The merger agent stages its resolution, then calls again.
      }
    }
    const { work, main } = state.resolving;
    if (git(work, ["diff", "--name-only", "--diff-filter=U"])) return state;
    if (git(work, ["diff", "--name-only"])) throw new Error("Stage the resolved files before continuing");
    if (git(work, ["rev-parse", "HEAD"]) !== row.head) throw new Error("Resolution worktree head changed outside this run");
    if (!existsSync(git(work, ["rev-parse", "--git-path", "MERGE_HEAD"]))) {
      throw new Error("No merge resolution exists; the deferred patch needs a new implementation and review");
    }
    this.identity(work);
    const message = batchMessage(number, `Resolve main for ${row.view.title}`, "Return this resolution to independent review.", []);
    git(work, ["commit", "-F", "-"], message);
    row.resolution = git(work, ["rev-parse", "HEAD"]);
    this.save(state);
    return this.finishResolution(state, row, work, main);
  }

  private async finishResolution(state: RunState, row: BatchRow, work: string, main: string): Promise<RunState> {
    if (git(work, ["status", "--porcelain"])) throw new Error("Resolution is not clean");
    git(work, ["merge-base", "--is-ancestor", row.head, "HEAD"]);
    git(work, ["merge-base", "--is-ancestor", main, "HEAD"]);
    delete row.resolutionTests;
    this.save(state);
    for (const gate of localGateCommands(work, main, state.browser)) {
      if (gate.id === "tests") {
        const files = gate.args.slice(2).map(file => file.replace(/^\.\//, ""));
        // The batch's base may predate the main merged into this resolution.
        // Reuse its native subject and isolated per-file sampler at this main.
        const subject = { ...state, work, base: main };
        const baseline = await this.testSubject(subject, files);
        const candidate = await this.testSample(work, files, false);
        const comparison = await confirmBatchTests(baseline, candidate,
          files => this.testSample(work, files, false),
          sites => this.testSubject(subject, [...new Set(sites.map(site => site.file))], undefined, false, { sites, only: true }));
        row.resolutionTests = { main, tip: row.resolution!, files, ...comparison };
        this.save(state);
        if (comparison.confirmed.length) throw new Error("Resolution failed tests; no branch pushed");
        if (comparison.decision.uncompared?.length) throw new Error("Resolution test comparison incomplete; no branch pushed");
        continue;
      }
      const result = await this.gateCommand(work, gate, false);
      if (result.code) throw new Error(`Resolution failed ${gate.id}; no branch pushed`);
    }
    if (!await this.unchanged(row)) { row.status = "head-moved"; this.save(state); return state; }
    const repository = (await this.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository response");
    const remote = (await this.gh(["api", `repos/${repository}/pulls/${row.number}`, "--jq", ".head.repo.clone_url"])).trim();
    if (!remote || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote)) throw new Error("PR branch repository unavailable");
    git(work, ["check-ref-format", `refs/heads/${row.view.headRefName}`]);
    // Explicit expected head plus normal push keeps this strictly fast-forward.
    const current = git(work, ["ls-remote", remote, `refs/heads/${row.view.headRefName}`]).split(/\s/)[0];
    if (current !== row.head) { row.status = "head-moved"; this.save(state); return state; }
    // The exact resolution passed the trusted main publication gates above.
    git(work, ["push", remote, `${row.resolution}:refs/heads/${row.view.headRefName}`], undefined,
      { ...process.env, LLV_SKIP_HOOKS: "1" });
    row.status = "needs-review";
    delete state.resolving;
    this.save(state);
    return state;
  }
}

function testDecisionReport(decisions: BatchTestDecision[], log: AttributionRecord[]): string[] {
  const describe = (site: TestSite) => `${site.file} > ${site.suite} > ${site.name}${site.occurrence ? ` [occurrence ${site.occurrence}]` : ""}`.replace(/[\r\n]/g, " ");
  const existing = new Map(decisions.flatMap(decision => decision.preExisting).map(site => [testIdentity(site), site]));
  const intermittent = new Map(decisions.flatMap(decision => decision.intermittent).map(site => [testIdentity(site), site]));
  const uncompared = new Map(decisions.flatMap(decision => decision.uncompared ?? []).map(site => [testIdentity(site), site]));
  const attributed = log.filter(entry => !entry.stale), stale = log.filter(entry => entry.stale);
  const evidence = (entry: AttributionRecord) => `${entry.prs.map(number => `#${number}`).join(", ")}: ${entry.reason}: ${describe(entry.test)}; candidate failed; confirmations ${entry.confirmation.join(", ")}; `
    + entry.removals.map(sample => `without ${sample.removed.map(number => `#${number}`).join(", ") || "none"}: ${sample.outcome}`).join("; ") + `; established on ${JSON.stringify(entry.candidate)} (${entry.source})`;
  return [
    "", "Pre-existing failures (permitted):", ...[...existing.values()].map(site => `- ${describe(site)}`),
    "", "Intermittent failures (permitted):", ...[...intermittent.values()].map(site => `- ${describe(site)}`),
    "", "Not compared (native main could not complete the file):", ...[...uncompared.values()].map(site => `- ${describe(site)}`),
    "", "Attributed failures (rule: a removal clears them; only the PRs it narrows to are held):", ...attributed.map(entry => `- ${evidence(entry)}`),
    "", "Stale reviewed detectors (rule: the PR did not change the file and main changed it after the PR's base; only that PR is deferred):",
    ...stale.map(entry => `- ${evidence(entry)}`),
  ];
}

export function report(state: RunState): string {
  return ["| PR | Result |", "| --- | --- |", ...state.rows.map((row) => {
    const result = row.status === "merged" ? `merged ${row.commit}` : row.status === "needs-review" ? `needs-review ${row.resolution}`
      : row.status === "culprit" ? `culprit ${row.detail}` : row.status === "deferred" ? `needs-review pending resolution (${row.detail})`
      : row.status === "head-moved" ? "left: reviewed head moved or is ineligible" : "left: awaiting local gate or publication";
    return `| #${row.number} | ${result.replace(/[\r\n]/g, " ").replaceAll("|", "\\|")} |`;
  }), ...testDecisionReport(state.gated?.decisions ?? [], state.attributionLog ?? []),
    ...state.rows.flatMap(row => row.resolutionTests ? [
      "", `Resolution #${row.number}: ${row.resolutionTests.tip}; native main ${row.resolutionTests.main}; per-file comparison:`,
      ...row.resolutionTests.files.map(file => `- ${file}`),
      ...testDecisionReport([row.resolutionTests.decision], []),
      "", row.resolutionTests.confirmed.length ? "New resolution failures (publication withheld):" : "New resolution failures: none",
      ...row.resolutionTests.confirmed.map(entry =>
        `- ${entry.test.file} > ${entry.test.suite} > ${entry.test.name}; confirmations ${entry.confirmation.join(", ")}`.replace(/[\r\n]/g, " ")),
      ...(row.resolutionTests.decision.uncompared?.length ? ["", "Unresolved resolution failures (publication withheld):",
        ...row.resolutionTests.decision.uncompared.map(site =>
          `- ${site.file} > ${site.suite} > ${site.name}; native main did not establish a result or absence`.replace(/[\r\n]/g, " "))] : []),
    ] : []),
    "", "Skipped test files:", ...(state.gated?.notApplicable ?? []).map(entry => `- ${entry.source}: ${entry.file}: ${entry.reason}`), ...(state.batch ? ["", state.batch.url] : [])].join("\n");
}

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2);
  if (command === "_bisect") {
    try {
      const spec = JSON.parse(readFileSync(argument!, "utf8")) as { repo: string; stateFile: string; gate: Gate };
      const result = await new MergeBatch(spec.repo, spec.stateFile).bisectSubject(spec.gate);
      process.exit(result.code === 0 ? 0 : result.code >= 127 ? 125 : 1);
    } catch { process.exit(125); }
  } else {
    const stateFile = join(process.env.TMPDIR ?? tmpdir(), "merge-batch.json");
    const lock = `${stateFile}.lock`;
    let held = false;
    try {
      mkdirSync(lock); held = true;
      const batch = new MergeBatch(process.cwd(), stateFile);
      let state: RunState;
      if (command === "build" && argument) state = await batch.build(argument);
      else if (command === "gate" && (!argument || argument === "--browser")) state = await batch.gate({ browser: argument === "--browser" });
      else if (command === "land") state = await batch.land();
      else if (command === "resolve" && /^[1-9]\d*$/.test(argument ?? "")) state = await batch.resolve(Number(argument));
      else throw new Error("Usage: merge-batch.ts build N@sha,... | gate [--browser] | land | resolve N");
      process.stdout.write(report(state) + "\n");
    } catch (error) {
      // Child-process failures may carry secret-bearing stdout/arguments.
      process.stderr.write(error instanceof Error && !('stdout' in error) ? `${error.message}\n` : "Batch command failed; inspect the private worktree and run state.\n");
      process.exitCode = 1;
    } finally { if (held) rmSync(lock, { recursive: true }); }
  }
}
