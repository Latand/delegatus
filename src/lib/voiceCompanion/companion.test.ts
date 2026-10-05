import { describe, expect, test } from "bun:test";

import type { CompanionEvent, Delivery, Payload, Recipient } from "./contract";
import { DEMO_IDS, demoScript } from "./demoScript";
import { defaultAnchor, findPlacement, intersectionArea, isFree, settlePlacement, type Rect } from "./placement";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CompanionState } from "./reducer";
import { createSimulatedCompanion, syntheticLevel, virtualClock } from "./simulator";

const RECIPIENT: Recipient = { project: "atlas", conversationId: "conversation_orchestrator", seatEpoch: 1, engine: "claude" };

/** The demo on virtual time, reduced as the window reduces it. */
function demo(locale: "en" | "uk" = "en") {
  const dispatched: Array<{ delivery: Delivery; instruction: string }> = [];
  const events: CompanionEvent[] = [];
  let state = INITIAL_COMPANION_STATE;
  const adapter = createSimulatedCompanion({
    script: demoScript(locale), recipient: RECIPIENT, clock: virtualClock(),
    dispatch: (delivery, instruction) => dispatched.push({ delivery, instruction }),
  });
  adapter.subscribe((event) => { events.push(event); state = reduceCompanion(state, event); });
  const until = async (done: () => boolean) => {
    for (let turn = 0; turn < 500 && !done(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done()).toBe(true);
  };
  return { adapter, dispatched, events, state: () => state, until };
}

const types = (events: readonly CompanionEvent[]) => events.map((event) => event.type);

describe("the simulated companion delegates only on an explicit, confirmed request", () => {
  for (const locale of ["en", "uk"] as const) {
    test(`${locale}: the greeting and the idea discussion reach no tool, and nothing is sent before the confirmation`, async () => {
      const run = demo(locale);
      await run.adapter.start({ locale, project: "atlas" });
      await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
      const proposed = run.events.findIndex((event) => event.type === "delegation.tool.called");
      const ask = run.events.findIndex((event) => event.type === "transcript.final" && event.speaker === "operator" && event.itemId === DEMO_IDS.askItem);
      /* Two operator turns and two answers came first, with no delegation event among them. */
      expect(types(run.events.slice(0, ask)).filter((type) => type.startsWith("delegation.") || type === "orchestrator.answer")).toEqual([]);
      expect(run.events.slice(0, ask).filter((event) => event.type === "transcript.final").length).toBe(4);
      expect(proposed).toBeGreaterThan(ask);
      /* The proposal is on screen and the read-back has played: still zero sends. */
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(run.dispatched).toEqual([]);
      expect(types(run.events)).not.toContain("delegation.tool.result");
      await run.adapter.close();
    });
  }

  test("send delivers exactly once, to the frozen recipient, and the answer joins that delivery", async () => {
    const run = demo();
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    const proposalId = run.state().delegation!.proposal!.proposalId;
    await run.adapter.command({ type: "confirmation", proposalId, decision: "send", via: "tap" });
    /* A second tap and a late cancel change nothing. */
    await run.adapter.command({ type: "confirmation", proposalId, decision: "send", via: "tap" });
    await run.adapter.command({ type: "confirmation", proposalId, decision: "cancel", via: "tap" });
    await run.adapter.finished;
    expect(run.dispatched.length).toBe(1);
    expect(run.dispatched[0]!.delivery).toEqual({ proposalId, callId: DEMO_IDS.callId, clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, recipient: RECIPIENT });
    const order = types(run.events).filter((type) => type.startsWith("delegation.") || type === "orchestrator.answer");
    expect(order).toEqual(["delegation.tool.called", "delegation.confirmation.required", "delegation.confirmed", "delegation.tool.result", "delegation.delivery.settled", "orchestrator.answer"]);
    expect(run.state().delegation?.stage).toBe("answered");
    expect(run.state().delegation?.answer?.reportId).toBe(DEMO_IDS.reportId);
    expect(run.state().phase).toBe("idle");
    expect(run.state().lines.at(-1)?.speaker).toBe("companion");
  });

  test("cancel sends nothing and says so", async () => {
    const run = demo();
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "cancel", via: "tap" });
    await run.adapter.finished;
    expect(run.dispatched).toEqual([]);
    expect(run.state().delegation?.stage).toBe("cancelled");
    expect(types(run.events)).not.toContain("orchestrator.answer");
    expect(run.state().lines.at(-1)?.text).toBe("Okay, nothing was sent.");
  });

  test("a confirmation for another proposal is ignored, and closing mid-proposal sends nothing", async () => {
    const run = demo();
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.command({ type: "confirmation", proposalId: "proposal_forged", decision: "send", via: "tap" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.state().delegation?.stage).toBe("awaiting-confirmation");
    await run.adapter.close();
    await run.adapter.close();
    await run.adapter.finished;
    expect(run.dispatched).toEqual([]);
    expect(run.state().phase).toBe("offline");
    expect(run.events.filter((event) => event.type === "session.closed").length).toBe(1);
  });

  test("an ended conversation starts again under the next generation, and the unanswered proposal is gone", async () => {
    const run = demo();
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.close();
    await run.adapter.finished;
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
    const before = run.events.length;
    await run.adapter.start({ locale: "en", project: "atlas" });
    expect(run.events[before]).toMatchObject({ type: "session.ready", generation: 2, seq: 0 });
    expect(run.state().generation).toBe(2);
    expect(run.state().phase).not.toBe("offline");
    /* The proposal of the ended session carries no authority into the new one. */
    expect(run.state().delegation).toBeNull();
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    expect(run.dispatched).toEqual([]);
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
    await run.adapter.finished;
    expect(run.dispatched.length).toBe(1);
    expect(new Set(run.events.map((event) => event.eventId)).size).toBe(run.events.length);
  });

  test("events are ordered, unique and carry bounded mouth levels", async () => {
    const run = demo();
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
    await run.adapter.finished;
    expect(run.events.map((event) => event.seq)).toEqual(run.events.map((_, index) => index));
    expect(new Set(run.events.map((event) => event.eventId)).size).toBe(run.events.length);
    const levels = run.events.filter((event) => event.type === "playback.level");
    expect(levels.length).toBeGreaterThan(200);
    for (const level of levels) if (level.type === "playback.level") { expect(level.rms).toBeGreaterThanOrEqual(0); expect(level.rms).toBeLessThanOrEqual(1); }
    for (let index = 1; index < run.events.length; index += 1) expect(run.events[index]!.atMs).toBeGreaterThanOrEqual(run.events[index - 1]!.atMs);
    expect(syntheticLevel("a b", 0)).toBeGreaterThan(syntheticLevel("a b", 60));
  });
});

