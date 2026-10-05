import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { McpToolBindings } from "./server";
import type { Pipeline } from "@/lib/pipelines/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-call-cost-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, SqliteMcpReceiptStore, MCP_TOOL_NAMES, MUTATING_MCP_TOOL_NAMES, OPTIONAL_READ_KEY_TOOLS } = await import("./server");
const { viewerMcpBindings, productionDomainDependencies, viewerMcpRecoverableTools } = await import("./bindings");
const { runAsMcpHttpCaller } = await import("./callerContext");
const { pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { saveTasks } = await import("@/lib/tasks/store");
const { savePipelines, loadPipelines } = await import("@/lib/pipelines/store");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { agentRegistry } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { taskAcknowledgement } = await import("./listAnswers");
afterAll(registerPipelineTick(async () => {}));

async function protocol(bindings: McpToolBindings) {
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "call-cost-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("only allowlisted pure reads may omit keys; explicit keys still replay after restart", async () => {
  let version = 0;
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({ version: ++version })])) as unknown as McpToolBindings;
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "reads.sqlite"));
  try {
    const service = createMcpToolService(bindings, receipts);
    for (const name of OPTIONAL_READ_KEY_TOOLS) {
      expect(MUTATING_MCP_TOOL_NAMES.has(name)).toBe(false);
      const first = await service.callTool(name, {});
      const second = await service.callTool(name, {});
      expect(first).toMatchObject({ ok: true, clientRequestId: null, replayed: false });
      if (!first.ok || !second.ok) throw new Error("read refused");
      expect(second.version).not.toBe(first.version);
    }
    const count = version;
    for (const name of MCP_TOOL_NAMES.filter(name => !OPTIONAL_READ_KEY_TOOLS.has(name))) {
      expect(await service.callTool(name, {})).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(version).toBe(count);
    const first = await service.callTool("get_pipeline", { clientRequestId: "stable", pipelineId: "fixture" });
    expect(await createMcpToolService(bindings, receipts).callTool("get_pipeline", { clientRequestId: "stable", pipelineId: "fixture" }))
      .toEqual({ ...first, replayed: true });
    expect(await service.callTool("get_pipeline", { clientRequestId: "stable", pipelineId: "changed" }))
      .toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(await service.callTool("get_pipeline", { clientRequestId: " " })).toMatchObject({ ok: false, code: "invalid_request" });
  } finally { receipts.close(); }
  const mcp = await protocol(bindings);
  try {
    const tools = await mcp.client.listTools();
    for (const name of OPTIONAL_READ_KEY_TOOLS) expect(tools.tools.find(tool => tool.name === name)!.inputSchema.required ?? []).not.toContain("clientRequestId");
    for (const name of MUTATING_MCP_TOOL_NAMES) expect(tools.tools.find(tool => tool.name === name)!.inputSchema.required).toContain("clientRequestId");
    expect((await mcp.client.callTool({ name: "get_pipeline", arguments: { pipelineId: "fixture" } })).isError).toBeUndefined();
  } finally { await mcp.close(); }
});

test("unkeyed reads retain authorization and cancellation, without touching receipts", async () => {
  let dispatched = 0;
  const read = Object.assign(async () => { dispatched++; return {}; }, { authorizeReceipt: async () => { throw new Error("private read refused"); } });
  const receipts = new MemoryMcpReceiptStore();
  receipts.claim = () => { throw new Error("keyless reads must never claim"); };
  const bindings = { get_pipeline: read } as unknown as McpToolBindings;
  const service = createMcpToolService(bindings, receipts);
  expect(await service.callTool("get_pipeline", {})).toMatchObject({ ok: false, error: "private read refused" });
  expect(dispatched).toBe(0);
  const denied = createMcpToolService(bindings, receipts, { permit: () => ({ allowed: false, code: "tool_not_permitted", error: "denied" }) });
  expect(await denied.callTool("get_pipeline", {})).toMatchObject({ ok: false, code: "tool_not_permitted" });
  const plain = createMcpToolService({ get_pipeline: async () => { dispatched++; return {}; } } as unknown as McpToolBindings, receipts);
  expect(await plain.callTool("get_pipeline", {}, { signal: AbortSignal.abort(new Error("cancelled")) })).toMatchObject({ ok: false, error: "cancelled" });
  expect(dispatched).toBe(0);
});

