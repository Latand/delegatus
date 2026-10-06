import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync, unlinkSync, lstatSync, rmdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { GithubRunner } from "../src/lib/monitor/githubEvidence";
import { parseReport, type TestRun, type TestSite } from "./local-gate-tests";
import { isolatedEnvironment } from "./local-gate";
import ts from "typescript";

/** Positive proof for the narrow case where a test cannot observe project code
 * or data. Anything beyond literal assertions needs passing removal evidence.
 */
export function literalAssertionFile(contents: string): boolean {
  const source = ts.createSourceFile("candidate.test.ts", contents, ts.ScriptTarget.Latest, true);
  const bindings = new Set<string>();
  let assertions = 0;
  const literal = (node: ts.Expression): boolean => ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
    || (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)
      && ts.isNumericLiteral(node.operand));
  const assertion = (node: ts.Expression): boolean => {
    if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !literal(node.arguments[0]!)) return false;
    const matcher = node.expression;
    if (!ts.isPropertyAccessExpression(matcher) || !["toBe", "toEqual", "toStrictEqual"].includes(matcher.name.text)) return false;
    const expect = matcher.expression;
    if (!ts.isCallExpression(expect) || !ts.isIdentifier(expect.expression) || expect.expression.text !== "expect"
      || expect.arguments.length !== 1 || !literal(expect.arguments[0]!)) return false;
    assertions++;
    return true;
  };
  for (const statement of source.statements) {
    let names: string[] | undefined;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "bun:test") {
      const clause = statement.importClause;
      if (!clause || clause.name || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
      if (clause.namedBindings.elements.some(element => element.propertyName || element.isTypeOnly)) return false;
      names = clause.namedBindings.elements.map(element => element.name.text);
    } else if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      if (statement.declarationList.declarations.length !== 1) return false;
      const { name, initializer } = statement.declarationList.declarations[0]!;
      if (!ts.isObjectBindingPattern(name) || !initializer || !ts.isCallExpression(initializer)
        || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== "require"
        || initializer.arguments.length !== 1 || !ts.isStringLiteral(initializer.arguments[0]!)
        || initializer.arguments[0]!.text !== "bun:test") return false;
      if (name.elements.some(element => element.propertyName || element.initializer || element.dotDotDotToken || !ts.isIdentifier(element.name))) return false;
      names = name.elements.map(element => element.name.getText(source));
    } else {
      if (!bindings.has("test") || !bindings.has("expect") || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
      const call = statement.expression;
      const callee = ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "skip" ? call.expression.expression : call.expression;
      if (!ts.isIdentifier(callee) || callee.text !== "test" || call.arguments.length !== 2 || !ts.isStringLiteral(call.arguments[0]!)) return false;
      const callback = call.arguments[1]!;
      if (!ts.isArrowFunction(callback) || callback.parameters.length || callback.modifiers?.length) return false;
      if (ts.isBlock(callback.body)) {
        if (!callback.body.statements.length || !callback.body.statements.every(item => ts.isExpressionStatement(item) && assertion(item.expression))) return false;
      } else if (!assertion(callback.body)) return false;
    }
    if (names) for (const name of names) {
      if (!["test", "expect"].includes(name) || bindings.has(name)) return false;
      bindings.add(name);
    }
  }
  return assertions > 0;
}

const testIdentity = (site: TestSite) => JSON.stringify([site.file, site.suite, site.name, site.occurrence ?? 0]);
export function compareBatchTests(base: TestRun, candidate: TestRun) {
  for (const [label, run] of [["baseline", base], ["candidate", candidate]] as const) {
    if (run.failures.some(site => site.kind === "error")) throw new Error(`${label}: between-test error; batch not gated`);
  }
  const failed = new Set(base.failures.map(testIdentity));
  return {
    preExisting: candidate.failures.filter(site => failed.has(testIdentity(site))),
    introduced: candidate.failures.filter(site => !failed.has(testIdentity(site))),
  };
}

