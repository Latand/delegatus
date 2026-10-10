/*
 * Renders the built landing (landing/site/dist/) for review:
 *
 *   bun landing/site/build.ts && CHROME_BIN=/usr/bin/google-chrome-stable bun landing/site/capture.ts
 *
 * At 1440×900 and 390×844, in English and Ukrainian: the full page, the first
 * screen, each section, the hero's demo held at each of its six steps, the
 * other views of each frame, and the legacy-install joke. PNGs go to
 * LANDING_RENDER_DIR (default ~/Pictures/delegatus-review/landing/final/),
 * which is never committed. Page errors and requests the frames left
 * unanswered are written beside them in report.json.
 *
 * `--only=en-1440` limits the run to one language and width.
 * `--scheme=light` asks the browser for a light colour scheme (default dark).
 * The page and its demo pin dark, so this shows they hold under either.
 *
 * `--check-fullscreen` puts each demo frame full screen through its control, in
 * both languages, portrait and landscape phone sizes and a touch tablet, once with the browser's Fullscreen API and once
 * as the overlay iPhone Safari gets. It asserts the frame's layout and scale, that the
 * control clears the product's own controls, that Esc and the control leave,
 * and that the page's scroll position comes back; PNGs go to
 * LANDING_RENDER_DIR (default /tmp/landing-fullscreen-renders/).
 *
 * `--check-prompt` expands both install prompts (Claude Code and Codex) in the
 * hero and the footer, in both languages and widths, and fails unless the
 * whole prompt can be read: nothing in it is clipped by the prompt or by an
 * ancestor, and its last line sits inside the page. PNGs go to
 * LANDING_RENDER_DIR.
 *
 * `--check-conversation` opens the «A conversation» frame at 1440 in both
 * languages and fails unless the agent window fills the frame and its reader
 * wears the plain border, without the role ribbon or a focus ring nobody asked for.
 *
 * `--check-demo` measures the hero's demo: one full loop at 1440×900 and
 * 390×844 under a 4× CPU throttle, traced, with the frames Chrome presented
 * and dropped and every main-thread task over 50 ms; the cold load (LCP and
 * bytes transferred) of this build and, with LANDING_BEFORE_DIR, of another
 * build on the same driver; that the demo waits off screen and in a hidden
 * tab, scrolled on with 40% of it showing, and stands still under reduced
 * motion; that it plays with no scroll on a 1440×900 and a 1440×780 first
 * screen, where at 1440×900 the typed request, the steps and some caption
 * stay in view all loop; that its pointer never crosses the stage's edge; and, unthrottled,
 * a frame every half second and a screen recording of one loop at both widths. It fails on a
 * long task during the loop, on more than 1% dropped frames, or on a demo that
 * moves when it should not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Frame, type Page } from "playwright-core";

import { type Locale } from "@/lib/i18n";

import worker, { type DataPoint } from "../worker";

type PerfRecord = {
  type: string;
  view?: string;
  results?: number;
  phone?: boolean;
  screen?: string;
  data?: { type?: string };
};
type PerfWindow = Window & {
  perfRecords: PerfRecord[];
  restoreSearch(): void;
};
/* What boardDemo.js exposes for this driver. */
declare global {
  interface Window {
    DLG: { demo: { loop: number; steps: number[]; hold: number; now(): number; seek(at: number): void; release(): void } };
  }
}

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = process.env.LANDING_DIST_DIR ?? path.join(here, "dist");
const out = process.env.LANDING_RENDER_DIR ?? path.join(os.homedir(), "Pictures/delegatus-review/landing/final");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length) ?? null;
const colorScheme = process.argv.find((arg) => arg.startsWith("--scheme="))?.slice("--scheme=".length) === "light" ? "light" : "dark";
const fullscreenCheck = process.argv.includes("--check-fullscreen");
const eventsCheck = process.argv.includes("--check-events");
const promptCheck = process.argv.includes("--check-prompt");
const eventPoints: DataPoint[] = [];
const eventBodies: unknown[] = [];
const swipeCheck = process.argv.find((arg) => arg.startsWith("--check-swipe="))?.slice("--check-swipe=".length);
if (!fs.existsSync(path.join(dist, "demo/demo.js"))) throw new Error("landing/site/dist is not built: run bun landing/site/build.ts first");
fs.mkdirSync(out, { recursive: true });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      if (eventsCheck) eventBodies.push(await request.clone().json());
      return worker.fetch(request, {
        INSTALLS: { writeDataPoint: () => { throw new Error("Install pings do not belong in landing captures"); } },
        SITE_EVENTS: { writeDataPoint: (point) => { eventPoints.push(point); } },
        ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
      });
    }
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = Bun.file(path.join(dist, path.normalize(pathname)));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const base = process.env.LANDING_URL ?? `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable" });
const report: Record<string, unknown> = {};

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, phone: false },
  { name: "390", width: 390, height: 844, phone: true },
] as const;

const settle = (page: Page, ms: number) => page.waitForTimeout(ms);

async function frameOf(page: Page, selector: string): Promise<Frame> {
  await page.waitForFunction(selector => !document.querySelector(`${selector}[data-busy]`), selector, { timeout: 30_000 });
  if (await page.locator(`${selector} .demo-retry`).count()) throw new Error(`navigation failed in ${selector}`);
  const handle = await page.locator(`${selector} iframe`).last().elementHandle({ timeout: 20_000 });
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no frame in ${selector}`);
  await page.waitForSelector(`${selector}[data-loaded]`, { timeout: 30_000 });
  return frame;
}

async function shoot(page: Page, selector: string, file: string) {
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  await settle(page, 300);
  await element.screenshot({ path: path.join(out, file) });
}

/* The install prompts, expanded: every line has to be readable, so the last
   step the agent is told to take is not cut off by the prompt's own box or by
   anything around it. */
async function checkPromptExpansion(lang: Locale, viewport: (typeof VIEWPORTS)[number]): Promise<string[]> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, colorScheme,
    ...(viewport.phone ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  const failures: string[] = [];
  await page.goto(`${base}?lang=${lang}`);
  for (const slot of ["hero", "footer"]) {
    for (const agent of ["claude", "codex"]) {
      const label = `${lang}-${viewport.name} ${slot} ${agent}`;
      const root = `[data-install="${slot}"]`;
      await page.locator(`${root} [role="tab"][data-agent="${agent}"]`).scrollIntoViewIfNeeded();
      await page.locator(`${root} [role="tab"][data-agent="${agent}"]`).click();
      if (await page.locator(`${root} .prompt`).getAttribute("data-open") !== "true") await page.locator(`${root} .prompt-more`).click();
      await settle(page, 700);
      const seen = await page.evaluate(({ root, agent, lang }) => {
        const pre = document.querySelector<HTMLElement>(`${root} .prompt pre`)!;
        const expected = (window as unknown as { DLG: { copy: { prompt: (agent: string, lang: string) => string } } }).DLG.copy.prompt(agent, lang);
        const lastLine = expected.trim().split("\n").pop()!.trim();
        const shown = (pre.textContent ?? "").trim();
        const range = document.createRange();
        range.selectNodeContents(pre);
        const rects = [...range.getClientRects()].filter((rect) => rect.height > 0);
        const inkBottom = Math.max(...rects.map((rect) => rect.bottom));
        /* The lowest edge any ancestor that clips its content leaves visible. */
        let visibleBottom = Infinity;
        for (let el: HTMLElement | null = pre; el; el = el.parentElement) {
          const overflowY = getComputedStyle(el).overflowY;
          if (overflowY !== "visible") visibleBottom = Math.min(visibleBottom, el.getBoundingClientRect().bottom);
        }
        return {
          complete: shown.endsWith(lastLine), lastLine,
          innerClipped: pre.scrollHeight - pre.clientHeight,
          ancestorClipped: Math.round(inkBottom - visibleBottom),
        };
      }, { root, agent, lang });
      if (!seen.complete) failures.push(`${label}: the prompt does not end with its last line ${JSON.stringify(seen.lastLine)}`);
      if (seen.innerClipped > 1) failures.push(`${label}: the prompt box hides ${seen.innerClipped}px of the prompt`);
      if (seen.ancestorClipped > 1) failures.push(`${label}: a container hides ${seen.ancestorClipped}px of the prompt`);
      await page.locator(`${root} .prompt`).screenshot({ path: path.join(out, `prompt-${label.replaceAll(" ", "-")}.png`) });
      await page.locator(`${root} .prompt-more`).click();
    }
  }
  await context.close();
  return failures;
}

/* A compositor touch gesture, aimed at the same visible surface a visitor touches.
   "before" records the published or unchanged build; "after" also asserts that
   the outer page moves in the finger's expected direction. */
