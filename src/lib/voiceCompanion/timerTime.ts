import { resolveVoiceClock } from "./voiceClock";

/** A timer keeps the zone resolved by its call. An absent or invalid stored zone stays explicitly UTC. */
const timerClock = (zone: string | null) => resolveVoiceClock(zone, () => null);

/** `10:20`, and `10:20 UTC` when the zone is unknown or UTC. */
export function clockText(at: number, zone: string | null): string {
  const clock = timerClock(zone);
  const text = clock.clock(at);
  return clock.name === "UTC" ? text : text.slice(0, 5);
}

/** The voice clock's own zone label, including fixed-offset aliases. */
export function namedClockText(at: number, zone: string | null): string {
  return timerClock(zone).clock(at);
}

/** Whole minutes still to go, rounded up: a timer with 30 seconds left has one minute left, never none. */
export const minutesLeft = (remainingMs: number) => Math.max(0, Math.ceil(remainingMs / 60_000));

/** `in 12 minutes`; `in under a minute`. */
export function minutesLeftText(remainingMs: number): string {
  const minutes = minutesLeft(remainingMs);
  return remainingMs < 60_000 ? "in under a minute" : `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
