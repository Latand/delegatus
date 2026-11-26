import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { writeJsonDurably } from "@/lib/state/durableJson";

/** The worker's own cap: a build that does not answer in this long is
    abandoned and its worker stopped. The seat source deadline is shorter. */
export const FILES_RESPONSE_WORKER_TIMEOUT_MS = 60_000;

/** The directory the Viewer and its files-response worker exchange bodies in. */
export const FILES_RESPONSE_RESULTS_DIRECTORY = "files-response-results";

/**
 * How old a result file must be before the sweep may remove it. Every reader
 * reads a whole file with one `readFile` while its request is open: the Viewer
 * reads `<pid>-<uuid>.json` and `.delta.json` when the worker answers, the
 * worker reads `.base.json` and `seat-agenda-<uuid>.json` while it builds. A
 * request ends within FILES_RESPONSE_WORKER_TIMEOUT_MS, after which nobody
 * reads its files, and an unlink after the reader opened the file cannot cut
 * its read short. An hour is sixty of those windows.
 */
export const FILES_RESPONSE_RESULT_MIN_AGE_MS = 60 * FILES_RESPONSE_WORKER_TIMEOUT_MS;

/** Bounds one pass; the next hourly pass continues. */
const MAX_ENTRIES_PER_PASS = 20_000;
const MAX_REMOVALS_PER_PASS = 5_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `<writer pid>-<uuid>.json|.delta.json` from the worker, `.base.json` from the Viewer. */
const PID_RESULT = new RegExp(`^([1-9]\\d{0,9})-${UUID}\\.(?:json|delta\\.json|base\\.json)$`);
/** The worker's temporary while it replaces a delta base. */
const BASE_TEMPORARY = /^delta-base-[0-9a-f]{40}\.json\.([1-9]\d{0,9})\.tmp$/;
/** The Viewer's seat agenda body, removed in its own `finally`. */
const SEAT_AGENDA = new RegExp(`^seat-agenda-${UUID}\\.json$`);
/** Deliberate: the worker keeps the newest DELTA_BASES_KEPT itself. */
const DELTA_BASE = /^delta-base-[0-9a-f]{40}\.json$/;

export type FilesResponseRemovalReason = "writer-exited" | "writer-previous-boot" | "request-ended";
export type FilesResponseKeptReason = "young" | "writer-alive" | "delta-base" | "unrecognized" | "not-a-file" | "foreign-owner" | "changed" | "pass-budget";

export type FilesResponseSweepReport = {
  at: string;
  mode: "on" | "dry-run";
  minAgeHours: number;
  /** In dry-run mode, what a pass would have removed. */
  removed: { name: string; reason: FilesResponseRemovalReason; bytes: number; ageHours: number }[];
  removedBytes: number;
  kept: Record<FilesResponseKeptReason, number>;
  keptBytes: Record<FilesResponseKeptReason, number>;
  errors: string[];
};

/** Kernel evidence about a writer, read fresh for every decision. */
export type WriterProbe = {
  /** False only when the pid has no live process (gone, or exited and unreaped). */
  alive(pid: number): boolean;
  /** Epoch ms the process now holding `pid` started, or null when unknown. */
  startedAt(pid: number): number | null;
  /** Epoch ms of this boot, or null when unknown. */
  bootAt(): number | null;
};

function linuxBootAt(): number | null {
  try {
    const match = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    return match ? Number(match[1]) * 1000 : null;
  } catch { return null; }
}

export const defaultWriterProbe: WriterProbe = {
  alive: pid => procBackend.pidAlive(pid) && !procBackend.processExited(pid),
  startedAt: pid => {
    if (process.platform !== "linux") return null;
    const ticks = procBackend.processIdentity(pid)?.split(":")[1];
    const boot = linuxBootAt();
    // /proc reports start times in USER_HZ (100 per second).
    return ticks && /^\d+$/.test(ticks) && boot !== null ? boot + Number(ticks) * 10 : null;
  },
  bootAt: () => process.platform === "linux" ? linuxBootAt() : null,
};

/** btime is whole seconds and process start is in ticks; never decide inside this slack. */
const CLOCK_SLACK_MS = 2_000;

/** Why the writer of a file last changed at `changedMs` is proven gone, or null. */
function writerGone(pid: number, changedMs: number, probe: WriterProbe): FilesResponseRemovalReason | null {
  const boot = probe.bootAt();
  if (boot !== null && changedMs < boot - CLOCK_SLACK_MS) return "writer-previous-boot";
  if (!probe.alive(pid)) return "writer-exited";
  // The process now at this pid started after the file last changed: a reused pid.
  const started = probe.startedAt(pid);
  if (started !== null && started > changedMs + CLOCK_SLACK_MS) return "writer-exited";
  return null;
}

type Entry = { name: string; file: string; stat: fs.Stats };
const changedAt = (stat: fs.Stats) => Math.max(stat.mtimeMs, stat.ctimeMs);
const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.isFile();

/** The removal decision for one regular file, or the reason it stays. */
function decide(entry: Entry, now: number, probe: WriterProbe): { removal: FilesResponseRemovalReason } | { kept: FilesResponseKeptReason } {
  const { name, stat } = entry;
  if (DELTA_BASE.test(name)) return { kept: "delta-base" };
  const writer = PID_RESULT.exec(name)?.[1] ?? BASE_TEMPORARY.exec(name)?.[1];
  if (!writer && !SEAT_AGENDA.test(name)) return { kept: "unrecognized" };
  // A future timestamp is not evidence of age.
  if (now - changedAt(stat) < FILES_RESPONSE_RESULT_MIN_AGE_MS) return { kept: "young" };
  // The seat agenda's writer removes it when its bounded request ends, so an
  // old one belongs to a request that ended without that cleanup.
  if (!writer) return { removal: "request-ended" };
  const gone = writerGone(Number(writer), changedAt(stat), probe);
  return gone ? { removal: gone } : { kept: "writer-alive" };
}

