import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionBoardReads } from "./boardReads";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-registry-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
const { COMPANION_TOOL_REGISTRY, COMPANION_TOOLS, runCompanionTool } = await import("./tools");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("all eight declarations execute through one allowlist, parameter schema and project fence", async () => {
  let ended = false;
  const admission = new CompanionAdmission(new CompanionStorage(), { recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected delivery"); } });
  const session = admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  const reads = new CompanionBoardReads({ tasks: () => [{ id: "task-a", project: "fixture", text: "A task", status: "open" }, { id: "task-b", project: "foreign", text: "Foreign", status: "open" }],
    pipelines: () => [{ id: "pipeline-a", project: "fixture", task: "A pipeline", state: "running", stages: [], runs: [] }],
    activity: async () => [{ conversationId: "conversation_a", project: "fixture", title: "Agent", lifecycle: "running" }], messages: async () => [{ role: "assistant", text: "Checked it" }] });
  const context = { project: "fixture", sessionId: session.id, callId: "call-a", delegationId: "delegation-a", admission, reads, endConversation: () => { ended = true; } };
  const args: Record<string, Record<string, unknown>> = { list_tasks: {}, get_task: { taskId: "task-a" }, list_pipelines: {}, get_pipeline: { pipelineId: "pipeline-a" },
    agent_activity: {}, conversation_messages: { conversationId: "conversation_a" }, request_orchestrator_delegation: { instruction: "Review it" }, end_conversation: {} };
  expect(COMPANION_TOOLS.map(row => row.name)).toEqual(COMPANION_TOOL_REGISTRY.map(row => row.name));
  for (const tool of COMPANION_TOOL_REGISTRY) {
    expect(await runCompanionTool(context, tool.name, args[tool.name])).toBeDefined();
    await expect(runCompanionTool({ ...context, project: "foreign" }, tool.name, args[tool.name])).rejects.toThrow("PROJECT_REFUSED");
    await expect(runCompanionTool(context, tool.name, { ...args[tool.name], project: "foreign" })).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
  }
  expect(ended).toBe(true);
  await expect(runCompanionTool(context, "send_message", {})).rejects.toThrow("TOOL_NOT_ALLOWED");
  await expect(runCompanionTool(context, "get_task", { taskId: "task-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(runCompanionTool(context, "get_task", {})).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
  admission.retire(session.id);
  await expect(runCompanionTool(context, "end_conversation", {})).rejects.toThrow("SESSION_CLOSED");
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
