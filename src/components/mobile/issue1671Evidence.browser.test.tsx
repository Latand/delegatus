import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";

import { serveEvidenceFixture } from "@/components/kanban/issue1695BrowserHarness";
import { translate } from "@/lib/i18n";

/*
 * The phone's browser evidence driver: the real Viewer at phone width, in
 * both colour schemes, against the production stylesheet
 * (`issue1671Evidence.fixture.tsx`), one case per issue:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "<case>"
 *
 * happy-dom has no compositor, so what only a browser can settle is settled
 * here, with real touch input where a gesture is the question — CDP
 * `Input.dispatchTouchEvent`, so the page's `touch-action` meets Chromium's
 * own gesture recognizer.
 *
 * #1671's case drove the board's swipe tray and its inline «All
 * conversations». Both left the board with #2072 slice 4 (the column pager
 * owns the sideways swipe, and history leaves the work surface); its readings
 * stay in `evidence/issue-1671/geometry.json`, what a row can have done to it
 * is now its long-press sheet, and the #2072 slice 4 cases below drive that
 * board with real touches.
 */

const browserTest = process.env.LLV_SWIPE_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1671");
/** The fixture's running conversation, under its managed account's home. */
const runningPath = (account: string) => `/state/agent-log-viewer/shared/accounts/claude/${account}/projects/atlas/running.jsonl`;
const RUNNING_PATH = runningPath("spare");
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 430, height: 932 }] as const;
const SCHEMES = ["light", "dark"] as const;

type Point = [number, number];
interface Rect { x: number; y: number; width: number; height: number }

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

/*
 * #2072 slice 4 — the phone's status columns (docs/design/phone-kanban.md
 * §3.2–§3.4, §3.9, §5), on the same real Viewer over the fixture's `?kanban=1`
 * scene, at the page iOS Safari leaves at 390 × 844 and 430 × 932, in en and
 * uk, dark and light:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2072 slice 4"
 *
 * Each column is opened from its tab and measured where it rests. Gates: no
 * sideways overflow; every visible control at least 44 × 44 and no two
 * crossing; the ink of each text (the union of its client rects, clipped by
 * its overflow ancestors) meets no other text's ink and no control it is not
 * inside; card titles two lines at most; tab labels whole; the dock inside
 * the page; each card's stage chain one line with its current stage whole;
 * no card age reads like a clock; what a tab's ⚠n counts is its first n
 * cards. Frames go to `LLV_KANBAN_FRAMES` (default `.artifacts/phone-kanban-s4`,
 * not committed); readings to `evidence/issue-2072/columns.json`.
 */
const COLUMNS_OUT = path.resolve(process.env.LLV_KANBAN_FRAMES || ".artifacts/phone-kanban-s4");
const COLUMNS_EVIDENCE = path.resolve("evidence/issue-2072");
const COLUMN_ORDER = ["inbox", "assigned", "blocked", "done"] as const;

interface ColumnReading {
  active: string | null;
  pagerAligned: number;
  overflowX: number;
  columnOverflowX: number;
  cards: Array<{ key: string; height: number; titleLines: number; needs: boolean }>;
  smallControls: Array<{ label: string; width: number; height: number }>;
  crossingControls: string[];
  inkOverlaps: string[];
  inkOnControls: string[];
  truncatedTabs: string[];
  chainOverflow: string[];
  cutCurrentStage: string[];
  clockAges: string[];
  dock: Rect | null;
  tabs: Array<{ status: string; count: string | null; working: string | null; needs: string | null }>;
  pinnedFirst: boolean;
  empty: boolean;
  more: string | null;
}

/* Runs in the page; the ink walk is the test's own. */
const readColumn = (page: Page) => page.evaluate((): ColumnReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const clip = (element: Element): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return { l: Math.max(out.l, 0), t: Math.max(out.t, 0), r: Math.min(out.r, innerWidth), b: Math.min(out.b, innerHeight) };
  };
  const board = document.querySelector<HTMLElement>("[data-phone-kanban]")!;
  const active = board.getAttribute("data-phone-kanban-active");
  const pager = board.querySelector<HTMLElement>("[data-phone-kanban-pager]")!;
  const column = board.querySelector<HTMLElement>(`[data-phone-kanban-column="${active}"]`)!;
  /* What is on screen: the tab strip and the column at rest. */
  const scope = [board.querySelector("[data-phone-kanban-tabs]")!, column];
  const visible = (element: Element) => {
    const r = element.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const c = clip(element);
    return Math.min(r.right, c.r) - Math.max(r.left, c.l) > 1 && Math.min(r.bottom, c.b) - Math.max(r.top, c.t) > 1;
  };
  const controls = scope.flatMap((root) => [...root.querySelectorAll<HTMLElement>("button, a[href]")]).filter(visible);
  const label = (element: Element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60);
  /* A control as the operator can see and tap it: its box clipped by its
     overflow ancestors, so a card scrolled under the tab strip is only the
     part the column still shows. */
  const shown = (element: Element): Box => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return { l: Math.max(r.l, c.l), t: Math.max(r.t, c.t), r: Math.min(r.r, c.r), b: Math.min(r.b, c.b) };
  };
  /* Controls whose target the operator can reach whole: cut by the column's
     edge is scrolling, not a small target, so only whole ones are sized. */
  const whole = (element: Element) => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return r.t >= c.t - 0.5 && r.b <= c.b + 0.5;
  };
  const smallControls = controls.filter(whole).map((element) => ({ label: label(element), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))
    .filter((control) => control.width < 43.5 || control.height < 43.5);
  const crossingControls: string[] = [];
  controls.forEach((a, i) => controls.slice(i + 1).forEach((b) => {
    if (a.contains(b) || b.contains(a)) return;
    if (overlap(shown(a), shown(b)) > 0.5) crossingControls.push(`${label(a)} × ${label(b)}`);
  }));
  /* Ink: every text node in scope, as the rects it paints, clipped. */
  const inks: Array<{ node: Node; text: string; rect: Box; control: Element | null }> = [];
  const range = document.createRange();
  for (const root of scope) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || parent.closest(".sr-only")) continue;
      const c = clip(parent);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        const rect = { l: Math.max(q.left, c.l), t: Math.max(q.top, c.t), r: Math.min(q.right, c.r), b: Math.min(q.bottom, c.b) };
        if (rect.r - rect.l <= 0.5 || rect.b - rect.t <= 0.5) continue;
        inks.push({ node, text: node.textContent.trim().slice(0, 40), rect, control: parent.closest("button, a[href]") });
      }
    }
  }
  const inkOverlaps: string[] = [];
  inks.forEach((a, i) => inks.slice(i + 1).forEach((b) => {
    if (a.node === b.node) return;
    if (overlap(a.rect, b.rect) > 1) inkOverlaps.push(`«${a.text}» × «${b.text}»`);
  }));
  const inkOnControls: string[] = [];
  for (const ink of inks) {
    for (const control of controls) {
      if (ink.control === control || control.contains(ink.node) || (ink.control && ink.control.contains(control))) continue;
      if (overlap(ink.rect, shown(control)) > 1) inkOnControls.push(`«${ink.text}» on ${label(control)}`);
    }
  }
  const cards = [...column.querySelectorAll<HTMLElement>("[data-phone-card]")];
  const cardReadings = cards.map((card) => {
    const title = card.querySelector<HTMLElement>("[data-phone-card-title]")!;
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight) || 16;
    return { key: card.getAttribute("data-phone-card") ?? "", height: card.getBoundingClientRect().height, titleLines: Math.round(title.getBoundingClientRect().height / lineHeight), needs: card.getAttribute("data-needs") === "1" };
  });
  const needsCount = Number(board.querySelector(`[data-phone-kanban-tab="${active}"] [data-phone-tab-needs]`)?.getAttribute("data-phone-tab-needs") ?? "0");
  const firstNeeds = cardReadings.slice(0, needsCount).every((card) => card.needs) && cardReadings.slice(needsCount).every((card) => !card.needs);
  const chainOverflow = [...column.querySelectorAll<HTMLElement>('[data-density="card"] .pb-pills.fold')]
    .filter((pills) => pills.scrollWidth > pills.clientWidth + 0.5)
    .map((pills) => pills.closest("[data-phone-card]")?.getAttribute("data-phone-card") ?? "");
  const cutCurrentStage = [...column.querySelectorAll<HTMLElement>('[data-density="card"] .pb-pill:is(.tone-active, .tone-review, .tone-needs) .pb-name')]
    .filter((name) => name.scrollWidth > name.clientWidth + 0.5)
    .map((name) => name.textContent ?? "");
  const clockAges = [...column.querySelectorAll<HTMLElement>("[data-phone-card] span")]
    .map((span) => (span.childElementCount ? "" : (span.textContent ?? "").trim()))
    .filter((text) => /^\d{1,2}:\d{2}$/.test(text));
  const truncatedTabs = [...board.querySelectorAll<HTMLElement>("[data-phone-tab-label]")]
    .filter((labelElement) => labelElement.scrollWidth > labelElement.clientWidth + 0.5 || box(labelElement).l < box(labelElement.closest("button")!).l - 0.5 || box(labelElement).r > box(labelElement.closest("button")!).r + 0.5)
    .map((labelElement) => labelElement.textContent ?? "");
  const dockElement = document.querySelector("[data-mobile2-dock]");
  const dockRect = dockElement?.getBoundingClientRect() ?? null;
  return {
    active,
    pagerAligned: pager.scrollLeft - COLUMN_INDEX(active) * pager.clientWidth,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    columnOverflowX: column.scrollWidth - column.clientWidth,
    cards: cardReadings,
    smallControls,
    crossingControls,
    inkOverlaps,
    inkOnControls,
    truncatedTabs,
    chainOverflow,
    cutCurrentStage,
    clockAges,
    dock: dockRect ? { x: dockRect.x, y: dockRect.y, width: dockRect.width, height: dockRect.height } : null,
    tabs: [...board.querySelectorAll("[data-phone-kanban-tab]")].map((tab) => ({
      status: tab.getAttribute("data-phone-kanban-tab") ?? "",
      count: tab.querySelector("[data-phone-tab-count]")?.textContent ?? null,
      working: tab.querySelector("[data-phone-tab-working]")?.textContent ?? null,
      needs: tab.querySelector("[data-phone-tab-needs]")?.textContent ?? null,
    })),
    pinnedFirst: firstNeeds,
    empty: Boolean(column.querySelector("[data-phone-kanban-empty]")),
    more: column.querySelector("[data-phone-kanban-more]")?.textContent ?? null,
  };
  function COLUMN_INDEX(status: string | null): number {
    return ["inbox", "assigned", "blocked", "done"].indexOf(status ?? "");
  }
});

/* The pager at rest: its offset unchanged across 300 ms. */
async function pagerAtRest(page: Page): Promise<void> {
  let last = Number.NaN;
  let still = 0;
  for (let i = 0; i < 60 && still < 3; i += 1) {
    await pause(page, 100);
    const left = await page.evaluate(() => document.querySelector("[data-phone-kanban-pager]")?.scrollLeft ?? 0);
    still = left === last ? still + 1 : 0;
    last = left;
  }
  if (still < 3) throw new Error("the pager never came to rest");
}

