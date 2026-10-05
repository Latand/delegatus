import { describe, expect, test } from "bun:test";

import { STEP_PAD_DESKTOP_PX as STEP_PAD_PX, stepCountLabel, stepScrollTop, stepState, stepTarget, type StepReading } from "./ownMessageSteps.prototype.model";

const TOPS = [100, 900, 2400, 3100];
const reading = (scrollTop: number, over: Partial<StepReading> = {}): StepReading => ({
  tops: TOPS, scrollTop, viewport: 600, maxScroll: 3400, olderUnloaded: false, pad: STEP_PAD_PX, ...over,
});

describe("own-message steps: the arithmetic every variant shares", () => {
  test("a step back from the middle of a reply lands on the message that reply answers", () => {
    expect(stepTarget(reading(1500), -1)).toBe(1);
    expect(stepScrollTop(reading(1500), 1)).toBe(900 - STEP_PAD_PX);
  });

  test("a step back from a landed message goes to the one before it", () => {
    expect(stepTarget(reading(900 - STEP_PAD_PX), -1)).toBe(0);
    expect(stepTarget(reading(900 - STEP_PAD_PX), 1)).toBe(2);
  });

  test("the tail has no next, and its counter names the last message on screen", () => {
    const tail = reading(3400);
    expect(stepTarget(tail, 1)).toBeNull();
    expect(stepState(tail)).toMatchObject({ position: 4, total: 4, canNext: false, canPrev: true });
    expect(stepTarget(tail, -1)).toBe(3);
  });

  test("the oldest loaded message has no previous unless older history is unloaded", () => {
    const oldest = reading(100 - STEP_PAD_PX);
    expect(stepState(oldest)).toMatchObject({ position: 1, canPrev: false, canNext: true });
    const unloaded = stepState(reading(100 - STEP_PAD_PX, { olderUnloaded: true }));
    expect(unloaded.canPrev).toBe(true);
    expect(stepCountLabel(unloaded)).toBe("1 / 4+");
    expect(stepState(reading(0, { olderUnloaded: true })).canPrev).toBe(true);
  });

  test("the phone lands a message exactly on the feed's top edge", () => {
    const phone = reading(1500, { pad: 0 });
    expect(stepScrollTop(phone, 1)).toBe(900);
    expect(stepState(reading(900, { pad: 0 })).position).toBe(2);
    expect(stepTarget(reading(900, { pad: 0 }), -1)).toBe(0);
  });

  test("a message that cannot reach the reading line is clamped to the feed's end", () => {
    expect(stepScrollTop(reading(0, { maxScroll: 2000 }), 3)).toBe(2000);
  });

  test("a conversation with no own message offers nothing", () => {
    const empty = stepState(reading(0, { tops: [] }));
    expect(empty).toMatchObject({ position: 0, total: 0, canPrev: false, canNext: false });
    expect(stepCountLabel(empty)).toBe("0 / 0");
  });
});
