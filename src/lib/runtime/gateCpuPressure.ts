import fs from "node:fs/promises";
import os from "node:os";
import { CpuPressureGate, parseCpuPressure, type CpuPressurePolicy } from "./cpuPressure";

/** Load fallback for systems without a readable PSI CPU metric. */
export const GATE_LOAD_PER_CPU_LIMIT = 0.75;

export class GateCpuPressure {
  private readonly pressure: CpuPressureGate | null;
  private sample: number | null = null;
  constructor(private readonly policy: CpuPressurePolicy | null, private readonly ports = {
    now: Date.now,
    pressure: async (): Promise<number | null> => {
      try { return parseCpuPressure(await fs.readFile(process.env.LLV_GATE_PSI_FILE ?? "/proc/pressure/cpu", "utf8")); }
      catch { return null; }
    },
    loadPerCpu: () => os.loadavg()[0] / Math.max(1, os.cpus().length),
  }) {
    this.pressure = policy ? new CpuPressureGate(policy, { now: ports.now, sample: () => this.sample }) : null;
  }

  /** One stable reason per hold; sampling and callers' polling yield the loop. */
  async check(): Promise<string | null> {
    if (!this.policy) return null;
    try { this.sample = await this.ports.pressure(); } catch { this.sample = null; }
    const hold = this.pressure!.check();
    if (this.sample !== null && Number.isFinite(this.sample)) {
      return hold ? `Waiting for measured CPU pressure to stay below ${this.policy.releaseBelow}% for ${this.policy.releaseAfterMs / 1000} s` : null;
    }
    let load: number;
    try { load = this.ports.loadPerCpu(); } catch { load = NaN; }
    if (!Number.isFinite(load) || load < 0) return "Waiting for a readable CPU pressure or load sample";
    return load >= GATE_LOAD_PER_CPU_LIMIT ? `Waiting for measured CPU load below ${GATE_LOAD_PER_CPU_LIMIT} per CPU` : null;
  }
}
