import { afterEach, expect, test, setSystemTime } from "bun:test";
import { normalizeRegistry } from "@/lib/agent/registry";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { viewerMcpBindings, type CallerAttribution } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "./server";

const now = "2026-10-02T10:00:00.000Z";
const project = "summary-fixture";
const content = { headline: "Outcome retained", text: "Storage holds the outcome. Readers can return to it.", left: "Interface follows." };
afterEach(() => { saveTasks([]); setSystemTime(); });

test.each(["manager", "agent"] as const)("update_task summary uses the attributed %s and can clear it", async kind => {
  setSystemTime(new Date(now));
  saveTasks([{ id: "summary-task", project, text: "Retain the outcome", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now }]);
  const caller: CallerAttribution = kind === "manager" ? { kind, role: "orchestrator", conversationId: "conversation_summary" } : { kind, role: "builder", conversationId: "conversation_summary" };
  const control = { get: async () => { throw new Error("unexpected live read"); }, post: async () => { throw new Error("unexpected live write"); } };
  const bindings = viewerMcpBindings(undefined, control, {
    registrySnapshot: () => normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
    callerAttribution: () => caller, callerProject: () => project,
    attentionAuthority: () => ({ kind: "worker", conversationId: caller.conversationId, role: caller.role }),
    authorizedSeats: () => [], canonicalSeatConversationId: (id: string) => id,
  } as never);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const first = await service.callTool("update_task", { clientRequestId: `summary-set-${kind}`, taskId: "summary-task", summary: { ...content, author: { kind: "operator" }, updatedAt: "forged" } });
  expect(first).toMatchObject({ ok: true });
  if (!first.ok) throw new Error(first.error);
  expect(first.changedFields).toContain("summary");
  expect(loadTasks()[0]?.summary).toEqual({ ...content, updatedAt: now,
    author: { kind: kind === "manager" ? "orchestrator" : "agent", conversationId: caller.conversationId } });
  const invalid = await service.callTool("update_task", { clientRequestId: `summary-invalid-${kind}`, taskId: "summary-task", summary: { ...content, text: "t".repeat(601) } });
  expect(invalid.ok).toBe(false);
  expect(loadTasks()[0]?.summary?.text).toBe(content.text);
  const refine = await service.callTool("update_task", { clientRequestId: `summary-refine-${kind}`, taskId: "summary-task", summary: null, refine: { text: "New title" } });
  expect(refine).toMatchObject({ ok: false, code: "TASK_INVALID_FIELD", details: { field: "summary" } });
  expect(loadTasks()[0]?.summary?.headline).toBe(content.headline);
  const cleared = await service.callTool("update_task", { clientRequestId: `summary-clear-${kind}`, taskId: "summary-task", summary: null });
  expect(cleared).toMatchObject({ ok: true });
  expect(loadTasks()[0]).not.toHaveProperty("summary");
});
