import fs from "node:fs";
import { waitForFixtureFile } from "./fixtureBarrier";

import { NextRequest } from "next/server";

const stateDir = process.env.LLV_STATE_DIR;
const kind = process.env.LLV_WRITER_KIND ?? "task";
const writer = process.env.LLV_WRITER_INTERFACE;
const operation = process.env.LLV_WRITER_OPERATION ?? "create";
const readyPath = process.env.LLV_WRITER_READY;
const releasePath = process.env.LLV_WRITER_RELEASE;
const creatorPath = process.env.LLV_WRITER_SRC;

if (!stateDir || !writer || !readyPath || !releasePath) throw new Error("writer concurrency fixture is incomplete");

if (process.env.LLV_WRITER_NO_PROCESS_IDENTITY === "1") {
  const { procBackend } = await import("@/lib/proc");
  procBackend.processIdentity = () => null;
}

let gated = false;
function holdAfterRead(): void {
  if (gated) return;
  gated = true;
  fs.writeFileSync(readyPath!, "ready\n", "utf8");
  waitForFixtureFile(releasePath!);
}

/* Since #1870 both stores write SQLite collections. Hold their real lease
   after the committed rows are read; JSON is only the initial import. */
if (kind === "task") {
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
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
