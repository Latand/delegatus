/**
 * WHERE the stale transcript window comes from, driven through the pane that
 * decides it — `BranchPane`, mounted whole, with its real IntersectionObserver
 * wiring, its real `LogFeed`, and the real `useLogTail` subscription underneath.
 *
 * `liveTurnStallPath.dom.test.tsx` establishes what the two transports do: the
 * runtime bus and the log bus share nothing, and the transcript window keeps
 * advancing on its own polling fallback while the runtime is degraded. What it
 * cannot establish is how a window goes stale in front of an operator, because
 * it supplies `paused` to a pane of its own. That is this file's job, and the
 * answer is the pane's own visibility input:
 *
 *   - `BranchPane` starts every pane `offscreen` and waits for its
 *     IntersectionObserver to say otherwise, so a pane that has just mounted is
 *     paused before it is anything else;
 *   - an observer callback that reports no intersection pauses the tail, which
 *     unsubscribes from the log bus entirely — by design, so the server stops
 *     re-reading bytes nobody is looking at;
 *   - the runtime session has no such input, so the live turn keeps growing
 *     into the same store, and every item projected into that gap is unclaimed;
 *   - when the observer reports the pane back on screen, the pane paints
 *     BEFORE its tail can fetch anything: its window is still the one it had
 *     while it was away. That frame — on screen, stale window, full unclaimed
 *     live turn — is the one the overlay has to survive, and the bound is what
 *     makes it readable.
 *
 * What this does NOT claim: that the pane's pause is the only way a window can
 * fall behind its live turn. It is the one this pane produces by itself, with
 * every transport healthy, which is enough to fix the rendering at the bound.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";
import { emptyStore, installSnapshot, type RuntimeStore } from "@/components/runtime/runtimeModel";
import {
  resetRuntimeBusForTests,
  setRuntimeBusForTests,
  setRuntimeUiEnabledForTests,
  type RuntimeBus,
  type RuntimeBusState,
} from "@/hooks/runtimeBus";
import { resetLogTailCacheForTests } from "@/hooks/useLogTail";
import { normalizeRuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import type { FileEntry, LogChunk } from "@/lib/types";

import { LIVE_TURN_VISIBLE_ROWS } from "./LiveTurnRows";
import { LONG_TURN_CALLS, longTurnPrefix } from "./liveTurnLongTurn.fixture";

const dom = new Window({ url: "http://localhost/" });
installActEnv();

/** The pane's own visibility input, under the test's hand. Nothing here
    decides when a pane is away — `BranchPane` does, from these entries. */
class TestIntersectionObserver {
  static live = new Set<TestIntersectionObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
    TestIntersectionObserver.live.add(this);
  }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); TestIntersectionObserver.live.delete(this); }
  report(isIntersecting: boolean): void { this.callback([{ isIntersecting }]); }
}

Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: TestIntersectionObserver,
  /* No SSE here: the log bus runs its polling fallback, which is the transport
     a paused tail unsubscribes from. */
  EventSource: undefined,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const CONVERSATION = "conversation-demo-9931";
const FILE = {
  path: "/workspace/demo/viewer/manager.jsonl",
  root: "claude-projects",
  name: "manager.jsonl",
  project: "demo-viewer",
  title: "the manager seat",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  cwd: "/workspace/demo/viewer",
  conversationId: CONVERSATION,
  parent: null,
  mtime: Date.now() / 1000,
  size: 4096,
  activity: "live",
  proc: "running",
  pid: 4417,
} as unknown as FileEntry;

/* ---- the transcript file, and who asked for it --------------------------- */

let served = "";
let logRequests = 0;
const realFetch = globalThis.fetch;

function serveTranscript(calls: number): void {
  const { lines } = longTurnPrefix(calls);
  const next = lines.map((line) => `${line}\n`).join("");
  if (!next.startsWith(served)) throw new Error("the transcript fixture is not append-only");
  served = next;
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    /* Only the transcript transport is served. Everything else a mounted pane
       reaches for (TTS configuration, availability, capabilities) answers 404,
       so each consumer takes its own unconfigured path rather than a shape
       this test invented. */
    if (!url.startsWith("/api/logs")) return new Response("", { status: 404 });
    logRequests += 1;
    const { reqs } = JSON.parse(String(init?.body)) as { reqs: { id: string; path: string; offset: number }[] };
    const bytes = Buffer.from(served, "utf8");
    const chunks: Record<string, LogChunk> = {};
    for (const req of reqs) {
      const start = Math.min(req.offset, bytes.length);
      chunks[req.id] = { offset: bytes.length, start, size: bytes.length, data: bytes.subarray(start).toString("utf8") };
    }
    return Response.json({ chunks });
  }) as typeof fetch;
}

/* ---- the runtime store, which takes no pause ----------------------------- */

let store: RuntimeStore = emptyStore();
const runtimeListeners = new Set<() => void>();
const runtimeState = (): RuntimeBusState => ({
  store,
  connection: "live",
  resyncedAt: null,
  lastEventAt: Date.now(),
  enabled: true,
  structuredHostsEnabled: true,
});
const bus: RuntimeBus = {
  getState: runtimeState,
  subscribe: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener); },
  subscribeFilesRevision: () => () => {},
  start: () => {},
  stop: () => {},
  refresh: async () => true,
};

/** Project the turn's first `calls` calls into the store, as the structured
    host does while the turn runs — regardless of what any pane is doing. */
