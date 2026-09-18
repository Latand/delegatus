import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for #1765: the real Viewer over
 * `issue1695Evidence.fixture.tsx?scenario=issue1765`, with the production
 * stylesheet, in Chromium, at the two widths the issue names:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=$(which google-chrome-stable) \
 *     bun test src/components/kanban/issue1765Board.browser.test.tsx
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

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
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
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
  });
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
