import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { MCP_OPERATION_PENDING_LEASE_MS, readMcpOperations, type McpOperation } from "./operationsFeed";
import { openMcpReceiptsReadOnly, type McpOperationCaller } from "./receiptsDatabase";
import {
  MCP_TOOL_NAMES,
  SqliteMcpReceiptStore,
  createMcpToolService,
  type McpToolBindings,
  type McpToolCallContext,
} from "./server";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const NOW = 1_780_000_000_000;
const MANAGER: McpOperationCaller = { kind: "worker", conversationId: "conversation_manager", project: "alpha" };

function receiptsFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-operations-"));
  scratch.push(directory);
  return path.join(directory, "mcp-receipts.sqlite");
}

/** A receipt database in the current schema, created by the real store. */
function seededDatabase(): { file: string; db: Database } {
  const file = receiptsFile();
  new SqliteMcpReceiptStore(file).close();
  return { file, db: new Database(file, { strict: true }) };
}

function insert(db: Database, row: {
  key: string;
  digest?: string;
  result?: unknown;
  rawResult?: string;
  claimedAt?: number;
  caller?: McpOperationCaller | null;
}): void {
  const result = row.rawResult ?? (row.result === undefined ? null : JSON.stringify(row.result));
  db.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at, caller_json) VALUES (?, ?, 'durable', ?, 1, ?, ?)")
    .run(row.key, row.digest ?? `digest-${row.key}`, result, row.claimedAt ?? NOW, row.caller ? JSON.stringify(row.caller) : null);
}

function stubBindings(overrides: Partial<McpToolBindings>): McpToolBindings {
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
  return Object.assign(bindings, overrides);
}

test("an operations-feed claim records the server-derived caller and hands its binding the claimed receipt", async () => {
  const file = receiptsFile();
  const store = new SqliteMcpReceiptStore(file, { now: () => NOW });
  const contexts = new Map<string, McpToolCallContext | undefined>();
  const bindings = stubBindings({
    create_pipeline: async (args, context) => {
      contexts.set(String(args.clientRequestId), context);
      return { pipelineId: "pipe-1", pipeline: { id: "pipe-1", project: "alpha" } };
    },
    update_task: async (args, context) => {
      contexts.set(String(args.clientRequestId), context);
      return { taskId: "task-1", task: { id: "task-1", project: "alpha" } };
    },
    create_task: async (args, context) => {
      contexts.set(String(args.clientRequestId), context);
      return { taskId: "task-2" };
    },
  });
  let resolutions = 0;
  const service = createMcpToolService(bindings, store, undefined, {
    operationCaller: () => {
      resolutions += 1;
      return MANAGER;
    },
  });

  const startedAt = Date.now();
  expect((await service.callTool("create_pipeline", { clientRequestId: "create-1", task: "Ship" })).ok).toBeTrue();
  expect((await service.callTool("update_task", { clientRequestId: "update-1", taskId: "task-1", status: "done" })).ok).toBeTrue();
  expect((await service.callTool("create_task", { clientRequestId: "task-1", project: "alpha", text: "Other" })).ok).toBeTrue();
  /* A replay reaches neither the binding nor a second row. */
  const replay = await service.callTool("create_pipeline", { clientRequestId: "create-1", task: "Ship" });
  expect(replay.replayed).toBeTrue();
  store.close();

  const db = new Database(file, { readonly: true, strict: true });
  const rows = db.query<{ receipt_key: string; digest: string; caller_json: string | null }, []>(
    "SELECT receipt_key, digest, caller_json FROM mcp_receipts ORDER BY sequence",
  ).all();
  db.close();
  expect(rows.map((row) => [row.receipt_key, row.caller_json === null ? null : JSON.parse(row.caller_json)])).toEqual([
    ["create_pipeline:create-1", MANAGER],
    ["update_task:update-1", MANAGER],
    ["create_task:task-1", null],
  ]);
  expect(resolutions).toBe(3);
  const createReceipt = contexts.get("create-1")?.receipt;
  expect(createReceipt).toEqual({ digest: rows[0]!.digest, claimedAt: expect.any(String), caller: MANAGER });
  const claimedAt = Date.parse(createReceipt!.claimedAt);
  expect(claimedAt >= startedAt && claimedAt <= Date.now()).toBeTrue();
  expect(contexts.get("update-1")?.receipt?.digest).toBe(rows[1]!.digest);
  expect(contexts.get("task-1")?.receipt).toBeUndefined();
});

