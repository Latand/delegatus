import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { openHostTempRoots, stageHostNamespace } from "@/lib/state/hostTempViews";

import { globalCache } from "@/lib/scanner/caches";
import { projectForCwd, recordWorktreeResolution } from "@/lib/scanner/describe";
import { scanProcesses, type ProcessScan } from "@/lib/tempSweep";
import type { FileEntry, RootKey } from "@/lib/types";

import { readForgeCache, resetForgeCacheForTests, type ForgeCacheFile } from "@/lib/forge/cache";
import { sweepForgeLinks } from "@/lib/forge/sweep";
import type { GithubRunner } from "@/lib/monitor/githubEvidence";
import type { Pipeline } from "@/lib/pipelines/types";

import {
  FINISHED_WORKTREE_RETENTION_MS,
  classifyStatus,
  exclusiveBytes,
  allocatedBytes,
  forgeCacheMergedPullRequests,
  ghMergedPullRequests,
  hostTempWorktreeAccess,
  liveOrWaitingConversationCwds,
  parseWorktreeList,
  productionMergedPullRequests,
  realGit,
  recordWorktreeSweep,
  runWorktreeSweep,
  startWorktreeSweep,
  stopWorktreeSweep,
  sweepMergedWorktrees,
  worktreeSweepMode,
  worktreeSweepStatus,
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
  /* Exercise real dependency bulk in every lane, including remote/PR removal. */
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules/dep/index.js"), "module.exports = 42;\n");
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
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      // Remote I/O stays in sandbox bare repositories. The URL seam models
      // a network transport, whose freshly advertised refs are read by Git.
      if (args[0] === "remote" && args[1] === "get-url" && result.code === 0
        && result.stdout.trim().endsWith("remote.git"))
        return { ...result, stdout: `https://github.com/${REPOSITORY}.git\n` };
      return result;
    },
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

test("a completed squash-merged lane releases its checkout and retains its local branch", async () => {
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
  expect(branchExists(root, "pipeline/aaaa")).toBe(true);
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
  expect(report.removed.map((removal) => removal.pr!.number)).toEqual([21]);
  expect(fs.existsSync(dir)).toBe(false);
});

test("a completed lane without a merged PR stays through retention, its clock started by the sweep that saw it settled", async () => {
  const root = repository();
  const { dir } = lane(root, path.join(caseDir, "widgets-pipeline-cccc"), "pipeline/cccc");
  const report = await sweepMergedWorktrees(ports({
    pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/cccc" })],
    prs: [],
  }));
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([expect.objectContaining({ path: dir, reason: "retention", pipelineId: "pipe-widgets-pipeline-cccc", firstSettledAt: report.at })]);
  expect(report.kept[0]!.detail).toBe(`eligible after ${new Date(Date.parse(report.at) + FINISHED_WORKTREE_RETENTION_MS).toISOString()}`);
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
}, 30_000); // Nine checkouts and real process scans can exceed the default on a busy host.

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
  expect(report.removed.map((removal) => [removal.path, removal.pr!.number])).toEqual([[dir, 91]]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(branchExists(root, "manual")).toBe(true);
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

test.each([false, true])("the sweep releases its borrowed root when input throws %s", async throws => {
  let closed = 0;
  const options = { ...ports({}), close: async () => { closed += 1; } };
  if (throws) options.scan = () => { throw new Error("fixture scan failed"); };
  if (throws) await expect(sweepMergedWorktrees(options)).rejects.toThrow("fixture scan failed");
  else expect((await sweepMergedWorktrees(options)).removed).toEqual([]);
  expect(closed).toBe(1);
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
    expect.objectContaining({ path: nested.dir, reason: "ignored-files", detail: ".worktrees/" }),
    expect.objectContaining({ path: env.dir, reason: "ignored-files", detail: ".env" }),
  ]);
  expect(report.removed.map((removal) => removal.path)).toEqual([clean.dir]);
  expect(fs.readFileSync(path.join(other, "wip.txt"), "utf8")).toContain("uncommitted");
  expect(fs.existsSync(path.join(env.dir, ".env"))).toBe(true);
  expect(fs.existsSync(clean.dir)).toBe(false);
});

test("the ignored-path classifier recognizes baseline outputs and keeps artifacts and unknown classes", () => {
  const raw = [
    "!! node_modules", "!! packages/web/node_modules/", "!! .next/", "!! tsconfig.tsbuildinfo",
    /* A cache with its own `*` .gitignore is listed file by file. */
    "!! .ruff_cache/.gitignore", "!! apps/api/.pytest_cache/v/", "!! apps/api/src/pkg.egg-info/",
    "!! .env.local", "!! .claude/settings.local.json", "!! .artifacts/", "!! notes/build.md.bak",
    "R  new.ts", "old.ts", "?? notes.txt", "",
  ].join("\0");
  expect(classifyStatus(raw)).toEqual({ changed: ["new.ts", "notes.txt"], ignored: [".env.local", ".claude/settings.local.json", ".artifacts/", "notes/build.md.bak"] });
  expect(classifyStatus(raw, true).ignored).toHaveLength(11);
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
  /* One read up front, one per removal attempt after its measurement, and
     one more for the removal that went ahead, after its final status read. */
  expect(scans).toEqual([0, 1, 2, 3, 3, 4]);
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

test.each(["on", "dry-run"] as const)("a nested worktree created during measurement keeps its parent in %s mode", async mode => {
  const root = repository();
  const outer = lane(root, path.join(caseDir, "outer"), "topic/outer");
  const inner = path.join(outer.dir, "node_modules/local-checkout");
  let innerTip = "";
  const report = await sweepMergedWorktrees(ports({ mode, repositories: [root], prs: [merged(116, "topic/outer", outer.tip)],
    measure: async () => {
      const nested = lane(root, inner, "topic/unique-inner");
      innerTip = nested.tip;
      return 123;
    } }));
  expect(report.removed).toHaveLength(0);
  expect(report.kept).toEqual([expect.objectContaining({ path: outer.dir, reason: "holds-worktree", detail: inner })]);
  expect(fs.readFileSync(path.join(inner, "topic-unique-inner.txt"), "utf8")).toBe("topic/unique-inner\n");
  expect(git(["rev-parse", "HEAD"], inner)).toBe(innerTip);
  expect(branchExists(root, "topic/unique-inner")).toBe(true);
});

test("a nested worktree created during the final status command keeps its parent", async () => {
  const root = repository();
  const outer = lane(root, path.join(caseDir, "outer"), "topic/outer");
  const inner = path.join(outer.dir, "node_modules/local-checkout");
  let statuses = 0;
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(116, "topic/outer", outer.tip)],
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      if (cwd === outer.dir && args[0] === "status" && ++statuses === 2) lane(root, inner, "topic/unique-inner");
      return result;
    } }));
  expect(report.removed).toHaveLength(0);
  expect(report.kept[0]!.reason).toBe("holds-worktree");
  expect(fs.readFileSync(path.join(inner, "topic-unique-inner.txt"), "utf8")).toBe("topic/unique-inner\n");
});

test.each(["locked", "unreadable"])("worktree registration becoming %s during measurement refuses removal", async change => {
  const root = repository();
  const outer = lane(root, path.join(caseDir, "outer"), "topic/outer");
  let measured = false;
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(116, "topic/outer", outer.tip)],
    measure: async () => { measured = true; if (change === "locked") git(["worktree", "lock", outer.dir], root); return 123; },
    git: async (args, cwd) => change === "unreadable" && measured && args[0] === "worktree" && args[1] === "list"
      ? { code: 1, stdout: "", stderr: "fixture listing failure" } : realGit(args, cwd) }));
  expect(report.removed).toHaveLength(0);
  expect(report.kept[0]!.reason).toBe(change === "locked" ? "locked" : "uncommitted");
  expect(fs.existsSync(outer.dir)).toBe(true);
  expect(branchExists(root, "topic/outer")).toBe(true);
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

function cacheLane() {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir } = lane(root, path.join(caseDir, "widgets-pipeline-cache"), "pipeline/cache");
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".artifacts/cache/bundle"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".artifacts/cache/bundle/cache.fixture.js"), "cache");
  fs.writeFileSync(path.join(dir, ".env"), "private fixture");
  fs.writeFileSync(path.join(dir, "untracked"), "keep");
  const owner = pipeline({ id: "cache", state: "closed", repoDir: root, worktreeDir: dir, branch: "pipeline/cache" });
  return { root, dir, owner };
}
test("a settled lane trims only its proved fixture bundle without a merged PR", async () => {
  const { dir, owner } = cacheLane();
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner] }));
  expect(report.trimmed).toEqual([{ path: path.join(dir, ".artifacts/cache/bundle"), bytes: expect.any(Number), pipelineId: "cache" }]);
  expect(report.trimmedBytes).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(dir, ".artifacts/cache/bundle"))).toBe(false);
  for (const name of [".env", "untracked", ".git"]) expect(fs.existsSync(path.join(dir, name))).toBe(true);
  expect(report.kept).toContainEqual(expect.objectContaining({ path: dir, reason: "retention" }));
});

test.each(["on", "dry-run"] as const)("a retained settled lane trims its nonempty Next build in %s mode", async mode => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".next/\n");
  const { dir } = lane(root, path.join(caseDir, "widgets-pipeline-next"), "pipeline/next");
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
  const next = path.join(dir, ".next");
  fs.mkdirSync(next);
  fs.writeFileSync(path.join(next, "BUILD_ID"), "generated build");
  const owner = pipeline({ id: "next", repoDir: root, worktreeDir: dir, branch: "pipeline/next" });
  const report = await sweepMergedWorktrees(ports({ mode, pipelines: [owner] }));
  expect(report.kept[0]!.reason).toBe("retention");
  expect(report.trimmed).toEqual([{ path: next, bytes: expect.any(Number), pipelineId: "next" }]);
  expect(report.trimmedBytes).toBeGreaterThan(0);
  expect(fs.existsSync(next)).toBe(mode === "dry-run");
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
});

test.each(["tracked", "unignored", "nested-repository", "nested-artifacts", "late-repository", "late-worktree", "late-process", "late-symlink"])("build trim preserves %s contents", async guard => {
  const root = repository();
  if (guard !== "tracked" && guard !== "unignored") fs.appendFileSync(path.join(root, ".git/info/exclude"), "dist/\n");
  const { dir } = lane(root, path.join(caseDir, "widgets-pipeline-build"), "pipeline/build");
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
  const output = path.join(dir, "dist");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "index.js"), "generated output");
  const owner = pipeline({ id: "build", repoDir: root, worktreeDir: dir, branch: "pipeline/build" });
  if (guard === "tracked") { git(["add", "dist"], dir); git(["commit", "-q", "-m", "tracked output"], dir); }
  if (guard === "nested-repository") git(["init", "-q", path.join(output, "source")], root);
  if (guard === "nested-artifacts") {
    fs.mkdirSync(path.join(output, ".artifacts"));
    fs.writeFileSync(path.join(output, ".artifacts/capture.png"), "retained capture");
  }
  const outside = path.join(caseDir, "external-output");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "keep target");
  let checks = 0, busy = false;
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner],
    scan: () => busy ? { ...NO_PROCESSES, processes: [{ pid: 123, paths: [dir] }] } as ProcessScan : NO_PROCESSES,
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      if (args[0] === "ls-files" && args.at(-1) === "dist" && ++checks === 2) {
        if (guard === "late-repository") git(["init", "-q", path.join(output, "source")], root);
        if (guard === "late-worktree") lane(root, path.join(output, "checkout"), "topic/private-build");
        if (guard === "late-process") busy = true;
        if (guard === "late-symlink") {
          fs.renameSync(output, path.join(dir, "previous-dist"));
          fs.symlinkSync(outside, output);
        }
      }
      return result;
    } }));
  expect(report.removed).toEqual([]);
  expect(report.trimmed).toEqual([]);
  expect(fs.existsSync(output)).toBe(true);
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep target");
  if (guard.startsWith("late-")) expect(checks).toBe(2);
});

