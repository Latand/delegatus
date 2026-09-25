import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { globalCache } from "@/lib/scanner/caches";
import { projectForCwd, recordWorktreeResolution } from "@/lib/scanner/describe";
import { scanProcesses, type ProcessScan } from "@/lib/tempSweep";
import type { FileEntry, RootKey } from "@/lib/types";

import { readForgeCache, resetForgeCacheForTests, type ForgeCacheFile } from "@/lib/forge/cache";
import { sweepForgeLinks } from "@/lib/forge/sweep";
import type { GithubRunner } from "@/lib/monitor/githubEvidence";
import type { Pipeline } from "@/lib/pipelines/types";

import {
  classifyStatus,
  forgeCacheMergedPullRequests,
  ghMergedPullRequests,
  liveOrWaitingConversationCwds,
  parseWorktreeList,
  productionMergedPullRequests,
  realGit,
  runWorktreeSweep,
  startWorktreeSweep,
  stopWorktreeSweep,
  sweepMergedWorktrees,
  worktreeSweepMode,
  type MergedPullRequest,
  type SweptPipeline,
  type WorktreeSweepPorts,
} from "./worktreeSweep";

/* Every repository here is a throwaway under the test's temp root, and the
   state directory is the test's own: nothing reads or removes the operator's
   worktrees or state. The remote URL names GitHub only so the repository has a
   forge name; the forge is the injected `mergedPullRequests` port. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worktree-sweep-test-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
const REPOSITORY = "example/widgets";
const children: ChildProcess[] = [];

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  stopWorktreeSweep();
});

let caseDir = "";
let caseIndex = 0;
beforeEach(() => {
  caseIndex += 1;
  caseDir = path.join(SANDBOX, `case-${caseIndex}`);
  fs.mkdirSync(caseDir, { recursive: true });
  process.env.LLV_STATE_DIR = path.join(caseDir, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  globalCache("project-info-cwd-v2").clear();
  globalCache("worktree-git").clear();
});

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", ["-c", "user.name=Sweep Test", "-c", "user.email=sweep@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(): string {
  const root = path.join(caseDir, "widgets");
  fs.mkdirSync(root, { recursive: true });
  git(["init", "-q", "-b", "main"], root);
  git(["remote", "add", "origin", `https://github.com/${REPOSITORY}.git`], root);
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(root, "README.md"), "widgets\n");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "initial"], root);
  return root;
}

/** A linked worktree on a new branch with one commit of its own. */
function lane(root: string, dir: string, branch: string): { dir: string; tip: string } {
  git(["worktree", "add", "-q", "-b", branch, dir, "main"], root);
  fs.writeFileSync(path.join(dir, `${branch.replace(/\W/g, "-")}.txt`), `${branch}\n`);
  git(["add", "."], dir);
  git(["commit", "-q", "-m", `work on ${branch}`], dir);
  /* An ignored dependency tree, which neither blocks nor survives removal. */
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "x".repeat(20_000));
  return { dir, tip: git(["rev-parse", "HEAD"], dir) };
}

function merged(number: number, headRefName: string, headRefOid: string): MergedPullRequest {
  return { number, url: `https://github.com/${REPOSITORY}/pull/${number}`, headRefName, headRefOid };
}

function pipeline(overrides: Partial<SweptPipeline> & Pick<SweptPipeline, "repoDir" | "worktreeDir" | "branch">): SweptPipeline {
  return { id: `pipe-${path.basename(overrides.worktreeDir)}`, state: "completed", delivery: undefined, runs: [], ...overrides };
}

const NO_PROCESSES: ProcessScan = { ownNamespace: null, processes: [] };

function ports(overrides: Partial<WorktreeSweepPorts> & { prs?: MergedPullRequest[] | null }): WorktreeSweepPorts {
  const { prs = [], ...rest } = overrides;
  return {
    mode: "on",
    git: realGit,
    mergedPullRequests: () => prs,
    pipelines: [],
    conversationCwds: () => [],
    scan: () => NO_PROCESSES,
    recordResolution: (worktree) => recordWorktreeResolution(worktree) !== null,
    ...rest,
  };
}

const branchExists = (root: string, branch: string) =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;

test("a completed lane whose PR was squash-merged loses its worktree and its local branch", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-aaaa"), "pipeline/aaaa");
  /* A squash merge: main never contains the lane's commit. */
  expect(spawnSync("git", ["merge-base", "--is-ancestor", tip, "main"], { cwd: root }).status).toBe(1);

  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/aaaa" })],
    prs: [merged(11, "pipeline/aaaa", tip)],
  }));

  expect(report.removed).toEqual([expect.objectContaining({ path: dir, pr: { number: 11, url: merged(11, "", "").url }, branch: "pipeline/aaaa", pipelineId: "pipe-widgets-pipeline-aaaa" })]);
  expect(report.removed[0]!.bytes).toBeGreaterThan(20_000);
  expect(report.removedBytes).toBe(report.removed[0]!.bytes);
  expect(fs.existsSync(dir)).toBe(false);
  expect(git(["worktree", "list", "--porcelain"], root)).not.toContain(dir);
  expect(branchExists(root, "pipeline/aaaa")).toBe(false);
  expect(fs.existsSync(root)).toBe(true);
  /* The resolution was on disk before the directory went. */
  const map = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"), "utf8")) as Record<string, { repo: string }>;
  expect(map[dir]?.repo).toBe(fs.realpathSync(root));
});

