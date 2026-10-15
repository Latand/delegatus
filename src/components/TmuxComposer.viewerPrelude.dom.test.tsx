/**
 * WHOSE turns carry the operator's view.
 *
 * The viewer-context prelude ("the operator is looking at: project …") belongs to
 * the active manager seat for the conversation's project. Its first version was gated on
 * `voiceEnabled`, a CAPABILITY shared by every hosted codex-app-server
 * conversation, so an ordinary hosted worker's turns silently carried the
 * operator's current project, focused conversation and selection too.
 *
 * These cases drive the REAL composer against a real structured send and read the
 * bytes that go on the wire: the manager's conversation gets the line, an
 * identically-capable worker gets none. Restore the capability gate and the worker
 * case goes red.
 */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { installTmuxComposerRuntimeForTests, resetTmuxComposerRuntimeForTests } from "@/test-helpers/tmuxComposerRuntime";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { pendingBridgeAcknowledgements, rememberBridgeAcknowledgement, resetBridgeAcknowledgementsForTests } from "@/lib/bridge/pendingAcknowledgements";
import { setComposerAdmissionTimingForTests } from "./composerAdmissionDeadline";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const MANAGER = "conversation_manager_prelude";
const WORKER = "conversation_worker_prelude";

/* Both conversations are hosted codex-app-server sessions: identically
   voice-capable, so capability cannot be what tells them apart. */
function structuredView(conversationId: string): RuntimeSessionView {
  return {
    session: {
      conversationId,
      hostKind: "codex-app-server",
      host: "hosted",
      capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: false, perTurnModel: false } },
      recentReceipts: [],
    },
    uiState: {},
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as unknown as RuntimeSessionView;
}

import { appendComposerDraft, TmuxComposer } from "./TmuxComposer";
const { readOutbox, resetOutboxForTests, retryOutbox } = await import("./conversation/outbox");
const { designatedManagerConversationId, isCachedDesignatedManagerConversation, MANAGER_IDENTITY_TTL_MS, resetManagerIdentityForTest } = await import("./voice/managerIdentity");
const { viewBus } = await import("@/hooks/viewPresenceBus");

const realFetch = globalThis.fetch;
const composerStorage = installComposerStorageForTests();
afterAll(() => composerStorage.uninstall());
let roots: Root[] = [];
let sentTexts: string[] = [];

function fileFor(conversationId: string, name: string): FileEntry {
  return {
    path: `/${name}.jsonl`, root: "codex-sessions", name: `${name}.jsonl`, project: "viewer",
    title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
    size: 1, activity: "idle", proc: "running", pid: null, conversationId,
    pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

/** The active project seat names the manager and nobody else. */
function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/orchestrator/seat?project=viewer") {
      return json({ seat: { conversationId: MANAGER }, pending: null, exists: true });
    }
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sentTexts.push(body.text ?? "");
      return json({ operationId: "op-1", receipt: { status: "delivered", operationId: "op-1" } });
    }
    return json({});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  installTmuxComposerRuntimeForTests({
    useRuntimeView: (file) => file.conversationId === MANAGER || file.conversationId === WORKER
      ? structuredView(file.conversationId)
      : null,
  });
  sentTexts = [];
  resetManagerIdentityForTest();
  stubFetch();
  /* The operator is somewhere else entirely: another project, another card
     focused — exactly the situation the prelude exists to describe. */
  viewBus.reportContext({ project: "other-project", board: { renderedRevision: null, durableRevision: null, sync: "unavailable" } });
  viewBus.reportSlice({
    mode: "list",
    focusedPath: "/some-other-card.jsonl",
    selectedPaths: ["/some-other-card.jsonl"],
    visiblePaths: [],
    camera: null,
  });
});

afterEach(async () => {
  resetTmuxComposerRuntimeForTests();
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
  resetManagerIdentityForTest();
  resetBridgeAcknowledgementsForTests();
  setComposerAdmissionTimingForTests(null);
  composerStorage.reset();
});

/** Type a draft into the real composer and submit it the way the Send button
    does, then let the queue drain onto the wire. */