test("a caller resolver fault records no caller and never refuses the call", async () => {
  const file = receiptsFile();
  const store = new SqliteMcpReceiptStore(file, { now: () => NOW });
  let receipt: McpToolCallContext["receipt"];
  const service = createMcpToolService(stubBindings({
    update_task: async (_args, context) => {
      receipt = context?.receipt;
      return { taskId: "task-1" };
    },
  }), store, undefined, {
    operationCaller: () => {
      throw new Error("process ancestry unreadable");
    },
  });

  expect((await service.callTool("update_task", { clientRequestId: "update-1", taskId: "task-1" })).ok).toBeTrue();
  store.close();
  const db = new Database(file, { readonly: true, strict: true });
  expect(db.query<{ caller_json: string | null }, []>("SELECT caller_json FROM mcp_receipts").get()?.caller_json).toBeNull();
  db.close();
  expect(receipt?.caller).toBeNull();
});

test("each receipt state reads truthfully: pending in the lease, unknown after it, accepted with its target, failed with a short refusal", () => {
  const { db } = seededDatabase();
  insert(db, { key: "create_pipeline:pending", caller: MANAGER, claimedAt: NOW - 1_000 });
  insert(db, { key: "update_task:lost", caller: MANAGER, claimedAt: NOW - MCP_OPERATION_PENDING_LEASE_MS - 1 });
  insert(db, { key: "create_pipeline:made", caller: MANAGER, result: { ok: true, pipelineId: "pipe-1", pipeline: { id: "pipe-1", project: "alpha" } } });
  insert(db, { key: "update_task:moved", caller: MANAGER, result: { ok: true, taskId: "task-1", task: { id: "task-1", project: "alpha" } } });
  insert(db, { key: "create_pipeline:refused", caller: MANAGER, result: { ok: false, error: `stages[0].kind: ${"x".repeat(400)}` } });
  insert(db, { key: "update_task:garbled", caller: MANAGER, rawResult: "{not json" });

  const page = readMcpOperations(db, { project: "alpha", after: 0, limit: 50 }, { now: NOW });
  const byKey = Object.fromEntries(page.operations.map((operation) => [operation.requestDigest.replace("digest-", ""), operation]));
  expect(byKey["create_pipeline:pending"]).toMatchObject({ state: "pending", tool: "create_pipeline", callerConversationId: "conversation_manager", callerProject: "alpha", project: null });
  expect(byKey["update_task:lost"]?.state).toBe("unknown");
  expect(byKey["create_pipeline:made"]).toMatchObject({ state: "accepted", pipelineId: "pipe-1", project: "alpha", refusal: null });
  expect(byKey["update_task:moved"]).toMatchObject({ state: "accepted", taskId: "task-1", project: "alpha" });
  expect(byKey["create_pipeline:refused"]?.state).toBe("failed");
  expect(byKey["create_pipeline:refused"]?.refusal?.startsWith("stages[0].kind: ")).toBeTrue();
  expect(byKey["create_pipeline:refused"]?.refusal?.length).toBe(200);
  expect(byKey["update_task:garbled"]?.state).toBe("unknown");
  expect(byKey["create_pipeline:pending"]?.claimedAt).toBe(new Date(NOW - 1_000).toISOString());
  db.close();
});

