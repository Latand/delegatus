import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { chromium, type Browser, type Page } from "playwright-core";
import postcss from "postcss";

/* Imported through the `@/` alias deliberately, and not only for the copy it
   checks below: inside `bun test`, `Bun.build` resolves a tsconfig path
   mapping only once the test module itself has imported through it, so a
   driver that reaches the alias for the first time from the bundle graph
   fails on every `@/lib/*` specifier in it. */
import { translate } from "@/lib/i18n";

/*
 * Rendered checks for #1681, against the production stylesheet and the real
 * controls (`issue1681Evidence.fixture.tsx`):
 *
 *   LLV_SEAT_TICK_BROWSER_TEST=1 bun test src/components/orchestrator/issue1681Evidence.browser.test.tsx
 *
 * happy-dom has no layout, so the claims only a browser can settle are settled
 * here:
 *
 *   - 1280 px with the dock at its default 440 px: the chip is visible in the
 *     incumbent row, beside Rotate, and the popover opens fully inside the
 *     viewport;
 *   - 640 px — the narrowest desktop the Viewer lays out (`useIsMobile`: under
 *     640 × 600 the phone shell takes over) — with the dock at its 360 px
 *     floor: the row keeps both controls whole, the popover is portalled so the
 *     dock's `overflow: hidden` cannot clip it, and nothing overflows
 *     sideways;
 *   - the KANBAN SEAT's header at 1280, 1048, 1024 and 900 px in both locales,
 *     and at every 8 px from 900 to 1280: that row does not wrap and nothing
 *     scrolls, so the controls group must not be drawn outside it, and the
 *     model name it exists to show must survive — whole, wherever the row has
 *     the room for it. It is measured on the row PRODUCTION draws, with the
 *     status read's effort and account badge on it, at the narrowest face the
 *     chip can carry and at the widest;
 *   - both halves of the inline host's give-way rule, measured from the other
 *     side: the same band and the same row with the stylesheet's own rule
 *     deleted from the page, so what each half buys is a number rather than an
 *     argument;
 *   - 390 × 844 in both locales, for a stale and a blocked reading: the tick
 *     row is at least 44 px, its label renders whole while the summary beside
 *     it truncates, the sheet opens and scrolls, and Save stays above a
 *     keyboard-sized inset.
 *
 * Measurements go to `evidence/issue-1681/geometry.json`. No raster is
 * committed: the numbers are the evidence, and this driver is how they are
 * reproduced.
 */

const browserTest = process.env.LLV_SEAT_TICK_BROWSER_TEST === "1" ? test : test.skip;
const EVIDENCE = path.resolve("evidence/issue-1681");
const OUT = path.resolve(".artifacts/issue-1681");

interface Rect { x: number; y: number; width: number; height: number }

