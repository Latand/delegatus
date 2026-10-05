import { describe, expect, test } from "bun:test";

import {
  accessoryReserve,
  cardComposerBudget,
  cardComposerCeiling,
  caretAtEnd,
  clampHeight,
  COMPOSER_ACCESSORY_WINDOW_PX,
  COMPOSER_MAX_PX,
  keyboardInset,
  MOBILE_COMPOSER_CHROME_PX,
  MOBILE_COMPOSER_UNIT_CHROME_PX,
  mobileComposerCeiling,
  mobileComposerUnitMax,
  SEAT_TRANSCRIPT_FLOOR_PX,
  seatComposerBudget,
  seatGrowth,
  shouldPin,
  visibleViewportHeight,
} from "./composerScroll";

describe("clampHeight grows to fit then caps", () => {
  test("adds the 2px border allowance below the cap", () => {
    expect(clampHeight(40, 160)).toBe(42);
  });

  test("never exceeds the max height", () => {
    expect(clampHeight(500, 160)).toBe(160);
    expect(clampHeight(160, 160)).toBe(160);
  });

  test("never drops below the min height when given one", () => {
    expect(clampHeight(10, 260, 84)).toBe(84);
    expect(clampHeight(200, 260, 84)).toBe(202);
    expect(clampHeight(400, 260, 84)).toBe(260);
  });

  test("min defaults to zero (single-row composers)", () => {
    expect(clampHeight(0, 160)).toBe(2);
  });
});

describe("caretAtEnd detects an end-of-text collapsed caret", () => {
  test("true only when both selection edges sit at the length", () => {
    expect(caretAtEnd(5, 5, 5)).toBe(true);
    expect(caretAtEnd(0, 0, 0)).toBe(true);
  });

  test("false mid-text or across a selection", () => {
    expect(caretAtEnd(3, 3, 5)).toBe(false); // caret parked mid-text
    expect(caretAtEnd(0, 5, 5)).toBe(false); // a range is selected
    expect(caretAtEnd(5, 3, 5)).toBe(false);
  });
});

describe("shouldPin — keep the newest text visible only when appending", () => {
  test("live dictation pins unconditionally, even with the caret mid-text", () => {
    expect(shouldPin({ pinned: true, caretAtEnd: false })).toBe(true);
    expect(shouldPin({ pinned: true, caretAtEnd: true })).toBe(true);
  });

  test("typing pins only when the caret is at the end", () => {
    expect(shouldPin({ pinned: false, caretAtEnd: true })).toBe(true);
    expect(shouldPin({ pinned: false, caretAtEnd: false })).toBe(false);
  });
});

describe("visibleViewportHeight — the keyboard-aware layout budget (#983)", () => {
  test("no visualViewport falls back to the layout viewport", () => {
    expect(visibleViewportHeight(800, null)).toBe(800);
    expect(visibleViewportHeight(800, undefined)).toBe(800);
  });

  test("an open keyboard (iOS: layout viewport unchanged) shrinks the budget", () => {
    expect(visibleViewportHeight(800, { height: 400, scale: 1 })).toBe(400);
  });

  test("pinch zoom cancels out: scale restores the layout-px measure", () => {
    expect(visibleViewportHeight(800, { height: 400, scale: 2 })).toBe(800);
  });

  test("rounding noise never exceeds the layout viewport", () => {
    expect(visibleViewportHeight(800, { height: 400.4, scale: 2 })).toBe(800);
  });
});

