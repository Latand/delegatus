/**
 * Renders and gates the kanban-board prototype in a real headless Chrome.
 *
 *   bun prototypes/kanban-board/capture.ts
 *
 * Frames land in `prototypes/kanban-board/out/<frame>/<scheme>/<screen>.png`
 * (gitignored: a browser render is not byte-deterministic and carries no
 * provenance manifest, see the repository's raster rule) and the measurements
 * in `out/manifest.json`, which the review can inspect directly.
 *
 * Two halves:
 *   1. the screenshot matrix — every key screen at 1440×900, 1280×800,
 *      1024×768, 768×1024 (coarse) and 390×844 (coarse), light and dark, each
 *      gated on: no horizontal body overflow, four columns (or tabs), the two
 *      protected-card rules, ≤ 2 visible title lines, ≥ 44 px targets on
 *      coarse pointers, and no two visible controls overlapping;
 *   2. the flows — driven headless in one page: an optimistic status move and
 *      its undo; a refused status move that rolls back; hide + undo; bulk hide
 *      with a working card kept; the protected card refusing to hide; inline
 *      rename with a refused save that keeps the draft; the concurrent agent
 *      edit; a hidden task resurfacing on a decision; keyboard-only status
 *      move and hide; menu focus and Escape.
 *
 * Set CHROME_BIN to a Chrome/Chromium binary if none is on PATH.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

const here = path.resolve(import.meta.dir);
const OUT = path.join(here, "out");
const INDEX = pathToFileURL(path.join(here, "index.html")).href;
const only = process.env.KANBAN_ONLY?.split(",").filter(Boolean);
/* KANBAN_FLOWS_ONLY=1 skips the matrix and drives the flows alone. */
const flowsOnly = process.env.KANBAN_FLOWS_ONLY === "1";

type Frame = { name: string; width: number; height: number; coarse?: boolean };
const FRAMES: Frame[] = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024, coarse: true },
  { name: "390x844", width: 390, height: 844, coarse: true },
];
const SCHEMES = ["light", "dark"] as const;

type Screen = { id: string; query: string; note: string };
const SCREENS: Screen[] = [
  { id: "board", query: "", note: "the four columns at rest" },
  { id: "card-menu", query: "menu=t-export", note: "the card's actions: status, colour, rename, hide" },
  { id: "status-menu", query: "status=t-links", note: "the status pill's menu" },
  { id: "editing-title", query: "edit=t-search", note: "inline rename with the saving hints" },
  { id: "editing-description", query: "editdesc=t-export", note: "inline description edit" },
  { id: "history-open", query: "history=open", note: "every history disclosure expanded" },
  { id: "hidden-tray", query: "hidden=t-merge-a,t-verify-a,t-compact&tray=1", note: "three hidden tasks and the tray" },
  { id: "column-menu-done", query: "colmenu=done", note: "the Done column's bulk hide" },
  { id: "drawer", query: "drawer=t-search", note: "the full history drawer, tucked behind the card" },
  { id: "search", query: "q=queue", note: "a search narrowing every column" },
  { id: "assigned-idle", query: "focus=t-merge-a", note: "the Idle divider inside Assigned, with its bulk hide" },
];

type Geometry = {
  columns: number; tabs: number; bodyOverflow: number; cards: number; hiddenCards: number;
  protectedHasHide: boolean; protectedHasLock: boolean; maxTitleLines: number; smallTargets: string[]; overlaps: string[];
  visibleControls: number; menuOpen: boolean; assignedWidth: number; shelfWidth: number; overlayOverflow: number;
};

