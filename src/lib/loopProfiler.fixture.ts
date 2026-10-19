import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { claimLoopProfilerDeploy, loopProfilerEnabled, loopProfilerSettings, startServingLoopProfiler } from "./loopProfilerServing";

function syntheticThreeSecondBlock() {
  const until = performance.now() + 3000;
  let value = 0;
  while (performance.now() < until) value += Math.sqrt(value + 1) % 123;
  return value;
}

if (process.argv[2] === "native" || process.argv[2] === "native-computed" || process.argv[2] === "native-compiled") {
  const lines: string[] = [];
  const settings = path.join(process.env.LLV_STATE_DIR!, "loop-profiler.json");
  // No settings file at start: the profiler arms by default after the claim.
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
} else if (process.argv[2] === "arm-window") {
  const minutes = Number(process.argv[3]);
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "loop-profiler.json"), JSON.stringify({ armMinutes: minutes }));
  let at = 0;
  Object.defineProperty(performance, "now", { value: () => at });
  const monitor = createViewerLoopMonitor();
  const results: unknown[] = [];
  monitor.setProfiler = recorder => {
    for (at of [30 * 60_000, minutes * 60_000 - 1, minutes * 60_000]) {
      recorder.correlate(at - 3000, at, 3000, value => results.push(value));
    }
    recorder.stop();
  };
  try {
    await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) });
    console.log(JSON.stringify(results));
  } finally { monitor.stop(); }
} else if (process.argv[2] === "claim") {
  console.log(JSON.stringify(await claimLoopProfilerDeploy(process.argv[3]!, process.argv[4]!, 123456)));
} else if (process.argv[2] === "host") {
  const monitor = createViewerLoopMonitor();
  await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "runtime-host", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) });
  console.log(JSON.stringify(await loopProfilerEnabled(process.argv[3]!)));
}