test("a row belongs to a project by its caller or its target, and no other tool appears", () => {
  const { db } = seededDatabase();
  const beta: McpOperationCaller = { ...MANAGER, project: "beta" };
  insert(db, { key: "update_task:mine", caller: MANAGER, result: { ok: true, taskId: "t1", task: { id: "t1", project: "alpha" } } });
  insert(db, { key: "create_pipeline:into-alpha", caller: beta, result: { ok: true, pipelineId: "p1", pipeline: { id: "p1", project: "alpha" } } });
  insert(db, { key: "update_task:refined", caller: null, result: { ok: true, refined: [], tasks: [{ id: "t2", project: "alpha" }] } });
  insert(db, { key: "update_task:elsewhere", caller: beta, result: { ok: true, taskId: "t3", task: { id: "t3", project: "beta" } } });
  insert(db, { key: "send_message:alpha", caller: MANAGER, result: { ok: true } });
  insert(db, { key: "createXpipeline:lookalike", caller: MANAGER, result: { ok: true } });

  const alpha = readMcpOperations(db, { project: "alpha", after: 0, limit: 50 }, { now: NOW });
  expect(alpha.operations.map((operation) => operation.requestDigest)).toEqual([
    "digest-update_task:mine", "digest-create_pipeline:into-alpha", "digest-update_task:refined",
  ]);
  expect(alpha.operations[2]).toMatchObject({ taskId: "t2", project: "alpha", callerConversationId: null });
  const betaPage = readMcpOperations(db, { project: "beta", after: 0, limit: 50 }, { now: NOW });
  expect(betaPage.operations.map((operation) => operation.requestDigest)).toEqual([
    "digest-create_pipeline:into-alpha", "digest-update_task:elsewhere",
  ]);
  db.close();
});

test("pages are ascending: the newest rows without a cursor, then forward with hasMore and a cursor past everything considered", () => {
  const { db } = seededDatabase();
  for (let index = 1; index <= 5; index += 1) {
    insert(db, { key: `update_task:u${index}`, caller: MANAGER, result: { ok: true, taskId: `t${index}`, task: { id: `t${index}`, project: "alpha" } } });
  }
  insert(db, { key: "update_task:other", caller: { ...MANAGER, project: "beta" }, result: { ok: true } });

  const tail = readMcpOperations(db, { project: "alpha", after: null, limit: 2 }, { now: NOW });
  expect(tail.operations.map((operation) => operation.sequence)).toEqual([4, 5]);
  expect(tail).toMatchObject({ after: 6, hasMore: false });

  const first = readMcpOperations(db, { project: "alpha", after: 0, limit: 2 }, { now: NOW });
  expect(first.operations.map((operation) => operation.sequence)).toEqual([1, 2]);
  expect(first).toMatchObject({ after: 2, hasMore: true });
  const second = readMcpOperations(db, { project: "alpha", after: first.after, limit: 2 }, { now: NOW });
  expect(second.operations.map((operation) => operation.sequence)).toEqual([3, 4]);
  const last = readMcpOperations(db, { project: "alpha", after: second.after, limit: 2 }, { now: NOW });
  expect(last.operations.map((operation) => operation.sequence)).toEqual([5]);
  expect(last).toMatchObject({ after: 6, hasMore: false });
  expect(readMcpOperations(db, { project: "alpha", after: last.after, limit: 2 }, { now: NOW })).toEqual({ operations: [], after: 6, hasMore: false });

  expect(readMcpOperations(db, { project: "alpha", after: 0, limit: 500 }, { now: NOW }).operations).toHaveLength(5);
  expect(readMcpOperations(db, { project: "alpha", after: 0, limit: 0 }, { now: NOW }).operations).toHaveLength(1);
  db.close();
});

test("a pending row holds the cursor, so its settlement is answered on a later page", () => {
  const { db } = seededDatabase();
  insert(db, { key: "update_task:before", caller: MANAGER, result: { ok: true, taskId: "t0", task: { id: "t0", project: "alpha" } } });
  insert(db, { key: "create_pipeline:running", caller: MANAGER, claimedAt: NOW - 500 });
  insert(db, { key: "update_task:after", caller: MANAGER, result: { ok: true, taskId: "t1", task: { id: "t1", project: "alpha" } } });

  const first = readMcpOperations(db, { project: "alpha", after: null, limit: 50 }, { now: NOW });
  expect(first.operations.map((operation) => operation.state)).toEqual(["accepted", "pending", "accepted"]);
  expect(first.after).toBe(1);

  db.query("UPDATE mcp_receipts SET result_json = ? WHERE receipt_key = ?")
    .run(JSON.stringify({ ok: true, pipelineId: "pipe-9", pipeline: { id: "pipe-9", project: "alpha" } }), "create_pipeline:running");
  const settled = readMcpOperations(db, { project: "alpha", after: first.after, limit: 50 }, { now: NOW + 1_000 });
  expect(settled.operations.map((operation) => [operation.sequence, operation.state])).toEqual([[2, "accepted"], [3, "accepted"]]);
  expect(settled.operations[0]?.pipelineId).toBe("pipe-9");
  expect(settled.after).toBe(3);
  db.close();
});

