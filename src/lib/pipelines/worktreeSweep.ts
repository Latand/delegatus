import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import type { ForgeCacheFile } from "@/lib/forge/cache";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { scanProcesses, type ProcessScan } from "@/lib/tempSweep";
import type { ExecResult } from "@/lib/workflows/provision";

import { pipelineActivitySettled, type Pipeline } from "./types";

/**
 * Removes the worktrees whose work is merged (#2202).
 *
 * Every pipeline gets its own `git worktree add` checkout and nothing removed
 * them: on 2026-09-25 the workstation held about 470 of them, 250 GB, and
 * `/home` was at 98%. This sweep removes a linked worktree of a registered
 * repository, and the local branch it had checked out, once the pull request
 * that branch delivered is merged. The pull request's state is read from the
 * forge cache the forge sweep keeps (#2059), or from `gh` when that cache holds
 * no complete read of the repository, never from ancestry against the base
 * branch: a squash merge leaves the branch's commits outside the base for ever.
 *
 * Registered repositories are the ones a pipeline ran in and the ones the
 * operator created a project from; every linked worktree git lists for them is
 * a candidate, whatever its layout (`.worktrees/<name>`, `worktrees/<name>`,
 * `.claude/worktrees/<name>`, a sibling `git worktree add ../<name>`). The main
 * checkout never is.
 *
 * Each of these keeps a worktree, and the report names which one did:
 *
 * - `open-pipeline` — a pipeline that is not completed or closed, or whose
 *   close teardown or delivery has not settled, owns it, runs inside it, or
 *   runs its git in it.
 * - `no-merged-pr` — no merged pull request has its branch as head (or is the
 *   one its pipeline delivered). A completed lane whose PR was closed or never
 *   opened stays until someone decides.
 * - `in-use` — a live process has its working directory, an open file, or its
 *   `TMPDIR`/`LLV_STATE_DIR`/`XDG_CONFIG_HOME` inside it (the `/proc` scan the
 *   temp sweep uses).
 * - `live-conversation` — a registry conversation that is hosted, starting, or
 *   holding a queued message runs there.
 * - `uncommitted` — tracked changes or untracked files; `git worktree remove`
 *   is never forced.
 * - `ignored-files` — an ignored path that is not a rebuildable output
 *   (`node_modules`, `.next`, `dist`, build caches): a `.env`, an agent's
 *   `.claude` session files, a nested repository under an ignored
 *   `.worktrees/`. `git worktree remove` deletes ignored files without asking,
 *   and the status read above never lists them.
 * - `unmerged-commits` — its HEAD is not contained in the merged PR's head
 *   commit, so something was committed after the merge or never pushed.
 * - `pr-head-unknown` — the merged PR's head commit is not in the local
 *   object store, so containment cannot be proven.
 * - `holds-worktree` — another linked worktree that stays is nested in it.
 * - `locked`, `missing` — git marks it locked, or its directory is not
 *   reachable from here.
 * - `forge-unavailable` — neither the forge cache nor `gh` answered with the
 *   repository's merged pull requests and their head commits.
 * - `map-write-failed`, `remove-failed` — the removal itself could not be
 *   made safe or did not happen.
 *
 * The process, pipeline and conversation guards are read once to skip what is
 * plainly busy, and read again immediately before each removal, after the
 * measurement: a sweep can run for minutes, and git refuses a removal only
 * when files changed, never when the directory is in use.
 *
 * Before a removal the checkout's worktree→project resolution is written to
 * `state/worktree-map.json`, so the conversations that ran there keep grouping
 * under the parent repository after the directory is gone (AGENTS.md,
 * "Worktree → project grouping").
 *
 * In the Docker install the Viewer container bind-mounts `$HOME` at the same
 * path and shares the host's pid namespace, so a worktree under `$HOME` has
 * the same path here as on the host, the image's own git removes it, and the
 * `/proc` scan sees every host process. A worktree outside `$HOME` is not
 * reachable from the container and is reported `missing`; it is never pruned.
 */

export type WorktreeSweepMode = "on" | "dry-run";

/** `LLV_WORKTREE_SWEEP`: unset or `1`/`on` sweeps, `0`/`off`/`false` turns the
    sweep off, `dry-run` reports what it would remove and removes nothing. */
