import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";

import { serveEvidenceFixture } from "@/components/kanban/issue1695BrowserHarness";
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
 *   - a lane hidden since its last round stays off the board, and a lane that
 *     parked again after its Hide is back in Needs you and in the badge;
 *     hidden again, it stays off both once the server answers, in every
 *     painted frame, although the server keeps a lane's first Hide instant;
 *   - Hide takes the row and the bar's count on the tap, Restore brings both
 *     back, and a hide the server refuses puts both back and says why;
 *   - Close lane takes the row on the tap and sends nothing once Restore
 *     cancelled it; a close that has gone out keeps its row gone until the
 *     server answers, and a second close inside the window keeps the first gone;
 *   - a long-press opens the actions sheet and not the lane under the finger;
 *   - a conversation's Close writes only the board, and Reopen round-trips;
 *   - «All conversations» appends the feed's rows first with no request, then
 *     project pages, in identical rows, with no search field, no repeats and
 *     no superseded round.
 *
 * Measurements go to `evidence/issue-1671/geometry.json`; frames to
 * `.artifacts/issue-1671/`, which is not committed.
 */

const browserTest = process.env.LLV_SWIPE_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1671");
const EVIDENCE = path.resolve("evidence/issue-1671");
/** The fixture's running conversation, under its managed account's home. */
const runningPath = (account: string) => `/state/agent-log-viewer/shared/accounts/claude/${account}/projects/atlas/running.jsonl`;
const RUNNING_PATH = runningPath("spare");
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 430, height: 932 }] as const;
const SCHEMES = ["light", "dark"] as const;

type Point = [number, number];
interface Rect { x: number; y: number; width: number; height: number }
interface Recorded {
  catalogRequests: string[];
  pipelinePatches: Array<{ id: string; action: string }>;
  closesAnswered: string[];
  hidesAnswered: Array<{ id: string; action: string; dismissedAt: string | null }>;
  boardMutations: Array<{ kind: string; path?: string }>;
  refuseNextPipelinePatch: boolean;
  pipelineAnswerDelayMs: number;
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

async function swipeLeft(page: Page, cdp: CDPSession, selector: string, width: number): Promise<void> {
  const [, y] = await centre(page, selector);
  await touch(cdp, along([width - 40, y], [width - 250, y + 3]));
  await pause(page, 350);
}

/* The target's rect once two reads 120 ms apart agree: nothing above it is
   still arriving, so a tap measured now lands where it was measured. */
async function stableRect(page: Page, selector: string): Promise<Rect> {
  let last = await rectOf(page, selector);
  for (let i = 0; i < 25; i += 1) {
    await pause(page, 120);
    const next = await rectOf(page, selector);
    if (last && next && Math.abs(next.y - last.y) < 0.5 && Math.abs(next.height - last.height) < 0.5) return next;
    last = next;
  }
  throw new Error(`${selector} never stopped moving`);
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

  /* 0. A Hide covers the decision it saw: the lane hidden since its last round
     stays off the board, the lane that parked again after its Hide is back,
     and the badge counts every lane Needs you lists. */
  const laneRow = (id: string) => `[data-mobile2-board] [data-mobile2-swipe-row="pipeline:${id}"]`;
  const hideDecision = {
    stillHidden: await count(laneRow("lane-hidden")),
    parkedAgain: await count(laneRow("lane-parked-again")),
    listedLanes: await count('[data-mobile2-board] [data-mobile2-swipe-row^="pipeline:"]'),
  };
  check("a lane hidden since its last round stays off the board", hideDecision.stillHidden === 0);
  check("a lane that parked again after its Hide is back in Needs you", hideDecision.parkedAgain === 1);
  check("the badge counts every lane Needs you lists", hideDecision.listedLanes === queued);

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

  /* 5b. A Close lane that has gone out stays gone until the server answers it,
     and a second Close lane inside the first one's window keeps the first gone.
     The fixture answers a close after 2.5 s, as a close stopping hosts does. */
  const sentBeforeCloses = (await recorded()).pipelinePatches.length;
  const closesSent = async () => (await recorded()).pipelinePatches.slice(sentBeforeCloses).map((patch) => patch.id);
  const closes = async () => ({ first: await count(lane(4)), second: await count(lane(5)), badge: await badge() });
  await swipeLeft(page, cdp, lane(4), viewport.width);
  await tap(page, cdp, `${lane(4)} [data-mobile2-swipe-action="closeLane"]`);
  await pause(page, 150);
  await swipeLeft(page, cdp, lane(5), viewport.width);
  await tap(page, cdp, `${lane(5)} [data-mobile2-swipe-action="closeLane"]`);
  const secondTapAt = Date.now();
  await pause(page, 150);
  const successive = { ...(await closes()), sent: await closesSent() };
  /* Past the second receipt's window, while its close is still out. */
  await pause(page, 4_300);
  const inFlight = { ...(await closes()), sinceSecondTapMs: Date.now() - secondTapAt, sent: await closesSent(), answered: [...(await recorded()).closesAnswered] };
  await shot("close-in-flight");
  await page.waitForFunction(() => (window as unknown as { evidence: Recorded }).evidence.closesAnswered.length >= 2, undefined, { timeout: 10_000 });
  await pause(page, 300);
  const answered = { ...(await closes()), answered: [...(await recorded()).closesAnswered] };
  check("a second Close lane inside the window keeps the first lane gone while its close is out", successive.first === 0 && successive.second === 0 && successive.badge === queued - 2 && successive.sent.join() === "lane-4");
  check("a Close lane whose window ran out stays gone while the server answers", inFlight.first === 0 && inFlight.second === 0 && inFlight.badge === queued - 2 && inFlight.sent.join() === "lane-4,lane-5" && !inFlight.answered.includes("lane-5"));
  check("answered closes stay gone", answered.first === 0 && answered.second === 0 && answered.badge === queued - 2);

  /* 5c. A lane hidden before that parked again hides again. The fixture keeps
     a lane's first Hide instant through a later dismiss, as the engine does,
     and holds each answer 400 ms. Every frame painted from the tap until both
     answers have landed is sampled for the row and the count. */
  const parkedAgain = laneRow("lane-parked-again");
  const badgeBeforeRehide = await badge();
  await page.evaluate(() => { (window as unknown as { evidence: Recorded }).evidence.pipelineAnswerDelayMs = 400; });
  await swipeLeft(page, cdp, parkedAgain, viewport.width);
  const sentBeforeRehide = (await recorded()).pipelinePatches.length;
  await tap(page, cdp, `${parkedAgain} [data-mobile2-swipe-action="hide"]`);
  await page.evaluate((sel) => {
    const sampler = window as unknown as { rehideFrames: Array<{ row: boolean; badge: string | null }>; rehideSampling: boolean };
    sampler.rehideFrames = [];
    sampler.rehideSampling = true;
    const sample = () => {
      sampler.rehideFrames.push({
        row: document.querySelector(sel) !== null,
        badge: document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? null,
      });
      if (sampler.rehideSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, parkedAgain);
  await page.waitForFunction(() => (window as unknown as { evidence: Recorded }).evidence.hidesAnswered.filter((answer) => answer.id === "lane-parked-again").length >= 2, undefined, { timeout: 5_000 }).catch(() => undefined);
  await pause(page, 600);
  const rehideFrames = await page.evaluate(() => {
    const sampler = window as unknown as { rehideFrames: Array<{ row: boolean; badge: string | null }>; rehideSampling: boolean };
    sampler.rehideSampling = false;
    return sampler.rehideFrames;
  });
  await page.evaluate(() => { (window as unknown as { evidence: Recorded }).evidence.pipelineAnswerDelayMs = 0; });
  const rehideAnswers = (await recorded()).hidesAnswered.filter((answer) => answer.id === "lane-parked-again");
  const rehide = {
    sent: (await recorded()).pipelinePatches.slice(sentBeforeRehide).map((patch) => `${patch.id}:${patch.action}`),
    answers: rehideAnswers,
    answeredDismissAgeMs: rehideAnswers.at(-1)?.dismissedAt ? Date.now() - Date.parse(rehideAnswers.at(-1)!.dismissedAt!) : null,
    frames: rehideFrames.length,
    framesWithRow: rehideFrames.filter((frame) => frame.row).length,
    badges: [...new Set(rehideFrames.map((frame) => frame.badge))],
    rowAfter: await count(parkedAgain),
    badgeBefore: badgeBeforeRehide,
    badgeAfter: await badge(),
  };
  await shot("rehidden");
  check("hiding a lane that parked again clears its old Hide, then sends the new one", rehide.sent.join() === "lane-parked-again:undismiss,lane-parked-again:dismiss");
  check("the new Hide is stamped now, after the round that parked the lane again", rehide.answeredDismissAgeMs !== null && rehide.answeredDismissAgeMs < 60_000);
  check("no painted frame shows the re-hidden row or its count while the answers land", rehide.frames >= 10 && rehide.framesWithRow === 0 && rehide.badges.join() === String(badgeBeforeRehide - 1));
  check("the re-hidden lane stays off Needs you and the badge once answered", rehide.rowAfter === 0 && rehide.badgeAfter === badgeBeforeRehide - 1);

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
  const running = `[data-mobile2-board] [data-mobile2-swipe-row="conversation:${RUNNING_PATH}"]`;
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

  /* 8. «All conversations» appends the same rows: the feed's first, then pages.
     The tap waits for the list above the row to stop moving: a banner that
     arrived between measuring and touching once moved the row out from under
     the finger, and the tap expanded nothing. */
  const toggle = '[data-mobile2-row="catalog"]';
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), toggle);
  const toggleBox = await stableRect(page, toggle);
  const banners = await count("[data-mobile2-banner]");
  await touch(cdp, [[toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2]]);
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", toggle, { timeout: 5_000 }).catch(() => undefined);
  await pause(page, 250);
  check("no banner stands over the list when the catalog row is tapped", banners === 0);
  const rowsSelector = '[data-mobile2-board] [data-mobile2-row="conversation"][data-catalog-path]';
  const expanded = await page.evaluate((sel) => ({
    rows: document.querySelectorAll(sel).length,
    requests: (window as unknown as { evidence: Recorded }).evidence.catalogRequests.length,
    toggle: document.querySelector('[data-mobile2-row="catalog"]')?.textContent ?? "",
  }), rowsSelector);
  await shot("expanded");
  /* The reader keeps scrolling: a page lands below the fold, and the next one
     loads only once the list's end is in reach again. The first page carries
     the superseded round, which gets no row, so twenty stored rows take two
     pages. A list that stops loading fails the checks below. */
  const scrolledStoredRows = () => page.evaluate((sel) => {
    const scroller = document.querySelector("[data-mobile2-board]") as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
    return [...document.querySelectorAll<HTMLElement>(sel)].filter((row) => row.dataset.catalogPath?.startsWith("/repo/history-")).length;
  }, rowsSelector);
  for (let i = 0; i < 50 && (await scrolledStoredRows()) < 20; i += 1) await pause(page, 200);
  await pause(page, 500);
  const appended = await page.evaluate((sel) => {
    const rows = [...document.querySelectorAll<HTMLElement>(sel)];
    const paths = rows.map((row) => row.dataset.catalogPath ?? "");
    const scroller = document.querySelector("[data-mobile2-board]")!;
    return {
      rows: rows.length,
      unique: new Set(paths).size,
      stored: paths.filter((item) => item.startsWith("/repo/history-")).length,
      superseded: paths.includes("/repo/superseded-round.jsonl"),
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
  check("a superseded round the stored catalog lists gets no row", !appended.superseded);
  check("no row appears twice", appended.unique === appended.rows);
  check("every appended row is the same row", appended.rowStyles === 1 && appended.heights.length === 1);
  check("catalog requests are this project's pages with no query",appended.requests.length > 0 && appended.requests.every((query) => query.includes("project=atlas") && query.includes("limit=20") && !/[?&]q=/.test(query)));
  check("no search field anywhere", appended.searchFields === 0);
  check("nothing overflows the phone sideways", !appended.pageOverflow && !appended.boardOverflow);
  check("no page errors", pageErrors.length === 0);

  await page.close();
  return {
    key, viewport, scheme, queued, hideDecision, vertical, tray, hide, restored, refused, closeLane: { ...closeLane, ...closeLaneAfter },
    closes: { successive, inFlight, answered }, rehide, longPress, conversationClose, banners, expanded, appended, pageErrors, failures,
  };
}

const TASK_0 = "Fast conversation switching";

/** The fixture page, bundled and served: one setup every case below runs on.
    The shared harness builds it the way the Viewer's client bundle sees it,
    with server actions stubbed (#2009); a plain browser build pulls their
    Node-only bodies in and fails before any case runs. */
async function serveFixture(): Promise<{ base: string; stop: () => void }> {
  fs.mkdirSync(OUT, { recursive: true });
  const { base, stop } = await serveEvidenceFixture(OUT, "src/components/mobile/issue1671Evidence.fixture.tsx");
  return { base: base.replace(/\/$/, ""), stop };
}

const launchChromium = () => chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });

browserTest("composer queue: a lost seat read drains once on the phone and survives reload", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const out = path.resolve(".artifacts/composer-queue");
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, colorScheme: "dark" });
      try {
        const page = await context.newPage();
        await page.goto(`${base}/?runtime=structured&queue-recovery=1#c=conversation_running`);
        const input = page.locator("textarea:visible").first();
        await input.fill("First message awaiting its seat read.");
        await input.press("Enter");
        await page.waitForSelector("[data-outbox-entry]", { timeout: 5_000 });
        await input.fill("Keep this original message.");
        await input.press("Enter");
        await page.waitForSelector('[data-outbox-state="queued"]');
        const key = await page.locator('[data-outbox-state="queued"]').getAttribute("data-outbox-entry");
        await page.screenshot({ path: path.join(out, `${viewport.width}-waiting.png`) });
        // Each serial entry reaches the production 15 s bound. The second row
        // stays visibly Queued on the unfixed composer, with no server operation.
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("evidence-queue-sends") ?? "[]").length === 2, undefined, { timeout: 40_000 });
        await page.waitForFunction(() => document.querySelectorAll('[data-outbox-state="delivered"]').length === 2);
        await page.screenshot({ path: path.join(out, `${viewport.width}-delivered.png`) });
        const sends = await page.evaluate(() => JSON.parse(sessionStorage.getItem("evidence-queue-sends") ?? "[]"));
        if (sends[1]?.idempotencyKey !== key || sends[1]?.text !== "Keep this original message."
          || sends[0]?.idempotencyKey === key) throw new Error("the original submission changed");
        await page.reload();
        await page.waitForSelector("textarea");
        await page.waitForTimeout(500);
        const count = await page.evaluate(() => JSON.parse(sessionStorage.getItem("evidence-queue-sends") ?? "[]").length);
        if (count !== 2) throw new Error("reload dispatched again");
        results.push({ viewport, posts: count, originalKeyPreserved: true, originalTextPreserved: true });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); stop(); }
  const evidence = path.resolve("evidence/composer-queue");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "recovery.json"), JSON.stringify(results, null, 2) + "\n");
}, 90_000);