test.each(["nested-worktree", "lock", "prunable", "unreadable"])("cache trim refreshes Git guards after measurement: %s", async (guard) => {
  const { root, dir, owner } = cacheLane();
  const next = path.join(dir, ".artifacts/cache/bundle");
  const privateFile = path.join(next, "checkout", "private-work");
  let measured = false;
  const report = await sweepMergedWorktrees(ports({
    pipelines: [owner],
    measure: async () => {
      if (guard === "nested-worktree") {
        git(["worktree", "add", "-q", "-b", "private", path.dirname(privateFile), "main"], root);
        fs.writeFileSync(privateFile, "keep private work");
      }
      if (guard === "lock") git(["worktree", "lock", dir], root);
      measured = true;
      return 100;
    },
    git: async (args, cwd) => {
      if (measured && args[0] === "worktree" && args[1] === "list") {
        if (guard === "unreadable") return { code: 1, stdout: "", stderr: "metadata unavailable" };
        if (guard === "prunable") return { code: 0, stdout: `worktree ${root}\0HEAD abc\0\0worktree ${dir}\0HEAD abc\0prunable metadata missing\0\0`, stderr: "" };
      }
      return realGit(args, cwd);
    },
  }));
  expect(measured).toBe(true);
  expect(report.trimmed).toEqual([]);
  expect(fs.readFileSync(path.join(next, "cache.fixture.js"), "utf8")).toBe("cache");
  if (guard === "nested-worktree") {
    expect(fs.readFileSync(privateFile, "utf8")).toBe("keep private work");
    expect(fs.existsSync(path.join(path.dirname(privateFile), ".git"))).toBe(true);
  }
});
test.each(["open", "shared-open", "process", "conversation", "main", "unowned", "wrong-name", "registered", "locked", "late-process"])("fixture-bundle guard: %s", async (guard) => {
  const { root, dir, owner } = cacheLane();
  let scans = 0;
  const processScan = { ...NO_PROCESSES, processes: [{ pid: 123, paths: [path.join(dir, "nested")] }] } as ProcessScan;
  const options = ports({ pipelines: [owner] });
  if (guard === "open") owner.state = "running";
  if (guard === "shared-open") options.pipelines = [owner, { ...owner, id: "other", state: "running" }];
  if (guard === "process") options.scan = () => processScan;
  if (guard === "late-process") options.scan = () => ++scans > 1 ? processScan : NO_PROCESSES;
  if (guard === "conversation") options.conversationCwds = () => [path.join(dir, "nested")];
  if (guard === "main") owner.worktreeDir = root;
  if (guard === "unowned") { options.pipelines = []; options.repositories = [root]; }
  if (guard === "wrong-name") owner.id = "different";
  if (guard === "registered") options.repositories = [root, dir];
  if (guard === "locked") git(["worktree", "lock", dir], root);
  const report = await sweepMergedWorktrees(options);
  expect(report.trimmed).toEqual([]);
  expect(fs.existsSync(path.join(dir, ".artifacts/cache/bundle/cache.fixture.js"))).toBe(true);
});
test("fixture bundle symlink is skipped; nested symlinks never lose their target", async () => {
  const { dir, owner } = cacheLane();
  const outside = path.join(caseDir, "outside");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.rmSync(path.join(dir, ".artifacts/cache/bundle"), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, ".artifacts/cache/bundle"));
  expect((await sweepMergedWorktrees(ports({ pipelines: [owner] }))).trimmed).toEqual([]);
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep");
  fs.unlinkSync(path.join(dir, ".artifacts/cache/bundle")); fs.mkdirSync(path.join(dir, ".artifacts/cache/bundle"));
  fs.symlinkSync(outside, path.join(dir, ".artifacts/cache/bundle/link"));
  expect((await sweepMergedWorktrees(ports({ pipelines: [owner] }))).trimmed).toHaveLength(0);
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep");
});
test("dry-run reports fixture bundle bytes and keeps the files", async () => {
  const { dir, owner } = cacheLane();
  const report = await sweepMergedWorktrees(ports({ mode: "dry-run", pipelines: [owner] }));
  expect(report.trimmed).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, ".artifacts/cache/bundle/cache.fixture.js"))).toBe(true);
});

test("an archived settled owner still trims when the live list no longer contains it", async () => {
  const { dir, owner } = cacheLane();
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], currentPipelines: () => [] }));
  expect(report.trimmed).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, ".artifacts/cache/bundle"))).toBe(false);
});
test("a settled lane created from a linked checkout trims its own cache", async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const source = lane(root, path.join(caseDir, "widgets-linked"), "source/linked").dir;
  const dir = lane(root, `${source}-pipeline-cache`, "pipeline/cache").dir;
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".artifacts/cache/bundle"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".artifacts/cache/bundle/cache.fixture.js"), "cache");
  const owner = pipeline({ id: "cache", state: "closed", repoDir: source, worktreeDir: dir, branch: "pipeline/cache" });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner] }));
  expect(report.trimmed).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, ".artifacts/cache/bundle"))).toBe(false);
  expect(fs.existsSync(source)).toBe(true);
});

const RETAIN_NOW = Date.parse("2026-10-06T12:00:00Z");
const OLD_TERMINAL = new Date(RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS - 1).toISOString();
test.each(["conversation", "process", "pipeline"])("a %s holding a symlink cwd preserves its physical checkout and branch", async guard => {
  const root = repository(); remoteRepository(root);
  const dir = path.join(caseDir, "alias-checkout");
  const branch = "topic/alias-guard";
  git(["worktree", "add", "-q", "-b", branch, dir, "main"], root);
  const alias = path.join(caseDir, "checkout-alias");
  fs.symlinkSync(dir, alias, "dir");
  const cwd = path.join(alias, "pending-directory");
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch, baseRef: git(["rev-parse", "HEAD"], dir), closedAt: OLD_TERMINAL });
  const queued = () => liveOrWaitingConversationCwds({ heldDeliveries: { delivery: { state: "held", conversationId: "queued" } },
    conversations: { queued: { generations: [{ launchProfile: { cwd } }] } } });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner, ...(guard === "pipeline"
    ? [pipeline({ id: "open-alias", repoDir: root, worktreeDir: alias, branch, state: "running" })] : [])],
    conversationCwds: guard === "conversation" ? queued : () => [],
    scan: () => guard === "process" ? { ownNamespace: null, processes: [{ pid: 456789, namespace: null, stamped: true, paths: [cwd] }] } : NO_PROCESSES,
    now: () => RETAIN_NOW }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe(guard === "conversation" ? "live-conversation" : guard === "process" ? "in-use" : "open-pipeline");
  expect(fs.existsSync(path.join(dir, "README.md"))).toBeTrue();
  expect(branchExists(root, branch)).toBeTrue();
});

test("a conversation acquiring a symlink cwd during measurement preserves the checkout", async () => {
  const root = repository(); remoteRepository(root);
  const dir = path.join(caseDir, "late-alias");
  git(["worktree", "add", "-q", "-b", "topic/late-alias", dir, "main"], root);
  const alias = path.join(caseDir, "cwd-alias");
  fs.symlinkSync(dir, alias, "dir");
  let conversations: string[] = [];
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/late-alias", baseRef: git(["rev-parse", "HEAD"], dir), closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], conversationCwds: () => conversations,
    now: () => RETAIN_NOW, measure: async () => { conversations = [alias]; return 1; } }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("live-conversation");
  expect(fs.existsSync(dir)).toBeTrue();
});

test("a finished owner recorded through a symlink releases its physical checkout after retention", async () => {
  const root = repository(); remoteRepository(root);
  const dir = path.join(caseDir, "finished-alias");
  git(["worktree", "add", "-q", "-b", "topic/finished-alias", dir, "main"], root);
  const alias = path.join(caseDir, "owner-alias");
  fs.symlinkSync(dir, alias, "dir");
  const owner = pipeline({ repoDir: root, worktreeDir: alias, branch: "topic/finished-alias", baseRef: git(["rev-parse", "HEAD"], dir), closedAt: OLD_TERMINAL });
  const parentProject = projectForCwd(root);
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(report.removed).toHaveLength(1);
  expect(report.removed[0]!.pipelineId).toBe(owner.id);
  expect(fs.existsSync(dir)).toBeFalse();
  globalCache("project-info-cwd-v2").clear();
  globalCache("worktree-git").clear();
  expect(projectForCwd(alias)).toBe(parentProject);
});

test("a project registered through a symlink retains its physical root checkout", async () => {
  const root = repository(); remoteRepository(root);
  const dir = path.join(caseDir, "project-alias");
  git(["worktree", "add", "-q", "-b", "topic/project-alias", dir, "main"], root);
  const alias = path.join(caseDir, "project-root-alias");
  fs.symlinkSync(dir, alias, "dir");
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/project-alias", baseRef: git(["rev-parse", "HEAD"], dir), closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], repositories: [root, alias], now: () => RETAIN_NOW }));
  expect(report.removed).toEqual([]);
  expect(fs.existsSync(dir)).toBeTrue();
});

function remoteRepository(root: string): string {
  const remote = path.join(caseDir, "remote.git");
  fs.mkdirSync(remote);
  git(["init", "--bare", "-q"], remote);
  git(["remote", "set-url", "origin", remote], root);
  git(["push", "-q", "origin", "main"], root);
  return remote;
}

test.each(["replacement", "graft"].flatMap(override => ["remote", "merged"].map(proof => [override, proof])))("a %s history override cannot prove an unpublished tip preserved by %s", async (override, proof) => {
  const root = repository(); remoteRepository(root);
  const advertised = git(["rev-parse", "HEAD"], root);
  const { dir, tip } = lane(root, path.join(caseDir, "literal-history"), "pipeline/literal-history");
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "pipeline/literal-history", closedAt: OLD_TERMINAL });
  if (override === "replacement") git(["replace", "--graft", advertised, tip], root);
  else fs.writeFileSync(path.join(root, ".git/info/grafts"), `${advertised} ${tip}\n`);
  // The altered graph invents ancestry which the advertised object lacks.
  expect(git(["merge-base", "--is-ancestor", tip, advertised], root)).toBe("");
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], prs: proof === "merged" ? [merged(176, owner.branch, advertised)] : [], now: () => RETAIN_NOW }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("local-only-commits");
  expect(fs.existsSync(dir)).toBe(true);
  expect(git(["rev-parse", `refs/heads/${owner.branch}`], root)).toBe(tip);
});

