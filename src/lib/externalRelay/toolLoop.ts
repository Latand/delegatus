import { createHash } from "node:crypto";
import { ExternalRelayError, relayCall } from "./client";
import { toolCallResultSchema, type ExternalRelayRequest, type ExternalRelayRequester, type RoundCall, type ToolCallResult } from "./protocol";
import type { PairedRelay } from "./store";
import type { RelayToolCallRecord } from "./answers";

export function mayQuote(audience: string | undefined, requester: ExternalRelayRequester | null | undefined): boolean {
  return audience === undefined || (audience === "admin" && requester?.is_admin === true) ||
    (audience === "owner" && requester?.is_owner === true);
}
export const callableReads = (request: ExternalRelayRequest) =>
  (request.input.tools ?? []).filter((tool) => tool.mode === "direct" && tool.effect === "read" &&
    tool.parameters && mayQuote(tool.audience, request.input.requester));

/** Sort at every depth without interpreting JSON keys as object prototypes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function callBody(request: ExternalRelayRequest, logical: { tool: string; arguments: Record<string, unknown> } | { cursor: string }) {
  const normalized = JSON.parse(canonical(logical)) as typeof logical;
  const call_id = createHash("sha256").update(`delegatus-relay-call\n${request.request_id}\n${canonical(normalized)}`).digest("base64url");
  return "cursor" in normalized
    ? { lease_id: request.lease_id, call_id, cursor: normalized.cursor }
    : { lease_id: request.lease_id, call_id, tool: normalized.tool, arguments: normalized.arguments };
}
export type ToolProjection = {
  round: number; tool: string; arguments?: Record<string, unknown>; page_of?: string;
  status: string; output: string; truncated: boolean; next_cursor?: string; audience?: string; code?: string;
};
export type ToolLoopRuntime = { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number };
export async function toolSleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Request-scoped memory only. The service owns the durable C6 ledger. */
export function createToolLoop(relay: PairedRelay, request: ExternalRelayRequest, lease: {
  signal: AbortSignal; lose: () => void; ack: () => Promise<boolean>;
}, runtime: ToolLoopRuntime = {}, onProgress?: (tool: string, done: boolean, failed: boolean) => void) {
  const tools = callableReads(request);
  const cache = new Map<string, Promise<{ result: ToolCallResult | null; code?: string; output?: string }>>();
  const cursors = new Map<string, string>();
  const accounted = new Set<string>();
  const projected = new Set<string>();
  const results: ToolProjection[] = [];
  const records: RelayToolCallRecord[] = [];
  let sent = 0;
  let remaining = 16;
  let outputBytes = 0;
  let terminal = false;
  // Authorization/version rejection stops siblings without ending the lease.
  let rejectionCode: string | undefined;
  const rejected = new AbortController();
  const callSignal = AbortSignal.any([lease.signal, rejected.signal]);
  const rejectedResult = () => ({ result: null, code: rejectionCode, output: "The call could not be completed." });
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? toolSleep;
  const wait = async (ms: number) => {
    try { await sleep(ms, callSignal); }
    catch (error) { if (lease.signal.aborted || !rejectionCode) throw error; }
  };
  const callsLeft = () => terminal ? 0 : Math.max(0, Math.min(remaining, 16 - sent));
  async function send(body: ReturnType<typeof callBody>, tool: string) {
    if (!await lease.ack()) { lease.lose(); lease.signal.throwIfAborted(); }
    const started = now();
    let failures = 0;
    let unavailable = 0;
    let pending = false;
    while (!lease.signal.aborted) {
      if (rejectionCode) return rejectedResult();
      if (pending && now() - started >= 330_000) return { result: null, output: "The read did not finish." };
      try {
        const response = await relayCall(relay.api_base, `/requests/${encodeURIComponent(request.request_id)}/tool-calls`, "POST", body,
          relay.credential, { timeoutMs: 30_000, maxBytes: 65_536, signal: callSignal });
        if (rejectionCode) return rejectedResult();
        const parsed = toolCallResultSchema.safeParse(response.body);
        if (!parsed.success || parsed.data.call_id !== body.call_id || parsed.data.tool !== tool) throw new ExternalRelayError("malformed");
        const result = parsed.data;
        // Concurrent responses and historical replays must never replenish the budget.
        if (!result.replayed) remaining = Math.min(remaining, result.calls_remaining);
        if (result.code === "too_many_calls" || result.delivered || ["confirmation_pending", "outcome_unknown"].includes(result.status)) terminal = true;
        if (!mayQuote(result.audience, request.input.requester)) return { result };
        if (result.status === "pending") {
          pending = true;
          if (now() - started >= 330_000) return { result: null, output: "The read did not finish." };
          await wait(Math.min((result.retry_after_s ?? 1) * 1000, 330_000 - (now() - started)));
          continue;
        }
        if (result.status === "denied" && result.code === "unavailable" && unavailable++ < 2) {
          await wait((result.retry_after_s ?? 1) * 1000);
          continue;
        }
        return { result };
      } catch (error) {
        if (lease.signal.aborted) throw error;
        if (rejectionCode) return rejectedResult();
        if (error instanceof ExternalRelayError) {
          if (error.status === 404 || (error.status === 409 && error.code === "lease_lost")) {
            lease.lose(); throw error;
          }
          if ([401, 426].includes(error.status)) {
            terminal = true;
            rejectionCode = error.code;
            rejected.abort();
          }
          if ([400, 401, 409, 413, 426].includes(error.status)) return { result: null, code: error.code, output: "The call could not be completed." };
          if (error.status === 429) {
            if (++failures > 3) return { result: null, code: error.code, output: "The call could not be completed." };
            await wait(Math.min(60, Math.max(1, error.retryAfterSeconds ?? 1)) * 1000);
            continue;
          }
        }
        if (++failures > 3) return { result: null, output: "The call could not be completed." };
        await wait(1000 * 2 ** (failures - 1));
      }
    }
    lease.signal.throwIfAborted();
    throw new Error("tool loop aborted");
  }
  async function runCalls(calls: RoundCall[], round: number) {
    const allowance = Math.min(4, callsLeft());
    // Admission is sequential, execution concurrent, projection in model order.
    const scheduled = calls.map((call, index) => {
      const local = (code: string) => ({ call, local: true, body: null, task: Promise.resolve({ result: null, code, output: "" }) });
      if (index >= allowance) return local("too_many_calls");
      if (!tools.some((tool) => tool.name === call.tool)) return local("not_permitted");
      let logical: Parameters<typeof callBody>[1];
      if (call.cursor !== null) {
        if (cursors.get(call.cursor) !== call.tool) return local("invalid_arguments");
        logical = { cursor: call.cursor };
      } else {
        let args: unknown;
        try { args = JSON.parse(call.arguments); } catch { return local("invalid_arguments"); }
        if (!args || typeof args !== "object" || Array.isArray(args)) return local("invalid_arguments");
        logical = { tool: call.tool, arguments: args as Record<string, unknown> };
      }
      const body = callBody(request, logical);
      if (Buffer.byteLength(JSON.stringify(body)) > 65_536) return local("invalid_arguments");
      let task = cache.get(body.call_id);
      if (!task) {
        sent++;
        const tool = tools.find((tool) => tool.name === call.tool)!;
        if (!tool.audience) onProgress?.(call.tool, false, false);
        task = send(body, call.tool).then((value) => {
          if (!tool.audience && (!value.result || !value.result.audience)) onProgress?.(call.tool, true, value.result?.status !== "ok");
          return value;
        });
        cache.set(body.call_id, task);
      }
      return { call, local: false, body, task };
    });
    // Settle every sibling before propagating lease loss; no detached rejection.
    const settled = await Promise.allSettled(scheduled.map((item) => item.task));
    lease.signal.throwIfAborted();
    for (const [index, value] of settled.entries()) {
      if (value.status === "rejected") throw value.reason;
      const { call, local, body } = scheduled[index]!;
      const raw = value.value.result;
      const withheld = !!raw && !mayQuote(raw.audience, request.input.requester);
      let output = withheld ? "" : raw?.output ?? value.value.output ?? "";
      let code = withheld ? "not_permitted" : raw?.code ?? value.value.code;
      let status = withheld ? "denied" : raw?.status ?? (local ? "denied" : "error");
      if (body && !accounted.has(body.call_id)) {
        accounted.add(body.call_id);
        const bytes = Buffer.byteLength(output);
        if (outputBytes + bytes > 65_536) { output = ""; code = "quota_exhausted"; status = "denied"; terminal = true; }
        else outputBytes += bytes;
      }
      // Store each logical result once: repeated calls cannot grow the prompt.
      const duplicate = body && projected.has(body.call_id);
      const projection: ToolProjection = { round, tool: call.tool,
        ...(body && "arguments" in body ? { arguments: body.arguments } : call.cursor ? { page_of: call.cursor } : {}),
        status, output, truncated: !withheld && (raw?.truncated ?? false),
        ...(!withheld && raw?.cursor ? { next_cursor: raw.cursor } : {}),
        ...(!withheld && raw?.audience ? { audience: raw.audience } : {}), ...(code ? { code } : {}),
      };
      if (!duplicate) {
        results.push(projection);
        if (body) projected.add(body.call_id);
      }
      if (!withheld && raw?.cursor) cursors.set(raw.cursor, call.tool);
      records.push({ round, tool: call.tool, page: call.cursor !== null, status: raw?.status ?? status,
        code: raw?.code ?? code ?? null, audience: raw?.audience ?? null,
        truncated: raw?.truncated ?? false, replayed: raw?.replayed ?? false, withheld, local: local || !raw });
    }
    if (!calls.length) terminal = true;
  }
  return { tools, results, records, callsLeft, runCalls };
}
