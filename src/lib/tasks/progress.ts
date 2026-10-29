import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import type { TaskRefusal } from "./commands";
import type { TaskProgress } from "./types";

export function isProgressValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** Both transports use this command guard; metadata is never read from input. */
export function readTaskProgress(input: unknown, setAt: string, by: PauseResumeActor):
  { ok: true; progress: TaskProgress | undefined } | TaskRefusal {
  if (input === null) return { ok: true, progress: undefined };
  if (!isProgressValue(input)) return {
    ok: false, status: 400, code: "TASK_INVALID_FIELD", field: "progress",
    error: "progress must be an integer from 0 to 100 or null",
  };
  return { ok: true, progress: { value: input, setAt, by: structuredClone(by) } };
}

/** Malformed optional metadata must not make its task unreadable. */
export function isTaskProgress(value: unknown): value is TaskProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Partial<TaskProgress>;
  const by = progress.by;
  if (!isProgressValue(progress.value) || typeof progress.setAt !== "string" || !Number.isFinite(Date.parse(progress.setAt))
    || !by || typeof by !== "object" || Array.isArray(by)) return false;
  return by.kind === "operator" || (by.kind === "agent"
    && (by.role === null || typeof by.role === "string")
    && (by.conversationId === null || typeof by.conversationId === "string")
    && (by.via === undefined || (!!by.via && typeof by.via === "object" && !Array.isArray(by.via) && typeof by.via.deputy === "string")));
}
