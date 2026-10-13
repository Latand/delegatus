import { expect, test } from "bun:test";
import { createRelaySteps, isBoardRead, relayStepFor } from "./progressSteps";
import { stepObservationFromRecords } from "./stepObservation";

test("the descriptor gates steps independently of the legacy note preference", () => {
  for (const features of [undefined, [], ["relay_tools"], ["progress_steps_future"]]) expect(createRelaySteps(features)).toBeNull();
  expect(createRelaySteps(["progress_steps"])).not.toBeNull();
});

test("only explicit viewer reads map to reading_board; other tools map to working", () => {
  expect(relayStepFor({ queued: true, writingAnswer: true, currentTool: "Bash" })).toBe("queued");
  expect(relayStepFor({})).toBe("thinking");
  expect(relayStepFor({ currentTool: null })).toBe("thinking");
  for (const tool of ["mcp__viewer__list_tasks", "mcp__viewer__get_pipeline", "viewer.board_snapshot", "mcp__viewer__read_prototype_review"])
    expect(relayStepFor({ currentTool: tool })).toBe("reading_board");
  for (const tool of ["list_tasks", "web_search", "Bash", "mcp__other__get_task", "mcp__viewer__create_task", "mcp__viewer__seat_tick_settings", "mcp__viewer__agent_activity", "mcp__viewer__lifecycle_events", "mcp__viewer__get_unknown"])
    expect(relayStepFor({ currentTool: tool })).toBe("working");
  expect(isBoardRead("mcp__viewer__get_task unexpected arguments")).toBe(false);
  expect(relayStepFor({ currentTool: "Bash", writingAnswer: true })).toBe("writing_answer");
});

test("seq one is accepted even after observation; changes wait three seconds from every beat", () => {
  const steps = createRelaySteps(["progress_steps"])!;
  steps.observe({ currentTool: "Bash" });
  expect(steps.beat(1, 0, false)?.label).toBe("accepted");
  expect(steps.changeDue(2999)).toBe(false);
  expect(steps.changeDue(3000)).toBe(true);
  expect(steps.beat(2, 3000, true)?.label).toBe("working");
  expect(steps.changeDue(9000)).toBe(false);
  steps.observe({ currentTool: "mcp__viewer__get_task" });
  steps.observe({ currentTool: "Bash" });
  expect(steps.changeDue(9000)).toBe(false); // Coalesce an unsent transient change.
  expect(steps.beat(3, 9000, false)).toBeNull();
  steps.observe({ writingAnswer: true });
  expect(steps.changeDue(11999)).toBe(false);
  expect(steps.beat(4, 12000, false)).toBeNull(); // Regular beats never carry a step.
  expect(steps.changeDue(14999)).toBe(false);
  expect(steps.beat(5, 15000, true)?.label).toBe("writing_answer");
  expect(steps.changeDue(18000)).toBe(false);
});

test("failed attempts and regular beats both consume the change interval", () => {
  const steps = createRelaySteps(["progress_steps"])!;
  steps.beat(1, 0, false); // Scheduling counts sends, regardless of their acknowledgement.
  expect(steps.beat(2, 2000, true)).toBeNull();
  expect(steps.changeDue(4999)).toBe(false);
  expect(steps.beat(3, 5000, true)?.label).toBe("thinking");
});

test("every generated progress is in the closed set and contains no observed host data", () => {
  const steps = createRelaySteps(["progress_steps"])!;
  const forbidden = "private fixture arguments and content";
  const observations = [{}, { currentTool: "mcp__viewer__get_task" }, { currentTool: forbidden }, { writingAnswer: true }, {}];
  const beats = [steps.beat(1, 0, false)];
  for (const [i, observation] of observations.entries()) {
    const withHostData = { ...observation, path: forbidden, text: forbidden };
    steps.observe(withHostData);
    beats.push(steps.beat(i + 2, (i + 1) * 3000, true));
  }
  expect(beats.map(p => p?.label)).toEqual(["accepted", "thinking", "reading_board", "working", "writing_answer", "thinking"]);
  for (const progress of beats) {
    expect(Object.keys(progress!)).toEqual(["kind", "label", "tool", "status", "at"]);
    expect(progress).toMatchObject({ kind: "step", tool: null, status: null });
    expect(progress!.at).toMatch(/Z$/);
  }
  expect(JSON.stringify(beats)).not.toContain(forbidden);
});

test("Codex transcript pairs calls by id, retains concurrent tools, and detects the final boundary", () => {
  const records: Record<string, unknown>[] = [{ type: "event_msg", payload: { type: "task_started" } }];
  const add = (payload: Record<string, unknown>) => records.push({ type: "response_item", payload });
  add({ type: "function_call", call_id: "board", name: "mcp__viewer__get_task", arguments: "private content" });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("reading_board");
  add({ type: "custom_tool_call", call_id: "shell", name: "exec_command", input: "private content" });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("working");
  add({ type: "custom_tool_call_output", call_id: "shell", output: "private content" });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("reading_board");
  add({ type: "function_call_output", call_id: "board", output: "private content" });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("thinking");
  add({ type: "message", role: "assistant", phase: "commentary", content: [{ text: "private content" }] });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("thinking");
  add({ type: "message", role: "assistant", phase: "final_answer", content: [{ text: "private content" }] });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("writing_answer");
  records.push({ type: "event_msg", payload: { type: "task_started" } });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("thinking");
  expect(JSON.stringify(stepObservationFromRecords(records))).not.toContain("private content");
  add({ type: "web_search_call", id: "search", status: "in_progress", action: { query: "private content" } });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("working");
  add({ type: "web_search_call", id: "search", status: "completed" });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("thinking");
});

test("Claude pairs tool results and reserves end_turn text for writing_answer", () => {
  const records: Record<string, unknown>[] = [{ type: "assistant", message: { content: [
    { type: "text", text: "private content" }, { type: "tool_use", id: "read", name: "mcp__viewer__list_tasks", input: { private: true } },
  ], stop_reason: "tool_use" } }];
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("reading_board");
  records.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "private content" }] } });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("thinking");
  records.push({ type: "assistant", message: { content: [{ type: "text", text: "Reply" }], stop_reason: "end_turn" } });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("writing_answer");
});

test("member stdout recognizes native search and final output while proposals stay thinking", () => {
  const records: Record<string, unknown>[] = [{ type: "item.started", item: { type: "web_search", id: "search", query: "private content" } }];
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("working");
  records.push({ type: "item.completed", item: { type: "web_search", id: "search" } });
  records.push({ type: "item.completed", item: { type: "agent_message", text: '{"kind":"tool_calls","calls":[]}' } });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("thinking");
  records.push({ type: "item.started", item: { type: "agent_message", text: '{"action":"reply"' } });
  expect(relayStepFor(stepObservationFromRecords(records))).toBe("writing_answer");
  expect(relayStepFor(stepObservationFromRecords([{ type: "assistant", message: { content: [
    { type: "tool_use", id: "output", name: "StructuredOutput", input: { action: "reply", text: "private content" } },
  ] } }]))).toBe("writing_answer");
  for (const action of ["call", "unexpected"]) {
    expect(relayStepFor(stepObservationFromRecords([{ type: "assistant", message: { content: [
      { type: "tool_use", id: "output", name: "StructuredOutput", input: { action } },
    ] } }]))).toBe("thinking");
    expect(relayStepFor(stepObservationFromRecords([{ type: "result", structured_output: { action } }]))).toBe("thinking");
  }
});