async function sendThrough(file: FileEntry, text: string): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<TmuxComposer file={file} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    appendComposerDraft(file.conversationId!, text);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (host.querySelector("form") as HTMLFormElement)
      .dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    for (let tick = 0; tick < 12; tick += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

test("the manager's turn carries what the operator is looking at", async () => {
  await sendThrough(fileFor(MANAGER, "manager_prelude"), "work on this");

  expect(sentTexts).toHaveLength(1);
  expect(sentTexts[0]).toContain("[viewer context — the operator is looking at:");
  expect(sentTexts[0]).toContain("project other-project");
  expect(sentTexts[0]!.endsWith("work on this")).toBe(true);
});

test("an equally voice-capable worker's turn carries nothing of the operator's view", async () => {
  await sendThrough(fileFor(WORKER, "worker_prelude"), "run the suite");

  expect(sentTexts).toEqual(["run the suite"]);
  expect(sentTexts[0]).not.toContain("viewer context");
  expect(sentTexts[0]).not.toContain("other-project");
});

test("a rotated seat scopes the prelude to the successor and revokes the predecessor", async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/orchestrator/seat?project=viewer") {
      return json({
        seat: { conversationId: WORKER, predecessorConversationId: MANAGER, seatEpoch: 2 },
        pending: null,
        exists: true,
      });
    }
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sentTexts.push(body.text ?? "");
      return json({ operationId: "op-1", receipt: { status: "delivered", operationId: "op-1" } });
    }
    return json({});
  }) as unknown as typeof fetch;

  await sendThrough(fileFor(MANAGER, "manager_prelude"), "predecessor turn");
  await sendThrough(fileFor(WORKER, "worker_prelude"), "successor turn");

  expect(sentTexts[0]).toBe("predecessor turn");
  expect(sentTexts[1]).toContain("[viewer context — the operator is looking at:");
  expect(sentTexts[1]!.endsWith("successor turn")).toBe(true);
});

test("no designated manager means no conversation gets the prelude", async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/orchestrator/seat?project=viewer") {
      return json({ seat: null, pending: null, exists: false });
    }
    if (url === "/api/runtime/send") {
      sentTexts.push((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      return json({ operationId: "op-1", receipt: { status: "delivered", operationId: "op-1" } });
    }
    return json({});
  }) as unknown as typeof fetch;

  await sendThrough(fileFor(MANAGER, "manager_prelude"), "still just a message");
  expect(sentTexts).toEqual(["still just a message"]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!condition() && performance.now() < deadline) await settle();
  expect(condition()).toBe(true);
}

/** Mount first, then reset the mount-warmed seat cache at the submit boundary. */
async function preparedComposer(attachment: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await settle(() => root.render(<TmuxComposer file={fileFor(MANAGER, "overlap")} />));
  await settle(() => appendComposerDraft(MANAGER, "first authored turn"));
  if (attachment) {
    const input = host.querySelector("textarea")!;
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
    await settle(() => props.onPaste({
      clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File(["synthetic-image"], "image.png", { type: "image/png" }) }] },
      preventDefault() {},
    }));
    await until(() => Boolean(host.querySelector('[data-testid="attachment-tile"][data-status="ready"]')));
  }
  resetManagerIdentityForTest();
  return {
    host,
    submit: () => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event),
  };
}

type SendBody = { conversationId: string; idempotencyKey: string; text: string; images: { base64: string; mime: string }[] };
const managerAnswer = () => Response.json({ seat: { conversationId: MANAGER }, pending: null, exists: true });
const bridgeAnswer = () => Response.json({ prelude: { text: "Earlier bridge report", ackToken: "current-batch" } });
const deliveredAnswer = (body: SendBody) => Response.json({ ok: true, operationId: `operation-${body.idempotencyKey}`, receipt: {
  operationId: `operation-${body.idempotencyKey}`, conversationId: body.conversationId, idempotencyKey: body.idempotencyKey,
  kind: "send", status: "delivered", text: body.text, at: new Date().toISOString(), revision: 1,
} });

