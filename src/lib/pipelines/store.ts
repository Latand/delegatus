import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { effortScale } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { MAX_SCAFFOLD_LENGTH } from "@/lib/roles/store";
import { refuseBusyBeforeAdmission } from "@/lib/state/fileTransaction";
import { initializeStateCollections, readStateCollectionsRows, SqliteStateCollection, type StateBoundedTransaction, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";
import type { BoardTask } from "@/lib/tasks/types";

import { MAX_FAIL_EDGE_ROUNDS, MAX_PIPELINE_GRAPH_EDITS, MAX_PIPELINE_STAGE_REPORTS, MAX_PIPELINE_STAGES, MAX_STAGE_OUTPUTS } from "./limits";
import { normalizeStageOutputPath } from "./stageAccess";
import { MAX_DECISION_ANSWER_CHARS } from "./types";
import type { EffectivePipelineRole, Pipeline, PipelineCreationIntent, PipelineDeliveryTarget, PipelineEdgeActivation, PipelinePublication, PipelineStage, PipelineTerminalReap, PipelineUnconfirmedHost } from "./types";
import { stageVerdictFrom } from "./verdict";

/** Same opaque content revision used by MCP record acknowledgements. */
export function pipelineRevision(pipeline: Pipeline): string {
  return crypto.createHash("sha256").update(JSON.stringify(pipeline)).digest("hex");
}

export const PIPELINES_SCHEMA_VERSION = 5;
/** Older registries are migrated in memory on load; the file is rewritten in
    the current shape by the next successful mutation, never by a read. */
const MIGRATABLE_SCHEMA_VERSIONS = new Set([2, 3, 4, PIPELINES_SCHEMA_VERSION]);
const pipelinesFile = () => statePath("pipelines.json");
const pipelinesArchiveFile = () => statePath("pipelines-archive.json");
const stateDatabaseFile = () => statePath("state.sqlite");
const artifactsRoot = () => statePath("pipelines");

type PipelineFile = { schemaVersion: number; pipelines: Pipeline[] };
const PIPELINE_ROLE_IDS = ["orchestrator", "reviewer", "verifier", "builder", "architect", "cleaner", "prod-auditor", "deployer"] as const;

export class PipelineStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PipelineStoreError";
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}
function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PipelineStoreError(`could not read pipeline registry: ${filePath}`, { cause: error });
  }
}

export function isEffectiveRole(value: unknown): value is EffectivePipelineRole {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value as Partial<EffectivePipelineRole>;
  if (role.engine !== "claude" && role.engine !== "codex") return false;
  if (role.model !== null && typeof role.model !== "string") return false;
  if (role.model && role.engine === "claude" && !normalizeClaudeLaunchModel(role.model)) return false;
  if (role.model && role.engine === "codex" && (role.model.length > 128 || !role.model.startsWith("gpt-") || /[\u0000-\u001f\u007f]/.test(role.model))) return false;
  if (role.effort !== null && (typeof role.effort !== "string" || !effortScale(role.engine, role.model)!.includes(role.effort))) return false;
  return (
    (role.roleId === null || PIPELINE_ROLE_IDS.includes(role.roleId as typeof PIPELINE_ROLE_IDS[number])) &&
    (role.access === "read-only" || role.access === "read-write") &&
    (role.promptScaffold === null || (typeof role.promptScaffold === "string" && role.promptScaffold.length <= MAX_SCAFFOLD_LENGTH))
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isVerdict(value: unknown): boolean {
  return value === null || stageVerdictFrom(value) !== null;
}

function isReviewFlowSync(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sync = value as Record<string, unknown>;
  const hostClaim = sync.hostClaim as Record<string, unknown> | null | undefined;
  const hostClaimValid = hostClaim === undefined || hostClaim === null || (
    typeof hostClaim === "object"
    && !Array.isArray(hostClaim)
    && /^(?:claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(hostClaim.sessionKey))
    && /^(?:default|unknown|managed:[0-9a-f]{12})$/.test(String(hostClaim.accountRef))
  );
  const flowStates = ["waiting_ready", "spawn_pending", "spawning", "reviewing", "relay_pending", "relaying", "fixing", "approved", "done_comment", "needs_decision", "paused", "closed"];
  return typeof sync.generation === "string"
    && (sync.sourceRevision === undefined || (Number.isInteger(sync.sourceRevision) && (sync.sourceRevision as number) >= 0))
    && Number.isInteger(sync.roundCount) && (sync.roundCount as number) >= 0
    && isNullableString(sync.implementerHeadSha)
    && isNullableString(sync.reviewerHeadSha)
    && (sync.verdict === null || ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(String(sync.verdict)))
    && flowStates.includes(String(sync.relayState))
    && (sync.terminalState === null || flowStates.includes(String(sync.terminalState)))
    && hostClaimValid
    && typeof sync.synchronizedAt === "string"
    && isNullableString(sync.sourceUpdatedAt)
    && (sync.lagMs === null || (typeof sync.lagMs === "number" && Number.isFinite(sync.lagMs) && sync.lagMs >= 0));
}

function isActivation(value: unknown): value is PipelineEdgeActivation | null {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activation = value as Partial<PipelineEdgeActivation>;
  return (
    typeof activation.stageId === "string" &&
    Number.isInteger(activation.attempt) &&
    (activation.attempt as number) >= 1 &&
    (activation.edge === "pass" || activation.edge === "fail") &&
    (activation.budgetSpent === undefined || (activation.budgetSpent === true && activation.edge === "fail"))
  );
}

function isVerdictRecovery(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recovery = value as Record<string, unknown>;
  return (
    ["pending", "recovered", "exhausted"].includes(String(recovery.state))
    && Number.isInteger(recovery.checks)
    && (recovery.checks as number) >= 0
    && Number.isInteger(recovery.maxChecks)
    && (recovery.maxChecks as number) >= 1
    && (recovery.checks as number) <= (recovery.maxChecks as number)
    && typeof recovery.startedAt === "string"
    && typeof recovery.lastCheckedAt === "string"
    && isNullableString(recovery.nextCheckAt)
    && typeof recovery.reason === "string"
    && recovery.reason.length > 0
    && recovery.reason.length <= 1_000
    && (recovery.messageTs === null
      || (typeof recovery.messageTs === "number" && Number.isFinite(recovery.messageTs) && recovery.messageTs >= 0))
  );
}

function isAttempt(value: unknown, index: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (
    attempt.n === index + 1 &&
    (attempt.decisionAnswerId === undefined || (typeof attempt.decisionAnswerId === "string" && attempt.decisionAnswerId.length > 0 && attempt.decisionAnswerId.length <= 200)) &&
    (attempt.historical === undefined || typeof attempt.historical === "boolean") &&
    ["pending", "spawning", "running", "reviewing", "committing", "passed", "failed", "needs_decision", "skipped"].includes(String(attempt.state)) &&
    isEffectiveRole(attempt.effectiveRole) &&
    isNullableString(attempt.launchId) &&
    isNullableString(attempt.conversationId) &&
    isNullableString(attempt.sessionId) &&
    isNullableString(attempt.agentPath) &&
    isNullableString(attempt.paneId) &&
    (attempt.accountId === undefined || isNullableString(attempt.accountId)) &&
    (attempt.usageLimitedAccounts === undefined || (
      Array.isArray(attempt.usageLimitedAccounts)
      && attempt.usageLimitedAccounts.every((limited) => (
        limited !== null
        && typeof limited === "object"
        && !Array.isArray(limited)
        && typeof limited.accountId === "string"
        && limited.accountId.length > 0
        && (limited.engine === undefined || limited.engine === "claude" || limited.engine === "codex")
        && (limited.resetsAt === null || (Number.isSafeInteger(limited.resetsAt) && limited.resetsAt >= 0))
      ))
      && new Set(attempt.usageLimitedAccounts.map((limited) => `${limited.engine ?? ""}:${limited.accountId}`)).size === attempt.usageLimitedAccounts.length
    )) &&
    isNullableString(attempt.flowId) &&
    (attempt.expectedReviewHeadSha === undefined || isNullableString(attempt.expectedReviewHeadSha)) &&
    (attempt.reviewHeadSha === undefined || isNullableString(attempt.reviewHeadSha)) &&
    isReviewFlowSync(attempt.reviewFlowSync) &&
    isNullableString(attempt.startedAt) &&
    isNullableString(attempt.completedAt) &&
    (attempt.input === undefined || isNullableString(attempt.input)) &&
    isActivation(attempt.activatedBy) &&
    isNullableString(attempt.output) &&
    isVerdict(attempt.verdict) &&
    isNullableString(attempt.error) &&
    (attempt.decisionRequested === undefined || typeof attempt.decisionRequested === "boolean") &&
    (attempt.budgetSpent === undefined || typeof attempt.budgetSpent === "boolean") &&
    isVerdictRecovery(attempt.verdictRecovery) &&
    isAttemptDefinition(attempt.definition) &&
    isSpawnActivation(attempt.activation) &&
    isStageReport(attempt.report) &&
    isRetiredLaunches(attempt.retiredLaunches) &&
    isUnresolvedTermination(attempt.unresolvedTermination)
  );
}

function isSpawnActivation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activation = value as Record<string, unknown>;
  const input = activation.input as Record<string, unknown> | undefined;
  const owner = activation.owner as Record<string, unknown> | undefined;
  return typeof activation.id === "string" && activation.id.length > 0
    && ["reserved", "reserving", "dispatching", "settled"].includes(String(activation.phase))
    && typeof activation.clientAttemptId === "string" && activation.clientAttemptId.length > 0
    && typeof activation.startedAt === "string" && typeof activation.fence === "string"
    && (activation.replay === undefined || typeof activation.replay === "boolean")
    && (activation.cancelRequested === undefined || typeof activation.cancelRequested === "boolean")
    && (activation.closeRequested === undefined || typeof activation.closeRequested === "boolean")
    && (!owner || (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
      && isNullableString(owner.startIdentity) && isNullableString(owner.bootEpoch)))
    && !!input && isEffectiveRole(input.role) && typeof input.prompt === "string"
    && typeof input.cwd === "string" && typeof input.project === "string"
    && typeof input.clientAttemptId === "string" && typeof input.title === "string"
    && !!input.runtimeProfile && !!input.membership;
}

function isAttemptDefinition(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const definition = value as Record<string, unknown>;
  const role = definition.role;
  return typeof definition.boundAt === "string"
    && typeof definition.stageDigest === "string"
    && typeof definition.prompt === "string"
    && isNullableString(definition.account)
    && (role === null || Boolean(role && typeof role === "object" && !Array.isArray(role) && (PIPELINE_ROLE_IDS as readonly unknown[]).includes((role as { roleId?: unknown }).roleId)))
    && (definition.sandbox === null || definition.sandbox === "full" || definition.sandbox === "restricted")
    && (definition.outputs === null || (Array.isArray(definition.outputs) && definition.outputs.every((output) => typeof output === "string")));
}

const GRAPH_EDIT_ACTION_NAMES: readonly string[] = ["add-stage", "remove-stage", "reorder-stage", "set-edge", "override-stage"];

function isActor(value: unknown): boolean {
  const actor = value as Record<string, unknown> | null;
  return Boolean(actor && typeof actor === "object" && !Array.isArray(actor) && (actor.kind === "operator"
    || (actor.kind === "agent" && isNullableString(actor.role) && isNullableString(actor.conversationId))));
}

function isStageProvenance(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  const pullRequest = provenance.pullRequest as Record<string, unknown> | null;
  return isNullableString(provenance.head)
    && typeof provenance.branch === "string"
    && (provenance.uncommitted === null
      || (Array.isArray(provenance.uncommitted) && provenance.uncommitted.every((path) => typeof path === "string")))
    && (pullRequest === null || Boolean(pullRequest && typeof pullRequest === "object" && !Array.isArray(pullRequest)
      && typeof pullRequest.url === "string" && Number.isSafeInteger(pullRequest.number) && typeof pullRequest.state === "string"))
    && Array.isArray(provenance.outputs)
    && provenance.outputs.every((output) => Boolean(output && typeof output === "object" && !Array.isArray(output)
      && typeof (output as { path: unknown }).path === "string"
      && typeof (output as { present: unknown }).present === "boolean"));
}

/** A stage attempt's own completion report (graph slice 2). */
function isStageReport(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return Number.isSafeInteger(report.seq) && (report.seq as number) >= 1
    && typeof report.at === "string"
    && isActor(report.actor)
    && stageVerdictFrom(report.verdict) !== null
    && isNullableString(report.summary)
    && isStageProvenance(report.provenance)
    && Number.isSafeInteger(report.calls) && (report.calls as number) >= 1;
}

function isStageReportEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Number.isSafeInteger(entry.seq) && (entry.seq as number) >= 1
    && typeof entry.at === "string"
    && isActor(entry.actor)
    && typeof entry.stageId === "string"
    && Number.isSafeInteger(entry.attempt) && (entry.attempt as number) >= 1
    && ["pass", "fail", "needs_decision"].includes(String(entry.status))
    && Number.isSafeInteger(entry.findings) && (entry.findings as number) >= 0
    && (entry.replaces === null || (Number.isSafeInteger(entry.replaces) && (entry.replaces as number) >= 1))
    && isNullableString(entry.summary);
}

