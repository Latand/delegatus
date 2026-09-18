import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for #1731: typing or dictating into the seat's composer
 * must not move the board below it. In the real Viewer over
 * `issue1695Evidence.fixture.tsx`, in Chromium:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1731SeatAnchor.browser.test.tsx
 *
 * The seat has a fixed height and the composer sits at its bottom, so a
 * growing field moves the form's top upward inside a box whose own size never
 * changes. Chrome's scroll anchoring on the page scroller (`.kb .kb-page`)
 * used to pick an anchor inside that moving region and compensate its
 * `scrollTop`, displacing the whole board by the field's height delta once per
 * character. `.kb .seat { overflow-anchor: none }` takes the seat out of the
 * anchor candidates; `kanbanBoard.css` carries the rule and this test holds it.
 *
 * Each case scrolls the page so the seat header is out of view and the
 * composer is the topmost visible content, then drives the composer's value
 * across its own wrap boundary — the probe finds that boundary at the actual
 * field width — and reads the board frame's viewport top, the scroller's
 * `scrollTop` and the field's height after every change. The field's height
 * has to change and the other two have to stand still.
 *
 * The red path runs in the same case: `overflow-anchor: auto` back on the seat
 * inline, the identical drive, and the board frame has to move. Anchoring is a
 * real-browser behaviour that happy-dom does not implement, which is why this
 * lives here and not in a `.dom.test.tsx`.
 *
 * Covered: 1440×900 and 1100×800, the compact seat and one dragged open by its
 * grip. Measurements go to `evidence/issue-1731/seat-anchor.json`; frames to
 * `.artifacts/issue-1731/`, which is not committed.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1731");
const EVIDENCE = path.resolve("evidence/issue-1731");
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1100, height: 800 }] as const;
/** How many times the draft crosses its wrap boundary — a dictated tail re-wraps about this often in a sentence. */
const ALTERNATIONS = 12;
/** How far above the scrollport's top edge the composer's form starts, so the composer is what the scroller can anchor to. */
const COMPOSER_CLIP = 24;

const SEAT = "[data-kanban-seat]";
const FIELD = `${SEAT} textarea`;
const FORM = `${SEAT} form`;
const SCROLLER = ".kb .kb-page";
const FRAME = ".kb .board-frame";

type Sample = { fieldHeight: number; frameTop: number; scrollTop: number };

async function boardReady(page: Page) {
  await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
  await page.waitForSelector(FIELD, { state: "attached", timeout: 20_000 });
  await page.waitForTimeout(800);
}

/** A value set the way the composer receives one from a keystroke or a transcript revision: the native setter, then React's input event. */
const setValue = (page: Page, value: string) => page.evaluate(({ selector, next }) => {
  const field = document.querySelector<HTMLTextAreaElement>(selector);
  if (!field) throw new Error("no seat composer");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, next);
  field.setSelectionRange(next.length, next.length);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}, { selector: FIELD, next: value });

/* A missing element is a failure and never a sentinel: a NaN reading would
   deduplicate to one value for the green assertion and compare unequal to
   itself for the red one, so a renamed selector would satisfy both checks
   while measuring nothing. */
const sample = (page: Page) => page.evaluate(({ field, frame, scroller }) => {
  const found = <T extends HTMLElement>(selector: string) => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`nothing matches ${selector} — this test measures what is not there`);
    return element;
  };
  return {
    fieldHeight: found<HTMLTextAreaElement>(field).offsetHeight,
    frameTop: Number(found(frame).getBoundingClientRect().top.toFixed(2)),
    scrollTop: Number(found(scroller).scrollTop.toFixed(2)),
  };
}, { field: FIELD, frame: FRAME, scroller: SCROLLER }) as Promise<Sample>;

/**
 * The shortest pair of drafts either side of the composer's first wrap, found
 * at the field's real width: a fixed string would sit on one side of it at one
 * viewport and on the other side at the next.
 */
async function wrapPair(page: Page): Promise<{ short: string; long: string; heights: [number, number] }> {
  const found = await page.evaluate(async ({ selector }) => {
    const field = document.querySelector<HTMLTextAreaElement>(selector);
    if (!field) throw new Error("no seat composer");
    const set = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
      field.setSelectionRange(value.length, value.length);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    let draft = "dictated";
    set(draft);
    await settle();
    const base = field.offsetHeight;
    for (let word = 0; word < 400; word++) {
      const next = `${draft} dictated`;
      set(next);
      await settle();
      if (field.offsetHeight > base) {
        const heights: [number, number] = [base, field.offsetHeight];
        set("");
        await settle();
        return { short: draft, long: next, heights };
      }
      draft = next;
    }
    set("");
    await settle();
    return null;
  }, { selector: FIELD });
  if (!found) throw new Error("the composer never wrapped: no height to hold still against");
  return found;
}

/** Scroll the page until the seat's header is gone and the composer is what sits at the top of the scrollport. */
async function scrollComposerToTop(page: Page) {
  const state = await page.evaluate(({ scroller, form, seat, clip }) => {
    const page_ = document.querySelector<HTMLElement>(scroller);
    const composer = document.querySelector<HTMLElement>(form);
    const head = document.querySelector<HTMLElement>(`${seat} .seat-head`);
    if (!page_ || !composer || !head) throw new Error("seat, composer or page scroller missing");
    const max = page_.scrollHeight - page_.clientHeight;
    const want = page_.scrollTop + composer.getBoundingClientRect().top - page_.getBoundingClientRect().top + clip;
    page_.scrollTop = Math.max(0, Math.min(max, want));
    return { scrollTop: page_.scrollTop, maxScroll: max };
  }, { scroller: SCROLLER, form: FORM, seat: SEAT, clip: COMPOSER_CLIP });
  await page.waitForTimeout(300);
  const preconditions = await page.evaluate(({ scroller, form, seat }) => {
    const page_ = document.querySelector<HTMLElement>(scroller)!;
    const composer = document.querySelector<HTMLElement>(form)!;
    const head = document.querySelector<HTMLElement>(`${seat} .seat-head`)!;
    const top = page_.getBoundingClientRect().top;
    const box = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, top + 2);
    return {
      headOutOfView: head.getBoundingClientRect().bottom <= top,
      composerOnTop: Boolean(hit && composer.contains(hit)),
      composerClipped: box.top < top,
    };
  }, { scroller: SCROLLER, form: FORM, seat: SEAT });
  return { ...state, ...preconditions };
}

