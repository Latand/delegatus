import { expect, test } from "bun:test";
import { CompanionBoardReads, READ_TOOL_NAMES } from "./boardReads";

test("every speech read tool stays on its board, bounds output, and refuses the rest of MCP", async () => {
  const title = "A".repeat(20_000);
  const reads = new CompanionBoardReads({
    tasks: () => [{ id: "task-a", project: "project-a", text: title, status: "blocked", note: { text: title }, hold: { note: title }, steps: [{ text: title, state: "open" }] },
      { id: "task-b", project: "project-b", text: "Foreign work", status: "done" }],
    pipelines: () => [{ id: "pipeline-a", project: "project-a", task: title, state: "running", stages: [{ id: "build", kind: "run" }], runs: [] }],
    activity: async () => [{ conversationId: "conversation_a", project: "project-a", title, lifecycle: "working" },
      { conversationId: "conversation_b", project: "project-b", title: "Foreign agent", lifecycle: "working" }],
    messages: async () => [{ role: "assistant", text: title }, { role: "assistant", text: "Finished the check" }],
  });
  for (const name of READ_TOOL_NAMES) {
    const result = await reads.call("project-a", name, { ...(name === "get_task" ? { taskId: "task-a" } : {}),
      ...(name === "get_pipeline" ? { pipelineId: "pipeline-a" } : {}), ...(name === "conversation_messages" ? { conversationId: "conversation_a" } : {}) });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(8_000);
    expect(JSON.stringify(result)).not.toContain("Foreign");
  }
  await expect(reads.call("project-a", "create_task", {})).rejects.toThrow("TOOL_NOT_ALLOWED");
  await expect(reads.call("project-a", "list_tasks", { project: "project-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "get_task", { taskId: "task-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "conversation_messages", { conversationId: "conversation_b" })).rejects.toThrow("PROJECT_REFUSED");
});