export function worktreeSweepMode(env: Readonly<Record<string, string | undefined>> = process.env): WorktreeSweepMode | null {
  const raw = env.LLV_WORKTREE_SWEEP?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "1" || raw === "on" || raw === "true") return "on";
  if (raw === "0" || raw === "off" || raw === "false") return null;
  if (raw === "dry-run" || raw === "dryrun") return "dry-run";
  console.warn(`[worktree sweep] LLV_WORKTREE_SWEEP=${raw} is not on, off or dry-run; running as dry-run`);
  return "dry-run";
}

const HOUR_MS = 3_600_000;
export const WORKTREE_SWEEP_INTERVAL_MS = HOUR_MS;
/** Boot is busy enough; the first sweep waits for it to settle. */
const FIRST_SWEEP_DELAY_MS = 10 * 60_000;
/** Worktrees one sweep may remove; the rest wait for the next one. */
const MAX_REMOVALS_PER_SWEEP = 200;
/** Entries one size measurement visits before it reports a lower bound. */
const MEASURE_ENTRY_LIMIT = 400_000;
/** A spawn or resume that has not settled in this long is not coming. */
const PENDING_CONVERSATION_MS = 24 * HOUR_MS;

export type WorktreeKeptReason =
  | "open-pipeline"
  | "no-merged-pr"
  | "in-use"
  | "live-conversation"
  | "uncommitted"
  | "ignored-files"
  | "unmerged-commits"
  | "pr-head-unknown"
  | "holds-worktree"
  | "locked"
  | "missing"
  | "forge-unavailable"
  | "map-write-failed"
  | "remove-failed"
  | "deferred";

export type MergedPullRequest = { number: number; url: string; headRefName: string; headRefOid: string };

export type WorktreeRemoval = {
  path: string;
  /** Bytes only this checkout held: files with one link, so a hard-linked
      `node_modules` counts only what removing it actually frees. */
  bytes: number;
  pr: { number: number; url: string };
  branch: string | null;
  pipelineId?: string;
};

export type WorktreeKept = { path: string; reason: WorktreeKeptReason; detail?: string; pipelineId?: string };

export type WorktreeSweepReport = {
  at: string;
  mode: WorktreeSweepMode;
  repositories: string[];
  /** In a dry run, what the sweep would have removed. */
  removed: WorktreeRemoval[];
  removedBytes: number;
  kept: WorktreeKept[];
  keptCounts: Partial<Record<WorktreeKeptReason, number>>;
  errors: string[];
};

export type GitRun = (args: string[], cwd: string) => Promise<ExecResult>;

export type SweptPipeline = Pick<Pipeline, "id" | "state" | "repoDir" | "worktreeDir" | "branch" | "delivery"> &
  Partial<Pick<Pipeline, "closeTeardown" | "closeReport" | "activationCloseRequested">> & {
    runs?: Pipeline["runs"];
  };

export type WorktreeSweepPorts = {
  mode: WorktreeSweepMode;
  git: GitRun;
  /** Every merged pull request of a GitHub repository (`owner/name`), or null
      when the forge could not be read completely. */
  mergedPullRequests: (repository: string) => MergedPullRequest[] | null | Promise<MergedPullRequest[] | null>;
  /** Every pipeline, archived ones included, to match lanes with their PRs. */
  pipelines: readonly SweptPipeline[];
  /** The pipelines as they are now, read again before each removal; an open
      one is never archived. Defaults to `pipelines`. */
  currentPipelines?: () => readonly SweptPipeline[];
  /** Repository roots registered some other way (operator-created projects). */
  repositories?: readonly string[];
  /** Working directories of conversations that are live or waiting, as they
      are now; read again before each removal. */
  conversationCwds: () => readonly string[];
  scan: () => ProcessScan;
  /** Writes the checkout's resolution to the worktree map; false refuses the removal. */
  recordResolution: (worktree: string) => boolean;
  measure?: (directory: string) => Promise<number>;
  now?: () => number;
  maxRemovals?: number;
};

/* Fails closed: a state added later holds its checkout until it is listed here. */
const SETTLED_STATES: ReadonlySet<Pipeline["state"]> = new Set(["completed", "closed"]);

/** Open, or completed and closed with a teardown or delivery still in flight. */
function pipelineHoldsCheckout(pipeline: SweptPipeline): boolean {
  return !SETTLED_STATES.has(pipeline.state) || !pipelineActivitySettled(pipeline);
}

