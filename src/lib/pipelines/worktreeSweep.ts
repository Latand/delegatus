import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { scanProcesses, type ProcessScan } from "@/lib/tempSweep";
import type { ExecResult } from "@/lib/workflows/provision";

import type { Pipeline } from "./types";

/**
 * Removes the worktrees whose work is merged (#2202).
 *
 * Every pipeline gets its own `git worktree add` checkout and nothing removed
 * them: on 2026-09-25 the workstation held about 470 of them, 250 GB, and
 * `/home` was at 98%. This sweep removes a linked worktree of a registered
 * repository, and the local branch it had checked out, once the pull request
 * that branch delivered is merged. The pull request's state is read from the
 * forge, never from ancestry against the base branch: a squash merge leaves
 * the branch's commits outside the base for ever.
 *
 * Registered repositories are the ones a pipeline ran in and the ones the
 * operator created a project from; every linked worktree git lists for them is
 * a candidate, whatever its layout (`.worktrees/<name>`, `worktrees/<name>`,
 * `.claude/worktrees/<name>`, a sibling `git worktree add ../<name>`). The main
 * checkout never is.
 *
 * Each of these keeps a worktree, and the report names which one did:
 *
 * - `open-pipeline` — a pipeline that is not completed or closed owns it, runs
 *   inside it, or runs its git in it.
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
 * - `unmerged-commits` — its HEAD is not contained in the merged PR's head
 *   commit, so something was committed after the merge or never pushed.
 * - `pr-head-unknown` — the merged PR's head commit is not in the local
 *   object store, so containment cannot be proven.
 * - `holds-worktree` — another linked worktree that stays is nested in it.
 * - `locked`, `missing` — git marks it locked, or its directory is not
 *   reachable from here.
 * - `forge-unavailable` — the merged pull requests could not be read.
 * - `map-write-failed`, `remove-failed` — the removal itself could not be
 *   made safe or did not happen.
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
/** A process scan older than this is taken again before a removal. */
const SCAN_MAX_AGE_MS = 60_000;
/** A spawn or resume that has not settled in this long is not coming. */
const PENDING_CONVERSATION_MS = 24 * HOUR_MS;

export type WorktreeKeptReason =
  | "open-pipeline"
  | "no-merged-pr"
  | "in-use"
  | "live-conversation"
  | "uncommitted"
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

export type SweptPipeline = Pick<Pipeline, "id" | "state" | "repoDir" | "worktreeDir" | "branch" | "delivery"> & {
  runs?: Pipeline["runs"];
};

export type WorktreeSweepPorts = {
  mode: WorktreeSweepMode;
  git: GitRun;
  /** Every merged pull request of a GitHub repository (`owner/name`), or null
      when the forge cannot be read. */
  mergedPullRequests: (repository: string) => Promise<MergedPullRequest[] | null>;
  pipelines: readonly SweptPipeline[];
  /** Repository roots registered some other way (operator-created projects). */
  repositories?: readonly string[];
  /** Working directories of conversations that are live or waiting. */
  conversationCwds: readonly string[];
  scan: () => ProcessScan;
  /** Writes the checkout's resolution to the worktree map; false refuses the removal. */
  recordResolution: (worktree: string) => boolean;
  measure?: (directory: string) => Promise<number>;
  now?: () => number;
  maxRemovals?: number;
};

const OPEN_STATES: ReadonlySet<Pipeline["state"]> = new Set(["draft", "provisioning", "running", "needs_decision", "needs_review", "paused"]);

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
    if (delivery?.state !== "held" && delivery?.state !== "assigned") continue;
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
  /* An open pipeline needs its own checkout and the repository it runs git in. */
  const openWorktrees = ports.pipelines.filter((pipeline) => OPEN_STATES.has(pipeline.state))
    .flatMap((pipeline) => [pipeline.worktreeDir, pipeline.repoDir].filter(Boolean).map(resolve));
  const conversationCwds = ports.conversationCwds.map(resolve);
  let scan = ports.scan();
  let scannedAt = now();
  const inUseBy = (directory: string): number | null => {
    for (const process of scan.processes) {
      if (process.paths.some((entry) => inside(resolve(entry), directory))) return process.pid;
    }
    return null;
  };

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
      if (worktree === mainPath || roots.has(worktree)) continue;
      if (openWorktrees.some((open) => inside(open, worktree))) {
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
        keep({ ...base, reason: "forge-unavailable", detail: repository });
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
      if (now() - scannedAt > SCAN_MAX_AGE_MS) {
        scan = ports.scan();
        scannedAt = now();
      }
      const pid = inUseBy(worktree);
      if (pid !== null) {
        keep({ ...base, reason: "in-use", detail: `pid ${pid}` });
        continue;
      }
      if (conversationCwds.some((cwd) => inside(cwd, worktree))) {
        keep({ ...base, reason: "live-conversation" });
        continue;
      }
      const status = await ports.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree);
      if (status.code !== 0) {
        keep({ ...base, reason: "uncommitted", detail: `git status failed: ${(status.stderr || "").trim()}` });
        continue;
      }
      if (status.stdout.length > 0) {
        keep({ ...base, reason: "uncommitted", detail: `${status.stdout.split("\0").filter(Boolean).length} path(s)` });
        continue;
      }
      const head = entry.head;
      let contained: MergedPullRequest | null = null;
      let known = false;
      for (const pr of [...prs.values()].sort((a, b) => b.number - a.number)) {
        if (!head) break;
        const present = await ports.git(["cat-file", "-e", `${pr.headRefOid}^{commit}`], root);
        if (present.code !== 0) continue;
        known = true;
        const ancestor = await ports.git(["merge-base", "--is-ancestor", head, pr.headRefOid], root);
        if (ancestor.code === 0) {
          contained = pr;
          break;
        }
      }
      if (!contained) {
        keep({ ...base, reason: known ? "unmerged-commits" : "pr-head-unknown", detail: [...prs.keys()].map((n) => `#${n}`).join(", ") });
        continue;
      }
      if (report.removed.length >= maxRemovals) {
        keep({ ...base, reason: "deferred" });
        continue;
      }
      const bytes = await measure(worktree);
      const removal: WorktreeRemoval = { ...base, bytes, pr: { number: contained.number, url: contained.url }, branch: entry.branch };
      if (dryRun) {
        report.removed.push(removal);
        report.removedBytes += bytes;
        remaining.delete(worktree);
        continue;
      }
      if (!ports.recordResolution(worktree)) {
        keep({ ...base, reason: "map-write-failed" });
        continue;
      }
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
      const branches = new Set<string>(entry.branch ? [entry.branch] : []);
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

