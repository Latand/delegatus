import type { BoardTask } from "./types";

export function isoNow(): string {
  return new Date().toISOString();
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

export function firstLineTitle(text: string): string {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first || "Untitled";
}

export function taskDeliveryText(id: string, text: string): string {
  return `Task #${shortTaskId(id)}: ${text}`;
}

/** Overdue derives at render only — nothing persists it, so DST and clock skew
    self-heal every frame. A malformed instant is never overdue. */
export function isOverdue(dueAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(dueAt);
  return Number.isFinite(t) && t < nowMs;
}

/** Compact chip label for a deadline, formatted in the zone it was set in
    (`dueTz`). Falls back to the viewer's zone if `dueTz` is somehow invalid.
    The clock is 24-hour in every locale, as the board's own stamps are. */
export function formatDue(dueAt: string, dueTz: string, locale = "en"): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: dueTz }).format(d);
  } catch {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  }
}

/** UTC instant → a `datetime-local` field value in the browser's local zone,
    for editing an existing deadline. */
export function toDueInputValue(dueAt: string): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value (browser local zone) → the canonical UTC instant
    plus the IANA zone captured at set time. Returns null for an unparseable value. */
export function fromDueInput(value: string): { dueAt: string; dueTz: string } | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return { dueAt: new Date(ms).toISOString(), dueTz: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/** A default advances by elapsed hours, including across daylight-saving changes. */
export function defaultTaskDue(nowMs = Date.now(), dueTz = Intl.DateTimeFormat().resolvedOptions().timeZone): { dueAt: string; dueTz: string } {
  const hour = 60 * 60 * 1000;
  return { dueAt: new Date(Math.ceil((nowMs + 72 * hour) / hour) * hour).toISOString(), dueTz };
}

/** Unknown history from an older release must never make its task unreadable. */
export function storedDueHistory(value: unknown): BoardTask["dueHistory"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const history = value as NonNullable<BoardTask["dueHistory"]>;
  const instant = (at: unknown): at is string => typeof at === "string" && Number.isFinite(Date.parse(at));
  if (!instant(history.firstAt) || !Number.isSafeInteger(history.slips) || history.slips < 0) return undefined;
  const last = history.last;
  if (last !== undefined && (!last || typeof last !== "object" || Array.isArray(last)
    || !instant(last.at) || !instant(last.from) || !instant(last.to)
    || (last.by !== "operator" && last.by !== "agent")
    || (last.reason !== undefined && (typeof last.reason !== "string" || !last.reason.trim() || last.reason.length > 200))
    || (last.conversationId !== undefined && typeof last.conversationId !== "string"))) return undefined;
  return { firstAt: history.firstAt, slips: history.slips, ...(last ? { last: { ...last } } : {}) };
}
