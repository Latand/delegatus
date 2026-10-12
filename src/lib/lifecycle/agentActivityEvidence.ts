import { emptyBackgroundTaskLedger, foldBackgroundTaskRecords, pendingBackgroundTasks } from "@/lib/pipelines/backgroundTasks";
import { recordValue, recordsValue } from "@/lib/scanner/json";
import { lastTurnFromRecords } from "@/lib/scanner/turnDuration";
import { checkCommand, waitShapedCall, type AgentActivityFacts } from "./agentActivity";

/** Native tool identities keep concurrent calls and their results separate. */
export function activityFactsFromRecords(records: Record<string, unknown>[], nowMs = Date.now()): AgentActivityFacts {
  const calls = new Map<string, { call: NonNullable<AgentActivityFacts["openCall"]>; at: number }>();
  const taskLabels = new Map<string, string>();
  let lastRecordAt: number | null = null;
  const codex = records.some(record => record.type === "response_item" || record.type === "event_msg");
  const opening = records.find(record => {
    const payload = recordValue(record.payload);
    return payload?.type === "task_started" || payload?.type === "function_call" || payload?.type === "custom_tool_call"
      || recordsValue(recordValue(record.message)?.content).some(part => part.type === "tool_use");
  });
  const openingAt = Date.parse(String(opening?.timestamp ?? ""));
  // A retained call predates the process it launched, even when the prompt
  // that opened the turn has scrolled out of the bounded tail.
  const turnStartedAt = lastTurnFromRecords(records, codex)?.startedAt ?? (Number.isFinite(openingAt) ? openingAt : null);
  let recentWait: AgentActivityFacts["recentWait"] = null;
  const complete = (id: unknown, at: number) => {
    if (typeof id !== "string") return;
    const entry = calls.get(id);
    if (entry && !waitShapedCall(entry.call)) recentWait = null;
    if (entry && waitShapedCall(entry.call)) {
      const command = entry.call.input.command ?? entry.call.input.cmd;
      recentWait = { finishedAt: at, command: typeof command === "string" ? checkCommand(command) : null };
    }
    calls.delete(id);
  };
  for (const record of records) {
    const at = Date.parse(String(record.timestamp ?? ""));
    if (Number.isFinite(at)) lastRecordAt = Math.max(lastRecordAt ?? 0, at);
    const payload = recordValue(record.payload);
    if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
      let input: Record<string, unknown> = {};
      try { input = recordValue(JSON.parse(String(payload.arguments ?? payload.input ?? "{}"))) ?? {}; } catch { input = { code: String(payload.arguments ?? payload.input ?? "") }; }
      if (typeof payload.call_id === "string" && typeof payload.name === "string") calls.set(payload.call_id, { call: { name: payload.name, input }, at });
    } else if (payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") complete(payload.call_id, at);
    for (const part of recordsValue(recordValue(record.message)?.content)) {
      if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") calls.set(part.id, { call: { name: part.name, input: recordValue(part.input) ?? {} }, at });
      if (part.type === "tool_result") {
        const taskId = recordValue(record.toolUseResult)?.backgroundTaskId;
        const call = typeof part.tool_use_id === "string" ? calls.get(part.tool_use_id)?.call : null;
        const label = call?.input.description ?? call?.input.command;
        if (typeof taskId === "string" && typeof label === "string") taskLabels.set(taskId, label.slice(0, 80));
        complete(part.tool_use_id, at);
      }
    }
  }
  const openCall = [...calls.values()].sort((a,b) => b.at - a.at).find(p => waitShapedCall(p.call))?.call ?? [...calls.values()].at(-1)?.call ?? null;
  const background = pendingBackgroundTasks(foldBackgroundTaskRecords(emptyBackgroundTaskLedger(), records), nowMs).filter(t => t.kind !== "wakeup").map(task => ({ id: task.id, description: taskLabels.get(task.id) ?? null }));
  return { lastRecordAt, turnStartedAt, openCall, recentWait, background };
}