function isGraphEdit(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return Number.isSafeInteger(edit.seq) && (edit.seq as number) >= 1
    && typeof edit.at === "string"
    && isActor(edit.actor)
    && GRAPH_EDIT_ACTION_NAMES.includes(String(edit.action))
    && isNullableString(edit.stageId)
    && typeof edit.pipelineState === "string"
    && (edit.effect === "applied" || edit.effect === "pending-next-attempt")
    && (edit.appliesFromAttempt === null || (Number.isSafeInteger(edit.appliesFromAttempt) && (edit.appliesFromAttempt as number) >= 1))
    && typeof edit.summary === "string";
}

function isRetiredLaunches(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value)
    && value.length <= 50
    && value.every((retired) => retired !== null
      && typeof retired === "object"
      && !Array.isArray(retired)
      && typeof (retired as { launchId: unknown }).launchId === "string"
      && (retired as { launchId: string }).launchId.length > 0
      && isNullableString((retired as { conversationId: unknown }).conversationId)
      && typeof (retired as { error: unknown }).error === "string"
      && typeof (retired as { retiredAt: unknown }).retiredAt === "string");
}

function isUnresolvedTermination(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.error === "string"
    && typeof record.recordedAt === "string"
    && Array.isArray(record.survivors)
    && record.survivors.every((survivor) => survivor !== null
      && typeof survivor === "object"
      && Number.isSafeInteger((survivor as { pid: unknown }).pid)
      && isNullableString((survivor as { startIdentity: unknown }).startIdentity)
      && ((survivor as { bootEpoch: unknown }).bootEpoch === undefined
        || isNullableString((survivor as { bootEpoch: unknown }).bootEpoch)));
}

function isRun(value: unknown): value is Pipeline["runs"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as { stageId?: unknown; attempts?: unknown };
  return typeof run.stageId === "string" && Array.isArray(run.attempts) && run.attempts.every(isAttempt);
}

function isFailEdge(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edge = value as { to?: unknown; maxRounds?: unknown; onExhausted?: unknown };
  return (
    typeof edge.to === "string" &&
    Number.isInteger(edge.maxRounds) &&
    (edge.maxRounds as number) >= 1 &&
    (edge.maxRounds as number) <= MAX_FAIL_EDGE_ROUNDS &&
    (edge.onExhausted === undefined || edge.onExhausted === "advance" || edge.onExhausted === "park")
  );
}

function isCreationIntent(value: unknown): value is PipelineCreationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Partial<PipelineCreationIntent>;
  return intent.kind === "task-spawn"
    && typeof intent.taskId === "string" && Boolean(intent.taskId.trim())
    && typeof intent.launchId === "string" && Boolean(intent.launchId.trim());
}

function isUnconfirmedHost(value: unknown): value is PipelineUnconfirmedHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const host = value as Partial<PipelineUnconfirmedHost>;
  return typeof host.stageId === "string"
    && Number.isInteger(host.attempt)
    && isNullableString(host.conversationId)
    && isNullableString(host.agentPath)
    && (host.paneId === undefined || isNullableString(host.paneId))
    && isNullableString(host.operationId)
    && typeof host.detail === "string"
    && typeof host.at === "string";
}

