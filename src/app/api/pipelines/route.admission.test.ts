import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { getPipelines } from "@/lib/pipelines/engine";
import { loadTasks } from "@/lib/tasks/store";
import { executeOrchestratorRotation, executeOrchestratorSeatRequest, type SeatCommandDependencies } from "@/lib/orchestrator/seatCommand";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { createMcpToolService, MemoryMcpReceiptStore } from "@/lib/mcp/server";
import { productionDomainDependencies, viewerMcpBindings } from "@/lib/mcp/bindings";

const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-admission-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
fs.mkdirSync(path.join(process.env.LLV_CODEX_HOME, "sessions"), { recursive: true });

const { agentRegistry } = await import("@/lib/agent/registry");
const { POST } = await import("./route");
const { PATCH } = await import("./[id]/route");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function seedCaller(role: string, parentConversationId: ViewerConversationId | null = null): { capability: string; conversationId: ViewerConversationId; path: string } {
  const store = agentRegistry();
  const capability = crypto.randomBytes(32).toString("base64url");
  const reviews = role === "reviewer"
    ? store.ensureConversation("codex", `/sessions/reviewed-${crypto.randomUUID()}.jsonl`, "terra").id
    : null;
  const begun = beginLegacySpawnFixture(store, {
    engine: "codex",
    cwd: "/repo",
    role,
    reviewsConversationId: reviews,
    parentConversationId: parentConversationId ?? reviews,
    origin: parentConversationId
      ? { kind: "agent", conversationId: parentConversationId }
      : { kind: "operator" },
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(process.env.LLV_CODEX_HOME!, "sessions", `caller-${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error(`settlement conflict: ${settled.code}`);
  return { capability, conversationId: settled.conversation.id, path: artifactPath };
}

function pipelineRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("an authenticated reviewer caller cannot create a pipeline", async () => {
  const caller = seedCaller("reviewer");
  const response = await POST(pipelineRequest(
    { task: "escape", repoDir: process.cwd(), src: caller.path },
    { "x-llv-spawn-capability": caller.capability },
  ));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "reviewer_origin_spawn",
    error: expect.stringContaining("in-session"),
  });
});

test("a declared reviewer src is rejected even without a capability header", async () => {
  const caller = seedCaller("verifier");
  const response = await POST(pipelineRequest({ task: "escape", repoDir: process.cwd(), src: caller.path }));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "reviewer_origin_spawn" });
});

test("an authenticated builder caller without src derives durable creator lineage", async () => {
  const caller = seedCaller("builder");
  const authenticated = await POST(pipelineRequest(
    { task: "derived creator", repoDir: process.cwd(), autoStart: false, stages: [] },
    { "x-llv-spawn-capability": caller.capability },
  ));
  expect(authenticated.status).toBe(201);
  expect(await authenticated.json()).toMatchObject({
    pipeline: {
      srcPath: caller.path,
      srcConversationId: caller.conversationId,
    },
  });
});

test("an unattributed caller must pass src when creating a pipeline", async () => {
  const external = await POST(pipelineRequest({
    task: "missing creator",
    repoDir: process.cwd(),
    autoStart: false,
    stages: [],
  }));
  expect(external.status).toBe(400);
  /* #1026: the HTTP surface carries the same field-level violation list the MCP
     tool returns, so both callers read one contract. */
  expect(await external.json()).toEqual({
    error: "pipeline creator lineage is required; pass src",
    violations: [{
      field: "src",
      message: "pipeline creator lineage is required; pass src",
      expected: expect.stringContaining("shared/claude/projects"),
    }],
  });
});

test("a capability header that does not authenticate is rejected before pipeline creation", async () => {
  const response = await POST(pipelineRequest(
    { task: "escape", repoDir: process.cwd() },
    { "x-llv-spawn-capability": "B".repeat(43) },
  ));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: expect.stringContaining("x-llv-spawn-capability") });
});

test("rotation revokes A's pipeline control while B, its builder and a live deputy can create work", async () => {
  const a = seedCaller("orchestrator");
  const b = seedCaller("orchestrator");
  const builder = seedCaller("builder", b.conversationId);
  const deputy = seedCaller("builder", b.conversationId);
  let next = a;
  const deps: SeatCommandDependencies = {
    spawn: async () => ({ status: 200, body: { ok: true, conversationId: next.conversationId, path: next.path } }),
    deliver: async () => ({ ok: true, outcome: "delivered" }),
    conversationTarget: id => ({ kind: "eligible", conversationId: id, path: id === a.conversationId ? a.path : b.path, cwd: process.cwd(), project: "proj-a", engine: "codex" }),
    resolvedConversation: id => ({ conversationId: id, path: id === a.conversationId ? a.path : b.path, holdsTurns: true, cwd: process.cwd() }),
    stampRegistryIdentity: () => {},
    projectTasks: () => [],
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => ({ kind: "unknown" }),
    runtimeIdentity: () => ({ engine: null, model: null }),
    now: () => "2026-09-28T00:00:00.000Z",
  };
  const seated = await executeOrchestratorSeatRequest({ project: "proj-a", clientRequestId: "seat-authority-a", mandate: "edited mandate", engine: "codex", model: "gpt-6-sol", cwd: process.cwd() }, deps);
  expect(seated.status).toBe(200);
  const request = (caller: typeof a, task: string) => ({ task, repoDir: process.cwd(), src: caller.path, autoStart: false, stages: [] });
  const predecessorCreate = await POST(pipelineRequest(request(a, "incumbent lane"), { "x-llv-spawn-capability": a.capability }));
  expect(predecessorCreate.status).toBe(201);
  const predecessor = await predecessorCreate.json() as { pipeline: { id: string } };
  next = b;
  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "seat-authority-b" }, deps);
  expect(rotated.status).toBe(200);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(b.conversationId);
  const beforeRefusal = {
    pipelines: getPipelines().pipelines.length,
    tasks: loadTasks().length,
    launches: Object.keys(agentRegistry().readOnlySnapshot().receipts).length,
  };

  let actor = a;
  const domain = { ...productionDomainDependencies, callerAttribution: () => actor === deputy
    ? { kind: "manager" as const, conversationId: b.conversationId, role: "builder", via: { deputy: deputy.conversationId } }
    : { kind: "agent" as const, conversationId: actor.conversationId, role: actor === builder ? "builder" : "orchestrator" } };
  const mcp = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), new MemoryMcpReceiptStore());
  const rejected = await mcp.callTool("create_pipeline", { clientRequestId: "revoked-create", ...request(a, "old seat duplicate") });
  expect(rejected).toMatchObject({ ok: false });
  expect(JSON.stringify(rejected)).toContain(b.conversationId);
  const refusedAction = await mcp.callTool("pipeline_action", { clientRequestId: "revoked-action", pipelineId: predecessor.pipeline.id, action: "pause" });
  expect(refusedAction).toMatchObject({ ok: false });
  expect(JSON.stringify(refusedAction)).toContain(b.conversationId);

  const oldAction = await PATCH(new NextRequest(`http://127.0.0.1:8898/api/pipelines/${predecessor.pipeline.id}`, {
    method: "PATCH", headers: { host: "127.0.0.1:8898", "content-type": "application/json", "x-llv-spawn-capability": a.capability },
    body: JSON.stringify({ action: "pause" }),
  }), { params: Promise.resolve({ id: predecessor.pipeline.id }) });
  expect(oldAction.status).toBe(403);
  expect(await oldAction.json()).toMatchObject({ code: "orchestrator_seat_revoked", error: expect.stringContaining(b.conversationId) });
  const oldHttpCreate = await POST(pipelineRequest(request(a, "old HTTP duplicate"), { "x-llv-spawn-capability": a.capability }));
  expect(oldHttpCreate.status).toBe(403);
  expect(await oldHttpCreate.json()).toMatchObject({ code: "orchestrator_seat_revoked", error: expect.stringContaining(b.conversationId) });
  const oldBrowserCreate = await POST(pipelineRequest(request(a, "old browser header duplicate"), {
    "x-llv-spawn-capability": a.capability,
    origin: "http://127.0.0.1:8898",
    "sec-fetch-site": "same-origin",
  }));
  expect(oldBrowserCreate.status).toBe(403);
  expect(await oldBrowserCreate.json()).toMatchObject({ code: "orchestrator_seat_revoked", error: expect.stringContaining(b.conversationId) });
  const oldSourceCreate = await POST(pipelineRequest(request(a, "old source duplicate")));
  expect(oldSourceCreate.status).toBe(403);
  expect(await oldSourceCreate.json()).toMatchObject({ code: "orchestrator_seat_revoked" });
  expect(productionDomainDependencies.callerAttribution?.()).toMatchObject({ kind: "unidentified", conversationId: null });
  const unidentifiedMcp = createMcpToolService(viewerMcpBindings(undefined, undefined, productionDomainDependencies), new MemoryMcpReceiptStore());
  const oldUnattributedCreate = await unidentifiedMcp.callTool("create_pipeline", {
    clientRequestId: "revoked-src-create", ...request(a, "old unattributed duplicate"),
  });
  expect(oldUnattributedCreate).toMatchObject({ ok: false });
  expect(JSON.stringify(oldUnattributedCreate)).toContain(b.conversationId);
  expect({ pipelines: getPipelines().pipelines.length, tasks: loadTasks().length, launches: Object.keys(agentRegistry().readOnlySnapshot().receipts).length }).toEqual(beforeRefusal);

  const operatorCreate = await POST(pipelineRequest({ task: "operator lane", repoDir: process.cwd(), autoStart: false, stages: [] }, {
    origin: "http://127.0.0.1:8898", "sec-fetch-site": "same-origin",
  }));
  expect(operatorCreate.status).toBe(201);
  const created = await POST(pipelineRequest(request(b, "successor lane"), { "x-llv-spawn-capability": b.capability }));
  expect(created.status).toBe(201);
  actor = b;
  const successorCreate = await mcp.callTool("create_pipeline", { clientRequestId: "successor-create", ...request(b, "new seat lane") });
  expect(successorCreate).toMatchObject({ ok: true });
  actor = builder;
  const builderCreate = await mcp.callTool("create_pipeline", { clientRequestId: "builder-create", ...request(builder, "builder lane") });
  expect(builderCreate).toMatchObject({ ok: true });
  actor = deputy;
  const deputyCreate = await mcp.callTool("create_pipeline", { clientRequestId: "deputy-create", ...request(deputy, "deputy lane") });
  expect(deputyCreate).toMatchObject({ ok: true });
});
