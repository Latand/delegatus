import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { prototypePublishSchema } from "@/lib/prototypeReview/input";

import { FOCUS_TARGET_SHAPES } from "@/lib/attention/targets";
import { statePath } from "@/lib/configDir";
import { openCurrentDatabase } from "@/lib/state/currentDatabase";
import { DeadlineExceededError, deadlineSignal } from "@/lib/deadline";
import { DEFAULT_STALL_AFTER_MS } from "@/lib/lifecycle/liveness";
import { operatorLocale } from "@/lib/operator/settings";
import { MEMORY_KINDS } from "@/lib/memory/parsers";
import { PIPELINE_LIST_DEFAULT_LIMIT, PIPELINE_LIST_MAX_LIMIT } from "@/lib/pipelines/listProjection";
import {
  DEFAULT_FAIL_EDGE_ROUNDS,
  MAX_FAIL_EDGE_ROUNDS,
  MAX_PIPELINE_STAGES,
  MAX_STAGE_FINDING_CHARS,
  MAX_STAGE_OUTPUTS,
  MAX_STAGE_OUTPUT_PATH_LENGTH,
  MAX_STAGE_PROMPT_LENGTH,
  MAX_STAGE_REPORT_FINDINGS,
  MAX_STAGE_REPORT_SUMMARY_CHARS,
  MIN_STARTED_PIPELINE_STAGES,
} from "@/lib/pipelines/limits";
import { PIPELINE_ACTIONS, PIPELINE_DISALLOWED_ROLE_IDS, PIPELINE_FAIL_EDGE_EXHAUSTIONS, STAGE_FINDING_SEVERITIES } from "@/lib/pipelines/types";
import { procBackend } from "@/lib/proc";
import { parseMessageOrigin, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { ROLE_IDS, type RoleId } from "@/lib/roles/types";
import { SELECTED_TAIL_MAX_LINES } from "@/lib/selection/resolve";
import { renderTaskColorRule } from "@/lib/tasks/colorRule";
import { renderTaskPriorityRule } from "@/lib/tasks/priority";
import { TASK_STEPS_LIMIT } from "@/lib/tasks/steps";
import { TASK_COLORS, TASK_PRIORITIES } from "@/lib/tasks/types";
import { BOT_MESSAGES_LIMIT, BOT_MESSAGES_MAX_CHARS, TELEGRAM_BOT_LIMITS } from "@/lib/telegram/bot/contracts";
import {
  MAX_REPLY_LABEL_CHARS, MAX_REPLY_SUGGESTIONS, MAX_REPLY_TEXT_BYTES, MIN_REPLY_SUGGESTIONS,
} from "@/lib/suggestions/types";
import {
  MAX_SCOPE_PATHS, MAX_SNAPSHOT_CHARS_PER_CONVERSATION, MAX_SNAPSHOT_LAST_MESSAGES, MAX_SNAPSHOT_STRING_LENGTH,
  MIN_SNAPSHOT_STRING_LENGTH, VIEW_RESOLUTIONS, VIEW_SCOPE_KINDS,
} from "@/lib/view/types";

import { runAsMcpHttpCaller, type McpHttpCaller } from "./callerContext";
import type { McpToolPolicy } from "./toolAllowlist";

export const MCP_SERVER_NAME = "viewer";

export const MCP_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "message_receipt",
  "create_task",
  "update_task",
  "create_pipeline",
  "pipeline_action",
  "stage_report",
  "link_task_to_pipeline",
  "list_conversations",
  "search_transcripts",
  "search_memory",
  "get_conversation",
  "conversation_deliverability",
  "conversation_messages",
  "deploy_exact_sha",
  "get_pipeline",
  "board_snapshot",
  "list_flows",
  "get_flow",
  "flow_action",
  "list_pipelines",
  "conversation_action",
  "operator_snapshot",
  "list_tasks",
  "get_task",
  "deployment_status",
  "resources",
  "conversation_migration",
  "agent_activity",
  "lifecycle_events",
  "request_attention",
  "suggest_replies",
  "publish_prototype_review",
  "read_prototype_review",
  "dismiss_attention",
  "bridge_report",
  "bridge_directive",
  "get_orchestrator",
  "create_orchestrator",
  "send_message_to_orchestrator",
  "ask_orchestrator_in_parallel",
  "rotate_orchestrator",
  "seat_tick_settings",
  "account_project_binding",
  "role_presets",
  "auto_updates",
  "account_limits",
  "telegram_bot_chats",
  "telegram_bot_send",
  "telegram_bot_send_media",
  "telegram_bot_send_document",
  "telegram_bot_messages",
  "issue_report",
] as const;

export type McpToolName = typeof MCP_TOOL_NAMES[number];
type ReceiptRetention = "bounded" | "durable";

export const MUTATING_MCP_TOOL_NAMES = new Set<McpToolName>([
  "spawn_agent",
  "send_message",
  "create_task",
  "update_task",
  "create_pipeline",
  "pipeline_action",
  /* Records the calling attempt's own completion, which the stage then settles
     on. A replayed clientRequestId must answer with the report the first call
     recorded rather than replace it a second time, and that record outlives
     this process. */
  "stage_report",
  "link_task_to_pipeline",
  "deploy_exact_sha",
  "flow_action",
  "conversation_action",
  "conversation_migration",
  /* Digest polls advance a durable relay cursor, so their receipts must
     survive the MCP process: a replayed clientRequestId has to return the same
     relay rather than skip past events the caller never saw. */
  "lifecycle_events",
  /* Reads liveness, but appends the stalls and exits it finds to the same
     durable journal — for exactly the reason `lifecycle_events` is here, so it
     is classified the same way rather than looking read-only by name. */
  "agent_activity",
  "request_attention",
  /* Writes the conversation's current reply-draft set, which the operator's
     composer reads. The record outlives this process, so a replayed
     clientRequestId must answer from the receipt rather than re-offer drafts
     under a question the operator has since answered. */
  "suggest_replies",
  "publish_prototype_review",
  /* Clears a needs-you flag the operator is shown, durably and attributed. A
     replayed clientRequestId must answer with the first result rather than
     clear again something that asked anew since. */
  "dismiss_attention",
  /* Appends to the durable bridge log, so a replayed clientRequestId must return
     the original receipt rather than append the report a second time. */
  "bridge_report",
  /* Delivers an instruction to the manager. Its own derived id is what makes a
     retry idempotent, and the receipt must outlive the MCP process for that. */
  "bridge_directive",
  /* Designation, delivery and rotation are durable side effects: a replayed
     clientRequestId must return the original receipt, never designate, spawn
     or deliver a second time. get_orchestrator is a read and stays bounded. */
  "create_orchestrator",
  "send_message_to_orchestrator",
  /* Starts the seat's parallel self (docs/design/ghost-seat.md §5): a fork, a
     host and a delivery. A replayed clientRequestId resumes the same record. */
  "ask_orchestrator_in_parallel",
  "rotate_orchestrator",
  /* Writes a project's durable tick settings when it carries a change (#1275).
     A pure read of the same tool changes nothing, but the receipt has to
     outlive this process either way: a replayed clientRequestId must answer
     with what the first call recorded. */
  "seat_tick_settings",
  /* Writes the durable account↔project bindings when it carries a change
     (#1279), and the record it answers with outlives this process either way:
     a replayed clientRequestId must answer with what the first call recorded. */
  "account_project_binding",
  /* Writes the durable role mapping and appends its audit line when it carries
     `overrides` (#2019); a read of the same tool changes nothing, but the
     receipt has to outlive this process either way: a replayed clientRequestId
     must answer with what the first call recorded rather than write again. */
  "role_presets",
  /* Switches automatic updates when it carries `enabled`, recorded with its
     writer in the Update dialog's history; a read changes nothing, but a
     replayed clientRequestId must answer with what the first call recorded
     rather than switch and record a second time. */
  "auto_updates",
  /* Posts into a Telegram chat. A replayed clientRequestId must answer with
     the message ids the first call posted, never post a second time. */
  "telegram_bot_send",
  "telegram_bot_send_media",
  "telegram_bot_send_document",
  /* Records a preview and files one issue (#2518). A replayed clientRequestId
     must answer with the issue the first call filed, never file a second. */
  "issue_report",
]);

/** Explicit allowlist: read-like tools with durable effects still need keys. */
export const OPTIONAL_READ_KEY_TOOLS = new Set<McpToolName>([
  "read_prototype_review",
  "message_receipt", "list_conversations", "search_transcripts", "get_conversation",
  "conversation_deliverability", "conversation_messages", "get_pipeline", "board_snapshot",
  "list_flows", "get_flow", "list_pipelines", "list_tasks", "get_task",
  "deployment_status", "resources", "get_orchestrator", "account_limits",
]);

export const isMutatingMcpTool = (tool: McpToolName): boolean => MUTATING_MCP_TOOL_NAMES.has(tool);


/**
 * Calls whose binding is idempotent over its own durable state, so a claim the
 * previous process never settled is RECONCILED by re-running the binding
 * rather than answered `call_interrupted` forever (#873 review, finding 3).
 *
 * `request_attention` qualifies because the operation's identity is written on
 * the attention record itself before anything can navigate: the re-run adopts
 * that record — one record, one navigation — waits out the same handoff, and
 * finally settles the durable receipt, so the retry that used to be a
 * permanent dead end becomes the deterministic answer to what actually
 * happened. The digest check above still refuses a same-id call with
 * different arguments.
 *
 * Archive and unarchive qualify at the action level: board hidden placement is
 * content-idempotent, so a retry after the board write converges without
 * another revision. Other conversation actions still require live runtime
 * ownership and remain outside interrupted recovery.
 *
 * Resolving a pipeline decision persists its request key, actor, answer and
 * stage fences alongside the new attempt. Re-running that action either admits
 * the answer once or returns the saved answer, including after a process exit
 * between pipeline persistence and receipt completion.
 */
const INTERRUPTED_RECOVERABLE_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>([
  "request_attention",
  // The Viewer owns the Telegram send claim. Re-dispatching this tool after
  // the MCP receipt store reopens lets that durable claim answer uncertain or
  // replay the completed Telegram receipt without repeating the HTTP send.
  "telegram_bot_send_media",
  "telegram_bot_send_document",
  /* The Viewer keys a publication by its caller and clientRequestId and checks
     the payload's digest under its publication lock, so a re-dispatch either
     publishes the round the stopped process never wrote or answers with the
     one it did, whose copies no longer need the source files. A changed
     payload under the same key is refused by the digest check above. */
  "publish_prototype_review",
  /* Deliberately NOT here: `suggest_replies`. Its write is idempotent over the
     record, but the record is retired by something outside the call — the
     operator's own answer — so re-running an interrupted write would put the
     drafts back under a question they have already answered. A disposable
     draft is exactly the thing not worth resurrecting: the interrupted call
     answers `call_interrupted`, and the seat offers a fresh set if it still
     wants one. */
]);

function interruptedCallIsRecoverable(toolName: McpToolName, args: McpToolArgs): boolean {
  if (INTERRUPTED_RECOVERABLE_TOOLS.has(toolName)) return true;
  if (toolName === "pipeline_action") return ["resolve-decision", "continue-review", "accept-head", "convert-legacy-review", "revert-legacy-review"].includes(String(args.action));
  if (toolName !== "conversation_action") return false;
  return args.action === "archive" || args.action === "unarchive";
}

export type McpToolArgs = Record<string, unknown> & { clientRequestId?: unknown };
export type McpToolPayload = Record<string, unknown>;
export interface McpToolCallContext {
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Numeric transport subphases, supplied by the service, never tool arguments. */
  recordTiming?: (phase: "http", milliseconds: number) => void;
  /** #1490: the durable binding this call's dispatch must use. Present only on
      a recoverable mutation's single dispatch; the binding reads its downstream
      idempotency key from here rather than deriving one of its own. */
  binding?: McpRequestBinding;
  /** Persist a newly created orchestrator recipient before its first send. */
  bindCreatedTarget?: (identity: string) => Promise<void>;
  /** #1490: written by the transport the moment the request may be on the
      wire. A failure raised while this still says `false` happened before any
      dispatch, which is the only way an error without an id proves that the
      server did nothing. */
  dispatch?: McpDispatchTracker;
  /** #1629: the native work identity this request arrived with, read off the
      protocol envelope rather than the arguments. See {@link McpNativeWork}. */
  nativeWork?: McpNativeWork | null;
}

/**
 * What native Codex says about the work that made this call (#1629).
 *
 * Installed 0.154.0 puts its backing turn identity on the JSON-RPC request
 * itself — `params._meta["x-codex-turn-metadata"]` — and repeats the thread on
 * `params._meta.threadId`. The evidence and its limits are recorded in
 * `docs/design/native-voice-work-identity.md`: eighteen real calls across three
 * isolated fixture runs, with a forged-argument case proving that the same names
 * placed in `arguments` never reach this object.
 *
 * THIS IS TRANSPORT PROVENANCE. It cannot widen what a caller
 * may do; it only lets a reader tell one of that caller's turns from another,
 * which is what the voice ledger needs and what conversation identity alone
 * could never supply. A caller that presents none is not refused — it simply
 * cannot have an implicit voice card resolved for it.
 */
export interface McpNativeWork {
  threadId: string;
  turnId: string;
  /** `turn_trigger`: `"realtime"` for a turn native started from a call. */
  turnTrigger: string | null;
  /** The tool-call occurrence within that turn. */
  callId: string | null;
  /** The provider output item this call came from. */
  itemId: string | null;
}

function metaString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function metaObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Read the native work identity off one request's `_meta`, or answer null.
 *
 * Strict on purpose. A turn metadata object whose `thread_id` disagrees with the
 * envelope's own `threadId` describes something this reader has no model for, so
 * it yields nothing rather than picking one — an inconsistent claim is weaker
 * evidence than no claim, not stronger.
 */
export function nativeWorkFromRequestMeta(meta: unknown): McpNativeWork | null {
  const envelope = metaObject(meta);
  if (!envelope) return null;
  const turn = metaObject(envelope["x-codex-turn-metadata"]);
  const turnId = metaString(turn, "turn_id");
  const threadId = metaString(envelope, "threadId") ?? metaString(turn, "thread_id");
  if (!turnId || !threadId) return null;
  const turnThreadId = metaString(turn, "thread_id");
  if (turnThreadId && turnThreadId !== threadId) return null;
  return {
    threadId,
    turnId,
    turnTrigger: metaString(turn, "turn_trigger"),
    callId: metaString(envelope, "callId"),
    itemId: metaString(envelope, "itemId"),
  };
}

export interface McpDispatchTracker {
  attempted: boolean;
}
export type McpToolBinding = ((args: McpToolArgs, context?: McpToolCallContext) => Promise<McpToolPayload>) & {
  /** Caller-dependent checks before receipt reads, claims or in-process joins. Must not mutate state. */
  authorizeReceipt?: (args: McpToolArgs) => void | Promise<void>;
  /** Fresh admission checks, after authority and existing-receipt lookup,
      before any claim. Mutable names must not conceal a recorded result. */
  prepareAdmission?: (args: McpToolArgs) => void | Promise<void>;
  /** Who the receipt belongs to, as the Viewer decides it for this call (the
      caller and the target it is allowed to reach). Asked before every receipt
      read, claim or in-process join, and part of the receipt's key, so one
      caller's clientRequestId never answers another's. A refusal burns nothing.
      Must not mutate state. */
  receiptScope?: (args: McpToolArgs, context?: McpToolCallContext) => Promise<string>;
};
export type McpToolBindings = Record<McpToolName, McpToolBinding>;

export interface McpBoundedNumericArg {
  path: readonly string[];
  min: number;
  max: number;
  fallback: number;
  role?: RoleId;
}

/**
 * Agent-facing numeric bounds whose nearest-valid interpretation is harmless.
 *
 * Deliberately absent: flow_action.rounds (operator mutation),
 * operator_snapshot.caller.pid (process identity),
 * conversation_migration.expectedRevision (concurrency identity), and
 * bridge_directive.utterance/ref (durable delivery identity). Those values keep
 * exact validation at the protocol boundary.
 */
export const MCP_BOUNDED_NUMERIC_ARGS: Partial<Record<McpToolName, readonly McpBoundedNumericArg[]>> = {
  spawn_agent: [
    { path: ["roleParams", "maxWorkers"], min: 1, max: 20, fallback: 3, role: "orchestrator" },
    { path: ["roleParams", "parallelN"], min: 1, max: 8, fallback: 1, role: "reviewer" },
  ],
  list_conversations: [
    { path: ["limit"], min: 1, max: 100, fallback: 50 },
  ],
  telegram_bot_messages: [
    { path: ["limit"], ...BOT_MESSAGES_LIMIT },
    { path: ["maxChars"], ...BOT_MESSAGES_MAX_CHARS },
  ],
  search_transcripts: [
    { path: ["limit"], min: 1, max: 100, fallback: 6 },
  ],
  search_memory: [
    { path: ["limit"], min: 1, max: 20, fallback: 10 },
  ],
  get_conversation: [
    { path: ["maxRecords"], min: 1, max: 500, fallback: 100 },
    { path: ["maxChars"], min: 1, max: 16_000, fallback: 4_000 },
    { path: ["tailLines"], min: 1, max: SELECTED_TAIL_MAX_LINES, fallback: 1 },
  ],
  conversation_messages: [
    { path: ["limit"], min: 1, max: 200, fallback: 20 },
    { path: ["maxChars"], min: 1, max: 16_000, fallback: 4_000 },
  ],
  board_snapshot: [
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  list_flows: [
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  list_pipelines: [
    { path: ["limit"], min: 1, max: PIPELINE_LIST_MAX_LIMIT, fallback: PIPELINE_LIST_DEFAULT_LIMIT },
  ],
  operator_snapshot: [
    { path: ["text", "lastMessages"], min: 1, max: MAX_SNAPSHOT_LAST_MESSAGES, fallback: 6 },
    { path: ["text", "maxCharsPerConversation"], min: 1, max: MAX_SNAPSHOT_CHARS_PER_CONVERSATION, fallback: 3_000 },
  ],
  list_tasks: [
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  deployment_status: [
    { path: ["limit"], min: 1, max: 100, fallback: 25 },
  ],
  agent_activity: [
    { path: ["stallAfterMs"], min: 1_000, max: 6 * 60 * 60_000, fallback: DEFAULT_STALL_AFTER_MS },
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  lifecycle_events: [
    { path: ["afterSeq"], min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
    { path: ["limit"], min: 1, max: 200, fallback: 50 },
    { path: ["maxItems"], min: 1, max: 25, fallback: 10 },
  ],
};

function compareDecimalIntegerToBound(value: string, bound: number): number {
  const unsigned = value.replace(/^[+-]/, "").replace(/^0+/, "") || "0";
  const negative = value.startsWith("-") && unsigned !== "0";
  const boundNegative = bound < 0;
  if (negative !== boundNegative) return negative ? -1 : 1;
  const boundUnsigned = String(Math.abs(bound));
  const magnitude = unsigned.length === boundUnsigned.length
    ? unsigned === boundUnsigned ? 0 : unsigned < boundUnsigned ? -1 : 1
    : unsigned.length < boundUnsigned.length ? -1 : 1;
  return negative ? -magnitude : magnitude;
}

function boundedNumericValue(value: unknown, spec: McpBoundedNumericArg): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Math.max(spec.min, Math.min(spec.max, value));
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const integer = value.trim();
    if (compareDecimalIntegerToBound(integer, spec.min) < 0) return spec.min;
    if (compareDecimalIntegerToBound(integer, spec.max) > 0) return spec.max;
    return Number(integer);
  }
  if (typeof value === "string"
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    const numeric = Number(value.trim());
    if (numeric === Number.POSITIVE_INFINITY) return spec.max;
    if (numeric === Number.NEGATIVE_INFINITY) return spec.min;
    if (Number.isInteger(numeric)) return Math.max(spec.min, Math.min(spec.max, numeric));
  }
  return Math.max(spec.min, Math.min(spec.max, spec.fallback));
}

function valueAtPath(args: McpToolArgs, pathParts: readonly string[]): unknown {
  let value: unknown = args;
  for (const part of pathParts) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function setValueAtPath(args: McpToolArgs, pathParts: readonly string[], value: number): void {
  let target: Record<string, unknown> = args;
  for (const part of pathParts.slice(0, -1)) {
    const nested = isRecord(target[part]) ? { ...target[part] } : {};
    target[part] = nested;
    target = nested;
  }
  target[pathParts.at(-1)!] = value;
}

export function normalizeBoundedMcpNumerics(
  toolName: McpToolName,
  args: McpToolArgs,
): { args: McpToolArgs; clamped?: Record<string, number> } {
  const specs = MCP_BOUNDED_NUMERIC_ARGS[toolName];
  if (!specs?.length) return { args };
  const normalized = { ...args };
  const clamped: Record<string, number> = {};
  for (const spec of specs) {
    if (spec.role !== undefined && args.role !== spec.role) continue;
    const input = valueAtPath(args, spec.path);
    if (input === undefined) continue;
    const applied = boundedNumericValue(input, toolName === "search_transcripts" && args.order === "newest" ? { ...spec, fallback: 20 } : spec);
    setValueAtPath(normalized, spec.path, applied);
    if (typeof input !== "number" || !Object.is(input, applied)) {
      clamped[spec.path.join(".")] = applied;
    }
  }
  return Object.keys(clamped).length ? { args: normalized, clamped } : { args: normalized };
}

export type McpToolSuccess = McpToolPayload & {
  ok: true;
  toolName: McpToolName;
  clientRequestId: string | null;
  replayed: boolean;
};

export type McpToolFailure = {
  ok: false;
  toolName: string;
  clientRequestId: string | null;
  replayed: boolean;
  error: string;
  code: string;
  retryable: boolean;
  /** Structured evidence a binding attached to its refusal, so an agent gets the
      same payload an HTTP caller does instead of only the prose message. */
  details?: McpToolPayload;
};

/** Thrown by a binding that refuses with machine-readable evidence. */
export class McpToolRefusal extends Error {
  constructor(message: string, readonly details: McpToolPayload) {
    super(message);
    this.name = "McpToolRefusal";
  }
}

/**
 * A refusal that happened BEFORE the operation was admitted (#1766).
 *
 * The binding has proven that nothing was created, reserved or dispatched — a
 * store lock that was never taken is the case this exists for. Such a refusal
 * does not consume the `clientRequestId`: its claim is released instead of
 * settled, so repeating the SAME logical call under the SAME key runs the
 * operation again rather than replaying the refusal for ever. A refusal that
 * IS meant to be remembered stays an ordinary `McpToolRefusal`, answers
 * `retryable: false`, and keeps its receipt.
 */
export class McpUnadmittedRefusal extends McpToolRefusal {
  constructor(message: string, details: McpToolPayload = {}) {
    super(message, {
      outcome: "not-executed",
      evidence: "not-admitted",
      nextAction: "retry-same-key",
      ...details,
    });
    this.name = "McpUnadmittedRefusal";
  }
}

export type McpToolResult = McpToolSuccess | McpToolFailure;

/**
 * Where one recoverable mutation's dispatch stands (#1490).
 *
 * `claimed` — the receipt row exists and NOTHING has been sent: the process
 * that owns it has not yet marked the dispatch. `dispatching` — the owner wrote
 * this marker before its one and only POST, so the server may hold the request
 * from this moment on and nothing can prove otherwise. `not-executed` — the
 * attempt was permanently closed while still `claimed`, so it can never be
 * dispatched: the one state that proves zero effect. `settled` — a result was
 * written. Rows written before this field existed carry null and are treated
 * as legacy: their fate is whatever downstream evidence says, never assumed.
 */
export type McpDispatchStage = "claimed" | "dispatching" | "not-executed" | "settled";

/** The server-resolved identity of who made a recoverable call. Never read
    from the arguments: the authority resolver decides it. */
export interface McpRequestCaller {
  kind: "root" | "worker" | "unidentified";
  conversationId: string | null;
  project: string | null;
  /** Server-derived predecessor seats that the current caller may recover. */
  predecessors?: string[];
}

export interface McpRequestTarget {
  /** Canonical project of the target (the recipient's for a send, the
      launch directory's for a spawn), or null when it has none. */
  project: string | null;
  /** Canonical target identity: the alias-resolved conversation id or
      transcript path for a send, the resolved working directory for a spawn. */
  identity: string | null;
}

/** What a recoverable tool's binding contributes to the durable claim. */
export interface McpRequestBindingInput {
  caller: McpRequestCaller;
  target: McpRequestTarget;
  /** The EXACT idempotency key handed downstream (clientAttemptId for a
      spawn, clientMessageId for a send). Persisted so recovery reads the same
      key the dispatch used, never a recomputed one. */
  downstreamKey: string;
  /** Relay admission's server-derived text and author, captured before dispatch
      so recovery verifies the actual durable payload after rotation/restart. */
  sendPayload?: { text: string; origin: MessageOrigin };
}

/** The identity persisted with a recoverable mutation's claim, before its
    dispatch, so recovery under the original clientRequestId can be authorised
    and can find the downstream record without any caller-supplied fact. */
export interface McpRequestBinding extends McpRequestBindingInput {
  version: 1;
  toolName: McpToolName;
  clientRequestId: string;
  /** The process that holds the claim, so a `claimed` row whose owner is gone
      can be closed as never dispatched instead of waiting forever. */
  owner: { pid: number; startIdentity: string | null };
  claimedAt: string;
}

export interface McpReceiptRecord {
  digest: string;
  result: McpToolResult | null;
  /** Stronger terminal recovery, kept separately from the ordinary replay. */
  recoveryResult?: McpToolResult | null;
  binding: McpRequestBinding | null;
  stage: McpDispatchStage | null;
}

type Receipt = {
  digest: string;
  result?: McpToolResult;
  recoveryResult?: McpToolResult;
  binding?: McpRequestBinding;
  stage?: McpDispatchStage;
};

export type ReceiptClaim =
  | { kind: "fresh" }
  | { kind: "pending"; unfinishedAgeMs?: number; record?: McpReceiptRecord }
  | { kind: "replay"; result: McpToolResult; record?: McpReceiptRecord }
  | { kind: "conflict"; record?: McpReceiptRecord };

export interface McpReceiptStore {
  claim(key: string, digest: string, retention: ReceiptRetention, binding?: McpRequestBinding): ReceiptClaim | Promise<ReceiptClaim>;
  complete(key: string, digest: string, result: McpToolResult, retention: ReceiptRetention): void | Promise<void>;
  /** Drop an unsettled claim so its `clientRequestId` can be used again
      (#1766). Only a claim this call still holds — same digest, no result
      recorded — is released; anything already settled is left exactly as it
      is. Optional so a minimal store keeps working: without it an unadmitted
      refusal is settled as before rather than silently stranding a claim. */
  release?(key: string, digest: string, unadmittedBinding?: McpRequestBinding): boolean | Promise<boolean>;
}

/**
 * The store surface original-key recovery needs (#1490). Every transition is
 * conditional on the row's current stage, so two processes racing over one
 * key can never both dispatch, and a late answer can never overwrite an
 * earlier terminal one.
 */
export interface McpRecoveryReceiptStore extends McpReceiptStore {
  /** Read one row without claiming it. */
  lookup(key: string): McpReceiptRecord | null | Promise<McpReceiptRecord | null>;
  /** `claimed` → `dispatching`. False means the attempt was closed by someone
      else first, and the caller must not dispatch. */
  markDispatching(key: string, digest: string): boolean | Promise<boolean>;
  /** Fill an absent orchestrator recipient once, under the original claim owner. */
  bindCreatedTarget?(key: string, digest: string, binding: McpRequestBinding, identity: string): boolean | Promise<boolean>;
  /** `claimed` → `not-executed`, writing the terminal result. False means the
      row is no longer merely claimed (it was dispatched, or already closed). */
  fenceUndispatched(key: string, digest: string, result: McpToolResult): boolean | Promise<boolean>;
  /** Writes the result only if none is recorded yet, and returns whatever the
      row holds afterwards — the first terminal answer always wins. Recovery
      may save stronger terminal evidence alongside an ordinary acceptance. */
  settle(key: string, digest: string, result: McpToolResult, stage?: "settled" | "not-executed", recovery?: boolean): McpToolResult | Promise<McpToolResult>;
}

export function supportsMcpRecovery(store: McpReceiptStore): store is McpRecoveryReceiptStore {
  const candidate = store as Partial<McpRecoveryReceiptStore>;
  return typeof candidate.lookup === "function"
    && typeof candidate.markDispatching === "function"
    && typeof candidate.fenceUndispatched === "function"
    && typeof candidate.settle === "function";
}

/** A claim whose tool was already dispatched is never released: absence would
    then be read as "nothing ran", which is exactly what it is not (#1766). */
function dispatchedReceipt(receipt: Receipt): boolean {
  return receipt.stage === "dispatching";
}

function recordOf(receipt: Receipt): McpReceiptRecord {
  return {
    digest: receipt.digest,
    result: receipt.result ?? null,
    ...(receipt.recoveryResult ? { recoveryResult: receipt.recoveryResult } : {}),
    binding: receipt.binding ?? null,
    stage: receipt.stage ?? (receipt.result ? "settled" : null),
  };
}

function terminalReceiptResult(result: McpToolResult | null | undefined): result is McpToolResult {
  return Boolean(result && (result.ok
    ? result.outcome === "settled" || result.settled === true
      || (result.toolName === "spawn_agent" && result.state === "settled")
    : result.details?.outcome === "settled" || result.details?.outcome === "not-executed"));
}

function receiptSettlement(
  receipt: Receipt,
  result: McpToolResult,
  stage: "settled" | "not-executed",
  recovery: boolean,
): { receipt: Receipt; result: McpToolResult } {
  if (recovery && !terminalReceiptResult(result)) throw new Error("MCP recovery requires terminal evidence");
  if (receipt.recoveryResult) return { receipt, result: receipt.recoveryResult };
  if (receipt.result) {
    if (recovery && !terminalReceiptResult(receipt.result) && receipt.stage !== "not-executed") {
      return { receipt: { ...receipt, recoveryResult: result, stage }, result };
    }
    return { receipt, result: receipt.result };
  }
  return { receipt: { ...receipt, result, stage }, result };
}

export class MemoryMcpReceiptStore implements McpRecoveryReceiptStore {
  private readonly receipts = new Map<string, Receipt>();

  claim(key: string, digest: string, _retention?: ReceiptRetention, binding?: McpRequestBinding): ReceiptClaim {
    const receipt = this.receipts.get(key);
    if (!receipt) {
      this.receipts.set(key, { digest, ...(binding ? { binding, stage: "claimed" } : {}) });
      return { kind: "fresh" };
    }
    const record = recordOf(receipt);
    if (receipt.digest !== digest) return { kind: "conflict", record };
    return receipt.result ? { kind: "replay", result: receipt.result, record } : { kind: "pending", record };
  }

  complete(key: string, digest: string, result: McpToolResult): void {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
    this.receipts.set(key, { ...receipt, digest, result, stage: "settled" });
  }

  release(key: string, digest: string, unadmittedBinding?: McpRequestBinding): boolean {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.digest !== digest || receipt.result || (dispatchedReceipt(receipt)
      && (!unadmittedBinding || JSON.stringify(receipt.binding) !== JSON.stringify(unadmittedBinding)))) return false;
    this.receipts.delete(key);
    return true;
  }

  lookup(key: string): McpReceiptRecord | null {
    const receipt = this.receipts.get(key);
    return receipt ? recordOf(receipt) : null;
  }

  markDispatching(key: string, digest: string): boolean {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.digest !== digest || receipt.stage !== "claimed" || receipt.result) return false;
    this.receipts.set(key, { ...receipt, stage: "dispatching" });
    return true;
  }

  bindCreatedTarget(key: string, digest: string, binding: McpRequestBinding, identity: string): boolean {
    const receipt = this.receipts.get(key);
    const next = receipt?.digest === digest ? withCreatedTarget(receipt, binding, identity) : null;
    if (!next) return false;
    this.receipts.set(key, next);
    return true;
  }

  fenceUndispatched(key: string, digest: string, result: McpToolResult): boolean {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.digest !== digest || receipt.stage !== "claimed" || receipt.result) return false;
    this.receipts.set(key, { ...receipt, result, stage: "not-executed" });
    return true;
  }

  settle(key: string, digest: string, result: McpToolResult, stage: "settled" | "not-executed" = "settled", recovery = false): McpToolResult {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
    const settled = receiptSettlement(receipt, result, stage, recovery);
    this.receipts.set(key, settled.receipt);
    return settled.result;
  }

}

/** Only the original dispatch owner may fill the absent recipient. A later
    seat rotation cannot replace a recipient already held by the receipt. */
function withCreatedTarget(receipt: Receipt | undefined, binding: McpRequestBinding, identity: string): Receipt | null {
  const held = receipt?.binding;
  if (!receipt || receipt.stage !== "dispatching" || receipt.result || receipt.recoveryResult
    || !held || held.toolName !== "send_message_to_orchestrator"
    || held.target.identity !== null || !/^conversation_[A-Za-z0-9_-]{1,128}$/.test(identity)
    || JSON.stringify(held) !== JSON.stringify(binding)) return null;
  return { ...receipt, binding: { ...held, target: { ...held.target, identity } } };
}

type ReceiptFile = {
  version: 2;
  readReceipts: Record<string, Receipt>;
  mutationReceipts: Record<string, Receipt>;
};

const FILE_RECEIPT_CAP = 500;
const SQLITE_READ_RECEIPT_BYTE_CAP = 8 * 1024 * 1024;
const SQLITE_BOUNDED_PENDING_TTL_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
type ReceiptLockOwner = { pid: number; startIdentity: string | null; token: string };
type ReceiptLockIdentity = { dev: number; ino: number };
type ReceiptLockObservation = {
  identity: ReceiptLockIdentity;
  mtimeMs: number;
  owner: ReceiptLockOwner | null;
  token: string | null;
};
type ReceiptRecoveryOwner = ReceiptLockOwner & {
  version: 1;
  epoch: number;
  targetDev: number;
  targetIno: number;
  targetToken: string | null;
};
type ReceiptRecoveryClaim = {
  owner: ReceiptRecoveryOwner;
  ownerPath: string;
};
type ReceiptRecoveryOwnerEntry = {
  owner: ReceiptRecoveryOwner;
  ownerPath: string;
};
type ReceiptRecoveryOwnerScan =
  | { kind: "owners"; entries: ReceiptRecoveryOwnerEntry[] }
  | { kind: "retry" };
type ReceiptRecoveryAttempt = "removed" | "blocked" | "retry";
type ReceiptRecoveryNamespaceState = "clear" | "blocked" | "retry";
type PendingRecoveryOwner = {
  pid: number;
  startIdentityTag: string | null;
};

// Append-only epochs provide one retirement owner without replacing a live
// claim. A successor publishes the next epoch only after the current owner dies.
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/** A receipt's key: the tool, the owner its binding's `receiptScope` named
    (hashed, so the key carries no identity), and the caller's request id. */
function receiptKey(toolName: McpToolName, requestId: string, scope: string | null): string {
  return scope === null
    ? `${toolName}:${requestId}`
    : `${toolName}@${crypto.createHash("sha256").update(scope).digest("hex").slice(0, 32)}:${requestId}`;
}

function receiptKeyParts(key: string): { toolName: McpToolName; requestId: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const toolName = key.slice(0, separator).replace(/@[0-9a-f]{32}$/, "");
  const requestId = key.slice(separator + 1);
  if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName) || !requestId.trim()) return null;
  return { toolName: toolName as McpToolName, requestId };
}