test.each(["completed", "closed"] as const)("a retained %s lane without a PR frees a tip equal to its base", async state => {
  const root = repository();
  const dir = path.join(caseDir, "widgets-pipeline-base");
  git(["worktree", "add", "-q", "-b", "pipeline/base", dir, "main"], root);
  const baseRef = git(["rev-parse", "HEAD"], dir);
  const owner = pipeline({ id: "base", repoDir: root, worktreeDir: dir, branch: "pipeline/base", state, baseRef, closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(report.removed).toEqual([expect.objectContaining({ path: dir, pr: null, preservation: "base" })]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"))).toBe(true);
});

test("retention, local-only commits and stale remote-tracking refs preserve finished work", async () => {
  const root = repository(); remoteRepository(root);
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-local"), "pipeline/local");
  git(["update-ref", "refs/remotes/origin/stale", tip], root);
  const owner = pipeline({ id: "local", repoDir: root, worktreeDir: dir, branch: "pipeline/local", closedAt: new Date(RETAIN_NOW).toISOString() });
  const young = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(young.kept[0]!.reason).toBe("retention");
  owner.closedAt = OLD_TERMINAL;
  const retained = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(retained.kept[0]!.reason).toBe("local-only-commits");
  expect(retained.keptBytes["local-only-commits"]).toBeGreaterThan(0);
  expect(fs.existsSync(dir)).toBe(true);
  git(["push", "-q", "origin", "pipeline/local"], root);
  const safe = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(safe.removed[0]!.preservation).toBe("remote-ref");
  expect(fs.existsSync(dir)).toBe(false);
  /* Checkout storage is released while the local branch stays available. */
  expect(branchExists(root, "pipeline/local")).toBe(true);
});

test.each(["merge-batch", "review-export", "attribution"])("an unowned %s checkout under a temp root follows the same retention and remote proof", async role => {
  const root = repository(); remoteRepository(root);
  const temp = path.join(caseDir, "tmp");
  const dir = path.join(temp, `llv-${role}-fixture/checkout`);
  git(["worktree", "add", "--detach", dir, "main"], root);
  const first = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], now: () => RETAIN_NOW }));
  expect(first.removed).toHaveLength(0);
  expect(first.kept).toEqual([expect.objectContaining({ path: dir, reason: "retention", firstSettledAt: first.at })]);
  const options = ports({ repositories: [root], tempRoots: [temp], previous: first, now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS });
  const dry = await sweepMergedWorktrees({ ...options, mode: "dry-run" });
  expect(dry.removed).toHaveLength(1);
  expect(fs.existsSync(dir)).toBe(true);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"))).toBe(false);
  const removed = await sweepMergedWorktrees(options);
  expect(removed.removed[0]!.preservation).toBe("remote-ref");
  expect(fs.existsSync(dir)).toBe(false);
});

function mergerBatch() {
  const root = repository();
  const run = path.join(caseDir, "tmp/llv-merger-run");
  const branch = "merge-batch/11111111-1111-1111-1111-111111111111";
  const { dir, tip } = lane(root, path.join(run, "merge-batch-fixture/checkout"), branch);
  const file = path.join(run, "merge-batch.json");
  const state = { version: 1, repo: root, work: dir, branch, landed: true,
    rows: [{ status: "merged", detail: "closed" }, { status: "deferred", detail: "" }] };
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const options = ports({ repositories: [root], prs: [merged(77, branch, tip)], now: () => RETAIN_NOW });
  return { root, run, branch, dir, tip, file, state, save, options };
}

test("a merged batch keeps its checkout and branch for four days, including 25 minutes after landing", async () => {
  const batch = mergerBatch();
  const first = await sweepMergedWorktrees(batch.options);
  const young = await sweepMergedWorktrees({ ...batch.options, previous: first, now: () => RETAIN_NOW + 25 * 60_000 });
  expect(young.kept).toEqual([expect.objectContaining({ path: batch.dir, reason: "retention" })]);
  expect(young.removed).toHaveLength(0);
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
  const before = await sweepMergedWorktrees({ ...batch.options, previous: young,
    now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS - 1 });
  expect(before.kept[0]!.reason).toBe("retention");
  const after = await sweepMergedWorktrees({ ...batch.options, previous: before,
    now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS });
  expect(after.removed[0]!.preservation).toBe("merged-pr");
  expect(fs.existsSync(batch.dir)).toBe(false);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
});

test("landed merger state protects deferred resolve work without a process in its checkout", async () => {
  const batch = mergerBatch();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  batch.save();
  const active = await sweepMergedWorktrees({ ...batch.options, previous: old });
  expect(active.removed).toHaveLength(0);
  expect(active.kept).toEqual([expect.objectContaining({ path: batch.dir, reason: "in-use", detail: "merge batch still owns checkout" })]);
  expect(active.kept[0]!.firstSettledAt).toBeUndefined();
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
  batch.state.rows[1]!.status = "needs-review";
  batch.save();
  const settled = await sweepMergedWorktrees({ ...batch.options, previous: active });
  expect(settled.kept[0]!.reason).toBe("retention");
  const removed = await sweepMergedWorktrees({ ...batch.options, previous: settled,
    now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS });
  expect(removed.removed).toHaveLength(1);
});

test.each(["state-file", "deleted-state-file", "unlinked-state-file", "run-directory", "run-log", "deleted-run-log"])("a process holding a merger's %s keeps a settled batch while running elsewhere", async held => {
  const batch = mergerBatch();
  batch.state.rows[1]!.status = "needs-review";
  batch.save();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  if (held === "unlinked-state-file") fs.unlinkSync(batch.file);
  const report = await sweepMergedWorktrees({ ...batch.options, previous: old,
    scan: () => ({ ownNamespace: null, processes: [{ pid: 7654321, namespace: null, stamped: true,
      paths: [batch.root, held === "run-directory" ? batch.run : held.endsWith("run-log") ? path.join(batch.run, "logs/resolve.log") + (held === "deleted-run-log" ? " (deleted)" : "") : batch.file + (held.endsWith("state-file") && held !== "state-file" ? " (deleted)" : "")] }] }) });
  expect(report.kept).toEqual([expect.objectContaining({ path: batch.dir, reason: "in-use", detail: `pid 7654321 holds merge batch ${held === "run-directory" || held.endsWith("run-log") ? "run" : "state"}` })]);
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
});

test.skipIf(process.platform !== "linux")("a real open descriptor to an unlinked merger state preserves its checkout and branch", async () => {
  const batch = mergerBatch();
  batch.state.rows[1]!.status = "needs-review";
  batch.save();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  const fd = fs.openSync(batch.file, "r");
  try {
    fs.unlinkSync(batch.file);
    const report = await sweepMergedWorktrees({ ...batch.options, previous: old, scan: () => scanProcesses() });
    expect(report.removed).toHaveLength(0);
    expect(report.kept[0]!.reason).toBe("in-use");
    expect(report.kept[0]!.detail).toBe(`pid ${process.pid} holds merge batch state`);
    expect(fs.existsSync(batch.dir)).toBe(true);
    expect(branchExists(batch.root, batch.branch)).toBe(true);
  } finally { fs.closeSync(fd); }
});

for (const unlinked of [false, true]) test.skipIf(process.platform !== "linux")(`a real merger log descriptor retains its batch when unlinked=${unlinked}`, async () => {
  const batch = mergerBatch();
  batch.state.rows[1]!.status = "needs-review";
  batch.save();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  const log = path.join(batch.run, "logs/resolve.log");
  fs.mkdirSync(path.dirname(log));
  fs.writeFileSync(log, "active resolution");
  const fd = fs.openSync(log, "r");
  let held = old;
  try {
    if (unlinked) fs.unlinkSync(log);
    const report = await sweepMergedWorktrees({ ...batch.options, previous: old, scan: () => scanProcesses() });
    held = report;
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([expect.objectContaining({ path: batch.dir, reason: "in-use", detail: `pid ${process.pid} holds merge batch run` })]);
    expect(fs.existsSync(batch.dir)).toBe(true);
    expect(branchExists(batch.root, batch.branch)).toBe(true);
  } finally { fs.closeSync(fd); }
  const resumed = await sweepMergedWorktrees({ ...batch.options, previous: held, scan: () => scanProcesses() });
  expect(resumed.kept[0]?.reason).toBe("retention");
  expect(branchExists(batch.root, batch.branch)).toBe(true);
  const finished = await sweepMergedWorktrees({ ...batch.options, previous: resumed,
    now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS, scan: () => scanProcesses() });
  expect(finished.removed).toHaveLength(1);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
}, 15_000);

test.skipIf(process.platform === "win32")("an aliased merger log path holds the physical run", async () => {
  const batch = mergerBatch();
  batch.state.rows[1]!.status = "needs-review";
  batch.save();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  const alias = path.join(caseDir, "run-alias");
  fs.symlinkSync(batch.run, alias);
  const report = await sweepMergedWorktrees({ ...batch.options, previous: old,
    scan: () => ({ ownNamespace: null, processes: [{ pid: 7654321, namespace: null, stamped: true, paths: [path.join(alias, "logs/resolve.log")] }] }) });
  expect(report.kept[0]?.reason).toBe("in-use");
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
});

test("a merger log holder acquired during measurement prevents removal", async () => {
  const batch = mergerBatch();
  batch.state.rows[1]!.status = "needs-review";
  batch.save();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  let active = false;
  const report = await sweepMergedWorktrees({ ...batch.options, previous: old,
    measure: async () => { active = true; return 123; },
    scan: () => ({ ownNamespace: null, processes: active ? [{ pid: 7654321, namespace: null, stamped: true, paths: [path.join(batch.run, "logs/resolve.log")] }] : [] }) });
  expect(report.kept[0]?.reason).toBe("in-use");
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
});

test.each(["measurement", "final-status"])("merger ownership acquired during %s is rechecked before removal", async phase => {
  const batch = mergerBatch();
  batch.state.rows[1]!.status = "needs-review";
  batch.save();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  const acquire = () => { batch.state.rows[1]!.status = "deferred"; batch.save(); };
  let statuses = 0;
  const report = await sweepMergedWorktrees({ ...batch.options, previous: old,
    measure: async () => { if (phase === "measurement") acquire(); return 123; },
    git: async (args, cwd) => {
      const result = await batch.options.git(args, cwd);
      if (cwd === batch.dir && args[0] === "status" && ++statuses === 2 && phase === "final-status") acquire();
      return result;
    } });
  expect(report.removed).toHaveLength(0);
  expect(report.kept[0]!.reason).toBe("in-use");
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
});

test.each(["closing-originals", "resolution", "locked", "malformed"])("a batch's %s ownership keeps its merged checkout", async phase => {
  const batch = mergerBatch();
  const old = await sweepMergedWorktrees({ ...batch.options, now: () => RETAIN_NOW - FINISHED_WORKTREE_RETENTION_MS });
  batch.state.rows[1]!.status = "needs-review";
  if (phase === "closing-originals") batch.state.rows[0]!.detail = "";
  const state = phase === "resolution" ? { ...batch.state, resolving: { number: 78, work: path.join(batch.run, "merge-resolution-fixture/checkout") } } : batch.state;
  fs.writeFileSync(batch.file, phase === "malformed" ? "{" : JSON.stringify(state));
  if (phase === "locked") fs.mkdirSync(batch.file + ".lock");
  const report = await sweepMergedWorktrees({ ...batch.options, previous: old });
  expect(report.kept[0]!.reason).toBe("in-use");
  expect(report.removed).toHaveLength(0);
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
});

test.skipIf(process.platform === "win32")("a merger state written through a symlink keeps the physical batch checkout", async () => {
  const batch = mergerBatch();
  const alias = path.join(caseDir, "run-alias");
  fs.symlinkSync(batch.run, alias);
  batch.state.work = path.join(alias, "merge-batch-fixture/checkout");
  batch.save();
  const report = await sweepMergedWorktrees(batch.options);
  expect(report.kept[0]!.reason).toBe("in-use");
  expect(fs.existsSync(batch.dir)).toBe(true);
  expect(branchExists(batch.root, batch.branch)).toBe(true);
});

test("a settled merger state with its captured test corpus releases the batch after retention", async () => {
  const batch = mergerBatch();
  batch.state.rows[1]!.status = "needs-review";
  fs.writeFileSync(batch.file, JSON.stringify({ ...batch.state, testCorpus: { "fixture.test.ts": "x".repeat(2 * 1024 * 1024) } }));
  const first = await sweepMergedWorktrees(batch.options);
  expect(first.kept[0]!.reason).toBe("retention");
  const after = await sweepMergedWorktrees({ ...batch.options, previous: first, now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS });
  expect(after.removed).toHaveLength(1);
});

