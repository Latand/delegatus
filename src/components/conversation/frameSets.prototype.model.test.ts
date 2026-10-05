import { describe, expect, test } from "bun:test";

import {
  chosenReply,
  coverFrames,
  frameAtView,
  frameSetInputDefects,
  framesOfVariant,
  FRAME_MAX_BYTES,
  FRAME_SET_MAX_FRAMES,
  setCounts,
  stepIndex,
  swipeDirection,
  viewsOf,
  type Frame,
  type FrameSet,
} from "./frameSets.prototype.model";

const frame = (variant: number | null, width: number, lang: string, n: number): Frame => ({
  id: `sha-${variant}-${width}-${lang}-${n}`, variant, caption: "", width, lang, w: width, h: 800, bytes: 1000, src: `/f/${n}`,
});

const set: FrameSet = {
  id: "fs_fixture",
  title: "Step between my own messages",
  source: { conversationId: "conversation_fixture", pipelineId: null, stageId: null, commit: null },
  createdAt: "2026-10-05T10:00:00.000Z",
  variants: [{ number: 1, title: "In the header" }, { number: 2, title: "A row above the composer" }],
  frames: [frame(1, 1440, "en", 0), frame(1, 390, "uk", 1), frame(2, 1440, "en", 2), frame(2, 390, "uk", 3), frame(null, 1440, "en", 4)],
};

describe("frame set prototype model", () => {
  test("a variant keeps its frames in the set's order, and a cover is each variant's first", () => {
    expect(framesOfVariant(set, 2).map((entry) => entry.src)).toEqual(["/f/2", "/f/3"]);
    expect(coverFrames(set).map((entry) => entry.src)).toEqual(["/f/0", "/f/2"]);
  });

  test("a compare pairs two variants at the same width and language", () => {
    expect(viewsOf(set).map((view) => view.key)).toEqual(["1440:en", "390:uk"]);
    expect(frameAtView(set, 2, "390:uk")?.src).toBe("/f/3");
    expect(frameAtView(set, 2, "440:en")).toBeNull();
  });

  test("a step stops at either end, and a swipe is sideways travel past the threshold", () => {
    expect(stepIndex(0, -1, 6)).toBe(0);
    expect(stepIndex(5, 1, 6)).toBe(5);
    expect(stepIndex(2, 1, 6)).toBe(3);
    expect(swipeDirection(-80, 10)).toBe(1);
    expect(swipeDirection(80, 10)).toBe(-1);
    expect(swipeDirection(-30, 0)).toBe(0);
    expect(swipeDirection(-80, 120)).toBe(0);
  });

  test("the chosen reply names the number and the title in the operator's language", () => {
    expect(chosenReply(set, 2, "en")).toBe("Variant 2 (A row above the composer).");
    expect(chosenReply(set, 2, "uk")).toBe("Варіант 2 (A row above the composer).");
    expect(chosenReply(set, 7, "en")).toBe("Variant 7.");
  });

  test("the closed row counts variants and frames with the language's plural forms", () => {
    expect(setCounts(set, "en")).toBe("2 variants · 5 frames");
    expect(setCounts(set, "uk")).toBe("2 варіанти · 5 кадрів");
    expect(setCounts({ ...set, variants: [], frames: [set.frames[0]!] }, "uk")).toBe("1 кадр");
  });

  test("a publication past a bound is refused with the bound named", () => {
    const paths = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `/w/frames/${index}.png`, variant: 1 }));
    const variants = [{ number: 1, title: "One" }];
    expect(frameSetInputDefects({ title: "Set", variants, frames: paths(3) })).toEqual([]);
    expect(frameSetInputDefects({ title: " ", variants, frames: [] })).toEqual(["a set needs a title", "a set needs at least one frame"]);
    expect(frameSetInputDefects({ title: "Set", variants, frames: paths(FRAME_SET_MAX_FRAMES + 1) })).toEqual([`a set holds at most ${FRAME_SET_MAX_FRAMES} frames`]);
    expect(frameSetInputDefects({ title: "Set", variants, frames: [{ path: "frames/a.png", variant: 2 }] })).toEqual([
      "frame 1 needs an absolute local path",
      "frame 1 names variant 2, which the set does not list",
    ]);
    expect(frameSetInputDefects({ title: "Set", variants, frames: paths(1) }, [FRAME_MAX_BYTES + 1])).toEqual(["frame 1 is larger than 4 MB"]);
  });
});
