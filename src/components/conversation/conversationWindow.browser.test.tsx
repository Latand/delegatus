import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
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
   * message's row in each state the send passes through, including a resume
   * that failed.
   *
   * Since send-latency slice 3 what the row SAYS at rest is one sentence for
   * every unconfirmed state; the transport's own words are its evidence, read
   * here from the affordance that holds them. The frames still cover every
   * state, because the point of this block is that the send works with the
   * host gone, not that each step announces itself.
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
    /** The transport evidence the row's own affordance holds. */
    transportLabel: string | null;
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
                  transportLabel: document.querySelector("[data-outbox-progress]")?.getAttribute("title") ?? null,
                  retryActions: document.querySelectorAll(`button[data-outbox-retry]`).length,
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
                expect(reading.statusLabel).toBe(translate(lang, "outbox.awaitingConfirmation"));
                expect(reading.transportLabel).toBe(translate(lang, "outbox.queued"));
              } else if (id === "dead-host-resuming") {
                /* The one state the vocabulary did not have: the send's own
                   recovery, under way, reading and spinning like progress. */
                expect(reading.outboxWait).toBe("resuming-host");
                expect(reading.transportLabel).toBe(translate(lang, "runtime.receipt.resumingHostFor", {
                  waited: translate(lang, "runtime.receipt.waitedMin", { n: 1 }),
                }));
                expect(reading.spinner).toBe(true);
              } else if (id === "dead-host-delivering") {
                /* The host is back and the message is being handed to it: the
                   step between "starting" and "delivered", which the committed
                   case list used to skip over. */
                expect(reading.outboxState).toBe("delivering");
                expect(reading.transportLabel).toBe(translate(lang, "outbox.delivering"));
                /* The operator reads the same sentence they read a moment ago:
                   the hand-over is progress, not news. */
                expect(reading.statusLabel).toBe(translate(lang, "outbox.awaitingConfirmation"));
                expect(reading.retryActions).toBe(0);
              } else if (id === "dead-host-delivered") {
                expect(reading.outboxState).toBe("delivered");
                /* Arrival clears the affordance; the row is the message. */
                expect(reading.transportLabel).toBeNull();
                expect(reading.spinner).toBe(false);
              } else {
                /* A resume the server gave up on: the reason in the operator's
                   own language — never the runtime's English sentence, which
                   is what they photographed inside the Ukrainian interface —
                   and exactly one action. */
                expect(reading.outboxState).toBe("failed");
                expect(reading.statusLabel).toBe(translate(lang, "outbox.failure.hostBusy"));
                expect(reading.statusLabel).not.toContain("contended attempts");
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

/** The refusals a Telegram launch can leave on a message, by the fixture's
    `?cause=`, with the lines each one renders. */
const TELEGRAM_REFUSALS = ["off", "withdrawn", "conflict"] as const;
const TELEGRAM_REFUSAL_KEYS = {
  off: { outbox: "outbox.failure.telegramOff", cause: "receipt.cause.telegramOff", remedy: "receipt.remedy.telegramOff" },
  withdrawn: { outbox: "outbox.failure.telegramWithdrawn", cause: "receipt.cause.telegramWithdrawn", remedy: "receipt.remedy.telegramWithdrawn" },
  conflict: { outbox: "outbox.failure.telegramNameTaken", cause: "receipt.cause.telegramNameTaken", remedy: "receipt.remedy.telegramNameTaken" },
} as const;

describe("a restart refused for Telegram reads as one line with what to do", () => {
  /*
   * A conversation that holds the Telegram tool used to refuse every message
   * while Telegram was disconnected, and the operator read the runtime's
   * sentence about it twice inside a Ukrainian interface. The restart is no
   * longer refused for that; journals still carry the sentence, and a
   * withdrawn grant still refuses, so the row has to say it well.
   *
   *   LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
   *     bun test src/components/conversation/conversationWindow.browser.test.tsx -t "refused for Telegram"
   *
   * The failed row over `?case=dead-host-telegram-refused`, for the three
   * refusals (Telegram disconnected, the grant withdrawn, the account's own
   * entry in the way), at 390 and 1440 px in en and uk: the reason is one
   * sentence in the interface language with its action, it appears once, and
   * the disclosure behind it prints no raw sentence. Readings go to `evidence/telegram-refusal/outbox.json`; frames to
   * `.artifacts/telegram-refusal/`, which is not committed.
   */
  const OUT = path.resolve(".artifacts/telegram-refusal");
  const EVIDENCE = path.resolve("evidence/telegram-refusal");
  const VIEWPORTS = [
    { name: "phone-390", width: 390, height: 844 },
    { name: "desktop-1440", width: 1440, height: 900 },
  ] as const;

  browserTest("at 390 and 1440 px in en and uk, said once in the interface language", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const readings: Record<string, unknown> = {};
    try {
      browser = await chromium.launch(LAUNCH);
      for (const refusal of TELEGRAM_REFUSALS) for (const viewport of VIEWPORTS) {
        for (const lang of ["en", "uk"] as const) {
          const sentence = translate(lang, TELEGRAM_REFUSAL_KEYS[refusal].outbox);
          const { context, page, pageErrors } = await openFixture(
            browser,
            `${served.base}?case=dead-host-telegram-refused&cause=${refusal}&lang=${lang}`,
            { width: viewport.width, height: viewport.height },
            "dark",
            lang,
          );
          try {
            await page.waitForSelector('[data-evidence-case="dead-host-telegram-refused"]');
            await page.waitForSelector("[data-outbox-reason]");
            const read = () => page.evaluate((sentence: string) => {
              const failure = document.querySelector("[data-outbox-failure]");
              const reason = document.querySelector<HTMLElement>("[data-outbox-reason]");
              const box = reason?.getBoundingClientRect();
              const text = document.body.innerText;
              return {
                statusLabel: document.querySelector("[data-outbox-status]")?.textContent?.trim() ?? null,
                timesSaid: text.split(sentence).length - 1,
                runtimeWords: /MCP|connector|structured host|reclaimed/i.test(text),
                rawLines: document.querySelectorAll("[data-outbox-raw], [data-outbox-transport]").length,
                actions: [...(failure?.querySelectorAll("button") ?? [])].filter((button) => !button.hasAttribute("data-outbox-reason")).length,
                reasonInsideViewport: box ? box.left >= 0 && box.right <= window.innerWidth : false,
                reasonWidth: box ? Math.round(box.width) : 0,
                reasonHeight: box ? Math.round(box.height) : 0,
                overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                viewportWidth: window.innerWidth,
              };
            }, sentence);
            const closed = await read();
            await page.screenshot({ path: path.join(OUT, `${refusal}-${viewport.name}-${lang}.png`), fullPage: true });
            await page.locator("[data-outbox-reason]").first().click();
            await page.waitForSelector("[data-outbox-detail]");
            const open = await read();
            await page.screenshot({ path: path.join(OUT, `${refusal}-${viewport.name}-${lang}-open.png`), fullPage: true });
            readings[`${refusal}-${viewport.name}-${lang}`] = { closed, open };
            expect(pageErrors).toEqual([]);
            for (const reading of [closed, open]) {
              expect(reading.statusLabel).toBe(sentence);
              expect(reading.timesSaid).toBe(1);
              expect(reading.runtimeWords).toBe(false);
              expect(reading.rawLines).toBe(0);
              expect(reading.actions).toBe(1);
              expect(reading.reasonInsideViewport).toBe(true);
              expect(reading.overflowX).toBe(0);
            }
          } finally {
            await context.close();
          }
        }
      }
      fs.writeFileSync(path.join(EVIDENCE, "outbox.json"), `${JSON.stringify(readings, null, 2)}\n`);
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 240_000);
});

describe("the composer's notice for a Telegram refusal fits a phone and says what to do", () => {
  /*
   * The composer's own notice for the same refusal is one clipping line, and
   * its chip is another. With the whole sentence in both, a 390 px phone cut
   * the line before the action, said "send again" twice, and kept the rest in
   * a hover title a phone never shows.
   *
   *   LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
   *     bun test src/components/conversation/conversationWindow.browser.test.tsx -t "composer's notice for a Telegram refusal"
   *
   * `?case=telegram-refused-composer` — one message that failed twice — for
   * the three refusals (Telegram disconnected, the grant withdrawn, the
   * account's own entry in the way), at 390 and
   * 1440 px in en and uk, at rest and expanded: the line and the chip carry the
   * short cause unclipped, the action is a wrapped sentence in the expanded
   * detail, and no line of the notice repeats another. Readings go to
   * `evidence/telegram-refusal/composer-notice.json`; frames to
   * `.artifacts/telegram-refusal/`, which is not committed.
   */
  const OUT = path.resolve(".artifacts/telegram-refusal");
  const EVIDENCE = path.resolve("evidence/telegram-refusal");
  const VIEWPORTS = [
    { name: "phone-390", width: 390, height: 844 },
    { name: "desktop-1440", width: 1440, height: 900 },
  ] as const;

  browserTest("at 390 and 1440 px in en and uk, unclipped, with the action in the expanded detail", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const readings: Record<string, unknown> = {};
    try {
      browser = await chromium.launch(LAUNCH);
      for (const refusal of TELEGRAM_REFUSALS) for (const viewport of VIEWPORTS) {
        for (const lang of ["en", "uk"] as const) {
          const { context, page, pageErrors } = await openFixture(
            browser,
            `${served.base}?case=telegram-refused-composer&cause=${refusal}&lang=${lang}`,
            { width: viewport.width, height: viewport.height },
            "dark",
            lang,
          );
          try {
            await page.waitForSelector('[data-evidence-case="telegram-refused-composer"]');
            await page.waitForSelector("[data-delivery-notice-cause]");
            const read = () => page.evaluate(() => {
              const clipped = (element: HTMLElement | null) => element ? Math.max(0, element.scrollWidth - element.clientWidth) : null;
              const inside = (element: Element | null) => {
                const box = element?.getBoundingClientRect();
                return box ? box.width > 0 && box.left >= 0 && box.right <= window.innerWidth : false;
              };
              const line = document.querySelector<HTMLElement>("[data-delivery-notice-cause]");
              const detail = document.querySelector<HTMLElement>("[data-delivery-notice-sentence]");
              const open = document.querySelector<HTMLDetailsElement>("[data-delivery-notice]")?.open ?? false;
              const chip = document.querySelector<HTMLElement>("[data-receipt-status] .truncate");
              return {
                line: line?.textContent ?? null,
                lineClippedPx: clipped(line),
                lineWidth: line ? Math.round(line.getBoundingClientRect().width) : 0,
                attempts: document.querySelector("[data-delivery-notice-count] [aria-hidden]")?.textContent ?? null,
                detail: open ? detail?.textContent ?? null : null,
                detailInsideViewport: open ? inside(detail) : false,
                detailLines: open && detail ? Math.round(detail.getBoundingClientRect().height / parseFloat(getComputedStyle(detail).lineHeight)) : 0,
                chip: open ? chip?.textContent ?? null : null,
                chipClippedPx: open ? clipped(chip) : null,
                chipInsideViewport: open ? inside(chip) : false,
                runtimeWords: /MCP|connector|structured host|reclaimed/i.test(document.body.innerText),
                overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                viewportWidth: window.innerWidth,
              };
            });
            const closed = await read();
            await page.screenshot({ path: path.join(OUT, `composer-${refusal}-${viewport.name}-${lang}.png`), fullPage: true });
            await page.locator("[data-delivery-notice] > summary").click({ position: { x: 8, y: 20 } });
            await page.waitForSelector("[data-delivery-notice-sentence]", { state: "visible" });
            const open = await read();
            await page.screenshot({ path: path.join(OUT, `composer-${refusal}-${viewport.name}-${lang}-open.png`), fullPage: true });
            readings[`${refusal}-${viewport.name}-${lang}`] = { closed, open };
            expect(pageErrors).toEqual([]);
            const cause = translate(lang, TELEGRAM_REFUSAL_KEYS[refusal].cause);
            const remedy = translate(lang, TELEGRAM_REFUSAL_KEYS[refusal].remedy);
            for (const reading of [closed, open]) {
              /* One line for two failed attempts, with the short cause whole. */
              expect(reading.line).toBe(`${translate(lang, "composer.deliveryFailed")} — ${cause}`);
              expect(reading.lineClippedPx).toBe(0);
              expect(reading.attempts).toBe("×2");
              expect(reading.runtimeWords).toBe(false);
              expect(reading.overflowX).toBe(0);
            }
            /* What to do is read without hover: a wrapped sentence on the page. */
            expect(open.detail).toBe(remedy);
            expect(open.detailInsideViewport).toBe(true);
            expect(open.chip).toBe(translate(lang, "receipt.human.verbatim", { reason: cause }));
            expect(open.chipClippedPx).toBe(0);
            expect(open.chipInsideViewport).toBe(true);
            /* No line of the notice is a copy of another. */
            expect(new Set([open.line, open.detail, open.chip]).size).toBe(3);
            expect(open.line).not.toContain(remedy);
            expect(open.chip).not.toContain(remedy);
          } finally {
            await context.close();
          }
        }
      }
      fs.writeFileSync(path.join(EVIDENCE, "composer-notice.json"), `${JSON.stringify(readings, null, 2)}\n`);
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 240_000);
});

describe("send latency slice 3: one message, one row", () => {
  /*
   * Rendered evidence for the operator's complaint that a sent message passes
   * through a pile of visually different states before it settles.
   *
   * ONE page, one mounted conversation window — the production `LogFeed` and
   * `TmuxComposer` over the production outbox store — and a configurable fake
   * host behind them. The driver types into the real field, submits through
   * the path it is exercising, and then advances the host: a receipt lands,
   * the axes move, the transcript carries the message. Every frame it
   * photographs is a frame that ONE submission really reached, which is the
   * only way a transition can be observed at all. Pre-arranged snapshots of
   * each state, in a fresh context each, is what the previous round did, and
   * it is why a replaced node looked identical to an adopted one.
   *
   * What is written down, per frame: the bubble's painted width, opacity, type
   * size, padding and FULL position (both axes), the words beside the message,
   * the controls on it, and whether the row is still the very same DOM node —
   * marked on the first frame and looked for by that mark afterwards.
   *
   * The number the work is judged by is `distinctRenderings`: how many
   * different descriptions one ordinary message passes through between Send
   * and the transcript's own record of it. `evidence/message-row/
   * before-default-branch.json` is this same driver, unchanged, run against
   * the default branch over the ordinary send alone — which is how the before
   * and the after are the same measurement rather than two descriptions of
   * one. (Only the success scenario runs there: the affordance the other
   * scenarios disclose does not exist on that side.)
   *
   * Every scenario runs at a phone (with touch emulated, as a phone has) and a
   * desktop viewport, in both themes and both languages. Geometry goes to
   * `evidence/message-row/one-row.json`; frames to `.artifacts/message-row/`
   * and, so the operator can look at the pixels before merging, to
   * `/var/tmp/llv-message-row-evidence/`. Neither raster directory is
   * committed.
   */

  const OUT = path.resolve(".artifacts/message-row");
  const EVIDENCE = path.resolve("evidence/message-row");
  const LOOK = "/var/tmp/llv-message-row-evidence";
  const VIEWPORTS = [
    { name: "phone-390", width: 390, height: 844, touch: true },
    { name: "desktop-1280", width: 1280, height: 900, touch: false },
  ] as const;
  const LANGS = ["en", "uk"] as const;
  const THEMES = ["dark", "light"] as const;

  const MESSAGE = "Check what is blocking the release and tell me which lane owns it.";
  const FAILURE_RAW = "structured host recovery failed after 12 contended attempts: account is busy";

  /** One submission's whole life, as steps the driver performs on the page. */
  type Step =
    | { state: string; act: "submit-button" | "submit-keyboard" }
    | { state: string; act: "attach-and-select" }
    /* A non-image attachment, and a send that is nothing BUT an attachment —
       the two shapes whose caption reads differently and whose row the
       adoption used to shrink (round-4 P2). */
    | { state: string; act: "attach-document" }
    | { state: string; act: "attach-image-only" }
    | { state: string; act: "settle"; status: "delivered" | "queued" | "uncertain" }
    | { state: string; act: "axes"; host: string; turn: string }
    | { state: string; act: "echo" }
    /* The provenance read the scenario held open finally answers. */
    | { state: string; act: "release-provenance" }
    | { state: string; act: "disclose"; target: "progress" | "reason" };

  /* `holdProvenance` holds `/api/log/provenance` open from before the
     submission to the step that releases it — the independent review's own
     probe (#1950 round 2, second round), which put two copies of a document
     and of a lost acknowledgement on screen and pushed an image-only row down
     by its own picture for as long as the response took. */
  const SCENARIOS: { id: string; holdProvenance?: true; steps: Step[] }[] = [
    /* An ordinary send that simply works, all the way to the transcript's own
       record being adopted into the row the operator already had. */
    { id: "success", steps: [
      { state: "submitted", act: "submit-button" },
      { state: "accepted", act: "settle", status: "queued" },
      { state: "confirmed", act: "settle", status: "delivered" },
      { state: "transcript", act: "echo" },
    ] },
    /* Admitted and parked: the agent is inside a turn, and a structured send
       only crosses at a turn boundary — and then the turn ends and the message
       goes all the way through. A scenario that stops at the park cannot say
       whether the row survived the arrival, which is the whole claim. */
    { id: "queued-behind-turn", steps: [
      { state: "submitted", act: "submit-keyboard" },
      { state: "queued-behind-turn", act: "axes", host: "hosted", turn: "running" },
      { state: "turn-ended", act: "axes", host: "hosted", turn: "idle" },
      { state: "confirmed", act: "settle", status: "delivered" },
      { state: "transcript", act: "echo" },
    ] },
    /* Admitted while nothing is hosting the conversation: the send raises the
       host on its way to delivering, and the host comes back. */
    { id: "held-for-host", steps: [
      { state: "submitted", act: "submit-button" },
      { state: "held-for-host", act: "axes", host: "recovering", turn: "unknown" },
      { state: "host-back", act: "axes", host: "hosted", turn: "idle" },
      { state: "confirmed", act: "settle", status: "delivered" },
      { state: "transcript", act: "echo" },
    ] },
    /* The acknowledgement never came back. The message may well be in the
       journal, so the row may never say it was not sent — and when the
       transcript then carries the message, that record is the answer nobody
       could get on the wire. It belongs to the row the operator already has:
       binding it beside that row is what put the message on screen TWICE
       (round-4 P1), which is why this scenario now runs through arrival. */
    { id: "lost-acknowledgement", steps: [
      { state: "lost-acknowledgement", act: "submit-button" },
      { state: "lost-acknowledgement-open", act: "disclose", target: "progress" },
      { state: "transcript", act: "echo" },
    ] },
    /* A failure the server proved: one reason in the operator's language, one
       thing to do about it, and the runtime's English sentence one tap away. */
    { id: "safe-failure", steps: [
      { state: "failed", act: "submit-keyboard" },
      { state: "failed-open", act: "disclose", target: "reason" },
    ] },
    /* The submission that carries more than words: a staged image and a
       reference to the card the operator was looking at. Both belong to the
       row from the first frame, and both must survive the transcript's own
       record arriving — the badge is how the operator checks what they asked
       ABOUT, and losing it on arrival is the same defect as losing the node. */
    { id: "attachment-and-context", steps: [
      { state: "prepared", act: "attach-and-select" },
      { state: "submitted-with-attachment", act: "submit-button" },
      { state: "attachment-confirmed", act: "settle", status: "delivered" },
      { state: "attachment-transcript", act: "echo" },
    ] },
    /* The same walk for a DOCUMENT, whose caption is a different sentence and
       whose bytes the transcript does not carry as a picture. */
    { id: "document-attachment", steps: [
      { state: "prepared", act: "attach-document" },
      { state: "submitted-with-document", act: "submit-button" },
      { state: "document-confirmed", act: "settle", status: "delivered" },
      { state: "document-transcript", act: "echo" },
    ] },
    /* And a send that is nothing but a picture — through its own arrival,
       which is where it used to break. It has no text for a record to be
       recognised by, so the feed dropped the record and painted the engine's
       copy of the picture as a row ABOVE the message, moving the operator's
       own row down the conversation (round-2 P2). The record names the
       submission it was written for, so it lands IN that row. */
    { id: "image-only", steps: [
      { state: "prepared", act: "attach-image-only" },
      { state: "submitted-image-only", act: "submit-button" },
      { state: "image-only-confirmed", act: "settle", status: "delivered" },
      { state: "image-only-transcript", act: "echo" },
    ] },
    /* The same three arrivals with the join held open the whole way. The
       document and the picture were admitted, so this browser already holds
       the operation id their records name and binds them itself. The lost
       acknowledgement was never named to it: its record waits for the join
       instead of painting a second copy, and lands in the row when it comes. */
    { id: "document-held-join", holdProvenance: true, steps: [
      { state: "prepared", act: "attach-document" },
      { state: "held-submitted-with-document", act: "submit-button" },
      { state: "held-document-confirmed", act: "settle", status: "delivered" },
      { state: "held-document-transcript", act: "echo" },
      { state: "held-document-released", act: "release-provenance" },
    ] },
    { id: "image-only-held-join", holdProvenance: true, steps: [
      { state: "prepared", act: "attach-image-only" },
      { state: "held-submitted-image-only", act: "submit-button" },
      { state: "held-image-only-confirmed", act: "settle", status: "delivered" },
      { state: "held-image-only-transcript", act: "echo" },
      { state: "held-image-only-released", act: "release-provenance" },
    ] },
    { id: "lost-ack-held-join", holdProvenance: true, steps: [
      { state: "held-lost-acknowledgement", act: "submit-button" },
      { state: "held-lost-ack-transcript", act: "echo" },
      { state: "held-lost-ack-released", act: "release-provenance" },
    ] },
    /* A Claude conversation, with a picture and a card reference riding the
       send. Its record parses as a system row that the renderer resolves back
       into the operator's bubble, and left beside the submission's row that
       was a second confirmed bubble at both widths, settled or not. */
    { id: "claude-canonical", steps: [
      { state: "prepared", act: "attach-and-select" },
      { state: "claude-submitted", act: "submit-button" },
      { state: "claude-confirmed", act: "settle", status: "delivered" },
      { state: "claude-transcript", act: "echo" },
    ] },
  ];

  /** A 48x48 PNG, two-tone: a real image through the production intake. */
  const TILE_PNG = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAX0lEQVR42u3XsQkAIAwEQCcRR3AVW6d3E90g"
    + "FhYKXpHyIVc9n3obM7pcani38wkAAAAA4Ajw+oO7PAAAAADAGUATAwAAANgDmhgAAADAHtDEAAAAAPaAJgYAAAD4DrAAlLbY"
    + "gOGW5kkAAAAASUVORK5CYII=";

  interface RowReading {
    state: string;
    /** Copies of the operator's message on screen. One, always. */
    bubbles: number;
    /** Everything about the bubble a person could see change, both axes. */
    bubble: {
      width: number;
      height: number;
      opacity: string;
      fontSize: string;
      padding: string;
      radius: string;
      /** Distance from the window's right edge, and the bubble's own place in
          the CONVERSATION: its offset inside the feed's scrolled content, which
          is a coordinate the row can actually move within. Measuring it against
          the row's own box (below) is how a move stayed invisible for two
          rounds — a bubble is always at the top of its own row. */
      right: number;
      top: number;
    } | null;
    /** The old, blind reading: the bubble's top inside its own row, which is
        zero whatever happens to the row. Kept so the negative control can show
        that it does not move when the stable coordinate does. */
    topWithinRow: number | null;
    /** Whether the row is still the node the first frame marked. */
    sameNode: boolean;
    /** Whether the bubble inside it is still that node's own body. */
    sameBody: boolean;
    /** Words on the row that are not the message itself. */
    aside: string;
    badge: string;
    inBubble: string;
    /** Controls on the message, by their accessible name. */
    controls: string[];
    /** The conversation's OWN attachment cards — the agent's copy of what the
        submission carried, rendered as its own row below the message. The
        caption inside the bubble is about the submission; this is the picture
        itself, and the two must never be the same thing twice. */
    transcriptAttachments: number;
    /** The row's own phase, where the row publishes one. */
    phase: string | null;
    outboxState: string | null;
    queue: unknown[];
    overflowX: number;
    viewportWidth: number;
  }

  /** Read in the page. The bubble is found by its own surface class, so the
      same reading works against a build that predates this work. */
  const READ = (state: string) => {
    const row = document.querySelector("[data-message-row]")
      ?? document.querySelector("[data-outbox-entry]")
      ?? document.querySelector('[data-feed-kind="user"]');
    const bubbles = [...document.querySelectorAll("div")].filter((node) =>
      node.className.includes("bg-user"));
    const bubble = bubbles[bubbles.length - 1];
    const painted = bubble ? getComputedStyle(bubble) : null;
    const rect = bubble?.getBoundingClientRect();
    const rowRect = (row as HTMLElement | null)?.getBoundingClientRect();
    /* The conversation's own scrolled content is the stable frame of reference:
       a row that moves within the feed moves in this coordinate, and scrolling
       does not. Without a scroller (a fixture that renders one arranged frame)
       the document itself is that frame. */
    const scroller = document.querySelector("[data-log-feed-scroller]") as HTMLElement | null;
    const scrollerRect = scroller?.getBoundingClientRect();
    const feedTop = (rect?: DOMRect) => rect
      ? Math.round(rect.top - (scrollerRect?.top ?? 0) + (scroller?.scrollTop ?? window.scrollY))
      : 0;
    const rowText = row?.textContent ?? "";
    const bubbleText = bubble?.textContent ?? "";
    return {
      state,
      bubbles: bubbles.length,
      bubble: bubble && painted && rect ? {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        opacity: painted.opacity,
        fontSize: painted.fontSize,
        padding: `${painted.paddingTop}/${painted.paddingRight}/${painted.paddingBottom}/${painted.paddingLeft}`,
        radius: painted.borderTopLeftRadius,
        right: Math.round(window.innerWidth - rect.right),
        top: feedTop(rect),
      } : null,
      topWithinRow: rect && rowRect ? Math.round(rect.top - rowRect.top) : null,
      sameNode: Boolean(row && (row as HTMLElement).dataset.observedRow === "1"),
      sameBody: Boolean(bubble && (bubble as HTMLElement).dataset.observedBody === "1"),
      aside: (bubbleText ? rowText.replace(bubbleText, " ") : rowText).replace(/\s+/g, " ").trim(),
      /* What the bubble carries besides the words: the reference to the card
         this turn pointed at, and what the submission was carrying with it. */
      badge: (row?.querySelector("[data-selected-context]")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      inBubble: (bubble?.textContent ?? "").replace(/\s+/g, " ").trim(),
      controls: [...(row?.querySelectorAll("button") ?? [])]
        .map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim())
        .filter(Boolean),
      /* Counted inside the conversation, and counting an inline picture too:
         an image-only send reaches the rollout as an inline `input_image`,
         which the feed renders from its own bytes rather than from a path. */
      transcriptAttachments: document.querySelectorAll(
        '[data-log-feed-scroller] img[src^="/api/inbox"], [data-log-feed-scroller] img[src^="data:image"]',
      ).length,
      phase: row?.getAttribute("data-message-row") ?? null,
      /* The queue's own word for this entry, kept in the record so a frame
         that reads oddly can be traced back to the state it was really in. */
      outboxState: row?.getAttribute("data-outbox-state") ?? null,
      queue: (window as unknown as { llvHost?: { queue(): unknown[] } }).llvHost?.queue() ?? [],
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      viewportWidth: window.innerWidth,
    };
  };

  /** What every DOM mutation between two frames said about the message. */
  interface Watch {
    /** Mutation batches observed since the mark. */
    batches: number;
    /** The most and the fewest copies of the message seen at ANY instant. */
    maxBubbles: number;
    minBubbles: number;
    /** Whether the marked row or its body ever left the document. */
    rowDetached: boolean;
    bodyDetached: boolean;
  }

  /**
   * Mark the row and its body, and start watching every mutation after it.
   *
   * Sampling at the end of each step cannot see a transient: the row being
   * unmounted and a canonical copy mounted in its place inside one 260 ms wait
   * reads exactly like an adoption two frames apart. So from the moment the
   * row exists, every mutation batch is counted — the most and the fewest
   * copies of the message that were ever on screen, and whether the very nodes
   * marked here ever left the document.
   */
  const MARK = () => {
    const row = document.querySelector("[data-message-row]")
      ?? document.querySelector("[data-outbox-entry]")
      ?? document.querySelector('[data-feed-kind="user"]');
    if (row) (row as HTMLElement).dataset.observedRow = "1";
    const bubbles = [...document.querySelectorAll("div")].filter((node) => node.className.includes("bg-user"));
    const bubble = bubbles[bubbles.length - 1];
    if (bubble) (bubble as HTMLElement).dataset.observedBody = "1";
    const watch = { batches: 0, maxBubbles: 0, minBubbles: Number.MAX_SAFE_INTEGER, rowDetached: false, bodyDetached: false };
    const sample = () => {
      watch.batches += 1;
      const copies = [...document.querySelectorAll("div")].filter((node) => node.className.includes("bg-user")).length;
      watch.maxBubbles = Math.max(watch.maxBubbles, copies);
      watch.minBubbles = Math.min(watch.minBubbles, copies);
      if (row && !document.contains(row)) watch.rowDetached = true;
      if (bubble && !document.contains(bubble)) watch.bodyDetached = true;
    };
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    (window as unknown as { llvWatch: { watch: typeof watch; stop(): void } }).llvWatch = {
      watch, stop: () => observer.disconnect(),
    };
  };

  /** Everything the observer saw, and stop watching. */
  const WATCHED = () => {
    const held = (window as unknown as { llvWatch?: { watch: Watch; stop(): void } }).llvWatch;
    held?.stop();
    return held?.watch ?? null;
  };

  /** One message's rendering, as a person would describe it. Two frames with
      the same description are the same rendering, however far apart in the
      message's life they are. */
  const describeRendering = (reading: RowReading): string => JSON.stringify({
    bubble: reading.bubble ? { ...reading.bubble, top: undefined } : null,
    aside: reading.aside,
    inBubble: reading.inBubble,
    controls: reading.controls,
  });

  browserTest("one message keeps one rendering, and one node, from submit to transcript", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.rmSync(LOOK, { recursive: true, force: true });
    fs.mkdirSync(LOOK, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const geometry: Record<string, RowReading> = {};
    /* What the observer saw BETWEEN the frames, per scenario. */
    const watches: Record<string, Watch | null> = {};
    /* The negative control: the same reading, after the row has deliberately
       been moved. It exists to prove the measurement can go red. */
    const moved: Record<string, { before: RowReading; after: RowReading }> = {};
    /* Per viewport: every rendering the ordinary send passed through. */
    const renderings: Record<string, Set<string>> = {};
    try {
      browser = await chromium.launch(LAUNCH);
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          for (const lang of LANGS) {
            /* ONE page for the whole walk: the transitions are the evidence. */
            const { context, page, pageErrors } = await openFixture(
              browser,
              `${served.base}?case=lifecycle&lang=${lang}`,
              { width: viewport.width, height: viewport.height },
              theme,
              lang,
              "no-preference",
              viewport.touch,
            );
            /* The agent's own copy of a pasted attachment. The fixture's fake
               transport cannot answer for it — an `<img src>` is a browser
               resource load and never reaches `fetch` — so it is served here,
               which is what makes the transcript's own attachment card a real
               picture rather than a missing-file chip. */
            await context.route("**/api/inbox*", (route) => route.fulfill({
              status: 200, contentType: "image/png", body: Buffer.from(TILE_PNG, "base64"),
            }));
            try {
              await page.waitForSelector('[data-evidence-case="lifecycle"]');
              await page.waitForSelector("textarea");
              for (const scenario of SCENARIOS) {
                /* A fresh window per scenario, and then ONE window for the
                   whole of it: a lifecycle is what this driver measures, and a
                   composer left mid-reconciliation by the previous scenario
                   would refuse the next submission outright. */
                await page.reload();
                await page.waitForSelector('[data-evidence-case="lifecycle"]');
                await page.waitForSelector("textarea");
                await page.evaluate(([id, hold]) => {
                  const host = (window as unknown as { llvHost: Record<string, (...args: unknown[]) => void> }).llvHost;
                  host.reset();
                  host.scenario(id);
                  if (hold) host.holdProvenance();
                }, [scenario.id, Boolean(scenario.holdProvenance)] as const);
                await page.waitForTimeout(60);
                let marked = false;
                for (const step of scenario.steps) {
                  if (step.act === "attach-and-select") {
                    await page.evaluate(() => (window as unknown as {
                      llvHost: { select(label: string): void };
                    }).llvHost.select("release-blockers"));
                    await page.fill("textarea", MESSAGE);
                    await page.setInputFiles('input[type="file"]', {
                      name: "stack-trace.png", mimeType: "image/png", buffer: Buffer.from(TILE_PNG, "base64"),
                    });
                    await page.waitForSelector('[data-testid="attachment-tile"][data-status="ready"]');
                  } else if (step.act === "attach-document") {
                    await page.fill("textarea", MESSAGE);
                    await page.setInputFiles('input[type="file"]', {
                      name: "release-notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 release notes"),
                    });
                    await page.waitForSelector('[data-testid="attachment-tile"][data-status="ready"]');
                  } else if (step.act === "attach-image-only") {
                    await page.setInputFiles('input[type="file"]', {
                      name: "stack-trace.png", mimeType: "image/png", buffer: Buffer.from(TILE_PNG, "base64"),
                    });
                    await page.waitForSelector('[data-testid="attachment-tile"][data-status="ready"]');
                  } else if (step.act === "submit-button" || step.act === "submit-keyboard") {
                    if (!scenario.steps.some((candidate) => candidate.act.startsWith("attach"))) await page.fill("textarea", MESSAGE);
                    if (step.act === "submit-keyboard") {
                      await page.focus("textarea");
                      await page.keyboard.press("Enter");
                    } else {
                      await page.click('button[type="submit"]');
                    }
                  } else if (step.act === "settle") {
                    await page.evaluate((status) => (window as unknown as {
                      llvHost: { settle(value: string): void };
                    }).llvHost.settle(status), step.status);
                  } else if (step.act === "axes") {
                    await page.evaluate(([host, turn]) => (window as unknown as {
                      llvHost: { axes(host: string, turn: string): void };
                    }).llvHost.axes(host!, turn!), [step.host, step.turn]);
                  } else if (step.act === "echo") {
                    await page.evaluate(() => (window as unknown as {
                      llvHost: { echo(): void };
                    }).llvHost.echo());
                  } else if (step.act === "release-provenance") {
                    await page.evaluate(() => (window as unknown as {
                      llvHost: { releaseProvenance(): void };
                    }).llvHost.releaseProvenance());
                  } else if (step.act === "disclose") {
                    await page.click(step.target === "progress" ? "[data-outbox-progress]" : "[data-outbox-reason]");
                  }
                  await page.waitForTimeout(260);
                  const reading = await page.evaluate(READ, step.state) as RowReading;
                  expect(pageErrors).toEqual([]);
                  const key = `${scenario.id}-${step.state}-${viewport.name}-${theme}-${lang}`;
                  geometry[key] = reading;
                  const frame = `${scenario.id}-${step.state}-${viewport.name}-${theme}-${lang}.png`;
                  await page.screenshot({ path: path.join(OUT, frame), fullPage: true });
                  fs.copyFileSync(path.join(OUT, frame), path.join(LOOK, frame));
                  /* The ordinary send is the walk the churn is counted over:
                     the other scenarios are single states of the same row. */
                  if (scenario.id === "success" && theme === "dark" && lang === "en") {
                    (renderings[viewport.name] ??= new Set()).add(describeRendering(reading));
                  }
                  /* Mark the first frame that HAS a row, so every later frame
                     answers whether that row survived the transition — and
                     start watching every mutation from that instant on. */
                  if (!marked && reading.bubbles > 0) {
                    await page.evaluate(MARK);
                    marked = true;
                  }
                }
                const suffix = `${viewport.name}-${theme}-${lang}`;
                watches[`${scenario.id}-${suffix}`] = await page.evaluate(WATCHED) as Watch | null;
                if (scenario.id === "success") {
                  /* THE NEGATIVE CONTROL. Everything above asserts that the
                     message did not move; an assertion that cannot fail is not
                     evidence, so the row is moved on purpose — a spacer pushed
                     in above it, which is what a re-mounted row elsewhere in
                     the list looks like — and the same reading is taken again.
                     The stable coordinate must see it; the row-relative one
                     the driver used to take must not. */
                  const before = await page.evaluate(READ, "moved-before") as RowReading;
                  const shifted = await page.evaluate(() => {
                    const wrapper = document.querySelector("[data-message-row]")?.closest("[data-feed-kind]");
                    if (!wrapper?.parentElement) return false;
                    const spacer = document.createElement("div");
                    spacer.style.height = "120px";
                    wrapper.parentElement.insertBefore(spacer, wrapper);
                    return true;
                  });
                  expect({ suffix, shifted }).toEqual({ suffix, shifted: true });
                  await page.waitForTimeout(60);
                  moved[suffix] = { before, after: await page.evaluate(READ, "moved-after") as RowReading };
                }
              }
            } finally {
              await context.close();
            }
          }
        }
      }
    } finally {
      /* Written before the assertions so a run that fails still leaves the
         evidence it collected — which is how the before/after counts are
         taken against a build that does not satisfy the claim yet. */
      fs.writeFileSync(
        path.join(EVIDENCE, "one-row.json"),
        `${JSON.stringify({
          distinctRenderings: Object.fromEntries(
            Object.entries(renderings).map(([viewport, set]) => [viewport, set.size]),
          ),
          renderings: Object.fromEntries(
            Object.entries(renderings).map(([viewport, set]) => [viewport, [...set]]),
          ),
          watches,
          moved,
          readings: geometry,
        }, null, 2)}\n`,
      );
      await browser?.close();
      served.stop();
    }

    for (const [key, reading] of Object.entries(geometry)) {
      /* Exactly one copy of the message at every instant of every scenario —
         never the local row beside the transcript's own record. The one frame
         taken BEFORE a submission (the staged attachment and the selected
         card, still in the composer) is the only one with none. */
      const expected = reading.state === "prepared" ? 0 : 1;
      expect({ key, bubbles: reading.bubbles }).toEqual({ key, bubbles: expected });
      expect({ key, overflowX: reading.overflowX }).toEqual({ key, overflowX: 0 });
    }

    /* What happened BETWEEN the frames. From the instant the row existed until
       the last step of its scenario, every mutation batch was counted: the
       message was on screen exactly once at every one of them, and the row
       and the body marked at the start never left the document. A transient
       second copy — the defect itself — cannot slip between two samples. */
    for (const [key, watch] of Object.entries(watches)) {
      expect({ key, watched: Boolean(watch) }).toEqual({ key, watched: true });
      expect({
        key,
        max: watch!.maxBubbles, min: watch!.minBubbles,
        rowDetached: watch!.rowDetached, bodyDetached: watch!.bodyDetached,
      }).toEqual({ key, max: 1, min: 1, rowDetached: false, bodyDetached: false });
      expect({ key, batches: watch!.batches > 1 }).toEqual({ key, batches: true });
    }

    /* And the negative control: with the row deliberately pushed down inside
       the feed, the reading the assertions above compare MUST differ. The
       coordinate the driver used to take — the bubble's top inside its own
       row — does not notice, which is why it was replaced. */
    for (const [suffix, pair] of Object.entries(moved)) {
      expect({ suffix, same: JSON.stringify(pair.after.bubble) === JSON.stringify(pair.before.bubble) })
        .toEqual({ suffix, same: false });
      expect({ suffix, moved: pair.after.bubble!.top - pair.before.bubble!.top > 100 })
        .toEqual({ suffix, moved: true });
      expect({ suffix, blind: pair.after.topWithinRow }).toEqual({ suffix, blind: pair.before.topWithinRow });
      /* Nothing else about the bubble changed: it is the same bubble, moved. */
      expect({ suffix, width: pair.after.bubble!.width }).toEqual({ suffix, width: pair.before.bubble!.width });
    }

    /* The claim, in one number: an ordinary send passes through ONE rendering
       while it is unconfirmed and ONE once it has arrived — and the second is
       already the transcript's own, so nothing changes when the transcript
       catches up. */
    for (const viewport of VIEWPORTS) {
      expect({ viewport: viewport.name, distinct: renderings[viewport.name]?.size }).toEqual({
        viewport: viewport.name, distinct: 2,
      });
    }

    const at = (key: string) => geometry[key]!;
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        for (const lang of LANGS) {
          const suffix = `${viewport.name}-${theme}-${lang}`;
          const submitted = at(`success-submitted-${suffix}`);
          const accepted = at(`success-accepted-${suffix}`);
          const confirmed = at(`success-confirmed-${suffix}`);
          const transcript = at(`success-transcript-${suffix}`);
          /* The phone's own defect: the optimistic row was capped at 75% and
             dimmed, its canonical replacement at 86% and full strength. They
             are one rendering now, so every frame of the walk agrees — down to
             where the bubble sits inside its own row. */
          expect({ suffix, bubble: accepted.bubble }).toEqual({ suffix, bubble: submitted.bubble });
          expect({ suffix, bubble: confirmed.bubble }).toEqual({ suffix, bubble: submitted.bubble });
          expect({ suffix, bubble: transcript.bubble }).toEqual({ suffix, bubble: submitted.bubble });
          /* And it is the SAME node, through every receipt and through the
             transcript's own record arriving — never a replacement that looks
             the same. */
          for (const step of [accepted, confirmed, transcript]) {
            expect({ suffix, state: step.state, sameNode: step.sameNode, sameBody: step.sameBody })
              .toEqual({ suffix, state: step.state, sameNode: true, sameBody: true });
          }
          /* The only difference the whole walk shows is the affordance. */
          expect({ suffix, controls: confirmed.controls }).toEqual({ suffix, controls: transcript.controls });
          expect(submitted.controls).not.toEqual(confirmed.controls);
          expect({ suffix, phase: transcript.phase }).toEqual({ suffix, phase: "confirmed" });

          /* Every other non-failure scenario runs to the same end, and the same
             two things are true of each: the message keeps the node it was
             painted on, and it does not move. A park behind a turn and a wait
             for a host that is coming back are detours, not different
             messages. */
          for (const id of ["queued-behind-turn", "held-for-host"] as const) {
            const start = at(`${id}-submitted-${suffix}`);
            const arrived = at(`${id}-transcript-${suffix}`);
            expect({ suffix, id, bubble: arrived.bubble }).toEqual({ suffix, id, bubble: start.bubble });
            expect({ suffix, id, sameNode: arrived.sameNode, sameBody: arrived.sameBody })
              .toEqual({ suffix, id, sameNode: true, sameBody: true });
            expect({ suffix, id, phase: arrived.phase }).toEqual({ suffix, id, phase: "confirmed" });
          }

          /* A lost acknowledgement never reads as a message that was not sent,
             and what it offers is a question, never a second send. */
          const unknown = at(`lost-acknowledgement-lost-acknowledgement-${suffix}`);
          expect({ suffix, phase: unknown.phase }).toEqual({ suffix, phase: "pending" });
          expect(unknown.aside).toContain(translate(lang, "outbox.awaitingConfirmation"));
          const unknownOpen = at(`lost-acknowledgement-lost-acknowledgement-open-${suffix}`);
          expect(unknownOpen.aside).toContain(translate(lang, "composer.deliveryChecking"));
          expect(unknownOpen.controls).toContain(translate(lang, "outbox.action.checkStatus"));
          expect(unknownOpen.controls).not.toContain(translate(lang, "outbox.action.takeBack"));
          expect(unknownOpen.controls).not.toContain(translate(lang, "outbox.action.retry"));
          /* Opening the evidence never moves the message itself. */
          expect({ suffix, bubble: unknownOpen.bubble }).toEqual({ suffix, bubble: unknown.bubble });
          /* And when the transcript then carries the message, that record is
             the answer the wire never gave. It lands IN the row the operator
             already had: one bubble, the same node, in the same place — not a
             canonical copy mounted beside a spinner (round-4 P1). */
          const unknownArrived = at(`lost-acknowledgement-transcript-${suffix}`);
          expect({ suffix, bubbles: unknownArrived.bubbles }).toEqual({ suffix, bubbles: 1 });
          expect({ suffix, sameNode: unknownArrived.sameNode, sameBody: unknownArrived.sameBody })
            .toEqual({ suffix, sameNode: true, sameBody: true });
          expect({ suffix, phase: unknownArrived.phase }).toEqual({ suffix, phase: "confirmed" });
          expect({ suffix, bubble: unknownArrived.bubble }).toEqual({ suffix, bubble: unknown.bubble });
          /* It reads as arrived, because it arrived: no affordance, and none
             of the wording of an unsettled delivery. */
          expect(unknownArrived.aside).not.toContain(translate(lang, "outbox.awaitingConfirmation"));
          expect(unknownArrived.controls).not.toContain(translate(lang, "outbox.action.checkStatus"));

          /* A proven failure: a concise reason in the operator's language and
             exactly ONE thing to do, with the runtime's English one tap away. */
          const failed = at(`safe-failure-failed-${suffix}`);
          expect({ suffix, phase: failed.phase }).toEqual({ suffix, phase: "failed" });
          expect(failed.aside).toContain(translate(lang, "outbox.failure.hostBusy"));
          expect(failed.aside).not.toContain("contended attempts");
          const actions = failed.controls.filter((label) =>
            label !== translate(lang, "feed.copyMd") && label !== translate(lang, "outbox.failure.hostBusy"));
          expect({ suffix, actions }).toEqual({ suffix, actions: [translate(lang, "outbox.action.retry")] });
          const failedOpen = at(`safe-failure-failed-open-${suffix}`);
          expect(failedOpen.aside).toContain(FAILURE_RAW);
          expect({ suffix, bubble: failedOpen.bubble }).toEqual({ suffix, bubble: failed.bubble });

          /* A submission that carried an image and a reference to a card keeps
             BOTH on its row, through preparation, confirmation and the
             transcript's own record arriving. The attachment line used to
             VANISH at adoption, which shrank the bubble by 19 px on the phone
             at the one moment this slice promises nothing moves (round-4 P2) —
             so the caption is asserted at every step, and the bubble's own box
             is asserted to be byte-identical across all three. */
          const withAttachment = at(`attachment-and-context-submitted-with-attachment-${suffix}`);
          const attachmentConfirmed = at(`attachment-and-context-attachment-confirmed-${suffix}`);
          const attachmentTranscript = at(`attachment-and-context-attachment-transcript-${suffix}`);
          const caption = translate(lang, "composer.imagesCount", { count: 1 });
          for (const step of [withAttachment, attachmentConfirmed, attachmentTranscript]) {
            expect({ suffix, state: step.state, badge: step.badge.includes("release-blockers") })
              .toEqual({ suffix, state: step.state, badge: true });
            expect({ suffix, state: step.state, caption: step.inBubble.includes(caption) })
              .toEqual({ suffix, state: step.state, caption: true });
            expect({ suffix, state: step.state, bubble: step.bubble })
              .toEqual({ suffix, state: step.state, bubble: withAttachment.bubble });
          }
          expect({ suffix, phase: attachmentTranscript.phase }).toEqual({ suffix, phase: "confirmed" });
          expect({ suffix, sameNode: attachmentTranscript.sameNode, sameBody: attachmentTranscript.sameBody })
            .toEqual({ suffix, sameNode: true, sameBody: true });
          /* The picture itself arrives as the conversation's OWN row, once,
             and only once the transcript carries it — so the caption on the
             bubble is a caption about the submission, never a second copy of
             the attachment. */
          expect({ suffix, cards: withAttachment.transcriptAttachments }).toEqual({ suffix, cards: 0 });
          expect({ suffix, cards: attachmentTranscript.transcriptAttachments }).toEqual({ suffix, cards: 1 });

          /* A DOCUMENT rides the same row with its own sentence, and nothing
             about that row changes through confirmation or adoption either.
             The transcript carries no picture for it, which is exactly why the
             caption is the only thing that can say what was carried. */
          const documentSteps = ["submitted-with-document", "document-confirmed", "document-transcript"] as const;
          const documentCaption = translate(lang, "composer.attachmentsCount", { count: 1 });
          const firstDocument = at(`document-attachment-${documentSteps[0]}-${suffix}`);
          for (const state of documentSteps) {
            const step = at(`document-attachment-${state}-${suffix}`);
            expect({ suffix, state, caption: step.inBubble.includes(documentCaption) })
              .toEqual({ suffix, state, caption: true });
            expect({ suffix, state, bubble: step.bubble }).toEqual({ suffix, state, bubble: firstDocument.bubble });
            expect({ suffix, state, cards: step.transcriptAttachments }).toEqual({ suffix, state, cards: 0 });
          }
          expect({ suffix, phase: at(`document-attachment-document-transcript-${suffix}`).phase })
            .toEqual({ suffix, phase: "confirmed" });

          /* And a send that is nothing but a picture: no words for a record to
             recognise it by, so it is recognised by the delivery's identity
             instead — with the same caption, the same box and the same place
             in the conversation through its receipt AND through the engine's
             own record of it arriving. */
          const imageOnlySteps = ["submitted-image-only", "image-only-confirmed", "image-only-transcript"] as const;
          const imageOnly = at(`image-only-submitted-image-only-${suffix}`);
          for (const state of imageOnlySteps) {
            const step = at(`image-only-${state}-${suffix}`);
            expect({ suffix, state, caption: step.inBubble }).toEqual({ suffix, state, caption });
            /* The whole box AND the coordinate: `bubble` carries `top`, the
               offset inside the conversation's own scrolled content, so a row
               pushed down by a picture inserted above it fails here. */
            expect({ suffix, state, bubble: step.bubble }).toEqual({ suffix, state, bubble: imageOnly.bubble });
            /* The first frame is where the node is MARKED, so it cannot
               answer whether it survived anything; every later one must. */
            if (state !== imageOnlySteps[0]) {
              expect({ suffix, state, sameNode: step.sameNode, sameBody: step.sameBody })
                .toEqual({ suffix, state, sameNode: true, sameBody: true });
            }
          }
          /* The picture itself arrives once, as the conversation's own row
             below the message — never a second copy of what the caption
             already says, and never before the record carries it. */
          const imageOnlyTranscript = at(`image-only-image-only-transcript-${suffix}`);
          expect({ suffix, cards: imageOnly.transcriptAttachments }).toEqual({ suffix, cards: 0 });
          expect({ suffix, cards: imageOnlyTranscript.transcriptAttachments }).toEqual({ suffix, cards: 1 });
          expect({ suffix, phase: imageOnlyTranscript.phase }).toEqual({ suffix, phase: "confirmed" });

          /* The document's own arrival, in the same two coordinates. Its
             delivered text is the operator's words plus the inbox path the
             route folded in, so nothing about the record's TEXT matches the
             row — and the row stays exactly where and what it was. */
          const documentTranscript = at(`document-attachment-document-transcript-${suffix}`);
          expect({ suffix, bubble: documentTranscript.bubble }).toEqual({ suffix, bubble: firstDocument.bubble });
          expect({ suffix, sameNode: documentTranscript.sameNode, sameBody: documentTranscript.sameBody })
            .toEqual({ suffix, sameNode: true, sameBody: true });

          /* The join held open for the whole walk. Every frame after the first
             is the node the first one marked, in the same box at the same
             place in the conversation — through the record's arrival AND
             through the read finally answering, which must change nothing. */
          const walks = [
            ["document-held-join", ["held-submitted-with-document", "held-document-confirmed", "held-document-transcript", "held-document-released"]],
            ["image-only-held-join", ["held-submitted-image-only", "held-image-only-confirmed", "held-image-only-transcript", "held-image-only-released"]],
            ["lost-ack-held-join", ["held-lost-acknowledgement", "held-lost-ack-transcript", "held-lost-ack-released"]],
            ["claude-canonical", ["claude-submitted", "claude-confirmed", "claude-transcript"]],
          ] as const;
          for (const [id, states] of walks) {
            const start = at(`${id}-${states[0]}-${suffix}`);
            for (const state of states.slice(1)) {
              const step = at(`${id}-${state}-${suffix}`);
              expect({ suffix, id, state, bubble: step.bubble }).toEqual({ suffix, id, state, bubble: start.bubble });
              expect({ suffix, id, state, sameNode: step.sameNode, sameBody: step.sameBody })
                .toEqual({ suffix, id, state, sameNode: true, sameBody: true });
            }
          }
          /* The document binds while the read is still open: arrived, its own
             words, its caption, and no picture of a file that is not one. */
          const heldDocument = at(`document-held-join-held-document-transcript-${suffix}`);
          expect({ suffix, phase: heldDocument.phase }).toEqual({ suffix, phase: "confirmed" });
          expect({ suffix, caption: heldDocument.inBubble.includes(documentCaption) }).toEqual({ suffix, caption: true });
          expect({ suffix, cards: heldDocument.transcriptAttachments }).toEqual({ suffix, cards: 0 });
          /* The picture binds while the read is open, and arrives once. */
          for (const state of ["held-image-only-transcript", "held-image-only-released"] as const) {
            const step = at(`image-only-held-join-${state}-${suffix}`);
            expect({ suffix, state, phase: step.phase }).toEqual({ suffix, state, phase: "confirmed" });
            expect({ suffix, state, cards: step.transcriptAttachments }).toEqual({ suffix, state, cards: 1 });
          }
          /* The lost acknowledgement's record waits for the join: still the
             one pending row with its question, not settled by its words. */
          const heldLost = at(`lost-ack-held-join-held-lost-ack-transcript-${suffix}`);
          expect({ suffix, phase: heldLost.phase }).toEqual({ suffix, phase: "pending" });
          expect(heldLost.aside).toContain(translate(lang, "outbox.awaitingConfirmation"));
          const releasedLost = at(`lost-ack-held-join-held-lost-ack-released-${suffix}`);
          expect({ suffix, phase: releasedLost.phase }).toEqual({ suffix, phase: "confirmed" });
          /* Claude: one bubble (the global count above), the reference and the
             caption carried through, and the picture exactly once. */
          const claudeArrived = at(`claude-canonical-claude-transcript-${suffix}`);
          expect({ suffix, phase: claudeArrived.phase }).toEqual({ suffix, phase: "confirmed" });
          expect({ suffix, badge: claudeArrived.badge.includes("release-blockers") }).toEqual({ suffix, badge: true });
          expect({ suffix, caption: claudeArrived.inBubble.includes(caption) }).toEqual({ suffix, caption: true });
          expect({ suffix, cards: at(`claude-canonical-claude-confirmed-${suffix}`).transcriptAttachments })
            .toEqual({ suffix, cards: 0 });
          expect({ suffix, cards: claudeArrived.transcriptAttachments }).toEqual({ suffix, cards: 1 });
        }
      }
    }
  }, 1_800_000);

  /*
   * #1950 round 3: equal text never decides for a submission with an identity.
   *
   * Two cases the final review reproduced, walked in the same mounted window:
   *
   *  - `twin-reversed`: two admitted sends of the same words, and only the
   *    second one's record lands. The first is still delivering. It used to
   *    vanish — a count of matching records retired it — and the second
   *    jumped up into its place.
   *  - `foreign-equal-text`: one admitted send beside an equal-text record
   *    naming a delivery the registry cannot resolve. It used to be claimed by
   *    its words: the admitted row went confirmed and kept the foreign
   *    record's anchor as its own.
   *
   * Every message row is read by its submission, with its place in the
   * conversation's scrolled content, and every DOM mutation between frames is
   * watched, so a row that was gone for one batch is caught. Frames go to the
   * look directory with a `round-3-` prefix, beside the earlier rounds'.
   */
  const ROUND3 = [
    { id: "twin-reversed", arrange: ["key-twin-first", "key-twin-second"], steps: [
      { state: "before", records: [] as string[] },
      { state: "after-second-echo", records: ["key-twin-second"] },
      { state: "after-first-echo", records: ["key-twin-second", "key-twin-first"] },
    ] },
    { id: "foreign-equal-text", arrange: ["key-admitted"], steps: [
      { state: "before", records: [] as string[] },
      { state: "foreign-arrived", records: ["key-somebody-else"] },
      { state: "own-arrived", records: ["key-somebody-else", "key-admitted"] },
    ] },
  ] as const;

  interface Round3Row { id: string | null; phase: string | null; top: number; height: number; sameNode: boolean; progress: number }
  interface Round3Reading { state: string; bubbles: number; rows: Round3Row[] }

  const READ_ROWS = (state: string): Round3Reading => {
    const scroller = document.querySelector("[data-log-feed-scroller]") as HTMLElement | null;
    const origin = scroller?.getBoundingClientRect().top ?? 0;
    const offset = scroller?.scrollTop ?? window.scrollY;
    const rows = ([...document.querySelectorAll("[data-message-row]")] as HTMLElement[]).map((row) => {
      const box = row.getBoundingClientRect();
      return {
        /* The mark set on the first frame names the submission and proves
           the node is that frame's; a confirmed row need not publish its
           entry id, so a row without the mark is identified by what it does
           publish, and reads as a new node. */
        id: row.dataset.round3Mark ?? row.getAttribute("data-outbox-entry"),
        phase: row.getAttribute("data-message-row"),
        top: Math.round((box.top - origin + offset) * 2) / 2,
        height: Math.round(box.height * 2) / 2,
        sameNode: row.dataset.round3Mark !== undefined,
        progress: row.querySelectorAll("[data-outbox-progress]").length,
      };
    });
    return {
      state,
      bubbles: [...document.querySelectorAll("div")].filter((node) => node.className.includes("bg-user")).length,
      rows,
    };
  };

  /** Mark every row by its submission and count, per mutation batch, the
      copies on screen and whether any marked row left the document. */
  const MARK_ROWS = () => {
    const marked = ([...document.querySelectorAll("[data-message-row]")] as HTMLElement[]);
    for (const row of marked) row.dataset.round3Mark = row.getAttribute("data-outbox-entry") ?? "";
    const watch = { batches: 0, minBubbles: Number.MAX_SAFE_INTEGER, maxBubbles: 0, detached: [] as string[] };
    const sample = () => {
      watch.batches += 1;
      const copies = [...document.querySelectorAll("div")].filter((node) => node.className.includes("bg-user")).length;
      watch.minBubbles = Math.min(watch.minBubbles, copies);
      watch.maxBubbles = Math.max(watch.maxBubbles, copies);
      for (const row of marked) {
        const id = row.dataset.round3Mark ?? "";
        if (!document.contains(row) && !watch.detached.includes(id)) watch.detached.push(id);
      }
    };
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    (window as unknown as { llvRound3: { watch: typeof watch; stop(): void } }).llvRound3 = { watch, stop: () => observer.disconnect() };
  };
  const ROUND3_WATCHED = () => {
    const held = (window as unknown as { llvRound3?: { watch: unknown; stop(): void } }).llvRound3;
    held?.stop();
    return held?.watch ?? null;
  };

  browserTest("round 3: an equal-text record never takes or hides an admitted row", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.mkdirSync(LOOK, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const readings: Record<string, Round3Reading> = {};
    const watches: Record<string, unknown> = {};
    try {
      browser = await chromium.launch(LAUNCH);
      for (const viewport of VIEWPORTS) {
        const { context, page, pageErrors } = await openFixture(
          browser,
          `${served.base}?case=lifecycle&lang=en`,
          { width: viewport.width, height: viewport.height },
          "dark",
          "en",
          "no-preference",
          viewport.touch,
        );
        try {
          for (const scenario of ROUND3) {
            await page.reload();
            await page.waitForSelector('[data-evidence-case="lifecycle"]');
            await page.waitForSelector("textarea");
            await page.evaluate(([id, keys]) => {
              const host = (window as unknown as { llvHost: { reset(): void; scenario(id: string): void; arrange(keys: string[]): void } }).llvHost;
              host.reset();
              host.scenario(id);
              host.arrange(keys);
            }, [scenario.id, [...scenario.arrange]] as [string, string[]]);
            await page.waitForTimeout(260);
            for (const step of scenario.steps) {
              if (step.records.length) {
                await page.evaluate((keys) => (window as unknown as {
                  llvHost: { records(keys: string[]): void };
                }).llvHost.records(keys), [...step.records]);
                await page.waitForTimeout(400);
              }
              const reading = await page.evaluate(READ_ROWS, step.state) as Round3Reading;
              expect(pageErrors).toEqual([]);
              const key = `${scenario.id}-${step.state}-${viewport.name}`;
              readings[key] = reading;
              const frame = `round-3-${scenario.id}-${step.state}-${viewport.name}.png`;
              await page.screenshot({ path: path.join(OUT, frame), fullPage: true });
              fs.copyFileSync(path.join(OUT, frame), path.join(LOOK, frame));
              if (step.state === "before") await page.evaluate(MARK_ROWS);
            }
            watches[`${scenario.id}-${viewport.name}`] = await page.evaluate(ROUND3_WATCHED);
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser?.close();
      served.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "round-3.json"), `${JSON.stringify({ readings, watches }, null, 2)}\n`);

    for (const viewport of VIEWPORTS) {
      const at = (scenario: string, state: string) => readings[`${scenario}-${state}-${viewport.name}`]!;
      const row = (reading: Round3Reading, id: string) => reading.rows.find((candidate) => candidate.id === id);
      const suffix = viewport.name;

      /* Two admitted equal-text sends, the second's record first. */
      const before = at("twin-reversed", "before");
      const half = at("twin-reversed", "after-second-echo");
      const both = at("twin-reversed", "after-first-echo");
      expect({ suffix, rows: before.rows.map((entry) => [entry.id, entry.phase]) })
        .toEqual({ suffix, rows: [["key-twin-first", "pending"], ["key-twin-second", "pending"]] });
      expect({ suffix, rows: half.rows.map((entry) => [entry.id, entry.phase, entry.sameNode]) })
        .toEqual({ suffix, rows: [["key-twin-first", "pending", true], ["key-twin-second", "confirmed", true]] });
      /* Nothing moved: the first keeps its place while it waits, and the
         second takes its own record where it already was. */
      expect({ suffix, first: row(half, "key-twin-first")!.top }).toEqual({ suffix, first: row(before, "key-twin-first")!.top });
      expect({ suffix, second: row(half, "key-twin-second")!.top }).toEqual({ suffix, second: row(before, "key-twin-second")!.top });
      expect({ suffix, progress: row(half, "key-twin-first")!.progress }).toEqual({ suffix, progress: 1 });
      expect({ suffix, bubbles: half.bubbles }).toEqual({ suffix, bubbles: 2 });
      /* Then the first's own record: both confirmed, each at its own record. */
      expect({ suffix, phases: both.rows.map((entry) => entry.phase) }).toEqual({ suffix, phases: ["confirmed", "confirmed"] });
      expect({ suffix, same: both.rows.every((entry) => entry.sameNode) }).toEqual({ suffix, same: true });
      expect({ suffix, bubbles: both.bubbles }).toEqual({ suffix, bubbles: 2 });
      expect({ suffix, order: both.rows.map((entry) => entry.id) }).toEqual({ suffix, order: ["key-twin-second", "key-twin-first"] });
      expect({ suffix, watch: watches[`twin-reversed-${suffix}`] })
        .toMatchObject({ suffix, watch: { minBubbles: 2, maxBubbles: 2, detached: [] } });

      /* An admitted row beside a foreign equal-text record. */
      const alone = at("foreign-equal-text", "before");
      const foreign = at("foreign-equal-text", "foreign-arrived");
      const own = at("foreign-equal-text", "own-arrived");
      expect({ suffix, rows: alone.rows.map((entry) => [entry.id, entry.phase]) })
        .toEqual({ suffix, rows: [["key-admitted", "pending"]] });
      const waiting = row(foreign, "key-admitted")!;
      expect({ suffix, phase: waiting.phase, same: waiting.sameNode, progress: waiting.progress })
        .toEqual({ suffix, phase: "pending", same: true, progress: 1 });
      /* The foreign record is a message of its own. */
      expect({ suffix, bubbles: foreign.bubbles }).toEqual({ suffix, bubbles: 2 });
      const adopted = row(own, "key-admitted")!;
      expect({ suffix, phase: adopted.phase, same: adopted.sameNode }).toEqual({ suffix, phase: "confirmed", same: true });
      expect({ suffix, bubbles: own.bubbles }).toEqual({ suffix, bubbles: 2 });
      expect({ suffix, watch: watches[`foreign-equal-text-${suffix}`] }).toMatchObject({ suffix, watch: { detached: [] } });
    }
  }, 600_000);
});

