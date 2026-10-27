import { expect, test } from "bun:test";
import { readOwnerHistory } from "./ownerHistory";
import { historyDouble, syntheticMessages } from "./ownerHistory.fixture";
import { McpPageCursorStore, MCP_CURSOR_TTL_MS, withMcpPageCursors } from "@/lib/mcp/pageCursors";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import type { McpToolName } from "@/lib/mcp/server";

test("owner history walks three service pages with opaque cursors and retained dates and zone", async () => {
  const double = await historyDouble();
  let now = 0;
  let zone = "Europe/Kyiv";
  const ports = { switches: () => ({ owner_tools: true }), relays: () => [double.relay], timeZone: () => zone, now: () => double.state.now };
  const bindings = viewerMcpBindings(undefined, {
    get: async () => ({}),
    post: async (_route, body) => {
      const { op, ...args } = body as Record<string, unknown>;
      return readOwnerHistory({ action: op, ...args }, ports);
    },
  });
  const service = withMcpPageCursors({ async callTool(toolName, args) {
    return { ok: true, toolName: toolName as McpToolName, clientRequestId: null, replayed: false, ...await bindings.relay_owner_history(args) };
  } }, new McpPageCursorStore({ now: () => now }));
  const call = async (args: Record<string, unknown>) => {
    const result = await service.callTool("relay_owner_history", args);
    if (!result.ok) throw new Error("history tool failed");
    return result;
  };
  const query = { action: "messages", chat: "-101", from: "2026-10-09", to: "2026-10-11", limit: 3 };
  try {
    for (const repeat of [false, true]) {
      zone = "Europe/Kyiv";
      let page = await call(query);
      const ids: number[] = [];
      for (let index = 0; index < 3; index++) {
        expect(page).toMatchObject({ available: true, timeZone: "Europe/Kyiv" });
        const wireQuery = Object.fromEntries(double.state.exchanges.at(-1)!.request.query);
        expect(wireQuery).toMatchObject({ tz: "Europe/Kyiv", from: query.from, to: query.to, limit: "3" });
        expect(wireQuery.cursor).toBe(index === 0 ? undefined : String(index * 3));
        ids.push(...(page.messages as Array<{ messageId: number }>).map(m => m.messageId));
        if (index === 2) { expect(page.nextCursor).toBeNull(); break; }
        expect(String(page.nextCursor)).toHaveLength(22);
        zone = "America/New_York";
        page = await call({ ...(repeat ? query : { action: "messages" }), cursor: page.nextCursor });
      }
      expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const first = await call(query);
      now += MCP_CURSOR_TTL_MS;
      expect(await call({ ...query, cursor: first.nextCursor })).toMatchObject({ available: true, cursorReset: true });
    }
  } finally { await double.close(); }
});

test("history forwards limits through the service cap of 100 messages", async () => {
  const double = await historyDouble();
  const original = syntheticMessages.slice();
  try {
    syntheticMessages.splice(0, syntheticMessages.length, ...Array.from({ length: 100 }, (_, i) => ({ ...original[0]!, message_id: i + 1, text: "", sent_at: "2026-10-12T09:00:00Z" })));
    // The wire byte cap may shorten a page; the requested count must still reach the service.
    const ports = { switches: () => ({ owner_tools: true }), relays: () => [double.relay], timeZone: () => "UTC", now: () => double.state.now };
    for (const limit of [1, 50, 100]) {
      const page = await readOwnerHistory({ action: "messages", chat: "-101", limit }, ports);
      expect(page.available).toBe(true);
      expect(double.state.exchanges.at(-1)!.request.query).toContainEqual(["limit", String(limit)]);
      if (!page.available || !("messages" in page)) throw new Error("missing page");
      const wire = double.state.exchanges.at(-1)!.response.body as { messages: unknown[] };
      expect(page.messages).toHaveLength(wire.messages.length);
      expect(page.messages.length).toBeLessThanOrEqual(limit);
    }
  } finally { syntheticMessages.splice(0, syntheticMessages.length, ...original); await double.close(); }
});
