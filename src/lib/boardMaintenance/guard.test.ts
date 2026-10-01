import { afterEach, expect, test } from "bun:test";
import { maintainerTaskWriteRefusal } from "./guard";
import { permitMaintainerTool } from "@/lib/mcp/toolAllowlist";
import { MUTATING_MCP_TOOL_NAMES } from "@/lib/mcp/server";
import { claim, sandbox, PROJECT } from "./testFixture";
import type { BoardTask } from "@/lib/tasks/types";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
test("each task refusal has a clear code, with hidden create allowed", () => {
  held = sandbox(); const run = claim(); const caller = { conversationId: "fixture-worker", project: PROJECT, run };
  const task = { id: "aabbccdd", project: PROJECT, text: "fixture", status: "assigned", assignments: [], placement: "unplaced", createdAt: run.claimedAt, updatedAt: run.claimedAt } satisfies BoardTask;
  const refuse = (args: Record<string, unknown>, more = {}) => maintainerTaskWriteRefusal({ caller, task, args, ...more });
  expect(refuse({ status: "done" }, { openPipeline: "lane" })?.code).toBe("maintainer_done_refused");
  expect(refuse({ status: "done" }, { liveAgent: "worker" })?.code).toBe("maintainer_done_refused");
  for (const args of [{ details: null }, { details: "" }, { removeLine: { index: 0 } }, { detachLinks: [] }, { board: "hidden" }, { hide: true }, { assignments: [] }, { replaceLine: { index: 0, text: "" } }]) expect(refuse(args)?.code).toBe("maintainer_delete_refused");
  expect(refuse({ details: "whole field" })?.code).toBe("maintainer_details_overwrite_refused");
  expect(refuse({ project: "another" })?.code).toBe("maintainer_project_refused");
  expect(refuse({ text: "new title" }, { caller: { ...caller, run: { ...run, state: "succeeded" } } })?.code).toBe("maintainer_run_ended");
  expect(refuse({ text: "new title" }, { caller: { ...caller, run: null, endedScheduledRun: true } })?.code).toBe("maintainer_run_ended");
  expect(refuse({ project: PROJECT, board: "hidden", details: "new details" }, { create: true })).toBeNull();
  expect(refuse({ status: "inbox", appendLine: "Maintenance: corrected by evidence" })).toBeNull();
});
test("mutating tool classification is fail closed; config reads remain available", () => {
  const allowed = ["create_task", "update_task", "agent_activity", "lifecycle_events", "seat_tick_settings", "account_project_binding", "role_presets", "auto_updates"];
  for (const tool of MUTATING_MCP_TOOL_NAMES) expect(permitMaintainerTool(tool, {}).allowed).toBe(allowed.includes(tool));
  for (const [tool, args] of [["seat_tick_settings", { maintenance: { enabled: true } }], ["role_presets", { overrides: {} }], ["auto_updates", { enabled: true }], ["account_project_binding", { action: "add" }]] as const) expect(permitMaintainerTool(tool, args)).toMatchObject({ allowed: false, code: "maintainer_tool_refused" });
  expect(permitMaintainerTool("account_project_binding", { action: "list", project: PROJECT }).allowed).toBe(true);
});