test("the lane's PR is found by the delivered number when its head branch differs from the lane branch", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-bbbb"), "pipeline/bbbb");
  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({
      repoDir: root,
      worktreeDir: dir,
      branch: "pipeline/bbbb",
      state: "closed",
      delivery: { target: { branch: "feature/delivered", pr: 21 } } as SweptPipeline["delivery"],
    })],
    prs: [merged(21, "feature/delivered", tip)],
  }));
  expect(report.removed.map((removal) => removal.pr.number)).toEqual([21]);
  expect(fs.existsSync(dir)).toBe(false);
});

test("a completed lane without a merged PR stays and is reported no-merged-pr", async () => {
  const root = repository();
  const { dir } = lane(root, path.join(caseDir, "widgets-pipeline-cccc"), "pipeline/cccc");
  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/cccc" })],
    prs: [],
  }));
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([{ path: dir, reason: "no-merged-pr", pipelineId: "pipe-widgets-pipeline-cccc" }]);
  expect(fs.existsSync(dir)).toBe(true);
  expect(branchExists(root, "pipeline/cccc")).toBe(true);
});

test("each guard keeps a merged worktree, and the main checkout is never a candidate", async () => {
  const root = repository();
  const mainTip = git(["rev-parse", "HEAD"], root);
  const untracked = lane(root, path.join(caseDir, "g-untracked"), "g/untracked");
  fs.writeFileSync(path.join(untracked.dir, "notes.txt"), "not committed\n");
  const modified = lane(root, path.join(caseDir, "g-modified"), "g/modified");
  fs.appendFileSync(path.join(modified.dir, "README.md"), "edit\n");
  const ahead = lane(root, path.join(caseDir, "g-ahead"), "g/ahead");
  const aheadMergedTip = ahead.tip;
  fs.writeFileSync(path.join(ahead.dir, "later.txt"), "after the merge\n");
  git(["add", "."], ahead.dir);
  git(["commit", "-q", "-m", "after merge"], ahead.dir);
  const unknownHead = lane(root, path.join(caseDir, "g-unknown-head"), "g/unknown-head");
  const busy = lane(root, path.join(caseDir, "g-busy"), "g/busy");
  const busySub = path.join(busy.dir, "src");
  fs.mkdirSync(busySub);
  const talking = lane(root, path.join(caseDir, "g-talking"), "g/talking");
  const open = lane(root, path.join(caseDir, "g-open"), "g/open");
  const locked = lane(root, path.join(caseDir, "g-locked"), "g/locked");
  const hosting = lane(root, path.join(caseDir, "g-hosting"), "g/hosting");
  git(["worktree", "lock", locked.dir], root);

  /* A real process with its working directory inside, found by the real /proc scan. */
  const sleeper = spawn("sleep", ["60"], { cwd: busySub, stdio: "ignore" });
  children.push(sleeper);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const report = await sweepMergedWorktrees(ports({
    pipelines: [
      pipeline({ repoDir: root, worktreeDir: open.dir, branch: "g/open", state: "running" }),
      pipeline({ repoDir: root, worktreeDir: talking.dir, branch: "g/talking" }),
      /* An open lane provisioned from a linked checkout runs its git there. */
      pipeline({ repoDir: hosting.dir, worktreeDir: path.join(caseDir, "g-hosted"), branch: "g/hosted", state: "needs_review" }),
    ],
    conversationCwds: () => [path.join(talking.dir, "packages", "web")],
    scan: () => scanProcesses(),
    prs: [
      merged(1, "main", mainTip),
      merged(2, "g/untracked", untracked.tip),
      merged(3, "g/modified", modified.tip),
      merged(4, "g/ahead", aheadMergedTip),
      merged(5, "g/unknown-head", "f".repeat(40)),
      merged(6, "g/busy", busy.tip),
      merged(7, "g/talking", talking.tip),
      merged(8, "g/open", open.tip),
      merged(9, "g/locked", locked.tip),
      merged(10, "g/hosting", hosting.tip),
    ],
  }));

  const reasons = Object.fromEntries(report.kept.map((kept) => [path.basename(kept.path), kept.reason]));
  expect(reasons).toEqual({
    "g-untracked": "uncommitted",
    "g-modified": "uncommitted",
    "g-ahead": "unmerged-commits",
    "g-unknown-head": "pr-head-unknown",
    "g-busy": "in-use",
    "g-talking": "live-conversation",
    "g-open": "open-pipeline",
    "g-locked": "locked",
    "g-hosting": "open-pipeline",
  });
  expect(report.kept.find((kept) => kept.reason === "in-use")?.detail).toBe(`pid ${sleeper.pid}`);
  expect(report.removed).toEqual([]);
  expect(report.kept.some((kept) => kept.path === root)).toBe(false);
  for (const dir of [root, untracked.dir, modified.dir, ahead.dir, unknownHead.dir, busy.dir, talking.dir, open.dir, locked.dir, hosting.dir]) {
    expect(fs.existsSync(dir)).toBe(true);
  }
  expect(branchExists(root, "main")).toBe(true);
  expect(fs.readFileSync(path.join(untracked.dir, "notes.txt"), "utf8")).toBe("not committed\n");
});

