import fs from "node:fs";
import path from "node:path";

import { recordValue, stringValue } from "./json";

/**
 * GitHub Copilot CLI's own transcript rules, in one place
 * (docs/design/copilot-engine.md 3.1).
 *
 * A session lives at `$COPILOT_HOME/session-state/<session-id>/`. Only
 * `events.jsonl` is the transcript; `checkpoints/`, `files/`, `research/`,
 * `rewind-file-snapshots/`, `workspace.yaml` and lock files are sidecars.
 * Every line is `{type, data, id, timestamp, parentId}`.
 *
 * The schema is unpublished and moves between CLI releases, so every reader
 * here is tolerant: an unknown `type` is skipped and a missing field degrades
 * that one item, never the session.
 */

export const COPILOT_TRANSCRIPT_BASENAME = "events.jsonl";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a path inside a Copilot `session-state` root is a transcript: the
    session directory's own `events.jsonl`, nothing nested deeper. */
export function isCopilotTranscriptPath(root: string, pathname: string): boolean {
  if (path.basename(pathname) !== COPILOT_TRANSCRIPT_BASENAME) return false;
  const relative = path.relative(root, pathname).split(path.sep);
  return relative.length === 2 && SESSION_ID.test(relative[0]!);
}

/** The session id a Copilot transcript belongs to: its directory name. */
export function copilotSessionIdFromPath(pathname: string): string | null {
  if (path.basename(pathname) !== COPILOT_TRANSCRIPT_BASENAME) return null;
  const id = path.basename(path.dirname(pathname));
  return SESSION_ID.test(id) ? id.toLowerCase() : null;
}

export function copilotData(record: Record<string, unknown>): Record<string, unknown> {
  return recordValue(record.data) ?? {};
}

export interface CopilotTurnState {
  state: "busy" | "terminal" | "unknown";
  source: "lifecycle" | "tool" | "assistant" | "empty";
  terminalAt: string | null;
}

/**
 * The prompt-level turn axis. One prompt runs several model turns
 * (`assistant.turn_start` … `assistant.turn_end`), one per tool round, so a
 * `turn_end` closes the prompt only when the last assistant message of that
 * turn requested no tools. `abort` and `session.shutdown` close it outright.
 */
export function copilotTurnState(records: Record<string, unknown>[]): CopilotTurnState {
  let state: CopilotTurnState = { state: "unknown", source: "empty", terminalAt: null };
  let toolsPending = false;
  for (const record of records) {
    const type = stringValue(record.type);
    const at = stringValue(record.timestamp);
    if (type === "user.message" || type === "assistant.turn_start") {
      state = { state: "busy", source: "lifecycle", terminalAt: null };
      if (type === "user.message") toolsPending = false;
    } else if (type === "assistant.message") {
      const requests = copilotData(record).toolRequests;
      toolsPending = Array.isArray(requests) && requests.length > 0;
      state = { state: "busy", source: "assistant", terminalAt: null };
    } else if (type === "tool.execution_start" || type === "tool.execution_complete") {
      state = { state: "busy", source: "tool", terminalAt: null };
    } else if (type === "assistant.turn_end") {
      state = toolsPending
        ? { state: "busy", source: "lifecycle", terminalAt: null }
        : { state: "terminal", source: "lifecycle", terminalAt: at };
    } else if (type === "abort" || type === "session.shutdown") {
      if (state.state !== "unknown" || type === "abort") state = { state: "terminal", source: "lifecycle", terminalAt: at };
      toolsPending = false;
    }
  }
  return state;
}

export interface CopilotHead {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  copilotVersion: string | null;
  firstUserMessage: string | null;
  startedAt: string | null;
}

/** Reads what the scanner needs from the head (and first user message) of a
    Copilot transcript. */
export function copilotHeadFromRecords(records: Record<string, unknown>[]): CopilotHead {
  const head: CopilotHead = { sessionId: null, cwd: null, model: null, effort: null, copilotVersion: null, firstUserMessage: null, startedAt: null };
  for (const record of records) {
    const type = stringValue(record.type);
    const data = copilotData(record);
    if (type === "session.start") {
      head.sessionId ??= stringValue(data.sessionId);
      head.cwd ??= stringValue(recordValue(data.context)?.cwd);
      head.model ??= stringValue(data.selectedModel);
      head.effort ??= stringValue(data.reasoningEffort);
      head.copilotVersion ??= stringValue(data.copilotVersion);
      head.startedAt ??= stringValue(data.startTime) ?? stringValue(record.timestamp);
    } else if (type === "session.resume") {
      head.cwd ??= stringValue(recordValue(data.context)?.cwd);
    } else if (type === "session.model_change") {
      head.model = stringValue(data.newModel) ?? head.model;
      head.effort = stringValue(data.reasoningEffort) ?? head.effort;
    } else if (type === "assistant.message") {
      head.model ??= stringValue(data.model);
    } else if (type === "user.message" && head.firstUserMessage === null) {
      head.firstUserMessage = stringValue(data.content);
    }
  }
  return head;
}

/** The session title the CLI recorded in `workspace.yaml` (`name:`), or null.
    Read as plain lines: the file is a flat key/value document. */
export function copilotWorkspaceTitle(transcriptPath: string): string | null {
  let text: string;
  try { text = fs.readFileSync(path.join(path.dirname(transcriptPath), "workspace.yaml"), "utf8"); }
  catch { return null; }
  for (const line of text.split("\n")) {
    const match = /^name:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1]!.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

/** The tool name the model called, with the Viewer MCP prefix normalized:
    Copilot names MCP tools `<server>-<tool>`, so `viewer-list_tasks` is the
    Viewer's `list_tasks`, presented as Claude's `mcp__viewer__list_tasks` is. */
export function copilotToolName(name: string): string {
  return name.startsWith("viewer-") ? `mcp__viewer__${name.slice("viewer-".length)}` : name;
}
