import { describeMcpCall, isViewerMcpServer } from "@/lib/mcp/presentation";

import type { DeputyOutcome, DeputyTouched, OrchestratorDeputy } from "./deputies";

/* The words a seat's deputy starts with and the words the seat is told when it
 * ends (docs/design/ghost-seat.md §4 "Avoiding conflicts with the main seat").
 * Pure: the command and the sweep hand in what they read. Agent-facing, so in
 * English whatever the operator's interface language is.
 */

/** Longest final message quoted back to the seat. */
export const DEPUTY_FINAL_TEXT_LIMIT = 600;
/** Longest collapsed line the feed draws. */
export const DEPUTY_RESULT_LINE_LIMIT = 120;

export interface DeputyWorkContext {
  /** Lanes the project has open now: the seat's work in flight. */
  openLanes: readonly { id: string; title: string; state: string; stage: string | null }[];
  /** Tasks updated in the last ten minutes. */
  recentTasks: readonly { id: string; title: string; status: string }[];
}

function bounded(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/**
 * The one message a deputy receives: the side ask, then the note that its main
 * self is working in parallel. The mandate is one paragraph on purpose; the
 * deputy already carries the seat's whole context.
 */
export function deputyMessage(input: {
  ask: string;
  seatConversationId: string;
  context: DeputyWorkContext;
}): string {
  const lanes = input.context.openLanes.slice(0, 12).map((lane) =>
    `- lane ${lane.id} «${bounded(lane.title, 80)}» ${lane.state}${lane.stage ? ` at ${lane.stage}` : ""}`);
  const tasks = input.context.recentTasks.slice(0, 12).map((task) =>
    `- task ${task.id} «${bounded(task.title, 80)}» ${task.status}`);
  return [
    input.ask.trim(),
    "",
    "---",
    `[Delegatus: you are the orchestrator's parallel self] Your main self is still working in conversation ${input.seatConversationId}; this is a fork of it, started for the one message above. Do that one job and nothing else: capture it as a task or an issue, answer the question, or launch or adjust a lane. Do not touch the lanes and tasks listed below; if the message is about them, capture it as a task and say so, leaving that work to the main self. You cannot deploy or rotate the seat. End your turn when done: you have no next turn, and your final message is what your main self reads.`,
    lanes.length ? `Open lanes now:\n${lanes.join("\n")}` : "Open lanes now: none.",
    tasks.length ? `Tasks touched in the last ten minutes:\n${tasks.join("\n")}` : "Tasks touched in the last ten minutes: none.",
  ].join("\n");
}

const OUTCOME_WORDS: Record<DeputyOutcome, string> = {
  done: "handled",
  timeout: "ran out of its 15 minutes on",
  "host-died": "stopped (its host died) while handling",
  "seat-rotated": "was ended by a seat rotation while handling",
  failed: "could not start on",
};

/** The bounded note the seat receives, queued behind its running turn. */
export function deputySeatNote(deputy: Pick<OrchestratorDeputy, "ask" | "outcome" | "touched" | "deputyConversationId" | "error">, finalText: string): string {
  const outcome = OUTCOME_WORDS[deputy.outcome ?? "done"];
  const touched = [
    ...deputy.touched.taskIds.map((id) => `task ${id}`),
    ...deputy.touched.pipelineIds.map((id) => `lane ${id}`),
    ...deputy.touched.conversationIds.map((id) => `conversation ${id}`),
  ];
  const lines = [
    `[Delegatus] Your parallel self ${outcome}: «${bounded(deputy.ask.text, 200)}»${deputy.deputyConversationId ? ` (conversation ${deputy.deputyConversationId})` : ""}.`,
    touched.length ? `It touched: ${touched.join(", ")}.` : "It touched no task, lane or conversation.",
  ];
  if (deputy.error) lines.push(`Error: ${bounded(deputy.error, 200)}`);
  const final = finalText.trim();
  if (final) lines.push(`Its final message: ${final.length > DEPUTY_FINAL_TEXT_LIMIT ? `${final.slice(0, DEPUTY_FINAL_TEXT_LIMIT - 1)}…` : final}`);
  return lines.join("\n");
}

/** The collapsed line: the first line of the deputy's final message. */
export function deputyResultLine(finalText: string): string {
  const first = finalText.split(/\r?\n/).map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  return first.length > DEPUTY_RESULT_LINE_LIMIT ? `${first.slice(0, DEPUTY_RESULT_LINE_LIMIT - 1).trimEnd()}…` : first;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function contentBlocks(line: JsonRecord): JsonRecord[] {
  const message = record(line.message);
  const content = message?.content;
  return Array.isArray(content) ? content.map(record).filter((block): block is JsonRecord => block !== null) : [];
}

function resultText(block: JsonRecord): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof record(part)?.text === "string" ? String(record(part)!.text) : "")).join("");
  }
  return "";
}

function parseResult(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return {};
  try { return JSON.parse(trimmed); } catch { return {}; }
}

/** `mcp__<server>__<tool>` → the tool name when the server is Delegatus. */
function viewerToolName(name: string): string | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match || !isViewerMcpServer(match[1]!)) return null;
  return match[2]!;
}

/**
 * What the deputy did, from its own transcript lines (the ones after the fork
 * prefix): the tasks, lanes and conversations its Delegatus calls named, and
 * its final message. Links come from the same `describeMcpCall` the feed's MCP
 * rows draw their chips from, so a chip on the collapsed line is the chip the
 * reader saw on the live row.
 */
export function deputyWorkFromLines(lines: readonly string[]): { touched: DeputyTouched; finalText: string } {
  const calls = new Map<string, { tool: string; input: unknown }>();
  const touched = { taskIds: new Set<string>(), pipelineIds: new Set<string>(), conversationIds: new Set<string>() };
  let finalText = "";
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let line: JsonRecord | null;
    try { line = record(JSON.parse(raw)); } catch { line = null; }
    if (!line || line.isSidechain === true) continue;
    if (line.type === "assistant") {
      const texts: string[] = [];
      for (const block of contentBlocks(line)) {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const tool = viewerToolName(block.name);
          if (tool) calls.set(block.id, { tool, input: block.input });
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          texts.push(block.text);
        }
      }
      if (texts.length) finalText = texts.join("\n");
    } else if (line.type === "user") {
      for (const block of contentBlocks(line)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string" || block.is_error === true) continue;
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        for (const link of describeMcpCall(call.tool, call.input, parseResult(resultText(block))).links) {
          if (link.kind === "task") touched.taskIds.add(link.id);
          else if (link.kind === "pipeline") touched.pipelineIds.add(link.id);
          else touched.conversationIds.add(link.id);
        }
      }
    }
  }
  return {
    touched: { taskIds: [...touched.taskIds], pipelineIds: [...touched.pipelineIds], conversationIds: [...touched.conversationIds] },
    finalText,
  };
}