async function checkSwipe() {
  if (swipeCheck !== "before" && swipeCheck !== "after") throw new Error("use --check-swipe=before or --check-swipe=after");
  const rows: { lang: Locale; surface: string; direction: string; before: number; after: number; delta: number; available: number }[] = [];
  const surfaces = [
    ["install-prompt", '.hero [data-install="hero"] .prompt pre'],
    ["hero-board", ".hero .demo"],
    ["open-composer", ".live-open iframe"],
    ["run-demo", ".live-run iframe"],
    ["open-demo", ".live-open iframe"],
    ["phone-demo", ".live-phone iframe"],
    ["plain-text", ".sec-run .sec-head h2"],
  ] as const;
  for (const lang of ["en", "uk"] as Locale[]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(`${base}?lang=${lang}`);
    for (const [surface, selector] of surfaces) {
      if (surface.endsWith("demo") || surface === "open-composer") {
        await page.locator(selector.replace(" iframe", "")).scrollIntoViewIfNeeded();
        await frameOf(page, selector.replace(" iframe", ""));
      }
      for (const direction of ["down", "up"] as const) {
        if (swipeCheck === "after" && (surface.endsWith("demo") || surface === "open-composer")) {
          const frame = await frameOf(page, selector.replace(" iframe", ""));
          await frame.evaluate((direction) => {
            for (const node of document.querySelectorAll<HTMLElement>("*")) {
              if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) {
                node.scrollTop = direction === "down" ? node.scrollHeight : 0;
              }
            }
          }, direction);
        }
        const element = page.locator(selector).first();
        await element.scrollIntoViewIfNeeded();
        let point = await page.evaluate((selector) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          const max = document.documentElement.scrollHeight - innerHeight;
          const center = rect.top + Math.min(rect.height, 520) / 2;
          scrollTo(0, Math.max(0, Math.min(max, scrollY + center - 420)));
          const positioned = document.querySelector(selector)!.getBoundingClientRect();
          return { x: Math.round(positioned.left + positioned.width / 2), y: Math.round(Math.max(positioned.top + 12, Math.min(positioned.bottom - 12, 420))) };
        }, selector);
        if (surface === "open-composer") {
          const field = (await frameOf(page, ".live-open")).locator("textarea").first();
          await field.waitFor({ state: "visible" });
          let rect = await field.boundingBox();
          if (!rect) throw new Error("conversation composer has no box");
          await page.evaluate((dy) => scrollBy(0, dy), rect.y + rect.height / 2 - 420);
          rect = await field.boundingBox();
          if (!rect) throw new Error("conversation composer moved out of view");
          point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
        await settle(page, 250);
        const { before, available } = await page.evaluate((direction) => ({ before: scrollY, available: direction === "down" ? document.documentElement.scrollHeight - innerHeight - scrollY : scrollY }), direction);
        const travel = direction === "down" ? -300 : 300;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        for (let step = 1; step <= 12; step += 1) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y + Math.round(travel * step / 12), id: 1 }] });
          await settle(page, 16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await settle(page, 450);
        const after = await page.evaluate(() => scrollY);
        rows.push({ lang, surface, direction, before, after, delta: after - before, available });
      }
    }
    if (swipeCheck === "after") {
      await page.locator(".live-open").scrollIntoViewIfNeeded();
      const open = await frameOf(page, ".live-open");
      const composer = open.locator("textarea").first();
      await composer.fill("A visitor can still type in this field");
      if (await composer.inputValue() !== "A visitor can still type in this field") throw new Error(`${lang}: composer did not accept typing`);

      // A short flick must keep moving after release, unlike an immediate scrollBy.
      await page.locator(".live-run").scrollIntoViewIfNeeded();
      const run = await frameOf(page, ".live-run");
      await run.evaluate(() => {
        for (const node of document.querySelectorAll<HTMLElement>("*")) {
          if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
        }
      });
      const runBox = await page.locator(".live-run iframe").boundingBox();
      if (!runBox) throw new Error("run frame has no box");
      const flickX = Math.round(runBox.x + runBox.width / 2);
      const flickY = Math.round(runBox.y + Math.min(runBox.height / 2, 400));
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: flickX, y: flickY, id: 2 }] });
      for (let step = 1; step <= 4; step += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: flickX, y: flickY - step * 40, id: 2 }] });
        await settle(page, 10);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await settle(page, 25);
      const atRelease = await page.evaluate(() => scrollY);
      await settle(page, 300);
      const afterCoast = await page.evaluate(() => scrollY);
      console.log(`${lang} run-frame flick coast: ${atRelease} -> ${afterCoast} (${afterCoast - atRelease})`);
      if (afterCoast - atRelease < 40) throw new Error(`${lang}: run-frame flick stopped without momentum`);

      // A new gesture on the landing must take over from a forwarded iframe flick.
      for (const interruption of ["touch", "wheel"] as const) {
        await page.locator(".live-run").scrollIntoViewIfNeeded();
        const box = await page.locator(".live-run iframe").boundingBox();
        if (!box) throw new Error("run frame has no box");
        const x = Math.round(box.x + box.width / 2);
        const y = Math.round(box.y + Math.min(box.height / 2, 400));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 4 }] });
        for (let step = 1; step <= 4; step += 1) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 40, id: 4 }] });
          await settle(page, 10);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        const releasePosition = await page.evaluate(() => scrollY);
        await settle(page, 25);
        const coastPosition = await page.evaluate(() => scrollY);
        if (coastPosition - releasePosition < 2) throw new Error(`${lang}: ${interruption} probe had no active flick to interrupt`);
        if (interruption === "touch") {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 8, y: 8, id: 5 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 8, y: 8, deltaX: 0, deltaY: 0 });
        }
        await settle(page, 25);
        const interruptedAt = await page.evaluate(() => scrollY);
        await settle(page, 250);
        const afterInterruption = await page.evaluate(() => scrollY);
        console.log(`${lang} ${interruption} stopped flick: ${interruptedAt} -> ${afterInterruption}`);
        if (Math.abs(afterInterruption - interruptedAt) > 5) throw new Error(`${lang}: ${interruption} did not stop iframe flick`);
      }

      // A long draft still scrolls inside its textarea until it reaches an edge.
      await composer.fill(Array.from({ length: 30 }, (_, index) => `Draft line ${index + 1}`).join("\n"));
      const draftSize = await composer.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
      if (draftSize.scrollHeight <= draftSize.height + 40) throw new Error(`${lang}: long composer draft did not overflow`);
      await composer.evaluate((element) => { element.scrollTop = 0; });
      await composer.scrollIntoViewIfNeeded();
      const composerBox = await composer.boundingBox();
      if (!composerBox) throw new Error("composer has no box");
      const draftX = Math.round(composerBox.x + composerBox.width / 2);
      const draftY = Math.round(composerBox.y + composerBox.height / 2);
      const pageBeforeDraft = await page.evaluate(() => scrollY);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: draftX, y: draftY, id: 3 }] });
      for (let step = 1; step <= 4; step += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: draftX, y: draftY - step * 25, id: 3 }] });
        await settle(page, 20);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await settle(page, 200);
      const draftScroll = await composer.evaluate((element) => element.scrollTop);
      const pageAfterDraft = await page.evaluate(() => scrollY);
      console.log(`${lang} long draft scroll: inner ${draftScroll}, page ${pageAfterDraft - pageBeforeDraft}`);
      if (draftScroll < 40 || Math.abs(pageAfterDraft - pageBeforeDraft) > 20) throw new Error(`${lang}: long composer draft did not retain inner scrolling`);

      const phone = await frameOf(page, ".live-phone");
      const columns = phone.locator(".snap-x").first();
      await columns.scrollIntoViewIfNeeded();
      await phone.locator("[data-phone-kanban-tab]").nth(1).click();
      await settle(page, 300);
      const horizontal = await columns.evaluate((element) => element.scrollLeft);
      console.log(`${lang} phone tab navigation: scrollLeft ${horizontal}`);
      if (horizontal < 300) throw new Error(`${lang}: phone tab navigation did not move`);
    }
    await context.close();
  }
  fs.writeFileSync(path.join(out, `swipe-${swipeCheck}.json`), `${JSON.stringify({ url: base, viewport: "390x844 touch DPR3", rows }, null, 2)}\n`);
  for (const row of rows) console.log(`${row.lang} ${row.surface} ${row.direction}: ${row.before} -> ${row.after} (${row.delta})`);
  if (swipeCheck === "after") {
    const failed = rows.filter((row) => {
      const control = rows.find((candidate) => candidate.lang === row.lang && candidate.surface === "plain-text" && candidate.direction === row.direction)!;
      const required = Math.min(300, Math.abs(control.delta), row.available) * 0.8;
      return Math.abs(row.delta) < required || Math.sign(row.delta) !== Math.sign(control.delta);
    });
    if (failed.length) throw new Error(`outer page moved less than 80% of the plain-text control for ${failed.map((row) => `${row.lang}/${row.surface}/${row.direction}`).join(", ")}`);
  }
}


/* Each frame full screen: the size the product runs at, the control's place,
   the way out, and the page where the visitor left it. */
