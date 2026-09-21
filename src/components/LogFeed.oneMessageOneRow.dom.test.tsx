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
  MutationObserver: dom.MutationObserver,
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
import { resetMessageProvenanceCacheForTests } from "./feed/messageProvenance";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";

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
  resetMessageProvenanceCacheForTests();
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

  /* And then the transcript's own record of the same message lands, in the
     shape the structured host writes it: marked with the operation the
     receipts above named. The row is admitted, so that name — never its
     words — is what hands the record to it (#1950 round 3). */
  await settle(() => {
    lines = [codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT, deliveryDedupToken("operation-one-row"))];
  });
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

/* ── The join is in hand before the record is (#1950 round 2, second round) ──
   An independent review held ONLY `/api/log/provenance` open and published the
   production-shaped record: the document and the lost acknowledgement each
   painted two bubbles, and the image-only row was pushed down by its own
   picture. Releasing the response repaired the view — so the invariant rested
   on a response winning a race. These cases hold the response open and
   require the invariant anyway. */

/** The provenance endpoint, held open until the test answers it. Every request
    waits; `answer` resolves the waiting ones and every later one. */
const holdProvenance = () => {
  const waiting: ((response: Response) => void)[] = [];
  let answer: { messages: Record<string, unknown>; submissions: Record<string, string> } | null = null;
  let asked = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/log/provenance")) {
      asked += 1;
      if (answer) return Response.json({ ...answer, occurrences: [] });
      return new Promise<Response>((resolve) => waiting.push(resolve));
    }
    if (url === "/api/tmux/targets") return Response.json({ targets: {} });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return {
    asked: () => asked,
    answer(next: { messages?: Record<string, unknown>; submissions?: Record<string, string> }) {
      answer = { messages: next.messages ?? {}, submissions: next.submissions ?? {} };
      for (const resolve of waiting.splice(0)) resolve(Response.json({ ...answer, occurrences: [] }));
    },
  };
};

/** Every committed state of the host between two readings: how many copies
    of the message it showed, and whether the original row was ever gone. */
const watchMutations = (host: HTMLElement, original: () => Element | null) => {
  const seen: { bubbles: number; attached: boolean }[] = [];
  const observer = new MutationObserver(() => {
    const row = original();
    seen.push({ bubbles: host.querySelectorAll("[data-user-bubble]").length, attached: Boolean(row && host.contains(row)) });
  });
  observer.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
};

/** The feed alone. These cases pre-arrange the queue as the delivery path
    left it; a mounted composer would start dispatching it. */
const feedOnly = (target: FileEntry = file) => (
  <LogFeed file={target} showSvc={false} lineFilter="" onStatus={() => {}} paused={false} follow={false} setFollow={() => {}} />
);

/** A receipt the delivery path projects onto the row, as the production rule
    projects it — the moment the browser learns the operation's id. */
const projectReceipt = async (id: string, operationId: string, status: "queued" | "delivered", at: number) => {
  const entry = readOutbox(CARD).find((candidate) => candidate.id === id)!;
  const patch = outboxReceiptPatch(entry, status, {
    operationId, idempotencyKey: id, conversationId: CARD, kind: "send", status,
    at: new Date(at).toISOString(), admittedAt: new Date(at - 1_000).toISOString(), revision: status === "queued" ? 1 : 2,
  } as RuntimeReceipt, at);
  if (patch) await settle(() => updateOutbox(CARD, id, patch));
};