test("artifact source, reports and media stay while root dependencies are trimmed", async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-artifacts"), "pipeline/artifacts");
  const artifacts = path.join(dir, ".artifacts");
  fs.mkdirSync(path.join(artifacts, "probe/node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(artifacts, "probe/node_modules/pkg/index.js"), "generated");
  fs.writeFileSync(path.join(artifacts, "probe/node_modules/unique.log"), "unique evidence");
  fs.mkdirSync(path.join(artifacts, "probe/.next"));
  fs.writeFileSync(path.join(artifacts, "probe/.next/unique.log"), "unique evidence");
  for (const name of ["report.md", "patch.ts", "capture.png"]) fs.writeFileSync(path.join(artifacts, name), "retained fixture");
  const owner = pipeline({ id: "artifacts", repoDir: root, worktreeDir: dir, branch: "pipeline/artifacts" });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], prs: [merged(121, owner.branch, tip)] }));
  expect(report.kept[0]!.reason).toBe("ignored-files");
  expect(report.trimmed.map(row => row.path)).toEqual([path.join(dir, "node_modules")]);
  expect(fs.readFileSync(path.join(artifacts, "probe/node_modules/unique.log"), "utf8")).toBe("unique evidence");
  expect(fs.readFileSync(path.join(artifacts, "probe/.next/unique.log"), "utf8")).toBe("unique evidence");
  expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
  for (const name of ["report.md", "patch.ts", "capture.png"]) expect(fs.existsSync(path.join(artifacts, name))).toBe(true);
});

test("an ignored container of Python bytecode is proven rebuildable from its actual contents", async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), "scripts/__pycache__/\n");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/module.py"), "result = 42\n");
  git(["add", "scripts/module.py"], root);
  git(["commit", "-q", "-m", "preserved bytecode input"], root);
  const { dir, tip } = lane(root, path.join(caseDir, "bytecode"), "topic/bytecode");
  fs.mkdirSync(path.join(dir, "scripts/__pycache__"));
  fs.writeFileSync(path.join(dir, "scripts/__pycache__/module.cpython-312.pyc"), "bytecode");
  expect((await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(122, "topic/bytecode", tip)] }))).removed).toHaveLength(1);
});

test("a newly written ignored artifact during measurement refuses removal", async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "late-artifact"), "topic/late-artifact");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(123, "topic/late-artifact", tip)], measure: async () => {
    fs.mkdirSync(path.join(dir, ".artifacts")); fs.writeFileSync(path.join(dir, ".artifacts/report.md"), "keep"); return 100;
  } }));
  expect(report.kept[0]!.reason).toBe("ignored-files");
  expect(fs.existsSync(dir)).toBe(true);
});

test("past retention, a remote that does not answer proves nothing and the checkout stays", async () => {
  const root = repository();
  git(["remote", "set-url", "origin", path.join(caseDir, "no-such-remote.git")], root);
  const { dir } = lane(root, path.join(caseDir, "widgets-pipeline-offline"), "pipeline/offline");
  const owner = pipeline({ id: "offline", repoDir: root, worktreeDir: dir, branch: "pipeline/offline", closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(report.kept).toEqual([expect.objectContaining({ path: dir, reason: "local-only-commits", detail: expect.stringContaining("no remote") })]);
  expect(fs.existsSync(dir)).toBe(true);
  expect(branchExists(root, "pipeline/offline")).toBe(true);
});

test("a retained lane whose HEAD equals its base releases its checkout and keeps its branch", async () => {
  const root = repository();
  git(["commit", "-q", "--allow-empty", "-m", "local base"], root);
  const dir = path.join(caseDir, "widgets-pipeline-localbase");
  git(["worktree", "add", "-q", "-b", "pipeline/localbase", dir, "main"], root);
  const baseRef = git(["rev-parse", "HEAD"], dir);
  git(["remote", "set-url", "origin", path.join(caseDir, "no-such-remote.git")], root);
  const owner = pipeline({ id: "localbase", repoDir: root, worktreeDir: dir, branch: "pipeline/localbase", baseRef, closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(report.removed).toEqual([expect.objectContaining({ path: dir, preservation: "base" })]);
  expect(branchExists(root, "pipeline/localbase")).toBe(true);
});

test("a local branch advanced after checkout removal keeps its unpublished commit", async () => {
  const root = repository(); remoteRepository(root);
  const { dir, tip } = lane(root, path.join(caseDir, "advance-ref"), "topic/advance-ref");
  git(["push", "-q", "origin", "topic/advance-ref"], root);
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/advance-ref", closedAt: OLD_TERMINAL });
  const ordinary = ports({ pipelines: [owner], now: () => RETAIN_NOW });
  const report = await sweepMergedWorktrees(ordinary);
  const advanced = git(["commit-tree", git(["rev-parse", `${tip}^{tree}`], root), "-p", tip, "-m", "local-only follow-up"], root);
  git(["update-ref", "refs/heads/topic/advance-ref", advanced, tip], root);
  expect(report.removed).toHaveLength(1);
  expect(advanced).not.toBe("");
  expect(git(["rev-parse", "refs/heads/topic/advance-ref"], root)).toBe(advanced);
  expect(git(["rev-list", "--count", `${tip}..topic/advance-ref`], root)).toBe("1");
  expect(report.errors).toEqual([]);
});

test("a symbolic lane ref and its checked-out main target survive cleanup", async () => {
  const root = repository(); remoteRepository(root);
  const { dir } = lane(root, path.join(caseDir, "symbolic-ref"), "topic/symbolic-ref");
  git(["merge", "--ff-only", "topic/symbolic-ref"], root);
  const main = git(["rev-parse", "refs/heads/main"], root);
  git(["push", "-q", "origin", "main", "topic/symbolic-ref"], root);
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/symbolic-ref", closedAt: OLD_TERMINAL });
  git(["symbolic-ref", "refs/heads/topic/symbolic-ref", "refs/heads/main"], root);
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  expect(report.removed).toHaveLength(1);
  expect(git(["rev-parse", "refs/heads/main"], root)).toBe(main);
  expect(git(["symbolic-ref", "--short", "HEAD"], root)).toBe("main");
  expect(git(["symbolic-ref", "refs/heads/topic/symbolic-ref"], root)).toBe("refs/heads/main");
});

test.each(["attached", "detached"].flatMap(attachment => ["final-status", "final-head", "last-files"].map(phase => [attachment, phase])))("an %s commit attempted during %s keeps its checkout and source", async (attachment, phase) => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "final-status-commit"), "topic/final-status-commit");
  if (attachment === "detached") git(["checkout", "--detach", "-q"], dir);
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/final-status-commit" });
  const ordinary = ports({ pipelines: [owner], prs: [merged(170, owner.branch, tip)] });
  let statuses = 0;
  let attempted = false;
  const report = await sweepMergedWorktrees({ ...ordinary, git: async (args, cwd) => {
    const result = await ordinary.git(args, cwd);
    const inject = phase === "final-status" ? args[0] === "status" && ++statuses === 2
      : phase === "final-head" ? args.join(" ") === "rev-parse --verify HEAD"
      : args.join(" ") === "ls-files --cached -v -z";
    if (inject && !attempted) {
      attempted = true;
      fs.writeFileSync(path.join(dir, "unique.txt"), "private detached work");
      git(["add", "unique.txt"], dir);
      const commit = spawnSync("git", ["-c", "user.name=Sweep Test", "-c", "user.email=sweep@example.invalid", "commit", "-q", "-m", "private detached work"], { cwd: dir, encoding: "utf8" });
      expect(commit.status).not.toBe(0);
      expect(commit.stderr).toContain("cannot lock ref 'HEAD'");
    }
    return result;
  } });
  expect(report.removed).toEqual([]);
  expect(attempted).toBe(true);
  expect(report.kept[0]!.reason).toBe(phase === "last-files" ? "ignored-files" : "uncommitted");
  expect(git(["rev-parse", "HEAD"], dir)).toBe(tip);
  expect(fs.readFileSync(path.join(dir, "unique.txt"), "utf8")).toBe("private detached work");
  // Releasing the sweep's locks lets retained work be committed normally.
  git(["commit", "-q", "-m", "retained detached work"], dir);
  expect(git(["rev-parse", "HEAD"], dir)).not.toBe(tip);
});

test.each(["final-head", "last-files"])("new ignored evidence during %s survives the final inventory", async phase => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\nsrc/private/\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/public.ts"), "export {};\n");
  git(["add", "src/public.ts"], root);
  git(["commit", "-q", "-m", "tracked directory"], root);
  const { dir, tip } = lane(root, path.join(caseDir, "late-evidence"), "topic/late-evidence");
  const ordinary = ports({ repositories: [root], prs: [merged(171, "topic/late-evidence", tip)] });
  const captures = [path.join(dir, ".artifacts/unique.log"), path.join(dir, "src/private/trace.zip")];
  let wrote = false;
  const report = await sweepMergedWorktrees({ ...ordinary, git: async (args, cwd) => {
    const result = await ordinary.git(args, cwd);
    if (cwd === dir && args.join(" ") === (phase === "final-head" ? "rev-parse --verify HEAD" : "ls-files --cached -v -z")) {
      for (const capture of captures) {
        fs.mkdirSync(path.dirname(capture), { recursive: true });
        fs.writeFileSync(capture, "unique evidence");
      }
      wrote = true;
    }
    return result;
  } });
  expect(wrote).toBe(true);
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("ignored-files");
  for (const capture of captures) expect(fs.readFileSync(capture, "utf8")).toBe("unique evidence");
});

test.each([".artifacts/only.pyc", "scripts/only.pyc", "only.pyc"])("sourceless bytecode %s stays", async relative => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\nscripts/\n*.pyc\n");
  const { dir, tip } = lane(root, path.join(caseDir, "bytecode-evidence"), "topic/bytecode-evidence");
  const artifact = path.join(dir, relative);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, "unique bytecode without retained source");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(172, "topic/bytecode-evidence", tip)] }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("ignored-files");
  expect(fs.readFileSync(artifact, "utf8")).toBe("unique bytecode without retained source");
});

test("kept nested checkouts contribute their allocated bytes once", async () => {
  const root = repository();
  const outer = lane(root, path.join(caseDir, "outer-report"), "topic/outer-report");
  const inner = lane(root, path.join(outer.dir, "node_modules/inner"), "topic/inner-report");
  fs.writeFileSync(path.join(inner.dir, "unique.log"), Buffer.alloc(256 * 1024, 1));
  const physical = await exclusiveBytes(outer.dir);
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(173, "topic/outer-report", outer.tip)] }));
  expect(report.removed).toEqual([]);
  expect(report.kept).toHaveLength(2);
  expect(report.kept.reduce((sum, row) => sum + (row.bytes ?? 0), 0)).toBe(physical);
  expect(Object.values(report.keptBytes).reduce((sum, bytes) => sum + (bytes ?? 0), 0)).toBe(physical);
  expect(fs.existsSync(inner.dir)).toBe(true);
});