test("pipeline defaults keep graph guards and full views; status-only pages preserve scope and cursors", async () => {
  const lanes = pipelineCorpus(27, 6);
  savePipelines(lanes);
  const bindings = viewerMcpBindings();
  const mcp = await protocol(bindings);
  const id = lanes[1]!.id;
  try {
    const call = async (args: Record<string, unknown>) => (await mcp.client.callTool({ name: "get_pipeline", arguments: { pipelineId: id, ...args } })).structuredContent as Record<string, unknown>;
    const compact = await call({});
    expect(compact).not.toHaveProperty("pipeline");
    expect(compact).toMatchObject({ revision: expect.stringMatching(/^[a-f0-9]{64}$/), graphDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const full = await call({ full: true });
    const legacy = await call({ compact: false });
    expect(full.pipeline).toEqual(legacy.pipeline);
    expect(full.stageDigests).toEqual(compact.stageDigests);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 10);
    const first = await bindings.list_pipelines({ limit: 2, statusOnly: true, includeClosed: true });
    expect(first).not.toHaveProperty("readMore");
    expect(first.pipelines).toHaveLength(2);
    expect((first.pipelines as Array<Record<string, unknown>>)[0]).not.toHaveProperty("stages");
    const next = await bindings.list_pipelines({ limit: 2, statusOnly: true, includeClosed: true, cursor: first.nextCursor });
    expect((next.pipelines as Array<{ id: string }>)[0]!.id).not.toBe((first.pipelines as Array<{ id: string }>)[0]!.id);
    const hints = await bindings.list_pipelines({ limit: 2, includeHints: true });
    expect(hints.readMore).toBeString();
    const reset = await bindings.list_pipelines({ cursor: first.nextCursor, project: "changed" });
    expect(reset.cursorReset).toBe(true);
  } finally { await mcp.close(); }
});

test("routine actions omit unchanged delivery and digests; graph edits and full answers retain them", async () => {
  const lane = pipelineCorpus(2, 6)[1]!;
  lane.delivery = { target: { repository: "fixture", branch: "refs/heads/fixture", remote: "origin" }, disposition: "owner", ownerId: lane.id, epoch: 1, active: true, publish: "enabled", journal: [] } as Pipeline["delivery"];
  const domain = { ...productionDomainDependencies, readPipelineRecord: () => lane,
    callerAttribution: () => ({ kind: "agent" as const, conversationId: "conversation_fixture", role: "builder" }),
    patchPipeline: async () => ({ pipeline: lane }) };
  const bindings = viewerMcpBindings(undefined, undefined, domain);
  const args = { clientRequestId: "action", pipelineId: lane.id, action: "pause" };
  const ack = await bindings.pipeline_action(args);
  for (const field of ["delivery", "stageDigests", "graphDigest", "readMore"]) expect(ack).not.toHaveProperty(field);
  expect(ack).toHaveProperty("revision");
  const full = await bindings.pipeline_action({ ...args, full: true });
  expect(full).toHaveProperty("delivery");
  expect(full).toHaveProperty("stageDigests");
  const edit = await bindings.pipeline_action({ ...args, action: "override-stage" });
  expect(edit).toHaveProperty("graphDigest");
  const takeover = await bindings.pipeline_action({ ...args, action: "takeover" });
  expect(takeover).toHaveProperty("delivery");
});

test("resources hands its one-second budget to the reader and reports a first collection as pending", async () => {
  const waits: Array<{ fresh: boolean; waitMs: number | undefined }> = [];
  const diagnostic = { fresh: false, durationMs: 750, phases: {}, generation: 1, startedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:00:01Z", collectorId: "fixture", cache: { status: "miss" } };
  const bindings = viewerMcpBindings(undefined, undefined, {
    readResourcesWithDiagnostic: async (fresh: boolean, options: { waitMs?: number } = {}) => {
      waits.push({ fresh, waitMs: options.waitMs });
      return fresh
        ? { payload: { system: null, sessions: [], sessionsCapturedAt: "2026-10-01T00:00:01Z", sessionsStale: false }, diagnostic: { ...diagnostic, fresh: true, status: "complete" } }
        : { payload: { system: null, sessions: [], sessionsCapturedAt: null, sessionsStale: true }, diagnostic: { ...diagnostic, status: "pending" } };
    },
  } as never);

  const pending = await bindings.resources({}) as { sessionSummary: { count: number }; freshness: Record<string, unknown> };
  expect(pending.sessionSummary.count).toBe(0);
  expect(pending.freshness).toMatchObject({ pending: true, reason: "collecting", cache: "miss", sessionsStale: true, sessionsCapturedAt: null, refreshSucceeded: null });
  const fresh = await bindings.resources({ fresh: true }) as { freshness: Record<string, unknown> };
  expect(fresh.freshness).not.toHaveProperty("pending");
  expect(fresh.freshness).toMatchObject({ reason: null, refreshSucceeded: true });
  expect(waits.map((wait) => wait.waitMs)).toEqual([750, 750]);
  expect(waits[0]!.waitMs).toBeLessThan(1_000);
});

test("agent_activity with no completed catalog names the hosted conversations and says the catalog is pending", async () => {
  const now = Date.now();
  const hosted = Array.from({ length: 3 }, (_, i) => `/fixtures/hosted-${i}.jsonl`);
  const entries = Object.fromEntries(hosted.map((artifactPath, i) => [`entry-${i}`, {
    key: { engine: "codex", accountId: null, sessionId: `session-${i}` }, artifactPath,
    status: "live", host: null, accountId: null,
    structuredHost: { process: { pid: 1000 + i, startIdentity: `identity-${i}` } },
    updatedAt: new Date(now).toISOString(),
  }]));
  const budgets: Array<number | undefined> = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    livenessSources: (catalog: { catalogBudgetMs?: number } = {}) => {
      budgets.push(catalog.catalogBudgetMs);
      return {
        now: () => now,
        probe: { now: () => now, pidAlive: () => true, processIdentity: (pid: number) => `identity-${pid - 1000}` },
        registrySnapshot: () => ({ entries, conversations: {} }), pipelines: () => [],
        /* What the selection answers once its budget is spent with nothing completed. */
        selectInventory: async () => ({ entries: [], matched: 0, scanned: 0, hostedSeen: new Set<string>(), generation: null, cacheStatus: "pending", freshScan: false, selectionMs: 700 }),
        describeTranscript: async (pathname: string) => ({ path: pathname, project: "activity-board", title: pathname.slice(pathname.lastIndexOf("/") + 1), engine: "codex", mtimeMs: now, conversationId: `conversation-${pathname.slice(pathname.lastIndexOf("/") + 1)}`, activity: "live", activityReason: null }),
        transcriptEvidence: async () => ({ turn: "idle", lastRecordTs: now, providerProgressAt: null }),
      };
    }, refreshLifecycleJournal: () => ({ appended: 0 }),
  } as never);

  const compact = await bindings.agent_activity({ clientRequestId: "pending-compact" });
  expect(compact).toMatchObject({ catalog: "pending", count: 3 });
  const full = await bindings.agent_activity({ clientRequestId: "pending-full", full: true });
  expect(full).toMatchObject({ catalog: "pending", selection: { cacheStatus: "pending", generation: null, scanned: 0, recovered: 3 } });
  expect(budgets).toEqual([700, 700]);
});

