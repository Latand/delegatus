import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { createGateSandbox, isolatedEnvironment } from "../../../scripts/local-gate";

const original = { ...process.env }, root = createGateSandbox();
Object.assign(process.env, isolatedEnvironment(root, checkEnvironment(original)));
delete process.env.LLV_SPAWN_CAPABILITY;
process.env.DELEGATUS_CODEX_HOME = process.env.LLV_CODEX_HOME = process.env.CODEX_HOME;
process.env.DELEGATUS_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
const { PATCH } = await import("@/app/api/pipelines/[id]/route");
const { POST } = await import("@/app/api/mcp/route");
const { setMcpHttpDependenciesForTests } = await import("./http");
const { agentRegistry, closeAgentRegistryForTests } = await import("@/lib/agent/registry");
const { spawnCapabilityDigest } = await import("@/lib/agent/callerClaims");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { createMcpToolService, SqliteMcpReceiptStore, requestDigest } = await import("./server");
const { viewerMcpBindings, viewerMcpToolPolicy, productionDomainDependencies } = await import("./bindings");
const { withWorkspaceMcpFence } = await import("./workspaceFence");
const { runAsMcpHttpCaller } = await import("./callerContext");
const { buildPipeline, savePipelines, loadPipelines, pipelineRevision } = await import("../pipelines/store");
const { patchPipeline, defaultPipelinePorts, getPipeline } = await import("../pipelines/engine");
const { injectStateWriteFaultForTests } = await import("../state/sqliteStateStore");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } = await import("../orchestrator/seats");
const { beginDeputy, recordDeputyFork } = await import("../orchestrator/deputies");
const { teamStore, teamStoreFile, resetTeamStoreForTests } = await import("../team/store");
const { createWorkspace } = await import("../team/workspaces");
const { sharedClaudeProjectsRoot } = await import("../accounts/claude");
type Ports = import("../pipelines/engine").PipelinePorts;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
afterAll(() => {
  setMcpHttpDependenciesForTests(null);
  closeAgentRegistryForTests();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  fs.rmSync(root, { recursive: true, force: true });
});