test("every linked layout of a registered repository is swept, nested checkouts first", async () => {
  const root = repository();
  const claude = lane(root, path.join(root, ".claude", "worktrees", "topic"), "topic");
  const dotted = lane(root, path.join(root, ".worktrees", "fix-1"), "fix-1");
  const plain = lane(root, path.join(root, "worktrees", "fix-2"), "fix-2");
  const outer = lane(root, path.join(caseDir, "sibling-outer"), "outer");
  const inner = lane(root, path.join(outer.dir, ".worktrees", "inner"), "inner");
  fs.writeFileSync(path.join(outer.dir, ".gitignore"), "node_modules/\n.worktrees/\n");
  git(["add", ".gitignore"], outer.dir);
  git(["commit", "-q", "-m", "ignore nested worktrees"], outer.dir);
  const outerTip = git(["rev-parse", "HEAD"], outer.dir);

  const report = await sweepMergedWorktrees(ports({
    /* Registered as an operator-created project, with no pipeline at all. */
    repositories: [root],
    prs: [
      merged(31, "topic", claude.tip),
      merged(32, "fix-1", dotted.tip),
      merged(33, "fix-2", plain.tip),
      merged(34, "outer", outerTip),
      merged(35, "inner", inner.tip),
    ],
  }));

  expect(report.kept).toEqual([]);
  expect(report.removed.map((removal) => removal.path).sort()).toEqual([claude.dir, dotted.dir, plain.dir, outer.dir, inner.dir].sort());
  expect(report.removed.findIndex((removal) => removal.path === inner.dir))
    .toBeLessThan(report.removed.findIndex((removal) => removal.path === outer.dir));
  for (const dir of [claude.dir, dotted.dir, plain.dir, outer.dir, inner.dir]) expect(fs.existsSync(dir)).toBe(false);
  expect(git(["worktree", "list", "--porcelain"], root).split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
});

test("a nested worktree that stays keeps the checkout holding it", async () => {
  const root = repository();
  const outer = lane(root, path.join(caseDir, "holder"), "holder");
  const inner = lane(root, path.join(outer.dir, "worktrees", "held"), "held");
  fs.writeFileSync(path.join(inner.dir, "draft.txt"), "uncommitted\n");
  const report = await sweepMergedWorktrees(ports({
    repositories: [root],
    prs: [merged(41, "holder", outer.tip), merged(42, "held", inner.tip)],
  }));
  expect(Object.fromEntries(report.kept.map((kept) => [kept.path, kept.reason]))).toEqual({
    [inner.dir]: "uncommitted",
    [outer.dir]: "holds-worktree",
  });
  expect(fs.existsSync(outer.dir)).toBe(true);
});

/* A `gh` as old as the Docker image's 2.23: it lists pull requests with the
   fields it knows and fails the whole command on one it does not, the way the
   forge sweep's `closingIssuesReferences` fails there. */
type GhRow = { number: number; headRefName: string; headRefOid: string; state: "MERGED" | "OPEN" | "CLOSED" };
function oldGh(rows: readonly GhRow[], calls: string[][] = []): GithubRunner {
  const known = new Set(["number", "url", "headRefName", "headRefOid", "state", "isDraft", "createdAt", "updatedAt"]);
  return async (args) => {
    calls.push(args);
    const fields = (args[args.indexOf("--json") + 1] ?? "").split(",");
    const unknown = fields.find((field) => !known.has(field));
    if (unknown) throw Object.assign(new Error("Command failed: gh pr list"), { code: 1, stderr: `Unknown JSON field: "${unknown}"` });
    const state = args[args.indexOf("--state") + 1];
    return JSON.stringify(rows
      .filter((row) => state === "all" || row.state.toLowerCase() === state)
      .map((row) => ({
        ...row,
        url: `https://github.com/${REPOSITORY}/pull/${row.number}`,
        isDraft: false,
        createdAt: "2026-09-24T00:00:00Z",
        updatedAt: "2026-09-24T00:00:00Z",
      })));
  };
}

const emptyCache = () => forgeCacheMergedPullRequests(() => ({ schemaVersion: 1, repositories: {} }));

test("under a gh that rejects closingIssuesReferences the forge cache stays empty, and gh still yields merged PRs with head commits", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-gggg"), "pipeline/gggg");
  const rows: GhRow[] = [
    { number: 81, headRefName: "pipeline/gggg", headRefOid: tip, state: "MERGED" },
    { number: 82, headRefName: "feature/open", headRefOid: "b".repeat(40), state: "OPEN" },
  ];
  const forgeFile = path.join(caseDir, "forge-links.json");
  resetForgeCacheForTests();
  const lanePipeline = { id: "pipe-gggg", project: "repo-fixture", state: "completed", branch: "pipeline/gggg", delivery: { target: { remote: `https://github.com/${REPOSITORY}.git`, pr: 81 } } } as unknown as Pipeline;
  const logged: string[] = [];
  await sweepForgeLinks({ now: () => Date.parse("2026-09-25T10:00:00Z"), run: oldGh(rows), loadPipelines: () => [lanePipeline], loadTasks: () => [], file: forgeFile, log: (message) => logged.push(message) });
  expect(readForgeCache(forgeFile).data.repositories[REPOSITORY]).toMatchObject({ completeSince: null, lastError: "command-failed" });
  expect(logged).toEqual([`[forge links] ${REPOSITORY}: command-failed`]);
  const cache = forgeCacheMergedPullRequests(() => readForgeCache(forgeFile).data);
  expect(cache(REPOSITORY)).toBeNull();

  const calls: string[][] = [];
  const source = productionMergedPullRequests({ cache, gh: ghMergedPullRequests(oldGh(rows, calls)) });
  expect(await source(REPOSITORY)).toEqual([merged(81, "pipeline/gggg", tip)]);
  expect(calls).toEqual([["pr", "list", "--repo", REPOSITORY, "--state", "merged", "--limit", "5000", "--json", "number,url,headRefName,headRefOid"]]);

  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/gggg" })],
    mergedPullRequests: source,
  }));
  expect(report.removed).toEqual([expect.objectContaining({ path: dir, pr: { number: 81, url: `https://github.com/${REPOSITORY}/pull/81` } })]);
  expect(fs.existsSync(dir)).toBe(false);
  /* One gh read per repository per sweep, the removal included. */
  expect(calls.length).toBe(1);
  resetForgeCacheForTests();
});

