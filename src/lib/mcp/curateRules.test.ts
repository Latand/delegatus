import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { afterEach, beforeEach, expect, test, spyOn, setSystemTime } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as roleMemoryPost } from "@/app/api/role-memory/route";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { importCandidate, seedImport, IMPORT_AT, IMPORT_ID } from "@/lib/memory/fixtures/import";
import { lessonKnownValuesFile } from "@/lib/memory/roleStore";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { newRuleId, roleMemoryCollection, roleScope } from "@/lib/memory/roleStore";
import { claimPass, patchPass, readPass } from "@/lib/memory/curation/store";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, TOOL_INPUT_SCHEMAS } from "./server";
import type { ViewerMcpDomainDependencies } from "./bindings";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";

let root: string, previous: string | undefined;
beforeEach(() => { previous = process.env.LLV_STATE_DIR; root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curate-mcp-")); process.env.LLV_STATE_DIR = root; });
afterEach(async () => { setSystemTime(); await shutdownTaskPageWorker(); setAgentRegistryForTests(null); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });

test("real MCP binding checks the live pass before dispatch and receipt replay", async () => {
  const scope = roleScope("mcp-fixture", "builder");
  const id = roleMemoryCollection(true)!.boundedPatch(8, tx => {
    const id = newRuleId(tx); const stamp = new Date().toISOString();
    tx.put({ kind: "rule", id, scope, rule: "Read the scope revision before proposing a stored change.", why: "A concurrent write had changed the guidance after its read.", state: "active", hints: [], source: { project: "mcp-fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: ["conversation", "fixture"].join("_") }, createdAt: stamp, changedAt: stamp });
    tx.put({ kind: "scope", scope, revision: 1, active: [id], history: [] }); return id;
  });
  const pass = claimPass({ project: "mcp-fixture", repoDir: root, now: Date.now() })!;
  const caller = ["conversation", "curator"].join("_") as `conversation_${string}`;
  const snapshot = structuredClone(new AgentRegistry(path.join(root, "registry.json")).readOnlySnapshot());
  snapshot.conversations[caller] = { id: caller, agentRole: "curator", projectOwnership: { project: "mcp-fixture" }, generations: [], continuityPaths: [] } as never;
  snapshot.receipts.fixture = { conversationId: caller, agentRole: "curator", clientAttemptId: pass.id, explicitProject: "mcp-fixture", state: "completed", launchId: "fixture", artifactPath: null } as never;
  const dependencies: ViewerMcpDomainDependencies = { ...productionDomainDependencies, registrySnapshot: () => snapshot, curatorSnapshot: () => snapshot, curatorAdmission: async () => {}, callerAttribution: () => ({ kind: "agent", conversationId: caller, role: snapshot.conversations[caller].agentRole ?? null }), attentionAuthority: () => ({ kind: "worker", conversationId: caller, role: "curator" } as never) };
  let resolutions = 0;
  const resolveCaller = dependencies.callerAttribution!;
  dependencies.callerAttribution = () => { resolutions++; return resolveCaller(); };
  const policy = viewerMcpToolPolicy(dependencies, false, () => ({ registrySnapshot: () => snapshot } as never));
  expect(policy.permit("create_task", withTaskDue({}))).toHaveProperty("allowed", false);
  expect(policy.permit("curate_rules", { action: "apply" })).toHaveProperty("allowed", true);
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), new MemoryMcpReceiptStore(), policy);
  const call = async (args: Parameters<typeof service.callTool>[1]) => {
    const before = resolutions;
    const result = await service.callTool("curate_rules", args);
    expect(resolutions - before).toBe(1);
    return result;
  };
  resolutions = 0;
  const read = await call({ clientRequestId: "read-fixture", action: "read", scope });
  expect(resolutions).toBe(1);
  expect(read.ok).toBe(true); expect(read).toHaveProperty("revision", 1);
  const args = { clientRequestId: "apply-fixture", action: "apply", scopes: [{ scope, revision: 1, order: [id] }] };
  expect((await call(args)).ok).toBe(true);
  expect((await call(args)).ok).toBe(true);
  expect(readPass(pass.id)!.counts.calls).toBe(1);
  dependencies.curatorAdmission = async () => { throw new DeliveryAdmissionRefusedError("seat wake expired"); };
  const blocked = await call({ clientRequestId: "stale-seat-read", action: "read", scope });
  expect(blocked.ok).toBe(false); expect(blocked).toHaveProperty("details.code", "CURATE_CALLER");
  expect(readPass(pass.id)!.counts.calls).toBe(1);
  dependencies.curatorAdmission = async () => {
    let checks = 0;
    return () => { if (++checks > 1) throw new DeliveryAdmissionRefusedError("fixture host expired during read"); };
  };
  const unhosted = await call({ clientRequestId: "host-expired-during-read", action: "read", scope });
  expect(unhosted.ok).toBe(false); expect(unhosted).toHaveProperty("details.code", "CURATE_CALLER");
  expect(unhosted).not.toHaveProperty("rules");
  dependencies.curatorAdmission = async () => {};
  let reads = 0;
  dependencies.curatorSnapshot = () => {
    if (++reads === 2) queueMicrotask(() => patchPass(pass.id, { state: "succeeded", endedAt: "2026-10-17T12:00:00.000Z" }));
    return snapshot;
  };
  const revoked = await call({ clientRequestId: "revoked-during-read", action: "read", scope });
  expect(revoked.ok).toBe(false); expect(revoked).toHaveProperty("details.code", "CURATE_CALLER");
  expect(revoked).not.toHaveProperty("rules");
  const replay = await call(args);
  expect(replay.ok).toBe(false); expect(replay).toHaveProperty("details.code", "CURATE_CALLER");
});

test("MCP schema keeps read and apply fields separate and requires widening notes at apply", () => {
  const schema = TOOL_INPUT_SCHEMAS.curate_rules;
  expect(schema.safeParse({ clientRequestId: "fixture", action: "read" }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "fixture", action: "apply" }).success).toBe(false);
  expect(schema.safeParse({ clientRequestId: "fixture", action: "read", restore: ["one"] }).success).toBe(false);
  expect(schema.safeParse({ clientRequestId: "fixture", action: "apply", scopes: [{ scope: "machine", revision: -1, order: [] }] }).success).toBe(false);
  const scopes = [{ scope: "role:fixture:builder", revision: 1, order: [] }];
  expect(schema.safeParse({ clientRequestId: "fixture", action: "apply", scopes, move: [{ id: "rule-one", to: "role:*:builder" }] }).success).toBe(false);
  expect(schema.safeParse({ clientRequestId: "fixture", action: "apply", scopes, move: [{ id: "rule-one", to: "role:*:builder", note: "Builders in every project use this." }] }).success).toBe(true);
});

test("the real import binding refreshes known values through the worker and operator Undo is durable and replayable", async () => {
  const project = "mcp-import", candidate = importCandidate(1, { suggestedScope: `project:${project}` });
  candidate.occurrences[0].project = project;
  await seedImport([candidate], project);
  const pass = claimPass({ project, repoDir: null, now: Date.parse(IMPORT_AT) })!;
  const caller = "conversation_import-curator" as const;
  const registry = new AgentRegistry(path.join(root, "fixture-registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  try {
    const snapshot = structuredClone(registry.readOnlySnapshot());
    snapshot.conversations[caller] = { id: caller, agentRole: "curator", projectOwnership: { project }, generations: [], continuityPaths: [] } as never;
    snapshot.receipts.fixture = { conversationId: caller, agentRole: "curator", clientAttemptId: pass.id, explicitProject: project, state: "completed", launchId: "fixture", artifactPath: null } as never;
    const dependencies: ViewerMcpDomainDependencies = { ...productionDomainDependencies, registrySnapshot: () => snapshot, curatorSnapshot: () => snapshot,
      curatorAdmission: async () => () => {}, callerAttribution: () => ({ kind: "agent", conversationId: caller, role: "curator" }), attentionAuthority: () => ({ kind: "worker", conversationId: caller, role: "curator" } as never) };
    const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies, false, () => ({ registrySnapshot: () => snapshot } as never)));
    expect((await service.callTool("curate_rules", { clientRequestId: "import-read", action: "read", scope: "imports" })).ok).toBe(true);
    const rule = "Inspect current ownership before changing a shared worker.";
    const result = await service.callTool("curate_rules", { clientRequestId: "import-adopt", action: "apply", scopes: [{ scope: candidate.suggestedScope, revision: 0, order: [`adopt:${candidate.id}:0`] }], adopt: [{ candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), parts: [{ to: candidate.suggestedScope, rule, why: "An imported note records a recurring ownership check." }], note: "Retain this check with its project readers." }] });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(lessonKnownValuesFile(), "utf8")).toContain(rule);
    const request = (origin = "http://localhost") => new NextRequest("http://localhost/api/role-memory", { method: "POST", headers: { Cookie: `llv_operator=${soloBrowserSession()}`, Origin: origin, host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify({ project, action: "revert-pass", ruleId: pass.id }) });
    const live = await roleMemoryPost(request());
    expect(live.status).toBe(409); expect(await live.json()).toEqual({ error: "CURATE_LIVE" });
    patchPass(pass.id, { state: "succeeded", endedAt: "2026-10-19T00:00:01.000Z" });
    expect((await roleMemoryPost(request("https://other.example"))).status).toBe(403);
    expect(readPass(pass.id)?.revertedAt).toBeUndefined();
    // Discard the first acknowledgement; the same operator action reconciles it.
    expect((await roleMemoryPost(request())).status).toBe(200);
    const replay = await roleMemoryPost(request());
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.undo).toMatchObject({ skipped: [], importUndo: { state: "undone", kept: 0, candidates: [{ candidate: candidate.id, state: "pending" }] } });
    expect(readPass(pass.id)?.revertedAt).toBeDefined();
    const { readImportCandidates } = await import("@/lib/memory/importStore");
    expect(readImportCandidates(IMPORT_ID).candidates[0].dispositions).toHaveLength(1);
  } finally { setAgentRegistryForTests(null); registry.close(); }
});