let serial = 0;
async function fixture(engine: "codex" | "claude" = "codex", closed = false, workspace?: { memberId: string; workspaceId: string }, mirror = false) {
  const n = ++serial, project = "source-fixture", registry = agentRegistry();
  const resources: { client?: Client; listener?: ReturnType<typeof Bun.serve> } = {};
  let receipts: InstanceType<typeof SqliteMcpReceiptStore> | undefined;
  cleanups.push(async () => {
    try { await resources.client?.close(); }
    finally { resources.listener?.stop(true); receipts?.close(); setMcpHttpDependenciesForTests(null); }
  });
  const register = (name: string) => {
    const id = `conversation_source_${n}_${name}` as const;
    const native = path.join(engine === "codex" ? process.env.CODEX_HOME! : process.env.LLV_CLAUDE_HOME!,
      engine === "codex" ? "sessions" : "projects", "fixture", `${id}.jsonl`);
    const src = mirror && name === "creator" ? path.join(sharedClaudeProjectsRoot(), "fixture", `${id}.jsonl`) : native;
    fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, "");
    const started = registry.beginSpawnRequest({ engine, cwd: root, explicitProject: project, transport: "structured", conversationId: id,
      role: "builder", clientAttemptId: id, launchProfile: emptyLaunchProfile({ cwd: root, project, title: "Source fixture", role: "worker", workspace }) });
    if (started.kind !== "created") throw new Error("fixture spawn not created");
    registry.settleSpawn(started.receipt.launchId, { key: { engine, sessionId: id }, artifactPath: src, cwd: root, accountId: "default",
      status: "unhosted", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    return { id, src, native, launchId: started.receipt.launchId, capability: registry.rotateSpawnCapabilityForReceipt(started.receipt.launchId) };
  };
  const caller = register("caller"), source = register("creator"), other = register("other");
  const pipeline = buildPipeline({ id: `a${String(n).padStart(7, "0")}`, task: "Source fixture", state: "draft", project, repoDir: root,
    stages: [], srcPath: null, srcConversationId: null, now: "2026-11-06T00:00:00.000Z" });
  if (closed) { pipeline.state = "closed"; pipeline.closedAt = "2026-11-06T01:00:00.000Z"; }
  savePipelines([pipeline]);
  let dispatches = 0;
  let ports: Partial<Ports> = {};
  let beforeDispatch: (() => void) | undefined;
  const domain = {
    ...productionDomainDependencies,
    readPipelineRecord: getPipeline,
    patchPipeline: ((...args: Parameters<typeof patchPipeline>) => {
      dispatches++; beforeDispatch?.();
      args[2] = { ...defaultPipelinePorts(), ...ports };
      return patchPipeline(...args);
    }),
  };
  const bindings = viewerMcpBindings(undefined, undefined, domain);
  receipts = new SqliteMcpReceiptStore(path.join(root, `receipts-${n}.sqlite`));
  // The production service wraps its bindings with the same workspace fence.
  const dependencies = { ...productionDomainDependencies, ...domain };
  const makeService = () => withWorkspaceMcpFence(createMcpToolService(bindings, receipts!, viewerMcpToolPolicy(dependencies)), dependencies);
  let service = makeService();
  let afterResponse: (() => void) | undefined;
  setMcpHttpDependenciesForTests({ service: async () => ({ async callTool(...args: Parameters<typeof service.callTool>) {
    const answer = await service.callTool(...args);
    afterResponse?.();
    return answer;
  } }),
    conversationForCapability: value => registry.conversationIdForSpawnCapabilityDigest(spawnCapabilityDigest(value)) });
  const listener = resources.listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/api/mcp"
    ? POST(new NextRequest(request)) : PATCH(new NextRequest(request), { params: Promise.resolve({ id: pipeline.id }) }) });
  const client = resources.client = new Client({ name: "source-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
    requestInit: { headers: { "x-llv-spawn-capability": caller.capability } },
  }));
  const args = (key: string, fields: Record<string, unknown> = {}) => ({ pipelineId: pipeline.id, action: "set-src", src: source.src, clientRequestId: `${n}-${key}`, ...fields });
  return { client, caller, source, other, pipeline, registry, bindings, listener,
    args, call: async (key: string, fields: Record<string, unknown> = {}) => CallToolResultSchema.parse(await client.callTool({ name: "pipeline_action", arguments: args(key, fields) })),
    row: () => getPipeline(pipeline.id)!, count: () => dispatches,
    receipts: () => receipts!, afterResponse: (value: () => void) => { afterResponse = value; },
    ports: (value: Partial<Ports>) => { ports = value; }, before: (value: () => void) => { beforeDispatch = value; },
    reopen: () => { receipts!.close(); receipts = new SqliteMcpReceiptStore(path.join(root, `receipts-${n}.sqlite`)); service = makeService(); },
  };
}

test("tools/list advertises the source and replacement flag", async () => {
  const f = await fixture();
  const schema = (await f.client.listTools()).tools.find(tool => tool.name === "pipeline_action")!.inputSchema;
  expect(schema.properties?.src).toMatchObject({ type: "string" });
  expect(schema.properties?.overwrite).toMatchObject({ type: "boolean" });
  expect(schema.properties?.srcPath).toBeUndefined();
});

for (const engine of ["codex", "claude"] as const) test(`${engine} caller adopts a registered source, reloads and replays after receipt reopen`, async () => {
  const f = await fixture(engine, engine === "claude"), before = f.row();
  const accepted = await f.call("adopt");
  expect(accepted.structuredContent).toMatchObject({ ok: true });
  const row = f.row();
  expect(row).toEqual({ ...before, srcPath: f.source.src, srcConversationId: f.source.id });
  expect(loadPipelines().find(p => p.id === row.id)).toEqual(row);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  try {
    const persisted = db.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key=?").get(row.id)!;
    expect(JSON.parse(persisted.value_json)).toMatchObject({ srcPath: f.source.src, srcConversationId: f.source.id });
  } finally { db.close(); }
  const reader = `import { findPipelineRecord } from ${JSON.stringify(path.resolve("src/lib/pipelines/store.ts"))}; console.log(JSON.stringify(findPipelineRecord(${JSON.stringify(row.id)})));`;
  const reloaded = spawnSync(process.execPath, ["-e", reader], { env: process.env, encoding: "utf8" });
  expect(reloaded.status).toBe(0);
  expect(JSON.parse(reloaded.stdout.trim())).toEqual(row);
  f.reopen();
  expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: true, replayed: true });
  expect(f.count()).toBe(1); expect(f.row()).toEqual(row);
  expect((await f.call("adopt", { src: f.other.src })).isError).toBe(true);
  expect(f.count()).toBe(1); expect(f.row()).toEqual(row);
});

