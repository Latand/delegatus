import { expect, test } from "bun:test";

import { COMPACT_SUFFIX, chooseSpendPlacement, clearOf, cutBy, overlapArea, settleSpendPlacement, spendCandidates, type Box } from "./spendPopoverPlacement";

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

test("the card's own title and state line outrank a neighbour's body text, so the bubble flips off the card", () => {
  const narrow = box(1142, 441, 1385, 609);
  const where = { viewport, card: narrow, anchor: box(1300, 495, 1375, 509) };
  const found = spendCandidates(where, (maxWidth) => ({ width: maxWidth, height: 186 }));
  /* The card below begins with its text at 636; the card above ends at 430, the neighbouring column is text up to 1093. */
  const neighbours = [box(1142, 636, 1385, 652), box(1142, 410, 1385, 430), box(852, 190, 1093, 700)];
  const ownTitle = [box(1165, 456, 1290, 472)];
  const ownState = [box(1160, 495, 1290, 509)];
  const picked = chooseSpendPlacement(found, { own: [box(1160, 520, 1300, 536)], ownTitle, ownState, foreign: [], neighbours, anchor: where.anchor })!;
  const at = { left: picked.left, top: picked.top, right: picked.left + picked.width, bottom: picked.top + picked.height };
  expect(overlapArea(at, ownTitle[0]!)).toBe(0);
  expect(overlapArea(at, ownState[0]!)).toBe(0);
  expect(overlapArea(at, where.anchor)).toBe(0);
});

test("where the band under the seat holds only the card's top, the bubble covers the column header and spares the card's title and state line", () => {
  const board = box(248, 0, 1440, 900);
  const seat = box(317, 60, 1357, 735);
  /* A card at the window's bottom: its top at 842, its title and state line just under it, the column header above it. */
  const cardBox = box(570, 842, 1010, 1100);
  const where = { viewport, card: cardBox, anchor: box(930, 888, 1000, 899), bounds: board, avoid: [seat], compactable: true };
  const found = spendCandidates(where, arranged);
  const header = [box(580, 800, 700, 816)];
  const ownTitle = [box(590, 855, 800, 871)];
  const ownState = [box(590, 884, 700, 899)];
  const picked = chooseSpendPlacement(found, { own: [], ownTitle, ownState, foreign: header, keepOut: [seat], anchor: where.anchor }, { card: cardBox, area: box(248, 735, 1432, 892) })!;
  expect(overlapArea(inside(picked), seat)).toBe(0);
  expect(overlapArea(inside(picked), ownTitle[0]!)).toBe(0);
  expect(overlapArea(inside(picked), ownState[0]!)).toBe(0);
  expect(overlapArea(inside(picked), header[0]!)).toBeGreaterThan(0);
});

test("a place that covers none of the other cards' text still wins over one that covers a neighbour's title", () => {
  const narrow = box(1142, 441, 1385, 609);
  const where = { viewport, card: narrow, anchor: box(1300, 495, 1375, 509) };
  const found = spendCandidates(where, (maxWidth) => ({ width: maxWidth, height: 186 }));
  const heads = [box(852, 190, 1093, 206)];
  const picked = chooseSpendPlacement(found, { own: [], foreign: heads, neighbours: [], anchor: where.anchor })!;
  expect(overlapArea({ left: picked.left, top: picked.top, right: picked.left + picked.width, bottom: picked.top + picked.height }, heads[0]!)).toBe(0);
});

test("the seat is taken out of the board's area: a bubble clamps against its edge, never into it", () => {
  const board = box(248, 0, 1440, 900);
  const seat = box(317, 60, 1357, 735);
  expect(clearOf(board, box(900, 860, 970, 876), [seat])).toEqual(box(248, 735, 1440, 900));
  /* A box below the marks moves the bottom edge; one the marks stand in changes nothing. */
  expect(clearOf(board, box(900, 100, 970, 116), [box(317, 600, 1357, 900)])).toEqual(box(248, 0, 1440, 600));
  expect(clearOf(board, box(900, 100, 970, 116), [box(317, 60, 1357, 300)])).toEqual(board);
  /* Marks at the window's bottom edge with the seat above: no place starts above the seat's bottom while the bubble fits under it. */
  const found = spendCandidates({ viewport, card: box(570, 780, 1010, 1100), anchor: box(930, 860, 1000, 876), bounds: board, avoid: [seat] }, (w) => ({ width: w, height: 120 }));
  expect(found.length).toBeGreaterThan(0);
  expect(found.every((c) => c.top >= 735 && c.top + c.height <= 892)).toBe(true);
});

/* The popover's two arrangements: stacked it is at most 320 wide and 190 tall; compact, its providers side by side, it is wider and 115 tall. */
const arranged = (w: number, compact = false) => ({ width: w, height: compact ? 115 : 190 });
const inside = (c: { left: number; top: number; width: number; height: number }) => ({ left: c.left, top: c.top, right: c.left + c.width, bottom: c.top + c.height });

