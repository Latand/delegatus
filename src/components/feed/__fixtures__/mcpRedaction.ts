/** Invented values only. Separate cases keep each field inside the chip limit. */
export const credentialSentinel = "invented-review-value";
export const mcpArgumentCases: Record<string, unknown>[] = [
  { query: "release notes", authorization: `Bearer ${credentialSentinel}` },
  { query: "release notes", headers: { Authorization: `Bearer ${credentialSentinel}`, Accept: "application/json" } },
  { query: "release notes", options: [{ nested: { [["access", "token"].join("_")]: credentialSentinel }, format: "compact" }] },
  { query: "release notes", password: { nested: [credentialSentinel] } },
  { query: "release notes", note: `Use Bearer ${credentialSentinel} for lookup` },
  { note: `Bearer ${credentialSentinel}`, query: "release notes" },
  { cookie: credentialSentinel, query: "release notes" },
];

export function mcpArgumentLine(engine: "claude" | "codex", args: Record<string, unknown>, id = "redaction", typed = false): string {
  if (engine === "claude") return JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id, name: "mcp__catalog__lookup", input: args },
  ] } });
  if (typed) return JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
    type: "McpToolCall", id, server: "catalog", tool: "lookup", arguments: args, status: "completed",
  } } });
  return JSON.stringify({ type: "response_item", payload: {
    type: "function_call", call_id: id, name: "mcp__catalog__lookup", arguments: JSON.stringify(args),
  } });
}