describe("mobileComposerCeiling — the phone grow ceiling against the visible viewport (#983, #1483)", () => {
  test("a full portrait viewport grows to what the composer box can show", () => {
    /* #983 read this as a flat 40% of the visible viewport (320px at 800).
       That share ignored the box the field lives in: 320 + the unit's own
       chrome overflows the composer's `max-h-[min(38dvh,20rem)]`, and the
       overflow is the tools row. The field takes the box's budget instead. */
    expect(mobileComposerCeiling(800, 800)).toBe(mobileComposerUnitMax(800) - MOBILE_COMPOSER_UNIT_CHROME_PX);
    expect(mobileComposerCeiling(800, 800)).toBe(239);
  });

  test("a portrait keyboard-open viewport holds the 160px cap — the chrome still fits", () => {
    expect(mobileComposerCeiling(400, 800)).toBe(160);
    expect(160 + MOBILE_COMPOSER_CHROME_PX).toBeLessThanOrEqual(400);
  });

  test("the 40% grow rule still governs the range between the cap and the box budget", () => {
    /* 390×844 and 430×932 with the keyboard up: 40% of what the operator can
       see, unchanged by #1483 — the box has room for it. */
    expect(mobileComposerCeiling(508, 844)).toBe(203);
    expect(mobileComposerCeiling(596, 932)).toBe(238);
  });

  test("a rotated keyboard-open viewport yields below 160px to keep the chrome visible (round 2)", () => {
    /* Landscape: the layout viewport is 390px tall, so the composer box's own
       38dvh cap is the tighter of the two bounds and the field yields to it. */
    expect(mobileComposerCeiling(280, 390)).toBe(mobileComposerUnitMax(390) - MOBILE_COMPOSER_UNIT_CHROME_PX);
    expect(mobileComposerCeiling(280, 390)).toBe(83);
    expect(mobileComposerCeiling(240, 390)).toBe(83);
  });

  test("a visible viewport too short for the box budget yields to the keyboard instead", () => {
    /* Below ~200px visible the bar plus the unit's chrome is what binds, and
       the field gives up the difference. */
    expect(mobileComposerCeiling(180, 390)).toBe(180 - MOBILE_COMPOSER_CHROME_PX);
  });

  test("never collapses below one 44px tap-target row", () => {
    /* The one case that outranks the reachability arithmetic below: on a
       viewport this small no field height keeps the tools row in view, and a
       0px field would be worse than an overflowing one. */
    expect(mobileComposerCeiling(150, 390)).toBe(44);
    expect(mobileComposerCeiling(0, 0)).toBe(44);
  });
});

/*
 * Issue #1483 — dictation must never push Stop out of reach. The mobile v2
 * composer is ONE box: the field on top and the tools row (chip · attach ·
 * dictate · send slot) under it, inside the same border, inside a form whose
 * own `max-h-[min(38dvh,20rem)]` scrolls what it cannot show. So the ceiling
 * has two bounds to respect at once, and the operator loses Stop when either
 * is broken: the field must fit its own box beside the tools row, AND the
 * whole unit must fit the visible area under the bar.
 */
describe("mobileComposerCeiling — the grown field never pushes its own tools row out of reach (#1483)", () => {
  const PHONES = [
    { name: "390×844 portrait, keyboard closed (dictating)", visible: 844, layout: 844 },
    { name: "390×844 portrait, keyboard open", visible: 508, layout: 844 },
    { name: "430×932 portrait, keyboard closed (dictating)", visible: 932, layout: 932 },
    { name: "430×932 portrait, keyboard open", visible: 596, layout: 932 },
    { name: "375×667 portrait, keyboard closed", visible: 667, layout: 667 },
    { name: "375×667 portrait, keyboard open", visible: 331, layout: 667 },
    { name: "844×390 landscape, keyboard closed", visible: 390, layout: 390 },
    { name: "844×390 landscape, keyboard open", visible: 280, layout: 390 },
  ];

  for (const phone of PHONES) {
    test(`${phone.name}: the tools row stays inside the box and above the keyboard`, () => {
      const field = mobileComposerCeiling(phone.visible, phone.layout);
      /* Inside the composer's own scroll box: past this the FORM scrolls, and
         reaching Stop costs a scroll that the next dictated chunk undoes. */
      expect(field + MOBILE_COMPOSER_UNIT_CHROME_PX).toBeLessThanOrEqual(mobileComposerUnitMax(phone.layout));
      /* Inside what the operator can see, under the one bar. */
      expect(field + MOBILE_COMPOSER_CHROME_PX).toBeLessThanOrEqual(phone.visible);
      /* Still a comfortable multi-line input: at 22px leading, four rows. */
      expect(field).toBeGreaterThanOrEqual(83);
    });
  }

  test("the reserve is the chrome the phone actually renders: the bar plus the unit's own", () => {
    /* 52 (the one bar) + 65 (tools row 44, box padding and border 8, form
       padding and top border 13). The #983 number reserved 156 for a docked
       focus strip, a separate conversation header and a picker row under the
       input, and mobile v2 renders none of those. */
    expect(MOBILE_COMPOSER_UNIT_CHROME_PX).toBe(65);
    expect(MOBILE_COMPOSER_CHROME_PX).toBe(52 + MOBILE_COMPOSER_UNIT_CHROME_PX);
  });

  test("the box budget follows the form's own max-height, in layout px", () => {
    /* `min(38dvh, 20rem)`. `dvh` ignores the on-screen keyboard, so the budget
       reads the LAYOUT viewport and an open keyboard never shrinks it. */
    expect(mobileComposerUnitMax(844)).toBe(320);
    expect(mobileComposerUnitMax(932)).toBe(320);
    expect(mobileComposerUnitMax(667)).toBe(253);
    expect(mobileComposerUnitMax(390)).toBe(148);
  });

  test("the field still grows past the desktop cap wherever the box has room", () => {
    /* The point of the phone ceiling (#177 item 3) survives: a portrait phone
       opens the field well past the shared 160px cap. */
    expect(mobileComposerCeiling(844, 844)).toBeGreaterThan(160);
    expect(mobileComposerCeiling(932, 932)).toBeGreaterThan(160);
  });
});

