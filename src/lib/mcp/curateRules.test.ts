import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { newRuleId, roleMemoryCollection, roleScope } from "@/lib/memory/roleStore";
import { claimPass, patchPass, readPass } from "@/lib/memory/curation/store";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, TOOL_INPUT_SCHEMAS } from "./server";
import type { ViewerMcpDomainDependencies } from "./bindings";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";

let root: string, previous: string | undefined;
beforeEach(() => { previous = process.env.LLV_STATE_DIR; root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curate-mcp-")); process.env.LLV_STATE_DIR = root; });
afterEach(() => { if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });

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
  const dependencies: ViewerMcpDomainDependencies = { ...productionDomainDependencies, registrySnapshot: () => snapshot, curatorAdmission: async () => {}, callerAttribution: () => ({ kind: "agent", conversationId: caller, role: snapshot.conversations[caller].agentRole ?? null }), attentionAuthority: () => ({ kind: "worker", conversationId: caller, role: "curator" } as never) };
  const policy = viewerMcpToolPolicy(dependencies, false, () => ({ registrySnapshot: () => snapshot } as never));
  expect(policy.permit("create_task", {})).toHaveProperty("allowed", false);
  expect(policy.permit("curate_rules", { action: "apply" })).toHaveProperty("allowed", true);
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), new MemoryMcpReceiptStore(), policy);
  const read = await service.callTool("curate_rules", { clientRequestId: "read-fixture", action: "read", scope });
  expect(read.ok).toBe(true); expect(read).toHaveProperty("revision", 1);
  const args = { clientRequestId: "apply-fixture", action: "apply", scopes: [{ scope, revision: 1, order: [id] }] };
  expect((await service.callTool("curate_rules", args)).ok).toBe(true);
  expect((await service.callTool("curate_rules", args)).ok).toBe(true);
  expect(readPass(pass.id)!.counts.calls).toBe(1);
  dependencies.curatorAdmission = async () => { throw new DeliveryAdmissionRefusedError("seat wake expired"); };
  const blocked = await service.callTool("curate_rules", { clientRequestId: "stale-seat-read", action: "read", scope });
  expect(blocked.ok).toBe(false); expect(blocked).toHaveProperty("details.code", "CURATE_CALLER");
  expect(readPass(pass.id)!.counts.calls).toBe(1);
  dependencies.curatorAdmission = async () => {};
  patchPass(pass.id, { state: "succeeded", endedAt: new Date().toISOString() });
  const replay = await service.callTool("curate_rules", args);
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
