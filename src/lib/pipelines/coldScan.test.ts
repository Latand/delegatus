import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";

import { POST } from "@/app/api/pipelines/tick/route";
import { statePath } from "@/lib/configDir";
import { completedFileScan, fileScanCacheStatus, resetFilesRouteCacheForTests, setFileCatalogMembershipProbeForTests, setFileScanRunnerForTests } from "@/lib/scanner/scanCache";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools } from "@/lib/mcp/bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "@/lib/mcp/server";
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

test("a failed cold generation defers the controller while retaining its diagnostic", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => null);
  setFileScanRunnerForTests(async () => { throw new Error("fixture scanner unavailable"); });
  await expect(completedFileScan()).rejects.toThrow("fixture scanner unavailable");
  expect(await controllerFileScan()).toEqual({ files: [], complete: false });
  await expect(completedFileScan({ wait: false })).rejects.toThrow("fixture scanner unavailable");
});

test("a cancelled cold-scan reader does not poison ticks or retryable MCP admission during replacement", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  let scans = 0;
  let releaseReplacement!: () => void;
  const replacement = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  setFileScanRunnerForTests(async (_roots, _options, signal) => {
    scans += 1;
    if (scans === 1) {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } else if (scans === 2) {
      await replacement;
    }
    return { files: [], projectCatalog: [], complete: true };
  });

  const reader = new AbortController();
  const cancelledRead = completedFileScan({ signal: reader.signal });
  for (let attempt = 0; attempt < 100 && scans === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(scans).toBe(1);
  reader.abort();
  await expect(cancelledRead).rejects.toMatchObject({ name: "AbortError" });
  for (let attempt = 0; attempt < 100 && fileScanCacheStatus().inFlight; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(fileScanCacheStatus().inFlight).toBe(false);

  const messages: string[] = [];
  let pipelines = 0;
  let flows = 0;
  const controller = new FlowPipelineController({
    scan: controllerFileScan,
    tickPipelines: async () => { pipelines += 1; return { changed: false }; },
    tickFlows: async () => { flows += 1; return { changed: false }; },
    log: (message) => { messages.push(message); },
  }, { maxPasses: 1 });
  const firstTick = await POST.withDependencies(request(), () => controller.tick());
  const secondTick = await POST.withDependencies(request(), () => controller.tick("watchdog"));
  expect(firstTick.status).toBe(200);
  expect(secondTick.status).toBe(200);
  expect(pipelines).toBe(2);
  expect(flows).toBe(0);
  expect(messages.some((message) => message.includes("scan phase failed"))).toBe(false);
  expect(fileScanCacheStatus().inFlight).toBe(true);

  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, productionDomainDependencies), new MemoryMcpReceiptStore(), undefined, {
    recovery: viewerMcpRecoverableTools(productionDomainDependencies),
  });
  const args = { project: "unknown-project", clientRequestId: "cancelled-cold-create" };
  const retryable = await service.callTool("create_orchestrator", args);
  expect(retryable).toMatchObject({
    ok: false,
    code: "scan_incomplete",
    retryable: true,
    details: { retryAfterSeconds: 5, nextAction: "retry-same-key", resend: "safe" },
  });
  expect("error" in retryable && retryable.error).toContain("still scanning, retry in 5 s");

  releaseReplacement();
  for (let attempt = 0; attempt < 100 && fileScanCacheStatus().inFlight; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(fileScanCacheStatus().inFlight).toBe(false);
  expect(await service.callTool("create_orchestrator", args)).toMatchObject({
    ok: false,
    code: "unknown_project",
    retryable: false,
  });
  await controller.tick("watchdog");
  expect(flows).toBe(1);
  expect(scans).toBe(2);
});
