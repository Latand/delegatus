import path from "node:path";

import { recordValue, stringValue } from "./json";

/**
 * Antigravity CLI (`agy`) host-written NDJSON transcript rules
 * (docs/design/antigravity-engine.md §3.2 & §3.5).
 *
 * A session lives at `<antigravityHome>/sessions/<sessionId>/events.jsonl`.
 * Only direct `<sessionId>/events.jsonl` files are transcripts; any sibling
 * files (such as `delivery-acceptance.sqlite`) are ignored. Every reader is
 * tolerant of unknown record types and partial trailing lines.
 */

export const ANTIGRAVITY_TRANSCRIPT_BASENAME = "events.jsonl";

/** Canonical session id shape shared by `AntigravityAcpHost` and the scanner. */
export const ANTIGRAVITY_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAntigravitySessionId(sessionId: string): boolean {
  return typeof sessionId === "string"
    && ANTIGRAVITY_SESSION_ID_PATTERN.test(sessionId)
    && !sessionId.includes("..");
}

/** Whether a path inside an Antigravity `sessions` root is a transcript:
    the session directory's own `events.jsonl`, nothing nested deeper. */
export function isAntigravityTranscriptPath(root: string, pathname: string): boolean {
  if (path.basename(pathname) !== ANTIGRAVITY_TRANSCRIPT_BASENAME) return false;
  const relative = path.relative(root, pathname).split(path.sep);
  return relative.length === 2 && isValidAntigravitySessionId(relative[0]!);
}

/** The session id an Antigravity transcript belongs to: its directory name. */
export function antigravitySessionIdFromPath(pathname: string): string | null {
  if (path.basename(pathname) !== ANTIGRAVITY_TRANSCRIPT_BASENAME) return null;
  const id = path.basename(path.dirname(pathname));
  if (!isValidAntigravitySessionId(id)) return null;
  return UUID_SESSION_ID.test(id) ? id.toLowerCase() : id;
}

export function antigravityData(record: Record<string, unknown>): Record<string, unknown> {
  return recordValue(record.data) ?? {};
}

export interface AntigravityTurnState {
  state: "busy" | "terminal" | "unknown";
  source: "lifecycle" | "tool" | "assistant" | "empty";
  terminalAt: string | null;
}

/**
 * Prompt-level turn axis for Antigravity host-written `events.jsonl`.
 * `user.message`, `assistant.turn_start`, `assistant.message`, and tool
 * lifecycle records keep the turn busy; `assistant.turn_end`, `abort`,
 * `session.quota_exhausted`, `session.error`, and `session.shutdown` close it.
 */
export function antigravityTurnState(records: Record<string, unknown>[]): AntigravityTurnState {
  let state: AntigravityTurnState = { state: "unknown", source: "empty", terminalAt: null };
  for (const record of records) {
    const type = stringValue(record.type);
    const at = stringValue(record.timestamp);
    if (type === "user.message" || type === "assistant.turn_start") {
      state = { state: "busy", source: "lifecycle", terminalAt: null };
    } else if (type === "assistant.message") {
      state = { state: "busy", source: "assistant", terminalAt: null };
    } else if (type === "tool.execution_start" || type === "tool.execution_complete") {
      state = { state: "busy", source: "tool", terminalAt: null };
    } else if (type === "assistant.turn_end") {
      state = { state: "terminal", source: "lifecycle", terminalAt: at };
    } else if (type === "abort" || type === "session.quota_exhausted" || type === "session.error" || type === "session.shutdown") {
      if (state.state !== "unknown" || type === "abort" || type === "session.quota_exhausted" || type === "session.error") {
        state = { state: "terminal", source: "lifecycle", terminalAt: at };
      }
    }
  }
  return state;
}

export interface AntigravityHead {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  agyVersion: string | null;
  firstUserMessage: string | null;
  startedAt: string | null;
}

