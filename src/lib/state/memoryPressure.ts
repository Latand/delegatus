import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "./durableJson";
import { withFileTransactionAsync } from "./fileTransaction";
import type { SeatTickCard } from "@/lib/monitor/types";

/**
 * Memory, swap and the tmpfs `/tmp`, read beside free disk space.
 *
 * Agents fill `/tmp`, and on a machine where `/tmp` is a tmpfs that is RAM
 * and then swap: on 2026-11-26 one workstation held 8.3 GB of agents' temp
 * trees there and 29 GB of swap. The System panel and the seat tick show the
 * three readings. When swap is more than half used, or a tmpfs `/tmp` holds
 * more than 4 GB, the operator is warned the way low disk space warns
 * (a seat card, a manager report and a seat-tick item, once per episode), and
 * the temp sweep with its stray pass runs at once, at most every 15 minutes.
 */

/** `f_type` of a tmpfs, from statfs(2). */
export const TMPFS_MAGIC = 0x01021994;
export const DEFAULT_SWAP_WARN_PERCENT = 50;
/** GB is 10⁹ bytes, like the disk thresholds' requirement text. */
export const DEFAULT_TMPFS_WARN_GB = 4;
/** An open episode ends only once every reading is below this share of its threshold. */
const RECOVERY_FACTOR = 0.9;
/** The immediate temp sweep a pressure episode asks for runs at most this often. */
export const MEMORY_SWEEP_MIN_INTERVAL_MS = 15 * 60_000;
/** A persisted reading older than this is read again rather than shown. */
const REPORT_FRESH_MS = 2 * 60_000;

export type MemoryUsage = { usedBytes: number; totalBytes: number };
export type TmpUsage = MemoryUsage & { tmpfs: boolean; view: "host" | "own" };
export type MemoryReading = { ram: MemoryUsage; swap: MemoryUsage; tmp: TmpUsage | null };
export type MemoryPressureReason = "swap" | "tmp";
export type MemoryPressure = MemoryReading & {
  at: string;
  episode: string | null;
  reasons: MemoryPressureReason[];
  swapWarnPercent: number;
  tmpWarnBytes: number;
};
export type MemoryThresholds = { swapWarnPercent: number; tmpWarnBytes: number };

export function memoryThresholds(env: Readonly<Record<string, string | undefined>> = process.env): MemoryThresholds {
  const number = (raw: string | undefined, fallback: number, valid: (value: number) => boolean) => {
    const value = raw?.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) && valid(value) ? value : fallback;
  };
  return {
    swapWarnPercent: number(env.LLV_MEMORY_SWAP_WARN_PERCENT, DEFAULT_SWAP_WARN_PERCENT, value => value > 0 && value <= 100),
    tmpWarnBytes: number(env.LLV_TMPFS_WARN_GB, DEFAULT_TMPFS_WARN_GB, value => value > 0) * 1e9,
  };
}

/** RAM in use is what the kernel cannot hand out again (total − available). */
export function parseMeminfo(text: string): Pick<MemoryReading, "ram" | "swap"> | null {
  const kib = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kib("MemTotal"), available = kib("MemAvailable"), swapTotal = kib("SwapTotal"), swapFree = kib("SwapFree");
  if (total === null || available === null || swapTotal === null || swapFree === null) return null;
  return {
    ram: { usedBytes: Math.max(0, total - available), totalBytes: total },
    swap: { usedBytes: Math.max(0, swapTotal - swapFree), totalBytes: swapTotal },
  };
}

type StatFs = { type: number; blocks: number; bfree: number; bsize: number };

/** Inside the Docker image `/tmp` is the container's own; the agents fill the
    host's, which PID 1's root shows. */
export function tmpCandidates(env: Readonly<Record<string, string | undefined>> = process.env): { path: string; view: TmpUsage["view"] }[] {
  return env.LLV_DOCKER_NSENTER_SHIMS === "1"
    ? [{ path: "/proc/1/root/tmp", view: "host" }, { path: "/tmp", view: "own" }]
    : [{ path: "/tmp", view: "own" }];
}

