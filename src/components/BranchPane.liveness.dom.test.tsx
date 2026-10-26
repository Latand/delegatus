import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, installSnapshot, type RuntimeSnapshot } from "@/components/runtime/runtimeModel";
import type { RuntimeBus, RuntimeBusState } from "@/hooks/runtimeBus";
import { setLocale, translate } from "@/lib/i18n";
import { createFailedLegacyBufferProjection } from "@/lib/runtime/fixtures/failedLegacyBufferProjection";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost } from "@/lib/runtime/structuredDeliveryController";
import type { FileEntry } from "@/lib/types";
import { resetOrchestratorSeatCacheForTests } from "./orchestrator/useOrchestratorSeat";
import { cancelOutbox, enqueueOutbox, readOutbox, updateOutbox } from "./conversation/outbox";
import { messageRowRecovery } from "./conversation/rowRecovery";
import { composerSubmissionPayloads } from "@/lib/composerSubmissionPayloads";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/" });
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
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
});
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile && query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

function inertRuntimeState(): RuntimeBusState {
  return {
    store: emptyStore(),
    connection: "offline",
    resyncedAt: null,
    lastEventAt: null,
    enabled: false,
    structuredHostsEnabled: false,
  };
}

let runtimeState = inertRuntimeState();
const runtimeBus: RuntimeBus = {
  getState: () => runtimeState,
  subscribe: () => () => {},
  subscribeFilesRevision: () => () => {},
  start: () => {},
  stop: () => {},
  refresh: async () => true,
};

const actualRuntimeBus = await import("@/hooks/runtimeBus");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/runtimeBus", () => ({
  ...actualRuntimeBus,
  getRuntimeBus: () => runtimeBus,
  isRuntimeUiEnabled: () => true,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [],
    linesStart: 0,
    size: 0,
    loading: false,
    error: null,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));

const { BranchPane } = await import("./BranchPane");
const { appendComposerDraft } = await import("./TmuxComposer");
const originalFetch = globalThis.fetch;
const composerStorage = installComposerStorageForTests();

const roots = new Set<Root>();

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  await bindStructuredDeliveryQueue([], { client: null });
  runtimeState = inertRuntimeState();
  setLocale("en");
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOrchestratorSeatCacheForTests();
  globalThis.fetch = originalFetch;
  mobile = false;
  composerStorage.reset();
});

afterAll(() => {
  composerStorage.uninstall();
  mock.module("@/hooks/runtimeBus", () => actualRuntimeBus);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  dom.close();
});

