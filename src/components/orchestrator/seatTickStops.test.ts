import { expect, test } from "bun:test";

import { translate, type TFunction } from "@/lib/i18n";

import {
  SEAT_TICK_DRAG_SPRING,
  SEAT_TICK_SETTLE_SPRING,
  isSeatTickSwitchSentence,
  seatTickColour,
  seatTickReleaseStop,
  seatTickShortWord,
  seatTickSpringStep,
  seatTickStep,
  seatTickStopChange,
  seatTickStopValue,
  seatTickStopWord,
  type SeatTickSpring,
} from "./seatTickStops";

const en: TFunction = (key, params) => translate("en", key, params);
const uk: TFunction = (key, params) => translate("uk", key, params);

/** One travel from 0 to 1 at 60 frames a second: the furthest the thumb went,
    how far it fell back under the target afterwards, and how long it took. */
function travel(spring: SeatTickSpring): { peak: number; back: number; seconds: number } {
  let motion = { x: 0, v: 0 };
  let peak = 0;
  let back = 1;
  let frames = 0;
  while (!(motion.x === 1 && motion.v === 0) && frames < 600) {
    motion = seatTickSpringStep(motion, 1, spring, 1 / 60);
    if (motion.x > peak) {
      peak = motion.x;
      back = 1;
    } else {
      back = Math.min(back, motion.x);
    }
    frames += 1;
  }
  return { peak, back, seconds: frames / 60 };
}

test("on release the thumb settles with a small overshoot and no second swing to speak of, in about half a second", () => {
  const settle = travel(SEAT_TICK_SETTLE_SPRING);
  expect(settle.peak).toBeGreaterThan(1.04);
  expect(settle.peak).toBeLessThan(1.09);
  expect(settle.back).toBeGreaterThan(0.99);
  expect(settle.seconds).toBeLessThan(0.6);
});

test("while held the spring is the springier of the two, and still comes to rest", () => {
  const held = travel(SEAT_TICK_DRAG_SPRING);
  const settle = travel(SEAT_TICK_SETTLE_SPRING);
  expect(held.peak).toBeGreaterThan(1.2);
  expect(held.peak).toBeLessThan(1.3);
  /* Three times the swing of a release, and more. */
  expect(held.peak - 1).toBeGreaterThan(3 * (settle.peak - 1));
  expect(held.seconds).toBeLessThan(0.9);
});

test("a dropped frame does not throw the thumb", () => {
  const late = seatTickSpringStep({ x: 0, v: 0 }, 3, SEAT_TICK_DRAG_SPRING, 2);
  expect(late.x).toBeGreaterThan(0);
  expect(late.x).toBeLessThan(3.6);
});

test("the words: a stop's short face, the exact number between stops, and the value in words", () => {
  expect([0, 1, 2, 3].map((stop) => seatTickStopWord(stop, 60, en))).toEqual(["off", "4 h", "1 h", "10 min"]);
  expect([0, 1, 2, 3].map((stop) => seatTickStopWord(stop, 60, uk))).toEqual(["вимк.", "4 год", "1 год", "10 хв"]);
  expect([15, 90, 120, 720, 1440, 2880].map((minutes) => seatTickShortWord(minutes, en))).toEqual(["15 min", "90 min", "2 h", "12 h", "24 h", "2 d"]);
  expect([0, 1, 2, 3].map((stop) => seatTickStopValue(stop, 60, en))).toEqual(["off", "every 4 hours", "every hour, the default", "every 10 minutes"]);
  expect([0, 1, 2, 3].map((stop) => seatTickStopValue(stop, 60, uk))).toEqual(["вимкнено", "кожні 4 години", "щогодини, типово", "кожні 10 хвилин"]);
  /* A default that is not the hour keeps the stop and shows its own interval. */
  expect(seatTickStopWord(2, 30, en)).toBe("30 min");
  expect(seatTickStopValue(2, 30, en)).toBe("30 min, the default");
});

test("what a stop sends, by who wrote the stored reason", () => {
  const set10 = "The operator set the activity slider to «every 10 minutes».";
  expect(seatTickStopChange(3, null, "en")).toEqual({ enabled: true, wakeIntervalMinutes: 10, untilMinutes: null, reason: set10 });
  expect(seatTickStopChange(1, set10, "uk")).toEqual({ enabled: true, wakeIntervalMinutes: 240, untilMinutes: null, reason: "Оператор поставив повзунок активності на «кожні 4 години»." });
  expect(seatTickStopChange(2, set10, "en")).toEqual({ enabled: true, wakeIntervalMinutes: null, untilMinutes: null, reason: null });
  expect(seatTickStopChange(2, null, "en")).toEqual({ enabled: true, wakeIntervalMinutes: null, untilMinutes: null });
  expect(seatTickStopChange(0, "watch the release", "en")).toEqual({ enabled: false, untilMinutes: null });
  expect(seatTickStopChange(2, "watch the release", "en")).toEqual({ enabled: true, wakeIntervalMinutes: null, untilMinutes: null });
  expect(isSeatTickSwitchSentence(`  ${set10}\n`)).toBe(true);
  expect(isSeatTickSwitchSentence(`${set10} And watch the release.`)).toBe(false);
  expect(isSeatTickSwitchSentence(null)).toBe(false);
});

test("steps, the release and the colour ramp", () => {
  expect([seatTickStep(2, 1), seatTickStep(3, 1), seatTickStep(0, -1), seatTickStep(2.77, 1), seatTickStep(2.77, -1)]).toEqual([3, 3, 0, 3, 2]);
  expect(seatTickReleaseStop(1.8, 0, 20)).toBe(2);
  /* Slower than a flick carries nothing. */
  expect(seatTickReleaseStop(1.8, -0.39, 20)).toBe(2);
  expect(seatTickReleaseStop(1.8, -0.5, 20)).toBe(0);
  expect(seatTickReleaseStop(1.2, 0.5, 20)).toBe(3);
  expect(seatTickColour(0)).toBe("var(--tick-0)");
  expect(seatTickColour(3)).toBe("var(--tick-3)");
  expect(seatTickColour(1.25)).toBe("color-mix(in oklch, var(--tick-2) 25%, var(--tick-1))");
  expect(seatTickColour(9)).toBe("var(--tick-3)");
});
