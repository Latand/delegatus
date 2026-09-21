/**
 * ONE message is ONE row, in the mounted feed (send-latency slice 3).
 *
 * The operator's complaint was that a message they pressed Send on once passed
 * through a pile of visually different renderings and felt slow. The largest
 * single cause was structural: the browser drew the message twice, with two
 * components, in two different lists — the outbox painted an optimistic bubble
 * at the tail, and when the transcript's own record of the same message
 * arrived a DIFFERENT node replaced it somewhere else. Anything the reader had
 * done to the first node — opened a long message, put focus on it — went with
 * it, and for an instant there could be two copies or none.
 *
 * So these assertions are about SAMENESS through the whole life of a send,
 * read off the real `LogFeed` with the real outbox store and the real
 * transcript parser:
 *
 *   - the same DOM node for the row and for the bubble inside it, from submit
 *     through every receipt and through the transcript's arrival;
 *   - the reader's own state on that node — an expanded long message — still
 *     there afterwards;
 *   - exactly one copy of the message at every instant, never two, never none;
 *   - and the row exists in the FIRST frame after Send even when the
 *     submission has durable preparation to do, which is the case that used to
 *     wait for a retain, a seal and a wire claim before painting anything.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { useRuntimeReceiptsForArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";
import { attachModeFor, capabilitiesFor } from "./agentCapabilities";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";
import { useAgentCapabilities } from "./useAgentCapabilities";

const dom = new Window();
installActEnv();
class ImmediateFileReader {
  result: string | null = null;
  error: null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  readAsDataURL(file: File): void {
    const mime = file.type || "image/png";
    this.result = `data:${mime};base64,${Buffer.from(file.name).toString("base64")}`;
    queueMicrotask(() => this.onload?.());
  }
}
Object.assign(globalThis, {
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
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
  FileReader: ImmediateFileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const CARD = "conversation_one_message_one_row";
const PATH = "/codex-one-message-one-row.jsonl";

const structuredView: RuntimeSessionView = {
  session: {
    conversationId: CARD,
    hostKind: "codex-app-server",
    host: "hosted",
    turn: "idle",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: true, perTurnModel: false } },
    recentReceipts: [],
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

import { LogFeed } from "./LogFeed";
import { setLogFeedDependenciesForTests } from "./logFeedDependencies";
import { TmuxComposer } from "./TmuxComposer";
import {
  enqueueOutbox, outboxReceiptPatch, readOutbox, resetOutboxForTests, updateOutbox,
} from "./conversation/outbox";
import { resetRenderedMessageRowsForTests } from "./conversation/renderedRows";
import { resetMessageRowRecoveryForTests } from "./conversation/rowRecovery";
import type { RuntimeReceipt } from "./runtime/runtimeModel";

const file = {
  path: PATH,
  root: "codex-sessions",
  name: "one-message-one-row.jsonl",
  project: "viewer",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  proc: "running",
  pid: 4242,
  conversationId: CARD,
  generation: 1,
  activity: "live",
  mtime: 1,
} as unknown as FileEntry;

/* Long enough that the bubble folds it away, so the reader has something to
   open — the state that used to be destroyed when the node was replaced. */
const TEXT = `${"Check what is blocking the release and tell me which lane owns it. ".repeat(9)}`;

const codexUserLine = (timestamp: string, message: string) => JSON.stringify({
  type: "event_msg", timestamp, payload: { type: "user_message", message },
});

const codexAgentLine = (timestamp: string, message: string) => JSON.stringify({
  type: "event_msg", timestamp, payload: { type: "agent_message", message },
});

/* The production shape of a structured send's own record: the Codex host
   stamps the delivery's identity onto the canonical structured-user record,
   and `/api/log/provenance` resolves that token to the client message id the
   delivery was admitted under. Two halves of one join; a record that carries
   only one of them is bound by neither. */
const DEDUP_TOKEN = "9f".repeat(32);
const TWIN_FIRST_DEDUP = "a1".repeat(32);
const TWIN_SECOND_DEDUP = "b2".repeat(32);
const codexStructuredUserLine = (timestamp: string, message: string, dedup = DEDUP_TOKEN) => JSON.stringify({
  type: "event_msg", timestamp,
  payload: { type: "user_message", message: `<!-- llv:structured-user dedup=${dedup} -->\n${message}` },
});

/** The provenance endpoint, answering the one join this window needs. */
const serveProvenance = (submissions: Record<string, string>) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/log/provenance")) {
      return Response.json({ messages: {}, occurrences: [], submissions });
    }
    if (String(input) === "/api/tmux/targets") return Response.json({ targets: {} });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
};