browserTest("#2072 slice 4: the phone's status columns, each column at rest, in en and uk, dark and light", async () => {
  fs.mkdirSync(COLUMNS_OUT, { recursive: true });
  fs.mkdirSync(COLUMNS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = ([{ width: 390, height: 667 }, { width: 430, height: 735 }] as const).flatMap((viewport) =>
    (["en", "uk"] as const).flatMap((lang) => (["dark", "light"] as const).map((scheme) => ({ viewport, lang, scheme }))));
  try {
    for (const { viewport, lang, scheme } of cases) {
      const key = `${viewport.width}-${lang}-${scheme}`;
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await page.waitForSelector('[data-mobile2-seat-card][data-mobile2-seat-state="live"]', { timeout: 20_000 }).catch(() => {});
        await pause(page, 800);
        for (const status of COLUMN_ORDER) {
          await page.locator(`[data-phone-kanban-tab="${status}"]`).click();
          await page.waitForFunction((wanted) => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") === wanted, status);
          await pagerAtRest(page);
          /* The column from its top to its end, a screen at a time: every
             gate holds at each stop, so a card low in the column is measured
             where the operator would read it. */
          for (let stop = 0; stop < 8; stop += 1) {
          const fail = (label: string) => failures.push(`${key} ${status} @${stop}: ${label}`);
          const reading = await readColumn(page);
          await page.screenshot({ path: path.join(COLUMNS_OUT, `${viewport.width}-${lang}-${scheme}-${status}${stop ? `-${stop}` : ""}.png`) });
          if (Math.abs(reading.pagerAligned) > 1) fail(`the pager rests ${reading.pagerAligned} px off its column`);
          if (reading.overflowX > 0.5) fail(`the page overflows sideways by ${reading.overflowX} px`);
          if (reading.columnOverflowX > 0.5) fail(`the column overflows sideways by ${reading.columnOverflowX} px`);
          if (reading.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(reading.smallControls)}`);
          if (reading.crossingControls.length) fail(`controls crossing: ${JSON.stringify(reading.crossingControls)}`);
          if (reading.inkOverlaps.length) fail(`text over text: ${JSON.stringify(reading.inkOverlaps.slice(0, 6))}`);
          if (reading.inkOnControls.length) fail(`text over a control: ${JSON.stringify(reading.inkOnControls.slice(0, 6))}`);
          if (reading.truncatedTabs.length) fail(`tab labels cut: ${JSON.stringify(reading.truncatedTabs)}`);
          if (reading.chainOverflow.length) fail(`chains off their line: ${JSON.stringify(reading.chainOverflow)}`);
          if (reading.cutCurrentStage.length) fail(`current stage names cut: ${JSON.stringify(reading.cutCurrentStage)}`);
          if (reading.clockAges.length) fail(`ages that read as clocks: ${JSON.stringify(reading.clockAges)}`);
          const tall = reading.cards.filter((card) => card.titleLines > 2);
          if (tall.length) fail(`titles over two lines: ${JSON.stringify(tall)}`);
          if (!reading.pinnedFirst) fail("what the tab's ⚠ counts is not the column's first cards");
          if (!reading.dock || reading.dock.y < 0 || reading.dock.y + reading.dock.height > viewport.height + 0.5) fail(`the dock is not inside the page: ${JSON.stringify(reading.dock)}`);
          if (status === "blocked" && !reading.empty) fail("Blocked, which holds nothing, does not say so");
          if (status === "done" && !reading.more) fail("Done shows no «Show more» past its window");
          if (status !== "blocked" && reading.empty) fail("a column with work says it is empty");
          /* The running card with a one-line title (§5): at most 74 px. */
          const favicon = reading.cards.find((card) => card.key === "task:t-favicon");
          if (favicon && favicon.titleLines === 1 && favicon.height > 74.5) fail(`a running card with a one-line title is ${favicon.height} px tall`);
          results.push({ key, status, stop, viewport, lang, scheme, ...reading });
          const moved = await page.evaluate((wanted) => {
            const column = document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!;
            const before = column.scrollTop;
            column.scrollTop = before + Math.round(column.clientHeight * 0.85);
            return column.scrollTop !== before;
          }, status);
          if (!moved) break;
          await pause(page, 350);
          }
        }
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(COLUMNS_EVIDENCE, "columns.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2072 slice 4 — the columns under real touches (phone-kanban §3.3, §3.7,
 * §3.8): a sideways swipe over the column area moves the pager one column and
 * the tabs follow; a vertical drag scrolls that column alone, keeps the tab
 * and opens nothing; a held finger on a card opens the card's sheet and not
 * the task under it; Move to moves the card on the tap, writes one guarded
 * PATCH, and says so in a receipt with Undo; a tap opens the task.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2072 slice 4 touch"
 */
browserTest("#2072 slice 4 touch: the pager swipes, a column scrolls alone, a held card opens its sheet and Move to lands", async () => {
  fs.mkdirSync(COLUMNS_OUT, { recursive: true });
  fs.mkdirSync(COLUMNS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = [
    { viewport: { width: 390, height: 667 }, lang: "en", scheme: "dark" },
    { viewport: { width: 430, height: 735 }, lang: "uk", scheme: "light" },
  ] as const;
  try {
    for (const { viewport, lang, scheme } of cases) {
      const key = `${viewport.width}-${lang}-${scheme}`;
      const fail = (label: string) => failures.push(`${key}: ${label}`);
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await pause(page, 800);
        const active = () => page.evaluate(() => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") ?? null);
        const column = await rectOf(page, '[data-phone-kanban-column="assigned"]');
        if (!column) throw new Error("no Assigned column");
        const midY = column.y + Math.min(column.height / 2, 160);
        const opened = { start: await active() };

        /* Sideways: Assigned → Blocked, and back. */
        await touch(cdp, along([viewport.width - 30, midY], [40, midY + 4], 14), 16);
        await pagerAtRest(page);
        const afterLeft = await active();
        await touch(cdp, along([40, midY], [viewport.width - 30, midY + 4], 14), 16);
        await pagerAtRest(page);
        const afterRight = await active();
        if (opened.start !== "assigned") fail(`the board opened on ${opened.start}`);
        if (afterLeft !== "blocked") fail(`a swipe left from Assigned landed on ${afterLeft}`);
        if (afterRight !== "assigned") fail(`a swipe right from Blocked landed on ${afterRight}`);
        const tabSelected = await page.evaluate(() => document.querySelector('[data-phone-kanban-tab="assigned"]')?.getAttribute("aria-selected"));
        if (tabSelected !== "true") fail("the tabs did not follow the pager");

        /* Vertical: the column scrolls, the tab and the stack stay. */
        const scrollBefore = await page.evaluate(() => document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop);
        await touch(cdp, along([viewport.width / 2, midY + 120], [viewport.width / 2 + 3, midY - 120], 14), 16);
        await pause(page, 600);
        const vertical = await page.evaluate(() => ({
          scrollTop: document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop,
          active: document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active"),
          sheet: Boolean(document.querySelector("[data-mobile2-sheet]")),
        }));
        if (!(vertical.scrollTop > scrollBefore + 40)) fail(`a vertical drag scrolled the column by ${vertical.scrollTop - scrollBefore} px`);
        if (vertical.active !== "assigned") fail(`a vertical drag changed the column to ${vertical.active}`);
        if (vertical.sheet) fail("a vertical drag opened a sheet");
        await page.evaluate(() => { document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop = 0; });
        await pause(page, 300);

        /* A held finger: the sheet, not the task. */
        const card = '[data-phone-card="task:t-favicon"]';
        const cardBox = await rectOf(page, card);
        if (!cardBox) throw new Error("no favicon card");
        const held: Point = [cardBox.x + cardBox.width / 2, cardBox.y + 18];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: held[0], y: held[1] }] });
        await pause(page, 700);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await pause(page, 500);
        const sheet = await page.evaluate(() => ({
          open: Boolean(document.querySelector('[data-mobile2-sheet="card"]')),
          actions: [...document.querySelectorAll("[data-phone-card-sheet] [data-phone-card-action]")].map((row) => row.getAttribute("data-phone-card-action")),
          smallest: Math.min(...[...document.querySelectorAll<HTMLElement>("[data-phone-card-sheet] [data-phone-card-action]")].map((row) => row.getBoundingClientRect().height)),
        }));
        await page.screenshot({ path: path.join(COLUMNS_OUT, `${key}-card-sheet.png`) });
        if (!sheet.open) fail("a held finger on a card opened no sheet");
        if (sheet.actions.join(",") !== "move-inbox,move-blocked,move-done,hide,open-agent") fail(`the card sheet offers ${sheet.actions.join(",")}`);
        if (sheet.smallest < 43.5) fail(`a sheet row is ${sheet.smallest} px tall`);

        /* Move to Blocked: on the tap, one guarded PATCH, a receipt with Undo. */
        await tap(page, cdp, '[data-phone-card-action="move-blocked"]');
        await pause(page, 150);
        const moved = await page.evaluate(() => ({
          inBlocked: Boolean(document.querySelector('[data-phone-kanban-column="blocked"] [data-phone-card="task:t-favicon"]')),
          inAssigned: Boolean(document.querySelector('[data-phone-kanban-column="assigned"] [data-phone-card="task:t-favicon"]')),
          blockedCount: document.querySelector('[data-phone-kanban-tab="blocked"] [data-phone-tab-count]')?.textContent ?? null,
          receipt: document.querySelector("[data-mobile2-receipt]")?.textContent ?? "",
          undo: Boolean(document.querySelector('[data-mobile2-receipt-undo="undo"]')),
        }));
        await page.screenshot({ path: path.join(COLUMNS_OUT, `${key}-moved.png`) });
        await page.waitForFunction(() => (window as unknown as { evidence: { taskPatches: unknown[] } }).evidence.taskPatches.length >= 1, undefined, { timeout: 5_000 }).catch(() => undefined);
        const patches = await page.evaluate(() => structuredClone((window as unknown as { evidence: { taskPatches: Array<{ id: string; body: Record<string, unknown> }> } }).evidence.taskPatches));
        if (!moved.inBlocked || moved.inAssigned) fail(`the card did not move on the tap: ${JSON.stringify(moved)}`);
        if (moved.blockedCount !== "1") fail(`Blocked counts ${moved.blockedCount}`);
        if (!moved.receipt.includes(translate(lang, "mobile2.kanban.moved", { column: translate(lang, "kanban.status.blocked") }))) fail(`the receipt reads «${moved.receipt}»`);
        if (!moved.undo) fail("the receipt carries no Undo");
        if (patches.length !== 1 || patches[0]!.id !== "t-favicon" || patches[0]!.body.status !== "blocked" || typeof patches[0]!.body.expectedRevision !== "string") fail(`the writes were ${JSON.stringify(patches)}`);

        /* Undo moves it back through the same queue. */
        await tap(page, cdp, '[data-mobile2-receipt-undo="undo"]');
        await page.waitForFunction(() => Boolean(document.querySelector('[data-phone-kanban-column="assigned"] [data-phone-card="task:t-favicon"]')), undefined, { timeout: 5_000 }).catch(() => fail("Undo did not bring the card back"));
        await page.waitForFunction(() => (window as unknown as { evidence: { taskPatches: unknown[] } }).evidence.taskPatches.length >= 2, undefined, { timeout: 5_000 }).catch(() => fail("Undo sent no write"));

        /* A tap opens the task. */
        await pause(page, 400);
        await tap(page, cdp, card);
        await pause(page, 500);
        const taskOpen = await page.evaluate(() => Boolean(document.querySelector('[data-mobile2-task="t-favicon"] [data-phone-task-body="t-favicon"]')));
        if (!taskOpen) fail("a tap on a card did not open its task screen");
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
        results.push({ key, viewport, lang, scheme, opened, afterLeft, afterRight, vertical: { ...vertical, before: scrollBefore }, sheet, moved, patches, taskOpen });
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(COLUMNS_EVIDENCE, "columns-touch.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2072 slice 5 — the task screen (phone-kanban §3.5), opened from its card
 * the way the operator opens it: a task with one pipeline, one with seven
 * (three completed, folded), one with agents and no pipeline, and one whose
 * pipeline waits on a decision, at 390 × 667 and 430 × 735 (the page Safari
 * leaves), in en and uk, dark. At every scroll stop: no sideways overflow, no
 * text over text or over a control (the ink walk of the columns' case), every
 * whole control at least 44 × 44 counting the reach a pill or a chip draws
 * past its box, no two controls crossing, and the bottom bar inside the page.
 * The 390 frames, and the whole scroll of each, are the review's pictures.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2072 slice 5"
 */
const TASK_OUT = path.resolve(process.env.LLV_TASK_FRAMES || ".artifacts/phone-kanban-s5");
const TASK_CASES = [
  { key: "one-pipeline", task: "t-favicon" },
  { key: "many", task: "t-many" },
  { key: "agents", task: "t-long" },
  { key: "decision", task: "t-data" },
] as const;

interface TaskReading {
  overflowX: number;
  bodyOverflowX: number;
  smallControls: Array<{ label: string; width: number; height: number }>;
  crossingControls: string[];
  inkOverlaps: string[];
  inkOnControls: string[];
  dock: Rect | null;
  lanes: string[];
  scrollHeight: number;
  clientHeight: number;
}

const readTaskScreen = (page: Page) => page.evaluate((): TaskReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const clip = (element: Element): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return { l: Math.max(out.l, 0), t: Math.max(out.t, 0), r: Math.min(out.r, innerWidth), b: Math.min(out.b, innerHeight) };
  };
  const screen = document.querySelector<HTMLElement>("[data-mobile2-task]")!;
  const body = screen.querySelector<HTMLElement>("[data-phone-task-body]")!;
  const scope = [screen.querySelector("[data-mobile2-bar]")!, body, screen.querySelector("[data-mobile2-dock]")].filter((element): element is Element => Boolean(element));
  /* A swipe row's tray waits under its card at opacity 0 until a swipe
     reveals it: nothing there is on screen. */
  const transparent = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) if (getComputedStyle(node).opacity === "0") return true;
    return false;
  };
  const visible = (element: Element) => {
    const r = element.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || transparent(element)) return false;
    const c = clip(element);
    return Math.min(r.right, c.r) - Math.max(r.left, c.l) > 1 && Math.min(r.bottom, c.b) - Math.max(r.top, c.t) > 1;
  };
  const controls = scope.flatMap((root) => [...root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")]).filter(visible);
  const label = (element: Element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60);
  const shown = (element: Element): Box => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return { l: Math.max(r.l, c.l), t: Math.max(r.t, c.t), r: Math.min(r.r, c.r), b: Math.min(r.b, c.b) };
  };
  const whole = (element: Element) => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return r.t >= c.t - 0.5 && r.b <= c.b + 0.5;
  };
  /* The target a finger has: the box, grown by a positioned ::after reach. */
  const target = (element: Element) => {
    const r = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    if (after.content === "none" || after.position !== "absolute") return { width: r.width, height: r.height };
    const px = (value: string) => (value.endsWith("px") ? parseFloat(value) : 0);
    return { width: r.width - Math.min(0, px(after.left)) - Math.min(0, px(after.right)), height: r.height - Math.min(0, px(after.top)) - Math.min(0, px(after.bottom)) };
  };
  const smallControls = controls.filter(whole).map((element) => ({ label: label(element), ...target(element) }))
    .filter((control) => control.width < 43.5 || control.height < 43.5);
  const crossingControls: string[] = [];
  controls.forEach((a, i) => controls.slice(i + 1).forEach((b) => {
    if (a.contains(b) || b.contains(a)) return;
    if (overlap(shown(a), shown(b)) > 0.5) crossingControls.push(`${label(a)} × ${label(b)}`);
  }));
  const inks: Array<{ node: Node; text: string; rect: Box; control: Element | null }> = [];
  const range = document.createRange();
  for (const root of scope) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || parent.closest(".sr-only") || transparent(parent)) continue;
      const c = clip(parent);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        const rect = { l: Math.max(q.left, c.l), t: Math.max(q.top, c.t), r: Math.min(q.right, c.r), b: Math.min(q.bottom, c.b) };
        if (rect.r - rect.l <= 0.5 || rect.b - rect.t <= 0.5) continue;
        inks.push({ node, text: node.textContent.trim().slice(0, 40), rect, control: parent.closest("button, a[href]") });
      }
    }
  }
  const inkOverlaps: string[] = [];
  inks.forEach((a, i) => inks.slice(i + 1).forEach((b) => {
    if (a.node === b.node) return;
    if (overlap(a.rect, b.rect) > 1) inkOverlaps.push(`«${a.text}» × «${b.text}»`);
  }));
  const inkOnControls: string[] = [];
  for (const ink of inks) {
    for (const control of controls) {
      if (ink.control === control || control.contains(ink.node) || (ink.control && ink.control.contains(control))) continue;
      if (overlap(ink.rect, shown(control)) > 1) inkOnControls.push(`«${ink.text}» on ${label(control)}`);
    }
  }
  const dockElement = screen.querySelector("[data-mobile2-dock]");
  const dockRect = dockElement?.getBoundingClientRect() ?? null;
  return {
    overflowX: document.documentElement.scrollWidth - innerWidth,
    bodyOverflowX: body.scrollWidth - body.clientWidth,
    smallControls,
    crossingControls,
    inkOverlaps,
    inkOnControls,
    dock: dockRect ? { x: dockRect.x, y: dockRect.y, width: dockRect.width, height: dockRect.height } : null,
    lanes: [...body.querySelectorAll("[data-phone-task-lane]")].map((lane) => lane.getAttribute("data-phone-task-lane") ?? ""),
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
  };
});

browserTest("#2072 slice 5: the task screen, opened from its card, in en and uk at 390 and 430, holds its ink, targets and bar", async () => {
  fs.mkdirSync(TASK_OUT, { recursive: true });
  fs.mkdirSync(COLUMNS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = ([{ width: 390, height: 667 }, { width: 430, height: 735 }] as const).flatMap((viewport) =>
    (["en", "uk"] as const).flatMap((lang) => TASK_CASES.map((entry) => ({ viewport, lang, ...entry }))));
  try {
    for (const { viewport, lang, key: scene, task } of cases) {
      const key = `${scene}-${viewport.width}-${lang}`;
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: "dark" });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
        await page.waitForSelector(`[data-phone-card="task:${task}"]`, { timeout: 20_000 });
        await pause(page, 600);
        await page.locator(`[data-phone-card="task:${task}"]`).click();
        await page.waitForSelector(`[data-mobile2-task="${task}"] [data-phone-task-body="${task}"]`, { timeout: 10_000 });
        /* A finger lifts; the driver's pointer would stay and hover the row under it. */
        await page.mouse.move(0, 0);
        await pause(page, 600);
        if (scene === "many") {
          await page.locator("[data-phone-task-ended]").click();
          await pause(page, 300);
          await page.evaluate(() => { document.querySelector("[data-phone-task-body]")!.scrollTop = 0; });
          await pause(page, 200);
        }
        for (let stop = 0; stop < 12; stop += 1) {
          const fail = (label: string) => failures.push(`${key} @${stop}: ${label}`);
          const reading = await readTaskScreen(page);
          await page.screenshot({ path: path.join(TASK_OUT, `task-${key}${stop ? `-${stop}` : ""}.png`) });
          if (reading.overflowX > 0.5) fail(`the page overflows sideways by ${reading.overflowX} px`);
          if (reading.bodyOverflowX > 0.5) fail(`the body overflows sideways by ${reading.bodyOverflowX} px`);
          if (reading.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(reading.smallControls)}`);
          if (reading.crossingControls.length) fail(`controls crossing: ${JSON.stringify(reading.crossingControls)}`);
          if (reading.inkOverlaps.length) fail(`text over text: ${JSON.stringify(reading.inkOverlaps.slice(0, 6))}`);
          if (reading.inkOnControls.length) fail(`text over a control: ${JSON.stringify(reading.inkOnControls.slice(0, 6))}`);
          if (!reading.dock || reading.dock.y < 0 || reading.dock.y + reading.dock.height > viewport.height + 0.5) fail(`the bottom bar is not inside the page: ${JSON.stringify(reading.dock)}`);
          if (stop === 0 && scene === "many" && reading.lanes.length !== 7) fail(`the task with seven pipelines draws ${reading.lanes.length}`);
          if (stop === 0 && scene === "decision" && reading.lanes[0] !== "lane-decision") fail(`the lane that needs a decision is not first: ${reading.lanes.join(",")}`);
          results.push({ key, stop, viewport, lang, ...reading });
          const moved = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>("[data-phone-task-body]")!;
            const before = body.scrollTop;
            body.scrollTop = before + Math.round(body.clientHeight * 0.85);
            return body.scrollTop !== before;
          });
          if (!moved) break;
          await pause(page, 250);
        }
        /* The whole scroll in one frame, at 390: the page grown to hold it. */
        if (viewport.width === 390) {
          const { scrollHeight, clientHeight } = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>("[data-phone-task-body]")!;
            body.scrollTop = 0;
            return { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
          });
          await page.setViewportSize({ width: viewport.width, height: viewport.height + Math.max(0, scrollHeight - clientHeight) });
          await pause(page, 400);
          await page.screenshot({ path: path.join(TASK_OUT, `task-${scene}-390-full-${lang}.png`) });
          await page.setViewportSize(viewport);
        }
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(COLUMNS_EVIDENCE, "task-screen.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2098 — the Overview on the phone is the phone kanban over every project
 * (docs/design/phone-kanban.md §3; issue #2098). The fixture's board spread
 * over three projects (`?overview=1`), at 390 × 667 and 430 × 735, en and uk,
 * dark. Each tab at rest carries the columns' gates (no sideways overflow,
 * whole controls at least 44 × 44 and none crossing, the ink of every text
 * meeting no other ink and no control, titles two lines at most, tab labels
 * whole, chains on one line, no clock-like ages, the pin first), and the
 * Overview's own: every card names its project by its display name and no
 * key shows, and nothing of the desktop board is on the page. A card opens
 * its task screen (the slice 5 gates) and ‹ lands on the column it left; a
 * row no task owns opens its conversation full screen, its feed the screen's
 * width and inside no card. Frames go to `LLV_OVERVIEW_FRAMES` (default
 * `.artifacts/phone-overview`, not committed); readings to
 * `evidence/issue-2098/overview.json`.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2098"
 */
const OVERVIEW_OUT = path.resolve(process.env.LLV_OVERVIEW_FRAMES || ".artifacts/phone-overview");
const OVERVIEW_EVIDENCE = path.resolve("evidence/issue-2098");
const OVERVIEW_NAMES = ["delegatus", "forge-api", "atlas-docs"];

const readOverviewCards = (page: Page) => page.evaluate(() => {
  const board = document.querySelector<HTMLElement>("[data-phone-kanban]")!;
  const column = board.querySelector<HTMLElement>(`[data-phone-kanban-column="${board.getAttribute("data-phone-kanban-active")}"]`)!;
  return {
    projects: [...column.querySelectorAll<HTMLElement>("[data-phone-card]")].map((card) => card.querySelector("[data-phone-card-project]")?.textContent ?? null),
    keyShown: /repo-[0-9a-f]{8,}/.test(board.textContent ?? ""),
    desktop: [...document.querySelectorAll("[data-kanban-board], [data-kanban-search], [data-hidden-pill], [data-kanban-reader]")].length,
  };
});

const readConversationScreen = (page: Page) => page.evaluate(() => {
  const screen = document.querySelector<HTMLElement>('[data-mobile2-screen="chat"]');
  const feed = screen?.querySelector<HTMLElement>("[data-feed-state]") ?? null;
  const rect = feed?.getBoundingClientRect() ?? null;
  return {
    open: Boolean(screen),
    back: Boolean(screen?.querySelector("[data-mobile2-back]")),
    board: Boolean(document.querySelector("[data-phone-kanban]")),
    feedWidth: rect?.width ?? 0,
    feedInCard: Boolean(feed?.closest("[data-phone-card], [data-kanban-card]")),
    overflowX: document.documentElement.scrollWidth - innerWidth,
    /* The screen reaches the page's bottom: a band under it is a keyboard
       inset nobody opened. */
    bandBelow: innerHeight - (screen?.getBoundingClientRect().bottom ?? 0),
    innerHeight,
  };
});

browserTest("#2098: the phone's Overview is the phone kanban over three projects, and what a card opens opens full screen", async () => {
  fs.mkdirSync(OVERVIEW_OUT, { recursive: true });
  fs.mkdirSync(OVERVIEW_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = ([{ width: 390, height: 667 }, { width: 430, height: 735 }] as const).flatMap((viewport) =>
    (["en", "uk"] as const).map((lang) => ({ viewport, lang })));
  try {
    for (const { viewport, lang } of cases) {
      const key = `${viewport.width}-${lang}`;
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: "dark" });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?overview=1`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await pause(page, 800);
        /* The bar's ⚠ and the tabs' ⚠ marks are one list: every project's
           asking conversations and parked lanes. */
        const queue = await page.evaluate(() => ({
          badge: Number(document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? "0"),
          marks: [...document.querySelectorAll("[data-phone-tab-needs]")].reduce((sum, mark) => sum + Number(mark.textContent), 0),
        }));
        if (queue.badge !== queue.marks) failures.push(`${key}: the ⚠ badge counts ${queue.badge}, the tabs mark ${queue.marks}`);
        results.push({ key, viewport, lang, queue });
        for (const status of COLUMN_ORDER) {
          await page.locator(`[data-phone-kanban-tab="${status}"]`).click();
          await page.waitForFunction((wanted) => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") === wanted, status);
          await pagerAtRest(page);
          await page.mouse.move(0, 0);
          for (let stop = 0; stop < 8; stop += 1) {
            const fail = (label: string) => failures.push(`${key} ${status} @${stop}: ${label}`);
            const reading = await readColumn(page);
            const cards = await readOverviewCards(page);
            await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-${status}${stop ? `-${stop}` : ""}.png`) });
            if (Math.abs(reading.pagerAligned) > 1) fail(`the pager rests ${reading.pagerAligned} px off its column`);
            if (reading.overflowX > 0.5) fail(`the page overflows sideways by ${reading.overflowX} px`);
            if (reading.columnOverflowX > 0.5) fail(`the column overflows sideways by ${reading.columnOverflowX} px`);
            if (reading.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(reading.smallControls)}`);
            if (reading.crossingControls.length) fail(`controls crossing: ${JSON.stringify(reading.crossingControls)}`);
            if (reading.inkOverlaps.length) fail(`text over text: ${JSON.stringify(reading.inkOverlaps.slice(0, 6))}`);
            if (reading.inkOnControls.length) fail(`text over a control: ${JSON.stringify(reading.inkOnControls.slice(0, 6))}`);
            if (reading.truncatedTabs.length) fail(`tab labels cut: ${JSON.stringify(reading.truncatedTabs)}`);
            if (reading.chainOverflow.length) fail(`chains off their line: ${JSON.stringify(reading.chainOverflow)}`);
            if (reading.cutCurrentStage.length) fail(`current stage names cut: ${JSON.stringify(reading.cutCurrentStage)}`);
            if (reading.clockAges.length) fail(`ages that read as clocks: ${JSON.stringify(reading.clockAges)}`);
            const tall = reading.cards.filter((card) => card.titleLines > 2);
            if (tall.length) fail(`titles over two lines: ${JSON.stringify(tall)}`);
            if (!reading.pinnedFirst) fail("what the tab's ⚠ counts is not the column's first cards");
            const unnamed = cards.projects.filter((name) => !name || !OVERVIEW_NAMES.includes(name));
            if (unnamed.length) fail(`cards that do not name their project: ${JSON.stringify(unnamed)}`);
            if (cards.keyShown) fail("a project key is on the board");
            if (cards.desktop) fail(`${cards.desktop} pieces of the desktop board are on the phone`);
            if ((status === "inbox" || status === "assigned") && reading.empty) fail(`${status} holds live work and says it is empty`);
            results.push({ key, status, stop, viewport, lang, ...reading, overview: cards });
            const moved = await page.evaluate((wanted) => {
              const column = document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!;
              const before = column.scrollTop;
              column.scrollTop = before + Math.round(column.clientHeight * 0.85);
              return column.scrollTop !== before;
            }, status);
            if (!moved) break;
            await pause(page, 350);
          }
          await page.evaluate((wanted) => { document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!.scrollTop = 0; }, status);
        }

        /* A card opens its task over the Overview; ‹ lands on the column. */
        await page.locator('[data-phone-kanban-tab="assigned"]').click();
        await pagerAtRest(page);
        await page.locator('[data-phone-card="task:t-favicon"]').click();
        await page.waitForSelector('[data-mobile2-task="t-favicon"] [data-phone-task-body="t-favicon"]', { timeout: 10_000 });
        await page.mouse.move(0, 0);
        await pause(page, 600);
        const task = await readTaskScreen(page);
        await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-task.png`) });
        const taskFail = (label: string) => failures.push(`${key} task: ${label}`);
        if (task.overflowX > 0.5) taskFail(`the page overflows sideways by ${task.overflowX} px`);
        if (task.smallControls.length) taskFail(`controls under 44 px: ${JSON.stringify(task.smallControls)}`);
        if (task.crossingControls.length) taskFail(`controls crossing: ${JSON.stringify(task.crossingControls)}`);
        if (task.inkOverlaps.length) taskFail(`text over text: ${JSON.stringify(task.inkOverlaps.slice(0, 6))}`);
        if (task.inkOnControls.length) taskFail(`text over a control: ${JSON.stringify(task.inkOnControls.slice(0, 6))}`);
        /* The task's agent row opens its conversation over the Overview, and
           the Overview stays the scope: the same ⚠, nothing stored as the
           project to reopen. */
        const scope = () => page.evaluate(() => ({
          badge: document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? null,
          stored: localStorage.getItem("llvProject"),
        }));
        const beforeAgent = await scope();
        await page.locator("[data-phone-task-agent] button").first().click();
        await page.waitForSelector('[data-mobile2-screen="chat"]', { timeout: 10_000 });
        await pause(page, 900);
        const afterAgent = await scope();
        if (afterAgent.badge !== beforeAgent.badge || afterAgent.stored !== "__overview__") taskFail(`an agent row changed the scope: ${JSON.stringify({ beforeAgent, afterAgent })}`);
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector('[data-mobile2-task="t-favicon"] [data-phone-task-body="t-favicon"]', { timeout: 10_000 });
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 10_000 });
        const backOn = await page.evaluate(() => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active"));
        if (backOn !== "assigned") taskFail(`‹ from the task landed on ${backOn}`);

        /* A row no task owns opens its conversation full screen. */
        await page.locator('[data-phone-kanban-tab="inbox"]').click();
        await pagerAtRest(page);
        const row = page.locator(`[data-phone-card-agent="${RUNNING_PATH}"]`);
        await row.scrollIntoViewIfNeeded();
        await row.click();
        await page.waitForSelector('[data-mobile2-screen="chat"] [data-feed-state]', { timeout: 10_000 });
        await page.mouse.move(0, 0);
        await pause(page, 900);
        const conversation = await readConversationScreen(page);
        await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-conversation.png`) });
        const chatFail = (label: string) => failures.push(`${key} conversation: ${label}`);
        if (!conversation.open || !conversation.back) chatFail(`the conversation is not a screen with ‹: ${JSON.stringify(conversation)}`);
        if (conversation.board) chatFail("the Overview's board is still drawn beside the conversation");
        if (conversation.feedInCard) chatFail("the feed is drawn inside a card");
        if (conversation.feedWidth < viewport.width - 24) chatFail(`the feed is ${conversation.feedWidth} px wide on a ${viewport.width} px page`);
        if (conversation.overflowX > 0.5) chatFail(`the page overflows sideways by ${conversation.overflowX} px`);
        if (conversation.bandBelow > 0.5 || conversation.innerHeight !== viewport.height) chatFail(`${conversation.bandBelow} px of empty band under the conversation (innerHeight ${conversation.innerHeight})`);
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 10_000 });

        /* A search result lands through the hash, as the search palette sends
           it: over the Overview too, and ‹ comes back to the Overview. */
        const beforeSearch = await scope();
        await page.evaluate((transcript) => { location.hash = "#f=" + encodeURIComponent(transcript); }, RUNNING_PATH);
        await page.waitForSelector('[data-mobile2-screen="chat"] [data-feed-state]', { timeout: 10_000 });
        await pause(page, 900);
        const afterSearch = { ...(await scope()), band: (await readConversationScreen(page)).bandBelow };
        if (afterSearch.badge !== beforeSearch.badge || afterSearch.stored !== "__overview__" || afterSearch.band > 0.5) chatFail(`a search result changed the scope or left a band: ${JSON.stringify({ beforeSearch, afterSearch })}`);
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 10_000 });
        const searchBack = await page.evaluate(() => ({ hash: location.hash, board: Boolean(document.querySelector("[data-phone-kanban]")) }));
        if (searchBack.hash || !searchBack.board) chatFail(`‹ from a search result landed on ${JSON.stringify(searchBack)}`);

        /* ⋯ › Hidden tasks, over the Overview. */
        await page.locator('[data-mobile2-open="menu"]').click();
        await page.locator('[data-mobile2-open="hidden"]').click();
        await page.waitForSelector("[data-phone-hidden-sheet]", { timeout: 5_000 });
        await pause(page, 500);
        const hidden = await page.evaluate(() => [...document.querySelectorAll("[data-phone-hidden-row]")].map((row) => row.getAttribute("data-phone-hidden-row")));
        await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-hidden.png`) });
        if (hidden.join(",") !== "t-seat,t-quota") failures.push(`${key} hidden: the sheet lists ${hidden.join(",")}`);
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        results.push({ key, viewport, lang, task, agentScope: { beforeAgent, afterAgent }, backOn, conversation, searchScope: { beforeSearch, afterSearch, searchBack }, hidden });
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(OVERVIEW_EVIDENCE, "overview.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * The Telegram bot account's setup panel (docs/design/telegram-bot-account.md)
 * — not connected, connected with chats, and reading blocked by a webhook — on
 * the phone (menu › Accounts › Telegram) at 390 and 430 in both schemes, and
 * on the desktop from the rail footer at 1440:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "telegram bot"
 *
 * Frames go to `$LLV_TELEGRAM_BOT_OUT` (default `.artifacts/telegram-bot`),
 * readings to `evidence/telegram-bot/panel.json`. A case fails on horizontal
 * overflow, a control cut by the panel's edge, two text boxes overlapping, a
 * phone target under 44 px, or, on the phone, a sheet narrower than the screen
 * or with no scrim behind it.
 */
const BOT_OUT = path.resolve(process.env.LLV_TELEGRAM_BOT_OUT ?? ".artifacts/telegram-bot");
const BOT_EVIDENCE = path.resolve("evidence/telegram-bot");
const BOT_SCENES = ["none", "chats", "webhook"] as const;

async function readTelegramPanel(page: Page, phone: boolean) {
  return page.evaluate((isPhone) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Telegram"]');
    if (!dialog) return null;
    const box = dialog.getBoundingClientRect();
    const failures: string[] = [];
    if (dialog.scrollWidth > dialog.clientWidth + 1) failures.push(`horizontal overflow ${dialog.scrollWidth} > ${dialog.clientWidth}`);
    if (box.left < -0.5 || box.right > window.innerWidth + 0.5) failures.push(`panel leaves the viewport: ${box.left}..${box.right}`);
    /* On the phone the sheet spans the screen over a dimming scrim, so none
       of the Accounts list shows beside it. */
    const scrim = document.querySelector<HTMLElement>("[data-telegram-scrim]");
    const scrimColor = scrim ? getComputedStyle(scrim).backgroundColor : null;
    if (isPhone && (box.left > 0.5 || box.right < window.innerWidth - 0.5)) failures.push(`the sheet leaves the screen's sides uncovered: ${box.left}..${box.right} of ${window.innerWidth}`);
    if (isPhone && (!scrimColor || scrimColor === "rgba(0, 0, 0, 0)" || scrimColor === "transparent")) failures.push(`no scrim behind the sheet (${scrimColor})`);
    const controls = [...dialog.querySelectorAll<HTMLElement>("button, input, summary")]
      .filter((element) => element.getClientRects().length > 0 && !(element.closest("details:not([open])") && !element.closest("summary")));
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40) ?? control.tagName;
      if (rect.left < box.left - 0.5 || rect.right > box.right + 0.5) failures.push(`control cut by the panel edge: ${name}`);
      if (isPhone && rect.height < 43.5) failures.push(`phone target under 44 px: ${name} (${rect.height})`);
    }
    /* Ink, not boxes: the union of each text leaf's own line rects. */
    /* A closed <details> keeps boxes for what it hides; that is not ink. */
    const hidden = (element: Element) => {
      const details = element.closest("details:not([open])");
      return details !== null && !element.closest("summary");
    };
    const leaves = [...dialog.querySelectorAll<HTMLElement>("span, p, label, h3, h4, summary, li")]
      .filter((element) => element.childElementCount === 0 && (element.textContent ?? "").trim() !== "" && element.getClientRects().length > 0 && !hidden(element));
    /* A range's rects run past an ellipsis and out of a clipped box
       (a truncated title, an sr-only line); the part a box with overflow
       other than visible cuts off is not ink. */
    const clipOf = (element: HTMLElement) => {
      let clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
      for (let node: HTMLElement | null = element; node && node !== dialog; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const r = node.getBoundingClientRect();
        clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
      }
      return clip;
    };
    const inkOf = (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const clip = clipOf(element);
      return [...range.getClientRects()]
        .map((r) => ({ left: Math.max(r.left, clip.left), top: Math.max(r.top, clip.top), right: Math.min(r.right, clip.right), bottom: Math.min(r.bottom, clip.bottom) }))
        .filter((r) => r.right - r.left > 1 && r.bottom - r.top > 1);
    };
    const inks = leaves.map((element) => ({ element, rects: inkOf(element) }));
    let overlaps = 0;
    for (let a = 0; a < inks.length; a += 1) {
      for (let b = a + 1; b < inks.length; b += 1) {
        if (inks[a]!.element.contains(inks[b]!.element) || inks[b]!.element.contains(inks[a]!.element)) continue;
        const hit = inks[a]!.rects.some((r1) => inks[b]!.rects.some((r2) =>
          Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left) > 1 && Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top) > 1));
        if (hit) {
          overlaps += 1;
          failures.push(`text overlaps: "${inks[a]!.element.textContent?.slice(0, 30)}" / "${inks[b]!.element.textContent?.slice(0, 30)}"`);
        }
      }
    }
    return {
      panel: { left: box.left, top: box.top, width: box.width, height: box.height, scrollHeight: dialog.scrollHeight },
      scrim: scrimColor,
      botSectionHeight: dialog.querySelector('section[aria-label="Bot"]')?.getBoundingClientRect().height ?? null,
      controls: controls.length,
      textLeaves: leaves.length,
      overlaps,
      failures,
    };
  }, phone);
}

