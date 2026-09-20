import { afterAll, afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";

const originalEnv = { ...process.env };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-mcp-"));
for (const key of Object.keys(process.env)) if (key.startsWith("LLV_")) delete process.env[key];
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "CODEX_HOME", "LLV_CODEX_HOME", "CLAUDE_CONFIG_DIR", "LLV_CLAUDE_HOME", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}

const { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { SqliteAgentRegistryStore } = await import("@/lib/agent/sqliteRegistryStore");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, revokedOrchestratorSeatConversationsOrUnknown } = await import("@/lib/orchestrator/seats");
const { POST } = await import("@/app/api/runtime/deployments/route");
const { viewerMcpBindings, productionViewerControlDependencies, productionDomainDependencies } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("./server");

let sequence = 0;
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
afterEach(() => { setAgentRegistryForTests(null); delete process.env.LLV_SPAWN_CAPABILITY; });

async function fixture(kind: "seat" | "worker" | "unidentified") {
  const root = path.join(sandbox, String(++sequence));
  fs.mkdirSync(root);
  process.env.LLV_STATE_DIR = root;
  const at = "2026-09-01T00:00:00.000Z";
  const conversationId = `conversation_${kind}`;
  const generationId = crypto.randomUUID();
  const transcript = path.join(root, `${generationId}.jsonl`);
  const key = { engine: "codex" as const, sessionId: generationId };
  const ownership = (project: string) => ({ project, source: "operator", setAt: at, operationId: "fixture-project" });
  const foreignId = "conversation_foreign";
  const unknownId = "conversation_unattributed";
  const foreignGeneration = crypto.randomUUID();
  const unknownGeneration = crypto.randomUUID();
  const snapshot = normalizeRegistry({ version: 2, receipts: {}, entries: {}, conversations: {
    [conversationId]: { id: conversationId, engine: "codex", projectOwnership: ownership("project-a"),
      generations: [{ id: generationId, path: transcript, launchProfile: { cwd: root, role: "orchestrator" } }] },
    [foreignId]: { id: foreignId, engine: "codex", projectOwnership: ownership("project-b"),
      generations: [{ id: foreignGeneration, path: path.join(root, "foreign.jsonl") }] },
    [unknownId]: { id: unknownId, engine: "codex",
      generations: [{ id: unknownGeneration, path: path.join(root, "unknown.jsonl") }] },
  } });
  const seed = new SqliteAgentRegistryStore(path.join(root, "agent-registry.sqlite"), { initialSnapshot: snapshot, normalize: normalizeRegistry });
  seed.close();
  const registry = new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry);
  let callerId = conversationId;
  let launchId = "seat-assignment";
  let callerGeneration = generationId;
  if (kind === "worker") {
    const spawn = registry.beginSpawnRequest({ engine: "codex", cwd: root, transport: "structured",
      explicitProject: "project-a", launchProfile: { cwd: root, role: "worker", title: "Read retirement observations" } });
    if (spawn.kind !== "created") throw new Error("fixture spawn was not created");
    launchId = spawn.receipt.launchId;
    callerId = spawn.receipt.conversationId;
    callerGeneration = generationId;
    registry.settleSpawn(launchId, { key: { engine: "codex", sessionId: callerGeneration }, artifactPath: transcript,
      cwd: root, accountId: null, status: "live", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "fixture", process: { pid: process.pid, startIdentity: "fixture" },
        eventCursor: 0, protocolVersion: "1", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 1, claimOwner: "fixture", pendingAction: null });
  } else if (kind === "seat") {
    // Designation and host evidence, with no spawn receipt for the seat.
    registry.upsert({ key, artifactPath: transcript, cwd: root, accountId: null, status: "live", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "fixture", process: { pid: process.pid, startIdentity: "fixture" },
        eventCursor: 0, protocolVersion: "1", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 1, claimOwner: "fixture", pendingAction: null });
    beginOrchestratorSeatIntent({ project: "project-a", mandate: "Own project", clientRequestId: "fixture-seat", mode: "spawn", now: at });
    completeOrchestratorSeatIntent({ project: "project-a", clientRequestId: "fixture-seat", conversationId: callerId, path: transcript, now: at });
  }
  const row = (id: string, generation: string) => ({ conversationId: id, key: `codex:${generation}`,
    clause: "events-flushed", reason: "event tail unavailable", undetermined: true });
  const reportPath = path.join(root, "host-retirement-report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ version: 1, startedAt: at, finishedAt: at, retired: [], failed: [],
    refused: [row(callerId, callerGeneration), row(foreignId, foreignGeneration), row(unknownId, unknownGeneration)] }));
  const requests: Array<Record<string, unknown>> = [];
  const viewer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/runtime/deployments");
    requests.push(await request.clone().json());
    return POST(new NextRequest(request));
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
  const server = createViewerMcpServer(createMcpToolService(
    viewerMcpBindings(undefined, productionViewerControlDependencies(true)), new MemoryMcpReceiptStore()));
  const client = new Client({ name: "retirement-observation-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, callerId, launchId, requests, reportPath, registry, origin: process.env.LLV_VIEWER_CONTROL_URL,
    call: async (args: Record<string, unknown> = {}) => (await client.callTool({ name: "deployment_status", arguments: {
      clientRequestId: `read-${++sequence}`, kind: "host-retirement", project: "project-a", ...args,
    } })).structuredContent as Record<string, unknown>,
    close: async () => { await client.close(); await server.close(); viewer.stop(true); },
  };
}