test("a document's record lands in its row while the provenance read is still open", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const provenance = holdProvenance();
  const submittedAt = Date.now();
  const words = "Summarise the release notes and flag anything that blocks the rollout.";
  enqueueOutbox(CARD, { id: "key-document", text: words, images: 0, files: 1, at: submittedAt });
  updateOutbox(CARD, "key-document", { state: "delivering" });
  await settle(() => root.render(feedOnly()));
  /* Admitted: the browser now holds the operation id, and so the token the
     record will carry. The registry's answer never comes. */
  await projectReceipt("key-document", "operation-document", "queued", submittedAt + 500);
  await projectReceipt("key-document", "operation-document", "delivered", submittedAt + 1_000);
  const before = reading(host);
  expect(before.rows).toBe(1);
  expect(before.bubbles).toBe(1);

  const watch = watchMutations(host, () => before.row);
  /* The production payload: the operator's words and the inbox path the
     route folded in — a text the row does not share. */
  await settle(() => {
    lines = [codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(),
      `${words}\n/var/tmp/llv-evidence-home/.claude/viewer-inbox/files/4d2a1f7c9b03/release-notes.pdf`,
      deliveryDedupToken("operation-document"))];
  });
  await settle(() => root.render(feedOnly()));
  watch.stop();

  const after = reading(host);
  expect(provenance.asked()).toBeGreaterThan(0);
  expect(after.rows).toBe(1);
  expect(after.bubbles).toBe(1);
  expect(after.row).toBe(before.row);
  expect(after.bubble).toBe(before.bubble);
  expect(after.bubbleClass).toBe(before.bubbleClass);
  expect(after.position).toBe(before.position);
  expect(after.phase).toBe("confirmed");
  /* The row keeps the operator's own words; the paths stay in the record. */
  expect(after.bubble!.textContent).toContain(words);
  expect(after.bubble!.textContent).not.toContain("release-notes.pdf");
  /* Every committed state in between: one copy, and the original row. */
  for (const state of watch.seen) expect(state).toEqual({ bubbles: 1, attached: true });
  await act(async () => root.unmount());
  host.remove();
});

test("an image-only record lands in its row and keeps its place while the read is open", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  holdProvenance();
  const submittedAt = Date.now();
  lines = [codexAgentLine(new Date(submittedAt - 5_000).toISOString(), "The release branch is green again.")];
  enqueueOutbox(CARD, { id: "key-image-only", text: "", images: 1, at: submittedAt });
  updateOutbox(CARD, "key-image-only", { state: "delivering" });
  await settle(() => root.render(feedOnly()));
  await projectReceipt("key-image-only", "operation-image-only", "delivered", submittedAt + 1_000);
  const before = messageRows(host);
  expect(before).toHaveLength(1);
  const watch = watchMutations(host, () => before[0]!.row);

  /* A native Codex user item: the picture, and a text part that is only the
     marker. No words for anything to be recognised by. */
  await settle(() => {
    lines = [
      codexAgentLine(new Date(submittedAt - 5_000).toISOString(), "The release branch is green again."),
      JSON.stringify({
        type: "response_item",
        timestamp: new Date(submittedAt + 3_000).toISOString(),
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
            { type: "input_text", text: `<!-- llv:structured-user dedup=${deliveryDedupToken("operation-image-only")} -->` },
          ],
        },
      }),
    ];
  });
  await settle(() => root.render(feedOnly()));
  watch.stop();

  const after = messageRows(host);
  expect(after).toHaveLength(1);
  expect(after[0]!.row).toBe(before[0]!.row);
  expect(after[0]!.bubble).toBe(before[0]!.bubble);
  expect(after[0]!.bubbleClass).toBe(before[0]!.bubbleClass);
  /* The row did not move down the conversation: the picture follows it. */
  expect(after[0]!.position).toBe(before[0]!.position);
  expect(after[0]!.phase).toBe("confirmed");
  const kinds = [...host.querySelectorAll("[data-feed-kind]")].map((row) => row.getAttribute("data-feed-kind"));
  const messageAt = after[0]!.position;
  /* Exactly one copy of the picture, and it sits below the message. */
  const attachments = kinds.filter((kind) => kind === "image");
  expect(attachments).toHaveLength(1);
  expect(kinds.indexOf("image")).toBeGreaterThan(messageAt);
  for (const state of watch.seen) expect(state.attached).toBe(true);
  await act(async () => root.unmount());
  host.remove();
});

