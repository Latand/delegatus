import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";
import { kanbanLayoutMode } from "./KanbanBoard";

/*
 * Rendered evidence for the kanban desktop board (#1695 K1+K2): the real
 * Viewer over `issue1695Evidence.fixture.tsx`, against the production
 * stylesheet, in Chromium, light and dark:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1695Kanban.browser.test.tsx
 *
 * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
 * prototype, each frame is also rendered by the prototype at the SAME BOARD
 * WIDTH (the Viewer's project rail takes part of the viewport) and the column
 * geometry is compared.
 *
 * What only a browser settles, and is gated here:
 *   - the layout mode follows the board's width, and its column widths are the
 *     prototype's (264 px shelves wide, 220 px narrow, a 280/480 px scroller,
 *     one tabbed column below 768 px); 640–767 px is the desktop board;
 *   - every task is on the board or counted off it, per column;
 *   - a status move lands in the new column on the click, a refused one comes
 *     back with an error receipt, a keyboard move works, find narrows;
 *   - the board never pushes the page sideways, in any mode;
 *   - `/` inside the board finds a task and leaves the global search closed;
 *     outside it the global search still opens;
 *   - `U` undoes while its receipt is on screen, and not after it closed;
 *   - a card's links open other views and conversations without writing a
 *     view preference;
 *   - presence names only the cards the operator can actually see;
 *   - the phone never mounts the kanban board.
 *
 * Geometry goes to `evidence/issue-1695/geometry.json`; frames to
 * `.artifacts/issue-1695/`, which is not committed.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1695");
const EVIDENCE = path.resolve("evidence/issue-1695");
const PROTOTYPE = process.env.KANBAN_PROTOTYPE_URL?.trim().replace(/\/$/, "") || null;
/* Viewports chosen so the BOARD (the viewport minus the Viewer's project rail)
   lands in each mode: wide, narrow, the scroller, and tabbed at 640–767 px. */
const VIEWPORTS = [
  { width: 1680, height: 950 },
  { width: 1600, height: 900 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 960, height: 720 },
  { width: 700, height: 720 },
  { width: 640, height: 720 },
] as const;
const SCHEMES = ["light", "dark"] as const;
const EXPECTED_COUNTS = { inbox: 3, assigned: 7, blocked: 2, done: 5 } as const;

interface ColumnGeometry { status: string; x: number; width: number; visible: boolean; count: string | null }
interface BoardGeometry {
  boardWidth: number;
  mode: string | null;
  columns: ColumnGeometry[];
  tablist: boolean;
  overflowX: number;
  /** How far the board's right edge reaches past the window. */
  beyondWindow: number;
  /** Sideways scroll of the whole page, and the widest element causing it
      that is not part of the board. Recorded, not gated: at a 640 px window
      the Viewer's own header row overflows on every face (#1698). */
  pageOverflow: number;
  pageOverflowOutsideBoard: string | null;
  card: { paddingLeft: string; radius: string; titleSize: string; titleWeight: string; pillHeight: number; tileWidth: number | null } | null;
  hiddenCount: string | null;
  cards: number;
  pipelineSections: number;
}

