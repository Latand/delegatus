import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";
import { createFeedSession, type FeedEntry } from "@/components/feed/parse";
import { resetLogTailCacheForTests, useLogTail } from "@/hooks/useLogTail";
import {
  createRuntimeBus,
  resetRuntimeBusForTests,
  setRuntimeBusForTests,
  setRuntimeUiEnabledForTests,
  type RuntimeBus,
} from "@/hooks/runtimeBus";
import { useRuntimeSessionForConversation } from "@/hooks/useRuntime";
import { normalizeRuntimeLiveTurn, runtimeLiveTurnItems } from "@/lib/runtime/liveTurn";
import type { FileEntry, LogChunk } from "@/lib/types";

import { LIVE_TURN_VISIBLE_ROWS, LiveTurnRows } from "./LiveTurnRows";
import { visibleRuntimeLiveTurnItems } from "./liveTurnHandoff";
import { LONG_TURN_CALLS, longTurnPrefix } from "./liveTurnLongTurn.fixture";

/**
 * WHY the wall of live rows appeared — driven through the transports that
 * produce it, not through a window handed to the component.
 *
 * The report came with a banner reading "Runtime degraded · polling", and the
 * first explanation offered for the stall was that transport. This file tests
 * that explanation rather than assuming it, and it does not hold:
 *
 *   - The two buses share nothing. `runtimeBus` polls `/api/runtime/snapshot`
 *     when its stream is down; `logBus` polls `/api/logs` when ITS stream is
 *     down. Neither pauses the other, and the transcript window keeps
 *     advancing on the polling fallback — proven below with the runtime bus
 *     held in `degraded` for the whole test. So the banner the report arrived
 *     with does not explain the stale window.
 *   - A tail that is paused does stall it, and the pause is an ordinary input
 *     rather than a failure: `LogFeed` passes `paused` to `useLogTail`, and a
 *     paused tail UNSUBSCRIBES from the log bus — by design, so the server
 *     stops re-reading bytes nobody is looking at. The runtime session hook has
 *     no such input: the live turn keeps being projected into the same store
 *     while the transcript that would retire its rows stands still. Every item
 *     projected in that gap is unclaimed, and before the bound they were all
 *     painted.
 *   - Resuming heals it: the tail re-subscribes, the bus kicks an immediate
 *     catch-up poll, and the claims land.
 *
 * What this file does NOT establish is where that `paused` comes from on a real
 * surface, because it hands the input to a pane of its own. `BranchPane` is what
 * decides it, from its own IntersectionObserver, and
 * `liveTurnPaneVisibility.dom.test.tsx` drives the mounted pane through that —
 * including the frame where the pane is back on screen and still holds the
 * window it had while it was away. Neither file claims the pane's pause is the
 * only way a window can fall behind its live turn.
 *
 * The bound in `LiveTurnRows` is what makes such a gap survivable however it
 * opened, so the last phases below also assert what the pane paints across it.
 */

const dom = new Window({ url: "http://localhost/" });
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  /* The log bus takes its SSE transport when the browser has one; without it
     it runs the polling fallback, which is the transport under test. */
  EventSource: undefined,
});

const CONVERSATION = "conversation-demo-9931";
const FILE = {
  path: "/workspace/demo/viewer/manager.jsonl",
  engine: "claude",
  fmt: "claude",
  cwd: "/workspace/demo/viewer",
} as FileEntry;

/* ---- the transcript, as bytes on the wire ------------------------------- */

/** What the transcript file holds right now. Only ever appended to. */
let served = "";
/** Requests the log bus has made for this pane. */
let logRequests = 0;
const realFetch = globalThis.fetch;

function serveTranscript(calls: number): void {
  const { lines } = longTurnPrefix(calls);
  const next = lines.map((line) => `${line}\n`).join("");
  if (!next.startsWith(served)) throw new Error("the transcript fixture is not append-only");
  served = next;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== "/api/logs") throw new Error(`unexpected request: ${String(input)}`);
  logRequests += 1;
  const { reqs } = JSON.parse(String(init?.body)) as { reqs: { id: string; path: string; offset: number }[] };
  const bytes = Buffer.from(served, "utf8");
  const chunks: Record<string, LogChunk> = {};
  for (const req of reqs) {
    if (req.path !== FILE.path) throw new Error(`unexpected transcript: ${req.path}`);
    const start = Math.min(req.offset, bytes.length);
    chunks[req.id] = { offset: bytes.length, start, size: bytes.length, data: bytes.subarray(start).toString("utf8") };
  }
  return Response.json({ chunks });
}) as typeof fetch;

