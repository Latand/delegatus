/**
 * The row a scrolled feed cuts at its top edge (#1978).
 *
 * The phone's conversation scroller starts right under the pane's task strip,
 * so whichever row straddles that edge is drawn sliced against the strip — at
 * rest, with nothing moving. These helpers find that row so the feed can come
 * to rest with the first visible row starting at the edge.
 *
 * A row is a feed row (`[data-feed-key]`, the unit the scroll anchor already
 * uses), or a row inside one: a list item (a run's numbered calls, an
 * answer's bullets) or a tool line. The first one crossing the edge that fits
 * well inside the viewport is aligned, outer before inner, so an opened run
 * taller than the screen hands the edge to the call inside it. When no crossing row fits (one long answer taller than the
 * screen), the fallback is ink: the client rects of the text under the edge,
 * plus the box of a row-sized control there, so at least no line is sliced.
 */

/** How far the straddling ink reaches above the edge (`hidden`) and below it
    (`shown`), in CSS px. Null when no glyph crosses the edge. */
export interface EdgeCut {
  hidden: number;
  shown: number;
}

/* Probe columns across the scroller's content box. A line that starts or ends
   mid-width (a short status line, an indented output) is still crossed by one
   of them; seven keeps the probe a handful of hit tests. */
const PROBE_COLUMNS = [0.04, 0.18, 0.32, 0.5, 0.68, 0.82, 0.96];
/* The coarse-pointer tap target, with room for a label: the tallest control
   that is still a row. */
const MAX_CONTROL_PX = 64;

/* A row taller than this share of the viewport is not aligned whole: moving
   to either of its edges could cost more than half a screen. */
const ROW_FIT = 0.75;
/* A row box has to start at the edge, not near it: half a device pixel above
   still reads as the strip's border cutting it. */
const EXACT = 0.01;
/* The browser keeps scroll offsets on whole CSS pixels while rows lay out on
   fractional ones, so the boundary between two rows can sit up to a pixel
   off any reachable position. A row showing no more than that under the edge
   is its predecessor's sliver, not a visible row; counting it would make the
   feed step back and forth by a pixel forever. */
const SLIVER_PX = 1;

/* Moves are whole CSS pixels, since the browser does not honour a sub-pixel
   scroll move. Back (revealing the cut row) rounds up, so the row ends at most
   a pixel below the edge; forward (letting it leave) rounds down, so what is
   left of it is a sliver and the row after it is not pushed above the edge. */
const backPx = (value: number) => Math.ceil(value - EXACT);
const forwardPx = (value: number) => Math.floor(value + EXACT);

const ROW_SELECTOR = "[data-feed-key], li, [data-tool-row]";
/* Rows of a run or a list sit a few pixels apart; an edge in that gap is on a
   boundary, and the ink fallback must not be asked what it cuts there. */
const ROW_GAP_PX = 8;
const ON_BOUNDARY: EdgeCut = { hidden: 0, shown: 0 };
/* The padding and border a container keeps under its last row. */
const FRAME_PX = 16;

/** The first row crossing the top edge that fits; a zero cut when the edge
    already sits on a row boundary; null when it falls inside a row too tall
    to align, which leaves the edge to the ink. */
export function rowEdgeCut(scroller: HTMLElement): EdgeCut | null {
  if (scroller.scrollHeight <= scroller.clientHeight) return null;
  const bounds = scroller.getBoundingClientRect();
  const edge = bounds.top + scroller.clientTop;
  const fit = scroller.clientHeight * ROW_FIT;
  /* Crossing rows too tall to align: the rows around the one that fits. */
  const around: number[] = [];
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= edge + SLIVER_PX) continue;
    /* The next row starts at the edge or a row gap below it: the edge sits on
       a boundary, even when the row around it is too tall to count. */
    if (rect.top >= edge - EXACT) return rect.top - edge <= ROW_GAP_PX ? ON_BOUNDARY : null;
    if (rect.height > fit) {
      around.push(rect.bottom);
      continue;
    }
    /* Leaving forward clears the frame of a row it closes too (a run's card
       ends a few pixels under its last call), or that frame's edge stays
       behind as a sliver of a cut row. */
    const bottom = around.reduce((lowest, end) => (end >= rect.bottom && end - rect.bottom <= FRAME_PX ? Math.max(lowest, end) : lowest), rect.bottom);
    return { hidden: backPx(edge - rect.top), shown: forwardPx(bottom - edge) };
  }
  return null;
}

/* How far from the edge the ink fallback looks, and so the longest move it
   makes. Every move it chooses lands inside this band, so whatever could
   cross the edge after the move was already counted before it. */
const BAND_PX = 96;
/* A band walk skips any subtree whose box misses the band, and still stops
   here: a long output with highlighting is thousands of spans. */
const MAX_BAND_NODES = 2_000;

type Span = { top: number; bottom: number };

/* Text lines and row-sized controls that intersect the band, from the
   subtrees of `roots` whose boxes reach it. A line is trimmed to the boxes of
   the overflow containers it sits in below the feed itself (a long output
   scrolls inside its own capped box), so text clipped out of sight is never
   counted as crossing the edge. */
