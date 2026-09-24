/**
 * One-line edits to a task's agent-facing `details`, and the task list route's
 * filters (#1845, second slice). A seat keeping a state card in `details`
 * rewrote the whole field for a one-line change; `replaceLine`, `removeLine`
 * and `appendLine` change that line alone, over the MCP `update_task` tool and
 * the HTTP PATCH alike. Both run the edit inside the task store's lock against
 * the stored value, refuse a prefix that does not name exactly one line, and
 * answer the revision and the field's length rather than the field.
 * `GET /api/tasks` used to ignore every query parameter and answer every task
 * of every project; it now reads `project` and `status` and refuses the rest.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-line-edits-"));
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
const { taskRevision } = await import("@/lib/tasks/revision");
const { TASK_DETAILS_LIMIT } = await import("@/lib/tasks/types");
const { NextRequest } = await import("next/server");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
const { GET, POST } = await import("@/app/api/tasks/route");
expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);

const HUMAN = "Keep the lane ledger\nThe seat's state card for this project.";
const CARD = [
  "Lane a1: builder running, PR none",
  "Lane b2: review round 2 of 4",
  "Lane c3: parked on a decision",
  `Notes: ${"context that must not travel back ".repeat(40).trim()}`,
].join("\n");

type Answer = Record<string, unknown> & { task?: Record<string, unknown> };

async function protocol() {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, `receipts-${Math.random().toString(36).slice(2)}.sqlite`));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-line-edits-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { clientRequestId: `lines-${Math.random().toString(36).slice(2)}-${++sequence}`, ...args } });
    return { isError: result.isError === true, answer: result.structuredContent as Answer, raw: JSON.stringify(result) };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

const stored = (id: string) => loadTasks().find((task) => task.id === id)!;

const request = (url: string, method: string, body?: unknown) => new NextRequest(url, {
  method,
  headers: { "content-type": "application/json", host: "localhost" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("update_task edits one line of details, keeps the rest and the text, and answers its length, never the field", async () => {
  const p = await protocol();
  try {
    const created = await p.call("create_task", { project: "line-edits", text: HUMAN, details: CARD });
    const id = created.answer.taskId as string;

    const replaced = await p.call("update_task", { taskId: id, replaceLine: { prefix: "Lane b2:", text: "Lane b2: review passed, merging" } });
    expect(replaced.isError).toBe(false);
    const expected = CARD.replace("Lane b2: review round 2 of 4", "Lane b2: review passed, merging");
    expect(stored(id).details).toBe(expected);
    expect(stored(id).text).toBe(HUMAN);
    expect(replaced.answer).toMatchObject({ taskId: id, revision: taskRevision(stored(id)), detailsLength: expected.length, changedFields: expect.arrayContaining(["details"]) });
    /* The field does not travel back: not the edited line, not the lines around it. */
    expect(replaced.raw).not.toContain("merging");
    expect(replaced.raw).not.toContain("Lane a1");
    expect(replaced.raw).not.toContain("context that must not travel back");

    const removed = await p.call("update_task", { taskId: id, removeLine: { prefix: "Lane c3" } });
    expect(removed.isError).toBe(false);
    const appended = await p.call("update_task", { taskId: id, appendLine: "Lane d4: builder queued" });
    expect(appended.isError).toBe(false);
    const final = expected.split("\n").filter((line) => !line.startsWith("Lane c3")).concat("Lane d4: builder queued").join("\n");
    expect(stored(id).details).toBe(final);
    expect(appended.answer).toMatchObject({ detailsLength: final.length, revision: taskRevision(stored(id)) });

    /* By index, with a prefix that must agree with the line at that index. */
    const byIndex = await p.call("update_task", { taskId: id, replaceLine: { index: 0, prefix: "Lane a1", text: "Lane a1: PR opened" } });
    expect(byIndex.isError).toBe(false);
    expect(stored(id).details!.split("\n")[0]).toBe("Lane a1: PR opened");
  } finally {
    await p.close();
  }
});

