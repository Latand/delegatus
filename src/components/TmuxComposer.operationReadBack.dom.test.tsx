/**
 * A row whose receipt fell out of the session tail is read back by its own
 * operation id, and a release or restart never sends it again.
 *
 * The session's receipt tail keeps a handful of receipts. On a busy
 * conversation an older message's receipt is evicted long before anyone looks
 * at it again, and after a reload or a re-host the row that still sits in
 * browser storage was only ever re-checked against that same tail: it showed
 * "delivering" for hours while `GET /api/runtime/operations/<id>` answered
 * `delivered` at revision 1. Everything queued behind it waited too.
 *
 * These cases run the production pieces end to end: the structured delivery
 * queue over a real runtime journal and agent registry, the production
 * operations route with its settlement read, and the production composer
 * mounted over storage seeded the way a stale browser tab holds it. Every
 * request that is not a GET is recorded, and none may name the old operation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { FakeEngineHost, createFakeDeliveryLedger } from "@/lib/runtime/fixtures/fakeEngineHost";
import { handleRuntimeOperationQuery } from "@/lib/runtime/http";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { structuredContentDigest } from "@/lib/runtime/structuredContent";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "@/lib/runtime/structuredDeliveryQueue";
import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { RuntimeJournal } from "@/runtime-host/journal";
import { installTmuxComposerRuntimeForTests, resetTmuxComposerRuntimeForTests } from "@/test-helpers/tmuxComposerRuntime";

import { readOutbox, resetOutboxForTests } from "./conversation/outbox";
import { TmuxComposer } from "./TmuxComposer";

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operation-read-back-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const realFetch = globalThis.fetch;

beforeEach(() => {
  installTmuxComposerRuntimeForTests({ useRuntimeView: () => null, useRuntimeReceipts: () => [] });
});

afterEach(() => {
  resetTmuxComposerRuntimeForTests();
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

function journalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
    transitionOperation: async (operationId: string, status: Parameters<RuntimeJournal["transitionOperation"]>[1], details?: Parameters<RuntimeJournal["transitionOperation"]>[2]) =>
      journal.transitionOperation(operationId, status, details),
  } as unknown as RuntimeHostClient;
}

function queuePort(journal: RuntimeJournal, hostClaim: string, failDelivered = false): StructuredDeliveryQueuePort {
  return {
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      if (failDelivered && status === "delivered") throw new Error("the Viewer was replaced before confirmation commit");
      journal.transitionOperation(operationId, status, details);
    },
    status: async (operationId) => journal.operationResult(operationId)?.receipt ?? null,
    hostClaim: () => hostClaim,
  };
}

interface Delivery {
  conversationId: string;
  operationId: string;
  key: string;
  text: string;
  registry: AgentRegistry;
  journalFile: string;
  ledger: ReturnType<typeof createFakeDeliveryLedger>;
}

/** One admitted operator message: a reservation in the registry and the
    operation in the runtime journal, exactly as the send route leaves them. */
