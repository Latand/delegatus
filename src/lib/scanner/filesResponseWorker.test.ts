import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { signalFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";

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

function expectEtagMatchesBody(result: { body: string; etag: string }): void {
  expect(result.etag).toBe(`"${createHash("sha1").update(result.body).digest("hex")}"`);
}

function bodyWithoutVolatileStorageFreeBytes(body: string): string {
  const parsed = JSON.parse(body) as { systemHealth: { storage: { writes: { freeBytes: number | null } } } };
  parsed.systemHealth.storage.writes.freeBytes = 0;
  return JSON.stringify(parsed);
}

function scratchState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-response-worker-"));
}

async function stopTestWorker(): Promise<void> {
  // The pool retains the original launch handle even after exit while inherited
  // stdio stays open. Its diagnostic PID can already belong to another process.
  const child = (globalThis as typeof globalThis & {
    __llvFilesResponseWorker?: { child: ChildProcess } | null;
  }).__llvFilesResponseWorker?.child;
  shutdownFilesResponseWorker("test");
  if (child) {
    await stopFixtureProcess(child);
    expect(child.exitCode !== null || child.signalCode !== null, "test worker was reaped before teardown returned").toBe(true);
  }
}

afterEach(async () => {
  await stopTestWorker();
  delete process.env.LLV_FILES_RESPONSE_WORKER_RSS_LIMIT_MB;
  delete process.env.LLV_FILES_RESPONSE_WORKER_IDLE_MS;
});