test("a line edit leaves every line it did not touch byte for byte, the indent of the line it uncovers at the top included", async () => {
  const p = await protocol();
  try {
    const indented = "Context:\n  - keep this indent\n  - second";
    const created = await p.call("create_task", { project: "line-edits", text: HUMAN, details: indented });
    const id = created.answer.taskId as string;
    expect(stored(id).details).toBe(indented);

    const removed = await p.call("update_task", { taskId: id, removeLine: { prefix: "Context:" } });
    expect(removed.isError).toBe(false);
    expect(stored(id).details).toBe("  - keep this indent\n  - second");
    expect(removed.answer).toMatchObject({ detailsLength: "  - keep this indent\n  - second".length });

    /* The HTTP PATCH stores the same bytes. */
    const replaced = await PATCH(request(`http://localhost/api/tasks/${id}`, "PATCH", { replaceLine: { index: 1, text: "  - second, edited" } }), { params: Promise.resolve({ id }) });
    expect(replaced.status).toBe(200);
    expect(stored(id).details).toBe("  - keep this indent\n  - second, edited");
  } finally {
    await p.close();
  }
});

test("update_task refuses an ambiguous or missing prefix, a line edit beside details, and an edit past the limit, storing nothing", async () => {
  const p = await protocol();
  try {
    const created = await p.call("create_task", { project: "line-edits", text: HUMAN, details: CARD });
    const id = created.answer.taskId as string;
    const before = taskRevision(stored(id));

    const ambiguous = await p.call("update_task", { taskId: id, replaceLine: { prefix: "Lane", text: "Lane x" } });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.raw).toContain("replaceLine.prefix matches 3 lines of the details; it must match exactly one");

    const missing = await p.call("update_task", { taskId: id, removeLine: { prefix: "Lane z9" } });
    expect(missing.isError).toBe(true);
    expect(missing.raw).toContain("removeLine.prefix matches 0 lines");

    const stale = await p.call("update_task", { taskId: id, replaceLine: { index: 1, prefix: "Lane a1", text: "Lane a1: moved" } });
    expect(stale.isError).toBe(true);
    expect(stale.raw).toContain("line 1 of the details does not start with the prefix");

    const both = await p.call("update_task", { taskId: id, details: "whole", appendLine: "one more" });
    expect(both.isError).toBe(true);
    expect(both.raw).toContain("send either details or line edits");

    const tooLong = await p.call("update_task", { taskId: id, appendLine: "x".repeat(TASK_DETAILS_LIMIT) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.raw).toContain(`no longer than ${TASK_DETAILS_LIMIT} characters`);

    /* A later edit in the same call failing refuses the earlier ones too. */
    const half = await p.call("update_task", { taskId: id, replaceLine: { prefix: "Lane a1", text: "Lane a1: done" }, removeLine: { prefix: "Lane" } });
    expect(half.isError).toBe(true);

    expect(taskRevision(stored(id))).toBe(before);
    expect(stored(id).details).toBe(CARD);
  } finally {
    await p.close();
  }
});

