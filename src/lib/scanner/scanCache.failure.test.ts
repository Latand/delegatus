import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/pipelines/tick/route";
import { controllerFileScan, FlowPipelineController } from "@/lib/pipelines/controller";
import { statePath } from "@/lib/configDir";
import {
  completedFileScan,
  resetFilesRouteCacheForTests,
  setFileCatalogMembershipProbeForTests,
  setFileScanRunnerForTests,
} from "./scanCache";

afterEach(() => {
  setFileScanRunnerForTests(null);
  setFileCatalogMembershipProbeForTests(null);
  resetFilesRouteCacheForTests();
});

test("a retained scan failure reports its age and generation, paces retries and recovers through the tick route", async () => {
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
    const refused = await tick();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ ok: false });
    expect(sweeps).toEqual(["forge", "merge", "notice"]);
    expect(flows).toBe(0);
    expect(errors[0]).toMatchObject({ generation: 1, failedAt: 100_000, ageMs: 2_000, cause: failure });
    expect(scans).toBe(1);

    now += 3_000;
    expect((await tick()).status).toBe(503);
    await ready.promise;
    expect(scans).toBe(2);
    // More wakes while the replacement is held cannot start another scan.
    expect((await tick()).status).toBe(503);
    expect(scans).toBe(2);
    expect(errors.at(-1)).toMatchObject({ generation: 1, ageMs: 5_000, refreshingGeneration: 2 });
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
