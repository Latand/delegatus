/*
 * What the rendered evidence of the seat deputy's block measures
 * (docs/design/ghost-seat.md §6.4, §7), shared by the two drivers that render
 * `deputyBlockEvidence.fixture.tsx`: the kanban board's at 1440 px and the
 * phone's at 390 px. The script runs in the page; the verdict runs in the test.
 */

export interface DeputyBlockReading {
  askId: string;
  state: string | null;
  open: boolean;
  /** The caption's participant title: its rendered width. */
  titleWidth: number | null;
  /** The collapsed line's result text width and its chips. */
  resultWidth: number | null;
  chips: number;
  /** The whole-line target of a collapsed block, and the caption's toggle. */
  targetHeight: number | null;
  /** The dashed edge against the body it should span. */
  edge: { top: number; bottom: number; bodyTop: number; lastRowBottom: number } | null;
  /** Ink of this block that overlaps ink of a seat row, in px². */
  overlapWithSeat: number;
  rows: number;
  /** The head's meta line: what it says the ask was sent to. */
  addressee: string | null;
  /** What the window shows right after the block: the seat row that resumes
      and names the head it continues, a new head, another block, or nothing
      that names it. */
  after: "resumes" | "head" | "block" | "end" | "unnamed";
  /** The resuming row's caption, when there is one. */
  resumeCaption: string | null;
  /** Collapsed: px from the result's last glyph to the first chip on its line
      (null when no chip shares the result's line). */
  resultToChipGap: number | null;
  /** Collapsed: the whole result shows, neither truncated nor clamped. */
  resultWhole: boolean | null;
  /** Collapsed: the chevron sits on the line's first text line. */
  chevronOnFirstLine: boolean | null;
  /** Every entity chip's text in the block. */
  chipTexts: string[];
  /** Phone captions of the block's prose rows. */
  rowSpeakers: string[];
  /** The left edges of the chip lines of the block's MCP rows, px. */
  chipLineLefts: number[];
  /** The block's streaming caret: whose ink it wears. */
  caret: string | null;
}

export interface DeputyEvidenceReading {
  blocks: DeputyBlockReading[];
  /** Keyed order of the window: seat rows and blocks as they sit. */
  order: string[];
  seatLiveLast: boolean;
  /** The seat's live turn: its speaker line and its caret's ink. */
  seatLive: { speaker: string | null; caret: string | null } | null;
  scrollWidth: number;
  viewportWidth: number;
}

/** In-page: every block's geometry and the window's order. Ink is the union of
    text rectangles, clipped by every overflow ancestor, so a box that merely
    touches another is not an overlap and a truncated line counts only what
    shows. Text the browser does not render (a closed disclosure's payload)
    is not ink. */
