import { expect, test } from "bun:test";
import { classifyAgentActivity } from "./agentActivity";
import { activityFactsFromRecords } from "./agentActivityEvidence";
const now = 1_800_000_000_000;
const stamp = (age: number) => new Date(now - age).toISOString();
test("sleep loop stays checking during the open sleep and between completed iterations", () => {
  const call = { timestamp: stamp(70_000), type: "response_item", payload: { type: "function_call", name: "sleep", call_id: "sleep-one", arguments: '{"duration_ms":50000}' } };
  expect(classifyAgentActivity(activityFactsFromRecords([call]), now).state).toBe("checking");
  const output = { timestamp: stamp(20_000), type: "response_item", payload: { type: "function_call_output", call_id: "sleep-one", output: "done" } };
  expect(classifyAgentActivity(activityFactsFromRecords([call, output]), now).state).toBe("checking");
  expect(classifyAgentActivity(activityFactsFromRecords([call, output]), now + 181_000).state).toBe("working");
});
test("Claude shell watch and blocking TaskOutput are checks", () => {
  for (const tool of [{ name: "Bash", input: { command: "sleep 55 && gh pr checks 1 --watch" } }, { name: "TaskOutput", input: { block: true } }]) {
    const records = [{ timestamp: stamp(700_000), type: "assistant", message: { content: [{ type: "tool_use", id: "one", ...tool }] } }];
    expect(classifyAgentActivity(activityFactsFromRecords(records, now), now).state).toBe("checking");
  }
});
test("real idle at ten minutes; pre-turn MCP and short children are excluded; a long check supplies its name", () => {
  const facts = { lastRecordAt: now - 660_000, turnStartedAt: now - 900_000, workProcesses: [{ startedAt: now - 1_000_000, command: "bun bin/mcp-server.mjs" }] };
  expect(classifyAgentActivity(facts, now)).toEqual({ state: "idle", check: null, idleForMs: 660_000 });
  expect(classifyAgentActivity({ ...facts, lastRecordAt: now - 540_000 }, now).state).toBe("working");
  expect(classifyAgentActivity({ ...facts, workProcesses: [{ startedAt: now - 29_000, command: "rg foo" }] }, now).state).toBe("idle");
  expect(classifyAgentActivity({ ...facts, workProcesses: [{ startedAt: now - 60_000, command: "bun scripts/privacy-publication-gate.ts --base main" }] }, now)).toEqual({ state: "checking", check: "privacy-publication-gate", idleForMs: null });
});
test("pending background command holds checking until its completion", () => {
  const records = [{ type: "user", timestamp: stamp(700_000), toolUseResult: { backgroundTaskId: "background-one" }, message: { content: [{ type: "tool_result", tool_use_id: "shell-one", content: "background running" }] } }];
  expect(classifyAgentActivity(activityFactsFromRecords(records, now), now).state).toBe("checking");
  const end = { type: "user", timestamp: stamp(650_000), message: { content: "<task-notification><task-id>background-one</task-id><status>completed</status></task-notification>" } };
  expect(classifyAgentActivity(activityFactsFromRecords([...records, end], now), now).state).toBe("idle");
});


test("a retained foreground call supplies the process start bound after the initiating prompt leaves the tail", () => {
  const facts = activityFactsFromRecords([{ type: "response_item", timestamp: stamp(660_000), payload: { type: "function_call", name: "exec_command", call_id: "check-one", arguments: '{"cmd":"bun test check.test.ts"}' } }], now);
  expect(classifyAgentActivity({ ...facts, workProcesses: [{ startedAt: now - 659_000, command: "rtk proxy bun test check.test.ts" }] }, now)).toMatchObject({ state: "checking", check: "bun test check.test.ts" });
});


test("a later completed non-wait call ends the recent sleep-loop reading", () => {
  const records = [
    { type: "response_item", timestamp: stamp(80_000), payload: { type: "function_call", name: "sleep", call_id: "sleep-one", arguments: "{}" } },
    { type: "response_item", timestamp: stamp(30_000), payload: { type: "function_call_output", call_id: "sleep-one", output: "done" } },
    { type: "response_item", timestamp: stamp(20_000), payload: { type: "function_call", name: "Read", call_id: "read-one", arguments: "{}" } },
    { type: "response_item", timestamp: stamp(10_000), payload: { type: "function_call_output", call_id: "read-one", output: "file" } },
  ];
  expect(classifyAgentActivity(activityFactsFromRecords(records, now), now).state).toBe("working");
});


test("native Codex exec wrappers expose awaited sleep and polling calls", () => {
  for (const code of ['await tools.clock__sleep({duration_ms:50000});', 'await tools.write_stdin({session_id:42});']) {
    const records = [{ type: "response_item", timestamp: stamp(660_000), payload: { type: "custom_tool_call", name: "functions.exec", call_id: "wait-one", input: code } }];
    expect(classifyAgentActivity(activityFactsFromRecords(records, now), now).state).toBe("checking");
  }
});
