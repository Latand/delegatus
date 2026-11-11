import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { chromium, type Browser, type Page } from "playwright-core";
import postcss from "postcss";
import type { BunPlugin } from "bun";

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
 *   - the real kanban header is covered by the kanban driver's seat-header case;
 *   - 390 × 844 in both locales, for a stale and a blocked reading: the tick
 *     row is at least 44 px, its button label and trailing switch render whole, the sheet opens and scrolls, and Save stays above a
 *     keyboard-sized inset.
 *
 * Measurements go to `evidence/issue-1681/geometry.json`. No raster is
 * committed: the numbers are the evidence, and this driver is how they are
 * reproduced.
 */

// Bun's standalone fixture bundler does not implement Next's server-action
// boundary. This fixture has no transcript, so that unrelated transport must
// never run; keep its server module out of the browser just as Next does.
const serverActionBoundary: BunPlugin = {
  name: "fixture-server-action-boundary",
  setup(build) {
    build.onLoad({ filter: /structuredUserProvenanceClient\.ts$/ }, () => ({ loader: "js",
      contents: 'export async function structuredUserProvenance() { throw new Error("No transcript metadata in this rendered fixture"); }',
    }));
  },
};

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
      detail: document.querySelector("[data-seat-tick-status-detail]")?.textContent ?? "",
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
      /* Under the seat identity, above «Edit the mandate», overlapping
         neither. */
      belowIdentity: identity ? own.top >= identity.bottom - 1 : false,
      aboveMandate: mandate ? own.bottom <= mandate.top + 1 : false,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      labelWidth: element.querySelector('[data-mobile2-open="tick"] span:last-child')!.getBoundingClientRect().width,
      labelText: element.querySelector('[data-mobile2-open="tick"] span:last-child')!.textContent ?? "",
      labelWhole: (() => {
        const label = element.querySelector<HTMLElement>('[data-mobile2-open="tick"] span:last-child')!;
        return label.scrollWidth <= label.clientWidth + 1;
      })(),
      buttonHeight: element.querySelector('[data-mobile2-open="tick"]')!.getBoundingClientRect().height,
      switchRight: element.querySelector('[data-seat-tick-switch]')!.getBoundingClientRect().right,
      switchState: element.querySelector('[data-seat-tick-switch]')!.getAttribute('data-seat-tick-chip'),
      switchText: element.querySelector('[data-seat-tick-switch]')!.getAttribute('aria-valuetext') ?? "",
      rowRight: Math.round(own.right),
    };
  });
  await shot(page, `phone-${locale}-${tick}-seat-sheet`);

  await page.locator('[data-seat-tick-row] [data-mobile2-open="tick"]').click();
  await page.waitForSelector('[data-mobile2-sheet="tick"]');
  await page.waitForTimeout(400);
  const sheet = (await rectOf(page, '[data-mobile2-sheet="tick"]'))!;
  const saveBeforeChange = await page.locator("[data-seat-tick-save]").count();
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

  /* The panel's one Save appears with the first change, in the footer. */
  await page.locator("[data-seat-tick-interval]").fill("45");
  await page.waitForSelector("[data-seat-tick-save]");
  const save = (await rectOf(page, "[data-seat-tick-save]"))!;

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
    saveBeforeChange,
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
    plugins: [serverActionBoundary],
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
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify(evidence, null, 2)}\n`);

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
      expect(read.chip.face, `${key} chip face`).toContain(translate("en", "seatTick.switch.min", { n: 30 }));
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
  /* The phone row has an opening button and a separate schedule switch. */
  for (const key of ["phone", "phoneUk", "phoneBlocked", "phoneBlockedUk"] as const) {
    const phoneRead = evidence[key] as Awaited<ReturnType<typeof phone>>;
    const row = phoneRead.row;
    expect(phoneRead.errors, `${key} page errors`).toEqual([]);
    /* The label renders, whole, in its own locale — never truncated away by
       the clause beside it. */
    expect(row.labelText, `${key} row label`).toBe(translate(phoneRead.locale, "seatTick.rowLabel"));
    expect(row.labelWidth, `${key} label width`).toBeGreaterThan(40);
    expect(row.labelWhole, `${key} whole label`).toBe(true);
    expect(row.buttonHeight, `${key} opening button touch target`).toBeGreaterThanOrEqual(44);
    expect(row.switchRight, `${key} switch inside the row`).toBeLessThanOrEqual(row.rowRight);
    expect(row.switchState, `${key} switch state`).toBe(phoneRead.tick);
    expect(row.switchText, `${key} accessible schedule`).not.toBe("");
    expect(row.rowRight, `${key} row inside the phone`).toBeLessThanOrEqual(phoneRead.viewport.width);
    expect(row.pageOverflow, `${key} no sideways overflow`).toBe(false);
    expect(phoneRead.rowMeetsTouchTarget, `${key} row is at least 44 px`).toBe(true);
  }

  const read = evidence.phone as Awaited<ReturnType<typeof phone>>;
  expect(read.errors, "phone page errors").toEqual([]);
  expect(read.rowMeetsTouchTarget, "the row is at least 44 px").toBe(true);
  expect(read.row.belowIdentity, "the row is under the seat identity").toBe(true);
  expect(read.row.aboveMandate, "the row is above Edit the mandate").toBe(true);
  expect(read.row.switchState, "the switch shows the actual state").toBe("stale");
  expect(read.sheet.seatSheets, "the tick sheet replaces the seat sheet").toBe(0);
  expect(read.sheet.title, "the sheet names the seat and the project").toBe(translate("en", "seatTick.sheetTitle", { project: "Atlas" }));
  expect(read.sheet.bodyScrolls, "the sheet's body scrolls").toBe(true);
  expect(read.saveBeforeChange, "no Save while nothing changed").toBe(0);
  expect(read.sheet.saveInBody, "Save is in the footer, not the scrolling body").toBe(false);
  expect(read.sheet.sheetShare, "the sheet takes at most 88 % of the height").toBeLessThanOrEqual(0.89);
  expect(read.save.height, "Save is at least 44 px").toBeGreaterThanOrEqual(44);
  expect(read.saveAboveKeyboard, "Save stays above the keyboard").toBe(true);
  expect(read.closeReturnsToSeatSheet, "the × returns to the seat sheet").toBe(true);
}, 300_000);


/*
 * The seat tick panel after critique items 1–7 and the maintainer picker
 * (#2396): the panel at 1440 (the popover) and at 390 (the sheet), light and
 * dark, English and Ukrainian, in the states the critique rendered. The
 * frames go to LLV_SEAT_TICK_SHOTS_DIR (default `.artifacts/seat-tick-shots`,
 * never committed) for a person to look at; the assertions are the geometry
 * and the claims that do not need a person:
 *
 *   - the status block is first and fits whole in the first screen, both
 *     surfaces (the critique's M1 and M2: maintenance was below the fold);
 *   - nothing overflows sideways and no text is clipped;
 *   - on the phone every control is at least 44 px (switches keep their 28 px
 *     track in a 44 px row);
 *   - one Save at most, absent until something changed;
 *   - the interval, Until and Reason follow the draft.
 *
 *   LLV_SEAT_TICK_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
 *     LLV_SEAT_TICK_SHOTS_DIR=… bun test src/components/orchestrator/issue1681Evidence.browser.test.tsx -t 2396
 */
const SHOTS = path.resolve(process.env.LLV_SEAT_TICK_SHOTS_DIR ?? ".artifacts/seat-tick-shots");

type Theme = "light" | "dark";
type Locale = "en" | "uk";

/** The states the critique rendered, by the fixture's query. `maint` is the
    maintenance reading; `tick` and `face` the wake reading. */
const PANEL_STATES = [
  { key: "default-never", query: "face=default&maint=never", about: "tick on its defaults, maintenance on and never run" },
  { key: "custom-done", query: "maint=ok", about: "tick every 30 min, maintenance done with 3 that need the operator" },
  { key: "off-off", query: "tick=off&maint=off", about: "tick off with a reason, maintenance off" },
  { key: "off-paused", query: "tick=off&maint=paused", about: "tick off, maintenance on and paused while wakes are off" },
  { key: "custom-failed", query: "maint=failed", about: "maintenance failed for lack of an account" },
  { key: "custom-running", query: "maint=running", about: "a maintenance run is live" },
  { key: "custom-held", query: "maint=held", about: "maintenance due, held while a deployment runs" },
  { key: "blocked-done", query: "tick=blocked&maint=ok", about: "wake blocked by an unresolved wake, named once" },
] as const;
type PanelState = typeof PANEL_STATES[number];

/** What a panel's first screen and whole content measure, read inside the page. */
function readPanel(scroller: HTMLElement) {
  const status = scroller.querySelector("[data-seat-tick-status]") as HTMLElement;
  const group = scroller.querySelector("[data-seat-tick-maintenance]") as HTMLElement;
  const top = scroller.getBoundingClientRect().top;
  const clipped = [...scroller.querySelectorAll("[data-seat-tick-status] span, [data-seat-tick-maintenance-row] span, [data-seat-tick-maintenance-about], button")]
    .filter((element) => (element as HTMLElement).scrollWidth > (element as HTMLElement).clientWidth + 1 && getComputedStyle(element).textOverflow === "ellipsis")
    .map((element) => element.textContent);
  const right = Math.max(...[...scroller.querySelectorAll("*")].map((element) => element.getBoundingClientRect().right));
  return {
    contentHeight: scroller.scrollHeight,
    visibleHeight: scroller.clientHeight,
    statusBottom: Math.round(status.getBoundingClientRect().bottom - top + scroller.scrollTop),
    groupTop: Math.round(group.getBoundingClientRect().top - top + scroller.scrollTop),
    saveCount: scroller.ownerDocument.querySelectorAll("[data-seat-tick-save]").length,
    intervalShown: scroller.querySelector("[data-seat-tick-interval]") !== null,
    untilShown: scroller.querySelector("[data-seat-tick-until]") !== null,
    reasonShown: scroller.querySelector("[data-seat-tick-reason]") !== null,
    maintenanceIntervalShown: scroller.querySelector("[data-seat-tick-maintenance-interval]") !== null,
    agentShown: scroller.querySelector("[data-seat-tick-agent]") !== null,
    statusText: status.textContent ?? "",
    contentRight: Math.round(right),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    clipped,
  };
}

async function panelDesktop(browser: Browser, base: string, theme: Theme, locale: Locale, state: PanelState) {
  const viewport = { width: 1440, height: 1600 };
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript((value) => window.localStorage.setItem("llv_lang", value), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?surface=desktop&dock=440&${state.query}`);
  await page.waitForSelector("[data-seat-tick-chip]");
  await page.click("[data-seat-tick-chip]");
  await page.waitForSelector("[data-seat-tick-maintenance]");
  await page.waitForTimeout(500);
  const popover = page.locator("[data-seat-tick-popover]");
  const measured = await popover.evaluate(readPanel);
  const capped = await popover.evaluate((element) => ({ maxHeight: getComputedStyle(element).maxHeight, height: element.getBoundingClientRect().height }));
  const tag = `${theme}-${locale}-${state.key}`;
  await popover.screenshot({ path: path.join(SHOTS, `desktop-1440-${tag}-popover-full.png`) });
  /* As it opens: the popover's own 70 vh cap, on a 900 px viewport. */
  if (state.key === "custom-done") {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `desktop-1440-${tag}-popover-as-opened.png`) });
  }
  await context.close();
  return { theme, locale, state: state.key, viewport, ...measured, capped, errors };
}