/** Ignored outputs any checkout rebuilds, which a removal may take. Anything
    else ignored keeps the worktree. */
const REBUILDABLE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", "out", "dist", "build", "coverage",
  "test-results", "playwright-report", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis",
  ".venv", "venv", ".tox", ".nox",
]);
const REBUILDABLE_FILES: ReadonlySet<string> = new Set(["next-env.d.ts", ".DS_Store"]);

/** A cache that carries its own `*` .gitignore (`.ruff_cache`, `.pytest_cache`)
    is listed file by file, so any rebuildable directory on the path counts. */
function rebuildable(ignored: string): boolean {
  const segments = ignored.replace(/\/+$/, "").split("/");
  const name = segments.at(-1) ?? "";
  if (segments.some((segment) => REBUILDABLE_DIRECTORIES.has(segment) || segment.endsWith(".egg-info"))) return true;
  return REBUILDABLE_FILES.has(name) || name.endsWith(".tsbuildinfo") || name.endsWith(".pyc");
}

function emptyDirectory(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

/** `git status --porcelain=v1 -z --ignored=matching`: the changed and
    untracked paths, and the ignored ones a removal would lose. An ignored
    directory is listed once, not descended into. */
export function classifyStatus(raw: string): { changed: string[]; ignored: string[] } {
  const changed: string[] = [];
  const ignored: string[] = [];
  const fields = raw.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    if (code === "!!") {
      if (!rebuildable(file)) ignored.push(file);
      continue;
    }
    changed.push(file);
    /* A rename or copy carries its source path in the next field. */
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return { changed, ignored };
}

function inside(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(directory + path.sep);
}

type ListedWorktree = { path: string; head: string | null; branch: string | null; locked: boolean; prunable: boolean; bare: boolean };

/** `git worktree list --porcelain -z`: records separated by an empty field. */
export function parseWorktreeList(raw: string): ListedWorktree[] {
  const out: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const field of raw.split("\0")) {
    if (field === "") {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: field.slice("worktree ".length), head: null, branch: null, locked: false, prunable: false, bare: false };
    } else if (!current) {
      continue;
    } else if (field.startsWith("HEAD ")) {
      current.head = field.slice(5);
    } else if (field.startsWith("branch ")) {
      current.branch = field.slice(7).replace(/^refs\/heads\//, "");
    } else if (field === "bare") {
      current.bare = true;
    } else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true;
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Bytes a removal frees: allocated blocks of entries with a single link,
    without following symlinks; a lower bound past the entry limit. */
export async function exclusiveBytes(directory: string): Promise<number> {
  let bytes = 0;
  let visited = 0;
  const pending = [directory];
  while (pending.length > 0 && visited < MEASURE_ENTRY_LIMIT) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const child = path.join(current, entry.name);
      try {
        const stat = await fs.promises.lstat(child);
        if (entry.isDirectory()) {
          bytes += stat.blocks * 512;
          pending.push(child);
        } else if (stat.nlink <= 1) {
          bytes += stat.blocks * 512;
        }
      } catch {
        /* Gone mid-walk. */
      }
    }
  }
  return bytes;
}

type RegistryShape = {
  entries?: Record<string, { cwd?: string; status?: string; pendingAction?: string | null; updatedAt?: string; structuredHost?: unknown }>;
  conversations?: Record<string, { generations?: Array<{ launchProfile?: { cwd?: string | null } | null }> }>;
  heldDeliveries?: Record<string, { conversationId?: string; state?: string }>;
};

/** The working directories of registry conversations that are live or
    waiting: hosted (`live`, `idle`, `handoff`), starting or resuming within
    the last day, or holding a message that is still queued for delivery. A
    `starting` row months old is a spawn that never came, and holds nothing. */
export function liveOrWaitingConversationCwds(file: RegistryShape, now = Date.now()): string[] {
  const cwds = new Set<string>();
  for (const entry of Object.values(file.entries ?? {})) {
    if (!entry?.cwd) continue;
    const hosted = entry.status === "live" || entry.status === "idle" || entry.status === "handoff";
    const updated = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
    const pending = (entry.status === "starting" || Boolean(entry.pendingAction)) && entry.status !== "dead"
      && Number.isFinite(updated) && now - updated < PENDING_CONVERSATION_MS;
    if (hosted || pending) cwds.add(entry.cwd);
  }
  for (const delivery of Object.values(file.heldDeliveries ?? {})) {
    /* `delivery-uncertain` was written and never confirmed; the reaper counts
       it as undelivered too. */
    if (delivery?.state !== "held" && delivery?.state !== "assigned" && delivery?.state !== "delivery-uncertain") continue;
    const generations = file.conversations?.[delivery.conversationId ?? ""]?.generations ?? [];
    const cwd = generations.at(-1)?.launchProfile?.cwd;
    if (cwd) cwds.add(cwd);
  }
  return [...cwds];
}

