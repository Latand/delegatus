import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import type { ForgeCacheFile } from "@/lib/forge/cache";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";
import { fsyncPath, writeJsonDurably } from "@/lib/state/durableJson";
import { captureProcessIdentity, processIdentityProvenDead, type ProcessIdentity } from "@/lib/processIdentity";
import { hostCommandArgs, openHostTempRoots, stageHostNamespace } from "@/lib/state/hostTempViews";
import { isOwnedTempName, ownTempRoots, resolvePhysicalPath, scanProcesses, sweepRoots, type ProcessScan, type TempSweepRoot } from "@/lib/tempSweep";
import type { ExecResult } from "@/lib/workflows/provision";

import { pipelineActivitySettled, type Pipeline } from "./types";
import { pipelineLiteralGitEnv } from "./git";

/**
 * Removes the worktrees whose work is merged (#2202), and finished ones whose
 * work is kept elsewhere.
 *
 * Every pipeline gets its own `git worktree add` checkout and nothing removed
 * them: on 2026-09-25 the workstation held about 470 of them, 250 GB, and
 * `/home` was at 98%. This sweep removes a linked worktree of a registered
 * repository once the pull request
 * that branch delivered is merged. The pull request's state is read from the
 * forge cache the forge sweep keeps (#2059), or from `gh` when that cache holds
 * no complete read of the repository, never from ancestry against the base
 * branch: a squash merge leaves the branch's commits outside the base for ever.
 * Local branch refs stay: another checkout can acquire a ref while cleanup is
 * yielding, and retaining that ref does not retain the checkout's disk bulk.
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
 *   one its pipeline delivered), and no pipeline or owned role layout makes it a
 *   finished lane: a checkout the operator made by hand stays.
 * - `retention` — a finished lane, or a role's temp checkout, that has not yet
 *   been settled for `FINISHED_WORKTREE_RETENTION_MS`.
 * - `local-only-commits` — past retention, without a merged PR containing its
 *   HEAD, and some commit of it is in no ref a remote advertises right now and
 *   HEAD is not its pipeline's base. Work that exists only here stays.
 * - `self-update-release` — a release checkout self-update owns and prunes
 *   itself, keeping the serving and rollback releases.
 * - `in-use` — an unfinished merge-batch state still owns it, or a live
 *   process holds that state, even while running outside the checkout; or
 *   a live process has its working directory, an open file, or its
 *   `TMPDIR`/`LLV_STATE_DIR`/`XDG_CONFIG_HOME` inside it (the `/proc` scan the
 *   temp sweep uses).
 * - `live-conversation` — a registry conversation that is hosted, starting, or
 *   holding a queued message runs there.
 * - `uncommitted` — tracked changes or untracked files; `git worktree remove`
 *   is never forced.
 * - `ignored-files` — ignored source, evidence and unknown output classes.
 *   The established dependency, build and cache classes are disposable;
 *   nested Git metadata and `.artifacts` still hold their containers.
 *   `git worktree remove` deletes ignored files without asking,
 *   so every removal refreshes this inventory.
 * - `unmerged-commits` — its HEAD is not contained in the merged PR's head
 *   commit, so something was committed after the merge or never pushed. Past
 *   retention the remote proof below applies instead.
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
 * A finished lane without a merged PR is freed too: a checkout whose
 * pipelines are all completed or closed with settled teardown and delivery, or
 * a recognized role checkout (the merger's declared batches, or owned temp
 * review exports and attribution runs), once it has been settled for the
 * retention period. Merger state and its live holders must release it first;
 * the four days also apply when its batch PR has merged. Its
 * HEAD must equal its pipeline's base, or every commit of it must be reachable
 * from a ref one of the repository's remotes advertises at that moment
 * (`git ls-remote`; a remote-tracking ref can outlive the branch it tracked).
 * Every other guard above applies unchanged, and the removal is never forced.
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
 * Role checkouts under validated host temp views are an exception: the same
 * guards and proofs run through that namespace's filesystem view and Git.
 * A stamped agent, PID 1 on an idle nsenter host, or a borrowed reader with
 * restored credentials supplies the view; the reader is released after the sweep.
 * Their canonical paths are recorded before removal as on a native install.
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
/** How long a finished lane, or a role's temp checkout nobody owns, stays
    settled before the sweep may free it without a merged PR. Merge-batch
    checkouts retain this period even after their batch PR merges. */
export const FINISHED_WORKTREE_RETENTION_MS = 4 * 24 * HOUR_MS;
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
  | "deferred"
  | "retention"
  | "local-only-commits"
  | "self-update-release";

export type MergedPullRequest = { number: number; url: string; headRefName: string; headRefOid: string };

export type WorktreeRemoval = {
  path: string;
  /** Bytes only this checkout held: files with one link, so a hard-linked
      `node_modules` counts only what removing it actually frees. */
  bytes: number;
  pr: { number: number; url: string } | null;
  preservation?: "merged-pr" | "remote-ref" | "base";
  branch: string | null;
  pipelineId?: string;
};

export type WorktreeKept = { path: string; reason: WorktreeKeptReason; detail?: string; pipelineId?: string; bytes?: number; firstSettledAt?: string };

export type WorktreeSweepReport = {
  at: string;
  mode: WorktreeSweepMode;
  repositories: string[];
  /** In a dry run, what the sweep would have removed. */
  removed: WorktreeRemoval[];
  removedBytes: number;
  trimmed: { path: string; bytes: number; pipelineId: string }[];
  trimmedBytes: number;
  kept: WorktreeKept[];
  keptCounts: Partial<Record<WorktreeKeptReason, number>>;
  keptBytes: Partial<Record<WorktreeKeptReason, number>>;
  errors: string[];
};

export type GitRun = (args: string[], cwd: string) => Promise<ExecResult>;

export type SweptPipeline = Pick<Pipeline, "id" | "state" | "repoDir" | "worktreeDir" | "branch" | "delivery"> &
  Partial<Pick<Pipeline, "closeTeardown" | "closeReport" | "activationCloseRequested" | "baseRef" | "closedAt">> & {
    runs?: Pipeline["runs"];
  };

export type WorktreeSweepPorts = {
  mode: WorktreeSweepMode;
  /** Release a borrowed host filesystem view after the sweep, even on failure. */
  close?: () => Promise<void>;
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
  /** Filesystem view of a host temp checkout from a container. Git and the
      worktree map still receive the canonical path in that namespace. */
  accessiblePath?: (directory: string) => string;
  now?: () => number;
  maxRemovals?: number;
  /** The previous report, whose `firstSettledAt` carries a retention clock
      started by observation across sweeps. */
  previous?: WorktreeSweepReport | null;
  /** Temp roots: an unowned linked checkout inside an owned temp name
      follows the finished-lane retention rule. Handmade checkouts stay. */
  tempRoots?: readonly string[];
};

const BUSY_REASONS: ReadonlySet<WorktreeKeptReason> = new Set(["open-pipeline", "live-conversation", "in-use", "locked", "uncommitted"]);

