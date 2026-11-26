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
 *
 * The `/tmp` that counts is the machine's. Inside the Docker image the
 * process's own `/tmp` is the container's, so only the watch's helper, which
 * reaches the host view (`hostTmpUsage.ts`), reports it there.
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
/** An observation older than this is read again rather than shown. */
const REPORT_FRESH_MS = 2 * 60_000;

export type MemoryUsage = { usedBytes: number; totalBytes: number };
/** The machine's `/tmp`: `own` where this process shares it, `host` where it was read through a host view. */
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

export type StatFs = { type: number; blocks: number; bfree: number; bsize: number };

export function tmpUsage(stat: StatFs, view: TmpUsage["view"]): TmpUsage {
  return { usedBytes: Math.max(0, stat.blocks - stat.bfree) * stat.bsize, totalBytes: stat.blocks * stat.bsize,
    tmpfs: stat.type === TMPFS_MAGIC, view };
}

/** What this process can read by itself, without waiting on anything. Inside
    the Docker image its `/tmp` is the container's, which is never reported as
    the machine's: the reading carries no `/tmp` there. */
export function readMemoryReading(ports: {
  env?: Readonly<Record<string, string | undefined>>;
  meminfo?: () => string;
  statfs?: (directory: string) => StatFs;
} = {}): MemoryReading | null {
  let parsed: ReturnType<typeof parseMeminfo>;
  try { parsed = parseMeminfo((ports.meminfo ?? (() => fs.readFileSync("/proc/meminfo", "utf8")))()); }
  catch { return null; }
  if (!parsed) return null;
  let tmp: TmpUsage | null = null;
  if ((ports.env ?? process.env).LLV_DOCKER_NSENTER_SHIMS !== "1") {
    try { tmp = tmpUsage((ports.statfs ?? (directory => fs.statfsSync(directory)))("/tmp"), "own"); }
    catch { /* No /tmp reading. */ }
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
  // A `/tmp` that cannot be read proves nothing about its recovery.
  if (!reading.tmp && prior?.episode && prior.reasons.includes("tmp")) reasons.push("tmp");
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

type Held = { pressure: MemoryPressure; unwritten: boolean };
const shared = globalThis as typeof globalThis & { __delegatusMemoryPressure?: Map<string, Held> };
/** The watch's latest observation, by report file, for every reader in this process. */
const held = () => shared.__delegatusMemoryPressure ??= new Map<string, Held>();

const episodeKey = (pressure: MemoryPressure | null) => pressure?.episode ? `${pressure.episode} ${pressure.reasons.join(",")}` : "";

/** One observation continuing the episode. The file is written, durably, only
    when the episode or its reasons change, so a calm machine's 30 s beat
    writes nothing; the readings themselves stay in memory. A write that fails
    (a full disk) keeps the observation and is retried on the next one. */
export function observeMemoryPressureReport(reading: MemoryReading, at: string, env: Readonly<Record<string, string | undefined>> = process.env, file = REPORT_FILE()): MemoryPressure {
  const persisted = readMemoryPressureReport(file);
  const last = held().get(file);
  const pressure = observeMemoryPressure(reading, last?.unwritten ? last.pressure : persisted, at, memoryThresholds(env));
  let unwritten = false;
  if (episodeKey(pressure) !== episodeKey(persisted)) {
    try { writeJsonDurably(file, pressure); }
    catch (error) {
      unwritten = true;
      console.warn("[memory pressure] report not written", error instanceof Error ? error.message : String(error));
    }
  }
  held().set(file, { pressure, unwritten });
  return pressure;
}

/** What a reader shows: the watch's observation while it is fresh, else a
    reading this process takes now (never written, so it cannot fork an
    episode), continuing the last known episode. */
export function currentMemoryPressure(now = Date.now(), env: Readonly<Record<string, string | undefined>> = process.env,
  read = () => readMemoryReading({ env }), file = REPORT_FILE()): MemoryPressure | null {
  const fresh = (pressure: MemoryPressure | null | undefined) => !!pressure && now - Date.parse(pressure.at) < REPORT_FRESH_MS;
  const observed = held().get(file)?.pressure;
  if (fresh(observed)) return observed!;
  const persisted = readMemoryPressureReport(file);
  if (fresh(persisted)) return persisted;
  const reading = read();
  return reading ? observeMemoryPressure(reading, observed ?? persisted, new Date(now).toISOString(), memoryThresholds(env)) : persisted;
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

function readActionsState(file: string): ActionsState {
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as ActionsState | null;
    if (stored && typeof stored.lastSweepAt === "number") return { lastSweepAt: stored.lastSweepAt, notice: stored.notice ?? null };
  } catch { /* First observation. */ }
  return { lastSweepAt: 0, notice: null };
}

/** Durable receipts keep overlapping readers and a restarted Viewer from
    repeating the sweep inside its interval, the card or the report. A calm
    observation with no notice open takes no lock and writes nothing. */
export async function reconcileMemoryPressure(pressure: MemoryPressure, ports: MemoryPressureActions, file = ACTIONS_FILE()): Promise<void> {
  if (!pressure.episode && !readActionsState(file).notice) return;
  await withFileTransactionAsync(file, "memory pressure notices", async () => {
    if (!ports.active()) return;
    const state = readActionsState(file);
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