const emptyCounts = (): Record<FilesResponseKeptReason, number> =>
  ({ young: 0, "writer-alive": 0, "delta-base": 0, unrecognized: 0, "not-a-file": 0, "foreign-owner": 0, changed: 0, "pass-budget": 0 });

/**
 * Removes result files the files-response worker and its Viewer left behind:
 * files whose request ended without the reader's cleanup because a worker was
 * stopped or a Viewer restarted. A file goes only when it is older than
 * FILES_RESPONSE_RESULT_MIN_AGE_MS and its writer is proven gone: the pid in
 * its name has no live process, a process that started after the file was
 * written, or the file predates this boot. Delta bases and any other name
 * stay. Symlinks and other non-files are never followed or removed, and every
 * decision is made again from a fresh lstat and probe immediately before the
 * unlink.
 */
export function sweepFilesResponseResults(options: {
  mode: "on" | "dry-run";
  directory?: string;
  now?: () => number;
  probe?: WriterProbe;
  uid?: number | null;
  remove?: (file: string) => void;
}): FilesResponseSweepReport {
  const now = options.now ?? Date.now;
  const probe = options.probe ?? defaultWriterProbe;
  const report: FilesResponseSweepReport = {
    at: new Date(now()).toISOString(), mode: options.mode, minAgeHours: FILES_RESPONSE_RESULT_MIN_AGE_MS / 3_600_000,
    removed: [], removedBytes: 0, kept: emptyCounts(), keptBytes: emptyCounts(), errors: [],
  };
  const keep = (reason: FilesResponseKeptReason, stat?: fs.Stats) => {
    report.kept[reason]++;
    report.keptBytes[reason] += stat?.isFile() ? stat.size : 0;
  };
  const directory = options.directory ?? statePath(FILES_RESPONSE_RESULTS_DIRECTORY);
  let root: fs.Stats;
  try { root = fs.lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.errors.push(`${directory}: ${String(error)}`);
    return report;
  }
  const uid = options.uid === undefined ? process.getuid?.() ?? null : options.uid;
  if (!root.isDirectory() || (uid !== null && root.uid !== uid)) {
    report.errors.push(`${directory}: not a directory this user owns; skipped`);
    return report;
  }
  let names: string[];
  try { names = fs.readdirSync(directory).sort(); }
  catch (error) { report.errors.push(`${directory}: ${String(error)}`); return report; }
  const remove = options.remove ?? (file => fs.unlinkSync(file));
  let examined = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    if (++examined > MAX_ENTRIES_PER_PASS || report.removed.length >= MAX_REMOVALS_PER_PASS) { keep("pass-budget"); continue; }
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) { keep("not-a-file", stat); continue; }
      if (uid !== null && stat.uid !== uid) { keep("foreign-owner", stat); continue; }
      const verdict = decide({ name, file, stat }, now(), probe);
      if ("kept" in verdict) { keep(verdict.kept, stat); continue; }
      // Re-read the file, the directory and the writer right before the unlink.
      const current = fs.lstatSync(file);
      const parent = fs.lstatSync(directory);
      const again = decide({ name, file, stat: current }, now(), probe);
      if (!sameFile(stat, current) || parent.dev !== root.dev || parent.ino !== root.ino || !parent.isDirectory() || !("removal" in again)) {
        keep("changed", current); continue;
      }
      if (options.mode === "on") remove(file);
      report.removed.push({ name, reason: again.removal, bytes: stat.size,
        ageHours: Math.round((now() - changedAt(stat)) / 36_000) / 100 });
      report.removedBytes += stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // its reader removed it
      report.errors.push(`${name}: ${String(error)}`);
    }
  }
  return report;
}

const REPORT_FILE = () => statePath("files-response-sweep-report.json");

export function recordFilesResponseSweep(report: FilesResponseSweepReport): void {
  fs.mkdirSync(path.dirname(REPORT_FILE()), { recursive: true, mode: 0o700 });
  writeJsonDurably(REPORT_FILE(), report);
}

/** Operator summary beside the temp sweep's on the resources surface. */
export function filesResponseSweepStatus() {
  let report: FilesResponseSweepReport;
  try { report = JSON.parse(fs.readFileSync(REPORT_FILE(), "utf8")) as FilesResponseSweepReport; }
  catch { return null; }
  return {
    at: report.at, mode: report.mode, removed: report.removed.length, removedBytes: report.removedBytes,
    kept: { ...report.kept }, keptBytes: { ...report.keptBytes }, errors: report.errors.length,
  };
}

/** One summary line for the sweep helper's log. */
export function filesResponseSweepSummary(report: FilesResponseSweepReport): string {
  const kept = Object.entries(report.kept).filter(([, count]) => count > 0).map(([reason, count]) => `${count} ${reason}`).join(", ") || "nothing";
  return `[files response sweep] ${report.mode === "dry-run" ? "would remove" : "removed"} ${report.removed.length} result file(s)`
    + ` (${(report.removedBytes / 1_048_576).toFixed(1)} MB); kept ${kept}; ${report.errors.length} error(s)`;
}
