import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { MEMORY_RESPONSE_BYTES } from "@/lib/memory/index";
import { memoryIndex } from "@/lib/memory/service";
import { GET, POST } from "./route";

// The explicit-path gate gives each file a private TMPDIR but may leave its
// directory creation to the test. The OS temp root itself must exist first.
fs.mkdirSync(os.tmpdir(), { recursive: true });

test("the real MCP binding searches both engines via the Viewer route, filters scope, opens bounded hits and records outcomes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-route-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  const claude = path.join(root, "topic.md"), codex = path.join(root, "MEMORY.md");
  fs.writeFileSync(claude, "---\nname: Widget feedback\ndescription: Widget report preference\ntype: feedback\n---\nKeep widget reports brief.\n");
  fs.writeFileSync(codex, "# Task Group: Widget\n## Task 1: Widget cache\n### rollout_summary_files\n- rollout_summaries/example.md (cwd=/workspace/widget, updated_at=2026-10-01T10:00:00Z)\n### Reusable knowledge\n- Widget cache holds eight entries.\n");
  const index = memoryIndex();
  try {
    await index.refresh([{ path: claude, engine: "claude", sourceKind: "claude_memory", project: "project-a" }, { path: codex, engine: "codex", sourceKind: "codex_memory" }]);
    const bindings = viewerMcpBindings(undefined, {
      get: async pathname => (await GET(new Request(`http://localhost${pathname}`))).json(),
      post: async (pathname, body) => (await POST(new Request(`http://localhost${pathname}`, { method: "POST", body: JSON.stringify(body) }))).json(),
    });
    const cross = await bindings.search_memory({ clientRequestId: "cross-search", query: "widget" });
    expect((cross.items as Array<{ engine: string }>).map(item => item.engine).sort()).toEqual(["claude", "codex"]);
    const page = await bindings.search_memory({ clientRequestId: "scoped-search", query: "widget", project: "project-a", kind: "preference" });
    const id = (page.items as Array<{ id: string }>)[0].id;
    const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
    const compactSearch = await service.callTool("search_memory", { clientRequestId: "short-search", query: "widget", project: "project-a", kind: "preference" });
    if (!compactSearch.ok) throw new Error(compactSearch.error);
    const shortId = (compactSearch.items as Array<{ id: string }>)[0]!.id;
    expect(shortId).toMatch(/^m_[a-f0-9]{8}$/i);
    const compactOpen = await service.callTool("search_memory", { clientRequestId: "short-open", id: shortId, project: "project-a" });
    expect(compactOpen).toMatchObject({ ok: true, item: { body: "Keep widget reports brief.\n" } });
    const upperShort = await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id: shortId.toUpperCase(), requestId: "short-open-upper", project: "project-a" }) }));
    expect(upperShort.status).toBe(200);
    expect((await bindings.search_memory({ clientRequestId: "other-project", query: "widget", project: "project-b" })).items).toEqual([]);
    expect((await bindings.search_memory({ clientRequestId: "open-hit", id, project: "project-a" })).item).toMatchObject({ body: "Keep widget reports brief.\n" });
    await bindings.search_memory({ clientRequestId: "open-hit", id, project: "project-a" });
    expect(index.offers(id)).toHaveLength(3);
    expect((await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id, requestId: "wrong-scope", project: "project-b" }) }))).status).toBe(404);
    expect((await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id: "m_ffffffff", requestId: "stale-short-id" }) }))).status).toBe(404);
    const db = (index as unknown as { database(): { query(sql: string): { run(...values: unknown[]): unknown } } }).database();
    const insert = db.query("INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const suffix of ["a", "b"]) insert.run(`m_12345678${suffix.repeat(16)}`, "claude", "preference", "global", null, claude, "claude_memory", "Collision", "Collision summary", "Collision body", "2026-10-01T00:00:00.000Z", "[]");
    const collision = await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id: "m_12345678", requestId: "colliding-short-id" }) }));
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({ code: "short_id_ambiguous" });
    expect((await GET(new Request("http://localhost/api/search/memory?q=widget&kind=typo"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/search/memory"))).status).toBe(400);
    const routedSummary = path.join(root, "memory_summary.md");
    fs.writeFileSync(routedSummary, "v1\n## User preferences\n- Keep synthetic reports brief.\n## What's in Memory\n## /workspace/widget\n### 2026-10-01\n- Synthetic widget retry rules stay bounded.\n### User preferences\n- Project-only synthetic widget preference.\n## Other topics\n### 2026-10-02\n- Synthetic unscoped shape must be skipped.\n");
    await index.refresh([{ path: routedSummary, engine: "codex", sourceKind: "codex_summary" }]);
    const summaryHits = (await bindings.search_memory({ clientRequestId: "routed-summary", query: "synthetic" })).items as Array<{ id: string; scope: string; project: string | null }>;
    expect(summaryHits).toHaveLength(3);
    const routedHit = summaryHits.find(item => item.scope === "project")!;
    const sameProject = await bindings.search_memory({ clientRequestId: "routed-summary-scope", query: "synthetic", project: routedHit.project! });
    expect(sameProject.items).toHaveLength(3);
    expect((await bindings.search_memory({ clientRequestId: "routed-other-scope", query: "synthetic", project: "project-b" })).items).toHaveLength(1);

    const sourceDirectory = path.join(root, ...Array.from({ length: 5 }, () => "d".repeat(200)));
    fs.mkdirSync(sourceDirectory, { recursive: true });
    const sourcePath = path.join(sourceDirectory, "topic.md");
    const escaped = "\u0001";
    fs.writeFileSync(sourcePath, `---\nname: Widget${escaped.repeat(154)}\ndescription: Widget${escaped.repeat(394)}\ntype: feedback\n---\nWidget${escaped.repeat(2042)}\n`);
    await index.refresh([{ path: sourcePath, engine: "claude", sourceKind: "claude_memory", project: "project-a" }]);
    const escapedHits = (await bindings.search_memory({ clientRequestId: "escaped-open-search", query: "widget" })).items as Array<{ id: string; sourcePath: string }>;
    const escapedHit = escapedHits.find(hit => hit.sourcePath.endsWith("topic.md"))!;
    const opened = await bindings.search_memory({ clientRequestId: "escaped-open-hit", id: escapedHit.id });
    expect(Buffer.byteLength(JSON.stringify({ item: opened.item }))).toBeLessThanOrEqual(MEMORY_RESPONSE_BYTES);
    expect((opened.item as { sourcePath: string }).sourcePath).toContain("topic.md");
    expect((opened.item as { body: string }).body.length).toBeGreaterThan(0);
    expect((opened.item as { truncated: boolean }).truncated).toBe(true);
  } finally {
    index.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("an unavailable memory index returns one bounded failure through MCP and can be retried after repair", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-unavailable-"));
  const previous = process.env.LLV_STATE_DIR;
  const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_STATE_DIR = root;
  const filename = path.join(root, "memory-index.sqlite");
  fs.writeFileSync(filename, "invalid database fixture");
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const { productionViewerControlDependencies, productionDomainDependencies } = await import("@/lib/mcp/bindings");
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    try { return request.method === "POST" ? await POST(request) : await GET(request); }
    catch { return new Response("<html>Internal server error</html>", { status: 500 }); }
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${server.port}`;
  try {
    const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), { ...productionDomainDependencies, callerAttribution: () => ({ kind: "unidentified", conversationId: null, role: null }) }), new MemoryMcpReceiptStore());
    const result = await service.callTool("search_memory", { clientRequestId: "unavailable-search", query: "widget" }, { deadlineAt: Date.now() + 30_000 });
    expect(result).toMatchObject({ ok: false, error: "Memory search is unavailable; retry later or check index diagnostics." });
    expect(requests).toBe(1);
    const opened = await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id: "m_12345678", requestId: "unavailable-open" }) }));
    expect(opened.status).toBe(503);
    expect(await opened.json()).toEqual({ code: "MEMORY_SEARCH_UNAVAILABLE", error: "Memory search is unavailable; retry later or check index diagnostics." });
    memoryIndex().close();
    fs.unlinkSync(filename);
    const repaired = await service.callTool("search_memory", { clientRequestId: "repaired-search", query: "widget" }, { deadlineAt: Date.now() + 30_000 });
    expect(repaired).toMatchObject({ ok: true, items: [] });
    expect(requests).toBe(2);
  } finally {
    server.stop(true);
    memoryIndex().close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("index failures emit a safe diagnostic without database paths or query text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-diagnostic-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  fs.writeFileSync(path.join(root, "memory-index.sqlite"), "invalid database fixture");
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await GET(new Request("http://localhost/api/search/memory?q=private-query-fixture"));
    expect(response.status).toBe(503);
    expect(diagnostic).toHaveBeenCalledWith("[search unavailable]", "memory", "SQLITE_NOTADB");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(root);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-query-fixture");
  } finally {
    diagnostic.mockRestore();
    memoryIndex().close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("search_memory finds and opens every rendered role rule by exact id, near id and text without engine indexing", async () => {
  const { roleMemoryCollection, learnedRulesSnapshot } = await import("@/lib/memory/roleStore");
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-search-"));
  process.env.LLV_STATE_DIR = root;
  const at = "2026-10-19T00:00:00.000Z";
  const scopes = ["role:project-a:builder", "role:*:builder", "project:project-a", "machine"];
  const ids = scopes.map((_, n) => `r_${String(n + 1).padStart(16, "0")}`);
  const rule = (id: string, scope: string, text: string) => ({ kind: "rule" as const, id, scope, rule: text, why: "Private provenance must stay outside search results.", state: "active" as const, hints: [], source: { project: "project-a", pipelineId: "seed", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_seed" }, createdAt: at, changedAt: at });
  const index = memoryIndex();
  const decode = async (response: Response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  };
  const control = {
    get: async (url: string) => decode(await GET(new Request(`http://localhost${url}`))),
    post: async (_url: string, body: unknown) => decode(await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify(body) }))),
  };
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const service = createMcpToolService(viewerMcpBindings(undefined, control, { callerAttribution: () => ({ kind: "unidentified", conversationId: null, role: null }) } as never), new MemoryMcpReceiptStore());
  let request = 0;
  const call = (args: Record<string, unknown>) => service.callTool("search_memory", { clientRequestId: `role-search-${request += 1}`, ...args });
  try {
    const store = roleMemoryCollection(true)!;
    store.boundedPatch(30, tx => {
      scopes.forEach((scope, n) => {
        tx.put({ kind: "scope", scope, revision: 1, active: [ids[n]], history: [] });
        tx.put(rule(ids[n], scope, `Verify the ${["amber", "bronze", "cobalt", "denim"][n]} receipt before replaying its durable operation.`));
      });
      const foreign = "r_1000000000000001";
      tx.put({ kind: "scope", scope: "role:project-b:builder", revision: 1, active: [foreign], history: [] });
      tx.put(rule(foreign, "role:project-b:builder", "Verify the foreign receipt before replaying its durable operation."));
      tx.put({ ...rule("r_2000000000000001", scopes[0], "Verify the archived receipt before replaying its durable operation."), state: "archived" });
      tx.put({ ...rule("r_3000000000000001", scopes[0], "Verify the version receipt before replaying its durable operation."), versionOf: ids[0] });
      tx.put(rule("r_4000000000000001", scopes[0], "Verify the unlisted receipt before replaying its durable operation."));
      tx.put({ kind: "scope", scope: scopes[0], revision: 1, active: [ids[0], "r_2000000000000001", "r_3000000000000001"], history: [] });
    });
    const rendered = [...learnedRulesSnapshot("project-a", "builder").block.matchAll(/^- \[([^\]]+)\]/gm)].map(match => match[1]);
    expect(rendered).toEqual(ids);
    for (const [n, id] of rendered.entries()) {
      const query = [id, id.slice(0, -1), ["amber", "bronze", "cobalt", "denim"][n]];
      for (const q of query) {
        const result = await call({ query: q, project: "project-a" });
        expect(result).toMatchObject({ ok: true, items: expect.arrayContaining([expect.objectContaining({ id })]) });
      }
      const result = await call({ id, project: "project-a" });
      expect(result).toMatchObject({ ok: true, item: { id, engine: "shared", kind: "instruction", body: store.get(`r:${id}`)?.kind === "rule" ? (store.get(`r:${id}`) as { rule: string }).rule : "" } });
      expect(JSON.stringify(result)).not.toContain("Private provenance");
    }
    expect(await call({ query: "amber" })).toMatchObject({ ok: true, items: [{ id: ids[0] }] });
    for (const query of ["foreign", "archived", "version", "unlisted"]) expect(await call({ query, project: "project-a" })).toMatchObject({ ok: true, items: [] });
    for (const id of ["r_1000000000000001", "r_2000000000000001", "r_3000000000000001", "r_4000000000000001"]) {
      expect(await call({ id, project: "project-a" })).toMatchObject({ ok: false, error: "memory entry not found" });
      const refused = await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id, project: "project-a", requestId: `refused-${id}` }) }));
      expect(refused.status).toBe(404);
    }
    expect(await call({ query: "receipt", project: "project-a", kind: "preference" })).toMatchObject({ ok: true, items: [] });
    expect(await call({ query: "receipt", project: "project-a", limit: 2 })).toMatchObject({ ok: true, items: [{ id: ids[0] }, { id: ids[1] }], truncated: true });
    // A peer rewrite is visible immediately; no discovery or refresh is needed.
    store.boundedPatch(1, tx => { tx.put(rule(ids[0], scopes[0], "Verify the emerald receipt before replaying its durable operation.")); });
    expect(await call({ query: "amber", project: "project-a" })).toMatchObject({ ok: true, items: [] });
    expect(await call({ query: "emerald", project: "project-a" })).toMatchObject({ ok: true, items: [{ id: ids[0] }] });
    const { persistProjectAliases } = await import("@/lib/projects/aliases");
    const { joinMovedScopes } = await import("@/lib/memory/roleStore");
    expect(persistProjectAliases([{ source: "project-a", target: "project-renamed", displayName: "Renamed fixture" }])).toBe(true);
    joinMovedScopes(at);
    expect(await call({ query: "emerald", project: "project-renamed" })).toMatchObject({ ok: true, items: [{ id: ids[0] }] });
    expect(await call({ id: ids[0], project: "project-renamed" })).toMatchObject({ ok: true, item: { id: ids[0], project: "project-renamed" } });
  } finally {
    index.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("the registered MCP search opens returned rule ids and matches Cyrillic text without case sensitivity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-search-mcp-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  const at = "2026-10-19T00:00:00.000Z";
  const id = "r_0123456789abcdef";
  const scope = "role:project-cyrillic:builder";
  const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
  const store = roleMemoryCollection(true)!;
  const index = memoryIndex();
  const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const control = {
    get: async (url: string) => {
      const response = await GET(new Request(`http://localhost${url}`));
      return response.json();
    },
    post: async (_url: string, body: unknown) => {
      const response = await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify(body) }));
      return response.json();
    },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, control, { callerAttribution: () => ({ kind: "unidentified", conversationId: null, role: null }) } as never), new MemoryMcpReceiptStore());
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "role-search-regression", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    store.boundedPatch(2, tx => {
      tx.put({ kind: "scope", scope, revision: 1, active: [id], history: [] });
      tx.put({ kind: "rule", id, scope, rule: "Перевіряйте підпис перед повтором операції.", why: "Search must handle Unicode case consistently.", state: "active", hints: [], source: { project: "project-cyrillic", pipelineId: "seed", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_seed" }, createdAt: at, changedAt: at });
    });
    const direct = await GET(new Request("http://localhost/api/search/memory?q=Перевіряйте&project=project-cyrillic"));
    expect(direct.ok, await direct.clone().text()).toBe(true);
    expect((await direct.json()).items.map((item: { id: string }) => item.id)).toContain(id);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    for (const [n, query] of ["Перевіряйте", "перевіряйте"].entries()) {
      const found = await client.callTool({ name: "search_memory", arguments: { clientRequestId: `cyrillic-search-${n}`, query, project: "project-cyrillic" } });
      expect(found.isError, JSON.stringify(found)).not.toBe(true);
      const items = (found.structuredContent as { items: Array<{ id: string }> }).items;
      expect(items.map(item => item.id)).toContain(id);
      const opened = await client.callTool({ name: "search_memory", arguments: { clientRequestId: `cyrillic-open-${n}`, id: items.find(item => item.id === id)!.id, project: "project-cyrillic" } });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({ item: { id, body: "Перевіряйте підпис перед повтором операції." } });
    }
    const malformed = await client.callTool({ name: "search_memory", arguments: { clientRequestId: "malformed-rule-id", id: "r_0123456789abcde", project: "project-cyrillic" } });
    expect(malformed.isError).toBe(true);
  } finally {
    await Promise.all([client.close(), server.close()]);
    store.boundedPatch(2, tx => { tx.delete(`s:${scope}`); tx.delete(`r:${id}`); });
    index.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("the registered search_memory schema accepts full rule ids and refuses malformed ones", async () => {
  const id = "r_0123456789abcdef";
  const calls: Record<string, unknown>[] = [];
  const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const service = createMcpToolService({ search_memory: async (args: Record<string, unknown>) => {
    calls.push(args);
    return args.id ? { item: { id, body: "rule body" } } : { items: [{ id, summary: "rule body" }] };
  } } as never, new MemoryMcpReceiptStore());
  const server = createViewerMcpServer(service, ["search_memory"]);
  const client = new Client({ name: "rule-id-schema-regression", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const found = await client.callTool({ name: "search_memory", arguments: { clientRequestId: "rule-schema-search", query: "rule" } });
    const returnedId = (found.structuredContent as { items: Array<{ id: string }> }).items[0]!.id;
    expect(returnedId).toBe(id);
    const opened = await client.callTool({ name: "search_memory", arguments: { clientRequestId: "rule-schema-open", id: returnedId } });
    expect(opened.isError).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({ item: { id, body: "rule body" } });
    const count = calls.length;
    const malformed = await client.callTool({ name: "search_memory", arguments: { clientRequestId: "rule-schema-invalid", id: "r_0123456789abcde" } });
    expect(malformed.isError).toBe(true);
    expect(calls).toHaveLength(count);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