browserTest("#1671 at phone width: real touches on the real Viewer, in both schemes", async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: Awaited<ReturnType<typeof run>>[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        try {
          results.push(await run(context, fixtureBase, viewport, scheme));
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((result) => result.failures.length > 0);
  if (failed.length) throw new Error(JSON.stringify(failed.map((result) => ({ key: result.key, failures: result.failures, pageErrors: result.pageErrors })), null, 2));
}, 300_000);

/*
 * #1795 — the runtime pill's sheet, on the same real Viewer, at the two phone
 * surfaces the operator reached it from and at a desktop viewport:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1795"
 *
 * happy-dom lays nothing out, so the defect the operator photographed — the
 * sheet rendered INSIDE the conversation pane, its grab bar, title and most of
 * the Model group above the visible area, the feed's down button floating over
 * it — is a browser question. Each surface records the chain of ancestors that
 * establish a containing block for `position: fixed` between the pill and the
 * document, then measures the open sheet against the viewport, hit-tests the
 * controls that were unreachable, re-taps the row the conversation already
 * runs on, and reads the account the surface names. The desktop case is here
 * rather than in a driver of its own because it is the same control: the
 * popover the sheet is the phone's face of.
 *
 * Readings go to `evidence/issue-1795/runtime-sheet.json`; frames to
 * `.artifacts/issue-1795/`, which is not committed.
 */
const SHEET_OUT = path.resolve(".artifacts/issue-1795");
/* Both phone widths, the short one the critique rendered at, and a 15-character
   account id — the width that took the model and its tier down with it. */
const SHEET_CASES = [
  { viewport: { width: 390, height: 844 }, account: "spare" },
  { viewport: { width: 430, height: 932 }, account: "spare" },
  { viewport: { width: 390, height: 600 }, account: "spare" },
  { viewport: { width: 390, height: 844 }, account: "review-relief-2" },
] as const;
const SHEET_EVIDENCE = path.resolve("evidence/issue-1795");

interface Containing { tag: string; marks: string[]; reasons: string[]; rect: Rect }

/** Every ancestor of `selector` that makes `position: fixed` resolve against
    itself instead of the viewport, nearest first. */
const containingBlocks = (page: Page, selector: string) => page.evaluate((sel): Containing[] => {
  const chain: Containing[] = [];
  const start = document.querySelector(sel);
  for (let node = start?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const reasons: string[] = [];
    if (style.transform !== "none") reasons.push(`transform: ${style.transform}`);
    if (style.perspective !== "none") reasons.push(`perspective: ${style.perspective}`);
    if (style.filter !== "none") reasons.push(`filter: ${style.filter}`);
    if (style.backdropFilter && style.backdropFilter !== "none") reasons.push(`backdrop-filter: ${style.backdropFilter}`);
    if (/paint|layout|strict|content/.test(style.contain ?? "")) reasons.push(`contain: ${style.contain}`);
    if ((style.containerType ?? "normal") !== "normal") reasons.push(`container-type: ${style.containerType}`);
    if ((style.contentVisibility ?? "visible") !== "visible") reasons.push(`content-visibility: ${style.contentVisibility}`);
    if (/transform|filter|perspective|contain/.test(style.willChange ?? "")) reasons.push(`will-change: ${style.willChange}`);
    if (!reasons.length) continue;
    const box = node.getBoundingClientRect();
    chain.push({
      tag: node.tagName.toLowerCase(),
      marks: [...node.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-")),
      reasons,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
  }
  return chain;
}, selector);

/** What the operator can actually see and hit: the box, whether it is inside
    the viewport, and what the topmost element at its centre belongs to. */
const reachable = (page: Page, selector: string, within: string) => page.evaluate(([sel, root]): null | (Rect & { inside: boolean; hitOwn: boolean }) => {
  const element = document.querySelector(sel!);
  const container = document.querySelector(root!);
  if (!element || !container) return null;
  const box = element.getBoundingClientRect();
  const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return {
    x: box.x, y: box.y, width: box.width, height: box.height,
    inside: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight + 0.5 && box.right <= innerWidth + 0.5,
    hitOwn: top !== null && (container.contains(top) || element.contains(top) || element === top),
  };
}, [selector, within] as const);

/** The switcher row that opens the board lane's review round, whose pane the
    deck mounts on its own perspective stage. */
const REVIEW_ROW_PREFIX = translate("en", "mobile2.chat.reviewOf", { title: "" }).trim();

/** What the bar's meta line actually says, cell by cell, and whether any cell
    is showing less than its text — the line the account was crowding out. */
const headerReading = (page: Page) => page.evaluate(() => {
  const cell = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      text: element.textContent ?? "",
      width: Math.round(box.width * 10) / 10,
      /* Chromium rounds a truncating box down by up to a pixel. */
      cut: element.scrollWidth > element.clientWidth + 1,
    };
  };
  const line = document.querySelector("[data-mobile2-chat-state]")?.parentElement ?? null;
  return {
    line: line ? { width: Math.round(line.getBoundingClientRect().width * 10) / 10, text: line.textContent ?? "" } : null,
    state: cell("[data-mobile2-chat-state]"),
    model: cell("[data-mobile2-chat-model]"),
    account: cell("[data-mobile2-chat-account]"),
    title: cell("[data-mobile2-title-text]"),
  };
});

async function sheetSurface(
  context: BrowserContext,
  base: string,
  surface: "pane-on-board" | "conversation-view" | "round-deck-on-board",
  account = "spare",
) {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const shot = (name: string) => page.screenshot({ path: path.join(SHEET_OUT, `${surface}-${name}.png`) });
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const recorded = () => page.evaluate(() => structuredClone((window as unknown as { evidence: { runtimeRequests: unknown[]; accountSelects: unknown[] } }).evidence));

  if (surface === "pane-on-board" || surface === "round-deck-on-board") {
    /* Exactly the operator's route: the board, then the conversation opened
       from it, which the board mounts inside its own shell. */
    await page.goto(`${base}/?account=${account}${surface === "round-deck-on-board" ? "&deck=1" : ""}#p=atlas`);
    const row = `[data-mobile2-board] [data-mobile2-swipe-row="conversation:${runningPath(account)}"]`;
    await page.waitForSelector(row, { timeout: 20_000 });
    await pause(page, 600);
    /* The row is below the fold under ten parked lanes: scroll to it, then tap
       where it now is. */
    await touch(cdp, [await centre(page, row)]);
    if (surface === "round-deck-on-board") {
      /* …and from there into the lane's review round, through the bar's own
         switcher. THIS is the pane the operator photographed: the round deck
         lays its front card on a perspective stage, and a perspective is a
         containing block for every `fixed` descendant under it. */
      await pause(page, 800);
      await touch(cdp, [await centre(page, "[data-mobile2-chat-title]")]);
      await pause(page, 800);
      const at = await page.evaluate((prefix) => {
        const row = [...document.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").startsWith(prefix!));
        if (!row) return null;
        const box = row.getBoundingClientRect();
        return [box.x + box.width / 2, box.y + box.height / 2] as [number, number];
      }, REVIEW_ROW_PREFIX);
      if (!at) throw new Error("no review round in the switcher");
      await touch(cdp, [at]);
      await pause(page, 900);
    }
  } else {
    /* The conversation on its own, deep-linked, with no board under it. */
    await page.goto(`${base}/?account=${account}#c=conversation_running`);
  }
  await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
  await pause(page, 600);

  /* What `fixed` is measured against here, with the sheet still closed. */
  const ancestors = await containingBlocks(page, "[data-runtime-pill]");
  /* …and what the bar says while nothing covers it. */
  const header = await headerReading(page);
  await shot("header");
  check("the header names the state, the model with its tier, and the account", Boolean(header.state && header.model && header.account));
  check("the state phrase is whole", header.state?.cut === false);
  check("the model and its tier are whole", header.model?.cut === false);
  check("the account the conversation runs on is the one it names", (header.account?.text ?? "").includes(account));
  /* An ordinary account id has to be READABLE, not merely present in the DOM:
     `@ spare` rendered as `@ s…` and the first evidence pass called that a pass
     because it read textContent (#1795, second critique). */
  if (account.length <= 8) check("the account is shown whole, not cut to a letter", header.account?.cut === false);
  /* A long one yields, and still shows more than an ellipsis. */
  else check("a long account id still shows its head", (header.account?.width ?? 0) >= 60);
  await tap(page, cdp, "[data-runtime-pill]");
  await pause(page, 400);
  await shot("sheet");

  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector("[data-runtime-sheet]");
    const backdrop = sheet?.parentElement ?? null;
    if (!sheet || !backdrop) return null;
    const box = backdrop.getBoundingClientRect();
    const card = sheet.getBoundingClientRect();
    return {
      portalledToBody: backdrop.parentElement === document.body,
      backdrop: { x: box.x, y: box.y, width: box.width, height: box.height },
      card: { x: card.x, y: card.y, width: card.width, height: card.height },
      viewport: { width: innerWidth, height: innerHeight },
      coversViewport: box.top <= 0.5 && box.left <= 0.5 && box.width >= innerWidth - 0.5 && box.height >= innerHeight - 0.5,
      scrollsInsideItself: sheet.scrollHeight <= sheet.clientHeight || getComputedStyle(sheet).overflowY === "auto",
    };
  });
  /* The feed behind it: rows the sheet has to cover, and the down button that
     floated over the sheet in the operator's screenshot. */
  const behind = await page.evaluate(() => {
    const feed = document.querySelector("[data-log-feed-scroller]");
    return {
      /* The scroller's own count of transcript lines it holds. */
      feedLines: Number(feed?.getAttribute("data-tail-line-count") ?? "0"),
      feedScrollable: feed ? feed.scrollHeight > feed.clientHeight + 1 : false,
      downButton: document.querySelectorAll("[data-feed-jump], [data-log-feed-down]").length,
    };
  });
  const title = await reachable(page, "[data-runtime-sheet] h2", "[data-runtime-sheet]");
  const close = await reachable(page, "[data-runtime-sheet-close]", "[data-runtime-sheet]");
  const accounts = await reachable(page, "[data-runtime-sheet-accounts]", "[data-runtime-sheet]");
  const firstModelRow = await reachable(page, "[data-runtime-sheet] [role=\"radiogroup\"] [data-runtime-sheet-row]", "[data-runtime-sheet]");
  const accountRows = await page.evaluate(() => [...document.querySelectorAll("[data-runtime-sheet-account]")].map((row) => ({
    id: row.getAttribute("data-runtime-sheet-account"),
    state: row.getAttribute("data-runtime-account-state"),
    next: row.getAttribute("data-runtime-account-next"),
    disabled: (row as HTMLButtonElement).disabled,
  })));
  const namesAccount = await page.evaluate(() => document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "");

  if (surface === "round-deck-on-board") {
    /* The surface only means something while the pane it opens in still has
       the containing block that clipped the sheet. */
    check("the round deck still lays its pane on a containing block", ancestors.some((node) => node.reasons.some((reason) => reason.startsWith("perspective"))));
  }
  check("the sheet is portalled to the document body", geometry?.portalledToBody === true);
  check("the sheet covers the whole viewport from this surface", geometry?.coversViewport === true);
  check("the sheet scrolls inside itself", geometry?.scrollsInsideItself === true);
  check("its title is on screen and nothing floats over it", Boolean(title?.inside && title.hitOwn));
  check("its close control is on screen and hittable", Boolean(close?.inside && close.hitOwn));
  check("the account group is on screen", Boolean(accounts?.inside && accounts.hitOwn));
  check("the first model row is on screen", Boolean(firstModelRow?.inside && firstModelRow.hitOwn));
  /* The feed behind the sheet is a real one, so the hit tests above are taken
     over transcript rows rather than an empty pane. */
  check("the transcript behind the sheet has content", behind.feedLines > 0);
  /* Scroll the sheet's own groups to the bottom: the title and the way out are
     a sticky row, so neither leaves with them. */
  await page.evaluate(() => {
    const sheet = document.querySelector("[data-runtime-sheet]");
    if (sheet) sheet.scrollTop = sheet.scrollHeight;
  });
  await pause(page, 300);
  const scrolledTitle = await reachable(page, "[data-runtime-sheet] h2", "[data-runtime-sheet]");
  const scrolledClose = await reachable(page, "[data-runtime-sheet-close]", "[data-runtime-sheet]");
  await shot("scrolled");
  check("the title stays in the sheet after its groups are scrolled", Boolean(scrolledTitle?.inside && scrolledTitle.hitOwn));
  check("the close control stays in the sheet after its groups are scrolled", Boolean(scrolledClose?.inside && scrolledClose.hitOwn));
  check("the account the conversation runs on is named", namesAccount.includes(account));
  check("the account it runs on is the marked row, and holds the next message until another is picked",
    accountRows.some((row) => row.id === account && row.state === "current" && row.next === "true" && row.disabled));
  check("another authenticated account is a one-tap select", accountRows.some((row) => row.id === "relief" && row.state === "ready" && !row.disabled));
  check("a signed-out account keeps its sign-in row", accountRows.some((row) => row.id === "dormant" && row.state === "needs-sign-in"));

  /* Re-tap the reasoning tier the conversation already runs on. */
  const checkedTier = "[data-runtime-sheet-row][aria-checked=\"true\"]";
  const beforeReselect = await recorded();
  await tap(page, cdp, checkedTier);
  await pause(page, 500);
  const afterReselect = await recorded();
  const sheetGone = await page.evaluate(() => document.querySelector("[data-runtime-sheet]") === null);
  check("re-selecting what it already runs on sends no reconfigure", afterReselect.runtimeRequests.length === beforeReselect.runtimeRequests.length);
  check("re-selecting what it already runs on closes the sheet", sheetGone);

  /* …and a row that IS a change still goes out, so the guard is equality. */
  await tap(page, cdp, "[data-runtime-pill]");
  await pause(page, 400);
  const changed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-runtime-sheet-row]")] as HTMLButtonElement[];
    const row = rows.find((candidate) => candidate.getAttribute("aria-checked") === "false");
    row?.setAttribute("data-evidence-change", "1");
    return row?.textContent ?? "";
  });
  await tap(page, cdp, "[data-evidence-change]");
  await pause(page, 600);
  const afterChange = await recorded();
  check("a real change still sends its reconfigure", afterChange.runtimeRequests.length > afterReselect.runtimeRequests.length);
  await shot("after-change");

  /* Picking another account has to SHOW: one select leaves, and the mark for
     where the next message goes moves onto the row that was tapped, while the
     row naming where the conversation RUNS stays where it was (critique P1). */
  const readyRow = "[data-runtime-sheet-account][data-runtime-account-state=\"ready\"]";
  const pickedId = await page.evaluate((sel) => document.querySelector(sel!)?.getAttribute("data-runtime-sheet-account") ?? "", readyRow);
  await touch(cdp, [await centre(page, readyRow)]);
  await pause(page, 700);
  const afterPick = await recorded();
  const picked = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("[data-runtime-sheet-account]")].map((row) => ({
      id: row.getAttribute("data-runtime-sheet-account"),
      state: row.getAttribute("data-runtime-account-state"),
      next: row.getAttribute("data-runtime-account-next"),
      disabled: (row as HTMLButtonElement).disabled,
    })),
    head: document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "",
  }));
  await shot("after-account-pick");
  check("picking an account sends exactly one select", afterPick.accountSelects.length === 1);
  check("the picked account is marked as the one the next message uses",
    picked.rows.some((row) => row.id === pickedId && row.next === "true" && row.disabled));
  check("no other row claims the next message",
    picked.rows.filter((row) => row.next === "true").length === 1);
  check("the account the conversation runs on still says so",
    picked.head.includes(account) && picked.rows.some((row) => row.state === "current"));

  check("no page errors", pageErrors.length === 0);

  await page.close();
  return {
    surface, account, viewportAccountPick: { pickedId, ...picked, selects: afterPick.accountSelects },
    ancestors, header, behind, geometry, title, close, scrolledTitle, scrolledClose, accounts, firstModelRow, accountRows, namesAccount,
    changedTo: changed, pageErrors, failures,
  };
}

