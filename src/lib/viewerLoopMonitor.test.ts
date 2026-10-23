import { expect, spyOn, test } from "bun:test";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { performanceProcess, createPerformanceSpans } from "./performanceSpans";
import { createLoopHeapSignals } from "./loopHeapSignals";

test.each(["viewer", "runtime-host"])("the default %s loop sink quiets package diagnostics and retains service evidence", async role => {
  const previous = process.env.LLV_QUIET_DIAGNOSTICS;
  const previousOwner = process.env.LLV_STATE_OWNER;
  const lines: string[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation(((line: string, done: () => void) => {
    lines.push(String(line)); done(); return true;
  }) as typeof process.stderr.write);
  let at = 0;
  const monitor = createViewerLoopMonitor(undefined, () => at, createPerformanceSpans(() => at));
  const drain = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    process.env.LLV_QUIET_DIAGNOSTICS = "1";
    process.env.LLV_STATE_OWNER = role;
    at = 61_000; monitor.tick(); await drain();
    expect(lines).toHaveLength(0);
    delete process.env.LLV_QUIET_DIAGNOSTICS;
    at = 122_000; monitor.tick(); await drain();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length))).toMatchObject({ role, gapMs: 60_990 });
    expect(JSON.parse(lines[1]!.slice("[performance summary] ".length))).toMatchObject({ role });
  } finally {
    monitor.stop(); write.mockRestore();
    if (previousOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = previousOwner;
    if (previous === undefined) delete process.env.LLV_QUIET_DIAGNOSTICS;
    else process.env.LLV_QUIET_DIAGNOSTICS = previous;
  }
});

test("long gaps without a recorder always explain their profiling status", () => {
  let at = 0;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at));
  try {
    at = 2009; monitor.tick();
    at += 2009.6; monitor.tick();
    at += 2010; monitor.tick();
    at += 3010; monitor.tick();
    const gaps = lines.map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
    expect(gaps.map(gap => gap.gapMs)).toEqual([1999, 2000, 2000, 3000]);
    expect(gaps[0]).not.toHaveProperty("jsProfile");
    for (const gap of gaps.slice(1)) expect(gap.jsProfile).toEqual({ status: "not-armed", reason: "profiler-not-started" });
  } finally { monitor.stop(); }
});

test("every loop-gap carries memory signals; ordinary ticks advance the heap baseline", () => {
  let at = 0, heap = 1000;
  const lines: string[] = [];
  const signals = createLoopHeapSignals(() => heap, () => ({ unavailable: "gc-entry-unsupported" }), () => at);
  signals.start();
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at), signals);
  at = 250; heap = 2000; monitor.tick();
  expect(lines).toEqual([]);
  at = 1260; heap = 5000; monitor.tick(); // gap = exactly 1000
  at = 2271; heap = 1000; monitor.tick(); // gap = 1001
  expect(lines).toHaveLength(2);
  const reports = lines.map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
  expect(reports[0].heap.deltaBytes).toBe(3000);
  expect(reports[0].heap.beforeBytes).toBeUndefined();
  expect(reports[1].heap).toMatchObject({ deltaBytes: -4000, beforeBytes: 5000, afterBytes: 1000 });
  for (const report of reports) {
    expect(report.gc).toEqual({ source: "unavailable", count: null, ms: null, reason: "gc-entry-unsupported" });
    expect(report.heap.allocatedBytes).toBeNull();
    expect(report.heap.freedBytes).toBeNull();
    expect(report.attribution.unresolved).toBe("unknown-runtime-or-native");
  }
  monitor.stop();
});

test.each(["viewer", "runtime-host"])("%s gap and summary records name the serving child revision before activation", role => {
  const previous = { diagnostic: process.env.LLV_DIAGNOSTIC_REVISION, owner: process.env.LLV_STATE_OWNER };
  const oldRevision = performanceProcess.revision;
  let at = 0;
  const lines: string[] = [];
  try {
    process.env.LLV_STATE_OWNER = role;
    process.env.LLV_DIAGNOSTIC_REVISION = "1234567890abcdef1234567890abcdef12345678";
    performanceProcess.revision = null;
    const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at));
    at = 61_000; monitor.tick(); monitor.stop();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("[viewer loop-gap] ")).toBe(true);
    expect(lines[1]!.startsWith("[performance summary] ")).toBe(true);
    for (const line of lines) expect(JSON.parse(line.slice(line.indexOf("] ") + 2))).toMatchObject({
      revision: process.env.LLV_DIAGNOSTIC_REVISION,
      role,
    });
  } finally {
    performanceProcess.revision = oldRevision;
    for (const [key, value] of [["LLV_DIAGNOSTIC_REVISION", previous.diagnostic], ["LLV_STATE_OWNER", previous.owner]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test.each(["viewer", "runtime-host"])("%s gap identity prefers the serving child over ambient state authority", role => {
  const prior = { owner: process.env.LLV_STATE_OWNER, diagnostic: process.env.LLV_DIAGNOSTIC_REVISION,
    authority: process.env.LLV_HOT_STATE_RELEASE_REVISION, revision: performanceProcess.revision };
  let at = 0;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at));
  try {
    process.env.LLV_STATE_OWNER = role;
    performanceProcess.revision = null;
    process.env.LLV_DIAGNOSTIC_REVISION = "b".repeat(40);
    process.env.LLV_HOT_STATE_RELEASE_REVISION = "a".repeat(40);
    at = 1000; monitor.tick();
    expect(JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length))).toMatchObject({ revision: "b".repeat(40), role });
    process.env.LLV_DIAGNOSTIC_REVISION = "invalid";
    at = 2000; monitor.tick();
    expect(JSON.parse(lines[1]!.slice("[viewer loop-gap] ".length)).revision).toBe("a".repeat(40));
    performanceProcess.revision = "c".repeat(40);
    at = 3000; monitor.tick();
    expect(JSON.parse(lines[2]!.slice("[viewer loop-gap] ".length)).revision).toBe("c".repeat(40));
    performanceProcess.revision = null;
    delete process.env.LLV_HOT_STATE_RELEASE_REVISION;
    at = 4000; monitor.tick();
    expect(JSON.parse(lines[3]!.slice("[viewer loop-gap] ".length)).revision).toBeNull();
  } finally {
    monitor.stop(); performanceProcess.revision = prior.revision;
    for (const [key, value] of [["LLV_STATE_OWNER", prior.owner], ["LLV_DIAGNOSTIC_REVISION", prior.diagnostic],
      ["LLV_HOT_STATE_RELEASE_REVISION", prior.authority]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});


test.each(["viewer", "runtime-host"])("%s uses its own gap threshold", role => {
  const owner = process.env.LLV_STATE_OWNER;
  let at = 0;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at));
  try {
    process.env.LLV_STATE_OWNER = role;
    at = 260; monitor.tick(); // exactly 250 ms is inside the host bound
    expect(lines).toEqual([]);
    at += 261; monitor.tick();
    expect(lines.length).toBe(role === "runtime-host" ? 1 : 0);
  } finally {
    monitor.stop();
    if (owner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = owner;
  }
});