test.each([false, true])("nested evidence contributes bytes to its own decision hold with hard links=%s", async hardlinked => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const outer = lane(root, path.join(caseDir, "outer-evidence-report"), "topic/outer-evidence-report");
  const inner = lane(root, path.join(outer.dir, "node_modules/inner"), "topic/inner-evidence-report");
  const capture = path.join(inner.dir, ".artifacts/capture.png");
  fs.mkdirSync(path.dirname(capture));
  fs.writeFileSync(capture, Buffer.alloc(256 * 1024, 1));
  if (hardlinked) fs.linkSync(capture, path.join(outer.dir, "node_modules/shared-capture.png"));
  const physical = await exclusiveBytes(outer.dir) + (hardlinked ? fs.statSync(capture).blocks * 512 : 0);
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(174, "topic/outer-evidence-report", outer.tip), merged(175, "topic/inner-evidence-report", inner.tip)] }));
  const held = report.kept.find(row => row.path === inner.dir)!;
  expect(held.reason).toBe("ignored-files");
  expect(held.bytes).toBeGreaterThanOrEqual(fs.statSync(capture).blocks * 512);
  expect(worktreeSweepStatus(report)?.waitsForDecisionBytes).toBe(held.bytes);
  expect(report.kept.reduce((sum, row) => sum + (row.bytes ?? 0), 0)).toBe(physical);
});

test("a branch attached to a new checkout after removal is retained", async () => {
  const root = repository(); remoteRepository(root);
  const { dir } = lane(root, path.join(caseDir, "reattach-ref"), "topic/reattach-ref");
  git(["push", "-q", "origin", "topic/reattach-ref"], root);
  const other = path.join(caseDir, "new-owner");
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/reattach-ref", closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW }));
  git(["worktree", "add", "-q", other, "topic/reattach-ref"], root);
  expect(report.removed).toHaveLength(1);
  expect(branchExists(root, "topic/reattach-ref")).toBe(true);
  expect(git(["symbolic-ref", "--short", "HEAD"], other)).toBe("topic/reattach-ref");
});

test("a new checkout acquiring the lane branch at deletion retains its ref and source", async () => {
  const root = repository(); remoteRepository(root);
  const branch = "topic/late-branch-owner";
  const { dir, tip } = lane(root, path.join(caseDir, "old-branch-owner"), branch);
  git(["push", "-q", "origin", branch], root);
  const other = path.join(caseDir, "late-branch-owner");
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch, closedAt: OLD_TERMINAL });
  const ordinary = ports({ pipelines: [owner], now: () => RETAIN_NOW });
  let acquired = false;
  const report = await sweepMergedWorktrees({ ...ordinary, git: async (args, cwd) => {
    if (args[0] === "update-ref" && args.includes("-d")) {
      git(["worktree", "add", "-q", other, branch], root);
      acquired = true;
    }
    return ordinary.git(args, cwd);
  } });
  if (!acquired) git(["worktree", "add", "-q", other, branch], root);
  expect(report.removed).toHaveLength(1);
  expect(branchExists(root, branch)).toBe(true);
  expect(git(["rev-parse", "HEAD"], other)).toBe(tip);
  expect(fs.readFileSync(path.join(other, `${branch.replace(/\W/g, "-")}.txt`), "utf8")).toBe(`${branch}\n`);
});

test("a checkout made by hand outside a temp root is never retained, however old", async () => {
  const root = repository(); remoteRepository(root);
  const dir = path.join(caseDir, "hand-made");
  git(["worktree", "add", "-q", "--detach", dir, "main"], root);
  const first = await sweepMergedWorktrees(ports({ repositories: [root], now: () => RETAIN_NOW }));
  const later = await sweepMergedWorktrees(ports({ repositories: [root], previous: first, now: () => RETAIN_NOW + 10 * FINISHED_WORKTREE_RETENTION_MS }));
  expect(later.removed).toEqual([]);
  expect(later.kept).toEqual([expect.objectContaining({ path: dir, reason: "no-merged-pr" })]);
  expect(later.kept[0]!.firstSettledAt).toBeUndefined();
  expect(fs.existsSync(dir)).toBe(true);
});

test("activity restarts the retention clock of a role's temp checkout", async () => {
  const root = repository(); remoteRepository(root);
  const temp = path.join(caseDir, "tmp");
  const dir = path.join(temp, "llv-merge-batch/checkout");
  git(["worktree", "add", "-q", "--detach", dir, "main"], root);
  const first = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], now: () => RETAIN_NOW }));
  const busy = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], previous: first, conversationCwds: () => [dir], now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS }));
  expect(busy.kept).toEqual([{ path: dir, reason: "live-conversation", bytes: expect.any(Number) }]);
  const quiet = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], previous: busy, now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS + 1 }));
  expect(quiet.kept).toEqual([expect.objectContaining({ path: dir, reason: "retention" })]);
  expect(fs.existsSync(dir)).toBe(true);
});

test("self-update's release checkouts are left to self-update", async () => {
  const root = repository(); remoteRepository(root);
  const temp = path.join(caseDir, "tmp");
  const release = path.join(temp, "delegatus/self-update/install-a/releases", git(["rev-parse", "HEAD"], root).slice(0, 12));
  git(["worktree", "add", "-q", "--detach", release, "main"], root);
  const first = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], now: () => RETAIN_NOW }));
  const later = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], previous: first, now: () => RETAIN_NOW + 10 * FINISHED_WORKTREE_RETENTION_MS }));
  expect(later.removed).toEqual([]);
  expect(later.kept).toEqual([expect.objectContaining({ path: release, reason: "self-update-release" })]);
  expect(fs.existsSync(release)).toBe(true);
});

test.each(["node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", "out", "dist", "build", "coverage",
  "test-results", "playwright-report", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis",
  ".venv", "venv", ".tox", ".nox", "pkg.egg-info"].flatMap(name => ["merged", "remote"].map(state => [name, state] as const)))("nonempty ignored %s releases a finished %s lane", async (name, state) => {
  const root = repository(); remoteRepository(root);
  fs.appendFileSync(path.join(root, ".git/info/exclude"), `${name}/\n.artifacts/\n`);
  const branch = "topic/generated-output";
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-generated"), branch);
  git(["push", "-q", "origin", branch], root);
  const output = path.join(dir, name, "generated");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "output.js"), "generated output");
  // Caches that ignore their own entries appear file-by-file in Git status.
  fs.writeFileSync(path.join(dir, name, ".gitignore"), "*\n");
  const report = await sweepMergedWorktrees(ports({ pipelines: [pipeline({ id: "generated", repoDir: root, worktreeDir: dir, branch, closedAt: OLD_TERMINAL })], now: () => RETAIN_NOW,
    prs: state === "merged" ? [merged(135, branch, tip)] : [] }));
  expect(report.removed.map(row => row.path)).toEqual([dir]);
  expect(report.kept).toEqual([]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(report.trimmed).toEqual([]);
  expect(branchExists(root, branch)).toBe(true);
});

test.each(["node_modules", "shared-output"])("an ignored %s symlink releases its checkout and keeps its target", async name => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), `${name}\n`);
  const { dir, tip } = lane(root, path.join(caseDir, "dependency-source"), "topic/dependency-source");
  if (name === "node_modules") fs.rmSync(path.join(dir, name), { recursive: true });
  const outside = path.join(caseDir, "shared-dependencies");
  fs.mkdirSync(outside);
  const source = path.join(outside, "index.js");
  fs.writeFileSync(source, "shared dependency");
  fs.symlinkSync(outside, path.join(dir, name));
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(136, "topic/dependency-source", tip)] }));
  expect(report.removed.map(row => row.path)).toEqual([dir]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(fs.readFileSync(source, "utf8")).toBe("shared dependency");
});

for (const name of [".venv-lane", ".venv", ".cache/.venv", ".next/.venv", "node_modules/.venv"]) test(`an artifact virtual environment ${name} preserves logs and source`, async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-venv"), "topic/venv");
  const venv = path.join(dir, ".artifacts", name);
  fs.mkdirSync(path.join(venv, "lib"), { recursive: true });
  fs.writeFileSync(path.join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
  /* Python's own venv writes a `*` .gitignore, so git lists each entry. */
  fs.writeFileSync(path.join(venv, ".gitignore"), "*\n");
  fs.writeFileSync(path.join(venv, "lib/site.py"), "installed");
  fs.writeFileSync(path.join(venv, "unique-run.log"), "unique log");
  fs.mkdirSync(path.join(venv, "out"));
  fs.writeFileSync(path.join(venv, "out/desktop.png"), "unique capture");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], pipelines: [pipeline({ id: "venv", repoDir: root, worktreeDir: dir, branch: "topic/venv" })], prs: [merged(131, "topic/venv", tip)] }));
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([expect.objectContaining({ path: dir, reason: "ignored-files" })]);
  expect(fs.readFileSync(path.join(venv, "unique-run.log"), "utf8")).toBe("unique log");
  expect(fs.readFileSync(path.join(venv, "lib/site.py"), "utf8")).toBe("installed");
  expect(fs.readFileSync(path.join(venv, "out/desktop.png"), "utf8")).toBe("unique capture");
});

test.each([".cache", ".next", "node_modules"])("%s preserves a collapsed nested evidence container", async name => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), `${name}/\n`);
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-evidence"), "topic/evidence");
  const evidence = path.join(dir, name, ".artifacts");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "capture.png"), "unique capture");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], pipelines: [pipeline({ id: "evidence", repoDir: root, worktreeDir: dir, branch: "topic/evidence" })], prs: [merged(132, "topic/evidence", tip)] }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]?.reason).toBe("ignored-files");
  expect(fs.readFileSync(path.join(evidence, "capture.png"), "utf8")).toBe("unique capture");
});

test.each([".venv", "environment"])("a fixture bundle preserves %s contents added during trim measurement", async name => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".next/\n.artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-late-env"), "topic/late-env");
  fs.mkdirSync(path.join(dir, ".artifacts"));
  fs.writeFileSync(path.join(dir, ".artifacts/capture.png"), "unique capture");
  const cache = path.join(dir, ".artifacts/board/bundle");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "case.fixture.js"), "generated");
  const log = path.join(cache, name, "unique.log");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], pipelines: [pipeline({ id: "late-env", repoDir: root, worktreeDir: dir, branch: "topic/late-env" })], prs: [merged(133, "topic/late-env", tip)],
    measure: async directory => {
      if (directory === cache) {
        fs.mkdirSync(path.dirname(log), { recursive: true });
        fs.writeFileSync(path.join(path.dirname(log), "pyvenv.cfg"), "home = /usr/bin\n");
        fs.writeFileSync(log, "unique log");
      }
      return 123;
    } }));
  expect(report.trimmed.some(row => row.path === cache)).toBe(false);
  expect(fs.readFileSync(log, "utf8")).toBe("unique log");
});

test("a fixture bundle is trimmed only when it holds nothing but bundled fixtures", async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-bundles"), "pipeline/bundles");
  const generated = path.join(dir, ".artifacts/board/bundle");
  const handwritten = path.join(dir, ".artifacts/notes/bundle");
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(handwritten, { recursive: true });
  fs.writeFileSync(path.join(generated, "issue1695Evidence.fixture.js"), "bundled");
  fs.writeFileSync(path.join(dir, ".artifacts/board/desktop.png"), "capture");
  fs.writeFileSync(path.join(handwritten, "plan.md"), "keep");
  const owner = pipeline({ id: "bundles", repoDir: root, worktreeDir: dir, branch: "pipeline/bundles" });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], prs: [merged(132, owner.branch, tip)] }));
  expect(report.kept[0]!.reason).toBe("ignored-files");
  expect(report.trimmed.map((row) => row.path)).toContain(generated);
  expect(fs.existsSync(generated)).toBe(false);
  expect(fs.readFileSync(path.join(handwritten, "plan.md"), "utf8")).toBe("keep");
  expect(fs.existsSync(path.join(dir, ".artifacts/board/desktop.png"))).toBe(true);
});