const measure = (page: Page, root: string) => page.evaluate((rootSelector): BoardGeometry => {
  const board = document.querySelector<HTMLElement>(rootSelector)!;
  const boardRect = board.getBoundingClientRect();
  const grid = board.querySelector<HTMLElement>(".board");
  const mode = board.dataset.mode ?? (grid?.classList.contains("narrow") ? "narrow" : grid?.classList.contains("scroll") ? "scroll" : grid?.classList.contains("tabs") ? "tabs" : "wide");
  const columns = [...board.querySelectorAll<HTMLElement>(".column[data-status]")].map((column) => {
    const rect = column.getBoundingClientRect();
    return { status: column.dataset.status!, x: Math.round(rect.x - boardRect.x), width: Math.round(rect.width), visible: rect.width > 0 && getComputedStyle(column).display !== "none", count: column.querySelector(".col-head .n")?.textContent ?? null };
  });
  const card = board.querySelector<HTMLElement>('.column[data-status="assigned"] .card');
  const cardStyle = card ? getComputedStyle(card) : null;
  const title = card?.querySelector<HTMLElement>(".title");
  const pill = card?.querySelector<HTMLElement>(".pill") ?? board.querySelector<HTMLElement>(".card .pill");
  const tile = board.querySelector<HTMLElement>(".tile");
  return {
    boardWidth: Math.round(boardRect.width),
    mode,
    columns,
    tablist: Boolean(board.querySelector('[role="tablist"]')),
    overflowX: Math.max(0, board.scrollWidth - board.clientWidth),
    beyondWindow: Math.max(0, Math.round(boardRect.right - window.innerWidth)),
    pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    pageOverflowOutsideBoard: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => !board.contains(element) && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > window.innerWidth + 1)
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
      .map((element) => `${element.tagName.toLowerCase()}[${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}] right=${Math.round(element.getBoundingClientRect().right)}`)[0] ?? null,
    card: cardStyle ? {
      paddingLeft: cardStyle.paddingLeft,
      radius: cardStyle.borderTopLeftRadius,
      titleSize: title ? getComputedStyle(title).fontSize : "",
      titleWeight: title ? getComputedStyle(title).fontWeight : "",
      pillHeight: pill ? Math.round(pill.getBoundingClientRect().height) : 0,
      tileWidth: tile ? Math.round(tile.getBoundingClientRect().width) : null,
    } : null,
    hiddenCount: board.querySelector("[data-hidden-pill] .count")?.textContent ?? null,
    cards: board.querySelectorAll(".card[data-id]").length,
    pipelineSections: board.querySelectorAll(".stage-section").length,
  };
}, root);

function gateGeometry(geometry: BoardGeometry, failures: string[], label: string): void {
  const expectedMode = kanbanLayoutMode(geometry.boardWidth);
  if (geometry.mode !== expectedMode) failures.push(`${label}: mode ${geometry.mode} at board width ${geometry.boardWidth}, expected ${expectedMode}`);
  const shelves = geometry.columns.filter((column) => column.status !== "assigned" && column.visible);
  const assigned = geometry.columns.find((column) => column.status === "assigned")!;
  if (expectedMode === "wide" && shelves.some((column) => Math.abs(column.width - 264) > 1)) failures.push(`${label}: wide shelves ${shelves.map((c) => c.width)} != 264`);
  if (expectedMode === "narrow" && shelves.some((column) => Math.abs(column.width - 220) > 1)) failures.push(`${label}: narrow shelves ${shelves.map((c) => c.width)} != 220`);
  if (expectedMode === "scroll") {
    if (shelves.some((column) => Math.abs(column.width - 280) > 1)) failures.push(`${label}: scroller shelves ${shelves.map((c) => c.width)} != 280`);
    if (Math.abs(assigned.width - 480) > 1) failures.push(`${label}: scroller Assigned ${assigned.width} != 480`);
  }
  if (expectedMode === "tabs") {
    if (!geometry.tablist) failures.push(`${label}: tabbed board without a tab list`);
    const visible = geometry.columns.filter((column) => column.visible);
    if (visible.length !== 1) failures.push(`${label}: tabbed board shows ${visible.length} columns`);
  }
  /* Every mode: the board holds its content (the scroller scrolls inside
     itself) and never reaches past the window. */
  if (geometry.overflowX > 1) failures.push(`${label}: board overflows sideways by ${geometry.overflowX}px`);
  if (geometry.beyondWindow > 1) failures.push(`${label}: board reaches ${geometry.beyondWindow}px past the window`);
}