test("cached manager context expires at the TTL boundary and follows the current designation", async () => {
  const cachedAt = 1_000;
  expect(isCachedDesignatedManagerConversation(MANAGER, "viewer", () => cachedAt)).toBe(false);
  await designatedManagerConversationId("viewer", fetch, () => cachedAt);
  expect(isCachedDesignatedManagerConversation(MANAGER, " viewer ", () => cachedAt + MANAGER_IDENTITY_TTL_MS - 1)).toBe(true);
  expect(isCachedDesignatedManagerConversation(MANAGER, "viewer", () => cachedAt + MANAGER_IDENTITY_TTL_MS)).toBe(false);
  expect(isCachedDesignatedManagerConversation(MANAGER, "viewer", () => cachedAt + MANAGER_IDENTITY_TTL_MS + 1)).toBe(false);
  expect(isCachedDesignatedManagerConversation(MANAGER, "other-project", () => cachedAt)).toBe(false);
  const successorFetch = (async () => Response.json({ seat: { conversationId: WORKER }, exists: true })) as unknown as typeof fetch;
  await designatedManagerConversationId("viewer", successorFetch, () => cachedAt + MANAGER_IDENTITY_TTL_MS);
  expect(isCachedDesignatedManagerConversation(MANAGER, "viewer", () => cachedAt + MANAGER_IDENTITY_TTL_MS)).toBe(false);
  expect(isCachedDesignatedManagerConversation(WORKER, "viewer", () => cachedAt + MANAGER_IDENTITY_TTL_MS)).toBe(true);
});

/** Real composer, bridge drain, storage and runtime HTTP client; only HTTP answers are held. */
function holdPreparation() {
  const seat = deferred<Response>();
  const bridge = deferred<Response>();
  const previousAck = deferred<Response>();
  const wire = deferred<Response>();
  const events: string[] = [];
  const sends: SendBody[] = [];
  const redeemed = new Set<string>();
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/orchestrator/seat?project=viewer") {
      events.push("seat");
      return seat.promise;
    }
    if (url.startsWith("/api/bridge?")) {
      events.push("bridge");
      return bridge.promise;
    }
    if (url === "/api/bridge") {
      const { ackToken } = JSON.parse(String(init?.body));
      events.push(`ack:${ackToken}`);
      if (ackToken === "previous-batch") return previousAck.promise;
      if (redeemed.has(ackToken)) return Response.json({ error: "spent acknowledgement" }, { status: 409 });
      redeemed.add(ackToken);
      return Response.json({ ok: true });
    }
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body)) as SendBody;
      sends.push(body);
      events.push(`send:${sends.length}`);
      return sends.length === 1 ? wire.promise : deliveredAnswer(body);
    }
    return fallback(input as RequestInfo, init);
  }) as typeof fetch;
  return { seat, bridge, previousAck, wire, events, sends, redeemed,
    async release() {
      seat.resolve(managerAnswer()); bridge.resolve(bridgeAnswer()); previousAck.resolve(Response.json({ ok: true }));
      wire.resolve(Response.json({ ok: false, delivery: "refused" }, { status: 400 }));
      await settle();
    },
  };
}

