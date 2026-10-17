import { expect, spyOn, test } from "bun:test";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, type McpToolBindings } from "./server";

test("request tools are always fresh and receipt-free, including retries with explicit keys", async () => {
  let calls = 0;
  const receipts = new MemoryMcpReceiptStore();
  const claim = spyOn(receipts, "claim"), lookup = spyOn(receipts, "lookup"), complete = spyOn(receipts, "complete");
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as McpToolBindings;
  bindings.relay_service_tools = async () => ({ count: ++calls });
  const service = createMcpToolService(bindings, receipts);
  let expected = 0;
  for (const args of [{ op: "list" }, { op: "list", clientRequestId: "same" }, { op: "list", clientRequestId: "same" }])
    expect(await service.callTool("relay_service_tools", args)).toMatchObject({ ok: true, replayed: false, count: ++expected });
  expect(calls).toBe(3); expect(claim).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
});
