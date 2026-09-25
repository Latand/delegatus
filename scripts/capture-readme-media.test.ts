import { expect, test } from "bun:test";

import { judgeRenderBack, RENDER_BACK_TILE, RENDER_BACK_TILE_LIMIT, ringClipPath, type RingBox } from "./capture-readme-media";

const box = (overrides: Partial<RingBox> = {}): RingBox => ({
  width: 200,
  height: 60,
  inset: { top: 2, right: 2, bottom: 2, left: 2 },
  radii: [[12, 12], [12, 12], [12, 12], [12, 12]],
  ...overrides,
});

test("a ring's clip is the border box less the content box, cut even-odd", () => {
  expect(ringClipPath(box())).toBe(
    'path(evenodd, "'
      + "M 12 0 H 188 A 12 12 0 0 1 200 12 V 48 A 12 12 0 0 1 188 60 H 12 A 12 12 0 0 1 0 48 V 12 A 12 12 0 0 1 12 0 Z "
      + "M 12 2 H 188 A 10 10 0 0 1 198 12 V 48 A 10 10 0 0 1 188 58 H 12 A 10 10 0 0 1 2 48 V 12 A 10 10 0 0 1 12 2 Z"
      + '")',
  );
});

test("the hole's corners lose the inset on each side and never go below zero", () => {
  const clip = ringClipPath(box({ inset: { top: 2, right: 2, bottom: 2, left: 14 }, radii: [[12, 12], [0, 0], [12, 12], [12, 12]] }));
  const hole = clip.slice(clip.indexOf("Z M") + 2);
  /* Left corners: 12 − 14 clamps the horizontal radius to 0, a square
     corner; the vertical one and the right corners lose 2. */
  expect(hole).toStartWith("M 14 2 H 198 A 0 0 0 0 1 198 2 V 48 A 10 10 0 0 1 188 58 H 14 A 0 10 0 0 1 14 48");
});

test("radii that overflow a side shrink by one factor, as CSS draws them", () => {
  const clip = ringClipPath(box({ width: 40, height: 20, inset: { top: 0, right: 0, bottom: 0, left: 0 }, radii: [[999, 999], [999, 999], [999, 999], [999, 999]] }));
  /* The short side (20) holds two radii, so each becomes 10. */
  expect(clip).toContain("M 10 0 H 30 A 10 10 0 0 1 40 10");
});

const frame = (width: number, height: number, paint?: (x: number, y: number) => number) => {
  const map = new Uint8Array(width * height);
  if (paint) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) map[y * width + x] = paint(x, y);
  return map;
};

test("identical frames pass", () => {
  const verdict = judgeRenderBack(frame(320, 256), 320, 256);
  expect(verdict).toEqual({ ok: true, worstTile: { x: 0, y: 0, mean: 0 }, changedTileShare: 0, meanDifference: 0 });
});

test("a filled box where a ring belongs fails on the tile it fills", () => {
  /* A 2 px ring around a 256×96 card, filled solid instead: the card's inside differs by 180. */
  const verdict = judgeRenderBack(frame(640, 320, (x, y) => (x >= 64 && x < 320 && y >= 96 && y < 192 ? 180 : 0)), 640, 320);
  expect(verdict.ok).toBe(false);
  expect(verdict.worstTile).toEqual({ x: 64, y: 96, mean: 180 });
});

test("one mis-painted chip the size of a tile fails in an otherwise identical frame", () => {
  const verdict = judgeRenderBack(frame(2560, 1600, (x, y) => (x >= 640 && x < 640 + RENDER_BACK_TILE && y >= 320 && y < 320 + RENDER_BACK_TILE ? 120 : 0)), 2560, 1600);
  expect(verdict.ok).toBe(false);
  expect(verdict.changedTileShare).toBeLessThan(0.001);
  expect(verdict.worstTile.mean).toBeGreaterThan(RENDER_BACK_TILE_LIMIT);
});

test("antialiasing-sized differences on glyph edges pass", () => {
  /* One pixel in sixteen off by 60, as glyph edges drawn as paths and as
     text are: the six committed frames' worst tiles measured 3 to 7. */
  const verdict = judgeRenderBack(frame(640, 320, (x, y) => ((x + 3 * y) % 16 === 0 ? 60 : 0)), 640, 320);
  expect(verdict.ok).toBe(true);
  expect(verdict.worstTile.mean).toBeLessThan(RENDER_BACK_TILE_LIMIT);
});

test("a shift across the whole frame fails even when every tile stays under the limit", () => {
  const verdict = judgeRenderBack(frame(640, 320, () => 12), 640, 320);
  expect(verdict.ok).toBe(false);
  expect(verdict.worstTile.mean).toBe(12);
  expect(verdict.changedTileShare).toBe(1);
});

test("a map of the wrong size is refused", () => {
  expect(() => judgeRenderBack(new Uint8Array(10), 4, 4)).toThrow("expected 16");
});
