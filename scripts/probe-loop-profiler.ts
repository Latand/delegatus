import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";

// Run only in a disposable process. The parent owns the hard deadline; a timer
// inside the sampled VM cannot bound its producer while that VM is blocked.
const workerSource = String.raw`
  const { parentPort } = require("node:worker_threads");
  const { Session } = require("node:inspector");
  const s = new Session(); s.connectToMainThread();
  const post = (method, params = {}) => new Promise((resolve, reject) =>
    s.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  (async () => {
    await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 10000 });
    await post("Profiler.start");
    parentPort.postMessage({ armed: true });
    setTimeout(async () => {
      const requestedAt = Date.now(); const { profile } = await post("Profiler.stop");
      parentPort.postMessage({ requestedAt, finishedAt: Date.now(), names: profile.nodes.map(n => n.callFrame.functionName) });
      s.disconnect();
    }, 100);
  })().catch(() => parentPort.postMessage({ refused: true }));
`;
const source = String.raw`
const { Session } = await import("node:inspector");
const { Worker } = await import("node:worker_threads");
const { pbkdf2Sync } = await import("node:crypto");
const session = new Session(); session.connect();
const post = (method, params = {}) => new Promise((resolve, reject) =>
  session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
await post("Profiler.enable");
await post("Profiler.setSamplingInterval", { interval: 10000 });
function namedMainThreadControl() {
  const end = performance.now() + 500;
  while (performance.now() < end) Math.sqrt(Math.random());
}
function namedNativeControl() { pbkdf2Sync("fixture", "fixture-salt", 500000, 32, "sha256"); }
// These plausible cap parameters are ignored by the pinned implementation.
// Confirm that empirically instead of treating an accepted command as a cap.
await post("Profiler.start", { maxBufferSize: 1, maxSamples: 1 });
const worker = new Worker(${JSON.stringify(workerSource)}, { eval: true });
let recoveredAt = 0;
const workerResult = await new Promise((resolve, reject) => {
  worker.on("error", reject);
  worker.on("message", message => {
    if (message.armed) { namedMainThreadControl(); namedNativeControl(); recoveredAt = Date.now(); }
    else resolve(message);
  });
});
await worker.terminate();
const { profile } = await post("Profiler.stop");
const names = profile.nodes.map(n => n.callFrame.functionName);
// A forced collection is a real GC control, but proves no coverage of automatic
// GC. Report that coverage as unknown even when a caller named gc is sampled.
await post("Profiler.start");
for (let i = 0; i < 5; i++) { let objects = Array.from({length:100000}, (_, n) => ({n})); Bun.gc(true); objects = null; Bun.gc(true); }
const gc = await post("Profiler.stop");
await post("Profiler.start");
const cleared = await post("Profiler.stop");
await post("Profiler.disable"); session.disconnect();
console.log(JSON.stringify({ runtime: process.versions.bun,
  local: { js: names.includes("namedMainThreadControl"), native: names.includes("pbkdf2Sync"),
    samples: profile.samples?.length ?? 0, stoppedAndCleared: !cleared.profile.nodes.some(n => n.callFrame.functionName === "namedMainThreadControl") },
  independent: { requestedBeforeRecovery: workerResult.requestedAt < recoveredAt,
    completedBeforeRecovery: workerResult.finishedAt < recoveredAt,
    sampledMainControl: workerResult.names?.includes("namedMainThreadControl") ?? false },
  gc: { automaticCoverage: "unknown", forcedControlSamples: gc.profile.samples?.length ?? 0,
    gcFrames: gc.profile.nodes.filter(n => /garbage|collector/i.test(n.callFrame.functionName)).length },
  producerCap: { requested: 1, observed: profile.samples?.length ?? 0 } }));
`;

export async function probeLoopProfiler() {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-profiler-probe-"));
  const roots = Object.fromEntries(["home", "config", "state", "tmp"].map(key => [key, path.join(directory, key)]));
  await Promise.all(Object.values(roots).map(root => mkdir(root)));
  const child = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, HOME: roots.home, XDG_CONFIG_HOME: roots.config,
      LLV_STATE_DIR: roots.state, TMPDIR: roots.tmp, LLV_STATE_OWNER: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0 || errors) throw new Error("isolated profiler capability probe failed");
    return JSON.parse(output);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}



// This is a disposable capability spike, never imported by a serving process.
type StackFrame = { name: string; sourceURL?: string; line: number };
type StackProfile = { traces: { frames: StackFrame[] }[] };
const sampleIntervalUs = 10_000;

function syntheticThreeSecondBlock() {
  const end = performance.now() + 3000;
  let checksum = 0;
  while (performance.now() < end) checksum += Math.sqrt(checksum + 1) % 123;
  return checksum;
}

