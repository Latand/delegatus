/**
 * The composer stays usable while the agent's host is gone.
 *
 * OBSERVATION STEP. Each test below names one gate that current main puts
 * between the operator and Send when the host is gone, and asserts the wanted
 * behaviour instead — so on main each one fails, and names the component and
 * the exact condition that produced it:
 *
 *  A. INPUT GATED. A conversation whose host record is gone entirely projects
 *     `hostKind: "unhosted"` (`registrySessionProjection`, the registry-derived
 *     runtime row with no `structuredHost` behind it). `structuredSessionOf`
 *     answers null for that kind, so `TmuxComposer`'s
 *     `deadHostBlocksSend = deadHost && !structuredSession` is true and
 *     `ComposerBar` receives `sendDisabledReason = deadHost.sendBlocked` plus
 *     `showImage={false}` — Send is inert and the attach control is not
 *     rendered at all.
 *
 *  B. IMAGES WITHHELD. A structured host whose axis went `dead` keeps its
 *     `codex-app-server` kind, so Send stays live but the capability matrix's
 *     `dead` row disables `images`. One staged image then makes `ComposerBar`'s
 *     `imageSendBlocked` true and the whole message — text included — cannot
 *     leave.
 *
 *  C. DICTATION BLOCKED. `ComposerBar` passes `busy={voiceSending || sendBlocked}`
 *     to `MicButtonView`, so gate A takes the mic down with Send.
 *
 * The server side is not the constraint: `deliverStructuredMessage` classifies
 * exactly these conversations `reclaimed`, raises the host itself
 * (`requiresDeadConversationRecovery` → `recoverDeadStructuredConversation`),
 * and judges the image payload against the RECOVERED session. The browser is
 * what withholds, so the browser is what these tests move.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";
import { setTmuxComposerRuntimeDependenciesForTests } from "@/components/tmuxComposerRuntime";
import {
  ComposerAdmissionTimeoutError,
  setComposerAdmissionTimingForTests,
} from "./composerAdmissionDeadline";
import type { RuntimeAdmissionLookup } from "@/hooks/useRuntime";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { installTmuxComposerRuntimeForTests, resetTmuxComposerRuntimeForTests } from "@/test-helpers/tmuxComposerRuntime";
import { agentCapabilitiesFromViews } from "./useAgentCapabilities";
import { composerSlotKind } from "./ComposerBar";
import { readOutbox, resetOutboxForTests } from "./conversation/outbox";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/** The registry-derived row for a conversation whose host is gone: no
    structured host record survives, so the projection carries `unhosted` for
    BOTH the kind and the axis. This is the production shape behind "the agent
    is not running any more", and the one the browser refuses to send on. */
function reclaimedView(conversationId: string): RuntimeSessionView {
  return {
    session: {
      conversationId,
      sessionKey: { engine: "codex", sessionId: "codex-session-reclaimed" },
      hostKind: "unhosted",
      host: "unhosted",
      turn: "unknown",
      provenance: "derived",
      revision: 7,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "viewer",
      artifactPath: null,
      capabilities: {
        steer: false,
        structuredAttention: false,
        imageInput: { supported: true },
        runtimeSettings: { perTurnEffort: true, perTurnModel: false },
      },
      activeTurnId: null,
    },
    uiState: {},
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as unknown as RuntimeSessionView;
}

/** A structured host that died with its registry record intact: the kind stays
    `codex-app-server` and only the axis flips. */
function deadStructuredView(conversationId: string): RuntimeSessionView {
  const view = reclaimedView(conversationId) as unknown as { session: Record<string, unknown> };
  return {
    ...(view as unknown as RuntimeSessionView),
    session: {
      ...view.session,
      hostKind: "codex-app-server",
      host: "dead",
      turn: "idle",
      provenance: "structured",
    },
  } as unknown as RuntimeSessionView;
}

const VIEWS: Record<string, RuntimeSessionView> = {};

import { TmuxComposer } from "./TmuxComposer";

const realFetch = globalThis.fetch;
/* happy-dom has no IndexedDB, and the composer retains the COMPLETE submission
   — text and attachment bytes under one key — before any of it reaches the
   wire. Without this the whole-message admission cannot even be attempted. */
const composerStorage = installComposerStorageForTests();
afterAll(() => composerStorage.uninstall());
let sentBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  composerStorage.reset();
  /* The outbox is a module-level store: without this, a queue entry one case
     left behind is still on the card the next one renders, and a recovery row
     from a previous message answers a `querySelector` meant for this one. */
  resetOutboxForTests();
  sentBodies = [];
  VIEWS["conv-reclaimed"] = reclaimedView("conv-reclaimed");
  VIEWS["conv-dead-structured"] = deadStructuredView("conv-dead-structured");
  installTmuxComposerRuntimeForTests({
    useRuntimeView: (file) => (file.conversationId ? VIEWS[file.conversationId] ?? null : null),
    runtimeEnabled: true,
    refreshRuntime: async () => true,
  });
});