test.each(["measurement", "last-tracked-check"])("a fixture bundle gaining a unique log during %s is kept intact", async phase => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-bundles"), "pipeline/bundles");
  const bundle = path.join(dir, ".artifacts/board/bundle");
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, "issue1695Evidence.fixture.js"), "bundled");
  const owner = pipeline({ id: "bundles", repoDir: root, worktreeDir: dir, branch: "pipeline/bundles" });
  let checks = 0;
  const addLog = () => fs.writeFileSync(path.join(bundle, "unique.log"), "keep this evidence");
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], prs: [merged(132, owner.branch, tip)],
    measure: async target => { if (target === bundle && phase === "measurement") addLog(); return 123; },
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      if (args[0] === "ls-files" && args.at(-1) === ".artifacts/board/bundle" && ++checks === 2 && phase === "last-tracked-check") addLog();
      return result;
    } }));
  expect(report.trimmed.map(row => row.path)).not.toContain(bundle);
  expect(fs.readFileSync(path.join(bundle, "unique.log"), "utf8")).toBe("keep this evidence");
  expect(fs.readFileSync(path.join(bundle, "issue1695Evidence.fixture.js"), "utf8")).toBe("bundled");
});

test.each(["checkout-link", "artifact-link", "checkout-directory", "cache-directory"])("cache trimming preserves redirected %s destinations", async change => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".next/\n.artifacts/\n");
  const { dir, tip } = lane(root, `${root}-pipeline-redirect`, "pipeline/redirect");
  const artifact = change === "artifact-link";
  const relative = ".artifacts/board/bundle";
  const candidate = path.join(dir, relative);
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, "case.fixture.js"), "generated");
  fs.mkdirSync(path.join(dir, ".artifacts"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".artifacts/capture.png"), "retain checkout");
  const external = path.join(caseDir, "external");
  const evidence = path.join(external, artifact ? "bundle/external.fixture.js" : ".artifacts/board/bundle/external.fixture.js");
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, "external evidence");
  const owner = pipeline({ id: "redirect", repoDir: root, worktreeDir: dir, branch: "pipeline/redirect" });
  let checks = 0;
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], prs: [merged(132, owner.branch, tip)],
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      if (args[0] === "ls-files" && args.at(-1) === relative && ++checks === 2) {
        const destination = artifact ? path.join(dir, ".artifacts/board") : change === "cache-directory" ? candidate : dir;
        fs.renameSync(destination, path.join(caseDir, "moved"));
        if (change.endsWith("link")) fs.symlinkSync(external, destination, "dir");
        else {
          const replacement = change === "cache-directory" ? destination : path.join(destination, relative);
          fs.mkdirSync(replacement, { recursive: true });
          fs.renameSync(evidence, path.join(replacement, "external.fixture.js"));
        }
      }
      return result;
    } }));
  expect(checks).toBe(2);
  expect(report.trimmed.map(row => row.path)).not.toContain(candidate);
  const retained = change.endsWith("link") ? evidence : path.join(candidate, "external.fixture.js");
  expect(fs.readFileSync(retained, "utf8")).toBe("external evidence");
});

test("artifact trimming stops at a foreign repository before its dependency trees", async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-foreign"), "pipeline/foreign");
  const foreign = path.join(dir, ".artifacts/source");
  fs.mkdirSync(foreign, { recursive: true });
  git(["init", "-q"], foreign);
  fs.mkdirSync(path.join(foreign, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "node_modules/unique.log"), "foreign evidence");
  const owner = pipeline({ id: "foreign", repoDir: root, worktreeDir: dir, branch: "pipeline/foreign" });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], prs: [merged(133, owner.branch, tip)] }));
  expect(report.trimmed.map(row => row.path)).not.toContain(path.join(foreign, "node_modules"));
  expect(fs.readFileSync(path.join(foreign, "node_modules/unique.log"), "utf8")).toBe("foreign evidence");
});

test.each(["initial", "measurement", "bare"])("a foreign repository in ignored dependencies stays after %s inspection", async phase => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "foreign-dependencies"), "topic/foreign-dependencies");
  const foreign = path.join(dir, "node_modules/private-source");
  let localTip = "";
  const create = () => {
    fs.mkdirSync(foreign, { recursive: true });
    if (phase === "bare") {
      git(["init", "-q", "--bare"], foreign);
      localTip = git(["commit-tree", git(["mktree"], foreign), "-m", "private work"], foreign);
      git(["update-ref", "refs/heads/private", localTip], foreign);
    } else {
      git(["init", "-q", "-b", "main"], foreign);
      fs.writeFileSync(path.join(foreign, "unique.txt"), "private source\n");
      git(["add", "."], foreign); git(["commit", "-q", "-m", "private work"], foreign);
      localTip = git(["rev-parse", "HEAD"], foreign);
    }
  };
  if (phase !== "measurement") create();
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(135, "topic/foreign-dependencies", tip)],
    measure: async () => { if (phase === "measurement") create(); return 123; } }));
  expect(report.removed).toHaveLength(0);
  expect(report.kept[0]!.reason).toBe("ignored-files");
  expect(fs.existsSync(foreign)).toBe(true);
  expect(git(["rev-parse", phase === "bare" ? "refs/heads/private" : "HEAD"], foreign)).toBe(localTip);
  if (phase !== "bare") expect(fs.readFileSync(path.join(foreign, "unique.txt"), "utf8")).toBe("private source\n");
});

test.each(["nested-worktree", "foreign-repository", "locked", "process"])("cache trim rechecks %s after its last tracked-file command", async change => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-late-cache"), "pipeline/late-cache");
  const cache = path.join(dir, ".artifacts/board/bundle");
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".next/\n.artifacts/\n");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "case.fixture.js"), "keep while guarded");
  fs.mkdirSync(path.join(dir, ".artifacts"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".artifacts/unique.log"), "retain checkout");
  const owner = pipeline({ id: "late-cache", repoDir: root, worktreeDir: dir, branch: "pipeline/late-cache" });
  let checks = 0;
  let busy = false;
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], prs: [merged(134, owner.branch, tip)],
    scan: () => busy ? { ownNamespace: null, processes: [{ pid: 7654321, namespace: null, stamped: true, paths: [dir] }] } : NO_PROCESSES,
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      if (args[0] === "ls-files" && args.at(-1) === ".artifacts/board/bundle" && ++checks === 2) {
        if (change === "nested-worktree") lane(root, path.join(cache, "local-checkout"), "topic/unique-cache-inner");
        else if (change === "foreign-repository") git(["init", "-q", path.join(cache, "private-source")], root);
        else if (change === "locked") git(["worktree", "lock", dir], root);
        else busy = true;
      }
      return result;
    } }));
  expect(checks).toBe(2);
  expect(report.trimmed.map(row => row.path)).not.toContain(cache);
  expect(fs.readFileSync(path.join(cache, "case.fixture.js"), "utf8")).toBe("keep while guarded");
});


test.each(["test-results", "out", "build", "coverage", "playwright-report", "node_modules", ".next"])("an artifact container containing only %s evidence keeps its files", async name => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "evidence"), "topic/evidence");
  const capture = path.join(dir, ".artifacts/run", name, "capture.png");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  fs.writeFileSync(capture, "retained capture");
  const trace = path.join(path.dirname(capture), "trace.zip");
  fs.writeFileSync(trace, "retained trace");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(141, "topic/evidence", tip)] }));
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([expect.objectContaining({ path: dir, reason: "ignored-files" })]);
  expect(fs.readFileSync(capture, "utf8")).toBe("retained capture");
  expect(fs.readFileSync(trace, "utf8")).toBe("retained trace");
});

test.each(["node_modules", ".next", ".cache", "test-results", "playwright-report", "out", "build", "dist", "coverage"].flatMap(name =>
  ["merged", "retained", "local-only"].map(state => [name, state] as const)))("ignored %s bulk is trimmed in a %s finished lane with artifacts", async (name, state) => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), `${name}/\n.artifacts/\n`);
  remoteRepository(root);
  const branch = "topic/evidence-output";
  const { dir, tip } = lane(root, path.join(caseDir, "widgets-pipeline-evidence-output"), branch);
  if (state !== "local-only") git(["push", "-q", "origin", branch], root);
  const evidence = path.join(dir, name, "run");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "output.js"), "generated output");
  const capture = path.join(dir, ".artifacts/capture.png");
  fs.mkdirSync(path.dirname(capture));
  fs.writeFileSync(capture, "retained capture");
  const owner = pipeline({ id: "evidence-output", repoDir: root, worktreeDir: dir, branch, closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW,
    prs: state === "merged" ? [merged(142, branch, tip)] : [] }));
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([expect.objectContaining({ path: dir, reason: "ignored-files" })]);
  expect(fs.existsSync(path.join(dir, name))).toBe(false);
  expect(fs.readFileSync(capture, "utf8")).toBe("retained capture");
  expect(branchExists(root, branch)).toBeTrue();
  expect(report.trimmed.map(row => row.path)).toContain(path.join(dir, name));
  expect(report.trimmedBytes).toBeGreaterThan(0);
});

test("a local-path remote does not prove preservation elsewhere", async () => {
  const root = repository(); remoteRepository(root);
  const { dir } = lane(root, path.join(caseDir, "local-remote"), "topic/local-remote");
  git(["push", "-q", "origin", "topic/local-remote"], root);
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/local-remote", closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ git: realGit, pipelines: [owner], now: () => RETAIN_NOW }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("local-only-commits");
  expect(fs.existsSync(dir)).toBe(true);
});

test("a remote branch deleted during measurement is no longer a preservation proof", async () => {
  const root = repository(); remoteRepository(root);
  const { dir } = lane(root, path.join(caseDir, "remote-deleted"), "topic/remote-deleted");
  git(["push", "-q", "origin", "topic/remote-deleted"], root);
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/remote-deleted", closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW,
    measure: async () => { git(["push", "-q", "origin", "--delete", "topic/remote-deleted"], root); return 10; },
  }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("local-only-commits");
  expect(fs.existsSync(dir)).toBe(true);
});

test("a handmade checkout inside a temp root never gains role ownership", async () => {
  const root = repository(); remoteRepository(root);
  const temp = path.join(caseDir, "tmp");
  const dir = path.join(temp, "personal-checkout");
  git(["worktree", "add", "-q", "--detach", dir, "main"], root);
  const first = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], now: () => RETAIN_NOW }));
  const later = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], previous: first, now: () => RETAIN_NOW + 10 * FINISHED_WORKTREE_RETENTION_MS }));
  expect(later.kept[0]!.reason).toBe("no-merged-pr");
  expect(later.kept[0]!.firstSettledAt).toBeUndefined();
  expect(fs.existsSync(dir)).toBe(true);
});