function isCloseCustody(pipeline: Partial<Pipeline>): boolean {
  const plan = pipeline.closeTeardown;
  const report = pipeline.closeReport;
  if (plan === undefined && report === undefined) return true;
  if (!plan || !report || typeof plan !== "object" || typeof report !== "object") return false;
  const host = (item: unknown): boolean => {
    if (!item || typeof item !== "object") return false;
    const ref = item as Record<string, unknown>;
    return typeof ref.stageId === "string" && Number.isInteger(ref.attempt) && Number(ref.attempt) > 0
      && isNullableString(ref.conversationId) && isNullableString(ref.agentPath) && isNullableString(ref.paneId)
      && (ref.launchId === undefined || isNullableString(ref.launchId));
  };
  const owner = plan.owner;
  return typeof plan.id === "string" && !!plan.id && ["pending", "running", "settled"].includes(plan.phase)
    && typeof plan.waitingForActivation === "boolean" && typeof plan.acknowledgeHosts === "boolean"
    && (owner === undefined || (owner && typeof owner === "object" && Number.isInteger(owner.pid) && owner.pid > 0 && isNullableString(owner.startIdentity) && isNullableString(owner.bootEpoch)))
    && (plan.flow === null || (typeof plan.flow === "object" && typeof plan.flow.id === "string"
      && typeof plan.flow.stageId === "string" && Number.isInteger(plan.flow.attempt)))
    && ["pending", "settled"].includes(report.status)
    && (plan.phase === "settled") === (report.status === "settled")
    && [report.pending, report.stopped, report.alreadyStopped, report.unconfirmed, report.acknowledged, report.stillRunning, report.notes]
      .every((items) => Array.isArray(items) && items.every(host))
    && report.unconfirmed.every((item) => isNullableString(item.operationId) && typeof item.detail === "string")
    && report.stillRunning.every((item) => typeof item.error === "string")
    && report.acknowledged.every((item) => typeof item.detail === "string")
    && report.notes.every((item) => typeof item.detail === "string")
    && Array.isArray(report.reviewers) && report.reviewers.every((item) => item && typeof item.stageId === "string"
      && Number.isInteger(item.attempt) && typeof item.flowId === "string" && Number.isInteger(item.round))
    && (report.worktree === null || (typeof report.worktree === "object" && typeof report.worktree.dir === "string"
      && Array.isArray(report.worktree.uncommitted) && report.worktree.uncommitted.every((item) => typeof item === "string")
      && typeof report.worktree.truncated === "boolean"))
    && (report.status !== "settled" || report.pending.length === 0);
}

function isTerminalReap(value: unknown): value is PipelineTerminalReap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reap = value as Partial<PipelineTerminalReap>;
  return Number.isInteger(reap.rounds) && (reap.rounds as number) >= 0
    && Number.isInteger(reap.stopped) && (reap.stopped as number) >= 0
    && typeof reap.lastAt === "string"
    && (reap.settledAttempts === undefined
      || (Array.isArray(reap.settledAttempts) && reap.settledAttempts.every((key) => typeof key === "string")))
    && isNullableString(reap.settledAt);
}

function isStage(value: unknown): value is PipelineStage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stage = value as Partial<PipelineStage>;
  const role = (value as { role?: unknown }).role;
  if (!(
    typeof stage.id === "string" &&
    (stage.kind === "run" || stage.kind === "review-loop") &&
    typeof stage.prompt === "string" &&
    (stage.next === null || typeof stage.next === "string") &&
    isFailEdge(stage.onFail) &&
    (role === undefined || Boolean(role && typeof role === "object" && !Array.isArray(role) && (PIPELINE_ROLE_IDS as readonly unknown[]).includes((role as { roleId?: unknown }).roleId))) &&
    (stage.engine === undefined || stage.engine === "claude" || stage.engine === "codex") &&
    (stage.model === undefined || stage.model === null || typeof stage.model === "string") &&
    (stage.effort === undefined || stage.effort === null || typeof stage.effort === "string") &&
    (stage.access === undefined || stage.access === "read-only" || stage.access === "read-write") &&
    (stage.sandbox === undefined || stage.sandbox === "full" || stage.sandbox === "restricted") &&
    (stage.outputs === undefined || (
      stage.kind === "run" &&
      Array.isArray(stage.outputs) &&
      stage.outputs.length > 0 && stage.outputs.length <= MAX_STAGE_OUTPUTS &&
      stage.outputs.every((output, index) => normalizeStageOutputPath(output) === output && stage.outputs!.indexOf(output) === index)
    )) &&
    isEffectiveRole(stage.effectiveRole)
  )) return false;
  const effective = stage.effectiveRole;
  const referencedRoleId = role === undefined ? null : (role as { roleId: EffectivePipelineRole["roleId"] }).roleId;
  if (stage.outputs !== undefined && effective.access !== "read-only") return false;
  if (effective.roleId !== referencedRoleId) return false;
  if (stage.kind === "review-loop" && effective.access !== "read-only") return false;
  if (stage.engine !== undefined && stage.engine !== effective.engine) return false;
  if (stage.model !== undefined && stage.model !== effective.model) return false;
  if (stage.effort !== undefined && stage.effort !== effective.effort) return false;
  if (stage.access !== undefined && stage.access !== effective.access) return false;
  if (referencedRoleId === null && effective.promptScaffold !== null) return false;
  if (referencedRoleId !== null && !effective.promptScaffold?.trim()) return false;
  return true;
}

/**
 * The v3 conversation-graph contract (#353). Verdict-keyed successors: each
 * stage has at most one pass edge (`next`) and one fail edge (`onFail`). The
 * pass graph must be acyclic (so every pass path terminates at `null`), edge
 * targets must exist, and every review-loop must be pass-reachable from a run
 * stage (it reviews a run's session). Run-stage fail edges may target any stage;
 * their cycles terminate at the per-edge round budget. Review-loop stages use
 * their bound flow for verdict recovery and cannot define `onFail`. Shared by
 * the store validator, the create-time normalizer, and the set-edge action so
 * every mutation path applies the same graph contract.
 */
export function pipelineGraphError(
  stages: ReadonlyArray<Pick<PipelineStage, "id" | "kind" | "next"> & { onFail?: Pipeline["stages"][number]["onFail"] }>,
): string | null {
  const ids = new Set(stages.map((stage) => stage.id));
  const nextOf = new Map(stages.map((stage) => [stage.id, stage.next] as const));
  for (const stage of stages) {
    if (stage.next !== null && !ids.has(stage.next)) return `stage ${stage.id} next must reference an existing stage`;
    if (stage.next === stage.id) return `stage ${stage.id} pass edge may not target itself`;
    const onFail = stage.onFail ?? null;
    if (stage.kind === "review-loop" && onFail) return `review-loop stage ${stage.id} does not support onFail`;
    if (onFail && !ids.has(onFail.to)) return `stage ${stage.id} onFail must reference an existing stage`;
    if (onFail && (!Number.isInteger(onFail.maxRounds) || onFail.maxRounds < 1 || onFail.maxRounds > MAX_FAIL_EDGE_ROUNDS)) {
      return `stage ${stage.id} onFail maxRounds must be an integer between 1 and ${MAX_FAIL_EDGE_ROUNDS}`;
    }
    if (onFail?.onExhausted !== undefined && onFail.onExhausted !== "advance" && onFail.onExhausted !== "park") {
      return `stage ${stage.id} onFail onExhausted must be advance or park`;
    }
  }
  /* Out-degree-1 pass graph: walking `next` from any stage must terminate
     within |stages| hops, else a pass cycle exists. */
  for (const stage of stages) {
    let cursor: string | null = stage.next;
    for (let hops = 0; cursor !== null; hops += 1) {
      if (cursor === stage.id || hops > stages.length) return `pipeline pass edges form a cycle through stage ${stage.id}`;
      cursor = nextOf.get(cursor) ?? null;
    }
  }
  for (const stage of stages) {
    if (stage.kind !== "review-loop") continue;
    const reachable = stages.some((candidate) => {
      if (candidate.kind !== "run") return false;
      let cursor: string | null = candidate.next;
      for (let hops = 0; cursor !== null && hops <= stages.length; hops += 1) {
        if (cursor === stage.id) return true;
        cursor = nextOf.get(cursor) ?? null;
      }
      return false;
    });
    /* #1026: this used to say "review-loop stage requires a preceding run
       stage", which reads as an ordering rule and sent a caller reordering an
       array that was already in the right order. The defect is a missing pass
       edge: stages default to `next: null`, so nothing reaches the review-loop.
       Name the unreachable stage and the edge that would reach it. */
    if (!reachable) {
      const runStages = stages.filter((candidate) => candidate.kind === "run");
      if (runStages.length === 0) {
        return `review-loop stage ${stage.id} is unreachable: the pipeline has no run stage, and a review-loop reviews the session of a run stage that reaches it`;
      }
      const source = runStages.findLast((candidate) => candidate.next === null) ?? runStages.at(-1)!;
      return `review-loop stage ${stage.id} is unreachable: no run stage's next chain reaches it — set next: "${stage.id}" on run stage ${source.id}`;
    }
  }
  return null;
}