function validReceiptResult(value: unknown, toolName: McpToolName, requestId: string): value is McpToolResult {
  if (!isRecord(value)
    || value.toolName !== toolName
    || value.clientRequestId !== requestId
    || typeof value.replayed !== "boolean") return false;
  if (value.ok === true) return true;
  return value.ok === false
    && typeof value.error === "string"
    && typeof value.code === "string"
    && typeof value.retryable === "boolean";
}

const RECEIPT_MEMBER_KEYS = ["binding", "digest", "recoveryResult", "result", "stage"] as const;
const DISPATCH_STAGES: ReadonlySet<string> = new Set<McpDispatchStage>(["claimed", "dispatching", "not-executed", "settled"]);

function isDispatchStage(value: unknown): value is McpDispatchStage {
  return typeof value === "string" && DISPATCH_STAGES.has(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function validRequestBinding(value: unknown, toolName?: McpToolName, requestId?: string): value is McpRequestBinding {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.toolName !== "string" || !(MCP_TOOL_NAMES as readonly string[]).includes(value.toolName)) return false;
  if (toolName !== undefined && value.toolName !== toolName) return false;
  if (typeof value.clientRequestId !== "string" || (requestId !== undefined && value.clientRequestId !== requestId)) return false;
  if (typeof value.downstreamKey !== "string" || !value.downstreamKey) return false;
  if (value.sendPayload !== undefined && (!isRecord(value.sendPayload)
    || typeof value.sendPayload.text !== "string" || !parseMessageOrigin(value.sendPayload.origin))) return false;
  if (typeof value.claimedAt !== "string") return false;
  const { caller, target, owner } = value;
  if (!isRecord(caller) || !["root", "worker", "unidentified"].includes(String(caller.kind))
    || !nullableString(caller.conversationId) || !nullableString(caller.project)
    || (caller.predecessors !== undefined
      && (!Array.isArray(caller.predecessors)
        || caller.predecessors.length > 32
        || caller.predecessors.some((predecessor) => typeof predecessor !== "string" || !/^conversation_[A-Za-z0-9_-]{1,128}$/.test(predecessor))))) return false;
  if (!isRecord(target) || !nullableString(target.project) || !nullableString(target.identity)) return false;
  if (!isRecord(owner) || typeof owner.pid !== "number" || !nullableString(owner.startIdentity)) return false;
  return true;
}

function validateReceiptRecord(
  value: unknown,
  retention?: ReceiptRetention,
): Record<string, Receipt> {
  if (!isRecord(value)) throw new Error("invalid MCP receipt file: receipt collection must be an object");
  const receipts: Record<string, Receipt> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const parts = receiptKeyParts(key);
    if (!parts) throw new Error(`invalid MCP receipt file: invalid receipt key ${JSON.stringify(key)}`);
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, RECEIPT_MEMBER_KEYS.filter((member) => member in candidate))
      || typeof candidate.digest !== "string"
      || !/^[0-9a-f]{64}$/i.test(candidate.digest)
      || ("result" in candidate && !validReceiptResult(candidate.result, parts.toolName, parts.requestId))
      || ("recoveryResult" in candidate && (!validReceiptResult(candidate.recoveryResult, parts.toolName, parts.requestId) || !terminalReceiptResult(candidate.recoveryResult)))
      || ("binding" in candidate && !validRequestBinding(candidate.binding, parts.toolName, parts.requestId))
      || ("stage" in candidate && !isDispatchStage(candidate.stage))) {
      throw new Error(`invalid MCP receipt file: invalid receipt ${JSON.stringify(key)}`);
    }
    const actualRetention: ReceiptRetention = MUTATING_MCP_TOOL_NAMES.has(parts.toolName) ? "durable" : "bounded";
    if (retention && actualRetention !== retention) {
      throw new Error(`invalid MCP receipt file: receipt ${JSON.stringify(key)} is in the wrong collection`);
    }
    receipts[key] = candidate as Receipt;
  }
  return receipts;
}

function readLockMetadata(lockPath: string): { owner: ReceiptLockOwner | null; token: string | null } {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ReceiptLockOwner>;
    const token = typeof value.token === "string" && value.token ? value.token : null;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0
      || !(value.startIdentity === null || typeof value.startIdentity === "string")
      || token === null) return { owner: null, token };
    return { owner: value as ReceiptLockOwner, token };
  } catch {
    return { owner: null, token: null };
  }
}

