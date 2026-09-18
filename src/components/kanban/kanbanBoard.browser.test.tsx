import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type LaunchOptions, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";
import { kanbanLayoutMode } from "./KanbanBoard";

/*
 * The one rendered-evidence driver for the kanban board. Every case here runs
 * the real Viewer over `issue1695Evidence.fixture.tsx`, against the production
 * stylesheet, in Chromium, and is gated by its environment variable, so a
 * plain `bun test` loads this file and skips every case:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
 *
 * Add a kanban issue's rendered evidence as a `describe` block here rather
 * than as a new file (#1761). With KANBAN_PROTOTYPE_URL pointing at a served
 * copy of the approved prototype, the cases that compare against it do so.
 * Each block keeps the comment, the gates and the evidence path it had as its
 * own file; only the scaffolding they all repeated is shared below.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const LAUNCH: LaunchOptions = { headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) };
const PROTOTYPE = process.env.KANBAN_PROTOTYPE_URL?.trim().replace(/\/$/, "") || null;
const VIEWPORT = { width: 1440, height: 900 } as const;

type Scheme = "light" | "dark";

const card = (id: string) => `[data-kanban-board] .card[data-id="task:${id}"]`;

describe("#1695 K1+K2 kanban board", () => {
  /*
   * Rendered evidence for the kanban desktop board (#1695 K1+K2): the real
   * Viewer over `issue1695Evidence.fixture.tsx`, against the production
   * stylesheet, in Chromium, light and dark:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
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

  const OUT = path.resolve(".artifacts/issue-1695");
  const EVIDENCE = path.resolve("evidence/issue-1695");
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
    const browser = await chromium.launch(LAUNCH);
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

      /* The views (#1695): a board stored on the scheme face opens on the Board, the desktop offers only Board and
         Conversations, Conversations lists the project's conversations and writes the list view, and Board comes
         back with the kanban face. Nothing stored is rewritten just by opening. */
      const faces = await openFixture(browser, `${base}?face=scheme`, VIEWPORTS[1], "light");
      try {
        await faces.page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
        const tabs = await faces.page.$$eval("[data-view-tab]", (nodes) => nodes.map((node) => node.getAttribute("data-view-tab")));
        const schemeShown = Boolean(await faces.page.$("[data-scheme-band], [data-scheme-ui]"));
        const openedMutations = await faces.page.evaluate(() => (window as unknown as { evidence: { boardMutations: Array<{ kind: string }> } }).evidence.boardMutations);
        /* Opening reads the stored view: no presentation is written. Membership convergence (`reconcile-roots`) runs
           on every open, whatever the view, and is recorded as it is. */
        const openedWrites = openedMutations.filter((mutation) => mutation.kind === "set-presentation").length;
        await faces.page.click('[data-kanban-board] [data-view-tab="list"]');
        await faces.page.waitForSelector("[data-desktop-conversations-row]", { state: "attached", timeout: 10_000 });
        const listed = await faces.page.$$eval("[data-desktop-conversations-row]", (nodes) => nodes.length);
        const conversationsTail = await faces.page.$eval("[data-desktop-conversations-tail]", (node) => node.textContent ?? "");
        const kanbanOnList = Boolean(await faces.page.$("[data-kanban-board]"));
        const toList = await faces.page.evaluate(() => (window as unknown as { evidence: { boardMutations: unknown[] } }).evidence.boardMutations);
        await faces.page.screenshot({ path: path.join(OUT, "production-conversations-light.png") });
        await faces.page.click('[data-view-tab="kanban"]');
        await faces.page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 10_000 });
        const back = await faces.page.evaluate(() => (window as unknown as { evidence: { boardMutations: unknown[] } }).evidence.boardMutations);
        if (JSON.stringify(tabs) !== JSON.stringify(["kanban", "list"])) failures.push(`tabs: the desktop offered ${JSON.stringify(tabs)}`);
        if (schemeShown) failures.push("tabs: the scheme was drawn on the desktop");
        if (openedWrites !== 0) failures.push(`tabs: opening a board stored on the scheme face wrote a presentation: ${JSON.stringify(openedMutations)}`);
        if (kanbanOnList || listed === 0) failures.push(`tabs: Conversations listed ${listed} rows with the kanban ${kanbanOnList ? "still" : "not"} mounted`);
        if (!toList.some((mutation) => JSON.stringify(mutation) === JSON.stringify({ kind: "set-presentation", viewMode: "list" }))) failures.push(`tabs: Conversations wrote ${JSON.stringify(toList)}`);
        if (!back.some((mutation) => JSON.stringify(mutation) === JSON.stringify({ kind: "set-presentation", desktopBoard: "kanban", viewMode: "scheme" }))) failures.push(`tabs: Board wrote ${JSON.stringify(back)}`);
        flows.tabs = { tabs, schemeShown, openedWrites, openedMutationKinds: openedMutations.map((mutation) => mutation.kind), listed, conversationsTail, toList, back };
        await faces.page.screenshot({ path: path.join(OUT, "production-default-board-light.png") });
        if (faces.pageErrors.length) failures.push(`tabs: page errors ${faces.pageErrors.join(" | ")}`);
      } finally {
        await faces.context.close();
      }

      /* + Task and + Agent (#1695 K9a): the new task is an inline card at the top of Inbox and lands there, the
         bar's + Agent opens a draft on a card of its own, and a card's + Agent opens one on that card. Each draft
         pane stays inside its card at reading width, and nothing pushes the page sideways. */
      const create = await openFixture(browser, base, VIEWPORTS[1], "light");
      try {
        const { page } = create;
        await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
        await page.click("[data-new-task]");
        await page.waitForSelector("[data-kanban-new-task] textarea", { timeout: 10_000 });
        const composerFirst = await page.$eval("[data-kanban-new-task]", (node) => ({
          column: node.closest<HTMLElement>(".column")?.dataset.status ?? null,
          first: node.parentElement?.firstElementChild === node,
          focused: node.contains(document.activeElement),
          width: Math.round(node.getBoundingClientRect().width),
        }));
        await page.screenshot({ path: path.join(OUT, "k9a-new-task-light.png") });
        await page.fill("[data-kanban-new-task] textarea", "Write the migration guide");
        await page.$eval("[data-kanban-new-task]", (node) => (node as HTMLFormElement).requestSubmit());
        await page.waitForSelector('.column[data-status="inbox"] .card[data-id="task:created-1"]', { state: "attached", timeout: 10_000 });
        /* The request id is recorded as present, never as its value: evidence carries no id-shaped literal. */
        const creates = await page.evaluate(() => (window as unknown as { evidence: { taskCreates: Array<Record<string, unknown>> } }).evidence.taskCreates
          .map(({ clientRequestId, ...rest }): Record<string, unknown> => ({ ...rest, clientRequestId: typeof clientRequestId === "string" && clientRequestId.length > 0 ? "present" : clientRequestId })));

        await page.click("[data-new-agent]");
        await page.waitForSelector('.card[data-id^="draft:"] [data-kanban-draft] section', { timeout: 10_000 });
        const barDraft = await page.$eval('.card[data-id^="draft:"]', (card) => {
          const pane = card.querySelector<HTMLElement>("[data-kanban-draft]")!.getBoundingClientRect();
          const box = card.getBoundingClientRect();
          return { column: card.closest<HTMLElement>(".column")?.dataset.status ?? null, paneWidth: Math.round(pane.width), inside: pane.left >= box.left - 1 && pane.right <= box.right + 1 };
        });
        await page.screenshot({ path: path.join(OUT, "k9a-agent-draft-light.png") });

        const cardId = "task:t-links";
        await page.click(`[data-add-agent="${cardId}"]`);
        await page.waitForSelector(`.card[data-id="${cardId}"] [data-kanban-draft] section`, { timeout: 10_000 });
        const cardDraft = await page.$eval(`.card[data-id="${cardId}"]`, (card) => {
          const pane = card.querySelector<HTMLElement>("[data-kanban-draft]")!.getBoundingClientRect();
          const box = card.getBoundingClientRect();
          const prompt = card.querySelector<HTMLTextAreaElement>('[data-kanban-draft] textarea[aria-label="First prompt text"]');
          return { paneWidth: Math.round(pane.width), inside: pane.left >= box.left - 1 && pane.right <= box.right + 1, prompt: prompt?.value ?? null };
        });
        const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        await page.$eval(`.card[data-id="${cardId}"]`, (node) => node.scrollIntoView({ block: "center" }));
        await page.screenshot({ path: path.join(OUT, "k9a-card-draft-light.png") });

        if (composerFirst.column !== "inbox" || !composerFirst.first || !composerFirst.focused) failures.push(`k9a: the new task card ${JSON.stringify(composerFirst)}`);
        if (creates.length !== 1 || creates[0]!.placement !== "unplaced" || creates[0]!.clientRequestId !== "present") failures.push(`k9a: + Task wrote ${JSON.stringify(creates)}`);
        if (barDraft.column !== "inbox" || !barDraft.inside || barDraft.paneWidth > 780) failures.push(`k9a: the bar's draft ${JSON.stringify(barDraft)}`);
        if (!cardDraft.inside || cardDraft.paneWidth > 780 || cardDraft.prompt !== "Repair old links in the release notes") failures.push(`k9a: the card's draft ${JSON.stringify(cardDraft)}`);
        if (pageOverflow > 0) failures.push(`k9a: the page scrolls sideways by ${pageOverflow} px`);
        if (create.pageErrors.length) failures.push(`k9a: page errors ${create.pageErrors.join(" | ")}`);
        flows.k9a = { composerFirst, creates, barDraft, cardDraft, pageOverflow };
      } finally {
        await create.context.close();
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
});