function isDelivery(value: unknown): value is NonNullable<Pipeline["delivery"]> {
  if (!value || typeof value !== "object") return false;
  const delivery = value as NonNullable<Pipeline["delivery"]>;
  const target = delivery.target;
  if (!target || typeof target.repository !== "string" || !target.repository || typeof target.remote !== "string"
    || typeof target.branch !== "string" || !target.branch.startsWith("refs/heads/")
    || !["owner", "comparison"].includes(delivery.disposition) || !["enabled", "disabled"].includes(delivery.publish)
    || typeof delivery.ownerId !== "string" || !delivery.ownerId || !Number.isSafeInteger(delivery.epoch) || delivery.epoch < 1
    || typeof delivery.active !== "boolean" || !Array.isArray(delivery.journal) || delivery.journal.length > 100) return false;
  if (delivery.disposition === "comparison" && (delivery.active || delivery.publish !== "disabled")) return false;
  if (delivery.active && delivery.publish !== "enabled") return false;
  const operation = delivery.operation;
  return !operation || (typeof operation.id === "string" && typeof operation.sha === "string"
    && Number.isSafeInteger(operation.epoch) && operation.epoch === delivery.epoch
    && ["pending", "running", "settled"].includes(operation.state));
}

function isDecisionAnswer(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return typeof answer.clientRequestId === "string" && answer.clientRequestId.length > 0 && answer.clientRequestId.length <= 200
    && typeof answer.expectedRevision === "string" && /^[0-9a-f]{64}$/.test(answer.expectedRevision)
    && typeof answer.stageId === "string" && answer.stageId.length > 0
    && Number.isSafeInteger(answer.attempt) && (answer.attempt as number) > 0
    && Number.isSafeInteger(answer.nextAttempt) && (answer.nextAttempt as number) > (answer.attempt as number)
    && typeof answer.question === "string"
    && typeof answer.answer === "string" && answer.answer.trim().length > 0 && answer.answer.length <= MAX_DECISION_ANSWER_CHARS
    && isActor(answer.actor) && typeof answer.at === "string";
}

function isPipeline(value: unknown): value is Pipeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pipeline = value as Partial<Pipeline>;
  if (!(
    typeof pipeline.id === "string" &&
    isCloseCustody(pipeline) &&
    (pipeline.activationCloseRequested === undefined || typeof pipeline.activationCloseRequested === "boolean") &&
    (pipeline.delivery === undefined || (isDelivery(pipeline.delivery) && (!pipeline.delivery.active || pipeline.delivery.ownerId === pipeline.id))) &&
    (pipeline.creationRequest === undefined || (typeof pipeline.creationRequest.key === "string" && !!pipeline.creationRequest.key && typeof pipeline.creationRequest.digest === "string")) &&
    typeof pipeline.task === "string" &&
    Array.isArray(pipeline.taskIds) &&
    pipeline.taskIds.every((taskId) => typeof taskId === "string") &&
    new Set(pipeline.taskIds).size === pipeline.taskIds.length &&
    (pipeline.creationIntent === undefined || isCreationIntent(pipeline.creationIntent)) &&
    (pipeline.spec === undefined || typeof pipeline.spec === "string") &&
    typeof pipeline.project === "string" &&
    typeof pipeline.repoDir === "string" &&
    typeof pipeline.worktreeDir === "string" &&
    typeof pipeline.branch === "string" &&
    typeof pipeline.baseBranch === "string" &&
    typeof pipeline.baseRef === "string" &&
    typeof pipeline.lastPassedCommit === "string" &&
    (pipeline.publication === undefined || pipeline.publication === "internal" || pipeline.publication === "remote-branch") &&
    (pipeline.publishedCommit === undefined || isNullableString(pipeline.publishedCommit)) &&
    Array.isArray(pipeline.stages) &&
    pipeline.stages.every(isStage) &&
    Array.isArray(pipeline.runs) &&
    pipeline.runs.every(isRun) &&
    ["draft", "provisioning", "running", "needs_decision", "paused", "completed", "closed"].includes(String(pipeline.state)) &&
    (pipeline.pausedState === null || ["provisioning", "running", "needs_decision", "completed", "closed"].includes(String(pipeline.pausedState))) &&
    (pipeline.pausedAt === undefined || isNullableString(pipeline.pausedAt)) &&
    (pipeline.resumedAt === undefined || isNullableString(pipeline.resumedAt)) &&
    isNullableString(pipeline.stateDetail) &&
    isNullableString(pipeline.srcPath) &&
    isNullableString(pipeline.srcConversationId) &&
    typeof pipeline.createdAt === "string" &&
    isNullableString(pipeline.closedAt) &&
    (pipeline.hiddenAt === undefined || isNullableString(pipeline.hiddenAt)) &&
    (pipeline.dismissedAt === undefined || isNullableString(pipeline.dismissedAt)) &&
    (pipeline.unconfirmedHosts === undefined
      || (Array.isArray(pipeline.unconfirmedHosts) && pipeline.unconfirmedHosts.every(isUnconfirmedHost))) &&
    (pipeline.terminalReap === undefined || isTerminalReap(pipeline.terminalReap)) &&
    (pipeline.restored === undefined || typeof pipeline.restored === "boolean") &&
    (pipeline.decisionAnswers === undefined || (Array.isArray(pipeline.decisionAnswers) && pipeline.decisionAnswers.every(isDecisionAnswer))) &&
    (pipeline.graphEdits === undefined || (Array.isArray(pipeline.graphEdits) && pipeline.graphEdits.length <= MAX_PIPELINE_GRAPH_EDITS && pipeline.graphEdits.every(isGraphEdit))) &&
    (pipeline.stageReports === undefined || (Array.isArray(pipeline.stageReports) && pipeline.stageReports.length <= MAX_PIPELINE_STAGE_REPORTS && pipeline.stageReports.every(isStageReportEntry))) &&
    (pipeline.pos === undefined || (
      typeof pipeline.pos === "object" && pipeline.pos !== null &&
      Number.isFinite(pipeline.pos.x) && Number.isFinite(pipeline.pos.y)
    ))
  )) return false;
  const stages = pipeline.stages as PipelineStage[];
  const runs = pipeline.runs as Pipeline["runs"];
  /* A draft is a scratchpad the operator assembles on the canvas (#136), so it
     may hold 0–8 stages (v2 legacy shells are seeded on migration, but a raw
     empty draft still loads and stays off the board projection). Every
     non-draft state keeps the 1–8 invariant (#353: the minimum graph is one
     implement conversation). */
  const minStages = pipeline.state === "draft" ? 0 : 1;
  if (stages.length < minStages || stages.length > MAX_PIPELINE_STAGES || runs.length !== stages.length) return false;
  const ids = stages.map((stage) => stage.id);
  if (new Set(ids).size !== ids.length) return false;
  if (pipelineGraphError(stages) !== null) return false;
  if (runs.some((run, index) => run.stageId !== stages[index]!.id)) return false;
  const expectedWorktree = path.join(path.dirname(pipeline.repoDir!), `${path.basename(pipeline.repoDir!)}-pipeline-${pipeline.id}`);
  if (pipeline.worktreeDir !== expectedWorktree || pipeline.branch !== `pipeline/${slugify(pipeline.task!)}-${pipeline.id}`) return false;
  const cursor = pipeline.cursor;
  if (cursor !== null && (
    !cursor ||
    typeof cursor !== "object" ||
    !ids.includes(cursor.stageId) ||
    !["pending", "spawning", "running", "reviewing", "committing"].includes(cursor.state) ||
    !(cursor.input === undefined || isNullableString(cursor.input)) ||
    !isActivation(cursor.activatedBy) ||
    (cursor.activatedBy != null && !ids.includes(cursor.activatedBy.stageId))
  )) return false;
  if ((pipeline.state === "completed" || pipeline.state === "closed") && cursor !== null) return false;
  if (pipeline.state === "draft") {
    /* An empty draft has no stage to point the cursor at; once it holds stages the
       cursor rests on the first, pending (Start spawns from there). */
    if (stages.length === 0) {
      if (cursor !== null) return false;
    } else if (cursor?.stageId !== stages[0]!.id || cursor.state !== "pending") return false;
    if (runs.some((run) => run.attempts.length > 0)) return false;
    const baseEmpty = !pipeline.baseBranch && !pipeline.baseRef && !pipeline.lastPassedCommit;
    const basePinned = Boolean(
      pipeline.baseBranch &&
      /^[0-9a-f]{40}$/i.test(pipeline.baseRef!) &&
      pipeline.lastPassedCommit === pipeline.baseRef,
    );
    if ((!baseEmpty && !basePinned) || pipeline.closedAt) return false;
  }
  return true;
}

