import fs from "node:fs";

import { delegatusSetting } from "./cpuPlacement";

/*
 * CPU-pressure admission for heavy work (docs/design/cpu-placement.md).
 *
 * A pipeline stage start, a workflow setup and a release install or build wait
 * while the machine's CPU pressure is high: each is held once `some avg10` reaches the hold threshold and released only
 * after the value has stayed below the release threshold for the release
 * window. Operator sends, receipt reconciliation and recovery never ask.
 * A failed sample admits: the work scopes' CPU quotas still bound the work.
 * `scripts/gate-slot.sh` applies the same policy to gates.
 */

export interface CpuPressurePolicy { holdAt: number; releaseBelow: number; releaseAfterMs: number; deferAfterMs: number }
export const DEFAULT_CPU_PRESSURE_POLICY: CpuPressurePolicy = { holdAt: 20, releaseBelow: 10, releaseAfterMs: 10_000, deferAfterMs: 120_000 };

export type CpuPressureHold = { since: number; avg10: number; deferred: boolean; policy: CpuPressurePolicy };

/** `some avg10` from /proc/pressure/cpu, or null when the text has none. */
export function parseCpuPressure(text: string): number | null {
  const match = /^some\b.*\bavg10=(\d+(?:\.\d+)?)/m.exec(text);
  return match ? Number(match[1]) : null;
}

function threshold(value: string | undefined, fallback: number): number {
  const number = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : fallback;
}

/** Null when the operator turned admission off. */
export function cpuPressurePolicy(env: Readonly<Record<string, string | undefined>> = process.env): CpuPressurePolicy | null {
  if (delegatusSetting(env, "CPU_PRESSURE") === "off") return null;
  const holdAt = threshold(delegatusSetting(env, "CPU_PRESSURE_HOLD"), DEFAULT_CPU_PRESSURE_POLICY.holdAt);
  const releaseBelow = Math.min(holdAt, threshold(delegatusSetting(env, "CPU_PRESSURE_RELEASE"), DEFAULT_CPU_PRESSURE_POLICY.releaseBelow));
  return { ...DEFAULT_CPU_PRESSURE_POLICY, holdAt, releaseBelow };
}

export class CpuPressureGate {
  private held: { since: number; avg10: number } | null = null;
  private belowSince: number | null = null;
  constructor(
    private readonly policy: CpuPressurePolicy,
    private readonly ports: { sample: () => number | null; now: () => number },
  ) {}

  /** Null admits. Each call takes one sample. */
  check(): CpuPressureHold | null {
    const now = this.ports.now();
    let avg10: number | null;
    try { avg10 = this.ports.sample(); } catch { avg10 = null; }
    if (avg10 === null || !Number.isFinite(avg10)) { this.held = null; this.belowSince = null; return null; }
    if (!this.held) {
      if (avg10 < this.policy.holdAt) return null;
      this.held = { since: now, avg10 };
      this.belowSince = null;
    } else if (avg10 < this.policy.releaseBelow) {
      this.belowSince ??= now;
      if (now - this.belowSince >= this.policy.releaseAfterMs) { this.held = null; this.belowSince = null; return null; }
    } else this.belowSince = null;
    return { since: this.held.since, avg10: this.held.avg10, deferred: now - this.held.since >= this.policy.deferAfterMs, policy: this.policy };
  }
}

/** The visible reason for one held start; stable while one hold lasts, so it is not rewritten each tick. */
export function cpuPressureHoldDetail(hold: CpuPressureHold, subject = "stage start"): string {
  const since = new Date(hold.since).toISOString();
  return hold.deferred
    ? `${subject} deferred by CPU pressure: held since ${since} (avg10 ${hold.avg10}% ≥ ${hold.policy.holdAt}%); it starts once pressure stays below ${hold.policy.releaseBelow}% for ${hold.policy.releaseAfterMs / 1000} s`
    : `${subject} held for CPU pressure since ${since} (avg10 ${hold.avg10}% ≥ ${hold.policy.holdAt}%)`;
}
export const CPU_PRESSURE_DETAIL_PREFIXES = ["stage start held for CPU pressure", "stage start deferred by CPU pressure"] as const;
/** Whether `detail` is a reason cpuPressureHoldDetail wrote for `subject`. */
export function isCpuPressureDetail(detail: string | null | undefined, subject: string): boolean {
  return !!detail && (detail.startsWith(`${subject} held for CPU pressure`) || detail.startsWith(`${subject} deferred by CPU pressure`));
}

/**
 * Waits until the gate admits a start that has no tick of its own. Each change
 * of the visible reason is reported once. Answers false when `signal` aborts
 * the wait; the caller then starts nothing.
 */
export async function waitForCpuPressure(gate: Pick<CpuPressureGate, "check"> | null, options: {
  subject: string; onReason: (reason: string) => void; signal?: AbortSignal; pollMs?: number;
}): Promise<boolean> {
  let shown: string | null = null;
  for (;;) {
    if (options.signal?.aborted) return false;
    const hold = gate?.check() ?? null;
    if (!hold) return true;
    const reason = cpuPressureHoldDetail(hold, options.subject);
    if (reason !== shown) { shown = reason; options.onReason(reason); }
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, options.pollMs ?? 2_000);
      options.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

const globalGate = globalThis as unknown as { __llvCpuPressureGate?: CpuPressureGate | null };
/** The process-wide gate over /proc/pressure/cpu; null when turned off. */
export function machineCpuPressureGate(): CpuPressureGate | null {
  if (globalGate.__llvCpuPressureGate !== undefined) return globalGate.__llvCpuPressureGate;
  const policy = cpuPressurePolicy();
  return globalGate.__llvCpuPressureGate = policy && new CpuPressureGate(policy, {
    sample: () => { try { return parseCpuPressure(fs.readFileSync("/proc/pressure/cpu", "utf8")); } catch { return null; } },
    now: Date.now,
  });
}