describe("#1695 K3 conversations inside cards", () => {
  /*
   * Rendered evidence for #1695 K3: conversations inside kanban cards and the
   * orchestrator seated above the board, in the real Viewer over
   * `issue1695Evidence.fixture.tsx`, in Chromium, light and dark:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
   * prototype, the same frames (board with the seat, several readers, one
   * conversation) are rendered by the prototype at the same board width beside
   * the production ones.
   *
   * Gated here, because only a laid-out page settles it:
   *   - the seat is centred, at most 1040 px wide, at the agreed default height
   *     clamp(160px, 30vh, 360px) with at least two transcript rows and a
   *     composer of at least 60 px, collapsed in a window under 800 px tall, the
   *     side dock stays closed, and every conversation on the page, the
   *     orchestrator included, has at most one composer;
   *   - readers sit inside their cards, at most 780 px wide, keep their title and
   *     full-window control in the header, and a shelf column holding one widens
   *     to reading width; Stop host is in the reader's actions menu;
   *   - a draft, its caret and its focus survive the card moving to another
   *     column while the operator types, and a status move of their own;
   *   - a reader's feed keeps its scroll position when another card passes its
   *     card in the same column;
   *   - the full-window reader is the same reader, and goes back into its card;
   *   - readers and their folded state survive a reload;
   *   - the seat's grip resizes it down to 160 px and the height survives a reload; Collapse
   *     keeps its conversation mounted, and the header's Orchestrator control
   *     expands it without opening the dock;
   *   - an attention `open` of an EMPTY transcript arrives as `reader`, presence
   *     names it, and Return closes it; a reader scrolled out of its column does
   *     not arrive, and neither does one whose transcript failed to read;
   *   - Link and Unlink go through the assignment route with their own receipts,
   *     including the refusal for a conversation's only task.
   *
   * Measurements go to `evidence/issue-1695/k3.json`; frames to
   * `.artifacts/issue-1695-k3/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1695-k3");
  const EVIDENCE = path.resolve("evidence/issue-1695");
  const FRAMES = [
    { width: 1680, height: 950 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 700, height: 720 },
  ] as const;
  const SCHEMES = ["light", "dark"] as const;
  const PENDING_WORKER = "/repo/pending-worker.jsonl";

  type Evidence = {
    presence: Array<{ mode: string; visiblePaths: string[]; focusedPath: string | null }>;
    assignments: Array<{ method: string; id: string; body: Record<string, unknown> }>;
    setTaskStatus(id: string, status: string): void;
    touchTask(id: string): void;
    failLogsFor: string | null;
    focus: {
      bus: { board(): { arrival?(destination: unknown): string | null; returnFromHandoff?(requestId?: string): void } | null };
      runFocusTransaction(request: unknown, bus: unknown, options: unknown): Promise<{ resolution: string; moved: boolean }>;
    };
  };

  const seatGeometry = (page: Page) => page.evaluate(() => {
    const seat = document.querySelector<HTMLElement>("[data-kanban-seat]");
    const pageBox = document.querySelector<HTMLElement>(".kb-page")!;
    const rect = seat?.getBoundingClientRect();
    const frame = pageBox.getBoundingClientRect();
    return {
      present: Boolean(seat),
      collapsed: seat?.dataset.collapsed === "1",
      width: rect ? Math.round(rect.width) : 0,
      height: rect ? Math.round(rect.height) : 0,
      centreOffset: rect ? Math.round((rect.left + rect.width / 2) - (frame.left + pageBox.clientWidth / 2)) : null,
      dock: Boolean(document.querySelector("[data-orchestrator-dock]")),
      conversations: document.querySelectorAll("[data-orchestrator-conversation]").length,
      composerHeight: Math.round(seat?.querySelector("[data-orchestrator-conversation] form")?.getBoundingClientRect().height ?? 0),
      /* Transcript rows the seat actually shows: at least 12 px of each inside its scroller. */
      transcriptRows: (() => {
        const scroller = seat?.querySelector<HTMLElement>("[data-orchestrator-conversation] [data-log-feed-scroller]");
        if (!scroller || seat?.dataset.collapsed === "1") return 0;
        const box = scroller.getBoundingClientRect();
        return [...scroller.querySelectorAll<HTMLElement>("[data-feed-key]")].filter((row) => {
          const rect = row.getBoundingClientRect();
          return Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top) >= 12;
        }).length;
      })(),
      /* Composer fields per conversation identity, wherever they render. */
      composers: (() => {
        const counts: Record<string, number> = {};
        document.querySelectorAll<HTMLTextAreaElement>("form textarea").forEach((field) => {
          const owner = field.closest<HTMLElement>("[data-orchestrator-conversation], [data-kanban-reader]");
          const key = owner?.dataset.orchestratorConversation ?? owner?.dataset.kanbanReader ?? "outside";
          counts[key] = (counts[key] ?? 0) + 1;
        });
        return counts;
      })(),
      pageOverflowX: Math.max(0, pageBox.scrollWidth - pageBox.clientWidth),
      boardFrameHeight: Math.round(document.querySelector<HTMLElement>(".board-frame")!.getBoundingClientRect().height),
      innerHeight: window.innerHeight,
      boardWidth: Math.round(document.querySelector<HTMLElement>("[data-kanban-board]")!.getBoundingClientRect().width),
    };
  });

  const readerGeometry = (page: Page) => page.evaluate(() => {
    const readers = [...document.querySelectorAll<HTMLElement>("[data-kanban-reader]")].map((reader) => ({
      key: reader.dataset.kanbanReader!,
      folded: reader.dataset.folded === "1",
      width: Math.round(reader.getBoundingClientRect().width),
      headText: reader.querySelector(".conv-head .ch-row")?.textContent ?? "",
      titleClipped: (() => { const title = reader.querySelector<HTMLElement>(".ch-title"); return title ? title.scrollWidth > title.clientWidth + 1 : null; })(),
      fullToggle: (() => { const toggle = reader.querySelector<HTMLElement>("[data-reader-full-toggle]"); return reader.dataset.folded === "1" ? null : Boolean(toggle && toggle.getBoundingClientRect().width > 0); })(),
      card: reader.closest<HTMLElement>(".card")?.dataset.id ?? null,
      column: reader.closest<HTMLElement>(".column")?.dataset.status ?? null,
      feed: reader.querySelector("[data-feed-state]")?.getAttribute("data-feed-state") ?? null,
    }));
    const columns = Object.fromEntries([...document.querySelectorAll<HTMLElement>(".column[data-status]")].map((column) => [column.dataset.status!, Math.round(column.getBoundingClientRect().width)]));
    const board = document.querySelector<HTMLElement>(".board");
    return { readers, columns, reading: board?.classList.contains("reading") ?? false, mode: document.querySelector<HTMLElement>("[data-kanban-board]")!.dataset.mode ?? null };
  });

  async function boardReady(page: Page) {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
    await page.waitForSelector("[data-kanban-seat] [data-orchestrator-panel]", { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(600);
  }

  const card = (id: string) => `.card[data-id="task:${id}"]`;
  const readerFor = (conversationId: string) => `[data-kanban-reader="${conversationId}"]`;

  async function waitSettled(page: Page, conversationId: string) {
    await page.waitForFunction((selector) => {
      const state = document.querySelector(`${selector} [data-feed-state]`)?.getAttribute("data-feed-state");
      return state === "items" || state === "empty";
    }, readerFor(conversationId), { timeout: 10_000 });
  }

  async function openReadersLikeThePrototype(page: Page) {
    await page.click(`${card("t-export")} .tile >> nth=0`);
    await page.click(`${card("t-auth")} .tile >> nth=0`);
    await page.click(`${card("t-links")} [data-stage="implement"]`);
    await waitSettled(page, "conversation_export-impl");
    await page.click(`${readerFor("conversation_links-impl")} [data-reader-fold]`);
    await page.evaluate((selector) => {
      const target = document.querySelector<HTMLElement>(selector)!;
      const pageBox = document.querySelector<HTMLElement>(".kb-page")!;
      const frame = document.querySelector<HTMLElement>(".board-frame")!;
      /* Like the prototype's frame: the seat's lower edge still in view, the
         card at the top of its column. */
      pageBox.scrollTop += frame.getBoundingClientRect().top - pageBox.getBoundingClientRect().top - 220;
      const body = target.closest<HTMLElement>(".col-body")!;
      body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 4;
    }, card("t-export"));
    await page.waitForTimeout(400);
  }

  browserTest("#1695 K3: conversations inside cards and the orchestrator above the board, against the prototype", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = server.base;
    const browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: unknown[] = [];
    const flows: Record<string, unknown> = {};
    const prototypeShot = async (query: string, viewport: { width: number; height: number }, scheme: "light" | "dark", file: string) => {
      if (!PROTOTYPE) return false;
      const proto = await openFixture(browser, `${PROTOTYPE}/${query ? `?${query}` : ""}`, viewport, scheme);
      try {
        const ready = await proto.page.waitForSelector("#app[data-ready] .board", { timeout: 20_000 }).then(() => true, () => false);
        if (ready) {
          await proto.page.waitForTimeout(500);
          await proto.page.screenshot({ path: path.join(OUT, file) });
        }
        return ready;
      } finally {
        await proto.context.close();
      }
    };
    try {
      for (const scheme of SCHEMES) {
        for (const viewport of FRAMES) {
          const label = `${viewport.width}x${viewport.height}-${scheme}`;
          const { context, page, pageErrors } = await openFixture(browser, base, viewport, scheme);
          try {
            await boardReady(page);
            const seat = await seatGeometry(page);
            const shortWindow = viewport.height < 800;
            const expected = Math.min(360, Math.max(160, Math.round(viewport.height * 0.3)));
            if (!seat.present) failures.push(`${label}: no seat`);
            if (seat.collapsed !== shortWindow) failures.push(`${label}: seat collapsed=${seat.collapsed} in a ${viewport.height} px window`);
            if (!seat.collapsed && Math.abs(seat.height - expected) > 2) failures.push(`${label}: seat ${seat.height}px tall, default ${expected}px`);
            if (!seat.collapsed && seat.composerHeight < 60) failures.push(`${label}: the seat's composer is squeezed to ${seat.composerHeight}px`);
            if (!seat.collapsed && seat.transcriptRows < 2) failures.push(`${label}: the seat shows ${seat.transcriptRows} transcript rows`);
            for (const [identity, count] of Object.entries(seat.composers)) if (count > 1 || identity === "outside") failures.push(`${label}: ${count} composer field(s) for ${identity}`);
            if (!seat.collapsed && seat.composers.conversation_orchestrator !== 1) failures.push(`${label}: the orchestrator has ${seat.composers.conversation_orchestrator ?? 0} composers`);
            if (seat.width > 1040) failures.push(`${label}: seat ${seat.width}px wide`);
            if (seat.centreOffset === null || Math.abs(seat.centreOffset) > 2) failures.push(`${label}: seat off centre by ${seat.centreOffset}px`);
            if (seat.dock) failures.push(`${label}: the side dock is open beside the seat`);
            if (seat.conversations !== 1) failures.push(`${label}: ${seat.conversations} orchestrator conversations mounted`);
            if (seat.pageOverflowX > 1) failures.push(`${label}: the page scrolls sideways by ${seat.pageOverflowX}px`);
            if (seat.boardFrameHeight < 440) failures.push(`${label}: the board below the seat is ${seat.boardFrameHeight}px tall`);
            await page.screenshot({ path: path.join(OUT, `board-${label}.png`) });
            const boardPrototype = await prototypeShot("", { width: seat.boardWidth, height: viewport.height }, scheme, `prototype-board-${label}.png`);

            let readers: Awaited<ReturnType<typeof readerGeometry>> | null = null;
            if (viewport.width >= 1024) {
              await openReadersLikeThePrototype(page);
              readers = await readerGeometry(page);
              if (readers.readers.length !== 3) failures.push(`${label}: ${readers.readers.length} readers open, expected 3`);
              for (const reader of readers.readers) {
                if (!reader.card) failures.push(`${label}: reader ${reader.key} is not inside a card`);
                if (reader.width > 780) failures.push(`${label}: reader ${reader.key} is ${reader.width}px wide`);
                if (/PID|Stop host/.test(reader.headText)) failures.push(`${label}: reader ${reader.key} header still carries host controls`);
                if (reader.fullToggle === false) failures.push(`${label}: reader ${reader.key} has no full-window control in its header`);
              }
              if (readers.readers.find((reader) => reader.key === "conversation_export-impl")?.feed !== "items") failures.push(`${label}: the export reader has no feed rows`);
              if (readers.readers.filter((reader) => reader.folded).length !== 1) failures.push(`${label}: expected one folded reader`);
              const mode = kanbanLayoutMode(seat.boardWidth);
              const blocked = readers.columns.blocked ?? 0;
              if ((mode === "wide" || mode === "narrow") && (blocked < 420 || blocked > 460 || !readers.reading)) failures.push(`${label}: Blocked holding a reader is ${blocked}px (reading=${readers.reading})`);
              if (mode === "scroll" && Math.abs(blocked - 460) > 1) failures.push(`${label}: scroller Blocked holding a reader is ${blocked}px`);
              await page.screenshot({ path: path.join(OUT, `readers-${label}.png`) });
              await prototypeShot("readers=c-export-1,c-links-1:c,c-auth-1&scrollto=t-export", { width: seat.boardWidth, height: viewport.height }, scheme, `prototype-readers-${label}.png`);
              const conversation = page.locator(readerFor("conversation_export-impl"));
              await conversation.screenshot({ path: path.join(OUT, `conversation-${label}.png`) });
              if (PROTOTYPE) {
                const proto = await openFixture(browser, `${PROTOTYPE}/?readers=c-export-1&scrollto=t-export`, { width: seat.boardWidth, height: viewport.height }, scheme);
                try {
                  const protoReader = proto.page.locator('section.reader.conv[data-member="c-export-1"]');
                  if (await protoReader.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
                    await proto.page.waitForTimeout(400);
                    await protoReader.screenshot({ path: path.join(OUT, `prototype-conversation-${label}.png`) });
                  } else {
                    failures.push(`${label}: the prototype rendered no conversation reader`);
                  }
                } finally {
                  await proto.context.close();
                }
              }
            }
            frames.push({ key: label, viewport, seat, readers, boardPrototype, pageErrors });
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }

      /* ── Flows, on the widest light frame ─────────────────────────────── */
      const { context, page, pageErrors } = await openFixture(browser, base, FRAMES[0], "light");
      try {
        await boardReady(page);

        /* A draft survives a move made elsewhere while the operator types. */
        await page.click(`${card("t-export")} .tile >> nth=0`);
        await waitSettled(page, "conversation_export-impl");
        const field = `${readerFor("conversation_export-impl")} textarea`;
        await page.click(field);
        await page.keyboard.type("Three presets and one advanced toggle");
        await page.evaluate((selector) => {
          const textarea = document.querySelector<HTMLTextAreaElement>(selector)!;
          textarea.dataset.k3probe = "draft";
          textarea.setSelectionRange(6, 13);
        }, field);
        await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.setTaskStatus("t-export", "blocked"));
        await page.waitForFunction((selector) => document.querySelector(selector)?.closest<HTMLElement>(".column")?.dataset.status === "blocked", card("t-export"), { timeout: 15_000 });
        await page.waitForTimeout(300);
        const elsewhere = await page.evaluate(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-k3probe="draft"]');
          return {
            present: Boolean(textarea),
            column: textarea?.closest<HTMLElement>(".column")?.dataset.status ?? null,
            value: textarea?.value ?? null,
            focused: document.activeElement === textarea,
            selection: textarea ? [textarea.selectionStart, textarea.selectionEnd] : null,
          };
        });
        await page.screenshot({ path: path.join(OUT, "flow-draft-after-move.png") });
        if (!elsewhere.present || elsewhere.column !== "blocked") failures.push(`draft: the reader did not travel with its card ${JSON.stringify(elsewhere)}`);
        if (elsewhere.value !== "Three presets and one advanced toggle") failures.push(`draft: value after the move is ${JSON.stringify(elsewhere.value)}`);
        if (!elsewhere.focused) failures.push("draft: focus left the composer when the card moved");
        if (JSON.stringify(elsewhere.selection) !== "[6,13]") failures.push(`draft: caret after the move is ${JSON.stringify(elsewhere.selection)}`);

        /* The operator's own status move keeps it too. */
        await page.click(`${card("t-export")} .pill`);
        await page.click('.menu [role="menuitemradio"]:has-text("Assigned")');
        await page.waitForFunction((selector) => document.querySelector(selector)?.closest<HTMLElement>(".column")?.dataset.status === "assigned", card("t-export"), { timeout: 5_000 });
        const ownMove = await page.evaluate(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-k3probe="draft"]');
          return { column: textarea?.closest<HTMLElement>(".column")?.dataset.status ?? null, value: textarea?.value ?? null };
        });
        if (ownMove.column !== "assigned" || ownMove.value !== "Three presets and one advanced toggle") failures.push(`draft: after a status move ${JSON.stringify(ownMove)}`);
        flows.draft = { elsewhere, ownMove };

        /* The full-window reader is the same reader. */
        await page.click(`${readerFor("conversation_export-impl")} [data-reader-full-toggle]`);
        await page.waitForSelector('.reader-full textarea[data-k3probe="draft"]', { timeout: 5_000 });
        await page.screenshot({ path: path.join(OUT, "flow-full-pane.png") });
        await page.click(`.reader-full ${readerFor("conversation_export-impl")} .ch-title`);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".reader-full"), undefined, { timeout: 5_000 });
        const backInCard = await page.evaluate(() => document.querySelector('textarea[data-k3probe="draft"]')?.closest<HTMLElement>(".card")?.dataset.id ?? null);
        if (backInCard !== "task:t-export") failures.push(`full pane: the reader went back to ${backInCard}`);
        flows.fullPane = { backInCard };

        /* Readers and their folded state survive a reload. */
        await page.click(`${card("t-auth")} .tile >> nth=0`);
        await page.click(`${readerFor("conversation_auth-impl")} [data-reader-fold]`);
        await page.reload();
        await boardReady(page);
        const reloaded = await readerGeometry(page);
        const remembered = {
          exportOpen: reloaded.readers.some((reader) => reader.key === "conversation_export-impl" && !reader.folded),
          authFolded: reloaded.readers.some((reader) => reader.key === "conversation_auth-impl" && reader.folded),
        };
        if (!remembered.exportOpen || !remembered.authFolded) failures.push(`reload: readers came back as ${JSON.stringify(reloaded.readers)}`);
        flows.reload = remembered;

        /* The seat: grip, reload, keyboard, Collapse, the header control. The
           fixture's attention toast sits over the seat's right edge while it
           shows (the island overlap tracked in #1643), so it is dismissed first,
           as the operator would. */
        const dismissToast = async () => {
          const dismiss = await page.$("[data-attention-toast-dismiss]");
          if (dismiss) await dismiss.click();
          return Boolean(dismiss);
        };
        await page.evaluate(() => { document.querySelector<HTMLElement>(".kb-page")!.scrollTop = 0; });
        await dismissToast();
        const before = await seatGeometry(page);
        const grip = await page.locator("[data-seat-grip]").boundingBox();
        if (!grip) throw new Error("seat grip not rendered");
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 50, { steps: 4 });
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 100, { steps: 4 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        const dragged = await seatGeometry(page);
        await page.reload();
        await boardReady(page);
        const afterReload = await seatGeometry(page);
        await dismissToast();
        await page.focus("[data-seat-grip]");
        await page.keyboard.press("ArrowUp");
        await page.waitForTimeout(200);
        const keyed = await seatGeometry(page);
        await page.click("[data-seat-collapse]");
        await page.waitForTimeout(200);
        const collapsed = await seatGeometry(page);
        await page.screenshot({ path: path.join(OUT, "flow-seat-collapsed.png") });
        await page.click("[data-orchestrator-toggle]");
        await page.waitForTimeout(200);
        const expanded = await seatGeometry(page);
        const shrinkGrip = await page.locator("[data-seat-grip]").boundingBox();
        if (!shrinkGrip) throw new Error("seat grip not rendered after expanding");
        await page.mouse.move(shrinkGrip.x + shrinkGrip.width / 2, shrinkGrip.y + shrinkGrip.height / 2);
        await page.mouse.down();
        await page.mouse.move(shrinkGrip.x + shrinkGrip.width / 2, shrinkGrip.y - 300, { steps: 6 });
        await page.mouse.move(shrinkGrip.x + shrinkGrip.width / 2, shrinkGrip.y - 600, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        const floor = await seatGeometry(page);
        await page.screenshot({ path: path.join(OUT, "flow-seat-floor.png") });
        const seatFlow = { before: before.height, dragged: dragged.height, afterReload: afterReload.height, keyed: keyed.height, collapsed: { height: collapsed.height, flag: collapsed.collapsed, conversations: collapsed.conversations }, expanded: { flag: expanded.collapsed, dock: expanded.dock }, floor: { height: floor.height, composer: floor.composerHeight } };
        if (Math.abs(floor.height - 160) > 1) failures.push(`seat: dragged all the way up it is ${floor.height}px, floor 160`);
        if (Math.abs(dragged.height - before.height - 100) > 3) failures.push(`seat: dragging the grip 100px changed the height by ${dragged.height - before.height}px`);
        if (Math.abs(afterReload.height - dragged.height) > 1) failures.push(`seat: height after reload ${afterReload.height}, dragged to ${dragged.height}`);
        if (Math.abs(afterReload.height - keyed.height - 40) > 1) failures.push(`seat: ArrowUp changed the height by ${afterReload.height - keyed.height}px`);
        if (!collapsed.collapsed || collapsed.height > 52 || collapsed.conversations !== 1) failures.push(`seat: collapsed ${JSON.stringify(seatFlow.collapsed)}`);
        if (expanded.collapsed || expanded.dock) failures.push(`seat: the header control left ${JSON.stringify(seatFlow.expanded)}`);
        flows.seat = seatFlow;

        /* Attention: an open of an EMPTY transcript arrives as its reader. */
        const arrival = await page.evaluate(async (target) => {
          const { bus, runFocusTransaction } = (window as unknown as { evidence: Evidence }).evidence.focus;
          const result = await runFocusTransaction({
            id: "attention_empty",
            target: { kind: "conversation", path: target },
            frameAtCreation: { project: "atlas", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
            intent: "open",
            zoom: "inspect",
          }, bus, { timeoutMs: 8_000 });
          const reader = document.querySelector<HTMLElement>('[data-kanban-reader="conversation_pending-worker"]');
          return { resolution: result.resolution, feed: reader?.querySelector("[data-feed-state]")?.getAttribute("data-feed-state") ?? null, card: reader?.closest<HTMLElement>(".card")?.dataset.id ?? null };
        }, PENDING_WORKER);
        await page.screenshot({ path: path.join(OUT, "flow-arrival-empty.png") });
        await page.waitForTimeout(1_500);
        const presence = await page.evaluate(() => {
          const posts = (window as unknown as { evidence: Evidence }).evidence.presence;
          return posts[posts.length - 1]?.focusedPath ?? null;
        });
        if (arrival.resolution !== "reader" || arrival.feed !== "empty") failures.push(`arrival: the empty transcript's open settled as ${JSON.stringify(arrival)}`);
        if (presence !== PENDING_WORKER) failures.push(`arrival: presence names ${presence}`);
        await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.focus.bus.board()?.returnFromHandoff?.("attention_empty"));
        await page.waitForTimeout(200);
        const returned = await page.evaluate(() => !document.querySelector('[data-kanban-reader="conversation_pending-worker"]'));
        if (!returned) failures.push("arrival: Return left the reader the open opened");

        /* A reader scrolled out of its column's box has not arrived. */
        await page.click(`${card("t-compact")} [data-stage="verify"]`);
        await waitSettled(page, "conversation_compact-ver");
        const destination = { rect: { x: 0, y: 0, w: 1, h: 1 }, zoom: "inspect", anchorKeys: ["/repo/compact-ver.jsonl"], intent: "open", path: "/repo/compact-ver.jsonl" };
        const inView = await page.evaluate((target) => {
          document.querySelector<HTMLElement>('[data-kanban-reader="conversation_compact-ver"]')!.scrollIntoView({ block: "center" });
          return (window as unknown as { evidence: Evidence }).evidence.focus.bus.board()!.arrival!(target);
        }, destination);
        /* The operator drags the orchestrator taller and scrolls back up to it:
           the reader is still mounted and open, below the page's fold. */
        await page.focus("[data-seat-grip]");
        for (let step = 0; step < 14; step += 1) await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(200);
        const outOfView = await page.evaluate((target) => {
          const reader = document.querySelector<HTMLElement>('[data-kanban-reader="conversation_compact-ver"]')!;
          const pageBox = document.querySelector<HTMLElement>(".kb-page")!;
          pageBox.scrollTop = 0;
          const rect = reader.getBoundingClientRect();
          const box = pageBox.getBoundingClientRect();
          return {
            inView: "",
            outOfView: (window as unknown as { evidence: Evidence }).evidence.focus.bus.board()!.arrival!(target),
            mounted: reader.isConnected && reader.dataset.folded === "0",
            visiblePx: Math.round(Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top))),
          };
        }, destination);
        outOfView.inView = String(inView);
        if (outOfView.inView !== "reader") failures.push(`arrival: a reader in view measured ${outOfView.inView}`);
        if (!outOfView.mounted || outOfView.visiblePx >= 48) failures.push(`arrival: could not take the reader out of view ${JSON.stringify(outOfView)}`);
        else if (outOfView.outOfView === "reader") failures.push("arrival: a reader scrolled out of its column arrived");
        flows.arrival = { arrival, presence, returned, outOfView };

        /* Link and Unlink over the assignment route. */
        const receipts = () => page.evaluate(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent));
        await page.evaluate(() => { document.querySelector<HTMLElement>(".kb-page")!.scrollTop = 0; });
        await page.click(`${card("t-export")} .tile >> nth=0`);
        const explore = readerFor("conversation_export-explore");
        await page.waitForSelector(explore, { timeout: 5_000 });
        await page.click(`${explore} [data-reader-menu]`);
        await page.click('.menu [role="menuitem"]:has-text("Unlink from this task")');
        await page.waitForFunction(() => document.querySelector("[data-kanban-receipt].error"), undefined, { timeout: 5_000 });
        const refusedUnlink = await receipts();
        await page.click(`${explore} [data-reader-menu]`);
        await page.click('.menu [role="menuitem"]:has-text("Link to another task")');
        await page.fill("[data-link-search]", "walkthrough");
        await page.screenshot({ path: path.join(OUT, "flow-link-picker.png") });
        await page.click('[data-link-task="t-onboarding"]');
        await page.waitForFunction(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].some((node) => node.textContent?.startsWith("Linked")), undefined, { timeout: 5_000 });
        const linked = await receipts();
        await page.waitForTimeout(600);
        const exploreNow = await page.evaluate((selector) => document.querySelector(selector) ? document.querySelector(selector)!.closest<HTMLElement>(".card")?.dataset.id ?? "parked" : null, explore);
        await page.click(`${explore} [data-reader-menu]`);
        await page.click('.menu [role="menuitem"]:has-text("Unlink from this task")');
        await page.waitForFunction(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].some((node) => node.textContent?.startsWith("Unlinked")), undefined, { timeout: 5_000 });
        const unlinked = await receipts();
        const calls = await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.assignments);
        const link = {
          refusedUnlink, linked, exploreNow, unlinked,
          calls: calls.map((call) => ({ method: call.method, id: call.id, body: call.body })),
        };
        const conversationName = "Explorer: list every export toggle";
        const owningTask = exploreNow === "task:t-onboarding" ? "Write the first-run walkthrough" : "Simplify the export settings sheet";
        if (!refusedUnlink.includes(`«Simplify the export settings sheet» is the only task «${conversationName}» has. Link it to another task first.`)) failures.push(`link: refused Unlink said ${JSON.stringify(refusedUnlink)}`);
        if (!linked.includes(`Linked «${conversationName}» to «Write the first-run walkthrough». Nothing was sent.`)) failures.push(`link: Link said ${JSON.stringify(linked)}`);
        if (!unlinked.includes(`Unlinked «${conversationName}» from «${owningTask}». Nothing stopped.`)) failures.push(`link: Unlink said ${JSON.stringify(unlinked)}`);
        const expectedCalls = [
          { method: "DELETE", id: "t-export", body: { conversationId: "conversation_export-explore" } },
          { method: "POST", id: "t-onboarding", body: { path: "/repo/export-explore.jsonl" } },
        ];
        if (JSON.stringify(link.calls.slice(0, 2)) !== JSON.stringify(expectedCalls) || link.calls.length !== 3 || link.calls[2]?.method !== "DELETE") failures.push(`link: route calls ${JSON.stringify(link.calls)}`);
        flows.link = link;
        if (pageErrors.length) failures.push(`flows: page errors ${pageErrors.join(" | ")}`);
      } finally {
        await context.close();
      }

      /* The same-column re-rank, the orchestrator's card, Stop host and a failed
         read, on a fresh page whose card order is the fixture's own. */
      const more = await openFixture(browser, base, FRAMES[0], "light");
      try {
        const { page } = more;
        await boardReady(page);
        const order = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.column[data-status="assigned"] .card[data-id]')].map((node) => node.dataset.id));

        /* A reader's feed keeps its place when another card passes its card. */
        await page.click(`${card("t-search")} [data-stage="verify"]`);
        await waitSettled(page, "conversation_search-ver-2");
        await page.evaluate((selector) => {
          const reader = document.querySelector<HTMLElement>(selector)!;
          reader.closest<HTMLElement>(".card")!.dataset.k3mark = "moved";
          reader.scrollIntoView({ block: "center" });
        }, readerFor("conversation_search-ver-2"));
        await page.waitForTimeout(300);
        /* The operator scrolls the feed up with the wheel, off its live tail. */
        const feedBox = await page.locator(`${readerFor("conversation_search-ver-2")} [data-log-feed-scroller]`).boundingBox();
        if (!feedBox) throw new Error("the verifier's feed is not laid out");
        await page.mouse.move(feedBox.x + feedBox.width / 2, feedBox.y + feedBox.height / 2);
        await page.mouse.wheel(0, -260);
        await page.waitForTimeout(600);
        const scrolled = await page.evaluate((selector) => {
          const scroller = document.querySelector<HTMLElement>(`${selector} [data-log-feed-scroller]`)!;
          return { top: scroller.scrollTop, room: scroller.scrollHeight - scroller.clientHeight };
        }, readerFor("conversation_search-ver-2"));
        const beforeRank = await order();
        await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.touchTask("t-export"));
        await page.waitForFunction(() => {
          const ids = [...document.querySelectorAll<HTMLElement>('.column[data-status="assigned"] .card[data-id]')].map((node) => node.dataset.id);
          return ids.indexOf("task:t-export") < ids.indexOf("task:t-search");
        }, undefined, { timeout: 15_000 });
        const afterRank = await order();
        const kept = await page.evaluate((selector) => {
          const reader = document.querySelector<HTMLElement>(selector)!;
          return { top: reader.querySelector<HTMLElement>("[data-log-feed-scroller]")!.scrollTop, sameCard: reader.closest<HTMLElement>(".card")?.dataset.k3mark === "moved" };
        }, readerFor("conversation_search-ver-2"));
        await page.waitForTimeout(500);
        const settledTop = await page.evaluate((selector) => document.querySelector<HTMLElement>(`${selector} [data-log-feed-scroller]`)!.scrollTop, readerFor("conversation_search-ver-2"));
        const rerank = { scrolled, beforeRank, afterRank, kept, settledTop };
        if (scrolled.room - scrolled.top < 40) failures.push(`rerank: the verifier's feed did not leave its tail ${JSON.stringify(scrolled)}`);
        if (beforeRank.indexOf("task:t-export") < beforeRank.indexOf("task:t-search")) failures.push(`rerank: t-export already led t-search ${JSON.stringify(beforeRank)}`);
        if (!kept.sameCard) failures.push("rerank: the reader's card was replaced rather than moved");
        if (Math.abs(kept.top - scrolled.top) > 4 || Math.abs(settledTop - scrolled.top) > 4) failures.push(`rerank: feed scroll ${scrolled.top} became ${kept.top}, then ${settledTop}`);
        await page.screenshot({ path: path.join(OUT, "flow-rerank-scroll.png") });
        flows.rerank = rerank;

        /* The orchestrator's own card: its reader shows the transcript, and the
           seat keeps the conversation's one composer. */
        await page.evaluate(() => { document.querySelector<HTMLElement>(".kb-page")!.scrollTop = 0; });
        const orchestratorTile = page.locator('.tile[data-member="/repo/orchestrator.jsonl"]');
        const orchestratorCard = await orchestratorTile.evaluate((tile) => ({ card: tile.closest<HTMLElement>(".card")?.dataset.id ?? null, column: tile.closest<HTMLElement>(".column")?.dataset.status ?? null }));
        await orchestratorTile.click();
        await waitSettled(page, "conversation_orchestrator");
        await page.waitForTimeout(400);
        const orchestratorComposers = (await seatGeometry(page)).composers;
        await page.locator(readerFor("conversation_orchestrator")).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, "flow-orchestrator-card.png") });
        if (orchestratorComposers.conversation_orchestrator !== 1) failures.push(`orchestrator card: ${JSON.stringify(orchestratorComposers)} composers with its reader open`);
        for (const [identity, count] of Object.entries(orchestratorComposers)) if (count > 1 || identity === "outside") failures.push(`orchestrator card: ${count} composer field(s) for ${identity}`);
        flows.orchestratorCard = { ...orchestratorCard, composers: orchestratorComposers };
        await page.click(`${readerFor("conversation_orchestrator")} [data-reader-close]`);

        /* Stop host from the reader's actions, confirmed by name, then cancelled. */
        await page.click(`${card("t-export")} .tile >> nth=0`);
        await waitSettled(page, "conversation_export-impl");
        await page.click(`${readerFor("conversation_export-impl")} [data-reader-menu]`);
        const menuItems = await page.evaluate(() => [...document.querySelectorAll('.menu [role="menuitem"]')].map((node) => node.textContent ?? ""));
        const stopItem = menuItems.find((text) => text.startsWith("Stop host"));
        if (!stopItem?.includes("PID 4401")) failures.push(`stop host: the reader's actions offer ${JSON.stringify(menuItems)}`);
        let stopConfirm: unknown = null;
        if (stopItem) {
          await page.click('.menu [role="menuitem"]:has-text("Stop host")');
          await page.waitForSelector(".popover.stop-confirm", { timeout: 5_000 });
          stopConfirm = await page.evaluate(() => ({
            text: document.querySelector(".popover.stop-confirm")?.textContent ?? "",
            cancelFocused: document.activeElement?.hasAttribute("data-stop-cancel") ?? false,
          }));
          await page.screenshot({ path: path.join(OUT, "flow-stop-host-confirm.png") });
          await page.click("[data-stop-cancel]");
          if (!(stopConfirm as { cancelFocused: boolean }).cancelFocused) failures.push("stop host: the confirmation does not start on Cancel");
        }
        flows.stopHost = { menuItems, stopConfirm };

        /* A transcript that fails to read never arrives. */
        const failedArrival = await page.evaluate(async () => {
          const evidence = (window as unknown as { evidence: Evidence }).evidence;
          evidence.failLogsFor = "/repo/upload-plan.jsonl";
          const result = await evidence.focus.runFocusTransaction({
            id: "attention_failed_read",
            target: { kind: "conversation", path: "/repo/upload-plan.jsonl" },
            frameAtCreation: { project: "atlas", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
            intent: "open",
            zoom: "inspect",
          }, evidence.focus.bus, { timeoutMs: 3_000 });
          const reader = document.querySelector<HTMLElement>('[data-kanban-reader="conversation_upload-plan"]');
          const outcome = { resolution: result.resolution, feed: reader?.querySelector("[data-feed-state]")?.getAttribute("data-feed-state") ?? null, text: reader?.querySelector("[data-feed-state]")?.textContent?.trim().slice(0, 80) ?? null };
          evidence.failLogsFor = null;
          return outcome;
        });
        await page.screenshot({ path: path.join(OUT, "flow-arrival-failed-read.png") });
        if (failedArrival.resolution !== "lost" || failedArrival.feed !== "error") failures.push(`failed read: the open settled as ${JSON.stringify(failedArrival)}`);
        flows.failedRead = failedArrival;
        if (more.pageErrors.length) failures.push(`more flows: page errors ${more.pageErrors.join(" | ")}`);
      } finally {
        await more.context.close();
      }

      /* The narrowest desktop: the seat starts collapsed and nothing pushes sideways. */
      const narrow = await openFixture(browser, base, { width: 640, height: 720 }, "light");
      try {
        await boardReady(narrow.page);
        const seat = await seatGeometry(narrow.page);
        await narrow.page.screenshot({ path: path.join(OUT, "board-640x720-light.png") });
        if (!seat.collapsed || seat.pageOverflowX > 1 || seat.dock) failures.push(`640: seat ${JSON.stringify(seat)}`);
        flows.narrow = seat;
      } finally {
        await narrow.context.close();
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "k3.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), frames, flows, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 900_000);
});

