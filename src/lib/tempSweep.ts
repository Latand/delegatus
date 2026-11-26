import { registerDiskPressureSweep } from "@/lib/state/diskPressureSweeps";
import { isPreservedMedia } from "@/lib/artifact/evidenceFormats";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import { removeTreeWithinAttemptBudget } from "./runtime/attemptTempRemoval";
import { createHash, randomUUID } from "node:crypto";
import { openHostTempRoots } from "@/lib/state/hostTempViews";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { STRUCTURED_HOST_STAMP_ENV } from "@/lib/scanner/process";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { OWNED_TEMP_PREFIX } from "@/lib/tempDirs";
import { attemptTempFailureDetail } from "@/lib/runtime/attemptTempDiagnostics";
import type { ContainerMount } from "@/lib/runtime/attemptTempFilesystem";
import { GATE_ALLOCATION_FILE, gateSandboxOwnerEnded, LOCAL_GATE_SANDBOX_NAME } from "@/lib/gateSandboxProof";
import { identitiesInUse, mappedFileIdentity, treeHoldsIdentity } from "@/lib/processFileIdentity";

/**
 * The bounded sweeper for temp directories Delegatus left behind (#1957).
 *
 * The creators clean up after themselves now: a test run removes its one root
 * (`test-preload.ts`), a pipeline stage's scratch directory retires at settlement
 * (`materializeStructuredHostAccess` now indexes pipeline attempt ownership).
 * What they cannot clean is a process
 * killed before it got there, and the residue that predates them. The sweeper
 * removes those, and nothing else:
 *
 * - **Only owned names.** `llv-*`, three legacy test prefixes, and private
 *   agent or local gate directories with recorded owner evidence.
 *   `llv-spawn-sandbox` (every agent's config root, kept
 *   on purpose so a resumed agent finds its own), `llv-tmux-cwd` and the
 *   `llv-gate` admission slots are never
 *   candidates. A name Delegatus did not choose is never touched under these
 *   rules, however old.
 * - **Strays, on proof.** Agents' own tools name their `/tmp` and `/var/tmp`
 *   trees themselves (a reviewer's `mktemp -d`), so a separate class covers a
 *   direct child of those two roots of any name: owned by this service's uid,
 *   private mode, every write in its tree older than 12 h
 *   (`LLV_TEMP_STRAY_MAX_AGE_HOURS`), no reference from any process in any
 *   mount namespace, including through a bind mount, no running container that
 *   mounts it, no process of this user
 *   that refuses inspection outside {@link UNINSPECTABLE_DAEMONS} or that
 *   names a path under either root, no socket inside, and not on the
 *   keep-list of system, session and harness entries
 *   (`isStrayTempName`). A tree a Delegatus agent was seen using is recorded by
 *   inode in `temp-provenance.json` and goes first. Removals use the same
 *   journaled trash, and each journal line carries its proof.
 * - **Only direct children of the temp roots it uses**: `/tmp`, `/var/tmp`,
 *   this process's temp dir and the Viewer's `scratch` directory. Never a root
 *   itself, never a symlink, never a directory another user owns.
 * - **Only when stale**: every descendant is inspected for modification time,
 *   and change time on directories and single-link files, with a 24 h floor.
 *   Unreadable, mounted, changing or over-budget trees stay.
 * - **Never in use**: no live process has it, or anything inside it, as its
 *   working directory, an open file, or its `HOME`/`TMPDIR`/`LLV_STATE_DIR`/
 *   `XDG_CONFIG_HOME`/`CLAUDE_CODE_TMPDIR`. A stage agent whose shell is idle
 *   still carries its scratch directory in `TMPDIR`, so it is kept. Roots
 *   claimed after startup keep an open directory descriptor in `tempDirs.ts`.
 *   Before quarantine and again at removal, the device and inode behind every
 *   process's cwd, root, descriptors, mappings and named paths are matched
 *   against the tree, which finds a holder in another mount namespace or
 *   behind a bind mount that spells the path differently. A process of this
 *   user that refuses inspection (non-dumpable) shows its command line alone:
 *   a tree it names there is held, and one it uses only as its working
 *   directory or through an open file cannot be seen. A container process of
 *   another user shows nothing at all, so a stray or detached agent or gate
 *   tree also stays while Docker reports a running container that mounts it
 *   (the attempt sweep's {@link containerMountHold} rule), and while that
 *   inventory cannot be read.
 * - **Never a pipeline worktree**, or a directory holding one, or holding any
 *   git checkout: registered linked merger, review and attribution checkouts
 *   are freed by the worktree sweep after its commit preservation proof,
 *   including validated host temp views in Docker. Independent
 *   repositories and unreadable trees stay for a decision: their preservation
 *   and ownership have not been proven. The report names these holds.
 *
 * In the Docker install the Viewer's `/tmp` is the container's own, while the
 * agents run on the host through the nsenter shims and fill the host's. The
 * host's temp roots are read through `/proc/<pid>/root` in a validated mount
 * namespace. Stamped agents provide views of the namespaces they use. In the
 * nsenter install, PID 1 also provides the host view while agents are idle;
 * when procfs denies access to its root, a borrowed reader runs there with our
 * restored credentials. It stays alive for the sweep and is released afterward.
 * The namespace is re-checked before every removal so a recycled pid can never
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
/** Maximum entries inspected before freshness is uncertain. */
export const TREE_INSPECTION_ENTRY_LIMIT = 200_000;
const JOURNAL_ROTATE_BYTES = 1_000_000;

/** Test prefixes from before the per-run test root; each is unique to this repository's suites. */
const LEGACY_OWNED_PREFIXES = ["pending-producer-", "inflight-producer-", "child-owner-"] as const;
/** Owned names that hold live, shared state and are never swept. */
const KEPT_OWNED_NAMES = new Set(["llv-spawn-sandbox", "llv-tmux-cwd", "llv-gate"]);
/** Environment variables whose directory a process is using even while it holds nothing open there. */
const IN_USE_ENV = ["HOME", "TMPDIR", "TMP", "TEMP", "LLV_STATE_DIR", "XDG_CONFIG_HOME", "CLAUDE_CODE_TMPDIR"] as const;
const AGENT_TEMP_NAME = /^(?:agyc|agent-scratch)-[A-Za-z0-9][A-Za-z0-9._-]*$/;

function detachedTempOwner(name: string): "agent" | "gate" | null {
  if (LOCAL_GATE_SANDBOX_NAME.test(name)) return "gate";
  return AGENT_TEMP_NAME.test(name) ? "agent" : null;
}

export function isOwnedTempName(name: string): boolean {
  if (KEPT_OWNED_NAMES.has(name)) return false;
  if (name.startsWith(OWNED_TEMP_PREFIX) && name.length > OWNED_TEMP_PREFIX.length) return true;
  return LEGACY_OWNED_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

/** Shared agent state consumes owned space while remaining protected from cleanup. */
export function isOwnedTempConsumerName(name: string): boolean {
  return KEPT_OWNED_NAMES.has(name) || isOwnedTempName(name);
}

/** Stray candidates: a direct child of `/tmp` or `/var/tmp` that no
 * Delegatus name claims. Agents' own tools (`mktemp -d` from a reviewer, a
 * verifier, a fixer) pick their own names, so ownership cannot come from the
 * name. A stray is removed on proof instead: this service's uid owns it, its
 * mode admits no other user, nothing in its tree was written for
 * {@link DEFAULT_STRAY_SWEEP_MAX_AGE_HOURS} hours, no process in any mount
 * namespace references it (cwd, open file, mapped file, argument, or a path
 * that reaches it through a bind mount), it holds no socket, no Git checkout
 * and no pin, and its name is not on the keep-list of system and harness
 * entries below. */
export const DEFAULT_STRAY_SWEEP_MAX_AGE_HOURS = 12;
/** Stray directories one sweep may remove; the rest wait for the next pass. */
export const MAX_STRAY_REMOVALS_PER_SWEEP = 200;
/** The temp roots every machine has: where strays are looked for. */
const SYSTEM_TEMP_ROOTS: readonly string[] = ["/tmp", "/var/tmp"];
/** Entries that are never strays, whatever their age: system and session
 * runtime directories, the Claude Code harness root, a local gate's record
 * directory (the proof that frees its sandbox), and every hidden entry (X
 * sockets, this sweep's own trash and journals). */
const STRAY_KEEP_PATTERNS: readonly RegExp[] = [
  /^systemd-private-/, /^\./, /^tmux-/, /^ssh-/, /^claude-\d+$/, /^snap-private-tmp$/, /^delegatus-gate-record-/,
];

export type StrayTempPolicy = { maxAgeMs: number; keep: readonly string[];
  /** Test seam: the roots treated as `/tmp` and `/var/tmp`. */
  roots?: readonly string[] };

/** The stray policy, or null when the operator turned it off with
 * `LLV_TEMP_STRAY_MAX_AGE_HOURS=0`. `LLV_TEMP_STRAY_KEEP` adds comma-separated
 * name prefixes to the keep-list. */
export function strayTempPolicy(env: Readonly<Record<string, string | undefined>> = process.env): StrayTempPolicy | null {
  const raw = env.LLV_TEMP_STRAY_MAX_AGE_HOURS;
  let hours = DEFAULT_STRAY_SWEEP_MAX_AGE_HOURS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) console.warn(`[temp sweep] LLV_TEMP_STRAY_MAX_AGE_HOURS is not a duration; using ${DEFAULT_STRAY_SWEEP_MAX_AGE_HOURS}h`);
    else if (parsed === 0) return null;
    else {
      if (parsed < 1) console.warn("[temp sweep] minimum stray age is 1h; using 1h");
      hours = Math.max(1, parsed);
    }
  }
  const keep = (env.LLV_TEMP_STRAY_KEEP ?? "").split(",").map(prefix => prefix.trim()).filter(Boolean);
  return { maxAgeMs: hours * HOUR_MS, keep };
}

/** Whether a direct child of a stray root may be considered at all. Owned
 * names keep their own rules and their own 24 h floor. */
export function isStrayTempName(name: string, keep: readonly string[] = []): boolean {
  if (!name || isOwnedTempConsumerName(name) || detachedTempOwner(name)) return false;
  if (STRAY_KEEP_PATTERNS.some(pattern => pattern.test(name))) return false;
  return !keep.some(prefix => name.startsWith(prefix));
}

/** `/tmp` and `/var/tmp` as the namespace that owns them names them. Tests
    name their own isolated roots instead; production passes none. */
function isStrayRoot(root: TempSweepRoot, strayRoots?: readonly string[]): boolean {
  if (strayRoots) return strayRoots.includes(root.path);
  if (SYSTEM_TEMP_ROOTS.includes(root.path)) return true;
  return !root.via && SYSTEM_TEMP_ROOTS.map(realDirectory).includes(root.path);
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
  if (hours > 0 && hours < 24) console.warn("[temp sweep] minimum age is 24h; using 24h");
  return hours === 0 ? null : Math.max(24, hours) * HOUR_MS;
}

/** One live process, as far as the sweep needs it. */
export type ScannedProcess = {
  pid: number;
  /** The mount namespace link (`mnt:[4026531841]`), or null off Linux. */
  namespace: string | null;
  /** Carries the structured-host stamp: an agent Delegatus started. */
  stamped: boolean;
  cwd?: string;
  /** Paths it is using: cwd, open files, and the directories named by {@link IN_USE_ENV}. */
  paths: string[];
  references?: string[];
  /** Its `/proc` entry, where the files it uses can be identified. Absent off Linux. */
  procDirectory?: string;
  /** Identities of the files it has mapped. */
  mapped?: string[];
  /** Set for a process of this user whose `/proc` links refuse inspection, to
   * the kernel's name for it. Only its command line is known: `paths` and
   * `references` come from that alone, it has no `cwd` (so `paths[0]` is no
   * working directory), and what it works in or holds open cannot be seen. */
  uninspectable?: string;
};