test("replacement requires explicit true and same lineage remains accepted", async () => {
  const f = await fixture();
  expect((await f.call("first")).isError).not.toBe(true);
  const before = f.row(), revision = pipelineRevision(before);
  for (const overwrite of [undefined, false, "true", 1, null]) {
    expect((await f.call(`replace-${String(overwrite)}`, { src: f.other.src, overwrite })).isError).toBe(true);
    expect(f.row()).toEqual(before); expect(pipelineRevision(f.row())).toBe(revision);
  }
  expect((await f.call("same")).isError).not.toBe(true);
  expect((await f.call("replace", { src: f.other.src, overwrite: true })).structuredContent).toMatchObject({ ok: true });
  expect(f.row()).toEqual({ ...before, srcPath: f.other.src, srcConversationId: f.other.id });
});

test("malformed, unknown and fabricated inputs leave the whole row unchanged", async () => {
  const f = await fixture(), before = f.row();
  fs.writeFileSync(path.join(process.env.CODEX_HOME!, "sessions", "unknown.jsonl"), "");
  const inputs = [ { src: undefined }, { src: " " }, { src: 7 }, { src: {} }, { src: path.join(root, "forbidden.jsonl") },
    { src: path.join(process.env.CODEX_HOME!, "sessions", "unknown.jsonl") }, { pipelineId: "deadbeef" }, { action: "unknown" },
    { src: undefined, srcPath: f.source.src }, { srcPath: f.other.src }, { extra: true }, { srcConversationId: f.other.id }, { srcDeputyConversationId: f.other.id } ];
  for (const [i, input] of inputs.entries()) {
    expect((await f.call(`invalid-${i}`, input)).isError).toBe(true); expect(f.row()).toEqual(before);
  }
  await expect(runAsMcpHttpCaller({ capability: f.caller.capability }, () => f.bindings.pipeline_action(f.args("direct-invalid", { overwrite: "true" })))).rejects.toThrow("boolean");
  expect(f.row()).toEqual(before);
});

test("concurrent same-key calls dispatch once; competing sources cannot both adopt", async () => {
  const f = await fixture();
  const answers = await Promise.all([f.call("duplicate"), f.call("duplicate")]);
  expect(answers.every(answer => answer.structuredContent?.ok === true)).toBe(true); expect(f.count()).toBe(1);
  const before = f.row();
  const competing = await Promise.all([f.call("same"), f.call("other", { src: f.other.src })]);
  expect(competing[0].isError).not.toBe(true); expect(competing[1].isError).toBe(true); expect(f.row()).toEqual(before);
});

test("binding invokes context authority and refuses unidentified callers", async () => {
  const f = await fixture(), before = f.row();
  await expect(runAsMcpHttpCaller({ capability: f.caller.capability }, () => f.bindings.pipeline_action(f.args("context"), {
    assertCaller: () => { throw new Error("fixture caller replaced"); },
  }))).rejects.toThrow("fixture caller replaced");
  await expect(f.bindings.pipeline_action(f.args("unidentified"))).rejects.toThrow();
  expect(f.row()).toEqual(before);
});

test("real SQLite writer wait rechecks caller capability before mutation", async () => {
  const f = await fixture(), before = f.row();
  const blocker = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  let changed = false, timer: ReturnType<typeof setTimeout> | undefined;
  cleanups.push(() => { clearTimeout(timer); blocker.close(); });
  f.before(() => {
    blocker.exec("BEGIN IMMEDIATE");
    timer = setTimeout(() => {
      f.registry.rotateSpawnCapabilityForReceipt(f.caller.launchId); changed = true;
      blocker.exec("ROLLBACK");
    }, 30);
  });
  const answer = await f.call("waiting");
  expect(answer.structuredContent).toMatchObject({ ok: false, details: { code: "caller_changed" } });
  expect(changed).toBe(true); expect(f.row()).toEqual(before);
});