afterEach(() => {
  setComposerAdmissionTimingForTests(null);
  resetTmuxComposerRuntimeForTests();
  setLocale("en");
  mobile = false;
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

function conversationFile(conversationId: string): FileEntry {
  return {
    path: `/${conversationId}.jsonl`,
    root: "codex-sessions",
    name: `${conversationId}.jsonl`,
    project: "viewer",
    title: "Viewer-launched conversation",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    lastTurn: { startedAt: 1_000, endedAt: 2_000 },
    conversationId,
    spawnOrigin: "viewer",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

function quietWire(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

/** Records every structured send the composer makes and answers `held`, which
    is what the server returns once the instruction is durably reserved and the
    host recovery is under way. */
function recordingSend(): void {
  setTmuxComposerRuntimeDependenciesForTests({
    useAgentCapabilities: (file) => agentCapabilitiesFromViews(
      file,
      file.conversationId ? VIEWS[file.conversationId] ?? null : null,
      null,
      true,
    ),
    refreshRuntime: async () => true,
    sendRuntimeMessage: (async (body: Record<string, unknown>) => {
      sentBodies.push(body);
      return {
        ok: true,
        held: true,
        operationId: "op-recovering",
        receipt: {
          operationId: "op-recovering",
          idempotencyKey: String(body.idempotencyKey ?? ""),
          conversationId: String(body.conversationId ?? ""),
          kind: "send",
          status: "queued",
          text: String(body.text ?? ""),
          at: "2026-09-20T00:00:00.000Z",
          revision: 1,
        },
      };
    }) as never,
  });
}

async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

function typeInto(host: HTMLElement, value: string): void {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value } }));
}

function pasteImage(host: HTMLElement, tag: string): void {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  const bytes = new TextEncoder().encode(`png-${tag}`);
  props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([bytes], `${tag}.png`, { type: "image/png" }) }] },
    preventDefault() {},
  });
}

async function untilPreviews(host: HTMLElement, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && host.querySelectorAll("img").length !== count; attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
  }
  expect(host.querySelectorAll("img").length).toBe(count);
}

const sendButton = (host: HTMLElement, locale: "en" | "uk"): HTMLButtonElement =>
  host.querySelector(`button[aria-label="${translate(locale, "composer.sendToAgent")}"]`) as HTMLButtonElement;

/* ── GATE A: the input is gated on a reclaimed host ─────────────────────────── */

