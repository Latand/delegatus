import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import postcss from "postcss";

import { translate } from "@/lib/i18n";

/*
 * Browser evidence for #1671 at phone width, in both colour schemes, against
 * the production stylesheet and the real Viewer (`issue1671Evidence.fixture.tsx`):
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx
 *
 * happy-dom has no compositor, so what only a browser can settle is settled
 * here with real touch input — CDP `Input.dispatchTouchEvent`, so the row's
 * `touch-action: pan-y` meets Chromium's own gesture recognizer:
 *
 *   - a vertical drag that starts on a row scrolls the board and opens nothing;
 *   - a horizontal drag reveals a tray whose buttons are at least 44 px, sit
 *     beside the card and inside the phone;
 *   - Hide takes the row and the bar's count on the tap, Restore brings both
 *     back, and a hide the server refuses puts both back and says why;
 *   - Close lane takes the row on the tap and sends nothing once Restore
 *     cancelled it;
 *   - a long-press opens the actions sheet and not the lane under the finger;
 *   - a conversation's Close writes only the board, and Reopen round-trips;
 *   - «All conversations» appends the feed's rows first with no request, then
 *     project pages, in identical rows, with no search field and no repeats.
 *
 * Measurements go to `evidence/issue-1671/geometry.json`; frames to
 * `.artifacts/issue-1671/`, which is not committed.
 */

const browserTest = process.env.LLV_SWIPE_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1671");
const EVIDENCE = path.resolve("evidence/issue-1671");
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 430, height: 932 }] as const;
const SCHEMES = ["light", "dark"] as const;

type Point = [number, number];
interface Rect { x: number; y: number; width: number; height: number }
interface Recorded {
  catalogRequests: string[];
  pipelinePatches: Array<{ id: string; action: string }>;
  boardMutations: Array<{ kind: string; path?: string }>;
  refuseNextPipelinePatch: boolean;
}

const pause = (page: Page, ms = 300) => page.waitForTimeout(ms);
const along = (from: Point, to: Point, steps = 12): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);

async function touch(cdp: CDPSession, points: Point[], stepMs = 16): Promise<void> {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first![0], y: first![1] }] });
  for (const [x, y] of rest) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const rectOf = (page: Page, selector: string) => page.evaluate((sel): Rect | null => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, selector);