function pipelinePrCandidates(pipelines: readonly SweptPipeline[]): { heads: Set<string>; numbers: Set<number> } {
  const heads = new Set<string>();
  const numbers = new Set<number>();
  for (const pipeline of pipelines) {
    if (pipeline.branch) heads.add(pipeline.branch);
    const deliveryBranch = pipeline.delivery?.target.branch?.replace(/^refs\/heads\//, "");
    if (deliveryBranch) heads.add(deliveryBranch);
    if (pipeline.delivery?.target.pr) numbers.add(pipeline.delivery.target.pr);
    for (const run of pipeline.runs ?? []) for (const attempt of run.attempts ?? []) {
      const number = attempt.report?.provenance?.pullRequest?.number;
      if (Number.isSafeInteger(number) && number) numbers.add(number);
    }
  }
  return { heads, numbers };
}

/** What the checkout has checked out now, read in the checkout itself: the
    listing is minutes old by the time a sweep of hundreds reaches it. */
async function checkedOut(git: GitRun, worktree: string): Promise<{ head: string; branch: string | null } | null> {
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], worktree);
  if (head.code !== 0 || !head.stdout.trim()) return null;
  const symbolic = await git(["symbolic-ref", "--quiet", "HEAD"], worktree);
  const branch = symbolic.code === 0 ? symbolic.stdout.trim().replace(/^refs\/heads\//, "") || null : null;
  return { head: head.stdout.trim(), branch };
}

async function mainRoot(git: GitRun, directory: string): Promise<string | null> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], directory);
  if (common.code !== 0) return null;
  const dir = common.stdout.trim();
  return path.basename(dir) === ".git" ? path.dirname(dir) : null;
}

