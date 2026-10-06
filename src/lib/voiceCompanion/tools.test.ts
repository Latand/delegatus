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
