/**
 * Agent-facing `details` through both published surfaces (#1834): the MCP
 * `create_task` / `update_task` / `get_task` / `list_tasks` tools an agent
 * calls, and the HTTP POST/PATCH the board sends. The field is the agent's
 * context, and `text` stays the human's title and description, so what these
 * cases pin is the independence of the two on every surface — set, replace and
 * clear — plus the truncation `list_tasks` applies to keep its already large
 * answer bounded, and the guidance the tools publish about which is which.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { TaskWithRevision } from "@/lib/tasks/revision";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-details-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
const { viewerMcpBindings } = await import("./bindings");
const { LIST_TASKS_DETAILS_CHARS } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");
const { TASKS_FILE, loadTasks } = await import("@/lib/tasks/store");
const { NextRequest } = await import("next/server");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
const { POST } = await import("@/app/api/tasks/route");
expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);

const HUMAN = "Fold agent context away\nThe card reads for a human first.";
const CONTEXT = "Lane ffb09e5c. Fences: PipelineSection.tsx. Gates: tsc, tests by path, build, privacy.";

type TaskAnswer = {
  ok?: boolean;
  task: TaskWithRevision;
  tasks?: Array<TaskWithRevision & { detailsTruncated?: boolean }>;
  count?: number;
};

async function protocol() {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, `receipts-${Math.random().toString(36).slice(2)}.sqlite`));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-details-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { clientRequestId: `d1834-${Math.random().toString(36).slice(2)}-${++sequence}`, ...args } })).structuredContent as TaskAnswer;
  return { client, call, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

const json = (body: unknown, method: string) => new NextRequest("http://localhost/api/tasks", {
  method,
  headers: { "content-type": "application/json", host: "localhost" },
  body: JSON.stringify(body),
});

test("create_task carries details, update_task sets, replaces and clears it, and text is never touched", async () => {
  const p = await protocol();
  try {
    const created = await p.call("create_task", { project: "details-project", text: HUMAN, details: CONTEXT });
    expect(created.task.details).toBe(CONTEXT);
    expect(created.task.text).toBe(HUMAN);
    const id = created.task.id;

    /* An update carrying only details leaves the text byte for byte. */
    const replaced = await p.call("update_task", { taskId: id, details: "A shorter state card." });
    expect(replaced.task).toMatchObject({ details: "A shorter state card.", text: HUMAN });
    expect(loadTasks().find((row) => row.id === id)!.text).toBe(HUMAN);

    /* And the reverse: only text moves the human part. */
    const retitled = await p.call("update_task", { taskId: id, text: "A new human title\nAnd its description." });
    expect(retitled.task).toMatchObject({ text: "A new human title\nAnd its description.", details: "A shorter state card." });

    /* null clears it, and the row keeps no empty field behind. */
    const cleared = await p.call("update_task", { taskId: id, details: null });
    expect("details" in cleared.task).toBe(false);
    const stored = loadTasks().find((row) => row.id === id)!;
    expect("details" in stored).toBe(false);
    expect(stored.text).toBe("A new human title\nAnd its description.");

    /* get_task returns the whole field once it is written again. */
    await p.call("update_task", { taskId: id, details: CONTEXT });
    const read = await p.call("get_task", { taskId: id });
    expect(read.task.details).toBe(CONTEXT);
  } finally {
    await p.close();
  }
});

test("list_tasks truncates details and says so; get_task still answers with the whole of it", async () => {
  const p = await protocol();
  try {
    const long = "state ".repeat(LIST_TASKS_DETAILS_CHARS);
    const created = await p.call("create_task", { project: "details-list", text: HUMAN, details: long });
    const short = await p.call("create_task", { project: "details-list", text: "Short one\nNo long context.", details: "brief" });

    const listed = await p.call("list_tasks", { project: "details-list" });
    const cut = listed.tasks!.find((row) => row.id === created.task.id)!;
    expect(cut.details).toHaveLength(LIST_TASKS_DETAILS_CHARS);
    expect(long.startsWith(cut.details!)).toBe(true);
    expect(cut.detailsTruncated).toBe(true);
    /* A row that fits is returned as it is, with no marker. */
    const kept = listed.tasks!.find((row) => row.id === short.task.id)!;
    expect(kept.details).toBe("brief");
    expect(kept.detailsTruncated).toBeUndefined();
    /* Truncation is presentation of the answer, never of the stored row. */
    expect(loadTasks().find((row) => row.id === created.task.id)!.details).toBe(long.trim());
    expect((await p.call("get_task", { taskId: created.task.id })).task.details).toBe(long.trim());
  } finally {
    await p.close();
  }
});

test("the tools publish details as its own field, and say the text is the human's", async () => {
  const p = await protocol();
  try {
    const { tools } = await p.client.listTools();
    for (const name of ["create_task", "update_task"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const properties = tool.inputSchema.properties as Record<string, { type?: unknown; description?: string }>;
      expect(properties.details).toBeDefined();
      expect(properties.details!.description ?? "").toContain("Agent-facing context");
      expect(tool.description ?? "").toContain("details");
    }
    expect(tools.find((tool) => tool.name === "create_task")!.description ?? "").toContain("HUMAN");
    /* update_task states the independence an agent must be able to rely on. */
    expect(tools.find((tool) => tool.name === "update_task")!.description ?? "").toContain("leaves `text` untouched");
    /* list_tasks warns that what it returns may be cut. */
    expect(tools.find((tool) => tool.name === "list_tasks")!.description ?? "").toContain("truncated");
  } finally {
    await p.close();
  }
});

test("the HTTP surface accepts details on create and on patch, on the same terms", async () => {
  const created = await POST(json({ project: "details-http", text: HUMAN, details: CONTEXT, placement: "unplaced" }, "POST"));
  const createdBody = await created.json() as { task: TaskWithRevision };
  expect(createdBody.task.details).toBe(CONTEXT);

  const patched = await PATCH(json({ details: "Replaced by the operator." }, "PATCH"), { params: Promise.resolve({ id: createdBody.task.id }) });
  const patchedBody = await patched.json() as { task: TaskWithRevision };
  expect(patchedBody.task).toMatchObject({ details: "Replaced by the operator.", text: HUMAN });

  const cleared = await PATCH(json({ details: "" }, "PATCH"), { params: Promise.resolve({ id: createdBody.task.id }) });
  const clearedBody = await cleared.json() as { task: TaskWithRevision };
  expect("details" in clearedBody.task).toBe(false);
  expect(clearedBody.task.text).toBe(HUMAN);

  const refused = await PATCH(json({ details: 17 }, "PATCH"), { params: Promise.resolve({ id: createdBody.task.id }) });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ field: "details" });
});