const realFetch = globalThis.fetch;
const composerStorage = installComposerStorageForTests();
afterAll(() => composerStorage.uninstall());

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  setLogFeedDependenciesForTests({
    useLogTail: () => ({
      lines, linesStart: 0, size: lines.length, loading: false, error: null, tickTime: null,
      paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false,
      loadOlder: async () => 0, prependGen: 0,
    }),
  });
  setRuntimeUiEnabledForTests(false);
  setTmuxComposerRuntimeDependenciesForTests({
    useAgentCapabilities: (candidate) => {
      const real = useAgentCapabilities(candidate);
      if (candidate.conversationId !== CARD) return real;
      const options = { runtimeEnabled: true };
      return {
        caps: capabilitiesFor(candidate, structuredView, options),
        runtime: structuredView,
        structuredSession: structuredView,
        runtimeEnabled: true,
        attachMode: attachModeFor(candidate, structuredView, options),
      };
    },
    useRuntimeReceiptsForArtifact: (path, conversationId) => useRuntimeReceiptsForArtifact(path, conversationId),
  });
});

afterEach(() => {
  composerStorage.reset();
  setLogFeedDependenciesForTests(null);
  setTmuxComposerRuntimeDependenciesForTests(null);
  setRuntimeUiEnabledForTests(null);
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
  resetRenderedMessageRowsForTests();
  resetMessageRowRecoveryForTests();
});

const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  });
};

const surface = () => (
  <>
    <LogFeed file={file} showSvc={false} lineFilter="" onStatus={() => {}} paused={false} follow={false} setFollow={() => {}} />
    <TmuxComposer file={file} />
  </>
);

/** Everything about the message a reader could see change. */
function reading(host: HTMLElement) {
  const rows = [...host.querySelectorAll("[data-message-row]")] as HTMLElement[];
  const row = rows[0] ?? null;
  const bubble = host.querySelector("[data-user-bubble]") as HTMLElement | null;
  const wrapper = row?.closest("[data-feed-kind]") as HTMLElement | null;
  return {
    row,
    bubble,
    wrapper,
    rows: rows.length,
    bubbles: host.querySelectorAll("[data-user-bubble]").length,
    phase: row?.getAttribute("data-message-row") ?? null,
    bubbleClass: bubble?.className ?? null,
    /* Where the row sits among the conversation's OWN rows: its
       conversational position, which is what a reader perceives. Counting raw
       siblings would move it whenever an unrelated marker appears beside the
       list (a «start of conversation» line, a header). */
    position: wrapper ? [...host.querySelectorAll("[data-feed-kind]")].indexOf(wrapper) : -1,
    /* The reader's own state on the node: an opened long message. */
    expanded: Boolean(row?.querySelector("details[open]")),
    progress: host.querySelectorAll("[data-outbox-progress]").length,
    copy: [...host.querySelectorAll("button")]
      .filter((button) => button.getAttribute("aria-label") === translate("en", "feed.copyMd")).length,
  };
}

test("the transcript's own record is adopted into the row the operator already has", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const submittedAt = Date.now();
  enqueueOutbox(CARD, { id: "key-one-row", text: TEXT, images: 0, at: submittedAt });
  await settle(() => root.render(surface()));

  const first = reading(host);
  expect(first.rows).toBe(1);
  expect(first.bubbles).toBe(1);
  expect(first.phase).toBe("pending");
  expect(first.progress).toBe(1);
  /* The reader opens the long message. This is the state the old replacement
     threw away, so it is the state the whole claim is measured against. */
  const disclosure = first.row!.querySelector("details") as HTMLDetailsElement;
  await settle(() => { disclosure.open = true; });
  expect(reading(host).expanded).toBe(true);

  /* Every receipt an ordinary send passes through, projected by the production
     rule into the production store. */
  const readings = [reading(host)];
  for (const status of ["pending", "queued", "delivering", "applying", "delivered"] as const) {
    const entry = readOutbox(CARD).find((candidate) => candidate.id === "key-one-row")!;
    const patch = outboxReceiptPatch(entry, status, {
      operationId: "operation-one-row", idempotencyKey: "key-one-row", conversationId: CARD,
      kind: "send", status, at: new Date(submittedAt + 1_000).toISOString(),
      admittedAt: new Date(submittedAt).toISOString(), revision: readings.length + 1,
    } as RuntimeReceipt, submittedAt + 2_000);
    if (patch) await settle(() => updateOutbox(CARD, "key-one-row", patch));
    readings.push(reading(host));
  }

  /* And then the transcript's own record of the same message lands. */
  await settle(() => { lines = [codexUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT)]; });
  await settle(() => root.render(surface()));
  const adopted = reading(host);
  readings.push(adopted);

  for (const step of readings) {
    /* One message, one row, one copy — at every single instant. */
    expect(step.rows).toBe(1);
    expect(step.bubbles).toBe(1);
    /* The SAME nodes: React never replaced the row or the body inside it. */
    expect(step.row).toBe(first.row);
    expect(step.bubble).toBe(first.bubble);
    expect(step.wrapper).toBe(first.wrapper);
    /* The same bubble: width cap, opacity, padding and type size live in
       these classes, and none of them moved. */
    expect(step.bubbleClass).toBe(first.bubbleClass);
    expect(step.position).toBe(first.position);
  }
  /* What the reader had opened is still open after the transcript arrived. */
  expect(adopted.expanded).toBe(true);
  /* The only visible difference across the whole walk: the progress
     affordance clears and the copy control takes the same slot. */
  expect(adopted.progress).toBe(0);
  expect(adopted.copy).toBe(1);
  expect(adopted.phase).toBe("confirmed");
  await act(async () => root.unmount());
  host.remove();
});