test("a repository registered only as a project has its merged worktree removed through the production merge source", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(root, ".claude", "worktrees", "manual"), "manual");
  const source = productionMergedPullRequests({
    /* No pipeline or linked task names it, so the forge sweep never reads it. */
    cache: emptyCache(),
    gh: ghMergedPullRequests(oldGh([{ number: 91, headRefName: "manual", headRefOid: tip, state: "MERGED" }])),
  });
  const report = await sweepMergedWorktrees(ports({ repositories: [root], mergedPullRequests: source }));
  expect(report.kept).toEqual([]);
  expect(report.removed.map((removal) => [removal.path, removal.pr.number])).toEqual([[dir, 91]]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(branchExists(root, "manual")).toBe(false);
});

test("the gh merge source fails closed, and a complete forge cache answers without gh", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(root, ".worktrees", "kept"), "kept");
  const failing: GithubRunner = async () => { throw Object.assign(new Error("Command failed: gh"), { code: 1 }); };
  const garbled = (raw: string): GithubRunner => async () => raw;
  for (const gh of [failing, garbled("not json"), garbled("{}"), garbled(JSON.stringify([{ number: 1, url: 7, headRefName: "kept", headRefOid: tip }]))]) {
    const report = await sweepMergedWorktrees(ports({ repositories: [root], mergedPullRequests: productionMergedPullRequests({ cache: emptyCache(), gh: ghMergedPullRequests(gh) }) }));
    expect(report.kept.map((kept) => [kept.path, kept.reason])).toEqual([[dir, "forge-unavailable"]]);
  }
  /* A merged PR gh lists without a head commit proves nothing and matches nothing. */
  const headless = await ghMergedPullRequests(garbled(JSON.stringify([{ number: 2, url: `https://github.com/${REPOSITORY}/pull/2`, headRefName: "kept", headRefOid: "" }])))(REPOSITORY);
  expect(headless).toEqual([]);
  expect(fs.existsSync(dir)).toBe(true);

  let ghCalls = 0;
  const cached = [merged(3, "kept", tip)];
  const source = productionMergedPullRequests({ cache: () => cached, gh: async () => { ghCalls += 1; return null; } });
  expect(await source(REPOSITORY)).toEqual(cached);
  expect(ghCalls).toBe(0);
});

test("a dry run measures what it would remove and touches nothing", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-dddd"), "pipeline/dddd");
  let recorded = 0;
  const report = await sweepMergedWorktrees(ports({
    mode: "dry-run",
    pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/dddd" })],
    prs: [merged(51, "pipeline/dddd", tip)],
    recordResolution: () => { recorded += 1; return true; },
  }));
  expect(report.mode).toBe("dry-run");
  expect(report.removed.map((removal) => removal.path)).toEqual([dir]);
  expect(report.removedBytes).toBeGreaterThan(20_000);
  expect(recorded).toBe(0);
  expect(fs.existsSync(dir)).toBe(true);
  expect(branchExists(root, "pipeline/dddd")).toBe(true);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"))).toBe(false);
});

test("an unreadable forge keeps every linked worktree, and a failed map write refuses the removal", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-eeee"), "pipeline/eeee");
  const pipelines = [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/eeee" })];
  const unreachable = await sweepMergedWorktrees(ports({ pipelines, prs: null }));
  expect(unreachable.kept.map((kept) => kept.reason)).toEqual(["forge-unavailable"]);
  const unrecorded = await sweepMergedWorktrees(ports({ pipelines, prs: [merged(61, "pipeline/eeee", tip)], recordResolution: () => false }));
  expect(unrecorded.kept.map((kept) => kept.reason)).toEqual(["map-write-failed"]);
  expect(fs.existsSync(dir)).toBe(true);
});