function sameLock(lockPath: string, identity: ReceiptLockIdentity): boolean {
  try {
    const current = fs.statSync(lockPath);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function observeLock(lockPath: string): ReceiptLockObservation | null {
  try {
    const before = fs.statSync(lockPath);
    const metadata = readLockMetadata(lockPath);
    const after = fs.statSync(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) return null;
    return {
      identity: { dev: after.dev, ino: after.ino },
      mtimeMs: after.mtimeMs,
      ...metadata,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function processOwnerAlive(owner: ReceiptLockOwner): boolean {
  if (!procBackend.pidAlive(owner.pid)) return false;
  if (owner.startIdentity === null) return true;
  const currentIdentity = procBackend.processIdentity(owner.pid);
  return currentIdentity === null || currentIdentity === owner.startIdentity;
}

function staleLock(observation: ReceiptLockObservation): boolean {
  if (observation.owner) return !processOwnerAlive(observation.owner);
  return Date.now() - observation.mtimeMs > LOCK_STALE_MS;
}

function recoveryOwnerPrefix(recoveryPath: string): string {
  return `${recoveryPath}.recovery-owner-`;
}

function waitForRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The clock a receipt-lock wait measures its deadline on, and the pause
    between its attempts. Production keeps the wall clock and a real timer; the
    lock harness swaps in a stepped clock so a whole 5 s wait is walked through
    exactly, on a count of pauses rather than a runner's speed (#1761). Lock
    staleness is always read against the real clock, because it is measured
    against a file's mtime. */
export interface ReceiptLockClock {
  now(): number;
  pause(milliseconds: number): Promise<void>;
}

const wallReceiptLockClock: ReceiptLockClock = { now: () => Date.now(), pause: waitForRetry };
let receiptLockClock: ReceiptLockClock = wallReceiptLockClock;

export function setReceiptLockClockForTests(clock: ReceiptLockClock | null): void {
  receiptLockClock = clock ?? wallReceiptLockClock;
}

function recoveryIdentityTag(identity: string | null): string {
  return identity === null
    ? "unknown"
    : crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

function recoveryTargetTag(token: string | null): string {
  return token === null
    ? "unknown"
    : crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function readRecoveryOwner(ownerPath: string): ReceiptRecoveryOwner {
  const value = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as unknown;
  if (!isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.epoch)
    || (value.epoch as number) < 0
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || !(value.startIdentity === null || typeof value.startIdentity === "string")
    || typeof value.token !== "string"
    || !value.token
    || !Number.isSafeInteger(value.targetDev)
    || !Number.isSafeInteger(value.targetIno)
    || !(value.targetToken === null || typeof value.targetToken === "string")) {
    throw new Error("invalid MCP receipt recovery owner");
  }
  return value as ReceiptRecoveryOwner;
}

function recoveryOwnerTargets(owner: ReceiptRecoveryOwner, observation: ReceiptLockObservation): boolean {
  return owner.targetDev === observation.identity.dev
    && owner.targetIno === observation.identity.ino
    && owner.targetToken === observation.token;
}

function recoveryOwners(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): ReceiptRecoveryOwnerScan {
  if (receiptLockClock.now() >= deadline) return { kind: "retry" };
  const directory = path.dirname(recoveryPath);
  const prefix = path.basename(recoveryOwnerPrefix(recoveryPath));
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "ENOENT") throw mkdirError;
    }
    return { kind: "retry" };
  }
  const entries: ReceiptRecoveryOwnerEntry[] = [];
  for (const entry of names) {
    if (!entry.startsWith(prefix)) continue;
    const epochText = entry.slice(prefix.length);
    if (!/^(?:0|[1-9][0-9]*)$/.test(epochText)) continue;
    const ownerPath = path.join(directory, entry);
    let owner: ReceiptRecoveryOwner;
    try {
      owner = readRecoveryOwner(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "retry" };
      throw error;
    }
    if (owner.epoch !== Number(epochText)) throw new Error("invalid MCP receipt recovery owner epoch");
    /* The namespace is named by the lock's inode, and an inode number is
       handed out again once its last link is gone. An entry for another token
       at the same inode belongs to another generation of the lock. Its
       retirement guards other files, so it neither owns nor blocks this one;
       the two share only the epoch names (`claimRecoveryOwnership`). */
    if (!recoveryOwnerTargets(owner, observation)) continue;
    entries.push({ owner, ownerPath });
  }
  entries.sort((left, right) => left.owner.epoch - right.owner.epoch);
  return { kind: "owners", entries };
}

/** The owners of this lock generation's retirement, or null when they cannot
    be read before the deadline. */
async function recoveryOwnersUntil(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): Promise<ReceiptRecoveryOwnerEntry[] | null> {
  while (receiptLockClock.now() < deadline) {
    const scan = recoveryOwners(recoveryPath, observation, deadline);
    if (scan.kind === "owners") return scan.entries;
    await receiptLockClock.pause(Math.min(10, Math.max(1, deadline - receiptLockClock.now())));
  }
  return null;
}

function publishRecoveryOwner(
  recoveryPath: string,
  owner: ReceiptRecoveryOwner,
): string | null {
  const ownerPath = `${recoveryOwnerPrefix(recoveryPath)}${owner.epoch}`;
  const temporary = `${ownerPath}.pending-v1-${owner.pid}-${recoveryIdentityTag(owner.startIdentity)}-${recoveryTargetTag(owner.targetToken)}-${owner.token}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(owner));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, ownerPath);
      return ownerPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function claimRecoveryOwnership(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): Promise<ReceiptRecoveryClaim | "blocked" | "retry"> {
  const token = crypto.randomUUID();
  while (true) {
    const owners = await recoveryOwnersUntil(recoveryPath, observation, deadline);
    if (!owners) return "retry";
    const current = owners.at(-1)?.owner;
    if (current && processOwnerAlive(current)) return "blocked";
    const owner: ReceiptRecoveryOwner = {
      version: 1,
      epoch: (current?.epoch ?? -1) + 1,
      pid: process.pid,
      startIdentity: procBackend.processIdentity(process.pid),
      token,
      targetDev: observation.identity.dev,
      targetIno: observation.identity.ino,
      targetToken: observation.token,
    };
    const ownerPath = publishRecoveryOwner(recoveryPath, owner);
    if (ownerPath) return { owner, ownerPath };
    /* Another claimant published this epoch first. This generation's winner
       shows in the next scan. Another generation's holds only the name, and
       this claimant has published nothing while it waits, so no two
       generations ever wait on each other: a live one unlinks the name within
       its own retirement, a dead one only when residue cleanup retires it
       under its own target. */
    let holder: ReceiptRecoveryOwner;
    try {
      holder = readRecoveryOwner(`${recoveryOwnerPrefix(recoveryPath)}${owner.epoch}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (recoveryOwnerTargets(holder, observation)) continue;
    if (!processOwnerAlive(holder)) return "retry";
    await receiptLockClock.pause(Math.min(10, Math.max(1, deadline - receiptLockClock.now())));
  }
}

async function recoveryClaimCurrent(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  claim: ReceiptRecoveryClaim,
  deadline: number,
): Promise<boolean> {
  const owners = await recoveryOwnersUntil(recoveryPath, observation, deadline);
  if (!owners) return false;
  const current = owners.at(-1);
  return current?.owner.token === claim.owner.token && current.ownerPath === claim.ownerPath;
}

function pendingRecoveryOwner(entry: string, prefix: string): PendingRecoveryOwner | null {
  if (!entry.startsWith(prefix)) return null;
  const suffix = entry.slice(prefix.length);
  const current = /^(?:0|[1-9][0-9]*)\.pending-v1-([1-9][0-9]*)-(unknown|[0-9a-f]{32})-(?:unknown|[0-9a-f]{32})-[0-9a-f-]{36}$/i.exec(suffix);
  if (current) {
    const pid = Number(current[1]);
    if (!Number.isSafeInteger(pid)) return null;
    return {
      pid,
      startIdentityTag: current[2] === "unknown" ? null : current[2]!.toLowerCase(),
    };
  }
  const legacy = /^(?:0|[1-9][0-9]*)\.pending-([1-9][0-9]*)-[0-9a-f-]{36}$/i.exec(suffix);
  if (!legacy) return null;
  const pid = Number(legacy[1]);
  return Number.isSafeInteger(pid) ? { pid, startIdentityTag: null } : null;
}

function pendingRecoveryOwnerAlive(owner: PendingRecoveryOwner): boolean {
  if (!procBackend.pidAlive(owner.pid)) return false;
  if (owner.startIdentityTag === null) return true;
  const currentIdentity = procBackend.processIdentity(owner.pid);
  return currentIdentity === null || recoveryIdentityTag(currentIdentity) === owner.startIdentityTag;
}

function removeDeadRecoveryOwnerAliases(
  recoveryPath: string,
): void {
  const directory = path.dirname(recoveryPath);
  const prefix = path.basename(recoveryOwnerPrefix(recoveryPath));
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const owner = pendingRecoveryOwner(entry, prefix);
    if (!owner || pendingRecoveryOwnerAlive(owner)) continue;
    const ownerPath = path.join(directory, entry);
    try {
      fs.unlinkSync(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function recoveryPathsForLock(lockPath: string): string[] {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  const marker = ".recovering";
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const markerIndex = entry.indexOf(marker, prefix.length);
    if (markerIndex < 0) continue;
    const suffix = entry.slice(markerIndex + marker.length);
    if (suffix && !suffix.startsWith(".recovery-owner-")) continue;
    paths.add(path.join(directory, entry.slice(0, markerIndex + marker.length)));
  }
  return [...paths];
}

/** Every lock generation that left something in this namespace: the one the
    recovery link names and each one an owner entry targets. The generation
    with the newest epoch comes first. Its successor epoch is a name nobody
    holds, so residue retired in this order never meets an epoch name that
    another dead generation still has. */
function abandonedRecoveryObservations(recoveryPath: string): ReceiptLockObservation[] {
  const generations: Array<{ observation: ReceiptLockObservation; epoch: number }> = [];
  const linked = observeLock(recoveryPath);
  if (linked) generations.push({ observation: linked, epoch: -1 });
  const directory = path.dirname(recoveryPath);
  const prefix = path.basename(recoveryOwnerPrefix(recoveryPath));
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const epochText = entry.slice(prefix.length);
    if (!/^(?:0|[1-9][0-9]*)$/.test(epochText)) continue;
    let owner: ReceiptRecoveryOwner;
    try {
      owner = readRecoveryOwner(path.join(directory, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (owner.epoch !== Number(epochText)) throw new Error("invalid MCP receipt recovery owner epoch");
    const generation = generations.find(({ observation }) => recoveryOwnerTargets(owner, observation));
    if (generation) {
      generation.epoch = Math.max(generation.epoch, owner.epoch);
    } else {
      generations.push({
        observation: {
          identity: { dev: owner.targetDev, ino: owner.targetIno },
          mtimeMs: 0,
          owner: null,
          token: owner.targetToken,
        },
        epoch: owner.epoch,
      });
    }
  }
  return generations
    .sort((left, right) => right.epoch - left.epoch)
    .map(({ observation }) => observation);
}

function lockReferencesObservation(lockPath: string, observation: ReceiptLockObservation): boolean {
  return sameLock(lockPath, observation.identity)
    && readLockMetadata(lockPath).token === observation.token;
}

async function cleanupAbandonedRecoveryArtifacts(
  lockPath: string,
  deadline: number,
): Promise<ReceiptRecoveryNamespaceState> {
  for (const recoveryPath of recoveryPathsForLock(lockPath)) {
    removeDeadRecoveryOwnerAliases(recoveryPath);
    const observations = abandonedRecoveryObservations(recoveryPath);
    if (observations.length === 0) {
      if (recoveryPathsForLock(lockPath).includes(recoveryPath)) return "retry";
      continue;
    }
    for (const observation of observations) {
      if (lockReferencesObservation(lockPath, observation)) continue;
      const claim = await claimRecoveryOwnership(recoveryPath, observation, deadline);
      if (claim === "blocked" || claim === "retry") return claim;
      let cleaned = false;
      try {
        if (!await recoveryClaimCurrent(recoveryPath, observation, claim, deadline)
          || lockReferencesObservation(lockPath, observation)) return "retry";
        if (sameLock(recoveryPath, observation.identity)
          && readLockMetadata(recoveryPath).token === observation.token) {
          try {
            fs.unlinkSync(recoveryPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } finally {
        cleaned = await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline);
      }
      if (!cleaned) return "retry";
    }
  }
  return "clear";
}

/** A claimant that gives up takes its own entry with it. Left behind, a live
    process's entry blocks every other claimant of this generation until that
    process exits. */
function withdrawRecoveryClaim(claim: ReceiptRecoveryClaim): void {
  try {
    if (readRecoveryOwner(claim.ownerPath).token === claim.owner.token) fs.unlinkSync(claim.ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function releaseRecoveryOwnership(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  claim: ReceiptRecoveryClaim,
  deadline: number,
): Promise<boolean> {
  const owners = await recoveryClaimCurrent(recoveryPath, observation, claim, deadline)
    ? await recoveryOwnersUntil(recoveryPath, observation, deadline)
    : null;
  if (!owners) {
    withdrawRecoveryClaim(claim);
    return false;
  }
  for (const { ownerPath } of owners.reverse()) {
    try {
      fs.unlinkSync(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  removeDeadRecoveryOwnerAliases(recoveryPath);
  return true;
}

async function removeObservedLock(
  lockPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): Promise<ReceiptRecoveryAttempt> {
  const recoveryPath = `${lockPath}.${observation.identity.dev}-${observation.identity.ino}.recovering`;
  const claim = await claimRecoveryOwnership(recoveryPath, observation, deadline);
  if (claim === "blocked" || claim === "retry") return claim;
  try {
    fs.linkSync(lockPath, recoveryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline)
        ? "blocked"
        : "retry";
    }
    if (code !== "EEXIST") {
      await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline);
      throw error;
    }
  }
  let outcome: ReceiptRecoveryAttempt = "blocked";
  try {
    const recoveryMetadata = readLockMetadata(recoveryPath);
    if (await recoveryClaimCurrent(recoveryPath, observation, claim, deadline)
      && sameLock(recoveryPath, observation.identity)
      && recoveryMetadata.token === observation.token
      && sameLock(lockPath, observation.identity)
      && readLockMetadata(lockPath).token === observation.token) {
      try {
        fs.unlinkSync(lockPath);
        outcome = "removed";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    if (sameLock(recoveryPath, observation.identity)
      && readLockMetadata(recoveryPath).token === observation.token) {
      try {
        fs.unlinkSync(recoveryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline)) {
      outcome = "retry";
    }
  }
  return outcome;
}

async function waitForLockRetry(deadline: number): Promise<void> {
  if (receiptLockClock.now() >= deadline) throw new Error("MCP receipt store is busy");
  await receiptLockClock.pause(Math.min(10, Math.max(1, deadline - receiptLockClock.now())));
}

async function withFileLock<T>(filePath: string, operation: () => T): Promise<T> {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = receiptLockClock.now() + LOCK_WAIT_MS;
  const owner: ReceiptLockOwner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  while (true) {
    const namespaceState = await cleanupAbandonedRecoveryArtifacts(lockPath, deadline);
    if (namespaceState !== "clear") {
      await waitForLockRetry(deadline);
      continue;
    }
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      let observation: ReceiptLockObservation | null = null;
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
        fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        observation = {
          identity: { dev: stat.dev, ino: stat.ino },
          mtimeMs: stat.mtimeMs,
          owner,
          token: owner.token,
        };
        return operation();
      } finally {
        fs.closeSync(fd);
        if (observation) {
          const retirementDeadline = receiptLockClock.now() + LOCK_WAIT_MS;
          let retired = await removeObservedLock(lockPath, observation, retirementDeadline);
          /* A retirement that could not claim found another generation's dead
             owner on its epoch name. Residue cleanup retires that owner; no
             outer loop comes back here to do it. */
          while (retired === "retry" && receiptLockClock.now() < retirementDeadline) {
            if (await cleanupAbandonedRecoveryArtifacts(lockPath, retirementDeadline) !== "clear") {
              await receiptLockClock.pause(Math.min(10, Math.max(1, retirementDeadline - receiptLockClock.now())));
            }
            retired = await removeObservedLock(lockPath, observation, retirementDeadline);
          }
          if (retired === "retry"
            || (retired !== "removed"
              && sameLock(lockPath, observation.identity)
              && readLockMetadata(lockPath).token === observation.token)) {
            throw new Error("MCP receipt lock retirement timed out");
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } else if (code !== "EEXIST") {
        throw error;
      }
      const observation = observeLock(lockPath);
      if (observation && staleLock(observation)
        && await removeObservedLock(lockPath, observation, deadline) === "removed") continue;
      await waitForLockRetry(deadline);
    }
  }
}

function readReceiptFile(filePath: string): ReceiptFile {
  let serialized: string;
  try {
    serialized = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, readReceipts: {}, mutationReceipts: {} };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("invalid MCP receipt file: invalid JSON", { cause: error });
  }
  if (!isRecord(parsed) || !Number.isInteger(parsed.version)) {
    throw new Error("invalid MCP receipt file: root must contain an integer version");
  }
  if (parsed.version === 2) {
    if (!hasExactKeys(parsed, ["mutationReceipts", "readReceipts", "version"])) {
      throw new Error("invalid MCP receipt file: invalid v2 members");
    }
    const readReceipts = validateReceiptRecord(parsed.readReceipts, "bounded");
    const mutationReceipts = validateReceiptRecord(parsed.mutationReceipts, "durable");
    if (Object.keys(readReceipts).some((key) => key in mutationReceipts)) {
      throw new Error("invalid MCP receipt file: duplicate receipt key");
    }
    return { version: 2, readReceipts, mutationReceipts };
  }
  if (parsed.version === 1) {
    if (!hasExactKeys(parsed, ["receipts", "version"])) {
      throw new Error("invalid MCP receipt file: invalid v1 members");
    }
    const receipts = validateReceiptRecord(parsed.receipts);
    const readReceipts: Record<string, Receipt> = {};
    const mutationReceipts: Record<string, Receipt> = {};
    for (const [key, receipt] of Object.entries(receipts)) {
      const parts = receiptKeyParts(key)!;
      const target = MUTATING_MCP_TOOL_NAMES.has(parts.toolName) ? mutationReceipts : readReceipts;
      target[key] = receipt;
    }
    return { version: 2, readReceipts, mutationReceipts };
  }
  throw new Error(`unsupported MCP receipt file version: ${String(parsed.version)}`);
}

function writeReceiptFile(filePath: string, state: ReceiptFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export class FileMcpReceiptStore implements McpRecoveryReceiptStore {
  constructor(private readonly filePath: string) {}

  async claim(key: string, digest: string, retention: ReceiptRetention, binding?: McpRequestBinding): Promise<ReceiptClaim> {
    return withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      if (receipt) {
        const record = recordOf(receipt);
        if (receipt.digest !== digest) return { kind: "conflict", record };
        return receipt.result ? { kind: "replay", result: receipt.result, record } : { kind: "pending", record };
      }
      const target = retention === "durable" ? state.mutationReceipts : state.readReceipts;
      target[key] = { digest, ...(binding ? { binding, stage: "claimed" as const } : {}) };
      const keys = Object.keys(state.readReceipts);
      for (const expired of keys.slice(0, Math.max(0, keys.length - FILE_RECEIPT_CAP))) delete state.readReceipts[expired];
      writeReceiptFile(this.filePath, state);
      return { kind: "fresh" };
    });
  }

  async complete(key: string, digest: string, result: McpToolResult, retention: ReceiptRetention): Promise<void> {
    await withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
      const settled: Receipt = { ...receipt, digest, result, stage: "settled" };
      if (retention === "durable") {
        delete state.readReceipts[key];
        state.mutationReceipts[key] = settled;
      } else if (state.mutationReceipts[key]) {
        state.mutationReceipts[key] = settled;
      } else {
        state.readReceipts[key] = settled;
      }
      writeReceiptFile(this.filePath, state);
    });
  }

  async release(key: string, digest: string, unadmittedBinding?: McpRequestBinding): Promise<boolean> {
    return withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      if (!receipt || receipt.digest !== digest || receipt.result || (dispatchedReceipt(receipt)
        && (!unadmittedBinding || JSON.stringify(receipt.binding) !== JSON.stringify(unadmittedBinding)))) return false;
      delete state.mutationReceipts[key];
      delete state.readReceipts[key];
      writeReceiptFile(this.filePath, state);
      return true;
    });
  }

  async lookup(key: string): Promise<McpReceiptRecord | null> {
    return withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      return receipt ? recordOf(receipt) : null;
    });
  }

  private async transition(
    key: string,
    digest: string,
    apply: (receipt: Receipt | undefined) => Receipt | null,
  ): Promise<boolean> {
    return withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      if (receipt && receipt.digest !== digest) return false;
      const next = apply(receipt);
      if (!next) return false;
      delete state.readReceipts[key];
      state.mutationReceipts[key] = next;
      writeReceiptFile(this.filePath, state);
      return true;
    });
  }

  markDispatching(key: string, digest: string): Promise<boolean> {
    return this.transition(key, digest, (receipt) =>
      receipt && receipt.stage === "claimed" && !receipt.result ? { ...receipt, stage: "dispatching" } : null);
  }

  bindCreatedTarget(key: string, digest: string, binding: McpRequestBinding, identity: string): Promise<boolean> {
    return this.transition(key, digest, (receipt) => withCreatedTarget(receipt, binding, identity));
  }

  fenceUndispatched(key: string, digest: string, result: McpToolResult): Promise<boolean> {
    return this.transition(key, digest, (receipt) =>
      receipt && receipt.stage === "claimed" && !receipt.result ? { ...receipt, result, stage: "not-executed" } : null);
  }

  async settle(key: string, digest: string, result: McpToolResult, stage: "settled" | "not-executed" = "settled", recovery = false): Promise<McpToolResult> {
    return withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
      const settled = receiptSettlement(receipt, result, stage, recovery);
      if (settled.receipt !== receipt) {
        delete state.readReceipts[key];
        state.mutationReceipts[key] = settled.receipt;
        writeReceiptFile(this.filePath, state);
      }
      return settled.result;
    });
  }

}

type StoredSqliteReceipt = {
  digest: string;
  result_json: string | null;
  recovery_result_json: string | null;
  claimed_at: number;
  binding_json: string | null;
  stage: string | null;
};

export interface SqliteMcpReceiptStoreOptions {
  legacyFilePath?: string;
  readReceiptCountCap?: number;
  readReceiptByteCap?: number;
  boundedPendingTtlMs?: number;
  now?: () => number;
}

/**
 * Keyed durable receipts for the production MCP server.
 *
 * One row carries one idempotency claim. Reads therefore touch one indexed row;
 * durable mutations survive restarts without sharing a retention budget with
 * large read responses. The legacy JSON import is validated by the same parser
 * as the legacy adapter and committed atomically with its import marker.
 */
export class SqliteMcpReceiptStore implements McpRecoveryReceiptStore {
  private readonly db: BunDatabase;
  private readonly readReceiptCountCap: number;
  private readonly readReceiptByteCap: number;
  private readonly boundedPendingTtlMs: number;
  private readonly now: () => number;

  constructor(readonly filename: string, options: SqliteMcpReceiptStoreOptions = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("SQLite MCP receipts require the Bun runtime");
    /* Bound to the file at its name: a receipt store the activation fallback
       replaced is reopened (with its schema), never written through the moved
       handle. The journal mode cannot change inside a transaction, so these
       pragmas run before the schema transaction. */
    this.db = openCurrentDatabase(filename, () => {
      const db = new sqlite.Database(filename, { create: true, strict: true });
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA journal_size_limit = 67108864; PRAGMA auto_vacuum = INCREMENTAL;");
      return db;
    }, { reopened: () => this.initializeSchema() });
    this.readReceiptCountCap = Math.max(1, Math.floor(options.readReceiptCountCap ?? FILE_RECEIPT_CAP));
    this.readReceiptByteCap = Math.max(1, Math.floor(options.readReceiptByteCap ?? SQLITE_READ_RECEIPT_BYTE_CAP));
    this.boundedPendingTtlMs = Math.max(1, Math.floor(options.boundedPendingTtlMs ?? SQLITE_BOUNDED_PENDING_TTL_MS));
    this.now = options.now ?? Date.now;
    this.initializeSchema();
    this.importLegacyFile(options.legacyFilePath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.pruneBoundedReceipts(this.now());
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
    this.secureFiles();
  }

  claim(key: string, digest: string, retention: ReceiptRetention, binding?: McpRequestBinding): ReceiptClaim {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      this.pruneBoundedReceipts(now);
      const receipt = this.selectRow(key);
      if (receipt) {
        this.db.exec("COMMIT");
        const record = this.recordOfRow(key, receipt);
        if (receipt.digest !== digest) return { kind: "conflict", record };
        if (receipt.result_json === null) {
          return { kind: "pending", unfinishedAgeMs: Math.max(0, now - receipt.claimed_at), record };
        }
        return { kind: "replay", result: record.result!, record };
      }
      const bindingJson = binding ? JSON.stringify(binding) : null;
      const storageBytes = this.storageBytes(key, digest, null, bindingJson);
      this.db.query<unknown, [string, string, ReceiptRetention, number, number, string | null, string | null]>(`
        INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at, binding_json, stage)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(key, digest, retention, storageBytes, now, bindingJson, binding ? "claimed" : null);
      this.pruneBoundedReceipts(now);
      this.db.exec("COMMIT");
      return { kind: "fresh" };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  complete(key: string, digest: string, result: McpToolResult, retention: ReceiptRetention): void {
    const resultJson = JSON.stringify(result);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db.query<Pick<StoredSqliteReceipt, "digest" | "binding_json"> & { retention: ReceiptRetention }, [string]>(`
        SELECT digest, retention, binding_json
        FROM mcp_receipts
        WHERE receipt_key = ?
      `).get(key);
      if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
      const effectiveRetention = receipt.retention === "durable" ? "durable" : retention;
      const storageBytes = this.storageBytes(key, digest, resultJson, receipt.binding_json);
      this.db.query<unknown, [ReceiptRetention, string, number, string]>(`
        UPDATE mcp_receipts
        SET retention = ?, result_json = ?, storage_bytes = ?, stage = 'settled'
        WHERE receipt_key = ?
      `).run(effectiveRetention, resultJson, storageBytes, key);
      this.pruneBoundedReceipts(this.now());
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  release(key: string, digest: string, unadmittedBinding?: McpRequestBinding): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db.query<Pick<StoredSqliteReceipt, "digest" | "result_json" | "recovery_result_json" | "stage" | "binding_json">, [string]>(`
        SELECT digest, result_json, recovery_result_json, stage, binding_json
        FROM mcp_receipts
        WHERE receipt_key = ?
      `).get(key);
      const releasable = Boolean(receipt) && receipt!.digest === digest
        && receipt!.result_json === null && receipt!.recovery_result_json === null
        && (receipt!.stage !== "dispatching" || (!!unadmittedBinding && receipt!.binding_json === JSON.stringify(unadmittedBinding)));
      if (releasable) this.db.query<unknown, [string]>("DELETE FROM mcp_receipts WHERE receipt_key = ?").run(key);
      this.db.exec("COMMIT");
      return releasable;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  lookup(key: string): McpReceiptRecord | null {
    const receipt = this.selectRow(key);
    return receipt ? this.recordOfRow(key, receipt) : null;
  }

  markDispatching(key: string, digest: string): boolean {
    return this.db.query<unknown, [string, string]>(`
      UPDATE mcp_receipts
      SET stage = 'dispatching'
      WHERE receipt_key = ? AND digest = ? AND stage = 'claimed' AND result_json IS NULL
    `).run(key, digest).changes === 1;
  }

  bindCreatedTarget(key: string, digest: string, binding: McpRequestBinding, identity: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.selectRow(key);
      const record = row ? this.recordOfRow(key, row) : null;
      const next = record?.digest === digest ? withCreatedTarget({
        digest, binding: record.binding ?? undefined, stage: record.stage ?? undefined,
        result: record.result ?? undefined, recoveryResult: record.recoveryResult ?? undefined,
      }, binding, identity) : null;
      if (next) {
        const bindingJson = JSON.stringify(next.binding);
        this.db.query(`UPDATE mcp_receipts SET binding_json = ?, storage_bytes = ? WHERE receipt_key = ?`)
          .run(bindingJson, this.storageBytes(key, digest, null, bindingJson), key);
      }
      this.db.exec("COMMIT");
      return next !== null;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  fenceUndispatched(key: string, digest: string, result: McpToolResult): boolean {
    const resultJson = JSON.stringify(result);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.selectRow(key);
      if (!receipt || receipt.digest !== digest || receipt.stage !== "claimed" || receipt.result_json !== null) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db.query<unknown, [string, number, string]>(`
        UPDATE mcp_receipts
        SET result_json = ?, storage_bytes = ?, stage = 'not-executed', retention = 'durable'
        WHERE receipt_key = ?
      `).run(resultJson, this.storageBytes(key, digest, resultJson, receipt.binding_json), key);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  settle(key: string, digest: string, result: McpToolResult, stage: "settled" | "not-executed" = "settled", recovery = false): McpToolResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.selectRow(key);
      if (!row || row.digest !== digest) throw new Error("MCP receipt ownership changed");
      const record = this.recordOfRow(key, row);
      const receipt: Receipt = {
        digest, ...(record.result ? { result: record.result } : {}),
        ...(record.recoveryResult ? { recoveryResult: record.recoveryResult } : {}),
        ...(record.stage ? { stage: record.stage } : {}),
      };
      const settled = receiptSettlement(receipt, result, stage, recovery);
      if (settled.receipt !== receipt) {
        const resultJson = settled.receipt.result ? JSON.stringify(settled.receipt.result) : null;
        const recoveryJson = settled.receipt.recoveryResult ? JSON.stringify(settled.receipt.recoveryResult) : null;
        this.db.query<unknown, [string | null, string | null, number, string | null, string]>(`
          UPDATE mcp_receipts
          SET result_json = ?, recovery_result_json = ?, storage_bytes = ?, stage = ?, retention = 'durable'
          WHERE receipt_key = ?
        `).run(resultJson, recoveryJson,
          this.storageBytes(key, digest, resultJson, row.binding_json, recoveryJson), settled.receipt.stage ?? null, key);
      }
      this.db.exec("COMMIT");
      return settled.result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private selectRow(key: string): StoredSqliteReceipt | null {
    return this.db.query<StoredSqliteReceipt, [string]>(`
      SELECT digest, result_json, recovery_result_json, claimed_at, binding_json, stage
      FROM mcp_receipts
      WHERE receipt_key = ?
    `).get(key);
  }

  private recordOfRow(key: string, receipt: StoredSqliteReceipt): McpReceiptRecord {
    const parts = receiptKeyParts(key);
    let binding: McpRequestBinding | null = null;
    if (receipt.binding_json !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(receipt.binding_json);
      } catch (error) {
        throw new Error("invalid MCP receipt database binding JSON", { cause: error });
      }
      if (!validRequestBinding(parsed, parts?.toolName, parts?.requestId)) throw new Error("invalid MCP receipt database binding");
      binding = parsed;
    }
    const recoveryResult = receipt.recovery_result_json === null ? null : this.parseResult(key, receipt.recovery_result_json);
    if (recoveryResult && !terminalReceiptResult(recoveryResult)) throw new Error("invalid MCP terminal recovery result");
    return {
      digest: receipt.digest,
      ...(recoveryResult ? { recoveryResult } : {}),
      result: receipt.result_json === null ? null : this.parseResult(key, receipt.result_json),
      binding,
      stage: isDispatchStage(receipt.stage) ? receipt.stage : receipt.result_json === null ? null : "settled",
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Creates the tables and adds every column a database from an earlier
   * schema lacks, in ONE write transaction. Several MCP processes start cold
   * against the same database at once; the write lock makes one of them
   * inspect and migrate while the others wait on `busy_timeout` and then find
   * the columns already there. Two processes that both inspected first would
   * both ALTER, and the second would throw "duplicate column name".
   */
  private initializeSchema(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_receipt_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_receipts (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          receipt_key TEXT NOT NULL UNIQUE,
          digest TEXT NOT NULL,
          retention TEXT NOT NULL CHECK(retention IN ('bounded', 'durable')),
          result_json TEXT,
          storage_bytes INTEGER NOT NULL,
          claimed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mcp_receipts_retention_sequence
        ON mcp_receipts(retention, sequence);
      `);
      /* #1490: the bound identity and dispatch stage of a recoverable mutation.
         Added in place so an existing database keeps every row it holds; rows
         from before carry NULL in both and are read as legacy. */
      const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(mcp_receipts)").all().map((column) => column.name));
      if (!columns.has("binding_json")) this.db.exec("ALTER TABLE mcp_receipts ADD COLUMN binding_json TEXT");
      if (!columns.has("stage")) this.db.exec("ALTER TABLE mcp_receipts ADD COLUMN stage TEXT");
      if (!columns.has("recovery_result_json")) this.db.exec("ALTER TABLE mcp_receipts ADD COLUMN recovery_result_json TEXT");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private importLegacyFile(legacyFilePath: string | undefined): void {
    if (!legacyFilePath || this.meta("legacy_import_v2") === "complete") return;
    let state: ReceiptFile;
    try {
      state = readReceiptFile(legacyFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!fs.existsSync(legacyFilePath)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.query<unknown, [string, string, ReceiptRetention, string | null, number, number, string | null, string | null, string | null]>(`
        INSERT OR IGNORE INTO mcp_receipts(
          receipt_key, digest, retention, result_json, storage_bytes, claimed_at, binding_json, stage, recovery_result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let claimedAt = this.now() - Object.keys(state.readReceipts).length - Object.keys(state.mutationReceipts).length;
      const importCollection = (receipts: Record<string, Receipt>, retention: ReceiptRetention) => {
        for (const [key, receipt] of Object.entries(receipts)) {
          const resultJson = receipt.result === undefined ? null : JSON.stringify(receipt.result);
          const bindingJson = receipt.binding === undefined ? null : JSON.stringify(receipt.binding);
          const recoveryJson = receipt.recoveryResult === undefined ? null : JSON.stringify(receipt.recoveryResult);
          insert.run(
            key, receipt.digest, retention, resultJson,
            this.storageBytes(key, receipt.digest, resultJson, bindingJson, recoveryJson), claimedAt, bindingJson, receipt.stage ?? null, recoveryJson,
          );
          claimedAt += 1;
        }
      };
      importCollection(state.mutationReceipts, "durable");
      importCollection(state.readReceipts, "bounded");
      this.pruneBoundedReceipts(this.now());
      this.db.query<unknown, [string, string]>(`
        INSERT INTO mcp_receipt_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run("legacy_import_v2", "complete");
      this.db.exec("COMMIT");
      /* The legacy payload can be much larger than the retained read budget.
         Compact once after its one-time import so deleted response pages never
         become the new long-lived database baseline. */
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private pruneBoundedReceipts(now: number): void {
    /* Bounded reads have a lease longer than the SDK's 30-second call budget.
       A crash cannot strand their claims forever; after the lease, a restart or
       any later receipt transaction removes them before completed replay rows
       are considered for count/byte retention. Durable mutation claims never
       enter this expiry path. */
    this.db.query<unknown, [number]>(`
      DELETE FROM mcp_receipts
      WHERE retention = 'bounded'
        AND result_json IS NULL
        AND claimed_at <= ?
    `).run(now - this.boundedPendingTtlMs);
    this.db.query<unknown, [number]>(`
      DELETE FROM mcp_receipts
      WHERE sequence IN (
        SELECT sequence
        FROM mcp_receipts
        WHERE retention = 'bounded' AND result_json IS NOT NULL
        ORDER BY sequence ASC
        LIMIT MAX(0, (
          SELECT COUNT(*) - ? FROM mcp_receipts WHERE retention = 'bounded'
        ))
      )
    `).run(this.readReceiptCountCap);
    const aggregate = this.db.query<{ storage_bytes: number }, []>(`
      SELECT COALESCE(SUM(storage_bytes), 0) AS storage_bytes
      FROM mcp_receipts
      WHERE retention = 'bounded'
    `).get()?.storage_bytes ?? 0;
    let excessBytes = aggregate - this.readReceiptByteCap;
    if (excessBytes <= 0) return;
    const completed = this.db.query<{ sequence: number; storage_bytes: number }, []>(`
      SELECT sequence, storage_bytes
      FROM mcp_receipts
      WHERE retention = 'bounded' AND result_json IS NOT NULL
      ORDER BY sequence ASC
    `).all();
    const expired: number[] = [];
    for (const receipt of completed) {
      if (excessBytes <= 0) break;
      expired.push(receipt.sequence);
      excessBytes -= receipt.storage_bytes;
    }
    const remove = this.db.query<unknown, [number]>("DELETE FROM mcp_receipts WHERE sequence = ?");
    for (const sequence of expired) remove.run(sequence);
  }

  private parseResult(key: string, serialized: string): McpToolResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new Error("invalid MCP receipt database result JSON", { cause: error });
    }
    const parts = receiptKeyParts(key);
    if (!parts || !validReceiptResult(parsed, parts.toolName, parts.requestId)) {
      throw new Error("invalid MCP receipt database result");
    }
    return parsed;
  }

  private storageBytes(key: string, digest: string, resultJson: string | null, bindingJson: string | null = null, recoveryJson: string | null = null): number {
    return Buffer.byteLength(key)
      + Buffer.byteLength(digest)
      + (resultJson === null ? 0 : Buffer.byteLength(resultJson))
      + (bindingJson === null ? 0 : Buffer.byteLength(bindingJson))
      + (recoveryJson === null ? 0 : Buffer.byteLength(recoveryJson));
  }

  private meta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM mcp_receipt_meta WHERE key = ?").get(key)?.value ?? null;
  }

  private secureFiles(): void {
    for (const target of [this.filename, `${this.filename}-wal`, `${this.filename}-shm`]) {
      try {
        fs.chmodSync(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

export function requestDigest(toolName: McpToolName, args: McpToolArgs): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable({ toolName, args }))).digest("hex");
}

function clientRequestId(args: McpToolArgs): string | null {
  return typeof args.clientRequestId === "string" && args.clientRequestId.trim() ? args.clientRequestId.trim() : null;
}

function failure(
  toolName: string,
  requestId: string | null,
  code: string,
  error: string,
  retryable: boolean,
  replayed = false,
  details?: McpToolPayload,
): McpToolFailure {
  return { ok: false, toolName, clientRequestId: requestId, replayed, error, code, retryable, ...(details ? { details } : {}) };
}

export interface McpToolService {
  callTool(toolName: string, args: McpToolArgs, context?: McpToolCallContext): Promise<McpToolResult>;
}

type McpTimingOutcome = "success" | "failure" | "replay" | "conflict" | "pending" | "deadline" | "cancelled";
type McpTimingPhase = "caller" | "http" | "claim" | "binding" | "completion" | "serialization" | "serviceTotal" | "replay";

interface McpToolTimingSample {
  toolName: McpToolName;
  outcome: McpTimingOutcome;
  phases: Partial<Record<McpTimingPhase, number>>;
  resultSizeBytes?: number;
  deadlineBudgetMs?: number;
  unfinishedAgeMs?: number;
}

export interface McpAggregateMeasure {
  samples: number;
  total: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface McpToolTimingSummary {
  toolName: McpToolName;
  calls: number;
  outcomes: Record<McpTimingOutcome, number>;
  phases: Record<McpTimingPhase, McpAggregateMeasure>;
  resultSizeBytes: McpAggregateMeasure;
  deadline: {
    callsWithDeadline: number;
    exceeded: number;
    budgetMs: McpAggregateMeasure;
  };
  cancellation: { cancelled: number };
  unfinishedAgeMs: McpAggregateMeasure;
}

const TIMING_SAMPLE_CAP = 2_048;

class AggregateMeasure {
  private readonly recent: number[] = [];
  private count = 0;
  private total = 0;
  private maximum = 0;

  add(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.total += value;
    this.maximum = Math.max(this.maximum, value);
    if (this.recent.length < TIMING_SAMPLE_CAP) this.recent.push(value);
    else this.recent[(this.count - 1) % TIMING_SAMPLE_CAP] = value;
  }

  snapshot(): McpAggregateMeasure {
    const values = this.recent.toSorted((left, right) => left - right);
    const percentile = (quantile: number) => values.length
      ? values[Math.max(0, Math.ceil(values.length * quantile) - 1)]!
      : 0;
    return {
      samples: this.count,
      total: this.total,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: this.maximum,
    };
  }
}

type MutableToolTiming = {
  calls: number;
  outcomes: Record<McpTimingOutcome, number>;
  phases: Record<McpTimingPhase, AggregateMeasure>;
  resultSizeBytes: AggregateMeasure;
  deadlineBudgetMs: AggregateMeasure;
  unfinishedAgeMs: AggregateMeasure;
};

const MCP_TIMING_OUTCOMES: McpTimingOutcome[] = [
  "success", "failure", "replay", "conflict", "pending", "deadline", "cancelled",
];
const MCP_TIMING_PHASES: McpTimingPhase[] = [
  "caller", "http", "claim", "binding", "completion", "serialization", "serviceTotal", "replay",
];

function mutableToolTiming(): MutableToolTiming {
  return {
    calls: 0,
    outcomes: Object.fromEntries(MCP_TIMING_OUTCOMES.map((outcome) => [outcome, 0])) as Record<McpTimingOutcome, number>,
    phases: Object.fromEntries(MCP_TIMING_PHASES.map((phase) => [phase, new AggregateMeasure()])) as Record<McpTimingPhase, AggregateMeasure>,
    resultSizeBytes: new AggregateMeasure(),
    deadlineBudgetMs: new AggregateMeasure(),
    unfinishedAgeMs: new AggregateMeasure(),
  };
}

/** Numeric-only per-tool aggregates. No request or response values enter this module. */
export class McpToolTimingAggregate {
  private readonly tools = new Map<McpToolName, MutableToolTiming>(
    MCP_TOOL_NAMES.map((toolName) => [toolName, mutableToolTiming()]),
  );

  observe(sample: McpToolTimingSample): void {
    const timing = this.tools.get(sample.toolName)!;
    timing.calls += 1;
    timing.outcomes[sample.outcome] += 1;
    for (const phase of MCP_TIMING_PHASES) timing.phases[phase].add(sample.phases[phase]);
    timing.resultSizeBytes.add(sample.resultSizeBytes);
    timing.deadlineBudgetMs.add(sample.deadlineBudgetMs);
    timing.unfinishedAgeMs.add(sample.unfinishedAgeMs);
  }

  snapshot(): McpToolTimingSummary[] {
    return MCP_TOOL_NAMES.map((toolName) => {
      const timing = this.tools.get(toolName)!;
      return {
        toolName,
        calls: timing.calls,
        outcomes: { ...timing.outcomes },
        phases: Object.fromEntries(MCP_TIMING_PHASES.map((phase) => [phase, timing.phases[phase].snapshot()])) as Record<McpTimingPhase, McpAggregateMeasure>,
        resultSizeBytes: timing.resultSizeBytes.snapshot(),
        deadline: {
          callsWithDeadline: timing.deadlineBudgetMs.snapshot().samples,
          exceeded: timing.outcomes.deadline,
          budgetMs: timing.deadlineBudgetMs.snapshot(),
        },
        cancellation: { cancelled: timing.outcomes.cancelled },
        unfinishedAgeMs: timing.unfinishedAgeMs.snapshot(),
      };
    });
  }
}

const productionMcpToolTimings = new McpToolTimingAggregate();

export function mcpToolTimingSnapshot(): McpToolTimingSummary[] {
  return productionMcpToolTimings.snapshot();
}

export interface McpToolServiceOptions {
  timings?: McpToolTimingAggregate;
  /** #1490: the tools whose claim is bound to the caller before dispatch and
      recoverable under the original clientRequestId afterwards. Requires a
      store that {@link supportsMcpRecovery}. */
  recovery?: Partial<Record<McpToolName, McpRecoverableTool>>;
}

/** The closed outcome vocabulary of original-key recovery (#1490). */
export type McpRecoveryOutcome = "accepted" | "in-flight" | "settled" | "not-executed" | "unknown";

/** What a caller may do next, stated on the answer rather than implied by
    `retryable`. `original-key-lookup` is the ONLY permitted action on an
    unknown or open outcome: never a new key, never an automatic resend. */
export type McpRecoveryNextAction = "original-key-lookup" | "follow-disposition" | "new-request-permitted";

export interface McpRecoveryEvidence {
  outcome: McpRecoveryOutcome;
  /** Provenance of this answer: which durable record or journal supplied it,
      or `none` when nothing was found. */
  evidence: string;
  reason: string | null;
  /** Every actual identifier the evidence carries (operationId, launchId,
      conversationId, transcriptPath, deliveryId). Empty when nothing was found. */
  ids: Record<string, string>;
  /** Terminal facts for a settled outcome: the actual state, resend guidance,
      duplicate risk, or the recorded error. */
  facts?: McpToolPayload;
  /** For a legacy record (claimed before bindings existed): whether existing
      durable evidence establishes that the CURRENT caller owns it. Anything
      but `established` discloses nothing. */
  ownership?: "established" | "unknown";
}

export interface McpRecoverableTool {
  /** Resolve the server-derived caller and target for fresh admission. Runs
      before receipt access unless bindForRecovery authenticates that access first. */
  bind(args: McpToolArgs): McpRequestBindingInput | Promise<McpRequestBindingInput>;
  /** Authenticate recovery without resolving a mutable target name. Existing
      receipts supply their own target; absent receipts still run bind before admission. */
  bindForRecovery?(args: McpToolArgs): McpRequestBindingInput | Promise<McpRequestBindingInput>;
  /** Read-only: what the downstream durable records say about this binding.
      Must never dispatch, enqueue, retry, withdraw or spawn. */
  recover(binding: McpRequestBinding, options: { legacy: boolean; context?: McpToolCallContext; args?: McpToolArgs }): Promise<McpRecoveryEvidence>;
}

/**
 * Thrown by a binding whose one dispatch may have reached the server without
 * an answer coming back: a timeout after the request was written, a reset, an
 * unreadable body, a proxy status that says nothing about the upstream. The
 * service reports it as `unknown` and never redispatches.
 */
export class McpDispatchUncertainError extends Error {
  constructor(message: string, readonly details: McpToolPayload = {}) {
    super(message);
    this.name = "McpDispatchUncertainError";
  }
}

/**
 * Thrown by the transport when it can PROVE the request never left this
 * process: the kernel refused the connection, so no byte was written and the
 * server did nothing. The one transport failure that closes an attempt as
 * not-executed.
 */
export class McpDispatchNotExecutedError extends Error {
  /** What the server said when it refused before doing anything, kept on
      the settled answer. */
  readonly details: McpToolPayload;

  constructor(message: string, details: McpToolPayload = {}) {
    super(message);
    this.name = "McpDispatchNotExecutedError";
    this.details = details;
  }
}

/**
 * The server's own answer to the one dispatch: a JSON verdict with a status.
 * Carries every id the verdict named. Distinct from a refusal a binding raises
 * on its own, so the service knows this one came back from the server.
 */
export class McpDispatchVerdictError extends McpToolRefusal {
  constructor(message: string, details: McpToolPayload & { status: number }) {
    super(message, details);
    this.name = "McpDispatchVerdictError";
  }
}

/** A final dispatch was affirmatively refused after an earlier effect was
    confirmed. The binding preserves that effect separately; the composite
    request closes with a refusal and cannot authorize another creation. */
export class McpDispatchSettledRefusalError extends McpToolRefusal {
  constructor(message: string, details: McpToolPayload) {
    super(message, {
      ...details,
      outcome: "settled",
      evidence: "dispatch-refused",
      nextAction: "follow-disposition",
    });
    this.name = "McpDispatchSettledRefusalError";
  }
}

function sameCaller(recorded: McpRequestCaller, current: McpRequestCaller, toolName: McpToolName): boolean {
  return recorded.kind === current.kind
    && recorded.project === current.project
    && (recorded.conversationId === current.conversationId
      || (toolName !== "send_message_to_orchestrator" && recorded.conversationId !== null
        && (current.predecessors ?? []).includes(recorded.conversationId)));
}

function identifiedCaller(caller: McpRequestCaller): boolean {
  return caller.kind === "root" || (caller.kind === "worker" && caller.conversationId !== null);
}

/** The string-valued ids a refusal carried, kept on an uncertain answer. */
function stringIds(details: McpToolPayload): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of ["operationId", "launchId", "conversationId", "deliveryId", "transcriptPath"]) {
    const value = details[name];
    if (typeof value === "string" && value) ids[name] = value;
  }
  return ids;
}

function nextActionFor(outcome: McpRecoveryOutcome): McpRecoveryNextAction {
  if (outcome === "settled") return "follow-disposition";
  if (outcome === "not-executed") return "new-request-permitted";
  return "original-key-lookup";
}

const RECOVERY_NOT_PERMITTED = "this clientRequestId cannot be recovered by this caller";
const CALLER_UNIDENTIFIED = "the caller's identity could not be established, so this mutation is refused before anything is claimed or dispatched";

function recoveryAnswer(
  toolName: McpToolName,
  requestId: string,
  evidence: McpRecoveryEvidence,
  replayed: boolean,
  original?: McpToolResult | null,
): McpToolResult {
  const shared: McpToolPayload = {
    recovered: true,
    outcome: evidence.outcome,
    evidence: evidence.evidence,
    reason: evidence.reason,
    nextAction: nextActionFor(evidence.outcome),
    ...evidence.ids,
    ...(evidence.facts ?? {}),
    ...(original ? { original } : {}),
  };
  if (evidence.outcome === "unknown") {
    return failure(
      toolName,
      requestId,
      "outcome_unknown",
      evidence.reason ?? "the outcome of this request is unknown; look it up again under the same clientRequestId",
      false,
      replayed,
      shared,
    );
  }
  if (evidence.outcome === "not-executed") {
    return failure(
      toolName,
      requestId,
      "not_executed",
      evidence.reason ?? "this request was never dispatched and the attempt is permanently closed",
      true,
      replayed,
      shared,
    );
  }
  return { ...shared, ok: true, toolName, clientRequestId: requestId, replayed };
}

/** Generic board replies cannot expose task-private review history. */
function withoutPrototypeTaskFields<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return seen.get(item);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return item;
    if (Array.isArray(item)) {
      const copy: unknown[] = []; seen.set(item, copy);
      for (const child of item) copy.push(visit(child));
      return copy;
    }
    const record = item as Record<string, unknown>;
    const task = typeof record.id === "string" && typeof record.project === "string" && typeof record.status === "string";
    const copy: Record<string, unknown> = {}; seen.set(item, copy);
    for (const [key, child] of Object.entries(record)) {
      if (task && ["prototypeReviews", "prototypeReviewReplica", "prototypeReview"].includes(key)) continue;
      Object.defineProperty(copy, key, { value: visit(child), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  };
  return visit(value) as T;
}

export function createMcpToolService(
  bindings: McpToolBindings,
  receipts: McpReceiptStore,
  /** #691 §6: the per-identity fence. Absent means "no fence", which is what every
      existing caller of this factory means and gets. */
  policy?: McpToolPolicy,
  options: McpToolServiceOptions = {},
): McpToolService {
  const inFlight = new Map<string, { digest: string; result: Promise<McpToolResult> }>();
  return {
    async callTool(toolName, args, context = {}) {
      if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
        return failure(toolName, clientRequestId(args), "unknown_tool", `Unknown viewer tool: ${toolName}`, false);
      }
      const typedTool = toolName as McpToolName;
      const normalized = normalizeBoundedMcpNumerics(typedTool, args);
      const effectiveArgs = normalized.args;
      if (typedTool === "search_memory" && typeof effectiveArgs.clientRequestId === "string"
        && effectiveArgs.clientRequestId.trim().length > 256) {
        return failure(typedTool, null, "invalid_request", "clientRequestId must be at most 256 characters for search_memory", false);
      }
      const callStartedAt = performance.now();
      const phaseDurations: Partial<Record<McpTimingPhase, number>> = {};
      context = { ...context, recordTiming: (phase, milliseconds) => {
        phaseDurations[phase] = (phaseDurations[phase] ?? 0) + milliseconds;
      } };
      const permit = () => {
        const startedAt = performance.now();
        try { return policy?.permit(typedTool, effectiveArgs); }
        finally { phaseDurations.caller = (phaseDurations.caller ?? 0) + performance.now() - startedAt; }
      };
      const measure = async <T>(phase: McpTimingPhase, run: () => T | Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        try { return await run(); }
        finally { phaseDurations[phase] = (phaseDurations[phase] ?? 0) + performance.now() - startedAt; }
      };
      try {
      const deadlineBudgetMs = context.deadlineAt === undefined
        ? undefined
        : Math.max(0, context.deadlineAt - Date.now());
      const finish = (result: McpToolResult, outcome: McpTimingOutcome, unfinishedAgeMs?: number): McpToolResult => {
        result = withoutPrototypeTaskFields(result);
        const serializationStartedAt = performance.now();
        let resultSizeBytes: number | undefined;
        try {
          resultSizeBytes = Buffer.byteLength(JSON.stringify(result));
        } catch { /* timing must never change a tool outcome */ }
        phaseDurations.serialization = performance.now() - serializationStartedAt;
        phaseDurations.serviceTotal = serializationStartedAt - callStartedAt;
        options.timings?.observe({
          toolName: typedTool,
          outcome,
          phases: phaseDurations,
          resultSizeBytes,
          deadlineBudgetMs,
          unfinishedAgeMs,
        });
        return result;
      };
      const retention: ReceiptRetention = MUTATING_MCP_TOOL_NAMES.has(typedTool) ? "durable" : "bounded";
      const requestId = clientRequestId(effectiveArgs);
      // Omitted keys on pure reads mean a fresh observation, without a receipt.
      // Explicit keys continue through the unchanged claim/replay path below.
      if (effectiveArgs.clientRequestId === undefined && OPTIONAL_READ_KEY_TOOLS.has(typedTool)) {
        const verdict = permit();
        if (verdict && !verdict.allowed) return finish(failure(typedTool, null, verdict.code, verdict.error, false), "failure");
        try {
          await measure("caller", async () => bindings[typedTool].authorizeReceipt?.(effectiveArgs));
          if (context.signal?.aborted) throw context.signal.reason;
          const payload = await measure("binding", () => bindings[typedTool](effectiveArgs, context));
          if (context.signal?.aborted) throw context.signal.reason;
          return finish({ ...payload, ...(normalized.clamped ? { clamped: normalized.clamped } : {}),
            ok: true, toolName: typedTool, clientRequestId: null, replayed: false }, "success");
        } catch (error) {
          const reason = context.signal?.aborted ? context.signal.reason : error;
          const outcome = reason instanceof DeadlineExceededError ? "deadline" : context.signal?.aborted ? "cancelled" : "failure";
          return finish(failure(typedTool, null,
            error instanceof McpToolRefusal && typeof error.details.code === "string" ? error.details.code : "tool_failed",
            reason instanceof Error ? reason.message : String(reason), true, false,
            error instanceof McpToolRefusal ? error.details : undefined), outcome);
        }
      }
      if (!requestId) return finish(failure(toolName, null, "invalid_request", "clientRequestId is required", false), "failure");
      /* Agent decisions own an atomic receipt in the flow row. Always enter the
         binding so caller authority is checked before replay, including after
         restart; an MCP-cache hit must never disclose another owner's receipt. */
      if (typedTool === "flow_action" && effectiveArgs.action === "agent-decision") {
        const verdict = permit();
        if (verdict && !verdict.allowed) return finish(failure(typedTool, requestId, verdict.code, verdict.error, false), "failure");
        try {
          const payload = await bindings[typedTool](effectiveArgs, context);
          return finish({ ...payload, ok: true, toolName: typedTool, clientRequestId: requestId, replayed: payload.replayed === true }, "success");
        } catch (error) {
          return finish(failure(typedTool, requestId, "tool_failed", error instanceof Error ? error.message : String(error), false, false,
            { outcome: "unknown", nextAction: "original-key-lookup" }), "failure");
        }
      }
      const recoverable = options.recovery?.[typedTool] ?? null;
      const recoveryStore = recoverable && supportsMcpRecovery(receipts) ? receipts : null;
      if (recoverable && !recoveryStore) throw new Error(`MCP receipt store cannot recover ${typedTool}`);

      /* Refused before the receipt is claimed, on purpose. A refusal is a
         property of who is calling, not of the operation, so it must not burn the
         clientRequestId — the same call becomes legitimate the moment the operator
         grants the tool, and a spent receipt would answer it with a stale no. */
      const verdict = permit();
      if (verdict && !verdict.allowed) {
        return finish(failure(typedTool, requestId, verdict.code, verdict.error, false), "failure");
      }
      try {
        const authorize = bindings[typedTool].authorizeReceipt;
        if (authorize) await authorize(effectiveArgs);
      } catch (error) {
        return finish(failure(typedTool, requestId,
          error instanceof McpToolRefusal && typeof error.details.code === "string" ? error.details.code : "tool_failed",
          error instanceof Error ? error.message : String(error),
          error instanceof McpToolRefusal && error.details.retryable === true, false,
          error instanceof McpToolRefusal ? error.details : undefined), "failure");
      }
      let scope: string | null;
      try {
        scope = await measure("caller", async () => await bindings[typedTool].receiptScope?.(effectiveArgs, context) ?? null);
      } catch (error) {
        // Nothing is claimed yet, so the same key may be tried again as it is.
        return finish(failure(typedTool, requestId, "tool_failed", error instanceof Error ? error.message : String(error), true), "failure");
      }

      /* #1490: `recoveryOnly` decides only whether an absent claim may start
         work, so it is excluded from the digest — the same logical call with
         and without it is one call. */
      const recoveryOnly = recoverable !== null && effectiveArgs.recoveryOnly === true;
      const digestArgs: McpToolArgs = recoverable
        ? Object.fromEntries(Object.entries(effectiveArgs).filter(([name]) => name !== "recoveryOnly"))
        : effectiveArgs;
      const digest = requestDigest(typedTool, digestArgs);
      const key = receiptKey(typedTool, requestId, scope);
      /* A recoverable mutation never joins an in-process duplicate: who is
         calling is decided first, and every later call under the key — in
         this process or another — is answered from the durable record. */
      const active = recoverable ? undefined : inFlight.get(key);
      if (active) {
        if (active.digest !== digest) {
          return finish(failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true), "conflict");
        }
        const replayStartedAt = performance.now();
        const replayed = { ...await active.result, replayed: true };
        phaseDurations.replay = performance.now() - replayStartedAt;
        return finish(replayed, "replay");
      }
      let outcome: McpTimingOutcome = "failure";
      let unfinishedAgeMs: number | undefined;
      const recoverableCall = async (tool: McpRecoverableTool, store: McpRecoveryReceiptStore): Promise<McpToolResult> => {
        /* Authority first, before the store is read: who is calling decides
           what may be disclosed, so it cannot be learned from the answer. A
           refusal here burns nothing — no claim exists yet. */
        let bound: McpRequestBindingInput;
        const callerStartedAt = performance.now();
        try {
          bound = await (tool.bindForRecovery ?? tool.bind)(digestArgs);
        } catch (error) {
          outcome = "failure";
          return failure(
            typedTool,
            requestId,
            error instanceof McpToolRefusal && typeof error.details.code === "string" ? error.details.code : "tool_failed",
            error instanceof Error ? error.message : String(error),
            false,
            false,
            error instanceof McpToolRefusal ? error.details : undefined,
          );
        } finally {
          phaseDurations.caller = (phaseDurations.caller ?? 0) + performance.now() - callerStartedAt;
        }
        let binding: McpRequestBinding = {
          version: 1,
          toolName: typedTool,
          clientRequestId: requestId,
          ...bound,
          owner: { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) },
          claimedAt: new Date().toISOString(),
        };
        /* No identity, no claim: a mutation nobody could ever recover is not
           dispatched, and the refusal is the same whether or not the key
           exists, so it discloses nothing. */
        if (!identifiedCaller(binding.caller)) {
          outcome = "failure";
          return failure(typedTool, requestId, "caller_unidentified", CALLER_UNIDENTIFIED, false, false);
        }
        const notPermitted = () => {
          outcome = "failure";
          return failure(typedTool, requestId, "recovery_not_permitted", RECOVERY_NOT_PERMITTED, false, true);
        };
        /* A receipt row that cannot be read is exactly "unknown": nothing is
           claimed, dispatched or disclosed on its behalf, and the same key
           answers again once the store can be read. Never a thrown error —
           that would leave the caller with no outcome at all. */
        const unreadableReceipt = (cause: unknown, replayed: boolean): McpToolResult => {
          outcome = "failure";
          const message = cause instanceof Error ? cause.message : String(cause);
          return recoveryAnswer(typedTool, requestId, {
            outcome: "unknown",
            evidence: "mcp-receipt-unreadable",
            reason: `the receipt record for this clientRequestId could not be read (${message}); nothing was claimed, dispatched or disclosed, and its fate stays unknown until the record can be read again under the same key`,
            ids: {},
          }, replayed);
        };
        /* Downstream evidence that has failed to be read is unknown too, with
           the cause on the answer, and never a thrown error. */
        const readEvidence = (bound: McpRequestBinding, legacy: boolean): Promise<McpRecoveryEvidence> =>
          tool.recover(bound, { legacy, context, args: digestArgs }).catch((cause: unknown): McpRecoveryEvidence => ({
            outcome: "unknown",
            evidence: "none",
            reason: cause instanceof Error ? cause.message : String(cause),
            ids: {},
          }));
        const terminalResult = terminalReceiptResult;
        const readableStoredResult = async (): Promise<McpToolResult | null> => {
          const current = await store.lookup(key);
          if (!current?.result || current.digest !== digest || !current.binding
            || !sameCaller(current.binding.caller, binding.caller, typedTool)) return null;
          return current.recoveryResult ?? current.result;
        };
        /* Terminal downstream evidence becomes the row's answer, written
           conditionally: the first terminal answer wins, so a dispatch error
           that arrives after the work was proven delivered — or a late
           original response — can never replace it. Open outcomes are never
           written: the row stays open for the original response. An ordinary
           acceptance keeps its replay while terminal recovery is saved beside it. */
        const answerFromEvidence = async (
          evidence: McpRecoveryEvidence,
          replayed: boolean,
          original?: McpToolResult | null,
        ): Promise<McpToolResult> => {
          // Read again after the evidence lookup: another process may have
          // settled the operation while this read was pending or unavailable.
          let current: McpReceiptRecord | null;
          try {
            current = await store.lookup(key);
          } catch (cause) {
            return unreadableReceipt(cause, replayed);
          }
          if (current?.binding && !sameCaller(current.binding.caller, binding.caller, typedTool)) return notPermitted();
          if (current && current.digest !== digest) return notPermitted();
          // Contradictory ownership never licenses disclosure of cached IDs.
          if (evidence.ownership === "unknown") return recoveryAnswer(typedTool, requestId, evidence, replayed);
          const previous = current?.recoveryResult ?? current?.result ?? original;
          if (terminalResult(previous)) return {
            ...previous,
            ...(recoveryOnly && previous.ok ? {
              recovered: true, outcome: "settled", evidence: "mcp-receipt", nextAction: "follow-disposition",
              ...(!previous.recovered ? {
                original: previous,
                state: typedTool === "spawn_agent" ? "completed" : "delivered",
                ...(["send_message", "send_message_to_orchestrator"].includes(typedTool) ? { resend: "not-needed", duplicateRisk: false } : {}),
              } : {}),
            } : {}),
            replayed: true,
          };
          const answer = recoveryAnswer(typedTool, requestId, evidence, replayed, previous);
          if (evidence.outcome !== "settled" && evidence.outcome !== "not-executed") return answer;
          let stored: McpToolResult;
          try {
            stored = await store.settle(
              key,
              digest,
              answer,
              evidence.outcome === "not-executed" ? "not-executed" : "settled",
              true,
            );
          } catch {
            // A failed write can race a successful terminal recovery.
            try {
              const current = await readableStoredResult();
              if (terminalResult(current)) return { ...current, replayed: true };
            } catch { /* The independently read evidence remains available. */ }
            return answer;
          }
          return stored === answer ? answer : { ...stored, replayed: true };
        };
        const recoverRecord = async (record: McpReceiptRecord): Promise<McpToolResult> => {
          const recorded = record.binding;
          if (!recorded) {
            /* A legacy row: claimed before bindings existed, so ownership has
               to come from the downstream record itself or not at all. The
               row stays intact either way; what it holds is disclosed only to
               a caller the durable evidence names as its owner. */
            const evidence = await tool.recover(binding, { legacy: true, context, args: digestArgs });
            if (evidence.ownership !== "established") {
              outcome = "failure";
              return recoveryAnswer(typedTool, requestId, {
                outcome: "unknown",
                evidence: "legacy-receipt-unbound",
                reason: "this clientRequestId was claimed before caller bindings existed and no durable evidence establishes its owner; its fate is unknown",
                ids: {},
              }, true);
            }
            if (record.digest !== digest) {
              outcome = "conflict";
              return failure(typedTool, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
            }
            if (record.result && !recoveryOnly) {
              outcome = "replay";
              return { ...record.result, replayed: true };
            }
            outcome = evidence.outcome === "unknown" ? "failure" : "replay";
            return recoveryAnswer(typedTool, requestId, evidence, true, record.result);
          }
          if (!sameCaller(recorded.caller, binding.caller, typedTool)) return notPermitted();
          if (record.digest !== digest) {
            outcome = "conflict";
            return failure(typedTool, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
          }
          // Older relay bindings omitted gateway authorship. Their cached
          // results may name another author's send and cannot license replay.
          if (typedTool === "send_message_to_orchestrator" && !recorded.sendPayload) return notPermitted();
          if (record.recoveryResult && record.stage === "not-executed") {
            outcome = "replay";
            return { ...record.recoveryResult, replayed: true };
          }
          if (record.result && (!recoveryOnly || record.stage === "not-executed")) {
            outcome = "replay";
            return { ...record.result, replayed: true };
          }
          if (record.stage === "claimed") {
            /* Claimed and never marked dispatching. While its owner lives the
               dispatch may be a moment away; once the owner is gone the row
               can be closed for good, and only THEN does absence prove zero
               effect. Closing it is the permanent pre-dispatch fence: the
               owner's own markDispatching fails against it. */
            const alive = processOwnerAlive({ ...recorded.owner, token: "" });
            if (!alive) {
              const closed = recoveryAnswer(typedTool, requestId, {
                outcome: "not-executed",
                evidence: "mcp-receipt",
                reason: "the MCP process that claimed this request ended before it dispatched anything; the attempt is permanently closed",
                ids: {},
              }, false);
              let fenced: boolean;
              try {
                fenced = await store.fenceUndispatched(key, digest, closed);
              } catch (cause) {
                return unreadableReceipt(cause, true);
              }
              if (fenced) {
                outcome = "failure";
                return { ...closed, replayed: true };
              }
              let current: McpReceiptRecord | null;
              try {
                current = await store.lookup(key);
              } catch (cause) {
                return unreadableReceipt(cause, true);
              }
              if (current) return recoverRecord(current);
            }
            outcome = "failure";
            return recoveryAnswer(typedTool, requestId, {
              outcome: "unknown",
              evidence: "mcp-receipt",
              reason: "the claim is held by a live MCP process that has not reported its dispatch; look it up again under the same clientRequestId",
              ids: {},
            }, true);
          }
          const evidence = await readEvidence(recorded, false);
          outcome = evidence.outcome === "unknown" ? "failure" : "replay";
          return answerFromEvidence(evidence, true, record.result);
        };
        const claimStartedAt = performance.now();
        if (tool.bindForRecovery) {
          let record: McpReceiptRecord | null;
          try {
            record = await store.lookup(key);
          } catch (cause) {
            return unreadableReceipt(cause, false);
          }
          if (record) return recoverRecord(record);
          // An absent lookup is no admission verdict: the original may still
          // arrive. Resolve current names only when this call can admit work.
          if (!recoveryOnly) {
            try {
              const fresh = await tool.bind(digestArgs);
              if (!identifiedCaller(fresh.caller) || !sameCaller(binding.caller, fresh.caller, typedTool)) return notPermitted();
              binding = { ...binding, ...fresh };
            } catch (error) {
              return failure(typedTool, requestId,
                error instanceof McpToolRefusal && typeof error.details.code === "string" ? error.details.code : "tool_failed",
                error instanceof Error ? error.message : String(error), false, false,
                error instanceof McpToolRefusal ? error.details : undefined);
            }
          }
        }
        if (recoveryOnly) {
          let record: McpReceiptRecord | null;
          try {
            record = await store.lookup(key);
          } catch (cause) {
            return unreadableReceipt(cause, false);
          }
          phaseDurations.claim = performance.now() - claimStartedAt;
          if (record) return recoverRecord(record);
          /* Nothing has claimed this key HERE — an observation, never a
             verdict: the original may be a moment from claiming it, in this
             process or another, and a lookup that wrote anything under the
             key would be the claim it promised never to make, cancelling that
             original. Nothing is written, and nothing downstream is read
             either: without a claim there is no durable binding that
             establishes whose work a downstream record under this key would
             be, so an answer built from it could hand one caller another's
             ids. The answer stays unknown while execution remains possible. */
          outcome = "failure";
          return recoveryAnswer(typedTool, requestId, {
            outcome: "unknown",
            evidence: "none",
            reason: "no claim exists for this clientRequestId yet; nothing was claimed, dispatched or read on its behalf, and the original call may still be on its way, so look it up again under the same key",
            ids: {},
          }, false);
        }
        let claim: ReceiptClaim;
        try {
          claim = await store.claim(key, digest, retention, binding);
        } catch (cause) {
          return unreadableReceipt(cause, false);
        }
        phaseDurations.claim = performance.now() - claimStartedAt;
        if (claim.kind !== "fresh") {
          let record = claim.record ?? null;
          if (!record) {
            try {
              record = await store.lookup(key);
            } catch (cause) {
              return unreadableReceipt(cause, true);
            }
          }
          if (record) return recoverRecord(record);
          outcome = "failure";
          return recoveryAnswer(typedTool, requestId, { outcome: "unknown", evidence: "mcp-receipt", reason: "the receipt store could not be read consistently", ids: {} }, true);
        }
        /* The fence before the one dispatch. Failing here means another
           process closed the attempt between the claim and now. */
        let dispatching: boolean;
        try {
          dispatching = await store.markDispatching(key, digest);
        } catch (cause) {
          /* The claim is this process's and stays `claimed`: nothing was
             dispatched, and once this process is gone the row closes as
             not-executed. */
          return unreadableReceipt(cause, false);
        }
        if (!dispatching) {
          let current: McpReceiptRecord | null;
          try {
            current = await store.lookup(key);
          } catch (cause) {
            return unreadableReceipt(cause, true);
          }
          if (current) return recoverRecord(current);
          outcome = "failure";
          return recoveryAnswer(typedTool, requestId, { outcome: "unknown", evidence: "mcp-receipt", reason: "the claim disappeared before dispatch", ids: {} }, true);
        }
        const bindingStartedAt = performance.now();
        let settled: McpToolResult;
        const dispatch: McpDispatchTracker = { attempted: false };
        try {
          const payload = await bindings[typedTool](effectiveArgs, { ...context, binding, dispatch,
            bindCreatedTarget: async (identity) => {
              if (!store.bindCreatedTarget || !await store.bindCreatedTarget(key, digest, binding, identity)) {
                throw new McpDispatchUncertainError("the created orchestrator recipient could not be durably bound; no message was dispatched");
              }
              binding.target = { ...binding.target, identity };
            },
          });
          settled = {
            ...payload,
            ...(normalized.clamped ? { clamped: normalized.clamped } : {}),
            ok: true,
            toolName: typedTool,
            clientRequestId: requestId,
            replayed: false,
          };
          outcome = "success";
        } catch (error) {
          phaseDurations.binding = performance.now() - bindingStartedAt;
          if (error instanceof McpUnadmittedRefusal && receipts.release) {
            await receipts.release(key, digest, binding);
            outcome = "failure";
            return failure(typedTool, requestId, "tool_failed", error.message, true, false, error.details);
          }
          if (error instanceof McpDispatchUncertainError) {
            /* The request may be on the server. Nothing is written: the row
               stays `dispatching`, which is exactly "unknown" — and every later
               call under this key reads the downstream evidence rather than
               replaying a guess. The evidence is read once now so an answer
               the server already recorded is not withheld. */
            outcome = context.signal?.aborted ? "cancelled" : "failure";
            const evidence = await readEvidence(binding, false);
            const uncertain: McpRecoveryEvidence = evidence.outcome === "unknown"
              ? { ...evidence, reason: `${error.message}; ${evidence.reason ?? "no durable evidence of the request was found yet"}` }
              : evidence;
            return answerFromEvidence(uncertain, false);
          }
          /* Admission identifies work whose outcome still needs evidence.
             Only affirmative pre-dispatch proof closes an attempt. HTTP
             status, error text, and admitted IDs cannot establish termination. */
          outcome = error instanceof DeadlineExceededError ? "deadline" : "failure";
          const refusal = error instanceof McpToolRefusal || error instanceof McpDispatchNotExecutedError ? error.details : {};
          const admitted = typeof refusal.operationId === "string" || typeof refusal.launchId === "string";
          const terminalRefusal = error instanceof McpDispatchSettledRefusalError;
          const proven = terminalRefusal || (!admitted && (
            error instanceof McpDispatchNotExecutedError
            || !dispatch.attempted
          ));
          if (!proven) {
            outcome = context.signal?.aborted ? "cancelled" : "failure";
            const message = error instanceof Error ? error.message : String(error);
            const evidence = await readEvidence(binding, false);
            const uncertain: McpRecoveryEvidence = evidence.outcome === "unknown"
              ? { ...evidence, reason: `${message}; ${evidence.reason ?? "no durable evidence of the request was found yet"}`, ids: evidence.ownership === "unknown" ? {} : { ...stringIds(refusal), ...evidence.ids } }
              : evidence;
            return answerFromEvidence(uncertain, false);
          }
          const details: McpToolPayload = {
            ...refusal,
            outcome: terminalRefusal ? "settled" : "not-executed",
            evidence: "dispatch-refused",
            nextAction: terminalRefusal ? "follow-disposition" : "new-request-permitted",
          };
          settled = failure(
            typedTool,
            requestId,
            terminalRefusal && typeof refusal.code === "string" ? refusal.code : "tool_failed",
            error instanceof Error ? error.message : String(error),
            !terminalRefusal,
            false,
            details,
          );
        }
        phaseDurations.binding = performance.now() - bindingStartedAt;
        const completionStartedAt = performance.now();
        let stored: McpToolResult;
        try {
          stored = await store.settle(
            key,
            digest,
            settled,
            settled.ok || settled.details?.outcome === "settled" ? "settled" : "not-executed",
          );
        } catch {
          /* The answer is real whether or not the row took it: the row stays
             `dispatching`, and every later call under the key reads the
             downstream evidence, which is what this answer was made from. */
          phaseDurations.completion = performance.now() - completionStartedAt;
          try {
            const current = await readableStoredResult();
            if (terminalResult(current)) return { ...current, replayed: true };
          } catch { /* The original response remains independently available. */ }
          return settled;
        }
        phaseDurations.completion = performance.now() - completionStartedAt;
        if (stored !== settled) outcome = "replay";
        return stored === settled ? settled : { ...stored, replayed: true };
      };
      const result = (async (): Promise<McpToolResult> => {
        if (recoverable && recoveryStore) return recoverableCall(recoverable, recoveryStore);
        const prepare = bindings[typedTool].prepareAdmission;
        if (prepare) {
          let existing: McpReceiptRecord | null = null;
          if (supportsMcpRecovery(receipts)) {
            try {
              existing = await measure("replay", () => receipts.lookup(key));
            } catch {
              return recoveryAnswer(typedTool, requestId, {
                outcome: "unknown", evidence: "mcp-receipt", reason: "the receipt store could not be read", ids: {},
              }, false);
            }
          }
          if (!existing) {
            try {
              await measure("caller", () => prepare(effectiveArgs));
            } catch (error) {
              return failure(typedTool, requestId,
                error instanceof McpToolRefusal && typeof error.details.code === "string" ? error.details.code : "tool_failed",
                error instanceof Error ? error.message : String(error), false, false,
                error instanceof McpToolRefusal ? error.details : undefined);
            }
          }
        }
        const claim = await measure("claim", () => receipts.claim(key, digest, retention));
        if (claim.kind === "conflict") {
          outcome = "conflict";
          return failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
        }
        if (claim.kind === "pending" && !interruptedCallIsRecoverable(typedTool, effectiveArgs)) {
          outcome = "pending";
          unfinishedAgeMs = claim.unfinishedAgeMs;
          return failure(toolName, requestId, "call_interrupted", "The previous MCP process ended before this call completed", true, true);
        }
        if (claim.kind === "replay") {
          const replayStartedAt = performance.now();
          const replayed = { ...claim.result, replayed: true };
          phaseDurations.replay = performance.now() - replayStartedAt;
          outcome = "replay";
          return replayed;
        }
        let settled: McpToolResult;
        let unadmitted = false;
        const bindingStartedAt = performance.now();
        try {
          const payload = await bindings[typedTool](effectiveArgs, context);
          settled = {
            ...payload,
            ...(normalized.clamped ? { clamped: normalized.clamped } : {}),
            ok: true,
            toolName: typedTool,
            clientRequestId: requestId,
            replayed: false,
          };
          outcome = "success";
        } catch (error) {
          const reason = context.signal?.aborted ? context.signal.reason : error;
          outcome = reason instanceof DeadlineExceededError
            ? "deadline"
            : context.signal?.aborted
              ? "cancelled"
              : "failure";
          const taskCode = (typedTool === "create_task" || typedTool === "update_task")
            && error instanceof McpToolRefusal && typeof error.details.code === "string"
            && (error.details.code.startsWith("TASK_") || error.details.code.startsWith("maintainer_")) ? error.details.code : null;
          /* A Telegram bot refusal answers with the bot's own code and its own
             retryable: a generic retryable tool_failed after send_uncertain
             would invite the double post the bot refuses to risk. */
          /* bridge_report's one refusal (a report with nothing left after the
             privacy scrub) names its code the same way: the same call fails the
             same way, so it is not retryable as sent. */
          const botRefusal = (typedTool === "telegram_bot_send" || typedTool === "telegram_bot_send_media" || typedTool === "telegram_bot_send_document" || typedTool === "bridge_report") && error instanceof McpToolRefusal
            && typeof error.details.code === "string" && typeof error.details.retryable === "boolean"
            ? { code: error.details.code, retryable: error.details.retryable } : null;
          /* Named issue, cross-project and orchestrator refusals preserve the
             server's cause and whether the same call can succeed later. */
          const namedRefusal = error instanceof McpToolRefusal && typeof error.details.code === "string" && typeof error.details.retryable === "boolean"
            && (typedTool === "issue_report" || error.details.code === "cross_project_refused"
              || ["create_orchestrator", "rotate_orchestrator", "ask_orchestrator_in_parallel"].includes(typedTool))
            ? { code: error.details.code, retryable: error.details.retryable } : null;
          unadmitted = error instanceof McpUnadmittedRefusal;
          // Tools without a downstream recovery reader still preserve an
          // uncertain dispatch as unknown. Cache that answer under the original
          // key so replay cannot repeat a possibly executed control.
          settled = error instanceof McpDispatchUncertainError
            ? recoveryAnswer(typedTool, requestId, {
              outcome: "unknown",
              evidence: "dispatch-uncertain",
              reason: `${error.message}; execution remains possible, so look up this call under the same clientRequestId; do not repeat it with a new key`,
              ids: stringIds(error.details),
            }, false)
            : failure(
            typedTool,
            requestId,
            taskCode ?? botRefusal?.code ?? namedRefusal?.code ?? "tool_failed",
            error instanceof Error ? error.message : String(error),
            botRefusal ? botRefusal.retryable : namedRefusal ? namedRefusal.retryable : taskCode === null,
            false,
            error instanceof McpToolRefusal ? error.details : undefined,
          );
        } finally {
          phaseDurations.binding = performance.now() - bindingStartedAt;
        }
        /* #863: a caller that has already given up gets no receipt row. The
           completion write serializes the whole result and persists it, which on
           a large read is exactly the cost the deadline existed to stop — and it
           would burn the clientRequestId on an answer nobody received, so the
           obvious retry would replay a stale timeout forever. The claim is left
           unsettled instead, which is what "the previous call did not finish"
           already means: a retry gets `call_interrupted`, retryable, and the
           bounded lease sweeps the row so the id comes back.

           Bounded reads only. `pruneBoundedReceipts` deletes an unsettled claim
           exclusively for `retention = 'bounded'` — durable mutation claims never
           enter that expiry path by design — so skipping the write for a
           mutating tool would strand a permanent `result_json IS NULL` row and
           make its clientRequestId answer `call_interrupted` forever. A mutation
           that was abandoned still settles, as it did before.

           Every outcome that produced a real answer still writes, so idempotent
           replay of a completed call is untouched. */
        if (retention === "bounded" && (outcome === "deadline" || outcome === "cancelled")) return settled;
        /* #1766: a refusal the binding proved happened before admission is not
           this request's answer for ever. Nothing was created, reserved or
           dispatched, so the claim is dropped rather than settled and the same
           clientRequestId runs the operation again — which is what `retryable`
           promised. A store that cannot release falls back to settling, the
           behaviour every refusal had before. A release that finds the row
           already settled (another process answered under this key) changes
           nothing and this answer still stands for the caller. */
        if (unadmitted && receipts.release) {
          const releaseStartedAt = performance.now();
          await receipts.release(key, digest);
          phaseDurations.completion = performance.now() - releaseStartedAt;
          return settled;
        }
        await measure("completion", () => receipts.complete(key, digest, settled, retention));
        return settled;
      })();
      inFlight.set(key, { digest, result });
      try {
        return finish(await result, outcome, unfinishedAgeMs);
      } finally {
        if (inFlight.get(key)?.result === result) inFlight.delete(key);
      }
      } finally {
        const totalMs = performance.now() - callStartedAt;
        if (totalMs >= 2_000) {
          // Fixed vocabulary only: no keys, arguments, identities or error text.
          // http is a subphase of binding; these wall times are not additive.
          phaseDurations.serviceTotal = totalMs;
          console.error(`[mcp slow] tool=${typedTool} ${MCP_TIMING_PHASES
            .map(phase => `${phase}Ms=${Math.round(phaseDurations[phase] ?? 0)}`).join(" ")}`);
        }
      }
    },
  };
}

/**
 * The original-key recovery contract (#1490), published on both mutations
 * whose response can be lost after the server may already hold the request.
 */
export const RECOVERY_CONTRACT_DESCRIPTION = [
  "Recovery under the ORIGINAL `clientRequestId` (#1490): the claim is bound server-side to the calling conversation, its project, the canonical target and the exact downstream key BEFORE the one dispatch, and the request is sent exactly once — never re-POSTed after it may have reached Delegatus.",
  "Repeat the same call with the same arguments (with or without `recoveryOnly: true`) to learn what became of it. A fresh ordinary call claims and dispatches once; an existing claim is answered by READING the durable downstream record, never by dispatching again; `recoveryOnly: true` never claims an absent key or starts any work. Changed arguments under an existing key are an `idempotency_conflict`; another caller or project is refused without disclosure, and a caller whose identity the server cannot establish is refused (`caller_unidentified`) before anything is claimed or dispatched.",
  "The answer's `outcome` is closed: `accepted` (durably admitted, with its actual ids), `in-flight` (executing), `settled` (terminal, with the actual state and resend guidance), `not-executed` (the server proves dispatch never began and the attempt is permanently closed), or `unknown` (timeout, interrupted claim, an unreadable receipt record, unreadable or ambiguous evidence, or absence while execution is still possible). `nextAction` says what is permitted: on `unknown`, `accepted` and `in-flight` ONLY another lookup under the same key — `retryable` never means a new key may be used, and nothing is ever redelivered automatically. `message_receipt(operationId)` remains available for an accepted send.",
  "For a direct `send_message`, a refused TCP connection is retried within the call only when the kernel proves no request was sent. If every attempt is refused, the unadmitted claim is released: the answer gives `outcome: not-executed`, `evidence: not-admitted` and `nextAction: retry-same-key`, and the caller may repeat the identical call under its original key. This exception never applies after a timeout, reset, proxy error or unreadable answer, when the request may have reached Delegatus.",
].join(" ");

const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  spawn_agent: [
    "Create a Delegatus-managed agent conversation and return its durable conversation and launch ids.",
    "Pass `taskId` to admit the agent onto an existing board task (#1720), reviewers included. A launch that names none joins the tasks held by the parent it names (`parentConversationId`, `src` or `parent`) and by the conversation it `reviews`; naming neither, or when neither holds a task, it is given a placeholder task of its own — a duplicate card.",
    "When a turn of the new agent ends, Delegatus sends you, the caller, one message from it: its title and id, how long it ran, its Verdict line first, and its final message (up to 4 KB). Briefs need no 'report back' line. Pass `notifyLauncher: false` to turn this off; the answer's `launcherNotice` says whether it is on.",
    RECOVERY_CONTRACT_DESCRIPTION,
  ].join(" "),
  send_message: [
    "Deliver a message to a Delegatus conversation through its registered runtime host.",
    "A reclaimed conversation host is resumed after the instruction is durably reserved, and the delivery queue keeps that single operation through publication.",
    "The answer reports acceptance. `outcome` is `held`, `queued` or `delivering` until the delivery record settles, and `settled` says whether arrival is established. Hold `operationId` and ask `message_receipt` what became of it — never treat an unsettled outcome as terminal, and never re-send an unsettled operation, because a send whose fate is unknown can be delivered twice.",
    RECOVERY_CONTRACT_DESCRIPTION,
  ].join(" "),
  message_receipt: [
    "Answer what became of one accepted send, by the `operationId` `send_message` returned.",
    "`state` is `delivered`, `failed` or `in-flight`, read from the durable delivery record and reconciled against the delivery journal's current answer rather than from what the send call reported at the time. Asking is also what ENDS an accepted send that was dropped: `in-flight` means it is still progressing — the recipient may be mid-turn — and asking again later reaches `delivered` or `failed`.",
    "`resend` says what is safe to do next: `not-needed` (it arrived), `safe` (the record proves it never executed and it is fenced, so the same instruction may be sent again), or `verify-first` (`duplicateRisk` is true — delivery began, or nothing proves it did not, so check the recipient before sending again).",
    "A resend is a NEW `send_message` under a NEW `clientRequestId`: the settled operation is fenced, so repeating the original `clientRequestId` replays that settled answer instead of delivering anything.",
    "`delivery: \"interrupt-then-turn-started\"` with `interruptedTurnId` means the recipient's engine cannot steer (Copilot), so your message interrupted its running turn and started the next one; it is present while that delivery is in flight and after it settles, and absent on every other send.",
  ].join(" "),
  create_task: [
    "Compact acknowledgement by default with ids, revision and changedFields; full:true includes the complete record.",
    "Create a durable board task.",
    "When work stops, set hold with its kind and one-line reason, plus a reference or until date when relevant. A wait for a free worker slot is kind worker; resource means the machine is short of memory, disk or similar, named in note. Stop work while waiting, then clear or update the hold when work resumes. A bare blocked status remains accepted and reads as no reason given.",
    "Use steps for partial outcomes: each step has a stable id, human text, declared state, and optional pipeline, issue or PR reference; attach hold to an open step when it waits.",
    "`text` is written for the HUMAN who reviews the board: a title of 3 to 10 words on the first line, then at most a few plain sentences saying what the work has to achieve. A role name, a stage id, a prompt excerpt or a state dump is not a title.",
    "Everything an AGENT needs and the operator does not (the prompt, the working context, the rules, the ids, the file fences, a state card) goes in `details`, condensed. The card and the task's opened view show it behind one collapsed Details row, so long agent text costs the operator one line instead of the whole description.",
    "Write `text` in the operator's interface language (operatorLocale in get_orchestrator); `details` stays in whatever language serves the agent. A `text` in another language is stored with a warning.",
    "Pass `icon` (a lucide icon name) and `color` on every task you create, both picked by the rule below, so the card reads at a glance.",
    renderTaskColorRule(),
    renderTaskPriorityRule(),
  ].join(" "),
  update_task: [
    "Compact acknowledgement by default with ids, revision and changedFields; full:true includes the complete record.",
    "Update a durable board task. Orchestrators and stage agents: set note whenever the situation changes — why it is parked, what or whom it waits for, or what runs now. Keep it current in one or two short plain sentences in the operator's language (at most 280 characters). A write replaces it; null clears it.",
    "When work stops, set hold with its kind and one-line reason, plus a reference or until date when relevant. A wait for a free worker slot is kind worker; resource means the machine is short of memory, disk or similar, named in note. Stop work while waiting, then clear or update the hold when work resumes. A bare blocked status remains accepted and reads as no reason given.",
    "Use steps for partial outcomes: each step has a stable id, human text, declared state, and optional pipeline, issue or PR reference; attach hold to an open step when it waits.",
    "`text` and `details` are separate fields: an update carrying only `details` leaves `text` untouched, and the reverse. `text` stays the human title and description; agent context goes in `details`, and null or an empty string clears it.",
    "`refine` writes only the human part, as it always has. `text` and `refine.text` are written in the operator's interface language; another language is stored with a warning.",
    "To change one line of `details`, send `replaceLine`, `removeLine` or `appendLine` instead of the whole field; the answer carries detailsLength and the revision, never the field.",
    "`icon` and `color` set the card's lucide icon and colour; give both to a task you touch that lacks them, picked by the colour and icon rule in create_task's description.",
    renderTaskPriorityRule(),
  ].join(" "),
  create_pipeline: [
    "Create a Delegatus pipeline through the pipeline engine: a stage graph of agent conversations run in one worktree.",
    "`taskIds` binds the pipeline to existing board tasks in the same call (#1720): every stage launch reads that list and joins those tasks, and a pipeline created without it is given a placeholder task of its own.",
    "`finishesTask` marks this pipeline as the one that finishes its tasks (#2187): true for every linked task, or a list of ids from taskIds (others are dropped and named in `finishesTaskDropped`). With the project's merge setting on, a marked lane's task moves to Done when its PR merges; with it off, when the lane completes. Either way it waits for every other started pipeline on the task to end. Default off; set it only when this lane's PR delivers the whole task.",
    "Stages are a graph, not a list: each stage names its pass successor with `next` (a stage id, or null to end the chain), and a run stage may name a fail successor with `onFail` ({to, maxRounds?, onExhausted?}). `maxRounds` defaults to 3; more requires an explicit value. What happens when the last review fails is `onExhausted`. advance (default): the fix stage (`to`) takes the last findings. A terminal gate (next:null) re-checks the fix once: pass completes, fail parks with the number of findings left. A nonterminal gate continues along its pass edge with unreviewed findings. stop-after-fix: after that fix the lane waits for the operator in needs_review. park: stop before the fix. A fail loop from another gate permits a fresh handoff; the round count remains cumulative. `next` defaults to null, so a plan whose stages never set it is a set of disconnected stages, not a chain.",
    "A review is a run stage with role reviewer (read-only by its role) whose onFail names a fix stage, and the fix stage's next is the reviewer, so every round gets a fresh reviewer on the new head. The fixer is builder mode=apply-fixes: it fixes every handed finding and every in-spec discovery immediately, adds focused checks, and leaves grading to reviewers. It never returns fail for its own discovery: it fixes it or lists an outside-spec observation under Notes. It returns fail only when blocked, setting blocked:true and blockedReason. A self-fail with a new committed head, without blocked:true, proceeds to review with the fixer's findings as notes for the reviewer; a fail with no new head still parks with its reason. `review-loop` is a legacy kind kept for stored lanes, and one must still be pass-reachable from a run stage through `next` edges: a new one is stored as a read-only reviewer and a fix stage with an advance fail edge, the answer's `convertedStages` names each pair as {reviewer, fixer}, and `legacyReview` lists any stage kept as sent with the refusals that kept it.",
    "Runtime overrides (engine, model, effort, access) belong on the stage; `role` carries only `roleId` and its `params`. access is the repository-mutation policy enforced at settlement. sandbox is the independent tool/network boundary, defaults to full, and never changes the repository policy.",
    "A read-only stage may name repository-relative outputs. It can write those paths, while the controller refuses undeclared worktree changes and agent-created commits and records only the declared outputs.",
    "autoStart:false creates a draft the operator starts from the board; a draft that pins `baseBranch` must also pass `baseRef` (a draft is not provisioned, so the caller resolves the SHA).",
    "`publication` defaults to internal: stages and reviews settle on Delegatus's own attempts, verdicts and exact local revisions, and nothing is pushed or read from GitHub while the pipeline runs. The one remote read is the time-bounded fetch of `origin/<baseBranch>` a pipeline created or started without `baseRef` needs, and the controller makes it AFTER this call is answered: the pipeline comes back in `provisioning` with its base unresolved, and a fetch that fails parks it with the reason. A pipeline pinned to `baseRef` never touches the network. Pass remote-branch only when the pipeline must publish its branch; reviews then launch and settle only on the published head.",
    "`src` is the creator's transcript path: a native ~/.claude/projects path is normalized to the shared Claude transcript store when the mirrored file exists there.",
    "An accepted create answers an acknowledgement: `pipelineId`, `state`, `stateDetail`, `cursor`, `taskIds`, `branch`, each stage's `{id, engine, model, effort}`, `stageDigests` and `graphDigest`. It never echoes the spec, prompts or role scaffolds you sent; get_pipeline reads the full record.",
    "An invalid call is answered once with every violated constraint, each naming its field and expected shape.",
    "A refusal that happened before anything was admitted — the pipeline registry lock was never taken — does not consume the `clientRequestId` (#1766): it answers `retryable: true` with `outcome: not-executed` and `nextAction: retry-same-key`, and repeating the identical call under the SAME id runs the create instead of replaying the refusal. Every other refusal keeps its receipt, so a repeat replays it.",
  ].join(" "),
  pipeline_action: "Compact acknowledgement by default with ids, revision and changedFields; full:true includes the complete record. revision fingerprints the returned record; guarded graph edits still use stageDigests/graphDigest. Apply a supported action to an existing pipeline. Every accepted action answers pipelineId, state, cursor, closedAt and revision; graph edits or full:true include stageDigests and graphDigest. A close includes `close`; a graph edit includes `graphEdit`. get_pipeline reads the full record with full:true. Close persists immediately; close.status=pending and close.pending list the outstanding teardown, and get_pipeline returns closeReport with final per-host outcomes. Graph edits (add-stage, reorder-stage, set-edge, override-stage) are accepted on a running, paused or parked pipeline and refused once it is completed or closed, since nothing runs them there; remove-stage stays draft-only. An attempt binds its stage's prompt, role, runtime and account when it starts, so edits apply from the next attempt. override-stage with applyNow:true stops the current turn and continues the same attempt, worktree, branch and receipts on the edited runtime. Same engine uses native fork/resume; an engine change uses a bounded handoff. Only engine/model/effort/serviceTier/account may accompany applyNow. Progress is in get_pipeline stageId → runtimeSwitch. set-edge takes {stageId, edge: pass | fail, to, maxRounds?, onExhausted?: advance | stop-after-fix | park}; maxRounds defaults to 3; more requires an explicit value. The last two apply to fail edges only, and a fail edge freezes once traversed. advance (default): the fix stage takes the last findings; a terminal gate re-checks once and completes only on pass, otherwise parks with the findings count. A nonterminal gate continues along its pass edge. stop-after-fix: after that fix the lane waits for the operator in needs_review. park: stop before the fix. add-stage preserves supplied edges and changes no other stage unless after names the pass edge to splice; index controls displayed order only. add-stage with a `review-loop` stage stores it as a read-only reviewer and a fix stage (role builder, mode apply-fixes, with its predecessor's domain and size, so its runtime comes from the fix row), joined by an advance fail edge, and answers convertedStages [{reviewer, fixer}]; when that needs a guess (no read-write predecessor, no free stage slot) the stage is stored as sent and the answer carries legacyReview [{stageId, refusals}]. Pass expectedStageDigest from get_pipeline to refuse a stale write with STAGE_CHANGED: stageDigests[stageId] for override-stage and set-edge, graphDigest for add-stage, remove-stage and reorder-stage. Stages run along pass edges; array order is presentation, and a stage that has started or holds the cursor keeps its place, so add-stage may not insert before it. Every accepted edit is recorded in the pipeline's graphEdits with the calling conversation. A refusal raised before the action was admitted — the pipeline registry lock was never taken — does not consume the clientRequestId (#1766): repeat the identical call under the same id.",
  stage_report: [
    "Report the completion of the pipeline run stage THIS conversation is running.",
    "Completion fields: verdict (pass | fail | needs_decision), findings as [{ severity: P0 | P1 | P2 | P3, text }], a short summary, and optional blocked/blockedReason. Set blocked:true only when a fixer cannot proceed (cannot build, cannot run required checks, or a handed finding is impossible within the specification); it requires fail and a non-empty blockedReason. Prose never classifies blocked state.",
    "A successful acknowledgement carries the completion metadata and a bounded severity count; use get_pipeline with pipelineId and stageId to read the stored findings and summary. Pass cannot carry findings. Notes that block nothing go in the summary. A needs_decision puts its question, options and recommendation in the summary and carries no findings: a needs_decision that carries findings on a stage with a fail edge is routed to that stage as a fail.",
    "A fixable defect is fail, however partial your confidence in the call is; needs_decision is for what only the operator can unblock.",
    "The server resolves the calling conversation to its own live attempt, so stageId is needed only when one conversation holds more than one live stage, and a conversation that holds no live attempt is refused.",
    "A review-loop stage is refused: its completion is the outcome of its review flow, which the server reads itself.",
    "Provenance is collected by the server, never taken from you: the answer records pending provenance, then bounded asynchronous checks observe the worktree HEAD, branch pull request and declared outputs. Read get_pipeline with stageId for the settled observation.",
    "The call records your intent. The stage settles when your turn ends, so you may keep working after it; calling again before settlement replaces the report, and a call after it is refused.",
    "This call is the stage's only completion channel: a fenced JSON verdict in the final turn is the fallback, written only when this call returned an error or the tool is absent from the session, and when both exist this call wins.",
    "Every accepted call is recorded on the pipeline with the calling conversation, the attempt and the time.",
  ].join(" "),
  link_task_to_pipeline: "Compact acknowledgement by default with ids, revision and changedFields; full:true includes the complete record. Attach a board task to a conversation owned by a pipeline. A refusal raised before the link was admitted — the task store lock was never taken — does not consume the clientRequestId (#1766): repeat the identical call under the same id.",
  list_conversations: "List scanned Delegatus conversations with durable ids and transcript paths, compact titles by default, within a 12 KB answer budget. project/query filters run server-side. Follow nextCursor as cursor for the next page. compact:false retains full titles; get_conversation reads a full conversation.",
  search_transcripts: "Search indexed user and assistant message bodies across engines and accounts. Ask it \"has this been solved before?\", using several phrasings, project-scoped then unscoped. Default relevance ranks conversations by query coverage and returns six conversations with up to three linked fragments each. Check matched, missing and interpretedAs. A unit ending in ~ matched loosely, by a compound term's parts near each other or by an identifier prefix: its fragment decides whether the hit is on topic. Copies fold into alsoIn. Open a hit with conversation_messages at transcriptPath and timestamp as since. order: newest returns matching messages newest first, requiring every query unit. byteOffset and lineNumber pin the exact line. Pass nextCursor unchanged to continue the snapshot. project accepts a key, repository name or path; an unrecognised value searches everywhere and projectScope says so. Queries read only the index, never transcript files.",
  search_memory: "Search the local read-only index of Claude and Codex memories, global instructions and single-fact skills. Supply query with optional project and kind; results rank by text relevance and include source paths, kinds, scopes and dates, bounded to 16 KB. Omit project for cross-project search. Supply a hit id in a second call to open its bounded body and record an opened outcome. Background information may be stale; verify the source before relying on it. The engines remain the only writers of their memory stores.",
  get_conversation: "Read a conversation summary and its recent messages and tools, newest kept within an answer budget: each record keeps its first maxChars characters with truncated:true when cut, and omitted counts the older records left out. full:true returns complete records and tail lines. With tailLines, conversationId or selectedContext uses the bounded identity path, while transcriptPath uses the validated pinned reader; both return a bounded raw tail without a corpus scan. For normalized, filtered, paged messages use conversation_messages.",
  conversation_deliverability: "Read whether one conversation currently has a deliverable host from the durable registry record. An accepted resume stays synchronizing until the current generation records a claimed process; reclaimed, synchronizing, superseded, and unknown are distinct conditions.",
  conversation_messages: "Read one conversation newest-first as engine-normalized records; Claude and Codex return the same shape, while hook attachments and usage envelopes are omitted. Identity accepts conversationId, transcriptPath, or selectedContext and resolves through the same bounded paths as get_conversation. kinds is a non-empty subset of message | reasoning | tool_call | tool_result | trace (default message). roles is a non-empty subset of user | assistant | system | tool (default all). since is an inclusive ISO timestamp lower bound. limit clamps to 1..200 (default 20); maxChars clamps to 1..16000 (default 4000), and truncated marks cut text after secret redaction. Records are newest-first. Pass the opaque cursor unchanged with an omitted or fresh clientRequestId for each next-older page while hasMore is true; cursors are bound to the transcript and filters. A normal empty page returns records: []. File work is bounded by the page, so a 100 MB rollout is never parsed in full.",
  deploy_exact_sha: "Deploy one full commit SHA of the Delegatus application that serves this MCP — never the calling project's code, which this tool cannot deploy at all. The Delegatus project's designated orchestrator decides when to deploy and calls this directly; authority is the server-attributed designated seat, and nobody asks the operator for a confirmation, a phrase, or a SHA. Idempotent by clientRequestId; deployments serialize at the runtime host. An accepted deploy is recorded against the calling seat (wakeOnSettle:true), and the seat tick wakes that seat once when it reaches a terminal phase, listing the lanes the seat paused, so end the turn after the call.",
  get_pipeline: "Read one pipeline by durable id, with stageDigests and graphDigest for a guarded graph edit. Use full:true for delivery ownership, closeReport, work links and retained bodies. Compact by default; full:true or compact:false returns the whole record, prompts, role scaffolds and attempt transcripts included. `stageId` narrows the answer to that stage and one attempt (the latest by default, or `attempt`): its verdict, findings, reported summary, conversation and error, with no prompts or transcripts. `compact: true` answers the list_pipelines compact row plus the digests.",
  board_snapshot: "Read a bounded, redacted snapshot of the Delegatus board, durable placement, and the selected project's hidden conversation count.",
  list_flows: "List durable implement-review flows newest-created first, compact by default, with a 24 KB row budget and cursor pagination. Rows include identity, state, revision, spec title/length and round count. omittedCount counts matching records outside this page; omittedRecordCount counts compacted records. Follow nextCursor with the same filters and a fresh clientRequestId until hasMore is false. full:true or compact:false returns complete records; get_flow(flowId) reads one full record. A single explicit full record can exceed the budget. Unknown states are ignored; limits clamp and invalid or mismatched cursors restart with cursorReset:true.",
  get_flow: "Read one implement-review flow by durable id.",
  flow_action: "Apply a supported action to an implement-review flow. agent-decision durably submits an owner decision for one exact revision, HEAD, round, turn and optional pipeline stage attempt. Use submit-review, continue-fixing, stop or completed with a reason. Accepted decisions await authoritative completion of that same turn. Replay the original clientRequestId to recover its receipt. completed records a comment outcome and never grants review approval.",
  list_pipelines: "List durable pipelines newest-created first, compact by default, with cursor pagination and a 24 KB page budget. Follow nextCursor with the same filters. full:true reads complete records; compact:false restores the previous bounded board cards: id, task, project, branch/worktree, state and stateDetail, cursor stage, task links, and a per-stage summary (role, engine, attempt count, latest attempt's state and verdict). Deliberately carries no bodies — the spec, stage prompts, role scaffolds and every attempt's input/output transcript are read with get_pipeline, which still returns the whole record. hasSpec tells you a spec exists; long free text is truncated. `state: \"open\"` selects every state a lane can still move from (everything but completed and closed). `compact: true` shrinks each row to id, the title's first line, state, cursor, a clamped stateDetail and per stage its id and latest attempt {n, state, verdict}; get_pipeline with `stageId` then reads one stage's conclusion.",
  conversation_action: "Control or archive Delegatus conversations. interrupt, kill, resume, compact, dialog-key and permission accept one conversation by id, transcript path, or selected-card reference. dialog-key presses a key in a terminal-hosted dialog; a structured host has no terminal, so its tool permission requests are answered with permission and decision allow (once) or deny, optionally naming requestId. archive and unarchive also accept up to 100 targets; they update the existing board hidden placement without requiring a live host or readable transcript. Each archive or unarchive target expands to every registered generation path while preserving an exact transcriptPath and a spawn:<launchId> placeholder. Each per-target outcome lists the paths actually written by this call; already-archived means the full expanded set was already hidden. Archive execution requires the operator root or a designated orchestrator seat and retains conversation_action's existing cross-project reach.",
  operator_snapshot: "Read the bounded, secret-redacted Delegatus state currently visible to the operator.",
  list_tasks: "List durable board tasks, newest updatedAt first, compact by default: id, project, status, first line of text, updatedAt, revision, pipelineIds, assignmentCount, detailsLength. Filter by status set, openOnly, updatedSince, ids, query and placement. Pages stop at the row limit or 24 KB (one explicit full record can exceed it); follow nextCursor with the same filters. Every omitted page/record is counted. full:true reads complete records; compact:false restores the previous truncated-details projection. get_task reads one complete record; never write a truncated value back.",
  get_task: "Read one durable board task, including the whole agent-facing `details`.",
  deployment_status: "Read Delegatus deployment or runtime operation status, or list recent deployments, newest first. `compact: true` answers each deployment as {deploymentId, phase, sha, terminal, startedAt, finishedAt, error}; without it, the full record. `kind: host-retirement` with project lets its designated seat and Delegatus-spawned workers read their own project. The server attributes your session; workers resolve their own spawn receipt automatically. Optional callerLaunchId selects an explicit receipt belonging to your session; a designated seat needs no receipt. This reads the latest durable sweep report, capped at 100 records and 100 examined subjects per page, at most 20 pages. Pass cursor unchanged with a fresh clientRequestId while hasMore. A changed report requires restarting pagination. Historical operation/PID identity and current ownership remain explicitly unknown where the authority does not record them; current registry identity is separate. `refusedByFlag` counts, across the whole sweep and every project, the flags behind each no-active-flags refusal, and a refused item names its own `flags`. No sweep or process control is triggered. Earlier individual refusals are not retained, so an absent target never proves completion.",
  resources: "Read system memory, session count/memory totals and Delegatus's own processes. full:true or compact:false includes complete session rows. freshness reports requestedAt, the system block's capturedAt and ageMs, the session table's sessionsCapturedAt, sessionsAgeMs and sessionsStale, the cache source, and refreshSucceeded (fresh:true only). A process with no observation yet answers within a second: freshness.pending is true with reason \"collecting\", the system block is current and the session table is empty until a later call; fresh:true waits for the collection instead. When the session collector failed, the rows come from an earlier capture: sessionsStale is true and every row carries stale:true with its capturedAt, so read them as history of what ran then. viewer lists the web server, runtime host and workers with their memory; it is not actionable, since nothing in it is an agent to kill. viewer is null with viewerUnavailable \"not-the-viewer\" when this tool is served by a stdio MCP server beside the agent, which cannot measure the web server's tree; the HTTP transport answers it from the Viewer itself.",
  conversation_migration: "Select an explicit account for a structured conversation, automatically reseat by quota, retry, roll back or cancel a migration, withdraw an unclaimed account switch, or send messages a failed switch held on the current account. Explicit selection uses the browser account picker's semantics and never substitutes another account.",
  agent_activity: "Read agent liveness, compact by default. liveOnly:true excludes gone lifecycles and dead hosts after verification; excludedGoneCount says how many were removed from the bounded observation. includeGone:true includes them. Recent unproven launches and verified live hosts remain visible; expired unproven launches are excluded. Compact answers stay within 24 KB; follow nextCursor with the same options for rows deferred by the byte budget. compact:false or full:true returns the full evidence: last transcript record, turn state, host state, provider-throttle retry time, and confirmed stalls. `compact: true` answers each conversation as {conversationId, title, turnState, lifecycle, silentForMs, stalledForMs, pipeline}, plus reason and permission {tool, command, reason, since} when the turn waits on an unanswered tool permission request (reason permission_request), and drops the transcript paths, host detail and the selection and timing reports. Every answer returns within a second and names what it could not confirm. catalog:\"pending\" means this process holds no completed conversation catalog yet: the rows are the hosts the registry names, and a later call lists the rest. catalog:\"stale\" means the rows come from an earlier catalog while a newer one is read; call again for conversations started since. evidence:\"pending\" with unverifiedCount means that many rows are projected without their transcript tail (evidenceSource \"projection\" in the full answer), and undescribedHostCount (undescribedTargetCount for a transcript the call named) counts those with no row yet; a later call returns them verified.",
  lifecycle_events: "Query the durable lifecycle event journal by lineage and cursor, or poll a bounded relay digest of what changed since the last one.",
  request_attention: [
    'Use waitFor:"accepted" to return after durable acceptance with accepted:true, arrival:"pending" and handoff:null. The default waits for durable browser arrival.',
    "Move the operator's one active Delegatus view to a typed target immediately and verify the arrival — no confirmation prompt, no pending offer. Execution is gated on server-derived authority: only the operator's root/gateway session or the target project's designated orchestrator seat may direct it; workers and unidentified callers are refused (ATTENTION_NOT_PERMITTED) with nothing recorded. The latest-interaction active view is chosen deterministically (down to the one executing browser tab); success is returned only after that view's camera/focus actually landed, and a missing view, lost target, or timeout is an explicit bounded failure. Durably attributed to the calling session, idempotent by clientRequestId across restarts, and the operator keeps a one-action Return control that restores exactly where they were. On a phone the request shows as a notice; the phone's view never moves. With no desktop to move and a phone open, the call answers at once with delivered: \"notice\" and no handoff.",
    `Targets are typed and discriminated by \`kind\`, one shape per kind: ${FOCUS_TARGET_SHAPES.map((shape) => `${shape.kind} — ${shape.example}`).join("; ")}.`,
    "A conversation target takes either its durable conversationId (resolved server-side to that conversation's current transcript, and the form to prefer because it survives resume and migration) or that transcript's path.",
    "A draft target also needs the top-level project argument; region and point accept intent \"show\" only. A rejected target names the kind it read and the fields that kind expects.",
  ].join(" "),
  suggest_replies: [
    "Offer the operator ready-made replies to your own message: 1\u20136 short drafts that render as pills under your latest turn in the dock and the board's conversation pane. Tapping one drops its text into their composer for editing \u2014 Delegatus never sends it, and nothing here decides anything.",
    "Call it after every message that asks the operator something or proposes a course of action, with 2\u20134 short, distinct drafts written in the operator's own language. The set REPLACES whatever you offered last for that conversation, and the operator's next message clears it.",
    "Authority is the same as request_attention's, and for the same reason \u2014 this writes into the surface they are answering in: the operator's own session or a designated orchestrator seat. A worker or unidentified caller is refused (SUGGEST_REPLIES_NOT_PERMITTED) with nothing recorded.",
    "The drafts always land under your OWN message: conversationId defaults to your conversation, and naming any other one is refused. To offer drafts elsewhere, ask that conversation's own session to offer them.",
  ].join(" "),
  publish_prototype_review: "Publish a prototype review on a TASK. In a pipeline omit taskId: the server binds your stage to its pipeline's task. Outside a pipeline supply taskId in your own project. Short form: title, dir, variants [{number:1..9,name,description}]; immediate files use variant-N or vN, viewport width, en/uk and caption in their filenames. Matching -original and -changed suffixes form before/after pairs. Full form: variants with frames [{path,originalPath?,caption,width?,lang?}] and videos [{path,caption}]. Every variant needs a short name, one or two lines about its character and differences, and media. Delegatus copies PNG/JPEG/WebP and MP4/WebM to local state; nothing is uploaded. Bounds: 9 variants, 240 files including originals, 4 MiB/image, 64 MiB/video, 48 MiB images and 192 MiB total. Read roots match the image viewer: home/worktrees, stage scratch and evidence roots (normally /var/tmp); unreadable sources refuse the whole review with a copy instruction. Same clientRequestId replays the original publication. The operator opens the task review, chooses one variant or a combination and comments; read_prototype_review returns the saved decision and history.",
  read_prototype_review: "Read a task's prototype reviews, newest waiting round, chosen variant numbers, exact operator comment, time and delivery state. Only the newest round can wait; an undecided round a later decision retired stays in the history with supersededBy naming that decided round. Pipeline callers may omit taskId; other callers supply it. Only your own project is readable. Media URLs are installation-local and absent where copies are unavailable. This tool makes no choice and sends no message.",
  dismiss_attention: [
    "Omit target to read exactly this project's Waiting-for-you panel, with each row's clear target and server evidence as hints. project defaults to your seat or maintenance run; the operator names one. Compact by default: 40 rows, 24 KB, nextCursor for more; kinds filters and full evidence are available. Use a fresh clientRequestId for each observation.",
    "With target, clear one conversation reason, parked lane, report question or waiting prototype round; task targets include the waiting round. Only the operator's root/gateway session and this project's designated seat may clear. Its maintainer may read and cannot clear; workers and unidentified callers are refused. Update decisions stay answer-only.",
    'Targets: {kind:"conversation",conversationId|path,reasonId}, {kind:"pipeline",pipelineId,laneMovedAt}, {kind:"report",seq}, {kind:"prototype",taskId,reviewId}, {kind:"task",taskId}. Optional reason is one line up to 200 characters, retained beside server attribution in the read\'s cleared list. undo:true restores the mark. New reasons and rounds ask again. Dismissal resolves a report question in its log and leaves prototype choices open. pipeline_action dismiss/undismiss is the same lane write.',
  ].join(" "),
  bridge_report: [
    "Append one report to the durable bridge log: the report log beside the orchestrator chat, the voice relay, and, for the designated orchestrator of a project that set one, the project's Telegram chat, posted by Delegatus from the same report. Callable from any session; the origin is labeled server-side and a non-orchestrator report is visibly attributed to its own session. While the project's Bridge reports setting is off, nothing is stored and the answer says so (recorded:false, bridgeReports:false).",
    "Pass `summary` (one line, at most 120 characters: what is now true, or the ask on blocked and question) and `sections` of short items: prod (on production), merged (merged, goes out with the next deploy), inProgress, queued (what comes next), decision (what the operator must answer or do). Each item is one or two plain sentences, at most 200 characters; name work by its title and #PR, a deploy by its 8-character sha, and no URLs. Delegatus renders the header, the local time, the emoji and, on a deploy report, the task changes since the previous deploy, and cuts whole items when the report is too long. `body` is the older free-text form.",
    "Write it in the operator's interface language (operatorLocale in get_orchestrator; each wake names it). A report may be read in a public group: never local paths, hosts, ports, domains, URLs, IPs, emails, account names or ids, usage limits or plans, people's names, other projects, quotes, secrets, or card, conversation and deployment ids. An item carrying one is dropped with a warning, and a report with nothing left is refused (report_empty_after_scrub) and stays owed.",
    "Use the key the seat tick's wake gives. `covers` lists further keys this report speaks for; `coversOwed: true` settles every outcome the tick owed whose wake reached you before this report. The answer carries `warnings` (language, private information, shape) and `destinations`; the same key again is a replay that stores nothing and re-sends only a Telegram copy whose send failed, and only while the project still reports to that chat.",
  ].join(" "),
  bridge_directive: "Relay the user's intent to the designated manager. The recipient and the delivery id are derived server-side, so a retry of the same root turn is one instruction, never two.",
  get_orchestrator: "Read a project's designated orchestrator: designation, health and activity, model and prompt version, transcript size, message/tool/compaction counts, context usage against its model's configured window (clearly labelled when estimated), predecessor lineage, and a bounded rotation recommendation — STRONGLY_RECOMMEND_ROTATION once usage reaches the configured threshold. Compact by default: the seat record without its mandate and role table, and counts for intentHistory and lineage; full:true returns them whole. Words only: it never rotates, creates, or interrupts anything itself.",
  create_orchestrator: "Create a project's orchestrator or adopt one eligible registered conversation: designate it as the project's selected orchestrator and deliver the approved versioned mandate (editable). Idempotent by clientRequestId.",
  send_message_to_orchestrator: [
    "A designated orchestrator seat may relay to another project's designated seat. The recipient sees the sending project and agent authorship, never operator authority. Workers, pipeline stages, deputies and unidentified callers are refused. Seat relays must omit Delegatus authority markers and bridge trailers; a seat cannot create a missing recipient. The operator's voice gateway keeps its existing path.",
    "Deliver a message to the project's selected orchestrator, resolved server-side. A dead selected conversation is resumed; with none designated, one is created first. The recipient is frozen before the message dispatch; a later seat rotation never redirects recovery. The answer reports acceptance: ask message_receipt what became of the operationId.",
    RECOVERY_CONTRACT_DESCRIPTION,
  ].join(" "),
  ask_orchestrator_in_parallel: "While the project's orchestrator seat is busy with a turn, start its parallel self for one side ask: a fork of the seat's conversation that answers this one message with the seat's authority (no deploy, no rotation), shows live in the seat's own feed, and queues a note to the seat when it ends. For the voice gateway (the operator's root session) relaying the operator; any other agent is refused with asker_refused and sends to the orchestrator instead. Claude seats only; refused with seat_not_busy when the seat is idle (send to it directly then) and with deputy_limit while another parallel self is running. Idempotent by clientRequestId.",
  seat_tick_settings: [
    "maintenance reads or changes the board maintenance timer and reads its run records; verbose adds the previous run log.",
    "Read — and change — one project's seat tick: whether Delegatus wakes that project's seat at all, how often, and what your own monitor prompt tells the wake to look at.",
    "Called with no change fields it is a read. `project` defaults to your own, and naming another project's is allowed rather than refused; the answer says which of the two you did, and the record, the board card and the tick's journal all carry who changed whose tick.",
    "`enabled: false` stops every wake for that project until someone turns it back on — indefinitely, if that is the decision. `wakeIntervalMinutes` sets how often a wake may be sent (null restores the default hour); the tick cannot wake more often than it checks, so a value under the check interval simply means every check. `untilMinutes` is an optional expiry after which the setting lapses back to the default — omit it and the setting stands until it is changed.",
    "`reason` is the tick panel’s instruction field: what to do next and when to stop. The seat receives its full text labelled as operator instructions on every scheduler-fired wake, alongside its own `monitorPrompt` and derived items. It also explains the cadence on the board card and is required whenever the settings leave the default. It can be set at the default cadence. Instructions over 500 characters are refused without storing a shortened version. Restoring the schedule and `untilMinutes` expiry preserve both fields; `reason: null` explicitly clears the instructions when the schedule is at its defaults. Restoring the default needs no new reason.",
    "`monitorPrompt` is your own additional prompt for this project's monitor, in your own words: it is appended to every later scheduler-fired wake beside the reasons and items the tick derives, never replacing them or the contract. Send a new `monitorPrompt` to replace it and `monitorPrompt: null` to clear it; to change one line, send `replaceLine`, `removeLine` or `appendLine` instead of the whole note. It is redacted before it is stored and refused, never cut, when it is over the limit the error names. A write answers only `{changed, revision, changedFields, monitorPromptLength}` (plus `project` and `scope` when it changed another project's tick). A read carries `monitorPromptLength`, and `verbose: true` returns the stored note once, as `monitorPrompt`. A wake shows the note only when it changed since the last wake the seat received, and then as a marked preview of a long note. It changes what a wake says and never whether or when one is sent, so a prompt on its own needs no reason and leaves the project on the default tick — and `untilMinutes` expires the on/off and cadence setting, not the prompt.",
    "A project nobody has configured runs on the defaults, which are exactly the behaviour the tick has always had.",
    "The answer carries each fact once: the reason under `effective` (and under `settings` only when an expiry has set the two apart), and a standing fence as the `fence` object. `verbose: true` adds the stored reason under `settings`, the `defaults` block, and `fenceDetail`, the fence restated as one sentence.",
  ].join(" "),
  account_project_binding: [
    "List, add and remove the bindings that decide which accounts a project's work may run on. `action` is list (the default), add or remove; add and remove need `engine`, `accountId` and `project`.",
    "Every answer is a READ of the record. A list answers the whole binding table. An add or a remove answers the row it changed — `engine`, `accountId`, `project`, `changed`, and `bound` re-read from the store after the write — with that project's allowed accounts for that engine; a mutation the re-read does not show is refused rather than reported ok.",
    "A project with no binding for an engine allows every account of that engine, which is exactly the behaviour it has always had; `restricted: false` on an engine's block says so. Binding a project to a subset fences every selection for its work, including the automatic switch under rate-limit pressure: when every allowed account is out of capacity that is reported and the work parks, and an account outside the set is never chosen.",
    "`project` defaults to your own on a list, and is required to add or remove.",
  ].join(" "),
  role_presets: [
    "Read — and change — which engine, model and effort each role runs on (builder, reviewer, verifier, architect, orchestrator, cleaner, prod-auditor, deployer, maintainer, and the builder and reviewer variants such as `trivial`, `frontend` or `apply-fixes`), the mapping the Settings agent mapping edits and `PUT /api/roles` writes.",
    "Called without `overrides` it is a read: per role its `config` and its `variants`, plus the registry `revision`, its `health` and any `resets` a retirement made. `detail: true` adds each role's `shipped` values and whether its prompt text is overridden, and `choices`, every valid model per engine with the efforts each accepts.",
    "`overrides` writes, in the shape of the PUT: `{ [roleId]: { config?, variants? } }`, where a full `{ engine, model, effort }` sets a row and `null` resets it to the shipped default; an absent key is left alone, and `promptScaffold: null` restores the shipped prompt text (a scaffold cannot be set from here). Example: `{ builder: { config: { engine: \"claude\", model: \"claude-sonnet-5-5\", effort: \"high\" } }, reviewer: { config: null } }`.",
    "Only the designated orchestrator seat and the operator's own session write; any other caller reads, and its write is refused with `role_presets_write_refused` before anything else is checked.",
    "The whole write is refused, and nothing is stored, when a row names an engine, model or effort outside the launch catalogue (`role_presets_invalid`, with the offending `violations` and `choices`) or when `expectedRevision` is not the current revision (`role_presets_stale_revision`, carrying the current registry to resend against). `expectedRevision` is optional.",
    "A write answers `{changed, revision, previousRevision, health, rows}`, each row as `{row, before, after}`. The revision check, the write and its audit record are one step under a lock shared by every process that writes the registry: every write is appended, with who made it, to `role-presets-audit.jsonl` beside role-presets.json, and a write whose record cannot be stored is undone and refused with `role_presets_audit_unavailable`. A change reaches launches that start after it; running agents keep the runtime they started on.",
  ].join(" "),
  auto_updates: [
    "Read — and switch on or off — automatic updates of the Delegatus install that serves this MCP: the same state and the same switch as the Update dialog.",
    "Enabling means: Delegatus follows `main`; once a newer merge's required checks are green it waits for a quiet window (no agent turns or pipeline stages running, the operator not active, no update in progress, enough free memory) and then deploys that revision by itself. A deployment that fails rolls back to the running release, and automatic updates then switch themselves off and say why (`off`) until someone turns them on again.",
    "Called without `enabled` it is a read, open to every caller: `mode`, `availability` (`available`, or why this install cannot update itself), `enabled`, `off` (when and why they switched themselves off), `phase`, `target`, `green`, `blockers` (turn and stage totals plus bounded named `turnList`/`stageList`, `discounted` rows whose host is gone, `unresolved` rows with no liveness record, `busyReason` and `operatorWindowMs`), `drain` (draining start or six-hour operator notice), `decision` (the pending operator choice), `waitingSince`, `longWait`, `changedAt`/`changedBy` and the latest switches as `recentChanges`.",
    "A ready green update holds new pipeline stages and autonomous launches immediately. Running work finishes without interruption; custody lasts through both processes succeeding or observed rollback. After six hours Needs-you names unfinished work and offers deploy now or keep waiting; admission never reopens on a timer. A turn counts while `agent_activity` lists its conversation as live or its registry row records a process that still answers; a turn whose host is gone never counts. A row with neither a liveness record nor a registry row counts for five minutes from the first reading that saw it and stays in `unresolved` afterwards. Evidence that cannot be read blocks admission. A launch refused with `launch_held_for_update` names the wait in `waitingFor`.",
    "`enabled: true|false` writes, and answers the same view afterwards. Only the designated orchestrator seat of the Delegatus project and the operator's own session write; any other caller, a seat of another project and a seat's parallel self included, is refused with `auto_updates_write_refused` (with a `reason`) before anything changes. Turning them on where `availability` is not `available` is refused with `auto_updates_unavailable`.",
    "Every write is recorded with who made it and when, on the setting and in the Update dialog's history. Idempotent by clientRequestId.",
  ].join(" "),
  account_limits: "Read each account's last observed usage: per account `engine`, `accountId`, `active`, `fresh` (recent enough for the automatic switch to act on), `plan`, the `session` and `weekly` windows and every metered model tier as {usedPercent, resetsAt}, and `observedAt`. Narrow with `engine` and `accountId`. A read of the durable observations the accounts panel shows; it never asks a provider.",
  issue_report: [
    "A Delegatus bug report on its way to Delegatus's own public repository: preview, show, publish. Nothing is filed without the digest of a preview the operator approved.",
    "action hints takes title and body and returns advisory hints (class, matched span, title/body, lines, and written/decoded reading), without storing text. Run it, then re-read the whole text yourself: hints may be false alarms and a clean result proves nothing. Remove or rewrite identifying content and operator quotes. Detector matches never refuse preview, storage or publication.",
    "action preview takes title, body and your privacyJudgment (assessment, removed, harmlessHints with reasons, uncertainties), stores the exact text with that judgment and remaining hints, and answers its digest. Known-name source failures appear as hintWarnings and leave the agent to review the text. Any identified session may preview.",
    "action show takes digest and answers the stored title and body exactly, with privacyJudgment, remaining hints and hintWarnings, and a chat-ready previewText in the operator's interface language that marks where the published text starts and ends and lists them after it. To an orchestrator seat it also answers approvalReplies, the reply in English and Ukrainian that approves this exact text, and approvalReplyDrafts, the same reply with a label that fits suggest_replies. Put previewText in the existing chat as it is, then offer that draft with suggest_replies beside a no and an edit. The operator decides last and may approve a text that has hints.",
    "action publish takes `digest` and files the stored text as one issue. Nothing the caller says is an approval: the server reads the seat's own conversation, and publishes only when the operator's last message since the seat read the preview back is the approving reply of this digest (`issue_report_approval_required` otherwise, and nothing is sent). Only an orchestrator seat that has read the preview back with show may publish; a digest that names no stored preview, or a preview whose text no longer matches its digest, is refused. A changed title or body is a new preview with a new digest and its own approving reply. One digest is filed once, whoever calls: a publication whose outcome nobody recorded answers `issue_report_outcome_unknown` until the issue is found, and only a refusal that provably came before the write (`issue_report_publish_failed`) may be repeated. The answer carries `issueUrl`.",
    "In a repository this installation declared as an App repository the issue is filed as the Delegatus GitHub App and is refused when that credential is unavailable; no person's credentials are used instead. Idempotent by clientRequestId, and a preview that was published answers its issue again instead of filing a second.",
  ].join(" "),
  telegram_bot_chats: [
    "List the chats the operator's connected Telegram bot knows: per chat `chat` (the alias, else the chat id — the value the other telegram_bot_* tools take), `title`, `type`, `isForum`, `member`, `postAllowed` with `postRefusal` in words when false, `seesAllMessages` with `visibilityNote`, `lastMessageAt` and `storedMessages`; plus the bot's `receiving` state and note.",
    "A chat appears once the bot has been added to it or has received a message there. Only chats the operator allowlisted with an alias accept posts. Left or removed chats are hidden unless includeInactive is true.",
    "With no bot connected the answer is still ok, with `connected: false` and a note. Every answer carries `limits`: " + TELEGRAM_BOT_LIMITS.join(" "),
  ].join(" "),
  telegram_bot_send: [
    "Post a message through the operator's Telegram bot into a chat the operator allowlisted — for example a report into a team group. `chat` accepts its alias, chat id, @username or t.me chat/topic link. A topic link supplies `topicId` unless one is given explicitly.",
    "`format` is plain (default) or html (Telegram's HTML subset: b, i, u, s, code, pre, a, blockquote, tg-spoiler). Plain text over 4096 characters is split into up to 4 messages; html over 4096 is refused. `replyToMessageId` replies to a message in that chat, `topicId` posts into a forum topic, `silent` sends without a notification.",
    "The post is attributed in Delegatus to your conversation, resolved server-side. A chat outside the allowlist is refused before anything is sent (chat_not_allowed, bot_not_in_chat, chat_unknown, bot_not_connected); Telegram's own refusals come back as forbidden (blocked, removed, or a user who never wrote to the bot), format_invalid, or rate_limited with retryAfterSeconds.",
    "A refusal answers ok:false with the bot's code as `code` and `retryable` saying whether a retry under a NEW clientRequestId may help (true only for rate_limited, network_failed, timed_out, telegram_failed); send_partial adds `details.sentMessageIds`.",
    "Idempotent by clientRequestId: a repeat answers the first post's message ids; a repeat of a send that never finished, or one whose connection was cut or timed out, answers send_uncertain (not retryable) instead of posting twice.",
  ].join(" "),
  telegram_bot_send_media: [
    "Send a JPEG or PNG photo, or an album of 2–10 photos, through the operator's Telegram bot into an allowlisted chat. `images` is an array of {path, caption}; each path is absolute on the Viewer host and must resolve, symlinks followed, under the same document roots as telegram_bot_send_document (by default `handoff/` in the Viewer host's home), never through a dot-directory or the Delegatus state directory. Every file is checked and loaded before Telegram is called; photos are limited to 10 MB and captions to 1024 characters. Refusals: photo_invalid, document_outside_roots, document_forbidden_path.",
    "`format` is plain (default) or html for captions. `replyToMessageId`, `topicId`, `silent`, chat links, attribution and clientRequestId work like telegram_bot_send. The answer returns messageIds in image order. A completed send replays its receipt; an unfinished or unconfirmed send answers send_uncertain instead of sending twice. Sent images appear in telegram_bot_messages with direction out and kind photo.",
  ].join(" "),
  telegram_bot_send_document: [
    "Post one file as a Telegram document (sendDocument) through the operator's Telegram bot into an allowlisted chat — the way to share a report: markdown and long text read badly as messages. The chat must be allowlisted by the operator, as for telegram_bot_send.",
    "`document.path` is absolute on the Viewer host and must resolve, symlinks followed, under a document root the operator set in the Telegram panel (by default `handoff/` in the Viewer host's home), so write reports there first. Paths through a dot-directory or the Delegatus state directory are refused even inside a root.",
    "Types: .md .markdown .txt .log .json .csv .pdf .png .jpg .jpeg .html, non-empty, at most 20 MB; text files are scanned, as UTF-8 and UTF-16, for private keys, tokens and credentials (including `password: word` assignments) and refused with document_secret naming the class (`details.secretClass`). Other refusals: document_invalid, document_outside_roots, document_forbidden_path, document_type, document_too_large.",
    "`document.filename` is the shown name (default the file's own name) and must keep the file's type class (text, PDF or image: a .md may be shown as .txt, never as .pdf); `document.caption` up to 1024 characters, plain or html by `format`. `replyToMessageId`, `topicId`, `silent`, chat links, attribution and clientRequestId work like telegram_bot_send: a completed send replays its receipt, an unconfirmed one answers send_uncertain instead of sending twice. The post appears in telegram_bot_messages with kind document and its filename.",
  ].join(" "),
  telegram_bot_messages: [
    "Read recent messages the operator's Telegram bot received in one chat, newest first, from Delegatus's local store — a bot has no history API, so only what arrived while it was connected exists.",
    "`chat` is the alias or chat id from telegram_bot_chats; reading is not limited to allowlisted chats. Page with `limit` and the answer's `nextCursor`; `since` (ISO time, inclusive) bounds how far back; `maxChars` truncates each text (`truncated: true`). Messages the bot posted appear with direction out and `sentBy` naming the posting conversation.",
    "`storedSince` is the oldest stored message; nothing older exists locally. Every answer carries `limits` and the chat's `visibilityNote`, which says whether the bot sees every message there.",
  ].join(" "),
  rotate_orchestrator: "Explicitly hand a project's orchestrator seat to a fresh successor: bounded handoff (predecessor transcript reference, open tasks, optional notes), atomic designation switch, manager-authority-only revocation of the predecessor, bidirectional lineage. Callable from any session, including the seat rotating itself; the answer and the durable record both name who triggered it. Never triggered automatically.",
};

const clientRequestIdSchema = z.string().min(1).describe("Stable idempotency key for this logical call.");
/* #1490: the one recovery switch. Excluded from the argument digest, so the
   same logical call with and without it is one call. */
const recoveryOnlySchema = z.boolean().optional()
  .describe("Default false. true: read what became of the call already made under this clientRequestId with these same arguments, and never claim an absent key or start any work — an absent claim is answered unknown (the original may still be on its way), nothing is written under the key, and nothing is disclosed — without a claim no durable binding establishes whose work a downstream record would be. false: claim and dispatch once if the key is new; otherwise recover exactly as with true. Excluded from the argument digest.");
/* #844 §7: the selected-card reference an operator turn carried, in either of
   the two forms a caller actually holds — the `ctx=` token copied off the
   structured-user marker, or that token already decoded. The object stays open
   because the reference is versioned and validated by its own parser; a schema
   that pinned today's fields would reject tomorrow's evidence at the door. */
const selectedContextSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional()
  .describe("Selected-card reference from the operator's turn (the `ctx=` marker token, or the decoded object). Resolves the conversation through a bounded identity lookup — no operator_snapshot needed.");
const conversationArchiveTargetSchema = z.object({
  conversationId: z.string().min(1).optional()
    .describe("Durable Delegatus conversation id. Archive and unarchive actions expand it to every registered generation path."),
  transcriptPath: z.string().min(1).optional()
    .describe("Exact board transcript path, including a spawn:<launchId> placeholder. Archive and unarchive actions preserve it and add every generation of the resolved conversation."),
}).strict().refine((target) => Boolean(target.conversationId || target.transcriptPath), {
  message: "conversationId or transcriptPath is required",
});
/* #1202: one reply draft. `label` is what the pill says, `text` is what lands
   in the composer, and the object is closed because a third field would be a
   caller inventing semantics the renderer does not have. */
const replyDraftSchema = z.object({
  label: z.string().min(1).max(MAX_REPLY_LABEL_CHARS)
    .describe("What the pill says \u2014 a few words the operator reads at a glance."),
  text: z.string().min(1)
    .describe(`The draft itself, in the operator's language. Lands in their composer, editable, never sent by Delegatus. At most ${MAX_REPLY_TEXT_BYTES} bytes.`),
}).strict();
const entityIdSchema = z.string().min(1);
const snapshotStringSchema = z.string()
  .min(MIN_SNAPSHOT_STRING_LENGTH)
  .max(MAX_SNAPSHOT_STRING_LENGTH);
const snapshotPathsSchema = z.array(snapshotStringSchema)
  .max(MAX_SCOPE_PATHS)
  .refine((paths) => new Set(paths).size === paths.length, {
    message: "scope.paths must contain unique paths",
  });
const snapshotScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(VIEW_SCOPE_KINDS).exclude(["paths"]),
  }).strict(),
  z.object({
    kind: z.literal("paths"),
    paths: snapshotPathsSchema,
  }).strict(),
]);

/* #1026: the stage contract, published rather than discovered. A caller that
   composed stages from `array of objects` alone learned id, kind, role shape,
   the runtime-override seam and the `next` edges through seven sequential
   rejections. Everything the engine's normalizer accepts is declared here; the
   object stays open (`passthrough`) and the semantic rules — id uniqueness,
   edge targets, review-loop reachability, role parameter values — stay with the
   engine, which now answers with all of them at once. */
const pipelineStageSchema = z.object({
  /* Bounds here stay exactly as wide as the engine's: it trims before it
     checks, so a padded id it accepts must not be refused at the door. */
  id: z.string().regex(/^\s*[A-Za-z0-9_-]{1,64}\s*$/u)
    .describe("Stage id, unique within the pipeline: 1–64 characters of A–Z a–z 0–9 _ - (surrounding whitespace is trimmed). Referenced by next and onFail."),
  kind: z.enum(["run", "review-loop"])
    .describe("run: an agent conversation that does the work. review-loop: a read-only review of the run stage whose next chain reaches it; a new one is stored as a read-only run reviewer plus a fix stage (builder, mode apply-fixes) with that run's domain and size, joined by an advance fail edge, and the answer names them in convertedStages (or lists legacyReview refusals when that needs a guess, and stores it as sent)."),
  "prompt": z.string().min(1)
    .describe(`Instruction for this stage's agent, appended to its role scaffold. Up to ${MAX_STAGE_PROMPT_LENGTH} characters once trimmed. {{task}} renders the pipeline task and {{prev.output}} the previous stage's final prose output; a prompt that places neither still receives the previous output as a labelled section appended after the instruction.`),
  next: z.string().nullable().optional()
    .describe("Pass successor: the id of the stage this one hands to when it passes, or null to end the chain. DEFAULTS TO null — without it nothing follows this stage, and a review-loop nothing points at is rejected as unreachable."),
  onFail: z.object({
    to: z.string().describe("Stage id this stage returns to on a fail verdict."),
    maxRounds: z.number().int().min(1).max(MAX_FAIL_EDGE_ROUNDS).optional()
      .describe(`How many times this stage reviews before its budget is spent (default ${DEFAULT_FAIL_EDGE_ROUNDS}). More than 3 requires an explicit value.`),
    onExhausted: z.enum(PIPELINE_FAIL_EDGE_EXHAUSTIONS).optional()
      .describe("What a fail on the last round does. advance (default): the fail target fixes the last findings. If THIS stage has next:null, it re-checks the fix once more: a pass completes, a fail parks with budget spent: N findings left. Otherwise the fix follows THIS stage's pass edge and relays the findings as unreviewed. A fix loop from another gate permits a new handoff through a previously spent gate; rounds remain cumulative. stop-after-fix: after the last fix the lane waits in needs_review if the head changed; use it when the operator asked to look before merge. park: stop before the last fix (one more review after maxRounds fail loops). Nothing merges on its own."),
  }).nullable().optional()
    .describe("Fail successor for a run stage. A review-loop stage may not define one — it recovers through its own review flow."),
  role: z.object({
    roleId: z.enum(ROLE_IDS)
      .describe(`Role preset from the shared registry; it supplies the stage's prompt scaffold and its default engine/model/effort. ${PIPELINE_DISALLOWED_ROLE_IDS.join(", ")} is refused inside a pipeline (it needs an interactive deploy confirmation).`),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      .describe("Values for the role's declared parameters, substituted into its scaffold. Only the role's own keys, validated against the registry."),
  }).strict().optional()
    .describe("Role reference ONLY. Runtime overrides do not go here — put engine/model/effort/access on the stage itself."),
  engine: z.enum(["claude", "codex"]).optional()
    .describe("Stage-level engine override; defaults to the role's registry engine."),
  model: z.string().nullable().optional()
    .describe("Stage-level model override, or null to inherit the role default. Must be a model the stage engine supports."),
  effort: z.string().nullable().optional()
    .describe("Stage-level effort override, or null to inherit the role default. Must be an effort the stage engine supports."),
  serviceTier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).nullable().optional()
    .describe("Codex service tier: a catalog id, or null to inherit the role tier. Explicit default or standard opts out of a role tier."),
  access: z.enum(["read-only", "read-write"]).optional()
    .describe("Repository mutation policy enforced at settlement. A review-loop stage is always read-only. This does not select the sandbox or remove network, SSH, gh, or read tools."),
  sandbox: z.enum(["full", "restricted"]).optional()
    .describe("Tool/network boundary, independent from access. Defaults to full host access. restricted enables the engine sandbox without changing the repository mutation policy."),
  outputs: z.array(z.string().min(1).max(MAX_STAGE_OUTPUT_PATH_LENGTH)).min(1).max(MAX_STAGE_OUTPUTS).optional()
    .describe("Repository-relative files or directories a run stage may produce. For read-only run stages, the controller records only these paths and refuses every other worktree change or agent-created commit. Review-loop stages cannot declare outputs."),
  account: z.string().nullable().optional()
    .describe("Account this stage runs on (#1279), or null to let the project's own selection choose. Honored only when the pipeline's project allows that account; an account outside the project's allowed set is refused with the allowed ones named. A project with no binding allows every account."),
}).passthrough();

/* #1016: the typed target contract, published rather than guessed. `target` was
   declared as a free-form record with a prose list of kind names, so the
   discriminator and every per-kind field lived only in `FocusTarget` — five
   plausible guesses in a row were rejected with one undifferentiated sentence.
   Each branch here is exactly as wide as `isFocusTarget`, and each stays open
   (`passthrough`) so the binding, not the protocol boundary, answers a
   mis-shaped target with the sentence that names the way through. The
   conversation branch is the one that carries two accepted forms, so both its
   fields are optional here and the binding requires one of them. */
const focusTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.string().min(1).optional()
      .describe('Durable "conversation_…" id, resolved server-side to that conversation\'s current transcript. The form to prefer: it survives resume and migration, which a path does not.'),
    path: z.string().min(1).optional()
      .describe("Transcript .jsonl path of the conversation. Accepted alongside conversationId; supply at least one."),
  }).passthrough().describe("A conversation card, named by durable id or by transcript path."),
  z.object({
    kind: z.literal("pipeline"),
    pipelineId: z.string().min(1).describe("Pipeline id; the request frames that pipeline's group on the board."),
  }).passthrough(),
  z.object({
    kind: z.literal("stage"),
    pipelineId: z.string().min(1).describe("Pipeline the stage belongs to."),
    stageId: z.string().min(1).describe("Stage id within that pipeline. Resolves to the stage slot before it materializes and to the running agent's conversation afterwards."),
  }).passthrough(),
  z.object({
    kind: z.literal("flowRound"),
    flowId: z.string().min(1).describe("Review flow id; the request frames that flow's deck."),
    round: z.number().int().min(0).describe("Round number within the flow, from 0."),
  }).passthrough(),
  z.object({
    kind: z.literal("task"),
    taskId: z.string().min(1).describe("Board task id."),
  }).passthrough(),
  z.object({
    kind: z.literal("draft"),
    draftId: z.string().min(1).describe("Board draft id. A draft exists only on the operator's canvas, so this target also needs the top-level project argument."),
  }).passthrough(),
  z.object({
    kind: z.literal("region"),
    project: z.string().min(1).describe("Project whose board the rect is in."),
    rect: z.object({
      x: z.number(), y: z.number(),
      w: z.number().min(0), h: z.number().min(0),
    }).passthrough().describe("World-space box, in the board's own geometry."),
  }).passthrough().describe("A board area. Geometric targets accept intent \"show\" only."),
  z.object({
    kind: z.literal("point"),
    project: z.string().min(1).describe("Project whose board the point is in."),
    x: z.number(), y: z.number(),
    zoom: z.number().gt(0).optional().describe("Optional explicit zoom; otherwise the point frames a card's worth of context around itself."),
  }).passthrough().describe("A board coordinate. Geometric targets accept intent \"show\" only."),
]).describe(
  `Typed focus target, discriminated by "kind": ${FOCUS_TARGET_SHAPES.map((shape) => `${shape.kind} — ${shape.example}`).join("; ")}.`,
);

