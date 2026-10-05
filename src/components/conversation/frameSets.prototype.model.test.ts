import { describe, expect, test } from "bun:test";

import {
  chosenReply,
  coverFrames,
  frameAtView,
  frameFromFileName,
  framesFromFileNames,
  frameSetInputDefects,
  framesOfVariant,
  FRAME_MAX_BYTES,
  FRAME_SET_MAX_FRAMES,
  justifiedRows,
  setCounts,
  stepIndex,
  stripTiles,
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

  test("a file name says the variant, the width and the language of its frame", () => {
    expect(frameFromFileName("/var/tmp/lane/variant-4-pane-440-en-open.png")).toEqual({ variant: 4, width: 440, lang: "en", caption: "pane open" });
    expect(frameFromFileName("variant-1-desktop-1440-uk-closed.png")).toEqual({ variant: 1, width: 1440, lang: "uk", caption: "desktop closed" });
    expect(frameFromFileName("v2_phone_390_en.webp")).toEqual({ variant: 2, width: 390, lang: "en", caption: "phone" });
    /* Variant 0 is the pane without the feature: a frame of no variant. */
    expect(frameFromFileName("variant-0-phone-390-uk-closed.png").variant).toBeNull();
    /* A name outside the convention is a plain captioned frame; a small number is no width. */
    expect(frameFromFileName("board-after-12.jpg")).toEqual({ variant: null, width: null, lang: null, caption: "board after 12" });
  });

  test("a directory is published by variant, then by name, numbers as numbers", () => {
    const ordered = framesFromFileNames([
      "variant-2-desktop-1440-en-10.png", "variant-2-desktop-1440-en-9.png", "notes.md", "variant-0-desktop-1440-en.png", "variant-1-phone-390-uk.png",
    ]).map((entry) => entry.name);
    expect(ordered).toEqual(["variant-1-phone-390-uk.png", "variant-2-desktop-1440-en-9.png", "variant-2-desktop-1440-en-10.png", "variant-0-desktop-1440-en.png"]);
  });

  test("the collage fills a row with frames at their own proportions", () => {
    /* Two desktop frames, two pane frames, two phone frames: the fixture's variant. */
    const aspects = [1.6, 1.6, 0.55, 0.55, 0.462, 0.462];
    const [row, ...more] = justifiedRows(aspects, 663, { target: 120, gap: 6 });
    expect(more).toEqual([]);
    expect(row!.tiles).toHaveLength(6);
    expect(row!.height).toBeGreaterThanOrEqual(120);
    expect(row!.tiles.reduce((total, tile) => total + tile.width, 0) + 6 * 5).toBeLessThanOrEqual(663);
    expect(row!.tiles[0]!.width).toBeGreaterThanOrEqual(190);
    /* Too narrow for six: the row wraps, and every row still fits. */
    const wrapped = justifiedRows(aspects, 360, { target: 120, gap: 6 });
    expect(wrapped.length).toBeGreaterThan(1);
    for (const each of wrapped) expect(each.tiles.reduce((total, tile) => total + tile.width, 0) + 6 * (each.tiles.length - 1)).toBeLessThanOrEqual(360);
    expect(wrapped.flatMap((each) => each.tiles.map((tile) => tile.index))).toEqual([0, 1, 2, 3, 4, 5]);
    /* A few frames never stretch into giants. */
    expect(justifiedRows([1.6], 1300, { target: 120, gap: 6 })[0]!.height).toBeLessThanOrEqual(150);
  });

  test("a narrow pane gets one row at a fixed height, wide enough to press", () => {
    const strip = stripTiles([1.6, 0.462], 76, 44);
    expect(strip).toEqual({ height: 76, tiles: [{ index: 0, width: 122 }, { index: 1, width: 44 }] });
    expect(setCounts(set, "en", true)).toBe("5 frames");
  });
});
