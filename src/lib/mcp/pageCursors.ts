import { createHash, randomBytes } from "node:crypto";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { currentMcpHttpCaller } from "./callerContext";
import type { McpToolArgs, McpToolResult, McpToolService } from "./server";

export const MCP_CURSOR_TTL_MS = 300_000;
export const MCP_CURSOR_MAX_ENTRIES = 2048;
export const MCP_CURSOR_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_PAGE_CURSOR_TOOLS = new Set([
  "list_conversations", "search_transcripts", "conversation_messages", "list_flows", "list_pipelines", "list_tasks",
  "deployment_status", "agent_fleet", "agent_activity", "dismiss_attention", "curate_rules",
  "telegram_bot_messages", "relay_owner_history", "relay_service_tools",
]);
export const MCP_PAGE_CURSOR_DESCRIPTION = "Page cursors are opaque 22-character handles, bound to this tool, caller and query/options. They expire after five minutes or eviction; a serving-process restart invalidates them. cursorReset:true means restart without cursor.";
export const MCP_PAGE_CURSOR_RAW_RELAY_RESULTS: unique symbol = Symbol.for("delegatus.mcp.pageCursors.rawRelayResults") as never;

type Held = { key: string; scope: string; state: string; expires: number; bytes: number };

/** Process-local, immutable continuations. Reads never extend the TTL or FIFO order. */
export class McpPageCursorStore {
  private entries = new Map<string, Held>();
  private keys = new Map<string, string>();
  private bytes = 0;

  constructor(private options: { now?: () => number; maxEntries?: number; maxBytes?: number; token?: () => string } = {}) {}

  private now() { return (this.options.now ?? Date.now)(); }
  private remove(handle: string) {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(handle);
    this.keys.delete(entry.key);
  }

  resolve(handle: unknown, scope: string): string | null {
    if (typeof handle !== "string" || handle.length !== 22 || !/^[A-Za-z0-9_-]{22}$/.test(handle)) return null;
    const entry = this.entries.get(handle);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.remove(handle); return null; }
    return entry.scope === scope ? entry.state : null;
  }

  issue(scope: string, state: string): string | null {
    const key = hash([scope, state]);
    const previous = this.keys.get(key);
    if (previous && this.resolve(previous, scope) !== null) return previous;
    const bytes = Buffer.byteLength(scope) + Buffer.byteLength(state) + 256;
    const maxBytes = this.options.maxBytes ?? MCP_CURSOR_MAX_BYTES;
    const maxEntries = this.options.maxEntries ?? MCP_CURSOR_MAX_ENTRIES;
    if (bytes > maxBytes || maxEntries < 1) return null;
    while (this.entries.size && (this.entries.size >= maxEntries || this.bytes + bytes > maxBytes)) {
      this.remove(this.entries.keys().next().value!);
    }
    let handle: string;
    do { handle = this.options.token?.() ?? randomBytes(16).toString("base64url"); } while (this.entries.has(handle));
    this.entries.set(handle, { key, scope, state, expires: this.now() + MCP_CURSOR_TTL_MS, bytes });
    this.keys.set(key, handle);
    this.bytes += bytes;
    return handle;
  }
}

const STORE_KEY = Symbol.for("delegatus.mcp.pageCursors");
export function mcpPageCursorStore(): McpPageCursorStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: McpPageCursorStore };
  return holder[STORE_KEY] ??= new McpPageCursorStore();
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function filters(args: McpToolArgs) {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !["cursor", "clientRequestId", "nativeCallerProof"].includes(key)));
}
export function mcpPageCursorCaller(): string | null {
  const caller = currentMcpHttpCaller();
  if (caller) return caller.capability ? hash(["capability", caller.capability])
    : caller.nativePeer?.startIdentity && caller.nativePeer.bootEpoch ? hash(["native", caller.nativePeer])
      : hash(["unidentified-http-adapter", caller.paginationIdentity ?? "compatibility"]);
  // Candidate probes and local stdio services have one caller per process.
  return hash(["local", process.pid, process.env.LLV_SPAWN_CAPABILITY ?? null]);
}

const RECEIPT_OWNER = "__mcpPageCaller";
const ownerStamp = (caller: string | null) => caller === null ? null : `caller:${caller}`;
function hasPageCursor(result: Record<string, unknown>): boolean {
  return [result.cursor, result.nextCursor].some(value => typeof value === "string" && value.length > 0)
    || (Array.isArray(result.results) && result.results.some(row => record(row) && (row.next_cursor || row.page_of)));
}

/** Keep existing receipt keys, including durable mutations from earlier releases.
 * Only the caller who produced a saved continuation may receive a handle for it. */
export function bindMcpPageCursorResult(tool: string, result: McpToolResult, caller: string | null): McpToolResult {
  return MCP_PAGE_CURSOR_TOOLS.has(tool) && result.ok && hasPageCursor(result)
    ? { ...result, [RECEIPT_OWNER]: ownerStamp(caller) } : result;
}

