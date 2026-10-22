import { describe, expect, test } from "bun:test";

import type { RuntimeSession } from "@/components/runtime/runtimeModel";
import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

import type { CueRequest } from "./cues";
import { AWAITING_REPLY_CAPACITY, AWAITING_REPLY_TTL_MS, createAwaitingReplies, createFleetCueWatcher } from "./fleetCues";

/*
 * S2 and S8 read the runtime stream (docs/design/sound-redesign.md §4.4).
 * The store hands over whole session maps; `updateSession` replaces only the
 * changed session object, so each step below does the same.
 */

type Sessions = Record<string, RuntimeSession>;

function session(id: string, over: Partial<RuntimeSession> = {}): RuntimeSession {
  return { conversationId: id, turn: "idle", activeTurnId: null, settledTurnId: null, lastTurnOutcome: null, liveTurn: null, ...over } as RuntimeSession;
}

function tool(itemId: string): RuntimeLiveTurnItem {
  return { itemId, text: "", phase: "streaming", startedAt: null, completedAt: null, tool: { name: "Bash", engine: "claude", status: "run", args: {} } };
}

function withTools(s: RuntimeSession, ids: string[]): RuntimeSession {
  return { ...s, turn: "running", activeTurnId: s.activeTurnId ?? "t1", liveTurn: { turnId: "t1", text: "", items: ids.map(tool) } };
}

function harness(live: string[] = []) {
  let clock = 1_000_000;
  const played: CueRequest[] = [];
  const liveFeeds = new Set(live);
  const awaiting = createAwaitingReplies(() => clock);
  const watcher = createFleetCueWatcher({ hasLiveFeed: (id) => liveFeeds.has(id), awaiting, play: (request) => void played.push(request) });
  let sessions: Sessions = {};
  const step = (change: (current: Sessions) => Sessions) => {
    sessions = change(sessions);
    watcher.observe(sessions);
  };
  return { played, liveFeeds, awaiting, watcher, step, advance: (ms: number) => { clock += ms; }, sessions: () => sessions };
}

describe("S2: agents working off screen", () => {
  test("the first store is the baseline: tools already there are silent", () => {
    const h = harness();
    h.step(() => ({ a: withTools(session("a"), ["x1", "x2"]) }));
    expect(h.played).toEqual([]);
  });

  test("a new tool item of a session with no live feed is distant typing, paced by the agents off screen", () => {
    const h = harness();
    h.step(() => ({ a: withTools(session("a"), []), b: withTools(session("b"), []), c: session("c") }));
    h.step((s) => ({ ...s, a: withTools(s.a!, ["x1"]) }));
    expect(h.played).toEqual([{ cue: "distant-typing", eventId: "distant:a:x1", agentsOffScreen: 2 }]);
  });

  test("a mounted pane scrolled out of view has no live feed, so it is heard as S2", () => {
    /* Pane registration is not the test: a board pane registers while mounted,
       on screen or not. Only a running feed counts. */
    const h = harness();
    h.step(() => ({ a: withTools(session("a"), []) }));
    h.step((s) => ({ ...s, a: withTools(s.a!, ["x1"]) }));
    expect(h.played.map((r) => r.cue)).toEqual(["distant-typing"]);
  });

  test("a session whose feed is live in this tab rings its own typing there, never S2", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: withTools(session("a"), []) }));
    h.step((s) => ({ ...s, a: withTools(s.a!, ["x1", "x2"]) }));
    expect(h.played).toEqual([]);
  });

  test("scrolling a pane back into view moves it from S2 to S1 at once", () => {
    const h = harness();
    h.step(() => ({ a: withTools(session("a"), []) }));
    h.step((s) => ({ ...s, a: withTools(s.a!, ["x1"]) }));
    h.liveFeeds.add("a");
    h.step((s) => ({ ...s, a: withTools(s.a!, ["x1", "x2"]) }));
    expect(h.played.map((r) => r.eventId)).toEqual(["distant:a:x1"]);
  });

  test("a tool item seen once never sounds again, whatever else changes", () => {
    const h = harness();
    h.step(() => ({ a: withTools(session("a"), []) }));
    h.step((s) => ({ ...s, a: withTools(s.a!, ["x1"]) }));
    h.step((s) => ({ ...s, a: { ...withTools(s.a!, ["x1"]), revision: 9 } }));
    expect(h.played).toHaveLength(1);
  });

  test("a session the tab never opened is heard too: the stream carries every session", () => {
    const h = harness();
    h.step(() => ({}));
    h.step(() => ({ fresh: withTools(session("fresh"), ["y1"]) }));
    expect(h.played.map((r) => r.eventId)).toEqual(["distant:fresh:y1"]);
  });

  test("prose items are not tool calls", () => {
    const h = harness();
    h.step(() => ({ a: withTools(session("a"), []) }));
    h.step((s) => ({ ...s, a: { ...s.a!, liveTurn: { turnId: "t1", text: "hi", items: [{ itemId: "p1", text: "hi", phase: "streaming", startedAt: null, completedAt: null }] } } }));
    expect(h.played).toEqual([]);
  });
});

