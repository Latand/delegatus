import type { PipelineStageAttempt } from "./types";

type Budget = NonNullable<PipelineStageAttempt["spawnAdmissionBudget"]>;
export type SpawnWaitKind = Budget["kind"];
export const SPAWN_ADMISSION_LIMIT_MS = 600_000;

/** Charge only observed waiting. A CPU hold checkpoints and suspends it; the
 * next admitted call resumes it. Missing an entire call on restart is bounded
 * as host work until the receipt proves its outcome. */
export function chargeSpawnWait(attempt: PipelineStageAttempt, now: string): void {
  const budget = attempt.spawnAdmissionBudget;
  if (!budget?.waitingSince) return;
  charge(budget, budget.kind, Date.parse(now) - Date.parse(budget.waitingSince));
  delete budget.waitingSince;
}

function charge(budget: Budget, kind: SpawnWaitKind, milliseconds: number): void {
  budget.spent[kind] = Math.min(SPAWN_ADMISSION_LIMIT_MS,
    budget.spent[kind] + Math.max(0, milliseconds));
}

export function beginSpawnAdmission(attempt: PipelineStageAttempt, now: string): number {
  const budget = attempt.spawnAdmissionBudget ??= {
    spent: { host: 0, writer: 0, controller: 0 }, kind: "host",
    // Preserve a legacy in-flight cutoff, without inventing lock evidence.
    inFlightSince: attempt.activation?.admissionStartedAt,
  };
  chargeSpawnWait(attempt, now);
  if (budget.inFlightSince) {
    budget.kind = budget.inFlightKind ?? "host";
    charge(budget, budget.kind, Date.parse(now) - Date.parse(budget.inFlightSince));
    delete budget.inFlightSince;
    delete budget.inFlightKind;
  }
  return remainingSpawnAdmission(attempt);
}

export function remainingSpawnAdmission(attempt: PipelineStageAttempt, kind = attempt.spawnAdmissionBudget!.kind): number {
  const budget = attempt.spawnAdmissionBudget!;
  if (budget.spent.host >= SPAWN_ADMISSION_LIMIT_MS) return 0;
  return (kind === "controller" ? 30_000 : SPAWN_ADMISSION_LIMIT_MS) - budget.spent[kind];
}

export function switchSpawnAdmissionPhase(attempt: PipelineStageAttempt, now: string, kind: "host" | "writer"): number {
  const budget = attempt.spawnAdmissionBudget!;
  if (budget.inFlightSince) charge(budget, budget.inFlightKind ?? "host", Date.parse(now) - Date.parse(budget.inFlightSince));
  budget.inFlightSince = now;
  budget.inFlightKind = kind;
  return remainingSpawnAdmission(attempt, kind);
}

export function recordSpawnFailure(attempt: PipelineStageAttempt, now: string, kind: SpawnWaitKind, failure: string): void {
  const budget = attempt.spawnAdmissionBudget;
  if (!budget) return;
  chargeSpawnWait(attempt, now);
  if (budget.inFlightSince) charge(budget, budget.inFlightKind ?? kind, Date.parse(now) - Date.parse(budget.inFlightSince));
  delete budget.inFlightSince;
  delete budget.inFlightKind;
  budget.kind = kind;
  budget.lastFailure = failure.slice(0, 2_000);
  if (kind === "writer") budget.lastWriterFailure = budget.lastFailure;
}

export function finishSpawnAdmission(attempt: PipelineStageAttempt, now: string): void {
  const budget = attempt.spawnAdmissionBudget;
  if (!budget?.inFlightSince) return;
  charge(budget, budget.inFlightKind ?? "host", Date.parse(now) - Date.parse(budget.inFlightSince));
  delete budget.inFlightSince;
  delete budget.inFlightKind;
}

export function spawnAdmissionFailure(attempt: PipelineStageAttempt): string | undefined {
  const budget = attempt.spawnAdmissionBudget;
  return budget?.lastWriterFailure && budget.lastWriterFailure !== budget.lastFailure
    ? `${budget.lastFailure}; last observed writer: ${budget.lastWriterFailure}`
    : budget?.lastFailure;
}