/** One sweep. Never throws for one worktree; its failure is kept with a reason. */
export async function sweepMergedWorktrees(ports: WorktreeSweepPorts): Promise<WorktreeSweepReport> {
  const now = ports.now ?? Date.now;
  const measure = ports.measure ?? exclusiveBytes;
  const maxRemovals = ports.maxRemovals ?? MAX_REMOVALS_PER_SWEEP;
  const dryRun = ports.mode === "dry-run";
  const report: WorktreeSweepReport = {
    at: new Date(now()).toISOString(),
    mode: ports.mode,
    repositories: [],
    removed: [],
    removedBytes: 0,
    kept: [],
    keptCounts: {},
    errors: [],
  };
  const keep = (kept: WorktreeKept) => {
    report.kept.push(kept);
    report.keptCounts[kept.reason] = (report.keptCounts[kept.reason] ?? 0) + 1;
  };
  const resolve = (entry: string) => path.resolve(entry);
  const currentPipelines = ports.currentPipelines ?? (() => ports.pipelines);
  /** What a live pipeline, process or conversation holds right now. An open
      pipeline needs its own checkout and the repository it runs git in. */
  const readGuards = () => ({
    open: currentPipelines().filter(pipelineHoldsCheckout)
      .flatMap((pipeline) => [pipeline.worktreeDir, pipeline.repoDir].filter(Boolean).map(resolve)),
    conversations: ports.conversationCwds().map(resolve),
    scan: ports.scan(),
  });
  const heldBy = (guards: ReturnType<typeof readGuards>, directory: string): WorktreeKept | null => {
    if (guards.open.some((open) => inside(open, directory))) return { path: directory, reason: "open-pipeline" };
    for (const process of guards.scan.processes) {
      if (process.paths.some((entry) => inside(resolve(entry), directory))) return { path: directory, reason: "in-use", detail: `pid ${process.pid}` };
    }
    if (guards.conversations.some((cwd) => inside(cwd, directory))) return { path: directory, reason: "live-conversation" };
    return null;
  };
  /* The first read skips what is plainly busy; each removal reads them again. */
  const initial = readGuards();

  /* A project registered at a linked checkout, or inside one, is its root. */
  const projectRoots = (ports.repositories ?? []).filter(Boolean).map(resolve);
  const roots = new Map<string, string>();
  for (const candidate of [...ports.pipelines.map((pipeline) => pipeline.repoDir), ...(ports.repositories ?? [])]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const root = await mainRoot(ports.git, candidate);
    if (root && !roots.has(root)) roots.set(root, root);
  }

  for (const root of [...roots.keys()].sort()) {
    report.repositories.push(root);
    const listing = await ports.git(["worktree", "list", "--porcelain", "-z"], root);
    if (listing.code !== 0) {
      report.errors.push(`${root}: git worktree list: ${(listing.stderr || listing.stdout).trim()}`);
      continue;
    }
    const listed = parseWorktreeList(listing.stdout).filter((entry) => !entry.bare);
    const [main, ...linked] = listed;
    if (!main || linked.length === 0) continue;
    const mainPath = resolve(main.path);
    const remote = await ports.git(["remote", "get-url", "origin"], root);
    const repository = remote.code === 0 ? githubRepositoryOfRemote(remote.stdout.trim()) : null;
    const merged = repository ? await ports.mergedPullRequests(repository) : [];
    const byHead = new Map<string, MergedPullRequest[]>();
    const byNumber = new Map<number, MergedPullRequest>();
    for (const pr of merged ?? []) {
      byNumber.set(pr.number, pr);
      const list = byHead.get(pr.headRefName) ?? [];
      list.push(pr);
      byHead.set(pr.headRefName, list);
    }
    /* Nested worktrees first, so an outer one they emptied can go in the same sweep. */
    const remaining = new Set(linked.map((entry) => resolve(entry.path)));
    const ordered = [...linked].sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
    for (const entry of ordered) {
      const worktree = resolve(entry.path);
      const owners = ports.pipelines.filter((pipeline) => pipeline.worktreeDir && resolve(pipeline.worktreeDir) === worktree);
      const pipelineId = owners[0]?.id;
      const base = { path: worktree, ...(pipelineId ? { pipelineId } : {}) };
      if (worktree === mainPath || roots.has(worktree) || projectRoots.some((project) => inside(project, worktree))) continue;
      if (initial.open.some((open) => inside(open, worktree))) {
        keep({ ...base, reason: "open-pipeline" });
        continue;
      }
      if (entry.locked) {
        keep({ ...base, reason: "locked" });
        continue;
      }
      if (entry.prunable || !fs.existsSync(worktree)) {
        keep({ ...base, reason: "missing" });
        continue;
      }
      if (repository && merged === null) {
        keep({ ...base, reason: "forge-unavailable", detail: `${repository}: neither the forge cache nor gh listed its merged pull requests` });
        continue;
      }
      const candidates = pipelinePrCandidates(owners);
      if (entry.branch) candidates.heads.add(entry.branch);
      const prs = new Map<number, MergedPullRequest>();
      for (const head of candidates.heads) for (const pr of byHead.get(head) ?? []) prs.set(pr.number, pr);
      for (const number of candidates.numbers) {
        const pr = byNumber.get(number);
        if (pr) prs.set(pr.number, pr);
      }
      if (prs.size === 0) {
        keep({ ...base, reason: "no-merged-pr", ...(repository ? {} : { detail: "no GitHub origin" }) });
        continue;
      }
      const nested = [...remaining].find((other) => other !== worktree && inside(other, worktree));
      if (nested) {
        keep({ ...base, reason: "holds-worktree", detail: nested });
        continue;
      }
      const busy = heldBy(initial, worktree);
      if (busy) {
        keep({ ...busy, ...base });
        continue;
      }
      const status = await ports.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], worktree);
      if (status.code !== 0) {
        keep({ ...base, reason: "uncommitted", detail: `git status failed: ${(status.stderr || "").trim()}` });
        continue;
      }
      const classified = classifyStatus(status.stdout);
      const changed = classified.changed;
      /* An ignored container a nested worktree removed earlier in this sweep
         left empty holds nothing. */
      const ignored = classified.ignored.filter((entry) => !emptyDirectory(path.join(worktree, entry)));
      if (changed.length > 0) {
        keep({ ...base, reason: "uncommitted", detail: `${changed.length} path(s)` });
        continue;
      }
      if (ignored.length > 0) {
        keep({ ...base, reason: "ignored-files", detail: ignored.slice(0, 5).join(", ") + (ignored.length > 5 ? `, … ${ignored.length - 5} more` : "") });
        continue;
      }
      /** The merged PR whose head contains what the checkout has checked out
          now, or why none does. */
      const prove = async (): Promise<{ pr: MergedPullRequest; branch: string | null } | WorktreeKept> => {
        const current = await checkedOut(ports.git, worktree);
        if (!current) return { ...base, reason: "unmerged-commits", detail: "HEAD unreadable" };
        let known = false;
        for (const pr of [...prs.values()].sort((a, b) => b.number - a.number)) {
          const present = await ports.git(["cat-file", "-e", `${pr.headRefOid}^{commit}`], root);
          if (present.code !== 0) continue;
          known = true;
          const ancestor = await ports.git(["merge-base", "--is-ancestor", current.head, pr.headRefOid], root);
          if (ancestor.code === 0) return { pr, branch: current.branch };
        }
        return { ...base, reason: known ? "unmerged-commits" : "pr-head-unknown", detail: [...prs.keys()].map((n) => `#${n}`).join(", ") };
      };
      let proof = await prove();
      if ("reason" in proof) {
        keep(proof);
        continue;
      }
      let contained = proof.pr;
      if (report.removed.length >= maxRemovals) {
        keep({ ...base, reason: "deferred" });
        continue;
      }
      const bytes = await measure(worktree);
      let removal: WorktreeRemoval = { ...base, bytes, pr: { number: contained.number, url: contained.url }, branch: proof.branch };
      if (dryRun) {
        report.removed.push(removal);
        report.removedBytes += bytes;
        remaining.delete(worktree);
        continue;
      }
      /* The measurement can take a while; what holds the checkout is read
         again now, as close to the removal as it can be. */
      const busyNow = heldBy(readGuards(), worktree);
      if (busyNow) {
        keep({ ...busyNow, ...base });
        continue;
      }
      if (!ports.recordResolution(worktree)) {
        keep({ ...base, reason: "map-write-failed" });
        continue;
      }
      /* A commit made since the status read leaves the checkout clean, so the
         removal below would not refuse it: HEAD is proven again last. */
      proof = await prove();
      if ("reason" in proof) {
        keep(proof);
        continue;
      }
      contained = proof.pr;
      removal = { ...removal, pr: { number: contained.number, url: contained.url }, branch: proof.branch };
      /* Never `--force`: git refuses a checkout that changed since the status read. */
      const removed = await ports.git(["worktree", "remove", worktree], root);
      if (removed.code !== 0) {
        keep({ ...base, reason: "remove-failed", detail: (removed.stderr || removed.stdout).trim() });
        continue;
      }
      remaining.delete(worktree);
      report.removed.push(removal);
      report.removedBytes += bytes;
      /* The lane branch goes with it; its tip is contained in the merged head,
         which is what makes `-D` safe after a squash merge `-d` cannot see. */
      const branches = new Set<string>(proof.branch ? [proof.branch] : []);
      for (const owner of owners) if (owner.branch) branches.add(owner.branch);
      for (const branch of branches) {
        const tip = await ports.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
        if (tip.code !== 0) continue;
        const ancestor = await ports.git(["merge-base", "--is-ancestor", tip.stdout.trim(), contained.headRefOid], root);
        if (ancestor.code !== 0) continue;
        const deleted = await ports.git(["branch", "-D", "--", branch], root);
        if (deleted.code !== 0) report.errors.push(`${root}: git branch -D ${branch}: ${(deleted.stderr || deleted.stdout).trim()}`);
      }
    }
  }
  return report;
}