describe("#2075 every image an agent looks at", () => {
  /*
   * Rendered evidence for #2075: one conversation per engine viewing pictures
   * the way that engine records it (Claude Read and an MCP screenshot, a Codex
   * code-mode exec and two app-server imageView items, a Copilot view) and a
   * live view_image row. Every picture is a thumbnail under its line at both
   * widths, with no "show" chip and no "[image output]" text; a tap opens the
   * viewer; a file gone from disk is a pill naming it.
   *
   * The pictures on disk are served by the route stub below from rasters
   * encoded here. Frames go to `LLV_AGENT_IMAGES_OUT` (default
   * `.artifacts/agent-images/`), which is not committed.
   */

  const OUT = path.resolve(process.env.LLV_AGENT_IMAGES_OUT ?? ".artifacts/agent-images");
  const FRAMES = [
    { name: "phone-390", width: 390, height: 844, touch: true, scheme: "dark" },
    { name: "phone-390", width: 390, height: 844, touch: true, scheme: "light" },
    { name: "phone-430", width: 430, height: 932, touch: true, scheme: "dark" },
    { name: "desktop-1280", width: 1280, height: 800, touch: false, scheme: "dark" },
  ] as const;
  const LANGS = ["en", "uk"] as const;
  const SERVED = new Set(["/w/shot.png", "/w/live.png"]);

  /* A flat two-tone PNG, encoded in place so no raster is committed. */
  function png(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
      return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = y * (width * 3 + 1) + 1 + x * 3;
        const band = (x + y) % 80 < 40;
        rows[at] = band ? 60 : 200;
        rows[at + 1] = band ? 130 : 90;
        rows[at + 2] = 170;
      }
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  interface ImagesReading {
    thumbnails: number;
    drawn: number;
    insideClosedDisclosure: number;
    chips: number;
    placeholderText: number;
    unavailable: string[];
    commandGroups: number;
    smallControls: number;
    /* The live picture and the settled pictures start at the same x, so a
       picture does not move sideways when its canonical row lands. */
    liveLeft: number | null;
    settledLeft: number[];
    overflowX: number;
  }

  browserTest("every engine's picture is a thumbnail under its line, and a gone file is a pill", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    const raster = png(320, 200);
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch(LAUNCH);
      for (const frame of FRAMES) {
        for (const lang of LANGS) {
          const url = `${served.base}?case=agent-images&lang=${lang}`;
          const { context, page, pageErrors } = await openFixture(
            browser, url, { width: frame.width, height: frame.height }, frame.scheme, lang, "no-preference", frame.touch,
          );
          try {
            await context.route("**/api/artifact?**", (route) => {
              const query = new URL(route.request().url()).searchParams;
              const file = query.get("path") ?? "";
              if (!SERVED.has(file)) {
                return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "file not found", code: "not-found" }) });
              }
              return route.fulfill({ status: 200, contentType: "image/png", body: raster });
            });
            await page.reload();
            await page.waitForSelector('[data-evidence-case="agent-images"]');
            await page.waitForSelector("[data-image-unavailable]");
            await page.waitForFunction(() => [...document.querySelectorAll("img")].every((img) => img.complete));
            const reading: ImagesReading = await page.evaluate(() => {
              const imgs = [...document.querySelectorAll("img")];
              const text = document.body.textContent ?? "";
              return {
                thumbnails: imgs.length,
                drawn: imgs.filter((img) => img.naturalWidth > 0).length,
                insideClosedDisclosure: imgs.filter((img) => img.closest("details:not([open])")).length,
                chips: [...document.querySelectorAll("button")].filter((button) => /\b(show|показати)\b/i.test(button.textContent ?? "")).length,
                placeholderText: (text.match(/\[(image output|вивід зображення)\]/g) ?? []).length,
                unavailable: [...document.querySelectorAll("[data-image-unavailable]")].map((pill) => pill.textContent ?? ""),
                commandGroups: document.querySelectorAll('[data-tool-row="group"]').length,
                smallControls: [...document.querySelectorAll("[data-tool-images] button, [data-live-tool-image] button")]
                  .filter((button) => button.getBoundingClientRect().height < 44).length,
                liveLeft: document.querySelector("[data-live-tool-image] img")?.getBoundingClientRect().left ?? null,
                settledLeft: [...document.querySelectorAll("[data-tool-images] img")].map((img) => img.getBoundingClientRect().left),
                overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
              };
            });
            await page.screenshot({ path: path.join(OUT, `${frame.name}-${frame.scheme}-${lang}.png`), fullPage: true });
            expect(pageErrors).toEqual([]);
            /* Claude ×3, Codex exec + one served imageView, Copilot, the live row. */
            expect(reading.thumbnails).toBe(7);
            expect(reading.drawn).toBe(7);
            expect(reading.insideClosedDisclosure).toBe(0);
            expect(reading.chips).toBe(0);
            expect(reading.placeholderText).toBe(0);
            expect(reading.commandGroups).toBe(0);
            expect(reading.unavailable).toHaveLength(1);
            expect(reading.unavailable[0]).toContain("deleted.png");
            expect(reading.unavailable[0]).toContain(translate(lang, "render.imageGone"));
            expect(reading.overflowX).toBe(0);
            if (frame.touch) expect(reading.smallControls).toBe(0);
            expect(reading.liveLeft).not.toBeNull();
            expect(reading.settledLeft).toHaveLength(6);
            for (const left of reading.settledLeft) expect(Math.abs(left - reading.liveLeft!)).toBeLessThanOrEqual(1);
            /* The desktop keeps the feed's avatar-column indent: 36 px gutter plus the 22 px glyph inset. */
            if (!frame.touch) expect(Math.round(reading.liveLeft!)).toBe(16 + 36 + 22);
            /* A tap opens the full-screen viewer on the picture it tapped. */
            const first = page.locator("[data-tool-images] img").first();
            const source = await first.getAttribute("src");
            await first.click();
            const viewer = page.locator("[role=dialog] img");
            await viewer.waitFor();
            expect(await viewer.getAttribute("src")).toBe(source);
            await page.screenshot({ path: path.join(OUT, `${frame.name}-${frame.scheme}-${lang}-viewer.png`) });
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 240_000);
});

