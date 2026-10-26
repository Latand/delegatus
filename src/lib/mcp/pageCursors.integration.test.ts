import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, requestDigest, type McpToolBindings } from "./server";
import { viewerMcpBindings } from "./bindings";
import { runAsMcpHttpCaller } from "./callerContext";
import { indexTranscriptSources, searchTranscripts } from "@/lib/search/transcriptSearch";

afterEach(() => setSystemTime());

test("a legacy durable pagination receipt cannot repeat its effects or adopt an unbound continuation", async () => {
  const receipts = new MemoryMcpReceiptStore();
  const args = { clientRequestId: "legacy-activity", project: "fixture" };
  const digest = requestDigest("agent_activity", args);
  receipts.claim("agent_activity:legacy-activity", digest, "durable");
  receipts.complete("agent_activity:legacy-activity", digest, { ok: true, toolName: "agent_activity", clientRequestId: "legacy-activity",
    replayed: false, nextCursor: "legacy-private-state", hasMore: true });
  let effects = 0;
  const service = createMcpToolService({ agent_activity: async () => { effects++; return { nextCursor: "new-state" }; } } as unknown as McpToolBindings, receipts);
  const result = await runAsMcpHttpCaller({ capability: "legacy-caller" }, () => service.callTool("agent_activity", args));
  expect(effects).toBe(0);
  expect(result).toMatchObject({ ok: false, cursorReset: true });
  expect(JSON.stringify(result)).not.toContain("legacy-private-state");
});

test("a real indexed search page shrinks while its snapshot continuation still reads the next conversation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cursor-index-"));
  setSystemTime(new Date("2026-10-17T12:00:00Z"));
  try {
    const sources = [0, 1, 2].map(index => {
      const filename = path.join(directory, `source-${index}.jsonl`);
      fs.writeFileSync(filename, JSON.stringify({ type: "user", timestamp: `2026-10-17T09:00:0${index}Z`,
        message: { role: "user", content: `Quartz cobalt garnet amber for pagination ${index}` } }) + "\n");
      const stat = fs.statSync(filename);
      return { path: filename, engine: "claude" as const, project: "cursor-fixture", size: stat.size, mtimeMs: stat.mtimeMs };
    });
    await indexTranscriptSources(sources, { complete: true });
    const query = "quartz cobalt garnet amber";
    const upstream = searchTranscripts({ query, project: "cursor-fixture", limit: 1, order: "relevance" });
    expect(upstream.nextCursor).toBeString();
    const bindings = viewerMcpBindings(undefined, { post: async () => ({}), get: async pathname => {
      const params = new URL(pathname, "http://localhost").searchParams;
      return (params.has("cursor") ? searchTranscripts({ query, project: "cursor-fixture", limit: 1, order: "relevance", cursor: params.get("cursor")! }) : upstream) as unknown as Record<string, unknown>;
    } });
    const args = { query, project: "cursor-fixture", limit: 1, full: true };
    const before = { ...await bindings.search_transcripts(args), ok: true, toolName: "search_transcripts", clientRequestId: null, replayed: false };
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
    const call = (input: Record<string, unknown>) => runAsMcpHttpCaller({ capability: "index-caller" }, () => service.callTool("search_transcripts", input));
    const samples: Array<{ before: number; after: number }> = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const after = await call(args);
      if (!after.ok) throw new Error(after.error);
      expect(after).toMatchObject({ ok: true, total: 3 });
      expect(String(after.nextCursor).length).toBe(22);
      expect({ ...after, nextCursor: upstream.nextCursor } as Record<string, unknown>).toEqual(before);
      samples.push({ before: Buffer.byteLength(JSON.stringify(before)), after: Buffer.byteLength(JSON.stringify(after)) });
      const next = await call({ ...args, cursor: after.nextCursor });
      if (!next.ok) throw new Error(next.error);
      expect(next).toMatchObject({ ok: true, total: 3 });
      expect(next.items).not.toEqual(after.items);
    }
    expect(new Set(samples.map(row => JSON.stringify(row))).size).toBe(1);
    expect(samples[0]!.after).toBeLessThan(samples[0]!.before);
    console.log("MCP cursor response bytes " + JSON.stringify({ samples, upstreamCursorChars: upstream.nextCursor!.length, handleChars: 22 }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("registered tools describe short expiring handles and carry them unchanged over MCP", async () => {
  const bindings = viewerMcpBindings(undefined, { post: async () => ({}), get: async () => ({ items: [], total: 2,
    nextCursor: Buffer.from(JSON.stringify({ query: "quartz", offset: 1 })).toString("base64url"),
    stats: { conversationsIndexed: 2, messagesIndexed: 2, fieldsSearched: ["message.body"], tokenizer: "fixture" } }) });
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "cursor-fixture", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = await client.callTool({ name: "search_transcripts", arguments: { query: "quartz" } });
    expect(String((result.structuredContent as Record<string, unknown>).nextCursor).length).toBe(22);
  } finally { await Promise.all([client.close(), server.close()]); }
});