async function popoverSurface(context: BrowserContext, base: string) {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  await page.goto(`${base}/#c=conversation_running`);
  await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
  await pause(page, 600);
  const ancestors = await containingBlocks(page, "[data-runtime-pill]");
  /* The desktop board is taller than the window; bring the pane's composer row
     into view before clicking where it now is. */
  await page.evaluate(() => document.querySelector("[data-runtime-pill]")?.scrollIntoView({ block: "center", inline: "center" }));
  await pause(page, 500);
  await page.mouse.click(...(await page.evaluate(() => {
    const box = document.querySelector("[data-runtime-pill]")!.getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2] as [number, number];
  })));
  await pause(page, 400);
  await page.screenshot({ path: path.join(SHEET_OUT, "desktop-popover.png") });
  const namesAccount = await page.evaluate(() => document.querySelector("[data-runtime-popover-account]")?.textContent ?? "");
  const popover = await reachable(page, "[data-runtime-popover]", "[data-runtime-popover]");
  check("the popover is open and on screen", Boolean(popover?.inside && popover.hitOwn));
  check("the popover names the account the conversation runs on", namesAccount.includes("spare"));
  check("no page errors", pageErrors.length === 0);
  await page.close();
  return { surface: "desktop-popover", ancestors, popover, namesAccount, pageErrors, failures };
}