function admit(name: string): Delivery {
  const directory = path.join(sandbox, name);
  const sessionId = `${name}-session`;
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "account-a",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-09-21T19:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "account-a",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const text = "is the earlier step finished yet?";
  const operationId = `${name}-operation`;
  const clientKey = `${name}-key`;
  const held = registry.holdDelivery(
    conversation.id,
    text,
    clientKey,
    "text",
    [],
    structuredContentDigest({ text, images: [] }),
    { operationId, kind: "send", policy: "interrupt-active", turnId: null },
  );
  expect(registry.beginDeliveryAttempt(held.id, held.generationId!)?.state).toBe("delivery-uncertain");
  const journalFile = path.join(directory, "events.sqlite");
  const journal = new RuntimeJournal(journalFile, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({ kind: "send", operationId, idempotencyKey: clientKey, conversationId: conversation.id, text, policy: "interrupt-active" });
  journal.close();
  return { conversationId: conversation.id, operationId, key: clientKey, text, registry, journalFile, ledger: createFakeDeliveryLedger() };
}

/** What the tab still holds from before the release: the first message on
    the wire at revision 2 under its original owner, and a second one queued
    locally behind it. Written straight into storage, as a reload finds it. */
function seedStaleTab(delivery: Delivery, admittedAt: string): void {
  const stale: RuntimeReceipt = {
    operationId: delivery.operationId,
    idempotencyKey: delivery.key,
    conversationId: delivery.conversationId,
    kind: "send",
    status: "delivering",
    reason: "delivering-owner:executor-a@claim-a:1",
    text: delivery.text,
    at: admittedAt,
    admittedAt,
    revision: 2,
  };
  // Submitted nine hours before the tab reopens, like the incident's row.
  const submittedAt = Date.now() - 9 * 60 * 60_000;
  sessionStorage.setItem(`llvOutbox:${delivery.conversationId}`, JSON.stringify([
    { id: delivery.key, text: delivery.text, images: 0, at: submittedAt, state: "delivering", deliveryReceipt: stale, operationId: delivery.operationId },
    { id: "second-key", text: "and the next thing?", images: 0, at: submittedAt + 60_000, state: "queued" },
  ]));
  sessionStorage.setItem(`llvRecoveryReceipts:${delivery.conversationId}`, JSON.stringify([stale]));
}

interface Recorded { method: string; url: string; body: string }

/** GETs of an operation go to the production route; everything else is
    recorded and left pending, so a send can be counted and never completes. */
function serveOperations(answer: (operationId: string) => Promise<Response>): Recorded[] {
  const requests: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
    if (url === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: { "0": "%1" } }) } as Response;
    const operation = /^\/api\/runtime\/operations\/([^/?]+)$/.exec(url);
    if (operation && method === "GET") return answer(decodeURIComponent(operation[1]!));
    return new Promise(() => {}) as unknown as Response;
  }) as typeof fetch;
  return requests;
}

