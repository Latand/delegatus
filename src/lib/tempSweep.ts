import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { STRUCTURED_HOST_STAMP_ENV } from "@/lib/scanner/process";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { OWNED_TEMP_PREFIX } from "@/lib/tempDirs";

/**
 * The bounded sweeper for temp directories Delegatus left behind (#1957).
 *
 * The creators clean up after themselves now: a test run removes its one root
 * (`test-preload.ts`), a pipeline stage's scratch directory goes with its host
 * (`materializeStructuredHostAccess`). What they cannot clean is a process
 * killed before it got there, and the residue that predates them. The sweeper
 * removes those, and nothing else:
 *
 * - **Only owned names.** `llv-*`, plus three test prefixes from before the
 *   per-run root existed. `llv-spawn-sandbox` (every agent's config root, kept
 *   on purpose so a resumed agent finds its own) and `llv-tmux-cwd` are never
 *   candidates. A name Delegatus did not choose is never touched, however old.
 * - **Only direct children of the temp roots it uses**: `/tmp`, `/var/tmp`,
 *   this process's temp dir and the Viewer's `scratch` directory. Never a root
 *   itself, never a symlink, never a directory another user owns.
 * - **Only when stale**: the newest modification time of the directory and its
 *   immediate entries is older than the threshold (24 h by default).
 * - **Never in use**: no live process has it, or anything inside it, as its
 *   working directory, an open file, or its `TMPDIR`/`LLV_STATE_DIR`/
 *   `XDG_CONFIG_HOME`/`CLAUDE_CODE_TMPDIR`. A stage agent whose shell is idle
 *   still carries its scratch directory in `TMPDIR`, so it is kept.
 * - **Never a pipeline worktree**, or a directory holding one, or holding any
 *   git checkout: registered linked merger, review and attribution checkouts
 *   are freed by the worktree sweep after its commit preservation proof,
 *   including host temp roots reached through an agent namespace. Independent
 *   repositories and unreadable trees stay for a decision: their preservation
 *   and ownership have not been proven. The report names these holds.
 *
 * In the Docker install the Viewer's `/tmp` is the container's own, while the
 * agents run on the host through the nsenter shims and fill the host's. The
 * host's temp roots are read through `/proc/<pid>/root` of an agent process
 * (one carrying the structured-host stamp) running in that mount namespace, and
 * the namespace is re-checked before every removal so a recycled pid can never
 * redirect one.
 */

export const DEFAULT_TEMP_SWEEP_MAX_AGE_HOURS = 24;
const HOUR_MS = 3_600_000;
export const TEMP_SWEEP_INTERVAL_MS = HOUR_MS;
/** Boot is busy enough; the first sweep waits for it to settle. */
const FIRST_SWEEP_DELAY_MS = 5 * 60_000;
/** Directories one sweep may remove; the rest wait for the next hour. */
const MAX_REMOVALS_PER_SWEEP = 500;
/** Entries one size measurement visits before it reports a lower bound. */
const MEASURE_ENTRY_LIMIT = 200_000;
/** Immediate entries read when dating a directory. */
const AGE_ENTRY_LIMIT = 1_000;
const JOURNAL_ROTATE_BYTES = 1_000_000;

/** Test prefixes from before the per-run test root; each is unique to this repository's suites. */
const LEGACY_OWNED_PREFIXES = ["pending-producer-", "inflight-producer-", "child-owner-"] as const;
/** Owned names that hold live, shared state and are never swept. */
const KEPT_OWNED_NAMES = new Set(["llv-spawn-sandbox", "llv-tmux-cwd"]);
/** Environment variables whose directory a process is using even while it holds nothing open there. */
const IN_USE_ENV = ["TMPDIR", "TMP", "TEMP", "LLV_STATE_DIR", "XDG_CONFIG_HOME", "CLAUDE_CODE_TMPDIR"] as const;