test("the sweep writes its report, and LLV_WORKTREE_SWEEP turns it off", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-ffff"), "pipeline/ffff");
  const made = (mode: WorktreeSweepPorts["mode"]) => Promise.resolve(ports({
    mode,
    pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/ffff" })],
    prs: [merged(71, "pipeline/ffff", tip)],
  }));
  expect(await runWorktreeSweep({ LLV_WORKTREE_SWEEP: "0" }, made)).toBeNull();
  expect(fs.existsSync(dir)).toBe(true);
  const report = await runWorktreeSweep({}, made);
  const written = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "worktree-sweep-report.json"), "utf8"));
  expect(written).toEqual(JSON.parse(JSON.stringify(report)));
  expect(written.removed).toEqual([expect.objectContaining({ path: dir, pr: expect.objectContaining({ number: 71 }) })]);
  expect(fs.existsSync(dir)).toBe(false);

  let armed = 0;
  startWorktreeSweep({ env: { LLV_WORKTREE_SWEEP: "off" }, schedule: () => { armed += 1; return setTimeout(() => {}, 0); } });
  expect(armed).toBe(0);
  startWorktreeSweep({ env: {}, schedule: (callback, delay) => { armed += 1; return setTimeout(() => {}, delay); } });
  expect(armed).toBe(1);
});

test("merged pull requests come from the forge cache once it holds a complete read with head commits", () => {
  const oid = "a".repeat(40);
  const entry = (extra: Partial<ForgeCacheFile["repositories"][string]>) => ({
    canonical: null, completeSince: "2026-09-25T00:00:00Z", lastSweepAt: "2026-09-25T00:00:00Z", lastAttemptAt: null, lastError: null, issues: {}, headRefOids: true as const,
    prs: {
      "1": { url: "https://github.com/example/widgets/pull/1", headRefName: "b1", createdAt: "", state: "merged" as const, closes: [], checkedAt: "", headRefOid: oid },
      "2": { url: "https://github.com/example/widgets/pull/2", headRefName: "b2", createdAt: "", state: "open" as const, closes: [], checkedAt: "", headRefOid: oid },
      "3": { url: "https://github.com/example/widgets/pull/3", headRefName: "b3", createdAt: "", state: "merged" as const, closes: [], checkedAt: "" },
    },
    ...extra,
  });
  const read = (repositories: ForgeCacheFile["repositories"]) => forgeCacheMergedPullRequests(() => ({ schemaVersion: 1, repositories }));
  expect(read({ "example/widgets": entry({}) })("Example/Widgets")).toEqual([
    { number: 1, url: "https://github.com/example/widgets/pull/1", headRefName: "b1", headRefOid: oid },
  ]);
  /* Renamed: the record's old name keys the entry, the remote says the new one. */
  expect(read({ "example/old-widgets": entry({ canonical: "example/widgets" }) })("example/widgets")?.map((pr) => pr.number)).toEqual([1]);
  expect(read({})("example/widgets")).toBeNull();
  expect(read({ "example/widgets": entry({ completeSince: null }) })("example/widgets")).toBeNull();
  expect(read({ "example/widgets": entry({ headRefOids: undefined }) })("example/widgets")).toBeNull();
});

test("an ignored nested repository or .env keeps the worktree; rebuildable outputs do not", async () => {
  const root = repository();
  /* Shared by every worktree of the repository, so no lane has a changed .gitignore. */
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), ".worktrees/\n.env\n*.tsbuildinfo\n.next/\n");
  const nested = lane(root, path.join(caseDir, "ig-nested"), "ig/nested");
  const other = path.join(nested.dir, ".worktrees", "other");
  fs.mkdirSync(other, { recursive: true });
  git(["init", "-q", "-b", "main"], other);
  fs.writeFileSync(path.join(other, "wip.txt"), "uncommitted work of another repository\n");
  const env = lane(root, path.join(caseDir, "ig-env"), "ig/env");
  fs.writeFileSync(path.join(env.dir, ".env"), "LOCAL_SETTING=1\n");
  const clean = lane(root, path.join(caseDir, "ig-clean"), "ig/clean");
  fs.writeFileSync(path.join(clean.dir, "tsconfig.tsbuildinfo"), "{}");
  fs.mkdirSync(path.join(clean.dir, ".next", "cache"), { recursive: true });
  /* The status read that guarded before lists nothing for either. */
  expect(git(["status", "--porcelain=v1", "--untracked-files=all"], nested.dir)).toBe("");
  expect(git(["status", "--porcelain=v1", "--untracked-files=all"], env.dir)).toBe("");

  const report = await sweepMergedWorktrees(ports({
    repositories: [root],
    prs: [merged(91, "ig/nested", nested.tip), merged(92, "ig/env", env.tip), merged(93, "ig/clean", clean.tip)],
  }));
  expect(report.kept).toEqual([
    { path: nested.dir, reason: "ignored-files", detail: ".worktrees/" },
    { path: env.dir, reason: "ignored-files", detail: ".env" },
  ]);
  expect(report.removed.map((removal) => removal.path)).toEqual([clean.dir]);
  expect(fs.readFileSync(path.join(other, "wip.txt"), "utf8")).toContain("uncommitted");
  expect(fs.existsSync(path.join(env.dir, ".env"))).toBe(true);
  expect(fs.existsSync(clean.dir)).toBe(false);
});

