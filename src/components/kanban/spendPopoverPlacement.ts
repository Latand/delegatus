/**
 * Where the card's spend popover opens. It stays inside the board (never the
 * sidebar or the seat pane) and touches its own card: over the card, beside
 * it, or above or below it. The seat's box is a hard exclusion: the board
 * area the bubble is clamped to ends where the seat does, and no place that
 * reaches into the seat is ever offered. When the room the seat leaves is
 * shorter than the bubble, the same rows are offered in a compact
 * arrangement, the providers side by side, which is wide and short. Among
 * the places that keep clear of the seat the one that covers the least wins,
 * ranked: the card's own title and state line (a place covering any of them
 * loses to one covering none), then the board's own chrome (the tab row that
 * jumps between columns), then column headers and other cards' titles, then
 * the rest of the neighbouring cards' text; a tie goes to the earlier
 * candidate. The place above the card is also offered at several offsets
 * along the card, so a short band can keep clear of the chrome by standing
 * beside it instead of over it. A card at the window's bottom edge therefore
 * flips above itself instead of covering its own title; where the band the
 * seat leaves holds only the card's top, the column header is what it covers.
 * A place that leaves a line of the card's own text cut at its edge is
 * widened or lowered to take the whole line. The geometry is pure so a test can drive it with
 * boxes; the page supplies the text boxes it measured.
 */

export interface Box { left: number; top: number; right: number; bottom: number }
export interface SpendPlacementInput {
  viewport: { width: number; height: number };
  card: Box;
  anchor: Box;
  /** The board's box: a bubble stays inside it. Absent, the window is the board. */
  bounds?: Box;
  /** Boxes a bubble never reaches into (the seat pane). */
  avoid?: readonly Box[];
  /** Whether the bubble has a compact arrangement to offer when its normal one is taller than the room. */
  compactable?: boolean;
}
/** A place's name: «over» is the first choice, the others say how they differ; a compact place ends in «-compact». */
export type SpendKind = string;
/** `maxWidth` is what the bubble is asked to take; `width` and `height` are what it measured at that. */
export interface SpendCandidate { kind: SpendKind; left: number; top: number; width: number; height: number; maxWidth: number }

const EDGE = 8;
const GAP = 8;
/** Narrower than this the lines wrap into a tall column; the candidate is not offered. */
const MIN_WIDTH = 220;
const MAX_WIDTH = 320;
/** The compact arrangement sets the providers side by side: twice the room of one column, each at least a normal bubble's minimum. */
const COMPACT_MIN_WIDTH = 2 * MIN_WIDTH;
const COMPACT_MAX_WIDTH = 2 * MAX_WIDTH;
/** How far the place above the card slides along it, in steps, and the least of the card its bubble keeps under it. */
const SWEEP_STEPS = 12;
const TOUCH = 5 * EDGE;
/** What a compact place's name ends in. */
export const COMPACT_SUFFIX = "-compact";

/** Area of the overlap of two boxes. */
export function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0.5 && height > 0.5 ? width * height : 0;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
const boxOf = (c: SpendCandidate): Box => ({ left: c.left, top: c.top, right: c.left + c.width, bottom: c.top + c.height });

/**
 * The board's area the bubble is clamped to: what is left of it once the boxes
 * it must stay out of (the seat) are taken away. A box wholly above the marks
 * moves the top edge down to its bottom, one wholly below moves the bottom edge
 * up, and one wholly beside them moves the side edge in.
 */
export function clearOf(board: Box, anchor: Box, avoid: readonly Box[] = []): Box {
  const area = { ...board };
  for (const box of avoid) {
    if (box.bottom <= anchor.top + 1) area.top = Math.max(area.top, box.bottom);
    else if (box.top >= anchor.bottom - 1) area.bottom = Math.min(area.bottom, box.top);
    else if (box.right <= anchor.left + 1) area.left = Math.max(area.left, box.right);
    else if (box.left >= anchor.right - 1) area.right = Math.min(area.right, box.left);
  }
  return area;
}

