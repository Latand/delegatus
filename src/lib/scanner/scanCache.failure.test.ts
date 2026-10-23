import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/pipelines/tick/route";
import { controllerFileScan, FlowPipelineController } from "@/lib/pipelines/controller";
import { statePath } from "@/lib/configDir";
import {
  completedFileScan,
  type FileScanSnapshot,
  resetFilesRouteCacheForTests,
  setFileCatalogMembershipProbeForTests,
  setFileScanRunnerForTests,
} from "./scanCache";

afterEach(() => {
  setFileScanRunnerForTests(null);
  setFileCatalogMembershipProbeForTests(null);
  resetFilesRouteCacheForTests();
});

test("a failed membership generation keeps an owned copy of the last good inventory and recovers", async () => {
  fs.mkdirSync(statePath(), { recursive: true });
  const directory = fs.mkdtempSync(path.join(statePath(), "scan-retained-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  resetFilesRouteCacheForTests();
  let now = 100_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let membership = "first", scans = 0;
  const failure = new Error("fixture membership scan refused");
  const replacement = Promise.withResolvers<FileScanSnapshot>();
  const started = Promise.withResolvers<void>();
  const row = { path: "/sessions/retained.jsonl", root: "codex-sessions", name: "retained.jsonl",
    project: "repo-fixture", title: "Retained", firstPrompt: "", engine: "codex", kind: "session",
    fmt: "codex", mtime: 1, size: 1, parent: null, activity: "idle", proc: null,
    pid: null, model: null, pendingQuestion: null, waitingInput: null } as const;
  setFileCatalogMembershipProbeForTests(async () => membership);
  setFileScanRunnerForTests(async () => {
    scans++;
    if (scans === 1) return { files: [{ ...row }], projectCatalog: [], complete: true };
    if (scans === 2) throw failure;
    started.resolve();
    return replacement.promise;
  });
  try {
    await completedFileScan();
    membership = "second";
    now += 10_000;
    await expect(completedFileScan()).rejects.toBe(failure);
    now += 10_000;
    const retained = await controllerFileScan();
    expect(retained).toMatchObject({ complete: true, files: [{ title: "Retained" }] });
    retained.files[0]!.title = "Caller edit";
    await started.promise;
    expect(await controllerFileScan()).toMatchObject({ complete: true, files: [{ title: "Retained" }] });
    expect(scans).toBe(3);
    const completed = completedFileScan();
    replacement.resolve({ files: [{ ...row, title: "Recovered" }], projectCatalog: [], complete: true });
    await completed;
    expect(await controllerFileScan()).toMatchObject({ complete: true, files: [{ title: "Recovered" }] });
  } finally {
    replacement.resolve({ files: [], projectCatalog: [], complete: true });
    await completedFileScan({ revalidate: false }).catch(() => {});
    clock.mockRestore();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a retained scan failure stays diagnostic while controller ticks succeed and retry", async () => {
  fs.mkdirSync(statePath(), { recursive: true });
  const directory = fs.mkdtempSync(path.join(statePath(), "scan-failure-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  resetFilesRouteCacheForTests();
  const failure = new Error("fixture scanner initialization refused");
  let now = 100_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let scans = 0;
  let release!: () => void;
  const ready = Promise.withResolvers<void>();
  const success = new Promise<{ files: []; projectCatalog: []; complete: true }>((resolve) => {
    release = () => resolve({ files: [], projectCatalog: [], complete: true });
  });
  setFileCatalogMembershipProbeForTests(async () => null);
  setFileScanRunnerForTests(async () => {
    if (++scans === 1) throw failure;
    ready.resolve();
    return success;
  });
  const sweeps: string[] = [];
  let flows = 0;
  const errors: unknown[] = [];
  const controller = new FlowPipelineController({
    now: () => now,
    scan: controllerFileScan,
    tickPipelines: async () => ({ changed: false }),
    tickFlows: async () => { flows++; return { changed: false }; },
    sweepForgeLinks: () => { sweeps.push("forge"); },
    sweepAutoMerge: () => { sweeps.push("merge"); },
    sweepSpawnNotices: () => { sweeps.push("notice"); },
    log: (_, error) => { if (error) errors.push(error); },
  }, { maxPasses: 2 });
  const tick = () => POST.withDependencies(new NextRequest("http://127.0.0.1:19000/api/pipelines/tick", {
    method: "POST", headers: { origin: "http://127.0.0.1:19000", host: "127.0.0.1:19000" },
  }), () => controller.tick());
  try {
    await expect(completedFileScan()).rejects.toBe(failure);
    now += 2_000;
    const deferred = await tick();
    expect(deferred.status).toBe(200);
    expect(await deferred.json()).toEqual({ ok: true });
    expect(sweeps).toEqual(["forge", "merge", "notice"]);
    expect(flows).toBe(0);
    await expect(completedFileScan({ wait: false })).rejects.toMatchObject({
      generation: 1, failedAt: 100_000, ageMs: 2_000, cause: failure,
    });
    expect(errors).toEqual([]);
    expect(scans).toBe(1);

    now += 3_000;
    expect((await tick()).status).toBe(200);
    await ready.promise;
    expect(scans).toBe(2);
    // More wakes while the replacement is held cannot start another scan.
    expect((await tick()).status).toBe(200);
    expect(scans).toBe(2);
    await expect(completedFileScan({ wait: false })).rejects.toMatchObject({
      generation: 1, ageMs: 5_000, refreshingGeneration: 2,
    });
    expect(errors).toEqual([]);
    const completed = completedFileScan();
    release();
    await completed;
    expect((await tick()).status).toBe(200);
    expect(flows).toBe(0);
    expect(scans).toBe(2);
    expect(sweeps).toHaveLength(12);
  } finally {
    release();
    await completedFileScan({ revalidate: false }).catch(() => {});
    clock.mockRestore();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