/* ---- the runtime bus, on its own clock and its own transport ------------- */

/** The live turn the structured host has projected so far. */
let projected = 0;
let snapshotSeq = 1;
let snapshotPolls = 0;

/* The bus's timers are injected, so its ladder (reconnect → degrade → poll)
   runs on a clock this test advances rather than on real seconds. The log bus
   keeps the real ones: they are separate transports, and that is the point. */
let clock = 0;
let timerSeq = 0;
const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();

function schedule(fn: () => void, ms: number, every: number | null): number {
  const id = ++timerSeq;
  timers.set(id, { at: clock + ms, fn, every });
  return id;
}

/** Run every runtime-bus timer due within `ms`, oldest first. */
async function advanceBusClock(ms: number): Promise<void> {
  const target = clock + ms;
  for (;;) {
    let dueId: number | null = null;
    let due: { at: number; fn: () => void; every: number | null } | null = null;
    for (const [id, timer] of timers) {
      if (timer.at <= target && (!due || timer.at < due.at)) { dueId = id; due = timer; }
    }
    if (dueId === null || !due) break;
    clock = due.at;
    if (due.every === null) timers.delete(dueId);
    else due.at = clock + due.every;
    await act(async () => { due!.fn(); });
  }
  clock = target;
}

function snapshotBody() {
  const { items } = longTurnPrefix(projected);
  return {
    schemaVersion: 1,
    snapshotSeq,
    retentionFloorSeq: 0,
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 1,
    sessions: [{
      conversationId: CONVERSATION,
      artifactPath: FILE.path,
      host: "hosted",
      hostKind: "claude-code",
      turn: "running",
      revision: snapshotSeq,
      attentionIds: [],
      recentReceipts: [],
      liveTurn: normalizeRuntimeLiveTurn({ turnId: "turn-long", text: "", items }),
    }],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
  };
}

let bus: RuntimeBus | null = null;

/** The bus as the operator's banner had it: its stream never opens, so after
    the degrade window it settles into the ten-second snapshot poll and reports
    `degraded`. Nothing here touches the transcript's transport. */
async function startDegradedRuntimeBus(): Promise<void> {
  bus = createRuntimeBus({
    fetch: async () => { snapshotPolls += 1; return Response.json(snapshotBody()); },
    createEventSource: () => { throw new Error("no stream"); },
    now: () => clock,
    setTimeout: ((fn: () => void, ms: number) => schedule(fn, ms, null)) as never,
    clearTimeout: ((id: number) => { timers.delete(id); }) as never,
    setInterval: ((fn: () => void, ms: number) => schedule(fn, ms, ms)) as never,
    clearInterval: ((id: number) => { timers.delete(id); }) as never,
  });
  setRuntimeUiEnabledForTests(true);
  setRuntimeBusForTests(bus);
  await act(async () => { bus!.start(); });
  /* Its stream keeps failing; past the degrade window it drops to polling. */
  await advanceBusClock(30_000);
  expect(bus.getState().connection).toBe("degraded");
}

/** One more fallback snapshot poll, carrying whatever has been projected. */
async function pollRuntimeSnapshot(): Promise<void> {
  snapshotSeq += 1;
  await advanceBusClock(10_000);
}

/* ---- the pane ----------------------------------------------------------- */

function feedOf(lines: readonly string[]): FeedEntry[] {
  return createFeedSession({ engine: "claude", fmt: "claude", cwd: FILE.cwd, showSvc: false, lineFilter: "" })
    .feed([...lines], 0, true).items;
}

/** A pane as `LogFeed` wires one: the transcript tail gated by the pane's own
    paused input, the runtime session gated by nothing. */
function Pane({ paused }: { paused: boolean }) {
  const session = useRuntimeSessionForConversation(CONVERSATION, FILE.path)?.session ?? null;
  const tail = useLogTail(FILE, paused, 0);
  const feed = useMemo(() => feedOf(tail.lines), [tail.lines]);
  const items = visibleRuntimeLiveTurnItems(session?.liveTurn ?? null, feed, undefined, session?.turn ?? null);
  return (
    <div
      data-pane
      data-pane-lines={tail.lines.length}
      data-pane-projected={runtimeLiveTurnItems(session?.liveTurn ?? null).length}
      data-pane-unclaimed={items.length}
    >
      <LiveTurnRows items={items} />
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountPane(paused: boolean): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Pane paused={paused} />); });
}

async function setPaused(paused: boolean): Promise<void> {
  await act(async () => { root!.render(<Pane paused={paused} />); });
}

/** Let the log bus's own (real) timers run: its reconnect debounce, then its
    poll interval. Bounded by the bus's own constants, not by guesswork. */