async function jscControl() {
  const jsc = await import("bun:jsc");
  const { profile } = jsc;
  let stopRequestedAt = 0;
  const startedAt = performance.now();
  // The stop request cannot run during the main-thread block.
  const capture = await profile(() => new Promise<void>(resolve => {
    setTimeout(() => { stopRequestedAt = performance.now(); resolve(); }, 100);
    syntheticThreeSecondBlock();
  }), sampleIntervalUs);
  const raw = capture.stackTraces as unknown as StackProfile;
  const matches = (frame: StackFrame) => frame.name === "syntheticThreeSecondBlock" && frame.sourceURL === import.meta.path;
  const total = raw.traces.filter(trace => trace.frames.some(matches)).length;
  const self = raw.traces.filter(trace => trace.frames[0] && matches(trace.frames[0])).length;
  const line = raw.traces.flatMap(trace => trace.frames).find(matches)?.line ?? null;
  let exceptionPropagated = false;
  try { profile(() => { throw new Error("synthetic rejection"); }, sampleIntervalUs); }
  catch { exceptionPropagated = true; }
  const cleared = profile(() => {}, sampleIntervalUs).stackTraces as unknown as StackProfile;
  return { runtime: process.versions.bun, revision: Bun.revision, api: "bun:jsc.profile", sampleIntervalUs,
    target: { function: "syntheticThreeSecondBlock", file: "scripts/probe-loop-profiler.ts", line,
      selfSamples: self, totalSamples: total, selfWeight: self / raw.traces.length, totalWeight: total / raw.traces.length },
    samples: raw.traces.length, requestedStopAfterMs: 100, actualStopAfterMs: stopRequestedAt - startedAt,
    exceptionPropagated, cleared: !cleared.traces.some(trace => trace.frames.some(matches)),
    profilerExports: Object.keys(jsc).filter(name => /profile/i.test(name)).sort() };
}

type Arm = "baseline" | "jsc" | "inspector";
async function costControl(arm: Exclude<Arm, "baseline">) {
  const { profile } = await import("bun:jsc");
  const { Session } = await import("node:inspector");
  const session = new Session(); session.connect();
  const post = (method: string, params = {}) => new Promise<void>((resolve, reject) =>
    session.post(method, params, error => error ? reject(error) : resolve()));
  await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: sampleIntervalUs });
  const rows = Array.from({ length: 10_000 }, (_, id) => ({ id, value: `row-${id}` }));
  let checksum = 0;
  const batch = () => { for (let n = 0; n < 20; n++) checksum += JSON.parse(JSON.stringify(rows)).length; };
  batch();
  const before = performance.now(); batch();
  const batches = Math.max(1, Math.min(50, Math.ceil(200 / (performance.now() - before))));
  const work = async (load: "idle" | "busy") => {
    if (load === "idle") await Bun.sleep(200);
    else for (let n = 0; n < batches; n++) batch();
  };
  const measure = async (selected: Arm, load: "idle" | "busy") => {
    const start = performance.now(), cpu = process.cpuUsage();
    if (selected === "jsc") await profile(() => work(load), sampleIntervalUs);
    else if (selected === "inspector") {
      await post("Profiler.start"); await work(load); await post("Profiler.stop");
    } else await work(load);
    const used = process.cpuUsage(cpu);
    return { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 };
  };
  const measurements = [];
  const loadBefore = loadavg();
  try {
    for (const load of ["idle", "busy"] as const) {
      await measure(arm, load); await measure("baseline", load);
      for (let pair = 0; pair < 20; pair++) {
        const order: Arm[] = pair % 2 ? [arm, "baseline"] : ["baseline", arm];
        const values: Partial<Record<Arm, { wallMs: number; cpuMs: number }>> = {};
        for (const selected of order) values[selected] = await measure(selected, load);
        measurements.push({ load, pair, first: order[0], baseline: values.baseline!, sampled: values[arm]! });
      }
    }
  } finally { await post("Profiler.disable"); session.disconnect(); }
  return { runtime: process.versions.bun, revision: Bun.revision, api: arm, sampleIntervalUs,
    batches, rows: rows.length, roundsPerBatch: 20, checksum, loadBefore, loadAfter: loadavg(), measurements };
}

async function runIsolatedControl(mode: "--jsc-child" | "--cost-child", arm?: "jsc" | "inspector") {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-profiler-control-"));
  const roots = Object.fromEntries(["home", "config", "state", "tmp"].map(key => [key, path.join(directory, key)]));
  await Promise.all(Object.values(roots).map(root => mkdir(root)));
  const child = Bun.spawn([process.execPath, import.meta.path, mode, ...(arm ? [arm] : [])], {
    env: { ...process.env, HOME: roots.home, XDG_CONFIG_HOME: roots.config, LLV_STATE_DIR: roots.state,
      TMPDIR: roots.tmp, LLV_STATE_OWNER: undefined, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    stdout: "pipe", stderr: "pipe",
  });
  // This process remains runnable while the disposable target is blocked.
  const deadline = setTimeout(() => child.kill("SIGKILL"), mode === "--cost-child" ? 120_000 : 15_000);
  try {
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0 || errors || output.length > 64 * 1024) throw new Error("isolated profiler control failed");
    return JSON.parse(output);
  } finally {
    clearTimeout(deadline); child.kill("SIGKILL"); await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}
export const probeJscLoopProfiler = () => runIsolatedControl("--jsc-child");

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "--jsc-child") console.log(JSON.stringify(await jscControl()));
  else if (mode === "--cost-child") {
    const arm = process.argv[3];
    if (arm !== "jsc" && arm !== "inspector") throw new Error("unknown synthetic cost arm");
    console.log(JSON.stringify(await costControl(arm)));
  } else if (mode === "--cost") {
    const measurements = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      for (const arm of (repetition % 2 ? ["inspector", "jsc"] : ["jsc", "inspector"]) as ("jsc" | "inspector")[]) {
        measurements.push({ repetition, ...await runIsolatedControl("--cost-child", arm) });
      }
    }
    console.log(JSON.stringify({ utc: new Date().toISOString(), measurements }));
  } else if (mode === "--jsc") console.log(JSON.stringify(await probeJscLoopProfiler()));
  else console.log(JSON.stringify(await probeLoopProfiler()));
}