/**
 * The places to try, best-looking first: over the card under the marks, then
 * over it at its top or bottom edge and wider than the card, then to its
 * right, to its left, below it and above it. `sizeAt` answers how big the
 * bubble is at a given width, since a narrower bubble wraps more, in its
 * normal or its compact arrangement. A place is offered only inside the board
 * area the seat leaves; when the bubble is too tall for that area at every
 * normal place the compact places are offered instead, and when even they
 * are too tall the places stay out of the seat and run past the board's edge
 * farthest from it.
 */
export function spendCandidates(input: SpendPlacementInput, measure: (maxWidth: number, compact?: boolean) => { width: number; height: number }): SpendCandidate[] {
  const { viewport, card, anchor } = input;
  /* The same width is asked for by several places: the bubble is measured once for each. */
  const sizes = new Map<string, { width: number; height: number }>();
  const sizeAt = (maxWidth: number, compact = false) => {
    const key = `${compact ? 1 : 0}:${maxWidth}`;
    let size = sizes.get(key);
    if (!size) { size = measure(maxWidth, compact); sizes.set(key, size); }
    return size;
  };
  const board: Box = {
    left: Math.max(EDGE, input.bounds?.left ?? EDGE), top: Math.max(EDGE, input.bounds?.top ?? EDGE),
    right: Math.min(viewport.width - EDGE, input.bounds?.right ?? Infinity), bottom: Math.min(viewport.height - EDGE, input.bounds?.bottom ?? Infinity),
  };
  const area = clearOf(board, anchor, input.avoid);
  const room = area.bottom - area.top;
  /** A seat below the marks: a too-tall bubble then ends at the room's bottom edge instead of starting at its top. */
  const fromBottom = area.top <= board.top + 0.5 && area.bottom < board.bottom - 0.5;
  const make = (compact: boolean): SpendCandidate[] => {
    const out: SpendCandidate[] = [];
    const suffix = compact ? COMPACT_SUFFIX : "";
    const minWidth = compact ? COMPACT_MIN_WIDTH : MIN_WIDTH;
    const maxWidth = compact ? COMPACT_MAX_WIDTH : MAX_WIDTH;
    /** `anchorRight` places the bubble's right edge at `left` instead of its left edge; `above` its bottom edge at `top`. */
    const place = (kind: SpendKind, left: number, top: number, wanted: number, anchorRight = false, above = false) => {
      const { width, height } = sizeAt(wanted, compact);
      const x = anchorRight ? left - width : left;
      const y = above ? top - height : top;
      const tooTall = height > room + 0.5;
      out.push({
        kind: `${kind}${suffix}`,
        left: clamp(x, area.left, area.right - width),
        /* Too tall for the room, it keeps to the seat's side of the room and runs past the board's own edge. */
        top: tooTall ? (fromBottom ? area.bottom - height : area.top) : clamp(y, area.top, area.bottom - height),
        width, height, maxWidth: wanted,
      });
    };
    const inner = card.right - card.left - 2 * EDGE;
    const widths = [...new Set([Math.min(maxWidth, inner), Math.min(maxWidth, area.right - area.left)].filter(w => w >= minWidth))];
    for (const width of widths) {
      /* A bubble wider than the card reaches over its gutter, and over what is beyond it. */
      const wide = width > inner + 0.5;
      for (const align of ["left", "right"] as const) {
        if (align === "right" && Math.abs(width - inner) < 1) continue;
        const kind = (name: string) => !wide && align === "left" && name === "marks" ? "over" : `over-${name}${wide ? "-wide" : ""}${align === "right" ? "-right" : ""}`;
        const x = align === "left" ? card.left + EDGE : card.right - EDGE;
        place(kind("marks"), x, anchor.bottom + GAP, width, align === "right");
        place(kind("top"), x, card.top, width, align === "right");
        place(kind("bottom"), x, card.bottom, width, align === "right", true);
      }
    }
    const right = area.right - card.right;
    const left = card.left - area.left;
    if (right >= minWidth) place("right", card.right, anchor.top, Math.min(maxWidth, right));
    if (left >= minWidth) place("left", card.left, anchor.top, Math.min(maxWidth, left), true);
    const wide = Math.min(maxWidth, area.right - area.left);
    if (wide >= minWidth || !compact) {
      place("below", card.left, card.bottom, wide);
      place("above", card.right, card.top, wide, true, true);
      /* The place above the card, slid along it: the bubble still touches the card, and what it covers changes with where it stands. */
      const { width } = sizeAt(wide, compact);
      for (let step = 0; step <= SWEEP_STEPS; step += 1) {
        const from = card.left - width + TOUCH;
        const to = card.right - TOUCH;
        place(`above-at-${step}`, from + ((to - from) * step) / SWEEP_STEPS, card.top, wide, false, true);
      }
    }
    return out;
  };
  /** A place is kept when it stands whole inside the area and clear of every box to avoid. */
  const clear = (c: SpendCandidate) => c.height <= room + 0.5 && (input.avoid ?? []).every(box => overlapArea(boxOf(c), box) === 0);
  const normal = make(false);
  const fits = normal.filter(clear);
  if (fits.length) return fits;
  const compact = input.compactable ? make(true) : [];
  const compactFits = compact.filter(clear);
  if (compactFits.length) return compactFits;
  /* Nothing fits whole: keep out of the seat all the same, and run past the board's far edge. */
  const rest = [...compact, ...normal].filter(c => (input.avoid ?? []).every(box => overlapArea(boxOf(c), box) === 0));
  return rest.length ? rest : [...compact, ...normal];
}

