import { expect, test } from "bun:test";
import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { MCP_TOOL_NAMES } from "./server";

test("search_memory registers and forwards bounded project/kind search to the Viewer-owned index", async () => {
  const reads: string[] = [];
  const page = { items: [], truncated: false };
  const control: ViewerControlDependencies = {
    get: async pathname => { reads.push(pathname); return page; }, post: async () => ({}),
  };
  expect(MCP_TOOL_NAMES as readonly string[]).toContain("search_memory");
  const result = await viewerMcpBindings(undefined, control).search_memory({ clientRequestId: "memory-search", query: "widget cache", project: "project-a", kind: "preference", limit: 999 });
  expect(reads).toEqual(["/api/search/memory?q=widget+cache&project=project-a&kind=preference&maxBytes=15889&limit=20"]);
  expect(result).toEqual(page);
});

test("search_memory opens by id through the Viewer and carries its idempotency key", async () => {
  const writes: unknown[] = [];
  const control: ViewerControlDependencies = {
    post: async (pathname, body) => { writes.push({ pathname, body }); return { item: { id: "m_fixture", body: "Synthetic widget rule" } }; },
  };
  const result = await viewerMcpBindings(undefined, control).search_memory({ clientRequestId: "memory-open", id: "m_fixture", project: "project-a" });
  expect(writes).toMatchObject([{ pathname: "/api/search/memory", body: { id: "m_fixture", project: "project-a", requestId: "memory-open" } }]);
  expect(result).toMatchObject({ item: { body: "Synthetic widget rule" } });
});