describe("the reducer", () => {
  let seq = 0;
  const at = (payload: Payload, over: Partial<CompanionEvent> = {}): CompanionEvent => {
    seq += 1;
    return { ...payload, version: 1, sessionId: "s", generation: 1, eventId: `e${seq}`, seq, atMs: seq, ...over } as CompanionEvent;
  };
  const run = (events: CompanionEvent[], from: CompanionState = INITIAL_COMPANION_STATE) => events.reduce(reduceCompanion, from);
  const delivery: Delivery = { proposalId: "p1", callId: "c1", clientMessageId: "m1", operationId: "o1", recipient: RECIPIENT };
  const delegated = () => run([
    at({ type: "session.ready", mode: "simulated" }),
    at({ type: "delegation.tool.called", callId: "c1", sourceItemId: "i1", instruction: "Review the plan" }),
    at({ type: "delegation.confirmation.required", proposal: { proposalId: "p1", callId: "c1", sourceItemId: "i1", instruction: "Review the plan", recipient: RECIPIENT } }),
    at({ type: "delegation.confirmed", proposalId: "p1", via: "tap" }),
    at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery } }),
  ]);

  test("a duplicate event and an event of a retired generation change nothing", () => {
    const ready = at({ type: "session.ready", mode: "simulated" });
    const delta = at({ type: "transcript.delta", speaker: "companion", itemId: "i", delta: "Hello" });
    const state = run([ready, delta, delta]);
    expect(state.lines.map((line) => line.text)).toEqual(["Hello"]);
    const next = reduceCompanion(state, at({ type: "session.ready", mode: "simulated" }, { generation: 2 }));
    expect(next.generation).toBe(2);
    expect(reduceCompanion(next, at({ type: "transcript.delta", speaker: "companion", itemId: "late", delta: "late" }, { generation: 1 }))).toBe(next);
    /* A provisional line does not survive the reconnect. */
    expect(next.lines).toEqual([]);
  });

  test("a final replaces the provisional text, per speaker and item", () => {
    const state = run([
      at({ type: "transcript.delta", speaker: "operator", itemId: "i", delta: "Ask the " }),
      at({ type: "transcript.delta", speaker: "companion", itemId: "i", delta: "Sure" }),
      at({ type: "transcript.delta", speaker: "operator", itemId: "i", delta: "orkestrator" }),
      at({ type: "transcript.final", speaker: "operator", itemId: "i", text: "Ask the orchestrator." }),
      at({ type: "transcript.delta", speaker: "operator", itemId: "i", delta: " stray" }),
    ]);
    expect(state.lines).toEqual([
      { key: "operator:i", speaker: "operator", text: "Ask the orchestrator.", final: true, interrupted: false },
      { key: "companion:i", speaker: "companion", text: "Sure", final: false, interrupted: false },
    ]);
  });

  test("the mouth follows playback past the end of generation, and a level is clamped", () => {
    const speaking = run([
      at({ type: "session.ready", mode: "simulated" }),
      at({ type: "response.started", responseId: "r", itemId: "i" }),
      at({ type: "playback.started", responseId: "r", itemId: "i" }),
      at({ type: "playback.level", responseId: "r", itemId: "i", rms: 7, playedMs: 10 }),
      at({ type: "response.generated", responseId: "r", status: "completed" }),
    ]);
    expect(speaking.phase).toBe("speaking");
    expect(speaking.mouth).toBe(1);
    /* A level for a response that is not playing moves nothing. */
    expect(reduceCompanion(speaking, at({ type: "playback.level", responseId: "other", itemId: "i", rms: 0.2, playedMs: 20 }))).toBe(speaking);
    const stopped = reduceCompanion(speaking, at({ type: "playback.stopped", responseId: "r", itemId: "i", playedMs: 900, reason: "ended" }));
    expect(stopped.phase).toBe("idle");
    expect(stopped.mouth).toBe(0);
    /* A level sample does not count as a visible change. */
    expect(run([at({ type: "playback.level", responseId: "r", itemId: "i", rms: 0.4, playedMs: 30 })], speaking).revision).toBe(speaking.revision);
  });

  test("the operator speaking over the companion stops the mouth and marks the line partial; delivered work stays", () => {
    const state = run([
      at({ type: "playback.started", responseId: "r", itemId: "i" }),
      at({ type: "transcript.delta", speaker: "companion", itemId: "i", delta: "Sent. I'll tell" }),
      at({ type: "playback.level", responseId: "r", itemId: "i", rms: 0.6, playedMs: 10 }),
      at({ type: "input.speech.started", itemId: "op" }),
      at({ type: "transcript.final", speaker: "companion", itemId: "i", text: "Sent. I'll tell you when it answers." }),
    ], delegated());
    expect(state.phase).toBe("listening");
    expect(state.mouth).toBe(0);
    expect(state.lines.at(-1)).toEqual({ key: "companion:i", speaker: "companion", text: "Sent. I'll tell", final: true, interrupted: true });
    expect(state.delegation?.stage).toBe("queued");
  });

  test("a tool call alone delivers nothing: a result without a confirmation is ignored", () => {
    const state = run([
      at({ type: "delegation.tool.called", callId: "c1", sourceItemId: "i1", instruction: "Review the plan" }),
      at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "delivered", delivery } }),
      at({ type: "delegation.confirmed", proposalId: "p1", via: "speech" }),
    ]);
    expect(state.delegation?.stage).toBe("proposed");
    expect(state.delegation?.delivery).toBeNull();
  });

  test("only the answer that joins the confirmed delivery is an answer, once", () => {
    const base = delegated();
    const stranger = reduceCompanion(base, at({ type: "orchestrator.answer", delivery: { ...delivery, clientMessageId: "other" }, reportId: "r0", status: "result", text: "unrelated" }));
    expect(stranger.delegation?.stage).toBe("queued");
    expect(stranger.lines).toEqual([]);
    const answered = run([
      at({ type: "delegation.delivery.settled", delivery, status: "delivered" }),
      at({ type: "orchestrator.answer", delivery, reportId: "r1", status: "result", text: "The plan holds." }),
      at({ type: "orchestrator.answer", delivery, reportId: "r1", status: "result", text: "The plan holds, again." }),
      at({ type: "delegation.tool.result", callId: "c1", result: { status: "cancelled", code: "late" } }),
    ], base);
    expect(answered.delegation?.stage).toBe("answered");
    expect(answered.lines.map((line) => [line.speaker, line.text])).toEqual([["orchestrator", "The plan holds."]]);
  });

  test("a malformed event is dropped", () => {
    const bad = { ...at({ type: "session.ready", mode: "simulated" }), seq: -1 };
    expect(reduceCompanion(INITIAL_COMPANION_STATE, bad)).toBe(INITIAL_COMPANION_STATE);
    expect(reduceCompanion(INITIAL_COMPANION_STATE, { ...at({ type: "session.ready", mode: "simulated" }), atMs: Number.NaN })).toBe(INITIAL_COMPANION_STATE);
  });
});