export const MEASURE_DEPUTY_BLOCKS = `(() => {
  const clipOf = (element) => {
    let clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const box = node.getBoundingClientRect();
        clip = { left: Math.max(clip.left, box.left), top: Math.max(clip.top, box.top), right: Math.min(clip.right, box.right), bottom: Math.min(clip.bottom, box.bottom) };
      }
    }
    return clip;
  };
  const ink = (root) => {
    const rects = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent || !node.textContent.trim()) continue;
      /* A closed <details> keeps its payload laid out under
         content-visibility: hidden; it has rectangles and no ink. */
      if (node.parentElement && node.parentElement.checkVisibility && !node.parentElement.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const clip = clipOf(node.parentElement);
      for (const rect of range.getClientRects()) {
        const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
        const top = Math.max(rect.top, clip.top), bottom = Math.min(rect.bottom, clip.bottom);
        if (right - left > 0.5 && bottom - top > 0.5) rects.push({ left, right, top, bottom });
      }
    }
    return rects;
  };
  const overlap = (a, b) => {
    let area = 0;
    for (const x of a) for (const y of b) {
      const w = Math.min(x.right, y.right) - Math.max(x.left, y.left);
      const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      if (w > 0.5 && h > 0.5) area += w * h;
    }
    return Math.round(area);
  };
  const content = document.querySelector("[data-feed-state]");
  const children = content ? [...content.children] : [];
  const seatRows = children.filter((child) => !child.hasAttribute("data-deputy-block") && (child.hasAttribute("data-feed-key") || child.hasAttribute("data-live-turn-group")));
  const seatInk = seatRows.map(ink);
  const order = children.flatMap((child) => child.hasAttribute("data-deputy-block") ? ["block:" + child.getAttribute("data-deputy-block")]
    : child.hasAttribute("data-live-turn-group") ? ["seat-live"]
    : child.hasAttribute("data-feed-key") ? ["seat"] : []);
  const round = (value) => Math.round(value * 10) / 10;
  const lastGlyphRight = (element) => {
    const rects = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width > 0.5) rects.push(rect);
    }
    const clip = element.getBoundingClientRect();
    if (!rects.length) return null;
    const lastTop = Math.max(...rects.map((rect) => rect.top));
    const onLast = rects.filter((rect) => Math.abs(rect.top - lastTop) < 2);
    return { right: Math.min(clip.right, Math.max(...onLast.map((rect) => rect.right))), top: lastTop, bottom: Math.max(...onLast.map((rect) => rect.bottom)) };
  };
  const afterOf = (block) => {
    const index = children.indexOf(block);
    const next = index >= 0 ? children[index + 1] : null;
    if (!next) return { after: "end", caption: null };
    if (next.hasAttribute("data-deputy-block")) return { after: "block", caption: null };
    if (next.getAttribute("data-feed-kind") === "user") return { after: "head", caption: null };
    const caption = next.querySelector('[data-seat-speaker="resumes"]');
    return caption ? { after: "resumes", caption: caption.textContent } : { after: "unnamed", caption: null };
  };
  const blocks = [...document.querySelectorAll("[data-deputy-block]")].map((block) => {
    const blockInk = ink(block);
    const title = block.querySelector("[data-deputy-title]");
    const result = block.querySelector("[data-deputy-result]");
    const toggle = block.querySelector("[data-deputy-toggle]");
    const edge = block.querySelector("[data-deputy-edge]");
    const body = block.querySelector("[data-deputy-body]");
    const rows = body ? [...body.querySelectorAll("[data-deputy-row], [data-live-turn], [data-deputy-missing]")] : [];
    const last = rows.length ? Math.max(...rows.map((row) => row.getBoundingClientRect().bottom)) : null;
    const chips = [...block.querySelectorAll("[data-deputy-chip]")];
    const glyph = result ? lastGlyphRight(result) : null;
    const sameLine = glyph ? chips.map((chip) => chip.getBoundingClientRect()).filter((rect) => rect.top < glyph.bottom && rect.bottom > glyph.top) : [];
    const collapsedLine = block.querySelector("[data-deputy-collapsed]");
    const chevron = collapsedLine ? collapsedLine.lastElementChild : null;
    const firstText = collapsedLine ? collapsedLine.querySelector("[data-deputy-short]") : null;
    const mcpRows = [...block.querySelectorAll('[data-testid="mcp-call-card"], [data-live-mcp]')];
    const chipLineLefts = mcpRows.flatMap((row) => {
      const title = row.querySelector("[data-mcp-title], [data-live-mcp-title]");
      const chip = row.querySelector('[data-testid^="mcp-link-"], [data-live-mcp-link]');
      if (!title || !chip) return [];
      const titleBox = title.getBoundingClientRect(), chipBox = chip.getBoundingClientRect();
      return chipBox.top >= titleBox.bottom - 1 ? [round(chipBox.left)] : [];
    });
    const caret = block.querySelector("[data-live-turn-caret]");
    const next = afterOf(block);
    return {
      askId: block.getAttribute("data-deputy-block"),
      state: block.getAttribute("data-deputy-state"),
      open: block.getAttribute("data-deputy-open") === "true",
      titleWidth: title ? round(title.getBoundingClientRect().width) : null,
      resultWidth: result ? round(result.getBoundingClientRect().width) : null,
      chips: block.querySelectorAll("[data-deputy-chip]").length,
      targetHeight: toggle ? round(toggle.getBoundingClientRect().height) : null,
      edge: edge && body && last !== null ? { top: round(edge.getBoundingClientRect().top), bottom: round(edge.getBoundingClientRect().bottom), bodyTop: round(body.getBoundingClientRect().top), lastRowBottom: round(last) } : null,
      overlapWithSeat: seatInk.reduce((total, rects) => total + overlap(blockInk, rects), 0),
      rows: rows.length,
      addressee: block.querySelector("[data-deputy-addressee]") ? block.querySelector("[data-deputy-addressee]").textContent.trim() : null,
      after: next.after,
      resumeCaption: next.caption,
      resultToChipGap: glyph && sameLine.length ? round(Math.min(...sameLine.map((rect) => rect.left)) - glyph.right) : null,
      resultWhole: result ? result.scrollWidth <= result.clientWidth + 1 && result.scrollHeight <= result.clientHeight + 1 : null,
      chevronOnFirstLine: chevron && firstText ? chevron.getBoundingClientRect().top < firstText.getBoundingClientRect().bottom && chevron.getBoundingClientRect().bottom > firstText.getBoundingClientRect().top : null,
      chipTexts: [...block.querySelectorAll('[data-testid^="mcp-link-"], [data-live-mcp-link]')].map((chip) => chip.textContent.trim()),
      rowSpeakers: [...block.querySelectorAll("[data-mobile-message-speaker]")].map((speaker) => speaker.textContent.trim()),
      chipLineLefts,
      caret: caret ? caret.getAttribute("data-live-turn-caret") + ":" + getComputedStyle(caret).backgroundColor : null,
    };
  });
  const seatLiveGroup = children.find((child) => child.hasAttribute("data-live-turn-group"));
  const seatCaret = seatLiveGroup ? seatLiveGroup.querySelector("[data-live-turn-caret]") : null;
  const seatSpeaker = seatLiveGroup ? seatLiveGroup.querySelector("[data-seat-speaker]") : null;
  return {
    blocks,
    order,
    seatLiveLast: order.at(-1) === "seat-live",
    seatLive: seatLiveGroup ? { speaker: seatSpeaker ? seatSpeaker.textContent.trim() : null, caret: seatCaret ? seatCaret.getAttribute("data-live-turn-caret") + ":" + getComputedStyle(seatCaret).backgroundColor : null } : null,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  };
})()`;

