/**
 * Compact MCP answers (#1845, slice 1).
 *
 * A seat drives lanes through these tools dozens of times a day, and every
 * answer lands in its context. Measured over one day, the write tools echoed the
 * whole pipeline record back — composed role scaffolds, stage prompts and the
 * spec — so a `create_pipeline` answered a median 10 KB to tell the caller an id
 * and a state. The projections here are what each answer carries instead. Each
 * one names where the full record still is: `get_pipeline` for a pipeline,
 * `deployment_status` without `compact` for a deployment, `agent_activity`
 * without `compact` for a liveness row.
 */
import { liveFreshObservation } from "@/lib/accounts/accountProjection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import type { AgentLivenessRecord, AgentLivenessSnapshot } from "@/lib/lifecycle/liveness";
import { latestOperationalStageAttempt } from "@/lib/pipelines/attemptSelection";
import { clampChars, clampLine } from "@/lib/pipelines/listProjection";
import { graphDigest, stageDigests } from "@/lib/pipelines/stageDigest";
import type { Pipeline, PipelineStage, PipelineStageAttempt, PipelineStageReport } from "@/lib/pipelines/types";
import { launchRuntimeLabel, variantForParams } from "@/lib/roles/paramConfig";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { modelTierWindows, type LimitWindow } from "@/lib/types";

const ACK_DETAIL_CHARS = 200;
const ERROR_CHARS = 300;
const TITLE_CHARS = 80;
const SUMMARY_CHARS = 2_000;

/**
 * What a pipeline write answers: where the lane stands after the write and the
 * digests a guarded graph edit names next — what `create_pipeline` answers.
 */
export function pipelineAcknowledgement(pipeline: Pipeline) {
  const stages = (pipeline.stages ?? []).map((stage) => ({ stage, runtime: stageRuntime(stage) }));
  return {
    pipelineId: pipeline.id,
    state: pipeline.state,
    stateDetail: clampChars(pipeline.stateDetail, ACK_DETAIL_CHARS),
    cursor: pipeline.cursor ? { stageId: pipeline.cursor.stageId, state: pipeline.cursor.state } : null,
    closedAt: pipeline.closedAt ?? null,
    taskIds: [...(pipeline.taskIds ?? [])],
    ...finishesTaskFields(pipeline),
    branch: pipeline.branch,
    stages: stages.map(({ stage, runtime }) => ({
      id: stage.id,
      role: runtime.roleId,
      variant: runtime.variant,
      engine: runtime.engine,
      model: runtime.model,
      effort: runtime.effort,
    })),
    runtimeLine: stages.map(({ stage, runtime }) => `${stage.id}: ${launchRuntimeLabel(runtime)}`).join(" · "),
    stageDigests: stageDigests(pipeline.stages ?? []),
    graphDigest: graphDigest(pipeline.stages ?? []),
  };
}

/**
 * Which model a stage runs and where it came from (docs/design/model-sizing-tiers.md
 * §3). A stage whose engine or model the request named is `(explicit)`: at
 * create, those input fields are present only when the caller sent them, and a
 * fix stage carries them only when its implementer did.
 */
function stageRuntime(stage: PipelineStage) {
  const roleId = stage.effectiveRole?.roleId ?? stage.role?.roleId ?? null;
  return {
    roleId,
    variant: variantForParams(roleId, stage.role?.params),
    engine: stage.effectiveRole?.engine ?? stage.engine ?? "claude",
    model: stage.effectiveRole?.model ?? stage.model ?? null,
    effort: stage.effectiveRole?.effort ?? stage.effort ?? null,
    explicit: stage.engine !== undefined || (stage.model !== undefined && stage.model !== null),
  };
}

/**
 * What a `pipeline_action` answers: where the lane stands after the action, and
 * the digests the next guarded edit names. The same shape `pause` has always
 * answered with, now for every action.
 */
export function pipelineActionAcknowledgement(pipeline: Pipeline) {
  return {
    pipelineId: pipeline.id,
    state: pipeline.state,
    cursor: pipeline.cursor ? { stageId: pipeline.cursor.stageId, state: pipeline.cursor.state } : null,
    closedAt: pipeline.closedAt ?? null,
    ...finishesTaskFields(pipeline),
    stageDigests: stageDigests(pipeline.stages ?? []),
    graphDigest: graphDigest(pipeline.stages ?? []),
  };
}

/** The tasks the lane finishes, and those whose move to Done waits (#2187
    §5), only when there are any. */
