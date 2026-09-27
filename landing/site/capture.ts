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
const dist = path.join(here, "dist");
const out = process.env.LANDING_RENDER_DIR ?? path.join(os.homedir(), "Pictures/delegatus-review/landing/final");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length) ?? null;
const checkRuns = Number(process.argv.find((arg) => arg.startsWith("--check-request="))?.slice("--check-request=".length) ?? 0);
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
/* When to look after the send, each wait after the last. The script moves at
   2.6 s, 7.8 s, 13 s and 17.6 s after the send, and the feed polls every
   1.2 s, so each look falls a poll or more after its step arrived. */
const TIMES_MS = [900, 3800, 4200, 5300, 5000];

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
    });
    addEventListener("scroll", () => records.push({ type: "scroll", at: performance.now(), y: scrollY }));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const result: Record<string, unknown> = { url: base, cpuThrottle: 4, viewport, errors };
  async function trace(name: string, action: () => Promise<unknown>) {
    await browser.startTracing(page, { screenshots: false, categories: ["devtools.timeline", "v8", "blink.user_timing", "disabled-by-default-devtools.timeline", "toplevel"] });
    const value = await action();
    const data = await browser.stopTracing();
    fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}-${name}.trace.json`), data);
    const events = JSON.parse(data.toString()).traceEvents as { name: string; dur?: number; args?: { data?: { url?: string } } }[];
    const sum = (name: string) => events.filter(e => e.name === name).reduce((s, e) => s + (e.dur ?? 0) / 1000, 0);
    const tasks = events.filter(e => e.name === "RunTask" && (e.dur ?? 0) >= 50_000);
    result[name] = { value, trace: { longTasks: tasks.length, longTaskMs: tasks.reduce((s,e) => s + e.dur! / 1000, 0), blockingMs: tasks.reduce((s,e) => s + e.dur! / 1000 - 50, 0), evaluateScriptMs: sum("EvaluateScript"), evaluateModuleMs: sum("v8.evaluateModule"), compileMs: sum("v8.compile"), layoutMs: sum("Layout"), paintMs: sum("Paint"), demoEvalMs: events.filter(e => /evaluate/i.test(e.name) && e.args?.data?.url?.includes("demo.js")).reduce((s,e) => s + (e.dur ?? 0) / 1000, 0) } };
    fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}.json`), JSON.stringify(result, null, 2));
    console.log(`${perfLabel}-${viewport.name} ${name}: ${JSON.stringify(result[name])}`);
  }
  try {
    await trace("load", async () => {
      await page.goto(`${base}?lang=en`, { waitUntil: "load" });
      await frameOf(page, ".live-hero");
      const readyMs = await page.evaluate(() => performance.now());
      await page.waitForTimeout(700);
      return page.evaluate((readyMs) => ({ readyMs, navigation: performance.getEntriesByType("navigation")[0]?.toJSON(), records: (window as any).perfRecords }), readyMs);
    });
    await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-loaded.png`) });
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
        const stateMs = await page.evaluate(() => performance.now() - (window as any).stepClick);
        const current = await frameOf(page, ".live-hero");
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
        if (step === 5) await current.waitForFunction(() => !!document.querySelector('[data-id="task:t-retries"]') || document.body.innerText.replace(/\s+/g, " ").includes("Webhook retries"));
        rows.push({ step, stateMs, visibleMs: await page.evaluate(() => performance.now() - (window as any).stepClick) });
      }
      return rows;
    });
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
        if (view === "search") await frame.waitForFunction(() => !!document.querySelector('input[type="search"], [role="dialog"] input'));
        if (view === "accounts") await frame.waitForFunction(() => document.body.innerText.replace(/\s+/g, " ").includes("Max"));
        rows.push({ view, visibleMs: Date.now() - start });
      }
      return rows;
    });
    await trace("language", async () => {
      for (const selector of [".live-run", ".live-open", ".live-phone"]) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        await frameOf(page, selector);
      }
      const rows = [];
      for (const lang of ["uk", "en", "uk", "en"]) {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await page.waitForTimeout(600);
        const before = await page.evaluate(() => scrollY);
        await page.locator(`button[data-lang="${lang}"]`).click();
        await page.waitForTimeout(7000);
        const after = await page.evaluate(() => scrollY);
        rows.push({ lang, before, after, delta: after - before });
      }
      return rows;
    });
    result.frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), records: await frame.evaluate(() => (window as any).perfRecords) })));
    await page.screenshot({ path: path.join(out, `${perfLabel}-${viewport.name}-language.png`) });
    fs.writeFileSync(path.join(out, `${perfLabel}-${viewport.name}.json`), JSON.stringify(result, null, 2));
    console.log(`${perfLabel}-${viewport.name}: complete`);
    if (perfLabel === "after" && (result.language as any).value.some((row: any) => Math.abs(row.delta) > 2)) throw new Error("language switch moved the page");
    if (errors.length) throw new Error(errors.join("\n"));
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