/** The seeded default action (#353): every pipeline, including a migrated v2
    empty shell, holds at least one implement conversation. Role-less claude/
    read-write defaults keep the seed independent of the role registry, so a
    read-only load can never fail on role resolution. */
function defaultImplementStage(): PipelineStage {
  return {
    id: "implement",
    kind: "run",
    "prompt": "{{task}}",
    next: null,
    onFail: null,
    effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null },
  };
}

/**
 * In-memory v2 → v3 migration (#353). Purely additive on history: every stage
 * gains `onFail: null`, every attempt/cursor gains `input: null` /
 * `activatedBy: null` (truthful "unknown provenance" — the engine's positional
 * fallback keeps an in-flight v2 pipeline running byte-identically), and a
 * zero-stage draft shell is seeded with the default implement stage. The file
 * itself is rewritten as v3 only by the next successful mutation.
 */
function migrateV2Pipeline(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const pipeline = raw as Record<string, unknown>;
  const stages = Array.isArray(pipeline.stages)
    ? (pipeline.stages as unknown[]).map((stage) => (stage && typeof stage === "object" ? { onFail: null, ...(stage as Record<string, unknown>) } : stage))
    : pipeline.stages;
  const runs = Array.isArray(pipeline.runs)
    ? (pipeline.runs as unknown[]).map((run) => (run && typeof run === "object" && Array.isArray((run as { attempts?: unknown }).attempts)
        ? {
            ...(run as Record<string, unknown>),
            attempts: (run as { attempts: unknown[] }).attempts.map((attempt) =>
              (attempt && typeof attempt === "object" ? { input: null, activatedBy: null, ...(attempt as Record<string, unknown>) } : attempt)),
          }
        : run))
    : pipeline.runs;
  const cursor = pipeline.cursor && typeof pipeline.cursor === "object"
    ? { input: null, activatedBy: null, ...(pipeline.cursor as Record<string, unknown>) }
    : pipeline.cursor;
  const migrated: Record<string, unknown> = { ...pipeline, stages, runs, cursor };
  if (migrated.state === "draft" && Array.isArray(migrated.stages) && migrated.stages.length === 0) {
    const seed = defaultImplementStage();
    migrated.stages = [seed];
    migrated.runs = [{ stageId: seed.id, attempts: [] }];
    migrated.cursor = { stageId: seed.id, state: "pending", input: null, activatedBy: null };
  }
  return migrated;
}

function migrateTaskIds(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return { taskIds: [], ...(raw as Record<string, unknown>) };
}

/** v4 accepted review-loop fail edges even though the embedded flow owns every
    review verdict and no engine path could traverse those edges. Clear that
    unreachable configuration before the v5 graph validator runs. */
function migrateReviewLoopFailEdges(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const pipeline = raw as Record<string, unknown>;
  if (!Array.isArray(pipeline.stages)) return raw;
  return {
    ...pipeline,
    ...(pipeline.delivery ? { delivery: structuredClone(pipeline.delivery) } : {}),
    ...(pipeline.creationRequest ? { creationRequest: { ...pipeline.creationRequest } } : {}),
    stages: pipeline.stages.map((stage) => {
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) return stage;
      const record = stage as Record<string, unknown>;
      return record.kind === "review-loop" ? { ...record, onFail: null } : stage;
    }),
  };
}

function migratePipelineRecord(raw: unknown, schemaVersion: number): unknown {
  let migrated = schemaVersion === 2 ? migrateV2Pipeline(raw) : raw;
  if (schemaVersion < 4) migrated = migrateTaskIds(migrated);
  if (schemaVersion < 5) migrated = migrateReviewLoopFailEdges(migrated);
  return migrated;
}

export function loadPipelines(): Pipeline[] {
  return pipelineStore().snapshot();
}

/** Startup needs fresh, complete authority, including cold records. Read both
    collections in one SQLite snapshot without projection caches or lenient
    archive decoding. Before cutover, validate the legacy sources in memory;
    this evidence read never migrates or rewrites an unreadable source. */
export function loadPipelinesForStartup(): Pipeline[] {
  const collections = readStateCollectionsRows(stateDatabaseFile(), ["pipelines", "pipelines_archive"]);
  const active = collections.get("pipelines");
  const archived = collections.get("pipelines_archive");
  if ((active === null) !== (archived === null)) {
    throw new PipelineStoreError("pipeline startup collections are incomplete");
  }
  const records = active === null && archived === null
    ? [...parsePipelinesFile(pipelinesFile(), false, true), ...parsePipelinesFile(pipelinesArchiveFile(), false, true)]
    : [...(active ?? []), ...(archived ?? [])];
  if (!records.every(isPipeline)) throw new PipelineStoreError("pipeline registry contains malformed records");
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new PipelineStoreError("pipeline startup records have contradictory identities");
  }
  return records.map(reviveLoadedPipeline);
}

function parsePipelinesFile(filename: string, lenient: boolean, strictPresence = false): Pipeline[] {
  const raw = readJson(filename);
  // Ordinary legacy readers historically accept null as empty. Startup must
  // distinguish that malformed content from positive missing-file evidence.
  if (raw === undefined || (raw === null && !strictPresence)) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (lenient) return [];
    throw new PipelineStoreError("pipeline registry must be an object");
  }
  const file = raw as Partial<PipelineFile>;
  if (typeof file.schemaVersion !== "number" || !MIGRATABLE_SCHEMA_VERSIONS.has(file.schemaVersion)) {
    if (lenient) return [];
    throw new PipelineStoreError(`unsupported pipeline registry schema: ${String(file.schemaVersion)}`);
  }
  if (!Array.isArray(file.pipelines)) {
    if (lenient) return [];
    throw new PipelineStoreError("pipeline registry contains malformed records");
  }
  const records = file.pipelines.map((pipeline) => migratePipelineRecord(pipeline, file.schemaVersion!));
  if (!lenient && !records.every(isPipeline)) throw new PipelineStoreError("pipeline registry contains malformed records");
  const accepted = lenient ? records.filter(isPipeline) : records as Pipeline[];
  if (lenient && accepted.length !== records.length) {
    console.error(`[pipelines] skipped ${records.length - accepted.length} malformed archived pipeline record(s)`);
  }
  return accepted.map(reviveLoadedPipeline);
}

export function planPipelineStateMigration(): {
  pipelines: { records: number; keys: string[] };
  archive: { records: number; keys: string[] };
} {
  const pipelines = parsePipelinesFile(pipelinesFile(), false);
  const archive = parsePipelinesFile(pipelinesArchiveFile(), true);
  return {
    pipelines: { records: pipelines.length, keys: pipelines.map((pipeline) => pipeline.id) },
    archive: { records: archive.length, keys: archive.map((pipeline) => pipeline.id) },
  };
}

/** Fresh per-call copies of every layer a caller may write (pipeline, stage,
    run, attempt, cursor rows), so cached records stay pristine while callers
    receive independently mutable structures. Deep config leaves are shared. */