function finishesTaskFields(pipeline: Pipeline) {
  return {
    ...(pipeline.finishesTaskIds?.length ? { finishesTaskIds: [...pipeline.finishesTaskIds] } : {}),
    ...(pipeline.taskFinishWaits?.length ? { taskFinishWaits: pipeline.taskFinishWaits.map((wait) => ({ taskId: wait.taskId, open: wait.open.length })) } : {}),
  };
}

/**
 * The durable stage report is the authority for findings and the narrative.
 * A successful completion only needs enough metadata to identify that report;
 * `get_pipeline` with `stageId` reads its complete bounded record. Keep this
 * projection scalar/bounded so a large finding list cannot return through a
 * second field in the acknowledgement.
 */
export function stageReportAcknowledgement(report: PipelineStageReport) {
  const findings = report.verdict.findings ?? [];
  const severityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of report.verdict.rankedFindings ?? []) {
    if (finding.severity) severityCounts[finding.severity] += 1;
  }
  return {
    seq: report.seq,
    at: report.at,
    verdict: {
      status: report.verdict.status,
      findingCount: findings.length,
      severityCounts,
    },
    provenance: {
      head: report.provenance.head,
      branch: report.provenance.branch,
      dirty: report.provenance.uncommitted === null ? null : report.provenance.uncommitted.length > 0,
      pullRequest: report.provenance.pullRequest,
      /* Declared outputs are capped by the pipeline schema. */
      outputs: report.provenance.outputs,
    },
    calls: report.calls,
  };
}

export class StageReadError extends Error {}

function attemptFor(pipeline: Pipeline, stageId: string, attempt: number | undefined): PipelineStageAttempt | null {
  if (attempt === undefined) return latestOperationalStageAttempt(pipeline, stageId);
  const attempts = (pipeline.runs ?? []).find((run) => run.stageId === stageId)?.attempts ?? [];
  const found = attempts.find((candidate) => candidate.n === attempt);
  if (!found) {
    const known = attempts.map((candidate) => candidate.n);
    throw new StageReadError(`stage ${stageId} has no attempt ${attempt}; its attempts are ${known.length ? known.join(", ") : "none yet"}`);
  }
  return found;
}

/**
 * One stage and one of its attempts (the latest operational one by default):
 * what it concluded, with no prompt, scaffold, relay input or transcript tail.
 */
export function pipelineStageRead(pipeline: Pipeline, stageId: string, attempt?: number) {
  const stage = (pipeline.stages ?? []).find((candidate) => candidate.id === stageId);
  if (!stage) {
    const known = (pipeline.stages ?? []).map((candidate) => candidate.id);
    throw new StageReadError(`pipeline ${pipeline.id} has no stage ${stageId}; its stages are ${known.join(", ") || "none"}`);
  }
  const selected = attemptFor(pipeline, stageId, attempt);
  const attempts = (pipeline.runs ?? []).find((run) => run.stageId === stageId)?.attempts ?? [];
  const role = stage.effectiveRole;
  /* A stage report is accepted before the reporting turn settles. During that
     interval the attempt stays running and has no settled verdict yet, while
     its report is already the authoritative completion record. */
  const reportedVerdict = selected?.report?.verdict;
  const verdict = selected?.verdict ?? reportedVerdict;
  return {
    pipelineId: pipeline.id,
    state: pipeline.state,
    cursor: pipeline.cursor ? { stageId: pipeline.cursor.stageId, state: pipeline.cursor.state } : null,
    stage: {
      id: stage.id,
      kind: stage.kind,
      roleId: role?.roleId ?? stage.role?.roleId ?? null,
      engine: role?.engine ?? stage.engine ?? null,
      model: role?.model ?? stage.model ?? null,
      effort: role?.effort ?? stage.effort ?? null,
      next: stage.next,
      onFail: stage.onFail ? { to: stage.onFail.to, maxRounds: stage.onFail.maxRounds, onExhausted: stage.onFail.onExhausted ?? "advance" } : null,
      attempts: attempts.length,
      stageDigest: stageDigests([stage])[stage.id] ?? null,
    },
    attempt: selected ? {
      n: selected.n,
      state: selected.state,
      verdict: verdict?.status ?? null,
      findings: verdict?.findings ?? [],
      summary: clampChars(selected.report?.summary ?? null, SUMMARY_CHARS),
      decisionRequested: selected.decisionRequested === true,
      /* Findings handed to the fix stage after the budget was spent and never
         re-reviewed (#1868). */
      budgetSpent: selected.budgetSpent === true,
      conversationId: selected.conversationId ?? null,
      /* The launch pipeline_action retry-stage names beside the stage. */
      launchId: selected.launchId ?? null,
      flowId: selected.flowId ?? null,
      startedAt: selected.startedAt ?? null,
      completedAt: selected.completedAt ?? null,
      error: clampChars(selected.error, ERROR_CHARS),
    } : null,
  };
}

