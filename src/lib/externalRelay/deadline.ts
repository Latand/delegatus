import { z } from "zod";

/** Provisional claim field: a rename or move changes this path only. */
export const RELAY_DEADLINE_PATH: readonly string[] = ["deadline_at"];
export const RELAY_REQUEST_WINDOW_MS = 120_000;
export const RELAY_BUSY_DECLINE_MARGIN_MS = 10_000;
export type RelayRequestDeadline = Readonly<{
  receivedAt: number;
  at: number;
  declineAt: number;
  source: "deadline_at" | "receipt";
  fallback: null | "absent" | "unparseable" | "past" | "far";
}>;
const time = z.iso.datetime({ offset: true });
export function relayRequestDeadline(raw: unknown, receivedAt = Date.now()): RelayRequestDeadline {
  let value: unknown = raw;
  for (const part of RELAY_DEADLINE_PATH)
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  const claimed = raw && typeof raw === "object" ? (raw as Record<string, unknown>).claimed_at : undefined;
  let fallback: RelayRequestDeadline["fallback"] = null;
  let budget = RELAY_REQUEST_WINDOW_MS;
  if (value === undefined) fallback = "absent";
  else if (!time.safeParse(value).success || !time.safeParse(claimed).success) fallback = "unparseable";
  else {
    const delta = Date.parse(value as string) - Date.parse(claimed as string);
    if (delta <= 0) fallback = "past";
    else if (delta > 600_000) fallback = "far";
    else budget = delta;
  }
  return Object.freeze({ receivedAt, at: receivedAt + budget,
    declineAt: receivedAt + Math.max(0, budget - RELAY_BUSY_DECLINE_MARGIN_MS),
    source: fallback ? "receipt" : "deadline_at", fallback });
}
export const remainingMs = (deadline: RelayRequestDeadline, now = Date.now()) => Math.max(0, deadline.at - now);