function liveLegacyFile(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/conversations/live-legacy.jsonl",
    root: "codex-sessions",
    name: "live-legacy.jsonl",
    project: "viewer",
    title: "live legacy turn",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: Date.now() / 1000,
    size: 512,
    activity: "live",
    activityReason: "jsonl_turn_open",
    proc: "running",
    pid: 203,
    lastTurn: { startedAt: Date.now() - 60_000, endedAt: null },
    model: "gpt",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

/** Waits on an observed condition; the deadline only bounds a failure. */
async function waitFor(what: string, condition: () => boolean, deadlineMs = 10_000): Promise<void> {
  const until = performance.now() + deadlineMs;
  while (!condition()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

/** One macrotask turn lets state set by an already-consumed response render. */
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function mount(file: FileEntry): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(<BranchPane file={file} tasks={[]} isRoot />));
  return host;
}

for (const detailState of ["current", "failed", "empty", "older-than-page"] as const) test(`an open phone conversation retains retired-send fences and payloads (${detailState})`, async () => {
  mobile = true;
  const detailReadFails = detailState === "failed" || detailState === "empty";
  const file = liveLegacyFile({ conversationId: `conversation_previous_${detailState}`, project: `viewer-${detailState}`, engine: "claude" });
  let rotated = false;
  const posts: string[] = [];
  let detailedReads = 0;
  const answered = { all: 0, detail: 0 };
  const answer = async (body: unknown, kind: "all" | "detail", status = 200): Promise<Response> => {
    const response = Response.json(body, { status });
    const json = response.json.bind(response);
    // Counted once the caller has consumed the body, so a count means "read".
    response.json = async () => { const value = await json(); answered[kind] += 1; return value; };
    return response;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && (/^\/api\/(?:tmux|runtime\/send|orchestrator\/message)(?:\?|$)/.test(url)
      || /^\/api\/runtime\/operations\/[^/]+(?:\?|$)/.test(url))) posts.push(url);
    if (url.startsWith("/api/orchestrator/seat")) {
      const kind = url.includes("scope=all") ? "all" : "detail";
      if (rotated && kind === "detail") detailedReads += 1;
      if (rotated && detailState === "failed" && kind === "detail") return answer({ error: "temporarily unavailable" }, kind, 503);
      if (rotated && detailState === "empty" && kind === "detail") return answer({ seat: null, exists: false }, kind);
      const current = rotated ? "conversation_current" : file.conversationId;
      return answer({
        seat: { project: file.project, conversationId: current, path: rotated ? "/fixtures/current.jsonl" : file.path,
          state: "active", seatEpoch: 2, mandate: "fixture", intent: { clientRequestId: "fixture", mode: "existing", launchId: null, error: null } },
        exists: true, viewerMcpRegistered: true,
        previous: rotated && detailState !== "older-than-page"
          ? [{ conversationId: file.conversationId, path: file.path, heldTo: "2026-01-01T00:00:00Z" }] : [],
        all: { conversationIds: [current], paths: [rotated ? "/fixtures/current.jsonl" : file.path],
          previous: { conversationIds: rotated ? [file.conversationId] : [], paths: rotated ? [file.path] : [] } },
      }, kind);
    }
    return Response.json({});
  }) as typeof fetch;
  enqueueOutbox(file.conversationId!, { id: "retired-message", text: "Saved operator message", images: 0, at: Date.now() });
  updateOutbox(file.conversationId!, "retired-message", { state: "failed", error: "recipient replaced", settledAt: Date.now() });
  const retained = await composerSubmissionPayloads.retain({ conversationId: file.conversationId!, key: "retained-message" }, {
    text: "Retained operator payload", images: [], files: [],
  });
  await composerSubmissionPayloads.seal(retained, { route: "runtime", body: { conversationId: file.conversationId, text: "Retained operator payload", idempotencyKey: "retained-message" } });
  expect(await composerSubmissionPayloads.beginAttempt(retained)).toBeTrue();
  expect(composerSubmissionPayloads.consumeAttempt(retained)).toBeTrue();
  expect(await composerSubmissionPayloads.observe(retained, {
    conversationId: file.conversationId!, idempotencyKey: "retained-message", operationId: "retained-operation", revision: 1,
    status: "failed", resend: "safe", at: new Date().toISOString(),
  })).toBeTrue();
  appendComposerDraft(file.conversationId!, "Unsent draft stays here");
  const host = mount(file);
  await waitFor("the first scope=all read", () => answered.all >= 1);
  await nextTurn();
  expect(host.querySelector("[data-retired-orchestrator]")).toBeNull();
  rotated = true;
  const readsBefore = answered.all;
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor("a scope=all read after rotation", () => answered.all > readsBefore);
  await waitFor("the detailed seat read", () => detailedReads > 0 && answered.detail >= 1);
  await waitFor("the retired banner", () => Boolean(host.querySelector("[data-retired-orchestrator]")));
  if (!detailReadFails) await waitFor("the successor link", () => Boolean(host.querySelector("[data-retired-orchestrator] a")));
  const banner = host.querySelector("[data-retired-orchestrator]");
  expect(banner).not.toBeNull();
  expect(banner!.querySelector("a")?.getAttribute("href") ?? null).toBe(detailReadFails ? null : "#c=conversation_current");
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("Unsent draft stays here");
  expect(host.querySelector('[data-testid="composer-send-blocked"] button')).toBeNull();
  const retry = host.querySelector("[data-outbox-retry=retired-message]") as HTMLButtonElement;
  expect(retry).not.toBeNull();
  expect(retry.disabled).toBeTrue();
  retry.click();
  const payloadRetry = host.querySelector("[data-payload-retry]") as HTMLButtonElement;
  expect(payloadRetry).not.toBeNull();
  expect(payloadRetry.disabled).toBeTrue();
  payloadRetry.click();
  expect(messageRowRecovery(file.conversationId!)?.retryOperation).toBeDefined();
  messageRowRecovery(file.conversationId!)!.retryOperation!("retained-message");
  await waitFor("the refusal status", () => host.querySelector('[data-testid="composer-status"]')?.textContent === translate("en", "retiredOrchestrator.sendBlocked"));
  expect(posts).toEqual([]);
  expect((await composerSubmissionPayloads.restore(retained))?.receipt?.status).toBe("failed");
  expect(readOutbox(file.conversationId!).find(entry => entry.id === "retired-message")).toMatchObject({
    text: "Saved operator message", state: "failed",
  });
});

