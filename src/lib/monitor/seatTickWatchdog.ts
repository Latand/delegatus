import type { SeatTickProjectState } from "./types";

export const SEAT_TICK_DELIVERY_ALARM_MS = 30 * 60_000;
export interface SeatTickDeliveryAlarm { clientMessageId: string | null; since: string; ageMs: number; detail: string }

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