const REPORT_FILE = () => statePath("worktree-sweep-report.json");

function gigabytes(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function summarizeWorktreeSweep(report: WorktreeSweepReport): string {
  const verb = report.mode === "dry-run" ? "would remove" : "removed";
  const kept = Object.entries(report.keptCounts).map(([reason, count]) => `${count} ${reason}`).join(", ");
  return `[worktree sweep] ${verb} ${report.removed.length} worktree(s) (${gigabytes(report.removedBytes)}) across ${report.repositories.length} repositor${report.repositories.length === 1 ? "y" : "ies"};`
    + ` kept ${report.kept.length}${kept ? ` (${kept})` : ""}; ${report.errors.length} error(s)`;
}

/* ── Production ports ───────────────────────────────────────────────────── */

const GIT_TIMEOUT_MS = 120_000;

/** Git without prompts and without optional locks, so a status read never
    rewrites a checkout's index. */
export const realGit: GitRun = (args, cwd) => new Promise((resolveRun) => {
  execFile("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  }, (error, stdout, stderr) => {
    /* A non-zero exit carries its status in `code`; a spawn failure or a
       timeout carries a string or nothing, which reads as no status at all. */
    const status = (error as { code?: unknown } | null)?.code;
    const code = !error ? 0 : typeof status === "number" ? status : null;
    resolveRun({ code, stdout: String(stdout ?? ""), stderr: String(stderr || error?.message || "") });
  });
});