function reviveLoadedPipeline(pipeline: Pipeline): Pipeline {
  const settledAttempts = pipeline.terminalReap?.settledAttempts
    ?? (pipeline.terminalReap?.settledAt
      ? pipeline.runs.flatMap((run) => run.attempts
          .filter((attempt) => Boolean(attempt.verdict || attempt.completedAt))
          .map((attempt) => `${run.stageId}:${attempt.n}`))
      : []);
  return {
    ...pipeline,
    closeTeardown: pipeline.closeTeardown ? structuredClone(pipeline.closeTeardown) : undefined,
    closeReport: pipeline.closeReport ? structuredClone(pipeline.closeReport) : undefined,
    project: canonicalProject(pipeline.project),
    taskIds: [...pipeline.taskIds],
    creationIntent: pipeline.creationIntent ? { ...pipeline.creationIntent } : undefined,
    spec: typeof pipeline.spec === "string" ? pipeline.spec : undefined,
    baseBranch: pipeline.baseBranch ?? "",
    baseRef: pipeline.baseRef ?? "",
    lastPassedCommit: pipeline.lastPassedCommit ?? "",
    publishedCommit: pipeline.publishedCommit ?? null,
    pausedState: pipeline.pausedState ?? null,
    stateDetail: pipeline.stateDetail ?? null,
    srcPath: pipeline.srcPath ?? null,
    srcConversationId: pipeline.srcConversationId ?? null,
    closedAt: pipeline.closedAt ?? null,
    hiddenAt: pipeline.hiddenAt ?? null,
    unconfirmedHosts: pipeline.unconfirmedHosts?.length
      ? pipeline.unconfirmedHosts.map((host) => ({ ...host }))
      : undefined,
    terminalReap: pipeline.terminalReap
      ? { ...pipeline.terminalReap, settledAttempts: [...settledAttempts] }
      : undefined,
    restored: undefined,
    stages: pipeline.stages.map((stage) => ({ ...stage, onFail: stage.onFail ?? null })),
    cursor: pipeline.cursor
      ? { ...pipeline.cursor, input: pipeline.cursor.input ?? null, activatedBy: pipeline.cursor.activatedBy ?? null }
      : null,
    runs: pipeline.runs.map((run) => ({
      ...run,
      attempts: Array.isArray(run.attempts)
        ? run.attempts.map((attempt) => ({
            ...attempt,
            launchId: attempt.launchId ?? null,
            conversationId: attempt.conversationId ?? null,
            sessionId: attempt.sessionId ?? null,
            agentPath: attempt.agentPath ?? null,
            paneId: attempt.paneId ?? null,
            ...(attempt.usageLimitedAccounts
              ? { usageLimitedAccounts: attempt.usageLimitedAccounts.map((limited) => ({ ...limited })) }
              : {}),
            flowId: attempt.flowId ?? null,
            expectedReviewHeadSha: attempt.expectedReviewHeadSha ?? null,
            reviewHeadSha: attempt.reviewHeadSha ?? null,
            reviewFlowSync: attempt.reviewFlowSync ? { ...attempt.reviewFlowSync } : undefined,
            startedAt: attempt.startedAt ?? null,
            completedAt: attempt.completedAt ?? null,
            input: attempt.input ?? null,
            activatedBy: attempt.activatedBy ?? null,
            output: attempt.output ?? null,
            verdict: attempt.verdict ?? null,
            error: attempt.error ?? null,
            verdictRecovery: attempt.verdictRecovery ? { ...attempt.verdictRecovery } : undefined,
            ...(attempt.retiredLaunches
              ? { retiredLaunches: attempt.retiredLaunches.map((retired) => ({ ...retired })) }
              : {}),
            unresolvedTermination: attempt.unresolvedTermination
              ? { ...attempt.unresolvedTermination, survivors: attempt.unresolvedTermination.survivors.map((survivor) => ({ ...survivor })) }
              : undefined,
          }))
        : [],
    })),
  };
}

let projectionCache: { signature: string; pipelines: Pipeline[] } | null = null;
const pipelineStores = new Map<string, {
  active: SqliteStateCollection<Pipeline>;
  archive: SqliteStateCollection<Pipeline>;
}>();

function decodePipeline(value: unknown): Pipeline | null {
  if (!isPipeline(value)) throw new PipelineStoreError("pipeline registry contains malformed records");
  return reviveLoadedPipeline(value);
}

function pipelineControllerActive(pipeline: Pipeline): boolean {
  if (pipeline.closeTeardown) return pipeline.closeTeardown.phase !== "settled";
  if (pipeline.activationCloseRequested) return true;
  if (pipeline.state === "closed") return Boolean(pipeline.unconfirmedHosts?.length);
  if (pipeline.state === "completed") {
    return Boolean(pipeline.unconfirmedHosts?.length) || !pipeline.terminalReap?.settledAt;
  }
  return true;
}

export function pipelineStateCollectionSeeds(): [StateCollectionSeed<Pipeline>, StateCollectionSeed<Pipeline>] {
  return [
    {
      collection: "pipelines",
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      migrationId: "pipelines-json-v1",
      loadRecords: () => parsePipelinesFile(pipelinesFile(), false),
      key: (pipeline: Pipeline) => pipeline.id,
      controllerActive: pipelineControllerActive,
    },
    {
      collection: "pipelines_archive",
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      migrationId: "pipelines-archive-json-v1",
      loadRecords: () => parsePipelinesFile(pipelinesArchiveFile(), true),
      key: (pipeline: Pipeline) => pipeline.id,
      controllerActive: () => false,
    },
  ];
}

function stores(): { active: SqliteStateCollection<Pipeline>; archive: SqliteStateCollection<Pipeline> } {
  const filename = stateDatabaseFile();
  const held = pipelineStores.get(filename);
  if (held) return held;
  initializeStateCollections(filename, pipelineStateCollectionSeeds());
  const common = {
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    busyMessage: "pipeline state is busy",
    key: (pipeline: Pipeline) => pipeline.id,
    decode: decodePipeline,
    clone: reviveLoadedPipeline,
    decodeError: (error: unknown) => error instanceof PipelineStoreError
      ? error
      : new PipelineStoreError("pipeline registry contains malformed records", { cause: error }),
    validate: (pipeline: Pipeline) => {
      releaseTerminalDelivery(pipeline);
      if (!isPipeline(pipeline)) {
        throw new PipelineStoreError("refusing to persist a malformed pipeline record");
      }
    },
  };
  const active = new SqliteStateCollection<Pipeline>(filename, {
    ...common,
    collection: "pipelines",
    controllerActive: pipelineControllerActive,
    strictDecode: true,
  });
  const archive = new SqliteStateCollection<Pipeline>(filename, {
    ...common,
    collection: "pipelines_archive",
    onDecodeError: (error) => console.error("[pipelines] skipped malformed archived SQLite row", error),
  });
  const created = { active, archive };
  pipelineStores.set(filename, created);
  return created;
}

function pipelineStore(): SqliteStateCollection<Pipeline> {
  return stores().active;
}

function archiveStore(): SqliteStateCollection<Pipeline> {
  return stores().archive;
}

function pipelinesFileSignature(): string {
  return pipelineStore().signature();
}

/** The validated pipeline projection keeps the signature cache introduced for
    the JSON store. SQLite collection revisions invalidate it across processes.
    The records are the cache itself — only the exported readers below decide
    what a caller may do with them. */
function cachedPipelines(): Pipeline[] {
  const before = pipelinesFileSignature();
  if (projectionCache?.signature === before) return projectionCache.pipelines;
  const pipelines = [...pipelineStore().loadReadonly()];
  const after = pipelinesFileSignature();
  if (before === after) projectionCache = { signature: after, pipelines };
  return pipelines;
}

/** Read-only load for request-path projections (issue #798): no lease, and the
    validated registry is cached against the SQLite collection revision.
    Every call still returns independently mutable records via the same revive
    pass `loadPipelines` uses, so a projection overlay can never write into the
    cache. */
export function loadPipelinesForProjection(): Pipeline[] {
  return cachedPipelines().map((pipeline) => withDeliveryPublicationDetail(reviveLoadedPipeline(pipeline)));
}

/** Reuse the lane card's existing publication/detail slot. Never persist this
    presentation overlay or feed it into a controller mutation. */
export function withDeliveryPublicationDetail(pipeline: Pipeline): Pipeline {
  const delivery = pipeline.delivery;
  if (!delivery) return pipeline;
  const publication = `Viewer publication: ${delivery.disposition}; owner ${delivery.ownerId}, epoch ${delivery.epoch}${delivery.publish === "disabled" ? "; disabled" : ""}`;
  const detail = pipeline.stateDetail;
  return { ...pipeline, stateDetail: detail?.includes(publication) ? detail : [detail, publication].filter(Boolean).join(" · ") };
}

