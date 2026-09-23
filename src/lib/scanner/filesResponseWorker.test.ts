import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildFilesResponseInWorker,
  filesResponseWorkerPoolDiagnostics,
  shutdownFilesResponseWorker,
  type FilesResponseWorkerRuntime,
} from "./filesResponseWorker";

const WORKER_PATH = path.resolve(import.meta.dir, "../filesResponse.worker.ts");

function runtimeFor(stateDir: string, extra: Record<string, string> = {}): FilesResponseWorkerRuntime {
  return {
    launch: { executable: process.execPath, workerPath: WORKER_PATH },
    env: {
      ...process.env,
      NODE_ENV: "production" as const,
      LLV_STATE_DIR: stateDir,
      LLV_AGENT_REGISTRY_SQLITE: "off",
      LLV_FILES_RESPONSE_WORKER: "1",
      ...extra,
    },
    timeoutMs: 30_000,
  };
}

const request = {
  type: "project" as const,
  url: "http://127.0.0.1/api/files",
  headers: [] as Array<[string, string]>,
  snapshot: { files: [], projectCatalog: [], complete: true },
};

function scratchState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-response-worker-"));
}

afterEach(() => {
  shutdownFilesResponseWorker("test");
  delete process.env.LLV_FILES_RESPONSE_WORKER_RSS_LIMIT_MB;
  delete process.env.LLV_FILES_RESPONSE_WORKER_IDLE_MS;
});

