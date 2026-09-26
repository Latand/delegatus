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
const base = `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable" });
const report: Record<string, unknown> = {};

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, phone: false },
  { name: "390", width: 390, height: 844, phone: true },
] as const;

const settle = (page: Page, ms: number) => page.waitForTimeout(ms);

async function frameOf(page: Page, selector: string): Promise<Frame> {
  const handle = await page.waitForSelector(`${selector} iframe`, { state: "attached", timeout: 20_000 });
  const frame = await handle.contentFrame();
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

if (checkRuns > 0) {
  const failures: string[] = [];
  for (let run = 0; run < checkRuns; run += 1) {
    const combos = (["en", "uk"] as Locale[]).flatMap((lang) => VIEWPORTS.map((viewport) => ({ lang, viewport })))
      .filter(({ lang, viewport }) => !only || only === `${lang}-${viewport.name}`);
    for (const found of await Promise.all(combos.map(({ lang, viewport }) => checkRequest(lang, viewport, run)))) failures.push(...found);
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