export function isOwnedTempName(name: string): boolean {
  if (KEPT_OWNED_NAMES.has(name)) return false;
  if (name.startsWith(OWNED_TEMP_PREFIX) && name.length > OWNED_TEMP_PREFIX.length) return true;
  return LEGACY_OWNED_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

/** Shared agent state consumes owned space while remaining protected from cleanup. */
export function isOwnedTempConsumerName(name: string): boolean {
  return KEPT_OWNED_NAMES.has(name) || isOwnedTempName(name);
}

/** The staleness threshold, or null when the operator turned the sweep off
    with `LLV_TEMP_SWEEP_MAX_AGE_HOURS=0`. */
export function tempSweepMaxAgeMs(env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const raw = env.LLV_TEMP_SWEEP_MAX_AGE_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TEMP_SWEEP_MAX_AGE_HOURS * HOUR_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    console.warn(`[temp sweep] LLV_TEMP_SWEEP_MAX_AGE_HOURS is not a duration; using ${DEFAULT_TEMP_SWEEP_MAX_AGE_HOURS}h`);
    return DEFAULT_TEMP_SWEEP_MAX_AGE_HOURS * HOUR_MS;
  }
  return hours === 0 ? null : hours * HOUR_MS;
}

/** One live process, as far as the sweep needs it. */
export type ScannedProcess = {
  pid: number;
  /** The mount namespace link (`mnt:[4026531841]`), or null off Linux. */
  namespace: string | null;
  /** Carries the structured-host stamp: an agent Delegatus started. */
  stamped: boolean;
  /** Paths it is using: cwd, open files, and the directories named by {@link IN_USE_ENV}. */
  paths: string[];
};

export type ProcessScan = { ownNamespace: string | null; processes: ScannedProcess[] };

function readLink(file: string): string | null {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
}

/** Every process this user can inspect, in one pass over `/proc`. A process of
    another user answers nothing and cannot be using a 0700 directory of ours. */
export function scanProcesses(procRoot = "/proc"): ProcessScan {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return portableScan();
  }
  const processes: ScannedProcess[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const base = path.join(procRoot, name);
    const namespace = readLink(path.join(base, "ns", "mnt"));
    if (!namespace) continue;
    const paths: string[] = [];
    const cwd = readLink(path.join(base, "cwd"));
    if (cwd) paths.push(cwd);
    try {
      for (const fd of fs.readdirSync(path.join(base, "fd"))) {
        const target = readLink(path.join(base, "fd", fd));
        if (target?.startsWith("/")) paths.push(target);
      }
    } catch {
      /* Exited mid-scan, or not ours. */
    }
    let stamped = false;
    try {
      for (const pair of fs.readFileSync(path.join(base, "environ"), "utf8").split("\0")) {
        const equals = pair.indexOf("=");
        if (equals <= 0) continue;
        const key = pair.slice(0, equals);
        if (key === STRUCTURED_HOST_STAMP_ENV) stamped = true;
        else if ((IN_USE_ENV as readonly string[]).includes(key) && pair.length > equals + 1) paths.push(pair.slice(equals + 1));
      }
    } catch {
      /* Exited mid-scan, or not ours. */
    }
    processes.push({ pid: Number(name), namespace, stamped, paths });
  }
  return { ownNamespace: readLink(path.join(procRoot, "self", "ns", "mnt")), processes };
}

/** Without `/proc`: working directories and open files through the platform backend, one namespace. */
function portableScan(): ProcessScan {
  const byPid = new Map<number, string[]>();
  for (const entry of procBackend.listProcesses()) byPid.set(entry.pid, entry.cwd ? [entry.cwd] : []);
  for (const root of ownTempRoots()) {
    procBackend.scanFdTargetsUnder(root, (target, pid) => {
      const list = byPid.get(pid) ?? [];
      list.push(target);
      byPid.set(pid, list);
    });
  }
  return {
    ownNamespace: null,
    processes: [...byPid].map(([pid, paths]) => ({ pid, namespace: null, stamped: false, paths })),
  };
}

/** A temp root as its users see it, and how this process reaches it. */
export type TempSweepRoot = {
  /** The path the processes using it see. In-use checks compare against this. */
  path: string;
  /** Prefix under which this process reads it: "" in its own namespace, `/proc/<pid>/root` in another. */
  via: string;
  /** For a root in another namespace: the pid it is read through and the namespace it must still be in. */
  anchor?: { pid: number; namespace: string };
};

