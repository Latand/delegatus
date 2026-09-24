/* The managed Docker install's update (#2007): one Viewer deployment.

   The request is the one `POST /api/runtime/deployments` makes
   (`requestViewerDeployment`): a pinned `revision` (the exact commit the
   check showed the operator, so what ships is what the changelog described)
   and an idempotency key. The runtime host builds a candidate image, gates
   its health, switches the stable listener to it and, when its own
   generation drifted, hands itself over to a successor through its fence.
   Nothing here signals a process or runs Docker.

   The web process that asked is replaced during the deployment, so what it
   asked is written down (`managed.json`) and the next web process carries on
   reading the same deployment. Progress is the deployment record the host
   journals, read the way `GET /api/runtime/deployments/:id` reads it. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ViewerDeploymentPhase, ViewerDeploymentReceipt, ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import { TAIL_LINES } from "./steps";
import { idleUpdate, MANAGED_STEPS, pendingSteps, shortSha, type ManagedStepName, type Revision, type Step, type UpdateState } from "./types";

export interface ManagedRecord {
  deploymentId: string;
  idempotencyKey: string;
  target: string;
  targetShort: string;
  targetVersion: string | null;
  requestedAt: string;
  /** When each step was first seen running, from the host's own timestamps. */
  observed: Partial<Record<ManagedStepName, string>>;
  /** The step that was running when the deployment was last seen active: a
      failure or rollback is reported at it. */
  lastStep: ManagedStepName | null;
  finishedAt: string | null;
  /** Since when the host has answered "no such deployment" (a reset journal,
      another install); null while it knows it. */
  missingSince?: string | null;
  /** The host stopped knowing this deployment long enough that it is no
      longer waited for. */
  lost?: boolean;
  phase: ViewerDeploymentPhase | null;
  error: string | null;
  servingProgress: string | null;
}

export class DeploymentBusyError extends Error {
  constructor(readonly deploymentId: string) {
    super(`another deployment is running (${deploymentId})`);
    this.name = "DeploymentBusyError";
  }
}

const CLIENT_KEY = /^[A-Za-z0-9-]{1,64}$/;

export function managedIdempotencyKey(target: string, clientKey: string): string {
  if (!CLIENT_KEY.test(clientKey)) throw new Error("the update request key is invalid");
  return `self-update-${target.slice(0, 12)}-${clientKey}`;
}

export async function requestManagedUpdate(
  target: Revision,
  clientKey: string,
  request: (body: ViewerDeploymentRequest) => Promise<ViewerDeploymentReceipt>,
  now: () => number = Date.now,
): Promise<ManagedRecord> {
  const idempotencyKey = managedIdempotencyKey(target.sha, clientKey);
  const receipt = await request({ revision: target.sha, idempotencyKey });
  if (receipt.state === "busy") throw new DeploymentBusyError(receipt.deploymentId);
  return {
    deploymentId: receipt.deploymentId,
    idempotencyKey,
    target: receipt.revision || target.sha,
    targetShort: shortSha(receipt.revision || target.sha),
    targetVersion: target.version || null,
    requestedAt: new Date(now()).toISOString(),
    observed: {},
    lastStep: null,
    finishedAt: null,
    phase: null,
    error: null,
    servingProgress: null,
  };
}

export function stepForPhase(phase: ViewerDeploymentPhase): ManagedStepName | null {
  switch (phase) {
    case "admitted": return "admit";
    case "building": return "image";
    case "candidate-starting": return "candidate";
    case "candidate-health": return "health";
    case "promoting":
    case "post-promotion-health": return "promote";
    case "host-handoff": return "handoff";
    default: return null;
  }
}

/** Where a failure happened, read from what the host recorded before it:
    a handoff record, a promotion publication, health evidence, a candidate.
    Used when the failure was not watched as it happened (the surface was
    closed, or the web process that asked was being replaced). */
export function stepReachedBy(status: ViewerDeploymentStatus): ManagedStepName {
  if (status.runtimeHostHandoff) return "handoff";
  if (status.mcpRuntime?.publications?.some((publication) => publication.action === "activate")) return "promote";
  if (status.health?.length) return "health";
  if (status.candidate) return "candidate";
  return "image";
}

function later(a: ManagedStepName | null, b: ManagedStepName): ManagedStepName {
  return a && MANAGED_STEPS.indexOf(a) > MANAGED_STEPS.indexOf(b) ? a : b;
}

