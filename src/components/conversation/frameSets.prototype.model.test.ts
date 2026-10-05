import { describe, expect, test } from "bun:test";

import { admittedAs } from "@/lib/artifact/localFile";

import {
  chosenReply,
  coverFrames,
  frameAtView,
  frameFromFileName,
  framesFromFileNames,
  frameSetInputDefects,
  frameSourceRefusal,
  frameSourceRoot,
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
    /* A variant's title stands whole beside its button, so it has a bound of its own. */
    expect(frameSetInputDefects({ title: "Set", variants: [{ number: 1, title: "x".repeat(61) }], frames: paths(1) })).toEqual(["variant 1 has a title longer than 60 characters"]);
  });

  test("a file name says the variant, the width and the language of its frame", () => {
    expect(frameFromFileName("/var/tmp/lane/variant-4-pane-440-en-open.png")).toEqual({ variant: 4, width: 440, lang: "en", caption: "pane open" });
    expect(frameFromFileName("variant-1-desktop-1440-uk-closed.png")).toEqual({ variant: 1, width: 1440, lang: "uk", caption: "desktop closed" });
    expect(frameFromFileName("v2_phone_390_en.webp")).toEqual({ variant: 2, width: 390, lang: "en", caption: "phone" });
    /* Variant 0 is the pane without the feature: a frame of no variant. */
    expect(frameFromFileName("variant-0-phone-390-uk-closed.png").variant).toBeNull();
    /* A name outside the convention is a plain captioned frame; a small number is no width. */
    expect(frameFromFileName("board-after-12.jpg")).toEqual({ variant: null, width: null, lang: null, caption: "board after 12" });
    /* A number before the variant is no width, whatever its size: a pull request's number stays in the caption. */
    expect(frameFromFileName("pr-2521-variant-2-390-en.png")).toEqual({ variant: 2, width: 390, lang: "en", caption: "pr 2521" });
    /* A viewport written as width by height gives its width. */
    expect(frameFromFileName("variant-3-desktop-1440x900-uk.png")).toEqual({ variant: 3, width: 1440, lang: "uk", caption: "desktop" });
    expect(frameFromFileName("board-1440x900.png")).toEqual({ variant: null, width: 1440, lang: null, caption: "board" });
  });

  test("a directory is published by variant, then by name, numbers as numbers", () => {
    const ordered = framesFromFileNames([
      "variant-2-desktop-1440-en-10.png", "variant-2-desktop-1440-en-9.png", "notes.md", "variant-0-desktop-1440-en.png", "variant-1-phone-390-uk.png",
    ]).map((entry) => entry.name);
    expect(ordered).toEqual(["variant-1-phone-390-uk.png", "variant-2-desktop-1440-en-9.png", "variant-2-desktop-1440-en-10.png", "variant-0-desktop-1440-en.png"]);
  });

  test("a frame is read from where the image route reads, and a refusal says where to put it", () => {
    const roots = { home: "/work/home", evidence: ["/var/tmp"] };
    /* The four places a lane's frames usually are. */
    const places = {
      worktree: "/work/home/work/lane/.artifacts/frame-sets/variant-4-pane-440-en-open.png",
      stage: "/work/home/.config/delegatus/state/scratch/llv-stage-abc/tmp/out/variant-4-pane-440-en-open.png",
      evidence: "/var/tmp/lane/variant-4-pane-440-en-open.png",
      temp: "/tmp/fs-lane/out/variant-4-pane-440-en-open.png",
    };
    expect(Object.fromEntries(Object.entries(places).map(([place, path]) => [place, frameSourceRoot(path, roots)]))).toEqual({ worktree: "home", stage: "home", evidence: "evidence", temp: null });
    /* The same answer the image route gives each of them. */
    for (const path of Object.values(places)) expect(frameSourceRoot(path, roots)).toBe(admittedAs(path, roots));
    expect(frameSourceRoot("/work/home-other/a.png", roots)).toBeNull();
    for (const path of [places.worktree, places.stage, places.evidence, "/work/home/work/lane/.artifacts/frame-sets"]) expect(frameSourceRefusal(path, roots)).toBeNull();
    /* The short form names a directory, the full form a file: both get the same copy. */
    const refusal = "is outside what Delegatus reads. Frames are read from: your worktree (the capture drivers write to .artifacts/ in it); the stage's own directory ($TMPDIR); /var/tmp."
      + " Nothing was published. Copy the frames and call again with the copy: cp -r /tmp/fs-lane/out /var/tmp/frames-fs-lane-out";
    expect(frameSourceRefusal("/tmp/fs-lane/out", roots)).toBe(`/tmp/fs-lane/out ${refusal}`);
    expect(frameSourceRefusal(places.temp, roots)).toBe(`${places.temp} ${refusal}`);
    /* An installation with no evidence root has nowhere to copy to, and says only where it reads. */
    expect(frameSourceRefusal("/tmp/fs-lane/out", { home: "/work/home", evidence: [] })).toBe(
      "/tmp/fs-lane/out is outside what Delegatus reads. Frames are read from: your worktree (the capture drivers write to .artifacts/ in it); the stage's own directory ($TMPDIR). Nothing was published.",
    );
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