async function geometry(page: Page, coarse: boolean): Promise<Geometry> {
  return page.evaluate((isCoarse) => {
    const app = document.getElementById("app")!;
    const vis = (el: Element) => {
      if (el.closest("details:not([open])") && !el.matches("summary")) return false;
      const check = (el as HTMLElement & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
      if (check && !check.call(el, { contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0.05;
    };
    const controls = [...document.querySelectorAll("button, input, textarea, summary, [role=menuitem], [role=menuitemradio]")].filter((c) => vis(c) && !c.closest("#bench"));
    const small: string[] = [];
    const overlaps: string[] = [];
    /* Clip each control to its scrolling column body: a control scrolled out of
       a column is clipped on screen even though its own rect says otherwise. */
    const clip = (c: Element) => {
      const r = c.getBoundingClientRect(); const sc = c.closest(".col-body");
      if (!sc) return r;
      const b = sc.getBoundingClientRect();
      const left = Math.max(r.left, b.left), top = Math.max(r.top, b.top), right = Math.min(r.right, b.right), bottom = Math.min(r.bottom, b.bottom);
      return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) } as DOMRect;
    };
    const rects = controls.map((c) => ({ c, r: clip(c), full: c.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0);
    /* Size is judged on the control's own box; a control half-scrolled out of
       its column is small on screen but not small. */
    if (isCoarse) for (const { c, full } of rects) { if (c.classList.contains("swatch")) continue; if (full.width < 44 || full.height < 44) small.push(`${c.getAttribute("aria-label") || c.textContent?.trim().slice(0, 30) || c.tagName} ${Math.round(full.width)}×${Math.round(full.height)}`); }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!, b = rects[j]!;
      if (a.c.contains(b.c) || b.c.contains(a.c)) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (x > 2 && y > 2) {
        /* A menu or drawer legitimately covers what is under it. */
        if (a.c.closest(".menu, .popover, .drawer, .receipt") || b.c.closest(".menu, .popover, .drawer, .receipt")) continue;
        overlaps.push(`${(a.c.getAttribute("aria-label") || a.c.textContent || "").trim().slice(0, 24)} ∩ ${(b.c.getAttribute("aria-label") || b.c.textContent || "").trim().slice(0, 24)}`);
      }
    }
    const titles = [...app.querySelectorAll(".card .title .clamp")].filter(vis);
    const maxTitleLines = Math.max(0, ...titles.map((t) => Math.round(t.getBoundingClientRect().height / 18)));
    const prot = app.querySelector('.card[data-protected="1"]');
    const assigned = app.querySelector('.column[data-status="assigned"]');
    const shelf = app.querySelector('.column[data-status="inbox"]');
    return {
      columns: [...app.querySelectorAll(".column")].filter(vis).length,
      tabs: app.querySelectorAll('[role="tab"]').length,
      bodyOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      cards: [...app.querySelectorAll(".card")].filter(vis).length,
      hiddenCards: (window as unknown as { __proto: { state: { tasks: { hiddenAt: number | null }[] } } }).__proto.state.tasks.filter((t) => t.hiddenAt).length,
      protectedHasHide: Boolean(prot?.querySelector("[data-hide]")),
      protectedHasLock: Boolean(prot?.querySelector("[data-lock]")),
      maxTitleLines,
      smallTargets: small,
      overlaps,
      visibleControls: controls.length,
      menuOpen: Boolean(document.querySelector(".menu, .popover, .drawer")),
      overlayOverflow: Math.max(0, ...[...document.querySelectorAll(".menu, .popover")].map((m) => { const r = m.getBoundingClientRect(); return Math.max(r.bottom - window.innerHeight, r.right - window.innerWidth, -r.top, -r.left); })),
      assignedWidth: assigned ? Math.round(assigned.getBoundingClientRect().width) : 0,
      shelfWidth: shelf ? Math.round(shelf.getBoundingClientRect().width) : 0,
    };
  }, coarse);
}

function gate(label: string, g: Geometry, frame: Frame, screen: Screen): void {
  if (g.bodyOverflow > 0) throw new Error(`${label}: body overflows horizontally by ${g.bodyOverflow}px`);
  if (frame.width >= 768 && g.columns !== 4) throw new Error(`${label}: ${g.columns} columns drawn, expected 4`);
  if (frame.width < 768 && (g.tabs !== 4 || g.columns !== 1)) throw new Error(`${label}: narrow layout drew ${g.columns} columns and ${g.tabs} tabs, expected 1 and 4`);
  if (frame.width >= 1024 && g.assignedWidth < g.shelfWidth * 1.6) throw new Error(`${label}: the Assigned column (${g.assignedWidth}px) is not the workspace next to ${g.shelfWidth}px shelves`);
  if (g.maxTitleLines > 2) throw new Error(`${label}: a title shows ${g.maxTitleLines} lines; the clamp is 2`);
  if (g.overlayOverflow > 0) throw new Error(`${label}: a menu or popover leaves the viewport by ${Math.round(g.overlayOverflow)}px`);
  if (screen.id === "board" && frame.width >= 768) {
    if (g.protectedHasHide) throw new Error(`${label}: the protected card offers a hide control`);
    if (!g.protectedHasLock) throw new Error(`${label}: the protected card does not explain why it stays`);
  }
  if (frame.coarse && g.smallTargets.length) throw new Error(`${label}: controls under 44px on a coarse pointer: ${g.smallTargets.slice(0, 6).join("; ")}`);
  if (g.overlaps.length) throw new Error(`${label}: overlapping controls: ${g.overlaps.slice(0, 4).join("; ")}`);
  if (screen.id.startsWith("editing") && frame.width >= 768) { /* the editor must exist */ }
}

async function open(page: Page, query: string, scheme: string, latency = 0): Promise<void> {
  const url = `${INDEX}?scheme=${scheme}&latency=${latency}&motion=reduce${query ? `&${query}` : ""}`;
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector('#app[data-ready="1"]', { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(80);
}

type Proto = { state: { tasks: { id: string; status: string; hiddenAt: number | null; title: string; description: string }[]; editing: Map<string, unknown> }; server: { failNext: string | null; latency: number; tasks: Map<string, { status: string; hiddenAt: number | null; title: string }> } };
const read = (page: Page, id: string) => page.evaluate((tid) => { const p = (window as unknown as { __proto: Proto }).__proto; const t = p.state.tasks.find((x) => x.id === tid)!; const s = p.server.tasks.get(tid)!; return { status: t.status, hiddenAt: t.hiddenAt, title: t.title, serverStatus: s.status, serverHidden: s.hiddenAt, serverTitle: s.title }; }, id);
const column = (page: Page, id: string) => page.evaluate((tid) => document.querySelector(`.card[data-id="${tid}"]`)?.closest(".column")?.getAttribute("data-status") ?? null, id);
const receiptText = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".receipt .msg")].map((m) => m.textContent).join(" | "));
async function expect(cond: boolean, msg: string): Promise<void> { if (!cond) throw new Error(`flow: ${msg}`); }

async function flows(page: Page, shot: (name: string) => Promise<void>): Promise<string[]> {
  const passed: string[] = [];
  await page.setViewportSize({ width: 1440, height: 900 });

  /* 1. Optimistic status move via the menu, then undo. */
  await open(page, "", "light", 700);
  await page.click('.card[data-id="t-links"] .pill');
  await page.waitForSelector('.menu[role="menu"]');
  await page.click('.menu [role="menuitemradio"]:has-text("Blocked")');
  await expect((await column(page, "t-links")) === "blocked", "the card did not move to Blocked at once");
  let r = await read(page, "t-links");
  await expect(r.status === "blocked" && r.serverStatus === "assigned", "the move was not optimistic (server already changed or client did not)");
  await expect(await page.evaluate(() => document.querySelector('.card[data-id="t-links"]')?.getAttribute("data-pending") === "1"), "the card does not show its saving state");
  await shot("flow-status-saving");
  await page.waitForTimeout(900);
  r = await read(page, "t-links");
  await expect(r.serverStatus === "blocked", "the server did not receive the status");
  await expect((await receiptText(page)).includes("Moved"), "no receipt for the move");
  await page.click('.receipt .act:has-text("Undo")');
  await expect((await column(page, "t-links")) === "assigned", "undo did not move the card back");
  await page.waitForTimeout(900);
  r = await read(page, "t-links");
  await expect(r.serverStatus === "assigned", "undo did not reach the server");
  passed.push("status move optimistic + undo");

  /* 2. A refused status move rolls back. */
  await open(page, "fail=status", "light", 500);
  await page.click('.card[data-id="t-export"] .pill');
  await page.click('.menu [role="menuitemradio"]:has-text("Done")');
  await expect((await column(page, "t-export")) === "done", "the refused move did not first apply optimistically");
  await page.waitForTimeout(800);
  await expect((await column(page, "t-export")) === "assigned", "the refused move did not roll back");
  r = await read(page, "t-export");
  await expect(r.serverStatus === "assigned", "the server changed despite refusing");
  await expect((await receiptText(page)).includes("Couldn't save"), "no error receipt after the refusal");
  await shot("flow-status-rollback");
  passed.push("refused status move rolls back with an error receipt");

  /* 3. Hide one group, undo it. */
  await open(page, "", "light", 300);
  await page.hover('.card[data-id="t-search"]');
  await page.click('.card[data-id="t-search"] [data-hide]');
  await expect((await page.$('.card[data-id="t-search"]')) === null, "the hidden card is still drawn");
  await expect(await page.evaluate(() => document.querySelector('.hidden-pill')?.getAttribute("data-count") === "1"), "the hidden pill does not count the task");
  await shot("flow-hide-receipt");
  await page.click('.receipt .act:has-text("Undo")');
  await expect((await page.$('.card[data-id="t-search"]')) !== null, "undo did not bring the group back");
  await page.waitForTimeout(500);
  r = await read(page, "t-search");
  await expect(r.serverHidden === null, "undo did not clear the hide on the server");
  passed.push("hide group + undo");

  /* 4. Bulk hide of finished tasks keeps the one with a working agent. */
  await open(page, "", "light", 200);
  await page.click('[data-focus="colmenu:done"]');
  await page.click('.menu [role="menuitem"]:has-text("Hide finished")');
  await page.waitForTimeout(400);
  const doneLeft = await page.evaluate(() => [...document.querySelectorAll('.column[data-status="done"] .card')].map((c) => c.getAttribute("data-id")));
  await expect(doneLeft.length === 1 && doneLeft[0] === "t-attach", `bulk hide left ${doneLeft.join(",")}; expected only the task with a working agent`);
  await expect((await receiptText(page)).includes("kept 1"), "the receipt does not say what was kept");
  await shot("flow-bulk-hide");
  await page.click('.receipt .act:has-text("Undo")');
  await page.waitForTimeout(400);
  await expect((await page.$$('.column[data-status="done"] .card')).length === 5, "bulk undo did not restore every finished task");
  passed.push("bulk hide keeps working card + single undo");

  /* 5. The protected card cannot be hidden: no control, menu item disabled, key refused. */
  await open(page, "", "light", 100);
  await expect((await page.$('.card[data-id="t-seat"] [data-hide]')) === null, "the project manager card has a hide control");
  await page.click('.card[data-id="t-seat"] [data-menu]');
  const disabled = await page.evaluate(() => document.querySelector('.menu [role="menuitem"][aria-disabled="true"]')?.textContent ?? "");
  await expect(disabled.includes("Hide from board") && disabled.includes("stays on the board"), "the menu does not explain why the seat cannot be hidden");
  await shot("flow-protected-menu");
  await page.keyboard.press("Escape");
  await page.focus('.card[data-id="t-seat"]');
  await page.keyboard.press("h");
  await page.waitForTimeout(50);
  await expect((await page.$('.card[data-id="t-seat"]')) !== null, "the seat was hidden by keyboard");
  await expect((await receiptText(page)).includes("stays on the board"), "the keyboard refusal is silent");
  passed.push("protected orchestrator cannot be hidden by control, menu or key");

  /* 6. Inline rename; a refused save keeps the draft; retry succeeds. */
  await open(page, "fail=title", "light", 300);
  await page.click('.card[data-id="t-export"] .title');
  await page.fill('.card[data-id="t-export"] input.edit', "Export presets: three, plus advanced");
  await page.keyboard.press("Enter");
  await expect((await read(page, "t-export")).title === "Export presets: three, plus advanced", "the rename did not apply optimistically");
  await page.waitForTimeout(600);
  r = await read(page, "t-export");
  await expect(r.title === "Simplify the export settings sheet", "the refused rename did not roll back");
  await expect(await page.evaluate(() => document.querySelector('.card[data-id="t-export"] .notice.error')?.textContent?.includes("Your text is kept") ?? false), "the failed save lost the draft or shows no notice");
  await shot("flow-rename-refused");
  await page.click('.card[data-id="t-export"] .notice.error button:has-text("Retry")');
  await page.waitForTimeout(600);
  r = await read(page, "t-export");
  await expect(r.title === "Export presets: three, plus advanced" && r.serverTitle === r.title, "retry did not save the kept draft");
  passed.push("inline rename with refused save keeping the draft, retry saves");

  /* 7. An agent edits the title while the operator edits it. */
  await open(page, "", "light", 100);
  await page.click('.card[data-id="t-export"] .title');
  await page.evaluate(() => (window as unknown as { __proto: { agentEditsCard: (id: string) => void } }).__proto.agentEditsCard("t-export"));
  await expect(await page.evaluate(() => Boolean(document.querySelector('.card[data-id="t-export"] .notice.info'))), "no notice about the concurrent agent edit");
  await expect(await page.evaluate(() => (document.querySelector('.card[data-id="t-export"] input.edit') as HTMLInputElement)?.value === "Simplify the export settings sheet"), "the operator's field was clobbered");
  await shot("flow-concurrent-edit");
  await page.click('.notice.info button:has-text("Use theirs")');
  await expect(await page.evaluate(() => (document.querySelector('.card[data-id="t-export"] input.edit') as HTMLInputElement)?.value.endsWith("(agent revision)")), "Use theirs did not load their version");
  passed.push("concurrent agent edit surfaces without clobbering");

  /* 8. A hidden task comes back when it needs a decision. */
  await open(page, "hidden=t-merge-a", "light", 100);
  await expect((await page.$('.card[data-id="t-merge-a"]')) === null, "the pre-hidden task is drawn");
  await page.evaluate(() => (window as unknown as { __proto: { hiddenTaskNeedsDecision: () => void } }).__proto.hiddenTaskNeedsDecision());
  await expect((await page.$('.card[data-id="t-merge-a"]')) !== null, "the task did not resurface");
  await expect(await page.evaluate(() => document.querySelector('.card[data-id="t-merge-a"] .activity .needs') !== null), "the resurfaced task does not say it needs you");
  const firstAssigned = await page.evaluate(() => document.querySelector('.column[data-status="assigned"] .card')?.getAttribute("data-id"));
  await expect(firstAssigned === "t-merge-a" || firstAssigned === "t-links", "a task needing a decision is not at the top of its column");
  await shot("flow-resurface");
  passed.push("hidden task resurfaces on a decision and sorts first");

  /* 9. Keyboard only: focus a card, ] moves it, h hides it, u undoes. */
  await open(page, "", "light", 100);
  await page.focus('.card[data-id="t-onboarding"]');
  await page.keyboard.press("]");
  await expect((await column(page, "t-onboarding")) === "assigned", "] did not move the card to the next column");
  await expect(await page.evaluate(() => document.activeElement?.getAttribute("data-id") === "t-onboarding"), "focus was lost across the move");
  await page.keyboard.press("h");
  await expect((await page.$('.card[data-id="t-onboarding"]')) === null, "h did not hide the card");
  await page.keyboard.press("u");
  await expect((await page.$('.card[data-id="t-onboarding"]')) !== null, "u did not undo the hide");
  passed.push("keyboard-only status move, hide and undo");

  /* 10. Menu focus contract: opens focused, Escape returns focus to the anchor. */
  await open(page, "", "light", 100);
  await page.click('.card[data-id="t-links"] [data-menu]');
  await expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".menu"))), "the menu opened without taking focus");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(await page.evaluate(() => document.activeElement?.getAttribute("data-menu") === "t-links"), "Escape did not return focus to the ⋯ button");
  passed.push("menu takes focus and Escape returns it");

  /* 11. Colour label. */
  await open(page, "", "light", 100);
  await page.click('.card[data-id="t-disk"] [data-menu]');
  await page.click('.menu .swatch[aria-label="Teal"]');
  await expect(await page.evaluate(() => document.querySelector('.card[data-id="t-disk"]')?.getAttribute("data-color") === "teal"), "the colour did not apply");
  await page.waitForTimeout(300);
  await shot("flow-colour");
  passed.push("colour label applies optimistically");

  return passed;
}

