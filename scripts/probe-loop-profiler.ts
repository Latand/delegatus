import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

if (import.meta.main) console.log(JSON.stringify(await probeLoopProfiler()));
