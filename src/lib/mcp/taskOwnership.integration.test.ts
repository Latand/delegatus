/**
 * Linked boards on the agent surface (docs/design/linked-installs.md M.4):
 * `list_tasks` and `get_task` answer the machine that runs a task as a label,
 * `runsHere` and a pending handover; `create_task` names only "here"; the
 * stamps stay out of the answer. Isolated state, invented names.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-ownership-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
const SELF = "0a0a0a0a-1111-4111-8111-111111111111";
const PEER = "0b0b0b0b-2222-4222-8222-222222222222";
const state = process.env.LLV_STATE_DIR!;
fs.mkdirSync(path.join(state, "links"), { recursive: true });
fs.writeFileSync(path.join(state, "links/self.json"), JSON.stringify({ v: 1, installId: SELF, label: "alpha", publicUrl: null, check: null }));
fs.writeFileSync(path.join(state, "links/grants.json"), JSON.stringify({ v: 1, codes: [], grants: [{ id: "0d0d0d0d-4444-4444-8444-444444444444", hash: "x", install: PEER, label: "beta", scopes: ["board:sync"], created: 1, lastUsed: null, requests: 0, movedAt: null, flushedAt: null }] }));
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");
const { saveTasks } = await import("@/lib/tasks/store");

test("list_tasks and get_task answer the owner as a label and runsHere; create_task accepts only machine \"here\"", async () => {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "receipts.sqlite"));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-ownership-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { clientRequestId: `ownership-${++sequence}`, ...args } })).structuredContent as Record<string, unknown>;
  try {
    const at = "2026-09-28T00:00:00.000Z";
    const stamp = "1790000000000.000.0b0b0b0b";
    const stamps = { text: stamp, status: stamp, look: stamp, place: stamp, links: stamp, machine: stamp, handover: stamp };
    saveTasks([
      { id: "task-peer", project: "fixture-project", status: "inbox", text: "Runs on beta", placement: "unplaced", assignments: [], machine: PEER, handover: { to: SELF }, sync: { s: stamps, o: "0b0b0b0b" }, createdAt: at, updatedAt: at },
      { id: "task-here", project: "fixture-project", status: "inbox", text: "Runs here", placement: "unplaced", assignments: [], machine: SELF, createdAt: at, updatedAt: at },
      { id: "task-plain", project: "fixture-project", status: "inbox", text: "Never linked", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at },
    ]);
    const listed = (await call("list_tasks", { project: "fixture-project" })).tasks as Record<string, unknown>[];
    const byId = new Map(listed.map((task) => [task.id, task]));
    expect(byId.get("task-peer")).toMatchObject({ machine: "beta", runsHere: false, handover: { to: "this machine" } });
    expect(byId.get("task-here")).toMatchObject({ machine: "this machine", runsHere: true });
    expect(byId.get("task-plain")!.machine).toBeUndefined();
    const full = (await call("get_task", { taskId: "task-peer" })).task as Record<string, unknown>;
    expect(full).toMatchObject({ machine: "beta", runsHere: false });
    expect(full.sync).toBeUndefined();
    expect(((await call("list_tasks", { project: "fixture-project", full: true })).tasks as Record<string, unknown>[]).find((task) => task.id === "task-peer")?.sync).toBeUndefined();

    expect((await call("create_task", { project: "fixture-project", text: "Made here", machine: "here" })).ok).toBe(true);
    const refused = await client.callTool({ name: "create_task", arguments: { clientRequestId: `ownership-${++sequence}`, project: "fixture-project", text: "Made elsewhere", machine: PEER } });
    expect(refused.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    receipts.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
