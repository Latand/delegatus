import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { memoryIndex } from "@/lib/memory/service";
import { GET, POST } from "./route";

test("the real MCP binding searches both engines via the Viewer route, filters scope, opens and records a hit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-route-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
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
    expect((await bindings.search_memory({ clientRequestId: "other-project", query: "widget", project: "project-b" })).items).toEqual([]);
    expect((await bindings.search_memory({ clientRequestId: "open-hit", id, project: "project-a" })).item).toMatchObject({ body: "Keep widget reports brief.\n" });
    await bindings.search_memory({ clientRequestId: "open-hit", id, project: "project-a" });
    expect(index.offers(id)).toHaveLength(1);
    expect((await POST(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id, requestId: "wrong-scope", project: "project-b" }) }))).status).toBe(404);
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
  } finally {
    index.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
