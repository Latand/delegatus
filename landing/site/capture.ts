/*
 * Renders the built landing (landing/site/dist/) for review:
 *
 *   bun landing/site/build.ts && CHROME_BIN=/usr/bin/google-chrome-stable bun landing/site/capture.ts
 *
 * At 1440×900 and 390×844, in English and Ukrainian: the full page, the first
 * screen, each section, the hero demo at every step of its script (driven by
 * pressing the product's own send control inside the frame, the way a visitor
 * does), the other views of each frame, and the legacy-install joke. PNGs go
 * to LANDING_RENDER_DIR (default ~/Pictures/delegatus-review/landing/final/),
 * which is never committed. Page errors and requests the demo left unanswered
 * are written beside them in report.json.
 *
 * `--only=en-1440` limits the run to one language and width.
 *
 * `--gallery` renders the Product Hunt gallery instead (see renderGallery).
 *
 * `--check-fullscreen` puts each demo frame full screen through its control, in
 * both languages and widths, once with the browser's Fullscreen API and once
 * as the overlay iPhone Safari gets. It asserts the frame's layout and scale, that the
 * control clears the product's own controls, that Esc and the control leave,
 * and that the page's scroll position comes back; PNGs go to
 * LANDING_RENDER_DIR (default /tmp/landing-fullscreen-renders/).
 *
 * `--check-request=10` renders nothing: it plays the hero's script that many
 * times in each language and width and fails unless every step shows the
 * visitor's request exactly once in the orchestrator's chat, above the reply.
 * On the phone the chat is held open (the visitor pressed "Orchestrator"), so
 * the chat is on screen at every step there too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Frame, type Page } from "playwright-core";

import { translate, type Locale } from "@/lib/i18n";

import { buildWorld } from "./demo/world";

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = process.env.LANDING_DIST_DIR ?? path.join(here, "dist");
const out = process.env.LANDING_RENDER_DIR ?? path.join(os.homedir(), "Pictures/delegatus-review/landing/final");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length) ?? null;
const checkRuns = Number(process.argv.find((arg) => arg.startsWith("--check-request="))?.slice("--check-request=".length) ?? 0);
const fullscreenCheck = process.argv.includes("--check-fullscreen");
const swipeCheck = process.argv.find((arg) => arg.startsWith("--check-swipe="))?.slice("--check-swipe=".length);
if (!fs.existsSync(path.join(dist, "demo/demo.js"))) throw new Error("landing/site/dist is not built: run bun landing/site/build.ts first");
fs.mkdirSync(out, { recursive: true });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
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

/* The orchestrator's answer to the request, by a phrase of it that is plain text. */
const ANSWER = { en: "is on the board", uk: "вже на дошці" } as const;
/* The script moves at 0.65, 5.85, 11.05 and 15.65 seconds. Check the
   delivered request before the first reply, then allow each rendered report
   half a second after its streamed update. Each wait follows the last. */
const TIMES_MS = [300, 1200, 4900, 5200, 4600];

/** How many copies of the request the frame shows, and whether each sits above the answer. */
async function requestBubbles(frame: Frame, lang: Locale) {
  const request = buildWorld(0, lang, 0, []).request;
  return frame.evaluate(({ request, answer }) => {
    /* The composer's one-line delivery receipt quotes the message too; it is not a chat row. */
    /* The feed binds short words to the next one with no-break spaces. */
    const words = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ");
    const leaves = (text: string) => [...document.querySelectorAll<HTMLElement>("body *")].filter((el) =>
      (el.getClientRects().length > 0 || getComputedStyle(el).display === "contents") && !el.closest("[data-delivery-echo]") && words(el).includes(text) && ![...el.children].some((child) => words(child).includes(text)));
    /* A display: contents wrapper has no box of its own; its parent's stands for it. */
    const top = (el: HTMLElement) => (el.getClientRects().length ? el : el.parentElement!).getBoundingClientRect().top;
    const answers = leaves(answer).map(top);
    const copies = leaves(request).map(top);
    return { copies: copies.length, belowAnswer: copies.filter((top) => answers.some((at) => top > at)).length, answered: answers.length > 0 };
  }, { request, answer: ANSWER[lang] });
}