function boundedNumericInput(toolName: McpToolName, fieldPath: string): z.ZodType {
  const spec = MCP_BOUNDED_NUMERIC_ARGS[toolName]?.find((candidate) => candidate.path.join(".") === fieldPath);
  if (!spec) throw new Error(`missing bounded numeric MCP specification for ${toolName}.${fieldPath}`);
  return z.json().optional().describe(
    `Integer ${spec.min}..${spec.max}. Numeric strings are coerced, out-of-range values clamp to the nearest bound, and other values use ${spec.fallback}.`,
  );
}

const taskHoldInputSchema = z.object({
  kind: z.string().describe("Why work is waiting: operator, task, PR, issue, worker, resource, limit, postponed, external, or unstated. worker is a wait for a free worker slot: a worker cap, a launch not admitted yet, or capacity another lane will free; use it for every slot wait. resource is a shortage on the machine such as memory or disk; say which one in note, since the card shows it. limit is an account usage limit, with until. Unknown kinds normalize to unstated."),
  ref: z.union([z.string(), z.number().int().positive()]).optional().describe("Task id, PR or issue number, or external URL when the kind uses a reference."),
  note: z.string().optional().describe("One short sentence saying what ends the wait; whitespace is normalized and text clamps to 200 characters. Omitted when no reason is known."),
  until: z.string().optional().describe("ISO date for limit or postponed waits."),
}).describe("Structured reason a task or checklist step is waiting. Provenance and since are assigned by the server.");

