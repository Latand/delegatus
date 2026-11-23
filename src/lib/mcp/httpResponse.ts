/** A refusal before tool dispatch carries no JSON-RPC request identity. */
export function mcpHttpRefusal(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export const MCP_REFUSAL_HEADER = "x-delegatus-mcp-refusal";
export const MCP_CHECK_HEADER = "x-delegatus-mcp-check";
export const MCP_REFUSAL_LABELS: readonly string[] = ["caller-identification", "tool-service", "capability-unknown"];
export const MCP_CHECK_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
