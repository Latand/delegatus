import { expect, test } from "bun:test";
import { createMcpToolService, MCP_TOOL_NAMES, McpToolRefusal, MemoryMcpReceiptStore, type McpToolBindings } from "./server";

test.each([
  ["STAGE_REPORT_SETTLED", false],
  ["STAGE_REPORT_INVALID", false],
  ["STAGE_REPORT_CONTRADICTORY", false],
  ["STAGE_REPORT_NOT_AN_ATTEMPT", false],
  ["STAGE_REPORT_NOT_HELD", false],
  ["STAGE_REPORT_SUPERSEDED", false],
  ["STAGE_REPORT_NOT_A_RUN_STAGE", false],
  ["STAGE_REPORT_CHANGED", true],
  ["STAGE_REPORT_BACKGROUND_TASK_RUNNING", true],
] as const)("stage_report classifies %s retryability as %s", async (code, retryable) => {
  let calls = 0;
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as McpToolBindings;
  bindings.stage_report = async () => {
    calls += 1;
    throw new McpToolRefusal("The stage report was refused.", { code, status: 409 });
  };
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const args = { clientRequestId: `report-${code}`, verdict: "pass" };
  const refused = await service.callTool("stage_report", args);
  expect(refused).toMatchObject({ ok: false, retryable, details: { code } });
  if (refused.ok) throw new Error("refusal was accepted");
  if (!retryable) expect(refused.code).toBe(code);
  expect(await service.callTool("stage_report", args)).toMatchObject({ retryable, replayed: true });
  expect(calls).toBe(1);
});