const taskStepsInputSchema = z.array(z.object({
  id: z.string().min(1).max(40),
  text: z.string().trim().min(1).max(120),
  state: z.enum(["done", "open", "dropped"]),
  ref: z.union([z.string(), z.number()]).optional(),
  hold: taskHoldInputSchema.nullable().optional().describe("Why this open step is not moving; null clears its reason."),
})).max(TASK_STEPS_LIMIT).describe("Up to twenty checklist steps. Pipeline references derive live step motion; other references are links.");

export const TOOL_INPUT_SCHEMAS: Record<McpToolName, z.ZodObject> = {
  publish_prototype_review: prototypePublishSchema,
  read_prototype_review: z.object({ clientRequestId: clientRequestIdSchema.optional(), taskId: z.string().min(1).optional() }).strict(),
  spawn_agent: z.object({
    clientRequestId: clientRequestIdSchema,
    cwd: z.string().min(1).describe("Existing working directory for the new agent."),
    "prompt": z.string().describe("First instruction sent to the agent."),
    title: z.string().min(1).describe("Semantic conversation title required for every new spawn."),
    /* Blank is refused HERE because nothing downstream refuses it: the spawn
       route reads a blank taskId as absent and admits the launch anyway — onto
       the tasks of whatever parent or reviewed conversation the call names, or
       onto a fresh placeholder card when it names none. Either way the
       outcome's card records nothing and the caller is told nothing, so the
       boundary is the only place that can answer. This dispatch reaches
       /api/spawn same-origin with the operator capability, so the route never
       infers the caller as parent; only body selectors set one. The
       create_pipeline half of this contract is refused by the engine, with its
       own named violation, so that schema leaves the entries to it. */
    taskId: z.string().refine((value) => value.trim().length > 0, { message: "taskId must name a board task; omit the field to launch without one" }).optional()
      .describe("Board task this agent works on (#1720). The launch joins that task when its receipt is reserved, and an id naming no task refuses the launch before any agent starts — a blank id is refused here, since the launch would otherwise read it as no task at all. The task must belong to the project resolved from cwd after project aliases are resolved; a task from another project is refused before any request is claimed or dispatched. Use a task on the target project's board, or omit taskId. Omitting it, the launch joins every task held by the parent this call names (parentConversationId, src or parent — this tool never infers one from the caller) and by the conversation it reviews; when the call names neither, or neither holds a task, it is given a placeholder task of its own, which is a duplicate card. A reviewer that names a parent therefore joins that parent's card beside the reviewed work's, so pass taskId on reviewer spawns too — an explicit id wins over inheritance."),
    engine: z.enum(["claude", "codex", "copilot"]).optional()
      .describe("Agent CLI. copilot runs the GitHub Copilot CLI over ACP on the structured transport; its account is named or the selected one (no automatic pick), model auto or an id the account offers, effort none…max."),
    model: z.string().optional(),
    effort: z.string().optional(),
    serviceTier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional()
      .describe("Codex only: catalog tier id such as priority or ultrafast; refused if the model/account does not offer it. default or standard opts out of a role tier."),
    fast: z.boolean().optional().describe("Codex speed: true means priority; must agree with serviceTier when both are present."),
    role: z.enum(ROLE_IDS).optional(),
    roleParams: z.record(z.string(), z.unknown()).optional()
      .describe("Role-specific parameters. Bounded integers accept numeric strings, clamp to their declared role bounds, and report the applied value in clamped."),
    reviews: z.string().optional(),
    parentConversationId: z.string().optional(),
    project: z.string().optional()
      .describe("Optional. The target project is resolved server-side from cwd; a value that contradicts it is refused before anything is claimed or dispatched."),
    allowSubagents: z.boolean().optional(),
    crossProjectRequest: z.string().optional()
      .describe("Only for a designated orchestrator seat acting on ANOTHER project's board, which is refused by default: hand the work to that project's seat with send_message_to_orchestrator. When the operator explicitly asked you to act on that project directly, quote their request here."),
    notifyLauncher: z.boolean().optional()
      .describe("Default true: each time a turn of the new agent ends, you receive one message from it with its final message. false turns that off for this launch."),
    mcpServers: z.array(z.string().regex(/^[^\s\u0000-\u001f\u007f]{1,128}$/u))
      .optional()
      .describe("Per-spawn MCP server allowlist, resolved server-side. Only servers Delegatus may grant are accepted; any other name is refused outright, never silently trimmed. `viewer` is always included. The grant is then decided by the new session's origin — a delegated launch, which every role-preset spawn is, receives the Delegatus baseline whatever it lists here — so this can narrow the surface, never widen it."),
    images: z.array(z.unknown()).optional(),
    recoveryOnly: recoveryOnlySchema,
  }).passthrough(),
  send_message: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    text: z.string().min(1),
    recoveryOnly: recoveryOnlySchema,
  }).passthrough(),
  message_receipt: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    operationId: z.string().min(1).describe("The operationId a send_message call returned."),
  }).passthrough(),
  create_task: z.object({
    includeHints: z.boolean().optional().describe("true includes the static readMore hint; full:true also includes it."),
    clientRequestId: clientRequestIdSchema,
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    findingKey: z.string().max(400).refine(value => [...value].length <= 200).optional()
      .describe("Opaque finding identity, at most 200 characters, unique among this project's open tasks. A recurring create increments count and lastSeenAt, replaces note (omitted clears it), preserves text, and answers the existing id with matched:true. After Done a new task links through finding.previousTaskId. Local to this install; never synced."),
    note: z.string().nullable().optional().describe("Current situation for a keyed finding, at most 280 characters. Author and time are server-derived; omitted clears the previous note on a match."),
    project: z.string().min(1),
    crossProjectRequest: z.string().optional()
      .describe("Only for a designated orchestrator seat acting on ANOTHER project's board, which is refused by default: hand the work to that project's seat with send_message_to_orchestrator. When the operator explicitly asked you to act on that project directly, quote their request here."),
    text: z.string().min(1).describe("The HUMAN part of the card: a title of 3 to 10 words on the first line, then at most a few plain sentences about the outcome. Agent context belongs in details."),
    hold: taskHoldInputSchema.optional(),
    steps: taskStepsInputSchema.optional(),
    details: z.string().optional()
      .describe("Agent-facing context, kept off the human description (#1834): the prompt, the working notes, the ids, the rules, the state. Plain text, no markdown rendering, capped at 20000 characters, condensed to what an agent picking the task up actually needs. The card shows it behind one collapsed Details row; a blank value creates a task with no details."),
    placement: z.enum(["pinned", "unplaced"]).optional().describe("Omitted placement creates an unplaced task. Pinned requires pos; unplaced must omit pos."),
    pos: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
    dueAt: z.string().optional(),
    dueTz: z.string().optional(),
    attachments: z.array(z.unknown()).optional(),
    board: z.enum(["shown", "hidden"]).optional()
      .describe("Board membership of the new task's band (#1627). Omitted creates a task the board shows, and the per-project limit counts only those; hidden records the task off the board, which is how work is kept when the board is full. Either way the task keeps its row in the task list, and update_task moves it between the two."),
    /* Unknown, so the command clamps what the schema would refuse (#2102). */
    icon: z.unknown().optional()
      .describe("A lucide icon name for the card (#2102), kebab-case: bug, smartphone, rocket, search-check, shield. Bug and lucide:bug mean the same. A name lucide does not have, or a value that is no name, is stored as no icon and the answer carries a note."),
    /* Unknown too, so an unknown colour is clamped with a note like an icon. */
    color: z.unknown().optional()
      .describe(`Colour label for the card: none, ${TASK_COLORS.join(", ")}, picked by the rule in this tool's description. A value that is no colour is stored as no colour and the answer carries a note.`),
    priority: z.unknown().optional()
      .describe(`${TASK_PRIORITIES.join(", ")}; omitted is normal. Picked by the rule in this tool's description. A value that is no priority creates a normal task and the answer carries a note.`),
    machine: z.literal("here").optional()
      .describe("The machine that runs the task on a linked board; a new task always runs on the machine that creates it, so the only value is \"here\"."),
  }).passthrough(),
  update_task: z.object({
    includeHints: z.boolean().optional().describe("true includes the static readMore hint; full:true also includes it."),
    clientRequestId: clientRequestIdSchema,
    findingKey: z.string().max(400).refine(value => [...value].length <= 200).nullable().optional()
      .describe("Set an opaque finding identity of at most 200 characters; null clears it and its occurrence metadata. Another open task holding it in this project refuses the update, including a reopen. Setting a new key starts count at one. Local to this install; never synced."),
    note: z.string().nullable().optional().describe("Current situation for the operator, at most 280 characters; replaces the note, null clears it. Author and updatedAt are server-derived."),
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    taskId: entityIdSchema.optional().describe("Required for every update except refine; refine defaults to every pending task the calling conversation is linked to."),
    refine: z.object({ text: z.string().trim().min(1).max(600).describe("Short human title on the first line (3–10 words), then up to two concise sentences.") }).optional()
      .describe("First-action task naming: title the placeholder task your conversation is linked to, once. Replaying the same text returns the prior result; a task already named by the operator or an earlier refinement answers already-named and keeps its title."),
    expectedProject: z.string().min(1).optional().describe("Required for pos or placement updates: copy the current task project exactly."),
    expectedRevision: z.string().min(1).optional().describe("Required for pos or placement updates: copy the opaque revision from get_task or list_tasks."),
    text: z.string().optional().describe("The HUMAN part: a title of 3 to 10 words on the first line, then at most a few plain sentences about the outcome. Agent context does not belong here; pass it as details."),
    hold: taskHoldInputSchema.nullable().optional(),
    steps: taskStepsInputSchema.nullable().optional(),
    details: z.string().nullable().optional()
      .describe("Agent-facing context (#1834): a string sets or replaces it, null or an empty string clears it. Its own field, so an update carrying only details leaves text byte for byte and the reverse. Read the current value with get_task first, since list_tasks truncates it and a write replaces the whole field rather than appending. To change one line, send replaceLine, removeLine or appendLine instead."),
    replaceLine: z.object({
      prefix: z.string().min(1).optional().describe("Replace the one details line starting with this text (leading spaces ignored). More or fewer than one match is refused and nothing is stored."),
      index: z.number().int().min(0).optional().describe("Or the zero-based line number; given with prefix, that line must start with it."),
      text: z.string().describe("The new line."),
    }).optional().describe("Replace one line of the stored details without resending the rest."),
    removeLine: z.object({
      prefix: z.string().min(1).optional().describe("Remove the one details line starting with this text (leading spaces ignored)."),
      index: z.number().int().min(0).optional().describe("Or the zero-based line number; given with prefix, that line must start with it."),
    }).optional().describe("Remove one line of the stored details."),
    appendLine: z.string().min(1).optional()
      .describe("Append one line to the stored details. Edits apply in the order replaceLine, removeLine, appendLine, atomically against the details stored at the write and under the details limit; not combined with details."),
    status: z.enum(["inbox", "assigned", "blocked", "done"]).optional(),
    placement: z.enum(["pinned", "unplaced"]).optional().describe("Pinned retains existing pos when omitted; unplaced removes pos. Placement updates require expectedProject and expectedRevision."),
    pos: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
    dueAt: z.string().nullable().optional(),
    dueTz: z.string().nullable().optional(),
    board: z.enum(["shown", "hidden"]).optional()
      .describe("Board membership of this task's band (#1614). hidden takes the band off the board and shown puts it back; the task itself is never removed, keeps its row in the task list and every assignment, and either direction is one write. It governs EMPTY tasks only — a task holding a durable agent association draws its band whatever this says."),
    color: z.enum(["none", ...TASK_COLORS]).optional()
      .describe("Colour label shown on the task's kanban card (#1695). none clears it."),
    priority: z.enum(TASK_PRIORITIES).optional()
      .describe("How soon to take the task, picked by the rule in this tool's description; normal clears a high or low. Leaves updatedAt unchanged."),
    icon: z.unknown().optional()
      .describe("A lucide icon name for the card (#2102), read like create_task's icon; none, null or an empty string clears it. Leaves updatedAt unchanged."),
    attachLinks: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional()
      .describe("PRs or issues to attach to the task's card by hand (#2059): \"#123\", \"123\", \"PR 123\", \"owner/repo#123\" or a github.com pull/issue URL, one or a list. A bare number means the task's repository. Attaching one already attached changes nothing. The card also shows every link its pipelines discover, so attach only what discovery cannot see. Leaves updatedAt unchanged."),
    detachLinks: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional()
      .describe("PRs or issues to remove, in the same forms as attachLinks. Only links attached by hand are removed; a discovered one answers WORK_LINK_AUTO with its evidence."),
    linkKind: z.enum(["pr", "issue"]).optional().describe("Whether attachLinks names pull requests or issues, when the number alone leaves it open."),
    hide: z.boolean().optional()
      .describe("Hide (true) or show (false) the task's whole group on the kanban board (#1695). Requires expectedProject and expectedRevision. Nothing is stopped, sent or changed besides the hide: conversations keep running and pipelines keep their state. The group comes back by itself when something newer needs the operator (a decision request, a newly linked conversation, a pipeline newly waiting on a decision). The task holding the project's orchestrator seat conversation cannot be hidden (TASK_HIDE_PROTECTED)."),
  }).passthrough(),
  create_pipeline: z.object({
    clientRequestId: clientRequestIdSchema,
    recoveryOnly: recoveryOnlySchema,
    delivery: z.object({
      branch: z.string().startsWith("refs/heads/"),
      remote: z.string().optional(),
      pr: z.number().int().positive().optional(),
      rejectedHead: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
      comparison: z.boolean().optional(),
    }).optional().describe("Delivery target, using the PR head repository remote and full branch. The canonical repository plus branch has one Delegatus publisher. A competing creation becomes an internal comparison lane and names its owner; host Git/gh tools remain unchanged."),
    task: z.string().min(1).describe("Board title for the pipeline."),
    taskIds: z.array(z.string()).optional()
      .describe("Board tasks this pipeline's work belongs to (#1720), recorded durably on the pipeline. EVERY stage launch — run, review-loop, retry, fail branch — reads this list at launch time and joins those tasks, so passing it in the create call is what keeps one product outcome on one card; a pipeline created without it is given a placeholder task of its own. Each id must name an existing task in the pipeline's project. pipeline_action \"link-task\" adds one afterwards, for the stages that have not started yet."),
    finishesTask: z.union([z.boolean(), z.array(z.string())]).optional()
      .describe("#2187: true marks every task in taskIds as one this pipeline finishes; a list marks those ids, and an id outside taskIds is dropped and named in the answer's finishesTaskDropped. A marked lane's task moves to Done when the lane completes (merge setting off) or when its PR merges (on), once no other started pipeline on the task is open. pipeline_action link-task with finishes changes it later."),
    spec: z.string().optional().describe("Acceptance criteria shared by every stage."),
    crossProjectRequest: z.string().optional()
      .describe("Only for a designated orchestrator seat acting on ANOTHER project's board, which is refused by default: hand the work to that project's seat with send_message_to_orchestrator. When the operator explicitly asked you to act on that project directly, quote their request here."),
    repoDir: z.string().min(1).describe("Absolute path of the existing git repository the pipeline worktree is cut from."),
    baseBranch: z.string().optional().describe("Branch the worktree is based on. A draft that pins this must also pass baseRef."),
    baseRef: z.string().optional().describe("Commit the pipeline is pinned to. Required when a draft (autoStart:false) pins baseBranch — resolve the SHA yourself."),
    stages: z.array(pipelineStageSchema).describe(
      `Stage graph, 0–${MAX_PIPELINE_STAGES} stages (a started pipeline needs at least ${MIN_STARTED_PIPELINE_STAGES}). Stages run in the order the next edges chain them, not array order; every review-loop must be pass-reachable from a run stage.`,
    ),
    src: z.string().optional().describe("Optional for an authenticated exact caller generation; otherwise required. Creator transcript path (.jsonl) under the shared Claude transcript store or a Codex sessions root; a native ~/.claude/projects path is normalized to its shared-store mirror when that file exists."),
    autoStart: z.boolean().optional().describe("false creates a draft for the operator to start from the board."),
    publication: z.enum(["internal", "remote-branch"]).optional().describe("internal (default): Delegatus's own state decides every stage and nothing is pushed or read from a remote while it runs; creation without baseRef leaves the base to the controller, fetched time-bounded after the call is answered. remote-branch: push every accepted revision and fence reviews on origin/<branch>."),
  }).passthrough(),
  pipeline_action: z.object({
    includeHints: z.boolean().optional().describe("true includes the static readMore hint; full:true also includes it."),
    clientRequestId: clientRequestIdSchema,
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    pipelineId: entityIdSchema,
    /* #774: was `z.string().min(1)` while the route admitted a fixed set. */
    action: z.enum(PIPELINE_ACTIONS).describe("resolve-decision: the pipeline creator answers a settled needs_decision question, reserving a fresh attempt of the same stage. Requires answer, expectedStageId, expectedAttempt and expectedRevision from get_pipeline. Reuse clientRequestId only for the identical answer. continue-review (#1938): the creator or operator adds an explicit bounded addRounds grant to the same lane. A needs_review lane reviews its unreviewed head; a needs_decision lane parked by a failed terminal budget re-check sends its retained findings to fix first, then runs a fresh reviewer on the new head for the granted rounds. Failed heads are never accepted by this action. Requires addRounds and expectedRevision from get_pipeline. accept-head (#2187): the creator or operator takes that unreviewed head as it is, and the lane follows the review stage's pass edge or completes; refused outside needs_review. Requires expectedRevision from get_pipeline. retry-merge (#2187): a completed lane whose automatic merge stopped (merge.state blocked or cancelled) goes back into its repository's merge queue; refused while the project's merge setting is off. preview-legacy-review: read-only; answers how a legacy review-loop stage would convert into a reviewer run stage plus one fix stage, or every reason it cannot, with a recommended finite reviewLimit. convert-legacy-review: the creator or operator applies that conversion explicitly; requires expectedRevision, and stageId, reviewLimit and implementerStageId when the preview asks for them; reuse clientRequestId only to replay it. revert-legacy-review: restores the original definition while nothing has run under the conversion; requires stageId and expectedRevision."),
    stageId: z.string().min(1).optional().describe("The stage a graph edit, a legacy-review conversion or a retry-stage names. retry-stage: the stage the pipeline waits on, retried whatever ended its attempt; without launchId it is sent as expectedStageId with that stage's current attempt as expectedAttempt, so a stage or attempt that moved on is refused with STAGE_CHANGED."),
    stage: pipelineStageSchema.optional().describe("add-stage: the complete stage definition. Keeps next and onFail as supplied unless after explicitly selects a pass edge to insert into."),
    after: z.string().min(1).optional().describe("add-stage only: splice into this stage's pass edge. That stage points to the new stage, which inherits its former next; every other edge stays unchanged. Independent of index."),
    index: z.number().int().optional().describe("add-stage: insertion position in the displayed stage order. A nonempty draft refuses index 0 because its entry must stay first."),
    stageIds: z.array(z.string()).optional().describe("reorder-stage: stage ids in the new displayed order."),
    toIndex: z.number().int().optional().describe("reorder-stage: destination index."),
    expectedStageDigest: z.string().regex(/^[0-9a-f]{64}$/).optional().describe("Graph edit guard from get_pipeline: the stage digest for override-stage and set-edge, or the graph digest for add-stage, remove-stage and reorder-stage."),
    edge: z.enum(["pass", "fail"]).optional().describe("set-edge: which successor to change."),
    to: z.string().nullable().optional().describe("set-edge: successor stage id, or null to clear the edge."),
    maxRounds: z.number().int().min(1).max(MAX_FAIL_EDGE_ROUNDS).optional().describe("set-edge fail edge: review budget, default 3. More than 3 requires an explicit value."),
    onExhausted: z.enum(PIPELINE_FAIL_EDGE_EXHAUSTIONS).optional().describe("set-edge fail edge: action when its review budget is spent."),
    role: pipelineStageSchema.shape.role.nullable().describe("override-stage: role reference, or null to clear it."),
    applyNow: z.boolean().optional().describe("override-stage: interrupt the running run stage and continue the SAME attempt on the new runtime."),
    engine: pipelineStageSchema.shape.engine.describe("override-stage: runtime engine."),
    model: pipelineStageSchema.shape.model.describe("override-stage: runtime model, or null to inherit."),
    effort: pipelineStageSchema.shape.effort.describe("override-stage: reasoning effort, or null to inherit."),
    serviceTier: pipelineStageSchema.shape.serviceTier.describe("override-stage: Codex tier, null to inherit; default or standard opts out."),
    access: pipelineStageSchema.shape.access.describe("override-stage: repository mutation policy."),
    account: pipelineStageSchema.shape.account.describe("override-stage: account pin, or null to clear it."),
    "prompt": z.string().optional().describe("override-stage: replacement prompt."),
    launchId: z.string().min(1).optional().describe("retry-stage only, optional, and only for an attempt whose launch failed: the launchId get_pipeline with stageId answers for it, sent with stageId. The engine then retries only a failed or conflicted launch receipt, so omit it for an agent that started and then failed or parked. A launch that is no longer the current attempt's is refused."),
    answer: z.string().min(1).max(12_000).optional(),
    addRounds: z.number().int().min(1).max(MAX_FAIL_EDGE_ROUNDS).optional().describe("continue-review only: explicit additional review rounds, 1..MAX_FAIL_EDGE_ROUNDS. For a failed terminal budget re-check, each granted round fixes retained findings then runs a fresh review; the last failed review parks in needs_decision and requires another grant. A needs_review lane reviews its current head first; stop-after-fix hands the last failed review to one fix and parks a new unreviewed head in needs_review."),
    reviewLimit: z.number().int().optional().describe("preview/convert-legacy-review only: the finite review count the converted reviewer gets, 1–9. It runs that many times when every review fails, the final review included; the default is the limit recorded on the stage's review flow, or 3 when none is recorded. More than 3 requires an explicit value."),
    implementerStageId: z.string().min(1).optional().describe("preview/convert-legacy-review only: the run stage whose role the fix stage copies, when more than one run passes into the review."),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    expectedStageId: z.string().min(1).optional(),
    expectedAttempt: z.number().int().nonnegative().optional().describe("With expectedStageId, or with override-stage applyNow: the attempt number the caller saw."),
    expectedConversationId: z.string().min(1).optional().describe("override-stage applyNow only: the conversation the caller saw running the attempt; another one is refused with STAGE_CHANGED."),
    expectedOwner: z.string().optional(),
    expectedEpoch: z.number().int().positive().optional(),
    reason: z.string().optional(),
    acceptedSha: z.string().regex(/^[0-9a-f]{40}$/i).optional().describe("publish: exact SHA to publish. A parked passed stage in committing can accept a moved head only when its worktree is clean, HEAD equals this SHA, its previously passed commit is an ancestor and all added work is verified clean integration of origin's configured main branch. Additional lane work or merge resolutions require a fresh review. Preserves pass and reviewed provenance, updates lastPassedCommit and advances automatically after publication. Omit to retry its existing accepted commit, including a settled failed publication; no takeover is needed. Deferred skip-stage, review retry-stage and takeover are refused when the serving controller cannot handle them."),
    link: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional()
      .describe("attach-link and detach-link (#2059): a PR or issue as \"#123\", \"123\", \"PR 123\", \"owner/repo#123\" or a github.com URL, or a list. A bare number means the pipeline's delivery repository. Attach what discovery cannot see: the pipeline's lane and delivery branches, its delivery.pr and the PR its stages reported are found without it. Allowed in every state; detach removes only links attached by hand. The answer carries workLinks, the resolved links."),
    kind: z.enum(["pr", "issue"]).optional().describe("attach-link only: whether link names a pull request or an issue, when the number alone leaves it open."),
    taskId: z.string().min(1).optional().describe("link-task and unlink-task: the board task. unlink-task also clears finishes for it."),
    finishes: z.boolean().optional().describe("link-task only (#2187): whether this pipeline finishes the task. An upsert: on a task already linked it only sets or clears the flag; absent leaves it as it is. A marked lane's task moves to Done when the lane completes (merge setting off) or its PR merges (on), once no other started pipeline on the task is open."),
  }).passthrough(),
  stage_report: z.object({
    clientRequestId: clientRequestIdSchema,
    verdict: z.enum(["pass", "fail", "needs_decision"])
      .describe("pass when the stage's contract is complete, notes that block nothing going in the summary. fail when the work is not done: for a review, the findings that stand; for any other stage, what stopped it. needs_decision when only the operator can unblock the stage, with the question in the summary and no findings."),
    findings: z.array(z.object({
      severity: z.enum(STAGE_FINDING_SEVERITIES).describe("P0 highest, P3 lowest. Findings are ranked by it."),
      text: z.string().min(1).max(MAX_STAGE_FINDING_CHARS - 5).describe(
        `What is wrong and where (file:line, or the surface and viewport), how to show it fails, the fix intent and its acceptance. Claim no head, pull request or declared output: the server reads that provenance itself. A finding is recorded in its rendered form "P1 — text", so text is limited to ${MAX_STAGE_FINDING_CHARS - 5} characters to preserve it in the ${MAX_STAGE_FINDING_CHARS}-character record.`,
      ),
    })).max(MAX_STAGE_REPORT_FINDINGS).optional()
      .describe("Unresolved work, ranked. Empty or omitted for pass, which cannot carry findings, and for needs_decision, whose findings would send a stage with a fail edge to its fix stage."),
    blocked: z.boolean().optional()
      .describe("Set true only when the fixer cannot proceed: cannot build, cannot run required checks, or a handed finding is impossible within the specification. Requires verdict fail and blockedReason; parks the fix stage even with a new committed head."),
    blockedReason: z.string().trim().min(1).max(MAX_STAGE_REPORT_SUMMARY_CHARS).optional()
      .describe("Required reason when blocked:true. Retained independently of prose and output truncation; requires blocked:true."),
    summary: z.string().max(MAX_STAGE_REPORT_SUMMARY_CHARS).optional()
      .describe("What was done, in a few sentences, with any notes that block nothing; for needs_decision, the question, the options and your recommendation. Shown on the card and relayed to the next stage."),
    stageId: z.string().min(1).optional()
      .describe("Only when this conversation holds more than one live stage; the refusal lists them."),
  }).passthrough(),
  link_task_to_pipeline: z.object({
    includeHints: z.boolean().optional().describe("true includes the static readMore hint; full:true also includes it."),
    clientRequestId: clientRequestIdSchema,
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    taskId: entityIdSchema,
    pipelineId: entityIdSchema,
  }).passthrough(),
  list_conversations: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    project: z.string().optional(),
    query: z.string().optional(),
    cursor: z.string().optional().describe("Opaque nextCursor from the previous page; pass the same project/query."),
    compact: z.unknown().optional().describe("Compact titles by default; false retains the full title."),
    limit: boundedNumericInput("list_conversations", "limit"),
  }).passthrough(),
  search_transcripts: z.object({
    full: z.boolean().optional().describe("true includes static tokenizer and fieldsSearched statistics; index counts are always returned."),
    clientRequestId: clientRequestIdSchema.optional(),
    query: z.string().trim().min(1).describe("Terms to match in indexed user and assistant message bodies."),
    project: z.string().trim().min(1).optional().describe("Project key, repository name, or path. Unknown or ambiguous values search every project and report the fallback."),
    order: z.enum(["relevance", "newest"]).optional().describe("relevance (default): rank conversations by coverage, with linked fragments. newest: messages newest first, every unit required."),
    cursor: z.string().min(1).optional().describe("Opaque cursor returned by the preceding page for this query and project."),
    limit: boundedNumericInput("search_transcripts", "limit").describe("Integer 1..100; default 6 conversations for relevance, 20 messages for newest. Numeric strings coerce and out-of-range values clamp."),
  }).passthrough(),
  search_memory: z.object({
    clientRequestId: clientRequestIdSchema.max(256, "clientRequestId must be at most 256 characters for the bounded memory response"),
    query: z.string().trim().min(1).max(2000).optional().describe("Terms to match in the shared memory index. Supply query or id."),
    id: z.string().regex(/^m_[a-zA-Z0-9_]+$/).max(64).optional().describe("Open one search hit and record its opened outcome in the local ledger."),
    project: z.string().trim().min(1).max(256).optional().describe("Canonical project key; includes that project's entries and global entries. Omit for cross-project search."),
    kind: z.enum(MEMORY_KINDS).optional(),
    limit: boundedNumericInput("search_memory", "limit"),
  }).passthrough(),
  get_conversation: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    maxRecords: boundedNumericInput("get_conversation", "maxRecords"),
    maxChars: boundedNumericInput("get_conversation", "maxChars")
      .describe("Characters retained per record or raw tail line after secret redaction. Integer 1..16000; default 4000 for messages and tail lines, 1000 for tools."),
    full: z.boolean().optional().describe("true returns complete record texts and tail lines with no answer budget."),
    selectedContext: selectedContextSchema,
    tailLines: boundedNumericInput("get_conversation", "tailLines")
      .describe("Read this many trailing transcript lines instead of the scanned summary. Use conversationId or selectedContext for the bounded identity path, or transcriptPath for the validated pinned reader; all alternatives keep answering while corpus scans are degraded."),
  }).passthrough(),
  conversation_deliverability: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    conversationId: z.string().min(1).optional(),
    transcriptPath: z.string().min(1).optional(),
  }).passthrough(),
  conversation_messages: z.object({
    full: z.boolean().optional().describe("true includes diagnostic metadata."),
    includeMetadata: z.boolean().optional().describe("true includes transcriptPath, engine, lastRecordAt and scanned. Capped scan evidence is always returned."),
    clientRequestId: clientRequestIdSchema.optional(),
    conversationId: z.string().min(1).optional()
      .describe("Durable Delegatus conversation id. Supply this, transcriptPath, or selectedContext."),
    transcriptPath: z.string().min(1).optional()
      .describe("Transcript under a registered scanner root. Supply this, conversationId, or selectedContext."),
    selectedContext: selectedContextSchema,
    kinds: z.array(z.enum(["message", "reasoning", "tool_call", "tool_result", "trace"])).min(1).optional()
      .describe("Record kinds to return: message, reasoning, tool_call, tool_result, trace. Defaults to message; duplicates are ignored."),
    roles: z.array(z.enum(["user", "assistant", "system", "tool"])).min(1).optional()
      .describe("Record roles to return: user, assistant, system, tool. Defaults to all four; duplicates are ignored."),
    since: z.string().min(1).optional()
      .describe("Inclusive ISO-8601 timestamp lower bound with Z or a numeric offset."),
    limit: boundedNumericInput("conversation_messages", "limit")
      .describe("Newest-first records per page. Integer 1..200, default 20; numeric strings coerce and out-of-range values clamp."),
    maxChars: boundedNumericInput("conversation_messages", "maxChars")
      .describe("Characters retained per record after secret redaction. Integer 1..16000, default 4000; truncated is true when text was cut."),
    cursor: z.string().min(1).optional()
      .describe("Opaque cursor from the preceding page. Pass it unchanged with an omitted or fresh clientRequestId for the next-older page while hasMore is true."),
  }).passthrough(),
  deploy_exact_sha: z.object({
    clientRequestId: clientRequestIdSchema,
    /* #795: authority is the caller's server-attributed designated-seat
       identity; the arguments carry only WHAT ships, never a proof. */
    revision: z.string().regex(/^[0-9a-f]{40}$/i).describe("Full 40-hex commit SHA to deploy. Resolve it yourself (e.g. remote main); never a branch name."),
  }).passthrough(),
  get_pipeline: z.object({
    full: z.boolean().optional().describe("true returns the complete pipeline, including prompts, transcripts, delivery and work links."),
    clientRequestId: clientRequestIdSchema.optional(),
    pipelineId: entityIdSchema,
    stageId: z.string().min(1).optional()
      .describe("Answer only this stage and one of its attempts: verdict, findings, summary, conversation, error. No prompts or transcripts."),
    attempt: z.number().int().positive().optional()
      .describe("With stageId: the attempt number to read. Defaults to the stage's latest attempt."),
    compact: z.boolean().optional()
      .describe("Compact by default: the list_pipelines row plus revision, stageDigests and graphDigest; false restores the full record."),
  }).passthrough(),
  board_snapshot: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    project: z.string().optional(),
    activity: z.enum(["live", "stalled", "recent", "idle"]).optional(),
    liveOnly: z.boolean().optional(),
    limit: boundedNumericInput("board_snapshot", "limit"),
  }).passthrough(),
  list_flows: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    project: z.string().optional(),
    state: z.unknown().optional().describe("A flow state or array of states. Unknown values are ignored."),
    includeClosed: z.boolean().optional(),
    limit: boundedNumericInput("list_flows", "limit"),
    full: z.unknown().optional().describe("true returns complete records; defaults to compact rows."),
    compact: z.boolean().optional().describe("Compact by default; false restores complete records."),
    ids: z.unknown().optional().describe("Only these durable ids (array or comma-separated string)."),
    cursor: z.unknown().optional().describe("Pass nextCursor unchanged with the same filters. Invalid cursors restart with cursorReset:true."),
  }).passthrough(),
  get_flow: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    flowId: entityIdSchema,
  }).passthrough(),
  flow_action: z.object({
    clientRequestId: clientRequestIdSchema,
    flowId: entityIdSchema,
    action: z.enum(["pause", "resume", "set-mode", "advance", "retry-round", "cancel-round", "set-round-limit", "extend", "another-round", "set-roles", "close", "agent-decision"]),
    decision: z.enum(["submit-review", "continue-fixing", "stop", "completed"]).optional(),
    reason: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedHead: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    round: z.number().int().nonnegative().optional(),
    turnId: z.string().optional(),
    stage: z.object({ pipelineId: z.string(), stageId: z.string(), attempt: z.number().int().positive() }).optional(),
    mode: z.enum(["auto", "manual"]).optional(),
    rounds: z.number().int().min(0).max(50).optional(),
    note: z.string().optional(),
    roles: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  list_pipelines: z.object({
    statusOnly: z.boolean().optional().describe("true omits per-stage cards from compact rows; full:true and compact:false retain their detailed views."),
    includeHints: z.boolean().optional().describe("true includes the static readMore hint; full:true also includes it."),
    clientRequestId: clientRequestIdSchema.optional(),
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    project: z.string().optional(),
    state: z.unknown().optional()
      .describe("A pipeline state or array of states; open includes every state except completed and closed. Unknown values are ignored."),
    includeClosed: z.boolean().optional(),
    limit: boundedNumericInput("list_pipelines", "limit"),
    compact: z.boolean().optional()
      .describe("Compact by default; false restores the previous board-card projection. Each row is id, task (first line), state, cursor, stateDetail and per stage {id, latestAttempt: {n, state, verdict}}."),
    cursor: z.unknown().optional().describe("Pass nextCursor unchanged with the same filters and a fresh clientRequestId. Invalid cursors restart with cursorReset:true."),
    ids: z.unknown().optional().describe("Only these durable ids (array or comma-separated string). Unknown ids match no records."),
    query: z.string().optional().describe("Case-insensitive substring in task text/title."),
    updatedSince: z.unknown().optional().describe("Inclusive ISO timestamp. Invalid timestamps are ignored. Tasks use updatedAt; pipelines use createdAt."),
  }).passthrough(),
  conversation_action: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional()
      .describe("Durable Delegatus conversation id. Archive and unarchive actions expand it to every registered generation path."),
    transcriptPath: z.string().optional()
      .describe("Exact transcript or spawn:<launchId> board path. Archive and unarchive actions preserve it and add every generation of the resolved conversation."),
    selectedContext: selectedContextSchema,
    targets: z.array(conversationArchiveTargetSchema).min(1).max(100).optional()
      .describe("Archive/unarchive list form. Cannot be combined with the single-target fields."),
    action: z.enum(["interrupt", "kill", "resume", "compact", "dialog-key", "permission", "archive", "unarchive"]),
    key: z.enum(["1", "2", "3", "4", "5", "6", "7", "8", "9", "Tab", "Enter", "Escape"]).optional(),
    decision: z.enum(["allow", "deny"]).optional()
      .describe("permission only: allow once or deny the structured host's pending tool permission request."),
    requestId: z.string().optional()
      .describe("permission only: the request to answer, when the conversation holds more than one; defaults to the oldest."),
    label: z.string().optional(),
    question: z.string().optional(),
  }).passthrough(),
  /* #774: these nested objects were `z.record(z.string(), z.unknown())`, so the
     published schema said "any object" while `validateSnapshotRequest` admitted
     an exact key set — 119 calls in ten days were rejected for a guessed key the
     caller had no way to look up. `.strict()` keeps an unknown key a loud
     rejection; plain `z.object` would silently strip it, which trades a wrong
     answer for a wasted round trip. */
  operator_snapshot: z.object({
    clientRequestId: clientRequestIdSchema,
    schemaVersion: z.literal(1).optional(),
    view: z.object({
      id: snapshotStringSchema.optional(),
      deviceId: snapshotStringSchema.optional(),
      resolution: z.enum(VIEW_RESOLUTIONS).optional(),
    }).strict().optional(),
    scope: snapshotScopeSchema.optional(),
    text: z.object({
      include: z.boolean().optional(),
      lastMessages: boundedNumericInput("operator_snapshot", "text.lastMessages"),
      maxCharsPerConversation: boundedNumericInput("operator_snapshot", "text.maxCharsPerConversation"),
    }).strict().optional(),
    caller: z.object({
      pid: z.number().int().min(1).optional(),
      transcriptPath: snapshotStringSchema.optional(),
    }).strict().optional(),
  }).strict(),
  list_tasks: z.object({
    includeHints: z.boolean().optional().describe("true includes the static readMore hint; full:true also includes it."),
    clientRequestId: clientRequestIdSchema.optional(),
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    project: z.string().optional(),
    status: z.unknown().optional().describe("One status or an array: inbox, assigned, blocked, done. Unknown values are ignored."),
    statuses: z.unknown().optional().describe("Alias for a status set; takes precedence over status."),
    openOnly: z.unknown().optional().describe("true excludes done tasks."),
    compact: z.unknown().optional().describe("Compact by default. false restores the previous projection with truncated details; full:true includes all details."),
    placement: z.unknown().optional().describe("pinned or unplaced; unknown values are ignored."),
    priority: z.unknown().optional().describe("One priority or an array: high, normal, low. Unknown values are ignored. Compact rows carry priority only when it is not normal."),
    limit: boundedNumericInput("list_tasks", "limit"),
    cursor: z.unknown().optional().describe("Pass nextCursor unchanged with the same filters and a fresh clientRequestId. Invalid cursors restart with cursorReset:true."),
    ids: z.unknown().optional().describe("Only these durable ids (array or comma-separated string). Unknown ids match no records."),
    query: z.string().optional().describe("Case-insensitive substring in task text/title."),
    updatedSince: z.unknown().optional().describe("Inclusive ISO timestamp. Invalid timestamps are ignored. Tasks use updatedAt; pipelines use createdAt."),
  }).passthrough(),
  get_task: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    compact: z.unknown().optional().describe("true returns a compact task row; the default remains the complete record."),
    taskId: entityIdSchema,
  }).passthrough(),
  deployment_status: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    kind: z.literal("host-retirement").optional().describe("Read the latest bounded host retirement observations for your project; omit for deployment status."),
    callerLaunchId: z.string().min(1).max(256).optional().describe("Optional for host-retirement: resolved server-side from your session. An explicit launchId from your task assignment must belong to you. A designated seat needs no spawn receipt."),
    project: z.string().min(1).max(256).optional().describe("Required for host-retirement; must match the authenticated caller's project."),
    cursor: z.string().min(1).max(512).optional().describe("Opaque page cursor: host-retirement returns cursor; deployment lists return nextCursor. Pass unchanged with the same query and a fresh clientRequestId; stop when hasMore is false."),
    deploymentId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    limit: boundedNumericInput("deployment_status", "limit"),
    compact: z.boolean().optional()
      .describe("true: each deployment as {deploymentId, phase, sha, terminal, startedAt, finishedAt, error}."),
  }).passthrough(),
  resources: z.object({
    full: z.boolean().optional().describe("true includes every session row; default returns system/viewer and session memory totals with freshness."),
    compact: z.boolean().optional().describe("false restores the full session view."),
    clientRequestId: clientRequestIdSchema.optional(),
    fresh: z.boolean().optional(),
  }).passthrough(),
  conversation_migration: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().min(1),
    action: z.enum(["reseat", "select-account", "retry", "rollback", "cancel", "withdraw", "keep-current"]).describe("select-account: explicit browser account choice, requires accountId; preserves the current model and effort and records an out-of-pool choice with caller attribution. reseat: on a structured conversation, records the chosen account as the conversation's intended account (reseat: intended); it moves there when it is next engaged. keep-current: messages held by a failed account switch go out on the account the conversation runs on. cancel: a claimed switch still waiting for its turn, by expectedRevision; the migration is rolled back and the reconfigure that owned it never applies, and the same cancel again answers cancel: replayed. withdraw: a queued switch the queue has not claimed, by operationId; a claimed one is refused with code SWITCH_CLAIMED and expectedRevision, the revision to cancel it by once its migration exists (null before)."),
    accountId: z.string().trim().min(1).optional().describe("select-account only: exact account to select. Never substituted. reseat remains automatic and refuses account fields."),
    expectedRevision: z.number().int().min(0).optional().describe("The migration's revision: required by retry, rollback and cancel."),
    operationId: z.string().min(1).optional().describe("withdraw: the queued reconfigure operation."),
    transcriptPath: z.string().optional(),
  }).passthrough(),
  agent_activity: z.object({
    includeHints: z.boolean().optional().describe("true includes the static readMore hint; full:true also includes it."),
    clientRequestId: clientRequestIdSchema,
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    project: z.string().optional(),
    includeGone: z.unknown().optional().describe("true includes gone lifecycles and dead hosts even with liveOnly:true."),
    liveOnly: z.boolean().optional(),
    cursor: z.string().optional().describe("Opaque nextCursor for remaining rows of the same observed page; use the same filters and options."),
    stallAfterMs: boundedNumericInput("agent_activity", "stallAfterMs")
      .describe("Silence under a live host that counts as a stall. A dead host over an open turn is always stalled."),
    limit: boundedNumericInput("agent_activity", "limit"),
    compact: z.boolean().optional()
      .describe("Compact by default; false retains full evidence fields. Each conversation as {conversationId, title, turnState, lifecycle, silentForMs, stalledForMs, pipeline}, plus reason and permission when a tool permission request holds the turn."),
  }).passthrough(),
  lifecycle_events: z.object({
    clientRequestId: clientRequestIdSchema,
    mode: z.enum(["query", "digest"]).optional().describe('"query" reads the journal; "digest" polls the bounded relay.'),
    project: z.string().optional(),
    pipelineId: z.string().optional(),
    conversationId: z.string().optional(),
    stageId: z.string().optional(),
    type: z.string().optional(),
    afterSeq: boundedNumericInput("lifecycle_events", "afterSeq").describe("Exclusive journal cursor for mode=query. Values clamp at zero and invalid values default to zero."),
    limit: boundedNumericInput("lifecycle_events", "limit"),
    subscriberId: z.string().optional().describe("Durable digest cursor owner; required for mode=digest."),
    maxItems: boundedNumericInput("lifecycle_events", "maxItems"),
    acknowledge: z.boolean().optional().describe("false polls the digest without advancing the cursor."),
  }).passthrough(),
  request_attention: z.object({
    clientRequestId: clientRequestIdSchema,
    waitFor: z.enum(["arrived", "accepted"]).optional().describe("Default arrived waits for durable browser arrival. accepted returns after the durable handoff is recorded, with arrival pending."),
    target: focusTargetSchema,
    reason: z.string().min(1).describe("One operator-safe sentence saying why it is worth looking at. Never the target's contents."),
    intent: z.enum(["show", "open"]).optional().describe("show frames and highlights; open also opens the target's own surface. Default show."),
    zoom: z.enum(["inspect", "situate"]).optional(),
    contextLabel: z.string().optional().describe("Named in the spoken sentence but never navigated to."),
    project: z.string().optional().describe("Required only for a target the server cannot attribute on its own (a board draft)."),
  }).passthrough(),
  suggest_replies: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().min(1).optional()
      .describe("Durable conversation whose composer these drafts belong under. Defaults to the calling conversation, and must BE it \u2014 another conversation is refused."),
    replies: z.array(replyDraftSchema).min(MIN_REPLY_SUGGESTIONS).max(MAX_REPLY_SUGGESTIONS)
      .describe(`${MIN_REPLY_SUGGESTIONS}\u2013${MAX_REPLY_SUGGESTIONS} drafts, ordered as the operator should read them. Two to four distinct ones is the usual shape.`),
  }).passthrough(),
  dismiss_attention: z.object({
    clientRequestId: clientRequestIdSchema,
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("conversation"),
        conversationId: z.string().min(1).optional().describe('Durable "conversation_…" id. The form to prefer.'),
        reasonId: z.string().min(1).optional(),
        path: z.string().min(1).optional().describe("Transcript .jsonl path. Supply at least one of the two."),
      }).passthrough(),
      z.object({ kind: z.literal("pipeline"), pipelineId: z.string().min(1), laneMovedAt: z.number().nullable().optional() }).passthrough(),
      z.object({ kind: z.literal("task"), taskId: z.string().min(1).describe("Board task id: its assignments and the lanes filed under it.") }).passthrough(),
      z.object({ kind: z.literal("update"), decisionId: z.string().optional() }).passthrough(),
      z.object({ kind: z.literal("report"), seq: z.number().int().positive() }).passthrough(),
      z.object({ kind: z.literal("prototype"), taskId: z.string().min(1), reviewId: z.string().min(1) }).passthrough(),
    ]).optional().describe("What to clear; omit to read the project panel."),
    project: z.string().min(1).optional().describe("Read form; defaults to your seat or maintenance project."),
    kinds: z.array(z.enum(["decision", "question", "plan", "permission", "delivery", "launch", "memory", "ask", "lane-decision", "lane-review", "prototype", "update"])).optional(),
    full: z.boolean().optional(),
    cursor: z.string().optional(),
    reason: z.string().max(200).optional().describe("One line retained beside who cleared the row."),
    undo: z.boolean().optional().describe("true brings back what an earlier dismissal cleared."),
  }).passthrough(),
  bridge_report: z.object({
    clientRequestId: clientRequestIdSchema,
    key: z.string().min(1).describe("Stable identity of this report. The same key always yields one log entry, so a retry after a host death is a no-op."),
    class: z.enum(["status", "completed", "failed", "blocked", "review_verdict", "question"]),
    summary: z.string().optional().describe("One line, at most 120 characters: what is now true, or the ask on blocked and question. In the operator's interface language."),
    sections: z.object({
      prod: z.array(z.string()).optional().describe("What reached production."),
      merged: z.array(z.string()).optional().describe("Merged, goes out with the next deploy."),
      inProgress: z.array(z.string()).optional().describe("What is running, a failure being retried included."),
      queued: z.array(z.string()).optional().describe("What starts next."),
      decision: z.array(z.string()).optional().describe("What the operator has to answer or do; at most 3."),
    }).partial().optional().describe("Short items, each one or two plain sentences of at most 200 characters."),
    covers: z.array(z.string().min(1)).optional().describe("Keys of further outcomes this report speaks for."),
    coversOwed: z.boolean().optional().describe("true settles every outcome the seat tick owed whose wake reached you before this report."),
    body: z.string().optional().describe("Older free-text form, filed as one in-progress item per line. Prefer summary and sections."),
    correlatesDirective: z.string().optional().describe("clientRequestId of the directive this answers."),
  }).passthrough(),
  bridge_directive: z.object({
    clientRequestId: clientRequestIdSchema,
    rootTurnId: z.string().regex(/^[A-Za-z0-9_.:-]+$/).describe("The realtime turn this instruction came from. The delivery id derives from it, so a retry must reuse the same value."),
    utterance: z.number().int().min(0).describe("Index of this instruction within that turn, from 0."),
    instruction: z.string().min(1).describe("What the user asked for, in plain words. No board state, no tool output."),
    project: z.string().optional().describe("Route to THIS project's designated orchestrator (validated seat). Absent: routes to the orchestrator of the calling voice session's own canonical project."),
    ref: z.number().int().positive().optional().describe("seq of the report this answers, when it answers one."),
  }).passthrough(),
  get_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    project: z.string().min(1).describe("Project key whose designated orchestrator to report on."),
    full: z.boolean().optional().describe("Compact by default: the seat without its mandate and role table, and counts for intentHistory and lineage. true returns every record whole."),
  }).passthrough(),
  create_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project key this orchestrator will own."),
    conversationId: z.string().regex(/^conversation_/).optional().describe("Existing registered conversation to adopt. Delegatus validates its project, cwd, transcript, lifecycle, and operator authority before seating it."),
    mandate: z.string().optional().describe("Edited mandate text; defaults to the approved versioned orchestrator prompt."),
    cwd: z.string().optional().describe("Working directory; defaults to Delegatus's own checkout."),
    engine: z.enum(["claude", "codex"]).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    accountId: z.string().optional(),
  }).passthrough(),
  send_message_to_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    recoveryOnly: recoveryOnlySchema,
    project: z.string().min(1).describe("Project whose selected orchestrator receives the message."),
    text: z.string().min(1).describe("The message. The recipient is resolved server-side; a dead session is resumed, a missing one created first."),
  }).passthrough(),
  ask_orchestrator_in_parallel: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project whose busy orchestrator seat takes the side ask in parallel."),
    text: z.string().min(1).describe("The side ask, exactly as the operator gave it."),
  }).passthrough(),
  rotate_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project whose orchestrator seat rotates to a fresh successor."),
    mandate: z.string().optional().describe("Successor mandate. Omitted: the incumbent's own mandate when it is based on the current default version or is bespoke; the current built-in default when the incumbent's is based on an older version (get_orchestrator reports both versions)."),
    keepIncumbentMandate: z.boolean().optional().describe("Carry the incumbent's mandate forward even when it is based on an older default version. Ignored when mandate is given."),
    handoffNotes: z.string().optional().describe("Bounded free-text handoff notes appended for the successor."),
    cwd: z.string().optional(),
    engine: z.enum(["claude", "codex"]).optional(),
    model: z.string().optional(),
    effort: z.string().optional().describe("Reasoning effort for the successor; round-trips into its spawn like create_orchestrator's."),
    accountId: z.string().optional(),
  }).passthrough(),
  account_project_binding: z.object({
    clientRequestId: clientRequestIdSchema,
    action: z.enum(["list", "add", "remove"]).optional()
      .describe("list (default) reads the whole record; add and remove change it and answer with the changed row read back."),
    engine: z.enum(["claude", "codex"]).optional()
      .describe("Engine the account belongs to. Required to add or remove."),
    accountId: z.string().trim().min(1).optional()
      .describe("Account to allow on, or stop allowing on, the project. Required to add or remove."),
    project: z.string().trim().min(1).optional()
      .describe("Project whose allowed set to read or change. Defaults to your own on a list; required to add or remove."),
  }).passthrough(),
  seat_tick_settings: z.object({
    maintenance: z.object({ enabled: z.boolean().optional(), intervalHours: z.union([z.number(), z.string()]).nullable().optional() }).optional()
      .describe("Board maintenance (#2162): one built-in agent on the seat tick, off until enabled. intervalHours is the minimum gap (1–168, default 3; null restores 3). Needs no reason."),
    clientRequestId: clientRequestIdSchema,
    full: z.unknown().optional().describe("true returns the full record; default answers omit large bodies and name the detail read."),
    project: z.string().trim().min(1).optional()
      .describe("Project whose tick to read or change. Defaults to your own; another project's is allowed and is recorded as such."),
    enabled: z.boolean().optional()
      .describe("false stops every wake for that project until it is turned back on. There is no expiry unless untilMinutes gives one."),
    wakeIntervalMinutes: z.number().positive().nullable().optional()
      .describe("Minutes between wakes for that project; null restores the default hour."),
    untilMinutes: z.number().positive().nullable().optional()
      .describe("Optional expiry, in minutes from now, after which the on/off and cadence setting lapses back to the default. It preserves the operator instructions and monitor prompt. Omit for a setting that stands until it is changed."),
    reason: z.string().trim().min(1).nullable().optional()
      .describe("Instructions the agent receives in full on every wake: what to do next and when to stop. Also the board card’s cadence explanation, required off the default schedule. Preserved on schedule reset and expiry; null clears at the default cadence. Over 500 characters is refused without truncation."),
    monitorPrompt: z.string().trim().min(1).nullable().optional()
      .describe("Your own additional prompt for this project's monitor: what every later scheduler-fired wake should look at, appended to the reasons and items the tick derives. Send a new one to replace it, null to clear it. Redacted before it is stored; refused, not truncated, when over the limit. It never changes whether or when a wake is sent, and needs no reason."),
    replaceLine: z.object({
      prefix: z.string().min(1).optional().describe("Replace the one note line starting with this text (leading spaces ignored). More or fewer than one match is refused."),
      index: z.number().int().min(0).optional().describe("Or the zero-based line number; given with prefix, that line must start with it."),
      text: z.string().describe("The new line."),
    }).optional().describe("Replace one line of the stored note without resending the rest."),
    removeLine: z.object({
      prefix: z.string().min(1).optional().describe("Remove the one note line starting with this text (leading spaces ignored)."),
      index: z.number().int().min(0).optional().describe("Or the zero-based line number; given with prefix, that line must start with it."),
    }).optional().describe("Remove one line of the stored note."),
    appendLine: z.string().min(1).optional()
      .describe("Append one line to the stored note. Edits apply in the order replaceLine, removeLine, appendLine, under the monitorPrompt limit and redaction; not combined with monitorPrompt."),
    verbose: z.boolean().optional()
      .describe("true: return the stored note once, as monitorPrompt, with the full settings. Every answer carries monitorPromptLength."),
  }).passthrough(),
  role_presets: z.object({
    clientRequestId: clientRequestIdSchema,
    overrides: z.record(z.string(), z.object({
      config: z.object({ engine: z.string(), model: z.string(), effort: z.string(), serviceTier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional() }).nullable().optional()
        .describe("A full { engine, model, effort } sets the role's row; null resets it to the shipped default."),
      variants: z.record(z.string(), z.object({ engine: z.string(), model: z.string(), effort: z.string(), serviceTier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional() }).nullable()).optional()
        .describe("Builder and reviewer only, keyed by variant (trivial, frontend, docs, apply-fixes, frontend-fixes, docs-fixes; reviewer: trivial). A full config sets the variant, null resets it."),
      promptScaffold: z.null().optional().describe("null restores the shipped prompt text. A scaffold cannot be set from here."),
    }).passthrough()).optional()
      .describe("The mapping change, keyed by role id. Omit to read the registry. Engine and model must be in the launch catalogue and the effort valid for them, or the whole write is refused."),
    expectedRevision: z.string().trim().min(1).optional()
      .describe("The registry revision this change was made against; a stale one is refused with the current registry. Only with overrides."),
    detail: z.boolean().optional()
      .describe("true: a read also carries each role's shipped values, whether its prompt is overridden, and the launch choices. Ignored with overrides."),
  }).passthrough(),
  auto_updates: z.object({
    clientRequestId: clientRequestIdSchema,
    enabled: z.boolean().optional()
      .describe("true turns automatic updates on, false turns them off. Omit to read the state."),
  }).passthrough(),
  account_limits: z.object({
    clientRequestId: clientRequestIdSchema.optional(),
    engine: z.enum(["claude", "codex", "copilot"]).optional().describe("Only this engine's accounts."),
    accountId: z.string().trim().min(1).optional().describe("Only this account."),
  }).passthrough(),
  issue_report: z.object({
    clientRequestId: clientRequestIdSchema,
    action: z.enum(["hints", "preview", "show", "publish"]).describe("hints: advisory pointers without storage. preview: store text and agent judgment. show: read a preview back. publish: file an approved preview."),
    title: z.string().optional().describe("preview only: the issue title, one line."),
    body: z.string().optional().describe("preview only: the issue body in the repository's issue style: symptom, observed evidence, impact, expected behaviour, suggested investigation."),
    privacyJudgment: z.object({
      assessment: z.string().trim().min(1).max(3000),
      removed: z.string().trim().min(1).max(3000),
      harmlessHints: z.string().trim().min(1).max(3000),
      uncertainties: z.string().trim().min(1).max(3000),
    }).optional().describe("preview: your own judgment after reading the whole text, what you removed, hints judged harmless and why, and uncertainties."),
    digest: z.string().regex(/^[0-9a-f]{64}$/).optional().describe("show and publish: the digest a preview answered."),
  }).passthrough(),
  telegram_bot_chats: z.object({
    clientRequestId: clientRequestIdSchema,
    includeInactive: z.boolean().optional().describe("Also list chats the bot left or was removed from. Default false."),
  }).passthrough(),
  telegram_bot_send: z.object({
    clientRequestId: clientRequestIdSchema,
    chat: z.string().trim().min(1).describe("The chat's alias, id, @username or t.me chat/topic link."),
    text: z.string().min(1).describe("The message. Plain text up to 16384 characters (split into up to 4 messages); html up to 4096."),
    format: z.enum(["plain", "html"]).optional().describe("plain (default) or html: Telegram's HTML subset."),
    replyToMessageId: z.number().int().positive().optional().describe("Reply to this message in the same chat. Sent anyway if it no longer exists."),
    topicId: z.number().int().positive().optional().describe("Forum topic (message_thread_id) to post into."),
    silent: z.boolean().optional().describe("Send without a notification sound."),
  }).passthrough(),
  telegram_bot_send_media: z.object({
    clientRequestId: clientRequestIdSchema,
    chat: z.string().trim().min(1).describe("The allowlisted chat's alias, id, @username or t.me chat/topic link."),
    images: z.array(z.object({
      path: z.string().min(1).describe("Absolute JPEG or PNG path on the Viewer host, under a document root (by default handoff/ in the Viewer host's home)."),
      caption: z.string().max(1024).describe("Caption for this image, up to 1024 characters."),
    })).min(1).max(10).describe("One image sends sendPhoto; 2–10 images send one album."),
    format: z.enum(["plain", "html"]).optional().describe("Caption format; plain by default."),
    replyToMessageId: z.number().int().positive().optional(),
    topicId: z.number().int().positive().optional(),
    silent: z.boolean().optional(),
  }).passthrough(),
  telegram_bot_send_document: z.object({
    clientRequestId: clientRequestIdSchema,
    chat: z.string().trim().min(1).describe("The allowlisted chat's alias, id, @username or t.me chat/topic link."),
    document: z.object({
      path: z.string().min(1).describe("Absolute path on the Viewer host, under a document root (by default handoff/ in the Viewer host's home)."),
      filename: z.string().min(1).max(255).optional().describe("The name the chat shows; defaults to the file's own name. Must keep an allowed extension."),
      caption: z.string().max(1024).optional().describe("Caption, up to 1024 characters."),
    }).describe("The file to post as a document."),
    format: z.enum(["plain", "html"]).optional().describe("Caption format; plain by default."),
    replyToMessageId: z.number().int().positive().optional(),
    topicId: z.number().int().positive().optional().describe("Forum topic (message_thread_id) to post into."),
    silent: z.boolean().optional().describe("Send without a notification sound."),
  }).passthrough(),
  telegram_bot_messages: z.object({
    clientRequestId: clientRequestIdSchema,
    chat: z.string().trim().min(1).describe("The chat's alias or chat id, as telegram_bot_chats lists it."),
    limit: boundedNumericInput("telegram_bot_messages", "limit"),
    cursor: z.string().optional().describe("nextCursor from the previous page."),
    since: z.string().optional().describe("ISO time; only messages at or after it."),
    maxChars: boundedNumericInput("telegram_bot_messages", "maxChars"),
  }).passthrough(),
};