async function main(): Promise<void> {
  /* A full run starts clean; a KANBAN_ONLY run keeps the other frames. */
  if (!only && !flowsOnly) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const executablePath = process.env.CHROME_BIN || ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
  const browser: Browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const manifest: { frames: Record<string, unknown>[]; flows: string[]; consoleErrors: string[] } = { frames: [], flows: [], consoleErrors: [] };
  try {
    for (const frame of FRAMES) {
      if (flowsOnly) break;
      if (only && !only.includes(frame.name)) continue;
      const context = await browser.newContext({ viewport: { width: frame.width, height: frame.height }, hasTouch: Boolean(frame.coarse), deviceScaleFactor: 1, ...(frame.coarse ? { isMobile: false } : {}) });
      if (frame.coarse) await context.addInitScript(() => { /* pointer:coarse is emulated below via CDP */ });
      const page = await context.newPage();
      page.on("pageerror", (err) => manifest.consoleErrors.push(`${frame.name}: ${err.message}`));
      page.on("console", (msg) => { if (msg.type() === "error") manifest.consoleErrors.push(`${frame.name}: ${msg.text()}`); });
      if (frame.coarse) { const cdp = await context.newCDPSession(page); await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] }); }
      for (const scheme of SCHEMES) {
        for (const screen of SCREENS) {
          const label = `${frame.name}/${scheme}/${screen.id}`;
          await open(page, screen.query, scheme);
          const g = await geometry(page, Boolean(frame.coarse));
          const dir = path.join(OUT, frame.name, scheme);
          fs.mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: path.join(dir, `${screen.id}.png`), fullPage: false });
          gate(label, g, frame, screen);
          manifest.frames.push({ frame: frame.name, scheme, screen: screen.id, note: screen.note, ...g, smallTargets: g.smallTargets.length, overlaps: g.overlaps.length });
          process.stdout.write(`ok  ${label}\n`);
        }
      }
      await context.close();
    }
    if (!only || flowsOnly) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.on("pageerror", (err) => manifest.consoleErrors.push(`flows: ${err.message}`));
      const dir = path.join(OUT, "flows");
      fs.mkdirSync(dir, { recursive: true });
      manifest.flows = await flows(page, async (name) => { await page.screenshot({ path: path.join(dir, `${name}.png`) }); });
      for (const f of manifest.flows) process.stdout.write(`ok  flow: ${f}\n`);
      await context.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  if (manifest.consoleErrors.length) throw new Error(`console errors:\n${manifest.consoleErrors.join("\n")}`);
  process.stdout.write(`\n${manifest.frames.length} frames, ${manifest.flows.length} flows green → ${path.relative(process.cwd(), OUT)}\n`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