/** How long the host may answer "no such deployment" before the surface
    stops waiting for it. A host that does not answer at all is not this: it
    is being replaced, and the deployment is waited for. */
export const LOST_AFTER_MS = 120_000;

/** The host answered that it knows no such deployment. */
export function observeMissing(record: ManagedRecord, now: number): ManagedRecord {
  if (!managedActive(record)) return record;
  const since = record.missingSince ? Date.parse(record.missingSince) : null;
  if (since === null) return { ...record, missingSince: new Date(now).toISOString() };
  if (now - since < LOST_AFTER_MS) return record;
  return { ...record, lost: true, phase: "failed", finishedAt: new Date(now).toISOString() };
}

/** Folds one read of the deployment into the record. */
export function observeDeployment(record: ManagedRecord, status: ViewerDeploymentStatus | null): ManagedRecord {
  if (!status) return record;
  if (record.missingSince) record = { ...record, missingSince: null };
  const step = stepForPhase(status.phase);
  const observed = { ...record.observed };
  if (step && !observed[step]) observed[step] = status.updatedAt;
  const failing = status.phase === "rolling-back" || status.phase === "rolled-back" || status.phase === "failed";
  return {
    ...record,
    observed,
    lastStep: step ?? (failing ? later(record.lastStep, stepReachedBy(status)) : record.lastStep),
    phase: status.phase,
    error: status.error,
    servingProgress: status.servingProgress ?? null,
    finishedAt: status.terminal ? (record.finishedAt ?? status.updatedAt) : null,
  };
}

function isFailure(phase: ViewerDeploymentPhase | null): boolean {
  return phase === "rolling-back" || phase === "rolled-back" || phase === "failed";
}

/** The Update section's state for one deployment, in the same shape the
    checkout install's step runner reports. */
export function managedUpdateState(record: ManagedRecord, now: number): UpdateState {
  const steps: Step[] = pendingSteps(MANAGED_STEPS);
  const failed = isFailure(record.phase);
  const succeeded = record.phase === "succeeded";
  const current = succeeded ? null : (record.lastStep ?? "admit");
  const currentIndex = current ? MANAGED_STEPS.indexOf(current) : MANAGED_STEPS.length;
  const startOf = (index: number): string | null => {
    const name = MANAGED_STEPS[index]!;
    return record.observed[name] ?? (index === 0 ? record.requestedAt : null);
  };
  /* A step's end is the next observed start, or the finish. */
  const endOf = (index: number): number | null => {
    for (let next = index + 1; next < MANAGED_STEPS.length; next += 1) {
      const at = record.observed[MANAGED_STEPS[next]!];
      if (at) return Date.parse(at);
    }
    return record.finishedAt ? Date.parse(record.finishedAt) : null;
  };
  const tail = [record.servingProgress, record.error].filter((line): line is string => Boolean(line)).slice(-TAIL_LINES);
  MANAGED_STEPS.forEach((name, index) => {
    const startedAt = startOf(index);
    const start = startedAt ? Date.parse(startedAt) : null;
    if (index < currentIndex) {
      const end = endOf(index);
      steps[index] = { ...steps[index]!, state: "done", startedAt, durationMs: start !== null && end !== null ? Math.max(0, end - start) : null };
    } else if (index === currentIndex) {
      const end = failed ? endOf(index) ?? now : now;
      steps[index] = {
        ...steps[index]!,
        state: failed ? "failed" : "running",
        startedAt,
        durationMs: start !== null ? Math.max(0, end - start) : null,
        tail,
        failure: record.lost ? { kind: "deployment-lost" } : null,
      };
    }
  });
  return {
    ...idleUpdate(MANAGED_STEPS),
    state: succeeded ? "done" : failed ? "failed" : "running",
    target: record.target,
    targetShort: record.targetShort,
    targetVersion: record.targetVersion,
    deploymentId: record.deploymentId,
    rolledBack: record.phase === "rolling-back" || record.phase === "rolled-back",
    steps,
    startedAt: record.requestedAt,
    finishedAt: record.finishedAt,
  };
}

export function managedActive(record: ManagedRecord | null): boolean {
  return record !== null && record.finishedAt === null;
}

export function readManagedRecord(file: string): ManagedRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ManagedRecord;
    return typeof parsed.deploymentId === "string" && typeof parsed.target === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeManagedRecord(file: string, record: ManagedRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, file);
}
