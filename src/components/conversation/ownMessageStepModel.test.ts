import { describe, expect, test } from "bun:test";

import { STEP_PAD_DESKTOP_PX as STEP_PAD_PX, stepCountLabel, stepRowOffered, stepScrollTop, stepState, stepTarget, type StepReading } from "./ownMessageStepModel";

const TOPS = [100, 900, 2400, 3100];
type Over = Partial<Omit<StepReading, "count" | "top">> & { tops?: readonly number[] };
const reading = (scrollTop: number, { tops = TOPS, ...over }: Over = {}): StepReading => ({
  count: tops.length, top: (index) => tops[index]!,
  scrollTop, viewport: 600, maxScroll: 3400, atTail: false, olderOwn: 0, olderUnloaded: false, pad: STEP_PAD_PX, ...over,
});

describe("own-message steps: the arithmetic", () => {
  test("a step back from the middle of a reply lands on the message that reply answers", () => {
    expect(stepTarget(reading(1500), -1)).toBe(1);
    expect(stepScrollTop(reading(1500), 1)).toBe(900 - STEP_PAD_PX);
  });

  test("a step back from a landed message goes to the one before it", () => {
    expect(stepTarget(reading(900 - STEP_PAD_PX), -1)).toBe(0);
    expect(stepTarget(reading(900 - STEP_PAD_PX), 1)).toBe(2);
  });

  test("the tail has no next, and its counter names the last message on screen", () => {
    const tail = reading(3400, { atTail: true });
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

  test("a phone feed holding its tail a few pixels short of the end is at the tail", () => {
    /* #1978: the followed phone feed rests with a row starting at its top
       edge, which can leave it short of the very end. The last own message
       has started on screen, so it is the one being read. */
    const resting = reading(5187, { tops: [100, 5400], maxScroll: 5200, atTail: true, pad: 0 });
    expect(stepState(resting)).toMatchObject({ position: 2, total: 2, canNext: false, canPrev: true });
    expect(stepTarget(resting, 1)).toBeNull();
    /* The same place after the reader let go of the tail is an ordinary one. */
    expect(stepState({ ...resting, atTail: false })).toMatchObject({ position: 1, canNext: true });
  });

  test("own messages above the page are counted, and a step back goes into them", () => {
    /* The page holds the last rows only: three own messages are in loaded
       history above it. */
    const windowed = reading(3400, { atTail: true, olderOwn: 3 });
    expect(stepState(windowed)).toMatchObject({ position: 7, total: 7, olderUnloaded: false, canPrev: true });
    const oldestOnPage = stepState(reading(100 - STEP_PAD_PX, { olderOwn: 3 }));
    expect(oldestOnPage).toMatchObject({ position: 4, total: 7, canPrev: true });
    expect(stepCountLabel(oldestOnPage)).toBe("4 / 7");
    /* A page with no own message on it at all still knows where it is. */
    const none = stepState(reading(3400, { tops: [], atTail: true, olderOwn: 9 }));
    expect(none).toMatchObject({ position: 9, total: 9, canPrev: true, canNext: false });
  });

  test("the answers are bisected: a long conversation costs a handful of reads", () => {
    const tops = Array.from({ length: 4096 }, (_, index) => index * 500);
    let reads = 0;
    const long: StepReading = { ...reading(1_000_000 - STEP_PAD_PX, { tops }), top: (index) => { reads += 1; return tops[index]!; } };
    expect(stepState(long).position).toBe(2001);
    expect(reads).toBeLessThanOrEqual(3 * 13);
    expect(stepTarget(long, -1)).toBe(1999);
    expect(stepTarget(long, 1)).toBe(2001);
  });

  test("the row is offered for two own messages, or while unloaded history may hold them", () => {
    const state = (over: Over) => stepState(reading(0, over));
    expect(stepRowOffered(state({ tops: [100, 900] }), false)).toBe(true);
    expect(stepRowOffered(state({ tops: [100] }), true)).toBe(false);
    expect(stepRowOffered(state({ tops: [] , olderOwn: 2 }), false)).toBe(true);
    /* One on the page and history still unloaded: the count is open. */
    expect(stepRowOffered(state({ tops: [100], olderUnloaded: true }), false)).toBe(true);
    /* None loaded: only a conversation the operator is known to have written in. */
    expect(stepRowOffered(state({ tops: [], olderUnloaded: true }), true)).toBe(true);
    expect(stepRowOffered(state({ tops: [], olderUnloaded: true }), false)).toBe(false);
  });

  test("a conversation with no own message offers nothing", () => {
    const empty = stepState(reading(0, { tops: [] }));
    expect(empty).toMatchObject({ position: 0, total: 0, canPrev: false, canNext: false });
    expect(stepCountLabel(empty)).toBe("0 / 0");
  });
});