describe("older history of a long conversation keeps its rows, its frames and its text", () => {
  /*
   * A 2,800-line Claude conversation whose window starts at its last 400
   * lines, walked to its start with the Home key. Every page is parsed with the
   * rows of the window already on screen: a row keeps its DOM node from the
   * first page to the last, frame times are recorded, and the text the
   * browser skips for being off screen (`content-visibility: auto`) is still
   * found by find-in-page and still selected by a drag that crosses it.
   *
   * Frames go to `LLV_LONG_HISTORY_OUT` (default `.artifacts/long-history/`),
   * which is not committed; the numbers go to the same directory as JSON.
   */
  const OUT = path.resolve(process.env.LLV_LONG_HISTORY_OUT ?? ".artifacts/long-history");

  interface WalkReading {
    cpu: number;
    loads: number;
    historyStart: number;
    reachedStartMs: number;
    frames: number;
    over50: number;
    over100: number;
    maxFrameMs: number;
    slowFrames: { index: number; ms: number }[];
    longTaskMaxMs: number;
    keptNodes: number;
    markedNodes: number;
    rows: number;
    contentVisibility: string;
  }

  browserTest("the Home key walks to the start without remounting a row and records frame times", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const readings: WalkReading[] = [];
    try {
      browser = await chromium.launch(LAUNCH);
      for (const cpu of [1, 4]) {
        const { context, page, pageErrors } = await openFixture(browser, `${served.base}?case=long-history&turns=700`, { width: 1280, height: 800 }, "dark");
        try {
          const client = await context.newCDPSession(page);
          if (cpu > 1) await client.send("Emulation.setCPUThrottlingRate", { rate: cpu });
          const scroller = page.locator("[data-log-feed-scroller]");
          await scroller.waitFor();
          await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length > 20);
          /* Tag the rows of the first window; React leaves attributes it did
             not set alone, so a tag survives exactly as long as the node does. */
          const markedNodes = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll("[data-feed-key]"));
            for (const row of rows) row.setAttribute("data-first-window", "1");
            (window as unknown as { __long: { frames: number[]; longTasks: number[] } }).__long = { frames: [], longTasks: [] };
            const state = (window as unknown as { __long: { frames: number[]; longTasks: number[] } }).__long;
            try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.longTasks.push(entry.duration); }).observe({ type: "longtask" }); } catch { /* unsupported */ }
            let last = performance.now();
            const tick = (now: number) => { state.frames.push(now - last); last = now; requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
            return rows.length;
          });
          const startedAt = Date.now();
          await scroller.hover();
          let reached = false;
          for (let step = 0; step < 400; step += 1) {
            await page.evaluate(() => (document.querySelector("[data-log-feed-scroller]") as HTMLElement).focus({ preventScroll: true }));
            await page.keyboard.press("Home");
            await page.waitForTimeout(30);
            const atStart = await page.evaluate(() => {
              const el = document.querySelector("[data-log-feed-scroller]") as HTMLElement;
              return /start of the conversation/.test(el.textContent ?? "") && el.scrollTop < 5;
            });
            if (atStart) { reached = true; break; }
          }
          const reachedStartMs = Date.now() - startedAt;
          await page.waitForTimeout(300);
          const reading = await page.evaluate(() => {
            const state = (window as unknown as { __long: { frames: number[]; longTasks: number[] } }).__long;
            const frames = state.frames.slice(1);
            const rows = Array.from(document.querySelectorAll("[data-feed-key]"));
            return {
              loads: (window as unknown as { llvHistory: { loads: () => number } }).llvHistory.loads(),
              historyStart: (window as unknown as { llvHistory: { start: () => number } }).llvHistory.start(),
              frames: frames.length,
              over50: frames.filter((ms) => ms > 50).length,
              over100: frames.filter((ms) => ms > 100).length,
              maxFrameMs: Math.round(Math.max(0, ...frames)),
              slowFrames: frames.map((ms, index) => ({ index, ms: Math.round(ms) })).filter((frame) => frame.ms > 100),
              longTaskMaxMs: Math.round(Math.max(0, ...state.longTasks)),
              keptNodes: rows.filter((row) => row.hasAttribute("data-first-window")).length,
              rows: rows.length,
              contentVisibility: getComputedStyle(rows[0]!).contentVisibility,
            };
          });
          expect(pageErrors).toEqual([]);
          /* The walk ends at the start of the history, never by running out of
             presses: a walk stuck on a stalled auto-reveal must fail here. */
          expect(reached).toBe(true);
          expect(reading.historyStart).toBe(0);
          readings.push({ cpu, reachedStartMs, markedNodes, ...reading });
          fs.writeFileSync(path.join(OUT, "walk.json"), JSON.stringify(readings, null, 2));
          await page.screenshot({ path: path.join(OUT, `at-start-cpu${cpu}.png`) });

          /* Row geometry stays honest: rows off screen are skipped, rows on
             screen are laid out, and nothing scrolls sideways. */
          expect(reading.contentVisibility).toBe("auto");
          expect(reading.loads).toBeGreaterThanOrEqual(1);
          /* Every row of the first window is the same DOM node it was. */
          expect(reading.keptNodes).toBe(markedNodes);
          /* The operator deferred the absolute frame-time target. Both CPU
             runs retain their measurements in walk.json; reaching the start,
             node reuse, find-in-page and selection remain correctness gates. */

          if (cpu === 1) {
            /* Find-in-page reaches text in rows the browser skipped: from the
               start, ask for a row near the end of the loaded history. */
            await page.evaluate(() => { (document.querySelector("[data-log-feed-scroller]") as HTMLElement).scrollTop = 0; getSelection()?.removeAllRanges(); });
            const found = await page.evaluate(() => (window as unknown as { find: (text: string) => boolean }).find("heliotrope-650"));
            expect(found).toBe(true);
            const foundText = await page.evaluate(() => getSelection()?.toString() ?? "");
            expect(foundText).toContain("heliotrope-650");

            /* A selection that starts in the first row and ends hundreds of
               rows later holds the text of both ends and of the rows between,
               skipped or not. */
            const copied = await page.evaluate(() => {
              const rows = Array.from(document.querySelectorAll("[data-feed-key]"));
              const first = rows[0]!;
              const last = rows[Math.min(rows.length - 1, 300)]!;
              const range = document.createRange();
              range.setStartBefore(first);
              range.setEndAfter(last);
              const selection = getSelection()!;
              selection.removeAllRanges();
              selection.addRange(range);
              return selection.toString();
            });
            expect(copied).toContain("heliotrope-0");
            expect(copied).toContain("heliotrope-1");
            expect(copied.length).toBeGreaterThan(5_000);
          }
        } finally {
          await context.close();
        }
      }
      fs.writeFileSync(path.join(OUT, "walk.json"), JSON.stringify(readings, null, 2));
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 300_000);

  /*
   * The own-message step row reads the feed on every scroll frame
   * (docs/design/own-message-steps.md). Over twenty-five days of an
   * orchestrator's conversation, all of it on the page (225 messages of the
   * operator's), one reading takes no selector pass over the feed and a wheel
   * through the history costs what it costs without the row. The numbers go
   * to the same directory, as `own-message-steps.json`.
   */
  const DAYS = 25;
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

  browserTest("one reading per frame is a few bisections, and frame times stay inside the pane's own spread", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch(LAUNCH);
      const run = async (row: boolean) => {
        const { context, page, pageErrors } = await openFixture(browser!, `${served.base}?case=own-message-steps&days=${DAYS}&row=${row ? 1 : 0}`, { width: 1280, height: 800 }, "dark", "en", "reduce");
        try {
          await page.locator("[data-own-message]").first().waitFor();
          /* Bring the whole history onto the page, as a reader at the top does. */
          await page.evaluate(async (own) => {
            const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            for (const deadline = performance.now() + 60_000; scroller.querySelectorAll("[data-own-message]").length < own && performance.now() < deadline;) {
              scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
              if (scroller.scrollTop === 0) scroller.dispatchEvent(new Event("scroll")); else scroller.scrollTop = 0;
              await new Promise((resolve) => setTimeout(resolve, 60));
            }
          }, DAYS * 9);
          expect(await page.locator("[data-own-message]").count()).toBe(DAYS * 9);
          const rows = await page.locator("[data-feed-key]").count();
          const reading = row ? await page.evaluate(() => (window as unknown as { ownSteps: { readCost: (runs: number) => { medianMs: number; meanMs: number; selectorPasses: number } } }).ownSteps.readCost(200)) : null;
          /* A wheel from the start of the history to its end. */
          await page.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
            scroller.scrollTop = 0;
          });
          await page.waitForTimeout(500);
          await page.locator("[data-log-feed-scroller]").hover();
          await page.evaluate(() => {
            const state = { frames: [] as number[] };
            (window as unknown as { __frames: typeof state }).__frames = state;
            let last = performance.now();
            const tick = (now: number) => { state.frames.push(now - last); last = now; requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
          });
          for (let step = 0; step < 300; step += 1) {
            await page.mouse.wheel(0, 900);
            await page.waitForTimeout(16);
          }
          const frames = await page.evaluate(() => (window as unknown as { __frames: { frames: number[] } }).__frames.frames.slice(1));
          expect(pageErrors).toEqual([]);
          return { row, rows, reading, frames: frames.length, medianFrameMs: Math.round(median(frames) * 10) / 10, over50: frames.filter((ms) => ms > 50).length };
        } finally {
          await context.close();
        }
      };
      const runs: Awaited<ReturnType<typeof run>>[] = [];
      for (let pair = 0; pair < 3; pair += 1) { runs.push(await run(true)); runs.push(await run(false)); }
      fs.writeFileSync(path.join(OUT, "own-message-steps.json"), JSON.stringify(runs, null, 2));
      const withRow = runs.filter((entry) => entry.row);
      const without = runs.filter((entry) => !entry.row);
      for (const entry of withRow) {
        expect(entry.reading!.selectorPasses).toBe(0);
        expect(entry.reading!.medianMs).toBeLessThanOrEqual(0.5);
        expect(entry.reading!.meanMs).toBeLessThanOrEqual(0.5);
      }
      /* The pane without the row is the yardstick: its own three runs differ
         from each other, and the row's runs stay inside that spread. */
      const spread = (pick: (entry: typeof runs[number]) => number) => {
        const values = without.map(pick);
        const high = Math.max(...values);
        return high + Math.max(high - Math.min(...values), high * 0.1);
      };
      expect(median(withRow.map((entry) => entry.medianFrameMs))).toBeLessThanOrEqual(spread((entry) => entry.medianFrameMs));
      expect(median(withRow.map((entry) => entry.over50 / entry.frames))).toBeLessThanOrEqual(spread((entry) => entry.over50 / entry.frames) + 0.02);
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 900_000);
});

