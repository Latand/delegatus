import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type LaunchOptions } from "playwright-core";

import { translate } from "@/lib/i18n";
import { openFixture, serveEvidenceFixture } from "@/components/kanban/issue1695BrowserHarness";

import { driverArrivalName, driverFrameName, driverFrameNames, framesFromFileNames, type DriverMoment } from "./frameSets.prototype.model";

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
          expect(await line.textContent()).toBe(translate(lang, "composer.deliveryChecking"));
          expect(await page.locator("[data-delivery-notice-retry]").getAttribute("aria-label"))
            .toBe(translate(lang, "composer.payloadRecheck"));
          await page.locator("[data-delivery-notice-retry]").click();
          expect(await page.locator("[data-fixture-sends]").textContent()).toBe("0");
          await page.screenshot({ path: path.join(out, `checking-${key}.png`), fullPage: true });
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

describe("frame sets, design variants", () => {
  /*
   * A design lane's frames and its measurements (docs/design/frame-sets.md):
   * four ways to open a set of prototypes and screenshots an agent published,
   * each mounted into the production pane by the fixture's `frame-sets` case.
   * Earlier designs were rejected for lying on top of the interface, so the
   * closed state is proved by measurement: per variant, width and language
   * the entry is hit-tested at its centre and four corners, intersected with
   * every other interactive element, with every other feed row and with the
   * rest of the row it stands in, and the rest of the pane is compared with
   * the same pane without the feature (`variant=0`). The walk then counts the
   * presses to one frame and to a chosen variant, and before each press reads
   * whether its target was on screen and how far it had to be scrolled to,
   * because a press the driver makes scrolls its target into view by itself.
   * It steps by key and by swipe and reads the reply out of the message
   * field. The six-frames-a-variant fixture hid what a real lane's set does
   * to the collage, so a second pass opens variant 4 over a set of this lane's
   * own size (`set=lane`: twenty-four frames and more a variant, and frames of
   * no variant) and fails the run when a "Choose" is past the feed's edge or
   * the collage is taller than the feed. A last pass holds the turn's answer
   * back, delivers it, and reads whether the entry is on screen at that
   * moment, for both places the entry can stand.
   *
   * Frames go to `LLV_FRAME_SETS_OUT` (default `.artifacts/frame-sets/`, not
   * committed), under the names `driverFrameNames` lists, which is the list
   * the model test publishes by the short form; the measurements go to
   * `evidence/frame-sets/measurements.json`.
   */
  const OUT = path.resolve(process.env.LLV_FRAME_SETS_OUT ?? ".artifacts/frame-sets");
  const EVIDENCE = path.resolve("evidence/frame-sets");
  const VIEWPORTS = [
    { name: "desktop-1440", width: 1440, height: 900, phone: false, pane: 0 },
    /* A board-node-sized pane. */
    { name: "pane-440", width: 1000, height: 800, phone: false, pane: 440 },
    { name: "phone-390", width: 390, height: 844, phone: true, pane: 0 },
  ] as const;
  const LANGS = ["en", "uk"] as const;
  /* The frame the walk goes to: variant 3, its fifth frame (the phone, en). */
  const TARGET = { variant: 3, index: 4, id: "fixture-3-390-en", before: "fixture-3-440-uk", after: "fixture-3-390-uk", inSet: 16, frames: 24 };
  const REPLY = { en: "Variant 3 (In the message field's own row).", uk: "Варіант 3 (У рядку самого поля повідомлення)." };
  /* The lane-sized set is this lane's own directory in publication order; the
     walk goes to the same place in it, variant 3's fifth frame. */
  const LANE = (() => {
    const frames = framesFromFileNames(driverFrameNames());
    const third = frames.map((frame, index) => ({ frame, index })).filter((entry) => entry.frame.variant === TARGET.variant);
    return {
      frames: frames.length,
      target: third[TARGET.index]!.index,
      firstOther: frames.findIndex((frame) => frame.variant === null),
      others: frames.filter((frame) => frame.variant === null).length,
      perVariant: [1, 2, 3, 4].map((variant) => frames.filter((frame) => frame.variant === variant).length),
    };
  })();
  const LANE_REPLY = {
    en: "Variant 3 (In the message field's own row, left of the attach button).",
    uk: "Варіант 3 (У рядку самого поля повідомлення, ліворуч від вкладення).",
  };

  type Box = [x: number, y: number, width: number, height: number];
  interface ControlReading {
    name: string;
    /** What of the control is on screen. */
    box: Box;
    /** Its own width and height, whatever a scrolling edge cuts off. */
    size: [width: number, height: number];
    /** Centre and four corners of what is visible all answer with the control itself. */
    hit: boolean;
    /** Other interactive elements whose visible box intersects this one. */
    overlaps: string[];
    /** Other feed rows whose visible box intersects this one. */
    overRows: string[];
    insideWindow: boolean;
  }
  interface Reading {
    controls: ControlReading[];
    probes: Record<string, Box>;
    /** The publishing call's own feed row: a plain tool row today, gone in a variant. */
    callRow: Box | null;
    /** The entry's own row in the feed. */
    entryRow: Box | null;
    /** The feed's scroll box: what is laid out, what is on screen, how far from its tail. */
    feed: { scrollHeight: number; clientHeight: number; fromTail: number };
    panel: Box | null;
    modal: boolean;
    overflowX: number;
    shown: string[];
    lightbox: string | null;
    draft: string;
    composerFocused: boolean;
  }
  interface Moved { probe: string; delta: Box }
  interface Press {
    control: string;
    /** The whole target was on screen before the press. */
    onScreen: boolean;
    /** How far the target had to be brought into view, in px: down or up the feed, and sideways along a strip. */
    scrollY: number;
    scrollX: number;
  }

  const measure = (page: import("playwright-core").Page) => page.evaluate((): Reading => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const boxOf = (rect: DOMRect): [number, number, number, number] => [round(rect.x), round(rect.y), round(rect.width), round(rect.height)];
    const cut = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    /* What of an element its scrolling ancestors and the window let through. */
    const visible = (element: Element): DOMRect => {
      let rect = element.getBoundingClientRect();
      let left = Math.max(rect.left, 0), top = Math.max(rect.top, 0), right = Math.min(rect.right, innerWidth), bottom = Math.min(rect.bottom, innerHeight);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        rect = parent.getBoundingClientRect();
        left = Math.max(left, rect.left); top = Math.max(top, rect.top); right = Math.min(right, rect.right); bottom = Math.min(bottom, rect.bottom);
      }
      return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    };
    const shown = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = visible(element);
      /* A sliver left by a scrolling strip's edge is not a control anyone meets. */
      return style.visibility !== "hidden" && style.display !== "none" && rect.width >= 8 && rect.height >= 8;
    };
    const name = (element: Element) => {
      const text = element.getAttribute("data-frame-control") ?? element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.getAttribute("data-testid")
        ?? element.getAttribute("placeholder") ?? (element.textContent ?? "").trim().slice(0, 28);
      return `${element.tagName.toLowerCase()}:${text}`;
    };
    const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    const callRow = document.querySelector<HTMLElement>("[data-frame-set-row]")
      ?? Array.from(scroller.querySelectorAll<HTMLElement>('[data-feed-kind="tool"]')).find((row) => (row.textContent ?? "").includes("publish_frames")) ?? null;
    const host = document.querySelector<HTMLElement>("[data-frame-set-host]");
    const hostRow = host?.closest<HTMLElement>("[data-feed-kind]") ?? callRow;
    /* What else stands in the entry's own row: the answer it closes. */
    const beside = host && hostRow ? Array.from(hostRow.children).filter((child) => child !== host && shown(child)) : [];
    const interactive = Array.from(document.querySelectorAll<HTMLElement>(
      'button, a[href], textarea, input, select, summary, [role="button"], [role="menuitem"], [tabindex]:not([tabindex="-1"])',
    )).filter(shown);
    /* Under an open full-screen surface only what is in it can be met. */
    const reachable = dialog ? interactive.filter((element) => dialog.contains(element)) : interactive;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-feed-kind]")).filter((row) => row !== hostRow && shown(row));
    const controls = Array.from(document.querySelectorAll<HTMLElement>("[data-frame-control]")).filter(shown).filter((control) => !dialog || dialog.contains(control));
    const readings = controls.map((control) => {
      const rect = visible(control);
      const inset = Math.min(rect.width, rect.height) / 2 - 0.5 < 3 ? 1 : Math.ceil((parseFloat(getComputedStyle(control).borderTopLeftRadius) || 0) * 0.3) + 1;
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
      ] as const;
      return {
        name: control.dataset.frameControl!,
        box: boxOf(rect),
        size: [round(control.getBoundingClientRect().width), round(control.getBoundingClientRect().height)] as [number, number],
        hit: points.every(([x, y]) => { const at = document.elementFromPoint(x, y); return at !== null && control.contains(at); }),
        overlaps: reachable.filter((other) => other !== control && !other.contains(control) && !control.contains(other) && cut(rect, visible(other)) > 1).map(name),
        overRows: dialog ? [] : [
          ...rows.filter((row) => cut(rect, visible(row)) > 1).map((row) => `${row.dataset.feedKind}:${(row.textContent ?? "").trim().slice(0, 24)}`),
          ...beside.filter((child) => cut(rect, visible(child)) > 1).map((child) => `own row:${(child.textContent ?? "").trim().slice(0, 24)}`),
        ],
        insideWindow: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    });

    const probes: Record<string, [number, number, number, number]> = {};
    const put = (key: string, element: Element | null | undefined) => { if (element && shown(element)) probes[key] = boxOf(element.getBoundingClientRect()); };
    const header = document.querySelector("[data-mobile2-bar]") ?? document.querySelector("[data-link-path] > header");
    put("header", header);
    put("title", document.querySelector("[data-mobile2-title]") ?? header?.querySelector(".truncate"));
    put("feed", scroller);
    put("jump-strip", document.querySelector("[data-feed-jump-strip]"));
    put("composer", document.querySelector('[data-testid="composer-input-unit"]'));
    put("field", document.querySelector("textarea"));
    const seen = new Map<string, number>();
    for (const element of interactive) {
      if (scroller.contains(element) || element.closest("[data-frame-set], [data-feed-jump-strip]") || dialog?.contains(element) || element.tagName === "TEXTAREA") continue;
      const group = element.closest("[data-mobile2-tools]") ? "tools" : element.closest('[data-testid="composer-input-unit"]') ? "composer"
        : element.closest("[data-mobile2-bar], [data-link-path] > header") ? "header" : "control";
      const key = `${group}:${name(element)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      probes[count > 1 ? `${key} #${count}` : key] = boxOf(element.getBoundingClientRect());
    }
    const panel = document.querySelector("[data-frame-panel]");
    const field = document.querySelector<HTMLTextAreaElement>("textarea");
    return {
      controls: readings,
      probes,
      callRow: callRow ? boxOf(callRow.getBoundingClientRect()) : null,
      entryRow: host ? boxOf(host.getBoundingClientRect()) : null,
      feed: { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, fromTail: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) },
      panel: panel ? boxOf(panel.getBoundingClientRect()) : null,
      modal: dialog !== null,
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      shown: Array.from(document.querySelectorAll<HTMLElement>("[data-frame-shown]")).map((img) => img.dataset.frameShown!),
      lightbox: document.querySelector("[data-lightbox-position]")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      draft: field?.value ?? "",
      composerFocused: document.activeElement === field,
    };
  });

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

  /** Where a control is against what its scrolling ancestors and the window let through. */
  const reach = (page: import("playwright-core").Page, control: string) => page.locator(`[data-frame-control="${control}"]`).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const box = parent.getBoundingClientRect();
      left = Math.max(left, box.left); top = Math.max(top, box.top); right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom);
    }
    const past = (low: number, high: number, from: number, to: number) => Math.round(Math.max(0, from - low, high - to));
    const scrollY = past(rect.top, rect.bottom, top - 1, bottom + 1);
    const scrollX = past(rect.left, rect.right, left - 1, right + 1);
    return { onScreen: scrollX === 0 && scrollY === 0, scrollY, scrollX };
  });

  /** The open collage against the feed it stands in: what of it needs no scroll, and how large a tile is. */
  const collage = (page: import("playwright-core").Page) => page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
    const panel = document.querySelector<HTMLElement>('[data-frame-panel="collage"]')!;
    const feed = scroller.getBoundingClientRect();
    const top = Math.max(0, feed.top) - 1, bottom = Math.min(innerHeight, feed.bottom) + 1;
    const tall = (rect: DOMRect) => rect.top >= top && rect.bottom <= bottom;
    const whole = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const strip = element.closest("[data-frame-collage-row]")!.getBoundingClientRect();
      return tall(rect) && rect.left >= strip.left - 1 && rect.right <= strip.right + 1;
    };
    const size = (element: Element | null) => element ? [Math.round(element.getBoundingClientRect().width), Math.round(element.getBoundingClientRect().height)] : null;
    const sections = Array.from(panel.querySelectorAll<HTMLElement>("[data-frame-collage-variant]"));
    return {
      form: panel.dataset.frameCollageForm,
      feedHeight: Math.round(feed.height),
      panel: [Math.round(panel.getBoundingClientRect().width), Math.round(panel.getBoundingClientRect().height)],
      panelInsideFeed: tall(panel.getBoundingClientRect()),
      entryOnScreen: tall(document.querySelector('[data-frame-control="entry"]')!.getBoundingClientRect()),
      chooseOnScreen: sections.map((section) => tall(section.querySelector('[data-frame-control^="choose-"]')!.getBoundingClientRect())),
      /* Per variant: tiles wholly on screen, tiles in all, and whether every row of them is inside the feed top to bottom. */
      tiles: sections.map((section) => {
        const tiles = Array.from(section.querySelectorAll('[data-frame-control^="tile-"]'));
        return { onScreen: tiles.filter(whole).length, of: tiles.length, rows: section.querySelectorAll("[data-frame-collage-row]").length,
          rowsInsideFeed: Array.from(section.querySelectorAll("[data-frame-collage-row]")).every((row) => tall(row.getBoundingClientRect())) };
      }),
      /* Per variant: the title as shown, and whether any of it is cut (by an ellipsis, by a clipping box, or by the feed's edge). */
      titles: sections.map((section) => {
        const title = section.querySelector<HTMLElement>("[data-frame-variant-title]")!;
        const rect = title.getBoundingClientRect();
        const within = section.getBoundingClientRect();
        return { text: title.textContent ?? "", box: [Math.round(rect.width), Math.round(rect.height)],
          cut: title.scrollWidth > title.clientWidth + 1 || title.scrollHeight > title.clientHeight + 1 || getComputedStyle(title).textOverflow === "ellipsis"
            || rect.left < within.left - 1 || rect.right > within.right + 1 || !tall(rect) };
      }),
      /* Per variant: the tile that stands for the frames the row has no room for. */
      more: sections.map((section) => section.querySelector('[data-frame-control^="more-"]')?.textContent ?? null),
      /* The row of the frames of no variant. */
      other: (() => {
        const row = panel.querySelector('[data-frame-control="other"]');
        return row ? { text: (row.textContent ?? "").replace(/\s+/g, " ").trim(), onScreen: tall(row.getBoundingClientRect()) } : null;
      })(),
      stripHeight: panel.dataset.frameCollageForm === "strip" ? Math.round(panel.querySelector("[data-frame-collage-row] > button")!.getBoundingClientRect().height) : null,
      tileOf: Object.fromEntries([1440, 440, 390].map((width) => [width, size(panel.querySelector(`[data-frame-tile-of="${width}"]`))])),
    };
  });

  /** How far the set's row starts from the answer's text above it: the left
      edge of the answer's first glyph, which is where the feed's tool cards
      start too. The row of an answer is wider than its text on the desktop
      (the avatar's gutter), so the row's box says nothing about this. */
  const leftOfAnswer = (page: import("playwright-core").Page) => page.evaluate(() => {
    const host = document.querySelector<HTMLElement>("[data-frame-set-host]")!;
    const body = host.parentElement!.querySelector("[data-tts-body]");
    if (!body) return null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").search(/\S/);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const glyph = range.getClientRects()[0];
      if (glyph) return Math.round(document.querySelector('[data-frame-control="entry"]')!.getBoundingClientRect().left - glyph.left);
    }
    return null;
  });

  browserTest("the closed entry covers nothing, and every variant reaches a frame and a chosen reply", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const served = await serveEvidenceFixture(OUT, FIXTURE);
    let browser: Browser | undefined;
    const failures: string[] = [];
    const evidence: Record<string, Record<string, unknown>> = {};
    const baselines = new Map<string, Reading>();
    const written = new Set<string>();
    try {
      browser = await chromium.launch(LAUNCH);
      for (const viewport of VIEWPORTS) for (const lang of LANGS) for (const variant of [0, 1, 2, 3, 4] as const) {
        const where = `variant-${variant}-${viewport.name}-${lang}`;
        const url = `${served.base}?case=frame-sets&variant=${variant}&lang=${lang}${viewport.pane ? `&pane=${viewport.pane}` : ""}`;
        const { context, page, pageErrors } = await openFixture(browser, url, { width: viewport.width, height: viewport.height }, "dark", lang, "reduce", viewport.phone);
        const fail = (moment: string, what: string) => failures.push(`${where} ${moment}: ${what}`);
        const settled = () => page.waitForTimeout(350);
        const ready = async () => {
          await page.locator(`[data-frame-proto="${variant}"]`).waitFor();
          await page.locator('[data-feed-kind="user"]').first().waitFor();
          if (variant !== 0) await page.locator('[data-frame-control="entry"]').waitFor();
          await settled();
        };
        const presses: Press[] = [];
        const press = async (control: string) => {
          /* Read first: the click below scrolls its target into view by itself. */
          const before = await reach(page, control);
          await page.locator(`[data-frame-control="${control}"]`).click();
          presses.push({ control, ...before });
          await page.waitForTimeout(200);
        };
        const walked = () => ({
          presses: presses.map((entry) => ({ ...entry })),
          count: presses.length,
          scrolled: { down: presses.reduce((sum, entry) => sum + entry.scrollY, 0), sideways: presses.reduce((sum, entry) => sum + entry.scrollX, 0) },
        });
        const check = (moment: string, reading: Reading) => {
          for (const control of reading.controls) {
            if (!control.hit) fail(moment, `${control.name} is not what a pointer meets at its centre and corners`);
            if (control.overlaps.length) fail(moment, `${control.name} intersects ${control.overlaps.join(", ")}`);
            if (control.overRows.length) fail(moment, `${control.name} lies over ${control.overRows.join(", ")}`);
            if (!control.insideWindow) fail(moment, `${control.name} leaves the window`);
            if (viewport.phone && (control.size[0] < 44 || control.size[1] < 44)) fail(moment, `${control.name} is ${control.size[0]} x ${control.size[1]}, under 44 px`);
          }
          if (reading.overflowX) fail(moment, `the page scrolls sideways by ${reading.overflowX}`);
        };
        const shot = (moment: DriverMoment) => {
          const name = driverFrameName(variant, viewport.name, lang, moment);
          written.add(name);
          return page.screenshot({ path: path.join(OUT, name) });
        };
        const key = `${viewport.name}-${lang}`;
        try {
          await ready();
          expect(await page.locator("[data-frame-variant-number]").textContent()).toBe(String(variant));
          expect((await page.locator("[data-frame-variant-number]").boundingBox())!.height).toBeGreaterThanOrEqual(28);

          /* Closed: the pane with the entry against the pane without it. */
          const closed = await measure(page);
          await shot("closed");
          if (variant === 0) {
            baselines.set(key, closed);
            expect(closed.callRow).not.toBeNull();
            expect(pageErrors).toEqual([]);
            continue;
          }
          const baseline = baselines.get(key)!;
          const record: Record<string, unknown> = (evidence[where] = {});
          check("closed", closed);
          const closedChanges = moved(baseline, closed);
          for (const change of closedChanges) fail("closed", `"${change.probe}" changed by ${JSON.stringify(change.delta)} against the pane without the feature`);
          expect(closed.controls.map((control) => control.name)).toEqual(["entry"]);
          const title = await page.locator("[data-frame-title]").evaluate((element) => ({ shown: Math.round(element.getBoundingClientRect().width), needs: element.scrollWidth, text: element.textContent ?? "" }));
          const offset = await leftOfAnswer(page);
          if (offset !== 0) fail("closed", `the set's row starts ${offset} px from the answer's text`);
          record.closed = {
            entry: closed.controls[0], leftOfAnswer: offset, rowHeight: closed.entryRow![3], toolRowHeightToday: baseline.callRow![3],
            feedGrowsBy: closed.feed.scrollHeight - baseline.feed.scrollHeight,
            title: { ...title, cut: title.needs > title.shown + 1 },
            counts: await page.locator("[data-frame-counts]").textContent(),
            changedAgainstNoFeature: closedChanges,
          };

          /* Open. */
          await press("entry");
          await page.locator("[data-frame-panel]").waitFor();
          await settled();
          const open = await measure(page);
          await shot("open");
          check("open", open);
          if (!open.modal && !open.controls.some((control) => control.name === "entry")) fail("open", "the row that was pressed left the screen");
          const openChanges = open.modal ? [] : moved(baseline, open);
          /* Opened in place, the row moves to the top of the feed, so the feed
             is off its tail and shows its own way-back row, as it does after
             any scroll up. Nothing else may differ. */
          for (const change of openChanges.filter((entry) => !/^(feed|jump-strip new)$/.test(entry.probe))) fail("open", `"${change.probe}" changed by ${JSON.stringify(change.delta)} against the pane without the feature`);
          record.open = {
            surface: open.modal ? "full screen, as the image viewer is" : "in the feed's own flow",
            panel: open.panel,
            entryStillOnScreen: open.controls.some((control) => control.name === "entry"),
            controls: open.controls.length,
            feedFromTail: open.feed.fromTail,
            changedAgainstNoFeature: openChanges,
          };
          if (variant === 4) {
            /* The recommended form: every "Choose" and every row of tiles needs no scroll once it is open. */
            const laid = await collage(page);
            (record.open as Record<string, unknown>).collage = laid;
            if (!laid.panelInsideFeed) fail("open", `the collage is ${laid.panel[1]} px tall in a feed of ${laid.feedHeight} px`);
            if (laid.chooseOnScreen.includes(false)) fail("open", `"Choose" needs a scroll: ${JSON.stringify(laid.chooseOnScreen)}`);
            if (laid.tiles.some((entry) => !entry.rowsInsideFeed || entry.onScreen === 0)) fail("open", `a variant's tiles need a scroll: ${JSON.stringify(laid.tiles)}`);
            /* A variant's title is what the operator tells the variants apart by before "Choose N". */
            for (const title of laid.titles.filter((entry) => entry.cut)) fail("open", `a variant's title is cut: ${JSON.stringify(title)}`);
            if (laid.titles.length !== 4) fail("open", `${laid.titles.length} variant titles, wanted 4`);
            if (laid.tiles.some((entry) => entry.rows !== 1)) fail("open", `a variant has more than one row of tiles: ${JSON.stringify(laid.tiles)}`);
            if (!viewport.phone && !viewport.pane && (laid.tileOf[1440]?.[0] ?? 0) < 180) fail("open", `a desktop frame's tile is ${JSON.stringify(laid.tileOf[1440])} on the desktop`);
          }

          /* To one frame: variant 3, its fifth. */
          if (variant === 1 || variant === 2) { await press(`tab-${TARGET.variant}`); await press(`thumb-${TARGET.index}`); }
          if (variant === 3) { await press(`left-tab-${TARGET.variant}`); await press(`view-${TARGET.index}`); }
          if (variant === 4) { await press(`tile-${TARGET.inSet}`); await page.locator("[data-lightbox-position]").waitFor(); }
          await settled();
          const at = async () => {
            const reading = await measure(page);
            return variant === 4 ? reading.lightbox : reading.shown[0];
          };
          const there = variant === 4 ? `${TARGET.inSet + 1} / ${TARGET.frames}` : TARGET.id;
          const before = variant === 4 ? `${TARGET.inSet} / ${TARGET.frames}` : TARGET.before;
          const after = variant === 4 ? `${TARGET.inSet + 2} / ${TARGET.frames}` : TARGET.after;
          if (await at() !== there) fail("frame", `shows ${await at()}, wanted ${there}`);
          await shot("frame");
          if (variant !== 4) {
            const reached = await measure(page);
            check("frame", reached);
            if (!reached.modal && !reached.controls.some((control) => control.name === "entry")) fail("frame", "the row that was pressed left the screen");
          }
          record.toFrame = { ...walked(), shows: await at() };

          /* By key on the desktop, by swipe on the phone: one back, one forward again, one on. */
          const steps: Record<string, unknown> = {};
          if (!viewport.phone) {
            await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(150);
            steps.arrowLeft = await at();
            await page.keyboard.press("ArrowRight"); await page.waitForTimeout(150);
            steps.arrowRight = await at();
            if (steps.arrowLeft !== before || steps.arrowRight !== there) fail("keys", `arrows gave ${JSON.stringify(steps)}`);
            if (variant === 1 || variant === 2) {
              await page.keyboard.press("2"); await page.waitForTimeout(150);
              steps.digit2 = await at();
              if (steps.digit2 !== "fixture-2-1440-en") fail("keys", `the digit gave ${steps.digit2}`);
            }
          } else {
            const stage = variant === 1 ? page.locator('[data-frame-control="stage"]') : variant === 4 ? page.locator('[role="dialog"] img:not([hidden])') : page.locator("[data-frame-stage]");
            const area = (await stage.boundingBox())!;
            const cdp = await context.newCDPSession(page);
            const y = Math.round(area.y + area.height / 2);
            const swipe = async (from: number, to: number) => {
              await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
              for (let step = 1; step <= 4; step += 1) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(from + ((to - from) * step) / 4), y }] });
              await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              await page.waitForTimeout(250);
            };
            const centre = Math.round(area.x + area.width / 2);
            await swipe(centre + 90, centre - 90);
            steps.swipeLeft = await at();
            await swipe(centre - 90, centre + 90);
            steps.swipeRight = await at();
            if (steps.swipeLeft !== after || steps.swipeRight !== there) fail("swipe", `swipes gave ${JSON.stringify(steps)}`);
          }
          record.steps = steps;

          /* To a chosen variant, from the closed row of a fresh pane. */
          await page.reload();
          await ready();
          presses.length = 0;
          await press("entry");
          if (variant === 1 || variant === 2) { await press(`tab-${TARGET.variant}`); await press("choose"); }
          if (variant === 3) { await press(`left-tab-${TARGET.variant}`); await press("choose-left"); }
          if (variant === 4) await press(`choose-${TARGET.variant}`);
          await settled();
          const chosen = await measure(page);
          if (chosen.draft !== REPLY[lang]) fail("choose", `the field holds ${JSON.stringify(chosen.draft)}`);
          if (chosen.modal) fail("choose", "the full-screen surface still covers the field");
          /* The reply is a draft: the operator adds to it and nothing was sent. */
          await page.locator("textarea").first().click();
          await page.keyboard.press("End");
          await page.keyboard.type(lang === "uk" ? " Лічильник лишити." : " Keep the counter.");
          await page.waitForTimeout(200);
          const edited = await measure(page);
          if (!edited.draft.startsWith(REPLY[lang]) || edited.draft === REPLY[lang]) fail("choose", `the draft did not take typing: ${JSON.stringify(edited.draft)}`);
          const sent = await page.locator('[data-feed-kind="user"]').count();
          if (sent !== 3) fail("choose", `${sent} own messages in the feed, wanted the three it started with`);
          /* The reply made the field taller. With the surface gone (2 and 3)
             the closed row is the feed's last thing and has to be whole. */
          const rowAfter = await reach(page, "entry");
          if ((variant === 2 || variant === 3) && !rowAfter.onScreen) fail("choose", `the set's row is ${rowAfter.scrollY} px under the feed's edge once the reply is in the field`);
          await shot("chosen");
          record.choose = { ...walked(), draft: chosen.draft, fieldFocused: chosen.composerFocused, afterTyping: edited.draft, sent: sent - 3, entryWholeAfter: rowAfter.onScreen };
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
      }
      /* A set of a real lane's size, in the recommended variant. Six frames a
         variant fit one row at every width; twenty-four do not, and a collage
         that wraps them is taller than the feed. After opening, every
         "Choose" is on screen and the collage is inside the feed, or the run
         fails. Then the same walk: variant 3's fifth frame, the frames of no
         variant, and a chosen reply. */
      for (const viewport of VIEWPORTS) for (const lang of LANGS) {
        const where = `variant-4-${viewport.name}-${lang}-lane-set`;
        const url = `${served.base}?case=frame-sets&variant=4&set=lane&lang=${lang}${viewport.pane ? `&pane=${viewport.pane}` : ""}`;
        const { context, page, pageErrors } = await openFixture(browser, url, { width: viewport.width, height: viewport.height }, "dark", lang, "reduce", viewport.phone);
        const fail = (moment: string, what: string) => failures.push(`${where} ${moment}: ${what}`);
        const ready = async () => {
          await page.locator('[data-frame-proto="4"]').waitFor();
          await page.locator('[data-frame-control="entry"]').waitFor();
          await page.waitForTimeout(350);
        };
        const presses: Press[] = [];
        const press = async (control: string) => {
          const before = await reach(page, control);
          await page.locator(`[data-frame-control="${control}"]`).click();
          presses.push({ control, ...before });
          await page.waitForTimeout(200);
        };
        const walked = () => ({
          presses: presses.map((entry) => ({ ...entry })),
          count: presses.length,
          scrolled: { down: presses.reduce((sum, entry) => sum + entry.scrollY, 0), sideways: presses.reduce((sum, entry) => sum + entry.scrollX, 0) },
        });
        const check = (moment: string, reading: Reading) => {
          for (const control of reading.controls) {
            if (!control.hit) fail(moment, `${control.name} is not what a pointer meets at its centre and corners`);
            if (control.overlaps.length) fail(moment, `${control.name} intersects ${control.overlaps.join(", ")}`);
            if (control.overRows.length) fail(moment, `${control.name} lies over ${control.overRows.join(", ")}`);
            if (!control.insideWindow) fail(moment, `${control.name} leaves the window`);
            if (viewport.phone && (control.size[0] < 44 || control.size[1] < 44)) fail(moment, `${control.name} is ${control.size[0]} x ${control.size[1]}, under 44 px`);
          }
          if (reading.overflowX) fail(moment, `the page scrolls sideways by ${reading.overflowX}`);
        };
        const shot = (moment: DriverMoment) => {
          const name = driverFrameName(4, viewport.name, lang, moment);
          written.add(name);
          return page.screenshot({ path: path.join(OUT, name) });
        };
        const position = async () => (await measure(page)).lightbox;
        try {
          await ready();
          const baseline = baselines.get(`${viewport.name}-${lang}`)!;
          const closed = await measure(page);
          check("closed", closed);
          const closedChanges = moved(baseline, closed);
          for (const change of closedChanges) fail("closed", `"${change.probe}" changed by ${JSON.stringify(change.delta)} against the pane without the feature`);
          expect(closed.controls.map((control) => control.name)).toEqual(["entry"]);
          const offset = await leftOfAnswer(page);
          if (offset !== 0) fail("closed", `the set's row starts ${offset} px from the answer's text`);

          await press("entry");
          await page.locator("[data-frame-panel]").waitFor();
          await page.waitForTimeout(350);
          const open = await measure(page);
          await shot("lane-open");
          check("open", open);
          const openChanges = moved(baseline, open);
          for (const change of openChanges.filter((entry) => !/^(feed|jump-strip new)$/.test(entry.probe))) fail("open", `"${change.probe}" changed by ${JSON.stringify(change.delta)} against the pane without the feature`);
          const laid = await collage(page);
          if (!laid.entryOnScreen) fail("open", "the row that was pressed left the screen");
          if (!laid.panelInsideFeed) fail("open", `the collage is ${laid.panel[1]} px tall in a feed of ${laid.feedHeight} px`);
          if (laid.chooseOnScreen.length !== 4 || laid.chooseOnScreen.includes(false)) fail("open", `"Choose" is past the feed's edge: ${JSON.stringify(laid.chooseOnScreen)}`);
          if (laid.tiles.some((entry) => entry.rows !== 1 || !entry.rowsInsideFeed || entry.onScreen === 0)) fail("open", `a variant's tiles need a scroll: ${JSON.stringify(laid.tiles)}`);
          for (const title of laid.titles.filter((entry) => entry.cut)) fail("open", `a variant's title is cut: ${JSON.stringify(title)}`);
          if (!laid.other?.onScreen) fail("open", `the row of the frames of no variant: ${JSON.stringify(laid.other)}`);

          /* To variant 3's fifth frame: its tile when the row holds it, else
             the "+N" tile and steps in the viewer. */
          const tile = await page.locator(`[data-frame-control="tile-${LANE.target}"]`).count();
          let stepsInViewer = 0;
          await press(tile ? `tile-${LANE.target}` : `more-${TARGET.variant}`);
          await page.locator("[data-lightbox-position]").waitFor();
          const there = `${LANE.target + 1} / ${LANE.frames}`;
          for (; stepsInViewer < 8 && await position() !== there; stepsInViewer += 1) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(150); }
          if (await position() !== there) fail("frame", `shows ${await position()}, wanted ${there}`);
          await shot("lane-frame");
          const toFrame = { ...walked(), stepsInViewer, shows: await position() };
          await page.keyboard.press("Escape");
          await page.locator("[data-lightbox-position]").waitFor({ state: "detached" });

          /* The frames of no variant: one press from the open collage. */
          await press("other");
          await page.locator("[data-lightbox-position]").waitFor();
          const firstOther = await position();
          if (firstOther !== `${LANE.firstOther + 1} / ${LANE.frames}`) fail("other", `shows ${firstOther}, wanted ${LANE.firstOther + 1} / ${LANE.frames}`);
          await page.keyboard.press("Escape");
          await page.locator("[data-lightbox-position]").waitFor({ state: "detached" });

          await page.reload();
          await ready();
          presses.length = 0;
          await press("entry");
          await press(`choose-${TARGET.variant}`);
          await page.waitForTimeout(350);
          const chosen = await measure(page);
          if (chosen.draft !== LANE_REPLY[lang]) fail("choose", `the field holds ${JSON.stringify(chosen.draft)}`);
          evidence[where] = {
            set: { frames: LANE.frames, perVariant: LANE.perVariant, ofNoVariant: LANE.others },
            closed: { entry: closed.controls[0], leftOfAnswer: offset, counts: await page.locator("[data-frame-counts]").textContent(), changedAgainstNoFeature: closedChanges },
            open: { panel: open.panel, controls: open.controls.length, feedFromTail: open.feed.fromTail, changedAgainstNoFeature: openChanges, collage: laid },
            toFrame,
            toFramesOfNoVariant: { presses: 2, shows: firstOther },
            choose: { ...walked(), draft: chosen.draft, fieldFocused: chosen.composerFocused },
          };
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
      }
      /* The moment the answer arrives. The turn is a real one's shape: seven
         Delegatus calls, none of which folds, and an answer of two screens
         with a table. The feed holds its tail, so what is on screen then is
         the end of the answer. Read for both places the entry can stand. */
      for (const viewport of VIEWPORTS) for (const lang of LANGS) for (const place of ["call", "turn"] as const) {
        const where = `arrival-${place}-${viewport.name}-${lang}`;
        const url = `${served.base}?case=frame-sets&variant=4&lang=${lang}&arrive=hold&place=${place}${viewport.pane ? `&pane=${viewport.pane}` : ""}`;
        const { context, page, pageErrors } = await openFixture(browser, url, { width: viewport.width, height: viewport.height }, "dark", lang, "reduce", viewport.phone);
        try {
          await page.locator('[data-frame-proto="4"]').waitFor();
          await page.locator('[data-frame-control="entry"]').waitFor();
          await page.waitForTimeout(350);
          const held = await measure(page);
          await page.evaluate(() => (window as unknown as { frameSets: { deliver: () => void } }).frameSets.deliver());
          await page.waitForFunction((was) => document.querySelector("[data-log-feed-scroller]")!.scrollHeight > was + 200, held.feed.scrollHeight);
          await page.waitForTimeout(500);
          const arrived = await measure(page);
          const entry = await reach(page, "entry");
          const turn = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-log-feed-scroller] [data-feed-kind]"));
            const last = rows.map((row) => row.dataset.feedKind).lastIndexOf("user");
            const answer = rows[rows.length - 1]!;
            return { delegatusCalls: rows.slice(last + 1).filter((row) => row.dataset.feedKind === "tool").length + document.querySelectorAll("[data-frame-set-row]").length
              - rows.slice(last + 1).filter((row) => row.dataset.frameSetRow !== undefined).length, answerHeight: Math.round(answer.getBoundingClientRect().height) };
          });
          written.add(driverArrivalName(place, viewport.name, lang));
          await page.screenshot({ path: path.join(OUT, driverArrivalName(place, viewport.name, lang)) });
          evidence[where] = {
            turn: { ...turn, feedHeight: arrived.feed.clientHeight, answerInFeeds: Math.round((turn.answerHeight / arrived.feed.clientHeight) * 10) / 10 },
            beforeTheAnswer: { entryOnScreen: (await Promise.resolve(held.controls.some((control) => control.name === "entry"))) },
            whenTheAnswerArrives: { feedFromTail: arrived.feed.fromTail, entryOnScreen: entry.onScreen, scrollToEntry: entry.scrollY },
          };
          if (arrived.feed.fromTail > 2) failures.push(`${where}: the feed is ${arrived.feed.fromTail} px off its tail when the answer arrives`);
          if (place === "turn") {
            if (!entry.onScreen) failures.push(`${where}: the entry is ${entry.scrollY} px off screen when the answer arrives`);
            for (const control of arrived.controls) {
              if (!control.hit) failures.push(`${where}: ${control.name} is not what a pointer meets`);
              if (control.overlaps.length || control.overRows.length) failures.push(`${where}: ${control.name} intersects ${[...control.overlaps, ...control.overRows].join(", ")}`);
            }
          }
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
      }
      fs.writeFileSync(
        path.join(EVIDENCE, "measurements.json"),
        `{\n${Object.entries(evidence).map(([where, moments]) => `  ${JSON.stringify(where)}: {\n${
          Object.entries(moments).map(([moment, reading]) => `    ${JSON.stringify(moment)}: ${JSON.stringify(reading)}`).join(",\n")
        }\n  }`).join(",\n")}\n}\n`,
      );
      /* The list the model test publishes by the short form is the list written here. */
      expect([...written].sort()).toEqual(driverFrameNames().sort());
      expect(failures).toEqual([]);
    } finally {
      await browser?.close();
      served.stop();
    }
  }, 1_800_000);
});
