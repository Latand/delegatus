/* Which prose rows of a feed are on screen, for the speak button's "most
   visible answer" (LogFeed). The measure used to read every row of the
   expanded history on every animation frame; most of that history is far
   outside the viewport and contributes zero area, so its cost grew with
   everything the operator had expanded. An IntersectionObserver with the
   screen as its root already applies every clipping ancestor, the feed
   scroller and the board column included, so only rows that can have area are
   ever measured. */

const ROW = "[data-tts-answer-index]";

export interface ScreenClip { left: number; top: number; right: number; bottom: number }

export interface VisibleAnswerRows {
  /** The prose rows that may have area inside the screen right now. */
  rows(): HTMLElement[];
  disconnect(): void;
}

function rowsWithin(node: Node): HTMLElement[] {
  if (node.nodeType !== 1) return [];
  const element = node as HTMLElement;
  const inside = Array.from(element.querySelectorAll<HTMLElement>(ROW));
  return element.matches(ROW) ? [element, ...inside] : inside;
}

/** `onChange` runs whenever the set of rows may have changed: a row crossing
 * the screen edge, or rows added to or removed from the feed. Added and
 * removed subtrees are scanned alone, never the whole feed again. Without an
 * IntersectionObserver every row in the feed is reported, as before. */
export function trackVisibleAnswerRows(viewport: HTMLElement, onChange: () => void): VisibleAnswerRows {
  if (typeof IntersectionObserver !== "function") {
    const mutations = new window.MutationObserver(onChange);
    mutations.observe(viewport, { childList: true, subtree: true });
    return { rows: () => Array.from(viewport.querySelectorAll<HTMLElement>(ROW)), disconnect: () => mutations.disconnect() };
  }
  const onScreen = new Set<HTMLElement>();
  const intersections = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const row = entry.target as HTMLElement;
      if (entry.isIntersecting) onScreen.add(row); else onScreen.delete(row);
    }
    onChange();
  });
  for (const row of rowsWithin(viewport)) intersections.observe(row);
  const mutations = new window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.removedNodes)) {
        for (const row of rowsWithin(node)) { intersections.unobserve(row); onScreen.delete(row); }
      }
      for (const node of Array.from(record.addedNodes)) {
        for (const row of rowsWithin(node)) if (viewport.contains(row)) intersections.observe(row);
      }
    }
    onChange();
  });
  mutations.observe(viewport, { childList: true, subtree: true });
  return {
    rows: () => Array.from(onScreen),
    disconnect() { intersections.disconnect(); mutations.disconnect(); onScreen.clear(); },
  };
}

/** The area of a prose row's readable text inside `clip`. Code, tables and
 * hidden text are not read aloud and do not count. */
export function visibleRowArea(row: HTMLElement, clip: ScreenClip): number {
  const body = row.querySelector("[data-tts-body]");
  if (!body) return 0;
  const walker = document.createTreeWalker(body, 4 /* SHOW_TEXT */);
  let area = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest("pre, code, table, [hidden], [aria-hidden='true']")) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
    area += rects.reduce((sum, rect) => sum + Math.max(0, Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left)) * Math.max(0, Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top)), 0);
  }
  return area;
}

/** One `{ index, area }` fragment per tracked row, the shape
 * `visibleSpeakableAnswer` reads. */
export function measureVisibleAnswerRows(tracked: VisibleAnswerRows, clip: ScreenClip): { index: number; area: number }[] {
  return tracked.rows().map((row) => row.querySelector("[data-tts-body]")
    ? { index: Number(row.dataset.ttsAnswerIndex), area: visibleRowArea(row, clip) }
    : { index: -1, area: 0 });
}
