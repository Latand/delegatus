/**
 * Task icons through every published surface (#2102): MCP `create_task`,
 * `update_task`, `list_tasks` and `get_task`, the HTTP create and PATCH the
 * board sends, the stored row, and the route that draws an icon. One command
 * reads the icon for both surfaces, so both store the same name and clamp the
 * same unknown one to none with a note.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { TaskWithRevision } from "@/lib/tasks/revision";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-icon-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");
const { TASKS_FILE, loadTasks, saveTasks } = await import("@/lib/tasks/store");
const { NextRequest } = await import("next/server");
const { POST } = await import("@/app/api/tasks/route");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
const { GET: getIcons } = await import("@/app/api/task-icons/route");
expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);

type Answer = { ok: boolean; task: TaskWithRevision & { icon?: string }; notes?: string[]; changedFields?: string[]; tasks?: Array<{ id: string; icon?: string }> };

async function protocol() {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, `receipts-${Math.random().toString(36).slice(2)}.sqlite`));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-icon-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { clientRequestId: `icon-${Math.random().toString(36).slice(2)}-${++sequence}`, ...args } })).structuredContent as Answer;
  return { client, call, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

const json = (method: string, body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/tasks", { method, headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });
const stored = (id: string) => loadTasks().find((row) => row.id === id)!;

test("create_task and update_task publish icon, tell agents to set it, and store the normalised name", async () => {
  const p = await protocol();
  try {
    const { tools } = await p.client.listTools();
    for (const name of ["create_task", "update_task"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const icon = (tool.inputSchema.properties as Record<string, { type?: unknown; description?: string }>).icon;
      expect({ name, described: icon?.description?.includes("lucide") }).toEqual({ name, described: true });
      expect({ name, told: tool.description?.includes("`icon`") }).toEqual({ name, told: true });
    }

    const created = await p.call("create_task", { project: "icon-project", text: "Fix the crash", icon: "lucide:Bug" });
    expect(created).toMatchObject({ ok: true, task: { icon: "bug" } });
    expect(created.notes).toBeUndefined();
    expect(created.changedFields).toContain("icon");
    expect(stored(created.task.id).icon).toBe("bug");

    const updated = await p.call("update_task", { taskId: created.task.id, icon: "Search Check" });
    expect(updated).toMatchObject({ ok: true, task: { icon: "search-check" }, changedFields: ["icon"] });
    /* Presentation: the row keeps its updatedAt. */
    expect(stored(created.task.id).updatedAt).toBe(created.task.updatedAt);

    /* list_tasks, compact by default, and get_task both return it. */
    const listed = await p.call("list_tasks", { ids: [created.task.id] });
    expect((listed as unknown as { tasks: Array<{ id: string; icon?: string }> }).tasks[0]).toMatchObject({ id: created.task.id, icon: "search-check" });
    const read = await p.call("get_task", { taskId: created.task.id });
    expect(read.task.icon).toBe("search-check");
  } finally { await p.close(); }
});

test("an unknown icon is never an error: it is stored as none and the answer says so, on MCP and HTTP alike", async () => {
  const p = await protocol();
  try {
    const created = await p.call("create_task", { project: "icon-project", text: "Ship the release", icon: "starship" });
    expect(created.ok).toBe(true);
    expect("icon" in created.task).toBe(false);
    expect(created.notes?.[0]).toContain('"starship" is not a lucide icon name');

    const set = await p.call("update_task", { taskId: created.task.id, icon: "rocket" });
    expect(set.task.icon).toBe("rocket");
    const clamped = await p.call("update_task", { taskId: created.task.id, icon: "rockett" });
    expect(clamped.ok).toBe(true);
    expect(clamped.notes?.[0]).toContain("close names: rocket");
    expect("icon" in stored(created.task.id)).toBe(false);
    const cleared = await p.call("update_task", { taskId: created.task.id, icon: null });
    expect(cleared.ok).toBe(true);

    const posted = await POST(json("POST", { project: "icon-project", text: "Review the graph", placement: "unplaced", icon: "SearchCheck" }));
    expect(posted.status).toBe(200);
    const body = await posted.json() as { task: { id: string; icon?: string }; notes?: string[] };
    expect(body.task.icon).toBe("search-check");
    expect(body.notes).toBeUndefined();

    const row = stored(body.task.id) as TaskWithRevision;
    const patched = await PATCH(json("PATCH", { icon: "not an icon at all", expectedProject: row.project, expectedRevision: row.revision }), { params: Promise.resolve({ id: body.task.id }) });
    expect(patched.status).toBe(200);
    const patchBody = await patched.json() as { task: { icon?: string }; notes?: string[] };
    expect(patchBody.task.icon).toBeUndefined();
    expect(patchBody.notes?.[0]).toContain("is not a lucide icon name");
    const restored = await PATCH(json("PATCH", { icon: "Bug" }), { params: Promise.resolve({ id: body.task.id }) });
    expect((await restored.json() as { task: { icon?: string } }).task.icon).toBe("bug");
  } finally { await p.close(); }
});

test("the icon survives the store round trip, and a row whose icon is not a name loads without one", () => {
  const rows = loadTasks();
  const withIcon = rows.find((row) => row.icon === "bug")!;
  expect(withIcon).toBeTruthy();
  saveTasks(rows.map((row) => (row.id === withIcon.id ? row : row.icon ? { ...row, icon: 7 as unknown as string } : row)));
  const reloaded = loadTasks();
  expect(reloaded).toHaveLength(rows.length);
  expect(reloaded.find((row) => row.id === withIcon.id)!.icon).toBe("bug");
  for (const row of reloaded.filter((candidate) => candidate.id !== withIcon.id)) expect(row.icon === undefined || typeof row.icon === "string").toBe(true);
});

test("the icon route draws the names a page asks for, and null for a name lucide does not have", async () => {
  const response = await getIcons(new NextRequest("http://localhost/api/task-icons?names=bug,rocket,not-an-icon"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("max-age");
  const { icons } = await response.json() as { icons: Record<string, unknown[] | null> };
  expect(Object.keys(icons).sort()).toEqual(["bug", "not-an-icon", "rocket"]);
  expect(icons.bug?.length).toBeGreaterThan(0);
  expect(icons.rocket?.length).toBeGreaterThan(0);
  expect(icons["not-an-icon"]).toBeNull();
});
