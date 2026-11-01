/*
 * Every time a person hears or reads about a voice timer comes from here (docs/design/voice-timers.md §3.5): the clock
 * time in the operator's zone and the minutes left. Once the voice clock module is on main, these bodies switch to it.
 */

/** The zone's own clock text, or null when the zone is unknown or not a zone the runtime knows. */
function zoneClock(at: number, zone: string | null): string | null {
  if (!zone) return null;
  try { return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at); }
  catch { return null; }
}
const utcClock = (at: number) => new Date(at).toISOString().slice(11, 16);
const UTC_ZONES = new Set(["UTC", "Etc/UTC", "GMT", "Etc/GMT"]);

/** `10:20`, and `10:20 UTC` when the zone is unknown, so the words never pass UTC off as the operator's time. */
export function clockText(at: number, zone: string | null): string {
  const local = zoneClock(at, zone);
  return local && !UTC_ZONES.has(zone!) ? local : `${utcClock(at)} UTC`;
}

/** `10:20 Kyiv time`; `10:20 UTC` when the zone is unknown. */
export function namedClockText(at: number, zone: string | null): string {
  const local = zoneClock(at, zone);
  if (!local || UTC_ZONES.has(zone!)) return `${utcClock(at)} UTC`;
  return `${local} ${(zone === "Europe/Kiev" ? "Europe/Kyiv" : zone!).split("/").at(-1)!.replaceAll("_", " ")} time`;
}

/** Whole minutes still to go, rounded up: a timer with 30 seconds left has one minute left, never none. */
export const minutesLeft = (remainingMs: number) => Math.max(0, Math.ceil(remainingMs / 60_000));

/** `in 12 minutes`; `in under a minute`. */
export function minutesLeftText(remainingMs: number): string {
  const minutes = minutesLeft(remainingMs);
  return remainingMs < 60_000 ? "in under a minute" : `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