test.each(["en", "uk"] as const)(
  "[%s] gate A — a reclaimed host keeps Send live and the attach control on the row",
  async (locale) => {
    setLocale(locale);
    mobile = false;
    quietWire();
    const { host, root } = await renderInto(<TmuxComposer file={conversationFile("conv-reclaimed")} deadHost />);
    try {
      typeInto(host, "Pick this back up, please.");

      const send = sendButton(host, locale);
      expect(send).toBeTruthy();
      expect(send.getAttribute("aria-disabled")).toBe("false");
      expect(send.disabled).toBe(false);
      /* No "host is dead — respawn to continue" strip stands between the
         operator and the send. */
      expect(host.querySelector('[data-testid="composer-send-blocked"]')).toBeNull();
      expect(host.textContent).not.toContain(translate(locale, "deadHost.sendBlocked"));

      /* The attach control is on the row and open: an image is part of the
         message the operator is writing, not something to add after a manual
         restore. */
      const attach = host.querySelector(`button[aria-label="${translate(locale, "composer.addAttachments")}"]`) as HTMLButtonElement;
      expect(attach).toBeTruthy();
      expect(attach.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

/* ── GATE C: dictation on the same surface ──────────────────────────────────── */

test("gate C — a reclaimed host leaves dictation available", async () => {
  quietWire();
  const { host, root } = await renderInto(<TmuxComposer file={conversationFile("conv-reclaimed")} deadHost />);
  try {
    const mic = host.querySelector(`button[aria-label="${translate("en", "mic.dictate")}"]`) as HTMLButtonElement;
    expect(mic).toBeTruthy();
    expect(mic.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

/* ── GATE B: the whole message, images included, leaves in one press ─────────── */

test.each(["conv-reclaimed", "conv-dead-structured"] as const)(
  "gate B — [%s] one press enqueues text AND image together and hands them to the recovering host",
  async (conversationId) => {
    quietWire();
    recordingSend();
    const { host, root } = await renderInto(<TmuxComposer file={conversationFile(conversationId)} deadHost />);
    try {
      typeInto(host, "Here is the screenshot I promised.");
      pasteImage(host, "screenshot");
      await untilPreviews(host, 1);

      const send = sendButton(host, "en");
      expect(send.disabled).toBe(false);
      expect(send.getAttribute("aria-disabled")).toBe("false");

      const form = host.querySelector("form")!;
      await act(async () => {
        form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
        await new Promise((r) => setTimeout(r, 0));
      });
      for (let attempt = 0; attempt < 200 && sentBodies.length === 0; attempt += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
      }

      /* ONE key carries both halves. Text is never split off from the image and
         delivered first. */
      expect(sentBodies).toHaveLength(1);
      const body = sentBodies[0]!;
      expect(body.text).toBe("Here is the screenshot I promised.");
      expect((body.images as unknown[]).length).toBe(1);

      /* And the queue holds one entry for that same message, counting its image. */
      const queued = readOutbox(conversationId).filter((entry) => entry.text === "Here is the screenshot I promised.");
      expect(queued).toHaveLength(1);
      expect(queued[0]!.images).toBe(1);
      expect(queued[0]!.id).toBe(String(body.idempotencyKey));
    } finally {
      await act(async () => root.unmount());
    }
  },
);

/* ── GATE D: the phone replaced Send with Respawn ───────────────────────────── */

/**
 * The phone's one control under the field takes a kind from `composerSlotKind`,
 * and `killed` used to win outright: a stopped conversation offered «Respawn»
 * even with a message already typed. That is the restore-first button the
 * operator must never have to press — the send in the field raises the host by
 * itself. Respawn keeps the empty-draft case, where there is nothing to send
 * and asking for an agent back is the only useful action.
 */
test("gate D — a typed draft on a stopped host keeps the phone's slot on Send", () => {
  const stopped = { killed: true, offline: false, working: false, hasDraft: false };
  expect(composerSlotKind({ ...stopped, hasDraft: true })).toBe("send");
  /* Nothing typed: Respawn is still the one useful action, and it gates nothing. */
  expect(composerSlotKind(stopped)).toBe("respawn");
  /* A runtime bus that is down cannot admit the send at all, so the honest kind
     there stays the queue — a stopped host does not change that. */
  expect(composerSlotKind({ ...stopped, hasDraft: true, offline: true })).toBe("queue");
});

/* ── The draft survives the reload that a dead host usually comes with ──────── */

test("a dead-host draft keeps its text AND its image across a reload", async () => {
  quietWire();
  recordingSend();
  const first = await renderInto(<TmuxComposer file={conversationFile("conv-reclaimed")} deadHost />);
  typeInto(first.host, "Look at this before you continue.");
  pasteImage(first.host, "before-reload");
  await untilPreviews(first.host, 1);
  /* Nothing was sent: this is the operator part-way through writing when the
     card is torn down and rebuilt. */
  expect(sentBodies).toHaveLength(0);
  await act(async () => first.root.unmount());

  const second = await renderInto(<TmuxComposer file={conversationFile("conv-reclaimed")} deadHost />);
  try {
    await untilPreviews(second.host, 1);
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value)
      .toBe("Look at this before you continue.");
    /* And it is still sendable in one press — the reload did not reintroduce a
       restore step in front of it. */
    const send = sendButton(second.host, "en");
    expect(send.disabled).toBe(false);
  } finally {
    await act(async () => second.root.unmount());
  }
});

/* ── An unknown send outcome is LOOKED UP, never sent again ─────────────────── */

/**
 * The dead-host route is newly open to the composer, and it inherits the
 * recovery every send has: the one for an attempt whose response never came
 * back. That recovery used to re-POST the send under the original key, which
 * is the duplicate the contract forbids — under a key the server already
 * admitted, the second POST is a second request against a message already on
 * its way to the agent.
 *
 * So it is a lookup now, and these cases hold the send count at ONE across
 * every branch of it: the message was admitted, the message was proven never
 * sent, and nothing could be read at all. Each asserts what the operator is
 * left holding afterwards, because "no duplicate" is only half the contract —
 * the other half is that no byte of the message is lost paying for it.
 */
/** A card of its own for each case: the recovery control is found by selector,
    and a row another message left behind would answer for this one. */
function lostResponseConversation(tag: string): string {
  const conversationId = `conv-lost-${tag}`;
  VIEWS[conversationId] = reclaimedView(conversationId);
  return conversationId;
}

function lostResponseSend(): void {
  setComposerAdmissionTimingForTests({
    admissionDeadlineMs: 8,
    receiptReconciliationMs: 40,
    receiptPollIntervalMs: 5,
  });
}

/** Drives the composer to a dead-host send whose response is lost, then hands
    back the recovery control that stands for its unknown fate. */
async function untilUnknownOutcome(host: HTMLElement): Promise<HTMLButtonElement> {
  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let attempt = 0; attempt < 300 && !host.querySelector("[data-receipt-uncertain-retry]"); attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 3)); });
  }
  const control = host.querySelector("[data-receipt-uncertain-retry]") as HTMLButtonElement;
  expect(control).toBeTruthy();
  return control;
}

/** A send that reaches the wire and never answers, plus a lookup whose reply
    this test chooses. Both are counted. */
function lostResponseRuntime(lookup: () => RuntimeAdmissionLookup): { lookups: string[] } {
  const lookups: string[] = [];
  setTmuxComposerRuntimeDependenciesForTests({
    useAgentCapabilities: (file) => agentCapabilitiesFromViews(
      file,
      file.conversationId ? VIEWS[file.conversationId] ?? null : null,
      null,
      true,
    ),
    refreshRuntime: async () => true,
    sendRuntimeMessage: (async (body: Record<string, unknown>) => {
      sentBodies.push(body);
      /* The request left; the answer never arrived. */
      throw new ComposerAdmissionTimeoutError();
    }) as never,
    lookupRuntimeAdmission: (async (_conversationId: string, clientMessageId: string) => {
      lookups.push(clientMessageId);
      return lookup();
    }) as never,
  });
  return { lookups };
}

test("an unknown dead-host outcome that WAS admitted is adopted by lookup, with no second send", async () => {
  quietWire();
  lostResponseSend();
  const { lookups } = lostResponseRuntime(() => ({
    outcome: "admitted",
    operationId: "op-already-admitted",
  }));
  const conversationId = lostResponseConversation("admitted");
  const { host, root } = await renderInto(<TmuxComposer file={conversationFile(conversationId)} deadHost />);
  try {
    typeInto(host, "Carry on from the screenshot.");
    pasteImage(host, "admitted");
    await untilPreviews(host, 1);

    const recover = await untilUnknownOutcome(host);
    expect(sentBodies).toHaveLength(1);

    await act(async () => {
      recover.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    for (let attempt = 0; attempt < 200 && lookups.length === 0; attempt += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 3)); });
    }

    /* The recovery asked, under the key the attempt was stamped with. */
    expect(lookups).toEqual([String(sentBodies[0]!.idempotencyKey)]);
    /* And it sent nothing: the count is the ONE original attempt, still. */
    expect(sentBodies).toHaveLength(1);

    /* The admitted operation is now on the entry, so the message is followed
       rather than offered for resending again. */
    const entry = readOutbox(conversationId).find((row) => row.id === String(sentBodies[0]!.idempotencyKey))!;
    expect(entry.operationId).toBe("op-already-admitted");
    expect(entry.deliveryUncertain).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
  }
});

