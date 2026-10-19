/** Run only in an isolated export, through gate-slot.sh. See docs/perf/loop-gap-heap.md. */
import { createHash } from "node:crypto";
import { LOOP_HEAP_SAMPLE_INTERVAL_MS } from "../src/lib/loopHeapSignals";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

const args = process.argv.slice(2);
function resourceLimits() {
  if (process.platform !== "linux") return [];
  const result = [];
  let directory = "/sys/fs/cgroup" + readFileSync("/proc/self/cgroup", "utf8").split("0::")[1]!.trim();
  while (directory.startsWith("/sys/fs/cgroup")) {
    const read = (file: string) => { try { return readFileSync(`${directory}/${file}`, "utf8").trim(); } catch { return null; } };
    result.push({ level: result.length, cpuMax: read("cpu.max"), memoryMax: read("memory.max"),
      throttledUs: Number(/throttled_usec (\d+)/.exec(read("cpu.stat") ?? "")?.[1] ?? 0) });
    if (directory === "/sys/fs/cgroup") break;
    directory = dirname(directory);
  }
  return result;
}
const cpuMs = (cpu: NodeJS.CpuUsage) => (cpu.user + cpu.system) / 1000;
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
if (args[0] === "--probe") {
  const jsc = await import("bun:jsc");
  const observed: Array<{ startTime: number; duration: number }> = [];
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) observed.push({ startTime: entry.startTime, duration: entry.duration });
  });
  // Probe even when the advertised list excludes gc: observe() can silently accept it.
  observer.observe({ entryTypes: ["gc"] });
  let held: unknown;
  const readings: unknown[] = [];
  const read = (phase: string) => {
    const stats = getHeapStatistics() as ReturnType<typeof getHeapStatistics> & { total_allocated_bytes?: number };
    readings.push({ phase, heapUsed: process.memoryUsage().heapUsed, heapSize: jsc.heapSize(),
      allocatedCounter: stats.total_allocated_bytes });
  };
  read("before");
  held = Array.from({ length: 500_000 }, (_, i) => ({ i, value: `value-${i}` }));
  read("allocated");
  Bun.gc(true); read("held-gc");
  held = undefined;
  for (let i = 0; i < 5; i++) Bun.gc(true);
  read("released-gc");
  await Bun.sleep(100);
  observed.push(...observer.takeRecords().map(({ startTime, duration }) => ({ startTime, duration })));
  observer.disconnect();
  const costs = [];
  for (const size of [10_000, 500_000]) {
    held = Array.from({ length: size }, (_, i) => ({ i, value: `value-${i}` })); Bun.gc(true);
    for (const [name, sample] of [["process.memoryUsage", () => process.memoryUsage()], ["bun:jsc.heapSize", jsc.heapSize],
      ["node:v8.getHeapStatistics", getHeapStatistics], ["bun:jsc.heapStats", jsc.heapStats]] as const) {
      const count = name === "process.memoryUsage" || name === "bun:jsc.heapSize" ? 10_000 : 20;
      const cpu = process.cpuUsage(), start = performance.now();
      for (let i = 0; i < count; i++) sample();
      costs.push({ size, name, calls: count, wallMs: performance.now() - start, cpuMs: cpuMs(process.cpuUsage(cpu)) });
    }
  }
  console.log(JSON.stringify({ runtime: Bun.version, bunRevision: Bun.revision, utc: new Date().toISOString(),
    jscExports: Object.keys(jsc).sort(), heapStatsKeys: Object.keys(jsc.heapStats()).sort(),
    supportedEntryTypes: PerformanceObserver.supportedEntryTypes, forcedCollections: 6, observedGc: observed, readings, costs,
    held: Array.isArray(held) ? held.length : 0 }));
} else if (args[0] === "--blocks") {
  const [, baseline, candidate = "src/lib/viewerLoopMonitor.ts", countArg = "300", framesArg = "10"] = args;
  const count = Number(countArg), frames = Number(framesArg);
  if (!baseline || !Number.isInteger(count) || count < 100 || !Number.isInteger(frames) || frames < 5 || frames > 20) {
    throw Error("Blocks require a baseline, at least 100 pairs and 5..20 frames per block");
  }
  if (PerformanceObserver.supportedEntryTypes.includes("gc")) throw Error("Use --paired when GC observation is available");
  const modules = [await import(resolve(baseline)), await import(resolve(candidate))];
  const { createPerformanceSpans } = await import("../src/lib/performanceSpans");
  const { createLoopHeapSignals } = await import("../src/lib/loopHeapSignals");
  const { startLoopWatchdog } = await import("../src/lib/loopWatchdog");
  const heap = createLoopHeapSignals(); heap.start();
  const meters = [0, 1].map(() => ({ ticks: 0, gaps: 0, logBytes: 0 }));
  const spans = [createPerformanceSpans(), createPerformanceSpans()];
  const monitors = modules.map((module, i) => module.createViewerLoopMonitor((line: string) => {
    meters[i]!.gaps += Number(line.startsWith("[viewer loop-gap]")); meters[i]!.logBytes += line.length;
  }, () => performance.now(), spans[i], i === 1 ? heap : undefined));
  const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i, state: "ready", value: `item-${i}` }));
  let active = 0, checksum = 0;
  const work = () => monitors[active].run("files.get", () => spans[active]!.sync("files.encode", () => {
    for (let i = 0; i < 3; i++) {
      const parsed = JSON.parse(JSON.stringify(rows));
      checksum += parsed.length + parsed[parsed.length - 1].id;
    }
  }));
  for (active = 0; active < 2; active++) {
    for (let i = 0; i < 100; i++) work();
    for (let i = 0; i < 10000; i++) monitors[active].tick();
  }
  active = 0;
  const watchdog = startLoopWatchdog();
  for (const recorder of spans) recorder.observeSite(watchdog.site);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => { meters[active]!.ticks++; monitors[active].tick(); timer = setTimeout(poll, 10); };
  const measurements: Array<Record<string, unknown>> = [];
  const resources = [];
  const affinity = process.platform === "linux" ? /Cpus_allowed_list:\s*(.*)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? null : null;
  try {
    const readyBy = performance.now() + 5000;
    while (!watchdog.snapshot().available && performance.now() < readyBy) await Bun.sleep(20);
    if (!watchdog.snapshot().available) throw Error("Common watchdog did not start");
    poll();
    for (const mode of ["idle", "load"]) {
      const before = resourceLimits();
      for (let run = 1; run <= count; run++) {
        for (const index of run % 2 === 1 ? [0, 1] : [1, 0]) {
          active = index; checksum = 0;
          const meter = { ...meters[index]! };
          const cpu = process.cpuUsage(), start = performance.now();
          for (let frame = 0; frame < frames; frame++) {
            if (mode === "load") work();
            if (mode === "load" && frame === 0 && (run === Math.floor(count / 3) || run === Math.floor(count * 2 / 3))) {
              const until = performance.now() + (run === Math.floor(count / 3) ? 550 : 1100);
              while (performance.now() < until) { /* matched stall in each arm */ }
            }
            await Bun.sleep(Math.max(0, start + (frame + 1) * 20 - performance.now()));
          }
          const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu), usedCpuMs = cpuMs(used);
          measurements.push({ mode, run, variant: index === 0 ? "baseline" : "candidate", batches: frames,
            checksum, elapsedMs, cpuMs: usedCpuMs, cpuPercent: usedCpuMs / elapsedMs * 100,
            userMs: used.user / 1000, systemMs: used.system / 1000, affinity,
            ticks: meters[index]!.ticks - meter.ticks, gaps: meters[index]!.gaps - meter.gaps,
            logBytes: meters[index]!.logBytes - meter.logBytes });
        }
        if (run % 25 === 0) process.stderr.write(`${mode}: ${run}/${count} block pairs complete\n`);
      }
      resources.push({ mode, before, after: resourceLimits() });
    }
  } finally {
    if (timer) clearTimeout(timer);
    for (const monitor of monitors) monitor.stop();
    heap.stop(); await watchdog.stop();
  }
  const pairs = ["idle", "load"].flatMap(mode => Array.from({ length: count }, (_, i) => {
    const base = measurements.find(row => row.mode === mode && row.run === i + 1 && row.variant === "baseline")!;
    const next = measurements.find(row => row.mode === mode && row.run === i + 1 && row.variant === "candidate")!;
    return { mode, run: i + 1, addedCpuPercentPoints: Number(next.cpuPercent) - Number(base.cpuPercent),
      relativeCpuPercent: (Number(next.cpuMs) / Number(base.cpuMs) - 1) * 100,
      sameWork: base.checksum === next.checksum && base.batches === next.batches && base.affinity === next.affinity };
  }));
  const summary = ["idle", "load"].map(mode => {
    const values = pairs.filter(row => row.mode === mode).map(row => row.addedCpuPercentPoints);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
    return { mode, pairs: values.length, mean, standardDeviation: deviation,
      upper95: mean + 2.2 * deviation / Math.sqrt(values.length), min: Math.min(...values), max: Math.max(...values) };
  });
  console.log(JSON.stringify({ utc: new Date().toISOString(), runtime: Bun.version, bunRevision: Bun.revision,
    sourceHashes: { baseline: hash(baseline), candidate: hash(candidate), sampler: hash("src/lib/loopHeapSignals.ts"),
      benchmark: hash(import.meta.path), spans: hash("src/lib/performanceSpans.ts"), watchdog: hash("src/lib/loopWatchdog.ts") },
    conditions: { protocol: "short-blocks-with-one-resident-watchdog", blockTargetMs: frames * 20,
      intervalMs: 10, heapReadCadenceMs: LOOP_HEAP_SAMPLE_INTERVAL_MS, loadPeriodMs: 20, rows: 10000, serializationsPerBatch: 3,
      stallMs: [550,1100], stallCountPerArm: 2, warmupBatchesPerVariant: 100, warmupManualTicksPerVariant: 10000,
      confidence: "paired mean plus 2.2 standard errors; conservative 95% t bound for >=100 pairs",
      cpuMetric: "whole-process user+system CPU in each block; 100% is one core",
      watchdog: "one common resident worker; actual monitor tick from a matching self-scheduled timer; unchanged scheduler-history serialization absent in both arms" },
    measurements, pairs, summary, resources,
    passed: pairs.every(row => row.sameWork) && summary.every(row => row.upper95 < 1) }, null, 2));
} else if (args[0] === "--paired") {
  const [, baseline, candidate = "src/lib/viewerLoopMonitor.ts", repetitionsArg = "15", batchesArg = "500"] = args;
  const repetitions = Number(repetitionsArg), phaseBatches = Number(batchesArg);
  if (!baseline || !Number.isInteger(repetitions) || repetitions < 15 || !Number.isInteger(phaseBatches) || phaseBatches < 400) {
    throw Error("Paired mode requires a baseline, at least 15 pairs and at least 400 batches");
  }
  const modules = [await import(resolve(baseline)), await import(resolve(candidate))];
  const { createPerformanceSpans } = await import("../src/lib/performanceSpans");
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: i, state: "ready", value: `item-${i}` }));
  const measurements: Array<Record<string, unknown>> = [];
  const runPhase = async (variant: "baseline" | "candidate", mode: string, run: number, warm = false) => {
    const index = variant === "baseline" ? 0 : 1;
    const spans = createPerformanceSpans();
    let gaps = 0, logBytes = 0, checksum = 0;
    const monitor = modules[index].createViewerLoopMonitor((line: string) => {
      gaps += Number(line.startsWith("[viewer loop-gap]")); logBytes += line.length;
    }, () => performance.now(), spans);
    const work = () => monitor.run("files.get", () => spans.sync("files.encode", () => {
      for (let i = 0; i < 3; i++) {
        const parsed = JSON.parse(JSON.stringify(rows));
        checksum += parsed.length + parsed[parsed.length - 1].id;
      }
    }));
    if (warm) {
      for (let i = 0; i < 100; i++) work();
      for (let i = 0; i < 10000; i++) monitor.tick();
      monitor.stop();
      return;
    }
    monitor.start();
    try {
      for (let i = 0; i < 20; i++) work();
      await Bun.sleep(1000);
      gaps = logBytes = checksum = 0;
      const limitsBefore = resourceLimits();
      const affinity = process.platform === "linux" ? /Cpus_allowed_list:\s*(.*)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? null : null;
      const cpu = process.cpuUsage(), start = performance.now(), batches = Number(batchesArg);
      for (let i = 0; i < batches; i++) {
        if (mode === "load") work();
        if (mode === "load" && (i === 100 || i === 300)) {
          const until = performance.now() + 550;
          while (performance.now() < until) { /* identical synthetic stalls */ }
        }
        await Bun.sleep(Math.max(0, start + (i + 1) * 20 - performance.now()));
      }
      await Bun.sleep(30);
      const elapsedMs = performance.now() - start, usedCpu = process.cpuUsage(cpu), usedCpuMs = cpuMs(usedCpu);
      const row = { run, variant, mode, batches, checksum, elapsedMs, cpuMs: usedCpuMs,
        affinity, cpuPercent: usedCpuMs / elapsedMs * 100, userMs: usedCpu.user / 1000, systemMs: usedCpu.system / 1000,
        gaps, logBytes, limitsBefore, limitsAfter: resourceLimits() };
      measurements.push(row);
      process.stderr.write(`${mode}/${variant}/${run}: ${usedCpuMs} ms CPU, ${gaps} gaps\n`);
    } finally { monitor.stop(); await Bun.sleep(100); }
  };
  await runPhase("baseline", "load", 0, true);
  await runPhase("candidate", "load", 0, true);
  for (const mode of ["idle", "load"]) {
    for (let i = 0; i < Number(repetitionsArg); i++) {
      for (const variant of i % 2 === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const) {
        await runPhase(variant, mode, i + 1);
      }
    }
  }
  const pairs = ["idle", "load"].flatMap(mode => Array.from({ length: Number(repetitionsArg) }, (_, i) => {
    const base = measurements.find(row => row.mode === mode && row.run === i + 1 && row.variant === "baseline")!;
    const next = measurements.find(row => row.mode === mode && row.run === i + 1 && row.variant === "candidate")!;
    return { mode, run: i + 1, addedCpuPercentPoints: Number(next.cpuPercent) - Number(base.cpuPercent),
      relativeCpuPercent: (Number(next.cpuMs) / Number(base.cpuMs) - 1) * 100,
      sameWork: base.checksum === next.checksum && base.batches === next.batches && base.affinity === next.affinity };
  }));
  const summary = ["idle", "load"].map(mode => {
    const values = pairs.filter(row => row.mode === mode).map(row => row.addedCpuPercentPoints);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
    // Conservative two-sided t critical value for n >= 15 (df >= 14).
    return { mode, pairs: values.length, mean, standardDeviation: deviation,
      upper95: mean + 2.2 * deviation / Math.sqrt(values.length), min: Math.min(...values), max: Math.max(...values) };
  });
  console.log(JSON.stringify({ utc: new Date().toISOString(), runtime: Bun.version, bunRevision: Bun.revision,
    sourceHashes: { baseline: hash(baseline), candidate: hash(candidate), sampler: hash("src/lib/loopHeapSignals.ts"),
      benchmark: hash(import.meta.path), spans: hash("src/lib/performanceSpans.ts"), watchdog: hash("src/lib/loopWatchdog.ts") },
    conditions: { protocol: "alternating-phases-in-one-vm", intervalMs: 10, heapReadCadenceMs: LOOP_HEAP_SAMPLE_INTERVAL_MS,
      loadPeriodMs: 20, rows: 10000, serializationsPerBatch: 3, stallCount: 2, stallMs: 550,
      warmupBatchesPerVariant: 100, warmupManualTicksPerVariant: 10000, warmupBatchesPerPhase: 20, warmupWaitMs: 1000,
      stopWaitMs: 100, confidence: "paired mean plus 2.2 standard errors; conservative 95% bound for >=15 pairs",
      cpuMetric: "process.cpuUsage user+system, including watchdog and GC helper threads; 100% is one core" },
    measurements, pairs, summary, passed: pairs.every(row => row.sameWork) && summary.every(row => row.upper95 < 1) }, null, 2));
} else if (args[0] === "--child") {
  const [, modulePath, mode, batchesArg, baselinePath = modulePath, candidatePath = modulePath] = args;
  const batches = Number(batchesArg);
  // Match the VM's code/shape population before choosing the active monitor.
  const modules = [await import(resolve(baselinePath!)), await import(resolve(candidatePath!))];
  const { createPerformanceSpans } = await import("../src/lib/performanceSpans");
  let gaps = 0, logBytes = 0, checksum = 0;
  const recorders = modules.map(() => createPerformanceSpans());
  const monitors = modules.map((module, i) => module.createViewerLoopMonitor((line: string) => {
    gaps += Number(line.startsWith("[viewer loop-gap]")); logBytes += line.length;
  }, () => performance.now(), recorders[i]));
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: i, state: "ready", value: `item-${i}` }));
  const workFor = (index: number) => monitors[index].run("files.get", () => recorders[index]!.sync("files.encode", () => {
    for (let j = 0; j < 3; j++) {
      const encoded = JSON.stringify(rows);
      const parsed = JSON.parse(encoded);
      checksum += parsed.length + parsed[parsed.length - 1].id;
    }
  }));
  for (let i = 0; i < 100; i++) { workFor(0); workFor(1); }
  for (let i = 0; i < 10_000; i++) { monitors[0].tick(); monitors[1].tick(); }
  for (const monitor of monitors) monitor.stop();
  const selected = resolve(modulePath!) === resolve(baselinePath!) ? 0 : 1;
  const monitor = monitors[selected];
  const work = () => workFor(selected);
  monitor.start();
  await Bun.sleep(1000);
  gaps = logBytes = checksum = 0;
  const limitsBefore = resourceLimits();
  const affinity = process.platform === "linux" ? /Cpus_allowed_list:\s*(.*)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? null : null;
  const cpu = process.cpuUsage(), start = performance.now();
  try {
    for (let i = 0; i < batches; i++) {
      if (mode === "load") work();
      // Two identical stalls exercise JSON log construction as well as the cheap poll.
      if (mode === "load" && (i === 100 || i === 300)) {
        const until = performance.now() + 550;
        while (performance.now() < until) { /* owned synthetic stall */ }
      }
      await Bun.sleep(Math.max(0, start + (i + 1) * 20 - performance.now()));
    }
    await Bun.sleep(30);
    const elapsedMs = performance.now() - start, usedCpu = process.cpuUsage(cpu), usedCpuMs = cpuMs(usedCpu);
    console.log(JSON.stringify({ mode, batches, checksum, elapsedMs, cpuMs: usedCpuMs, selected,
      affinity, cpuPercent: usedCpuMs / elapsedMs * 100, userMs: usedCpu.user / 1000, systemMs: usedCpu.system / 1000, gaps, logBytes, limitsBefore, limitsAfter: resourceLimits() }));
  } finally { monitor.stop(); }
} else {
  const [baseline, candidate = "src/lib/viewerLoopMonitor.ts", repetitionsArg = "3", batchesArg = "1000", controlArg] = args;
  if (!baseline) throw Error("Usage: benchmark-loop-heap.ts <baseline module> [candidate module] [repetitions] [batches]");
  const measurements: Array<Record<string, unknown>> = [];
  for (const mode of ["idle", "load"]) {
    for (let run = 0; run < Number(repetitionsArg); run++) {
      for (const variant of run % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        const child = Bun.spawn([process.execPath, import.meta.path, "--child", (variant === "baseline" || controlArg === "--control") ? baseline : candidate, mode, batchesArg, baseline, candidate],
          { env: process.env, stdout: "pipe", stderr: "inherit" });
        const output = await new Response(child.stdout).text();
        if (await child.exited !== 0) throw Error(`Measurement failed: ${mode}/${variant}/${run + 1}`);
        const row = { run: run + 1, variant, ...JSON.parse(output) };
        measurements.push(row);
        process.stderr.write(`${mode}/${variant}/${run + 1}: ${row.cpuMs} ms CPU, ${row.gaps} gaps\n`);
      }
    }
  }
  const pairs = ["idle", "load"].flatMap(mode => Array.from({ length: Number(repetitionsArg) }, (_, i) => {
    const base = measurements.find(row => row.mode === mode && row.run === i + 1 && row.variant === "baseline")!;
    const next = measurements.find(row => row.mode === mode && row.run === i + 1 && row.variant === "candidate")!;
    return { mode, run: i + 1, addedCpuPercentPoints: Number(next.cpuPercent) - Number(base.cpuPercent),
      relativeCpuPercent: (Number(next.cpuMs) / Number(base.cpuMs) - 1) * 100,
      sameWork: base.checksum === next.checksum && base.batches === next.batches && base.affinity === next.affinity };
  }));
  console.log(JSON.stringify({ utc: new Date().toISOString(), runtime: Bun.version, bunRevision: Bun.revision,
    sourceHashes: { baseline: hash(baseline), candidate: hash(candidate), sampler: hash("src/lib/loopHeapSignals.ts"),
      benchmark: hash(import.meta.path), spans: hash("src/lib/performanceSpans.ts"), watchdog: hash("src/lib/loopWatchdog.ts") },
    conditions: { control: controlArg === "--control" ? "baseline-vs-baseline" : "baseline-vs-candidate", preload: "both-variants", intervalMs: 10, loadPeriodMs: 20, rows: 10000, serializationsPerBatch: 3,
      stallCount: 2, stallMs: 550, warmupBatchesPerVariant: 100, warmupManualTicksPerVariant: 10000, warmupWaitMs: 1000, logSink: "bounded scalar counts",
      cpuMetric: "process.cpuUsage user+system, including watchdog and GC helper threads; 100% is one core" },
    measurements, pairs, passed: pairs.every(row => row.sameWork && row.addedCpuPercentPoints < 1) }, null, 2));
}
