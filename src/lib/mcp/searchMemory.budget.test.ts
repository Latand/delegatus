import { afterAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-budget-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const [{ viewerMcpBindings }, { createMcpToolService, MemoryMcpReceiptStore }, { memoryIndex }, { GET, POST }] = await Promise.all([
  import("./bindings"), import("./server"), import("@/lib/memory/service"), import("@/app/api/search/memory/route"),
]);
const index = memoryIndex();
const sourceRoot = path.join(sandbox, "skills");
fs.mkdirSync(sourceRoot, { recursive: true });
const sources = Array.from({ length: 20 }, (_, n) => {
  const sourcePath = path.join(sourceRoot, `widget-${n}`, "SKILL.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `---\nname: widget-${n}\ndescription: ${"\u0001".repeat(400)}\n---\nwidget body ${n}\n`);
  return { path: sourcePath, sourceKind: "skill" as const, engine: "shared" as const };
});
await index.refresh(sources);

const control = {
  get: async (pathname: string) => {
    const response = await GET(new Request(`http://viewer${pathname}`));
    return response.json();
  },
  post: async (_pathname: string, body: unknown) => {
    const response = await POST(new Request("http://viewer/api/search/memory", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return response.json();
  },
};
const service = createMcpToolService(viewerMcpBindings(undefined, control), new MemoryMcpReceiptStore());

afterAll(() => {
  index.close();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("search_memory keeps the complete MCP envelope within 16,000 bytes for escaped content and bounded keys", async () => {
  for (const clientRequestId of ["ordinary-key", "\u0002".repeat(256)]) {
    const result = await service.callTool("search_memory", { clientRequestId, query: "widget", limit: 20 });
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_000);
  }
});

test("search_memory open stays bounded, and rejects an overlong caller key", async () => {
  const id = index.search({ query: "widget" }).items[0]!.id;
  for (const clientRequestId of ["open-key", `o${"\u0002".repeat(255)}`]) {
    const result = await service.callTool("search_memory", { clientRequestId, id });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_000);
  }
  const rejected = await service.callTool("search_memory", { clientRequestId: "r".repeat(20_000), query: "widget" });
  expect(rejected.ok).toBe(false);
});

test("discovery and indexing refuse a hit whose source metadata alone exceeds the POST budget", async () => {
  const { discoverMemorySources } = await import("@/lib/memory/sources");
  const longRoot = path.join(sandbox, ...Array.from({ length: 12 }, () => "\u0001".repeat(240)));
  const sourcePath = path.join(longRoot, "SKILL.md");
  fs.mkdirSync(longRoot, { recursive: true });
  fs.writeFileSync(sourcePath, "---\nname: widget pointer\ndescription: Widget pointer\n---\nWidget metadata fixture.\n");
  const inventory = await discoverMemorySources({ claudeHomes: [], codexHome: path.join(sandbox, "codex"), skillRoots: [longRoot] });
  expect(inventory.sources.some(source => source.path === sourcePath), JSON.stringify({ count: inventory.sources.length, complete: inventory.complete })).toBe(true);
  await index.refresh(inventory.sources);
  const id = "m_" + crypto.createHash("sha256").update(`shared\0${sourcePath}\0skill`).digest("hex").slice(0, 24);
  const response = await POST(new Request("http://viewer/api/search/memory", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, requestId: "metadata-overflow" }),
  }));
  expect(response.status).toBe(404);
  expect(Buffer.byteLength(await response.text())).toBeLessThanOrEqual(16_000);
  expect(index.offers(id)).toEqual([]);
});