export type ProcessScan = { ownNamespace: string | null; processes: ScannedProcess[]; unverified?: boolean };

/** Programs, by the kernel's process name, that run as the login user, refuse
 * inspection as part of how they work and never work inside a temp tree of
 * ours: the user service manager and its PAM helper, the key agents and the
 * smart card daemon, an input daemon and a login session's SSH server. One of
 * them leaves the stray pass its proof while its command line names nothing
 * under a stray root. Any other uninspectable process of this user may be
 * standing in a stray, so no stray is removed while it runs. */
export const UNINSPECTABLE_DAEMONS: ReadonlySet<string> = new Set([
  "systemd", "(sd-pam)", "ssh-agent", "gpg-agent", "scdaemon", "gnome-keyring-d", "xinput", "sshd", "sshd-session",
]);

/** The record of a refused process, or null when it holds nothing of ours: it
 * exited, it is a zombie, or another user owns it (and so cannot work inside a
 * private tree of this user). */
function uninspectableProcess(base: string, pid: number): ScannedProcess | null {
  const read = (file: string) => { try { return fs.readFileSync(path.join(base, file), "utf8"); } catch { return ""; } };
  try { if (fs.statSync(base).uid !== process.getuid?.()) return null; }
  catch { return null; }
  // The state letter follows the parenthesised name, which may itself hold parentheses.
  const stat = read("stat");
  if (/^[ZXx]/.test(stat.slice(stat.lastIndexOf(")") + 1).trimStart())) return null;
  const references = read("cmdline").split("\0").filter(Boolean);
  return { pid, namespace: null, stamped: false, uninspectable: read("comm").trim(),
    paths: references.filter(token => token.startsWith("/") && processPathWithinLimits(token)), references };
}

export function processPathWithinLimits(file: string): boolean {
  return Buffer.byteLength(file) < 4096 && file.split(path.sep).every(name => Buffer.byteLength(name) <= 255);
}

function readLink(file: string): string | null {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
}

/** Every process this user can inspect, in one pass over `/proc`. A process of
    another user answers nothing and cannot be using a 0700 directory of ours.
    A process of this user whose links are refused (the kernel's non-dumpable
    flag: key agents, or any program that sets it) is kept with the paths of its
    world-readable command line. Its working directory, open files, mappings and
    environment stay unseen, so this scan alone never proves it uses nothing. */
export function scanProcesses(procRoot = "/proc", extraRoots: readonly string[] = []): ProcessScan {
  return performanceSpans.sync("proc.scan", () => {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    const fallback = portableScan(extraRoots);
    if (process.platform === "linux") fallback.unverified = true;
    return fallback;
  }
  const processes: ScannedProcess[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const base = path.join(procRoot, name);
    let namespace: string;
    try { namespace = fs.readlinkSync(path.join(base, "ns", "mnt")); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const refused = code === "EACCES" || code === "EPERM" ? uninspectableProcess(base, Number(name)) : null;
      if (refused) processes.push(refused);
      continue;
    }
    const paths = new Set<string>();
    const cwd = readLink(path.join(base, "cwd"));
    if (cwd) paths.add(cwd);
    try {
      for (const fd of fs.readdirSync(path.join(base, "fd"))) {
        const target = readLink(path.join(base, "fd", fd));
        if (target?.startsWith("/")) paths.add(target);
      }
    } catch {
      /* Exited mid-scan, or not ours. */
    }
    for (const link of ["exe", "root"]) {
      const target = readLink(path.join(base, link));
      if (target?.startsWith("/") && target !== "/") paths.add(target);
    }
    const references: string[] = [];
    const mapped = new Set<string>();
    try {
      for (const token of fs.readFileSync(path.join(base, "cmdline"), "utf8").split("\0")) {
        references.push(token);
        // A process can rewrite argv as one command line. Keep it as text
        // for argument matching when it cannot be a filesystem path.
        if (token.startsWith("/") && processPathWithinLimits(token)) paths.add(token);
      }
      for (const line of fs.readFileSync(path.join(base, "maps"), "utf8").split("\n")) {
        const target = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];
        if (!target) continue;
        paths.add(target.replace(/ \(deleted\)$/, ""));
        const identity = mappedFileIdentity(line);
        if (identity) mapped.add(identity);
      }
    } catch { /* A process can exit during inspection. */ }
    let stamped = false;
    try {
      for (const pair of fs.readFileSync(path.join(base, "environ"), "utf8").split("\0")) {
        const equals = pair.indexOf("=");
        if (equals <= 0) continue;
        references.push(pair.slice(equals + 1));
        const key = pair.slice(0, equals);
        if (key === STRUCTURED_HOST_STAMP_ENV) stamped = true;
        else if ((IN_USE_ENV as readonly string[]).includes(key) && pair.length > equals + 1) paths.add(pair.slice(equals + 1));
      }
    } catch {
      /* Exited mid-scan, or not ours. */
    }
    processes.push({ pid: Number(name), namespace, stamped, ...(cwd ? { cwd } : {}), paths: [...paths], references, procDirectory: base, mapped: [...mapped] });
  }
  return { ownNamespace: readLink(path.join(procRoot, "self", "ns", "mnt")), processes };
  });
}

