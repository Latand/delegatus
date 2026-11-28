import { textLengthError } from "@/lib/textLimits";
import { MIN_SHORT_ID_CHARS, resolveShortId } from "@/lib/shortIds";
import { TASK_HOLD_KINDS, type BoardTask, type TaskHold, type TaskHoldKind } from "./types";

const iso = (value: unknown): string | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const sentence = (value: unknown): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
export const TASK_HOLD_NOTE_LIMIT = 200;
export const TASK_HOLD_REF_LIMIT = 500;

/** The Waiting column records a next step reserved for the operator. */
export const holdParks = (hold: TaskHold): boolean => hold.kind === "operator" && !!sentence(hold.note);

export function normalizeHoldKind(kind: unknown): unknown {
  return typeof kind === "string" ? kind.trim().toLowerCase() : kind;
}

export type HoldFormIds = (prefix: string) => Iterable<string>;

export function* taskFormIds(task: Pick<BoardTask, "prototypeReview" | "prototypeReviews" | "prototypeReviewReplica">): Iterable<string> {
  for (const round of task.prototypeReviews ?? task.prototypeReviewReplica?.rounds ?? []) yield round.id;
  const summary = task.prototypeReview ?? task.prototypeReviewReplica?.summary;
  if (summary?.latestReviewId) yield summary.latestReviewId;
  if (summary?.waitingReviewId) yield summary.waitingReviewId;
}

/** Resolve only the abbreviated form IDs that tools can print. Include
    retained forms in the candidate set so an old hold cannot pick a newer
    form just because the original was answered or dismissed. */
export function resolveHoldFormRef(ref: string, formIds: HoldFormIds) {
  if (ref.length < "pr_".length + MIN_SHORT_ID_CHARS || !/^pr_[a-f0-9]{1,31}$/i.test(ref)) return undefined;
  const prefix = ref.toLowerCase();
  try {
    return resolveShortId(formIds(prefix), prefix);
  } catch {
    return { kind: "unavailable" as const };
  }
}

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
export function readTaskHold(value: unknown, now: string, by: TaskHold["by"], previous?: TaskHold, conversationId?: string, notes?: string[], formIds?: HoldFormIds): TaskHold | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalized = normalizeHoldKind(raw.kind);
  const known = (TASK_HOLD_KINDS as readonly unknown[]).includes(normalized);
  const kind: TaskHoldKind = known ? normalized as TaskHoldKind : "unstated";
  if (!known && raw.kind !== undefined) notes?.push(`Unknown hold kind ${JSON.stringify(raw.kind)} normalized to unstated.`);
  let ref = typeof raw.ref === "number" && Number.isSafeInteger(raw.ref) && raw.ref > 0 ? String(raw.ref) : (typeof raw.ref === "string" ? raw.ref : "");
  if (kind === "operator" && ref && formIds) {
    const resolved = resolveHoldFormRef(ref, formIds);
    if (resolved?.kind === "match") ref = resolved.value;
  }
  const until = (kind === "limit" || kind === "postponed") ? iso(raw.until) : undefined;
  if (raw.until !== undefined && kind !== "limit" && kind !== "postponed") {
    notes?.push(`hold.until ignored for hold kind "${kind}"; only limit and postponed store until. Use dueAt for the task deadline.`);
  }
  return { kind, note: sentence(raw.note), since: previous?.since ?? now, by,
    ...(["operator", "task", "pr", "issue", "external"].includes(kind) && ref ? { ref } : {}),
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

const HOLD_REF_KINDS: readonly TaskHoldKind[] = ["operator", "task", "pr", "issue", "external"];
const HOLD_UNTIL_KINDS: readonly TaskHoldKind[] = ["limit", "postponed"];

/** The ref and date a hold editor shows for a kind: the stored hold's own while
    its kind is unchanged, nothing once the kind moves, so a PR number never
    outlives a switch to another kind. */
export function holdEditorDraft(original: TaskHold | undefined, kind: TaskHoldKind): { ref: string; until: string } {
  return original?.kind === kind ? { ref: original.ref ?? "", until: original.until ?? "" } : { ref: "", until: "" };
}

/** What the editor submits: a ref only for kinds that store one (an operator
    hold keeps its form or step ref unseen), a date only for kinds that carry one. */
export function holdEditorPatch(draft: { kind: TaskHoldKind; note: string; ref: string; until: string }): Partial<TaskHold> {
  const { kind, note, ref, until } = draft;
  return { kind, note, ...(ref && HOLD_REF_KINDS.includes(kind) ? { ref } : {}), ...(until && HOLD_UNTIL_KINDS.includes(kind) ? { until } : {}) };
}
