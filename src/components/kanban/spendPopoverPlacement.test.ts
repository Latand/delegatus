import { expect, test } from "bun:test";

import { chooseSpendPlacement, cutBy, overlapArea, settleSpendPlacement, spendCandidates, type Box } from "./spendPopoverPlacement";

const viewport = { width: 1440, height: 900 };
/* A bubble that wraps taller the narrower it is: 60 000 px² of text, at most 320 wide. */
const sizeAt = (maxWidth: number) => ({ width: maxWidth, height: Math.ceil(60_000 / maxWidth) });
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const card = box(570, 180, 1010, 570);
const anchor = box(930, 228, 1000, 244);
const kinds = (c: ReturnType<typeof spendCandidates>) => c.map((x) => x.kind);
/* The five first-choice places, whose preference order these cases judge. */
const classic = () => spendCandidates({ viewport, card, anchor }, sizeAt).filter((c) => ["over", "right", "left", "below", "above"].includes(c.kind));

test("the overlap of two boxes is their shared area, and touching boxes share none", () => {
  expect(overlapArea(box(0, 0, 10, 10), box(5, 5, 20, 20))).toBe(25);
  expect(overlapArea(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(0);
  expect(overlapArea(box(0, 0, 10, 10), box(30, 30, 40, 40))).toBe(0);
});

test("a wide card offers its own area first, then each side, below and above", () => {
  const found = spendCandidates({ viewport, card, anchor }, sizeAt);
  const names = kinds(found);
  expect(names[0]).toBe("over");
  expect(names.slice(-4)).toEqual(["right", "left", "below", "above"]);
  const over = found[0]!;
  expect(over.left).toBe(card.left + 8);
  expect(over.top).toBe(anchor.bottom + 8);
  expect(over.maxWidth).toBe(320);
  /* Over the card it can also stand at the card's top edge or end at its bottom edge. */
  expect(found.find((c) => c.kind === "over-top")!.top).toBe(card.top);
  const bottom = found.find((c) => c.kind === "over-bottom")!;
  expect(bottom.top + bottom.height).toBe(card.bottom);
  /* Beside, above and below it touches the card. */
  expect(found.find((c) => c.kind === "right")!.left).toBe(card.right);
  expect(found.find((c) => c.kind === "below")!.top).toBe(card.bottom);
});

test("a narrow card is covered whole by a bubble wider than itself, from either side", () => {
  const narrow = box(1142, 441, 1385, 609);
  const found = spendCandidates({ viewport, card: narrow, anchor: box(1300, 495, 1375, 509) }, sizeAt);
  const wide = found.filter((c) => c.kind.startsWith("over") && c.maxWidth === 320);
  expect(wide.some((c) => c.kind.endsWith("-right"))).toBe(true);
  expect(wide.some((c) => c.left < narrow.left)).toBe(true);
});

test("a card too narrow for the bubble offers no place over itself, and a card with no room beside it no side", () => {
  const narrow = box(277, 190, 400, 400);
  expect(kinds(spendCandidates({ viewport, card: narrow, anchor: box(320, 230, 390, 246) }, sizeAt)).filter((k) => k.startsWith("over")).every((k) => k.includes("wide"))).toBe(true);
  const fills = box(8, 100, 1432, 400);
  const names = kinds(spendCandidates({ viewport, card: fills, anchor: box(1300, 120, 1400, 136) }, sizeAt));
  expect(names).not.toContain("right");
  expect(names).not.toContain("left");
  expect(names).toContain("below");
});

test("a bubble stays inside the board and out of the seat: the sidebar's room is not offered", () => {
  /* A board that starts at 248, a card at its right, and room on the left only in the sidebar. */
  const board = box(248, 48, 1000, 700);
  const small = { width: 1000, height: 700 };
  const found = spendCandidates({ viewport: small, card: box(273, 108, 950, 560), anchor: box(905, 336, 937, 350), bounds: board }, sizeAt);
  for (const c of found) {
    expect(c.left).toBeGreaterThanOrEqual(248);
    expect(c.left + c.width).toBeLessThanOrEqual(992);
  }
  const seat = box(248, 48, 1000, 300);
  const kept = spendCandidates({ viewport: small, card: box(273, 308, 950, 560), anchor: box(905, 336, 937, 350), bounds: board, avoid: [seat] }, sizeAt);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.every((c) => overlapArea({ left: c.left, top: c.top, right: c.left + c.width, bottom: c.top + c.height }, seat) === 0)).toBe(true);
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
  const found = classic();
  expect(chooseSpendPlacement(found, { own: [], foreign: [] })!.kind).toBe("over");
  /* Text of the next column under the right-hand place does not matter when the card's own area is free. */
  expect(chooseSpendPlacement(found, { own: [], foreign: [box(1020, 230, 1200, 246)] })!.kind).toBe("over");
});

test("foreign text under the preferred places moves the bubble to the one that covers the least", () => {
  const found = classic();
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
  const found = classic();
  const under = (kind: string, width: number) => {
    const c = found.find((x) => x.kind === kind)!;
    return box(c.left + 10, c.top + 10, c.left + 10 + width, c.top + 26);
  };
  const foreign = ["right", "left", "below", "above"].map((kind) => under(kind, 20));
  expect(chooseSpendPlacement(found, { own: [under("over", 300)], foreign })!.kind).toBe("over");
});

test("with nothing foreign anywhere, the place that covers the least of the card's own text wins", () => {
  const found = classic();
  const over = found.find((x) => x.kind === "over")!;
  const own = box(over.left + 10, over.top + 10, over.left + 300, over.top + 26);
  expect(chooseSpendPlacement(found, { own: [own], foreign: [] })!.kind).toBe("right");
  expect(chooseSpendPlacement(found, { own: [], foreign: [] })!.kind).toBe("over");
});

test("a neighbour's title outranks the rest of its card's text", () => {
  const found = classic();
  const under = (kind: string, width: number) => {
    const c = found.find((x) => x.kind === kind)!;
    return box(c.left + 10, c.top + 10, c.left + 10 + width, c.top + 26);
  };
  /* A title under «over» and a large block of body text under every other place: the body text is covered rather than the title. */
  const neighbours = ["right", "left", "below", "above"].map((kind) => under(kind, 300));
  expect(chooseSpendPlacement(found, { own: [], foreign: [under("over", 20)], neighbours })!.kind).not.toBe("over");
});

test("a place that covers none of the other cards' text wins even when it covers all of its own card", () => {
  const narrow = box(1142, 441, 1385, 609);
  const where = { viewport, card: narrow, anchor: box(1300, 495, 1375, 509) };
  const found = spendCandidates(where, (maxWidth) => ({ width: maxWidth, height: 186 }));
  /* The card below begins with its text at 636; the card above ends at 430, the neighbouring column is text up to 1093. */
  const neighbours = [box(1142, 636, 1385, 652), box(1142, 410, 1385, 430), box(852, 190, 1093, 700)];
  const picked = chooseSpendPlacement(found, { own: [box(1160, 520, 1300, 536)], ownTitle: [box(1165, 456, 1290, 472)], foreign: [], neighbours, anchor: where.anchor })!;
  expect(overlapArea({ left: picked.left, top: picked.top, right: picked.left + picked.width, bottom: picked.top + picked.height }, neighbours[0]!)).toBe(0);
  expect(overlapArea({ left: picked.left, top: picked.top, right: picked.left + picked.width, bottom: picked.top + picked.height }, neighbours[2]!)).toBe(0);
});

test("a line of the card's text that a place would cut is taken whole, never left as a fragment", () => {
  const cardBox = box(570, 330, 1012, 720);
  const lines = [box(895, 400, 990, 416), box(590, 560, 700, 576)];
  const placed = { kind: "over", left: 578, top: 360, width: 320, height: 208, maxWidth: 320 };
  expect(cutBy({ left: 578, top: 360, right: 898, bottom: 568 }, lines)).toHaveLength(2);
  const settled = settleSpendPlacement(placed, lines, { card: cardBox, area: box(248, 48, 1000, 700) });
  expect(cutBy({ left: settled.left, top: settled.top, right: settled.left + settled.width, bottom: settled.top + settled.height }, lines)).toEqual([]);
  expect(settled.left + settled.width).toBeLessThanOrEqual(1000);
  /* A place that cuts nothing is left as it was. */
  expect(settleSpendPlacement({ ...placed, left: 700, top: 600 }, lines, { card: cardBox, area: box(248, 48, 1000, 700) })).toMatchObject({ left: 700, top: 600, width: 320, height: 208 });
});

test("a line cut at a place's top edge moves the place below it", () => {
  const settled = settleSpendPlacement({ kind: "over", left: 578, top: 400, width: 320, height: 100, maxWidth: 320 }, [box(600, 394, 700, 410)], { card: box(570, 300, 1012, 700), area: box(248, 48, 1000, 700) });
  expect(settled.top).toBeGreaterThanOrEqual(410);
});