test("resource summaries retain stale/freshness evidence; full rows remain available", async () => {
  const sessions = [{ target: "fixture", panePid: 1, path: null, engine: "codex", title: "worker", project: "fixture", activity: null, lastActiveAt: null, cwd: null, rssBytes: 123, swapBytes: 45, procCount: 2 }];
  const bindings = viewerMcpBindings(undefined, undefined, { readResourcesWithDiagnostic: undefined,
    readResources: async () => ({ system: null, sessions, sessionsCapturedAt: "2026-10-01T00:00:00Z", sessionsStale: true, viewer: null, viewerUnavailable: "not-the-viewer" }) } as never);
  const compact = await bindings.resources({});
  expect(compact).not.toHaveProperty("sessions");
  expect(compact).toMatchObject({ sessionSummary: { count: 1, rssBytes: 123, swapBytes: 45, procCount: 2 }, freshness: { sessionsStale: true }, viewerUnavailable: "not-the-viewer" });
  const full = await bindings.resources({ full: true });
  expect(full).toMatchObject({ sessions: [{ ...sessions[0], stale: true, capturedAt: "2026-10-01T00:00:00Z" }] });
  expect((await bindings.resources({ compact: false })).sessions).toEqual(full.sessions);
  const task = { id: "fixture", project: "fixture", text: "Task", status: "inbox", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", placement: "unplaced", assignments: [] };
  expect(taskAcknowledgement(task as never, {}, ["status"])).not.toHaveProperty("readMore");
  expect(taskAcknowledgement(task as never, { includeHints: true }, ["status"])).toHaveProperty("readMore");
});

test("hint flags preserve task age for color, icon and priority edits at the MCP boundary", async () => {
  const mcp = await protocol(viewerMcpBindings());
  try {
    for (const [field, value] of [["color", "sky"], ["icon", "zap"], ["priority", "high"]]) {
      for (const includeHints of [undefined, false, true]) {
        const task = { id: "presentation-fixture", project: "fixture", text: "Task", status: "inbox", placement: "unplaced", assignments: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
        saveTasks([task] as never);
        const result = await mcp.client.callTool({ name: "update_task", arguments: {
          clientRequestId: `${field}-${includeHints}`, taskId: task.id, [field!]: value,
          ...(includeHints === undefined ? {} : { includeHints }),
        } });
        expect(result.isError).toBeUndefined();
        const payload = result.structuredContent as Record<string, unknown>;
        expect(payload.changedFields).toEqual([field]);
        const read = await viewerMcpBindings().get_task({ taskId: task.id });
        expect(read.task).toMatchObject({ [field!]: value, updatedAt: task.updatedAt });
        if (includeHints === true) expect(payload).toHaveProperty("readMore");
        else expect(payload).not.toHaveProperty("readMore");
      }
    }
  } finally { await mcp.close(); }
});

test("task notes round-trip through compact and full MCP paths without restoring default hints", async () => {
  const task = { id: "note-cost-fixture", project: "fixture", text: "Task", details: "Private working details", status: "inbox", placement: "unplaced", assignments: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
  saveTasks([task] as never);
  const bindings = viewerMcpBindings(undefined, undefined, {
    ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "agent", conversationId: "conversation_fixture", role: "builder" }),
  } as never);
  const mcp = await protocol(bindings);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.client.callTool({ name, arguments: { taskId: task.id, ...args } });
    expect(result.structuredContent).toMatchObject({ ok: true });
    return result.structuredContent as Record<string, unknown>;
  };
  try {
    for (const [index, options] of [{}, { includeHints: true }, { full: true }, { compact: false }].entries()) {
      const text = `Waiting for review ${index}. `.padEnd(280, ".");
      const written = await call("update_task", { clientRequestId: `note-cost-${index}`, note: text, ...options });
      expect(written.changedFields).toContain("note");
      expect(written.task).toMatchObject({ note: { text, author: { kind: "agent", conversationId: "conversation_fixture" } } });
      if (index === 0) expect(written).not.toHaveProperty("readMore");
      else expect(written).toHaveProperty("readMore");
      if (index < 2) expect(written.task).not.toHaveProperty("details");
      else expect(written.task).toHaveProperty("details", task.details);
      const read = await call("get_task", {});
      expect(read.task).toMatchObject({ details: task.details, note: { text } });
      const compactRead = await call("get_task", { compact: true });
      expect(compactRead.task).toMatchObject({ note: { text } });
      expect(compactRead.task).not.toHaveProperty("details");
      const listed = await call("list_tasks", { project: "fixture", ...options });
      expect(listed.tasks).toEqual([expect.objectContaining({ note: expect.objectContaining({ text }) })]);
      const note = (read.task as { note: unknown }).note;
      expect(taskAcknowledgement({ ...task, note } as never, {}, []).omittedFieldCount)
        .toBe(taskAcknowledgement(task as never, {}, []).omittedFieldCount);
    }
    const cleared = await call("update_task", { clientRequestId: "note-cost-clear", note: null });
    expect(cleared.changes).toMatchObject({ note: null });
    expect(cleared.task).not.toHaveProperty("note");
    expect((await call("get_task", {})).task).not.toHaveProperty("note");
  } finally { await mcp.close(); }
});