const rectOf = (page: Page, selector: string) => page.evaluate((sel): Rect | null => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}, selector);

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function desktop(browser: Browser, base: string, width: number, height: number, dock: number) {
  const key = `desktop-${width}-dock-${dock}`;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "dark" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?surface=desktop&dock=${dock}`);
  await page.waitForSelector("[data-seat-tick-chip]");
  await page.waitForTimeout(400);

  const chip = (await rectOf(page, "[data-seat-tick-chip]"))!;
  const rotate = (await rectOf(page, "[data-orchestrator-rotate]"))!;
  const dockBox = (await rectOf(page, "[data-fixture-dock]"))!;
  const rowRead = await page.evaluate(() => {
    const contentWidth = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return Math.round(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    const dockEl = document.querySelector("[data-fixture-dock]") as HTMLElement;
    const row = document.querySelector("[data-orchestrator-incumbent]") as HTMLElement;
    const identity = document.querySelector("[data-orchestrator-identity]") as HTMLElement;
    const face = document.querySelector("[data-seat-tick-face]") as HTMLElement | null;
    return {
      /* The dock CLIPS; its own content must fit the width it really has. */
      dockOverflow: dockEl.scrollWidth > dockEl.clientWidth,
      hostWidth: Math.round(row.getBoundingClientRect().width),
      hostContentWidth: contentWidth(row),
      /* The dock's row wraps, so its own height says whether the controls
         pushed it onto a second line — the optional note in the critique. */
      identityLines: Math.round(identity.getBoundingClientRect().height),
      faceShown: face !== null && face.getBoundingClientRect().width > 0,
      rowLines: Math.round(row.getBoundingClientRect().height),
      /* Pre-existing, and recorded rather than asserted: the rail's 248 px and
         the dock's 360 px floor already exceed a 640 px viewport, so the
         desktop shell scrolls sideways there with or without this control. */
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  /* Rendered, not `textContent`: a collapsed face is `display: none` and keeps
     its words in the DOM. */
  const face = await page.evaluate(() => {
    const element = document.querySelector("[data-seat-tick-face]") as HTMLElement | null;
    return element && element.getBoundingClientRect().width > 0 ? element.textContent!.trim() : null;
  });
  const title = await page.getAttribute("[data-seat-tick-chip]", "title");
  const dot = await page.getAttribute("[data-seat-tick-chip] [data-seat-tick-dot]", "data-seat-tick-dot");
  await shot(page, `${key}-closed`);

  await page.click("[data-seat-tick-chip]");
  await page.waitForSelector("[data-seat-tick-popover]");
  await page.waitForTimeout(300);
  const popover = (await rectOf(page, "[data-seat-tick-popover]"))!;
  const measured = await page.evaluate(() => {
    const box = document.querySelector("[data-seat-tick-popover]") as HTMLElement;
    const details = document.querySelector("[data-seat-tick-details]") as HTMLDetailsElement;
    return {
      portalled: box.parentElement === document.body,
      state: (document.querySelector("[data-seat-tick-body]") as HTMLElement).dataset.seatTickState ?? "",
      summary: document.querySelector("[data-seat-tick-summary]")?.textContent ?? "",
      sentence: document.querySelector("[data-seat-tick-sentence]")?.textContent ?? "",
      detailsOpen: details.open,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      /* The dock clips its own children; a popover inside it would be cut. */
      insideDock: (document.querySelector("[data-fixture-dock]") as HTMLElement).contains(box),
    };
  });
  await shot(page, `${key}-open`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const afterEscape = await page.locator("[data-seat-tick-popover]").count();
  await page.click("[data-seat-tick-chip]");
  await page.waitForSelector("[data-seat-tick-popover]");
  await page.mouse.click(Math.min(width - 12, dockBox.x + dockBox.width + 40), height - 20);
  await page.waitForTimeout(200);
  const afterOutside = await page.locator("[data-seat-tick-popover]").count();

  await context.close();
  return {
    key,
    viewport: { width, height },
    dock,
    chip: { ...chip, face, title, dot },
    rotate,
    row: rowRead,
    /* Both controls whole, on ONE line, with the tick immediately before
       Rotate: they are the row's control group and they travel together. */
    chipBeforeRotate: chip.x + chip.width <= rotate.x + 1,
    controlsShareALine: Math.abs(chip.y - rotate.y) < 1,
    chipInsideDock: chip.x >= dockBox.x && chip.x + chip.width <= dockBox.x + dockBox.width + 1,
    rotateInsideDock: rotate.x + rotate.width <= dockBox.x + dockBox.width + 1,
    popover: { ...popover, ...measured },
    popoverInViewport: popover.x >= 0 && popover.y >= 0 && popover.x + popover.width <= width && popover.y + popover.height <= height,
    closesOnEscape: afterEscape === 0,
    closesOnOutsideClick: afterOutside === 0,
    errors,
  };
}

/**
 * The seat header row's geometry, read inside the page.
 *
 * Module-level and closure-free so `page.evaluate` can take it by reference
 * from BOTH callers below — the named samples and the width sweep. One copy
 * of this code produces every number in the evidence, so a width the sweep
 * reports cannot be a second reading written a second way.
 */
function readSeatRow() {
  const contentWidth = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return Math.round(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  };
  const head = document.querySelector(".seat-head") as HTMLElement;
  const row = document.querySelector("[data-orchestrator-incumbent]") as HTMLElement;
  const controls = document.querySelector("[data-orchestrator-controls]") as HTMLElement;
  const chip = document.querySelector("[data-seat-tick-chip]") as HTMLElement;
  const rotate = document.querySelector("[data-orchestrator-rotate]") as HTMLElement;
  const model = row.querySelector("[data-orchestrator-model]") as HTMLElement | null;
  const account = row.querySelector("[data-orchestrator-account]") as HTMLElement | null;
  const predecessor = document.querySelector("[data-orchestrator-predecessor]") as HTMLElement | null;
  const box = (element: Element | null) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), right: Math.round(rect.right), width: Math.round(rect.width) };
  };
  /* What the row is drawn over, if anything: every sibling of the incumbent
     row inside the header, and the row's own right edge against them. */
  const siblings = [...head.children]
    .filter((child) => child !== row)
    .map((child) => ({ mark: child.getAttribute("data-fixture-host-controls") !== null || child.getAttribute("data-fixture-collapse") !== null, ...box(child)! }))
    .filter((child) => child.mark);
  const identity = document.querySelector("[data-orchestrator-identity]") as HTMLElement;
  const controlsRight = controls.getBoundingClientRect().right;
  /* The precise symptom: `.seat-head` does not wrap and nothing scrolls, so
     a shrink-0 group inside a shrunk row SPILLS past its parent's right edge
     and is painted under whatever follows it in the DOM. `scrollWidth` reads
     0 for it, because flex absorbed the pressure by crushing the row's
     flexible children to nothing instead. */
  const spill = Math.round(controlsRight - identity.getBoundingClientRect().right);
  return {
    /* The container query reads the HOST's width; the identity row inside it
       is what gets crushed. Both are recorded so the thresholds are
       calibrated against a measurement rather than a guess. */
    hostWidth: Math.round(row.getBoundingClientRect().width),
    hostContentWidth: contentWidth(row),
    identityWidth: Math.round(identity.getBoundingClientRect().width),
    /* How far the controls group is drawn outside the row that holds it. */
    controlsSpill: Math.max(0, spill),
    /* And past the link that is painted over it — only while the link is
       actually drawn: a `display: none` element measures a zero rect at the
       origin, and subtracting that reports the whole viewport as a spill. */
    spillPastPredecessor: predecessor && predecessor.getBoundingClientRect().width > 0
      ? Math.max(0, Math.round(controlsRight - predecessor.getBoundingClientRect().x))
      : 0,
    headOverflow: Math.round(head.scrollWidth - head.clientWidth),
    rowOverflow: Math.round(row.scrollWidth - row.clientWidth),
    /* RENDERED, not `textContent`: a collapsed face is `display: none` and
       still carries its words in the DOM. */
    chipFace: (() => {
      const face = chip.querySelector("[data-seat-tick-face]") as HTMLElement | null;
      return face && face.getBoundingClientRect().width > 0 ? face.textContent!.trim() : null;
    })(),
    /* The whole summary stays reachable whatever the face shows. */
    chipTitle: chip.getAttribute("title"),
    chipLabel: chip.getAttribute("aria-label"),
    chipWidth: Math.round(chip.getBoundingClientRect().width),
    controlsWidth: Math.round(controls.getBoundingClientRect().width),
    modelWidth: model ? Math.round(model.getBoundingClientRect().width) : null,
    /* What the name would take if the row had the room — `scrollWidth` on the
       truncating span. Drawn/full is the reading the critique's table is in,
       and the difference is exactly what the row took away from the seat's own
       identity. */
    modelFullWidth: model ? model.scrollWidth : null,
    modelTruncated: model ? model.scrollWidth > model.clientWidth + 1 : false,
    /* The two children the first-paint row does not have, and the ones the
       crush lived in: the effort rides inside the model name, the account is
       its own badge. Recorded so a fixture that stopped mounting the status
       read cannot pass these assertions in silence. */
    modelText: model ? model.textContent!.replace(/\s+/g, " ").trim() : null,
    accountShown: account !== null && account.getBoundingClientRect().width > 0,
    accountWidth: account ? Math.round(account.getBoundingClientRect().width) : 0,
    rotateVisible: rotate.getBoundingClientRect().width > 0,
    predecessorShown: predecessor !== null && predecessor.getBoundingClientRect().width > 0,
    predecessorWidth: predecessor ? Math.round(predecessor.getBoundingClientRect().width) : 0,
    /* Inline the link is its glyph: no text node is drawn, and its words are
       on the title and the accessible name instead. */
    predecessorText: predecessor ? predecessor.textContent!.trim() : null,
    predecessorLabel: predecessor ? predecessor.getAttribute("aria-label") : null,
    /* Drawn OVER a sibling: the controls group's right edge past a later
       sibling's left edge is the overlap the critique measured at 900 px. */
    overlapsSiblings: siblings.some((sibling) => controlsRight > sibling.x + 1),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
}

/**
 * The kanban seat's header, in its own host, in both locales.
 *
 * `.kb .seat-head` is one flex row that does not wrap above 767 px, so an
 * overflow here does not reflow — it draws the controls group over the row's
 * other children and squeezes the model name to nothing. The dock's numbers
 * cannot stand in for it, which is how a 1024 px seat check written into the
 * design note went unmeasured.
 */
/**
 * What the seat surface is mounted with (`issue1681Evidence.fixture.tsx`).
 *
 * `face` is the widest thing in the controls group and `incumbent` decides
 * whether the row carries the two children the crush lived in — the effort
 * beside the model name and the account badge. Production passes both as soon
 * as the status poll answers, so `designated` is the row this file measures;
 * `board` is the first paint, before that poll lands.
 */
interface SeatCase {
  face?: ChipFace;
  incumbent?: "designated" | "board";
}
type ChipFace = "default" | "configured" | "longest";
/** The configured interval behind each face, for the chip's own title and
    accessible label — which carry the whole summary at every width. */
const FACE_MINUTES: Record<ChipFace, number> = { default: 60, configured: 30, longest: 1439 };
const seatUrl = (base: string, { face = "configured", incumbent = "designated" }: SeatCase) =>
  `${base}/?surface=seat&face=${face}&incumbent=${incumbent}`;
const caseKey = ({ face = "configured", incumbent = "designated" }: SeatCase) => `${incumbent}-${face}`;

async function seat(browser: Browser, base: string, width: number, locale: "en" | "uk", seatCase: SeatCase = {}) {
  const key = `seat-${width}-${locale}-${caseKey(seatCase)}`;
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: "dark" });
  /* The Viewer reads its locale from `localStorage`; the Ukrainian faces are
     the longest strings this row ever carries. */
  await context.addInitScript((value) => window.localStorage.setItem("llv_lang", value), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(seatUrl(base, seatCase));
  await page.waitForSelector("[data-seat-tick-chip]");
  await page.waitForTimeout(400);

  const measured = await page.evaluate(readSeatRow);
  await shot(page, key);
  await context.close();
  return { key, viewport: { width, height: 800 }, locale, ...seatCase, ...measured, errors };
}

/**
 * The inline host's one give-way width, mirroring `globals.css`.
 *
 * The stylesheet is where it takes effect; here it is what the assertions
 * below read, so a threshold moved in one place and not the other fails this
 * driver instead of shipping.
 */
const INLINE_GIVE_WAY_PX = 539;

/**
 * The host width from which the model name must hold its full bar.
 *
 * Below a 299 px host — an 800 px viewport — the room is gone before this row
 * is reached: `.seat-head` has already spent it on the seat mark, the title,
 * the «stays on the board» pill, the host controls and Collapse, and the
 * incumbent row is what is left. Nothing this row gives up buys it back; it
 * has given up everything it has by then. That narrow band is the seat
 * TITLE's to give way in, and it is recorded in the PR rather than fixed
 * here.
 *
 * What the band below the bar still owes, and what is asserted there, is that
 * the row holds together: no spill, no overlap, no overflow, and a model name
 * that is still drawn. That is the part main got wrong — at 768–792 px main
 * spilled 64–131 px and drew nothing for a model name at all.
 */
const MODEL_BAR_HOST_PX = 299;

/**
 * The bands the sweeps walk, in the steps the critique measured in.
 *
 * The PRODUCTION band is 900–1280: the row the status poll leaves behind is
 * wider than the first paint's by an effort and an account badge, and 900 px
 * is where the design note's own desktop claim starts. Above 1100 the seat's
 * 1040 px cap makes every wider viewport measure the same row, and 1280 is in
 * anyway because it is the width the crush was reported at.
 *
 * The FIRST-PAINT band starts at the phone shell's ceiling, where that lighter
 * row is still whole. The production row is not whole down there — at 768–800
 * px it loses its model name, which is recorded in the pull request as an
 * after-merge item rather than swept here.
 */
const SWEEP_STEP = 8;
const PRODUCTION_BAND = { from: 900, to: 1280 };
const FIRST_PAINT_BAND = { from: 768, to: 1100 };
/** The widths the critique's own table is in, so a sample of this sweep is
    comparable to it rather than near it. */
const NAMED_WIDTHS = [900, 1024, 1048, 1100, 1280];
function bandWidths({ from, to }: { from: number; to: number }): number[] {
  const widths = new Set<number>();
  for (let width = from; width <= to; width += SWEEP_STEP) widths.add(width);
  widths.add(to);
  for (const width of NAMED_WIDTHS) if (width >= from && width <= to) widths.add(width);
  return [...widths].sort((a, b) => a - b);
}

type SeatRow = ReturnType<typeof readSeatRow>;

/**
 * The seat header across a whole desktop band, in one locale, for one face and
 * one status read.
 *
 * Named widths are points, and this defect came back BETWEEN them twice: first
 * over-full at every host between a 399 px and a 523 px sample, then whole at
 * 1024 px and crushed at 1048 and above, where nobody had measured. A
 * threshold is a claim about a range, so the range is what gets measured —
 * every 8 px across the band, plus the widths the critique's own table is in,
 * with the assertions the named samples use.
 *
 * One context, resized: the seat surface is flex and container queries only,
 * so a viewport change is the whole state change, and reloading 51 pages per
 * sweep would buy nothing but minutes.
 */
async function sweepSeat(
  browser: Browser,
  base: string,
  locale: "en" | "uk",
  seatCase: SeatCase = {},
  band: { from: number; to: number } = PRODUCTION_BAND,
  /** Sweep the same band with one half of the give-way rule DELETED from the
      page — the what-if each half of the threshold is calibrated against. */
  keep: "word" | "link" | null = null,
) {
  const widths = bandWidths(band);
  const context = await browser.newContext({ viewport: { width: band.to, height: 800 }, colorScheme: "dark" });
  await context.addInitScript((value) => window.localStorage.setItem("llv_lang", value), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(seatUrl(base, seatCase));
  await page.waitForSelector("[data-seat-tick-chip]");
  await page.waitForTimeout(400);
  /* The rule is DELETED from the loaded stylesheet rather than overridden by
     one of this file's own: an override would be measuring whatever `display`
     it happened to pick, and what the threshold is a claim about is the row
     without that rule in it. The link's half of the same container rule is
     left alone — this what-if is about the word. */
  if (keep) {
    await page.evaluate((marker) => {
      const drop = (group: CSSGroupingRule): void => {
        for (let index = group.cssRules.length - 1; index >= 0; index -= 1) {
          const rule = group.cssRules[index];
          const selector = (rule as CSSStyleRule).selectorText;
          if (typeof selector === "string") {
            if (selector.includes(marker) && selector.includes("incumbent-inline")) group.deleteRule(index);
          } else if ((rule as CSSGroupingRule).cssRules) {
            drop(rule as CSSGroupingRule);
          }
        }
      };
      for (const sheet of [...document.styleSheets]) drop(sheet as unknown as CSSGroupingRule);
    }, keep === "word" ? "data-seat-tick-face" : "data-orchestrator-predecessor");
    await page.waitForTimeout(100);
  }

  const rows: (SeatRow & { width: number })[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    /* Two frames, so the container query has re-evaluated and the flex row has
       been laid out again before anything is read out of it. */
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    rows.push({ width, ...(await page.evaluate(readSeatRow)) });
  }
  await context.close();

  /* Recorded as a SUMMARY rather than 51 rows per sweep: what a sweep is for
     is its worst case, and the width it happened at is what a threshold gets
     calibrated against. The assertions below still run on every row. */
  const worstOf = (candidates: typeof rows) => candidates.reduce((worst, row) => ((row.modelWidth ?? 0) < (worst.modelWidth ?? 0) ? row : worst));
  const worstModel = worstOf(rows);
  const worstModelAtBar = worstOf(rows.filter((row) => row.hostContentWidth >= MODEL_BAR_HOST_PX));
  const worstSpill = rows.reduce((worst, row) => (row.controlsSpill > worst.controlsSpill ? row : worst));
  const shown = (predicate: (row: SeatRow) => boolean) => {
    const widths = rows.filter(predicate).map((row) => row.hostContentWidth);
    return widths.length ? Math.min(...widths) : null;
  };
  const { face = "configured", incumbent = "designated" } = seatCase;
  return {
    /* The SUMMARY is what lands in `geometry.json`; the rows stay here, for
       the assertions. 86 near-identical records would bury the three numbers
       that say whether the row holds. */
    summary: {
      key: `sweep-${locale}-${caseKey(seatCase)}${keep ? `-${keep}-kept` : ""}`,
      locale,
      face,
      incumbent,
      /* Which half of the give-way rule was taken out of the page for this
         sweep; null is the row as it ships. */
      keptAtEveryWidth: keep,
      band: { ...band, step: SWEEP_STEP, samples: rows.length },
      hostContentWidths: { min: Math.min(...rows.map((row) => row.hostContentWidth)), max: Math.max(...rows.map((row) => row.hostContentWidth)) },
      minModelWidth: { width: worstModel.width, hostContentWidth: worstModel.hostContentWidth, modelWidth: worstModel.modelWidth, modelFullWidth: worstModel.modelFullWidth },
      /* The same worst case, over the hosts that owe the full bar. */
      minModelWidthAtBar: { width: worstModelAtBar.width, hostContentWidth: worstModelAtBar.hostContentWidth, modelWidth: worstModelAtBar.modelWidth },
      maxControlsSpill: { width: worstSpill.width, hostContentWidth: worstSpill.hostContentWidth, controlsSpill: worstSpill.controlsSpill },
      maxSpillPastPredecessor: Math.max(...rows.map((row) => row.spillPastPredecessor)),
      maxHeadOverflow: Math.max(...rows.map((row) => row.headOverflow)),
      overlapsSiblings: rows.some((row) => row.overlapsSiblings),
      /* The narrowest host at which each thing is still drawn — the
         thresholds, read off the rendered row instead of off the
         stylesheet. */
      narrowestHostWithFace: shown((row) => row.chipFace !== null),
      narrowestHostWithPredecessor: shown((row) => row.predecessorShown),
      /* The narrowest host that still draws the seat's identity WHOLE. Above
         the give-way width every row owes this; below it the number says how
         far the whole name survives anyway. */
      narrowestHostWithWholeModel: shown((row) => !row.modelTruncated),
      /* The critique's own table, at its own widths: what the model name is
         drawn at, out of what it would take. */
      named: rows
        .filter((row) => NAMED_WIDTHS.includes(row.width))
        .map((row) => ({
          width: row.width,
          hostContentWidth: row.hostContentWidth,
          modelWidth: row.modelWidth,
          modelFullWidth: row.modelFullWidth,
          chipWidth: row.chipWidth,
          chipFace: row.chipFace,
          predecessorWidth: row.predecessorWidth,
          accountWidth: row.accountWidth,
        })),
    },
    rows,
    errors,
  };
}

async function phone(browser: Browser, base: string, locale: "en" | "uk" = "en", tick: "stale" | "blocked" = "stale") {
  const viewport = { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
  await context.addInitScript((value) => window.localStorage.setItem("llv_lang", value), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?surface=phone&tick=${tick}`);
  await page.waitForSelector("[data-seat-tick-row]");
  await page.waitForTimeout(400);

  const row = (await rectOf(page, "[data-seat-tick-row]"))!;
  const rowRead = await page.evaluate(() => {
    const element = document.querySelector("[data-seat-tick-row]") as HTMLElement;
    const mandate = document.querySelector("[data-orchestrator-edit-mandate]")?.getBoundingClientRect();
    const identity = document.querySelector("[data-orchestrator-incumbent]")?.getBoundingClientRect();
    const own = element.getBoundingClientRect();
    return {
      state: element.dataset.seatTickRow ?? "",
      text: element.textContent ?? "",
      dot: element.querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot") ?? "",
      /* Under the seat identity, above «Edit the mandate», overlapping
         neither. */
      belowIdentity: identity ? own.top >= identity.bottom - 1 : false,
      aboveMandate: mandate ? own.bottom <= mandate.top + 1 : false,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      /* The row's three parts, against each other and against the phone's own
         right edge: a trailing CLAUSE in a fixed-size slot crushes the label
         to nothing and pushes the dot and the chevron off the screen.

         Selected STRUCTURALLY — the label and the slots are the shared row
         primitive's own spans, so the caller has nothing to hang an attribute
         on: child 0 is the icon, 1 the label, 2 the trailing slot. */
      labelWidth: Math.round((element.children[1] as HTMLElement).getBoundingClientRect().width),
      labelText: (element.children[1] as HTMLElement).textContent ?? "",
      summaryWidth: Math.round((element.querySelector("[data-seat-tick-row-summary]") as HTMLElement).getBoundingClientRect().width),
      dotRight: Math.round((element.querySelector("[data-seat-tick-dot]") as HTMLElement).getBoundingClientRect().right),
      chevronRight: Math.round(((element.children[2] as HTMLElement).querySelector("svg") as unknown as SVGElement).getBoundingClientRect().right),
      rowRight: Math.round(own.right),
    };
  });
  await shot(page, `phone-${locale}-${tick}-seat-sheet`);

  await page.locator("[data-seat-tick-row]").click();
  await page.waitForSelector('[data-mobile2-sheet="tick"]');
  await page.waitForTimeout(400);
  const sheet = (await rectOf(page, '[data-mobile2-sheet="tick"]'))!;
  const save = (await rectOf(page, "[data-seat-tick-save]"))!;
  const opened = await page.evaluate(() => {
    const box = document.querySelector('[data-mobile2-sheet="tick"]') as HTMLElement;
    const body = box.querySelector("[data-mobile2-sheet-body]") as HTMLElement;
    return {
      seatSheets: document.querySelectorAll('[data-mobile2-sheet="seat"]').length,
      title: box.querySelector("h2")?.textContent ?? "",
      /* The body scrolls; the footer does not, which is what keeps Save at the
         thumb and above the keyboard. */
      bodyScrolls: body.scrollHeight > body.clientHeight,
      saveInBody: body.contains(document.querySelector("[data-seat-tick-save]")),
      sheetShare: box.getBoundingClientRect().height / window.innerHeight,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  await shot(page, `phone-${locale}-${tick}-tick-sheet`);

  /* The keyboard: focus the interval field and apply the inset the phone's own
     signal produces, then measure what is still reachable above it. */
  await page.locator("[data-seat-tick-interval]").focus();
  const keyboard = 336;
  await page.evaluate((inset) => {
    const host = document.querySelector("[style*='--seat-keyboard-inset']") as HTMLElement;
    host.style.setProperty("--seat-keyboard-inset", `${inset}px`);
    (document.querySelector('[data-mobile2-scrim]') as HTMLElement).style.bottom = `${inset}px`;
  }, keyboard);
  await page.waitForTimeout(300);
  const saveWithKeyboard = (await rectOf(page, "[data-seat-tick-save]"))!;
  await shot(page, `phone-${locale}-${tick}-keyboard`);

  const close = await page.evaluate(() => {
    (document.querySelector('[data-mobile2-sheet="tick"] [data-mobile2-close]') as HTMLButtonElement).click();
    return null;
  });
  await page.waitForSelector('[data-mobile2-sheet="seat"]');
  const returned = await page.locator("[data-seat-tick-row]").count();

  await context.close();
  return {
    key: `phone-390-${locale}-${tick}`,
    locale,
    tick,
    viewport,
    row: { ...row, ...rowRead },
    rowMeetsTouchTarget: row.height >= 44,
    sheet: { ...sheet, ...opened },
    save,
    saveAboveKeyboard: saveWithKeyboard.y + saveWithKeyboard.height <= viewport.height - keyboard,
    closeReturnsToSeatSheet: returned === 1 && close === null,
    errors,
  };
}

/**
 * What the seat's header must hold, wherever it is measured.
 *
 * Shared between the named widths and the sweep so the bar is one bar: the
 * row does not wrap and nothing scrolls, so a control group inside a shrunk
 * row is DRAWN over its siblings rather than reflowing, and the model name the
 * row exists to show is what gets crushed first.
 */
function expectSeatRow(read: SeatRow, locale: "en" | "uk", key: string, seatCase: SeatCase = {}): void {
  const { face = "configured", incumbent = "designated" } = seatCase;
  /* The controls group must not be drawn one pixel outside the row that holds
     it, nor over the siblings that follow it. */
  expect(read.controlsSpill, `${key} controls spill`).toBe(0);
  expect(read.spillPastPredecessor, `${key} spill past the predecessor link`).toBe(0);
  expect(read.overlapsSiblings, `${key} overlaps the header's other controls`).toBe(false);
  expect(read.headOverflow, `${key} header overflow`).toBe(0);
  /* And the identity the row exists for stays readable: a model name crushed
     to nothing is the row losing its own subject. */
  expect(read.modelWidth, `${key} model name drawn`).toBeGreaterThan(0);
  if (read.hostContentWidth >= MODEL_BAR_HOST_PX) {
    expect(read.modelWidth, `${key} model width`).toBeGreaterThan(40);
  }
  /* Above the give-way width the row has room for everything it carries, so
     the identity is drawn WHOLE — the defect this file was rewritten for was
     a row that fitted, spilled nowhere, and showed «clau…» anyway. */
  if (read.hostContentWidth > INLINE_GIVE_WAY_PX) {
    expect(read.modelTruncated, `${key} model name whole`).toBe(false);
  }
  /* The row measured is the row production draws: once the status poll has
     answered it carries the effort inside the model name and the account as
     its own badge, and those two are what the crush lived in. */
  if (incumbent === "designated") {
    expect(read.modelText, `${key} model name and effort`).toBe("claude-opus-5 · high");
    expect(read.accountShown, `${key} account badge`).toBe(true);
  }
  expect(read.rotateVisible, `${key} Rotate visible`).toBe(true);
  expect(read.chipWidth, `${key} chip visible`).toBeGreaterThan(0);
  /* Whatever the face shows, the word it gave up is still reachable — on the
     chip's own title and its accessible label, in the row's own locale. */
  const interval = translate(locale, "seatTick.everyMin", { n: FACE_MINUTES[face] });
  expect(read.chipTitle, `${key} chip title`).toContain(interval);
  expect(read.chipLabel, `${key} chip label`).toContain(interval);
  /* The word and the link are given up by the width, not by the locale, and at
     the one threshold the row was calibrated to: above it both are drawn, at
     or below it the row has already given them both up. */
  if (read.hostContentWidth > INLINE_GIVE_WAY_PX) {
    expect(read.chipFace, `${key} chip face`).not.toBeNull();
    expect(read.predecessorShown, `${key} predecessor link`).toBe(true);
    /* And where it IS drawn it is a glyph: no label in the row, its words on
       the title and on the accessible name. That is what stopped 156 px (en)
       and 186 px (uk) of a link that never shrinks coming off the seat's own
       identity. */
    expect(read.predecessorText, `${key} predecessor link is its glyph`).toBe("");
    expect(read.predecessorLabel, `${key} predecessor accessible name`).toBe(translate(locale, "orchPanel.predecessor"));
    expect(read.predecessorWidth, `${key} predecessor link width`).toBeLessThanOrEqual(24);
  } else {
    expect(read.chipFace, `${key} chip face collapsed`).toBeNull();
    expect(read.predecessorShown, `${key} predecessor link collapsed`).toBe(false);
  }
}

browserTest("#1681 rendered: the chip at 1280 and at the narrowest desktop, and the row and sheet at 390", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const build = await Bun.build({
    entrypoints: [path.resolve("src/components/orchestrator/issue1681Evidence.fixture.tsx")],
    target: "browser",
    outdir: path.join(OUT, "bundle"),
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const entry = build.outputs.find((output) => output.kind === "entry-point")!.path;
  const css = await postcss([tailwind()]).process(fs.readFileSync("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/app.js") return new Response(Bun.file(entry), { headers: { "content-type": "text/javascript" } });
      if (pathname === "/style.css") return new Response(css.css, { headers: { "content-type": "text/css" } });
      return new Response(
        '<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const base = `http://127.0.0.1:${server.port}`;
  let evidence: Record<string, unknown>;
  try {
    evidence = {
      issue: 1681,
      /* The narrowest desktop the Viewer lays out is 640 × 600 (`useIsMobile`);
         360 px is the dock's own floor (`OrchestratorDock.MIN_WIDTH`). */
      /* 1440 is the first width where the dock's own clamp
         (`max(360px, min(width, 100vw - 948px))`) actually grants the
         operator's 440 px, so it is where the tick's word comes back. */
      roomy: await desktop(browser, base, 1440, 900, 440),
      wide: await desktop(browser, base, 1280, 800, 440),
      narrow: await desktop(browser, base, 640, 600, 360),
      /* The seat header, which the dock's numbers say nothing about — on the
         row the status poll leaves behind, which is what production draws. */
      seatWide: await seat(browser, base, 1280, "en"),
      seat1048: await seat(browser, base, 1048, "en"),
      seat1048Uk: await seat(browser, base, 1048, "uk"),
      seat1024: await seat(browser, base, 1024, "en"),
      seat1024Uk: await seat(browser, base, 1024, "uk"),
      seat900: await seat(browser, base, 900, "en"),
      seat900Uk: await seat(browser, base, 900, "uk"),
      /* Those are points; the row broke BETWEEN them. The sweeps walk the
         band in both locales with the same bar, at the narrowest face the
         chip can carry and at the widest — the two ends of the only thing in
         the controls group whose width the operator can change. */
      sweepEnDefault: await sweepSeat(browser, base, "en", { face: "default" }),
      sweepEnLongest: await sweepSeat(browser, base, "en", { face: "longest" }),
      sweepUkDefault: await sweepSeat(browser, base, "uk", { face: "default" }),
      sweepUkLongest: await sweepSeat(browser, base, "uk", { face: "longest" }),
      /* And the first paint, before the status poll answers: a lighter row,
         swept down to the phone shell's ceiling. */
      sweepFirstPaintEn: await sweepSeat(browser, base, "en", { incumbent: "board" }, FIRST_PAINT_BAND),
      sweepFirstPaintUk: await sweepSeat(browser, base, "uk", { incumbent: "board" }, FIRST_PAINT_BAND),
      /* The other side of the threshold, in the worst case there is: the same
         band and the same row with the give-way rule taken out of the page. A
         threshold nobody has measured the far side of is a story. */
      sweepUkLongestWordKept: await sweepSeat(browser, base, "uk", { face: "longest" }, PRODUCTION_BAND, "word"),
      /* The link's half of the same rule, in the band where it is the one that
         costs: the first paint at the phone shell's ceiling. */
      sweepFirstPaintUkLinkKept: await sweepSeat(browser, base, "uk", { incumbent: "board" }, FIRST_PAINT_BAND, "link"),
      phone: await phone(browser, base),
      /* The row's label is the thing that disappeared: the longest trailing
         clause, and the longest label, in the locale that has both. */
      phoneUk: await phone(browser, base, "uk"),
      phoneBlocked: await phone(browser, base, "en", "blocked"),
      phoneBlockedUk: await phone(browser, base, "uk", "blocked"),
    };
  } finally {
    await browser.close();
    server.stop(true);
  }
  /* The sweeps go in as their summaries: 86 near-identical records would bury
     the numbers that say whether the row holds, and the rows themselves are
     reproduced by re-running this driver. */
  const sweepKeys = ["sweepEnDefault", "sweepEnLongest", "sweepUkDefault", "sweepUkLongest", "sweepFirstPaintEn", "sweepFirstPaintUk"] as const;
  const whatIfKeys = ["sweepUkLongestWordKept", "sweepFirstPaintUkLinkKept"] as const;
  const recorded = {
    ...evidence,
    ...Object.fromEntries([...sweepKeys, ...whatIfKeys].map((key) => [key, (evidence[key] as Awaited<ReturnType<typeof sweepSeat>>).summary])),
  };
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify(recorded, null, 2)}\n`);

  for (const key of ["roomy", "wide", "narrow"] as const) {
    const read = evidence[key] as Awaited<ReturnType<typeof desktop>>;
    expect(read.errors, `${key} page errors`).toEqual([]);
    expect(read.chip.width, `${key} chip rendered`).toBeGreaterThan(0);
    expect(read.chipBeforeRotate, `${key} chip before Rotate`).toBe(true);
    expect(read.chipInsideDock, `${key} chip inside the dock`).toBe(true);
    expect(read.rotateInsideDock, `${key} Rotate inside the dock`).toBe(true);
    /* The dot is the state at EVERY width; the face is the schedule while the
       host can afford the word, and the whole summary is on the title and the
       accessible label either way. */
    expect(read.chip.dot, `${key} chip dot`).toBe("warn");
    expect(read.chip.title, `${key} closed summary`).toContain("stale");
    if (read.row.hostContentWidth > 379) {
      expect(read.chip.face, `${key} chip face`).toContain(translate("en", "seatTick.everyMin", { n: 30 }));
    } else {
      expect(read.chip.face, `${key} chip face collapsed`).toBeNull();
      /* The dock's row WRAPS, and on the row production draws — the status
         read's effort and account badge included — a 336 px host spends a
         second line on them rather than crushing the identity. That is this
         host giving way the way it is built to, and it is bounded: two lines,
         inside a dock that still does not overflow. The kanban seat's row has
         no such give, which is why it is measured separately and why the two
         hosts have thresholds of their own. */
      expect(read.row.identityLines, `${key} identity lines`).toBeLessThanOrEqual(56);
    }
    expect(read.popoverInViewport, `${key} popover inside the viewport`).toBe(true);
    expect(read.popover.portalled, `${key} popover portalled`).toBe(true);
    expect(read.popover.insideDock, `${key} popover outside the clipping dock`).toBe(false);
    expect(read.popover.state, `${key} rendered state`).toBe("stale");
    expect(read.popover.detailsOpen, `${key} Details closed by default`).toBe(false);
    expect(read.controlsShareALine, `${key} the tick and Rotate on one line`).toBe(true);
    expect(read.row.dockOverflow, `${key} the row fits the dock it is in`).toBe(false);
    expect(read.closesOnEscape, `${key} Escape closes`).toBe(true);
    expect(read.closesOnOutsideClick, `${key} outside click closes`).toBe(true);
  }
  /* The kanban seat's header, which the dock's numbers said nothing about. */
  for (const key of ["seatWide", "seat1048", "seat1048Uk", "seat1024", "seat1024Uk", "seat900", "seat900Uk"] as const) {
    const seatRead = evidence[key] as Awaited<ReturnType<typeof seat>>;
    expect(seatRead.errors, `${key} page errors`).toEqual([]);
    expectSeatRow(seatRead, seatRead.locale, key);
  }
  /* And the same assertions at every 8 px across the band, because the named
     widths above are points and the row broke between them. */
  for (const key of sweepKeys) {
    const sweep = evidence[key] as Awaited<ReturnType<typeof sweepSeat>>;
    const seatCase = { face: sweep.summary.face, incumbent: sweep.summary.incumbent };
    expect(sweep.errors, `${key} page errors`).toEqual([]);
    expect(sweep.rows.length, `${key} samples`).toBe(bandWidths(sweep.summary.band).length);
    for (const row of sweep.rows) expectSeatRow(row, sweep.summary.locale, `${key} at ${row.width} px`, seatCase);
  }

  /* What the give-way rule BUYS, measured rather than argued: the same band,
     the same row, the same widest face, with the rule taken out of the page.
     The word held at every width crushes the very name this row exists to
     show — and the row does not spill while it does it, which is why only a
     measurement finds it. */
  {
    const shipped = evidence.sweepUkLongest as Awaited<ReturnType<typeof sweepSeat>>;
    const whatIf = evidence.sweepUkLongestWordKept as Awaited<ReturnType<typeof sweepSeat>>;
    expect(whatIf.errors, "the word what-if page errors").toEqual([]);
    expect(whatIf.summary.keptAtEveryWidth, "the what-if kept the word").toBe("word");
    /* The rule really came out: below the threshold the face is drawn. */
    expect(whatIf.summary.narrowestHostWithFace, "the what-if draws the face at every host").toBe(whatIf.summary.hostContentWidths.min);
    /* And keeping it costs the identity: the whole name survives only from a
       much wider host, and the worst case loses tens of pixels. */
    expect(whatIf.summary.narrowestHostWithWholeModel!, "the what-if needs a wider host for a whole name")
      .toBeGreaterThan(shipped.summary.narrowestHostWithWholeModel!);
    expect(whatIf.summary.minModelWidth.modelWidth!, "the what-if crushes the name further")
      .toBeLessThan(shipped.summary.minModelWidth.modelWidth! - 30);

    /* The link's half, in the band where it is the one that costs: 12 px of
       glyph, against a row that has nothing left to give. */
    const shippedLink = evidence.sweepFirstPaintUk as Awaited<ReturnType<typeof sweepSeat>>;
    const linkWhatIf = evidence.sweepFirstPaintUkLinkKept as Awaited<ReturnType<typeof sweepSeat>>;
    expect(linkWhatIf.errors, "the link what-if page errors").toEqual([]);
    expect(linkWhatIf.summary.keptAtEveryWidth, "the what-if kept the link").toBe("link");
    expect(linkWhatIf.summary.narrowestHostWithPredecessor, "the what-if draws the link at every host").toBe(linkWhatIf.summary.hostContentWidths.min);
    /* Kept there it takes the name further down AND pushes the controls group
       outside the row that holds it — which is the failure this whole file
       exists to catch. */
    expect(linkWhatIf.summary.minModelWidthAtBar.modelWidth!, "the what-if crushes the name further")
      .toBeLessThan(shippedLink.summary.minModelWidthAtBar.modelWidth!);
    expect(linkWhatIf.summary.maxControlsSpill.controlsSpill, "the what-if spills past the row")
      .toBeGreaterThan(shippedLink.summary.maxControlsSpill.controlsSpill);
  }

  /* The phone's row, in both locales and for the longest trailing clause it
     can carry. The row's LABEL is what disappeared: a clause in a fixed-size
     trailing slot crushed it to nothing and pushed the state dot and the
     chevron off the right edge. */
  for (const key of ["phone", "phoneUk", "phoneBlocked", "phoneBlockedUk"] as const) {
    const phoneRead = evidence[key] as Awaited<ReturnType<typeof phone>>;
    const row = phoneRead.row;
    expect(phoneRead.errors, `${key} page errors`).toEqual([]);
    /* The label renders, whole, in its own locale — never truncated away by
       the clause beside it. */
    expect(row.labelText, `${key} row label`).toBe(translate(phoneRead.locale, "seatTick.rowLabel"));
    expect(row.labelWidth, `${key} label width`).toBeGreaterThan(40);
    /* The summary is the element that gives way, and it still shows
       something. */
    expect(row.summaryWidth, `${key} summary width`).toBeGreaterThan(80);
    /* The dot and the chevron stay inside the row, which stays inside the
       phone: those two marks are the row's state and its affordance. */
    expect(row.dotRight, `${key} dot inside the row`).toBeLessThanOrEqual(row.rowRight);
    expect(row.chevronRight, `${key} chevron inside the row`).toBeLessThanOrEqual(row.rowRight);
    expect(row.rowRight, `${key} row inside the phone`).toBeLessThanOrEqual(phoneRead.viewport.width);
    expect(row.pageOverflow, `${key} no sideways overflow`).toBe(false);
    expect(phoneRead.rowMeetsTouchTarget, `${key} row is at least 44 px`).toBe(true);
  }

  const read = evidence.phone as Awaited<ReturnType<typeof phone>>;
  expect(read.errors, "phone page errors").toEqual([]);
  expect(read.rowMeetsTouchTarget, "the row is at least 44 px").toBe(true);
  expect(read.row.belowIdentity, "the row is under the seat identity").toBe(true);
  expect(read.row.aboveMandate, "the row is above Edit the mandate").toBe(true);
  expect(read.row.dot, "the row's dot is the actual state").toBe("warn");
  expect(read.sheet.seatSheets, "the tick sheet replaces the seat sheet").toBe(0);
  expect(read.sheet.title, "the sheet names the seat and the project").toBe(translate("en", "seatTick.sheetTitle", { project: "Atlas" }));
  expect(read.sheet.bodyScrolls, "the sheet's body scrolls").toBe(true);
  expect(read.sheet.saveInBody, "Save is in the footer, not the scrolling body").toBe(false);
  expect(read.sheet.sheetShare, "the sheet takes at most 88 % of the height").toBeLessThanOrEqual(0.89);
  expect(read.save.height, "Save is at least 44 px").toBeGreaterThanOrEqual(44);
  expect(read.saveAboveKeyboard, "Save stays above the keyboard").toBe(true);
  expect(read.closeReturnsToSeatSheet, "the × returns to the seat sheet").toBe(true);
}, 300_000);