test("final synchronous source lookup cannot revoke authority and still write", async () => {
  const f = await fixture(), before = f.row(); let live = true, lookups = 0;
  f.ports({ deputySeatFor: () => { if (++lookups === 2) live = false; return null; } });
  await expect(runAsMcpHttpCaller({ capability: f.caller.capability }, () => f.bindings.pipeline_action(f.args("last-check"), {
    assertCaller: () => { if (!live) throw new Error("fixture final authority lost"); },
  }))).rejects.toThrow("fixture final authority lost");
  expect(live).toBe(false); expect(f.row()).toEqual(before);
});

test("direct controller retains srcPath and rolls back failed persistence", async () => {
  const f = await fixture(), before = f.row();
  injectStateWriteFaultForTests({ site: "commit", collection: "pipelines", times: 1, error: new Error("fixture write failed") });
  try { await expect(patchPipeline(f.pipeline.id, { action: "set-src", srcPath: f.source.src })).rejects.toThrow("fixture write failed"); }
  finally { injectStateWriteFaultForTests(null); }
  expect(f.row()).toEqual(before);
  expect((await patchPipeline(f.pipeline.id, { action: "set-src", srcPath: f.source.src })).pipeline?.srcConversationId).toBe(f.source.id);
});

test("HTTP controller consumes srcPath and refuses unknown direct fields without mutation", async () => {
  const f = await fixture(), before = f.row();
  const send = (body: Record<string, unknown>) => fetch(new URL(`/api/pipelines/${f.pipeline.id}`, f.listener.url), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  for (const fields of [{ src: f.source.src }, { extra: true }, { srcConversationId: f.other.id }, { overwrite: "true" }]) {
    const reply = await send({ action: "set-src", srcPath: f.source.src, ...fields });
    expect(reply.status).toBe(400); expect(f.row()).toEqual(before);
  }
  const reply = await send({ action: "set-src", srcPath: f.source.src });
  expect(reply.status).toBe(200); expect(f.row().srcConversationId).toBe(f.source.id);
});

test("superseded caller cannot replay an earlier successful source receipt", async () => {
  const f = await fixture();
  expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: true });
  const before = f.row();
  f.registry.recordSupersedence(f.caller.id, f.other.id);
  expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: false });
  expect(f.count()).toBe(1); expect(f.row()).toEqual(before);
});

test("a controller loses authority during the actual final writer wait", async () => {
  const f = await fixture(), before = f.row();
  const blocker = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  let live = true, held = false, released: Promise<void> | undefined;
  cleanups.push(async () => { await released; blocker.close(); });
  const ports = { ...defaultPipelinePorts(), deputySeatFor: () => {
    // The base invokes this after taking its collection lease but before its
    // asynchronous persist. The repaired path invokes it before writer admission.
    if (!held) {
      held = true; blocker.exec("BEGIN IMMEDIATE");
      released = new Promise<void>(resolve => setTimeout(() => { live = false; blocker.exec("ROLLBACK"); resolve(); }, 20));
    }
    return null;
  } };
  await expect(patchPipeline(f.pipeline.id, { action: "set-src", srcPath: f.source.src }, ports, undefined,
    () => { if (!live) throw new Error("fixture writer authority lost"); })).rejects.toThrow("fixture writer authority lost");
  expect(held).toBe(true); expect(live).toBe(false); expect(f.row()).toEqual(before);
  expect((await patchPipeline(f.pipeline.id, { action: "set-src", srcPath: f.source.src })).pipeline?.srcConversationId).toBe(f.source.id);
});

function designate(project: string, conversationId: string, src: string, key: string) {
  beginOrchestratorSeatIntent({ project, mandate: "Own the fixture", clientRequestId: key, mode: "existing", conversationId });
  completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId, path: src });
}

