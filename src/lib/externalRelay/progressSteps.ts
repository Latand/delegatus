import type { ExternalRelayStepId, ExternalRelayStepProgress } from "./protocol";

export type RelayStepObservation = { queued?: boolean; currentTool?: string | null; writingAnswer?: boolean };

// Explicit reads: a new or mixed read/write tool defaults to working.
const boardReads = new Set([
  "board_snapshot", "list_tasks", "get_task", "list_pipelines", "get_pipeline",
  "list_flows", "get_flow", "read_prototype_review", "list_conversations",
  "get_conversation", "conversation_messages", "conversation_deliverability",
  "search_transcripts", "search_memory", "message_receipt", "deployment_status", "resources",
  "get_orchestrator", "account_limits", "operator_snapshot",
]);
export function isBoardRead(tool: string): boolean {
  const name = tool.startsWith("mcp__viewer__") ? tool.slice("mcp__viewer__".length)
    : tool.startsWith("viewer.") ? tool.slice("viewer.".length) : null;
  return name !== null && boardReads.has(name);
}
export function relayStepFor(observed: RelayStepObservation): ExternalRelayStepId {
  if (observed.queued) return "queued";
  if (observed.writingAnswer) return "writing_answer";
  if (!observed.currentTool) return "thinking";
  return isBoardRead(observed.currentTool) ? "reading_board" : "working";
}
const ids = new Set<string>(["accepted", "queued", "thinking", "reading_board", "working", "writing_answer"]);

/** The descriptor alone enables this wire; answer.progress controls legacy notes. */
export function createRelaySteps(features?: readonly string[]) {
  if (!features?.includes("progress_steps")) return null;
  let current: ExternalRelayStepId = "thinking";
  let sent: ExternalRelayStepId | null = null;
  let lastBeatAt = -Infinity;
  return {
    observe(observed: RelayStepObservation) { current = relayStepFor(observed); },
    changeDue(now: number) { return sent !== current && now - lastBeatAt >= 3000; },
    beat(seq: number, now: number, change: boolean): ExternalRelayStepProgress | null {
      const due = now - lastBeatAt >= 3000;
      lastBeatAt = now; // Failed attempts also consume the beat interval.
      const label = seq === 1 ? "accepted" : change && due && current !== sent ? current : null;
      if (!label || !ids.has(label)) return null;
      sent = label;
      return { kind: "step", label, tool: null, status: null, at: new Date(now).toISOString() };
    },
  };
}
