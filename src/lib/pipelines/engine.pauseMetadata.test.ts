import { expect, test, harness, create, patchPipeline, loadPipelines } from "./engine.fixture";
import { TOOL_INPUT_SCHEMAS } from "@/lib/mcp/server";
import { viewerMcpBindings } from "@/lib/mcp/bindings";

test("pause persists its reason and resume date; resume clears the metadata", async () => {
  const h = harness();
  const lane = await create(h.ports);
  const resumeCondition = { kind: "date" as const, at: "2026-11-01T12:00:00.000Z" };
  const result = await patchPipeline(lane.id, { action: "pause", reason: "wait for the release window", resumeCondition }, h.ports);
  expect(result.error).toBeUndefined();
  expect(loadPipelines().find(p => p.id === lane.id)?.pause).toEqual({ reason: "wait for the release window", resumeCondition, actor: { kind: "operator" } });
  await patchPipeline(lane.id, { action: "resume" }, h.ports);
  expect(loadPipelines().find(p => p.id === lane.id)?.pause).toBeUndefined();
});

test.each([
  { reason: " " },
  { resumeCondition: { kind: "date", at: "not a date" } },
  { resumeCondition: { kind: "account-usage", engine: "codex", accountId: "fixture", window: "weekly", belowPercent: 101 } },
])("malformed pause metadata refuses the transition: %j", async patch => {
  const h = harness();
  const lane = await create(h.ports);
  const before = loadPipelines().find(p => p.id === lane.id)!;
  const result = await patchPipeline(lane.id, { action: "pause", ...patch } as never, h.ports);
  expect(result.status).toBe(400);
  expect(loadPipelines().find(p => p.id === lane.id)).toEqual(before);
});

test("pipeline_action carries an account resume condition through MCP to the real writer", async () => {
  const h = harness();
  const lane = await create(h.ports);
  const resumeCondition = { kind: "account-usage" as const, engine: "codex" as const,
    accountId: "fixture", window: "weekly" as const, belowPercent: 80 };
  const args = TOOL_INPUT_SCHEMAS.pipeline_action.parse({ clientRequestId: "pause-with-condition", pipelineId: lane.id,
    action: "pause", reason: "wait for quota recovery", resumeCondition });
  const conversationId = ["conversation", "fixture-seat"].join("_");
  const bindings = viewerMcpBindings(undefined, undefined, {
    patchPipeline: (id, request, _ports, actor) => patchPipeline(id, request, h.ports, actor),
    callerAttribution: () => ({ kind: "manager", conversationId, role: "orchestrator" }),
  });
  await bindings.pipeline_action(args);
  const pause = loadPipelines().find(p => p.id === lane.id)!.pause;
  expect(pause).toEqual({ reason: "wait for quota recovery", resumeCondition,
    actor: { kind: "agent", role: "orchestrator", conversationId } });
});

test("legacy pause callers get an explicit missing-reason record and no condition", async () => {
  const h = harness();
  const lane = await create(h.ports);
  await patchPipeline(lane.id, { action: "pause" }, h.ports);
  expect(loadPipelines().find(p => p.id === lane.id)!.pause).toEqual({ reason: "No pause reason supplied", actor: { kind: "operator" } });
});
