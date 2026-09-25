import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type LaunchOptions, type Page } from "playwright-core";

import { translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { DEFAULT_ROLE_FRAME, ROLE_FRAME_VARIANTS } from "@/lib/roleFrames";

import { REPORT_LOG_CHAT_MIN_WIDTH, REPORT_LOG_MAX_WIDTH, REPORT_LOG_MIN_WIDTH, REPORT_LOG_SPLIT_WIDTH } from "@/components/orchestrator/OrchestratorPanel";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";
import { kanbanLayoutMode } from "./KanbanBoard";
import { clipTitle } from "./taskText";

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
   *     prototype's (equal shelves of at least 264 px wide, balanced on large
   *     screens, 220 px narrow, a 280/480 px scroller,
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
    card: { paddingLeft: string; radius: string; titleSize: string; titleWeight: string; menuHeight: number; tileWidth: number | null } | null;
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
    /* The card's ⋯ is where its status changes (#2148): a column names the status. */
    const menu = card?.querySelector<HTMLElement>("[data-menu]") ?? board.querySelector<HTMLElement>(".card [data-menu]");
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
        menuHeight: menu ? Math.round(menu.getBoundingClientRect().height) : 0,
        tileWidth: tile ? Math.round(tile.getBoundingClientRect().width) : null,
      } : null,
      hiddenCount: board.querySelector("[data-hidden-pill] .count")?.textContent ?? null,
      cards: board.querySelectorAll(".card[data-id]").length,
      pipelineSections: board.querySelectorAll(".pblock").length,
    };
  }, root);

  function gateGeometry(geometry: BoardGeometry, failures: string[], label: string): void {
    const expectedMode = kanbanLayoutMode(geometry.boardWidth);
    if (geometry.mode !== expectedMode) failures.push(`${label}: mode ${geometry.mode} at board width ${geometry.boardWidth}, expected ${expectedMode}`);
    const shelves = geometry.columns.filter((column) => column.status !== "assigned" && column.visible);
    const assigned = geometry.columns.find((column) => column.status === "assigned")!;
    /* Wide shelves are balanced on large screens: equal, never under the
       prototype's 264 px, with Assigned kept at its 520 px floor or more. */
    if (expectedMode === "wide" && (shelves.some((column) => column.width < 263.5) || Math.max(...shelves.map((c) => c.width)) - Math.min(...shelves.map((c) => c.width)) > 1 || assigned.width < 519.5)) failures.push(`${label}: wide shelves ${shelves.map((c) => c.width)}, Assigned ${assigned.width}`);
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
            /* The wide grid no longer caps its shelves at the prototype's 264 px, so only narrow compares. */
            if (prototype && production.mode === prototype.mode && production.mode === "narrow") {
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

        await page.click('.card[data-id="task:t-disk"] [data-menu]');
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
        await page.click('.card[data-id="task:t-verify-a"] [data-menu]');
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
        await undo.page.click('.card[data-id="task:t-merge-a"] [data-menu]');
        await undo.page.click('.menu [role="menuitemradio"]:has-text("Done")');
        await undo.page.waitForFunction(() => document.querySelector('.card[data-id="task:t-merge-a"]')?.getAttribute("data-pending") === "0", undefined, { timeout: 5_000 });
        await undo.page.keyboard.press("u");
        await undo.page.waitForFunction(() => document.querySelector('.card[data-id="task:t-merge-a"]')?.getAttribute("data-pending") === "0", undefined, { timeout: 5_000 });
        await undo.page.waitForTimeout(200);
        const undone = { column: await columnOf("t-merge-a"), patches: await patches() };
        if (undone.column !== "assigned" || undone.patches !== 2) failures.push(`undo: U while the receipt shows left ${JSON.stringify(undone)}`);

        await undo.page.click('.card[data-id="task:t-disk"] [data-menu]');
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
   *   - the seat is centred, at most 1040 px wide, at the default height
   *     75dvh with at least two transcript rows and a
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
            const expected = Math.round(viewport.height * 0.75);
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
              /* Reading width: 420–460 px, or a balanced shelf's width where that is wider. */
              const ceiling = Math.max(460, readers.columns.done ?? 0);
              if ((mode === "wide" || mode === "narrow") && (blocked < 420 || blocked > ceiling + 1 || !readers.reading)) failures.push(`${label}: Blocked holding a reader is ${blocked}px (reading=${readers.reading})`);
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
        await page.click(`${card("t-export")} [data-menu]`);
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
      const section = `${card(id)} .pblock`;
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
          /* Binding correction 4: every card starts on the summary. The lane
             row (#2072) draws the summary as its chain of pills with no graph
             slot, and its toggle puts the graph in the chain's place. */
          await page.locator(`${card("t-search")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(300);
          const view = (selector: string) => page.evaluate((scope) => ({
            chain: document.querySelectorAll(`${scope} .pblock .pb-chain`).length,
            graphs: document.querySelectorAll(`${scope} .pblock .pb-graph`).length,
            nodes: document.querySelectorAll(`${scope} .pnode`).length,
            pressed: document.querySelector(`${scope} [data-graph-toggle]`)?.getAttribute("aria-pressed") ?? null,
            chips: document.querySelectorAll(`${scope} .pb-chain .pb-pills .pb-pill`).length,
          }), selector);
          const fresh = await view(card("t-search"));
          await shot(page, "production", "summary-default", scheme);
          if (fresh.chain !== 1 || fresh.graphs !== 0 || fresh.nodes !== 0 || fresh.pressed !== "false" || fresh.chips !== 4) failures.push(`retry card default ${scheme}: ${JSON.stringify(fresh)}`);
          frames[`summary-default-${scheme}`] = { production: fresh };
          await openGraph(page, "t-search");
          const opened = await view(card("t-search"));
          if (opened.chain !== 0 || opened.graphs !== 1 || opened.pressed !== "true") failures.push(`retry card graph ${scheme}: the graph did not take the summary's place ${JSON.stringify(opened)}`);
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
          /* The same toggle brings the summary back, all four stages with it. */
          await page.click(`${card("t-search")} .pblock [data-graph-toggle]`);
          await page.waitForSelector(`${card("t-search")} .pblock .pb-chain`, { timeout: 5_000 });
          const back = await view(card("t-search"));
          if (back.chain !== 1 || back.graphs !== 0 || back.nodes !== 0 || back.pressed !== "false" || back.chips !== 4) failures.push(`retry card summary again ${scheme}: ${JSON.stringify(back)}`);
        });
        await prototype("scrollto=t-search", scheme, `prototype retry graph ${scheme}`, async (page) => {
          await page.locator(`${protoCard("t-search")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(300);
          const graph = await measureGraph(page, protoCard("t-search"));
          await shot(page, "prototype", "graph-branch-retry", scheme);
          Object.assign(frames[`graph-branch-retry-${scheme}`] as object ?? {}, { prototype: graph });
        });
      }

      await production("light", "two-stage graph", async (page) => {
        await openGraph(page, "t-links");
        await page.locator(`${card("t-links")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(250);
        const graph = await measureGraph(page, card("t-links"));
        await shot(page, "production", "graph-two-stage", "light");
        frames["graph-two-stage"] = { production: graph };
        if (graph?.dir !== "LR" || graph.nodes.some((node) => node.width !== 176 || node.height !== 76)) failures.push(`two-stage graph: ${JSON.stringify(graph)}`);
      }, WIDE);
      await prototype("scrollto=t-links", "light", "prototype two-stage graph", async (page) => {
        await page.locator(`${protoCard("t-links")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(300);
        Object.assign(frames["graph-two-stage"] as object, { prototype: await measureGraph(page, protoCard("t-links")) });
        await shot(page, "prototype", "graph-two-stage", "light");
      }, WIDE);

      await production("light", "five review rounds", async (page) => {
        await openGraph(page, "t-rounds");
        await page.locator(`${card("t-rounds")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
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
        const section = `${card("t-search")} .pblock`;
        await openGraph(page, "t-search");
        await page.click(`${section} .pnode[data-stage="implement"]`);
        await page.waitForSelector(`${card("t-search")} [data-kanban-reader]`, { timeout: 10_000 });
        await page.waitForTimeout(300);
        const node = await page.evaluate((selector) => ({
          pressed: document.querySelector(`${selector} .pnode[data-stage="implement"]`)?.getAttribute("aria-pressed"),
          reader: document.querySelector<HTMLElement>(`${selector.replace(" .pblock", "")} [data-kanban-reader]`)?.dataset.kanbanReader ?? null,
        }), section);
        await shot(page, "production", "node-reader", "light");
        await page.click(`${section} [data-graph-toggle]`);
        const summary = await page.evaluate((selector) => ({ nodes: document.querySelectorAll(`${selector} .pnode`).length, chips: document.querySelectorAll(`${selector} .pb-pill`).length }), section);
        /* The historical helper was adopted last; the node opens and marks Implement's own latest attempt. */
        if (node.pressed !== "true" || node.reader !== "conversation_search-impl-2") failures.push(`node: ${JSON.stringify(node)}`);
        if (summary.nodes !== 0 || summary.chips !== 4) failures.push(`toggle back: ${JSON.stringify(summary)}`);
        flows.toggleAndNode = { node, summary };
      });

      await production("light", "live edge", async (page) => {
        type Hook = { evidence: { addStageAttempt: (pipelineId: string, stageId: string, over: Record<string, unknown>) => void } };
        const section = `${card("t-search")} .pblock`;
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
   *   - the eight-stage sheet: header, graph direction, one pane per stage at
   *     the prototype's pane width, four waiting stages each with an unsent
   *     first message and no composer, the live stage focused. Each stage is
   *     drawn once (#2148): while the graph is shown it is the navigation, so
   *     the chip strip is drawn only with the graph hidden;
   *   - the retry sheet: attempt tabs on Implement and Verify, the loop on the
   *     graph's fail edge;
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
    /** The lane's controls in the sheet's head (#2148), and nothing else of them. */
    headControls: string[];
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
      /* The loop is the chip strip's loop chip, or the graph's fail edge. */
      loops: [...sheet.querySelectorAll(".gs-nav .ploop, .gs-graph .pelabel.fail")].map(text),
      graphDir: sheet.querySelector<HTMLElement>(".gs-graph .pgraph")?.dataset.dir ?? null,
      graphNodes: sheet.querySelectorAll(".gs-graph .pnode").length,
      headControls: [...sheet.querySelectorAll<HTMLElement>(".lane-bar button")].map((button) => (button.closest("header") ? "" : "outside:") + (button.getAttribute("aria-label") ?? text(button))),
      focusedPane: (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".pane[data-stage]")?.dataset.stage ?? null,
      panes: [...sheet.querySelectorAll<HTMLElement>(".pane[data-stage]")].map((pane) => ({
        stage: pane.dataset.stage ?? "",
        width: Math.round(pane.getBoundingClientRect().width),
        folded: pane.classList.contains("folded"),
        attempts: [...pane.querySelectorAll(".attempts button")].map(text),
        draft: Boolean(pane.querySelector(".msg.user.draft")),
        status: pane.querySelector(".bstatus") ? text(pane.querySelector(".bstatus")) : null,
        /* A waiting stage has nothing to reply to, so no composer (#2148). */
        composerDisabled: pane.querySelector<HTMLTextAreaElement>(".pane-conv.draft textarea:disabled, .composer2") ? true : null,
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
      /* No closed composer under a waiting stage's message any more (#2148). */
      composerDisabled: Boolean(panel.querySelector<HTMLTextAreaElement>(".composer2 textarea, textarea:disabled")),
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
      await page.locator(`${card(taskId)} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
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
          /* The graph is shown and is the navigation: no chip strip beside it. */
          if (sheet.panes.length !== 8 || sheet.navChips !== 0) failures.push(`stages ${scheme}: ${sheet.panes.length} panes, ${sheet.navChips} chips`);
          if (sheet.graphDir !== "LR" || sheet.graphNodes !== 8) failures.push(`stages ${scheme}: graph ${sheet.graphDir} ${sheet.graphNodes}`);
          if (JSON.stringify(sheet.headControls) !== JSON.stringify(["Collapse finished", "Expand all", "Previous stage", "Next stage"])) failures.push(`stages ${scheme}: head controls ${JSON.stringify(sheet.headControls)}`);
          const waiting = sheet.panes.filter((pane) => pane.draft);
          if (waiting.map((pane) => pane.stage).join() !== "review-ui,verify,docs,merge") failures.push(`stages ${scheme}: waiting panes ${JSON.stringify(waiting)}`);
          if (waiting.some((pane) => pane.status !== "First message · not sent yet" || pane.composerDisabled !== null)) failures.push(`stages ${scheme}: waiting panes ${JSON.stringify(waiting)}`);
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
        /* The graph's node is the navigation while the graph is shown. */
        await page.click('.gsheet .gs-graph .pnode[data-stage="implement"]');
        await page.waitForTimeout(700);
        const sheet = await measureSheet(page);
        await shot(page, "production", "stages-retry", "light");
        frames["stages-retry"] = { production: sheet };
        const byStage = new Map(sheet?.panes.map((pane) => [pane.stage, pane] as const));
        if (JSON.stringify(byStage.get("implement")?.attempts) !== JSON.stringify(["#1 · passed", "#2 · passed"])) failures.push(`stages retry: implement tabs ${JSON.stringify(byStage.get("implement")?.attempts)}`);
        if (JSON.stringify(byStage.get("verify")?.attempts) !== JSON.stringify(["#1 · failed", "#2 · running"])) failures.push(`stages retry: verify tabs ${JSON.stringify(byStage.get("verify")?.attempts)}`);
        if (sheet?.loops.length !== 1) failures.push(`stages retry: loops ${JSON.stringify(sheet?.loops)}`);
        /* Hidden, the graph gives way to the chips, whose loop chip says the rounds. */
        await page.click(".gsheet [data-sheet-graph]");
        await page.waitForTimeout(300);
        const chips = await measureSheet(page);
        if (chips?.navChips !== 4 || chips.graphNodes !== 0 || chips.loops.length !== 1) failures.push(`stages retry, graph hidden: ${JSON.stringify({ navChips: chips?.navChips, graphNodes: chips?.graphNodes, loops: chips?.loops })}`);
      });
      await prototype("sheet=t-search:implement", "light", "prototype stages retry", async (page) => {
        await page.waitForSelector(".gsheet .pane[data-stage]", { timeout: 10_000 });
        await page.waitForTimeout(500);
        frames["stages-retry"] = { ...frames["stages-retry"], prototype: await measureSheet(page) };
        await shot(page, "prototype", "stages-retry", "light");
      });

      await production("light", "stage details and save", async (page) => {
        const section = `${card("t-links")} .pblock`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .pb-pills [data-stage="review"]`);
        const panel = `${card("t-links")} [data-stage-detail]`;
        await page.waitForSelector(panel, { timeout: 5_000 });
        await page.locator(panel).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(400);
        const detail = await measureDetail(page, panel);
        await shot(page, "production", "stage-details", "light");
        frames["stage-details"] = { production: detail };
        if (detail?.bubble !== "Check both anchors against the published notes before approving." || detail.status !== "First message · not sent yet" || !detail.edit || detail.composerDisabled) failures.push(`stage details: ${JSON.stringify(detail)}`);
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
        if (!/^First message · not sent yet · edited \d/.test(status ?? "")) failures.push(`stage draft status: ${status}`);
      });
      await prototype("stage=t-links:review", "light", "prototype stage details", async (page) => {
        const panel = '[data-stage-detail="t-links|review"]';
        await page.waitForSelector(panel, { timeout: 10_000 });
        await page.waitForTimeout(400);
        frames["stage-details"] = { ...frames["stage-details"], prototype: await measureDetail(page, panel) };
        await shot(page, "prototype", "stage-details", "light");
      }, "board");

      await production("light", "stage started during save", async (page) => {
        const section = `${card("t-links")} .pblock`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .pb-pills [data-stage="review"]`);
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
        const section = `${card("t-links")} .pblock`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .pb-pills [data-stage="review"]`);
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
        await page.click('.gsheet .gs-graph .pnode[data-stage="docs"]');
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
        const section = `${card("t-upload")} .pblock`;
        /* The lane's actions are a group in the card's one ⋯ (#2148). */
        const laneMenu = `${card("t-upload")} [data-menu]`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        if (await page.locator(`${section} [data-pipeline-menu]`).count()) failures.push("pipeline actions: the lane still draws a ⋯ of its own");
        await page.click(laneMenu);
        await page.waitForTimeout(350);
        await shot(page, "production", "pipeline-menu", "light");
        await page.locator('.menu [role="menuitem"]', { hasText: "Pause" }).first().click();
        await page.waitForSelector(`${section} [data-pipeline-acting="pause"]`, { timeout: 2_000 });
        const pending = await page.locator(`${section} [data-pipeline-acting]`).textContent();
        await page.waitForSelector(`${section} .pstate-chip[data-pstate="paused"]`, { timeout: 5_000 });
        const pausedReceipt = await page.locator("[data-kanban-receipt] .msg").last().textContent();
        await page.evaluate(() => { (window as unknown as Hook).evidence.refuseNextPipelinePatch = { status: 409, error: "the runtime host did not answer" }; });
        await page.click(laneMenu);
        await page.locator('.menu [role="menuitem"]', { hasText: "Resume" }).first().click();
        await page.waitForSelector("[data-kanban-receipt].error", { timeout: 5_000 });
        await page.waitForTimeout(350);
        const refused = await page.locator("[data-kanban-receipt].error .msg").textContent();
        await shot(page, "production", "pipeline-refused", "light");
        await page.click("[data-kanban-receipt].error .act");
        await page.waitForSelector(`${section} .pstate-chip[data-pstate="running"]`, { timeout: 5_000 });
        /* The pause is carried out and its answer lost: not confirmed, and Check again only reads. */
        await page.evaluate(() => { (window as unknown as Hook).evidence.loseNextPipelineAnswer = true; });
        await page.click(laneMenu);
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
        const section = `${card("t-links")} .pblock`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.evaluate(() => { (window as unknown as Hook).evidence.refuseNextPipelinePatch = { status: 409, error: "the stage worktree has uncommitted changes" }; });
        await page.click(`${card("t-links")} [data-menu]`);
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
        const section = `${card("t-upload")} .pblock`;
        await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${section} .pb-pills [data-stage="build-ui"]`);
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
          /* The graph marks the stage in focus while it is the navigation. */
          current: document.querySelector<HTMLElement>(".gsheet .gs-graph .pnode.selected")?.dataset.stage ?? null,
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
        /* #2148 draws each stage once: with the graph shown the prototype's chip
           strip and its "Stage k of n" bar are gone, so the chip count and the
           loop's place are recorded here and not compared. */
        comparison[key] = { panes: [ours.panes.length, theirs.panes.length], navChips: [ours.navChips, theirs.navChips], loops: [ours.loops.length, theirs.loops.length], graphDir: [ours.graphDir, theirs.graphDir], graphNodes: [ours.graphNodes, theirs.graphNodes], widths, drafts, attempts };
        if (ours.panes.length !== theirs.panes.length) failures.push(`${key}: structure ${JSON.stringify(comparison[key])}`);
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
        /* #2148 says a waiting stage once: the status words and the closed
           composer depart from the prototype on purpose, and are recorded, not
           compared. */
        if (detail.production.edit !== detail.prototype.edit) failures.push(`stage-details: ${JSON.stringify(comparison["stage-details"])}`);
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
   *     then "with the next message" with the target known to this page only (the
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
      await page.locator(`${card("t-search")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.click(`${card("t-search")} .pb-pills [data-stage="verify"]`);
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
        await page.locator(`${card("t-links")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.click(`${card("t-links")} .pb-pills [data-stage="review"]`);
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
          if (!pending || !pending.chip.pending || pending.chip.when !== "with the next message") failures.push(`pending switch: chip ${JSON.stringify(pending?.chip)}`);
          if (JSON.stringify(pending?.now.at(-1)) !== JSON.stringify(["Pending", "Account G · moves with the next message"])) failures.push(`pending switch: summary ${JSON.stringify(pending?.now)}`);
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
        if (!recorded?.chip.pending || source !== "record" || !recorded.notes.includes("Messages sent now are held and delivered after the switch, in the order they were sent. Cancel delivers them on the current account instead.") || !recorded.notes.includes("Not carried: a message bound to the current turn, injected context, or attachments only the sending browser holds. Each ends failed with its reason, keeps the text the Viewer holds for it, and its receipt says whether sending it again is safe.") || !recorded.cancel) failures.push(`recorded switch: ${JSON.stringify({ recorded, source })}`);
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

describe("#1846 one account pick, every surface in the same frame", () => {
  /*
   * Rendered evidence for the account pick's shared store (#1846, critique P1): the running verify
   * conversation on a structured host (`&runtime=structured` answers one runtime session), so the reader's
   * composer draws its runtime pill beside the board's account chip. A pick made in either one must show in
   * the other in the frame of the click, before any answer or projection: the fixture's runtime snapshot
   * never projects the pick, so whatever shows came from the page's own store.
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "#1846"
   *
   * Measurements go to `evidence/issue-1846/shared-pick.json`; frames to `.artifacts/issue-1846/`.
   */
  const OUT = path.resolve(".artifacts/issue-1846");
  const EVIDENCE = path.resolve("evidence/issue-1846");
  const READER = '[data-reader-path="/repo/search-ver-2.jsonl"]';
  const CHIP = '[data-kanban-board] [data-account-trigger="conversation_search-ver-2"]';

  /** Clicks inside the page and reads every surface one animation frame later. */
  const clickAndRead = (page: Page, selector: string) => page.evaluate(async ([target, chip]) => {
    const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const element = document.querySelector<HTMLElement>(target);
    if (!element) return { error: `no ${target}` };
    const started = performance.now();
    element.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    return {
      ms: Math.round((performance.now() - started) * 10) / 10,
      chip: [...(document.querySelector(chip)?.querySelectorAll(".cur, .arrow, .to, .when") ?? [])].map(text).join(" "),
      pillHead: text(document.querySelector("[data-runtime-popover-account]")),
      pickerPending: text(document.querySelector(".popover.acct-pop [data-account-pending] .v")),
    };
  }, [selector, CHIP] as const);

  /* The desktop board in English at the board's own width, and at 1280 px in Ukrainian, whose «з наступним
     повідомленням» is the longer tail the chip has to hold (#1846 critique P3). */
  const PASSES = [
    { lang: "en", viewport: VIEWPORT },
    { lang: "uk", viewport: VIEWPORT },
    { lang: "en", viewport: { width: 1_280, height: 900 } },
    { lang: "uk", viewport: { width: 1_280, height: 900 } },
  ] as const;

  /** A chip-sized cell: its text, its width, and whether it draws less than its text. */
  const cellReading = (page: Page, selector: string) => page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const cut = [element, ...element.querySelectorAll<HTMLElement>("*")].some((node) => node.scrollWidth > node.clientWidth + 1);
    return {
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
      width: Math.round(box.width * 10) / 10,
      inView: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
      cut,
    };
  }, selector);

  browserTest("#1846: a pick in the runtime pill shows on the board chip, and a pick on the board shows in the pill, in one frame", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const passes: Record<string, unknown>[] = [];
    try {
      for (const { lang, viewport } of PASSES) {
        const tr = (key: Parameters<typeof translate>[1], vars?: Record<string, string>) => translate(lang, key, vars);
        /* Every surface names an account by the label its rows carry (#1846 critique P2). */
        const runsOn = tr("mobile2.composer.accountRunsOn", { account: "Account A" });
        const runsOnNext = tr("mobile2.composer.accountRunsOnNext", { account: "Account A", next: "Account C" });
        const chipMoving = `Account A → Account C ${tr("kanban.account.whenNextMessage")}`;
        const key = `${lang}-${viewport.width}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        const record: Record<string, unknown> = { lang, viewport };
        passes.push(record);
        const opened = await openFixture(browser, `${server.base}?scenario=accounts&runtime=structured`, viewport, "light", lang);
        const { page } = opened;
        try {
          await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
          await page.waitForTimeout(700);
          await page.locator(`${card("t-search")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
          await page.click(`${card("t-search")} .pb-pills [data-stage="verify"]`);
          await page.waitForSelector(CHIP, { timeout: 10_000 });
          await page.waitForSelector(`${READER} [data-runtime-pill]`, { state: "attached", timeout: 10_000 });
          await page.waitForTimeout(500);
          record.before = await page.evaluate((chip) => document.querySelector(chip)?.textContent?.replace(/\s+/g, " ").trim() ?? "", CHIP);

          /* 1. The pill's Account panel picks Account C. */
          await page.locator(`${READER} [data-runtime-pill]`).evaluate((element) => { element.scrollIntoView({ block: "center" }); (element as HTMLElement).click(); });
          await page.waitForSelector('[data-runtime-row="submenu"][data-runtime-value="account"]', { timeout: 5_000 });
          await page.click('[data-runtime-row="submenu"][data-runtime-value="account"]');
          await page.waitForSelector('[data-runtime-row="account"][data-runtime-value="account-account-c"]', { timeout: 5_000 });
          const pillPick = await clickAndRead(page, '[data-runtime-row="account"][data-runtime-value="account-account-c"]');
          record.pillPick = pillPick;
          await page.waitForTimeout(200);
          /* The popover closed with the pick: the pill it was made on carries it (critique P3), and the board chip
             and the reader's account chip hold the longer tail whole. */
          record.pillMark = await cellReading(page, `${READER} [data-runtime-pill-next-account]`);
          record.boardChip = await cellReading(page, CHIP);
          /* The reader's own header chip, in the board column that holds the reader: the narrow pane. The
             conversation pane's «@ A → B» badge is not mounted here — a kanban reader replaces the pane's
             header with this one — so the reading below also records that it is absent. */
          record.readerChip = await cellReading(page, `${READER} [data-account-trigger]`);
          record.readerWidth = await page.evaluate((reader) => Math.round((document.querySelector(reader)?.getBoundingClientRect().width ?? 0) * 10) / 10, READER);
          record.paneBadges = await page.evaluate(() => document.querySelectorAll("[data-conversation-account-chip]").length);
          await page.screenshot({ path: path.join(OUT, `${key}-pill-pick-chip.png`) });
          if (!("chip" in pillPick) || pillPick.chip !== chipMoving) fail(`pill pick: chip ${JSON.stringify(pillPick)}`);
          const pillMark = record.pillMark as Awaited<ReturnType<typeof cellReading>>;
          if (pillMark?.text !== "→ Account C" || pillMark.cut) fail(`the pill's face carries the pick: ${JSON.stringify(pillMark)}`);
          const boardChip = record.boardChip as Awaited<ReturnType<typeof cellReading>>;
          if (boardChip?.cut !== false) fail(`the board chip holds its tail whole: ${JSON.stringify(boardChip)}`);
          const readerChip = record.readerChip as Awaited<ReturnType<typeof cellReading>>;
          if (!readerChip || readerChip.cut || !readerChip.text.includes("Account C")) fail(`the reader's header chip names the pick whole: ${JSON.stringify(readerChip)}`);

          /* 2. The board picker, opened now, says the same thing. */
          await page.click(CHIP);
          await page.waitForSelector(".popover.acct-pop .acct-row", { timeout: 5_000 });
          const picker = await page.evaluate(() => ({
            pending: document.querySelector(".popover.acct-pop [data-account-pending] .v")?.textContent?.trim() ?? null,
            source: document.querySelector(".popover.acct-pop [data-account-pending]")?.getAttribute("data-account-source") ?? null,
            checked: [...document.querySelectorAll('.popover.acct-pop .acct-row[aria-checked="true"]')].map((row) => (row as HTMLElement).dataset.account),
          }));
          record.pickerAfterPillPick = picker;
          await page.screenshot({ path: path.join(OUT, `${key}-pill-pick-picker.png`) });
          if (picker.pending !== tr("kanban.account.pendingNextMessage", { target: "Account C" }) || picker.source !== "pick" || JSON.stringify(picker.checked) !== JSON.stringify(["account-c"])) fail(`board picker after the pill's pick: ${JSON.stringify(picker)}`);

          /* 3. The board picker takes it back: the pill's line and its face follow in the same frame. */
          const boardBack = await clickAndRead(page, '.popover.acct-pop [data-account-cancel]');
          record.boardTakeBack = boardBack;
          record.pillMarkAfterTakeBack = await cellReading(page, `${READER} [data-runtime-pill-next-account]`);
          await page.locator(`${READER} [data-runtime-pill]`).evaluate((element) => (element as HTMLElement).click());
          await page.waitForSelector("[data-runtime-popover-account]", { timeout: 5_000 });
          const pillAfterBack = await page.evaluate(() => document.querySelector("[data-runtime-popover-account]")?.textContent?.trim() ?? "");
          record.pillAfterBoardTakeBack = pillAfterBack;
          if (!("chip" in boardBack) || boardBack.chip !== "Account A" || pillAfterBack !== runsOn || record.pillMarkAfterTakeBack !== null) fail(`board take-back: ${JSON.stringify({ boardBack, pillAfterBack, mark: record.pillMarkAfterTakeBack })}`);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(200);

          /* 4. A pick in the board picker, then the pill's popover. */
          await page.locator(`${READER} [data-runtime-pill]`).evaluate((element) => (element as HTMLElement).click());
          await page.waitForSelector("[data-runtime-popover-account]", { timeout: 5_000 });
          const pillHeadBefore = await page.evaluate(() => document.querySelector("[data-runtime-popover-account]")?.textContent?.trim() ?? "");
          await page.keyboard.press("Escape");
          await page.click(CHIP);
          await page.waitForSelector(".popover.acct-pop .acct-row", { timeout: 5_000 });
          const boardPick = await clickAndRead(page, '.popover.acct-pop .acct-row[data-account="account-c"]');
          record.boardPick = boardPick;
          await page.locator(`${READER} [data-runtime-pill]`).evaluate((element) => (element as HTMLElement).click());
          await page.waitForSelector("[data-runtime-popover-account]", { timeout: 5_000 });
          const pillHeadAfter = await page.evaluate(() => document.querySelector("[data-runtime-popover-account]")?.textContent?.trim() ?? "");
          record.pillHead = { before: pillHeadBefore, after: pillHeadAfter };
          await page.screenshot({ path: path.join(OUT, `${key}-board-pick-pill.png`) });
          if (pillHeadBefore !== runsOn || pillHeadAfter !== runsOnNext) fail(`pill after the board's pick: ${JSON.stringify(record.pillHead)}`);
          if (!("chip" in boardPick) || boardPick.chip !== chipMoving) fail(`board pick: chip ${JSON.stringify(boardPick)}`);

          record.requests = await page.evaluate(() => {
            const evidence = (window as unknown as { evidence: { pillRequests: Array<Record<string, unknown>>; accountRequests: Array<Record<string, unknown>>; migrationRequests: unknown[] } }).evidence;
            return { pill: evidence.pillRequests.map((body) => body.accountId), board: evidence.accountRequests.map((body) => body.accountId), migrations: evidence.migrationRequests.length };
          });
          const requests = record.requests as { pill: unknown[]; board: unknown[]; migrations: number };
          if (JSON.stringify(requests.pill) !== JSON.stringify(["account-c"]) || JSON.stringify(requests.board) !== JSON.stringify(["default", "account-c"]) || requests.migrations !== 0) fail(`requests: ${JSON.stringify(requests)}`);
          if (opened.pageErrors.length) fail(`page errors ${opened.pageErrors.join(" | ")}`);
        } finally {
          await opened.context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "shared-pick.json"), `${JSON.stringify({ passes, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 300_000);
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
    const rows = [...card.querySelectorAll<HTMLElement>(".pblock")].map((row) => ({
      pipeline: row.dataset.pipeline ?? "",
      title: text(row.querySelector(".pb-title")),
      hover: row.querySelector(".pb-title")?.getAttribute("title") ?? "",
      state: text(row.querySelector(".pstate-chip")),
      pills: [...row.querySelectorAll(".pb-pills .pname, .pnode .pname")].map((pill) => text(pill)),
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

describe("#1938 a spent review budget ends visibly on the card and the phone", () => {
  /*
   * Rendered evidence for #1938: the real Viewer over
   * `issue1695Evidence.fixture.tsx?scenario=issue1938`, in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=$(which google-chrome-stable) \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t 1938
   *
   * One task holds one lane whose critique failed on its only round, whose
   * findings went to one more build, and whose build wrote a new head. At
   * 1280 px the lane row's state word says needs review and its answer names
   * the last verdict, the reviewed head and the unreviewed current head; the
   * card never reads completed. At 390 px the phone queues the lane under
   * Needs you as a pipeline card with a «needs review» badge and the heads line
   * shortened to the unreviewed head (#2072 §3.4).
   *
   * Measurements go to `evidence/issue-1938/board.json`; frames to
   * `.artifacts/issue-1938/`, which is not committed.
   */
  const OUT = path.resolve(".artifacts/issue-1938");
  const EVIDENCE = path.resolve("evidence/issue-1938");
  const CARD = '[data-kanban-board] .card[data-id="task:t-review-spent"]';
  const HEADS = translate("en", "pipelineReview.heads", { verdict: "fail", reviewed: "4f1c2a9d", current: "9b2e7d4c" });
  const STATE = en["pipelineState.needs_review"];

  browserTest("#1938: the card and the phone name needs_review with the last verdict and both heads, never completed", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=issue1938`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, unknown> = {};
    try {
      for (const scheme of ["light", "dark"] as const) {
        const opened = await openFixture(browser, base, { width: 1280, height: 900 }, scheme);
        try {
          await opened.page.waitForSelector(CARD, { state: "attached", timeout: 20_000 });
          await opened.page.locator(CARD).evaluate((element) => element.scrollIntoView({ block: "center" }));
          await opened.page.waitForTimeout(500);
          const measured = await opened.page.evaluate((selector) => {
            const card = document.querySelector(selector);
            const row = card?.querySelector<HTMLElement>('.pblock[data-pipeline="p-review-spent"]');
            const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? "";
            /* In the head row, or on the chain row where the chain is the head (#2148). */
            const chip = row?.querySelector<HTMLElement>(".pb-head .pstate-word, .pb-tail .pstate-word");
            const note = row?.querySelector<HTMLElement>("[data-review-heads]");
            const title = row?.querySelector<HTMLElement>(".pb-title");
            const box = (node: HTMLElement | null | undefined) => node ? (({ x, y, width, height }) => ({ x, y, width, height }))(node.getBoundingClientRect()) : null;
            return {
              drawn: Boolean(row),
              state: chip?.dataset.pstate ?? null,
              chip: text(chip),
              note: text(note),
              label: row?.getAttribute("aria-label") ?? "",
              cardText: text(card),
              chipBox: box(chip),
              noteBox: box(note),
              noteClipped: note ? note.scrollWidth > note.clientWidth : null,
              titleClipped: title ? title.scrollWidth > title.clientWidth : null,
            };
          }, CARD);
          await opened.page.locator(CARD).screenshot({ path: path.join(OUT, `issue-1938-1280-${scheme}.png`) });
          frames[`1280-${scheme}`] = measured;
          if (!measured.drawn) failures.push(`1280 ${scheme}: the lane was not drawn on its card`);
          if (measured.state !== "needs_review") failures.push(`1280 ${scheme}: the chip's state is ${measured.state}`);
          if (measured.chip !== STATE) failures.push(`1280 ${scheme}: the chip reads ${JSON.stringify(measured.chip)}`);
          if (measured.note !== HEADS) failures.push(`1280 ${scheme}: the note reads ${JSON.stringify(measured.note)}`);
          if (!measured.label.includes(HEADS)) failures.push(`1280 ${scheme}: the row's label omits the heads: ${JSON.stringify(measured.label)}`);
          if (!measured.noteBox?.width || measured.noteClipped) failures.push(`1280 ${scheme}: the heads line is not fully drawn: ${JSON.stringify(measured.noteBox)}`);
          if (/completed/i.test(measured.cardText)) failures.push(`1280 ${scheme}: the card says completed`);
          if (opened.pageErrors.length) failures.push(`1280 ${scheme}: page errors ${opened.pageErrors.join(" | ")}`);
        } finally {
          await opened.context.close();
        }
      }

      const phone = await openFixture(browser, base, { width: 390, height: 844 }, "light");
      try {
        const ROW = '[data-mobile2-pipeline-row="p-review-spent"]';
        await phone.page.waitForSelector(ROW, { state: "attached", timeout: 20_000 });
        await phone.page.locator(ROW).first().evaluate((element) => element.scrollIntoView({ block: "center" }));
        await phone.page.waitForTimeout(500);
        const measured = await phone.page.evaluate((selector) => {
          const row = document.querySelector<HTMLElement>(selector);
          const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? "";
          const meta = row?.querySelector<HTMLElement>("[data-pipeline-reason]");
          return {
            state: row?.dataset.mobile2State ?? null,
            text: text(row),
            meta: text(meta),
            width: row?.getBoundingClientRect().width ?? null,
            overflows: row ? row.scrollWidth > row.clientWidth : null,
          };
        }, ROW);
        await phone.page.locator(ROW).first().screenshot({ path: path.join(OUT, "issue-1938-390.png") });
        await phone.page.screenshot({ path: path.join(OUT, "issue-1938-390-board.png"), fullPage: true });
        frames["390"] = measured;
        if (measured.state !== "needs_review") failures.push(`390: the row's state is ${measured.state}`);
        const SHORT = translate("en", "pipelineBlock.reason.review", { current: "9b2e7d4c" });
        if (!measured.meta.startsWith(SHORT)) failures.push(`390: the card's reason omits the unreviewed head: ${JSON.stringify(measured.meta)}`);
        if (!measured.text.includes(en["mobile2.pipelines.badgeReview"])) failures.push(`390: the row has no needs review badge: ${JSON.stringify(measured.text)}`);
        if (measured.overflows) failures.push("390: the row overflows its width");
        if (phone.pageErrors.length) failures.push(`390: page errors ${phone.pageErrors.join(" | ")}`);
      } finally {
        await phone.context.close();
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "board.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#1865 stage conversations lead with the stage and its attempt", () => {
  /*
   * Rendered evidence for #1865: the real Viewer over
   * `issue1695Evidence.fixture.tsx?scenario=issue1865`, with the production
   * stylesheet, in Chromium, at 1440 and 1280, in English and Ukrainian, light
   * and dark:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=$(which google-chrome-stable) \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "#1865"
   *
   * The seeded task carries the header lane the operator read: design → build
   * → critique, where design and critique share the architect preset and
   * critique ran twice. Three of its stage conversations are opened on the
   * card — design, critique's latest attempt from the lane's row, and
   * critique's first from Past attempts — and each reader header is gated: it
   * leads with the stage's name, with the attempt once the stage ran twice
   * (`Design`, `Critique · 1`, `Critique · 2`), the three are distinct, none
   * names the preset, the preset is in the header's tooltip, and the label
   * itself is drawn whole. The Stages sheet is then opened and its panes must
   * name the same stages letter for letter.
   *
   * Measurements go to `evidence/issue-1865/board.json`; frames to
   * `.artifacts/issue-1865/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1865");
  const EVIDENCE = path.resolve("evidence/issue-1865");
  const CARD = card("t-labels");
  const TASK = "Build the board header lane";
  const LABELS = ["Design", "Critique · 1", "Critique · 2"];

  interface Header { text: string; hint: string; label: string; labelWhole: boolean; width: number; attempt: { text: string; muted: boolean; tabular: boolean } | null }
  interface Tile { name: string; attempt: string; hint: string; nameWhole: boolean; attemptMuted: boolean }

  /** Each reader header on the card, whether its leading stage label is painted
      whole, and how its attempt suffix is set apart from the bold name. */
  const measureHeaders = (page: Page) => page.evaluate(({ selector, labels }): Header[] => {
    const cardEl = document.querySelector(selector);
    return [...(cardEl?.querySelectorAll<HTMLElement>(".conv-head .ch-title") ?? [])].map((title) => {
      const text = title.textContent ?? "";
      const label = labels.filter((candidate) => text.startsWith(`${candidate} · `)).sort((a, b) => b.length - a.length)[0] ?? "";
      const box = title.getBoundingClientRect();
      const suffix = title.querySelector<HTMLElement>(".attempt");
      /* The label ends where the attempt suffix ends, or with the name. */
      let end: DOMRect | null = null;
      if (suffix) end = suffix.getBoundingClientRect();
      else if (label && title.firstChild?.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.setStart(title.firstChild, 0);
        range.setEnd(title.firstChild, label.length);
        end = range.getBoundingClientRect();
      }
      const labelWhole = !!label && !!end && box.width > 0 && end.right <= box.right + 0.5;
      const attempt = suffix ? (() => {
        const style = getComputedStyle(suffix);
        return { text: suffix.textContent ?? "", muted: style.color !== getComputedStyle(title).color, tabular: style.fontVariantNumeric.includes("tabular-nums") };
      })() : null;
      return { text, hint: title.getAttribute("title") ?? "", label, labelWhole, width: Math.round(box.width * 10) / 10, attempt };
    });
  }, { selector: CARD, labels: LABELS });

  /** Each stage tile on the card: its name, its attempt suffix, and whether the
      name is drawn whole. */
  const measureTiles = (page: Page) => page.evaluate((selector): Tile[] => {
    const cardEl = document.querySelector(selector);
    return [...(cardEl?.querySelectorAll<HTMLElement>(".tile") ?? [])].map((tile) => {
      const role = tile.querySelector<HTMLElement>(".role");
      const suffix = tile.querySelector<HTMLElement>(".attempt");
      return {
        name: role?.textContent ?? "",
        attempt: suffix?.textContent ?? "",
        hint: role?.getAttribute("title") ?? "",
        nameWhole: !!role && role.scrollWidth <= role.clientWidth + 0.5,
        attemptMuted: !!suffix && !!role && getComputedStyle(suffix).color !== getComputedStyle(role).color,
      };
    });
  }, CARD);

  /** A pointer click at the centre of the first match: the board's chips and
      Past attempts' buttons are real targets under the mouse. */
  const clickAt = async (page: Page, selector: string) => {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`nothing drawn at ${selector}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(350);
  };

  browserTest("#1865: each stage conversation on the card names its stage and attempt, as the stage list does", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=issue1865`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: unknown[] = [];
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const scheme of ["light", "dark"] as const) {
          for (const width of [1440, 1280]) {
            const label = `${width}-${lang}-${scheme}`;
            const viewport = { width, height: 900 };
            const opened = await openFixture(browser, base, viewport, scheme, lang);
            const fail = (text: string) => failures.push(`${label}: ${text}`);
            try {
              await opened.page.waitForSelector(CARD, { state: "attached", timeout: 20_000 });
              await opened.page.locator(CARD).evaluate((element) => element.scrollIntoView({ block: "start" }));
              await opened.page.waitForTimeout(500);
              await clickAt(opened.page, `${CARD} .pb-pill[data-stage="design"]`);
              await clickAt(opened.page, `${CARD} .pb-pill[data-stage="critique"]`);
              /* Critique's first attempt opens from the card's Past attempts,
                 which the card keeps folded. */
              if (!(await opened.page.locator(`${CARD} details.history`).first().evaluate((element) => (element as HTMLDetailsElement).open))) {
                await clickAt(opened.page, `${CARD} details.history > summary`);
              }
              const pastKey = await opened.page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(`${selector} details.history [data-past]`)]
                .find((row) => /^Critique/.test(row.querySelector(".lbl")?.textContent ?? ""))?.dataset.past ?? null, CARD);
              if (!pastKey) fail("Past attempts lists no earlier critique");
              else await clickAt(opened.page, `${CARD} details.history [data-past=${JSON.stringify(pastKey)}] .hopen`);
              const headers = await measureHeaders(opened.page);
              await opened.page.locator(CARD).evaluate((element) => element.scrollIntoView({ block: "start" }));
              await opened.page.screenshot({ path: path.join(OUT, `board-${label}.png`) });

              const texts = headers.map((header) => header.text).sort();
              const expected = LABELS.map((stage) => `${stage} · ${TASK}`).sort();
              if (JSON.stringify(texts) !== JSON.stringify(expected)) fail(`reader headers ${JSON.stringify(texts)}, expected ${JSON.stringify(expected)}`);
              const preset = translate(lang, "roleCopy.architect.name" as never);
              for (const header of headers) {
                if (header.text.includes(preset)) fail(`a header names the preset: ${JSON.stringify(header.text)}`);
                if (!header.hint.includes(` · ${preset} · `)) fail(`the preset is missing from the tooltip: ${JSON.stringify(header.hint)}`);
                if (!header.labelWhole) fail(`the stage label is cut: ${JSON.stringify(header)}`);
              }
              for (const header of headers.filter((entry) => entry.label.includes(" · "))) {
                if (!header.attempt?.muted || !header.attempt.tabular) fail(`the attempt in ${JSON.stringify(header.label)} is not a muted tabular suffix: ${JSON.stringify(header.attempt)}`);
              }
              const critique2 = headers.find((header) => header.label === "Critique · 2");
              const attemptOf = translate(lang, "kanban.stageAttemptOf" as never, { stage: "Critique", n: 2, total: 2 } as never);
              if (!critique2?.hint.startsWith(attemptOf)) fail(`the latest critique's tooltip reads ${JSON.stringify(critique2?.hint)}`);

              await clickAt(opened.page, `${CARD} [data-open-stages]`);
              await opened.page.waitForSelector("[data-stages-sheet] .pane .pname", { timeout: 10_000 });
              await opened.page.waitForTimeout(400);
              const stageList = await opened.page.evaluate(() => [...document.querySelectorAll("[data-stages-sheet] .pane .pname")].map((name) => name.textContent ?? ""));
              await opened.page.screenshot({ path: path.join(OUT, `sheet-${label}.png`) });
              if (JSON.stringify(stageList) !== JSON.stringify(["1. Design", "2. Build", "3. Critique"])) fail(`the stage list reads ${JSON.stringify(stageList)}`);
              for (const header of headers) {
                const name = header.label.split(" · ")[0];
                if (!stageList.some((entry) => entry.endsWith(`. ${name}`))) fail(`${JSON.stringify(header.label)} names no stage of the list`);
              }
              /* The member tiles the card draws for stage conversations, where
                 it draws them: the same label, the suffix muted, the name whole. */
              const tiles = await measureTiles(opened.page);
              for (const tile of tiles.filter((entry) => entry.hint)) {
                if (tile.hint.startsWith(tile.name) === false) fail(`a tile's tooltip does not lead with its stage: ${JSON.stringify(tile)}`);
                if (!tile.nameWhole) fail(`a tile's stage name is cut: ${JSON.stringify(tile)}`);
                if (tile.attempt && !tile.attemptMuted) fail(`a tile's attempt is not muted: ${JSON.stringify(tile)}`);
              }
              frames.push({ label, viewport, lang, scheme, headers, tiles, stageList });
              if (opened.pageErrors.length) fail(`page errors ${opened.pageErrors.join(" | ")}`);
            } catch (error) {
              fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
            } finally {
              await opened.context.close();
            }
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "board.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#1743 engine marks, effort scale and how often an edge fired", () => {
  /*
   * Rendered evidence for #1743, on the harness the #1695 cases already use: the
   * real Viewer over `issue1695Evidence.fixture.tsx?scenario=issue1743`, with the
   * production stylesheet, in Chromium.
   *
   *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=$(which google-chrome-stable) \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * The seeded task carries two pipelines. In the first, the critique's fail edge
   * has sent the work back to the builder TWICE of three; in the second the same
   * kind of edge has spent its whole budget. Across their stages sit mixed engines,
   * all five effort levels, a long uncatalogued model, a stage edited after its
   * last launch, and a stage that has never started.
   *
   * Four surfaces are gated, each in English and in Ukrainian, light and dark:
   *
   *   card graph  — the task card's own graph at 1280 px, inside a 256 px column
   *   640 px      — the narrowest desktop, where the card graph falls to legend
   *                 mode and the arrow carries a bare badge
   *   modal graph — the same graph inside the Stages sheet, with its pane headers
   *   390 px      — the phone: its board rows AND its pipeline screen, which
   *                 draws a pipeline as stage rows rather than as a graph, for
   *                 the live pipeline and the one whose budget is spent
   *
   * What it measures, as numbers: the count on each travelled edge, whether the
   * spent edge is drawn exhausted, the engine mark and effort step on every node,
   * chip and phone stage row, which nodes read as configuration, which flag a
   * differing next attempt, and — for every node, every edge label, every loop
   * chip and every pane header — whether anything overflows the box it sits in.
   *
   * The language of each frame is proved rather than assumed: `openFixture` seeds
   * `llv_lang` before the first render, and every frame records the document's own
   * `lang` plus the strings it drew, so an English render can never again be filed
   * as Ukrainian evidence.
   *
   * Measurements go to `evidence/issue-1743/marks.json`; frames to
   * `.artifacts/issue-1743/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1743");
  const EVIDENCE = path.resolve("evidence/issue-1743");
  const CARD = card("t-marks");
  const LOOPED = '.pblock[data-pipeline="p-marks"]';
  const SPENT = '.pblock[data-pipeline="p-marks-spent"]';

  interface NodeMeasure {
    stage: string;
    engineMark: string | null;
    effortStep: string | null;
    identity: string | null;
    nextDiffers: boolean;
    model: string;
    /** The model text is ellipsized rather than widening the node. */
    modelTruncated: boolean;
    /** Pixels by which the widest child sticks out of the node's own box. */
    overflowX: number;
    overflowY: number;
  }

  interface EdgeMeasure {
    edge: string;
    fired: string | null;
    travelled: boolean;
    spent: boolean;
    /** An arrow that has just carried work animates; it is dashed while it does. */
    live: boolean;
    /** The stroke as drawn: dashed while an edge is only configured, solid once
        it has been travelled — on a pass edge exactly as on a fail edge. */
    dash: string;
    /** The circled number drawn on the arrow, when one is. */
    circle: string | null;
    /** What the label settled on when it sits beside the return lane. */
    form: string | null;
    /** The label's own text, so a language claim can be checked. */
    text: string;
    /** Pixels by which the label sticks out of the graph's own box. */
    overflowX: number;
    /** Painted area of the label in px², and the fill it paints. */
    area: number;
    fill: string;
    filled: boolean;
    /** The disc's own fill and the fill behind it: a disc painted in its
        surround is a hole, which is the pass count's drawing, not a fail's. */
    circleFill: string;
    markFill: string;
  }

  interface GraphMeasure {
    nodes: NodeMeasure[];
    edges: EdgeMeasure[];
    /** Effective on-screen px of the identity row's 10 px caption text. */
    captionPx: number;
    identityWords: string | null;
    /** Rows the graph moved under itself because a label did not fit beside it.
        The key must sample the SAME mark the arrow above it carries. */
    legend: Array<{ edge: string; text: string; circle: string | null; filled: boolean; spent: boolean }>;
  }

  const READ_GRAPH = (scopeSelector: string) => (page: Page) => page.evaluate((selector): GraphMeasure | null => {
    const scope = document.querySelector(selector);
    const graph = scope?.querySelector<HTMLElement>(".pgraph");
    const box = scope?.querySelector<HTMLElement>(".pgraph-box");
    if (!scope || !graph) return null;
    /* The graph may sit under a scale transform (the modal's zoom), so the caption
       size that matters is the one it actually lands at on screen. */
    const drawn = graph.getBoundingClientRect().width / Math.max(1, graph.offsetWidth);
    const captionRaw = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-caption")) || 10;
    const nodes = [...graph.querySelectorAll<HTMLElement>(".pnode")].map((node) => {
      const rect = node.getBoundingClientRect();
      let overflowX = 0;
      let overflowY = 0;
      for (const child of node.querySelectorAll<HTMLElement>("*")) {
        /* The edge ports are drawn straddling the border on purpose, so they are
           not content and cannot overflow it. */
        if (child.classList.contains("pport")) continue;
        const childRect = child.getBoundingClientRect();
        if (!childRect.width && !childRect.height) continue;
        overflowX = Math.max(overflowX, childRect.right - rect.right, rect.left - childRect.left);
        overflowY = Math.max(overflowY, childRect.bottom - rect.bottom, rect.top - childRect.top);
      }
      const identity = node.querySelector<HTMLElement>(".pident");
      return {
        stage: node.dataset.stage ?? "",
        engineMark: node.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
        effortStep: node.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
        identity: identity?.dataset.identity ?? null,
        nextDiffers: Boolean(node.querySelector("[data-next-differs]")),
        model: identity?.querySelector(".imodel")?.textContent?.trim() ?? "",
        modelTruncated: (() => {
          const text = identity?.querySelector<HTMLElement>(".imodel");
          return Boolean(text && text.scrollWidth > text.clientWidth + 1);
        })(),
        overflowX: Math.round(overflowX * 100) / 100,
        overflowY: Math.round(overflowY * 100) / 100,
      };
    });
    const edges = [...graph.querySelectorAll<SVGPathElement>(".pedge")].map((path) => {
      const id = path.getAttribute("data-edge") ?? "";
      const label = graph.querySelector<HTMLElement>(`[data-edge-label="${id}"]`);
      const cls = path.getAttribute("class") ?? "";
      /* Painted boxes, not layout boxes: a label carries a translate of its own
         (centred on its point, or only vertically when it sits beside the return
         lane), so only the rendered rectangle says whether the graph box cuts it.
         Both rects are in the same scaled space, so dividing by the graph's own
         scale gives the answer in layout px at any zoom. */
      const overflowX = label
        ? Math.max(0, (label.getBoundingClientRect().right - graph.getBoundingClientRect().right) / Math.max(drawn, 0.01))
        : 0;
      /* Where a fail label paints depends on the form it took: a full pill inverts
         ITSELF when the budget is spent, while a bare badge has no pill and the
         ink sits on the mark inside it. Read whichever of the two actually paints,
         so "exhausted is never the lighter drawing" is measured on the drawing
         the operator sees (#1743). */
      const opaque = (colour: string) => Boolean(colour) && colour !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(colour);
      const mark = label?.querySelector<HTMLElement>(".cfired") ?? null;
      const labelFill = label ? getComputedStyle(label).backgroundColor : "";
      const markFill = mark ? getComputedStyle(mark).backgroundColor : "";
      const fill = opaque(labelFill) ? labelFill : markFill;
      const paintedRect = (opaque(labelFill) ? label : mark ?? label)?.getBoundingClientRect();
      return {
        edge: id,
        fired: path.getAttribute("data-edge-fired"),
        travelled: cls.includes("taken"),
        spent: cls.includes("spent") || (label?.className ?? "").includes("spent"),
        live: cls.includes("live"),
        dash: getComputedStyle(path).strokeDasharray,
        circle: label?.querySelector(".ccircle")?.textContent?.trim() ?? null,
        form: label?.dataset.edgeLabelForm ?? null,
        text: label?.textContent?.trim() ?? "",
        overflowX: Math.round(overflowX * 100) / 100,
        area: paintedRect ? Math.round(paintedRect.width * paintedRect.height) : 0,
        fill,
        filled: opaque(labelFill) || opaque(markFill),
        circleFill: (() => {
          const circle = label?.querySelector<HTMLElement>(".ccircle");
          return circle ? getComputedStyle(circle).backgroundColor : "";
        })(),
        markFill,
      };
    });
    return {
      nodes,
      edges,
      captionPx: Math.round(captionRaw * drawn * 100) / 100,
      identityWords: graph.dataset.identityWords ?? null,
      legend: [...(box?.querySelectorAll<HTMLElement>(".plegend li") ?? [])].map((row) => ({
        edge: row.dataset.legendEdge ?? "",
        text: row.textContent?.trim() ?? "",
        circle: row.querySelector(".ccircle")?.textContent?.trim() ?? null,
        filled: Boolean(row.querySelector(".ccircle.filled")),
        spent: Boolean(row.querySelector(".cfired.spent")),
      })),
    };
  }, scopeSelector);

  /** The minimized strip: one chip per stage, each carrying mark and ladder. */
  const readChips = (page: Page, scopeSelector: string) => page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return null;
    return {
      chips: [...scope.querySelectorAll<HTMLElement>(".pb-pills .pb-pill")].map((chip) => ({
        stage: chip.dataset.stage ?? "",
        engineMark: chip.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
        effortStep: chip.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
        markWidth: Math.round((chip.querySelector("[data-engine-mark]")?.getBoundingClientRect().width ?? 0) * 100) / 100,
        scaleWidth: Math.round((chip.querySelector("[data-effort-pills]")?.getBoundingClientRect().width ?? 0) * 100) / 100,
        nextDiffers: Boolean(chip.querySelector("[data-next-differs]")),
      })),
      /* The collapsed row draws a fail edge as an arc under the pills now, or,
         on a row that wrapped, as a count on the failing pill (#1798). Either
         way the budget it carries is the same one the chip used to print. */
      loops: [...scope.querySelectorAll<HTMLElement>("[data-loop-arc], .pret")].map((mark) => ({
        count: mark.querySelector(".parc-count")?.textContent?.trim() ?? (mark.classList.contains("pret") ? mark.textContent?.trim().replace(/^\u21ba/, "") ?? null : null),
        spent: mark.dataset.arcState === "exhausted",
        fired: mark.dataset.arcFired ?? null,
        max: mark.dataset.arcMax ?? null,
        /* The sentence the chip printed survives in the mark's own title. */
        text: mark.querySelector("title")?.textContent ?? mark.getAttribute("title") ?? "",
      })),
    };
  }, scopeSelector);

  /** Every pane header the sheet drew: the model must survive beside the role. */
  /* A pane says who runs its stage once (#2148): the column head names the
     stage and its role, and the identity row of the conversation under it (or
     of the first message, before the stage starts) carries mark, model and
     ladder. */
  const readPaneHeads = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".gsheet .pane")].map((pane) => {
    const role = pane.querySelector<HTMLElement>(".pane-title .prole");
    const idRow = pane.querySelector<HTMLElement>(".pane-conv .pane-id");
    return {
      stage: pane.getAttribute("data-stage") ?? "",
      folded: pane.classList.contains("folded"),
      headMarks: pane.querySelectorAll(".pane-head [data-engine-mark], .pane-head [data-effort-pills]").length,
      headTitle: role?.getAttribute("title") ?? "",
      idRow: Boolean(idRow),
      engineMark: idRow?.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
      /* Content wider than the row is content the row cuts. */
      roleOverflow: role ? Math.max(0, role.scrollWidth - role.clientWidth) : 0,
    };
  }));

  /** The phone board: the kanban does not mount there, and the engine mark does. */
  const readPhone = (page: Page) => page.evaluate(() => ({
    board: document.querySelector("[data-mobile2-board]") ? "mobile2" : document.querySelector("[data-kanban-board]") ? "kanban" : "none",
    marks: [...document.querySelectorAll("[data-engine-mark]")].map((mark) => mark.getAttribute("data-engine-mark")),
    markBoxes: [...document.querySelectorAll<HTMLElement>("[data-engine-mark]")]
      .map((mark) => Math.round(mark.getBoundingClientRect().width))
      .filter((width) => width > 0),
    /* The one mark component emits this attribute; a surviving ad-hoc glyph would
       draw an engine icon with none. */
    pipelineRows: document.querySelectorAll('[data-mobile2-row="pipeline"]').length,
  }));

  /** The phone's pipeline screen: a pipeline drawn as stage rows. */
  const readPhoneStages = (page: Page) => page.evaluate(() => ({
    rows: [...document.querySelectorAll<HTMLElement>("[data-mobile2-stage]")].map((row) => ({
      stage: row.dataset.mobile2Stage ?? "",
      engineMark: row.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
      effortStep: row.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
      identity: row.querySelector<HTMLElement>(".pident")?.dataset.identity ?? null,
      model: row.querySelector(".imodel")?.textContent?.trim() ?? "",
      returns: row.querySelector(".ccircle")?.textContent?.trim() ?? null,
      /* A return is a FILLED disc in both states, with a closed ring once the
         budget is spent, and the budget itself is printed beside it: on a phone
         there is no arrow and no legend to carry either (#1743). */
      returnFilled: Boolean(row.querySelector(".cfired .ccircle.filled")),
      returnSpent: Boolean(row.querySelector(".cfired.spent")),
      returnBudget: row.querySelector("[data-mobile2-stage-budget]")?.textContent?.trim() ?? "",
      returnBudgetState: row.querySelector<HTMLElement>("[data-mobile2-stage-budget]")?.dataset.mobile2StageBudget ?? null,
      /* Painted area of the whole mark, so "exhausted reads heavier than live"
         is a number rather than a claim. */
      returnArea: (() => {
        const mark = row.querySelector<HTMLElement>(".cfired");
        if (!mark) return 0;
        const rect = mark.getBoundingClientRect();
        return Math.round(rect.width * rect.height);
      })(),
      /* The stage name may not be squeezed out by the budget beside it. */
      nameWidth: Math.round((row.querySelector<HTMLElement>(".truncate")?.getBoundingClientRect().width ?? 0)),
      /* Nothing on a 390 px row may paint outside the row. */
      overflowX: (() => {
        const rect = row.getBoundingClientRect();
        let out = 0;
        for (const child of row.querySelectorAll<HTMLElement>("*")) {
          const childRect = child.getBoundingClientRect();
          if (!childRect.width && !childRect.height) continue;
          out = Math.max(out, childRect.right - rect.right, rect.left - childRect.left);
        }
        return Math.round(out * 100) / 100;
      })(),
    })),
  }));

  /** What language the page is actually in, taken from the page itself. */
  const readLanguage = (page: Page) => page.evaluate(() => ({
    documentLang: document.documentElement.lang,
    stored: (() => { try { return localStorage.getItem("llv_lang"); } catch { return null; } })(),
  }));

  browserTest("#1743: every stage says who runs it, and a fail edge that fired twice says so on the arrow", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const base = `${server.base}?scenario=issue1743`;
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, unknown> = {};

    /* The two facts the operator asked to see, checked on whichever graph is
       handed in: the looped edge fired twice with a return left, and the spent
       one is drawn exhausted. */
    const checkGraph = (label: string, measured: GraphMeasure | null, kind: "looped" | "spent") => {
      if (!measured) {
        failures.push(`${label}: no graph was drawn`);
        return;
      }
      const overflowing = measured.nodes.filter((node) => node.overflowX > 0.5 || node.overflowY > 0.5);
      if (overflowing.length) failures.push(`${label}: nodes overflow their box ${JSON.stringify(overflowing)}`);
      /* A label the graph box cuts loses exactly the part that carries the
         remaining budget, so no label may stick out of the box (#1743). */
      const cut = measured.edges.filter((edge) => edge.overflowX > 0.5);
      if (cut.length) failures.push(`${label}: edge labels are cut by the graph box ${JSON.stringify(cut.map((edge) => [edge.edge, edge.overflowX, edge.text]))}`);
      if (measured.nodes.some((node) => !node.engineMark)) {
        failures.push(`${label}: a node drew no engine mark ${JSON.stringify(measured.nodes.map((node) => [node.stage, node.engineMark]))}`);
      }
      if (measured.nodes.some((node) => !node.effortStep)) {
        failures.push(`${label}: a node drew no effort step ${JSON.stringify(measured.nodes.map((node) => [node.stage, node.effortStep]))}`);
      }
      if (kind === "looped") {
        const back = measured.edges.find((edge) => edge.edge === "critique:fail:build");
        if (back?.fired !== "2") failures.push(`${label}: the fail edge reads fired=${back?.fired}`);
        if (!back?.travelled) failures.push(`${label}: the fail edge that fired twice is not drawn as travelled`);
        if (back?.circle !== "2") failures.push(`${label}: the circled count on the arrow is ${JSON.stringify(back?.circle)}`);
        if (back?.spent) failures.push(`${label}: the fail edge with one return left is drawn exhausted`);
        /* The launched values win over a later edit, and the edit is flagged. */
        const build = measured.nodes.find((node) => node.stage === "build");
        if (build?.engineMark !== "claude") failures.push(`${label}: build shows ${build?.engineMark}, not what it launched on`);
        if (!build?.nextDiffers) failures.push(`${label}: build does not flag that the next attempt differs`);
        const ship = measured.nodes.find((node) => node.stage === "ship");
        if (ship?.identity !== "configured") failures.push(`${label}: the unstarted stage reads ${JSON.stringify(ship?.identity)}`);
        const started = measured.nodes.filter((node) => node.stage !== "ship" && node.stage !== "verify");
        if (started.some((node) => node.identity !== "launched")) {
          failures.push(`${label}: a started stage does not read as launched ${JSON.stringify(started.map((node) => [node.stage, node.identity]))}`);
        }
      } else {
        const back = measured.edges.find((edge) => edge.edge === "review:fail:fix");
        if (back?.fired !== "2") failures.push(`${label}: the spent fail edge reads fired=${back?.fired}`);
        if (!back?.spent) failures.push(`${label}: the exhausted budget is not drawn as exhausted`);
        if (back?.circle !== "2") failures.push(`${label}: the exhausted arrow's circle is ${JSON.stringify(back?.circle)}`);
      }
      /* Whatever a fail label gave up to fit, the budget it no longer prints is
         in the legend under the graph — never nowhere. A pass edge has no budget,
         so its bare circled count is the whole of what it has to say. */
      for (const edge of measured.edges.filter((entry) => entry.form === "badge")) {
        if (!measured.legend.some((row) => row.text.includes(String(edge.fired)) && row.text.length > 8)) {
          failures.push(`${label}: ${edge.edge} stepped down to a number and the legend says nothing`);
        }
      }
      /* Wherever the mark itself paints the exhausted ring, the disc inside it
         must still be a DISC: painted in the ring's own colour it is a hole, and
         a hole is this vocabulary's pass count (#1743). */
      for (const edge of measured.edges.filter((entry) => entry.spent && entry.travelled)) {
        if (edge.markFill && edge.markFill === edge.circleFill) {
          failures.push(`${label}: the exhausted count on ${edge.edge} is a hole in its ring (${edge.circleFill})`);
        }
      }
      /* Dashed is "configured, not travelled" on every kind of edge: a pass edge
         that has never fired may not read as a path the work has taken (#1743).
         A live arrow animates its own dashes, so it is not evidence either way. */
      for (const edge of measured.edges.filter((entry) => !entry.live)) {
        const dashed = Boolean(edge.dash) && edge.dash !== "none";
        if (edge.travelled && dashed) failures.push(`${label}: travelled edge ${edge.edge} is drawn dashed (${edge.dash})`);
        if (!edge.travelled && !dashed) failures.push(`${label}: untravelled edge ${edge.edge} is drawn solid`);
      }
      /* A key that samples a different mark than the arrow it explains explains
         nothing: the legend's circle is filled like the arrow's, and carries the
         same closed ring when the budget is spent (#1743). */
      for (const row of measured.legend) {
        const drawn = measured.edges.find((edge) => edge.edge === row.edge);
        if (!drawn?.travelled) continue;
        if (!row.filled) failures.push(`${label}: the legend for ${row.edge} samples an outlined count where the arrow is filled`);
        if (row.spent !== Boolean(drawn.spent)) {
          failures.push(`${label}: the legend for ${row.edge} reads spent=${row.spent} while the arrow reads spent=${drawn.spent}`);
        }
      }
    };

    /* The card's own graph at a given width, in one language and scheme. */
    const desktop = async (lang: "en" | "uk", scheme: "light" | "dark", width: number, withModal: boolean) => {
      const label = `${width}-${lang}-${scheme}`;
      const viewport = { width, height: width >= 1280 ? 1000 : 720 };
      const opened = await openFixture(browser, base, viewport, scheme, lang);
      try {
        await opened.page.waitForSelector(CARD, { state: "attached", timeout: 20_000 });
        const language = await readLanguage(opened.page);
        if (language.documentLang !== lang) failures.push(`${label}: the page rendered in ${JSON.stringify(language)}`);
        await opened.page.locator(CARD).evaluate((element) => element.scrollIntoView({ block: "start" }));
        await opened.page.waitForTimeout(400);
        /* The compact strip first: engine and effort with no graph open. */
        const chips = await readChips(opened.page, `${CARD} ${LOOPED}`);
        if (!chips?.chips.length) failures.push(`${label}: the compact strip drew no chip`);
        for (const chip of chips?.chips ?? []) {
          if (!chip.engineMark) failures.push(`${label}: chip ${chip.stage} drew no engine mark`);
          if (!chip.effortStep) failures.push(`${label}: chip ${chip.stage} drew no effort step`);
          if (chip.markWidth <= 0) failures.push(`${label}: chip ${chip.stage} mark is ${chip.markWidth} px wide`);
          if (chip.scaleWidth <= 0) failures.push(`${label}: chip ${chip.stage} effort scale is ${chip.scaleWidth} px wide`);
        }
        if (chips?.loops[0]?.fired !== "2") failures.push(`${label}: the return mark counts ${JSON.stringify(chips?.loops[0]?.fired)}`);
        const spentChips = await readChips(opened.page, `${CARD} ${SPENT}`);
        if (!spentChips?.loops[0]?.spent) failures.push(`${label}: the spent return mark is not drawn as spent`);
        /* Whatever form the mark took, the budget the chip used to print is
           still reachable: the count on it, and the sentence in its title. */
        for (const loop of [...(chips?.loops ?? []), ...(spentChips?.loops ?? [])]) {
          if (!loop.count) failures.push(`${label}: a fired return mark prints no count ${JSON.stringify(loop)}`);
          if (!loop.max) failures.push(`${label}: a return mark carries no budget ${JSON.stringify(loop)}`);
          if (!loop.text) failures.push(`${label}: a return mark carries no sentence ${JSON.stringify(loop)}`);
        }

        /* Then the card graph itself. */
        for (const selector of [`${CARD} ${LOOPED}`, `${CARD} ${SPENT}`]) {
          await opened.page.click(`${selector} [data-graph-toggle]`);
        }
        await opened.page.waitForTimeout(400);
        const looped = await READ_GRAPH(`${CARD} ${LOOPED}`)(opened.page);
        const spent = await READ_GRAPH(`${CARD} ${SPENT}`)(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `card-${label}.png`) });
        checkGraph(`card ${label}`, looped, "looped");
        checkGraph(`card ${label}`, spent, "spent");
        if (looped && looped.captionPx < 9) failures.push(`card ${label}: identity text lands at ${looped.captionPx} px`);
        /* Exhaustion is a luminance cue: wherever the two are drawn the same way,
           the spent edge must never carry LESS ink than the live one. */
        const liveLabel = looped?.edges.find((edge) => edge.edge === "critique:fail:build");
        const spentLabel = spent?.edges.find((edge) => edge.edge === "review:fail:fix");
        if (liveLabel && spentLabel) {
          if (!spentLabel.filled) failures.push(`card ${label}: the exhausted label paints no fill`);
          if (spentLabel.fill === liveLabel.fill) {
            failures.push(`card ${label}: the exhausted label paints the same fill as the live one (${spentLabel.fill})`);
          }
          /* Same drawing, so the areas are comparable: exhaustion may never be the
             lighter of the two. In legend mode both are bare badges, which is the
             case that read backwards before (#1743). */
          if (spentLabel.form === liveLabel.form && spentLabel.area < liveLabel.area) {
            failures.push(`card ${label}: the exhausted label is smaller than the live one (${spentLabel.area} vs ${liveLabel.area} px2)`);
          }
        }

        if (!withModal) {
          frames[label] = { viewport, language, chips, spentChips, looped, spent };
          if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
          return;
        }

        /* And the modal graph, which draws the same nodes under the sheet's zoom. */
        await opened.page.click(`${CARD} ${LOOPED} [data-open-stages]`);
        await opened.page.waitForSelector("[data-sheet-graph]", { state: "attached", timeout: 20_000 });
        /* The sheet's graph toggle is a switch: turn it on only if it is off. */
        if (await opened.page.getAttribute("[data-sheet-graph]", "aria-pressed") !== "true") {
          await opened.page.click("[data-sheet-graph]");
        }
        await opened.page.waitForSelector(".gsheet .pgraph", { state: "attached", timeout: 20_000 });
        await opened.page.waitForTimeout(400);
        const modal = await READ_GRAPH(".gsheet")(opened.page);
        const paneHeads = await readPaneHeads(opened.page);
        /* Amendment 3: the modal draws the graph under a scale, so the identity
           row's 10 px caption lands smaller than it is written. Zooming out twice
           from the default takes it under the 9 px floor, and the words must give
           way to the mark and the ladder, which are shapes and stay readable. */
        await opened.page.click('[data-zoom="-"]');
        await opened.page.click('[data-zoom="-"]');
        await opened.page.waitForTimeout(300);
        const zoomedOut = await READ_GRAPH(".gsheet")(opened.page);
        const zoomScale = await opened.page.getAttribute("[data-zoom-scale]", "data-zoom-scale");
        /* The chips are the graph's collapsed form (#2148): hide the graph to read them. */
        await opened.page.click("[data-sheet-graph]");
        await opened.page.waitForSelector("[data-nav-stage]", { state: "attached", timeout: 5_000 });
        const navChips = await opened.page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-nav-stage]")].map((chip) => ({
          stage: chip.dataset.navStage ?? "",
          engineMark: chip.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
          effortStep: chip.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
        })));
        await opened.page.screenshot({ path: path.join(OUT, `modal-${label}.png`) });
        checkGraph(`modal ${label}`, modal, "looped");
        if (modal && modal.captionPx < 9 && modal.identityWords !== "0") {
          failures.push(`modal ${label}: identity text lands at ${modal.captionPx} px and the words were kept`);
        }
        if (!navChips.length || navChips.some((chip) => !chip.engineMark || !chip.effortStep)) {
          failures.push(`modal ${label}: a nav chip is missing its mark or ladder ${JSON.stringify(navChips)}`);
        }
        /* A pane says who runs its stage once (#2148, amending #1743): its
           head names the stage and its role and keeps the identity in its
           title; the identity row under it draws the mark. */
        if (!paneHeads.length) failures.push(`modal ${label}: the sheet drew no pane`);
        for (const head of paneHeads) {
          if (head.headMarks) failures.push(`modal ${label}: pane ${head.stage} draws who runs it in its head as well`);
          if (!head.headTitle) failures.push(`modal ${label}: pane ${head.stage} lost the identity words from its head's title`);
          if (head.idRow && !head.engineMark) failures.push(`modal ${label}: pane ${head.stage}'s identity row drew no engine mark`);
          if (head.roleOverflow > 1) failures.push(`modal ${label}: pane ${head.stage} cuts ${head.roleOverflow} px of its role line`);
        }
        if (!paneHeads.some((head) => head.idRow && head.engineMark)) failures.push(`modal ${label}: no pane drew an identity row`);
        if (zoomedOut) {
          if (zoomedOut.captionPx >= 9) failures.push(`modal ${label}: two zoom-out steps still land the caption at ${zoomedOut.captionPx} px`);
          if (zoomedOut.identityWords !== "0") failures.push(`modal ${label}: the words survived at ${zoomedOut.captionPx} px`);
          if (zoomedOut.nodes.some((node) => node.model)) failures.push(`modal ${label}: a model still reads at ${zoomedOut.captionPx} px`);
          if (zoomedOut.nodes.some((node) => !node.engineMark || !node.effortStep)) {
            failures.push(`modal ${label}: the mark or the ladder was dropped with the words ${JSON.stringify(zoomedOut.nodes)}`);
          }
        }
        frames[label] = { viewport, language, chips, spentChips, looped, spent, modal, paneHeads, navChips, zoomedOut: { ...zoomedOut, zoomScale } };
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };

    const phone = async (lang: "en" | "uk", scheme: Scheme) => {
      const label = `390-${lang}-${scheme}`;
      const viewport = { width: 390, height: 844 };
      const opened = await openFixture(browser, base, viewport, scheme, lang);
      try {
        await opened.page.waitForSelector('[data-mobile2-row="pipeline"]', { state: "attached", timeout: 20_000 });
        await opened.page.waitForTimeout(400);
        const language = await readLanguage(opened.page);
        if (language.documentLang !== lang) failures.push(`${label}: the page rendered in ${JSON.stringify(language)}`);
        const measured = await readPhone(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `phone-${label}.png`), fullPage: true });
        /* The kanban card graph does not exist at this width: mobile v2 keeps its
           own board (#1695). What must hold here is that the phone draws the SAME
           mark component, so the engine vocabulary is one across the Viewer. */
        if (measured.board !== "mobile2") failures.push(`${label}: the phone drew ${measured.board}`);
        if (!measured.marks.length) failures.push(`${label}: the phone drew no engine mark`);
        if (measured.marks.some((mark) => mark !== "claude" && mark !== "codex" && mark !== "openclaw")) {
          failures.push(`${label}: an unexpected engine mark ${JSON.stringify(measured.marks)}`);
        }
        if (measured.markBoxes.some((width) => width < 12)) failures.push(`${label}: a mark rendered at ${JSON.stringify(measured.markBoxes)} px`);
        if (!measured.pipelineRows) failures.push(`${label}: the phone board drew no pipeline row`);

        /* The phone's pipeline screen draws the pipeline as stage rows: that is
           where "who runs this stage" and "work came back here" belong on a phone. */
        await opened.page.click('[data-mobile2-go="pipelines"]');
        await opened.page.waitForSelector('[data-mobile2-pipeline-row="p-marks"]', { state: "attached", timeout: 20_000 });
        await opened.page.click('[data-mobile2-pipeline-row="p-marks"]');
        await opened.page.waitForSelector("[data-mobile2-stage]", { state: "attached", timeout: 20_000 });
        await opened.page.waitForTimeout(400);
        const stages = await readPhoneStages(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `phone-pipeline-${label}.png`), fullPage: true });
        if (stages.rows.length !== 5) failures.push(`${label}: the pipeline screen drew ${stages.rows.length} stage rows`);
        for (const row of stages.rows) {
          if (!row.engineMark) failures.push(`${label}: stage row ${row.stage} drew no engine mark`);
          if (!row.effortStep) failures.push(`${label}: stage row ${row.stage} drew no effort ladder`);
          if (row.overflowX > 0.5) failures.push(`${label}: stage row ${row.stage} paints ${row.overflowX} px outside itself`);
          if (row.nameWidth < 40) failures.push(`${label}: stage row ${row.stage} draws its name at ${row.nameWidth} px`);
        }
        const unstarted = stages.rows.find((row) => row.stage === "ship");
        if (unstarted?.identity !== "configured") failures.push(`${label}: the unstarted stage row reads ${JSON.stringify(unstarted?.identity)}`);
        const returned = stages.rows.find((row) => row.stage === "build");
        if (returned?.returns !== "2") failures.push(`${label}: the stage work came back to counts ${JSON.stringify(returned?.returns)}`);
        if (!returned?.returnFilled) failures.push(`${label}: the live return is not a filled disc`);
        if (returned?.returnSpent) failures.push(`${label}: the return with one left is drawn as spent`);
        if (returned?.returnBudgetState !== "left") failures.push(`${label}: the live row's budget reads ${JSON.stringify(returned?.returnBudgetState)}`);
        if (!/2.*3/.test(returned?.returnBudget ?? "")) failures.push(`${label}: the live row prints the budget as ${JSON.stringify(returned?.returnBudget)}`);
        if (stages.rows.filter((row) => row.returns).length !== 1) {
          failures.push(`${label}: a row that was never returned to carries a count ${JSON.stringify(stages.rows.map((row) => [row.stage, row.returns]))}`);
        }

        /* And the pipeline whose budget is spent, on the same screen: exhaustion
           is what the phone drew lighter and wordless before (#1743). */
        await opened.page.click("[data-mobile2-back]");
        await opened.page.waitForSelector('[data-mobile2-pipeline-row="p-marks-spent"]', { state: "attached", timeout: 20_000 });
        await opened.page.click('[data-mobile2-pipeline-row="p-marks-spent"]');
        await opened.page.waitForSelector('[data-mobile2-stage="fix"]', { state: "attached", timeout: 20_000 });
        await opened.page.waitForTimeout(400);
        const spentStages = await readPhoneStages(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `phone-pipeline-spent-${label}.png`), fullPage: true });
        const spentRow = spentStages.rows.find((row) => row.stage === "fix");
        if (spentRow?.returns !== "2") failures.push(`${label}: the exhausted row counts ${JSON.stringify(spentRow?.returns)}`);
        if (!spentRow?.returnFilled) failures.push(`${label}: the exhausted return is not a filled disc`);
        if (!spentRow?.returnSpent) failures.push(`${label}: the exhausted return draws no closed ring`);
        if (spentRow?.returnBudgetState !== "spent") failures.push(`${label}: the exhausted row's budget reads ${JSON.stringify(spentRow?.returnBudgetState)}`);
        if (!/2.*2/.test(spentRow?.returnBudget ?? "")) failures.push(`${label}: the exhausted row prints the budget as ${JSON.stringify(spentRow?.returnBudget)}`);
        if (spentRow?.returnBudget === returned?.returnBudget) {
          failures.push(`${label}: the exhausted row says the same as the live one ${JSON.stringify(spentRow?.returnBudget)}`);
        }
        /* Exhaustion may never be the LIGHTER of the two drawings. */
        if ((spentRow?.returnArea ?? 0) < (returned?.returnArea ?? 0)) {
          failures.push(`${label}: the exhausted mark is smaller than the live one (${spentRow?.returnArea} vs ${returned?.returnArea} px2)`);
        }
        for (const row of spentStages.rows) {
          if (row.overflowX > 0.5) failures.push(`${label}: exhausted stage row ${row.stage} paints ${row.overflowX} px outside itself`);
        }
        frames[label] = { viewport, language, measured, stages, spentStages };
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };

    try {
      for (const lang of ["en", "uk"] as const) {
        for (const scheme of ["light", "dark"] as const) {
          await desktop(lang, scheme, 1280, true);
          /* The narrowest desktop the board supports: the card graph falls to
             legend mode and the arrow carries a bare badge. */
          await desktop(lang, scheme, 640, false);
          /* The phone in both schemes too: the finding that sent this round
             back was a phone one, and it named light and dark (#1743). */
          await phone(lang, scheme);
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }

    /* The languages must differ where they say anything: a uk frame whose strings
       are byte-identical to the en one is an English render filed as Ukrainian. */
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1280, 640] as const) {
        const en = frames[`${width}-en-${scheme}`] as { chips?: { loops: Array<{ text: string }> } } | undefined;
        const uk = frames[`${width}-uk-${scheme}`] as { chips?: { loops: Array<{ text: string }> } } | undefined;
        const enText = en?.chips?.loops[0]?.text ?? "";
        const ukText = uk?.chips?.loops[0]?.text ?? "";
        if (!enText || !ukText) failures.push(`${width}-${scheme}: a return mark printed nothing to compare languages on`);
        else if (enText === ukText) failures.push(`${width}-${scheme}: the Ukrainian frame drew the English string ${JSON.stringify(enText)}`);
      }
    }

    fs.writeFileSync(path.join(EVIDENCE, "marks.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 900_000);
});

describe("#1802 folding the rail footer and the orchestrator seat", () => {
  /*
   * Rendered evidence for the two folds the operator asked for before a stream
   * (#1802), in the real Viewer over `issue1695Evidence.fixture.tsx`, in
   * Chromium at a desktop viewport, light and dark:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * Gated here, because only a laid-out page settles it:
   *   - open, the rail's footer paints machine figures and a limit window; one
   *     click folds it to a row of its own height with a label on it and NO
   *     digit, no percent and no plan word anywhere in the rail, the footer
   *     subtree is gone from the document rather than hidden, and the project
   *     list is taller by what the footer gave back;
   *   - the seat's fold control is a real target with a word on it, not a bare
   *     glyph: at least 64 px wide and 24 px tall, and its text is the
   *     locale's own Fold / Unfold word;
   *   - folded, the seat is a slim bar — under 72 px — that still carries the
   *     seat's state word, and the conversation it holds is still mounted, so
   *     a draft typed before the fold is still in the field after it.
   *
   * Measurements go to `evidence/issue-1802/fold.json`; no frame is committed.
   */

  const EVIDENCE = path.resolve("evidence/issue-1802");

  const railFooter = (page: Page) => page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>("aside")!;
    const footer = rail.querySelector<HTMLElement>("[data-rail-footer]")!;
    const toggle = footer.querySelector<HTMLElement>("[data-rail-footer-toggle]")!;
    const list = rail.querySelector<HTMLElement>("nav")!;
    const toggleBox = toggle.getBoundingClientRect();
    return {
      state: footer.dataset.railFooter!,
      footerHeight: Math.round(footer.getBoundingClientRect().height),
      toggle: { width: Math.round(toggleBox.width), height: Math.round(toggleBox.height), text: (toggle.textContent ?? "").trim() },
      /* Everything below the project list, as the operator reads it. */
      railText: (footer.textContent ?? "").replace(/\s+/g, " ").trim(),
      subtrees: footer.querySelectorAll(":scope > div").length,
      listHeight: Math.round(list.getBoundingClientRect().height),
    };
  });

  const seatBar = (page: Page) => page.evaluate(() => {
    const seat = document.querySelector<HTMLElement>("[data-kanban-seat]")!;
    const fold = seat.querySelector<HTMLElement>("[data-seat-collapse]")!;
    const box = fold.getBoundingClientRect();
    const badge = seat.querySelector<HTMLElement>("[data-orchestrator-badge]");
    const field = seat.querySelector<HTMLTextAreaElement>("[data-orchestrator-conversation] textarea");
    return {
      collapsed: seat.dataset.collapsed === "1",
      height: Math.round(seat.getBoundingClientRect().height),
      fold: { width: Math.round(box.width), height: Math.round(box.height), text: (fold.textContent ?? "").trim(), expanded: fold.getAttribute("aria-expanded") },
      stateWord: (badge?.textContent ?? "").trim(),
      conversations: seat.querySelectorAll("[data-orchestrator-conversation]").length,
      draft: field?.value ?? null,
    };
  });

  browserTest("the rail footer and the seat both fold to a slim, numberless row", async () => {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "llv-1802-")));
    const browser: Browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const scheme of ["light", "dark"] as const) {
        const { context, page, pageErrors } = await openFixture(browser, server.base, VIEWPORT, scheme, "en");
        try {
          await page.waitForSelector("[data-kanban-seat]");
          await page.waitForSelector("[data-rail-footer]");
          /* The rail's resources probe starts 1.5 s after mount by design: wait
             for its figures, so the fold is asked to hide a painted footer. */
          await page.waitForFunction(() => /\d/.test(document.querySelector<HTMLElement>("[data-rail-footer]")?.textContent ?? ""), null, { timeout: 20_000 });

          const railOpen = await railFooter(page);
          if (!/\d/.test(railOpen.railText)) failures.push(`${scheme}: the open rail footer printed no figure to hide`);
          if (railOpen.state !== "open") failures.push(`${scheme}: the rail footer did not start open`);

          await page.click("[data-rail-footer-toggle]");
          const railFolded = await railFooter(page);
          if (railFolded.state !== "folded") failures.push(`${scheme}: the rail footer did not fold`);
          if (/\d/.test(railFolded.railText)) failures.push(`${scheme}: the folded rail footer still prints ${JSON.stringify(railFolded.railText)}`);
          if (/%/.test(railFolded.railText)) failures.push(`${scheme}: the folded rail footer still prints a percentage`);
          if (/GiB|MiB/.test(railFolded.railText)) failures.push(`${scheme}: the folded rail footer still prints a memory figure`);
          if (railFolded.subtrees !== 0) failures.push(`${scheme}: the folded rail footer left ${railFolded.subtrees} subtree(s) mounted`);
          if (railFolded.footerHeight >= railOpen.footerHeight) failures.push(`${scheme}: folding did not shrink the footer (${railOpen.footerHeight} → ${railFolded.footerHeight})`);
          if (railFolded.listHeight <= railOpen.listHeight) failures.push(`${scheme}: the project list did not take the freed height`);

          const seatOpen = await seatBar(page);
          if (seatOpen.collapsed) failures.push(`${scheme}: the seat did not start open at ${VIEWPORT.height}px`);
          if (seatOpen.fold.width < 64 || seatOpen.fold.height < 24) failures.push(`${scheme}: the seat's fold control is ${seatOpen.fold.width}×${seatOpen.fold.height}, too small to find`);
          if (!seatOpen.fold.text) failures.push(`${scheme}: the seat's fold control carries no word`);

          /* A half-typed message, so the fold is asked to keep it. */
          await page.fill("[data-kanban-seat] [data-orchestrator-conversation] textarea", "half a thought");
          await page.click("[data-kanban-seat] [data-seat-collapse]");
          const seatFolded = await seatBar(page);
          if (!seatFolded.collapsed) failures.push(`${scheme}: the seat did not fold`);
          if (seatFolded.height > 72) failures.push(`${scheme}: the folded seat is ${seatFolded.height}px, not a slim bar`);
          if (!seatFolded.stateWord) failures.push(`${scheme}: the folded seat bar says nothing about the seat's state`);
          if (seatFolded.conversations !== 1) failures.push(`${scheme}: folding unmounted the seat's conversation`);

          await page.click("[data-kanban-seat] [data-seat-collapse]");
          const seatBack = await seatBar(page);
          if (seatBack.collapsed) failures.push(`${scheme}: the seat did not unfold`);
          if (seatBack.draft !== "half a thought") failures.push(`${scheme}: the draft did not survive the fold (${JSON.stringify(seatBack.draft)})`);

          frames[scheme] = { railOpen, railFolded, seatOpen, seatFolded, seatBack };
          if (pageErrors.length) failures.push(`${scheme}: ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }

    fs.writeFileSync(path.join(EVIDENCE, "fold.json"), `${JSON.stringify({ viewport: VIEWPORT, frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 300_000);
});

describe("#1820 the Overview is the project board over every project", () => {
  /*
   * Rendered evidence for #1820: the real Viewer on its Overview, over
   * `issue1695Evidence.fixture.tsx?scenario=issue1820` — three invented
   * projects, each with a card a worker is working on and a card nobody is —
   * with the production stylesheet, in Chromium:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=$(which google-chrome-stable) \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * What only a browser settles, and is gated here, at a desktop and a phone
   * viewport:
   *   - the Overview draws the kanban board's own columns, not a grid of
   *     project cards and not a column per project;
   *   - the cards in them come from three projects at once, each carrying its
   *     own project's display name, and no canonical project key is drawn;
   *   - a card with nobody working on it is absent from every column, and the
   *     column head says how many of its cards are shown;
   *   - what needs one project to write into — «+ Task», «+ Agent», the
   *     orchestrator seat — is drawn nowhere;
   *   - `?scenario=issue1820-quiet` — projects and tasks, nobody working —
   *     keeps the board and says why it is empty in the operator's words: the
   *     Overview's own filter, never advice about a search nobody typed;
   *   - `?scenario=issue1820-empty` still draws the first-run panel and no
   *     board at all.
   *
   * Measurements go to `evidence/issue-1820/overview.json`; frames to
   * `.artifacts/issue-1820/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1820");
  const EVIDENCE = path.resolve("evidence/issue-1820");
  const VIEWPORTS = [
    { label: "desktop-1440", width: 1440, height: 900 },
    { label: "phone-390", width: 390, height: 844 },
  ] as const;
  /* The three projects the fixture seeds, and the cards each is expected to
     contribute. A quiet card of each project must be drawn nowhere. */
  const WORKING = ["task:t-ledger", "task:t-mesh"] as const;
  const QUIET = ["task:t-ledger-quiet", "task:t-mesh-quiet"] as const;
  const PROJECT_LABELS = ["acme-ledger", "river-mesh", "atlas"] as const;
  const KEYS = ["acme-ledger", "river-mesh"] as const;
  /* Drawn when the Overview's own filter empties a column, and never drawn
     there: the search's own no-match copy. */
  const QUIET_TITLE = en["overview.noneWorking"];
  const QUIET_BODY = en["overview.noneWorkingHint"];
  const SEARCH_COPY = [en["kanban.noMatch"], en["kanban.noMatchHint"]] as const;

  interface OverviewMeasure {
    boards: number;
    columns: string[];
    columnCounts: Array<{ status: string; count: string }>;
    cards: Array<{ id: string; status: string; project: string }>;
    projectsOnCards: string[];
    singleProjectControls: { newTask: number; newAgent: number; seat: number; addAgent: number };
    firstRun: boolean;
    headerLine: string;
    emptyStates: Array<{ status: string; text: string }>;
  }

  const measure = (page: Page) => page.evaluate((): OverviewMeasure => {
    const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? "";
    const cards = [...document.querySelectorAll<HTMLElement>("[data-kanban-board] .card")].map((card) => ({
      id: card.dataset.id ?? "",
      status: (card.closest("section.column") as HTMLElement | null)?.dataset.status ?? "",
      project: text(card.querySelector("[data-project-chip]")),
    }));
    return {
      boards: document.querySelectorAll("[data-kanban-board]").length,
      columns: [...document.querySelectorAll<HTMLElement>("[data-kanban-board] section.column")].map((column) => column.dataset.status ?? ""),
      columnCounts: [...document.querySelectorAll<HTMLElement>("[data-kanban-board] section.column")].map((column) => ({
        status: column.dataset.status ?? "",
        count: text(column.querySelector(".col-head .n")),
      })),
      cards,
      projectsOnCards: [...new Set(cards.map((card) => card.project).filter(Boolean))].sort(),
      singleProjectControls: {
        newTask: document.querySelectorAll("[data-new-task]").length,
        newAgent: document.querySelectorAll("[data-new-agent]").length,
        seat: document.querySelectorAll("[data-kanban-seat]").length,
        addAgent: document.querySelectorAll(".card [data-add-agent]").length,
      },
      firstRun: Boolean(document.querySelector('[data-testid="overview-first-run"]')),
      headerLine: text(document.querySelector("h1")?.parentElement),
      emptyStates: [...document.querySelectorAll<HTMLElement>("[data-kanban-board] section.column")].map((column) => ({
        status: column.dataset.status ?? "",
        text: text(column.querySelector(".empty")),
      })),
    };
  });

  browserTest("#1820: the Overview draws one board of working cards from three projects, each labelled with its own", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const frames: Record<string, unknown> = {};

    const board = async (viewport: (typeof VIEWPORTS)[number]) => {
      const label = viewport.label;
      const opened = await openFixture(browser, `${server.base}?scenario=issue1820`, { width: viewport.width, height: viewport.height }, "light");
      try {
        await opened.page.waitForSelector("[data-kanban-board] .card", { state: "attached", timeout: 30_000 });
        await opened.page.waitForTimeout(700);
        const measured = await measure(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `issue-1820-${label}.png`), fullPage: true });
        frames[label] = { viewport, measured };

        if (measured.boards !== 1) failures.push(`${label}: ${measured.boards} boards drawn, expected exactly one`);
        if (measured.columns.join() !== "inbox,assigned,blocked,done") failures.push(`${label}: columns ${measured.columns.join()}`);
        /* Three projects share those four columns. */
        for (const name of PROJECT_LABELS) {
          if (!measured.projectsOnCards.includes(name)) failures.push(`${label}: no card labelled ${name}; labels ${JSON.stringify(measured.projectsOnCards)}`);
        }
        const drawn = new Set(measured.cards.map((card) => card.id));
        for (const id of WORKING) if (!drawn.has(id)) failures.push(`${label}: the working card ${id} is not drawn`);
        for (const id of QUIET) if (drawn.has(id)) failures.push(`${label}: the quiet card ${id} is drawn`);
        /* Every drawn card names its project; none of them names the key. */
        for (const card of measured.cards) {
          if (!card.project) failures.push(`${label}: ${card.id} carries no project label`);
        }
        const body = await opened.page.evaluate(() => document.body.textContent ?? "");
        for (const key of KEYS) {
          if (body.includes(`-${key}`)) failures.push(`${label}: a canonical project key is drawn as text`);
        }
        /* Narrowed, and each column head says so. */
        for (const column of measured.columnCounts) {
          if (!/^\d+ of \d+$/.test(column.count)) failures.push(`${label}: ${column.status} head reads ${JSON.stringify(column.count)}`);
        }
        const controls = measured.singleProjectControls;
        for (const [name, count] of Object.entries(controls)) {
          if (count) failures.push(`${label}: ${name} is drawn ${count} time(s) on a board with no single project`);
        }
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };

    /* Projects, tasks, and nobody working: the board stays and every column
       names the Overview's own filter (#696 — a filtered-out board and a
       fruitless search must not render the same screen). */
    const quiet = async (viewport: (typeof VIEWPORTS)[number]) => {
      const label = `${viewport.label}-quiet`;
      const opened = await openFixture(browser, `${server.base}?scenario=issue1820-quiet`, { width: viewport.width, height: viewport.height }, "light");
      try {
        await opened.page.waitForSelector("[data-kanban-board] section.column .empty", { state: "attached", timeout: 30_000 });
        await opened.page.waitForTimeout(700);
        const measured = await measure(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `issue-1820-${label}.png`), fullPage: true });
        frames[label] = { viewport, measured };

        if (measured.boards !== 1) failures.push(`${label}: ${measured.boards} boards drawn on an installation with projects but no work`);
        if (measured.firstRun) failures.push(`${label}: the first-run panel is drawn over an installation that has projects`);
        if (measured.cards.length) failures.push(`${label}: ${measured.cards.length} card(s) drawn while nobody is working`);
        for (const column of measured.emptyStates) {
          if (!column.text.includes(QUIET_TITLE)) failures.push(`${label}: ${column.status} empty state reads ${JSON.stringify(column.text)}`);
          if (!column.text.includes(QUIET_BODY)) failures.push(`${label}: ${column.status} empty state carries no word about the filter`);
          if (SEARCH_COPY.some((copy) => column.text.includes(copy))) failures.push(`${label}: ${column.status} offers advice about a search nobody typed`);
        }
        /* The counts still read «0 of N»: the inventory is there, narrowed. */
        for (const column of measured.columnCounts) {
          if (!/^0 of \d+$/.test(column.count)) failures.push(`${label}: ${column.status} head reads ${JSON.stringify(column.count)}`);
        }
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };

    const empty = async (viewport: (typeof VIEWPORTS)[number]) => {
      const label = `${viewport.label}-empty`;
      const opened = await openFixture(browser, `${server.base}?scenario=issue1820-empty`, { width: viewport.width, height: viewport.height }, "light");
      try {
        await opened.page.waitForSelector('[data-testid="overview-first-run"]', { state: "attached", timeout: 30_000 });
        await opened.page.waitForTimeout(500);
        const measured = await measure(opened.page);
        await opened.page.screenshot({ path: path.join(OUT, `issue-1820-${label}.png`), fullPage: true });
        frames[label] = { viewport, measured };
        if (!measured.firstRun) failures.push(`${label}: the first-run panel is absent`);
        if (measured.boards !== 0) failures.push(`${label}: a board is drawn on an installation with no projects`);
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await opened.context.close();
      }
    };

    try {
      for (const viewport of VIEWPORTS) {
        await board(viewport);
        await quiet(viewport);
        await empty(viewport);
      }
    } finally {
      await browser.close();
      server.stop();
    }

    fs.writeFileSync(path.join(EVIDENCE, "overview.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 900_000);
});

describe("#1796 per-model limits", () => {
  browserTest("Fable and Opus lines survive the footer fold and render on desktop and phone", async () => {
    const out = path.resolve(".artifacts/issue-1796/browser");
    fs.mkdirSync(out, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const evidence: Record<string, unknown> = {
      driver: "src/components/kanban/kanbanBoard.browser.test.tsx",
      fixture: "src/components/kanban/issue1695Evidence.fixture.tsx?scenario=tier-limits",
      values: "invented",
    };
    const readRows = (page: Page, selector: string) => page.locator(selector).evaluate((root) => ({
      rows: [...root.querySelectorAll<HTMLElement>("[data-limit-row]")].map((row) => ({
        key: row.dataset.limitRow, text: row.textContent?.replace(/\s+/g, " ").trim(),
        width: Math.round(row.getBoundingClientRect().width),
      })),
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    }));
    try {
      for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
        const { context, page, pageErrors } = await openFixture(browser, server.base + "?scenario=tier-limits", viewport, "light", "en");
        try {
          let selector: string;
          if (name === "desktop") {
            await page.waitForFunction(() => document.querySelector("[data-rail-footer]")?.textContent?.includes("Fable · Week"));
            const footerText = await page.locator("[data-rail-footer]").innerText();
            expect(footerText).toContain("Opus · Week");
            await page.screenshot({ path: path.join(out, "desktop-footer.png") });
            await page.click("[data-rail-footer-toggle]");
            expect(await page.locator("[data-rail-footer]").innerText()).not.toContain("Fable");
            await page.click("[data-rail-footer-toggle]");
            await page.waitForFunction(() => document.querySelector("[data-rail-footer]")?.textContent?.includes("Fable · Week"));
            evidence.footer = { text: footerText, restoredAfterFold: true };
            await page.click('button[aria-label="Claude accounts — switch or add"]');
            selector = '[role="dialog"][aria-label="Claude accounts"]';
          } else {
            await page.waitForSelector('[data-mobile2-screen="board"]');
            await page.click('[data-mobile2-open="menu"]');
            await page.click('[data-mobile2-go="accounts"]');
            selector = '[data-mobile2-screen="accounts"]';
          }
          await page.waitForSelector(selector + ' [data-limit-row="tier:fable"]');
          const facts = await readRows(page, selector);
          expect(facts.rows.some((row) => row.key === "tier:fable" && row.text?.includes("Fable · Week") && row.text.includes("12%"))).toBe(true);
          expect(facts.rows.some((row) => row.key === "tier:opus" && row.text?.includes("Opus · Week") && row.text.includes("37%"))).toBe(true);
          expect(facts.overflow).toBe(0);
          expect(pageErrors).toEqual([]);
          await page.screenshot({ path: path.join(out, `${name}-accounts.png`), fullPage: true });
          evidence[name] = { viewport, ...facts, pageErrors };
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/issue-1796", { recursive: true });
      fs.writeFileSync("evidence/issue-1796/limits.json", JSON.stringify(evidence, null, 2) + "\n");
    } finally { await browser.close(); server.stop(); }
  }, 90_000);
});

describe("#1839 a tier the provider files under a codename", () => {
  browserTest("the provider's label names the row, on desktop and phone, and the codename never reaches the operator", async () => {
    const out = path.resolve(".artifacts/issue-1839/browser");
    fs.mkdirSync(out, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const evidence: Record<string, unknown> = {
      driver: "src/components/kanban/kanbanBoard.browser.test.tsx",
      fixture: "src/components/kanban/issue1695Evidence.fixture.tsx?scenario=tier-codename",
      values: "invented",
    };
    const readRows = (page: Page, selector: string) => page.locator(selector).evaluate((root) => ({
      rows: [...root.querySelectorAll<HTMLElement>("[data-limit-row]")].map((row) => ({
        key: row.dataset.limitRow, text: row.textContent?.replace(/\s+/g, " ").trim(),
        width: Math.round(row.getBoundingClientRect().width),
      })),
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    }));
    try {
      for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
        const { context, page, pageErrors } = await openFixture(browser, server.base + "?scenario=tier-codename", viewport, "light", "en");
        try {
          let selector: string;
          if (name === "desktop") {
            await page.waitForFunction(() => document.querySelector("[data-rail-footer]")?.textContent?.includes("Fable · Week"));
            const footerText = await page.locator("[data-rail-footer]").innerText();
            expect(footerText).toContain("Cedar Ember · Week");
            expect(footerText).not.toContain("Nimbus");
            evidence.footer = { text: footerText };
            await page.screenshot({ path: path.join(out, "desktop-footer.png") });
            await page.click('button[aria-label="Claude accounts — switch or add"]');
            selector = '[role="dialog"][aria-label="Claude accounts"]';
          } else {
            await page.waitForSelector('[data-mobile2-screen="board"]');
            await page.click('[data-mobile2-open="menu"]');
            await page.click('[data-mobile2-go="accounts"]');
            selector = '[data-mobile2-screen="accounts"]';
          }
          await page.waitForSelector(selector + ' [data-limit-row="tier:nimbus_quill"]');
          const facts = await readRows(page, selector);
          /* The row is still keyed by the bucket the window arrived in — that is
             what the gate matches on — while what it reads is the label. */
          expect(facts.rows.some((row) => row.key === "tier:nimbus_quill" && row.text?.includes("Fable · Week") && row.text.includes("12%"))).toBe(true);
          expect(facts.rows.some((row) => row.key === "tier:cedar_ember" && row.text?.includes("Cedar Ember · Week") && row.text.includes("37%"))).toBe(true);
          expect(facts.rows.every((row) => !row.text?.includes("nimbus"))).toBe(true);
          expect(facts.overflow).toBe(0);
          expect(pageErrors).toEqual([]);
          await page.screenshot({ path: path.join(out, `${name}-accounts.png`), fullPage: true });
          evidence[name] = { viewport, ...facts, pageErrors };
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/issue-1839", { recursive: true });
      fs.writeFileSync("evidence/issue-1839/limits.json", JSON.stringify(evidence, null, 2) + "\n");
    } finally { await browser.close(); server.stop(); }
  }, 90_000);
});

describe("#1819 putting the whole project sidebar away, and the header that stays", () => {
  /*
   * Rendered evidence for the operator's correction before a stream (#1819),
   * in the real Viewer over `issue1695Evidence.fixture.tsx`, in Chromium at a
   * desktop viewport, light and dark:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * Gated here, because only a laid-out page settles it:
   *   - shown, the rail's header carries the title, the hide control and ONE
   *     menu, and no digit and no paused badge; the menu opens onto three rows
   *     that each say in words what they are;
   *   - hidden, no rail element is in the document at all and none of its copy
   *     is readable, the main area is wider by what the rail gave back, and the
   *     one control that brings it back overlaps neither the board header's
   *     first control nor the orchestrator dock;
   *   - the B key does the same toggle from the keyboard.
   *
   * Measurements go to `evidence/issue-1819/sidebar.json`; no frame is
   * committed — the PNGs stay in the run's own temp directory.
   */

  const EVIDENCE = path.resolve("evidence/issue-1819");

  interface Box { x: number; y: number; w: number; h: number }
  interface Shell {
    rail: { present: boolean; width: number; headerText: string; headerButtons: string[] } | null;
    menu: { open: boolean; rows: string[] } | null;
    restore: Box | null;
    main: Box;
    /** Every control the main area paints, plus the dock, so an overlap with
        the restore button is a measurement and not an opinion. */
    neighbours: { label: string; box: Box }[];
    shellText: string;
  }

  const readShell = (page: Page) => page.evaluate((): Shell => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const rail = document.querySelector<HTMLElement>("aside:not([data-orchestrator-dock])");
    const header = rail?.querySelector<HTMLElement>("header") ?? null;
    const panel = document.querySelector<HTMLElement>("[data-rail-menu-panel]");
    const main = document.querySelector<HTMLElement>("main")!;
    const restore = document.querySelector<HTMLElement>("[data-rail-restore]");
    const neighbours = [
      ...[...main.querySelectorAll<HTMLElement>("button")].slice(0, 12).map((el, index) => ({ label: `main control ${index + 1}`, box: box(el) })),
      ...[...document.querySelectorAll<HTMLElement>("[data-orchestrator-dock]")].map((el) => ({ label: "orchestrator dock", box: box(el) })),
    ].filter((entry) => entry.box.w > 0 && entry.box.h > 0);
    return {
      rail: rail
        ? {
          present: true,
          width: box(rail).w,
          headerText: (header?.textContent ?? "").replace(/\s+/g, " ").trim(),
          headerButtons: [...(header?.querySelectorAll<HTMLElement>(":scope > button, :scope > div > button") ?? [])].map((el) => el.getAttribute("aria-label") ?? ""),
        }
        : null,
      menu: panel ? { open: true, rows: [...panel.querySelectorAll<HTMLElement>(":scope > div")].map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim()) } : null,
      restore: restore ? box(restore) : null,
      main: box(main),
      neighbours,
      shellText: (document.getElementById("root")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  });

  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  browserTest("one control puts the whole sidebar away, and the header it leaves carries no counters", async () => {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const OUT = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "llv-1819-"));
    const server = await serveEvidenceFixture(OUT);
    const browser: Browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const scheme of ["light", "dark"] as const) {
        const { context, page, pageErrors } = await openFixture(browser, server.base, VIEWPORT, scheme, "en");
        try {
          await page.waitForSelector("aside [data-rail-menu]");
          await page.waitForTimeout(500);

          /* ---- Shown, with the menu open: the frame the operator judges. */
          await page.click("[data-rail-menu]");
          await page.waitForSelector("[data-rail-menu-panel]");
          const shown = await readShell(page);
          await page.screenshot({ path: path.join(OUT, `${scheme}-rail-shown-menu-open.png`) });

          if (!shown.rail) failures.push(`${scheme}: the rail is not on screen to begin with`);
          if (/\d/.test(shown.rail?.headerText ?? "")) failures.push(`${scheme}: the rail header still prints a count: ${JSON.stringify(shown.rail?.headerText)}`);
          if ((shown.rail?.headerText ?? "").includes("⏸")) failures.push(`${scheme}: the rail header still carries the paused badge`);
          if ((shown.rail?.headerButtons.length ?? 0) !== 2) failures.push(`${scheme}: the rail header carries ${shown.rail?.headerButtons.length} controls, not the hide control and one menu`);
          if ((shown.menu?.rows.length ?? 0) !== 3) failures.push(`${scheme}: the menu holds ${shown.menu?.rows.length} rows, not three`);
          for (const needle of ["Language", "English", "Open on phone (QR)", "Notifications"]) {
            if (!(shown.menu?.rows ?? []).some((row) => row.includes(needle))) failures.push(`${scheme}: the menu says nothing about "${needle}" (${JSON.stringify(shown.menu?.rows)})`);
          }

          /* ---- Hidden: the rail is gone from the document, not merely off. */
          await page.keyboard.press("Escape");
          await page.click("[data-rail-hide]");
          await page.waitForTimeout(400);
          const hidden = await readShell(page);
          await page.screenshot({ path: path.join(OUT, `${scheme}-rail-hidden.png`) });

          if (hidden.rail) failures.push(`${scheme}: the rail is still in the document after the hide control`);
          if (!hidden.restore) failures.push(`${scheme}: nothing on screen brings the rail back`);
          if (hidden.shellText.includes("Agent logs")) failures.push(`${scheme}: the rail's title is still readable with the rail hidden`);
          if (hidden.main.w <= shown.main.w) failures.push(`${scheme}: the main area did not widen (${shown.main.w} → ${hidden.main.w})`);
          if (hidden.main.w < shown.main.w + (shown.rail?.width ?? 0) - 48) failures.push(`${scheme}: the main area took back only ${hidden.main.w - shown.main.w}px of the rail's ${shown.rail?.width}px`);
          if (hidden.restore && (hidden.restore.w > 40 || hidden.restore.h > 40)) failures.push(`${scheme}: the restore control is ${hidden.restore.w}×${hidden.restore.h}, not an unobtrusive edge control`);
          for (const neighbour of hidden.neighbours) {
            if (hidden.restore && overlaps(hidden.restore, neighbour.box)) failures.push(`${scheme}: the restore control overlaps the ${neighbour.label}`);
          }

          /* ---- Back, and then the same toggle from the keyboard. */
          await page.click("[data-rail-restore]");
          await page.waitForTimeout(400);
          const back = await readShell(page);
          if (!back.rail) failures.push(`${scheme}: the restore control did not bring the rail back`);

          await page.keyboard.press("Escape");
          await page.click("main");
          await page.keyboard.press("b");
          await page.waitForTimeout(400);
          const afterKey = await readShell(page);
          if (afterKey.rail) failures.push(`${scheme}: the B key did not hide the rail`);
          await page.keyboard.press("b");
          await page.waitForTimeout(400);
          const afterKeyBack = await readShell(page);
          if (!afterKeyBack.rail) failures.push(`${scheme}: the B key did not bring the rail back`);

          frames[scheme] = { shown, hidden, back: { rail: back.rail, main: back.main }, afterKey: { rail: afterKey.rail, restore: afterKey.restore }, afterKeyBack: { rail: afterKeyBack.rail } };
          if (pageErrors.length) failures.push(`${scheme}: ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }

    fs.writeFileSync(path.join(EVIDENCE, "sidebar.json"), `${JSON.stringify({ viewport: VIEWPORT, frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 300_000);
});

/* #1798's return arc under the collapsed row is gone from the card: variant B
   (#2072) puts a fired fail edge on the failing pill as "↺1/2", and the arc is
   drawn only by the graph. The rendered record of the arc stays in
   `evidence/issue-1798/`; the suffix is gated by `PipelineBlock.dom.test.tsx`
   and the "#2072 one pipeline block" case below. */

describe("#1836 where the view was just taken", () => {
  /*
   * Rendered evidence for the arrival (#1836), in the real Viewer over
   * `issue1695Evidence.fixture.tsx`, against the production stylesheet, in
   * Chromium — desktop and 390x844, light and dark, both motion preferences.
   *
   * The arrival is DRIVEN, not imitated: the page runs the real focus
   * transaction, asks the board's own index what it drew the anchor as, and
   * hands that to the real `startArrivalPulse` — the same three calls
   * `AttentionHost` makes. A driver that set the attribute itself would
   * photograph the stylesheet and prove nothing about what gets marked.
   *
   * What only a browser settles, and is gated here:
   *   - the mark paints a ring the card does not otherwise carry, so the
   *     landed card is findable at a glance beside its neighbours;
   *   - it is a blink (a running animation) by default and a STEADY highlight
   *     of the same strength under reduced motion, never nothing;
   *   - it moves NOTHING: the landed element and its neighbour occupy exactly
   *     the same boxes while it plays;
   *   - it takes itself off, leaving the card exactly as it was;
   *   - a conversation no card holds is landed in its own reader pane, and
   *     that pane is what lights up.
   *
   * 390x844 is the phone, and the phone is recorded rather than gated for the
   * handoff itself: mobile is chat-only by design — it withholds its device id
   * and never follows a handoff (`src/lib/attention/service.ts`) — so what is
   * measured there is the decoration the operator would see, on the surface
   * that width actually draws.
   *
   * The scheme's own surfaces (an absolutely positioned node and task band)
   * are not drawn by this fixture; their geometry is settled in the board
   * geometry driver, `scripts/capture-board-geometry.ts`, and their positioning
   * contract in `arrivalPulse.dom.test.tsx`.
   *
   * Geometry goes to `evidence/issue-1836/arrival-pulse.json`; frames to
   * `.artifacts/issue-1836/`, which is not committed.
   */
  type PulseEvidence = {
    focus: {
      bus: { board(): { index: { pulseSelectorFor?(key: string): string | null } } | null };
      runFocusTransaction(request: unknown, bus: unknown, options: unknown): Promise<{ resolution: string; moved: boolean }>;
      startArrivalPulse(selectors: Array<string | null>, options?: { durationMs?: number }): { cancel(): void };
      cancelArrivalPulse(): void;
    };
  };

  /** One arrival, exactly as the host performs it: the transaction, the board's
      own answer for what it drew, and the mark. Returns what the page can only
      say from inside itself — the boxes and the paint, before, during, after. */
  const arrive = (page: Page, path: string, intent: "show" | "open", neighbour: string | null) => page.evaluate(async ([target, wanted, near]) => {
    const { bus, runFocusTransaction, startArrivalPulse } = (window as unknown as { evidence: PulseEvidence }).evidence.focus;
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    const paint = (element: Element | null) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return { animation: style.animationName, duration: style.animationDuration, shadow: style.boxShadow, position: style.position };
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const result = await runFocusTransaction({
      id: `attention_pulse_${wanted}`,
      target: { kind: "conversation", path: target },
      frameAtCreation: { project: "atlas", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
      intent: wanted,
      zoom: "inspect",
    }, bus, { timeoutMs: 8_000 });
    await wait(400);

    const selector = bus.board()?.index.pulseSelectorFor?.(target) ?? null;
    const landed = selector ? document.querySelector(selector) : null;
    const other = near ? document.querySelector(near) : null;
    const before = { landed: box(landed), neighbour: box(other), paint: paint(landed) };
    startArrivalPulse([selector]);
    /* Past the card's own box-shadow transition, so what is measured and
       photographed is the pulse rather than the way into it. */
    await wait(300);
    const during = { landed: box(landed), neighbour: box(other), paint: paint(landed), mark: landed?.getAttribute("data-attention-pulse") ?? null };
    return { resolution: result.resolution, selector, before, during };
  }, [path, intent, neighbour] as const);

  /** The mark comes off, and the page says what it left behind. */
  const settlePulse = (page: Page, selector: string | null, neighbour: string | null) => page.evaluate(async ([sel, near]) => {
    const { cancelArrivalPulse } = (window as unknown as { evidence: PulseEvidence }).evidence.focus;
    cancelArrivalPulse();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const landed = sel ? document.querySelector(sel) : null;
    const other = near ? document.querySelector(near) : null;
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    const style = landed ? getComputedStyle(landed) : null;
    return {
      landed: box(landed),
      neighbour: box(other),
      paint: style ? { animation: style.animationName, duration: style.animationDuration, shadow: style.boxShadow, position: style.position } : null,
      mark: landed?.getAttribute("data-attention-pulse") ?? null,
    };
  }, [selector, neighbour] as const);

  browserTest("the landed card blinks, holds steady under reduced motion, moves nothing, and leaves nothing behind", async () => {
    const out = path.resolve(".artifacts/issue-1836");
    fs.mkdirSync(out, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const IMPLEMENTER = "/repo/export-impl.jsonl";
    const REVIEWER = "/repo/export-review.jsonl";
    const evidence: Record<string, unknown> = {
      driver: "src/components/kanban/kanbanBoard.browser.test.tsx",
      fixture: "src/components/kanban/issue1695Evidence.fixture.tsx",
      values: "invented",
    };
    const failures: string[] = [];
    try {
      for (const [surface, viewport] of [["desktop", VIEWPORT], ["phone", { width: 390, height: 844 }]] as const) {
        for (const scheme of ["light", "dark"] as const) {
          for (const motion of ["no-preference", "reduce"] as const) {
            const label = `${surface}-${scheme}-${motion}`;
            const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=loose`, viewport, scheme, "en", motion);
            try {
              const kanban = await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 }).then(() => true).catch(() => false);
              const board = await page.evaluate(() => (document.querySelector("[data-mobile2-board]") ? "mobile2" : document.querySelector("[data-kanban-board]") ? "kanban" : "none"));
              if (!kanban) {
                /* The phone. Mobile is chat-only for a handoff, so there is no
                   arrival to gate — what is recorded is the surface that width
                   draws, and the decoration on it, which is what the operator
                   would have to see at a glance. */
                const rows = await page.$$eval("[data-mobile2-row], .card[data-id]", (nodes) => nodes.length);
                const mark = await page.evaluate(async () => {
                  const { startArrivalPulse, cancelArrivalPulse } = (window as unknown as { evidence: PulseEvidence }).evidence.focus;
                  const row = document.querySelector("[data-mobile2-row], .card[data-id]");
                  if (!row) return null;
                  const rect = () => { const box = row.getBoundingClientRect(); return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }; };
                  const shadow = () => getComputedStyle(row).boxShadow;
                  const before = { box: rect(), shadow: shadow() };
                  startArrivalPulse(["[data-mobile2-row], .card[data-id]"]);
                  await new Promise((resolve) => setTimeout(resolve, 300));
                  const during = { box: rect(), shadow: shadow(), animation: getComputedStyle(row).animationName, mark: row.getAttribute("data-attention-pulse") };
                  cancelArrivalPulse();
                  await new Promise((resolve) => setTimeout(resolve, 200));
                  return { before, during, after: { box: rect(), shadow: shadow() } };
                });
                await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
                if (mark) {
                  if (mark.during.shadow === mark.before.shadow) failures.push(`${label}: the mark painted no ring at 390x844`);
                  if (JSON.stringify(mark.during.box) !== JSON.stringify(mark.before.box)) failures.push(`${label}: the mark moved the row it lit`);
                  if (motion === "no-preference" && mark.during.animation !== "attention-arrival-pulse") failures.push(`${label}: no blink (${mark.during.animation})`);
                  if (motion === "reduce" && mark.during.animation !== "none") failures.push(`${label}: reduced motion still animates (${mark.during.animation})`);
                  if (mark.after.shadow !== mark.before.shadow) failures.push(`${label}: the mark left something behind`);
                }
                evidence[label] = { viewport, board, rows, handoff: "the phone withholds its device id and never follows a handoff", mark };
                if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
                continue;
              }

              /* A conversation a card holds: the card is what lights up, and
                 its neighbour must not stir. */
              const neighbour = "[data-kanban-board] .card[data-id] ~ .card[data-id]";
              const card = await arrive(page, IMPLEMENTER, "show", neighbour);
              await page.screenshot({ path: path.join(out, `${label}-card.png`) });
              const cleared = await settlePulse(page, card.selector, neighbour);
              if (card.resolution === "lost") failures.push(`${label}: the handoff found nowhere to land`);
              if (!card.selector) failures.push(`${label}: the board answered no selector for the landed card`);
              if (!card.during.paint || card.during.paint.shadow === card.before.paint?.shadow) failures.push(`${label}: the mark painted no ring`);
              if (JSON.stringify(card.during.landed) !== JSON.stringify(card.before.landed)) failures.push(`${label}: the mark moved the card it lit`);
              if (JSON.stringify(card.during.neighbour) !== JSON.stringify(card.before.neighbour)) failures.push(`${label}: the mark moved the neighbouring card`);
              if (motion === "no-preference" && card.during.paint?.animation !== "attention-arrival-pulse") failures.push(`${label}: no blink (${card.during.paint?.animation})`);
              if (motion === "reduce" && card.during.paint?.animation !== "none") failures.push(`${label}: reduced motion still animates (${card.during.paint?.animation})`);
              if (motion === "reduce" && !/0px 0px 0px [\d.]+px/.test(card.during.paint?.shadow ?? "")) failures.push(`${label}: reduced motion left no ring`);
              if (cleared.mark !== null) failures.push(`${label}: the mark outlived the pulse`);
              if (cleared.paint?.shadow !== card.before.paint?.shadow) failures.push(`${label}: the card did not go back to what it was`);
              if (JSON.stringify(cleared.landed) !== JSON.stringify(card.before.landed)) failures.push(`${label}: the card ended somewhere else`);

              /* A conversation NO card holds: it is opened in its own reader,
                 and that pane is the thing the operator is being pointed at. */
              const pane = await arrive(page, REVIEWER, "open", null);
              await page.screenshot({ path: path.join(out, `${label}-reader.png`) });
              const paneCleared = await settlePulse(page, pane.selector, null);
              if (!pane.selector?.includes("data-reader-path")) failures.push(`${label}: the board answered ${pane.selector} for a conversation no card holds`);
              if (pane.during.paint?.shadow === pane.before.paint?.shadow) failures.push(`${label}: the reader pane was not lit`);
              if (JSON.stringify(pane.during.landed) !== JSON.stringify(pane.before.landed)) failures.push(`${label}: the mark moved the reader pane`);
              if (paneCleared.mark !== null) failures.push(`${label}: the reader pane stayed lit`);

              evidence[label] = { viewport, board, card, cleared, pane, paneCleared };
              if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
            } finally { await context.close(); }
          }
        }
      }
      fs.mkdirSync("evidence/issue-1836", { recursive: true });
      fs.writeFileSync("evidence/issue-1836/arrival-pulse.json", JSON.stringify({ ...evidence, failures }, null, 2) + "\n");
      if (failures.length) throw new Error(failures.join("\n"));
    } finally { await browser.close(); server.stop(); }
  }, 600_000);
});

describe("#1836 the phone draws a lane the moment the server admits it", () => {
  /*
   * The phone board at 390x844, in the real Viewer over
   * `issue1695Evidence.fixture.tsx`. The fixture's `/api/files` scan never
   * carries the admitted lane; only `/api/attention` hands it out, as the rows
   * the server holds. So a lane on this board came from the push.
   *
   * Gated: the pipelines row counts the lane, the pipelines list names it,
   * the phone never names a device or posts anything (it stays chat-only for
   * a handoff), and a lane the server then drops leaves the list again.
   *
   * Geometry and counts go to `evidence/issue-1836/phone-admitted-lane.json`;
   * frames to `.artifacts/issue-1836/`, which is not committed.
   */
  type LaneEvidence = {
    admitLane(title: string): void;
    admitted: unknown;
    attentionCalls: Array<{ url: string; method: string }>;
  };
  const TITLE = "A lane just created";

  browserTest("the admitted lane is on the phone board before any scan carries it, and leaves when dropped", async () => {
    const out = path.resolve(".artifacts/issue-1836");
    fs.mkdirSync(out, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const evidence: Record<string, unknown> = {
      driver: "src/components/kanban/kanbanBoard.browser.test.tsx",
      fixture: "src/components/kanban/issue1695Evidence.fixture.tsx",
      values: "invented",
    };
    const failures: string[] = [];
    const viewport = { width: 390, height: 844 };
    const pipelinesRow = "[data-mobile2-row='pipelines']";
    const poll = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    try {
      for (const scheme of ["light", "dark"] as const) {
        const label = `phone-${scheme}`;
        const { context, page, pageErrors } = await openFixture(browser, server.base, viewport, scheme, "en");
        try {
          await page.waitForSelector("[data-mobile2-board]", { timeout: 20_000 });
          const rowText = () => page.$eval(pipelinesRow, (node) => node.textContent ?? "").catch(() => null);
          const before = await rowText();
          await page.screenshot({ path: path.join(out, `${label}-before.png`) });

          await page.evaluate((title) => (window as unknown as { evidence: LaneEvidence }).evidence.admitLane(title), TITLE);
          const admittedAt = Date.now();
          await poll(page);
          let during = before;
          while (Date.now() - admittedAt < 5_000 && during === before) {
            await page.waitForTimeout(100);
            during = await rowText();
          }
          const drawnAfterMs = Date.now() - admittedAt;
          await page.screenshot({ path: path.join(out, `${label}-admitted.png`) });
          if (during === before) failures.push(`${label}: the pipelines row did not count the admitted lane (${before})`);

          await page.click(pipelinesRow);
          const listed = await page.waitForFunction((title) => document.body.textContent?.includes(title), TITLE, { timeout: 5_000 }).then(() => true).catch(() => false);
          await page.screenshot({ path: path.join(out, `${label}-list.png`) });
          if (!listed) failures.push(`${label}: the pipelines list does not name the admitted lane`);

          /* The server drops it: refused, or never materialized. */
          await page.evaluate(() => { (window as unknown as { evidence: LaneEvidence }).evidence.admitted = null; });
          await poll(page);
          const gone = await page.waitForFunction((title) => !document.body.textContent?.includes(title), TITLE, { timeout: 5_000 }).then(() => true).catch(() => false);
          await page.screenshot({ path: path.join(out, `${label}-withdrawn.png`) });
          if (!gone) failures.push(`${label}: the dropped lane stayed on the list`);

          const calls = await page.evaluate(() => (window as unknown as { evidence: LaneEvidence }).evidence.attentionCalls);
          if (calls.length === 0) failures.push(`${label}: the phone never read the admitted rows`);
          if (calls.some((call) => call.method !== "GET")) failures.push(`${label}: the phone posted to the attention record`);
          if (calls.some((call) => call.url.includes("deviceId="))) failures.push(`${label}: the phone named a device`);

          evidence[label] = { viewport, pipelinesRow: { before, during }, drawnAfterMs, listed, withdrawn: gone, attentionCalls: calls };
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/issue-1836", { recursive: true });
      fs.writeFileSync("evidence/issue-1836/phone-admitted-lane.json", JSON.stringify({ ...evidence, failures }, null, 2) + "\n");
      if (failures.length) throw new Error(failures.join("\n"));
    } finally { await browser.close(); server.stop(); }
  }, 300_000);
});

describe("#1834 the card's collapsed Details row", () => {
  /*
   * Rendered evidence for the agent-context split (#1834), in the real Viewer
   * over `issue1695Evidence.fixture.tsx`, in Chromium at a desktop viewport
   * (light and dark) and on the phone at 390×844:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx
   *
   * Gated here, because only a laid-out page settles it:
   *   - closed, the card carries ONE row saying «Details» and nothing of the
   *     agent's text is readable anywhere on it, while the title and the
   *     description are exactly what they were;
   *   - opened, the whole text is in place inside the card and scrolls INSIDE
   *     itself — the element overflows and the card's own height barely moves,
   *     which is the claim a DOM test cannot make;
   *   - a task without details carries no row at all;
   *   - clicking the opened text opens the editor in its place;
   *   - the phone's opened task shows the same one closed row and opens the
   *     same text.
   *
   * Measurements go to `evidence/issue-1834/details.json`; no frame is
   * committed — the PNGs stay in the run's own temp directory.
   */

  const EVIDENCE = path.resolve("evidence/issue-1834");
  const DETAILED = "t-search";
  const PLAIN = "t-upload";

  interface Row {
    present: boolean;
    label: string;
    expanded: boolean;
    /** The opened text, its box and whether it scrolls inside itself. */
    text: { chars: number; firstLine: string; clientHeight: number; scrollHeight: number; overflowY: string; fontFamily: string } | null;
    editorField: string | null;
  }
  interface Measured {
    board: string;
    detailed: { cardHeight: number; title: string; description: string; row: Row; textOnCard: boolean };
    plain: { row: Row; description: string };
  }

  const readRow = (page: Page, id: string) => page.evaluate((selector: string): Row => {
    const card = document.querySelector<HTMLElement>(selector);
    const block = card?.querySelector<HTMLElement>("[data-details]") ?? null;
    const toggle = block?.querySelector<HTMLElement>("[data-details-toggle]") ?? null;
    const text = block?.querySelector<HTMLElement>("[data-details-text]") ?? null;
    const style = text ? getComputedStyle(text) : null;
    return {
      present: Boolean(block),
      label: (toggle?.textContent ?? "").replace(/\s+/g, " ").trim(),
      expanded: toggle?.getAttribute("aria-expanded") === "true",
      text: text
        ? {
          chars: (text.textContent ?? "").length,
          firstLine: (text.textContent ?? "").split("\n")[0]!.slice(0, 60),
          clientHeight: Math.round(text.clientHeight),
          scrollHeight: Math.round(text.scrollHeight),
          overflowY: style!.overflowY,
          fontFamily: style!.fontFamily,
        }
        : null,
      editorField: block?.querySelector<HTMLElement>("[data-card-editor]")?.getAttribute("data-card-editor") ?? null,
    };
  }, `${card(id)}`);

  /** One reading of both cards: the shared shape above plus each card's row. */
  const measure = async (page: Page): Promise<Measured> => {
    const shell = await page.evaluate((selectors: { detailed: string; plain: string }) => {
      const words = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
      const detailed = document.querySelector<HTMLElement>(selectors.detailed);
      const plain = document.querySelector<HTMLElement>(selectors.plain);
      return {
        board: document.querySelector("[data-kanban-board]") ? "kanban" : document.querySelector("[data-mobile2-board]") ? "mobile2" : "none",
        cardHeight: Math.round(detailed?.getBoundingClientRect().height ?? 0),
        title: words(detailed?.querySelector(".title")),
        description: words(detailed?.querySelector(".desc")),
        textOnCard: words(detailed).includes("Files another lane holds"),
        plainDescription: words(plain?.querySelector(".desc")),
      };
    }, { detailed: card(DETAILED), plain: card(PLAIN) });
    return {
      board: shell.board,
      detailed: { cardHeight: shell.cardHeight, title: shell.title, description: shell.description, row: await readRow(page, DETAILED), textOnCard: shell.textOnCard },
      plain: { row: await readRow(page, PLAIN), description: shell.plainDescription },
    };
  };

  browserTest("the agent's context is one closed row on the card, and opens in place scrolling inside itself", async () => {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const OUT = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "llv-1834-"));
    const server = await serveEvidenceFixture(OUT);
    const browser: Browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];

    const desktop = async (scheme: Scheme, lang: "en" | "uk") => {
      const label = `${scheme}-${lang}`;
      const { context, page, pageErrors } = await openFixture(browser, server.base, VIEWPORT, scheme, lang);
      try {
        await page.waitForSelector(card(DETAILED), { timeout: 20_000 });
        await page.waitForTimeout(500);

        /* ---- Closed: one row, and none of the agent's text on the card. */
        const closed = await measure(page);
        await page.screenshot({ path: path.join(OUT, `${label}-details-closed.png`) });
        if (!closed.detailed.row.present) failures.push(`${label}: the card carries no Details row`);
        if (closed.detailed.row.expanded) failures.push(`${label}: the row is open before anything was clicked`);
        if (closed.detailed.row.text) failures.push(`${label}: the agent's text is on the card while the row is shut`);
        if (closed.detailed.textOnCard) failures.push(`${label}: the agent's own words are readable on the closed card`);
        if (closed.detailed.row.label !== (lang === "uk" ? "Деталі" : "Details")) failures.push(`${label}: the row says ${JSON.stringify(closed.detailed.row.label)}`);
        if (!closed.detailed.description.startsWith("Results vanish")) failures.push(`${label}: the human description moved: ${JSON.stringify(closed.detailed.description)}`);
        /* A task nobody wrote details for carries no row at all. */
        if (closed.plain.row.present) failures.push(`${label}: a task without details drew a Details row`);
        if (!closed.plain.description.startsWith("Resumable uploads")) failures.push(`${label}: the plain card's description moved`);

        /* ---- Opened: the whole text, in place, scrolling inside itself. */
        await page.click(`${card(DETAILED)} [data-details-toggle]`);
        await page.waitForTimeout(300);
        const open = await measure(page);
        await page.screenshot({ path: path.join(OUT, `${label}-details-open.png`) });
        if (!open.detailed.row.expanded) failures.push(`${label}: the row did not open`);
        if (!open.detailed.row.text) failures.push(`${label}: opening the row showed no text`);
        if ((open.detailed.row.text?.chars ?? 0) < 200) failures.push(`${label}: the opened text is only ${open.detailed.row.text?.chars} characters`);
        if (open.detailed.row.text && open.detailed.row.text.scrollHeight <= open.detailed.row.text.clientHeight) {
          failures.push(`${label}: the opened text does not overflow its own box (${open.detailed.row.text.clientHeight} ≥ ${open.detailed.row.text.scrollHeight}), so nothing proves it scrolls inside itself`);
        }
        if (open.detailed.row.text && !/auto|scroll/.test(open.detailed.row.text.overflowY)) {
          failures.push(`${label}: the opened text has overflow-y ${open.detailed.row.text.overflowY}, so it cannot scroll inside itself`);
        }
        if (open.detailed.cardHeight - closed.detailed.cardHeight > 320) {
          failures.push(`${label}: opening the row grew the card by ${open.detailed.cardHeight - closed.detailed.cardHeight}px, so the text is not bounded`);
        }
        if (open.detailed.title !== closed.detailed.title || open.detailed.description !== closed.detailed.description) {
          failures.push(`${label}: opening the row changed the human title or description`);
        }

        /* ---- The opened text is edited in its place. */
        await page.click(`${card(DETAILED)} [data-details-text]`);
        await page.waitForTimeout(300);
        const editing = await readRow(page, DETAILED);
        await page.screenshot({ path: path.join(OUT, `${label}-details-editing.png`) });
        if (editing.editorField !== "details") failures.push(`${label}: clicking the opened text opened ${JSON.stringify(editing.editorField)} instead of the details editor`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);

        /* ---- Shut again: one row, and the text gone from the card. */
        await page.click(`${card(DETAILED)} [data-details-toggle]`);
        await page.waitForTimeout(300);
        const shut = await readRow(page, DETAILED);
        if (shut.expanded || shut.text) failures.push(`${label}: the row did not shut again`);

        frames[label] = { viewport: VIEWPORT, closed, open, editing, shut };
        if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await context.close();
      }
    };

    /* The phone draws its own board, and a task is opened from its menu. */
    const phone = async () => {
      const label = "390";
      const viewport = { width: 390, height: 844 };
      const { context, page, pageErrors } = await openFixture(browser, server.base, viewport, "light", "en");
      try {
        await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 20_000 });
        await page.waitForTimeout(500);
        await page.click('[data-mobile2-open="menu"]');
        await page.click('[data-mobile2-menu-row="tasks"]');
        await page.waitForTimeout(400);
        await page.getByText("Restore search results after the index rebuild").first().click();
        await page.waitForSelector("[data-task-details-toggle]", { timeout: 10_000 });
        await page.waitForTimeout(300);

        const read = () => page.evaluate(() => {
          const block = document.querySelector<HTMLElement>("[data-task-details]");
          const toggle = document.querySelector<HTMLElement>("[data-task-details-toggle]");
          const field = block?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
          const text = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task text"]');
          const style = field ? getComputedStyle(field) : null;
          return {
            rows: document.querySelectorAll("[data-task-details-toggle]").length,
            label: (toggle?.textContent ?? "").replace(/\s+/g, " ").trim(),
            expanded: toggle?.getAttribute("aria-expanded") === "true",
            details: field
              ? { chars: field.value.length, clientHeight: Math.round(field.clientHeight), scrollHeight: Math.round(field.scrollHeight), overflowY: style!.overflowY }
              : null,
            taskText: (text?.value ?? "").split("\n")[0] ?? "",
            contextReadable: (document.getElementById("root")?.textContent ?? "").includes("Files another lane holds"),
          };
        });

        const closed = await read();
        await page.screenshot({ path: path.join(OUT, "phone-390x844-details-closed.png") });
        if (closed.rows !== 1) failures.push(`${label}: the opened task carries ${closed.rows} details rows, not one`);
        if (closed.expanded) failures.push(`${label}: the row is open before anything was tapped`);
        if (closed.details) failures.push(`${label}: the agent's text is on screen while the row is shut`);
        if (closed.contextReadable) failures.push(`${label}: the agent's own words are readable with the row shut`);
        if (closed.label !== "Details") failures.push(`${label}: the row says ${JSON.stringify(closed.label)}`);
        if (!closed.taskText.startsWith("Restore search results")) failures.push(`${label}: the task's own text is not the text field's first line`);

        await page.click("[data-task-details-toggle]");
        await page.waitForTimeout(300);
        const open = await read();
        await page.screenshot({ path: path.join(OUT, "phone-390x844-details-open.png") });
        if (!open.expanded || !open.details) failures.push(`${label}: tapping the row showed no text`);
        if ((open.details?.chars ?? 0) < 200) failures.push(`${label}: the opened text is only ${open.details?.chars} characters`);
        if (open.details && open.details.scrollHeight <= open.details.clientHeight) {
          failures.push(`${label}: the opened text does not overflow its own box, so nothing proves it scrolls inside itself`);
        }
        if (open.taskText !== closed.taskText) failures.push(`${label}: opening the row changed the task's text`);

        frames[label] = { viewport, closed, open };
        if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally {
        await context.close();
      }
    };

    try {
      await desktop("light", "en");
      await desktop("dark", "uk");
      await phone();
    } finally {
      await browser.close();
      server.stop();
    }

    fs.writeFileSync(path.join(EVIDENCE, "details.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});


describe("role evaluation mounted candidate", () => {
  const candidateTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" && process.env.ROLE_EVAL_CANDIDATE ? test : test.skip;
  candidateTest("executes final-row rejection, reorder, touch and keyboard retry", async () => {
    const { gradeRendered } = await import("../../../evals/roles/graders/rendered");
    await gradeRendered(path.resolve(process.env.ROLE_EVAL_CANDIDATE!), path.resolve(process.env.ROLE_EVAL_OUTPUT!));
  }, 180_000);
});


describe("readable tool rows", () => {
  browserTest("Codex feed at phone and desktop widths", async () => {
    const phase = process.env.TOOL_CAPTURE_PHASE === "before" ? "before" : "after";
    const out = path.resolve(`.artifacts/readable-tools/${phase}`);
    fs.mkdirSync(out, { recursive: true });
    const server = await serveEvidenceFixture(out, "src/components/feed/__fixtures__/readableTools.fixture.tsx");
    const browser = await chromium.launch(LAUNCH);
    const readings: object[] = [];
    try {
      for (const width of [390, 1280]) for (const lang of ["en", "uk"] as const) {
        const { context, page, pageErrors } = await openFixture(browser, server.base, { width, height: 1000 }, "dark", lang);
        await page.locator("[data-readable-tools]").waitFor();
        await page.screenshot({ path: path.join(out, `${width}-${lang}-closed.png`), fullPage: true });
        // Open the existing tool/group disclosures with real pointer input.
        for (let round = 0; round < 8; round++) {
          // Pin each node while clicking: a live :not([open]) locator can
          // retarget between Playwright's checks and the native toggle event.
          const details = await page.locator("details:not([open]) > summary").elementHandles();
          for (const summary of details) {
            if (await summary.evaluate(el => !el.parentElement?.hasAttribute("open"))) await summary.click();
            await page.waitForTimeout(100);
          }
          const folds = page.locator("[data-mobile-run-fold][aria-expanded=false]");
          if (await folds.count()) {
            await folds.first().click();
            await page.waitForTimeout(100);
          }
          await page.waitForTimeout(100);
          if (!await page.locator("details:not([open]), [data-mobile-run-fold][aria-expanded=false]").count()) break;
        }
        expect(await page.locator("details:not([open]), [data-mobile-run-fold][aria-expanded=false]").count()).toBe(0);
        await page.screenshot({ path: path.join(out, `${width}-${lang}-open.png`), fullPage: true });
        const reading = await page.locator("[data-readable-tools]").evaluate(el => ({
          text: el.textContent, scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth, rows: el.querySelectorAll("details").length,
        }));
        expect(pageErrors).toEqual([]);
        expect(reading.scrollWidth).toBeLessThanOrEqual(width);
        if (phase === "after") {
          expect(reading.text).toContain("git status --short");
          expect(reading.text).toContain("Check retry behaviour");
          expect(reading.text).toContain("+1");
          expect(reading.text).not.toContain("Text absent");
          expect(reading.text).not.toContain("Extension");
          expect(await page.locator("[data-readable-tools]").innerHTML()).not.toContain("invented-review-value");
          expect(reading.text).toContain("application/json");
          const clippedChips = await page.locator("[data-tool-chip]").evaluateAll(chips =>
            chips.filter(el => el.scrollWidth > el.clientWidth + 1).length);
          expect(clippedChips).toBe(0);
          // Short labels stay on one line even next to a one-character value.
          const wrappedLabels = await page.locator("[data-tool-chip] > span:first-child").evaluateAll(labels =>
            labels.filter(el => el.getClientRects().length > 1).length);
          expect(wrappedLabels).toBe(0);
        }
        readings.push({ width, lang, ...reading });
        await context.close();
      }
      fs.mkdirSync("evidence/readable-tools", { recursive: true });
      fs.writeFileSync(`evidence/readable-tools/${phase}.json`, JSON.stringify({ phase, readings }, null, 2) + "\n");
    } finally { await browser.close(); server.stop(); }
  }, 120_000);
});


/* #1938: Codex tool rows at phone width, beside Claude rows, in a real browser.
   happy-dom lays nothing out, so the defect this case exists for — a row whose
   label wrapped out of its own fixed-height box and painted over the row under
   it — is only visible where boxes have geometry. The fixture
   (`codexPhoneRows.fixture.tsx`) carries the same eight tool cases under both
   engines: clean, failed, heredoc, wrapper-prefixed, env-prefixed, very long,
   MCP and still running.

     CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
       bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "codex tool rows"

   `TOOL_ROW_CAPTURE_PHASE=before` records the defect without asserting it;
   the default `after` phase holds the verdicts. PNGs go to the directory named
   by `TOOL_ROW_PNG_DIR` so the pixels can be looked at before merging. */
describe("codex tool rows on a phone", () => {
  /* One row must contain its own text and never touch another row. Returned as
     data (not thrown) so every frame is measured and the evidence file records
     the whole matrix rather than the first failure. */
  const measureRows = `(() => {
    const rows = [...document.querySelectorAll("[data-tool-row]")];
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    const intersect = (a, b) => ({
      top: Math.max(a.top, b.top), left: Math.max(a.left, b.left),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
    });
    const empty = r => r.right - r.left < 0.5 || r.bottom - r.top < 0.5;
    /* A clipped label is not an escape: \`truncate\` hides the overflow, but a
       Range's rect ignores that, so each text rect is first cut down by every
       ancestor that clips it. What survives is what the operator can see. */
    const visible = (node, row) => {
      let clip = null;
      for (let el = node.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = clip ? intersect(clip, box(el)) : box(el);
        if (el === row) break;
      }
      return clip;
    };
    const textRects = row => {
      const out = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const clip = visible(node, row);
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const raw of range.getClientRects()) {
          if (raw.width === 0 || raw.height === 0) continue;
          const rect = clip ? intersect(clip, raw) : { top: raw.top, left: raw.left, right: raw.right, bottom: raw.bottom };
          if (empty(rect)) continue;
          out.push({ text: node.nodeValue.trim().slice(0, 60), rect });
        }
      }
      return out;
    };
    /* What the operator sees is ink, not the layout box: a label that wraps out
       of a fixed-height row keeps its row's box small and paints over the row
       below it. So each row is measured by the union of its box and every
       visible text rect inside it. */
    const inked = rows.map(row => {
      const base = box(row);
      const ink = { ...base };
      for (const { rect } of textRects(row)) {
        ink.top = Math.min(ink.top, rect.top); ink.left = Math.min(ink.left, rect.left);
        ink.right = Math.max(ink.right, rect.right); ink.bottom = Math.max(ink.bottom, rect.bottom);
      }
      return { base, ink, text: (row.textContent || "").trim().slice(0, 60) };
    });
    const disjoint = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
    const overlaps = [];
    for (let i = 0; i < inked.length; i++) for (let j = i + 1; j < inked.length; j++) {
      if (disjoint(inked[i].ink, inked[j].ink)) continue;
      overlaps.push({ a: i, b: j, aText: inked[i].text, bText: inked[j].text });
    }
    const escapes = [];
    for (const [index, row] of rows.entries()) {
      const r = box(row);
      for (const { text, rect } of textRects(row)) {
        if (rect.top >= r.top - 1 && rect.bottom <= r.bottom + 1 && rect.left >= r.left - 1 && rect.right <= r.right + 1) continue;
        escapes.push({
          row: index, text,
          overflowY: Math.round(Math.max(0, rect.bottom - r.bottom, r.top - rect.top)),
          overflowX: Math.round(Math.max(0, rect.right - r.right, r.left - rect.left)),
        });
        break;
      }
    }
    const lineHeight = parseFloat(getComputedStyle(document.body).lineHeight) || 16;
    const tall = inked.filter(row => row.ink.bottom - row.ink.top > lineHeight * 2.6)
      .map(row => ({ text: row.text, height: Math.round(row.ink.bottom - row.ink.top) }));
    return { rows: rows.length, overlaps, escapes, tall, scrollWidth: document.documentElement.scrollWidth };
  })()`;

  browserTest("rows stay one compact line and never overlap", async () => {
    const phase = process.env.TOOL_ROW_CAPTURE_PHASE === "before" ? "before" : "after";
    const out = path.resolve(`.artifacts/codex-phone-rows/${phase}`);
    const pngDir = process.env.TOOL_ROW_PNG_DIR ?? "/var/tmp/llv-codex-rows-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out, "src/components/feed/__fixtures__/codexPhoneRows.fixture.tsx");
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];
    const shots: string[] = [];
    try {
      for (const width of [390, 1280]) {
        for (const scheme of ["dark", "light"] as const) {
          for (const lang of ["en", "uk"] as const) {
            const { context, page, pageErrors } = await openFixture(browser, server.base, { width, height: 1400 }, scheme, lang);
            try {
              await page.locator("[data-codex-phone-rows]").waitFor();
              for (const state of ["collapsed", "expanded"] as const) {
                if (state === "expanded") {
                  /* Open every disclosure with real pointer input. Each node is
                     pinned before the click: a live `:not([open])` locator can
                     retarget between Playwright's check and the native toggle. */
                  for (let round = 0; round < 10; round++) {
                    for (const summary of await page.locator("details:not([open]) > summary").elementHandles()) {
                      if (await summary.evaluate(el => !el.parentElement?.hasAttribute("open"))) await summary.click();
                    }
                    const folds = page.locator("[data-mobile-run-fold][aria-expanded=false], [data-mobile-run] > button[aria-expanded=false]");
                    for (const fold of await folds.elementHandles()) await fold.click();
                    await page.waitForTimeout(80);
                    if (!(await page.locator("details:not([open]), [aria-expanded=false]").count())) break;
                  }
                }
                await page.waitForTimeout(80);
                const reading = await page.evaluate(measureRows) as {
                  rows: number; overlaps: unknown[]; escapes: unknown[]; tall: unknown[]; scrollWidth: number;
                };
                const label = `${width}-${scheme}-${lang}-${state}`;
                frames[label] = reading;
                for (const engine of ["codex", "claude"] as const) {
                  const name = `${engine}-${label}.png`;
                  await page.locator(`[data-rows-engine=${engine}]`).screenshot({ path: path.join(pngDir, name) });
                  shots.push(name);
                }
                if (phase !== "after") continue;
                if (!reading.rows) failures.push(`${label}: the fixture rendered no tool rows`);
                if (reading.overlaps.length) failures.push(`${label}: ${reading.overlaps.length} row pairs overlap — ${JSON.stringify(reading.overlaps[0])}`);
                if (reading.escapes.length) failures.push(`${label}: ${reading.escapes.length} text runs escape their row — ${JSON.stringify(reading.escapes[0])}`);
                if (reading.tall.length) failures.push(`${label}: ${reading.tall.length} rows are taller than one line — ${JSON.stringify(reading.tall[0])}`);
                if (reading.scrollWidth > width) failures.push(`${label}: the document scrolls sideways (${reading.scrollWidth} > ${width})`);
              }
              if (pageErrors.length) failures.push(`${width}-${scheme}-${lang}: page errors ${pageErrors.join(" | ")}`);
            } finally {
              await context.close();
            }
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/codex-phone-rows", { recursive: true });
    fs.writeFileSync(`evidence/codex-phone-rows/${phase}.json`, `${JSON.stringify({ phase, shots, frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});


/* #1959: the live-turn overlay at phone width, against the two transcript
   states that decide what it paints. The defect the operator photographed is a
   rendering one — dozens of "Bash · arguments omitted" and "viewer ·
   create_pipeline · arguments omitted" rows under the canonical cards — so it
   is measured where rows have geometry, over the same long turn the DOM tests
   use (`liveTurnLongTurn.fixture.ts`): sixty calls, long Viewer MCP names,
   failures, shed arguments, one still running.

     CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
       bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "live turn rows"

   `LIVE_ROWS_CAPTURE_PHASE=before` records the wall without asserting it (run
   it against the overlay as it was); the default `after` phase holds the
   verdicts. PNGs go to the directory named by `LIVE_ROWS_PNG_DIR` — they are
   never committed — and the readings to `evidence/live-turn-rows/<phase>.json`. */
describe("live turn rows on a phone", () => {
  /* What a title has to hold to be worth reading. At 390 px an overlay row is
     about 330 px wide, and the badge, the outcome mark and the row's own
     indent take a fixed bite out of it; what is left is the title's, and a
     title holding less than these is one the operator cannot use. The round-1
     row gave it 1.27 px — 0 % — because the chips took the line and the title
     was the only item left able to shrink. A chip smaller than `MIN_CHIP_PX`
     in either direction has been squeezed rather than wrapped. */
  const MIN_MCP_TITLE_PX = 140;
  const MIN_MCP_TITLE_SHARE = 40;
  const MIN_CHIP_PX = 24;

  /* What the operator can see of the overlay: how many rows it paints, what
     the collapsed line says, whether any row is a bare "arguments omitted",
     and whether a live row repeats a call the transcript below already shows. */
  const measureOverlay = `(() => {
    const phrases = ${JSON.stringify([en["feed.liveToolArgsOmitted"], translate("uk", "feed.liveToolArgsOmitted")])};
    const read = (section) => {
      const overlay = section.querySelector("[data-live-rows-overlay]");
      const transcript = section.querySelector("[data-live-rows-transcript]");
      const rows = [...overlay.querySelectorAll("[data-live-turn]")];
      const collapsed = overlay.querySelector("[data-live-turn-earlier]");
      const text = overlay.textContent || "";
      const ids = rows.map(row => row.getAttribute("data-live-turn-item-id")).filter(Boolean);
      const canonical = new Set(transcript
        ? [...transcript.querySelectorAll("[data-tool-row], [data-testid=mcp-call-card]")]
          .flatMap(node => (node.textContent || "").trim() ? [(node.textContent || "").trim()] : [])
        : []);
      const box = overlay.getBoundingClientRect();
      /* Round-2 P2: the action title is what the operator reads, so it is
         measured. On one flex line it was the only item able to shrink and
         two entity chips squeezed it to about a pixel; the readings below say
         how much of the row it holds now, and how tall the row grew to keep
         its chips whole. */
      const mcp = [...overlay.querySelectorAll("[data-live-mcp]")].map(row => {
        /* A bare flex-1 span is where the title lived before it was given a
           basis of its own, so the before phase measures the same thing. */
        const title = row.querySelector("[data-live-mcp-title]") || row.querySelector("span.flex-1");
        const rowBox = row.getBoundingClientRect();
        const titleBox = title.getBoundingClientRect();
        const chips = [...row.querySelectorAll("[data-live-mcp-link]")];
        const mark = row.querySelector("[data-live-mcp-outcome=omitted]") ? "omitted"
          : row.querySelector("[aria-label=success]") ? "success"
            : row.querySelector("[aria-label=error]") ? "error"
              : row.querySelector("[role=status]") ? "pending" : "none";
        return {
          tool: row.getAttribute("data-live-mcp"),
          status: row.getAttribute("data-live-tool-status"),
          state: row.getAttribute("data-live-mcp-state"),
          mark,
          chips: chips.length,
          /* A chip that had to shrink to fit is not a tappable chip. */
          minChipWidth: chips.length ? Math.round(Math.min(...chips.map(chip => chip.getBoundingClientRect().width))) : 0,
          minChipHeight: chips.length ? Math.round(Math.min(...chips.map(chip => chip.getBoundingClientRect().height))) : 0,
          rowWidth: Math.round(rowBox.width),
          rowHeight: Math.round(rowBox.height),
          titleWidth: Math.round(titleBox.width * 100) / 100,
          titleShare: rowBox.width ? Math.round((titleBox.width / rowBox.width) * 100) : 0,
          /* How much of the action title survives before the ellipsis. */
          titleFullWidth: title.scrollWidth,
          titleText: (title.textContent || "").trim(),
        };
      });
      /* The canonical McpCallCard the live row hands over to, measured in the
         same units and held to the same bounds (#1955). A handoff is only
         invisible if the card the transcript writes reads at least as well as
         the live row it replaces, so both sides of it are asserted here. */
      const canonicalMcp = transcript
        ? [...transcript.querySelectorAll("[data-testid=mcp-call-card]")].map(card => {
          /* A bare flex-1 span is where this title lived before it was given a
             basis of its own, so an earlier phase measures the same thing. */
          const title = card.querySelector("[data-mcp-title]") || card.querySelector("summary > span.flex-1");
          const summary = card.querySelector("summary");
          if (!title || !summary) return null;
          const rowBox = summary.getBoundingClientRect();
          const chips = [...card.querySelectorAll("[data-testid^=mcp-link-]")];
          return {
            tool: (title.textContent || "").trim().slice(0, 40),
            rowWidth: Math.round(rowBox.width),
            titleWidth: Math.round(title.getBoundingClientRect().width * 100) / 100,
            titleShare: rowBox.width ? Math.round((title.getBoundingClientRect().width / rowBox.width) * 100) : 0,
            chips: chips.length,
            minChipWidth: chips.length ? Math.round(Math.min(...chips.map(chip => chip.getBoundingClientRect().width))) : 0,
            minChipHeight: chips.length ? Math.round(Math.min(...chips.map(chip => chip.getBoundingClientRect().height))) : 0,
          };
        }).filter(Boolean)
        : [];
      return {
        mcp,
        canonicalMcp,
        rows: rows.length,
        height: Math.round(box.height),
        toolRows: rows.filter(row => row.hasAttribute("data-live-tool")).length,
        mcpRows: overlay.querySelectorAll("[data-live-mcp]").length,
        mcpChips: overlay.querySelectorAll("[data-live-mcp-link]").length,
        argsOmittedRows: rows.filter(row => phrases.some(phrase => (row.textContent || "").includes(phrase))).length,
        argsOmittedMentions: phrases.reduce((total, phrase) => total + text.split(phrase).length - 1, 0),
        collapsed: collapsed ? { count: Number(collapsed.getAttribute("data-live-turn-earlier")), text: (collapsed.textContent || "").trim() } : null,
        collapsedLines: overlay.querySelectorAll("[data-live-turn-earlier]").length,
        /* A live row that repeats a canonical row is the duplicate the
           operator reads as junk: both name the same call. */
        duplicates: rows.filter(row => canonical.has((row.textContent || "").trim())).length,
        ids,
      };
    };
    const out = {};
    for (const section of document.querySelectorAll("[data-live-rows-case]")) {
      out[section.getAttribute("data-live-rows-case")] = read(section);
    }
    return { cases: out, scrollWidth: document.documentElement.scrollWidth };
  })()`;

  browserTest("the overlay is a bounded tail, and nothing at all once the transcript carries the calls", async () => {
    /* Any phase name but "after" records without asserting, so the overlay as
       it was at an earlier commit can be measured in these same units: "before"
       is the unbounded wall this issue started from, "round1" the bounded
       overlay whose MCP row still squeezed its title and called an unknown
       outcome a success. */
    const phase = (process.env.LIVE_ROWS_CAPTURE_PHASE ?? "after").replace(/[^a-z0-9-]/gi, "") || "after";
    /* Which tree rendered these readings. An earlier phase is captured from an
       exported checkout of the revision being measured, which carries no git
       metadata of its own, so the runner names it — and a phase whose PNGs and
       JSON disagree about their source cannot go unnoticed again. */
    const source = process.env.LIVE_ROWS_SOURCE_REV
      ?? (() => {
        try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
        catch { return "unrecorded"; }
      })();
    const out = path.resolve(`.artifacts/live-turn-rows/${phase}`);
    const pngDir = process.env.LIVE_ROWS_PNG_DIR ?? "/var/tmp/llv-live-rows-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out, "src/components/conversation/liveTurnRowsEvidence.fixture.tsx");
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];
    const shots: string[] = [];
    try {
      for (const lang of ["en", "uk"] as const) {
        const { context, page, pageErrors } = await openFixture(browser, server.base, { width: 390, height: 1400 }, "dark", lang);
        try {
          await page.locator("[data-live-turn-evidence]").waitFor();
          await page.waitForTimeout(150);
          type McpReading = {
            tool: string; status: string; state: string; mark: string; chips: number;
            minChipWidth: number; minChipHeight: number; rowWidth: number; rowHeight: number;
            titleWidth: number; titleShare: number; titleFullWidth: number; titleText: string;
          };
          type CanonicalReading = {
            tool: string; rowWidth: number; titleWidth: number; titleShare: number;
            chips: number; minChipWidth: number; minChipHeight: number;
          };
          const reading = await page.evaluate(measureOverlay) as {
            cases: Record<string, { rows: number; argsOmittedRows: number; argsOmittedMentions: number; mcpRows: number; mcpChips: number; collapsed: { count: number; text: string } | null; collapsedLines: number; duplicates: number; mcp: McpReading[]; canonicalMcp: CanonicalReading[] }>;
            scrollWidth: number;
          };
          const label = `390-dark-${lang}`;
          frames[label] = reading;
          for (const section of ["stale", "current", "states"] as const) {
            /* The before phase is rendered by the overlay as it was, which
               has no section the fix added. */
            if (!reading.cases[section]) continue;
            const name = `${section}-${label}-${phase}.png`;
            await page.locator(`[data-live-rows-case=${section}]`).screenshot({ path: path.join(pngDir, name) });
            shots.push(name);
          }
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          if (phase !== "after") continue;
          const stale = reading.cases.stale!;
          const current = reading.cases.current!;
          /* The tail is bounded, and what it drops it counts — once. */
          if (stale.rows > 8) failures.push(`${label}: the overlay painted ${stale.rows} rows`);
          if (!stale.rows) failures.push(`${label}: the overlay painted no tail at all`);
          if (stale.collapsedLines !== 1) failures.push(`${label}: ${stale.collapsedLines} collapsed lines`);
          if (!stale.collapsed?.count) failures.push(`${label}: the collapsed line counts nothing`);
          /* No wall of "arguments omitted", in either language. */
          if (stale.argsOmittedRows || stale.argsOmittedMentions) {
            failures.push(`${label}: ${stale.argsOmittedRows} rows / ${stale.argsOmittedMentions} mentions of shed arguments`);
          }
          /* A Viewer MCP row reads like its canonical card, chips and all. */
          if (!stale.mcpRows) failures.push(`${label}: no MCP row survived into the tail`);
          if (!stale.mcpChips) failures.push(`${label}: the MCP rows carry no entity chips`);

          /* Round-2 P2, the readable title. The tail carries the two-chip
             call (`link_task_to_pipeline`), which is where the title used to
             lose its line entirely: 1.27 px of a 330 px row. A title has to
             hold a readable share of its row, and the chips beside it have to
             stay whole rather than shrink to fit. */
          const chipped = stale.mcp.filter((row) => row.chips >= 2);
          if (!chipped.length) failures.push(`${label}: the tail carries no MCP row with two entity chips`);
          for (const row of [...stale.mcp, ...reading.cases.states!.mcp]) {
            if (row.titleWidth < MIN_MCP_TITLE_PX) {
              failures.push(`${label}: ${row.tool} title is ${row.titleWidth}px of a ${row.rowWidth}px row`);
            }
            if (row.titleShare < MIN_MCP_TITLE_SHARE) {
              failures.push(`${label}: ${row.tool} title holds only ${row.titleShare}% of its row`);
            }
            if (row.chips && (row.minChipWidth < MIN_CHIP_PX || row.minChipHeight < MIN_CHIP_PX)) {
              failures.push(`${label}: ${row.tool} chips squeezed to ${row.minChipWidth}x${row.minChipHeight}px`);
            }
          }

          /* Round-3 P2, the other half of the handoff: the canonical card the
             live row becomes. A row that reads well only until the transcript
             claims it is not a handoff, and this card squeezed its own title
             to 1.27 px with two chips (#1955) — the same construction the live
             row was fixed for. Both are held to one bound now, in the same
             units, over the same calls. */
          const canonical = current.canonicalMcp;
          if (!canonical.length) failures.push(`${label}: the current transcript carries no canonical MCP card`);
          if (!canonical.some((card) => card.chips >= 2)) {
            failures.push(`${label}: no canonical MCP card carries two entity chips`);
          }
          for (const card of canonical) {
            if (card.titleWidth < MIN_MCP_TITLE_PX) {
              failures.push(`${label}: canonical "${card.tool}" title is ${card.titleWidth}px of a ${card.rowWidth}px row`);
            }
            if (card.titleShare < MIN_MCP_TITLE_SHARE) {
              failures.push(`${label}: canonical "${card.tool}" title holds only ${card.titleShare}% of its row`);
            }
            if (card.chips && (card.minChipWidth < MIN_CHIP_PX || card.minChipHeight < MIN_CHIP_PX)) {
              failures.push(`${label}: canonical "${card.tool}" chips squeezed to ${card.minChipWidth}x${card.minChipHeight}px`);
            }
          }

          /* Round-2 P1, the outcome vocabulary: a call whose result the
             journal dropped is never painted as a success. */
          const marks = Object.fromEntries(reading.cases.states!.mcp.map((row) => [row.status, row.mark]));
          for (const [status, expected] of [["run", "pending"], ["ok", "success"], ["err", "error"], ["unknown", "omitted"]] as const) {
            if (marks[status] !== expected) {
              failures.push(`${label}: an MCP call with status ${status} is marked "${marks[status] ?? "nothing"}", not "${expected}"`);
            }
          }
          /* And once the transcript carries the calls, the overlay is silent. */
          if (current.rows || current.collapsedLines) {
            failures.push(`${label}: the overlay painted ${current.rows} rows beside a current transcript`);
          }
          if (stale.duplicates || current.duplicates) {
            failures.push(`${label}: ${stale.duplicates + current.duplicates} live rows repeat a canonical row`);
          }
          if (reading.scrollWidth > 390) failures.push(`${label}: the document scrolls sideways (${reading.scrollWidth} > 390)`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/live-turn-rows", { recursive: true });
    fs.writeFileSync(`evidence/live-turn-rows/${phase}.json`, `${JSON.stringify({ phase, source, shots, frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 300_000);
});


describe("#1972 stopped launches in the production task reader", () => {
  browserTest("closed launch dismisses from the board while the parked launch stays retryable", async () => {
    const out = path.resolve(".artifacts/stopped-launches");
    fs.mkdirSync(out, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    try {
      const { page, context, pageErrors } = await openFixture(browser, `${server.base}?scenario=stopped-launches`, { width: 1280, height: 900 }, "light", "en");
      await page.waitForSelector(card("t-stopped"));
      await page.locator(card("t-stopped")).scrollIntoViewIfNeeded();

      await page.locator(`${card("t-stopped")} [data-pipeline="p-closed"] .pb-pill[data-stage="build"]`).click();
      const closed = page.locator('[data-reader-path="spawn:launch-closed"]');
      await closed.locator("[data-launch-dismiss]").waitFor({ state: "visible" });
      expect(await closed.locator("[data-launch-retry]").count()).toBe(0);
      expect(await closed.locator("textarea, [data-agent-control-strip]").count()).toBe(0);
      const bounds = await closed.locator("[data-launch-dismiss]").boundingBox();
      expect(bounds?.width).toBeGreaterThan(0);
      await page.screenshot({ path: path.join(out, "closed-launch.png") });
      await closed.locator("[data-launch-dismiss]").click();
      await closed.waitFor({ state: "detached" });
      await page.waitForFunction(() => (window as unknown as { evidence: { boardMutations: Array<{ kind: string; path?: string }> } }).evidence.boardMutations
        .some((mutation) => mutation.kind === "close" && mutation.path === "spawn:launch-closed"));
      expect(await page.locator(`${card("t-stopped")} .tile[data-member="spawn:launch-closed"]`).count()).toBe(0);
      await page.locator(`${card("t-stopped")} [data-pipeline="p-needs_decision"] .pb-pill[data-stage="build"]`).click();
      const parked = page.locator('[data-reader-path="spawn:launch-needs_decision"]');
      await parked.locator("[data-launch-retry]").waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(out, "parked-launch.png") });
      expect(pageErrors).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
      server.stop();
    }
  }, 60_000);
});

describe("columns balanced on large screens, stage pills and heads on one line", () => {
  /*
   * The board's four columns on a large screen, and the one-line rows inside
   * them, over `?scenario=balance`: every column holds a card whose pipelines
   * name their stages in 5, 20 and 40 characters, on a one-stage chain and on
   * Build → Review with a fail loop that fired; one task carries five
   * pipelines; Inbox holds a stack of long-titled cards.
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "columns balanced"
   *
   * What it gates, per viewport, in en and uk:
   *   - wide mode at 1920 and 2560: Assigned is 60–70 % of the width it had
   *     with shelves capped at 264 px (content − 3·264 − 3·16), the three
   *     shelves are equal and wider than 264 px;
   *   - every wide or narrow frame: Assigned ≥ 520 (wide) / 440 (narrow),
   *     shelves ≥ 232 (wide) / 220 (narrow), nothing overflows sideways;
   *   - a card fills its column;
   *   - a stage pill's ink stays inside the pill, its name is one line and
   *     ends in an ellipsis with the full name in the pill's title, and the
   *     dot, the engine mark, the model and the effort bars keep their size;
   *   - a column head is one line: its title, count and counters inside the
   *     head, the counters truncating before anything wraps.
   * BALANCE_CAPTURE_LABEL names the record, written to
   * src/components/kanban/evidence/column-balance/<label>.json. With `main` (the stylesheet and
   * components of the base, this fixture and driver on top) the same checks
   * are recorded and must fail: the negative control.
   */
  const label = process.env.BALANCE_CAPTURE_LABEL?.trim() || "branch";
  const EVIDENCE = path.resolve("src/components/kanban/evidence/column-balance");
  const measure = `(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const intersect = (a, b) => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const empty = r => r.right - r.left < 0.5 || r.bottom - r.top < 0.5;
    /* Ink, clipped: a Range's rects ignore overflow, so each text rect is cut
       by every clipping ancestor up to the measured element. */
    const clipOf = (node, top) => {
      let clip = null;
      for (let el = node.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = clip ? intersect(clip, box(el)) : box(el);
        if (el === top) break;
      }
      return clip;
    };
    const textRects = top => {
      const out = [];
      const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        /* A closed <details> paints only its summary, yet its rows still report rects. */
        const shut = node.parentElement.closest("details:not([open])");
        if (shut && !node.parentElement.closest("summary")) continue;
        const clip = clipOf(node, top);
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const raw of range.getClientRects()) {
          if (raw.width === 0 || raw.height === 0) continue;
          const rect = clip ? intersect(clip, raw) : { top: raw.top, left: raw.left, right: raw.right, bottom: raw.bottom };
          if (!empty(rect)) out.push({ text: node.nodeValue.trim().slice(0, 50), rect, parent: node.parentElement });
        }
      }
      return out;
    };
    const escapes = (el, slack) => {
      const r = box(el);
      return textRects(el).filter(({ rect }) => rect.top < r.top - slack || rect.bottom > r.bottom + slack || rect.left < r.left - slack || rect.right > r.right + slack).map(({ text }) => text);
    };
    /* The number of visual lines a text node spans. */
    const lines = el => {
      const tops = new Set();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const raw of range.getClientRects()) if (raw.width > 0) tops.add(Math.round(raw.top));
      }
      return tops.size;
    };
    const board = document.querySelector("[data-board]");
    const style = getComputedStyle(board);
    const content = board.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const columns = [...board.querySelectorAll(".column")].map(column => {
      const head = column.querySelector(".col-head");
      const body = column.querySelector(".col-body");
      const bodyStyle = getComputedStyle(body);
      const inner = body.clientWidth - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight);
      const cards = [...column.querySelectorAll(".card")].filter(card => card.getBoundingClientRect().width > 0);
      const counters = [...head.querySelectorAll(".live, .needs")].map(counter => ({
        text: counter.textContent, title: counter.getAttribute("title"), lines: lines(counter),
        /* What the counter shows: its text, or under 300 px its number alone. */
        shown: counter.querySelector(".ct") && getComputedStyle(counter.querySelector(".ct")).display === "none" ? getComputedStyle(counter, "::after").content.replace(/"/g, "") : counter.textContent,
        width: Math.round(counter.getBoundingClientRect().width),
        truncated: counter.querySelector(".ct") ? counter.querySelector(".ct").scrollWidth > counter.querySelector(".ct").clientWidth + 1 : false,
      }));
      return {
        status: column.dataset.status, width: Math.round(column.getBoundingClientRect().width * 10) / 10,
        head: { lines: [...head.children].filter(child => (child.textContent || "").trim()).map(child => lines(child)), escapes: escapes(head, 1), counters, height: Math.round(head.getBoundingClientRect().height) },
        narrowCards: cards.filter(card => card.getBoundingClientRect().width < inner - 1).map(card => ({ id: card.dataset.id, width: Math.round(card.getBoundingClientRect().width), inner: Math.round(inner) })),
      };
    });
    const pills = [...board.querySelectorAll('.card[data-id^="task:t-bal-"] .pb-pills .pb-pill')].filter(pill => pill.getBoundingClientRect().width > 0).map(pill => {
      const name = pill.querySelector(".pname");
      const model = pill.querySelector(".imodel");
      const parts = [pill.querySelector(".pdot"), pill.querySelector(".pident > span:first-child"), model, pill.querySelector(".reasoning-slot")].filter(Boolean);
      const r = box(pill);
      return {
        column: pill.closest(".column").dataset.status,
        stage: pill.dataset.stage,
        name: name ? name.textContent : null,
        nameLines: name ? lines(name) : 0,
        nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
        ellipsis: name ? getComputedStyle(name).textOverflow : null,
        titleHasName: (pill.getAttribute("title") || "").includes(name ? name.textContent : ""),
        escapes: escapes(pill, 0.5),
        partsInside: parts.every(part => { const p = box(part); return p.left >= r.left - 0.5 && p.right <= r.right + 0.5 && p.top >= r.top - 0.5 && p.bottom <= r.bottom + 0.5; }),
        partWidths: parts.map(part => Math.round(part.getBoundingClientRect().width * 10) / 10),
        model: model ? { text: model.textContent, clipped: model.scrollWidth > model.clientWidth + 1 } : null,
        height: Math.round(r.height),
      };
    });
    /* A lane titled like its task has no head row of its own: its chain is the
       head (#2148). The head rows left are the titled ones. */
    const heads = [...board.querySelectorAll('.card[data-id^="task:t-bal-"] .pblock .pb-head')].filter(row => row.getBoundingClientRect().width > 0 && row.querySelector(".pb-title")).map(row => {
      const title = row.querySelector(".pb-title");
      return { column: row.closest(".column").dataset.status, ellipsis: getComputedStyle(title).textOverflow, clipped: title.scrollWidth > title.clientWidth + 1, escapes: escapes(row.closest(".card"), 1) };
    });
    return {
      viewport: window.innerWidth, boardWidth: Math.round(board.getBoundingClientRect().width), content: Math.round(content * 10) / 10,
      mode: board.dataset.mode, overflow: Math.max(0, board.scrollWidth - board.clientWidth), pageOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      columns, pills, heads,
    };
  })()`;

  browserTest("Assigned gives a third of its width to the shelves; pills and heads hold one line", async () => {
    const out = path.resolve(".artifacts/kanban-column-balance", label);
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const width of [1440, 1500, 1648, 1680, 1920, 2560]) {
        for (const lang of ["en", "uk"] as const) {
          const tag = `${width}-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=balance`, { width, height: 1000 }, "light", lang);
          try {
            await page.waitForSelector(card("t-bal-done"));
            await page.waitForTimeout(600);
            const frame = await page.evaluate(measure) as {
              boardWidth: number; content: number; mode: string; overflow: number; pageOverflow: number;
              columns: Array<{ status: string; width: number; head: { lines: number[]; escapes: string[]; counters: Array<{ text: string; title: string | null; lines: number; truncated: boolean; shown: string; width: number }>; height: number }; narrowCards: unknown[] }>;
              pills: Array<{ column: string; stage: string; name: string | null; nameLines: number; nameClipped: boolean; ellipsis: string | null; titleHasName: boolean; escapes: string[]; partsInside: boolean; partWidths: number[]; model: { text: string; clipped: boolean } | null; height: number }>;
              heads: Array<{ column: string; ellipsis: string; clipped: boolean; escapes: string[] }>;
            };
            frames[tag] = frame;
            await page.screenshot({ path: path.join(out, `${tag}.png`) });
            const col = (status: string) => frame.columns.find((entry) => entry.status === status)!.width;
            const shelves = ["inbox", "blocked", "done"].map(col);
            if (frame.pageOverflow > 0) failures.push(`${tag}: the page scrolls sideways by ${frame.pageOverflow}px`);
            {
              if (frame.mode === "wide" || frame.mode === "narrow") {
                if (frame.overflow > 0) failures.push(`${tag}: the ${frame.mode} board overflows by ${frame.overflow}px`);
                const floor = frame.mode === "wide" ? { work: 520, shelf: 232 } : { work: 440, shelf: 220 };
                if (col("assigned") < floor.work - 0.5) failures.push(`${tag}: Assigned ${col("assigned")} under ${floor.work}`);
                if (shelves.some((w) => w < floor.shelf - 0.5)) failures.push(`${tag}: a shelf under ${floor.shelf}: ${shelves.join(", ")}`);
                if (Math.max(...shelves) - Math.min(...shelves) > 1) failures.push(`${tag}: shelves differ: ${shelves.join(", ")}`);
                if (frame.mode === "narrow" && shelves.some((w) => Math.abs(w - 220) > 1)) failures.push(`${tag}: narrow shelves ${shelves.join(", ")} != 220`);
              }
              if (width === 1920 || width === 2560) {
                if (frame.mode !== "wide") failures.push(`${tag}: mode ${frame.mode}, expected wide`);
                /* On main the shelves were capped at 264: Assigned held the content less three shelves and three gaps. */
                const before = frame.content - 3 * 264 - 3 * 16;
                const ratio = col("assigned") / before;
                if (ratio < 0.6 || ratio > 0.7) failures.push(`${tag}: Assigned ${col("assigned")} is ${(ratio * 100).toFixed(1)}% of main's ${before}`);
                if (shelves.some((w) => w <= 264.5)) failures.push(`${tag}: a shelf is not wider than 264: ${shelves.join(", ")}`);
              }
              for (const column of frame.columns) {
                if (column.width < 1) continue;
                if (column.head.lines.some((n) => n > 1)) failures.push(`${tag} ${column.status}: the head wraps (${column.head.lines.join(",")})`);
                if (column.head.escapes.length) failures.push(`${tag} ${column.status}: head text outside the head: ${column.head.escapes.join(" | ")}`);
                if (column.head.counters.some((counter) => counter.title !== counter.text)) failures.push(`${tag} ${column.status}: a counter without its full text as title`);
                /* A counter never loses its number, whatever it gives up. */
                if (column.head.counters.some((counter) => !/\d/.test(counter.shown) || counter.width < 8)) failures.push(`${tag} ${column.status}: a counter shows «${column.head.counters.map((counter) => counter.shown).join(" | ")}»`);
                if (column.narrowCards.length) failures.push(`${tag} ${column.status}: cards narrower than the column: ${JSON.stringify(column.narrowCards)}`);
              }
              for (const pill of frame.pills) {
                const where = `${tag} ${pill.column} ${pill.stage}`;
                if (pill.escapes.length) failures.push(`${where}: text outside the pill: ${pill.escapes.join(" | ")}`);
                if (pill.nameLines > 1) failures.push(`${where}: the name wraps onto ${pill.nameLines} lines`);
                if (pill.ellipsis !== "ellipsis") failures.push(`${where}: the name ends in ${pill.ellipsis}`);
                if (!pill.titleHasName) failures.push(`${where}: the title does not carry the name`);
                if (!pill.partsInside) failures.push(`${where}: the dot, mark, model or bars leave the pill`);
                if (pill.model?.clipped) failures.push(`${where}: the model «${pill.model.text}» is cut`);
              }
              /* The mark, the model and the bars keep one size in every column. */
              const sizes = new Set(frame.pills.map((pill) => pill.partWidths.join("/")));
              if (sizes.size > 2) failures.push(`${tag}: pill parts change size across columns: ${[...sizes].join(" ; ")}`);
              for (const head of frame.heads) {
                if (head.ellipsis !== "ellipsis") failures.push(`${tag} ${head.column}: a pipeline title ends in ${head.ellipsis}`);
                if (head.escapes.length) failures.push(`${tag} ${head.column}: text leaves a pipeline card: ${head.escapes.slice(0, 4).join(" | ")}`);
              }
            }
            if (pageErrors.length) failures.push(`${tag}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    const summary = Object.fromEntries(Object.entries(frames).map(([tag, frame]) => {
      const f = frame as { boardWidth: number; content: number; mode: string; columns: Array<{ status: string; width: number }> };
      return [tag, { boardWidth: f.boardWidth, content: f.content, mode: f.mode, columns: Object.fromEntries(f.columns.map((column) => [column.status, column.width])) }];
    }));
    fs.writeFileSync(path.join(EVIDENCE, `${label}.json`), JSON.stringify({ label, summary, frames, failures }, null, 2) + "\n");
    /* The base run is the negative control: it records what fails there and does not gate. */
    if (label !== "main") expect(failures).toEqual([]);
    else expect(failures.length).toBeGreaterThan(0);
  }, 240_000);
});

describe("the orchestrator seat's header keeps every element readable and clickable", () => {
  /*
   * The seat's header at its fullest (`?scenario=seat-head`): a mandate one
   * version behind the default, so the stale chip draws; a designated
   * incumbent with its effort, account and a context past the rotation line;
   * twenty previous seats; the tick chip, Rotate, Stop host, the placement
   * switch and Fold. The operator saw the context meter and the stale chip
   * drawn over Stop host and Rotate in a seat about 1080 px wide.
   *
   *   CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "orchestrator seat.s header"
   *
   * Every button, link and piece of text in the header is measured by its INK
   * — its box united with every visible text rect inside it, each rect first
   * cut by the ancestors that clip it — and no two may touch. On top of that:
   * nothing may be drawn outside the header, no button's label may be clipped,
   * no text may be crushed below what can be read, and a truncated label must
   * carry a title saying the rest. Below 640 px the phone shell replaces the
   * board, so there the seat's card and its sheet's identity are what is
   * measured. At the widest desktop the seat is also docked at the side.
   * Every frame draws the role frame the product ships by default (#2043),
   * and the 1080 px Ukrainian head is measured under each other variant too.
   * `SEAT_HEAD_PNG_DIR` collects frames (never committed); the readings go to
   * `evidence/seat-head/geometry.json`.
   */
  const OUT = path.resolve(".artifacts/seat-head");
  const EVIDENCE = path.resolve("evidence/seat-head");
  const WIDTHS = [390, 768, 1080, 1440] as const;
  /** Anything narrower cannot be read: a model name cut to «cla…». */
  const READABLE_PX = 40;

  const MEASURE = `(rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (!root) return null;
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    const intersect = (a, b) => ({
      top: Math.max(a.top, b.top), left: Math.max(a.left, b.left),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
    });
    const empty = r => r.right - r.left < 0.5 || r.bottom - r.top < 0.5;
    /* Rendered at all — display: none has no rects. A box crushed to zero
       width still has one, and is measured as crushed rather than skipped. */
    const rendered = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    /* The clip every ancestor up to the document imposes: the seat's panel
       clips with overflow hidden, so a control pushed past its edge is gone. */
    const clipOf = node => {
      let clip = null;
      for (let el = node.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = clip ? intersect(clip, box(el)) : box(el);
      }
      return clip;
    };
    const ownText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.nodeValue.trim());
    const interactive = el => el.matches("button, a[href]");
    const all = [...root.querySelectorAll("*")].filter(rendered);
    const atoms = all.filter(el =>
      interactive(el)
      || el.matches(".role-mark, .av")
      || (ownText(el) && !el.parentElement.closest("button, a[href]")));
    const runsOf = el => {
      const out = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue.trim() || !rendered(node.parentElement)) continue;
        const clip = clipOf(node);
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const raw of range.getClientRects()) {
          if (raw.height === 0) continue;
          const full = { top: raw.top, left: raw.left, right: raw.right, bottom: raw.bottom };
          const seen = clip ? intersect(clip, full) : full;
          out.push({ full, seen: empty(seen) ? null : seen });
        }
      }
      return out;
    };
    /* What a text node would take if nothing squeezed it. */
    const natural = el => {
      let width = 0;
      for (const node of el.childNodes) {
        if (node.nodeType !== 3 || !node.nodeValue.trim()) continue;
        const probe = document.createElement("span");
        probe.textContent = node.nodeValue;
        const style = getComputedStyle(el);
        /* Longhands: Chrome serializes the font shorthand as empty whenever
           a longhand it cannot express is set, tabular-nums among them. */
        probe.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;white-space:pre";
        for (const key of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariantNumeric", "fontFeatureSettings", "letterSpacing", "textTransform"]) probe.style[key] = style[key];
        document.body.appendChild(probe);
        width += probe.getBoundingClientRect().width;
        probe.remove();
      }
      return width;
    };
    const read = atoms.map(el => {
      const clip = clipOf(el);
      const own = box(el);
      const seenBox = clip ? intersect(clip, own) : own;
      const ink = empty(seenBox) ? null : { ...seenBox };
      let visibleText = 0;
      let clipped = false;
      for (const run of runsOf(el)) {
        if (!run.seen) { clipped = true; continue; }
        visibleText += run.seen.right - run.seen.left;
        if (run.seen.right - run.seen.left < run.full.right - run.full.left - 0.5) clipped = true;
        if (ink) {
          ink.top = Math.min(ink.top, run.seen.top); ink.left = Math.min(ink.left, run.seen.left);
          ink.right = Math.max(ink.right, run.seen.right); ink.bottom = Math.max(ink.bottom, run.seen.bottom);
        }
      }
      /* A truncated label draws the same text into less room than it needs. */
      const naturalText = interactive(el) ? visibleText : natural(el);
      const truncated = [el, ...el.querySelectorAll("*")].some(node => node.scrollWidth > node.clientWidth + 0.5 && getComputedStyle(node).textOverflow === "ellipsis")
        || (!interactive(el) && naturalText - (own.right - own.left) > 1);
      let titled = false;
      for (let node = el; node && node !== root.parentElement; node = node.parentElement) if (node.getAttribute("title") || node.getAttribute("aria-label")) { titled = true; break; }
      const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.className || el.tagName).toString().trim().slice(0, 40);
      return {
        name, button: interactive(el), el,
        box: own, ink, visibleText: Math.round(visibleText), naturalText: Math.round(naturalText),
        clipped, truncated, titled,
      };
    });
    const disjoint = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
    const overlaps = [];
    for (let i = 0; i < read.length; i++) for (let j = i + 1; j < read.length; j++) {
      if (read[i].el.contains(read[j].el) || read[j].el.contains(read[i].el)) continue;
      const a = read[i].ink, b = read[j].ink;
      if (!a || !b || disjoint(a, b)) continue;
      overlaps.push({ a: read[i].name, b: read[j].name, x: Math.round(Math.min(a.right, b.right) - Math.max(a.left, b.left)) });
    }
    const rootBox = box(root);
    const rootClip = clipOf(root);
    const bounds = rootClip ? intersect(rootClip, rootBox) : rootBox;
    const outside = read.filter(atom => {
      const b = atom.box;
      return b.left < bounds.left - 0.5 || b.right > bounds.right + 0.5 || b.top < bounds.top - 0.5 || b.bottom > bounds.bottom + 0.5;
    }).map(atom => ({ name: atom.name, left: Math.round(atom.box.left), right: Math.round(atom.box.right), bounds: [Math.round(bounds.left), Math.round(bounds.right)] }));
    return {
      root: { width: Math.round(rootBox.right - rootBox.left), height: Math.round(rootBox.bottom - rootBox.top) },
      atoms: read.map(({ el: _el, box: _box, ink: _ink, ...rest }) => rest),
      overlaps, outside,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  }`;

  type HeadAtom = { name: string; button: boolean; visibleText: number; naturalText: number; clipped: boolean; truncated: boolean; titled: boolean };
  type HeadReading = {
    root: { width: number; height: number };
    atoms: HeadAtom[];
    overlaps: Array<{ a: string; b: string; x: number }>;
    outside: Array<Record<string, unknown>>;
    pageOverflow: boolean;
  };

  const measure = (page: Page, root: string) => page.evaluate(`(${MEASURE})(${JSON.stringify(root)})`) as Promise<HeadReading | null>;

  /** What a reading owes the operator, as failure lines. */
  function verdicts(label: string, reading: HeadReading | null, mandate: boolean): string[] {
    if (!reading) return [`${label}: nothing was drawn to measure`];
    const out: string[] = [];
    if (mandate && !reading.atoms.some((atom) => /mandate v|мандат v/i.test(atom.name))) out.push(`${label}: the stale-mandate chip is not drawn — nothing was measured`);
    for (const overlap of reading.overlaps) out.push(`${label}: «${overlap.a}» and «${overlap.b}» overlap by ${overlap.x} px`);
    for (const escape of reading.outside) out.push(`${label}: ${JSON.stringify(escape)} is drawn outside its row`);
    for (const atom of reading.atoms) {
      if (atom.button && atom.clipped) out.push(`${label}: the button «${atom.name}» has its label clipped`);
      if (!atom.button && atom.naturalText > 0 && atom.visibleText < Math.min(atom.naturalText, READABLE_PX) - 0.5) out.push(`${label}: «${atom.name}» is crushed to ${atom.visibleText} of ${atom.naturalText} px`);
      if (!atom.button && (atom.truncated || atom.clipped) && !atom.titled) out.push(`${label}: «${atom.name}» is truncated with no title saying the rest`);
    }
    if (reading.pageOverflow) out.push(`${label}: the page scrolls sideways`);
    return out;
  }

  browserTest("at 390, 768, 1080 and 1440 px in en and uk, with a stale mandate and every control present", async () => {
    const pngDir = process.env.SEAT_HEAD_PNG_DIR ?? null;
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    if (pngDir) fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];
    /* The attention toast floats over the board's top-right corner, which is
       where the seat's controls are; it is not part of the header and would
       only hide it in the frames. */
    const hideToast = (page: Page) => page.addStyleTag({ content: "[data-attention-toast] { display: none !important; }" });
    /* The fixture has no document head, so the frame the layout's boot script
       would set is set here. */
    const setFrame = async (page: Page, frame: string) => {
      await page.evaluate((value) => document.documentElement.setAttribute("data-role-frame", value), frame);
      await page.waitForTimeout(150);
    };
    const shoot = async (page: Page, selector: string, name: string) => {
      if (pngDir) await page.locator(selector).first().screenshot({ path: path.join(pngDir, `${name}.png`) });
    };
    try {
      for (const width of WIDTHS) {
        for (const lang of ["en", "uk"] as const) {
          const phone = width < 640;
          const label = `${width}-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=seat-head`, phone ? { width, height: 844 } : { width, height: 900 }, "light", lang, "no-preference", phone);
          try {
            await setFrame(page, DEFAULT_ROLE_FRAME);
            if (phone) {
              /* The phone shell replaces the board: the seat is a card, and
                 its identity and controls are in the sheet the card opens. */
              await page.waitForSelector("[data-mobile2-seat-card]", { timeout: 20_000 });
              await page.waitForTimeout(600);
              frames[`${label}-card`] = await measure(page, "[data-mobile2-seat-card]");
              failures.push(...verdicts(`${label} seat card`, frames[`${label}-card`] as HeadReading | null, false));
              await shoot(page, "[data-mobile2-seat-card]", `seat-card-${label}`);
              await page.locator("[data-mobile2-open=seat]").first().click();
              await page.waitForSelector("[data-mobile2-sheet='seat'] [data-orchestrator-incumbent]", { timeout: 20_000 });
              await page.waitForTimeout(600);
              frames[`${label}-sheet`] = await measure(page, "[data-mobile2-sheet='seat'] [data-orchestrator-incumbent]");
              failures.push(...verdicts(`${label} seat sheet`, frames[`${label}-sheet`] as HeadReading | null, false));
              await shoot(page, "[data-mobile2-sheet='seat']", `seat-sheet-${label}`);
            } else {
              await page.waitForSelector("[data-kanban-seat] [data-orchestrator-mandate-version]", { timeout: 20_000 });
              await page.waitForSelector("[data-kanban-seat] [data-orchestrator-account]", { timeout: 20_000 });
              await hideToast(page);
              await page.waitForTimeout(600);
              const placements = width >= 1440 ? ["top", "side"] as const : ["top"] as const;
              for (const placement of placements) {
                if (placement === "side") {
                  await page.locator("[data-kanban-seat] [data-seat-placement]").click();
                  await page.waitForSelector("[data-kanban-seat].side [data-orchestrator-mandate-version]", { timeout: 20_000 });
                  await page.waitForTimeout(600);
                }
                const key = `${label}-${placement}`;
                frames[key] = await measure(page, "[data-kanban-seat] .seat-head");
                failures.push(...verdicts(key, frames[key] as HeadReading | null, true));
                await shoot(page, "[data-kanban-seat] .seat-head", `seat-head-${key}`);
                if (width !== 1080 || lang !== "uk" || placement !== "top") continue;
                for (const frame of ROLE_FRAME_VARIANTS.filter((variant) => variant !== DEFAULT_ROLE_FRAME)) {
                  await setFrame(page, frame);
                  frames[`${key}-${frame}`] = await measure(page, "[data-kanban-seat] .seat-head");
                  failures.push(...verdicts(`${key} ${frame}`, frames[`${key}-${frame}`] as HeadReading | null, true));
                  await shoot(page, "[data-kanban-seat] .seat-head", `seat-head-${key}-${frame}`);
                }
                await setFrame(page, DEFAULT_ROLE_FRAME);
              }
            }
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } catch (error) {
            failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify({ widths: WIDTHS, readablePx: READABLE_PX, frames, failures }, null, 2)}\n`);
    expect(failures).toEqual([]);
  }, 600_000);
});

/* PR and issue chips (#2059) over `issue1695Evidence.fixture.tsx?scenario=work-links`:
   the card whose five pipelines carry an open PR with two issues, a lane with
   no PR, a PR two lanes share, a closed attempt and a merged fix, and the
   longest Inbox title with an attached draft. At 768, 1080 and 1440 px the
   kanban cards are measured, at 390 px the phone's pipeline screen, in en
   and uk:

     CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
       bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "PR and issue chips"

   Measured as ink (see "codex tool rows on a phone"): no chip's box meets a
   visible text run outside its own row — the title above all — no chip is cut
   by an overflow ancestor, a title that has more to say keeps at least 10rem,
   and the page never scrolls sideways. PNGs go to WORK_LINKS_PNG_DIR (never
   committed), the readings to `evidence/work-links/geometry.json`. */
describe("PR and issue chips on pipelines and task cards", () => {
  const measureChips = `(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    const intersect = (a, b) => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = r => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const meets = (a, b) => area(intersect(a, b)) > 0.5;
    /* What survives every clipping box from el up: a text run is cut by
       its own line-clamped span too, a mark only by what holds it. */
    const clipFrom = el => {
      let clip = { top: -1e9, left: -1e9, right: 1e9, bottom: 1e9 };
      for (let up = el; up; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = intersect(clip, box(up));
      }
      return clip;
    };
    const ink = root => {
      const out = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const clip = clipFrom(node.parentElement);
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const raw of range.getClientRects()) {
          const rect = intersect(clip, { top: raw.top, left: raw.left, right: raw.right, bottom: raw.bottom });
          if (area(rect) > 0.5) out.push({ text: node.nodeValue.trim().slice(0, 40), el: node.parentElement, rect });
        }
      }
      return out;
    };
    const rows = [...document.querySelectorAll("[data-work-links]")].filter(row => row.getClientRects().length);
    const overlaps = [], clipped = [], squeezed = [];
    let chips = 0;
    for (const row of rows) {
      row.scrollIntoView({ block: "center" });
      const scope = row.closest(".pblock") || row.closest(".card") || row.closest("[data-mobile2-pipeline-body]")?.parentElement || document.body;
      const title = row.closest(".pblock")?.querySelector(".pb-title")
        || row.closest(".card")?.querySelector(".head .title")
        || document.querySelector("[data-mobile2-title-text]");
      const marks = [...row.querySelectorAll(".wl-chip, .wl-more, .wl-nopr")];
      chips += marks.length;
      const others = ink(scope).filter(entry => !row.contains(entry.el));
      for (const mark of marks) {
        const rect = box(mark);
        const shown = intersect(rect, clipFrom(mark.parentElement));
        if (area(shown) < area(rect) - 1) clipped.push({ row: row.dataset.workLinks, mark: mark.textContent, shown: Math.round(area(shown)), full: Math.round(area(rect)) });
        for (const entry of others) {
          if (meets(rect, entry.rect)) overlaps.push({ row: row.dataset.workLinks, mark: mark.textContent, text: entry.text });
        }
      }
      /* A title that shares a line with chips keeps 10rem, so the chips wrap
         rather than take its meaning; one on a line of its own is not theirs. */
      const band = title ? box(title) : null;
      if (band && marks.some(mark => { const r = box(mark); return r.bottom > band.top + 1 && r.top < band.bottom - 1; })) {
        const width = band.right - band.left;
        const needs = Math.min(title.scrollWidth, 160);
        if (width + 1 < needs) squeezed.push({ row: row.dataset.workLinks, title: (title.textContent || "").slice(0, 40), width: Math.round(width), needs });
      }
    }
    return { rows: rows.length, chips, overlaps, clipped, squeezed, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  })()`;

  browserTest("PR and issue chips never cover or clip a title, at 390, 768, 1080 and 1440 px, in en and uk", async () => {
    const out = path.resolve(".artifacts/work-links");
    const pngDir = process.env.WORK_LINKS_PNG_DIR ?? "/var/tmp/llv-work-links-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const base = `${server.base}?scenario=work-links`;
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, unknown> = {};
    const failures: string[] = [];
    type Reading = { rows: number; chips: number; overlaps: unknown[]; clipped: unknown[]; squeezed: unknown[]; scrollWidth: number; innerWidth: number };
    const gate = (label: string, reading: Reading, minRows: number) => {
      frames[label] = reading;
      if (reading.rows < minRows) failures.push(`${label}: ${reading.rows} chip rows drawn, expected at least ${minRows}`);
      if (reading.overlaps.length) failures.push(`${label}: ${reading.overlaps.length} chips meet other text — ${JSON.stringify(reading.overlaps[0])}`);
      if (reading.clipped.length) failures.push(`${label}: ${reading.clipped.length} chips are cut — ${JSON.stringify(reading.clipped[0])}`);
      if (reading.squeezed.length) failures.push(`${label}: ${reading.squeezed.length} titles squeezed under 10rem — ${JSON.stringify(reading.squeezed[0])}`);
      if (reading.scrollWidth > reading.innerWidth) failures.push(`${label}: the page scrolls sideways (${reading.scrollWidth} > ${reading.innerWidth})`);
    };
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const width of [768, 1080, 1440]) {
          const label = `${width}-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, base, { width, height: 900 }, "light", lang);
          try {
            await page.waitForSelector('[data-kanban-board] [data-work-links="t-many"]', { state: "attached", timeout: 20_000 });
            await page.waitForTimeout(400);
            /* The finished lanes fold behind their count; open them, so every
               lane's own row is measured. */
            const toggle = page.locator('.card[data-id="task:t-many"] [data-completed-toggle]');
            if (await toggle.count()) await toggle.evaluate((element) => (element as HTMLElement).click());
            await page.waitForTimeout(200);
            gate(label, await page.evaluate(measureChips) as Reading, 6);
            await page.locator('.card[data-id="task:t-many"]').screenshot({ path: path.join(pngDir, `card-${label}.png`) });
            const long = page.locator('.card[data-id="task:t-longtitle"]');
            if (await long.count() && await long.isVisible()) await long.screenshot({ path: path.join(pngDir, `longtitle-${label}.png`) });
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
        const label = `390-${lang}`;
        const { context, page, pageErrors } = await openFixture(browser, base, { width: 390, height: 844 }, "light", lang, "no-preference", true);
        try {
          await page.waitForSelector('[data-mobile2-go="pipeline"]', { state: "attached", timeout: 20_000 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(pngDir, `phone-board-${label}.png`) });
          /* The queue row is the pipeline card (#2072): its PR is passive text at the end of the chain line. */
          const clause = await page.locator('[data-mobile2-go="pipeline"] [data-work-links-text]').first().textContent();
          if (!/#2195/.test(clause ?? "")) failures.push(`${label}: the queue row does not name its PR: ${JSON.stringify(clause)}`);
          await page.locator('[data-mobile2-go="pipeline"]').first().evaluate((element) => (element as HTMLElement).click());
          await page.waitForSelector("[data-mobile2-links]", { state: "attached", timeout: 10_000 });
          await page.waitForTimeout(300);
          gate(label, await page.evaluate(measureChips) as Reading, 1);
          if ((frames[label] as Reading).chips < 3) failures.push(`${label}: the pipeline screen drew ${(frames[label] as Reading).chips} chips, expected the PR and its two issues`);
          await page.screenshot({ path: path.join(pngDir, `phone-${label}.png`) });
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/work-links", { recursive: true });
    fs.writeFileSync("evidence/work-links/geometry.json", `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});

/* #2072 slice 3: one pipeline block for the desktop card and the phone,
   variant B (docs/design/desktop-flat-cards.md §4, docs/design/phone-kanban.md
   §3.13). Over the variant renders' own cards (`?scenario=pipeline-block`):
   the lane rows on the desktop card at 1440 and 1080 px, and the pipeline
   cards on the phone's Needs you rows and pipelines list at 390 px, in en and
   uk. The gate is ink, not boxes (§5): the union of each text element's
   client rects, cut by every ancestor that clips it, meets no other text's ink
   and no control, no two controls meet, and no text of a block paints outside
   its card.

     CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
       bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "one pipeline block"

   PNGs go to the directory named by `PIPELINE_BLOCK_PNG_DIR` (never
   committed), with the variant renders' file names; the readings go to
   `evidence/pipeline-block/geometry.json`. */
describe("#2072 one pipeline block, desktop and phone", () => {
  /* Two lanes of the pipeline-block scenario stand on a long-named stage. The
     eight-stage one's 44 characters leave no room for "✓3" and "+4" beside it
     in a 390 px card, so the card settles on the stage alone; the two-stage
     one's 86 characters do not fit even alone, so the name wraps in its pill. */
  const LONG_STAGES = {
    "verify-backward-compatibility-and-migrations": { name: "Verify backward compatibility and migrations", wrap: false },
    "confirm-each-attachment-arrives-whole-on-the-phone-the-desktop-and-the-telegram-bridge": { name: "Confirm each attachment arrives whole on the phone the desktop and the telegram bridge", wrap: true },
  } as const;
  const measureBlocks = `(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    const intersect = (a, b) => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = r => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const meets = (a, b) => area(intersect(a, b)) > 0.5;
    const union = (a, b) => ({ top: Math.min(a.top, b.top), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    /* A clipped label is not an escape: a Range's rects ignore overflow, so
       each one is cut down by every ancestor that clips it first. */
    const clipFrom = el => {
      let clip = { top: -1e9, left: -1e9, right: 1e9, bottom: 1e9 };
      for (let up = el; up; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = intersect(clip, box(up));
      }
      return clip;
    };
    /* Each text element's ink: the union of its visible text rects. */
    const inkOf = scope => {
      const byElement = new Map();
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const el = node.parentElement;
        if (!el || getComputedStyle(el).visibility === "hidden") continue;
        const clip = clipFrom(el);
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const raw of range.getClientRects()) {
          const rect = intersect(clip, { top: raw.top, left: raw.left, right: raw.right, bottom: raw.bottom });
          if (area(rect) <= 0.5) continue;
          const entry = byElement.get(el);
          byElement.set(el, entry ? { ...entry, rect: union(entry.rect, rect) } : { el, rect, text: (el.textContent || "").trim().slice(0, 48) });
        }
      }
      return [...byElement.values()];
    };
    const controlsOf = scope => [...scope.querySelectorAll("button, a, [role=button]")]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .map(el => ({ el, rect: intersect(box(el), clipFrom(el.parentElement)), text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 48) }))
      .filter(entry => area(entry.rect) > 0.5);
    const nested = (a, b) => a.contains(b) || b.contains(a);
    /* The ink above is what paints, so it cannot see a text that does not
       paint at all. A card's chain (phone-kanban §3.13) cuts no name or count:
       each text in a card-density block is seen where it is laid out — its
       natural rects, clipped by nothing up to its card — and its own box does
       not hide a sideways overflow behind an ellipsis. */
    const clippedOf = (block, card) => {
      const out = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const el = node.parentElement;
        if (!el || getComputedStyle(el).visibility === "hidden") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter(r => r.width * r.height > 0.5).map(r => ({ top: r.top, left: r.left, right: r.right, bottom: r.bottom }));
        if (!rects.length) continue;
        const natural = rects.reduce(union);
        let clip = { top: -1e9, left: -1e9, right: 1e9, bottom: 1e9 };
        for (let up = el; up; up = up.parentElement) {
          const style = getComputedStyle(up);
          if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = intersect(clip, box(up));
          if (up === card) break;
        }
        const visible = intersect(natural, clip);
        const lost = Math.max(visible.left - natural.left, natural.right - visible.right, visible.top - natural.top, natural.bottom - visible.bottom);
        const own = getComputedStyle(el);
        const ellipsis = own.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1;
        if (lost > 1 || ellipsis) out.push({ text: node.nodeValue.trim().slice(0, 48), natural: Math.round(natural.right - natural.left), visible: Math.round(Math.max(0, visible.right - visible.left)), lost: Math.round(lost), ellipsis });
      }
      return out;
    };
    /* A desktop lane row is its own scope; a phone card is the scope of the
       block inside it, with its title and badge. */
    const scopes = [...new Set([...document.querySelectorAll("[data-kanban-board] .card [data-pipeline], [data-mobile2-pipeline-row]")]
      .filter(el => el.getClientRects().length)
      .map(el => el.closest("[data-mobile2-pipeline-row]") || el))];
    const overlaps = [], escapes = [], clipped = [], unsettled = [];
    let texts = 0, controls = 0;
    for (const scope of scopes) {
      scope.scrollIntoView({ block: "center" });
      const card = scope.closest(".card, [data-mobile2-pipeline-row]") || scope;
      const frame = box(card);
      const ink = inkOf(scope);
      const hits = controlsOf(scope);
      texts += ink.length; controls += hits.length;
      const where = scope.getAttribute("data-pipeline") || scope.getAttribute("data-mobile2-pipeline-row");
      for (const block of scope.querySelectorAll('.pblock[data-density="card"]')) {
        for (const entry of clippedOf(block, card)) clipped.push({ where, ...entry });
        /* Every fold the card settled on fits its box. */
        for (const fold of block.querySelectorAll(".pb-pills.fold")) {
          if (fold.scrollWidth > fold.clientWidth + 1) {
            const line = fold.closest(".pb-line");
            unsettled.push({ where, scrollWidth: fold.scrollWidth, clientWidth: fold.clientWidth, level: line?.getAttribute("data-fold-level"), alone: line?.getAttribute("data-alone"), wrap: line?.getAttribute("data-wrap") });
          }
        }
      }
      for (let i = 0; i < ink.length; i++) {
        const a = ink[i];
        if (a.rect.left < frame.left - 1 || a.rect.right > frame.right + 1 || a.rect.top < frame.top - 1 || a.rect.bottom > frame.bottom + 1) escapes.push({ where, text: a.text });
        for (let j = i + 1; j < ink.length; j++) {
          const b = ink[j];
          if (!nested(a.el, b.el) && meets(a.rect, b.rect)) overlaps.push({ where, kind: "text/text", a: a.text, b: b.text });
        }
        for (const control of hits) {
          if (!control.el.contains(a.el) && meets(a.rect, control.rect)) overlaps.push({ where, kind: "text/control", a: a.text, b: control.text });
        }
      }
      for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
        if (!nested(hits[i].el, hits[j].el) && meets(hits[i].rect, hits[j].rect)) overlaps.push({ where, kind: "control/control", a: hits[i].text, b: hits[j].text });
      }
    }
    const lanes = document.querySelectorAll('.pblock[data-density="task"]').length;
    const cards = document.querySelectorAll('[data-mobile2-pipeline-row] .pblock[data-density="card"]').length;
    /* Each long-named current stage, as its card drew it. */
    const longStages = {};
    for (const id of ${JSON.stringify(Object.keys(LONG_STAGES))}) {
      const pill = document.querySelector('[data-mobile2-pipeline-row] .pblock[data-density="card"] .pb-pill[data-stage="' + id + '"]');
      const line = pill && pill.closest(".pb-line");
      longStages[id] = pill && line ? {
        text: pill.querySelector(".pb-name")?.textContent ?? null,
        level: line.getAttribute("data-fold-level"),
        alone: line.getAttribute("data-alone") === "1",
        wrap: line.getAttribute("data-wrap") === "1",
        items: [...line.querySelectorAll(".pb-pills.fold .pb-pill")].map(item => item.textContent.trim()),
        height: Math.round(pill.getBoundingClientRect().height),
      } : null;
    }
    return { scopes: scopes.length, lanes, cards, texts, controls, overlaps, escapes, clipped, unsettled, longStages, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  })()`;
  type LongStage = { text: string | null; level: string | null; alone: boolean; wrap: boolean; items: string[]; height: number };
  type Reading = {
    scopes: number; lanes: number; cards: number; texts: number; controls: number; overlaps: unknown[]; escapes: unknown[];
    clipped: unknown[]; unsettled: unknown[]; longStages: Record<string, LongStage | null>;
    scrollWidth: number; innerWidth: number;
  };
  const CARDS = ["t-mobile", "t-review-spent", "t-many", "t-upload", "t-search", "t-export", "t-links", "t-limits", "t-attach"];

  browserTest("no text of a pipeline block meets another's ink or a control, and no card cuts a name or count, at 390, 1080 and 1440 px, in en and uk", async () => {
    const out = path.resolve(".artifacts/pipeline-block");
    const pngDir = process.env.PIPELINE_BLOCK_PNG_DIR ?? "/var/tmp/llv-pipeline-block-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const base = `${server.base}?scenario=pipeline-block`;
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, Reading> = {};
    const failures: string[] = [];
    const gate = (label: string, reading: Reading, need: { lanes?: number; cards?: number; longStages?: boolean }) => {
      frames[label] = reading;
      /* Nothing measured is no verdict: the block has to be on the page. */
      if (need.lanes !== undefined && reading.lanes < need.lanes) failures.push(`${label}: ${reading.lanes} lane rows drawn, expected at least ${need.lanes}`);
      if (need.cards !== undefined && reading.cards < need.cards) failures.push(`${label}: ${reading.cards} pipeline cards drawn, expected at least ${need.cards}`);
      if (reading.overlaps.length) failures.push(`${label}: ${reading.overlaps.length} overlaps — ${JSON.stringify(reading.overlaps.slice(0, 3))}`);
      if (reading.escapes.length) failures.push(`${label}: ${reading.escapes.length} texts paint outside their card — ${JSON.stringify(reading.escapes.slice(0, 3))}`);
      if (reading.clipped.length) failures.push(`${label}: ${reading.clipped.length} card texts are cut — ${JSON.stringify(reading.clipped.slice(0, 3))}`);
      if (reading.unsettled.length) failures.push(`${label}: ${reading.unsettled.length} card chains settled wider than their box — ${JSON.stringify(reading.unsettled.slice(0, 3))}`);
      /* Each long current stage is drawn whole, on the line of its own that
         the fold reached: alone for the one that fits, wrapped for the one
         that does not. */
      if (need.longStages) {
        for (const [id, want] of Object.entries(LONG_STAGES)) {
          const got = reading.longStages[id];
          if (got?.text !== want.name || !got.alone || got.wrap !== want.wrap || got.items.length !== 1) failures.push(`${label}: ${id} settled as ${JSON.stringify(got)}, expected its whole name alone on its line${want.wrap ? ", wrapped" : ""}`);
        }
      }
      if (reading.scrollWidth > reading.innerWidth) failures.push(`${label}: the page scrolls sideways (${reading.scrollWidth} > ${reading.innerWidth})`);
    };
    const seatFolded = `try { localStorage.setItem("llv:kanban-seat:v2", JSON.stringify({ height: null, collapsed: { atlas: true }, placement: "top", width: null })); } catch {}`;
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const [width, scheme] of [[1440, "light"], [1440, "dark"], [1080, "light"]] as const) {
          const label = `${width}-${lang}-${scheme}`;
          const { context, page, pageErrors } = await openFixture(browser, base, { width, height: 3400 }, scheme, lang);
          try {
            await context.addInitScript(seatFolded);
            await page.reload();
            /* Waits for the card, not the block, so a build without the block
               is measured too and its missing lane rows are the verdict. */
            await page.waitForSelector('[data-kanban-board] .card[data-id="task:t-many"] [data-pipeline]', { timeout: 30_000 });
            await page.waitForTimeout(800);
            if (scheme === "light") {
              gate(label, await page.evaluate(measureBlocks) as Reading, { lanes: 12 });
              /* One tone map (#2080): a spent review budget's state word takes
                 the same warning ink as a decision's. */
              const inks = await page.evaluate(() => ["needs_decision", "needs_review"].map((state) => {
                const word = document.querySelector(`.pblock .pstate-word[data-pstate="${state}"]`);
                return word ? getComputedStyle(word).color : null;
              }));
              if (!inks[0] || inks[0] !== inks[1]) failures.push(`${label}: needs review is drawn ${inks[1]}, needs a decision ${inks[0]}`);
            }
            for (const id of CARDS) {
              const element = page.locator(card(id));
              if (await element.count()) await element.screenshot({ path: path.join(pngDir, `card-${id}-${label}.png`) });
            }
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
        for (const scheme of ["dark", "light"] as const) {
          const label = `390-${lang}-${scheme}`;
          const { context, page, pageErrors } = await openFixture(browser, base, { width: 390, height: 844 }, scheme, lang, "no-preference", true);
          try {
            await page.waitForSelector("[data-mobile2-pipeline-row]", { timeout: 30_000 });
            await page.waitForTimeout(600);
            const suffix = scheme === "dark" ? lang : `light-${lang}`;
            await page.screenshot({ path: path.join(pngDir, `phone-board-390-${suffix}.png`) });
            gate(`${label}-board`, await page.evaluate(measureBlocks) as Reading, { cards: 3 });
            await page.locator('[data-mobile2-row="pipelines"]').first().evaluate((element) => (element as HTMLElement).click());
            await page.waitForSelector("[data-mobile2-pipelines] [data-mobile2-pipeline-row]", { timeout: 10_000 });
            await page.waitForTimeout(400);
            await page.evaluate(() => document.querySelector("[data-mobile2-pipelines]")?.scrollTo(0, 0));
            await page.screenshot({ path: path.join(pngDir, `phone-pipelines-390-${suffix}.png`) });
            gate(`${label}-pipelines`, await page.evaluate(measureBlocks) as Reading, { cards: 8, longStages: true });
            for (const id of Object.keys(LONG_STAGES)) {
              const row = page.locator(`[data-mobile2-pipelines] [data-mobile2-pipeline-row]:has(.pb-pill[data-stage="${id}"])`);
              if (await row.count()) await row.first().screenshot({ path: path.join(pngDir, `phone-card-390-${await row.first().getAttribute("data-mobile2-pipeline-row")}-${suffix}.png`) });
            }
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/pipeline-block", { recursive: true });
    fs.writeFileSync("evidence/pipeline-block/geometry.json", `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 900_000);

  /* The phone's pipeline screen, the Stages view (slice 6, §3.13), over the
     same scenario's lanes: the eight-stage one running its long-named fourth
     stage, a lane paused while a stage ran, the parked decision, the spent
     review budget and a completed lane.
     Each is opened from the phone's pipelines list the way the operator opens
     it, and the whole screen, bar and body, is measured as ink: no text meets
     another text or a control, no control meets another, every control is a
     44 px target, no stage name is cut, and nothing scrolls sideways. The body
     scrolls, so it is measured at its top and at its end, and the running lane
     once more with its passed stages unfolded. */
  const measureScreen = `(() => {
    const screen = document.querySelector('[data-mobile2-screen="pipeline"]');
    if (!screen) return null;
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    const intersect = (a, b) => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = r => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const meets = (a, b) => area(intersect(a, b)) > 0.5;
    const union = (a, b) => ({ top: Math.min(a.top, b.top), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    const clipFrom = el => {
      let clip = { top: -1e9, left: -1e9, right: 1e9, bottom: 1e9 };
      for (let up = el; up; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = intersect(clip, box(up));
      }
      return clip;
    };
    /* The banner slot is the shell's, on every screen, and gated with it. */
    const banner = el => Boolean(el.closest("[data-mobile2-banner]"));
    /* A chip's target is its box plus the reach its ::after gives it on a coarse pointer. */
    const reach = el => {
      const r = box(el);
      const after = getComputedStyle(el, "::after");
      if (after.content === "none" || after.position !== "absolute") return r;
      const px = v => parseFloat(v) || 0;
      return { top: r.top + px(after.top), left: r.left + px(after.left), right: r.right - px(after.right), bottom: r.bottom - px(after.bottom) };
    };
    const byElement = new Map();
    const walker = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const el = node.parentElement;
      if (!el || banner(el) || getComputedStyle(el).visibility === "hidden") continue;
      const clip = clipFrom(el);
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const raw of range.getClientRects()) {
        const rect = intersect(clip, { top: raw.top, left: raw.left, right: raw.right, bottom: raw.bottom });
        if (area(rect) <= 0.5) continue;
        const entry = byElement.get(el);
        byElement.set(el, entry ? { ...entry, rect: union(entry.rect, rect) } : { el, rect, text: (el.textContent || "").trim().slice(0, 48) });
      }
    }
    const ink = [...byElement.values()];
    const controls = [...screen.querySelectorAll("button, a, [role=button]")]
      .filter(el => !banner(el) && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .map(el => ({ el, full: reach(el), rect: intersect(reach(el), clipFrom(el.parentElement)), text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 48) }))
      .filter(entry => area(entry.rect) > 0.5);
    const nested = (a, b) => a.contains(b) || b.contains(a);
    const overlaps = [], escapes = [], small = [], cut = [];
    const frame = box(screen);
    for (let i = 0; i < ink.length; i++) {
      const a = ink[i];
      if (a.rect.left < frame.left - 1 || a.rect.right > frame.right + 1) escapes.push(a.text);
      for (let j = i + 1; j < ink.length; j++) {
        const b = ink[j];
        if (!nested(a.el, b.el) && meets(a.rect, b.rect)) overlaps.push({ kind: "text/text", a: a.text, b: b.text });
      }
      for (const control of controls) {
        if (!control.el.contains(a.el) && meets(a.rect, control.rect)) overlaps.push({ kind: "text/control", a: a.text, b: control.text });
      }
    }
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      if (!nested(controls[i].el, controls[j].el) && meets(controls[i].rect, controls[j].rect)) overlaps.push({ kind: "control/control", a: controls[i].text, b: controls[j].text });
    }
    /* A target is measured whole, before the scroller clips it. */
    for (const control of controls) {
      const height = control.full.bottom - control.full.top, width = control.full.right - control.full.left;
      if (height < 43.5 || width < 43.5) small.push({ text: control.text, width: Math.round(width), height: Math.round(height) });
    }
    for (const name of screen.querySelectorAll(".pb-stage .pb-name, .pb-heading")) {
      if (name.scrollWidth > name.clientWidth + 1) cut.push((name.textContent || "").slice(0, 48));
    }
    const stages = [...screen.querySelectorAll(".pb-stage[data-stage]")].map(el => el.getAttribute("data-stage"));
    /* How the current stage is drawn, read as computed colour and motion, and
       the tokens it is compared with, read the same way. */
    const probe = token => {
      const el = document.createElement("span");
      el.style.color = "var(" + token + ")";
      screen.appendChild(el);
      const color = getComputedStyle(el).color;
      el.remove();
      return color;
    };
    const cur = screen.querySelector(".pb-stage[data-stage-current]");
    const mark = cur && cur.querySelector(".pb-stage-title .pmark");
    const tone = cur && mark ? {
      held: cur.getAttribute("data-stage-held") === "1",
      mark: mark.getAttribute("data-mark"),
      live: mark.getAttribute("data-live") === "1",
      pulse: getComputedStyle(mark, "::before").animationName,
      markInk: getComputedStyle(mark).color,
      word: getComputedStyle(cur.querySelector(".pb-stage-state")).color,
      stripe: getComputedStyle(cur).boxShadow,
    } : null;
    const inks = { muted: probe("--color-muted"), success: probe("--color-success") };
    return {
      texts: ink.length, controls: controls.length, overlaps, escapes, small, cut, stages, tone, inks,
      current: screen.querySelector(".pb-stage[data-stage-current]")?.getAttribute("data-stage") ?? null,
      answers: [...screen.querySelectorAll("[data-answer-action]")].map(el => el.getAttribute("data-answer-action")),
      fold: screen.querySelector("[data-passed-fold]")?.getAttribute("data-passed-fold") ?? null,
      scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    };
  })()`;
  type ScreenTone = { held: boolean; mark: string | null; live: boolean; pulse: string; markInk: string; word: string; stripe: string };
  type ScreenReading = {
    texts: number; controls: number; overlaps: unknown[]; escapes: unknown[]; small: unknown[]; cut: unknown[];
    stages: string[]; current: string | null; answers: string[]; fold: string | null; scrollWidth: number; innerWidth: number;
    tone: ScreenTone | null; inks: { muted: string; success: string };
  } | null;
  /* `motion`: the running lane's current stage pulses in its live tone; the
     paused lane's held stage is hollow, still and muted (§3.13). */
  const SCREENS = [
    { id: "p-upload", name: "running", current: "verify-backward-compatibility-and-migrations", answers: [], fold: "3", completed: false, motion: "live" },
    { id: "p-md-accept", name: "paused", current: "accept", answers: [], fold: null, completed: false, motion: "held" },
    { id: "p-md-decision", name: "decision", current: "implement", answers: ["skip-stage", "retry-stage"], fold: null, completed: false, motion: null },
    { id: "p-review-spent", name: "review", current: "critique", answers: ["close", "continue-review"], fold: null, completed: false, motion: null },
    { id: "p-compact", name: "done", current: null, answers: [], fold: null, completed: true, motion: null },
  ] as const;

  browserTest("the phone's pipeline screen: no text meets another's ink or a control, every control is 44 px, no stage name is cut, and a paused lane's stage is still, at 390 and 430 px, in en and uk", async () => {
    const out = path.resolve(".artifacts/pipeline-screen");
    const pngDir = process.env.PIPELINE_SCREEN_PNG_DIR ?? "/var/tmp/llv-pipeline-screen-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const base = `${server.base}?scenario=pipeline-block`;
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, ScreenReading> = {};
    const failures: string[] = [];
    const gate = (label: string, reading: ScreenReading, want: (typeof SCREENS)[number]) => {
      frames[label] = reading;
      if (!reading) {
        failures.push(`${label}: no pipeline screen drawn`);
        return;
      }
      if (reading.current !== want.current) failures.push(`${label}: the current stage is ${reading.current}, expected ${want.current}`);
      if (JSON.stringify(reading.answers) !== JSON.stringify(want.answers)) failures.push(`${label}: answers ${JSON.stringify(reading.answers)}, expected ${JSON.stringify(want.answers)}`);
      if (reading.overlaps.length) failures.push(`${label}: ${reading.overlaps.length} overlaps — ${JSON.stringify(reading.overlaps.slice(0, 3))}`);
      if (reading.escapes.length) failures.push(`${label}: ${reading.escapes.length} texts paint outside the screen — ${JSON.stringify(reading.escapes.slice(0, 3))}`);
      if (reading.small.length) failures.push(`${label}: ${reading.small.length} controls under 44 px — ${JSON.stringify(reading.small.slice(0, 4))}`);
      if (reading.cut.length) failures.push(`${label}: ${reading.cut.length} names are cut — ${JSON.stringify(reading.cut.slice(0, 3))}`);
      if (reading.scrollWidth > reading.innerWidth) failures.push(`${label}: the page scrolls sideways (${reading.scrollWidth} > ${reading.innerWidth})`);
      const { tone, inks } = reading;
      if (want.motion === "held" && (!tone || !tone.held || tone.mark !== "ring" || tone.live || tone.pulse !== "none"
        || tone.markInk !== inks.muted || tone.word !== inks.muted || !tone.stripe.includes(inks.muted))) {
        failures.push(`${label}: the held stage is drawn ${JSON.stringify(tone)}, expected a still hollow ring with the mark, the word and the stripe in ${inks.muted}`);
      }
      if (want.motion === "live" && (!tone || tone.held || tone.mark !== "dot" || !tone.live || tone.pulse === "none"
        || tone.markInk !== inks.success || tone.word !== inks.success || !tone.stripe.includes(inks.success))) {
        failures.push(`${label}: the running stage is drawn ${JSON.stringify(tone)}, expected a pulsing dot with the mark, the word and the stripe in ${inks.success}`);
      }
    };
    const bodyTo = (page: Page, where: "top" | "end") => page.evaluate((to) => {
      const body = document.querySelector("[data-mobile2-pipeline-body]");
      if (body) body.scrollTop = to === "top" ? 0 : body.scrollHeight;
    }, where);
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const [width, height, scheme] of [[390, 844, "dark"], [390, 844, "light"], [430, 932, "dark"]] as const) {
          const { context, page, pageErrors } = await openFixture(browser, base, { width, height }, scheme, lang, "no-preference", true);
          try {
            await page.waitForSelector('[data-mobile2-row="pipelines"]', { timeout: 30_000 });
            await page.waitForTimeout(500);
            await page.locator('[data-mobile2-row="pipelines"]').first().evaluate((element) => (element as HTMLElement).click());
            await page.waitForSelector("[data-mobile2-pipelines] [data-mobile2-pipeline-row]", { timeout: 10_000 });
            for (const screen of SCREENS) {
              const label = `${screen.name}-${width}-${lang}-${scheme}`;
              if (screen.completed && !(await page.locator(`[data-mobile2-pipeline-row="${screen.id}"]`).count())) {
                await page.locator("[data-mobile2-completed-toggle]").evaluate((element) => (element as HTMLElement).click());
              }
              await page.locator(`[data-mobile2-pipeline-row="${screen.id}"]`).first().evaluate((element) => (element as HTMLElement).click());
              await page.waitForSelector(`[data-mobile2-screen="pipeline"][data-mobile2-pipeline="${screen.id}"] .pblock`, { timeout: 10_000 });
              await page.waitForTimeout(400);
              const name = `pipeline-${screen.name}-${width}-${lang}${scheme === "light" ? "-light" : ""}`;
              if (width === 390) await page.screenshot({ path: path.join(pngDir, `${name}.png`) });
              gate(`${label}-top`, await page.evaluate(measureScreen) as ScreenReading, screen);
              await bodyTo(page, "end");
              await page.waitForTimeout(150);
              gate(`${label}-end`, await page.evaluate(measureScreen) as ScreenReading, screen);
              const folded = frames[`${label}-top`]?.fold ?? null;
              if (folded !== screen.fold) failures.push(`${label}: the passed fold is ${folded}, expected ${screen.fold}`);
              /* The whole scroll at 390 px, folded, the way the round-2 "-full" frames draw it. */
              if (width === 390 && screen.name === "running") {
                const tall = await page.evaluate(() => {
                  const body = document.querySelector("[data-mobile2-pipeline-body]");
                  return body ? body.scrollHeight - body.clientHeight : 0;
                });
                await page.setViewportSize({ width, height: height + tall });
                await page.waitForTimeout(300);
                await page.screenshot({ path: path.join(pngDir, `${name.replace(`-${width}-`, `-${width}-full-`)}.png`) });
                await page.setViewportSize({ width, height });
              }
              if (screen.fold) {
                await bodyTo(page, "top");
                await page.locator("[data-passed-fold]").evaluate((element) => (element as HTMLElement).click());
                await page.waitForTimeout(200);
                const open = await page.evaluate(measureScreen) as ScreenReading;
                gate(`${label}-unfolded`, open, screen);
                if ((open?.stages.length ?? 0) !== 8) failures.push(`${label}: unfolded, ${open?.stages.length} stages are listed, expected 8`);
              }
              await page.locator("[data-mobile2-back]").first().evaluate((element) => (element as HTMLElement).click());
              await page.waitForSelector("[data-mobile2-pipelines]", { timeout: 10_000 });
              await page.waitForTimeout(250);
            }
            if (pageErrors.length) failures.push(`${width}-${lang}-${scheme}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/pipeline-block", { recursive: true });
    fs.writeFileSync("evidence/pipeline-block/pipeline-screen.json", `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 900_000);
});

describe("#2102 task icons on the desktop board and the Overview", () => {
  /* Every card of the pipeline-block scenario and of the Overview, with some
     tasks carrying a stored icon (`&icons=1`), at 1440 and 1080 px, in en and
     uk, light and dark. Each icon is lucide's own drawing, served the way the
     Viewer serves it. Gated per card: the icon is the head's first box and has
     loaded; its glyph keeps a gap from the title's ink; the title still runs
     from the icon to the tools (the flex-1 rule), so the icon takes no room
     from it; and the glyph sits level with the title's first line. The picker
     is opened from a card's icon, searched and used, and the write is read
     back from the fixture. Frames go to TASK_ICONS_PNG_DIR. A card is
     `content-visibility: auto`: off screen its SVG is not laid out at all, so
     each card is brought into view and given two frames before it is read. */
  const measureIcons = `(async () => {
    const out = { cards: 0, loaded: 0, sources: { stored: 0, suggested: 0, default: 0 }, problems: [], offsets: [] };
    for (const card of document.querySelectorAll("[data-kanban-board] .card")) {
      if (!card.getClientRects().length) continue;
      card.scrollIntoView({ block: "center" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const id = card.getAttribute("data-id");
      const head = card.querySelector(":scope > .head");
      const icon = head && head.firstElementChild && head.firstElementChild.classList.contains("task-icon") ? head.firstElementChild : null;
      if (!icon) { out.problems.push({ id, problem: "no icon before the title" }); continue; }
      out.cards += 1;
      const shown = icon.querySelector("[data-task-icon]");
      const svg = shown && shown.querySelector("svg");
      if (svg) out.loaded += 1;
      else { out.problems.push({ id, problem: "icon not drawn", icon: shown && shown.getAttribute("data-task-icon") }); continue; }
      out.sources[shown.getAttribute("data-icon-source")] += 1;
      const title = head.querySelector(":scope > .title");
      const text = title && title.querySelector(".clamp");
      if (!title || !text) { out.problems.push({ id, problem: "no title" }); continue; }
      const tools = head.querySelector(":scope > .tools");
      const glyph = svg.getBoundingClientRect(), box = title.getBoundingClientRect(), row = head.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = [...range.getClientRects()].filter((rect) => rect.width * rect.height > 0.5).sort((a, b) => a.top - b.top);
      if (!lines.length) { out.problems.push({ id, problem: "title paints nothing" }); continue; }
      const inkLeft = Math.min(...lines.map((rect) => rect.left));
      if (inkLeft - glyph.right < 4) out.problems.push({ id, problem: "icon meets the title", gap: Math.round(inkLeft - glyph.right) });
      const end = tools ? tools.getBoundingClientRect().left - (parseFloat(getComputedStyle(head).columnGap) || 0) : row.right;
      if (end - box.right > 2) out.problems.push({ id, problem: "the title stops short of the tools", short: Math.round(end - box.right) });
      if (box.left - glyph.right > 12) out.problems.push({ id, problem: "space between the icon and the title", gap: Math.round(box.left - glyph.right) });
      const offset = (glyph.top + glyph.bottom) / 2 - (lines[0].top + lines[0].bottom) / 2;
      out.offsets.push(Math.round(offset * 10) / 10);
      if (Math.abs(offset) > 1.5) out.problems.push({ id, problem: "icon is not level with the first line", offset: Math.round(offset * 10) / 10 });
    }
    return out;
  })()`;
  type IconReading = { cards: number; loaded: number; sources: Record<"stored" | "suggested" | "default", number>; problems: unknown[]; offsets: number[] };
  const iconsDrawn = () => [...document.querySelectorAll("[data-kanban-board] .card .task-icon [data-task-icon]")].every((element) => element.querySelector("svg"));

  browserTest("icons lead every card's title without taking its room, on the board and the Overview, at 1440 and 1080 px, en and uk, light and dark; the picker searches and writes", async () => {
    const out = path.resolve(".artifacts/task-icons");
    const pngDir = process.env.TASK_ICONS_PNG_DIR ?? "/var/tmp/llv-task-icons-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const frames: Record<string, IconReading> = {};
    const failures: string[] = [];
    const seatFolded = `try { localStorage.setItem("llv:kanban-seat:v2", JSON.stringify({ height: null, collapsed: { atlas: true }, placement: "top", width: null })); } catch {}`;
    const surfaces = [
      { name: "board", query: "?scenario=pipeline-block&icons=1", ready: '[data-kanban-board] .card[data-id="task:t-upload"]' },
      { name: "overview", query: "?scenario=issue1820&icons=1", ready: '[data-kanban-board] .card[data-id="task:t-ledger"]' },
    ] as const;
    try {
      for (const surface of surfaces) {
        for (const lang of ["en", "uk"] as const) {
          for (const width of [1440, 1080] as const) {
            for (const scheme of ["light", "dark"] as const) {
              const label = `${surface.name}-${width}-${lang}-${scheme}`;
              const { context, page, pageErrors } = await openFixture(browser, `${server.base}${surface.query}`, { width, height: 1000 }, scheme, lang);
              try {
                await context.addInitScript(seatFolded);
                await page.reload();
                await page.waitForSelector(surface.ready, { timeout: 30_000 });
                await page.waitForFunction(iconsDrawn, undefined, { timeout: 15_000 }).catch(() => {});
                /* A folded card is the board's other density: its head, icon included, is all it keeps. */
                if (surface.name === "board") await page.locator(`${card("t-disk")} .icon-btn.fold`).click();
                await page.waitForTimeout(300);
                const reading = await page.evaluate(measureIcons) as IconReading;
                if (surface.name === "board" && await page.locator(`${card("t-disk")}[data-collapsed="1"] .head > .task-icon [data-task-icon] svg`).count() !== 1) failures.push(`${label}: the folded card lost its icon`);
                /* Reading brought every card into view; the frame is taken from the top-left again. */
                await page.evaluate(() => {
                  for (const element of document.querySelectorAll<HTMLElement>("[data-kanban-board], [data-kanban-board] *")) {
                    if (element.scrollTop) element.scrollTop = 0;
                    if (element.scrollLeft) element.scrollLeft = 0;
                  }
                  window.scrollTo(0, 0);
                });
                await page.waitForTimeout(200);
                frames[label] = reading;
                if (reading.cards < 5) failures.push(`${label}: ${reading.cards} cards with an icon, expected at least 5`);
                if (!reading.sources.stored || !reading.sources.suggested || !reading.sources.default) failures.push(`${label}: stored, suggested and default icons should all show, got ${JSON.stringify(reading.sources)}`);
                if (reading.problems.length) failures.push(`${label}: ${reading.problems.length} problems — ${JSON.stringify(reading.problems.slice(0, 4))}`);
                await page.screenshot({ path: path.join(pngDir, `${label}.png`) });
                if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);

                /* The picker, from a card whose icon is only suggested. */
                if (surface.name === "board" && (width === 1440 || scheme === "light")) {
                  const target = page.locator(`${card("t-links")} [data-icon-menu]`);
                  await target.click();
                  await page.waitForSelector(".icon-popover [data-task-icon-picker] [data-icon-choice] svg", { timeout: 10_000 });
                  await page.waitForTimeout(200);
                  const frame = async (name: string) => {
                    const box = await page.locator(".icon-popover").boundingBox();
                    const anchor = await target.boundingBox();
                    if (!box || !anchor) { failures.push(`${label}: no picker to draw for ${name}`); return; }
                    if (box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > 1000) failures.push(`${label}: the picker leaves the window ${JSON.stringify(box)}`);
                    const left = Math.max(0, Math.min(box.x, anchor.x) - 24), top = Math.max(0, Math.min(box.y, anchor.y) - 24);
                    const right = Math.min(width, Math.max(box.x + box.width, anchor.x + anchor.width + 360) + 24), bottom = Math.min(1000, Math.max(box.y + box.height, anchor.y + anchor.height) + 24);
                    await page.screenshot({ path: path.join(pngDir, `${label}-picker-${name}.png`), clip: { x: left, y: top, width: right - left, height: bottom - top } });
                  };
                  await frame("common");
                  await page.locator(".icon-popover [data-task-icon-search]").fill("rock");
                  await page.waitForFunction(() => document.querySelector(".icon-popover [data-icon-choice]")?.getAttribute("data-icon-choice") === "rocket", undefined, { timeout: 10_000 }).catch(() => {});
                  await page.waitForTimeout(250);
                  const first = await page.locator(".icon-popover [data-icon-choice]").first().getAttribute("data-icon-choice");
                  if (first !== "rocket") failures.push(`${label}: "rock" finds ${first} first, expected rocket`);
                  await frame("search");
                  await page.locator('.icon-popover [data-icon-choice="rocket"]').click();
                  await page.waitForTimeout(400);
                  const after = await page.locator(`${card("t-links")} .task-icon [data-task-icon]`).evaluate((element) => [element.getAttribute("data-task-icon"), element.getAttribute("data-icon-source")]);
                  if (after[0] !== "rocket" || after[1] !== "stored") failures.push(`${label}: after picking, the card shows ${JSON.stringify(after)}`);
                  const written = await page.evaluate(() => (window as unknown as { evidence: { taskPatches: Array<{ id: string; body: Record<string, unknown> }> } }).evidence.taskPatches.filter((patch) => patch.id === "t-links").map((patch) => patch.body.icon));
                  if (written.at(-1) !== "rocket") failures.push(`${label}: the fixture received ${JSON.stringify(written)}, expected an icon write of rocket`);
                  await page.locator(card("t-links")).screenshot({ path: path.join(pngDir, `${label}-card-picked.png`) });
                }
              } finally {
                await context.close();
              }
            }
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/task-icons", { recursive: true });
    fs.writeFileSync("evidence/task-icons/geometry.json", `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 900_000);
});

describe("ghost cards: no «Untitled task» wall, and every counted conversation opens", () => {
  /* The `ghost-tasks` scenario: a conversation the backfill adopted after it
     ended, a launch that never produced a transcript, a young task whose
     agent is still working, and a named task whose conversation this board
     did not load. On the desktop at 1440 px and on the phone at 390 px, in en
     and uk: an ended placeholder shows its conversation's title, only the
     young one still says its name is coming, the launch that did not start
     is listed as such with a Dismiss and counts no conversation, and the
     conversation the board did not load opens from its own row. The dismiss
     is sent and the card leaves the column. A launch that failed two minutes
     ago is listed at once with its error, counts no conversation, and opens
     its launch view with Retry. Frames go to GHOST_TASKS_PNG_DIR;
     every frame is taken before any gate is read, so the same case renders
     the "before" frames on a tree without the change. */
  const GHOSTS = ["t-ghost-backfill", "t-ghost-fixture", "t-ghost-young", "t-ghost-elsewhere", "t-ghost-failed"] as const;
  const FAILED_ERROR = "account limit reached: the weekly window resets in 3 days";
  const read = `(() => {
    const out = {};
    for (const id of ${JSON.stringify(GHOSTS)}) {
      const card = document.querySelector('[data-kanban-board] .card[data-id="task:' + id + '"]');
      if (!card) { out[id] = null; continue; }
      const title = card.querySelector(".head .title");
      out[id] = {
        title: (title && title.textContent || "").trim(),
        pending: Boolean(card.querySelector(".head .title.pending")),
        conversations: card.querySelector("[data-foot-conversations]")?.getAttribute("data-foot-conversations") ?? null,
        notStarted: card.querySelectorAll("[data-launch-not-started]").length,
        notLoaded: card.querySelectorAll("[data-not-loaded]").length,
        failed: card.querySelectorAll("[data-launch-failed]").length,
        error: (card.querySelector("[data-launch-error]")?.textContent ?? "").trim() || null,
      };
    }
    return out;
  })()`;
  type Reading = Record<string, { title: string; pending: boolean; conversations: string | null; notStarted: number; notLoaded: number; failed: number; error: string | null } | null>;

  browserTest("ended placeholders borrow their conversation's title, a launch that never started is listed apart with a Dismiss, and a conversation off the board opens — desktop and phone, en and uk", async () => {
    const out = path.resolve(".artifacts/ghost-tasks");
    const pngDir = process.env.GHOST_TASKS_PNG_DIR ?? "/var/tmp/llv-ghost-tasks-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    const url = `${server.base}?scenario=ghost-tasks`;
    try {
      for (const lang of ["en", "uk"] as const) {
        const untitled = translate(lang, "kanban.untitled");
        /* Desktop. */
        {
          const label = `desktop-1440-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, { width: 1440, height: 1000 }, "light", lang);
          try {
            await page.waitForSelector(card("t-ghost-fixture"), { timeout: 30_000 });
            await page.waitForTimeout(600);
            for (const id of GHOSTS) {
              const element = page.locator(card(id));
              if (await element.count()) {
                await element.scrollIntoViewIfNeeded();
                await element.screenshot({ path: path.join(pngDir, `${label}-${id}.png`) });
              }
            }
            await page.locator(card("t-ghost-fixture")).scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(pngDir, `${label}-board.png`) });
            const reading = await page.evaluate(read) as Reading;
            readings[label] = reading;
            const at = (id: string) => reading[id];
            if (at("t-ghost-backfill")?.pending || at("t-ghost-backfill")?.title === untitled) failures.push(`${label}: the ended placeholder still reads «${untitled}»`);
            if (at("t-ghost-fixture")?.pending) failures.push(`${label}: the launch that never started still waits for a name`);
            if (at("t-ghost-fixture")?.conversations !== null) failures.push(`${label}: the launch that never started counts ${at("t-ghost-fixture")?.conversations} conversation(s)`);
            if (at("t-ghost-fixture")?.notStarted !== 1) failures.push(`${label}: no «launch did not start» row`);
            if (!at("t-ghost-young")?.pending) failures.push(`${label}: the young task no longer waits for its agent's name`);
            if (at("t-ghost-elsewhere")?.conversations !== "1" || at("t-ghost-elsewhere")?.notLoaded !== 1) failures.push(`${label}: the conversation off the board is not counted with its own open row ${JSON.stringify(at("t-ghost-elsewhere"))}`);
            if (at("t-ghost-failed")?.pending || at("t-ghost-failed")?.title === untitled) failures.push(`${label}: the failed launch still waits for a name`);
            if (at("t-ghost-failed")?.conversations !== null || at("t-ghost-failed")?.failed !== 1 || at("t-ghost-failed")?.error !== FAILED_ERROR) failures.push(`${label}: the launch that failed two minutes ago is not listed with its error ${JSON.stringify(at("t-ghost-failed"))}`);
            /* The failed launch opens its launch view: the error and Retry. */
            const openFailed = page.locator(`${card("t-ghost-failed")} [data-launch-open]`);
            if (await openFailed.count()) {
              await openFailed.click();
              await page.waitForTimeout(600);
              const view = page.locator('[data-launch-state="failed"]').first();
              if (await view.count()) {
                await view.scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(pngDir, `${label}-t-ghost-failed-opened.png`) });
              }
              const opened = await page.evaluate(() => ({
                text: document.querySelector('[data-launch-state="failed"]')?.textContent ?? null,
                retry: document.querySelectorAll('[data-launch-state="failed"] [data-launch-retry]').length,
              }));
              readings[`${label}-failed-opened`] = opened;
              if (!opened.text?.includes(FAILED_ERROR) || opened.retry !== 1) failures.push(`${label}: the failed launch's view ${JSON.stringify(opened)}`);
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(300);
            } else failures.push(`${label}: the failed launch offers no Open`);
            /* The conversation off the board opens by its own link. */
            const open = page.locator(`${card("t-ghost-elsewhere")} [data-not-loaded]`);
            if (await open.count()) {
              await open.click();
              await page.waitForTimeout(200);
              const hash = await page.evaluate(() => location.hash);
              if (!hash.includes("upload-retries")) failures.push(`${label}: opening the off-board conversation set ${JSON.stringify(hash)}`);
            }
            /* Dismiss: the row is sent and the ghost leaves the Assigned column. */
            const dismiss = page.locator(`${card("t-ghost-fixture")} [data-launch-dismiss]`);
            if (await dismiss.count()) {
              await dismiss.click();
              await page.waitForTimeout(800);
              const sent = await page.evaluate(() => (window as unknown as { evidence: { assignments: Array<{ method: string; id: string; body: Record<string, unknown> }> } }).evidence.assignments.filter((entry) => entry.method === "PATCH"));
              if (sent.length !== 1 || sent[0]!.id !== "t-ghost-fixture" || sent[0]!.body.dismiss !== "launch-did-not-start") failures.push(`${label}: the dismiss sent ${JSON.stringify(sent)}`);
              const column = await page.locator(card("t-ghost-fixture")).evaluate((element) => element.closest<HTMLElement>(".column")?.dataset.status ?? null).catch(() => null);
              if (column === "assigned") failures.push(`${label}: the dismissed ghost is still in Assigned`);
              await page.screenshot({ path: path.join(pngDir, `${label}-after-dismiss.png`) });
            }
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
        /* Phone. */
        {
          const label = `phone-390-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, { width: 390, height: 844 }, "light", lang, "no-preference", true);
          try {
            await page.waitForSelector("[data-phone-kanban]", { timeout: 30_000 });
            const tab = page.locator('[data-phone-kanban-tab="assigned"]');
            if (await tab.count()) await tab.first().click();
            await page.waitForTimeout(600);
            const titles: Record<string, string | null> = {};
            for (const id of GHOSTS) {
              const element = page.locator(`[data-phone-card="task:${id}"]`);
              if (!await element.count()) { titles[id] = null; continue; }
              await element.first().scrollIntoViewIfNeeded();
              await element.first().screenshot({ path: path.join(pngDir, `${label}-${id}.png`) });
              titles[id] = (await element.first().locator("[data-phone-card-title]").textContent())?.trim() ?? null;
            }
            await page.locator('[data-phone-card="task:t-ghost-fixture"]').first().scrollIntoViewIfNeeded().catch(() => {});
            await page.screenshot({ path: path.join(pngDir, `${label}-board.png`) });
            if (titles["t-ghost-backfill"] === untitled) failures.push(`${label}: the ended placeholder still reads «${untitled}»`);
            if (titles["t-ghost-young"] !== untitled) failures.push(`${label}: the young task no longer waits for its agent's name`);
            /* The ghost's own screen: no conversation to open, a launch that did not start with its Dismiss. */
            const ghost = page.locator('[data-phone-card="task:t-ghost-fixture"]');
            let screen: Record<string, number> | null = null;
            if (await ghost.count()) {
              await ghost.first().click();
              await page.waitForTimeout(800);
              await page.screenshot({ path: path.join(pngDir, `${label}-task-t-ghost-fixture.png`) });
              screen = await page.evaluate(() => ({
                unstarted: document.querySelectorAll("[data-phone-task-unstarted]").length,
                dismiss: document.querySelectorAll("[data-phone-launch-dismiss]").length,
                notLoaded: document.querySelectorAll("[data-phone-task-not-loaded]").length,
              }));
              if (screen.unstarted !== 1 || screen.dismiss !== 1) failures.push(`${label}: the ghost's screen ${JSON.stringify(screen)}`);
              await page.goBack().catch(() => {});
              await page.waitForTimeout(500);
            }
            /* The failed launch's screen: the error at once, and Open reaches its launch view with Retry. */
            const failedCard = page.locator('[data-phone-card="task:t-ghost-failed"]');
            let failedScreen: Record<string, unknown> | null = null;
            if (await failedCard.count()) {
              await failedCard.first().click();
              await page.waitForTimeout(800);
              await page.screenshot({ path: path.join(pngDir, `${label}-task-t-ghost-failed.png`) });
              failedScreen = await page.evaluate(() => ({
                failed: document.querySelectorAll("[data-phone-task-launch-failed]").length,
                error: document.querySelector("[data-phone-launch-error]")?.textContent ?? null,
                open: document.querySelectorAll("[data-phone-launch-open]").length,
              }));
              if (failedScreen.failed !== 1 || failedScreen.error !== FAILED_ERROR || failedScreen.open !== 1) failures.push(`${label}: the failed launch's task screen ${JSON.stringify(failedScreen)}`);
              const open = page.locator("[data-phone-launch-open]");
              if (await open.count()) {
                await open.first().click();
                await page.waitForTimeout(1000);
                await page.screenshot({ path: path.join(pngDir, `${label}-t-ghost-failed-opened.png`) });
                const opened = await page.evaluate(() => ({
                  text: document.querySelector('[data-launch-state="failed"]')?.textContent ?? null,
                  retry: document.querySelectorAll('[data-launch-state="failed"] [data-launch-retry]').length,
                }));
                failedScreen.opened = opened;
                if (!opened.text?.includes(FAILED_ERROR)) failures.push(`${label}: the failed launch's view ${JSON.stringify(opened)}`);
                await page.goBack().catch(() => {});
                await page.waitForTimeout(500);
              }
              await page.goBack().catch(() => {});
              await page.waitForTimeout(500);
            }
            const elsewhere = page.locator('[data-phone-card="task:t-ghost-elsewhere"]');
            let elsewhereScreen: Record<string, number> | null = null;
            if (await elsewhere.count()) {
              await elsewhere.first().click();
              await page.waitForTimeout(800);
              await page.screenshot({ path: path.join(pngDir, `${label}-task-t-ghost-elsewhere.png`) });
              elsewhereScreen = await page.evaluate(() => ({ notLoaded: document.querySelectorAll("[data-phone-task-not-loaded]").length }));
              if (elsewhereScreen.notLoaded !== 1) failures.push(`${label}: the off-board conversation has no row of its own on the task screen`);
            }
            readings[label] = { titles, ghostScreen: screen, elsewhereScreen, failedScreen };
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/ghost-tasks", { recursive: true });
    fs.writeFileSync("evidence/ghost-tasks/readings.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("old cards list only the launches that did not start, folded behind one row", () => {
  /* The `unstarted-regression` scenario: two Inbox cards whose lanes ran for
     days (43 and 27 assignments, one per stage attempt, review round and
     handshake retry, each with the conversation it minted and no path, none
     loaded on this board), and a card with four launches of its own that did
     not start: three rows that never minted a conversation and one whose
     receipt failed an hour ago. On the desktop at 1440 px and on the phone at
     390 px, in en and uk: the lane cards list no launch row and no row per
     conversation, and the mixed card shows one summary row that opens on
     click, with Dismiss all beside it. Frames go to
     UNSTARTED_REGRESSION_PNG_DIR; every frame is taken before any gate is
     read, so the same case renders the "before" frames on a tree without the
     change. */
  const CARDS = ["t-lanes-sqlite", "t-lanes-flows", "t-lanes-mixed"] as const;
  const FAILED_ERROR = "account limit reached: the weekly window resets in 3 days";
  const read = `(() => {
    const out = {};
    for (const id of ${JSON.stringify(CARDS)}) {
      const card = document.querySelector('[data-kanban-board] .card[data-id="task:' + id + '"]');
      if (!card) { out[id] = null; continue; }
      const rect = card.getBoundingClientRect();
      out[id] = {
        height: Math.round(rect.height),
        conversations: card.querySelector("[data-foot-conversations]")?.getAttribute("data-foot-conversations") ?? null,
        rows: card.querySelectorAll("[data-launch-not-started]").length,
        summary: card.querySelector("[data-launches-not-started]")?.getAttribute("data-launches-not-started") ?? null,
        summaryText: (card.querySelector("[data-launches-toggle]")?.textContent ?? "").trim() || null,
        dismissAll: (card.querySelector("[data-launches-dismiss-all]")?.textContent ?? "").trim() || null,
        notLoaded: card.querySelectorAll("[data-not-loaded]").length,
        error: (card.querySelector("[data-launch-error]")?.textContent ?? "").trim() || null,
      };
    }
    return out;
  })()`;
  type Reading = Record<string, { height: number; conversations: string | null; rows: number; summary: string | null; summaryText: string | null; dismissAll: string | null; notLoaded: number; error: string | null } | null>;

  browserTest("the lane cards list no launch, and the launches that did not start fold behind one row with Dismiss all — desktop and phone, en and uk", async () => {
    const out = path.resolve(".artifacts/unstarted-regression");
    const pngDir = process.env.UNSTARTED_REGRESSION_PNG_DIR ?? "/var/tmp/llv-unstarted-regression-evidence";
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    const url = `${server.base}?scenario=unstarted-regression`;
    try {
      for (const lang of ["en", "uk"] as const) {
        const summaryText = translate(lang, "kanban.launchesNotStarted", { count: 4 });
        /* Desktop. */
        {
          const label = `desktop-1440-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, { width: 1440, height: 1000 }, "light", lang);
          try {
            await page.waitForSelector(card("t-lanes-sqlite"), { timeout: 30_000 });
            await page.waitForTimeout(600);
            for (const id of CARDS) {
              const element = page.locator(card(id));
              if (await element.count()) {
                await element.scrollIntoViewIfNeeded();
                await element.screenshot({ path: path.join(pngDir, `${label}-${id}.png`) });
              }
            }
            await page.locator(card("t-lanes-sqlite")).scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(pngDir, `${label}-board.png`) });
            const reading = await page.evaluate(read) as Reading;
            readings[label] = reading;
            /* The fold opens on click and lists each launch. */
            const toggle = page.locator(`${card("t-lanes-mixed")} [data-launches-toggle]`);
            let opened: Record<string, unknown> | null = null;
            if (await toggle.count()) {
              await toggle.click();
              await page.waitForTimeout(300);
              await page.locator(card("t-lanes-mixed")).screenshot({ path: path.join(pngDir, `${label}-t-lanes-mixed-open.png`) });
              opened = await page.locator(card("t-lanes-mixed")).evaluate((element) => ({
                expanded: element.querySelector("[data-launches-toggle]")?.getAttribute("aria-expanded") ?? null,
                rows: [...element.querySelectorAll("[data-launch-not-started]")].map((row) => row.getAttribute("data-launch-not-started")),
                error: (element.querySelector("[data-launch-error]")?.textContent ?? "").trim() || null,
                open: element.querySelectorAll("[data-launch-open]").length,
              }));
              readings[`${label}-mixed-open`] = opened;
            }
            const at = (id: string) => reading[id];
            for (const [id, count] of [["t-lanes-sqlite", "43"], ["t-lanes-flows", "27"]] as const) {
              const found = at(id);
              if (!found) { failures.push(`${label}: no card ${id}`); continue; }
              if (found.rows !== 0 || found.summary !== null) failures.push(`${label}: ${id} lists launches that started ${JSON.stringify(found)}`);
              if (found.notLoaded !== 0) failures.push(`${label}: ${id} lists ${found.notLoaded} stage conversation(s) one row each`);
              if (found.conversations !== count) failures.push(`${label}: ${id} counts ${found.conversations} conversations, not ${count}`);
            }
            const mixed = at("t-lanes-mixed");
            if (mixed?.summary !== "4" || mixed.rows !== 0 || mixed.summaryText !== summaryText || mixed.dismissAll !== translate(lang, "kanban.dismissAllLaunches")) failures.push(`${label}: the mixed card's summary row ${JSON.stringify(mixed)}`);
            if (opened?.expanded !== "true" || (opened.rows as string[]).length !== 4 || opened.error !== FAILED_ERROR || opened.open !== 1) failures.push(`${label}: the opened fold ${JSON.stringify(opened)}`);
            /* Dismiss all sends one dismissal per launch. */
            const all = page.locator(`${card("t-lanes-mixed")} [data-launches-dismiss-all]`);
            if (await all.count()) {
              await all.click();
              await page.waitForTimeout(1200);
              const sent = await page.evaluate(() => (window as unknown as { evidence: { assignments: Array<{ method: string; id: string; body: Record<string, unknown> }> } }).evidence.assignments.filter((entry) => entry.method === "PATCH"));
              readings[`${label}-dismiss-all`] = sent.map((entry) => ({ id: entry.id, launchId: entry.body.launchId ?? null, dismiss: entry.body.dismiss ?? null }));
              if (sent.length !== 4 || sent.some((entry) => entry.id !== "t-lanes-mixed" || entry.body.dismiss !== "launch-did-not-start")) failures.push(`${label}: Dismiss all sent ${JSON.stringify(sent)}`);
            } else failures.push(`${label}: the mixed card offers no Dismiss all`);
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
        /* Phone. */
        {
          const label = `phone-390-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, { width: 390, height: 844 }, "light", lang, "no-preference", true);
          try {
            await page.waitForSelector("[data-phone-kanban]", { timeout: 30_000 });
            const tab = page.locator('[data-phone-kanban-tab="inbox"]');
            if (await tab.count()) await tab.first().click();
            await page.waitForTimeout(600);
            const screens: Record<string, unknown> = {};
            for (const id of CARDS) {
              const element = page.locator(`[data-phone-card="task:${id}"]`);
              if (!await element.count()) { screens[id] = null; failures.push(`${label}: no phone card ${id}`); continue; }
              await element.first().scrollIntoViewIfNeeded();
              await element.first().click();
              await page.waitForTimeout(800);
              /* The agents section, where launches are listed. */
              await page.locator("[data-phone-task-agents]").first().scrollIntoViewIfNeeded().catch(() => {});
              await page.screenshot({ path: path.join(pngDir, `${label}-task-${id}.png`) });
              const screen: Record<string, unknown> = await page.evaluate(() => ({
                rows: document.querySelectorAll("[data-phone-task-unstarted]").length,
                summary: document.querySelector("[data-phone-task-unstarted-summary]")?.getAttribute("data-phone-task-unstarted-summary") ?? null,
                summaryText: (document.querySelector("[data-phone-launches-toggle]")?.textContent ?? "").trim() || null,
                dismissAll: (document.querySelector("[data-phone-launches-dismiss-all]")?.textContent ?? "").trim() || null,
                notLoaded: document.querySelectorAll("[data-phone-task-not-loaded]").length,
                agentsHeight: Math.round(document.querySelector("[data-phone-task-agents]")?.getBoundingClientRect().height ?? 0),
              }));
              if (id === "t-lanes-mixed") {
                const toggle = page.locator("[data-phone-launches-toggle]");
                if (await toggle.count()) {
                  await toggle.first().click();
                  await page.waitForTimeout(300);
                  await page.locator("[data-phone-task-agents]").first().scrollIntoViewIfNeeded().catch(() => {});
                  await page.screenshot({ path: path.join(pngDir, `${label}-task-${id}-open.png`) });
                  screen.opened = await page.evaluate(() => ({
                    expanded: document.querySelector("[data-phone-launches-toggle]")?.getAttribute("aria-expanded") ?? null,
                    rows: document.querySelectorAll("[data-phone-task-unstarted]").length,
                    error: (document.querySelector("[data-phone-launch-error]")?.textContent ?? "").trim() || null,
                  }));
                }
              }
              screens[id] = screen;
              await page.goBack().catch(() => {});
              await page.waitForTimeout(500);
            }
            readings[label] = screens;
            for (const id of ["t-lanes-sqlite", "t-lanes-flows"]) {
              const screen = screens[id] as Record<string, unknown> | null;
              if (screen && (screen.rows !== 0 || screen.summary !== null || screen.notLoaded !== 0)) failures.push(`${label}: ${id}'s task screen ${JSON.stringify(screen)}`);
            }
            const mixed = screens["t-lanes-mixed"] as Record<string, unknown> | null;
            const opened = mixed?.opened as Record<string, unknown> | undefined;
            if (mixed && (mixed.summary !== "4" || mixed.rows !== 0 || mixed.summaryText !== summaryText || mixed.dismissAll !== translate(lang, "kanban.dismissAllLaunches"))) failures.push(`${label}: the mixed task screen ${JSON.stringify(mixed)}`);
            if (opened?.expanded !== "true" || opened.rows !== 4 || opened.error !== FAILED_ERROR) failures.push(`${label}: the opened fold ${JSON.stringify(opened ?? null)}`);
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/unstarted-regression", { recursive: true });
    fs.writeFileSync("evidence/unstarted-regression/readings.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("board order: working cards first, then recently worked, then idle", () => {
  /* The `board-order` scenario: the Assigned column the operator reported on
     2026-09-24, where the card whose build stage was running sat at the very
     bottom. Its stage conversation is live and its row carries no agent-work
     stamp yet; beside it, a direct worker and a research lane at work, a card
     whose agent finished seven minutes ago, one that finished yesterday, and
     a task nobody worked on that was edited a minute ago. On the desktop at
     1440×900 and on the phone at 390×844, the column reads working cards
     first, then the recent ones, then the idle one. Frames go to
     BOARD_ORDER_PNG_DIR, each taken before any gate is read, so the same case
     renders the "before" frames on a tree without the change. */
  const EXPECTED = ["t-order-tint", "t-order-maint", "t-order-research", "t-order-review", "t-order-yesterday", "t-order-notes"];

  browserTest("the Assigned column puts working cards on top on the desktop and the phone", async () => {
    const pngDir = process.env.BOARD_ORDER_PNG_DIR ?? "/var/tmp/llv-board-order-evidence";
    const out = path.resolve(".artifacts/board-order");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    const url = `${server.base}?scenario=board-order`;
    try {
      for (const lang of ["en", "uk"] as const) {
        {
          const label = `desktop-1440-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, VIEWPORT, "light", lang);
          try {
            await page.waitForSelector(card("t-order-tint"), { timeout: 30_000 });
            /* The seat folded, so the columns have the window's height. */
            const fold = page.locator("[data-seat-collapse]");
            if (await fold.count()) await fold.first().click();
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(pngDir, `${label}-board.png`) });
            const column = page.locator('[data-kanban-board] .column[data-status="assigned"]');
            await column.screenshot({ path: path.join(pngDir, `${label}-assigned.png`) });
            /* The column's end, where the working card sat. */
            await page.locator('[data-kanban-board] .col-body[data-status="assigned"]').evaluate((body) => { body.scrollTop = body.scrollHeight; });
            await page.waitForTimeout(300);
            await column.screenshot({ path: path.join(pngDir, `${label}-assigned-end.png`) });
            const order = await page.evaluate(() => [...document.querySelectorAll('[data-kanban-board] .column[data-status="assigned"] .card')]
              .map((element) => (element.getAttribute("data-id") ?? "").replace(/^task:/, "")));
            readings[label] = order;
            if (JSON.stringify(order) !== JSON.stringify(EXPECTED)) failures.push(`${label}: Assigned reads ${JSON.stringify(order)}`);
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
        {
          const label = `phone-390-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, { width: 390, height: 844 }, "light", lang, "no-preference", true);
          try {
            await page.waitForSelector("[data-phone-kanban]", { timeout: 30_000 });
            const tab = page.locator('[data-phone-kanban-tab="assigned"]');
            if (await tab.count()) await tab.first().click();
            await page.waitForSelector('[data-phone-kanban-column="assigned"] [data-phone-card="task:t-order-tint"]', { timeout: 30_000 });
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(pngDir, `${label}-assigned.png`) });
            await page.locator('[data-phone-kanban-column="assigned"]').evaluate((body) => { body.scrollTop = body.scrollHeight; });
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(pngDir, `${label}-assigned-end.png`) });
            const order = await page.evaluate(() => [...document.querySelectorAll('[data-phone-kanban-column="assigned"] [data-phone-card]')]
              .map((element) => (element.getAttribute("data-phone-card") ?? "").replace(/^task:/, "")));
            readings[label] = order;
            if (JSON.stringify(order) !== JSON.stringify(EXPECTED)) failures.push(`${label}: Assigned reads ${JSON.stringify(order)}`);
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/board-order", { recursive: true });
    fs.writeFileSync("evidence/board-order/readings.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("task priority: the Inbox takes high first and low last, the other columns keep their order", () => {
  /* The `task-priority` scenario: an Inbox of two high, two normal and two
     low tasks (one low task with a working agent, which still sits under
     every normal one), and an Assigned column whose high and low tasks keep
     the most recent agent work on top. On the desktop at 1440×900 the board,
     the Inbox and the card's ⋯ with its Priority group; on the phone at
     390×844 the Inbox tab and the task sheet's Priority face; en and uk.
     Frames go to PRIORITY_PNG_DIR, or `.artifacts/task-priority/`, never
     committed; the readings go to `evidence/task-priority/readings.json`.

       CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 PRIORITY_PNG_DIR=… \
         bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "task priority" */
  const INBOX = ["t-prio-deploy", "t-prio-limits", "t-prio-notes", "t-prio-export", "t-prio-cleanup", "t-prio-idea"];
  const ASSIGNED = ["t-prio-banner", "t-prio-search", "t-prio-docs"];
  const MARKS: Record<string, string> = { "t-prio-deploy": "high", "t-prio-limits": "high", "t-prio-cleanup": "low", "t-prio-idea": "low", "t-prio-banner": "low", "t-prio-search": "high" };

  browserTest("the Inbox sorts by priority with a quiet mark on high and low, on the desktop and the phone, en and uk", async () => {
    const pngDir = path.resolve(process.env.PRIORITY_PNG_DIR ?? ".artifacts/task-priority");
    const out = path.resolve(".artifacts/task-priority-bundle");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    const url = `${server.base}?scenario=task-priority`;
    try {
      for (const lang of ["en", "uk"] as const) {
        const t = (key: string) => translate(lang, key as never);
        {
          const label = `desktop-1440-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, VIEWPORT, "light", lang);
          try {
            await page.waitForSelector(card("t-prio-deploy"), { timeout: 30_000 });
            const fold = page.locator("[data-seat-collapse]");
            if (await fold.count()) await fold.first().click();
            await page.mouse.move(0, 0);
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(pngDir, `${label}-board.png`) });
            await page.locator('[data-kanban-board] .column[data-status="inbox"]').screenshot({ path: path.join(pngDir, `${label}-inbox.png`) });
            const read = await page.evaluate(() => {
              const column = (status: string) => [...document.querySelectorAll(`[data-kanban-board] .column[data-status="${status}"] .card`)]
                .map((element) => (element.getAttribute("data-id") ?? "").replace(/^task:/, ""));
              const marks = Object.fromEntries([...document.querySelectorAll("[data-kanban-board] .card")].flatMap((element) => {
                const mark = element.querySelector(".prio-mark");
                return mark ? [[(element.getAttribute("data-id") ?? "").replace(/^task:/, ""), [mark.getAttribute("data-priority"), mark.getAttribute("aria-label")]]] : [];
              }));
              /* The mark takes no room from the title: in one column a marked
                 card's title is as wide as an unmarked card's. */
              const squeezed = ["inbox", "assigned"].flatMap((status) => {
                const widths = [...document.querySelectorAll(`[data-kanban-board] .column[data-status="${status}"] .card`)]
                  .map((element) => Math.round(element.querySelector(".head > .title")?.getBoundingClientRect().width ?? 0));
                return Math.max(...widths) - Math.min(...widths) > 1 ? [`${status} ${JSON.stringify(widths)}`] : [];
              });
              /* And it leads the foot line, in the foot's own row. */
              const misplaced = [...document.querySelectorAll("[data-kanban-board] .card .prio-mark")].flatMap((mark) =>
                mark.parentElement?.classList.contains("foot") && mark.parentElement.firstElementChild === mark ? [] : [(mark.closest(".card")?.getAttribute("data-id") ?? "")]);
              return { inbox: column("inbox"), assigned: column("assigned"), marks, squeezed, misplaced };
            });
            readings[label] = read;
            if (JSON.stringify(read.inbox) !== JSON.stringify(INBOX)) failures.push(`${label}: Inbox reads ${JSON.stringify(read.inbox)}`);
            if (JSON.stringify(read.assigned) !== JSON.stringify(ASSIGNED)) failures.push(`${label}: Assigned reads ${JSON.stringify(read.assigned)}`);
            for (const [id, level] of Object.entries(MARKS)) {
              const got = (read.marks as Record<string, [string, string]>)[id];
              if (!got || got[0] !== level || got[1] !== t(`kanban.priorityMark.${level}`)) failures.push(`${label}: ${id} mark ${JSON.stringify(got)}`);
            }
            const extra = Object.keys(read.marks).filter((id) => !(id in MARKS));
            if (extra.length) failures.push(`${label}: normal tasks carry a mark: ${extra.join(", ")}`);
            if (read.squeezed.length) failures.push(`${label}: title widths differ: ${read.squeezed.join(", ")}`);
            if (read.misplaced.length) failures.push(`${label}: mark not leading the foot: ${read.misplaced.join(", ")}`);
            /* The card's ⋯: the Priority group under Move to, the current level checked. */
            await page.locator(`${card("t-prio-notes")} [data-menu]`).click();
            await page.waitForSelector(".menu", { timeout: 10_000 });
            await page.waitForTimeout(300);
            await page.locator(".menu").screenshot({ path: path.join(pngDir, `${label}-menu.png`) });
            const menu = await page.evaluate(() => ({
              heads: [...document.querySelectorAll(".menu .head")].map((head) => head.textContent?.trim()),
              checked: [...document.querySelectorAll('.menu [role="menuitemradio"][aria-checked="true"]')].map((item) => item.querySelector(".lbl")?.firstChild?.textContent?.trim() ?? item.textContent?.trim()),
            }));
            readings[`${label}-menu`] = menu;
            if (menu.heads[1] !== t("kanban.priority")) failures.push(`${label}: menu heads ${JSON.stringify(menu.heads)}`);
            if (!menu.checked.includes(t("kanban.priority.normal"))) failures.push(`${label}: checked ${JSON.stringify(menu.checked)}`);
            /* Raise it to high: it moves above the normal tasks at once. */
            await page.locator('.menu [role="menuitemradio"]').filter({ hasText: t("kanban.priority.high") }).first().click();
            await page.waitForTimeout(1500);
            const raised = await page.evaluate(() => [...document.querySelectorAll('[data-kanban-board] .column[data-status="inbox"] .card')]
              .map((element) => (element.getAttribute("data-id") ?? "").replace(/^task:/, "")));
            readings[`${label}-raised`] = raised;
            /* The newest edit leads its level, as it did among the normal ones. */
            const RAISED = ["t-prio-notes", "t-prio-deploy", "t-prio-limits", "t-prio-export", "t-prio-cleanup", "t-prio-idea"];
            if (JSON.stringify(raised) !== JSON.stringify(RAISED)) failures.push(`${label}: after High the Inbox reads ${JSON.stringify(raised)}`);
            await page.mouse.move(0, 0);
            await page.locator('[data-kanban-board] .column[data-status="inbox"]').screenshot({ path: path.join(pngDir, `${label}-inbox-raised.png`) });
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
        {
          const label = `phone-390-${lang}`;
          const { context, page, pageErrors } = await openFixture(browser, url, { width: 390, height: 844 }, "light", lang, "no-preference", true);
          try {
            await page.waitForSelector("[data-phone-kanban]", { timeout: 30_000 });
            await page.locator('[data-phone-kanban-tab="inbox"]').first().click();
            await page.waitForSelector('[data-phone-kanban-column="inbox"] [data-phone-card="task:t-prio-deploy"]', { timeout: 30_000 });
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(pngDir, `${label}-inbox.png`) });
            const read = await page.evaluate(() => ({
              inbox: [...document.querySelectorAll('[data-phone-kanban-column="inbox"] [data-phone-card^="task:"]')].map((element) => (element.getAttribute("data-phone-card") ?? "").replace(/^task:/, "")),
              marks: Object.fromEntries([...document.querySelectorAll('[data-phone-kanban-column="inbox"] [data-phone-card]')].flatMap((element) => {
                const mark = element.querySelector("[data-phone-card-priority]");
                return mark ? [[(element.getAttribute("data-phone-card") ?? "").replace(/^task:/, ""), mark.getAttribute("data-phone-card-priority")]] : [];
              })),
              overflowX: document.scrollingElement ? document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth : 0,
            }));
            readings[label] = read;
            if (JSON.stringify(read.inbox) !== JSON.stringify(INBOX)) failures.push(`${label}: Inbox reads ${JSON.stringify(read.inbox)}`);
            for (const id of INBOX) if ((read.marks as Record<string, string>)[id] !== MARKS[id]) failures.push(`${label}: ${id} mark ${(read.marks as Record<string, string>)[id]}`);
            if (read.overflowX > 0.5) failures.push(`${label}: overflows sideways by ${read.overflowX}px`);
            /* The task sheet's Priority face. */
            await page.locator('[data-phone-card="task:t-prio-notes"]').click();
            await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 10_000 });
            await page.locator('[data-mobile2-open="menu"]').first().click();
            await page.locator('[data-phone-task-menu="priority"]').click();
            await page.waitForSelector("[data-phone-task-priorities]", { timeout: 10_000 });
            await page.waitForTimeout(500);
            await page.screenshot({ path: path.join(pngDir, `${label}-sheet.png`) });
            const sheet = await page.evaluate(() => [...document.querySelectorAll("[data-phone-task-priority]")].map((row) => [row.getAttribute("data-phone-task-priority"), row.textContent?.trim(), row.getAttribute("aria-checked"), Math.round(row.getBoundingClientRect().height)]));
            readings[`${label}-sheet`] = sheet;
            const want = (["high", "normal", "low"] as const).map((level) => [level, t(`kanban.priority.${level}`), level === "normal" ? "true" : "false"]);
            if (JSON.stringify(sheet.map((row) => row.slice(0, 3))) !== JSON.stringify(want)) failures.push(`${label}: sheet ${JSON.stringify(sheet)}`);
            if (sheet.some((row) => (row[3] as number) < 44)) failures.push(`${label}: sheet rows under 44px ${JSON.stringify(sheet)}`);
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/task-priority", { recursive: true });
    fs.writeFileSync("evidence/task-priority/readings.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("interface polish round 2: press and open/close motion, the status menu at the card's ⋯, quiet card tools, the narrow sheet head", () => {
  /*
   * What only a browser settles for the round-2 interface polish (#2148), over
   * the fixture's default and `stages` scenarios in Chromium:
   *
   *   - a pressed board button and a lane's answer button scale to 0.96 and keep
   *     their whole unpressed box: a press that began 1 px inside the left edge
   *     and was held past the transition still clicks the button. The same press
   *     with the hit layer taken out misses, which is what shows this check can
   *     fail;
   *   - under reduced motion nothing scales, Past attempts opens in one frame and
   *     the Stages sheet arrives whole. Without it, Past attempts opens over
   *     several frames, a second click mid-way closes it from where it is, and
   *     the sheet fades in;
   *   - a card draws no status pill; S on a focused card opens the status menu at
   *     the card's ⋯; the fold and the ⋯ rest at 35 % and come up on hover and on
   *     focus, while the seat's lock, a status mark with no action, keeps its
   *     full strength (the rule it escaped, put back, fades it: the red path); the
   *     card's ⋯ names the task's Attach and each lane's apart;
   *   - below a desktop width (1024 px) the Stages sheet's head puts the lane's
   *     controls on a line of their own inside the sheet, and from there up the
   *     head holds one row with the title readable.
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "interface polish round 2"
   *
   * Readings go to `evidence/interface-polish/readings.json`; frames to
   * `.artifacts/interface-polish/`, which is not committed.
   */
  const OUT = path.resolve(".artifacts/interface-polish");
  const HIT_LAYER_OFF = ".kb .btn:active::after, .kb .card .add:active::after, .pblock .pb-act:active::after { display: none !important; }";

  interface PressReading { selector: string; width: number; x: number; pressedLeft: number; scale: string; hitInside: boolean; hit: string; clicks: number }

  /** Holds a press 1 px inside the control's left edge past the transition, then
      lets go; the click is counted at the control and kept from acting. */
  async function pressNearEdge(page: Page, selector: string, hitLayer: boolean): Promise<PressReading> {
    const control = page.locator(selector).first();
    await control.scrollIntoViewIfNeeded();
    const box = (await control.boundingBox())!;
    await control.evaluate((element) => {
      const hook = window as unknown as { pressClicks: number };
      hook.pressClicks = 0;
      if (element.hasAttribute("data-press-counted")) return;
      element.setAttribute("data-press-counted", "");
      element.addEventListener("click", (event) => { hook.pressClicks += 1; event.stopPropagation(); event.preventDefault(); }, { capture: true });
    });
    const style = hitLayer ? null : await page.addStyleTag({ content: HIT_LAYER_OFF });
    const x = box.x + 1;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(350);
    const held = await control.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        pressedLeft: Math.round(element.getBoundingClientRect().left * 100) / 100,
        scale: getComputedStyle(element).scale,
        hitInside: element.contains(hit),
        hit: hit ? `${hit.tagName.toLowerCase()}.${(hit.getAttribute("class") ?? "").split(" ").join(".")}` : "",
      };
    }, { x, y });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const clicks = await page.evaluate(() => (window as unknown as { pressClicks: number }).pressClicks);
    if (style) await style.evaluate((element) => (element as unknown as HTMLElement).remove());
    await page.mouse.move(2, 2);
    return { selector, width: Math.round(box.width), x: Math.round(x * 100) / 100, ...held, clicks };
  }

  /** Heights of the first card's Past attempts, one per frame, from the click on. */
  const sampleHistory = (page: Page, reverseAfterMs: number | null) => page.evaluate(async (reverse) => {
    const history = document.querySelector<HTMLDetailsElement>("[data-kanban-board] .card .history")!;
    const summary = history.querySelector<HTMLElement>("summary")!;
    const closed = history.getBoundingClientRect().height;
    const heights: number[] = [];
    const t0 = performance.now();
    summary.click();
    let reversed = false;
    await new Promise<void>((done) => {
      const tick = () => {
        heights.push(Math.round(history.getBoundingClientRect().height * 10) / 10);
        if (reverse !== null && !reversed && performance.now() - t0 >= reverse) { reversed = true; summary.click(); }
        if (performance.now() - t0 < 420) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    const settled = history.getBoundingClientRect().height;
    if (history.open) summary.click();
    return { closed: Math.round(closed * 10) / 10, heights, settled: Math.round(settled * 10) / 10, open: history.open };
  }, reverseAfterMs);

  /** The Stages sheet's opacity on its first frames after Stages is pressed. */
  const sampleSheet = (page: Page, taskId: string) => page.evaluate(async (selector) => {
    document.querySelector<HTMLElement>(`${selector} [data-open-stages]`)!.click();
    const opacities: number[] = [];
    await new Promise<void>((done) => {
      let frames = 0;
      const tick = () => {
        const sheet = document.querySelector<HTMLElement>(".gsheet");
        if (sheet) opacities.push(Math.round(Number(getComputedStyle(sheet).opacity) * 100) / 100);
        frames += 1;
        if (frames < 20) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return opacities;
  }, card(taskId));

  browserTest("interface polish round 2 holds in a real browser", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const motion of ["no-preference", "reduce"] as const) {
        const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=stages`, VIEWPORT, "light", "en", motion);
        try {
          await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
          /* The seat folded; a toast may stand over its button, so no pointer. */
          await page.evaluate(() => document.querySelector<HTMLElement>('[data-seat-collapse][aria-expanded="true"]')?.click());
          await page.waitForTimeout(800);
          /* The pressables: a board button, and a lane's answer button, each one
             whose left edge nothing covers at rest. */
          /* The widest of each, so the 2 % a press takes off each side is more
             than the pixel it is pressed inside the edge. */
          const pick = (selector: string, probe: string) => page.evaluate(({ selector: query, probe: name }) => {
            const found = [...document.querySelectorAll<HTMLElement>(query)]
              .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)
              .find((element) => {
                element.scrollIntoView({ block: "center" });
                const r = element.getBoundingClientRect();
                return r.width >= 60 && getComputedStyle(element).visibility !== "hidden" && element.contains(document.elementFromPoint(r.left + 1, r.top + r.height / 2));
              });
            if (!found) return null;
            found.setAttribute("data-press-probe", name);
            return found.textContent?.trim() ?? "";
          }, { selector, probe });
          const button = await pick("[data-kanban-board] .btn:not(:disabled)", "btn");
          const answer = await pick("[data-kanban-board] .pblock .pb-act:not(:disabled)", "answer");
          if (!button || !answer) failures.push(`${motion}: pressables not found ${JSON.stringify({ button, answer })}`);
          const presses: Record<string, PressReading> = {};
          for (const probe of ["btn", "answer"] as const) {
            const selector = `[data-press-probe="${probe}"]`;
            if (!(await page.locator(selector).count())) continue;
            presses[probe] = await pressNearEdge(page, selector, true);
            if (motion === "no-preference") {
              presses[`${probe}-no-hit-layer`] = await pressNearEdge(page, selector, false);
              const kept = presses[probe]!;
              const lost = presses[`${probe}-no-hit-layer`]!;
              if (kept.scale !== "0.96" || !kept.hitInside || kept.clicks !== 1) failures.push(`${probe}: a held press near the edge ${JSON.stringify(kept)}`);
              /* The red path: where the press takes 2 px or more off the side, the
                 same press with the hit layer taken out lands beside the button. */
              if (lost.pressedLeft - lost.x >= 2 && (lost.scale !== "0.96" || lost.hitInside || lost.clicks !== 0)) failures.push(`${probe}: without the hit layer the press should miss, and it read ${JSON.stringify(lost)}`);
            } else if (presses[probe]!.scale !== "none" || presses[probe]!.clicks !== 1) {
              failures.push(`${probe} under reduced motion: ${JSON.stringify(presses[probe])}`);
            }
          }
          /* Past attempts: by height over frames, reversible mid-way; at once under reduced motion. */
          const history = await sampleHistory(page, null);
          await page.waitForTimeout(600);
          const reversed = motion === "no-preference" ? await sampleHistory(page, 80) : null;
          await page.waitForTimeout(600);
          const full = Math.max(...history.heights);
          const between = history.heights.filter((height) => height > history.closed + 1 && height < full - 1);
          if (motion === "no-preference") {
            if (between.length < 2 || history.settled !== full) failures.push(`past attempts open by height: ${JSON.stringify(history)}`);
            if (!reversed || reversed.open || Math.max(...reversed.heights) >= full - 1 || reversed.settled !== history.closed) failures.push(`past attempts reversed mid-way: ${JSON.stringify(reversed)}`);
          } else if (between.length || history.heights[0] !== full) {
            failures.push(`past attempts under reduced motion: ${JSON.stringify(history)}`);
          }
          /* The Stages sheet fades in; under reduced motion it arrives whole. */
          const sheet = await sampleSheet(page, "t-upload");
          if (motion === "no-preference" ? !(sheet.length && sheet[0]! < 1 && sheet.at(-1) === 1) : sheet.some((value) => value !== 1)) failures.push(`${motion}: the sheet's first frames ${JSON.stringify(sheet)}`);
          await page.keyboard.press("Escape");
          readings[motion] = { button, answer, presses, history, reversed, sheet };
          if (pageErrors.length) failures.push(`${motion}: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }

      /* The card: no pill, S at the ⋯, quiet tools. */
      {
        const { context, page, pageErrors } = await openFixture(browser, server.base, VIEWPORT, "light", "en");
        try {
          await page.waitForSelector(card("t-verify-a"), { timeout: 20_000 });
          await page.waitForTimeout(600);
          const pills = await page.evaluate(() => document.querySelectorAll("[data-kanban-board] .card .foot .pill").length);
          if (pills) failures.push(`${pills} status pills on the board's cards`);
          const more = `${card("t-verify-a")} [data-menu]`;
          await page.locator(card("t-verify-a")).scrollIntoViewIfNeeded();
          await page.mouse.move(2, 2);
          await page.waitForTimeout(300);
          const opacity = () => page.locator(more).evaluate((element) => getComputedStyle(element).opacity);
          const rest = await opacity();
          await page.locator(card("t-verify-a")).hover();
          await page.waitForTimeout(300);
          const hovered = await opacity();
          await page.mouse.move(2, 2);
          await page.locator(card("t-verify-a")).focus();
          await page.waitForTimeout(300);
          const focused = await opacity();
          await page.keyboard.press("s");
          await page.waitForSelector('.menu[aria-label^="Status of"]', { timeout: 5_000 });
          const placed = await page.evaluate((selector) => {
            const menu = document.querySelector<HTMLElement>('.menu[aria-label^="Status of"]')!.getBoundingClientRect();
            const anchor = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
            const gapX = Math.max(0, menu.left - anchor.right, anchor.left - menu.right);
            const gapY = Math.max(0, menu.top - anchor.bottom, anchor.top - menu.bottom);
            return { gapX: Math.round(gapX), gapY: Math.round(gapY), radios: document.querySelectorAll('.menu [role="menuitemradio"]').length };
          }, more);
          await page.screenshot({ path: path.join(OUT, "status-menu-from-s.png") });
          await page.keyboard.press("Escape");
          /* The seat's lock keeps its strength at rest, and under the rule it escaped it fades
             with the tools. The fixture's seat card is not drawn today (#2165), so the lock is
             the one KanbanCard draws, placed in this card's tools beside its ⋯. */
          await page.mouse.move(2, 2);
          const lockOpacity = () => page.evaluate((selector) => {
            const tools = document.querySelector<HTMLElement>(`${selector} [data-menu]`)!.parentElement!;
            let lock = tools.querySelector<HTMLElement>("[data-lock]");
            if (!lock) {
              lock = document.createElement("span");
              lock.className = "icon-btn lock";
              lock.setAttribute("role", "img");
              lock.setAttribute("data-lock", "");
              tools.prepend(lock);
            }
            return getComputedStyle(lock).opacity;
          }, card("t-verify-a"));
          await page.waitForTimeout(300);
          const lockRest = await lockOpacity();
          const oldRule = await page.addStyleTag({ content: "@media (hover: hover) and (pointer: fine) { .kb .card .tools .icon-btn:not(.hide) { opacity: 0.35; transition: none; } }" });
          await page.waitForTimeout(100);
          const lockUnderOldRule = await lockOpacity();
          await oldRule.evaluate((element) => (element as unknown as HTMLElement).remove());
          readings.card = { pills, opacity: { rest, hovered, focused }, placed, lock: { rest: lockRest, underOldRule: lockUnderOldRule } };
          if (lockRest !== "1") failures.push(`the seat's lock fades at rest: ${lockRest}`);
          if (lockUnderOldRule !== "0.35") failures.push(`the lock's check cannot go red: under the old rule it read ${lockUnderOldRule}`);
          if (rest !== "0.35" || hovered !== "1" || focused !== "1") failures.push(`quiet card tools: ${JSON.stringify({ rest, hovered, focused })}`);
          if (placed.gapX > 8 || placed.gapY > 16 || placed.radios !== 4) failures.push(`S opened the status menu away from the card's ⋯: ${JSON.stringify(placed)}`);
          if (pageErrors.length) failures.push(`card: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }

      /* The card's ⋯ on a card with a lane: the task's Attach once, then one per lane that names the pipeline. */
      {
        const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=stages`, VIEWPORT, "light", "en");
        try {
          await page.waitForSelector(`${card("t-upload")} .pblock`, { state: "attached", timeout: 20_000 });
          await page.evaluate(() => document.querySelector<HTMLElement>('[data-seat-collapse][aria-expanded="true"]')?.click());
          await page.waitForTimeout(600);
          /* A toast may stand over the ⋯, so no pointer. */
          await page.locator(`${card("t-upload")} [data-menu]`).evaluate((element) => { element.scrollIntoView({ block: "center" }); (element as HTMLElement).click(); });
          await page.waitForSelector('.menu[aria-label^="Actions for"]', { timeout: 5_000 });
          const attach = await page.evaluate((selector) => ({
            lanes: document.querySelectorAll(`${selector} .pblock`).length,
            labels: [...document.querySelectorAll<HTMLElement>('.menu [role^="menuitem"] .lbl')].map((label) => label.firstChild?.textContent ?? "").filter((label) => label.startsWith("Attach PR or issue")),
          }), card("t-upload"));
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(OUT, "card-menu-attach.png") });
          await page.keyboard.press("Escape");
          readings.attach = attach;
          const expected = ["Attach PR or issue…", ...Array.from({ length: attach.lanes }, () => "Attach PR or issue to the pipeline…")];
          if (!attach.lanes || JSON.stringify(attach.labels) !== JSON.stringify(expected)) failures.push(`the card's ⋯ Attach labels: ${JSON.stringify(attach)}`);
          if (pageErrors.length) failures.push(`attach: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }

      /* The sheet's head at 640 and 820 px, and at 1100 px. */
      for (const width of [640, 820, 1100]) {
        const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=stages`, { width, height: 800 }, "light", "en");
        try {
          await page.waitForSelector(`${card("t-upload")} [data-open-stages]`, { state: "attached", timeout: 20_000 });
          await page.locator(`${card("t-upload")} .pblock`).evaluate((element) => element.scrollIntoView({ block: "center" }));
          await page.click(`${card("t-upload")} [data-open-stages]`);
          await page.waitForSelector(".gsheet .pane[data-stage]", { timeout: 10_000 });
          await page.waitForTimeout(600);
          const head = await page.evaluate(() => {
            const header = document.querySelector<HTMLElement>(".gsheet header")!;
            const rect = (element: Element | null) => {
              if (!element) return null;
              const r = element.getBoundingClientRect();
              return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
            };
            return {
              header: rect(header),
              title: rect(header.querySelector("h2")),
              laneBar: rect(header.querySelector(".lane-bar")),
              close: rect(header.querySelector("[data-sheet-close]")),
              overflow: header.scrollWidth - header.clientWidth,
            };
          });
          await page.screenshot({ path: path.join(OUT, `sheet-head-${width}.png`) });
          readings[`sheet-head-${width}`] = head;
          const inside = (box: { left: number; right: number } | null) => Boolean(box && head.header && box.left >= head.header.left - 0.5 && box.right <= head.header.right + 0.5);
          if (head.overflow > 1 || !inside(head.laneBar) || !inside(head.close)) failures.push(`sheet head at ${width}: ${JSON.stringify(head)}`);
          if (width < 1024 && !(head.laneBar && head.title && head.laneBar.top >= head.title.bottom - 1)) failures.push(`sheet head at ${width}: the lane's controls share the title's line ${JSON.stringify(head)}`);
          if (!(head.title && head.title.width >= 80)) failures.push(`sheet head at ${width}: the title is not readable ${JSON.stringify(head)}`);
          if (width >= 1024 && !(head.laneBar && head.title && head.laneBar.top < head.title.bottom)) failures.push(`sheet head at ${width}: not one row ${JSON.stringify(head)}`);
          /* Only the lane's controls leave the first line: the close stays on the title's. */
          if (!(head.close && head.title && head.close.top < head.title.bottom && head.close.bottom > head.title.top)) failures.push(`sheet head at ${width}: the close left the title's line ${JSON.stringify(head)}`);
          if (pageErrors.length) failures.push(`sheet head ${width}: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/interface-polish", { recursive: true });
    fs.writeFileSync("evidence/interface-polish/readings.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("the open agents at the board's side: short names, role emblem and colour, one click to each", () => {
  /* The `stages` scenario with 1, 3 and 7 of its conversations open as
     readers, remembered in this browser's storage before the first render,
     at 1440×900 and 1920×1080 in English and Ukrainian, and at 1600×900,
     where the names would cost the columns their layout and the rail is the
     count. What only a browser settles, and is gated here: the rail stands
     beside the columns and overlaps none of them; it lists exactly the open
     readers with the role their ribbon wears; a segment brings its reader
     into the window and focuses it; Alt+J walks on from there. Frames go to
     OPEN_AGENTS_PNG_DIR. */
  const OPEN = {
    1: ["search-ver-2"],
    3: ["search-ver-2", "rounds-review", "upload-plan"],
    7: ["search-ver-2", "rounds-review", "upload-plan", "upload-ui", "export-impl", "links-impl", "search-rev"],
  } as const;
  const seedReaders = (ids: readonly string[]) => `try { localStorage.setItem("llv:kanban-readers:v1:atlas", ${JSON.stringify(JSON.stringify(ids.map((id) => ({ key: `conversation_${id}`, path: `/repo/${id}.jsonl`, folded: false }))))}); } catch {}`;

  interface RailReading {
    tier: string | null;
    segments: Array<{ key: string; role: string; readerRole: string | null; name: string; card: string | null; dot: string | null }>;
    /** The chip, or the count alone: what the strip draws. */
    rail: { x: number; y: number; width: number; height: number } | null;
    overlaps: string[];
    head: string | null;
    pageErrors: string[];
  }
  const readRail = (page: Page) => page.evaluate((): Omit<RailReading, "pageErrors"> => {
    const rail = document.querySelector<HTMLElement>("[data-open-rail]");
    const box = rail?.getBoundingClientRect() ?? null;
    const chip = rail?.querySelector<HTMLElement>(".or-chip, .or-count")?.getBoundingClientRect() ?? null;
    const overlaps = box ? [...document.querySelectorAll<HTMLElement>("[data-kanban-board] .column[data-status], [data-kanban-board] .card")].filter((element) => {
      const other = element.getBoundingClientRect();
      return other.width > 0 && other.height > 0 && other.left < box.right - 0.5 && other.right > box.left + 0.5 && other.top < box.bottom - 0.5 && other.bottom > box.top + 0.5;
    }).map((element) => element.dataset.status ?? element.dataset.id ?? element.className) : [];
    return {
      tier: rail?.dataset.openRail ?? null,
      segments: [...document.querySelectorAll<HTMLElement>("[data-open-agent]")].map((segment) => ({
        key: segment.dataset.openAgent!,
        role: segment.dataset.role!,
        readerRole: document.querySelector<HTMLElement>(`[data-kanban-reader="${segment.dataset.openAgent}"]`)?.dataset.role ?? null,
        name: segment.querySelector(".or-name")?.textContent ?? "",
        card: segment.querySelector(".or-card")?.textContent ?? null,
        dot: segment.querySelector("[data-open-agent-dot]")?.getAttribute("data-open-agent-dot") ?? null,
      })),
      rail: chip ? { x: Math.round(chip.x), y: Math.round(chip.y), width: Math.round(chip.width), height: Math.round(chip.height) } : null,
      overlaps,
      head: rail?.querySelector("[data-open-rail-count]")?.textContent ?? null,
    };
  });
  /* The reader the operator is in, and how much of it the window shows. */
  const readFocus = (page: Page) => page.evaluate(() => {
    const reader = document.activeElement?.closest<HTMLElement>("[data-kanban-reader]") ?? null;
    const box = reader?.getBoundingClientRect();
    return {
      key: reader?.dataset.kanbanReader ?? null,
      headInWindow: box ? box.top >= 0 && box.top + 40 <= window.innerHeight && box.left >= 0 && box.left + 120 <= window.innerWidth : false,
    };
  });

  browserTest("1, 3 and 7 open agents at 1440×900 and 1920×1080, the count alone at 1600×900, in English and Ukrainian", async () => {
    const pngDir = process.env.OPEN_AGENTS_PNG_DIR ?? "/var/tmp/llv-open-agents-evidence";
    const out = path.resolve(".artifacts/open-agents-rail");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    const url = `${server.base}?scenario=stages`;
    const open = async (viewport: { width: number; height: number }, lang: "en" | "uk", ids: readonly string[]) => {
      const opened = await openFixture(browser, url, viewport, "light", lang);
      await opened.context.addInitScript(seedReaders(ids));
      await opened.page.reload();
      await opened.page.waitForSelector("[data-open-rail]", { timeout: 30_000 });
      await opened.page.waitForFunction((count) => document.querySelectorAll("[data-kanban-reader]").length >= count, ids.length, { timeout: 30_000 });
      /* The seat folded, so the board has the window; `O` is its own key, and a click could land on the attention island over its head. */
      await opened.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      if (await opened.page.locator('[data-seat-collapse][aria-expanded="true"]').count()) await opened.page.keyboard.press("o");
      await opened.page.waitForTimeout(700);
      return opened;
    };
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }] as const) {
          for (const count of [1, 3, 7] as const) {
            const label = `${viewport.width}x${viewport.height}-${count}-${lang}`;
            const ids = OPEN[count];
            const { context, page, pageErrors } = await open(viewport, lang, ids);
            try {
              await page.screenshot({ path: path.join(pngDir, `${label}.png`) });
              const reading = await readRail(page);
              readings[label] = { ...reading, pageErrors };
              if (reading.tier !== "full") failures.push(`${label}: the rail is ${reading.tier}, expected its names`);
              if (JSON.stringify(reading.segments.map((segment) => segment.key)) !== JSON.stringify(ids.map((id) => `conversation_${id}`))) failures.push(`${label}: the rail lists ${reading.segments.map((segment) => segment.key).join(", ")}`);
              for (const segment of reading.segments) {
                if (segment.role !== segment.readerRole) failures.push(`${label}: ${segment.key} wears ${segment.role}, its reader ${segment.readerRole}`);
                if (!segment.name || /conversation_|\/repo\//.test(`${segment.name} ${segment.card ?? ""}`)) failures.push(`${label}: ${segment.key} is named «${segment.name}»`);
              }
              if (reading.overlaps.length) failures.push(`${label}: the rail overlaps ${reading.overlaps.join(", ")}`);
              if (!reading.rail || reading.rail.y + reading.rail.height > viewport.height + 1) failures.push(`${label}: the rail is not whole in the window (${JSON.stringify(reading.rail)})`);
              if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
              if (count === 7) {
                /* One click on the last segment takes the board there; Alt+J walks on, round the end. */
                const last = `conversation_${ids[ids.length - 1]}`;
                await page.locator(`[data-open-agent-jump="${last}"]`).click();
                await page.waitForTimeout(500);
                const jumped = await readFocus(page);
                await page.screenshot({ path: path.join(pngDir, `${label}-jumped.png`) });
                if (jumped.key !== last || !jumped.headInWindow) failures.push(`${label}: after the click the operator is in ${JSON.stringify(jumped)}`);
                await page.keyboard.press("Alt+KeyJ");
                await page.waitForTimeout(500);
                const cycled = await readFocus(page);
                await page.screenshot({ path: path.join(pngDir, `${label}-alt-j.png`) });
                if (cycled.key !== `conversation_${ids[0]}` || !cycled.headInWindow) failures.push(`${label}: Alt+J landed in ${JSON.stringify(cycled)}`);
                await page.locator(`[data-open-agent="conversation_${ids[2]}"]`).hover();
                await page.waitForTimeout(250);
                await page.locator("[data-open-rail]").screenshot({ path: path.join(pngDir, `${label}-rail-hover.png`) });
                (readings[label] as Record<string, unknown>).jumped = jumped;
                (readings[label] as Record<string, unknown>).cycled = cycled;
              }
            } finally {
              await context.close();
            }
          }
        }
        {
          const label = `1600x900-7-${lang}`;
          const { context, page, pageErrors } = await open({ width: 1600, height: 900 }, lang, OPEN[7]);
          try {
            await page.screenshot({ path: path.join(pngDir, `${label}.png`) });
            const reading = await readRail(page);
            if (reading.tier !== "compact") failures.push(`${label}: the rail is ${reading.tier}, expected the count`);
            if (reading.head !== "7") failures.push(`${label}: the count reads «${reading.head}»`);
            if (reading.overlaps.length) failures.push(`${label}: the rail overlaps ${reading.overlaps.join(", ")}`);
            await page.locator("[data-open-rail-count]").click();
            await page.waitForSelector(".popover.open-agents", { timeout: 5_000 });
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(pngDir, `${label}-list.png`) });
            const listed = await readRail(page);
            if (listed.segments.length !== 7) failures.push(`${label}: the list holds ${listed.segments.length}`);
            await page.locator(`.popover.open-agents [data-open-agent-jump="conversation_${OPEN[7][3]}"]`).click();
            await page.waitForTimeout(500);
            const jumped = await readFocus(page);
            await page.screenshot({ path: path.join(pngDir, `${label}-jumped.png`) });
            if (jumped.key !== `conversation_${OPEN[7][3]}` || !jumped.headInWindow) failures.push(`${label}: after the click the operator is in ${JSON.stringify(jumped)}`);
            readings[label] = { ...reading, listed: listed.segments.length, jumped, pageErrors };
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/open-agents-rail", { recursive: true });
    fs.writeFileSync("evidence/open-agents-rail/readings.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 900_000);

  /* The page's edges, read in the same frames. The project's name, the
     folded Orchestrator row and the rail start on one left edge; the row
     stands one gap below the bar and one gap above what the board draws
     next (the columns, or the strip over them, the scroll mode's jump
     strip or the tabbed mode's tabs, which starts where the first column
     does and stands that gap above the columns); the rail's top is the columns' top; the
     rail's rows and the cards hold their content at one inset; and every
     column's title sits at the same offset in its column, framed or not.
     The first column the board shows starts on that edge too, and beside
     the rail it stands the board's edge (`--kb-edge`) clear of it, the same
     space the rail keeps from the sidebar, in every mode; the scroller's
     snap once scrolled that edge away at 1440×900. Each case runs with the
     rail, in its full tier at 1440×900 and 1920×1080 and as the count at
     1600×900, and without it, and at 1000×800 and 700×800 without it,
     where the board scrolls and where it shows tabs. */
  interface EdgeReading {
    mode: string | null;
    tier: string | null;
    name: number | null;
    seat: { left: number; top: number; bottom: number } | null;
    bar: number;
    rail: { left: number; top: number; right: number } | null;
    edge: number;
    column: number | null;
    strip: { left: number; top: number; bottom: number } | null;
    columns: number;
    railInset: number | null;
    cardInset: number | null;
    titles: Record<string, { left: number; top: number }>;
  }
  const readEdges = (page: Page) => page.evaluate((): EdgeReading => {
    const rect = (element: Element | null | undefined) => element?.getBoundingClientRect() ?? null;
    const lead = document.querySelector(".bar[data-bar=\"project\"] .bar-lead");
    const walker = lead ? document.createTreeWalker(lead, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }) : null;
    const text = walker?.nextNode() ?? null;
    let name: number | null = null;
    if (text) {
      const range = document.createRange();
      range.selectNodeContents(text);
      name = range.getBoundingClientRect().left;
    }
    const seat = rect(document.querySelector(".kb-page > .seat"));
    const railBox = rect(document.querySelector("[data-open-rail] :is(.or-chip, .or-count)"));
    const strip = rect(document.querySelector(".scroll-wrap > .tabs-nav > button"));
    const chip = rect(document.querySelector("[data-open-rail] .or-chip"));
    const emblem = rect(document.querySelector("[data-open-rail] .or-emblem"));
    const cardEl = document.querySelector<HTMLElement>("[data-kanban-board] .column[data-status=\"inbox\"] .card");
    const cardBox = rect(cardEl);
    const cardHead = rect(cardEl?.querySelector(".head"));
    const titles: Record<string, { left: number; top: number }> = {};
    for (const column of document.querySelectorAll<HTMLElement>("[data-kanban-board] .column[data-status]")) {
      const box = column.getBoundingClientRect();
      const title = column.querySelector(".col-head h2")?.getBoundingClientRect();
      if (title && box.width > 0) titles[column.dataset.status!] = { left: title.left - box.left, top: title.top - box.top };
    }
    const scroller = document.querySelector("[data-kanban-board] .board")?.getBoundingClientRect();
    const shown = [...document.querySelectorAll<HTMLElement>("[data-kanban-board] .column[data-status]")].map((column) => column.getBoundingClientRect()).filter((box) => box.width > 0 && (!scroller || box.right > scroller.left + 0.5));
    const kb = document.querySelector("[data-kanban-board]");
    const columns = Math.min(...[...document.querySelectorAll<HTMLElement>("[data-kanban-board] .column[data-status]")].map((column) => column.getBoundingClientRect()).filter((box) => box.width > 0).map((box) => box.top));
    return {
      mode: document.querySelector<HTMLElement>("[data-kanban-board]")?.dataset.mode ?? null,
      tier: document.querySelector<HTMLElement>("[data-open-rail]")?.dataset.openRail ?? null,
      name,
      seat: seat ? { left: seat.left, top: seat.top, bottom: seat.bottom } : null,
      bar: rect(document.querySelector(".bar[data-bar=\"project\"]"))!.bottom,
      rail: railBox ? { left: railBox.left, top: railBox.top, right: railBox.right } : null,
      edge: kb ? parseFloat(getComputedStyle(kb).getPropertyValue("--kb-edge")) : Number.NaN,
      column: shown.length ? Math.min(...shown.map((box) => box.left)) : null,
      strip: strip ? { left: strip.left, top: strip.top, bottom: strip.bottom } : null,
      columns,
      railInset: chip && emblem ? emblem.left - chip.left : null,
      cardInset: cardBox && cardHead ? cardHead.left - cardBox.left : null,
      titles,
    };
  });
  const edgeFailures = (label: string, edges: EdgeReading, railExpected: boolean): string[] => {
    const failures: string[] = [];
    const near = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) <= 0.5;
    if (!edges.seat) return [`${label}: no Orchestrator row on top`];
    if (!near(edges.name, edges.seat.left)) failures.push(`${label}: the project's name starts at ${edges.name}, the Orchestrator row at ${edges.seat.left}`);
    if (railExpected) {
      if (!edges.rail) failures.push(`${label}: no rail`);
      else {
        if (!near(edges.rail.left, edges.seat.left)) failures.push(`${label}: the rail starts at ${edges.rail.left}, the Orchestrator row at ${edges.seat.left}`);
        if (!near(edges.rail.top, edges.columns)) failures.push(`${label}: the rail's top is ${edges.rail.top}, the columns' ${edges.columns}`);
        if (edges.column != null && !near(edges.column - edges.rail.right, edges.edge)) failures.push(`${label}: the first column stands ${edges.column - edges.rail.right} px clear of the rail, the board's edge is ${edges.edge}`);
      }
      if (edges.tier === "full" && !near(edges.railInset, edges.cardInset)) failures.push(`${label}: the rail's rows hold their content ${edges.railInset} in, the cards ${edges.cardInset}`);
    }
    if (!railExpected && !near(edges.column, edges.seat.left)) failures.push(`${label}: the first column starts at ${edges.column}, the Orchestrator row at ${edges.seat.left}`);
    const above = edges.seat.top - edges.bar;
    const next = edges.strip ?? { top: edges.columns, bottom: edges.columns };
    const below = next.top - edges.seat.bottom;
    if (!near(above, below)) failures.push(`${label}: ${above} px above the Orchestrator row, ${below} below it`);
    if (edges.strip && !near(edges.columns - edges.strip.bottom, above)) failures.push(`${label}: the ${edges.mode} strip stands ${edges.columns - edges.strip.bottom} px above the columns, the row ${above} below the bar`);
    if (edges.strip && !near(edges.strip.left, edges.column)) failures.push(`${label}: the ${edges.mode} strip starts at ${edges.strip.left}, the first column at ${edges.column}`);
    const inbox = edges.titles.inbox;
    for (const [status, title] of Object.entries(edges.titles)) {
      if (inbox && (!near(title.left, inbox.left) || !near(title.top, inbox.top))) failures.push(`${label}: ${status}'s title sits at ${title.left},${title.top} in its column, Inbox's at ${inbox.left},${inbox.top}`);
    }
    return failures;
  };

  browserTest("one left edge, one gap round the Orchestrator row, the rail level with the columns, one inset for its rows and the cards", async () => {
    const pngDir = process.env.OPEN_AGENTS_PNG_DIR ?? "/var/tmp/llv-open-agents-evidence";
    const out = path.resolve(".artifacts/open-agents-rail");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 1600, height: 900 }, { width: 1000, height: 800 }, { width: 700, height: 800 }] as const) {
          for (const ids of viewport.width < 1440 ? [[]] as const : [OPEN[3], []] as const) {
            const label = `edges-${viewport.width}x${viewport.height}-${ids.length}-${lang}`;
            const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=stages`, viewport, "light", lang);
            try {
              await context.addInitScript(seedReaders(ids));
              await page.reload();
              await page.waitForSelector("[data-kanban-board] .column[data-status] .card >> visible=true", { timeout: 30_000 });
              if (ids.length) await page.waitForSelector("[data-open-rail]", { timeout: 30_000 });
              await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
              if (await page.locator('[data-seat-collapse][aria-expanded="true"]').count()) await page.keyboard.press("o");
              await page.waitForTimeout(700);
              await page.screenshot({ path: path.join(pngDir, `${label}.png`) });
              const edges = await readEdges(page);
              readings[label] = { ...edges, pageErrors };
              failures.push(...edgeFailures(label, edges, ids.length > 0));
              if (ids.length && edges.tier !== (viewport.width === 1600 ? "compact" : "full")) failures.push(`${label}: the rail is ${edges.tier}`);
              if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
            } finally {
              await context.close();
            }
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.mkdirSync("evidence/open-agents-rail", { recursive: true });
    fs.writeFileSync("evidence/open-agents-rail/edges.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 900_000);
});

describe("#2179 #2185 agent replies wider than the operator's bubble, a seat dragged wider, one inset per container", () => {
  /*
   * Over the fixture's `agent-report` scenario, where the orchestrator has
   * just answered with a long report (a list, a code block and a table), at
   * 1440 and 1280 in Chromium:
   *
   *   - the agent's reply runs wider than the operator's bubble, and stays
   *     inside a readable measure on the widest seat;
   *   - the seat on top takes a width grip on its right edge: a drag widens it
   *     (both edges move, it stays centred), the arrows move it by 40 px, and
   *     the width comes back after a reload for this project only. At 1280 the
   *     board beside the project rail is already the seat's width, so the drag
   *     is read with the rail put away;
   *   - the containers the designer marked (#2185) are measured by their INK:
   *     a card's top, bottom and side insets, the space above and below the
   *     «Not on a task» divider, the origin chip against the card's text edge
   *     and baseline, the left edges of everything in an open conversation and
   *     in the seat, the gaps between the seat's header items, Fold's inset,
   *     and the rail's filter row.
   *
   *   AGENT_REPLY_STAMP=after AGENT_REPLY_PNG_DIR=… CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "agent replies wider"
   *
   * `AGENT_REPLY_STAMP=before` only records (it is how the merge base was
   * read); `after` also gates. Readings go to
   * `evidence/agent-reply-width/readings-<stamp>.json`; frames to
   * `AGENT_REPLY_PNG_DIR`, or `.artifacts/agent-reply-width/`, never committed.
   */
  const STAMP = process.env.AGENT_REPLY_STAMP === "before" ? "before" : "after";
  const OUT = path.resolve(process.env.AGENT_REPLY_PNG_DIR ?? ".artifacts/agent-reply-width");
  const EVIDENCE = path.resolve("evidence/agent-reply-width");
  const FRAMES = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }] as const;
  const SEAT = "[data-kanban-seat]";
  const READER = '[data-kanban-reader="conversation_export-impl"]';
  const HIDE_TOAST = "[data-attention-toast] { display: none !important; }";

  /* Ink: the union of the visible text runs, glyphs and images inside an
     element, which is what the eye reads as its edge. */
  const INK = `(() => {
    const visible = el => {
      while (el && getComputedStyle(el).display === "contents") el = el.parentElement;
      return Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0;
    };
    /* The alphabetic baseline of an element's first text run: the run's box
       top plus its font's ascent, which is where Chrome sets the content area. */
    window.__baseline = el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const style = getComputedStyle(node.parentElement);
        const context = document.createElement("canvas").getContext("2d");
        context.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
        return rect.top + context.measureText(node.nodeValue).fontBoundingBoxAscent;
      }
      return null;
    };
    window.__ink = (root, skip) => {
      if (!root) return null;
      let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
      /* A line the clamp or a scroller hides is no ink: each rect is cut by
         every ancestor that clips. */
      const clipOf = el => {
        let clip = null;
        for (let at = el; at; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          const r = at.getBoundingClientRect();
          clip = clip ? { top: Math.max(clip.top, r.top), left: Math.max(clip.left, r.left), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) } : { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
        }
        return clip;
      };
      const add = (r, clip) => {
        const cut = clip ? { top: Math.max(clip.top, r.top), left: Math.max(clip.left, r.left), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) } : r;
        if (cut.right - cut.left < 0.5 || cut.bottom - cut.top < 0.5) return;
        top = Math.min(top, cut.top); left = Math.min(left, cut.left); right = Math.max(right, cut.right); bottom = Math.max(bottom, cut.bottom);
      };
      const skipped = el => skip && el.closest(skip);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue.trim() || !visible(node.parentElement) || skipped(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const clip = clipOf(node.parentElement);
        for (const r of range.getClientRects()) add(r, clip);
      }
      for (const el of root.querySelectorAll("svg, img")) if (visible(el) && !skipped(el) && !el.parentElement.closest("svg")) add(el.getBoundingClientRect(), clipOf(el.parentElement));
      return top === Infinity ? null : { top, left, right, bottom };
    };
    window.__box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  })()`;
  const round = (value: unknown): unknown => typeof value === "number" ? Math.round(value * 10) / 10
    : Array.isArray(value) ? value.map(round)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, round(entry)])) : value;

  async function ready(page: Page) {
    await page.addStyleTag({ content: HIDE_TOAST });
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
    await page.waitForSelector(`${SEAT} [data-orchestrator-panel]`, { state: "attached", timeout: 20_000 });
    await page.waitForFunction((seat) => document.querySelector(`${seat} [data-feed-state]`)?.getAttribute("data-feed-state") === "items", SEAT, { timeout: 15_000 });
    await page.addScriptTag({ content: INK });
    await page.waitForTimeout(500);
  }

  /* The report's first line at the top of the seat's transcript, or with
     `lower`, its code block and table. */
  async function showReport(page: Page, lower = false) {
    await page.evaluate(({ seat, lower }) => {
      const scroller = document.querySelector<HTMLElement>(`${seat} [data-log-feed-scroller]`)!;
      const report = [...document.querySelectorAll<HTMLElement>(`${seat} [data-tts-message]`)].find((el) => el.textContent?.includes("Here is where the release stands"))!;
      const anchor = lower ? report.querySelector("pre") ?? report : report;
      scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (lower ? 40 : 8);
    }, { seat: SEAT, lower });
    await page.waitForTimeout(300);
  }

  const readSeat = (page: Page) => page.evaluate((seat) => {
    const w = window as unknown as { __ink: (el: Element | null, skip?: string) => { top: number; left: number; right: number; bottom: number } | null; __box: (el: Element | null) => { top: number; left: number; right: number; bottom: number; width: number; height: number } | null };
    const root = document.querySelector(seat)!;
    const box = w.__box(root)!;
    const report = [...root.querySelectorAll("[data-tts-message]")].find((el) => el.textContent?.includes("Here is where the release stands")) ?? null;
    const bubbles = [...root.querySelectorAll("[data-user-bubble]")];
    const avatar = report?.parentElement?.firstElementChild ?? null;
    const head = root.querySelector(".seat-head");
    const title = root.querySelector(".seat-title");
    const strong = w.__ink(title?.querySelector("strong") ?? null);
    const proj = w.__ink(title?.querySelector(".proj") ?? null);
    const state = w.__box(title?.querySelector(".state i") ?? null) ?? w.__ink(title?.querySelector(".state") ?? null);
    const av = w.__box(root.querySelector(".seat-head .av"));
    const fold = w.__box(root.querySelector("[data-seat-collapse]"));
    const strip = root.querySelector("[data-agent-control-strip]");
    const field = root.querySelector("[data-orchestrator-conversation] form textarea")?.parentElement ?? null;
    const modelRow = root.querySelector("[data-orchestrator-conversation] form [data-runtime-pill], [data-orchestrator-conversation] form [data-testid] > div:last-child button");
    const border = parseFloat(getComputedStyle(root).borderLeftWidth) || 0;
    const inner = box.left + border;
    const edge = (value: number | null | undefined) => value == null ? null : value - inner;
    return {
      seatWidth: box.width,
      seatCentreOffset: (box.left + box.right) / 2 - (() => { const frame = root.parentElement!.getBoundingClientRect(); return (frame.left + frame.right) / 2; })(),
      reportWidth: report ? w.__box(report)!.width : null,
      reportInkWidth: report ? (() => { const ink = w.__ink(report.querySelector("[data-tts-body]") ? report : report); return ink ? ink.right - ink.left : null; })() : null,
      bubbleWidths: bubbles.map((el) => w.__box(el)!.width),
      bubbleRightInset: bubbles.length ? box.right - border - w.__box(bubbles[0]!)!.right : null,
      insets: {
        headAvatar: edge(av?.left),
        foldRight: fold ? box.right - border - fold.right : null,
        feedAvatar: edge(w.__box(avatar)?.left),
        reportText: edge(report ? w.__ink(report.querySelector("[data-tts-body]") ?? report)?.left : null),
        strip: edge(strip ? w.__ink(strip)?.left : null),
        stripBox: edge(w.__box(strip?.firstElementChild?.firstElementChild ?? null)?.left),
        composerBox: edge(w.__box(field)?.left),
        modelRow: edge(w.__box(modelRow)?.left),
      },
      headGaps: {
        avatarToTitle: av && strong ? strong.left - av.right : null,
        titleToProject: strong && proj ? proj.left - strong.right : null,
        projectToState: proj && state ? state.left - proj.right : null,
        headPadLeft: head ? parseFloat(getComputedStyle(head).paddingLeft) : null,
        headPadRight: head ? parseFloat(getComputedStyle(head).paddingRight) : null,
      },
    };
  }, SEAT);

  const readCards = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __ink: (el: Element | null, skip?: string) => { top: number; left: number; right: number; bottom: number } | null; __box: (el: Element | null) => { top: number; left: number; right: number; bottom: number; width: number; height: number } | null };
    const column = document.querySelector('.column[data-status="inbox"]')!;
    const cards = [...column.querySelectorAll<HTMLElement>(".card")].map((card) => {
      const box = w.__box(card)!;
      const ink = w.__ink(card, ".label, .saving")!;
      const titleText = w.__ink(card.querySelector(".title"));
      const text = w.__ink(card.querySelector(".foot .age, .foot .origin-chip"));
      const chip = card.querySelector(".origin-chip");
      const chipAge = chip?.nextElementSibling ?? null;
      const baseline = (el: Element | null) => el ? (window as unknown as { __baseline: (el: Element) => number | null }).__baseline(el) : null;
      return {
        id: card.dataset.id,
        top: ink.top - box.top,
        bottom: box.bottom - ink.bottom,
        left: ink.left - box.left,
        right: box.right - ink.right,
        titleLeft: titleText ? titleText.left - box.left : null,
        footTextLeft: text ? text.left - box.left : null,
        chip: chip ? {
          boxLeft: w.__box(chip)!.left - box.left,
          textLeft: w.__ink(chip)!.left - box.left,
          baselineDelta: (() => { const a = baseline(chip); const b = baseline(chipAge); return a !== null && b !== null ? a - b : null; })(),
          textEdgeAbove: (() => { const latest = card.querySelector(".tile .latest, .tile .row"); const ink2 = w.__ink(latest); return ink2 ? ink2.left - box.left : null; })(),
          /* From the text above it to its frame, and from its frame to the line below it. */
          gapAbove: (() => { const members = w.__ink(card.querySelector(".members")); return members ? w.__box(chip)!.top - members.bottom : null; })(),
          gapBelow: (() => {
            const chipBox = w.__box(chip)!;
            const below = [...chip.parentElement!.children].map((el) => w.__ink(el)).filter((ink): ink is NonNullable<typeof ink> => Boolean(ink) && ink!.top >= chipBox.bottom - 0.5);
            return below.length ? Math.min(...below.map((ink) => ink.top)) - chipBox.bottom : null;
          })(),
        } : null,
      };
    });
    const divider = column.querySelector<HTMLElement>(".divider");
    let dividerGaps = null as null | { above: number; below: number };
    if (divider) {
      const line = divider.getBoundingClientRect();
      const mid = (w.__ink(divider)!.top + w.__ink(divider)!.bottom) / 2;
      const prev = divider.previousElementSibling?.getBoundingClientRect();
      const next = divider.nextElementSibling?.getBoundingClientRect();
      dividerGaps = { above: prev ? mid - prev.bottom : NaN, below: next ? next.top - mid : NaN };
      void line;
    }
    return { cards, dividerGaps };
  });

  const readReader = (page: Page) => page.evaluate((selector) => {
    const w = window as unknown as { __ink: (el: Element | null, skip?: string) => { top: number; left: number; right: number; bottom: number } | null; __box: (el: Element | null) => { top: number; left: number; right: number; bottom: number; width: number; height: number } | null };
    const root = document.querySelector(selector)!;
    const box = w.__box(root)!;
    const border = parseFloat(getComputedStyle(root).borderLeftWidth) || 0;
    const edge = (value: number | null | undefined) => value == null ? null : Math.round((value - box.left - border) * 10) / 10;
    const agent = [...root.querySelectorAll("[data-tts-message]")].pop() ?? null;
    const avatar = agent?.parentElement?.firstElementChild ?? null;
    const status = root.querySelector("[data-turn-status]");
    const pill = root.querySelector("[data-live-tail-pill]");
    const strip = root.querySelector("[data-agent-control-strip]");
    const field = root.querySelector("form textarea")?.parentElement ?? null;
    const model = root.querySelector("form [data-runtime-pill]");
    const bubble = root.querySelector("[data-user-bubble]");
    return {
      width: box.width,
      head: edge(w.__box([...root.querySelectorAll(".conv-head .ch-row > *")].find((el) => el.getClientRects().length > 0) ?? null)?.left),
      avatar: edge(w.__box(avatar)?.left),
      agentText: edge(agent ? w.__ink(agent.querySelector("[data-tts-body]") ?? agent)?.left : null),
      statusRow: edge(w.__box(status?.firstElementChild ?? null)?.left),
      liveTailPill: edge(w.__box(pill)?.left),
      strip: edge(w.__box(strip?.firstElementChild?.firstElementChild ?? null)?.left),
      composerBox: edge(w.__box(field)?.left),
      modelRow: edge(w.__box(model)?.left),
      bubbleRight: bubble ? Math.round((box.right - border - w.__box(bubble)!.right) * 10) / 10 : null,
      stripRight: strip ? Math.round((box.right - border - (w.__box(strip.firstElementChild)!.right)) * 10) / 10 : null,
    };
  }, READER);

  const readRail = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __box: (el: Element | null) => { top: number; left: number; right: number; bottom: number; width: number; height: number } | null };
    const aside = document.querySelector("aside")!;
    const asideBox = w.__box(aside)!;
    const header = aside.querySelector("header");
    const input = aside.querySelector("input");
    const folder = aside.querySelector('[data-testid="rail-create-project"]');
    const first = aside.querySelector("nav button");
    const menu = aside.querySelector("[data-rail-menu]");
    const brand = aside.querySelector("[data-brand-mark]");
    const inputBox = w.__box(input)!;
    const folderBox = w.__box(folder);
    return {
      brandLeft: w.__box(brand)!.left - asideBox.left,
      menuRight: asideBox.right - 1 - w.__box(menu)!.right,
      filterLeft: inputBox.left - asideBox.left,
      folderRight: folderBox ? asideBox.right - 1 - folderBox.right : null,
      rowLeft: w.__box(first)!.left - asideBox.left,
      rowRight: asideBox.right - 1 - w.__box(first)!.right,
      input: { top: inputBox.top, height: inputBox.height },
      folder: folderBox ? { top: folderBox.top, width: folderBox.width, height: folderBox.height } : null,
      headerToFilter: inputBox.top - w.__box(header)!.bottom,
      filterToFirstRow: w.__box(first)!.top - inputBox.bottom,
    };
  });

  browserTest("#2179 #2185: agent replies, the seat's width grip, and the insets the designer marked", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(path.resolve(".artifacts/agent-reply-width-bundle"));
    const browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const readings: Record<string, unknown> = {};
    const url = `${server.base}?scenario=agent-report`;
    const shot = (page: Page, name: string, selector?: string) => selector
      ? page.locator(selector).first().screenshot({ path: path.join(OUT, `${name}-${STAMP}.png`) })
      : page.screenshot({ path: path.join(OUT, `${name}-${STAMP}.png`) });
    try {
      for (const viewport of FRAMES) {
        const label = String(viewport.width);
        const { context, page, pageErrors } = await openFixture(browser, url, viewport, "light");
        try {
          await ready(page);
          await showReport(page);
          const seat = await readSeat(page);
          readings[`seat-${label}-default`] = round(seat);
          await shot(page, `seat-${label}-default`, SEAT);
          await shot(page, `board-${label}-seat`);
          await showReport(page, true);
          await shot(page, `seat-${label}-default-table`, SEAT);
          await showReport(page);
          if (STAMP === "after") {
            const widest = Math.max(0, ...seat.bubbleWidths);
            if (!(seat.reportWidth !== null && seat.reportWidth > widest + 40)) failures.push(`${label}: the agent's reply (${seat.reportWidth}px) is not wider than the operator's bubble (${widest}px)`);
            /* Boxes: the head's avatar, the transcript's avatar, the strip's first control, the composer and the model row. */
            const { headAvatar, feedAvatar, stripBox, composerBox, modelRow } = seat.insets;
            const insets = [feedAvatar, stripBox, composerBox, modelRow].filter((value): value is number => typeof value === "number");
            if (insets.length < 4 || insets.some((value) => Math.abs(value - headAvatar!) > 1)) failures.push(`${label}: the seat's rows are on different left edges ${JSON.stringify(seat.insets)}`);
            if (seat.insets.foldRight === null || Math.abs(seat.insets.foldRight - seat.insets.headAvatar!) > 1) failures.push(`${label}: Fold sits ${seat.insets.foldRight}px from the right, the avatar ${seat.insets.headAvatar}px from the left`);
          }

          /* The width grip, where it exists. */
          const grip = page.locator(`${SEAT} [data-seat-grip="top-width"]`);
          const hasGrip = (await grip.count()) > 0;
          readings[`grip-${label}`] = hasGrip;
          if (STAMP === "after" && !hasGrip) failures.push(`${label}: the seat on top has no width grip`);
          if (hasGrip) {
            if (viewport.width < 1440) {
              await page.click("[data-rail-hide]");
              await page.waitForTimeout(500);
              await showReport(page);
              readings[`seat-${label}-rail-away`] = round(await readSeat(page));
              await shot(page, `seat-${label}-rail-away-default`, SEAT);
            }
            const before = (await page.locator(SEAT).boundingBox())!;
            const handle = (await grip.boundingBox())!;
            await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
            await page.mouse.down();
            await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2, { steps: 6 });
            await page.mouse.up();
            await page.waitForTimeout(500);
            await showReport(page);
            const wide = await readSeat(page);
            readings[`seat-${label}-dragged`] = round(wide);
            await shot(page, `seat-${label}-dragged`, SEAT);
            await showReport(page, true);
            await shot(page, `seat-${label}-dragged-table`, SEAT);
            await showReport(page);
            await shot(page, `board-${label}-seat-dragged`);
            const after = (await page.locator(SEAT).boundingBox())!;
            if (!(after.width > before.width + 100)) failures.push(`${label}: a 120 px drag took the seat from ${before.width}px to ${after.width}px`);
            if (Math.abs(wide.seatCentreOffset) > 2) failures.push(`${label}: the dragged seat is off centre by ${wide.seatCentreOffset}px`);
            if (!(wide.reportWidth !== null && seat.reportWidth !== null && wide.reportWidth >= seat.reportWidth)) failures.push(`${label}: the reply narrowed when the seat widened (${seat.reportWidth} → ${wide.reportWidth})`);
            /* The arrows, then a reload: the width is this project's. */
            await grip.focus();
            await page.keyboard.press("ArrowLeft");
            await page.waitForTimeout(300);
            const keyed = (await page.locator(SEAT).boundingBox())!.width;
            if (!(keyed < after.width - 20)) failures.push(`${label}: ArrowLeft left the seat at ${keyed}px (was ${after.width}px)`);
            const stored = await page.evaluate(() => localStorage.getItem("llv:kanban-seat:v2"));
            readings[`stored-${label}`] = stored;
            await page.reload();
            await ready(page);
            const reloaded = (await page.locator(SEAT).boundingBox())!.width;
            if (Math.abs(reloaded - keyed) > 1) failures.push(`${label}: the seat came back ${reloaded}px wide after a reload, ${keyed}px before`);
            if (!stored || !/"atlas":\d+/.test(stored)) failures.push(`${label}: the width is not stored per project: ${stored}`);
            if (viewport.width < 1440) {
              await page.click("[data-rail-hide]").catch(() => undefined);
            }
          }
          if (pageErrors.length) failures.push(`${label} seat: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }

        /* The board with the seat folded: cards, the divider, the chip; then one open conversation. */
        const board = await openFixture(browser, url, viewport, "light");
        try {
          await ready(board.page);
          await board.page.click(`${SEAT} [data-seat-collapse]`);
          await board.page.waitForTimeout(500);
          const cards = await readCards(board.page);
          readings[`cards-${label}`] = round(cards);
          readings[`rail-${label}`] = round(await readRail(board.page));
          await shot(board.page, `cards-${label}`, '.column[data-status="inbox"]');
          await board.page.screenshot({ path: path.join(OUT, `rail-${label}-${STAMP}.png`), clip: { x: 0, y: 0, width: 248, height: 220 } });
          await board.page.locator(".seat-head").first().screenshot({ path: path.join(OUT, `seat-head-${label}-folded-${STAMP}.png`) });
          await board.page.click('.card[data-id="task:t-export"] .tile >> nth=0');
          await board.page.waitForFunction((selector) => document.querySelector(`${selector} [data-feed-state]`)?.getAttribute("data-feed-state") === "items", READER, { timeout: 15_000 });
          await board.page.waitForTimeout(600);
          const reader = await readReader(board.page);
          readings[`reader-${label}`] = round(reader);
          await shot(board.page, `reader-${label}`, READER);
          await shot(board.page, `board-${label}-reader`);
          if (STAMP === "after") {
            for (const card of cards.cards) {
              if (Math.abs(card.top - card.bottom) > 1.5) failures.push(`${label}: card ${card.id} top ${card.top}px, bottom ${card.bottom}px`);
              if (card.chip && Math.abs(card.chip.baselineDelta ?? 99) > 0.5) failures.push(`${label}: card ${card.id}'s origin chip is ${card.chip.baselineDelta}px off the age's baseline`);
              if (card.chip && (card.chip.gapAbove === null || card.chip.gapBelow === null || Math.abs(card.chip.gapAbove - card.chip.gapBelow) > 1)) failures.push(`${label}: card ${card.id}'s origin chip has ${card.chip.gapAbove}px above and ${card.chip.gapBelow}px below`);
              if (card.chip && card.chip.textEdgeAbove !== null && Math.abs(card.chip.boxLeft - card.chip.textEdgeAbove) > 1) failures.push(`${label}: card ${card.id}'s origin chip starts ${card.chip.boxLeft}px in, the text above ${card.chip.textEdgeAbove}px`);
            }
            if (!cards.dividerGaps || Math.abs(cards.dividerGaps.above - cards.dividerGaps.below) > 1) failures.push(`${label}: the divider has ${JSON.stringify(cards.dividerGaps)} around it`);
            const edges = [reader.head, reader.avatar, reader.statusRow, reader.liveTailPill, reader.strip, reader.composerBox, reader.modelRow].filter((value): value is number => typeof value === "number");
            if (edges.some((value) => Math.abs(value - reader.avatar!) > 1)) failures.push(`${label}: the open conversation's rows start on different edges ${JSON.stringify(reader)}`);
            const rail = await readRail(board.page);
            if (rail.folder && (Math.abs(rail.folder.top - rail.input.top) > 0.5 || Math.abs(rail.folder.height - rail.input.height) > 0.5 || Math.abs(rail.folder.width - rail.folder.height) > 0.5)) failures.push(`${label}: the rail's folder button ${JSON.stringify(rail.folder)} beside the field ${JSON.stringify(rail.input)}`);
            if (Math.abs(rail.headerToFilter - rail.filterToFirstRow) > 0.5 || Math.abs(rail.filterLeft - rail.rowLeft) > 0.5) failures.push(`${label}: the rail's filter row ${JSON.stringify(rail)}`);
          }
          if (board.pageErrors.length) failures.push(`${label} board: page errors ${board.pageErrors.join(" | ")}`);
        } finally {
          await board.context.close();
        }
      }

      /* Tried and compared: the agent's reply in a light container of its own. */
      if (STAMP === "after") {
        const trial = await openFixture(browser, url, FRAMES[0], "light");
        try {
          await ready(trial.page);
          await trial.page.addStyleTag({ content: `${SEAT} [data-tts-message] { background: var(--surface-well); border-radius: var(--radius-surface); padding: 8px 14px 10px; }` });
          await showReport(trial.page);
          await trial.page.locator(SEAT).screenshot({ path: path.join(OUT, "seat-1440-trial-agent-container.png") });
        } finally {
          await trial.context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, `readings-${STAMP}.json`), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (STAMP === "after" && failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#2187 a lane parked on a review says why in one line and answers in plain words", () => {
  /*
   * docs/design/merge-policy-and-task-finishing.md §3.4: one lane for each row
   * of the table (`?scenario=review-stops`) on the desktop board at 1440, in
   * en and uk. Each lane row draws its reason line in the table's words and
   * the two answers in theirs; no answer cuts its label, and no text of the
   * answer meets another text or a control, all inside its card. The phone's
   * task screen at 390 is the phone driver's case of the same issue.
   *
   *   REVIEW_STOPS_STAMP=after REVIEW_STOPS_PNG_DIR=… CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "#2187"
   *
   * `REVIEW_STOPS_STAMP=before` only records (it is how the merge base was
   * drawn); PNGs go to `REVIEW_STOPS_PNG_DIR`, or `.artifacts/review-stops/`,
   * never committed.
   */
  const STAMP = process.env.REVIEW_STOPS_STAMP === "before" ? "before" : "after";
  const OUT = path.resolve(process.env.REVIEW_STOPS_PNG_DIR ?? ".artifacts/review-stops");
  const EVIDENCE = path.resolve("evidence/review-stops");
  const LANES = [
    { task: "t-stop-fix", kind: "stop-after-fix", reason: "pipelineBlock.stop.afterFix", answers: [["accept-head", "pipelineBlock.answer.acceptAsIs"], ["continue-review", "pipelineBlock.answer.reviewAgain"]] },
    { task: "t-stop-park", kind: "park", reason: "pipelineBlock.stop.park", answers: [["skip-stage", "pipelineBlock.answer.acceptWithoutReview"], ["retry-stage", "pipelineBlock.answer.reviewAgain"]] },
    { task: "t-stop-once", kind: "once", reason: "pipelineBlock.stop.once", answers: [["skip-stage", "pipelineBlock.answer.acceptWithoutReview"], ["retry-stage", "pipelineBlock.answer.reviewAgain"]] },
    { task: "t-stop-legacy", kind: "legacy", reason: "pipelineBlock.stop.legacy", answers: [["skip-stage", "pipelineBlock.answer.acceptWithoutReview"], ["retry-stage", "pipelineBlock.answer.reviewAgain"]] },
  ] as const;
  type LaneReading = {
    task: string; kind: string | null; reason: string | null; answers: Array<[string, string]>; findings: string[];
    clipped: string[]; overlaps: string[]; escapes: string[]; buttonHeights: number[];
  };
  /* Each lane's answer as drawn: the reason line, the answers' labels, the
     findings it lists, and the ink of every text in it against every other
     text and control, clipped by what clips it. */
  const READ = (tasks: string[]) => tasks.map((task) => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    type Box = ReturnType<typeof box>;
    const intersect = (a: Box, b: Box): Box => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = (r: Box) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const union = (a: Box, b: Box): Box => ({ top: Math.min(a.top, b.top), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    const card = document.querySelector(`[data-kanban-board] .card[data-id="task:${task}"]`);
    const answer = card?.querySelector(".pb-answer");
    const out: LaneReading = { task, kind: null, reason: null, answers: [], findings: [], clipped: [], overlaps: [], escapes: [], buttonHeights: [] };
    if (!card || !answer) return out;
    const reason = answer.querySelector("[data-review-stop]");
    out.kind = reason?.getAttribute("data-review-stop") ?? null;
    out.reason = (reason ?? answer.querySelector(".stage-report, .review-heads"))?.textContent?.trim() ?? null;
    const buttons = [...answer.querySelectorAll<HTMLElement>("[data-answer-action]")];
    out.answers = buttons.map((button) => [button.getAttribute("data-answer-action") ?? "", (button.textContent ?? "").trim()]);
    out.buttonHeights = buttons.map((button) => Math.round(button.getBoundingClientRect().height));
    out.findings = [...answer.querySelectorAll(".stage-findings li .text")].map((item) => (item.textContent ?? "").trim());
    const ink: Array<{ el: Element; rect: Box; text: string }> = [];
    const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.trim() || !node.parentElement) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width * r.height > 0.5).map((r) => ({ top: r.top, left: r.left, right: r.right, bottom: r.bottom }));
      if (!rects.length) continue;
      const rect = rects.reduce(union);
      ink.push({ el: node.parentElement, rect, text: node.nodeValue.trim().slice(0, 40) });
      /* A label cut by its own button, or by any box that clips it. */
      for (let up: Element | null = node.parentElement; up && up !== card; up = up.parentElement) {
        const style = getComputedStyle(up);
        const clipping = style.overflowX !== "visible" || style.overflowY !== "visible";
        const visible = clipping ? intersect(rect, box(up)) : rect;
        if (clipping && area(visible) + 1 < area(rect)) { out.clipped.push(`${node.nodeValue.trim().slice(0, 40)} cut by ${up.tagName.toLowerCase()}`); break; }
      }
    }
    for (const button of buttons) {
      if (button.scrollWidth > button.clientWidth + 1) out.clipped.push(`${button.textContent?.trim()} overflows its button by ${button.scrollWidth - button.clientWidth}px`);
    }
    const frame = box(card);
    for (let i = 0; i < ink.length; i++) {
      const a = ink[i]!;
      if (a.rect.left < frame.left - 1 || a.rect.right > frame.right + 1 || a.rect.bottom > frame.bottom + 1) out.escapes.push(a.text);
      for (let j = i + 1; j < ink.length; j++) {
        const b = ink[j]!;
        if (!a.el.contains(b.el) && !b.el.contains(a.el) && area(intersect(a.rect, b.rect)) > 0.5) out.overlaps.push(`text/text: ${a.text} | ${b.text}`);
      }
      for (const button of buttons) {
        if (!button.contains(a.el) && area(intersect(a.rect, box(button))) > 0.5) out.overlaps.push(`text/control: ${a.text} | ${button.textContent?.trim()}`);
      }
    }
    for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
      if (area(intersect(box(buttons[i]!), box(buttons[j]!))) > 0.5) out.overlaps.push(`control/control: ${buttons[i]!.textContent?.trim()} | ${buttons[j]!.textContent?.trim()}`);
    }
    return out;
  });

  browserTest("each row of §3.4's table draws its reason line and its plain answers at 1440, en and uk, with no cut label and no overlap", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(path.resolve(".artifacts/review-stops-bundle"));
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, LaneReading[]> = {};
    const failures: string[] = [];
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const scheme of ["light", "dark"] as const) {
          const label = `1440-${lang}-${scheme}`;
          const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=review-stops`, { width: 1440, height: 900 }, scheme, lang);
          try {
            await page.waitForSelector(`${card("t-stop-legacy")} [data-pipeline]`, { timeout: 30_000 });
            await page.waitForTimeout(800);
            for (const lane of LANES) {
              const element = page.locator(card(lane.task));
              await element.scrollIntoViewIfNeeded();
              await element.screenshot({ path: path.join(OUT, `${STAMP}-card-${lane.kind}-${label}.png`) });
            }
            await page.screenshot({ path: path.join(OUT, `${STAMP}-board-${label}.png`) });
            const reading = await page.evaluate(READ, LANES.map((lane) => lane.task)) as LaneReading[];
            readings[label] = reading;
            const t = (key: string, params?: Record<string, string | number>) => translate(lang, key as never, params);
            for (const lane of LANES) {
              const got = reading.find((entry) => entry.task === lane.task)!;
              const fail = (text: string) => failures.push(`${label} ${lane.kind}: ${text}`);
              if (got.kind !== lane.kind) fail(`drawn as ${got.kind}`);
              if (lane.kind === "once") {
                const [head, tail] = t(lane.reason, { stage: "\u0000" }).split("\u0000");
                if (!got.reason?.startsWith(head!) || !got.reason.endsWith(tail!)) fail(`reason ${JSON.stringify(got.reason)}`);
              } else if (got.reason !== t(lane.reason, lane.kind === "park" ? { count: 3 } : undefined)) fail(`reason ${JSON.stringify(got.reason)}`);
              const want = lane.answers.map(([action, key]) => [action, t(key)]);
              if (JSON.stringify(got.answers) !== JSON.stringify(want)) fail(`answers ${JSON.stringify(got.answers)}, expected ${JSON.stringify(want)}`);
              if (lane.kind === "legacy" && got.findings.some((text) => /round limit reached/.test(text))) fail(`the flow's own detail is still listed as a finding: ${JSON.stringify(got.findings)}`);
              if (!got.findings.length) fail("no finding listed under the reason");
              for (const entry of [...got.clipped, ...got.overlaps]) fail(entry);
              for (const entry of got.escapes) fail(`paints outside its card: ${entry}`);
            }
            /* §3.5: the completed lane whose last fix nobody reviewed says so on a line of its own, inside its card. */
            const done = page.locator(card("t-stop-done"));
            await done.scrollIntoViewIfNeeded();
            await done.screenshot({ path: path.join(OUT, `${STAMP}-card-unreviewed-${label}.png`) });
            const note = await page.evaluate((selector) => {
              const cardElement = document.querySelector(selector);
              const line = cardElement?.querySelector("[data-pipeline-unreviewed]");
              if (!cardElement || !line) return null;
              const a = line.getBoundingClientRect();
              const frame = cardElement.getBoundingClientRect();
              const crossed = [...cardElement.querySelectorAll(".pb-head, .pb-chain, .pb-note")].filter((other) => {
                const b = other.getBoundingClientRect();
                return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
              }).length;
              return { text: (line.textContent ?? "").trim(), inside: a.left >= frame.left - 1 && a.right <= frame.right + 1, crossed };
            }, card("t-stop-done"));
            const wantNote = translate(lang, "pipelineBlock.unreviewedFix" as never, { count: 1 });
            if (note?.text !== wantNote) failures.push(`${label} unreviewed: ${JSON.stringify(note)}, expected ${JSON.stringify(wantNote)}`);
            else if (!note.inside || note.crossed) failures.push(`${label} unreviewed: ${JSON.stringify(note)}`);
            const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (sideways > 0) failures.push(`${label}: the page scrolls sideways by ${sideways}px`);
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, `desktop-${STAMP}.json`), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (STAMP === "after" && failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#2187 a completed lane's automatic merge, and the project's merge setting", () => {
  /*
   * docs/design/merge-policy-and-task-finishing.md §4.6, §6: a completed lane
   * in each merge state (`?scenario=merge-states`) on the desktop board at
   * 1440, en and uk: the word after "done" in its ink, the line under the
   * chain, and a stopped merge's reason with "Leave the PR open" and "Try the
   * merge again". No label is cut, no text meets another text or a control,
   * and nothing paints outside its card. The board's ⋯ carries the "Merge
   * when the review passes" row, drawn on and then off by its own switch. The
   * phone at 390 is the phone driver's case of the same issue.
   *
   *   CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 MERGE_STATES_PNG_DIR=… \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "#2187 a completed lane"
   *
   * PNGs go to `MERGE_STATES_PNG_DIR`, or `.artifacts/merge-states/`, never committed.
   */
  const OUT = path.resolve(process.env.MERGE_STATES_PNG_DIR ?? ".artifacts/merge-states");
  const EVIDENCE = path.resolve("evidence/merge-states");
  const LANES = [
    { task: "t-merge-wait", word: "waiting", note: "waiting" },
    { task: "t-merge-update", word: "updating", note: "waiting" },
    { task: "t-merge-stop", word: "stopped", note: null },
    { task: "t-merge-done", word: "merged", note: "merged" },
  ] as const;
  type MergeReading = {
    task: string; word: string | null; wordText: string | null; wordColor: string | null; note: string | null; noteText: string | null;
    reason: string | null; answers: Array<[string, string]>; clipped: string[]; overlaps: string[]; escapes: string[];
  };
  const READ = (tasks: string[]) => tasks.map((task) => {
    type Box = { top: number; left: number; right: number; bottom: number };
    const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    const intersect = (a: Box, b: Box): Box => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = (r: Box) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const union = (a: Box, b: Box): Box => ({ top: Math.min(a.top, b.top), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    const cardElement = document.querySelector(`[data-kanban-board] .card[data-id="task:${task}"]`);
    const block = cardElement?.querySelector(".pblock");
    const out: MergeReading = { task, word: null, wordText: null, wordColor: null, note: null, noteText: null, reason: null, answers: [], clipped: [], overlaps: [], escapes: [] };
    if (!cardElement || !block) return out;
    const word = block.querySelector(".pb-merge");
    out.word = word?.getAttribute("data-merge-state") ?? null;
    out.wordText = word?.textContent?.trim() ?? null;
    out.wordColor = word ? getComputedStyle(word).color : null;
    const note = block.querySelector("[data-merge-note]");
    out.note = note?.getAttribute("data-merge-note") ?? null;
    out.noteText = note?.textContent?.trim() ?? null;
    out.reason = block.querySelector("[data-merge-stop]")?.textContent?.trim() ?? null;
    const buttons = [...block.querySelectorAll<HTMLElement>("[data-answer-action]")];
    out.answers = buttons.map((button) => [button.getAttribute("data-answer-action") ?? "", (button.textContent ?? "").trim()]);
    for (const button of buttons) if (button.scrollWidth > button.clientWidth + 1) out.clipped.push(`${button.textContent?.trim()} overflows its button by ${button.scrollWidth - button.clientWidth}px`);
    /* The ink of the merge's own words, and of everything else in the lane row they could meet. */
    const ink: Array<{ el: Element; rect: Box; text: string; own: boolean }> = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.trim() || !node.parentElement) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width * r.height > 0.5).map((r) => ({ top: r.top, left: r.left, right: r.right, bottom: r.bottom }));
      if (!rects.length) continue;
      let rect = rects.reduce(union);
      const own = Boolean(node.parentElement.closest(".pb-merge, [data-merge-note], .pb-answer"));
      /* Ink is what shows: a text its overflow box clips (the lane title's
         ellipsis) is measured inside that box. The merge's own words may not
         be clipped at all. */
      for (let up: Element | null = node.parentElement; up && up !== cardElement; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const visible = intersect(rect, box(up));
        if (own && area(visible) + 1 < area(rect)) { out.clipped.push(`${node.nodeValue.trim().slice(0, 40)} cut by ${up.tagName.toLowerCase()}.${up.className}`); break; }
        rect = visible;
      }
      if (area(rect) > 0.5) ink.push({ el: node.parentElement, rect, text: node.nodeValue.trim().slice(0, 40), own });
    }
    const frame = box(cardElement);
    for (let i = 0; i < ink.length; i++) {
      const a = ink[i]!;
      if (a.own && (a.rect.left < frame.left - 1 || a.rect.right > frame.right + 1 || a.rect.bottom > frame.bottom + 1)) out.escapes.push(a.text);
      for (let j = i + 1; j < ink.length; j++) {
        const b = ink[j]!;
        if ((a.own || b.own) && !a.el.contains(b.el) && !b.el.contains(a.el) && area(intersect(a.rect, b.rect)) > 0.5) out.overlaps.push(`text/text: ${a.text} | ${b.text}`);
      }
      if (a.own) for (const button of buttons) if (!button.contains(a.el) && area(intersect(a.rect, box(button))) > 0.5) out.overlaps.push(`text/control: ${a.text} | ${button.textContent?.trim()}`);
    }
    return out;
  });

  browserTest("each merge state says its words at 1440, en and uk, and the ⋯ carries the setting row on and off", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(path.resolve(".artifacts/merge-states-bundle"));
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const scheme of ["light", "dark"] as const) {
          const label = `1440-${lang}-${scheme}`;
          const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=merge-states`, { width: 1440, height: 900 }, scheme, lang);
          try {
            await page.waitForSelector(`${card("t-merge-stop")} [data-merge-stop]`, { timeout: 30_000 });
            await page.waitForTimeout(800);
            const t = (key: string, params?: Record<string, string | number>) => translate(lang, key as never, params);
            for (const lane of LANES) {
              const element = page.locator(card(lane.task));
              await element.scrollIntoViewIfNeeded();
              await element.screenshot({ path: path.join(OUT, `card-${lane.word}-${label}.png`) });
            }
            await page.screenshot({ path: path.join(OUT, `board-${label}.png`) });
            const reading = await page.evaluate(READ, LANES.map((lane) => lane.task)) as MergeReading[];
            for (const lane of LANES) {
              const got = reading.find((entry) => entry.task === lane.task)!;
              const fail = (text: string) => failures.push(`${label} ${lane.word}: ${text}`);
              if (got.word !== lane.word) fail(`merge word drawn as ${got.word}`);
              if (lane.word === "waiting") {
                const [head] = t("pipelineBlock.merge.waiting", { age: "\u0000" }).split("\u0000");
                if (!got.wordText?.startsWith(head!) || got.wordText === head) fail(`word ${JSON.stringify(got.wordText)}`);
              } else if (got.wordText !== t(`pipelineBlock.merge.${lane.word}`)) fail(`word ${JSON.stringify(got.wordText)}`);
              if (got.note !== lane.note) fail(`note ${got.note}`);
              if (lane.note === "waiting" && got.noteText !== t("pipelineBlock.merge.waitingHint")) fail(`note ${JSON.stringify(got.noteText)}`);
              if (lane.note === "merged" && got.noteText !== t("pipelineBlock.merge.byDelegatus")) fail(`note ${JSON.stringify(got.noteText)}`);
              if (lane.word === "stopped") {
                const want = t("pipelineBlock.merge.reason", { reason: t("pipelineBlock.mergeReason.check", { name: "privacy-publication" }) });
                if (got.reason !== want) fail(`reason ${JSON.stringify(got.reason)}, expected ${JSON.stringify(want)}`);
                const answers = [["dismiss", t("pipelineBlock.answer.leaveOpen")], ["retry-merge", t("pipelineBlock.answer.retryMerge")]];
                if (JSON.stringify(got.answers) !== JSON.stringify(answers)) fail(`answers ${JSON.stringify(got.answers)}`);
              } else if (got.answers.length) fail(`answers ${JSON.stringify(got.answers)} on a merge that asks nothing`);
              for (const entry of [...got.clipped, ...got.overlaps]) fail(entry);
              for (const entry of got.escapes) fail(`paints outside its card: ${entry}`);
            }
            /* The ⋯ menu: the setting row on, its switch, and the row off. */
            const more = page.locator('[data-bar-group="more"] button').first();
            await more.click();
            const row = page.locator("[data-merge-on-review]");
            await row.waitFor({ timeout: 10_000 });
            await page.waitForFunction(() => !document.querySelector("[data-merge-on-review-switch]")?.hasAttribute("disabled"), undefined, { timeout: 10_000 });
            const menuBox = page.locator('[data-bar-menu-group="project"]').locator("xpath=..");
            await menuBox.screenshot({ path: path.join(OUT, `menu-setting-on-${label}.png`) });
            const readRow = () => page.evaluate(() => {
              const element = document.querySelector("[data-merge-on-review]")!;
              const toggle = element.querySelector<HTMLElement>("[data-merge-on-review-switch]")!;
              const label = element.querySelector("span.flex-1")!;
              const hint = element.querySelector('[role="status"]')!;
              const a = label.getBoundingClientRect();
              const b = toggle.getBoundingClientRect();
              const menu = element.closest('[role="menu"], [data-bar-menu-group]')!.getBoundingClientRect();
              const h = hint.getBoundingClientRect();
              return {
                state: element.getAttribute("data-merge-on-review"), checked: toggle.getAttribute("aria-checked"),
                label: label.textContent?.trim() ?? "", hint: hint.textContent?.trim() ?? "",
                labelMeetsSwitch: Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5,
                labelCut: label.scrollWidth > label.clientWidth + 1,
                inside: h.right <= menu.right + 1 && b.right <= menu.right + 1,
                switchHeight: Math.round(b.height),
              };
            });
            const on = await readRow();
            if (on.state !== "on" || on.checked !== "true") failures.push(`${label} menu: the row reads ${JSON.stringify(on)}`);
            if (on.label !== t("projectSettings.mergeOnReview") || on.hint !== t("projectSettings.mergeOnReview.on")) failures.push(`${label} menu on: ${JSON.stringify(on)}`);
            await page.locator("[data-merge-on-review-switch]").click();
            await page.waitForFunction(() => document.querySelector("[data-merge-on-review]")?.getAttribute("data-merge-on-review") === "off", undefined, { timeout: 10_000 });
            await page.waitForFunction(() => !document.querySelector("[data-merge-on-review-switch]")?.hasAttribute("disabled"), undefined, { timeout: 10_000 });
            await menuBox.screenshot({ path: path.join(OUT, `menu-setting-off-${label}.png`) });
            const off = await readRow();
            if (off.hint !== t("projectSettings.mergeOnReview.off")) failures.push(`${label} menu off: ${JSON.stringify(off)}`);
            const writes = await page.evaluate(() => (window as unknown as { evidence?: { settingWrites: unknown[] } }).evidence?.settingWrites ?? null);
            for (const entry of [on, off]) if (entry.labelMeetsSwitch || entry.labelCut || !entry.inside) failures.push(`${label} menu geometry: ${JSON.stringify(entry)}`);
            await page.keyboard.press("Escape");
            /* Try the merge again sends retry-merge for the stopped lane. */
            if (scheme === "light") {
              await page.locator(`${card("t-merge-stop")} [data-answer-action="retry-merge"]`).click();
              await page.waitForTimeout(1_200);
            }
            const patches = await page.evaluate(() => (window as unknown as { evidence?: { pipelinePatches: Array<{ id: string; body: Record<string, unknown> }> } }).evidence?.pipelinePatches ?? null);
            if (scheme === "light" && !patches?.some((entry) => entry.id === "p-merge-stop" && entry.body.action === "retry-merge")) failures.push(`${label}: Try the merge again sent ${JSON.stringify(patches)}`);
            readings[label] = { lanes: reading, menu: { on, off, writes }, patches };
            const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (sideways > 0) failures.push(`${label}: the page scrolls sideways by ${sideways}px`);
            if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "desktop.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#2187 a pipeline that finishes its task, and the wait for the task's other lanes", () => {
  /*
   * docs/design/merge-policy-and-task-finishing.md §5.3, §6 (mockup D4): on
   * the desktop board at 1440, en and uk (`?scenario=task-finish`), a running
   * lane marked "finishes the task", a task whose marked lane merged while a
   * second lane still runs ("Done waits for 1 more pipeline" on the card,
   * "finishes the task once 1 other pipeline ends" on the lane row), and a
   * Done task its marked lane finished ("finished the task"). The card's ⋯
   * carries "Finishes the task", checked, with the count of the other open
   * lane in warning ink, and the toggle sends `link-task` with `finishes`. No
   * word is cut, none meets another text or a control, and nothing paints
   * outside its card. The phone at 390 is the phone driver's case.
   *
   *   CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 TASK_FINISH_PNG_DIR=… \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "#2187 a pipeline that finishes"
   *
   * PNGs go to `TASK_FINISH_PNG_DIR`, or `.artifacts/task-finish/`, never committed.
   */
  const OUT = path.resolve(process.env.TASK_FINISH_PNG_DIR ?? ".artifacts/task-finish");
  const EVIDENCE = path.resolve("evidence/task-finish");
  const CARDS = ["t-finish-marked", "t-finish-hold", "t-finish-done"] as const;
  type FinishReading = {
    task: string; column: string | null; flags: Array<{ pipeline: string; state: string; text: string; color: string; inChain: boolean; beforeLinks: boolean }>;
    laneWaits: string[]; cardWait: string | null; clipped: string[]; overlaps: string[]; escapes: string[];
  };
  const READ = (tasks: string[]) => tasks.map((task) => {
    type Box = { top: number; left: number; right: number; bottom: number };
    const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    const intersect = (a: Box, b: Box): Box => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = (r: Box) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const union = (a: Box, b: Box): Box => ({ top: Math.min(a.top, b.top), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    const cardElement = document.querySelector(`[data-kanban-board] .card[data-id="task:${task}"]`);
    const out: FinishReading = { task, column: null, flags: [], laneWaits: [], cardWait: null, clipped: [], overlaps: [], escapes: [] };
    if (!cardElement) return out;
    out.column = cardElement.closest(".column[data-status]")?.getAttribute("data-status") ?? null;
    for (const flag of cardElement.querySelectorAll<HTMLElement>("span[data-pipeline-finish]")) {
      out.flags.push({
        pipeline: flag.getAttribute("data-pipeline-finish-for") ?? "", state: flag.getAttribute("data-pipeline-finish") ?? "", text: flag.textContent?.trim() ?? "",
        color: getComputedStyle(flag).color, inChain: Boolean(flag.closest(".pb-chain")) && !flag.closest(".pb-head"),
        beforeLinks: Boolean(flag.nextElementSibling?.classList.contains("pb-links")),
      });
    }
    out.laneWaits = [...cardElement.querySelectorAll('p[data-pipeline-finish="waits"]')].map((node) => node.textContent?.trim() ?? "");
    out.cardWait = cardElement.querySelector("[data-task-finish-wait]")?.textContent?.trim() ?? null;
    const controls = [...cardElement.querySelectorAll<HTMLElement>("button, a")];
    const ink: Array<{ el: Element; rect: Box; text: string; own: boolean }> = [];
    const walker = document.createTreeWalker(cardElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.trim() || !node.parentElement) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width * r.height > 0.5).map((r) => ({ top: r.top, left: r.left, right: r.right, bottom: r.bottom }));
      if (!rects.length) continue;
      let rect = rects.reduce(union);
      const own = Boolean(node.parentElement.closest("[data-pipeline-finish], [data-task-finish-wait]"));
      for (let up: Element | null = node.parentElement; up && up !== cardElement; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const visible = intersect(rect, box(up));
        if (own && area(visible) + 1 < area(rect)) { out.clipped.push(`${node.nodeValue.trim().slice(0, 40)} cut by ${up.tagName.toLowerCase()}.${up.className}`); break; }
        rect = visible;
      }
      if (area(rect) > 0.5) ink.push({ el: node.parentElement, rect, text: node.nodeValue.trim().slice(0, 40), own });
    }
    const frame = box(cardElement);
    for (let i = 0; i < ink.length; i++) {
      const a = ink[i]!;
      if (a.own && (a.rect.left < frame.left - 1 || a.rect.right > frame.right + 1 || a.rect.bottom > frame.bottom + 1)) out.escapes.push(a.text);
      for (let j = i + 1; j < ink.length; j++) {
        const b = ink[j]!;
        if ((a.own || b.own) && !a.el.contains(b.el) && !b.el.contains(a.el) && area(intersect(a.rect, b.rect)) > 0.5) out.overlaps.push(`text/text: ${a.text} | ${b.text}`);
      }
      if (a.own) for (const control of controls) if (!control.contains(a.el) && area(intersect(a.rect, box(control))) > 0.5) out.overlaps.push(`text/control: ${a.text} | ${control.textContent?.trim().slice(0, 30)}`);
    }
    return out;
  });
  const READ_MENU = () => {
    const root = document.querySelector<HTMLElement>(".menu")!;
    const menu = root.getBoundingClientRect();
    return [...root.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].map((item) => {
      const why = item.querySelector<HTMLElement>(".why:not(.warn)");
      const warn = item.querySelector<HTMLElement>(".why.warn");
      const box = item.getBoundingClientRect();
      return {
        label: item.querySelector(".lbl")?.firstChild?.textContent ?? "", checked: item.getAttribute("aria-checked"),
        why: why?.textContent ?? null, warn: warn?.textContent ?? null, warnColor: warn ? getComputedStyle(warn).color : null, whyColor: why ? getComputedStyle(why).color : null,
        cut: [item, why, warn].some((el) => el ? el.scrollWidth > el.clientWidth + 1 : false),
        inside: box.left >= menu.left - 1 && box.right <= menu.right + 1 && menu.right <= window.innerWidth && menu.bottom <= window.innerHeight + 1,
      };
    });
  };

  browserTest("the flag, finished the task, the wait on the card and the lane row, and the menu's count at 1440, en and uk", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(path.resolve(".artifacts/task-finish-bundle"));
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const scheme of ["light", "dark"] as const) {
          const label = `1440-${lang}-${scheme}`;
          const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=task-finish`, { width: 1440, height: 900 }, scheme, lang);
          try {
            await page.waitForSelector(`${card("t-finish-hold")} [data-task-finish-wait]`, { timeout: 30_000 });
            await page.waitForTimeout(800);
            const t = (key: string, params?: Record<string, string | number>) => translate(lang, key as never, params);
            for (const task of CARDS) {
              const element = page.locator(card(task));
              await element.scrollIntoViewIfNeeded();
              await element.screenshot({ path: path.join(OUT, `card-${task.replace("t-finish-", "")}-${label}.png`) });
            }
            await page.screenshot({ path: path.join(OUT, `board-${label}.png`) });
            const reading = await page.evaluate(READ, [...CARDS]) as FinishReading[];
            const of = (task: string) => reading.find((entry) => entry.task === task)!;
            const fail = (text: string) => failures.push(`${label} ${text}`);
            const marked = of("t-finish-marked");
            if (JSON.stringify(marked.flags.map((flag) => [flag.pipeline, flag.state, flag.text])) !== JSON.stringify([["p-finish-marked", "marked", t("pipelineBlock.finish.marked")]])) fail(`marked flags ${JSON.stringify(marked.flags)}`);
            if (marked.cardWait !== null || marked.laneWaits.length) fail(`marked waits ${JSON.stringify([marked.cardWait, marked.laneWaits])}`);
            const hold = of("t-finish-hold");
            if (hold.column !== "assigned") fail(`the waiting task sits in ${hold.column}`);
            if (hold.flags.length) fail(`the waiting lane draws a chain flag ${JSON.stringify(hold.flags)}`);
            if (JSON.stringify(hold.laneWaits) !== JSON.stringify([t("pipelineBlock.finish.waits", { count: 1 })])) fail(`lane wait ${JSON.stringify(hold.laneWaits)}`);
            if (hold.cardWait !== t("pipelineBlock.finish.cardWaits", { count: 1 })) fail(`card wait ${JSON.stringify(hold.cardWait)}`);
            const done = of("t-finish-done");
            if (done.column !== "done") fail(`the finished task sits in ${done.column}`);
            if (JSON.stringify(done.flags.map((flag) => [flag.state, flag.text])) !== JSON.stringify([["finished", t("pipelineBlock.finish.done")]])) fail(`done flags ${JSON.stringify(done.flags)}`);
            for (const entry of [...marked.flags, ...done.flags]) {
              if (!entry.inChain) fail(`${entry.pipeline}: the flag is not on the chain row`);
              if (!entry.beforeLinks) fail(`${entry.pipeline}: the flag is not right before the PR chip`);
            }
            /* Success ink once it has, muted before: the two flags differ. */
            if (marked.flags[0] && done.flags[0] && marked.flags[0].color === done.flags[0].color) fail(`finished flag shares the marked flag's ink ${done.flags[0].color}`);
            for (const entry of reading) {
              for (const line of [...entry.clipped, ...entry.overlaps]) fail(`${entry.task}: ${line}`);
              for (const line of entry.escapes) fail(`${entry.task}: paints outside its card: ${line}`);
            }
            /* The card's ⋯: both lanes' toggles, the marked one checked with the count in warning ink. */
            await page.locator(card("t-finish-hold")).scrollIntoViewIfNeeded();
            await page.click(`${card("t-finish-hold")} [data-menu]`);
            await page.waitForSelector('.menu [role="menuitemcheckbox"]', { timeout: 10_000 });
            await page.waitForTimeout(350);
            await page.locator(".menu").screenshot({ path: path.join(OUT, `menu-hold-${label}.png`) });
            await page.screenshot({ path: path.join(OUT, `board-menu-${label}.png`) });
            const menu = await page.evaluate(READ_MENU);
            const want = [
              { label: t("pipelineBlock.finish.menu"), checked: "true", why: t("pipelineBlock.finish.menuWhy"), warn: t("pipelineBlock.finish.menuOpen", { count: 1 }) },
              { label: t("pipelineBlock.finish.menu"), checked: "false", why: t("pipelineBlock.finish.menuWhy"), warn: null },
            ];
            if (JSON.stringify(menu.map(({ label: l, checked, why, warn }) => ({ label: l, checked, why, warn }))) !== JSON.stringify(want)) fail(`menu ${JSON.stringify(menu)}`);
            for (const entry of menu) {
              if (entry.cut || !entry.inside) fail(`menu geometry ${JSON.stringify(entry)}`);
              if (entry.warn && entry.warnColor === entry.whyColor) fail(`the count hint is not in warning ink: ${entry.warnColor}`);
            }
            await page.keyboard.press("Escape");
            /* The toggle: clearing the running lane's flag sends link-task, and the flag leaves the row. */
            if (scheme === "light") {
              await page.click(`${card("t-finish-marked")} [data-menu]`);
              await page.waitForSelector('.menu [role="menuitemcheckbox"]', { timeout: 10_000 });
              await page.locator('.menu [role="menuitemcheckbox"]').first().click();
              await page.waitForFunction(() => !document.querySelector('[data-kanban-board] .card[data-id="task:t-finish-marked"] span[data-pipeline-finish]'), undefined, { timeout: 10_000 }).catch(() => fail("the flag stayed on the row after clearing it"));
              const patches = await page.evaluate(() => (window as unknown as { evidence?: { pipelinePatches: Array<{ id: string; body: Record<string, unknown> }> } }).evidence?.pipelinePatches ?? null);
              if (!patches?.some((entry) => entry.id === "p-finish-marked" && entry.body.action === "link-task" && entry.body.taskId === "t-finish-marked" && entry.body.finishes === false)) fail(`the toggle sent ${JSON.stringify(patches)}`);
              readings[`${label}-toggle`] = { patches };
            }
            readings[label] = { cards: reading, menu };
            const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (sideways > 0) fail(`the page scrolls sideways by ${sideways}px`);
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "desktop.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#2166 the desktop leads with the orchestrator", () => {
  /*
   * Slice 1 of docs/design/orchestrator-first-onboarding.md §6: the real
   * Viewer over `issue1695Evidence.fixture.tsx`, in Chromium, at 1440 × 900
   * and 1280 × 800, English and Ukrainian:
   *
   *   - `?scenario=orchestrator-first` — a project created a moment ago, with
   *     no seat, no task and no view chosen. It opens on its Board, the seat's
   *     create draft above the columns in plain words (no issue number, no
   *     "MCP", "deploy", "APPROVE" or "lanes"), its rules folded, its runtime
   *     on one Runs on row, and the four columns on screen under it. The empty
   *     Inbox and Assigned name the orchestrator.
   *   - `?scenario=orchestrator-first-overview` — the quiet Overview of an
   *     install with no seat anywhere, which leads with one band.
   *
   * Every container is measured by ink against #2185's scale: one inset on
   * every side, the heading, the text, the Runs on row, the rules and the
   * footer on the seat head's avatar edge, equal padding above and below, and
   * the band on the columns' own left edge. `LLV_2166_BEFORE=1` records the
   * same readings from a checkout without the change and gates nothing.
   *
   * Readings go to `evidence/orchestrator-first/slice1.json` (or
   * `slice1-before.json`); frames to `LLV_2166_OUT`, outside the repository.
   */
  const BEFORE = process.env.LLV_2166_BEFORE === "1";
  const OUT = path.resolve(process.env.LLV_2166_OUT ?? ".artifacts/orchestrator-first");
  const EVIDENCE = path.resolve("evidence/orchestrator-first");
  const TAG = BEFORE ? "before" : "after";
  const FRAMES = [
    { label: "1440", width: 1440, height: 900, lang: "en" },
    { label: "1280", width: 1280, height: 800, lang: "en" },
    { label: "1280-uk", width: 1280, height: 800, lang: "uk" },
  ] as const;
  const JARGON = ["MCP", "deploy", "APPROVE", "lanes"] as const;

  /* The left edge of what a node draws: its text's first glyph, or its box
     when it holds no text. */
  const readDraft = (page: Page) => page.evaluate(() => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const ink = (node: Element | null) => {
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length) return null;
      return { left: Math.min(...rects.map((rect) => rect.left)), top: Math.min(...rects.map((rect) => rect.top)), right: Math.max(...rects.map((rect) => rect.right)), bottom: Math.max(...rects.map((rect) => rect.bottom)) };
    };
    const seat = document.querySelector<HTMLElement>("[data-kanban-seat]");
    const form = document.querySelector<HTMLElement>('[data-orchestrator-draft="create"]');
    if (!seat || !form) return null;
    const box = seat.getBoundingClientRect();
    const body = form.firstElementChild as HTMLElement;
    const footer = form.lastElementChild as HTMLElement;
    const bodyBox = body.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    const avatar = seat.querySelector(".seat-head .av")?.getBoundingClientRect() ?? null;
    const fold = seat.querySelector(".seat-fold")?.getBoundingClientRect() ?? null;
    const heading = ink(form.querySelector("h2"));
    const intro = ink(form.querySelector("[data-orchestrator-intro]"));
    const example = ink(form.querySelector("[data-orchestrator-example]"));
    const runsOn = form.querySelector<HTMLElement>("[data-orchestrator-runs-on]")?.getBoundingClientRect() ?? null;
    const runsOnLabel = ink(form.querySelector("[data-orchestrator-runs-on] .text-label"));
    const rules = form.querySelector<HTMLElement>("[data-orchestrator-mandate-details]");
    const rulesBox = rules?.getBoundingClientRect() ?? null;
    const confirm = form.querySelector<HTMLElement>("[data-orchestrator-confirm]")?.getBoundingClientRect() ?? null;
    const byHand = ink(form.querySelector("[data-orchestrator-by-hand]"));
    const lastInBody = (body.lastElementChild as HTMLElement | null)?.getBoundingClientRect() ?? null;
    const copy = form.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("textarea").forEach((field) => field.remove());
    const columns = [...document.querySelectorAll<HTMLElement>("[data-kanban-board] section.column")].map((column) => {
      const rect = column.getBoundingClientRect();
      const empty = column.querySelector<HTMLElement>(".empty");
      return { status: column.dataset.status ?? "", top: round(rect.top), left: round(rect.left), emptyBottom: empty ? round(empty.getBoundingClientRect().bottom) : null, empty: empty?.textContent?.trim() ?? "" };
    });
    const clipped = [...form.querySelectorAll<HTMLElement>("h2, p, span, summary, button")]
      .filter((node) => node.offsetParent && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== "visible" && !node.closest("[data-orchestrator-cwd]"))
      .map((node) => node.textContent?.trim().slice(0, 40) ?? "");
    const at = (value: number | undefined | null) => (value == null ? null : round(value - box.left));
    return {
      words: copy.textContent ?? "",
      rulesOpen: rules?.hasAttribute("open") ?? null,
      radios: form.querySelectorAll('[role="radio"]').length,
      runsOnValue: form.querySelector("[data-orchestrator-runs-on-value]")?.textContent ?? null,
      confirmText: form.querySelector("[data-orchestrator-confirm]")?.textContent ?? null,
      seat: { left: round(box.left), width: round(box.width), top: round(box.top), bottom: round(box.bottom) },
      /* From the seat's left border edge. */
      edges: {
        avatar: at(avatar?.left), heading: at(heading?.left), intro: at(intro?.left), example: at(example?.left),
        runsOn: at(runsOn?.left), rules: at(rulesBox?.left), confirm: at(confirm?.left), byHand: at(byHand?.left),
      },
      insets: {
        foldFromRight: fold ? round(box.right - fold.right) : null,
        runsOnLabel: runsOn && runsOnLabel ? round(runsOnLabel.left - runsOn.left) : null,
        bodyTop: heading ? round(heading.top - bodyBox.top) : null,
        bodyBottom: lastInBody ? round(bodyBox.bottom - lastInBody.bottom) : null,
        footerTop: confirm ? round(confirm.top - footerBox.top) : null,
        footerBottom: byHand ? round(footerBox.bottom - byHand.bottom) : null,
        gapHeadingIntro: heading && intro ? round(intro.top - heading.bottom) : null,
        gapRunsOnRules: runsOn && rulesBox ? round(rulesBox.top - runsOn.bottom) : null,
        gapConfirmByHand: confirm && byHand ? round(byHand.top - confirm.bottom) : null,
      },
      draftHeight: round(box.height),
      columns,
      clipped,
      viewportHeight: innerHeight,
      conversationsView: Boolean(document.querySelector("[data-desktop-conversations-scroll]")),
    };
  });

  const readBand = (page: Page) => page.evaluate(() => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const band = document.querySelector<HTMLElement>("[data-overview-orchestrator-band]");
    if (!band) return null;
    const box = band.getBoundingClientRect();
    const range = (node: Element | null) => {
      if (!node) return null;
      const r = document.createRange();
      r.selectNodeContents(node);
      const rects = [...r.getClientRects()].filter((rect) => rect.width > 0);
      return rects.length ? { left: Math.min(...rects.map((rect) => rect.left)), top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)) } : null;
    };
    const picture = (band.firstElementChild as HTMLElement).getBoundingClientRect();
    const title = range(band.querySelector("h2"));
    const text = range(band.querySelector("p"));
    const button = band.querySelector<HTMLElement>("[data-overview-orchestrator-create]")!.getBoundingClientRect();
    const firstColumn = document.querySelector<HTMLElement>("[data-kanban-board] section.column")?.getBoundingClientRect() ?? null;
    const page = band.parentElement!.getBoundingClientRect();
    return {
      band: { left: round(box.left), right: round(box.right), top: round(box.top), height: round(box.height) },
      columnLeft: firstColumn ? round(firstColumn.left) : null,
      /* The page the band and the columns stand in: the band keeps the same
         edge on both sides of it. */
      pageLeft: round(page.left),
      pageRight: round(page.right),
      insets: {
        pictureLeft: round(picture.left - box.left),
        pictureTop: round(picture.top - box.top),
        pictureBottom: round(box.bottom - picture.bottom),
        buttonRight: round(box.right - button.right),
        pictureToText: title ? round(title.left - picture.right) : null,
        titleLeft: title ? round(title.left - box.left) : null,
        textLeft: text ? round(text.left - box.left) : null,
        titleToText: title && text ? round(text.top - title.bottom) : null,
      },
      text: band.textContent ?? "",
      buttonFill: getComputedStyle(band.querySelector("[data-overview-orchestrator-create]")!).backgroundColor,
      overflow: box.right > innerWidth + 1,
    };
  });

  browserTest("#2166 slice 1: the plain draft on a new project's Board and the Overview's band, measured", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "llv-2166-")));
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const readings: Record<string, unknown> = {};
    const near = (a: number | null | undefined, b: number | null | undefined, tolerance = 1) => a != null && b != null && Math.abs(a - b) <= tolerance;
    try {
      for (const frame of FRAMES) {
        const viewport = { width: frame.width, height: frame.height };
        const label = `board-draft-${frame.label}`;
        const opened = await openFixture(browser, `${server.base}?scenario=orchestrator-first`, viewport, "light", frame.lang);
        try {
          await opened.page.waitForSelector('[data-orchestrator-draft="create"]', { state: "visible", timeout: 30_000 });
          await opened.page.waitForTimeout(800);
          const reading = await readDraft(opened.page);
          await opened.page.screenshot({ path: path.join(OUT, `${label}-${TAG}.png`) });
          readings[label] = reading;
          if (!BEFORE) {
            if (!reading) throw new Error("no draft on the seat");
            if (reading.conversationsView) failures.push(`${label}: a project with no view chosen opened on Conversations`);
            if (reading.rulesOpen !== false) failures.push(`${label}: the rules are not folded`);
            if (reading.radios) failures.push(`${label}: the pickers stand open`);
            if (/#\d/.test(reading.words)) failures.push(`${label}: the draft names an issue number`);
            for (const word of JARGON) if (reading.words.includes(word)) failures.push(`${label}: the draft says «${word}»`);
            if (reading.clipped.length) failures.push(`${label}: text cut off: ${JSON.stringify(reading.clipped)}`);
            const { edges, insets } = reading;
            for (const [name, left] of Object.entries(edges)) {
              if (!near(left, edges.avatar)) failures.push(`${label}: ${name} starts at ${left}, the avatar at ${edges.avatar}`);
            }
            if (!near(insets.foldFromRight, edges.avatar)) failures.push(`${label}: Fold ends ${insets.foldFromRight} from the right, the avatar starts ${edges.avatar} from the left`);
            if (!near(insets.footerTop, 12)) failures.push(`${label}: the footer's top padding is ${insets.footerTop}`);
            /* The four columns, and what their empty states say, are on
               screen under the draft (design §3.6: about 330 px of draft). */
            for (const column of reading.columns) {
              if (column.emptyBottom === null || column.emptyBottom > reading.viewportHeight) failures.push(`${label}: the ${column.status} column's empty state ends at ${column.emptyBottom}, off a ${reading.viewportHeight} px window`);
            }
            const inbox = reading.columns.find((column) => column.status === "inbox")?.empty ?? "";
            if (frame.lang === "en" && !inbox.includes("The orchestrator adds a task here for each thing you ask.")) failures.push(`${label}: the empty Inbox reads ${JSON.stringify(inbox)}`);
          }
          if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await opened.context.close();
        }
      }

      for (const frame of FRAMES) {
        const viewport = { width: frame.width, height: frame.height };
        const label = `overview-band-${frame.label}`;
        const opened = await openFixture(browser, `${server.base}?scenario=orchestrator-first-overview`, viewport, "light", frame.lang);
        try {
          await opened.page.waitForSelector("[data-kanban-board] section.column", { state: "attached", timeout: 30_000 });
          if (!BEFORE) await opened.page.waitForSelector("[data-overview-orchestrator-band]", { state: "visible", timeout: 15_000 });
          await opened.page.waitForTimeout(700);
          const reading = await readBand(opened.page);
          await opened.page.screenshot({ path: path.join(OUT, `${label}-${TAG}.png`) });
          readings[label] = reading;
          if (!BEFORE) {
            if (!reading) throw new Error("no band on an install with no seat");
            if (!near(reading.band.left, reading.columnLeft)) failures.push(`${label}: the band starts at ${reading.band.left}, the columns at ${reading.columnLeft}`);
            if (!near(reading.band.left - reading.pageLeft, reading.pageRight - reading.band.right)) failures.push(`${label}: the band's edges differ, ${reading.band.left - reading.pageLeft} left and ${reading.pageRight - reading.band.right} right`);
            const { insets } = reading;
            if (!near(insets.pictureLeft, 12) || !near(insets.buttonRight, 12)) failures.push(`${label}: side insets ${insets.pictureLeft} / ${insets.buttonRight}`);
            if (!near(insets.pictureTop, insets.pictureBottom)) failures.push(`${label}: top ${insets.pictureTop} and bottom ${insets.pictureBottom} differ`);
            if (!near(insets.pictureToText, 12)) failures.push(`${label}: picture to text ${insets.pictureToText}`);
            if (!near(insets.titleLeft, insets.textLeft)) failures.push(`${label}: title at ${insets.titleLeft}, text at ${insets.textLeft}`);
            if (reading.overflow) failures.push(`${label}: the band runs past the window`);
            /* The one filled button: the board's own button reset stays off it. */
            if (/rgba\(0, 0, 0, 0\)|transparent/.test(reading.buttonFill)) failures.push(`${label}: the band's button has no fill`);
          }
          if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await opened.context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, BEFORE ? "slice1-before.json" : "slice1.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length && !BEFORE) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#2166 the interface walk", () => {
  /*
   * Slice 3 of docs/design/orchestrator-first-onboarding.md §6: the real
   * Viewer over `?scenario=orchestrator-first-walk` — a project whose seat was
   * created a moment ago, idle over empty columns — in Chromium at 1440 × 900
   * and 1280 × 800, English, and at 1280 × 800 Ukrainian.
   *
   *   - On an install whose marker never ran the walk it starts by itself on
   *     stop 1, with the seat folded beforehand: the walk expands it.
   *   - Each stop's spotlight covers its anchor inside the window and stays in
   *     the board's pane (its left edge right of the rail); the popover is
   *     wholly on screen.
   *   - The popover keeps #2185's one inset: Skip's label ends as far from the
   *     right edge as the title starts from the left, and the mark, the title,
   *     the body and the progress dots start on one left edge.
   *   - "Give it the first task" focuses the seat's composer and writes
   *     `walk: "done"`; a reload does not start it again.
   *   - `&install=existing` never starts it by itself; the rail menu's
   *     "Interface walk" does, and Skip writes `walk: "skipped"`.
   *
   * Readings go to `evidence/orchestrator-first/slice3.json`; frames to
   * `LLV_2166_OUT`, outside the repository (`walk-before-*` is the same board
   * with no walk showing).
   */
  const OUT = path.resolve(process.env.LLV_2166_OUT ?? ".artifacts/orchestrator-first");
  const EVIDENCE = path.resolve("evidence/orchestrator-first");
  const FRAMES = [
    { label: "1440", width: 1440, height: 900, lang: "en" },
    { label: "1280", width: 1280, height: 800, lang: "en" },
    { label: "1280-uk", width: 1280, height: 800, lang: "uk" },
  ] as const;
  /* The seat folded in this browser before the page loads. */
  const FOLDED = `try { localStorage.setItem("llv:kanban-seat:v2", JSON.stringify({ height: null, collapsed: { atlas: true }, placement: "top", width: null, topWidths: {}, sideWidths: {}, heightV: 2 })); } catch {}`;

  const readStop = (page: Page) => page.evaluate(() => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const box = (node: Element | null | undefined) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom) };
    };
    const ink = (node: Element | null) => {
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length) return null;
      return { left: round(Math.min(...rects.map((rect) => rect.left))), right: round(Math.max(...rects.map((rect) => rect.right))) };
    };
    const pop = document.querySelector<HTMLElement>("[data-walk-popover]");
    if (!pop) return null;
    const stop = Number(pop.dataset.walkPopover);
    const key = stop === 1 ? "seat" : stop === 2 ? "board" : "needs";
    const drawn = [...document.querySelectorAll<HTMLElement>(`[data-walk-anchor="${key}"]`)].find((node) => node.getBoundingClientRect().width > 0) ?? null;
    const composer = stop === 1 ? drawn?.querySelector("[data-orchestrator-conversation] form") ?? null : null;
    const anchor = composer ?? drawn;
    const border = parseFloat(getComputedStyle(pop).borderLeftWidth) || 0;
    const popBox = pop.getBoundingClientRect();
    return {
      stop,
      anchor: box(anchor),
      anchorIsComposer: Boolean(composer),
      spotlight: box(document.querySelector("[data-walk-spotlight]")),
      pane: box(anchor?.closest("[data-kanban-board]")),
      railRight: box(document.querySelector("[data-rail-menu]")?.closest("aside"))?.right ?? null,
      popover: box(pop),
      viewport: { width: innerWidth, height: innerHeight },
      /* From the popover's inner (padding) edges. */
      insets: {
        mark: round(pop.querySelector("[data-walk-mark]")!.getBoundingClientRect().left - popBox.left - border),
        title: (() => { const value = ink(pop.querySelector("[data-walk-title]")); return value ? round(value.left - popBox.left - border) : null; })(),
        body: (() => { const value = ink(pop.querySelector("[data-walk-body]")); return value ? round(value.left - popBox.left - border) : null; })(),
        dots: round(pop.querySelector("[data-walk-dots]")!.getBoundingClientRect().left - popBox.left - border),
        skipFromRight: (() => { const value = ink(pop.querySelector("[data-walk-skip-label]")); return value ? round(popBox.right - border - value.right) : null; })(),
        primaryFromRight: round(popBox.right - border - pop.querySelector("[data-walk-primary]")!.getBoundingClientRect().right),
      },
      seatCollapsed: document.querySelector("[data-kanban-seat]")?.getAttribute("data-collapsed") ?? null,
      focused: document.activeElement?.hasAttribute("data-walk-primary") ?? false,
      text: pop.innerText,
    };
  });
  type StopReading = NonNullable<Awaited<ReturnType<typeof readStop>>>;

  const gate = (label: string, reading: StopReading, failures: string[]) => {
    const near = (a: number | null, b: number | null, tolerance = 1) => a != null && b != null && Math.abs(a - b) <= tolerance;
    const { anchor, spotlight, pane, popover, viewport, insets } = reading;
    if (!anchor) failures.push(`${label}: no anchor drawn`);
    if (!spotlight) failures.push(`${label}: no spotlight`);
    if (anchor && spotlight) {
      /* The anchor's visible part: inside the window and its pane. */
      const seen = {
        left: Math.max(anchor.left, 0, pane?.left ?? 0), top: Math.max(anchor.top, 0, pane?.top ?? 0),
        right: Math.min(anchor.right, viewport.width, pane?.right ?? viewport.width), bottom: Math.min(anchor.bottom, viewport.height, pane?.bottom ?? viewport.height),
      };
      if (spotlight.left > seen.left + 0.5 || spotlight.top > seen.top + 0.5 || spotlight.right < seen.right - 0.5 || spotlight.bottom < seen.bottom - 0.5) {
        failures.push(`${label}: the spotlight ${JSON.stringify(spotlight)} does not cover the anchor ${JSON.stringify(seen)}`);
      }
      if (pane && (spotlight.left < pane.left - 0.5 || spotlight.right > pane.right + 0.5 || spotlight.top < pane.top - 0.5 || spotlight.bottom > pane.bottom + 0.5)) {
        failures.push(`${label}: the spotlight ${JSON.stringify(spotlight)} leaves its pane ${JSON.stringify(pane)}`);
      }
      if (reading.railRight != null && spotlight.left < reading.railRight - 0.5) failures.push(`${label}: the spotlight starts at ${spotlight.left}, over the rail ending at ${reading.railRight}`);
    }
    if (!popover || popover.left < 0 || popover.top < 0 || popover.right > viewport.width || popover.bottom > viewport.height) {
      failures.push(`${label}: the popover ${JSON.stringify(popover)} leaves the ${viewport.width} × ${viewport.height} window`);
    }
    for (const [name, left] of [["title", insets.title], ["body", insets.body], ["dots", insets.dots]] as const) {
      if (!near(left, insets.mark)) failures.push(`${label}: ${name} starts at ${left}, the mark at ${insets.mark}`);
    }
    if (!near(insets.skipFromRight, insets.title)) failures.push(`${label}: Skip ends ${insets.skipFromRight} from the right, the title starts ${insets.title} from the left`);
    if (!near(insets.primaryFromRight, insets.title)) failures.push(`${label}: the button ends ${insets.primaryFromRight} from the right, the title starts ${insets.title} from the left`);
    if (reading.stop === 1 && !reading.anchorIsComposer) failures.push(`${label}: stop 1 does not point at the seat's composer`);
  };

  browserTest("#2166 slice 3: the walk's three stops, measured, and when it starts", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "llv-2166-walk-")));
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const readings: Record<string, unknown> = {};
    const writes = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("evidence-walk-writes") ?? "[]") as unknown[]);
    try {
      for (const frame of FRAMES) {
        const viewport = { width: frame.width, height: frame.height };
        const opened = await openFixture(browser, "about:blank", viewport, "light", frame.lang);
        const { page } = opened;
        try {
          await opened.context.addInitScript(FOLDED);
          await page.goto(`${server.base}?scenario=orchestrator-first-walk#p=atlas`);
          /* By itself, on the seat turning live. */
          await page.waitForSelector('[data-walk-popover="1"]', { state: "visible", timeout: 30_000 });
          for (const stop of [1, 2, 3] as const) {
            const label = `walk-${stop}-${frame.label}`;
            await page.waitForSelector(`[data-walk-popover="${stop}"]`, { state: "visible", timeout: 10_000 });
            await page.waitForTimeout(700);
            const reading = await readStop(page);
            await page.screenshot({ path: path.join(OUT, `${label}-after.png`) });
            readings[label] = reading;
            if (!reading) { failures.push(`${label}: no popover`); break; }
            gate(label, reading, failures);
            if (stop === 1 && reading.seatCollapsed !== "0") failures.push(`${label}: the folded seat was not expanded`);
            if (!reading.focused) failures.push(`${label}: focus is not in the popover`);
            if (stop < 3) await page.locator("[data-walk-primary]").click();
          }
          /* The last button: the seat's composer, and the marker says done. */
          await page.locator("[data-walk-primary]").click();
          await page.waitForSelector("[data-walk-popover]", { state: "detached", timeout: 5_000 });
          const composerFocused = await page.evaluate(() => Boolean(document.activeElement?.matches("[data-kanban-seat] [data-orchestrator-conversation] textarea")));
          if (!composerFocused) failures.push(`walk-${frame.label}: "Give it the first task" left focus on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "nothing")}`);
          const written = await writes(page);
          if (JSON.stringify(written) !== JSON.stringify([{ walk: "done" }])) failures.push(`walk-${frame.label}: wrote ${JSON.stringify(written)}`);
          /* A reload: the marker says done, and the live seat starts nothing. */
          await page.reload();
          await page.waitForSelector("[data-kanban-seat]", { state: "visible", timeout: 30_000 });
          await page.waitForTimeout(3_000);
          if (await page.locator("[data-walk-popover]").count()) failures.push(`walk-${frame.label}: the walk started again after a reload`);
          await page.screenshot({ path: path.join(OUT, `walk-before-${frame.label}.png`) });
          if (opened.pageErrors.length) failures.push(`walk-${frame.label}: page errors ${opened.pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`walk-${frame.label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await opened.context.close();
        }
      }

      /* An upgraded install: nothing by itself; the rail menu's row starts it, and Skip writes skipped. */
      for (const frame of FRAMES.slice(0, 2)) {
        const viewport = { width: frame.width, height: frame.height };
        const label = `menu-walk-${frame.label}`;
        const opened = await openFixture(browser, `${server.base}?scenario=orchestrator-first-walk&install=existing#p=atlas`, viewport, "light", frame.lang);
        const { page } = opened;
        try {
          await page.waitForSelector("[data-kanban-seat]", { state: "visible", timeout: 30_000 });
          await page.waitForTimeout(3_000);
          if (await page.locator("[data-walk-popover]").count()) failures.push(`${label}: an existing install started the walk by itself`);
          await page.locator("[data-rail-menu]").click();
          await page.waitForSelector("[data-rail-menu-interface-walk]", { state: "visible", timeout: 5_000 });
          const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-rail-menu-panel] button")].map((row) => row.innerText.trim()));
          const guide = rows.indexOf("Setup guide");
          if (guide < 0 || rows[guide + 1] !== "Interface walk" || rows[guide + 2] !== "Agent mapping") failures.push(`${label}: the menu reads ${JSON.stringify(rows)}`);
          await page.screenshot({ path: path.join(OUT, `${label}-after.png`) });
          await page.locator("[data-rail-menu-interface-walk]").click();
          await page.waitForSelector('[data-walk-popover="1"]', { state: "visible", timeout: 10_000 });
          await page.locator("[data-walk-primary]").click();
          await page.locator("[data-walk-skip]").click();
          await page.waitForSelector("[data-walk-popover]", { state: "detached", timeout: 5_000 });
          const written = await writes(page);
          readings[label] = { rows, written };
          if (JSON.stringify(written) !== JSON.stringify([{ walk: "skipped" }])) failures.push(`${label}: Skip wrote ${JSON.stringify(written)}`);
          if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await opened.context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "slice3.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});

describe("#2146 the orchestrator's report log beside its chat, and the Bridge reports switch", () => {
  /*
   * On the desktop board at 1440, en and uk, light and dark: the seat's report
   * log is a column right of its chat — this project's bridge reports, newest
   * first, each a local time, a class word and the body as written, `#123` and
   * the board's card ids linked, a quiet «new» on what arrived since the last
   * look, and «Show older» under the page. Nothing else is in it. The board's
   * ⋯ carries "Bridge reports" on and then off by its own switch, and off, the
   * log is one line with the switch that turns it back on. The empty log is
   * one line too. The phone at 390 is the phone driver's case.
   *
   *   CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 REPORT_LOG_PNG_DIR=… \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "#2146"
   *
   * PNGs go to `REPORT_LOG_PNG_DIR`, or `.artifacts/report-log/`, never committed.
   */
  const OUT = path.resolve(process.env.REPORT_LOG_PNG_DIR ?? ".artifacts/report-log");
  const EVIDENCE = path.resolve("evidence/orchestrator-report-log");
  const READ_LOG = () => {
    const log = document.querySelector("[data-report-log]");
    const conversation = document.querySelector("[data-kanban-seat] [data-orchestrator-conversation]");
    if (!log) return null;
    const scroller = log.querySelector(".overflow-y-auto") as HTMLElement | null;
    const rows = [...log.querySelectorAll("[data-report-entry]")];
    const cut = [...log.querySelectorAll<HTMLElement>("[data-report-entry] *")].filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible").map((element) => element.textContent?.slice(0, 40) ?? "");
    const logBox = log.getBoundingClientRect();
    const conversationBox = conversation?.getBoundingClientRect() ?? null;
    return {
      layout: document.querySelector("[data-report-log-layout]")?.getAttribute("data-report-log-layout") ?? null,
      beside: conversationBox ? logBox.left >= conversationBox.right - 1 : false,
      width: Math.round(logBox.width),
      entries: rows.length,
      classes: [...new Set(rows.map((row) => row.getAttribute("data-report-class")))],
      labels: [...new Set(rows.map((row) => row.querySelector("[data-report-class-label]")?.textContent ?? ""))],
      fresh: rows.filter((row) => row.hasAttribute("data-report-new")).map((row) => row.getAttribute("data-report-entry")),
      github: log.querySelectorAll("[data-report-link=github]").length,
      cards: log.querySelectorAll("[data-report-link=card]").length,
      older: Boolean(log.querySelector("[data-report-log-older]")),
      sideways: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
      cut,
      /* The panel holds entries and nothing else. */
      extra: [...log.querySelectorAll("section > div > *")].map((element) => element.tagName.toLowerCase()).filter((tag) => tag !== "ol" && tag !== "div"),
      off: log.querySelector("[data-report-log-off] p")?.textContent ?? null,
      offSwitch: log.querySelector("[data-report-log-off] [data-bridge-reports-switch]")?.getAttribute("aria-checked") ?? null,
      empty: log.querySelector("[data-report-log-empty]")?.textContent ?? null,
    };
  };

  browserTest("the log sits right of the seat's chat at 1440, en and uk, light and dark, and the ⋯ switch turns it off and on", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(path.resolve(".artifacts/report-log-bundle"));
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      for (const lang of ["en", "uk"] as const) {
        for (const scheme of ["light", "dark"] as const) {
          const label = `1440-${lang}-${scheme}`;
          const t = (key: string, params?: Record<string, string | number>) => translate(lang, key as never, params);
          const fail = (text: string) => failures.push(`${label}: ${text}`);
          const { context, page, pageErrors } = await openFixture(browser, server.base, VIEWPORT, scheme, lang);
          try {
            await page.waitForSelector("[data-report-log] [data-report-entry]", { timeout: 30_000 });
            /* The operator last looked three reports ago. */
            await page.evaluate(() => {
              const newest = Number(document.querySelector("[data-report-entry]")!.getAttribute("data-report-entry"));
              const third = [...document.querySelectorAll("[data-report-entry]")][3]!.getAttribute("data-report-entry");
              localStorage.setItem("llvReportLogSeen:atlas", String(third ?? newest));
            });
            await page.reload();
            await page.waitForSelector("[data-report-log] [data-report-entry]", { timeout: 30_000 });
            /* The fixture's attention toast sits over the seat's head, where
               the log's toggle is. */
            await page.waitForTimeout(600);
            await page.locator("[data-attention-toast-dismiss]").click().catch(() => {});
            await page.mouse.move(0, 0);
            await page.waitForTimeout(800);
            const toggle = await page.evaluate(() => document.querySelector("[data-kanban-seat] [data-report-log-toggle]")?.getAttribute("data-report-log-toggle") ?? null);
            if (toggle !== "open") fail(`the head's report log toggle reads ${toggle}`);
            const seat = page.locator("[data-kanban-seat]");
            await seat.screenshot({ path: path.join(OUT, `seat-${label}.png`) });
            await page.screenshot({ path: path.join(OUT, `board-${label}.png`) });
            const reading = await page.evaluate(READ_LOG);
            if (!reading) { fail("no report log"); continue; }
            if (reading.layout !== "beside" || !reading.beside) fail(`the log is not beside the chat: ${JSON.stringify(reading)}`);
            if (reading.entries !== 30) fail(`first page holds ${reading.entries} entries`);
            if (reading.classes.length !== 6) fail(`classes drawn: ${reading.classes.join(", ")}`);
            for (const word of ["completed", "failed", "blocked", "question", "review_verdict", "status"]) {
              if (!reading.labels.includes(t(`reportLog.class.${word}`))) fail(`no ${word} label`);
            }
            if (reading.fresh.length !== 3) fail(`new marks on ${JSON.stringify(reading.fresh)}`);
            if (!reading.github || !reading.cards) fail(`links: ${reading.github} GitHub, ${reading.cards} cards`);
            if (!reading.older) fail("no Show older under the first page");
            if (reading.sideways > 0 || reading.cut.length) fail(`cut: ${reading.sideways}px sideways, ${JSON.stringify(reading.cut)}`);
            if (reading.extra.length) fail(`something else in the panel: ${reading.extra.join(", ")}`);

            /* Older entries on request, drawn at the bottom of the column. */
            await page.locator("[data-report-log-older]").click();
            await page.waitForFunction(() => document.querySelectorAll("[data-report-entry]").length > 30, undefined, { timeout: 10_000 });
            await page.evaluate(() => {
              const scroller = document.querySelector("[data-report-log] .overflow-y-auto")!;
              scroller.scrollTop = scroller.scrollHeight;
            });
            await page.waitForTimeout(300);
            await page.locator("[data-report-log]").screenshot({ path: path.join(OUT, `log-older-${label}.png`) });
            const older = await page.evaluate(READ_LOG);
            if (older?.entries !== 46 || older.older) fail(`after Show older: ${older?.entries} entries, older control ${older?.older}`);

            /* The ⋯ menu: the Bridge reports row on, then off by its switch. */
            await page.locator('[data-bar-group="more"] button').first().click();
            await page.locator("[data-bridge-reports]").waitFor({ timeout: 10_000 });
            await page.waitForFunction(() => [...document.querySelectorAll("[data-bar-menu-group] [role=switch]")].every((toggle) => !toggle.hasAttribute("disabled")), undefined, { timeout: 10_000 });
            const menuBox = page.locator('[data-bar-menu-group="project"]').locator("xpath=..");
            await page.waitForTimeout(400);
            await menuBox.screenshot({ path: path.join(OUT, `menu-bridge-on-${label}.png`) });
            const readRow = () => page.evaluate(() => {
              const element = document.querySelector("[data-bar-menu-group] [data-bridge-reports]")!;
              const toggle = element.querySelector<HTMLElement>("[data-bridge-reports-switch]")!;
              const name = element.querySelector("span.flex-1")!;
              const hint = element.querySelector('[role="status"]')!;
              const a = name.getBoundingClientRect();
              const b = toggle.getBoundingClientRect();
              const menu = element.closest("[data-bar-menu-group]")!.getBoundingClientRect();
              return {
                state: element.getAttribute("data-bridge-reports"), checked: toggle.getAttribute("aria-checked"),
                label: name.textContent?.trim() ?? "", hint: hint.textContent?.trim() ?? "",
                labelMeetsSwitch: Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5,
                labelCut: name.scrollWidth > name.clientWidth + 1,
                inside: hint.getBoundingClientRect().right <= menu.right + 1 && b.right <= menu.right + 1,
              };
            });
            const on = await readRow();
            if (on.state !== "on" || on.checked !== "true" || on.label !== t("projectSettings.bridgeReports") || on.hint !== t("projectSettings.bridgeReports.on")) fail(`menu on ${JSON.stringify(on)}`);
            await page.locator("[data-bar-menu-group] [data-bridge-reports-switch]").click();
            await page.waitForFunction(() => document.querySelector("[data-bar-menu-group] [data-bridge-reports]")?.getAttribute("data-bridge-reports") === "off", undefined, { timeout: 10_000 });
            await page.waitForTimeout(300);
            await menuBox.screenshot({ path: path.join(OUT, `menu-bridge-off-${label}.png`) });
            const off = await readRow();
            if (off.hint !== t("projectSettings.bridgeReports.off")) fail(`menu off ${JSON.stringify(off)}`);
            for (const entry of [on, off]) if (entry.labelMeetsSwitch || entry.labelCut || !entry.inside) fail(`menu geometry ${JSON.stringify(entry)}`);
            await page.keyboard.press("Escape");
            if (await page.locator("[data-bar-menu-group]").count()) await page.locator('[data-bar-group="more"] button').first().click();
            await page.waitForFunction(() => !document.querySelector("[data-bar-menu-group]"), undefined, { timeout: 10_000 });
            await page.mouse.move(0, 0);
            await page.waitForTimeout(300);

            /* Off: the log is one line and the switch. */
            await page.waitForSelector("[data-report-log-off]", { timeout: 10_000 });
            await seat.screenshot({ path: path.join(OUT, `seat-off-${label}.png`) });
            const offLog = await page.evaluate(READ_LOG);
            if (offLog?.off !== t("reportLog.off") || offLog.offSwitch !== "false" || offLog.entries !== 0) fail(`off panel ${JSON.stringify(offLog)}`);
            const writes = await page.evaluate(() => (window as unknown as { evidence?: { settingWrites: unknown[] } }).evidence?.settingWrites ?? null);
            if (!JSON.stringify(writes).includes('"bridgeReports":false')) fail(`the switch wrote ${JSON.stringify(writes)}`);
            /* The panel's own switch turns them back on. */
            await page.locator("[data-report-log-off] [data-bridge-reports-switch]").click();
            await page.waitForSelector("[data-report-log] [data-report-entry]", { timeout: 10_000 });
            readings[label] = { reading, older: { entries: older?.entries }, menu: { on, off }, offLog, writes };
            const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (sideways > 0) fail(`the page scrolls sideways by ${sideways}px`);
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
      /* The empty log, one line. */
      const { context, page } = await openFixture(browser, `${server.base}?reports=empty`, VIEWPORT, "light", "en");
      try {
        await page.waitForSelector("[data-report-log-empty]", { timeout: 30_000 });
        await page.waitForTimeout(500);
        await page.locator("[data-kanban-seat]").screenshot({ path: path.join(OUT, "seat-empty-1440-en-light.png") });
        const empty = await page.evaluate(READ_LOG);
        if (empty?.empty !== translate("en", "reportLog.empty")) failures.push(`empty: ${JSON.stringify(empty)}`);
        readings.empty = empty;
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "desktop.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 900_000);
});

describe("the report log opens beside the seat's chat only where the chat keeps its width", () => {
  /*
   * The seat's report log (#2146) opened beside the chat from a 720 px seat as
   * a 300 px column, leaving the chat 420 px. It now opens only where the chat
   * keeps REPORT_LOG_CHAT_MIN_WIDTH (1.5 times that) beside a column of at
   * least REPORT_LOG_MIN_WIDTH; narrower, it stays closed until the header
   * toggle shows it in the transcript's place. At 1280, 1440, 1728 and 1920,
   * the seat at its default width and widened across the board, en and uk,
   * over the fixture's reports and a long draft in the composer; and a seat
   * dragged to 900 px at 1440, where the log used to open and no longer does.
   *
   *   CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
   *     REPORT_PANEL_STAMP=after REPORT_PANEL_PNG_DIR=… \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "keeps its width"
   *
   * `REPORT_PANEL_STAMP=before` draws the same frames over a checkout without
   * the change and gates nothing. PNGs go to `REPORT_PANEL_PNG_DIR`, or
   * `.artifacts/report-panel-width/`, never committed.
   */
  const STAMP = process.env.REPORT_PANEL_STAMP === "before" ? "before" : "after";
  const OUT = path.resolve(process.env.REPORT_PANEL_PNG_DIR ?? ".artifacts/report-panel-width");
  const EVIDENCE = path.resolve("evidence/orchestrator-report-log");
  const SEAT = "[data-kanban-seat]";
  const DRAFTS = {
    en: "Before the release goes out tonight, take the search lane off review and merge it once the checks are green, then rebuild the candidate and run verify-candidate against it. If the runtime host fails to take the fence again, do not retry more than once: file an issue with the host log attached and leave production on the current build. Also move the favicon lane behind the upload one, and tell me in one line what is still waiting on me when you are done.\n\nOne more thing about the reports: write them more often, especially while I am away, so that when I come back I can read what happened without asking. Keep each one short but say what changed, what it cost and what is waiting on me, in the language the interface is set to. If a lane has been quiet for an hour, say so and say why, even if nothing is wrong.",
    uk: "Перед сьогоднішнім релізом зніміть лінію пошуку з рев'ю і змерджте її, щойно перевірки стануть зеленими, потім перезберіть кандидата і проженіть verify-candidate. Якщо runtime host знову не візьме fence, повторіть лише один раз: заведіть issue з логом хоста і залиште продакшн на поточній збірці. Також поставте лінію фавікона за лінією завантаження і напишіть одним рядком, що ще чекає на мене, коли закінчите.\n\nІ ще про звіти: пишіть їх частіше, особливо поки мене немає, щоб, повернувшись, я міг прочитати, що сталося, нічого не питаючи. Кожен звіт короткий, але в ньому сказано, що змінилося, чого це коштувало і що чекає на мене, мовою, вибраною в інтерфейсі. Якщо лінія мовчить понад годину, скажіть про це і чому, навіть коли все гаразд.",
  } as const;
  const seatRecord = (topWidth: number | null) => `try { localStorage.setItem("llv:kanban-seat:v2", ${JSON.stringify(JSON.stringify({
    height: null, collapsed: {}, placement: "top", width: null, topWidths: topWidth === null ? {} : { atlas: topWidth }, sideWidths: {}, heightV: 2,
  }))}); } catch {}`;
  const READ = () => {
    const box = (element: Element | null | undefined) => (element ? Math.round(element.getBoundingClientRect().width) : null);
    const seat = document.querySelector("[data-kanban-seat]");
    const log = seat?.querySelector("[data-report-log]") ?? null;
    const layout = seat?.querySelector("[data-report-log-layout]")?.getAttribute("data-report-log-layout") ?? null;
    return {
      seat: box(seat),
      panel: box(seat?.querySelector("[data-orchestrator-panel]")),
      layout,
      conversation: box(seat?.querySelector("[data-orchestrator-conversation]")),
      log: box(log),
      /* Beside the chat, the log's column, its left border included. */
      column: layout === "beside" ? box(log?.parentElement) : null,
      toggle: seat?.querySelector("[data-report-log-toggle]")?.getAttribute("data-report-log-toggle") ?? null,
      entries: log?.querySelectorAll("[data-report-entry]").length ?? 0,
      draft: (seat?.querySelector("[data-orchestrator-conversation] textarea") as HTMLTextAreaElement | null)?.value.length ?? 0,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  };

  browserTest("the log opens beside the chat only where the chat keeps 1.5 times its old minimum, and the toggle shows it narrower", async () => {
    const dir = path.join(OUT, STAMP);
    fs.mkdirSync(dir, { recursive: true });
    const server = await serveEvidenceFixture(path.resolve(".artifacts/report-panel-width-bundle"));
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    const frames: Array<{ width: number; seat: "normal" | "maximised" | "dragged-900"; topWidth: number | null }> = [
      ...[1280, 1440, 1728, 1920].flatMap((width) => [
        { width, seat: "normal" as const, topWidth: null },
        { width, seat: "maximised" as const, topWidth: 4_000 },
      ]),
      { width: 1440, seat: "dragged-900", topWidth: 900 },
    ];
    try {
      for (const frame of frames) {
        for (const lang of ["en", "uk"] as const) {
          const label = `${frame.width}-${frame.seat}-${lang}`;
          const fail = (text: string) => failures.push(`${label}: ${text}`);
          const { context, page, pageErrors } = await openFixture(browser, "about:blank", { width: frame.width, height: 900 }, "light", lang);
          try {
            await context.addInitScript(seatRecord(frame.topWidth));
            await page.goto(server.base);
            await page.waitForSelector(`${SEAT} [data-orchestrator-conversation] textarea`, { timeout: 30_000 });
            await page.waitForSelector(`${SEAT} [data-report-log-toggle]`, { timeout: 30_000 });
            await page.waitForTimeout(600);
            await page.locator("[data-attention-toast-dismiss]").click().catch(() => {});
            await page.locator(`${SEAT} [data-orchestrator-conversation] textarea`).fill(DRAFTS[lang]);
            await page.mouse.move(0, 0);
            await page.waitForTimeout(800);
            const opened = await page.evaluate(READ);
            await page.locator(SEAT).screenshot({ path: path.join(dir, `${label}.png`) });
            const reading: Record<string, unknown> = { opened };
            if (opened.draft !== DRAFTS[lang].length) fail(`the composer holds ${opened.draft} characters of the draft`);
            if (opened.sideways > 0) fail(`the page scrolls sideways by ${opened.sideways}px`);
            const wide = (opened.panel ?? 0) >= REPORT_LOG_SPLIT_WIDTH;
            if (STAMP === "after") {
              if (wide) {
                if (opened.layout !== "beside" || opened.toggle !== "open") fail(`a ${opened.panel}px seat did not open the log beside the chat: ${JSON.stringify(opened)}`);
                if ((opened.conversation ?? 0) < REPORT_LOG_CHAT_MIN_WIDTH) fail(`the chat beside the log is ${opened.conversation}px`);
                if ((opened.column ?? 0) < REPORT_LOG_MIN_WIDTH || (opened.column ?? 0) > REPORT_LOG_MAX_WIDTH) fail(`the log column is ${opened.column}px`);
              } else if (opened.layout !== null || opened.log !== null || opened.toggle !== "closed") {
                fail(`a ${opened.panel}px seat opened the log by itself: ${JSON.stringify(opened)}`);
              }
            }
            if (!wide || STAMP === "before") {
              /* The header toggle: beside where it fits, in the transcript's place where it does not. */
              if (opened.toggle === "closed") {
                await page.locator(`${SEAT} [data-report-log-toggle]`).click();
                await page.waitForSelector(`${SEAT} [data-report-log] [data-report-entry]`, { timeout: 10_000 });
                await page.mouse.move(0, 0);
                await page.waitForTimeout(400);
                const toggled = await page.evaluate(READ);
                reading.toggled = toggled;
                await page.locator(SEAT).screenshot({ path: path.join(dir, `${label}-toggled.png`) });
                if (STAMP === "after" && (toggled.layout !== null || toggled.log === null || toggled.toggle !== "open")) fail(`the toggle did not show the log in place: ${JSON.stringify(toggled)}`);
              }
            }
            readings[label] = reading;
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    if (STAMP === "after") {
      fs.mkdirSync(EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(EVIDENCE, "width.json"), `${JSON.stringify({ rule: { chatMin: REPORT_LOG_CHAT_MIN_WIDTH, logMin: REPORT_LOG_MIN_WIDTH, logMax: REPORT_LOG_MAX_WIDTH, split: REPORT_LOG_SPLIT_WIDTH }, readings, failures }, null, 2)}\n`);
    } else {
      fs.writeFileSync(path.join(dir, "readings.json"), `${JSON.stringify({ readings }, null, 2)}\n`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  }, 900_000);
});

describe("the board scrolls on the compositor at a device pixel ratio of 1", () => {
  /*
   * At a device pixel ratio under 1.5 Chromium keeps a scroller with no
   * opaque background of its own on the main thread, to keep LCD text in it.
   * On the live board that meant every scroll frame waited for a repaint and a
   * re-layerize of the whole page: the content moved on about half of the
   * frames, and a catalog update landing mid-scroll stopped it. The board's
   * scrollers are promoted in kanbanBoard.css; this case scrolls each one that
   * overflows, the page and the columns, down and back, under a trace, and
   * requires every scroll frame the compositor reports to be one it scrolled
   * itself (`SCROLL_COMPOSITOR_THREAD`), never `SCROLL_MAIN_THREAD`.
   *
   *   CHROME_BIN=google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "compositor"
   */
  browserTest("the page and every overflowing column scroll without the main thread", async () => {
    const server = await serveEvidenceFixture(path.resolve(".artifacts/board-scroll-bundle"));
    const browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    try {
      /* Short enough that the columns overflow as well as the page. */
      const { context, page, pageErrors } = await openFixture(browser, server.base, { width: 1440, height: 640 }, "light", "en");
      try {
        await page.waitForSelector("[data-kanban-board] .card[data-id]", { timeout: 30_000 });
        await page.waitForTimeout(800);
        const scrollers = await page.evaluate(() => {
          const targets = [document.querySelector<HTMLElement>(".kb .kb-page"), ...document.querySelectorAll<HTMLElement>(".kb .col-body")];
          return targets.flatMap((element, index) => {
            if (!element || element.scrollHeight - element.clientHeight < 40) return [];
            element.dataset.scrollProbe = String(index);
            return [{ probe: String(index), name: element.classList.contains("kb-page") ? "page" : `column ${element.closest<HTMLElement>(".column")?.dataset.status}`, distance: element.scrollHeight - element.clientHeight }];
          });
        });
        if (!scrollers.some((scroller) => scroller.name === "page")) failures.push("the page does not overflow");
        if (!scrollers.some((scroller) => scroller.name.startsWith("column"))) failures.push(`no column overflows: ${JSON.stringify(scrollers)}`);
        const input = await context.newCDPSession(page);
        const tracing = await browser.newBrowserCDPSession();
        for (const scroller of scrollers) {
          /* A point whose nearest scroller is this one, so the wheel lands on it. */
          const at = await page.evaluate((probe) => {
            const target = document.querySelector<HTMLElement>(`[data-scroll-probe="${probe}"]`)!;
            target.scrollTop = 0;
            target.scrollIntoView({ block: "nearest" });
            const box = target.getBoundingClientRect();
            const owner = (element: Element | null) => {
              for (let node = element; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
              }
              return null;
            };
            for (let y = Math.max(box.top, 0) + 8; y < Math.min(box.bottom, innerHeight) - 8; y += 17) {
              for (let x = Math.max(box.left, 0) + 8; x < Math.min(box.right, innerWidth) - 8; x += 29) {
                if (owner(document.elementFromPoint(x, y)) === target) return { x: Math.round(x), y: Math.round(y) };
              }
            }
            return null;
          }, scroller.probe);
          if (!at) { failures.push(`${scroller.name}: no point on screen scrolls it`); continue; }
          const events: Array<{ name: string; ph: string; pid: number; tid: number; args?: { name?: string; frame_reporter?: { state?: string; scroll_state?: string } } }> = [];
          const collect = (event: { value: unknown[] }) => { events.push(...(event.value as typeof events)); };
          tracing.on("Tracing.dataCollected", collect);
          const complete = new Promise<void>((resolve) => tracing.once("Tracing.tracingComplete", () => resolve()));
          await tracing.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["cc", "benchmark", "disabled-by-default-devtools.timeline.frame", "__metadata"] } } as never);
          for (const down of [true, false]) {
            await input.send("Input.synthesizeScrollGesture", { x: at.x, y: at.y, yDistance: down ? -scroller.distance : scroller.distance, speed: 1200, gestureSourceType: "mouse", preventFling: true });
          }
          await tracing.send("Tracing.end");
          await complete;
          tracing.off("Tracing.dataCollected", collect);
          const moved = await page.evaluate((probe) => document.querySelector<HTMLElement>(`[data-scroll-probe="${probe}"]`)!.scrollTop, scroller.probe);
          const compositor = new Set(events.filter((event) => event.ph === "M" && event.name === "thread_name" && event.args?.name === "Compositor").map((event) => `${event.pid}:${event.tid}`));
          const states = new Map<string, number>();
          for (const event of events) {
            const frame = event.args?.frame_reporter;
            if (event.name !== "PipelineReporter" || event.ph !== "b" || !compositor.has(`${event.pid}:${event.tid}`) || !frame?.scroll_state || frame.scroll_state === "SCROLL_NONE") continue;
            states.set(frame.scroll_state, (states.get(frame.scroll_state) ?? 0) + 1);
          }
          const reading = Object.fromEntries(states);
          if (!states.size) failures.push(`${scroller.name}: no scroll frames were traced (scrollTop ${moved})`);
          if (states.has("SCROLL_MAIN_THREAD")) failures.push(`${scroller.name}: scrolled on the main thread ${JSON.stringify(reading)}`);
        }
        if (pageErrors.length) failures.push(`page errors ${pageErrors.join(" | ")}`);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      server.stop();
    }
    if (failures.length) throw new Error(failures.join("\n"));
  }, 300_000);
});

describe("a column widens itself: the agent focused from the rail, the mouse resting on it", () => {
  /*
   * The `stages` scenario at 1440×900 with five of its conversations open,
   * one of them on an Inbox card, beside the Viewer's sidebar (the board
   * scrolls its columns) and with the sidebar put away (the columns share a
   * grid). The mouse comes to rest over a card in the rightmost narrow shelf
   * the window shows whole: the frames are that column mid-countdown, with its
   * cue, and the board after the dwell, with the column holding the wide
   * share; in both schemes, and under reduced motion. A fresh board then takes
   * the rail's segment for the Inbox agent: the frame is Inbox widened with
   * the reader focused in it. What is gated: the cue shows before the
   * threshold and sweeps (still under reduced motion), and both the dwell and
   * the rail leave every column exactly as wide as a press of the same
   * column's Widen button does on a fresh board. Frames and readings go to
   * COLUMN_AUTOEXPAND_PNG_DIR.
   *
   *   CHROME_BIN=/usr/bin/google-chrome-stable LLV_KANBAN_BROWSER_TEST=1 \
   *     bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "widens itself"
   */
  const OPEN = ["search-ver-2", "rounds-review", "pending-worker", "upload-plan", "export-impl"] as const;
  const SHELF_AGENT = "conversation_pending-worker";
  const seedReaders = `try { localStorage.setItem("llv:kanban-readers:v1:atlas", ${JSON.stringify(JSON.stringify(OPEN.map((id) => ({ key: `conversation_${id}`, path: `/repo/${id}.jsonl`, folded: false }))))}); } catch {}`;
  const readColumns = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-kanban-board] .column[data-status]")].map((column) => {
    const head = column.querySelector(".col-head");
    const sweep = head ? getComputedStyle(head, "::after") : null;
    return [column.dataset.status!, {
      width: Math.round(column.getBoundingClientRect().width),
      wide: column.dataset.wide === "1",
      cue: column.hasAttribute("data-dwell"),
      sweep: sweep && sweep.content !== "none" ? sweep.animationName : null,
      frame: getComputedStyle(column).borderTopColor,
    }];
  })));

  browserTest("the cue mid-countdown, the widened column and the rail's agent, at 1440×900", async () => {
    const pngDir = process.env.COLUMN_AUTOEXPAND_PNG_DIR ?? "/var/tmp/llv-column-autoexpand";
    const out = path.resolve(".artifacts/column-autoexpand");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(out);
    const browser = await chromium.launch(LAUNCH);
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    const open = async (sidebar: boolean, scheme: Scheme, motion: "no-preference" | "reduce" = "no-preference") => {
      const opened = await openFixture(browser, `${server.base}?scenario=stages`, VIEWPORT, scheme, "en", motion);
      await opened.context.addInitScript(seedReaders);
      await opened.page.reload();
      await opened.page.waitForSelector("[data-open-rail]", { timeout: 30_000 });
      await opened.page.waitForFunction((count) => document.querySelectorAll("[data-kanban-reader]").length >= count, OPEN.length, { timeout: 30_000 });
      if (!sidebar) await opened.page.click("[data-rail-hide]");
      await opened.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      if (await opened.page.locator('[data-seat-collapse][aria-expanded="true"]').count()) await opened.page.keyboard.press("o");
      /* The pointer starts on the bar, over no column. */
      await opened.page.mouse.move(700, 10);
      await opened.page.waitForTimeout(700);
      return opened;
    };
    /* The columns a press of `status`'s Widen button leaves, on a fresh board. */
    const viaButton = async (sidebar: boolean, status: string, before?: (page: Page) => Promise<void>) => {
      const { context, page } = await open(sidebar, "light");
      try {
        await before?.(page);
        const box = await page.locator(`[data-col-width="${status}"]`).boundingBox();
        if (!box) return null;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.move(700, 10);
        await page.waitForTimeout(700);
        return await readColumns(page);
      } finally {
        await context.close();
      }
    };
    const sameAs = (label: string, got: Awaited<ReturnType<typeof readColumns>>, want: Awaited<ReturnType<typeof readColumns>> | null) => {
      if (!want) return failures.push(`${label}: the Widen button was not on screen`);
      for (const [status, column] of Object.entries(want)) {
        const mine = got[status];
        if (!mine || mine.wide !== column.wide || Math.abs(mine.width - column.width) > 1) failures.push(`${label}: ${status} is ${JSON.stringify(mine)}, the Widen button leaves ${JSON.stringify(column)}`);
      }
    };
    const cases = [
      { sidebar: true, scheme: "light", motion: "no-preference" },
      { sidebar: false, scheme: "light", motion: "no-preference" },
      { sidebar: false, scheme: "dark", motion: "no-preference" },
      { sidebar: false, scheme: "light", motion: "reduce" },
    ] as const;
    try {
      for (const { sidebar, scheme, motion } of cases) {
        const label = `${sidebar ? "sidebar" : "no-sidebar"}-${scheme}${motion === "reduce" ? "-reduced-motion" : ""}`;
        const { context, page, pageErrors } = await open(sidebar, scheme, motion);
        try {
          const before = await readColumns(page);
          /* Over a card in the rightmost narrow shelf the window shows whole, clear of its buttons. */
          const target = await page.evaluate(() => {
            const shown = [...document.querySelectorAll<HTMLElement>('[data-kanban-board] .column[data-wide="0"]')].filter((column) => {
              const box = column.getBoundingClientRect();
              return box.left >= 0 && box.right <= innerWidth;
            });
            const column = shown.at(-1);
            if (!column) return null;
            const body = column.querySelector<HTMLElement>(".col-body")!.getBoundingClientRect();
            return { status: column.dataset.status!, x: Math.round(body.left + body.width / 2), y: Math.round(body.top + 90), mode: document.querySelector<HTMLElement>("[data-kanban-board]")?.dataset.mode ?? null };
          });
          if (!target) {
            failures.push(`${label}: no narrow column is whole in the window`);
            continue;
          }
          await page.mouse.move(target.x - 40, target.y - 30);
          await page.mouse.move(target.x, target.y, { steps: 6 });
          await page.waitForTimeout(800);
          const mid = await readColumns(page);
          await page.screenshot({ path: path.join(pngDir, `${label}-cue-mid-countdown.png`) });
          await page.waitForTimeout(1_000);
          const after = await readColumns(page);
          await page.screenshot({ path: path.join(pngDir, `${label}-widened.png`) });
          const button = scheme === "light" && motion === "no-preference" ? await viaButton(sidebar, target.status) : null;
          readings[label] = { target, before, mid, after, button, pageErrors };
          const cue = mid[target.status];
          if (!cue?.cue) failures.push(`${label}: no cue on ${target.status} 800 ms into the dwell`);
          if (motion === "reduce" ? cue?.sweep : cue?.sweep !== "kb-dwell") failures.push(`${label}: the sweep reads ${cue?.sweep}`);
          if (!after[target.status]?.wide || before[target.status]?.wide) failures.push(`${label}: ${target.status} did not widen`);
          if (button) sameAs(label, after, button);
          if (after[target.status]?.cue) failures.push(`${label}: the cue stayed after the widening`);
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }
      for (const sidebar of [true, false]) {
        const label = `${sidebar ? "sidebar" : "no-sidebar"}-light-rail-focus`;
        const { context, page, pageErrors } = await open(sidebar, "light");
        try {
          const status = await page.evaluate((key) => document.querySelector(`[data-kanban-reader="${key}"]`)?.closest<HTMLElement>(".column")?.dataset.status ?? null, SHELF_AGENT);
          /* Another agent first, so the rail's jump is a move across the board. */
          const first = async (on: Page) => {
            await on.locator(`[data-open-agent-jump="conversation_${OPEN[0]}"]`).click();
            await on.waitForTimeout(500);
          };
          await first(page);
          const before = await readColumns(page);
          await page.screenshot({ path: path.join(pngDir, `${label}-before.png`) });
          await page.locator(`[data-open-agent-jump="${SHELF_AGENT}"]`).click();
          await page.waitForTimeout(700);
          const after = await readColumns(page);
          const focused = await page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-kanban-reader]")?.dataset.kanbanReader ?? null);
          await page.screenshot({ path: path.join(pngDir, `${label}.png`) });
          const button = await viaButton(sidebar, "inbox", first);
          readings[label] = { status, before, after, button, focused, pageErrors };
          if (status !== "inbox") failures.push(`${label}: the shelf agent's reader sits in ${status}`);
          else if (!after.inbox?.wide || before.inbox?.wide) failures.push(`${label}: Inbox did not widen`);
          sameAs(label, after, button);
          if (focused !== SHELF_AGENT) failures.push(`${label}: the operator is in ${focused}`);
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    fs.writeFileSync(path.join(pngDir, "readings.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("#1856 undo and redo on the desktop board", () => {
  /*
   * Rendered evidence for the board's undo and redo (#1856): the real Viewer
   * over `issue1695Evidence.fixture.tsx?scenario=pipeline-block`, whose tasks
   * carry Ukrainian titles under `llv_lang=uk`, at 1440 in English and in
   * Ukrainian:
   *
   *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "#1856"
   *
   * Gated per language:
   *   - `]` on a card moves it and the receipt offers Undo;
   *   - Ctrl+Z puts the card back through one PATCH fenced on the revision the
   *     move returned, and the receipt is replaced by one offering Redo;
   *   - an undo after an agent wrote the task where the page cannot see it
   *     (`agentWritesDescriptionQuietly`) sends one PATCH, meets the 409,
   *     leaves the card where the store has it, and says so in an error
   *     receipt with no action whose text stays within two lines at 560 px;
   *   - an undo whose write fails offers Retry, in a word the Redo beside it
   *     does not use, on one line;
   *   - in every frame the receipts stand over the columns' foot, centred on
   *     the pane beside the open project rail, and every column well ends on
   *     the pixel row it ended on before the first receipt, after a close and
   *     after the timer too;
   *   - the bottom receipt covers no card of a list scrolled to its end (the
   *     lists' padding clears one receipt), and a list scrolled to its end
   *     keeps its cards where they are when the receipts leave.
   *
   * Measurements go to `evidence/issue-1856/undo-redo.json`; frames to
   * `.artifacts/issue-1856/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1856");
  const EVIDENCE = path.resolve("evidence/issue-1856");
  type Evidence = {
    agentWritesDescriptionQuietly: (id: string, description: string) => void;
    refuseNextTaskPatch: boolean;
    taskPatches: Array<{ id: string; body: Record<string, unknown> }>;
    taskWrites: Array<{ id: string; startedAt: number; answeredAt: number }>;
    storedTask: (id: string) => Record<string, unknown> | null;
  };
  const columnOf = (page: Page, id: string) => page.evaluate((selector) => document.querySelector(selector)?.closest<HTMLElement>(".column")?.dataset.status ?? null, card(id));
  const storedRevision = (page: Page, id: string) => page.evaluate((task) => (window as unknown as { evidence: Evidence }).evidence.storedTask(task)?.revision ?? null, id);
  const receipts = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-kanban-receipt]")].map((receipt) => {
    const message = receipt.querySelector<HTMLElement>(".msg")!;
    const box = receipt.getBoundingClientRect();
    return {
      text: message.textContent ?? "",
      action: receipt.querySelector(".act")?.textContent ?? null,
      error: receipt.classList.contains("error"),
      width: Math.round(box.width),
      lines: Math.round(message.getBoundingClientRect().height / parseFloat(getComputedStyle(message).lineHeight)),
      clipped: message.scrollHeight > message.clientHeight + 1,
    };
  }));
  /* Where the receipts stand: their centre against the pane's, the bottom of
     every column well on the board's page (the page scrolls under a seat, so
     it is read in the page's own coordinates), and the cards the bottom
     receipt covers once the page and each card list are scrolled to their
     ends (all are put back where they were). */
  const placement = (page: Page) => page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".kb-pane")!.getBoundingClientRect();
    const scroller = document.querySelector<HTMLElement>(".kb-page")!;
    const boxes = () => [...document.querySelectorAll<HTMLElement>("[data-kanban-receipt]")].map((receipt) => receipt.getBoundingClientRect());
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const wells = Object.fromEntries([...scroller.querySelectorAll<HTMLElement>(".column[data-status]")].map((column) => [column.dataset.status, Math.round(column.getBoundingClientRect().bottom - origin)]));
    const lists = [...scroller.querySelectorAll<HTMLElement>(".col-body")];
    const kept = { page: scroller.scrollTop, lists: lists.map((list) => list.scrollTop) };
    scroller.scrollTop = scroller.scrollHeight;
    lists.forEach((list) => { list.scrollTop = list.scrollHeight; });
    const atEnd = boxes().sort((a, b) => b.bottom - a.bottom).slice(0, 1);
    const coveredAtEnd = lists.flatMap((list) => {
      const view = list.getBoundingClientRect();
      return [...list.querySelectorAll<HTMLElement>(".card")].flatMap((node) => {
        const box = node.getBoundingClientRect();
        const top = Math.max(box.top, view.top), bottom = Math.min(box.bottom, view.bottom);
        return atEnd.some((r) => top < bottom && r.left < box.right && box.left < r.right && r.top < bottom && top < r.bottom) ? [node.dataset.id ?? "?"] : [];
      });
    });
    lists.forEach((list, index) => { list.scrollTop = kept.lists[index]; });
    scroller.scrollTop = kept.page;
    const shown = boxes();
    return {
      paneCentre: Math.round(pane.left + pane.width / 2),
      receiptCentres: shown.map((r) => Math.round(r.left + r.width / 2)),
      stackTop: shown.length ? Math.round(Math.min(...shown.map((r) => r.top))) : null,
      wells,
      coveredAtEnd,
    };
  });
  const placed = (lang: string, frame: string, where: Awaited<ReturnType<typeof placement>>, before: Record<string, number>, failures: string[]) => {
    if (where.receiptCentres.some((x) => Math.abs(x - where.paneCentre) > 1)) failures.push(`${lang} ${frame}: receipts centred at ${where.receiptCentres.join(", ")}, the pane at ${where.paneCentre}`);
    if (JSON.stringify(where.wells) !== JSON.stringify(before)) failures.push(`${lang} ${frame}: column wells end at ${JSON.stringify(where.wells)}, before the receipts at ${JSON.stringify(before)}`);
    if (where.coveredAtEnd.length) failures.push(`${lang} ${frame}: receipts over ${where.coveredAtEnd.join(", ")} with their lists scrolled to the end`);
  };
  /* Where each card list's last card ends, optionally after scrolling the
     page and every list to its end first. */
  const listEnds = (page: Page, scroll: boolean) => page.evaluate((toEnd) => {
    const scroller = document.querySelector<HTMLElement>(".kb-page")!;
    const lists = [...scroller.querySelectorAll<HTMLElement>(".col-body")];
    if (toEnd) {
      scroller.scrollTop = scroller.scrollHeight;
      lists.forEach((list) => { list.scrollTop = list.scrollHeight; });
    }
    return Object.fromEntries(lists.map((list) => [
      list.closest<HTMLElement>(".column")?.dataset.status ?? "?",
      Math.round([...list.querySelectorAll<HTMLElement>(".card")].at(-1)?.getBoundingClientRect().bottom ?? 0),
    ]));
  }, scroll);
  const patches = (page: Page) => page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.taskPatches);
  const writesSettled = (page: Page, count: number) => page.waitForFunction((expected) => {
    const writes = (window as unknown as { evidence: Evidence }).evidence.taskWrites;
    return writes.length === expected && writes.every((write) => write.answeredAt > 0);
  }, count, { timeout: 10_000 });
  const short = clipTitle;
  const titleOf = (page: Page, id: string) => page.evaluate((selector) => document.querySelector(`${selector} .title`)?.textContent ?? "", card(id));

  browserTest("#1856: a move, its undo, and an undo refused after an agent's write, in English and Ukrainian at 1440", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const server = await serveEvidenceFixture(OUT);
    const browser: Browser = await chromium.launch(LAUNCH);
    const failures: string[] = [];
    const record: Record<string, unknown> = {};
    try {
      for (const lang of ["en", "uk"] as const) {
        const tr = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(lang, key, vars);
        const opened = await openFixture(browser, `${server.base}?scenario=pipeline-block`, VIEWPORT, "light", lang);
        const { page } = opened;
        try {
          await page.waitForSelector(card("t-export"), { timeout: 20_000 });
          await page.waitForTimeout(800);
          const frames: Record<string, unknown> = {};
          const before = (await placement(page)).wells;
          frames.before = { wells: before };

          /* The move. */
          const title = await titleOf(page, "t-export");
          await page.locator(card("t-export")).focus();
          await page.keyboard.press("]");
          await writesSettled(page, 1);
          await page.waitForTimeout(300);
          const moved = await receipts(page);
          await page.screenshot({ path: path.join(OUT, `move-${lang}.png`) });
          let where = await placement(page);
          frames.move = { column: await columnOf(page, "t-export"), receipts: moved, placement: where };
          placed(lang, "move", where, before, failures);
          const movedText = tr("kanban.moved", { title: short(title), status: tr("kanban.status.blocked" as never) });
          if (await columnOf(page, "t-export") !== "blocked") failures.push(`${lang} move: t-export in ${await columnOf(page, "t-export")}`);
          if (JSON.stringify(moved.map((receipt) => [receipt.text, receipt.action])) !== JSON.stringify([[movedText, tr("kanban.undo")]])) failures.push(`${lang} move: receipts ${JSON.stringify(moved)}`);

          /* Ctrl+Z, on the board. */
          const afterMove = await storedRevision(page, "t-export");
          await page.keyboard.press("Control+z");
          await writesSettled(page, 2);
          await page.waitForTimeout(300);
          const undone = await receipts(page);
          await page.screenshot({ path: path.join(OUT, `undo-${lang}.png`) });
          const sent = await patches(page);
          where = await placement(page);
          frames.undo = { column: await columnOf(page, "t-export"), receipts: undone, patch: sent[1] ?? null, fence: afterMove, placement: where };
          placed(lang, "undo", where, before, failures);
          const backText = tr("kanban.movedBack", { title: short(title), status: tr("kanban.status.assigned" as never) });
          if (await columnOf(page, "t-export") !== "assigned") failures.push(`${lang} undo: t-export in ${await columnOf(page, "t-export")}`);
          if (JSON.stringify(undone.map((receipt) => [receipt.text, receipt.action])) !== JSON.stringify([[backText, tr("kanban.redo")]])) failures.push(`${lang} undo: receipts ${JSON.stringify(undone)}`);
          if (sent[1]?.body.status !== "assigned" || !afterMove || sent[1]?.body.expectedRevision !== afterMove) failures.push(`${lang} undo: patch ${JSON.stringify(sent)}`);

          /* An agent writes t-search where the page cannot see it; Ctrl+Z is refused. */
          const searchTitle = await titleOf(page, "t-search");
          await page.locator(card("t-search")).focus();
          await page.keyboard.press("]");
          await writesSettled(page, 3);
          await page.waitForTimeout(300);
          await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.agentWritesDescriptionQuietly("t-search", "Agent: keep the old index until the new one answers a warm query."));
          await page.keyboard.press("Control+z");
          await writesSettled(page, 4);
          await page.waitForTimeout(600);
          const refused = await receipts(page);
          await page.screenshot({ path: path.join(OUT, `refusal-${lang}.png`) });
          const all = await patches(page);
          where = await placement(page);
          frames.refusal = { column: await columnOf(page, "t-search"), receipts: refused, patches: all.slice(2), placement: where };
          placed(lang, "refusal", where, before, failures);
          const refusedText = tr("kanban.undoRefused", { title: short(searchTitle) });
          const refusal = refused.find((receipt) => receipt.text === refusedText);
          if (all.length !== 4) failures.push(`${lang} refusal: ${all.length} patches`);
          if (await columnOf(page, "t-search") !== "blocked") failures.push(`${lang} refusal: t-search in ${await columnOf(page, "t-search")}`);
          if (!refusal || !refusal.error || refusal.action !== null) failures.push(`${lang} refusal: receipts ${JSON.stringify(refused)}`);
          else if (refusal.lines > 2 || refusal.clipped || refusal.width > 560) failures.push(`${lang} refusal: ${refusal.lines} lines, clipped ${refusal.clipped}, ${refusal.width} px`);
          if (refused.some((receipt) => receipt.text === tr("kanban.movedBack", { title: short(searchTitle), status: tr("kanban.status.assigned" as never) }))) failures.push(`${lang} refusal: the undo's own receipt stayed`);

          /* Every list scrolled to its end, the receipts closed: no card moves. */
          const atEnd = await listEnds(page, true);
          await page.waitForTimeout(100);
          while (await page.locator("[data-kanban-receipt]").count()) await page.locator("[data-kanban-receipt] .close").first().click();
          await page.waitForTimeout(300);
          const closedEnds = await listEnds(page, false);
          where = await placement(page);
          frames.closed = { lastCardBottoms: { before: atEnd, after: closedEnds }, placement: where };
          placed(lang, "closed", where, before, failures);
          if (JSON.stringify(closedEnds) !== JSON.stringify(atEnd)) failures.push(`${lang} closed: the last cards of lists scrolled to the end moved from ${JSON.stringify(atEnd)} to ${JSON.stringify(closedEnds)}`);
          await page.evaluate(() => document.querySelectorAll<HTMLElement>(".kb-page, .kb-page .col-body").forEach((node) => { node.scrollTop = 0; }));

          /* t-export moves again and its undo's write fails: the receipt offers Retry. */
          await page.locator(card("t-export")).focus();
          await page.keyboard.press("]");
          await writesSettled(page, 5);
          await page.waitForTimeout(300);
          await page.evaluate(() => { (window as unknown as { evidence: Evidence }).evidence.refuseNextTaskPatch = true; });
          await page.keyboard.press("Control+z");
          await page.waitForSelector("[data-kanban-receipt].error", { timeout: 5_000 });
          await page.waitForTimeout(600);
          const failed = await receipts(page);
          await page.screenshot({ path: path.join(OUT, `failure-${lang}.png`) });
          where = await placement(page);
          frames.failure = { column: await columnOf(page, "t-export"), receipts: failed, placement: where };
          placed(lang, "failure", where, before, failures);
          const failedText = tr("kanban.undoFailed", { error: "refused by the evidence fixture" });
          const failure = failed.find((receipt) => receipt.text === failedText);
          if (!failure || !failure.error || failure.action !== tr("kanban.retry")) failures.push(`${lang} failure: receipts ${JSON.stringify(failed)}`);
          else if (failure.lines !== 1 || failure.clipped) failures.push(`${lang} failure: ${failure.lines} lines, clipped ${failure.clipped}`);
          if (tr("kanban.retry") === tr("kanban.redo")) failures.push(`${lang}: Retry and Redo are both «${tr("kanban.redo")}»`);

          /* The receipts leave on their timers: the wells stay put. */
          await page.mouse.move(0, 0);
          await page.waitForFunction(() => !document.querySelector("[data-kanban-receipt]"), undefined, { timeout: 20_000 });
          await page.waitForTimeout(300);
          where = await placement(page);
          frames.expired = { placement: where };
          placed(lang, "expired", where, before, failures);
          if (opened.pageErrors.length) failures.push(`${lang}: page errors ${opened.pageErrors.join(" | ")}`);
          record[lang] = frames;
        } catch (error) {
          failures.push(`${lang}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await opened.context.close();
        }
      }
    } finally {
      await browser.close();
      server.stop();
    }
    /* A revision has the shape of a UUID, which the publication gate refuses in
       any committed file: the record keeps its counter only. */
    const revisions = (_key: string, value: unknown) => (typeof value === "string" && value.startsWith("task-v1:") ? `revision ${Number(value.slice(-12))}` : value);
    fs.writeFileSync(path.join(EVIDENCE, "undo-redo.json"), `${JSON.stringify({ viewport: VIEWPORT, frames: record, failures }, revisions, 2)}\n`);
    expect(failures).toEqual([]);
  }, 240_000);
});
