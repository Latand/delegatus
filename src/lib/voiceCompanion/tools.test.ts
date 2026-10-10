import { fixtureBoardReads } from "./boardReads.fixture";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-registry-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
const { COMPANION_TOOL_REGISTRY, COMPANION_TOOLS, runCompanionTool } = await import("./tools");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("all declarations execute through one allowlist, parameter schema and project fence", async () => {
  let ended = false;
  const admission = new CompanionAdmission(new CompanionStorage(), { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected delivery"); } });
  const session = admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  const reads = fixtureBoardReads({ tasks: () => [{ id: "task-a", project: "fixture", text: "A task", status: "open" }, { id: "task-b", project: "foreign", text: "Foreign", status: "open" }],
    pipelines: () => [{ id: "pipeline-a", project: "fixture", task: "A pipeline", state: "running", stages: [], runs: [] }],
    activity: async () => [{ conversationId: "conversation_a", project: "fixture", title: "Agent", lifecycle: "running" }], messages: async () => [{ role: "assistant", text: "Checked it" }] });
  const context = { project: "fixture", sessionId: session.id, callId: "call-a", delegationId: "delegation-a", admission, reads, endConversation: () => { ended = true; } };
  const args: Record<string, Record<string, unknown>> = { list_tasks: {}, get_task: { taskId: "task-a" }, list_pipelines: {}, get_pipeline: { pipelineId: "pipeline-a" },
    agent_activity: {}, conversation_messages: { conversationId: "conversation_a" }, orchestrator_messages:{},search_transcripts:{query:"plan"},read_prototype_review:{taskId:"task-a"},view_prototype_frame:{taskId:"task-a",reviewId:"review-a",mediaId:"frame-a"}, request_orchestrator_delegation: { instruction: "Review it", confirmation_reason: null },
    resolve_orchestrator_confirmation: { decision: "send" }, end_conversation: {} };
  expect(COMPANION_TOOLS.map(row => row.name)).toEqual(COMPANION_TOOL_REGISTRY.map(row => row.name));
  for (const tool of COMPANION_TOOL_REGISTRY) {
    expect(await runCompanionTool(context, tool.name, args[tool.name])).toBeDefined();
    await expect(runCompanionTool(context, tool.name, { ...args[tool.name], arbitrary: "foreign" })).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
  }
  expect(ended).toBe(true);
  await expect(runCompanionTool(context, "send_message", {})).rejects.toThrow("TOOL_NOT_ALLOWED");
  await expect(runCompanionTool(context, "get_task", { taskId: "task-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(runCompanionTool(context, "get_task", {})).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
  admission.retire(session.id);
  await expect(runCompanionTool(context, "end_conversation", {})).rejects.toThrow("SESSION_CLOSED");
});

test("the delegation tool sends at once; the model's own flag asks first, and the spoken answer resolves it through the second tool", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const sent: string[] = [];
  const admission = new CompanionAdmission(new CompanionStorage(), { recipient: () => ({ project: "fixture", conversationId: "conversation_seat", seatEpoch: 1, engine: "claude" }), reports: () => [],
    send: async ({ text }) => { sent.push(text.split("\n")[0]!); return { status: "delivered", operationId: `operation-${sent.length}` }; } });
  const session = admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const call = (callId: string, name: string, args: Record<string, unknown>, confirmationProposalId?: string) =>
    runCompanionTool({ project: "fixture", sessionId: session.id, callId, delegationId: `delegation-${callId}`, confirmationProposalId, admission, reads, endConversation: () => undefined }, name, args);
  // The default, with the flag null or left out: delivered before the tool answers, and a replayed call adds nothing.
  expect(await call("c1", "request_orchestrator_delegation", { instruction: "Review the plan", confirmation_reason: null })).toMatchObject({ status: "sent", delivery: "delivered" });
  expect(await call("c1", "request_orchestrator_delegation", { instruction: "Review the plan", confirmation_reason: null })).toMatchObject({ status: "sent" });
  expect(await call("c2", "request_orchestrator_delegation", { instruction: "Rerun the checks" })).toMatchObject({ status: "sent" });
  expect(await call("c3", "request_orchestrator_delegation", { instruction: "Merge the lane", confirmation_reason: "   " })).toMatchObject({ status: "sent" });
  expect(sent).toEqual(["Review the plan", "Rerun the checks", "Merge the lane"]);
  // With nothing waiting, an answer resolves nothing.
  expect(await call("c4", "resolve_orchestrator_confirmation", { decision: "send" })).toMatchObject({ status: "nothing_waiting" });
  // The exception: the model's reason, nothing sent, then the operator's yes.
  expect(await call("c5", "request_orchestrator_delegation", { instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." }))
    .toMatchObject({ status: "awaiting_confirmation", reason: "Deleting cannot be undone." });
  expect(sent.length).toBe(3);
  expect(await call("c6", "resolve_orchestrator_confirmation", { decision: "send" })).toMatchObject({ status: "sent", delivery: "delivered" });
  expect(await call("c7", "resolve_orchestrator_confirmation", { decision: "send" })).toMatchObject({ status: "nothing_waiting" });
  expect(sent).toEqual(["Review the plan", "Rerun the checks", "Merge the lane", "Delete the old presets"]);
  // A no sends nothing and the result says so.
  expect(await call("c8", "request_orchestrator_delegation", { instruction: "Stop every agent", confirmation_reason: "I am not sure this is what you meant." })).toMatchObject({ status: "awaiting_confirmation" });
  const declined = await call("c9", "resolve_orchestrator_confirmation", { decision: "cancel" }) as { status: string; code: string; speech: string };
  expect(declined).toMatchObject({ status: "refused", code: "operator_cancelled" });
  expect(declined.speech).toContain("Nothing was sent");
  expect(sent.length).toBe(4);
  for (const args of [{ decision: "maybe" }, { decision: "" }, {}, { decision: "send", proposalId: "x" }])
    await expect(call("c10", "resolve_orchestrator_confirmation", args)).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
  await expect(call("c11", "request_orchestrator_delegation", { instruction: "Review", confirmation_reason: "x".repeat(241) })).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
});

test("a delayed spoken answer stays bound to the proposal included in its backend turn", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const sent: string[] = [];
  const admission = new CompanionAdmission(new CompanionStorage(), { recipient: () => ({ project: "fixture", conversationId: "conversation_seat", seatEpoch: 1, engine: "claude" }), reports: () => [],
    send: async ({ text }) => { sent.push(text.split("\n")[0]!); return { status: "delivered", operationId: `operation-${sent.length}` }; } });
  const session = admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const a = await admission.delegate(session.id, "call-a", "delegation-a", "Delete the old presets", { confirmation: "A needs confirmation." });
  const b = await admission.delegate(session.id, "call-b", "delegation-b", "Deploy the new release", { confirmation: "B needs confirmation." });
  expect(a.state).toBe("awaiting"); expect(b.state).toBe("awaiting");
  const target = a.state === "awaiting" ? a.proposal.proposalId : "missing";
  const result = await runCompanionTool({ project: "fixture", sessionId: session.id, callId: "answer-a", delegationId: "answer-turn-a",
    confirmationProposalId: target, admission, reads, endConversation: () => undefined }, "resolve_orchestrator_confirmation", { decision: "send" }) as { status: string };
  expect(result.status).toBe("sent");
  expect(sent).toEqual(["Delete the old presets"]);
  expect(admission.outcome(session.id, target)).toMatchObject({ state: "sent", status: "delivered" });
  const noSnapshot = await runCompanionTool({ project: "fixture", sessionId: session.id, callId: "answer-none", delegationId: "answer-turn-none",
    confirmationProposalId: null, admission, reads, endConversation: () => undefined }, "resolve_orchestrator_confirmation", { decision: "send" }) as { status: string };
  expect(noSnapshot.status).toBe("nothing_waiting");
  expect(sent).toEqual(["Delete the old presets"]);
  expect(admission.outcome(session.id, b.state === "awaiting" ? b.proposal.proposalId : "missing")).toMatchObject({ state: "awaiting" });
});

test("the model resolves a pending voice confirmation without a server-side consent phrase list", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const sent: string[] = [];
  const admission = new CompanionAdmission(new CompanionStorage(), {
    recipient: () => ({ project: "fixture", conversationId: "conversation_seat", seatEpoch: 1, engine: "codex" }), reports: () => [],
    send: async ({ text }) => { sent.push(text.split("\n")[0]!); return { status: "delivered", operationId: `operation-${sent.length}` }; },
  });
  const session = admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  admission.input(session.id, { itemId: "request", text: "Ask the orchestrator to review the plan.", final: true, turn: 1 });
  const request = await runCompanionTool({ project: "fixture", sessionId: session.id, callId: "proposal", delegationId: "request", sourceTurn: 1,
    admission, reads, endConversation: () => undefined }, "request_orchestrator_delegation",
  { instruction: "Review the plan", confirmation_reason: "Two plans exist." }) as { status: string };
  expect(request.status).toBe("awaiting_confirmation");
  const proposal = admission.awaiting(session.id)!;
  const tooEarly = await runCompanionTool({ project: "fixture", sessionId: session.id, callId: "same-turn", delegationId: "request", sourceTurn: 1,
    confirmationProposalId: proposal.proposalId, admission, reads, endConversation: () => undefined }, "resolve_orchestrator_confirmation", { decision: "send" });
  expect(tooEarly).toMatchObject({ status: "refused", code: "not_confirmed" });
  expect(admission.awaiting(session.id)?.proposalId).toBe(proposal.proposalId);
  expect(sent).toEqual([]);
  admission.input(session.id, { itemId: "answer", text: "Я тебе разрешаю", final: true, turn: 2 });
  const context = { project: "fixture", sessionId: session.id, callId: "answer", delegationId: "answer", sourceTurn: 2,
    confirmationProposalId: proposal.proposalId, admission, reads, endConversation: () => undefined };

  expect(await runCompanionTool(context, "resolve_orchestrator_confirmation", { decision: "send" }))
    .toMatchObject({ status: "sent", delivery: "delivered" });
  expect(sent).toEqual(["Review the plan"]);
  await runCompanionTool(context, "resolve_orchestrator_confirmation", { decision: "send" });
  expect(sent).toEqual(["Review the plan"]);

  admission.input(session.id, { itemId: "request-2", text: "Ask the orchestrator to check the release.", final: true, turn: 3 });
  const second = await admission.delegate(session.id, "proposal-2", "request-2", "Check the release", { sourceTurn: 3, confirmation: "Check the target." });
  if (second.state !== "awaiting") throw new Error("expected a pending confirmation");
  const cancel = await runCompanionTool({ ...context, callId: "cancel", sourceTurn: 4, confirmationProposalId: second.proposal.proposalId },
    "resolve_orchestrator_confirmation", { decision: "cancel" });
  expect(cancel).toMatchObject({ status: "refused", code: "operator_cancelled" });
  expect(sent).toEqual(["Review the plan"]);
});

test("asking first is the model's judgment in the schema: an optional reason, and no list of words anywhere in the registry", () => {
  const tool = COMPANION_TOOLS.find(row => row.name === "request_orchestrator_delegation")!;
  expect(tool.parameters.properties.confirmation_reason).toMatchObject({ type: ["string", "null"] });
  expect(tool.parameters.required).toEqual(["project", "instruction", "confirmation_reason", "asked_again"]);
  expect(tool.parameters.properties.asked_again).toMatchObject({ type: ["string", "null"] });
  expect(tool.description).toContain("delivered at once");
  expect(tool.description).toContain("your own judgment");
  expect(COMPANION_TOOLS.find(row => row.name === "resolve_orchestrator_confirmation")!.parameters.properties.decision).toMatchObject({ enum: ["send", "cancel"] });
});

test("ending the call needs the operator's own explicit request, in English, Ukrainian and Russian", async () => {
  const { explicitEndRequest, liveEndRefusal } = await import("./liveGate");
  for (const said of ["End the call.", "Okay, hang up.", "Could you end the conversation?", "No more questions. End the call.", "Thanks, that's all for today.", "Goodbye!",
    "Заверши розмову.", "Давай закінчимо розмову.", "Завершуй.", "Дякую, бувай.", "Завершить.", "Закончим.", "Давай закончим разговор."])
    expect([said, explicitEndRequest(said)]).toEqual([said, { admit: true }]);
  for (const [said, reason] of [["What is on the board?", "not_requested"], ["Finish the task.", "not_requested"], ["Close the pipeline when it passes.", "not_requested"],
    ["What happens when I end the call?", "conditional"], ["Do I just say “end the call”?", "quoted"], ["If the build is green, end the call.", "conditional"],
    ["End the call when the review is done.", "conditional"], ["Don't hang up.", "negated"], ["Is it time to end the call?", "question"], ["End the call. Actually, wait.", "retracted"], ["End the call. Or is the review still running?", "question"],
    ["Що зараз на дошці?", "not_requested"], ["Заверши завдання.", "not_requested"], ["Закінчи перевірку плану.", "not_requested"], ["Не завершуй розмову.", "negated"],
    ["Якщо все готово, заверши розмову.", "conditional"], ["Чи треба завершити розмову?", "conditional"], ["Він сказав «заверши розмову».", "quoted"],
    ["Закончи задачу.", "not_requested"], ["Если всё готово, закончим разговор.", "conditional"], ["Не заканчивай разговор.", "negated"]] as const)
    expect([said, explicitEndRequest(said)]).toEqual([said, { admit: false, reason }]);
  const turn = (text: string, at: number, final = true) => ({ itemId: `item-${at}`, text, final, turn: at });
  expect(liveEndRefusal([], undefined)).toBeNull(); // nothing on record: the model's reading stands
  expect(liveEndRefusal([turn("End the call.", 1)], 1)).toBeNull();
  expect(liveEndRefusal([turn("End the", 1, false)], 1)).toBe("not_requested");
  expect(liveEndRefusal([turn("End the call.", 1), turn("Thanks.", 2)], 2)).toBeNull(); // a backchannel split the turn
  expect(liveEndRefusal([turn("End the call.", 1), turn("What is on the board?", 2)], 2)).toBe("not_requested");
  expect(liveEndRefusal([turn("End the call.", 1), turn("No, wait, stay.", 2)], 1)).toBe("retracted");
});


test("every delegation refusal code has a concrete sentence", async () => {
  const { DELEGATION_REASONS } = await import("./delegationOutcome");
  for (const reason of Object.values(DELEGATION_REASONS)) {
    expect(reason.length).toBeGreaterThan(15);
    expect(reason).not.toContain("This request was refused");
  }
});


test("read filters reject widened schemas and malformed boolean, integer and status values", async () => {
  const storage = new CompanionStorage();
  const admission = new CompanionAdmission(storage,{recipient:()=>null,reports:()=>[],send:async()=>{throw new Error("unexpected send");}});
  const session = admission.create({project:"fixture",locale:"en",authority:"live-model"});
  const reads = fixtureBoardReads({tasks:()=>[],pipelines:()=>[],activity:async()=>[],messages:async()=>[]});
  const context = {project:"fixture",sessionId:session.id,callId:"read",delegationId:"read",admission,reads,endConversation:()=>undefined};
  for(const args of [{openOnly:"true"},{limit:11},{limit:1.5},{statuses:["running"]},{ids:Array(21).fill("task-a")},{query:"x".repeat(121)},{full:true}])
    await expect(runCompanionTool(context,"list_tasks",args)).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
  expect(await runCompanionTool(context,"list_tasks",{openOnly:true,statuses:["inbox"],limit:10,query:null,ids:null,cursor:null,project:null})).toMatchObject({total:0});
  admission.retire(session.id);
});
