import { expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createLoopProfiler, LOOP_PROFILE_ARM_MS, LOOP_PROFILE_BYTES, trimLoopProfile,
  type LoopProfile, type LoopGapProfile, type LoopProfilerPorts } from "./loopProfiler";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { createPerformanceSpans } from "./performanceSpans";
import { loopProfilerEnabled } from "./loopProfilerServing";

const root = path.resolve(".");
const frame = { name: "syntheticThreeSecondBlock", sourceURL: path.join(root, "src/lib/loopProfiler.fixture.ts"), line: 7 };
const sample: LoopProfile = { traces: [{ frames: [frame] }] };
function harness(expires = LOOP_PROFILE_ARM_MS) {
  let at = 0, enabled = true, reads = 0, calls = 0;
  let finish: ((result: { stackTraces: unknown }) => void) | undefined;
  const sleeps: number[] = [], phases: string[] = [], emitted: LoopGapProfile[] = [];
  const ports: LoopProfilerPorts = { now: () => at, enabled: async () => { reads++; return enabled; },
    collect: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    sleep: async ms => { sleeps.push(ms); at += ms; },
    flushTick: () => {}, root, phase: (phase, work) => { phases.push(phase); return work(); } };
  const recorder = createLoopProfiler(ports, expires);
  return { ports, recorder, emitted, phases, sleeps, get calls() { return calls; }, get reads() { return reads; },
    time: (value: number) => { at = value; }, disable: () => { enabled = false; },
    finish: (value: { stackTraces: unknown } = { stackTraces: sample }) => { if (!finish) throw new Error("not collecting"); finish(value); },
    gap: (from = 0, to = at, ms = 3000) => recorder.correlate(from, to, ms, value => emitted.push(value)),
  };
}
const turn = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("healthy windows discard returned profiles without reading stacks", async () => {
  const h = harness(5000); const done = h.recorder.start(); await turn();
  expect(h.calls).toBe(1);
  h.time(5000);
  expect(h.gap(0, 5000, 1999)).toBe(false);
  h.finish({ get stackTraces(): unknown { throw new Error("healthy profile was walked"); } });
  await done;
  expect(h.emitted).toEqual([]); expect(h.phases).toEqual(["settings", "collect"]);
});

test("only overlapping gaps at the exact threshold correlate and retention is bounded", async () => {
  const h = harness(5000); const done = h.recorder.start(); await turn(); h.time(5000);
  expect(h.gap(-3000, -1)).toBe(true);
  expect(h.gap(6000, 8000)).toBe(true);
  expect(h.emitted).toEqual(Array.from({ length: 2 }, () => ({ status: "skipped", reason: "outside-window" })));
  h.emitted.length = 0;
  for (let i = 0; i < 4; i++) expect(h.gap(0, 5000, 2000)).toBe(true);
  expect(h.gap()).toBe(true);
  expect(h.emitted.pop()).toEqual({ status: "skipped", reason: "pending-limit" });
  h.finish(); await done;
  expect(h.emitted).toHaveLength(4);
  expect(h.emitted[0]).toMatchObject({ status: "captured", from: 0, to: 5000, intervalUs: 10000,
    frames: { rows: [{ function: "syntheticThreeSecondBlock", file: "src/lib/loopProfiler.fixture.ts", selfWeight: 1, totalWeight: 1 }] } });
  expect(Buffer.byteLength(JSON.stringify(h.emitted[0]))).toBeLessThanOrEqual(LOOP_PROFILE_BYTES);
});

test("profile completion before the poll flushes into the same loop-gap sequence", async () => {
  const h = harness(5000), lines: string[] = [];
  let at = 0;
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at));
  monitor.setProfiler(h.recorder); h.ports.flushTick = () => monitor.tick();
  const done = h.recorder.start(); await turn();
  at = 3010; h.time(at);
  monitor.run("http.render", () => {});
  // No poll occurred yet. The collection boundary must observe it.
  h.finish(); h.disable(); await done;
  expect(lines).toHaveLength(1);
  expect(lines[0]!.startsWith("[viewer loop-gap] ")).toBe(true);
  expect(JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length))).toMatchObject({ sequence: 1, gapMs: 3000,
    jsProfile: { status: "captured", frames: { rows: [{ function: "syntheticThreeSecondBlock" }] } } });
  monitor.stop();
});

