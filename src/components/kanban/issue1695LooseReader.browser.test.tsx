import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for review round 2 of #1712: the reader of a conversation
 * no card holds takes the whole window, and every way of going somewhere else
 * on the Board leaves that window first. In the real Viewer over
 * `issue1695Evidence.fixture.tsx?scenario=loose` (a review round of the export
 * implementer, which no card holds), in Chromium:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1695LooseReader.browser.test.tsx
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

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
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
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
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