browserTest("#1795: the runtime sheet covers the phone from every surface, closes, ignores a re-tap, and names the account", async () => {
  fs.mkdirSync(SHEET_OUT, { recursive: true });
  fs.mkdirSync(SHEET_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: { surface: string; failures: string[]; pageErrors: string[] }[] = [];
  try {
    for (const { viewport, account } of SHEET_CASES) {
      for (const surface of ["pane-on-board", "round-deck-on-board", "conversation-view"] as const) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
        try {
          const result = await sheetSurface(context, fixtureBase, surface, account);
          results.push({ viewport, ...result });
          if (result.failures.length) failures.push({ surface: `${viewport.width}x${viewport.height}-${account}-${surface}`, failures: result.failures, pageErrors: result.pageErrors });
        } finally {
          await context.close();
        }
      }
    }
    const desktop = await browser.newContext({ viewport: { width: 1_280, height: 900 }, colorScheme: "dark" });
    try {
      const result = await popoverSurface(desktop, fixtureBase);
      results.push({ viewport: { width: 1_280, height: 900 }, ...result });
      if (result.failures.length) failures.push({ surface: "1280-popover", failures: result.failures, pageErrors: result.pageErrors });
    } finally {
      await desktop.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(SHEET_EVIDENCE, "runtime-sheet.json"), `${JSON.stringify(results, null, 2)}\n`);
  if (failures.length) throw new Error(JSON.stringify(failures, null, 2));
}, 300_000);

/*
 * #1846 — a pick on the phone, on the same real Viewer with the running conversation on a structured host
 * (`&runtime=structured`), in English and Ukrainian, with short ids and with two long ones:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1846"
 *
 * The sheet's row for another account is tapped and the sheet closed; the title line must then name the
 * account the next message goes to whole, the running account yielding first, and the model with its tier
 * stays whole on the line under it. The pick sends the conversation's reconfigure and never an engine select.
 *
 * Readings go to `evidence/issue-1846/phone-header.json`; frames to `.artifacts/issue-1846/`.
 */
const PICK_OUT = path.resolve(".artifacts/issue-1846");
const PICK_EVIDENCE = path.resolve("evidence/issue-1846");
const PICK_CASES = [
  { account: "spare", next: "relief" },
  { account: "review-relief-2", next: "production-backup-7" },
] as const;

browserTest("#1846: a pick on the phone names the next account whole on the title line", async () => {
  fs.mkdirSync(PICK_OUT, { recursive: true });
  fs.mkdirSync(PICK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const { account, next } of PICK_CASES) {
        const viewport = { width: 390, height: 844 };
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        const key = `${lang}-${account}-${next}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await page.goto(`${fixtureBase}/?account=${account}&next=${next}&runtime=structured#c=conversation_running`);
          await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
          await pause(page, 800);
          const before = await headerReading(page);
          await tap(page, cdp, "[data-runtime-pill]");
          await page.waitForSelector(`[data-runtime-sheet-account="${next}"]`, { timeout: 10_000 });
          await pause(page, 300);
          await tap(page, cdp, `[data-runtime-sheet-account="${next}"]`);
          await pause(page, 100);
          const sheetLine = await page.evaluate(() => document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "");
          await page.screenshot({ path: path.join(PICK_OUT, `phone-${key}-sheet.png`) });
          await tap(page, cdp, "[data-runtime-sheet-close]");
          await pause(page, 400);
          const after = await headerReading(page);
          const parts = await page.evaluate(() => {
            const cell = (selector: string) => {
              const element = document.querySelector(selector);
              if (!element) return null;
              const box = element.getBoundingClientRect();
              /* The text's own width, unrounded: scrollWidth rounds, and hid a cut of under a pixel that still drew an ellipsis. */
              const range = document.createRange();
              range.selectNodeContents(element);
              const need = range.getBoundingClientRect().width;
              const tag = document.querySelector("[data-mobile2-chat-account]")!.getBoundingClientRect();
              return {
                text: element.textContent ?? "",
                width: Math.round(box.width * 10) / 10,
                need: Math.round(need * 10) / 10,
                cut: need > box.width + 0.1,
                /* On the tag's one line, or wrapped below it where the tag clips it. */
                shown: box.top >= tag.top - 0.5 && box.bottom <= tag.bottom + 0.5 && box.width > 0,
              };
            };
            return { runs: cell("[data-mobile2-chat-account-runs]"), to: cell("[data-mobile2-chat-account-to]") };
          });
          await page.screenshot({ path: path.join(PICK_OUT, `phone-${key}-header.png`) });
          const sent = await page.evaluate(() => {
            const evidence = (window as unknown as { evidence: { runtimeRequests: Array<Record<string, unknown>>; accountSelects: unknown[] } }).evidence;
            return { reconfigures: evidence.runtimeRequests.map((body) => body.accountId ?? null), selects: evidence.accountSelects.length };
          });
          results.push({ key, lang, viewport, account, next, before, sheetLine, after, parts, sent, pageErrors });
          if (!sheetLine.includes(account) || !sheetLine.includes(next)) fail(`the sheet names both accounts: ${sheetLine}`);
          if (parts.to?.text !== `→ ${next}`) fail(`the title line names the next account: ${JSON.stringify(parts.to)}`);
          /* The title keeps at least 6rem (critique round 4), so a next id longer than the room left draws its head
             and yields its tail; one that fits is whole. */
          if (parts.to?.shown !== true) fail(`the next account is on the line: ${JSON.stringify(parts.to)}`);
          if (next.length <= 8 && parts.to?.cut !== false) fail(`a short next account is whole: ${JSON.stringify(parts.to)}`);
          if (parts.to?.cut && parts.to.width < 80) fail(`the next account shows a readable head: ${JSON.stringify(parts.to)}`);
          if ((after.title?.width ?? 0) < 95.5) fail(`the title keeps its 6rem: ${JSON.stringify(after.title)}`);
          /* The running account is either whole beside it or not drawn at all — never a sliver. */
          if (parts.runs?.shown && parts.runs.cut) fail(`the running account shows cut: ${JSON.stringify(parts.runs)}`);
          if (account.length <= 8 && !parts.runs?.shown) fail(`short ids both fit: ${JSON.stringify(parts.runs)}`);
          if (after.model?.cut !== false) fail(`the model and its tier are whole: ${JSON.stringify(after.model)}`);
          if (JSON.stringify(sent.reconfigures) !== JSON.stringify([next]) || sent.selects !== 0) fail(`requests ${JSON.stringify(sent)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PICK_EVIDENCE, "phone-header.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #1846 at 1280x900 on the deck surface this fixture offers (`&deck=1`, the running conversation as a review
 * round), in English and Ukrainian, with short ids and with two long ones:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1846 desktop"
 *
 * The pick is made in the runtime pill's Account panel. On a desktop board the conversation opens in a
 * kanban reader, which replaces the conversation pane's own header, so the pane's «@ A → B» badge is not
 * mounted; the reading records that, and reads the header chip the reader does draw, and the pill's mark,
 * for what each draws against its text.
 *
 * Readings go to `evidence/issue-1846/desktop-deck.json`; frames to `.artifacts/issue-1846/`.
 */
browserTest("#1846 desktop: the deck surface's account chip at 1280 px names the pick whole", async () => {
  fs.mkdirSync(PICK_OUT, { recursive: true });
  fs.mkdirSync(PICK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const reading = (page: Page, selector: string) => page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const overflowing = [element, ...element.querySelectorAll<HTMLElement>("*")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({ text: node.textContent ?? "", width: node.clientWidth, need: node.scrollWidth }));
    const pane = element.closest("[data-kanban-reader]")?.getBoundingClientRect() ?? null;
    return {
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
      width: Math.round(box.width * 10) / 10,
      paneWidth: pane ? Math.round(pane.width * 10) / 10 : null,
      insidePane: pane ? box.left >= pane.left - 0.5 && box.right <= pane.right + 0.5 : null,
      overflowing,
    };
  }, selector);
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const { account, next } of PICK_CASES) {
        const viewport = { width: 1_280, height: 900 };
        const context = await browser.newContext({ viewport, colorScheme: "dark" });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        const key = `desktop-${lang}-${account}-${next}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${fixtureBase}/?account=${account}&next=${next}&runtime=structured&deck=1#c=conversation_running`);
          await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
          await pause(page, 800);
          const before = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          await page.locator("[data-runtime-pill]").first().evaluate((element) => { element.scrollIntoView({ block: "center" }); (element as HTMLElement).click(); });
          await page.waitForSelector('[data-runtime-row="submenu"][data-runtime-value="account"]', { timeout: 5_000 });
          /* Clicked in the page: the reader's composer sits under the portalled popover's hit box in this frame. */
          await page.locator('[data-runtime-row="submenu"][data-runtime-value="account"]').evaluate((element) => (element as HTMLElement).click());
          await page.waitForSelector(`[data-runtime-row="account"][data-runtime-value="account-${next}"]`, { timeout: 5_000 });
          await page.locator(`[data-runtime-row="account"][data-runtime-value="account-${next}"]`).evaluate((element) => (element as HTMLElement).click());
          await pause(page, 400);
          const chip = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          const mark = await reading(page, "[data-runtime-pill-next-account]");
          const paneBadges = await page.evaluate(() => document.querySelectorAll("[data-conversation-account-chip]").length);
          await page.screenshot({ path: path.join(PICK_OUT, `${key}.png`) });
          /* The narrow pane: the same reader held to 426 px, the width a board column gives its reader. */
          await page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>("[data-kanban-reader]");
            if (pane) { pane.style.width = "426px"; pane.style.maxWidth = "426px"; }
          });
          await pause(page, 200);
          const narrow = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          await page.screenshot({ path: path.join(PICK_OUT, `${key}-narrow.png`) });
          const sent = await page.evaluate(() => {
            const evidence = (window as unknown as { evidence: { runtimeRequests: Array<Record<string, unknown>>; accountSelects: unknown[] } }).evidence;
            return { reconfigures: evidence.runtimeRequests.map((body) => body.accountId ?? null), selects: evidence.accountSelects.length };
          });
          results.push({ key, lang, viewport, account, next, before, chip, narrow, mark, paneBadges, sent, pageErrors });
          if (narrow?.paneWidth !== 426) fail(`the narrow pane is 426 px: ${JSON.stringify(narrow)}`);
          if (narrow?.insidePane === false) fail(`in the narrow pane the chip leaves it: ${JSON.stringify(narrow)}`);
          if (!chip?.text.includes(next)) fail(`the reader's header chip names the next account: ${JSON.stringify(chip)}`);
          if (chip?.insidePane === false) fail(`the chip leaves its pane: ${JSON.stringify(chip)}`);
          if (!mark?.text.includes(next)) fail(`the pill carries the pick: ${JSON.stringify(mark)}`);
          if (JSON.stringify(sent.reconfigures) !== JSON.stringify([next]) || sent.selects !== 0) fail(`requests ${JSON.stringify(sent)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PICK_EVIDENCE, "desktop-deck.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #1865 at 390x844, in English and Ukrainian, light and dark, on the lane the
 * fixture adds for it (`?stages=1`): design and critique share the architect
 * preset, and the lane is parked on critique's second attempt.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1865"
 *
 * The queue row is the pipeline card (#2072 slice 3): its chain names the stage
 * by the name the stage list gives it, its reason line says what the stage
 * returned, and neither names the preset. The lane's screen titles each stage
 * row by that name, with the attempt once the stage ran twice, and the preset
 * leads the row's meta line instead. Neither title is cut. The card's reason
 * line is painted whole with its age after it, however many lines that takes;
 * each stage row's meta line keeps its verdict and findings count whole
 * (the preset truncates first), and the effort ladder ends before the meta
 * line begins — both of which the Ukrainian row once failed.
 *
 * Readings go to `evidence/issue-1865/phone.json`; frames to `.artifacts/issue-1865/`.
 */
const LABELS_OUT = path.resolve(".artifacts/issue-1865");
const LABELS_EVIDENCE = path.resolve("evidence/issue-1865");

browserTest("#1865: the phone names a stage and its attempt in the queue row and on the lane's stage rows", async () => {
  fs.mkdirSync(LABELS_OUT, { recursive: true });
  fs.mkdirSync(LABELS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const ROW = '[data-mobile2-row="pipeline"][data-mobile2-pipeline-row$="lane-labels"]';
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of SCHEMES) {
        const viewport = { width: 390, height: 844 };
        const key = `${lang}-${scheme}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await page.goto(`${fixtureBase}/?stages=1#p=atlas`);
          await page.waitForSelector(ROW, { timeout: 20_000 });
          await pause(page, 600);
          const queueRow = await page.evaluate((selector) => document.querySelector(selector)?.textContent ?? "", ROW);
          /* The reason line and its age, painted inside the block's column. */
          const queueMeta = await page.evaluate((selector) => {
            const reason = document.querySelector<HTMLElement>(`${selector} [data-pipeline-reason]`);
            const column = reason?.closest(".pblock")?.getBoundingClientRect();
            const box = reason?.getBoundingClientRect();
            const range = document.createRange();
            if (reason) range.selectNodeContents(reason);
            const ink = range.getBoundingClientRect();
            return {
              text: reason?.textContent ?? "",
              chain: [...document.querySelectorAll(`${selector} .pb-pill[data-stage] .pb-name`)].map((name) => name.textContent),
              lines: box && reason ? Math.round(box.height / parseFloat(getComputedStyle(reason).lineHeight || "16")) : 0,
              columnRight: column ? Math.round(column.right * 10) / 10 : 0,
              inkRight: Math.round(ink.right * 10) / 10,
              clipped: !reason || reason.scrollWidth > reason.clientWidth + 0.5 || (column ? ink.right > column.right + 0.5 : true),
            };
          }, ROW);
          if (queueMeta.clipped) fail(`the queue row's reason line is clipped: ${JSON.stringify(queueMeta)}`);
          if (!/ · \d/.test(queueMeta.text)) fail(`the queue row's reason line carries no age: ${JSON.stringify(queueMeta)}`);
          await page.screenshot({ path: path.join(LABELS_OUT, `phone-${key}-queue.png`) });
          const expectedQueue = translate(lang, "pipelineBlock.reason.failed", { stage: "Critique" });
          if (!queueMeta.text.startsWith(expectedQueue)) fail(`the queue row's reason reads ${JSON.stringify(queueMeta.text)}, expected it to begin ${JSON.stringify(expectedQueue)}`);
          if (!queueMeta.chain.includes("Critique")) fail(`the queue row's chain does not name Critique: ${JSON.stringify(queueMeta.chain)}`);
          const preset = translate(lang, "roleCopy.architect.name");
          if (queueRow.toLocaleLowerCase().includes(preset.toLocaleLowerCase())) fail(`the queue row names the preset: ${JSON.stringify(queueRow)}`);

          await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), ROW);
          await pause(page, 250);
          await tap(page, cdp, ROW);
          await page.waitForSelector('[data-mobile2-screen="pipeline"] [data-mobile2-stage="critique"]', { timeout: 10_000 });
          await pause(page, 500);
          const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-mobile2-screen="pipeline"] [data-mobile2-stage]')].map((row) => {
            const title = row.querySelector<HTMLElement>("[data-mobile2-stage-title]");
            const meta = row.querySelector<HTMLElement>("[data-mobile2-stage-meta]");
            const range = document.createRange();
            if (title) range.selectNodeContents(title);
            const need = title ? range.getBoundingClientRect().width : 0;
            const box = title?.getBoundingClientRect();
            /* The meta line: the part after the preset must be whole, and the
               identity's ink must end before the meta line's begins. */
            const rest = meta?.lastElementChild as HTMLElement | null | undefined;
            const identity = meta?.previousElementSibling as HTMLElement | null | undefined;
            const identityInk = identity ? (() => {
              const r = document.createRange();
              r.selectNodeContents(identity);
              return Math.max(r.getBoundingClientRect().right, ...[...identity.querySelectorAll("*")].map((el) => el.getBoundingClientRect().right));
            })() : 0;
            const metaLeft = meta?.getBoundingClientRect().left ?? 0;
            return {
              stage: row.dataset.mobile2Stage ?? "",
              title: title?.textContent ?? "",
              meta: meta?.textContent ?? "",
              metaRestWhole: !!rest && rest.scrollWidth <= rest.clientWidth + 0.5,
              identityWidth: identity ? Math.round(identity.getBoundingClientRect().width * 10) / 10 : 0,
              identityGap: Math.round((metaLeft - identityInk) * 10) / 10,
              width: box ? Math.round(box.width * 10) / 10 : 0,
              need: Math.round(need * 10) / 10,
              cut: box ? need > box.width + 0.1 : true,
            };
          }));
          await page.screenshot({ path: path.join(LABELS_OUT, `phone-${key}-stages.png`) });
          results.push({ key, lang, scheme, viewport, queueRow, queueMeta, rows, pageErrors });
          const byStage = new Map(rows.map((row) => [row.stage, row] as const));
          const expected = { design: "Design · 2", critique: "Critique · 2" } as const;
          for (const [stage, title] of Object.entries(expected)) {
            const row = byStage.get(stage);
            if (row?.title !== title) fail(`the ${stage} row is titled ${JSON.stringify(row?.title)}, expected ${JSON.stringify(title)}`);
            if (row?.cut !== false) fail(`the ${stage} row's title is cut: ${JSON.stringify(row)}`);
            if (!row?.meta.startsWith(`${preset} · `)) fail(`the ${stage} row's meta does not lead with the preset: ${JSON.stringify(row?.meta)}`);
          }
          for (const row of rows) {
            if (!row.metaRestWhole) fail(`the ${row.stage} row's verdict or findings count is cut: ${JSON.stringify(row)}`);
            if (row.identityGap < 0) fail(`the ${row.stage} row's effort ladder runs into its meta line: ${JSON.stringify(row)}`);
          }
          const critiqueMeta = byStage.get("critique")?.meta ?? "";
          const findings = translate(lang, "pipelineVerdict.findings", { count: 2 });
          if (!critiqueMeta.endsWith(findings)) fail(`the critique row's meta does not end with its findings count: ${JSON.stringify(critiqueMeta)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(LABELS_EVIDENCE, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #1978 at 390x844 in both colour schemes, and at 1280x960 for the desktop's
 * copy controls, on the conversation the fixture gives a shell call and an
 * assigned task (`?toolcard=1`):
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1978"
 *
 * Everything is read as ink, the client rects of text clipped by every
 * overflow ancestor, because box-only overlap checks have passed over real
 * overlaps in this repository:
 *
 *   - the command's and the output's copy controls neither touch nor overlap,
 *     no glyph of the card sits under either, and no call's copy control
 *     hangs past its call into the next one; the desktop keeps its small
 *     22 px controls;
 *   - with the task strip right above the feed, the first visible feed row
 *     starts at or below the strip's bottom edge, and no glyph line and no
 *     control straddles the feed's top edge: following the tail, after the card opens, and at rest
 *     after a drag released it from the tail, with the first lines of a
 *     result taller than the screen under the strip at a sweep of offsets
 *     (every stop comes to rest), and once the conversation is closed to the
 *     board and opened again.
 *
 * Readings go to `evidence/issue-1978/phone.json`; frames to `.artifacts/issue-1978/`.
 */
const EDGE_OUT = path.resolve(".artifacts/issue-1978");
const EDGE_EVIDENCE = path.resolve("evidence/issue-1978");

interface InkReading {
  command: Rect | null;
  output: Rect | null;
  controlsOverlap: number;
  controlsGap: number | null;
  inkUnderControls: string[];
  stripBottom: number | null;
  feedTop: number;
  cutLines: Array<{ text: string; top: number; bottom: number }>;
  firstRow: { key: string; top: number; bottom: number } | null;
  slivers: Array<{ key: string; top: number; bottom: number }>;
  overhangs: Array<{ label: string; by: number }>;
  tail: { spacer: number | null; fromBottom: number };
}

/* Runs in the page. The ink walk is the test's own: every text node under the
   feed, never the product's sampled probe. */
const readInk = (page: Page) => page.evaluate((): InkReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const area = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  /* From the element holding the text itself: a capped output clips its own
     overflowing lines. */
  const clip = (element: Element, stop: Element | null = null): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent && parent !== stop; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return out;
  };
  /* `full` is a line clipped only by the containers inside the feed (a long
     output scrolls in its own capped box): a line the feed's edge cuts is
     found by it, and text clipped out of sight never is. */
  const ink = (root: Element) => {
    const feedElement = document.querySelector("[data-log-feed-scroller]");
    const out: Array<{ text: string; full: Box; seen: Box | null }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement) continue;
      if (getComputedStyle(node.parentElement).visibility === "hidden") continue;
      const c = clip(node.parentElement);
      const inside = clip(node.parentElement, feedElement);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        if (q.width <= 0 || q.height <= 0) continue;
        const full = { l: Math.max(q.left, inside.l), t: Math.max(q.top, inside.t), r: Math.min(q.right, inside.r), b: Math.min(q.bottom, inside.b) };
        if (full.r <= full.l || full.b <= full.t) continue;
        const seen = { l: Math.max(full.l, c.l), t: Math.max(full.t, c.t), r: Math.min(full.r, c.r), b: Math.min(full.b, c.b) };
        out.push({ text: node.textContent.trim().slice(0, 48), full, seen: seen.r > seen.l && seen.b > seen.t ? seen : null });
      }
    }
    return out;
  };
  const feed = document.querySelector("[data-log-feed-scroller]")!;
  const feedBox = box(feed);
  const edge = feedBox.t + feed.clientTop;
  /* The command's control sits in the command block, whose parent is the
     card's readable body; the output's control is the body's other one. */
  const command = document.querySelector('[aria-label="Copy command"]');
  const body = command?.parentElement?.parentElement ?? null;
  const output = body?.querySelector('[aria-label="Copy output"]') ?? null;
  const controls = [command, output].filter((element): element is Element => !!element);
  const under = body ? ink(body).filter((line) => line.seen && controls.some((control) => area(line.seen!, box(control)) > 0.25)).map((line) => line.text) : [];
  const strip = document.querySelector("[data-task-relations]");
  const rect = (element: Element | null): Rect | null => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    command: rect(command ?? null),
    output: rect(output),
    controlsOverlap: command && output ? area(box(command), box(output)) : 0,
    controlsGap: command && output ? box(output).t - box(command).b : null,
    inkUnderControls: under,
    stripBottom: strip ? box(strip).b : null,
    feedTop: edge,
    cutLines: [
      ...ink(feed),
      /* A control sliced by the edge is a cut row as much as a line is. */
      ...[...feed.querySelectorAll("button")].map((control) => ({ text: `<${control.tagName.toLowerCase()} ${control.getAttribute("aria-label") ?? ""}>`, full: box(control) })),
    ].filter((line) => line.full.t < edge - 0.5 && line.full.b > edge + 0.5 && line.full.r > feedBox.l && line.full.l < feedBox.r)
      .map((line) => ({ text: line.text, top: line.full.t, bottom: line.full.b })),
    tail: (() => {
      const spacer = feed.querySelector<HTMLElement>("[data-feed-tail-spacer]");
      return { spacer: spacer?.getBoundingClientRect().height ?? null, fromBottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop };
    })(),
    /* Every copy control of a run's calls stays inside its own call: one that
       hangs past the call's box lands on the next call's header. */
    overhangs: [...feed.querySelectorAll<HTMLElement>("li button[aria-label^='Copy']")]
      .map((control) => ({ label: control.getAttribute("aria-label") ?? "", by: box(control).b - box(control.closest("li")!).b }))
      .filter((control) => control.by > 0.5),
    /* A row of any size left showing only its frame (a card's bottom border
       and padding) under the edge reads as a cut row too. */
    slivers: [...feed.querySelectorAll<HTMLElement>("[data-feed-key], li, [data-tool-row]")]
      .filter((row) => box(row).t < edge && box(row).b > edge + 1 && box(row).b - edge <= 16)
      .map((row) => ({ key: row.dataset.feedKey ?? row.tagName.toLowerCase(), top: box(row).t, bottom: box(row).b })),
    firstRow: (() => {
      /* A row is a feed row or a row inside one (a run's numbered call, a
         bullet, a tool line), outer before inner; the first visible one that
         fits in three quarters of the feed is the one that must start whole.
         Scroll offsets are whole CSS pixels and rows lay out on half ones, so
         a predecessor can show a sliver of up to one pixel under the edge;
         visible means showing more than that. */
      const fit = feed.clientHeight * 0.75;
      const row = [...feed.querySelectorAll<HTMLElement>("[data-feed-key], li, [data-tool-row]")]
        .find((candidate) => box(candidate).b > edge + 1 && box(candidate).b - box(candidate).t <= fit);
      return row ? { key: row.dataset.feedKey ?? `${row.tagName.toLowerCase()}: ${(row.textContent ?? "").slice(0, 40)}`, top: box(row).t, bottom: box(row).b } : null;
    })(),
  };
});

/* The feed at rest: its scroll position unchanged across 400 ms, so momentum
   and any settling move have run out before anything is read. */
async function feedAtRest(page: Page): Promise<void> {
  let last = Number.NaN;
  let still = 0;
  for (let i = 0; i < 60 && still < 4; i += 1) {
    await pause(page, 100);
    const top = await page.evaluate(() => document.querySelector("[data-log-feed-scroller]")?.scrollTop ?? 0);
    still = top === last ? still + 1 : 0;
    last = top;
  }
  if (still < 4) throw new Error("the feed never came to rest");
}

browserTest("#1978: a command card's copy controls stay apart and off the text, and the task strip never cuts a line", async () => {
  fs.mkdirSync(EDGE_OUT, { recursive: true });
  fs.mkdirSync(EDGE_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = [
    { viewport: { width: 390, height: 844 }, scheme: "dark" },
    { viewport: { width: 390, height: 844 }, scheme: "light" },
    { viewport: { width: 1280, height: 960 }, scheme: "dark" },
  ] as const;
  try {
    for (const { viewport, scheme } of cases) {
      const phone = viewport.width < 640;
      const key = `${viewport.width}-${scheme}`;
      const fail = (label: string) => failures.push(`${key}: ${label}`);
      const context = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone, deviceScaleFactor: 2, colorScheme: scheme });
      await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await page.goto(`${fixtureBase}/?toolcard=1#f=${encodeURIComponent(RUNNING_PATH)}`);
        await page.waitForSelector("[data-log-feed-scroller]", { timeout: 20_000 });
        await page.getByText("The projection replays every band", { exact: false }).first().waitFor({ timeout: 20_000 });
        await pause(page, 900);
        const readings: Record<string, InkReading> = {};
        await feedAtRest(page);
        readings.following = await readInk(page);

        /* Open the run from its line, as the operator does: the phone folds
           it to one line, the desktop shows it as a group. */
        if (phone) {
          const r = await page.locator("[data-mobile-run-fold]").last().boundingBox();
          if (!r) throw new Error("the run's line is not on screen");
          await touch(cdp, [[r.x + r.width / 2, r.y + r.height / 2]]);
        } else if (!(await page.locator('[aria-label="Copy command"]').count())) {
          await page.locator("[data-log-feed-scroller] summary").last().click();
        }
        await page.waitForSelector('[aria-label="Copy command"]', { timeout: 5_000 });
        await pause(page, 900);
        await feedAtRest(page);
        readings.opened = await readInk(page);
        await page.screenshot({ path: path.join(EDGE_OUT, `${key}-opened.png`) });

        if (phone) {
          /* A call taller than the screen: open the long result in full, then
             wheel its first lines under the strip at a sweep of offsets. Its
             lines and its copy control meet the edge together there, where
             clearing one used to cut the other and the feed stepped between
             two positions forever. Every stop must come to rest clean. */
          await page.locator("[data-log-feed-scroller] li", { hasText: "bands.ts" }).getByText("show all output").first().tap();
          await feedAtRest(page);
          await page.mouse.move(viewport.width / 2, viewport.height / 2);
          for (const offset of [2, 7, 13, 19, 26, 34, 43, 55]) {
            const delta = await page.evaluate((into) => {
              const feed = document.querySelector("[data-log-feed-scroller]")!;
              const long = [...feed.querySelectorAll("li pre")].find((pre) => pre.textContent?.includes("band(0)"));
              if (!long) throw new Error("the long result is not open");
              return long.getBoundingClientRect().top - (feed.getBoundingClientRect().top + feed.clientTop) + into;
            }, offset);
            await page.mouse.wheel(0, delta);
            await feedAtRest(page);
            readings[`long-${offset}`] = await readInk(page);
          }
          await page.screenshot({ path: path.join(EDGE_OUT, `${key}-long.png`) });

          /* Bring the card to the top edge, then leave the tail by drags of
             uneven lengths; each rest is read once the feed has settled. */
          for (const distance of [137, 211, 173]) {
            const feed = await rectOf(page, "[data-log-feed-scroller]");
            const x = feed!.x + feed!.width / 2;
            const y = feed!.y + feed!.height / 2;
            await touch(cdp, along([x, y - distance / 2], [x, y + distance / 2]), 24);
            await pause(page, 1_200);
            await feedAtRest(page);
            readings[`rest-${distance}`] = await readInk(page);
          }
          await page.screenshot({ path: path.join(EDGE_OUT, `${key}-rest.png`) });
          /* Close to the board and come back to the conversation through
             history: the feed comes back where it was left and still rests
             on a row. */
          await page.evaluate(() => { location.hash = "#p=atlas"; });
          await pause(page, 900);
          await page.goBack();
          await page.getByText("The projection replays every band", { exact: false }).first().waitFor({ timeout: 10_000 });
          await pause(page, 1_200);
          await feedAtRest(page);
          readings.reopened = await readInk(page);
          await page.screenshot({ path: path.join(EDGE_OUT, `${key}-reopened.png`) });
        }

        results.push({ key, viewport, scheme, readings, pageErrors });
        const opened = readings.opened!;
        if (!opened.command || !opened.output) fail(`the card shows both copy controls: ${JSON.stringify(opened)}`);
        if (opened.controlsOverlap > 0) fail(`the copy controls overlap by ${opened.controlsOverlap} px²`);
        if (opened.controlsGap !== null && opened.controlsGap <= 0) fail(`the copy controls touch: the output's starts ${opened.controlsGap} px below the command's`);
        if (opened.inkUnderControls.length) fail(`text under a copy control: ${JSON.stringify(opened.inkUnderControls)}`);
        /* Phone only: the desktop's 22 px control overhangs a one-line output
           by ~2.6 px today, and the desktop keeps its present look. */
        if (phone && opened.overhangs.length) fail(`copy controls hang past their call: ${JSON.stringify(opened.overhangs)}`);
        const size = phone ? 44 : 22;
        for (const control of [opened.command, opened.output]) {
          if (control && (Math.abs(control.width - size) > 0.5 || Math.abs(control.height - size) > 0.5)) fail(`a copy control is ${control.width}x${control.height}, expected ${size}`);
        }
        if (phone) {
          for (const [moment, reading] of Object.entries(readings)) {
            if (reading.stripBottom === null) fail(`${moment}: no task strip above the feed`);
            else if (reading.feedTop < reading.stripBottom - 0.5) fail(`${moment}: the feed starts above the strip's bottom edge`);
            if (reading.cutLines.length) fail(`${moment}: lines cut by the feed's top edge: ${JSON.stringify(reading.cutLines)}`);
            if (reading.slivers.length) fail(`${moment}: rows showing only a sliver under the edge: ${JSON.stringify(reading.slivers)}`);
            if (!reading.firstRow) fail(`${moment}: no feed row on screen`);
            else if (reading.stripBottom !== null && reading.firstRow.top < reading.stripBottom) fail(`${moment}: the first visible row starts at ${reading.firstRow.top}, above the strip's bottom ${reading.stripBottom}: ${JSON.stringify(reading.firstRow)}`);
          }
        }
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(EDGE_EVIDENCE, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2072 slice 2, the jump strip: a conversation away from its tail, at the
 * pages Safari leaves on a 390 × 844 and a 430 × 932 phone, in both languages
 * and both schemes (the desktop reader's strip is held by the DOM test in
 * `LogFeed.mobileChrome.dom.test.tsx`). The «down» control used to float
 * over the feed's bottom edge, where a line of text always sat once the reader
 * had left the tail. It is now a 44 px row of its own between the feed and the
 * composer:
 *
 *   - the feed's viewport ends at the strip's top edge, and no text's ink,
 *     clipped by its overflow ancestors, reaches the strip or its control;
 *   - the strip is 44 px tall, its target at least 44 × 44 around a 32 px
 *     pill, and it lies wholly above the composer and inside the page;
 *   - the feed's scroll offset is the same before and after the strip
 *     appears, so the line being read at the top does not move;
 *   - a tap returns to the tail and the strip leaves with it.
 *
 * Readings go to `evidence/issue-2072/jump-strip.json`; frames to `.artifacts/jump-strip/`.
 */
const JUMP_OUT = path.resolve(".artifacts/jump-strip");
const JUMP_EVIDENCE = path.resolve("evidence/issue-2072");

interface JumpReading {
  strip: Rect | null;
  control: Rect | null;
  pill: Rect | null;
  feed: Rect;
  composerTop: number | null;
  inkOnStrip: string[];
  controlsCrossing: string[];
  overflowX: number;
  label: string;
}

/* Runs in the page; the ink walk is the test's own. */
const readJump = (page: Page) => page.evaluate((): JumpReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const rect = (element: Element | null): Rect | null => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const meets = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
  const clip = (element: Element): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return out;
  };
  const strip = document.querySelector("[data-feed-jump-strip]");
  const control = strip?.querySelector("button") ?? null;
  const feed = document.querySelector("[data-log-feed-scroller]")!;
  /* Every text outside the strip, as the ink it paints. */
  const inkOnStrip: string[] = [];
  if (strip) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement || strip.contains(node)) continue;
      if (getComputedStyle(node.parentElement).visibility === "hidden") continue;
      const c = clip(node.parentElement);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        const seen = { l: Math.max(q.left, c.l), t: Math.max(q.top, c.t), r: Math.min(q.right, c.r), b: Math.min(q.bottom, c.b) };
        if (seen.r - seen.l <= 0.5 || seen.b - seen.t <= 0.5) continue;
        if (meets(seen, box(strip))) inkOnStrip.push(node.textContent.trim().slice(0, 48));
      }
    }
  }
  const controlsCrossing = control
    ? [...document.querySelectorAll("button, a[href], textarea, input")]
      .filter((other) => other !== control && !control.contains(other) && !other.contains(control))
      .filter((other) => other.getClientRects().length && meets(box(other), box(control)))
      .map((other) => other.getAttribute("aria-label") ?? other.tagName.toLowerCase())
    : [];
  const composer = document.querySelector("textarea");
  return {
    strip: rect(strip),
    control: rect(control),
    pill: rect(strip?.querySelector("[data-feed-jump-pill]") ?? null),
    feed: rect(feed)!,
    composerTop: composer ? box(composer.parentElement ?? composer).t : null,
    inkOnStrip,
    controlsCrossing,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    label: control?.textContent?.trim() ?? "",
  };
});