/*
 * Issue #1629 — the field and the accessory region divide ONE bounded box. The
 * region above the field holds every surface the composer can gain — a docked
 * call, the native queue, the sends awaiting an answer, the receipts of the
 * ones that failed — and it is the part of the box that gives room back, so a
 * field that grows into all of it leaves surfaces with a zero-height interior:
 * no Start, no recovery control and no receipt reachable, by pointer or by
 * keyboard. The ceiling reserves the region's room while surfaces are in it,
 * and hands it straight back when they are gone. The same rule runs against
 * two boxes — the phone's viewport share and a card's own height.
 */
describe("accessoryReserve — one rule for the room above the input (#1629)", () => {
  test("nothing in the region reserves nothing, on any box", () => {
    expect(accessoryReserve(0, 320)).toBe(0);
    expect(accessoryReserve(0, 1080)).toBe(0);
  });

  test("each surface in the region gets a window it can be used through, and the gap it arrives with", () => {
    expect(accessoryReserve(1, 320)).toBe(COMPOSER_ACCESSORY_WINDOW_PX + 6);
    expect(accessoryReserve(2, 800)).toBe(2 * (COMPOSER_ACCESSORY_WINDOW_PX + 6));
  });

  test("together they never take more than half the box — the field is what the operator is typing in", () => {
    /* A call, a queue, a run of pending sends and six unresolved receipts, all
       at once, inside a 260px card composer: four windows do not fit, so the
       region takes half and scrolls the rest. */
    expect(accessoryReserve(4, 260)).toBe(130);
    expect(accessoryReserve(4, 260)).toBeLessThan(4 * (COMPOSER_ACCESSORY_WINDOW_PX + 6));
  });

  test("an unmeasured box reserves nothing, because there is no share to take it from", () => {
    expect(accessoryReserve(3, 0)).toBe(0);
  });
});

describe("cardComposerBudget — a share of the conversation, not of the screen (#1629)", () => {
  test("the 60% share binds on a tall card and the transcript floor on a short one", () => {
    expect(cardComposerBudget(1080)).toBe(648);
    expect(cardComposerBudget(500)).toBe(260);
    expect(cardComposerBudget(680)).toBe(408);
  });
});

describe("cardComposerCeiling — the card field yields to the region it shares a box with (#1629)", () => {
  test("with an empty region the ceiling is the shared cap it always was", () => {
    expect(cardComposerCeiling(680, 0)).toBe(COMPOSER_MAX_PX);
    expect(cardComposerCeiling(1080, 0)).toBe(COMPOSER_MAX_PX);
  });

  test("a roomy card keeps the whole cap even with the region full", () => {
    /* 648px of budget: three windows and the composer's chrome fit inside it
       with the field at its cap, so nothing is taken from the draft. */
    expect(cardComposerCeiling(1080, 3)).toBe(COMPOSER_MAX_PX);
  });

  test("the 600x500 card that lost its receipts gives the region its room instead", () => {
    /* The composition the final review reproduced: a live call and six
       unresolved receipts under a twenty-line draft. The field stops short of
       the region's reserve, so the region has a window rather than 0px below
       the pane's bottom edge. */
    const ceiling = cardComposerCeiling(500, 2);
    expect(ceiling).toBeLessThan(COMPOSER_MAX_PX);
    expect(ceiling).toBe(cardComposerBudget(500) - 65 - accessoryReserve(2, cardComposerBudget(500)));
    expect(cardComposerBudget(500) - ceiling).toBeGreaterThanOrEqual(accessoryReserve(2, cardComposerBudget(500)));
  });

  test("a usable field outranks the reserve on a card too small for both", () => {
    /* The region scrolls itself there; a field the operator cannot type one
       line into has no alternative at all. */
    expect(cardComposerCeiling(320, 4)).toBe(44);
  });

  test("an unmeasured or indefinite box falls back to the fixed cap, exactly as before", () => {
    expect(cardComposerCeiling(0, 4)).toBe(COMPOSER_MAX_PX);
    expect(cardComposerCeiling(-1, 1)).toBe(COMPOSER_MAX_PX);
  });
});

