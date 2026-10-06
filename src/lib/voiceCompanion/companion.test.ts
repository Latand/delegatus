import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { READ_TOOL_NAMES } from "./boardReads";
import type { CompanionEvent, Delivery, Payload, Recipient } from "./contract";
import { admitDelegationProposal, explicitDelegationRequest } from "./gate";
import { bezierProgress, bezierSlope, maxFrameShare, riseCurve, RISE_FRAME_SHARE, RISE_FROM_REST, RISE_IN_FLIGHT, RISE_MS } from "./motion";
import { BUBBLE_MAX_CHARS, CONTROL_SELECTOR, defaultAnchor, intersectionArea, isFree, isPassiveCursor, laneLayout, LANE_HEIGHTS, placeCollapsed, placeExpanded, splitSpeech, type Rect } from "./placement";
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
  test("the production Node runtime loads the gate and preserves polite requests in both languages", () => {
    const source = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(new URL("./gate.ts", import.meta.url), "utf8"));
    const result = spawnSync("node", ["--input-type=module"], {
      input: `${source}\nconsole.log(JSON.stringify([
        explicitDelegationRequest("Could you ask the orchestrator to review the plan?"),
        explicitDelegationRequest("Можеш попросити оркестратора перевірити план?"),
        explicitDelegationRequest("Ask the orchestrator?"),
        explicitDelegationRequest("Попроси оркестратора?")
      ]));`,
      encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { admit: true }, { admit: true },
      { admit: false, reason: "question" }, { admit: false, reason: "question" },
    ]);
  });

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
    "Tell our orchestrator the deploy is done.",
    "Hand this over to the orchestrator.",
    "Pass this message on to the project's orchestrator.",
    "Скажи оркестратору, що деплой завершено.",
    "Передай це нашому оркестратору: перезапусти перевірки.",
    "Запитай у оркестратора, коли буде реліз.",
    /* Plain sentences beside the request leave it standing. */
    "Hi Delegatus. Ask the orchestrator to review the export plan. It is in the docs folder.",
    "Привіт. Попроси оркестратора перевірити план експорту. Він у теці з документами.",
    "Ask the orchestrator to stop the deploy and wait for the checks.",
    /* "When" as the question itself, asked of the orchestrator. */
    "Ask the orchestrator when the release is.",
    "Спитай оркестратора, коли буде реліз.",
    "Ask the orchestrator to review only the export plan.",
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
    /* A request verb whose addressee is someone else: a question for the companion about the orchestrator. */
    ["Tell me how the orchestrator works.", "not_addressed"],
    ["Could you tell me how the orchestrator works?", "not_addressed"],
    ["Please tell me what the orchestrator is doing.", "not_addressed"],
    ["Tell me what to send to the orchestrator.", "not_addressed"],
    ["Send me a summary of what the orchestrator did.", "not_addressed"],
    ["Give me the list of tasks the orchestrator holds.", "not_addressed"],
    ["Ask about the orchestrator's queue.", "not_addressed"],
    ["Tell the orchestrator's story.", "not_addressed"],
    ["Let me know when the orchestrator answers.", "not_addressed"],
    ["Скажи, що робить оркестратор.", "not_addressed"],
    ["Скажи мені, як працює оркестратор.", "not_addressed"],
    ["Можеш сказати, чим зайнятий оркестратор?", "not_addressed"],
    ["Скажи мені, що передати оркестратору.", "not_addressed"],
    ["Напиши, що таке оркестратор.", "not_addressed"],
    ["Розкажи, як працює оркестратор.", "not_imperative"],
    /* The whole input is read: a sentence beside the request takes it back, hedges it or negates it. */
    ["Ask the orchestrator to review the plan. Actually, do not send anything.", "retracted"],
    ["Попроси оркестратора перевірити план. Нічого не надсилай.", "retracted"],
    ["Ask the orchestrator to review the plan. Never mind.", "retracted"],
    ["Попроси оркестратора перевірити план. Хоча ні, забудь.", "retracted"],
    ["Ask the orchestrator to review the plan, actually don't send anything.", "retracted"],
    ["Попроси оркестратора перевірити план, хоча ні, не треба.", "retracted"],
    ["Ask the orchestrator to review the plan. Only if the build is green.", "conditional"],
    ["Ask the orchestrator to review the plan. But only when the checks pass.", "conditional"],
    ["Попроси оркестратора перевірити план. Але тільки якщо збірка зелена.", "conditional"],
    ["Попроси оркестратора перевірити план. Лише коли перевірки пройдуть.", "conditional"],
    /* The same condition inside the request's own sentence. */
    ["Ask the orchestrator to review the plan, but only when the checks pass.", "conditional"],
    ["Попроси оркестратора перевірити план, але лише коли перевірки пройдуть.", "conditional"],
    ["Попроси оркестратора перевірити план, тільки коли перевірки пройдуть.", "conditional"],
    ["Ask the orchestrator to merge it when the checks pass.", "conditional"],
    ["Ask the orchestrator to merge it once the build is green.", "conditional"],
    ["Ask the orchestrator to merge it as soon as the checks pass.", "conditional"],
    ["Tell the orchestrator to deploy after the review ends.", "conditional"],
    ["Ask the orchestrator only when the checks pass.", "conditional"],
    ["Ask the orchestrator when the checks pass, to merge it.", "conditional"],
    ["Попроси оркестратора злити, щойно перевірки пройдуть.", "conditional"],
    ["Передай оркестратору, коли перевірки пройдуть, що можна зливати.", "conditional"],
    ["Попроси оркестратора злити за умови, що збірка зелена.", "conditional"],
    ["Ask the orchestrator to review the plan. I am not sure about it.", "negated"],
    ["Попроси оркестратора перевірити план. Я не впевнений.", "negated"],
    ["Ask the orchestrator to review the plan. Or should I do it myself?", "question"],
    ["Wait. Ask the orchestrator to review the plan.", "retracted"],
    ["Explain how the orchestrator works.", "not_imperative"],
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
    expect(admitDelegationProposal({ sourceItemId: "a", instruction, inputs: [ask], frozenSourceText: ask.text })).toEqual({ admit: true });
    expect(admitDelegationProposal({ sourceItemId: "a", instruction, inputs: [{ ...ask, text: "Ask the orchestrator to delete the plan." }], frozenSourceText: ask.text })).toEqual({ admit: false, reason: "source_changed" });
    /* A confirmation that waits is answered aloud: later speech leaves it unless it takes the request back. */
    const waiting = { sourceItemId: "a", instruction, frozenSourceText: ask.text, waiting: true };
    expect(admitDelegationProposal({ ...waiting, inputs: [ask, { itemId: "b", text: "Yes, send it.", final: true }] })).toEqual({ admit: true });
    expect(admitDelegationProposal({ ...waiting, inputs: [ask, { itemId: "b", text: "", final: false }] })).toEqual({ admit: true });
    expect(admitDelegationProposal({ ...waiting, inputs: [ask, { itemId: "b", text: "Never mind.", final: true }] })).toEqual({ admit: false, reason: "retracted" });
    expect(admitDelegationProposal({ ...waiting, inputs: [ask, { itemId: "b", text: "Wait", final: false }] })).toEqual({ admit: false, reason: "retracted" });
    expect(admitDelegationProposal({ ...waiting, inputs: [{ ...ask, text: "Ask the orchestrator to delete the plan." }, { itemId: "b", text: "Yes.", final: true }] })).toEqual({ admit: false, reason: "source_changed" });
  });
});

