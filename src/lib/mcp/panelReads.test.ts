import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import * as cooperative from "@/lib/cooperative";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import type { RoleMemoryRule } from "@/lib/memory/roleTypes";
import { viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";
import { readSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import path from "node:path";

const NOW = Date.parse("2026-10-12T12:00:00Z"), AT = new Date(NOW).toISOString();
const PROJECT = "panel-project", SEAT = "conversation_panel_seat";
const domain = {
  registrySnapshot: () => ({ conversations: {}, conversationAliases: {}, entries: {}, receipts: {}, memberships: {}, lineageEdges: {} }),
  callerAttribution: () => ({ kind: "manager", conversationId: SEAT, role: "orchestrator" }),
  authorizedSeats: () => [{ conversationId: SEAT, path: null, project: PROJECT }],
  callerProject: () => PROJECT,
  readTickSettings: readSeatTickSettings, writeTickSettings: writeSeatTickSettings,
};
afterEach(() => setSystemTime());

function seedHistory() {
  const scope = `role:${PROJECT}:builder`, id = "r_panel";
  const rule: RoleMemoryRule = { kind: "rule", id, scope, rule: "Check the current revision before applying changes.", why: "Concurrent writes can invalidate a plan.",
    state: "active", hints: [], createdAt: AT, changedAt: AT,
    source: { project: PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "fixture" } };
  roleMemoryCollection(true)!.boundedPatch(2, tx => {
    tx.put(rule);
    tx.put({ kind: "scope", scope, active: [id], revision: 4097,
      history: Array.from({ length: 4096 }, (_, index) => ({ revision: index + 1, at: AT, by: "agent", added: [id], merged: [], archived: [] })) });
  });
}

test("curation expiry preserves settings with an explicit unavailable panel and durable replay", async () => {
  setSystemTime(new Date(NOW));
  seedHistory();
  const originalYield = cooperative.yieldToRuntime;
  let yielded = false;
  const hook = spyOn(cooperative, "yieldToRuntime").mockImplementation(async () => {
    await originalYield();
    yielded = true;
    setSystemTime(new Date(NOW + 5100));
  });
  const store = new SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "panels.sqlite"));
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain as never), store, viewerMcpToolPolicy(domain as never));
  const args = { verbose: true, clientRequestId: "curation-expiry" };
  try {
    const answer = await service.callTool("seat_tick_settings", args, { deadlineAt: NOW + 10_000 });
    expect(yielded).toBe(true);
    expect(answer).toMatchObject({ ok: true, partial: true, omissions: ["curation"], settings: { project: PROJECT }, curation: { status: "unavailable" } });
    expect(answer).toHaveProperty("maintenance");
    expect(answer).toHaveProperty("effective");
    if (!answer.ok) throw Error("settings read refused");
    expect((answer.curation as { runsError: string }).runsError).toContain("timed out");
    expect(await service.callTool("seat_tick_settings", args)).toMatchObject({ ok: true, replayed: true, partial: true });
  } finally { hook.mockRestore(); store.close(); }
});

test("caller cancellation still refuses the whole read", async () => {
  const controller = new AbortController();
  controller.abort(Error("caller left"));
  await expect(viewerMcpBindings(undefined, undefined, domain as never).seat_tick_settings({ verbose: true }, { signal: controller.signal })).rejects.toThrow("caller left");
});
