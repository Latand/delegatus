import type { Database as BunDatabase } from "bun:sqlite";

import { MCP_OPERATION_TOOLS, isMcpOperationTool, type McpOperationCaller, type McpOperationTool } from "./receiptsDatabase";

/**
 * The read-only operations feed (#1695 C5): what `create_pipeline` and
 * `update_task` calls did, read from the MCP receipt rows that already decide
 * their idempotency. Nothing here claims, settles, replays or rewrites a
 * receipt, and no arguments or result bodies leave this module.
 */

export const MCP_OPERATIONS_MAX_LIMIT = 50;

/** A claim with no result stays pending for this long. The tool call deadline
    is 30 s; a claim still unanswered after four of them has most likely lost
    its process, and nothing can prove it did not, so it reads unknown. */
export const MCP_OPERATION_PENDING_LEASE_MS = 120_000;

const MAX_REFUSAL_CHARS = 200;

export type McpOperationState = "pending" | "accepted" | "failed" | "unknown";

export interface McpOperation {
  /** The receipt row's sequence; the feed's order and cursor. */
  sequence: number;
  tool: McpOperationTool;
  /** The receipt digest. `Pipeline.creationReceipt.requestDigest` carries the same value. */
  requestDigest: string;
  state: McpOperationState;
  claimedAt: string;
  callerConversationId: string | null;
  callerProject: string | null;
  /** The target's project once the result names it. */
  project: string | null;
  pipelineId?: string;
  taskId?: string;
  /** The recorded refusal, shortened; only on `failed`. */
  refusal: string | null;
}

export interface McpOperationsPage {
  operations: McpOperation[];
  /** Pass back unchanged. A pending row holds it, so that row is answered
      again until it settles or turns unknown. */
  after: number;
  /** More matching rows follow `after`. */
  hasMore: boolean;
}

export interface McpOperationsRequest {
  project: string;
  /** Rows after this sequence; null reads the newest rows. */
  after: number | null;
  limit: number;
}

export interface McpOperationsOptions {
  now?: number;
  /** The pipeline stamped with this creation digest (C8), if any. */
  pipelineForDigest?: (digest: string) => { id: string; project: string } | null;
}

