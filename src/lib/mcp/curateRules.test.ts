import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { awaitFixtureFile } from "./fixtureBarrier";
import { ROLE_MEMORY_BOUND } from "@/lib/memory/roleTypes";
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
import { AgentRegistry, setAgentRegistryForTests, type RegistryFile } from "@/lib/agent/registry";
import { newRuleId, roleMemoryCollection, roleScope } from "@/lib/memory/roleStore";
import { claimPass, patchPass, readPass, curationCollection } from "@/lib/memory/curation/store";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, requestDigest, TOOL_INPUT_SCHEMAS } from "./server";
import type { ViewerMcpDomainDependencies } from "./bindings";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";

let root: string, previous: string | undefined;
beforeEach(() => { previous = process.env.LLV_STATE_DIR; root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curate-mcp-")); process.env.LLV_STATE_DIR = root; });
afterEach(async () => { await reapFixtureChildren(); setSystemTime(); await shutdownTaskPageWorker(); setAgentRegistryForTests(null); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });

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
    tx.put({ kind: "rule", id, scope, rule: "Read caller/owner/task identifiers before changing stored guidance.", why: "A previous edit used stale ownership evidence.", state: "active", hints: [], source: { project: CUSTODY_PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" }, createdAt: stamp, changedAt: stamp });
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
    expect(await call({ action: "read", scope, clientRequestId: "fresh-read" })).toMatchObject({ ok: true, revision: 1, bound: ROLE_MEMORY_BOUND, rules: [{ id, readabilityHint: { needsRewrite: true, signals: ["slash-list"] } }] });
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
    const rewritten = await call({ action: "read", scope, clientRequestId: "policy-cleared-read" });
    expect(rewritten).toMatchObject({ ok: true, revision: 2, bound: ROLE_MEMORY_BOUND, rules: [{ id, rule: "Read current scope ownership before every stored edit." }] });
    expect((rewritten as { rules: Record<string, unknown>[] }).rules[0]).not.toHaveProperty("readabilityHint");
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


/** All new cases use the exported HTTP route, SDK schema, production policy
 * and bindings with a registry-minted capability and the real custody guard. */
async function committedSdkFixture(store = new MemoryMcpReceiptStore()) {
  const { scheduledCustodyFixture, CUSTODY_PROJECT, CUSTODY_NOW } = await import("@/lib/memory/curation/custody.fixture");
  const admission = await import("@/lib/monitor/seatTickAdmissionSources");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { setMcpHttpDependenciesForTests } = await import("./http");
  const { POST } = await import("@/app/api/mcp/route");
  const { createHash } = await import("node:crypto");
  setSystemTime(new Date(CUSTODY_NOW));
  const f = scheduledCustodyFixture(root);
  setAgentRegistryForTests(f.registry);
  const scope = roleScope(CUSTODY_PROJECT, "builder"), id = "r_sdk-commit-source";
  roleMemoryCollection(true)!.boundedPatch(8, tx => {
    const stamp = new Date(CUSTODY_NOW).toISOString();
    tx.put({ kind: "rule", id, scope, rule: "Inspect the current scope before committing stored guidance.", why: "A previous change used an obsolete scope revision.", state: "active", hints: [], source: { project: CUSTODY_PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false }, createdAt: stamp, changedAt: stamp });
    tx.put({ kind: "scope", scope, revision: 1, active: [id], history: [] });
  });
  const clock = spyOn(admission, "defaultSeatTickAdmissionSources").mockImplementation(() => f.sources);
  const { pass, capability } = await f.start();
  const service = createMcpToolService(viewerMcpBindings(), store, viewerMcpToolPolicy());
  let afterAnswer: (() => void) | undefined;
  setMcpHttpDependenciesForTests({ service: async () => ({ async callTool(tool, args, context) {
    const result = await service.callTool(tool, args, context); afterAnswer?.(); return result;
  } }), conversationForCapability: value => f.registry.conversationIdForSpawnCapabilityDigest(createHash("sha256").update(value).digest("hex")) });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => POST(new NextRequest(request)) });
  const client = new Client({ name: "curator-commit", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/api/mcp`), { requestInit: { headers: { "x-llv-spawn-capability": capability } } }));
  } catch (error) { await client.close(); listener.stop(true); clock.mockRestore(); f.registry.close(); throw error; }
  const call = async (args: Record<string, unknown>) => {
    const answer = await client.callTool({ name: "curate_rules", arguments: args });
    if (!answer.structuredContent) throw new Error(JSON.stringify(answer));
    return answer.structuredContent as Record<string, unknown>;
  };
  const args = { action: "apply", clientRequestId: "committed-apply", scopes: [{ scope, revision: 1, order: [id] }],
    rewrite: [{ id, rule: "Check the current owner and scope before committing guidance.", note: "Keep the ownership check before the write." }] };
  return { f, pass, capability, id, scope, call, args, store, afterAnswer: (callback?: () => void) => { afterAnswer = callback; }, close: async () => {
    await client.close(); listener.stop(true); setMcpHttpDependenciesForTests(null); clock.mockRestore(); f.registry.close();
  } };
}

test("SDK lost acknowledgement replays the immutable editorial disposition after a later write", async () => {
  const f = await committedSdkFixture();
  try {
    const first = await f.call(f.args);
    expect(first).toMatchObject({ ok: true, disposition: "committed", revisions: [{ scope: f.scope, input: 1, result: 2 }], placeholders: {}, counts: { calls: 1, rewritten: 1 }, maintenance: { counts: "complete", knownValues: "complete", cleanup: "complete" } });
    const held = roleMemoryCollection()!;
    const committed = held.snapshot();
    expect(await f.call(f.args)).toEqual({ ...first, replayed: true });
    expect(held.snapshot()).toEqual(committed);
    expect(await f.call({ ...f.args, clientRequestId: "later-apply", scopes: [{ scope: f.scope, revision: 2, order: [f.id] }], rewrite: [{ id: f.id, rule: "Verify scope membership again before changing stored guidance.", note: "Retain this subsequent scope membership check." }] })).toMatchObject({ ok: true });
    const later = held.snapshot();
    expect(await f.call(f.args)).toEqual({ ...first, replayed: true });
    expect(held.snapshot()).toEqual(later);
    expect(await f.call({ ...f.args, clientRequestId: "new-stale-plan" })).toMatchObject({ ok: false, details: { code: "CURATE_STALE" } });
    expect(readPass(f.pass.id)!.counts.calls).toBe(2);
  } finally { await f.close(); }
});

test.each(["text", "note", "revision", "order", "target", "operation"])("SDK same-key changed %s conflicts without an effect", async field => {
  const f = await committedSdkFixture();
  try {
    expect(await f.call(f.args)).toMatchObject({ ok: true, disposition: "committed" });
    const before = roleMemoryCollection()!.snapshot();
    const changed = structuredClone(f.args);
    if (field === "text") changed.rewrite[0].rule = "Check the current scope revision before every stored guidance edit.";
    if (field === "note") changed.rewrite[0].note = "Retain this guidance at the receiving boundary.";
    if (field === "revision") changed.scopes[0].revision++;
    if (field === "order") changed.scopes[0].order = [];
    if (field === "target") changed.scopes[0].scope = "machine";
    if (field === "operation") changed.rewrite = [];
    expect(await f.call(changed)).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
  } finally { await f.close(); }
});

test.each(["counts", "known-values", "cleanup"])("SDK postcommit %s failure reports commit once with pending maintenance", async fault => {
  const f = await committedSdkFixture();
  const storeModule = await import("@/lib/memory/curation/store");
  const privacy = await import("@/lib/memory/privacy");
  const { StateLockDeferredError } = await import("@/lib/state/lockWait");
  let restore = () => {};
  try {
    if (fault === "counts") {
      const original = storeModule.patchPass;
      const mock = spyOn(storeModule, "patchPass").mockImplementation((id, patch) => {
        if (patch.counts && roleMemoryCollection()!.get(`s:${f.scope}`)?.kind === "scope") throw new StateLockDeferredError("fixture count persistence deferred");
        return original(id, patch);
      }); restore = () => mock.mockRestore();
    } else if (fault === "known-values") {
      fs.mkdirSync(path.dirname(lessonKnownValuesFile()), { recursive: true });
      fs.writeFileSync(lessonKnownValuesFile(), "The previous generated snapshot predates this editorial edit.\n");
      const mock = spyOn(privacy, "refreshCurationKnownValuesAsync").mockRejectedValue(new Error("fixture known-values unavailable"));
      restore = () => mock.mockRestore();
    } else {
      const held = roleMemoryCollection()! as unknown as { releaseLeaseSync(token: string): void };
      const original = held.releaseLeaseSync.bind(held);
      const mock = spyOn(held, "releaseLeaseSync").mockImplementation(token => { original(token); throw new Error("fixture postcommit cleanup refusal"); });
      restore = () => mock.mockRestore();
    }
    const first = await f.call(f.args);
    expect(first).toMatchObject({ ok: true, disposition: "committed", counts: { calls: 1, rewritten: 1 }, maintenance: { [fault === "known-values" ? "knownValues" : fault]: "pending" } });
    const snapshot = roleMemoryCollection()!.snapshot();
    restore(); restore = () => {};
    expect(await f.call(f.args)).toEqual({ ...first, replayed: true });
    expect(roleMemoryCollection()!.snapshot()).toEqual(snapshot);
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
    if (fault === "known-values") {
      expect(fs.existsSync(lessonKnownValuesFile())).toBe(false);
      const check = Bun.spawn([process.execPath, "scripts/privacy-publication-gate.ts", "--require-known-values", "--paths", "package.json"], {
        env: { ...process.env, LLV_PRIVACY_KNOWN_VALUES_FILE: lessonKnownValuesFile(), LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.resolve("scripts/privacy-known-value-fingerprints.json") }, stdout: "pipe", stderr: "pipe",
      });
      const [exit, output, errors] = await Promise.all([check.exited, new Response(check.stdout).text(), new Response(check.stderr).text()]);
      expect(exit).not.toBe(0); expect(output + errors).toMatch(/known|configuration|unavailable/i);
    }
  } finally { restore(); await f.close(); }
});

test("SDK authority lost after commit withholds contents, then original authority recovers the saved result", async () => {
  const f = await committedSdkFixture();
  const privacy = await import("@/lib/memory/privacy");
  const original = privacy.refreshCurationKnownValuesAsync;
  const refresh = spyOn(privacy, "refreshCurationKnownValuesAsync").mockImplementation(async () => {
    await original(); f.f.policy({ deployment: true });
  });
  try {
    const refused = await f.call(f.args);
    expect(refused).toMatchObject({ ok: false, details: { code: "CURATE_CALLER" } });
    expect(refused).not.toHaveProperty("operationId");
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
    expect(await f.call(f.args)).toMatchObject({ ok: false });
    f.f.policy({ deployment: false });
    refresh.mockRestore();
    expect(await f.call(f.args)).toMatchObject({ ok: true, replayed: true, disposition: "committed", counts: { calls: 1 } });
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
  } finally { refresh.mockRestore(); await f.close(); }
});

test("SDK legacy UNKNOWN and missing witnesses remain UNKNOWN without a new apply", async () => {
  const store = new MemoryMcpReceiptStore();
  const f = await committedSdkFixture(store);
  try {
    await store.claim(`curate_rules:${f.args.clientRequestId}`, requestDigest("curate_rules", f.args), "durable");
    const before = roleMemoryCollection()!.snapshot();
    expect(await f.call(f.args)).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown" } });
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
    expect(readPass(f.pass.id)!.counts.calls).toBe(0);
    expect(await f.call({ ...f.args, clientRequestId: "fresh-independent" })).toMatchObject({ ok: true });
  } finally { await f.close(); }
});


test.each([
  ["before-complete", "split"], ["after-complete", "split"],
  ["before-complete", "adopt"], ["after-complete", "adopt"],
] as const)("SDK %s process loss recovers original %s ids after an actual service restart", async (crash, kind) => {
  const candidate = importCandidate(1, { suggestedScope: "project:scheduled-custody-fixture" });
  candidate.occurrences[0].project = "scheduled-custody-fixture";
  if (kind === "adopt") await seedImport([candidate], "scheduled-custody-fixture");
  const f = await committedSdkFixture();
  const { CUSTODY_NOW } = await import("@/lib/memory/curation/custody.fixture");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const clients: InstanceType<typeof Client>[] = [];
  const start = async (generation: string, phase?: typeof crash) => {
    const configPath = path.join(root, `curator-${generation}.json`), portFile = path.join(root, `port-${generation}`), marker = path.join(root, `commit-${generation}`);
    fs.writeFileSync(configPath, JSON.stringify({ root, seatId: f.f.seatId, now: CUSTODY_NOW, portFile, marker, crash: phase }));
    const child = ownFixtureChild(Bun.spawn([process.execPath, path.join(import.meta.dir, "receiptStoreProbeChild.ts"), "curator-http", configPath], { env: { ...process.env }, stdout: "ignore", stderr: "inherit" }));
    await awaitFixtureFile(portFile);
    const client = new Client({ name: "curator-restart", version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${fs.readFileSync(portFile, "utf8")}/api/mcp`), { requestInit: { headers: { "x-llv-spawn-capability": f.capability } } }));
    return { child, client, marker };
  };
  try {
    if (kind === "adopt") expect(await f.call({ action: "read", scope: "imports", clientRequestId: "restart-import-read" })).toMatchObject({ ok: true });
    const args = kind === "adopt" ? { action: "apply", clientRequestId: "restart-adopt", scopes: [{ scope: candidate.suggestedScope, revision: 0, order: [`adopt:${candidate.id}:0`] }],
      adopt: [{ candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), parts: [{ to: candidate.suggestedScope, rule: "Verify current ownership immediately before changing shared state.", why: "A retained import records a recurring ownership check." }], note: "Retain this check with its project readers." }] }
      : { action: "apply", clientRequestId: "restart-split", scopes: [{ scope: f.scope, revision: 1, order: [f.id, `split:${f.id}:1`] }], split: [{ id: f.id,
      parts: [{ to: f.scope, rule: "Read the current scope before preparing stored guidance." }, { to: f.scope, rule: "Recheck current ownership immediately before the stored edit." }], note: "Keep preparation and commit checks independently readable." }] };
    const first = await start("first", crash);
    const lost = first.client.callTool({ name: "curate_rules", arguments: args }).catch(() => null);
    await awaitFixtureFile(first.marker);
    expect(await first.child.exited).toBe(79);
    await lost;
    const committed = JSON.parse(fs.readFileSync(first.marker, "utf8"));
    expect(committed).toMatchObject({ ok: true, disposition: "committed", counts: { calls: 1, split: kind === "split" ? 1 : 0 } });
    const snapshot = roleMemoryCollection()!.snapshot();
    const second = await start("second");
    expect(second.child.pid).not.toBe(first.child.pid);
    const replay = (await second.client.callTool({ name: "curate_rules", arguments: args })).structuredContent;
    expect(replay).toEqual({ ...committed, replayed: true });
    expect(roleMemoryCollection()!.snapshot()).toEqual(snapshot);
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
    if (kind === "adopt") {
      const { candidateById } = await import("@/lib/memory/importCuration");
      expect(candidateById(IMPORT_ID, candidate.id)!.dispositions).toHaveLength(1);
    }
    expect((await second.client.callTool({ name: "curate_rules", arguments: { ...args, clientRequestId: "independent-stale" } })).structuredContent).toMatchObject({ ok: false, details: { code: "CURATE_STALE" } });
  } finally { for (const client of clients) await client.close(); await reapFixtureChildren(); await f.close(); }
}, 30_000);