test("an attachment-bearing submission paints its final row before its payload is durable", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await settle(() => root.render(surface()));

  /* Hold the durable preparation open. Until this resolves the submission has
     retained nothing, sealed nothing and claimed no wire — which is exactly
     the window in which the operator used to be shown nothing at all. */
  let releasePreparation = () => {};
  const blocked = new Promise<void>((resolve) => { releasePreparation = () => resolve(); });
  const sends: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/tmux/targets") return Response.json({ targets: {} });
    if (String(input) === "/api/runtime/send") {
      sends.push(JSON.parse(String(init?.body)));
      return Response.json({ receipt: null }, { status: 202 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, {
    onChange(event: unknown): void;
    onPaste(event: unknown): void;
  }>)[propsKey]!;
  await settle(() => props.onChange({ target: { value: TEXT } }));
  await settle(() => props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File(["tile"], "tile.png", { type: "image/png" }) }] },
    preventDefault() {},
  }));
  await settle(() => {});

  /* The payload store is made slow on purpose, so the row has to exist before
     it answers rather than because it answered. */
  const payloads = await import("@/lib/composerSubmissionPayloads");
  const realRetain = payloads.composerSubmissionPayloads.retain.bind(payloads.composerSubmissionPayloads);
  (payloads.composerSubmissionPayloads as unknown as { retain: typeof realRetain }).retain = (async (...args: Parameters<typeof realRetain>) => {
    await blocked;
    return realRetain(...args);
  }) as typeof realRetain;
  try {
    await settle(() => host.querySelector("form")!.dispatchEvent(
      new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    ));

    /* The first frame after Send already holds the whole message: its final
       bubble, its attachment line, its quiet progress affordance — and it is
       held back from the wire until its envelope is durable. */
    const preparing = reading(host);
    expect(preparing.rows).toBe(1);
    expect(preparing.bubbles).toBe(1);
    expect(preparing.phase).toBe("pending");
    expect(preparing.progress).toBe(1);
    expect(readOutbox(CARD)[0]).toMatchObject({ text: TEXT, images: 1, preparing: true });
    expect(preparing.row!.textContent).toContain("1 image");
    expect(sends).toHaveLength(0);

    await settle(() => releasePreparation());
    await settle(() => {});
    const durable = reading(host);
    /* The same row, in the same place, with the same rendering: nothing about
       the message moved when its payload became durable. */
    expect(durable.row).toBe(preparing.row);
    expect(durable.bubble).toBe(preparing.bubble);
    expect(durable.bubbleClass).toBe(preparing.bubbleClass);
    expect(durable.position).toBe(preparing.position);
    expect(durable.rows).toBe(1);
    expect(readOutbox(CARD)[0]?.preparing).toBeUndefined();
    /* And only now does the message reach the wire, exactly once. */
    expect(sends).toHaveLength(1);
  } finally {
    (payloads.composerSubmissionPayloads as unknown as { retain: typeof realRetain }).retain = realRetain;
    releasePreparation();
    await act(async () => root.unmount());
    host.remove();
  }
});