/** Without `/proc`: working directories and open files through the platform backend, one namespace. */
function portableScan(extraRoots: readonly string[] = []): ProcessScan {
  const byPid = new Map<number, ScannedProcess>();
  for (const { pid, cwd, argv } of procBackend.listProcesses()) {
    byPid.set(pid, { pid, namespace: null, stamped: false, ...(cwd ? { cwd } : {}), paths: cwd ? [cwd] : [], references: argv });
  }
  for (const root of new Set([...ownTempRoots(), ...extraRoots])) {
    procBackend.scanFdTargetsUnder(root, (target, pid) => {
      const entry = byPid.get(pid) ?? { pid, namespace: null, stamped: false, paths: [] };
      entry.paths.push(target);
      byPid.set(pid, entry);
    });
  }
  return {
    ownNamespace: null,
    processes: [...byPid.values()],
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
export function sweepRoots(scan: { ownNamespace: string | null; processes: Iterable<Pick<ScannedProcess, "pid" | "namespace" | "stamped">> }, ownRoots: string[], procRoot = "/proc"): TempSweepRoot[] {
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

/** Discover mount anchors without enumerating open files or memory maps.
 * The separate reference scan at retirement still inspects every process. */
export function discoverSweepRoots(ownRoots: string[], procRoot = "/proc"): TempSweepRoot[] {
  const ownNamespace = readLink(path.join(procRoot, "self", "ns", "mnt"));
  function* mounts() {
    let entries: string[];
    try { entries = fs.readdirSync(procRoot); }
    catch { return; } // Without proc there are no foreign namespace anchors.
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const base = path.join(procRoot, name);
      const namespace = readLink(path.join(base, "ns", "mnt"));
      if (!namespace || namespace === ownNamespace) continue;
      try {
        const env = fs.readFileSync(path.join(base, "environ"), "utf8");
        if (env.split("\0").some(field => field.startsWith(STRUCTURED_HOST_STAMP_ENV + "="))) {
          yield { pid: Number(name), namespace, stamped: true };
        }
      } catch { /* The process exited or its environment is inaccessible. */ }
    }
  }
  return sweepRoots({ ownNamespace, processes: mounts() }, ownRoots, procRoot);
}

function inside(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(directory + path.sep);
}

type OwnerHold = "agent-owner-unverified" | "gate-owner-unverified" | "conversation_reference";
type ReferenceHold = OwnerHold | "process_reference" | "process-scan-unverified" | "container_reference"
  | "container_inventory_unknown";

/** The absolute pieces of a ':'-joined value: a search path (`PATH`,
 * `PYTHONPATH`) or a volume argument (`/host:/inside`). */
function* joinedPaths(text: string): Generator<string> {
  if (!text.includes(":")) return;
  for (const piece of text.split(":")) if (path.isAbsolute(piece) && processPathWithinLimits(piece)) yield piece;
}

/** The paths a process names: those the scan collected, then flag values and
 * path arguments inside its command line and environment. A value that holds
 * ':' is read both whole, as a file may be named that way, and piece by piece. */
function* namedPaths(proc: ScannedProcess): Generator<string> {
  yield* proc.paths;
  const absolute = (argument: string) => {
    const file = path.isAbsolute(argument) ? argument : proc.cwd && path.join(proc.cwd, argument);
    return file && processPathWithinLimits(file) ? file : null;
  };
  for (const value of proc.references ?? []) {
    const argument = /^--?[^=\s]+=([\s\S]*)$/.exec(value)?.[1] ?? value;
    const whole = argument && !argument.startsWith("-") ? absolute(argument) : null;
    if (whole) yield whole;
    // Split before the embedded matches: a piece may hold spaces they stop at.
    yield* joinedPaths(argument);
    for (const match of value.matchAll(/["']((?:\/|\.\.?\/)[^"']+)["']|(?:\/|\.\.?\/)[^\s\x00'"\x60=;|&<>]+/g)) {
      const text = match[1] ?? match[0];
      const embedded = absolute(text);
      if (embedded) yield embedded;
      yield* joinedPaths(text);
    }
  }
}

function processUsesTemp(proc: ScannedProcess, holds: (file: string) => boolean): boolean {
  for (const file of namedPaths(proc)) if (holds(file)) return true;
  return false;
}

type MountRow = { device: string; root: string; point: string };

function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function readMountRows(file: string, read: (file: string) => string): MountRow[] | null {
  let text: string;
  try { text = read(file); } catch { return null; }
  return text.split("\n").flatMap(line => {
    const fields = line.split(" ");
    return fields.length > 4 ? [{ device: fields[2]!, root: unescapeMountField(fields[3]!), point: unescapeMountField(fields[4]!) }] : [];
  });
}

/** The places a directory is visible in each mount namespace a scanned
 * process lives in, and whether such a process references one of them.
 *
 * A container that bind-mounts `/tmp/x` (or a subdirectory of it) at `/work`
 * reaches the tree through a path that names nothing under `/tmp`, so a
 * string comparison with the process's cwd, open files and arguments misses
 * it. Mountinfo names each mount's device and the path of its root inside that
 * filesystem, which turns the candidate into one filesystem-relative path:
 *
 * - a mount whose root lies inside the candidate exposes part of it at the
 *   mount point, so a reference under that point holds the candidate;
 * - a mount whose root encloses the candidate (a container that mounts all of
 *   `$HOME` or `/tmp`) exposes it at the translated path, and only a reference
 *   under that translated path holds it. The ancestor mount alone holds
 *   nothing, or every root under a mounted home would stay forever.
 *
 * A namespace whose mountinfo cannot be read adds nothing beyond the direct
 * path checks every caller already runs. Shared by owned, detached-agent and
 * stray candidates, at inspection and again on the quarantined tree. */
export function aliasedReferenceHold(candidate: string, via: string, scan: ProcessScan, procRoot = "/proc",
  read: (file: string) => string = file => fs.readFileSync(file, "utf8")): boolean {
  const own = readMountRows(via ? path.join(via, "..", "mountinfo") : path.join(procRoot, "self", "mountinfo"), read);
  if (!own) return false;
  // `inside` cannot see that every absolute path lies under "/".
  const under = (candidate: string, directory: string) => directory === "/" ? candidate.startsWith("/") : inside(candidate, directory);
  let mount: MountRow | undefined;
  for (const row of own) if (under(candidate, row.point) && (!mount || row.point.length >= mount.point.length)) mount = row;
  if (!mount) return false;
  const physical = path.join(mount.root, path.relative(mount.point, candidate));
  const byNamespace = new Map<string, ScannedProcess[]>();
  for (const proc of scan.processes) {
    if (!proc.paths.length && !proc.references?.length) continue;
    // A process whose namespace link is refused answers by its own mount table.
    const key = proc.namespace ?? `pid:${proc.pid}`;
    const list = byNamespace.get(key) ?? [];
    list.push(proc);
    byNamespace.set(key, list);
  }
  for (const processes of byNamespace.values()) {
    let rows: MountRow[] | null = null;
    for (const proc of processes) if ((rows = readMountRows(path.join(procRoot, String(proc.pid), "mountinfo"), read))) break;
    if (!rows) continue;
    const destinations: string[] = [];
    for (const row of rows) {
      if (row.device !== mount.device) continue;
      if (under(row.root, physical)) destinations.push(row.point);
      else if (under(physical, row.root)) destinations.push(path.join(row.point, path.relative(row.root, physical)));
    }
    if (!destinations.length) continue;
    const reaches = (file: string) => {
      const resolved = path.resolve(file.replace(/ \(deleted\)$/, ""));
      return destinations.some(destination => under(resolved, destination));
    };
    if (processes.some(proc => processUsesTemp(proc, reaches))) return true;
  }
  return false;
}

/** A directory's identity for the provenance ledger. Inode numbers are reused
 * as soon as a tree is removed, so the birth time joins them where the
 * filesystem records one. */
export function provenanceIdentity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}${stat.birthtimeMs > 0 ? `:${Math.floor(stat.birthtimeMs * 1000)}` : ""}`;
}

/** One agent process seen using a stray candidate: the record that lets a
 * later pass name the tree an agent's, by identity, after the agent is gone. */
export type TempProvenanceRow = {
  root: string; namespace: string | null; name: string; identity: string;
  firstSeenAt: string; lastSeenAt: string; evidence: "cwd" | "reference";
};
const PROVENANCE_ROW_LIMIT = 4000;

/** Rows for the direct children of stray roots that stamped (Delegatus
 * launched) processes use right now. Pure apart from the `lstat` that pins
 * each row to the inode it saw. */
export function observeTempProvenance(scan: ProcessScan, roots: readonly TempSweepRoot[], at: string,
  options: { uid?: number | null; keep?: readonly string[]; strayRoots?: readonly string[] } = {}): TempProvenanceRow[] {
  const rows = new Map<string, TempProvenanceRow>();
  for (const root of roots) {
    if (!isStrayRoot(root, options.strayRoots)) continue;
    const namespace = root.anchor?.namespace ?? scan.ownNamespace;
    for (const proc of scan.processes) {
      if (!proc.stamped || (proc.namespace ?? null) !== (namespace ?? null)) continue;
      const names = new Map<string, TempProvenanceRow["evidence"]>();
      processUsesTemp(proc, file => {
        const resolved = path.resolve(file.replace(/ \(deleted\)$/, ""));
        if (!resolved.startsWith(root.path + path.sep)) return false;
        const name = resolved.slice(root.path.length + 1).split(path.sep)[0]!;
        if (isStrayTempName(name, options.keep)) {
          const evidence = proc.cwd && inside(path.resolve(proc.cwd), path.join(root.path, name)) ? "cwd" : "reference";
          if (names.get(name) !== "cwd") names.set(name, evidence);
        }
        return false;
      });
      for (const [name, evidence] of names) {
        let stat: fs.Stats;
        try { stat = fs.lstatSync(path.join(root.via + root.path, name)); } catch { continue; }
        if (!stat.isDirectory() || (options.uid != null && stat.uid !== options.uid)) continue;
        const identity = provenanceIdentity(stat);
        const key = `${namespace}|${root.path}|${name}|${identity}`;
        const prior = rows.get(key);
        rows.set(key, { root: root.path, namespace: namespace ?? null, name, identity, firstSeenAt: at, lastSeenAt: at,
          evidence: prior?.evidence === "cwd" ? "cwd" : evidence });
      }
    }
  }
  return [...rows.values()];
}

/** Merge observations into the durable ledger: newest last-seen first, bounded. */
export function mergeTempProvenance(prior: readonly TempProvenanceRow[], observed: readonly TempProvenanceRow[]): TempProvenanceRow[] {
  const key = (row: TempProvenanceRow) => `${row.namespace}|${row.root}|${row.name}|${row.identity}`;
  const merged = new Map(prior.map(row => [key(row), row]));
  for (const row of observed) {
    const existing = merged.get(key(row));
    merged.set(key(row), existing ? { ...existing, lastSeenAt: row.lastSeenAt, evidence: existing.evidence === "cwd" ? "cwd" : row.evidence } : row);
  }
  return [...merged.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, PROVENANCE_ROW_LIMIT);
}

export function readTempProvenance(file: string): TempProvenanceRow[] {
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows.filter((row): row is TempProvenanceRow => !!row && typeof row.root === "string"
      && typeof row.name === "string" && typeof row.identity === "string" && typeof row.lastSeenAt === "string"
      && typeof row.firstSeenAt === "string" && (row.evidence === "cwd" || row.evidence === "reference")) : [];
  } catch { return []; }
}

/** What made a removed directory removable, written with every removal. */
export type TempSweepProof = {
  newestWriteAt: string; entries: number; uid: number | null; mode: string; identity: string;
  processes: number; namespaces: number;
  /** Processes of this user that refused inspection, all of them known daemons. */
  uninspectable: number;
  ledger?: Pick<TempProvenanceRow, "firstSeenAt" | "lastSeenAt" | "evidence">;
};

export type TempSweepRemoval = { path: string; via: string; bytes: number;
  /** Null for a replayed removal, whose tree was dated by the pass that began it. */
  ageHours: number | null;
  /** An interrupted removal an earlier pass began, finished by this one. */
  replay?: true;
  /** Absent for owned names. */
  kind?: "stray";
  /** `agent-ledger` when a recorded agent process used this exact inode;
      otherwise the age, liveness, uid and keep-list proof stood alone. */
  provenance?: "agent-ledger" | "age-liveness";
  proof?: TempSweepProof };

export type TempSweepReport = {
  failed?: boolean;
  at: string;
  mode?: "on" | "dry-run";
  trashFinished?: number;
  maxAgeHours: number;
  roots: string[];
  removed: TempSweepRemoval[];
  removedBytes: number;
  /** `ledger` counts roots the attempt ledger owns and retires; this sweep
      skips them without a walk, so their bytes are the ledger's to report.
      Absent in reports written before it was separated from `inUse`. */
  kept: { young: number; inUse: number; worktree: number; deferred: number; ledger?: number };
  /** Allocations retained under each guard; absent in older report versions. */
  keptBytes?: TempSweepReport["kept"];
  /** The reason specific directories remain protected. */
  held?: { path: string; via: string; reason: TreeHold | ReferenceHold | "pinned" | "attempt-owner-unlisted" | "shared-access"; bytes: number }[];
  /** The prefix-independent pass over `/tmp` and `/var/tmp`; absent when it is off. */
  stray?: { maxAgeHours: number; removed: number; removedBytes: number; agentLedger: number; deferred: number };
  errors: string[];
};

export type TempSweepOptions = {
  maxAgeMs: number;
  mode?: "on" | "dry-run";
  inspect?: typeof inspectTree;
  mountPoints?: (directory: string, via: string) => string[];
  currentScan?: () => ProcessScan;
  /** The mounts of every running container; null when the inventory could not
   * be read whole. Production asks Docker ({@link readContainerMounts}). */
  containerMounts?: () => Promise<ContainerMount[] | null>;
  conversationCwds?: () => readonly string[];
  /** Current registry proof for detached agent temp trees. */
  conversationProtection?: () => { held: readonly string[]; ended: ReadonlyMap<string, number> };
  remove?: (directory: string, mutationStarted: () => void) => Promise<void>;
  now?: () => number;
  uid?: number | null;
  roots?: TempSweepRoot[];
  scratchRoot?: string | null;
  scan?: ProcessScan;
  /** Pipeline worktrees; never removed, nor any directory holding one. */
  worktrees?: string[];
  /** Refresh pipeline ownership after asynchronous measurements. */
  currentWorktrees?: () => readonly string[];
  /** Retained checkouts already attributed by the worktree sweep report. */
  accountedWorktrees?: string[];
  procRoot?: string;
  maxRemovals?: number;
  /** Exact roots registered by an attempt; never broadened to siblings. */
  onlyDirectories?: readonly string[];
  /** Re-read durable attempt authority after asynchronous measurements. */
  eligible?: (directory: string) => Promise<boolean>;
  /** Whether the attempt ledger lists this root. A root that carries the
   * ledger's owner marker without a ledger row is retired by nobody, so it is
   * reported as held. Without this port every marked root counts as listed. */
  attemptLedger?: (directory: string) => boolean;
  /** Synchronous authority and identity fence immediately before quarantine/removal. */
  dispatchGuard?: (directory: string) => boolean;
  /** Registered disposable roots have their own durable authority and streamed
   * preservation inspection. Legacy/unowned roots always require snapshots. */
  disposable?: boolean;
  /** Recovered roots keep their original journal until expired authority admits replay. */
  keepRefusedTrash?: boolean;
  measure?: (directory: string) => Promise<number>;
  /** Consider directories of any name in `/tmp` and `/var/tmp` on the stray
      proof. `provenance` is the durable agent ledger; a row whose inode
      matches orders that tree first and names it in the removal journal. */
  stray?: StrayTempPolicy & { maxRemovals?: number; provenance?: readonly TempProvenanceRow[] };
};

export type TreeHold = "git-checkout" | "unreadable-tree" | "entry-limit" | "mount-boundary" | "changed-during-inspection" | "evidence" | "socket";
export type TreeInspection = { newestMs: number; entries: number; hold: TreeHold | null };

/** Read mount boundaries in the namespace that owns the path. Failure holds the candidate. */
export function mountPointsUnder(directory: string, via = "", read = (file: string) => fs.readFileSync(file, "utf8")): string[] {
  if (process.platform !== "linux") return [];
  const procView = /^\/proc\/(\d+)\/root(\/.*)$/.exec(directory);
  if (!via && procView) { via = `/proc/${procView[1]}/root`; directory = procView[2]!; }
  const file = via ? path.join(via, "..", "mountinfo") : "/proc/self/mountinfo";
  return read(file).split("\n").flatMap(line => {
    const field = line.split(" ")[4];
    if (!field) return [];
    const point = field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    return inside(point, directory) ? [point] : [];
  });
}

/** One bounded, symlink-safe freshness and preservation walk. */
export function inspectTree(directory: string, options: {
  limit?: number; threshold?: number; git?: boolean | "linked"; mounts?: readonly string[];
  preserveEvidence?: boolean;
  preserveKeep?: boolean;
  /** The caller proved this root's own Git registration. Nested Git still holds. */
  registeredWorktree?: boolean;
  /** A quarantine rename may refresh only this directory's ctime. */
  ignoreRootCtime?: boolean;
  /** Hold a tree holding a Unix socket: a listener keeps its socket open as a
      descriptor that names no path, and its file's times never move. */
  sockets?: boolean;
  stat?: (file: string) => fs.Stats;
} = {}): TreeInspection {
  const result: TreeInspection = { newestMs: 0, entries: 0, hold: null };
  const stat = options.stat ?? (file => fs.lstatSync(file));
  try {
    const root = stat(directory);
    if (!root.isDirectory() || root.dev !== stat(path.dirname(directory)).dev
      || options.mounts?.length) return { ...result, hold: "mount-boundary" };
    const pending = [directory];
    while (pending.length) {
      const current = pending.pop()!;
      const own = stat(current);
      if (++result.entries > (options.limit ?? TREE_INSPECTION_ENTRY_LIMIT)) return { ...result, hold: "entry-limit" };
      if (own.dev !== root.dev) return { ...result, hold: "mount-boundary" };
      if (options.sockets && own.isSocket()) return { ...result, hold: "socket" };
      result.newestMs = Math.max(result.newestMs, own.mtimeMs,
        !(options.ignoreRootCtime && current === directory) && (own.isDirectory() || own.isFile() && own.nlink === 1) ? own.ctimeMs : 0);
      if (result.newestMs > (options.threshold ?? Infinity)) return result;
      if (!own.isDirectory()) continue;
      const names = fs.readdirSync(current);
      if (options.preserveKeep && names.includes(".delegatus-keep")) return { ...result, hold: "evidence" };
      if (options.preserveEvidence && names.some(name => name === ".artifacts" || isPreservedMedia(name)))
        return { ...result, hold: "evidence" };
      if (options.git !== false) {
        if (options.git === "linked" && names.includes("worktrees") && (path.basename(current) === ".git" || names.includes("objects")))
          return { ...result, hold: "git-checkout" };
        if (names.includes(".git") && !(options.registeredWorktree && current === directory)
          && (options.git !== "linked" || !stat(path.join(current, ".git")).isDirectory())
          && gitCheckoutMarker(path.join(current, ".git"), stat(path.join(current, ".git")).isDirectory()))
          return { ...result, hold: "git-checkout" };
        if (options.git !== "linked" && names.includes("objects") && ["HEAD", "config", "refs"].some(name => names.includes(name)))
          return { ...result, hold: "git-checkout" };
      }
      for (const name of names) pending.push(path.join(current, name));
    }
  } catch (error) {
    result.hold = (error as NodeJS.ErrnoException).code === "ENOENT" ? "changed-during-inspection" : "unreadable-tree";
  }
  return result;
}

export function tempSweepMode(env: NodeJS.ProcessEnv = process.env): "on" | "dry-run" | null {
  const value = env.LLV_TEMP_SWEEP?.trim().toLowerCase();
  if (["0", "off", "false"].includes(value ?? "")) return null;
  if (!value || ["1", "on", "true"].includes(value)) return "on";
  return "dry-run";
}

/** Durable intent precedes the rename; only recorded trash is recoverable. */
export async function removeTreeViaTrash(directory: string, options: {
  journal: string; held: (trash: string) => boolean | Promise<boolean>; remove?: (trash: string, mutationStarted: () => void) => Promise<void>;
  context?: { sha: string };
  validate?: (trash: string) => boolean;
  dispatch?: (trash: string) => boolean;
  disposable?: boolean;
  /** Marks the intent as a stray's, so an interrupted removal is replayed
      under the stray proof rather than refused for its unowned name. */
  stray?: boolean;
  cleaner?: import("@/lib/cleaner/diskJournal").CleanerAuditBinding;
}): Promise<boolean> {
  const trash = path.join(path.dirname(directory), `.delegatus-trash-${path.basename(directory)}-${randomUUID()}`);
  const original = fs.lstatSync(directory);
  if (!original.isDirectory() || original.isSymbolicLink()) return false;
  if (options.validate && !options.validate(directory)) return false;
  const uid = original.uid;
  const identity = `${original.dev}:${original.ino}`;
  const snapshot = options.disposable ? null : snapshotTree(directory);
  writeJsonDurably(options.journal, { directory, trash, uid, identity, snapshot, ...(options.disposable ? { disposable: true } : {}),
    ...(options.stray ? { stray: true } : {}), ...(options.context ? { context: options.context } : {}), ...(options.cleaner ? { cleaner: options.cleaner } : {}) });
  fs.renameSync(directory, trash);
  const moved = fs.lstatSync(trash);
  let holdError: unknown;
  let held = true;
  try {
    const observation = options.held(trash);
    held = typeof observation === "boolean" ? observation : await observation;
    // A throwing final fence refuses this quarantine just like a hold.
    // Restore before propagating its named reason; removal has not started.
    held = `${moved.dev}:${moved.ino}` !== identity || held || !!(options.validate && !options.validate(trash))
      || !!(snapshot && !matchesSnapshot(trash, snapshot)) || mountPointsUnder(trash).length > 0;
  } catch (error) { holdError = error; held = true; }
  const final = fs.lstatSync(trash);
  // Asynchronous guards can race a replaced quarantine name. Preserve both
  // identities and the intent; never restore or delete the replacement.
  if (!final.isDirectory() || final.isSymbolicLink() || `${final.dev}:${final.ino}` !== identity || final.uid !== uid) return false;
  if (!held && options.dispatch) {
    try { held = !options.dispatch(trash); }
    catch (error) { holdError = error; held = true; }
  }
  if (held) {
    try { fs.lstatSync(directory); throw new Error("original path was acquired while trash is held; preserved both paths"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fs.renameSync(trash, directory);
    if (!options.cleaner) fs.unlinkSync(options.journal);
    if (holdError) throw holdError;
    return false;
  }
  let mutationStarted = false;
  const markMutationStarted = () => { mutationStarted = true; };
  try {
    await (options.remove ?? removeTreeWithinAttemptBudget)(trash, markMutationStarted);
  } catch (error) {
    // A final removal fence can refuse before touching the quarantined tree.
    // Return its original inode to its owner and discard the now-completed
    // intent; once native removal began, keep recovery custody.
    if (!mutationStarted) {
      const current = fs.lstatSync(trash);
      if (current.isDirectory() && !current.isSymbolicLink() && `${current.dev}:${current.ino}` === identity && current.uid === uid) {
        try { fs.lstatSync(directory); throw new Error(`original path was acquired while removal was refused (${attemptTempFailureDetail(error)}); preserved both paths`, { cause: error }); }
        catch (restoreError) { if ((restoreError as NodeJS.ErrnoException).code !== "ENOENT") throw restoreError; }
        fs.renameSync(trash, directory);
        if (!options.cleaner) fs.unlinkSync(options.journal);
      }
    }
    throw error;
  }
  if (!options.cleaner) fs.unlinkSync(options.journal);
  return true;
}

/** Replay only a same-parent, same-owner trash path from our durable intent. */
export async function finishTreeTrash(journal: string, held: (trash: string) => boolean | Promise<boolean>,
  remove?: (trash: string, mutationStarted: () => void) => Promise<void>, validate?: (trash: string) => boolean, allowDisposable = false, dispatch?: (trash: string) => boolean, keepRefusedTrash = false): Promise<boolean> {
  const row = JSON.parse(fs.readFileSync(journal, "utf8")) as { directory: string; trash: string; uid: number; identity: string; snapshot?: TreeSnapshot; disposable?: boolean; cleaner?: unknown };
  const trashPath = journaledTrash(journal, row);
  const matches = () => row.snapshot ? matchesSnapshot(trashPath, row.snapshot) : allowDisposable && row.disposable === true;
  if (path.dirname(row.directory) !== path.dirname(row.trash)
    || !path.basename(row.trash).startsWith(`.delegatus-trash-${path.basename(row.directory)}-`)) return false;
  if (!fs.existsSync(trashPath)) { if (!row.cleaner) fs.unlinkSync(journal); return false; }
  const stat = fs.lstatSync(trashPath);
  if (!stat.isDirectory() || stat.dev !== fs.statSync(path.dirname(trashPath)).dev || `${stat.dev}:${stat.ino}` !== row.identity || stat.uid !== row.uid || (process.getuid && stat.uid !== process.getuid())
    || !matches() || mountPointsUnder(trashPath).length) return false;
  // held/validate are caller supplied and may scan or mutate the tree. Run
  // them first, then prove the exact journaled tree again at the delete edge.
  const observation = held(trashPath);
  if ((typeof observation === "boolean" ? observation : await observation) || validate && !validate(trashPath)) return false;
  const final = fs.lstatSync(trashPath);
  if (!final.isDirectory() || final.dev !== fs.statSync(path.dirname(trashPath)).dev
    || `${final.dev}:${final.ino}` !== row.identity || final.uid !== row.uid
    || (process.getuid && final.uid !== process.getuid()) || !matches()
    || mountPointsUnder(trashPath).length || dispatch && !dispatch(trashPath)) return false;
  let mutationStarted = false;
  try {
    await (remove ?? removeTreeWithinAttemptBudget)(
      trashPath, () => { mutationStarted = true; }, undefined, row.identity);
  } catch (error) {
    // Permission repair is reversible. Its final fence may refuse after the
    // modes have rolled back but before native removal acquires custody.
    if (!mutationStarted && !keepRefusedTrash) {
      const current = fs.lstatSync(trashPath);
      if (current.isDirectory() && !current.isSymbolicLink() && `${current.dev}:${current.ino}` === row.identity && current.uid === row.uid) {
        try { fs.lstatSync(row.directory); throw new Error(`original path was acquired while removal was refused (${attemptTempFailureDetail(error)}); preserved both paths`, { cause: error }); }
        catch (restoreError) { if ((restoreError as NodeJS.ErrnoException).code !== "ENOENT") throw restoreError; }
        fs.renameSync(trashPath, row.directory);
        if (!row.cleaner) fs.unlinkSync(journal);
      }
    }
    throw error;
  }
  if (!row.cleaner) fs.unlinkSync(journal);
  return true;
}

/** Where a journaled quarantine is now: an interrupted native removal leaves
 * it under the claim name it renamed it to. */
function journaledTrash(journal: string, row: { directory: string; trash: string; identity: string }): string {
  return readAttemptTempTrash(journal, path.dirname(row.directory))?.trash ?? claimedTrashForJournal(row) ?? row.trash;
}

/** Resolve a claim made after the journal was written. The journal's owner,
 * identity and same-parent relationship prove which one interrupted native
 * removal may resume; this works for worktree and evidence journals too. */
function claimedTrashForJournal(row: { directory: string; trash: string; identity: string }) {
  if (typeof row.directory !== "string" || typeof row.trash !== "string" || typeof row.identity !== "string"
    || !/^\d+:\d+$/.test(row.identity) || path.dirname(row.directory) !== path.dirname(row.trash)
    || !path.basename(row.trash).startsWith(`.delegatus-trash-${path.basename(row.directory)}-`)) return null;
  const parent = path.dirname(row.directory), prefix = `.delegatus-trash-claim-${row.identity.replace(":", "-")}-`;
  try {
    const claims = fs.readdirSync(parent).filter(name => name.startsWith(prefix)).filter(name => {
      const stat = fs.lstatSync(path.join(parent, name), { throwIfNoEntry: false });
      return stat?.isDirectory() && !stat.isSymbolicLink() && `${stat.dev}:${stat.ino}` === row.identity;
    });
    return claims.length === 1 && !fs.lstatSync(row.directory, { throwIfNoEntry: false }) ? path.join(parent, claims[0]!) : null;
  } catch { return null; }
}

type TreeSnapshot = { entries: Record<string, { kind: "directory" | "file" | "symlink" | "other"; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number }>; count: number };
function snapshotTree(directory: string): TreeSnapshot {
  const root = fs.lstatSync(directory); const entries: TreeSnapshot["entries"] = {}; const pending = [directory]; let count = 0;
  while (pending.length) {
    const current = pending.pop()!; const stat = fs.lstatSync(current); const relative = path.relative(directory, current);
    if (++count > TREE_INSPECTION_ENTRY_LIMIT || stat.dev !== root.dev) throw new Error("tree snapshot is uncertain or over the inspection limit");
    entries[relative] = { kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
      dev: stat.dev, ino: stat.ino, size: stat.isDirectory() ? 0 : stat.size, mtimeMs: stat.isDirectory() ? 0 : stat.mtimeMs,
      ctimeMs: stat.isDirectory() ? 0 : stat.ctimeMs, mode: stat.mode };
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
  }
  return { entries, count };
}

/** Missing paths are allowed after an interrupted recursive remove; additions and changed extant files are held. */
export function matchesSnapshot(directory: string, snapshot: TreeSnapshot): boolean {
  try {
    const current = snapshotTree(directory);
    for (const [relative, entry] of Object.entries(current.entries)) {
      const before = snapshot.entries[relative];
      if (!before || before.kind !== entry.kind || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size
        || before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs || before.mode !== entry.mode) return false;
    }
    return true;
  } catch { return false; }
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
    let entries: fs.Dir;
    try {
      entries = await fs.promises.opendir(current);
    } catch {
      continue;
    }
    try {
      for await (const entry of entries) {
        if (visited >= MEASURE_ENTRY_LIMIT) break;
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
    } catch { /* Iteration can fail after opendir succeeds (Bun EACCES). Keep the measured lower bound. */ }
  }
  return bytes;
}

/** Bounded allocation observation for the attempt ledger. */
export async function measureTempBytes(directory: string): Promise<number> {
  return measureBytes(directory, new Set(), true);
}

/** One deterministic recovery intent per registered root permits point reads. */
export function attemptTempJournalPath(directory: string): string {
  return path.join(path.dirname(directory), `.delegatus-sweep-${createHash("sha256").update(directory).digest("hex")}.json`);
}

/** Recovery accepts only a direct, private scratch journal and its original
 * directory identity. Names and owner markers alone never grant authority. */
export function readAttemptTempTrash(journal: string, scratch: string): { directory: string; trash: string; identity: string; uid: number } | null {
  try {
    if (path.dirname(journal) !== scratch || fs.realpathSync(scratch) !== scratch) return null;
    const parent = fs.lstatSync(scratch), file = fs.lstatSync(journal);
    if (!parent.isDirectory() || parent.isSymbolicLink() || process.getuid && parent.uid !== process.getuid()
      || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 16384
      || file.uid !== parent.uid) return null;
    const fd = fs.openSync(journal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let row;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== file.dev || opened.ino !== file.ino || opened.size > 16384) return null;
      const buffer = Buffer.alloc(16385), used = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const after = fs.fstatSync(fd), current = fs.lstatSync(journal);
      if (used > 16384 || used !== opened.size || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) return null;
      row = JSON.parse(buffer.subarray(0, used).toString("utf8"));
    } finally { fs.closeSync(fd); }
    if (typeof row.directory !== "string" || path.dirname(row.directory) !== scratch
      || !/^llv-(?:read-only-stage|stage|stage-config)-[A-Za-z0-9._-]+$/.test(path.basename(row.directory))
      || journal !== attemptTempJournalPath(row.directory) || row.disposable !== true
      || typeof row.trash !== "string" || path.dirname(row.trash) !== scratch
      || !path.basename(row.trash).startsWith(`.delegatus-trash-${path.basename(row.directory)}-`)
      || typeof row.identity !== "string" || !/^\d+:\d+$/.test(row.identity)
      || fs.lstatSync(row.directory, { throwIfNoEntry: false })) return null;
    let trashPath = row.trash;
    let trash = fs.lstatSync(trashPath, { throwIfNoEntry: false });
    if (!trash) {
      const prefix = `.delegatus-trash-claim-${row.identity.replace(":", "-")}-`;
      const claims = fs.readdirSync(scratch).filter(name => name.startsWith(prefix)).filter(name => {
        const candidate = fs.lstatSync(path.join(scratch, name), { throwIfNoEntry: false });
        return candidate?.isDirectory() && !candidate.isSymbolicLink() && `${candidate.dev}:${candidate.ino}` === row.identity;
      });
      if (claims.length !== 1) return null;
      trashPath = path.join(scratch, claims[0]!); trash = fs.lstatSync(trashPath);
    }
    if (!trash.isDirectory() || trash.isSymbolicLink() || trash.dev !== parent.dev
      || trash.uid !== parent.uid || row.uid !== trash.uid || `${trash.dev}:${trash.ino}` !== row.identity) return null;
    return { directory: row.directory, trash: trashPath, identity: row.identity, uid: row.uid };
  } catch { return null; }
}

function namespaceStill(anchor: TempSweepRoot["anchor"], procRoot: string): boolean {
  if (!anchor) return true;
  return readLink(path.join(procRoot, String(anchor.pid), "ns", "mnt")) === anchor.namespace;
}

/** Damaged or unknown Git metadata still holds its tree. The empty marker
    in uv's source-distribution cache is the one proved disposable class. */
export function isUvCacheMarker(entry: string): boolean {
  return /(?:^|\/)sdists-v\d+(?:\/|$)/.test(path.dirname(entry).replaceAll(path.sep, "/"));
}

function gitCheckoutMarker(entry: string, directory: boolean): boolean {
  try {
    if (directory) return true;
    const stat = fs.lstatSync(entry);
    return !stat.isFile() || stat.size !== 0 || !isUvCacheMarker(entry);
  } catch {
    // Unreadable repository metadata cannot prove a disposable cache marker.
    return true;
  }
}

/** One sweep. Never throws for a single directory; its failure lands in `errors`. */
export async function sweepStaleTempDirs(options: TempSweepOptions): Promise<TempSweepReport> {
  const now = options.now?.() ?? Date.now();
  const procRoot = options.procRoot ?? "/proc";
  const uid = options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  const extraRoots = options.roots?.map(root => root.path);
  const readScan = () => options.currentScan?.() ?? options.scan ?? scanProcesses(procRoot, extraRoots);
  const scan = readScan();
  const roots = options.roots ?? sweepRoots(scan, ownTempRoots(), procRoot);
  const inUse = [...new Set(scan.processes.flatMap(process => process.paths.map(entry => path.resolve(entry))))];
  const readWorktrees = () => (options.currentWorktrees?.() ?? options.worktrees ?? []).map(entry => path.resolve(entry));
  const worktrees = readWorktrees();
  const accounted = (options.accountedWorktrees ?? []).map(entry => path.resolve(entry));
  const maxRemovals = options.maxRemovals ?? MAX_REMOVALS_PER_SWEEP;
  const rawMeasure: typeof measureBytes = options.measure ?? measureBytes;
  const report: TempSweepReport = {
    at: new Date(now).toISOString(), mode: options.mode ?? "on", trashFinished: 0,
    maxAgeHours: options.maxAgeMs / HOUR_MS,
    roots: roots.map((root) => root.via ? `${root.path} (via ${root.via})` : root.path),
    removed: [],
    removedBytes: 0,
    kept: { young: 0, inUse: 0, worktree: 0, deferred: 0, ledger: 0 },
    keptBytes: { young: 0, inUse: 0, worktree: 0, deferred: 0, ledger: 0 },
    held: [],
    errors: [],
  };
  const strayRootSafety = new Map<TempSweepRoot, boolean>();
  /** A stray root must be the directory itself, with no link at it or at any
      parent, so a removal can never land behind a redirected parent. */
  const strayCandidate = (root: TempSweepRoot, name: string) => {
    if (!options.stray || options.onlyDirectories || root.path === options.scratchRoot || !isStrayRoot(root, options.stray.roots)
      || !isStrayTempName(name, options.stray.keep)) return false;
    let safe = strayRootSafety.get(root);
    if (safe === undefined) {
      try {
        let current = "";
        // `lstat` answers for a link itself, so a linked step is no directory.
        safe = root.path.split(path.sep).filter(Boolean).every(step => fs.lstatSync(root.via + (current += path.sep + step)).isDirectory());
      } catch { safe = false; }
      strayRootSafety.set(root, safe);
    }
    return safe;
  };
  const maxAgeFor = (root: TempSweepRoot, candidate: string) => strayCandidate(root, path.basename(candidate))
    ? options.stray!.maxAgeMs : options.maxAgeMs;
  const inspect = (reachable: string, root: TempSweepRoot, candidate: string, afterQuarantine = false) => {
    const stray = strayCandidate(root, path.basename(candidate));
    // Agents keep evidence under their evidence directory; a stray tree's
    // media files (a dependency's icons, a scratch screenshot) are not that.
    try { return (options.inspect ?? inspectTree)(reachable, { threshold: (options.now?.() ?? Date.now()) - maxAgeFor(root, candidate),
      mounts: (options.mountPoints ?? mountPointsUnder)(candidate, root.via), ignoreRootCtime: afterQuarantine,
      preserveEvidence: !options.disposable && !stray, ...(stray ? { sockets: true } : {}) }); }
    catch (error) {
      report.errors.push(`${candidate}: inspection failed: ${String(error)}`);
      return { newestMs: 0, entries: 0, hold: "unreadable-tree" as const };
    }
  };
  /* Every reference check resolves each scanned path's links, and a process
     table holds tens of thousands of them (mapped libraries, environment
     paths). Outside the swept roots a path's resolution is memoized for this
     sweep; inside them it is always read again, because that is where a tree
     is renamed, replaced or linked while the sweep runs. */
  const physicalCache = new Map<string, string>();
  const sweptPrefixes = roots.map(root => root.via + root.path);
  const physicalOf = (file: string) => {
    if (sweptPrefixes.some(prefix => inside(file, prefix))) return resolvePhysicalPath(file);
    let resolved = physicalCache.get(file);
    if (resolved === undefined) { resolved = resolvePhysicalPath(file); if (physicalCache.size < 200_000) physicalCache.set(file, resolved); }
    return resolved;
  };
  /** Hundreds of processes name the same files, so one check answers each
   * spelling once. The answers live no longer than that check. */
  const once = (answer: (file: string) => boolean) => {
    const answers = new Map<string, boolean>();
    return (file: string) => {
      let known = answers.get(file);
      if (known === undefined) answers.set(file, known = answer(file));
      return known;
    };
  };
  const pathHolds = (root: TempSweepRoot, ...directories: string[]) => {
    const physical = directories.map(directory => resolvePhysicalPath(root.via + directory));
    return once((file: string) => {
      const resolved = path.resolve(file.replace(/ \(deleted\)$/, ""));
      return directories.some(directory => inside(resolved, directory))
        || physical.some(directory => inside(physicalOf(root.via + resolved), directory));
    });
  };
  const conversationHolds = (candidate: string, via = "") => (options.conversationCwds?.() ?? options.conversationProtection?.().held ?? []).some(entry =>
    inside(path.resolve(entry), via && candidate.startsWith(via) ? candidate.slice(via.length) : candidate)
      || inside(resolvePhysicalPath(via + entry), resolvePhysicalPath(candidate)));
  const detachedOwner = (root: TempSweepRoot, name: string) => !options.onlyDirectories && root.path !== options.scratchRoot
    ? detachedTempOwner(name) : null;
  const scanIdentities = new WeakMap<ProcessScan, Set<string>>();
  /** A path check reads spellings. The identity of the files behind them also
   * finds a holder in another mount namespace or behind a bind mount. */
  const processHoldsFile = (observed: ProcessScan, tree: string) => {
    let identities = scanIdentities.get(observed);
    if (!identities) scanIdentities.set(observed, identities = identitiesInUse(observed.processes.flatMap(proc => proc.procDirectory
      ? [{ directory: proc.procDirectory, namespace: proc.namespace, mapped: proc.mapped, paths: namedPaths(proc) }] : [])));
    return treeHoldsIdentity(tree, identities, TREE_INSPECTION_ENTRY_LIMIT);
  };
  const unreadScans = new WeakMap<ProcessScan, ProcessScan>();
  /** The processes whose own links do not answer, so the identity match sees
   * nothing of what they use. */
  const unreadByIdentity = (observed: ProcessScan) => {
    let unread = unreadScans.get(observed);
    if (!unread) {
      unreadScans.set(observed, unread = { ownNamespace: observed.ownNamespace, processes: observed.processes.filter(proc => {
        if (!proc.procDirectory) return true;
        try { fs.statSync(`${proc.procDirectory}/root`); return false; } catch { return true; }
      }) });
    }
    return unread;
  };
  /** Whether any process reaches this tree: by the device and inode of the
   * files it uses, and, for a process that cannot be read that way, by
   * translating the paths it names through its mount table. */
  const reachedBy = (root: TempSweepRoot, observed: ProcessScan, tree: string, ...names: string[]): ReferenceHold | null => {
    if (processHoldsFile(observed, tree)) return "process_reference";
    const unread = unreadByIdentity(observed);
    return unread.processes.length && [...new Set(names)].some(name => aliasedReferenceHold(name, root.via, unread, procRoot))
      ? "container_reference" : null;
  };
  /** Registered attempt roots keep their own argument and consumer proof in `eligible`. */
  const processNames = (observed: ProcessScan, holds: (file: string) => boolean) =>
    observed.processes.some(proc => options.onlyDirectories ? proc.paths.some(holds) : processUsesTemp(proc, holds));
  const detachedHold = (kind: "agent" | "gate", root: TempSweepRoot, original: string, reachable: string, observed: ProcessScan,
    removalBegan = false): ReferenceHold | null => {
    const current = root.via ? reachable.slice(root.via.length) : reachable;
    const holds = pathHolds(root, original, current);
    const processHolds = (match: (file: string) => boolean) => observed.processes.some(proc => processUsesTemp(proc, match));
    if (processHolds(holds)) return "process_reference";
    if (observed.unverified) return "process-scan-unverified";
    const protection = options.conversationProtection?.();
    if ((protection?.held ?? options.conversationCwds?.() ?? []).some(holds)) return "conversation_reference";
    if (kind === "agent") {
      const originalHolds = pathHolds(root, original);
      const stat = fs.lstatSync(reachable);
      const recorded = stat.birthtimeMs > 0 && protection && [...protection.ended].some(([cwd, at]) =>
        Math.floor(stat.birthtimeMs) <= at && originalHolds(cwd));
      if (!recorded) return "agent-owner-unverified";
      // A registry cwd is a path spelling. It cannot select between two
      // different trees with that name in known mount namespaces.
      for (const other of roots) {
        if (other.path !== root.path || other.via === root.via || !namespaceStill(other.anchor, procRoot)) continue;
        try {
          const alias = fs.lstatSync(other.via + original, { throwIfNoEntry: false });
          if (alias && (alias.dev !== stat.dev || alias.ino !== stat.ino)) return "agent-owner-unverified";
        } catch { return "agent-owner-unverified"; }
      }
      return reachedBy(root, observed, reachable, original, current);
    }
    // Our interrupted removal can have taken the allocation record with it.
    // The journal's snapshot shows the record was there when ownership was proven.
    if (!(removalBegan && !fs.lstatSync(path.join(reachable, GATE_ALLOCATION_FILE), { throwIfNoEntry: false }))
      && !gateSandboxOwnerEnded(reachable, original, root.via,
        journal => processHolds(pathHolds(root, journal)) || processHoldsFile(observed, root.via + journal))) return "gate-owner-unverified";
    return reachedBy(root, observed, reachable, original, current);
  };
  /** The stray liveness proof: every process in every scanned namespace, its
      cwd, open and mapped files, environment paths and arguments, by path and
      by file identity; then the registry's live conversations. A process that
      refuses inspection shows its command line alone, so a stray also stays
      while an unknown one runs, or while any of them names a path under `/tmp`
      or `/var/tmp`: where it stands from there cannot be seen. */
  const strayHold = (root: TempSweepRoot, original: string, reachable: string, observed: ProcessScan): ReferenceHold | null => {
    const current = root.via ? reachable.slice(root.via.length) : reachable;
    const holds = pathHolds(root, original, current);
    if (observed.processes.some(proc => processUsesTemp(proc, holds))) return "process_reference";
    if (observed.unverified) return "process-scan-unverified";
    const protection = options.conversationProtection?.();
    if ((protection?.held ?? options.conversationCwds?.() ?? []).some(holds)) return "conversation_reference";
    const reached = reachedBy(root, observed, reachable, original, current);
    if (reached) return reached;
    // Both temp roots count, whether or not this pass has them to read.
    const strayRoots = [...new Set([...options.stray?.roots ?? SYSTEM_TEMP_ROOTS,
      ...roots.filter(other => isStrayRoot(other, options.stray?.roots)).map(other => other.path)])];
    const underStrayRoot = pathHolds(root, ...strayRoots);
    return observed.processes.some(proc => proc.uninspectable !== undefined && (!UNINSPECTABLE_DAEMONS.has(proc.uninspectable)
      || processUsesTemp(proc, file => !strayRoots.includes(path.resolve(file)) && underStrayRoot(file))))
      ? "process-scan-unverified" : null;
  };
  let inventoryFailed = false;
  /** Whether a running container holds a stray or detached tree. The process
   * scan answers nothing for a container process of another user, so Docker's
   * mounts are asked by the rule the attempt sweeps use, before quarantine and
   * again on the quarantined tree. A mount keeps naming the original path after
   * the tree moved, so every name the tree has is passed, as the host spells it.
   * A failed read is remembered: every later tree of this pass stays, and a
   * daemon that hangs costs one timeout. */
  const containerHold = async (...names: string[]): Promise<ReferenceHold | null> => {
    const { containerMountHold, readContainerMounts } = await import("@/lib/runtime/attemptTempFilesystem");
    let mounts: ContainerMount[] | null = null;
    if (!inventoryFailed) {
      let cause = "the reply was incomplete";
      try { mounts = await (options.containerMounts ?? readContainerMounts)(); }
      catch (error) { cause = attemptTempFailureDetail(error); }
      if (!mounts) {
        inventoryFailed = true;
        report.errors.push(`container inventory unreadable (${cause}); stray and detached temp trees stay`);
      }
    }
    const hold = containerMountHold(names, mounts);
    return hold === "container_mount_reference" ? "container_reference" : hold;
  };
  /** Asked after the rename and ahead of the synchronous fences, which stay the
   * last thing before removal. */
  const trashMounted = async (root: TempSweepRoot, trash: string, original: string, bytes = 0) => {
    const name = path.basename(original);
    if (!strayCandidate(root, name) && !detachedOwner(root, name)) return false;
    const hold = await containerHold(original, root.via && trash.startsWith(root.via) ? trash.slice(root.via.length) : trash);
    if (hold) report.held!.push({ path: original, via: root.via, reason: hold, bytes });
    return !!hold;
  };
  const trashHolds = (root: TempSweepRoot, trash: string, original: string, bytes = 0, removalBegan = false) => {
    if (!namespaceStill(root.anchor, procRoot)) return true;
    const stray = strayCandidate(root, path.basename(original));
    const owner = stray ? null : detachedOwner(root, path.basename(original));
    if (!stray && !owner && conversationHolds(trash, root.via)) return true;
    const observed = readScan();
    const current = root.via && trash.startsWith(root.via) ? trash.slice(root.via.length) : trash;
    const hold: ReferenceHold | null = stray ? strayHold(root, original, trash, observed)
      : owner ? detachedHold(owner, root, original, trash, observed, removalBegan)
      : processNames(observed, pathHolds(root, ...(options.onlyDirectories ? [current] : [original, current]))) ? "process_reference"
      : options.onlyDirectories ? null : reachedBy(root, observed, trash, original, current);
    if (hold) report.held!.push({ path: original, via: root.via, reason: hold, bytes });
    return !!hold;
  };
  const pinned = (directory: string) => {
    try { fs.lstatSync(path.join(directory, ".delegatus-keep")); return true; } catch { return false; }
  };
  const listedAttempt = (original: string, physical = original) => options.attemptLedger
    && /^llv-(?:read-only-stage|stage|stage-config)-/.test(path.basename(original))
    && (options.attemptLedger(original) || original !== physical && options.attemptLedger(physical));
  const trashPolicyHolds = (root: TempSweepRoot, trash: string, original: string) => {
    if (!options.onlyDirectories && (listedAttempt(original) || fs.existsSync(path.join(trash, ".delegatus-attempt-owner")))) return true;
    if (detachedOwner(root, path.basename(original)) && (fs.lstatSync(trash).mode & 0o077) !== 0) return true;
    const inspection = inspect(trash, root, original, true);
    const protectedTrees = [...readWorktrees(), ...accounted].map(entry => path.resolve(entry));
    return !!pinned(trash) || !!inspection.hold || (options.now?.() ?? Date.now()) - inspection.newestMs < maxAgeFor(root, original)
      || protectedTrees.some(entry => inside(entry, original) || inside(original, entry));
  };
  const trashJournal = (root: TempSweepRoot, candidate: string) => options.onlyDirectories
    ? attemptTempJournalPath(root.via + candidate)
    : path.join(root.via + root.path, `.delegatus-sweep-${randomUUID()}.json`);
  const seenCandidates = new Set<string>();
  const seenAllocations = new Set<string>();
  const measure: typeof measureBytes = async (...args) => {
    try { return await rawMeasure(...args); }
    catch (error) {
      report.errors.push(`${args[0]}: allocation observation failed: ${String(error)}`);
      return 0;
    }
  };
  const candidates: { root: TempSweepRoot; candidate: string; modified: number; stray: boolean; ledger?: TempProvenanceRow }[] = [];
  if (options.stray) report.stray = { maxAgeHours: options.stray.maxAgeMs / HOUR_MS, removed: 0, removedBytes: 0, agentLedger: 0, deferred: 0 };
  const strayMaxRemovals = options.stray?.maxRemovals ?? MAX_STRAY_REMOVALS_PER_SWEEP;
  const replayed = { owned: 0, stray: 0 };
  const ledgerRow = (root: TempSweepRoot, name: string, identity: string) => options.stray?.provenance?.find(row =>
    row.root === root.path && row.name === name && row.identity === identity
    && (row.namespace ?? null) === (root.anchor?.namespace ?? scan.ownNamespace ?? null));
  for (const root of roots) {
    if (!namespaceStill(root.anchor, procRoot)) {
      report.errors.push(`${root.path} (via ${root.via}): namespace is unavailable; skipped`);
      continue;
    }
    let names: string[];
    try {
      names = options.onlyDirectories
        ? options.onlyDirectories.filter(directory => path.dirname(directory) === root.path)
          .flatMap(directory => [path.basename(directory), path.basename(attemptTempJournalPath(root.via + directory))])
        : fs.readdirSync(root.via + root.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.errors.push(`${root.via}${root.path}: ${(error as Error).message}`);
      continue;
    }
    for (const name of names.filter(name => name.startsWith(".delegatus-sweep-") && name.endsWith(".json"))) {
      if (options.mode === "dry-run") continue;
      try {
        const journal = path.join(root.via + root.path, name);
        if (options.onlyDirectories && !fs.existsSync(journal)) continue;
        const row = JSON.parse(fs.readFileSync(journal, "utf8"));
        if (options.onlyDirectories && !options.onlyDirectories.includes(row.directory)) continue;
        if (options.eligible && !await options.eligible(row.trash)) continue;
        if (path.dirname(row.directory) !== root.via + root.path
          || !(isOwnedTempName(path.basename(row.directory)) || detachedOwner(root, path.basename(row.directory))
            || (row.stray === true && strayCandidate(root, path.basename(row.directory))))) continue;
        const original = path.resolve(row.directory);
        const candidate = path.join(root.path, path.basename(original));
        const owner = detachedOwner(root, path.basename(candidate));
        const removalBegan = owner === "gate" && !!row.snapshot?.entries?.[GATE_ALLOCATION_FILE];
        const quarantine = journaledTrash(journal, row);
        const left = fs.existsSync(quarantine);
        // Attempt retirement accounts for its own replays in its ledger. Only a
        // directory beside the original is walked: a journal can name any path.
        const bytes = left && !options.onlyDirectories && path.dirname(quarantine) === path.dirname(row.directory)
          && fs.lstatSync(quarantine).isDirectory() ? await measure(quarantine, new Set()) : 0;
        const finished = await finishTreeTrash(journal,
          async trash => (options.eligible && !await options.eligible(trash)) || await trashMounted(root, trash, candidate)
            || (!owner && trashHolds(root, trash, candidate)),
          options.remove, trash => !trashPolicyHolds(root, trash, owner ? candidate : original) && (!options.dispatchGuard || options.dispatchGuard(trash)),
          options.disposable, owner ? trash => !trashHolds(root, trash, candidate, 0, removalBegan) : undefined, options.keepRefusedTrash);
        if (finished) report.trashFinished!++;
        // A removal that emptied its trash and was lost before it dropped the
        // intent has no row yet either: both paths are gone with the intent.
        const emptied = !left && !fs.existsSync(journal) && !fs.existsSync(row.directory);
        if (!options.onlyDirectories && (finished || emptied)) {
          const stray = row.stray === true;
          report.removed.push({ path: candidate, via: root.via, bytes, ageHours: null, replay: true, ...(stray ? { kind: "stray" as const } : {}) });
          report.removedBytes += bytes;
          if (stray) { report.stray!.removed++; report.stray!.removedBytes += bytes; replayed.stray++; }
          else replayed.owned++;
        }
      } catch (error) { report.errors.push(String(error)); }
    }
    for (const name of names.sort()) {
      const stray = !isOwnedTempName(name) && !detachedOwner(root, name) && strayCandidate(root, name);
      if (!isOwnedTempName(name) && !detachedOwner(root, name) && !stray) continue;
      if (options.onlyDirectories && !options.onlyDirectories.includes(path.join(root.path, name))) continue;
      const candidate = path.join(root.path, name);
      let modified: number, ledger: TempProvenanceRow | undefined;
      try {
        const stat = fs.lstatSync(root.via + candidate);
        modified = stat.mtimeMs;
        if (stray) ledger = ledgerRow(root, name, provenanceIdentity(stat));
      } catch { continue; }
      candidates.push({ root, candidate, modified, stray, ...(ledger ? { ledger } : {}) });
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
      await measure(root.via + checkout, seenAccounted, false, [], links);
      if (namespaceStill(root.anchor, procRoot)) for (const identity of links) seenAllocations.add(identity);
    }
  }
  // Nested owned roots receive their own allocations before a parent walk.
  // Strays come after owned names; among strays, trees an agent was recorded
  // using come first, then the oldest.
  for (const { root, candidate, stray, ledger } of candidates.sort((a, b) => b.candidate.split(path.sep).length - a.candidate.split(path.sep).length
    || Number(a.stray) - Number(b.stray) || Number(!a.ledger) - Number(!b.ledger)
    || a.modified - b.modified || a.candidate.localeCompare(b.candidate))) {
    try {
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
      // A stray needs this service's uid by number: without one there is no
      // ownership proof, so nothing of an unknown owner is ever a stray.
      if (stray && uid === null) continue;
      const owner = detachedOwner(root, path.basename(candidate));
      if (owner && (uid === null || (stat.mode & 0o077) !== 0)) continue;
      const identity = `${stat.dev}:${stat.ino}`;
      if (seenCandidates.has(identity)) continue;
      seenCandidates.add(identity);
      const excluded = accounted.flatMap(checkout => root.via ? [checkout, root.via + checkout] : [checkout]);
      const includeRoot = candidates.some(other => other.candidate !== candidate && inside(candidate, other.candidate));
      const keep = async (reason: keyof TempSweepReport["kept"], measured?: number): Promise<boolean> => {
        const bytes = measured ?? await measure(reachable, seenAllocations, includeRoot, excluded);
        if (!namespaceStill(root.anchor, procRoot)) {
          report.errors.push(`${root.path} (via ${root.via}): namespace changed during measurement; skipped`);
          return false;
        }
        report.kept[reason] = (report.kept[reason] ?? 0) + 1;
        report.keptBytes![reason] = (report.keptBytes![reason] ?? 0) + bytes;
        return true;
      };
      const keepReference = async (reason: ReferenceHold, bytes: number) => {
        if (await keep("inUse", bytes)) report.held!.push({ path: candidate, via: root.via, reason, bytes });
      };
      // The attempt ledger owns this root: it measures it with one native
      // `du` and decides its retirement. This sweep never removes it, so a
      // walk of its tree here would only repeat that measurement. A marked
      // root the ledger does not list has no owner left; it stays, and the
      // report names it. No process was asked about it, so it is counted as
      // the ledger's, never as in use.
      if (!options.onlyDirectories) {
        const listed = listedAttempt(candidate, originalPath);
        if (listed || fs.existsSync(path.join(reachable, ".delegatus-attempt-owner"))) {
          if (await keep("ledger", 0) && listed === false) report.held!.push({ path: candidate, via: root.via, reason: "attempt-owner-unlisted", bytes: 0 });
          continue;
        }
      }
      if (owner) {
        const hold = detachedHold(owner, root, candidate, reachable, scan);
        if (hold) {
          await keepReference(hold, 0);
          continue;
        }
      }
      // A process of another user is invisible to this scan, and a mode that
      // admits other users lets one work inside. Only a private tree is a stray.
      if (stray && (stat.mode & 0o077) !== 0) {
        if (await keep("inUse", 0)) report.held!.push({ path: candidate, via: root.via, reason: "shared-access", bytes: 0 });
        continue;
      }
      const maxAgeMs = stray ? options.stray!.maxAgeMs : options.maxAgeMs;
      const inspection = inspect(reachable, root, candidate);
      const newest = inspection.newestMs;
      const pinned = fs.existsSync(path.join(reachable, ".delegatus-keep")) || (() => { try { fs.lstatSync(path.join(reachable, ".delegatus-keep")); return true; } catch { return false; } })();
      if (pinned || inspection.hold) {
        const bytes = inspection.hold === "mount-boundary" ? 0 : await measure(reachable, seenAllocations, includeRoot, excluded);
        if (await keep("worktree", bytes)) report.held!.push({ path: candidate, via: root.via, reason: pinned ? "pinned" : inspection.hold!, bytes });
        continue;
      }
      if (now - newest < maxAgeMs) {
        await keep("young");
        continue;
      }
      const processHolds = (entry: string) => inside(entry, candidate)
        || inside(resolvePhysicalPath(root.via + entry), originalPath);
      if (stray) {
        const hold = strayHold(root, candidate, reachable, scan);
        if (hold) { await keepReference(hold, 0); continue; }
      } else if (!owner) {
        // A process that refuses inspection holds what its command line names,
        // flag values included, before any mount translation is asked.
        const named = inUse.some(processHolds)
          || processNames({ ...scan, processes: scan.processes.filter(proc => proc.uninspectable !== undefined) }, once(entry => processHolds(path.resolve(entry))));
        if (named || conversationHolds(reachable, root.via)) {
          await keep("inUse");
          if (named) report.held!.push({ path: candidate, via: root.via, reason: "process_reference", bytes: 0 });
          continue;
        }
        if (aliasedReferenceHold(candidate, root.via, unreadByIdentity(scan), procRoot)) {
          await keepReference("container_reference", 0);
          continue;
        }
      }
      const physicallyOverlaps = (entries: readonly string[]) => entries.some(entry => (root.via ? [entry, root.via + entry] : [entry]).some(accessible => {
        try {
          const physical = fs.realpathSync(accessible);
          return inside(physical, originalPath) || inside(originalPath, physical);
        } catch { return false; }
      }));
      const protectedBy = (entries: readonly string[]) => entries.some(entry => inside(entry, candidate) || inside(candidate, entry)) || physicallyOverlaps(entries);
      const checkoutHold = (entries: readonly string[]) => protectedBy(entries) ? "git-checkout" : inspection.hold
        ?? (physicallyOverlaps(accounted) ? "git-checkout" : null);
      const hold = checkoutHold(worktrees);
      if (hold) {
        const bytes = await measure(reachable, seenAllocations, includeRoot, excluded);
        if (await keep("worktree", bytes)) report.held!.push({ path: candidate, via: root.via, reason: hold, bytes });
        continue;
      }
      // The budgets bound what this pass begins; replayed removals are outside them.
      if (stray ? report.stray!.removed - replayed.stray >= strayMaxRemovals
        : report.removed.length - (report.stray?.removed ?? 0) - replayed.owned >= maxRemovals) {
        if (stray) report.stray!.deferred++;
        await keep("deferred");
        continue;
      }
      if (!namespaceStill(root.anchor, procRoot)) {
        report.errors.push(`${root.path} (via ${root.via}): the namespace it was read through is gone; skipped`);
        continue;
      }
      try {
        const bytes = await measure(reachable, seenAllocations, includeRoot, excluded);
        const mounted = stray || owner ? await containerHold(candidate) : null;
        const freshScan = readScan();
        const hold: ReferenceHold | null = mounted ? mounted
          : stray ? strayHold(root, candidate, reachable, freshScan)
          : owner ? detachedHold(owner, root, candidate, reachable, freshScan)
          : processNames(freshScan, once(entry => processHolds(path.resolve(entry)))) ? "process_reference"
          : conversationHolds(reachable, root.via) ? "conversation_reference"
          : options.onlyDirectories ? null : reachedBy(root, freshScan, reachable, candidate);
        if (hold) {
          if (owner || stray || hold === "process_reference" || hold === "container_reference") await keepReference(hold, bytes);
          else await keep("inUse", bytes);
          continue;
        }
        // Measurement yields to new owners and filesystem activity. Date and
        // inspect the same physical tree again immediately before removal.
        const current = fs.lstatSync(reachable);
        if (!current.isDirectory() || (uid !== null && current.uid !== uid) || (owner && (current.mode & 0o077) !== 0)
          || `${current.dev}:${current.ino}` !== identity
          || fs.realpathSync(reachable) !== originalPath) {
          report.errors.push(`${reachable}: temp directory changed during measurement; skipped`);
          continue;
        }
        const finalInspection = inspect(reachable, root, candidate);
        const finalPin = (() => { try { fs.lstatSync(path.join(reachable, ".delegatus-keep")); return true; } catch { return false; } })();
        if (finalInspection.hold || finalPin) {
          if (await keep("worktree", bytes)) report.held!.push({ path: candidate, via: root.via, reason: finalPin ? "pinned" : finalInspection.hold!, bytes });
          continue;
        }
        if ((options.now?.() ?? Date.now()) - finalInspection.newestMs < maxAgeMs) {
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
        if (options.eligible && !await options.eligible(reachable)) { await keep("inUse", bytes); continue; }
        if (options.mode !== "dry-run" && !await removeTreeViaTrash(reachable, {
          journal: trashJournal(root, candidate), remove: options.remove, disposable: options.disposable,
          ...(stray ? { stray: true } : {}),
          held: async trash => (options.eligible && !await options.eligible(trash)) || await trashMounted(root, trash, candidate, bytes)
            || (!owner && trashHolds(root, trash, candidate, bytes)),
          validate: trash => !trashPolicyHolds(root, trash, path.resolve(candidate)) && (!options.dispatchGuard || options.dispatchGuard(trash)),
          ...(owner ? { dispatch: (trash: string) => !trashHolds(root, trash, candidate, bytes) } : {}),
        })) { await keep("inUse", bytes); continue; }
        const removal: TempSweepRemoval = { path: candidate, via: root.via, bytes, ageHours: Math.round((now - newest) / HOUR_MS) };
        if (stray) {
          removal.kind = "stray";
          removal.provenance = ledger ? "agent-ledger" : "age-liveness";
          const inspected = freshScan.processes.filter(proc => proc.uninspectable === undefined);
          removal.proof = { newestWriteAt: new Date(finalInspection.newestMs).toISOString(), entries: finalInspection.entries,
            uid, mode: (current.mode & 0o7777).toString(8), identity, processes: inspected.length,
            namespaces: new Set(inspected.map(proc => proc.namespace)).size,
            uninspectable: freshScan.processes.length - inspected.length,
            ...(ledger ? { ledger: { firstSeenAt: ledger.firstSeenAt, lastSeenAt: ledger.lastSeenAt, evidence: ledger.evidence } } : {}) };
          report.stray!.removed++;
          report.stray!.removedBytes += bytes;
          if (ledger) report.stray!.agentLedger++;
        }
        report.removed.push(removal);
        report.removedBytes += bytes;
      } catch (error) {
        report.errors.push(`${reachable}: ${(error as Error).message}`);
      }
    } catch (error) {
      report.errors.push(`${candidate}: inspection failed: ${String(error)}`);
    }
  }
  return report;
}

const REPORT_FILE = () => statePath("temp-sweep-report.json");
const PROVENANCE_FILE = () => statePath("temp-provenance.json");

/** Drop ledger rows whose tree is gone or whose name now holds another inode,
    for the roots this pass can see; rows of other namespaces stay. */
export function pruneTempProvenance(rows: readonly TempProvenanceRow[], roots: readonly TempSweepRoot[], ownNamespace: string | null): TempProvenanceRow[] {
  return rows.filter(row => {
    const root = roots.find(candidate => candidate.path === row.root
      && (candidate.anchor?.namespace ?? ownNamespace ?? null) === (row.namespace ?? null));
    if (!root) return true;
    try {
      const stat = fs.lstatSync(path.join(root.via + root.path, row.name));
      return stat.isDirectory() && provenanceIdentity(stat) === row.identity;
    } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  });
}

/** Record which stray trees Delegatus agents are using now. */
function updateTempProvenance(roots: readonly TempSweepRoot[], policy: StrayTempPolicy, at: string, scan: ProcessScan): TempProvenanceRow[] {
  const file = PROVENANCE_FILE();
  const rows = mergeTempProvenance(pruneTempProvenance(readTempProvenance(file), roots, scan.ownNamespace),
    observeTempProvenance(scan, roots, at, { uid: process.getuid?.() ?? null, keep: policy.keep }));
  try { writeJsonDurably(file, rows); }
  catch (error) { console.warn("[temp sweep] provenance ledger not written", error instanceof Error ? error.message : String(error)); }
  return rows;
}
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
  const heldFor = ["agent-owner-unverified", "gate-owner-unverified", "conversation_reference", "process-scan-unverified", "process_reference", "container_reference",
    "container_inventory_unknown", "shared-access"]
    .some(reason => heldCounts[reason]) ? "by safety checks" : "for Git preservation or tree inspection";
  return {
    at: report.at, ...(report.failed ? { failed: true } : {}), mode: report.mode ?? "on", trashFinished: report.trashFinished ?? 0, removed: report.removed.length, removedBytes: report.removedBytes,
    kept: { ...report.kept }, keptBytes: report.keptBytes ? { ...report.keptBytes } : null, heldCounts, heldBytes, errors: report.errors.length,
    ...(report.stray ? { stray: { ...report.stray } } : {}),
    summary: `[temp sweep] ${report.mode === "dry-run" ? "would remove" : "removed"} ${report.removed.length} directories (${megabytes(report.removedBytes)}); held ${(report.held ?? []).length} ${heldFor}; ${report.errors.length} error(s)`
      + (report.stray ? `; strays older than ${report.stray.maxAgeHours} h in /tmp and /var/tmp: ${report.stray.removed} removed (${megabytes(report.stray.removedBytes)}), ${report.stray.deferred} deferred` : ""),
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
  const [{ loadPipelinesForList }, { readWorktreeSweepReport, conversationCwdStatus, liveOrWaitingConversationCwds }, { agentRegistry }] = await Promise.all([
    import("@/lib/pipelines/store"), import("@/lib/pipelines/worktreeSweep"), import("@/lib/agent/registry"),
  ]);
  const snapshot = () => agentRegistry().worktreeProtectionSnapshot();
  return {
    conversationCwds: () => liveOrWaitingConversationCwds(snapshot()),
    conversationProtection: () => {
      const ended = new Map<string, number>();
      const { held, deferred } = conversationCwdStatus(snapshot(), undefined, undefined, ended);
      return { held: [...held, ...deferred], ended };
    },
    worktrees: loadPipelinesForList().map(pipeline => pipeline.worktreeDir).filter((dir): dir is string => !!dir),
    currentWorktrees: () => loadPipelinesForList().map(pipeline => pipeline.worktreeDir).filter((dir): dir is string => !!dir),
    accountedWorktrees: (readWorktreeSweepReport()?.kept ?? []).map(row => row.path),
  };
}

/** Result files the files-response worker and its Viewer left behind, in the
    same pass and mode, with their own report. A failure here is logged and
    never stops the temp sweep. */
async function sweepFilesResponseResultFiles(mode: "on" | "dry-run", now?: () => number): Promise<void> {
  try {
    const results = await import("@/lib/scanner/filesResponseResults");
    const report = results.sweepFilesResponseResults({ mode, ...(now ? { now } : {}) });
    results.recordFilesResponseSweep(report);
    console.log(results.filesResponseSweepSummary(report));
  } catch (error) {
    console.error("[files response sweep] failed", error instanceof Error ? error.message : String(error));
  }
}

type TempSweepPorts = Pick<TempSweepOptions, "roots" | "scan" | "now" | "inspect" | "mountPoints" | "containerMounts">;

/** The production sweep: threshold from the environment, worktrees from the pipelines store. */
export async function runTempSweepInHelper(env: NodeJS.ProcessEnv = process.env, ports: TempSweepPorts = {}): Promise<TempSweepReport | null> {
  const maxAgeMs = tempSweepMaxAgeMs(env);
  const mode = tempSweepMode(env);
  const strayPolicy = strayTempPolicy(env);
  if (maxAgeMs === null || mode === null) return null;
  await sweepFilesResponseResultFiles(mode, ports.now);
  let checkouts: Awaited<ReturnType<typeof cleanupWorktrees>>;
  try {
    checkouts = await cleanupWorktrees();
  } catch (error) {
    /* Without the worktree list nothing can be proven safe to remove. */
    console.error("[temp sweep] skipped: the pipeline worktrees could not be read", error instanceof Error ? error.message : String(error));
    return null;
  }
  const scratch = realDirectory(statePath("scratch"));
  const candidates = ports.roots ?? discoverSweepRoots([...ownTempRoots(env), ...(scratch ? [scratch] : [])]);
  const writable = new Set(writableRoots(candidates.filter(root => !root.via).map(root => root.path)));
  const view = await openHostTempRoots(candidates, env);
  const roots = view.roots.filter(root => root.via || writable.has(root.path));
  // Root discovery is one snapshot; deletion gets its own fresh process scan.
  let report: TempSweepReport;
  try {
    // A ledger that cannot be opened leaves every marked root counted as listed.
    let ledger: { has: (directory: string) => boolean; close: () => void } | undefined;
    try { ledger = new (await import("@/lib/runtime/attemptTempRetention")).AttemptTempStore(); }
    catch (error) { console.error("[temp sweep] attempt ledger unavailable", error instanceof Error ? error.message : String(error)); }
    const opened = ledger;
    try {
      const stray = strayPolicy ? { ...strayPolicy, provenance: updateTempProvenance(roots, strayPolicy,
        new Date(ports.now?.() ?? Date.now()).toISOString(), ports.scan ?? scanProcesses("/proc", roots.map(root => root.path))) } : undefined;
      report = await sweepStaleTempDirs({ maxAgeMs, mode, ...(opened ? { attemptLedger: (directory: string) => opened.has(directory) } : {}), ...ports, roots, scratchRoot: scratch, ...checkouts,
        ...(stray ? { stray } : {}) });
    }
    finally { opened?.close(); await view.close(); }
  } catch (error) {
    report = { at: new Date(ports.now?.() ?? Date.now()).toISOString(), failed: true, mode,
      maxAgeHours: maxAgeMs / HOUR_MS, roots: roots.map(root => root.path), removed: [], removedBytes: 0,
      kept: { young: 0, inUse: 0, worktree: 0, deferred: 0 }, errors: [String(error)] };
    recordTempSweep(report);
    throw error;
  }
  recordTempSweep(report);
  const { young, inUse, worktree, deferred, ledger = 0 } = report.kept;
  console.log(
    `[temp sweep] removed ${report.removed.length} stale director${report.removed.length === 1 ? "y" : "ies"} (${megabytes(report.removedBytes)});`
    + ` kept ${young} young, ${inUse} in use, ${worktree} worktree, ${deferred} deferred, ${ledger} owned by the attempt ledger;`
    + ` ${(report.held ?? []).filter(hold => hold.reason === "attempt-owner-unlisted").length} attempt root(s) outside the ledger; ${report.errors.length} error(s)`
    + (report.stray ? `; strays: removed ${report.stray.removed} (${megabytes(report.stray.removedBytes)}, ${report.stray.agentLedger} recorded agent trees), ${report.stray.deferred} deferred` : ""),
  );
  return report;
}

/** Production calls share the leased sweep helper. Explicit inspection ports
 * keep the policy tests local without changing any removal decision. */
export async function runTempSweep(env: NodeJS.ProcessEnv = process.env, ports: TempSweepPorts = {}): Promise<TempSweepReport | null> {
  if (Object.keys(ports).length) return runTempSweepInHelper(env, ports);
  const { runTempSweepOffThread } = await import("@/lib/pipelines/worktreeSweepWorker");
  return runTempSweepOffThread(env);
}

const sweepHost = globalThis as typeof globalThis & {
  __llvTempSweepTimer?: ReturnType<typeof setTimeout>;
  __llvAttemptTempTimer?: ReturnType<typeof setTimeout>;
  __llvTempPressureStop?: () => void;
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
  if (tempSweepMaxAgeMs() === null || tempSweepMode() === null) return;
  const schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const sweep = ports.sweep ?? (() => runTempSweep());
  let running = false;
  const arm = (delayMs: number) => {
    const timer = schedule(() => {
      running = true;
      void withViewerOperation("temp.sweep", sweep)
        .catch((error) => console.error("[temp sweep] failed", error instanceof Error ? error.message : String(error)))
        .finally(() => {
          running = false;
          if (sweepHost.__llvTempSweepTimer === timer) arm(ports.intervalMs ?? TEMP_SWEEP_INTERVAL_MS);
        });
    }, delayMs);
    timer.unref?.();
    sweepHost.__llvTempSweepTimer = timer;
  };
  sweepHost.__llvTempPressureStop = registerDiskPressureSweep("temp", () => {
    if (!running && sweepHost.__llvTempSweepTimer) { clearTimeout(sweepHost.__llvTempSweepTimer); arm(0); }
  });
  arm(ports.firstDelayMs ?? FIRST_SWEEP_DELAY_MS);
  if (!Object.keys(ports).length) {
    const attemptArm = (delayMs = 60_000) => {
      const timer = setTimeout(() => {
        void import("@/lib/pipelines/worktreeSweepWorker")
          .then(({ runAttemptTempSweepOffThread }) => runAttemptTempSweepOffThread())
          .catch(error => console.error("[attempt temp] tick failed", attemptTempFailureDetail(error)))
          .then(() => import("@/lib/pipelines/worktreeSweepWorker"))
          .then(({ runTemporaryDataMaintenanceOffThread }) => sweepHost.__llvAttemptTempTimer === timer ? runTemporaryDataMaintenanceOffThread() : null)
          .catch(error => console.error("[temporary data] tick failed", attemptTempFailureDetail(error)))
          .finally(() => { if (sweepHost.__llvAttemptTempTimer === timer) attemptArm(); });
      }, delayMs);
      timer.unref?.();
      sweepHost.__llvAttemptTempTimer = timer;
    };
    attemptArm();
  }
}

/** Test seam: the timer is process-global. */
export function stopTempSweep(): void {
  sweepHost.__llvTempPressureStop?.();
  if (sweepHost.__llvTempSweepTimer) clearTimeout(sweepHost.__llvTempSweepTimer);
  sweepHost.__llvTempSweepTimer = undefined;
  if (sweepHost.__llvAttemptTempTimer) clearTimeout(sweepHost.__llvAttemptTempTimer);
  sweepHost.__llvAttemptTempTimer = undefined;
}
