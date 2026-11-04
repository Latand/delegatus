import { createHash } from "node:crypto";
import type { Pipeline, PipelineIntegration, PipelineStage } from "./types";

export const INTEGRATION_STAGES = ["integration-resolve", "integration-review", "integration-fix"] as const;
export const INTEGRATION_SESSION_MS = 60 * 60_000;
export const INTEGRATION_REPAIR_LIMIT = 3;

/** Workspace authority is part of the context boundary, including its revision. */
export function integrationScope(pipeline: Pipeline): string {
  return createHash("sha256").update(JSON.stringify([pipeline.project, pipeline.workspace ?? null])).digest("hex");
}

export function integrationRequirementRevision(pipeline: Pipeline): string {
  return createHash("sha256").update(JSON.stringify([pipeline.task, pipeline.spec ?? null, pipeline.taskIds, pipeline.decisionAnswers ?? []])).digest("hex");
}

/** Persisted writer output is decoded before any controller consumes it. */
export function isPipelineIntegration(value: unknown): value is PipelineIntegration {
  if (!value || typeof value !== "object") return false;
  const i = value as PipelineIntegration;
  const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{40}$/i.test(v);
  const str = (v: unknown) => typeof v === "string" && !!v;
  const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  return str(i.outcomeId) && ["queued", "legacy-draining", "resolving", "reviewing", "checking", "waiting", "blocked", "landing", "reconciling", "landed"].includes(i.state)
    && str(i.scope) && str(i.requirementRevision) && str(i.decisionRevision) && sha(i.desiredBase)
    && (i.integratedHead === null || sha(i.integratedHead)) && sha(i.expectedRemoteHead) && count(i.ownerEpoch) && count(i.cycles) && count(i.repairs)
    && (i.featureBase === null || sha(i.featureBase))
    && str(i.reservationKey) && time(i.startedAt) && time(i.deadline)
    && (i.binding === null || !!i.binding && INTEGRATION_STAGES.includes(i.binding.stageId as typeof INTEGRATION_STAGES[number])
      && count(i.binding.attempt) && (i.binding.launchId === null || str(i.binding.launchId)) && (i.binding.conversationId === null || str(i.binding.conversationId)))
    && (i.publicationId === null || str(i.publicationId)) && (i.reviewedHead === null || sha(i.reviewedHead))
    && !!i.batch && str(i.batch.owner) && Array.isArray(i.batch.items) && i.batch.items.length > 0 && i.batch.items.length <= 8
    && i.batch.items.every(str) && new Set(i.batch.items).size === i.batch.items.length
    && count(i.batch.cursor) && i.batch.cursor <= i.batch.items.length && time(i.batch.deadline);
}

export function integrationRecord(pipeline: Pipeline, now: string): PipelineIntegration {
  const merge = pipeline.merge!, refresh = merge.refresh!;
  const previous = merge.integration;
  return {
    outcomeId: previous?.outcomeId ?? pipeline.refreshOf?.pipelineId ?? pipeline.id,
    state: "queued", scope: integrationScope(pipeline), requirementRevision: integrationRequirementRevision(pipeline),
    decisionRevision: merge.policyChangedAt, desiredBase: refresh.base,
    featureBase: previous ? previous.featureBase : /^[a-f0-9]{40}$/i.test(pipeline.baseRef ?? "") ? pipeline.baseRef : null,
    integratedHead: null, expectedRemoteHead: refresh.head,
    ownerEpoch: pipeline.delivery!.epoch, cycles: previous?.cycles ?? 0, repairs: previous?.repairs ?? 0,
    reservationKey: previous?.reservationKey ?? refresh.key, startedAt: now,
    deadline: new Date(Date.parse(now) + INTEGRATION_SESSION_MS).toISOString(),
    binding: null, publicationId: null, reviewedHead: null,
    batch: previous?.batch && previous.batch.cursor < previous.batch.items.length && Date.parse(previous.batch.deadline) > Date.parse(now)
      ? previous.batch : { owner: pipeline.id, items: [pipeline.id], cursor: 0, deadline: new Date(Date.parse(now) + INTEGRATION_SESSION_MS).toISOString() },
  };
}

