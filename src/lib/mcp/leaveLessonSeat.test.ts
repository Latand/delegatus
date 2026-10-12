import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "seat-lesson-"));
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { learnedRulesBlock, roleMemoryCollection, projectView } = await import("@/lib/memory/roleStore");

const project = "seat-lessons";
const conversationId = "seat";
const rule = "Before reporting an agent as stalled, inspect the tail of its conversation for recent work.";
const why = "An activity signal reported a stall while the transcript showed progress.";
function service() {
  return createMcpToolService(viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "manager", conversationId }),
    authorizedSeats: () => [{ project, conversationId, path: null }],
    listPipelineRecords: () => [],
  } as never), new MemoryMcpReceiptStore());
}

test("a designated seat leaves a role rule without a stage request", async () => {
  const result = await service().callTool("leave_lesson", { clientRequestId: "seat-first", lesson: { scope: "role", rule, why } });
  expect(result).toMatchObject({ ok: true, project, roleId: "orchestrator", left: [{ scope: `role:${project}:orchestrator`, state: "active" }] });
  expect(learnedRulesBlock(project, "orchestrator")).toContain(rule);
  const rows = roleMemoryCollection()!.snapshot();
  expect(rows.filter(row => row.kind === "request")).toEqual([]);
  const stored = rows.find(row => row.kind === "rule");
  expect(stored).toMatchObject({ source: { origin: "seat", project, conversationId, roleId: "orchestrator", fixRound: false } });
  expect(projectView(project).scopes.find(scope => scope.roleId === "orchestrator")?.active[0]?.stageId).toBe("seat");
});
