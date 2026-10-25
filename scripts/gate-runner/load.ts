// Routing is advisory: only gate-slot.sh can admit and start local work.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { CPU_QUEUE_SPACING_MS, cpuAdmissionFile } from "../../src/lib/runtime/cpuAdmission";
import { cpuPressurePolicy, parseCpuPressure } from "../../src/lib/runtime/cpuPressure";
import type { Env } from "./client";

export const REMOTE_LOAD_PER_CPU = 1.5;
export const LOCAL_LOAD_PER_CPU = 0.75;
export const LOAD_PROBE = `printf 'load=%s\\n' "$(cut -d ' ' -f1 /proc/loadavg)"; printf 'cpus=%s\\n' "$(getconf _NPROCESSORS_ONLN)"`;
export interface Load { load: number; cpus: number }
export interface LocalAdmission extends Load { pressureReady: boolean; queueReady: boolean; slotReady: boolean }

export function parseLoad(output: string): Load | null {
  const load = /^load=(\d+(?:\.\d+)?)$/m.exec(output);
  const cpus = /^cpus=([1-9]\d*)$/m.exec(output);
  if (!load || !cpus) return null;
  const sample = { load: Number(load[1]), cpus: Number(cpus[1]) };
  return Number.isFinite(sample.load) && Number.isSafeInteger(sample.cpus) ? sample : null;
}

/** Unknown signals keep the usual remote route. Sample local state only when needed. */
export function saturationReason(remote: Load | null, local: () => LocalAdmission | null): string | null {
  if (!remote || remote.load < remote.cpus * REMOTE_LOAD_PER_CPU) return null;
  const here = local();
  if (!here || !Number.isFinite(here.load) || here.load < 0 || !Number.isSafeInteger(here.cpus) || here.cpus < 1
    || here.load >= here.cpus * LOCAL_LOAD_PER_CPU || !here.pressureReady || !here.queueReady || !here.slotReady) return null;
  return `the runner is saturated (load ${remote.load} on ${remote.cpus} CPUs); local admission has headroom (load ${here.load} on ${here.cpus} CPUs)`;
}

/** Read without creating tickets, clearing stale owners, or consuming admission. */
export function queueReady(file: string, now: number): boolean {
  try { fs.statSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const db = new Database(file, { readonly: true });
  try {
    const waiting = db.query<{ count: number }, []>("SELECT count(*) AS count FROM tickets WHERE key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)").get();
    const last = db.query<{ last: number | null }, []>("SELECT last FROM admission WHERE id = 1").get();
    return waiting?.count === 0 && !!last && (last.last === null || now - last.last >= CPU_QUEUE_SPACING_MS);
  } finally { db.close(); }
}

export function localAdmission(env: Env): LocalAdmission | null {
  try {
    const policy = cpuPressurePolicy(env);
    const pressure = policy ? parseCpuPressure(fs.readFileSync(env.LLV_GATE_PSI_FILE ?? "/proc/pressure/cpu", "utf8")) : null;
    // Match the wrapper's shell defaults and integer validation.
    const slotSetting = env.LLV_GATE_SLOTS || "6";
    if (!/^[1-9]\d*$/.test(slotSetting) || slotSetting.trim() !== slotSetting) return null;
    const slots = Number(slotSetting);
    if (!Number.isSafeInteger(slots) || slots < 1) return null;
    const dir = env.LLV_GATE_LOCK_DIR || "/var/tmp";
    // Missing flock or inaccessible locks are unknown, never proof of room.
    let slotReady = false;
    for (let i = 1; i <= slots; i++) {
      if (spawnSync("flock", ["-n", path.join(dir, `llv-heavy-gate.slot${i}.lock`), "true"], { stdio: "ignore", timeout: 1000 }).status === 0) { slotReady = true; break; }
    }
    return {
      load: os.loadavg()[0]!, cpus: os.cpus().length,
      pressureReady: !policy || (pressure !== null && pressure < policy.releaseBelow),
      queueReady: queueReady(cpuAdmissionFile(), Date.now()), slotReady,
    };
  } catch { return null; }
}