test("every submission path paints the same final-form row", async () => {
  /* Slice 3 item 6. The Send button, the Enter key, a quick reply and a
     completed dictation are four ways into ONE function — `queueSubmit` —
     and the row must not be able to tell them apart. Dictation reaches it
     through `submit(overrideText)`, which is the same entry point the quick
     reply below uses (`performVoiceSend` calling `submit(combined)` is pinned
     in `src/hooks/composerVoiceSend.test.ts`), so exercising the override
     path here covers both. */
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  let admitted = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/tmux/targets") return Response.json({ targets: {} });
    /* Admitted and parked behind the agent's turn: the rows stay observable in
       their submitted form and the composer is free to take the next one. */
    if (String(input) === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body)) as { idempotencyKey: string };
      admitted += 1;
      const receipt = {
        operationId: `operation-path-${admitted}`, idempotencyKey: body.idempotencyKey,
        conversationId: CARD, kind: "send", status: "queued",
        at: new Date().toISOString(), admittedAt: new Date().toISOString(), revision: 1,
      };
      return Response.json({ operationId: receipt.operationId, receipt }, { status: 202 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  await settle(() => root.render(surface()));

  /* React replaces the props object on every render, so it is read fresh for
     each interaction rather than captured once. */
  const fieldProps = () => {
    const textarea = host.querySelector("textarea")!;
    const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
    return (textarea as unknown as Record<string, {
      onChange(event: unknown): void;
      onKeyDown(event: unknown): void;
    }>)[propsKey]!;
  };

  const renderings: string[] = [];
  const describeNewest = () => {
    const rows = [...host.querySelectorAll("[data-message-row]")] as HTMLElement[];
    const row = rows[rows.length - 1]!;
    const bubble = row.querySelector("[data-user-bubble]") as HTMLElement;
    return JSON.stringify({
      phase: row.getAttribute("data-message-row"),
      bubble: bubble.className,
      controls: [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-expanded")),
      hasProgress: Boolean(row.querySelector("[data-outbox-progress]")),
    });
  };

  /* The quick reply first, while nothing is in flight: it is the
     override-text submission, taken through the real send menu the operator
     uses, and the path a completed dictation shares. */
  const send = host.querySelector('button[type="submit"]') as HTMLButtonElement;
  await settle(() => send.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true }) as unknown as Event));
  const quickAck = [...host.ownerDocument.querySelectorAll('[role="menuitem"]')]
    .find((item) => (item.textContent ?? "").includes(translate("en", "composer.quickAckLabel"))) as HTMLButtonElement | undefined;
  expect(quickAck).toBeDefined();
  await settle(() => quickAck!.click());
  renderings.push(describeNewest());

  await settle(() => fieldProps().onChange({ target: { value: "sent with the button" } }));
  await settle(() => host.querySelector("form")!.dispatchEvent(
    new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
  ));
  renderings.push(describeNewest());

  await settle(() => fieldProps().onChange({ target: { value: "sent with the keyboard" } }));
  await settle(() => fieldProps().onKeyDown({
    key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
    nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {},
  }));
  renderings.push(describeNewest());

  /* Three submissions, three rows, one rendering. */
  expect(readOutbox(CARD)).toHaveLength(3);
  expect(host.querySelectorAll("[data-message-row]")).toHaveLength(3);
  expect(new Set(renderings).size).toBe(1);
  await act(async () => root.unmount());
  host.remove();
});

/** The same reading, for every message row the window is painting. */
function messageRows(host: HTMLElement) {
  return ([...host.querySelectorAll("[data-message-row]")] as HTMLElement[]).map((row) => {
    const wrapper = row.closest("[data-feed-kind]") as HTMLElement | null;
    return {
      row,
      wrapper,
      bubble: row.querySelector("[data-user-bubble]") as HTMLElement | null,
      bubbleClass: (row.querySelector("[data-user-bubble]") as HTMLElement | null)?.className ?? null,
      phase: row.getAttribute("data-message-row"),
      text: (row.querySelector("[data-user-bubble]") as HTMLElement | null)?.textContent ?? "",
      progress: row.querySelectorAll("[data-outbox-progress]").length,
      position: wrapper ? [...host.querySelectorAll("[data-feed-kind]")].indexOf(wrapper) : -1,
    };
  });
}

