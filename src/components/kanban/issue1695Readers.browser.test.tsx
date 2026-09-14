import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";
import { kanbanLayoutMode } from "./KanbanBoard";

/*
 * Rendered evidence for #1695 K3: conversations inside kanban cards and the
 * orchestrator seated above the board, in the real Viewer over
 * `issue1695Evidence.fixture.tsx`, in Chromium, light and dark:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1695Readers.browser.test.tsx
 *
 * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
 * prototype, the same frames (board with the seat, several readers, one
 * conversation) are rendered by the prototype at the same board width beside
 * the production ones.
 *
 * Gated here, because only a laid-out page settles it:
 *   - the seat is centred, at most 1040 px wide, at its smaller default height,
 *     collapsed in a window under 800 px tall, and the side dock stays closed;
 *   - readers sit inside their cards, at most 780 px wide, and a shelf column
 *     holding one widens to reading width;
 *   - a draft, its caret and its focus survive the card moving to another
 *     column while the operator types, and a status move of their own;
 *   - the full-window reader is the same reader, and goes back into its card;
 *   - readers and their folded state survive a reload;
 *   - the seat's grip resizes it and the height survives a reload; Collapse
 *     keeps its conversation mounted, and the header's Orchestrator control
 *     expands it without opening the dock;
 *   - an attention `open` of an EMPTY transcript arrives as `reader`, presence
 *     names it, and Return closes it; a reader scrolled out of its column does
 *     not arrive;
 *   - Link and Unlink go through the assignment route with their own receipts,
 *     including the refusal for a conversation's only task.
 *
 * Measurements go to `evidence/issue-1695/k3.json`; frames to
 * `.artifacts/issue-1695-k3/`, which is not committed.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1695-k3");
const EVIDENCE = path.resolve("evidence/issue-1695");
const PROTOTYPE = process.env.KANBAN_PROTOTYPE_URL?.trim().replace(/\/$/, "") || null;
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
  focus: {
    bus: { board(): { arrival?(destination: unknown): string | null; returnFromHandoff?(): void } | null };
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
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
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
          const expected = Math.min(460, Math.max(300, Math.round(viewport.height * 0.44)));
          if (!seat.present) failures.push(`${label}: no seat`);
          if (seat.collapsed !== shortWindow) failures.push(`${label}: seat collapsed=${seat.collapsed} in a ${viewport.height} px window`);
          if (!seat.collapsed && Math.abs(seat.height - expected) > 2) failures.push(`${label}: seat ${seat.height}px tall, default ${expected}px`);
          if (!seat.collapsed && seat.composerHeight < 60) failures.push(`${label}: the seat's composer is squeezed to ${seat.composerHeight}px`);
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
      const seatFlow = { before: before.height, dragged: dragged.height, afterReload: afterReload.height, keyed: keyed.height, collapsed: { height: collapsed.height, flag: collapsed.collapsed, conversations: collapsed.conversations }, expanded: { flag: expanded.collapsed, dock: expanded.dock } };
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
      await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.focus.bus.board()?.returnFromHandoff?.());
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
