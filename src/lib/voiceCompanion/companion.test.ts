import { describe, expect, test } from "bun:test";

import type { CompanionEvent, Delivery, Payload, Recipient } from "./contract";
import { admitDelegationProposal, explicitDelegationRequest } from "./gate";
import { BUBBLE_MAX_CHARS, defaultAnchor, intersectionArea, isFree, laneLayout, LANE_HEIGHTS, placeCollapsed, placeExpanded, splitSpeech, type Rect } from "./placement";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CompanionState } from "./reducer";
import { DEMO_IDS, SCENARIOS, scenarioScript, scenarioText, type ScenarioName } from "./scenarios";
import { createSimulatedCompanion, syntheticLevel, virtualClock, type ScriptStep } from "./simulator";

const RECIPIENT: Recipient = { project: "atlas", conversationId: "conversation_orchestrator", seatEpoch: 1, engine: "claude" };

/** A script on virtual time, reduced as the companion reduces it. */
function simulate(script: readonly ScriptStep[]) {
  const dispatched: Array<{ delivery: Delivery; instruction: string }> = [];
  const events: CompanionEvent[] = [];
  let state = INITIAL_COMPANION_STATE;
  const adapter = createSimulatedCompanion({ script, recipient: RECIPIENT, clock: virtualClock(), dispatch: (delivery, instruction) => dispatched.push({ delivery, instruction }) });
  adapter.subscribe((event) => { events.push(event); state = reduceCompanion(state, event); });
  const until = async (done: () => boolean) => {
    for (let turn = 0; turn < 2_000 && !done(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done()).toBe(true);
  };
  return { adapter, dispatched, events, state: () => state, until };
}
const scenario = (name: ScenarioName, locale: "en" | "uk" = "en") => simulate(scenarioScript(name, locale));
const types = (events: readonly CompanionEvent[]) => events.map((event) => event.type);
const delegationTypes = (events: readonly CompanionEvent[]) => types(events).filter((type) => type.startsWith("delegation.") || type === "orchestrator.answer");

describe("the explicit-request gate", () => {
  const admitted = [
    "Ask the orchestrator to review the export plan.",
    "Please tell the orchestrator the search lane can merge.",
    "Delegatus, send this to the orchestrator: rerun the billing checks.",
    "Could you ask the orchestrator to look at the flaky test?",
    "Let the orchestrator know the deploy is done.",
    "Попроси оркестратора перевірити план експорту.",
    "Будь ласка, передай оркестратору, що пошук можна зливати.",
    "Делегатусе, надішли оркестратору: перезапусти перевірки платежів.",
    "Можеш попросити оркестратора глянути на нестабільний тест?",
  ];
  const refused: Array<[string, string]> = [
    ["Hi Delegatus. Are you there?", "no_orchestrator"],
    ["Привіт, Делегатусе. Ти тут?", "no_orchestrator"],
    ["Don't send anything to the orchestrator.", "negated"],
    ["Не надсилай нічого оркестратору.", "negated"],
    ["Tell nobody, not even the orchestrator.", "negated"],
    ["He said “ask the orchestrator to merge it”.", "quoted"],
    ["Він сказав «попроси оркестратора злити».", "quoted"],
    ["If the build fails, ask the orchestrator to retry.", "not_imperative"],
    ["Ask the orchestrator to merge it if the checks pass.", "conditional"],
    ["Якщо збірка впаде, попроси оркестратора повторити.", "not_imperative"],
    ["Попроси оркестратора злити, якщо перевірки пройдуть.", "conditional"],
    ["Maybe ask the orchestrator later.", "not_imperative"],
    ["Можливо, попроси оркестратора пізніше.", "not_imperative"],
    ["I wonder how the orchestrator works.", "not_imperative"],
    ["Should we ask the orchestrator?", "not_imperative"],
    ["Ask the orchestrator?", "question"],
    ["We could ask the orchestrator later.", "not_imperative"],
    ["", "no_input"],
  ];
  for (const text of admitted) test(`admits: ${text}`, () => expect(explicitDelegationRequest(text)).toEqual({ admit: true }));
  for (const [text, reason] of refused) test(`refuses (${reason}): ${text || "(empty)"}`, () => expect(explicitDelegationRequest(text)).toEqual({ admit: false, reason: reason as never }));

  test("a proposal binds the operator's last, completed input", () => {
    const ask = { itemId: "a", text: "Ask the orchestrator to review the plan.", final: true };
    const instruction = "Review the plan.";
    expect(admitDelegationProposal({ sourceItemId: "a", instruction, inputs: [ask] })).toEqual({ admit: true });
    expect(admitDelegationProposal({ sourceItemId: "missing", instruction, inputs: [ask] })).toEqual({ admit: false, reason: "no_input" });
    expect(admitDelegationProposal({ sourceItemId: "a", instruction, inputs: [{ ...ask, final: false }] })).toEqual({ admit: false, reason: "not_final" });
    expect(admitDelegationProposal({ sourceItemId: "a", instruction, inputs: [ask, { itemId: "b", text: "Never mind.", final: true }] })).toEqual({ admit: false, reason: "stale_input" });
    expect(admitDelegationProposal({ sourceItemId: "a", instruction, inputs: [ask, { itemId: "b", text: "Wait", final: false }] })).toEqual({ admit: false, reason: "stale_input" });
    expect(admitDelegationProposal({ sourceItemId: "a", instruction: "  ", inputs: [ask] })).toEqual({ admit: false, reason: "empty_instruction" });
  });
});

describe("the simulated companion opens a confirmation only for an explicit request", () => {
  const propose = (sourceItemId: string): ScriptStep[] => [
    { kind: "propose", callId: "call_x", proposalId: "proposal_x", sourceItemId, instruction: "Do the thing." },
    { kind: "confirm", clientMessageId: "m_x", operationId: "op_x", settleAfterMs: 10, cancelled: [] },
  ];
  /* The model misfires: it proposes a delegation after each of these. The operator then taps Send anyway. */
  const misfires: Array<[string, ScriptStep[]]> = [
    ["greeting (en)", [{ kind: "operator", itemId: "i1", text: "Hi Delegatus. Are you there?" }, ...propose("i1")]],
    ["greeting (uk)", [{ kind: "operator", itemId: "i1", text: "Привіт, Делегатусе. Ти тут?" }, ...propose("i1")]],
    ["negation (en)", [{ kind: "operator", itemId: "i1", text: "Don't send anything to the orchestrator." }, ...propose("i1")]],
    ["negation (uk)", [{ kind: "operator", itemId: "i1", text: "Не надсилай нічого оркестратору." }, ...propose("i1")]],
    ["quotation", [{ kind: "operator", itemId: "i1", text: "He said “ask the orchestrator to merge it”." }, ...propose("i1")]],
    ["conditional (en)", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to merge it if the checks pass." }, ...propose("i1")]],
    ["conditional (uk)", [{ kind: "operator", itemId: "i1", text: "Якщо збірка впаде, попроси оркестратора повторити." }, ...propose("i1")]],
    ["missing input", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ...propose("i9")]],
    ["stale input", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, { kind: "operator", itemId: "i2", text: "Actually, never mind." }, ...propose("i1")]],
  ];
  for (const [name, script] of misfires) {
    test(`${name}: no confirmation is offered and Send sends nothing`, async () => {
      const run = simulate(script);
      await run.adapter.start({ locale: "en", project: "atlas" });
      await run.until(() => run.events.some((event) => event.type === "delegation.tool.result"));
      await run.adapter.command({ type: "confirmation", proposalId: "proposal_x", decision: "send", via: "tap" });
      await run.adapter.finished;
      expect(types(run.events)).not.toContain("delegation.confirmation.required");
      expect(run.dispatched).toEqual([]);
      expect(run.state().delegation?.stage).toBe("refused");
    });
  }

  test("an explicit request plus Send delivers exactly once", async () => {
    const run = simulate([{ kind: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план." }, ...propose("i1")]);
    await run.adapter.start({ locale: "uk", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    expect(run.dispatched).toEqual([]);
    await run.adapter.command({ type: "confirmation", proposalId: "proposal_x", decision: "send", via: "tap" });
    await run.adapter.command({ type: "confirmation", proposalId: "proposal_x", decision: "send", via: "tap" });
    await run.adapter.finished;
    expect(run.dispatched.length).toBe(1);
    expect(run.state().delegation?.stage).toBe("delivered");
  });

  test("the reducer applies the same gate: a confirmation the adapter should not have offered is refused", () => {
    let seq = 0;
    const at = (payload: Payload): CompanionEvent => ({ ...payload, version: 1, sessionId: "s", generation: 1, eventId: `e${++seq}`, seq, atMs: seq } as CompanionEvent);
    const state = [
      at({ type: "session.ready", mode: "official-realtime" }),
      at({ type: "transcript.final", speaker: "operator", itemId: "i1", text: "Не надсилай нічого оркестратору." }),
      at({ type: "delegation.tool.called", callId: "c1", sourceItemId: "i1", instruction: "Do it" }),
      at({ type: "delegation.confirmation.required", proposal: { proposalId: "p1", callId: "c1", sourceItemId: "i1", instruction: "Do it", recipient: RECIPIENT } }),
      at({ type: "delegation.confirmed", proposalId: "p1", via: "tap" }),
    ].reduce(reduceCompanion, INITIAL_COMPANION_STATE);
    expect(state.delegation?.stage).toBe("refused");
    expect(state.delegation?.refusal).toBe("negated");
  });
});

describe("the delegation scenario", () => {
  for (const locale of ["en", "uk"] as const) {
    test(`${locale}: ordinary talk reaches no tool; Send delivers once; the answer joins the delivery and is spoken back`, async () => {
      const run = scenario("delegation", locale);
      await run.adapter.start({ locale, project: "atlas" });
      await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
      const ask = run.events.findIndex((event) => event.type === "transcript.final" && event.speaker === "operator" && event.itemId === DEMO_IDS.askItem);
      expect(delegationTypes(run.events.slice(0, ask))).toEqual([]);
      expect(run.events.slice(0, ask).filter((event) => event.type === "transcript.final" && event.speaker === "operator").length).toBe(2);
      expect(run.dispatched).toEqual([]);
      await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
      await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "cancel", via: "tap" });
      await run.adapter.finished;
      expect(run.dispatched.length).toBe(1);
      expect(run.dispatched[0]!.delivery).toEqual({ proposalId: DEMO_IDS.proposalId, callId: DEMO_IDS.callId, clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, recipient: RECIPIENT });
      expect(delegationTypes(run.events)).toEqual(["delegation.tool.called", "delegation.confirmation.required", "delegation.confirmed", "delegation.tool.result", "delegation.delivery.settled", "orchestrator.answer"]);
      expect(run.state().delegation?.stage).toBe("answered");
      expect(run.state().lines.at(-1)).toMatchObject({ speaker: "companion", text: scenarioText(locale).explain, playback: "played" });
    });
  }

  test("cancel sends nothing and says so", async () => {
    const run = scenario("delegation");
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "cancel", via: "tap" });
    await run.adapter.finished;
    expect(run.dispatched).toEqual([]);
    expect(run.state().delegation?.stage).toBe("cancelled");
    expect(run.state().lines.at(-1)?.text).toBe("Okay, nothing was sent.");
  });

  test("closing mid-proposal sends nothing; a restart is a new generation without the old proposal", async () => {
    const run = scenario("proposal");
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.command({ type: "confirmation", proposalId: "proposal_forged", decision: "send", via: "tap" });
    await run.adapter.close();
    await run.adapter.close();
    await run.adapter.finished;
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
    expect(run.dispatched).toEqual([]);
    expect(run.events.filter((event) => event.type === "session.closed").length).toBe(1);
    await run.adapter.start({ locale: "en", project: "atlas" });
    expect(run.state().generation).toBe(2);
    expect(run.state().delegation).toBeNull();
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
    await run.adapter.finished;
    expect(run.dispatched.length).toBe(1);
    expect(new Set(run.events.map((event) => event.eventId)).size).toBe(run.events.length);
  });
});

describe("every scenario plays out on the contract", () => {
  for (const name of SCENARIOS) for (const locale of ["en", "uk"] as const) {
    test(`${name} (${locale})`, async () => {
      const run = scenario(name, locale);
      await run.adapter.start({ locale, project: "atlas" });
      if (name === "delegation") {
        await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
        await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
      }
      await run.adapter.finished;
      expect(run.events.map((event) => event.seq)).toEqual(run.events.map((_, index) => index));
      for (let index = 1; index < run.events.length; index += 1) expect(run.events[index]!.atMs).toBeGreaterThanOrEqual(run.events[index - 1]!.atMs);
      expect(run.dispatched.length).toBe(name === "delegation" ? 1 : 0);
      expect(run.state().phase).toBe("idle");
      for (const event of run.events) if (event.type === "playback.level") { expect(event.rms).toBeGreaterThanOrEqual(0); expect(event.rms).toBeLessThanOrEqual(1); }
      if (name === "burst") {
        expect(run.state().calls.map((call) => [call.name, call.status])).toEqual([["board_snapshot", "done"], ["list_pipelines", "done"], ["deployment_status", "done"], ["account_limits", "failed"]]);
        /* All four are running at once before the first one finishes. */
        const firstResult = run.events.findIndex((event) => event.type === "tool.result");
        expect(run.events.slice(0, firstResult).filter((event) => event.type === "tool.called").length).toBe(4);
      }
      if (name === "many") expect(run.state().lines.length).toBe(10);
      /* The very long answer needs more bubbles than the four shown at once, so older ones must leave. */
      if (name === "long") expect(splitSpeech(run.state().lines[0]!.text).length).toBeGreaterThan(4);
    });
  }
});

describe("transcripts are generated text; playback alone says what played", () => {
  let seq = 0;
  const at = (payload: Payload, over: Partial<CompanionEvent> = {}): CompanionEvent => {
    seq += 1;
    return { ...payload, version: 1, sessionId: "s", generation: 1, eventId: `e${seq}`, seq, atMs: seq, ...over } as CompanionEvent;
  };
  const run = (events: CompanionEvent[], from: CompanionState = INITIAL_COMPANION_STATE) => events.reduce(reduceCompanion, from);

  test("the whole transcript arrives first, then a barge-in 10 ms into playback: the line is cut at 10 ms and claims nothing more", () => {
    const text = "The export plan folds the toggles into three presets and moves the rare switches into one sheet.";
    const state = run([
      at({ type: "session.ready", mode: "official-realtime" }),
      at({ type: "response.started", responseId: "r", itemId: "i" }),
      at({ type: "transcript.final", speaker: "companion", itemId: "i", responseId: "r", text }),
      at({ type: "response.generated", responseId: "r", status: "completed" }),
      at({ type: "playback.started", responseId: "r", itemId: "i" }),
      at({ type: "playback.level", responseId: "r", itemId: "i", rms: 0.5, playedMs: 10 }),
      at({ type: "input.speech.started", itemId: "op" }),
      at({ type: "playback.stopped", responseId: "r", itemId: "i", playedMs: 12, reason: "interrupted" }),
    ]);
    const line = state.lines.find((candidate) => candidate.key === "companion:i")!;
    expect(line).toMatchObject({ text, final: true, playback: "cut", playedMs: 12 });
    expect(state.phase).toBe("listening");
    expect(state.mouth).toBe(0);
  });

  test("in the simulator the transcript is final before the audio ends, and the interruption scenario cuts the line where its audio stopped", async () => {
    const sim = scenario("interrupt");
    await sim.adapter.start({ locale: "en", project: "atlas" });
    await sim.adapter.finished;
    const plan = (type: string) => sim.events.findIndex((event) => event.type === type && "responseId" in event && event.responseId === DEMO_IDS.interruptedResponse);
    expect(plan("transcript.final")).toBeGreaterThan(-1);
    expect(plan("transcript.final")).toBeLessThan(plan("response.generated"));
    expect(plan("response.generated")).toBeLessThan(plan("playback.stopped"));
    /* No transcript delta after generation completed. */
    expect(sim.events.slice(plan("response.generated")).some((event) => event.type === "transcript.delta" && event.responseId === DEMO_IDS.interruptedResponse)).toBe(false);
    const line = sim.state().lines.find((candidate) => candidate.key === "companion:item_co_plan")!;
    expect(line.playback).toBe("cut");
    expect(line.text).toBe(scenarioText("en").longPlan);
    expect(line.playedMs!).toBeGreaterThanOrEqual(3_200);
    expect(line.playedMs!).toBeLessThan(3_300);
    expect(sim.state().lines.find((candidate) => candidate.key === `operator:${DEMO_IDS.bargeInItem}`)?.text).toBe(scenarioText("en").wait);
  });

  test("a duplicate event and an event of a retired generation change nothing", () => {
    const delta = at({ type: "transcript.delta", speaker: "companion", itemId: "i", delta: "Hello" });
    const state = run([at({ type: "session.ready", mode: "simulated" }), delta, delta]);
    expect(state.lines.map((line) => line.text)).toEqual(["Hello"]);
    const next = reduceCompanion(state, at({ type: "session.ready", mode: "simulated" }, { generation: 2 }));
    expect(reduceCompanion(next, at({ type: "transcript.delta", speaker: "companion", itemId: "late", delta: "late" }, { generation: 1 }))).toBe(next);
    expect(next.lines).toEqual([]);
  });

  test("a final replaces the provisional text, per speaker and item", () => {
    const state = run([
      at({ type: "transcript.delta", speaker: "operator", itemId: "i", delta: "Ask the " }),
      at({ type: "transcript.delta", speaker: "companion", itemId: "i", delta: "Sure" }),
      at({ type: "transcript.final", speaker: "operator", itemId: "i", text: "Ask the orchestrator." }),
      at({ type: "transcript.delta", speaker: "operator", itemId: "i", delta: " stray" }),
    ]);
    expect(state.lines.map((line) => [line.key, line.text, line.final, line.playback])).toEqual([
      ["operator:i", "Ask the orchestrator.", true, "none"],
      ["companion:i", "Sure", false, "pending"],
    ]);
  });

  test("the mouth follows playback past the end of generation; a level is clamped and costs no revision", () => {
    const speaking = run([
      at({ type: "session.ready", mode: "simulated" }),
      at({ type: "playback.started", responseId: "r", itemId: "i" }),
      at({ type: "playback.level", responseId: "r", itemId: "i", rms: 7, playedMs: 10 }),
      at({ type: "response.generated", responseId: "r", status: "completed" }),
    ]);
    expect(speaking.phase).toBe("speaking");
    expect(speaking.mouth).toBe(1);
    expect(reduceCompanion(speaking, at({ type: "playback.level", responseId: "other", itemId: "i", rms: 0.2, playedMs: 20 }))).toBe(speaking);
    expect(run([at({ type: "playback.level", responseId: "r", itemId: "i", rms: 0.4, playedMs: 30 })], speaking).revision).toBe(speaking.revision);
    const stopped = reduceCompanion(speaking, at({ type: "playback.stopped", responseId: "r", itemId: "i", playedMs: 900, reason: "ended" }));
    expect(stopped).toMatchObject({ phase: "idle", mouth: 0 });
    expect(stopped.lines[0]!.playback).toBe("played");
  });

  test("a malformed event is dropped", () => {
    const bad = { ...at({ type: "session.ready", mode: "simulated" }), seq: -1 };
    expect(reduceCompanion(INITIAL_COMPANION_STATE, bad)).toBe(INITIAL_COMPANION_STATE);
    expect(reduceCompanion(INITIAL_COMPANION_STATE, { ...at({ type: "session.ready", mode: "simulated" }), atMs: Number.NaN })).toBe(INITIAL_COMPANION_STATE);
  });

  test("calls: running, then done or failed, once", () => {
    const state = run([
      at({ type: "tool.called", callId: "a", name: "board_snapshot", summary: "Open tasks" }),
      at({ type: "tool.called", callId: "b", name: "account_limits", summary: "Usage" }),
      at({ type: "tool.result", callId: "a", status: "done", summary: "14 open" }),
      at({ type: "tool.result", callId: "b", status: "failed", summary: "rate limited" }),
      at({ type: "tool.result", callId: "a", status: "failed", summary: "late" }),
    ]);
    expect(state.calls.map((call) => [call.callId, call.status, call.result])).toEqual([["a", "done", "14 open"], ["b", "failed", "rate limited"]]);
  });
});

describe("a delivery and its answer bind the whole frozen identity", () => {
  let seq = 0;
  const at = (payload: Payload): CompanionEvent => ({ ...payload, version: 1, sessionId: "s", generation: 1, eventId: `b${++seq}`, seq, atMs: seq } as CompanionEvent);
  const run = (events: CompanionEvent[], from: CompanionState = INITIAL_COMPANION_STATE) => events.reduce(reduceCompanion, from);
  const delivery: Delivery = { proposalId: "p1", callId: "c1", clientMessageId: "m1", operationId: "o1", recipient: RECIPIENT };
  const confirmed = () => run([
    at({ type: "session.ready", mode: "official-realtime" }),
    at({ type: "transcript.final", speaker: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }),
    at({ type: "delegation.tool.called", callId: "c1", sourceItemId: "i1", instruction: "Review the plan" }),
    at({ type: "delegation.confirmation.required", proposal: { proposalId: "p1", callId: "c1", sourceItemId: "i1", instruction: "Review the plan", recipient: RECIPIENT } }),
    at({ type: "delegation.confirmed", proposalId: "p1", via: "tap" }),
  ]);
  const queued = () => run([at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery } })], confirmed());
  const variants: Array<[string, Delivery]> = [
    ["operation", { ...delivery, operationId: "o2" }],
    ["project", { ...delivery, recipient: { ...RECIPIENT, project: "other" } }],
    ["conversation", { ...delivery, recipient: { ...RECIPIENT, conversationId: "conversation_other" } }],
    ["seat epoch", { ...delivery, recipient: { ...RECIPIENT, seatEpoch: 2 } }],
    ["engine", { ...delivery, recipient: { ...RECIPIENT, engine: "codex" } }],
    ["message key", { ...delivery, clientMessageId: "m2" }],
  ];

  test("the matching settlement and answer are taken", () => {
    const state = run([
      at({ type: "delegation.delivery.settled", delivery, status: "delivered" }),
      at({ type: "orchestrator.answer", delivery, reportId: "r1", status: "result", text: "The plan holds." }),
      at({ type: "orchestrator.answer", delivery, reportId: "r1", status: "result", text: "Again." }),
    ], queued());
    expect(state.delegation).toMatchObject({ stage: "answered", answer: { reportId: "r1", text: "The plan holds." } });
  });

  for (const [name, other] of variants) {
    test(`a different ${name} neither settles nor answers`, () => {
      const base = queued();
      const settled = reduceCompanion(base, at({ type: "delegation.delivery.settled", delivery: other, status: "delivered" }));
      expect(settled.delegation).toEqual(base.delegation);
      const answered = reduceCompanion(base, at({ type: "orchestrator.answer", delivery: other, reportId: "r9", status: "result", text: "someone else's" }));
      expect(answered.delegation).toEqual(base.delegation);
    });
    if (other.recipient !== RECIPIENT) test(`a tool result to a different ${name} than the proposal froze is ignored`, () => {
      const base = confirmed();
      expect(reduceCompanion(base, at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery: other } })).delegation).toEqual(base.delegation);
    });
  }

  test("an unknown outcome waits for the original receipt: no answer before it, the recovered receipt settles, then its answer joins", () => {
    const unknown = run([at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "unknown", delivery: { ...delivery, operationId: null } } })], confirmed());
    expect(unknown.delegation?.stage).toBe("unknown");
    const early = reduceCompanion(unknown, at({ type: "orchestrator.answer", delivery: { ...delivery, operationId: null }, reportId: "r1", status: "result", text: "early" }));
    expect(early.delegation?.stage).toBe("unknown");
    const guessed = reduceCompanion(unknown, at({ type: "orchestrator.answer", delivery, reportId: "r1", status: "result", text: "guessed" }));
    expect(guessed.delegation?.stage).toBe("unknown");
    const stillNull = reduceCompanion(unknown, at({ type: "delegation.delivery.settled", delivery: { ...delivery, operationId: null }, status: "delivered" }));
    expect(stillNull.delegation?.stage).toBe("unknown");
    const recovered = run([
      at({ type: "delegation.delivery.settled", delivery, status: "delivered" }),
      at({ type: "orchestrator.answer", delivery: { ...delivery, operationId: "o2" }, reportId: "r2", status: "result", text: "other operation" }),
      at({ type: "orchestrator.answer", delivery, reportId: "r1", status: "result", text: "The plan holds." }),
    ], unknown);
    expect(recovered.delegation).toMatchObject({ stage: "answered", delivery: { operationId: "o1" }, answer: { reportId: "r1" } });
  });

  test("a queued result without an operation is ignored", () => {
    const base = confirmed();
    expect(reduceCompanion(base, at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery: { ...delivery, operationId: null } } })).delegation).toEqual(base.delegation);
  });

  test("a tool call alone delivers nothing", () => {
    const state = run([
      at({ type: "delegation.tool.called", callId: "c2", sourceItemId: "i1", instruction: "Review" }),
      at({ type: "delegation.tool.result", callId: "c2", result: { status: "delivered", delivery: { ...delivery, callId: "c2" } } }),
    ]);
    expect(state.delegation).toMatchObject({ stage: "proposed", delivery: null });
  });
});

