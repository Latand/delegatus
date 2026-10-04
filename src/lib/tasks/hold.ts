import { TASK_HOLD_KINDS, type TaskHold, type TaskHoldKind } from "./types";

const iso = (value: unknown): string | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const sentence = (value: unknown, limit: number): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";

/** Waiting reasons are forgiving: bad kinds become unstated, long prose is
    clamped, and provenance and first-write time belong to the server. */
export function readTaskHold(value: unknown, now: string, by: TaskHold["by"], previous?: TaskHold, conversationId?: string): TaskHold | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const kind: TaskHoldKind = (TASK_HOLD_KINDS as readonly unknown[]).includes(raw.kind) ? raw.kind as TaskHoldKind : "unstated";
  const ref = typeof raw.ref === "number" && Number.isSafeInteger(raw.ref) && raw.ref > 0 ? String(raw.ref) : sentence(raw.ref, 500);
  const until = (kind === "limit" || kind === "postponed") ? iso(raw.until) : undefined;
  return { kind, note: sentence(raw.note, 200), since: previous?.since ?? now, by,
    ...(["task", "pr", "issue", "external"].includes(kind) && ref ? { ref } : {}),
    ...(until ? { until } : {}), ...(by === "agent" && conversationId ? { conversationId } : {}) };
}

/** Optional extension fields must never make an old task disappear. */
export function storedTaskHold(value: unknown): TaskHold | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as TaskHold;
  const since = iso(raw.since);
  if (!since || !["operator", "agent", "migration"].includes(raw.by)) return undefined;
  return readTaskHold(raw, since, raw.by, undefined, sentence(raw.conversationId, 200) || undefined);
}
