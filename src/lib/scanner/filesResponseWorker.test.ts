import { readSummaryBootstrap } from "./summaryBootstrap";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { signalFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { applyFilesDelta } from "@/lib/filesDelta";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";

import {
  buildFilesResponseInWorker,
  drainFilesResponseWorker,
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
      HOME: path.join(stateDir, "home"),
      XDG_CONFIG_HOME: path.join(stateDir, "config"),
      TMPDIR: stateDir,
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
    expect(result.stateWrites).toEqual(JSON.parse(result.body).systemHealth.storage.writes);
    expect(result.stateDataWrites).toEqual(result.stateWrites);
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

test("normal RSS and idle cache hits keep one warm worker and retirement logs its cause", async () => {
  const stateDir = scratchState();
  process.env.LLV_FILES_RESPONSE_WORKER_RSS_LIMIT_MB = "1";
  process.env.LLV_FILES_RESPONSE_WORKER_IDLE_MS = "40";
  const logs: unknown[][] = [];
  const log = spyOn(console, "warn").mockImplementation((...args) => { logs.push(args); });
  let fakeNow = 1_000_000;
  const now = spyOn(Date, "now").mockImplementation(() => fakeNow);
  const timers = new Map<object, { run: () => void; due: number }>();
  const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay = 0) => {
    const handle = { unref() {} };
    timers.set(handle, { run, due: fakeNow + Number(delay) });
    return handle;
  }) as never);
  const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: object) => { timers.delete(handle); }) as never);
  const advance = async (ms: number) => {
    const until = fakeNow + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [handle, timer] = next;
      timers.delete(handle);
      fakeNow = timer.due;
      timer.run();
      await Promise.resolve();
    }
    fakeNow = until;
  };
  try {
    const before = filesResponseWorkerPoolDiagnostics().spawns;
    await buildFilesResponseInWorker(request, runtimeFor(stateDir));
    const pid = filesResponseWorkerPoolDiagnostics().pid;
    expect(pid).not.toBeNull();
    await advance(61_000);
    await buildFilesResponseInWorker(request, runtimeFor(stateDir, { LLV_UNUSED_TEST_VALUE: "changed" }));
    expect(filesResponseWorkerPoolDiagnostics().pid).toBe(pid);
    expect(filesResponseWorkerPoolDiagnostics().spawns - before).toBe(1);
    shutdownFilesResponseWorker("explicit test shutdown");
    expect(logs).toContainEqual([`[files response worker] retired: explicit test shutdown`, { pid, rssBytes: expect.any(Number) }]);
  } finally {
    clearTimer.mockRestore();
    setTimer.mockRestore();
    now.mockRestore();
    log.mockRestore();
    await stopTestWorker();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const quiet of [true, false]) {
  test(`normal viewer exit keeps its retirement reason with quiet=${quiet}`, async () => {
    const stateDir = scratchState();
    const previous = process.env.LLV_QUIET_DIAGNOSTICS;
    const log = spyOn(console, "info").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await buildFilesResponseInWorker(request, runtimeFor(stateDir));
      const child = (globalThis as typeof globalThis & { __llvFilesResponseWorker?: { child: ChildProcess } | null }).__llvFilesResponseWorker?.child;
      if (!child) throw new Error("fixture worker did not start");
      if (quiet) process.env.LLV_QUIET_DIAGNOSTICS = "1";
      else delete process.env.LLV_QUIET_DIAGNOSTICS;
      shutdownFilesResponseWorker("viewer exit");
      await stopFixtureProcess(child);
      expect(log).toHaveBeenCalledTimes(quiet ? 0 : 1);
      expect(warn).not.toHaveBeenCalled();
      expect(filesResponseWorkerPoolDiagnostics().lastRetirement).toBe("viewer exit");
    } finally {
      if (previous === undefined) delete process.env.LLV_QUIET_DIAGNOSTICS;
      else process.env.LLV_QUIET_DIAGNOSTICS = previous;
      log.mockRestore(); warn.mockRestore();
      await stopTestWorker();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

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

test("v2 resident worker preserves the certified base across discarded builds and retirement", async () => {
  const { applyBoardDelta } = await import("@/lib/boardDelta");
  const stateDir = scratchState();
  const scoped = { ...request, url: "http://127.0.0.1/api/files?view=summary", deltaScope: "c".repeat(40), boardEpoch: "first" };
  try {
    const first = await buildFilesResponseInWorker(scoped, runtimeFor(stateDir));
    expect(JSON.parse(first.body).boardProtocol).toBe(2);
    const changed = structuredClone(scoped);
    changed.snapshot!.projectCatalog = [{ project: "new", conversations: 0, smt: 1 }] as never;
    const next = await buildFilesResponseInWorker(changed, runtimeFor(stateDir), first);
    expect(next.delta?.base).toBe(first.etag);
    expect(applyBoardDelta(JSON.parse(first.body), JSON.parse(next.delta!.body))).toEqual(JSON.parse(next.body));
    const unpublished = structuredClone(changed);
    unpublished.snapshot!.projectCatalog = [{ project: "discarded", conversations: 0, smt: 2 }] as never;
    await buildFilesResponseInWorker(unpublished, runtimeFor(stateDir), next);
    const certified = await buildFilesResponseInWorker(scoped, runtimeFor(stateDir), next);
    expect(certified.delta?.base).toBe(next.etag);
    expect(applyBoardDelta(JSON.parse(next.body), JSON.parse(certified.delta!.body))).toEqual(JSON.parse(certified.body));
    await stopTestWorker();
    const recovered = await buildFilesResponseInWorker(changed, runtimeFor(stateDir), certified);
    expect(recovered.delta?.base).toBe(certified.etag);
    expect(applyBoardDelta(JSON.parse(certified.body), JSON.parse(recovered.delta!.body))).toEqual(JSON.parse(recovered.body));
    const restarted = await buildFilesResponseInWorker({ ...changed, boardEpoch: "second" }, runtimeFor(stateDir), recovered);
    expect(restarted.etag).not.toBe(recovered.etag);
    expect(restarted.delta).toBeUndefined();
    const otherScope = await buildFilesResponseInWorker({ ...changed, deltaScope: "d".repeat(40) }, runtimeFor(stateDir), recovered);
    expect(otherScope.delta).toBeUndefined();
    expect(fs.readdirSync(path.join(stateDir, "files-response-results"))).toEqual([]);
  } finally {
    await stopTestWorker();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const retirement of ["shutdown", "drained"] as const) {
  test(`v2 keeps a small delta from the certified ETag after ${retirement} retirement`, async () => {
    const { applyBoardDelta } = await import("@/lib/boardDelta");
    const stateDir = scratchState();
    const runtime = runtimeFor(stateDir);
    const scoped = (mtime: number) => ({
      ...request,
      url: "http://127.0.0.1/api/files?view=summary",
      deltaScope: "e".repeat(40), boardEpoch: "same-viewer",
      snapshot: {
        files: Array.from({ length: 20 }, (_, index) => ({
          path: `/sessions/session-${index}.jsonl`, root: "codex-sessions", name: `session-${index}`,
          project: "repo", title: "retained title ".repeat(1000), engine: "codex", kind: "session", fmt: "codex",
          parent: null, mtime: index === 0 ? mtime : 1, size: 1, activity: "recent", proc: null, pid: null,
          model: null, pendingQuestion: null, waitingInput: null,
        })),
        projectCatalog: [], complete: true,
      },
    });
    let retiredChild: ChildProcess | undefined;
    try {
      const before = filesResponseWorkerPoolDiagnostics().spawns;
      const first = await buildFilesResponseInWorker(scoped(1) as never, runtime);
      const child = (globalThis as typeof globalThis & { __llvFilesResponseWorker?: { child: ChildProcess } }).__llvFilesResponseWorker!.child;
      retiredChild = child;
      if (retirement === "drained") await drainFilesResponseWorker("drained");
      else shutdownFilesResponseWorker("shutdown");
      expect(filesResponseWorkerPoolDiagnostics().lastRetirement).toBe(retirement);
      expect(filesResponseWorkerPoolDiagnostics().pid).toBeNull();
      await stopFixtureProcess(child);
      delete process.env.LLV_FILES_RESPONSE_WORKER_RSS_LIMIT_MB;
      const next = await buildFilesResponseInWorker(scoped(2) as never, runtime, first);
      expect(filesResponseWorkerPoolDiagnostics().spawns - before).toBe(2);
      expect(next.delta?.base).toBe(first.etag);
      expect(Buffer.byteLength(next.delta!.body)).toBeLessThan(Buffer.byteLength(next.body) / 10);
      expect(applyBoardDelta(JSON.parse(first.body), JSON.parse(next.delta!.body))).toEqual(JSON.parse(next.body));
      expect(fs.readdirSync(path.join(stateDir, "files-response-results"))).toEqual([]);
    } finally {
      await stopTestWorker();
      if (retiredChild) await stopFixtureProcess(retiredChild);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

/* #1994: the v1 delta from a scope's previous representation survives the
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

test("a discarded worker build cannot replace the parent's certified delta base", async () => {
  const stateDir = scratchState();
  const scoped = { ...request, url: "http://127.0.0.1/api/files?view=summary", deltaScope: "b".repeat(40) };
  try {
    const first = await buildFilesResponseInWorker(scoped, runtimeFor(stateDir));
    const parent = JSON.parse(first.body);
    parent.parentOnly = "certified representation";
    const body = JSON.stringify(parent);
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    // This build updates the worker's persisted base but was never published
    // into the parent cache. The next delta must still start at the parent.
    await buildFilesResponseInWorker(scoped, runtimeFor(stateDir));
    const next = await buildFilesResponseInWorker(scoped, runtimeFor(stateDir), { body, etag });
    expect(next.delta?.base).toBe(etag);
    expect(applyFilesDelta(parent, JSON.parse(next.delta!.body))).toEqual(JSON.parse(next.body));
    expect(fs.readdirSync(path.join(stateDir, "files-response-results")).filter(name => !name.startsWith("delta-base-"))).toEqual([]);
  } finally { await stopTestWorker(); fs.rmSync(stateDir, { recursive: true, force: true }); }
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


test("the production worker persists only a completed operator summary", async () => {
  const stateDir = scratchState();
  try {
    const runtime = runtimeFor(stateDir);
    await buildFilesResponseInWorker(request, runtime);
    expect(await readSummaryBootstrap(stateDir)).toBeNull();
    const summary = { ...request, url: "http://127.0.0.1/api/files?view=summary" };
    await buildFilesResponseInWorker({ ...summary, headers: [["x-llv-spawn-capability", "fixture-agent"]] }, runtime);
    expect(await readSummaryBootstrap(stateDir)).toBeNull();
    const result = await buildFilesResponseInWorker(summary, runtime);
    const restored = await readSummaryBootstrap(stateDir);
    expect(restored?.etag).toBe(result.etag);
    expect(Buffer.from(restored!.body).toString()).toBe(result.body);
    const scoped = { ...summary, deltaScope: "f".repeat(40), boardEpoch: "bootstrap-viewer" };
    const encoded = await buildFilesResponseInWorker(scoped, runtime);
    expect(JSON.parse(encoded.body).boardProtocol).toBe(2);
    const savedV2 = await readSummaryBootstrap(stateDir);
    expect(savedV2?.etag).toBe(encoded.etag);
    expect(Buffer.from(savedV2!.body).toString()).toBe(encoded.body);
    const changed = structuredClone(scoped);
    changed.snapshot.projectCatalog = [{ project: "after-bootstrap", conversations: 0, smt: 1 }] as never;
    const next = await buildFilesResponseInWorker(changed, runtime, encoded);
    expect(next.delta?.base).toBe(encoded.etag);
    const { applyBoardDelta } = await import("@/lib/boardDelta");
    expect(applyBoardDelta(JSON.parse(encoded.body), JSON.parse(next.delta!.body))).toEqual(JSON.parse(next.body));
    expect((await readSummaryBootstrap(stateDir))?.etag).toBe(next.etag);
  } finally {
    await stopTestWorker();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});


test("seat agenda worker preserves asks and ordering from the exact board representation", async () => {
  const { seatAgendaInWorker } = await import("./filesResponseWorker");
  const { seatAgendaAsks } = await import("@/lib/attention/seatAgenda");
  const state = scratchState();
  const now = Date.parse("2026-10-18T12:00:00Z") / 1000;
  const lane = (id: string, project: string) => ({ id, task: id, project, state: "needs_decision", createdAt: "2026-10-18T10:00:00Z", stateDetail: "waiting", stages: [], runs: [], cursor: null, attentionRoute: { key: `lane:${id}:lane-decision:none`, owner: "seat", seat: "seat-fixture" } });
  const body = { files: [], pipelines: [lane("first", "project-a"), lane("foreign", "elsewhere"), lane("second", "project-a")] };
  try {
    expect(await seatAgendaInWorker(JSON.stringify(body), "project-a", now, runtimeFor(state)))
      .toEqual(seatAgendaAsks(body as never, now, "project-a"));
    expect((await seatAgendaInWorker(JSON.stringify(body), "project-a", now, runtimeFor(state))).map(row => row.id)).toEqual(["first", "second"]);
    await drainFilesResponseWorker("restart agenda reader");
    expect(await seatAgendaInWorker(JSON.stringify(body), "project-a", now, runtimeFor(state)))
      .toEqual(seatAgendaAsks(body as never, now, "project-a"));
    await expect(seatAgendaInWorker("{torn", "project-a", now, runtimeFor(state))).rejects.toThrow();
    expect(await seatAgendaInWorker(JSON.stringify({ files: [], pipelines: [] }), "project-a", now, runtimeFor(state))).toEqual([]);
  } finally { await stopTestWorker(); fs.rmSync(state, { recursive: true, force: true }); }
});


test("an expired seat source leaves a queued peer alone and never dispatches later", async () => {
  const { runSeatSourceInWorker } = await import("./filesResponseWorker");
  const state = scratchState();
  const program = path.join(state, "held-worker.ts");
  fs.writeFileSync(program, String.raw`
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const state = process.env.LLV_STATE_DIR!;
process.stdin.on("end", () => process.exit(0));
createInterface({ input: process.stdin }).on("line", async line => {
  const { id, request } = JSON.parse(line);
  if (request.type === "project") {
    fs.writeFileSync(path.join(state, "ready"), "ready");
    while (!fs.existsSync(path.join(state, "release"))) await new Promise(resolve => setTimeout(resolve, 2));
  } else fs.appendFileSync(path.join(state, "dispatches"), "one\n");
  const directory = path.join(state, "files-response-results"); fs.mkdirSync(directory, { recursive: true });
  const bodyFile = path.join(directory, id + ".json"); fs.writeFileSync(bodyFile, "[]");
  process.stdout.write(JSON.stringify({ id, ok: true, result: { bodyFile, contentType: "application/json", etag: "", timing: "" }, rssBytes: 1 }) + "\n");
});
`);
  const runtime = { ...runtimeFor(state), launch: { executable: process.execPath, workerPath: program } };
  const peer = buildFilesResponseInWorker(request, runtime);
  let peerFailure: unknown;
  void peer.catch(error => { peerFailure = error; });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(state, "ready"))) {
      if (peerFailure) throw peerFailure;
      if (Date.now() >= deadline) throw new Error("worker readiness was not observed");
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await expect(runSeatSourceInWorker({ type: "seat-reports", project: "fixture" }, { ...runtime, timeoutMs: 50 })).rejects.toThrow("deadline");
    expect(filesResponseWorkerPoolDiagnostics().pid).not.toBeNull();
    fs.writeFileSync(path.join(state, "release"), "release");
    expect((await peer).body).toBe("[]");
    expect((await runSeatSourceInWorker({ type: "seat-reports", project: "fixture" }, runtime)).body).toBe("[]");
    expect(fs.readFileSync(path.join(state, "dispatches"), "utf8")).toBe("one\n");
  } finally { await stopTestWorker(); await peer.catch(() => undefined); fs.rmSync(state, { recursive: true, force: true }); }
}, 15_000);


test("seat liveness uses the certified inventory generation and observes replacements across reads and restart", async () => {
  const { runSeatSourceInWorker } = await import("./filesResponseWorker");
  const state = scratchState(), snapshotFile = path.join(state, "inventory.json");
  const runtime = runtimeFor(state);
  const query = { project: "fixture", stallAfterMs: 60_000, limit: 1 };
  const publish = (generation: number, title: string) => fs.writeFileSync(snapshotFile, JSON.stringify({ epoch: "fixture-epoch", generation,
    snapshot: { complete: true, projectCatalog: [], files: [{ root: "claude-projects", name: "worker", path: path.join(state, "worker.jsonl"),
      project: "fixture", title, kind: "session", engine: "claude", fmt: "claude", parent: null, mtime: Date.now() / 1000, size: 0,
      activity: "live", proc: null, pid: null, model: null }] } }));
  const read = async (generation: number) => JSON.parse((await runSeatSourceInWorker({ type: "seat-liveness", query,
    scan: { snapshotFile, epoch: "fixture-epoch", generation } }, runtime)).body) as Array<{ title: string }>;
  try {
    publish(1, "First inventory");
    expect((await read(1)).map(row => row.title)).toEqual(["First inventory"]);
    publish(2, "Replacement inventory");
    await expect(read(1)).rejects.toThrow("inventory changed");
    expect((await read(2)).map(row => row.title)).toEqual(["Replacement inventory"]);
    fs.writeFileSync(snapshotFile, "{torn");
    await expect(read(2)).rejects.toThrow();
    publish(3, "Recovered inventory");
    await drainFilesResponseWorker("restart inventory reader");
    expect((await read(3)).map(row => row.title)).toEqual(["Recovered inventory"]);
  } finally { await stopTestWorker(); fs.rmSync(state, { recursive: true, force: true }); }
}, 15_000);