/**
 * The sentence the session instructions carry about the operator's interface
 * language (docs/design/orchestrator-reports.md §4.2), composed when the
 * session starts, so every spawned agent reads it before its first `refine`.
 * Empty while no client has reported a language.
 */
export function operatorLanguageInstruction(locale: "en" | "uk" | null = readOperatorLocale()): string {
  if (!locale) return "";
  const language = locale === "uk" ? "Ukrainian" : "English";
  return ` The operator's interface language is ${language}: write board task text (create_task and update_task text, refine) and bridge reports in ${language}. Chat replies follow the language the operator writes to you in; task details, prompts and GitHub stay as they are.`;
}

function readOperatorLocale(): "en" | "uk" | null {
  try {
    return operatorLocale();
  } catch {
    return null;
  }
}

export function viewerMcpInstructions(locale?: "en" | "uk" | null): string {
  return `${VIEWER_MCP_BASE_INSTRUCTIONS}${operatorLanguageInstruction(locale === undefined ? readOperatorLocale() : locale)}`;
}

const VIEWER_MCP_BASE_INSTRUCTIONS = "This server is Delegatus, registered under the MCP key `viewer`, so its tools are named mcp__viewer__*. List tasks newest-first with status sets, openOnly, ids or query and follow nextCursor. Lists are compact by default; full:true retrieves complete records; get_pipeline is compact by default. Use get_task/get_flow for complete records. Writes acknowledge changedFields and revision. Use seat_tick_settings verbose:true to read the complete monitor note. Use clientRequestId on mutations; pure reads may omit it for a fresh observation. Static readMore hints require includeHints:true or full:true. Reuse it only when replaying the same logical operation. If your conversation was launched onto a board task that still carries its placeholder title, make your first Delegatus action update_task with refine: { text } — a short human title (3–10 words) on the first line and at most two concise sentences, describing the work you were given. Pipeline stages and read-only roles skip this: the orchestrator names their tasks. A refine that answers TASK_NOT_FOUND means your conversation holds no task; carry on. Keep an existing meaningful title; the reply says already-named when one exists. Reuse the same text on retry. A task's text is for the human who reviews the board, and refine writes only that; agent-facing context (the prompt, the working notes, the ids, the rules, the state) belongs in the separate details field of create_task and update_task, condensed, which the card shows behind one collapsed Details row. Read the board through these tools rather than curl: list_pipelines with state `open` and compact: true for the open lanes, get_pipeline with stageId for one stage's conclusion, deployment_status and agent_activity with compact: true, and account_limits for each account's usage windows.";

