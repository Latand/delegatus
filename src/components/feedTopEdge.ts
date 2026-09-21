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
/* A hit element can be a large block (a whole card, when the probe lands in
   its padding); its text is walked, but never without bound. */
const MAX_TEXT_NODES = 400;
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

/** The ink crossing the top edge, or null. */
export function inkEdgeCut(scroller: HTMLElement): EdgeCut | null {
  if (scroller.scrollHeight <= scroller.clientHeight || typeof document.elementFromPoint !== "function") return null;
  const bounds = scroller.getBoundingClientRect();
  const edge = bounds.top + scroller.clientTop;
  const left = bounds.left + scroller.clientLeft;
  const width = scroller.clientWidth;
  const seen = new Set<Element>();
  let top = Infinity;
  let bottom = -Infinity;
  for (const column of PROBE_COLUMNS) {
    const hit = document.elementFromPoint(left + width * column, edge + 0.5);
    if (!hit || hit === scroller || !scroller.contains(hit) || seen.has(hit)) continue;
    seen.add(hit);
    /* A control is a row of its own: a copy button left sliced at the edge
       reads as broken as a sliced line of text. A block-sized one (a picture's
       frame) is left to scroll like a card; it could never fit either way. */
    const control = hit.closest("button");
    if (control && scroller.contains(control)) {
      const rect = control.getBoundingClientRect();
      if (rect.height <= MAX_CONTROL_PX && rect.top < edge - 0.5 && rect.bottom > edge + 0.5) {
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    const walker = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let visited = 0;
    for (let node = walker.nextNode(); node && visited < MAX_TEXT_NODES; node = walker.nextNode(), visited += 1) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.height <= 0 || rect.width <= 0) continue;
        if (rect.top < edge - 0.5 && rect.bottom > edge + 0.5) {
          top = Math.min(top, rect.top);
          bottom = Math.max(bottom, rect.bottom);
        }
      }
    }
  }
  if (top === Infinity) return null;
  return { hidden: backPx(edge - top), shown: forwardPx(bottom - edge) };
}

/** The scroll delta that puts a boundary at the top edge: back by the hidden
    part (the row shows whole) or forward by the shown part (it leaves whole),
    whichever is shorter and still inside the scroll range. A row that fits is
    aligned whole; otherwise the ink under the edge. Zero when nothing is cut. */
export function restingDelta(scroller: HTMLElement): number {
  const cut = rowEdgeCut(scroller) ?? inkEdgeCut(scroller);
  if (!cut) return 0;
  const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  if (cut.shown <= cut.hidden && cut.shown <= room) return cut.shown;
  return -cut.hidden;
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
  return cut.shown > 0 ? { spacer: cut.shown } : null;
}
