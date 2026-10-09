import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { BoardTask } from "@/lib/tasks/types";
import type { PipelineStage } from "@/lib/pipelines/types";
import type { RuntimeHostClient } from "@/lib/runtime/client";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-helper-tasks-"));
const environment = {
  LLV_STATE_DIR: path.join(sandbox, "state"),
  LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
  LLV_SPAWN_TRANSPORT: "structured",
  LLV_STRUCTURED_HOSTS: "1",
  LLV_RUNTIME_EVENTS: "1",
  LLV_RUNTIME_HOST_SOCKET: path.join(sandbox, "runtime.sock"),
  NEXT_PUBLIC_RUNTIME_UI: "1",
};
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);

const { AgentRegistry } = await import("@/lib/agent/registry");
const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
const { rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
const { buildPipeline, loadPipelines, savePipelines } = await import("@/lib/pipelines/store");
const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
const { projectForCwd } = await import("@/lib/scanner/describe");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
const { createMcpToolService, MemoryMcpReceiptStore, McpToolRefusal } = await import("@/lib/mcp/server");
const { POST } = await import("./route");
type Dependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  saveTasks([]);
  savePipelines([]);
});

const now = "2026-10-09T06:00:00.000Z";
const project = projectForCwd(sandbox)!;
function task(id: string): BoardTask {
  return { id, project, status: "inbox", text: "Implement the shared work", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now };
}
const holders = (conversationId: string) => loadTasks().filter(t => t.assignments.some(a => a.conversationId === conversationId)).map(t => t.id).sort();

function harness(stageCaller = true) {
  const store = new AgentRegistry(path.join(fs.mkdtempSync(path.join(sandbox, "registry-")), "registry.json"));
  const caller = store.ensureConversation("claude", path.join(sandbox, "caller.jsonl"), null);
  saveTasks([task("stage-work-a"), task("stage-work-b"), task("explicit-work")]);
  const stage: PipelineStage = { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Implement the work", next: null,
    effectiveRole: { roleId: "builder", engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: "Build the work" } };
  const lane = buildPipeline({ id: "helper-task-lane", task: "Implement the work", taskIds: ["stage-work-a", "stage-work-b"], project, repoDir: sandbox,
    stages: [stage], srcPath: null, srcConversationId: null, now });
  lane.state = "running";
  lane.runs[0]!.attempts.push({ n: 1, state: "running", effectiveRole: stage.effectiveRole, launchId: null,
    conversationId: stageCaller ? caller.id : "conversation_other_stage", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: now, completedAt: null, input: "Implement the work", activatedBy: null, output: null, verdict: null, error: null });
  savePipelines([lane]);
  const account = { engine: "claude" as const, accountId: "account-fixture", kind: "managed" as const,
    home: path.join(sandbox, "account"), transcriptRoot: path.join(sandbox, "projects"), env: { NODE_ENV: "test" as const } };
  let launches = 0;
  const dependencies: Dependencies = {
    ...POST.productionDependencies,
    registry: () => store, assertStructuredRuntime: () => {}, engineReadiness: () => "connected",
    resolveHealthySpawnAccount: async () => account, resolveSpawnAccount: () => account,
    runtimeHostClient: () => ({} as RuntimeHostClient), defer: work => { void work(); }, storeImages: () => [],
    spawnStructuredConversation: async input => {
      launches += 1;
      return { ok: true, target: null, path: null, effectivePermissionMode: "default", launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId, launched: true, retrySafe: false, initialMessage: "delivered", state: "settled" };
    },
  };
  const capability = rotateOperatorSpawnCapability();
  const dispatched: Record<string, unknown>[] = [];
  const control = { post: async (_pathname: string, body: Record<string, unknown>) => {
    dispatched.push(body);
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", { method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json",
        "x-llv-spawn-capability": capability, ...internalServiceHeaders("mcp") }, body: JSON.stringify(body) }), dependencies);
    const payload = await response.json();
    if (response.status >= 400) throw new McpToolRefusal(payload.error, { status: response.status });
    return payload;
  } };
  const bindings = viewerMcpBindings(undefined, control, {
    callerAttribution: () => ({ kind: "agent", conversationId: caller.id, role: "builder" }),
    attentionAuthority: () => ({ kind: "worker", conversationId: caller.id, role: "builder" }),
    registrySnapshot: () => store.snapshot(), loadTasks,
  });
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const args = { clientRequestId: "helper-task-request", cwd: sandbox, title: "Probe the shared work", prompt: "Probe the cache", engine: "claude", model: "sonnet", role: "builder" };
  return { service, args, store, caller, dispatched, control, launches: () => launches };
}