test("deputy source resolves to its current seat and ordinary replacement removes the deputy", async () => {
  const f = await fixture(), before = f.row();
  const now = new Date("2026-11-06T00:00:00.000Z");
  setSystemTime(now); cleanups.push(() => { setSystemTime(); });
  designate(f.pipeline.project, f.other.id, f.other.src, "source-deputy-seat");
  const begun = beginDeputy({ project: f.pipeline.project, seatConversationId: f.other.id,
    seatEpoch: orchestratorSeatFor(f.pipeline.project).active!.seatEpoch, seatPath: f.other.src,
    clientRequestId: "source-deputy", askId: "deputy_source_fixture", now, ask: { text: "Inspect source", images: 0, sender: null } });
  expect(begun.kind).toBe("begun");
  recordDeputyFork(begun.deputy.askId, { deputyConversationId: f.source.id, artifactPath: f.source.src, forkRecordCount: 0 });
  expect((await f.call("deputy")).structuredContent).toMatchObject({ ok: true });
  expect(f.row()).toEqual({ ...before, srcPath: f.other.src, srcConversationId: f.other.id, srcDeputyConversationId: f.source.id });
  expect((await f.call("ordinary", { src: f.caller.src, overwrite: true })).structuredContent).toMatchObject({ ok: true });
  expect(f.row()).toEqual({ ...before, srcPath: f.caller.src, srcConversationId: f.caller.id });
});

test("revoked seat cannot change lineage or replay its completed receipt", async () => {
  const f = await fixture();
  designate(f.pipeline.project, f.caller.id, f.caller.src, "source-seat-current");
  expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: true });
  const before = f.row();
  designate(f.pipeline.project, f.other.id, f.other.src, "source-seat-successor");
  for (const [key, fields] of [["adopt", {}], ["replace", { src: f.other.src, overwrite: true }]] as const) {
    expect((await f.call(key, fields)).structuredContent).toMatchObject({ ok: false, details: { code: "orchestrator_seat_revoked" } });
    expect(f.row()).toEqual(before);
  }
  expect(f.count()).toBe(1);
});

test("workspace source and target checks survive receipt replay and membership revocation during writer wait", async () => {
  const store = teamStore(), filename = teamStoreFile(), at = "2026-11-06T00:00:00.000Z";
  cleanups.push(() => {
    resetTeamStoreForTests();
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(filename + suffix, { force: true });
  });
  const member = (id: string, role: "owner" | "member") => ({ id, name: id, role, status: "active" as const,
    color: "teal" as const, telegram: null, createdAt: at, createdBy: "claim", revokedAt: null });
  const owner = member("m_source_owner", "owner"), worker = member("m_source_worker", "member"), workspaceId = `w_${"c".repeat(32)}`;
  store.insertMember(owner); store.insertMember(worker);
  createWorkspace(store, owner, { id: workspaceId, name: "Source workspace", projects: ["source-fixture"] });
  store.putWorkspaceMember(workspaceId, worker.id, "member", owner.id, at);
  const f = await fixture("codex", false, { memberId: worker.id, workspaceId });
  expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: true });
  const before = f.row();
  for (const fields of [{ pipelineId: "foreign-pipeline" }, { src: "conversation_foreign" }]) {
    expect((await f.call(JSON.stringify(fields), { ...fields, overwrite: true })).structuredContent).toMatchObject({ ok: false, code: "workspace_forbidden" });
    expect(f.row()).toEqual(before);
  }
  const blocker = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  let timer: ReturnType<typeof setTimeout> | undefined, changed = false;
  cleanups.push(() => { clearTimeout(timer); blocker.close(); });
  f.before(() => {
    blocker.exec("BEGIN IMMEDIATE");
    timer = setTimeout(() => { store.removeWorkspaceMember(workspaceId, worker.id); changed = true; blocker.exec("ROLLBACK"); }, 30);
  });
  expect((await f.call("lost-workspace", { src: f.other.src, overwrite: true })).structuredContent).toMatchObject({ ok: false, code: "workspace_forbidden" });
  expect(changed).toBe(true); expect(f.row()).toEqual(before);
  expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: false, code: "workspace_forbidden" });
});