function bandInk(roots: readonly Element[], scroller: Element, low: number, high: number): Span[] {
  const spans: Span[] = [];
  const range = document.createRange();
  let visited = 0;
  const keep = (top: number, bottom: number, clip: Span) => {
    const t = Math.max(top, clip.top);
    const b = Math.min(bottom, clip.bottom);
    if (b > t && b > low && t < high) spans.push({ top: t, bottom: b });
  };
  const visit = (element: Element, clip: Span) => {
    if (visited >= MAX_BAND_NODES) return;
    visited += 1;
    const rect = element.getBoundingClientRect();
    /* `display: contents` has no box of its own; its children still do. */
    const boxed = rect.width > 0 || rect.height > 0;
    if (boxed && !(rect.bottom > low && rect.top < high)) return;
    if (element.tagName === "BUTTON") {
      if (rect.height <= MAX_CONTROL_PX) keep(rect.top, rect.bottom, clip);
      return;
    }
    let inner = clip;
    if (boxed && element !== scroller) {
      const style = getComputedStyle(element);
      if (style.overflowY !== "visible") inner = { top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom) };
    }
    if (inner.bottom <= inner.top) return;
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.textContent?.trim()) continue;
        range.selectNodeContents(child);
        for (const line of range.getClientRects()) {
          if (line.height > 0 && line.width > 0) keep(line.top, line.bottom, inner);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        visit(child as Element, inner);
      }
    }
  };
  /* A root's own overflow ancestors below the feed clip it as well. */
  for (const root of roots) {
    let clip: Span = { top: -Infinity, bottom: Infinity };
    for (let parent = root.parentElement; parent && parent !== scroller; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowY !== "visible") {
        const box = parent.getBoundingClientRect();
        clip = { top: Math.max(clip.top, box.top), bottom: Math.min(clip.bottom, box.bottom) };
      }
    }
    visit(root, clip);
  }
  return spans;
}

/** The ink crossing the top edge, as the shortest move back (`hidden`) and
    forward (`shown`) that leaves NO line and no control crossing it: moving
    past a cut control can land on a line and aligning that line can cut the
    control again, so both are cleared together. Null when nothing crosses;
    an unreachable direction is Infinity. Moves stay inside the band and
    inside the row being read, so the position they reach is clear by
    construction and the next reading finds nothing to do. */
export function inkEdgeCut(scroller: HTMLElement): EdgeCut | null {
  if (scroller.scrollHeight <= scroller.clientHeight || typeof document.elementFromPoint !== "function") return null;
  const bounds = scroller.getBoundingClientRect();
  const edge = bounds.top + scroller.clientTop;
  /* Read the outermost row crossing the edge, the one too tall to align; with
     none, whatever the edge probes hit. */
  let span: Span = { top: -Infinity, bottom: Infinity };
  let roots: Element[] = [];
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    if (rect.top < edge && rect.bottom > edge) {
      roots = [row];
      span = { top: rect.top, bottom: rect.bottom };
      break;
    }
    if (rect.top >= edge) break;
  }
  if (!roots.length) {
    const left = bounds.left + scroller.clientLeft;
    for (const column of PROBE_COLUMNS) {
      const hit = document.elementFromPoint(left + scroller.clientWidth * column, edge + 0.5);
      if (hit && hit !== scroller && scroller.contains(hit) && !roots.includes(hit)) roots.push(hit);
    }
  }
  const ink = bandInk(roots, scroller, edge - BAND_PX, edge + BAND_PX);
  /* After a move of `delta` the edge sits at `edge + delta` in today's
     coordinates; half a pixel of overlap is rounding, not a cut. */
  const crosses = (delta: number) => ink.some((line) => line.top < edge + delta - 0.5 && line.bottom > edge + delta + 0.5);
  if (!crosses(0)) return null;
  let back = Infinity;
  let forward = Infinity;
  for (const line of ink) {
    for (const delta of [Math.floor(line.top - edge + 0.5), Math.ceil(line.bottom - edge - 0.5)]) {
      if (delta === 0 || Math.abs(delta) >= BAND_PX) continue;
      if (edge + delta < span.top || edge + delta > span.bottom) continue;
      if (crosses(delta)) continue;
      if (delta < 0) back = Math.min(back, -delta);
      else forward = Math.min(forward, delta);
    }
  }
  if (back === Infinity && forward === Infinity) return null;
  return { hidden: back, shown: forward };
}

/** The scroll delta that puts a boundary at the top edge: back by the hidden
    part (the row shows whole) or forward by the shown part (it leaves whole),
    whichever is shorter and still inside the scroll range. A row that fits is
    aligned whole; otherwise the ink under the edge. Zero when nothing is cut. */
export function restingDelta(scroller: HTMLElement): number {
  const cut = rowEdgeCut(scroller) ?? inkEdgeCut(scroller);
  if (!cut) return 0;
  const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  const forward = cut.shown <= room ? cut.shown : Infinity;
  const back = cut.hidden <= scroller.scrollTop ? cut.hidden : Infinity;
  if (forward === Infinity && back === Infinity) return 0;
  return forward <= back ? forward : -back;
}

/* Following the tail, the bottom is pinned, so the edge moves one of two ways:
   back, into the blank space under the last row, while that blank covers it
   and the tail stays inside the follow band; otherwise forward, by a spacer
   under the last row, so the cut row leaves whole and the next one starts at
   the edge. A row that fits is shorter than ROW_FIT of the screen, so is the
   spacer; the newest line always stays in view. */
const TAIL_BACK_MAX_PX = 40;

export type TailPlan = { back: number } | { spacer: number } | null;

/** How a feed pinned to its tail aligns its top edge. `slack` is the blank
    height between the last row and the viewport's bottom. */
export function tailPlan(scroller: HTMLElement, slack: number): TailPlan {
  const cut = rowEdgeCut(scroller) ?? inkEdgeCut(scroller);
  if (!cut) return null;
  if (cut === ON_BOUNDARY) return null;
  if (cut.hidden <= Math.min(slack, TAIL_BACK_MAX_PX)) return { back: cut.hidden };
  return cut.shown > 0 && cut.shown !== Infinity ? { spacer: cut.shown } : null;
}