async function openTelegramPanel(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.locator('[data-mobile2-open="menu"]').first().click();
    await page.locator('[data-mobile2-menu-row="accounts"]').click();
    await page.waitForSelector("[data-mobile2-telegram] button", { timeout: 10_000 });
    await page.locator("[data-mobile2-telegram] button").first().click();
  } else {
    const footer = page.locator("[data-rail-footer]").first();
    await footer.waitFor({ timeout: 10_000 });
    if (await footer.getAttribute("data-rail-footer") === "folded") await page.click("[data-rail-footer-toggle]");
    await page.locator('button[aria-label="Telegram connection"]').click();
  }
  await page.waitForSelector('[role="dialog"][aria-label="Telegram"] section[aria-label="Bot"]', { timeout: 10_000 });
  await pause(page, 500);
}

browserTest("telegram bot: the setup panel on the phone and the desktop holds its width, controls and ink", async () => {
  fs.mkdirSync(BOT_OUT, { recursive: true });
  fs.mkdirSync(BOT_EVIDENCE, { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = [
    ...VIEWPORTS.flatMap((viewport) => SCHEMES.map((scheme) => ({ viewport, scheme, phone: true }))),
    { viewport: { width: 1_440, height: 900 }, scheme: "light" as const, phone: false },
    { viewport: { width: 1_440, height: 900 }, scheme: "dark" as const, phone: false },
  ];
  try {
    for (const { viewport, scheme, phone } of cases) {
      for (const scene of BOT_SCENES) {
        const key = `${phone ? "phone" : "desktop"}-${viewport.width}-${scheme}-${scene}`;
        const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${base}/?bot=${scene}`);
          await openTelegramPanel(page, phone);
          const top = await readTelegramPanel(page, phone);
          await page.screenshot({ path: path.join(BOT_OUT, `${key}.png`) });
          /* The panel scrolls inside itself; the second frame is its end. */
          await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"][aria-label="Telegram"]');
            dialog?.querySelectorAll("details").forEach((details) => { (details as HTMLDetailsElement).open = true; });
            dialog?.scrollTo({ top: dialog.scrollHeight });
          });
          await pause(page, 300);
          const end = await readTelegramPanel(page, phone);
          await page.screenshot({ path: path.join(BOT_OUT, `${key}-end.png`) });
          if (!top || !end) failures.push(`${key}: the panel did not open`);
          for (const reading of [top, end]) for (const failure of reading?.failures ?? []) failures.push(`${key}: ${failure}`);
          if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
          results.push({ key, viewport, scheme, scene, top, end });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(BOT_EVIDENCE, "panel.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * The chat row's posting switch: one tap allows a chat with no alias under
 * the one its title suggests; an alias typed into a chat that suggests none
 * rides with the tap on the switch; and a rename of an allowed chat followed
 * by switching it off is one save. The field's blur between them used to
 * save first, disable the switch, and swallow the tap. Each case must end on
 * the switch's new state after exactly one POST, by touch on the phone and by
 * mouse on the desktop:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "telegram bot switch"
 */
browserTest("telegram bot switch: one tap allows a chat, and a typed alias rides with the tap", async () => {
  fs.mkdirSync(BOT_OUT, { recursive: true });
  fs.mkdirSync(BOT_EVIDENCE, { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const surfaces = [
    { name: "phone-390", viewport: { width: 390, height: 844 }, phone: true },
    { name: "desktop-1440", viewport: { width: 1_440, height: 900 }, phone: false },
  ];
  const steps = [
    { scene: "typed", title: "Реліз", fill: "release", expect: { chatId: "-1000000000505", alias: "release", postAllowed: true } },
    { scene: "chats", title: "Person A", fill: null, expect: { chatId: "700000303", alias: "person-a", postAllowed: true } },
    { scene: "chats", title: "Team Reports", fill: "team-weekly", expect: { chatId: "-1000000000101", alias: "team-weekly", postAllowed: false } },
  ] as const;
  try {
    for (const surface of surfaces) {
      for (const step of steps) {
        const key = `${surface.name}-${step.scene}-${step.expect.alias}`;
        const context = await browser.newContext({ viewport: surface.viewport, colorScheme: "light", deviceScaleFactor: 2, ...(surface.phone ? { hasTouch: true, isMobile: true } : {}) });
        try {
          const page = await context.newPage();
          await page.goto(`${base}/?bot=${step.scene}`);
          await openTelegramPanel(page, surface.phone);
          const field = page.locator(`input[aria-label="Alias agents use: ${step.title}"]`);
          const toggle = page.locator(`[role="switch"][aria-label="Agents may post: ${step.title}"]`);
          if (step.fill !== null) await field.fill(step.fill);
          if (surface.phone) await toggle.tap();
          else await toggle.click();
          const wanted = String(step.expect.postAllowed);
          await page.waitForFunction(({ title, value }) => document.querySelector(`[role="switch"][aria-label="Agents may post: ${title}"]`)?.getAttribute("aria-checked") === value, { title: step.title, value: wanted }, { timeout: 5_000 })
            .catch(() => failures.push(`${key}: the switch did not end ${wanted}`));
          await pause(page, 300);
          const posts = await page.evaluate(() => structuredClone((window as unknown as { evidence: { botPosts: Array<Record<string, unknown>> } }).evidence.botPosts));
          const checked = await toggle.getAttribute("aria-checked");
          const expected = { action: "chat", ...step.expect };
          if (posts.length !== 1 || JSON.stringify(posts[0]) !== JSON.stringify(expected)) {
            failures.push(`${key}: expected exactly one POST ${JSON.stringify(expected)}, saw ${JSON.stringify(posts)}`);
          }
          await page.screenshot({ path: path.join(BOT_OUT, `${key}-after-tap.png`) });
          results.push({ key, surface: surface.name, scene: step.scene, title: step.title, filled: step.fill, checked, posts });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(BOT_EVIDENCE, "switch.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * docs/design/needs-attention.md — why a phone card needs the operator, its
 * Dismiss, and an agent's request_attention that moves nothing, on the real
 * Viewer over the fixture's `?needs=1` scene at 390 × 844:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable LLV_NEEDS_PHASE=after \
 *     LLV_NEEDS_FRAMES=<dir> bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "needs attention"
 *
 * The same case renders the scene on a checkout without the change
 * (`LLV_NEEDS_PHASE=before`), which records frames and readings and gates
 * nothing, so the two phases are the before and after of one scene. Frames go
 * to `LLV_NEEDS_FRAMES` (default `.artifacts/needs-attention`, not committed);
 * the after readings to `evidence/needs-attention/phone.json`.
 */
const NEEDS_PHASE = process.env.LLV_NEEDS_PHASE === "before" ? "before" : "after";
const NEEDS_OUT = path.resolve(process.env.LLV_NEEDS_FRAMES || ".artifacts/needs-attention");
const NEEDS_EVIDENCE = path.resolve("evidence/needs-attention");
const NEEDS_READER = "/state/agent-log-viewer/shared/accounts/claude/spare/projects/atlas/running.jsonl";

/** What one column shows about what needs the operator, card by card. */
const needsReading = (page: Page, status: string) => page.evaluate((wanted) => {
  const column = document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!;
  const rect = (element: Element | null) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const cross = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return {
    tabNeeds: document.querySelector(`[data-phone-kanban-tab="${wanted}"] [data-phone-tab-needs]`)?.textContent ?? null,
    cards: [...column.querySelectorAll<HTMLElement>("[data-phone-card]")].map((card) => {
      const frame = card.closest("[data-phone-card-frame]");
      const dismiss = frame?.querySelector("[data-phone-card-dismiss]") ?? null;
      const undo = frame?.querySelector("[data-phone-card-undo]") ?? null;
      const inks = [...card.querySelectorAll("[data-phone-card-title], [data-phone-card-badge]")].map((node) => node.getBoundingClientRect());
      const control = (dismiss ?? undo)?.getBoundingClientRect() ?? null;
      return {
        key: card.getAttribute("data-phone-card"),
        title: card.querySelector("[data-phone-card-title]")?.textContent ?? "",
        needs: card.getAttribute("data-needs") === "1",
        edge: card.closest("[data-phone-card-frame]") ? frame?.className.includes("inset_3px") ?? false : card.getAttribute("data-edge"),
        badge: card.querySelector("[data-phone-card-badge]")?.textContent ?? null,
        state: card.querySelector("[data-phone-card-state]")?.textContent ?? null,
        cleared: card.querySelector("[data-phone-card-cleared]")?.textContent ?? null,
        dismiss: rect(dismiss),
        undo: rect(undo),
        /* The card's own button and its control are side by side, never on
           top of each other, and the control covers none of the card's text. */
        controlCrossesCard: control ? cross(control, card.getBoundingClientRect()) > 0.5 : false,
        controlOnText: control ? inks.some((ink) => cross(control, ink) > 0.5) : false,
      };
    }),
  };
}, status);

/** Where the operator is: the screen on top and how far its feed is scrolled. */
const whereAmI = (page: Page) => page.evaluate(() => {
  const screens = [...document.querySelectorAll<HTMLElement>("[data-mobile2-screen]")];
  const top = screens.at(-1) ?? null;
  const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]");
  return {
    screen: top?.getAttribute("data-mobile2-screen") ?? null,
    conversation: top?.getAttribute("data-mobile2-conversation") ?? null,
    feedScrollTop: feed ? Math.round(feed.scrollTop) : null,
    banner: document.querySelectorAll("[data-mobile2-banner]").length,
    badge: document.querySelector("[data-mobile2-open='attention']")?.getAttribute("aria-label") ?? null,
    dot: document.querySelectorAll("[data-mobile2-notice-dot]").length,
    hash: location.hash,
  };
});

browserTest("needs attention: why a phone card needs the operator, its Dismiss, and a request that moves nothing", async () => {
  fs.mkdirSync(NEEDS_OUT, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const readings: Record<string, unknown> = { phase: NEEDS_PHASE };
  const failures: string[] = [];
  const fail = (label: string) => failures.push(label);
  const after = NEEDS_PHASE === "after";
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(NEEDS_OUT, `${NEEDS_PHASE}-${name}.png`) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: "light" });
    await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
    try {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`${fixtureBase}/?kanban=1&needs=1&notice=1#p=atlas`);
      await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
      await pause(page, 900);

      /* Assigned: a card for each reason that still asks, then the rest. */
      await page.locator('[data-phone-kanban-tab="assigned"]').click();
      await pagerAtRest(page);
      await shot(page, "assigned");
      const assigned = await needsReading(page, "assigned");
      readings.assigned = assigned;
      const geometry = await readColumn(page);
      readings.assignedGeometry = { smallControls: geometry.smallControls, crossingControls: geometry.crossingControls, inkOverlaps: geometry.inkOverlaps, inkOnControls: geometry.inkOnControls, pinnedFirst: geometry.pinnedFirst };
      /* The card someone cleared, scrolled to where the operator reads it. */
      await page.evaluate(() => document.querySelector('[data-phone-card="task:t-cleared"]')?.scrollIntoView({ block: "center" }));
      await pause(page, 400);
      await shot(page, "assigned-cleared");

      /* Inbox: the question, then what no task owns, stalled and walled among it. */
      await page.locator('[data-phone-kanban-tab="inbox"]').click();
      await pagerAtRest(page);
      await shot(page, "inbox");
      const inbox = await needsReading(page, "inbox");
      readings.inbox = inbox;
      await page.evaluate(() => document.querySelector('[data-phone-kanban-column="inbox"] [data-phone-kanban-unlinked]')?.scrollIntoView({ block: "start" }));
      await pause(page, 400);
      await shot(page, "inbox-loose");

      if (after) {
        const byKey = new Map(assigned.cards.map((card) => [card.key, card] as const));
        const expectBadge = (key: string, words: RegExp) => {
          const card = byKey.get(key);
          if (!card?.needs) fail(`${key} is not pinned as needing the operator`);
          else if (!words.test(card.badge ?? "")) fail(`${key} names «${card.badge}», wanted ${words}`);
          if (card && (!card.dismiss || card.dismiss.width < 44 || card.dismiss.height < 44)) fail(`${key} has no 44 × 44 Dismiss: ${JSON.stringify(card.dismiss)}`);
          if (card?.controlCrossesCard || card?.controlOnText) fail(`${key}'s Dismiss sits over the card`);
        };
        expectBadge("task:t-data", /^needs a decision · /);
        expectBadge("task:t-copilot", /^review budget spent · /);
        expectBadge("task:t-prompt", /^permission prompt$/);
        expectBadge("task:t-owed", /^message not delivered$/);
        const cleared = byKey.get("task:t-cleared");
        if (!cleared || cleared.needs || !/^Cleared · orchestrator · /.test(cleared.cleared ?? "")) fail(`the cleared card reads ${JSON.stringify(cleared)}`);
        if (cleared && (!cleared.undo || cleared.undo.height < 44)) fail("the cleared card has no 44 px Undo");
        if (geometry.crossingControls.length) fail(`controls crossing: ${JSON.stringify(geometry.crossingControls)}`);
        if (geometry.inkOverlaps.length) fail(`text over text: ${JSON.stringify(geometry.inkOverlaps.slice(0, 6))}`);
        if (geometry.inkOnControls.length) fail(`text over a control: ${JSON.stringify(geometry.inkOnControls.slice(0, 6))}`);
        if (geometry.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(geometry.smallControls)}`);
        const loose = inbox.cards.filter((card) => card.key !== "task:t-systemd" && card.state);
        if (!loose.some((card) => /resets/.test(card.state ?? ""))) fail("the walled row does not say when it resets");
        if (!loose.some((card) => /^stalled/i.test(card.state ?? ""))) fail("a stalled row lost its word");
        if (inbox.cards.some((card) => card.state && card.needs)) fail("a stalled or walled row is pinned as needing the operator");

        /* One tap on Dismiss: the card clears on the tap and says who cleared it. */
        await page.locator('[data-phone-kanban-tab="assigned"]').click();
        await pagerAtRest(page);
        await page.evaluate(() => document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop = 0);
        await pause(page, 300);
        await page.locator('[data-phone-card-dismiss="task:t-prompt"]').click();
        await pause(page, 900);
        await shot(page, "dismissed");
        const dismissedReading = await needsReading(page, "assigned");
        readings.dismissed = dismissedReading;
        readings.dismissals = await page.evaluate(() => (window as unknown as { evidence: { dismissals: unknown[] } }).evidence.dismissals);
        const prompt = dismissedReading.cards.find((card) => card.key === "task:t-prompt");
        if (!prompt || prompt.needs || !/^Cleared · you · /.test(prompt.cleared ?? "")) fail(`the dismissed card reads ${JSON.stringify(prompt)}`);
      }

      /* The operator reads a conversation; the orchestrator asks for them. */
      await page.locator('[data-phone-kanban-tab="inbox"]').click();
      await pagerAtRest(page);
      await page.locator(`[data-phone-card-agent="${NEEDS_READER}"]`).first().scrollIntoViewIfNeeded();
      await page.locator(`[data-phone-card-agent="${NEEDS_READER}"]`).first().click();
      await page.waitForSelector('[data-mobile2-screen="chat"]', { timeout: 10_000 });
      await pause(page, 1_200);
      await page.evaluate(() => {
        const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]");
        if (feed) feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 360);
      });
      await pause(page, 500);
      const before = await whereAmI(page);
      await shot(page, "chat-before-notice");
      await page.evaluate(() => {
        (window as unknown as { evidence: { noticeOn: boolean } }).evidence.noticeOn = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await pause(page, 1_500);
      const arrived = await whereAmI(page);
      await shot(page, "chat-notice");
      readings.chat = { before, arrived };
      if (before.screen !== arrived.screen || before.conversation !== arrived.conversation || before.hash !== arrived.hash) fail(`the screen moved: ${JSON.stringify({ before, arrived })}`);
      if (before.feedScrollTop !== arrived.feedScrollTop) fail(`the feed moved from ${before.feedScrollTop} to ${arrived.feedScrollTop}`);
      if (arrived.banner > before.banner) fail("a banner was put above the conversation");
      if (after && arrived.dot !== 1) fail(`the badge's dot is ${arrived.dot}, wanted one`);

      /* The ⚠ sheet: the request as a row, above the queue. */
      const badge = page.locator("[data-mobile2-open='attention']");
      if (await badge.count()) {
        await badge.click();
        await pause(page, 700);
        await shot(page, "sheet-notice");
        readings.sheet = await page.evaluate(() => ({
          notices: [...document.querySelectorAll("[data-mobile2-notice-row]")].map((row) => row.textContent ?? ""),
          queue: [...document.querySelectorAll("[data-attention-row]")].map((row) => row.textContent ?? ""),
          dotAfterOpen: document.querySelectorAll("[data-mobile2-notice-dot]").length,
        }));
        const sheet = readings.sheet as { notices: string[]; dotAfterOpen: number };
        if (after && sheet.notices.length !== 1) fail(`the sheet lists ${sheet.notices.length} notices`);
        if (after && sheet.dotAfterOpen !== 0) fail("the dot stays lit after the sheet showed the notice");
      } else if (after) {
        fail("no ⚠ badge to open");
      }
      if (pageErrors.length) fail(`page errors: ${pageErrors.join(" | ")}`);
      await page.close();
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  readings.failures = failures;
  fs.writeFileSync(path.join(NEEDS_OUT, `readings-${NEEDS_PHASE}.json`), `${JSON.stringify(readings, null, 2)}\n`);
  if (after) {
    fs.mkdirSync(NEEDS_EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(NEEDS_EVIDENCE, "phone.json"), `${JSON.stringify(readings, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }
}, 300_000);

/*
 * #2105 — Back and screen history on the phone follow the path the operator
 * took. The kanban fixture (`?kanban=1`) at 390 × 844, dark, touch. Every
 * phone screen and every sheet over one is one history entry; the browser's
 * Back (which is what iOS's edge swipe sends) and the bar's ‹ each pop exactly
 * one, and the screen they land on is the one the operator came from, with
 * its scroll and its column. Walks:
 *
 *   report    board → the orchestrator → Back → a task → its agent → Back ends
 *             on the task (the operator's report: it ended on the orchestrator)
 *   path      board → task → pipeline → conversation → Back ×3, each screen in
 *             turn, the task's scroll and the board's column and offset kept
 *   sheets    the same path with a sheet opened at each step and closed by
 *             Back, which stays on the screen; a sheet closed by its × leaves
 *             no entry behind
 *   deeplink  a link that lands through the hash, an in-app link and a
 *             tapped notification's hand-off, each from the task screen:
 *             Back returns to the task
 *   predecessor  a ⋯ row that opens the round before this conversation
 *             takes the menu's entry; one Back returns under it, no menu
 *   reload    a reload on the task, the pipeline and the conversation keeps
 *             the screen, and Back still goes where it went before
 *   reload-sheets  a reload with a card, lane or stage sheet open drops the
 *             sheet and its entry, so one Back leaves the screen; the ⋯ menu,
 *             which needs no choice, comes back and Back closes it
 *   overview-reload  the same reloads over the phone's Overview, where each
 *             screen is drawn by its own project: the screen waits for its
 *             data, and the history does not grow
 *   link-project, link-overview  a link in a conversation to another
 *             project's task, then to its lane: one entry each, and one Back
 *             returns to the conversation
 *
 * Frames go to `LLV_PHONE_BACK_FRAMES` (default `.artifacts/phone-back`, not
 * committed), prefixed by `LLV_PHONE_BACK_PREFIX` so a run on the code before
 * the change can be kept beside a run after it; readings go to
 * `evidence/issue-2105/history.json`.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2105"
 */
const PHONE_BACK_OUT = path.resolve(process.env.LLV_PHONE_BACK_FRAMES || ".artifacts/phone-back");
const PHONE_BACK_PREFIX = process.env.LLV_PHONE_BACK_PREFIX || "after";
const PHONE_BACK_EVIDENCE = path.resolve("evidence/issue-2105");

interface PhonePlace { screen: string | null; id: string | null; sheet: string | null; column: string | null; hash: string; historyLength: number }
interface PhoneExpect { screen: string; id?: string; sheet?: string | null }

const readPhonePlace = (page: Page) => page.evaluate((): PhonePlace => {
  const shells = [...document.querySelectorAll<HTMLElement>("[data-mobile2-screen]")];
  const top = shells[shells.length - 1] ?? null;
  return {
    screen: top?.getAttribute("data-mobile2-screen") ?? null,
    id: top?.getAttribute("data-mobile2-conversation") ?? top?.getAttribute("data-mobile2-task") ?? top?.getAttribute("data-mobile2-pipeline") ?? null,
    sheet: document.querySelector("[data-mobile2-sheet]")?.getAttribute("data-mobile2-sheet") ?? null,
    column: document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") ?? null,
    hash: location.hash,
    historyLength: history.length,
  };
});

/** The id a conversation screen names itself by: the fixture's conversation id. */
const conversationOf = (transcript: string | null) => (transcript ? `conversation_${transcript.split("/").pop()!.replace(".jsonl", "")}` : undefined);

const placeMatches = (place: PhonePlace, want: PhoneExpect) =>
  place.screen === want.screen && (want.id === undefined || place.id === want.id) && (want.sheet === undefined || place.sheet === want.sheet);

browserTest("#2105: Back and the phone's screen history follow the path the operator took", async () => {
  fs.mkdirSync(PHONE_BACK_OUT, { recursive: true });
  fs.mkdirSync(PHONE_BACK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const failures: string[] = [];
  const results: unknown[] = [];
  const viewport = { width: 390, height: 844 };
  const walk = async (name: string, run: (ctx: {
    page: Page;
    step: (label: string, act: () => Promise<unknown>, want: PhoneExpect) => Promise<PhonePlace>;
    back: (label: string, want: PhoneExpect, how?: "browser" | "chevron") => Promise<PhonePlace>;
    fail: (text: string) => void;
  }) => Promise<void>) => {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const steps: unknown[] = [];
    let n = 0;
    const fail = (text: string) => failures.push(`${name}: ${text}`);
    /* One step: act, wait for the screen it should land on, then wait again
       and read once more, so a screen that something pushes a moment later —
       the orchestrator the report names — is caught rather than missed. */
    const step = async (label: string, act: () => Promise<unknown>, want: PhoneExpect) => {
      n += 1;
      await act();
      await page.waitForFunction(({ screen, id, sheet }) => {
        const shells = [...document.querySelectorAll<HTMLElement>("[data-mobile2-screen]")];
        const top = shells[shells.length - 1] ?? null;
        const openSheet = document.querySelector("[data-mobile2-sheet]")?.getAttribute("data-mobile2-sheet") ?? null;
        const topId = top?.getAttribute("data-mobile2-conversation") ?? top?.getAttribute("data-mobile2-task") ?? top?.getAttribute("data-mobile2-pipeline") ?? null;
        return top?.getAttribute("data-mobile2-screen") === screen && (id === undefined || topId === id) && (sheet === undefined || openSheet === sheet);
      }, want, { timeout: 8_000 }).catch(() => undefined);
      await pause(page, 1_200);
      const place = await readPhonePlace(page);
      await page.screenshot({ path: path.join(PHONE_BACK_OUT, `${PHONE_BACK_PREFIX}-${name}-${String(n).padStart(2, "0")}-${label}.png`) });
      steps.push({ n, label, want, place });
      if (!placeMatches(place, want)) fail(`step ${n} (${label}) wanted ${JSON.stringify(want)}, landed on ${JSON.stringify(place)}`);
      return place;
    };
    const back = (label: string, want: PhoneExpect, how: "browser" | "chevron" = "browser") =>
      step(label, () => (how === "chevron" ? page.locator("[data-mobile2-back]").first().click() : page.goBack({ waitUntil: "commit" }).catch(() => null)), want);
    try {
      await run({ page, step, back, fail });
      if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
    } catch (error) {
      fail(`threw ${(error as Error).message.split("\n")[0]}`);
    } finally {
      results.push({ walk: name, steps });
      await context.close();
    }
  };
  const board = `${fixtureBase}/?kanban=1#p=atlas`;
  const boardShown = (page: Page) => page.waitForSelector('[data-phone-card="task:t-many"]', { timeout: 20_000 });
  try {
    await walk("report", async ({ page, step, back }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      const seat = await step("orchestrator", () => page.locator("[data-mobile2-seat-open]").click(), { screen: "chat", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-long"]').click(), { screen: "task", id: "t-long", sheet: null });
      const agent = conversationOf(await page.locator("[data-phone-task-agent]").first().getAttribute("data-phone-task-agent"));
      await step("agent", () => page.locator("[data-phone-task-agent] button").first().click(), { screen: "chat", id: agent, sheet: null });
      const landed = await back("back-to-task", { screen: "task", id: "t-long", sheet: null });
      if (landed.screen === "chat" && landed.id === seat.id) failures.push("report: Back from the agent opened the orchestrator conversation");
      await back("back-to-board-again", { screen: "board", sheet: null });
    });

    await walk("path", async ({ page, step, back, fail }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      /* Bring the task's card into view in its column, so the column has an offset to keep. */
      const offset = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('[data-phone-card="task:t-many"]')!;
        card.scrollIntoView({ block: "center" });
        const column = card.closest<HTMLElement>("[data-phone-kanban-column]")!;
        return { column: column.getAttribute("data-phone-kanban-column"), top: column.scrollTop };
      });
      await pause(page, 400);
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await page.locator("[data-phone-task-ended]").click().catch(() => undefined);
      await pause(page, 300);
      /* Where the task screen was when it was left: the driver's click scrolls
         its target into view first, so the page keeps the last offset itself. */
      await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>("[data-phone-task-body]")!;
        /* A detached scroller reports a last scroll to 0 on its way out. */
        const record = () => { if (body.isConnected) (window as unknown as { taskScroll: number }).taskScroll = body.scrollTop; };
        body.addEventListener("scroll", record, { passive: true });
        body.scrollTop = Math.round(body.scrollHeight / 3);
        record();
      });
      await pause(page, 400);
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-review"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      const taskScroll = await page.evaluate(() => (window as unknown as { taskScroll: number }).taskScroll);
      if (taskScroll < 40) fail(`the task screen was left at scroll ${taskScroll}, too close to the top to show a restore`);
      await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-many-review"] [data-stage-open="build"]').first().click(), { screen: "chat", sheet: null });
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-many-review", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-many", sheet: null }, "chevron");
      const restored = await page.evaluate(() => document.querySelector<HTMLElement>("[data-phone-task-body]")?.scrollTop ?? -1);
      if (Math.abs(restored - taskScroll) > 2) fail(`the task screen came back at scroll ${restored}, left at ${taskScroll}`);
      await back("back-to-board", { screen: "board", sheet: null });
      const column = await page.evaluate((status) => {
        const board = document.querySelector<HTMLElement>("[data-phone-kanban]")!;
        return { active: board.getAttribute("data-phone-kanban-active"), top: board.querySelector<HTMLElement>(`[data-phone-kanban-column="${status}"]`)?.scrollTop ?? -1 };
      }, offset.column);
      if (column.active !== offset.column || Math.abs(column.top - offset.top) > 2) fail(`the board came back on ${JSON.stringify(column)}, left on ${JSON.stringify(offset)}`);
    });

    await walk("sheets", async ({ page, step, back, fail }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      const boardHash = await page.evaluate(() => location.hash);
      await step("board-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "board", sheet: "menu" });
      await back("board-menu-back", { screen: "board", sheet: null });
      await step("card-sheet", () => page.locator('[data-phone-card="task:t-many"]').click({ button: "right" }), { screen: "board", sheet: "card" });
      await back("card-sheet-back", { screen: "board", sheet: null });
      await step("tasks-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "board", sheet: "menu" });
      await step("tasks-sheet", () => page.locator('[data-mobile2-menu-row="tasks"]').click(), { screen: "board", sheet: "tasks" });
      await back("tasks-sheet-back", { screen: "board", sheet: null });
      /* Closed by its own ×, a sheet takes its entry with it: the next Back leaves the screen. */
      await step("menu-closed-by-x", async () => {
        await page.locator('[data-mobile2-open="menu"]').first().click();
        await page.waitForSelector('[data-mobile2-sheet="menu"]');
        await page.locator("[data-mobile2-close]").click();
      }, { screen: "board", sheet: null });
      if ((await page.evaluate(() => location.hash)) !== boardHash) fail("a sheet on the board moved the URL");
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await step("status-sheet", () => page.locator("[data-phone-task-status-pill]").first().click(), { screen: "task", id: "t-many", sheet: "status" });
      await back("status-sheet-back", { screen: "task", id: "t-many", sheet: null });
      await step("task-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "task", id: "t-many", sheet: "menu" });
      await back("task-menu-back", { screen: "task", id: "t-many", sheet: null });
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-review"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      await step("pipeline-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "pipeline", id: "lane-many-review", sheet: "menu" });
      await back("pipeline-menu-back", { screen: "pipeline", id: "lane-many-review", sheet: null });
      const chat = await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-many-review"] [data-stage-open="build"]').first().click(), { screen: "chat", sheet: null });
      await step("conversation-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "chat", id: chat.id ?? undefined, sheet: "menu" });
      await back("conversation-menu-back", { screen: "chat", id: chat.id ?? undefined, sheet: null });
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-many-review", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-many", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
    });

    await walk("deeplink", async ({ page, step, back }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-long"]').click(), { screen: "task", id: "t-long", sheet: null });
      const id = conversationOf(await page.locator("[data-phone-task-agent]").first().getAttribute("data-phone-task-agent"))!;
      /* A notification or a link the Viewer does not intercept lands through the hash. */
      await step("hash-link", () => page.evaluate((conversation) => { location.hash = "#c=" + encodeURIComponent(conversation); }, id), { screen: "chat", id, sheet: null });
      await back("hash-link-back", { screen: "task", id: "t-long", sheet: null });
      /* A link in a message: the Viewer opens a target it knows in place. */
      await step("message-link", () => page.evaluate((conversation) => {
        const anchor = document.createElement("a");
        anchor.href = "#c=" + encodeURIComponent(conversation);
        anchor.textContent = "Open conversation";
        anchor.setAttribute("data-evidence-link", "");
        document.querySelector("[data-phone-task-body]")!.prepend(anchor);
        anchor.click();
      }, id), { screen: "chat", id, sheet: null });
      await back("message-link-back", { screen: "task", id: "t-long", sheet: null });
      /* A tapped notification: the service worker hands its link to the tab
         (the message `public/question-push-sw.js` sends), and the tab opens it
         as one entry and answers, so the worker does not navigate it too. */
      let taken = false;
      await step("notification", async () => {
        taken = await page.evaluate((conversation) => new Promise<boolean>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve(true);
          setTimeout(() => resolve(false), 2_000);
          navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
            data: { type: "delegatus:open-url", url: "/#c=" + encodeURIComponent(conversation) + "#question" },
            ports: [channel.port2],
          }));
        }), id);
      }, { screen: "chat", id, sheet: null });
      if (!taken) failures.push("deeplink: the tab did not answer the notification's hand-off");
      await back("notification-back", { screen: "task", id: "t-long", sheet: null });
      /* A link whose conversation never opens leaves the task on screen over
         an entry the store did not write; ‹ still lands on the board, and the
         history agrees: Forward comes back to the task. */
      await step("dead-link", () => page.evaluate(() => { location.hash = "#c=conversation_never_opened"; }), { screen: "task", id: "t-long", sheet: null });
      await back("dead-link-chevron", { screen: "board", sheet: null }, "chevron");
      await step("forward-to-task", () => page.goForward({ waitUntil: "commit" }).catch(() => null), { screen: "task", id: "t-long", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
    });

    /* A ⋯ row that opens another conversation (the round before this one)
       takes the menu's entry: one Back returns to the conversation the menu
       was opened over, with no menu. */
    await walk("predecessor", async ({ page, step, back, fail }) => {
      await step("board", async () => {
        await page.goto(`${fixtureBase}/?kanban=1&rounds=1#p=atlas`);
        await boardShown(page);
        await page.locator('[data-phone-kanban-tab="inbox"]').click();
        await page.waitForSelector('[data-phone-card="task:t-systemd"]', { timeout: 10_000 });
      }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-systemd"]').click(), { screen: "task", id: "t-systemd", sheet: null });
      const agent = conversationOf(await page.locator("[data-phone-task-agent]").first().getAttribute("data-phone-task-agent"));
      await step("conversation", () => page.locator("[data-phone-task-agent] button").first().click(), { screen: "chat", id: agent, sheet: null });
      await step("menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "chat", id: agent, sheet: "menu" });
      const length = await page.evaluate(() => history.length);
      const round = await page.locator('[data-mobile2-menu-row="predecessor"]').getAttribute("data-continues-conversation");
      await step("round-before", () => page.locator('[data-mobile2-menu-row="predecessor"]').click(), { screen: "chat", id: round ?? undefined, sheet: null });
      const after = await page.evaluate(() => history.length);
      if (after !== length) fail(`opening the round from the menu left the history at ${after} entries, ${length} with the menu open`);
      await back("round-back", { screen: "chat", id: agent, sheet: null });
      await back("back-to-task", { screen: "task", id: "t-systemd", sheet: null });
    });

    await walk("reload", async ({ page, step, back }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await step("task-reload", () => page.reload(), { screen: "task", id: "t-many", sheet: null });
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-review"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      await step("pipeline-reload", () => page.reload(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      const chat = await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-many-review"] [data-stage-open="build"]').first().click(), { screen: "chat", sheet: null });
      await step("conversation-reload", () => page.reload(), { screen: "chat", id: chat.id ?? undefined, sheet: null });
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-many-review", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-many", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
    });

    /* A reload with a sheet open. A sheet that shows what its screen chose to
       open it on (a card's actions, a lane's menu, a stage's settings) cannot
       come back without that choice: it closes and takes its entry, so the
       next Back leaves the screen. A sheet that needs no choice (⋯) comes
       back, and Back closes it. */
    const sheetEntry = (page: Page) => page.evaluate(() => (history.state as { mobile2?: { sheet?: string | null } } | null)?.mobile2?.sheet ?? null);
    await walk("reload-sheets", async ({ page, step, back, fail }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      await step("card-sheet", () => page.locator('[data-phone-card="task:t-many"]').click({ button: "right" }), { screen: "board", sheet: "card" });
      await step("card-sheet-reload", () => page.reload(), { screen: "board", sheet: null });
      if ((await sheetEntry(page)) !== null) fail(`after a reload the card sheet's entry is still the tab's: ${await sheetEntry(page)}`);
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await step("lane-sheet", () => page.locator('[data-phone-task-lane="lane-many-pill"] [data-pipeline-menu]').click(), { screen: "task", id: "t-many", sheet: "lane" });
      await step("lane-sheet-reload", () => page.reload(), { screen: "task", id: "t-many", sheet: null });
      if ((await sheetEntry(page)) !== null) fail(`after a reload the lane sheet's entry is still the tab's: ${await sheetEntry(page)}`);
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-pill"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-pill", sheet: null });
      await step("stage-sheet", () => page.locator("[data-stage-configure]").first().click(), { screen: "pipeline", id: "lane-many-pill", sheet: "stage" });
      await step("stage-sheet-reload", () => page.reload(), { screen: "pipeline", id: "lane-many-pill", sheet: null });
      if ((await sheetEntry(page)) !== null) fail(`after a reload the stage sheet's entry is still the tab's: ${await sheetEntry(page)}`);
      await back("pipeline-back", { screen: "task", id: "t-many", sheet: null });
      await step("menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "task", id: "t-many", sheet: "menu" });
      await step("menu-reload", () => page.reload(), { screen: "task", id: "t-many", sheet: "menu" });
      await back("menu-back", { screen: "task", id: "t-many", sheet: null });
      await back("task-back", { screen: "board", sheet: null });
    });

    /* Over the Overview a screen is drawn by its own project's dashboard, and
       a reload brings the stack back before any answer names that project:
       the screen waits for its data rather than going home, and nothing is
       pushed again. */
    const overview = `${fixtureBase}/?overview=1`;
    const overviewShown = async (page: Page) => {
      await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
      await page.locator('[data-phone-kanban-tab="assigned"]').click();
      await page.waitForSelector('[data-phone-card="task:t-favicon"]', { timeout: 10_000 });
    };
    const entries = (page: Page) => page.evaluate(() => history.length);
    await walk("overview-reload", async ({ page, step, back, fail }) => {
      await step("overview", async () => { await page.goto(overview); await overviewShown(page); }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-favicon"]').click(), { screen: "task", id: "t-favicon", sheet: null });
      let length = await entries(page);
      await step("task-reload", () => page.reload(), { screen: "task", id: "t-favicon", sheet: null });
      if ((await entries(page)) !== length) fail(`a reload on the task grew the history from ${length} to ${await entries(page)}`);
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-favicon"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-favicon", sheet: null });
      length = await entries(page);
      await step("pipeline-reload", () => page.reload(), { screen: "pipeline", id: "lane-favicon", sheet: null });
      if ((await entries(page)) !== length) fail(`a reload on the pipeline grew the history from ${length} to ${await entries(page)}`);
      const chat = await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-favicon"] [data-stage-open="implement"]').first().click(), { screen: "chat", sheet: null });
      length = await entries(page);
      await step("conversation-reload", () => page.reload(), { screen: "chat", id: chat.id ?? undefined, sheet: null });
      if ((await entries(page)) !== length) fail(`a reload on the conversation grew the history from ${length} to ${await entries(page)}`);
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-favicon", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-favicon", sheet: null });
      await back("back-to-overview", { screen: "board", sheet: null });
    });

    /* A link in a message to another project's task or lane (the MCP call
       card's chip) writes one entry, over the conversation it was read in, and
       one Back returns there — on a project's board and over the Overview. */
    const delegatus = `repo-${"a1b2".repeat(4)}`;
    const link = (page: Page, kind: "task" | "pipeline", id: string) =>
      page.evaluate(({ kind, id }) => { window.dispatchEvent(new CustomEvent("llv:mcp-navigate", { detail: { kind, id } })); }, { kind, id });
    for (const [name, url] of [["link-project", `${fixtureBase}/?overview=1#p=${delegatus}`], ["link-overview", overview]] as const) {
      await walk(name, async ({ page, step, back, fail }) => {
        await step("board", async () => { await page.goto(url); await overviewShown(page); }, { screen: "board", sheet: null });
        await step("task", () => page.locator('[data-phone-card="task:t-favicon"]').click(), { screen: "task", id: "t-favicon", sheet: null });
        const chat = await step("conversation", () => page.locator('[data-phone-task-lane="lane-favicon"] button[data-stage="implement"]').first().click(), { screen: "chat", sheet: null });
        let length = await entries(page);
        await step("task-link", () => link(page, "task", "t-many"), { screen: "task", id: "t-many", sheet: null });
        if ((await entries(page)) !== length + 1) fail(`a task link wrote ${(await entries(page)) - length} entries`);
        await back("task-link-back", { screen: "chat", id: chat.id ?? undefined, sheet: null });
        length = await entries(page);
        await step("pipeline-link", () => link(page, "pipeline", "lane-many-review"), { screen: "pipeline", id: "lane-many-review", sheet: null });
        if ((await entries(page)) !== length) fail(`a pipeline link after Back grew the history from ${length} to ${await entries(page)}`);
        await back("pipeline-link-back", { screen: "chat", id: chat.id ?? undefined, sheet: null });
        await back("back-to-task", { screen: "task", id: "t-favicon", sheet: null });
      });
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PHONE_BACK_EVIDENCE, `history-${PHONE_BACK_PREFIX}.json`), `${JSON.stringify({ viewport, results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);