export function readMemoryReading(ports: {
  meminfo?: () => string;
  statfs?: (directory: string) => StatFs;
  candidates?: { path: string; view: TmpUsage["view"] }[];
} = {}): MemoryReading | null {
  let parsed: ReturnType<typeof parseMeminfo>;
  try { parsed = parseMeminfo((ports.meminfo ?? (() => fs.readFileSync("/proc/meminfo", "utf8")))()); }
  catch { return null; }
  if (!parsed) return null;
  let tmp: TmpUsage | null = null;
  for (const candidate of ports.candidates ?? tmpCandidates()) {
    try {
      const stat = (ports.statfs ?? (directory => fs.statfsSync(directory)))(candidate.path);
      tmp = { usedBytes: Math.max(0, stat.blocks - stat.bfree) * stat.bsize, totalBytes: stat.blocks * stat.bsize,
        tmpfs: stat.type === TMPFS_MAGIC, view: candidate.view };
      break;
    } catch { /* The next view, or no /tmp reading. */ }
  }
  return { ...parsed, tmp };
}

function swapPercent(reading: MemoryReading): number {
  return reading.swap.totalBytes > 0 ? (100 * reading.swap.usedBytes) / reading.swap.totalBytes : 0;
}

/** Which thresholds the reading is over. An open episode keeps a reason until
    the reading falls below {@link RECOVERY_FACTOR} of its threshold, so a
    value hovering at the line is one warning. */
export function memoryPressureReasons(reading: MemoryReading, thresholds: MemoryThresholds, open = false): MemoryPressureReason[] {
  const factor = open ? RECOVERY_FACTOR : 1;
  const reasons: MemoryPressureReason[] = [];
  if (reading.swap.totalBytes > 0 && swapPercent(reading) > thresholds.swapWarnPercent * factor) reasons.push("swap");
  if (reading.tmp?.tmpfs && reading.tmp.usedBytes > thresholds.tmpWarnBytes * factor) reasons.push("tmp");
  return reasons;
}

export function observeMemoryPressure(reading: MemoryReading, prior: MemoryPressure | null, at: string, thresholds: MemoryThresholds): MemoryPressure {
  const reasons = memoryPressureReasons(reading, thresholds, !!prior?.episode);
  return { ...reading, at, reasons, episode: reasons.length ? prior?.episode ?? at : null, ...thresholds };
}

const REPORT_FILE = () => statePath("memory-pressure-report.json");
const ACTIONS_FILE = () => statePath("memory-pressure-actions.json");

function isMemoryPressure(value: unknown): value is MemoryPressure {
  const row = value as MemoryPressure | null;
  return !!row && typeof row.at === "string" && (row.episode === null || typeof row.episode === "string")
    && Array.isArray(row.reasons) && typeof row.ram?.usedBytes === "number" && typeof row.swap?.usedBytes === "number";
}

export function readMemoryPressureReport(file = REPORT_FILE()): MemoryPressure | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return isMemoryPressure(value) ? value : null;
  } catch { return null; }
}

/** One observation continuing the persisted episode, written back. A write
    that fails (a full disk) still returns the observation. */
export function observeMemoryPressureReport(reading: MemoryReading, at: string, env: Readonly<Record<string, string | undefined>> = process.env, file = REPORT_FILE()): MemoryPressure {
  const pressure = observeMemoryPressure(reading, readMemoryPressureReport(file), at, memoryThresholds(env));
  try { writeJsonDurably(file, pressure); }
  catch (error) { console.warn("[memory pressure] report not written", error instanceof Error ? error.message : String(error)); }
  return pressure;
}

/** What a reader shows: the watch's persisted observation while it is fresh,
    else a reading taken now (never written, so it cannot fork an episode). */
export function currentMemoryPressure(now = Date.now(), env: Readonly<Record<string, string | undefined>> = process.env, read = () => readMemoryReading()): MemoryPressure | null {
  const persisted = readMemoryPressureReport();
  if (persisted && now - Date.parse(persisted.at) < REPORT_FRESH_MS) return persisted;
  const reading = read();
  return reading ? observeMemoryPressure(reading, persisted, new Date(now).toISOString(), memoryThresholds(env)) : persisted;
}

