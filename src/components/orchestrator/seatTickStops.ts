import { translate, type MessageKey, type TFunction } from "@/lib/i18n";
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

import type { SeatTickChange } from "./useSeatTickSettings";

/*
 * The seat tick switch's model (docs/design/seat-tick-slider.md, variant 4):
 * where a record sits on the four stops, what the thumb says, what a move
 * writes, and how the thumb travels. Pure, so the desktop chip and the phone
 * row share one reading and every rule is testable without a pointer.
 *
 * Positions are in stops: 0 is off, 1 is every 4 h, 2 is the default (1 h),
 * 3 is every 10 min. A value between two stops is a fraction.
 */

export const SEAT_TICK_LAST_STOP = 3;
const FOUR_HOURS = 240;
const TEN_MINUTES = 10;

/** Movement under this many pixels between press and release is a click. */
export const SEAT_TICK_DRAG_THRESHOLD = { mouse: 4, touch: 8 } as const;
/** A release faster than this, in px/ms over the window below, is a flick. */
export const SEAT_TICK_FLICK_SPEED = 0.4;
/** The speed is read over this much of the movement before the release: the
    browser can deliver a last move with no distance just before it. */
export const SEAT_TICK_FLICK_WINDOW_MS = 80;
/** How far a flick carries past the release point, in milliseconds of travel. */
export const SEAT_TICK_FLICK_CARRY_MS = 90;
/** Keyboard steps write after this long without another key. */
export const SEAT_TICK_KEY_COMMIT_MS = 700;

export interface SeatTickPlace {
  /** 0..3, fractional for a value between stops. */
  position: number;
  /** The stop the record is on, or null for a value that is not a preset. */
  stop: number | null;
}

const clampStop = (value: number) => Math.min(SEAT_TICK_LAST_STOP, Math.max(0, value));

/** Where the record sits. The stops are evenly spaced and a value between two
    of them is placed on a log scale between them; longer than 4 h falls between
    off and 4 h, shorter than 10 min pins to the right end. */
export function seatTickPlace(answer: SeatTickSettingsAnswer): SeatTickPlace {
  const { effective } = answer;
  if (!effective.enabled) return { position: 0, stop: 0 };
  const minutes = effective.wakeIntervalMinutes;
  const base = answer.defaultWakeIntervalMinutes;
  if (effective.isDefault || minutes === base) return { position: 2, stop: 2 };
  if (minutes === FOUR_HOURS) return { position: 1, stop: 1 };
  if (minutes === TEN_MINUTES) return { position: 3, stop: 3 };
  if (minutes < TEN_MINUTES) return { position: 3, stop: null };
  /* A week and longer sits at the same place, a fifth of a step from off. */
  if (minutes > FOUR_HOURS) return { position: 1 - 0.8 * Math.min(1, Math.log(minutes / FOUR_HOURS) / Math.log(42)), stop: null };
  /* A default configured outside the two presets still has to order the scale. */
  const middle = Math.min(FOUR_HOURS - 1, Math.max(TEN_MINUTES + 1, base));
  if (minutes > middle) return { position: 1 + Math.log(FOUR_HOURS / minutes) / Math.log(FOUR_HOURS / middle), stop: null };
  return { position: 2 + Math.log(middle / minutes) / Math.log(middle / TEN_MINUTES), stop: null };
}

/** The interval as the thumb's word: the number and its unit, exact. */
export function seatTickShortWord(minutes: number, t: TFunction): string {
  if (minutes >= 2880 && minutes % 1440 === 0) return t("seatTick.switch.day", { n: minutes / 1440 });
  if (minutes >= 60 && minutes % 60 === 0) return t("seatTick.switch.hour", { n: minutes / 60 });
  return t("seatTick.switch.min", { n: minutes });
}

/** What a stop's thumb says. The default stop shows the default's own interval. */
export function seatTickStopWord(stop: number, defaultMinutes: number, t: TFunction): string {
  if (stop === 0) return t("seatTick.chip.off");
  return seatTickShortWord(stop === 1 ? FOUR_HOURS : stop === 2 ? defaultMinutes : TEN_MINUTES, t);
}

const STOP_VALUE: Record<number, MessageKey> = {
  0: "seatTick.switch.value.off",
  1: "seatTick.switch.value.fourHours",
  3: "seatTick.switch.value.tenMinutes",
};

/** A stop in words, for the value text and for the sentence a move writes. */
export function seatTickStopValue(stop: number, defaultMinutes: number, t: TFunction): string {
  if (stop !== 2) return t(STOP_VALUE[stop] ?? "seatTick.switch.value.off");
  const interval = defaultMinutes === 60 ? t("seatTick.switch.value.hour") : seatTickShortWord(defaultMinutes, t);
  return t("seatTick.switch.value.default", { interval });
}

/** The sentence the switch writes as the reason the module requires off the
    default. Stops 1 and 3 only name themselves; stop 0 says how it ends. */