test("a bubble taller than the room under the seat offers the compact arrangement, which stays out of the seat and inside the board", () => {
  const board = box(248, 0, 1440, 900);
  /* The seat ends at 735: 157 px are left under it, and the stacked bubble is 190 tall. */
  const seat = box(317, 60, 1357, 735);
  const where = { viewport, card: box(570, 840, 1010, 1120), anchor: box(930, 890, 1000, 899), bounds: board, avoid: [seat], compactable: true };
  const found = spendCandidates(where, arranged);
  expect(found.length).toBeGreaterThan(0);
  expect(found.every((c) => c.kind.endsWith(COMPACT_SUFFIX))).toBe(true);
  for (const c of found) {
    expect(overlapArea(inside(c), seat)).toBe(0);
    expect(c.top).toBeGreaterThanOrEqual(735);
    expect(c.top + c.height).toBeLessThanOrEqual(892);
    expect(c.height).toBe(115);
  }
  /* The place the ranking picks is one of them, with no overlap with the seat. */
  const best = chooseSpendPlacement(found, { own: [], foreign: [], keepOut: [seat] }, { card: where.card, area: box(248, 735, 1432, 892) })!;
  expect(best.kind.endsWith(COMPACT_SUFFIX)).toBe(true);
  expect(overlapArea(inside(best), seat)).toBe(0);
  /* With room for the stacked bubble no compact place is offered. */
  const roomy = spendCandidates({ ...where, avoid: [box(317, 60, 1357, 600)] }, arranged);
  expect(roomy.some((c) => c.kind.endsWith(COMPACT_SUFFIX))).toBe(false);
  expect(roomy.length).toBeGreaterThan(0);
});

test("a bubble with no compact arrangement and no room under the seat runs past the board's edge, never into the seat", () => {
  const board = box(248, 0, 1440, 900);
  const seat = box(317, 60, 1357, 735);
  const found = spendCandidates({ viewport, card: box(570, 840, 1010, 1120), anchor: box(930, 890, 1000, 899), bounds: board, avoid: [seat] }, arranged);
  expect(found.length).toBeGreaterThan(0);
  expect(found.every((c) => overlapArea(inside(c), seat) === 0)).toBe(true);
  /* A seat standing below the marks gets the same: the bubble ends where the seat begins. */
  const below = box(317, 400, 1357, 880);
  const flipped = spendCandidates({ viewport, card: box(570, 100, 1010, 380), anchor: box(930, 120, 1000, 136), bounds: box(248, 0, 1440, 900), avoid: [below] }, (w) => ({ width: w, height: 400 }));
  expect(flipped.every((c) => overlapArea(inside(c), below) === 0)).toBe(true);
});

test("any overlap with the seat loses to a place with none, however small the overlap and however much the free place covers elsewhere", () => {
  const seat = box(300, 100, 1300, 700);
  const grazes = { kind: "over", left: 600, top: 690, width: 320, height: 190, maxWidth: 320 };
  const clear = { kind: "below", left: 600, top: 700, width: 320, height: 190, maxWidth: 320 };
  const onSeat = { kind: "above", left: 600, top: 200, width: 320, height: 190, maxWidth: 320 };
  /* The place that grazes the seat by 10 px is earlier and covers no text; the clear place covers a heading. */
  const heading = box(620, 720, 800, 736);
  expect(chooseSpendPlacement([grazes, clear], { own: [], foreign: [heading], keepOut: [seat] })!.kind).toBe("below");
  expect(chooseSpendPlacement([onSeat, grazes, clear], { own: [], foreign: [heading], keepOut: [seat] })!.kind).toBe("below");
  /* Overlap with the seat is a yes or no: a small graze does not beat a deep one by area. */
  expect(chooseSpendPlacement([onSeat, grazes], { own: [], foreign: [box(620, 695, 800, 710)], keepOut: [seat] })!.kind).toBe("above");
});

test("a card at the window's bottom with room above it flips above itself instead of covering its title and state line", () => {
  const board = box(248, 0, 1000, 700);
  const small = { width: 1000, height: 700 };
  const cardBox = box(273, 495, 950, 856);
  const markBox = box(890, 545, 940, 561);
  const found = spendCandidates({ viewport: small, card: cardBox, anchor: markBox, bounds: board, avoid: [box(260, 60, 973, 102)] }, (w) => ({ width: w, height: 190 }));
  const ownTitle = [box(300, 510, 700, 530)];
  const ownState = [box(300, 545, 400, 561)];
  const neighbours = [box(290, 230, 900, 470)];
  const picked = chooseSpendPlacement(found, { own: [box(300, 600, 900, 700)], ownTitle, ownState, foreign: [], neighbours, anchor: markBox, keepOut: [box(260, 60, 973, 102)] })!;
  const at = { left: picked.left, top: picked.top, right: picked.left + picked.width, bottom: picked.top + picked.height };
  expect(overlapArea(at, ownTitle[0]!)).toBe(0);
  expect(overlapArea(at, ownState[0]!)).toBe(0);
  expect(picked.top).toBeGreaterThanOrEqual(102);
  expect(picked.top + picked.height).toBeLessThanOrEqual(692);
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
