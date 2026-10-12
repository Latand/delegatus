import type { OrchestratorSeat } from "./seats";

/** A terminal failure remains in history even after its banner is obsolete. */
export interface SeatFailureRecord {
  error: string;
  clientRequestId: string;
  seatEpoch: number;
  designatedAt: string;
  terminalizedAt: string;
  predecessorConversationId?: string | null;
  automaticReplacement?: { conversationId: string; seatEpoch: number };
}

/** A targeted host read, bound to the designated seat it observed. */
export interface SeatHostObservation {
  conversationId: string;
  seatEpoch: number;
  hostState: string;
  observedAt: string;
}

export function currentSeatFailure(
  failure: SeatFailureRecord | null,
  active: OrchestratorSeat | null,
  observation: SeatHostObservation | null = null,
): SeatFailureRecord | null {
  if (!failure || !active || !active.conversationId || active.state !== "active" || active.intent.error !== null) return failure;
  const failedAt = Date.parse(failure.terminalizedAt);
  const activatedAt = Date.parse(active.activatedAt ?? "");
  const rollback = Boolean(failure.predecessorConversationId
    && failure.predecessorConversationId === active.conversationId
    && Number.isFinite(Date.parse(active.designatedAt))
    && Date.parse(active.designatedAt) <= failedAt);
  const laterDesignation = active.intent.clientRequestId !== failure.clientRequestId
    && (active.seatEpoch > failure.seatEpoch || activatedAt > failedAt);
  if (laterDesignation && !rollback) return null;
  const live = observation?.hostState === "alive" && observation.conversationId === active.conversationId
    && observation.seatEpoch === active.seatEpoch && Number.isFinite(Date.parse(observation.observedAt));
  if (!live) return failure;
  return Date.parse(observation.observedAt) > failedAt ? null : failure;
}