for (const idle of [false, true]) test.skipIf(process.platform !== "linux")(`host temp role checkouts with idle host ${idle} use namespace Git and preserve local work`, async () => {
  const root = repository(); remoteRepository(root);
  const proc = path.join(caseDir, "proc/42");
  const namespace = "mnt:[fixture-host]";
  fs.mkdirSync(path.join(proc, "ns"), { recursive: true });
  fs.symlinkSync(namespace, path.join(proc, "ns/mnt"));
  const canonicalRoot = "/host-temp";
  const canonical = path.join(canonicalRoot, "llv-host-role/checkout");
  const actual = path.join(proc, "root", canonical);
  git(["worktree", "add", "-q", "--detach", actual, "main"], root);
  const patches: { mockRestore(): void }[] = [];
  {
    const readlink = fs.readlinkSync;
    patches.push(spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
      String(file) === "/proc/1/ns/mnt" ? namespace : Reflect.apply(readlink, fs, [file, ...args])) as typeof readlink));
  }
  if (idle) {
    const map = (file: fs.PathLike) => typeof file === "string" && (file === "/proc/1/root" || file.startsWith("/proc/1/root/"))
      ? path.join(proc, "root") + file.slice("/proc/1/root".length) : file;
    for (const method of ["statSync", "lstatSync", "realpathSync", "readdirSync", "readFileSync", "existsSync"] as const) {
      const original = fs[method];
      patches.push(spyOn(fs, method).mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
        Reflect.apply(original, fs, [map(file), ...args])) as typeof original));
    }
    for (const method of ["readdir", "lstat"] as const) {
      const original = fs.promises[method];
      patches.push(spyOn(fs.promises, method).mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
        Reflect.apply(original, fs.promises, [map(file), ...args])) as typeof original));
    }
  }
  const view = await openHostTempRoots(idle ? [{ path: canonicalRoot, via: "" }]
    : [{ path: canonicalRoot, via: path.join(proc, "root"), anchor: { pid: 42, namespace } }], { LLV_DOCKER_NSENTER_SHIMS: "1" });
  try {
    const calls: string[][] = [];
    const access = hostTempWorktreeAccess(view.roots, async (command, args, cwd) => {
      if (command === "git") {
        const answer = await realGit(args, cwd);
        return args[0] === "worktree" && args[1] === "list" ? { ...answer, stdout: answer.stdout.replaceAll(actual, canonical) } : answer;
      }
      expect(command).toBe("nsenter");
      expect(args.slice(0, 5)).toEqual(["-t", idle ? "1" : "42", "-m", "-p", "--"]);
      const sh = args.indexOf("sh");
      const hostCwd = args[sh + 1]!;
      const gitArgs = args.slice(sh + 2);
      calls.push(gitArgs);
      // Stand in for entering the fixture namespace; use real sandbox Git.
      return realGit(gitArgs.map(value => value === canonical ? actual : value), hostCwd === canonical ? actual : hostCwd);
    }, { LLV_DOCKER_NSENTER_SHIMS: "1" });
    const ordinary = ports({ repositories: [root], tempRoots: [canonicalRoot], now: () => RETAIN_NOW });
    const hostPorts: WorktreeSweepPorts = { ...ordinary, ...access,
      git: async (args, cwd) => {
        if (cwd === canonical || args[0] === "worktree" && args[1] === "remove") return access.git(args, cwd);
        const answer = args[0] === "worktree" && args[1] === "list" ? await access.git(args, cwd) : await ordinary.git(args, cwd);
        if (args[0] === "worktree" && args[1] === "list") return { ...answer, stdout: answer.stdout.replaceAll(actual, canonical) };
        return answer;
      },
      recordResolution: cwd => recordWorktreeResolution(cwd, access.accessiblePath(cwd)) !== null,
    };
    const first = await sweepMergedWorktrees(hostPorts);
    expect(first.kept[0]!.reason).toBe("retention");
    const settled = { ...hostPorts, previous: first, now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS };
    git(["commit", "--allow-empty", "-q", "-m", "private role work"], actual);
    const local = await sweepMergedWorktrees(settled);
    expect(local.kept[0]!.reason).toBe("local-only-commits");
    expect(fs.existsSync(actual)).toBe(true);
    git(["push", "-q", "origin", "HEAD:refs/heads/role-work"], actual);
    const removed = await sweepMergedWorktrees(settled);
    expect(removed.removed).toEqual([expect.objectContaining({ path: canonical, preservation: "remote-ref" })]);
    expect(calls.some(args => args[0] === "worktree" && args[1] === "remove" && !args.includes("--force"))).toBe(true);
    expect(calls.some(args => args[0] === "worktree" && args[1] === "list")).toBe(true);
    expect(fs.existsSync(actual)).toBe(false);
    const map = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"), "utf8"));
    expect(map[canonical].repo).toBe(root);
    expect(map[canonical].worktree).toBe("checkout");
  } finally { await view.close(); for (const patch of patches.reverse()) patch.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("a recycled host namespace anchor cannot redirect Git or filesystem access", async () => {
  const proc = path.join(caseDir, "proc/42");
  fs.mkdirSync(path.join(proc, "ns"), { recursive: true });
  fs.symlinkSync("mnt:[replacement]", path.join(proc, "ns/mnt"));
  let called = false;
  const readlink = fs.readlinkSync;
  const patch = spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
    String(file) === "/proc/1/ns/mnt" ? "mnt:[original]" : Reflect.apply(readlink, fs, [file, ...args])) as typeof readlink);
  const access = hostTempWorktreeAccess([{ path: "/tmp", via: path.join(proc, "root"), anchor: { pid: 42, namespace: "mnt:[original]" } }], async () => {
    called = true; return { code: 0, stdout: "", stderr: "" };
  }, { LLV_DOCKER_NSENTER_SHIMS: "1" });
  try {
  expect(access.accessiblePath("/tmp/llv-role/checkout")).toBe("/proc/0/root/tmp/llv-role/checkout");
  expect((await access.git(["worktree", "remove", "/tmp/llv-role/checkout"], caseDir)).code).toBe(1);
  expect(called).toBe(false);
  } finally { patch.mockRestore(); }
});

test("Git reporting an ignored evidence descendant directly still preserves its capture", async () => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".artifacts/run/test-results/\n");
  const { dir, tip } = lane(root, path.join(caseDir, "direct-evidence"), "topic/direct-evidence");
  const capture = path.join(dir, ".artifacts/run/test-results/failure.png");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  fs.writeFileSync(capture, "retained failure");
  const status = git(["status", "--porcelain=v1", "--ignored=matching"], dir);
  expect(status).toContain("!! .artifacts/run/test-results/");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(151, "topic/direct-evidence", tip)] }));
  expect(report.kept[0]!.reason).toBe("ignored-files");
  expect(fs.readFileSync(capture, "utf8")).toBe("retained failure");
});

test.each(["role", "pipeline"])("activity while a %s checkout is young restarts its retention clock", async kind => {
  const root = repository(); remoteRepository(root);
  const temp = path.join(caseDir, "tmp");
  const dir = kind === "role" ? path.join(temp, "llv-review-export/checkout") : path.join(caseDir, "widgets-pipeline-retained");
  git(["worktree", "add", "-q", "--detach", dir, "main"], root);
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "", closedAt: new Date(RETAIN_NOW).toISOString() });
  const options = ports({ repositories: [root], pipelines: kind === "pipeline" ? [owner] : [], tempRoots: [temp], now: () => RETAIN_NOW });
  const first = await sweepMergedWorktrees(options);
  const busy = await sweepMergedWorktrees({ ...options, previous: first, conversationCwds: () => [dir], now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS - 60_000 });
  expect(busy.kept[0]!.reason).toBe("live-conversation");
  expect(busy.kept[0]!.firstSettledAt).toBeUndefined();
  const quietAt = RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS;
  const quiet = await sweepMergedWorktrees({ ...options, previous: busy, now: () => quietAt });
  expect(quiet.removed).toEqual([]);
  expect(quiet.kept[0]!.reason).toBe("retention");
  expect(quiet.kept[0]!.firstSettledAt).toBe(new Date(quietAt).toISOString());
  expect((await sweepMergedWorktrees({ ...options, previous: quiet, now: () => quietAt + FINISHED_WORKTREE_RETENTION_MS })).removed).toHaveLength(1);
});

test.each(["scripts/", ".artifacts/__pycache__/"])("bytecode directory %s containing a unique log stays", async ignored => {
  const root = repository();
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ignored + "\n");
  const { dir, tip } = lane(root, path.join(caseDir, "bytecode-log"), "topic/bytecode-log");
  const base = ignored === "scripts/" ? "scripts/__pycache__" : ".artifacts/__pycache__";
  const log = path.join(dir, base, "run.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "unique evidence");
  fs.writeFileSync(path.join(path.dirname(log), "module.pyc"), "regenerable bytecode");
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(161, "topic/bytecode-log", tip)] }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("ignored-files");
  expect(fs.readFileSync(log, "utf8")).toBe("unique evidence");
});

test.each(["intact", "missing-marker", "hardlinked"])("worktree and temp reports partition role allocations with %s metadata", async marker => {
  const { runTempSweep, tempSweepStatus } = await import("@/lib/tempSweep");
  const root = repository(); remoteRepository(root);
  const temp = path.join(caseDir, "temp");
  const role = path.join(temp, "llv-review-export");
  const { dir } = lane(root, path.join(role, "checkout"), "topic/private-export");
  fs.writeFileSync(path.join(role, "role-output.txt"), marker === "hardlinked" ? Buffer.alloc(1024 * 1024, 1) : "retained role output");
  if (marker === "hardlinked") fs.linkSync(path.join(role, "role-output.txt"), path.join(dir, "node_modules/dep/shared-output.log"));
  const first = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], now: () => RETAIN_NOW }));
  let report = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], previous: first,
    now: () => RETAIN_NOW + FINISHED_WORKTREE_RETENTION_MS }));
  expect(report.kept[0]!.reason).toBe("local-only-commits");
  if (marker === "missing-marker") {
    fs.unlinkSync(path.join(dir, ".git"));
    report = await sweepMergedWorktrees(ports({ repositories: [root], tempRoots: [temp], previous: report,
      now: () => RETAIN_NOW + 2 * FINISHED_WORKTREE_RETENTION_MS }));
  }
  recordWorktreeSweep(report);
  const temporary = (await runTempSweep({ NODE_ENV: "test", LLV_TEMP_SWEEP_MAX_AGE_HOURS: "24" }, { roots: [{ path: temp, via: "" }],
    scan: NO_PROCESSES, now: () => Date.now() + 10 * FINISHED_WORKTREE_RETENTION_MS }))!;
  expect(temporary.removed).toEqual([]);
  expect(temporary.held).toHaveLength(1);
  const reported = Object.values(report.keptBytes).reduce((sum, bytes) => sum + (bytes ?? 0), 0)
    + Object.values(tempSweepStatus(temporary)!.heldBytes).reduce((sum, bytes) => sum + bytes, 0);
  const sharedBytes = marker === "hardlinked" ? fs.statSync(path.join(role, "role-output.txt")).blocks * 512 : 0;
  expect(reported).toBeLessThanOrEqual(await exclusiveBytes(role) + sharedBytes);
  if (marker === "hardlinked") expect(report.kept[0]!.bytes).toBeGreaterThanOrEqual(sharedBytes);
  if (marker === "hardlinked") expect(temporary.held![0]!.bytes).toBeLessThan(sharedBytes);
  else expect(temporary.held![0]!.bytes).toBeGreaterThanOrEqual(fs.statSync(path.join(role, "role-output.txt")).blocks * 512);
  expect(fs.existsSync(dir)).toBeTrue();
  expect(fs.readFileSync(path.join(role, "role-output.txt"))).toEqual(marker === "hardlinked" ? Buffer.alloc(1024 * 1024, 1) : Buffer.from("retained role output"));
});