browserTest("#1695 kanban board: the prototype's columns and cards over the real Viewer, light and dark", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await serveEvidenceFixture(OUT);
  const base = server.base;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const failures: string[] = [];
  const frames: unknown[] = [];
  const flows: Record<string, unknown> = {};
  try {
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        const label = `${viewport.width}x${viewport.height}-${scheme}`;
        const { context, page, pageErrors } = await openFixture(browser, base, viewport, scheme);
        try {
          await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
          await page.waitForTimeout(400);
          const production = await measure(page, "[data-kanban-board]");
          gateGeometry(production, failures, `production ${label}`);
          for (const [status, count] of Object.entries(EXPECTED_COUNTS)) {
            const column = production.columns.find((entry) => entry.status === status);
            if (column?.count !== String(count)) failures.push(`production ${label}: ${status} count ${column?.count} != ${count}`);
          }
          if (production.hiddenCount !== "1") failures.push(`production ${label}: hidden count ${production.hiddenCount} != 1`);
          await page.screenshot({ path: path.join(OUT, `production-${label}.png`) });
          let prototype: BoardGeometry | null = null;
          if (PROTOTYPE) {
            const proto = await openFixture(browser, `${PROTOTYPE}/?seat=collapsed`, { width: production.boardWidth, height: viewport.height }, scheme);
            try {
              const ready = await proto.page.waitForSelector("#app[data-ready] .board, #app[data-ready] [data-phone-note]", { timeout: 20_000 }).then(() => true, () => false);
              if (ready && await proto.page.$("#app .board")) {
                prototype = await measure(proto.page, "#app");
                await proto.page.screenshot({ path: path.join(OUT, `prototype-${label}.png`) });
              }
            } finally {
              await proto.context.close();
            }
          }
          const deltas = prototype ? production.columns.map((column) => {
            const other = prototype!.columns.find((entry) => entry.status === column.status);
            return { status: column.status, production: column.width, prototype: other?.width ?? null, delta: other ? column.width - other.width : null };
          }) : null;
          if (prototype && production.mode === prototype.mode && (production.mode === "wide" || production.mode === "narrow")) {
            for (const delta of deltas!) if (delta.delta !== null && Math.abs(delta.delta) > 2) failures.push(`${label}: ${delta.status} is ${delta.production}px, prototype ${delta.prototype}px`);
          }
          frames.push({ key: label, viewport, production, prototype, deltas, pageErrors });
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }
    }

    /* Flows, once, on the widest light frame. */
    const { context, page, pageErrors } = await openFixture(browser, base, VIEWPORTS[0], "light");
    try {
      await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
      const columnOf = (id: string) => page.evaluate((cardId) => document.querySelector(`.card[data-id="task:${cardId}"]`)?.closest<HTMLElement>(".column")?.dataset.status ?? null, id);
      const pending = (id: string) => page.evaluate((cardId) => document.querySelector(`.card[data-id="task:${cardId}"]`)?.getAttribute("data-pending") ?? null, id);
      const receipts = () => page.evaluate(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent));

      await page.click('.card[data-id="task:t-disk"] .pill');
      await page.click('.menu [role="menuitemradio"]:has-text("Done")');
      const landedAt = { column: await columnOf("t-disk"), pending: await pending("t-disk"), receipts: await receipts() };
      await page.screenshot({ path: path.join(OUT, "flow-move-in-flight.png") });
      await page.waitForFunction(() => document.querySelector('.card[data-id="task:t-disk"]')?.getAttribute("data-pending") === "0", undefined, { timeout: 5_000 });
      /* The guard's revision is an opaque id; the evidence records that it was sent. */
      const settled = {
        column: await columnOf("t-disk"),
        patches: await page.evaluate(() => (window as unknown as { evidence: { taskPatches: Array<{ id: string; body: Record<string, unknown> }> } }).evidence.taskPatches
          .map((patch) => ({ id: patch.id, status: patch.body.status, expectedProject: patch.body.expectedProject, guarded: typeof patch.body.expectedRevision === "string" }))),
      };
      if (!settled.patches.every((patch) => patch.guarded)) failures.push("flow: a status write went out without its revision guard");
      if (landedAt.column !== "done") failures.push(`flow: moved card in ${landedAt.column} on the click`);
      if (landedAt.pending !== "1") failures.push("flow: no saving state while the write is out");
      if (settled.column !== "done") failures.push(`flow: moved card in ${settled.column} after the answer`);
      flows.move = { landedAt, settled };

      await page.evaluate(() => { (window as unknown as { evidence: { refuseNextTaskPatch: boolean } }).evidence.refuseNextTaskPatch = true; });
      await page.click('.card[data-id="task:t-verify-a"] .pill');
      await page.click('.menu [role="menuitemradio"]:has-text("Blocked")');
      const refusedOnClick = await columnOf("t-verify-a");
      await page.waitForFunction(() => document.querySelector("[data-kanban-receipt].error"), undefined, { timeout: 5_000 });
      const refused = { onClick: refusedOnClick, afterAnswer: await columnOf("t-verify-a"), receipts: await receipts() };
      await page.screenshot({ path: path.join(OUT, "flow-move-refused.png") });
      if (refused.onClick !== "blocked" || refused.afterAnswer !== "assigned") failures.push(`flow: refused move went ${refused.onClick} → ${refused.afterAnswer}`);
      flows.refused = refused;

      await page.focus('.card[data-id="task:t-onboarding"]');
      await page.keyboard.press("]");
      const keyboard = await columnOf("t-onboarding");
      await page.waitForTimeout(100);
      const focused = await page.evaluate(() => document.activeElement?.closest<HTMLElement>(".card")?.dataset.id ?? null);
      if (keyboard !== "assigned") failures.push(`flow: ] moved the card to ${keyboard}`);
      if (focused !== "task:t-onboarding") failures.push(`flow: focus after the keyboard move is on ${focused}`);
      flows.keyboard = { column: keyboard, focused };

      await page.fill("[data-kanban-search]", "links");
      const found = await page.evaluate(() => document.querySelector('.column[data-status="assigned"] .col-head .n')?.textContent);
      await page.screenshot({ path: path.join(OUT, "flow-find.png") });
      if (found !== "1 of 7") failures.push(`flow: find reads ${found}`);
      flows.find = found;

      /* `/`: inside the board it focuses the kanban find and the global
         search stays closed; from the page body the global search opens. */
      await page.fill("[data-kanban-search]", "");
      await page.focus('.card[data-id="task:t-links"]');
      await page.keyboard.press("/");
      await page.waitForTimeout(150);
      const slashInside = await page.evaluate(() => ({
        kanbanFind: document.activeElement?.hasAttribute("data-kanban-search") ?? false,
        globalSearch: Boolean(document.querySelector('[aria-modal="true"]')),
      }));
      if (!slashInside.kanbanFind || slashInside.globalSearch) failures.push(`slash: inside the board ${JSON.stringify(slashInside)}`);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("/");
      await page.waitForTimeout(300);
      const slashOutside = await page.evaluate(() => Boolean(document.querySelector('[aria-modal="true"]')));
      if (!slashOutside) failures.push("slash: the global search no longer opens from the page body");
      await page.keyboard.press("Escape");
      flows.slash = { inside: slashInside, outsideOpensGlobalSearch: slashOutside };

      /* Presence names what is on screen: a tile's conversation is reported
         exactly when its card intersects its column's scroll box. */
      const presenceCheck = async () => {
        await page.waitForTimeout(1_500);
        return page.evaluate(() => {
          const posts = (window as unknown as { evidence: { presence: Array<{ mode: string; visiblePaths: string[] }> } }).evidence.presence;
          const last = posts[posts.length - 1] ?? null;
          const tiles = [...document.querySelectorAll<HTMLElement>("[data-kanban-board] .tile[data-member]")].map((tile) => {
            const card = tile.closest<HTMLElement>(".card")!;
            const body = card.closest<HTMLElement>(".col-body")!.getBoundingClientRect();
            const rect = card.getBoundingClientRect();
            const onScreen = rect.bottom > body.top && rect.top < body.bottom && getComputedStyle(card.closest(".column")!).display !== "none";
            return { path: tile.dataset.member!, onScreen, reported: Boolean(last?.visiblePaths.includes(tile.dataset.member!)) };
          });
          return { posts: posts.length, mode: last?.mode ?? null, reported: last?.visiblePaths.length ?? 0, tiles };
        });
      };
      const presenceTop = await presenceCheck();
      await page.evaluate(() => { const body = document.querySelector<HTMLElement>('.column[data-status="assigned"] .col-body')!; body.scrollTop = body.scrollHeight; });
      const presenceScrolled = await presenceCheck();
      for (const [label, check] of [["top", presenceTop], ["scrolled", presenceScrolled]] as const) {
        const wrong = check.tiles.filter((tile) => tile.onScreen !== tile.reported);
        if (!check.posts || wrong.length) failures.push(`presence ${label}: ${JSON.stringify(wrong)} (${check.posts} posts)`);
      }
      if (!presenceTop.tiles.some((tile) => !tile.onScreen) || !presenceTop.tiles.some((tile) => tile.onScreen)) failures.push("presence: the fixture no longer has tiles both on and off screen");
      flows.presence = { top: presenceTop, scrolled: presenceScrolled };
      if (pageErrors.length) failures.push(`flows: page errors ${pageErrors.join(" | ")}`);
    } finally {
      await context.close();
    }

    /* Undo lives as long as its receipt: U right after a move undoes it; U
       after the receipt closed by its timer sends nothing. */
    const undo = await openFixture(browser, base, VIEWPORTS[0], "light");
    try {
      await undo.page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
      const columnOf = (id: string) => undo.page.evaluate((cardId) => document.querySelector(`.card[data-id="task:${cardId}"]`)?.closest<HTMLElement>(".column")?.dataset.status ?? null, id);
      const patches = () => undo.page.evaluate(() => (window as unknown as { evidence: { taskPatches: unknown[] } }).evidence.taskPatches.length);
      await undo.page.click('.card[data-id="task:t-merge-a"] .pill');
      await undo.page.click('.menu [role="menuitemradio"]:has-text("Done")');
      await undo.page.waitForFunction(() => document.querySelector('.card[data-id="task:t-merge-a"]')?.getAttribute("data-pending") === "0", undefined, { timeout: 5_000 });
      await undo.page.keyboard.press("u");
      await undo.page.waitForFunction(() => document.querySelector('.card[data-id="task:t-merge-a"]')?.getAttribute("data-pending") === "0", undefined, { timeout: 5_000 });
      await undo.page.waitForTimeout(200);
      const undone = { column: await columnOf("t-merge-a"), patches: await patches() };
      if (undone.column !== "assigned" || undone.patches !== 2) failures.push(`undo: U while the receipt shows left ${JSON.stringify(undone)}`);

      await undo.page.click('.card[data-id="task:t-disk"] .pill');
      await undo.page.click('.menu [role="menuitemradio"]:has-text("Blocked")');
      await undo.page.waitForFunction(() => document.querySelector('.card[data-id="task:t-disk"]')?.getAttribute("data-pending") === "0", undefined, { timeout: 5_000 });
      await undo.page.waitForFunction(() => !document.querySelector("[data-kanban-receipt] .act"), undefined, { timeout: 12_000 });
      const beforeLateUndo = await patches();
      await undo.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await undo.page.keyboard.press("u");
      await undo.page.waitForTimeout(800);
      const expired = { column: await columnOf("t-disk"), patchesBefore: beforeLateUndo, patchesAfter: await patches() };
      if (expired.column !== "blocked" || expired.patchesAfter !== expired.patchesBefore) failures.push(`undo: U after the receipt closed ${JSON.stringify(expired)}`);
      flows.undo = { undone, expired };
      if (undo.pageErrors.length) failures.push(`undo: page errors ${undo.pageErrors.join(" | ")}`);
    } finally {
      await undo.context.close();
    }

    /* A card's links look elsewhere without writing a view preference: the
       elided-conversation link shows the list for this session only, and a
       stage chip whose conversation left the scheme window opens it by id. */
    const links = await openFixture(browser, base, VIEWPORTS[1], "light");
    try {
      await links.page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
      const presentationWrites = () => links.page.evaluate(() => (window as unknown as { evidence: { boardMutations: Array<{ kind: string }> } }).evidence.boardMutations.filter((mutation) => mutation.kind === "set-presentation").length);
      await links.page.click('.card[data-id="task:t-auth"] .ref.quiet');
      await links.page.waitForFunction(() => !document.querySelector("[data-kanban-board]"), undefined, { timeout: 10_000 });
      const afterList = { writes: await presentationWrites(), listTab: await links.page.evaluate(() => document.querySelector('[data-view-tab="list"]')?.getAttribute("aria-pressed") ?? null) };
      await links.page.click('[data-view-tab="kanban"]');
      await links.page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 10_000 });
      const writesBeforeChip = await presentationWrites();
      await links.page.click('.card[data-id="task:t-compact"] [data-stage="build"]');
      await links.page.waitForTimeout(400);
      const afterChip = { writes: await presentationWrites(), hash: await links.page.evaluate(() => location.hash) };
      if (afterList.writes !== 0 || afterList.listTab !== "true") failures.push(`links: the list link wrote ${afterList.writes} view preferences (list tab ${afterList.listTab})`);
      if (afterChip.writes !== writesBeforeChip) failures.push(`links: the stage chip wrote ${afterChip.writes - writesBeforeChip} view preferences`);
      if (afterChip.hash !== "#c=conversation_compact-build") failures.push(`links: the stage chip navigated to ${afterChip.hash}`);
      flows.links = { afterList, writesBeforeChip, afterChip };
      if (links.pageErrors.length) failures.push(`links: page errors ${links.pageErrors.join(" | ")}`);
    } finally {
      await links.context.close();
    }

    /* The tabs: from the scheme face, Kanban writes the face and mounts the
       board; Board takes it back. */
    const faces = await openFixture(browser, `${base}?face=scheme`, VIEWPORTS[1], "light");
    try {
      await faces.page.waitForSelector('[data-view-tab="kanban"]', { state: "attached", timeout: 20_000 });
      const kanbanBefore = Boolean(await faces.page.$("[data-kanban-board]"));
      await faces.page.click('[data-view-tab="kanban"]');
      await faces.page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 10_000 });
      const written = await faces.page.evaluate(() => (window as unknown as { evidence: { boardMutations: unknown[] } }).evidence.boardMutations);
      await faces.page.click('[data-kanban-board] [data-view-tab="scheme"]');
      await faces.page.waitForFunction(() => !document.querySelector("[data-kanban-board]"), undefined, { timeout: 10_000 });
      const back = await faces.page.evaluate(() => (window as unknown as { evidence: { boardMutations: unknown[] } }).evidence.boardMutations);
      if (kanbanBefore) failures.push("tabs: the kanban board was mounted on the scheme face");
      if (!written.some((mutation) => JSON.stringify(mutation) === JSON.stringify({ kind: "set-presentation", desktopBoard: "kanban", viewMode: "scheme" }))) failures.push(`tabs: Kanban wrote ${JSON.stringify(written)}`);
      if (!back.some((mutation) => JSON.stringify(mutation) === JSON.stringify({ kind: "set-presentation", desktopBoard: "scheme", viewMode: "scheme" }))) failures.push(`tabs: Board wrote ${JSON.stringify(back)}`);
      flows.tabs = { kanbanBefore, written, back };
      if (faces.pageErrors.length) failures.push(`tabs: page errors ${faces.pageErrors.join(" | ")}`);
    } finally {
      await faces.context.close();
    }

    /* The phone keeps its own board: the kanban never mounts there. */
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    try {
      const page = await phone.newPage();
      await page.goto(base);
      await page.waitForTimeout(2_500);
      const kanbanOnPhone = await page.$("[data-kanban-board]");
      await page.screenshot({ path: path.join(OUT, "phone-390x844.png") });
      if (kanbanOnPhone) failures.push("phone: the kanban board mounted at 390 px");
      flows.phone = { kanbanMounted: Boolean(kanbanOnPhone) };
    } finally {
      await phone.close();
    }
  } finally {
    await browser.close();
    server.stop();
  }
  const modes = new Set(frames.map((frame) => (frame as { production: BoardGeometry }).production.mode));
  for (const mode of ["wide", "narrow", "scroll", "tabs"]) if (!modes.has(mode)) failures.push(`no frame rendered the ${mode} mode`);
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), frames, flows, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);
