/**
 * Claude permission requests on a structured host (#2215), in the one shape
 * every reader shares: the host's state, the registry column, the board's
 * Needs-you item, `agent_activity` and the seat wake.
 *
 * Claude Code asks for a tool over `--permission-prompt-tool stdio` as a
 * `control_request` whose `request.subtype` is `can_use_tool`. It does so even
 * under `--permission-mode bypassPermissions` when its own safety check flags a
 * command — `decision_reason_type: "safetyCheck"`, `classifier_approvable:
 * false` — and the turn then waits for an answer that nothing used to give.
 * The fields read here are the ones the CLI sends (recorded in the host's own
 * event log): `tool_name`, `input`, `decision_reason`, `decision_reason_type`.
 *
 * Browser-safe: no filesystem and no process state, so the board's attention
 * model can import it.
 */

/** The `control_request` subtype Claude uses to ask for a tool. */
export const CLAUDE_TOOL_REQUEST_METHOD = "can_use_tool";

/** Tools whose `can_use_tool` request is a question for the operator rather
    than a permission. The transcript already surfaces them as a pending
    question or plan, so they are not listed as permission requests. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** How long an attended request may wait before it is denied (#2215). */
export const ATTENDED_PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** The line every automatic deny carries after the engine's own reason. */
export const NO_APPROVER_LINE = "No one can approve this here; rewrite the command so it does not need permission.";

const COMMAND_EXCERPT_CHARS = 300;
const REASON_CHARS = 500;
const TOOL_CHARS = 120;

/** One pending permission request, bounded. */
export interface PendingPermissionRequest {
  /** The control request id; the answer names it. */
  id: string;
  tool: string;
  /** A bounded excerpt of what the tool would do: the command, the file, the URL. */
  command: string | null;
  /** The engine's `decision_reason`, verbatim within the bound. */
  reason: string | null;
  /** The engine's `decision_reason_type` (`safetyCheck`, `subcommandResults`, …). */
  reasonType: string | null;
  /** When the host received it, ISO. */
  since: string;
}

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** Whether a host attention is Claude asking for a tool (a permission or a question). */
export function isClaudeToolRequest(method: string): boolean {
  return method === CLAUDE_TOOL_REQUEST_METHOD;
}

/** The tool a `can_use_tool` request names, or null. */
export function toolRequestName(attention: unknown): string | null {
  const source = record(attention);
  return text(source?.tool_name) ?? text(source?.toolName) ?? text(source?.tool);
}

/** Whether a `can_use_tool` request is a permission for the operator to grant,
    as opposed to a question the transcript already surfaces. */
export function isPermissionRequest(attention: unknown): boolean {
  const tool = toolRequestName(attention);
  return tool !== null && !QUESTION_TOOLS.has(tool);
}

/** What the tool would do, in one bounded excerpt: the shell command, else the
    file or URL it targets, else its input serialized. */
export function permissionCommandExcerpt(input: unknown): string | null {
  const source = record(input);
  if (!source) return null;
  const named = text(source.command) ?? text(source.file_path) ?? text(source.notebook_path)
    ?? text(source.url) ?? text(source.path) ?? text(source.pattern);
  if (named) return bounded(named, COMMAND_EXCERPT_CHARS);
  let serialized: string;
  try { serialized = JSON.stringify(source); } catch { return null; }
  return serialized && serialized !== "{}" ? bounded(serialized, COMMAND_EXCERPT_CHARS) : null;
}

/** The bounded record of one `can_use_tool` permission request, or null when
    the attention is not one (a question tool, another control). */
export function pendingPermissionFrom(id: string, attention: unknown, since: string): PendingPermissionRequest | null {
  if (!isPermissionRequest(attention)) return null;
  const source = record(attention)!;
  const reason = text(source.decision_reason);
  return {
    id,
    tool: bounded(toolRequestName(attention)!, TOOL_CHARS),
    command: permissionCommandExcerpt(source.input),
    reason: reason ? bounded(reason, REASON_CHARS) : null,
    reasonType: text(source.decision_reason_type),
    since,
  };
}

/** The deny message an automatic answer carries: the engine's own reason,
    verbatim, then the one line that tells the agent what to do instead. */
export function permissionDenyMessage(reason: string | null): string {
  return reason ? `${reason}\n${NO_APPROVER_LINE}` : NO_APPROVER_LINE;
}

/** The `can_use_tool` answer that denies the request with `message`. */
export function permissionDenyResolution(message: string): { behavior: "deny"; message: string } {
  return { behavior: "deny", message };
}

/** One line naming the request: tool, command excerpt, reason. */
export function permissionHeadline(request: Pick<PendingPermissionRequest, "tool" | "command" | "reason">): string {
  const command = request.command ? `: ${request.command.replace(/\s+/g, " ").trim()}` : "";
  const reason = request.reason ? ` — ${request.reason.replace(/\s+/g, " ").trim()}` : "";
  return `${request.tool}${command}${reason}`;
}

/** A persisted list, validated: anything that is not a well-formed request is dropped. */
export function normalizePendingPermissions(value: unknown): PendingPermissionRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: PendingPermissionRequest[] = [];
  for (const candidate of value) {
    const source = record(candidate);
    if (!source || !text(source.id) || !text(source.tool) || !text(source.since)) continue;
    requests.push({
      id: source.id as string,
      tool: source.tool as string,
      command: text(source.command),
      reason: text(source.reason),
      reasonType: text(source.reasonType),
      since: source.since as string,
    });
  }
  return requests;
}
