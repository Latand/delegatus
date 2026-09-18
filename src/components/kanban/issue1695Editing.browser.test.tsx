import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for task editing on the kanban board (#1695 K4b): the real
 * Viewer over `issue1695Evidence.fixture.tsx?scenario=editing`, against the
 * production stylesheet, in Chromium:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1695Editing.browser.test.tsx
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

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1695");
const EVIDENCE = path.resolve("evidence/issue-1695");
const PROTOTYPE = process.env.KANBAN_PROTOTYPE_URL?.trim().replace(/\/$/, "") || null;
const VIEWPORT = { width: 1440, height: 900 } as const;

type Scheme = "light" | "dark";
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

const card = (id: string) => `[data-kanban-board] .card[data-id="task:${id}"]`;
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
  const browser: Browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
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