export function createViewerMcpServer(service: McpToolService): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, {
    instructions: viewerMcpInstructions(),
  });
  for (const toolName of MCP_TOOL_NAMES) {
    const taskMutation = toolName === "create_task" || toolName === "update_task";
    const schema = TOOL_INPUT_SCHEMAS[toolName];
    // The SDK's default validation error has no retryability or field envelope.
    // Preserve the published input shape, but carry invalid optional task fields through
    // to our strict validation below, before dispatch or receipt acquisition.
    const inputSchema = taskMutation ? schema.extend(Object.fromEntries(
      Object.entries(schema.shape).filter(([, fieldSchema]) => fieldSchema.isOptional())
        .map(([field, fieldSchema]) => [field, fieldSchema.catch((context: { input: unknown } | undefined) => context?.input)]),
    )) : schema;
    server.registerTool(toolName, {
      description: TOOL_DESCRIPTIONS[toolName],
      inputSchema,
    }, async (args, extra) => {
      if (taskMutation) {
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          const issues = parsed.error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message }));
          const result = failure(toolName, String((args as McpToolArgs).clientRequestId), "TASK_INVALID_FIELD",
            issues.map(issue => `${issue.field}: ${issue.message}`).join("; "), false, false,
            { field: issues[0]?.field, issues });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
        }
      }
      /* A call over the shared HTTP endpoint names its caller by the
         capability the route authenticated; it runs as that caller so every
         resolver reads the request's identity rather than this process's. */
      const httpCaller = mcpHttpCallerFromAuthInfo((extra as { authInfo?: unknown }).authInfo);
      const timeoutMs = 30_000;
      const deadline = deadlineSignal(timeoutMs, {
        /* Over stdio a client's cancel reaches `extra.signal`. Over the
           stateless HTTP endpoint it arrives on a later POST, to another
           server, so the route hands over a signal of its own for this call:
           aborted by that cancel, or by the client walking away. */
        signal: (() => {
          const cancelled = httpCaller?.cancelSignal(extra.requestId) ?? null;
          return cancelled ? AbortSignal.any([extra.signal, cancelled]) : extra.signal;
        })(),
        reason: "MCP tool deadline exceeded",
      });
      try {
        const call = () => service.callTool(toolName, args as McpToolArgs, {
          signal: deadline.signal,
          deadlineAt: Date.now() + timeoutMs,
          /* #1629: the SDK hands the request's own `_meta` through on `extra`,
             which is the only place native work identity exists — the model
             never sees it and its arguments travel in a different namespace.
             Forwarded as context so a voice-selected card can be resolved for
             the turn that actually asked, rather than for whatever the
             conversation last pointed at. */
          nativeWork: nativeWorkFromRequestMeta((extra as { _meta?: unknown })._meta),
        });
        const result = await (httpCaller ? runAsMcpHttpCaller({ capability: httpCaller.capability }, call) : call());
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
          ...(result.ok ? {} : { isError: true }),
        };
      } finally {
        deadline.release();
      }
    });
  }
  return server;
}

