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

test("no read field carries a machine path to the model, the card or speech, and what is useful stays", async () => {
  // Built from parts: a path of this shape never stands in the source.
  const home = ["", "home", "fixture-operator"].join("/");
  const paths = [`${home}/.config/delegatus/state/tasks.json`, `${home}/.claude/projects/-fixture/session.jsonl`, "~/Projects/fixture-wt/handoff",
    ["", "tmp", "fixture-worktree", "src"].join("/"), `file://${home}/notes.md`, ["C:", "Users", "fixture", "notes"].join("\\"),
    // A root file and a drive file are machine paths too.
    ["", "secret.txt"].join("/"), ["C:", "private.txt"].join("\\")];
  const text = (label: string) => `${label} see ${paths.join(" and ")} then src/lib/x.ts and https://example.test/a/b`;
  const reads = new CompanionBoardReads({
    tasks: () => [{ id: "task-a", project: "project-a", text: text("Title"), status: "blocked", note: { text: text("Note") }, hold: { note: text("Hold") }, steps: [{ text: text("Step"), state: "open" }] }],
    pipelines: () => [{ id: "pipeline-a", project: "project-a", task: text("Pipeline"), state: "running", stages: [{ id: "build", kind: "run" }], runs: [] }],
    activity: async () => [{ conversationId: "conversation_a", project: "project-a", title: text("Agent"), lifecycle: "working" }],
    messages: async () => [{ role: "assistant", text: text("Message") }],
  });
  const labels: Record<string, string> = { list_tasks: "Title", get_task: "Note", list_pipelines: "Pipeline", get_pipeline: "Pipeline", agent_activity: "Agent", conversation_messages: "Message" };
  for (const name of READ_TOOL_NAMES) {
    const result = JSON.stringify(await reads.call("project-a", name, { ...(name === "get_task" ? { taskId: "task-a" } : {}),
      ...(name === "get_pipeline" ? { pipelineId: "pipeline-a" } : {}), ...(name === "conversation_messages" ? { conversationId: "conversation_a" } : {}) }));
    for (const leak of ["fixture-operator", "fixture-wt", "fixture-worktree", ".config", ".claude", "Users", "/home", "file:", "secret.txt", "private.txt"]) expect([name, leak, result.includes(leak)]).toEqual([name, leak, false]);
    expect(result).toContain(`${labels[name]} see [path]`);
  }
  const task = await reads.call("project-a", "get_task", { taskId: "task-a" });
  expect(task.item).toMatchObject({ hold: expect.stringContaining("Hold see [path]"), steps: [{ text: expect.stringContaining("Step see [path]") }] });
  expect(task.speech).toContain("src/lib/x.ts");
  expect(task.speech).toContain("https://example.test/a/b");
  await expect(reads.call("project-b", "get_task", { taskId: "task-a" })).rejects.toThrow("PROJECT_REFUSED");
});