test("a stage caller's spawn_agent helper joins every pipeline task without a placeholder or a parent selector", async () => {
  const h = harness();
  const result = await h.service.callTool("spawn_agent", h.args);
  expect(result).toMatchObject({ ok: true });
  expect(holders(result.conversationId as string)).toEqual(["stage-work-a", "stage-work-b"]);
  expect(loadTasks()).toHaveLength(3);
  expect(h.dispatched[0]).not.toHaveProperty("taskId");
  expect(h.dispatched[0]).not.toHaveProperty("parentConversationId");
  expect(h.launches()).toBe(1);
});

test("an explicit taskId wins over the stage caller's pipeline tasks", async () => {
  const h = harness();
  const result = await h.service.callTool("spawn_agent", { ...h.args, taskId: "explicit-work" });
  expect(result).toMatchObject({ ok: true });
  expect(holders(result.conversationId as string)).toEqual(["explicit-work"]);
  expect(loadTasks()).toHaveLength(3);
});

test("a non-stage worker without a task target keeps its placeholder launch", async () => {
  const h = harness(false);
  const result = await h.service.callTool("spawn_agent", h.args);
  expect(result).toMatchObject({ ok: true });
  expect(holders(result.conversationId as string)).toHaveLength(1);
  expect(loadTasks()).toHaveLength(4);
  const placeholder = loadTasks().find(t => t.assignments.some(a => a.conversationId === result.conversationId))!;
  expect(placeholder.origin?.refinement).toBe("pending");
  expect(["stage-work-a", "stage-work-b", "explicit-work"]).not.toContain(placeholder.id);
});

test("replay under the same key retains the original membership after the pipeline disappears", async () => {
  const h = harness();
  const first = await h.service.callTool("spawn_agent", h.args);
  expect(first).toMatchObject({ ok: true });
  savePipelines([]);
  const replay = await h.service.callTool("spawn_agent", h.args);
  expect(replay).toMatchObject({ ok: true, replayed: true, conversationId: first.conversationId, launchId: first.launchId });
  expect(h.dispatched).toHaveLength(1);
  // A repeated downstream dispatch also converges at the admission seam.
  const routeReplay = await h.control.post("/api/spawn", h.dispatched[0]!);
  expect(routeReplay).toMatchObject({ conversationId: first.conversationId, launchId: first.launchId });
  expect(holders(first.conversationId as string)).toEqual(["stage-work-a", "stage-work-b"]);
  expect(loadTasks()).toHaveLength(3);
  expect(h.launches()).toBe(1);
});

test("turn notices may be disabled while a stage helper still joins its task", async () => {
  const h = harness();
  const result = await h.service.callTool("spawn_agent", { ...h.args, notifyLauncher: false });
  expect(result).toMatchObject({ ok: true, launcherNotice: "off" });
  expect(holders(result.conversationId as string)).toEqual(["stage-work-a", "stage-work-b"]);
  expect(loadTasks()).toHaveLength(3);
});

test("a historical adopted helper holds no stage task context of its own", async () => {
  const h = harness();
  const lanes = loadPipelines();
  lanes[0]!.runs[0]!.attempts[0]!.historical = true;
  savePipelines(lanes);
  const result = await h.service.callTool("spawn_agent", h.args);
  expect(result).toMatchObject({ ok: true });
  expect(loadTasks()).toHaveLength(4);
  expect(holders(result.conversationId as string)).toHaveLength(1);
});
