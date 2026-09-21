/**
 * The line a scrolled feed cuts at its top edge (#1978).
 *
 * The phone's conversation scroller starts right under the pane's task strip,
 * so whichever text line straddles that edge is drawn sliced in half against
 * the strip — at rest, with nothing moving. These helpers find that line so
 * the feed can come to rest on a line boundary instead.
 *
 * "Line" means ink: the client rects of the text under the edge, plus the box
 * of a row-sized control there, not the boxes of the rows holding them,
 * because a row's padding can be cut without cutting a glyph and a tall row (a
 * whole tool card) can never fit under an edge anyway.
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

export function topEdgeCut(scroller: HTMLElement): EdgeCut | null {
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
  return { hidden: edge - top, shown: bottom - edge };
}

/** The scroll delta that puts a line boundary at the top edge: back by the
    hidden part (the line shows whole) or forward by the shown part (it leaves
    whole), whichever is shorter and still inside the scroll range. Zero when
    nothing is cut. */
export function restingDelta(scroller: HTMLElement): number {
  const cut = topEdgeCut(scroller);
  if (!cut) return 0;
  const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  if (cut.shown <= cut.hidden && cut.shown <= room) return cut.shown;
  return -cut.hidden;
}
