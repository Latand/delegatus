import { randomUUID } from "node:crypto";

export const SEAT_TICK_TIMING_LIMIT = 512;
export interface SeatTickPhaseTiming {
  phase: string;
  beginMs: number;
  endMs: number;
  /** Viewer process CPU, including other work while this phase awaited I/O. */
  cpuUs: number;
  /** The phase was still pending when this journal line was captured. */
  pending?: true;
}
export interface SeatTickTiming {
  checkId: string;
  startedAt: string;
  elapsedMs: number;
  cpuUs: number;
  dropped: number;
  phases: SeatTickPhaseTiming[];
}
const milliseconds = (value: number) => Math.round(value * 1000) / 1000;

/** Intern names within one record; repeated registry/guard phases then cost
 * four numbers each on disk. The public reader expands them again. */
export function compactSeatTickTiming(timing: SeatTickTiming) {
  const names: string[] = [], ids = new Map<string, number>();
  const phases = timing.phases.map(row => {
    let id = ids.get(row.phase);
    if (id === undefined) { id = names.length; names.push(row.phase); ids.set(row.phase, id); }
    return [id, row.beginMs, row.endMs, row.cpuUs, ...(row.pending ? [1] : [])];
  });
  return { ...timing, names, phases };
}

/** Small numeric spans only; no payloads, extra writes or per-phase timers. */
export class SeatTickTimings {
  private readonly checkId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly started: number;
  private readonly cpu;
  private readonly spans: { row: SeatTickPhaseTiming; cpu: NodeJS.CpuUsage; open: boolean }[] = [];
  private dropped = 0;
  constructor(private readonly clock = () => performance.now(), private readonly usage = () => process.cpuUsage()) {
    this.started = clock();
    this.cpu = usage();
  }
  begin(phase: string): () => void {
    if (this.spans.length >= SEAT_TICK_TIMING_LIMIT) { this.dropped++; return () => {}; }
    const span = { row: { phase, beginMs: milliseconds(this.clock() - this.started), endMs: 0, cpuUs: 0 }, cpu: this.usage(), open: true };
    this.spans.push(span);
    return () => {
      if (!span.open) return;
      span.open = false;
      span.row.endMs = Math.max(span.row.beginMs, milliseconds(this.clock() - this.started));
      const cpu = this.usage();
      span.row.cpuUs = Math.max(0, cpu.user + cpu.system - span.cpu.user - span.cpu.system);
    };
  }
  snapshot(): SeatTickTiming {
    const elapsedMs = milliseconds(Math.max(0, this.clock() - this.started)), cpu = this.usage();
    return { checkId: this.checkId, startedAt: this.startedAt, elapsedMs,
      cpuUs: Math.max(0, cpu.user + cpu.system - this.cpu.user - this.cpu.system), dropped: this.dropped,
      phases: this.spans.map(({ row, open, cpu: start }) => open
        ? { ...row, endMs: Math.max(row.beginMs, elapsedMs), cpuUs: Math.max(0, cpu.user + cpu.system - start.user - start.system), pending: true }
        : { ...row }) };
  }
}

/** The journal reader preserves old rows and bounds untrusted new fields. */
export function sanitizeSeatTickTiming(value: unknown): SeatTickTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (typeof raw.checkId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(raw.checkId)
    || typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))
    || !finite(raw.elapsedMs) || !finite(raw.cpuUs) || !finite(raw.dropped) || !Array.isArray(raw.phases)) return undefined;
  const phases: SeatTickPhaseTiming[] = [];
  for (const stored of raw.phases.slice(0, SEAT_TICK_TIMING_LIMIT)) {
    const row = Array.isArray(stored) && Array.isArray(raw.names)
      ? { phase: Number.isSafeInteger(stored[0]) && stored[0] >= 0 ? raw.names[stored[0]] : undefined,
        beginMs: stored[1], endMs: stored[2], cpuUs: stored[3], pending: stored[4] === 1 }
      : stored;
    if (!row || typeof row !== "object") continue;
    const phase = row as Record<string, unknown>;
    if (typeof phase.phase !== "string" || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(phase.phase)
      || !finite(phase.beginMs) || !finite(phase.endMs) || phase.endMs < phase.beginMs || !finite(phase.cpuUs)) continue;
    phases.push({ phase: phase.phase, beginMs: phase.beginMs, endMs: phase.endMs, cpuUs: phase.cpuUs, ...(phase.pending === true ? { pending: true as const } : {}) });
  }
  return { checkId: raw.checkId, startedAt: raw.startedAt.slice(0, 40), elapsedMs: raw.elapsedMs, cpuUs: raw.cpuUs,
    dropped: raw.dropped + Math.max(0, raw.phases.length - SEAT_TICK_TIMING_LIMIT), phases };
}
