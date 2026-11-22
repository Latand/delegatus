import { createHash } from "node:crypto";
import { ExternalRelayError, relayCall } from "./client";
import { isolatedDelivery, lookupResultSchema, relayToolAudience, visibleRelayTools, type ExternalRelayRequest, type ExternalRelayTool } from "./protocol";
import type { PairedRelay } from "./store";
import { canonical, toolSleep, type ToolLoopRuntime } from "./toolLoop";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

/** Only the service's advertised, audience-visible metadata enters the owner prompt. */
export function compactToolIndex(request: ExternalRelayRequest) {
  return visibleRelayTools(request)
    .map(({ name, summary, mode, effect, audience }) => ({ name, summary, mode,
      ...(effect ? { effect } : {}), ...(audience ? { audience } : {}) }));
}

export type ToolGuidance = { tools: string[]; text: string };
export function describeToolIndex(request: ExternalRelayRequest, names: string[], blocks: ToolGuidance[] = []) {
  const visible = visibleRelayTools(request);
  const tools = visible.filter(tool => names.includes(tool.name));
  const missing = names.filter(name => !visible.some(tool => tool.name === name));
  const reply = () => {
    const direct = tools.filter(tool => tool.mode === "direct").map(tool => tool.name);
    const guidance = blocks.length ? blocks.filter(block => block.tools.some(name => direct.includes(name)))
      : request.input.tool_guidance && direct.length ? [{ tools: direct, text: request.input.tool_guidance }] : [];
    return { tools: [...tools], guidance, missing, truncated };
  };
  let truncated = false;
  while (Buffer.byteLength(JSON.stringify(reply())) > 65_536 && tools.length) { tools.pop(); truncated = true; }
  return reply();
}

/** Fill a request once for both agent paths. Lookup failures retain the safe handoff claim. */
export async function hydrateToolIndex(relay: PairedRelay, request: ExternalRelayRequest,
  lease: { signal: AbortSignal; ack: () => Promise<boolean>; lose: () => void },
  runtime: ToolLoopRuntime = {}, deadlineAt = Infinity): Promise<{ request: ExternalRelayRequest; guidance: ToolGuidance[] }> {
  if (isolatedDelivery(request)) return { request, guidance: [] };
  const visible = visibleRelayTools(request);
  if (!visible.some(tool => tool.mode === "direct" && tool.spec && !tool.parameters)) return { request, guidance: [] };
  return withViewerOperation("relay.tool-index", async () => {
    const now = runtime.now ?? Date.now;
    const sleep = runtime.sleep ?? toolSleep;
    const budget = Math.max(0, Math.min(30_000, deadlineAt - now()));
    const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(budget)]);
    const until = now() + budget;
    const tools = new Map<string, ExternalRelayTool>();
    const guidance = new Map<string, ToolGuidance>();
    const mayQuote = relayToolAudience(request);
    const pending = new Set(visible.filter(tool => tool.mode === "direct").map(tool => tool.name).sort());
    try {
      for (let page = 0; pending.size && page < 4; page++) {
        const describe = [...pending];
        const call_id = createHash("sha256").update(`delegatus-relay-lookup\n${request.request_id}\n${canonical({ describe })}`).digest("base64url");
        let unavailable = 0;
        while (true) {
          signal.throwIfAborted();
          if (now() >= until) throw new Error("lookup budget exhausted");
          if (!await lease.ack()) { lease.lose(); throw new Error("lookup lease lost"); }
          signal.throwIfAborted();
          const response = await relayCall(relay.api_base, `/requests/${encodeURIComponent(request.request_id)}/tool-calls`, "POST",
            { lease_id: request.lease_id, call_id, describe }, relay.credential,
            { signal, timeoutMs: Math.max(1, Math.min(30_000, until - now())), maxBytes: 65_536 });
          const result = lookupResultSchema.parse(response.body);
          if (result.call_id !== call_id || result.tool !== "") throw new Error("lookup identity mismatch");
          if (result.status === "denied" && result.code === "unavailable" && unavailable++ < 2) {
            await sleep(Math.min(60, Math.max(1, result.retry_after_s ?? 1)) * 1000, signal); continue;
          }
          if (result.status !== "ok" || !result.tools) throw new Error("lookup refused");
          let progress = 0;
          for (const tool of result.tools) if (pending.has(tool.name) && mayQuote(tool.audience)) {
            const filled = { ...tool }; delete filled.spec;
            if (filled.mode === "handoff" || filled.parameters) { tools.set(tool.name, filled); pending.delete(tool.name); progress++; }
          }
          for (const block of result.guidance ?? []) {
            const previous = guidance.get(block.text);
            guidance.set(block.text, { text: block.text, tools: [...new Set([...(previous?.tools ?? []), ...block.tools])] });
          }
          if (!result.truncated) pending.clear();
          else if (!progress) throw new Error("lookup made no progress");
          break;
        }
      }
      const admittedGuidance = [...guidance.values()].filter(block => block.tools.some(name => tools.has(name)));
      return { request: { ...request, input: { ...request.input,
        tools: visible.flatMap(tool => tool.mode === "direct" ? tools.has(tool.name) ? [tools.get(tool.name)!] : [] : [tool]),
        tool_guidance: admittedGuidance.map(block => block.text).join("\n\n") || null } }, guidance: admittedGuidance };
    } catch (error) {
      if (error instanceof ExternalRelayError && (error.status === 404 || error.code === "lease_lost")) lease.lose();
      if (lease.signal.aborted) throw error;
      return { request, guidance: [] };
    }
  });
}
