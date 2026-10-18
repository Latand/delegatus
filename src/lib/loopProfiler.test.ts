import { expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createLoopProfiler, LOOP_PROFILE_ARM_MS, LOOP_PROFILE_BYTES, LOOP_PROFILE_COOLDOWN_MS, trimLoopProfile,
  type LoopProfile, type LoopGapProfile, type LoopProfilerPorts } from "./loopProfiler";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { createPerformanceSpans } from "./performanceSpans";
import { loopProfilerEnabled } from "./loopProfilerServing";

const root = path.resolve(".");
const frame = { name: "syntheticFunction", sourceURL: path.join(root, "src/lib/loopProfiler.fixture.ts"), line: 7 };
const sample: LoopProfile = { traces: [{ frames: [frame] }] };
function harness(expires = LOOP_PROFILE_ARM_MS) {
  let at = 0, enabled = true, reads = 0, calls = 0;
  let finish: ((result: { stackTraces: unknown }) => void) | undefined;
  const sleeps: number[] = [], phases: string[] = [], emitted: LoopGapProfile[] = [];
  let afterSleep: (() => void) | undefined;
  const ports: LoopProfilerPorts = { now: () => at, enabled: async () => { reads++; return enabled; },
    collect: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    sleep: async ms => { sleeps.push(ms); at += ms; afterSleep?.(); },
    flushTick: () => {}, root, phase: (phase, work) => { phases.push(phase); return work(); } };
  const recorder = createLoopProfiler(ports, expires);
  return { ports, recorder, emitted, phases, sleeps, get calls() { return calls; }, get reads() { return reads; },
    time: (value: number) => { at = value; }, disable: () => { enabled = false; },
    afterSleep: (work: () => void) => { afterSleep = work; },
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
  expect(h.gap(-3000, -1)).toBe(false);
  expect(h.gap(6000, 8000)).toBe(false);
  for (let i = 0; i < 4; i++) expect(h.gap(0, 5000, 2000)).toBe(true);
  expect(h.gap()).toBe(false);
  h.finish(); await done;
  expect(h.emitted).toHaveLength(4);
  expect(h.emitted[0]).toMatchObject({ status: "captured", from: 0, to: 5000, intervalUs: 10000,
    frames: { rows: [{ function: "syntheticFunction", file: "src/lib/loopProfiler.fixture.ts", selfWeight: 1, totalWeight: 1 }] } });
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
    jsProfile: { status: "captured", frames: { rows: [{ function: "syntheticFunction" }] } } });
  monitor.stop();
});

test.each([false, true])("a long window cools down even without a qualifying gap: gap=%s", async gap => {
  const h = harness(); const done = h.recorder.start(); await turn(); h.time(6000);
  if (gap) h.gap();
  h.afterSleep(h.disable); h.finish(); await done;
  expect(h.sleeps).toEqual([LOOP_PROFILE_COOLDOWN_MS]); expect(h.calls).toBe(1);
});

test("consecutive healthy windows continue until the kill switch is read at the boundary", async () => {
  const h = harness(); const done = h.recorder.start(); await turn();
  h.time(5000); h.finish(); await turn(); expect(h.calls).toBe(2);
  h.disable(); h.time(10000); h.finish(); await done;
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
    await run; expect(h.emitted).toEqual([{ status: "unavailable" }]);
    expect(h.gap()).toBe(false);
  }
});

test("privacy filter rejects outside paths, URL payloads, dynamic names and native frames", () => {
  const bad = [
    { ...frame, sourceURL: path.resolve(root, "../private.ts") },
    { ...frame, sourceURL: path.join(root, "node_modules/package/index.ts") },
    { ...frame, sourceURL: `file://${frame.sourceURL}?message=private` },
    { ...frame, sourceURL: "https://example.invalid/private.ts" },
    { ...frame, name: "message text\nprivate" }, { ...frame, name: "native function" },
    { ...frame, sourceURL: undefined }, { ...frame, line: NaN },
  ];
  expect(trimLoopProfile({ traces: bad.map(value => ({ frames: [value] })) }, root).rows).toEqual([]);
  const recursive = trimLoopProfile({ traces: [{ frames: [frame, frame] }] }, root);
  expect(recursive.rows[0]).toMatchObject({ self: 1, total: 1 });
});

test("large profiles visit at most 4096 samples and 32 frames with at most 16 retained rows", () => {
  let visits = 0;
  const frames = Array.from({ length: 100 }, (_, i) => ({ ...frame, name: `function${i}`, get line() { visits++; return i + 1; } }));
  const raw = { traces: Array.from({ length: 10000 }, () => ({ frames })) };
  const result = trimLoopProfile(raw, root);
  expect(result.inspectedSamples).toBe(4096); expect(visits).toBeLessThanOrEqual(2 * 4096 * 32 * 3);
  expect(result.rows).toHaveLength(16); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(LOOP_PROFILE_BYTES);
});

test("a late hot blocker survives candidate churn and long locations respect the byte cap", () => {
  const traces = Array.from({ length: 256 }, (_, i) => ({ frames: [{ ...frame, name: `cold${i}` }] }));
  traces.push(...Array.from({ length: 300 }, () => ({ frames: [frame] })));
  expect(trimLoopProfile({ traces }, root).rows[0]).toMatchObject({ function: frame.name, self: 300, total: 300 });
  const large = trimLoopProfile({ traces: Array.from({ length: 16 }, (_, i) => ({ frames: [{
    ...frame, name: `long${i}`, sourceURL: path.join(root, `src/${"x".repeat(650)}${i}.ts`),
  }] })) }, root);
  expect(large.rows.length).toBeLessThan(16);
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(LOOP_PROFILE_BYTES - 512);
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

test("fresh processes cannot renew a consumed deploy budget; runtime host never claims it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-profile-restart-"));
  try {
    expect(await loopProfilerEnabled(dir)).toBe(false);
    for (const value of ["not json", JSON.stringify({ enabled: "true" }), " ".repeat(513)]) {
      await writeFile(path.join(dir, "loop-profiler.json"), value); expect(await loopProfilerEnabled(dir)).toBe(false);
    }
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

test("Bun main-thread three-second block is named on its actual loop-gap record", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-profile-native-"));
  try {
    const lines: string[] = await child(["native"], dir);
    const gaps = lines.filter(line => line.startsWith("[viewer loop-gap] ")).map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
    const gap = gaps.find(row => row.gapMs >= 2000);
    expect(gap?.jsProfile?.status).toBe("captured");
    expect(gap.operations.some((op: { name: string }) => op.name === "loop-profiler.collect")).toBe(true);
    const target = gap.jsProfile.frames.rows.find((row: { function: string }) => row.function === "syntheticThreeSecondBlock");
    expect(target).toMatchObject({ file: "src/lib/loopProfiler.fixture.ts" });
    expect(target.self).toBeGreaterThan(200); expect(target.total).toBeGreaterThan(200); expect(target.line).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(gap.jsProfile))).toBeLessThanOrEqual(LOOP_PROFILE_BYTES);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 25_000);