async function checkFullscreen() {
  const dir = process.env.LANDING_RENDER_DIR ?? "/tmp/landing-fullscreen-renders";
  fs.mkdirSync(dir, { recursive: true });
  const frames = [["run", ".live-run"], ["open", ".live-open"], ["phone", ".live-phone"]] as const;
  const LABELS = { en: { enter: "Full screen", exit: "Exit full screen" }, uk: { enter: "На весь екран", exit: "Вийти з повного екрана" } };
  const failures: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const modeOnly = process.argv.find((arg) => arg.startsWith("--fs-mode="))?.slice("--fs-mode=".length);
  for (const mode of ["native", "overlay"] as const) {
    if (modeOnly && modeOnly !== mode) continue;
    for (const lang of ["en", "uk"] as Locale[]) {
      for (const viewport of [
        ...VIEWPORTS,
        { name: "844-landscape", width: 844, height: 390, phone: true },
        { name: "390-short", width: 390, height: 480, phone: true },
        { name: "1024-tablet", width: 1024, height: 768, phone: false, tablet: true },
      ]) {
        const touch = viewport.phone || "tablet" in viewport;
        if (only && only !== `${lang}-${viewport.name}`) continue;
        /* iPad Safari has element fullscreen, so a tablet never gets the overlay. */
        if ("tablet" in viewport && mode === "overlay") continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, colorScheme,
          ...(touch ? { hasTouch: true, isMobile: true } : {}),
        });
        /* iPhone Safari has no element fullscreen: the page must run without the API. */
        if (mode === "overlay") await context.addInitScript(() => {
          for (const name of ["requestFullscreen", "webkitRequestFullscreen"]) Object.defineProperty(Element.prototype, name, { value: undefined, configurable: true });
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}?lang=${lang}`);
        for (const [name, selector] of frames) {
          const key = `${mode}-${lang}-${viewport.name}-${name}`;
          const fail = (why: string) => failures.push(`${key}: ${why}`);
          await page.locator(selector).scrollIntoViewIfNeeded();
          await frameOf(page, selector);
          await settle(page, 1200);
          const button = page.locator(`${selector} > .fs-btn, .stage-wrap:has(> ${selector}) > .fs-btn`);
          /* Where the page stood, and what the frame looked like, before. */
          await page.evaluate((top) => window.scrollTo(0, top), (await page.evaluate(() => scrollY)) + 37);
          await button.scrollIntoViewIfNeeded();
          await settle(page, 200);
          const measure = (selector: string) => page.evaluate((selector) => {
            const live = document.querySelector<HTMLElement>(selector)!;
            const iframe = live.querySelector<HTMLIFrameElement>("iframe")!;
            const rect = iframe.getBoundingClientRect();
            const host = live.querySelector<HTMLElement>(".live-frame")!;
            const btn = (live.closest(".stage-wrap") ?? live).querySelector<HTMLElement>(":scope > .fs-btn, :scope > .live-frame ~ .fs-btn")!;
            const b = btn.getBoundingClientRect();
            /* The product's own controls, in page coordinates. */
            const doc = iframe.contentDocument!;
            const k = rect.width / iframe.offsetWidth;
            const hits = [...doc.querySelectorAll<HTMLElement>("button, a[href], input, textarea, [role=button], [role=tab]")].filter((el) => {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return false;
              const left = rect.left + r.left * k, top = rect.top + r.top * k, right = left + r.width * k, bottom = top + r.height * k;
              /* Only what a visitor can see: not clipped away by the frame. */
              return left < b.right && right > b.left && top < b.bottom && bottom > b.top
                && right > host.getBoundingClientRect().left && left < host.getBoundingClientRect().right
                && bottom > host.getBoundingClientRect().top && top < host.getBoundingClientRect().bottom;
            }).map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 20) ?? el.tagName);
            return {
              scrollY, src: iframe.src, layout: `${iframe.offsetWidth}x${iframe.offsetHeight}`, transform: getComputedStyle(iframe).transform,
              phone: live.dataset.mode === "phone", fixed: live.hasAttribute("data-fixed"), expectedPhone: `${live.dataset.pw}x${live.dataset.ph}`,
              bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
              hostBounds: (() => { const r = host.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })(),
              radius: getComputedStyle(iframe).borderRadius,
              viewport: `${innerWidth}x${innerHeight}`, host: `${host.clientWidth}x${host.clientHeight}`,
              label: btn.getAttribute("aria-label"), button: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
              covers: hits, native: Boolean(document.fullscreenElement), full: live.closest("[data-fs]") !== null,
              rootBox: (() => { const r = (live.closest(".stage-wrap") ?? live).getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
              chrome: (() => { const r = (live.closest(".stage-wrap") ?? live).getBoundingClientRect(); return Math.round(r.height - host.clientHeight); })(),
            };
          }, selector);
          const before = await measure(selector);
          if (before.covers.length) fail(`control covers ${before.covers.join(", ")} before full screen`);
          if (mode === "native") await page.screenshot({ path: path.join(dir, `${lang}-${viewport.name}-${name}-page.png`) });
          const handle = await page.locator(`${selector} iframe`).last().elementHandle();
          await button.click();
          await settle(page, 700);
          const inside = await measure(selector);
          const [vw, vh] = inside.viewport.split("x").map(Number);
          const [lw, lh] = inside.layout.split("x").map(Number);
          const [hw, hh] = inside.host.split("x").map(Number);
          if (!inside.full) fail("root did not enter full screen");
          if (mode === "native" && !inside.native) fail("native fullscreen did not start");
          if (mode === "overlay" && inside.native) fail("overlay run went native");
          const checkPhone = (value: typeof inside) => {
            if (value.layout !== value.expectedPhone) fail(`phone viewport changed to ${value.layout}`);
            if (value.bounds.width > lw + 1 || value.bounds.height > lh + 1) fail("phone enlarged above its canonical size");
            if (value.bounds.left < value.hostBounds.left + 11 || value.bounds.right > value.hostBounds.right - 11
              || value.bounds.top < value.hostBounds.top + 11 || value.bounds.bottom > value.hostBounds.bottom - 11) fail("phone escaped its frame");
            if (parseFloat(value.radius) < 1) fail("phone frame lost its rounded corners");
          };
          if (before.phone) checkPhone(before);
          if (viewport.phone && !inside.phone) fail("touch phone switched to desktop layout");
          if ("tablet" in viewport && !inside.fixed && (before.phone || inside.phone)) fail("touch tablet switched to phone layout");
          if (inside.phone) checkPhone(inside);
          else if (lw !== vw || lh !== hh || hw !== vw) fail(`iframe ${inside.layout}, frame area ${inside.host}, viewport ${inside.viewport}`);
          if (inside.chrome !== vh - hh || inside.rootBox !== `0,0 ${vw}x${vh}`) fail(`root ${inside.rootBox}, chrome ${inside.chrome}`);
          if (!inside.phone && inside.transform !== "none") fail(`scale is ${inside.transform}`);
          if (inside.src !== before.src || (await page.locator(`${selector} iframe`).last().elementHandle().then((h) => h && handle && h.evaluate((a, b) => a === b, handle)).catch(() => false)) !== true) fail("iframe reloaded");
          if (inside.covers.length) fail(`exit control covers ${inside.covers.join(", ")}`);
          if (inside.label !== LABELS[lang].exit || before.label !== LABELS[lang].enter) fail(`labels "${before.label}" / "${inside.label}"`);
          await page.screenshot({ path: path.join(dir, `${lang}-${viewport.name}-${name}-${mode}.png`) });
          if (name === "run" && mode === "overlay") {
            /* The window changing size while full screen. */
            await page.setViewportSize({ width: viewport.width === 1440 ? 1100 : 360, height: viewport.height === 900 ? 700 : 640 });
            await settle(page, 700);
            const resized = await measure(selector);
            const [rw] = resized.viewport.split("x").map(Number);
            const [w2, h2] = resized.layout.split("x").map(Number);
            const [, hh2] = resized.host.split("x").map(Number);
            if (resized.phone) checkPhone(resized);
            else if (w2 !== rw || h2 !== hh2 || resized.transform !== "none") fail(`after resize iframe ${resized.layout} in ${resized.viewport}`);
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await settle(page, 500);
          }
          /* Out again: Esc in the overlay (also from inside the product), the control in the API mode. */
          if (mode === "overlay") {
            await page.evaluate((selector) => document.querySelector(selector)!.querySelector("iframe")!.contentDocument!.body.focus(), selector);
            await page.keyboard.press("Escape");
          } else await page.locator(`${selector} > .fs-btn, .stage-wrap:has(> ${selector}) > .fs-btn`).click();
          await settle(page, 700);
          const after = await measure(selector);
          if (after.phone) checkPhone(after);
          if (after.full || after.native) fail("still full screen after leaving");
          if (Math.abs(after.scrollY - before.scrollY) > 1) fail(`scroll ${before.scrollY} -> ${after.scrollY}`);
          if (after.layout !== before.layout || after.transform !== before.transform) fail(`size ${before.layout} ${before.transform} -> ${after.layout} ${after.transform}`);
          if (after.label !== before.label) fail(`label ${before.label} -> ${after.label}`);
          rows.push({ key, viewport: inside.viewport, layout: inside.layout, frameArea: inside.host, chromePx: inside.chrome, scale: inside.transform, native: inside.native, scrollBefore: before.scrollY, scrollAfter: after.scrollY, control: before.label, exit: inside.label });
        }
        if (errors.length) failures.push(`${mode}-${lang}-${viewport.name}: page errors ${errors.join("; ")}`);
        await context.close();
      }
    }
  }
  fs.writeFileSync(path.join(dir, "fullscreen-check.json"), `${JSON.stringify({ rows, failures }, null, 2)}\n`);
  for (const row of rows) console.log(JSON.stringify(row));
  for (const failure of failures) console.error(failure);
  console.log(failures.length ? `${failures.length} failure(s)` : `${rows.length} full-screen cases hold`);
  return failures.length === 0;
}

// The browser sends real beacons to the local Worker with a recording binding.
// No external analytics request is made by this check.
async function checkEvents() {
  if (process.env.LANDING_URL) throw new Error("--check-events requires the local recording server");
  const rows: Record<string, unknown>[] = [];
  for (const lang of ["en", "uk"] as Locale[]) {
    for (const viewport of VIEWPORTS) {
      const key = `${lang}-${viewport.name}`;
      if (only && only !== key) continue;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        ...(viewport.phone ? { hasTouch: true, isMobile: true } : {}),
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((phone) => {
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} } });
        if (phone) Object.defineProperty(document, "fullscreenEnabled", { value: false });
      }, viewport.phone);
      eventPoints.length = 0;
      eventBodies.length = 0;
      const action = async (run: () => Promise<unknown>, event: string, agent = "") => {
        const before = eventPoints.length;
        const response = page.waitForResponse((response) =>
          new URL(response.url()).pathname === "/api/event" && response.request().method() === "POST");
        await run();
        if ((await response).status() !== 204) throw new Error(`${key}: ${event} did not return 204`);
        await settle(page, 100);
        if (eventPoints.length !== before + 1) throw new Error(`${key}: wrong or duplicated ${event} data point`);
        exact(event, agent);
      };
      const exact = (event: string, agent = "") => {
        const expected = { blobs: [event, agent, lang, ""], doubles: [1], indexes: [event] };
        if (JSON.stringify(eventPoints.at(-1)) !== JSON.stringify(expected)) throw new Error(`${key}: wrong ${event} data point`);
        const body = { event, lang, ...(agent ? { agent } : {}) };
        if (JSON.stringify(eventBodies.at(-1)) !== JSON.stringify(body)) throw new Error(`${key}: unexpected beacon fields`);
      };
      try {
        await page.goto(`${base}?lang=${lang}`);
        await settle(page, 600);
        /* The demo counts once, when it first plays in view: on load where most of it, or its top
           with a quarter of it, shows in the first screen, otherwise once it is scrolled to.
           Scrolling past it again counts nothing. */
        const inView = await page.evaluate(() => {
          const box = document.querySelector(".hero .demo")!.getBoundingClientRect();
          const shown = (Math.min(innerHeight, box.bottom) - Math.max(0, box.top)) / box.height;
          return shown >= 0.55 || (box.top >= 0 && shown >= 0.25);
        });
        if (inView) {
          if (eventPoints.length !== 1) throw new Error(`${key}: a demo in view at load counted ${eventPoints.length} events`);
          exact("demo_start");
        } else {
          if (eventPoints.length) throw new Error(`${key}: load counted an event`);
          await action(() => page.evaluate(() => document.querySelector(".hero .demo")!.scrollIntoView({ block: "center" })), "demo_start");
        }
        await page.evaluate(() => scrollTo(0, 0));
        for (const install of ["hero", "footer"]) {
          const slot = `[data-install="${install}"]`;
          for (const agent of ["claude", "codex"]) {
            await page.locator(`${slot} [data-agent="${agent}"]`).click();
            await action(() => page.locator(`${slot} [data-copy-prompt]`).click(), "copy_prompt", agent);
          }
          await page.locator(`${slot} .legacy-link`).click();
          await action(() => page.locator(`${slot} [data-copy-cmd]`).click(), "copy_legacy");
          await page.locator(`${slot} .legacy-link`).click();
        }
        await page.evaluate(() => document.querySelector(".hero .demo")!.scrollIntoView({ block: "center" }));
        await settle(page, 300);
        await page.locator(".live-run").scrollIntoViewIfNeeded();
        await frameOf(page, ".live-run");
        await action(() => page.locator('.sec-run .fs-btn').click(), "fullscreen_open");
        await page.locator('.sec-run .fs-btn').click();
        await page.waitForFunction(() => !document.documentElement.classList.contains("fs-lock"));
        await settle(page, 200);
        if (eventPoints.length !== 8) throw new Error(`${key}: unrelated controls counted events`);
        const points = [...eventPoints];
        // Missing/throwing beacon support cannot break copy or full-screen controls.
        await page.evaluate(() => { Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined }); });
        await page.locator('[data-install="hero"] [data-copy-prompt]').evaluate((button) => button.removeAttribute("data-copied"));
        await page.locator('[data-install="hero"] [data-copy-prompt]').click();
        if (await page.locator('[data-install="hero"] [data-copy-prompt]').getAttribute("data-copied") === null) {
          throw new Error(`${key}: unavailable analytics blocked copy`);
        }
        await page.evaluate(() => { Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => { throw new Error("blocked"); } }); });
        await page.locator('.sec-run .fs-btn').click();
        await page.waitForFunction(() => document.documentElement.classList.contains("fs-lock"));
        await page.locator('.sec-run .fs-btn').click();
        await page.waitForFunction(() => !document.documentElement.classList.contains("fs-lock"));
        if (eventPoints.length !== 8) throw new Error(`${key}: unavailable analytics wrote a point`);
        if (errors.length) throw new Error(`${key}: ${errors.join("; ")}`);
        rows.push({ key, points, beacons: [...eventBodies], errors });
        console.log(`${key}: 8 real beacons, exact points, ${viewport.phone ? "overlay" : "native"} full screen; unavailable analytics leaves actions working`);
      } finally {
        await context.close();
      }
    }
  }
  fs.writeFileSync(path.join(out, "events-check.json"), `${JSON.stringify(rows, null, 2)}\n`);
}

if (eventsCheck) {
  try { await checkEvents(); } finally { await browser.close(); server.stop(true); }
  process.exit(0);
}

if (promptCheck) {
  const failures: string[] = [];
  try {
    for (const lang of ["en", "uk"] as Locale[]) {
      for (const viewport of VIEWPORTS) {
        if (only && only !== `${lang}-${viewport.name}`) continue;
        failures.push(...await checkPromptExpansion(lang, viewport));
      }
    }
  } finally { await browser.close(); server.stop(true); }
  for (const failure of failures) console.error(failure);
  console.log(failures.length ? `${failures.length} clipped prompt(s)` : "every expanded prompt reads to its last line");
  process.exit(failures.length ? 1 : 0);
}

/* The «A conversation» frame opens a builder in the agent window. The window
   is the whole frame, with no margin of board round it, and its reader wears
   the plain border: no builder's amber ribbon round the frame, and the role
   named the quiet way, with no ribbon tag. Desktop only: the phone frame has
   no agent window. */
async function checkConversation() {
  const failures: string[] = [];
  for (const lang of ["en", "uk"] as Locale[]) {
    for (const viewport of VIEWPORTS.filter((entry) => !entry.phone)) {
      const key = `${lang}-${viewport.name}`;
      if (only && only !== key) continue;
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, colorScheme });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}?lang=${lang}`);
        await page.locator(".live-open").scrollIntoViewIfNeeded();
        const frame = await frameOf(page, ".live-open");
        await frame.waitForSelector("[data-agent-window] [data-kanban-reader] [data-tool-row]", { timeout: 30_000 });
        await settle(page, 1200);
        const seen = await frame.evaluate(() => {
          const window_ = document.querySelector<HTMLElement>("[data-agent-window-frame]")!;
          const rect = window_.getBoundingClientRect();
          const reader = window_.querySelector<HTMLElement>(".reader.conv[data-role-host]");
          const mark = reader?.querySelector<HTMLElement>(".role-mark");
          return {
            window: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: getComputedStyle(window_).borderTopLeftRadius },
            frame: { width: innerWidth, height: innerHeight },
            role: reader?.dataset.role ?? null,
            ribbon: reader ? getComputedStyle(reader, "::after").display : null,
            border: reader ? getComputedStyle(reader).borderTopWidth : null,
            ring: reader ? getComputedStyle(reader).boxShadow : null,
            tag: mark ? { background: getComputedStyle(mark).backgroundColor, clipPath: getComputedStyle(mark).clipPath } : null,
          };
        });
        await shoot(page, ".live-open", `${key}-3-open-conversation-check.png`);
        const fail = (why: string) => failures.push(`${key}: ${why} ${JSON.stringify(seen)}`);
        if (Math.abs(seen.window.x) > 1 || Math.abs(seen.window.y) > 1 || Math.abs(seen.window.width - seen.frame.width) > 1 || Math.abs(seen.window.height - seen.frame.height) > 1) fail("the agent window leaves a margin of board round it");
        if (seen.window.radius !== "0px") fail("the agent window rounds its corners inside the frame");
        if (!seen.role || seen.role === "orchestrator") fail("the frame opens no builder");
        if (seen.ribbon !== "none") fail("the reader wears the role ribbon");
        if (seen.border !== "1px") fail("the reader has no plain border");
        if (seen.ring !== "none") fail("the reader wears the keyboard's focus ring though nobody touched the frame");
        if (seen.tag && (seen.tag.background !== "rgba(0, 0, 0, 0)" || seen.tag.clipPath !== "none")) fail("the role reads as a ribbon tag");
        if (errors.length) fail(`page errors ${errors.join("; ")}`);
        console.log(`${key}: ${JSON.stringify(seen)}`);
      } finally { await context.close(); }
    }
  }
  for (const failure of failures) console.error(failure);
  console.log(failures.length ? `${failures.length} failure(s)` : "the conversation frame is the agent window, plain and whole");
  return failures.length === 0;
}