for (const attachment of [false, true]) {
  for (const preparation of ["warm cache", "cold lookup with acknowledgements"] as const) {
    test(`seat rotation during bridge preparation omits expired manager context (${attachment ? "attachment" : "text"}, ${preparation})`, async () => {
      const composer = await preparedComposer(attachment);
      let now = Date.now();
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const fallback = globalThis.fetch;
      const bridge = deferred<Response>();
      const acknowledgements = Array.from({ length: 5 }, () => deferred<Response>());
      const ackCalls: string[] = [];
      const sends: SendBody[] = [];
      let seat = MANAGER;
      let seatReads = 0;
      let bridgeReads = 0;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/orchestrator/seat?project=viewer") {
          seatReads += 1;
          return Response.json({ seat: { conversationId: seat }, exists: true });
        }
        if (url.startsWith("/api/bridge?")) {
          bridgeReads += 1;
          return bridge.promise;
        }
        if (url === "/api/bridge") {
          const { ackToken } = JSON.parse(String(init?.body));
          ackCalls.push(ackToken);
          return acknowledgements[Number(ackToken.split("-").at(-1))]!.promise;
        }
        if (url === "/api/runtime/send") {
          const body = JSON.parse(String(init?.body)) as SendBody;
          sends.push(body);
          return deliveredAnswer(body);
        }
        return fallback(input as RequestInfo, init);
      }) as typeof fetch;
      try {
        if (preparation === "warm cache") {
          expect(await designatedManagerConversationId("viewer")).toBe(MANAGER);
          now += MANAGER_IDENTITY_TTL_MS - 1_000;
        } else {
          for (let index = 0; index < acknowledgements.length; index += 1) {
            rememberBridgeAcknowledgement(`earlier-turn-${index}`, `previous-${index}`);
          }
        }
        await settle(composer.submit);
        await until(() => seatReads === 1);
        seat = WORKER;
        if (preparation === "warm cache") {
          await until(() => bridgeReads === 1);
          now += 2_000;
        } else {
          for (let index = 0; index < acknowledgements.length; index += 1) {
            await until(() => ackCalls.length === index + 1);
            expect(ackCalls[index]).toBe(`previous-${index}`);
            expect(sends).toHaveLength(0);
            // Each acknowledgement finishes within its 8 s deadline, while
            // their cumulative wait expires the initial manager lookup.
            now += 7_000;
            await settle(() => acknowledgements[index]!.resolve(Response.json({ ok: true })));
          }
        }
        expect(sends).toHaveLength(0);
        await settle(() => bridge.resolve(Response.json({ prelude: null })));
        await until(() => sends.length === 1 && readOutbox(MANAGER)[0]?.state === "delivered");
        expect(sends[0]!.text).toBe("first authored turn");
        expect(sends[0]!.images).toHaveLength(attachment ? 1 : 0);
        expect(sends[0]!.idempotencyKey).toBe(readOutbox(MANAGER)[0]!.id);
        expect(pendingBridgeAcknowledgements()).toEqual([]);
      } finally {
        clock.mockRestore();
        bridge.resolve(Response.json({ prelude: null }));
        for (const acknowledgement of acknowledgements) acknowledgement.resolve(Response.json({ ok: true }));
        await settle();
      }
    });
  }

  for (const first of ["seat", "bridge"] as const) {
    test(`manager lookup overlaps bridge drain; both gate one ordered send (${attachment ? "attachment" : "text"}, ${first} first)`, async () => {
      const composer = await preparedComposer(attachment);
      const held = holdPreparation();
      try {
        rememberBridgeAcknowledgement("earlier-turn", "previous-batch");
        await settle(composer.submit);
        await until(() => held.events.includes("ack:previous-batch"));
        // The old acknowledgement remains a barrier for the bridge GET alone.
        expect(held.events).toContain("seat");
        expect(held.events).not.toContain("bridge");
        expect(held.sends).toHaveLength(0);
        await settle(() => held.previousAck.resolve(Response.json({ ok: true })));
        await until(() => held.events.includes("bridge"));
        await settle(() => held[first].resolve(first === "seat" ? managerAnswer() : bridgeAnswer()));
        expect(held.sends).toHaveLength(0);
        expect(held.events).not.toContain("ack:current-batch");
        await settle(() => held[first === "seat" ? "bridge" : "seat"].resolve(first === "seat" ? bridgeAnswer() : managerAnswer()));
        await until(() => held.sends.length === 1);
        const original = held.sends[0]!;
        expect(original.text).toContain("Earlier bridge report\n\n[viewer context");
        expect(original.text).toContain("project other-project");
        expect(original.text.endsWith("first authored turn")).toBe(true);
        expect(original.images).toHaveLength(attachment ? 1 : 0);
        if (attachment) expect(original.images[0]).toEqual({ base64: btoa("synthetic-image"), mime: "image/png" });
        expect(original.idempotencyKey).toBe(readOutbox(MANAGER)[0]!.id);
        expect(held.events).not.toContain("ack:current-batch");
        await settle(() => appendComposerDraft(MANAGER, "second authored turn"));
        await settle(composer.submit);
        expect(readOutbox(MANAGER).map((row) => row.text)).toEqual(["first authored turn", "second authored turn"]);
        expect(held.sends).toHaveLength(1);
        // Each drain gets a fresh response, including the following turn.
        const fallback = globalThis.fetch;
        globalThis.fetch = ((input, init) => String(input).startsWith("/api/bridge?")
          ? Promise.resolve(Response.json({ prelude: null })) : fallback(input, init)) as typeof fetch;
        await settle(() => held.wire.resolve(deliveredAnswer(original)));
        await until(() => held.sends.length === 2 && readOutbox(MANAGER).every((row) => row.state === "delivered"));
        expect(held.sends.map((body) => body.text.endsWith("first authored turn"))).toEqual([true, false]);
        expect(held.sends[1]!.text.endsWith("second authored turn")).toBe(true);
        expect(new Set(held.sends.map((body) => body.idempotencyKey)).size).toBe(2);
        expect([...held.redeemed]).toEqual(["current-batch"]);
        expect(pendingBridgeAcknowledgements()).toEqual([]);
        await settle(() => retryOutbox(MANAGER, original.idempotencyKey));
        expect(held.sends).toHaveLength(2);
      } finally { await held.release(); }
    });
  }

  test(`manager timeout still waits for bridge and sends once (${attachment ? "attachment" : "text"})`, async () => {
    setComposerAdmissionTimingForTests({ admissionDeadlineMs: 20, receiptReconciliationMs: 100, receiptPollIntervalMs: 5 });
    const composer = await preparedComposer(attachment);
    const held = holdPreparation();
    try {
      await settle(composer.submit);
      await until(() => held.events.includes("bridge"));
      expect(held.events).toContain("seat");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
      expect(held.sends).toHaveLength(0);
      expect(held.events).not.toContain("ack:current-batch");
      await settle(() => held.bridge.resolve(bridgeAnswer()));
      await until(() => held.sends.length === 1);
      const original = held.sends[0]!;
      expect(original.text).toBe("Earlier bridge report\n\nfirst authored turn");
      await settle(() => held.wire.resolve(deliveredAnswer(original)));
      await until(() => readOutbox(MANAGER)[0]?.state === "delivered");
      await settle(() => held.seat.resolve(managerAnswer()));
      expect(held.sends).toHaveLength(1);
      expect(held.sends[0]).toEqual(original);
    } finally { await held.release(); }
  });
}

