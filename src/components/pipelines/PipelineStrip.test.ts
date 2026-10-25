import { describe, expect, test } from "bun:test";

import { actionMenuPlacement, verdictPlacement } from "./PipelineStrip";

const viewport = { width: 1000, height: 800 };
const content = { width: 260, height: 200 };

describe("verdictPlacement (#93 finding: popover never renders off-screen)", () => {
  test("places the popover above a mid-page chip", () => {
    const anchor = { top: 400, bottom: 424, left: 470, width: 60 };
    const p = verdictPlacement(anchor, content, viewport);
    expect(p.below).toBe(false);
    expect(p.top).toBe(392); // anchor.top - margin
    expect(p.left).toBe(500); // chip center, unclamped
  });

  test("flips below when a chip near the page header leaves no room above", () => {
    /* 24px from the top: a 200px popover cannot fit above, and below has room. */
    const anchor = { top: 24, bottom: 48, left: 470, width: 60 };
    const p = verdictPlacement(anchor, content, viewport);
    expect(p.below).toBe(true);
    expect(p.top).toBe(56); // anchor.bottom + margin
  });

  test("clamps a chip near the left edge so the box stays on-screen", () => {
    const anchor = { top: 400, bottom: 424, left: 0, width: 20 };
    const p = verdictPlacement(anchor, content, viewport);
    /* center would be 10; half-width 130 + 8 margin forces left = 138. */
    expect(p.left).toBe(138);
  });

  test("clamps a chip near the right edge symmetrically", () => {
    const anchor = { top: 400, bottom: 424, left: 990, width: 20 };
    const p = verdictPlacement(anchor, content, viewport);
    /* center 1000 clamps to viewport.width - half - margin = 1000 - 130 - 8 = 862. */
    expect(p.left).toBe(862);
  });

  test("keeps the popover above when both sides are cramped and above has more room", () => {
    const anchor = { top: 300, bottom: 780, left: 470, width: 60 };
    const p = verdictPlacement(anchor, content, viewport);
    /* roomAbove 292 > roomBelow 12, so it stays above and does not flip into a
       worse spot. */
    expect(p.below).toBe(false);
  });

  test("clamps a tall popover placed above so its top edge and footer stay on-screen", () => {
    /* A long retry history bounds the box near 80vh; both edges must stay in view. */
    const tall = { width: 260, height: 700 };
    const anchor = { top: 400, bottom: 424, left: 470, width: 60 };
    const p = verdictPlacement(anchor, tall, viewport);
    expect(p.below).toBe(false);
    /* box occupies [top - height, top]; both within [margin, vh - margin]. */
    expect(p.top - tall.height).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeLessThanOrEqual(viewport.height - 8);
  });

  test("clamps a tall popover flipped below so its bottom edge stays on-screen", () => {
    const tall = { width: 260, height: 500 };
    const anchor = { top: 10, bottom: 34, left: 470, width: 60 };
    const p = verdictPlacement(anchor, tall, viewport);
    expect(p.below).toBe(true);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + tall.height).toBeLessThanOrEqual(viewport.height - 8);
  });
});

describe("actionMenuPlacement: the ⋯ menu stays inside an 8px gutter at its rendered size", () => {
  const inside = (p: { left: number; top: number; maxHeight: number }, menu: { width: number; height: number }, view: { width: number; height: number }) => {
    const height = Math.min(menu.height, p.maxHeight);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + menu.width).toBeLessThanOrEqual(view.width - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + height).toBeLessThanOrEqual(view.height - 8);
  };
  const menu = { width: 220, height: 420 };
  for (const view of [{ width: 1440, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 900 }]) {
    test(`at ${view.width}: below a trigger near the top, above one 160px from the bottom`, () => {
      const top = actionMenuPlacement({ top: 40, bottom: 68, right: view.width - 24 }, menu, view);
      expect(top.top).toBe(74);
      inside(top, menu, view);
      const bottom = actionMenuPlacement({ top: view.height - 160, bottom: view.height - 132, right: view.width - 2 }, menu, view);
      expect(bottom.top + menu.height).toBe(view.height - 166);
      inside(bottom, menu, view);
    });
  }
  test("a menu taller than both sides takes the taller side and is bounded to it", () => {
    const view = { width: 390, height: 500 };
    const p = actionMenuPlacement({ top: 300, bottom: 328, right: 380 }, menu, view);
    expect(p).toEqual({ left: 160, top: 8, maxHeight: 286 });
    inside(p, menu, view);
  });
});