if (process.argv.includes("--check-conversation")) {
  let ok = false;
  try { ok = await checkConversation(); } finally { await browser.close(); server.stop(true); }
  process.exit(ok ? 0 : 1);
}

if (fullscreenCheck) {
  let ok = false;
  try { ok = await checkFullscreen(); } finally { await browser.close(); server.stop(true); }
  process.exit(ok ? 0 : 1);
}

/* A finger that moves steadily and then rests over a phone demo. The landing
   follows it 1:1 and stays put while it rests. Run on a build that measures the
   finger in a frame that moves with the page, the page alternates instead: each
   forwarded scroll moves the frame under the finger, and the next reading
   undoes it. "content-space" replays the coordinate semantics seen in the
   iPhone recording (Touch.screenY carries the parent's scroll); "stable" is the
   Chromium default. Both have to pass. */
async function checkSwipeFeedback() {
  const rows: Record<string, unknown>[] = [];
  const failures: string[] = [];
  for (const semantics of ["stable", "content-space"] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    if (semantics === "content-space") {
      await context.addInitScript(() => {
        if (window.parent === window) return;
        const screenY = Object.getOwnPropertyDescriptor(Touch.prototype, "screenY")!.get!;
        Object.defineProperty(Touch.prototype, "screenY", { get() { return screenY.call(this) + window.parent.scrollY; } });
      });
    }
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(`${base}?lang=en`);
    for (const surface of ["run", "phone"]) {
      const host = `.live-${surface}`;
      await page.locator(host).scrollIntoViewIfNeeded();
      const frame = await frameOf(page, host);
      await frame.evaluate(() => {
        for (const node of document.querySelectorAll<HTMLElement>("*")) {
          if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
        }
      });
      const point = await page.evaluate((selector) => {
        const box = document.querySelector(`${selector} iframe`)!.getBoundingClientRect();
        scrollTo(0, Math.max(0, scrollY + box.top + Math.min(box.height, 520) / 2 - 420));
        const placed = document.querySelector(`${selector} iframe`)!.getBoundingClientRect();
        return { x: Math.round(placed.left + placed.width / 2), y: Math.round(Math.max(placed.top + 12, Math.min(placed.bottom - 12, 420))) };
      }, host);
      await settle(page, 250);
      const trace: number[] = [];
      const read = async () => { trace.push(await page.evaluate(() => scrollY)); };
      const touch = (type: string, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: point.x, y, id: 1 }] } as never);
      await read();
      await touch("touchStart", point.y);
      const steps = 10, stride = 12;
      for (let step = 1; step <= steps; step += 1) {
        await touch("touchMove", point.y - step * stride);
        await settle(page, 16);
        await read();
      }
      const moved = trace[trace.length - 1]! - trace[0]!;
      // The finger rests, with the small tremor every finger has.
      for (let tick = 0; tick < 24; tick += 1) {
        await touch("touchMove", point.y - steps * stride - (tick % 2));
        await settle(page, 16);
        await read();
      }
      await touch("touchEnd", 0);
      const held = trace.slice(steps + 1);
      const rest = Math.max(...held) - Math.min(...held);
      let reversals = 0;
      for (let index = 1; index < trace.length; index += 1) if (trace[index]! < trace[index - 1]! - 1) reversals += 1;
      await settle(page, 700);
      const settled = await page.evaluate(() => scrollY);
      const finger = steps * stride;
      const row = { semantics, surface, finger, moved, ratio: Number((moved / finger).toFixed(2)), rest, reversals, coast: settled - trace[trace.length - 1]!, trace: trace.join(",") };
      rows.push(row);
      const problems = [
        Math.abs(moved - finger) > finger * 0.15 && `page moved ${moved}px for ${finger}px of finger`,
        rest > 4 && `page moved ${rest}px while the finger rested`,
        reversals > 0 && `page reversed ${reversals} times`,
        settled < trace[trace.length - 1]! - 2 && "page snapped back after release",
      ].filter(Boolean);
      for (const problem of problems) failures.push(`${semantics}/${surface}: ${problem}`);
    }
    await context.close();
  }
  for (const row of rows) console.log(JSON.stringify(row));
  fs.writeFileSync(path.join(out, "swipe-feedback.json"), `${JSON.stringify({ url: base, viewport: "390x844 touch DPR3", rows }, null, 2)}\n`);
  if (failures.length) throw new Error(`swipe feedback: ${failures.join("; ")}`);
  console.log("swipe feedback: the page follows the finger 1:1 and holds still while it rests");
}