test("three long gaps in consecutive slow windows each carry captured frames on their gap record", async () => {
  const h = harness(18000), lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), h.ports.now, createPerformanceSpans(h.ports.now));
  monitor.setProfiler(h.recorder); h.ports.flushTick = monitor.tick;
  const done = h.recorder.start(); await turn();
  try {
    for (let index = 0; index < 3; index++) {
      expect(h.calls).toBe(index + 1);
      h.time((index + 1) * 6000);
      // The collection timer recovers before the polling timer each time.
      h.finish(); await turn();
      expect(lines).toHaveLength(index + 1);
      const gap = JSON.parse(lines[index]!.slice("[viewer loop-gap] ".length));
      expect(gap).toMatchObject({ sequence: index + 1, gapMs: 5990,
        jsProfile: { status: "captured", from: index * 6000, to: (index + 1) * 6000, intervalUs: 10000,
          frames: { rows: [{ function: "syntheticThreeSecondBlock", file: "src/lib/loopProfiler.fixture.ts" }] } } });
      expect(Buffer.byteLength(JSON.stringify(gap.jsProfile))).toBeLessThanOrEqual(LOOP_PROFILE_BYTES);
    }
    await done;
    expect(h.calls).toBe(3); expect(h.sleeps).toEqual([]);
  } finally { monitor.stop(); }
});

test("slow windows without a qualifying gap discard stacks and immediately sample again", async () => {
  const h = harness(12000); const done = h.recorder.start(); await turn();
  for (const at of [6000, 12000]) {
    h.time(at);
    h.finish({ get stackTraces(): unknown { throw new Error("healthy profile was walked"); } });
    await turn();
  }
  await done;
  expect(h.calls).toBe(2); expect(h.sleeps).toEqual([]);
  expect(h.emitted).toEqual([]); expect(h.phases).not.toContain("trim");
});

test.each([5000, 6000])("consecutive %s ms windows stop when the kill switch is read at the boundary", async duration => {
  const h = harness(); const done = h.recorder.start(); await turn();
  h.time(duration); if (duration > 5000) h.gap();
  h.finish(); await turn(); expect(h.calls).toBe(2);
  h.disable(); h.time(duration * 2); h.finish(); await done;
  expect(h.calls).toBe(2); expect(h.reads).toBe(3); expect(h.sleeps).toEqual([]);
});

test("thirty-minute expiry and disable during an awaited setting read admit no next collection", async () => {
  const h = harness(); const done = h.recorder.start(); await turn();
  h.time(LOOP_PROFILE_ARM_MS); h.finish(); await done; expect(h.calls).toBe(1);
  const expired = harness(0); await expired.recorder.start(); expect(expired.calls).toBe(0);
  for (const action of ["expiry", "stop"] as const) {
    const held = harness(); let release!: (value: boolean) => void;
    held.ports.enabled = () => new Promise(resolve => { release = resolve; });
    const run = held.recorder.start(); await turn();
    if (action === "expiry") held.time(LOOP_PROFILE_ARM_MS); else held.recorder.stop();
    release(true); await run; expect(held.calls).toBe(0);
  }
});

test("off admits nothing and the last window is shortened to the remaining arm budget", async () => {
  const off = harness(); off.disable(); await off.recorder.start(); expect(off.calls).toBe(0);
  const h = harness(1234);
  h.ports.collect = async (work, interval) => { expect(interval).toBe(10000); await work(); return { stackTraces: sample }; };
  await h.recorder.start(); expect(h.sleeps).toEqual([1234]);
});

test("collection and conversion failures release pending gap records and stop retrying", async () => {
  for (const kind of ["collect", "trim"] as const) {
    const h = harness(); let reject!: (error: Error) => void;
    if (kind === "collect") h.ports.collect = () => new Promise((_, fail) => { reject = fail; });
    const run = h.recorder.start(); await turn(); h.time(3000); expect(h.gap()).toBe(true);
    if (kind === "collect") reject(new Error("private diagnostic failure")); else h.finish({ stackTraces: null });
    await run; expect(h.emitted).toEqual([{ status: "unavailable", reason: "capture-failed" }]);
    expect(h.gap()).toBe(true);
    expect(h.emitted).toEqual(Array.from({ length: 2 }, () => ({ status: "unavailable", reason: "capture-failed" })));
  }
});

