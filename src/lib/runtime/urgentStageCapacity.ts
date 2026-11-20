import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withoutOperationLease } from "../operationLease";
import { withViewerOperation } from "../viewerLoopMonitor";
import { CPU_STAGE_POLL_MS, type CpuAdmissionQueue, type UrgentStageCapacity } from "./cpuAdmission";
import { AGENT_SLICE, cpuSettings, onlineCpuCount, WORK_SLICE } from "./cpuPlacement";

const sampleWindowMs = 250;
const sampleDeadlineMs = 1_000;
const EVIDENCE_RING_LIMIT = 64;
const LOG_REPEAT_INTERVAL_MS = 30_000;

export type CpuSample = { at: number; idle: number; total: number; usageUsec: number; throttled: number; quota: number; period: number };

export type UrgentCapacityProbeReason =
  | "ok"
  | "host-exhausted"
  | "work-slice-exhausted"
  | "both-exhausted"
  | "exhausted"
  | "throttled"
  | "quota-changed"
  | "invalid-sample"
  | "deadline-missed"
  | "probe-error"
  | "unavailable";

export type UrgentCapacityMeasurement = {
  hasCapacity: boolean;
  reason: UrgentCapacityProbeReason;
  hostSpareCores: number | null;
  workSpareCores: number | null;
  requiredCores: number | null;
  throttledDelta: number | null;
  sampleElapsedMs: number | null;
  probeElapsedMs: number | null;
};

export type UrgentCapacityDisposition =
  | "woke-eligible"
  | "held-no-capacity"
  | "discarded-revision-changed"
  | "discarded-admission-changed"
  | "discarded-make-due-refused"
  | "discarded-changed-after-due"
  | "discarded-expired";

export type UrgentCapacityEvidence = {
  at: number;
  key: string;
  revision: string;
  dueRevision: string | null;
  lastBeforeProbe: number | null;
  lastAfterProbe: number | null;
  disposition: UrgentCapacityDisposition;
  probeReason: UrgentCapacityProbeReason;
  hasCapacity: boolean;
  hostSpareCores: number | null;
  workSpareCores: number | null;
  requiredCores: number | null;
  throttledDelta: number | null;
  sampleElapsedMs: number | null;
  probeElapsedMs: number | null;
  sampleAgeMs: number;
  expiresAt: number | null;
};

const roundCores = (value: number): number => Math.round(value * 1_000) / 1_000;

const emptyMeasurement = (
  reason: UrgentCapacityProbeReason,
  required: number | null = null,
  probeElapsedMs: number | null = null,
): UrgentCapacityMeasurement => ({
  hasCapacity: false,
  reason,
  hostSpareCores: null,
  workSpareCores: null,
  requiredCores: required === null ? null : roundCores(required / 100),
  throttledDelta: null,
  sampleElapsedMs: null,
  probeElapsedMs: probeElapsedMs === null ? null : Math.max(0, Math.round(probeElapsedMs)),
});

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

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

/** Evaluates host spare CPU, work-slice quota headroom, throttling and deadline
 * bounds without changing the admission rule. */