async function panelPhone(browser: Browser, base: string, theme: Theme, locale: Locale, state: PanelState) {
  const viewport = { width: 390, height: 2600 };
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: theme });
  await context.addInitScript((value) => window.localStorage.setItem("llv_lang", value), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?surface=phone&${state.query}`);
  await page.waitForSelector("[data-seat-tick-row]");
  await page.locator("[data-seat-tick-row]").click();
  await page.waitForSelector('[data-mobile2-sheet="tick"]');
  await page.waitForSelector("[data-seat-tick-maintenance]");
  await page.waitForTimeout(500);
  const sheet = page.locator('[data-mobile2-sheet="tick"]');
  const measured = await page.locator('[data-mobile2-sheet="tick"] [data-mobile2-sheet-body]').evaluate(readPanel);
  const targets = await page.evaluate(() => [...document.querySelectorAll('[data-mobile2-sheet="tick"] [data-mobile2-sheet-body] button, [data-mobile2-sheet="tick"] [data-mobile2-sheet-body] input, [data-mobile2-sheet="tick"] [data-mobile2-sheet-body] select, [data-mobile2-sheet="tick"] [data-mobile2-sheet-body] textarea, [data-mobile2-sheet="tick"] [data-mobile2-sheet-body] summary')]
    .filter((element) => !element.hasAttribute("role") || element.getAttribute("role") !== "switch")
    .map((element) => ({ name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30) ?? element.tagName, height: Math.round(element.getBoundingClientRect().height) }))
    .filter((entry) => entry.height < 44));
  const tag = `${theme}-${locale}-${state.key}`;
  await sheet.screenshot({ path: path.join(SHOTS, `phone-390-${tag}-sheet-full.png`) });
  /* As it opens: the real 844 px phone. */
  if (state.key === "custom-done") {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `phone-390-${tag}-sheet-as-opened.png`) });
  }
  await context.close();
  return { theme, locale, state: state.key, viewport, ...measured, smallTargets: targets, errors };
}

/** One edit in each group: the Save appears, and the maintainer's agent
    changes through its three selects. */
async function panelDirty(browser: Browser, base: string, theme: Theme, locale: Locale, surface: "desktop" | "phone") {
  const phone = surface === "phone";
  const viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 1100 };
  const context = await browser.newContext({ viewport, colorScheme: theme, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript((value) => window.localStorage.setItem("llv_lang", value), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?surface=${surface}&maint=ok`);
  if (phone) {
    await page.waitForSelector("[data-seat-tick-row]");
    await page.locator("[data-seat-tick-row]").click();
    await page.waitForSelector('[data-mobile2-sheet="tick"]');
  } else {
    await page.waitForSelector("[data-seat-tick-chip]");
    await page.click("[data-seat-tick-chip]");
  }
  await page.waitForSelector("[data-seat-tick-agent]");
  const before = await page.locator("[data-seat-tick-save]").count();
  await page.locator("[data-seat-tick-agent-model]").selectOption("gpt-6-luna");
  await page.locator("[data-seat-tick-agent-effort]").selectOption("high");
  await page.waitForSelector("[data-seat-tick-save]");
  const picker = await page.evaluate(() => ({
    engine: (document.querySelector("[data-seat-tick-agent-engine]") as HTMLSelectElement).value,
    model: (document.querySelector("[data-seat-tick-agent-model]") as HTMLSelectElement).value,
    efforts: [...document.querySelectorAll("[data-seat-tick-agent-effort] option")].map((option) => (option as HTMLOptionElement).value),
    about: document.querySelector("[data-seat-tick-maintenance-about]")?.textContent ?? "",
    saveCount: document.querySelectorAll("[data-seat-tick-save]").length,
  }));
  /* The maintenance group scrolled into view, with the Save beside it. */
  await page.locator("[data-seat-tick-agent]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${phone ? "phone-390" : "desktop-1440"}-${theme}-${locale}-agent-changed-save-shown.png`) });
  await context.close();
  return { surface, theme, locale, saveBefore: before, ...picker, errors };
}

