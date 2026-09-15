import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for Stages on the kanban board (#1695 K5b): the real
 * Viewer over `issue1695Evidence.fixture.tsx?scenario=stages`, with the
 * production stylesheet, in Chromium:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1695Stages.browser.test.tsx
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
 *     stage's wiring token with the words; a stage that starts during the save
 *     keeps the words, marked not delivered, and becomes the reader when let
 *     go; words saved elsewhere stop the save until Keep mine;
 *   - one folded "Added when it starts" line under each waiting stage's first
 *     message, in the card panel and every waiting pane, unfolding to what
 *     `renderStagePrompt` adds (binding correction 2);
 *   - Pause and Resume over the pipeline route with the pending chip, the
 *     receipt, and a refusal with Retry; a lost answer reported as not
 *     confirmed with a Check again that only reads; a refused skip whose
 *     Retry finds the pipeline waiting on another stage and sends nothing;
 *   - the reader open on a card is the same mounted conversation in its pane
 *     and back, composer text included; the board's "/" stays behind the
 *     open sheet; Escape returns focus to Stages; arrow keys step the lane.
 *
 * Measurements go to `evidence/issue-1695/k5b.json`; frames to
 * `.artifacts/issue-1695/`, which is not committed.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1695");
const EVIDENCE = path.resolve("evidence/issue-1695");
const PROTOTYPE = process.env.KANBAN_PROTOTYPE_URL?.trim().replace(/\/$/, "") || null;
const VIEWPORT = { width: 1440, height: 900 } as const;

type Scheme = "light" | "dark";

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

const card = (id: string) => `[data-kanban-board] .card[data-id="task:${id}"]`;
type Hook = { evidence: {
  pipelinePatches: Array<{ id: string; body: Record<string, unknown> }>;
  pipelineReads: string[];
  refuseNextPipelinePatch: { status: number; error: string } | null;
  startStageOnNextPatch: { pipelineId: string; stageId: string } | null;
  writeStagePromptQuietly: (pipelineId: string, stageId: string, prompt: string) => void;
  loseNextPipelineAnswer: boolean;
  moveCursor: (pipelineId: string, stageId: string) => void;
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
  const browser: Browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
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
      if (JSON.stringify(saved) !== JSON.stringify({ id: "p-links", body: { action: "override-stage", stageId: "review", prompt: "{{prev.output}}\n\nCheck both anchors against the published notes, then the changelog." } })) failures.push(`stage draft save: ${JSON.stringify(saved)}`);
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
      if (JSON.stringify(writes) !== JSON.stringify([{ action: "skip-stage" }]) || reads !== 2) failures.push(`moved cursor, requests: ${JSON.stringify({ writes, reads })}`);
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