/* Fails closed: a state added later holds its checkout until it is listed here. */
const SETTLED_STATES: ReadonlySet<Pipeline["state"]> = new Set(["completed", "closed"]);

/** Open, or completed and closed with a teardown or delivery still in flight. */
function pipelineHoldsCheckout(pipeline: SweptPipeline): boolean {
  return !SETTLED_STATES.has(pipeline.state) || !pipelineActivitySettled(pipeline);
}

function latestTerminalTime(pipelines: readonly SweptPipeline[]): number {
  const times = pipelines.flatMap(owner => [owner.closedAt, ...(owner.runs ?? []).flatMap(run => run.attempts.map(attempt => attempt.completedAt))])
    .map(date => date ? Date.parse(date) : Number.NaN).filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

/** The baseline's dependency, build and cache classes. Evidence in
    `.artifacts` and nested repositories remains protected inside them. */
const REBUILDABLE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", "out", "dist", "build", "coverage",
  "test-results", "playwright-report", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis",
  ".venv", "venv", ".tox", ".nox",
]);
const REBUILDABLE_FILES: ReadonlySet<string> = new Set(["next-env.d.ts", ".DS_Store"]);

function rebuildableDirectory(name: string): boolean {
  return REBUILDABLE_DIRECTORIES.has(name) || name.endsWith(".egg-info");
}

function rebuildable(ignored: string): boolean {
  const segments = ignored.replace(/\/+$/, "").split("/");
  const name = segments.at(-1) ?? "";
  if (segments.includes(".artifacts")) return false;
  if (segments.some(rebuildableDirectory)) return true;
  return REBUILDABLE_FILES.has(name) || name.endsWith(".tsbuildinfo") || name.endsWith(".pyc");
}

/** Conventional Python cache entries need their source input. Sourceless
    exports and symlinked inputs remain for inspection. */
function bytecodeInput(file: string): boolean {
  const directory = path.dirname(file);
  const name = path.basename(file);
  const cached = name.match(/^(.+)\.cpython-\d+(?:\.opt-\d+)?\.pyc$/);
  const source = path.basename(directory) === "__pycache__" && cached
    ? path.join(path.dirname(directory), `${cached[1]}.py`) : file.slice(0, -1);
  try { return fs.lstatSync(source).isFile(); }
  catch { return false; }
}

/** Inspect collapsed ignored containers without following links. Established
    outputs still keep nested evidence and Git metadata, including bare repos.
    Unknown containers require source-backed bytecode for every file. */
function onlyRebuildableContents(directory: string, generated = false): boolean {
  const pending = [directory];
  let visited = 0;
  try {
    while (pending.length) {
      const current = pending.pop()!;
      if (!fs.lstatSync(current).isDirectory()) return false;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      const names = new Set(entries.map(entry => entry.name));
      if (names.has("objects") && ["HEAD", "refs", "config"].some(name => names.has(name))) return false;
      for (const entry of entries) {
        if (++visited > MEASURE_ENTRY_LIMIT) return false;
        const child = path.join(current, entry.name);
        if (entry.name === ".git" || entry.name === ".artifacts") return false;
        if (entry.isSymbolicLink()) { if (generated) continue; return false; }
        if (entry.isDirectory()) pending.push(child);
        else if (!entry.isFile() || !generated && (!entry.name.endsWith(".pyc") || !bytecodeInput(child))) return false;
      }
    }
    return true;
  } catch { return false; }
}

/** Removing an ignored symlink only unlinks it. Established output classes
    keep protected nested trees; unknown directories need a contents proof. */
function disposableIgnored(worktree: string, ignored: string): boolean {
  if (ignored.split("/").includes(".artifacts")) return false;
  const target = path.join(worktree, ignored);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory()) return onlyRebuildableContents(target, ignored.split("/").some(rebuildableDirectory));
    return stat.isFile() && rebuildable(ignored)
      && (ignored.split("/").some(rebuildableDirectory) || !ignored.endsWith(".pyc") || bytecodeInput(target));
  } catch { return false; }
}

function keptIgnored(worktree: string, ignored: readonly string[]): string[] {
  return ignored.filter(entry => !disposableIgnored(worktree, entry));
}

/** The browser bundle a rendered-evidence driver writes beside its captures
    (`serveEvidenceFixture` → `<out>/bundle/<fixture>.js`), which the driver
    rebuilds on every run: flat, and nothing but `*.fixture.js`. */
function fixtureBundle(directory: string): boolean {
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    return entries.length > 0 && entries.every((entry) => entry.isFile() && entry.name.endsWith(".fixture.js"));
  } catch {
    return false;
  }
}

/** Self-update's release checkouts (`<cache>/self-update/<install>/releases/<sha12>`):
    `pruneReleaseWorktrees` removes them itself and keeps the release that
    serves and the one a rollback needs. */
function selfUpdateRelease(worktree: string): boolean {
  const releases = path.dirname(worktree);
  return path.basename(releases) === "releases" && /^[0-9a-f]{12}$/.test(path.basename(worktree))
    && path.basename(path.dirname(path.dirname(releases))) === "self-update";
}

/** `git status --porcelain=v1 -z --ignored=matching`: the changed and
    untracked paths, and the ignored ones a removal would lose. An ignored
    directory is listed once, not descended into. */