test("native Claude source spelling resolves to the registered shared mirror", async () => {
  const f = await fixture("claude", false, undefined, true), before = f.row();
  expect(fs.existsSync(f.source.native)).toBe(false);
  expect((await f.call("mirror", { src: f.source.native })).structuredContent).toMatchObject({ ok: true });
  expect(f.row()).toEqual({ ...before, srcPath: f.source.src, srcConversationId: f.source.id });
});

test("two fresh source requests serialize against the current lineage", async () => {
  const f = await fixture();
  const answers = await Promise.all([f.call("creator"), f.call("other", { src: f.other.src })]);
  expect(answers.filter(answer => answer.structuredContent?.ok === true)).toHaveLength(1);
  expect(answers.filter(answer => answer.isError === true)).toHaveLength(1);
  const winner = answers[0].structuredContent?.ok === true ? f.source : f.other;
  expect(f.row()).toMatchObject({ srcPath: winner.src, srcConversationId: winner.id });
});

test("the final source lookup cannot supersede the real caller and still commit", async () => {
  const f = await fixture(), before = f.row(); let lookups = 0;
  f.ports({ deputySeatFor: () => {
    if (++lookups === 2) f.registry.recordSupersedence(f.caller.id, f.other.id);
    return null;
  } });
  expect((await f.call("superseded-at-write")).structuredContent).toMatchObject({ ok: false, details: { code: "caller_changed" } });
  expect(lookups).toBe(2); expect(f.row()).toEqual(before);
});

test("seat replacement during writer admission refuses overwrite without changing lineage", async () => {
  const f = await fixture();
  designate(f.pipeline.project, f.caller.id, f.caller.src, "source-wait-seat");
  expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: true });
  const before = f.row();
  const blocker = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  let held = false, released: Promise<void> | undefined;
  cleanups.push(async () => { await released; blocker.close(); });
  f.ports({ deputySeatFor: () => {
    if (!held) {
      held = true; blocker.exec("BEGIN IMMEDIATE");
      released = new Promise<void>(resolve => setTimeout(() => {
        designate(f.pipeline.project, f.other.id, f.other.src, "source-wait-successor");
        blocker.exec("ROLLBACK"); resolve();
      }, 20));
    }
    return null;
  } });
  expect((await f.call("replace", { src: f.other.src, overwrite: true })).structuredContent)
    .toMatchObject({ ok: false, details: { code: "orchestrator_seat_revoked" } });
  expect(held).toBe(true); expect(f.row()).toEqual(before);
});

test("a deputy loses its seat authority during source resolution", async () => {
  const f = await fixture(), before = f.row();
  const now = new Date("2026-11-06T00:00:00.000Z");
  setSystemTime(now); cleanups.push(() => { setSystemTime(); });
  designate(f.pipeline.project, f.source.id, f.source.src, "source-calling-deputy-seat");
  const begun = beginDeputy({ project: f.pipeline.project, seatConversationId: f.source.id,
    seatEpoch: orchestratorSeatFor(f.pipeline.project).active!.seatEpoch, seatPath: f.source.src,
    clientRequestId: "source-calling-deputy", askId: "deputy_source_caller", now,
    ask: { text: "Update source", images: 0, sender: null } });
  expect(begun.kind).toBe("begun");
  recordDeputyFork(begun.deputy.askId, { deputyConversationId: f.caller.id, artifactPath: f.caller.src, forkRecordCount: 0 });
  let lookups = 0;
  f.ports({ deputySeatFor: () => {
    if (++lookups === 2) designate(f.pipeline.project, f.other.id, f.other.src, "source-calling-deputy-successor");
    return null;
  } });
  expect((await f.call("deputy-lost-seat")).structuredContent).toMatchObject({ ok: false });
  expect(lookups).toBe(2); expect(f.row()).toEqual(before);
});