// Use the real pool and both call-site helpers. A descendant keeps stdout open
// after the root exits, so diagnostics retain the root PID through actual reuse.
for (const helperFile of ["./filesResponseWorker.test.ts", "../../app/api/files/route.test.ts"]) {
  test.skipIf(process.platform !== "linux")(`worker cleanup preserves a genuinely reused PID: ${helperFile}`, () => {
    const stateDir = scratchState();
    const program = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { captureProcessIdentity, processIdentityStatus } from ${JSON.stringify(new URL("../processIdentity.ts", import.meta.url).pathname)};
import { stopFixtureIdentity, stopFixtureProcess } from ${JSON.stringify(new URL("../testing/fixtureProcess.ts", import.meta.url).pathname)};
import { buildFilesResponseInWorker, filesResponseWorkerPoolDiagnostics, shutdownFilesResponseWorker } from ${JSON.stringify(new URL("./filesResponseWorker.ts", import.meta.url).pathname)};
const scratch = ${JSON.stringify(stateDir)};
process.env.LLV_STATE_DIR = scratch;
const fake = path.join(scratch, "linger-worker.mjs");
fs.writeFileSync(fake, \`import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import {spawn} from 'node:child_process';
readline.createInterface({input:process.stdin}).once('line', line => {
  const {id} = JSON.parse(line);
  const child = spawn('/bin/sleep', ['30'], {stdio:['ignore','inherit','inherit']});
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR, 'descendant.json'), JSON.stringify({pid:child.pid}));
  const directory = path.join(process.env.LLV_STATE_DIR, 'files-response-results'); fs.mkdirSync(directory, {recursive:true});
  const bodyFile = path.join(directory, 'body.json'); fs.writeFileSync(bodyFile, '{}');
  process.stdout.write(JSON.stringify({id,ok:true,result:{bodyFile,contentType:'application/json',etag:'probe',timing:'0'}}) + String.fromCharCode(10), () => process.exit(0));
});\`);
await buildFilesResponseInWorker({type:'project',url:'http://127.0.0.1/api/files',headers:[]}, {
  launch:{executable:process.execPath,workerPath:fake},env:process.env,timeoutMs:2000,
});
const old = globalThis.__llvFilesResponseWorker.child;
if (old.exitCode === null) await new Promise(resolve => old.once('exit', resolve));
await Bun.sleep(30);
const descendant = captureProcessIdentity(JSON.parse(fs.readFileSync(path.join(scratch, 'descendant.json'), 'utf8')).pid);
let bystander;
try {
  if (filesResponseWorkerPoolDiagnostics().pid !== old.pid) throw new Error('pool did not retain exited root');
  fs.writeFileSync('/proc/sys/kernel/ns_last_pid', String(old.pid - 1));
  bystander = spawn('/bin/sleep', ['30'], {stdio:'ignore'});
  const other = captureProcessIdentity(bystander.pid);
  if (other.pid !== old.pid) throw new Error('real PID reuse did not occur');
  await stopFixtureProcess(old);
  if (processIdentityStatus(other) !== 'alive') throw new Error('original-handle control killed bystander');
  const source = fs.readFileSync(${JSON.stringify(new URL(helperFile, import.meta.url).pathname)}, 'utf8');
  const helper = source.slice(source.indexOf('async function stopTestWorker()'), source.indexOf('afterEach(async () =>'));
  const code = ts.transpileModule(helper, {compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext}}).outputText;
  const expect = (actual, message) => ({toBe(expected) {if (actual !== expected) throw new Error(message + ': ' + actual + ' !== ' + expected);}});
  const cleanup = new Function('filesResponseWorkerPoolDiagnostics', 'captureProcessIdentity', 'shutdownFilesResponseWorker', 'stopFixtureIdentity', 'stopFixtureProcess', 'processIdentityStatus', 'Bun', 'expect', code + '; return stopTestWorker;')(
    filesResponseWorkerPoolDiagnostics, captureProcessIdentity, shutdownFilesResponseWorker, stopFixtureIdentity, stopFixtureProcess, processIdentityStatus, Bun, expect,
  );
  await cleanup();
  if (processIdentityStatus(other) !== 'alive') throw new Error('worker cleanup killed recycled-PID bystander');
  fs.writeFileSync(fake, \`import readline from 'node:readline'; import fs from 'node:fs'; import path from 'node:path';
readline.createInterface({input:process.stdin}).on('line', line => {
  const {id} = JSON.parse(line);
  const bodyFile = path.join(process.env.LLV_STATE_DIR, 'files-response-results', 'live.json'); fs.writeFileSync(bodyFile, '{}');
  process.stdout.write(JSON.stringify({id,ok:true,result:{bodyFile,contentType:'application/json',etag:'probe',timing:'0'}}) + String.fromCharCode(10));
});\`);
  await buildFilesResponseInWorker({type:'project',url:'http://127.0.0.1/api/files',headers:[]}, {
    launch:{executable:process.execPath,workerPath:fake},env:process.env,timeoutMs:2000,
  });
  const live = globalThis.__llvFilesResponseWorker.child;
  const liveIdentity = captureProcessIdentity(live.pid);
  if (live.exitCode !== null || live.signalCode !== null) throw new Error('owned worker was not live');
  await cleanup();
  if (live.exitCode === null && live.signalCode === null) throw new Error('cleanup returned before owned worker exit');
  if (processIdentityStatus(liveIdentity) !== 'dead') throw new Error('cleanup did not reap owned live worker');
  if (processIdentityStatus(other) !== 'alive') throw new Error('live-worker cleanup killed bystander');
  console.log('recycled worker PID bystander survived');
} finally {
  if (bystander) await stopFixtureProcess(bystander);
  await stopFixtureIdentity(descendant);
  shutdownFilesResponseWorker('probe end');
}
`;
    try {
      const result = spawnSync("unshare", ["-Urpf", "--mount-proc", process.execPath, "-e", program], { encoding: "utf8", timeout: 7_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("recycled worker PID bystander survived");
    } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
  }, 10_000);
}

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
    await stopTestWorker();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/* #1814: production forked one ~1.2 GB worker every ten seconds because every
   build got its own process. A burst has to be served by one. */
test("a burst of rapid sequential projections is served by one worker process", async () => {
  const stateDir = scratchState();
  try {
    const before = filesResponseWorkerPoolDiagnostics().spawns;
    const results: Array<Awaited<ReturnType<typeof buildFilesResponseInWorker>>> = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(await buildFilesResponseInWorker(request, runtimeFor(stateDir)));
    }
    const after = filesResponseWorkerPoolDiagnostics();
    expect(after.spawns - before).toBe(1);
    expect(after.builds).toBeGreaterThanOrEqual(6);
    expect(after.pid).not.toBeNull();
    for (const result of results) expectEtagMatchesBody(result);
  } finally {
    await stopTestWorker();
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
    for (const result of results) expectEtagMatchesBody(result);
    /* Each answer is read from its own body file and the file is removed, so
       two builds can never hand back the same one. */
    expect(new Set(results.map((result) => bodyWithoutVolatileStorageFreeBytes(result.body))).size).toBe(1);
  } finally {
    await stopTestWorker();
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
    await stopTestWorker();
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
    await stopTestWorker();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a worker that dies mid-build fails its build and the next one starts a fresh worker", async () => {
  const stateDir = scratchState();
  try {
    await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    const running = filesResponseWorkerPoolDiagnostics();
    expect(running.pid).not.toBeNull();
    const identity = captureProcessIdentity(running.pid!);
    const pending = buildFilesResponseInWorker(request, runtimeFor(stateDir));
    signalFixtureIdentity(identity, "SIGKILL");
    await expect(pending).rejects.toThrow(/files response worker/);
    const recovered = await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    expect(recovered.etag).toMatch(/^"[a-f0-9]{40}"$/);
    expect(filesResponseWorkerPoolDiagnostics().spawns).toBeGreaterThanOrEqual(running.spawns + 1);
  } finally {
    await stopTestWorker();
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
    await stopTestWorker();

    const second = await buildFilesResponseInWorker(scoped(2) as never, runtimeFor(stateDir));
    expect(second.etag).not.toBe(first.etag);
    expect(second.delta?.base).toBe(first.etag);
    const delta = JSON.parse(second.delta!.body);
    expect(delta).toMatchObject({ v: 1, base: first.etag, etag: second.etag });
    expect(delta.rows).toEqual([["files", { count: 2, upsert: [["/sessions/changed.jsonl", expect.objectContaining({ mtime: 2 })]] }]]);

    const repeated = await buildFilesResponseInWorker(scoped(2) as never, runtimeFor(stateDir));
    expectEtagMatchesBody(repeated);
    if (repeated.delta) {
      expect(repeated.delta.base).toBe(second.etag);
      const repeatedDelta = JSON.parse(repeated.delta.body);
      expect(repeatedDelta.rows).toBeUndefined();
      expect(repeatedDelta.set).toBeUndefined();
      expect(repeatedDelta.unset).toBeUndefined();
      expect(repeatedDelta.entries).toEqual([[
        "systemHealth",
        { upsert: [["storage", expect.objectContaining({
          writes: expect.objectContaining({ state: "ok", since: null, freeBytes: expect.any(Number) }),
        })]] },
      ]]);
    }
    expect(fs.readdirSync(path.join(stateDir, "files-response-results")).filter((name) => !name.startsWith("delta-base-"))).toEqual([]);
  } finally {
    await stopTestWorker();
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
    await stopTestWorker();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
