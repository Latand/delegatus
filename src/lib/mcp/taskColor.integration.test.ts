/**
 * A new task's colour through every create surface: MCP `create_task` and the
 * HTTP create the board sends store it and answer it, an unknown colour is
 * clamped to none with a note on both, and the create_task and update_task
 * descriptions carry the colour and icon rule the rule module renders.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { TaskWithRevision } from "@/lib/tasks/revision";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-color-"));
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
const { TASKS_FILE, loadTasks } = await import("@/lib/tasks/store");
const { renderTaskColorRule } = await import("@/lib/tasks/colorRule");
const { NextRequest } = await import("next/server");
const { POST } = await import("@/app/api/tasks/route");
expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);

type Answer = { ok: boolean; task: TaskWithRevision & { color?: string; icon?: string }; notes?: string[]; changedFields?: string[]; changes?: Record<string, unknown> };

async function protocol() {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, `receipts-${Math.random().toString(36).slice(2)}.sqlite`));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-color-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { clientRequestId: `color-${Math.random().toString(36).slice(2)}-${++sequence}`, ...args } })).structuredContent as Answer;
  return { client, call, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

const request = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });
const stored = (id: string) => loadTasks().find((row) => row.id === id)!;

test("create_task stores the colour it is given and answers it in changedFields", async () => {
  const p = await protocol();
  try {
    const created = await p.call("create_task", { project: "color-project", text: "Tidy the test helpers", icon: "wrench", color: "slate" });
    expect(created).toMatchObject({ ok: true, task: { color: "slate", icon: "wrench" }, changes: { color: "slate" } });
    expect(created.changedFields).toContain("color");
    expect(created.notes).toBeUndefined();
    expect(stored(created.task.id).color).toBe("slate");

    /* none, like an absent colour, creates the task without one and no note. */
    const none = await p.call("create_task", { project: "color-project", text: "No colour on purpose", color: "none" });
    expect(none.ok).toBe(true);
    expect("color" in none.task).toBe(false);
    expect(none.notes).toBeUndefined();
  } finally { await p.close(); }
});

test("an unknown colour is never an error: it is stored as none and the answer says so, on MCP and HTTP alike", async () => {
  const p = await protocol();
  try {
    const created = await p.call("create_task", { project: "color-project", text: "Colour nobody has", icon: "bug", color: "mauve" });
    expect(created.ok).toBe(true);
    expect(created.task.icon).toBe("bug");
    expect("color" in created.task).toBe(false);
    expect("color" in stored(created.task.id)).toBe(false);
    expect(created.notes).toEqual(['color "mauve" is not one of coral, amber, lime, teal, sky, violet, pink, slate, so the task has no colour']);

    /* An unknown icon and an unknown colour each leave their own note. */
    const both = await p.call("create_task", { project: "color-project", text: "Two clamps", icon: "starship", color: 7 });
    expect(both.ok).toBe(true);
    expect(both.notes).toHaveLength(2);
    expect(both.notes?.[1]).toContain("color number is not one of");
  } finally { await p.close(); }

  const posted = await POST(request({ project: "color-project", text: "Fix the phone layout", placement: "unplaced", icon: "smartphone", color: "sky" }));
  expect(posted.status).toBe(200);
  const body = await posted.json() as { task: { id: string; color?: string }; notes?: string[] };
  expect(body.task.color).toBe("sky");
  expect(body.notes).toBeUndefined();
  expect(stored(body.task.id).color).toBe("sky");

  const clamped = await POST(request({ project: "color-project", text: "Colour in capitals", placement: "unplaced", color: "Teal" }));
  expect(clamped.status).toBe(200);
  expect((await clamped.json() as { task: { color?: string } }).task.color).toBe("teal");
  const unknown = await POST(request({ project: "color-project", text: "Colour nobody has", placement: "unplaced", color: "mauve" }));
  expect(unknown.status).toBe(200);
  const unknownBody = await unknown.json() as { task: { id: string; color?: string }; notes?: string[] };
  expect(unknownBody.task.color).toBeUndefined();
  expect(unknownBody.notes?.[0]).toContain('color "mauve" is not one of');
});

test("create_task carries the rendered colour and icon rule, and both task tools tell agents to set icon and color", async () => {
  const p = await protocol();
  try {
    const { tools } = await p.client.listTools();
    const create = tools.find((tool) => tool.name === "create_task")!;
    const update = tools.find((tool) => tool.name === "update_task")!;
    expect(create.description).toContain(renderTaskColorRule());
    expect(create.description).toContain("Pass `icon` (a lucide icon name) and `color` on every task you create");
    expect(update.description).toContain("give both to a task you touch that lacks them");
    const color = (create.inputSchema.properties as Record<string, { description?: string }>).color;
    expect(color?.description).toContain("none, coral, amber, lime, teal, sky, violet, pink, slate");
  } finally { await p.close(); }
});
