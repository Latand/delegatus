import { z } from "zod";
import type { ExternalRelayRequest } from "./protocol";
import type { PairedRelay, RelayTargetSettings } from "./store";
import { canonical, createToolLoop, RELAY_TOOL_ROUNDS, toolSleep, type ToolLoopRuntime, type ToolProjection } from "./toolLoop";
import { compactToolIndex, describeToolIndex, type ToolGuidance } from "./toolIndex";
import { liveOwnerRelayRequest } from "./ownerAuthority";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export const relayServiceToolsSchema = z.object({
  op: z.enum(["list", "describe", "call"]),
  query: z.string().min(1).max(200).optional(),
  names: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
  calls: z.array(z.object({ tool: z.string().min(1).max(64),
    arguments: z.record(z.string(), z.unknown()), cursor: z.string().max(64).nullable().optional() })).min(1).max(4).optional(),
});
type Args = z.infer<typeof relayServiceToolsSchema>;
type BatchReply = { status: string; results: (ToolProjection & { note?: string } | { tool: string; status: string })[]; callsLeft: number; actionSent: boolean };
type Adapter = ReturnType<typeof openOwnerServiceTools>;
const shared = globalThis as typeof globalThis & { __llvRelayOwnerServiceTools?: Map<string, Adapter> };
const registry = () => shared.__llvRelayOwnerServiceTools ??= new Map();
const note = (result: ToolProjection): string | undefined => {
  if (result.status === "confirmation_pending") return "Confirmation was requested in the chat; the action has not run. Tell the owner and make no further call.";
  if (result.status === "outcome_unknown" || result.status === "execution_unknown" || result.execution_unknown) return "The action may have happened. Say so; do not repeat it.";
  if (result.effect === "action" && result.status === "denied") return "This denial may hide a completed effect. Do not repeat the action.";
  if (result.delivered) return "The service already posted this result in the chat.";
  if (result.truncated && result.next_cursor) return "The result is truncated. Use next_cursor with this same tool to read the next page.";
};

/** One live request owns one loop; no lease or credential crosses the MCP boundary. */
export function openOwnerServiceTools(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest,
  guidance: ToolGuidance[], lease: { signal: AbortSignal; lose: () => void; ack: () => Promise<boolean> },
  runtime: ToolLoopRuntime, authorize: () => boolean) {
  const closed = new AbortController();
  const signal = AbortSignal.any([lease.signal, closed.signal]);
  let open = true;
  const check = () => {
    if (!authorize()) { open = false; closed.abort(); }
    signal.throwIfAborted();
  };
  const loop = createToolLoop(relay, request, { signal, lose: lease.lose, ack: async () => {
    check(); const acknowledged = await lease.ack(); check(); return acknowledged;
  } }, { ...runtime, sleep: async (ms, sleepSignal) => {
    check(); await (runtime.sleep ?? toolSleep)(ms, sleepSignal); check();
  } });
  const described = new Set<string>();
  const batches = new Map<string, Promise<BatchReply>>();
  let active: { key: string; promise: Promise<BatchReply> } | null = null;
  let rounds = 0;
  let closing: Promise<void> | null = null;
  const adapter = {
    relayId: relay.id, targetId: target.id,
    get records() { return loop.records; },
    get available() { return open && !signal.aborted; },
    async op(args: Args, waitMs: number) {
      check();
      if (args.op === "list") {
        const terms = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        return { tools: compactToolIndex(request).filter(tool => terms.every(term => `${tool.name} ${tool.summary}`.toLowerCase().includes(term))) };
      }
      if (args.op === "describe") {
        const result = describeToolIndex(request, args.names ?? [], guidance);
        for (const tool of result.tools) if (tool.mode === "direct") described.add(tool.name);
        return result;
      }
      const calls = args.calls;
      if (!calls?.length) return { status: "invalid_arguments" };
      // Bound canonical keys even when called directly by a binding, before loop admission.
      if (Buffer.byteLength(JSON.stringify(calls)) > 4 * 65_536) return { status: "invalid_arguments" };
      const key = canonical(calls.map(call => ({ ...call, cursor: call.cursor ?? null })));
      const cached = batches.get(key);
      if (active && active.key !== key) return { status: "busy" };
      let batch = cached;
      if (!batch) {
        const needsDescription = calls.filter(call => loop.tools.some(tool => tool.name === call.tool && tool.effect === "action") && !described.has(call.tool));
        if (needsDescription.length) return { status: "describe_first", tools: needsDescription.map(call => call.tool) };
        if (rounds >= RELAY_TOOL_ROUNDS - 1) return { status: "too_many_calls", callsLeft: 0 };
        const start = loop.results.length;
        const round = ++rounds;
        batch = (async (): Promise<BatchReply> => {
          try {
            await loop.runCalls(calls.map(call => ({ tool: call.tool, arguments: JSON.stringify(call.arguments), cursor: call.cursor ?? null })), round);
            const identity = (tool: string, argumentsValue: unknown, cursor?: string | null) => canonical({ tool, arguments: cursor ? null : argumentsValue, cursor: cursor ?? null });
            const seen = new Set(loop.results.slice(0, start).filter(result => result.arguments || result.page_of)
              .map(result => identity(result.tool, result.arguments, result.page_of)));
            const added = loop.results.slice(start);
            const repeated = calls.flatMap(call => {
              const key = identity(call.tool, call.arguments, call.cursor);
              if (seen.has(key)) return [{ tool: call.tool, status: "repeated" }];
              seen.add(key); return [];
            });
            // Preserve every loop projection, including local denials. Only
            // calls omitted by its deduplication need a repeated marker.
            const results: BatchReply["results"] = added.map(result => {
              const explanation = note(result);
              return { ...result, ...(explanation ? { note: explanation } : {}) };
            });
            results.push(...repeated.slice(0, calls.length - added.length));
            return { status: "completed", results, callsLeft: loop.callsLeft(), actionSent: loop.actionSent };
          } catch { return { status: "relay_tools_unavailable", results: [], callsLeft: 0, actionSent: loop.actionSent }; }
        })();
        batches.set(key, batch);
        active = { key, promise: batch };
        void batch.then(() => { if (active?.key === key) active = null; });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([batch, new Promise<{ status: string }>(resolve => {
          timer = setTimeout(() => resolve({ status: "in_progress" }), Math.min(20_000, Math.max(0, waitMs)));
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
    close(status = "cancelled"): Promise<void> {
      open = false;
      return closing ??= (async () => {
        if (status === "done" && active) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([active.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, 30_000); })]); }
          finally { if (timer) clearTimeout(timer); }
        }
        closed.abort();
        if (active) await active.promise;
      })();
    },
    async dispose() {
      await adapter.close();
      if (registry().get(request.request_id) === adapter) registry().delete(request.request_id);
    },
  };
  if (registry().has(request.request_id)) throw new Error("owner service tools already registered");
  registry().set(request.request_id, adapter);
  return adapter;
}

/** Null is deliberately the same refusal for every failed authority or lifetime check. */
export function relayServiceToolsOp(conversationId: string, input: unknown, waitMs = 20_000) {
  return withViewerOperation("relay.service-tools", async () => {
    const owner = liveOwnerRelayRequest(conversationId);
    const adapter = owner && registry().get(owner.requestId);
    if (!adapter?.available || adapter.relayId !== owner!.relayId || adapter.targetId !== owner!.targetId) return null;
    return adapter.op(relayServiceToolsSchema.parse(input), waitMs);
  });
}