/** The gates, named per failure. */
export function deputyEvidenceFailures(reading: DeputyEvidenceReading, label: string, options: { scenario: string; phone: boolean; lang: "en" | "uk" }): string[] {
  const failures: string[] = [];
  if (!reading.blocks.length) failures.push(`${label}: no deputy block rendered`);
  if (reading.scrollWidth > reading.viewportWidth + 1) failures.push(`${label}: the page scrolls sideways (${reading.scrollWidth} > ${reading.viewportWidth})`);
  if (options.scenario !== "collapsed" && !reading.seatLiveLast) failures.push(`${label}: the seat's live turn is not the last section (${reading.order.join(" ")})`);
  if (reading.order.at(0)?.startsWith("block:") || reading.order.at(-1)?.startsWith("block:")) {
    failures.push(`${label}: a block is not pinned among the seat's rows (${reading.order.join(" ")})`);
  }
  for (const block of reading.blocks) {
    const name = `${label} ${block.askId}`;
    if (block.overlapWithSeat > 0) failures.push(`${name}: ${block.overlapWithSeat}px² of its ink overlaps a seat row`);
    if (!block.addressee || !block.addressee.includes(options.lang === "uk" ? "паралельне я" : "parallel self")) {
      failures.push(`${name}: the ask's meta line does not say it went to the parallel self (${block.addressee})`);
    }
    if (block.after === "unnamed") failures.push(`${name}: the seat row after the block does not name the head it continues`);
    if (options.lang === "uk") {
      const english = block.chipTexts.filter((chip) => /^Open /.test(chip));
      if (english.length) failures.push(`${name}: English chips in the Ukrainian interface (${english.join(", ")})`);
    }
    if (options.phone) {
      const bare = block.rowSpeakers.filter((speaker) => /^(Claude|Codex|Copilot|OpenClaw)$/.test(speaker));
      if (bare.length) failures.push(`${name}: a row inside the block is captioned with the bare engine name (${bare.join(", ")})`);
    }
    if (block.chipLineLefts.length > 1 && Math.max(...block.chipLineLefts) - Math.min(...block.chipLineLefts) > 2) {
      failures.push(`${name}: the block's chip lines start at ${block.chipLineLefts.join(", ")}`);
    }
    if (block.caret && !block.caret.startsWith("deputy:")) failures.push(`${name}: the block's caret wears the seat's ink (${block.caret})`);
    if (block.open) {
      if (block.titleWidth === null || block.titleWidth < 120) failures.push(`${name}: the caption's title is ${block.titleWidth}px`);
      if (!block.edge) failures.push(`${name}: an open block has no dashed edge over its rows`);
      else {
        if (Math.abs(block.edge.top - block.edge.bodyTop) > 2) failures.push(`${name}: the edge starts ${block.edge.top - block.edge.bodyTop}px off the body`);
        if (block.edge.bottom < block.edge.lastRowBottom - 8 || block.edge.bottom > block.edge.lastRowBottom + 4) {
          failures.push(`${name}: the edge ends at ${block.edge.bottom}, the last row at ${block.edge.lastRowBottom}`);
        }
      }
      if (!block.rows) failures.push(`${name}: an open block shows no rows`);
    } else {
      if (block.resultWidth === null || block.resultWidth < (options.phone ? 150 : 160)) failures.push(`${name}: the collapsed line's text is ${block.resultWidth}px`);
      if (options.phone && (block.targetHeight === null || block.targetHeight < 44)) failures.push(`${name}: the collapsed line's target is ${block.targetHeight}px tall`);
      if (block.resultWhole !== true) failures.push(`${name}: the collapsed line cuts its result`);
      if (block.chevronOnFirstLine !== true) failures.push(`${name}: the chevron is not on the collapsed line's first line`);
      if (!options.phone && block.chips && (block.resultToChipGap === null || block.resultToChipGap > 12)) {
        failures.push(`${name}: the first chip sits ${block.resultToChipGap}px from the result's last glyph`);
      }
    }
  }
  if (reading.blocks.some((block) => block.caret) && reading.seatLive) {
    if (!reading.seatLive.speaker) failures.push(`${label}: the seat's live turn streams beside a parallel self without naming its participant`);
    if (!reading.seatLive.caret?.startsWith("seat:")) failures.push(`${label}: the seat's live caret is ${reading.seatLive.caret}`);
    const deputyCaret = reading.blocks.find((block) => block.caret)?.caret?.split(":")[1];
    if (deputyCaret && deputyCaret === reading.seatLive.caret?.split(":")[1]) failures.push(`${label}: both live carets wear the same ink (${deputyCaret})`);
  }
  return failures;
}