test("the ignored-path classifier lets only rebuildable outputs through", () => {
  const raw = [
    "!! node_modules", "!! packages/web/node_modules/", "!! .next/", "!! tsconfig.tsbuildinfo",
    /* A cache with its own `*` .gitignore is listed file by file. */
    "!! .ruff_cache/.gitignore", "!! apps/api/.pytest_cache/v/", "!! apps/api/src/pkg.egg-info/",
    "!! .env.local", "!! .claude/settings.local.json", "!! .artifacts/", "!! notes/build.md.bak",
    "R  new.ts", "old.ts", "?? notes.txt", "",
  ].join("\0");
  expect(classifyStatus(raw)).toEqual({ changed: ["new.ts", "notes.txt"], ignored: [".env.local", ".claude/settings.local.json", ".artifacts/", "notes/build.md.bak"] });
});

test("the guards are read again after the measurement, right before each removal", async () => {
  const root = repository();
  const busy = lane(root, path.join(caseDir, "late-busy"), "late/busy");
  const hosting = lane(root, path.join(caseDir, "late-hosting"), "late/hosting");
  const talking = lane(root, path.join(caseDir, "late-talking"), "late/talking");
  const quiet = lane(root, path.join(caseDir, "late-quiet"), "late/quiet");
  const measured = new Set<string>();
  const scans: number[] = [];
  const report = await sweepMergedWorktrees(ports({
    repositories: [root],
    prs: [merged(101, "late/busy", busy.tip), merged(102, "late/hosting", hosting.tip), merged(103, "late/talking", talking.tip), merged(104, "late/quiet", quiet.tip)],
    measure: async (directory) => {
      measured.add(directory);
      return 1;
    },
    /* Each appears only after its own checkout was measured: a shell started
       there, a pipeline created with it as its repository, an agent spawned in it. */
    scan: () => {
      scans.push(measured.size);
      return measured.has(busy.dir)
        ? { ownNamespace: null, processes: [{ pid: 4242, paths: [path.join(busy.dir, "src")] }] } as unknown as ProcessScan
        : NO_PROCESSES;
    },
    currentPipelines: () => measured.has(hosting.dir)
      ? [pipeline({ repoDir: hosting.dir, worktreeDir: path.join(caseDir, "late-hosted"), branch: "late/hosted", state: "provisioning" })]
      : [],
    conversationCwds: () => measured.has(talking.dir) ? [talking.dir] : [],
  }));
  expect(Object.fromEntries(report.kept.map((kept) => [path.basename(kept.path), [kept.reason, kept.detail]]))).toEqual({
    "late-busy": ["in-use", "pid 4242"],
    "late-hosting": ["open-pipeline", undefined],
    "late-talking": ["live-conversation", undefined],
  });
  expect(report.removed.map((removal) => removal.path)).toEqual([quiet.dir]);
  for (const dir of [busy.dir, hosting.dir, talking.dir]) expect(fs.existsSync(dir)).toBe(true);
  /* One read up front, then one per removal attempt. */
  expect(scans).toEqual([0, 1, 2, 3, 4]);
});

test("a completed or closed pipeline whose teardown or delivery has not settled still holds its checkout", async () => {
  const root = repository();
  const tearing = lane(root, path.join(caseDir, "unsettled-teardown"), "unsettled/teardown");
  const delivering = lane(root, path.join(caseDir, "unsettled-delivery"), "unsettled/delivery");
  const report = await sweepMergedWorktrees(ports({
    pipelines: [
      pipeline({ repoDir: root, worktreeDir: tearing.dir, branch: "unsettled/teardown", state: "closed", closeTeardown: { id: "t", phase: "running", waitingForActivation: false, acknowledgeHosts: true, flow: null } }),
      pipeline({ repoDir: root, worktreeDir: delivering.dir, branch: "unsettled/delivery", delivery: { target: {}, operation: { state: "running" } } as unknown as SweptPipeline["delivery"] }),
    ],
    prs: [merged(111, "unsettled/teardown", tearing.tip), merged(112, "unsettled/delivery", delivering.tip)],
  }));
  expect(report.kept.map((kept) => [path.basename(kept.path), kept.reason]).sort()).toEqual([
    ["unsettled-delivery", "open-pipeline"],
    ["unsettled-teardown", "open-pipeline"],
  ]);
  expect(report.removed).toEqual([]);
});

test("a pipeline state the sweep does not know holds its checkout", async () => {
  const root = repository();
  const future = lane(root, path.join(caseDir, "future-state"), "future/state");
  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({ repoDir: root, worktreeDir: future.dir, branch: "future/state", state: "archiving" as unknown as SweptPipeline["state"] })],
    prs: [merged(113, "future/state", future.tip)],
  }));
  expect(report.kept.map((kept) => [path.basename(kept.path), kept.reason])).toEqual([["future-state", "open-pipeline"]]);
  expect(report.removed).toEqual([]);
  expect(fs.existsSync(future.dir)).toBe(true);
});