/** Merged pull requests from the forge cache the forge sweep keeps (#2059):
    null until it holds a complete read of the repository with head commits. A
    merged PR's head never changes, so the cache is as good as a fresh read. */
export function forgeCacheMergedPullRequests(read: () => ForgeCacheFile) {
  return (repository: string): MergedPullRequest[] | null => {
    const data = read();
    const name = repository.toLowerCase();
    const entry = data.repositories[name] ?? Object.values(data.repositories).find((candidate) => candidate.canonical === name);
    if (!entry?.completeSince || !entry.headRefOids) return null;
    return Object.entries(entry.prs).flatMap(([number, pr]) => pr.state === "merged" && pr.headRefOid
      ? [{ number: Number(number), url: pr.url, headRefName: pr.headRefName, headRefOid: pr.headRefOid }]
      : []);
  };
}

const GH_MERGED_FIELDS = "number,url,headRefName,headRefOid";
/** Merged pull requests one `gh` read lists; an older one past it stays as
    `no-merged-pr`, which keeps its worktree. */
export const GH_MERGED_LIMIT = 5_000;
const GH_TIMEOUT_MS = 60_000;

/** Merged pull requests straight from `gh`, for a repository the forge cache
    has not read completely: the forge sweep reads only the repositories a
    pipeline or a linked task names, and its field list needs a newer `gh` than
    some installs carry. Asks only for fields every `gh` since 2.0 knows.
    Fails closed: a failed command or one malformed row answers null. */