test("attachment refusal replays the sealed preludes and original key without a second drain", async () => {
  const composer = await preparedComposer(true);
  const held = holdPreparation();
  try {
    await settle(composer.submit);
    await until(() => held.events.includes("bridge"));
    await settle(() => { held.seat.resolve(managerAnswer()); held.bridge.resolve(bridgeAnswer()); });
    await until(() => held.sends.length === 1);
    const original = held.sends[0]!;
    await settle(() => appendComposerDraft(MANAGER, "keep the next draft"));
    await settle(() => held.wire.resolve(Response.json({ ok: false, delivery: "refused", error: "pre-admission refusal" }, { status: 503 })));
    await until(() => readOutbox(MANAGER)[0]?.state === "failed");
    expect(held.events).not.toContain("ack:current-batch");
    resetManagerIdentityForTest();
    viewBus.reportContext({ project: "later-project", board: { renderedRevision: null, durableRevision: null, sync: "unavailable" } });
    const retry = composer.host.querySelector<HTMLButtonElement>("[data-payload-retry]");
    expect(retry).not.toBeNull();
    await settle(() => retry!.click());
    await until(() => held.sends.length === 2 && readOutbox(MANAGER)[0]?.state === "delivered");
    expect(held.sends[1]).toEqual(original);
    expect(held.events.filter((event) => event === "seat")).toHaveLength(1);
    expect(held.events.filter((event) => event === "bridge")).toHaveLength(1);
    expect(composer.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("keep the next draft");
    await settle(() => retryOutbox(MANAGER, original.idempotencyKey));
    expect(held.sends).toHaveLength(2);
  } finally { await held.release(); }
});

test("a pending seat grants no viewer context", async () => {
  const composer = await preparedComposer(false);
  const held = holdPreparation();
  try {
    await settle(composer.submit);
    await until(() => held.events.includes("bridge"));
    await settle(() => {
      held.seat.resolve(Response.json({ seat: null, pending: { conversationId: MANAGER }, exists: false }));
      held.bridge.resolve(bridgeAnswer());
    });
    await until(() => held.sends.length === 1);
    expect(held.sends[0]!.text).toBe("Earlier bridge report\n\nfirst authored turn");
    await settle(() => held.wire.resolve(deliveredAnswer(held.sends[0]!)));
    await until(() => readOutbox(MANAGER)[0]?.state === "delivered");
  } finally { await held.release(); }
});