describe("geometry", () => {
  const viewport = { width: 1440, height: 900 };
  const block = { width: 132, height: 148 };
  const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
  const inside = (box: Rect) => box.x >= 8 && box.y >= 8 && box.x + box.width <= viewport.width - 8 && box.y + box.height <= viewport.height - 8;

  test("the lane faces the middle and flips at each edge, so it stays inside the viewport", () => {
    const at = (x: number, y: number) => laneLayout(viewport, rect(x, y, block.width, block.height), 360);
    const cases: Array<[string, number, number, string, string]> = [
      ["bottom-right", 1292, 736, "left", "up"], ["bottom-left", 16, 736, "right", "up"],
      ["top-right", 1292, 16, "left", "down"], ["top-left", 16, 16, "right", "down"],
      ["right edge", 1292, 380, "left", "up"], ["left edge", 16, 380, "right", "up"],
      ["top edge", 700, 16, "left", "down"], ["bottom edge", 700, 736, "left", "up"],
    ];
    for (const [name, x, y, side, direction] of cases) {
      const lane = at(x, y);
      expect([name, lane.side, lane.direction]).toEqual([name, side, direction]);
      expect(inside(lane.rect)).toBe(true);
      expect(intersectionArea(lane.rect, rect(x, y, block.width, block.height))).toBe(0);
      expect(lane.rect.height).toBe(360);
    }
  });

  test("a viewport too short for the lane either way shortens it", () => {
    const lane = laneLayout({ width: 1000, height: 400 }, rect(800, 120, block.width, block.height), 360);
    expect(lane.rect.y).toBeGreaterThanOrEqual(8);
    expect(lane.rect.y + lane.rect.height).toBeLessThanOrEqual(392);
  });

  test("an empty page keeps the bottom-right corner with the tallest lane", () => {
    const placed = placeExpanded({ viewport, block, obstacles: [], desired: defaultAnchor(viewport, block) })!;
    expect(placed.at).toEqual({ x: 1292, y: 736 });
    expect(placed.laneHeight).toBe(LANE_HEIGHTS[0]);
  });

  test("a control under the lane moves the character until both are free", () => {
    const obstacles = [rect(1100, 600, 60, 30)];
    const placed = placeExpanded({ viewport, block, obstacles, desired: defaultAnchor(viewport, block) })!;
    expect(isFree({ ...placed.at, ...block }, obstacles)).toBe(true);
    expect(isFree(placed.lane.rect, obstacles)).toBe(true);
  });

  test("no room for any lane: the open companion has nowhere; the small shape still finds a place", () => {
    const grid: Rect[] = [];
    for (let x = 0; x < 1440; x += 100) for (let y = 0; y < 900; y += 100) grid.push(rect(x + 30, y + 30, 30, 30));
    expect(placeExpanded({ viewport, block, obstacles: grid, desired: defaultAnchor(viewport, block) })).toBeNull();
    const shape = { width: 52, height: 52 };
    const placed = placeCollapsed({ viewport, size: shape, obstacles: grid, desired: defaultAnchor(viewport, shape) })!;
    expect(isFree({ ...placed, ...shape }, grid)).toBe(true);
  });

  test("speech closes a bubble at a sentence once it holds 48 characters, a long sentence at a word, and a streaming line never takes a word back", () => {
    const text = scenarioText("en").long;
    const chunks = splitSpeech(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
    expect(chunks.join(" ")).toBe(text);
    expect(splitSpeech("I'm here. What's on your mind?")).toEqual(["I'm here. What's on your mind?"]);
    expect(splitSpeech("Keep three presets for the common cases: quick, full and archive. Move the rare switches into one sheet."))
      .toEqual(["Keep three presets for the common cases: quick, full and archive.", "Move the rare switches into one sheet."]);
    const words = text.match(/\S+\s*/g)!;
    for (let count = 1; count < words.length; count += 7) {
      const partial = splitSpeech(words.slice(0, count).join(""));
      expect(partial.slice(0, -1)).toEqual(chunks.slice(0, partial.length - 1));
    }
    for (const chunk of splitSpeech(scenarioText("uk").long)) expect(chunk.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
  });

  test("the synthetic level opens on vowels", () => {
    expect(syntheticLevel("a b", 0)).toBeGreaterThan(syntheticLevel("a b", 60));
  });
});