function deploymentStartedAt(deployment: ViewerDeploymentStatus): number {
  const created = Date.parse(deployment.createdAt);
  if (Number.isFinite(created)) return created;
  const updated = Date.parse(deployment.updatedAt);
  return Number.isFinite(updated) ? updated : Number.NEGATIVE_INFINITY;
}

/**
 * Newest-first by the instant a deployment started (#1845 defect C). Deployment
 * ids are random UUIDs, so id order says nothing about time; the id only breaks
 * a tie between two deployments admitted in the same instant.
 */
export function newestDeploymentsFirst<T extends ViewerDeploymentStatus>(deployments: readonly T[]): T[] {
  return [...deployments].sort((left, right) =>
    deploymentStartedAt(right) - deploymentStartedAt(left)
    || right.deploymentId.localeCompare(left.deploymentId));
}

export function compactDeployment(deployment: ViewerDeploymentStatus) {
  return {
    deploymentId: deployment.deploymentId,
    phase: deployment.phase,
    sha: deployment.revision,
    terminal: deployment.terminal,
    startedAt: deployment.createdAt ?? null,
    finishedAt: deployment.terminal ? deployment.updatedAt ?? null : null,
    error: clampChars(deployment.error, ERROR_CHARS),
  };
}

function compactLivenessRow(row: AgentLivenessRecord) {
  return {
    conversationId: row.conversationId,
    title: clampLine(row.title, TITLE_CHARS) ?? "",
    turnState: row.turnState,
    lifecycle: row.lifecycle,
    /* The one waiting that asks something of the reader (#2215): the reason
       and the request ride the compact row, so a caller learns a turn is held
       on a permission without a second, full read. */
    ...(row.reason === "permission_request" && row.permission
      ? {
          reason: row.reason,
          permission: { tool: row.permission.tool, command: row.permission.command, reason: row.permission.reason, since: row.permission.since },
        }
      : {}),
    silentForMs: row.silentForMs,
    stalledForMs: row.stalledForMs,
    pipeline: row.pipeline
      ? { pipelineId: row.pipeline.pipelineId, stageId: row.pipeline.stageId, attempt: row.pipeline.attempt }
      : null,
  };
}

/** The liveness answer without transcript paths, host detail or the selection
    and timing reports: which conversations are live, stalled or gone. */
export function compactLiveness(snapshot: AgentLivenessSnapshot) {
  return {
    observedAt: snapshot.observedAt,
    count: snapshot.count,
    stalledCount: snapshot.stalledCount,
    stalledConfirmedCount: snapshot.stalledConfirmedCount,
    conversations: snapshot.conversations.map(compactLivenessRow),
  };
}

export type AccountLimitEngine = "claude" | "codex" | "copilot";

export type AccountLimitsInput = {
  engine?: AccountLimitEngine;
  accountId?: string;
  accounts: Record<AccountLimitEngine, ReadonlyArray<{ accountId: string }>>;
  active: Record<AccountLimitEngine, string | null>;
  observations: Record<AccountLimitEngine, Readonly<Record<string, DurableQuotaObservation>>>;
  now: number;
};

function windowRow(window: LimitWindow | null | undefined) {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt === null || window.resetsAt === undefined ? null : new Date(window.resetsAt * 1000).toISOString(),
  };
}

/**
 * Per account, the usage the Viewer last observed (#1845 row 11): the session
 * and weekly windows, every metered model tier, and when each resets. Read from
 * the durable quota observations the accounts panel reads, so asking never
 * reaches a provider.
 */
export function accountLimitRows(input: AccountLimitsInput) {
  const engines: AccountLimitEngine[] = input.engine ? [input.engine] : ["claude", "codex", "copilot"];
  return engines.flatMap((engine) => input.accounts[engine]
    .filter((account) => !input.accountId || account.accountId === input.accountId)
    .map((account) => {
      const observation = input.observations[engine][account.accountId];
      const limits = observation?.limits ?? null;
      return {
        engine,
        /* No label: it is free text the operator typed and may name a person;
           the account id is the one identity this answer carries. */
        accountId: account.accountId,
        active: input.active[engine] === account.accountId,
        /* Whether the observation is recent enough for the automatic switch to
           act on — the same test the accounts panel draws "stale" from. */
        fresh: liveFreshObservation(observation, input.now),
        plan: limits?.plan ?? null,
        session: windowRow(limits?.session),
        weekly: windowRow(limits?.weekly),
        tiers: modelTierWindows(limits).map((tier) => ({ tier: tier.tier, ...windowRow(tier)! })),
        observedAt: observation?.observedAt ?? null,
      };
    }));
}