describe("the simulated companion sends an explicit request at once and asks first only where the model says so", () => {
  const deliver: ScriptStep = { kind: "deliver", clientMessageId: "m_x", operationId: "op_x", settleAfterMs: 10, cancelled: [] };
  /* The default: nothing asks the operator. */
  const propose = (sourceItemId: string): ScriptStep[] => [{ kind: "propose", callId: "call_x", proposalId: "proposal_x", sourceItemId, instruction: "Do the thing." }, deliver];
  /* The exception: the model gives its reason and the request waits. */
  const ask = (sourceItemId: string, spoken?: Extract<ScriptStep, { kind: "deliver" }>["spoken"]): ScriptStep[] => [
    { kind: "propose", callId: "call_x", proposalId: "proposal_x", sourceItemId, instruction: "Do the thing.", confirm: "This cannot be undone." },
    { ...deliver, ...(spoken ? { spoken } : {}), cancelled: [{ kind: "companion", itemId: "c_no", responseId: "r_no", text: "Okay, nothing was sent." }] },
  ];
  const tap = (run: ReturnType<typeof simulate>, decision: "send" | "cancel", proposalId = "proposal_x") => run.adapter.command({ type: "confirmation", proposalId, decision, via: "tap" });
  /* The model misfires: it raises a delegation after each of these, asking to confirm it or not. Send is tapped anyway. */
  const misfires: Array<[string, ScriptStep[], string]> = [
    ["greeting (en)", [{ kind: "operator", itemId: "i1", text: "Hi Delegatus. Are you there?" }], "i1"],
    ["greeting (uk)", [{ kind: "operator", itemId: "i1", text: "Привіт, Делегатусе. Ти тут?" }], "i1"],
    ["negation (en)", [{ kind: "operator", itemId: "i1", text: "Don't send anything to the orchestrator." }], "i1"],
    ["negation (uk)", [{ kind: "operator", itemId: "i1", text: "Не надсилай нічого оркестратору." }], "i1"],
    ["quotation", [{ kind: "operator", itemId: "i1", text: "He said “ask the orchestrator to merge it”." }], "i1"],
    ["conditional (en)", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to merge it if the checks pass." }], "i1"],
    ["conditional (uk)", [{ kind: "operator", itemId: "i1", text: "Якщо збірка впаде, попроси оркестратора повторити." }], "i1"],
    ["a question about the orchestrator (en)", [{ kind: "operator", itemId: "i1", text: "Tell me how the orchestrator works." }], "i1"],
    ["a polite question about the orchestrator (en)", [{ kind: "operator", itemId: "i1", text: "Could you tell me how the orchestrator works?" }], "i1"],
    ["a question about the orchestrator (uk)", [{ kind: "operator", itemId: "i1", text: "Скажи, що робить оркестратор." }], "i1"],
    ["a retraction in the next sentence (en)", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan. Actually, do not send anything." }], "i1"],
    ["a retraction in the next sentence (uk)", [{ kind: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план. Нічого не надсилай." }], "i1"],
    ["a condition in the next sentence (en)", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan. Only if the build is green." }], "i1"],
    ["a condition in the next sentence (uk)", [{ kind: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план. Але тільки якщо збірка зелена." }], "i1"],
    ["an only-when condition in the next sentence (en)", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan. But only when the checks pass." }], "i1"],
    ["an only-when condition in the next sentence (uk)", [{ kind: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план. Лише коли перевірки пройдуть." }], "i1"],
    ["an only-when condition in the request's sentence (en)", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan, but only when the checks pass." }], "i1"],
    ["an only-when condition in the request's sentence (uk)", [{ kind: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план, але лише коли перевірки пройдуть." }], "i1"],
    ["missing input", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }], "i9"],
    ["stale input", [{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, { kind: "operator", itemId: "i2", text: "Actually, never mind." }], "i1"],
  ];
  for (const [name, said, sourceItemId] of misfires) for (const [variant, steps] of [["sent at once", propose], ["asked first", ask]] as const) {
    test(`${name}, ${variant}: nothing is offered, nothing is sent, and Send sends nothing`, async () => {
      const run = simulate([...said, ...steps(sourceItemId)]);
      await run.adapter.start({ locale: "en", project: "atlas" });
      await run.until(() => run.events.some((event) => event.type === "delegation.tool.result"));
      await tap(run, "send");
      await run.adapter.finished;
      expect(types(run.events)).not.toContain("delegation.confirmation.required");
      expect(types(run.events)).not.toContain("delegation.sending");
      expect(run.dispatched).toEqual([]);
      expect(run.state().delegation?.stage).toBe("refused");
    });
  }

  test("an explicit request is sent at once, exactly once, and no tap is asked for or counted", async () => {
    const run = simulate([{ kind: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план." }, ...propose("i1")]);
    const stages: Array<string | undefined> = [];
    run.adapter.subscribe((event) => {
      stages.push(run.state().delegation?.stage);
      if (event.type === "delegation.sending") { void tap(run, "send"); void tap(run, "cancel"); }
    });
    await run.adapter.start({ locale: "uk", project: "atlas" });
    await run.adapter.finished;
    expect(delegationTypes(run.events)).toEqual(["delegation.tool.called", "delegation.sending", "delegation.tool.result", "delegation.delivery.settled"]);
    expect(stages).not.toContain("awaiting-confirmation");
    expect(run.dispatched.map((sent) => [sent.delivery.proposalId, sent.delivery.clientMessageId, sent.instruction])).toEqual([["proposal_x", "m_x", "Do the thing."]]);
    expect(run.state().delegation).toMatchObject({ stage: "delivered", instruction: "Do the thing." });
  });

  test("a confirmation the model asked for waits with its reason, and Send delivers exactly once", async () => {
    const run = simulate([{ kind: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план." }, ...ask("i1")]);
    await run.adapter.start({ locale: "uk", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    expect(run.state().delegation?.proposal?.confirmation).toEqual({ reason: "This cannot be undone." });
    expect(run.dispatched).toEqual([]);
    await tap(run, "send");
    await tap(run, "send");
    await run.adapter.finished;
    expect(run.dispatched.length).toBe(1);
    expect(run.state().delegation?.stage).toBe("delivered");
  });

  for (const [text, locale] of [["Yes, send it.", "en"], ["Так, надсилай.", "uk"]] as const) {
    test(`the spoken answer «${text}», passed on by the tool, sends exactly once with no tap`, async () => {
      const run = simulate([{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ...ask("i1", { itemId: "i2", text, decision: "send" })]);
      await run.adapter.start({ locale, project: "atlas" });
      await run.adapter.finished;
      expect(delegationTypes(run.events)).toEqual(["delegation.tool.called", "delegation.confirmation.required", "delegation.confirmed", "delegation.tool.result", "delegation.delivery.settled"]);
      expect(run.events.find((event) => event.type === "delegation.confirmed")).toMatchObject({ via: "speech", confirmationItemId: "i2" });
      /* Nothing went out while the question stood. */
      const answered = run.events.findIndex((event) => event.type === "transcript.final" && event.itemId === "i2");
      expect(run.events.findIndex((event) => event.type === "delegation.confirmed")).toBeGreaterThan(answered);
      expect(run.dispatched.length).toBe(1);
      expect(run.state().delegation?.stage).toBe("delivered");
    });
  }

  /* Declined in words the model reads as a no, and in words that take the request back before the model is asked. */
  for (const [text, code] of [["Leave it for today.", "operator_cancelled"], ["No, don't send it.", "retracted"], ["Ні, не треба.", "retracted"]] as const) {
    test(`the spoken answer «${text}» sends nothing and says so`, async () => {
      const run = simulate([{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ...ask("i1", { itemId: "i2", text, decision: "cancel" })]);
      await run.adapter.start({ locale: "en", project: "atlas" });
      await run.adapter.finished;
      await tap(run, "send");
      expect(types(run.events)).not.toContain("delegation.confirmed");
      expect(run.dispatched).toEqual([]);
      expect(run.state().delegation).toMatchObject({ stage: "cancelled", refusal: code, delivery: null });
      expect(run.state().lines.at(-1)?.text).toBe("Okay, nothing was sent.");
    });
  }

  test("a tap that comes before the spoken answer decides, and the answer said after it changes nothing", async () => {
    const run = simulate([{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ...ask("i1", { itemId: "i2", text: "Yes, send it.", decision: "send" })]);
    run.adapter.subscribe((event) => { if (event.type === "delegation.confirmation.required") void tap(run, "cancel"); });
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.adapter.finished;
    expect(run.dispatched).toEqual([]);
    expect(run.state().delegation).toMatchObject({ stage: "cancelled", refusal: "operator_cancelled" });
  });

  test("a confirmation nobody answers sends nothing when the conversation ends", async () => {
    const run = simulate([{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ...ask("i1")]);
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.close();
    await tap(run, "send");
    expect(run.dispatched).toEqual([]);
    expect(run.state().delegation).toMatchObject({ stage: "cancelled", refusal: "session_closed", delivery: null });
  });

  /* The page can only tap: the spoken answer is the model's tool call, never a command a page could forge. */
  for (const confirmationItemId of [undefined, "nonexistent", "i1"]) {
    test(`a speech command from outside naming ${confirmationItemId ?? "no item"} sends nothing; the tap after it sends exactly once`, async () => {
      const run = simulate([{ kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ...ask("i1")]);
      await run.adapter.start({ locale: "en", project: "atlas" });
      await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
      await run.adapter.command({ type: "confirmation", proposalId: "proposal_x", decision: "send", via: "speech", ...(confirmationItemId ? { confirmationItemId } : {}) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(types(run.events)).not.toContain("delegation.confirmed");
      expect(run.dispatched).toEqual([]);
      expect(run.state().delegation?.stage).toBe("awaiting-confirmation");
      await tap(run, "send");
      await run.adapter.finished;
      expect(run.dispatched.length).toBe(1);
      expect(run.state().delegation?.stage).toBe("delivered");
    });
  }

  test("the reducer shows a send that started with no confirmation, and takes a spoken confirmation as it takes a tap", () => {
    const at = (payload: Payload, seq: number): CompanionEvent => ({ ...payload, version: 1, sessionId: "s", generation: 1, eventId: `s:1:${seq}`, seq, atMs: seq } as CompanionEvent);
    const proposal = { proposalId: "p1", callId: "c1", sourceItemId: "i1", instruction: "Review the plan.", recipient: RECIPIENT };
    const delivery: Delivery = { proposalId: "p1", callId: "c1", clientMessageId: "m1", operationId: "op1", recipient: RECIPIENT };
    const called = [
      at({ type: "session.ready", mode: "simulated" }, 0),
      at({ type: "transcript.final", speaker: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, 1),
      at({ type: "delegation.tool.called", callId: "c1", sourceItemId: "i1", instruction: "Review the plan." }, 2),
    ].reduce(reduceCompanion, INITIAL_COMPANION_STATE);
    const sending = reduceCompanion(called, at({ type: "delegation.sending", proposal }, 3));
    expect(sending.delegation).toMatchObject({ stage: "sending", proposal, delivery: null });
    expect(reduceCompanion(sending, at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery } }, 4)).delegation).toMatchObject({ stage: "queued", delivery });
    /* A send for another call, or one claimed over a confirmation that waits, moves nothing. */
    expect(reduceCompanion(called, at({ type: "delegation.sending", proposal: { ...proposal, callId: "c2" } }, 3)).delegation?.stage).toBe("proposed");
    const waiting = reduceCompanion(called, at({ type: "delegation.confirmation.required", proposal: { ...proposal, confirmation: { reason: "Hard to undo." } } }, 3));
    expect(waiting.delegation).toMatchObject({ stage: "awaiting-confirmation", proposal: { confirmation: { reason: "Hard to undo." } } });
    expect(reduceCompanion(waiting, at({ type: "delegation.sending", proposal }, 4)).delegation?.stage).toBe("awaiting-confirmation");
    for (const via of ["speech", "tap"] as const) {
      const after = [
        at({ type: "delegation.confirmed", proposalId: "p1", via }, 4),
        at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery } }, 5),
      ].reduce(reduceCompanion, waiting);
      expect(after.delegation).toMatchObject({ stage: "queued", delivery });
    }
    /* A delivery claimed with no confirmation before it is not shown. */
    expect(reduceCompanion(waiting, at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery } }, 4)).delegation).toMatchObject({ stage: "awaiting-confirmation", delivery: null });
  });

  /* The operator asks, hears the question, then takes the request back. Send is tapped anyway. */
  const withdrawals: Array<[string, string, ScriptStep]> = [
    ["a finished withdrawal (en)", "Ask the orchestrator to review the plan.", { kind: "operator", itemId: "i2", text: "Do not send anything. Never mind." }],
    ["a finished withdrawal (uk)", "Попроси оркестратора перевірити план.", { kind: "operator", itemId: "i2", text: "Нічого не надсилай. Забудь." }],
    /* The question is interrupted: the new input has started and nothing of it is final when the card leaves. */
    ["an unfinished new input (en)", "Ask the orchestrator to review the plan.", { kind: "companion", itemId: "c1", responseId: "r1", text: "I will ask the orchestrator to review the plan.", bargeIn: { afterMs: 200, itemId: "i2", text: "Wait, hold on" } }],
    ["an unfinished new input (uk)", "Попроси оркестратора перевірити план.", { kind: "companion", itemId: "c1", responseId: "r1", text: "Я попрошу оркестратора перевірити план.", bargeIn: { afterMs: 200, itemId: "i2", text: "Стривай, зачекай" } }],
  ];
  for (const [name, said, after] of withdrawals) {
    test(`${name} while the confirmation waits removes it, and Send sends nothing`, async () => {
      const run = simulate([{ kind: "operator", itemId: "i1", text: said }, ask("i1")[0]!, after, { ...deliver }]);
      await run.adapter.start({ locale: "en", project: "atlas" });
      await run.adapter.finished;
      expect(types(run.events)).toContain("delegation.confirmation.required");
      const started = run.events.findIndex((event) => event.type === "input.speech.started" && event.itemId === "i2");
      const withdrawn = run.events.findIndex((event) => event.type === "delegation.tool.result" && event.result.status === "cancelled");
      expect(withdrawn).toBeGreaterThan(started);
      /* It left on the words that took it back, before the new input was final. */
      expect(run.events.slice(started, withdrawn).some((event) => event.type === "transcript.final" && event.itemId === "i2")).toBe(false);
      expect(run.events[withdrawn]).toMatchObject({ result: { code: "retracted" } });
      await tap(run, "send");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(types(run.events)).not.toContain("delegation.confirmed");
      expect(run.dispatched).toEqual([]);
      expect(run.state().delegation).toMatchObject({ stage: "cancelled", refusal: "retracted", delivery: null });
    });
  }

  test("ordinary speech while a confirmation waits leaves it standing for the answer", async () => {
    const run = simulate([
      { kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ask("i1")[0]!,
      { kind: "operator", itemId: "i2", text: "Hmm, let me think about it." }, { ...deliver },
    ]);
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.events.some((event) => event.type === "transcript.final" && event.itemId === "i2"));
    expect(run.state().delegation?.stage).toBe("awaiting-confirmation");
    expect(run.dispatched).toEqual([]);
    await tap(run, "send");
    await run.adapter.finished;
    expect(run.dispatched.length).toBe(1);
  });

  test("after a withdrawal the old Send revives nothing; a new explicit request gets its own card and its own Send", async () => {
    const run = simulate([
      { kind: "operator", itemId: "i1", text: "Ask the orchestrator to review the plan." }, ask("i1")[0]!,
      { kind: "operator", itemId: "i2", text: "Never mind." }, { ...deliver },
      { kind: "operator", itemId: "i3", text: "Ask the orchestrator to review the export plan." },
      { kind: "propose", callId: "call_y", proposalId: "proposal_y", sourceItemId: "i3", instruction: "Review the export plan.", confirm: "Two plans exist." },
      { kind: "deliver", clientMessageId: "m_y", operationId: "op_y", settleAfterMs: 10, cancelled: [] },
    ]);
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.proposal?.proposalId === "proposal_y");
    expect(run.dispatched).toEqual([]);
    await tap(run, "send");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(run.dispatched).toEqual([]);
    expect(types(run.events)).not.toContain("delegation.confirmed");
    expect(run.state().delegation?.stage).toBe("awaiting-confirmation");
    await tap(run, "send", "proposal_y");
    await run.adapter.finished;
    expect(run.dispatched.map((sent) => [sent.delivery.proposalId, sent.instruction])).toEqual([["proposal_y", "Review the export plan."]]);
    expect(run.state().delegation?.stage).toBe("delivered");
  });

  test("the reducer withdraws a waiting confirmation on speech that takes it back or a corrected source, and keeps it through an answer", () => {
    let seq = 0;
    const at = (payload: Payload): CompanionEvent => ({ ...payload, version: 1, sessionId: "s", generation: 1, eventId: `e${++seq}`, seq, atMs: seq } as CompanionEvent);
    const proposal = { proposalId: "p1", callId: "c1", sourceItemId: "i1", instruction: "Review the plan.", recipient: RECIPIENT, confirmation: { reason: "Two plans exist." } };
    const delivery: Delivery = { proposalId: "p1", callId: "c1", clientMessageId: "m1", operationId: "op1", recipient: RECIPIENT };
    const waiting = [
      at({ type: "session.ready", mode: "official-realtime" }),
      at({ type: "transcript.final", speaker: "operator", itemId: "i1", text: "Попроси оркестратора перевірити план." }),
      at({ type: "delegation.tool.called", callId: "c1", sourceItemId: "i1", instruction: proposal.instruction }),
      at({ type: "delegation.confirmation.required", proposal }),
    ].reduce(reduceCompanion, INITIAL_COMPANION_STATE);
    expect(waiting.delegation?.stage).toBe("awaiting-confirmation");
    const later: Array<[string, Payload, string]> = [
      ["a first word that takes it back", { type: "transcript.delta", speaker: "operator", itemId: "i2", delta: "Стривай" }, "retracted"],
      ["a finished sentence that takes it back", { type: "transcript.final", speaker: "operator", itemId: "i2", text: "Нічого не надсилай." }, "retracted"],
      ["a corrected source", { type: "transcript.final", speaker: "operator", itemId: "i1", text: "Попроси оркестратора видалити план." }, "source_changed"],
    ];
    for (const [name, payload, reason] of later) {
      const withdrawn = reduceCompanion(waiting, at(payload));
      expect([name, withdrawn.delegation?.stage, withdrawn.delegation?.refusal]).toEqual([name, "cancelled", reason]);
      /* A forged or late confirmation and delivery change nothing. */
      const forced = [
        at({ type: "delegation.confirmed", proposalId: "p1", via: "tap" }),
        at({ type: "delegation.confirmed", proposalId: "p1", via: "speech" }),
        at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1", result: { status: "queued", delivery } }),
        at({ type: "delegation.delivery.settled", delivery, status: "delivered" }),
      ].reduce(reduceCompanion, withdrawn);
      expect([name, forced.delegation?.stage, forced.delegation?.delivery]).toEqual([name, "cancelled", null]);
    }
    /* The operator answers aloud, so speech that takes nothing back leaves the card for the answer. */
    const standing: Payload[] = [
      { type: "input.speech.started", itemId: "i2" },
      { type: "transcript.delta", speaker: "operator", itemId: "i2", delta: "Так," },
      { type: "transcript.final", speaker: "operator", itemId: "i2", text: "Так, надсилай." },
      { type: "transcript.final", speaker: "companion", itemId: "c9", responseId: "r9", text: "I will ask the orchestrator." },
    ];
    for (const payload of standing) expect([payload.type, reduceCompanion(waiting, at(payload)).delegation?.stage]).toEqual([payload.type, "awaiting-confirmation"]);
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

  test("the reducer refuses a conditional request, in one sentence or two, whatever the adapter offers and confirms", () => {
    const conditional = [
      "Ask the orchestrator to review the plan, but only when the checks pass.",
      "Ask the orchestrator to review the plan. But only when the checks pass.",
      "Попроси оркестратора перевірити план, але лише коли перевірки пройдуть.",
      "Попроси оркестратора перевірити план. Лише коли перевірки пройдуть.",
    ];
    for (const text of conditional) {
      let seq = 0;
      const at = (payload: Payload): CompanionEvent => ({ ...payload, version: 1, sessionId: "s", generation: 1, eventId: `e${++seq}`, seq, atMs: seq } as CompanionEvent);
      const proposal = { proposalId: "p1", callId: "c1", sourceItemId: "i1", instruction: "Review the plan.", recipient: RECIPIENT };
      const state = [
        at({ type: "session.ready", mode: "official-realtime" }),
        at({ type: "transcript.final", speaker: "operator", itemId: "i1", text }),
        at({ type: "delegation.tool.called", callId: "c1", sourceItemId: "i1", instruction: "Review the plan." }),
        at({ type: "delegation.confirmation.required", proposal }),
        at({ type: "delegation.confirmed", proposalId: "p1", via: "tap" }),
        at({ type: "delegation.delivery.settled", delivery: { proposalId: "p1", callId: "c1", clientMessageId: "m1", operationId: "op1", recipient: RECIPIENT }, status: "delivered" }),
      ].reduce(reduceCompanion, INITIAL_COMPANION_STATE);
      expect([text, state.delegation?.stage, state.delegation?.refusal, state.delegation?.delivery ?? null]).toEqual([text, "refused", "conditional", null]);
    }
  });
});

describe("the delegation scenarios", () => {
  for (const locale of ["en", "uk"] as const) {
    test(`${locale}: ordinary talk reaches no tool; the request goes out once with no tap; the answer joins the delivery and is spoken back`, async () => {
      const run = scenario("delegation", locale);
      const stages: Array<string | undefined> = [];
      run.adapter.subscribe(() => { stages.push(run.state().delegation?.stage); });
      await run.adapter.start({ locale, project: "atlas" });
      await run.adapter.finished;
      const asked = run.events.findIndex((event) => event.type === "transcript.final" && event.speaker === "operator" && event.itemId === DEMO_IDS.askItem);
      expect(delegationTypes(run.events.slice(0, asked))).toEqual([]);
      expect(run.events.slice(0, asked).filter((event) => event.type === "transcript.final" && event.speaker === "operator").length).toBe(2);
      expect(stages).not.toContain("awaiting-confirmation");
      expect(run.dispatched.length).toBe(1);
      expect(run.dispatched[0]!.delivery).toEqual({ proposalId: DEMO_IDS.proposalId, callId: DEMO_IDS.callId, clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, recipient: RECIPIENT });
      expect(delegationTypes(run.events)).toEqual(["delegation.tool.called", "delegation.sending", "delegation.tool.result", "delegation.delivery.settled", "orchestrator.answer"]);
      expect(run.state().delegation?.stage).toBe("answered");
      expect(run.state().lines.at(-1)).toMatchObject({ speaker: "companion", text: scenarioText(locale).explain, playback: "played" });
    });

    test(`${locale}: a request that is hard to undo is asked aloud, and the spoken yes sends it once`, async () => {
      const run = scenario("voiceConfirm", locale);
      /* What stood while the question was open: the model's reason on the card, and nothing sent. */
      const asked: unknown[] = [];
      run.adapter.subscribe((event) => { if (event.type === "delegation.confirmation.required") asked.push([run.state().delegation?.stage, run.state().delegation?.proposal?.confirmation, run.dispatched.length]); });
      await run.adapter.start({ locale, project: "atlas" });
      await run.adapter.finished;
      expect(asked).toEqual([["awaiting-confirmation", { reason: scenarioText(locale).critical }, 0]]);
      expect(delegationTypes(run.events)).toEqual(["delegation.tool.called", "delegation.confirmation.required", "delegation.confirmed", "delegation.tool.result", "delegation.delivery.settled"]);
      expect(run.events.find((event) => event.type === "delegation.confirmed")).toMatchObject({ via: "speech", confirmationItemId: DEMO_IDS.yesItem });
      expect(run.dispatched.map((sent) => [sent.delivery.clientMessageId, sent.instruction])).toEqual([[DEMO_IDS.criticalClientMessageId, scenarioText(locale).instructionCritical]]);
      expect(run.state().lines.at(-1)).toMatchObject({ speaker: "companion", text: scenarioText(locale).sentCritical });
    });

    test(`${locale}: the demo sends one request at once and one after a spoken confirmation, each exactly once`, async () => {
      const run = scenario("demo", locale);
      await run.adapter.start({ locale, project: "atlas" });
      await run.adapter.finished;
      expect(run.dispatched.map((sent) => [sent.delivery.clientMessageId, sent.instruction])).toEqual([
        [DEMO_IDS.clientMessageId, scenarioText(locale).instruction], [DEMO_IDS.criticalClientMessageId, scenarioText(locale).instructionCritical],
      ]);
      expect(delegationTypes(run.events)).toEqual([
        "delegation.tool.called", "delegation.sending", "delegation.tool.result", "delegation.delivery.settled", "orchestrator.answer",
        "delegation.tool.called", "delegation.confirmation.required", "delegation.confirmed", "delegation.tool.result", "delegation.delivery.settled",
      ]);
      /* The first request keeps its card and its answer while the second one is asked and sent. */
      expect(run.state().deliveryCards.map((card) => [card.callId, card.stage])).toEqual([[DEMO_IDS.callId, "answered"], [DEMO_IDS.criticalCallId, "delivered"]]);
    });
  }

  test("a declined confirmation sends nothing and says so", async () => {
    const run = scenario("proposal");
    await run.adapter.start({ locale: "en", project: "atlas" });
    await run.until(() => run.state().delegation?.stage === "awaiting-confirmation");
    await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "cancel", via: "tap" });
    await run.adapter.finished;
    expect(run.dispatched).toEqual([]);
    expect(run.state().delegation).toMatchObject({ stage: "cancelled", refusal: "operator_cancelled" });
    expect(run.state().lines.at(-1)?.text).toBe("Okay, nothing was sent.");
  });

  for (const locale of ["en", "uk"] as const) {
    test(`${locale}: speaking over the question to take the request back withdraws it; Send then sends nothing`, async () => {
      const run = scenario("withdraw", locale);
      await run.adapter.start({ locale, project: "atlas" });
      await run.adapter.finished;
      await run.adapter.command({ type: "confirmation", proposalId: DEMO_IDS.proposalId, decision: "send", via: "tap" });
      expect(delegationTypes(run.events)).toEqual(["delegation.tool.called", "delegation.confirmation.required", "delegation.tool.result"]);
      expect(run.dispatched).toEqual([]);
      expect(run.state().delegation).toMatchObject({ stage: "cancelled", refusal: "retracted" });
      expect(run.state().lines.at(-1)?.text).toBe(scenarioText(locale).dropped);
    });
  }

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
      await run.adapter.finished;
      expect(run.events.map((event) => event.seq)).toEqual(run.events.map((_, index) => index));
      for (let index = 1; index < run.events.length; index += 1) expect(run.events[index]!.atMs).toBeGreaterThanOrEqual(run.events[index - 1]!.atMs);
      expect(run.dispatched.length).toBe(name === "delegation" ? 1 : 0);
      expect(run.state().phase).toBe("idle");
      for (const event of run.events) if (event.type === "playback.level") { expect(event.rms).toBeGreaterThanOrEqual(0); expect(event.rms).toBeLessThanOrEqual(1); }
      if (name === "burst") {
        for (const call of run.state().calls) expect(READ_TOOL_NAMES as readonly string[]).toContain(call.name);
        expect(run.state().calls.map((call) => [call.name, call.status])).toEqual([["list_tasks", "done"], ["list_pipelines", "done"], ["agent_activity", "done"], ["conversation_messages", "failed"]]);
        /* All four are running at once before the first one finishes. */
        const firstResult = run.events.findIndex((event) => event.type === "tool.result");
        expect(run.events.slice(0, firstResult).filter((event) => event.type === "tool.called").length).toBe(4);
      }
      /* A question about the board is answered from read calls with real registry names, and never delegates. */
      if (name === "read" || name === "reads" || name === "readLong") {
        const calls = run.state().calls;
        expect(calls.length).toBe(name === "reads" ? 3 : 1);
        for (const call of calls) { expect(READ_TOOL_NAMES as readonly string[]).toContain(call.name); expect(call.status).toBe("done"); }
        expect(run.events.some((event) => event.type.startsWith("delegation."))).toBe(false);
        const answered = run.events.findIndex((event) => event.type === "response.started");
        expect(run.events.findLastIndex((event) => event.type === "tool.result")).toBeLessThan(answered);
      }
      if (name === "readLong") expect(splitSpeech(run.state().lines.at(-1)!.text).length).toBeGreaterThan(4);
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

  test("an unknown send recovers its queued receipt through the adapter result and rejects another binding", () => {
    const unknown = run([at({ type: "delegation.tool.result", callId: "c1", result: { status: "unknown", delivery: { ...delivery, operationId: null } } })], confirmed());
    const forged = reduceCompanion(unknown, at({ type: "delegation.tool.result", callId: "c1", result: { status: "queued", delivery: { ...delivery, clientMessageId: "different" } } }));
    expect(forged.delegation).toEqual(unknown.delegation);
    const recovered = reduceCompanion(unknown, at({ type: "delegation.tool.result", callId: "c1", result: { status: "queued", delivery } }));
    expect(recovered.delegation).toMatchObject({ stage: "queued", delivery: { operationId: "o1" } });
    expect(reduceCompanion(recovered, at({ type: "orchestrator.answer", delivery, reportId: "recovered", status: "result", text: "Checked" })).delegation?.stage).toBe("answered");
  });

  test("a tool call alone delivers nothing", () => {
    const state = run([
      at({ type: "delegation.tool.called", callId: "c2", sourceItemId: "i1", instruction: "Review" }),
      at({ type: "delegation.tool.result", callId: "c2", result: { status: "delivered", delivery: { ...delivery, callId: "c2" } } }),
    ]);
    expect(state.delegation).toMatchObject({ stage: "proposed", delivery: null });
  });

  test("a newer call retains an in-flight send and applies its later unknown receipt to that card", () => {
    const sendingA = confirmed();
    const proposalB = { proposalId: "p2", callId: "c2", sourceItemId: "i2", instruction: "Deploy the release", recipient: RECIPIENT };
    const currentB = run([
      at({ type: "delegation.tool.called", callId: "c2", sourceItemId: "i2", instruction: proposalB.instruction }),
      at({ type: "delegation.sending", proposal: proposalB }),
    ], sendingA);
    expect(currentB.deliveryCards).toContainEqual(expect.objectContaining({ callId: "c1", stage: "sending", delivery: null }));
    const withReceipt = reduceCompanion(currentB, at({ type: "delegation.tool.result", callId: "c1", proposalId: "p1",
      result: { status: "unknown", delivery: { ...delivery, operationId: null } } }));
    expect(withReceipt.delegation).toMatchObject({ callId: "c2", stage: "sending" });
    expect(withReceipt.deliveryCards).toContainEqual(expect.objectContaining({ callId: "c1", stage: "unknown", notice: "DELIVERY_UNCONFIRMED",
      delivery: expect.objectContaining({ clientMessageId: "m1", operationId: null }) }));
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

  test("the open character keeps off the page's text where a place without any exists, and one page gives one place", () => {
    /* A paragraph across the corner the character asks for, and a control beside it. */
    const text = [rect(1000, 700, 420, 18), rect(1000, 722, 420, 18), rect(1000, 744, 300, 18), rect(1000, 860, 420, 18)];
    const obstacles = [rect(900, 820, 80, 30)];
    const desired = defaultAnchor(viewport, block);
    const placed = placeExpanded({ viewport, block, obstacles, text, desired })!;
    expect(isFree({ ...placed.at, ...block }, [...obstacles, ...text])).toBe(true);
    expect(isFree(placed.lane.rect, obstacles)).toBe(true);
    /* The lane may lie over text: only the character is held off it. Without the text the corner itself is taken. */
    expect(placeExpanded({ viewport, block, obstacles, desired })!.at).not.toEqual(placed.at);
    /* The same arguments, the same answer, whatever was placed before. */
    for (let turn = 0; turn < 3; turn += 1) expect(placeExpanded({ viewport, block, obstacles: [...obstacles].reverse(), text: [...text].reverse(), desired })!.at).toEqual(placed.at);
  });

  test("a page that is text everywhere still gets an open character, off every control", () => {
    const text: Rect[] = [];
    for (let y = 0; y < 900; y += 20) text.push(rect(0, y, 1440, 16));
    const obstacles = [rect(1300, 800, 100, 60)];
    const placed = placeExpanded({ viewport, block, obstacles, text, desired: defaultAnchor(viewport, block) })!;
    expect(placed).not.toBeNull();
    expect(isFree({ ...placed.at, ...block }, obstacles)).toBe(true);
    expect(isFree(placed.lane.rect, obstacles)).toBe(true);
  });

  test("no frame of a rise carries more than 12 % of its path, from rest or taking over a rise in flight, even when one frame is missed", () => {
    for (const curve of [RISE_FROM_REST, RISE_IN_FLIGHT]) {
      expect(maxFrameShare(curve, RISE_MS, 1000 / 60)).toBeLessThanOrEqual(RISE_FRAME_SHARE / 2);
      expect(maxFrameShare(curve, RISE_MS, 2000 / 60)).toBeLessThanOrEqual(RISE_FRAME_SHARE);
      expect(bezierProgress(curve, 0)).toBe(0);
      expect(bezierProgress(curve, 1)).toBe(1);
      /* Monotonic: the lane never moves back toward the character. */
      for (let at = 0; at < 1; at += 0.01) expect(bezierProgress(curve, at + 0.01)).toBeGreaterThanOrEqual(bezierProgress(curve, at));
    }
    /* The curve this replaced: a fifth of the path in the first frame. */
    expect(maxFrameShare([0.22, 1, 0.36, 1], 340, 1000 / 60)).toBeGreaterThan(0.2);
    /* A rise from rest starts and ends slowly; one that takes over starts at speed. */
    expect(bezierProgress(RISE_FROM_REST, 0.05)).toBeLessThan(0.01);
    expect(bezierProgress(RISE_IN_FLIGHT, 0.05)).toBeGreaterThan(0.04);
  });

  test("a rise that takes over another starts at speed only when the lane still moves at speed", () => {
    /* Mid-flight of a 100 px rise the lane moves fast: a rise of the same length carries on at speed. */
    const mid = (100 * bezierSlope(RISE_FROM_REST, 0.5)) / RISE_MS;
    expect(riseCurve(mid, 100)).toBe(RISE_IN_FLIGHT);
    /* Its slow end is all but rest, and so is a 20 px rise against a 180 px card that arrives. */
    expect(riseCurve((100 * bezierSlope(RISE_FROM_REST, 0.97)) / RISE_MS, 100)).toBe(RISE_FROM_REST);
    expect(riseCurve((20 * bezierSlope(RISE_FROM_REST, 0.5)) / RISE_MS, 200)).toBe(RISE_FROM_REST);
    expect(riseCurve(0, 100)).toBe(RISE_FROM_REST);
    expect(riseCurve(mid, 0)).toBe(RISE_FROM_REST);
    /* The curve that starts at speed sets off no faster than a rise from rest runs at its middle. */
    expect(bezierSlope(RISE_IN_FLIGHT, 0)).toBeLessThanOrEqual(bezierSlope(RISE_FROM_REST, 0.5));
  });

  test("no room for any lane: the open companion has nowhere; the small shape still finds a place", () => {
    const grid: Rect[] = [];
    for (let x = 0; x < 1440; x += 100) for (let y = 0; y < 900; y += 100) grid.push(rect(x + 30, y + 30, 30, 30));
    expect(placeExpanded({ viewport, block, obstacles: grid, desired: defaultAnchor(viewport, block) })).toBeNull();
    const shape = { width: 52, height: 52 };
    const placed = placeCollapsed({ viewport, size: shape, obstacles: grid, desired: defaultAnchor(viewport, shape) })!;
    expect(isFree({ ...placed, ...shape }, grid)).toBe(true);
  });

  test("speech closes a bubble at a sentence once it holds 48 characters, and a streaming line never changes a bubble before its last", () => {
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

  test("a sentence longer than a bubble is cut at a clause: no bubble ends on a function word or starts as a lone word", () => {
    /* The two cuts the first split made mid-phrase (review of 2f5590ee7). */
    expect(splitSpeech(scenarioText("en").long)).toContain("The billing migration lane is blocked on the external audit,");
    expect(splitSpeech(scenarioText("en").long)).toContain("and nothing on our side can move it until they confirm the reconciliation.");
    expect(splitSpeech(scenarioText("uk").long).slice(0, 3)).toEqual([
      "Ось уся картина релізу. Від ранку злито чотири смуги: банер повтору, адаптер черги, пресети експорту",
      "й виправлення блокування акаунта. Дві ще відкриті.",
      "Смуга пошуку пройшла рев’ю з другого кола й чекає пакетного злиття, яке запускається що двадцять хвилин,",
    ]);
    const closers = /(?:^|\s)(?:a|an|the|of|to|in|on|and|or|but|that|which|nothing|і|й|та|а|але|що|яке|який|в|у|на|з|до|не)$/iu;
    for (const locale of ["en", "uk"] as const) for (const key of ["long", "paragraph", "longPlan", "opinion", "burstSummary", "explain", "readsAnswer", "readLongAnswer"] as const) {
      const text = scenarioText(locale)[key];
      const chunks = splitSpeech(text);
      expect(chunks.join(" "), `${locale} ${key}`).toBe(text);
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.length, chunk).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
        expect(closers.test(chunk.replace(/[^\p{L}\p{N}\s]+$/u, "")), `ends on a function word: ${chunk}`).toBe(false);
        /* A bubble that continues a sentence the one before it left open holds more than a word or two. */
        if (index > 0 && !/[.!?…]$/u.test(chunks[index - 1]!)) expect(chunk.split(/\s+/u).length, `carried too little: ${chunk}`).toBeGreaterThanOrEqual(3);
      }
    }
    /* No comma to cut at: the cut still carries two words on and keeps off the function word. */
    const flat = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen the eighteen nineteen twenty twentyone";
    expect(splitSpeech(flat)).toEqual(["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", "seventeen the eighteen nineteen twenty twentyone"]);
    /* One word longer than a bubble is left whole for the wrap to break. */
    expect(splitSpeech("x".repeat(150))).toEqual(["x".repeat(150)]);
  });

  test("a streaming line's bubbles only ever gain words: none gives a word back, and the finished line is split as before", () => {
    for (const locale of ["en", "uk"] as const) for (const key of ["long", "paragraph", "longPlan", "opinion", "burstSummary", "explain", "readsAnswer", "readLongAnswer"] as const) {
      const text = scenarioText(locale)[key];
      const words = text.match(/\S+\s*/gu)!;
      let shown: string[] = [];
      for (let count = 1; count <= words.length; count += 1) {
        const next = splitSpeech(words.slice(0, count).join(""), BUBBLE_MAX_CHARS, true);
        expect(next.length, `${locale} ${key} at ${count}: a bubble went away`).toBeGreaterThanOrEqual(shown.length);
        for (const [index, chunk] of shown.entries()) expect(next[index]!.startsWith(chunk), `${locale} ${key} at ${count}: "${chunk}" became "${next[index]}"`).toBe(true);
        for (const chunk of next) expect(chunk.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
        shown = next;
      }
      /* The line ends: what was held back joins the last bubble or is the next one. */
      const whole = splitSpeech(text);
      for (const [index, chunk] of shown.entries()) expect(whole[index]!.startsWith(chunk), `${locale} ${key}: "${chunk}" against "${whole[index]}"`).toBe(true);
    }
    /* Nothing is settled in the first words; a bubble that would have given up its tail holds it back instead. */
    expect(splitSpeech("The plan", BUBBLE_MAX_CHARS, true)).toEqual([]);
    expect(splitSpeech("The orchestrator replied. The plan holds, with one gap: last month's saved", BUBBLE_MAX_CHARS, true)).toEqual(["The orchestrator replied. The plan holds, with one gap:"]);
    expect(splitSpeech("The orchestrator replied. The plan holds, with one gap: last month's saved")).toEqual(["The orchestrator replied. The plan holds, with one gap: last month's saved"]);
  });

  test("a cursor of its own marks a control: resize handles and dragging surfaces count, text and plain boxes do not", () => {
    for (const cursor of ["ew-resize", "ns-resize", "col-resize", "grab", "grabbing", "move", "pointer", "not-allowed"]) expect(isPassiveCursor(cursor), cursor).toBe(false);
    for (const cursor of ["auto", "default", "text", "none", ""]) expect(isPassiveCursor(cursor), cursor).toBe(true);
    expect(CONTROL_SELECTOR).toContain("[role='separator']");
  });

  test("the synthetic level opens on vowels", () => {
    expect(syntheticLevel("a b", 0)).toBeGreaterThan(syntheticLevel("a b", 60));
  });
});
