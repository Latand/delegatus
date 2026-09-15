import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";

import { SqliteMcpReceiptStore } from "@/lib/mcp/server";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";

import { GET } from "./route";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-operations-route-"));
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const receipts = () => path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.sqlite");

function request(query: string): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/mcp/operations${query}`);
}

test("the route refuses a missing project or a malformed cursor, and answers an absent database with an empty page", async () => {
  expect((await GET(request(""))).status).toBe(400);
  expect((await GET(request("?project=alpha&after=abc"))).status).toBe(400);
  expect((await GET(request("?project=alpha&after=-1"))).status).toBe(400);

  const empty = await GET(request("?project=alpha&after=3"));
  expect(empty.status).toBe(200);
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({ operations: [], after: 3, hasMore: false });
  expect(fs.existsSync(receipts())).toBeFalse();
});

test("the route reads receipt rows without writing them and joins a stamped pipeline by its creation digest", async () => {
  new SqliteMcpReceiptStore(receipts()).close();
  const writer = new Database(receipts(), { strict: true });
  const insert = writer.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at, caller_json) VALUES (?, ?, 'durable', ?, 1, ?, ?)");
  const caller = JSON.stringify({ kind: "worker", conversationId: "conversation_manager", project: "alpha" });
  insert.run("create_pipeline:lost-response", "digest-stamped", JSON.stringify({ ok: false, error: "deadline" }), Date.now(), caller);
  insert.run("update_task:moved", "digest-moved", JSON.stringify({ ok: true, taskId: "task-1", task: { id: "task-1", project: "alpha" } }), Date.now(), caller);
  writer.close();
  savePipelines([buildPipeline({
    id: "pipe0001",
    task: "Ship",
    project: "alpha",
    repoDir: path.join(process.env.LLV_STATE_DIR!, "repo"),
    stages: [],
    srcPath: null,
    srcConversationId: "conversation_manager",
    now: new Date().toISOString(),
    state: "draft",
    creationReceipt: { tool: "create_pipeline", requestDigest: "digest-stamped", callerConversationId: "conversation_manager", claimedAt: new Date().toISOString() },
  })]);
  const before = fs.readFileSync(receipts());

  const response = await GET(request("?project=alpha&limit=999"));
  expect(response.status).toBe(200);
  const page = await response.json() as { operations: { tool: string; state: string; pipelineId?: string; taskId?: string }[]; after: number; hasMore: boolean };
  expect(page.operations.map(({ tool, state, pipelineId, taskId }) => ({ tool, state, id: pipelineId ?? taskId }))).toEqual([
    { tool: "create_pipeline", state: "accepted", id: "pipe0001" },
    { tool: "update_task", state: "accepted", id: "task-1" },
  ]);
  expect(page).toMatchObject({ after: 2, hasMore: false });
  expect(fs.readFileSync(receipts()).equals(before)).toBeTrue();
});