/** The `authInfo.clientId` the HTTP route stamps on an authenticated request. */
export const MCP_HTTP_CLIENT_ID = "llv-spawn-capability";

/** The authenticated HTTP caller the route attached to this request, or null
    for a request that did not come through it (every stdio call). */
function mcpHttpCallerFromAuthInfo(authInfo: unknown): (McpHttpCaller & { cancelSignal: (requestId: unknown) => AbortSignal | null }) | null {
  if (!authInfo || typeof authInfo !== "object") return null;
  const { clientId, token, extra } = authInfo as { clientId?: unknown; token?: unknown; extra?: { cancelSignal?: unknown } };
  if (clientId !== MCP_HTTP_CLIENT_ID || typeof token !== "string" || !token) return null;
  const lookup = typeof extra?.cancelSignal === "function" ? extra.cancelSignal as (requestId: unknown) => unknown : null;
  return {
    capability: token,
    cancelSignal: (requestId) => {
      const signal = lookup?.(requestId);
      return signal instanceof AbortSignal ? signal : null;
    },
  };
}

/**
 * The production tool service: bindings, the shared SQLite receipt store every
 * Viewer MCP server writes (so a clientRequestId replays the same way whichever
 * process or transport it arrives on), the per-call policy, and recovery.
 */
export async function createProductionViewerMcpService(hostHealthProbe = false): Promise<McpToolService> {
  const {
    productionViewerControlDependencies,
    viewerMcpBindings,
    viewerMcpRecoverableTools,
    viewerMcpToolPolicy,
  } = await import("./bindings");
  const controlDependencies = productionViewerControlDependencies(hostHealthProbe);
  return createMcpToolService(
    viewerMcpBindings(undefined, controlDependencies),
    new SqliteMcpReceiptStore(statePath("mcp-receipts.sqlite"), {
      legacyFilePath: statePath("mcp-receipts.json"),
    }),
    viewerMcpToolPolicy(undefined, hostHealthProbe),
    { timings: productionMcpToolTimings, recovery: viewerMcpRecoverableTools() },
  );
}

export async function startViewerMcpServer(): Promise<void> {
  const { admittedMcpHealthProbe, MCP_HEALTH_PROBE_CAPABILITY_ENV } = await import("./healthProbeAdmission");
  const healthProbeCapability = process.env[MCP_HEALTH_PROBE_CAPABILITY_ENV];
  delete process.env[MCP_HEALTH_PROBE_CAPABILITY_ENV];
  const hostHealthProbe = await admittedMcpHealthProbe(healthProbeCapability);
  const service = await createProductionViewerMcpService(hostHealthProbe);
  const server = createViewerMcpServer(service);
  const transport = new StdioServerTransport();
  // The SDK does not close its transport on EOF. A dead client (including a
  // killed launcher) must not leave domain timers or in-flight reads resident.
  // This entry point owns a dedicated stdio process, never the Viewer server.
  process.stdin.once("end", () => {
    setTimeout(() => process.exit(0), 1_000);
    void server.close().then(
      () => process.exit(0),
      (error: unknown) => { console.error("MCP shutdown failed", error); process.exit(1); },
    );
  });
  await server.connect(transport);
}