export const MAX_TEST_CONFIRMATIONS = 3;
export const MAX_TEST_CONFIRMATION_RUNS = MAX_TEST_CONFIRMATIONS * 2;
type NativeTestSample = { run: TestRun; absent: boolean };
type TestObservation = { removed: number[]; outcome: "pass" | "fail" | "absent"; corpus?: "native" };
export type TestAttribution = {
  test: TestSite; prs: number[]; reason: string; confirmation: ("pass" | "fail")[]; removals: TestObservation[];
};
export type BatchTestDecision = {
  preExisting: TestSite[]; intermittent: TestSite[]; attributed: TestAttribution[];
};
function observed(run: TestRun, test: TestSite, label: string): "pass" | "fail" {
  if (run.failures.some(site => site.kind === "error")) throw new Error(`${label}: between-test error; batch not gated`);
  if (!run.completed.includes(test.file)) throw new Error(`${label}: incomplete test file; batch not gated`);
  if (run.failures.some(site => testIdentity(site) === testIdentity(test))) return "fail";
  if (run.passed.some(site => testIdentity(site) === testIdentity(test))) return "pass";
  throw new Error(`${label}: missing or skipped test; absence is not passing evidence`);
}

/** Recorded results drive the decision; callbacks supply fresh file samples. */
export async function attributeBatchTests(base: TestRun, candidate: TestRun, prs: number[],
  rerun: (files: string[]) => Promise<TestRun>, without: (removed: number[], files: string[]) => Promise<TestRun>,
  native?: { owners: (test: TestSite) => number[]; independent: (test: TestSite) => boolean;
    without: (removed: number[], test: TestSite) => Promise<NativeTestSample> }): Promise<BatchTestDecision> {
  const comparison = compareBatchTests(base, candidate);
  const decision: BatchTestDecision = { preExisting: comparison.preExisting, intermittent: [], attributed: [] };
  const pending = new Map(comparison.introduced.map(test => [testIdentity(test), { test, confirmation: [] as ("pass" | "fail")[] }]));
  const files = [...new Set(comparison.introduced.map(test => test.file))];
  if (!files.length) return decision;
  for (let round = 0; round < MAX_TEST_CONFIRMATION_RUNS; round++) {
    const run = await rerun(files);
    const discovered = compareBatchTests(base, run);
    for (const test of discovered.preExisting) {
      if (!decision.preExisting.some(site => testIdentity(site) === testIdentity(test))) decision.preExisting.push(test);
    }
    for (const entry of pending.values()) {
      const outcome = observed(run, entry.test, "candidate confirmation");
      entry.confirmation.push(outcome);
    }
    for (const test of discovered.introduced) {
      if (!pending.has(testIdentity(test))) pending.set(testIdentity(test), { test, confirmation: [] });
    }
    if ([...pending.values()].every(entry => entry.confirmation.length >= MAX_TEST_CONFIRMATIONS)) break;
  }
  if ([...pending.values()].some(entry => entry.confirmation.length < MAX_TEST_CONFIRMATIONS)) {
    throw new Error("Candidate confirmation budget exhausted with unclassified failures; batch not gated");
  }
  const confirmed = [...pending.values()].map(entry => entry.test).filter(test => {
    if (pending.get(testIdentity(test))!.confirmation.includes("pass")) { decision.intermittent.push(test); return false; }
    return true;
  });
  if (!confirmed.length) return decision;
  const affected = [...new Set(confirmed.map(test => test.file))];
  const removals: { removed: number[]; run: TestRun }[] = [];
  for (const pr of prs) removals.push({ removed: [pr], run: await without([pr], affected) });
  for (const test of confirmed) {
    const evidence: TestObservation[] = removals.map(entry => ({ removed: entry.removed, outcome: observed(entry.run, test, "PR removal") }));
    let responsible = evidence.filter(entry => entry.outcome === "pass").map(entry => entry.removed[0]!);
    let reason = responsible.length === 1 ? "test regression" : "integration: needs both";
    if (!responsible.length) {
      // Several independent changes can keep the same assertion red after each
      // single removal. Find a minimal clearing removal set, retaining unrelated
      // PRs. This costs at most one all-removed sample plus one sample per PR.
      responsible = [...prs];
      const all = await without(responsible, [test.file]);
      const outcome = observed(all, test, "combined PR removal");
      evidence.push({ removed: [...responsible], outcome });
      if (outcome !== "pass") {
        // Native absence identifies authorship only. A new feature's healthy
        // detector can also fail when its implementation is entirely removed.
        // Require independent proof that the test cannot observe that code.
        const owners = native?.owners(test).filter(pr => prs.includes(pr)) ?? [];
        if (!owners.length) throw new Error("Integration failure persists without any PR; cannot establish attribution");
        if (!native!.independent(test)) throw new Error(`Insufficient test-change attribution for ${test.file} > ${test.name}; detector retained; batch not gated`);
        const nativeOutcome = async (removed: number[]) => {
          const sample = await native!.without(removed, test);
          // Absence comes from the native subject's complete test inventory.
          // Skipped assertions remain present and provide no passing evidence.
          if (sample.run.failures.some(site => site.kind === "error")) throw new Error("Native PR removal: between-test error; batch not gated");
          const outcome = sample.absent ? "absent" : observed(sample.run, test, "native PR removal");
          evidence.push({ removed: [...removed], outcome, corpus: "native" });
          return outcome;
        };
        responsible = [...owners];
        if (await nativeOutcome(responsible) === "fail") throw new Error("Native test failure persists without its authors; cannot establish attribution");
        for (const pr of owners) {
          const removed = responsible.filter(number => number !== pr);
          if (await nativeOutcome(removed) !== "fail") responsible = removed;
        }
        if (!responsible.length) throw new Error("Native test failure is intermittent; cannot establish test-change attribution");
        reason = responsible.length === 1 ? "test change regression" : "integration: needs both; test change regression";
      } else {
        for (const pr of prs) {
          const removed = responsible.filter(number => number !== pr);
          const outcome = observed(await without(removed, [test.file]), test, "combined PR removal");
          evidence.push({ removed, outcome });
          if (outcome === "pass") responsible = removed;
        }
      }
    }
    decision.attributed.push({ test, prs: responsible, reason,
      confirmation: pending.get(testIdentity(test))!.confirmation, removals: evidence });
  }
  return decision;
}