describe("the orchestrator seat's own budget (#1734)", () => {
  /* Measured on the rendered seat: a 270 px seat leaves its conversation 165 px,
     of which the control strip takes 37; a 675 px one leaves 570. */
  test("the card budget is what left a compact seat two rows: it is negative there", () => {
    expect(cardComposerBudget(165)).toBeLessThan(0);
    expect(cardComposerCeiling(165, 0)).toBe(44);
  });

  test("a compact seat that can grow gives the field its whole cap", () => {
    const budget = seatComposerBudget({ boxHeight: 165, room: 675 - 270, rows: 37 });
    expect(budget).toBe(165 + 405 - 37 - SEAT_TRANSCRIPT_FLOOR_PX);
    expect(cardComposerCeiling(165, 0, budget)).toBe(COMPOSER_MAX_PX);
  });

  test("a seat already at its grip's stop borrows from the transcript, down to its minimum", () => {
    /* 1280 x 600: the default seat is 450 px, its conversation 345. */
    const budget = seatComposerBudget({ boxHeight: 345, room: 0, rows: 37 });
    expect(budget).toBe(236);
    expect(cardComposerCeiling(345, 0, budget)).toBe(COMPOSER_MAX_PX);
    /* A window too short for the cap: the field takes what is left over the minimum. */
    const short = seatComposerBudget({ boxHeight: 240, room: 0, rows: 37 });
    expect(cardComposerCeiling(240, 0, short)).toBe(240 - 37 - SEAT_TRANSCRIPT_FLOOR_PX - 65);
  });

  test("the budget stands still while the seat grows: the box gains what the room loses", () => {
    const before = seatComposerBudget({ boxHeight: 165, room: 405, rows: 37 });
    const after = seatComposerBudget({ boxHeight: 165 + 132, room: 405 - 132, rows: 37 });
    expect(after).toBe(before);
  });

  test("the accessory region's reserve comes off the seat's budget as it does a card's", () => {
    const budget = seatComposerBudget({ boxHeight: 240, room: 0, rows: 37 });
    expect(cardComposerCeiling(240, 1, budget)).toBe(Math.max(44, budget - 65 - accessoryReserve(1, budget)));
  });

  test("negative room and negative rows count as none", () => {
    expect(seatComposerBudget({ boxHeight: 300, room: -20, rows: -3 })).toBe(300 - SEAT_TRANSCRIPT_FLOOR_PX);
  });
});

describe("seatGrowth — how far past its set height the seat has to be (#1734)", () => {
  test("a seat with transcript to spare does not grow", () => {
    expect(seatGrowth({ grown: 0, transcriptHeight: 441.5, overflow: 0, room: 0 })).toBe(0);
    expect(seatGrowth({ grown: 0, transcriptHeight: 300, overflow: 0, room: 400 })).toBe(0);
  });

  test("a form that cannot show its content is what the seat adds, in one step", () => {
    expect(seatGrowth({ grown: 0, transcriptHeight: 72, overflow: 82, room: 405 })).toBe(82);
    expect(seatGrowth({ grown: 82, transcriptHeight: 72, overflow: 0, room: 405 })).toBe(82);
    expect(seatGrowth({ grown: 82, transcriptHeight: 72, overflow: 36, room: 405 })).toBe(118);
  });

  test("a transcript back above its minimum gives the growth back, and never more than was added", () => {
    expect(seatGrowth({ grown: 118, transcriptHeight: 72 + 54, overflow: 0, room: 405 })).toBe(64);
    expect(seatGrowth({ grown: 40, transcriptHeight: 72 + 200, overflow: 0, room: 405 })).toBe(0);
  });

  test("the grip's stop is the limit", () => {
    expect(seatGrowth({ grown: 0, transcriptHeight: 72, overflow: 300, room: 180 })).toBe(180);
    expect(seatGrowth({ grown: 50, transcriptHeight: 72, overflow: 10, room: 0 })).toBe(0);
    expect(seatGrowth({ grown: 0, transcriptHeight: 72, overflow: 10, room: -5 })).toBe(0);
  });

  test("half a px of slack is not traded back and forth", () => {
    /* 72.5 px of transcript: giving 0.5 back would cut the form by the same half px and add it again. */
    expect(seatGrowth({ grown: 82, transcriptHeight: 72.5, overflow: 0, room: 405 })).toBe(82);
    expect(seatGrowth({ grown: 82, transcriptHeight: 73, overflow: 0, room: 405 })).toBe(81);
    expect(seatGrowth({ grown: 81, transcriptHeight: 72, overflow: 0, room: 405 })).toBe(81);
  });

  test("repeated on the layout it produced, the step settles where the form shows everything", () => {
    /* The seat dragged to the grip's lower stop, in the numbers measured at
       1440 × 900: 105.4 px of header above the conversation, a 37 px control
       strip, a form that needs 90.6 px. The conversation is 54.6 px, less than
       the transcript's minimum and the strip, so the form has no height and
       reports only its own content as overflow. */
    const above = 105.4, strip = 37, needs = 90.6, set = 160, room = 515;
    const layout = (grown: number) => {
      const box = set + grown - above;
      const form = Math.max(0, Math.min(needs, box - SEAT_TRANSCRIPT_FLOOR_PX - strip));
      return { transcriptHeight: Math.max(SEAT_TRANSCRIPT_FLOOR_PX, box - strip - form), overflow: needs - form };
    };
    const first = seatGrowth({ grown: 0, ...layout(0), room });
    expect(first).toBe(91);
    expect(layout(first).overflow).toBeGreaterThan(50);
    let grown = first;
    let steps = 1;
    for (; steps < 8; steps += 1) {
      const next = seatGrowth({ grown, ...layout(grown), room });
      if (next === grown) break;
      grown = next;
    }
    expect(steps).toBe(2);
    expect(set + grown).toBe(305);
    expect(layout(grown).overflow).toBeLessThanOrEqual(0);
    expect(layout(grown).transcriptHeight).toBeGreaterThanOrEqual(SEAT_TRANSCRIPT_FLOOR_PX);
  });
});