async function centre(page: Page, selector: string): Promise<Point> {
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), selector);
  await pause(page, 250);
  const box = await rectOf(page, selector);
  if (!box) throw new Error(`nothing at ${selector}`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/* A tap where the target already is. Scrolling first would be the operator
   moving the list, which puts an open tray away before the tap lands. */
async function tap(page: Page, cdp: CDPSession, selector: string): Promise<void> {
  const box = await rectOf(page, selector);
  if (!box) throw new Error(`nothing to tap at ${selector}`);
  await touch(cdp, [[box.x + box.width / 2, box.y + box.height / 2]]);
}
const tapInView = async (page: Page, cdp: CDPSession, selector: string) => touch(cdp, [await centre(page, selector)]);

async function swipeLeft(page: Page, cdp: CDPSession, selector: string, width: number): Promise<void> {
  const [, y] = await centre(page, selector);
  await touch(cdp, along([width - 40, y], [width - 250, y + 3]));
  await pause(page, 350);
}

async function run(context: BrowserContext, base: string, viewport: { width: number; height: number }, scheme: "light" | "dark") {
  const key = `${viewport.width}-${scheme}`;
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${key}-${name}.png`) });
  const lane = (i: number) => `[data-mobile2-board] [data-mobile2-swipe-row="pipeline:lane-${i}"]`;
  const count = (selector: string) => page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
  const badge = async () => Number(await page.evaluate(() => document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? "NaN"));
  const receipt = () => page.evaluate(() => document.querySelector("[data-mobile2-receipt]")?.textContent ?? "");
  const recorded = () => page.evaluate(() => structuredClone((window as unknown as { evidence: Recorded }).evidence));
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

  await page.goto(`${base}/#p=atlas`);
  await page.waitForSelector(lane(9), { timeout: 20_000 });
  await pause(page, 800);
  const queued = await badge();
  await shot("board");

  /* 1. A vertical drag that starts on a row scrolls the board and opens nothing. */
  const startY = viewport.height - 220;
  const startedOn = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("[data-mobile2-swipe-row]")?.getAttribute("data-mobile2-swipe-row") ?? null, [viewport.width / 2, startY]);
  await touch(cdp, along([viewport.width / 2, startY], [viewport.width / 2 + 6, startY - 320], 14));
  await pause(page, 700);
  const vertical = {
    startedOn,
    scrollTop: await page.evaluate(() => (document.querySelector("[data-mobile2-board]") as HTMLElement).scrollTop),
    openRows: await count("[data-mobile2-swipe-open]"),
  };
  check("a vertical drag starts on a row", startedOn !== null);
  check("a vertical drag scrolls the board", vertical.scrollTop > 40);
  check("a vertical drag opens no row", vertical.openRows === 0);
  await page.evaluate(() => { (document.querySelector("[data-mobile2-board]") as HTMLElement).scrollTop = 0; });
  await pause(page);

  /* 2. A horizontal drag reveals the tray beside the card, at touch size. */
  await swipeLeft(page, cdp, lane(0), viewport.width);
  const tray = await page.evaluate((sel) => {
    const row = document.querySelector(sel)!;
    const card = row.querySelector("[data-mobile2-swipe-card]")!.getBoundingClientRect();
    return {
      open: row.getAttribute("data-mobile2-swipe-open"),
      touchAction: getComputedStyle(row).touchAction,
      cardLeft: card.left, cardRight: card.right,
      opacity: getComputedStyle(row.querySelector("[data-mobile2-swipe-tray]")!).opacity,
      buttons: [...row.querySelectorAll("[data-mobile2-swipe-action]")].map((button) => {
        const r = button.getBoundingClientRect();
        return { key: button.getAttribute("data-mobile2-swipe-action"), label: button.getAttribute("aria-label"), x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    };
  }, lane(0));
  await shot("tray");
  check("the tray opens", tray.open === "true" && tray.opacity === "1");
  check("the row keeps vertical panning to the browser", tray.touchAction === "pan-y");
  check("the tray holds Hide and Close lane", tray.buttons.map((button) => button.key).join() === "hide,closeLane");
  check("tray buttons are at least 44 px", tray.buttons.every((button) => button.width >= 44 && button.height >= 44));
  check("tray buttons sit beside the card", tray.buttons.every((button) => button.x >= tray.cardRight - 0.5));
  check("tray buttons stay inside the phone", tray.buttons.every((button) => button.x + button.width <= viewport.width + 0.5));

  /* 3. Hide takes the row and the count on the tap; Restore brings both back. */
  await tap(page, cdp, `${lane(0)} [data-mobile2-swipe-action="hide"]`);
  await pause(page, 120);
  const hide = {
    rowGone: (await count(lane(0))) === 0,
    badge: await badge(),
    receipt: await receipt(),
    receiptBox: await rectOf(page, "[data-mobile2-receipt]"),
    dockBox: await rectOf(page, "[data-mobile2-board-dock]"),
    patches: (await recorded()).pipelinePatches,
  };
  await shot("hidden");
  check("Hide takes the row on the tap", hide.rowGone);
  check("Hide takes the bar's count on the tap", hide.badge === queued - 1);
  check("Hide sends dismiss", hide.patches.at(-1)?.action === "dismiss");
  check("the receipt names the lane", hide.receipt.includes(TASK_0));
  check("the receipt sits above the dock", !hide.receiptBox || !hide.dockBox || hide.receiptBox.y + hide.receiptBox.height <= hide.dockBox.y + 0.5);
  await tap(page, cdp, '[data-mobile2-receipt-undo="restore"]');
  await page.waitForSelector(lane(0), { timeout: 5_000 });
  await pause(page, 200);
  const restored = { badge: await badge(), patches: (await recorded()).pipelinePatches };
  check("Restore brings the row and the count back", restored.badge === queued && restored.patches.at(-1)?.action === "undismiss");

  /* 4. A hide the server refuses puts the row and the count back, and says why. */
  await page.evaluate(() => { (window as unknown as { evidence: Recorded }).evidence.refuseNextPipelinePatch = true; });
  await swipeLeft(page, cdp, lane(1), viewport.width);
  await tap(page, cdp, `${lane(1)} [data-mobile2-swipe-action="hide"]`);
  await pause(page, 80);
  const refusedAtOnce = { rowGone: (await count(lane(1))) === 0, badge: await badge() };
  await page.waitForSelector(lane(1), { timeout: 5_000 });
  await pause(page, 250);
  const refused = { ...refusedAtOnce, badgeAfter: await badge(), receipt: await receipt() };
  await shot("refused");
  check("a refused hide still leaves on the tap", refused.rowGone && refused.badge === queued - 1);
  check("a refused hide comes back and says why", refused.badgeAfter === queued && refused.receipt.includes("refused by the evidence fixture"));

  /* 5. Close lane goes on the tap and sends nothing once Restore cancelled it. */
  await swipeLeft(page, cdp, lane(2), viewport.width);
  const sentBefore = (await recorded()).pipelinePatches.length;
  await tap(page, cdp, `${lane(2)} [data-mobile2-swipe-action="closeLane"]`);
  await pause(page, 150);
  const closeLane = { rowGone: (await count(lane(2))) === 0, badge: await badge(), receipt: await receipt() };
  await shot("close-lane");
  await tap(page, cdp, '[data-mobile2-receipt-undo="restore"]');
  await page.waitForSelector(lane(2), { timeout: 5_000 });
  /* Past the receipt's window: a cancelled close is never sent late. */
  await pause(page, 4_400);
  const closeLaneAfter = { badge: await badge(), sent: (await recorded()).pipelinePatches.length - sentBefore };
  check("Close lane takes the row and the count on the tap", closeLane.rowGone && closeLane.badge === queued - 1);
  check("Close lane's receipt says the lane closed", closeLane.receipt.includes(translate("en", "mobile2.pipeline.archived")));
  check("a cancelled Close lane sends nothing", closeLaneAfter.sent === 0 && closeLaneAfter.badge === queued);

  /* 6. A long-press opens the actions sheet and not the lane under the finger. */
  const [pressX, pressY] = await centre(page, lane(3));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pressX, y: pressY }] });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pause(page, 450);
  const longPress = await page.evaluate(() => {
    const sheet = document.querySelector('[data-mobile2-sheet="row"]');
    return {
      sheet: sheet !== null,
      rows: sheet ? [...sheet.querySelectorAll("[data-mobile2-row-action]")].map((row) => ({ key: row.getAttribute("data-mobile2-row-action"), height: row.getBoundingClientRect().height })) : [],
      pipelineScreen: document.querySelector('[data-mobile2-screen="pipeline"]') !== null,
    };
  });
  await shot("long-press");
  check("a long-press opens the actions sheet", longPress.sheet && longPress.rows.map((row) => row.key).join() === "hide,closeLane");
  check("the sheet's rows are at least 44 px", longPress.rows.every((row) => row.height >= 44));
  check("a long-press does not open the lane", !longPress.pipelineScreen);
  await page.evaluate(() => (document.querySelector('[data-mobile2-sheet="row"] [data-mobile2-close]') as HTMLElement | null)?.click());
  await pause(page, 450);

  /* 7. A conversation's Close writes only the board, and Reopen round-trips. */
  const running = '[data-mobile2-board] [data-mobile2-swipe-row="conversation:/repo/running.jsonl"]';
  await swipeLeft(page, cdp, running, viewport.width);
  const conversationTray = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-mobile2-swipe-action]`)].map((button) => button.getAttribute("aria-label")), running);
  await shot("conversation-tray");
  await tap(page, cdp, `${running} [data-mobile2-swipe-action="close"]`);
  await pause(page, 150);
  const conversationGone = (await count(running)) === 0;
  await page.waitForFunction(() => (window as unknown as { evidence: Recorded }).evidence.boardMutations.some((mutation) => mutation.kind === "close"), undefined, { timeout: 5_000 });
  await shot("conversation-closed");
  await tap(page, cdp, '[data-mobile2-receipt-undo="reopen"]');
  const reopened = await page.waitForSelector(running, { timeout: 5_000 }).then(() => true, () => false);
  const conversationClose = {
    tray: conversationTray, rowGone: conversationGone, reopened,
    boardScreen: await count('[data-mobile2-screen="board"]'),
    mutations: (await recorded()).boardMutations.map((mutation) => mutation.kind),
    pipelineWrites: (await recorded()).pipelinePatches.length - sentBefore,
  };
  check("a conversation's tray holds Close card only", conversationTray.length === 1 && String(conversationTray[0]).startsWith(translate("en", "mobile2.chat.menuClose")));
  check("Close card takes the row on the tap", conversationClose.rowGone);
  check("Reopen brings the conversation back to the board", conversationClose.reopened && conversationClose.boardScreen === 1);

  /* 8. «All conversations» appends the same rows: the feed's first, then pages. */
  await tapInView(page, cdp, '[data-mobile2-row="catalog"]');
  await pause(page, 450);
  const rowsSelector = '[data-mobile2-board] [data-mobile2-row="conversation"][data-catalog-path]';
  const expanded = await page.evaluate((sel) => ({
    rows: document.querySelectorAll(sel).length,
    requests: (window as unknown as { evidence: Recorded }).evidence.catalogRequests.length,
    toggle: document.querySelector('[data-mobile2-row="catalog"]')?.textContent ?? "",
  }), rowsSelector);
  await shot("expanded");
  await page.evaluate(() => { const scroller = document.querySelector("[data-mobile2-board]") as HTMLElement; scroller.scrollTop = scroller.scrollHeight; });
  await page.waitForFunction((sel) => [...document.querySelectorAll<HTMLElement>(sel)].filter((row) => row.dataset.catalogPath?.startsWith("/repo/history-")).length >= 20, rowsSelector, { timeout: 10_000 });
  await pause(page, 500);
  const appended = await page.evaluate((sel) => {
    const rows = [...document.querySelectorAll<HTMLElement>(sel)];
    const paths = rows.map((row) => row.dataset.catalogPath ?? "");
    const scroller = document.querySelector("[data-mobile2-board]")!;
    return {
      rows: rows.length,
      unique: new Set(paths).size,
      stored: paths.filter((item) => item.startsWith("/repo/history-")).length,
      rowStyles: new Set(rows.map((row) => row.className)).size,
      heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
      requests: (window as unknown as { evidence: Recorded }).evidence.catalogRequests,
      searchFields: document.querySelectorAll('input[type="search"]').length,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      boardOverflow: scroller.scrollWidth > scroller.clientWidth,
    };
  }, rowsSelector);
  await shot("appended");
  check("expanding appends the feed's thirty rows with no request", expanded.rows === 30 && expanded.requests === 0);
  check("the expanded row reads Show fewer", expanded.toggle.includes(translate("en", "mobile2.board.showFewer")));
  check("catalog pages append below the feed's rows", appended.stored >= 20);
  check("no row appears twice", appended.unique === appended.rows);
  check("every appended row is the same row", appended.rowStyles === 1 && appended.heights.length === 1);
  check("catalog requests are this project's pages with no query",appended.requests.length > 0 && appended.requests.every((query) => query.includes("project=atlas") && query.includes("limit=20") && !/[?&]q=/.test(query)));
  check("no search field anywhere", appended.searchFields === 0);
  check("nothing overflows the phone sideways", !appended.pageOverflow && !appended.boardOverflow);
  check("no page errors", pageErrors.length === 0);

  await page.close();
  return { key, viewport, scheme, queued, vertical, tray, hide, restored, refused, closeLane: { ...closeLane, ...closeLaneAfter }, longPress, conversationClose, expanded, appended, pageErrors, failures };
}

const TASK_0 = "Fast conversation switching";

browserTest("#1671 at phone width: real touches on the real Viewer, in both schemes", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const build = await Bun.build({
    entrypoints: [path.resolve("src/components/mobile/issue1671Evidence.fixture.tsx")],
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
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const results: Awaited<ReturnType<typeof run>>[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        try {
          results.push(await run(context, `http://127.0.0.1:${server.port}`, viewport, scheme));
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((result) => result.failures.length > 0);
  if (failed.length) throw new Error(JSON.stringify(failed.map((result) => ({ key: result.key, failures: result.failures, pageErrors: result.pageErrors })), null, 2));
}, 300_000);