async function checkRequest(lang: Locale, viewport: (typeof VIEWPORTS)[number], run: number): Promise<string[]> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, colorScheme: "dark",
    ...(viewport.phone ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${base}?lang=${lang}`);
  const hero = await frameOf(page, ".live-hero");
  await settle(page, 1500);
  const failures: string[] = [];
  await hero.locator(`[aria-label="${translate(lang, "composer.sendToAgent")}"]`).first().click();
  if (viewport.phone) await page.locator('.hero [data-hero-view="orchestrator"]').click();
  for (let at = 1; at <= 5; at += 1) {
    await settle(page, TIMES_MS[at - 1]!);
    const seen = await requestBubbles(hero, lang);
    if (seen.copies !== 1 || seen.belowAnswer > 0 || (at >= 2 && !seen.answered)) failures.push(`${lang}-${viewport.name} run ${run} step ${at}: ${JSON.stringify(seen)}`);
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
    ["hero-composer", ".live-hero iframe"],
    ["hero-demo", ".live-hero iframe"],
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
      if (surface.endsWith("demo") || surface === "hero-composer") {
        await page.locator(selector.replace(" iframe", "")).scrollIntoViewIfNeeded();
        await frameOf(page, selector.replace(" iframe", ""));
      }
      for (const direction of ["down", "up"] as const) {
        if (swipeCheck === "after" && (surface.endsWith("demo") || surface === "hero-composer")) {
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
        if (surface === "hero-composer") {
          const field = (await frameOf(page, ".live-hero")).locator("textarea").first();
          await field.waitFor({ state: "visible" });
          let rect = await field.boundingBox();
          if (!rect) throw new Error("hero composer has no box");
          await page.evaluate((dy) => scrollBy(0, dy), rect.y + rect.height / 2 - 420);
          rect = await field.boundingBox();
          if (!rect) throw new Error("hero composer moved out of view");
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
      const hero = await frameOf(page, ".live-hero");
      const composer = hero.locator("textarea").first();
      await composer.fill("A visitor can still type in this field");
      if (await composer.inputValue() !== "A visitor can still type in this field") throw new Error(`${lang}: composer did not accept typing`);

      // A short flick must keep moving after release, unlike an immediate scrollBy.
      await page.locator(".live-hero").scrollIntoViewIfNeeded();
      await hero.evaluate(() => {
        for (const node of document.querySelectorAll<HTMLElement>("*")) {
          if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
        }
      });
      const heroBox = await page.locator(".live-hero iframe").boundingBox();
      if (!heroBox) throw new Error("hero frame has no box");
      const flickX = Math.round(heroBox.x + heroBox.width / 2);
      const flickY = Math.round(heroBox.y + Math.min(heroBox.height / 2, 400));
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
      console.log(`${lang} hero flick coast: ${atRelease} -> ${afterCoast} (${afterCoast - atRelease})`);
      if (afterCoast - atRelease < 40) throw new Error(`${lang}: hero flick stopped without momentum`);

      // A new gesture on the landing must take over from a forwarded iframe flick.
      for (const interruption of ["touch", "wheel"] as const) {
        await page.locator(".live-hero").scrollIntoViewIfNeeded();
        const box = await page.locator(".live-hero iframe").boundingBox();
        if (!box) throw new Error("hero frame has no box");
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
  const frames = [["hero", ".live-hero"], ["run", ".live-run"], ["open", ".live-open"], ["phone", ".live-phone"]] as const;
  const LABELS = { en: { enter: "Full screen", exit: "Exit full screen" }, uk: { enter: "На весь екран", exit: "Вийти з повного екрана" } };
  const failures: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const modeOnly = process.argv.find((arg) => arg.startsWith("--fs-mode="))?.slice("--fs-mode=".length);
  for (const mode of ["native", "overlay"] as const) {
    if (modeOnly && modeOnly !== mode) continue;
    for (const lang of ["en", "uk"] as Locale[]) {
      for (const viewport of VIEWPORTS) {
        if (only && only !== `${lang}-${viewport.name}`) continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, colorScheme: "dark",
          ...(viewport.phone ? { hasTouch: true, isMobile: true } : {}),
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
          if (lw !== vw || lh !== hh || hw !== vw) fail(`iframe ${inside.layout}, frame area ${inside.host}, viewport ${inside.viewport}`);
          if (inside.chrome !== vh - hh || inside.rootBox !== `0,0 ${vw}x${vh}`) fail(`root ${inside.rootBox}, chrome ${inside.chrome}`);
          if (inside.transform !== "none") fail(`scale is ${inside.transform}`);
          if (inside.src !== before.src || (await page.locator(`${selector} iframe`).last().elementHandle().then((h) => h && handle && h.evaluate((a, b) => a === b, handle)).catch(() => false)) !== true) fail("iframe reloaded");
          if (inside.covers.length) fail(`exit control covers ${inside.covers.join(", ")}`);
          if (inside.label !== LABELS[lang].exit || before.label !== LABELS[lang].enter) fail(`labels "${before.label}" / "${inside.label}"`);
          await page.screenshot({ path: path.join(dir, `${lang}-${viewport.name}-${name}-${mode}.png`) });
          if (name === "hero" && mode === "overlay") {
            /* The hero's step bar works from inside full screen. */
            await page.locator('[data-step="3"]').click();
            await settle(page, 800);
            if ((await page.locator('[data-step="3"][aria-current="step"]').count()) !== 1) fail("hero step bar did not answer in full screen");
            /* The window changing size while full screen. */
            await page.setViewportSize({ width: viewport.width === 1440 ? 1100 : 360, height: viewport.height === 900 ? 700 : 640 });
            await settle(page, 700);
            const resized = await measure(selector);
            const [rw, rh] = resized.viewport.split("x").map(Number);
            const [w2, h2] = resized.layout.split("x").map(Number);
            const [, hh2] = resized.host.split("x").map(Number);
            if (w2 !== rw || h2 !== hh2 || resized.transform !== "none") fail(`after resize iframe ${resized.layout} in ${resized.viewport}`);
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
    for (const surface of ["hero", "phone"]) {
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
    await page.evaluate(() => { (window as any).perfRecords.length = 0; });
    await page.locator('.sec-open [data-view="search"]').click();
    await page.locator(".live-open .demo-retry").waitFor();
    const falseAck = await page.evaluate(() => (window as any).perfRecords.some((r: any) => r.type === "view-ack" && r.view === "search"));
    if (falseAck || await frame.locator("[data-search-result]").count()) throw new Error("empty Search was acknowledged ready");
    await page.locator(".live-open").screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-search-retry.png`) });
    await frame.evaluate(() => (window as any).restoreSearch());
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
      await frameOf(page, ".live-hero");
      const readyMs = await page.evaluate(() => performance.now());
      await page.waitForTimeout(700);
      return page.evaluate((readyMs) => ({ readyMs, navigation: performance.getEntriesByType("navigation")[0]?.toJSON(), records: (window as any).perfRecords }), readyMs);
    });
    await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-loaded.png`) });
    if (process.argv.includes("--load-only")) return;
    await trace("steps", async () => {
      const rows = [];
      const hero = await frameOf(page, ".live-hero");
      for (const step of [2, 3, 4, 5, 0]) {
        const button = page.locator(`button[data-step="${step}"]`);
        await button.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await page.evaluate(() => { (window as any).stepClick = 0; document.addEventListener("click", () => { (window as any).stepClick = performance.now(); }, { once: true, capture: true }); });
        await button.click();
        await page.waitForFunction(step => document.querySelector("[data-step-hint]")?.getAttribute("data-step") === String(step), step);
        const current = await frameOf(page, ".live-hero");
        await current.waitForFunction(step => document.documentElement.dataset.demoStep === String(step), step);
        const stateMs = await page.evaluate(() => performance.now() - (window as any).stepClick);
        if (step === 2) await current.waitForFunction(() => document.body.innerText.replace(/\s+/g, " ").includes("Idempotent refunds"));
        if (step === 3) await current.waitForFunction(() => document.body.innerText.replace(/\s+/g, " ").includes("Build passed"));
        if (step === 4) {
          try { await current.waitForFunction(() => document.body.innerText.replace(/\s+/g, " ").includes("passed review with no findings: two"), undefined, { timeout: 4000 }); }
          catch (error) {
            await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-step4.png`) });
            fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}-step4.txt`), await current.locator("body").innerText());
            if (perfLabel === "after") throw error;
            rows.push({ step, stateMs, visibleMs: null, error: "report not visible after 4 seconds" });
            continue;
          }
        }
        if (step === 5) {
          try { await current.waitForFunction(() => !!document.querySelector('[data-id="task:t-retries"][data-attention="needs"], [data-mobile2-section="needs"], [data-pstate="needs_decision"]'), undefined, { timeout: 4000 }); }
          catch (error) {
            await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-step5.png`) });
            fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}-step5.txt`), await current.locator("body").innerText());
            if (perfLabel === "after") throw error;
            rows.push({ step, stateMs, visibleMs: null, error: "decision not visible after 4 seconds" });
            continue;
          }
        }
        rows.push({ step, stateMs, visibleMs: await page.evaluate(() => performance.now() - (window as any).stepClick) });
      }
      return rows;
    });
    if (process.argv.includes("--steps-only")) return;
    await trace("playback", async () => {
      const hero = await frameOf(page, ".live-hero");
      await hero.locator(`[aria-label="${translate("en", "composer.sendToAgent")}"]`).first().click();
      await page.waitForFunction(() => document.querySelector("[data-step-hint]")?.getAttribute("data-step") === "5", undefined, { timeout: 30_000 });
      return page.evaluate(() => (window as any).perfRecords.filter((r: any) => r.type === "message" && r.data?.type === "dlg:state"));
    });
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
    result.frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), records: await frame.evaluate(() => (window as any).perfRecords) })));
    const acknowledgements = await page.evaluate(() => (window as any).perfRecords.filter((r: any) => r.type === "view-ack"));
    result.acknowledgements = acknowledgements;
    if (perfLabel === "after" && acknowledgements.some((r: any) =>
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
    if (perfLabel === "after" && (result.language as any).value.some((row: any) => Math.abs(row.delta) > 2)) throw new Error("language switch moved the page");
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (error) {
    await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-failure.png`) });
    const frames = await Promise.all(page.frames().map(async frame => frame.evaluate(() => ({
      url: location.href, hash: location.hash, screen: document.querySelector("[data-mobile2-screen]")?.getAttribute("data-mobile2-screen"),
      search: document.querySelector<HTMLInputElement>("[data-search-input]")?.value,
      results: document.querySelectorAll("[data-search-result]").length, records: (window as any).perfRecords,
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

if (checkRuns > 0) {
  const failures: string[] = [];
  for (let run = 0; run < checkRuns; run += 1) {
    const combos = (["en", "uk"] as Locale[]).flatMap((lang) => VIEWPORTS.map((viewport) => ({ lang, viewport })))
      .filter(({ lang, viewport }) => !only || only === `${lang}-${viewport.name}`);
    for (const { lang, viewport } of combos) failures.push(...await checkRequest(lang, viewport, run));
    console.log(`run ${run}: ${failures.length ? `${failures.length} failure(s) so far` : "one request, above the answer, at every step"}`);
  }
  await browser.close();
  server.stop(true);
  for (const failure of failures) console.error(failure);
  process.exit(failures.length ? 1 : 0);
}

/* `--gallery` renders the Product Hunt gallery that docs/launch/product-hunt.md
   lists: each slide is the demo at one step and view, framed with its caption
   at 1270×760 and twice the pixels, then the install slide, the 240×240
   thumbnail and the repository's 1280×640 social preview. English only, the
   language of the launch. PNGs go to <out>/gallery/ and are never committed. */
type GallerySlide = { file: string; title: string; sub: string; query?: string; phone?: string[]; install?: true };
const GALLERY: GallerySlide[] = [
  { file: "01-orchestrator", query: "step=5&view=board", title: "Delegate everything.",
    sub: "Tell one orchestrator what you want shipped. It plans the work, runs Claude Code, Codex and Copilot agents, and reports back." },
  { file: "02-pipeline", query: "step=5&view=pipeline", title: "Build, review, verify. On its own.",
    sub: "Every task gets a worktree, a builder and a fresh read-only reviewer on another engine. A failed review goes back to the builder." },
  { file: "03-decision", query: "step=5&view=decision", title: "It stops only when the call is yours.",
    sub: "A decision waits on its card with the finding and the ways forward. Merging on a passed review is your switch, off by default." },
  { file: "04-conversation", query: "step=5&view=conversation", title: "Every agent session reads as a chat.",
    sub: "Diffs, commands and their output as cards, streaming live. Press / to search everything any agent wrote, on any engine." },
  { file: "05-accounts", query: "step=5&view=accounts", title: "Your accounts. Your limits, in view.",
    sub: "Several Claude, Codex and Copilot accounts side by side, with their five-hour and weekly windows and when each resets." },
  { file: "06-phone", phone: ["step=5&phone=1&view=board", "step=5&phone=1&view=decision"], title: "Answer from your phone.",
    sub: "The board in your pocket, inside your own tailnet. A push when an agent asks you something. Telegram reports built in." },
  { file: "07-install", install: true, title: "Runs on your machine. Uses your accounts.",
    sub: "Free and open source under MIT. Claude Code, Codex and GitHub Copilot. macOS, Linux, and Windows through WSL 2." },
];
/* The demo is captured this wide and cropped to the slide's frame: 1174×554 CSS pixels. */
const GALLERY_DEMO = { width: 1600, height: 756 };
const GALLERY_PHONE = { width: 390, height: 812 };

/* The install slide's claim, counted when it renders from the default branch's
   own line of merges (origin/main when the clone has it), so a feature branch
   that merged main in counts the same pull requests main does. */
function builtWithItself(days = 30) {
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: here }).stdout.toString().trim();
  if (git("rev-parse", "--is-shallow-repository") === "true") throw new Error("--gallery counts merged pull requests: fetch the full history first (git fetch --unshallow)");
  const ref = git("rev-parse", "--verify", "--quiet", "origin/main") ? "origin/main" : "HEAD";
  const merged = git("log", ref, "--first-parent", `--since=${days} days ago`, "--format=%s%x09%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)")
    .split("\n").map((line) => line.split("\t")).filter(([subject]) => /\(#\d+\)$/.test(subject ?? ""));
  return { days, ref, merged: merged.length, byAgents: merged.filter(([, trailers]) => /Claude|Codex|Copilot/.test(trailers ?? "")).length };
}

async function renderGallery() {
  const dir = path.join(out, "gallery");
  fs.mkdirSync(dir, { recursive: true });
  const brand = (name: string) => fs.readFileSync(path.join(here, "../../public/brand", name));
  const uri = (type: string, data: Buffer) => `data:${type};base64,${data.toString("base64")}`;
  const mark = uri("image/svg+xml", brand("delegatus-mark.svg"));
  const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  const counted = builtWithItself();
  const fonts = await inlineFonts(GALLERY_FONTS);

  async function demoShot(query: string, phone: boolean): Promise<string> {
    const size = phone ? GALLERY_PHONE : GALLERY_DEMO;
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: "dark", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    const page = await context.newPage();
    await page.goto(`${base}demo/index.html?lang=en&${query}`);
    await settle(page, phone ? 5000 : 6000);
    const shot = await page.screenshot();
    await context.close();
    return uri("image/png", shot);
  }

  const page = await browser.newPage({ viewport: { width: 1270, height: 760 }, deviceScaleFactor: 2, colorScheme: "dark" });
  const render = async (html: string, file: string, size = { width: 1270, height: 760 }) => {
    await page.setViewportSize(size);
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (html.includes("@font-face") && !await page.evaluate(() => document.fonts.check('700 38px "Unbounded"'))) throw new Error(`${file}: the caption face did not load`);
    /* A caption that wraps would run into the frame below it. */
    const overflow = await page.evaluate(() => [...document.querySelectorAll("[data-one-line]")].filter((el) => el.scrollWidth > el.clientWidth || el.getBoundingClientRect().height > 60).length);
    if (overflow) throw new Error(`${file}: a one-line caption wraps`);
    await page.screenshot({ path: path.join(dir, `${file}.png`) });
    console.log(`gallery: ${file}.png`);
  };
  const head = (slide: GallerySlide, oneLine = true) => `<h1${oneLine ? " data-one-line" : ""}>${escape(slide.title)}</h1><p class="sub">${escape(slide.sub)}</p>`;
  const brandTag = `<div class="brand"><img src="${mark}" alt=""><span>Delegatus</span></div>`;

  for (const slide of GALLERY) {
    let body: string;
    if (slide.phone) {
      const shots = await Promise.all(slide.phone.map((query) => demoShot(query, true)));
      body = `<div class="side">${head(slide, false)}${brandTag}</div><div class="phones">${shots.map((src) => `<div class="handset"><img src="${src}" alt=""></div>`).join("")}</div>`;
    } else if (slide.install) {
      body = `<div class="install"><img class="big-mark" src="${mark}" alt="">${head(slide)}<code>bunx delegatus-cli</code>`
        + `<p class="fact">Built with itself: ${counted.byAgents} of the ${counted.merged} pull requests merged in the last ${counted.days} days were co-authored by the agents it runs.</p>`
        + `<p class="url">delegatus.org</p></div>`;
    } else {
      body = `<div class="head">${head(slide)}</div>${brandTag}<div class="shot"><img src="${await demoShot(slide.query!, false)}" alt=""></div>`;
    }
    await render(GALLERY_PAGE(fonts, body), slide.file);
  }
  await render(`<!doctype html><body style="margin:0"><img src="${uri("image/svg+xml", brand("delegatus-touch-icon.svg"))}" style="display:block;width:240px;height:240px">`, "thumbnail", { width: 240, height: 240 });
  await render(`<!doctype html><body style="margin:0"><img src="${uri("image/svg+xml", brand("delegatus-social-card.svg"))}" style="display:block;width:1280px;height:640px">`, "social-preview", { width: 1280, height: 640 });
  await page.close();
  console.log(`gallery in ${dir} (${counted.byAgents}/${counted.merged} agent-co-authored merges on ${counted.ref} in ${counted.days} days)`);
}

/* The landing's own faces. The slide carries them inline, fetched here rather
   than by the browser, so a slide never renders in a fallback face. */
const GALLERY_FONTS = "https://fonts.googleapis.com/css2?family=Geologica:wght@300..600&family=Martian+Mono:wght@400;500&family=Unbounded:wght@600;700&display=swap";
async function inlineFonts(url: string): Promise<string> {
  const agent = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" };
  const css = await (await fetch(url, { headers: agent })).text();
  const files = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) ?? [])];
  if (!files.length) throw new Error("--gallery could not load the landing's fonts");
  const inlined = await Promise.all(files.map(async (file) => [file, Buffer.from(await (await fetch(file)).arrayBuffer()).toString("base64")] as const));
  return inlined.reduce((text, [file, data]) => text.replaceAll(file, `data:font/woff2;base64,${data}`), css);
}

const GALLERY_PAGE = (fonts: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>${fonts}</style>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1270px; height: 760px; overflow: hidden; position: relative; color: #fbebdd; font-family: Geologica, sans-serif;
    background: radial-gradient(900px 520px at 88% -12%, rgba(139, 124, 246, .22), transparent 62%),
      radial-gradient(700px 420px at -8% 112%, rgba(224, 57, 43, .13), transparent 60%), #111218; }
  h1 { font: 700 38px/1.18 Unbounded, sans-serif; letter-spacing: -.01em; white-space: nowrap; }
  .sub { margin-top: 14px; font-size: 20px; line-height: 1.45; color: #b8bcca; }
  .head { position: absolute; top: 40px; left: 48px; width: 960px; }
  .brand { position: absolute; top: 44px; right: 48px; display: flex; gap: 10px; align-items: center; font: 600 17px Unbounded, sans-serif; }
  .brand img { width: 26px; height: 26px; }
  .shot { position: absolute; left: 48px; right: 48px; top: 206px; bottom: 0; border-radius: 14px 14px 0 0; overflow: hidden;
    border: 1px solid #353a4a; border-bottom: 0; box-shadow: 0 30px 80px rgba(0, 0, 0, .55), 0 0 0 6px rgba(255, 255, 255, .03); }
  .shot img { display: block; width: 100%; }
  .side { position: absolute; left: 56px; top: 0; bottom: 0; width: 470px; display: flex; flex-direction: column; justify-content: center; }
  .side h1 { white-space: normal; }
  .side .brand { position: absolute; top: auto; right: auto; bottom: 44px; left: 0; }
  .phones { position: absolute; right: 64px; top: 0; bottom: 0; display: flex; gap: 30px; align-items: center; }
  .handset { width: 318px; padding: 9px; border-radius: 44px; background: #05060a; border: 1px solid #3a3f50; box-shadow: 0 30px 80px rgba(0, 0, 0, .6); }
  .handset img { display: block; width: 300px; border-radius: 35px; }
  .install { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 90px; }
  .install .big-mark { width: 96px; height: 96px; margin-bottom: 30px; }
  .install .sub { max-width: 900px; }
  .install code { margin-top: 38px; padding: 18px 34px; border-radius: 14px; background: #191b23; border: 1px solid #353a4a; font: 500 30px "Martian Mono", monospace; color: #fbebdd; }
  .install code::before { content: "$ "; color: #7d8193; }
  .install .fact { margin-top: 34px; font-size: 18px; color: #9fe0b5; }
  .install .url { position: absolute; bottom: 36px; font: 600 16px Unbounded, sans-serif; color: #7d8193; letter-spacing: .02em; }
</style></head><body>${body}</body></html>`;

if (process.argv.includes("--gallery")) {
  await renderGallery();
  await browser.close();
  server.stop(true);
  process.exit(0);
}

for (const lang of ["en", "uk"] as Locale[]) {
  for (const viewport of VIEWPORTS) {
    const key = `${lang}-${viewport.name}`;
    if (only && only !== key) continue;
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, colorScheme: "dark",
      ...(viewport.phone ? { hasTouch: true, isMobile: true } : {}),
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}?lang=${lang}`);
    const hero = await frameOf(page, ".live-hero");
    await settle(page, 2500);
    await page.screenshot({ path: path.join(out, `${key}-first-screen.png`) });

    /* Walk down so every frame loads, then take the page whole. */
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += viewport.height / 2) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await settle(page, 150);
    }
    for (const selector of [".live-run", ".live-open", ".live-phone"]) await frameOf(page, selector);
    await settle(page, 3000);

    await shoot(page, ".hero", `${key}-1-hero.png`);
    await shoot(page, ".sec-run", `${key}-2-run.png`);
    await shoot(page, ".sec-open", `${key}-3-open.png`);
    await shoot(page, ".sec-reach", `${key}-4-reach.png`);
    await shoot(page, ".band", `${key}-5-footer.png`);

    /* The hero's script, the way a visitor runs it. */
    const demo = ".hero .stage-wrap";
    await shoot(page, demo, `${key}-demo-0-request.png`);
    const send = translate(lang, "composer.sendToAgent");
    await hero.locator(`[aria-label="${send}"]`).first().click();
    for (const [index, name] of ["1-sent", "2-task", "3-build", "4-review", "5-needs-you"].entries()) {
      await settle(page, TIMES_MS[index]!);
      await shoot(page, demo, `${key}-demo-${name}.png`);
    }

    /* The other faces of each frame, through the page's own tabs. */
    const tab = async (selector: string, settleMs: number, file: string, target: string) => {
      await page.locator(selector).first().click();
      await page.waitForFunction(() => !document.querySelector(".live[data-busy]"), undefined, { timeout: 20_000 });
      await settle(page, settleMs);
      await shoot(page, target, file);
    };
    await tab('.hero [data-hero-view="orchestrator"]', 1600, `${key}-demo-view-orchestrator.png`, demo);
    await tab('.sec-run [data-view="decision"]', 2200, `${key}-2-run-decision.png`, ".sec-run .stage-wrap");
    for (const view of ["search", "accounts", "overview"]) {
      await tab(`.sec-open [data-view="${view}"]`, 2600, `${key}-3-open-${view}.png`, viewport.phone ? ".live-open" : ".sec-open");
    }
    await tab('.seg-phone [data-view="decision"]', 1800, `${key}-4-reach-decision.png`, ".reach-art");
    await tab('.seg-phone [data-view="reports"]', 1800, `${key}-4-reach-reports.png`, ".reach-art");

    /* The page whole, every frame loaded: each is brought into view first so it renders. */
    for (const selector of [".live-open", ".live-run", ".live-phone", ".live-hero"]) {
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
      unanswered: await hero.evaluate(() => (window as unknown as { demoUnanswered?: string[] }).demoUnanswered ?? []),
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