/** The registry read behind bounded list projections (issue #863).
 *
 * Deliberately skips the per-caller `reviveLoadedPipeline` pass that every other
 * reader pays: a list page filters and slices these records and then copies only
 * the handful of scalars a row needs, so materializing mutable copies of 500
 * pipelines' nested stage/attempt history — for rows that are about to be
 * dropped, out of fields a list never returns — is pure waste.
 *
 * The price is that these ARE the cached records. Read them; never write them.
 * Anything that mutates a pipeline goes through `withPipelineMutation`, and
 * anything that overlays one takes `loadPipelinesForProjection`.
 */
export function loadPipelinesForList(): readonly Pipeline[] {
  return cachedPipelines();
}

/** How long a pipeline mutation waits for the registry lease before it refuses
    (#1766). The default is the cap the attempt loop in the state store already
    imposed; `LLV_PIPELINE_LOCK_WAIT_MS` bounds it lower, which is what lets a
    test prove the wait cannot hang a request. The wait matters because the
    lease is held across whole controller passes: a create issued while
    pipelines provision waits here rather than refusing on contact. */
const DEFAULT_PIPELINE_LOCK_WAIT_MS = 30_000;

export function pipelineLockWaitMs(): number {
  const configured = Number(process.env.LLV_PIPELINE_LOCK_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_PIPELINE_LOCK_WAIT_MS;
}

/** Serialize every production read-modify-write across Viewer and MCP processes.
 *
 * A refusal raised before `mutate` runs is a {@link StoreBusyBeforeAdmissionError}
 * (#1766): the lease was never taken, so nothing was read, written or reserved
 * and the same request may run again under the same idempotency key. A busy
 * error from anywhere after that keeps its ordinary ambiguous meaning — the
 * lease release raises the same message after the row is committed. */
export async function withPipelineMutation<T>(
  mutate: (pipelines: Pipeline[], persist: {
    (): void;
    (records: readonly Pipeline[]): void;
  }) => Promise<T> | T,
): Promise<T> {
  return refuseBusyBeforeAdmission((admitted) => pipelineStore().mutate((pipelines, persist) => {
    admitted();
    return mutate(pipelines, persist);
  }, undefined, false, pipelineLockWaitMs()));
}

export async function withPipelineControllerMutation<T>(
  mutate: (pipelines: Pipeline[], persist: {
    (): void;
    (records: readonly Pipeline[]): void;
  }) => Promise<T> | T,
): Promise<T> {
  return pipelineStore().mutate(mutate, undefined, true);
}

/** Hold the existing cross-process mutation lease through startup admission.
 * Unavailable state or authority permits only the caller's deferred path.
 * Never reinterpret a failure inside admission as permission to run it again.
 */
export async function withPipelineStartupAdmission<T>(
  admit: (available: boolean) => Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    // Refuse malformed legacy archives before the ordinary store can migrate
    // them leniently. Admission rereads under the lease before any effects.
    loadPipelinesForStartup();
    return await withPipelineMutation(() => {
      entered = true;
      return admit(true);
    });
  } catch (error) {
    if (entered) throw error;
    return admit(false);
  }
}

export function deliveryJournal(pipeline: Pipeline, kind: NonNullable<Pipeline["delivery"]>["journal"][number]["kind"], reason: string, conversationId: string | null = null): void {
  const delivery = pipeline.delivery!;
  delivery.journal = [...delivery.journal, { at: new Date().toISOString(), kind, ownerId: delivery.ownerId, epoch: delivery.epoch, conversationId, reason }].slice(-100);
}

function terminalDeliveryFailure(pipeline: Pipeline): string | null {
  const terminalAttempt = pipeline.state === "needs_decision" && pipeline.cursor
    ? pipeline.runs.find((run) => run.stageId === pipeline.cursor!.stageId)?.attempts.findLast((attempt) => !attempt.historical)
    : null;
  return terminalAttempt?.verdict?.status === "fail" && terminalAttempt.completedAt
    ? `${pipeline.cursor!.stageId}:${terminalAttempt.n}:${terminalAttempt.startedAt ?? ""}` : null;
}

function releaseTerminalDelivery(pipeline: Pipeline): void {
  if (pipeline.closeTeardown && (pipeline.closeTeardown.phase !== "settled" || pipeline.closeReport?.stillRunning.length || pipeline.closeReport?.unconfirmed.length)) return;
  const delivery = pipeline.delivery;
  const failure = terminalDeliveryFailure(pipeline);
  const failed = failure !== null && failure !== delivery?.settledFailure;
  if (!delivery?.active || (pipeline.state !== "closed" && pipeline.state !== "completed" && !failed)) return;
  // An interrupted external write remains fenced until its result is known.
  if (delivery.operation?.state === "running") return;
  delivery.active = false;
  delivery.publish = "disabled";
  delivery.releasedAt = pipeline.closedAt ?? new Date().toISOString();
  if (failed) delivery.settledFailure = failure;
  deliveryJournal(pipeline, "release", failed ? "terminal failure without an active fail edge" : `pipeline ${pipeline.state}`);
}

export function pipelineDeliveryLookup(query: { requestKey: string } | { repository: string; branch: string; active?: boolean }): Pipeline | null {
  return pipelineStore().pipelineLookup(query);
}

export function unclaimedPipelinePublications(): Pipeline[] {
  return pipelineStore().unclaimedPipelinePublications();
}

export function withDeliveryMutation<R>(operation: (tx: StateBoundedTransaction<Pipeline>) => R): R {
  return pipelineStore().boundedPatch(16, operation);
}

export async function withDeliveryMutationAsync<R>(operation: (tx: StateBoundedTransaction<Pipeline>) => R): Promise<R> {
  return refuseBusyBeforeAdmission((admitted) => pipelineStore().boundedPatchAsync(16, (tx) => {
    admitted();
    return operation(tx);
  }, pipelineLockWaitMs()));
}

/** Called under the existing pipeline lease; indexed reads, no provisioning. */
export function assignPipelineDelivery(pipeline: Pipeline, target: PipelineDeliveryTarget, comparison = false,
  lookup: typeof pipelineDeliveryLookup = pipelineDeliveryLookup): void {
  const owner = lookup({ ...target, active: true });
  const previous = lookup(target);
  const epoch = owner?.delivery?.epoch ?? (comparison && previous?.delivery ? previous.delivery.epoch : (previous?.delivery?.epoch ?? 0) + 1);
  pipeline.delivery = {
    target, disposition: owner || comparison ? "comparison" : "owner",
    publish: owner || comparison ? "disabled" : "enabled",
    ownerId: owner?.id ?? (comparison ? previous?.delivery?.ownerId : undefined) ?? pipeline.id, epoch, active: !owner && !comparison, journal: [],
  };
  if (pipeline.delivery.disposition === "comparison") pipeline.publication = "internal";
  deliveryJournal(pipeline, pipeline.delivery.disposition === "owner" ? "claim" : "comparison",
    owner ? `target owned by ${owner.id} at epoch ${epoch}` : comparison ? "comparison requested; no active owner" : "target claimed", pipeline.srcConversationId);
}

export async function createPipelineWithDelivery(pipeline: Pipeline, target: PipelineDeliveryTarget, comparison = false): Promise<Pipeline> {
  return withDeliveryMutationAsync((tx) => {
    if (pipeline.creationRequest) {
      const replay = tx.pipelineLookup({ requestKey: pipeline.creationRequest.key });
      if (replay) {
        if (replay.creationRequest?.digest !== pipeline.creationRequest.digest) throw new Error("idempotency_conflict: creation arguments changed");
        return replay;
      }
    }
    assignPipelineDelivery(pipeline, target, comparison, tx.pipelineLookup);
    tx.put(pipeline);
    return pipeline;
  });
}

export function deliveryOwnerError(pipeline: Pipeline, owner: Pipeline | null): string | null {
  const delivery = pipeline.delivery;
  if (delivery?.active && delivery.publish === "enabled" && delivery.disposition === "owner"
    && owner?.id === pipeline.id && owner.delivery?.epoch === delivery.epoch
    && pipeline.state !== "closed" && pipeline.state !== "completed") return null;
  return `Viewer publication denied: target owner is ${owner?.id ?? delivery?.ownerId ?? "unclaimed"} at epoch ${owner?.delivery?.epoch ?? delivery?.epoch ?? 0}; this lane must request explicit takeover`;
}