export type ReviewedPr = { number: number; reviewed: string };
export type Candidate = { main: string; prs: { number: number; head: string }[] };
export function candidateOf(state: Pick<RunState, "base" | "rows">): Candidate {
  return { main: state.base, prs: state.rows.filter(row => row.status === "clean").map(row => ({ number: row.number, head: row.head })) };
}
const sameCandidate = (a: Candidate, b: Candidate) => JSON.stringify(a) === JSON.stringify(b);
type Detector = { source: string; pr?: number; corpus: Record<string, string> };
type NotApplicable = { source: string; file: string; reason: string };
type AttributionRecord = TestAttribution & { candidate: Candidate; source: string };
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
  head: string; view: PrView; patch: string; status: "clean" | "deferred" | "culprit" | "head-moved" | "merged" | "needs-review";
  commit: string; paths: string[]; detail: string; resolution?: string;
};
export type Gate = { id: string; args: string[]; report?: boolean };
export type RunState = {
  version: 2; repo: string; work: string; branch: string; base: string; tip: string;
  rows: BatchRow[]; gated: Validation | null; batch: { number: number; url: string } | null;
  published: string | null; refreshes: number; landed: boolean; gates: Gate[];
  resolving?: { number: number; work: string; main: string };
  mergeIntent?: string;
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

/** Replace this one function when the CI/local-hooks lane supplies its wrapper. */
export function localGateCommands(cwd: string, base: string): Gate[] {
  const paths = git(cwd, ["diff", "--name-only", "-z", base, "HEAD", "--"]).split("\0").filter(Boolean);
  const file = (path: string) => existsSync(join(cwd, path)) && statSync(join(cwd, path)).isFile();
  const tests = touchedTests(paths, file);
  const lint = paths.filter((path) => /\.[cm]?[jt]sx?$/.test(path) && file(path));
  return [
    { id: "dependencies", args: ["bun", "install", "--frozen-lockfile"] },
    { id: "tsc", args: ["bunx", "tsc", "--noEmit"] },
    ...(lint.length ? [{ id: "eslint", args: ["bun", "scripts/eslint-changes.ts", "--base", base, ...lint] }] : []),
    ...(tests.length ? [{ id: "tests", args: ["bun", "test", ...tests.map((path) => `./${path}`)] }] : []),
    { id: "privacy", args: ["bun", "scripts/privacy-publication-gate.ts", "--base", base, "--check-commits"] },
  ];
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

  read(): RunState {
    const state = JSON.parse(readFileSync(this.stateFile, "utf8")) as RunState;
    if (state.version !== 2 || realpathSync(state.repo) !== realpathSync(this.repo)
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
    const state: RunState = { version: 2, repo: realpathSync(this.repo), work, branch, base, tip: base,
      rows: [], gated: null, batch: null, published: null, refreshes: 0, landed: false, gates: [], attributionLog: [] };
    // Save ownership before any batch mutation, so failures remain inspectable.
    this.save(state);
    for (const pair of pairs) {
      const view = await this.view(pair.number);
      git(work, ["fetch", "origin", `refs/pull/${pair.number}/head`]);
      // Even an ineligible PR supplies detectors from its reviewed commit.
      // Resolve abbreviations once; the reviewed head never follows the forge.
      const head = git(work, ["rev-parse", `${pair.reviewed}^{commit}`]);
      const row: BatchRow = { ...pair, head, view, patch: "", status: "head-moved", commit: "", paths: [], detail: "" };
      state.rows.push(row);
      if (view.state !== "OPEN" || view.isDraft || view.baseRefName !== "main" || !view.headRefOid.startsWith(pair.reviewed)) continue;
      if (git(work, ["rev-parse", "FETCH_HEAD"]) !== view.headRefOid) continue;
      row.patch = patchId(work, git(work, ["merge-base", base, row.head]), row.head);
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
      const env = gate.id === "tests" ? isolatedEnvironment(stateDir, process.env) : process.env;
      const result = await this.run(cwd, ["/var/tmp/llv-gate", ...args], { ...env, LLV_STATE_DIR: stateDir });
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

  private async testSample(cwd: string, files: string[], corpus: false | Record<string, string>, missingModule?: (output: string, file: string, report: string) => boolean): Promise<TestRun & { present: TestSite[]; unavailable: string[] }> {
    const started = performance.now();
    const sample: TestRun & { present: TestSite[]; unavailable: string[] } = { failures: [], passed: [], completed: [], elapsedMs: 0, present: [], unavailable: [] };
    for (const file of files) {
      const result = await this.gateCommand(cwd, { id: "tests", args: ["bun", "test", `./${file}`], report: true }, corpus);
      if (result.code !== 0 && missingModule?.(result.output, file, result.report ?? "")) {
        sample.unavailable.push(file);
        continue;
      }
      if (/^# Unhandled error between tests/m.test(result.output)) throw new Error(`Test gate: between-test error in ${file}; batch not gated`);
      let parsed: ReturnType<typeof parseReport>;
      try { parsed = parseReport(result.report ?? "", result.output, file, cwd); }
      catch { throw new Error(`Test gate could not complete ${file}; missing or invalid report`); }
      if (parsed.failures.some(site => site.kind === "error")) throw new Error(`Test gate: between-test error in ${file}; batch not gated`);
      if ((result.code === 0) !== (parsed.failures.length === 0)) throw new Error(`Test gate could not run ${file}; runner exit disagrees with report`);
      // Reuse the validated parser to retain skipped identities as present.
      // Native omission may remove an added assertion; skipping it proves no fix.
      const present = parseReport((result.report ?? "").replace(/<skipped\b[^>]*(?:\/>|>[\s\S]*?<\/skipped>)/g, ""), result.output, file, cwd);
      sample.present.push(...present.failures, ...present.passed);
      sample.failures.push(...parsed.failures); sample.passed.push(...parsed.passed); sample.completed.push(file);
    }
    sample.elapsedMs = performance.now() - started;
    return sample;
  }

  private async testSubject(state: RunState, files: string[], removed?: number[], stable: false | Record<string, string> = false): Promise<TestRun & { present: TestSite[] }> {
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
      return await this.testSample(work, selected, stable);
    } finally { git(state.work, ["worktree", "remove", "--force", work]); }
  }

  private treeTests(state: RunState, revision: string): Record<string, string> {
    const entries = git(state.work, ["ls-tree", "-r", "-z", revision]).split("\0").filter(Boolean);
    const corpus: Record<string, string> = {};
    for (const entry of entries) {
      const tab = entry.indexOf("\t"), metadata = entry.slice(0, tab), file = entry.slice(tab + 1);
      if (!file || !/[._](?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
      if (!/^100(?:644|755) blob /.test(metadata!)) throw new Error("Test file must be a regular tracked file");
      const blob = metadata!.split(" ")[2]!;
      corpus[file] = execFileSync("git", ["cat-file", "blob", blob], { cwd: state.work, maxBuffer: 16 * 1024 * 1024 }).toString("base64");
    }
    return corpus;
  }

  private detectors(state: RunState): Detector[] {
    // Contents come only from immutable Git objects. Deduplication is local to
    // this validation; a rebuilt candidate starts with an empty set again.
    const seen = new Set<string>();
    return [{ source: "native candidate", corpus: this.treeTests(state, state.tip) },
      ...state.rows.map(row => ({ source: `#${row.number}@${row.head}`, pr: row.number, corpus: this.treeTests(state, row.head) }))]
      .map(detector => ({ ...detector, corpus: Object.fromEntries(Object.entries(detector.corpus).filter(([file, contents]) => {
        const key = JSON.stringify([file, contents]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      })) })).filter(detector => Object.keys(detector.corpus).length);
  }

  private missingReviewedModule(state: RunState, detector: Detector, output: string, file: string, report: string): boolean {
    // Only a load failure of a module introduced by the withheld PR qualifies.
    // Deleting a main module, runtime exceptions and partial runs stay red.
    const errors = [...output.matchAll(/^error: Cannot find module '(\.[^'\r\n]+)' from '([^'\r\n]+)'$/gm)];
    if (errors.length !== 1 || !/^\s*1 error\s*$/m.test(output) || /<testcase\b/.test(report)) return false;
    const [, module, importer] = errors[0]!;
    if (relative(state.work, importer!) !== file) return false;
    const stem = relative(state.work, resolve(dirname(importer!), module!));
    if (stem.startsWith("../") || stem.startsWith("/")) return false;
    const paths = [stem, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"].map(suffix => stem + suffix)];
    if (paths.some(path => existsSync(join(state.work, path)))) return false;
    const head = state.rows.find(row => row.number === detector.pr)!.head;
    const contains = (revision: string, path: string) => {
      try { git(state.work, ["cat-file", "-e", `${revision}:${path}`]); return true; }
      catch { return false; }
    };
    return !paths.some(path => contains(state.base, path)) && paths.some(path => contains(head, path));
  }

  private async validateTests(state: RunState, validation: Validation): Promise<boolean> {
    const detectors = this.detectors(state);
    const files = [...new Set(detectors.flatMap(detector => Object.keys(detector.corpus)))];
    // Native main only: candidate-only files and assertions have no baseline
    // observations. This sample has no lifetime beyond this candidate tuple.
    const baseline = await this.testSubject(state, files);
    const prs = validation.candidate.prs.map(pr => pr.number);
    for (const detector of detectors) {
      const withheld = detector.pr !== undefined && !prs.includes(detector.pr);
      const candidate = await this.testSample(state.work, Object.keys(detector.corpus), detector.corpus, withheld ? (output, file, report) => this.missingReviewedModule(state, detector, output, file, report) : undefined);
      for (const file of candidate.unavailable) validation.notApplicable.push({ source: detector.source, file,
        reason: "reviewed detector cannot load without withheld PR code (missing module)" });
      // A withheld, self-contained literal assertion can never judge remaining
      // implementation code. Establish that afresh, including confirmations;
      // historical attribution is never consulted as validation evidence.
      if (withheld) for (const file of Object.keys(detector.corpus)) {
        if (!literalAssertionFile(Buffer.from(detector.corpus[file]!, "base64").toString("utf8"))) continue;
        const introduced = compareBatchTests(baseline, candidate).introduced.filter(test => test.file === file);
        if (!introduced.length) continue;
        for (let round = 0; round < MAX_TEST_CONFIRMATIONS; round++) {
          const run = await this.testSample(state.work, [file], detector.corpus);
          for (const test of introduced) if (observed(run, test, "withheld literal assertion") !== "fail") {
            throw new Error("Withheld literal assertion changed during confirmation; batch not gated");
          }
        }
        validation.notApplicable.push({ source: detector.source, file, reason: "confirmed faulty literal assertions of a withheld PR; independent of candidate code" });
        candidate.failures = candidate.failures.filter(test => !introduced.some(site => testIdentity(site) === testIdentity(test)));
      }
      const decision = await attributeBatchTests(baseline, candidate, prs,
        files => this.testSample(state.work, files, detector.corpus),
        (removed, files) => this.testSubject(state, files, removed, detector.corpus), {
          owners: test => state.rows.filter(row => row.status === "clean" && row.paths.includes(test.file)).map(row => row.number),
          independent: test => literalAssertionFile(Buffer.from(detector.corpus[test.file]!, "base64").toString("utf8")),
          without: async (removed, test) => {
            const run = await this.testSubject(state, [test.file], removed);
            return { run, absent: !run.present.some(site => testIdentity(site) === testIdentity(test)) };
          },
        });
      validation.decisions.push(decision);
      for (const entry of decision.attributed) state.attributionLog.push({ ...entry, candidate: validation.candidate, source: detector.source });
      for (const row of state.rows) {
        if (row.status !== "clean") continue;
        const failures = decision.attributed.filter(entry => entry.prs.includes(row.number));
        if (!failures.length) continue;
        row.status = "culprit";
        row.detail = failures.map(entry => `${entry.reason}: ${entry.test.file} > ${entry.test.suite} > ${entry.test.name}`).join("; ");
      }
      this.save(state);
      if (decision.attributed.length) return false;
    }
    return true;
  }

  async gate(): Promise<RunState> {
    const state = this.read();
    this.assertTip(state);
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
      return await this.run(trustedWork, ["/var/tmp/llv-gate", "bun", "scripts/privacy-publication-gate.ts",
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
    for (const gate of localGateCommands(work, main)) {
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
  const attributed = log;
  return [
    "", "Pre-existing failures (permitted):", ...[...existing.values()].map(site => `- ${describe(site)}`),
    "", "Intermittent failures (permitted):", ...[...intermittent.values()].map(site => `- ${describe(site)}`),
    "", "Attributed failures:", ...attributed.map(entry =>
      `- ${entry.prs.map(number => `#${number}`).join(", ")}: ${entry.reason}: ${describe(entry.test)}; candidate failed; confirmations ${entry.confirmation.join(", ")}; `
      + entry.removals.map(sample => `without ${sample.removed.map(number => `#${number}`).join(", ") || "none"}${sample.corpus ? " (native tests)" : ""}: ${sample.outcome}`).join("; ") + `; established on ${JSON.stringify(entry.candidate)} (${entry.source})`),
  ];
}

export function report(state: RunState): string {
  return ["| PR | Result |", "| --- | --- |", ...state.rows.map((row) => {
    const result = row.status === "merged" ? `merged ${row.commit}` : row.status === "needs-review" ? `needs-review ${row.resolution}`
      : row.status === "culprit" ? `culprit ${row.detail}` : row.status === "deferred" ? `needs-review pending resolution (${row.detail})`
      : row.status === "head-moved" ? "left: reviewed head moved or is ineligible" : "left: awaiting local gate or publication";
    return `| #${row.number} | ${result.replace(/[\r\n]/g, " ").replaceAll("|", "\\|")} |`;
  }), ...testDecisionReport(state.gated?.decisions ?? [], state.attributionLog ?? []),
    "", "Not applicable reviewed detectors:", ...(state.gated?.notApplicable ?? []).map(entry => `- ${entry.source}: ${entry.file}: ${entry.reason}`), ...(state.batch ? ["", state.batch.url] : [])].join("\n");
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
      else if (command === "gate") state = await batch.gate();
      else if (command === "land") state = await batch.land();
      else if (command === "resolve" && /^[1-9]\d*$/.test(argument ?? "")) state = await batch.resolve(Number(argument));
      else throw new Error("Usage: merge-batch.ts build N@sha,... | gate | land | resolve N");
      process.stdout.write(report(state) + "\n");
    } catch (error) {
      // Child-process failures may carry secret-bearing stdout/arguments.
      process.stderr.write(error instanceof Error && !('stdout' in error) ? `${error.message}\n` : "Batch command failed; inspect the private worktree and run state.\n");
      process.exitCode = 1;
    } finally { if (held) rmSync(lock, { recursive: true }); }
  }
}
