import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tasks-mcp-"));
const original = { ...process.env };
for (const name of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR"]) { process.env[name] = path.join(root, name); fs.mkdirSync(process.env[name]!, { recursive: true }); }
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_OPERATOR_TOKEN = "fixture";
const { recordProjectRemote } = await import("@/lib/projects/aliases");
recordProjectRemote({ project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", canonicalRemote: "https://github.com/sample/project" });
const { GET, POST } = await import("@/app/api/projects/claude-cloud-tasks/route");
const demand = await import("@/lib/projects/claudeCloudTaskDemand");
const { prepareClaudeCloudTask } = await import("@/lib/projects/claudeCloudTasks");
const { createClaudeCloudTaskProvider } = await import("@/lib/pipelines/cloudClaudeClient");
const { fakeClaudeCloud } = await import("@/lib/pipelines/claudeCloud.fixture");
const { viewerMcpBindings, productionDomainDependencies, productionViewerControlDependencies } = await import("./bindings");
const { INTERNAL_SERVICE_HEADER } = await import("@/lib/agent/callerClaims");
const { createViewerMcpServer, createMcpToolService, SqliteMcpReceiptStore } = await import("./server");
const { permitMaintainerTool } = await import("./toolAllowlist");

let authorized = true, failRoute = false, writes = 0;
let lastHeaders = new Headers();
let release!: () => void;
const blocked = new Promise<void>(resolve => { release = resolve; });
const fake = fakeClaudeCloud({ preparationAnswer: (method, target) => method === "GET" && target === "/v1/code/triggers" ? blocked.then(() => Response.json({ data: [], has_more: false })) : null });
const provider = createClaudeCloudTaskProvider(fake.dependencies);
const account = { engine: "claude" as const, accountId: "default", kind: "managed" as const, home: root, transcriptRoot: root, env: { NODE_ENV: "test" as const } };
let slices = 0;
const ports = spyOn(demand, "claudeCloudTaskDemandPorts").mockImplementation(() => ({
  accounts: () => [{ id: "default", label: "Account A", home: root, projectsDir: root, kind: "managed", authPresent: true, createdAt: 0 }],
  allowed: () => true, remote: () => "https://github.com/sample/project", resolve: () => ({ kind: "available", account }),
  prepare: input => { slices++; return prepareClaudeCloudTask({ ...input, now: fake.dependencies.now }, provider); },
}));
const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (failRoute) return Response.json({ error: "fixture unavailable" }, { status: 503 });
  if (request.method === "POST") {
    writes++; lastHeaders = new Headers(request.headers);
    const headers = new Headers(request.headers);
    if (!authorized) headers.delete(INTERNAL_SERVICE_HEADER);
    return POST(new NextRequest(request.url, { method: "POST", headers, body: await request.text() }));
  }
  return GET(new NextRequest(request));
} });
const base = `http://127.0.0.1:${http.port}`;
process.env.LLV_VIEWER_CONTROL_URL = base;
const receipts = new SqliteMcpReceiptStore(path.join(root, "receipts.sqlite"));
afterAll(async () => { release(); await demand.settleClaudeCloudTaskDemands(); ports.mockRestore(); fake.stop(); http.stop(true); receipts.close();
  for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name]; Object.assign(process.env, original); fs.rmSync(root, { recursive: true, force: true }); });