export interface WindowText {
  /** Text of the card itself. */
  own: readonly Box[];
  /** The card's own title: covering it is the last thing a place should do. */
  ownTitle?: readonly Box[];
  /** The words of the card's state line, which rank with its title. */
  ownState?: readonly Box[];
  /** Boxes a place must not touch (the seat): one that does loses to any that does not. */
  keepOut?: readonly Box[];
  /** The board's chrome outside the cards and its column headers (the tab row that jumps between columns): ranks before the headers. */
  chrome?: readonly Box[];
  /** Other cards' titles and column headers: these must stay readable. */
  foreign: readonly Box[];
  /** The rest of the neighbouring cards' text. */
  neighbours?: readonly Box[];
  /** The marks the bubble belongs to. */
  anchor?: Box;
}
/** The card and the board's box, which a place widened to take a cut line stays inside. */
export interface SpendFrame {
  card: Box;
  /** What is left of the board outside the seat: a place stays inside it. */
  area: Box;
}

const within = (inner: Box, outer: Box) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;

/** Text the box cuts: some of it is under the box and some is not. */
export function cutBy(box: Box, text: readonly Box[]): Box[] {
  return text.filter(rect => overlapArea(box, rect) > 0 && !within(rect, box));
}

/**
 * A place that cuts a line of the card's own text at its edge leaves a
 * fragment of that line. Widen the bubble to the line's end, or lower it to
 * the line's bottom, until no line is cut; a line cut at the top moves the
 * bubble below it. The bubble stays inside the board.
 */
export function settleSpendPlacement(candidate: SpendCandidate, text: readonly Box[], frame: SpendFrame): SpendCandidate {
  let { left, top, width, height } = candidate;
  const { card } = frame;
  for (let pass = 0; pass < 6; pass += 1) {
    const { area } = frame;
    const box = { left, top, right: left + width, bottom: top + height };
    const cut = cutBy(box, text);
    if (!cut.length) break;
    let right = box.right;
    let bottom = box.bottom;
    let nextLeft = left;
    let nextTop = top;
    for (const rect of cut) {
      if (rect.top < box.top - 0.5) nextTop = Math.max(nextTop, rect.bottom + 1);
      else bottom = Math.max(bottom, rect.bottom + 1);
      if (rect.right > box.right + 0.5) right = Math.max(right, Math.min(rect.right + 1, Math.max(card.right - 2, box.right)));
      if (rect.left < box.left - 0.5) nextLeft = Math.min(nextLeft, Math.max(rect.left - 1, Math.min(card.left + 2, box.left)));
    }
    if (nextTop > top) { bottom += nextTop - top; top = nextTop; }
    right = Math.min(right, area.right);
    left = Math.max(nextLeft, area.left);
    width = Math.max(width, right - left);
    height = Math.max(height, bottom - top);
    if (top + height > area.bottom) { top = Math.max(area.top, area.bottom - height); height = Math.min(height, area.bottom - top); }
  }
  return { ...candidate, left, top, width, height };
}

