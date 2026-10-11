import fs from "node:fs";
import { tailRecords } from "@/lib/scanner/activity";
import { recordValue, recordsValue } from "@/lib/scanner/json";
import { isBoardRead, type RelayStepObservation } from "./progressSteps";
import type { AgentRegistry } from "@/lib/agent/registry";
const finalActions = new Set<unknown>(["reply", "ignore", "handoff"]);

export function readOwnerStepObservation(registry: Pick<AgentRegistry, "conversation">, id: string): RelayStepObservation {
  try {
    if (!id.startsWith("conversation_")) return {};
    const generation = registry.conversation(id as `conversation_${string}`)?.generations.at(-1);
    return generation ? readRelayStepObservation(generation.path) : {};
  } catch {
    return {}; // Optional progress cannot turn an otherwise healthy owner run into a failure.
  }
}

/** Only tool identity and final-message boundaries leave the transcript reader. */
export function stepObservationFromRecords(records: Record<string, unknown>[]): RelayStepObservation {
  const pending = new Map<string, string>();
  let writingAnswer = false;
  const start = (id: unknown, name: unknown) => {
    if (typeof id === "string" && typeof name === "string") pending.set(id, name);
    writingAnswer = false;
  };
  const done = (id: unknown) => { if (typeof id === "string") pending.delete(id); };
  for (const row of records) {
    const payload = recordValue(row.payload) ?? row;
    if (payload.type === "task_started" || payload.type === "turn_started" || row.type === "user" && !recordsValue(recordValue(row.message)?.content).some(b => b.type === "tool_result")) {
      pending.clear(); writingAnswer = false;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") start(payload.call_id, payload.name);
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") done(payload.call_id);
    if (payload.type === "web_search_call" || payload.type === "local_shell_call") {
      const id = payload.call_id ?? payload.id;
      if (payload.status === "completed") done(id);
      else start(id, "native_tool");
    }
    if (payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer"
      || payload.type === "agent_message" && payload.phase === "final_answer" || payload.type === "task_complete") writingAnswer = true;
    const item = recordValue(row.item);
    if (row.type === "item.started" && item?.type === "web_search") start(item.id ?? "search", "web_search");
    if (row.type === "item.completed" && item?.type === "web_search") done(item.id ?? "search");
    if (item?.type === "agent_message" && (row.type === "item.started" || row.type === "item.updated" || row.type === "item.completed")) {
      // Intermediate JSON tool proposals do not start the final reply.
      if (item.phase === "final_answer" || typeof item.text === "string" && /"action"\s*:\s*"(?:reply|ignore|handoff)"/.test(item.text)) writingAnswer = true;
    }
    const message = recordValue(row.message);
    if (row.type === "result" && finalActions.has(recordValue(row.structured_output)?.action)) writingAnswer = true;
    const blocks = recordsValue(message?.content);
    if (row.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use") {
          if (block.name === "StructuredOutput") writingAnswer = finalActions.has(recordValue(block.input)?.action);
          else start(block.id, block.name === "WebSearch" ? "web_search" : block.name);
        }
      }
      if (message?.stop_reason === "end_turn" && blocks.some(b => b.type === "text") && !blocks.some(b => b.type === "tool_use")) writingAnswer = true;
    }
    for (const block of blocks) if (block.type === "tool_result") done(block.tool_use_id);
  }
  const tools = [...pending.values()];
  return { currentTool: tools.find(tool => !isBoardRead(tool)) ?? tools[0] ?? null, writingAnswer };
}
export function readRelayStepObservation(file: string): RelayStepObservation {
  try {
    const stat = fs.statSync(file);
    return stepObservationFromRecords(tailRecords(file, stat.size, stat.mtimeMs));
  } catch {
    return {}; // Progress is optional; lifecycle observation still owns failures.
  }
}
