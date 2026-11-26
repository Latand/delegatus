import { expect, test } from "bun:test";

import { chooseSpendPlacement, overlapArea, spendCandidates, type Box } from "./spendPopoverPlacement";

const viewport = { width: 1440, height: 900 };
/* A bubble that wraps taller the narrower it is: 60 000 px² of text, at most 320 wide. */
const sizeAt = (maxWidth: number) => ({ width: maxWidth, height: Math.ceil(60_000 / maxWidth) });
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const card = box(570, 180, 1010, 570);
const anchor = box(930, 228, 1000, 244);
const kinds = (c: ReturnType<typeof spendCandidates>) => c.map((x) => x.kind);

test("the overlap of two boxes is their shared area, and touching boxes share none", () => {
  expect(overlapArea(box(0, 0, 10, 10), box(5, 5, 20, 20))).toBe(25);
  expect(overlapArea(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(0);
  expect(overlapArea(box(0, 0, 10, 10), box(30, 30, 40, 40))).toBe(0);
});

test("a wide card offers its own area first, then each side, below and above", () => {
  const found = spendCandidates({ viewport, card, anchor }, sizeAt);
  expect(kinds(found)).toEqual(["over", "right", "left", "below", "above"]);
  const over = found[0]!;
  expect(over.left).toBe(card.left + 8);
  expect(over.top).toBe(anchor.bottom + 8);
  expect(over.maxWidth).toBe(320);
});

test("a card too narrow for the bubble offers no place over itself, and a card with no room beside it no side", () => {
  const narrow = box(277, 190, 500, 400);
  expect(kinds(spendCandidates({ viewport, card: narrow, anchor: box(420, 230, 490, 246) }, sizeAt))).not.toContain("over");
  const fills = box(8, 100, 1432, 400);
  expect(kinds(spendCandidates({ viewport, card: fills, anchor: box(1300, 120, 1400, 136) }, sizeAt))).toEqual(["over", "below", "above"]);
});

test("every candidate stays inside the window", () => {
  for (const found of [
    spendCandidates({ viewport, card: box(1100, 700, 1430, 890), anchor: box(1350, 720, 1420, 736) }, sizeAt),
    spendCandidates({ viewport, card: box(10, 2, 300, 120), anchor: box(230, 10, 290, 26) }, sizeAt),
  ]) {
    for (const c of found) {
      expect(c.left).toBeGreaterThanOrEqual(8);
      expect(c.top).toBeGreaterThanOrEqual(8);
      expect(c.left + c.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(c.top + c.height).toBeLessThanOrEqual(viewport.height - 8);
    }
  }
});

test("the place that covers no foreign text wins, and an earlier place wins a tie", () => {
  const found = spendCandidates({ viewport, card, anchor }, sizeAt);
  expect(chooseSpendPlacement(found, { own: [], foreign: [] })!.kind).toBe("over");
  /* Text of the next column under the right-hand place does not matter when the card's own area is free. */
  expect(chooseSpendPlacement(found, { own: [], foreign: [box(1020, 230, 1200, 246)] })!.kind).toBe("over");
});

test("foreign text under the preferred places moves the bubble to the one that covers the least", () => {
  const found = spendCandidates({ viewport, card, anchor }, sizeAt);
  const over = found.find((c) => c.kind === "over")!;
  const right = found.find((c) => c.kind === "right")!;
  const left = found.find((c) => c.kind === "left")!;
  const text = [
    /* A neighbouring card's title under «over», and a heading under «right». */
    box(over.left + 10, over.top + 10, over.left + 200, over.top + 26),
    box(right.left + 10, right.top + 10, right.left + 300, right.top + 26),
  ];
  expect(chooseSpendPlacement(found, { own: [], foreign: text })!.kind).toBe("left");
  const tight = [...text, box(left.left + 10, left.top + 10, left.left + 100, left.top + 26)];
  const picked = chooseSpendPlacement(found, { own: [], foreign: tight })!;
  /* «over» and both sides are covered; below or above the card is free. */
  expect(["below", "above"]).toContain(picked.kind);
});

test("other cards' text decides first: a bubble over a lot of its own card's text beats one over a little of a neighbour's", () => {
  const found = spendCandidates({ viewport, card, anchor }, sizeAt);
  const under = (kind: string, width: number) => {
    const c = found.find((x) => x.kind === kind)!;
    return box(c.left + 10, c.top + 10, c.left + 10 + width, c.top + 26);
  };
  const foreign = ["right", "left", "below", "above"].map((kind) => under(kind, 20));
  expect(chooseSpendPlacement(found, { own: [under("over", 300)], foreign })!.kind).toBe("over");
});

test("with nothing foreign anywhere, the place that covers the least of the card's own text wins", () => {
  const found = spendCandidates({ viewport, card, anchor }, sizeAt);
  const over = found.find((x) => x.kind === "over")!;
  const own = box(over.left + 10, over.top + 10, over.left + 300, over.top + 26);
  expect(chooseSpendPlacement(found, { own: [own], foreign: [] })!.kind).toBe("right");
  expect(chooseSpendPlacement(found, { own: [], foreign: [] })!.kind).toBe("over");
});

test("a neighbour's title outranks the rest of its card's text", () => {
  const found = spendCandidates({ viewport, card, anchor }, sizeAt);
  const under = (kind: string, width: number) => {
    const c = found.find((x) => x.kind === kind)!;
    return box(c.left + 10, c.top + 10, c.left + 10 + width, c.top + 26);
  };
  /* A title under «over» and a large block of body text under every other place: the body text is covered rather than the title. */
  const neighbours = ["right", "left", "below", "above"].map((kind) => under(kind, 300));
  expect(chooseSpendPlacement(found, { own: [], foreign: [under("over", 20)], neighbours })!.kind).not.toBe("over");
});