function gib(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(1)} GiB`; }

/** The seat tick's machine line: always present, plain English. */
export function memoryPressureLine(pressure: MemoryPressure): string {
  const tmp = pressure.tmp
    ? `/tmp ${gib(pressure.tmp.usedBytes)}${pressure.tmp.tmpfs ? ` in tmpfs of ${gib(pressure.tmp.totalBytes)}` : " on disk"}`
    : "/tmp unreadable";
  return `Machine memory: RAM ${gib(pressure.ram.usedBytes)} of ${gib(pressure.ram.totalBytes)} used; swap ${gib(pressure.swap.usedBytes)} of ${gib(pressure.swap.totalBytes)}`
    + `${pressure.swap.totalBytes > 0 ? ` (${Math.round(swapPercent(pressure))}%)` : ""}; ${tmp}.`
    + (pressure.episode ? ` Over the warning line (${pressure.reasons.join(", ")}) since ${pressure.episode}.` : "");
}

/** The card and report text; the operator reads it in Ukrainian, like the disk notice. */
export function memoryPressureNoticeText(pressure: MemoryPressure): string {
  const lines = [`Тиск на пам'ять: ОЗП ${gib(pressure.ram.usedBytes)} з ${gib(pressure.ram.totalBytes)}; swap ${gib(pressure.swap.usedBytes)} з ${gib(pressure.swap.totalBytes)}`
    + (pressure.swap.totalBytes > 0 ? ` (${Math.round(swapPercent(pressure))}%)` : "")
    + (pressure.tmp ? `; /tmp ${gib(pressure.tmp.usedBytes)}${pressure.tmp.tmpfs ? " у tmpfs" : " на диску"}` : "") + "."];
  if (pressure.reasons.includes("swap")) lines.push(`Swap зайнятий більше ніж на ${pressure.swapWarnPercent}%.`);
  if (pressure.reasons.includes("tmp")) lines.push(`/tmp у пам'яті займає більше ніж ${(pressure.tmpWarnBytes / 1e9).toFixed(0)} GB.`);
  lines.push("Прибирання тимчасових файлів (/tmp і /var/tmp) запущено одразу; повторно не частіше ніж раз на 15 хв.");
  return lines.join("\n");
}

/** The seat-tick item, once per episode. */
export function memoryPressureSignals(pressure: MemoryPressure | null): { id: string; episode: string; label: string }[] {
  return pressure?.episode ? [{ id: "memory-pressure", episode: pressure.episode, label: `Memory pressure: ${memoryPressureLine(pressure).replace(/^Machine memory: /, "")}` }] : [];
}

type Notice = { episode: string; project: string; card: boolean; report: boolean };
type ActionsState = { lastSweepAt: number; notice: Notice | null };

export type MemoryPressureActions = {
  active: () => boolean;
  project: () => Promise<string | null>;
  card: (project: string, card: SeatTickCard, at: string) => Promise<boolean>;
  report: (project: string, key: string, text: string, at: string) => Promise<boolean>;
  /** Run the temp sweep (owned names and strays) now. */
  sweep: () => void;
};

/** Durable receipts keep overlapping readers and a restarted Viewer from
    repeating the sweep inside its interval, the card or the report. */
export async function reconcileMemoryPressure(pressure: MemoryPressure, ports: MemoryPressureActions, file = ACTIONS_FILE()): Promise<void> {
  await withFileTransactionAsync(file, "memory pressure notices", async () => {
    if (!ports.active()) return;
    let state: ActionsState = { lastSweepAt: 0, notice: null };
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as ActionsState | null;
      if (stored && typeof stored.lastSweepAt === "number") state = { lastSweepAt: stored.lastSweepAt, notice: stored.notice ?? null };
    } catch { /* First observation. */ }
    const persist = () => writeJsonDurably(file, state);
    const prior = state.notice;
    if (prior && prior.episode !== pressure.episode) {
      if (prior.card && !await ports.card(prior.project, { ref: "seat-memory-pressure", kind: "memory-pressure", instance: prior.episode,
        state: "resolved", detail: "Тиск на пам'ять минув." }, pressure.at)) return;
      state.notice = null;
      persist();
    }
    if (!pressure.episode) return;
    const now = Date.parse(pressure.at);
    if (now - state.lastSweepAt >= MEMORY_SWEEP_MIN_INTERVAL_MS) {
      ports.sweep();
      state.lastSweepAt = now;
      persist();
    }
    const project = state.notice?.project ?? await ports.project();
    if (!project) return;
    const notice = state.notice ??= { episode: pressure.episode, project, card: false, report: false };
    const text = memoryPressureNoticeText(pressure);
    if (!notice.card) {
      notice.card = await ports.card(project, { ref: "seat-memory-pressure", kind: "memory-pressure", instance: notice.episode, state: "open", detail: text }, pressure.at);
      persist();
    }
    if (!notice.report) {
      notice.report = await ports.report(project, `memory-pressure:${notice.episode}`, text, pressure.at);
      persist();
    }
  });
}
