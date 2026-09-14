/**
 * Task colour and group hide through both published surfaces (#1695 K4a):
 * the MCP `update_task` tool an agent calls and the HTTP PATCH the kanban
 * board sends. Both reach one command, so both publish the same fields, write
 * the same rows, answer the same fence, and refuse the same seat task.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { TaskWithRevision } from "@/lib/tasks/revision";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-color-group-hide-"));
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
const { statePath } = await import("@/lib/configDir");
const { NextRequest } = await import("next/server");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);

async function protocol() {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, `receipts-${Math.random().toString(36).slice(2)}.sqlite`));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-color-group-hide-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { clientRequestId: `k4a-${Math.random().toString(36).slice(2)}-${++sequence}`, ...args } })).structuredContent as
      { ok: boolean; task: TaskWithRevision; code?: string; details?: { field?: string; code?: string } };
  return { client, call, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

const patchHttp = (id: string, body: Record<string, unknown>) => PATCH(
  new NextRequest("http://localhost/api/tasks", { method: "PATCH", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

function seatFor(project: string, conversationId: string) {
  fs.writeFileSync(statePath("orchestrator-seats.json"), JSON.stringify({
    schemaVersion: 1,
    nextSeatEpoch: 4,
    seats: {
      [project]: {
        project, seatEpoch: 3, conversationId, path: null, mandate: "Keep the project moving.", promptVersion: null,
        predecessorConversationId: null, state: "active", intent: { clientRequestId: "seat-fixture", mode: "spawn", launchId: null, error: null },
        designatedAt: "2026-09-14T09:00:00.000Z", activatedAt: "2026-09-14T09:00:01.000Z",
      },
    },
    pending: {},
    revocations: [],
    history: [],
  }));
}

test("update_task publishes the colour names and the hide, and both land in the task file", async () => {
  const p = await protocol();
  try {
    const { tools } = await p.client.listTools();
    const properties = tools.find((tool) => tool.name === "update_task")!.inputSchema.properties as Record<string, { enum?: string[]; type?: string; description?: string }>;
    expect(properties.color?.enum).toEqual(["none", "coral", "amber", "lime", "teal", "sky", "violet", "pink", "slate"]);
    expect(properties.hide?.type).toBe("boolean");
    expect(properties.hide?.description ?? "").toContain("TASK_HIDE_PROTECTED");

    const created = await p.call("create_task", { project: "color-project", text: "Colour me" });
    const coloured = await p.call("update_task", { taskId: created.task.id, color: "violet" });
    expect(coloured).toMatchObject({ ok: true, task: { color: "violet" } });
    expect(loadTasks().find((row) => row.id === created.task.id)!.color).toBe("violet");

    /* An agent's hide is fenced and recorded as the agent's. */
    const unfenced = await p.call("update_task", { taskId: created.task.id, hide: true });
    expect(unfenced.ok).toBe(false);
    const hidden = await p.call("update_task", { taskId: created.task.id, hide: true, expectedProject: coloured.task.project, expectedRevision: coloured.task.revision });
    expect(hidden).toMatchObject({ ok: true, task: { groupHidden: { by: "agent" } } });
    const stored = loadTasks().find((row) => row.id === created.task.id)!;
    expect(stored.groupHidden?.by).toBe("agent");
    expect(stored.text).toBe("Colour me");

    /* The same revision a second time is stale. */
    const stale = await p.call("update_task", { taskId: created.task.id, hide: false, expectedProject: coloured.task.project, expectedRevision: coloured.task.revision });
    expect(stale.ok).toBe(false);
    expect(JSON.stringify(stale)).toContain("TASK_REVISION_MISMATCH");

    const cleared = await p.call("update_task", { taskId: created.task.id, color: "none" });
    expect(cleared.ok).toBe(true);
    expect("color" in loadTasks().find((row) => row.id === created.task.id)!).toBe(false);
  } finally { await p.close(); }
});

test("the dashboard's PATCH hides as the operator, and both surfaces refuse the task holding the seat conversation without writing", async () => {
  const p = await protocol();
  try {
    const project = "seat-project";
    const plain = await p.call("create_task", { project, text: "Plain group" });
    const seatTask = await p.call("create_task", { project, text: "Orchestrator group" });
    saveTasks(loadTasks().map((row) => row.id === seatTask.task.id
      ? { ...row, assignments: [{ path: "/fixture/seat.jsonl", conversationId: "conversation_seat_fixture", panePid: null, state: "linked", error: null, at: "2026-09-14T09:00:00.000Z" }] }
      : row));
    seatFor(project, "conversation_seat_fixture");

    const plainRow = loadTasks().find((row) => row.id === plain.task.id) as TaskWithRevision;
    const response = await patchHttp(plain.task.id, { hide: true, expectedProject: plainRow.project, expectedRevision: plainRow.revision });
    expect(response.status).toBe(200);
    expect(loadTasks().find((row) => row.id === plain.task.id)!.groupHidden?.by).toBe("operator");

    const seatRow = loadTasks().find((row) => row.id === seatTask.task.id) as TaskWithRevision;
    const before = fs.readFileSync(TASKS_FILE, "utf8");
    const refused = await patchHttp(seatTask.task.id, { hide: true, expectedProject: seatRow.project, expectedRevision: seatRow.revision });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("orchestrator seat") });
    const agentRefused = await p.call("update_task", { taskId: seatTask.task.id, hide: true, expectedProject: seatRow.project, expectedRevision: seatRow.revision });
    expect(agentRefused.ok).toBe(false);
    expect(JSON.stringify(agentRefused)).toContain("TASK_HIDE_PROTECTED");
    expect(fs.readFileSync(TASKS_FILE, "utf8")).toBe(before);
  } finally { await p.close(); }
});

test("a task file written by a later build, with values this build does not name, still loads every row", () => {
  const rows = loadTasks();
  const later = rows.map((row, index) => (index === 0 ? { ...row, color: "ultraviolet", groupHidden: { at: "2026-09-14T09:00:00.000Z", by: "someone-new", reason: "later" } } : row));
  saveTasks(later as never);
  const reloaded = loadTasks();
  expect(reloaded).toHaveLength(rows.length);
  expect(reloaded[0]!.text).toBe(rows[0]!.text);
});