type ReceiptRow = {
  sequence: number;
  receipt_key: string;
  digest: string;
  result_json: string | null;
  claimed_at: number;
  caller_json: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseJson(serialized: string | null): unknown {
  if (serialized === null) return null;
  try {
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function callerOf(serialized: string | null): McpOperationCaller | null {
  const caller = record(parseJson(serialized));
  if (!caller || !["root", "worker", "unidentified"].includes(String(caller.kind))) return null;
  return {
    kind: caller.kind as McpOperationCaller["kind"],
    conversationId: text(caller.conversationId),
    project: text(caller.project),
  };
}

/** Target identity named by an accepted result, without copying the body. */
function targetOf(tool: McpOperationTool, result: Record<string, unknown>): { project: string | null; pipelineId?: string; taskId?: string } {
  if (tool === "create_pipeline") {
    const pipeline = record(result.pipeline);
    const pipelineId = text(result.pipelineId) ?? text(pipeline?.id);
    return { project: text(pipeline?.project), ...(pipelineId ? { pipelineId } : {}) };
  }
  const task = record(result.task) ?? record(Array.isArray(result.tasks) ? result.tasks[0] : null);
  const taskId = text(result.taskId) ?? text(task?.id);
  return { project: text(task?.project), ...(taskId ? { taskId } : {}) };
}

function operationOf(row: ReceiptRow, now: number, options: McpOperationsOptions): McpOperation | null {
  const tool = row.receipt_key.slice(0, row.receipt_key.indexOf(":"));
  if (!isMcpOperationTool(tool)) return null;
  const caller = callerOf(row.caller_json);
  const base = {
    sequence: row.sequence,
    tool,
    requestDigest: row.digest,
    claimedAt: new Date(row.claimed_at).toISOString(),
    callerConversationId: caller?.conversationId ?? null,
    callerProject: caller?.project ?? null,
  };
  /* The durable pipeline outranks the receipt: a card stamped with this
     digest exists, whatever the row managed to record. */
  const receipted = tool === "create_pipeline" ? options.pipelineForDigest?.(row.digest) ?? null : null;
  if (receipted) return { ...base, state: "accepted", project: receipted.project, pipelineId: receipted.id, refusal: null };
  if (row.result_json === null) {
    const state = now - row.claimed_at <= MCP_OPERATION_PENDING_LEASE_MS ? "pending" : "unknown";
    return { ...base, state, project: null, refusal: null };
  }
  const result = record(parseJson(row.result_json));
  if (result?.ok === true) return { ...base, state: "accepted", ...targetOf(tool, result), refusal: null };
  if (result?.ok === false) {
    const error = text(result.error) ?? "refused";
    const refusal = error.length > MAX_REFUSAL_CHARS ? `${error.slice(0, MAX_REFUSAL_CHARS - 1)}…` : error;
    return { ...base, state: "failed", project: null, refusal };
  }
  return { ...base, state: "unknown", project: null, refusal: null };
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(MCP_OPERATIONS_MAX_LIMIT, Math.max(1, Math.floor(limit))) : MCP_OPERATIONS_MAX_LIMIT;
}

/**
 * One page of a project's operations, ascending by sequence. A row belongs to
 * the project when its recorded caller or its result's target is in it.
 */
export function readMcpOperations(
  db: BunDatabase | null,
  request: McpOperationsRequest,
  options: McpOperationsOptions = {},
): McpOperationsPage {
  if (!db) return { operations: [], after: request.after ?? 0, hasMore: false };
  const limit = clampLimit(request.limit);
  const now = options.now ?? Date.now();
  const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(mcp_receipts)").all().map((column) => column.name));
  if (!columns.size) return { operations: [], after: request.after ?? 0, hasMore: false };
  /* A database no MCP process has migrated yet has no caller column. */
  const callerColumn = columns.has("caller_json") ? "caller_json" : "NULL";
  const toolFilter = MCP_OPERATION_TOOLS.map(() => "receipt_key LIKE ? ESCAPE '\\'").join(" OR ");
  const toolPatterns = MCP_OPERATION_TOOLS.map((tool) => `${tool.replaceAll("_", "\\_")}:%`);
  /* CASE guards json_extract, so one malformed row cannot fail the page. */
  const projectFilter = `
    (CASE WHEN json_valid(${callerColumn}) THEN json_extract(${callerColumn}, '$.project') END) = ?
    OR (CASE WHEN json_valid(result_json) THEN coalesce(
      json_extract(result_json, '$.pipeline.project'),
      json_extract(result_json, '$.task.project'),
      json_extract(result_json, '$.tasks[0].project')
    ) END) = ?`;
  const select = `SELECT sequence, receipt_key, digest, result_json, claimed_at, ${callerColumn} AS caller_json FROM mcp_receipts`;
  const filters = [...toolPatterns, request.project, request.project];
  return db.transaction(() => {
    const maxSequence = db.query<{ sequence: number | null }, []>("SELECT MAX(sequence) AS sequence FROM mcp_receipts").get()?.sequence ?? 0;
    let rows: ReceiptRow[];
    let hasMore = false;
    if (request.after === null) {
      rows = db.query<ReceiptRow, (string | number)[]>(`${select} WHERE (${toolFilter}) AND (${projectFilter}) ORDER BY sequence DESC LIMIT ?`)
        .all(...filters, limit)
        .reverse();
    } else {
      rows = db.query<ReceiptRow, (string | number)[]>(`${select} WHERE sequence > ? AND (${toolFilter}) AND (${projectFilter}) ORDER BY sequence ASC LIMIT ?`)
        .all(request.after, ...filters, limit + 1);
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
    }
    const operations = rows.map((row) => operationOf(row, now, options)).filter((operation): operation is McpOperation => operation !== null);
    const considered = hasMore ? rows.at(-1)!.sequence : Math.max(maxSequence, request.after ?? 0);
    const pending = operations.find((operation) => operation.state === "pending");
    return { operations, after: pending ? Math.min(pending.sequence - 1, considered) : considered, hasMore };
  })();
}
