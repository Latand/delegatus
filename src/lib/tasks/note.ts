import { TASK_NOTE_LIMIT, type TaskNote } from "./types";

export function isTaskNote(value: unknown): value is TaskNote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const note = value as Partial<TaskNote>;
  const author = note.author;
  return typeof note.text === "string" && note.text.trim().length > 0 && note.text.length <= TASK_NOTE_LIMIT
    && !/[\r\n]/.test(note.text) && typeof note.updatedAt === "string" && Number.isFinite(Date.parse(note.updatedAt))
    && !!author && typeof author === "object" && (
      author.kind === "operator"
      || (author.kind === "orchestrator" && (author.conversationId === undefined || author.conversationId === null || typeof author.conversationId === "string"))
      || (author.kind === "agent" && (author.conversationId === null || typeof author.conversationId === "string"))
    );
}