test("a git status that fails keeps the worktree as uncommitted", async () => {
  const root = repository();
  const unreadable = lane(root, path.join(caseDir, "status-fails"), "status/fails");
  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({ repoDir: root, worktreeDir: unreadable.dir, branch: "status/fails" })],
    git: (args, cwd) => args[0] === "status"
      ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: index file corrupt" })
      : realGit(args, cwd),
    prs: [merged(114, "status/fails", unreadable.tip)],
  }));
  expect(report.kept).toEqual([expect.objectContaining({ path: unreadable.dir, reason: "uncommitted", detail: "git status failed: fatal: index file corrupt" })]);
  expect(report.removed).toEqual([]);
  expect(fs.existsSync(unreadable.dir)).toBe(true);
  expect(branchExists(root, "status/fails")).toBe(true);
});

test("a commit made on a detached HEAD after the listing keeps the worktree as unmerged-commits", async () => {
  const root = repository();
  const detached = lane(root, path.join(caseDir, "late-commit"), "late/commit");
  git(["checkout", "-q", "--detach"], detached.dir);
  git(["branch", "-D", "late/commit"], root);
  let late = "";
  const report = await sweepMergedWorktrees(ports({
    /* The delivered PR number alone makes the detached checkout a candidate. */
    pipelines: [pipeline({
      repoDir: root,
      worktreeDir: detached.dir,
      branch: "late/commit",
      delivery: { target: { branch: "late/commit", pr: 115 } } as SweptPipeline["delivery"],
    })],
    /* The owner commits while the sweep works: after the listing, before the
       status read, and the committing process is gone before the removal. */
    git: (args, cwd) => {
      if (args[0] === "status" && cwd === detached.dir && !late) {
        fs.writeFileSync(path.join(detached.dir, "late.txt"), "late\n");
        git(["add", "late.txt"], detached.dir);
        git(["commit", "-q", "-m", "late"], detached.dir);
        late = git(["rev-parse", "HEAD"], detached.dir);
      }
      return realGit(args, cwd);
    },
    prs: [merged(115, "late/commit", detached.tip)],
  }));
  expect(late).not.toBe("");
  expect(report.kept).toEqual([expect.objectContaining({ path: detached.dir, reason: "unmerged-commits", detail: "#115" })]);
  expect(report.removed).toEqual([]);
  expect(fs.existsSync(detached.dir)).toBe(true);
  expect(git(["rev-parse", "HEAD"], detached.dir)).toBe(late);
});

test("a commit made after the measurement is proven again right before the removal", async () => {
  const root = repository();
  const moving = lane(root, path.join(caseDir, "moving"), "moving");
  const report = await sweepMergedWorktrees(ports({
    repositories: [root],
    prs: [merged(116, "moving", moving.tip)],
    measure: async (directory) => {
      fs.writeFileSync(path.join(directory, "later.txt"), "later\n");
      git(["add", "later.txt"], directory);
      git(["commit", "-q", "-m", "later"], directory);
      return 1;
    },
  }));
  expect(report.kept).toEqual([expect.objectContaining({ path: moving.dir, reason: "unmerged-commits" })]);
  expect(report.removed).toEqual([]);
  expect(fs.existsSync(moving.dir)).toBe(true);
  expect(branchExists(root, "moving")).toBe(true);
});

test("a project registered at a merged, clean linked worktree keeps its root", async () => {
  const root = repository();
  const project = lane(root, path.join(caseDir, "project-at-linked"), "project/linked");
  const inner = lane(root, path.join(caseDir, "project-holds-inner"), "project/inner");
  const other = lane(root, path.join(caseDir, "project-sibling"), "project/sibling");
  fs.mkdirSync(path.join(inner.dir, "packages", "web"), { recursive: true });
  const report = await sweepMergedWorktrees(ports({
    repositories: [project.dir, path.join(inner.dir, "packages", "web")],
    prs: [merged(117, "project/linked", project.tip), merged(118, "project/inner", inner.tip), merged(119, "project/sibling", other.tip)],
  }));
  expect(report.repositories).toEqual([root]);
  expect(report.kept).toEqual([]);
  expect(report.removed.map((removal) => removal.path)).toEqual([other.dir]);
  expect(fs.existsSync(project.dir)).toBe(true);
  expect(fs.existsSync(inner.dir)).toBe(true);
  expect(branchExists(root, "project/linked")).toBe(true);
});

test("the mode knob reads on, off and dry-run", () => {
  expect(worktreeSweepMode({})).toBe("on");
  expect(worktreeSweepMode({ LLV_WORKTREE_SWEEP: "1" })).toBe("on");
  expect(worktreeSweepMode({ LLV_WORKTREE_SWEEP: "0" })).toBeNull();
  expect(worktreeSweepMode({ LLV_WORKTREE_SWEEP: "off" })).toBeNull();
  expect(worktreeSweepMode({ LLV_WORKTREE_SWEEP: "dry-run" })).toBe("dry-run");
});

