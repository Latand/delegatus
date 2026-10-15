import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// The benchmark already requires an owned PID namespace. Load its Viewer
// before the barrier fixture, whose parent polling is synchronous test work.
if (process.env.MCP_BENCH_CHILD) {
  await (await import("../../../scripts/mcp-state-writer-benchmark")).stateWriterChild(process.env.MCP_BENCH_CHILD);
  if (process.env.MCP_BENCH_CHILD === "seed") process.exit(0);
  await new Promise(() => {});
}

const { waitForFixtureFile } = await import("./fixtureBarrier");

if (process.env.LLV_TASK_EXECUTOR_HTTP_PARTIAL) {
  const { createInterface } = await import("node:readline");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const request = JSON.parse(line) as { id: number };
    process.stdout.write(JSON.stringify({ id: request.id, http: { status: 200, headers: [] } }) + '\t{"message":"partial');
    fs.writeFileSync(process.env.LLV_WRITER_READY!, "ready");
    await waitForFixtureFile(process.env.LLV_TASK_EXECUTOR_HTTP_PARTIAL);
    process.stdout.write(' response"}\n');
  }
  process.exit(0);
}

if (process.env.LLV_TASK_EXECUTOR_STALL) {
  if (process.env.LLV_WRITER_READY) fs.writeFileSync(process.env.LLV_WRITER_READY, String(process.pid));
  process.stdin.resume();
  await new Promise(() => {});
}

if (process.env.LLV_TASK_EXECUTOR_REPORT_PID) {
  fs.writeFileSync(process.env.LLV_WRITER_READY!, String(process.pid));
  await import("../mcpTask.worker");
  await new Promise(() => {});
}

if (process.env.LLV_TASK_EXECUTOR_OWNER) {
  if (process.env.LLV_MCP_TASK_WORKER_BUNDLE) {
    const { McpTaskExecutor } = await import("./taskExecutor");
    (globalThis as Record<symbol, unknown>)[Symbol.for("llv.mcp.taskExecutor")] = new McpTaskExecutor({
      launch: { executable: process.execPath, workerPath: path.resolve(process.env.LLV_MCP_TASK_WORKER_BUNDLE) },
    });
  }
  const { createProductionViewerMcpService } = await import("./server");
  const { runAsMcpHttpCaller } = await import("./callerContext");
  const service = await createProductionViewerMcpService();
  const result = await runAsMcpHttpCaller({ capability: process.env.LLV_TASK_EXECUTOR_OWNER }, () => service.callTool("list_tasks", { project: "fixture", limit: 1 }));
  if (!result.ok) throw new Error(JSON.stringify(result));
  fs.writeFileSync(process.env.LLV_WRITER_READY!, "ready");
  await new Promise(() => {});
}

if (process.env.LLV_NATIVE_PEER_VERIFY) {
  if (fs.existsSync(process.env.LLV_NATIVE_PEER_HIDDEN!)) throw new Error("fixture did not hide its parent's mount");
  const { verifyNativePeer } = await import("./nativePeer");
  console.log(JSON.stringify(await verifyNativePeer(process.env.LLV_NATIVE_PEER_VERIFY, process.env.LLV_NATIVE_PEER_BODY!)));
  process.exit(0);
}

