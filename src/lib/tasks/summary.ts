import {
  TASK_SUMMARY_HEADLINE_LIMIT, TASK_SUMMARY_TEXT_LIMIT, TASK_SUMMARY_LEFT_LIMIT,
  type TaskSummaryContent, type TaskSummary, type TaskSummaryAuthor,
} from "./types";

const fields = { headline: TASK_SUMMARY_HEADLINE_LIMIT, text: TASK_SUMMARY_TEXT_LIMIT, left: TASK_SUMMARY_LEFT_LIMIT } as const;

/** Shared by task edits and stage reports; reject rather than truncate. */
export function normalizeTaskSummary(input: unknown): { value: TaskSummaryContent } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "summary must be an object with headline and text" };
  const raw = input as Record<string, unknown>;
  const value: TaskSummaryContent = { headline: "", text: "" };
  for (const field of ["headline", "text", "left"] as const) {
    if (field === "left" && raw[field] === undefined) continue;
    if (typeof raw[field] !== "string") return { error: `summary.${field} must be a string of at most ${fields[field]} characters` };
    if (field !== "text" && /[\r\n]/.test(raw[field])) return { error: `summary.${field} must be one line of at most ${fields[field]} characters` };
    const text = raw[field].replace(/\s+/g, " ").trim();
    if (text.length > fields[field] || (field !== "left" && !text)) return { error: `summary.${field} must be ${field === "left" ? "at most" : "1 to"} ${fields[field]} characters` };
    if (field !== "left" || text) value[field] = text;
  }
  return { value };
}

export function readTaskSummaryInput(input: unknown, now: string, author: TaskSummaryAuthor):
  | { ok: true; summary: TaskSummary | undefined }
  | { ok: false; status: 400; code: "TASK_INVALID_FIELD"; field: "summary"; error: string } {
  if (input === null) return { ok: true, summary: undefined };
  const parsed = normalizeTaskSummary(input);
  if ("error" in parsed) return { ok: false, status: 400, code: "TASK_INVALID_FIELD", field: "summary", error: parsed.error };
  return { ok: true, summary: { ...parsed.value, author, updatedAt: now } };
}

export function isTaskSummaryContent(value: unknown): value is TaskSummaryContent {
  const parsed = normalizeTaskSummary(value);
  if ("error" in parsed) return false;
  const raw = value as TaskSummaryContent;
  return raw.headline === parsed.value.headline && raw.text === parsed.value.text && raw.left === parsed.value.left;
}

export function isTaskSummary(value: unknown): value is TaskSummary {
  if (!isTaskSummaryContent(value)) return false;
  const { author, updatedAt } = value as TaskSummary;
  if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) || !author || typeof author !== "object" || Array.isArray(author)) return false;
  if (author.kind === "operator") return true;
  if (author.kind === "orchestrator") return author.conversationId === undefined || author.conversationId === null || typeof author.conversationId === "string";
  if (author.kind === "agent") return author.conversationId === null || typeof author.conversationId === "string";
  return author.kind === "stage" && typeof author.pipelineId === "string" && !!author.pipelineId
    && typeof author.stageId === "string" && !!author.stageId && Number.isSafeInteger(author.attempt) && author.attempt > 0
    && (author.conversationId === null || typeof author.conversationId === "string");
}
