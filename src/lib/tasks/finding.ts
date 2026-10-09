import type { TaskRefusal } from "./commands";
import type { BoardTask } from "./types";

export const FINDING_KEY_LIMIT = 200;

/** Opaque: retain whitespace and case, and count Unicode characters. */
export function readFindingKey(value: unknown): { ok: true; key?: string } | TaskRefusal {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string" || value.length > FINDING_KEY_LIMIT * 2 || [...value].length > FINDING_KEY_LIMIT) {
    return { ok: false, status: 400, code: "TASK_INVALID_FIELD", field: "findingKey", error: `findingKey must be a string of at most ${FINDING_KEY_LIMIT} characters` };
  }
  return { ok: true, key: value };
}

export function validStoredFinding(value: unknown): value is NonNullable<BoardTask["finding"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.count) && Number(row.count) > 0
    && typeof row.lastSeenAt === "string" && Number.isFinite(Date.parse(row.lastSeenAt))
    && (row.previousTaskId === undefined || typeof row.previousTaskId === "string");
}
