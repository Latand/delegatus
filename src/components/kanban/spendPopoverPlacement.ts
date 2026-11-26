/**
 * Where the card's spend popover opens. It may sit over its own card (the
 * reader's own text is already in view), beside it, or above or below it; the
 * place that covers the least text belonging to anything else wins, and a tie
 * goes to the earlier candidate. The geometry is pure so a test can drive it
 * with boxes; the page supplies the text boxes it measured.
 */

export interface Box { left: number; top: number; right: number; bottom: number }
export interface SpendPlacementInput {
  viewport: { width: number; height: number };
  card: Box;
  anchor: Box;
}
export type SpendKind = "over" | "right" | "left" | "below" | "above";
/** `maxWidth` is what the bubble is asked to take; `width` and `height` are what it measured at that. */
export interface SpendCandidate { kind: SpendKind; left: number; top: number; width: number; height: number; maxWidth: number }

const EDGE = 8;
const GAP = 8;
/** Narrower than this the lines wrap into a tall column; the candidate is not offered. */
const MIN_WIDTH = 220;
const MAX_WIDTH = 320;

/** Area of the overlap of two boxes. */
export function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0.5 && height > 0.5 ? width * height : 0;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

/**
 * The places to try, best-looking first: over the card under the marks, then
 * to its right, to its left, below it and above it. `sizeAt` answers how
 * tall the bubble is at a given width, since a narrower bubble wraps more.
 */
export function spendCandidates(input: SpendPlacementInput, sizeAt: (maxWidth: number) => { width: number; height: number }): SpendCandidate[] {
  const { viewport, card, anchor } = input;
  const out: SpendCandidate[] = [];
  /** `anchorRight` places the bubble's right edge at `left` instead of its left edge. */
  const place = (kind: SpendKind, left: number, top: number, maxWidth: number, anchorRight = false, above = false) => {
    const { width, height } = sizeAt(maxWidth);
    const x = anchorRight ? left - width : left;
    const y = above ? top - height : top;
    out.push({
      kind,
      left: clamp(x, EDGE, viewport.width - width - EDGE),
      top: clamp(y, EDGE, viewport.height - height - EDGE),
      width, height, maxWidth,
    });
  };
  const over = Math.min(MAX_WIDTH, card.right - card.left - 2 * EDGE);
  if (over >= MIN_WIDTH) place("over", card.left + EDGE, anchor.bottom + GAP, over);
  const right = viewport.width - card.right - EDGE - GAP;
  const left = card.left - EDGE - GAP;
  if (right >= MIN_WIDTH) place("right", card.right + GAP, anchor.top, Math.min(MAX_WIDTH, right));
  if (left >= MIN_WIDTH) { const width = Math.min(MAX_WIDTH, left); place("left", card.left - GAP, anchor.top, width, true); }
  const wide = Math.min(MAX_WIDTH, viewport.width - 2 * EDGE);
  place("below", card.left, card.bottom + GAP, wide);
  place("above", card.right, card.top - GAP, wide, true, true);
  return out;
}

export interface WindowText {
  /** Text of the card itself. */
  own: readonly Box[];
  /** Card titles, the card's own included, and anything outside the cards (the sidebar, the seat): these must stay readable. */
  foreign: readonly Box[];
  /** The rest of the neighbouring cards' text. */
  neighbours?: readonly Box[];
}

/**
 * The candidate that covers the least text, a tie going to the earlier one.
 * Titles and text outside the cards decide first, then the rest of the
 * neighbouring cards' text; the card's own text, which the reader is already
 * looking at, only breaks a tie between places that cover none of the others.
 */
export function chooseSpendPlacement(candidates: SpendCandidate[], text: WindowText): SpendCandidate | null {
  let best: SpendCandidate | null = null;
  let bestScore: number[] = [Infinity];
  for (const candidate of candidates) {
    const box = { left: candidate.left, top: candidate.top, right: candidate.left + candidate.width, bottom: candidate.top + candidate.height };
    const covered = (boxes: readonly Box[] = []) => boxes.reduce((sum, other) => sum + overlapArea(box, other), 0);
    const score = [covered(text.foreign), covered(text.neighbours), covered(text.own)];
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

/** The window's text boxes, split into every card's title with everything outside the cards, the card's own other text, and the neighbouring cards' other text, as many nodes as `limit`. */
export function windowTextBoxes(card: Element, skip: Element, limit = 8000): { own: Box[]; foreign: Box[]; neighbours: Box[] } {
  const own: Box[] = [];
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
        if (parent.closest(".title, h3") || !parent.closest("[data-kanban-card]")) foreign.push(shown);
        else if (card.contains(node)) own.push(shown);
        else neighbours.push(shown);
      }
    }
  }
  range.detach();
  return { own, foreign, neighbours };
}