for (const entryArrives of ["before the banner", "after the banner"] as const) test(`a message queued ${entryArrives} for a retired orchestrator stays queued and cancellable`, async () => {
  mobile = true;
  const file = liveLegacyFile({ conversationId: "conversation_previous_queued", project: "viewer-queued", engine: "claude" });
  const posts: string[] = [];
  let answeredAll = 0;
  let answeredDetail = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && /^\/api\/(?:tmux|runtime\/send|orchestrator\/message)(?:\?|$)/.test(url)) posts.push(url);
    if (!url.startsWith("/api/orchestrator/seat")) return Response.json({});
    const kind = url.includes("scope=all") ? "all" : "detail";
    const response = Response.json({
      seat: { project: file.project, conversationId: "conversation_current", path: "/fixtures/current.jsonl",
        state: "active", seatEpoch: 2, mandate: "fixture", intent: { clientRequestId: "fixture", mode: "existing", launchId: null, error: null } },
      exists: true, viewerMcpRegistered: true,
      previous: [{ conversationId: file.conversationId, path: file.path, heldTo: "2026-01-01T00:00:00Z" }],
      all: { conversationIds: ["conversation_current"], paths: ["/fixtures/current.jsonl"],
        previous: { conversationIds: [file.conversationId], paths: [file.path] } },
    });
    const json = response.json.bind(response);
    response.json = async () => { const value = await json(); if (kind === "all") answeredAll += 1; else answeredDetail += 1; return value; };
    return response;
  }) as typeof fetch;
  const id = file.conversationId!;
  const enqueue = () => enqueueOutbox(id, { id: "queued-message", text: "Queued before the seat rotated", images: 0, at: Date.now() });
  if (entryArrives === "before the banner") enqueue();
  const host = mount(file);
  await waitFor("the retired banner with its successor link", () => answeredAll >= 1 && answeredDetail >= 1
    && Boolean(host.querySelector("[data-retired-orchestrator] a")));
  if (entryArrives === "after the banner") enqueue();
  await waitFor("the queued message row", () => host.textContent?.includes("Queued before the seat rotated") === true);
  await nextTurn();
  expect(readOutbox(id).find(entry => entry.id === "queued-message")?.state).toBe("queued");
  expect(posts).toEqual([]);
  cancelOutbox(id, "queued-message");
  expect(readOutbox(id).find(entry => entry.id === "queued-message")).toBeUndefined();
});

function installRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  runtimeState = {
    store: installSnapshot(snapshot),
    connection: "live",
    resyncedAt: null,
    lastEventAt: Date.now(),
    enabled: true,
    structuredHostsEnabled: snapshot.structuredHostsEnabled === true,
  };
}

function deadProjectionSnapshot(conversationId: string): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    structuredHostsEnabled: true,
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 1,
    sessions: [{
      conversationId,
      sessionKey: { engine: "codex", sessionId: `${conversationId}-session` },
      hostKind: "codex-app-server",
      host: "dead",
      turn: "unknown",
      provenance: "structured",
      revision: 1,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "viewer",
      artifactPath: "/conversations/conflicting.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    }],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  };
}

test("a failed legacy pane-buffer probe reaches BranchPane as one live running verdict", async () => {
  const fixture = await createFailedLegacyBufferProjection();
  try {
    expect(fixture.failedDelivery).toMatchObject({
      ok: false,
      outcome: "failed",
      error: "Pane buffer unreadable — message was not sent.",
    });
    for (const rawIdentifier of fixture.rawIdentifiers) {
      expect(JSON.stringify(fixture.failedDelivery)).not.toContain(rawIdentifier);
    }
    expect(fixture.snapshot.sessions.filter((session) => session.conversationId === fixture.conversationId)).toHaveLength(1);
    expect(fixture.snapshot.sessions.find((session) => session.conversationId === fixture.conversationId)).toMatchObject({
      hostKind: "tmux-legacy",
      host: "hosted",
      turn: "running",
      provenance: "derived",
    });
    expect(hasStructuredDeliveryHost(fixture.key)).toBeFalse();

    installRuntimeSnapshot(fixture.snapshot);
    const host = mount(liveLegacyFile({ conversationId: fixture.conversationId }));
    expect(host.querySelectorAll('[data-card-status="running"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-strip-surface="live-root"]')).toHaveLength(1);
    expect(host.querySelector("[data-dead-host-banner]")).toBeNull();
    expect(host.querySelector('[data-strip-surface="dead"]')).toBeNull();
    expect(host.textContent).not.toContain("Respawn conversation");
    expect(host.textContent).not.toContain("Drafted images will be sent after the host recovers");
    for (const rawIdentifier of fixture.rawIdentifiers) {
      expect(host.innerHTML).not.toContain(rawIdentifier);
    }
  } finally {
    await fixture.dispose();
  }
});

test.each([
  ["live host", "conversation_conflicting_live_process", { activity: "idle", lastTurn: { startedAt: 1_000, endedAt: 2_000 } }],
  ["open turn", "conversation_conflicting_open_turn", { proc: null, pid: null }],
] as const)("conflicting dead projection stays fail closed on %s evidence alone", (_evidence, conversationId, overrides) => {
  installRuntimeSnapshot(deadProjectionSnapshot(conversationId));
  const host = mount(liveLegacyFile({ conversationId, ...overrides }));

  expect(host.querySelector("[data-dead-host-banner]")).toBeNull();
  expect(host.textContent).not.toContain("Respawn conversation");
});
