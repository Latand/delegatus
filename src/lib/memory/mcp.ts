import type { ViewerControlDependencies } from "@/lib/mcp/bindings";
import type { McpToolArgs } from "@/lib/mcp/server";

/** Stdio forwards to the serving Viewer; only that process owns the derivative. */
export async function searchMemoryTool(args: McpToolArgs, control: ViewerControlDependencies, conversationId: string | null) {
  const requestId = typeof args.clientRequestId === "string" ? args.clientRequestId.trim() : "";
  // The Viewer payload is spread into this exact success envelope by
  // createMcpToolService. Reserve its serialized bytes before asking the route
  // to build the page, including JSON escaping in the caller-controlled key.
  const envelope = { ok: true, toolName: "search_memory", clientRequestId: requestId, replayed: false };
  const payloadBudget = 16_000 - (Buffer.byteLength(JSON.stringify(envelope)) - 1);
  if (typeof args.id === "string" && args.id.trim()) {
    return control.post("/api/search/memory", { id: args.id.trim(), project: args.project, requestId, conversationId, maxBytes: payloadBudget });
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("query or id is required");
  const params = new URLSearchParams({ q: query });
  if (typeof args.project === "string" && args.project.trim()) params.set("project", args.project.trim());
  if (typeof args.kind === "string" && args.kind.trim()) params.set("kind", args.kind.trim());
  params.set("maxBytes", String(payloadBudget));
  const limit = Number(args.limit);
  params.set("limit", String(Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.min(20, Math.trunc(limit))) : 10));
  if (!control.get) throw new Error("Viewer control read is unavailable");
  return control.get(`/api/search/memory?${params}`);
}