async function project(calls: number): Promise<void> {
  const { items } = longTurnPrefix(calls);
  store = installSnapshot({
    schemaVersion: 1,
    snapshotSeq: calls + 1,
    retentionFloorSeq: 0,
    structuredHostsEnabled: true,
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 1,
    sessions: [{
      conversationId: CONVERSATION,
      artifactPath: FILE.path,
      host: "hosted",
      hostKind: "claude-code",
      turn: "running",
      provenance: "structured",
      revision: calls + 1,
      attentionIds: [],
      recentReceipts: [],
      cwd: "demo-viewer",
      capabilities: { steer: true },
      activeTurnId: "turn-long",
      liveTurn: normalizeRuntimeLiveTurn({ turnId: "turn-long", text: "", items }),
    }],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  } as never);
  await act(async () => { for (const listener of runtimeListeners) listener(); });
}

/* ---- the pane ------------------------------------------------------------ */

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountPane(): Promise<void> {
  const { BranchPane } = await import("@/components/BranchPane");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<BranchPane file={FILE} tasks={[]} isRoot noComposer />); });
}

/** Every observer `BranchPane` opened for a mounted pane. */
function paneObservers(): TestIntersectionObserver[] {
  return [...TestIntersectionObserver.live].filter((observer) => observer.targets.size > 0);
}

/** The pane's visibility, as its own observer reports it. */
async function reportVisible(isIntersecting: boolean): Promise<void> {
  const observers = paneObservers();
  expect(observers.length).toBeGreaterThan(0);
  await act(async () => { for (const observer of observers) observer.report(isIntersecting); });
}

/** Let the log bus's own (real) timers run: reconnect debounce, then poll. */
async function letTranscriptPoll(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** What is on screen in the pane, and what the overlay was handed. */
const reading = () => {
  const pane = host!;
  const rows = pane.querySelectorAll("[data-live-turn]");
  const earlier = pane.querySelector("[data-live-turn-earlier]");
  return {
    /* Transcript rows the pane's own window produced. */
    canonical: pane.querySelectorAll("[data-tool-row], [data-testid=mcp-call-card]").length,
    painted: rows.length,
    collapsed: earlier ? Number(earlier.getAttribute("data-live-turn-earlier")) : 0,
    requests: logRequests,
  };
};

beforeEach(() => {
  setLocale("en");
  served = "";
  logRequests = 0;
  store = emptyStore();
  installFetch();
  setRuntimeUiEnabledForTests(true);
  setRuntimeBusForTests(bus);
  resetLogTailCacheForTests();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host = null;
  document.body.replaceChildren();
  TestIntersectionObserver.live.clear();
  runtimeListeners.clear();
  setRuntimeBusForTests(null);
  setRuntimeUiEnabledForTests(null);
  resetRuntimeBusForTests();
  resetLogTailCacheForTests();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
});

afterAll(() => dom.close());

test(
  "the pane's own visibility is what freezes its transcript window, and the overlay stays readable across it",
  async () => {
    /* (1) The turn is twenty calls in and the file carries all twenty. The
       pane mounts: `BranchPane` holds every pane offscreen until its observer
       says otherwise, so nothing has been fetched yet. */
    await project(20);
    serveTranscript(20);
    await mountPane();
    await letTranscriptPoll(400);

    const beforeFirstSight = reading();
    expect(beforeFirstSight.requests).toBe(0);
    expect(beforeFirstSight.canonical).toBe(0);

    /* (2) The observer reports the pane on screen. The tail subscribes, the
       window catches up, and the canonical rows claim every live row: the
       overlay paints nothing at all. */
    await reportVisible(true);
    await letTranscriptPoll(600);

    const onScreen = reading();
    expect(onScreen.requests).toBeGreaterThan(0);
    expect(onScreen.canonical).toBeGreaterThan(0);
    expect(onScreen.painted).toBe(0);
    expect(onScreen.collapsed).toBe(0);

    /* (3) The pane goes away — scrolled past the observer's 256 px margin, or
       zoomed out into the board's dormant band. Its tail unsubscribes, and the
       turn runs to its full sixty calls in the store regardless. */
    await reportVisible(false);
    const requestsWhenAway = logRequests;
    await project(LONG_TURN_CALLS);
    serveTranscript(LONG_TURN_CALLS);
    await letTranscriptPoll(1_200);

    const away = reading();
    /* Not one byte was asked for while the pane was away. */
    expect(away.requests).toBe(requestsWhenAway);
    expect(away.canonical).toBe(onScreen.canonical);

    /* (4) THE FRAME THE OPERATOR SEES. The observer reports the pane back on
       screen and React paints it before its tail can fetch anything, so the
       window is still the one it had while it was away while the live turn is
       the whole sixty calls. Everything projected into that gap is unclaimed —
       forty calls of it, five times the tail the overlay may paint — and this
       is where the wall was. What is on screen now is the bound: a readable
       tail, one counted line, and no third thing. */
    await reportVisible(true);

    const resumed = reading();
    expect(resumed.requests).toBe(requestsWhenAway);
    expect(resumed.canonical).toBe(onScreen.canonical);
    expect(resumed.painted).toBeGreaterThan(0);
    expect(resumed.painted).toBeLessThanOrEqual(LIVE_TURN_VISIBLE_ROWS);
    expect(resumed.collapsed).toBeGreaterThan(LIVE_TURN_VISIBLE_ROWS);
    /* The rows painted plus the rows counted are the whole unclaimed gap: the
       overlay hides nothing it does not count. */
    expect(resumed.painted + resumed.collapsed).toBeGreaterThanOrEqual(LONG_TURN_CALLS - 20);

    /* (5) A moment later the tail's catch-up lands, the canonical rows claim
       the calls, and the overlay retires itself. */
    await letTranscriptPoll(600);

    const caughtUp = reading();
    expect(caughtUp.requests).toBeGreaterThan(requestsWhenAway);
    expect(caughtUp.canonical).toBeGreaterThan(onScreen.canonical);
    expect(caughtUp.painted).toBe(0);
    expect(caughtUp.collapsed).toBe(0);
  },
  30_000,
);
