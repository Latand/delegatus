import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "@/components/kanban/issue1695BrowserHarness";

/*
 * The one rendered-evidence driver for the conversation window. Every case
 * here runs the production conversation components over
 * `conversationWindowEvidence.fixture.tsx`, against the production stylesheet,
 * in Chromium, and is gated by its environment variable, so a plain
 * `bun test` loads this file and skips every case:
 *
 *   LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
 *     bun test src/components/conversation/conversationWindow.browser.test.tsx
 *
 * Add a conversation-window issue's rendered evidence as a `describe` block
 * here rather than as a new file (#1761).
 */

const browserTest = process.env.LLV_CONVERSATION_BROWSER_TEST === "1" ? test : test.skip;
const LAUNCH: LaunchOptions = {
  headless: true,
  args: ["--no-sandbox"],
  ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
};
const FIXTURE = "src/components/conversation/conversationWindowEvidence.fixture.tsx";

describe("#1793 launch-prompt bubble", () => {
  /*
   * Rendered evidence for issue #1793: a launch whose receipt says its initial
   * message was delivered never renders a "Delivering" chip, and once the
   * transcript the launch created carries the launch's own first user record
   * the bubble is gone — never a second copy of that record beside it.
   *
   * Three cases, each at a phone and a desktop viewport, in both languages:
   *
   *   queued                 the honest spinner, before the receipt settles;
   *   receipt-delivered      the receipt settled it — no spinner, no lie;
   *   retired-on-transcript  the transcript answered, the bubble is gone and
   *                          the transcript's record is the message's only
   *                          rendering.
   *
   * Geometry goes to `evidence/issue-1793/bubble.json`; frames to
   * `.artifacts/issue-1793/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1793");
  const EVIDENCE = path.resolve("evidence/issue-1793");
  const VIEWPORTS = [
    { name: "phone-390", width: 390, height: 844 },
    { name: "desktop-1280", width: 1280, height: 900 },
  ] as const;
  const CASES = ["queued", "receipt-delivered", "retired-on-transcript"] as const;
  const LANGS = ["en", "uk"] as const;

  interface BubbleGeometry {
    /** How many launch bubbles the window paints beside the transcript. */
    outboxEntries: number;
    /** The bubble's own delivery state, as the row publishes it. */
    outboxState: string | null;
    /** The delivery wait phase, when the chip is in one. */
    outboxWait: string | null;
    /** The words the operator actually reads under the bubble. */
    statusLabel: string | null;
    /** A spinner under a bubble is the claim the message is still in flight. */
    spinner: boolean;
    /** The transcript's own record of the launch message is always present. */
    transcriptRecords: number;
    /** The window never pushes the page sideways. */
    overflowX: number;
    viewportWidth: number;
  }

  browserTest("the chip reads the receipt, and the transcript retires the bubble", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const geometry: Record<string, BubbleGeometry> = {};
    try {
      browser = await chromium.launch(LAUNCH);
      for (const viewport of VIEWPORTS) {
        for (const id of CASES) {
          for (const lang of LANGS) {
            const url = `${served.base}?case=${id}&lang=${lang}`;
            const { context, page, pageErrors } = await openFixture(
              browser,
              url,
              { width: viewport.width, height: viewport.height },
              "dark",
              lang,
            );
            try {
              await page.waitForSelector(`[data-evidence-case="${id}"]`);
              const reading = await page.evaluate(() => {
                const entry = document.querySelector("[data-outbox-entry]");
                const status = document.querySelector("[data-outbox-status]");
                return {
                  outboxEntries: document.querySelectorAll("[data-outbox-entry]").length,
                  outboxState: entry?.getAttribute("data-outbox-state") ?? null,
                  outboxWait: entry?.getAttribute("data-outbox-wait") ?? null,
                  statusLabel: status?.textContent?.trim() ?? null,
                  spinner: Boolean(document.querySelector("[data-outbox-entry] .animate-spin")),
                  transcriptRecords: document.querySelectorAll("[data-evidence-transcript]").length,
                  overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                  viewportWidth: window.innerWidth,
                };
              });
              expect(pageErrors).toEqual([]);
              geometry[`${id}-${viewport.name}-${lang}`] = reading;
              await page.screenshot({ path: path.join(OUT, `${id}-${viewport.name}-${lang}.png`), fullPage: true });

              /* The transcript's own record is always there, and the window
                 never scrolls sideways at either width. */
              expect(reading.transcriptRecords).toBe(1);
              expect(reading.overflowX).toBe(0);
              if (id === "queued") {
                /* Before the receipt settles, the spinner is the truth. */
                expect(reading.outboxEntries).toBe(1);
                expect(reading.outboxState).toBe("delivering");
                expect(reading.spinner).toBe(true);
              } else if (id === "receipt-delivered") {
                /* The receipt settled it: one bubble, no spinner, no wait. */
                expect(reading.outboxEntries).toBe(1);
                expect(reading.outboxState).toBe("delivered");
                expect(reading.outboxWait).toBeNull();
                expect(reading.spinner).toBe(false);
              } else {
                /* The transcript carries the record: nothing beside it. */
                expect(reading.outboxEntries).toBe(0);
                expect(reading.statusLabel).toBeNull();
              }
            } finally {
              await context.close();
            }
          }
        }
      }
      fs.writeFileSync(path.join(EVIDENCE, "bubble.json"), `${JSON.stringify(geometry, null, 2)}\n`);
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 180_000);
});
