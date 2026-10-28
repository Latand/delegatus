import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-environment-mcp-"));
const original = { ...process.env };
for (const name of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR"]) { process.env[name] = path.join(root, name); fs.mkdirSync(process.env[name]!, { recursive: true }); }
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_OPERATOR_TOKEN = "fixture";
const { persistProjectAliases } = await import("@/lib/projects/aliases");
persistProjectAliases([{ source: "old-lifecycle", target: "repo-lifecycle", displayName: "Lifecycle" }, { source: "old-unauthorized", target: "repo-unauthorized", displayName: "Unauthorized" }]);
const { GET, POST } = await import("@/app/api/projects/cloud-environments/route");
const { viewerMcpBindings, productionDomainDependencies, productionViewerControlDependencies } = await import("./bindings");
const { INTERNAL_SERVICE_HEADER } = await import("@/lib/agent/callerClaims");
const { createViewerMcpServer, createMcpToolService, SqliteMcpReceiptStore } = await import("./server");
const { permitMaintainerTool } = await import("./toolAllowlist");
const { readCloudEnvironmentBindings } = await import("@/lib/projects/codexCloudEnvironments");
const { setCloudEnvironmentOverride } = await import("@/lib/projects/codexCloudEnvironments");

afterAll(() => { for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name]; Object.assign(process.env, original); fs.rmSync(root, { recursive: true, force: true }); });
let authorized = true, writes = 0;
const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method === "POST") {
    writes++;
    const headers = new Headers(request.headers);
    if (!authorized) headers.delete(INTERNAL_SERVICE_HEADER);
    return POST(new NextRequest(request.url, { method: "POST", headers, body: await request.text() }));
  }
  return GET(new NextRequest(request));
} });
afterAll(() => http.stop(true));
const base = `http://127.0.0.1:${http.port}`;
process.env.LLV_VIEWER_CONTROL_URL = base;
const receipts = new SqliteMcpReceiptStore(path.join(root, "receipts.sqlite"));
afterAll(() => receipts.close());

async function protocol(maintenance = false, worker = false) {
  const control = productionViewerControlDependencies(true);
  const domain = { ...productionDomainDependencies, attentionAuthority: () => worker ? { kind: "worker" as const, conversationId: "conversation_worker", role: "builder" }
    : { kind: "root" as const, conversationId: null }, authorizedSeats: () => [],
    callerAttribution: () => ({ kind: "gateway" as const, conversationId: null, role: null }), callerProject: () => "repo-fixture" };
  const bindings = viewerMcpBindings(undefined, control, domain);
  const service = createMcpToolService(bindings, receipts, maintenance ? { permit: permitMaintainerTool } : undefined);
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "cloud-environments-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { call: async (args: Record<string, unknown>) => await client.callTool({ name: "codex_cloud_environment", arguments: args }),
    close: async () => { await client.close(); await server.close(); } };
}

test("SDK read/set reaches the real binding, loopback route and storage; durable replay does not write twice", async () => {
  const p = await protocol();
  try {
    const read = await p.call({ action: "read", project: "repo-lifecycle" });
    expect(read.isError, JSON.stringify(read)).not.toBe(true); expect(read.structuredContent).toMatchObject({ bindings: [] });
    const args = { action: "set", project: "repo-lifecycle", accountId: "account-a", environmentId: "asenvcfg_manual", expectedRevision: 0, clientRequestId: "cloud-set-first" };
    const first = await p.call(args);
    expect(first.isError).not.toBe(true); expect(first.structuredContent).toMatchObject({ ok: true, binding: { revision: 1, state: "discovering", environmentId: "asenvcfg_manual" } });
    const before = writes;
    await p.close();
    const restarted = await protocol();
    try { expect((await restarted.call(args)).structuredContent).toMatchObject({ replayed: true, binding: { revision: 1 } }); }
    finally { await restarted.close(); }
    expect(writes).toBe(before);
    const conflicting = await protocol();
    try {
      const conflict = await conflicting.call({ ...args, clientRequestId: "cloud-stale-write", environmentId: "asenvcfg_other" });
      expect(conflict.structuredContent).toMatchObject({ conflict: true, binding: { environmentId: "asenvcfg_manual", revision: 1 } });
    } finally { await conflicting.close(); }
  } finally { await p.close(); }
});

test("read-only maintenance callers read saved readiness and cannot mutate or forge actor input", async () => {
  const p = await protocol(true);
  try {
    expect((await p.call({ action: "read", project: "repo-fixture" })).isError).not.toBe(true);
    const before = writes;
    const refused = await p.call({ action: "set", project: "repo-fixture", accountId: "account-a", environmentId: null, expectedRevision: 1, clientRequestId: "cloud-maintenance-write" });
    expect(refused.isError).toBe(true); expect(writes).toBe(before);
    const forged = await p.call({ action: "set", project: "repo-fixture", accountId: "account-a", environmentId: null, expectedRevision: 1, clientRequestId: "cloud-forged-actor", actor: "operator" });
    expect(forged.isError).toBe(true); expect(writes).toBe(before);
  } finally { await p.close(); }
});

test("the HTTP route refuses an unauthenticated write without changing the override", async () => {
  await setCloudEnvironmentOverride({ project: "repo-unauthorized", accountId: "account-a", environmentId: "asenvcfg_manual", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
  authorized = false;
  const p = await protocol();
  try {
    expect((await p.call({ action: "set", project: "repo-unauthorized", accountId: "account-a", environmentId: null, expectedRevision: 1, clientRequestId: "cloud-unauthorized" })).isError).toBe(true);
    expect(readCloudEnvironmentBindings("repo-unauthorized", { accountId: "account-a" }).bindings[0]).toMatchObject({ environmentId: "asenvcfg_manual", revision: 1 });
  } finally { authorized = true; await p.close(); }
});

test("an ordinary worker cannot write or replay an operator mutation through the MCP service marker", async () => {
  const p = await protocol(false, true);
  try {
    const before = writes;
    const refused = await p.call({ action: "set", project: "repo-lifecycle", accountId: "account-a", environmentId: "asenvcfg_manual", expectedRevision: 0, clientRequestId: "cloud-set-first" });
    expect(refused.isError).toBe(true); expect(writes).toBe(before);
  } finally { await p.close(); }
});

test("duplicate project query fields cannot make workspace admission and the reader select different projects", async () => {
  const response = await fetch(`${base}/api/projects/cloud-environments?project=repo-fixture&project=repo-unauthorized`, { signal: AbortSignal.timeout(5000) });
  expect(response.status).toBe(400);
});