for (const change of ["superseded", "seat"] as const) {
  for (const boundary of ["receipt", "SDK response"] as const) test(`${change} during ${boundary} refuses source replay without changing its receipt`, async () => {
    const f = await fixture();
    if (change === "seat") designate(f.pipeline.project, f.caller.id, f.caller.src, "replay-current-seat");
    expect((await f.call("adopt")).structuredContent).toMatchObject({ ok: true });
    const before = f.row(), key = `pipeline_action:${f.args("adopt").clientRequestId}`;
    const receipt = f.receipts().lookup(key);
    const revoke = () => {
      if (change === "seat") designate(f.pipeline.project, f.other.id, f.other.src, "replay-successor-seat");
      else f.registry.recordSupersedence(f.caller.id, f.other.id);
    };
    if (boundary === "receipt") {
      const claim = f.receipts().claim.bind(f.receipts());
      f.receipts().claim = (...args: Parameters<typeof claim>) => {
        const result = claim(...args);
        queueMicrotask(revoke);
        return result;
      };
    } else f.afterResponse(revoke);
    const answer = await f.call("adopt");
    if (change === "seat") expect(orchestratorSeatFor(f.pipeline.project).active?.conversationId).toBe(f.other.id);
    else expect(productionDomainDependencies.registrySnapshot().conversations[f.caller.id]?.supersededBy?.conversationId).toBe(f.other.id);
    expect(answer.structuredContent).toMatchObject({ ok: false, code: change === "seat" ? "orchestrator_seat_revoked" : "caller_changed" });
    expect(f.count()).toBe(1); expect(f.row()).toEqual(before);
    expect(f.receipts().lookup(key)).toEqual(receipt);
    f.reopen();
    expect(f.receipts().lookup(key)).toEqual(receipt);
  });
}

for (const change of ["none", "superseded", "seat"] as const) test(`${change} while a duplicate awaits source settlement preserves one dispatch`, async () => {
  const f = await fixture();
  if (change === "seat") designate(f.pipeline.project, f.caller.id, f.caller.src, "duplicate-current-seat");
  let completed!: () => void, release!: () => void;
  const stored = new Promise<void>(resolve => { completed = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const receipts = f.receipts(), complete = receipts.complete.bind(receipts), claim = receipts.claim.bind(receipts);
  let claims = 0;
  receipts.claim = (...args: Parameters<typeof claim>) => { claims++; return claim(...args); };
  receipts.complete = async (...args: Parameters<typeof complete>) => {
    complete(...args); completed(); await held;
  };
  const first = f.call("duplicate");
  try {
    await stored;
    const before = f.row(), key = `pipeline_action:${f.args("duplicate").clientRequestId}`;
    const receipt = receipts.lookup(key);
    f.bindings.pipeline_action.canonicalizeReceiptArgs = args => {
      queueMicrotask(() => {
        if (change === "superseded") f.registry.recordSupersedence(f.caller.id, f.other.id);
        if (change === "seat") designate(f.pipeline.project, f.other.id, f.other.src, "duplicate-successor-seat");
        release();
      });
      return args;
    };
    const duplicate = await f.call("duplicate"), original = await first;
    if (change === "none") {
      expect(original.structuredContent).toMatchObject({ ok: true, replayed: false });
      expect(duplicate.structuredContent).toMatchObject({ ok: true, replayed: true });
    } else {
      const refusal = { ok: false, code: change === "seat" ? "orchestrator_seat_revoked" : "caller_changed" };
      expect(original.structuredContent).toMatchObject(refusal);
      expect(duplicate.structuredContent).toMatchObject(refusal);
    }
    expect(claims).toBe(1); expect(f.count()).toBe(1); expect(f.row()).toEqual(before);
    expect(receipts.lookup(key)).toEqual(receipt);
    expect(receipt?.result).toMatchObject({ ok: true });
    f.reopen();
    expect(f.receipts().lookup(key)).toEqual(receipt);
  } finally { release(); await first; }
});

test("unsettled source receipt remains UNKNOWN after reopen without dispatch", async () => {
  const f = await fixture(), before = f.row(), args = f.args("uncertain");
  const key = `pipeline_action:${args.clientRequestId}`;
  expect(f.receipts().claim(key, requestDigest("pipeline_action", args), "durable").kind).toBe("fresh");
  const receipt = f.receipts().lookup(key);
  f.reopen();
  expect((await f.call("uncertain")).structuredContent).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown" } });
  expect(f.count()).toBe(0); expect(f.row()).toEqual(before);
  expect(f.receipts().lookup(key)).toEqual(receipt);
});
