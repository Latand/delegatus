import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { chromium, type Browser, type Page } from "playwright-core";
import postcss from "postcss";

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
  if ((expectedMode === "wide" || expectedMode === "narrow") && geometry.overflowX > 1) failures.push(`${label}: board overflows sideways by ${geometry.overflowX}px`);
}

async function openFixture(browser: Browser, url: string, viewport: { width: number; height: number }, scheme: "light" | "dark") {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: "no-preference" });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url);
  return { context, page, pageErrors };
}

browserTest("#1695 kanban board: the prototype's columns and cards over the real Viewer, light and dark", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const build = await Bun.build({
    entrypoints: [path.resolve("src/components/kanban/issue1695Evidence.fixture.tsx")],
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
  const base = `http://127.0.0.1:${server.port}/`;
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
      if (pageErrors.length) failures.push(`flows: page errors ${pageErrors.join(" | ")}`);
    } finally {
      await context.close();
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
      if (!back.some((mutation) => JSON.stringify(mutation) === JSON.stringify({ kind: "set-presentation", desktopBoard: null, viewMode: "scheme" }))) failures.push(`tabs: Board wrote ${JSON.stringify(back)}`);
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
    server.stop(true);
  }
  const modes = new Set(frames.map((frame) => (frame as { production: BoardGeometry }).production.mode));
  for (const mode of ["wide", "narrow", "scroll", "tabs"]) if (!modes.has(mode)) failures.push(`no frame rendered the ${mode} mode`);
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), frames, flows, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);