/** Drag the seat's grip down, the way an operator opens it for a longer answer. */
async function dragSeatOpen(page: Page, by: number) {
  const before = await page.evaluate((seat) => document.querySelector<HTMLElement>(seat)?.getBoundingClientRect().height ?? 0, SEAT);
  const grip = await page.locator("[data-seat-grip]").boundingBox();
  if (!grip) throw new Error("no seat grip to drag");
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + by, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate((seat) => document.querySelector<HTMLElement>(seat)?.getBoundingClientRect().height ?? 0, SEAT);
  return { before: Math.round(before), after: Math.round(after) };
}

const setAnchoring = (page: Page, value: "" | "auto") => page.evaluate(({ seat, next }) => {
  const section = document.querySelector<HTMLElement>(seat);
  if (!section) throw new Error("no seat");
  section.style.overflowAnchor = next;
  return getComputedStyle(section).overflowAnchor;
}, { seat: SEAT, next: value });

/** One pass of the draft across its wrap boundary, sampled after every change. */
async function drive(page: Page, pair: { short: string; long: string }) {
  await setValue(page, pair.short);
  await page.waitForTimeout(150);
  const samples: Sample[] = [await sample(page)];
  for (let step = 0; step < ALTERNATIONS; step++) {
    await setValue(page, step % 2 === 0 ? pair.long : pair.short);
    await page.waitForTimeout(70);
    samples.push(await sample(page));
  }
  const tops = samples.map((entry) => entry.frameTop);
  return {
    fieldHeights: [...new Set(samples.map((entry) => entry.fieldHeight))],
    frameTops: [...new Set(tops)],
    scrollTops: [...new Set(samples.map((entry) => entry.scrollTop))],
    swings: tops.filter((top, index) => index > 0 && top !== tops[index - 1]).length,
  };
}

browserTest("#1731: typing or dictating in the seat leaves the board where it is, at both widths and both seat sizes", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await serveEvidenceFixture(OUT);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const cases: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      const { context, page, pageErrors } = await openFixture(browser, server.base, viewport, "light");
      try {
        await boardReady(page);
        for (const seatSize of ["compact", "grip-expanded"] as const) {
          const label = `${viewport.width}x${viewport.height} ${seatSize}`;
          let drag: { before: number; after: number } | null = null;
          if (seatSize === "grip-expanded") {
            drag = await dragSeatOpen(page, 250);
            if (drag.after <= drag.before) failures.push(`${label}: the grip did not open the seat (${drag.before} → ${drag.after})`);
          }
          const pair = await wrapPair(page);
          await page.click(FIELD);
          await page.waitForTimeout(250);
          const placement = await scrollComposerToTop(page);
          if (!placement.headOutOfView) failures.push(`${label}: the seat header is still in view at scrollTop ${placement.scrollTop}`);
          if (!placement.composerOnTop) failures.push(`${label}: the composer is not the topmost visible content at scrollTop ${placement.scrollTop}`);

          const anchoring = await page.evaluate((seat) => getComputedStyle(document.querySelector(seat)!).overflowAnchor, SEAT);
          if (anchoring !== "none") failures.push(`${label}: the seat's overflow-anchor is ${anchoring}, not none — the stylesheet rule is gone`);
          const fixed = await drive(page, pair);
          await page.screenshot({ path: path.join(OUT, `${label.replace(/[^a-z0-9]+/gi, "-")}-fixed.png`) });

          /* The red path, in place: the seat becomes an anchor candidate again and the same drive has to move the board. */
          const red = await setAnchoring(page, "auto");
          const unfixed = await drive(page, pair);
          await setAnchoring(page, "");

          cases.push({ viewport, seat: seatSize, seatHeights: drag, scroll: placement, wrap: { heights: pair.heights, shortLength: pair.short.length, longLength: pair.long.length }, fixed, unfixed: { ...unfixed, overflowAnchor: red } });
          if (fixed.fieldHeights.length < 2) failures.push(`${label}: the field never changed height (${fixed.fieldHeights.join(", ")}) — nothing was held still`);
          if (fixed.frameTops.length !== 1) failures.push(`${label}: the board frame moved, tops ${fixed.frameTops.join(", ")} (${fixed.swings} swings)`);
          if (fixed.scrollTops.length !== 1) failures.push(`${label}: the page scroller moved, scrollTops ${fixed.scrollTops.join(", ")}`);
          if (unfixed.fieldHeights.length < 2) failures.push(`${label}: the red path's field never changed height — the control proves nothing`);
          if (unfixed.swings === 0) failures.push(`${label}: the board stood still with anchoring back on, so this check cannot fail`);

          if (seatSize === "compact") await setValue(page, "");
        }
        if (pageErrors.length) failures.push(`${viewport.width}x${viewport.height}: page errors ${pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${viewport.width}x${viewport.height}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
  fs.writeFileSync(path.join(EVIDENCE, "seat-anchor.json"), `${JSON.stringify({ alternations: ALTERNATIONS, cases, failures }, null, 2)}\n`);
  expect(failures).toEqual([]);
}, 600_000);
