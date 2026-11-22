import { expect, test } from "bun:test";
import { createRequestWorkload, workloadRoute } from "./requestWorkload";

test("keeps exact minute totals while bounding peer and conversation detail", () => {
  let at = 0;
  const meter = createRequestWorkload(() => at);
  const target = "conversation_00000000-0000-4000-8000-000000000001";
  for (let pid = 1; pid <= 160; pid++) {
    meter.receivedTool("agent_activity", { pid, startIdentity: `${pid}:100` }, null, target);
  }
  at = 60;
  meter.receivedTool("list_tasks", null, null, undefined);
  const [first, next] = meter.snapshot(0, 1).minutes;
  expect(first?.complete).toBe(true);
  expect(first?.tools.agent_activity).toBe(160);
  expect(Object.keys(first!.callerTargets)).toHaveLength(128);
  expect(first?.omittedCallerTargets).toBe(32);
  expect(next?.tools.list_tasks).toBe(1);
  expect(JSON.stringify(first)).not.toContain(target);
  at = 151 * 60;
  meter.completedRender("http:/");
  expect(meter.snapshot(0, 0).minutes).toEqual([]);
});

test("an unrecognized route cannot put paths or query values into telemetry", () => {
  expect(workloadRoute("/outside/private")).toBe("other");
  expect(workloadRoute("/api/files?project=private")).toBe("/api/files");
  expect(workloadRoute("/api/tasks/private/prototypes")).toBe("/api/tasks/[id]/prototypes");
});

test("a detached callback stops charging a completed request", async () => {
  const meter = createRequestWorkload();
  let later!: Promise<string | undefined>;
  await meter.withTool("list_tasks", async () => {
    later = Bun.sleep(20).then(() => meter.label());
    await Promise.resolve();
    expect(meter.label()).toBe("mcp:list_tasks");
  });
  expect(await later).toBeUndefined();
});

test("registry reads retain the request or the outer background operation that initiated them", async () => {
  const meter = createRequestWorkload(() => 0);
  meter.registryRead("registry.keyed", "agents.reconcile");
  await meter.withTool("get_pipeline", async () => {
    await Promise.resolve();
    meter.registryRead("registry.snapshot", "registry.read");
  });
  meter.registryRead("registry.snapshot", undefined);
  expect(meter.snapshot(0, 0).minutes[0]?.registryReads).toEqual({
    "registry.keyed|agents.reconcile": 1, "registry.snapshot|mcp:get_pipeline": 1, "registry.snapshot|unscoped": 1,
  });
});

test("times successful and failed route requests once in their completion minute", async () => {
  let at = 59;
  const meter = createRequestWorkload(() => at);
  await meter.withRoute("/api/files?private=value", async () => {
    await meter.withTool("agent_activity", async () => { at = 60; });
    at = 61;
  });
  const before = meter.snapshot(1, 1).minutes[0]!;
  expect(() => meter.withRoute("/api/files", () => { at = 61.5; throw Error("handler failed"); })).toThrow();
  expect(before.routeTimings).toEqual({ "/api/files": { count: 1, totalMs: 2000 } });
  expect(meter.snapshot(1, 1).minutes[0]!.routeTimings).toEqual({ "/api/files": { count: 2, totalMs: 2500 } });
  expect(meter.snapshot(0, 0).minutes[0]!.routeTimings).toEqual({});
});