if (process.argv.includes("--check-swipe-feedback")) {
  try { await checkSwipeFeedback(); } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exitCode = 1; } finally { await browser.close(); server.stop(true); }
  process.exit(process.exitCode ?? 0);
}

if (swipeCheck) {
  try { await checkSwipe(); } finally { await browser.close(); server.stop(true); }
  process.exit(0);
}


/* Performance cases share this driver, its ephemeral server and one browser.
   --perf=before (observe) / --perf=after (also enforce scroll regression).
   LANDING_URL can select the published site; LANDING_RENDER_DIR holds traces. */
const perfLabel = process.argv.find((arg) => arg.startsWith("--perf="))?.split("=")[1];
async function performanceCase(viewport: (typeof VIEWPORTS)[number]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
    isMobile: viewport.phone, hasTouch: viewport.phone });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(() => {
    const records: Record<string, unknown>[] = [];
    Object.assign(window, { perfRecords: records });
    for (const type of ["longtask", "paint", "largest-contentful-paint"]) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) records.push({ type, at: entry.startTime, duration: entry.duration });
      }).observe({ type, buffered: true });
    }
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function(options) {
      records.push({ type: "focus", at: performance.now(), tag: this.tagName, label: this.getAttribute("aria-label"), options });
      return focus.call(this, options);
    };
    addEventListener("message", (event) => {
      if (event.data?.type?.startsWith("dlg:")) records.push({ type: "message", at: performance.now(), data: event.data });
      if (event.data?.type === "dlg:viewed") {
        const doc = (event.source as Window | null)?.document;
        if (doc) records.push({ type: "view-ack", at: performance.now(), view: event.data.view,
          phone: doc.documentElement.hasAttribute("data-demo-phone"),
          screen: doc.querySelector("[data-mobile2-screen]")?.getAttribute("data-mobile2-screen"),
          results: doc.querySelectorAll("[data-search-result]").length });
      }
    });
    addEventListener("scroll", () => records.push({ type: "scroll", at: performance.now(), y: scrollY }));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const result: Record<string, unknown> = { url: base, browser: browser.version(), cpuThrottle: 4, viewport, errors };
  async function trace(name: string, action: () => Promise<unknown>) {
    await browser.startTracing(page, { screenshots: false, categories: ["devtools.timeline", "v8", "blink.user_timing", "disabled-by-default-devtools.timeline", "toplevel"] });
    const value = await action();
    const data = await browser.stopTracing();
    fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}-${name}.trace.json`), data);
    const events = JSON.parse(data.toString()).traceEvents as { name: string; dur?: number; args?: { data?: { url?: string } } }[];
    const sum = (name: string) => events.filter(e => e.name === name).reduce((s, e) => s + (e.dur ?? 0) / 1000, 0);
    const tasks = events.filter(e => e.name === "RunTask" && (e.dur ?? 0) >= 50_000);
    result[name] = { value, trace: { longTasks: tasks.length, longTaskMs: tasks.reduce((s,e) => s + e.dur! / 1000, 0), blockingMs: tasks.reduce((s,e) => s + e.dur! / 1000 - 50, 0), evaluateScriptMs: sum("EvaluateScript"), evaluateModuleMs: sum("v8.evaluateModule"), compileMs: sum("v8.compile"), layoutMs: sum("Layout"), paintMs: sum("Paint"), demoModuleEvalMs: sum("v8.evaluateModule") } };
    fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}.json`), JSON.stringify(result, null, 2));
    console.log(`${perfLabel}-${viewport.name} ${name}: ${JSON.stringify(result[name])}`);
  }
  async function earlyTab(lang = "en") {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pattern = "**/demo.js";
    await page.route(pattern, async route => { await gate; await route.continue(); });
    try {
      await page.goto(`${base}?lang=${lang}`, { waitUntil: "domcontentloaded" });
      await page.locator(".live-open").scrollIntoViewIfNeeded();
      await page.locator(".live-open iframe").waitFor({ state: "attached" });
      const initial = await page.locator(".live-open iframe").getAttribute("src");
      if (!initial?.includes("view=conversation")) throw new Error("early-tab case did not start on the default view");
      await page.locator('.sec-open [data-view="search"]').click();
      release();
      const frame = await frameOf(page, ".live-open");
      await frame.waitForSelector("[data-search-result]");
      const results = await frame.locator("[data-search-result]").count();
      if (results !== 3) throw new Error(`early ${lang} Search rendered ${results} results`);
      return { lang, selectedBeforeScriptLoad: "search", results };
    } finally { release(); await page.unroute(pattern); }
  }
  async function searchFailure() {
    const frame = await frameOf(page, ".live-open");
    await frame.evaluate(() => {
      const original = window.fetch;
      Object.assign(window, { restoreSearch: () => { window.fetch = original; } });
      window.fetch = (async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (String(args[0]).includes("/api/search/transcripts")) {
          return Response.json({ ...await response.json(), items: [], total: 0 });
        }
        return response;
      }) as typeof fetch;
    });
    await page.locator('.sec-open [data-view="conversation"]').click();
    await frameOf(page, ".live-open");
    await page.evaluate(() => { (window as unknown as PerfWindow).perfRecords.length = 0; });
    await page.locator('.sec-open [data-view="search"]').click();
    await page.locator(".live-open .demo-retry").waitFor();
    const falseAck = await page.evaluate(() => (window as unknown as PerfWindow).perfRecords.some((r) => r.type === "view-ack" && r.view === "search"));
    if (falseAck || await frame.locator("[data-search-result]").count()) throw new Error("empty Search was acknowledged ready");
    await page.locator(".live-open").screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-search-retry.png`) });
    await frame.evaluate(() => (window as unknown as PerfWindow).restoreSearch());
    await page.locator(".live-open .demo-retry").click();
    const recovered = await frameOf(page, ".live-open");
    if (recovered !== frame || await recovered.locator("[data-search-result]").count() !== 3) throw new Error("retry did not recover Search in place");
    return { falseAcknowledgements: 0, recoveredResults: 3, sameFrame: true };
  }
  try {
    if (process.argv.includes("--search-failure-only")) {
      await page.goto(`${base}?lang=uk`, { waitUntil: "load" });
      await page.locator(".live-open").scrollIntoViewIfNeeded();
      await trace("search-failure", searchFailure);
      if (errors.length) throw new Error(errors.join("\n"));
      return;
    }
    if (process.argv.includes("--early-tab-only")) {
      await trace("early-tab", earlyTab);
      return;
    }
    await trace("load", async () => {
      await page.goto(`${base}?lang=en`, { waitUntil: "load" });
      await page.waitForSelector(".hero .demo .d-card");
      const readyMs = await page.evaluate(() => performance.now());
      await page.waitForTimeout(700);
      return page.evaluate((readyMs) => ({ readyMs, navigation: performance.getEntriesByType("navigation")[0]?.toJSON(), records: (window as unknown as PerfWindow).perfRecords }), readyMs);
    });
    await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-loaded.png`) });
    if (process.argv.includes("--load-only")) return;
    await trace("tabs", async () => {
      await page.locator(".live-open").scrollIntoViewIfNeeded();
      await frameOf(page, ".live-open");
      const rows = [];
      for (const view of ["search", "accounts", "overview", "conversation"]) {
        const start = Date.now();
        await page.locator(`.sec-open [data-view="${view}"]`).click();
        await page.waitForFunction(() => !document.querySelector(".live-open[data-busy]"));
        const frame = await frameOf(page, ".live-open");
        if (perfLabel === "after" && !viewport.phone && view !== "conversation") {
          await frame.waitForFunction(() => !document.querySelector("[data-reader-close]"));
        }
        if (view === "search") {
          await frame.waitForSelector("[data-search-result]");
          if (await frame.locator("[data-search-result]").count() !== 3) throw new Error("Search must show three results");
        }
        if (view === "accounts") await frame.waitForFunction(() => document.body.innerText.replace(/\s+/g, " ").includes("Max"));
        rows.push({ view, visibleMs: Date.now() - start });
        if (perfLabel === "after") await page.locator(".live-open").screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-${view}.png`) });
      }
      return rows;
    });
    await trace("language", async () => {
      for (const selector of [".live-run", ".live-open", ".live-phone"]) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        await frameOf(page, selector);
      }
      const rows = [];
      for (const [index, lang] of ["uk", "en", "uk", "en", "uk", "en"].entries()) {
        const top = index < 4 ? 0 : 800;
        await page.evaluate(top => window.scrollTo({ top, behavior: "instant" }), top);
        await page.waitForTimeout(600);
        const before = await page.evaluate(() => scrollY);
        if (top === 0) await page.locator(`button[data-lang="${lang}"]`).click();
        else await page.locator(`button[data-lang="${lang}"]`).evaluate((button: HTMLButtonElement) => button.click());
        await page.waitForTimeout(7000);
        const after = await page.evaluate(() => scrollY);
        rows.push({ lang, before, after, delta: after - before });
        if (perfLabel === "after") {
          await page.locator(".live-open").scrollIntoViewIfNeeded();
          const frame = await frameOf(page, ".live-open");
          // The latest of several quick tab choices must win without a reload.
          await page.evaluate(() => {
            for (const view of ["accounts", "overview", "search"]) document.querySelector<HTMLButtonElement>(`.sec-open [data-view="${view}"]`)!.click();
          });
          const selected = await frameOf(page, ".live-open");
          if (selected !== frame || await selected.locator("[data-search-result]").count() !== 3) throw new Error(`Search failed after switching to ${lang}`);
        }
      }
      return rows;
    });
    result.frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), records: await frame.evaluate(() => (window as unknown as PerfWindow).perfRecords) })));
    const acknowledgements = await page.evaluate(() => (window as unknown as PerfWindow).perfRecords.filter((r) => r.type === "view-ack"));
    result.acknowledgements = acknowledgements;
    if (perfLabel === "after" && acknowledgements.some((r) =>
      (r.view === "search" && r.results !== 3) || (r.phone && r.view === "conversation" && r.screen !== "chat"))) {
      fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}-invalid-ack.json`), JSON.stringify(acknowledgements, null, 2));
      throw new Error("demo acknowledged a view before its content rendered");
    }
    await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-language.png`) });
    if (perfLabel === "after") {
      await trace("early-tab", () => earlyTab("en"));
      await trace("early-tab-uk", () => earlyTab("uk"));
      await trace("search-failure", searchFailure);
    }
    fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}.json`), JSON.stringify(result, null, 2));
    console.log(`${perfLabel}-${viewport.name}: complete`);
    if (perfLabel === "after" && (result.language as { value: { delta: number }[] }).value.some((row) => Math.abs(row.delta) > 2)) throw new Error("language switch moved the page");
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (error) {
    await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-failure.png`) });
    const frames = await Promise.all(page.frames().map(async frame => frame.evaluate(() => ({
      url: location.href, hash: location.hash, screen: document.querySelector("[data-mobile2-screen]")?.getAttribute("data-mobile2-screen"),
      search: document.querySelector<HTMLInputElement>("[data-search-input]")?.value,
      results: document.querySelectorAll("[data-search-result]").length, records: (window as unknown as PerfWindow).perfRecords,
    })).catch(() => null)));
    fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}-failure.json`), JSON.stringify({ error: String(error), frames }, null, 2));
    throw error;
  } finally { await context.close(); }
}
if (perfLabel) {
  try {
    for (const viewport of VIEWPORTS) if (!only || only === `en-${viewport.name}`) await performanceCase(viewport);
  } finally { await browser.close(); server.stop(true); }
  process.exit(0);
}