describe("delivery outcome settlement", () => {
  browserTest("plain delivery status at phone and desktop disappears after confirmation", async () => {
    const out = path.resolve(".artifacts/delivery-outcome");
    fs.mkdirSync(out, { recursive: true });
    const served = await serveEvidenceFixture(out, FIXTURE);
    const browser = await chromium.launch(LAUNCH);
    const evidence: Record<string, unknown> = {};
    try {
      for (const width of [390, 1440]) for (const lang of ["uk", "en"] as const) {
        const { context, page, pageErrors } = await openFixture(browser,
          `${served.base}?case=delivery-settlement&lang=${lang}`, { width, height: 900 }, "dark", lang,
          "reduce", width === 390);
        const key = `${width}-${lang}`;
        try {
          const line = page.locator("[data-delivery-notice-cause]");
          await line.waitFor();
          /* The notice line speaks for a send that has ended, so an unknown
             outcome there is a check that is over: since #2545 it reads
             "Delivery unconfirmed", and "Checking delivery…" belongs to a
             delivery still in flight, which the card case below draws. */
          expect(await line.textContent()).toBe(translate(lang, "composer.deliveryCheckEnded"));
          expect(await page.locator("[data-delivery-notice-retry]").getAttribute("aria-label"))
            .toBe(translate(lang, "composer.payloadRecheck"));
          await page.locator("[data-delivery-notice-retry]").click();
          expect(await page.locator("[data-fixture-sends]").textContent()).toBe("0");
          await page.screenshot({ path: path.join(out, `unconfirmed-${key}.png`), fullPage: true });
          await page.locator("[data-confirm-delivery]").click();
          await page.waitForFunction(() => !document.querySelector("[data-runtime-receipt-stack]"));
          await page.screenshot({ path: path.join(out, `delivered-${key}.png`), fullPage: true });
          await page.locator("[data-refuse-delivery]").click();
          await line.waitFor();
          expect(await line.textContent()).toBe(translate(lang, "composer.deliveryNotDelivered"));
          await page.locator("[data-delivery-notice-retry]").click();
          expect(await page.locator("[data-fixture-sends]").textContent()).toBe("1");
          const geometry = await line.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
              overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth), text: element.textContent };
          });
          expect(geometry.overflowX).toBe(0);
          expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
          evidence[key] = geometry;
          await page.screenshot({ path: path.join(out, `not-delivered-${key}.png`), fullPage: true });
          expect(pageErrors).toEqual([]);
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/delivery-outcome", { recursive: true });
      fs.writeFileSync("evidence/delivery-outcome/receipts.json", JSON.stringify(evidence, null, 2) + "\n");
    } finally { await browser.close(); served.stop(); }
  }, 120_000);
});

describe("delivery check card", () => {
  /*
   * The card for a delivery whose fate is unconfirmed, above the production
   * composer: an English handoff relayed by another project's orchestrator.
   * Three states and widths, both languages, both schemes. `LLV_DELIVERY_CARD_SIDE=before`
   * runs the same case over a checkout that still draws the earlier card and
   * records its geometry under `before`; the default records `after` and gates
   * it. Geometry goes to `evidence/delivery-check-card/card.json`; frames to
   * `.artifacts/delivery-check-card/`, which is not committed.
   */
  const side = process.env.LLV_DELIVERY_CARD_SIDE === "before" ? "before" : "after";
  const VIEWPORTS = [
    { name: "desktop-1440", width: 1440, height: 900, touch: false },
    { name: "pane-1000", width: 1000, height: 800, touch: false },
    { name: "phone-390", width: 390, height: 844, touch: true },
  ] as const;

  browserTest("the card is compact, says its status once and stays clear of the composer", async () => {
    const out = path.resolve(".artifacts/delivery-check-card");
    fs.mkdirSync(out, { recursive: true });
    const served = await serveEvidenceFixture(out, FIXTURE);
    const browserServer = await chromium.launchServer(LAUNCH);
    const browserProcess = browserServer.process();
    const browserPid = browserProcess.pid;
    const browser = await chromium.connect(browserServer.wsEndpoint());
    const readings: Record<string, unknown> = {};
    try {
      for (const state of ["failed", "uncertain", "delivering"] as const) for (const viewport of VIEWPORTS) for (const lang of ["en", "uk"] as const) for (const scheme of ["light", "dark"] as const) {
        const { context, page, pageErrors } = await openFixture(browser,
          `${served.base}?case=delivery-check-card&lang=${lang}&state=${state}`, { width: viewport.width, height: viewport.height },
          scheme, lang, "reduce", viewport.touch);
        const key = state === "failed" ? `${viewport.name}-${lang}-${scheme}` : `${state}-${viewport.name}-${lang}-${scheme}`;
        try {
          const status = translate(lang, side === "before" || state !== "failed" ? "composer.deliveryChecking" : "composer.deliveryCheckEnded");
          await page.locator("[data-runtime-receipt-stack] > summary").click();
          await page.locator("[data-receipt-discard]").waitFor();
          const read = () => page.evaluate((statusText) => {
            const box = (element: Element) => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
            const stack = document.querySelector("[data-runtime-receipt-stack]")!;
            const details = document.querySelector("[data-runtime-receipt-details]")!;
            const card = details.firstElementChild as HTMLElement;
            const message = card.querySelector("[data-receipt-message]") as HTMLElement;
            const messageStyle = getComputedStyle(message);
            const buttons = [...card.querySelectorAll("[data-receipt-uncertain-retry], [data-receipt-discard]")].map(box);
            const detail = card.querySelector("[data-receipt-uncertain-why]") as HTMLElement;
            const detailStyle = getComputedStyle(detail);
            const field = document.querySelector("textarea")!;
            /* Elements whose own text is the status and that take up room. */
            const statusShown = [...stack.querySelectorAll("*")].filter((node) =>
              node.children.length === 0 && node.textContent?.trim() === statusText
              && (node as HTMLElement).getBoundingClientRect().width > 1).length;
            const cardStyle = getComputedStyle(card);
            const children = [...card.children].filter((child) => getComputedStyle(child).position !== "absolute");
            const used = children.reduce((sum, child) => sum + child.getBoundingClientRect().height, 0)
              + parseFloat(cardStyle.rowGap || "0") * Math.max(0, children.length - 1)
              + parseFloat(cardStyle.paddingTop) + parseFloat(cardStyle.paddingBottom);
            return {
              stack: box(stack), card: box(card), field: box(field),
              messageAlign: messageStyle.textAlign,
              messageWidth: Math.round(message.getBoundingClientRect().width),
              messageLines: Math.round(message.getBoundingClientRect().height / parseFloat(messageStyle.lineHeight)),
              buttonHeights: buttons.map((button) => Math.round(button.height)),
              statusShown,
              detailText: detail.textContent?.trim(),
              detailLines: Math.round(detail.getBoundingClientRect().height / parseFloat(detailStyle.lineHeight)),
              detailFullyVisible: detail.scrollHeight <= detail.clientHeight + 1 && detail.scrollWidth <= detail.clientWidth + 1,
              discardDisabled: (card.querySelector("[data-receipt-discard]") as HTMLButtonElement).disabled,
              boilerplateShown: card.textContent!.includes("carries no operator authority"),
              /* Column cards only: room the card holds beyond its own rows. */
              cardSlack: cardStyle.flexDirection === "column" ? Math.round(card.getBoundingClientRect().height - used) : null,
              detailsScrolls: details.scrollHeight > details.clientHeight + 1,
              /* Both controls are inside the part of the list that is drawn. */
              controlsInView: buttons.every((button) => button.bottom <= details.getBoundingClientRect().bottom + 0.5
                && button.top >= details.getBoundingClientRect().top - 0.5),
              overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            };
          }, status);
          const reading = await read();
          readings[key] = reading;
          await page.screenshot({ path: path.join(out, `${side}-${key}.png`), fullPage: true });
          expect(pageErrors).toEqual([]);
          expect(reading.overflowX).toBe(0);
          if (side === "after") {
            expect(reading.statusShown).toBe(1);
            expect(["left", "start"]).toContain(reading.messageAlign);
            expect(reading.messageLines).toBeLessThanOrEqual(2);
            expect(reading.boilerplateShown).toBe(false);
            expect(reading.cardSlack).toBeLessThanOrEqual(1);
            expect(reading.detailsScrolls).toBe(false);
            expect(reading.controlsInView).toBe(true);
            expect(reading.discardDisabled).toBe(state === "delivering");
            expect(reading.detailFullyVisible).toBe(true);
            expect(reading.detailText).toBe(translate(lang, state === "delivering"
              ? "composer.deliveryDiscardHandover" : state === "failed"
                ? "composer.deliveryCheckEndedDetail" : "composer.deliveryCheckingDetail"));
            if (viewport.touch) {
              if (state === "failed") expect(reading.card.height).toBeLessThanOrEqual(144);
              expect(reading.detailLines).toBeLessThanOrEqual(2);
            }
            /* The settled chips' size: a caption-height pill with a mouse, the
               44px touch target on a phone. */
            for (const height of reading.buttonHeights) {
              if (viewport.touch) expect(height).toBe(44);
              else expect(height).toBe(23);
            }
            /* Nothing of the card reaches the field under it. */
            expect(reading.stack.bottom).toBeLessThanOrEqual(reading.field.top);
            expect(await page.locator("[data-receipt-relay-label]").textContent())
              .toBe(translate(lang, "composer.relayLabel", { project: "Atlas" }));
            /* Expanding shows the whole handoff and still clears the field. */
            await page.locator("[data-receipt-message-toggle]").click();
            const expanded = await read();
            expect(expanded.messageLines).toBeGreaterThan(2);
            expect(expanded.controlsInView).toBe(true);
            expect(expanded.stack.bottom).toBeLessThanOrEqual(expanded.field.top);
            expect(expanded.overflowX).toBe(0);
            await page.screenshot({ path: path.join(out, `${side}-${key}-expanded.png`), fullPage: true });
            await page.locator("[data-receipt-message-toggle]").click();
            await page.locator("[data-receipt-uncertain-retry]").click();
            expect(await page.locator("[data-fixture-retries]").textContent()).toBe("1");
            if (state !== "delivering") {
              await page.locator("[data-receipt-discard]").click();
              await page.waitForFunction(() => !document.querySelector("[data-runtime-receipt-stack]"));
            }
          }
        } finally { await context.close(); }
      }
      const file = "evidence/delivery-check-card/card.json";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const recorded = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : {};
      fs.writeFileSync(file, JSON.stringify({ ...recorded, [side]: readings }, null, 2) + "\n");
    } finally {
      await browser.close();
      await browserServer.close();
      console.error(`delivery check card: closed owned browser PID ${browserPid}`);
      served.stop();
    }
  }, 300_000);
});