test.each(["read", "apply"] as const)("scheduled custody keeps SDK HTTP %s past the delivered wake boundary", async action => {
  const { scheduledCustodyFixture, CUSTODY_PROJECT, CUSTODY_NOW } = await import("@/lib/memory/curation/custody.fixture");
  const { curatorRecoveryGuard } = await import("@/lib/memory/curation/admission");
  const admission = await import("@/lib/monitor/seatTickAdmissionSources");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { setMcpHttpDependenciesForTests } = await import("./http");
  const { POST } = await import("@/app/api/mcp/route");
  const { createHash } = await import("node:crypto");
  setSystemTime(new Date(CUSTODY_NOW));
  const f = scheduledCustodyFixture(root);
  setAgentRegistryForTests(f.registry);
  const scope = roleScope(CUSTODY_PROJECT, "builder");
  const id = roleMemoryCollection(true)!.boundedPatch(8, tx => {
    const id = newRuleId(tx), stamp = new Date(CUSTODY_NOW).toISOString();
    tx.put({ kind: "rule", id, scope, rule: "Read scope ownership before changing stored guidance.", why: "A previous edit used stale ownership evidence.", state: "active", hints: [], source: { project: CUSTODY_PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" }, createdAt: stamp, changedAt: stamp });
    tx.put({ kind: "scope", scope, revision: 1, active: [id], history: [] }); return id;
  });
  const clock = spyOn(admission, "defaultSeatTickAdmissionSources").mockImplementation(() => f.sources);
  let client: InstanceType<typeof Client> | undefined;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  try {
    const { pass, capability } = await f.start();
    expect(f.launches).toBe(1);
    // Production attribution resolves the registry-minted capability. No caller
    // or curator-admission override is installed in the MCP domain dependencies.
    const service = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore(), viewerMcpToolPolicy());
    setMcpHttpDependenciesForTests({ service: async () => service,
      conversationForCapability: value => f.registry.conversationIdForSpawnCapabilityDigest(createHash("sha256").update(value).digest("hex")) });
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => POST(new NextRequest(request)) });
    client = new Client({ name: "scheduled-custody", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/api/mcp`), { requestInit: { headers: { "x-llv-spawn-capability": capability } } }));
    const call = async (args: Record<string, unknown>) => (await client!.callTool({ name: "curate_rules", arguments: args })).structuredContent;
    expect(await call({ action: "read", scope, clientRequestId: "fresh-read" })).toMatchObject({ ok: true, revision: 1 });
    f.setNow(CUSTODY_NOW + 20 * 60_000 + 1);
    if (action === "read") expect(await call({ action: "read", scope, clientRequestId: "aged-read" })).toMatchObject({ ok: true, revision: 1 });
    const args = { action: "apply", scopes: [{ scope, revision: 1, order: [id] }], rewrite: [{ id, rule: "Read current scope ownership before every stored edit.", note: "Retain the ownership check on each edit." }], clientRequestId: "aged-apply" };
    expect(await call(args)).toMatchObject({ ok: true });
    expect(await call(args)).toMatchObject({ ok: true, replayed: true });
    expect(readPass(pass.id)).toMatchObject({ state: "running", counts: { calls: 1, changed: 1, rewritten: 1 } });
    expect(await f.controller.reconcile(CUSTODY_PROJECT)).toBeNull();
    const guard = await curatorRecoveryGuard(pass.conversationId!, f.sources);
    guard();
    f.policy({ deployment: true });
    expect(await call({ action: "read", scope, clientRequestId: "policy-held-read" })).toMatchObject({ ok: false, details: { code: "CURATE_CALLER" } });
    expect(await call({ ...args, scopes: [{ scope, revision: 2, order: [id] }], clientRequestId: "policy-held-apply" })).toMatchObject({ ok: false, details: { code: "CURATE_CALLER" } });
    f.policy({ deployment: false });
    expect(await call({ action: "read", scope, clientRequestId: "policy-cleared-read" })).toMatchObject({ ok: true, revision: 2 });
    const { chooseSource } = await import("@/lib/memory/fixtures/source");
    chooseSource("engines");
    try {
      expect(await call({ action: "read", scope, clientRequestId: "memory-off-read" })).toMatchObject({ ok: false });
    } finally { chooseSource("unchosen"); }
    f.setNow(CUSTODY_NOW + 60 * 60_000);
    expect(await call(args)).toMatchObject({ ok: false, details: { code: "CURATE_CALLER" } });
    expect(readPass(pass.id)).toMatchObject({ state: "failed", failure: "timed-out", counts: { calls: 1, changed: 1 } });
  } finally {
    await client?.close(); listener?.stop(true);
    setMcpHttpDependenciesForTests(null); clock.mockRestore(); f.registry.close();
  }
});