/* The hero's demo: its moments for the renders, and the `--check-demo` measurement. */
async function demoMoments(page: Page): Promise<number[]> {
  const { steps, hold } = await page.evaluate(() => ({ steps: window.DLG.demo.steps, hold: window.DLG.demo.hold }));
  return steps.slice(0, 6).map((from, index) => (index === 5 ? hold : index === 4 ? Math.round((from + steps[5]!) / 2) : steps[index + 1]! - 400));
}

function serveDirectory(dir: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.startsWith("/api/")) return new Response(null, { status: 204 });
      let pathname = decodeURIComponent(new URL(request.url).pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = Bun.file(path.join(dir, path.normalize(pathname)));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
}

const FRAME_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "toplevel", "benchmark", "cc", "viz"];
type TraceEvent = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: Record<string, unknown> };

/* A cold load with the cache off and the CPU at a quarter speed, the page left
   where it opens: the largest contentful paint and every byte that arrived. */
async function coldLoad(url: string, viewport: (typeof VIEWPORTS)[number]) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: viewport.phone, hasTouch: viewport.phone });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  let bytes = 0, requests = 0, failed = 0, errors = 0;
  const largest: { url: string; kb: number }[] = [];
  const urls = new Map<string, string>();
  cdp.on("Network.requestWillBeSent", (event) => urls.set(event.requestId, event.request.url));
  cdp.on("Network.responseReceived", (event) => { if (event.response.status >= 400) errors += 1; });
  cdp.on("Network.loadingFinished", (event) => {
    bytes += event.encodedDataLength;
    requests += 1;
    largest.push({ url: (urls.get(event.requestId) ?? "").replace(url.replace(/\?.*$/, ""), "/").slice(0, 90), kb: Math.round(event.encodedDataLength / 102.4) / 10 });
  });
  cdp.on("Network.loadingFailed", () => { failed += 1; });
  await page.addInitScript(() => {
    const seen = { at: 0, element: "", shift: 0 };
    Object.assign(window, { lcp: seen });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!entry.hadRecentInput) seen.shift += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { element?: Element | null })[]) {
        seen.at = entry.startTime;
        seen.element = entry.element ? `${entry.element.tagName.toLowerCase()}${entry.element.className ? `.${String(entry.element.className).split(" ")[0]}` : ""}` : "";
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  await page.goto(url, { waitUntil: "load" });
  /* What loads on its own after the load event (the frames that start with the page) arrives in this time. */
  await page.waitForTimeout(8000);
  const seen = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return { lcp: (window as unknown as { lcp: { at: number; element: string; shift: number } }).lcp, domContentLoaded: navigation.domContentLoadedEventEnd, load: navigation.loadEventEnd };
  });
  await context.close();
  largest.sort((a, b) => b.kb - a.kb);
  return {
    lcpMs: Math.round(seen.lcp.at), lcpElement: seen.lcp.element, cls: Math.round(seen.lcp.shift * 1000) / 1000,
    domContentLoadedMs: Math.round(seen.domContentLoaded), loadMs: Math.round(seen.load),
    transferKB: Math.round(bytes / 102.4) / 10, requests, failed, httpErrors: errors, largest: largest.slice(0, 6),
  };
}

