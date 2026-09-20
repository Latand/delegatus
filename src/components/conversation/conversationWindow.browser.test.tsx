import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright-core";

import { translate } from "@/lib/i18n";
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

describe("#1846 recurrence: the first turn that died unauthorized", () => {
  /*
   * Rendered evidence for the auth-terminal presentation fix. The engine wrote
   * one turn-end record and no answer, so what this frame shows IS the whole
   * of what the operator gets: either a failed terminal that names the
   * failure, quotes the provider and says what to do, or — the control case —
   * the quiet completion note a turn that really completed still gets.
   *
   * Both cases at a phone and a desktop viewport, in both languages. Geometry
   * goes to `evidence/issue-1846-auth-terminal/terminal.json`; frames to
   * `.artifacts/issue-1846-auth-terminal/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/issue-1846-auth-terminal");
  const EVIDENCE = path.resolve("evidence/issue-1846-auth-terminal");
  const VIEWPORTS = [
    { name: "phone-390", width: 390, height: 844 },
    { name: "desktop-1280", width: 1280, height: 900 },
  ] as const;
  const CASES = ["auth-terminal", "clean-terminal"] as const;
  /* The fixture's failing record quotes this in a JSON body; assembled from
     parts so no credential-shaped literal is committed. */
  const SENTINEL = ["sk", "live", "9f4c2ab77d31e05c86f0"].join("_");
  const LANGS = ["en", "uk"] as const;

  interface TerminalGeometry {
    /** The failed terminal's own reason, as the row publishes it. */
    turnError: string | null;
    /** The words the operator reads on the row. */
    rowText: string | null;
    /** A completion note beside a failure would be the old lie returning. */
    completionNotes: number;
    /** The row is painted in the danger hue rather than muted grey. */
    danger: boolean;
    /** Nothing credential-shaped survived redaction onto the screen. */
    leaks: number;
    /** The row's painted box, so a frame proves it is actually visible. */
    box: { width: number; height: number } | null;
    overflowX: number;
    viewportWidth: number;
  }

  browserTest("the failed terminal is readable at both widths, and a real completion stays quiet", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const geometry: Record<string, TerminalGeometry> = {};
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
                const row = document.querySelector("[data-turn-error]");
                const rect = row?.getBoundingClientRect();
                const painted = row ? getComputedStyle(row) : null;
                const body = document.body.textContent ?? "";
                return {
                  turnError: row?.getAttribute("data-turn-error") ?? null,
                  rowText: row?.textContent?.trim() ?? null,
                  completionNotes: [...document.querySelectorAll("div")]
                    .filter((node) => node.children.length === 0 && /Task completed|Задачу завершено/.test(node.textContent ?? ""))
                    .length,
                  danger: painted ? painted.borderTopColor !== painted.backgroundColor : false,
                  leaks: (body.match(/[A-Za-z0-9]{24,}/g) ?? []).length,
                  box: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
                  overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                  viewportWidth: window.innerWidth,
                };
              });
              expect(pageErrors).toEqual([]);
              geometry[`${id}-${viewport.name}-${lang}`] = reading;
              await page.screenshot({ path: path.join(OUT, `${id}-${viewport.name}-${lang}.png`), fullPage: true });

              /* Neither case pushes the page sideways, and no credential-shaped
                 run of characters is ever on screen. */
              expect(reading.overflowX).toBe(0);
              expect(reading.leaks).toBe(0);
              if (id === "auth-terminal") {
                /* The failure is on screen, painted, and says all three things:
                   what failed, what the provider said, what to do next. */
                expect(reading.turnError).toBe("auth");
                expect(reading.danger).toBe(true);
                expect(reading.box!.width).toBeGreaterThan(200);
                expect(reading.box!.height).toBeGreaterThan(40);
                expect(reading.completionNotes).toBe(0);
                expect(reading.rowText).toContain(lang === "uk" ? "Помилка авторизації" : "Authorization failed");
                /* The Viewer's own explanation, and never the provider's
                   sentence, which the fixture's record carries verbatim. */
                expect(reading.rowText).toContain(lang === "uk" ? "вхід цього акаунта більше не дійсний" : "sign-in is no longer valid");
                expect(reading.rowText).toContain(lang === "uk" ? "Увійдіть" : "Sign in to it again");
                expect(reading.rowText).not.toContain("refresh token has expired");
                expect(reading.rowText).not.toContain(SENTINEL);
              } else {
                /* A turn that really completed keeps the quiet note it had. */
                expect(reading.turnError).toBeNull();
                expect(reading.completionNotes).toBe(1);
              }
            } finally {
              await context.close();
            }
          }
        }
      }
      fs.writeFileSync(path.join(EVIDENCE, "terminal.json"), `${JSON.stringify(geometry, null, 2)}\n`);
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 180_000);
});