const GH_TIMEOUT_MS = 180_000;
const MERGED_FULL_LIMIT = 5_000;
const MERGED_PAGE_LIMIT = 100;
/** A full re-read catches anything an incremental page could have missed. */
const MERGED_FULL_EVERY_MS = 6 * HOUR_MS;

type MergedMemo = { fullAt: number; prs: Map<number, MergedPullRequest> };
const mergedHost = globalThis as typeof globalThis & { __llvWorktreeSweepMerged?: Map<string, MergedMemo> };

function parseMerged(raw: string): MergedPullRequest[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: MergedPullRequest[] = [];
  for (const row of parsed as Array<Record<string, unknown>>) {
    if (!row || !Number.isSafeInteger(row.number) || typeof row.url !== "string" || typeof row.headRefName !== "string") continue;
    if (typeof row.headRefOid !== "string" || !/^[0-9a-f]{40}$/i.test(row.headRefOid)) continue;
    out.push({ number: row.number as number, url: row.url, headRefName: row.headRefName, headRefOid: row.headRefOid });
  }
  return out;
}

/** Merged pull requests through `gh`: one full read per repository every six
    hours, and between them one page of the most recently updated, merged into
    the memory copy. A merged PR's head never changes, so nothing goes stale. */
export function ghMergedPullRequests(run: (args: string[]) => Promise<string> = ghRun, now: () => number = Date.now) {
  return async (repository: string): Promise<MergedPullRequest[] | null> => {
    const memos = mergedHost.__llvWorktreeSweepMerged ??= new Map();
    const memo = memos.get(repository);
    const full = !memo || now() - memo.fullAt > MERGED_FULL_EVERY_MS;
    const args = ["pr", "list", "--repo", repository, "--state", "merged", "--json", "number,url,headRefName,headRefOid"];
    try {
      const rows = parseMerged(await run(full
        ? [...args, "--limit", String(MERGED_FULL_LIMIT)]
        : [...args, "--limit", String(MERGED_PAGE_LIMIT), "--search", "sort:updated-desc"]));
      if (rows === null) return memo ? [...memo.prs.values()] : null;
      const next: MergedMemo = full ? { fullAt: now(), prs: new Map() } : memo!;
      for (const row of rows) next.prs.set(row.number, row);
      memos.set(repository, next);
      return [...next.prs.values()];
    } catch (error) {
      console.error(`[worktree sweep] ${repository}: merged pull requests unavailable`, error instanceof Error ? error.message : String(error));
      return memo ? [...memo.prs.values()] : null;
    }
  };
}

function ghRun(args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile("gh", args, { cwd: os.tmpdir(), timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolveRun(String(stdout));
    });
  });
}

function withArchived(hot: readonly Pipeline[], archived: readonly Pipeline[]): Pipeline[] {
  const ids = new Set(hot.map((pipeline) => pipeline.id));
  return [...hot, ...archived.filter((pipeline) => !ids.has(pipeline.id))];
}

/** The ports as the Viewer runs them, over its own state. */
export async function productionWorktreeSweepPorts(mode: WorktreeSweepMode): Promise<WorktreeSweepPorts> {
  const [{ loadArchivedPipelines, loadPipelinesForList }, { projectCurationSnapshot }, { agentRegistry }, { recordWorktreeResolution }] = await Promise.all([
    import("@/lib/pipelines/store"),
    import("@/lib/projects/curation"),
    import("@/lib/agent/registry"),
    import("@/lib/scanner/describe"),
  ]);
  return {
    mode,
    git: realGit,
    mergedPullRequests: ghMergedPullRequests(),
    /* Settled lanes move to the archive after a while; their delivered PR
       numbers are what find a PR whose head is not the lane branch. */
    pipelines: withArchived(loadPipelinesForList(), loadArchivedPipelines()),
    repositories: projectCurationSnapshot().manualProjects.map((project) => project.root),
    conversationCwds: liveOrWaitingConversationCwds(agentRegistry().readOnlySnapshot()),
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