function composerFile(conversationId: string): FileEntry {
  return {
    path: "/sessions/stale-tab.jsonl", root: "codex-sessions", name: "stale-tab.jsonl", project: "viewer",
    title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
    size: 1, activity: "idle", proc: "running", pid: null, conversationId,
    pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

async function mountComposer(conversationId: string): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={composerFile(conversationId)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return async () => act(async () => root.unmount());
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

const touchesOperation = (requests: Recorded[], delivery: Delivery) => requests.filter((request) =>
  request.method !== "GET" && (request.url.includes(delivery.operationId) || request.body.includes(delivery.key)));

test("a stale delivering row reloaded after a release reads its delivered record back and drains the queue once", async () => {
  const delivery = admit("delivered-before-release");
  // Executor A hands the message over and the journal records its arrival.
  const journal = new RuntimeJournal(delivery.journalFile, { structuredHosts: true });
  await new StructuredDeliveryQueue(queuePort(journal, "claim-a:1"), () => new FakeEngineHost(delivery.ledger)).drain();
  expect(journal.operationResult(delivery.operationId)?.receipt.status).toBe("delivered");
  expect(delivery.ledger.writes).toHaveLength(1);

  const admittedAt = journal.operationResult(delivery.operationId)!.receipt.admittedAt ?? new Date().toISOString();
  seedStaleTab(delivery, admittedAt);
  const requests = serveOperations((operationId) => handleRuntimeOperationQuery(operationId, {
    client: () => journalClient(journal),
    rolledBack: () => false,
    settle: (id, client) => resolveSendReceipt(id, { client, registry: delivery.registry }),
  }));
  const unmount = await mountComposer(delivery.conversationId);
  try {
    await waitFor(() => readOutbox(delivery.conversationId).find((entry) => entry.id === delivery.key)?.state === "delivered");

    const [first, second] = readOutbox(delivery.conversationId);
    expect(first).toMatchObject({ id: delivery.key, state: "delivered" });
    expect(first!.deliveryUncertain).toBeUndefined();
    /* The coordinator's browser acceptance reads exactly this: the stored
       recovery receipt of the original operation and key says delivered. */
    const stored = (JSON.parse(sessionStorage.getItem(`llvRecoveryReceipts:${delivery.conversationId}`) ?? "[]") as RuntimeReceipt[])
      .find((candidate) => candidate.operationId === delivery.operationId && candidate.idempotencyKey === delivery.key
        && candidate.conversationId === delivery.conversationId);
    expect(stored?.status).toBe("delivered");
    // The answer the route gave was the settled record at revision 1.
    expect(requests.filter((request) => request.method === "GET" && request.url.includes(delivery.operationId)).length).toBeGreaterThan(0);
    /* The message behind it is released under its own key: the serial
       dispatcher claims it (queued → delivering) exactly once, and only
       because the row ahead of it no longer holds the wire. */
    expect(second?.id).toBe("second-key");
    await waitFor(() => readOutbox(delivery.conversationId)[1]?.state !== "queued");
    expect(readOutbox(delivery.conversationId)[1]).toMatchObject({ id: "second-key", state: "delivering" });
    expect(requests.filter((request) => request.method !== "GET" && request.body.includes("second-key")).length).toBeLessThanOrEqual(1);
    // Nothing was ever sent, retried or discarded for the delivered operation.
    expect(touchesOperation(requests, delivery)).toEqual([]);
    expect(delivery.ledger.writes).toHaveLength(1);
  } finally {
    await unmount();
    journal.close();
  }
});

test("a row left delivering by an executor the release replaced ends uncertain, never resent", async () => {
  const delivery = admit("owner-replaced");
  /* Executor A hands the message to the engine and dies with the Viewer
     before it can record the answer: the row stays `delivering` under A. */
  const first = new RuntimeJournal(delivery.journalFile, { structuredHosts: true });
  await expect(new StructuredDeliveryQueue(queuePort(first, "claim-a:1", true), () => new FakeEngineHost(delivery.ledger)).drain())
    .rejects.toThrow("the Viewer was replaced");
  const stuck = first.operationResult(delivery.operationId)!.receipt;
  expect(stuck.status).toBe("delivering");
  first.close();

  /* The successor Viewer runs a new executor. The structured host kept its
     writer claim across the release, so the claim still MATCHES and the
     successor correctly leaves the row to its owner — who is gone. */
  const journal = new RuntimeJournal(delivery.journalFile, { structuredHosts: true });
  await new StructuredDeliveryQueue(queuePort(journal, "claim-a:1"), () => new FakeEngineHost(delivery.ledger)).drain();
  expect(journal.operationResult(delivery.operationId)?.receipt.status).toBe("delivering");

  /* The tab reloads after the settlement window. The only thing that can end
     the row now is a read of the operation by id. */
  const admittedAt = stuck.admittedAt ?? stuck.at;
  seedStaleTab(delivery, admittedAt);
  const afterWindow = Date.parse(admittedAt) + 11 * 60_000;
  const requests = serveOperations((operationId) => handleRuntimeOperationQuery(operationId, {
    client: () => journalClient(journal),
    rolledBack: () => false,
    settle: (id, client) => resolveSendReceipt(id, { client, registry: delivery.registry, now: () => afterWindow }),
  }));
  const unmount = await mountComposer(delivery.conversationId);
  try {
    await waitFor(() => readOutbox(delivery.conversationId).find((entry) => entry.id === delivery.key)?.deliveryUncertain === true);

    expect(readOutbox(delivery.conversationId)[0]).toMatchObject({ id: delivery.key, state: "delivering", deliveryUncertain: true });
    expect(journal.operationResult(delivery.operationId)?.receipt.status).toBe("uncertain");
    // An unknown fate does not hold the wire: the queued message goes, once.
    await waitFor(() => readOutbox(delivery.conversationId)[1]?.state !== "queued");
    expect(readOutbox(delivery.conversationId)[1]).toMatchObject({ id: "second-key", state: "delivering" });
    expect(requests.filter((request) => request.method !== "GET" && request.body.includes("second-key")).length).toBeLessThanOrEqual(1);
    expect(touchesOperation(requests, delivery)).toEqual([]);
    expect(delivery.ledger.writes).toHaveLength(1);
  } finally {
    await unmount();
    journal.close();
  }
});

test("a delivered operation from another sender is not shown as unknown after a reload", async () => {
  /* A message sent from elsewhere (an agent, another device) whose last
     observation this tab kept was `uncertain`. Its receipt has left the tail,
     and its own record says delivered at revision 1. */
  const conversationId = "conversation-other-sender";
  const admittedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const uncertain: RuntimeReceipt = {
    operationId: "other-sender-operation",
    idempotencyKey: "other-sender-key",
    conversationId,
    kind: "send",
    status: "uncertain",
    reason: "delivery was started by an earlier executor; whether it reached the recipient is unverified",
    text: "coordination update",
    at: admittedAt,
    admittedAt,
    revision: 4,
  };
  sessionStorage.setItem(`llvRecoveryReceipts:${conversationId}`, JSON.stringify([uncertain]));
  const requests = serveOperations(async (operationId) => Response.json({
    operationId,
    receipt: { ...uncertain, status: "delivered", reason: null, resend: "not-needed", at: new Date(Date.parse(admittedAt) + 60_000).toISOString(), revision: 1 },
  }));
  const unknown = "The last attempt's outcome is unknown";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={composerFile(conversationId)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    await waitFor(() => !host.textContent?.includes(unknown));
    expect(host.textContent).not.toContain(unknown);
    expect(requests.filter((request) => request.method !== "GET" && request.url.includes(uncertain.operationId))).toEqual([]);
  } finally {
    await act(async () => root.unmount());
  }
});

/* The reads follow the hidden-traffic policy and are shared per operation. */
function seedStaleRow(conversationId: string): RuntimeReceipt {
  const admittedAt = new Date(Date.now() - 9 * 60 * 60_000).toISOString();
  const stale: RuntimeReceipt = {
    operationId: "gated-operation", idempotencyKey: "gated-key", conversationId, kind: "send",
    status: "delivering", reason: "delivering-owner:executor-a@claim-a:1", text: "gated", at: admittedAt, admittedAt, revision: 2,
  };
  sessionStorage.setItem(`llvOutbox:${conversationId}`, JSON.stringify([
    { id: stale.idempotencyKey, text: "gated", images: 0, at: Date.parse(admittedAt), state: "delivering", deliveryReceipt: stale, operationId: stale.operationId },
  ]));
  sessionStorage.setItem(`llvRecoveryReceipts:${conversationId}`, JSON.stringify([stale]));
  return stale;
}

function answerDelivered(stale: RuntimeReceipt): Recorded[] {
  return serveOperations(async (operationId) => Response.json({
    operationId,
    receipt: { ...stale, status: "delivered", reason: null, resend: "not-needed", at: new Date().toISOString(), revision: 1 },
  }));
}

const operationReads = (requests: Recorded[]) => requests.filter((request) => request.url.startsWith("/api/runtime/operations/"));

test("a hidden phone tab makes no operation read, and reads once it is shown again", async () => {
  const conversationId = "conversation-hidden-phone";
  const stale = seedStaleRow(conversationId);
  const requests = answerDelivered(stale);
  const matchMedia = (dom as unknown as { matchMedia: unknown }).matchMedia;
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
    matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {},
  });
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  const unmount = await mountComposer(conversationId);
  try {
    await waitFor(() => false);
    expect(operationReads(requests)).toEqual([]);
    expect(readOutbox(conversationId)[0]?.state).toBe("delivering");

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => { document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event); });
    await waitFor(() => readOutbox(conversationId)[0]?.state === "delivered");
    expect(operationReads(requests).map((request) => request.method)).toEqual(["GET"]);
  } finally {
    await unmount();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    (dom as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
  }
});

test("an inactive composer makes no operation read", async () => {
  const conversationId = "conversation-inactive";
  const stale = seedStaleRow(conversationId);
  const requests = answerDelivered(stale);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={composerFile(conversationId)} viewActive={false} pollPaused />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    await waitFor(() => false);
    expect(operationReads(requests)).toEqual([]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("two composers showing the same operation share one read", async () => {
  const conversationId = "conversation-two-mounts";
  const stale = seedStaleRow(conversationId);
  const requests = answerDelivered(stale);
  const first = await mountComposer(conversationId);
  const second = await mountComposer(conversationId);
  try {
    await waitFor(() => readOutbox(conversationId)[0]?.state === "delivered");
    expect(readOutbox(conversationId)[0]?.state).toBe("delivered");
    expect(operationReads(requests)).toEqual([{ method: "GET", url: `/api/runtime/operations/${stale.operationId}`, body: "" }]);
  } finally {
    await second();
    await first();
  }
});