test("an unknown dead-host outcome proven NOT executed keeps every byte and sends nothing by itself", async () => {
  quietWire();
  lostResponseSend();
  const { lookups } = lostResponseRuntime(() => ({ outcome: "not-executed" }));
  const conversationId = lostResponseConversation("not-executed");
  const { host, root } = await renderInto(<TmuxComposer file={conversationFile(conversationId)} deadHost />);
  try {
    typeInto(host, "Nothing of this reached the journal.");
    pasteImage(host, "not-executed");
    await untilPreviews(host, 1);

    const recover = await untilUnknownOutcome(host);
    await act(async () => {
      recover.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    for (let attempt = 0; attempt < 200 && lookups.length === 0; attempt += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 3)); });
    }

    expect(lookups).toHaveLength(1);
    /* Affirmative non-execution AUTHORIZES a later attempt; it does not make
       one. The operator presses Retry, and nothing is sent behind their back. */
    expect(sentBodies).toHaveLength(1);

    const key = String(sentBodies[0]!.idempotencyKey);
    /* The proof is recorded against the retained payload before the entry
       settles, so the wait watches the uncertainty clearing, not the call. */
    for (let attempt = 0; attempt < 200
      && readOutbox(conversationId).find((row) => row.id === key)?.deliveryUncertain; attempt += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 3)); });
    }
    const entry = readOutbox(conversationId).find((row) => row.id === key)!;
    expect(entry.state).toBe("failed");
    expect(entry.deliveryUncertain).toBeUndefined();
    /* The message itself is intact — the same key, the same text, its image. */
    expect(entry.text).toBe("Nothing of this reached the journal.");
    expect(entry.images).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a lookup that cannot answer leaves the unknown outcome unknown, and still sends nothing", async () => {
  quietWire();
  lostResponseSend();
  const { lookups } = lostResponseRuntime(() => ({ outcome: "unknown" }));
  const conversationId = lostResponseConversation("unknown");
  const { host, root } = await renderInto(<TmuxComposer file={conversationFile(conversationId)} deadHost />);
  try {
    typeInto(host, "The registry could not be read.");
    const recover = await untilUnknownOutcome(host);
    const key = String(sentBodies[0]!.idempotencyKey);

    await act(async () => {
      recover.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    for (let attempt = 0; attempt < 200 && lookups.length === 0; attempt += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 3)); });
    }

    expect(lookups).toHaveLength(1);
    expect(sentBodies).toHaveLength(1);
    /* Absence that was never observed is not evidence: the entry keeps its
       uncertainty rather than being converted into a failure or a success. */
    const entry = readOutbox(conversationId).find((row) => row.id === key)!;
    expect(entry.deliveryUncertain).toBe(true);
    expect(entry.operationId).toBeUndefined();
    expect(entry.text).toBe("The registry could not be read.");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a reload before the lookup keeps ONE send, and the lookup still runs under the original key", async () => {
  quietWire();
  lostResponseSend();
  const { lookups } = lostResponseRuntime(() => ({ outcome: "admitted", operationId: "op-after-reload" }));
  const conversationId = lostResponseConversation("reload");
  const first = await renderInto(<TmuxComposer file={conversationFile(conversationId)} deadHost />);
  typeInto(first.host, "Lost the answer, then reloaded.");
  await untilUnknownOutcome(first.host);
  const key = String(sentBodies[0]!.idempotencyKey);
  await act(async () => first.root.unmount());

  const second = await renderInto(<TmuxComposer file={conversationFile(conversationId)} deadHost />);
  try {
    /* A remount must not re-dispatch the attempt whose fate is unknown. */
    expect(sentBodies).toHaveLength(1);
    for (let attempt = 0; attempt < 300 && !second.host.querySelector("[data-receipt-uncertain-retry]"); attempt += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 3)); });
    }
    const recover = second.host.querySelector("[data-receipt-uncertain-retry]") as HTMLButtonElement;
    expect(recover).toBeTruthy();
    await act(async () => {
      recover.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    for (let attempt = 0; attempt < 200 && lookups.length === 0; attempt += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 3)); });
    }

    expect(lookups).toEqual([key]);
    expect(sentBodies).toHaveLength(1);
  } finally {
    await act(async () => second.root.unmount());
  }
});