test("a lost acknowledgement's record never paints a second copy while its join is being read", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const provenance = holdProvenance();
  const submittedAt = Date.now();
  /* Admitted, and nobody told the browser: no operation id, no receipt. */
  enqueueOutbox(CARD, { id: "key-lost-ack-held", text: TEXT, images: 0, at: submittedAt });
  updateOutbox(CARD, "key-lost-ack-held", {
    state: "failed", deliveryUncertain: true, dispatchedAt: submittedAt + 10, error: "lost response",
  });
  await settle(() => root.render(surface()));
  const before = reading(host);
  expect(before.phase).toBe("pending");
  const watch = watchMutations(host, () => before.row);

  const token = deliveryDedupToken("operation-lost-ack-held");
  await settle(() => { lines = [codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT, token)]; });
  await settle(() => root.render(surface()));

  /* The read is open. The record belongs to SOME submission and only the
     registry can say which — so it waits, and the operator's own row is the
     one copy of the message on screen. It is not settled by the words. */
  const waiting = reading(host);
  expect(waiting.rows).toBe(1);
  expect(waiting.bubbles).toBe(1);
  expect(waiting.row).toBe(before.row);
  expect(waiting.phase).toBe("pending");
  expect(waiting.progress).toBe(1);

  /* The registry answers: the record is this submission's. */
  await settle(() => provenance.answer({ submissions: { [token]: "key-lost-ack-held" } }));
  await settle(() => root.render(surface()));
  watch.stop();
  const adopted = reading(host);
  expect(adopted.rows).toBe(1);
  expect(adopted.bubbles).toBe(1);
  expect(adopted.row).toBe(before.row);
  expect(adopted.bubble).toBe(before.bubble);
  expect(adopted.position).toBe(before.position);
  expect(adopted.phase).toBe("confirmed");
  for (const state of watch.seen) expect(state).toEqual({ bubbles: 1, attached: true });
  /* Still the queue's record under its original key, payload intact. */
  expect(readOutbox(CARD).find((entry) => entry.id === "key-lost-ack-held"))
    .toMatchObject({ text: TEXT, deliveryUncertain: true });
  await act(async () => root.unmount());
  host.remove();
});

test("a record the registry does not name renders on its own once the read has answered", async () => {
  /* The wait is for an answer, never for a particular one. Somebody else's
     send of the same words is somebody else's message: once the registry has
     answered without naming this row, it is painted, and the operator's own
     row keeps waiting with its one control. */
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const provenance = holdProvenance();
  const submittedAt = Date.now();
  enqueueOutbox(CARD, { id: "key-lost-ack-other", text: TEXT, images: 0, at: submittedAt });
  updateOutbox(CARD, "key-lost-ack-other", { state: "failed", deliveryUncertain: true, error: "lost response" });
  await settle(() => root.render(surface()));
  const before = reading(host);

  const foreign = deliveryDedupToken("operation-somebody-else");
  await settle(() => { lines = [codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT, foreign)]; });
  await settle(() => root.render(surface()));
  expect(reading(host).bubbles).toBe(1);

  await settle(() => provenance.answer({ submissions: { [foreign]: "key-of-another-browser" } }));
  await settle(() => root.render(surface()));
  const after = reading(host);
  expect(after.bubbles).toBe(2);
  expect(after.row).toBe(before.row);
  expect(after.phase).toBe("pending");
  expect(after.progress).toBe(1);
  expect(readOutbox(CARD)[0]).toMatchObject({ deliveryUncertain: true });
  await act(async () => root.unmount());
  host.remove();
});

/* ── A Claude record is the message, not a row beside it (round-5 P1) ─────── */

