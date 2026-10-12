import { expect, test, spyOn } from "bun:test";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, type McpToolBindings, McpToolRefusal } from "./server";
import { productionDomainDependencies, viewerMcpBindings } from "./bindings";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { historyOwnerRun } from "@/lib/externalRelay/ownerHistory.caller.fixture";

test("history always observes fresh data, never reads or writes receipts even with an explicit key", async () => {
  let calls = 0;
  const store = new MemoryMcpReceiptStore();
  const claim = spyOn(store, "claim"), lookup = spyOn(store, "lookup"), complete = spyOn(store, "complete");
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as McpToolBindings;
  bindings.relay_owner_history = async () => ({ groups: [], count: ++calls });
  const service = createMcpToolService(bindings, store);
  for (const args of [{ action: "groups" }, { action: "groups", clientRequestId: "same" }, { action: "groups", clientRequestId: "same" }]) {
    expect(await service.callTool("relay_owner_history", args)).toMatchObject({ ok: true, replayed: false, count: calls });
  }
  expect(calls).toBe(3); expect(claim).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
});
test("binding posts only fixed arguments and caller capability; live Telegram reply is refused before control", async () => {
  const original = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "b".repeat(43);
  try {
    const seen: unknown[] = [];
    const control = { get: async () => ({}), post: async (route: string, body: unknown, headers?: Record<string,string>) => { seen.push({ route, body, capability: headers?.[VIEWER_SPAWN_CAPABILITY_HEADER] }); return { available: false, reason: "switch_off" }; } };
    const bindings = viewerMcpBindings(undefined, control);
    await bindings.relay_owner_history({ action: "messages", chat: "-101", limit: 20, caller: "ignored" });
    expect(seen).toEqual([{ route: "/api/external-relay/owner-history", body: { op: "messages", chat: "-101", limit: 20 }, capability: "b".repeat(43) }]);
    const end = historyOwnerRun("conversation_reply");
    const live = viewerMcpBindings(undefined, control, { ...productionDomainDependencies, callerAttribution: () => ({ kind: "agent", conversationId: "conversation_reply", role: null }) });
    try { await expect(live.relay_owner_history({ action: "groups" })).rejects.toBeInstanceOf(McpToolRefusal); expect(seen).toHaveLength(1); }
    finally { end(); }
    await live.relay_owner_history({ action: "groups" }); expect(seen).toHaveLength(2);
  } finally { if (original === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV]; else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = original; }
});