/* One full loop, playing in view, traced at a quarter of the CPU. */
async function loopTrace(viewport: (typeof VIEWPORTS)[number], dir: string) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: viewport.phone, hasTouch: viewport.phone });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(`${base}?lang=en`, { waitUntil: "load" });
  await page.waitForSelector(".hero .demo .d-card");
  await page.evaluate(() => document.querySelector(".hero .demo")!.scrollIntoView({ block: "center" }));
  await settle(page, 1500);
  const loop = await page.evaluate(() => { window.DLG.demo.seek(0); window.DLG.demo.release(); return window.DLG.demo.loop; });
  await browser.startTracing(page, { screenshots: false, categories: FRAME_CATEGORIES });
  await settle(page, loop + 200);
  const data = await browser.stopTracing();
  const played = await page.evaluate(() => window.DLG.demo.now());
  await context.close();
  fs.writeFileSync(path.join(dir, `loop-${viewport.name}.trace.json`), data);
  const events = (JSON.parse(data.toString()).traceEvents as TraceEvent[]);
  const threads = new Map<string, string>();
  for (const event of events) if (event.name === "thread_name") threads.set(`${event.pid}:${event.tid}`, String((event.args as { name?: string })?.name));
  const main = events.filter((event) => threads.get(`${event.pid}:${event.tid}`) === "CrRendererMain");
  const tasks = main.filter((event) => (event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask") && event.ph === "X");
  const long = tasks.filter((event) => (event.dur ?? 0) >= 50_000).map((event) => Math.round(event.dur! / 1000));
  const count = (name: string) => events.filter((event) => event.name === name).length;
  /* Chrome's frame reporter states each frame it was asked for: presented, partly presented (the main thread
     missed it, the compositor did not), or dropped. */
  const reports = events.filter((event) => event.name === "PipelineReporter" && event.ph === "b");
  const state = (event: TraceEvent) => String((event.args?.frame_reporter as { state?: string } | undefined)?.state ?? "none");
  const states: Record<string, number> = {};
  for (const event of reports) states[state(event)] = (states[state(event)] ?? 0) + 1;
  const dropped = states.STATE_DROPPED ?? 0;
  const presented = (states.STATE_PRESENTED_ALL ?? 0) + (states.STATE_PRESENTED_PARTIAL ?? 0);
  const wanted = presented + dropped;
  const longestMs = tasks.reduce((max, event) => Math.max(max, (event.dur ?? 0) / 1000), 0);
  return {
    viewport: `${viewport.width}x${viewport.height}`, cpuThrottle: 4, loopMs: loop, tracedMs: loop + 200, playedTo: Math.round(played),
    frames: { reported: reports.length, presented, dropped, droppedPercent: wanted ? Math.round((dropped / wanted) * 1000) / 10 : null, states,
      drawFrame: count("DrawFrame"), droppedFrameEvents: count("DroppedFrame"), beginFrame: count("BeginFrame") },
    mainThread: { tasks: tasks.length, longTasks: long.length, longTaskMs: long, longestTaskMs: Math.round(longestMs * 10) / 10,
      layoutMs: Math.round(main.filter((e) => e.name === "Layout").reduce((sum, e) => sum + (e.dur ?? 0), 0) / 100) / 10,
      layouts: main.filter((e) => e.name === "Layout").length,
      styleMs: Math.round(main.filter((e) => e.name === "UpdateLayoutTree").reduce((sum, e) => sum + (e.dur ?? 0), 0) / 100) / 10,
      paintMs: Math.round(main.filter((e) => e.name === "Paint").reduce((sum, e) => sum + (e.dur ?? 0), 0) / 100) / 10 },
    errors,
  };
}

/* The demo waits off screen, in a hidden tab and on the visitor's pause, and stands still under reduced motion. */
async function demoHolds(viewport: (typeof VIEWPORTS)[number]) {
  const failures: string[] = [];
  const running = (page: Page) => page.evaluate(() => document.getAnimations().filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
    return animation.playState === "running" && !!target?.closest(".demo, .demo-rail");
  }).length);
  const advances = async (page: Page) => {
    const first = await page.evaluate(() => window.DLG.demo.now());
    await settle(page, 600);
    return (await page.evaluate(() => window.DLG.demo.now())) !== first;
  };
  for (const motion of ["no-preference", "reduce"] as const) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: viewport.phone, hasTouch: viewport.phone, reducedMotion: motion });
    const page = await context.newPage();
    const key = `${viewport.name}-${motion}`;
    await page.goto(`${base}?lang=en`, { waitUntil: "load" });
    await page.waitForSelector(".hero .demo .d-card");
    await page.evaluate(() => document.querySelector(".hero .demo")!.scrollIntoView({ block: "center" }));
    await settle(page, 800);
    if (motion === "reduce") {
      if (await advances(page) || await running(page)) failures.push(`${key}: the demo moves under reduced motion`);
      const captions = await page.evaluate(() => [...document.querySelectorAll(".demo-steps .cap")].map((cap) => getComputedStyle(cap).opacity));
      if (captions.length !== 6 || captions.some((opacity) => opacity !== "1")) failures.push(`${key}: not every step's caption shows (${captions.join(",")})`);
      const cursor = await page.evaluate(() => getComputedStyle(document.querySelector(".d-cursor")!).display);
      if (cursor !== "none") failures.push(`${key}: the cursor shows on the still board`);
    } else {
      if (!await advances(page)) failures.push(`${key}: the demo does not play in view`);
      await page.locator("[data-demo-pause]").click();
      if (await advances(page) || await running(page)) failures.push(`${key}: the pause button does not stop it`);
      await page.locator("[data-demo-pause]").click();
      if (!await advances(page)) failures.push(`${key}: play does not resume it`);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await settle(page, 400);
      if (await advances(page) || await running(page)) failures.push(`${key}: the demo plays off screen`);
      await page.evaluate(() => document.querySelector(".hero .demo")!.scrollIntoView({ block: "center" }));
      await settle(page, 400);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      if (await advances(page) || await running(page)) failures.push(`${key}: the demo plays in a hidden tab`);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      if (!await advances(page)) failures.push(`${key}: the demo does not come back with the tab`);
      /* The loop starts on an empty board, and nothing that flies stays behind. */
      const strays = await page.evaluate(() => {
        const shown = (selector: string) => [...document.querySelectorAll(selector)].filter((el) => Number(getComputedStyle(el).opacity) > 0.01).length;
        const at = (time: number) => { window.DLG.demo.seek(time); return { cards: shown(".d-card"), messages: shown(".d-msg"), fliers: shown(".d-fly"), pulses: shown(".d-pulse") }; };
        const result = { start: at(0), hold: at(window.DLG.demo.hold) };
        window.DLG.demo.release();
        return result;
      });
      if (Object.values(strays.start).some(Boolean)) failures.push(`${key}: the loop does not start empty ${JSON.stringify(strays.start)}`);
      if (strays.hold.fliers || strays.hold.pulses) failures.push(`${key}: flying marks stay on the finished board ${JSON.stringify(strays.hold)}`);
      /* Nothing in the picture takes the pointer. */
      const pointer = await page.evaluate(() => getComputedStyle(document.querySelector(".demo-stage")!).pointerEvents);
      if (pointer !== "none") failures.push(`${key}: the stage takes the pointer`);
      /* The pointer stays whole inside the stage at every moment of the loop. */
      const clipped = await page.evaluate(() => {
        const stage = document.querySelector(".demo-stage")!.getBoundingClientRect();
        const cursor = document.querySelector(".d-cursor")!;
        const out: number[] = [];
        for (let at = 0; at < window.DLG.demo.loop; at += 100) {
          window.DLG.demo.seek(at);
          const box = cursor.getBoundingClientRect();
          if (Number(getComputedStyle(cursor).opacity) <= 0.01) continue;
          if (box.left < stage.left - 0.5 || box.top < stage.top - 0.5 || box.right > stage.right + 0.5 || box.bottom > stage.bottom + 0.5) out.push(at);
        }
        window.DLG.demo.release();
        return out;
      });
      if (clipped.length) failures.push(`${key}: the pointer crosses the stage's edge at ${clipped.join(", ")} ms`);
      /* Scrolled on until 40% of it shows, the top gone, it pauses. */
      await page.evaluate(() => {
        const box = document.querySelector(".hero .demo")!.getBoundingClientRect();
        scrollBy(0, box.top + box.height * 0.6);
      });
      await settle(page, 400);
      if (await advances(page) || await running(page)) failures.push(`${key}: the demo plays with 40% of it showing`);
    }
    await context.close();
  }
  /* A laptop's first screen shows the top of the hero's demo: it plays there with no scroll. */
  for (const height of viewport.phone ? [] : [viewport.height, 780]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`${base}?lang=en`, { waitUntil: "load" });
    await page.waitForSelector(".hero .demo .d-card");
    await settle(page, 1000);
    const shown = await page.evaluate(() => {
      const box = document.querySelector(".hero .demo")!.getBoundingClientRect();
      return Math.round(((Math.min(innerHeight, box.bottom) - Math.max(0, box.top)) / box.height) * 100);
    });
    if (!await advances(page)) failures.push(`${viewport.width}x${height}: the demo does not play on the first screen (${shown}% of it showing)`);
    await context.close();
  }
  /* On a computer's first screen the whole story plays with no scroll: the
     request is typed where it can be read, the steps and the demo's label stay
     in view, and some step's caption shows at every moment of the loop. */
  for (const lang of viewport.phone ? [] : (["en", "uk"] as Locale[])) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`${base}?lang=${lang}`, { waitUntil: "load" });
    await page.waitForSelector(".hero .demo .d-card");
    await settle(page, 600);
    const story = await page.evaluate(() => {
      const inView = (el: Element | null) => {
        const box = el?.getBoundingClientRect();
        return !!box && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
      };
      const showing = (el: Element) => Number(getComputedStyle(el).opacity) > 0.5;
      const { loop, steps } = window.DLG.demo;
      const typing = (steps[2]! + steps[3]!) / 2;
      window.DLG.demo.seek(typing);
      const typed = [...document.querySelectorAll(".d-typed span")].filter(showing);
      const result = {
        typed: typed.length > 0 && typed.every(inView),
        composer: inView(document.querySelector(".d-comp")),
        steps: inView(document.querySelector(".demo-steps .chip")),
        note: inView(document.querySelector(".demo-note")),
        uncaptioned: [] as number[],
      };
      for (let at = 0; at < loop; at += 50) {
        window.DLG.demo.seek(at);
        if (![...document.querySelectorAll(".demo-steps .cap")].some((cap) => showing(cap) && inView(cap))) result.uncaptioned.push(at);
      }
      window.DLG.demo.release();
      return result;
    });
    const key = `${viewport.width}x${viewport.height}-${lang}`;
    if (!story.typed || !story.composer) failures.push(`${key}: the request is typed below the first screen`);
    if (!story.steps || !story.note) failures.push(`${key}: the demo's steps or its label sit below the first screen`);
    if (story.uncaptioned.length) failures.push(`${key}: no caption shows at ${story.uncaptioned.length} of the loop's moments, from ${story.uncaptioned.slice(0, 8).join(", ")} ms`);
    await context.close();
  }
  return failures;
}