const CLAUDE_PATH = "/claude-one-message-one-row.jsonl";
const claudeFile = {
  ...(file as unknown as Record<string, unknown>),
  path: CLAUDE_PATH,
  root: "claude-projects",
  name: "claude-one-message-one-row.jsonl",
  engine: "claude",
  fmt: "claude",
} as unknown as FileEntry;

/** The shape a structured Claude delivery journals: an SDK-sourced user
    record, which the parser renders as a system row until the ledger joins
    its uuid to the delivery that wrote it. */
const claudeSdkUserLine = (timestamp: string, uuid: string, text: string) => JSON.stringify({
  type: "user", uuid, timestamp, promptSource: "sdk", sessionId: "claude-one-message-one-row",
  message: { role: "user", content: text },
});

test("a delivered Claude record takes the operator's row and paints no second bubble", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const uuid = ["5b1c7a0e", "3d2f", "4c8a", "9e61", "0a4b2c6d8e1f"].join("-");
  const selected = {
    version: 1, state: "selected", capturedAt: new Date().toISOString(),
    conversationId: "conversation_selected_card", label: "Release lane", project: "viewer",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/log/provenance")) {
      return Response.json({
        messages: { [uuid]: { origin: "operator", submissionId: "key-claude", selectedContext: selected } },
        occurrences: [],
        submissions: {},
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const submittedAt = Date.now();
  enqueueOutbox(CARD, { id: "key-claude", text: TEXT, images: 1, at: submittedAt });
  updateOutbox(CARD, "key-claude", { state: "delivering", operationId: "operation-claude" });
  const feed = () => feedOnly(claudeFile);
  await settle(() => root.render(feed()));
  const before = reading(host);
  expect(before.rows).toBe(1);
  expect(before.bubbles).toBe(1);
  const watch = watchMutations(host, () => before.row);

  await settle(() => { lines = [claudeSdkUserLine(new Date(submittedAt + 3_000).toISOString(), uuid, TEXT)]; });
  await settle(() => root.render(feed()));
  /* And once more after everything has settled — the reviewer's second copy
     survived settlement, so settlement is part of the claim. */
  await settle(() => root.render(feed()));
  watch.stop();

  const after = reading(host);
  expect(after.rows).toBe(1);
  expect(after.bubbles).toBe(1);
  expect(after.row).toBe(before.row);
  expect(after.bubble).toBe(before.bubble);
  expect(after.bubbleClass).toBe(before.bubbleClass);
  expect(after.position).toBe(before.position);
  expect(after.phase).toBe("confirmed");
  /* The reference the operator attached rides the record into the row. */
  expect(after.row!.textContent).toContain("Release lane");
  /* No system card beside it either: the record has no row of its own. */
  expect(host.querySelectorAll("[data-feed-kind='sysmsg']")).toHaveLength(0);
  for (const state of watch.seen) expect(state).toEqual({ bubbles: 1, attached: true });
  await act(async () => root.unmount());
  host.remove();
});

/* ── Text never decides for a submission that has an identity (#1950 round 3) ──
   Both of these reproduce a final-review finding against the mounted window:
   an admitted submission is a message whose own delivery this browser can
   name, so only that name — its operation's record, its turn, its native
   item — may take its row. Another record repeating its words may not, and a
   COUNT of such records may not hide it either. */

test("two admitted equal-text sends: the second's record leaves the first pending on its node", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const submittedAt = Date.now();
  serveProvenance({});
  enqueueOutbox(CARD, { id: "key-admitted-first", text: TEXT, images: 0, at: submittedAt });
  updateOutbox(CARD, "key-admitted-first", { state: "delivering" });
  enqueueOutbox(CARD, { id: "key-admitted-second", text: TEXT, images: 0, at: submittedAt + 1_000 });
  updateOutbox(CARD, "key-admitted-second", { state: "delivering" });
  await settle(() => root.render(feedOnly()));
  /* Both admitted: the browser holds both operation ids, so both records can
     be named the moment they land. */
  await projectReceipt("key-admitted-first", "operation-admitted-first", "queued", submittedAt + 500);
  await projectReceipt("key-admitted-second", "operation-admitted-second", "queued", submittedAt + 1_500);
  const before = messageRows(host);
  expect(before).toHaveLength(2);
  expect(before.map((entry) => entry.phase)).toEqual(["pending", "pending"]);
  const watch = watchMutations(host, () => before[0]!.row);

  /* The SECOND send's own record lands first. */
  const secondRecord = codexStructuredUserLine(
    new Date(submittedAt + 3_000).toISOString(), TEXT, deliveryDedupToken("operation-admitted-second"),
  );
  await settle(() => { lines = [secondRecord]; });
  await settle(() => root.render(feedOnly()));
  await settle(() => root.render(feedOnly()));
  watch.stop();

  const half = messageRows(host);
  expect(half).toHaveLength(2);
  const halfFirst = half.find((entry) => entry.row === before[0]!.row);
  const halfSecond = half.find((entry) => entry.row === before[1]!.row);
  /* The first send is still delivering: same node, same place, still
     pending, still showing its progress — and nothing retired it. */
  expect(halfFirst).toBeDefined();
  expect(halfFirst!.phase).toBe("pending");
  expect(halfFirst!.bubble).toBe(before[0]!.bubble);
  expect(halfFirst!.position).toBe(before[0]!.position);
  expect(halfFirst!.progress).toBe(1);
  /* The second took its own record and did not move. */
  expect(halfSecond).toBeDefined();
  expect(halfSecond!.phase).toBe("confirmed");
  expect(halfSecond!.bubble).toBe(before[1]!.bubble);
  expect(halfSecond!.position).toBe(before[1]!.position);
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(2);
  expect(readOutbox(CARD).find((entry) => entry.id === "key-admitted-first")!.retiredEchoId).toBeUndefined();
  /* At no committed instant was the first row gone or a copy missing. */
  for (const state of watch.seen) expect(state).toEqual({ bubbles: 2, attached: true });

  /* Then the first send's own record, after the agent's answer to the second. */
  await settle(() => {
    lines = [
      secondRecord,
      codexAgentLine(new Date(submittedAt + 3_500).toISOString(), "Looking now."),
      codexStructuredUserLine(new Date(submittedAt + 4_000).toISOString(), TEXT, deliveryDedupToken("operation-admitted-first")),
    ];
  });
  await settle(() => root.render(feedOnly()));
  const both = messageRows(host);
  expect(both).toHaveLength(2);
  const bothFirst = both.find((entry) => entry.row === before[0]!.row);
  const bothSecond = both.find((entry) => entry.row === before[1]!.row);
  expect(bothFirst!.phase).toBe("confirmed");
  expect(bothSecond!.phase).toBe("confirmed");
  expect(bothFirst!.bubble).toBe(before[0]!.bubble);
  expect(bothSecond!.bubble).toBe(before[1]!.bubble);
  /* Now each sits at its own record. */
  expect(bothSecond!.position).toBeLessThan(bothFirst!.position);
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(2);
  await act(async () => root.unmount());
  host.remove();
});

test("an admitted row is not adopted by an equal-text record whose identity resolves to nobody", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const submittedAt = Date.now();
  /* The registry has answered, and it has no mapping for the foreign token. */
  serveProvenance({});
  enqueueOutbox(CARD, { id: "key-admitted", text: TEXT, images: 0, at: submittedAt });
  updateOutbox(CARD, "key-admitted", { state: "delivering" });
  await settle(() => root.render(feedOnly()));
  await projectReceipt("key-admitted", "operation-admitted", "queued", submittedAt + 500);
  const before = reading(host);
  expect(before.phase).toBe("pending");

  /* Somebody else's delivery of the same words: it names an operation, and
     that operation is not this row's. */
  await settle(() => {
    lines = [codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT, deliveryDedupToken("operation-somebody-else"))];
  });
  await settle(() => root.render(feedOnly()));
  await settle(() => root.render(feedOnly()));

  const rows = messageRows(host);
  const own = rows.find((entry) => entry.row === before.row);
  expect(own).toBeDefined();
  expect(own!.phase).toBe("pending");
  expect(own!.bubble).toBe(before.bubble);
  expect(own!.progress).toBe(1);
  /* The foreign record renders as its own message. */
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(2);
  const entry = readOutbox(CARD).find((candidate) => candidate.id === "key-admitted")!;
  expect(entry.retiredEchoId).toBeUndefined();
  expect(entry.state).toBe("delivering");

  /* Its own record — its own operation — is what takes the row. */
  await settle(() => {
    lines = [
      codexStructuredUserLine(new Date(submittedAt + 3_000).toISOString(), TEXT, deliveryDedupToken("operation-somebody-else")),
      codexStructuredUserLine(new Date(submittedAt + 4_000).toISOString(), TEXT, deliveryDedupToken("operation-admitted")),
    ];
  });
  await settle(() => root.render(feedOnly()));
  const adopted = messageRows(host).find((candidate) => candidate.row === before.row);
  expect(adopted).toBeDefined();
  expect(adopted!.phase).toBe("confirmed");
  expect(adopted!.bubble).toBe(before.bubble);
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(2);
  await act(async () => root.unmount());
  host.remove();
});

