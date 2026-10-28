import type { SeatTickProjectState, SeatTickRunRecord } from "./types";

export const SEAT_TICK_DELIVERY_ALARM_MS = 30 * 60_000;
export interface SeatTickDeliveryAlarm { clientMessageId: string | null; since: string; ageMs: number; detail: string }

export const SEAT_TICK_CHECK_ERROR_LIMIT = 3;
export interface SeatTickCheckErrorAlarm { since: string; detail: string }

/** The project journal is the counter, so process succession cannot reset it.
 * Reconciliation events carry no completed-check outcome. A completed check
 * ends the streak, including a quiet or refused check. */
export function seatTickCheckErrorAlarm(records: readonly SeatTickRunRecord[]): SeatTickCheckErrorAlarm | null {
  const recent = records.filter(record => ["quiet", "wake", "proactive", "no-seat", "skipped", "refused", "error"].includes(record.verdict))
    .slice(-SEAT_TICK_CHECK_ERROR_LIMIT);
  if (recent.length < SEAT_TICK_CHECK_ERROR_LIMIT || recent.some(record => record.verdict !== "error")) return null;
  return { since: recent[0]!.at,
    detail: `Seat tick check alarm: the last ${SEAT_TICK_CHECK_ERROR_LIMIT} checks failed; latest failure: ${recent.at(-1)!.detail ?? "reason unavailable"}` };
}

/** Only decided work starts the watchdog. Idle seats owe no delivery. The
 * durable first decision survives restarts and repeated failed attempts. */
export function seatTickDeliveryAlarm(state: SeatTickProjectState, now: number): SeatTickDeliveryAlarm | null {
  const since = state.wakeDecidedSince ?? state.outstandingWake?.preparedAt;
  if (!since) return null;
  const start = Date.parse(since), landed = Date.parse(state.lastWakeAt ?? "");
  if (!Number.isFinite(start) || now - start < SEAT_TICK_DELIVERY_ALARM_MS || landed > start) return null;
  const ageMs = Math.max(0, now - start);
  const clientMessageId = state.outstandingWake?.clientMessageId ?? state.releasedWake?.clientMessageId ?? null;
  return { clientMessageId, since, ageMs,
    detail: `Seat wake delivery alarm: wakes have been decided without delivery for ${Math.floor(ageMs / 60_000)} minutes; stuck delivery ${clientMessageId ?? "no reservation"}; ageMs=${ageMs}` };
}