/* Unthrottled: a frame every half second through one loop, and the loop recorded as it plays. */
async function demoFrames(viewport: (typeof VIEWPORTS)[number], dir: string) {
  for (const lang of ["en", "uk"] as Locale[]) {
    const frames = path.join(dir, `frames-${viewport.name}-${lang}`);
    fs.mkdirSync(frames, { recursive: true });
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.phone ? 2 : 1, isMobile: viewport.phone, hasTouch: viewport.phone });
    const page = await context.newPage();
    await page.goto(`${base}?lang=${lang}`, { waitUntil: "load" });
    await page.waitForSelector(".hero .demo .d-card");
    await page.evaluate(() => document.querySelector(".hero .demo")!.scrollIntoView({ block: "center" }));
    await settle(page, 800);
    const loop = await page.evaluate(() => window.DLG.demo.loop);
    for (let at = 0; at < loop; at += 500) {
      await page.evaluate((at) => window.DLG.demo.seek(at), at);
      await settle(page, 60);
      await page.locator(".hero .stage-wrap").screenshot({ path: path.join(frames, `t${String(at).padStart(5, "0")}.png`) });
    }
    await context.close();
  }
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: viewport.phone, hasTouch: viewport.phone,
    recordVideo: { dir, size: { width: viewport.width, height: viewport.height } },
  });
  const page = await context.newPage();
  await page.goto(`${base}?lang=en`, { waitUntil: "load" });
  await page.waitForSelector(".hero .demo .d-card");
  await page.evaluate(() => document.querySelector(".hero .demo")!.scrollIntoView({ block: "center" }));
  await settle(page, 800);
  const loop = await page.evaluate(() => { window.DLG.demo.seek(0); window.DLG.demo.release(); return window.DLG.demo.loop; });
  await settle(page, loop + 1500);
  const video = page.video();
  await context.close();
  const recorded = await video?.path();
  if (recorded) fs.renameSync(recorded, path.join(dir, `loop-${viewport.name}.webm`));
}

if (process.argv.includes("--check-demo")) {
  const failures: string[] = [];
  const result: Record<string, unknown> = { url: base, browser: browser.version() };
  const before = process.env.LANDING_BEFORE_DIR ? serveDirectory(process.env.LANDING_BEFORE_DIR) : null;
  try {
    for (const viewport of VIEWPORTS) {
      if (only && only !== `en-${viewport.name}`) continue;
      const loop = await loopTrace(viewport, out);
      result[`loop-${viewport.name}`] = loop;
      console.log(`loop ${viewport.name}: ${JSON.stringify(loop)}`);
      if (loop.mainThread.longTasks > 0) failures.push(`${viewport.name}: ${loop.mainThread.longTasks} long task(s) during the loop`);
      if (loop.frames.droppedPercent === null || loop.frames.droppedPercent > 1) failures.push(`${viewport.name}: ${loop.frames.droppedPercent}% of frames dropped`);
      if (loop.errors.length) failures.push(`${viewport.name}: page errors ${loop.errors.join("; ")}`);
      /* Five cold loads of each build, alternating, and the median of each timing. */
      const runs: { after: Awaited<ReturnType<typeof coldLoad>>[]; before: Awaited<ReturnType<typeof coldLoad>>[] } = { after: [], before: [] };
      for (let run = 0; run < 5; run += 1) {
        runs.after.push(await coldLoad(`${base}?lang=en`, viewport));
        if (before) runs.before.push(await coldLoad(`http://127.0.0.1:${before.port}/?lang=en`, viewport));
      }
      const median = (list: Awaited<ReturnType<typeof coldLoad>>[]) => {
        if (!list.length) return null;
        const mid = (key: "lcpMs" | "domContentLoadedMs" | "loadMs" | "cls") => list.map((entry) => entry[key]).sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
        return { ...list[0]!, lcpMs: mid("lcpMs"), domContentLoadedMs: mid("domContentLoadedMs"), loadMs: mid("loadMs"), cls: mid("cls"), lcpRuns: list.map((entry) => entry.lcpMs) };
      };
      const load = { after: median(runs.after), before: median(runs.before) };
      result[`load-${viewport.name}`] = load;
      console.log(`load ${viewport.name}: ${JSON.stringify(load)}`);
      failures.push(...await demoHolds(viewport));
      if (!process.argv.includes("--no-frames")) await demoFrames(viewport, out);
    }
  } finally {
    await browser.close();
    server.stop(true);
    before?.stop(true);
  }
  result.failures = failures;
  fs.writeFileSync(path.join(out, "demo-check.json"), `${JSON.stringify(result, null, 2)}\n`);
  for (const failure of failures) console.error(failure);
  console.log(failures.length ? `${failures.length} failure(s)` : `the demo holds: no long task, frames presented, it waits when it should; renders in ${out}`);
  process.exit(failures.length ? 1 : 0);
}
for (const lang of ["en", "uk"] as Locale[]) {
  for (const viewport of VIEWPORTS) {
    const key = `${lang}-${viewport.name}`;
    if (only && only !== key) continue;
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, colorScheme,
      ...(viewport.phone ? { hasTouch: true, isMobile: true } : {}),
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}?lang=${lang}`);
    await page.waitForSelector(".hero .demo .d-card");
    await settle(page, 2500);
    await page.screenshot({ path: path.join(out, `${key}-first-screen.png`) });

    /* Walk down so every frame loads, then take the page whole. */
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += viewport.height / 2) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await settle(page, 150);
    }
    for (const selector of [".live-run", ".live-open", ".live-phone"]) {
      // Keep the lazy frame visible while its initial view renders.
      await page.locator(selector).scrollIntoViewIfNeeded();
      await frameOf(page, selector);
    }
    await settle(page, 3000);

    await shoot(page, ".hero", `${key}-1-hero.png`);
    await shoot(page, ".sec-run", `${key}-2-run.png`);
    await shoot(page, ".sec-open", `${key}-3-open.png`);
    await shoot(page, ".sec-reach", `${key}-4-reach.png`);
    await page.locator(".sec-faq details").first().evaluate((item) => { (item as HTMLDetailsElement).open = true; });
    await shoot(page, ".sec-faq", `${key}-5-faq.png`);
    await page.locator(".sec-faq details").first().evaluate((item) => { (item as HTMLDetailsElement).open = false; });
    await shoot(page, ".band", `${key}-6-footer.png`);

    /* The hero's demo, held near the end of each of its steps. */
    await page.locator(".hero .demo").scrollIntoViewIfNeeded();
    for (const [index, at] of (await demoMoments(page)).entries()) {
      await page.evaluate((at) => window.DLG.demo.seek(at), at);
      await settle(page, 150);
      await page.locator(".hero .stage-wrap").screenshot({ path: path.join(out, `${key}-demo-${index + 1}.png`) });
    }
    await page.evaluate(() => window.DLG.demo.release());

    /* The other faces of each frame, through the page's own tabs. */
    const tab = async (selector: string, settleMs: number, file: string, target: string) => {
      await page.locator(selector).first().click();
      await page.waitForFunction(() => !document.querySelector(".live[data-busy]"), undefined, { timeout: 20_000 });
      await settle(page, settleMs);
      await shoot(page, target, file);
    };
    await tab('.sec-run [data-view="decision"]', 2200, `${key}-2-run-decision.png`, ".sec-run .stage-wrap");
    for (const view of ["search", "accounts", "overview"]) {
      await tab(`.sec-open [data-view="${view}"]`, 2600, `${key}-3-open-${view}.png`, viewport.phone ? ".live-open" : ".sec-open");
    }
    await tab('.seg-phone [data-view="decision"]', 1800, `${key}-4-reach-decision.png`, ".reach-art");
    await tab('.seg-phone [data-view="reports"]', 1800, `${key}-4-reach-reports.png`, ".reach-art");

    /* The page whole, every frame loaded: each is brought into view first so it renders. */
    for (const selector of [".live-open", ".live-run", ".live-phone"]) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      await settle(page, 700);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page, 500);
    await page.screenshot({ path: path.join(out, `${key}-full.png`), fullPage: true });

    /* The legacy install and the giggle. */
    await page.locator(".hero .legacy-link").click();
    await settle(page, 1200);
    await shoot(page, ".hero-head", `${key}-legacy.png`);

    report[key] = {
      errors,
      unanswered: await (await frameOf(page, ".live-run")).evaluate(() => (window as unknown as { demoUnanswered?: string[] }).demoUnanswered ?? []),
      overflowX: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
    await context.close();
    console.log(`${key}: done`);
  }
}

fs.writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
server.stop(true);
console.log(`renders in ${out}`);
