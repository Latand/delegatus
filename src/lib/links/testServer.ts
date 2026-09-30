/** Private HTTP harness for the two-install protocol test. Never imported by production. */
import fs from "node:fs";
import http from "node:http";
import { NextRequest } from "next/server";

import { saveAddress } from "./self";
import { proxy } from "@/proxy";
import { dropRemoteProjects } from "./boardLinks";
import * as links from "@/app/api/links/route";
import * as peer from "@/app/api/peer/v1/[...path]/route";
import * as selfCheck from "@/app/api/peer/v1/self-check/route";
import * as peerUnknown from "@/app/api/peer/[...path]/route";
import * as peerRoot from "@/app/api/peer/route";
import * as codes from "@/app/api/links/codes/route";
import * as peers from "@/app/api/links/peers/route";
import * as peerOne from "@/app/api/links/peers/[id]/route";
import * as grants from "@/app/api/links/grants/route";
import * as shared from "@/app/api/links/shared/route";
import * as tasksRoute from "@/app/api/tasks/route";
import * as taskOne from "@/app/api/tasks/[id]/route";
import { forgetTaskExchange } from "./taskExchange";
import { readTaskCursor, remoteStore } from "./boardLinks";
import { ownBoardStoreId } from "./boardLinks";
import { initializeStateCollections, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { statePath } from "@/lib/configDir";
import { createTask } from "@/lib/tasks/commands";
import { loadTasks, mutateTasks, taskFeedSource } from "@/lib/tasks/store";
import { runsElsewhere } from "./linked";
import { listFiles } from "@/lib/scanner";
import { currentFileScan, lastScannedFiles, setFileScanRunnerForTests } from "@/lib/scanner/scanCache";
import { runFileCatalogScan } from "@/lib/scanner/scanCoordinator";
import { agentCursors, agentFeed, dropAgents, receivedAgentRows, remoteAgents } from "./agentFeed";
import { admitScannedConversations } from "@/lib/tasks/membership";
import { admitRecoveredLaunch, admitReservedLaunch } from "@/lib/tasks/launchMembership";
import { applyTaskCuratorProposals, collectTaskCuratorInputs } from "@/lib/tasks/curator";
import { Database, Statement } from "bun:sqlite";

const dir = process.argv[2]!;
process.env.LLV_STATE_DIR = dir;
process.env.XDG_CONFIG_HOME = `${dir}/config`;
process.env.LLV_STATE_OWNER = "viewer";
process.env.LLV_TOKEN = "key";
fs.mkdirSync(dir, { recursive: true });
let syncCalls = 0;
let restartAgentFeedAfterPage: string | null = null;
let padSync = 0;
let maxSyncBody = 0;
let failSync: number | null = null;
let legacyTaskWire = false;
let badInfo = false;
let grantDeleteStatus: number | null = null;
let holdNextSync: "request" | "response" | "task-response" | null = null;
let syncHeld = false;
let releaseSync: (() => void) | null = null;
const syncBodySizes: number[] = [];
const syncAnswerSizes: number[] = [];
const wire: { path: string; request: string; response: string }[] = [];
let captureWire = true;
let measureMemory = false;
/* Every sync body since the last reset, for the tests that scan them all. */
let captured: { request: string; response: string }[] = [];
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
let capturing = true;
/** A sync answer padded to this many bytes. */
let padAnswer = 0;
/* Store spies (M.9 "Idle call, work"): every statement this process runs on
   any SQLite database, counted as a `state_rows` read or as a write. */
const store = { rowReads: 0, writes: 0 };
let spying = true;
const wrapped = new WeakSet<object>();
const kindOf = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) ? "write" : /\bFROM\s+state_rows\b/i.test(sql) ? "read" : null;
const count = (kind: "read" | "write" | null) => {
  if (!spying || !kind) return;
  if (kind === "read") store.rowReads++; else store.writes++;
};
// A statement's `get`, `all`, `run`… are its own properties, so each statement
// is wrapped once when it is prepared (`query` hands back cached ones).
for (const method of ["query", "prepare"] as const) {
  const original = Database.prototype[method] as (this: Database, sql: string, ...rest: unknown[]) => Statement;
  (Database.prototype as unknown as Record<string, unknown>)[method] = function (this: Database, sql: string, ...rest: unknown[]) {
    const statement = original.call(this, sql, ...rest);
    const kind = kindOf(sql);
    if (kind && !wrapped.has(statement)) {
      wrapped.add(statement);
      const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const run of ["all", "get", "run", "values", "iterate", "raw"]) {
        const bound = own[run];
        if (typeof bound === "function") own[run] = (...args: unknown[]) => { count(kind); return bound.apply(statement, args); };
      }
    }
    return statement;
  };
}
for (const method of ["run", "exec"] as const) {
  const original = (Database.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
  if (!original) continue;
  (Database.prototype as unknown as Record<string, unknown>)[method] = function (this: Database, sql: string, ...args: unknown[]) { count(kindOf(sql)); return original.call(this, sql, ...args); };
}
/** The revision and byte size of the collections M2 adds, read outside the spies. */
function storeFigures() {
  spying = false;
  try {
    const db = new Database(statePath("state.sqlite"), { readonly: true });
    try {
      const names = ["tasks", "board_links", "task_tombstones"];
      const revisions = Object.fromEntries(names.map((name) => [name, (db.query("SELECT revision FROM state_collections WHERE collection = ?").get(name) as { revision: number } | null)?.revision ?? null]));
      const bytes = Object.fromEntries(names.map((name) => [name, (db.query("SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(row_key AS BLOB)) + length(CAST(value_json AS BLOB))), 0) AS bytes, COALESCE(MAX(length(CAST(value_json AS BLOB))), 0) AS largest FROM state_rows WHERE collection = ?").get(name))]));
      const changes = Object.fromEntries(names.map((name) => [name, (db.query("SELECT COUNT(*) AS rows FROM state_changes WHERE collection = ?").get(name) as { rows: number }).rows]));
      return { revisions, bytes, changes };
    } finally { db.close(); }
  } finally { spying = true; }
}
const json = (response: http.ServerResponse, value: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
const server = http.createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/test/metrics") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ syncCalls, maxSyncBody, maxSyncBodyLast100: Math.max(...syncBodySizes.slice(-100), 0), maxSyncAnswerLast100: Math.max(...syncAnswerSizes.slice(-100), 0) }));
      return;
    }
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const body = () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    if (path === "/test/cpu") { const usage = process.cpuUsage(); json(response, { ms: (usage.user + usage.system) / 1000 }); return; }
    if (path === "/test/heap") {
      Bun.gc(true);
      const memory = process.memoryUsage();
      json(response, { heapUsed: memory.heapUsed, rss: memory.rss });
      return;
    }
    if (path === "/test/clock") { clockOffset = Number(query.get("offset") ?? 0); json(response, { clockOffset }); return; }
    if (path === "/test/legacy-task-wire") { legacyTaskWire = query.get("on") === "1"; json(response, { legacyTaskWire }); return; }
    if (path === "/test/capture") { capturing = query.get("on") !== "0"; captured = []; json(response, { capturing }); return; }
    if (path === "/test/measure-memory") { capturing = false; captured = []; captureWire = false; wire.length = 0; measureMemory = true; json(response, { ok: true }); return; }
    if (path === "/test/captured") { json(response, captured); if (query.get("reset") === "1") captured = []; return; }
    if (path === "/test/tasks") { json(response, loadTasks()); return; }
    if (path === "/test/legacy-cursor") {
      const input = body() as { id: string; pull: number[]; pushed: number[]; projects: string[] };
      const opened = new SqliteStateCollection<{ key: string; store: string; shared: unknown[]; cursor?: unknown }>(statePath("state.sqlite"), {
        collection: "board_links", schemaVersion: 1, busyMessage: "test board links busy", key: (row) => row.key,
        decode: (value) => value as never, clone: structuredClone,
      });
      opened.boundedPatch(2, (tx) => tx.put({ key: `tasks:${input.id}`, store: remoteStore(input.id)!, shared: [], cursor: { pull: input.pull, pushed: input.pushed, pullCovered: input.projects, pushCovered: input.projects } }));
      forgetTaskExchange(input.id);
      json(response, { cursor: readTaskCursor(input.id, remoteStore(input.id)!) });
      return;
    }
    if (path === "/test/import-tasks") {
      const input = body() as { tasks: ReturnType<typeof loadTasks> };
      mutateTasks(() => ({ tasks: input.tasks, result: null }));
      json(response, { count: input.tasks.length });
      return;
    }
    if (path === "/test/scan") { const scan = await currentFileScan({ fresh: true }); json(response, { files: scan.snapshot.files.map((file) => ({ project: file.project, engine: file.engine, conversationId: file.conversationId, proc: file.proc })), generation: scan.generation }); return; }
    if (path === "/test/agent-state") {
      const state = query.get("state");
      setFileScanRunnerForTests(state === "running" || state === "done"
        ? (...args) => runFileCatalogScan(...args).then((snapshot) => ({ ...snapshot, files: snapshot.files.map((file) => ({ ...file,
          proc: state, activity: state === "running" ? "live" as const : "idle" as const })) }))
        : null);
      json(response, { state }); return;
    }
    if (path === "/test/agents") { json(response, remoteAgents(query.get("project") ?? "")); return; }
    if (path === "/test/agent-maps") {
      const id = query.get("id") ?? "";
      json(response, { scanned: lastScannedFiles()?.length ?? 0, local: agentFeed(id).sizes(), remote: receivedAgentRows(id).length });
      return;
    }
    if (path === "/test/agent-reset") { const cursor = agentCursors(`peer:${query.get("id") ?? ""}`); cursor.pull = null; cursor.pullOffset = 0; json(response, { ok: true }); return; }
    if (path === "/test/agent-feed-restart") { restartAgentFeedAfterPage = query.get("id"); json(response, { ok: true }); return; }
    if (path === "/test/runs-here") {
      const task = loadTasks().find((row) => row.id === query.get("id"));
      json(response, task ? { refusal: runsElsewhere(task) } : { error: "not found" });
      return;
    }
    if (path === "/test/store") {
      const counts = { ...store };
      if (query.get("reset") === "1") { store.rowReads = 0; store.writes = 0; }
      json(response, { ...counts, ...storeFigures() });
      return;
    }
    if (path === "/test/pad-answer") { padAnswer = Math.max(Number(query.get("to")) || 0, 0); json(response, { padAnswer }); return; }
    if (path === "/test/revision") { json(response, { revision: taskFeedSource()?.revision() ?? 0 }); return; }
    if (path === "/test/bulk") {
      // Many tasks in one transaction, as a test fixture.
      const input = body() as { project: string; count: number; text?: string; details?: string; explicit?: boolean; each?: boolean };
      const ids: string[] = [];
      const run = (count: number) => mutateTasks((tasks) => {
        const next = tasks.slice();
        for (let i = 0; i < count; i++) {
          const outcome = createTask(next, { project: input.project, text: input.text ?? `fixture ${ids.length}`, details: input.details, placement: "unplaced", board: "hidden" }, [], { explicit: input.explicit !== false });
          if (!outcome.ok) throw new Error(outcome.error);
          next.push(outcome.task);
          ids.push(outcome.task.id);
        }
        return { tasks: next, result: null };
      });
      if (input.each) for (let i = 0; i < input.count; i++) run(1); else run(input.count);
      json(response, { ids });
      return;
    }
    if (path === "/test/prompts") {
      /* Tasks whose text starts as a prompt, each made by its production path:
         the transcript scan's admission, a recovered launch's display prompt, a
         pipeline stage launch titled with its goal, and a curator card. */
      const input = body() as { project: string; launch: string; goal: string; curator: string };
      const before = new Set(loadTasks().map((task) => task.id));
      const entries = await listFiles();
      const scanned = admitScannedConversations(entries, []);
      admitRecoveredLaunch({ launchId: "launch-canary", conversationId: "conversation_launch_canary", engine: "claude", cwd: undefined, clientAttemptId: "attempt-canary",
        explicitProject: input.project, launchProfile: {}, launchDisplay: { prompt: input.launch } });
      admitReservedLaunch({ engine: "codex", cwd: undefined, explicitProject: input.project, launchProfile: { title: input.goal }, origin: { kind: "container", container: "pipeline", containerId: "lane-canary" } },
        { launchId: "launch-stage-canary", conversationId: "conversation_stage_canary" }, () => undefined);
      const curatorInput = collectTaskCuratorInputs(entries, { project: input.project })[0];
      const curated = curatorInput ? applyTaskCuratorProposals(entries, [{ inputId: curatorInput.id, title: input.curator }]) : null;
      json(response, { scanned, entries: entries.length, curated: curated?.created.length ?? 0, skipped: curated?.skipped ?? [],
        tasks: loadTasks().filter((task) => !before.has(task.id)).map((task) => ({ id: task.id, text: task.text })) });
      return;
    }
    if (path === "/test/raw") {
      // Write a row in a stored shape of the test's choosing (a pre-M2 row, an oversize link).
      const input = body() as { id: string; fields: Record<string, unknown>; remove?: string[] };
      mutateTasks((tasks) => {
        const index = tasks.findIndex((task) => task.id === input.id);
        const next = { ...tasks[index]!, ...input.fields } as Record<string, unknown>;
        for (const key of input.remove ?? []) delete next[key];
        tasks[index] = next as never;
        return { tasks, result: null };
      });
      json(response, { ok: true });
      return;
    }
    if (path === "/test/new-store") {
      // A recreated board store: the self row goes, the next read mints another id.
      const file = statePath("state.sqlite");
      initializeStateCollections(file, [{ collection: "board_links", schemaVersion: 1, migrationId: "linked-boards-m1", key: (row: { key: string }) => row.key, loadRecords: () => [] }]);
      const links = new SqliteStateCollection<{ key: string }>(file, { collection: "board_links", schemaVersion: 1, busyMessage: "busy", key: (row) => row.key, decode: (value) => value as { key: string }, clone: structuredClone });
      links.boundedPatch(2, (tx) => { if (tx.get("self")) tx.delete("self"); });
      json(response, { store: ownBoardStoreId() });
      return;
    }
    if (path === "/test/fail-sync") {
      const on = new URL(request.url ?? "/", "http://localhost").searchParams.get("on");
      failSync = on === "401" ? 401 : on === "1" ? 503 : null;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ failSync }));
      return;
    }
    if (path === "/test/pad-sync") {
      padSync = Math.min(Math.max(Number(new URL(request.url ?? "/", "http://localhost").searchParams.get("bytes")) || 0, 0), 65_536);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ padSync }));
      return;
    }
    if (path === "/test/bad-info") {
      badInfo = new URL(request.url ?? "/", "http://localhost").searchParams.get("on") === "1";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ badInfo }));
      return;
    }
    if (path === "/test/fail-grant-delete") {
      const status = Number(new URL(request.url ?? "/", "http://localhost").searchParams.get("on"));
      grantDeleteStatus = status === 401 || status === 503 ? status : null;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ grantDeleteStatus }));
      return;
    }
    if (path === "/test/hold-sync") {
      const side = new URL(request.url ?? "/", "http://localhost").searchParams.get("side");
      holdNextSync = side === "response" || side === "task-response" ? side : "request";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ holdNextSync }));
      return;
    }
    if (path === "/test/sync-held") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ held: syncHeld }));
      return;
    }
    if (path === "/test/release-sync") {
      releaseSync?.();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ released: syncHeld }));
      return;
    }
    if (path === "/api/peer/v1/boards/sync" && failSync) {
      if (capturing) captured.push({ request: Buffer.concat(chunks).toString("utf8"), response: "" });
      response.writeHead(failSync, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    if (path === "/api/peer/v1/info" && badInfo) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{");
      return;
    }
    if (path === "/api/peer/v1/grant" && request.method === "DELETE" && grantDeleteStatus) {
      response.writeHead(grantDeleteStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    if (path === "/test/wire") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(wire));
      return;
    }
    if (path === "/test/forget-remote") {
      const id = new URL(request.url ?? "/", "http://localhost").searchParams.get("id");
      if (id) dropRemoteProjects(id);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ forgotten: Boolean(id) }));
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
    const req = new NextRequest(`http://127.0.0.1:${(server.address() as { port: number }).port}${request.url}`, {
      method: request.method, headers, body: ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") && chunks.length ? Buffer.concat(chunks) : undefined,
    });
    let result: Response;
    const method = request.method ?? "GET";
    // The merge-base task decoder rejects every key outside its v2 allowlist.
    // Keep that strict failure in the HTTP integration harness for rolling upgrades.
    if (path === "/api/peer/v1/boards/sync" && legacyTaskWire) {
      const rows = (body().push as { rows?: unknown[] } | undefined)?.rows ?? [];
      if (rows.some((row) => !!row && typeof row === "object" && !Array.isArray(row) && "board" in row)) {
        response.statusCode = 400;
        json(response, { error: "malformed" });
        return;
      }
    }
    // Exercise the same proxy then route order used by the Viewer for peers.
    const perimeter = path === "/api/peer" || path.startsWith("/api/peer/") ? proxy(req) : null;
    if (perimeter && perimeter.headers.get("x-middleware-next") !== "1") result = perimeter;
    else if (path === "/api/peer/v1/self-check") result = method === "POST" ? selfCheck.POST(req) : selfCheck.GET(req);
    else if (path.startsWith("/api/peer/v1/")) {
      const context = { params: Promise.resolve({ path: path.slice("/api/peer/v1/".length).split("/") }) };
      result = method === "GET" ? await peer.GET(req, context) : method === "DELETE" ? await peer.DELETE(req, context) : await peer.POST(req, context);
    } else if (path === "/api/peer") result = peerRoot.GET(req);
    else if (path.startsWith("/api/peer/")) result = peerUnknown.GET(req);
    else if (path === "/api/links") result = method === "GET" ? links.GET(req) : await links.POST(req);
    else if (path === "/api/links/codes") result = method === "GET" ? codes.GET(req) : method === "DELETE" ? await codes.DELETE(req) : await codes.POST(req);
    else if (path === "/api/links/peers") result = method === "GET" ? peers.GET(req) : await peers.POST(req);
    else if (path.startsWith("/api/links/peers/")) {
      const context = { params: Promise.resolve({ id: path.slice("/api/links/peers/".length) }) };
      result = method === "DELETE" ? await peerOne.DELETE(req, context) : await peerOne.POST(req, context);
    } else if (path === "/api/links/grants") result = method === "GET" ? grants.GET(req) : grants.DELETE(req);
    else if (path === "/api/links/shared") result = method === "GET" ? shared.GET(req) : method === "PATCH" ? await shared.PATCH(req) : await shared.POST(req);
    else if (path === "/api/tasks") result = method === "GET" ? await tasksRoute.GET(req) : await tasksRoute.POST(req);
    else if (path.startsWith("/api/tasks/")) {
      const context = { params: Promise.resolve({ id: path.slice("/api/tasks/".length) }) };
      result = method === "DELETE" ? await taskOne.DELETE(req, context) : await taskOne.PATCH(req, context);
    }
    else result = Response.json({ error: "not found" }, { status: 404 });
    let resultBody = Buffer.from(await result.arrayBuffer());
    if (path === "/api/peer/v1/boards/sync" && legacyTaskWire && result.status === 200) {
      const legacy = JSON.parse(resultBody.toString("utf8")) as { taskWireVersion?: number; tasks?: { rows?: Record<string, unknown>[] } };
      delete legacy.taskWireVersion;
      for (const row of legacy.tasks?.rows ?? []) {
        delete row.board;
        if (typeof row.text === "string" && row.s) row.text = "Untitled task";
      }
      resultBody = Buffer.from(JSON.stringify(legacy));
    }
    if (path === "/api/peer/v1/boards/sync" && restartAgentFeedAfterPage) {
      const agents = (JSON.parse(resultBody.toString("utf8")) as { agents?: { reset?: boolean; more?: boolean } }).agents;
      if (agents?.reset && agents.more) {
        dropAgents(`grant:${restartAgentFeedAfterPage}`);
        restartAgentFeedAfterPage = null;
      }
    }
    // Whitespace after the JSON keeps it valid; only the size cap refuses it.
    if (path === "/api/peer/v1/boards/sync" && padAnswer > resultBody.byteLength) resultBody = Buffer.concat([resultBody, Buffer.alloc(padAnswer - resultBody.byteLength, " ")]);
    if (captureWire && path.startsWith("/api/peer/v1/") && wire.length < 30) wire.push({ path, request: Buffer.concat(chunks).toString("utf8"), response: resultBody.toString("utf8") });
    const heldBody = path === "/api/peer/v1/boards/sync" && holdNextSync
      ? JSON.parse((holdNextSync === "request" ? Buffer.concat(chunks) : resultBody).toString("utf8")) as { index?: number; tasks?: { rows?: unknown[] } } : null;
    if (path === "/api/peer/v1/boards/sync" && holdNextSync &&
        (holdNextSync === "task-response" ? (heldBody?.tasks?.rows?.length ?? 0) > 0 : heldBody?.index === 0)) {
      holdNextSync = null;
      syncHeld = true;
      await new Promise<void>((resolve) => { releaseSync = resolve; });
      syncHeld = false;
      releaseSync = null;
    }
    // Wire bytes are counted by the test's TCP proxy; padding proves extra headers reach that count.
    const answerHeaders = Object.fromEntries(result.headers);
    delete answerHeaders["content-length"];
    response.writeHead(result.status, { ...answerHeaders, ...(path === "/api/peer/v1/boards/sync" && padSync ? { "x-test-pad": "p".repeat(padSync) } : {}) });
    response.end(resultBody, () => {
      if (path === "/api/peer/v1/boards/sync") {
        if (capturing) captured.push({ request: Buffer.concat(chunks).toString("utf8"), response: resultBody.toString("utf8") });
        if (captured.length > 5_000) captured.shift();
        syncCalls++;
        maxSyncBody = Math.max(maxSyncBody, Buffer.concat(chunks).byteLength);
        if (!measureMemory) {
          syncBodySizes.push(Buffer.concat(chunks).byteLength);
          syncAnswerSizes.push(resultBody.byteLength);
        }
      }
    });
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "error" }));
  }
});
server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  if (process.argv[3] !== "--no-address") {
    const saved = await saveAddress(`http://127.0.0.1:${port}`, pathBasename(dir));
    if (saved.refusal) throw new Error(saved.refusal);
  }
  process.stdout.write(JSON.stringify({ port }) + "\n");
});
function pathBasename(value: string) { return value.split("/").filter(Boolean).at(-1) ?? "install"; }