test("files response projection runs in an isolated worker process", async () => {
  const stateDir = scratchState();
  try {
    const result = await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    expect(result.etag).toMatch(/^"[a-f0-9]{40}"$/);
    expect(result.contentType).toContain("application/json");
    expect(JSON.parse(result.body)).toMatchObject({
      files: [],
      projectCatalog: [],
      flows: [],
      pipelines: [],
      workflows: [],
      tasks: [],
    });
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/* #1814: production forked one ~1.2 GB worker every ten seconds because every
   build got its own process. A burst has to be served by one. */
test("a burst of rapid sequential projections is served by one worker process", async () => {
  const stateDir = scratchState();
  try {
    const before = filesResponseWorkerPoolDiagnostics().spawns;
    const etags: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      etags.push((await buildFilesResponseInWorker(request, runtimeFor(stateDir))).etag);
    }
    const after = filesResponseWorkerPoolDiagnostics();
    expect(after.spawns - before).toBe(1);
    expect(after.builds).toBeGreaterThanOrEqual(6);
    expect(after.pid).not.toBeNull();
    expect(new Set(etags).size).toBe(1);
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("concurrent projections are served by one worker process", async () => {
  const stateDir = scratchState();
  try {
    const before = filesResponseWorkerPoolDiagnostics().spawns;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => buildFilesResponseInWorker(request, runtimeFor(stateDir))),
    );
    const after = filesResponseWorkerPoolDiagnostics();
    expect(after.spawns - before).toBe(1);
    expect(results).toHaveLength(6);
    expect(new Set(results.map((result) => result.etag)).size).toBe(1);
    /* Each answer is read from its own body file and the file is removed, so
       two builds can never hand back the same one. */
    expect(new Set(results.map((result) => result.body)).size).toBe(1);
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a worker that ends a build above the size threshold is retired", async () => {
  const stateDir = scratchState();
  process.env.LLV_FILES_RESPONSE_WORKER_RSS_LIMIT_MB = "1";
  try {
    const before = filesResponseWorkerPoolDiagnostics().spawns;
    await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    expect(filesResponseWorkerPoolDiagnostics().lastRetirement).toBe("size");
    expect(filesResponseWorkerPoolDiagnostics().pid).toBeNull();
    await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    expect(filesResponseWorkerPoolDiagnostics().spawns - before).toBe(2);
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a worker nobody asks for a projection is retired when it goes idle", async () => {
  const stateDir = scratchState();
  process.env.LLV_FILES_RESPONSE_WORKER_IDLE_MS = "40";
  try {
    await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    expect(filesResponseWorkerPoolDiagnostics().pid).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(filesResponseWorkerPoolDiagnostics().lastRetirement).toBe("idle");
    expect(filesResponseWorkerPoolDiagnostics().pid).toBeNull();
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a worker that dies mid-build fails its build and the next one starts a fresh worker", async () => {
  const stateDir = scratchState();
  try {
    await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    const running = filesResponseWorkerPoolDiagnostics();
    expect(running.pid).not.toBeNull();
    const pending = buildFilesResponseInWorker(request, runtimeFor(stateDir));
    /* The pid this kills is the one the pool just reported as its own. */
    process.kill(running.pid!, "SIGKILL");
    await expect(pending).rejects.toThrow(/files response worker/);
    const recovered = await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    expect(recovered.etag).toMatch(/^"[a-f0-9]{40}"$/);
    expect(filesResponseWorkerPoolDiagnostics().spawns).toBeGreaterThanOrEqual(running.spawns + 1);
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/* #1994: the delta from a scope's previous representation survives the
   worker being retired between two revisions. */
test("a retired worker still answers the next revision with a delta from its persisted base", async () => {
  const stateDir = scratchState();
  const deltaScope = "a".repeat(40);
  const entry = (name: string, mtime: number) => ({
    path: `/sessions/${name}.jsonl`, root: "codex-sessions", name, project: "repo", title: name, engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime, size: 1, activity: "recent", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  });
  const scoped = (mtime: number) => ({
    ...request,
    url: "http://127.0.0.1/api/files?view=summary",
    deltaScope,
    snapshot: { files: [entry("kept", 1), entry("changed", mtime)], projectCatalog: [], complete: true },
  });
  try {
    const first = await buildFilesResponseInWorker(scoped(1) as never, runtimeFor(stateDir));
    expect(first.delta).toBeUndefined();
    shutdownFilesResponseWorker("test");

    const second = await buildFilesResponseInWorker(scoped(2) as never, runtimeFor(stateDir));
    expect(second.etag).not.toBe(first.etag);
    expect(second.delta?.base).toBe(first.etag);
    const delta = JSON.parse(second.delta!.body);
    expect(delta).toMatchObject({ v: 1, base: first.etag, etag: second.etag });
    expect(delta.rows).toEqual([["files", { count: 2, upsert: [["/sessions/changed.jsonl", expect.objectContaining({ mtime: 2 })]] }]]);

    const repeated = await buildFilesResponseInWorker(scoped(2) as never, runtimeFor(stateDir));
    expect(repeated.delta).toBeUndefined();
    expect(fs.readdirSync(path.join(stateDir, "files-response-results")).filter((name) => !name.startsWith("delta-base-"))).toEqual([]);
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/* #2072: the worker reads the persisted scan snapshot when its turn comes, and
   a later scan may have replaced the file by then. It reports the generation
   the file it read names, so the projection is dated by the rows it holds. */
test("a projection from the snapshot file reports the scan generation that file holds", async () => {
  const stateDir = scratchState();
  const snapshotFile = path.join(stateDir, "files-scan-snapshot.json");
  const snapshot = { files: [], projectCatalog: [], complete: true };
  try {
    fs.writeFileSync(snapshotFile, JSON.stringify({ version: 1, schemaVersion: 12, epoch: "e1", generation: 15, snapshot }));
    const fromFile = await buildFilesResponseInWorker({ ...request, snapshot: undefined, snapshotFile }, runtimeFor(stateDir));
    expect(fromFile.snapshotRead).toEqual({ epoch: "e1", generation: 15 });

    /* A file written before the scan named its generation dates nothing. */
    fs.writeFileSync(snapshotFile, JSON.stringify({ version: 1, schemaVersion: 12, snapshot }));
    const undated = await buildFilesResponseInWorker({ ...request, snapshot: undefined, snapshotFile }, runtimeFor(stateDir));
    expect(undated.snapshotRead).toBeUndefined();

    /* An inline snapshot is the caller's own; it knows what it sent. */
    const inline = await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    expect(inline.snapshotRead).toBeUndefined();
  } finally {
    shutdownFilesResponseWorker("test");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
