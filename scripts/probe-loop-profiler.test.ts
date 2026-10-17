import { expect, test } from "bun:test";
import { probeLoopProfiler } from "./probe-loop-profiler";

test("pinned Bun samples local JS/native callers, clears them, and exposes the worker-target limitation", async () => {
  const result = await probeLoopProfiler();
  expect(result.local.js).toBe(true);
  expect(result.local.native).toBe(true);
  expect(result.local.samples).toBeGreaterThan(0);
  expect(result.local.stoppedAndCleared).toBe(true);
  expect(result.independent.requestedBeforeRecovery).toBe(true);
  expect(result.independent.completedBeforeRecovery).toBe(true);
  expect(result.independent.sampledMainControl).toBe(false);
  expect(result.gc.automaticCoverage).toBe("unknown");
  expect(result.producerCap.requested).toBe(1);
  expect(result.producerCap.observed).toBeGreaterThan(1);
}, 20_000);