test("a lane that settles again during measurement receives fresh retention", async () => {
  const root = repository(); remoteRepository(root);
  const { dir } = lane(root, path.join(caseDir, "resettled"), "topic/resettled");
  git(["push", "-q", "origin", "topic/resettled"], root);
  const owner = pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/resettled", closedAt: OLD_TERMINAL });
  const report = await sweepMergedWorktrees(ports({ pipelines: [owner], now: () => RETAIN_NOW,
    measure: async () => { owner.closedAt = new Date(RETAIN_NOW).toISOString(); return 10; },
  }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("retention");
  expect(fs.existsSync(dir)).toBe(true);
});


test.skipIf(process.platform === "win32")("allocated hard links count once while removal estimates exclude shared files", async () => {
  const first = path.join(caseDir, "allocation-first");
  const second = path.join(caseDir, "allocation-second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  const file = path.join(first, "shared.bin");
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 1));
  fs.linkSync(file, path.join(first, "second-link.bin"));
  fs.linkSync(file, path.join(second, "third-link.bin"));
  const bytes = fs.statSync(file).blocks * 512;
  const seen = new Set<string>();
  expect(await allocatedBytes(first, [], seen)).toBe(bytes);
  expect(await allocatedBytes(second, [], seen)).toBe(0);
  expect(await exclusiveBytes(first)).toBe(0);
});


test.each(["skip-worktree", "assume-unchanged"])("hidden tracked edits under %s retain the finished checkout until restored", async flag => {
  const root = repository(); remoteRepository(root);
  const branch = "topic/hidden-edits";
  const { dir } = lane(root, path.join(caseDir, "hidden-edits"), branch);
  git(["push", "-q", "origin", branch], root);
  const file = path.join(dir, "README.md");
  const original = fs.readFileSync(file, "utf8");
  git(["update-index", `--${flag}`, "README.md"], dir);
  fs.writeFileSync(file, "unique hidden tracked edits");
  expect(git(["status", "--porcelain=v1"], dir)).toBe("");
  const options = ports({ pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch, closedAt: OLD_TERMINAL })], now: () => RETAIN_NOW });
  const held = await sweepMergedWorktrees(options);
  expect(held.removed).toEqual([]);
  expect(held.kept[0]!.reason).toBe("uncommitted");
  expect(fs.readFileSync(file, "utf8")).toBe("unique hidden tracked edits");
  expect(branchExists(root, branch)).toBe(true);
  fs.writeFileSync(file, original);
  git(["update-index", `--no-${flag}`, "README.md"], dir);
  expect((await sweepMergedWorktrees(options)).removed).toHaveLength(1);
  expect(branchExists(root, branch)).toBe(true);
});

test.each(["none", "skip-worktree", "assume-unchanged"].flatMap(flag =>
  ["final-status", "final-head", "last-files"].map(phase => [flag, phase] as const)))("tracked edits with %s during %s preserve the checkout and branch", async (flag, phase) => {
  const root = repository();
  const branch = "topic/late-tracked-edit";
  const { dir, tip } = lane(root, path.join(caseDir, "late-tracked-edit"), branch);
  const file = path.join(dir, "README.md");
  let statuses = 0;
  let changed = false;
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(181, branch, tip)],
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      if (args[0] === "status") statuses += 1;
      const target = phase === "final-status" ? args[0] === "status" && statuses === 2
        : phase === "final-head" ? args.join(" ") === "rev-parse --verify HEAD" && statuses === 2
        : args[0] === "ls-files" && args.includes("--cached");
      if (cwd === dir && target && !changed) {
        changed = true;
        if (flag !== "none") git(["update-index", `--${flag}`, "README.md"], dir);
        fs.writeFileSync(file, "unique late tracked edits");
      }
      return result;
    } }));
  expect(changed).toBe(true);
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("uncommitted");
  expect(fs.readFileSync(file, "utf8")).toBe("unique late tracked edits");
  expect(branchExists(root, branch)).toBe(true);
});


test.each(["initial", "final"])("unreadable %s tracked inventory preserves the checkout", async phase => {
  const root = repository();
  const branch = "topic/unreadable-inventory";
  const { dir, tip } = lane(root, path.join(caseDir, "unreadable-inventory"), branch);
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(182, branch, tip)],
    git: async (args, cwd) => {
      if (cwd === dir && args[0] === "ls-files" && (phase === "initial" ? !args.includes("--cached") : args.includes("--cached")))
        return { code: 1, stdout: "", stderr: "inventory unavailable" };
      return realGit(args, cwd);
    } }));
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("uncommitted");
  expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("widgets\n");
  expect(branchExists(root, branch)).toBe(true);
});

test("same-size hidden tracked edits with restored mtime survive the last Git read", async () => {
  const root = repository();
  const branch = "topic/restored-mtime";
  const { dir, tip } = lane(root, path.join(caseDir, "restored-mtime"), branch);
  const file = path.join(dir, "README.md");
  const original = fs.statSync(file);
  let changed = false;
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(183, branch, tip)],
    git: async (args, cwd) => {
      const result = await realGit(args, cwd);
      if (cwd === dir && args[0] === "ls-files" && args.includes("--cached")) {
        changed = true;
        git(["update-index", "--skip-worktree", "README.md"], dir);
        fs.writeFileSync(file, "changed\n");
        fs.utimesSync(file, original.atime, original.mtime);
      }
      return result;
    } }));
  expect(changed).toBe(true);
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("uncommitted");
  expect(fs.readFileSync(file, "utf8")).toBe("changed\n");
  expect(branchExists(root, branch)).toBe(true);
});


test.each(["native", "unrelated-docker-view", "docker-local-copy"])("a private agent mount view leaves %s cleanup on ordinary Git", async kind => {
  const root = repository();
  const mergedLane = lane(root, path.join(caseDir, "tmp/merged"), "topic/native-merged");
  const retained = path.join(caseDir, "tmp/retained");
  git(["worktree", "add", "-q", "--detach", retained, "main"], root);
  const owners = [pipeline({ repoDir: root, worktreeDir: mergedLane.dir, branch: "topic/native-merged" }),
    pipeline({ repoDir: root, worktreeDir: retained, branch: "", baseRef: git(["rev-parse", "main"], root), closedAt: OLD_TERMINAL })];
  const commands: string[] = [];
  const access = hostTempWorktreeAccess([{ path: path.join(caseDir, "tmp"), via: "/proc/42/root", anchor: { pid: 42, namespace: kind === "docker-local-copy" ? stageHostNamespace() ?? "mnt:[unavailable]" : "mnt:[private-agent]" } }],
    async (command, args, cwd) => { commands.push(command); return realGit(args, cwd); },
    { LLV_DOCKER_NSENTER_SHIMS: kind === "native" ? "0" : "1" });
  const report = await sweepMergedWorktrees({ ...ports({ pipelines: owners, prs: [merged(250, "topic/native-merged", mergedLane.tip)], now: () => RETAIN_NOW }), ...access });
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every(command => command === "git")).toBe(true);
  expect(report.errors).toEqual([]);
  expect(report.removed.map(row => row.path).sort()).toEqual([mergedLane.dir, retained].sort());
  expect(report.kept).toEqual([]);
});

/** Kill a real sweeper at lock-publication or final-listing boundaries. All
    state and Git processes here belong to this test's sandbox. */
async function killedSweeper(root: string, dir: string, tip: string, phase: string): Promise<void> {
  const script = `
    import fs from "node:fs";
    import { realGit, sweepMergedWorktrees } from ${JSON.stringify(path.join(process.cwd(), "src/lib/pipelines/worktreeSweep.ts"))};
    const [root, dir, tip, phase] = process.argv.slice(1);
    const die = () => { fs.writeSync(1, "crash-boundary\\n"); process.kill(process.pid, "SIGKILL"); };
    let links = 0;
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      links++;
      if (phase === "prepared-head" && links === 1 || phase === "prepared-branch" && links === 2) die();
      return link(...args);
    };
    let listings = 0;
    await sweepMergedWorktrees({ mode: "on", git: async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "list" && ++listings === 2) die();
      return realGit(args, cwd);
    }, pipelines: [{ id: "crash-lane", repoDir: root, worktreeDir: dir, branch: "topic/crash", state: "completed", runs: [] }],
      mergedPullRequests: () => [{ number: 251, url: "https://github.com/example/widgets/pull/251", headRefName: "topic/crash", headRefOid: tip }],
      conversationCwds: () => [], scan: () => ({ ownNamespace: null, processes: [] }), recordResolution: () => true });
  `;
  const child = spawn(process.execPath, ["-e", script, root, dir, tip, phase], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  let errors = "";
  child.stdout!.on("data", data => { output += String(data); });
  child.stderr!.on("data", data => { errors += String(data); });
  const signal = await new Promise<string | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (_code, signal) => resolve(signal));
  });
  children.splice(children.indexOf(child), 1);
  expect(errors).toBe("");
  expect(output).toContain("crash-boundary");
  expect(signal).toBe("SIGKILL");
}

test.each(["prepared-head", "prepared-branch", "held"])("a sweeper killed at %s recovers its locks before the next sweep", async phase => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "crash-lane"), "topic/crash");
  await killedSweeper(root, dir, tip, phase);
  const headLock = git(["rev-parse", "--git-path", "HEAD.lock"], dir);
  const branchLock = path.join(root, ".git/refs/heads/topic/crash.lock");
  expect(fs.existsSync(headLock)).toBe(phase !== "prepared-head");
  expect(fs.existsSync(branchLock)).toBe(phase === "held");
  const ordinary = ports({ pipelines: [pipeline({ repoDir: root, worktreeDir: dir, branch: "topic/crash" })], prs: [merged(251, "topic/crash", tip)] });
  // Keep the checkout for one recovery pass to prove commits work again.
  const recovered = await sweepMergedWorktrees({ ...ordinary, conversationCwds: () => [dir] });
  expect(recovered.errors).toEqual([]);
  expect(recovered.kept[0]!.reason).toBe("live-conversation");
  expect(fs.existsSync(headLock)).toBe(false);
  expect(fs.existsSync(branchLock)).toBe(false);
  git(["commit", "--allow-empty", "-q", "-m", "commit after recovery"], dir);
  const newTip = git(["rev-parse", "HEAD"], dir);
  const removed = await sweepMergedWorktrees({ ...ordinary, mergedPullRequests: () => [merged(251, "topic/crash", newTip)] });
  expect(removed.errors).toEqual([]);
  expect(removed.removed.map(row => row.path)).toEqual([dir]);
  expect(fs.readdirSync(path.join(process.env.LLV_STATE_DIR!, "worktree-sweep-locks"))).toEqual([]);
});

test("recovery preserves a foreign HEAD lock that replaced the recorded inode", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "crash-lane"), "topic/crash");
  await killedSweeper(root, dir, tip, "held");
  const lock = git(["rev-parse", "--git-path", "HEAD.lock"], dir);
  fs.writeFileSync(lock + ".replacement", "foreign lock");
  fs.renameSync(lock + ".replacement", lock);
  const report = await sweepMergedWorktrees(ports({ repositories: [root], prs: [merged(251, "topic/crash", tip)] }));
  expect(report.errors).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(report.kept[0]!.reason).toBe("locked");
  expect(fs.readFileSync(lock, "utf8")).toBe("foreign lock");
});

test("another sweep preserves locks held by a living sweeper", async () => {
  const root = repository();
  const { dir, tip } = lane(root, path.join(caseDir, "live-lock-lane"), "topic/live-lock");
  const ordinary = ports({ repositories: [root], prs: [merged(252, "topic/live-lock", tip)] });
  let listings = 0;
  const report = await sweepMergedWorktrees({ ...ordinary, git: async (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "list" && ++listings === 2) {
      const concurrent = await sweepMergedWorktrees(ordinary);
      expect(concurrent.errors).toEqual([]);
      expect(concurrent.kept[0]!.reason).toBe("locked");
      expect(fs.existsSync(git(["rev-parse", "--git-path", "HEAD.lock"], dir))).toBe(true);
    }
    return ordinary.git(args, cwd);
  } });
  expect(report.errors).toEqual([]);
  expect(report.removed.map(row => row.path)).toEqual([dir]);
});
