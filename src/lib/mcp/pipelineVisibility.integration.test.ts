import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

// The command isolates HOME, config, state and TMPDIR before loading this graph.
const { harness, create, createPipelineFromRequest, closeAndDrain, RUN_STAGES, loadPipelines, savePipelines, tickPipelines, patchPipeline, setPipelineDismissal } = await import("@/lib/pipelines/engine.fixture");
const { viewerMcpBindings, viewerMcpToolPolicy, productionDomainDependencies } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { setMcpHttpDependenciesForTests } = await import("./http");
const { POST } = await import("@/app/api/mcp/route");
const { buildMobileBoard, needsDecisionPipelineRows } = await import("@/components/mobile/mobileBoardModel");
const { laneNeed } = await import("@/components/attention/needReason");
import type { ViewerMcpDomainDependencies } from "./bindings";
import type { Pipeline } from "@/lib/pipelines/types";

const SEAT = "conversation_visibility_seat";
const CAPABILITY = "v".repeat(43);
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setMcpHttpDependenciesForTests(null);
});

async function protocol(h: ReturnType<typeof harness>) {
  const domain: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "manager", conversationId: SEAT, role: "orchestrator" }),
    attentionAuthority: () => ({ kind: "worker", conversationId: SEAT, role: "orchestrator" }),
    authorizedSeats: () => [{ conversationId: SEAT, path: "/seat.jsonl", project: "viewer" }],
    patchPipeline: (id, request) => patchPipeline(id, request, h.ports),
    dismissalPorts: {
      now: () => new Date(h.ports.now()), resolveConversation: () => null, task: () => null,
      pipelines: loadPipelines, pipeline: id => loadPipelines().find(row => row.id === id) ?? null,
      setPipelineDismissal: (id, dismiss, by, moved, note) => setPipelineDismissal(id, dismiss, by, h.ports, moved, note),
      resolveReports: () => ({ resolved: [], alreadyClear: [], unknown: [] }),
    },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain));
  setMcpHttpDependenciesForTests({ service: async () => service, conversationForCapability: value => value === CAPABILITY ? SEAT : null });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
  cleanups.push(() => server.stop(true));
  const client = new Client({ name: "pipeline-visibility", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", server.url), { requestInit: { headers: { "x-llv-spawn-capability": CAPABILITY } } }));
  let serial = 0;
  return async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: { ...args, clientRequestId: `visibility-${++serial}` } });
    return { error: response.isError === true, data: response.structuredContent as Record<string, unknown>, raw: JSON.stringify(response) };
  };
}

function assertUi(pipeline: Pipeline, hidden: boolean) {
  const now = 1_000_000;
  expect(needsDecisionPipelineRows([pipeline], "viewer", now)).toHaveLength(hidden ? 0 : 1);
  expect(buildMobileBoard({ files: [], pipelines: [pipeline], project: "viewer", now }).attentionCount).toBe(hidden ? 0 : 1);
  expect(Boolean(laneNeed(pipeline)?.cleared)).toBe(hidden);
}

for (const failure of ["base", "worktree"] as const) for (const check of ["visibility", "repark"] as const) test(`${check}: Hide and a roundless ${failure} re-park agree over HTTP MCP and the board`, async () => {
  const h = harness();
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd, env, options) => {
    if ((failure === "base" && args[0] === "fetch") || (failure === "worktree" && args[0] === "worktree")) {
      return { code: 128, stdout: "", stderr: "fixture provisioning refused" };
    }
    if (failure === "worktree" && args[0] === "rev-parse" && args[1] === "--abbrev-ref" && cwd?.includes("-pipeline-")) {
      return { code: 128, stdout: "", stderr: "missing worktree" };
    }
    return baseExec(command, args, cwd, env, options);
  };
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs.flatMap(run => run.attempts)).toHaveLength(0);
  const call = await protocol(h);
  const action = async (action: string) => {
    const answer = await call("pipeline_action", { pipelineId: created.id, action });
    expect(answer.error, answer.raw).toBe(false);
  };
  const lists = async (hidden: boolean) => {
    const stored = loadPipelines()[0]!;
    for (const view of [{}, { compact: false }, { statusOnly: true }]) {
      const answer = await call("list_pipelines", { project: "viewer", ...view });
      expect(answer.error, answer.raw).toBe(false);
      expect(answer.data.pipelines).toEqual([expect.objectContaining({ id: created.id, dismissedAt: stored.dismissedAt ?? null, hiddenFromBoard: hidden })]);
    }
    const full = await call("list_pipelines", { project: "viewer", full: true });
    expect(full.error, full.raw).toBe(false);
    expect(full.data.pipelines).toEqual([expect.objectContaining({ id: created.id, dismissedAt: stored.dismissedAt ?? null })]);
    assertUi(stored, hidden);
  };
  await action("dismiss");
  const firstHide = loadPipelines()[0]!;
  expect(firstHide).toMatchObject({ state: parked.state, cursor: parked.cursor, runs: parked.runs });
  if (check === "visibility") await lists(true);
  else assertUi(loadPipelines()[0]!, true);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.dismissedAt).toBe(firstHide.dismissedAt);
  await action("undismiss");
  if (check === "visibility") await lists(false);
  else assertUi(loadPipelines()[0]!, false);
  const hideAgain = await call("dismiss_attention", { target: { kind: "pipeline", pipelineId: created.id }, reason: "Current decision acknowledged" });
  expect(hideAgain.error, hideAgain.raw).toBe(false);
  expect(loadPipelines()[0]!.dismissedNote).toBe("Current decision acknowledged");
  await action("retry-stage");
  expect(loadPipelines()[0]!.state).toBe("provisioning");
  await tickPipelines([], h.ports);
  const reparked = loadPipelines()[0]!;
  expect(reparked).toMatchObject({ state: "needs_decision", dismissedAt: null });
  expect(reparked.dismissedBy).toBeUndefined();
  expect(reparked.dismissedNote).toBeUndefined();
  expect(reparked.runs).toEqual(parked.runs);
  await lists(false);
  await action("dismiss");
  await lists(true);
  expect(h.killedPanes).toEqual([]);
});

test("draft and closed lanes are already clear over MCP and retain their record", async () => {
  const h = harness();
  savePipelines([]);
  const draft = await createPipelineFromRequest({ task: "A hidden draft", repoDir: "/repo", stages: RUN_STAGES as never, autoStart: false }, h.ports);
  expect(draft.pipeline?.state).toBe("draft");
  const call = await protocol(h);
  for (const state of ["draft", "closed"] as const) {
    if (state === "closed") await closeAndDrain(draft.pipeline!.id, { action: "close" }, h.ports);
    const row = loadPipelines()[0]!;
    expect(row.state).toBe(state);
    for (const action of ["dismiss", "undismiss"]) {
      const before = loadPipelines();
      const answer = await call("pipeline_action", { pipelineId: row.id, action });
      expect(answer.error, answer.raw).toBe(false);
      expect(answer.data.dismissal).toMatchObject({ dismissed: false, alreadyClear: true });
      expect(answer.data.changedFields).toEqual([]);
      expect(loadPipelines()).toEqual(before);
    }
  }
});