export async function takeoverPipelineDelivery(id: string, expectedOwner: string, expectedEpoch: number, reason: string, conversationId: string | null): Promise<{ pipeline?: Pipeline; error?: string; status?: number }> {
  return withDeliveryMutationAsync((tx) => {
    const pipeline = tx.get(id);
    if (!pipeline?.delivery) return { error: "pipeline has no delivery target", status: 409 };
    const target = pipeline.delivery.target;
    const owner = tx.pipelineLookup({ ...target, active: true });
    const previous = owner ?? tx.pipelineLookup(target);
    if (!previous?.delivery || previous.delivery.ownerId !== expectedOwner || previous.delivery.epoch !== expectedEpoch) {
      return { error: `delivery owner changed: current owner ${previous?.delivery?.ownerId ?? "none"}, epoch ${previous?.delivery?.epoch ?? 0}`, status: 409 };
    }
    const old = tx.get(expectedOwner);
    if (old?.delivery?.operation?.state === "running") return { error: `publisher ${expectedOwner} at epoch ${expectedEpoch} is in flight or its outcome is uncertain; reconcile it before takeover`, status: 409 };
    if (pipeline.state === "closed" || pipeline.state === "completed") return { error: "a terminal lane cannot take ownership", status: 409 };
    if (old?.delivery) {
      old.delivery.active = false;
      old.delivery.publish = "disabled";
      old.delivery.releasedAt = new Date().toISOString();
      deliveryJournal(old, "release", reason, conversationId);
      tx.put(old);
    }
    pipeline.delivery = { target, disposition: "owner", publish: "enabled", active: true,
      ownerId: pipeline.id, epoch: expectedEpoch + 1, journal: pipeline.delivery.journal,
      settledFailure: terminalDeliveryFailure(pipeline) ?? pipeline.delivery.settledFailure };
    pipeline.publishedCommit = null;
    deliveryJournal(pipeline, "takeover", reason, conversationId);
    tx.put(pipeline);
    return { pipeline };
  });
}

export function savePipelines(pipelines: Pipeline[]): void {
  pipelineStore().replaceSync(pipelines);
}

/** Settled records leave the hot registry after this long; the archive keeps
    the full record for the closed list and by-id reads. */
const SETTLED_PIPELINE_ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Lenient read: the archive is cold storage, so a malformed or legacy record
    is skipped with a log line instead of poisoning every closed-list read. */
export function loadArchivedPipelines(): Pipeline[] {
  return archiveStore().snapshot();
}

function pipelineSettledForArchive(pipeline: Pipeline, nowMs: number): boolean {
  if (pipeline.closeTeardown && (pipeline.closeTeardown.phase !== "settled" || pipeline.closeReport?.stillRunning.length || pipeline.closeReport?.unconfirmed.length)) return false;
  if (pipeline.activationCloseRequested) return false;
  if (pipeline.delivery?.active || pipeline.delivery?.operation?.state === "running") return false;
  /* Closed records archive on closedAt. A discarded draft now closes like
     anything else (#1274), but records discarded before that fix are hidden
     with no closedAt at all, so their hiddenAt still stands in. Anything still
     actionable (running, needs_decision, visible drafts) stays hot. */
  const settledAt = pipeline.closedAt ?? (pipeline.state === "draft" ? pipeline.hiddenAt : null);
  if (!settledAt) return false;
  const parsed = Date.parse(settledAt);
  return Number.isFinite(parsed) && nowMs - parsed > SETTLED_PIPELINE_ARCHIVE_AFTER_MS;
}

/** Move settled records out of the hot registry. The former JSON path parsed
    and rewrote every record here; the archive collection now receives only the
    settled rows before the active collection drops them. */
export async function archiveSettledPipelines(
  nowMs = Date.now(),
  options: { beforeCommit?: () => void } = {},
): Promise<number> {
  return pipelineStore().moveMatchingTo(
    archiveStore(),
    (pipeline) => pipelineSettledForArchive(pipeline, nowMs),
    options,
  );
}

export function checkpointPipelineRollbackMirrorsForDemotion(): { pipelines: number; pipelinesArchive: number } {
  const { active, archive } = stores();
  const pipelines = active.checkpointMirrorForDemotion((pipelines, revision) => {
    atomicWriteJson(pipelinesFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, _sqliteRevision: revision, pipelines });
  });
  const pipelinesArchive = archive.checkpointMirrorForDemotion((pipelines, revision) => {
    atomicWriteJson(pipelinesArchiveFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, _sqliteRevision: revision, pipelines });
  });
  return { pipelines, pipelinesArchive };
}

export async function checkpointPipelineRollbackMirrorsForDemotionAsync(): Promise<{ pipelines: number; pipelinesArchive: number }> {
  const { active, archive } = stores();
  const pipelines = await active.checkpointMirrorForDemotionAsync((pipelines, revision) => {
    atomicWriteJson(pipelinesFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, _sqliteRevision: revision, pipelines });
  });
  const pipelinesArchive = await archive.checkpointMirrorForDemotionAsync((pipelines, revision) => {
    atomicWriteJson(pipelinesArchiveFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, _sqliteRevision: revision, pipelines });
  });
  return { pipelines, pipelinesArchive };
}

/** Active collection source for the bounded MCP selection projection. */
export function pipelineSelectionSource() {
  const collection = pipelineStore();
  return { filename: stateDatabaseFile(), read: (id: string) => collection.get(id) };
}

/** Full-record read by id: the hot registry first, then the archive. */
export function findPipelineRecord(pipelineId: string): Pipeline | null {
  return pipelineStore().get(pipelineId) ?? archiveStore().get(pipelineId);
}

/** Validates durable task membership at the pipeline store seam. */
export function pipelineTaskLinkError(
  pipeline: Pick<Pipeline, "project">,
  taskIds: readonly string[],
  tasks: readonly BoardTask[],
  options: { allowMissing?: boolean } = {},
): string | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    if (!task) {
      if (options.allowMissing) continue;
      return `task not found: ${taskId}`;
    }
    if (task.project !== pipeline.project) return `task project does not match pipeline project: ${taskId}`;
  }
  return null;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

export function pipelineIdentity(id: string, task: string, repoDir: string): Pick<Pipeline, "worktreeDir" | "branch"> {
  const repoName = path.basename(repoDir);
  return {
    worktreeDir: path.join(path.dirname(repoDir), `${repoName}-pipeline-${id}`),
    branch: `pipeline/${slugify(task)}-${id}`,
  };
}

export function buildPipeline(input: {
  id: string;
  task: string;
  taskIds?: string[];
  creationIntent?: PipelineCreationIntent;
  spec?: string;
  project: string;
  repoDir: string;
  stages: PipelineStage[];
  srcPath: string | null;
  srcConversationId: string | null;
  now: string;
  state?: "draft" | "provisioning";
  publication?: PipelinePublication;
}): Pipeline {
  const identity = pipelineIdentity(input.id, input.task, input.repoDir);
  return {
    id: input.id,
    task: input.task,
    taskIds: [...new Set(input.taskIds ?? [])],
    ...(input.creationIntent ? { creationIntent: { ...input.creationIntent } } : {}),
    ...(input.spec ? { spec: input.spec } : {}),
    project: input.project,
    repoDir: input.repoDir,
    ...identity,
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    ...(input.publication ? { publication: input.publication } : {}),
    publishedCommit: null,
    stages: (JSON.parse(JSON.stringify(input.stages)) as PipelineStage[]).map((stage) => ({ ...stage, onFail: stage.onFail ?? null })),
    runs: input.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: input.stages.length ? { stageId: input.stages[0]!.id, state: "pending", input: null, activatedBy: null } : null,
    state: input.state ?? "provisioning",
    pausedState: null,
    stateDetail: null,
    srcPath: input.srcPath,
    srcConversationId: input.srcConversationId,
    createdAt: input.now,
    closedAt: null,
    hiddenAt: null,
  };
}

export function pipelineArtifactsDir(pipelineId: string): string {
  return path.join(artifactsRoot(), pipelineId);
}