test("a lost acknowledgement keeps its one row, and the transcript's record lands in it", async () => {
  /* Round-4 P1. The submission whose acknowledgement never came back was
     excluded from echo binding, so when the transcript's own record of the
     SAME message arrived the feed had no way to recognise it: it mounted the
     canonical row beside the one the operator already had and the message was
     on screen twice — one copy with a copy control, one still spinning.

     The record is authoritative arrival evidence and it belongs to the row
     that is already there. Nothing about identity is relaxed to accept it: it
     is claimed by the submission's own watermark, under the submission's own
     key, which is the same rule every other message is bound by. */
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const submittedAt = Date.now();
  /* The server DID admit this send; only the answer to the browser was lost.
     So the registry can name the submission behind the record's identity,
     and it can do so from the moment of admission — which is why the window
     asks for the join while it waits, not once the record has landed. */
  serveProvenance({ [DEDUP_TOKEN]: "key-lost-ack" });
  enqueueOutbox(CARD, { id: "key-lost-ack", text: TEXT, images: 0, at: submittedAt });
  /* Exactly what the composer writes when its request dies on the wire: the
     local row is `failed`, and the unknown flag says nobody established what
     happened to it. */
  updateOutbox(CARD, "key-lost-ack", {
    state: "failed", deliveryUncertain: true, dispatchedAt: submittedAt + 10,
    error: "lost response",
  });
  await settle(() => root.render(surface()));

  const unknown = reading(host);
  expect(unknown.rows).toBe(1);
  expect(unknown.bubbles).toBe(1);
  /* Never "not delivered": unknown is neither delivered nor lost. */
  expect(unknown.phase).toBe("pending");
  expect(unknown.progress).toBe(1);
  /* And the row offers the lookup under its original key and nothing else —
     no second attempt of a message that may already be in the engine, and no
     decision about a fate nobody has established (round-4 P2). */
  await settle(() => (host.querySelector("[data-outbox-progress]") as HTMLElement).click());
  expect(host.querySelector("[data-outbox-detail] [data-outbox-check]")).not.toBeNull();
  expect(host.querySelector("[data-receipt-uncertain-retry], [data-receipt-discard], [data-outbox-operation-retry], [data-outbox-discard], [data-outbox-retry], [data-outbox-clear]")).toBeNull();
  const opened = reading(host);
  const disclosure = opened.row!.querySelector("details") as HTMLDetailsElement;
  await settle(() => { disclosure.open = true; });
  expect(reading(host).expanded).toBe(true);

  /* The transcript carries the message. That is the engine's own record of
     it — the thing the lost acknowledgement failed to tell us. */
  await settle(() => { lines = [codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT)]; });
  await settle(() => root.render(surface()));

  const adopted = reading(host);
  /* ONE bubble, not two, and the very node the operator already had. */
  expect(adopted.rows).toBe(1);
  expect(adopted.bubbles).toBe(1);
  expect(adopted.row).toBe(unknown.row);
  expect(adopted.bubble).toBe(unknown.bubble);
  expect(adopted.wrapper).toBe(unknown.wrapper);
  expect(adopted.bubbleClass).toBe(unknown.bubbleClass);
  expect(adopted.position).toBe(unknown.position);
  expect(adopted.expanded).toBe(true);
  /* It reads as arrived, because it arrived. */
  expect(adopted.phase).toBe("confirmed");
  expect(adopted.progress).toBe(0);
  expect(adopted.copy).toBe(1);
  /* The submission itself is not thrown away by being answered for: its
     payload and its original key are still the queue's record of it. */
  expect(readOutbox(CARD).find((entry) => entry.id === "key-lost-ack"))
    .toMatchObject({ text: TEXT, deliveryUncertain: true });
  await act(async () => root.unmount());
  host.remove();
});