export function ghMergedPullRequests(run: GithubRunner, limit = GH_MERGED_LIMIT) {
  return async (repository: string): Promise<MergedPullRequest[] | null> => {
    let raw: string;
    try {
      raw = await run(["pr", "list", "--repo", repository, "--state", "merged", "--limit", String(limit), "--json", GH_MERGED_FIELDS]);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const rows: MergedPullRequest[] = [];
    for (const entry of parsed) {
      const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      if (!Number.isSafeInteger(row.number) || typeof row.url !== "string" || typeof row.headRefName !== "string") return null;
      /* A head commit is what containment is proven against; without one the
         PR matches nothing, and its worktree stays. */
      if (typeof row.headRefOid !== "string" || !/^[0-9a-f]{40}$/i.test(row.headRefOid)) continue;
      rows.push({ number: row.number as number, url: row.url, headRefName: row.headRefName, headRefOid: row.headRefOid });
    }
    return rows;
  };
}

/** The production merge source: the forge cache when it holds a complete read
    of the repository, `gh` otherwise, each repository asked once per sweep. */
export function productionMergedPullRequests(sources: {
  cache: (repository: string) => MergedPullRequest[] | null;
  gh: (repository: string) => Promise<MergedPullRequest[] | null>;
}) {
  const answers = new Map<string, Promise<MergedPullRequest[] | null>>();
  return (repository: string): Promise<MergedPullRequest[] | null> => {
    const key = repository.toLowerCase();
    let answer = answers.get(key);
    if (!answer) {
      const cached = sources.cache(repository);
      answers.set(key, answer = cached ? Promise.resolve(cached) : sources.gh(repository));
    }
    return answer;
  };
}

function withArchived(hot: readonly Pipeline[], archived: readonly Pipeline[]): Pipeline[] {
  const ids = new Set(hot.map((pipeline) => pipeline.id));
  return [...hot, ...archived.filter((pipeline) => !ids.has(pipeline.id))];
}

/** The ports as the Viewer runs them, over its own state. `run` is the `gh`
    seam, replaceable to run the image's `gh` from outside it. */
export async function productionWorktreeSweepPorts(
  mode: WorktreeSweepMode,
  run: GithubRunner = githubRunner(os.tmpdir(), GH_TIMEOUT_MS),
): Promise<WorktreeSweepPorts> {
  const [{ loadArchivedPipelines, loadPipelinesForList }, { projectCurationSnapshot }, { agentRegistry }, { recordWorktreeResolution }, { readForgeCache }] = await Promise.all([
    import("@/lib/pipelines/store"),
    import("@/lib/projects/curation"),
    import("@/lib/agent/registry"),
    import("@/lib/scanner/describe"),
    import("@/lib/forge/cache"),
  ]);
  return {
    mode,
    git: realGit,
    mergedPullRequests: productionMergedPullRequests({
      cache: forgeCacheMergedPullRequests(() => readForgeCache().data),
      gh: ghMergedPullRequests(run),
    }),
    /* Settled lanes move to the archive after a while; their delivered PR
       numbers are what find a PR whose head is not the lane branch. */
    pipelines: withArchived(loadPipelinesForList(), loadArchivedPipelines()),
    currentPipelines: () => loadPipelinesForList(),
    repositories: projectCurationSnapshot().manualProjects.map((project) => project.root),
    conversationCwds: () => liveOrWaitingConversationCwds(agentRegistry().readOnlySnapshot()),
    scan: () => scanProcesses(),
    recordResolution: (worktree) => recordWorktreeResolution(worktree) !== null,
  };
}

/** The last sweep in full, at `state/worktree-sweep-report.json`. */
export function recordWorktreeSweep(report: WorktreeSweepReport): void {
  fs.mkdirSync(path.dirname(REPORT_FILE()), { recursive: true, mode: 0o700 });
  writeJsonDurably(REPORT_FILE(), report);
}

/** The production sweep: mode from the environment, report to the state directory. */
export async function runWorktreeSweep(
  env: Readonly<Record<string, string | undefined>> = process.env,
  portsFor: (mode: WorktreeSweepMode) => Promise<WorktreeSweepPorts> = productionWorktreeSweepPorts,
): Promise<WorktreeSweepReport | null> {
  const mode = worktreeSweepMode(env);
  if (mode === null) return null;
  let ports: WorktreeSweepPorts;
  try {
    ports = await portsFor(mode);
  } catch (error) {
    /* Without the pipelines and the conversations nothing can be proven safe to remove. */
    console.error("[worktree sweep] skipped: its inputs could not be read", error instanceof Error ? error.message : String(error));
    return null;
  }
  const report = await sweepMergedWorktrees(ports);
  recordWorktreeSweep(report);
  console.log(summarizeWorktreeSweep(report));
  return report;
}

const sweepHost = globalThis as typeof globalThis & {
  __llvWorktreeSweepTimer?: ReturnType<typeof setTimeout>;
};

/** Starts the hourly sweep once per process, from the release that owns
    traffic. Each sweep is scheduled when the previous one has finished, so two
    never overlap. */
export function startWorktreeSweep(ports: {
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  sweep?: () => Promise<unknown>;
  firstDelayMs?: number;
  intervalMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): void {
  if (sweepHost.__llvWorktreeSweepTimer) return;
  if (worktreeSweepMode(ports.env) === null) return;
  const schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const sweep = ports.sweep ?? (() => runWorktreeSweep());
  const arm = (delayMs: number) => {
    const timer = schedule(() => {
      void sweep()
        .catch((error) => console.error("[worktree sweep] failed", error instanceof Error ? error.message : String(error)))
        .finally(() => {
          if (sweepHost.__llvWorktreeSweepTimer === timer) arm(ports.intervalMs ?? WORKTREE_SWEEP_INTERVAL_MS);
        });
    }, delayMs);
    timer.unref?.();
    sweepHost.__llvWorktreeSweepTimer = timer;
  };
  arm(ports.firstDelayMs ?? FIRST_SWEEP_DELAY_MS);
}

/** Test seam: the timer is process-global. */
export function stopWorktreeSweep(): void {
  if (sweepHost.__llvWorktreeSweepTimer) clearTimeout(sweepHost.__llvWorktreeSweepTimer);
  sweepHost.__llvWorktreeSweepTimer = undefined;
}