describe("S8: the conversation this device wrote to has answered", () => {
  test("a send to a running turn: no S8 at the interrupt, S8 when the answering turn completes", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { turn: "running", activeTurnId: "t1", settledTurnId: "t0" }) }));
    h.awaiting.expect("a", { activeTurnId: "t1", settledTurnId: "t0" }, "interrupt-active");
    h.step((s) => ({ ...s, a: { ...s.a!, turn: "idle", activeTurnId: null, settledTurnId: "t1", lastTurnOutcome: "interrupted" } }));
    expect(h.played).toEqual([]);
    h.step((s) => ({ ...s, a: { ...s.a!, turn: "running", activeTurnId: "t2", settledTurnId: null } }));
    h.step((s) => ({ ...s, a: { ...s.a!, turn: "idle", activeTurnId: null, settledTurnId: "t2", lastTurnOutcome: "completed" } }));
    expect(h.played).toEqual([{ cue: "reply", eventId: "reply:a:t2" }]);
  });

  test("a later turn that is interrupted keeps the wait; the one after it answers", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { settledTurnId: "t0" }) }));
    h.awaiting.expect("a", { activeTurnId: null, settledTurnId: "t0" }, "interrupt-active");
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t1", lastTurnOutcome: "interrupted" } }));
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t2", lastTurnOutcome: "completed" } }));
    expect(h.played.map((r) => r.eventId)).toEqual(["reply:a:t2"]);
  });

  test("an error ends the wait silently", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { settledTurnId: "t0" }) }));
    h.awaiting.expect("a", { activeTurnId: null, settledTurnId: "t0" }, "interrupt-active");
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t1", lastTurnOutcome: "error" } }));
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t2", lastTurnOutcome: "completed" } }));
    expect(h.played).toEqual([]);
  });

  test("a refused send leaves no entry", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { settledTurnId: "t0" }) }));
    const cancel = h.awaiting.expect("a", { activeTurnId: null, settledTurnId: "t0" }, "interrupt-active");
    cancel();
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t1", lastTurnOutcome: "completed" } }));
    expect(h.played).toEqual([]);
  });

  test("a turn that starts and ends inside one notification still answers", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { settledTurnId: "t0" }) }));
    h.awaiting.expect("a", { activeTurnId: null, settledTurnId: "t0" }, "interrupt-active");
    /* No running snapshot in between: only the settled id moved. */
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t1", lastTurnOutcome: "completed" } }));
    expect(h.played.map((r) => r.eventId)).toEqual(["reply:a:t1"]);
  });

  test("a steer folded into the running turn answers when that turn completes", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { turn: "running", activeTurnId: "t1", settledTurnId: "t0" }) }));
    h.awaiting.expect("a", { activeTurnId: "t1", settledTurnId: "t0" }, "steer-if-active");
    h.step((s) => ({ ...s, a: { ...s.a!, turn: "idle", activeTurnId: null, settledTurnId: "t1", lastTurnOutcome: "completed" } }));
    expect(h.played.map((r) => r.eventId)).toEqual(["reply:a:t1"]);
  });

  test("the operator's own launch answers when its first turn completes", () => {
    const h = harness();
    h.step(() => ({}));
    h.awaiting.expect("new", { activeTurnId: null, settledTurnId: null }, "launch");
    h.step(() => ({ new: session("new", { turn: "running", activeTurnId: "t1" }) }));
    h.step((s) => ({ ...s, new: { ...s.new!, turn: "idle", activeTurnId: null, settledTurnId: "t1", lastTurnOutcome: "completed" } }));
    expect(h.played.map((r) => r.eventId)).toEqual(["reply:new:t1"]);
  });

  test("a seat's own tick ending in a conversation nobody wrote to is silent", () => {
    const h = harness(["seat"]);
    h.step(() => ({ seat: session("seat", { settledTurnId: "t0" }) }));
    h.step((s) => ({ ...s, seat: { ...s.seat!, settledTurnId: "t1", lastTurnOutcome: "completed" } }));
    expect(h.played).toEqual([]);
  });

  test("an answer plays once, then the wait is over", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { settledTurnId: "t0" }) }));
    h.awaiting.expect("a", { activeTurnId: null, settledTurnId: "t0" }, "interrupt-active");
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t1", lastTurnOutcome: "completed" } }));
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t2", lastTurnOutcome: "completed" } }));
    expect(h.played.map((r) => r.eventId)).toEqual(["reply:a:t1"]);
  });

  test("a wait is forgotten after 2 hours", () => {
    const h = harness(["a"]);
    h.step(() => ({ a: session("a", { settledTurnId: "t0" }) }));
    h.awaiting.expect("a", { activeTurnId: null, settledTurnId: "t0" }, "interrupt-active");
    h.advance(AWAITING_REPLY_TTL_MS + 1);
    h.step((s) => ({ ...s, a: { ...s.a!, settledTurnId: "t1", lastTurnOutcome: "completed" } }));
    expect(h.played).toEqual([]);
  });

  test("at most 64 conversations wait; the oldest is forgotten first", () => {
    const h = harness();
    h.step(() => ({}));
    for (let i = 0; i <= AWAITING_REPLY_CAPACITY; i++) {
      h.advance(1);
      h.awaiting.expect(`c${i}`, { activeTurnId: null, settledTurnId: null }, "launch");
    }
    h.step(() => ({
      c0: session("c0", { settledTurnId: "t", lastTurnOutcome: "completed" }),
      c1: session("c1", { settledTurnId: "t", lastTurnOutcome: "completed" }),
    }));
    expect(h.played.map((r) => r.eventId)).toEqual(["reply:c1:t"]);
  });
});