browserTest("#2072: away from the tail, the jump control is a row of its own and never covers text", async () => {
  fs.mkdirSync(JUMP_OUT, { recursive: true });
  fs.mkdirSync(JUMP_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = (["en", "uk"] as const).flatMap((lang) => [
    { viewport: { width: 390, height: 667 }, scheme: "dark", lang },
    { viewport: { width: 390, height: 667 }, scheme: "light", lang },
    { viewport: { width: 430, height: 735 }, scheme: "dark", lang },
  ] as const);
  try {
    for (const { viewport, scheme, lang } of cases) {
      const key = `${viewport.width}x${viewport.height}-${scheme}-${lang}`;
      const fail = (label: string) => failures.push(`${key}: ${label}`);
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/#f=${encodeURIComponent(RUNNING_PATH)}`);
        await page.waitForSelector('[data-log-feed-scroller] [data-feed-state="items"]', { timeout: 20_000 });
        await pause(page, 900);
        await feedAtRest(page);
        const following = await readJump(page);
        if (following.strip) fail("a strip while following the tail");

        /* Leave the tail as a wheel does: the input marks the scroll as the
           reader's, then the offset moves. The offset is read again once the
           strip has laid out, before any settle can run. */
        const anchoring = await page.evaluate(async () => {
          const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
          const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const firstRow = () => [...feed.querySelectorAll<HTMLElement>("[data-feed-key]")]
            .find((row) => row.getBoundingClientRect().bottom > feed.getBoundingClientRect().top + 1);
          feed.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -360 }));
          feed.scrollTop -= 360;
          const before = feed.scrollTop;
          const row = firstRow();
          const rowTop = row?.getBoundingClientRect().top ?? null;
          for (let i = 0; i < 30 && !document.querySelector("[data-feed-jump-strip]"); i += 1) await frame();
          await frame();
          await frame();
          return {
            mounted: Boolean(document.querySelector("[data-feed-jump-strip]")),
            before,
            after: feed.scrollTop,
            rowMoved: row && rowTop !== null ? row.getBoundingClientRect().top - rowTop : null,
          };
        });
        if (!anchoring.mounted) fail("no jump strip once away from the tail");
        if (anchoring.after !== anchoring.before) fail(`the feed moved when the strip appeared: ${anchoring.before} → ${anchoring.after}`);
        if (anchoring.rowMoved !== null && Math.abs(anchoring.rowMoved) > 0.5) fail(`the line being read moved by ${anchoring.rowMoved} px when the strip appeared`);

        await feedAtRest(page);
        const away = await readJump(page);
        await page.screenshot({ path: path.join(JUMP_OUT, `${key}.png`) });
        const { strip, control, pill, feed } = away;
        if (!strip || !control || !pill) fail(`strip, control and pill: ${JSON.stringify({ strip, control, pill })}`);
        else {
          if (Math.abs(strip.height - 44) > 0.5) fail(`the strip is ${strip.height} px tall, expected 44`);
          if (control.width < 44 - 0.5 || control.height < 44 - 0.5) fail(`the control's target is ${control.width}x${control.height}`);
          if (Math.abs(pill.height - 32) > 0.5) fail(`the pill is ${pill.height} px tall, expected 32`);
          if (feed.y + feed.height > strip.y + 0.5) fail(`the feed ends at ${feed.y + feed.height}, below the strip's top ${strip.y}`);
          if (strip.y < 0 || strip.y + strip.height > viewport.height + 0.5) fail(`the strip is outside the page: ${JSON.stringify(strip)}`);
          if (away.composerTop !== null && strip.y + strip.height > away.composerTop + 0.5) fail(`the strip reaches into the composer at ${away.composerTop}`);
        }
        if (away.inkOnStrip.length) fail(`text under the strip: ${JSON.stringify(away.inkOnStrip)}`);
        if (away.controlsCrossing.length) fail(`controls crossing the jump control: ${JSON.stringify(away.controlsCrossing)}`);
        if (away.overflowX > 0.5) fail(`the page overflows sideways by ${away.overflowX} px`);
        const word = translate(lang, "feed.down");
        if (!away.label.includes(word) && !/\d/.test(away.label)) fail(`the control reads «${away.label}», expected «${word}» or a count`);

        await page.locator("[data-feed-jump-strip] button").click();
        await pause(page, 600);
        await feedAtRest(page);
        const back = await page.evaluate(() => {
          const feed = document.querySelector("[data-log-feed-scroller]")!;
          return { strip: Boolean(document.querySelector("[data-feed-jump-strip]")), fromBottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop };
        });
        if (back.strip) fail("the strip stayed after returning to the tail");
        if (back.fromBottom > 60) fail(`the tap left the feed ${back.fromBottom} px from the tail`);
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
        results.push({ key, viewport, scheme, lang, following: following.strip, anchoring, away, back });
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(JUMP_EVIDENCE, "jump-strip.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);
