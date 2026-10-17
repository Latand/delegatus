import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loopWatchdogLayout, readLoopStall } from "./loopWatchdog";

const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "loopWatchdog.ts")).href;

async function runProbe(script: string, deadlineMs = 20_000) {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-watchdog-test-"));
  const roots = Object.fromEntries(["home", "config", "state", "tmp"].map(key => [key, path.join(directory, key)]));
  await Promise.all(Object.values(roots).map(root => mkdir(root)));
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, HOME: roots.home, XDG_CONFIG_HOME: roots.config, LLV_STATE_DIR: roots.state,
      TMPDIR: roots.tmp, LLV_STATE_OWNER: undefined, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
  try {
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    return JSON.parse(output);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}

const setup = `
  const { startLoopWatchdog } = await import(${JSON.stringify(moduleUrl)});
  const watchdog = startLoopWatchdog();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  await watchdog.ready;
  if (!watchdog.snapshot().available) throw Error("watchdog did not start");
  if (process.platform === "linux" && !((watchdog.snapshot().samples.at(-1)?.rssBytes ?? -1) > 0)) {
    throw Error("RSS sampler reported ready without a sample");
  }
`;

test("trigger storage is numeric, fixed, and unpublished rows are rejected", () => {
  const cells = new BigInt64Array(new SharedArrayBuffer(loopWatchdogLayout.cells * 8));
  expect(cells.byteLength).toBe(52_904);
  expect(readLoopStall(cells)).toBeNull();
  const at = loopWatchdogLayout.trigger;
  [0, 1_500_000, 100_000, 12345, 7, 1_400_000, 100, 200, 12000, 12300].forEach((value, offset) => Atomics.store(cells, at + offset, BigInt(value)));
  expect(readLoopStall(cells)).toBeNull();
  Atomics.store(cells, at, BigInt(1));
  expect(readLoopStall(cells)).toEqual({ sequence: 1, monotonicUs: 1_500_000, heartbeatUs: 100_000,
    utcMs: 12345, site: 7, ageMs: 1400, rssBeforeBytes: 100, rssBytes: 200, rssBeforeUtcMs: 12000, rssUtcMs: 12300 });
});

test("independent worker records a stale heartbeat before recovery, once per stall, across fresh processes", async () => {
  for (let run = 0; run < 2; run++) {
    const report = await runProbe(setup + `
      watchdog.heartbeat(); watchdog.site(7);
      const began = Date.now();
      function namedBlockedControl() { const until = performance.now() + 1800; while (performance.now() < until) {} }
      namedBlockedControl();
      const recovered = Date.now();
      // Delay observation beyond recovery; no recovery callback creates the trigger.
      await delay(400);
      const first = watchdog.snapshot().stall;
      watchdog.heartbeat();
      const heartbeat = setInterval(() => watchdog.heartbeat(), 10);
      await delay(250);
      clearInterval(heartbeat);
      // A second stale heartbeat inside the minute keeps the first trigger.
      watchdog.heartbeat(); namedBlockedControl();
      const second = watchdog.snapshot().stall;
      await watchdog.stop();
      console.log(JSON.stringify({ began, recovered, first, second }));
    `);
    expect(report.first.sequence).toBe(1);
    expect(report.first.site).toBe(7);
    expect(report.first.utcMs).toBeGreaterThanOrEqual(report.began + 1000);
    expect(report.first.utcMs).toBeLessThan(report.recovered);
    expect(report.first.ageMs).toBeGreaterThan(1000);
    expect(report.second).toEqual(report.first);
  }
}, 45_000);

test.skipIf(process.platform !== "linux")("worker observes real RSS growth while a labelled main-thread phase is blocked", async () => {
  const report = await runProbe(setup + `
    watchdog.heartbeat(); watchdog.site(7);
    const before = watchdog.snapshot().samples.at(-1);
    const began = Date.now();
    const retained = [];
    const until = performance.now() + 2200;
    // Touch every page in two allocations during the stalled interval.
    retained.push(Buffer.alloc(64 * 1024 * 1024, 1));
    while (performance.now() < until) {
      if (performance.now() > until - 500 && retained.length === 1) retained.push(Buffer.alloc(64 * 1024 * 1024, 2));
    }
    const recovered = Date.now();
    const snapshot = watchdog.snapshot();
    await watchdog.stop();
    console.log(JSON.stringify({ began, recovered, before, stall: snapshot.stall, samples: snapshot.samples,
      sentinel: retained[1][0] }));
  `);
  expect(report.sentinel).toBe(2);
  expect(report.stall.site).toBe(7);
  expect(report.stall.rssBeforeBytes).toBeGreaterThan(0);
  expect(report.stall.rssBeforeUtcMs).toBeLessThanOrEqual(report.began);
  const interior = report.samples.filter((row: { rssUtcMs: number }) => row.rssUtcMs > report.began && row.rssUtcMs < report.recovered);
  expect(interior.length).toBeGreaterThan(1);
  expect(Math.max(...interior.map((row: { rssBytes: number }) => row.rssBytes)) - report.before.rssBytes).toBeGreaterThan(96 * 1024 * 1024);
}, 30_000);

test.skipIf(process.platform !== "linux")("production monitor serializes the stall-time phase and RSS while heap coverage stays explicit", async () => {
  const monitorUrl = new URL("viewerLoopMonitor.ts", moduleUrl).href;
  const spansUrl = new URL("performanceSpans.ts", moduleUrl).href;
  const report = await runProbe(`
    const { createViewerLoopMonitor } = await import(${JSON.stringify(monitorUrl)});
    const { startLoopWatchdog } = await import(${JSON.stringify(new URL("loopWatchdog.ts", moduleUrl).href)});
    const { createPerformanceSpans } = await import(${JSON.stringify(spansUrl)});
    const spans = createPerformanceSpans(); const lines = [];
    const monitor = createViewerLoopMonitor(line => lines.push(line), () => performance.now(), spans, undefined,
      () => startLoopWatchdog({ startupDelayMs: 4000 }));
    const readiness = monitor.start();
    const readinessPromise = readiness instanceof Promise;
    await readiness;
    const began = Date.now();
    const retained = [];
    monitor.run("http.render", () => spans.sync("http.render", () => {
      retained.push(Buffer.alloc(64 * 1024 * 1024, 3));
      const end = performance.now() + 1800; while (performance.now() < end) {}
    }));
    const recovered = Date.now();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error("monitor did not report the confirmed stall")), 10000);
      const poll = () => {
        if (lines.some(line => line.startsWith("[viewer loop-gap] "))) {
          clearTimeout(deadline); resolve(); return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    monitor.stop();
    const row = lines.filter(line => line.startsWith("[viewer loop-gap] ")).map(line => JSON.parse(line.slice(18)))
      .find(row => row.gapMs > 1500);
    console.log(JSON.stringify({ row, began, recovered, sentinel: retained[0][0], readinessPromise }));
  `);
  expect(report.readinessPromise).toBe(true);
  expect(report.sentinel).toBe(3);
  expect(report.row.scheduler.stall.site).toBe("http.render");
  expect(report.row.scheduler.stall.utcMs).toBeGreaterThan(report.began);
  expect(report.row.scheduler.stall.utcMs).toBeLessThan(report.recovered);
  expect(report.row.scheduler.rss.source).toBe("proc-status-worker");
  expect(report.row.scheduler.rss.deltaBytes).toBeGreaterThan(48 * 1024 * 1024);
  expect(report.row.scheduler.rss.sampleToUtcMs).toBeLessThan(report.recovered);
  expect(report.row.heap).toMatchObject({ source: "unavailable", deltaBytes: null, unavailable: "nonblocking-heap-sampling-unavailable" });
  expect(report.row.operations).toContainEqual(expect.objectContaining({ name: "http.render", completed: true }));
  expect(report.row.attribution.slices).toContainEqual(expect.objectContaining({ site: "http.render", kind: "sync" }));
}, 30_000);

test.skipIf(process.platform !== "linux")("real transcript index entry and resumed segments retain watchdog attribution", async () => {
  for (const phase of ["entry", "resume"]) {
    const report = await runProbe(`
      const { createViewerLoopMonitor } = await import(${JSON.stringify(new URL("viewerLoopMonitor.ts", moduleUrl).href)});
      const { performanceSpans } = await import(${JSON.stringify(new URL("performanceSpans.ts", moduleUrl).href)});
      const { indexTranscriptSources } = await import(${JSON.stringify(new URL("search/transcriptSearch.ts", moduleUrl).href)});
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const lines = [];
      const monitor = createViewerLoopMonitor(line => lines.push(line), () => performance.now(), performanceSpans);
      const originalSync = performanceSpans.sync.bind(performanceSpans);
      let shouldBlock = ${JSON.stringify(phase === "entry")};
      performanceSpans.sync = (site, work, rows, bytes) => {
        if (site === "transcript.index" && shouldBlock) {
          shouldBlock = false;
          return originalSync(site, () => {
            const until = performance.now() + 1700;
            while (performance.now() < until) {}
            return work();
          }, rows, bytes);
        }
        return originalSync(site, work, rows, bytes);
      };
      await monitor.start();
      const transcript = path.join(process.env.TMPDIR, "index-control.jsonl");
      await fs.writeFile(transcript, "fixture\\n");
      const stat = await fs.stat(transcript);
      let markStarted;
      const started = new Promise(resolve => { markStarted = resolve; });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const indexing = monitor.run("transcript.index", () => indexTranscriptSources([{
        path: transcript, project: "watchdog-control", engine: "claude", size: stat.size, mtimeMs: stat.mtimeMs,
      }], { complete: true, readMessages: async function* () {
        markStarted();
        await gate;
        yield { body: "control message", speaker: "user", timestamp: null, byteOffset: 0, lineNumber: 1 };
      } }));
      if (${JSON.stringify(phase === "resume")}) {
        await started;
        shouldBlock = true;
        release();
      } else { await started; release(); }
      await indexing;
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(Error("monitor did not report the transcript index stall")), 10000);
        const poll = () => {
          if (lines.some(line => line.startsWith("[viewer loop-gap] "))) {
            clearTimeout(deadline); resolve(); return;
          }
          setTimeout(poll, 10);
        };
        poll();
      });
      monitor.stop();
      const row = lines.filter(line => line.startsWith("[viewer loop-gap] ")).map(line => JSON.parse(line.slice(18)))
        .find(row => row.gapMs > 1500);
      console.log(JSON.stringify({ phase: ${JSON.stringify(phase)}, row }));
    `);
    expect(report.phase).toBe(phase);
    expect(report.row.scheduler.stall.site).toBe("transcript.index");
    expect(report.row.attribution.slices).toContainEqual(expect.objectContaining({
      site: "transcript.index", kind: "sync", maxMs: expect.any(Number),
    }));
    expect(report.row.attribution.slices.find((slice: { site: string; kind: string }) =>
      slice.site === "transcript.index" && slice.kind === "sync")?.maxMs).toBeGreaterThan(1000);
  }
}, 45_000);

test("actual producer wraps at 600 samples and a healthy heartbeat never triggers", async () => {
  const report = await runProbe(setup + `
    const heartbeat = setInterval(() => watchdog.heartbeat(), 10);
    const deadline = performance.now() + 90000;
    let snapshot;
    do {
      await delay(100);
      snapshot = watchdog.snapshot();
      if (performance.now() > deadline) throw Error("ring did not wrap");
    } while ((snapshot.samples.at(-1)?.sequence ?? 0) < 605);
    clearInterval(heartbeat); await watchdog.stop();
    console.log(JSON.stringify({ count: snapshot.samples.length, stall: snapshot.stall,
      first: snapshot.samples[0].sequence, last: snapshot.samples.at(-1).sequence,
      rssReads: new Set(snapshot.samples.map(row => row.rssUtcMs).filter(at => at > 0)).size,
      ordered: snapshot.samples.every((row, i, rows) => !i || row.sequence > rows[i - 1].sequence) }));
  `, 100_000);
  expect(report.count).toBeLessThanOrEqual(600);
  expect(report.count).toBeGreaterThanOrEqual(599);
  expect(report.last - report.first).toBeLessThanOrEqual(599);
  expect(report.ordered).toBe(true);
  expect(report.stall).toBeNull();
  if (process.platform === "linux") {
    expect(report.rssReads).toBeGreaterThan(1);
    expect(report.rssReads).toBeLessThanOrEqual(61);
  }
}, 110_000);
