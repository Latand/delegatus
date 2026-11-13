import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { claimLoopProfilerDeploy, loopProfilerEnabled, loopProfilerSettings, startServingLoopProfiler as serving } from "./loopProfilerServing";
const startServingLoopProfiler: typeof serving = (monitor, env, injected) => serving(monitor, env, Object.create(injected ?? null, { decision: { value: injected?.decision ?? (() => {}) } })); // Preserve lazy collection getters.

function syntheticThreeSecondBlock() {
  const until = performance.now() + 3000;
  let value = 0;
  while (performance.now() < until) value += Math.sqrt(value + 1) % 123;
  return value;
}

if (process.argv[2] === "native" || process.argv[2] === "native-computed" || process.argv[2] === "native-compiled") {
  const lines: string[] = [];
  const settings = path.join(process.env.LLV_STATE_DIR!, "loop-profiler.json");
  // Request a bounded manual capture in this private fixture process.
  fs.writeFileSync(settings, JSON.stringify({ manualUntil: Date.now() + 60_000 }));
  let start = startServingLoopProfiler;
  let compiledBlock: (() => number) | undefined;
  if (process.argv[2] === "native-compiled") {
    // Exercise Next's actual emitted native-import path, including its
    // dependency graph. Registering chunk definitions executes no modules.
    const require = createRequire(import.meta.url);
    require(path.resolve(".next/server/instrumentation.js"));
    const runtime = require(path.resolve(".next/server/webpack-runtime.js"));
    let moduleId: string | undefined;
    for (const file of fs.readdirSync(".next/server/chunks", { recursive: true }).filter(file => typeof file === "string" && file.endsWith(".js")).sort()) {
      const chunk = require(path.resolve(".next/server/chunks", String(file)));
      if (!chunk.modules) continue;
      runtime.C(chunk);
      for (const [id, body] of Object.entries(chunk.modules)) {
        const code = String(body);
        if (/\bexports\.startServingLoopProfiler\s*=/.test(code)
          || /\bstartServingLoopProfiler\s*:\s*\(\)\s*=>/.test(code)) moduleId = id;
      }
    }
    if (!moduleId) throw new Error("compiled profiler export absent");
    const compiled = runtime(moduleId);
    start = compiled.startServingLoopProfiler;
    compiledBlock = compiled.syntheticThreeSecondBlockForProfilerFixture;
    if (typeof start !== "function" || typeof compiledBlock !== "function") throw new Error("compiled profiler exports are incomplete");
  }
  const monitor = createViewerLoopMonitor(line => {
    lines.push(line);
    if (line.includes('"jsProfile"')) fs.writeFileSync(settings, JSON.stringify({ enabled: false }));
  });
  const ticker = setInterval(() => monitor.tick(), 10);
  const blockWork = process.argv[2] === "native-computed"
    ? () => {
      const marker = "privateSyntheticMarker";
      const computed = { [marker]() {
        const until = performance.now() + 3000;
        let value = 0;
        while (performance.now() < until) value += Math.sqrt(value + 1) % 123;
        return value;
      } };
      computed[marker]();
    }
    : compiledBlock ?? syntheticThreeSecondBlock;
  let block: ReturnType<typeof setTimeout> | undefined;
  const run = monitor.run;
  monitor.run = (operation, work) => {
    // Schedule the block only once collection has reached the native profiler.
    if (operation === "loop-profiler.collect" && !block) block = setTimeout(blockWork, 0);
    return run(operation, work);
  };
  try { await start(monitor, { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) }); console.log(JSON.stringify(lines)); }
  finally { if (block) clearTimeout(block); clearInterval(ticker); monitor.stop(); }
} else if (process.argv[2] === "disabled") {
  const lines: string[] = [];
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "loop-profiler.json"), JSON.stringify({ enabled: false }));
  const monitor = createViewerLoopMonitor(line => { lines.push(line); });
  try { await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) }); console.log(JSON.stringify(lines)); }
  finally { monitor.stop(); }
} else if (process.argv[2] === "trim-cost") {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
  const { trimLoopProfile } = await import("./loopProfiler");
  const root = path.join(process.env.LLV_STATE_DIR!, "trim-cost");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  const measurements = [];
  for (const varied of [false, true]) {
    const files = varied ? 8 : 1, functions = varied ? 64 : 32;
    const frames = Array.from({ length: files }, (_, file) => {
      const sourceURL = path.join(root, "scripts", `loop-profile-fixture-${file}.ts`);
      fs.writeFileSync(sourceURL, Array.from({ length: functions }, (_, n) => `function f${n}() {}`).join("\n"));
      return Array.from({ length: functions }, (_, n) => ({ name: `f${n}`, sourceURL, line: n + 1, column: 1 }));
    }).flat();
    const traces = Array.from({ length: 4096 }, (_, t) => ({ frames: Array.from({ length: 32 }, (_, d) => frames[varied ? (t * 7 + d) % frames.length : d]!) }));
    const weights = new Map(frames.map(frame => [`${path.relative(root, frame.sourceURL)}:${frame.line}`, { self: 0, total: 0 }]));
    for (const trace of traces) for (const [depth, frame] of trace.frames.entries()) {
      const weight = weights.get(`${path.relative(root, frame.sourceURL)}:${frame.line}`)!;
      if (depth === 0) weight.self++;
      weight.total++;
    }
    const ms = [];
    for (let run = 0; run < 6; run++) {
      const startedAt = performance.now();
      const result = trimLoopProfile({ traces }, root);
      ms.push(performance.now() - startedAt);
      assert.equal(result.rows.length, 16);
      assert.equal(result.inspectedSamples, 4096);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192 - 512);
      for (const row of result.rows) {
        assert.equal(row.column, 1);
        assert.ok(row.file.startsWith("scripts/loop-profile-fixture-"));
        const expected = weights.get(`${row.file}:${row.line}`)!;
        assert.equal(row.function, `f${row.line - 1}`);
        assert.equal(row.self, expected.self); assert.equal(row.total, expected.total);
      }
    }
    measurements.push({ files, distinctFrames: frames.length, traces: 4096, depth: 32, retainedRows: 16, ms });
  }
  console.log(JSON.stringify({ bun: process.versions.bun, measurements }));
} else if (process.argv[2] === "settings") {
  const messages: string[] = [];
  const settings = await loopProfilerSettings(process.env.LLV_STATE_DIR!, message => messages.push(message));
  console.log(JSON.stringify({ ...settings, messages }));
} else if (process.argv[2] === "idle-arm-cost") {
  const measurements = [];
  let checksum = 0;
  for (let pair = 0; pair < 8; pair++) {
    for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "loop-profiler.json"), JSON.stringify({ enabled }));
      let at = 1_000_000;
      let captures = 0;
      const monitor = createViewerLoopMonitor(() => {}, () => at);
      const supervisor = await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) }, {
        now: () => at, wallNow: () => at, poll: false, collect: async () => { captures++; throw new Error("idle collection"); },
      });
      const cpu = process.cpuUsage(), start = performance.now();
      for (let tick = 0; tick < 1000; tick++) {
        for (let i = 0; i < 5000; i++) checksum = (checksum + i) | 0;
        // One settings poll per 100 healthy 10 ms turns, as in serving.
        for (let turn = 0; turn < 100; turn++) { at += 10; monitor.tick(); }
        await supervisor!.refresh();
      }
      const used = process.cpuUsage(cpu);
      if (captures !== 0) throw new Error("idle collection");
      measurements.push({ pair, enabled, polls: 1000, ticks: 100000, wallMs: performance.now() - start,
        cpuMs: (used.user + used.system) / 1000, captures });
      monitor.stop();
    }
  }
  console.log(JSON.stringify({ bun: process.versions.bun, checksum, measurements }));
} else if (process.argv[2] === "lifetime") {
  let at = Number(process.argv[3]);
  const gapMs = Number(process.argv[4]);
  const directory = process.env.LLV_STATE_DIR!;
  const reasons: string[] = [];
  let calls = 0;
  const monitor = createViewerLoopMonitor(() => {}, () => at);
  try {
    const supervisor = await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) }, {
      now: () => at, wallNow: () => at, decision: reason => reasons.push(reason),
      sleep: async ms => { at += ms; },
      get collect() {
        if (process.argv[5] === "late-load") at += 600_000;
        if (process.argv[5] === "late-kill") fs.writeFileSync(path.join(directory, "loop-profiler.json"), JSON.stringify({ enabled: false }));
        if (process.argv[5] === "late-automatic-off") fs.writeFileSync(path.join(directory, "loop-profiler.json"), JSON.stringify({ automatic: false }));
        if (process.argv[5] === "late-manual-expiry") at += 60_000;
        return async (work: () => Promise<void>) => { calls++; await work(); return { stackTraces: { traces: [] } }; };
      },
    });
    if (process.argv[5] === "manual-switch") {
      fs.writeFileSync(path.join(directory, "loop-profiler.json"), JSON.stringify({ enabled: true, automatic: false, manualUntil: at + 30_000 }));
      await supervisor?.refresh();
      at += 30_000; await supervisor?.refresh();
    }
    at += gapMs + 10; monitor.tick(); await supervisor?.refresh();
    let profiles = 0;
    try { profiles = JSON.parse(fs.readFileSync(path.join(directory, "loop-profiler-captures.json"), "utf8")).profiles.length; } catch { /* no capture */ }
    console.log(JSON.stringify({ calls, profiles, reasons }));
  } finally { monitor.stop(); }
} else if (process.argv[2] === "claim") {
  console.log(JSON.stringify(await claimLoopProfilerDeploy(process.argv[3]!, process.argv[4]!, 123456)));
} else if (process.argv[2] === "host") {
  const monitor = createViewerLoopMonitor();
  await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "runtime-host", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) });
  console.log(JSON.stringify(await loopProfilerEnabled(process.argv[3]!)));
}
