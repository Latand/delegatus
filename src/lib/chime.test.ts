import { describe, expect, test } from "bun:test";

import { SOUNDS } from "./audio/synth";
import { hasLiveFeed, registerLiveFeed } from "./chime";

describe("dictation cap chimes are distinct and correctly shaped", () => {
  test("the near-cap warning is two quick pings at one pitch", () => {
    const warn = SOUNDS["dict-warn"].strikes;
    expect(warn).toHaveLength(2);
    expect(warn[0]!.hz).toBe(warn[1]!.hz);
    expect(warn[1]!.at - warn[0]!.at).toBeCloseTo(0.11, 6);
  });

  test("the cap stop is an unmistakably descending two-note", () => {
    const stop = SOUNDS["dict-stop"].strikes;
    expect(stop).toHaveLength(2);
    expect(stop[1]!.hz).toBeLessThan(stop[0]!.hz);
    expect(stop[1]!.at).toBeGreaterThan(stop[0]!.at);
  });

  test("the stop tune sits below the warning ping so the ear reads 'ended'", () => {
    const stopLow = Math.min(...SOUNDS["dict-stop"].strikes.map((note) => note.hz));
    expect(stopLow).toBeLessThan(SOUNDS["dict-warn"].strikes[0]!.hz);
  });

  test("the warning is never the one short note of S3, which can sound while the operator dictates", () => {
    expect(SOUNDS.step.strikes).toHaveLength(1);
    expect(SOUNDS["dict-warn"].strikes.length).not.toBe(SOUNDS.step.strikes.length);
  });
});

describe("the live feeds of this tab", () => {
  test("a conversation counts as live while any running feed shows it", () => {
    expect(hasLiveFeed("conv-1")).toBe(false);
    const board = registerLiveFeed("conv-1");
    const overlay = registerLiveFeed("conv-1");
    expect(hasLiveFeed("conv-1")).toBe(true);
    board();
    expect(hasLiveFeed("conv-1")).toBe(true);
    overlay();
    expect(hasLiveFeed("conv-1")).toBe(false);
  });

  test("releasing the same registration twice cannot release another surface's", () => {
    const first = registerLiveFeed("conv-2");
    const second = registerLiveFeed("conv-2");
    first();
    first();
    expect(hasLiveFeed("conv-2")).toBe(true);
    second();
    expect(hasLiveFeed("conv-2")).toBe(false);
  });
});
