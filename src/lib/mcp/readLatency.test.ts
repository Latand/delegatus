import { expect, test } from "bun:test";

import { productionDomainDependencies, viewerMcpToolPolicy } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, McpToolTimingAggregate, type McpToolBindings } from "./server";

test("public store reads do not pay synchronous caller projection or queue behind another call", async () => {
  let projections = 0;
  const dependencies = {
    ...productionDomainDependencies,
    attentionAuthority: () => {
      projections++;
      // Fault injection at the actual synchronous policy seam. Three unrelated
      // calls used to serialize these projections on the stdio event loop.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      return { kind: "unidentified" as const };
    },
  };
  const policy = viewerMcpToolPolicy(dependencies, false, () => ({
    activeSeats: () => [], revocations: () => [], conversationFacts: () => null, resolveAlias: id => id,
  }));
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as McpToolBindings;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  bindings.pipeline_action = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return {}; };
  const timings = new McpToolTimingAggregate();
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), policy, { timings });
  const close = service.callTool("pipeline_action", { clientRequestId: "slow-close", action: "close" });
  await started;
  try {
    const start = performance.now();
    const results = await Promise.all(["list_tasks", "get_task", "get_pipeline"].map(tool => service.callTool(tool, { clientRequestId: tool })));
    const ms = Math.round(performance.now() - start);
    console.log(JSON.stringify({ injectedCallerDelayMs: 750, parallelReadsMs: ms, projections,
      callerMs: timings.snapshot().filter(row => results.some(result => result.toolName === row.toolName)).map(row => ({ tool: row.toolName, ms: Math.round(row.phases.caller.max) })) }));
    expect(results.every(result => result.ok)).toBe(true);
    expect(projections).toBe(0);
    expect(ms).toBeLessThan(250);
  } finally { release(); await close; }
});

test("archive still verifies caller on every call and probe credentials retain their allowlist", () => {
  let reads = 0;
  const dependencies = { ...productionDomainDependencies, attentionAuthority: () => {
    reads++;
    return { kind: "unidentified" as const };
  } };
  const policy = viewerMcpToolPolicy(dependencies, false, () => ({
    activeSeats: () => [], revocations: () => [], conversationFacts: () => null, resolveAlias: id => id,
  }));
  expect(policy.permit("conversation_action", { action: "archive" }).allowed).toBe(false);
  expect(policy.permit("conversation_action", { action: "unarchive" }).allowed).toBe(false);
  expect(reads).toBe(2);
  const probe = viewerMcpToolPolicy(dependencies, true);
  for (const tool of ["list_tasks", "get_task", "get_pipeline"] as const) expect(probe.permit(tool, {}).allowed).toBe(false);
  expect(probe.permit("board_snapshot", {}).allowed).toBe(true);
  expect(reads).toBe(2);
});