async function letTranscriptPoll(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const reading = () => {
  const pane = host!.querySelector<HTMLElement>("[data-pane]")!;
  return {
    lines: Number(pane.dataset.paneLines),
    projected: Number(pane.dataset.paneProjected),
    unclaimed: Number(pane.dataset.paneUnclaimed),
    painted: pane.querySelectorAll("[data-live-turn]").length,
    collapsed: pane.querySelector("[data-live-turn-earlier]")?.getAttribute("data-live-turn-earlier") ?? null,
  };
};

beforeEach(() => {
  setLocale("en");
  served = "";
  logRequests = 0;
  projected = 0;
  snapshotSeq = 1;
  snapshotPolls = 0;
  clock = 0;
  timers.clear();
  resetLogTailCacheForTests();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host = null;
  document.body.replaceChildren();
  bus?.stop();
  bus = null;
  setRuntimeBusForTests(null);
  setRuntimeUiEnabledForTests(null);
  resetRuntimeBusForTests();
  globalThis.fetch = realFetch;
});

test(
  "a degraded runtime does not stall the transcript; a paused tail does, and the overlay stays bounded through it",
  async () => {
    await startDegradedRuntimeBus();

    /* (1) Twenty calls in, pane on screen. Both buses are polling. */
    projected = 20;
    serveTranscript(20);
    await mountPane(false);
    await letTranscriptPoll(500);
    await pollRuntimeSnapshot();

    const opened = reading();
    expect(opened.lines).toBeGreaterThan(0);
    expect(opened.projected).toBeGreaterThan(0);
    /* The window carries these calls, so nothing is left for the overlay. */
    expect(opened.unclaimed).toBe(0);
    expect(opened.painted).toBe(0);

    /* (2) The turn runs on, and the pane is still open. The transcript window
       advances on the polling fallback: this is hypothesis (a) as it was first
       stated — "degraded/polling stalls the feed" — and it is REFUTED. */
    projected = 40;
    serveTranscript(40);
    await pollRuntimeSnapshot();
    const pollsBefore = logRequests;
    await letTranscriptPoll(1_500);

    const polling = reading();
    expect(logRequests).toBeGreaterThan(pollsBefore);
    expect(polling.lines).toBeGreaterThan(opened.lines);
    expect(polling.projected).toBeGreaterThan(opened.projected);
    expect(polling.unclaimed).toBe(0);
    expect(polling.painted).toBe(0);
    expect(bus!.getState().connection).toBe("degraded");

    /* (3) The pane's tail is paused — the input `BranchPane` sets while a pane
       is dormant or offscreen. It unsubscribes, so the window freezes where it
       stood, while the runtime store keeps projecting into the same turn. */
    await setPaused(true);
    const requestsWhenPaused = logRequests;
    projected = LONG_TURN_CALLS;
    serveTranscript(LONG_TURN_CALLS);
    await pollRuntimeSnapshot();
    await letTranscriptPoll(1_500);

    const away = reading();
    /* Not one byte was asked for while the pane was away. */
    expect(logRequests).toBe(requestsWhenPaused);
    expect(away.lines).toBe(polling.lines);
    /* The live turn grew anyway: the runtime session hook takes no pause. */
    expect(away.projected).toBeGreaterThan(polling.projected);
    /* And every item projected into that gap is unclaimed — the wall, out of
       a pause alone, with both transports answering every request made. */
    expect(away.unclaimed).toBe(away.projected - polling.projected);
    expect(away.unclaimed).toBeGreaterThan(LIVE_TURN_VISIBLE_ROWS);

    /* What the operator actually sees of it is the bound: a readable tail and
       one counted line, whatever the window behind it is doing. */
    expect(away.painted).toBeLessThanOrEqual(LIVE_TURN_VISIBLE_ROWS);
    expect(away.painted).toBeGreaterThan(0);
    expect(Number(away.collapsed)).toBeGreaterThan(0);
    expect(Number(away.collapsed) + away.painted).toBe(away.unclaimed);

    /* (4) The pane comes back: the tail re-subscribes, the bus kicks an
       immediate catch-up poll, and the claims retire the overlay. */
    await setPaused(false);
    await letTranscriptPoll(500);

    const back = reading();
    expect(logRequests).toBeGreaterThan(requestsWhenPaused);
    expect(back.lines).toBeGreaterThan(away.lines);
    expect(back.unclaimed).toBe(0);
    expect(back.painted).toBe(0);
    expect(back.collapsed).toBeNull();
    expect(snapshotPolls).toBeGreaterThan(1);
  },
  30_000,
);
