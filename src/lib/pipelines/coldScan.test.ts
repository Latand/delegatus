import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";

import { POST } from "@/app/api/pipelines/tick/route";
import { statePath } from "@/lib/configDir";
import { resetFilesRouteCacheForTests, setFileCatalogMembershipProbeForTests, setFileScanRunnerForTests } from "@/lib/scanner/scanCache";
import { controllerFileScan, FlowPipelineController } from "./controller";

afterEach(() => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(null);
  setFileCatalogMembershipProbeForTests(null);
  fs.rmSync(statePath("files-scan-snapshot.json"), { force: true });
});

function request(): NextRequest {
  return new NextRequest("http://localhost/api/pipelines/tick", {
    method: "POST", headers: { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin" },
  });
}

test("a tick answers 200 and advances pipelines while the shared cold scan is held", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let scans = 0;
  setFileScanRunnerForTests(async () => {
    scans += 1;
    await held;
    return { files: [], projectCatalog: [], complete: true };
  });
  let pipelines = 0;
  let flows = 0;
  const messages: string[] = [];
  const controller = new FlowPipelineController({
    scan: controllerFileScan,
    tickPipelines: async () => { pipelines += 1; return { changed: false }; },
    tickFlows: async () => { flows += 1; return { changed: false }; },
    log: (message) => { messages.push(message); },
  }, { maxPasses: 1 });
  const pending = POST.withDependencies(request(), () => controller.tick());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    pending,
    new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 250); }),
  ]);
  clearTimeout(timeout);
  const flowsBeforeRelease = flows;
  release();
  await pending;
  expect(early?.status).toBe(200);
  expect(pipelines).toBe(1);
  expect(flowsBeforeRelease).toBe(0);
  expect(messages.some((message) => message.includes("skipped") && message.includes("scanning"))).toBe(true);
  // The detached generation must finish and become usable on the next tick.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await controller.tick();
  expect(flows).toBe(1);
  expect(scans).toBe(1);
});

test("incomplete derivation is deferred and a later complete generation resumes flows", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  let complete = false;
  let scans = 0;
  setFileScanRunnerForTests(async () => {
    scans += 1;
    return { files: [], projectCatalog: [], complete };
  });
  let flows = 0;
  const controller = new FlowPipelineController({
    scan: controllerFileScan,
    tickPipelines: async () => ({ changed: false }),
    tickFlows: async () => { flows += 1; return { changed: false }; },
    log: () => {},
  }, { maxPasses: 1 });
  expect((await POST.withDependencies(request(), () => controller.tick())).status).toBe(200);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(flows).toBe(0);
  complete = true;
  await controller.tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await controller.tick();
  expect(flows).toBe(1);
  expect(scans).toBe(2);
});

test("a failed scan unrelated to incomplete derivation remains a controller failure", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => null);
  setFileScanRunnerForTests(async () => { throw new Error("fixture scanner unavailable"); });
  await controllerFileScan();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await expect(controllerFileScan()).rejects.toThrow("fixture scanner unavailable");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
});