for (const kind of ["seat", "worker"] as const) {
  for (const explicit of [false, true]) test(`${kind} reads its project over MCP and loopback HTTP with ${explicit ? "explicit" : "automatic"} launch identity`, async () => {
    const f = await fixture(kind);
    try {
      expect(productionDomainDependencies.callerAttribution?.()).toMatchObject({ conversationId: f.callerId, kind: kind === "seat" ? "manager" : "agent" });
      // A legacy seat may inherit a capability which has no spawn receipt.
      if (kind === "seat" && explicit) process.env.LLV_SPAWN_CAPABILITY = crypto.randomBytes(32).toString("base64url");
      const result = await f.call(explicit ? { callerLaunchId: f.launchId } : {});
      expect(result).toMatchObject({ ok: true, kind: "host-retirement", project: "project-a" });
      expect(result.items).toEqual([expect.objectContaining({ conversationId: f.callerId, result: "undetermined" })]);
      expect(JSON.stringify(result)).not.toContain("conversation_foreign");
      expect(JSON.stringify(result)).not.toContain("conversation_unattributed");
      expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });
}

test("foreign projects and unidentified callers disclose no observations", async () => {
  for (const kind of ["seat", "worker", "unidentified"] as const) {
    const f = await fixture(kind);
    try {
      const result = await f.call({ project: kind === "unidentified" ? "project-a" : "project-b", callerLaunchId: f.launchId,
        callerConversationId: f.callerId, seatProject: "project-b", capability: "forged" });
      expect(result.ok).toBe(false);
      expect(result.items).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("event tail unavailable");
    } finally { await f.close(); }
  }
});

test("served schema teaches automatic launch identity and bounded pagination", async () => {
  const f = await fixture("unidentified");
  try {
    const tool = (await f.client.listTools()).tools.find(tool => tool.name === "deployment_status")!;
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    for (const name of ["kind", "project", "callerLaunchId", "limit", "cursor"]) expect(properties[name]).toBeDefined();
    expect(properties.callerLaunchId!.description).toContain("Optional");
    expect(tool.description).toContain("designated seat");
    expect(tool.inputSchema.required).not.toContain("callerLaunchId");
  } finally { await f.close(); }
});

test("a worker cannot select another session's receipt or turn itself into a seat", async () => {
  const f = await fixture("worker");
  try {
    const other = f.registry.beginSpawn("codex", sandbox, { cwd: sandbox, title: "Foreign receipt" });
    const result = await f.call({ callerLaunchId: other.launchId, authentication: { conversationId: f.callerId, seatProject: "project-a" } });
    expect(result).toMatchObject({ ok: false, details: { code: "retirement_receipt_refused" } });
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test("HTTP refuses an unsigned caller claim and a worker capability", async () => {
  const f = await fixture("worker");
  try {
    const capability = f.registry.rotateSpawnCapabilityForReceipt(f.launchId);
    for (const header of ["", capability]) {
      const response = await fetch(`${f.origin}/api/runtime/deployments?kind=host-retirement`, {
        method: "POST", headers: { "content-type": "application/json", "x-llv-spawn-capability": header },
        body: JSON.stringify({ project: "project-a", limit: 25, authentication: { conversationId: f.callerId, seatProject: "project-a" } }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "retirement observation requires authenticated MCP attribution" });
    }
  } finally { await f.close(); }
});

test("MCP pagination stays bounded, excludes unattributed subjects and detects changed reports", async () => {
  const f = await fixture("worker");
  try {
    const report = JSON.parse(fs.readFileSync(f.reportPath, "utf8"));
    report.refused = Array.from({ length: 101 }, () => report.refused[0]);
    fs.writeFileSync(f.reportPath, JSON.stringify(report));
    const before = fs.readFileSync(f.reportPath);
    const first = await f.call({ limit: 900 });
    expect(first).toMatchObject({ ok: true, limit: 100, hasMore: true, maxPages: 20 });
    expect(first.items).toHaveLength(100);
    const second = await f.call({ limit: 900, cursor: first.cursor });
    expect(second).toMatchObject({ ok: true, hasMore: false, cursor: null });
    expect(second.items).toHaveLength(1);
    expect(fs.readFileSync(f.reportPath)).toEqual(before);
    report.finishedAt = "2026-09-01T00:01:00.000Z";
    fs.writeFileSync(f.reportPath, JSON.stringify(report));
    const changed = await f.call({ cursor: first.cursor });
    expect(changed).toMatchObject({ ok: false });
    expect(changed.error).toContain("restart without the cursor");
  } finally { await f.close(); }
});

test("a seat whose designation was replaced is refused on the next read", async () => {
  const f = await fixture("seat");
  try {
    expect(await f.call()).toMatchObject({ ok: true });
    beginOrchestratorSeatIntent({ project: "project-a", mandate: "Replacement", clientRequestId: "replace-seat", mode: "spawn" });
    completeOrchestratorSeatIntent({ project: "project-a", clientRequestId: "replace-seat", conversationId: "conversation_replacement", path: null });
    expect(await f.call()).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

for (const alias of [false, true]) for (const explicit of [false, true]) test(`a revoked seat cannot reuse its worker receipt with ${explicit ? "explicit" : "automatic"} launch identity${alias ? " through a conversation alias" : ""}`, async () => {
  const f = await fixture("worker");
  const read = () => f.call(explicit ? { callerLaunchId: f.launchId } : {});
  const designate = (conversationId: string, clientRequestId: string) => {
    beginOrchestratorSeatIntent({ project: "project-a", mandate: "Own project", clientRequestId, mode: "existing", conversationId });
    completeOrchestratorSeatIntent({ project: "project-a", clientRequestId, conversationId, path: null });
  };
  try {
    const seatId = alias ? "conversation_former_identity" : f.callerId;
    if (alias) {
      const store = new SqliteAgentRegistryStore(path.join(process.env.LLV_STATE_DIR!, "agent-registry.sqlite"), {
        initialSnapshot: f.registry.readOnlySnapshot(), normalize: normalizeRegistry,
      });
      try { store.mutate(snapshot => { snapshot.conversationAliases[seatId] = f.callerId as `conversation_${string}`; }); }
      finally { store.close(); }
    }
    const resolveAlias = (id: string) => f.registry.canonicalConversationId(id as `conversation_${string}`);
    // A Viewer-spawned worker may be adopted as the project's seat.
    expect(await read()).toMatchObject({ ok: true });
    designate(seatId, "adopt-worker");
    expect(productionDomainDependencies.callerAttribution?.()).toMatchObject({ kind: "manager", conversationId: f.callerId });
    expect(await read()).toMatchObject({ ok: true });

    designate("conversation_replacement", "replace-adopted-seat");
    expect(revokedOrchestratorSeatConversationsOrUnknown(resolveAlias)?.has(f.callerId)).toBe(true);
    expect(f.registry.snapshot().receipts[f.launchId]).toMatchObject({ conversationId: f.callerId });
    const refused = await read();
    expect(refused).toMatchObject({ ok: false, details: { code: "retirement_seat_revoked" } });
    expect(refused.items).toBeUndefined();
    expect(JSON.stringify(refused)).not.toContain("event tail unavailable");
    expect(f.requests).toHaveLength(2);

    // Deliberate re-designation advances the epoch beyond the revocation.
    designate(f.callerId, "redesignate-worker");
    expect(revokedOrchestratorSeatConversationsOrUnknown(resolveAlias)?.has(f.callerId)).toBe(false);
    expect(await read()).toMatchObject({ ok: true, items: [expect.objectContaining({ conversationId: f.callerId })] });
    expect(f.requests).toHaveLength(3);
  } finally { await f.close(); }
});

test("a worker discloses no observations while the revocation store is unreadable", async () => {
  const f = await fixture("worker");
  try {
    fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json"), "{broken");
    expect(revokedOrchestratorSeatConversationsOrUnknown()).toBeNull();
    for (const args of [{}, { callerLaunchId: f.launchId }]) {
      const refused = await f.call(args);
      expect(refused).toMatchObject({ ok: false, details: { code: "retirement_authority_unavailable" } });
      expect(refused.items).toBeUndefined();
    }
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test("packaged stdio callers retain project access without inheriting a spawn capability", async () => {
  for (const kind of ["seat", "worker"] as const) {
    const f = await fixture(kind);
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "bin/mcp-server.mjs")],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    const client = new Client({ name: "retirement-stdio-test", version: "1" });
    try {
      expect(process.env.LLV_SPAWN_CAPABILITY).toBeUndefined();
      await client.connect(transport);
      const result = await client.callTool({ name: "deployment_status", arguments: {
        clientRequestId: `stdio-${kind}`, kind: "host-retirement", project: "project-a",
      } });
      expect(result.structuredContent, stderr).toMatchObject({ ok: true, items: [expect.objectContaining({ conversationId: f.callerId })] });
      expect(f.requests).toHaveLength(1);
    } finally { await client.close(); await transport.close(); await f.close(); }
  }
}, 15_000);

test.each(["seat", "worker"] as const)("project aliases preserve %s reads while foreign subjects stay hidden", async (kind) => {
  const f = await fixture(kind);
  try {
    fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), JSON.stringify({
      schemaVersion: 1, aliases: { "project-a": "project-current" }, displayNames: { "project-current": "Current project" },
    }));
    for (const project of ["project-current", "project-a"]) {
      const result = await f.call({ project });
      expect(result).toMatchObject({ ok: true, project: "project-current", items: [expect.objectContaining({ conversationId: f.callerId })] });
      expect(JSON.stringify(result)).not.toContain("conversation_foreign");
      expect(JSON.stringify(result)).not.toContain("conversation_unattributed");
    }
    expect(await f.call({ project: "project-b" })).toMatchObject({ ok: false });
  } finally { await f.close(); }
});