describe("placement: the window covers no control", () => {
  const viewport = { width: 1440, height: 900 };
  const size = { width: 304, height: 300 };
  const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

  test("an empty page keeps the bottom-right corner", () => {
    const desired = defaultAnchor(viewport, size);
    expect(findPlacement({ viewport, size, obstacles: [], desired })).toEqual({ x: 1120, y: 584 });
  });

  test("a control in the corner moves the window to the nearest free rectangle, with clearance", () => {
    const obstacles = [rect(1300, 800, 100, 40)];
    const placed = findPlacement({ viewport, size, obstacles, desired: defaultAnchor(viewport, size) })!;
    expect(isFree({ ...placed, ...size }, obstacles)).toBe(true);
    expect(intersectionArea({ ...placed, ...size }, obstacles[0]!)).toBe(0);
    expect(placed.y + size.height).toBeLessThanOrEqual(800 - 8);
    expect(placed.x).toBe(1120);
  });

  test("a page with no free rectangle docks the window; a small shape still floats", () => {
    const grid: Rect[] = [];
    for (let x = 0; x < 1440; x += 120) for (let y = 0; y < 900; y += 120) grid.push(rect(x + 20, y + 20, 30, 30));
    expect(settlePlacement({ viewport, size, obstacles: grid, desired: defaultAnchor(viewport, size) })).toEqual({ mode: "dock" });
    const shape = { width: 60, height: 60 };
    const placed = settlePlacement({ viewport, size: shape, obstacles: grid, desired: defaultAnchor(viewport, shape) });
    expect(placed.mode).toBe("float");
    if (placed.mode === "float") expect(isFree({ ...placed.at, ...shape }, grid)).toBe(true);
  });

  test("a window wider than the viewport has nowhere to float", () => {
    expect(findPlacement({ viewport: { width: 280, height: 500 }, size, obstacles: [], desired: { x: 0, y: 0 } })).toBeNull();
  });
});