// Native observer controls share the concurrency fixture and its owned runner.
// This branch loads no application store and performs no process discovery.
if (process.env.LLV_WRITER_OBSERVER_CONTROL) {
  const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const filename = process.env.LLV_WRITER_DATABASE!;
  const mode = process.env.LLV_WRITER_OBSERVER_CONTROL;
  if (mode === "lease-hold" || mode === "lease-wait") {
    if (process.env.MCP_SQL_EVENTS) await (await import("../../../scripts/sqlite-observer")).observeLeases();
    const { SqliteStateCollection, initializeStateCollections } = await import("@/lib/state/sqliteStateStore");
    initializeStateCollections(filename, [{ collection: "observer", schemaVersion: 1, migrationId: "fixture", key: (row: { id: string }) => row.id, loadRecords: () => [] }]);
    const collection = new SqliteStateCollection<{ id: string }>(filename, { collection: "observer", schemaVersion: 1, busyMessage: "fixture lease held", key: row => row.id, decode: value => value as { id: string }, clone: structuredClone });
    await collection.mutate(async (rows, persist) => {
      if (mode === "lease-hold") {
        fs.writeFileSync(process.env.LLV_WRITER_READY!, "ready");
        await Bun.sleep(Number(process.env.LLV_WRITER_HOLD_MS));
      } else { rows.push({ id: "waited" }); persist(); }
    });
  } else if (mode === "overhead") {
    const db = new Database(filename);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE state_rows(collection TEXT,row_key TEXT,value_json TEXT,row_order INTEGER,row_revision INTEGER,controller_active INTEGER,PRIMARY KEY(collection,row_key))");
    const insert = db.query("INSERT INTO state_rows VALUES ('observer',?,?,?,1,1)");
    const value = JSON.stringify({ project: "fixture", text: "Fixture task", details: "x".repeat(500), status: "inbox", assignments: [] });
    const started = performance.now();
    for (let n = 0; n < 1000; n++) insert.run(String(n), value, n);
    console.log(JSON.stringify({ iterations: 1000, elapsedMs: performance.now() - started }));
    db.close();
  } else if (mode === "lock") {
    const db = new Database(filename);
    db.exec("BEGIN IMMEDIATE");
    fs.writeFileSync(process.env.LLV_WRITER_READY!, "ready");
    await Bun.sleep(Number(process.env.LLV_WRITER_HOLD_MS));
    db.exec("ROLLBACK"); db.close();
  } else if (mode === "wait" || mode === "refuse") {
    const db = new Database(filename);
    db.exec(`PRAGMA busy_timeout=${mode === "wait" ? 2000 : 30}`);
    let refused = false;
    try { db.query("INSERT INTO sample VALUES (?)").run(4); }
    catch (error) { if ((error as { errno: number }).errno !== 5) throw error; refused = true; }
    db.close();
    if (refused !== (mode === "refuse")) throw new Error("unexpected SQLite wait outcome");
  } else {
    const { openCurrentDatabase } = await import("@/lib/state/currentDatabase");
    const db = openCurrentDatabase(filename, () => new Database(filename));
    db.exec("CREATE TABLE sample(value)");
    const other = new Database(filename, { readonly: true });
    other.close();
    const replacement = new Database(filename, { readonly: true });
    db.exec("BEGIN IMMEDIATE");
    db.query("INSERT INTO sample VALUES (?)").run(1);
    db.exec("COMMIT");
    db.query("INSERT INTO sample VALUES (?)").run(2);
    db.exec("BEGIN IMMEDIATE");
    db.query("INSERT INTO sample VALUES (?)").run(3);
    db.exec("ROLLBACK");
    db.exec("BEGIN IMMEDIATE"); db.exec("COMMIT");
    if (db.query<{ n: number }, []>("SELECT count(*) AS n FROM sample").get()!.n !== 2) throw new Error("observer control changed rows");
    replacement.close(); db.close();
  }
  process.exit(0);
}

const stateDir = process.env.LLV_STATE_DIR;
const kind = process.env.LLV_WRITER_KIND ?? "task";
const writer = process.env.LLV_WRITER_INTERFACE;
const operation = process.env.LLV_WRITER_OPERATION ?? "create";
const readyPath = process.env.LLV_WRITER_READY;
const releasePath = process.env.LLV_WRITER_RELEASE;
const creatorPath = process.env.LLV_WRITER_SRC;

if (process.env.LLV_WRITER_PREPARE === "1") {
  (await import("@/lib/tasks/store")).loadTasks();
  (await import("@/lib/pipelines/store")).loadPipelines();
  process.exit(0);
}
if (!stateDir || !writer || !readyPath || !releasePath) throw new Error("writer concurrency fixture is incomplete");

if (process.env.LLV_WRITER_NO_PROCESS_IDENTITY === "1") {
  const { procBackend } = await import("@/lib/proc");
  const processIdentity = procBackend.processIdentity.bind(procBackend);
  // Only the lease owner lacks identity; the fixture's parent remains verifiable.
  procBackend.processIdentity = (pid) => pid === process.pid ? null : processIdentity(pid);
}

let gated = false;
function holdAfterRead(): void {
  if (gated) return;
  gated = true;
  fs.writeFileSync(readyPath!, "ready\n", "utf8");
  waitForFixtureFile(releasePath!);
}

if (process.env.LLV_WRITER_INITIALIZED && process.env.LLV_WRITER_BEGIN) {
  (await import("@/lib/tasks/store")).loadTasks();
  (await import("@/lib/pipelines/store")).loadPipelines();
  (await import("@/lib/accounts/claude")).listClaudeAccounts();
  (await import("@/lib/accounts/codex")).listCodexAccounts();
  (await import("@/lib/accounts/copilot")).listCopilotAccounts();
  fs.writeFileSync(process.env.LLV_WRITER_INITIALIZED, "ready");
  waitForFixtureFile(process.env.LLV_WRITER_BEGIN);
}

/* Since #1870 both stores write SQLite collections. Hold their real lease
   after the committed rows are read; JSON is only the initial import. */