test("live or waiting conversations: hosted, freshly starting, or holding a queued message", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const cwds = liveOrWaitingConversationCwds({
    entries: {
      a: { cwd: "/w/live", status: "live" },
      b: { cwd: "/w/idle", status: "idle" },
      c: { cwd: "/w/starting", status: "starting", pendingAction: "spawn", updatedAt: "2026-09-25T11:00:00Z" },
      d: { cwd: "/w/stale-start", status: "starting", pendingAction: "spawn", updatedAt: "2026-07-14T05:54:16Z" },
      e: { cwd: "/w/dead", status: "dead" },
      f: { cwd: "/w/unhosted", status: "unhosted" },
    },
    conversations: {
      q: { generations: [{ launchProfile: { cwd: "/w/old" } }, { launchProfile: { cwd: "/w/queued" } }] },
      r: { generations: [{ launchProfile: { cwd: "/w/delivered" } }] },
      s: { generations: [{ launchProfile: { cwd: "/w/assigned" } }] },
      /* Written and never confirmed: the message may still be on its way. */
      u: { generations: [{ launchProfile: { cwd: "/w/uncertain" } }] },
    },
    heldDeliveries: {
      h1: { conversationId: "q", state: "held" },
      h2: { conversationId: "r", state: "delivered" },
      h3: { conversationId: "s", state: "assigned" },
      h4: { conversationId: "u", state: "delivery-uncertain" },
    },
  }, now);
  expect(cwds.sort()).toEqual(["/w/assigned", "/w/idle", "/w/live", "/w/queued", "/w/starting", "/w/uncertain"]);
});

test("the porcelain listing parses branches, detached heads, locks and prunable entries", () => {
  const raw = [
    "worktree /r", "HEAD aaa", "branch refs/heads/main", "",
    "worktree /r-lane", "HEAD bbb", "detached", "locked reason", "",
    "worktree /gone", "HEAD ccc", "branch refs/heads/x", "prunable gitdir file points to non-existent location", "",
  ].join("\0");
  expect(parseWorktreeList(raw)).toEqual([
    { path: "/r", head: "aaa", branch: "main", locked: false, prunable: false, bare: false },
    { path: "/r-lane", head: "bbb", branch: null, locked: true, prunable: false, bare: false },
    { path: "/gone", head: "ccc", branch: "x", locked: false, prunable: true, bare: false },
  ]);
});

test("the Viewer's listing keeps a removed lane's conversations under the parent repository", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-gggg"), "pipeline/gggg");
  const parentProject = projectForCwd(root)!;
  const roots: Record<RootKey, string> = {
    "codex-sessions": path.join(caseDir, "codex-sessions"),
    "claude-projects": path.join(caseDir, "claude-projects"),
    "claude-tasks": path.join(caseDir, "claude-tasks"),
    "openclaw-sessions": path.join(caseDir, "openclaw"),
    "copilot-sessions": path.join(caseDir, "copilot-sessions"),
  };
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true });
  /* A stage conversation that ran in the lane, and one in a subdirectory of it. */
  const stage = path.join(roots["claude-projects"], dir.replace(/[^a-zA-Z0-9]/g, "-"), "stage-session.jsonl");
  const nested = path.join(roots["codex-sessions"], "nested-session.jsonl");
  fs.mkdirSync(path.dirname(stage), { recursive: true });
  fs.writeFileSync(stage, JSON.stringify({ type: "user", cwd: dir, message: { content: "Build the lane" } }) + "\n");
  fs.writeFileSync(nested, JSON.stringify({ type: "session_meta", payload: { cwd: path.join(dir, "src", "lib") } }) + "\n");

  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/gggg" })],
    prs: [merged(81, "pipeline/gggg", tip)],
  }));
  expect(report.removed.map((removal) => removal.path)).toEqual([dir]);
  expect(fs.existsSync(dir)).toBe(false);

  /* A fresh process: only what is on disk can place them now. */
  const listed = await listInFreshProcess(roots);
  const byPath = new Map(listed.files.map((entry) => [entry.path, entry]));
  expect(byPath.get(stage)?.project).toBe(parentProject);
  expect(byPath.get(nested)?.project).toBe(parentProject);
  const catalog = listed.projectCatalog.filter((entry) => entry.conversations > 0).map((entry) => entry.project);
  expect(catalog).toEqual([parentProject]);
});

async function listInFreshProcess(roots: Record<RootKey, string>): Promise<{ files: FileEntry[]; projectCatalog: Array<{ project: string; conversations: number }> }> {
  const modulePath = path.join(import.meta.dir, "..", "scanner", "discover.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const { discoverFilesWithProjectCatalog } = await import(${JSON.stringify(modulePath)});
      const result = await discoverFilesWithProjectCatalog(${JSON.stringify(roots)}, undefined, { persist: false });
      process.stdout.write(JSON.stringify({ files: result.files, projectCatalog: result.projectCatalog }));
    `],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR! },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`fresh listing process failed (${exitCode}): ${error}`);
  return JSON.parse(output);
}
