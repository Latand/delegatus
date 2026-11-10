import { textLengthError } from "@/lib/textLimits";
import { TASK_HOLD_KINDS, type TaskHold, type TaskHoldKind } from "./types";

const iso = (value: unknown): string | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const sentence = (value: unknown): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
export const TASK_HOLD_NOTE_LIMIT = 200;
export const TASK_HOLD_REF_LIMIT = 500;

/** New authoritative input is refused before any task or step is persisted. */
export function validateTaskHoldInput(value: unknown, field = "hold"): { ok: false; error: string; status: 400; code: "TASK_INVALID_FIELD"; field: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  for (const [key, max] of [["note", TASK_HOLD_NOTE_LIMIT], ["ref", TASK_HOLD_REF_LIMIT]] as const) {
    const text = key === "note" ? sentence(raw[key]) : typeof raw[key] === "string" ? raw[key] : "";
    if (text.length > max) return { ok: false, status: 400, code: "TASK_INVALID_FIELD", field: `${field}.${key}`, error: textLengthError(`${field}.${key}`, text.length, max, "UTF-16 code units") };
  }
  return null;
}

/** Waiting reasons normalize bad kinds to unstated. Writers validate length
    separately; readers preserve retained text, including legacy overages.
    Provenance and first-write time belong to the server. */
export function readTaskHold(value: unknown, now: string, by: TaskHold["by"], previous?: TaskHold, conversationId?: string, notes?: string[]): TaskHold | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalized = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : raw.kind;
  const known = (TASK_HOLD_KINDS as readonly unknown[]).includes(normalized);
  const kind: TaskHoldKind = known ? normalized as TaskHoldKind : "unstated";
  if (!known && raw.kind !== undefined) notes?.push(`Unknown hold kind ${JSON.stringify(raw.kind)} normalized to unstated.`);
  const ref = typeof raw.ref === "number" && Number.isSafeInteger(raw.ref) && raw.ref > 0 ? String(raw.ref) : (typeof raw.ref === "string" ? raw.ref : "");
  const until = (kind === "limit" || kind === "postponed") ? iso(raw.until) : undefined;
  if (raw.until !== undefined && kind !== "limit" && kind !== "postponed") {
    notes?.push(`hold.until ignored for hold kind "${kind}"; only limit and postponed store until. Use dueAt for the task deadline.`);
  }
  return { kind, note: sentence(raw.note), since: previous?.since ?? now, by,
    ...(["task", "pr", "issue", "external"].includes(kind) && ref ? { ref } : {}),
    ...(until ? { until } : {}), ...(by === "agent" && conversationId ? { conversationId } : {}) };
}

/** Optional extension fields must never make an old task disappear. */
export function storedTaskHold(value: unknown, notes?: string[]): TaskHold | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as TaskHold;
  const since = iso(raw.since);
  if (!since || !["operator", "agent", "migration"].includes(raw.by)) return undefined;
  return readTaskHold(raw, since, raw.by, undefined, sentence(raw.conversationId) || undefined, notes);
}