test("C8: a create whose pipeline carries its digest reads accepted, whatever its receipt row recorded", () => {
  const { db } = seededDatabase();
  insert(db, { key: "create_pipeline:unanswered", digest: "digest-unanswered", caller: MANAGER, claimedAt: NOW - MCP_OPERATION_PENDING_LEASE_MS - 1 });
  insert(db, { key: "create_pipeline:errored", digest: "digest-errored", caller: MANAGER, result: { ok: false, error: "response lost" } });
  insert(db, { key: "update_task:digest-shared", digest: "digest-errored", caller: MANAGER, result: { ok: false, error: "refused" } });
  const pipelines = new Map([
    ["digest-unanswered", { id: "pipe-a", project: "alpha" }],
    ["digest-errored", { id: "pipe-b", project: "alpha" }],
  ]);

  const page = readMcpOperations(db, { project: "alpha", after: 0, limit: 50 }, {
    now: NOW,
    pipelineForDigest: (digest) => pipelines.get(digest) ?? null,
  });
  expect(page.operations.map((operation) => [operation.tool, operation.state, operation.pipelineId ?? null])).toEqual([
    ["create_pipeline", "accepted", "pipe-a"],
    ["create_pipeline", "accepted", "pipe-b"],
    ["update_task", "failed", null],
  ]);
  db.close();
});

test("no argument or result body leaves the feed", () => {
  const { db } = seededDatabase();
  insert(db, {
    key: "create_pipeline:bodies",
    caller: MANAGER,
    result: { ok: true, pipelineId: "pipe-1", pipeline: { id: "pipe-1", project: "alpha", spec: "SECRET-SPEC", stages: [{ prompt: "SECRET-PROMPT" }] } },
  });
  const page = readMcpOperations(db, { project: "alpha", after: 0, limit: 50 }, { now: NOW });
  const serialized = JSON.stringify(page);
  expect(serialized).not.toContain("SECRET-");
  const keys: (keyof McpOperation)[] = [
    "sequence", "tool", "requestDigest", "claimedAt", "callerConversationId", "callerProject", "state", "project", "pipelineId", "refusal",
  ];
  expect(Object.keys(page.operations[0]!).sort()).toEqual([...keys].sort());
  db.close();
});

test("a database no MCP process has migrated, and one that does not exist yet, both answer", () => {
  const file = receiptsFile();
  expect(openMcpReceiptsReadOnly(file)).toBeNull();
  expect(fs.existsSync(file)).toBeFalse();
  expect(readMcpOperations(null, { project: "alpha", after: 7, limit: 50 })).toEqual({ operations: [], after: 7, hasMore: false });

  const legacy = new Database(file, { create: true, strict: true });
  legacy.exec(`
    CREATE TABLE mcp_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_key TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL,
      retention TEXT NOT NULL,
      result_json TEXT,
      storage_bytes INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL
    );
  `);
  legacy.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at) VALUES (?, ?, 'durable', ?, 1, ?)")
    .run("update_task:old", "digest-old", JSON.stringify({ ok: true, taskId: "t1", task: { id: "t1", project: "alpha" } }), NOW);
  legacy.close();

  const reader = openMcpReceiptsReadOnly(file)!;
  const page = readMcpOperations(reader, { project: "alpha", after: null, limit: 50 }, { now: NOW });
  expect(page.operations).toEqual([expect.objectContaining({ state: "accepted", taskId: "t1", callerConversationId: null, callerProject: null })]);
  expect(() => reader.exec("DELETE FROM mcp_receipts")).toThrow();
  reader.close();
});
