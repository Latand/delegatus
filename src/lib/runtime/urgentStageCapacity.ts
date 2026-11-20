import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withoutOperationLease } from "../operationLease";
import { withViewerOperation } from "../viewerLoopMonitor";
import { CPU_STAGE_POLL_MS, type CpuAdmissionQueue, type UrgentStageCapacity } from "./cpuAdmission";
import { AGENT_SLICE, cpuSettings, onlineCpuCount, WORK_SLICE } from "./cpuPlacement";

const sampleWindowMs = 250;
const sampleDeadlineMs = 1_000;

type CpuSample = { at: number; idle: number; total: number; usageUsec: number; throttled: number; quota: number; period: number };

async function readSample(slice: string, signal: AbortSignal): Promise<CpuSample | null> {
  const options = { encoding: "utf8", signal } as const;
  const [host, work, limit] = await Promise.all([
    readFile("/proc/stat", options), readFile(path.join(slice, "cpu.stat"), options), readFile(path.join(slice, "cpu.max"), options),
  ]);
  const hostFields = /^cpu\s+([^\n]+)/.exec(host)?.[1]?.trim().split(/\s+/).slice(0, 8).map(Number);
  const usageUsec = Number(/^usage_usec (\d+)$/m.exec(work)?.[1]);
  const throttled = Number(/^nr_throttled (\d+)$/m.exec(work)?.[1]);
  const [quota, period] = limit.trim().split(/\s+/).map(Number);
  if (!hostFields || hostFields.length !== 8 || !hostFields.every(n => Number.isSafeInteger(n) && n >= 0)
    || !Number.isSafeInteger(usageUsec) || !Number.isSafeInteger(throttled)
    || !quota || !period || quota < 0 || period < 0 || !Number.isSafeInteger(quota) || !Number.isSafeInteger(period)) return null;
  return { at: performance.now(), idle: hostFields[3]!, total: hostFields.reduce((sum, value) => sum + value, 0),
    usageUsec, throttled, quota, period };
}

export function hasStartupCpuHeadroom(before: CpuSample, after: CpuSample, cpus: number, required: number): boolean {
  if (before.quota !== after.quota || before.period !== after.period || before.throttled !== after.throttled) return false;
  const elapsedUsec = (after.at - before.at) * 1_000;
  const used = after.usageUsec - before.usageUsec;
  const hostElapsed = after.total - before.total;
  const idle = after.idle - before.idle;
  if (elapsedUsec <= 0 || used < 0 || hostElapsed <= 0 || idle < 0 || idle > hostElapsed) return false;
  const workSpare = after.quota / after.period - used / elapsedUsec;
  const hostSpare = cpus * idle / hostElapsed;
  return Math.min(workSpare, hostSpare) * 100 >= required;
}

async function measureSpareCpu(slice: string, cpus: number, required: number): Promise<boolean> {
  const deadline = performance.now() + sampleDeadlineMs;
  const signal = AbortSignal.timeout(sampleDeadlineMs);
  const before = await readSample(slice, signal);
  if (!before) return false;
  await delay(sampleWindowMs, undefined, { signal, ref: false });
  const after = await readSample(slice, signal);
  return after !== null && performance.now() <= deadline && hasStartupCpuHeadroom(before, after, cpus, required);
}

export type UrgentStagePoll = {
  currentRevision(): string | null;
  makeDue(revision: string, expiresAt: number): Promise<string | null>;
  wake(): void;
};

const measureMachineHeadroom = async () => {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) return false;
  const cpus = onlineCpuCount();
  const settings = cpuSettings(process.env, cpus);
  if (settings.mode === "off") return false;
  const slice = path.join("/sys/fs/cgroup/user.slice", `user-${uid}.slice`, `user@${uid}.service`,
    "delegatus.slice", AGENT_SLICE, WORK_SLICE);
  return measureSpareCpu(slice, cpus, settings.scopeQuotaPercent);
};

/** One on-demand sample for the machine. Its completion returns through the
 * owning stage's normal controller poll, with the same ticket and revision. */
export function urgentStageCapacitySampler(measure = measureMachineHeadroom, now = Date.now) {
  let cached: { queue: CpuAdmissionQueue; sample: UrgentStageCapacity } | undefined;
  let pending: { queue: CpuAdmissionQueue; key: string; revision: string; work: Promise<void> } | undefined;
  const latest = (queue: CpuAdmissionQueue, key: string): UrgentStageCapacity | undefined => {
    if (cached?.queue !== queue || cached.sample.key !== key || now() - cached.sample.sampledAt > CPU_STAGE_POLL_MS) return undefined;
    return cached.sample;
  };
  return { latest, refresh(queue: CpuAdmissionQueue, key: string, poll: UrgentStagePoll): Promise<void> | undefined {
    const revision = poll.currentRevision();
    if (revision === null) return;
    if (pending) return pending.queue === queue && pending.key === key && pending.revision === revision ? pending.work : undefined;
    const lastBeforeProbe = queue.lastAdmission();
    if (cached?.queue === queue && cached.sample.key === key && cached.sample.revision === revision
      && cached.sample.lastBeforeProbe === lastBeforeProbe && now() - cached.sample.sampledAt < sampleDeadlineMs) return;
    const work = withoutOperationLease(async () => {
      const hasCapacity = await withViewerOperation("pipelines.startup-admission", measure).catch(() => false);
      const sampledAt = now();
      if (poll.currentRevision() !== revision || queue.lastAdmission() !== lastBeforeProbe) return;
      if (!hasCapacity) {
        cached = { queue, sample: { key, revision, sampledAt, lastBeforeProbe, hasCapacity } };
        return;
      }
      const expiresAt = sampledAt + CPU_STAGE_POLL_MS;
      const dueRevision = await poll.makeDue(revision, expiresAt);
      if (dueRevision === null) return;
      if (poll.currentRevision() === dueRevision && queue.lastAdmission() === lastBeforeProbe && now() <= expiresAt) {
        cached = { queue, sample: { key, revision: dueRevision, sampledAt, lastBeforeProbe, hasCapacity } };
      }
      poll.wake();
    }).finally(() => { pending = undefined; });
    pending = { queue, key, revision, work };
    return work;
  } };
}
