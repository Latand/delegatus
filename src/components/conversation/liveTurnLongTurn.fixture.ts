/* The long Claude turn the live overlay has to survive, as ugly as the one the
   operator photographed and entirely invented: no real path, host, id, account
   or command from a live transcript appears here.

   Sixty tool calls in one turn, interleaved with prose, carrying the four
   shapes that made the wall unreadable:

     - long Viewer MCP names (`mcp__viewer__…`), whose canonical row is an
       McpCallCard with the call's meaning and its entity chips, not the bare
       "viewer · create_pipeline" a generic summarizer produces;
     - failures, which must stay legible wherever they land;
     - calls whose arguments the live window's own bound shed, which have
       nothing left to say and belong in the collapsed count;
     - one still-running call at the end — the thing the overlay is FOR.

   The same records are emitted twice: as live-turn items (what the structured
   host projects) and as Claude transcript lines carrying the same call ids
   (what the canonical feed parses), so a test can put the two side by side and
   ask whether a canonical row claims its live row. */

import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

export const LONG_TURN_CALLS = 60;

const BASE = Date.parse("2026-09-20T09:15:00.000Z");
const at = (index: number) => new Date(BASE + index * 4_000).toISOString();

interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "ok" | "err" | "run" | "unknown";
  /** The live window shed this call's arguments to honour its own bound. */
  argsOmitted?: boolean;
  at: string;
}

const GREP_PATTERN = "(liveTurn|overlay|claim|transcriptMovedPast|argsOmitted)";
const LONG_COMMAND =
  "bun test src/components/conversation/liveTurnToolRows.dom.test.tsx "
  + "--timeout=20000 --reporter=verbose 2>&1 | tail --lines=40";

/* Every fifth call is a Viewer MCP call, and those are the long names. */
const MCP_CASES: { tool: string; args: Record<string, unknown> }[] = [
  { tool: "create_pipeline", args: { task: "Bound the live overlay to its in-flight tail", repoDir: "/workspace/demo/viewer", project: "demo-viewer" } },
  { tool: "update_task", args: { taskId: "task-demo-4417", status: "assigned", text: "Live rows: show the tail, collapse the rest" } },
  { tool: "get_pipeline", args: { pipelineId: "pipeline-demo-2208", stageId: "stage-build" } },
  { tool: "link_task_to_pipeline", args: { taskId: "task-demo-4417", pipelineId: "pipeline-demo-2208" } },
  { tool: "search_transcripts", args: { query: "live turn rows arguments omitted", limit: 20 } },
  { tool: "pipeline_action", args: { pipelineId: "pipeline-demo-2208", action: "start" } },
  { tool: "send_message", args: { conversationId: "conversation-demo-9931", text: "The overlay is bounded now — please re-read the tail on the phone." } },
  { tool: "create_task", args: { text: "Capture the phone evidence for the bounded overlay", project: "demo-viewer" } },
];

function callAt(index: number): Call {
  const when = at(index);
  const fifth = index % 5 === 0;
  if (fifth) {
    const mcp = MCP_CASES[(index / 5) % MCP_CASES.length]!;
    return {
      id: `toolu_demo_${String(index).padStart(3, "0")}`,
      name: `mcp__viewer__${mcp.tool}`,
      args: mcp.args,
      status: index % 35 === 0 ? "err" : "ok",
      at: when,
    };
  }
  const shape = index % 4;
  const args = shape === 0
    ? { command: index % 3 === 0 ? LONG_COMMAND : `bun test src/components/conversation/step${index}.test.ts` }
    : shape === 1
      ? { file_path: `/workspace/demo/viewer/src/components/conversation/step${index}.tsx` }
      : shape === 2
        ? { pattern: GREP_PATTERN, path: "src/components/conversation", output_mode: "content" }
        : { file_path: `/workspace/demo/viewer/src/components/conversation/step${index}.tsx`, old_string: `const step = ${index};`, new_string: `const step = ${index + 1};` };
  return {
    id: `toolu_demo_${String(index).padStart(3, "0")}`,
    name: shape === 0 ? "Bash" : shape === 1 ? "Read" : shape === 2 ? "Grep" : "Edit",
    args,
    status: index % 11 === 0 ? "err" : "ok",
    at: when,
  };
}

/** The turn's calls in response order, newest last. The last one is still
    running; everything before the newest twelve has had its arguments shed,
    which is what the live window's argument bound does to an old row. */