browserTest("#2396 rendered: the seat tick panel at 1440 and 390, light and dark, English and Ukrainian", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const build = await Bun.build({
    entrypoints: [path.resolve("src/components/orchestrator/issue1681Evidence.fixture.tsx")],
    target: "browser",
    plugins: [serverActionBoundary],
    outdir: path.join(OUT, "bundle-2396"),
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
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const base = `http://127.0.0.1:${server.port}`;
  const desktops: Awaited<ReturnType<typeof panelDesktop>>[] = [];
  const phones: Awaited<ReturnType<typeof panelPhone>>[] = [];
  const dirty: Awaited<ReturnType<typeof panelDirty>>[] = [];
  try {
    for (const theme of ["light", "dark"] as const) {
      for (const locale of ["en", "uk"] as const) {
        for (const state of PANEL_STATES) {
          desktops.push(await panelDesktop(browser, base, theme, locale, state));
          phones.push(await panelPhone(browser, base, theme, locale, state));
        }
        dirty.push(await panelDirty(browser, base, theme, locale, "desktop"));
        dirty.push(await panelDirty(browser, base, theme, locale, "phone"));
      }
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  fs.writeFileSync(path.join(SHOTS, "geometry.json"), `${JSON.stringify({ desktops, phones, dirty }, null, 2)}\n`);

  const expectedMaintenance: Record<PanelState["key"], string> = {
    "default-never": "on", "custom-done": "on", "off-off": "off", "off-paused": "on", "custom-failed": "on", "custom-running": "running", "custom-held": "on", "blocked-done": "on",
  };
  for (const read of desktops) {
    const key = `desktop ${read.theme} ${read.locale} ${read.state}`;
    expect(read.errors, `${key} page errors`).toEqual([]);
    expect(read.pageOverflow, `${key} sideways overflow`).toBe(false);
    expect(read.clipped, `${key} clipped text`).toEqual([]);
    expect(read.contentRight, `${key} content inside the viewport`).toBeLessThanOrEqual(read.viewport.width);
    /* The popover's own cap is 70 vh of the viewport it opens in; the status
       block must end inside the first 630 px of a 900 px window, which is the
       critique's M1. */
    expect(read.statusBottom, `${key} status block inside the first screen`).toBeLessThanOrEqual(630);
    expect(read.saveCount, `${key} no Save while nothing changed`).toBe(0);
    expect(read.statusText, `${key} status names maintenance`).toContain(read.locale === "en" ? "Maintenance" : "Обслуговування");
  }
  for (const read of phones) {
    const key = `phone ${read.theme} ${read.locale} ${read.state}`;
    expect(read.errors, `${key} page errors`).toEqual([]);
    expect(read.pageOverflow, `${key} sideways overflow`).toBe(false);
    expect(read.contentRight, `${key} content inside the phone`).toBeLessThanOrEqual(read.viewport.width);
    expect(read.clipped, `${key} clipped text`).toEqual([]);
    /* The critique's M2: the sheet's body is 621 px on a 844 px phone, and
       the status block has to end inside it. */
    expect(read.statusBottom, `${key} status block inside the first screen`).toBeLessThanOrEqual(621);
    expect(read.smallTargets, `${key} controls under 44 px`).toEqual([]);
    expect(read.saveCount, `${key} no Save while nothing changed`).toBe(0);
  }
  /* The fields follow the draft: the defaults show no Until and no Reason, an
     off tick shows no interval, and maintenance off shows no interval. */
  const find = <T extends { theme: string; locale: string; state: string }>(rows: T[], theme: Theme, locale: Locale, state: string) =>
    rows.find((row) => row.theme === theme && row.locale === locale && row.state === state)!;
  for (const rows of [desktops, phones] as const) {
    const defaults = find(rows as never[], "light", "en", "default-never") as (typeof desktops)[number];
    expect([defaults.intervalShown, defaults.untilShown, defaults.reasonShown]).toEqual([true, false, false]);
    const custom = find(rows as never[], "light", "en", "custom-done") as (typeof desktops)[number];
    expect([custom.intervalShown, custom.untilShown, custom.reasonShown, custom.maintenanceIntervalShown]).toEqual([true, true, true, true]);
    const off = find(rows as never[], "light", "en", "off-off") as (typeof desktops)[number];
    expect([off.intervalShown, off.untilShown, off.reasonShown, off.maintenanceIntervalShown]).toEqual([false, true, true, false]);
    for (const read of rows as (typeof desktops)[number][]) expect(read.agentShown, `${read.state} the maintainer's agent is offered`).toBe(true);
  }
  void expectedMaintenance;
  for (const read of dirty) {
    const key = `${read.surface} ${read.theme} ${read.locale} agent change`;
    expect(read.errors, `${key} page errors`).toEqual([]);
    expect(read.saveBefore, `${key} no Save before the change`).toBe(0);
    expect(read.saveCount, `${key} one Save after it`).toBe(1);
    expect([read.engine, read.model], `${key} the picked runtime`).toEqual(["codex", "gpt-6-luna"]);
    /* Luna's own ladder: no `ultra`. */
    expect(read.efforts, `${key} the model's own ladder`).toEqual(["low", "medium", "high", "xhigh", "max"]);
  }
}, 900_000);


browserTest("context auto-rotation rendered in the shared tick panel, English and Ukrainian, light and dark", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const build = await Bun.build({
    entrypoints: [path.resolve("src/components/orchestrator/issue1681Evidence.fixture.tsx")],
    target: "browser",
    plugins: [serverActionBoundary],
    outdir: path.join(OUT, "bundle-auto-rotation"),
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
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });

  const base = `http://127.0.0.1:${server.port}`;
  const readings: unknown[] = [];
  try {
    for (const theme of ["light", "dark"] as const) for (const locale of ["en", "uk"] as const) {
      for (const layout of [{ width: 1440, height: 900, dock: 440, surface: "desktop" }, { width: 640, height: 600, dock: 360, surface: "desktop" }, { width: 390, height: 844, dock: 0, surface: "phone" }]) {
        const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, colorScheme: theme });
        try {
          const page = await context.newPage();
          await page.addInitScript(language => localStorage.setItem("llv_lang", language), locale);
          const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
          await page.goto(`${base}/?surface=${layout.surface}&dock=${layout.dock}&locale=${locale}&autoRotate=failed&face=default`);
          const phone = layout.surface === "phone";
          await page.waitForSelector(phone ? "[data-seat-tick-row]" : "[data-seat-tick-chip]");
          await page.click(phone ? '[data-mobile2-open="tick"]' : "[data-seat-tick-chip]");
          await page.waitForSelector("[data-seat-tick-auto-rotate-threshold]");
          expect(await page.locator("[data-seat-tick-auto-rotate-enabled]").getAttribute("aria-checked")).toBe("true");
          // The failure line speaks the operator's language and keeps the engine's error out.
          const failed = await page.locator("[data-seat-tick-auto-rotate-failed]").innerText();
          expect(failed).not.toContain("fixture launch refused");
          expect(failed).toContain(locale === "en" ? "did not replace the orchestrator; the current one keeps working. Next try after" : "не замінила оркестратора, поточний працює далі. Наступна — після");
          expect((await page.locator("[data-seat-tick-auto-rotate]").innerText()).toLowerCase()).toContain(translate(locale, "seatTick.autoRotate.head").toLowerCase());
          expect(await page.locator("[data-seat-tick-auto-rotate-about]").innerText()).toBe(translate(locale, "seatTick.autoRotate.about"));
          expect(await page.locator("[data-seat-tick-auto-rotate] label").innerText()).toBe(translate(locale, "seatTick.autoRotate.thresholdLabel"));
          await page.locator("[data-seat-tick-auto-rotate-threshold]").fill("65");
          await page.locator("[data-seat-tick-auto-rotate]").scrollIntoViewIfNeeded();
          await page.locator("[data-seat-tick-save]").scrollIntoViewIfNeeded();
          await page.evaluate(() => {
            const caption = document.querySelector("[data-seat-tick-auto-rotate-failed]")!;
            const save = document.querySelector("[data-seat-tick-save]")!;
            for (let parent = caption.parentElement; parent; parent = parent.parentElement) {
              if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
                parent.scrollTop += Math.max(0, caption.getBoundingClientRect().bottom - save.getBoundingClientRect().top + 8);
                break;
              }
            }
          });
          const geometry = await page.evaluate(() => {
            const host = document.querySelector("[data-seat-tick-popover]") ?? document.querySelector('[data-mobile2-sheet="tick"]')!;
            const hostBox = host.getBoundingClientRect();
            const save = document.querySelector("[data-seat-tick-save]")!.getBoundingClientRect();
            const clipped: string[] = [];
            for (const selector of ["[data-seat-tick-auto-rotate-enabled]", "[data-seat-tick-auto-rotate-about]", "[data-seat-tick-auto-rotate-threshold]", "[data-seat-tick-auto-rotate-failed]", "[data-seat-tick-save]"]) {
              const control = document.querySelector(selector)!;
              const box = control.getBoundingClientRect();
              if (box.left < hostBox.left - 1 || box.right > hostBox.right + 1 || box.left < -1 || box.right > innerWidth + 1
                || box.top < hostBox.top - 1 || box.bottom > (selector.includes("save") ? innerHeight : save.top) + 1) clipped.push(selector);
            }
            return { overflow: host.scrollWidth > host.clientWidth, clipped, saveReachable: save.top >= 0 && save.bottom <= innerHeight, width: hostBox.width };
          });
          expect(errors).toEqual([]); expect(geometry.overflow).toBe(false); expect(geometry.clipped).toEqual([]); expect(geometry.saveReachable).toBe(true);
          await page.screenshot({ path: path.join(OUT, `auto-rotation-${theme}-${locale}-${layout.width}.png`) });
          readings.push({ theme, locale, viewport: layout, ...geometry });
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); server.stop(true); }
  fs.writeFileSync(path.join(EVIDENCE, "auto-rotation.json"), `${JSON.stringify(readings, null, 2)}\n`);
}, 360_000);


browserTest("automatic releases rendered in the shared tick panel, English and Ukrainian, light and dark", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const build = await Bun.build({
    entrypoints: [path.resolve("src/components/orchestrator/issue1681Evidence.fixture.tsx")],
    target: "browser",
    plugins: [serverActionBoundary],
    outdir: path.join(OUT, "bundle-release"),
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
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });

  const base = `http://127.0.0.1:${server.port}`;
  const readings: unknown[] = [];
  try {
    for (const theme of ["light", "dark"] as const) for (const locale of ["en", "uk"] as const) {
      for (const layout of [{ width: 1440, height: 900, dock: 440, surface: "desktop" }, { width: 390, height: 844, dock: 0, surface: "phone" }]) {
        const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, colorScheme: theme });
        try {
          const page = await context.newPage();
          await page.addInitScript(language => localStorage.setItem("llv_lang", language), locale);
          const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
          await page.goto(`${base}/?surface=${layout.surface}&dock=${layout.dock}&locale=${locale}&release=blocked&face=default`);
          const phone = layout.surface === "phone";
          await page.waitForSelector(phone ? "[data-seat-tick-row]" : "[data-seat-tick-chip]");
          await page.click(phone ? '[data-mobile2-open="tick"]' : "[data-seat-tick-chip]");
          await page.waitForSelector("[data-seat-tick-release]");
          expect(await page.locator("[data-seat-tick-release-enabled]").getAttribute("aria-checked")).toBe("true");
          expect(await page.locator("[data-seat-tick-release-ask]").isChecked()).toBe(true);
          await page.locator("[data-seat-tick-release-enabled]").click();
          expect(await page.locator("[data-seat-tick-release-enabled]").getAttribute("aria-checked")).toBe("false");
          await page.locator("[data-seat-tick-release-enabled]").click();
          expect(await page.locator("[data-seat-tick-release-enabled]").getAttribute("aria-checked")).toBe("true");
          expect(await page.locator("[data-seat-tick-release-reason]").innerText()).toBe(translate(locale, "seatTick.release.wait.tools"));
          await page.locator('[data-seat-tick-release-field=changes]').fill("31");
          await page.locator('[data-seat-tick-release-field="hours"]').fill("13");
          await page.locator("[data-seat-tick-release]").scrollIntoViewIfNeeded();
          await page.locator("[data-seat-tick-save]").scrollIntoViewIfNeeded();
          await page.evaluate(() => {
            const caption = document.querySelector("[data-seat-tick-release-clear]")!;
            const save = document.querySelector("[data-seat-tick-save]")!;
            for (let parent = caption.parentElement; parent; parent = parent.parentElement) {
              if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
                parent.scrollTop += Math.max(0, caption.getBoundingClientRect().bottom - save.getBoundingClientRect().top + 8);
                break;
              }
            }
          });
          const geometry = await page.evaluate(() => {
            const host = document.querySelector("[data-seat-tick-popover]") ?? document.querySelector('[data-mobile2-sheet="tick"]')!;
            const hostBox = host.getBoundingClientRect();
            const save = document.querySelector("[data-seat-tick-save]")!.getBoundingClientRect();
            const clipped: string[] = [];
            for (const selector of ["[data-seat-tick-release-enabled]", "[data-seat-tick-release-ask]", "[data-seat-tick-release-field=changes]", "[data-seat-tick-release-reason]", "[data-seat-tick-release-field=hours]", "[data-seat-tick-release-clear]", "[data-seat-tick-save]"]) {
              const control = document.querySelector(selector)!;
              const box = control.getBoundingClientRect();
              if (box.left < hostBox.left - 1 || box.right > hostBox.right + 1 || box.left < -1 || box.right > innerWidth + 1
                || box.top < hostBox.top - 1 || box.bottom > (selector.includes("save") ? innerHeight : save.top) + 1) clipped.push(selector);
            }
            return { overflow: host.scrollWidth > host.clientWidth, clipped, saveReachable: save.top >= 0 && save.bottom <= innerHeight, width: hostBox.width };
          });
          expect(errors).toEqual([]); expect(geometry.overflow).toBe(false); expect(geometry.clipped).toEqual([]); expect(geometry.saveReachable).toBe(true);
          await page.screenshot({ path: path.join(OUT, `release-${theme}-${locale}-${layout.width}.png`) });
          readings.push({ theme, locale, viewport: layout, ...geometry });
          await page.goto(`${base}/?surface=${layout.surface}&dock=${layout.dock}&locale=${locale}&release=unknown&face=default`);
          await page.waitForSelector(phone ? "[data-seat-tick-row]" : "[data-seat-tick-chip]");
          await page.click(phone ? '[data-mobile2-open="tick"]' : "[data-seat-tick-chip]");
          await page.waitForSelector("[data-seat-tick-release]");
          expect(await page.locator("[data-seat-tick-release-reason]").count()).toBe(0);
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); server.stop(true); }
  fs.writeFileSync(path.join(EVIDENCE, "release.json"), `${JSON.stringify(readings, null, 2)}\n`);
}, 360_000);
