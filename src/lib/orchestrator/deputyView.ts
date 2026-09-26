/* A seat's deputy as the seat read model carries it to the browser
 * (docs/design/ghost-seat.md §5 "Reaching the feed", §6). Client-safe: no node
 * imports, so the feed, the seat head and the phone's seat card parse the same
 * shape the route writes.
 */

export type SeatDeputyOutcome = "done" | "timeout" | "host-died" | "seat-rotated" | "failed";

export interface SeatDeputySender {
  memberId: string;
  name: string;
  color: string | null;
  initials: string | null;
}

export interface SeatDeputyView {
  askId: string;
  seatConversationId: string;
  deputyConversationId: string | null;
  ask: { text: string; images: number; sender: SeatDeputySender | null };
  artifactPath: string | null;
  forkRecordCount: number | null;
  state: "pending" | "active" | "ended";
  startedAt: string;
  activatedAt: string | null;
  endedAt: string | null;
  outcome: SeatDeputyOutcome | null;
  touched: { taskIds: string[]; pipelineIds: string[]; conversationIds: string[] };
  result: { line: string; finalText: string } | null;
}

/** The view of one record: everything the feed draws, and nothing it does not
    (no request key, no note receipt). */
export function seatDeputyView(deputy: SeatDeputyView): SeatDeputyView {
  return {
    askId: deputy.askId,
    seatConversationId: deputy.seatConversationId,
    deputyConversationId: deputy.deputyConversationId,
    ask: { text: deputy.ask.text, images: deputy.ask.images, sender: deputy.ask.sender },
    artifactPath: deputy.artifactPath,
    forkRecordCount: deputy.forkRecordCount,
    state: deputy.state,
    startedAt: deputy.startedAt,
    activatedAt: deputy.activatedAt,
    endedAt: deputy.endedAt,
    outcome: deputy.outcome,
    touched: deputy.touched,
    result: deputy.result ? { line: deputy.result.line, finalText: deputy.result.finalText } : null,
  };
}

const OUTCOMES: readonly SeatDeputyOutcome[] = ["done", "timeout", "host-died", "seat-rotated", "failed"];

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const strings = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : []
);

/** Crash-safe parse of one view off the wire; null for anything malformed. */
export function parseSeatDeputyView(value: unknown): SeatDeputyView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const askId = text(row.askId);
  const seatConversationId = text(row.seatConversationId);
  const startedAt = text(row.startedAt);
  const state = row.state === "pending" || row.state === "active" || row.state === "ended" ? row.state : null;
  if (!askId || !seatConversationId || !startedAt || !state) return null;
  const ask = (row.ask && typeof row.ask === "object" ? row.ask : {}) as Record<string, unknown>;
  const senderRaw = (ask.sender && typeof ask.sender === "object" ? ask.sender : null) as Record<string, unknown> | null;
  const sender = senderRaw && text(senderRaw.memberId) && text(senderRaw.name)
    ? { memberId: text(senderRaw.memberId)!, name: text(senderRaw.name)!, color: text(senderRaw.color), initials: text(senderRaw.initials) }
    : null;
  const touched = (row.touched && typeof row.touched === "object" ? row.touched : {}) as Record<string, unknown>;
  const result = row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : null;
  const count = row.forkRecordCount;
  return {
    askId,
    seatConversationId,
    deputyConversationId: text(row.deputyConversationId),
    ask: {
      text: typeof ask.text === "string" ? ask.text : "",
      images: typeof ask.images === "number" && ask.images > 0 ? Math.floor(ask.images) : 0,
      sender,
    },
    artifactPath: text(row.artifactPath),
    forkRecordCount: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null,
    state,
    startedAt,
    activatedAt: text(row.activatedAt),
    endedAt: text(row.endedAt),
    outcome: OUTCOMES.includes(row.outcome as SeatDeputyOutcome) ? row.outcome as SeatDeputyOutcome : null,
    touched: { taskIds: strings(touched.taskIds), pipelineIds: strings(touched.pipelineIds), conversationIds: strings(touched.conversationIds) },
    result: result && typeof result.line === "string"
      ? { line: result.line, finalText: typeof result.finalText === "string" ? result.finalText : "" }
      : null,
  };
}

export function parseSeatDeputyViews(value: unknown): SeatDeputyView[] {
  return Array.isArray(value) ? value.flatMap((entry) => parseSeatDeputyView(entry) ?? []) : [];
}

/** Whether a view's block is still running. */
export function seatDeputyLive(view: Pick<SeatDeputyView, "state">): boolean {
  return view.state !== "ended";
}