export function evaluateStartupCpuHeadroom(
  before: CpuSample,
  after: CpuSample,
  cpus: number,
  required: number,
  probeElapsedMs: number | null = null,
): UrgentCapacityMeasurement {
  const requiredCores = roundCores(required / 100);
  const sampleElapsedMs = Number.isFinite(after.at - before.at) && after.at >= before.at ? Math.round(after.at - before.at) : null;
  const elapsedMs = probeElapsedMs === null ? null : Math.max(0, Math.round(probeElapsedMs));
  const throttledDelta = after.throttled - before.throttled;
  if (before.quota !== after.quota || before.period !== after.period) {
    return {
      hasCapacity: false, reason: "quota-changed", hostSpareCores: null, workSpareCores: null,
      requiredCores, throttledDelta, sampleElapsedMs, probeElapsedMs: elapsedMs,
    };
  }
  const elapsedUsec = (after.at - before.at) * 1_000;
  const used = after.usageUsec - before.usageUsec;
  const hostElapsed = after.total - before.total;
  const idle = after.idle - before.idle;
  if (elapsedUsec <= 0 || used < 0 || hostElapsed <= 0 || idle < 0 || idle > hostElapsed) {
    return {
      hasCapacity: false, reason: "invalid-sample", hostSpareCores: null, workSpareCores: null,
      requiredCores, throttledDelta, sampleElapsedMs, probeElapsedMs: elapsedMs,
    };
  }
  const workSpare = after.quota / after.period - used / elapsedUsec;
  const hostSpare = cpus * idle / hostElapsed;
  const workSpareCores = roundCores(workSpare);
  const hostSpareCores = roundCores(hostSpare);
  if (throttledDelta !== 0) {
    return {
      hasCapacity: false, reason: "throttled", hostSpareCores, workSpareCores,
      requiredCores, throttledDelta, sampleElapsedMs, probeElapsedMs: elapsedMs,
    };
  }
  if (probeElapsedMs !== null && probeElapsedMs > sampleDeadlineMs) {
    return {
      hasCapacity: false, reason: "deadline-missed", hostSpareCores, workSpareCores,
      requiredCores, throttledDelta, sampleElapsedMs, probeElapsedMs: elapsedMs,
    };
  }
  const hostOk = hostSpare * 100 >= required;
  const workOk = workSpare * 100 >= required;
  const reason: UrgentCapacityProbeReason = hostOk && workOk
    ? "ok"
    : !hostOk && !workOk
      ? "both-exhausted"
      : !hostOk
        ? "host-exhausted"
        : "work-slice-exhausted";
  return {
    hasCapacity: hostOk && workOk,
    reason,
    hostSpareCores,
    workSpareCores,
    requiredCores,
    throttledDelta,
    sampleElapsedMs,
    probeElapsedMs: elapsedMs,
  };
}

export function hasStartupCpuHeadroom(before: CpuSample, after: CpuSample, cpus: number, required: number): boolean {
  return evaluateStartupCpuHeadroom(before, after, cpus, required).hasCapacity;
}

async function measureSpareCpu(slice: string, cpus: number, required: number): Promise<UrgentCapacityMeasurement> {
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(sampleDeadlineMs);
  try {
    const before = await readSample(slice, signal);
    if (!before) return emptyMeasurement("invalid-sample", required, performance.now() - startedAt);
    await delay(sampleWindowMs, undefined, { signal, ref: false });
    const after = await readSample(slice, signal);
    const probeElapsedMs = performance.now() - startedAt;
    if (!after) return emptyMeasurement("invalid-sample", required, probeElapsedMs);
    return evaluateStartupCpuHeadroom(before, after, cpus, required, probeElapsedMs);
  } catch (error) {
    const probeElapsedMs = performance.now() - startedAt;
    return emptyMeasurement(isAbortError(error) || probeElapsedMs > sampleDeadlineMs ? "deadline-missed" : "probe-error", required, probeElapsedMs);
  }
}

export type UrgentStagePoll = {
  currentRevision(): string | null;
  makeDue(revision: string, expiresAt: number): Promise<string | null>;
  wake(): void;
};

const measureMachineHeadroom = async (): Promise<UrgentCapacityMeasurement> => {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) return emptyMeasurement("unavailable");
  const cpus = onlineCpuCount();
  const settings = cpuSettings(process.env, cpus);
  if (settings.mode === "off") return emptyMeasurement("unavailable");
  const slice = path.join("/sys/fs/cgroup/user.slice", `user-${uid}.slice`, `user@${uid}.service`,
    "delegatus.slice", AGENT_SLICE, WORK_SLICE);
  return measureSpareCpu(slice, cpus, settings.scopeQuotaPercent);
};

const globalEvidenceSymbol = Symbol.for("delegatus.urgentStageCapacity.evidence");
const globalEvidenceHost = globalThis as typeof globalThis & { [globalEvidenceSymbol]?: UrgentCapacityEvidence[] };

