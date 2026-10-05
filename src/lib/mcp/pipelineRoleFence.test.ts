import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as realEngine from "@/lib/pipelines/engine";

/*
 * #2518: an issue reporter writes one thing, a report's preview. It starts no
 * child agent, and the review found it could still reach pipeline creation
 * through MCP, where no role was asked. The engine here is a fake that records
 * every call, so nothing is created and "not called" is observed, not inferred.
 */

const created: unknown[] = [];
const patched: unknown[] = [];
mock.module("@/lib/pipelines/engine", () => ({
  ...realEngine,
  createPipelineFromRequest: async (request: unknown) => {
    created.push(request);
    return { pipeline: { id: "0a1b2c3d", stages: [], state: "draft" } };
  },
}));

const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore, MUTATING_MCP_TOOL_NAMES } = await import("./server");
type CallerAttribution = import("./bindings").CallerAttribution;
type McpToolResult = import("./server").McpToolResult;

let sandbox = "";
let previousStateDir: string | undefined;
beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-role-fence-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  created.length = 0;
  patched.length = 0;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const REPORTER: CallerAttribution = { kind: "agent", conversationId: "conversation_reporter", role: "issue-reporter" };
const REVIEWER: CallerAttribution = { kind: "agent", conversationId: "conversation_reviewer", role: "reviewer" };
const SEAT: CallerAttribution = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };
const BUILDER: CallerAttribution = { kind: "agent", conversationId: "conversation_builder", role: "builder" };

const EMPTY_REGISTRY = { conversations: {}, conversationAliases: {}, memberships: {}, lineageEdges: {}, receipts: {}, entries: {} };

let next = 0;
function call(caller: CallerAttribution, tool: "create_pipeline" | "pipeline_action", args: Record<string, unknown>, registry: Record<string, unknown> = EMPTY_REGISTRY) {
  const domain = {
    attentionAuthority: () => ({ kind: "worker", conversationId: caller.conversationId, role: caller.role }),
    callerAttribution: () => caller,
    authorizedSeats: () => [],
    registrySnapshot: () => registry,
    patchPipeline: async (id: string, body: unknown) => {
      patched.push({ id, body });
      return { pipeline: { id, stages: [], state: "running" } };
    },
    getPipelines: () => ({ pipelines: [] }),
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  return service.callTool(tool, { clientRequestId: `role-fence-${next += 1}`, ...args }) as Promise<McpToolResult & Record<string, unknown>>;
}

const PIPELINE = () => ({
  src: path.join(sandbox, "reporter.jsonl"), repoDir: sandbox, task: "Do the work the reporter was not asked to do",
  stages: [{ id: "build", role: "builder" }], autoStart: true,
});

test("an issue reporter creates no pipeline through MCP: the engine is never called", async () => {
  const refused = await call(REPORTER, "create_pipeline", PIPELINE());
  expect(refused).toMatchObject({ ok: false });
  expect(String(refused.error)).toContain("issue reporter starts no agents and no pipelines");
  expect(created).toEqual([]);
});

test("the role the registry records for the caller decides as well as the attributed one", async () => {
  const registry = {
    ...EMPTY_REGISTRY,
    conversations: { conversation_builder: { id: "conversation_builder", agentRole: "issue-reporter", generations: [], continuityPaths: [] } },
  };
  expect(await call(BUILDER, "create_pipeline", PIPELINE(), registry)).toMatchObject({ ok: false });
  expect(created).toEqual([]);
});

test("every role with no child-spawn capability is refused the same way", async () => {
  expect(await call(REVIEWER, "create_pipeline", PIPELINE())).toMatchObject({ ok: false });
  expect(created).toEqual([]);
});

test("an issue reporter launches no stage of an existing pipeline", async () => {
  for (const action of ["start", "retry-stage", "resume", "skip-stage", "publish", "add-stage", "accept-head", "pause", "cancel"]) {
    const refused = await call(REPORTER, "pipeline_action", { pipelineId: "0a1b2c3d", action, stageId: "build" });
    expect(refused).toMatchObject({ ok: false });
    expect(String(refused.error)).toContain("issue reporter starts no agents and no pipelines");
  }
  expect(patched).toEqual([]);
});

test("the reporter policy refuses every other mutation before downstream dispatch, including receipt replay", async () => {
  let caller = BUILDER;
  let writes = 0;
  const domain = {
    attentionAuthority: () => ({ kind: "worker", conversationId: caller.conversationId, role: caller.role }),
    callerAttribution: () => caller,
    registrySnapshot: () => EMPTY_REGISTRY,
  };
  const bindings = Object.fromEntries([...MUTATING_MCP_TOOL_NAMES].map((tool) => [tool, async () => { writes++; return { recorded: true }; }])) as never;
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  const args = { clientRequestId: "reporter-replay", pipelineId: "0a1b2c3d", action: "resume" };
  expect(await service.callTool("pipeline_action", args)).toMatchObject({ ok: true });
  expect(writes).toBe(1);
  caller = REPORTER;
  expect(await service.callTool("pipeline_action", args)).toMatchObject({ ok: false, code: "issue_reporter_write_refused" });
  expect(writes).toBe(1);
  const policy = viewerMcpToolPolicy(domain as never);
  for (const tool of MUTATING_MCP_TOOL_NAMES) {
    if (["issue_report", "agent_activity", "lifecycle_events", "role_presets", "seat_tick_settings", "account_project_binding", "auto_updates"].includes(tool)) continue;
    expect(policy.permit(tool, {})).toMatchObject({ allowed: false, code: "issue_reporter_write_refused" });
  }
  for (const [tool, input] of [
    ["issue_report", { action: "preview" }], ["issue_report", { action: "show" }],
    ["pipeline_action", { action: "preview" }], ["agent_activity", {}], ["lifecycle_events", {}],
    ["role_presets", {}], ["seat_tick_settings", {}], ["account_project_binding", { action: "list" }], ["auto_updates", {}],
  ] as const) expect(policy.permit(tool, input)).toEqual({ allowed: true });
  for (const [tool, input] of [
    ["issue_report", { action: "publish" }], ["role_presets", { overrides: {} }], ["seat_tick_settings", { enabled: true }],
    ["account_project_binding", { action: "bind" }], ["auto_updates", { enabled: true }],
  ] as const) expect(policy.permit(tool, input)).toMatchObject({ allowed: false });
});

test("an orchestrator and a builder still reach the engine", async () => {
  for (const caller of [SEAT, BUILDER]) {
    created.length = 0;
    const answer = await call(caller, "create_pipeline", PIPELINE());
    expect(String(answer.error ?? "")).not.toContain("starts no agents");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ repoDir: sandbox, autoStart: true });
  }
  await call(SEAT, "pipeline_action", { pipelineId: "0a1b2c3d", action: "start" });
  expect(patched).toHaveLength(1);
});