describe("composer stays usable with a dead host", () => {
  /*
   * Rendered evidence for sending with the agent's host gone.
   *
   * The claim is that the operator writes, attaches, and presses Send ONCE —
   * no restore button in front of it — and that the message then says what it
   * is doing. So the frames are: the composer itself on a reclaimed
   * conversation, with a real draft and a real staged image; and the one
   * message's bubble in each state the send passes through, including a resume
   * that failed.
   *
   * The composer case reads its capability props from the production matrix,
   * so a frame cannot show an open picker the shipped matrix would have
   * closed. Every case runs at a phone and a desktop viewport, in both
   * languages — the phone matters twice over here, because its send slot used
   * to turn into «Respawn» the moment the host stopped.
   *
   * Geometry goes to `evidence/dead-host-composer/composer.json`; frames to
   * `.artifacts/dead-host-composer/`, which is not committed.
   */

  const OUT = path.resolve(".artifacts/dead-host-composer");
  const EVIDENCE = path.resolve("evidence/dead-host-composer");
  const VIEWPORTS = [
    { name: "phone-390", width: 390, height: 844 },
    { name: "desktop-1280", width: 1280, height: 900 },
  ] as const;
  const CASES = [
    "dead-host-composer",
    "dead-host-not-resumable",
    "dead-host-queued",
    "dead-host-resuming",
    "dead-host-delivering",
    "dead-host-delivered",
    "dead-host-resume-failed",
  ] as const;
  const LANGS = ["en", "uk"] as const;

  interface DeadHostGeometry {
    /** Whether the field the operator types into is present and writable. */
    fieldEnabled: boolean | null;
    /** The draft actually in it, so a frame proves the text was not dropped. */
    draftLength: number;
    /** Staged attachment tiles that finished decoding: the photo is really there. */
    readyTiles: number;
    /** The attach control, and whether it is open. */
    attachEnabled: boolean | null;
    /** Any reason painted on the attach control — the withheld-images tooltip. */
    attachReason: string | null;
    /** Send, and whether one press is available. */
    sendEnabled: boolean | null;
    /** Dictation, and whether it is available on the same surface. */
    micEnabled: boolean | null;
    /** The blocked-send strip. Present is the gate; absent is the fix. */
    sendBlockedStrip: boolean;
    /** The reason painted where Send is genuinely blocked, which only the
        permanently non-resumable case has. */
    sendBlockedText: string | null;
    /** The phone's one control under the field, by the kind it took. A
        stopped host used to make this «Respawn» with a message already
        written; it has to read as Send. */
    slotKind: string | null;
    slotLabel: string | null;
    /** Whether the blocked Send is really inert, found by the reason it wears
        as its accessible name. */
    blockedSendInert: boolean | null;
    /** The message's own delivery state and wait phase, as the row publishes them. */
    outboxState: string | null;
    outboxWait: string | null;
    /** The words under the bubble the operator actually reads. */
    statusLabel: string | null;
    /** A retry beside a failed message. */
    retryActions: number;
    /** A spinner claims the message is moving. */
    spinner: boolean;
    overflowX: number;
    viewportWidth: number;
  }

  browserTest("one press sends, and the message says what it is doing", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const geometry: Record<string, DeadHostGeometry> = {};
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
              if (id === "dead-host-composer" || id === "dead-host-not-resumable") {
                /* The staged tile decodes asynchronously through the real
                   attachment intake; wait for it rather than racing it. */
                await page.waitForSelector('[data-testid="attachment-tile"][data-status="ready"]');
              }
              const reading = await page.evaluate((labels: { attach: string; send: string; mic: string; retry: string; blocked: string }) => {
                const byLabel = (label: string) =>
                  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
                const field = document.querySelector<HTMLTextAreaElement>("textarea");
                const attach = byLabel(labels.attach);
                const send = byLabel(labels.send);
                const mic = byLabel(labels.mic);
                const entry = document.querySelector("[data-outbox-entry]");
                const status = document.querySelector("[data-outbox-status]");
                return {
                  fieldEnabled: field ? !field.disabled : null,
                  draftLength: field?.value.length ?? 0,
                  readyTiles: document.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]').length,
                  attachEnabled: attach ? !attach.disabled : null,
                  attachReason: attach?.getAttribute("title") ?? null,
                  sendEnabled: send ? !send.disabled && send.getAttribute("aria-disabled") !== "true" : null,
                  micEnabled: mic ? !mic.disabled : null,
                  sendBlockedStrip: Boolean(document.querySelector('[data-testid="composer-send-blocked"]')),
                  sendBlockedText: document.querySelector('[data-testid="composer-send-blocked"]')?.textContent?.trim() ?? null,
                  blockedSendInert: (() => {
                    /* A blocked Send wears its REASON as its accessible name,
                       which is also why it is not found under the send label. */
                    const button = byLabel(labels.blocked);
                    return button ? button.disabled || button.getAttribute("aria-disabled") === "true" : null;
                  })(),
                  /* The phone's slot publishes its own kind on the control. */
                  slotKind: document.querySelector("[data-mobile2-send]")?.getAttribute("data-mobile2-send") ?? null,
                  slotLabel: document.querySelector("[data-mobile2-send]")?.getAttribute("aria-label") ?? null,
                  outboxState: entry?.getAttribute("data-outbox-state") ?? null,
                  outboxWait: entry?.getAttribute("data-outbox-wait") ?? null,
                  statusLabel: status?.textContent?.trim() ?? null,
                  retryActions: document.querySelectorAll(`button[aria-label="${labels.retry}"]`).length,
                  spinner: Boolean(document.querySelector("[data-outbox-entry] .animate-spin")),
                  overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                  viewportWidth: window.innerWidth,
                };
              }, {
                attach: translate(lang, "composer.addAttachments"),
                send: translate(lang, "composer.sendToAgent"),
                mic: translate(lang, "mic.dictate"),
                retry: translate(lang, "outbox.retry"),
                blocked: translate(lang, "deadHost.rootRemoved"),
              });
              expect(pageErrors).toEqual([]);
              geometry[`${id}-${viewport.name}-${lang}`] = reading;
              await page.screenshot({ path: path.join(OUT, `${id}-${viewport.name}-${lang}.png`), fullPage: true });

              expect(reading.overflowX).toBe(0);
              if (id === "dead-host-composer") {
                /* Everything the operator needs to write the message is open,
                   at both widths, in both languages — and nothing tells them
                   to press something else first. */
                expect(reading.fieldEnabled).toBe(true);
                expect(reading.draftLength).toBeGreaterThan(0);
                expect(reading.readyTiles).toBe(1);
                expect(reading.attachEnabled).toBe(true);
                expect(reading.attachReason).toBeNull();
                expect(reading.sendEnabled).toBe(true);
                expect(reading.micEnabled).toBe(true);
                expect(reading.sendBlockedStrip).toBe(false);
                /* The phone's one control under the field is the SEND, with a
                   message already written — never the respawn that used to
                   stand in front of it. At 1280 there is no slot at all and
                   the bar's own Send is the control, which is why the kind is
                   only asserted where the slot renders. */
                if (viewport.width === 390) {
                  expect(reading.slotKind).toBe("send");
                  expect(reading.slotLabel).toBe(translate(lang, "composer.sendToAgent"));
                }
              } else if (id === "dead-host-not-resumable") {
                /* The one permanently non-resumable state. The field, the
                   attachment and the dictation stay exactly as usable — the
                   draft is not confiscated — while Send says why it cannot
                   help and names the action that can. */
                expect(reading.fieldEnabled).toBe(true);
                expect(reading.draftLength).toBeGreaterThan(0);
                expect(reading.readyTiles).toBe(1);
                /* Not found under the send label at all: it wears its reason. */
                expect(reading.sendEnabled).toBeNull();
                expect(reading.blockedSendInert).toBe(true);
                expect(reading.sendBlockedText).toBe(translate(lang, "deadHost.rootRemoved"));
                /* And it is not a retry invitation: no Retry is offered for a
                   state that can never change back. */
                expect(reading.retryActions).toBe(0);
              } else if (id === "dead-host-queued") {
                expect(reading.outboxState).toBe("queued");
                expect(reading.statusLabel).toBe(translate(lang, "outbox.queued"));
              } else if (id === "dead-host-resuming") {
                /* The one state the vocabulary did not have: the send's own
                   recovery, under way, reading and spinning like progress. */
                expect(reading.outboxWait).toBe("resuming-host");
                expect(reading.statusLabel).toBe(translate(lang, "runtime.receipt.resumingHostFor", {
                  waited: translate(lang, "runtime.receipt.waitedMin", { n: 1 }),
                }));
                expect(reading.spinner).toBe(true);
              } else if (id === "dead-host-delivering") {
                /* The host is back and the message is being handed to it: the
                   step between "starting" and "delivered", which the committed
                   case list used to skip over. */
                expect(reading.outboxState).toBe("delivering");
                expect(reading.statusLabel).toBe(translate(lang, "outbox.delivering"));
                expect(reading.retryActions).toBe(0);
              } else if (id === "dead-host-delivered") {
                expect(reading.outboxState).toBe("delivered");
                expect(reading.statusLabel).toBe(translate(lang, "outbox.delivered"));
                expect(reading.spinner).toBe(false);
              } else {
                /* A resume the server gave up on: the reason it gave up for,
                   verbatim, and exactly one retry. */
                expect(reading.outboxState).toBe("failed");
                expect(reading.statusLabel).toContain("account is busy");
                expect(reading.statusLabel).not.toBe(translate(lang, "outbox.failed"));
                expect(reading.retryActions).toBe(1);
              }
            } finally {
              await context.close();
            }
          }
        }
      }
      fs.writeFileSync(path.join(EVIDENCE, "composer.json"), `${JSON.stringify(geometry, null, 2)}\n`);
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 240_000);
});