test("two identical submissions, one of them unacknowledged, keep two rows and two records", async () => {
  /* The other half of round-4 P1, under round-2's rule. Identical text must
     never merge two submissions, and an unknown outcome must not change that
     — but text is not what tells them apart any more. Each record carries the
     identity of the delivery that wrote it, so the first record answers for
     the first send and the second for the second even when they arrive out of
     order, and both rows keep the node they were painted on. */
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const submittedAt = Date.now();
  serveProvenance({ [TWIN_FIRST_DEDUP]: "key-twin-first", [TWIN_SECOND_DEDUP]: "key-twin-second" });
  enqueueOutbox(CARD, { id: "key-twin-first", text: TEXT, images: 0, at: submittedAt });
  updateOutbox(CARD, "key-twin-first", { state: "failed", deliveryUncertain: true, error: "lost response" });
  enqueueOutbox(CARD, { id: "key-twin-second", text: TEXT, images: 0, at: submittedAt + 1_000 });
  updateOutbox(CARD, "key-twin-second", { state: "delivering" });
  await settle(() => root.render(surface()));

  const before = messageRows(host);
  expect(before).toHaveLength(2);
  expect(before.map((entry) => entry.phase)).toEqual(["pending", "pending"]);

  /* The SECOND submission's record arrives first — the out-of-order case. It
     names its own send, so the unacknowledged first one neither settles on it
     nor consumes it. */
  await settle(() => {
    lines = [codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT, TWIN_SECOND_DEDUP)];
  });
  await settle(() => root.render(surface()));
  const half = messageRows(host);
  expect(half).toHaveLength(2);
  /* Both rows are the nodes they were painted on. The one that arrived moved
     into the transcript's own order — that is where its record is — and the
     one still waiting stays in the tail below it. */
  const halfFirst = half.find((entry) => entry.row === before[0]!.row);
  const halfSecond = half.find((entry) => entry.row === before[1]!.row);
  expect(halfFirst).toBeDefined();
  expect(halfSecond).toBeDefined();
  expect(halfFirst!.phase).toBe("pending");
  expect(halfSecond!.phase).toBe("confirmed");
  expect(halfFirst!.bubble).toBe(before[0]!.bubble);
  expect(halfSecond!.bubble).toBe(before[1]!.bubble);
  expect(halfFirst!.bubbleClass).toBe(before[0]!.bubbleClass);
  expect(halfSecond!.bubbleClass).toBe(before[1]!.bubbleClass);

  /* And then the first submission's own record. */
  await settle(() => {
    lines = [
      codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT, TWIN_SECOND_DEDUP),
      /* The agent answered in between, which is what a repeated identical
         send actually looks like in a transcript. */
      codexAgentLine(new Date(submittedAt + 3_500).toISOString(), "Looking now."),
      codexStructuredUserLine(new Date(submittedAt + 4_000).toISOString(), TEXT, TWIN_FIRST_DEDUP),
    ];
  });
  await settle(() => root.render(surface()));
  const both = messageRows(host);
  expect(both).toHaveLength(2);
  expect(both.map((entry) => entry.phase)).toEqual(["confirmed", "confirmed"]);
  const bothFirst = both.find((entry) => entry.row === before[0]!.row);
  const bothSecond = both.find((entry) => entry.row === before[1]!.row);
  expect(bothFirst).toBeDefined();
  expect(bothSecond).toBeDefined();
  expect(bothFirst!.bubble).toBe(before[0]!.bubble);
  expect(bothSecond!.bubble).toBe(before[1]!.bubble);
  /* Each record kept its own submission: the one whose acknowledgement was
     lost sits at ITS record, after the agent's answer, and the other at its
     own — never merged, never swapped. */
  expect(bothSecond!.position).toBeLessThan(bothFirst!.position);
  /* Two messages, two bubbles — never one merged into the other. */
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(2);
  await act(async () => root.unmount());
  host.remove();
});

test("an unrelated arrival of the same words never settles an unacknowledged row", async () => {
  /* Round-2 P1, in the mounted window. A record that names no submission of
     this browser's — somebody else's send of the same words — used to flip
     the row to confirmed and take its lookup away, while the entry was still
     marked uncertain. It is somebody else's message: it gets its own row, and
     the operator's own row keeps waiting with the one control it has. */
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const submittedAt = Date.now();
  serveProvenance({});
  enqueueOutbox(CARD, { id: "key-lost-ack", text: TEXT, images: 0, at: submittedAt });
  updateOutbox(CARD, "key-lost-ack", { state: "failed", deliveryUncertain: true, error: "lost response" });
  await settle(() => root.render(surface()));
  const unknown = reading(host);
  expect(unknown.phase).toBe("pending");

  await settle(() => { lines = [codexUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT)]; });
  await settle(() => root.render(surface()));

  const after = reading(host);
  /* Still pending, still the same node, and still the one row the operator's
     own queue owns. */
  expect(after.rows).toBe(1);
  expect(after.phase).toBe("pending");
  expect(after.row).toBe(unknown.row);
  expect(after.row!.querySelector("[data-user-bubble]")).toBe(unknown.bubble);
  expect(after.progress).toBe(1);
  /* The arrival is a second message, so the conversation shows two — what it
     must never do is make one of them answer for the other. */
  expect(after.bubbles).toBe(2);
  expect(readOutbox(CARD)[0]).toMatchObject({ deliveryUncertain: true });
  await act(async () => root.unmount());
  host.remove();
});
