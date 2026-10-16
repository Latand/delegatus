import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-short-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const { persistProjectAliases } = await import("./aliases");
const { namedProjectDirectory, resolveNamedProject } = await import("./nameResolution");
const { normalizeShortIdArgs } = await import("@/lib/mcp/shortIdArgs");
const a = "repo-12345678aaaa" + "a".repeat(20), b = "repo-12345678bbbb" + "b".repeat(20);

test("short project keys resolve at the boundary and through names; ambiguity never reads an empty board", async () => {
  persistProjectAliases([{ source: "fixture-old", target: a, displayName: "First project" }]);
  expect(await normalizeShortIdArgs({ project: a.slice(0, 13), expectedProject: a.slice(0, 12).toUpperCase() })).toEqual({ project: a, expectedProject: a });
  expect(resolveNamedProject(a.slice(0, 12), namedProjectDirectory())).toBe(a);
  persistProjectAliases([{ source: "second-old", target: b, displayName: "Second project" }]);
  await expect(normalizeShortIdArgs({ project: a.slice(0, 13) })).rejects.toMatchObject({ details: { code: "ambiguous_project" } });
  expect(() => resolveNamedProject(a.slice(0, 13), namedProjectDirectory())).toThrow("ambiguous");
  expect(await normalizeShortIdArgs({ project: b.slice(0, 17) })).toEqual({ project: b });
  expect(await normalizeShortIdArgs({ project: a })).toEqual({ project: a });
  await expect(normalizeShortIdArgs({ project: "repo-ffffffff" })).rejects.toMatchObject({ details: { code: "unknown_project" } });
});

test("list_tasks reads the same rows with a full or a unique short project key", async () => {
  const { saveTasks } = await import("@/lib/tasks/store");
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const at = "2026-10-16T00:00:00.000Z";
  saveTasks([{ id: "short-project-task", text: "Fixture work", project: a, status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at }]);
  const service = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());
  const full = await service.callTool("list_tasks", { project: a });
  const short = await service.callTool("list_tasks", { project: a.slice(0, 17) });
  expect(short.ok).toBe(true); expect(short).toEqual(full);
  expect(JSON.stringify(short)).toContain("short-project-task");
});

test("a short expectedProject preserves an aliased task's stored project guard", async () => {
  const old = "repo-abcdef01" + "c".repeat(24);
  persistProjectAliases([{ source: old, target: a, displayName: "First project" }]);
  expect(await normalizeShortIdArgs({ project: old.slice(0, 13), expectedProject: old.slice(0, 13) })).toEqual({ project: a, expectedProject: old });
});

test("project-prefix admission observes cancellation before reading state", async () => {
  await expect(normalizeShortIdArgs({ project: a.slice(0, 17) }, { signal: AbortSignal.abort() })).rejects.toThrow();
});

test("a null cancellation reason returns a refusal before a project tool runs", async () => {
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  let calls = 0;
  const service = createMcpToolService({ list_tasks: async () => { calls++; return { tasks: [] }; } } as never, new MemoryMcpReceiptStore());
  const answer = await service.callTool("list_tasks", { project: a.slice(0, 17) }, { signal: AbortSignal.abort(null) });
  expect(answer.ok).toBe(false); expect(calls).toBe(0);
});