test.each(["fresh", "replay", "read"])("SDK %s disclosure rechecks authority after the service await", async mode => {
  const f = await committedSdkFixture();
  try {
    if (mode === "replay") expect(await f.call(f.args)).toMatchObject({ ok: true });
    f.afterAnswer(() => f.f.policy({ deployment: true }));
    const args = mode === "read" ? { action: "read", scope: f.scope, clientRequestId: "late-read-authority" } : f.args;
    const refused = await f.call(args);
    expect(refused).toMatchObject({ ok: false, details: { code: "CURATE_CALLER" } });
    expect(refused).not.toHaveProperty("operationId"); expect(refused).not.toHaveProperty("rules");
    f.afterAnswer(); f.f.policy({ deployment: false });
    if (mode !== "read") {
      expect(await f.call(f.args)).toMatchObject({ ok: true, disposition: "committed" });
      expect(readPass(f.pass.id)!.counts.calls).toBe(1);
    }
  } finally { await f.close(); }
});

test("SDK authority replacement after receipt claim refuses before any editorial effect", async () => {
  const store = new MemoryMcpReceiptStore();
  const f = await committedSdkFixture(store);
  const original = store.claim.bind(store);
  const claim = spyOn(store, "claim").mockImplementation((...args) => {
    const result = original(...args); f.f.policy({ deployment: true }); return result;
  });
  try {
    const before = roleMemoryCollection()!.snapshot();
    expect(await f.call(f.args)).toMatchObject({ ok: false, details: { code: "CURATE_CALLER" } });
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
    claim.mockRestore(); f.f.policy({ deployment: false });
    expect(await f.call(f.args)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(await f.call({ ...f.args, clientRequestId: "new-independent-owner" })).toMatchObject({ ok: true });
  } finally { claim.mockRestore(); await f.close(); }
});

test("SDK accepts four feasible scopes above the advisory aggregate and refuses a fitting budget archive", async () => {
  const f = await committedSdkFixture();
  try {
    const scopes = [f.scope, "role:*:builder", "project:scheduled-custody-fixture", "machine"];
    const ids = scopes.map((_, index) => `r_aggregate-${index}`);
    roleMemoryCollection()!.boundedPatch(16, tx => {
      for (const [index, scope] of scopes.entries()) {
        const source = roleMemoryCollection()!.get(`r:${f.id}`);
        if (source?.kind !== "rule") throw Error("missing source");
        tx.put({ ...source, id: ids[index], scope, rule: "Перевіряй поточного власника перед зміною збережених правил. ".repeat(70) });
        tx.put({ kind: "scope", scope, active: [ids[index]], revision: 1, history: [] });
      }
    });
    const { scopeChars } = await import("@/lib/memory/roleConsolidate");
    let aggregate = 0;
    for (const [index, scope] of scopes.entries()) {
      const read = await f.call({ action: "read", scope, clientRequestId: `aggregate-read-${index}` });
      expect(read).toMatchObject({ ok: true, bound: ROLE_MEMORY_BOUND });
      const rule = roleMemoryCollection()!.get(`r:${ids[index]}`);
      if (rule?.kind !== "rule") throw Error("missing aggregate rule");
      expect(scopeChars([rule])).toBeLessThan(ROLE_MEMORY_BOUND);
      aggregate += Buffer.byteLength(rule.rule);
    }
    expect(aggregate).toBeGreaterThan(16_000);
    expect(await f.call({ action: "apply", clientRequestId: "feasible-scopes", scopes: scopes.map((scope, index) => ({ scope, revision: 1, order: [ids[index]] })) })).toMatchObject({ ok: true, disposition: "committed" });
    expect(await f.call({ action: "apply", clientRequestId: "fitting-archive", scopes: [{ scope: f.scope, revision: 2, order: [] }], archive: [{ id: ids[0], reason: "budget", note: "Try to reduce the combined advisory total." }] })).toMatchObject({ ok: false, details: { code: "CURATE_BUDGET" } });
  } finally { await f.close(); }
});


test.each(["conversation", "project", "pass", "role", "ended", "host", "policy", "memory"])("SDK saved result denies changed %s authority without editorial writes", async change => {
  const f = await committedSdkFixture();
  const { chooseSource } = await import("@/lib/memory/fixtures/source");
  try {
    expect(await f.call(f.args)).toMatchObject({ ok: true, disposition: "committed" });
    const before = roleMemoryCollection()!.snapshot();
    const writer = f.f.registry as unknown as { mutate<T>(write: (snapshot: RegistryFile) => T): T };
    if (["conversation", "project", "pass", "role"].includes(change)) writer.mutate(snapshot => {
      const receipt = Object.values(snapshot.receipts).find(row => row.clientAttemptId === f.pass.id)!;
      const conversation = snapshot.conversations[f.pass.conversationId!];
      if (change === "conversation") receipt.conversationId = f.f.seatId as `conversation_${string}`;
      if (change === "project") { receipt.explicitProject = "other-project"; conversation.projectOwnership = { project: "other-project" } as never; }
      if (change === "pass") receipt.clientAttemptId = "curate_other-pass";
      if (change === "role") conversation.agentRole = "builder";
    });
    if (change === "ended") patchPass(f.pass.id, { state: "succeeded", endedAt: "2026-10-20T12:00:01.000Z" });
    if (change === "host") f.f.seat.seatEpoch++;
    if (change === "policy") f.f.policy({ curatorEnabled: false });
    if (change === "memory") chooseSource("engines");
    const answer = await f.call(f.args);
    expect(answer).toMatchObject({ ok: false });
    expect(answer).not.toHaveProperty("operationId"); expect(answer).not.toHaveProperty("placeholders");
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
  } finally { chooseSource("unchosen"); await f.close(); }
});


test("SDK pre-admission deferral retries safely and commits one editorial call", async () => {
  const f = await committedSdkFixture();
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const { StateLockDeferredError } = await import("@/lib/state/lockWait");
  const original = SqliteStateCollection.commitPatchesSync;
  let attempts = 0;
  const commit = spyOn(SqliteStateCollection, "commitPatchesSync").mockImplementation((patches, options) => {
    if (++attempts === 1) throw new StateLockDeferredError("fixture curator admission");
    return original(patches, options);
  });
  try {
    expect(await f.call(f.args)).toMatchObject({ ok: true, disposition: "committed", counts: { calls: 1 } });
    expect(attempts).toBe(2);
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
  } finally { commit.mockRestore(); await f.close(); }
});

test("SDK owner loss at final transaction admission rolls rules, history and witness back", async () => {
  const f = await committedSdkFixture();
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const original = SqliteStateCollection.commitPatchesSync;
  const commit = spyOn(SqliteStateCollection, "commitPatchesSync").mockImplementation((patches, options) => original(patches, { ...options,
    beforeCommit: () => { f.f.policy({ deployment: true }); options?.beforeCommit?.(); },
  }));
  try {
    const before = roleMemoryCollection()!.snapshot();
    expect(await f.call(f.args)).toMatchObject({ ok: false, details: { code: "CURATE_CALLER" } });
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
    expect(curationCollection()!.keyRange("o:", "o;", 2)).toEqual([]);
    commit.mockRestore(); f.f.policy({ deployment: false });
    expect(await f.call(f.args)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(await f.call({ ...f.args, clientRequestId: "fresh-after-rollback" })).toMatchObject({ ok: true });
  } finally { commit.mockRestore(); await f.close(); }
});

test("SDK final admission sees a concurrent scope writer and refuses its stale new-key plan", async () => {
  const f = await committedSdkFixture();
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const original = SqliteStateCollection.commitPatchesSync;
  const held = roleMemoryCollection()!;
  let intervened = false;
  const commit = spyOn(SqliteStateCollection, "commitPatchesSync").mockImplementation((patches, options) => {
    if (!intervened) {
      intervened = true;
      held.boundedPatch(2, tx => {
        const row = tx.get(`s:${f.scope}`);
        if (row?.kind === "scope") tx.put({ ...row, revision: row.revision + 1 });
      });
    }
    return original(patches, options);
  });
  try {
    expect(await f.call(f.args)).toMatchObject({ ok: false, details: { code: "CURATE_STALE" } });
    const row = held.get(`r:${f.id}`);
    expect(row).toMatchObject({ rule: "Inspect the current scope before committing stored guidance." });
    expect(curationCollection()!.keyRange("o:", "o;", 2)).toEqual([]);
    expect(readPass(f.pass.id)!.counts.calls).toBe(0);
  } finally { commit.mockRestore(); await f.close(); }
});


test.each(["missing", "unreadable", "unbound"])("SDK %s witness keeps the MCP receipt and editorial state unchanged", async fault => {
  const store = new MemoryMcpReceiptStore();
  const f = await committedSdkFixture(store);
  let restore = () => {};
  try {
    const first = await f.call(f.args);
    expect(first).toMatchObject({ ok: true, disposition: "committed" });
    const key = `curate_rules:${f.args.clientRequestId}`, receipt = store.lookup(key);
    const before = roleMemoryCollection()!.snapshot();
    const collection = curationCollection()!, rowKey = `o:${first.operationId}`;
    const witness = collection.get(rowKey);
    expect(witness?.kind).toBe("operation");
    expect(JSON.stringify(witness)).not.toContain(f.args.rewrite[0].rule);
    expect(JSON.stringify(witness)).not.toContain(f.args.rewrite[0].note);
    if (fault === "missing") collection.patchSync(() => ({ records: [], deleteKeys: [rowKey] }));
    if (fault === "unbound" && witness?.kind === "operation") collection.boundedPatch(2, tx => tx.put({ ...witness, conversationId: "conversation_other-curator" }));
    if (fault === "unreadable") {
      const original = collection.get.bind(collection);
      const read = spyOn(collection, "get").mockImplementation(key => {
        if (key === rowKey) throw new Error("fixture witness storage unreadable");
        return original(key);
      }); restore = () => read.mockRestore();
    }
    const result = await f.call(f.args);
    expect(result).toMatchObject({ ok: false });
    if (fault !== "unbound") expect(result).toMatchObject({ code: "outcome_unknown", details: { outcome: "unknown" } });
    expect(result).not.toHaveProperty("operationId"); expect(result).not.toHaveProperty("placeholders");
    expect(store.lookup(key)).toEqual(receipt);
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
  } finally { restore(); await f.close(); }
});


test.each(["a", "ї", "😀"])("SDK enforces the rendered %s codepoint boundary on keyed apply", async char => {
  const f = await committedSdkFixture();
  try {
    const held = roleMemoryCollection()!;
    const source = held.get(`r:${f.id}`);
    if (source?.kind !== "rule") throw Error("missing boundary source");
    const overhead = Array.from(`- [${f.id}] `).length;
    held.boundedPatch(2, tx => tx.put({ ...source, rule: char.repeat(ROLE_MEMORY_BOUND - overhead) }));
    const plan = { action: "apply", clientRequestId: "boundary-exact", scopes: [{ scope: f.scope, revision: 1, order: [f.id] }] };
    expect(await f.call(plan)).toMatchObject({ ok: true, disposition: "committed", revisions: [{ scope: f.scope, input: 1, result: 2 }] });
    const current = held.get(`r:${f.id}`);
    if (current?.kind !== "rule") throw Error("missing committed boundary source");
    held.boundedPatch(2, tx => tx.put({ ...current, rule: current.rule + char }));
    expect(await f.call({ ...plan, clientRequestId: "boundary-overflow", scopes: [{ scope: f.scope, revision: 2, order: [f.id] }] })).toMatchObject({ ok: false, details: { code: "CURATE_BOUND" } });
    expect(await f.call(plan)).toMatchObject({ ok: true, replayed: true, revisions: [{ scope: f.scope, input: 1, result: 2 }] });
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
  } finally { await f.close(); }
});


test("SDK canonical project succession preserves the original operation without replaying editorial work", async () => {
  const f = await committedSdkFixture();
  const { persistProjectAliases, resetProjectAliasesForTests } = await import("@/lib/projects/aliases");
  try {
    const first = await f.call(f.args);
    expect(first).toMatchObject({ ok: true, disposition: "committed" });
    const before = roleMemoryCollection()!.snapshot();
    expect(persistProjectAliases([{ source: "scheduled-custody-fixture", target: "renamed-custody-fixture", displayName: "renamed-custody-fixture" }])).toBe(true);
    resetProjectAliasesForTests();
    expect(await f.call(f.args)).toEqual({ ...first, replayed: true });
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
  } finally { resetProjectAliasesForTests(); await f.close(); }
});


test("SDK duplicate during held maintenance reads the commit without joining or redispatching the original", async () => {
  const f = await committedSdkFixture();
  const privacy = await import("@/lib/memory/privacy");
  const original = privacy.refreshCurationKnownValuesAsync;
  let reached!: () => void, release!: () => void;
  const maintenanceEntered = new Promise<void>(resolve => { reached = resolve; });
  const maintenanceRelease = new Promise<void>(resolve => { release = resolve; });
  const refresh = spyOn(privacy, "refreshCurationKnownValuesAsync").mockImplementation(async () => {
    reached(); await maintenanceRelease; await original();
  });
  let first: Promise<Record<string, unknown>> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    first = f.call(f.args);
    await maintenanceEntered;
    const before = roleMemoryCollection()!.snapshot();
    const duplicate = await Promise.race([f.call(f.args), new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("the duplicate joined held maintenance")), 2000);
    })]);
    expect(duplicate).toMatchObject({ ok: true, replayed: true, disposition: "committed", counts: { calls: 1 }, maintenance: { knownValues: "pending" } });
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    const completed = await first;
    expect(completed).toMatchObject({ ok: true, disposition: "committed", operationId: duplicate.operationId, revisions: duplicate.revisions, counts: duplicate.counts, placeholders: duplicate.placeholders, maintenance: { knownValues: "complete" } });
    expect(await f.call(f.args)).toEqual({ ...completed, replayed: true });
    expect(roleMemoryCollection()!.snapshot()).toEqual(before);
    expect(readPass(f.pass.id)!.counts.calls).toBe(1);
  } finally {
    if (deadline) clearTimeout(deadline);
    release(); await first?.catch(() => {});
    refresh.mockRestore(); await f.close();
  }
});
