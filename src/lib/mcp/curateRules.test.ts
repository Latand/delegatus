import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { afterEach, beforeEach, expect, test } from "bun:test";
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
afterEach(async () => { await shutdownTaskPageWorker(); setAgentRegistryForTests(null); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });

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
