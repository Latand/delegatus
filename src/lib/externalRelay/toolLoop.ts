import { createHash } from "node:crypto";
import { ExternalRelayError, relayCall } from "./client";
import { isOwnerTool, ownerRateLimitSchema, RELAY_OWNER_TOOLS, toolCallResultSchema, type ExternalRelayRequest, type ExternalRelayRequester, type RoundCall, type ToolCallResult } from "./protocol";
import { readRelaySwitches } from "./switches";
import type { PairedRelay } from "./store";
import type { RelayToolCallRecord } from "./answers";

export function mayQuote(audience: string | undefined, requester: ExternalRelayRequester | null | undefined): boolean {
  return audience === undefined || (audience === "admin" && requester?.is_admin === true) ||
    (audience === "owner" && requester?.is_owner === true);
}
export const callableReads = (request: ExternalRelayRequest) =>
  (request.input.tools ?? []).filter((tool) => tool.mode === "direct" && tool.effect === "read" &&
    tool.parameters && mayQuote(tool.audience, request.input.requester));

export const callableTools = (request: ExternalRelayRequest) =>
  (request.input.tools ?? []).filter((tool) => tool.mode === "direct" && tool.parameters &&
    (tool.effect === "read" || tool.effect === "action" && !!request.input.requester) &&
    mayQuote(tool.audience, request.input.requester));

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
  effect?: "action"; delivered?: true; execution_unknown?: true; summary?: string; expires_in_s?: number;
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
  // I8/C8 admission and the authoritative index belong to the service. The
  // feature gates only the amended owner semantics; legacy 2a owner reads stay.
  const tools = callableTools(request);
  const ownerToolsEnabled = readRelaySwitches().owner_tools && relay.features?.includes(RELAY_OWNER_TOOLS);
  const effectOf = (name: string) => request.input.tools?.find((tool) => tool.name === name)?.effect;
  const cache = new Map<string, Promise<{ result: ToolCallResult | null; code?: string; output?: string; unknown?: boolean }>>();
  const cursors = new Map<string, string>();
  const accounted = new Set<string>();
  const projected = new Set<string>();
  const results: ToolProjection[] = [];
  const records: RelayToolCallRecord[] = [];
  let sent = 0;
  let remaining = 16;
  let outputBytes = 0;
  let terminal = false;
  let actionSent = false;
  const possibleOwnerActions = new Set<string>();
  let sawUnknown = false;
  // Authorization/version rejection stops siblings without ending the lease.
  let rejectionCode: string | undefined;
  const rejected = new AbortController();
  const callSignal = AbortSignal.any([lease.signal, rejected.signal]);
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? toolSleep;
  const wait = async (ms: number) => {
    try { await sleep(ms, callSignal); }
    catch (error) { if (lease.signal.aborted || !rejectionCode) throw error; }
  };
  const callsLeft = () => terminal ? 0 : Math.max(0, Math.min(remaining, 16 - sent));
  async function send(body: ReturnType<typeof callBody>, tool: string) {
    if (!await lease.ack()) { lease.lose(); lease.signal.throwIfAborted(); }
    lease.signal.throwIfAborted();
    const action = effectOf(tool) === "action";
    const owner = ownerToolsEnabled && isOwnerTool(tools.find((item) => item.name === tool)!);
    const unknown = () => {
      terminal = true; sawUnknown = true;
      return { result: null, unknown: true, output: "The service did not confirm whether this action happened." };
    };
    let ambiguous = false;
    const refused = (code?: string) => {
      if (action && ambiguous) return unknown();
      // A wire refusal proves this owner call was not admitted. Other calls'
      // markers and any earlier uncertainty in this call still block handoff.
      if (owner) possibleOwnerActions.delete(body.call_id);
      return { result: null, code, output: "The call could not be completed." };
    };
    const unfinished = () => action ? unknown() : { result: null, output: "The read did not finish." };
    const started = now();
    let failures = 0;
    let unavailable = 0;
    let pending = false;
    let onlyRateLimited = true;
    while (!lease.signal.aborted) {
      if (rejectionCode) return refused(rejectionCode);
      if (pending && now() - started >= 330_000) return unfinished();
      try {
        if (action) {
          if (owner) possibleOwnerActions.add(body.call_id);
          else actionSent = true;
        }
        const response = await relayCall(relay.api_base, `/requests/${encodeURIComponent(request.request_id)}/tool-calls`, "POST", body,
          relay.credential, { timeoutMs: 30_000, maxBytes: 65_536, signal: callSignal });
        if (rejectionCode) return refused(rejectionCode);
        const parsed = toolCallResultSchema.safeParse(response.body);
        if (!parsed.success || parsed.data.call_id !== body.call_id || parsed.data.tool !== tool) throw new ExternalRelayError("malformed");
        const result = parsed.data;
        onlyRateLimited = false;
        // Concurrent responses and historical replays must never replenish the budget.
        if (!result.replayed) remaining = Math.min(remaining, result.calls_remaining);
        // R6 zero ends new actions even on replay; an admitted pending call still polls below.
        if (action && result.calls_remaining === 0 || result.code === "too_many_calls" || result.delivered || ["confirmation_pending", "outcome_unknown"].includes(result.status)) terminal = true;
        // Reauthorization can deny a saved success after execution. Keep the
        // denial; unavailable permits only retries of this same wire identity.
        if (action && result.status === "denied" && result.code !== "unavailable") terminal = true;
        if (action && result.status === "outcome_unknown") sawUnknown = true;
        if (!action && !mayQuote(result.audience, request.input.requester)) return { result };
        if (result.status === "pending") {
          pending = true;
          if (action) ambiguous = true;
          if (now() - started >= 330_000) return unfinished();
          await wait(Math.min((result.retry_after_s ?? 1) * 1000, 330_000 - (now() - started)));
          continue;
        }
        if (result.status === "denied" && result.code === "unavailable") {
          if (action) ambiguous = true;
          if (unavailable++ < 2) {
            await wait((result.retry_after_s ?? 1) * 1000);
            continue;
          }
          if (action) {
            unknown();
            return { result, unknown: true };
          }
        }
        return { result };
      } catch (error) {
        if (lease.signal.aborted) throw error;
        if (rejectionCode) return refused(rejectionCode);
        if (error instanceof ExternalRelayError) {
          if (error.status === 404 || (error.status === 409 && error.code === "lease_lost")) {
            lease.lose(); throw error;
          }
          if ([401, 426].includes(error.status)) {
            terminal = true;
            rejectionCode = error.code;
            rejected.abort();
          }
          if (action && error.status === 409 && error.code === "call_conflict") return unknown();
          if ([400, 401, 413, 426].includes(error.status) || !action && error.status === 409)
            return refused(error.code);
          if (error.status === 429) {
            const nonAdmission = ownerRateLimitSchema.safeParse(error.payload);
            if (!owner || nonAdmission.success) {
              if (++failures > 3) {
                if (owner && onlyRateLimited) sent--;
                return refused(error.code);
              }
              await wait((owner && nonAdmission.success ? nonAdmission.data.error.retry_after_s
                : Math.min(60, Math.max(1, error.retryAfterSeconds ?? 1))) * 1000);
              continue;
            }
          }
        }
        // Only the wire-defined refusals above prove non-admission. Any other
        // response (including a redirect or HTTP timeout) leaves fate unresolved.
        ambiguous = true;
        onlyRateLimited = false;
        if (++failures > 3) return action ? unknown() : refused();
        await wait(1000 * 2 ** (failures - 1));
      }
    }
    lease.signal.throwIfAborted();
    throw new Error("tool loop aborted");
  }
  async function runCalls(calls: RoundCall[], round: number) {
    const allowance = Math.min(4, callsLeft());
    let roundAction: string | undefined;
    let releaseReads!: () => void;
    const readsSettled = new Promise<void>((resolve) => { releaseReads = resolve; });
    // Reserve the action identity immediately, but release its send only after reads settle.
    const scheduled = calls.map((call, index) => {
      const local = (code: string, output = "") => ({ call, local: true, body: null, task: Promise.resolve({ result: null, code, output }) });
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
      const action = effectOf(call.tool) === "action";
      if (action && roundAction && roundAction !== body.call_id)
        return local("too_many_calls", "One action per round; call it again next round if it is still needed.");
      if (action) roundAction = body.call_id;
      let task = cache.get(body.call_id);
      if (!task) {
        if (!action) sent++;
        const tool = tools.find((tool) => tool.name === call.tool)!;
        task = (async () => {
          if (action) {
            await readsSettled;
            lease.signal.throwIfAborted();
            if (rejectionCode || callsLeft() === 0) return { result: null, code: "too_many_calls", output: "" };
            sent++;
          }
          if (!tool.audience) onProgress?.(call.tool, false, false);
          return send(body, call.tool);
        })().then((value) => {
          if (!tool.audience && (!value.result || !value.result.audience)) onProgress?.(call.tool, true, value.result?.status !== "ok");
          return value;
        });
        cache.set(body.call_id, task);
      }
      return { call, local: false, body, task };
    });
    const projections = new Map<number, ToolProjection>();
    const rows = new Map<number, RelayToolCallRecord>();
    function project(index: number, value: Awaited<typeof scheduled[number]["task"]>) {
      const { call, local, body } = scheduled[index]!;
      const action = effectOf(call.tool) === "action";
      const raw = value.result;
      const withheld = !!raw && !mayQuote(raw.audience, request.input.requester);
      let output = withheld ? "" : raw?.output ?? value.output ?? "";
      let code = withheld && !action ? "not_permitted" : raw?.code ?? value.code;
      let status = withheld && !action ? "denied" : raw?.status ?? ("unknown" in value && value.unknown ? "outcome_unknown" : local ? "denied" : "error");
      if (withheld && action) terminal = true;
      let truncated = !withheld && (raw?.truncated ?? false);
      if (body && !accounted.has(body.call_id)) {
        accounted.add(body.call_id);
        const bytes = Buffer.byteLength(output);
        if (outputBytes + bytes > 65_536) {
          output = ""; terminal = true;
          if (action) truncated = true;
          else { code = "quota_exhausted"; status = "denied"; }
        }
        else outputBytes += bytes;
      }
      // Store each logical result once: repeated calls cannot grow the prompt.
      const duplicate = body && projected.has(body.call_id);
      const projection: ToolProjection = { round, tool: call.tool,
        ...(body && "arguments" in body ? { arguments: body.arguments } : call.cursor ? { page_of: call.cursor } : {}),
        status, output, truncated,
        ...(action ? { effect: "action" as const } : {}),
        ...(action && raw && "unknown" in value && value.unknown ? { execution_unknown: true as const } : {}),
        ...(action && raw?.delivered ? { delivered: true as const } : {}),
        ...(action && !withheld && raw?.status === "confirmation_pending" ? {
          ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
          ...(raw.expires_at ? { expires_in_s: Math.max(0, Math.ceil((Date.parse(raw.expires_at) - now()) / 1000)) } : {}),
        } : {}),
        ...(!withheld && raw?.cursor ? { next_cursor: raw.cursor } : {}),
        ...(!withheld && raw?.audience ? { audience: raw.audience } : {}), ...(code ? { code } : {}),
      };
      if (!duplicate) {
        projections.set(index, projection);
        if (body) projected.add(body.call_id);
      }
      if (!withheld && raw?.cursor) cursors.set(raw.cursor, call.tool);
      rows.set(index, { round, tool: call.tool, page: call.cursor !== null, status: raw?.status ?? status,
        code: raw?.code ?? code ?? null, audience: raw?.audience ?? null,
        truncated: raw?.truncated ?? false, replayed: raw?.replayed ?? false, withheld, local: local || !raw,
        ...(action ? { effect: "action" as const } : {}) });
    }
    const readIndexes = scheduled.flatMap((item, index) => effectOf(item.call.tool) !== "action" ? [index] : []);
    const reads = await Promise.allSettled(readIndexes.map((index) => scheduled[index]!.task));
    for (const [offset, value] of reads.entries()) if (value.status === "fulfilled") project(readIndexes[offset]!, value.value);
    releaseReads();
    // Settle every sibling before propagating lease loss; no detached rejection.
    const settled = await Promise.allSettled(scheduled.map((item) => item.task));
    lease.signal.throwIfAborted();
    for (const [index, value] of settled.entries()) {
      if (value.status === "rejected") throw value.reason;
      const { call } = scheduled[index]!;
      const action = effectOf(call.tool) === "action";
      if (action) project(index, value.value);
      const projection = projections.get(index);
      if (projection) results.push(projection);
      records.push(rows.get(index)!);
    }
    if (!calls.length) terminal = true;
  }
  return { tools, results, records, callsLeft, runCalls, get actionSent() { return actionSent || possibleOwnerActions.size > 0; }, get sawUnknown() { return sawUnknown; } };
}