test.each(["no-active-window", "arm-expired", "kill-switch", "stopped"] as const)(
  "a long gap without a pending capture logs its reason: %s", async reason => {
    const h = harness(), lines: string[] = [];
    const monitor = createViewerLoopMonitor(line => lines.push(line), h.ports.now, createPerformanceSpans(h.ports.now));
    monitor.setProfiler(h.recorder);
    try {
      if (reason === "arm-expired") { h.time(LOOP_PROFILE_ARM_MS); await h.recorder.start(); }
      else if (reason === "kill-switch") { h.disable(); await h.recorder.start(); }
      else if (reason === "stopped") h.recorder.stop();
      // No collection exists to retain this report, including at the exact threshold.
      if (reason !== "arm-expired") h.time(2010);
      monitor.tick();
      const gap = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length));
      expect(gap.jsProfile).toEqual({ status: reason === "no-active-window" ? "skipped" : "not-armed", reason });
      expect(h.calls).toBe(0);
    } finally { monitor.stop(); }
  });

test("a gap during the next settings read logs the missing window while sampling resumes", async () => {
  const h = harness(), lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), h.ports.now, createPerformanceSpans(h.ports.now));
  monitor.setProfiler(h.recorder);
  const done = h.recorder.start(); await turn();
  let release!: (value: boolean) => void;
  h.ports.enabled = () => new Promise(resolve => { release = resolve; });
  h.time(5000); h.finish(); await turn();
  h.time(7010); monitor.tick();
  expect(JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length)).jsProfile).toEqual({ status: "skipped", reason: "no-active-window" });
  release(true); await turn(); expect(h.calls).toBe(2);
  h.ports.enabled = async () => false;
  h.time(12010); h.finish(); await done; monitor.stop();
  expect(h.calls).toBe(2);
});

test("privacy filter rejects outside paths, URL payloads, dynamic names and native frames", () => {
  const marker = "privateSyntheticMarker";
  const bad = [
    { ...frame, sourceURL: path.resolve(root, "../private.ts") },
    { ...frame, sourceURL: path.join(root, "node_modules/package/index.ts") },
    { ...frame, sourceURL: `file://${frame.sourceURL}?message=private` },
    { ...frame, sourceURL: "https://example.invalid/private.ts" },
    { ...frame, name: "message text\nprivate" }, { ...frame, name: "native function" }, { ...frame, name: marker },
    { ...frame, sourceURL: undefined }, { ...frame, line: NaN },
  ];
  expect(trimLoopProfile({ traces: bad.map(value => ({ frames: [value] })) }, root).rows).toEqual([]);
  expect(trimLoopProfile({ traces: [{ frames: [{ ...frame, name: marker }] }] }, root).rows).toEqual([]);
  const recursive = trimLoopProfile({ traces: [{ frames: [frame, frame] }] }, root);
  expect(recursive.rows[0]).toMatchObject({ self: 1, total: 1 });
});

test("a correctly attributed low-sample profile keeps its frame without a count threshold", () => {
  const result = trimLoopProfile({ traces: Array.from({ length: 119 }, () => ({ frames: [frame] })) }, root);
  expect(result.rows[0]).toMatchObject({ function: "syntheticThreeSecondBlock", file: "src/lib/loopProfiler.fixture.ts", self: 119, total: 119 });
});