async function protocol(kind: "root" | "worker" | "seat" = "root", maintenance = false) {
  const control = productionViewerControlDependencies(true);
  const domain = { ...productionDomainDependencies,
    attentionAuthority: () => kind === "root" ? { kind: "root" as const, conversationId: null } : { kind: "worker" as const, conversationId: "conversation_worker", role: "builder" },
    authorizedSeats: () => kind === "seat" ? [{ conversationId: "conversation_worker", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] as ReturnType<NonNullable<typeof productionDomainDependencies.authorizedSeats>> : [],
    callerAttribution: () => ({ kind: "gateway" as const, conversationId: null, role: null }), callerProject: () => "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const bindings = viewerMcpBindings(undefined, control, domain);
  const service = createMcpToolService(bindings, receipts, maintenance ? { permit: permitMaintainerTool } : undefined);
  const server = createViewerMcpServer(service), client = new Client({ name: "claude-tasks-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { call: (args: Record<string, unknown>) => client.callTool({ name: "claude_cloud_task", arguments: args }), close: async () => { await client.close(); await server.close(); } };
}

test("SDK reads saved readiness without provider traffic and refuses forged fields", async () => {
  const p = await protocol();
  try {
    const before = fake.calls.length;
    const answer = await p.call({ action: "read", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
    expect(answer.structuredContent).toMatchObject({ accounts: [{ accountId: "default", state: "not_prepared" }] });
    expect(fake.calls).toHaveLength(before);
    expect((await p.call({ action: "prepare", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "operator", clientRequestId: "forged-actor" })).isError).toBe(true);
    expect(writes).toBe(0);
  } finally { await p.close(); }
});

test("worker and maintenance callers cannot prepare or replay root receipts", async () => {
  for (const [kind, maintenance] of [["worker", false], ["root", true]] as const) {
    const p = await protocol(kind, maintenance);
    try {
      const before = writes;
      expect((await p.call({ action: "read", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).isError).not.toBe(true);
      const refused = await p.call({ action: "prepare", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", clientRequestId: "prepare-first" });
      expect(refused.isError).toBe(true);
      if (kind === "worker") expect(JSON.stringify(refused)).toContain("claude_cloud_task_write_refused");
      expect(writes).toBe(before);
    } finally { await p.close(); }
  }
});

test("root queues a slow preparation; seat and transport retries join it; SDK replay survives server restart", async () => {
  const p = await protocol();
  const args = { action: "prepare", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", clientRequestId: "prepare-first" };
  try {
    const answer = await p.call(args);
    expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
    expect(answer.structuredContent).toMatchObject({ ok: true, queued: ["default"] });
    expect(fake.calls.filter(c => c.method === "POST")).toHaveLength(0);
    const before = writes;
    await p.close();
    const restarted = await protocol();
    try { expect((await restarted.call(args)).structuredContent).toMatchObject({ replayed: true }); }
    finally { await restarted.close(); }
    expect(writes).toBe(before);
    const seat = await protocol("seat");
    try { expect((await seat.call({ ...args, clientRequestId: "seat-prepare" })).isError).not.toBe(true); }
    finally { await seat.close(); }
    const retryHeaders = new Headers(lastHeaders); retryHeaders.delete("content-length");
    const retried = await fetch(`${base}/api/projects/claude-cloud-tasks`, { method: "POST", headers: retryHeaders, body: JSON.stringify(args) });
    expect(retried.status).toBe(202);
    release(); await demand.settleClaudeCloudTaskDemands();
    expect(slices).toBe(1);
    expect(fake.calls.filter(c => c.method === "POST" && c.path === "/v1/code/triggers")).toHaveLength(1);
    const read = await protocol();
    try { expect((await read.call({ action: "read", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).structuredContent).toMatchObject({ accounts: [{ state: "ready" }] }); }
    finally { await read.close(); }
    const worker = await protocol("worker");
    try { expect((await worker.call(args)).isError).toBe(true); }
    finally { await worker.close(); }
  } finally { release(); await p.close(); }
});

test("route authority is checked independently and a 503 writes nothing", async () => {
  const p = await protocol();
  try {
    const count = slices;
    authorized = false;
    expect((await p.call({ action: "prepare", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", clientRequestId: "route-refusal" })).isError).toBe(true);
    authorized = true; failRoute = true;
    expect((await p.call({ action: "prepare", project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", clientRequestId: "route-down" })).isError).toBe(true);
    expect(slices).toBe(count);
  } finally { authorized = true; failRoute = false; await p.close(); }
});

test("duplicate project query parameters fail before reading readiness", async () => {
  expect((await fetch(`${base}/api/projects/claude-cloud-tasks?project=repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&project=other`)).status).toBe(400);
});