/**
 * The candidate that covers the least, a tie going to the earlier one. Any
 * overlap with the seat loses to every place with none, however small, then
 * any overlap with the card's own title and state line, then the board's
 * chrome (the tab row), then other cards' titles and column headers, then the rest of the
 * neighbouring cards' text, then the marks; the card's own other text,
 * which the reader is already looking at, only breaks a tie between places
 * that cover none of the others. With a frame a place first takes the whole
 * of any line of the card's text it would cut.
 */
export function chooseSpendPlacement(candidates: SpendCandidate[], text: WindowText, frame?: SpendFrame): SpendCandidate | null {
  let best: SpendCandidate | null = null;
  let bestScore: number[] = [Infinity];
  const cuttable = [...text.own, ...(text.ownTitle ?? []), ...(text.ownState ?? [])];
  for (const raw of candidates) {
    const candidate = frame ? settleSpendPlacement(raw, cuttable, frame) : raw;
    const box = boxOf(candidate);
    const covered = (boxes: readonly Box[] = []) => boxes.reduce((sum, other) => sum + overlapArea(box, other), 0);
    const score = [covered(text.keepOut) > 0 ? 1 : 0, covered(text.ownTitle) + covered(text.ownState) > 0 ? 1 : 0, covered(text.chrome), covered(text.foreign), covered(text.neighbours), text.anchor ? overlapArea(box, text.anchor) : 0, covered(text.own)];
    const better = score.findIndex((value, at) => value !== (bestScore[at] ?? Infinity));
    if (better >= 0 && score[better]! < (bestScore[better] ?? Infinity)) { best = candidate; bestScore = score; }
  }
  return best;
}

/** The part of `rect` that no scrolling or clipping ancestor of `from` hides; null when none of it shows. */
export function shownPart(from: Element, rect: DOMRect, clips: Map<Element, Box | null>): Box | null {
  let box: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  for (let el: Element | null = from; el && el !== document.documentElement; el = el.parentElement) {
    let clip = clips.get(el);
    if (clip === undefined) {
      const style = getComputedStyle(el);
      const cuts = (value: string) => value !== "visible";
      if (cuts(style.overflowX) || cuts(style.overflowY)) {
        const bounds = el.getBoundingClientRect();
        clip = { left: cuts(style.overflowX) ? bounds.left : -Infinity, right: cuts(style.overflowX) ? bounds.right : Infinity,
          top: cuts(style.overflowY) ? bounds.top : -Infinity, bottom: cuts(style.overflowY) ? bounds.bottom : Infinity };
      } else clip = null;
      clips.set(el, clip);
    }
    if (clip) box = { left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right), top: Math.max(box.top, clip.top), bottom: Math.min(box.bottom, clip.bottom) };
    if (box.right - box.left <= 0.5 || box.bottom - box.top <= 0.5) return null;
  }
  return box;
}

/** The window's text boxes, split into the card's own title, the words of its state line, text outside the cards that is not a column header (the tab row, the sidebar), every other card's title with the column headers, the card's own other text, and the neighbouring cards' other text, as many nodes as `limit`. */
export function windowTextBoxes(card: Element, skip: Element, limit = 8000): { own: Box[]; ownTitle: Box[]; ownState: Box[]; chrome: Box[]; foreign: Box[]; neighbours: Box[] } {
  const own: Box[] = [];
  const chrome: Box[] = [];
  const ownTitle: Box[] = [];
  const ownState: Box[] = [];
  const foreign: Box[] = [];
  const neighbours: Box[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const clips = new Map<Element, Box | null>();
  let seen = 0;
  for (let node = walker.nextNode(); node && seen < limit; node = walker.nextNode()) {
    seen += 1;
    const parent = node.parentElement;
    if (!parent || !node.nodeValue?.trim() || skip.contains(node) || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight) {
        const shown = shownPart(parent, rect, clips);
        if (!shown) continue;
        if (card.contains(node) && parent.closest(".title, h3")) ownTitle.push(shown);
        else if (card.contains(node) && parent.closest(".card-state-words")) ownState.push(shown);
        else if (parent.closest(".col-head, .title, h3")) foreign.push(shown);
        else if (!parent.closest("[data-kanban-card]")) chrome.push(shown);
        else if (card.contains(node)) own.push(shown);
        else neighbours.push(shown);
      }
    }
  }
  range.detach();
  return { own, ownTitle, ownState, chrome, foreign, neighbours };
}
