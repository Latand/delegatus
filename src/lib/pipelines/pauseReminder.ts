import type { Pipeline } from "./types";
import type { PipelinePause } from "./pauseMetadata";

export const PAUSE_REMINDER_AFTER_MS = 24 * 60 * 60_000;

export function pausedByOperator(pipeline: Pick<Pipeline, "pause" | "stateDetail">): boolean {
  const actor = pipeline.pause?.actor;
  return actor ? actor.kind === "operator" : pipeline.stateDetail?.trim() === "paused by operator";
}

export function pauseReminderDue(pause: PipelinePause | undefined, pausedAt: string | null | undefined, now: number, conditionMet = false): boolean {
  const condition = pause?.resumeCondition;
  if (condition?.kind === "date") return Date.parse(condition.at) <= now;
  if (condition?.kind === "account-usage") return conditionMet;
  const since = Date.parse(pausedAt ?? "");
  return Number.isFinite(since) && now - since >= PAUSE_REMINDER_AFTER_MS;
}
