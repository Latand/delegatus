import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { relayStepFor } from "./progressSteps";
import { readRelayStepObservation, stepObservationFromRecords } from "./stepObservation";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-native-observation-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function record(type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "response_item", payload: { type, ...payload } })}\n`;
}

test("native namespaced and flat viewer reads are classified while other tools and namespaces stay working", () => {
  const namespaced = stepObservationFromRecords([{ payload: {
    type: "function_call", namespace: "mcp__viewer", name: "get_task", call_id: "board",
  } }]);
  const flat = stepObservationFromRecords([{ payload: {
    type: "function_call", name: "mcp__viewer__get_task", call_id: "flat-board",
  } }]);
  const otherNamespace = stepObservationFromRecords([{ payload: {
    type: "function_call", namespace: "mcp__other", name: "get_task", call_id: "other-board",
  } }]);
  const viewerWrite = stepObservationFromRecords([{ payload: {
    type: "function_call", namespace: "mcp__viewer", name: "update_task", call_id: "write",
  } }]);

  expect(relayStepFor(namespaced)).toBe("reading_board");
  expect(relayStepFor(flat)).toBe("reading_board");
  expect(relayStepFor(otherNamespace)).toBe("working");
  expect(relayStepFor(viewerWrite)).toBe("working");
});

test("pending calls survive a concurrent result larger than the transcript tail", () => {
  const file = path.join(root, "concurrent.jsonl");
  fs.writeFileSync(file, record("task_started", {})
    + record("function_call", { namespace: "mcp__viewer", name: "get_task", call_id: "board" })
    + record("function_call", { name: "exec_command", call_id: "shell" }));
  expect(relayStepFor(readRelayStepObservation(file))).toBe("working");

  fs.appendFileSync(file, record("function_call_output", { call_id: "board", output: "x".repeat(140_000) }));
  expect(fs.statSync(file).size).toBeGreaterThan(131_072);
  expect(readRelayStepObservation(file).currentTool).toBe("exec_command");
  expect(relayStepFor(readRelayStepObservation(file))).toBe("working");
});

test("a pending board read remains reading_board after a large concurrent result", () => {
  const file = path.join(root, "board-pending.jsonl");
  fs.writeFileSync(file, record("task_started", {})
    + record("function_call", { name: "exec_command", call_id: "shell" })
    + record("function_call", { namespace: "mcp__viewer", name: "get_task", call_id: "board" }));
  expect(relayStepFor(readRelayStepObservation(file))).toBe("working");

  fs.appendFileSync(file, record("function_call_output", { call_id: "shell", output: "x".repeat(140_000) }));
  expect(fs.statSync(file).size).toBeGreaterThan(131_072);
  expect(relayStepFor(readRelayStepObservation(file))).toBe("reading_board");
});

test("a truncated initial tail cannot claim that no tool is pending", () => {
  const file = path.join(root, "truncated-start.jsonl");
  fs.writeFileSync(file, record("function_call", { name: "exec_command", call_id: "older" })
    + record("function_call_output", { call_id: "older", output: "x".repeat(140_000) }));
  expect(relayStepFor(readRelayStepObservation(file))).toBe("working");
});

test("a cold poll retains an unfinished row and observes its completion and final answer", () => {
  const file = path.join(root, "partial-start.jsonl");
  const call = record("task_started", {})
    + JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "shell", name: "exec_command" } });
  const split = call.indexOf('"name"') + 3;
  fs.writeFileSync(file, call.slice(0, split));
  expect(relayStepFor(readRelayStepObservation(file))).toBe("working");

  fs.appendFileSync(file, call.slice(split) + "\n");
  expect(relayStepFor(readRelayStepObservation(file))).toBe("working");

  fs.appendFileSync(file, record("function_call_output", { call_id: "shell" })
    + record("message", { role: "assistant", phase: "final_answer" }));
  expect(relayStepFor(readRelayStepObservation(file))).toBe("writing_answer");
});

test("a malformed incremental row does not poison observations of later valid rows", () => {
  const file = path.join(root, "malformed-increment.jsonl");
  fs.writeFileSync(file, record("task_started", {}));
  expect(relayStepFor(readRelayStepObservation(file))).toBe("thinking");

  fs.appendFileSync(file, "{broken}\n");
  readRelayStepObservation(file);
  fs.appendFileSync(file, record("function_call", { name: "exec_command", call_id: "shell" }));
  expect(relayStepFor(readRelayStepObservation(file))).toBe("working");
});
