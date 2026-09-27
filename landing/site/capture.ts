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

/* The install slide's claim, counted from this checkout's history when it renders. */
function builtWithItself(days = 30) {
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: here }).stdout.toString().trim();
  if (git("rev-parse", "--is-shallow-repository") === "true") throw new Error("--gallery counts merged pull requests: fetch the full history first (git fetch --unshallow)");
  const merged = git("log", "--first-parent", `--since=${days} days ago`, "--format=%s%x09%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)")
    .split("\n").map((line) => line.split("\t")).filter(([subject]) => /\(#\d+\)$/.test(subject ?? ""));
  return { days, merged: merged.length, byAgents: merged.filter(([, trailers]) => /Claude|Codex|Copilot/.test(trailers ?? "")).length };
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
  console.log(`gallery in ${dir} (${counted.byAgents}/${counted.merged} agent-co-authored merges in ${counted.days} days)`);
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