export function longTurnCalls(count = LONG_TURN_CALLS): Call[] {
  return Array.from({ length: count }, (_, index) => {
    const call = callAt(index);
    if (index === count - 1) return { ...call, status: "run" as const };
    if (index === count - 2) return { ...call, status: "unknown" as const };
    return index < count - 12 ? { ...call, argsOmitted: true } : call;
  });
}

const PROSE = [
  "Reading the overlay and the claim handoff before touching either.",
  "The transcript window is the only thing that retires a live row, so the pane has to be looking at it.",
  "Now the bound itself: the tail is what the operator is waiting on, the rest is the transcript's job.",
];

/** The live turn as the structured host projects it: prose interleaved with
    the calls, every tool row keyed by the engine call id its canonical row
    carries. */
export function longTurnLiveItems(count = LONG_TURN_CALLS): RuntimeLiveTurnItem[] {
  return liveItemsFor(longTurnCalls(count));
}

function liveItemsFor(calls: Call[]): RuntimeLiveTurnItem[] {
  const items: RuntimeLiveTurnItem[] = [];
  calls.forEach((call, index) => {
    if (index % 24 === 0) {
      items.push({
        itemId: `msg_demo_${index}`,
        text: PROSE[(index / 24) % PROSE.length]!,
        phase: "awaiting-echo",
        startedAt: call.at,
        completedAt: call.at,
      });
    }
    items.push({
      itemId: call.id,
      text: "",
      phase: "awaiting-echo",
      startedAt: call.at,
      completedAt: call.status === "run" ? null : call.at,
      tool: {
        name: call.name,
        engine: "claude",
        status: call.status,
        args: call.argsOmitted ? {} : call.args,
        ...(call.argsOmitted ? { argsOmitted: true as const } : {}),
      },
    });
  });
  return items;
}

/** The same turn as Claude writes it to its transcript: one `tool_use` record
    per call and one `tool_result` for every call that finished. This is what a
    CURRENT canonical window holds, and every id in it claims a live row. */
export function longTurnTranscriptLines(count = LONG_TURN_CALLS): string[] {
  return transcriptLinesFor(longTurnCalls(count));
}

function transcriptLinesFor(calls: Call[]): string[] {
  const lines: string[] = [];
  calls.forEach((call, index) => {
    if (index % 24 === 0) {
      lines.push(JSON.stringify({
        type: "assistant",
        uuid: `msg_demo_${index}`,
        timestamp: call.at,
        message: { role: "assistant", id: `msg_demo_${index}`, content: [{ type: "text", text: PROSE[(index / 24) % PROSE.length] }] },
      }));
    }
    lines.push(JSON.stringify({
      type: "assistant",
      timestamp: call.at,
      message: { role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.args }] },
    }));
    if (call.status === "run") return;
    lines.push(JSON.stringify({
      type: "user",
      timestamp: call.at,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: call.id,
          content: [{ type: "text", text: call.status === "err" ? "error: the step failed" : "ok" }],
          is_error: call.status === "err",
        }],
      },
    }));
  });
  return lines;
}

/** A transcript window that stopped before this turn began: the shape a pane
    holds while its tail is paused (dormant or offscreen) and the runtime store
    keeps projecting into the same turn. Nothing here can claim a live row, and
    every live instant is newer than the newest row in it. */
export function staleTranscriptLines(): string[] {
  const before = new Date(BASE - 10 * 60_000).toISOString();
  return [
    JSON.stringify({ type: "user", uuid: "rec-stale-1", timestamp: before, message: { role: "user", content: "Bound the live overlay." } }),
    JSON.stringify({
      type: "assistant",
      uuid: "rec-stale-2",
      timestamp: before,
      message: { role: "assistant", id: "rec-stale-2", content: [{ type: "text", text: "Starting on it." }] },
    }),
  ];
}

/** The same turn part-way through: its first `calls` calls, as the pair a pane
    holds at that moment — the bytes the transcript file has on disk and the
    items the runtime store has projected. It is a genuine PREFIX of the whole
    turn, so a file that grows only ever appends and a live turn that grows only
    ever extends, which is what a test driving the real transports needs. */
export function longTurnPrefix(calls: number): { lines: string[]; items: RuntimeLiveTurnItem[] } {
  const kept = longTurnCalls().slice(0, Math.max(0, Math.min(calls, LONG_TURN_CALLS)));
  return { lines: transcriptLinesFor(kept), items: liveItemsFor(kept) };
}
