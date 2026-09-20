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
    | { state: string; act: "settle"; status: "delivered" | "queued" | "uncertain" }
    | { state: string; act: "axes"; host: string; turn: string }
    | { state: string; act: "echo" }
    | { state: string; act: "disclose"; target: "progress" | "reason" };

  const SCENARIOS: { id: string; steps: Step[] }[] = [
    /* An ordinary send that simply works, all the way to the transcript's own
       record being adopted into the row the operator already had. */
    { id: "success", steps: [
      { state: "submitted", act: "submit-button" },
      { state: "accepted", act: "settle", status: "queued" },
      { state: "confirmed", act: "settle", status: "delivered" },
      { state: "transcript", act: "echo" },
    ] },
    /* Admitted and parked: the agent is inside a turn, and a structured send
       only crosses at a turn boundary. */
    { id: "queued-behind-turn", steps: [
      { state: "submitted", act: "submit-keyboard" },
      { state: "queued-behind-turn", act: "axes", host: "hosted", turn: "running" },
    ] },
    /* Admitted while nothing is hosting the conversation: the send raises the
       host on its way to delivering. */
    { id: "held-for-host", steps: [
      { state: "submitted", act: "submit-button" },
      { state: "held-for-host", act: "axes", host: "recovering", turn: "unknown" },
    ] },
    /* The acknowledgement never came back. The message may well be in the
       journal, so the row may never say it was not sent. */
    { id: "lost-acknowledgement", steps: [
      { state: "lost-acknowledgement", act: "submit-button" },
      { state: "lost-acknowledgement-open", act: "disclose", target: "progress" },
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
      /** Distance from the window's right edge and from its own row's top. */
      right: number;
      top: number;
    } | null;
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
        top: rowRect ? Math.round(rect.top - rowRect.top) : 0,
      } : null,
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
      phase: row?.getAttribute("data-message-row") ?? null,
      /* The queue's own word for this entry, kept in the record so a frame
         that reads oddly can be traced back to the state it was really in. */
      outboxState: row?.getAttribute("data-outbox-state") ?? null,
      queue: (window as unknown as { llvHost?: { queue(): unknown[] } }).llvHost?.queue() ?? [],
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      viewportWidth: window.innerWidth,
    };
  };

  /** Mark the row and its body so later frames can prove they are the same. */
  const MARK = () => {
    const row = document.querySelector("[data-message-row]")
      ?? document.querySelector("[data-outbox-entry]")
      ?? document.querySelector('[data-feed-kind="user"]');
    if (row) (row as HTMLElement).dataset.observedRow = "1";
    const bubbles = [...document.querySelectorAll("div")].filter((node) => node.className.includes("bg-user"));
    const bubble = bubbles[bubbles.length - 1];
    if (bubble) (bubble as HTMLElement).dataset.observedBody = "1";
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
                await page.evaluate((id) => {
                  const host = (window as unknown as { llvHost: Record<string, (...args: unknown[]) => void> }).llvHost;
                  host.reset();
                  host.scenario(id);
                }, scenario.id);
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
                  } else if (step.act === "submit-button" || step.act === "submit-keyboard") {
                    if (scenario.id !== "attachment-and-context") await page.fill("textarea", MESSAGE);
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
                     answers whether that row survived the transition. */
                  if (!marked && reading.bubbles > 0) {
                    await page.evaluate(MARK);
                    marked = true;
                  }
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

          /* A lost acknowledgement never reads as a message that was not sent,
             and what it offers is a question, never a second send. */
          const unknown = at(`lost-acknowledgement-lost-acknowledgement-${suffix}`);
          expect({ suffix, phase: unknown.phase }).toEqual({ suffix, phase: "pending" });
          expect(unknown.aside).toContain(translate(lang, "outbox.awaitingConfirmation"));
          const unknownOpen = at(`lost-acknowledgement-lost-acknowledgement-open-${suffix}`);
          expect(unknownOpen.aside).toContain(translate(lang, "orchPanel.errorUnknownTitle"));
          expect(unknownOpen.controls).toContain(translate(lang, "outbox.action.checkStatus"));
          expect(unknownOpen.controls).not.toContain(translate(lang, "outbox.action.takeBack"));
          expect(unknownOpen.controls).not.toContain(translate(lang, "outbox.action.retry"));
          /* Opening the evidence never moves the message itself. */
          expect({ suffix, bubble: unknownOpen.bubble }).toEqual({ suffix, bubble: unknown.bubble });

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
             BOTH on its row, and the reference survives the transcript's own
             record arriving. The attachment count is the local submission's
             own fact and retires with it: the transcript carries the image as
             its own row. */
          const withAttachment = at(`attachment-and-context-submitted-with-attachment-${suffix}`);
          expect(withAttachment.badge).toContain("release-blockers");
          expect(withAttachment.inBubble).toContain(translate(lang, "composer.imagesCount", { count: 1 }));
          const attachmentTranscript = at(`attachment-and-context-attachment-transcript-${suffix}`);
          expect(attachmentTranscript.badge).toContain("release-blockers");
          expect({ suffix, phase: attachmentTranscript.phase }).toEqual({ suffix, phase: "confirmed" });
          expect({ suffix, sameNode: attachmentTranscript.sameNode, sameBody: attachmentTranscript.sameBody })
            .toEqual({ suffix, sameNode: true, sameBody: true });
        }
      }
    }
  }, 1_800_000);
});