if (kind === "task") {
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  if (process.env.LLV_WRITER_NO_PROCESS_IDENTITY === "1") {
    // Hold the aged lease before patchSync opens its SQL transaction. A peer
    // must refuse this live lease even when SQLite itself is available.
    const prototype = SqliteStateCollection.prototype as unknown as {
      options: { collection: string };
      tryAcquireLease(db: import("bun:sqlite").Database, token: string): boolean;
    };
    const acquire = prototype.tryAcquireLease;
    prototype.tryAcquireLease = function (db, token) {
      const acquired = acquire.call(this, db, token);
      if (acquired && this.options.collection === "tasks") {
        db.query("UPDATE state_leases SET acquired_at = ? WHERE collection = 'tasks' AND owner_token = ?")
          .run(Date.now() - 60_000, token);
        holdAfterRead();
      } else if (!acquired && this.options.collection === "tasks") {
        fs.writeFileSync(`${readyPath}.waiting`, "lease refused\n");
      }
      return acquired;
    };
  }
  const patchSync = SqliteStateCollection.prototype.patchSync;
  SqliteStateCollection.prototype.patchSync = function gatedPatchSync(this: InstanceType<typeof SqliteStateCollection>, prepare) {
    return patchSync.call(this, () => {
      const patch = prepare();
      holdAfterRead();
      return patch;
    });
  } as typeof patchSync;
}
if (kind === "pipeline") {
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const mutate = SqliteStateCollection.prototype.mutate;
  SqliteStateCollection.prototype.mutate = function gatedMutation(this: InstanceType<typeof SqliteStateCollection>, operation, ...args) {
    return mutate.call(this, (records, persist) => {
      holdAfterRead();
      return operation(records, persist);
    }, ...args);
  } as typeof mutate;
  const boundedPatch = SqliteStateCollection.prototype.boundedPatch;
  SqliteStateCollection.prototype.boundedPatch = function gatedCreate(this: InstanceType<typeof SqliteStateCollection>, limit, operation, ...args) {
    return boundedPatch.call(this, limit, (tx) => operation({
      ...tx,
      pipelineLookup: (query) => {
        const result = tx.pipelineLookup(query);
        holdAfterRead();
        return result;
      },
    }), ...args);
  } as typeof boundedPatch;
}

if (kind === "task" && operation === "create" && writer === "http") {
  const input = { project: "viewer", text: `${writer} task`, placement: "unplaced" as const, clientRequestId: `${writer}-task-request` };
  const { POST } = await import("@/app/api/tasks/route");
  const response = await POST(new NextRequest("http://127.0.0.1/api/tasks", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!response.ok) throw new Error(`HTTP task create failed: ${response.status} ${await response.text()}`);
} else if (kind === "task" && operation === "create" && writer === "mcp") {
  const input = { project: "viewer", text: `${writer} task`, placement: "unplaced" as const, clientRequestId: `${writer}-task-request` };
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().create_task(input);
} else if (kind === "task" && operation === "update" && writer === "http") {
  const { PATCH } = await import("@/app/api/tasks/[id]/route");
  const response = await PATCH(new NextRequest("http://127.0.0.1/api/tasks/task-http", {
    method: "PATCH",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ text: "http updated task" }),
  }), { params: Promise.resolve({ id: "task-http" }) });
  if (!response.ok) throw new Error(`HTTP task update failed: ${response.status} ${await response.text()}`);
} else if (kind === "task" && operation === "update" && writer === "mcp") {
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().update_task({
    taskId: "task-mcp",
    text: "mcp updated task",
    clientRequestId: "mcp-task-update-request",
  });
} else if (kind === "pipeline" && operation === "create" && writer === "http") {
  const input = { task: `${writer} pipeline`, src: creatorPath, repoDir: process.cwd(), autoStart: false, stages: [] };
  const { POST } = await import("@/app/api/pipelines/route");
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!response.ok) throw new Error(`HTTP pipeline create failed: ${response.status} ${await response.text()}`);
} else if (kind === "pipeline" && operation === "create" && writer === "mcp") {
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().create_pipeline({
    task: `${writer} pipeline`,
    src: creatorPath,
    repoDir: process.cwd(),
    autoStart: false,
    stages: [],
    clientRequestId: `${writer}-pipeline-request`,
  });
} else if (kind === "pipeline" && operation === "transition" && writer === "http") {
  const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
  registerPipelineTick(async () => {});
  const { PATCH } = await import("@/app/api/pipelines/[id]/route");
  const response = await PATCH(new NextRequest("http://127.0.0.1/api/pipelines/pipeline-http", {
    method: "PATCH",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  }), { params: Promise.resolve({ id: "pipeline-http" }) });
  if (!response.ok) throw new Error(`HTTP pipeline transition failed: ${response.status} ${await response.text()}`);
} else if (kind === "pipeline" && operation === "transition" && writer === "mcp") {
  const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
  registerPipelineTick(async () => {});
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().pipeline_action({
    pipelineId: "pipeline-mcp",
    action: "start",
    clientRequestId: "mcp-pipeline-transition-request",
  });
} else {
  throw new Error(`unknown writer: ${kind}/${operation}/${writer}`);
}