describe("#1695 K4b inline editing, colour, hide and the Hidden tray", () => {
  /*
   * Rendered evidence for task editing on the kanban board (#1695 K4b): the real
   * Viewer over `issue1695Evidence.fixture.tsx?scenario=editing`, against the
   * production stylesheet, in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
   * prototype, every frame and flow is also driven in the prototype, at the
   * same board width, and saved beside the production frame; the ported
   * geometry (swatches, the title editor, the tray) is compared.
   *
   * Gated here:
   *   - the card menu carries Colour swatches, Rename (Enter), the description
   *     (E) and Hide from board (H) with its why line;
   *   - the title and description editors open focused in place with their
   *     hints; Enter, Esc and a refused save keep the prototype's behaviour, and
   *     an agent's title arriving mid-edit is offered beside the draft;
   *   - × hides a group at once with Undo; the write is guarded and Undo clears
   *     the stored hide;
   *   - Hide finished tasks keeps the group whose agent is working, writes one
   *     task at a time, and one Undo brings every group back;
   *   - the group holding the orchestrator's conversation keeps a lock, stays on
   *     the board despite a stored hide, and H sends nothing;
   *   - a hidden group whose conversation asks for a decision comes back with a
   *     receipt saying why;
   *   - a colour writes only the colour and leaves `updatedAt`;
   *   - the Hidden tray lists hidden groups, the empty task off the board and
   *     the closed conversation, and Show and Restore bring each back.
   *
   * Measurements go to `evidence/issue-1695/k4b.json`; frames to
   * `.artifacts/issue-1695/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1695");
  const EVIDENCE = path.resolve("evidence/issue-1695");

  type Evidence = {
    agentWritesDescriptionQuietly: (id: string, description: string) => void;
    filesDelayMs: number;
    seatReads: number;
    taskPatches: Array<{ id: string; body: Record<string, unknown> }>;
    taskWrites: Array<{ id: string; startedAt: number; answeredAt: number }>;
    boardMutations: Array<Record<string, unknown>>;
    refuseNextTaskPatch: boolean;
    agentWritesTitle: (id: string, title: string) => void;
    askDecision: (path: string) => void;
    storedTask: (id: string) => Record<string, unknown> | null;
  };

  const protoCard = (id: string) => `#app .card[data-id="${id}"]`;
  const columnOf = (page: Page, id: string) => page.evaluate((selector) => document.querySelector(selector)?.closest<HTMLElement>(".column")?.dataset.status ?? null, card(id));
  const receipts = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent ?? ""));
  const evidenceOf = <T,>(page: Page, read: (evidence: Evidence) => T) => page.evaluate(`(${read.toString()})(window.evidence)`) as Promise<T>;
  const hiddenCount = (page: Page) => page.evaluate(() => document.querySelector("[data-hidden-pill]")?.getAttribute("data-count") ?? null);

  async function boardReady(page: Page) {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
    await page.waitForSelector("[data-kanban-seat] [data-orchestrator-panel]", { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(600);
  }

  /** A press the way a person makes one: down, a beat, up. */
  async function humanPress(page: Page, selector: string, holdMs = 90) {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`nothing to press at ${selector}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(holdMs);
    await page.mouse.up();
  }

  const writesSettled = (page: Page, count: number, timeout = 10_000) => page.waitForFunction((expected) => {
    const writes = (window as unknown as { evidence: Evidence }).evidence.taskWrites;
    return writes.length === expected && writes.every((write) => write.answeredAt > 0);
  }, count, { timeout });

  /** The width the board gets beside the Viewer's project rail. */
  const boardWidth = (page: Page) => page.evaluate(() => Math.round(document.querySelector("[data-kanban-board]")?.getBoundingClientRect().width ?? 0));

  const rect = (page: Page, selector: string) => page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  }, selector);

  browserTest("#1695 K4b: inline editing, colour, group hide and the Hidden tray over the real Viewer, against the prototype", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=editing`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, unknown> = {};
    const flows: Record<string, unknown> = {};
    const prototypeNotes: string[] = [];
    let width = 0;

    const production = async (scheme: Scheme, run: (page: Page) => Promise<void>, label: string) => {
      const opened = await openFixture(browser, base, VIEWPORT, scheme);
      try {
        await boardReady(opened.page);
        if (!width) width = await boardWidth(opened.page);
        await run(opened.page);
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    /* The prototype at the production board's width, driven to the same state. */
    const prototype = async (query: string, scheme: Scheme, run: (page: Page) => Promise<void>, label: string) => {
      if (!PROTOTYPE) return;
      const opened = await openFixture(browser, `${PROTOTYPE}/${query ? `?${query}` : ""}`, { width: width || VIEWPORT.width, height: VIEWPORT.height }, scheme);
      try {
        await opened.page.waitForSelector("#app[data-ready] .board", { timeout: 20_000 });
        await opened.page.waitForTimeout(400);
        await run(opened.page);
      } catch (error) {
        prototypeNotes.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    const shot = (page: Page, side: "production" | "prototype", id: string, scheme: Scheme = "light") => page.screenshot({ path: path.join(OUT, `${side}-k4b-${id}-${scheme}.png`) });

    try {
      /* ── Static frames ───────────────────────────────────────────────────── */
      for (const scheme of ["light", "dark"] as const) {
        await production(scheme, async (page) => {
          await page.locator(card("t-export")).scrollIntoViewIfNeeded();
          await page.click(`${card("t-export")} [data-menu]`);
          await page.waitForSelector(".menu .swatch");
          await page.waitForTimeout(350);
          const menu = await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>(".menu")!;
            const swatch = root.querySelector<HTMLElement>(".swatch")!.getBoundingClientRect();
            return {
              width: Math.round(root.getBoundingClientRect().width),
              swatches: [...root.querySelectorAll(".swatch")].map((node) => node.getAttribute("aria-label")),
              swatchBox: { width: Math.round(swatch.width), height: Math.round(swatch.height) },
              checked: root.querySelector('.swatch[aria-checked="true"]')?.getAttribute("data-swatch") ?? null,
              items: [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => ({ label: item.querySelector(".lbl")?.firstChild?.textContent ?? "", kbd: item.querySelector(".kbd")?.textContent ?? null, why: item.querySelector(".why")?.textContent ?? null, disabled: item.getAttribute("aria-disabled") === "true" })),
            };
          });
          await shot(page, "production", "card-menu", scheme);
          const named = (label: string) => menu.items.find((item) => item.label === label);
          if (menu.swatches.length !== 9) failures.push(`card menu ${scheme}: ${menu.swatches.length} swatches`);
          if (named("Rename")?.kbd !== "Enter") failures.push(`card menu ${scheme}: Rename ${JSON.stringify(named("Rename"))}`);
          if (named("Edit description")?.kbd !== "E") failures.push(`card menu ${scheme}: description ${JSON.stringify(named("Edit description"))}`);
          if (named("Hide from board")?.kbd !== "H" || !named("Hide from board")?.why) failures.push(`card menu ${scheme}: hide ${JSON.stringify(named("Hide from board"))}`);
          frames[`card-menu-${scheme}`] = { production: menu };
        }, `card menu ${scheme}`);
        await prototype("menu=t-export", scheme, async (page) => {
          await page.waitForSelector(".menu .swatch");
          await page.waitForTimeout(350);
          const swatch = await rect(page, ".menu .swatch");
          const menuBox = await rect(page, ".menu");
          await shot(page, "prototype", "card-menu", scheme);
          Object.assign(frames[`card-menu-${scheme}`] ?? (frames[`card-menu-${scheme}`] = {}), { prototype: { width: menuBox?.width, swatchBox: swatch } });
        }, `prototype card menu ${scheme}`);

        await production(scheme, async (page) => {
          await page.click("[data-hidden-pill]");
          await page.waitForSelector(".hidden-tray");
          await page.waitForTimeout(350);
          const tray = await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>(".hidden-tray")!;
            return {
              width: Math.round(root.getBoundingClientRect().width),
              count: document.querySelector("[data-hidden-pill]")?.getAttribute("data-count"),
              sections: [...root.querySelectorAll(".sec-label")].map((node) => node.textContent),
              groups: [...root.querySelectorAll<HTMLElement>("[data-hidden-group]")].map((row) => ({ id: row.dataset.hiddenGroup, meta: row.querySelector(".meta")?.textContent })),
              empty: [...root.querySelectorAll<HTMLElement>("[data-hidden-task]")].map((row) => row.dataset.hiddenTask),
              closed: [...root.querySelectorAll<HTMLElement>("[data-closed-conversation]")].map((row) => row.querySelector(".title")?.textContent),
              rowHeight: Math.round(root.querySelector(".row")?.getBoundingClientRect().height ?? 0),
            };
          });
          await shot(page, "production", "hidden-tray", scheme);
          if (tray.count !== "5") failures.push(`tray ${scheme}: hidden count ${tray.count}`);
          if (JSON.stringify(tray.groups.map((group) => group.id).sort()) !== JSON.stringify(["t-compact", "t-merge-a", "t-verify-a"])) failures.push(`tray ${scheme}: groups ${JSON.stringify(tray.groups)}`);
          if (JSON.stringify(tray.empty) !== JSON.stringify(["t-old"])) failures.push(`tray ${scheme}: empty ${JSON.stringify(tray.empty)}`);
          if (JSON.stringify(tray.closed) !== JSON.stringify(["Spike: a virtualized Done column"])) failures.push(`tray ${scheme}: closed ${JSON.stringify(tray.closed)}`);
          frames[`hidden-tray-${scheme}`] = { production: tray };
        }, `tray ${scheme}`);
        await prototype("hidden=t-merge-a,t-verify-a,t-compact&tray=1", scheme, async (page) => {
          await page.waitForSelector(".popover .row");
          const box = await rect(page, ".popover");
          const row = await rect(page, ".popover .row");
          await shot(page, "prototype", "hidden-tray", scheme);
          Object.assign(frames[`hidden-tray-${scheme}`] ?? (frames[`hidden-tray-${scheme}`] = {}), { prototype: { width: box?.width, rowHeight: row?.height } });
        }, `prototype tray ${scheme}`);
      }

      await production("light", async (page) => {
        await page.locator(card("t-search")).evaluate((element) => element.scrollIntoView({ block: "center" }));
        const before = await rect(page, card("t-search"));
        await page.click(`${card("t-search")} [data-rename]`);
        await page.waitForSelector(`${card("t-search")} input.title-edit`);
        const editing = await page.evaluate((selector) => {
          const field = document.querySelector<HTMLInputElement>(`${selector} input.title-edit`)!;
          return { focused: document.activeElement === field, value: field.value, height: Math.round(field.getBoundingClientRect().height), hint: document.querySelector(`${selector} .edit-hint span`)?.textContent ?? null };
        }, card("t-search"));
        const during = await rect(page, card("t-search"));
        await shot(page, "production", "editing-title");
        if (!editing.focused || editing.value !== "Restore search results after the index rebuild" || editing.hint !== "Enter saves · Esc cancels") failures.push(`editing title: ${JSON.stringify(editing)}`);
        await page.keyboard.press("Escape");
        const afterEscape = await page.evaluate((selector) => ({ editor: Boolean(document.querySelector(`${selector} input.title-edit`)), focused: document.activeElement === document.querySelector(selector) }), card("t-search"));
        if (afterEscape.editor || !afterEscape.focused) failures.push(`editing title: Esc left ${JSON.stringify(afterEscape)}`);
        frames["editing-title"] = { production: { ...editing, cardBefore: before, cardDuring: during } };

        await page.locator(card("t-export")).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${card("t-export")} [data-describe]`);
        await page.waitForSelector(`${card("t-export")} textarea.desc-edit`);
        const description = await page.evaluate((selector) => {
          const field = document.querySelector<HTMLTextAreaElement>(`${selector} textarea.desc-edit`)!;
          return { focused: document.activeElement === field, value: field.value, height: Math.round(field.getBoundingClientRect().height), hint: document.querySelector(`${selector} .edit-hint span`)?.textContent ?? null };
        }, card("t-export"));
        await shot(page, "production", "editing-description");
        if (!description.focused || !description.value.startsWith("Fold the eleven toggles")) failures.push(`editing description: ${JSON.stringify(description)}`);
        frames["editing-description"] = { production: description };
        await page.keyboard.press("Escape");
        if ((await evidenceOf(page, (evidence) => evidence.taskPatches.length)) !== 0) failures.push("editing: Esc sent a write");
      }, "editing frames");
      await prototype("edit=t-search", "light", async (page) => {
        await page.waitForSelector(`${protoCard("t-search")} input.edit`);
        const field = await rect(page, `${protoCard("t-search")} input.edit`);
        await shot(page, "prototype", "editing-title");
        Object.assign(frames["editing-title"] as object, { prototype: { height: field?.height } });
      }, "prototype editing title");
      await prototype("editdesc=t-export", "light", async (page) => {
        await page.waitForSelector(`${protoCard("t-export")} textarea.edit`);
        const field = await rect(page, `${protoCard("t-export")} textarea.edit`);
        await shot(page, "prototype", "editing-description");
        Object.assign(frames["editing-description"] as object, { prototype: { height: field?.height } });
      }, "prototype editing description");

      await production("light", async (page) => {
        await page.click('[data-colmenu="done"]');
        await page.waitForSelector(".menu");
        await page.waitForTimeout(350);
        const items = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.menu [role="menuitem"]')].map((item) => ({ label: item.querySelector(".lbl")?.firstChild?.textContent ?? "", why: item.querySelector(".why")?.textContent ?? null, disabled: item.getAttribute("aria-disabled") === "true" })));
        await shot(page, "production", "column-menu-done");
        const hide = items.find((item) => item.label.startsWith("Hide finished"));
        if (hide?.label !== "Hide finished tasks (3)" || hide.why !== "Keeps 1 task whose agent is still working.") failures.push(`done column menu: ${JSON.stringify(items)}`);
        frames["column-menu-done"] = { production: items };
      }, "done column menu");
      await prototype("colmenu=done", "light", async (page) => {
        await page.waitForSelector(".menu");
        await shot(page, "prototype", "column-menu-done");
      }, "prototype done column menu");

      /* ── Flows ───────────────────────────────────────────────────────────── */
      await production("light", async (page) => {
        const countBefore = await hiddenCount(page);
        await page.hover(card("t-search"));
        await page.click(`${card("t-search")} [data-hide]`);
        const onClick = { column: await columnOf(page, "t-search"), count: await hiddenCount(page), receipts: await receipts(page), focused: await page.evaluate(() => document.activeElement?.closest<HTMLElement>(".card")?.dataset.id ?? null) };
        await page.waitForTimeout(350);
        await shot(page, "production", "flow-hide-receipt");
        await page.waitForFunction(() => (window as unknown as { evidence: Evidence }).evidence.taskWrites.every((write) => write.answeredAt > 0), undefined, { timeout: 5_000 });
        const written = await evidenceOf(page, (evidence) => ({ patches: evidence.taskPatches.map((patch) => ({ id: patch.id, hide: patch.body.hide, guarded: typeof patch.body.expectedRevision === "string" })), stored: Boolean(evidence.storedTask("t-search")?.groupHidden) }));
        await page.click('[data-kanban-receipt] .act:has-text("Undo")');
        await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-pending") === "0", card("t-search"), { timeout: 5_000 });
        const undone = { column: await columnOf(page, "t-search"), stored: await evidenceOf(page, (evidence) => Boolean(evidence.storedTask("t-search")?.groupHidden)) };
        if (onClick.column !== null || onClick.count !== String(Number(countBefore) + 1) || !onClick.receipts.includes("Hidden «Restore search results after the index rebuild» · 1 agent keeps working")) failures.push(`hide: on click ${JSON.stringify(onClick)}`);
        if (!onClick.focused) failures.push("hide: focus did not move to another card");
        if (!written.stored || written.patches.length !== 1 || !written.patches[0]!.guarded || written.patches[0]!.hide !== true) failures.push(`hide: written ${JSON.stringify(written)}`);
        if (undone.column !== "assigned" || undone.stored) failures.push(`hide: undo left ${JSON.stringify(undone)}`);
        flows.hide = { countBefore, onClick, written, undone };
      }, "hide flow");
      await prototype("", "light", async (page) => {
        await page.hover(protoCard("t-search"));
        await page.click(`${protoCard("t-search")} [data-hide]`);
        await page.waitForTimeout(200);
        await shot(page, "prototype", "flow-hide-receipt");
      }, "prototype hide flow");

      await production("light", async (page) => {
        await page.click('[data-colmenu="done"]');
        await page.click('.menu [role="menuitem"]:has-text("Hide finished")');
        const left = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.column[data-status="done"] .card')].map((node) => node.dataset.id));
        const receiptList = await receipts(page);
        await page.waitForTimeout(350);
        await shot(page, "production", "flow-bulk-hide");
        await page.waitForFunction(() => {
          const writes = (window as unknown as { evidence: Evidence }).evidence.taskWrites;
          return writes.length === 3 && writes.every((write) => write.answeredAt > 0);
        }, undefined, { timeout: 10_000 });
        const writes = await evidenceOf(page, (evidence) => evidence.taskWrites.map((write) => ({ ...write })));
        const sequential = writes.every((write, index) => index === 0 || write.startedAt >= writes[index - 1]!.answeredAt);
        await page.click('[data-kanban-receipt] .act:has-text("Undo")');
        await page.waitForFunction(() => document.querySelectorAll('.column[data-status="done"] .card').length === 4, undefined, { timeout: 5_000 });
        await page.waitForFunction(() => {
          const writes = (window as unknown as { evidence: Evidence }).evidence.taskWrites;
          return writes.length === 6 && writes.every((write) => write.answeredAt > 0);
        }, undefined, { timeout: 10_000 });
        const stored = await evidenceOf(page, (evidence) => ["t-interrupt", "t-voice", "t-queue"].map((id) => Boolean(evidence.storedTask(id)?.groupHidden)));
        if (JSON.stringify(left) !== JSON.stringify(["task:t-attach"])) failures.push(`bulk hide: Done keeps ${JSON.stringify(left)}`);
        if (!receiptList.includes("Hidden 3 finished tasks · kept 1 with a working agent")) failures.push(`bulk hide: receipts ${JSON.stringify(receiptList)}`);
        if (!sequential) failures.push(`bulk hide: writes overlapped ${JSON.stringify(writes)}`);
        if (stored.some(Boolean)) failures.push(`bulk hide: undo left stored hides ${JSON.stringify(stored)}`);
        flows.bulkHide = { left, receipts: receiptList, sequential, writes: writes.map((write) => ({ id: write.id, tookMs: Math.round(write.answeredAt - write.startedAt) })), undoneStored: stored };
      }, "bulk hide flow");
      await prototype("", "light", async (page) => {
        await page.click('[data-focus="colmenu:done"]');
        await page.click('.menu [role="menuitem"]:has-text("Hide finished")');
        await page.waitForTimeout(400);
        await shot(page, "prototype", "flow-bulk-hide");
      }, "prototype bulk hide flow");

      await production("light", async (page) => {
        await page.locator(card("t-seat")).scrollIntoViewIfNeeded();
        const seatCard = await page.evaluate((selector) => {
          const element = document.querySelector<HTMLElement>(selector);
          return element ? {
            column: element.closest<HTMLElement>(".column")?.dataset.status ?? null,
            lock: Boolean(element.querySelector("[data-lock]")),
            hideButton: Boolean(element.querySelector("[data-hide]")),
            resurfaced: element.querySelector("[data-resurfaced] .msg")?.textContent ?? null,
            hideAgain: Boolean(element.querySelector("[data-resurfaced] button")),
          } : null;
        }, card("t-seat"));
        await page.focus(card("t-seat"));
        await page.keyboard.press("h");
        await page.waitForTimeout(300);
        const receiptList = await receipts(page);
        await page.waitForTimeout(350);
        await shot(page, "production", "flow-protected-seat");
        const loadReceipts = receiptList.filter((text) => text.includes("is back on the board"));
        if (loadReceipts.length) failures.push(`seat group: the first seat read announced ${JSON.stringify(loadReceipts)}`);
        await page.click(`${card("t-seat")} [data-menu]`);
        const menuHide = await page.evaluate(() => {
          const item = [...document.querySelectorAll<HTMLElement>('.menu [role="menuitem"]')].find((node) => node.querySelector(".lbl")?.firstChild?.textContent === "Hide from board");
          return item ? { disabled: item.getAttribute("aria-disabled") === "true", why: item.querySelector(".why")?.textContent ?? null } : null;
        });
        const patches = await evidenceOf(page, (evidence) => evidence.taskPatches.length);
        if (!seatCard || seatCard.column !== "assigned" || !seatCard.lock || seatCard.hideButton || seatCard.resurfaced !== "Back on the board: it holds the orchestrator's conversation" || seatCard.hideAgain) failures.push(`seat group: ${JSON.stringify(seatCard)}`);
        if (!receiptList.includes("«Coordinate the atlas release» holds the orchestrator's conversation, so it stays on the board")) failures.push(`seat group: H receipts ${JSON.stringify(receiptList)}`);
        if (!menuHide?.disabled) failures.push(`seat group: menu hide ${JSON.stringify(menuHide)}`);
        if (patches !== 0) failures.push(`seat group: ${patches} writes`);
        flows.protectedSeat = { seatCard, receipts: receiptList, menuHide, patches };
      }, "protected seat flow");
      await prototype("", "light", async (page) => {
        await page.focus(".seat");
        await page.keyboard.press("h");
        await page.click('[data-focus="seat-collapse"]');
        await page.waitForTimeout(200);
        await shot(page, "prototype", "flow-protected-seat");
      }, "prototype protected seat flow");

      await production("light", async (page) => {
        await page.evaluate(() => { (window as unknown as { evidence: Evidence }).evidence.refuseNextTaskPatch = true; });
        await page.locator(card("t-export")).scrollIntoViewIfNeeded();
        await page.click(`${card("t-export")} [data-rename]`);
        await page.fill(`${card("t-export")} input.title-edit`, "Export presets: three, plus advanced");
        await page.keyboard.press("Enter");
        const optimistic = await page.evaluate((selector) => document.querySelector(`${selector} .title`)?.textContent ?? null, card("t-export"));
        await page.waitForSelector(`${card("t-export")} [data-edit-failed]`, { timeout: 5_000 });
        const refused = await page.evaluate((selector) => ({ title: document.querySelector(`${selector} .title`)?.textContent ?? null, notice: document.querySelector(`${selector} [data-edit-failed] .msg`)?.textContent ?? null }), card("t-export"));
        await page.waitForTimeout(350);
        await shot(page, "production", "flow-rename-refused");
        await page.click(`${card("t-export")} [data-edit-failed] button:has-text("Retry")`);
        await page.waitForFunction(() => (window as unknown as { evidence: Evidence }).evidence.taskWrites.length === 2 && (window as unknown as { evidence: Evidence }).evidence.taskWrites.every((write) => write.answeredAt > 0), undefined, { timeout: 5_000 });
        await page.waitForTimeout(300);
        const stored = await evidenceOf(page, (evidence) => String(evidence.storedTask("t-export")?.text ?? ""));
        if (optimistic !== "Export presets: three, plus advanced") failures.push(`rename: optimistic title ${optimistic}`);
        if (refused.title !== "Simplify the export settings sheet" || !refused.notice?.includes("Your text is kept")) failures.push(`rename: refused ${JSON.stringify(refused)}`);
        if (stored !== "Export presets: three, plus advanced\nFold the eleven toggles into three sensible presets and one advanced disclosure.") failures.push(`rename: stored ${JSON.stringify(stored)}`);
        /* Refused again, then reopened: the field starts from the kept draft. */
        await page.evaluate(() => { (window as unknown as { evidence: Evidence }).evidence.refuseNextTaskPatch = true; });
        await page.click(`${card("t-export")} [data-rename]`);
        await page.fill(`${card("t-export")} input.title-edit`, "Export presets, kept draft");
        await page.keyboard.press("Enter");
        await page.waitForSelector(`${card("t-export")} [data-edit-failed]`, { timeout: 5_000 });
        await page.click(`${card("t-export")} [data-rename]`);
        const reopened = await page.evaluate((selector) => ({ value: document.querySelector<HTMLInputElement>(`${selector} input.title-edit`)?.value ?? null, notice: Boolean(document.querySelector(`${selector} [data-edit-failed]`)) }), card("t-export"));
        await page.keyboard.press("Enter");
        await writesSettled(page, 4);
        await page.waitForTimeout(300);
        const reopenedStored = await evidenceOf(page, (evidence) => String(evidence.storedTask("t-export")?.text ?? "").split("\n", 1)[0]);
        if (reopened.value !== "Export presets, kept draft" || reopened.notice || reopenedStored !== "Export presets, kept draft") failures.push(`rename: reopened ${JSON.stringify({ reopened, reopenedStored })}`);
        flows.renameRefused = { optimistic, refused, stored, reopened, reopenedStored };
      }, "rename refused flow");
      await prototype("fail=title", "light", async (page) => {
        await page.click(`${protoCard("t-export")} .title`);
        await page.fill(`${protoCard("t-export")} input.edit`, "Export presets: three, plus advanced");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(700);
        await shot(page, "prototype", "flow-rename-refused");
      }, "prototype rename refused flow");

      await production("light", async (page) => {
        await page.locator(card("t-export")).scrollIntoViewIfNeeded();
        await page.click(`${card("t-export")} [data-rename]`);
        await page.fill(`${card("t-export")} input.title-edit`, "Export presets, my draft");
        await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.agentWritesTitle("t-export", "Simplify the export settings sheet (agent revision)"));
        await page.waitForSelector(`${card("t-export")} [data-edit-incoming]`, { timeout: 5_000 });
        const incoming = await page.evaluate((selector) => ({ notice: document.querySelector(`${selector} [data-edit-incoming] .msg`)?.textContent ?? null, draft: document.querySelector<HTMLInputElement>(`${selector} input.title-edit`)?.value ?? null }), card("t-export"));
        await page.waitForTimeout(350);
        await shot(page, "production", "flow-concurrent-edit");
        const editorState = () => page.evaluate((selector) => ({
          value: document.querySelector<HTMLInputElement>(`${selector} input.title-edit`)?.value ?? null,
          focused: document.activeElement === document.querySelector(`${selector} input.title-edit`),
          notice: Boolean(document.querySelector(`${selector} [data-edit-incoming]`)),
        }), card("t-export"));
        /* A person's press, 90 ms between down and up, on Use theirs. */
        await humanPress(page, `${card("t-export")} [data-edit-incoming] button:has-text("Use theirs")`);
        await page.waitForTimeout(400);
        const theirs = { ...(await editorState()), patches: await evidenceOf(page, (evidence) => evidence.taskPatches.length) };
        if (incoming.draft !== "Export presets, my draft" || incoming.notice !== "An agent changed the title while you edit: «Simplify the export settings sheet (agent revision)»") failures.push(`concurrent edit: ${JSON.stringify(incoming)}`);
        if (theirs.value !== "Simplify the export settings sheet (agent revision)" || theirs.notice || theirs.patches !== 0) failures.push(`concurrent edit: Use theirs left ${JSON.stringify(theirs)}`);
        /* And on Keep mine, after the agent writes again. */
        await page.fill(`${card("t-export")} input.title-edit`, "Export presets, second draft");
        await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.agentWritesTitle("t-export", "Simplify the export settings sheet (agent revision 2)"));
        await page.waitForSelector(`${card("t-export")} [data-edit-incoming]`, { timeout: 5_000 });
        await humanPress(page, `${card("t-export")} [data-edit-incoming] button:has-text("Keep mine")`);
        await page.waitForTimeout(400);
        const mine = { ...(await editorState()), patches: await evidenceOf(page, (evidence) => evidence.taskPatches.length), stored: await evidenceOf(page, (evidence) => String(evidence.storedTask("t-export")?.text ?? "").split("\n", 1)[0]) };
        if (mine.value !== "Export presets, second draft" || mine.notice || mine.patches !== 0 || mine.stored !== "Simplify the export settings sheet (agent revision 2)") failures.push(`concurrent edit: Keep mine left ${JSON.stringify(mine)}`);
        flows.concurrentEdit = { incoming, theirs, mine };
      }, "concurrent edit flow");
      await prototype("", "light", async (page) => {
        await page.click(`${protoCard("t-export")} .title`);
        await page.evaluate(() => (window as unknown as { __proto: { agentEditsCard: (id: string) => void } }).__proto.agentEditsCard("t-export"));
        await page.waitForTimeout(200);
        await shot(page, "prototype", "flow-concurrent-edit");
      }, "prototype concurrent edit flow");

      await production("light", async (page) => {
        const before = await columnOf(page, "t-merge-a");
        await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.askDecision("/repo/merge-impl.jsonl"));
        await page.waitForSelector(card("t-merge-a"), { state: "attached", timeout: 10_000 });
        await page.locator(card("t-merge-a")).scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const back = await page.evaluate((selector) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          return { column: element.closest<HTMLElement>(".column")?.dataset.status ?? null, needs: Boolean(element.querySelector(".activity .needs")), line: element.querySelector("[data-resurfaced] .msg")?.textContent ?? null };
        }, card("t-merge-a"));
        const receiptList = await receipts(page);
        await page.waitForTimeout(350);
        await shot(page, "production", "flow-resurface");
        if (before !== null || back.column !== "assigned" || !back.needs || back.line !== "Back on the board: a conversation asked for a decision") failures.push(`resurface: ${JSON.stringify({ before, back })}`);
        if (!receiptList.includes("«Merge the approved queue adapter release · merge» is back on the board: a conversation asked for a decision")) failures.push(`resurface: receipts ${JSON.stringify(receiptList)}`);
        flows.resurface = { before, back, receipts: receiptList };
      }, "resurface flow");
      await prototype("hidden=t-merge-a", "light", async (page) => {
        await page.evaluate(() => (window as unknown as { __proto: { hiddenTaskNeedsDecision: () => void } }).__proto.hiddenTaskNeedsDecision());
        await page.waitForTimeout(300);
        await shot(page, "prototype", "flow-resurface");
      }, "prototype resurface flow");

      await production("light", async (page) => {
        const before = await evidenceOf(page, (evidence) => String(evidence.storedTask("t-disk")?.updatedAt ?? ""));
        await page.locator(card("t-disk")).scrollIntoViewIfNeeded();
        await page.click(`${card("t-disk")} [data-menu]`);
        await page.click('.menu .swatch[aria-label="Teal"]');
        const applied = await page.evaluate((selector) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          return { color: element.dataset.color, bar: getComputedStyle(element.querySelector(".label")!).backgroundColor };
        }, card("t-disk"));
        await page.waitForFunction(() => (window as unknown as { evidence: Evidence }).evidence.taskWrites.every((write) => write.answeredAt > 0), undefined, { timeout: 5_000 });
        await page.waitForTimeout(300);
        await page.waitForTimeout(350);
        await shot(page, "production", "flow-colour");
        const stored = await evidenceOf(page, (evidence) => ({ color: evidence.storedTask("t-disk")?.color, updatedAt: String(evidence.storedTask("t-disk")?.updatedAt ?? ""), body: evidence.taskPatches[0]?.body }));
        if (applied.color !== "teal" || applied.bar !== "rgb(26, 158, 143)") failures.push(`colour: ${JSON.stringify(applied)}`);
        if (stored.color !== "teal" || stored.updatedAt !== before || Object.keys(stored.body ?? {}).sort().join() !== "color,expectedProject,expectedRevision") failures.push(`colour: stored ${JSON.stringify({ ...stored, before })}`);
        flows.colour = { applied, stored: { color: stored.color, updatedAtKept: stored.updatedAt === before, fields: Object.keys(stored.body ?? {}).sort() } };
      }, "colour flow");
      await prototype("", "light", async (page) => {
        await page.click(`${protoCard("t-disk")} [data-menu]`);
        await page.click('.menu .swatch[aria-label="Teal"]');
        await page.waitForTimeout(300);
        await shot(page, "prototype", "flow-colour");
      }, "prototype colour flow");

      await production("light", async (page) => {
        await page.click("[data-hidden-pill]");
        await page.click('.hidden-tray [data-hidden-group="t-verify-a"] .show');
        await page.waitForSelector(card("t-verify-a"), { state: "attached", timeout: 5_000 });
        const shown = { column: await columnOf(page, "t-verify-a"), count: await hiddenCount(page) };
        await page.click("[data-hidden-pill]");
        await page.click('.hidden-tray [data-closed-conversation="/repo/old-spike.jsonl"] .show');
        await page.waitForTimeout(600);
        const restored = {
          count: await hiddenCount(page),
          mutations: await evidenceOf(page, (evidence) => evidence.boardMutations.filter((mutation) => mutation.kind === "restore")),
          receipts: await receipts(page),
        };
        if (shown.column !== "assigned" || shown.count !== "4") failures.push(`tray show: ${JSON.stringify(shown)}`);
        if (restored.count !== "3" || JSON.stringify(restored.mutations) !== JSON.stringify([{ kind: "restore", path: "/repo/old-spike.jsonl", placement: "manual" }])) failures.push(`tray restore: ${JSON.stringify(restored)}`);
        flows.tray = { shown, restored };
      }, "tray flow");

      await production("light", async (page) => {
        /* The agent rewrites the description where the board cannot see it yet;
           the operator's title is put onto that text and sent once more. */
        await page.locator(card("t-export")).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${card("t-export")} [data-rename]`);
        await page.fill(`${card("t-export")} input.title-edit`, "Export presets, merged");
        await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.agentWritesDescriptionQuietly("t-export", "Agent: three presets and one advanced disclosure."));
        await page.keyboard.press("Enter");
        await writesSettled(page, 2);
        await page.waitForTimeout(500);
        const merged = {
          stored: await evidenceOf(page, (evidence) => String(evidence.storedTask("t-export")?.text ?? "")),
          patches: await evidenceOf(page, (evidence) => evidence.taskPatches.map((patch) => String(patch.body.text ?? ""))),
          notice: await page.evaluate((selector) => Boolean(document.querySelector(`${selector} [data-edit-incoming]`)), card("t-export")),
        };
        if (merged.stored !== "Export presets, merged\nAgent: three presets and one advanced disclosure." || merged.patches.length !== 2 || merged.notice) failures.push(`field-aware save: ${JSON.stringify(merged)}`);
        flows.fieldAwareSave = merged;
      }, "field-aware save flow");

      await production("light", async (page) => {
        /* Every catalog read now takes 1.8 s and carries what the store held when
           it began: the poll that follows the hide lands after the Undo. */
        await page.evaluate(() => { (window as unknown as { evidence: Evidence }).evidence.filesDelayMs = 1_800; });
        await page.hover(card("t-search"));
        await page.click(`${card("t-search")} [data-hide]`);
        await writesSettled(page, 1);
        await page.click('[data-kanban-receipt] .act:has-text("Undo")');
        const started = Date.now();
        const timeline: Array<{ ms: number; present: boolean; focused: boolean }> = [];
        while (Date.now() - started < 4_000) {
          timeline.push({ ms: Date.now() - started, ...(await page.evaluate((selector) => ({ present: Boolean(document.querySelector(selector)), focused: document.activeElement === document.querySelector(selector) }), card("t-search"))) });
          await page.waitForTimeout(150);
        }
        await writesSettled(page, 2);
        const gone = timeline.filter((sample) => !sample.present);
        const unfocused = timeline.filter((sample) => sample.ms > 300 && !sample.focused);
        if (gone.length || unfocused.length) failures.push(`delayed poll after Undo: ${JSON.stringify({ gone, unfocused })}`);
        flows.delayedPollUndo = { samples: timeline.length, gone: gone.length, unfocused: unfocused.length, first: timeline[0], last: timeline.at(-1) };
      }, "delayed poll flow");

      await production("light", async (page) => {
        const title = "Restore search results after the index rebuild";
        await page.hover(card("t-search"));
        await page.click(`${card("t-search")} [data-hide]`);
        await writesSettled(page, 1);
        await page.evaluate(() => { (window as unknown as { evidence: Evidence }).evidence.refuseNextTaskPatch = true; });
        await page.click('[data-kanban-receipt] .act:has-text("Undo")');
        const onClick = await columnOf(page, "t-search");
        await page.waitForSelector("[data-kanban-receipt].error", { timeout: 5_000 });
        await page.waitForTimeout(300);
        const refused = { onClick, after: await columnOf(page, "t-search"), receipts: await receipts(page) };
        await page.waitForTimeout(50);
        await shot(page, "production", "flow-undo-refused");
        await page.click(`[data-kanban-receipt].error .act:has-text("Retry")`);
        await writesSettled(page, 3);
        await page.waitForTimeout(300);
        const retried = { column: await columnOf(page, "t-search"), stored: await evidenceOf(page, (evidence) => Boolean(evidence.storedTask("t-search")?.groupHidden)) };
        if (refused.onClick !== "assigned" || refused.after !== null || refused.receipts.includes(`«${title}» is back on the board`) || !refused.receipts.includes(`Couldn't show «${title}»: refused by the evidence fixture`)) failures.push(`refused undo: ${JSON.stringify(refused)}`);
        if (retried.column !== "assigned" || retried.stored) failures.push(`refused undo: retry left ${JSON.stringify(retried)}`);
        flows.refusedUndo = { refused, retried };
      }, "refused undo flow");

      await production("light", async (page) => {
        await page.click('[data-colmenu="done"]');
        await page.click('.menu [role="menuitem"]:has-text("Hide finished")');
        await writesSettled(page, 3);
        const order = await evidenceOf(page, (evidence) => evidence.taskWrites.map((write) => write.id));
        await page.evaluate(() => { (window as unknown as { evidence: Evidence }).evidence.refuseNextTaskPatch = true; });
        await page.click('[data-kanban-receipt] .act:has-text("Undo")');
        await writesSettled(page, 6);
        await page.waitForTimeout(400);
        const titles: Record<string, string> = { "t-interrupt": "Universal interrupt and stop for every engine", "t-voice": "Keep the orchestrator role when voice is enabled", "t-queue": "Preserve native queue recovery through journal compaction" };
        const refusedTitle = titles[order[0]!]!;
        const short = refusedTitle.length > 48 ? `${refusedTitle.slice(0, 46).trimEnd()}…` : refusedTitle;
        const after = {
          receipts: await receipts(page),
          done: await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.column[data-status="done"] .card')].map((node) => node.dataset.id)),
          refusedStillHidden: await evidenceOf(page, (evidence) => Boolean(evidence.storedTask("t-interrupt")?.groupHidden)),
        };
        await shot(page, "production", "flow-bulk-undo-refused");
        const retry = await page.locator(`[data-kanban-receipt].error:has-text("${short}") .act`).textContent().catch(() => null);
        if (!after.receipts.includes(`Couldn't show «${short}»: refused by the evidence fixture`) || retry !== "Retry") failures.push(`bulk undo refusal: ${JSON.stringify({ after, retry })}`);
        if (!after.receipts.includes("2 tasks are back on the board") || after.receipts.some((text) => text.startsWith("3 tasks"))) failures.push(`bulk undo count: ${JSON.stringify(after.receipts)}`);
        if (after.done.length !== 3 || after.done.includes(`task:${order[0]}`)) failures.push(`bulk undo board: ${JSON.stringify(after.done)}`);
        flows.bulkUndoRefused = { order, after, retry };
      }, "bulk undo refusal flow");

      await production("light", async (page) => {
        /* The page reads the seat once per interval: the board and the panel
           above it share one read. */
        await page.evaluate(() => { (window as unknown as { evidence: Evidence }).evidence.seatReads = 0; });
        await page.waitForTimeout(12_500);
        const seat = {
          reads: await evidenceOf(page, (evidence) => evidence.seatReads),
          panel: await page.evaluate(() => Boolean(document.querySelector("[data-kanban-seat] [data-orchestrator-panel]"))),
          lock: await page.evaluate((selector) => Boolean(document.querySelector(`${selector} [data-lock]`)), card("t-seat")),
        };
        if (seat.reads < 1 || seat.reads > 3 || !seat.panel || !seat.lock) failures.push(`seat read: ${JSON.stringify(seat)}`);
        flows.seatRead = seat;
      }, "seat read flow");

      await production("light", async (page) => {
        const active = () => page.evaluate(() => ({ card: document.activeElement?.closest<HTMLElement>(".card")?.dataset.id ?? null, editor: (document.activeElement as HTMLElement | null)?.dataset?.cardEditor ?? null, menu: Boolean(document.activeElement?.closest(".menu")) }));
        await page.locator(card("t-onboarding")).scrollIntoViewIfNeeded();
        await page.focus(card("t-onboarding"));
        await page.keyboard.press("Enter");
        const rename = await active();
        await page.keyboard.press("Escape");
        await page.keyboard.press("e");
        const describe = await active();
        await page.keyboard.press("Escape");
        await page.keyboard.press("c");
        const colour = { ...(await active()), swatches: await page.evaluate(() => document.querySelectorAll('.menu[aria-label="Colour"] .swatch').length) };
        await page.keyboard.press("Escape");
        /* Escape hands focus back to the menu's anchor, the card's ⋯, as in the prototype. */
        const afterMenu = await page.evaluate(() => document.activeElement?.getAttribute("data-menu") ?? null);
        if (afterMenu !== "task:t-onboarding") failures.push(`keys: Escape from the colour menu focused ${afterMenu}`);
        await page.focus(card("t-onboarding"));
        await page.keyboard.press("h");
        const hidden = await columnOf(page, "t-onboarding");
        await page.keyboard.press("u");
        await page.waitForTimeout(100);
        const undone = await columnOf(page, "t-onboarding");
        if (rename.editor !== "title" || describe.editor !== "description" || !colour.menu || colour.swatches !== 9 || hidden !== null || undone !== "inbox") failures.push(`keys: ${JSON.stringify({ rename, describe, colour, hidden, undone })}`);
        flows.keys = { rename, describe, colour, hidden, undone };
      }, "keyboard flow");
    } finally {
      await browser.close();
      server.stop();
    }

    /* The ported geometry, where the prototype was driven. */
    const compare = (label: string, production: number | undefined, prototypeValue: number | undefined, tolerance: number) => {
      if (production === undefined || prototypeValue === undefined) return null;
      const delta = production - prototypeValue;
      if (Math.abs(delta) > tolerance) failures.push(`${label}: production ${production}px, prototype ${prototypeValue}px`);
      return { production, prototype: prototypeValue, delta };
    };
    const pick = (key: string) => frames[key] as { production?: Record<string, unknown>; prototype?: Record<string, unknown> } | undefined;
    const geometry = PROTOTYPE ? {
      swatchWidth: compare("swatch width", (pick("card-menu-light")?.production?.swatchBox as { width: number } | undefined)?.width, (pick("card-menu-light")?.prototype?.swatchBox as { width: number } | undefined)?.width, 2),
      swatchHeight: compare("swatch height", (pick("card-menu-light")?.production?.swatchBox as { height: number } | undefined)?.height, (pick("card-menu-light")?.prototype?.swatchBox as { height: number } | undefined)?.height, 2),
      trayWidth: compare("tray width", pick("hidden-tray-light")?.production?.width as number | undefined, pick("hidden-tray-light")?.prototype?.width as number | undefined, 2),
      titleEditorHeight: compare("title editor height", pick("editing-title")?.production?.height as number | undefined, pick("editing-title")?.prototype?.height as number | undefined, 2),
    } : null;
    if (PROTOTYPE && prototypeNotes.length) failures.push(...prototypeNotes.map((note) => `prototype not driven: ${note}`));
    fs.writeFileSync(path.join(EVIDENCE, "k4b.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), boardWidth: width, frames, geometry, flows, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#1695 K5a pipeline graphs and Past attempts", () => {
  /*
   * Rendered evidence for pipelines on kanban cards (#1695 K5a): the real Viewer
   * over `issue1695Evidence.fixture.tsx?scenario=pipelines`, with the production
   * stylesheet, in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
   * prototype, the same cards are rendered by the prototype at the same board
   * width, saved beside the production frames, and their graph geometry is
   * compared.
   *
   * Gated here:
   *   - every card starts on the compact summary (binding correction 4), the
   *     active four-stage Assigned card included;
   *   - the retry pipeline's graph, once toggled: direction chosen for the width,
   *     node boxes, pass edges solid, the fail edge back to Implement dashed in
   *     its lane with "fail · retry 1 of 2" although a helper conversation was
   *     adopted last, Review's round chip, Verify running;
   *   - a two-stage pipeline fits left to right;
   *   - five review rounds keep their chips inside the node, on one line;
   *   - Past attempts lists every finished attempt (a failed latest one too)
   *     and settled round, leaves out the running attempt, and lists the helper
   *     conversation as such;
   *   - a node opens its stage's own latest conversation and is marked;
   *   - an adopted helper marks no edge; a new attempt through the fail edge
   *     does, and the mark clears on time through a later change.
   *
   * Measurements go to `evidence/issue-1695/k5a.json`; frames to
   * `.artifacts/issue-1695/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1695");
  const EVIDENCE = path.resolve("evidence/issue-1695");
  /* Wide enough that the Assigned column fits a two-stage graph left to right. */
  const WIDE = { width: 1680, height: 950 } as const;

  interface GraphMeasure {
    dir: string | null;
    nodes: Array<{ stage: string; width: number; height: number; state: string; detail: string }>;
    edges: Array<{ edge: string; classes: string; dashed: boolean }>;
    labels: string[];
  }

  /** The graph of one card, read the same way from either page. */
  const measureGraph = (page: Page, cardSelector: string) => page.evaluate((selector): GraphMeasure | null => {
    const card = document.querySelector(selector);
    const graph = card?.querySelector<HTMLElement>(".pgraph");
    if (!graph) return null;
    return {
      dir: graph.dataset.dir ?? null,
      nodes: [...graph.querySelectorAll<HTMLElement>(".pnode")].map((node) => {
        const box = node.getBoundingClientRect();
        return {
          stage: node.dataset.stage ?? "",
          width: Math.round(box.width),
          height: Math.round(box.height),
          state: node.querySelector(".pstate")?.textContent?.trim() ?? "",
          detail: [...node.querySelectorAll(".pdetail, .rchip")].map((part) => part.textContent?.trim()).join(" "),
        };
      }),
      edges: [...graph.querySelectorAll<SVGPathElement>(".pedge")].map((edge) => ({
        edge: edge.dataset.edge ?? "",
        classes: edge.getAttribute("class") ?? "",
        dashed: getComputedStyle(edge).strokeDasharray !== "none",
      })),
      labels: [...graph.querySelectorAll(".pelabel")].map((label) => label.textContent?.trim() ?? ""),
    };
  }, cardSelector);

  const protoCard = (id: string) => `#app .card[data-id="${id}"]`;

  async function boardReady(page: Page) {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(700);
  }

  browserTest("#1695 K5a: pipeline graphs, summaries and Past attempts on kanban cards, against the prototype", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=pipelines`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, unknown> = {};
    const flows: Record<string, unknown> = {};
    const notes: string[] = [];
    let boardWidth = 0;

    const widths: Record<string, number> = {};
    const production = async (scheme: Scheme, label: string, run: (page: Page) => Promise<void>, viewport: { width: number; height: number } = VIEWPORT) => {
      const opened = await openFixture(browser, base, viewport, scheme);
      try {
        await boardReady(opened.page);
        widths[viewport.width] ??= await opened.page.evaluate(() => Math.round(document.querySelector("[data-kanban-board]")!.getBoundingClientRect().width));
        if (!boardWidth) boardWidth = await opened.page.evaluate(() => Math.round(document.querySelector("[data-kanban-board]")!.getBoundingClientRect().width));
        await run(opened.page);
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    const prototype = async (query: string, scheme: Scheme, label: string, run: (page: Page) => Promise<void>, viewport: { width: number; height: number } = VIEWPORT) => {
      if (!PROTOTYPE) return;
      const opened = await openFixture(browser, `${PROTOTYPE}/?${query}`, { width: widths[viewport.width] ?? viewport.width, height: viewport.height }, scheme);
      try {
        await opened.page.waitForSelector("#app[data-ready] .board", { timeout: 20_000 });
        await opened.page.waitForTimeout(600);
        await run(opened.page);
      } catch (error) {
        notes.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    const shot = (page: Page, side: string, id: string, scheme: Scheme) => page.screenshot({ path: path.join(OUT, `${side}-k5a-${id}-${scheme}.png`) });

    const openGraph = async (page: Page, id: string) => {
      const section = `${card(id)} .stage-section`;
      await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "start" }));
      if (await page.evaluate((selector) => document.querySelector(`${selector} [data-graph-toggle]`)?.getAttribute("aria-pressed") !== "true", section)) {
        await page.click(`${section} [data-graph-toggle]`);
      }
      await page.waitForSelector(`${section} .pnode`, { timeout: 5_000 });
      await page.waitForTimeout(250);
    };

    try {
      for (const scheme of ["light", "dark"] as const) {
        await production(scheme, `retry graph ${scheme}`, async (page) => {
          /* Binding correction 4: every card starts on the compact summary. */
          await page.locator(`${card("t-search")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(300);
          const fresh = await page.evaluate((selector) => ({
            compact: document.querySelector(`${selector} .stage-section`)?.classList.contains("compact") ?? null,
            nodes: document.querySelectorAll(`${selector} .pnode`).length,
            pressed: document.querySelector(`${selector} [data-graph-toggle]`)?.getAttribute("aria-pressed") ?? null,
            chips: document.querySelectorAll(`${selector} .psummary .pchip`).length,
          }), card("t-search"));
          await shot(page, "production", "summary-default", scheme);
          if (!fresh.compact || fresh.nodes !== 0 || fresh.pressed !== "false" || fresh.chips !== 4) failures.push(`retry card default ${scheme}: ${JSON.stringify(fresh)}`);
          frames[`summary-default-${scheme}`] = { production: fresh };
          await openGraph(page, "t-search");
          const graph = await measureGraph(page, card("t-search"));
          await shot(page, "production", "graph-branch-retry", scheme);
          frames[`graph-branch-retry-${scheme}`] = { production: graph };
          if (!graph) {
            failures.push(`retry graph ${scheme}: the toggle opened no graph`);
            return;
          }
          const byStage = new Map(graph.nodes.map((node) => [node.stage, node] as const));
          if (graph.nodes.map((node) => node.stage).join() !== "implement,review,verify,merge") failures.push(`retry graph ${scheme}: nodes ${JSON.stringify(graph.nodes)}`);
          if (graph.nodes.some((node) => node.height !== 76)) failures.push(`retry graph ${scheme}: node heights ${graph.nodes.map((node) => node.height)}`);
          if (byStage.get("verify")?.state !== "running" || byStage.get("merge")?.state !== "waiting") failures.push(`retry graph ${scheme}: states ${JSON.stringify(graph.nodes)}`);
          if (byStage.get("review")?.detail !== "R1 ✓") failures.push(`retry graph ${scheme}: review rounds ${byStage.get("review")?.detail}`);
          /* A helper conversation is adopted last on Implement: neither the attempt count nor the budget moves. */
          if (byStage.get("implement")?.detail !== "attempt 2") failures.push(`retry graph ${scheme}: implement detail ${byStage.get("implement")?.detail}`);
          const fail = graph.edges.find((edge) => edge.edge === "verify:fail:implement");
          if (!fail?.dashed || !/\bback\b/.test(fail.classes) || !/\btaken\b/.test(fail.classes)) failures.push(`retry graph ${scheme}: fail edge ${JSON.stringify(fail)}`);
          if (graph.edges.filter((edge) => !edge.dashed).length !== 3) failures.push(`retry graph ${scheme}: pass edges ${JSON.stringify(graph.edges)}`);
          if (!graph.labels.includes("fail · retry 1 of 2")) failures.push(`retry graph ${scheme}: labels ${JSON.stringify(graph.labels)}`);
        });
        await prototype("scrollto=t-search", scheme, `prototype retry graph ${scheme}`, async (page) => {
          await page.locator(`${protoCard("t-search")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(300);
          const graph = await measureGraph(page, protoCard("t-search"));
          await shot(page, "prototype", "graph-branch-retry", scheme);
          Object.assign(frames[`graph-branch-retry-${scheme}`] as object ?? {}, { prototype: graph });
        });
      }

      await production("light", "two-stage graph", async (page) => {
        await openGraph(page, "t-links");
        await page.locator(`${card("t-links")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(250);
        const graph = await measureGraph(page, card("t-links"));
        await shot(page, "production", "graph-two-stage", "light");
        frames["graph-two-stage"] = { production: graph };
        if (graph?.dir !== "LR" || graph.nodes.some((node) => node.width !== 176 || node.height !== 76)) failures.push(`two-stage graph: ${JSON.stringify(graph)}`);
      }, WIDE);
      await prototype("scrollto=t-links", "light", "prototype two-stage graph", async (page) => {
        await page.locator(`${protoCard("t-links")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(300);
        Object.assign(frames["graph-two-stage"] as object, { prototype: await measureGraph(page, protoCard("t-links")) });
        await shot(page, "prototype", "graph-two-stage", "light");
      }, WIDE);

      await production("light", "five review rounds", async (page) => {
        await openGraph(page, "t-rounds");
        await page.locator(`${card("t-rounds")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(250);
        const review = await page.evaluate((selector) => {
          const node = document.querySelector<HTMLElement>(`${selector} .pnode[data-stage="review"]`);
          if (!node) return null;
          const box = node.getBoundingClientRect();
          const chips = [...node.querySelectorAll<HTMLElement>(".rchip")].map((chip) => {
            const rect = chip.getBoundingClientRect();
            return { text: chip.textContent?.trim(), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
          });
          return { dir: node.closest<HTMLElement>(".pgraph")?.dataset.dir ?? null, right: Math.round(box.right), bottom: Math.round(box.bottom), chips };
        }, card("t-rounds"));
        await shot(page, "production", "five-rounds", "light");
        frames["five-rounds"] = { production: review };
        const inside = review && review.chips.every((chip) => chip.right <= review.right - 1 && chip.bottom <= review.bottom);
        const oneLine = review && new Set(review.chips.map((chip) => chip.top)).size === 1;
        if (!review || review.dir !== "LR" || JSON.stringify(review.chips.map((chip) => chip.text)) !== JSON.stringify(["+4", "R5 ✓"]) || !inside || !oneLine) failures.push(`five rounds: ${JSON.stringify(review)}`);
      }, WIDE);

      await production("light", "past attempts and helpers", async (page) => {
        const limits = await page.evaluate((selector) => [...document.querySelectorAll(`${selector} details.history [data-past-kind]`)].map((row) => ({
          kind: (row as HTMLElement).dataset.pastKind, label: row.querySelector(".lbl")?.textContent, verdict: row.querySelector(".verdict")?.textContent,
        })), card("t-limits"));
        frames["failed-latest"] = { production: limits };
        if (!limits.some((row) => row.kind === "attempt" && row.label === "Builder · attempt 1" && row.verdict === "failed")) failures.push(`failed latest attempt missing from Past attempts: ${JSON.stringify(limits)}`);

        await page.locator(`${card("t-search")} details.history`).evaluate((element) => { (element as HTMLDetailsElement).open = true; element.scrollIntoView({ block: "center" }); });
        await page.waitForTimeout(300);
        const past = await page.evaluate((selector) => [...document.querySelectorAll(`${selector} details.history [data-past-kind]`)].map((row) => ({
          kind: (row as HTMLElement).dataset.pastKind, label: row.querySelector(".lbl")?.textContent, verdict: row.querySelector(".verdict")?.textContent, open: Boolean(row.querySelector(".hopen")),
        })), card("t-search"));
        await shot(page, "production", "history-open", "light");
        frames["history-open"] = { production: past };
        const labels = past.map((row) => row.label).sort();
        const expected = ["Builder · attempt 1", "Builder · attempt 2", "Builder · helper conversation 1", "Reviewer · attempt 1", "Reviewer · round 1", "Verifier · attempt 1"];
        if (JSON.stringify(labels) !== JSON.stringify(expected) || !past.every((row) => row.open)) failures.push(`past attempts: ${JSON.stringify(past)}`);
        if (past.some((row) => row.label === "Verifier · attempt 2")) failures.push("past attempts: the running Verify attempt is listed");
        await page.click(`${card("t-search")} details.history [data-past-kind="helper"] .hopen`);
        await page.waitForSelector(`${card("t-search")} [data-kanban-reader]`, { timeout: 10_000 });
        const opened = await page.evaluate((selector) => document.querySelector<HTMLElement>(`${selector} [data-kanban-reader]`)?.dataset.kanbanReader ?? null, card("t-search"));
        if (opened !== "conversation_search-helper") failures.push(`helper row opened ${opened}`);
        flows.helperOpen = opened;
      });
      await prototype("history=open&scrollto=t-search", "light", "prototype history", async (page) => {
        await page.locator(`${protoCard("t-search")} details.history`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(300);
        await shot(page, "prototype", "history-open", "light");
      });

      await production("light", "toggle and node", async (page) => {
        const section = `${card("t-search")} .stage-section`;
        await openGraph(page, "t-search");
        await page.click(`${section} .pnode[data-stage="implement"]`);
        await page.waitForSelector(`${card("t-search")} [data-kanban-reader]`, { timeout: 10_000 });
        await page.waitForTimeout(300);
        const node = await page.evaluate((selector) => ({
          pressed: document.querySelector(`${selector} .pnode[data-stage="implement"]`)?.getAttribute("aria-pressed"),
          reader: document.querySelector<HTMLElement>(`${selector.replace(" .stage-section", "")} [data-kanban-reader]`)?.dataset.kanbanReader ?? null,
        }), section);
        await shot(page, "production", "node-reader", "light");
        await page.click(`${section} [data-graph-toggle]`);
        const summary = await page.evaluate((selector) => ({ nodes: document.querySelectorAll(`${selector} .pnode`).length, chips: document.querySelectorAll(`${selector} .pchip`).length }), section);
        /* The historical helper was adopted last; the node opens and marks Implement's own latest attempt. */
        if (node.pressed !== "true" || node.reader !== "conversation_search-impl-2") failures.push(`node: ${JSON.stringify(node)}`);
        if (summary.nodes !== 0 || summary.chips !== 4) failures.push(`toggle back: ${JSON.stringify(summary)}`);
        flows.toggleAndNode = { node, summary };
      });

      await production("light", "live edge", async (page) => {
        type Hook = { evidence: { addStageAttempt: (pipelineId: string, stageId: string, over: Record<string, unknown>) => void } };
        const section = `${card("t-search")} .stage-section`;
        await openGraph(page, "t-search");
        const before = await page.evaluate((selector) => document.querySelectorAll(`${selector} .pedge.live`).length, section);
        /* A helper adopted with the fail edge's provenance copied: nothing travelled that edge. */
        await page.evaluate(() => (window as unknown as Hook).evidence.addStageAttempt("p-search", "implement", { historical: true, state: "passed", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }));
        await page.waitForTimeout(1_500);
        const afterHelper = await page.evaluate((selector) => document.querySelectorAll(`${selector} .pedge.live`).length, section);
        await page.evaluate(() => (window as unknown as Hook).evidence.addStageAttempt("p-search", "implement", { activatedBy: { stageId: "verify", attempt: 2, edge: "fail" } }));
        await page.waitForSelector(`${section} .pedge.live[data-edge="verify:fail:implement"]`, { timeout: 10_000 });
        const markedAt = Date.now();
        const label = await page.evaluate((selector) => document.querySelector(`${selector} .pelabel.live`)?.textContent ?? null, section);
        await shot(page, "production", "live-edge", "light");
        /* Another change inside the window: an attempt of the stage's own that no edge activated. */
        await page.waitForTimeout(400);
        await page.evaluate(() => (window as unknown as Hook).evidence.addStageAttempt("p-search", "review", {}));
        await page.waitForFunction((selector) => document.querySelector(`${selector} .pnode[data-stage="review"] .pdetail`)?.textContent === "attempt 2", section, { timeout: 5_000 });
        await page.waitForFunction((selector) => !document.querySelector(`${selector} .pedge.live`), section, { timeout: 6_000 });
        const clearedAfterMs = Date.now() - markedAt;
        if (before !== 0 || afterHelper !== 0 || label !== "fail · retry 2 of 2") failures.push(`live edge: ${JSON.stringify({ before, afterHelper, label })}`);
        if (clearedAfterMs > 3_400) failures.push(`live edge: cleared ${clearedAfterMs} ms after it was marked`);
        flows.liveEdge = { before, afterHelper, label, clearedAfterMs };
      });
    } finally {
      await browser.close();
      server.stop();
    }

    const compare = (key: string) => {
      const frame = frames[key] as { production?: GraphMeasure | null; prototype?: GraphMeasure | null } | undefined;
      if (!frame?.production || !frame.prototype) return null;
      return {
        dir: { production: frame.production.dir, prototype: frame.prototype.dir },
        nodeHeights: { production: frame.production.nodes.map((node) => node.height), prototype: frame.prototype.nodes.map((node) => node.height) },
        nodeWidths: { production: frame.production.nodes.map((node) => node.width), prototype: frame.prototype.nodes.map((node) => node.width) },
        edges: { production: frame.production.edges.length, prototype: frame.prototype.edges.length },
        labels: { production: frame.production.labels, prototype: frame.prototype.labels },
      };
    };
    const geometry = PROTOTYPE ? { retryLight: compare("graph-branch-retry-light"), retryDark: compare("graph-branch-retry-dark"), twoStage: compare("graph-two-stage") } : null;
    for (const [key, value] of Object.entries(geometry ?? {})) {
      if (!value) {
        failures.push(`${key}: the prototype frame was not measured`);
        continue;
      }
      if (value.dir.production !== value.dir.prototype) failures.push(`${key}: direction ${value.dir.production}, prototype ${value.dir.prototype}`);
      if (value.edges.production !== value.edges.prototype) failures.push(`${key}: ${value.edges.production} edges, prototype ${value.edges.prototype}`);
      if (JSON.stringify(value.nodeHeights.production) !== JSON.stringify(value.nodeHeights.prototype)) failures.push(`${key}: node heights ${value.nodeHeights.production}, prototype ${value.nodeHeights.prototype}`);
      const widthDelta = Math.max(0, ...value.nodeWidths.production.map((width, index) => Math.abs(width - (value.nodeWidths.prototype[index] ?? width))));
      if (widthDelta > 2) failures.push(`${key}: node widths ${value.nodeWidths.production}, prototype ${value.nodeWidths.prototype}`);
    }
    if (PROTOTYPE && notes.length) failures.push(...notes.map((note) => `prototype not driven: ${note}`));
    fs.writeFileSync(path.join(EVIDENCE, "k5a.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), boardWidth, boardWidths: widths, frames, geometry, flows, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#1695 K5b the Stages sheet and pipeline actions", () => {
  /*
   * Rendered evidence for Stages on the kanban board (#1695 K5b): the real
   * Viewer over `issue1695Evidence.fixture.tsx?scenario=stages`, with the
   * production stylesheet, in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
   * prototype, the prototype's `sheet=t-upload`, `sheet=t-search:implement` and
   * `stage=t-links:review` frames are rendered, the sheet at the same window
   * width and the card panel at the same board width, saved beside the
   * production frames, and compared.
   *
   * Gated here:
   *   - the eight-stage sheet: header, navigator, graph direction, one pane per
   *     stage at the prototype's pane width, four waiting stages each with an
   *     undelivered first message and a closed composer, the live stage focused;
   *   - the retry sheet: attempt tabs on Implement and Verify, the loop chip;
   *   - a waiting node on a card opens its first message; Save sends the
   *     stage's wiring token with the words and the digest the read returned; a
   *     stage another client saves between that read and the write is refused by
   *     the route's guard and not overwritten; a stage that starts during the
   *     save keeps the words, marked not delivered, and becomes the reader when
   *     let go; words saved elsewhere stop the save until Keep mine;
   *   - one folded "Added when it starts" line under each waiting stage's first
   *     message, in the card panel and every waiting pane, unfolding to what
   *     `renderStagePrompt` adds (binding correction 2);
   *   - Pause and Resume over the pipeline route with the pending chip, the
   *     receipt, and a refusal with Retry; a lost answer reported as not
   *     confirmed with a Check again that only reads; a refused skip whose
   *     Retry carries the same expected stage and attempt, which the route's
   *     guard refuses once the pipeline waits on another stage;
   *   - the reader open on a card is the same mounted conversation in its pane
   *     and back, composer text included; the board's "/" stays behind the
   *     open sheet; Escape returns focus to Stages; arrow keys step the lane.
   *
   * Measurements go to `evidence/issue-1695/k5b.json`; frames to
   * `.artifacts/issue-1695/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1695");
  const EVIDENCE = path.resolve("evidence/issue-1695");

  interface SheetMeasure {
    title: string;
    progress: string;
    navChips: number;
    loops: string[];
    graphDir: string | null;
    graphNodes: number;
    lanePos: string;
    focusedPane: string | null;
    panes: Array<{ stage: string; width: number; folded: boolean; attempts: string[]; draft: boolean; status: string | null; composerDisabled: boolean | null; reader: boolean; added: string | null }>;
  }

  /** The sheet, read the same way from either page. */
  const measureSheet = (page: Page) => page.evaluate((): SheetMeasure | null => {
    const sheet = document.querySelector<HTMLElement>(".gsheet");
    if (!sheet) return null;
    const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return {
      title: text(sheet.querySelector("header h2")),
      progress: text(sheet.querySelector("header .progress")),
      navChips: sheet.querySelectorAll(".navchip").length,
      loops: [...sheet.querySelectorAll(".gs-nav .ploop")].map(text),
      graphDir: sheet.querySelector<HTMLElement>(".gs-graph .pgraph")?.dataset.dir ?? null,
      graphNodes: sheet.querySelectorAll(".gs-graph .pnode").length,
      lanePos: text(sheet.querySelector(".lane-bar .pos")),
      focusedPane: (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".pane[data-stage]")?.dataset.stage ?? null,
      panes: [...sheet.querySelectorAll<HTMLElement>(".pane[data-stage]")].map((pane) => ({
        stage: pane.dataset.stage ?? "",
        width: Math.round(pane.getBoundingClientRect().width),
        folded: pane.classList.contains("folded"),
        attempts: [...pane.querySelectorAll(".attempts button")].map(text),
        draft: Boolean(pane.querySelector(".msg.user.draft")),
        status: pane.querySelector(".bstatus") ? text(pane.querySelector(".bstatus")) : null,
        composerDisabled: pane.querySelector<HTMLTextAreaElement>(".pane-conv.draft textarea") ? Boolean(pane.querySelector<HTMLTextAreaElement>(".pane-conv.draft textarea")?.disabled) : null,
        reader: Boolean(pane.querySelector("[data-kanban-reader], .feed")),
        added: pane.querySelector("[data-draft-added] summary") ? text(pane.querySelector("[data-draft-added] summary")) : null,
      })),
    };
  });

  /** A waiting stage's panel on a card, read the same way from either page. */
  const measureDetail = (page: Page, selector: string) => page.evaluate((root) => {
    const panel = document.querySelector<HTMLElement>(root);
    if (!panel) return null;
    const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return {
      bubble: text(panel.querySelector(".msg.user.draft .btext")),
      status: text(panel.querySelector(".bstatus")),
      edit: Boolean(panel.querySelector(".bedit")),
      event: text(panel.querySelector(".msg.event")),
      engine: text(panel.querySelector(".ch-engine")),
      composerDisabled: Boolean(panel.querySelector<HTMLTextAreaElement>(".composer2 textarea")?.disabled),
      added: panel.querySelector("[data-draft-added] summary") ? text(panel.querySelector("[data-draft-added] summary")) : null,
      width: Math.round(panel.getBoundingClientRect().width),
    };
  }, selector);

  type Hook = { evidence: {
    pipelinePatches: Array<{ id: string; body: Record<string, unknown> }>;
    pipelineReads: string[];
    refuseNextPipelinePatch: { status: number; error: string } | null;
    startStageOnNextPatch: { pipelineId: string; stageId: string } | null;
    writeStagePromptQuietly: (pipelineId: string, stageId: string, prompt: string) => void;
    loseNextPipelineAnswer: boolean;
    moveCursor: (pipelineId: string, stageId: string) => void;
    changeStageBeforeNextPatch: { pipelineId: string; stageId: string; prompt: string } | null;
    storedPipeline: (id: string) => { stages: Array<{ id: string; prompt: string }> } | null;
  } };

  async function boardReady(page: Page) {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(700);
  }

  browserTest("#1695 K5b: the Stages sheet, waiting stages' first messages and pipeline actions, against the prototype", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=stages`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, { production?: unknown; prototype?: unknown }> = {};
    const flows: Record<string, unknown> = {};
    const notes: string[] = [];
    let boardWidth = 0;

    const production = async (scheme: Scheme, label: string, run: (page: Page) => Promise<void>) => {
      const opened = await openFixture(browser, base, VIEWPORT, scheme);
      try {
        await boardReady(opened.page);
        if (!boardWidth) boardWidth = await opened.page.evaluate(() => Math.round(document.querySelector("[data-kanban-board]")!.getBoundingClientRect().width));
        await run(opened.page);
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    /* The sheet covers the window, so it is compared at the window's width; a
       card's panel at the board's, as the prototype has no Viewer around it. */
    const prototype = async (query: string, scheme: Scheme, label: string, run: (page: Page) => Promise<void>, width: "window" | "board" = "window") => {
      if (!PROTOTYPE) return;
      const opened = await openFixture(browser, `${PROTOTYPE}/?${query}`, { width: width === "board" && boardWidth ? boardWidth : VIEWPORT.width, height: VIEWPORT.height }, scheme);
      try {
        await opened.page.waitForSelector("#app[data-ready] .board", { timeout: 20_000 });
        await opened.page.waitForTimeout(700);
        await run(opened.page);
      } catch (error) {
        notes.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    const shot = (page: Page, side: string, id: string, scheme: Scheme) => page.screenshot({ path: path.join(OUT, `${side}-k5b-${id}-${scheme}.png`) });
    const openStages = async (page: Page, taskId: string) => {
      await page.locator(`${card(taskId)} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.click(`${card(taskId)} [data-open-stages]`);
      await page.waitForSelector(".gsheet .pane[data-stage]", { timeout: 10_000 });
      await page.waitForTimeout(500);
    };
    const clickText = (page: Page, scope: string, textValue: string) => page.locator(scope, { hasText: textValue }).first().click();

    try {
      for (const scheme of ["light", "dark"] as const) {
        await production(scheme, `stages ${scheme}`, async (page) => {
          await openStages(page, "t-upload");
          const sheet = await measureSheet(page);
          await shot(page, "production", "stages", scheme);
          frames[`stages-${scheme}`] = { production: sheet };
          if (!sheet) {
            failures.push(`stages ${scheme}: the sheet did not open`);
            return;
          }
          if (sheet.panes.length !== 8 || sheet.navChips !== 8) failures.push(`stages ${scheme}: ${sheet.panes.length} panes, ${sheet.navChips} chips`);
          if (sheet.graphDir !== "LR" || sheet.graphNodes !== 8) failures.push(`stages ${scheme}: graph ${sheet.graphDir} ${sheet.graphNodes}`);
          const waiting = sheet.panes.filter((pane) => pane.draft);
          if (waiting.map((pane) => pane.stage).join() !== "review-ui,verify,docs,merge") failures.push(`stages ${scheme}: waiting panes ${JSON.stringify(waiting)}`);
          if (waiting.some((pane) => pane.status !== "Waiting for stage start · not delivered" || pane.composerDisabled !== true)) failures.push(`stages ${scheme}: waiting panes ${JSON.stringify(waiting)}`);
          if (waiting.some((pane) => !pane.added?.startsWith("Added when it starts: previous stage output · pinned task · spec · "))) failures.push(`stages ${scheme}: added-at-start lines ${JSON.stringify(waiting.map((pane) => pane.added))}`);
          if (sheet.panes.filter((pane) => !pane.draft).some((pane) => !pane.reader)) failures.push(`stages ${scheme}: a started pane holds no conversation ${JSON.stringify(sheet.panes)}`);
          if (sheet.focusedPane !== "build-ui") failures.push(`stages ${scheme}: focus on ${sheet.focusedPane}`);
          if (!sheet.progress.startsWith("8 stages · ")) failures.push(`stages ${scheme}: progress ${sheet.progress}`);
        });
        await prototype("sheet=t-upload", scheme, `prototype stages ${scheme}`, async (page) => {
          await page.waitForSelector(".gsheet .pane[data-stage]", { timeout: 10_000 });
          await page.waitForTimeout(500);
          frames[`stages-${scheme}`] = { ...frames[`stages-${scheme}`], prototype: await measureSheet(page) };
          await shot(page, "prototype", "stages", scheme);
        });
      }

      await production("light", "stages retry", async (page) => {
        await openStages(page, "t-search");
        await page.click('.gsheet [data-nav-stage="implement"]');
        await page.waitForTimeout(700);
        const sheet = await measureSheet(page);
        await shot(page, "production", "stages-retry", "light");
        frames["stages-retry"] = { production: sheet };
        const byStage = new Map(sheet?.panes.map((pane) => [pane.stage, pane] as const));
        if (JSON.stringify(byStage.get("implement")?.attempts) !== JSON.stringify(["#1 · passed", "#2 · passed"])) failures.push(`stages retry: implement tabs ${JSON.stringify(byStage.get("implement")?.attempts)}`);
        if (JSON.stringify(byStage.get("verify")?.attempts) !== JSON.stringify(["#1 · failed", "#2 · running"])) failures.push(`stages retry: verify tabs ${JSON.stringify(byStage.get("verify")?.attempts)}`);
        if (sheet?.loops.length !== 1 || !sheet.loops[0]!.endsWith("· 1/2")) failures.push(`stages retry: loops ${JSON.stringify(sheet?.loops)}`);
        if (sheet?.lanePos !== "Stage 1 of 4") failures.push(`stages retry: lane position ${sheet?.lanePos}`);
      });
      await prototype("sheet=t-search:implement", "light", "prototype stages retry", async (page) => {
        await page.waitForSelector(".gsheet .pane[data-stage]", { timeout: 10_000 });
        await page.waitForTimeout(500);
        frames["stages-retry"] = { ...frames["stages-retry"], prototype: await measureSheet(page) };
        await shot(page, "prototype", "stages-retry", "light");
      });

      await production("light", "stage details and save", async (page) => {
        const section = `${card("t-links")} .stage-section`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .psummary [data-stage="review"]`);
        const panel = `${card("t-links")} [data-stage-detail]`;
        await page.waitForSelector(panel, { timeout: 5_000 });
        await page.locator(panel).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(400);
        const detail = await measureDetail(page, panel);
        await shot(page, "production", "stage-details", "light");
        frames["stage-details"] = { production: detail };
        if (detail?.bubble !== "Check both anchors against the published notes before approving." || detail.status !== "Waiting for stage start · not delivered" || !detail.edit || !detail.composerDisabled) failures.push(`stage details: ${JSON.stringify(detail)}`);
        if (detail?.event !== "Starts when Builder passes · last stage") failures.push(`stage details event: ${detail?.event}`);
        if (detail?.added !== "Added when it starts: previous stage output · pinned task · spec · role preset · access rules · verdict contract") failures.push(`stage details added line: ${detail?.added}`);
        await page.click(`${panel} [data-draft-added] summary`);
        await page.waitForTimeout(250);
        const added = await page.evaluate((selector) => {
          const details = document.querySelector<HTMLDetailsElement>(`${selector} [data-draft-added]`);
          const pre = details?.querySelector<HTMLElement>(".added-text");
          return { open: details?.open ?? false, text: pre?.textContent ?? "", height: Math.round(pre?.getBoundingClientRect().height ?? 0) };
        }, panel);
        await shot(page, "production", "stage-details-added", "light");
        flows.addedAtStart = { summary: detail?.added, open: added.open, height: added.height, head: added.text.split("\n").slice(0, 3) };
        if (!added.open || !added.text.startsWith("[previous stage output: not produced yet]\n\nPinned task:\nRepair old links in the release notes") || !added.text.includes("Finish the completed turn with one fenced JSON object")) failures.push(`added at start: ${JSON.stringify(added).slice(0, 400)}`);
        await page.click(`${panel} [data-draft-added] summary`);

        await page.click(`${panel} [data-draft-edit]`);
        await page.waitForSelector(`${panel} textarea.draft-edit`);
        const focused = await page.evaluate(() => document.activeElement?.classList.contains("draft-edit") ?? false);
        await page.fill(`${panel} textarea.draft-edit`, "Check both anchors against the published notes, then the changelog.");
        await page.waitForTimeout(250);
        await shot(page, "production", "flow-stage-draft-editing", "light");
        await page.keyboard.press("Control+Enter");
        await page.waitForFunction((selector) => !document.querySelector(`${selector} textarea.draft-edit`), panel, { timeout: 5_000 });
        await page.waitForTimeout(300);
        const saved = await page.evaluate(() => (window as unknown as Hook).evidence.pipelinePatches.at(-1) ?? null);
        const status = await page.locator(`${panel} .bstatus`).textContent();
        await shot(page, "production", "flow-stage-draft", "light");
        flows.saveDraft = { focused, saved, status };
        if (!focused) failures.push("stage draft: Edit did not focus the field");
        const digest = (saved?.body as { expectedStageDigest?: unknown } | undefined)?.expectedStageDigest;
        if (JSON.stringify({ ...saved, body: { ...saved?.body, expectedStageDigest: "<digest>" } }) !== JSON.stringify({ id: "p-links", body: { action: "override-stage", stageId: "review", prompt: "{{prev.output}}\n\nCheck both anchors against the published notes, then the changelog.", expectedStageDigest: "<digest>" } }) || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) failures.push(`stage draft save: ${JSON.stringify(saved)}`);
        if (!/^Waiting for stage start · not delivered · edited \d/.test(status ?? "")) failures.push(`stage draft status: ${status}`);
      });
      await prototype("stage=t-links:review", "light", "prototype stage details", async (page) => {
        const panel = '[data-stage-detail="t-links|review"]';
        await page.waitForSelector(panel, { timeout: 10_000 });
        await page.waitForTimeout(400);
        frames["stage-details"] = { ...frames["stage-details"], prototype: await measureDetail(page, panel) };
        await shot(page, "prototype", "stage-details", "light");
      }, "board");

      await production("light", "stage started during save", async (page) => {
        const section = `${card("t-links")} .stage-section`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .psummary [data-stage="review"]`);
        const panel = `${card("t-links")} [data-stage-detail]`;
        await page.waitForSelector(panel);
        await page.click(`${panel} [data-draft-edit]`);
        await page.fill(`${panel} textarea.draft-edit`, "Too late for this one.");
        await page.evaluate(() => { (window as unknown as Hook).evidence.startStageOnNextPatch = { pipelineId: "p-links", stageId: "review" }; });
        await page.click(`${panel} [data-draft-save]`);
        await page.waitForSelector(`${panel} [data-draft-undelivered]`, { timeout: 5_000 });
        await page.locator(panel).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(1_200);
        const notice = await page.evaluate((selector) => ({
          message: document.querySelector(`${selector} [data-draft-undelivered] .msg-text`)?.textContent ?? null,
          kept: document.querySelector(`${selector} [data-draft-undelivered] .kept`)?.textContent ?? null,
          receipts: [...document.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent),
        }), panel);
        await shot(page, "production", "flow-stage-started", "light");
        await clickText(page, `${panel} [data-draft-undelivered] button`, "Discard");
        await page.waitForSelector(`${card("t-links")} [data-kanban-reader="conversation_links-review"]`, { timeout: 10_000 });
        await page.waitForTimeout(400);
        const promoted = await page.evaluate((selector) => ({
          panel: Boolean(document.querySelector(`${selector} [data-stage-detail]`)),
          reader: document.querySelector<HTMLElement>(`${selector} [data-kanban-reader]`)?.dataset.kanbanReader ?? null,
        }), card("t-links"));
        await shot(page, "production", "flow-stage-reader", "light");
        flows.startedDuringSave = { notice, promoted };
        if (notice.message !== "Reviewer started with its previous first message. Your edit was not delivered." || notice.kept !== "Too late for this one." || notice.receipts.length) failures.push(`started during save: ${JSON.stringify(notice)}`);
        if (promoted.panel || promoted.reader !== "conversation_links-review") failures.push(`started during save, promoted: ${JSON.stringify(promoted)}`);
      });

      await production("light", "changed between read and write", async (page) => {
        const section = `${card("t-links")} .stage-section`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .psummary [data-stage="review"]`);
        const panel = `${card("t-links")} [data-stage-detail]`;
        await page.waitForSelector(panel);
        await page.click(`${panel} [data-draft-edit]`);
        await page.fill(`${panel} textarea.draft-edit`, "Mine, typed before the other save landed.");
        const theirs = "{{prev.output}}\n\nTheirs, saved between the read and the write.";
        await page.evaluate((prompt) => { (window as unknown as Hook).evidence.changeStageBeforeNextPatch = { pipelineId: "p-links", stageId: "review", prompt }; }, theirs);
        await page.click(`${panel} [data-draft-save]`);
        await page.waitForSelector(`${panel} [data-draft-changed]`, { timeout: 5_000 });
        await page.locator(panel).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(300);
        const outcome = await page.evaluate((selector) => {
          const hook = (window as unknown as Hook).evidence;
          return {
            notice: document.querySelector(`${selector} [data-draft-changed] .msg-text`)?.textContent ?? null,
            field: document.querySelector<HTMLTextAreaElement>(`${selector} textarea.draft-edit`)?.value ?? null,
            writes: hook.pipelinePatches.map((patch) => patch.body),
            reads: hook.pipelineReads.length,
            stored: hook.storedPipeline("p-links")?.stages.find((entry) => entry.id === "review")?.prompt ?? null,
          };
        }, panel);
        await shot(page, "production", "flow-stage-guard-refused", "light");
        flows.changedBetweenReadAndWrite = outcome;
        if (outcome.notice !== "Changed elsewhere since you began: «Theirs, saved between the read and the write.»" || outcome.field !== "Mine, typed before the other save landed.") failures.push(`guarded save: ${JSON.stringify(outcome)}`);
        if (outcome.writes.length !== 1 || outcome.reads !== 2 || outcome.stored !== theirs) failures.push(`guarded save requests: ${JSON.stringify(outcome)}`);
      });

      await production("light", "changed elsewhere", async (page) => {
        await openStages(page, "t-upload");
        await page.click('.gsheet [data-nav-stage="docs"]');
        await page.waitForTimeout(600);
        const pane = '.gsheet .pane[data-stage="docs"]';
        await page.click(`${pane} [data-draft-edit]`);
        await page.fill(`${pane} textarea.draft-edit`, "Document the resume token, the limits, and the retry header.");
        await page.evaluate(() => (window as unknown as Hook).evidence.writeStagePromptQuietly("p-upload", "docs", "{{prev.output}}\n\nDocument the resume token and link the migration note."));
        await page.click(`${pane} [data-draft-save]`);
        await page.waitForSelector(`${pane} [data-draft-changed]`, { timeout: 5_000 });
        await page.waitForTimeout(300);
        const changed = await page.locator(`${pane} [data-draft-changed] .msg-text`).textContent();
        const writesBefore = await page.evaluate(() => (window as unknown as Hook).evidence.pipelinePatches.length);
        await shot(page, "production", "flow-stage-changed", "light");
        await clickText(page, `${pane} [data-draft-changed] button`, "Keep mine");
        await page.waitForFunction((selector) => !document.querySelector(`${selector} textarea.draft-edit`), pane, { timeout: 5_000 });
        const written = await page.evaluate(() => (window as unknown as Hook).evidence.pipelinePatches.at(-1) ?? null);
        flows.changedElsewhere = { changed, writesBefore, written };
        if (changed !== "Changed elsewhere since you began: «Document the resume token and link the migration note.»" || writesBefore !== 0) failures.push(`changed elsewhere: ${JSON.stringify({ changed, writesBefore })}`);
        if (written?.body.prompt !== "{{prev.output}}\n\nDocument the resume token, the limits, and the retry header.") failures.push(`keep mine: ${JSON.stringify(written)}`);
      });

      await production("light", "pipeline actions", async (page) => {
        const section = `${card("t-upload")} .stage-section`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} [data-pipeline-menu]`);
        await page.waitForTimeout(350);
        await shot(page, "production", "pipeline-menu", "light");
        await page.locator('.menu [role="menuitem"]', { hasText: "Pause" }).first().click();
        await page.waitForSelector(`${section} [data-pipeline-acting="pause"]`, { timeout: 2_000 });
        const pending = await page.locator(`${section} [data-pipeline-acting]`).textContent();
        await page.waitForSelector(`${section} .pstate-chip[data-pstate="paused"]`, { timeout: 5_000 });
        const pausedReceipt = await page.locator("[data-kanban-receipt] .msg").last().textContent();
        await page.evaluate(() => { (window as unknown as Hook).evidence.refuseNextPipelinePatch = { status: 409, error: "the runtime host did not answer" }; });
        await page.click(`${section} [data-pipeline-menu]`);
        await page.locator('.menu [role="menuitem"]', { hasText: "Resume" }).first().click();
        await page.waitForSelector("[data-kanban-receipt].error", { timeout: 5_000 });
        await page.waitForTimeout(350);
        const refused = await page.locator("[data-kanban-receipt].error .msg").textContent();
        await shot(page, "production", "pipeline-refused", "light");
        await page.click("[data-kanban-receipt].error .act");
        await page.waitForSelector(`${section} .pstate-chip[data-pstate="running"]`, { timeout: 5_000 });
        /* The pause is carried out and its answer lost: not confirmed, and Check again only reads. */
        await page.evaluate(() => { (window as unknown as Hook).evidence.loseNextPipelineAnswer = true; });
        await page.click(`${section} [data-pipeline-menu]`);
        await page.locator('.menu [role="menuitem"]', { hasText: "Pause" }).first().click();
        await page.waitForFunction(() => [...document.querySelectorAll("[data-kanban-receipt].error .msg")].some((node) => node.textContent?.includes("is not confirmed")), undefined, { timeout: 5_000 });
        await page.waitForTimeout(350);
        const unknown = await page.evaluate(() => {
          const receipt = [...document.querySelectorAll("[data-kanban-receipt].error")].find((node) => node.querySelector(".msg")?.textContent?.includes("is not confirmed"));
          return { text: receipt?.querySelector(".msg")?.textContent ?? null, action: receipt?.querySelector(".act")?.textContent ?? null };
        });
        await shot(page, "production", "pipeline-unconfirmed", "light");
        const readsBefore = await page.evaluate(() => (window as unknown as Hook).evidence.pipelineReads.length);
        await page.locator("[data-kanban-receipt].error", { hasText: "is not confirmed" }).locator(".act").click();
        await page.waitForFunction(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].some((node) => node.textContent === "«Redesign attachment upload for large files» is paused now"), undefined, { timeout: 5_000 });
        const readsAfter = await page.evaluate(() => (window as unknown as Hook).evidence.pipelineReads.length);
        const sent = await page.evaluate(() => (window as unknown as Hook).evidence.pipelinePatches.map((patch) => patch.body));
        flows.pipelineActions = { pending, pausedReceipt, refused, unknown, checkReads: readsAfter - readsBefore, sent };
        if (unknown.text !== "Pause for «Redesign attachment upload for large files» is not confirmed: no answer came back, so it may or may not have run. Nothing is sent again." || unknown.action !== "Check again") failures.push(`lost answer: ${JSON.stringify(unknown)}`);
        if (readsAfter - readsBefore !== 1) failures.push(`check again read ${readsAfter - readsBefore} times`);
        if (pending !== "Pausing…" || pausedReceipt !== "Paused «Redesign attachment upload for large files»") failures.push(`pause: ${JSON.stringify({ pending, pausedReceipt })}`);
        if (refused !== "Resume was refused: the runtime host did not answer") failures.push(`refused resume: ${refused}`);
        if (JSON.stringify(sent) !== JSON.stringify([{ action: "pause" }, { action: "resume" }, { action: "resume" }, { action: "pause" }])) failures.push(`pipeline writes: ${JSON.stringify(sent)}`);
      });

      await production("light", "moved cursor", async (page) => {
        const section = `${card("t-links")} .stage-section`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.evaluate(() => { (window as unknown as Hook).evidence.refuseNextPipelinePatch = { status: 409, error: "the stage worktree has uncommitted changes" }; });
        await page.click(`${section} [data-pipeline-menu]`);
        await page.locator('.menu [role="menuitem"]', { hasText: "Skip Builder" }).first().click();
        await page.waitForSelector("[data-kanban-receipt].error", { timeout: 5_000 });
        const refused = await page.locator("[data-kanban-receipt].error .msg").textContent();
        await page.evaluate(() => (window as unknown as Hook).evidence.moveCursor("p-links", "review"));
        await page.click("[data-kanban-receipt].error .act");
        await page.waitForFunction(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].some((node) => node.textContent?.includes("was not sent")), undefined, { timeout: 5_000 });
        await page.waitForTimeout(350);
        const notSent = await page.locator("[data-kanban-receipt] .msg", { hasText: "was not sent" }).textContent();
        await shot(page, "production", "pipeline-moved-cursor", "light");
        const writes = await page.evaluate(() => (window as unknown as Hook).evidence.pipelinePatches.map((patch) => patch.body));
        const reads = await page.evaluate(() => (window as unknown as Hook).evidence.pipelineReads.length);
        flows.movedCursor = { refused, notSent, writes, reads };
        if (refused !== "Skip Builder was refused: the stage worktree has uncommitted changes") failures.push(`moved cursor, refusal: ${refused}`);
        if (notSent !== "Skip Builder was not sent: the pipeline now waits on Reviewer.") failures.push(`moved cursor, retry: ${notSent}`);
        const guarded = { action: "skip-stage", expectedStageId: "implement", expectedAttempt: 1 };
        if (JSON.stringify(writes) !== JSON.stringify([guarded, guarded]) || reads !== 1) failures.push(`moved cursor, requests: ${JSON.stringify({ writes, reads })}`);
      });

      await production("light", "persistent reader and keys", async (page) => {
        const section = `${card("t-upload")} .stage-section`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .psummary [data-stage="build-ui"]`);
        const reader = '[data-kanban-reader="conversation_upload-ui"]';
        await page.waitForSelector(`${card("t-upload")} ${reader} textarea`, { timeout: 10_000 });
        await page.fill(`${card("t-upload")} ${reader} textarea`, "Keep this draft while the stages open.");
        await page.evaluate((selector) => { (document.querySelector(selector)!.closest(".reader-host") as HTMLElement & { kbProbe?: number }).kbProbe = 1695; }, reader);
        await openStages(page, "t-upload");
        const inPane = await page.evaluate((selector) => {
          const element = document.querySelector(`.gsheet .pane[data-stage="build-ui"] ${selector}`);
          return {
            probe: (element?.closest(".reader-host") as (HTMLElement & { kbProbe?: number }) | null)?.kbProbe ?? null,
            draft: element?.querySelector("textarea")?.value ?? null,
            inCard: Boolean(document.querySelector(`[data-kanban-board] .card ${selector}`)),
          };
        }, reader);
        await shot(page, "production", "stages-reader", "light");
        await page.focus('.gsheet .pane[data-stage="build-ui"]');
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(700);
        const stepped = await page.evaluate(() => ({
          focused: (document.activeElement as HTMLElement | null)?.dataset.stage ?? null,
          current: document.querySelector<HTMLElement>('.gsheet [data-nav-stage][aria-current="true"]')?.dataset.navStage ?? null,
        }));
        await page.keyboard.press("/");
        await page.waitForTimeout(200);
        const slash = await page.evaluate(() => ({
          search: document.activeElement?.hasAttribute("data-kanban-search") ?? false,
          open: Boolean(document.querySelector(".gsheet")),
        }));
        await page.keyboard.press("Escape");
        await page.waitForSelector(".gsheet", { state: "detached", timeout: 5_000 });
        await page.waitForTimeout(200);
        const back = await page.evaluate(({ selector, cardSelector }) => {
          const element = document.querySelector(`${cardSelector} ${selector}`);
          return {
            probe: (element?.closest(".reader-host") as (HTMLElement & { kbProbe?: number }) | null)?.kbProbe ?? null,
            draft: element?.querySelector("textarea")?.value ?? null,
            focus: document.activeElement?.hasAttribute("data-open-stages") ?? false,
          };
        }, { selector: reader, cardSelector: card("t-upload") });
        flows.persistentReader = { inPane, stepped, slash, back };
        if (slash.search || !slash.open) failures.push(`slash under the sheet: ${JSON.stringify(slash)}`);
        if (inPane.probe !== 1695 || inPane.draft !== "Keep this draft while the stages open." || inPane.inCard) failures.push(`reader in pane: ${JSON.stringify(inPane)}`);
        if (stepped.focused !== "review-ui" || stepped.current !== "review-ui") failures.push(`arrow key: ${JSON.stringify(stepped)}`);
        if (back.probe !== 1695 || back.draft !== "Keep this draft while the stages open." || !back.focus) failures.push(`reader back on card: ${JSON.stringify(back)}`);
      });
    } finally {
      await browser.close();
      server.stop();
    }

    const stages = (key: string) => frames[key] as { production?: SheetMeasure | null; prototype?: SheetMeasure | null } | undefined;
    const comparison: Record<string, unknown> = {};
    if (PROTOTYPE) {
      for (const key of ["stages-light", "stages-dark", "stages-retry"]) {
        const frame = stages(key);
        if (!frame?.production || !frame.prototype) {
          failures.push(`${key}: the prototype frame was not measured`);
          continue;
        }
        const { production: ours, prototype: theirs } = frame;
        const widths = { production: ours.panes.map((pane) => pane.width), prototype: theirs.panes.map((pane) => pane.width) };
        const drafts = { production: ours.panes.filter((pane) => pane.draft).map((pane) => pane.stage), prototype: theirs.panes.filter((pane) => pane.draft).map((pane) => pane.stage) };
        const attempts = { production: ours.panes.map((pane) => pane.attempts), prototype: theirs.panes.map((pane) => pane.attempts) };
        comparison[key] = { panes: [ours.panes.length, theirs.panes.length], navChips: [ours.navChips, theirs.navChips], loops: [ours.loops.length, theirs.loops.length], graphDir: [ours.graphDir, theirs.graphDir], graphNodes: [ours.graphNodes, theirs.graphNodes], widths, drafts, attempts, lanePos: [ours.lanePos, theirs.lanePos] };
        if (ours.panes.length !== theirs.panes.length || ours.navChips !== theirs.navChips || ours.loops.length !== theirs.loops.length) failures.push(`${key}: structure ${JSON.stringify(comparison[key])}`);
        if (ours.graphDir !== theirs.graphDir || ours.graphNodes !== theirs.graphNodes) failures.push(`${key}: graph ${ours.graphDir}/${ours.graphNodes}, prototype ${theirs.graphDir}/${theirs.graphNodes}`);
        const widthDelta = Math.max(0, ...widths.production.map((width, index) => Math.abs(width - (widths.prototype[index] ?? width))));
        if (widthDelta > 2) failures.push(`${key}: pane widths ${widths.production}, prototype ${widths.prototype}`);
        if (JSON.stringify(drafts.production) !== JSON.stringify(drafts.prototype)) failures.push(`${key}: waiting panes ${JSON.stringify(drafts)}`);
        if (JSON.stringify(attempts.production) !== JSON.stringify(attempts.prototype)) failures.push(`${key}: attempt tabs ${JSON.stringify(attempts)}`);
      }
      const detail = frames["stage-details"] as { production?: { status: string; edit: boolean; composerDisabled: boolean } | null; prototype?: { status: string; edit: boolean; composerDisabled: boolean } | null } | undefined;
      if (!detail?.production || !detail.prototype) failures.push("stage-details: the prototype frame was not measured");
      else {
        comparison["stage-details"] = { status: [detail.production.status, detail.prototype.status], edit: [detail.production.edit, detail.prototype.edit], composerDisabled: [detail.production.composerDisabled, detail.prototype.composerDisabled] };
        /* The prototype marks its own save as simulated; the words before that are the requirement. */
        if (!detail.prototype.status.startsWith(detail.production.status) || detail.production.edit !== detail.prototype.edit || detail.production.composerDisabled !== detail.prototype.composerDisabled) failures.push(`stage-details: ${JSON.stringify(comparison["stage-details"])}`);
      }
    }
    if (PROTOTYPE && notes.length) failures.push(...notes.map((note) => `prototype not driven: ${note}`));
    fs.writeFileSync(path.join(EVIDENCE, "k5b.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), boardWidth, frames, comparison, flows, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 900_000);
});

describe("#1695 K6a account chips and pickers", () => {
  /*
   * Rendered evidence for account choice on the kanban board (#1695 K6): the
   * real Viewer over `issue1695Evidence.fixture.tsx?scenario=accounts`, with the
   * production stylesheet, in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
   * prototype, its `account-picker` frame (a working stage conversation's
   * picker) and its waiting stage's picker (`stage=t-links:review`) are rendered
   * beside the production frames and compared.
   *
   * Gated here:
   *   - a waiting stage's chip and picker: the project's choice first, accounts
   *     the binding refuses for a stage unavailable, a choice written as
   *     `override-stage {stageId, account, expectedStageDigest}` alone, the
   *     stage's prompt and runtime unchanged;
   *   - a running stage conversation's chip and picker: its current account and
   *     stage setting, an account outside the project's accounts offered and
   *     recorded, the switch sent as the conversation header's `reconfigure`,
   *     then "after this turn" with the target known to this page only (the
   *     fixture runs without a runtime plane, so no session reports it), every
   *     nothing resent while it waits, and "now runs on" only once the
   *     conversation runs on the target;
   *   - Cancel switch and Change the pending account, as the prototype has them
   *     (#1705): Change withdraws the queued switch by its operation before the
   *     new switch is sent; Cancel on a switch the migration record reports
   *     sends the record's revision; a switch past waiting for its turn offers
   *     neither;
   *   - a switch the migration record reports, shown to a fresh page; a switch
   *     with no answer, not confirmed and never resent.
   *
   * Measurements go to `evidence/issue-1695/k6.json`; frames to
   * `.artifacts/issue-1695/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1695");
  const EVIDENCE = path.resolve("evidence/issue-1695");

  interface PickerMeasure {
    width: number;
    head: string;
    now: string[][];
    label: string;
    rows: Array<{ name: string; tag: string; checked: boolean; disabled: boolean; meter: boolean }>;
    notes: string[];
    cancel: boolean;
    chip: { text: string; pending: boolean; when: string };
  }

  /** The open picker and the chip it came from, read the same way from either page. */
  const measurePicker = (page: Page, chipSelector: string) => page.evaluate((selector): PickerMeasure | null => {
    const pop = document.querySelector<HTMLElement>(".popover.acct-pop");
    if (!pop) return null;
    const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const chip = document.querySelector<HTMLElement>(selector);
    return {
      width: Math.round(pop.getBoundingClientRect().width),
      head: text(pop.querySelector(".head span")),
      now: [...pop.querySelectorAll(".acct-now .kv")].map((line) => [text(line.querySelector(".k")), text(line.querySelector(".v"))]),
      label: text(pop.querySelector(".acct-lbl")),
      rows: [...pop.querySelectorAll<HTMLElement>(".acct-row")].map((row) => ({
        name: text(row.querySelector(".nm")),
        tag: text(row.querySelector(".tag")),
        checked: row.getAttribute("aria-checked") === "true",
        disabled: row.getAttribute("aria-disabled") === "true",
        meter: Boolean(row.querySelector(".meter i")),
      })),
      notes: [...pop.querySelectorAll(".acct-now .acct-sub, :scope > .note, .gap")].map(text),
      cancel: [...pop.querySelectorAll("button")].some((button) => /cancel/i.test(button.textContent ?? "")),
      chip: { text: text(chip), pending: Boolean(chip?.classList.contains("pending")), when: text(chip?.querySelector(".when")) },
    };
  }, chipSelector);

  const VERIFY_CHIP = '[data-kanban-board] [data-account-trigger="conversation_search-ver-2"]';
  const LINKS_REVIEW_CHIP = '[data-kanban-board] [data-account-trigger="stage:p-links:review"]';

  type Hook = { evidence: {
    pipelinePatches: Array<{ id: string; body: Record<string, unknown> }>;
    accountRequests: Array<Record<string, unknown>>;
    migrationRequests: Array<{ conversationId: string; body: Record<string, unknown> }>;
    loseNextAccountAnswer: boolean;
    storedPipeline: (id: string) => { stages: Array<{ id: string; prompt: string; account?: string | null; effectiveRole: Record<string, unknown> }> } | null;
    setMigration: (pathname: string, migration: Record<string, unknown> | null) => void;
    commitAccountSwitch: (conversationId: string, accountId: string) => void;
  } };

  async function boardReady(page: Page) {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(700);
  }

  browserTest("#1695 K6a: account chips and pickers on waiting and running stages, against the prototype", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=accounts`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, { production?: unknown; prototype?: unknown }> = {};
    const flows: Record<string, unknown> = {};
    const notes: string[] = [];

    const production = async (scheme: Scheme, label: string, run: (page: Page) => Promise<void>) => {
      const opened = await openFixture(browser, base, VIEWPORT, scheme);
      try {
        await boardReady(opened.page);
        await run(opened.page);
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    const prototype = async (query: string, scheme: Scheme, label: string, run: (page: Page) => Promise<void>) => {
      if (!PROTOTYPE) return;
      const opened = await openFixture(browser, `${PROTOTYPE}/?${query}`, VIEWPORT, scheme);
      try {
        await opened.page.waitForSelector("#app[data-ready] .board", { timeout: 20_000 });
        await opened.page.waitForTimeout(700);
        await run(opened.page);
      } catch (error) {
        notes.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };
    const shot = (page: Page, side: string, id: string, scheme: Scheme) => page.screenshot({ path: path.join(OUT, `${side}-k6a-${id}-${scheme}.png`) });
    const hook = <T,>(page: Page, run: (evidence: Hook["evidence"]) => T) => page.evaluate(`(${run.toString()})(window.evidence)`) as Promise<T>;
    const openVerify = async (page: Page) => {
      await page.locator(`${card("t-search")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.click(`${card("t-search")} .psummary [data-stage="verify"]`);
      await page.waitForSelector(VERIFY_CHIP, { timeout: 10_000 });
      await page.waitForTimeout(300);
    };
    const openPicker = async (page: Page, chip: string) => {
      await page.click(chip);
      await page.waitForSelector(".popover.acct-pop .acct-row", { timeout: 5_000 });
      await page.waitForTimeout(400);
    };
    const closePicker = async (page: Page) => {
      await page.keyboard.press("Escape");
      await page.waitForSelector(".popover.acct-pop", { state: "detached", timeout: 5_000 });
    };
    const receipts = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent ?? ""));

    try {
      for (const scheme of ["light", "dark"] as const) {
        await production(scheme, `conversation picker ${scheme}`, async (page) => {
          await openVerify(page);
          await openPicker(page, VERIFY_CHIP);
          const measure = await measurePicker(page, VERIFY_CHIP);
          await shot(page, "production", "account-picker", scheme);
          frames[`account-picker-${scheme}`] = { production: measure };
          if (!measure) return void failures.push(`conversation picker ${scheme}: the picker did not open`);
          if (measure.head !== "Account · Verifier · Claude") failures.push(`conversation picker ${scheme}: head ${measure.head}`);
          if (JSON.stringify(measure.now.slice(0, 2)) !== JSON.stringify([["Current turn on", "Account A · Max · 72% of 5h"], ["Stage setting", "Project's choice"]])) failures.push(`conversation picker ${scheme}: summary ${JSON.stringify(measure.now)}`);
          const tags = measure.rows.map((row) => [row.name, row.tag, row.checked, row.disabled]);
          if (JSON.stringify(tags.slice(0, 3)) !== JSON.stringify([["Account A · Max", "current", true, false], ["Account C · Max", "", false, false], ["Account G · Pro", "outside this project's accounts", false, false]])) failures.push(`conversation picker ${scheme}: rows ${JSON.stringify(tags)}`);
          if (!/^limit · resets \d/.test(measure.rows[3]?.tag ?? "")) failures.push(`conversation picker ${scheme}: limited row ${JSON.stringify(measure.rows[3])}`);
          if (!measure.notes.some((note) => note.startsWith("The running turn is never interrupted."))) failures.push(`conversation picker ${scheme}: notes ${JSON.stringify(measure.notes)}`);
        });
        await prototype("readers=c-search-ver-2&scrollto=t-search&seat=collapsed", scheme, `prototype conversation picker ${scheme}`, async (page) => {
          await page.click('[data-account-trigger="c-search-ver-2"]');
          await page.waitForSelector(".popover.acct-pop", { timeout: 5_000 });
          await page.waitForTimeout(250);
          const measure = await measurePicker(page, '[data-account-trigger="c-search-ver-2"]');
          await shot(page, "prototype", "account-picker", scheme);
          frames[`account-picker-${scheme}`] = { ...frames[`account-picker-${scheme}`], prototype: measure };
        });
      }

      await production("light", "stage picker", async (page) => {
        await page.locator(`${card("t-links")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${card("t-links")} .psummary [data-stage="review"]`);
        await page.waitForSelector(LINKS_REVIEW_CHIP, { timeout: 10_000 });
        await openPicker(page, LINKS_REVIEW_CHIP);
        const before = await measurePicker(page, LINKS_REVIEW_CHIP);
        await shot(page, "production", "account-stage", "light");
        const stored = await hook(page, (evidence) => evidence.storedPipeline("p-links")?.stages.find((entry) => entry.id === "review") ?? null);
        /* The binding refuses it for a stage: nothing is sent. */
        await page.$eval('.popover.acct-pop .acct-row[data-account="account-g"]', (element) => (element as HTMLElement).click());
        await page.waitForTimeout(300);
        const refusedPatches = await hook(page, (evidence) => evidence.pipelinePatches.length);
        await page.click('.popover.acct-pop .acct-row[data-account="account-c"]');
        await page.waitForTimeout(1_200);
        const patches = await hook(page, (evidence) => evidence.pipelinePatches);
        const after = await hook(page, (evidence) => evidence.storedPipeline("p-links")?.stages.find((entry) => entry.id === "review") ?? null);
        const chip = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", LINKS_REVIEW_CHIP);
        frames["account-stage"] = { production: before };
        flows.stageAccount = { before, refusedPatches, patches, stored: { prompt: stored?.prompt, account: stored?.account ?? null }, after: { prompt: after?.prompt, account: after?.account ?? null }, chip, receipts: await receipts(page) };
        if (!before || before.rows[0]?.name !== "Project's choice" || !before.rows[0].checked) failures.push(`stage picker: first row ${JSON.stringify(before?.rows[0])}`);
        if (before?.rows.find((row) => row.name === "Account G · Pro")?.disabled !== true) failures.push(`stage picker: a refused account is selectable ${JSON.stringify(before?.rows)}`);
        if (!before?.notes.some((note) => note.startsWith("Applies from the stage's first turn."))) failures.push(`stage picker: notes ${JSON.stringify(before?.notes)}`);
        if (refusedPatches !== 0) failures.push(`stage picker: a refused account sent ${refusedPatches} writes`);
        const body = patches.at(-1)?.body ?? null;
        if (patches.length !== 1 || !body || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["account", "action", "expectedStageDigest", "stageId"]) || body.account !== "account-c" || body.stageId !== "review" || typeof body.expectedStageDigest !== "string") failures.push(`stage picker: writes ${JSON.stringify(patches)}`);
        if (after?.account !== "account-c" || after?.prompt !== stored?.prompt || JSON.stringify(after?.effectiveRole) !== JSON.stringify(stored?.effectiveRole)) failures.push(`stage picker: stored stage ${JSON.stringify({ stored, after })}`);
        if (chip !== "Account C") failures.push(`stage picker: chip ${chip}`);
      });
      await prototype("stage=t-links:review", "light", "prototype stage picker", async (page) => {
        await page.click('[data-account-trigger^="draft:"]');
        await page.waitForSelector(".popover.acct-pop", { timeout: 5_000 });
        await page.waitForTimeout(250);
        const measure = await measurePicker(page, '[data-account-trigger^="draft:"]');
        await shot(page, "prototype", "account-stage", "light");
        frames["account-stage"] = { ...frames["account-stage"], prototype: measure };
      });

      for (const scheme of ["light", "dark"] as const) {
        await production(scheme, `pending switch ${scheme}`, async (page) => {
          await openVerify(page);
          await openPicker(page, VERIFY_CHIP);
          await page.click('.popover.acct-pop .acct-row[data-account="account-g"]');
          await page.waitForTimeout(800);
          await openPicker(page, VERIFY_CHIP);
          const pending = await measurePicker(page, VERIFY_CHIP);
          await shot(page, "production", "account-pending", scheme);
          frames[`account-pending-${scheme}`] = { production: pending };
          if (scheme === "dark") return;
          await closePicker(page);
          /* It waits: nothing is resent while the turn runs. */
          await page.waitForTimeout(1_500);
          const requests = await hook(page, (evidence) => evidence.accountRequests);
          const waiting = await receipts(page);
          /* Change: the queued switch is withdrawn by its operation before the new account is asked for. */
          await openPicker(page, VERIFY_CHIP);
          await page.click('.popover.acct-pop .acct-row[data-account="account-c"]');
          await page.waitForTimeout(1_500);
          const migrationRequests = await hook(page, (evidence) => evidence.migrationRequests);
          const changedRequests = await hook(page, (evidence) => evidence.accountRequests);
          const changedChip = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", VERIFY_CHIP);
          await hook(page, (evidence) => evidence.commitAccountSwitch("conversation_search-ver-2", "account-c"));
          await page.waitForTimeout(1_500);
          const committed = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", VERIFY_CHIP);
          flows.conversationSwitch = { pending, requests, waiting, migrationRequests, changedRequests, changedChip, committed, receipts: await receipts(page) };
          if (!pending || !pending.chip.pending || pending.chip.when !== "after this turn") failures.push(`pending switch: chip ${JSON.stringify(pending?.chip)}`);
          if (JSON.stringify(pending?.now.at(-1)) !== JSON.stringify(["Pending", "Account G · waits for the current turn to end"])) failures.push(`pending switch: summary ${JSON.stringify(pending?.now)}`);
          if (!pending?.cancel || pending.label !== "Change the pending account" || pending.rows.filter((row) => !row.disabled).length < 3) failures.push(`pending switch: Cancel and Change ${JSON.stringify({ cancel: pending?.cancel, label: pending?.label, rows: pending?.rows })}`);
          if (!pending?.notes.some((note) => note.startsWith("Known to this page only."))) failures.push(`pending switch: notes ${JSON.stringify(pending?.notes)}`);
          if (requests.length !== 1 || requests[0]?.action !== "reconfigure" || requests[0]?.accountId !== "account-g" || requests[0]?.conversationId !== "conversation_search-ver-2") failures.push(`pending switch: requests ${JSON.stringify(requests)}`);
          if (!waiting.includes("Account G is outside this project's accounts; the switch is recorded as your choice") || waiting.some((line) => line.includes("now runs on"))) failures.push(`pending switch: receipts ${JSON.stringify(waiting)}`);
          if (JSON.stringify(migrationRequests.map((entry) => entry.body)) !== JSON.stringify([{ action: "withdraw", operationId: "account-switch-1" }]) || changedRequests.length !== 2 || changedRequests[1]?.accountId !== "account-c") failures.push(`change: ${JSON.stringify({ migrationRequests, changedRequests })}`);
          if (!changedChip.includes("Account C")) failures.push(`change: chip ${changedChip}`);
          if (committed !== "Account C" || !(flows.conversationSwitch as { receipts: string[] }).receipts.includes("Verifier now runs on Account C")) failures.push(`change: after commit ${committed} ${JSON.stringify((flows.conversationSwitch as { receipts: string[] }).receipts)}`);
        });
      }
      await prototype("readers=c-search-ver-2&scrollto=t-search&seat=collapsed", "light", "prototype pending switch", async (page) => {
        await page.evaluate(() => {
          const proto = (window as unknown as { __proto: { state: { switches: Map<string, unknown> }; render: () => void } }).__proto;
          proto.state.switches.set("c-search-ver-2", { to: "Account G", phase: "waiting-turn", requestedAt: "14:05" });
          proto.render();
        });
        await page.click('[data-account-trigger="c-search-ver-2"]');
        await page.waitForSelector(".popover.acct-pop", { timeout: 5_000 });
        await page.waitForTimeout(250);
        const measure = await measurePicker(page, '[data-account-trigger="c-search-ver-2"]');
        await shot(page, "prototype", "account-pending", "light");
        frames["account-pending-light"] = { ...frames["account-pending-light"], prototype: measure };
      });

      await production("light", "recorded and lost switches", async (page) => {
        await openVerify(page);
        await hook(page, (evidence) => evidence.setMigration("conversation_search-ver-2", { intentId: "intent-1", trigger: "manual", phase: "waiting-turn", targetAccountId: "account-c", targetLabel: "account-c", failure: null, revision: 2 }));
        await page.waitForTimeout(1_500);
        await openPicker(page, VERIFY_CHIP);
        const recorded = await measurePicker(page, VERIFY_CHIP);
        const source = await page.evaluate(() => document.querySelector(".popover.acct-pop [data-account-pending]")?.getAttribute("data-account-source") ?? null);
        await shot(page, "production", "account-recorded", "light");
        /* Cancel by the record's revision; the fixture's route rolls the switch back. */
        await page.click(".popover.acct-pop [data-account-cancel]");
        await page.waitForTimeout(1_500);
        const cancelRequests = await hook(page, (evidence) => evidence.migrationRequests);
        const cancelledChip = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", VERIFY_CHIP);
        /* A switch past waiting for its turn offers neither Cancel nor Change. */
        await hook(page, (evidence) => evidence.setMigration("conversation_search-ver-2", { intentId: "intent-2", trigger: "manual", phase: "preparing", targetAccountId: "account-c", targetLabel: "account-c", failure: null, revision: 3 }));
        await page.waitForTimeout(1_500);
        await openPicker(page, VERIFY_CHIP);
        const started = await measurePicker(page, VERIFY_CHIP);
        await closePicker(page);
        await hook(page, (evidence) => evidence.setMigration("conversation_search-ver-2", null));
        await page.waitForTimeout(1_500);
        await hook(page, (evidence) => { evidence.loseNextAccountAnswer = true; });
        await openPicker(page, VERIFY_CHIP);
        await page.click('.popover.acct-pop .acct-row[data-account="account-c"]');
        await page.waitForTimeout(1_500);
        const lost = await page.evaluate((selector) => document.querySelector(selector)?.querySelector(".when")?.textContent ?? null, VERIFY_CHIP);
        const requests = await hook(page, (evidence) => evidence.accountRequests.length);
        flows.recordedAndLost = { recorded, source, cancelRequests, cancelledChip, started, lost, requests, receipts: await receipts(page) };
        if (!recorded?.chip.pending || source !== "record" || !recorded.notes.includes("Messages sent now are held. Cancel delivers them on the current account; if the switch completes, they are not delivered and have to be sent again.") || !recorded.cancel) failures.push(`recorded switch: ${JSON.stringify({ recorded, source })}`);
        if (JSON.stringify(cancelRequests.map((entry) => entry.body)) !== JSON.stringify([{ action: "cancel", expectedRevision: 2 }]) || cancelledChip !== "Account A") failures.push(`cancel: ${JSON.stringify({ cancelRequests, cancelledChip })}`);
        if (!started || started.cancel || !started.rows.every((row) => row.disabled) || !started.notes.includes("Too late to cancel: the switch has started.")) failures.push(`started switch: ${JSON.stringify(started)}`);
        if (lost !== "not confirmed" || requests !== 1) failures.push(`lost switch: ${JSON.stringify({ lost, requests })}`);
      });
    } finally {
      await browser.close();
      server.stop();
    }

    const comparison: Record<string, unknown> = {};
    if (PROTOTYPE) {
      for (const key of ["account-picker-light", "account-picker-dark", "account-stage", "account-pending-light"]) {
        const frame = frames[key] as { production?: PickerMeasure | null; prototype?: PickerMeasure | null } | undefined;
        if (!frame?.production || !frame.prototype) {
          failures.push(`${key}: the prototype frame was not measured`);
          continue;
        }
        const { production: ours, prototype: theirs } = frame;
        comparison[key] = {
          width: [ours.width, theirs.width],
          summaryKeys: [ours.now.map(([k]) => k), theirs.now.map(([k]) => k)],
          label: [ours.label, theirs.label],
          rows: [ours.rows.length, theirs.rows.length],
          meters: [ours.rows.filter((row) => row.meter).length, theirs.rows.filter((row) => row.meter).length],
          pendingChip: [ours.chip.pending, theirs.chip.pending],
          cancel: [ours.cancel, theirs.cancel],
        };
        if (Math.abs(ours.width - theirs.width) > 2) failures.push(`${key}: picker width ${ours.width}, prototype ${theirs.width}`);
        if (ours.now[0]?.[0] !== theirs.now[0]?.[0]) failures.push(`${key}: summary ${JSON.stringify(comparison[key])}`);
        if (ours.chip.pending !== theirs.chip.pending) failures.push(`${key}: chip ${JSON.stringify(comparison[key])}`);
        if (ours.cancel !== theirs.cancel) failures.push(`${key}: Cancel ${JSON.stringify(comparison[key])}`);
      }
    }
    if (PROTOTYPE && notes.length) failures.push(...notes.map((note) => `prototype not driven: ${note}`));
    fs.writeFileSync(path.join(EVIDENCE, "k6.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), frames, comparison, flows, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 900_000);
});

describe("#1712 the window of a conversation no card holds", () => {
  /*
   * Rendered evidence for review round 2 of #1712: the reader of a conversation
   * no card holds takes the whole window, and every way of going somewhere else
   * on the Board leaves that window first. In the real Viewer over
   * `issue1695Evidence.fixture.tsx?scenario=loose` (a review round of the export
   * implementer, which no card holds), in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * Each case opens the reviewer in the window, goes to something a card holds,
   * and asks the page what is actually under the target's own box
   * (`elementFromPoint`), so a target laid out but covered by the window does
   * not pass. Cases: a focus handoff `show` and `open`, a resumed `show` (the
   * arrival check runs before any move), a `#c=` link, and a pipeline link.
   *
   * Measurements go to `evidence/issue-1695/loose-reader.json`; frames to
   * `.artifacts/issue-1695-loose-reader/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1695-loose-reader");
  const EVIDENCE = path.resolve("evidence/issue-1695");
  const REVIEWER = "/repo/export-review.jsonl";
  const IMPLEMENTER = "/repo/export-impl.jsonl";

  type Evidence = {
    focus: {
      bus: unknown;
      runFocusTransaction(request: unknown, bus: unknown, options: unknown): Promise<{ resolution: string; moved: boolean }>;
    };
  };

  /** What is under the middle of the target's visible box: the target itself, the full-window reader, or something else. */
  const hitTest = (page: Page, selector: string) => page.evaluate((sel) => {
    const target = document.querySelector<HTMLElement>(sel);
    if (!target) return { present: false, under: "absent", window: Boolean(document.querySelector(".reader-full")) };
    const rect = target.getBoundingClientRect();
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    const x = rect.left + rect.width / 2;
    const y = top + Math.min((bottom - top) / 2, 40);
    const hit = document.elementFromPoint(x, y);
    const under = hit && target.contains(hit) ? "target" : hit?.closest(".reader-full") ? "window" : hit ? "other" : "nothing";
    return { present: true, under, window: Boolean(document.querySelector(".reader-full")) };
  }, selector);

  const transaction = (page: Page, id: string, targetPath: string, intent: "show" | "open", resume = false) => page.evaluate(async ({ id, targetPath, intent, resume }) => {
    const { bus, runFocusTransaction } = (window as unknown as { evidence: Evidence }).evidence.focus;
    const result = await runFocusTransaction({
      id,
      target: { kind: "conversation", path: targetPath },
      frameAtCreation: { project: "atlas", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
      intent,
      zoom: "inspect",
    }, bus, { timeoutMs: 8_000, ...(resume ? { resume: true } : {}) });
    return result.resolution;
  }, { id, targetPath, intent, resume });

  const readerFor = (conversationId: string) => `[data-kanban-reader="${conversationId}"]`;
  const implementerCard = `[data-kanban-card]:has([data-member="${IMPLEMENTER}"])`;

  async function openReviewer(page: Page, id: string) {
    const resolution = await transaction(page, id, REVIEWER, "open");
    await page.waitForFunction((sel) => {
      const state = document.querySelector(`.reader-full ${sel} [data-feed-state]`)?.getAttribute("data-feed-state");
      return state === "items" || state === "empty";
    }, readerFor("conversation_export-review"), { timeout: 10_000 });
    return { resolution, hit: await hitTest(page, `.reader-full ${readerFor("conversation_export-review")}`) };
  }

  browserTest("#1712 review round 2: going anywhere else on the Board leaves the window of a conversation no card holds", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const browser = await chromium.launch(LAUNCH);
    const cases: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    try {
      const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=loose`, { width: 1440, height: 900 }, "light");
      try {
        await page.waitForSelector(`[data-kanban-card] [data-member="${IMPLEMENTER}"]`, { timeout: 15_000 });
        const onNoCard = await page.evaluate((reviewer) => !document.querySelector(`[data-kanban-card] [data-member="${reviewer}"]`), REVIEWER);
        if (!onNoCard) failures.push("fixture: a card holds the review round");

        const steps: Array<{ name: string; go: () => Promise<string | null>; target: string }> = [
          { name: "focus handoff show", go: () => transaction(page, "loose-show", IMPLEMENTER, "show"), target: implementerCard },
          { name: "resumed focus handoff show", go: () => transaction(page, "loose-resumed-show", IMPLEMENTER, "show", true), target: implementerCard },
          { name: "focus handoff open", go: () => transaction(page, "loose-open", IMPLEMENTER, "open"), target: readerFor("conversation_export-impl") },
          {
            name: "#c= link",
            go: async () => {
              await page.evaluate(() => { location.hash = "#c=conversation_export-impl"; });
              return null;
            },
            target: readerFor("conversation_export-impl"),
          },
          {
            name: "pipeline link",
            go: async () => {
              await page.evaluate(() => window.dispatchEvent(new CustomEvent("llv:mcp-navigate", { detail: { kind: "pipeline", id: "p-search" } })));
              return null;
            },
            target: '[data-kanban-card="task:t-search"]',
          },
        ];
        for (const [index, step] of steps.entries()) {
          const opened = await openReviewer(page, `loose-reviewer-${index}`);
          if (opened.resolution !== "reader" || opened.hit.under !== "target") failures.push(`${step.name}: the reviewer did not open in the window (${JSON.stringify(opened)})`);
          const resolution = await step.go();
          /* Settled: the window is gone and the target is laid out, or the wait ends and the hit test says what is on top. */
          await page.waitForFunction((sel) => !document.querySelector(".reader-full") && Boolean(document.querySelector(sel)), step.target, { timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(400);
          const hit = await hitTest(page, step.target);
          await page.screenshot({ path: path.join(OUT, `${String(index + 1).padStart(2, "0")}-${step.name.replace(/[^a-z0-9]+/gi, "-")}.png`) });
          cases.push({ name: step.name, reviewerOpened: opened.resolution, resolution, windowAfter: hit.window, targetPresent: hit.present, underTarget: hit.under });
          if (hit.window || hit.under !== "target") failures.push(`${step.name}: after it, ${JSON.stringify(hit)} (resolution ${resolution})`);
          if (resolution === "lost") failures.push(`${step.name}: the handoff settled as lost`);
        }
        if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(" | ")}`);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "loose-reader.json"), `${JSON.stringify({ viewport: { width: 1440, height: 900 }, scheme: "light", cases, failures }, null, 2)}\n`);
    expect(failures).toEqual([]);
  }, 180_000);
});

describe("#1731 the seat anchors the board", () => {
  /*
   * Rendered evidence for #1731: typing or dictating into the seat's composer
   * must not move the board below it. In the real Viewer over
   * `issue1695Evidence.fixture.tsx`, in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * The seat has a fixed height and the composer sits at its bottom, so a
   * growing field moves the form's top upward inside a box whose own size never
   * changes. Chrome's scroll anchoring on the page scroller (`.kb .kb-page`)
   * used to pick an anchor inside that moving region and compensate its
   * `scrollTop`, displacing the whole board by the field's height delta once per
   * character. `.kb .seat { overflow-anchor: none }` takes the seat out of the
   * anchor candidates; `kanbanBoard.css` carries the rule and this test holds it.
   *
   * Each case scrolls the page so the seat header is out of view and the
   * composer is the topmost visible content, then drives the composer's value
   * across its own wrap boundary — the probe finds that boundary at the actual
   * field width — and reads the board frame's viewport top, the scroller's
   * `scrollTop` and the field's height after every change. The field's height
   * has to change and the other two have to stand still.
   *
   * The red path runs in the same case: `overflow-anchor: auto` back on the seat
   * inline, the identical drive, and the board frame has to move. Anchoring is a
   * real-browser behaviour that happy-dom does not implement, which is why this
   * lives here and not in a `.dom.test.tsx`.
   *
   * Covered: 1440×900 and 1100×800, the compact seat and one dragged open by its
   * grip. Measurements go to `evidence/issue-1731/seat-anchor.json`; frames to
   * `.artifacts/issue-1731/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1731");
  const EVIDENCE = path.resolve("evidence/issue-1731");
  const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1100, height: 800 }] as const;
  /** How many times the draft crosses its wrap boundary — a dictated tail re-wraps about this often in a sentence. */
  const ALTERNATIONS = 12;
  /** How far above the scrollport's top edge the composer's form starts, so the composer is what the scroller can anchor to. */
  const COMPOSER_CLIP = 24;

  const SEAT = "[data-kanban-seat]";
  const FIELD = `${SEAT} textarea`;
  const FORM = `${SEAT} form`;
  const SCROLLER = ".kb .kb-page";
  const FRAME = ".kb .board-frame";

  type Sample = { fieldHeight: number; frameTop: number; scrollTop: number };

  async function boardReady(page: Page) {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
    await page.waitForSelector(FIELD, { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(800);
  }

  /** A value set the way the composer receives one from a keystroke or a transcript revision: the native setter, then React's input event. */
  const setValue = (page: Page, value: string) => page.evaluate(({ selector, next }) => {
    const field = document.querySelector<HTMLTextAreaElement>(selector);
    if (!field) throw new Error("no seat composer");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, next);
    field.setSelectionRange(next.length, next.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, { selector: FIELD, next: value });

  /* A missing element is a failure and never a sentinel: a NaN reading would
     deduplicate to one value for the green assertion and compare unequal to
     itself for the red one, so a renamed selector would satisfy both checks
     while measuring nothing. */
  const sample = (page: Page) => page.evaluate(({ field, frame, scroller }) => {
    const found = <T extends HTMLElement>(selector: string) => {
      const element = document.querySelector<T>(selector);
      if (!element) throw new Error(`nothing matches ${selector} — this test measures what is not there`);
      return element;
    };
    return {
      fieldHeight: found<HTMLTextAreaElement>(field).offsetHeight,
      frameTop: Number(found(frame).getBoundingClientRect().top.toFixed(2)),
      scrollTop: Number(found(scroller).scrollTop.toFixed(2)),
    };
  }, { field: FIELD, frame: FRAME, scroller: SCROLLER }) as Promise<Sample>;

  /**
   * The shortest pair of drafts either side of the composer's first wrap, found
   * at the field's real width: a fixed string would sit on one side of it at one
   * viewport and on the other side at the next.
   */
  async function wrapPair(page: Page): Promise<{ short: string; long: string; heights: [number, number] }> {
    const found = await page.evaluate(async ({ selector }) => {
      const field = document.querySelector<HTMLTextAreaElement>(selector);
      if (!field) throw new Error("no seat composer");
      const set = (value: string) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
        field.setSelectionRange(value.length, value.length);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      let draft = "dictated";
      set(draft);
      await settle();
      const base = field.offsetHeight;
      for (let word = 0; word < 400; word++) {
        const next = `${draft} dictated`;
        set(next);
        await settle();
        if (field.offsetHeight > base) {
          const heights: [number, number] = [base, field.offsetHeight];
          set("");
          await settle();
          return { short: draft, long: next, heights };
        }
        draft = next;
      }
      set("");
      await settle();
      return null;
    }, { selector: FIELD });
    if (!found) throw new Error("the composer never wrapped: no height to hold still against");
    return found;
  }

  /** Scroll the page until the seat's header is gone and the composer is what sits at the top of the scrollport. */
  async function scrollComposerToTop(page: Page) {
    const state = await page.evaluate(({ scroller, form, seat, clip }) => {
      const page_ = document.querySelector<HTMLElement>(scroller);
      const composer = document.querySelector<HTMLElement>(form);
      const head = document.querySelector<HTMLElement>(`${seat} .seat-head`);
      if (!page_ || !composer || !head) throw new Error("seat, composer or page scroller missing");
      const max = page_.scrollHeight - page_.clientHeight;
      const want = page_.scrollTop + composer.getBoundingClientRect().top - page_.getBoundingClientRect().top + clip;
      page_.scrollTop = Math.max(0, Math.min(max, want));
      return { scrollTop: page_.scrollTop, maxScroll: max };
    }, { scroller: SCROLLER, form: FORM, seat: SEAT, clip: COMPOSER_CLIP });
    await page.waitForTimeout(300);
    const preconditions = await page.evaluate(({ scroller, form, seat }) => {
      const page_ = document.querySelector<HTMLElement>(scroller)!;
      const composer = document.querySelector<HTMLElement>(form)!;
      const head = document.querySelector<HTMLElement>(`${seat} .seat-head`)!;
      const top = page_.getBoundingClientRect().top;
      const box = composer.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, top + 2);
      return {
        headOutOfView: head.getBoundingClientRect().bottom <= top,
        composerOnTop: Boolean(hit && composer.contains(hit)),
        composerClipped: box.top < top,
      };
    }, { scroller: SCROLLER, form: FORM, seat: SEAT });
    return { ...state, ...preconditions };
  }

  /** Drag the seat's grip down, the way an operator opens it for a longer answer. */
  async function dragSeatOpen(page: Page, by: number) {
    const before = await page.evaluate((seat) => document.querySelector<HTMLElement>(seat)?.getBoundingClientRect().height ?? 0, SEAT);
    const grip = await page.locator("[data-seat-grip]").boundingBox();
    if (!grip) throw new Error("no seat grip to drag");
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + by, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.evaluate((seat) => document.querySelector<HTMLElement>(seat)?.getBoundingClientRect().height ?? 0, SEAT);
    return { before: Math.round(before), after: Math.round(after) };
  }

  const setAnchoring = (page: Page, value: "" | "auto") => page.evaluate(({ seat, next }) => {
    const section = document.querySelector<HTMLElement>(seat);
    if (!section) throw new Error("no seat");
    section.style.overflowAnchor = next;
    return getComputedStyle(section).overflowAnchor;
  }, { seat: SEAT, next: value });

  /** One pass of the draft across its wrap boundary, sampled after every change. */
  async function drive(page: Page, pair: { short: string; long: string }) {
    await setValue(page, pair.short);
    await page.waitForTimeout(150);
    const samples: Sample[] = [await sample(page)];
    for (let step = 0; step < ALTERNATIONS; step++) {
      await setValue(page, step % 2 === 0 ? pair.long : pair.short);
      await page.waitForTimeout(70);
      samples.push(await sample(page));
    }
    const tops = samples.map((entry) => entry.frameTop);
    return {
      fieldHeights: [...new Set(samples.map((entry) => entry.fieldHeight))],
      frameTops: [...new Set(tops)],
      scrollTops: [...new Set(samples.map((entry) => entry.scrollTop))],
      swings: tops.filter((top, index) => index > 0 && top !== tops[index - 1]).length,
    };
  }

  browserTest("#1731: typing or dictating in the seat leaves the board where it is, at both widths and both seat sizes", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const browser = await chromium.launch(LAUNCH);
    const cases: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    try {
      for (const viewport of VIEWPORTS) {
        const { context, page, pageErrors } = await openFixture(browser, server.base, viewport, "light");
        try {
          await boardReady(page);
          for (const seatSize of ["compact", "grip-expanded"] as const) {
            const label = `${viewport.width}x${viewport.height} ${seatSize}`;
            let drag: { before: number; after: number } | null = null;
            if (seatSize === "grip-expanded") {
              drag = await dragSeatOpen(page, 250);
              if (drag.after <= drag.before) failures.push(`${label}: the grip did not open the seat (${drag.before} → ${drag.after})`);
            }
            const pair = await wrapPair(page);
            await page.click(FIELD);
            await page.waitForTimeout(250);
            const placement = await scrollComposerToTop(page);
            if (!placement.headOutOfView) failures.push(`${label}: the seat header is still in view at scrollTop ${placement.scrollTop}`);
            if (!placement.composerOnTop) failures.push(`${label}: the composer is not the topmost visible content at scrollTop ${placement.scrollTop}`);

            const anchoring = await page.evaluate((seat) => getComputedStyle(document.querySelector(seat)!).overflowAnchor, SEAT);
            if (anchoring !== "none") failures.push(`${label}: the seat's overflow-anchor is ${anchoring}, not none — the stylesheet rule is gone`);
            const fixed = await drive(page, pair);
            await page.screenshot({ path: path.join(OUT, `${label.replace(/[^a-z0-9]+/gi, "-")}-fixed.png`) });

            /* The red path, in place: the seat becomes an anchor candidate again and the same drive has to move the board. */
            const red = await setAnchoring(page, "auto");
            const unfixed = await drive(page, pair);
            await setAnchoring(page, "");

            cases.push({ viewport, seat: seatSize, seatHeights: drag, scroll: placement, wrap: { heights: pair.heights, shortLength: pair.short.length, longLength: pair.long.length }, fixed, unfixed: { ...unfixed, overflowAnchor: red } });
            if (fixed.fieldHeights.length < 2) failures.push(`${label}: the field never changed height (${fixed.fieldHeights.join(", ")}) — nothing was held still`);
            if (fixed.frameTops.length !== 1) failures.push(`${label}: the board frame moved, tops ${fixed.frameTops.join(", ")} (${fixed.swings} swings)`);
            if (fixed.scrollTops.length !== 1) failures.push(`${label}: the page scroller moved, scrollTops ${fixed.scrollTops.join(", ")}`);
            if (unfixed.fieldHeights.length < 2) failures.push(`${label}: the red path's field never changed height — the control proves nothing`);
            if (unfixed.swings === 0) failures.push(`${label}: the board stood still with anchoring back on, so this check cannot fail`);

            if (seatSize === "compact") await setValue(page, "");
          }
          if (pageErrors.length) failures.push(`${viewport.width}x${viewport.height}: page errors ${pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${viewport.width}x${viewport.height}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "seat-anchor.json"), `${JSON.stringify({ alternations: ALTERNATIONS, cases, failures }, null, 2)}\n`);
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("#1765 pipelines named on the card", () => {
  /*
   * Rendered evidence for #1765: the real Viewer over
   * `issue1695Evidence.fixture.tsx?scenario=issue1765`, with the production
   * stylesheet, in Chromium, at the two widths the issue names:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=$(which google-chrome-stable) \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * The seeded board holds one task with five pipelines — two running, three
   * completed. At 1280 px that task is a kanban card, and the card is what is
   * gated: every drawn row leads with its own title, the five titles are
   * distinct, no raw `conversation_<uuid>` is anywhere on it, and the completed
   * rows sit behind one «3 completed» disclosure that opens to the three of
   * them, newest first. At 390 px the phone draws its own board instead of the
   * kanban card (mobile v2), so what is gated there is that surface: its
   * pipeline rows are named by their task, and no raw id is drawn.
   *
   * Both widths gate the removals: no readiness, launch-history, idle-worker or
   * quiet drawer anywhere on the page, and no floating «N · M waiting» pill.
   *
   * Measurements go to `evidence/issue-1765/board.json`; frames to
   * `.artifacts/issue-1765/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1765");
  const EVIDENCE = path.resolve("evidence/issue-1765");
  const CARD = '[data-kanban-board] .card[data-id="task:t-many"]';

  interface Removals {
    /** The drawers this issue takes off the board, counted on the whole page. */
    retired: Record<string, number>;
    /** Buttons whose whole text is the corner pill's «N · M waiting». */
    cornerPill: string[];
    /** Raw conversation identifiers drawn on the measured surface. */
    rawConversationIds: string[];
    /** The header's own counts, which this issue leaves alone. */
    headerCounts: string[];
  }

  interface CardMeasure extends Removals {
    rows: Array<{ pipeline: string; title: string; hover: string; state: string; pills: string[] }>;
    completedToggle: string | null;
    completedCount: number | null;
    reportLines: string[];
  }

  interface PhoneMeasure extends Removals {
    board: string;
    pipelineRows: string[];
  }

  /** The desktop card, plus what must be absent from the page around it. */
  const measureCard = (page: Page) => page.evaluate((selector): CardMeasure | null => {
    const card = document.querySelector(selector);
    if (!card) return null;
    const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? "";
    const rows = [...card.querySelectorAll<HTMLElement>(".stage-section")].map((row) => ({
      pipeline: row.dataset.pipeline ?? "",
      title: text(row.querySelector(".ptitle")),
      hover: row.querySelector(".ptitle")?.getAttribute("title") ?? "",
      state: text(row.querySelector(".pstate-chip")),
      pills: [...row.querySelectorAll(".psummary .pname, .pnode .pname")].map((pill) => text(pill)),
    }));
    const toggle = card.querySelector<HTMLElement>("[data-completed-toggle]");
    const folded = card.querySelector<HTMLElement>("[data-completed-pipelines]");
    return {
      rows,
      completedToggle: toggle ? text(toggle) : null,
      completedCount: folded ? Number(folded.dataset.completedPipelines) : null,
      reportLines: [...card.querySelectorAll(".stage-report")].map((line) => text(line)),
      rawConversationIds: [...new Set((card.textContent ?? "").match(/conversation[_-][0-9a-f-]{8,}/gi) ?? [])],
      retired: {
        readiness: document.querySelectorAll('[data-testid="task-readiness"]').length,
        launchHistory: document.querySelectorAll('[data-testid="launch-history"]').length,
        workerStacks: document.querySelectorAll('[data-testid="worker-stacks"]').length,
      },
      cornerPill: [...document.querySelectorAll("button")]
        .map((button) => (button.textContent ?? "").trim())
        .filter((label) => /^\d+\s*·?\s*\d+\s+waiting$/.test(label)),
      headerCounts: [...document.querySelectorAll("[data-kanban-board] > header.bar .summary .num")].map((node) => text(node)),
    };
  }, CARD);

  /** The phone's own board at 390 px, plus the same absences. */
  const measurePhone = (page: Page) => page.evaluate((): PhoneMeasure => {
    const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? "";
    const board = document.querySelector("[data-mobile2-board]") ? "mobile2" : document.querySelector("[data-kanban-board]") ? "kanban" : "none";
    return {
      board,
      pipelineRows: [...document.querySelectorAll('[data-mobile2-row="pipeline"]')].map((row) => text(row)),
      rawConversationIds: [...new Set((document.body.textContent ?? "").match(/conversation[_-][0-9a-f-]{8,}/gi) ?? [])],
      retired: {
        readiness: document.querySelectorAll('[data-testid="task-readiness"]').length,
        launchHistory: document.querySelectorAll('[data-testid="launch-history"]').length,
        workerStacks: document.querySelectorAll('[data-testid="worker-stacks"]').length,
      },
      cornerPill: [...document.querySelectorAll("button")]
        .map((button) => (button.textContent ?? "").trim())
        .filter((label) => /^\d+\s*·?\s*\d+\s+waiting$/.test(label)),
      headerCounts: [...document.querySelectorAll("[data-mobile2-bar] [data-mobile2-title-text]")].map((node) => text(node)),
    };
  });

  const checkRemovals = (label: string, measured: Removals, failures: string[]) => {
    for (const [name, count] of Object.entries(measured.retired)) {
      if (count) failures.push(`${label}: the ${name} drawer is drawn ${count} time(s)`);
    }
    if (measured.cornerPill.length) failures.push(`${label}: corner pill ${JSON.stringify(measured.cornerPill)}`);
    if (measured.rawConversationIds.length) failures.push(`${label}: raw conversation ids ${JSON.stringify(measured.rawConversationIds)}`);
  };

  browserTest("#1765: a task's pipelines are named on the card, and the retired drawers and corner pill are drawn nowhere", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=issue1765`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, unknown> = {};

    const desktop = async () => {
      const label = "1280";
      const viewport = { width: 1280, height: 900 };
      const opened = await openFixture(browser, base, viewport, "light");
      try {
        await opened.page.waitForSelector(CARD, { state: "attached", timeout: 20_000 });
        await opened.page.locator(CARD).evaluate((element) => element.scrollIntoView({ block: "start" }));
        await opened.page.waitForTimeout(500);
        const folded = await measureCard(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `issue-1765-${label}-folded.png`) });
        if (!folded) {
          failures.push(`${label}: the seeded card was not drawn`);
          return;
        }
        await opened.page.click(`${CARD} [data-completed-toggle]`);
        await opened.page.waitForTimeout(300);
        const expanded = await measureCard(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `issue-1765-${label}-open.png`) });
        frames[label] = { viewport, folded, expanded };

        /* The two running rows on top; the three completed behind one count. */
        if (folded.rows.length !== 2) failures.push(`${label}: ${folded.rows.length} rows drawn folded, expected the 2 running ones`);
        if (folded.completedCount !== 3) failures.push(`${label}: completed count ${folded.completedCount}`);
        if (folded.completedToggle !== "3 completed") failures.push(`${label}: the disclosure reads ${JSON.stringify(folded.completedToggle)}`);
        if (expanded?.rows.length !== 5) failures.push(`${label}: ${expanded?.rows.length} rows once the disclosure is open`);
        const titles = (expanded?.rows ?? []).map((row) => row.title);
        if (titles.some((title) => !title)) failures.push(`${label}: a row drew no title: ${JSON.stringify(titles)}`);
        if (new Set(titles).size !== titles.length) failures.push(`${label}: the titles are not distinct: ${JSON.stringify(titles)}`);
        if (titles.includes("Pipeline")) failures.push(`${label}: a row still draws the generic chip`);
        /* Newest first among the folded rows. */
        const completedOrder = (expanded?.rows ?? []).slice(2).map((row) => row.pipeline);
        if (completedOrder.join() !== "p-many-pill,p-many-collapse,p-many-report") failures.push(`${label}: completed order ${completedOrder.join()}`);
        /* The report line reads as role, outcome and age. */
        if (!(expanded?.reportLines ?? []).some((line) => /^Builder passed · /.test(line))) failures.push(`${label}: stage report lines ${JSON.stringify(expanded?.reportLines)}`);
        /* The header's own counts are untouched by the removals. */
        if (folded.headerCounts.length !== 3) failures.push(`${label}: header counts ${JSON.stringify(folded.headerCounts)}`);
        for (const measured of [folded, expanded!]) checkRemovals(label, measured, failures);
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };

    const phone = async () => {
      const label = "390";
      const viewport = { width: 390, height: 844 };
      const opened = await openFixture(browser, base, viewport, "light");
      try {
        await opened.page.waitForSelector('[data-mobile2-row="pipeline"]', { state: "attached", timeout: 20_000 });
        await opened.page.waitForTimeout(500);
        const measured = await measurePhone(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `issue-1765-${label}.png`), fullPage: true });
        frames[label] = { viewport, measured };
        if (measured.board !== "mobile2") failures.push(`${label}: the phone drew ${measured.board}`);
        if (!measured.pipelineRows.length) failures.push(`${label}: the phone board drew no pipeline row`);
        checkRemovals(label, measured, failures);
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };

    try {
      await desktop();
      await phone();
    } finally {
      await browser.close();
      server.stop();
    }

    fs.writeFileSync(path.join(EVIDENCE, "board.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});