test("a line edit applies to the details stored at the write, so an edit to another line in between survives", async () => {
  const p = await protocol();
  try {
    const created = await p.call("create_task", { project: "line-edits", text: HUMAN, details: CARD });
    const id = created.answer.taskId as string;
    /* Two writers, each changing its own line, neither having re-read after the other. */
    const first = await p.call("update_task", { taskId: id, replaceLine: { prefix: "Lane a1", text: "Lane a1: first writer" } });
    const second = await p.call("update_task", { taskId: id, replaceLine: { prefix: "Lane c3", text: "Lane c3: second writer" } });
    expect(first.isError || second.isError).toBe(false);
    const lines = stored(id).details!.split("\n");
    expect(lines[0]).toBe("Lane a1: first writer");
    expect(lines[2]).toBe("Lane c3: second writer");
    expect(lines[1]).toBe("Lane b2: review round 2 of 4");

    /* The revision fence still applies to a line edit. */
    const fenced = await p.call("update_task", { taskId: id, expectedProject: "line-edits", expectedRevision: `task-v1:${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, appendLine: "late" });
    expect(fenced.isError).toBe(true);
    expect(fenced.raw).toContain("TASK_REVISION_MISMATCH");
    expect(stored(id).details!.endsWith("late")).toBe(false);
  } finally {
    await p.close();
  }
});

test("update_task publishes the line edits", async () => {
  const p = await protocol();
  try {
    const { tools } = await p.client.listTools();
    const tool = tools.find((candidate) => candidate.name === "update_task")!;
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    for (const name of ["replaceLine", "removeLine", "appendLine"]) expect(properties[name]).toBeDefined();
    expect(tool.description ?? "").toContain("replaceLine");
  } finally {
    await p.close();
  }
});

test("the HTTP PATCH takes the same line edits and answers the revision and detailsLength", async () => {
  const created = await POST(request("http://localhost/api/tasks", "POST", { project: "line-edits-http", text: HUMAN, details: CARD, placement: "unplaced" }));
  const id = ((await created.json()) as { task: { id: string } }).task.id;

  const edited = await PATCH(request(`http://localhost/api/tasks/${id}`, "PATCH", { replaceLine: { prefix: "Lane b2", text: "Lane b2: merged" } }), { params: Promise.resolve({ id }) });
  expect(edited.status).toBe(200);
  const body = await edited.json() as Record<string, unknown>;
  const expected = CARD.replace("Lane b2: review round 2 of 4", "Lane b2: merged");
  expect(stored(id).details).toBe(expected);
  expect(body).toEqual({ ok: true, taskId: id, revision: taskRevision(stored(id)), detailsLength: expected.length, updatedAt: stored(id).updatedAt });

  const refused = await PATCH(request(`http://localhost/api/tasks/${id}`, "PATCH", { removeLine: { prefix: "Lane" } }), { params: Promise.resolve({ id }) });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: "TASK_INVALID_FIELD", field: "removeLine" });
  expect(stored(id).details).toBe(expected);
});

test("the HTTP line edit still reports what it clamped beside it, and still never echoes the field", async () => {
  const created = await POST(request("http://localhost/api/tasks", "POST", { project: "line-edits-http", text: HUMAN, details: "a\nb", placement: "unplaced" }));
  const id = ((await created.json()) as { task: { id: string } }).task.id;

  const edited = await PATCH(request(`http://localhost/api/tasks/${id}`, "PATCH", { appendLine: "c", icon: "no-such-icon-abc" }), { params: Promise.resolve({ id }) });
  expect(edited.status).toBe(200);
  const body = await edited.json() as Record<string, unknown>;
  expect(stored(id).details).toBe("a\nb\nc");
  expect(body).toMatchObject({ ok: true, taskId: id, revision: taskRevision(stored(id)), detailsLength: 5 });
  expect(body.notes).toEqual([expect.stringContaining("no-such-icon-abc")]);
  expect(body).not.toHaveProperty("task");
  expect(body).not.toHaveProperty("details");
});

test("GET /api/tasks honours project and status and refuses a parameter it does not read", async () => {
  const make = async (project: string, text: string) => {
    const created = await POST(request("http://localhost/api/tasks", "POST", { project, text, placement: "unplaced" }));
    return ((await created.json()) as { task: { id: string } }).task.id;
  };
  const kept = await make("filter-kept", "Kept task\nOne of this project's tasks.");
  const done = await make("filter-kept", "Finished task\nAlready done.");
  await PATCH(request(`http://localhost/api/tasks/${done}`, "PATCH", { status: "done" }), { params: Promise.resolve({ id: done }) });
  await make("filter-other", "Another project's task\nMust not appear.");

  const ids = async (query: string) => {
    const response = await GET(request(`http://localhost/api/tasks${query}`, "GET"));
    expect(response.status).toBe(200);
    return ((await response.json()) as { tasks: Array<{ id: string; project: string }> }).tasks;
  };

  const project = await ids("?project=filter-kept");
  expect(project.map((task) => task.id).sort()).toEqual([kept, done].sort());
  expect(await ids("?project=nonexistent-x")).toEqual([]);
  expect((await ids("?project=filter-kept&status=inbox,assigned,blocked")).map((task) => task.id)).toEqual([kept]);
  expect((await ids("?project=filter-kept&status=done")).map((task) => task.id)).toEqual([done]);
  /* No query answers every task, as before. */
  expect((await ids("")).length).toBe(loadTasks().length);

  const unknown = await GET(request("http://localhost/api/tasks?project=filter-kept&limit=200", "GET"));
  expect(unknown.status).toBe(400);
  expect(((await unknown.json()) as { error: string }).error).toContain("limit");
  const badStatus = await GET(request("http://localhost/api/tasks?status=open", "GET"));
  expect(badStatus.status).toBe(400);
});
