import { expect, test } from "bun:test";
import { probeLoopProfiler, probeJscLoopProfiler } from "./probe-loop-profiler";

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


test("JSC identifies a three-second main-thread block and exposes the delayed stop", async () => {
  const result = await probeJscLoopProfiler();
  expect(result.runtime).toBe("1.4.0");
  expect(result.target.function).toBe("syntheticThreeSecondBlock");
  expect(result.target.file).toBe("scripts/probe-loop-profiler.ts");
  expect(result.target.line).toBeGreaterThan(0);
  expect(result.target.totalSamples).toBeGreaterThan(1);
  expect(result.target.totalWeight).toBeGreaterThan(0);
  expect(result.target.selfSamples).toBeLessThanOrEqual(result.target.totalSamples);
  expect(result.requestedStopAfterMs).toBe(100);
  expect(result.actualStopAfterMs).toBeGreaterThanOrEqual(3000);
  expect(result.exceptionPropagated).toBe(true);
  expect(result.cleared).toBe(true);
  expect(result.profilerExports).toEqual(["profile", "samplingProfilerStackTraces", "startSamplingProfiler"]);
}, 20_000);