function pushBounded(ring: UrgentCapacityEvidence[], entry: UrgentCapacityEvidence): void {
  ring.push(entry);
  if (ring.length > EVIDENCE_RING_LIMIT) ring.splice(0, ring.length - EVIDENCE_RING_LIMIT);
}

/** Bounded process-wide ring of recent urgent-capacity sampler observations (#4224). */
export function recentUrgentStageCapacityEvidence(): readonly UrgentCapacityEvidence[] {
  return [...(globalEvidenceHost[globalEvidenceSymbol] ?? [])];
}

function normalizeMeasurement(result: boolean | UrgentCapacityMeasurement): UrgentCapacityMeasurement {
  if (typeof result !== "boolean") return result;
  return {
    hasCapacity: result,
    reason: result ? "ok" : "exhausted",
    hostSpareCores: null,
    workSpareCores: null,
    requiredCores: null,
    throttledDelta: null,
    sampleElapsedMs: null,
    probeElapsedMs: null,
  };
}

function stageLabelFromKey(key: string): string {
  const parts = key.split(":");
  return parts.length > 2 && parts[0] === "stage" ? parts.slice(2).join(":") : key;
}

const defaultEvidenceLog = (line: string) => console.warn(line);

export type UrgentStageCapacitySamplerOptions = {
  log?: ((line: string) => void) | null;
};

/** One on-demand sample for the machine. Its completion returns through the
 * owning stage's normal controller poll, with the same ticket and revision. */