describe("own-message step row", () => {
  /*
   * The row that steps between the operator's own messages
   * (docs/design/own-message-steps.md): a row of its own between the feed and
   * the composer. The fixture's `own-message-steps` case mounts the production
   * pane over an orchestrator's day, with the row (`row=1`) and without it
   * (`row=0`), and the two are driven side by side: every moment is measured
   * in both, so whatever the row changed about the pane is on record.
   *
   * Per control: a hit-test at its centre and four corners answers with the
   * control itself, its box intersects no other interactive element and no
   * part of the feed's viewport, it is inside the window, and on the phone a
   * button is at least 44 x 44. Per pane: against the pane without the row,
   * only the feed's height and the place of the rows riding above the step
   * row may differ, by the row's own height.
   *
   * Frames go to `.artifacts/own-message-steps/` (not committed); the
   * measurements to `evidence/own-message-steps/row.json`.
   */
  const OUT = path.resolve(".artifacts/own-message-steps");
  const EVIDENCE = path.resolve("evidence/own-message-steps");
  const VIEWPORTS = [
    { name: "desktop-1440", width: 1440, height: 900, phone: false, pane: 0, surface: "pane" },
    { name: "desktop-1000", width: 1000, height: 800, phone: false, pane: 0, surface: "pane" },
    /* A board-node-sized pane: the narrowest the desktop draws. */
    { name: "desktop-1000-pane-440", width: 1000, height: 800, phone: false, pane: 440, surface: "pane" },
    /* The orchestrator's conversation in its dock column. */
    { name: "desktop-1000-orchestrator-440", width: 1000, height: 800, phone: false, pane: 440, surface: "orchestrator" },
    { name: "phone-390", width: 390, height: 844, phone: true, pane: 0, surface: "pane" },
  ] as const;
  const LANGS = ["en", "uk"] as const;
  /** The on-screen keyboard's height on a 390 x 844 phone. */
  const KEYBOARD_PX = 336;
  const LOADED_OWN = 7;
  const ALL_OWN = 9;
  /** What the row costs the feed. */
  const ROW_PX = { desktop: 37, phone: 45 } as const;
  /** The feed's own way-back row, which the phone's step row takes in. */
  const JUMP_PX = 44;

  type Box = [x: number, y: number, width: number, height: number];
  interface ControlReading {
    name: string;
    box: Box;
    /** Centre and four corners all answer with the control itself. */
    hit: boolean;
    /** Other interactive elements whose box intersects this one. */
    overlaps: string[];
    /** Any part of it lies inside the feed's viewport. */
    overFeed: boolean;
    insideWindow: boolean;
  }
  interface Reading {
    controls: ControlReading[];
    probes: Record<string, Box>;
    overflowX: number;
    /** The count as the row prints it; null without the row. */
    count: string | null;
    row: Box | null;
    /** Own messages on the page, and how many of them start at or above the reading line. */
    own: number;
    machine: number;
    /** Where the own message being read sits under the feed's top edge. */
    landedAt: number | null;
    atFeedEnd: boolean;
    /** The agent's answer to that message has started inside the feed's viewport. */
    replyOnScreen: boolean;
    jumpStrips: number;
  }
  interface Moved { probe: string; delta: Box }

  const measure = (page: import("playwright-core").Page, fromEnd: number) => page.evaluate((fromEnd): Reading => {
    const box = (element: Element): [number, number, number, number] => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10) as [number, number, number, number];
    };
    const cut = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const shown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    };
    const name = (element: Element) => {
      const text = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.getAttribute("data-testid")
        ?? element.getAttribute("placeholder") ?? (element.textContent ?? "").trim().slice(0, 28);
      return `${element.tagName.toLowerCase()}:${text}`;
    };
    const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
    const feed = scroller.getBoundingClientRect();
    const controls = Array.from(document.querySelectorAll<HTMLElement>("[data-own-step-control]")).filter(shown);
    const interactive = Array.from(document.querySelectorAll<HTMLElement>(
      'button, a[href], textarea, input, select, summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [tabindex]:not([tabindex="-1"])',
    )).filter(shown);
    const readings = controls.map((control) => {
      const rect = control.getBoundingClientRect();
      /* A rounded corner is not part of the control, so the corner points sit
         just inside the rounding. */
      const inset = Math.ceil((parseFloat(getComputedStyle(control).borderTopLeftRadius) || 0) * 0.3) + 1;
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
      ] as const;
      return {
        name: control.dataset.ownStepControl!,
        box: box(control),
        hit: points.every(([x, y]) => { const at = document.elementFromPoint(x, y); return at !== null && control.contains(at); }),
        /* A row scrolled out of the feed is clipped by it, so what counts
           of a control inside the feed is the part the feed shows. */
        overlaps: interactive
          .filter((other) => other !== control && !other.contains(control) && !control.contains(other))
          .filter((other) => {
            const at = other.getBoundingClientRect();
            if (!scroller.contains(other)) return cut(rect, at) > 1;
            const top = Math.max(at.top, feed.top);
            const bottom = Math.min(at.bottom, feed.bottom);
            return bottom > top && cut(rect, new DOMRect(at.left, top, at.width, bottom - top)) > 1;
          })
          .map(name),
        overFeed: cut(rect, feed) > 1,
        insideWindow: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    });

    /* The rest of the pane, by name: its structure, then every interactive
       element outside the feed (rows inside it move with the scroll) and
       outside the step row. */
    const probes: Record<string, [number, number, number, number]> = {};
    const put = (key: string, element: Element | null | undefined) => { if (element && shown(element)) probes[key] = box(element); };
    const header = document.querySelector("[data-mobile2-bar]") ?? document.querySelector("[data-link-path] > header");
    put("header", header);
    put("title", document.querySelector("[data-mobile2-title]") ?? header?.querySelector(".truncate"));
    put("feed", scroller);
    put("jump-strip", document.querySelector("[data-feed-jump-strip]"));
    put("jump-pill", document.querySelector("[data-feed-jump-pill]"));
    const last = scroller.parentElement?.parentElement?.lastElementChild;
    put("turn-status", last === scroller.parentElement || last?.matches("[data-feed-jump-strip]") ? null : last);
    put("composer", document.querySelector('[data-testid="composer-input-unit"]'));
    put("field", document.querySelector("textarea"));
    const seen = new Map<string, number>();
    for (const element of interactive) {
      if (scroller.contains(element) || element.closest("[data-own-steps]") || element.tagName === "TEXTAREA") continue;
      const group = element.closest("[data-mobile2-tools]") ? "tools" : element.closest('[data-testid="composer-input-unit"]') ? "composer"
        : element.closest("[data-mobile2-bar], [data-link-path] > header") ? "header" : element.closest('[role="dialog"]') ? "sheet" : "control";
      const key = `${group}:${name(element)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      probes[count > 1 ? `${key} #${count}` : key] = box(element);
    }

    const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-own-message]"));
    const current = rows[rows.length - 1 - fromEnd];
    let reply: Element | null = current?.nextElementSibling ?? null;
    while (reply && reply.getAttribute("data-feed-kind") !== "prose") reply = reply.nextElementSibling;
    const replyTop = reply?.getBoundingClientRect().top ?? Infinity;
    const row = document.querySelector("[data-own-steps]");
    return {
      controls: readings,
      probes,
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      count: document.querySelector('[data-own-step-control="count"]')?.textContent ?? null,
      row: row ? box(row) : null,
      own: rows.length,
      machine: scroller.querySelectorAll('[data-feed-kind="tmsg"]').length,
      landedAt: current ? Math.round(current.getBoundingClientRect().top - feed.top) : null,
      atFeedEnd: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1,
      replyOnScreen: replyTop >= feed.top && replyTop < feed.bottom,
      jumpStrips: document.querySelectorAll("[data-feed-jump-strip]").length,
    };
  }, fromEnd);

  /* The pane without the row has no step of its own, so it is put where the
     pane with the row went: the same own message on the reading line, as a
     reader's scroll, with older history brought the same way. */
  const follow = (page: import("playwright-core").Page, fromEnd: number, own: number, phone: boolean) => page.evaluate(async ({ fromEnd, own, phone }) => {
    const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const asReader = (to: number) => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: to > scroller.scrollTop ? 1 : -1, bubbles: true }));
      if (scroller.scrollTop === to) scroller.dispatchEvent(new Event("scroll"));
      else scroller.scrollTop = to;
    };
    const rows = () => Array.from(scroller.querySelectorAll<HTMLElement>("[data-own-message]"));
    for (const deadline = performance.now() + 6_000; rows().length < own && performance.now() < deadline;) {
      asReader(0);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const row = rows()[rows().length - 1 - fromEnd];
    if (!row) return;
    for (const until = performance.now() + 600; performance.now() < until;) {
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const wanted = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, phone ? Math.floor(top) : Math.round(top - 8)));
      if (Math.abs(wanted - scroller.scrollTop) >= 1) asReader(wanted);
      await frame();
    }
  }, { fromEnd, own, phone });

  const moved = (baseline: Reading, reading: Reading): Moved[] => {
    const out: Moved[] = [];
    for (const probe of new Set([...Object.keys(baseline.probes), ...Object.keys(reading.probes)])) {
      const was = baseline.probes[probe];
      const now = reading.probes[probe];
      if (!was || !now) { out.push({ probe: `${probe} ${was ? "gone" : "new"}`, delta: [0, 0, 0, 0] }); continue; }
      const delta = now.map((value, index) => Math.round((value - was[index]!) * 10) / 10) as Box;
      if (delta.some((value) => Math.abs(value) > 0.5)) out.push({ probe, delta });
    }
    return out;
  };
  /* The record is one file and each case owns its sections of it, so a case
     run alone leaves the other's readings as they were. */
  const writeEvidence = (sections: Record<string, Record<string, unknown>>) => {
    const file = path.join(EVIDENCE, "row.json");
    const kept = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>> : {};
    const all = { ...kept, ...sections };
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(file, `{\n${Object.entries(all).map(([section, moments]) => `  ${JSON.stringify(section)}: {\n${
      Object.entries(moments).map(([moment, reading]) => `    ${JSON.stringify(moment)}: ${JSON.stringify(reading)}`).join(",\n")
    }\n  }`).join(",\n")}\n}\n`);
  };
  const position = (reading: Reading) => Number(reading.count?.split(" / ")[0] ?? NaN);
  const total = (reading: Reading) => Number.parseInt(reading.count?.split(" / ")[1] ?? "", 10);

  browserTest("the row covers nothing and costs the feed its own height, at every width, in both languages", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    const server = await chromium.launchServer(LAUNCH);
    const browserPid = server.process().pid!;
    const browser = await chromium.connect(server.wsEndpoint());
    const failures: string[] = [];
    const evidence: Record<string, Record<string, unknown>> = {};
    const totals: Record<string, { readings: number; hitTestPasses: number; intersections: number; overFeed: number; outsideWindow: number; underSize: number; undeclaredChanges: number }> = {};
    try {
      for (const viewport of VIEWPORTS) for (const lang of LANGS) {
        const where = `${viewport.name}-${lang}`;
        const query = `case=own-message-steps&lang=${lang}${viewport.pane ? `&pane=${viewport.pane}` : ""}&surface=${viewport.surface}`;
        const size = { width: viewport.width, height: viewport.height };
        const withRow = await openFixture(browser, `${served.base}?${query}&row=1`, size, "dark", lang, "reduce", viewport.phone);
        const without = await openFixture(browser, `${served.base}?${query}&row=0`, size, "dark", lang, "reduce", viewport.phone);
        const page = withRow.page;
        const base = without.page;
        const sum = totals[viewport.name] ??= { readings: 0, hitTestPasses: 0, intersections: 0, overFeed: 0, outsideWindow: 0, underSize: 0, undeclaredChanges: 0 };
        const fail = (moment: string, what: string) => failures.push(`${where} ${moment}: ${what}`);
        const settled = () => page.waitForTimeout(650);
        const cost = viewport.phone ? ROW_PX.phone : ROW_PX.desktop;
        const press = async (direction: -1 | 1) => {
          await page.locator(`[data-own-step-control="${direction < 0 ? "previous" : "next"}"]`).click();
          await settled();
        };
        const record = async (moment: string, fromEnd: number, shot: boolean): Promise<Reading> => {
          const reading = await measure(page, fromEnd);
          const baseline = await measure(base, fromEnd);
          /* The pane without the row shows its way-back row exactly while the
             reader is away from the tail. */
          const away = baseline.jumpStrips > 0;
          /* What the row says it changes. The feed gives up the row's height;
             on the phone, away from the tail, the feed's own way-back row is
             a cell of the step row, so the feed gives up the difference. */
          const feedCost = viewport.phone && away ? cost - JUMP_PX : cost;
          const changes = moved(baseline, reading);
          const undeclared = changes.filter(({ probe, delta }) => {
            if (probe === "feed") return !(delta[0] === 0 && delta[1] === 0 && delta[2] === 0 && Math.abs(delta[3] + feedCost) <= 0.5);
            if (viewport.phone) return !/^(jump-strip gone|jump-pill|control:button:.* gone)$/.test(probe);
            return !(/^(jump-strip|jump-pill|turn-status|control:.*)$/.test(probe) && delta[0] === 0 && delta[2] === 0 && delta[3] === 0 && Math.abs(delta[1] + cost) <= 0.5);
          });
          for (const change of undeclared) fail(moment, `undeclared change to "${change.probe}" by ${JSON.stringify(change.delta)}`);
          if (!changes.some((change) => change.probe === "feed")) fail(moment, "the feed did not give up the row's height");
          if (!reading.row || Math.abs(reading.row[3] - cost) > 0.5) fail(moment, `the row is ${reading.row?.[3]} px tall, expected ${cost}`);
          if (baseline.row) fail(moment, "the pane without the row drew one");
          const buttons = reading.controls.filter((control) => control.name !== "count");
          if (buttons.length < 2 || !reading.controls.some((control) => control.name === "count")) fail(moment, "the row is missing a control");
          for (const control of reading.controls) {
            sum.readings += 1;
            if (control.hit) sum.hitTestPasses += 1; else fail(moment, `${control.name} is not what a pointer meets at its centre and corners`);
            if (control.overlaps.length) { sum.intersections += control.overlaps.length; fail(moment, `${control.name} intersects ${control.overlaps.join(", ")}`); }
            if (control.overFeed) { sum.overFeed += 1; fail(moment, `${control.name} lies over the feed`); }
            if (!control.insideWindow) { sum.outsideWindow += 1; fail(moment, `${control.name} leaves the window`); }
            if (viewport.phone && control.name !== "count" && (control.box[2] < 44 || control.box[3] < 44)) { sum.underSize += 1; fail(moment, `${control.name} is ${control.box[2]} x ${control.box[3]}, under 44 px`); }
          }
          sum.undeclaredChanges += undeclared.length;
          if (reading.overflowX) fail(moment, `the page scrolls sideways by ${reading.overflowX}`);
          if (viewport.phone && away && reading.jumpStrips) fail(moment, "the phone spends a second row on the way back");
          if (viewport.phone && away && !reading.controls.some((control) => control.name === "latest")) fail(moment, "the way back is not in the step row");
          if (!viewport.phone && away && reading.jumpStrips !== 1) fail(moment, "the desktop lost its way-back row");
          (evidence[where] ??= {})[moment] = { count: reading.count, row: reading.row, controls: reading.controls, changedAgainstNoRow: changes };
          if (shot) {
            await page.screenshot({ path: path.join(OUT, `${where}-${moment}.png`) });
            await base.screenshot({ path: path.join(OUT, `${where}-${moment}-no-row.png`) });
          }
          return reading;
        };
        try {
          for (const each of [page, base]) {
            await each.locator("[data-own-message]").first().waitFor();
            await each.waitForTimeout(650);
          }

          /* At rest: the tail, nothing typed. Only what the operator typed is
             counted; wakes, notices and pipeline messages are relay cards. */
          const rest = await record("rest", 0, true);
          expect(rest.own).toBe(LOADED_OWN);
          expect(rest.machine).toBeGreaterThanOrEqual(20);
          expect(rest.count).toBe(`${LOADED_OWN} / ${LOADED_OWN}+`);
          expect(await page.locator('[data-own-step-control="next"]').isDisabled()).toBe(true);

          /* Three steps back: the message stepped to is at the top of the feed
             and its answer is under it. */
          await press(-1); await press(-1); await press(-1);
          let now = await measure(page, 0);
          let fromEnd = total(now) - position(now);
          await follow(base, fromEnd, now.own, viewport.phone);
          const stepped = await record("stepped", fromEnd, true);
          /* From the tail the first step goes to the message the reply on
             screen answers, which is the last one unless it is still in view. */
          expect([LOADED_OWN - 3, LOADED_OWN - 2]).toContain(position(stepped));
          expect(stepped.count).toBe(`${position(stepped)} / ${LOADED_OWN}+`);
          const lands = viewport.phone ? 0 : 8;
          if (stepped.landedAt === null || Math.abs(stepped.landedAt - lands) > 2) fail("stepped", `the message landed ${stepped.landedAt}px under the feed's top`);
          if (!stepped.replyOnScreen) fail("stepped", "the reply to the message is not on screen");
          /* The phone's feed moves itself to a row boundary after a reader's
             scroll (#1978); a landing it accepts is still there later. */
          await page.waitForTimeout(900);
          const rested = await measure(page, fromEnd);
          if (rested.landedAt !== stepped.landedAt) fail("stepped", `the feed moved the landed message from ${stepped.landedAt}px to ${rested.landedAt}px`);

          /* A draft of several lines; on the phone, the keyboard up as well. */
          for (const each of [page, base]) await each.locator("textarea").first().fill("one\ntwo\nthree\nfour\nfive\nsix");
          await page.waitForTimeout(300);
          await record("six-line-draft", fromEnd, true);
          if (viewport.phone) {
            for (const each of [page, base]) await each.evaluate((px) => (window as unknown as { ownSteps: { keyboard: (px: number) => void } }).ownSteps.keyboard(px), KEYBOARD_PX);
            await page.waitForTimeout(300);
            await record("keyboard", fromEnd, true);
            for (const each of [page, base]) await each.evaluate(() => (window as unknown as { ownSteps: { keyboard: (px: number) => void } }).ownSteps.keyboard(0));
          }
          for (const each of [page, base]) {
            await each.locator("textarea").first().fill("");
            await each.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          }
          await page.waitForTimeout(300);

          /* A step forward comes back to where the count says, and the keys
             do what the buttons do, from inside the composer too. */
          await press(1);
          now = await measure(page, 0);
          if (position(now) !== position(stepped) + 1) fail("forward", `position ${position(now)} after ${position(stepped)}`);
          const draft = "one\ntwo\nthree\nfour\nfive\nsix";
          await page.locator("textarea").first().fill(draft);
          await page.locator("textarea").first().evaluate((field) => { (field as HTMLTextAreaElement).setSelectionRange(5, 5); });
          await page.locator("textarea").first().focus();
          await page.keyboard.press("Alt+ArrowUp");
          await settled();
          now = await measure(page, 0);
          if (position(now) !== position(stepped)) fail("keys", `Alt+ArrowUp left the position at ${position(now)}`);
          await page.keyboard.press("Alt+ArrowDown");
          await settled();
          now = await measure(page, 0);
          if (position(now) !== position(stepped) + 1) fail("keys", `Alt+ArrowDown left the position at ${position(now)}`);
          expect(await page.locator("textarea").first().inputValue()).toBe(draft);
          expect(await page.locator("textarea").first().evaluate((field) => {
            const input = field as HTMLTextAreaElement;
            return [input.selectionStart, input.selectionEnd, document.activeElement === input];
          })).toEqual([5, 5, true]);
          await page.locator("textarea").first().fill("");
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

          /* All the way back. A step back from the oldest loaded message asks
             the feed for the page before it and finishes there, so the walk
             ends on the conversation's first own message with the count no
             longer open-ended and nothing left to step back to. */
          for (let presses = 0; presses < ALL_OWN + 2; presses += 1) {
            if (await page.locator('[data-own-step-control="previous"]').isDisabled()) break;
            await press(-1);
          }
          now = await measure(page, 0);
          fromEnd = total(now) - position(now);
          await follow(base, fromEnd, ALL_OWN, viewport.phone);
          const oldest = await record("oldest", fromEnd, true);
          expect(oldest.count).toBe(`1 / ${ALL_OWN}`);
          expect(oldest.own).toBe(ALL_OWN);
          if (!oldest.replyOnScreen) fail("oldest", "the reply to the message is not on screen");
          if (oldest.landedAt === null || Math.abs(oldest.landedAt - lands) > 2) fail("oldest", `the message landed ${oldest.landedAt}px under the feed's top`);
          expect(await page.locator('[data-own-step-control="previous"]').isDisabled()).toBe(true);

          /* The way back, from the step row on the phone and from the feed's
             own row on the desktop, returns to the tail. */
          await page.locator('button:has([data-feed-jump-pill])').click();
          await settled();
          const tail = await measure(page, 0);
          if (await page.locator("[data-feed-jump-pill]").count()) fail("tail", "the way back did not reach the tail");
          expect(tail.count).toBe(`${ALL_OWN} / ${ALL_OWN}`);
          expect([...withRow.pageErrors, ...without.pageErrors]).toEqual([]);
        } finally {
          await withRow.context.close();
          await without.context.close();
        }
      }

      /* Fewer than two own messages: nothing to step between, so no row. */
      for (const own of [1, 2] as const) {
        const { context, page, pageErrors } = await openFixture(browser, `${served.base}?case=own-message-steps&own=${own}`, { width: 1440, height: 900 }, "dark", "en", "reduce");
        try {
          await page.locator("[data-own-message]").first().waitFor();
          await page.waitForTimeout(650);
          expect(await page.locator("[data-own-message]").count()).toBe(own);
          expect(await page.locator("[data-own-steps]").count()).toBe(own === 2 ? 1 : 0);
          (evidence["own-messages"] ??= {})[String(own)] = { row: own === 2 };
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
      }

      writeEvidence({ totals, ...evidence });
      expect(failures).toEqual([]);
    } finally {
      await browser.close(); await server.close(); served.stop();
      let alive = false;
      try { process.kill(browserPid, 0); alive = true; } catch { /* Recorded browser exited. */ }
      expect(alive).toBe(false);
    }
  }, 1_800_000);

  type Page = import("playwright-core").Page;
  type Controls = { arrive: (kind: "work" | "replies" | "turn" | "voice", count: number) => void };
  const arrive = (page: Page, kind: "work" | "replies" | "turn" | "voice", count: number) =>
    page.evaluate(({ kind, count }) => (window as unknown as { ownSteps: Controls }).ownSteps.arrive(kind, count), { kind, count });
  const countOf = (page: Page) => page.locator('[data-own-step-control="count"]').textContent({ timeout: 1_000 }).catch(() => null);
  /** Where the feed is: how far from its end, whether it shows its way back,
      and where the own message being read starts under its top edge. */
  const place = (page: Page) => page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
    const feed = scroller.getBoundingClientRect();
    const count = document.querySelector('[data-own-step-control="count"]')?.textContent ?? null;
    const own = Array.from(scroller.querySelectorAll<HTMLElement>("[data-own-message]"));
    const nearest = own.map((row) => Math.round(row.getBoundingClientRect().top - feed.top)).sort((a, b) => Math.abs(a) - Math.abs(b))[0] ?? null;
    return {
      count,
      row: document.querySelectorAll("[data-own-steps]").length,
      toEnd: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
      wayBack: document.querySelectorAll("[data-feed-jump-pill]").length,
      nextDisabled: document.querySelector<HTMLButtonElement>('[data-own-step-control="next"]')?.disabled ?? null,
      nearestOwnTop: nearest,
    };
  });

  browserTest("empty steps return an untouched tail and its last visible own message", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    const server = await chromium.launchServer(LAUNCH);
    const browserPid = server.process().pid!;
    const browser = await chromium.connect(server.wsEndpoint());
    const evidence: Record<string, Record<string, unknown>> = {};
    try {
      for (const size of [
        { name: "desktop-1440", width: 1440, height: 900, phone: false },
        { name: "phone-390", width: 390, height: 844, phone: true },
      ]) for (const lang of LANGS) for (const turns of [1, 2]) {
        const { context, page, pageErrors } = await openFixture(browser,
          `${served.base}?case=own-message-steps&lang=${lang}&own=0&trailing=150&tailOnly=1&row=1`, size, "dark", lang, "reduce", size.phone);
        try {
          await page.locator("[data-log-feed-scroller]").waitFor();
          for (let turn = 0; turn < turns; turn += 1) await arrive(page, "turn", 1);
          await page.locator('[data-own-step-control="previous"]').waitFor();
          await page.waitForTimeout(650);
          const before = await place(page);
          expect(before.count).toBe(`${turns} / ${turns}+`);
          const previous = page.locator('[data-own-step-control="previous"]');
          if (size.phone) await previous.tap(); else await previous.click();
          await page.waitForTimeout(650);
          const after = await place(page);
          expect(after.wayBack).toBe(0);
          expect(after.toEnd).toBe(0);
          expect(after.count).toBe(turns === 1 ? null : "2 / 2");
          if (turns === 2) {
            expect(await previous.isDisabled()).toBe(true);
            expect(after.nextDisabled).toBe(true);
            if (!size.phone) expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-own-steps"))).toBe(true);
          }
          await arrive(page, "replies", 6);
          await page.waitForTimeout(650);
          const replies = await place(page);
          expect(replies.toEnd).toBe(0);
          expect(replies.wayBack).toBe(0);
          evidence[`empty-step-${size.name}-${lang}-${turns}`] = { before, after, replies };
          await page.screenshot({ path: path.join(OUT, `empty-step-${size.name}-${lang}-${turns}.png`) });
          expect(pageErrors).toEqual([]);
        } finally { await context.close(); }
      }
      /* A slow page need not produce another revision before the deadline.
         On the phone also exercise the long reply interval under CPU 4x. */
      for (const size of [
        { name: "desktop-1440", width: 1440, height: 900, phone: false },
        { name: "phone-390", width: 390, height: 844, phone: true },
      ]) {
        const { context, page, pageErrors } = await openFixture(browser,
          `${served.base}?case=own-message-steps&own=0&trailing=${size.phone ? 4000 : 150}&tailOnly=1&older=30000`, size, "dark", "en", "reduce", size.phone);
        try {
          if (size.phone) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
          await page.locator('[data-own-step-control="previous"]').waitFor();
          await page.waitForTimeout(650);
          const previous = page.locator('[data-own-step-control="previous"]');
          if (size.phone) await previous.tap(); else await previous.click();
          await page.waitForTimeout(100);
          /* Shortcuts from a control inside the scroller must retain the
             original tail ownership through a repeat and a disabled direction. */
          await page.locator("[data-log-feed-scroller] button").last().focus();
          expect(await page.evaluate(() => document.querySelector("[data-log-feed-scroller]")!.contains(document.activeElement))).toBe(true);
          await page.keyboard.press("Alt+ArrowUp");
          await page.keyboard.press("Alt+ArrowDown");
          const waitStarted = await page.evaluate(() => performance.now());
          await page.waitForTimeout(18_000);
          /* CPU throttling can leave a commit in flight when the timer is
             due. Read the settled result; it must arrive within the review's
             forty-second observation window even through that long frame. */
          await page.waitForFunction(() => !document.querySelector("[data-feed-jump-pill]"), undefined, { timeout: 20_000 });
          await page.waitForTimeout(650);
          const expired = await place(page);
          const restoredAfterMs = Math.round(await page.evaluate(() => performance.now()) - waitStarted);
          expect(restoredAfterMs).toBeLessThanOrEqual(40_000);
          evidence[`empty-step-deadline-${size.name}`] = { expired, restoredAfterMs };
          writeEvidence(evidence);
          await page.screenshot({ path: path.join(OUT, `empty-step-deadline-${size.name}.png`) });
          expect({ scenario: size.name, ...expired }).toMatchObject({ wayBack: 0, toEnd: 0 });
          await arrive(page, "replies", 6);
          await page.waitForTimeout(1000);
          const replies = await place(page);
          expect(replies.wayBack).toBe(0);
          expect(replies.toEnd).toBe(0);
          evidence[`empty-step-deadline-${size.name}`] = { expired, restoredAfterMs, replies };
          if (size.phone) {
            await page.waitForTimeout(13_000);
            const latePage = await place(page);
            expect(latePage.wayBack).toBe(0);
            expect(latePage.toEnd).toBe(0);
            evidence[`empty-step-deadline-${size.name}`] = { expired, restoredAfterMs, replies, latePage };
          }
          expect(pageErrors).toEqual([]);
        } finally { await context.close(); }
      }
      writeEvidence(evidence);
    } finally {
      await browser.close(); await server.close(); served.stop();
      let alive = false;
      try { process.kill(browserPid, 0); alive = true; } catch { /* Recorded browser exited. */ }
      expect(alive).toBe(false);
    }
  }, 120_000);

  browserTest("the row holds through a long turn, a way back mid-step, the phone's resting tail and arriving rows", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    const server = await chromium.launchServer(LAUNCH);
    const browserPid = server.process().pid!;
    const browser = await chromium.connect(server.wsEndpoint());
    const failures: string[] = [];
    const evidence: Record<string, Record<string, unknown>> = {};
    const SIZES = [
      { name: "desktop-1440", width: 1440, height: 900, phone: false },
      { name: "phone-390", width: 390, height: 844, phone: true },
    ] as const;
    try {
      const open = (query: string, size: { width: number; height: number }, lang: "en" | "uk", phone: boolean) =>
        openFixture(browser!, `${served.base}?case=own-message-steps&lang=${lang}${query}`, size, "dark", lang, "reduce", phone);
      const ready = async (page: Page) => {
        await page.locator("[data-own-message]").first().waitFor();
        await page.waitForTimeout(650);
      };
      const previous = (page: Page) => page.locator('[data-own-step-control="previous"]');

      /* A long turn of the agent's after the last own message: the page shows
         the last rows of what is loaded, so every own message slides off it.
         The row stays, its total does not shrink while the reader is at the
         tail, and the walk back reaches every own message in turn, by the
         button and by the key. */
      for (const size of SIZES) {
        const where = `long-turn-${size.name}`;
        const { context, page, pageErrors } = await open("", size, "en", size.phone);
        const fail = (what: string) => failures.push(`${where}: ${what}`);
        try {
          await ready(page);
          const atTail: unknown[] = [];
          let onPage = LOADED_OWN;
          for (let chunk = 1; chunk <= 30 && onPage > 0; chunk += 1) {
            await arrive(page, "work", 20);
            await page.waitForTimeout(350);
            const now = await place(page);
            onPage = await page.locator("[data-own-message]").count();
            atTail.push({ calls: chunk * 20, count: now.count, ownOnPage: onPage });
            if (now.row !== 1) fail(`no row after ${chunk * 20} tool calls`);
            if (now.count !== `${LOADED_OWN} / ${LOADED_OWN}+`) fail(`count ${now.count} after ${chunk * 20} tool calls`);
            if (now.wayBack) fail("the feed left its tail while rows arrived");
          }
          if (onPage !== 0) fail("the long turn did not push every own message off the page");
          await page.screenshot({ path: path.join(OUT, `${where}-tail.png`) });
          /* Each step lands on the own message before: the ninth, the eighth
             and so on to the first. The feed brings older history as the
             reader nears the top, so the total opens up along the way. */
          const lands = size.phone ? 0 : 8;
          const walk: (string | null)[] = [];
          for (let fromEnd = 0; fromEnd < ALL_OWN; fromEnd += 1) {
            if (fromEnd % 2 && !size.phone) {
              await page.locator("textarea").first().focus();
              await page.keyboard.press("Alt+ArrowUp");
            } else await previous(page).click();
            await page.waitForFunction(({ fromEnd, lands }) => {
              const [at, of] = (document.querySelector('[data-own-step-control="count"]')?.textContent ?? "").split(" / ");
              const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
              const top = scroller.getBoundingClientRect().top;
              return Number.parseInt(of ?? "", 10) - Number(at) === fromEnd
                && Array.from(scroller.querySelectorAll("[data-own-message]")).some((row) => Math.abs(row.getBoundingClientRect().top - top - lands) <= 2);
            }, { fromEnd, lands }, { timeout: 8_000 }).catch(() => undefined);
            await page.waitForTimeout(650);
            const now = await place(page);
            walk.push(now.count);
            const [at, of] = (now.count ?? "").split(" / ");
            if (Number.parseInt(of ?? "", 10) - Number(at) !== fromEnd) fail(`step ${fromEnd + 1} shows ${now.count}`);
            if (now.nearestOwnTop === null || Math.abs(now.nearestOwnTop - lands) > 2) fail(`step ${fromEnd + 1} landed ${now.nearestOwnTop}px under the feed's top`);
          }
          if (walk.at(-1) !== `1 / ${ALL_OWN}`) fail(`the walk ended on ${walk.at(-1)}`);
          if (!await previous(page).isDisabled()) fail("a step back is still offered on the first own message");
          evidence[where] = { "at-tail": atTail, "walk-back": walk };
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
      }

      /* The way back to the tail, pressed while a step is still landing and
         while a step is waiting for an older page that takes three seconds. */
      for (const size of SIZES) {
        const where = `way-back-${size.name}`;
        const record: Record<string, unknown> = {};
        const pill = (page: Page) => page.locator("button:has([data-feed-jump-pill])");
        for (const pause of [60, 250]) {
          const { context, page, pageErrors } = await open("", size, "en", size.phone);
          try {
            await ready(page);
            await previous(page).click(); await page.waitForTimeout(650);
            await previous(page).click(); await page.waitForTimeout(650);
            await previous(page).click();
            await page.waitForTimeout(pause);
            await pill(page).click();
            await page.waitForTimeout(1_200);
            const soon = await place(page);
            await page.waitForTimeout(2_800);
            const later = await place(page);
            record[`mid-landing-${pause}ms`] = { soon, later };
            for (const [when, now] of [["1.2 s", soon], ["4 s", later]] as const) {
              if (now.wayBack) failures.push(`${where} ${pause} ms: the way back is still offered after ${when}, ${now.toEnd}px from the end at ${now.count}`);
              if (now.count !== `${LOADED_OWN} / ${LOADED_OWN}+`) failures.push(`${where} ${pause} ms: count ${now.count} after ${when}`);
            }
            expect(pageErrors).toEqual([]);
          } finally {
            await context.close();
          }
        }
        const { context, page, pageErrors } = await open("&older=3000", size, "en", size.phone);
        try {
          await ready(page);
          for (let presses = 0; presses < LOADED_OWN + 1 && await countOf(page) !== `1 / ${LOADED_OWN}+`; presses += 1) {
            await previous(page).click();
            await page.waitForTimeout(650);
          }
          expect(await countOf(page)).toBe(`1 / ${LOADED_OWN}+`);
          await previous(page).click();
          await page.waitForTimeout(700);
          await pill(page).click();
          await page.waitForTimeout(1_200);
          const soon = await place(page);
          await page.waitForTimeout(2_800);
          const later = await place(page);
          record["waiting-for-older-page"] = { soon, later };
          for (const [when, now] of [["1.2 s", soon], ["4 s", later]] as const) {
            if (now.wayBack) failures.push(`${where} older page: the way back is still offered after ${when}, ${now.toEnd}px from the end at ${now.count}`);
          }
          if (later.count !== `${ALL_OWN} / ${ALL_OWN}`) failures.push(`${where} older page: count ${later.count} once the page arrived`);
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
        evidence[where] = record;
      }

      /* #1978: a phone feed that follows the tail rests with a row starting
         at its top edge, up to a row short of the very end. While it holds
         the tail the count names the last own message on screen and there is
         no next, whatever the height. */
      for (const lang of LANGS) {
        const record: Record<string, unknown> = {};
        for (let height = 780; height <= 900; height += 10) {
          const { context, page, pageErrors } = await open("", { width: 390, height }, lang, true);
          try {
            await ready(page);
            await arrive(page, "turn", 1);
            await page.waitForTimeout(900);
            const now = await place(page);
            record[String(height)] = { toEnd: now.toEnd, count: now.count, nextDisabled: now.nextDisabled, wayBack: now.wayBack };
            const wanted = `${LOADED_OWN + 1} / ${LOADED_OWN + 1}+`;
            if (now.wayBack) failures.push(`phone-tail-${lang} ${height}: the feed is not holding its tail`);
            if (now.count !== wanted) failures.push(`phone-tail-${lang} ${height}: count ${now.count}, ${now.toEnd}px from the end`);
            if (!now.nextDisabled) failures.push(`phone-tail-${lang} ${height}: a next is offered at the tail`);
            expect(pageErrors).toEqual([]);
          } finally {
            await context.close();
          }
        }
        evidence[`phone-tail-390-${lang}`] = record;
      }

      /* New rows while the reader is away from the tail, on the phone: the
         way back is a 44 px cell of the step row, and it keeps its arrow
         whole whatever the count of new rows is. */
      for (const lang of LANGS) {
        const where = `phone-390-${lang}`;
        const { context, page, pageErrors } = await open("", { width: 390, height: 844 }, lang, true);
        const record: Record<string, unknown> = {};
        try {
          await ready(page);
          await previous(page).click();
          await page.waitForTimeout(650);
          let arrived = 0;
          for (const wanted of [0, 2, 12, 112, 1112]) {
            if (wanted > arrived) {
              await arrive(page, "replies", wanted - arrived);
              arrived = wanted;
              await page.waitForTimeout(wanted > 200 ? 1_500 : 500);
            }
            const reading = await measure(page, 0);
            const cell = await page.evaluate(() => {
              const pill = document.querySelector<HTMLElement>("[data-own-steps] [data-feed-jump-pill]");
              if (!pill) return null;
              const round = (rect: DOMRect) => [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10);
              const arrow = pill.querySelector("svg")!.getBoundingClientRect();
              const count = pill.querySelector<HTMLElement>("[data-feed-jump-count]");
              const box = pill.getBoundingClientRect();
              const text = count?.getBoundingClientRect() ?? null;
              const inside = (rect: DOMRect) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5;
              return {
                label: count?.textContent ?? "",
                pill: round(box),
                arrow: round(arrow),
                arrowInside: inside(arrow),
                textInside: text ? inside(text) && count!.scrollWidth <= count!.clientWidth + 1 : true,
                arrowClearOfText: text ? arrow.bottom <= text.top + 0.5 || text.bottom <= arrow.top + 0.5 : true,
              };
            });
            const latest = reading.controls.find((control) => control.name === "latest");
            const moment = `new-rows-${wanted}`;
            record[moment] = { cell, latest, overflowX: reading.overflowX, count: reading.count };
            const fail = (what: string) => failures.push(`${where} ${moment}: ${what}`);
            if (!cell || !latest) { fail("the way back is not in the step row"); continue; }
            if (cell.label !== (wanted === 0 ? "" : wanted > 99 ? "99+" : String(wanted))) fail(`the cell says "${cell.label}"`);
            if (Math.abs(cell.arrow[2]! - 14) > 0.5 || Math.abs(cell.arrow[3]! - 14) > 0.5 || !cell.arrowInside || !cell.arrowClearOfText) fail(`the arrow is ${cell.arrow[2]} x ${cell.arrow[3]}`);
            if (!cell.textInside) fail("the count leaves the pill");
            if (latest.box[2] < 44 || latest.box[3] < 44) fail(`the way back is ${latest.box[2]} x ${latest.box[3]}`);
            if (!latest.hit) fail("the way back is not what a pointer meets");
            if (latest.overlaps.length) fail(`the way back intersects ${latest.overlaps.join(", ")}`);
            for (const control of reading.controls) if (control.overlaps.length) fail(`${control.name} intersects ${control.overlaps.join(", ")}`);
            if (reading.overflowX) fail(`the page scrolls sideways by ${reading.overflowX}`);
            if (wanted === 12 || wanted === 1112) await page.screenshot({ path: path.join(OUT, `${where}-${moment}.png`) });
          }
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
        evidence[`${where}-new-rows`] = record;
      }

      writeEvidence(evidence);
      expect(failures).toEqual([]);
    } finally {
      await browser.close(); await server.close(); served.stop();
      let alive = false;
      try { process.kill(browserPid, 0); alive = true; } catch { /* Recorded browser exited. */ }
      expect(alive).toBe(false);
    }
  }, 900_000);

  browserTest("late senders, older history under append and voice turns are own-message steps", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    const server = await chromium.launchServer(LAUNCH);
    const browserPid = server.process().pid!;
    const browser = await chromium.connect(server.wsEndpoint());
    const evidence: Record<string, Record<string, unknown>> = {};
    const failures: string[] = [];
    const sizes = [
      { name: "desktop", width: 1440, height: 900, phone: false },
      { name: "phone", width: 390, height: 844, phone: true },
    ];
    try {
      for (const size of sizes) {
        const open = (query: string) => openFixture(browser, `${served.base}?case=own-message-steps${query}`, size, "dark", "en", "reduce", size.phone);
        const lands = size.phone ? 0 : 8;
        /* Every loaded record counts toward pending, even above the first
           sixty rows or above the page. A partial answer keeps waiting. */
        for (const scenario of ["visible", "above-page", "partial", "full"]) {
          const query = `&engine=claude&ledger=${scenario === "partial" ? 200 : 2500}&trailing=${scenario === "above-page" ? 400 : 100}${scenario === "partial" ? "&partial=1" : ""}${scenario === "full" ? "&full=1" : ""}`;
          const { context, page, pageErrors } = await open(query);
          const samples: unknown[] = [];
          try {
            for (let sample = 0; sample < 8; sample += 1) {
              await page.waitForTimeout(250);
              const now = await place(page);
              samples.push(now);
              if (now.count !== null) failures.push(`${size.name} ${scenario}: premature count ${now.count}`);
            }
            if (scenario === "partial") {
              const own = await page.locator("[data-own-message]").count();
              if (own < 2) failures.push(`${size.name} partial: no resolved bubbles to exercise the count`);
              await page.evaluate(() => (window as unknown as { ownSteps: { settleSenders(): void } }).ownSteps.settleSenders());
            }
            const wanted = scenario === "full" ? "9 / 9" : "7 / 7+";
            await page.waitForFunction((wanted) => document.querySelector('[data-own-step-control="count"]')?.textContent === wanted, wanted, { timeout: 8000 }).catch(() => undefined);
            const after = await place(page);
            if (after.count !== wanted) failures.push(`${size.name} ${scenario}: settled count ${after.count}`);
            evidence[`senders-${size.name}-${scenario}`] = { samples, after };
            expect(pageErrors).toEqual([]);
          } finally { await context.close(); }
        }
        /* From a tail with no own rows, release the cap before asking for
           history. Appending during the load must retain the reply. */
        for (const engine of ["codex", "claude"]) {
          const { context, page, pageErrors } = await open(`&engine=${engine}&tailOnly=1&trailing=150&cap=150&older=600&ledger=300`);
          try {
            await page.locator('[data-own-step-control="previous"]').waitFor();
            await page.waitForTimeout(650);
            await page.locator('[data-own-step-control="previous"]').click();
            await page.waitForTimeout(60);
            const immediately = await place(page);
            if (immediately.wayBack !== 1) failures.push(`${size.name} ${engine}: no way back before the older page`);
            for (let append = 0; append < 6; append += 1) {
              // The cap fixture's records are Codex arrivals; exercise the
              // real append boundary on Codex and the ledger boundary on Claude.
              if (engine === "codex") await arrive(page, "replies", 1);
              await page.waitForTimeout(250);
            }
            await page.waitForTimeout(800);
            const after = await place(page);
            if (after.count !== "9 / 9") failures.push(`${size.name} ${engine}: older count ${after.count}`);
            if (after.nearestOwnTop === null || Math.abs(after.nearestOwnTop - lands) > 2) failures.push(`${size.name} ${engine}: first press landed ${after.nearestOwnTop}`);
            const reply = await page.evaluate(() => {
              const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-own-message]"));
              const last = rows.at(-1);
              let reply = last?.nextElementSibling;
              while (reply && !reply.matches('[data-feed-kind="prose"]')) reply = reply.nextElementSibling;
              return reply?.textContent ?? "";
            });
            if (!reply.includes("Agreed: the search lane merges as soon as the browser check passes")) failures.push(`${size.name} ${engine}: the answer was trimmed: ${reply.slice(0, 80)}`);
            evidence[`older-${size.name}-${engine}`] = { immediately, after, reply };
            await page.screenshot({ path: path.join(OUT, `older-${size.name}-${engine}.png`) });
            expect(pageErrors).toEqual([]);
          } finally { await context.close(); }
        }
        const { context, page, pageErrors } = await open("");
        try {
          await page.locator("[data-own-message]").first().waitFor();
          await page.waitForTimeout(650);
          await arrive(page, "voice", 1);
          await arrive(page, "replies", 20);
          await page.waitForTimeout(650);
          const voice = page.locator('[data-feed-kind="voice"]');
          if (await voice.getAttribute("data-own-message") === null) failures.push(`${size.name}: voice has no own-message marker`);
          const atTail = await place(page);
          if (atTail.count !== "8 / 8+") failures.push(`${size.name}: voice count ${atTail.count}`);
          await page.locator('[data-own-step-control="previous"]').click();
          await page.waitForTimeout(900);
          const after = await place(page);
          const voiceTop = await voice.evaluate((row) => row.getBoundingClientRect().top - document.querySelector("[data-log-feed-scroller]")!.getBoundingClientRect().top);
          if (Math.abs(voiceTop - lands) > 2) failures.push(`${size.name}: voice landed ${voiceTop}`);
          await page.screenshot({ path: path.join(OUT, `voice-${size.name}.png`) });
          await page.locator('button:has([data-feed-jump-pill])').click();
          await arrive(page, "work", 600);
          await page.waitForTimeout(1000);
          const abovePage = await place(page);
          if (await voice.count() !== 0) failures.push(`${size.name}: voice did not move above the page`);
          if (abovePage.count !== "8 / 8+") failures.push(`${size.name}: voice above-page count ${abovePage.count}`);
          evidence[`voice-${size.name}`] = { atTail, after, voiceTop, abovePage };
          expect(pageErrors).toEqual([]);
        } finally { await context.close(); }
      }
      writeEvidence(evidence);
      expect(failures).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
      served.stop();
      let alive = false;
      try { process.kill(browserPid, 0); alive = true; } catch { /* The recorded browser exited. */ }
      expect(alive).toBe(false);
    }
  }, 180_000);


  browserTest("long phone counts keep every control clear in both languages", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    const server = await chromium.launchServer(LAUNCH);
    const browserPid = server.process().pid!;
    const browser = await chromium.connect(server.wsEndpoint());
    const evidence: Record<string, Record<string, unknown>> = {};
    try {
      for (const days of [25, 112]) for (const lang of LANGS) {
        const { context, page, pageErrors } = await openFixture(browser, `${served.base}?case=own-message-steps&days=${days}&lang=${lang}`, { width: 390, height: 844 }, "dark", lang, "reduce", true);
        const readings: Record<string, unknown> = {};
        try {
          await page.locator("[data-own-message]").first().waitFor();
          await page.waitForTimeout(900);
          for (const moment of ["rest", "stepped", "draft", "keyboard"]) {
            if (moment === "stepped") await page.locator('[data-own-step-control="previous"]').click();
            if (moment === "draft") await page.locator("textarea").first().fill("one\ntwo\nthree\nfour\nfive\nsix");
            if (moment === "keyboard") await page.evaluate((px) => (window as unknown as { ownSteps: { keyboard(px: number): void } }).ownSteps.keyboard(px), KEYBOARD_PX);
            await page.waitForTimeout(650);
            const reading = await measure(page, 0);
            readings[moment] = reading;
            expect(reading.count?.split(" / ")[1]).toBe(String(days * ALL_OWN));
            expect(reading.row?.[3]).toBe(ROW_PX.phone);
            expect(reading.overflowX).toBe(0);
            if (moment !== "rest") expect(reading.controls.some((control) => control.name === "latest")).toBe(true);
            for (const control of reading.controls) {
              expect(control.hit).toBe(true);
              expect(control.overlaps).toEqual([]);
              expect(control.overFeed).toBe(false);
              expect(control.insideWindow).toBe(true);
              if (control.name !== "count") {
                expect(control.box[2]).toBeGreaterThanOrEqual(44);
                expect(control.box[3]).toBeGreaterThanOrEqual(44);
              }
            }
            const labelsFit = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-own-step-control="previous"], [data-own-step-control="next"]')).every((button) => {
              const text = button.lastElementChild as HTMLElement;
              const inner = text.getBoundingClientRect();
              const outer = button.getBoundingClientRect();
              return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom
                && text.scrollWidth <= text.clientWidth + 1 && text.scrollHeight <= text.clientHeight + 1;
            }));
            expect(labelsFit).toBe(true);
            if (moment === "stepped") await page.screenshot({ path: path.join(OUT, `long-count-phone-${days}-${lang}.png`) });
          }
          evidence[`long-count-phone-${days}-${lang}`] = readings;
          expect(pageErrors).toEqual([]);
        } finally { await context.close(); }
      }
      writeEvidence(evidence);
    } finally {
      await browser.close(); await server.close(); served.stop();
      let alive = false;
      try { process.kill(browserPid, 0); alive = true; } catch { /* Recorded browser exited. */ }
      expect(alive).toBe(false);
    }
  }, 120_000);

});

