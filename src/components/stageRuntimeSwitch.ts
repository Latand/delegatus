import { ENGINE_MODELS, claudeCatalogModelId } from "@/lib/agent/models";
import type { MessageKey, TFunction } from "@/lib/i18n";
import { latestAttempt } from "@/lib/pipelines/stageChip";
import type { PatchPipelineRequest, Pipeline, PipelineRuntimeSeat, PipelineRuntimeSwitch, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { PipelineWriteResult } from "./kanban/pipelinePorts";
import type { RuntimeDraft } from "./runtimeProfile";

/*
 * The conversation of a pipeline stage's running attempt. Its runtime belongs
 * to the attempt, so a choice in the composer's runtime pill goes to the
 * pipeline (`override-stage` with `applyNow`), and the attempt continues on
 * what was chosen. Everything here is read off records the page already has.
 */

export interface StageRun {
  pipeline: Pipeline;
  stage: PipelineStage;
  attempt: PipelineStageAttempt;
  /** The attempt can take a runtime choice now; a settled one falls back to the conversation's own reconfigure. */
  live: boolean;
}

const OPEN_PHASES: ReadonlySet<PipelineRuntimeSwitch["phase"]> = new Set(["requested", "cutting", "switching", "continuing"]);

export function switchOpen(record: PipelineRuntimeSwitch | null | undefined): boolean {
  return Boolean(record && OPEN_PHASES.has(record.phase));
}

/** The pipeline a conversation was launched into as a stage, when it was. */
export function stagePipelineId(file: FileEntry): string | null {
  return file.durableLineage?.memberships.findLast((item) => item.kind === "pipeline" && item.stageId)?.containerId ?? null;
}

/** The stage attempt this conversation is the current agent of, or null. */
export function stageRunOf(file: FileEntry, pipeline: Pipeline | null): StageRun | null {
  const membership = file.durableLineage?.memberships.findLast((item) => item.kind === "pipeline" && item.stageId);
  if (!pipeline || !membership || pipeline.id !== membership.containerId) return null;
  const stage = pipeline.stages.find((candidate) => candidate.id === membership.stageId);
  const attempt = stage ? latestAttempt(pipeline, stage.id) : null;
  if (!stage || stage.kind !== "run" || !attempt) return null;
  const bound = attempt.conversationId ? attempt.conversationId === file.conversationId : attempt.agentPath === file.path;
  if (!bound) return null;
  const record = attempt.runtimeSwitches?.at(-1);
  const live = attempt.state === "running" || attempt.state === "spawning" || switchOpen(record);
  if (!live && attempt.state !== "needs_decision") return null;
  return { pipeline, stage, attempt, live };
}

/**
 * The whole runtime the pill shows, sent explicitly: the attempt continues on
 * exactly this. The engine is the conversation's, whatever the stage's next
 * attempt was set to, and the attempt and conversation the pill was opened on
 * ride along, so a choice that arrives after a retry is refused.
 */
export function stageSwitchRequest(run: StageRun, engine: string, draft: RuntimeDraft, accountId?: string): PatchPipelineRequest {
  return {
    action: "override-stage",
    stageId: run.stage.id,
    applyNow: true,
    expectedAttempt: run.attempt.n,
    ...(run.attempt.conversationId ? { expectedConversationId: run.attempt.conversationId } : {}),
    ...(engine === "claude" || engine === "codex" ? { engine } : {}),
    model: draft.model,
    effort: draft.effort,
    // Claude has no speed: a tier the next attempt was given for Codex is cleared with the engine.
    ...(engine === "codex" ? { serviceTier: draft.fast ? "priority" : "standard" } : engine === "claude" ? { serviceTier: null } : {}),
    ...(accountId ? { account: accountId } : {}),
  };
}

export interface SeatNames {
  account(id: string): string;
  effort(tier: string): string;
}

/** A runtime by the names the pill's own rows use, with whatever sets it apart from `other`. */
function seatName(seat: PipelineRuntimeSeat, other: PipelineRuntimeSeat, names: SeatNames): string {
  const id = seat.engine === "claude" ? claudeCatalogModelId(seat.model) ?? seat.model : seat.model;
  const parts = [ENGINE_MODELS[seat.engine].find((option) => option.id === id)?.label ?? seat.model ?? seat.engine];
  if (seat.engine === other.engine && seat.model === other.model && seat.effort && seat.effort !== other.effort) parts.push(names.effort(seat.effort));
  if (seat.accountId && seat.accountId !== other.accountId) parts.push(names.account(seat.accountId));
  return parts.join(" · ");
}

const KILLED = /^stage stopped by kill during runtime switch/;

const REASONS: ReadonlyArray<[RegExp, MessageKey]> = [
  [KILLED, "stageRuntime.reason.kill"],
  [/^runtime switch (?:rollback refused|source account is no longer allowed)/, "stageRuntime.reason.sourceDisallowed"],
  [/^(?:(?:runtime switch )?target account is no longer allowed|actual account is no longer allowed|runtime switch continuation (?:is )?fenced)/, "stageRuntime.reason.accountDisallowed"],
  [/^target engine is unavailable/, "stageRuntime.reason.engineUnavailable"],
  [/^runtime switch did not settle/, "stageRuntime.reason.didNotSettle"],
  [/^runtime switch failed/, "stageRuntime.reason.switchFailed"],
  [/^could not stop the running agent/, "stageRuntime.reason.stopFailed"],
  [/^(?:runtime switch was not started|stage stopped mid-turn)/, "stageRuntime.reason.deliveryPending"],
  [/^(?:runtime switch stop remains unconfirmed|runtime switch launch could not be proven stopped)/, "stageRuntime.reason.stopUnconfirmed"],
  [/^(?:runtime switch rollback waiting|continued runtime generation is unavailable)/, "stageRuntime.reason.sourceUnconfirmed"],
  [/^continuation delivered/, "stageRuntime.reason.turnStartPending"],
  [/^runtime switch continuation failed/, "stageRuntime.reason.continuationFailed"],
];

/**
 * What a switch that did not take says, in the operator's language and by
 * display names. Null while it is under way and once it has taken. The words
 * follow what happened to the agent: a refusal that came before the turn was
 * cut leaves it working, a rollback continues it, and only a kill stopped it.
 */
export function switchFailureText(t: TFunction, run: StageRun, names: SeatNames): string | null {
  const record = run.attempt.runtimeSwitches?.at(-1);
  if (!record) return null;
  const outcome = record.outcome;
  const key: MessageKey | null = switchOpen(record)
    ? run.attempt.state === "needs_decision" ? "stageRuntime.waiting" : null
    : record.phase === "rolled-back" ? "stageRuntime.rolledBack"
      : record.phase !== "failed" ? null
        : outcome && KILLED.test(outcome) ? "stageRuntime.failed" : "stageRuntime.notSwitched";
  if (!key) return null;
  // Only a switch still waiting is waiting for confirmation; a settled one without known words adds none.
  const reasonKey = outcome
    ? REASONS.find(([pattern]) => pattern.test(outcome))?.[1] ?? (key === "stageRuntime.waiting" ? "stageRuntime.reason.generic" : null)
    : null;
  return t(key, {
    target: seatName(record.to, record.from, names),
    current: seatName(record.from, record.to, names),
    reason: reasonKey ? t(reasonKey) : "",
  }).trim();
}

const REFUSALS: Readonly<Record<string, MessageKey>> = {
  RUNTIME_SWITCH_IN_PROGRESS: "stageRuntime.busy",
  ATTEMPT_STARTING: "stageRuntime.starting",
  STAGE_ALREADY_REPORTED: "stageRuntime.reported",
  RUNTIME_SWITCH_UNAVAILABLE: "stageRuntime.held",
  STAGE_CHANGED: "stageRuntime.changed",
};

/** Why the pipeline did not take the choice. A cause without words of its own keeps the server's text. */
export function switchRefusalText(t: TFunction, answer: Extract<PipelineWriteResult, { ok: false }>): string {
  if (answer.unknown) return t("stageRuntime.unconfirmed");
  const key = answer.code ? REFUSALS[answer.code] : undefined;
  if (key) return t(key);
  if (/not allowed on project|allows no \w+ account|no allowed target account/.test(answer.error)) return t("stageRuntime.noAccount");
  return answer.error;
}