export function classifyStatus(raw: string, includeRebuildable = false): { changed: string[]; ignored: string[] } {
  const changed: string[] = [];
  const ignored: string[] = [];
  const fields = raw.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    if (code === "!!") {
      if (includeRebuildable || !rebuildable(file)) ignored.push(file);
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
export function exclusiveBytes(directory: string, excludedDirectories: readonly string[] = [], seenEntries = new Set<string>()): Promise<number> {
  return measureDirectory(directory, excludedDirectories, seenEntries, true);
}

/** Physical allocations retained or used by owned consumers. Shared inode
    identities count hard links and namespace aliases once across walks. */
export function allocatedBytes(directory: string, excludedDirectories: readonly string[] = [], seenEntries = new Set<string>()): Promise<number> {
  return measureDirectory(directory, excludedDirectories, seenEntries, false);
}

async function measureDirectory(directory: string, excludedDirectories: readonly string[], seenEntries: Set<string>, singleLinksOnly: boolean): Promise<number> {
  const excluded = new Set<string>();
  for (const excludedDirectory of excludedDirectories) {
    try { const stat = fs.statSync(excludedDirectory); excluded.add(`${stat.dev}:${stat.ino}`); }
    catch { /* An unavailable directory contributes no measured bytes. */ }
  }
  try {
    const stat = fs.statSync(directory);
    const identity = `${stat.dev}:${stat.ino}`;
    if (excluded.has(identity) || seenEntries.has(identity)) return 0;
    seenEntries.add(identity);
  }
  catch { return 0; }
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
          const identity = `${stat.dev}:${stat.ino}`;
          if (excluded.has(identity) || seenEntries.has(identity)) continue;
          seenEntries.add(identity);
          bytes += stat.blocks * 512;
          pending.push(child);
        } else if (!singleLinksOnly || stat.nlink <= 1) {
          const identity = `${stat.dev}:${stat.ino}`;
          if (seenEntries.has(identity)) continue;
          seenEntries.add(identity);
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

/** Git's network transports, including scp-style SSH. Local paths and file
    transports can share the very disk this sweep is trying to free. */
function networkRemote(url: string): boolean {
  if (/^(?:https?|ssh|git):\/\/[^/]+\//i.test(url)) return true;
  // Refuse drive letters, file URLs and Git's local remote-helper syntax.
  return /^(?:[^/@:]+@)?[^/\\:]+:[^:].+/.test(url) && !/^(?:file|[a-z]):/i.test(url);
}

/** merge-batch.ts keeps its state beside the batch and resolution roots.
    Landing precedes deferred resolution and closing the original PRs, so a
    merged batch PR alone cannot release this ownership. Read it again with
    every guard check, including through the host namespace in Docker. */
function mergeBatchOwnership(directory: string, branch: string | null, scan: ProcessScan,
  accessible: (directory: string) => string): { owned: boolean; hold: string | null } {
  const parent = path.dirname(directory);
  const checkout = path.basename(directory) === "checkout" && /^merge-(?:batch|resolution)-[^/]+$/.test(path.basename(parent));
  const privacy = /^privacy-main-[^/]+$/.test(path.basename(directory));
  const runDirectory = checkout ? path.dirname(parent) : privacy ? parent : null;
  const batchLayout = checkout && path.basename(parent).startsWith("merge-batch-");
  let owned = batchLayout && /^merge-batch\/[a-f0-9-]{36}$/.test(branch ?? "");
  const processes = scan.processes.map(process => ({ pid: process.pid,
    paths: process.paths.map(target => path.resolve(target.replace(/ \(deleted\)$/, ""))) }));
  const samePath = (left: string, right: string) => {
    if (path.resolve(left) === path.resolve(right)) return true;
    try { return fs.realpathSync(accessible(left)) === fs.realpathSync(accessible(right)); }
    catch { return false; }
  };
  const files = new Set<string>(runDirectory ? [path.join(runDirectory, "merge-batch.json")] : []);
  for (const process of processes) for (const target of process.paths)
    if (path.basename(target) === "merge-batch.json") files.add(path.resolve(target));
  for (const file of files) {
    const knownLayout = file === (runDirectory ? path.join(runDirectory, "merge-batch.json") : null);
    const locked = fs.existsSync(accessible(file + ".lock"));
    const physicalRun = resolvePhysicalPath(accessible(path.dirname(file)));
    const holder = processes.find(process => process.paths.some(target =>
      inside(target, path.dirname(file))
      || inside(resolvePhysicalPath(accessible(target)), physicalRun)));
    const holderDetail = holder ? `pid ${holder.pid} holds merge batch ${holder.paths.some(target => samePath(target, file)) ? "state" : "run"}` : null;
    // An open descriptor survives unlink/atomic replacement. The process
    // still owns this run even when the path no longer has a readable file.
    if (knownLayout && holder) return { owned, hold: holderDetail };
    let state: { version?: unknown; work?: unknown; branch?: unknown; landed?: unknown;
      resolving?: { work?: unknown }; rows?: { status?: unknown; detail?: unknown }[] };
    try {
      const stat = fs.statSync(accessible(file));
      if (!stat.isFile()) throw new Error("unreadable batch state");
      state = JSON.parse(fs.readFileSync(accessible(file), "utf8"));
      if (!state || state.version !== 1 || typeof state.work !== "string" || typeof state.branch !== "string"
        || !/^merge-batch\/[a-f0-9-]{36}$/.test(state.branch) || !Array.isArray(state.rows)) throw new Error("invalid batch state");
    } catch (error) {
      if (knownLayout && (locked || (error as NodeJS.ErrnoException).code !== "ENOENT"))
        return { owned, hold: "merge batch ownership is unreadable or locked" };
      continue;
    }
    if (!samePath(state.work as string, directory)
      && (typeof state.resolving?.work !== "string" || !samePath(state.resolving.work, directory))
      && !(privacy && knownLayout)) continue;
    owned = true;
    const settled = state.landed === true && !state.resolving && state.rows!.every(row => row
      && (row.status === "needs-review" || row.status === "head-moved" || row.status === "culprit"
        || row.status === "merged" && (row.detail === "closed" || row.detail === "head moved after landing; original kept open")));
    if (!settled || locked || holder) return { owned, hold: holder ? holderDetail : "merge batch still owns checkout" };
  }
  return { owned, hold: null };
}

/** Git's linked-checkout registration is local metadata. Read it without
    yielding after the last Git command: another checkout or a lock created
    while that command ran must still stop a recursive removal. */
function registrationHold(root: string, directory: string, target: string,
  accessible: (directory: string) => string): WorktreeKept | null {
  try {
    const registrations = path.join(root, ".git/worktrees");
    const realDirectory = fs.realpathSync(accessible(directory));
    const realTarget = fs.realpathSync(accessible(target));
    let registered = false;
    for (const entry of fs.readdirSync(accessible(registrations), { withFileTypes: true })) {
      if (!entry.isDirectory()) return { path: directory, reason: "uncommitted", detail: "worktree registration is unreadable" };
      const metadata = path.join(registrations, entry.name);
      const pointer = fs.readFileSync(accessible(path.join(metadata, "gitdir")), "utf8").trim();
      if (!pointer) return { path: directory, reason: "uncommitted", detail: "worktree registration is incomplete" };
      const checkout = path.dirname(path.resolve(metadata, pointer));
      let realCheckout = checkout;
      try { realCheckout = fs.realpathSync(accessible(checkout)); } catch { /* Missing registrations still hold their containers. */ }
      if (checkout === directory || realCheckout === realDirectory) {
        registered = true;
        if (fs.existsSync(accessible(path.join(metadata, "locked")))) return { path: directory, reason: "locked" };
      } else if (inside(checkout, target) || inside(realCheckout, realTarget))
        return { path: directory, reason: "holds-worktree", detail: checkout };
    }
    return registered ? null : { path: directory, reason: "missing" };
  } catch { return { path: directory, reason: "uncommitted", detail: "worktree registration could not be refreshed" }; }
}

type SweepHeadLock = { file: string; prepared: string; dev: string; ino: string };
type SweepHeadLockRecord = { owner: ProcessIdentity; locks: SweepHeadLock[] };
const HEAD_LOCK_RECORDS = () => statePath("worktree-sweep-locks");

/** Only our recorded inodes can be released. Retain the journal on an I/O
    failure so the next sweep can retry, including after a lost namespace view. */
function releaseRecordedHeadLocks(record: SweepHeadLockRecord, journal: string, accessible: (directory: string) => string): void {
  for (const lock of record.locks) for (const file of [lock.file, lock.prepared]) {
    const reached = accessible(file);
    try {
      const stat = fs.lstatSync(reached, { bigint: true });
      if (String(stat.dev) === lock.dev && String(stat.ino) === lock.ino) {
        fs.unlinkSync(reached);
        fsyncPath(path.dirname(reached));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  fs.unlinkSync(journal);
  fsyncPath(path.dirname(journal));
}

function recoverCheckoutHeadLocks(accessible: (directory: string) => string, errors: string[]): void {
  let files: string[];
  try { files = fs.readdirSync(HEAD_LOCK_RECORDS()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push("HEAD lock recovery: records could not be read");
    return;
  }
  for (const file of files.filter(file => file.endsWith(".json"))) {
    const journal = path.join(HEAD_LOCK_RECORDS(), file);
    try {
      const record = JSON.parse(fs.readFileSync(journal, "utf8")) as SweepHeadLockRecord;
      if (!record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 0 || !Array.isArray(record.locks)
        || record.locks.some(lock => !path.isAbsolute(lock.file) || !path.isAbsolute(lock.prepared)
          || !lock.file.endsWith(".lock") || path.dirname(lock.file) !== path.dirname(lock.prepared)
          || !path.basename(lock.prepared).startsWith(".delegatus-sweep-") || !/^\d+$/.test(lock.dev) || !/^\d+$/.test(lock.ino)))
        throw new Error("invalid lock record");
      if (processIdentityProvenDead(record.owner)) releaseRecordedHeadLocks(record, journal, accessible);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push("HEAD lock recovery: a record could not be released");
    }
  }
}

/** Git commits and ref updates honor these locks. Prepare an inode and record
    it durably BEFORE linking it at Git's lock name, covering a crash at every
    point between acquisition and removal without claiming somebody else's lock. */
function lockCheckoutHead(directory: string, accessible: (directory: string) => string, errors: string[]): (() => void) | null {
  const journal = path.join(HEAD_LOCK_RECORDS(), `${randomUUID()}.json`);
  const record: SweepHeadLockRecord = { owner: captureProcessIdentity(process.pid), locks: [] };
  const release = () => {
    if (!record.locks.length) return;
    try { releaseRecordedHeadLocks(record, journal, accessible); }
    catch { errors.push("HEAD lock release: recorded locks await recovery"); }
  };
  try {
    const pointer = fs.readFileSync(path.join(accessible(directory), ".git"), "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return null;
    const metadata = path.resolve(directory, pointer.slice(8));
    const common = path.resolve(metadata, fs.readFileSync(accessible(path.join(metadata, "commondir")), "utf8").trim());
    if (fs.existsSync(accessible(path.join(common, "reftable")))) return null;
    const claim = (file: string) => {
      const prepared = path.join(path.dirname(file), `.delegatus-sweep-${randomUUID()}`);
      const reached = accessible(file);
      const preparedPath = accessible(prepared);
      fs.mkdirSync(path.dirname(reached), { recursive: true });
      const fd = fs.openSync(preparedPath, "wx", 0o600);
      try {
        fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd, { bigint: true });
        record.locks.push({ file, prepared, dev: String(stat.dev), ino: String(stat.ino) });
      } finally { fs.closeSync(fd); }
      writeJsonDurably(journal, record);
      fs.linkSync(preparedPath, reached); // Atomic exclusive claim; an existing Git lock stays.
      // Retain the prepared hard link so a replaced Git lock cannot recycle
      // our recorded inode before recovery verifies it.
      fsyncPath(path.dirname(reached));
    };
    claim(path.join(metadata, "HEAD.lock"));
    let value = fs.readFileSync(accessible(path.join(metadata, "HEAD")), "utf8").trim();
    for (let depth = 0; value.startsWith("ref: "); depth++) {
      const ref = value.slice(5);
      if (depth >= 8 || !ref.startsWith("refs/heads/") || ref.split("/").some(part => !part || part === "." || part === "..") || /[\\\s]/.test(ref)) throw new Error("unsupported HEAD reference");
      claim(path.join(common, `${ref}.lock`));
      try { value = fs.readFileSync(accessible(path.join(common, ref)), "utf8").trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; value = "packed"; }
    }
    return release;
  } catch { release(); return null; }
}

/** Tracked files must stay unchanged through the final asynchronous reads.
    Inode and nanosecond change times also detect writes with restored mtime. */
function trackedSnapshot(worktree: string, inventory: string): Map<string, string> | null {
  if (inventory && !inventory.endsWith("\0")) return null;
  const snapshot = new Map<string, string>();
  try {
    for (const file of inventory.split("\0").filter(Boolean)) {
      if (snapshot.size >= MEASURE_ENTRY_LIMIT) return null;
      const stat = fs.lstatSync(path.join(worktree, file), { bigint: true });
      snapshot.set(file, `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    }
    return snapshot;
  } catch { return null; }
}

function sameTrackedFiles(before: Map<string, string> | null, after: Map<string, string> | null): boolean {
  return before !== null && after !== null && before.size === after.size
    && [...before].every(([file, identity]) => after.get(file) === identity);
}

/** Status can precede the arrival of a new ignored file. Inventory the
    filesystem after the last asynchronous read; unknown contents stay. */
function freshIgnored(worktree: string, tracked: string): string[] {
  const files = new Set(tracked.split("\0").filter(Boolean));
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join("/"));
  }
  const pending = [""];
  let visited = 0;
  try {
    while (pending.length) {
      const relative = pending.pop()!;
      for (const entry of fs.readdirSync(path.join(worktree, relative), { withFileTypes: true })) {
        if (++visited > MEASURE_ENTRY_LIMIT) return ["inspection limit"];
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (name === ".git" || files.has(name)) continue;
        if (entry.isDirectory() && directories.has(name)) pending.push(name);
        else if (!disposableIgnored(worktree, name)) return [name];
      }
    }
    return [];
  } catch { return ["unreadable contents"]; }
}

/** One sweep. Never throws for one worktree; its failure is kept with a reason. */
export async function sweepMergedWorktrees(ports: WorktreeSweepPorts): Promise<WorktreeSweepReport> {
  try { return await sweepMergedWorktreesWithRoots(ports); }
  finally { await ports.close?.(); }
}

async function sweepMergedWorktreesWithRoots(ports: WorktreeSweepPorts): Promise<WorktreeSweepReport> {
  const now = ports.now ?? Date.now;
  const accessible = ports.accessiblePath ?? ((directory: string) => directory);
  const measure = ports.measure ?? ((directory: string) => exclusiveBytes(accessible(directory)));
  const maxRemovals = ports.maxRemovals ?? MAX_REMOVALS_PER_SWEEP;
  const dryRun = ports.mode === "dry-run";
  const report: WorktreeSweepReport = {
    at: new Date(now()).toISOString(),
    mode: ports.mode,
    repositories: [],
    removed: [],
    removedBytes: 0,
    trimmed: [],
    trimmedBytes: 0,
    kept: [],
    keptCounts: {},
    keptBytes: {},
    errors: [],
  };
  if (!dryRun) recoverCheckoutHeadLocks(accessible, report.errors);
  const keep = (kept: WorktreeKept) => {
    /* Activity restarts the retention clock. */
    if (BUSY_REASONS.has(kept.reason)) delete kept.firstSettledAt;
    report.kept.push(kept);
    report.keptCounts[kept.reason] = (report.keptCounts[kept.reason] ?? 0) + 1;
  };
  const previouslyKept = new Map((ports.previous?.kept ?? []).map(kept => [kept.path, kept] as const));
  const tempRoots = (ports.tempRoots ?? []).filter(Boolean).map((root) => path.resolve(root));
  const resolve = (entry: string) => path.resolve(entry);
  const physical = (entry: string) => resolvePhysicalPath(accessible(entry));
  const paths = (entries: readonly string[]) => [...new Set([...new Set(entries)].flatMap(entry => [resolve(entry), physical(entry)]))];
  const currentPipelines = ports.currentPipelines ?? (() => ports.pipelines);
  // The live list omits archived lanes. Preserve their settled ownership,
  // letting fresh live entries override the initial snapshot by id.
  const ownershipPipelines = () => [...new Map([...ports.pipelines, ...currentPipelines()].map((pipeline) => [pipeline.id, pipeline])).values()];
  /** What a live pipeline, process or conversation holds right now. An open
      pipeline needs its own checkout and the repository it runs git in. */
  const readGuards = () => {
    const scan = ports.scan();
    return {
      open: paths(ownershipPipelines().filter(pipelineHoldsCheckout)
        .flatMap(pipeline => [pipeline.worktreeDir, pipeline.repoDir].filter(Boolean))),
      conversations: paths(ports.conversationCwds()),
      scan: { ...scan, processes: scan.processes.map(process => ({ ...process, paths: paths(process.paths) })) },
    };
  };
  const heldBy = (guards: ReturnType<typeof readGuards>, directory: string, branch: string | null = null): WorktreeKept | null => {
    const destinations = paths([directory]);
    const holds = (candidate: string) => destinations.some(destination => inside(candidate, destination));
    if (guards.open.some(holds)) return { path: directory, reason: "open-pipeline" };
    const batch = mergeBatchOwnership(directory, branch, guards.scan, accessible);
    if (batch.hold) return { path: directory, reason: "in-use", detail: batch.hold };
    for (const process of guards.scan.processes) {
      if (process.paths.some(holds)) return { path: directory, reason: "in-use", detail: `pid ${process.pid}` };
    }
    if (guards.conversations.some(holds)) return { path: directory, reason: "live-conversation" };
    return null;
  };
  /* The first read skips what is plainly busy; each removal reads them again. */
  const initial = readGuards();
  const ownersAtStart = ownershipPipelines();
  const ownersOf = (pipelines: readonly SweptPipeline[], worktree: string) => {
    const target = physical(worktree);
    return pipelines.filter(pipeline => pipeline.worktreeDir && (resolve(pipeline.worktreeDir) === worktree
      || physical(pipeline.worktreeDir) === target));
  };

  /* A project registered at a linked checkout, or inside one, is its root. */
  const projectRoots = paths((ports.repositories ?? []).filter(Boolean));
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
    /** The commits this repository's remotes advertise as branch and tag tips,
        read afresh for each preservation proof; null
        when no remote answered. */
    const remoteTips = async () => {
      const remotes = await ports.git(["remote"], root);
      if (remotes.code !== 0) return null;
      const tips = new Set<string>();
      let answered = false;
      for (const name of remotes.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const url = await ports.git(["remote", "get-url", name], root);
        // Another path on this machine is no proof against losing local work.
        if (url.code !== 0 || !networkRemote(url.stdout.trim())) continue;
        const refs = await ports.git(["ls-remote", "--heads", "--tags", "--", name], root);
        if (refs.code !== 0) continue;
        answered = true;
        for (const line of refs.stdout.split("\n")) {
          const oid = line.split(/\s+/)[0] ?? "";
          if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid)) tips.add(oid);
        }
      }
      return answered ? [...tips] : null;
    };
    /** Every commit reachable from `commit` is reachable from an advertised
        tip held locally. A tip this clone never fetched proves nothing. */
    const onRemote = async (commit: string): Promise<boolean | null> => {
      const tips = await remoteTips();
      if (tips === null) return null;
      if (tips.length === 0) return false;
      const outside = await ports.git(["rev-list", "--ignore-missing", "--max-count=1", commit, "--not", ...tips], root);
      return outside.code === 0 && outside.stdout.trim() === "";
    };
    /* Nested worktrees first, so an outer one they emptied can go in the same sweep. */
    const remaining = new Set(linked.map((entry) => resolve(entry.path)));
    const ordered = [...linked].sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
    for (const entry of ordered) {
      const worktree = resolve(entry.path);
      const owners = ownersOf(ownersAtStart, worktree);
      const batch = mergeBatchOwnership(worktree, entry.branch, initial.scan, accessible);
      const pipelineId = owners[0]?.id;
      if (worktree === mainPath || roots.has(worktree) || projectRoots.some((project) => inside(project, worktree))) continue;
      if (owners.length === 0 && selfUpdateRelease(worktree)) {
        keep({ path: worktree, reason: "self-update-release" });
        continue;
      }
      /* A finished lane, or a role's temp checkout nobody owns, follows the
         retention rule; a checkout the operator made by hand never does. */
      const finished = owners.length > 0 ? !owners.some(pipelineHoldsCheckout) : batch.owned || tempRoots.some((temp) =>
        inside(worktree, temp) && isOwnedTempName(path.relative(temp, worktree).split(path.sep)[0] ?? ""));
      /* A lane's own terminal time dates it on the first pass; otherwise the
         first sweep that saw it settled starts the clock. */
      const terminal = latestTerminalTime(owners);
      const previous = previouslyKept.get(worktree);
      const terminalAt = terminal ? new Date(terminal).toISOString() : report.at;
      const firstSettledAt = finished ? previous?.firstSettledAt
        ?? (previous && BUSY_REASONS.has(previous.reason) ? report.at : terminalAt) : undefined;
      const settledSince = Math.max(terminal, Date.parse(firstSettledAt ?? report.at));
      const retained = finished && now() - settledSince >= FINISHED_WORKTREE_RETENTION_MS;
      const base = { path: worktree, ...(pipelineId ? { pipelineId } : {}), ...(firstSettledAt ? { firstSettledAt } : {}) };
      if (initial.open.some((open) => inside(open, worktree))) {
        keep({ ...base, reason: "open-pipeline" });
        continue;
      }
      if (entry.locked) {
        keep({ ...base, reason: "locked" });
        continue;
      }
      if (entry.prunable || !fs.existsSync(accessible(worktree))) {
        keep({ ...base, reason: "missing" });
        continue;
      }
      // Activity also resets retention while a checkout is still young or
      // has no matching PR. It must be observed before either early return.
      const busy = heldBy(initial, worktree, entry.branch);
      if (busy) {
        keep({ ...busy, ...base });
        continue;
      }
      /* Past retention the remote proof stands without the forge. */
      if (repository && merged === null && !retained) {
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
      if ((prs.size === 0 || batch.owned) && !retained) {
        keep(finished
          ? { ...base, reason: "retention", detail: `eligible after ${new Date(settledSince + FINISHED_WORKTREE_RETENTION_MS).toISOString()}` }
          : { ...base, reason: "no-merged-pr", ...(repository ? {} : { detail: "no GitHub origin" }) });
        continue;
      }
      const nested = [...remaining].find((other) => other !== worktree && inside(other, worktree));
      if (nested) {
        keep({ ...base, reason: "holds-worktree", detail: nested });
        continue;
      }
      const status = await ports.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], worktree);
      if (status.code !== 0) {
        keep({ ...base, reason: "uncommitted", detail: `git status failed: ${(status.stderr || "").trim()}` });
        continue;
      }
      const classified = classifyStatus(status.stdout, true);
      const changed = classified.changed;
      /* An ignored container a nested worktree removed earlier in this sweep
         left empty holds nothing. */
      const ignored = keptIgnored(accessible(worktree), classified.ignored);
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
      const prove = async (): Promise<{ pr: MergedPullRequest | null; head: string; preservation: "merged-pr" | "remote-ref" | "base"; branch: string | null } | WorktreeKept> => {
        const current = await checkedOut(ports.git, worktree);
        if (!current) return { ...base, reason: "unmerged-commits", detail: "HEAD unreadable" };
        const freshOwners = ownersOf(ownershipPipelines(), worktree);
        if (retained) {
          if (freshOwners.some(pipelineHoldsCheckout)) return { ...base, reason: "open-pipeline" };
          const freshSettled = Math.max(settledSince, latestTerminalTime(freshOwners));
          if (now() - freshSettled < FINISHED_WORKTREE_RETENTION_MS)
            return { ...base, reason: "retention", detail: `eligible after ${new Date(freshSettled + FINISHED_WORKTREE_RETENTION_MS).toISOString()}` };
        }
        let known = false;
        for (const pr of [...prs.values()].sort((a, b) => b.number - a.number)) {
          const present = await ports.git(["cat-file", "-e", `${pr.headRefOid}^{commit}`], root);
          if (present.code !== 0) continue;
          known = true;
          const ancestor = await ports.git(["merge-base", "--is-ancestor", current.head, pr.headRefOid], root);
          if (ancestor.code === 0) return { pr, head: current.head, preservation: "merged-pr", branch: current.branch };
        }
        if (retained) {
          const remote = await onRemote(current.head);
          if (remote) return { pr: null, head: current.head, preservation: "remote-ref", branch: current.branch };
          if (freshOwners.some((owner) => owner.baseRef === current.head)) return { pr: null, head: current.head, preservation: "base", branch: current.branch };
          return { ...base, reason: "local-only-commits", detail: remote === null
            ? "no remote of the repository answered, so its commits are not proven kept elsewhere"
            : "a commit of HEAD is in no ref a remote advertises, and HEAD is not its pipeline's base" };
        }
        return { ...base, reason: known ? "unmerged-commits" : "pr-head-unknown", detail: [...prs.keys()].map((n) => `#${n}`).join(", ") };
      };
      let proof = await prove();
      if ("reason" in proof) {
        keep(proof);
        continue;
      }
      if (report.removed.length >= maxRemovals) {
        keep({ ...base, reason: "deferred" });
        continue;
      }
      const bytes = await measure(worktree);
      let removal: WorktreeRemoval = { ...base, bytes, pr: proof.pr ? { number: proof.pr.number, url: proof.pr.url } : null, preservation: proof.preservation, branch: proof.branch };
      /* The measurement can take a while; what holds the checkout is read
         again now, as close to the removal as it can be. */
      const busyNow = heldBy(readGuards(), worktree, entry.branch);
      if (busyNow) {
        keep({ ...busyNow, ...base });
        continue;
      }
      const resolutionPaths = [...new Set([worktree, ...ownersOf(ownershipPipelines(), worktree).map(owner => owner.worktreeDir).filter(Boolean)])];
      if (!dryRun && resolutionPaths.some(directory => !ports.recordResolution(directory))) {
        keep({ ...base, reason: "map-write-failed" });
        continue;
      }
      const releaseHead = dryRun ? () => {} : lockCheckoutHead(worktree, accessible, report.errors);
      if (!releaseHead) { keep({ ...base, reason: "locked", detail: "HEAD could not be held through removal" }); continue; }
      try {
        /* A commit made since the status read leaves the checkout clean, so the
           removal below would not refuse it: HEAD is proven again last. */
        proof = await prove();
        if ("reason" in proof) {
          keep(proof);
          continue;
        }
        removal = { ...removal, pr: proof.pr ? { number: proof.pr.number, url: proof.pr.url } : null, preservation: proof.preservation, branch: proof.branch };
        const finalListing = await ports.git(["worktree", "list", "--porcelain", "-z"], root);
        if (finalListing.code !== 0) { keep({ ...base, reason: "uncommitted", detail: "worktree registration could not be refreshed" }); continue; }
        const finalWorktrees = parseWorktreeList(finalListing.stdout);
        const finalEntry = finalWorktrees.find(other => resolve(other.path) === worktree);
        if (!finalEntry || finalEntry.prunable) { keep({ ...base, reason: "missing" }); continue; }
        if (finalEntry.locked) { keep({ ...base, reason: "locked" }); continue; }
        const finalNested = finalWorktrees.find(other => resolve(other.path) !== worktree && inside(resolve(other.path), worktree));
        if (finalNested) { keep({ ...base, reason: "holds-worktree", detail: finalNested.path }); continue; }
        const trackedBefore = await ports.git(["ls-files", "-z"], worktree);
        const originalTracked = trackedBefore.code === 0 ? trackedSnapshot(accessible(worktree), trackedBefore.stdout) : null;
        if (originalTracked === null) { keep({ ...base, reason: "uncommitted", detail: "tracked contents could not be inspected" }); continue; }
        const finalStatus = await ports.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], worktree);
        const finalClass = classifyStatus(finalStatus.stdout, true);
        if (finalStatus.code !== 0 || finalClass.changed.length) { keep({ ...base, reason: "uncommitted" }); continue; }
        const finalHead = await ports.git(["rev-parse", "--verify", "HEAD"], worktree);
        if (finalHead.code !== 0 || finalHead.stdout.trim() !== proof.head) {
          keep({ ...base, reason: retained ? "local-only-commits" : "unmerged-commits", detail: "HEAD changed after its preservation proof" });
          continue;
        }
        const finalIgnored = keptIgnored(accessible(worktree), finalClass.ignored);
        const trackedNow = await ports.git(["ls-files", "--cached", "-v", "-z"], worktree);
        if (trackedNow.code !== 0) { keep({ ...base, reason: "uncommitted" }); continue; }
        const tagged = trackedNow.stdout.split("\0").filter(Boolean);
        // Git status and worktree removal trust these index flags. They cannot
        // establish that a tracked file contains no unique local edits.
        if (tagged.some(file => !file.startsWith("H "))) {
          keep({ ...base, reason: "uncommitted", detail: "Git index flags hide tracked contents" }); continue;
        }
        const trackedPaths = tagged.map(file => file.slice(2)).join("\0") + (tagged.length ? "\0" : "");
        if (!sameTrackedFiles(originalTracked, trackedSnapshot(accessible(worktree), trackedPaths))) {
          keep({ ...base, reason: "uncommitted", detail: "tracked contents changed during cleanup checks" }); continue;
        }
        const newlyIgnored = freshIgnored(accessible(worktree), trackedPaths);
        const registration = registrationHold(root, worktree, worktree, accessible);
        if (registration) { keep({ ...registration, ...base }); continue; }
        if (finalIgnored.length || newlyIgnored.length) { keep({ ...base, reason: "ignored-files" }); continue; }
        const finalBusy = heldBy(readGuards(), worktree, entry.branch);
        if (finalBusy) { keep({ ...finalBusy, ...base }); continue; }
        if (dryRun) {
          report.removed.push(removal);
          report.removedBytes += bytes;
          remaining.delete(worktree);
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
      } finally { releaseHead(); }
    }

    // Retained, settled lanes release ignored dependency/build/cache bulk and
    // the evidence drivers' fixture-only bundles, keeping protected contents.
    for (const entry of ordered) {
      const worktree = resolve(entry.path);
      if (!remaining.has(worktree) || entry.locked || entry.prunable
        || worktree === mainPath || roots.has(worktree)
        || projectRoots.some((project) => inside(project, worktree))) continue;
      const owners = ownersOf(ownersAtStart, worktree);
      const owner = owners.find((pipeline) => {
        const source = resolve(pipeline.repoDir);
        return worktree === path.join(path.dirname(source), `${path.basename(source)}-pipeline-${pipeline.id}`);
      });
      if (!owner || owners.some(pipelineHoldsCheckout) || heldBy(readGuards(), worktree)) continue;
      const candidates: string[] = [];
      try {
        for (const child of fs.readdirSync(accessible(worktree), { withFileTypes: true })) {
          if (child.isDirectory() && rebuildableDirectory(child.name)
            && disposableIgnored(accessible(worktree), child.name)) candidates.push(path.join(worktree, child.name));
        }
      } catch { /* Unreadable output trees stay. */ }
      // Inside artifacts, only fixture bundles carry a regeneration proof.
      const pending = [path.join(worktree, ".artifacts")];
      let visited = 0;
      while (pending.length && visited < MEASURE_ENTRY_LIMIT) {
        const current = pending.pop()!;
        try {
          if (!fs.lstatSync(accessible(current)).isDirectory()) continue;
          if (fs.existsSync(path.join(accessible(current), ".git"))) continue;
          for (const child of fs.readdirSync(accessible(current), { withFileTypes: true })) {
            visited += 1;
            if (!child.isDirectory() || child.name === ".git") continue;
            const directory = path.join(current, child.name);
            if (child.name === "node_modules" || child.name === ".next") continue;
            if (child.name === "bundle" && fixtureBundle(accessible(directory))) candidates.push(directory);
            else pending.push(directory);
          }
        } catch { /* Missing or unreadable artifacts stay. */ }
      }
      for (const next of candidates) {
        const relative = path.relative(worktree, next);
        const artifact = relative.split(path.sep).includes(".artifacts");
        if (!artifact) {
          const ignored = await ports.git(["check-ignore", "-q", "--", relative], worktree);
          if (ignored.code !== 0) continue;
        }
        const identity = (directory: string) => {
          try {
            const stat = fs.lstatSync(accessible(directory));
            return stat.isDirectory() ? `${stat.dev}:${stat.ino}:${fs.realpathSync(accessible(directory))}` : null;
          } catch { return null; }
        };
        const originalWorktree = identity(worktree);
        const originalNext = identity(next);
        if (!originalWorktree || !originalNext) continue;
        const safeDirectory = (worktrees = listed) => {
          try {
            if (identity(worktree) !== originalWorktree || identity(next) !== originalNext) return false;
            const realWorktree = fs.realpathSync(accessible(worktree));
            const realNext = fs.realpathSync(accessible(next));
            return realNext === path.join(realWorktree, path.relative(worktree, next))
              && !worktrees.some((other) => inside(resolve(other.path), next));
          } catch { return false; }
        };
        if (!safeDirectory()) continue;
        const tracked = await ports.git(["ls-files", "-z", "--", path.relative(worktree, next)], worktree);
        if (tracked.code !== 0 || tracked.stdout.length) continue;
        const bytes = await measure(next);
        // The cache measurement yields; Git locks and nested checkouts may have
        // appeared meanwhile. Unknown metadata cannot authorize recursive removal.
        let currentListing;
        try { currentListing = await ports.git(["worktree", "list", "--porcelain", "-z"], root); }
        catch { continue; }
        if (currentListing.code !== 0) continue;
        const currentWorktrees = parseWorktreeList(currentListing.stdout);
        const currentEntry = currentWorktrees.find((other) => resolve(other.path) === worktree);
        if (!currentEntry || currentEntry.bare || currentEntry.locked || currentEntry.prunable) continue;
        // Measurement yields: refresh both activity and directory guards last.
        const nowOwners = ownersOf(ownershipPipelines(), worktree);
        if (!nowOwners.some((pipeline) => pipeline.id === owner.id) || nowOwners.some(pipelineHoldsCheckout)
          || heldBy(readGuards(), worktree) || !safeDirectory(currentWorktrees)) continue;
        const trackedNow = await ports.git(["ls-files", "-z", "--", path.relative(worktree, next)], worktree);
        if (trackedNow.code !== 0 || trackedNow.stdout.length) continue;
        // A unique log or source added during any async check changes a
        // fixture bundle's classification. Keep the whole directory then.
        if (artifact ? !fixtureBundle(accessible(next)) : !disposableIgnored(accessible(worktree), relative)) continue;
        if (registrationHold(root, worktree, next, accessible) || heldBy(readGuards(), worktree)) continue;
        // The last Git read also yields. Refuse a replaced checkout, cache or
        // artifact parent before recursive removal can follow its new target.
        if (!safeDirectory(currentWorktrees)) continue;
        try {
          if (!dryRun) await fs.promises.rm(accessible(next), { recursive: true });
          report.trimmed.push({ path: next, bytes, pipelineId: owner.id });
          report.trimmedBytes += bytes;
        } catch (error) { report.errors.push(`${next}: build cache trim failed: ${String(error)}`); }
      }
    }
  }
  const seenKept = new Set<string>();
  for (const kept of [...report.kept].sort((a, b) => b.path.split(path.sep).length - a.path.split(path.sep).length)) {
    const nested = report.kept.filter(other => other !== kept && inside(other.path, kept.path) && other.path !== kept.path);
    const reached = accessible(kept.path);
    let rootBytes = 0;
    // Parent walks exclude nested roots. Attribute their directory blocks to
    // the nested decision too, once, along with its files.
    if (report.kept.some(other => other.path !== kept.path && inside(kept.path, other.path))) {
      try {
        const stat = fs.statSync(reached);
        if (!seenKept.has(`${stat.dev}:${stat.ino}`)) rootBytes = stat.blocks * 512;
      } catch { /* Unavailable directories contribute no measured blocks. */ }
    }
    kept.bytes = rootBytes + await allocatedBytes(reached, nested.map(row => accessible(row.path)), seenKept);
    report.keptBytes[kept.reason] = (report.keptBytes[kept.reason] ?? 0) + kept.bytes;
  }
  return report;
}

const REPORT_FILE = () => statePath("worktree-sweep-report.json");

export function readWorktreeSweepReport(): WorktreeSweepReport | null {
  try { return JSON.parse(fs.readFileSync(REPORT_FILE(), "utf8")) as WorktreeSweepReport; }
  catch { return null; }
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function summarizeWorktreeSweep(report: WorktreeSweepReport): string {
  const verb = report.mode === "dry-run" ? "would remove" : "removed";
  const kept = Object.entries(report.keptCounts).map(([reason, count]) => `${count} ${reason} (${gigabytes(report.keptBytes?.[reason as WorktreeKeptReason] ?? 0)})`).join(", ");
  return `[worktree sweep] ${verb} ${report.removed.length} worktree(s) (${gigabytes(report.removedBytes)}) across ${report.repositories.length} repositor${report.repositories.length === 1 ? "y" : "ies"};`
    + ` ${report.mode === "dry-run" ? "would trim" : "trimmed"} ${report.trimmed?.length ?? 0} build cache(s) (${gigabytes(report.trimmedBytes ?? 0)}); kept ${report.kept.length}${kept ? ` (${kept})` : ""}; ${report.errors.length} error(s)`;
}

/** Kept reasons that wait for someone: the sweep will not free them by itself. */
const DECISION_REASONS: ReadonlySet<WorktreeKeptReason> = new Set(["local-only-commits", "unmerged-commits", "ignored-files", "pr-head-unknown", "remove-failed", "map-write-failed"]);

/** The last report as the resources read surface carries it: counts and
    bytes per reason, no paths. */
export function worktreeSweepStatus(report: WorktreeSweepReport | null = readWorktreeSweepReport()) {
  if (!report) return null;
  const waiting = report.kept.filter((row) => DECISION_REASONS.has(row.reason));
  return {
    at: report.at, mode: report.mode, summary: summarizeWorktreeSweep(report),
    removed: report.removed.length, removedBytes: report.removedBytes, trimmedBytes: report.trimmedBytes ?? 0,
    keptCounts: report.keptCounts, keptBytes: report.keptBytes ?? {},
    waitsForDecision: waiting.length,
    waitsForDecisionBytes: waiting.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
  };
}

/* ── Production ports ───────────────────────────────────────────────────── */

const GIT_TIMEOUT_MS = 120_000;

/** Literal Git objects without prompts or optional locks, so history
    overrides cannot authorize deletion and status never rewrites the index. */
function runGitCommand(command: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolveRun) => {
    execFile(command, args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...pipelineLiteralGitEnv(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout, stderr) => {
      /* A non-zero exit carries its status in `code`; a spawn failure or a
         timeout carries a string or nothing, which reads as no status at all. */
      const status = (error as { code?: unknown } | null)?.code;
      const code = !error ? 0 : typeof status === "number" ? status : null;
      resolveRun({ code, stdout: String(stdout ?? ""), stderr: String(stderr || error?.message || "") });
    });
  });
}

export const realGit: GitRun = (args, cwd) => runGitCommand("git", args, cwd);

/** Host role checkouts use the same sweep and guards. Files are read through
    the namespace root; Git removes its registered canonical path inside that
    namespace, with the caller's uid and groups. A gone or recycled anchor
    cannot authorize an operation in a different namespace. */
export function hostTempWorktreeAccess(
  roots: readonly TempSweepRoot[], run = runGitCommand,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const namespace = env.LLV_DOCKER_NSENTER_SHIMS === "1" ? stageHostNamespace() : null;
  const foreign = roots.filter(root => namespace && root.via && root.anchor?.namespace === namespace);
  const rootFor = (directory: string) => !fs.existsSync(directory) ? foreign.find(root => inside(directory, root.path)) : undefined;
  const valid = (root: TempSweepRoot) => {
    try { return fs.readlinkSync(path.join(path.dirname(root.via), "ns/mnt")) === root.anchor?.namespace; }
    catch { return false; }
  };
  return {
    accessiblePath: (directory: string) => {
      const root = rootFor(directory);
      return root ? (valid(root) ? root.via : "/proc/0/root") + directory : directory;
    },
    git: (async (args: string[], cwd: string) => {
      const target = args[0] === "worktree" && args[1] === "remove" ? args[2]! : cwd;
      let root = rootFor(target);
      if (!root && args[0] === "worktree" && args[1] === "list" && foreign.length) {
        // List locally first. Only registrations outside our own filesystem
        // need the host view; unrelated private agent namespaces never select it.
        const listed = await run("git", args, cwd);
        if (listed.code !== 0) return listed;
        root = parseWorktreeList(listed.stdout).map(entry => rootFor(entry.path)).find(Boolean);
        if (!root) return listed;
      }
      if (!root) return run("git", args, cwd);
      if (!valid(root)) return Promise.resolve({ code: 1, stdout: "", stderr: "host temp namespace is unavailable" });
      return run("nsenter", hostCommandArgs(root.anchor!.pid, "/bin/sh", ["-c",
        'cd "$1" || exit; shift; exec git "$@"', "sh", cwd, ...args]), os.tmpdir());
    }) satisfies GitRun,
  };
}

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
  const pipelines = withArchived(loadPipelinesForList(), loadArchivedPipelines());
  const repositories = projectCurationSnapshot().manualProjects.map((project) => project.root);
  const view = await openHostTempRoots(sweepRoots(scanProcesses(), [...ownTempRoots(), statePath("scratch")]));
  const temp = view.roots;
  const access = hostTempWorktreeAccess(temp);
  return {
    mode,
    close: view.close,
    previous: readWorktreeSweepReport(),
    ...access,
    mergedPullRequests: productionMergedPullRequests({
      cache: forgeCacheMergedPullRequests(() => readForgeCache().data),
      gh: ghMergedPullRequests(run),
    }),
    /* Settled lanes move to the archive after a while; their delivered PR
       numbers are what find a PR whose head is not the lane branch. */
    pipelines,
    currentPipelines: () => loadPipelinesForList(),
    repositories,
    conversationCwds: () => liveOrWaitingConversationCwds(agentRegistry().readOnlySnapshot()),
    scan: () => scanProcesses(),
    recordResolution: (worktree) => recordWorktreeResolution(worktree, access.accessiblePath(worktree)) !== null,
    tempRoots: [...new Set(temp.map(root => root.path))],
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