function realDirectory(candidate: string | undefined): string | null {
  if (!candidate?.trim()) return null;
  try {
    const real = fs.realpathSync(candidate);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Resolve aliases even when a queued cwd or temp path has a missing suffix. */
export function resolvePhysicalPath(candidate: string): string {
  const original = path.resolve(candidate);
  let current = original;
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...suffix); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return original;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function ownTempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [os.tmpdir(), env.TMPDIR, "/tmp", "/var/tmp"].map(realDirectory);
  return [...new Set(roots.filter((root): root is string => root !== null && root !== "/"))];
}

/** The roots this process can remove anything from. A container that mounts
    the host's `/var/tmp` read-only (the evidence the image routes serve,
    #2084) sees it as its own temp root; every removal there would fail with
    EROFS and every size walk would run twice, so it is left to the host
    namespace's own `/var/tmp`, which the sweep reaches through an agent. */
export function writableRoots(roots: string[], check: (root: string) => void = (root) => fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK)): string[] {
  return roots.filter((root) => {
    try {
      check(root);
      return true;
    } catch {
      return false;
    }
  });
}

/** The roots one sweep visits: this process's temp dirs and scratch directory,
    and `/tmp` and `/var/tmp` of every other mount namespace a Delegatus agent
    runs in. */
export function sweepRoots(scan: ProcessScan, ownRoots: string[], procRoot = "/proc"): TempSweepRoot[] {
  const roots: TempSweepRoot[] = ownRoots.map((root) => ({ path: root, via: "" }));
  const seen = new Set<string>();
  for (const process of scan.processes) {
    if (!process.stamped || !process.namespace) continue;
    if (process.namespace === scan.ownNamespace || seen.has(process.namespace)) continue;
    seen.add(process.namespace);
    const via = path.join(procRoot, String(process.pid), "root");
    for (const root of ["/tmp", "/var/tmp"]) {
      roots.push({ path: root, via, anchor: { pid: process.pid, namespace: process.namespace } });
    }
  }
  return roots;
}

function inside(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(directory + path.sep);
}

export type TempSweepRemoval = { path: string; via: string; bytes: number; ageHours: number };

export type TempSweepReport = {
  at: string;
  maxAgeHours: number;
  roots: string[];
  removed: TempSweepRemoval[];
  removedBytes: number;
  kept: { young: number; inUse: number; worktree: number; deferred: number };
  /** Allocations retained under each guard; absent in older report versions. */
  keptBytes?: TempSweepReport["kept"];
  /** Git or inspection holds beyond the pipeline worktree list. */
  held?: { path: string; via: string; reason: "git-checkout" | "unreadable-tree" | "entry-limit"; bytes: number }[];
  errors: string[];
};

export type TempSweepOptions = {
  maxAgeMs: number;
  now?: () => number;
  uid?: number | null;
  roots?: TempSweepRoot[];
  scan?: ProcessScan;
  /** Pipeline worktrees; never removed, nor any directory holding one. */
  worktrees?: string[];
  /** Refresh pipeline ownership after asynchronous measurements. */
  currentWorktrees?: () => readonly string[];
  /** Retained checkouts already attributed by the worktree sweep report. */
  accountedWorktrees?: string[];
  procRoot?: string;
  maxRemovals?: number;
};

/** Newest modification time of a directory and its immediate entries. */
function newestMtimeMs(directory: string, own: fs.Stats): number {
  let newest = own.mtimeMs;
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return newest;
  }
  for (const name of names.slice(0, AGE_ENTRY_LIMIT)) {
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(directory, name)).mtimeMs);
    } catch {
      /* Gone mid-read. */
    }
  }
  return newest;
}