function ownSentence(stop: number, locale: "en" | "uk"): string {
  if (stop === 0) return translate(locale, "seatTick.switch.reason.off");
  return translate(locale, "seatTick.switch.reason.set", { stop: translate(locale, STOP_VALUE[stop]!) });
}

/** Whether a stored reason is one the switch wrote, in either language: those
    are the switch's to replace and to clear, and no other text is. */
export function isSeatTickSwitchSentence(reason: string | null): boolean {
  if (!reason) return false;
  const text = reason.trim();
  return [0, 1, 3].some((stop) => text === ownSentence(stop, "en") || text === ownSentence(stop, "uk"));
}

/**
 * What landing on a stop sends. Every move clears an expiry, because a stop is
 * a standing level. A reason a person or a seat wrote is never sent over; with
 * none stored the switch writes its own sentence, replaces it on the next move
 * and clears it on the default, so an hourly tick does not keep delivering
 * «set to every 10 minutes».
 */
export function seatTickStopChange(stop: number, storedReason: string | null, locale: "en" | "uk"): SeatTickChange {
  const own = !storedReason || isSeatTickSwitchSentence(storedReason);
  if (stop === 2) {
    return { enabled: true, wakeIntervalMinutes: null, untilMinutes: null, ...(storedReason && own ? { reason: null } : {}) };
  }
  const schedule: SeatTickChange = stop === 0
    ? { enabled: false, untilMinutes: null }
    : { enabled: true, wakeIntervalMinutes: stop === 1 ? FOUR_HOURS : TEN_MINUTES, untilMinutes: null };
  return own ? { ...schedule, reason: ownSentence(stop, locale) } : schedule;
}

/** The stop an arrow reaches: one stop over, or from a value between stops the
    neighbouring stop in that direction. */
export function seatTickStep(position: number, direction: 1 | -1): number {
  const whole = Number.isInteger(position);
  return clampStop(direction > 0 ? (whole ? position + 1 : Math.ceil(position)) : (whole ? position - 1 : Math.floor(position)));
}

/** Where a release lands: the nearest stop to the released position, after a
    flick has carried it `SEAT_TICK_FLICK_CARRY_MS` further. */
export function seatTickReleaseStop(position: number, speedPxPerMs: number, stepPx: number): number {
  const carry = Math.abs(speedPxPerMs) > SEAT_TICK_FLICK_SPEED ? (speedPxPerMs * SEAT_TICK_FLICK_CARRY_MS) / stepPx : 0;
  return Math.round(clampStop(position + carry));
}

/* The activity ramp, from the app's own tokens (`--tick-0..3` in globals.css):
   grey for off, a calm blue, the accent at the default, a warm violet-magenta
   at the most active stop. Mixed in OKLCH between stops, so a drag sweeps the
   hue. Green and amber are left to the health dot. */
export function seatTickColour(position: number): string {
  const x = clampStop(position);
  const from = Math.min(SEAT_TICK_LAST_STOP - 1, Math.floor(x));
  const share = Math.round((x - from) * 100);
  if (share <= 0) return `var(--tick-${from})`;
  if (share >= 100) return `var(--tick-${from + 1})`;
  return `color-mix(in oklch, var(--tick-${from + 1}) ${share}%, var(--tick-${from}))`;
}

/*
 * The thumb's travel is a damped spring toward where it should be. While the
 * pointer holds it the spring is light, so the thumb trails and swings as it
 * follows; once released it is damped harder, so it settles on the stop with
 * a small overshoot: about a pixel on a move of one stop.
 */
export interface SeatTickSpring { stiffness: number; damping: number }
/** Damping ratio 0.4: the thumb trails a moving pointer by about 40 ms of its
    travel and swings a quarter of that lag past it when the pointer stops. */
export const SEAT_TICK_DRAG_SPRING: SeatTickSpring = { stiffness: 450, damping: 17 };
/** Damping ratio 0.65: about 7 % of the distance past the stop, then rest. */
export const SEAT_TICK_SETTLE_SPRING: SeatTickSpring = { stiffness: 420, damping: 26.6 };
/** How far past an end the thumb is drawn, in stops: the pill is a wall, and
    the thumb gives against it by the pill's own inset and no more. */
export const SEAT_TICK_END_GIVE = 0.08;

export interface SeatTickMotion { x: number; v: number }

/** Advance the spring by `seconds`, in steps short enough to stay stable on a
    dropped frame. Returns the same object once it has come to rest on the target. */
export function seatTickSpringStep(motion: SeatTickMotion, target: number, spring: SeatTickSpring, seconds: number): SeatTickMotion {
  let { x, v } = motion;
  let left = Math.min(0.064, Math.max(0, seconds));
  while (left > 0) {
    const dt = Math.min(0.004, left);
    v += (spring.stiffness * (target - x) - spring.damping * v) * dt;
    x += v * dt;
    left -= dt;
  }
  if (Math.abs(target - x) < 0.002 && Math.abs(v) < 0.02) return { x: target, v: 0 };
  return { x, v };
}