export function urgentStageCapacitySampler(
  measure: () => Promise<boolean | UrgentCapacityMeasurement> = measureMachineHeadroom,
  now = Date.now,
  options: UrgentStageCapacitySamplerOptions = {},
) {
  let cached: { queue: CpuAdmissionQueue; sample: UrgentStageCapacity } | undefined;
  let pending: { queue: CpuAdmissionQueue; key: string; revision: string; work: Promise<void> } | undefined;
  const ring: UrgentCapacityEvidence[] = [];
  const lastLogged = new Map<string, { at: number; signature: string }>();
  const log = options.log === undefined ? defaultEvidenceLog : options.log;
  const record = (entry: UrgentCapacityEvidence): void => {
    Object.freeze(entry);
    pushBounded(ring, entry);
    const shared = globalEvidenceHost[globalEvidenceSymbol] ??= [];
    pushBounded(shared, entry);
    if (!log) return;
    const signature = `${entry.disposition}:${entry.probeReason}`;
    const previous = lastLogged.get(entry.key);
    const shouldLog = entry.disposition === "woke-eligible"
      || !previous
      || previous.signature !== signature
      || entry.at - previous.at >= LOG_REPEAT_INTERVAL_MS;
    if (!shouldLog) return;
    lastLogged.set(entry.key, { at: entry.at, signature });
    while (lastLogged.size > EVIDENCE_RING_LIMIT) lastLogged.delete(lastLogged.keys().next().value!);
    log(`[cpu-admission] urgent-capacity ${JSON.stringify({
      stage: stageLabelFromKey(entry.key),
      disposition: entry.disposition,
      probeReason: entry.probeReason,
      hasCapacity: entry.hasCapacity,
      hostSpareCores: entry.hostSpareCores,
      workSpareCores: entry.workSpareCores,
      requiredCores: entry.requiredCores,
      throttledDelta: entry.throttledDelta,
      sampleElapsedMs: entry.sampleElapsedMs,
      probeElapsedMs: entry.probeElapsedMs,
      sampleAgeMs: entry.sampleAgeMs,
      revision: entry.revision.slice(0, 64),
      dueRevision: entry.dueRevision?.slice(0, 64) ?? null,
    })}`);
  };
  const latest = (queue: CpuAdmissionQueue, key: string): UrgentStageCapacity | undefined => {
    if (cached?.queue !== queue || cached.sample.key !== key || now() - cached.sample.sampledAt > CPU_STAGE_POLL_MS) return undefined;
    return cached.sample;
  };
  return {
    latest,
    recentEvidence: (): readonly UrgentCapacityEvidence[] => [...ring],
    refresh(queue: CpuAdmissionQueue, key: string, poll: UrgentStagePoll): Promise<void> | undefined {
      const revision = poll.currentRevision();
      if (revision === null) return;
      if (pending) return pending.queue === queue && pending.key === key && pending.revision === revision ? pending.work : undefined;
      const lastBeforeProbe = queue.lastAdmission();
      if (cached?.queue === queue && cached.sample.key === key && cached.sample.revision === revision
        && cached.sample.lastBeforeProbe === lastBeforeProbe && now() - cached.sample.sampledAt < sampleDeadlineMs) return;
      const work = withoutOperationLease(async () => {
        const measurement = await withViewerOperation("pipelines.startup-admission", measure)
          .then(normalizeMeasurement)
          .catch(() => emptyMeasurement("probe-error"));
        const sampledAt = now();
        const afterRevision = poll.currentRevision();
        const lastAfterProbe = queue.lastAdmission();
        const base = {
          key,
          revision,
          lastBeforeProbe,
          lastAfterProbe,
          probeReason: measurement.reason,
          hasCapacity: measurement.hasCapacity,
          hostSpareCores: measurement.hostSpareCores,
          workSpareCores: measurement.workSpareCores,
          requiredCores: measurement.requiredCores,
          throttledDelta: measurement.throttledDelta,
          sampleElapsedMs: measurement.sampleElapsedMs,
          probeElapsedMs: measurement.probeElapsedMs,
        };
        if (afterRevision !== revision) {
          record({ ...base, at: sampledAt, dueRevision: null, disposition: "discarded-revision-changed", sampleAgeMs: 0, expiresAt: null });
          return;
        }
        if (lastAfterProbe !== lastBeforeProbe) {
          record({ ...base, at: sampledAt, dueRevision: null, disposition: "discarded-admission-changed", sampleAgeMs: 0, expiresAt: null });
          return;
        }
        if (!measurement.hasCapacity) {
          cached = { queue, sample: { key, revision, sampledAt, lastBeforeProbe, hasCapacity: false } };
          record({ ...base, at: sampledAt, dueRevision: null, disposition: "held-no-capacity", sampleAgeMs: 0, expiresAt: null });
          return;
        }
        const expiresAt = sampledAt + CPU_STAGE_POLL_MS;
        const dueRevision = await poll.makeDue(revision, expiresAt);
        const currentAtWake = dueRevision === null ? null : poll.currentRevision();
        const lastAtWake = queue.lastAdmission();
        const wakeAt = now();
        const sampleAgeMs = Math.max(0, wakeAt - sampledAt);
        if (dueRevision === null) {
          record({ ...base, at: wakeAt, lastAfterProbe: lastAtWake, dueRevision: null, disposition: "discarded-make-due-refused", sampleAgeMs, expiresAt });
          return;
        }
        if (currentAtWake !== dueRevision || lastAtWake !== lastBeforeProbe) {
          record({ ...base, at: wakeAt, lastAfterProbe: lastAtWake, dueRevision, disposition: "discarded-changed-after-due", sampleAgeMs, expiresAt });
          poll.wake();
          return;
        }
        if (wakeAt > expiresAt) {
          record({ ...base, at: wakeAt, lastAfterProbe: lastAtWake, dueRevision, disposition: "discarded-expired", sampleAgeMs, expiresAt });
          poll.wake();
          return;
        }
        cached = { queue, sample: { key, revision: dueRevision, sampledAt, lastBeforeProbe, hasCapacity: true } };
        record({ ...base, at: wakeAt, lastAfterProbe: lastAtWake, dueRevision, disposition: "woke-eligible", sampleAgeMs, expiresAt });
        poll.wake();
      }).finally(() => { pending = undefined; });
      pending = { queue, key, revision, work };
      return work;
    },
  };
}