type Continuation = { filters: Record<string, unknown>; cursor: string };
function continuation(store: McpPageCursorStore, handle: unknown, scope: string, caller: string | null): Continuation | null {
  const state = caller === null ? null : store.resolve(handle, scope);
  return state === null ? null : JSON.parse(state) as Continuation;
}
function matches(current: Record<string, unknown>, previous: Record<string, unknown>, partial = false) {
  return partial ? Object.entries(current).every(([key, value]) => canonical(value) === canonical(previous[key]))
    : canonical(current) === canonical(previous);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function withoutCursor(args: McpToolArgs): McpToolArgs {
  const { cursor: _cursor, ...rest } = args;
  return rest;
}

async function restartPage(service: McpToolService, toolName: string, args: McpToolArgs, context?: Parameters<McpToolService["callTool"]>[2]): Promise<McpToolResult> {
  const fresh = await service.callTool(toolName, withoutCursor(args), context);
  return fresh.ok ? { ...fresh, cursorReset: true } : fresh;
}

function invalidInput(toolName: string, args: McpToolArgs): McpToolResult {
  return { ok: false, toolName, clientRequestId: typeof args.clientRequestId === "string" ? args.clientRequestId : null,
    replayed: false, cursorReset: true, code: "cursor_reset", retryable: true,
    error: "Page cursor expired or does not match this caller, tool or filters; restart without cursor." };
}

/** Wrap outside receipts: a saved result holds upstream state, never durable handles.
 * Resolve before resuming so rejected handles expose no held continuation. */
export function withMcpPageCursors(service: McpToolService, store = mcpPageCursorStore()): McpToolService {
  const wrapped: McpToolService = { callTool: (toolName, args, context) => {
    if (!MCP_PAGE_CURSOR_TOOLS.has(toolName)) return service.callTool(toolName, args, context);
    return withViewerOperation("mcp.page-cursors", async () => {
      const caller = mcpPageCursorCaller();
      const scope = hash([toolName, caller]);
      let resolved = args;
      if (args.cursor !== undefined && args.cursor !== null && args.cursor !== "") {
        const held = continuation(store, args.cursor, scope, caller);
        if (!held || !matches(filters(args), held.filters, toolName === "relay_owner_history")) return restartPage(wrapped, toolName, args, context);
        resolved = { ...held.filters, ...args, cursor: held.cursor };
      }
      const relayCalls: Array<{ tool: unknown; arguments: unknown; cursor?: unknown; handle?: unknown }> = [];
      if (toolName === "relay_service_tools" && Array.isArray(args.calls)) {
        for (const call of args.calls) {
          if (!record(call)) return invalidInput(toolName, args);
          let item = { tool: call.tool, arguments: call.arguments, cursor: call.cursor, handle: call.cursor };
          if (call.cursor) {
            const held = continuation(store, call.cursor, scope, caller);
            if (!held || held.filters.op !== args.op || held.filters.tool !== call.tool
              || !matches(record(call.arguments) ? call.arguments : {}, held.filters.arguments as Record<string, unknown>, true)) {
              const calls = (args.calls as unknown[]).map(value => {
                if (!record(value)) return value;
                const { cursor: _cursor, ...callWithoutCursor } = value;
                return callWithoutCursor;
              });
              const fresh = await wrapped.callTool(toolName, { ...args, calls }, context);
              return fresh.ok ? { ...fresh, cursorReset: true } : fresh;
            }
            item = { ...item, arguments: held.filters.arguments, cursor: held.cursor };
          }
          relayCalls.push(item);
        }
        resolved = { ...resolved, calls: relayCalls.map(({ handle: _handle, ...call }) => call) };
      }
      const result = await service.callTool(toolName, resolved, context);
      if (!result.ok) return result;
      if (mcpPageCursorCaller() !== caller) return invalidInput(toolName, args);
      const owner = result[RECEIPT_OWNER];
      if ((owner !== undefined && owner !== ownerStamp(caller))
        || (result.replayed && hasPageCursor(result) && owner === undefined)) return invalidInput(toolName, args);
      const answer = { ...result };
      delete answer[RECEIPT_OWNER];
      const issue = (state: string, query: Record<string, unknown>) => store.issue(scope, JSON.stringify({ filters: query, cursor: state }));
      for (const field of ["cursor", "nextCursor"] as const) {
        const state = result[field];
        if (typeof state !== "string" || !state) continue;
        const handle = issue(state, filters(resolved));
        if (!handle) return invalidInput(toolName, args);
        answer[field] = handle;
      }
      if (toolName === "relay_service_tools" && Array.isArray(result.results)) {
        const rows: unknown[] = [];
        const rawRows = (result as McpToolResult & { [MCP_PAGE_CURSOR_RAW_RELAY_RESULTS]?: unknown })[MCP_PAGE_CURSOR_RAW_RELAY_RESULTS];
        for (const [index, row] of result.results.entries()) {
          if (!record(row)) { rows.push(row); continue; }
          const copy = { ...row };
          const rawRow = Array.isArray(rawRows) && record(rawRows[index]) ? rawRows[index] as Record<string, unknown> : row;
          const call = relayCalls.find(call => call.tool === rawRow.tool && (rawRow.page_of
            ? call.cursor === rawRow.page_of : canonical(call.arguments) === canonical(rawRow.arguments)))
            ?? (relayCalls.filter(call => call.tool === row.tool).length === 1 ? relayCalls.find(call => call.tool === row.tool) : undefined);
          if (rawRow.page_of) {
            if (!call?.handle) return invalidInput(toolName, args);
            copy.page_of = call.handle;
          }
          if (typeof rawRow.next_cursor === "string" && rawRow.next_cursor) {
            if (!call) return invalidInput(toolName, args);
            const handle = issue(rawRow.next_cursor, { op: args.op, tool: call.tool, arguments: call.arguments });
            if (!handle) return invalidInput(toolName, args);
            copy.next_cursor = handle;
          }
          rows.push(copy);
        }
        answer.results = rows;
      }
      return answer;
    });
  } };
  return wrapped;
}