/** Allocated bytes under a directory, without following symlinks; a lower bound past the entry limit. */
async function measureBytes(directory: string, seen = new Set<string>(), includeRoot = false, excluded: readonly string[] = [], linkedFiles?: Set<string>): Promise<number> {
  let bytes = 0;
  const excludedDirectories = new Set<string>();
  const excludedPaths: string[] = [];
  for (const candidate of excluded) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        excludedDirectories.add(`${stat.dev}:${stat.ino}`);
        excludedPaths.push(fs.realpathSync(candidate));
      }
    } catch { /* An absent checkout has no overlapping allocation. */ }
  }
  try {
    const stat = await fs.promises.stat(directory);
    const identity = `${stat.dev}:${stat.ino}`;
    const physical = fs.realpathSync(directory);
    if (excludedPaths.some(excluded => physical.startsWith(excluded + path.sep))) return 0;
    if (seen.has(identity)) return 0;
    seen.add(identity);
    if (includeRoot) bytes += stat.blocks * 512;
    if (excludedDirectories.has(identity)) return bytes;
  } catch { return 0; }
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
        const identity = `${stat.dev}:${stat.ino}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (!stat.isDirectory() && stat.nlink > 1) linkedFiles?.add(identity);
        bytes += stat.blocks * 512;
        if (entry.isDirectory() && !excludedDirectories.has(identity)) pending.push(child);
      } catch {
        /* Gone mid-walk. */
      }
    }
  }
  return bytes;
}

function namespaceStill(anchor: TempSweepRoot["anchor"], procRoot: string): boolean {
  if (!anchor) return true;
  return readLink(path.join(procRoot, String(anchor.pid), "ns", "mnt")) === anchor.namespace;
}

/** Damaged or unknown Git metadata still holds its tree. The empty marker
    in uv's source-distribution cache is the one proved disposable class. */
function gitCheckoutMarker(entry: string, directory: boolean): boolean {
  try {
    if (directory) return true;
    const stat = fs.lstatSync(entry);
    return !stat.isFile() || stat.size !== 0 || !/(?:^|\/)uvcache\/sdists-v\d+(?:\/|$)/.test(entry.replaceAll(path.sep, "/"));
  } catch {
    // Unreadable repository metadata cannot prove a disposable cache marker.
    return true;
  }
}

/** A merger batch, a review export or an attribution run can leave a git
    checkout inside its temp root, with commits nowhere else. A recursive
    delete cannot prove them kept, so a root holding one stays: a linked
    checkout of a registered repository is the worktree sweep's to free, under
    its retention and remote proof. A tree too large to search stays too. */
export function containsGitCheckout(directory: string): "git-checkout" | "unreadable-tree" | "entry-limit" | null {
  const pending = [directory];
  let visited = 0;
  try {
    if (!fs.lstatSync(directory).isDirectory()) return null;
    while (pending.length) {
      const current = pending.pop()!;
      // A damaged bare repository can lose HEAD while its refs and objects
      // still hold unpublished work.
      const config = path.join(current, "config");
      const bareMetadata = ["HEAD", "refs/heads", "refs/tags"].some(name => fs.existsSync(path.join(current, name)))
        || (fs.existsSync(config) && fs.lstatSync(config).isFile());
      if (bareMetadata && fs.existsSync(path.join(current, "objects"))
        && fs.statSync(path.join(current, "objects")).isDirectory()) return "git-checkout";
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (++visited > MEASURE_ENTRY_LIMIT) return "entry-limit";
        const child = path.join(current, entry.name);
        if (entry.name === ".git" && gitCheckoutMarker(child, entry.isDirectory())) return "git-checkout";
        if (entry.isDirectory() && entry.name !== ".git") pending.push(child);
      }
    }
    return null;
  } catch { return "unreadable-tree"; }
}

/** One sweep. Never throws for a single directory; its failure lands in `errors`. */
export async function sweepStaleTempDirs(options: TempSweepOptions): Promise<TempSweepReport> {
  const now = options.now?.() ?? Date.now();
  const procRoot = options.procRoot ?? "/proc";
  const uid = options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  const readScan = () => options.scan ?? scanProcesses(procRoot);
  const scan = readScan();
  const roots = options.roots ?? sweepRoots(scan, ownTempRoots(), procRoot);
  const inUse = scan.processes.flatMap((process) => process.paths.map((entry) => path.resolve(entry)));
  const readWorktrees = () => (options.currentWorktrees?.() ?? options.worktrees ?? []).map(entry => path.resolve(entry));
  const worktrees = readWorktrees();
  const accounted = (options.accountedWorktrees ?? []).map(entry => path.resolve(entry));
  const maxRemovals = options.maxRemovals ?? MAX_REMOVALS_PER_SWEEP;
  const report: TempSweepReport = {
    at: new Date(now).toISOString(),
    maxAgeHours: options.maxAgeMs / HOUR_MS,
    roots: roots.map((root) => root.via ? `${root.path} (via ${root.via})` : root.path),
    removed: [],
    removedBytes: 0,
    kept: { young: 0, inUse: 0, worktree: 0, deferred: 0 },
    keptBytes: { young: 0, inUse: 0, worktree: 0, deferred: 0 },
    held: [],
    errors: [],
  };
  const seenCandidates = new Set<string>();
  const seenAllocations = new Set<string>();
  const candidates: { root: TempSweepRoot; candidate: string }[] = [];
  for (const root of roots) {
    if (!namespaceStill(root.anchor, procRoot)) {
      report.errors.push(`${root.path} (via ${root.via}): namespace is unavailable; skipped`);
      continue;
    }
    let names: string[];
    try {
      names = fs.readdirSync(root.via + root.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.errors.push(`${root.via}${root.path}: ${(error as Error).message}`);
      continue;
    }
    for (const name of names.sort()) {
      if (!isOwnedTempName(name)) continue;
      candidates.push({ root, candidate: path.join(root.path, name) });
    }
  }
  // Retained checkouts own their shared file allocations. Seed only hard-link
  // identities; enclosing temp trees still own the checkout directory blocks.
  // One bounded walk per physical checkout also covers namespace aliases.
  const seenAccounted = new Set<string>();
  for (const root of candidates.length ? roots : []) {
    if (!namespaceStill(root.anchor, procRoot)) continue;
    for (const checkout of accounted) {
      const links = new Set<string>();
      await measureBytes(root.via + checkout, seenAccounted, false, [], links);
      if (namespaceStill(root.anchor, procRoot)) for (const identity of links) seenAllocations.add(identity);
    }
  }
  // Nested owned roots receive their own allocations before a parent walk.
  for (const { root, candidate } of candidates.sort((a, b) => b.candidate.split(path.sep).length - a.candidate.split(path.sep).length)) {
    if (!namespaceStill(root.anchor, procRoot)) {
      report.errors.push(`${root.path} (via ${root.via}): namespace changed before inspection; skipped`);
      continue;
    }
    const reachable = root.via + candidate;
    let stat: fs.Stats;
    let originalPath: string;
    try {
      stat = fs.lstatSync(reachable);
      originalPath = fs.realpathSync(reachable);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) continue;
    const identity = `${stat.dev}:${stat.ino}`;
    if (seenCandidates.has(identity)) continue;
    seenCandidates.add(identity);
    const excluded = accounted.flatMap(checkout => root.via ? [checkout, root.via + checkout] : [checkout]);
    const includeRoot = candidates.some(other => other.candidate !== candidate && inside(candidate, other.candidate));
    const keep = async (reason: keyof TempSweepReport["kept"], measured?: number): Promise<boolean> => {
      const bytes = measured ?? await measureBytes(reachable, seenAllocations, includeRoot, excluded);
      if (!namespaceStill(root.anchor, procRoot)) {
        report.errors.push(`${root.path} (via ${root.via}): namespace changed during measurement; skipped`);
        return false;
      }
      report.kept[reason] += 1;
      report.keptBytes![reason] += bytes;
      return true;
    };
    const newest = newestMtimeMs(reachable, stat);
    if (now - newest < options.maxAgeMs) {
      await keep("young");
      continue;
    }
    const processHolds = (entry: string) => inside(entry, candidate)
      || inside(resolvePhysicalPath(root.via + entry), originalPath);
    if (inUse.some(processHolds)) {
      await keep("inUse");
      continue;
    }
    const physicallyOverlaps = (entries: readonly string[]) => entries.some(entry => (root.via ? [entry, root.via + entry] : [entry]).some(accessible => {
      try {
        const physical = fs.realpathSync(accessible);
        return inside(physical, originalPath) || inside(originalPath, physical);
      } catch { return false; }
    }));
    const protectedBy = (entries: readonly string[]) => entries.some(entry => inside(entry, candidate) || inside(candidate, entry)) || physicallyOverlaps(entries);
    const checkoutHold = (entries: readonly string[]) => protectedBy(entries) ? "git-checkout" : containsGitCheckout(reachable)
      ?? (physicallyOverlaps(accounted) ? "git-checkout" : null);
    const hold = checkoutHold(worktrees);
    if (hold) {
      const bytes = await measureBytes(reachable, seenAllocations, includeRoot, excluded);
      if (await keep("worktree", bytes)) report.held!.push({ path: candidate, via: root.via, reason: hold, bytes });
      continue;
    }
    if (report.removed.length >= maxRemovals) {
      await keep("deferred");
      continue;
    }
    if (!namespaceStill(root.anchor, procRoot)) {
      report.errors.push(`${root.path} (via ${root.via}): the namespace it was read through is gone; skipped`);
      continue;
    }
    try {
      const bytes = await measureBytes(reachable, seenAllocations, includeRoot, excluded);
      if (readScan().processes.some(process => process.paths.some(entry => processHolds(path.resolve(entry))))) {
        await keep("inUse", bytes);
        continue;
      }
      // Measurement yields to new owners and filesystem activity. Date and
      // inspect the same physical tree again immediately before removal.
      const current = fs.lstatSync(reachable);
      if (!current.isDirectory() || (uid !== null && current.uid !== uid) || `${current.dev}:${current.ino}` !== identity
        || fs.realpathSync(reachable) !== originalPath) {
        report.errors.push(`${reachable}: temp directory changed during measurement; skipped`);
        continue;
      }
      if ((options.now?.() ?? Date.now()) - newestMtimeMs(reachable, current) < options.maxAgeMs) {
        await keep("young", bytes);
        continue;
      }
      /* A checkout made meanwhile still keeps the measured tree. */
      const finalHold = checkoutHold(readWorktrees());
      if (finalHold) {
        if (await keep("worktree", bytes)) report.held!.push({ path: candidate, via: root.via, reason: finalHold, bytes });
        continue;
      }
      if (!namespaceStill(root.anchor, procRoot)) {
        report.errors.push(`${root.path} (via ${root.via}): namespace changed during measurement; skipped`);
        continue;
      }
      await fs.promises.rm(reachable, { recursive: true, force: true });
      report.removed.push({ path: candidate, via: root.via, bytes, ageHours: Math.round((now - newest) / HOUR_MS) });
      report.removedBytes += bytes;
    } catch (error) {
      report.errors.push(`${reachable}: ${(error as Error).message}`);
    }
  }
  return report;
}

const REPORT_FILE = () => statePath("temp-sweep-report.json");
const JOURNAL_FILE = () => statePath("temp-sweep-journal.ndjson");

function readTempSweepReport(): TempSweepReport | null {
  try { return JSON.parse(fs.readFileSync(REPORT_FILE(), "utf8")) as TempSweepReport; }
  catch { return null; }
}

/** Operator summary for the existing resources surface. Held directories
    need Git preservation or tree inspection; their paths stay in the file. */
export function tempSweepStatus(report: TempSweepReport | null = readTempSweepReport()) {
  if (!report) return null;
  const heldCounts: Record<string, number> = {};
  const heldBytes: Record<string, number> = {};
  for (const hold of report.held ?? []) {
    heldCounts[hold.reason] = (heldCounts[hold.reason] ?? 0) + 1;
    heldBytes[hold.reason] = (heldBytes[hold.reason] ?? 0) + hold.bytes;
  }
  return {
    at: report.at, removed: report.removed.length, removedBytes: report.removedBytes,
    kept: { ...report.kept }, keptBytes: report.keptBytes ? { ...report.keptBytes } : null, heldCounts, heldBytes, errors: report.errors.length,
    summary: `[temp sweep] removed ${report.removed.length} directories (${megabytes(report.removedBytes)}); held ${(report.held ?? []).length} for Git preservation or tree inspection; ${report.errors.length} error(s)`,
  };
}

/** The last sweep in full, and one journal line per removed directory. */
export function recordTempSweep(report: TempSweepReport): void {
  fs.mkdirSync(path.dirname(REPORT_FILE()), { recursive: true, mode: 0o700 });
  writeJsonDurably(REPORT_FILE(), report);
  if (report.removed.length === 0) return;
  const journal = JOURNAL_FILE();
  try {
    if (fs.statSync(journal).size > JOURNAL_ROTATE_BYTES) fs.renameSync(journal, `${journal}.1`);
  } catch {
    /* No journal yet. */
  }
  fs.appendFileSync(journal, report.removed.map((removal) => JSON.stringify({ at: report.at, ...removal })).join("\n") + "\n");
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

async function cleanupWorktrees() {
  const [{ loadPipelinesForList }, { readWorktreeSweepReport }] = await Promise.all([
    import("@/lib/pipelines/store"), import("@/lib/pipelines/worktreeSweep"),
  ]);
  return {
    worktrees: loadPipelinesForList().map(pipeline => pipeline.worktreeDir).filter((dir): dir is string => !!dir),
    currentWorktrees: () => loadPipelinesForList().map(pipeline => pipeline.worktreeDir).filter((dir): dir is string => !!dir),
    accountedWorktrees: (readWorktreeSweepReport()?.kept ?? []).map(row => row.path),
  };
}

/** The production sweep: threshold from the environment, worktrees from the pipelines store. */
export async function runTempSweep(env: NodeJS.ProcessEnv = process.env, ports: Pick<TempSweepOptions, "roots" | "scan" | "now"> = {}): Promise<TempSweepReport | null> {
  const maxAgeMs = tempSweepMaxAgeMs(env);
  if (maxAgeMs === null) return null;
  let checkouts: Awaited<ReturnType<typeof cleanupWorktrees>>;
  try {
    checkouts = await cleanupWorktrees();
  } catch (error) {
    /* Without the worktree list nothing can be proven safe to remove. */
    console.error("[temp sweep] skipped: the pipeline worktrees could not be read", error instanceof Error ? error.message : String(error));
    return null;
  }
  const scratch = realDirectory(statePath("scratch"));
  const roots = ports.roots ?? sweepRoots(scanProcesses(), writableRoots([...ownTempRoots(env), ...(scratch ? [scratch] : [])]));
  // Root discovery is one snapshot; deletion gets its own fresh process scan.
  const report = await sweepStaleTempDirs({ maxAgeMs, ...ports, roots, ...checkouts });
  recordTempSweep(report);
  const { young, inUse, worktree, deferred } = report.kept;
  console.log(
    `[temp sweep] removed ${report.removed.length} stale director${report.removed.length === 1 ? "y" : "ies"} (${megabytes(report.removedBytes)});`
    + ` kept ${young} young, ${inUse} in use, ${worktree} worktree, ${deferred} deferred; ${report.errors.length} error(s)`,
  );
  return report;
}

const sweepHost = globalThis as typeof globalThis & {
  __llvTempSweepTimer?: ReturnType<typeof setTimeout>;
};

/** Starts the hourly sweep once per process, from the release that owns
    traffic. Each sweep is scheduled when the previous one has finished, so two
    never overlap. */
export function startTempSweep(ports: {
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  sweep?: () => Promise<unknown>;
  firstDelayMs?: number;
  intervalMs?: number;
} = {}): void {
  if (sweepHost.__llvTempSweepTimer) return;
  if (tempSweepMaxAgeMs() === null) return;
  const schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const sweep = ports.sweep ?? (() => runTempSweep());
  const arm = (delayMs: number) => {
    const timer = schedule(() => {
      void sweep()
        .catch((error) => console.error("[temp sweep] failed", error instanceof Error ? error.message : String(error)))
        .finally(() => {
          if (sweepHost.__llvTempSweepTimer === timer) arm(ports.intervalMs ?? TEMP_SWEEP_INTERVAL_MS);
        });
    }, delayMs);
    timer.unref?.();
    sweepHost.__llvTempSweepTimer = timer;
  };
  arm(ports.firstDelayMs ?? FIRST_SWEEP_DELAY_MS);
}

/** Test seam: the timer is process-global. */
export function stopTempSweep(): void {
  if (sweepHost.__llvTempSweepTimer) clearTimeout(sweepHost.__llvTempSweepTimer);
  sweepHost.__llvTempSweepTimer = undefined;
}