test("create source inference pins the authenticated generation, rejects ambiguous/stale lineage and preserves explicit src", async () => {
  const store = agentRegistry();
  const begun = beginLegacySpawnFixture(store, { engine: "codex", cwd: process.cwd(), role: "builder", origin: { kind: "operator" } });
  if (begun.kind !== "created") throw new Error("fixture admission failed");
  const transcript = path.join(process.env.LLV_CODEX_HOME!, "sessions", "creator.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: "fixture-creator" } }) + "\n");
  const settled = store.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: "fixture-creator" }, artifactPath: transcript, cwd: process.cwd(), accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("fixture settlement failed");
  const cid = settled.conversation.id;
  const capability = store.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
  let snapshot = structuredClone(store.readOnlySnapshot());
  const domain = { ...productionDomainDependencies, registrySnapshot: () => snapshot,
    attentionAuthority: () => ({ kind: "worker" as const, conversationId: cid, role: "builder" }),
    callerAttribution: () => ({ kind: "agent" as const, conversationId: cid, role: "builder" }) };
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "create.sqlite"));
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const args = { task: "Draft fixture", spec: "Verify admission", repoDir: process.cwd(), baseRef: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), autoStart: false, stages: [{ id: "build", kind: "run", prompt: "Build fixture", next: null }] };
  try {
    const call = (clientRequestId: string, extra = {}) => runAsMcpHttpCaller({ capability }, () => service.callTool("create_pipeline", { ...args, clientRequestId, ...extra }));
    const created = await call("infer");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(loadPipelines().find(row => row.id === created.pipelineId)?.srcPath).toBe(transcript);
    expect((await call("infer")).replayed).toBe(true);
    const original = structuredClone(snapshot);
    snapshot.conversations[cid]!.generations.push({ ...snapshot.conversations[cid]!.generations[0]!, id: "successor", path: path.join(path.dirname(transcript), "successor.jsonl") });
    const count = loadPipelines().length;
    expect((await call("stale")).ok).toBe(false);
    expect(loadPipelines()).toHaveLength(count);
    // Existing explicit source behavior survives when automatic inference is unavailable.
    expect((await call("explicit", { src: transcript })).ok).toBe(true);
    snapshot = structuredClone(original);
    snapshot.receipts.duplicate = { ...snapshot.receipts[begun.receipt.launchId]!, launchId: "duplicate" };
    expect((await call("ambiguous")).ok).toBe(false);
    snapshot = structuredClone(original);
    snapshot.receipts[begun.receipt.launchId]!.artifactPath = path.join(path.dirname(transcript), "foreign.jsonl");
    expect((await call("foreign")).ok).toBe(false);
    const production = createMcpToolService(viewerMcpBindings(), receipts, undefined, {
      recovery: viewerMcpRecoverableTools(),
    });
    const native = await runAsMcpHttpCaller({ capability }, () => production.callTool("create_pipeline", { ...args, clientRequestId: "production-infer" }));
    if (!native.ok) throw new Error(JSON.stringify({ code: native.code, error: native.error, details: native.details }));
    expect(native.ok).toBe(true);
    expect(loadPipelines().find(row => row.id === native.pipelineId)?.srcPath).toBe(transcript);
    const admittedCount = loadPipelines().length;
    const refused = await runAsMcpHttpCaller({ capability: "invalid-capability" }, () => production.callTool("create_pipeline", { ...args, clientRequestId: "production-invalid" }));
    expect(refused).toMatchObject({ ok: false, code: "caller_unidentified" });
    expect(loadPipelines()).toHaveLength(admittedCount);
  } finally { receipts.close(); }
});