describe("image viewers: pinch, pan and the right click", () => {
  /*
   * The file preview's image pane and the fullscreen viewer under real input:
   * a mouse at 1280 px and two fingers at 390 px (CDP `Input.dispatchTouchEvent`,
   * so the viewer's `touch-action` meets Chromium's own gesture recognizer).
   * Every step reads the picture's box, and a step that leaves it somewhere
   * the operator did not put it is a failure.
   *
   * Headless Chromium draws no context menu, so the menu is played the way a
   * desktop delivers it: the press of the button, no release (the menu takes
   * it), then the pointer moving with no button held.
   *
   *   IMAGE_VIEWER_STAMP=before records the readings and asserts nothing, for
   *   a run against the viewers as they were. Frames go to
   *   `IMAGE_VIEWER_PNG_DIR` (default `.artifacts/image-viewer/`), readings to
   *   `evidence/image-viewer/<stamp>.json`.
   */

  const STAMP = process.env.IMAGE_VIEWER_STAMP === "before" ? "before" : "after";
  const OUT = path.resolve(process.env.IMAGE_VIEWER_PNG_DIR ?? ".artifacts/image-viewer");
  const EVIDENCE = path.resolve("evidence/image-viewer");
  const VIEWERS = ["pane", "fullscreen"] as const;
  type ViewerName = (typeof VIEWERS)[number];
  type Page = Awaited<ReturnType<typeof openFixture>>["page"];
  const PICTURE: Record<ViewerName, string> = {
    pane: '[data-evidence-case="image-viewers"] img',
    fullscreen: "[role=dialog] img:not([hidden])",
  };

  interface Reading {
    /** The picture's drawn box, and the box of the frame that clips it. */
    x: number; y: number; w: number; h: number;
    frame: { x: number; y: number; w: number; h: number };
    /** Drawn width over natural width. */
    scale: number;
    position: string | null;
    closed: boolean;
    /** What the page itself did under the viewer. */
    pageScale: number; scrollY: number; innerWidth: number;
    /** Pointer captures taken and context menus refused since the page loaded. */
    captures: number; menus: number; menusRefused: number; menuOnPicture: boolean;
  }

  const read = (page: Page, viewer: ViewerName): Promise<Reading> => page.evaluate((selector) => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const img = document.querySelector<HTMLImageElement>(selector);
    const rect = img?.getBoundingClientRect() ?? new DOMRect();
    const frame = img?.closest(".overflow-hidden")?.getBoundingClientRect() ?? new DOMRect();
    const seen = (window as unknown as { viewerInput: { captures: number; menus: number; refused: number; onPicture: boolean } }).viewerInput;
    return {
      x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height),
      frame: { x: round(frame.x), y: round(frame.y), w: round(frame.width), h: round(frame.height) },
      scale: img?.naturalWidth ? Math.round((rect.width / img.naturalWidth) * 10_000) / 10_000 : 0,
      position: document.querySelector("[data-lightbox-position]")?.textContent?.trim() ?? null,
      closed: document.querySelector("[data-viewer-closed]") !== null,
      pageScale: round(window.visualViewport?.scale ?? 1), scrollY: round(window.scrollY), innerWidth: window.innerWidth,
      captures: seen.captures, menus: seen.menus, menusRefused: seen.refused, menuOnPicture: seen.onPicture,
    };
  }, PICTURE[viewer]);

  const WATCH = `window.viewerInput = { captures: 0, menus: 0, refused: 0, onPicture: false };
    const capture = Element.prototype.setPointerCapture;
    Element.prototype.setPointerCapture = function (id) { window.viewerInput.captures += 1; return capture.call(this, id); };
    addEventListener("contextmenu", (event) => { setTimeout(() => {
      window.viewerInput.menus += 1;
      if (event.defaultPrevented) window.viewerInput.refused += 1;
      window.viewerInput.onPicture = event.target instanceof HTMLImageElement;
    }); }, true);`;

  const centre = (reading: Reading) => ({ x: reading.frame.x + reading.frame.w / 2, y: reading.frame.y + reading.frame.h / 2 });
  /** How far the picture's centre moved between two readings. */
  const moved = (from: Reading, to: Reading) => ({ dx: Math.round((to.x + to.w / 2 - from.x - from.w / 2) * 10) / 10, dy: Math.round((to.y + to.h / 2 - from.y - from.h / 2) * 10) / 10 });
  const far = (delta: { dx: number; dy: number }) => Math.hypot(delta.dx, delta.dy);
  /** Where the picture's own point that sat under `point` in `from` is drawn in `to`, as a distance from `point`. */
  const drift = (from: Reading, to: Reading, point: { x: number; y: number }) => {
    const fx = (point.x - from.x) / from.w;
    const fy = (point.y - from.y) / from.h;
    return Math.round(Math.hypot(to.x + fx * to.w - point.x, to.y + fy * to.h - point.y) * 10) / 10;
  };
  /** How much of the picture is inside its frame, along each axis. */
  const overlap = (from: number, size: number, frameFrom: number, frameSize: number) => Math.round(Math.min(from + size, frameFrom + frameSize) - Math.max(from, frameFrom));
  const inView = ({ x, y, w, h, frame }: Reading) => ({ w: overlap(x, w, frame.x, frame.w), h: overlap(y, h, frame.y, frame.h) });
  const sameBox = (a: Reading, b: Reading) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
  const settle = (page: Page, ms = 180) => page.waitForTimeout(ms);

  async function open(browser: Browser, base: string, viewer: ViewerName, phone: boolean) {
    const opened = await openFixture(
      browser, `${base}?case=image-viewers&viewer=${viewer}&lang=en`,
      phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, "dark", "en", "reduce", phone, phone ? 2 : 1,
    );
    await opened.page.addScriptTag({ content: WATCH });
    await opened.page.waitForFunction((selector) => {
      const img = document.querySelector<HTMLImageElement>(selector);
      return Boolean(img?.complete && img.naturalWidth > 0);
    }, PICTURE[viewer]);
    await settle(opened.page, 300);
    return { ...opened, cdp: await opened.context.newCDPSession(opened.page) };
  }

  async function desktop(browser: Browser, base: string, viewer: ViewerName, fail: (text: string) => void) {
    const { context, page, pageErrors, cdp } = await open(browser, base, viewer, false);
    const out: Record<string, unknown> = {};
    const mouse = (type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel", x: number, y: number, more: Record<string, unknown> = {}) =>
      cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "none", buttons: 0, ...more } as never);
    const now = () => read(page, viewer);
    try {
      const fit = await now();
      out.fit = fit;
      await page.screenshot({ path: path.join(OUT, `${STAMP}-desktop-${viewer}-fit.png`) });
      const zoomIn = page.locator(`button[aria-label="${translate("en", "lightbox.zoomIn")}"]`);
      await zoomIn.click();
      await zoomIn.click();
      await settle(page);
      const zoomed = await now();
      out.zoomed = zoomed;
      if (!(zoomed.scale > fit.scale)) fail("the zoom-in button did not zoom");
      const at = centre(zoomed);

      /* A press that is not the primary button: the menu owns the release, and
         the pointer then moves with no button held. */
      const presses = [
        { name: "right", press: { button: "right", buttons: 2 } },
        { name: "middle", press: { button: "middle", buttons: 4 } },
        { name: "ctrl-primary", press: { button: "left", buttons: 1, modifiers: 2 } },
        { name: "shift-primary", press: { button: "left", buttons: 1, modifiers: 8 } },
      ] as const;
      for (const { name, press } of presses) {
        await mouse("mouseMoved", at.x, at.y);
        const before = await now();
        if (name === "right") await page.screenshot({ path: path.join(OUT, `${STAMP}-desktop-${viewer}-right-click-1-before.png`) });
        await mouse("mousePressed", at.x, at.y, { ...press, clickCount: 1 });
        await settle(page, 60);
        for (let step = 1; step <= 7; step += 1) await mouse("mouseMoved", at.x + step * 20, at.y + step * 13);
        await settle(page);
        const after = await now();
        if (name === "right") await page.screenshot({ path: path.join(OUT, `${STAMP}-desktop-${viewer}-right-click-2-after-menu.png`) });
        const follow = moved(before, after);
        out[`press-${name}`] = { before: { x: before.x, y: before.y }, after: { x: after.x, y: after.y }, follow, captures: after.captures - before.captures, menus: after.menus - before.menus, menusRefused: after.menusRefused, menuOnPicture: after.menuOnPicture };
        if (far(follow) > 0.5) fail(`${name} press: the picture followed the pointer by ${follow.dx}, ${follow.dy}`);
        if (after.captures !== before.captures) fail(`${name} press captured the pointer`);
        if (name === "right" && (after.menus - before.menus !== 1 || after.menusRefused || !after.menuOnPicture)) fail("the picture's own menu did not open on the right press");
        /* Let go wherever the pointer is, so the next press starts clean. */
        await mouse("mouseReleased", at.x + 140, at.y + 91, { button: press.button, clickCount: 1 });
        await settle(page, 60);
      }

      /* The primary button pans, and the pan ends with the release. */
      await mouse("mouseMoved", at.x, at.y);
      const panFrom = await now();
      await mouse("mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 6; step += 1) await mouse("mouseMoved", at.x - step * 10, at.y + step * 7, { button: "left", buttons: 1 });
      await settle(page);
      const panned = await now();
      await mouse("mouseReleased", at.x - 60, at.y + 42, { button: "left", clickCount: 1 });
      await mouse("mouseMoved", at.x + 90, at.y + 120);
      await settle(page);
      const released = await now();
      out.pan = { drag: moved(panFrom, panned), afterRelease: moved(panned, released) };
      if (far({ dx: moved(panFrom, panned).dx + 60, dy: moved(panFrom, panned).dy - 42 }) > 1) fail(`a primary drag of -60, 42 moved the picture by ${JSON.stringify(moved(panFrom, panned))}`);
      if (far(moved(panned, released)) > 0.5) fail("the picture kept following after the release");

      /* A pan the window loses: its focus, then its capture. */
      for (const loss of ["blur", "lost-capture"] as const) {
        await mouse("mouseMoved", at.x, at.y);
        await mouse("mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
        await mouse("mouseMoved", at.x + 20, at.y, { button: "left", buttons: 1 });
        await settle(page, 60);
        const held = await now();
        await page.evaluate((kind) => {
          if (kind === "blur") { window.dispatchEvent(new Event("blur")); return; }
          for (const node of document.querySelectorAll("*")) if (node.hasPointerCapture(1)) node.releasePointerCapture(1);
        }, loss);
        for (let step = 1; step <= 5; step += 1) await mouse("mouseMoved", at.x + 20 + step * 20, at.y + step * 20, { button: "left", buttons: 1 });
        await settle(page);
        const after = await now();
        out[`pan-${loss}`] = { follow: moved(held, after) };
        if (far(moved(held, after)) > 0.5) fail(`after ${loss} the picture followed the pointer by ${JSON.stringify(moved(held, after))}`);
        await mouse("mouseReleased", at.x + 120, at.y + 100, { button: "left", clickCount: 1 });
        await settle(page, 60);
      }

      /* The wheel, plain and as a trackpad pinch, zooms about the cursor. */
      const reset = page.locator(`button[aria-label="${translate("en", viewer === "pane" ? "preview.fitImage" : "lightbox.resetZoom")}"]`);
      for (const [name, more, delta] of [["wheel", {}, -100], ["ctrl-wheel", { modifiers: 2 }, -30]] as const) {
        await reset.click();
        await settle(page);
        const start = await now();
        const point = { x: centre(start).x + 120, y: centre(start).y - 70 };
        await mouse("mouseMoved", point.x, point.y);
        for (let turn = 0; turn < 3; turn += 1) await mouse("mouseWheel", point.x, point.y, { ...more, deltaX: 0, deltaY: delta });
        await settle(page);
        const end = await now();
        out[name] = { from: start.scale, to: end.scale, drift: drift(start, end, point), pageScale: end.pageScale, innerWidth: end.innerWidth, scrollY: end.scrollY };
        if (!(end.scale > start.scale * 1.2)) fail(`${name} did not zoom in (${start.scale} to ${end.scale})`);
        if (drift(start, end, point) > 1.5) fail(`${name} moved the point under the cursor by ${drift(start, end, point)}px`);
        if (end.innerWidth !== start.innerWidth || end.pageScale !== 1 || end.scrollY !== 0) fail(`${name} zoomed or scrolled the page`);
      }

      /* Thrown as far as a drag goes, some of the picture stays in the frame. */
      const edge = await now();
      const grip = centre(edge);
      for (let throwAt = 0; throwAt < 4; throwAt += 1) {
        await mouse("mouseMoved", grip.x, grip.y);
        await mouse("mousePressed", grip.x, grip.y, { button: "left", buttons: 1, clickCount: 1 });
        for (let step = 1; step <= 10; step += 1) await mouse("mouseMoved", grip.x + step * 60, grip.y + step * 36, { button: "left", buttons: 1 });
        await mouse("mouseReleased", grip.x + 600, grip.y + 360, { button: "left", clickCount: 1 });
      }
      await settle(page);
      const thrown = await now();
      out.thrown = { box: { x: thrown.x, y: thrown.y, w: thrown.w, h: thrown.h }, inView: inView(thrown) };
      await page.screenshot({ path: path.join(OUT, `${STAMP}-desktop-${viewer}-thrown.png`) });
      if (inView(thrown).w < 40 || inView(thrown).h < 40) fail(`the picture was thrown out of the frame: ${JSON.stringify(inView(thrown))} left in view`);

      /* Zooming out past fit is fit. */
      await mouse("mouseMoved", grip.x, grip.y);
      for (let turn = 0; turn < 40; turn += 1) await mouse("mouseWheel", grip.x, grip.y, { deltaX: 0, deltaY: 100 });
      await settle(page);
      const out40 = await now();
      out.zoomedOut = { scale: out40.scale, fit: fit.scale, box: { x: out40.x, y: out40.y, w: out40.w, h: out40.h } };
      if (!sameBox(out40, fit)) fail(`zooming out past fit left the picture at ${JSON.stringify(out.zoomedOut)}`);

      /* A double click goes to zoomed and back. */
      await reset.click();
      await settle(page);
      const twice = async () => {
        for (const clickCount of [1, 2]) {
          await mouse("mousePressed", grip.x, grip.y, { button: "left", buttons: 1, clickCount });
          await mouse("mouseReleased", grip.x, grip.y, { button: "left", clickCount });
        }
        await settle(page);
        return now();
      };
      const doubled = await twice();
      const back = await twice();
      out.doubleClick = { fit: fit.scale, zoomed: doubled.scale, back: back.scale };
      if (!(doubled.scale > fit.scale * 1.2)) fail("a double click at fit did not zoom");
      if (!sameBox(back, fit)) fail("a second double click did not return to fit");
      if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
    } finally {
      await context.close();
    }
    return out;
  }

  async function phone(browser: Browser, base: string, viewer: ViewerName, fail: (text: string) => void) {
    const { context, page, pageErrors, cdp } = await open(browser, base, viewer, true);
    const out: Record<string, unknown> = {};
    type Finger = { x: number; y: number; id: number };
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", fingers: Finger[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: fingers.map(({ x, y, id }) => ({ x, y, id })) });
    const now = async () => { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); return read(page, viewer); };
    /** One finger from `from` by `dx`, `dy`, lifted at the end. */
    const drag = async (from: { x: number; y: number }, dx: number, dy: number, steps = 10) => {
      await touch("touchStart", [{ ...from, id: 0 }]);
      for (let step = 1; step <= steps; step += 1) {
        await touch("touchMove", [{ x: from.x + (dx * step) / steps, y: from.y + (dy * step) / steps, id: 0 }]);
        await page.waitForTimeout(12);
      }
      await touch("touchEnd", []);
    };
    /** Two fingers about `mid`, from `from` px apart to `to`, each lifted in turn. */
    const pinch = async (mid: { x: number; y: number }, from: number, to: number, watch?: (reading: Reading) => void) => {
      const pair = (gap: number): Finger[] => [{ x: mid.x - gap / 2, y: mid.y, id: 0 }, { x: mid.x + gap / 2, y: mid.y, id: 1 }];
      await touch("touchStart", [pair(from)[0]!]);
      const one = await now();
      await touch("touchStart", pair(from));
      const two = await now();
      for (let step = 1; step <= 16; step += 1) {
        await touch("touchMove", pair(from + ((to - from) * step) / 16));
        if (watch) watch(await now());
        else await page.waitForTimeout(12);
      }
      const spread = await now();
      await touch("touchEnd", [pair(to)[0]!]);
      const lifted = await now();
      await touch("touchEnd", []);
      const done = await now();
      return { one, two, spread, lifted, done };
    };
    try {
      const fit = await now();
      out.fit = fit;
      await page.screenshot({ path: path.join(OUT, `${STAMP}-phone-390-${viewer}-1-fit.png`) });
      const mid = { x: centre(fit).x + 30, y: centre(fit).y - 20 };
      const reset = page.locator(`button[aria-label="${translate("en", viewer === "pane" ? "preview.fitImage" : "lightbox.resetZoom")}"]`);

      /* At fit one finger belongs to the viewer's own navigation. */
      if (viewer === "fullscreen") {
        await drag(mid, -190, 6);
        await settle(page, 350);
        const next = await now();
        await drag(mid, 190, -6);
        await settle(page, 350);
        const previous = await now();
        out.fitSwipe = { afterLeft: next.position, afterRight: previous.position, pictureLeftAt: moved(fit, previous) };
        if (next.position !== "2 / 3" || previous.position !== "1 / 3") fail(`a sideways swipe at fit read ${next.position} then ${previous.position}`);
        if (!sameBox(previous, fit)) fail(`two sideways swipes at fit left the picture moved by ${JSON.stringify(moved(fit, previous))}`);
      } else {
        await drag(mid, -150, 40);
        await settle(page);
        const still = await now();
        out.fitDrag = { moved: moved(fit, still), scrollY: still.scrollY };
        if (!sameBox(still, fit)) fail(`one finger at fit moved the picture by ${JSON.stringify(moved(fit, still))} and scrolled the page to ${still.scrollY}`);
        await page.evaluate(() => window.scrollTo(0, 0));
      }

      /* Zoomed with the button, one finger pans, and a later touch somewhere
         else finds the picture where that finger left it. */
      const zoomIn = page.locator(`button[aria-label="${translate("en", "lightbox.zoomIn")}"]`);
      /* Chromium now and then drops the click of a tap that lands within half
         a second of the last finger lifting, in either viewer and before this
         change too, so a button is tapped a second after the gesture. */
      await settle(page, 1200);
      await zoomIn.tap();
      await zoomIn.tap();
      await settle(page);
      const byButton = await now();
      await drag(mid, -50, 60);
      const dragged = await now();
      await page.waitForTimeout(400);
      const elsewhere = { x: mid.x + 60, y: mid.y - 30 };
      await touch("touchStart", [{ ...elsewhere, id: 0 }]);
      await touch("touchMove", [{ x: elsewhere.x + 3, y: elsewhere.y, id: 0 }]);
      const stuck = await now();
      await touch("touchEnd", []);
      out.buttonZoomThenTouch = { zoomed: byButton.scale, drag: moved(byButton, dragged), laterTouch: moved(dragged, stuck), scrollY: stuck.scrollY, pageScale: stuck.pageScale };
      if (!(byButton.scale > fit.scale)) fail("the zoom-in button did not zoom");
      if (far({ dx: moved(byButton, dragged).dx + 50, dy: moved(byButton, dragged).dy - 60 }) > 1.5) fail(`one finger dragged -50, 60 moved the button-zoomed picture by ${JSON.stringify(moved(byButton, dragged))}`);
      if (far(moved(dragged, stuck)) > 4) fail(`the picture jumped to a later touch by ${JSON.stringify(moved(dragged, stuck))}`);
      if (stuck.scrollY !== 0) fail(`a pan of the zoomed picture scrolled the page to ${stuck.scrollY}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 1200);
      await reset.tap();
      await settle(page);

      /* Two fingers spread to three times their distance about `mid`. */
      const scales: number[] = [];
      const grown = await pinch(mid, 80, 240, (reading) => scales.push(reading.scale));
      await settle(page);
      await page.screenshot({ path: path.join(OUT, `${STAMP}-phone-390-${viewer}-2-pinched.png`) });
      const steps = scales.map((scale, at) => scale / (scales[at - 1] ?? grown.two.scale));
      out.pinch = {
        fit: fit.scale, to: grown.spread.scale, ratio: Math.round((grown.spread.scale / fit.scale) * 100) / 100, scales,
        secondFingerLands: { ...moved(grown.one, grown.two), scale: grown.two.scale / grown.one.scale },
        midpointDrift: drift(grown.two, grown.spread, mid),
        firstFingerLifts: { ...moved(grown.spread, grown.lifted), scale: grown.lifted.scale / grown.spread.scale },
        lastFingerLifts: { ...moved(grown.lifted, grown.done), scale: grown.done.scale / grown.lifted.scale },
        largestStep: Math.round(Math.max(...steps) * 1000) / 1000, smallestStep: Math.round(Math.min(...steps) * 1000) / 1000,
        pageScale: grown.done.pageScale, scrollY: grown.done.scrollY,
      };
      if (far(moved(grown.one, grown.two)) > 0.5 || grown.two.scale !== grown.one.scale) fail(`the picture jumped when the second finger landed: ${JSON.stringify(moved(grown.one, grown.two))}`);
      if (Math.abs(grown.spread.scale / fit.scale - 3) > 0.1) fail(`fingers spread to three times their distance scaled the picture ${grown.spread.scale / fit.scale} times`);
      if (Math.min(...steps) < 0.999 || Math.max(...steps) > 1.2) fail(`the pinch did not grow evenly: steps between ${Math.min(...steps)} and ${Math.max(...steps)}`);
      if (drift(grown.two, grown.spread, mid) > 2) fail(`the point between the fingers moved by ${drift(grown.two, grown.spread, mid)}px`);
      if (far(moved(grown.spread, grown.lifted)) > 0.5 || far(moved(grown.lifted, grown.done)) > 0.5 || grown.done.scale !== grown.spread.scale) fail("the picture jumped when a finger lifted");
      if (grown.done.pageScale !== 1 || grown.done.scrollY !== 0) fail(`the page itself zoomed to ${grown.done.pageScale} or scrolled to ${grown.done.scrollY} under the pinch`);

      /* A later touch somewhere else: the picture stays where the fingers left it. */
      const later = { x: mid.x - 70, y: mid.y + 130 };
      await touch("touchStart", [{ ...later, id: 0 }]);
      const touched = await now();
      await touch("touchMove", [{ x: later.x + 3, y: later.y, id: 0 }]);
      const nudged = await now();
      await touch("touchEnd", []);
      out.laterTouch = { onTouch: moved(grown.done, touched), onNudge: moved(grown.done, nudged) };
      if (far(moved(grown.done, touched)) > 0.5 || far(moved(grown.done, nudged)) > 4) fail(`the picture jumped to a later touch: ${JSON.stringify(out.laterTouch)}`);

      /* One finger pans the zoomed picture by what the finger travelled. */
      const panFrom = await now();
      await drag(mid, -50, 60);
      const panned = await now();
      out.onefingerPan = { drag: moved(panFrom, panned), scale: panned.scale / panFrom.scale, pageScale: panned.pageScale, scrollY: panned.scrollY };
      if (far({ dx: moved(panFrom, panned).dx + 50, dy: moved(panFrom, panned).dy - 60 }) > 1.5 || panned.scale !== panFrom.scale) fail(`one finger dragged -50, 60 moved the zoomed picture by ${JSON.stringify(moved(panFrom, panned))}`);
      if (panned.scrollY !== 0) fail("a one-finger pan scrolled the page");

      for (let throwAt = 0; throwAt < 4; throwAt += 1) await drag({ x: 60, y: centre(fit).y - 200 }, 300, 380);
      await settle(page);
      const thrown = await now();
      out.thrown = { box: { x: thrown.x, y: thrown.y, w: thrown.w, h: thrown.h }, inView: inView(thrown), scrollY: thrown.scrollY };
      await page.screenshot({ path: path.join(OUT, `${STAMP}-phone-390-${viewer}-3-thrown.png`) });
      if (inView(thrown).w < 40 || inView(thrown).h < 40) fail(`the picture was thrown out of the frame: ${JSON.stringify(inView(thrown))} left in view`);

      /* Fingers closed past fit: fit. */
      await pinch(centre(fit), 300, 40);
      const shrunk = await pinch(centre(fit), 300, 40);
      await settle(page);
      out.pinchedIn = { scale: shrunk.done.scale, fit: fit.scale, box: { x: shrunk.done.x, y: shrunk.done.y, w: shrunk.done.w, h: shrunk.done.h } };
      await page.screenshot({ path: path.join(OUT, `${STAMP}-phone-390-${viewer}-4-pinched-in.png`) });
      if (!sameBox(shrunk.done, fit)) fail(`closing the fingers past fit left the picture at ${JSON.stringify(out.pinchedIn)}`);

      /* A double tap goes to zoomed and back. */
      const tapTwice = async () => {
        for (let tap = 0; tap < 2; tap += 1) {
          await touch("touchStart", [{ ...mid, id: 0 }]);
          await touch("touchEnd", []);
          await page.waitForTimeout(90);
        }
        await settle(page, 450);
        return now();
      };
      const doubled = await tapTwice();
      const back = await tapTwice();
      out.doubleTap = { fit: fit.scale, zoomed: doubled.scale, back: back.scale };
      if (!(doubled.scale > fit.scale * 1.2)) fail("a double tap at fit did not zoom");
      if (!sameBox(back, fit)) fail("a second double tap did not return to fit");

      /* A vertical drag at fit closes the fullscreen viewer. */
      if (viewer === "fullscreen") {
        const open = await page.locator("[data-viewer-closed]").count() === 0;
        await drag(mid, 5, 260);
        await settle(page, 350);
        const closed = await page.locator("[data-viewer-closed]").count() === 1;
        out.fitVerticalDrag = { openBefore: open, closed };
        if (!open) fail("the viewer had closed before the vertical drag");
        if (!closed) fail("a vertical drag at fit did not close the viewer");
      }
      const last = await page.evaluate(() => ({ pageScale: window.visualViewport?.scale ?? 1, scrollY: window.scrollY }));
      out.page = last;
      if (last.pageScale !== 1 || last.scrollY !== 0) fail(`the page ended zoomed to ${last.pageScale} or scrolled to ${last.scrollY}`);
      if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
    } finally {
      await context.close();
    }
    return out;
  }

  browserTest("the picture goes where the hand put it, and nowhere after the hand lets go", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    const server = await chromium.launchServer(LAUNCH);
    const browserPid = server.process().pid!;
    fs.writeFileSync(path.join(OUT, "browser.pid"), `${browserPid}\n`);
    const browser = await chromium.connect(server.wsEndpoint());
    const failures: string[] = [];
    const readings: Record<string, unknown> = {};
    try {
      for (const viewer of VIEWERS) for (const surface of ["desktop-1280", "phone-390"] as const) {
        const key = `${surface}-${viewer}`;
        const fail = (text: string) => failures.push(`${key}: ${text}`);
        try {
          readings[key] = await (surface === "phone-390" ? phone : desktop)(browser, served.base, viewer, fail);
        } catch (error) {
          fail(error instanceof Error ? error.message.split("\n")[0]! : String(error));
        }
      }
      fs.writeFileSync(path.join(EVIDENCE, `${STAMP}.json`), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
      if (STAMP === "after") expect(failures).toEqual([]);
    } finally {
      await browser.close(); await server.close(); served.stop();
      let alive = false;
      try { process.kill(browserPid, 0); alive = true; } catch { /* Recorded browser exited. */ }
      expect(alive).toBe(false);
    }
  }, 600_000);
});

describe("prototype review: the orchestrator's open composer says a prototype is ready", () => {
  /*
   * The phone's half of the orchestrator's notice. With the composer put away
   * the seat's card carries one chip, which the kanban driver measures; with
   * the orchestrator's conversation open the notice stands above the message
   * field. This block opens that composer at 390 with three tasks waiting, in
   * English and Ukrainian, light and dark, and reads: the one line the phone
   * shows and the count folded behind it, the 44 px action, that the line and
   * the field do not overlap and nothing leaves the screen, the unfolded list,
   * and that «Go to prototype» opens the waiting round of the task it names.
   *
   *   LLV_CONVERSATION_BROWSER_TEST=1 bun test src/components/conversation/conversationWindow.browser.test.tsx -t "prototype review"
   *
   * Readings go to `evidence/prototype-review/composer-notice.json`; frames to
   * PROTOTYPE_REVIEW_PNG_DIR (default `.artifacts/prototype-review/`), which
   * is not committed.
   */
  const OUT = path.resolve(".artifacts/prototype-review");
  const EVIDENCE = path.resolve("evidence/prototype-review");
  const VIEWPORT = { width: 390, height: 844 };

  browserTest("prototype review: the notice above the phone's open composer, its count and its jump", async () => {
    const pngDir = process.env.PROTOTYPE_REVIEW_PNG_DIR ?? OUT;
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(pngDir, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | null = null;
    const readings: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      browser = await chromium.launch(LAUNCH);
      for (const lang of ["en", "uk"] as const) for (const scheme of ["light", "dark"] as const) {
        const label = `phone-390-${lang}-${scheme}`;
        const tr = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(lang, key, vars);
        /* Each line names the task its jump lands on, the fixture's task text. */
        const taskTitles: Record<string, string> = lang === "uk"
          ? { "t-search": "Повернути результати пошуку після перебудови індексу", "t-links": "Полагодити старі посилання в нотатках до випуску", "t-upload": "Переробити завантаження великих вкладень" }
          : { "t-search": "Restore search results after the index rebuild", "t-links": "Repair old links in the release notes", "t-upload": "Redesign attachment upload for large files" };
        const { context, page, pageErrors } = await openFixture(browser, `${served.base}?case=prototype-notice&lang=${lang}`, VIEWPORT, scheme, lang, "reduce", true);
        const shot = (name: string) => page.screenshot({ path: path.join(pngDir, `${label}-composer-${name}.png`) });
        /* The notice, the message field and the screen: what the line says,
           where it stands and whether anything overlaps or leaves the frame. */
        const read = () => page.evaluate(() => {
          const box = (element: Element) => { const rect = element.getBoundingClientRect(); return [Math.round(rect.left * 10) / 10, Math.round(rect.top * 10) / 10, Math.round(rect.width * 10) / 10, Math.round(rect.height * 10) / 10]; };
          const crosses = (a: number[], b: number[]) => a[0]! < b[0]! + b[2]! - 0.5 && b[0]! < a[0]! + a[2]! - 0.5 && a[1]! < b[1]! + b[3]! - 0.5 && b[1]! < a[1]! + a[3]! - 0.5;
          const list = document.querySelector<HTMLElement>("[data-evidence-composer] [data-prototype-notices]");
          const field = document.querySelector<HTMLTextAreaElement>("[data-evidence-composer] textarea");
          const rows = [...document.querySelectorAll<HTMLElement>("[data-evidence-composer] [data-prototype-notice]")];
          const more = document.querySelector<HTMLElement>("[data-evidence-composer] [data-prototype-notice-more]");
          const parts = [...rows.map(box), ...(more ? [box(more)] : []), ...(field ? [box(field)] : [])];
          const overlaps: string[] = [];
          for (let i = 0; i < parts.length; i += 1) for (let j = i + 1; j < parts.length; j += 1) if (crosses(parts[i]!, parts[j]!)) overlaps.push(`${i} × ${j}`);
          return {
            waiting: list?.dataset.prototypeNotices ?? null,
            rows: rows.map((row) => {
              const action = row.querySelector<HTMLElement>("[data-prototype-notice-open]")!;
              const title = row.querySelector<HTMLElement>("span.truncate")!;
              return {
                task: row.dataset.prototypeNotice, text: row.textContent, box: box(row), action: box(action), actionLabel: action.getAttribute("aria-label"),
                titleClear: title.getBoundingClientRect().right <= action.getBoundingClientRect().left + 0.5,
                titleCut: title.scrollWidth > title.clientWidth,
              };
            }),
            more: more ? { folded: more.dataset.prototypeNoticeMore, text: more.textContent, expanded: more.getAttribute("aria-expanded"), box: box(more) } : null,
            field: field ? box(field) : null,
            fieldEnabled: field ? !field.disabled : null,
            overlaps,
            outside: parts.filter((part) => part[0]! < -0.5 || part[0]! + part[2]! > window.innerWidth + 0.5 || part[1]! < -0.5 || part[1]! + part[3]! > window.innerHeight + 0.5).length,
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
            viewport: [window.innerWidth, window.innerHeight],
          };
        });
        try {
          await page.waitForSelector('[data-evidence-case="prototype-notice"] [data-prototype-notice]', { timeout: 20_000 });
          await page.waitForTimeout(400);
          const folded = await read();
          readings[`${label}-notice`] = folded;
          await shot("notice");
          const first = folded.rows[0];
          /* Three tasks wait: the phone shows one line and folds two behind the count. */
          if (folded.waiting !== "3" || folded.rows.length !== 1 || folded.more?.folded !== "2" || !folded.more.text?.includes("2")) failures.push(`${label}: the composer's notice reads ${JSON.stringify({ waiting: folded.waiting, rows: folded.rows.length, more: folded.more })}`);
          if (!first || first.task !== "t-search" || !first.text?.includes(tr("proto.notice.ready")) || !first.text.includes(tr("proto.notice.open")) || !first.titleClear) failures.push(`${label}: the notice line reads ${JSON.stringify(first)}`);
          if (first && (!first.text?.includes(taskTitles[first.task!]!) || !first.actionLabel?.includes(taskTitles[first.task!]!))) failures.push(`${label}: the notice line does not name its task: «${first.text}», «${first.actionLabel}»`);
          if (first && (first.action[3]! < 44 || first.action[2]! < 44)) failures.push(`${label}: «${tr("proto.notice.open")}» is ${first.action[2]}×${first.action[3]}, under a 44 px touch target`);
          if (folded.more && folded.more.box[3]! < 44) failures.push(`${label}: the count behind the notice is ${folded.more.box[3]} px tall`);
          if (!folded.field || !folded.fieldEnabled || (first && first.box[1]! + first.box[3]! > folded.field[1]! + 0.5)) failures.push(`${label}: the notice does not stand above a usable message field: ${JSON.stringify({ row: first?.box, field: folded.field })}`);
          if (folded.overlaps.length || folded.outside || folded.overflowX > 0) failures.push(`${label}: the notice overlaps ${folded.overlaps.join(", ")}, leaves the screen (${folded.outside}) or scrolls the page sideways by ${folded.overflowX}px`);

          /* Unfolded: every waiting task has its line, the long title is cut before the action and the field stays on screen. */
          await page.locator("[data-evidence-composer] [data-prototype-notice-more]").click();
          await page.waitForFunction(() => document.querySelectorAll("[data-evidence-composer] [data-prototype-notice]").length === 3);
          await page.waitForTimeout(200);
          const all = await read();
          readings[`${label}-notice-all`] = all;
          await shot("notice-all");
          if (all.rows.length !== 3 || all.more?.expanded !== "true" || all.rows.some((row) => !row.titleClear || row.action[3]! < 44)) failures.push(`${label}: the unfolded notice reads ${JSON.stringify(all.rows.map((row) => ({ task: row.task, clear: row.titleClear, action: row.action })))}`);
          for (const row of all.rows) if (!row.text?.includes(taskTitles[row.task!]!)) failures.push(`${label}: the unfolded notice of ${row.task} does not name its task: «${row.text}»`);
          if (!all.rows.some((row) => row.titleCut)) failures.push(`${label}: the long title was expected to be cut and was not`);
          if (all.overlaps.length || all.outside || all.overflowX > 0) failures.push(`${label}: unfolded, the notice overlaps ${all.overlaps.join(", ")}, leaves the screen (${all.outside}) or scrolls sideways by ${all.overflowX}px`);
          await page.locator("[data-evidence-composer] [data-prototype-notice-more]").click();
          await page.waitForFunction(() => document.querySelectorAll("[data-evidence-composer] [data-prototype-notice]").length === 1);

          /* The jump: the review of the task the line names, on its waiting round. */
          await page.locator('[data-evidence-composer] [data-prototype-notice-open="t-search"]').click();
          await page.waitForSelector('[data-mobile2-sheet="prototype-review"] [data-prototype-variant]', { timeout: 10_000 });
          await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("[data-prototype-canvas] img")].every((image) => image.complete && image.naturalWidth > 0));
          await page.waitForTimeout(400);
          const jump = await page.evaluate(() => {
            const review = document.querySelector<HTMLElement>("[data-prototype-review]");
            const sheet = document.querySelector<HTMLElement>('[data-mobile2-sheet="prototype-review"]')!.getBoundingClientRect();
            return {
              review: review?.dataset.prototypeReview ?? null, round: review?.dataset.prototypeRoundShown ?? null,
              variants: document.querySelectorAll("[data-prototype-review] button[data-prototype-variant]").length,
              sheet: [Math.round(sheet.left), Math.round(sheet.top), Math.round(sheet.width), Math.round(sheet.height)],
              sheetInside: sheet.left >= -0.5 && sheet.right <= window.innerWidth + 0.5 && sheet.bottom <= window.innerHeight + 0.5,
              overflowX: document.documentElement.scrollWidth - window.innerWidth,
            };
          });
          readings[`${label}-jump`] = jump;
          await shot("jump");
          if (jump.review !== "t-search" || jump.round !== "r-search" || jump.variants !== 2 || !jump.sheetInside || jump.overflowX > 0) failures.push(`${label}: «${tr("proto.notice.open")}» opened ${JSON.stringify(jump)}`);
          await page.keyboard.press("Escape");
          await page.waitForSelector("[data-prototype-review]", { state: "detached", timeout: 5_000 });
          if (!await page.locator("[data-evidence-composer] [data-prototype-notice]").count()) failures.push(`${label}: the notice of an undecided review left the composer after the review was closed`);
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}${pageErrors.length ? ` (page errors: ${pageErrors.join(" | ")})` : ""}`);
          await shot("failed-here").catch(() => {});
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser?.close();
      served.stop();
    }
    fs.writeFileSync(path.join(EVIDENCE, "composer-notice.json"), `${JSON.stringify({ driver: "src/components/conversation/conversationWindow.browser.test.tsx", readings, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 600_000);
});
