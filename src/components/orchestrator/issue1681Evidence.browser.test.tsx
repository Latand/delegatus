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
 *   - 390 × 844: the tick row is at least 44 px, the sheet opens and scrolls,
 *     and Save stays above a keyboard-sized inset.
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
    const dockEl = document.querySelector("[data-fixture-dock]") as HTMLElement;
    const row = document.querySelector("[data-orchestrator-incumbent]") as HTMLElement;
    return {
      /* The dock CLIPS; its own content must fit the width it really has. */
      dockOverflow: dockEl.scrollWidth > dockEl.clientWidth,
      rowLines: Math.round(row.getBoundingClientRect().height),
      /* Pre-existing, and recorded rather than asserted: the rail's 248 px and
         the dock's 360 px floor already exceed a 640 px viewport, so the
         desktop shell scrolls sideways there with or without this control. */
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  const face = await page.textContent("[data-seat-tick-chip]");
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
    chip: { ...chip, face: face?.trim() ?? "", title, dot },
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

async function phone(browser: Browser, base: string) {
  const viewport = { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?surface=phone`);
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
    };
  });
  await shot(page, "phone-seat-sheet");

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
  await shot(page, "phone-tick-sheet");

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
  await shot(page, "phone-tick-sheet-keyboard");

  const close = await page.evaluate(() => {
    (document.querySelector('[data-mobile2-sheet="tick"] [data-mobile2-close]') as HTMLButtonElement).click();
    return null;
  });
  await page.waitForSelector('[data-mobile2-sheet="seat"]');
  const returned = await page.locator("[data-seat-tick-row]").count();

  await context.close();
  return {
    key: "phone-390",
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
      wide: await desktop(browser, base, 1280, 800, 440),
      narrow: await desktop(browser, base, 640, 600, 360),
      phone: await phone(browser, base),
    };
  } finally {
    await browser.close();
    server.stop(true);
  }
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  for (const key of ["wide", "narrow"] as const) {
    const read = evidence[key] as Awaited<ReturnType<typeof desktop>>;
    expect(read.errors, `${key} page errors`).toEqual([]);
    expect(read.chip.width, `${key} chip rendered`).toBeGreaterThan(0);
    expect(read.chipBeforeRotate, `${key} chip before Rotate`).toBe(true);
    expect(read.chipInsideDock, `${key} chip inside the dock`).toBe(true);
    expect(read.rotateInsideDock, `${key} Rotate inside the dock`).toBe(true);
    /* The face is the schedule and the dot is the state, at every width. */
    expect(read.chip.face, `${key} chip face`).toContain(translate("en", "seatTick.everyMin", { n: 30 }));
    expect(read.chip.dot, `${key} chip dot`).toBe("warn");
    expect(read.chip.title, `${key} closed summary`).toContain("stale");
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
  const read = evidence.phone as Awaited<ReturnType<typeof phone>>;
  expect(read.errors, "phone page errors").toEqual([]);
  expect(read.rowMeetsTouchTarget, "the row is at least 44 px").toBe(true);
  expect(read.row.belowIdentity, "the row is under the seat identity").toBe(true);
  expect(read.row.aboveMandate, "the row is above Edit the mandate").toBe(true);
  expect(read.row.dot, "the row's dot is the actual state").toBe("warn");
  expect(read.row.text, "the row's trailing summary").toContain(translate("en", "seatTick.everyMin", { n: 30 }));
  expect(read.row.text, "the row's label").toContain(translate("en", "seatTick.rowLabel"));
  expect(read.row.pageOverflow, "no sideways overflow on the phone").toBe(false);
  expect(read.sheet.seatSheets, "the tick sheet replaces the seat sheet").toBe(0);
  expect(read.sheet.title, "the sheet names the seat and the project").toBe(translate("en", "seatTick.sheetTitle", { project: "Atlas" }));
  expect(read.sheet.bodyScrolls, "the sheet's body scrolls").toBe(true);
  expect(read.sheet.saveInBody, "Save is in the footer, not the scrolling body").toBe(false);
  expect(read.sheet.sheetShare, "the sheet takes at most 88 % of the height").toBeLessThanOrEqual(0.89);
  expect(read.save.height, "Save is at least 44 px").toBeGreaterThanOrEqual(44);
  expect(read.saveAboveKeyboard, "Save stays above the keyboard").toBe(true);
  expect(read.closeReturnsToSeatSheet, "the × returns to the seat sheet").toBe(true);
}, 300_000);