/** Called under the existing delivery transaction. No I/O or agent launch. */
export function admitIntegration(pipeline: Pipeline, expected: Pipeline, stages: PipelineStage[], now: string): string | null {
  const merge = pipeline.merge, reservation = merge?.refresh, delivery = pipeline.delivery;
  if (!merge || !reservation || !delivery || reservation.pipelineId || pipeline.state !== "completed" || pipeline.hiddenAt
    || delivery.disposition !== "owner" || delivery.ownerId !== pipeline.id || delivery.active
    || merge.state !== "refreshing" || reservation.key !== expected.merge?.refresh?.key
    || reservation.digest !== expected.merge?.refresh?.digest || merge.updatedAt !== expected.merge?.updatedAt
    || delivery.epoch !== expected.delivery?.epoch || pipeline.lastPassedCommit !== expected.lastPassedCommit
    || integrationScope(pipeline) !== integrationScope(expected)) return "integration reservation or delivery owner changed";
  if (delivery.operation?.state === "running" || merge.effectUncertain) return "integration waits for publication or forge reconciliation";
  const record = merge.integration ?? integrationRecord(pipeline, now);
  if (record.scope !== integrationScope(pipeline) || record.requirementRevision !== integrationRequirementRevision(pipeline)
    || record.decisionRevision !== merge.policyChangedAt) return "integration requirements or authority changed";
  if (record.cycles >= 64) return "integration cycle budget exhausted";
  if (record.repairs >= INTEGRATION_REPAIR_LIMIT) return "integration repair budget exhausted";
  const prepared = record.integratedHead;
  if (prepared && (prepared !== record.expectedRemoteHead || reservation.head !== pipeline.lastPassedCommit
    || !merge.updates.some(update => update.commit === prepared && update.head === prepared && update.base === reservation.base)))
    return "mechanical integration has no matching landed update receipt";
  const previousIds = new Set(INTEGRATION_STAGES);
  if (pipeline.stages.some(stage => previousIds.has(stage.id as typeof INTEGRATION_STAGES[number])) && !merge.integration)
    return "integration stage identity is already in use";
  // Old terminal integration attempts remain in their real runs with reports.
  const retained = pipeline.stages.filter(stage => !previousIds.has(stage.id as typeof INTEGRATION_STAGES[number]));
  pipeline.stages = [...retained, ...stages];
  pipeline.runs = pipeline.stages.map(stage => pipeline.runs.find(run => run.stageId === stage.id) ?? { stageId: stage.id, attempts: [] });
  for (const run of pipeline.runs.filter(run => previousIds.has(run.stageId as typeof INTEGRATION_STAGES[number]))) {
    for (const attempt of run.attempts) attempt.historical = true;
  }
  delivery.active = true; delivery.publish = "enabled"; delivery.disposition = "owner";
  delivery.ownerId = pipeline.id; delivery.epoch++;
  delete delivery.operation;
  delete delivery.releasedAt;
  pipeline.publication = "remote-branch";
  // The same worktree is provisioned again. Its selected starting commit is
  // the reconciled delivery head; the original comparison base stays above.
  pipeline.baseRef = record.expectedRemoteHead;
  pipeline.baseRefPinned = true;
  if (prepared) pipeline.lastPassedCommit = prepared;
  pipeline.cursor = { stageId: prepared ? "integration-review" : INTEGRATION_STAGES[0], state: "pending", input: null, activatedBy: null };
  pipeline.state = "provisioning"; pipeline.stateDetail = "integration accepted; preparing the existing outcome";
  pipeline.closedAt = null; pipeline.pausedState = null;
  record.state = prepared ? "reviewing" : "resolving"; record.cycles++; record.ownerEpoch = delivery.epoch;
  record.desiredBase = reservation.base; record.integratedHead = prepared; record.reviewedHead = null;
  record.binding = null; record.publicationId = null;
  record.startedAt = now; record.deadline = new Date(Date.parse(now) + INTEGRATION_SESSION_MS).toISOString();
  merge.integration = record;
  return null;
}

/** Bind to the ordinary attempt; launch/report/publication retain their own fences. */
export function integrationAttempt(pipeline: Pipeline): void {
  const integration = pipeline.merge?.integration, stageId = pipeline.cursor?.stageId;
  if (!integration || !stageId || !INTEGRATION_STAGES.includes(stageId as typeof INTEGRATION_STAGES[number])) return;
  const attempt = pipeline.runs.find(run => run.stageId === stageId)?.attempts.filter(a => !a.historical).at(-1);
  if (!attempt) return;
  integration.binding = { stageId, attempt: attempt.n, launchId: attempt.launchId, conversationId: attempt.conversationId };
  integration.state = ["needs_decision", "needs_review", "paused", "closed"].includes(pipeline.state) ? "blocked"
    : attempt.providerWait ? "waiting" : stageId === "integration-review" ? "reviewing" : "resolving";
}


/** An accepted answer renews this attempt's requirement revision. Existing
 * policy and epoch checks still decide whether it may execute. */
export function renewIntegrationDecision(pipeline: Pipeline, now: string): void {
  const integration = pipeline.merge?.integration;
  if (!integration || !pipeline.cursor || !INTEGRATION_STAGES.includes(pipeline.cursor.stageId as typeof INTEGRATION_STAGES[number])
    || integration.scope !== integrationScope(pipeline) || integration.ownerEpoch !== pipeline.delivery?.epoch
    || pipeline.delivery?.operation?.state === "running") return;
  integration.requirementRevision = integrationRequirementRevision(pipeline);
  integration.reviewedHead = null;
  integration.deadline = new Date(Date.parse(now) + INTEGRATION_SESSION_MS).toISOString();
}
