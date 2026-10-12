import fs from "node:fs";
import { tailRecordsResult } from "@/lib/scanner/activity";
import { recordValue, recordsValue } from "@/lib/scanner/json";
import { isBoardRead, type RelayStepObservation } from "./progressSteps";
import type { AgentRegistry } from "@/lib/agent/registry";

const finalActions = new Set<unknown>(["reply", "ignore", "handoff"]);
type ObservationState = { pending: Map<string, string>; writingAnswer: boolean; uncertain: boolean };
type CachedObservation = ObservationState & { size: number; mtimeMs: number; dev: number; ino: number; partial: string };
const observations = new Map<string, CachedObservation>();
const OBSERVATION_CACHE_LIMIT = 256;

function emptyState(): ObservationState {
  return { pending: new Map(), writingAnswer: false, uncertain: false };
}

function callName(payload: Record<string, unknown>): string | null {
  if (typeof payload.name !== "string") return null;
  if (typeof payload.namespace !== "string" || !payload.namespace) return payload.name;
  return `${payload.namespace.replace(/_+$/, "")}__${payload.name}`;
}

function currentObservation(state: ObservationState, partialRecord = false): RelayStepObservation {
  const tools = [...state.pending.values()];
  return {
    currentTool: tools.find(tool => !isBoardRead(tool)) ?? tools[0] ?? (state.uncertain || partialRecord ? "native_tool" : null),
    writingAnswer: state.writingAnswer,
  };
}

function applyRecords(state: ObservationState, records: Record<string, unknown>[]): void {
  const start = (id: unknown, name: unknown) => {
    if (typeof id === "string" && typeof name === "string") state.pending.set(id, name);
    state.writingAnswer = false;
  };
  const done = (id: unknown) => { if (typeof id === "string") state.pending.delete(id); };
  for (const row of records) {
    const payload = recordValue(row.payload) ?? row;
    if (payload.type === "task_started" || payload.type === "turn_started" || row.type === "user" && !recordsValue(recordValue(row.message)?.content).some(b => b.type === "tool_result")) {
      state.pending.clear(); state.writingAnswer = false; state.uncertain = false;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") start(payload.call_id, callName(payload));
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") done(payload.call_id);
    if (payload.type === "web_search_call" || payload.type === "local_shell_call") {
      const id = payload.call_id ?? payload.id;
      if (payload.status === "completed") done(id);
      else start(id, "native_tool");
    }
    if (payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer"
      || payload.type === "agent_message" && payload.phase === "final_answer" || payload.type === "task_complete") state.writingAnswer = true;
    const item = recordValue(row.item);
    if (row.type === "item.started" && item?.type === "web_search") start(item.id ?? "search", "web_search");
    if (row.type === "item.completed" && item?.type === "web_search") done(item.id ?? "search");
    if (item?.type === "agent_message" && (row.type === "item.started" || row.type === "item.updated" || row.type === "item.completed")) {
      // Intermediate JSON tool proposals do not start the final reply.
      if (item.phase === "final_answer" || typeof item.text === "string" && /"action"\s*:\s*"(?:reply|ignore|handoff)"/.test(item.text)) state.writingAnswer = true;
    }
    const message = recordValue(row.message);
    if (row.type === "result" && finalActions.has(recordValue(row.structured_output)?.action)) state.writingAnswer = true;
    const blocks = recordsValue(message?.content);
    if (row.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use") {
          if (block.name === "StructuredOutput") state.writingAnswer = finalActions.has(recordValue(block.input)?.action);
          else start(block.id, block.name === "WebSearch" ? "web_search" : block.name);
        }
      }
      if (message?.stop_reason === "end_turn" && blocks.some(b => b.type === "text") && !blocks.some(b => b.type === "tool_use")) state.writingAnswer = true;
    }
    for (const block of blocks) if (block.type === "tool_result") done(block.tool_use_id);
  }
}

function cacheObservation(file: string, state: ObservationState, partial: string, stat: fs.Stats, size = stat.size): void {
  observations.delete(file);
  while (observations.size >= OBSERVATION_CACHE_LIMIT) {
    const oldest = observations.keys().next().value;
    if (oldest === undefined) break;
    observations.delete(oldest);
  }
  observations.set(file, { ...state, size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino, partial });
}

function unfinishedTail(file: string, stat: fs.Stats): string | null {
  if (stat.size === 0) return "";
  const length = Math.min(stat.size, 131_072);
  const start = stat.size - length;
  const fd = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) return null;
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(fd, bytes, read, length - read, start + read);
      if (!count) return null;
      read += count;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
    if (bytes[length - 1] === 0x0a) return "";
    const lineStart = bytes.lastIndexOf(0x0a) + 1;
    if (lineStart === 0 && start > 0) return null;
    return bytes.subarray(lineStart).toString("utf8");
  } finally { fs.closeSync(fd); }
}

/** Only tool identity and final-message boundaries leave the transcript reader. */
export function stepObservationFromRecords(records: Record<string, unknown>[]): RelayStepObservation {
  const state = emptyState();
  applyRecords(state, records);
  return currentObservation(state);
}

export function readRelayStepObservation(file: string): RelayStepObservation {
  try {
    const stat = fs.statSync(file);
    const cached = observations.get(file);
    if (cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.size <= stat.size
      && (cached.size < stat.size || cached.mtimeMs === stat.mtimeMs)) {
      const fd = fs.openSync(file, "r");
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== cached.dev || opened.ino !== cached.ino || opened.size !== stat.size) return currentObservation(cached);
        const bytes = Buffer.alloc(stat.size - cached.size);
        let read = 0;
        while (read < bytes.length) {
          const count = fs.readSync(fd, bytes, read, bytes.length - read, cached.size + read);
          if (!count) return currentObservation(cached);
          read += count;
        }
        const after = fs.fstatSync(fd);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return currentObservation(cached);
        const state: ObservationState = { pending: new Map(cached.pending), writingAnswer: cached.writingAnswer, uncertain: cached.uncertain };
        const lines = `${cached.partial}${bytes.toString("utf8")}`.split("\n");
        const partial = lines.pop() ?? "";
        const records: Record<string, unknown>[] = [];
        let parseFailed = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let value: unknown;
          try { value = JSON.parse(line); }
          catch { parseFailed = true; break; }
          if (value && typeof value === "object" && !Array.isArray(value)) records.push(value as Record<string, unknown>);
        }
        if (parseFailed) {
          observations.delete(file);
          return currentObservation(cached, true);
        }
        applyRecords(state, records);
        cacheObservation(file, state, partial, stat);
        return currentObservation(state, Boolean(partial));
      } finally { fs.closeSync(fd); }
    }

    const tail = tailRecordsResult(file, stat.size, stat.mtimeMs);
    const state = emptyState();
    state.uncertain = tail.prefixTruncated;
    applyRecords(state, tail.records);
    const partial = unfinishedTail(file, stat);
    if (partial === null) return currentObservation(state, true);
    cacheObservation(file, state, partial, stat, stat.size - Buffer.byteLength(partial));
    return currentObservation(state, Boolean(partial));
  } catch {
    return {}; // Progress is optional; lifecycle observation still owns failures.
  }
}

export function readOwnerStepObservation(registry: Pick<AgentRegistry, "conversation">, id: string): RelayStepObservation {
  try {
    if (!id.startsWith("conversation_")) return {};
    const generation = registry.conversation(id as `conversation_${string}`)?.generations.at(-1);
    return generation ? readRelayStepObservation(generation.path) : {};
  } catch {
    return {}; // Optional progress cannot turn an otherwise healthy owner run into a failure.
  }
}
