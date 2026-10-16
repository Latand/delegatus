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

test("cached catalog projection preserves names from file rows omitted by the project catalog", () => {
  const files = [{ project: a, displayName: "File-only board", projectRoot: "/fixture/file-only" }];
  const sources = { lastCompletedCatalog: () => ({ projectCatalog: [], files }) };
  expect(resolveNamedProject("File-only board", namedProjectDirectory(sources))).toBe(a);
  expect(resolveNamedProject("File-only board", namedProjectDirectory(sources))).toBe(a);
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

test("task-only project keys are indexed before short-key writes and collisions refuse", async () => {
  const { saveTasks } = await import("@/lib/tasks/store");
  const prefix = "repo-deadbeef";
  const left = `${prefix}${"a".repeat(24)}`;
  const right = `${prefix}${"b".repeat(24)}`;
  const at = "2026-10-16T00:00:00.000Z";
  const task = (id: string, project: string) => ({ id, text: id, project, status: "inbox" as const, placement: "unplaced" as const, assignments: [], createdAt: at, updatedAt: at });
  saveTasks([task("task-only-a", left), task("task-only-b", right)]);
  await expect(normalizeShortIdArgs({ project: prefix })).rejects.toMatchObject({ details: { code: "ambiguous_project" } });
  let writes = 0;
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const service = createMcpToolService({ create_task: async () => { writes++; return { task: task("unexpected", right) }; } } as never, new MemoryMcpReceiptStore());
  const refused = await service.callTool("create_task", { project: prefix, text: "must refuse" });
  expect(refused).toMatchObject({ ok: false, code: "ambiguous_project" });
  expect(writes).toBe(0);
  saveTasks([task("task-only-a", left)]);
  expect(await normalizeShortIdArgs({ project: left.slice(0, 17) })).toEqual({ project: left });
  expect(await normalizeShortIdArgs({ project: left })).toEqual({ project: left });
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const roundTrip = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());
  const listed = await roundTrip.callTool("list_tasks", { project: left.slice(0, 17) });
  if (!listed.ok) throw new Error(listed.error);
  expect(listed).toMatchObject({ ok: true, tasks: [{ project: "repo-deadbeef" }] });
  const returnedProject = (listed.tasks as Array<{ project: string }>)[0]!.project;
  const created = await roundTrip.callTool("create_task", { clientRequestId: "task-only-round-trip", project: returnedProject, text: "Round-trip task" });
  if (!created.ok) throw new Error(created.error);
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  expect((await import("@/lib/tasks/store")).loadTasks().some(row => row.text === "Round-trip task" && row.project === left)).toBe(true);
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
