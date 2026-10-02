import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GithubRunner } from "../src/lib/monitor/githubEvidence";

export type ReviewedPr = { number: number; reviewed: string };

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
      if (!/^Co-Authored-By:/i.test(line)) continue;
      const match = /^Co-Authored-By:\s*([^<>\r\n]+)\s+<([^<>\s]+)>\s*$/i.exec(line);
      if (!match || !machineEmail(match[2]!)) throw new Error("Non-machine attribution trailer refused");
      trailers.add(`Co-Authored-By: ${match[1]!.trim()} <${match[2]}>`);
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
export function noticePrs(log: string, commits: BatchCommit[]): number[] {
  // Checkout logs also print HEAD and filenames. Only a diagnostic can accuse
  // a PR; incidental checkout output must never turn a main-wide red into one.
  const notices = log.split("\n").filter((line) => /\b(?:commit_message|merge_boundary|error|warning|notice|finding|file|path):|::(?:error|warning|notice)(?:\s|::)/i.test(line)).join("\n");
  const hashes = new Set(notices.match(/\b[a-f0-9]{7,40}\b/g) ?? []);
  const tokens = new Set(notices.split(/[\s:,'"`()[\]<>]+/).filter(Boolean));
  return commits.filter((entry) => [...hashes].some((hash) => entry.commit.startsWith(hash))
    || entry.paths.some((path) => tokens.has(path))).map((entry) => entry.number);
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
export function nextRefresh(count: number): number {
  if (count >= MAX_MAIN_REFRESHES) throw new Error("Main moved more than three times");
  return count + 1;
}

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).trimEnd();
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
export type Gate = { id: string; args: string[] };
export type RunState = {
  version: 1; repo: string; work: string; branch: string; base: string; tip: string;
  rows: BatchRow[]; gated: string | null; batch: { number: number; url: string } | null;
  published: string | null; refreshes: number; landed: boolean; gates: Gate[];
  resolving?: { number: number; work: string; main: string };
  mergeIntent?: string;
};
export type CommandResult = { code: number; output: string };
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
    ...(lint.length ? [{ id: "eslint", args: ["bunx", "eslint", "--", ...lint] }] : []),
    ...(tests.length ? [{ id: "tests", args: ["bun", "test", ...tests.map((path) => `./${path}`)] }] : []),
    { id: "privacy", args: ["bun", "scripts/privacy-publication-gate.ts", "--base", base, "--check-commits"] },
  ];
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
    if (state.version !== 1 || realpathSync(state.repo) !== realpathSync(this.repo)
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

  private identity(cwd: string): void {
    for (const kind of ["AUTHOR", "COMMITTER"]) {
      const identity = git(cwd, ["var", `GIT_${kind}_IDENT`]);
      const email = /<([^<>]+)>/.exec(identity)?.[1];
      if (!email || !machineEmail(email)) throw new Error("Batch commits require a machine noreply identity");
    }
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
    const state: RunState = { version: 1, repo: realpathSync(this.repo), work, branch, base, tip: base,
      rows: [], gated: null, batch: null, published: null, refreshes: 0, landed: false, gates: [] };
    // Save ownership before any batch mutation, so failures remain inspectable.
    this.save(state);
    for (const pair of pairs) {
      const view = await this.view(pair.number);
      const row: BatchRow = { ...pair, head: view.headRefOid, view, patch: "", status: "head-moved", commit: "", paths: [], detail: "" };
      state.rows.push(row);
      if (view.state !== "OPEN" || view.isDraft || view.baseRefName !== "main" || !view.headRefOid.startsWith(pair.reviewed)) continue;
      git(work, ["fetch", "origin", `refs/pull/${pair.number}/head`]);
      if (git(work, ["rev-parse", "FETCH_HEAD"]) !== view.headRefOid) continue;
      row.patch = patchId(work, git(work, ["merge-base", base, row.head]), row.head);
      row.status = "clean";
    }
    await this.rebuild(state);
    return state;
  }

  private async rebuild(state: RunState): Promise<void> {
    this.assertTip(state);
    git(state.work, ["reset", "--hard", state.base]); // Only this run's owned worktree.
    state.gated = null;
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
      const message = batchMessage(row.number, row.view.title, row.view.body, authors);
      this.identity(state.work);
      git(state.work, ["commit", "-F", "-"], message);
      row.commit = git(state.work, ["rev-parse", "HEAD"]);
      row.paths = git(state.work, ["diff", "--name-only", "-z", previous, row.commit]).split("\0").filter(Boolean);
      row.status = "clean"; row.detail = "";
    }
    state.tip = git(state.work, ["rev-parse", "HEAD"]);
    this.save(state);
  }

  private async gateCommand(cwd: string, gate: Gate): Promise<CommandResult> {
    // Older bisect subjects may predate added tests or deleted lint targets.
    let args = gate.args;
    if (gate.id === "tests" || gate.id === "eslint") {
      const prefix = gate.id === "tests" ? 2 : 3;
      const files = args.slice(prefix).filter((path) => existsSync(join(cwd, path)) && statSync(join(cwd, path)).isFile());
      if (!files.length) return { code: 0, output: "" };
      args = [...args.slice(0, prefix), ...files];
    }
    const stateDir = mkdtempSync(join("/var/tmp", "merge-gate-state-"));
    try { return await this.run(cwd, ["/var/tmp/llv-gate", ...args], { ...process.env, LLV_STATE_DIR: stateDir }); }
    finally { rmSync(stateDir, { recursive: true, force: true }); }
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
      if (result.code !== 0) throw new Error(`Bisect could not attribute ${gate.id}`);
      const bad = git(state.work, ["rev-parse", "refs/bisect/bad"]);
      const row = state.rows.find((entry) => entry.status === "clean" && entry.commit === bad);
      if (!row) throw new Error(`Bisect found no batch PR for ${gate.id}`);
      return row;
    } finally {
      git(state.work, ["bisect", "reset", state.branch]);
      rmSync(commandFile);
    }
  }

  async gate(): Promise<RunState> {
    const state = this.read();
    this.assertTip(state);
    while (state.rows.some((row) => row.status === "clean")) {
      state.gates = localGateCommands(state.work, state.base);
      this.save(state);
      let failed: Gate | null = null;
      for (const gate of state.gates) {
        const result = await this.gateCommand(state.work, gate);
        if (result.code !== 0) { failed = gate; break; }
      }
      if (!failed) { this.assertTip(state); state.gated = state.tip; this.save(state); return state; }
      const row = await this.culprit(state, failed);
      row.status = "culprit"; row.detail = `${failed.id}: first failing batch commit`;
      await this.rebuild(state);
    }
    state.gated = state.tip;
    this.save(state);
    return state;
  }

  private body(state: RunState): string {
    const rows = state.rows.filter((row) => row.status === "clean");
    const issues = [...new Set(rows.flatMap((row) => row.view.closingIssuesReferences.map((issue) => issue.number)))];
    return ["Reviewed patches, one commit per pull request.", ...rows.map((row) => `- #${row.number} at ${row.head}`),
      "", ...issues.map((number) => `Closes #${number}`)].join("\n");
  }

  private async publish(state: RunState): Promise<void> {
    this.assertTip(state);
    if (state.gated !== state.tip) throw new Error("Exact batch tip has not passed local gates");
    const title = `Merge batch: ${state.rows.filter((row) => row.status === "clean").map((row) => `#${row.number}`).join(", ")}`;
    const bodyFile = join(dirname(this.stateFile), "merge-batch-body.md");
    writeFileSync(bodyFile, this.body(state), { mode: 0o600 });
    // Check public title/body too; changed-file and commit gates ran in gate().
    const privacy = await this.run(state.work, ["/var/tmp/llv-gate", "bun", "scripts/privacy-publication-gate.ts", "--paths", bodyFile]);
    if (privacy.code) throw new Error("Batch PR body failed the publication gate");
    const push = ["push", ...(state.published ? [`--force-with-lease=refs/heads/${state.branch}:${state.published}`] : []),
      "origin", `${state.tip}:refs/heads/${state.branch}`];
    git(state.work, push);
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
  }

  private async refresh(state: RunState): Promise<RunState> {
    state.refreshes = nextRefresh(state.refreshes);
    this.assertTip(state);
    git(state.work, ["fetch", "origin", "main"]);
    const base = git(state.work, ["rev-parse", "origin/main"]);
    try { git(state.work, ["rebase", base]); }
    catch { git(state.work, ["rebase", "--abort"]); }
    state.tip = git(state.work, ["rev-parse", "HEAD"]);
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
      const attributed = noticePrs(log, state.rows.filter((row) => row.status === "clean"));
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
    this.assertTip(state);
    if (state.gated !== state.tip) throw new Error("Run gate before land");
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
    for (let poll = 0; poll < 120; poll++) {
      const clean = state.rows.filter((row) => row.status === "clean");
      if (!clean.length) {
        if (state.batch) await this.gh(["pr", "close", String(state.batch.number), "--comment", "Batch empty after attribution; nothing merged."]);
        state.landed = true; this.save(state); return state;
      }
      let moved = false;
      for (const row of clean) if (!await this.unchanged(row)) { row.status = "head-moved"; moved = true; }
      if (moved) { await this.rebuild(state); state = await this.gate(); continue; }
      git(state.work, ["fetch", "origin", "main"]);
      if (git(state.work, ["rev-parse", "origin/main"]) !== state.base) { state = await this.refresh(state); continue; }
      if (state.published !== state.tip || !state.batch) await this.publish(state);
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
        for (const row of clean) if (!await this.unchanged(row)) { row.status = "head-moved"; moved = true; }
        if (moved) { await this.rebuild(state); state = await this.gate(); continue; }
        state.mergeIntent = state.tip; this.save(state);
        try { await this.gh(["pr", "merge", String(state.batch!.number), "--rebase", "--match-head-commit", state.tip]); }
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
      const result = await this.gateCommand(work, gate);
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
    git(work, ["push", remote, `${row.resolution}:refs/heads/${row.view.headRefName}`]);
    row.status = "needs-review";
    delete state.resolving;
    this.save(state);
    return state;
  }
}

export function report(state: RunState): string {
  return ["| PR | Result |", "| --- | --- |", ...state.rows.map((row) => {
    const result = row.status === "merged" ? `merged ${row.commit}` : row.status === "needs-review" ? `needs-review ${row.resolution}`
      : row.status === "culprit" ? `culprit ${row.detail}` : row.status === "deferred" ? `needs-review pending resolution (${row.detail})`
      : row.status;
    return `| #${row.number} | ${result} |`;
  }), ...(state.batch ? ["", state.batch.url] : [])].join("\n");
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