test("a delivered Claude record waits for its native id while the ledger read is open, then takes its row", async () => {
  /* The record's words no longer bind it to an admitted row, and nothing in
     the browser can compute its engine id's owner. So while the ledger has
     not answered, the record waits: the operator keeps exactly one copy of
     the message, on its original node, and no system card flashes beside
     it. */
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const uuid = ["7c2e9a1b", "4f3d", "4b6a", "8d21", "1c3e5a7b9d0f"].join("-");
  const provenance = holdProvenance();
  const submittedAt = Date.now();
  enqueueOutbox(CARD, { id: "key-claude-held", text: TEXT, images: 0, at: submittedAt });
  updateOutbox(CARD, "key-claude-held", { state: "delivering", operationId: "operation-claude-held" });
  const feed = () => feedOnly(claudeFile);
  await settle(() => root.render(feed()));
  const before = reading(host);
  expect(before.rows).toBe(1);
  const seen: { bubbles: number; systemRows: number; attached: boolean }[] = [];
  const observer = new MutationObserver(() => {
    seen.push({
      bubbles: host.querySelectorAll("[data-user-bubble]").length,
      systemRows: host.querySelectorAll("[data-feed-kind='sysmsg']").length,
      attached: Boolean(before.row && host.contains(before.row)),
    });
  });
  observer.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });

  await settle(() => { lines = [claudeSdkUserLine(new Date(submittedAt + 3_000).toISOString(), uuid, TEXT)]; });
  await settle(() => root.render(feed()));
  expect(provenance.asked()).toBeGreaterThan(0);
  const held = reading(host);
  expect(held.rows).toBe(1);
  expect(held.bubbles).toBe(1);
  expect(held.row).toBe(before.row);
  expect(held.phase).toBe("pending");
  expect(host.querySelectorAll("[data-feed-kind='sysmsg']")).toHaveLength(0);

  await settle(() => provenance.answer({ messages: { [uuid]: { origin: "operator", submissionId: "key-claude-held" } } }));
  await settle(() => root.render(feed()));
  observer.disconnect();
  const after = reading(host);
  expect(after.rows).toBe(1);
  expect(after.bubbles).toBe(1);
  expect(after.row).toBe(before.row);
  expect(after.bubble).toBe(before.bubble);
  expect(after.position).toBe(before.position);
  expect(after.phase).toBe("confirmed");
  for (const state of seen) expect(state).toEqual({ bubbles: 1, systemRows: 0, attached: true });
  await act(async () => root.unmount());
  host.remove();
});