test("static names remain attributable beyond the old declaration lookback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-profile-long-function-"));
  const sourceDirectory = path.join(directory, "src");
  await mkdir(sourceDirectory, { recursive: true });
  const sourceURL = path.join(sourceDirectory, "long.ts");
  const lines = ["function ordinaryLongFunction() {"];
  for (let index = 0; index < 48; index++) lines.push(`  const value${index} = ${index};`);
  lines.push("  return value47;", "}");
  await writeFile(sourceURL, lines.join("\n"));
  try {
    const result = trimLoopProfile({ traces: Array.from({ length: 20 }, () => ({ frames: [
      { name: "ordinaryLongFunction", sourceURL, line: 49 },
    ] })) }, directory);
    expect(result.rows[0]).toMatchObject({ function: "ordinaryLongFunction", file: "src/long.ts", line: 49, self: 20, total: 20 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("static callables from emitted Viewer chunks are retained with repository-relative paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-profile-emitted-bundle-"));
  const chunkDirectory = path.join(directory, ".next/server/chunks");
  await mkdir(chunkDirectory, { recursive: true });
  const sourceURL = path.join(chunkDirectory, "viewer.js");
  await writeFile(sourceURL, "function emittedViewerLoopOwner(){for(;;){}};const computed={['privateSyntheticMarker'](){}};");
  try {
    const good = trimLoopProfile({ traces: Array.from({ length: 20 }, () => ({ frames: [
      { name: "emittedViewerLoopOwner", sourceURL, line: 1 },
    ] })) }, directory);
    expect(good.rows[0]).toMatchObject({ function: "emittedViewerLoopOwner", file: ".next/server/chunks/viewer.js", line: 1, self: 20, total: 20 });
    const computed = trimLoopProfile({ traces: [{ frames: [
      { name: "privateSyntheticMarker", sourceURL, line: 1 },
    ] }] }, directory);
    expect(computed.rows).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("large profiles visit at most 4096 samples and 32 frames with at most 16 retained rows", async () => {
  const source = await namedSource("function", 100);
  try {
    let visits = 0;
    const frames = source.frames.map(value => ({ ...value, get line() { visits++; return value.line; } }));
    const raw = { traces: Array.from({ length: 10000 }, () => ({ frames })) };
    const result = trimLoopProfile(raw, source.directory);
    expect(result.inspectedSamples).toBe(4096); expect(visits).toBeLessThanOrEqual(2 * 4096 * 32 * 3);
    expect(result.rows).toHaveLength(16); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(LOOP_PROFILE_BYTES);
  } finally { await source.cleanup(); }
});

test("a late hot blocker survives candidate churn and long locations respect the byte cap", async () => {
  const source = await namedSource("cold", 257);
  try {
    const hot = source.frames[256]!;
    const traces = source.frames.slice(0, 256).map(value => ({ frames: [value] }));
    traces.push(...Array.from({ length: 300 }, () => ({ frames: [hot] })));
    expect(trimLoopProfile({ traces }, source.directory).rows[0]).toMatchObject({ function: hot.name, self: 300, total: 300 });
    const large = trimLoopProfile({ traces: Array.from({ length: 16 }, (_, i) => ({ frames: [{
      ...hot, name: `long${i}`, sourceURL: path.join(source.directory, `src/${"x".repeat(650)}${i}.ts`),
    }] })) }, source.directory);
    expect(large.rows.length).toBeLessThan(16);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(LOOP_PROFILE_BYTES - 512);
  } finally { await source.cleanup(); }
});

async function child(args: string[], directory: string) {
  const home = path.join(directory, "home"), config = path.join(directory, "config"), temp = path.join(directory, "tmp");
  for (const dir of [home, config, temp]) await mkdir(dir, { recursive: true });
  const processChild = Bun.spawn([process.execPath, path.join(import.meta.dir, "loopProfiler.fixture.ts"), ...args], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, TMPDIR: temp, LLV_STATE_DIR: directory,
      LLV_STATE_OWNER: undefined, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => processChild.kill("SIGKILL"), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(processChild.stdout).text(), new Response(processChild.stderr).text(), processChild.exited]);
    expect(stderr).toBe(""); expect(code).toBe(0); return JSON.parse(stdout);
  } finally { clearTimeout(deadline); processChild.kill("SIGKILL"); await processChild.exited; }
}

async function namedSource(prefix: string, count: number) {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-profile-names-"));
  const sourceDirectory = path.join(directory, "src");
  await mkdir(sourceDirectory, { recursive: true });
  const sourceURL = path.join(sourceDirectory, "names.ts");
  const names = Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  await writeFile(sourceURL, names.map(name => `function ${name}() {}`).join("\n"));
  const frames = names.map((name, index) => ({ name, sourceURL, line: index + 1 }));
  return { directory, frames, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("fresh processes cannot renew a consumed deploy budget; runtime host never claims it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-profile-restart-"));
  try {
    expect(await loopProfilerEnabled(dir)).toBe(true);
    for (const value of ["not json", JSON.stringify({ enabled: "false" }), " ".repeat(513), JSON.stringify({ enabled: true })]) {
      await writeFile(path.join(dir, "loop-profiler.json"), value); expect(await loopProfilerEnabled(dir)).toBe(true);
    }
    await writeFile(path.join(dir, "loop-profiler.json"), JSON.stringify({ enabled: false }));
    expect(await loopProfilerEnabled(dir)).toBe(false);
    await writeFile(path.join(dir, "loop-profiler.json"), JSON.stringify({ enabled: true }));
    expect(await child(["host", dir], dir)).toBe(true);
    expect(await readdir(dir)).not.toContain("loop-profiler-deploy.json");
    expect(await child(["claim", dir, "a".repeat(40)], dir)).toBe(true);
    const original = await readFile(path.join(dir, "loop-profiler-deploy.json"), "utf8");
    expect(await child(["claim", dir, "a".repeat(40)], dir)).toBe(false);
    expect(await readFile(path.join(dir, "loop-profiler-deploy.json"), "utf8")).toBe(original);
    expect(await child(["claim", dir, "b".repeat(40)], dir)).toBe(true);
    const contenders = await Promise.all([child(["claim", dir, "c".repeat(40)], dir), child(["claim", dir, "c".repeat(40)], dir)]);
    expect(contenders.filter(Boolean)).toHaveLength(1);
    await writeFile(path.join(dir, "loop-profiler-deploy.json"), "malformed");
    expect(await child(["claim", dir, "c".repeat(40)], dir)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit enabled:false is a kill switch: deploy opportunity is consumed and nothing is recorded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-profile-off-"));
  try {
    const lines: string[] = await child(["disabled"], dir);
    expect(lines.some(line => line.includes('"jsProfile"'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, "loop-profiler-deploy.json"), "utf8")).revision).toBe("a".repeat(40));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("with no settings file, Bun main-thread three-second block is named on its actual loop-gap record", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-profile-native-"));
  try {
    const lines: string[] = await child(["native"], dir);
    const gaps = lines.filter(line => line.startsWith("[viewer loop-gap] ")).map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
    const gap = gaps.find(row => row.gapMs >= 2000);
    expect(gap?.jsProfile?.status).toBe("captured");
    expect(gap.operations.some((op: { name: string }) => op.name === "loop-profiler.collect")).toBe(true);
    const target = gap.jsProfile.frames.rows.find((row: { function: string }) => row.function === "syntheticThreeSecondBlock");
    expect(target).toMatchObject({ file: "src/lib/loopProfiler.fixture.ts" });
    expect(target.line).toBeGreaterThan(0);
    expect(Number.isSafeInteger(target.self) && target.self >= 0).toBe(true);
    expect(Number.isSafeInteger(target.total) && target.total >= target.self).toBe(true);
    expect(target.total).toBeLessThanOrEqual(gap.jsProfile.frames.inspectedSamples);
    expect(Buffer.byteLength(JSON.stringify(gap.jsProfile))).toBeLessThanOrEqual(LOOP_PROFILE_BYTES);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 25_000);

test("production bundle block is named on its correlated loop-gap record", async () => {
  if (process.env.LLV_LOOP_PROFILER_COMPILED_TEST !== "1") return;
  const dir = await mkdtemp(path.join(tmpdir(), "loop-profile-compiled-"));
  try {
    const lines: string[] = await child(["native-compiled"], dir);
    const gaps = lines.filter(line => line.startsWith("[viewer loop-gap] ")).map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
    const gap = gaps.find(row => row.gapMs >= 2000);
    expect(gap?.jsProfile?.status).toBe("captured");
    const target = gap.jsProfile.frames.rows.find((row: { file: string }) => row.file.startsWith(".next/server/"));
    expect(target).toBeDefined();
    expect(target.function).toMatch(/^[A-Za-z_$][\w$]{0,95}$/);
    expect(target.line).toBeGreaterThan(0);
    expect(target.self).toBeGreaterThan(100);
    expect(target.total).toBeGreaterThanOrEqual(target.self);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 25_000);

test("runtime computed method keys never appear in a native loop-gap profile", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-profile-computed-key-"));
  try {
    const lines: string[] = await child(["native-computed"], dir);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("privateSyntheticMarker");
    const gaps = lines.filter(line => line.startsWith("[viewer loop-gap] ")).map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
    const gap = gaps.find(row => row.gapMs >= 2000);
    expect(gap?.jsProfile?.status).toBe("captured");
    expect(gap.jsProfile.frames.rows.some((row: { function: string }) => row.function === "privateSyntheticMarker")).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 25_000);