describe("mobileComposerCeiling — the field leaves the region its room (#1629)", () => {
  const PHONE = { visible: 840, layout: 840 };
  const BOX = mobileComposerUnitMax(840);

  test("with an empty region the ceiling is exactly what it always was", () => {
    expect(mobileComposerCeiling(PHONE.visible, PHONE.layout, 0)).toBe(mobileComposerCeiling(PHONE.visible, PHONE.layout));
    expect(mobileComposerCeiling(PHONE.visible, PHONE.layout)).toBe(BOX - MOBILE_COMPOSER_UNIT_CHROME_PX);
  });

  test("a rendered surface takes its room off the field, leaving the input's own chrome whole", () => {
    const withQueue = mobileComposerCeiling(PHONE.visible, PHONE.layout, 1);
    expect(withQueue).toBe(mobileComposerCeiling(PHONE.visible, PHONE.layout) - accessoryReserve(1, BOX));
    /* What the phone that reported this actually has left: the box budget minus
       its own chrome minus the region's room — and the tools row holding Send
       still fits inside the box beside the field (#1483 still holds). */
    expect(withQueue).toBe(158);
    expect(withQueue + MOBILE_COMPOSER_UNIT_CHROME_PX + accessoryReserve(1, BOX))
      .toBeLessThanOrEqual(BOX);
  });

  test("a call and a queue at once reserve two windows, capped at half the box", () => {
    const both = mobileComposerCeiling(PHONE.visible, PHONE.layout, 2);
    expect(both).toBeLessThan(mobileComposerCeiling(PHONE.visible, PHONE.layout, 1));
    expect(both + MOBILE_COMPOSER_UNIT_CHROME_PX + accessoryReserve(2, BOX)).toBeLessThanOrEqual(BOX);
  });

  test("the reserve comes off the keyboard-open bound too, because the region is above the keyboard as well", () => {
    /* Keyboard up on a 390×844 phone: the visible bound is what binds, and the
       region shares that visible area with the field. */
    const open = mobileComposerCeiling(508, 844, 1);
    expect(open).toBeLessThan(mobileComposerCeiling(508, 844));
    /* Whichever of the two bounds binds, the region's room survives both. */
    const reserve = accessoryReserve(1, mobileComposerUnitMax(844));
    expect(open + MOBILE_COMPOSER_CHROME_PX + reserve).toBeLessThanOrEqual(508);
    expect(open + MOBILE_COMPOSER_UNIT_CHROME_PX + reserve).toBeLessThanOrEqual(mobileComposerUnitMax(844));
  });

  test("a usable field outranks the reserve on a viewport too small for both", () => {
    /* Landscape, keyboard up: the one-row floor still wins, so the field never
       collapses to nothing for the sake of the region — the region scrolls
       itself instead. */
    expect(mobileComposerCeiling(280, 390, 1)).toBe(44);
  });

  test("one window is a surface's frame, its header and a row readable inside it", () => {
    expect(COMPOSER_ACCESSORY_WINDOW_PX).toBe(90);
  });
});
