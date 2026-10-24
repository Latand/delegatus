import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, installSnapshot, type RuntimeSnapshot } from "@/components/runtime/runtimeModel";
import type { RuntimeBus, RuntimeBusState } from "@/hooks/runtimeBus";
import { setLocale } from "@/lib/i18n";
import { createFailedLegacyBufferProjection } from "@/lib/runtime/fixtures/failedLegacyBufferProjection";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost } from "@/lib/runtime/structuredDeliveryController";
import type { FileEntry } from "@/lib/types";
import { resetOrchestratorSeatCacheForTests } from "./orchestrator/useOrchestratorSeat";
import { enqueueOutbox, readOutbox, updateOutbox } from "./conversation/outbox";

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
});

afterAll(() => {
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

function mount(file: FileEntry): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(<BranchPane file={file} tasks={[]} isRoot />));
  return host;
}

test("an open phone conversation follows seat retirement without losing the draft or retrying its failed message", async () => {
  mobile = true;
  const file = liveLegacyFile({ conversationId: "conversation_previous", project: "viewer", engine: "claude" });
  let rotated = false;
  let posts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && /^\/api\/(?:tmux|runtime\/send|orchestrator\/message)(?:\?|$)/.test(url)) posts += 1;
    if (url.startsWith("/api/orchestrator/seat")) {
      const current = rotated ? "conversation_current" : file.conversationId;
      return Response.json({
        seat: { project: "viewer", conversationId: current, path: rotated ? "/fixtures/current.jsonl" : file.path,
          state: "active", seatEpoch: 2, mandate: "fixture", intent: { clientRequestId: "fixture", mode: "existing", launchId: null, error: null } },
        exists: true, viewerMcpRegistered: true,
        previous: rotated ? [{ conversationId: file.conversationId, path: file.path, heldTo: "2026-01-01T00:00:00Z" }] : [],
        all: { conversationIds: [current], paths: [rotated ? "/fixtures/current.jsonl" : file.path],
          previous: { conversationIds: rotated ? [file.conversationId] : [], paths: rotated ? [file.path] : [] } },
      });
    }
    return Response.json({});
  }) as typeof fetch;
  enqueueOutbox(file.conversationId!, { id: "retired-message", text: "Saved operator message", images: 0, at: Date.now() });
  updateOutbox(file.conversationId!, "retired-message", { state: "failed", error: "recipient replaced", settledAt: Date.now() });
  appendComposerDraft(file.conversationId!, "Unsent draft stays here");
  const host = mount(file);
  for (let i = 0; i < 20; i += 1) await Bun.sleep(5);
  expect(host.querySelector("[data-retired-orchestrator]")).toBeNull();
  rotated = true;
  document.dispatchEvent(new Event("visibilitychange"));
  for (let i = 0; i < 40 && !host.querySelector("[data-retired-orchestrator]"); i += 1) await Bun.sleep(5);
  const banner = host.querySelector("[data-retired-orchestrator]");
  expect(banner).not.toBeNull();
  expect(banner!.querySelector("a")?.getAttribute("href")).toBe("#c=conversation_current");
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("Unsent draft stays here");
  expect(host.querySelector('[data-testid="composer-send-blocked"] button')).toBeNull();
  const retry = host.querySelector("[data-outbox-retry=retired-message]") as HTMLButtonElement;
  expect(retry).not.toBeNull();
  expect(retry.disabled).toBeTrue();
  retry.click();
  expect(posts).toBe(0);
  expect(readOutbox(file.conversationId!).find(entry => entry.id === "retired-message")).toMatchObject({
    text: "Saved operator message", state: "failed",
  });
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
