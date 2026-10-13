import { canonicalProject } from "@/lib/projects/aliases";
import { projectWorkerCounts } from "@/lib/orchestrator/workerCount";
import { effectiveWorkerLimit, projectWorkerLimit, readWorkerLimits, WORKER_LIMIT_DEFAULT, WORKER_LIMIT_MIN, WORKER_LIMIT_MAX, type WorkerLimitSource } from "./workerLimit";

export interface WorkerReading { running: number; runningMachine: number; limit: number; source: WorkerLimitSource; machine: number }
export function workerReading(project: string): WorkerReading {
  const counts = projectWorkerCounts();
  const limit = effectiveWorkerLimit(project);
  return { running: counts.byProject.get(canonicalProject(project)) ?? 0, runningMachine: counts.machine, limit: limit.value, source: limit.source, machine: limit.machine };
}
export function workerLimitAnswer(project: string | null) {
  const stored = readWorkerLimits();
  const counts = projectWorkerCounts();
  const machine = stored.machine?.value ?? WORKER_LIMIT_DEFAULT;
  const key = project ? canonicalProject(project) : null;
  const own = key ? projectWorkerLimit(key, stored) : null;
  return {
    machine: { value: machine, default: WORKER_LIMIT_DEFAULT, min: WORKER_LIMIT_MIN, max: WORKER_LIMIT_MAX, source: stored.machine ? "machine" : "default", changedAt: stored.machine?.changedAt ?? null, changedBy: stored.machine?.changedBy ?? null },
    project: key ? { key, value: own?.value ?? null, effective: own?.value ?? machine, source: own ? "project" : stored.machine ? "machine" : "default" } : null,
    running: { here: key ? counts.byProject.get(key) ?? 0 : null, machine: counts.machine },
  };
}
export type WorkerLimitAnswer = ReturnType<typeof workerLimitAnswer>;