/** Reads scanner head metadata (and first user prompt) from Antigravity records. */
export function antigravityHeadFromRecords(records: Record<string, unknown>[]): AntigravityHead {
  const head: AntigravityHead = {
    sessionId: null,
    cwd: null,
    model: null,
    effort: null,
    agyVersion: null,
    firstUserMessage: null,
    startedAt: null,
  };
  for (const record of records) {
    const type = stringValue(record.type);
    const data = antigravityData(record);
    if (type === "session.start") {
      head.sessionId ??= stringValue(data.sessionId);
      head.cwd ??= stringValue(data.cwd) ?? stringValue(recordValue(data.context)?.cwd);
      head.model ??= stringValue(data.model) ?? stringValue(data.baseModel) ?? stringValue(data.selectedModel);
      head.effort ??= stringValue(data.effort) ?? stringValue(data.reasoningEffort);
      head.agyVersion ??= stringValue(data.agyVersion);
      head.startedAt ??= stringValue(data.startTime) ?? stringValue(record.timestamp);
    } else if (type === "session.resume") {
      head.sessionId ??= stringValue(data.sessionId);
      head.cwd ??= stringValue(data.cwd) ?? stringValue(recordValue(data.context)?.cwd);
      head.model = stringValue(data.model) ?? stringValue(data.baseModel) ?? stringValue(data.selectedModel) ?? head.model;
      head.effort = stringValue(data.effort) ?? stringValue(data.reasoningEffort) ?? head.effort;
      head.agyVersion ??= stringValue(data.agyVersion);
    } else if (type === "session.model_change") {
      head.model = stringValue(data.model) ?? stringValue(data.newModel) ?? stringValue(data.baseModel) ?? head.model;
      head.effort = stringValue(data.effort) ?? stringValue(data.reasoningEffort) ?? head.effort;
    } else if (type === "assistant.message") {
      head.model ??= stringValue(data.model);
    } else if (type === "user.message" && head.firstUserMessage === null) {
      head.firstUserMessage = stringValue(data.content);
    }
  }
  return head;
}

export interface AntigravityStopReason {
  kind: "quota_exhausted" | "error" | "aborted";
  message: string;
  resetsAt: number | null;
  at: string | null;
}

/** Extracts the terminal stop reason (quota exhaustion, error, or abort) from the
    most recent turn of an Antigravity transcript, or null if the turn finished normally. */
export function antigravityStopReason(records: Record<string, unknown>[]): AntigravityStopReason | null {
  let stop: AntigravityStopReason | null = null;
  for (const record of records) {
    const type = stringValue(record.type);
    const data = antigravityData(record);
    const at = stringValue(record.timestamp);
    if (type === "user.message" || type === "assistant.turn_start" || type === "assistant.turn_end") {
      stop = null;
    } else if (type === "session.quota_exhausted") {
      const resetsAt = typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt) ? data.resetsAt : null;
      const message = stringValue(data.message) ?? "Antigravity quota reached";
      stop = { kind: "quota_exhausted", message, resetsAt, at };
    } else if (type === "session.error") {
      const message = stringValue(data.message) ?? stringValue(data.error) ?? "Antigravity turn error";
      stop = { kind: "error", message, resetsAt: null, at };
    } else if (type === "abort") {
      const reason = stringValue(data.reason) ?? "interrupted";
      stop = { kind: "aborted", message: reason, resetsAt: null, at };
    }
  }
  return stop;
}

/** Normalizes Viewer MCP tool names emitted by Antigravity (`mcp_viewer_<tool>`
    and `viewer-<tool>`) into the canonical `mcp__viewer__<tool>` spelling. */
export function antigravityToolName(name: string): string {
  if (name.startsWith("mcp_viewer_") && name.length > "mcp_viewer_".length) {
    return `mcp__viewer__${name.slice("mcp_viewer_".length)}`;
  }
  if (name.startsWith("viewer-") && name.length > "viewer-".length) {
    return `mcp__viewer__${name.slice("viewer-".length)}`;
  }
  return name;
}
