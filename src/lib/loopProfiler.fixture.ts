import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { claimLoopProfilerDeploy, loopProfilerEnabled, startServingLoopProfiler } from "./loopProfilerServing";

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
  const block = process.argv[2] === "native-computed"
    ? setTimeout(() => {
      const marker = "privateSyntheticMarker";
      const computed = { [marker]() {
        const until = performance.now() + 3000;
        let value = 0;
        while (performance.now() < until) value += Math.sqrt(value + 1) % 123;
        return value;
      } };
      computed[marker]();
    }, 100)
    : setTimeout(compiledBlock ?? syntheticThreeSecondBlock, 100);
  try { await start(monitor, { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) }); console.log(JSON.stringify(lines)); }
  finally { clearTimeout(block); clearInterval(ticker); monitor.stop(); }
} else if (process.argv[2] === "disabled") {
  const lines: string[] = [];
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "loop-profiler.json"), JSON.stringify({ enabled: false }));
  const monitor = createViewerLoopMonitor(line => { lines.push(line); });
  try { await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) }); console.log(JSON.stringify(lines)); }
  finally { monitor.stop(); }
} else if (process.argv[2] === "claim") {
  console.log(JSON.stringify(await claimLoopProfilerDeploy(process.argv[3]!, process.argv[4]!, 123456)));
} else if (process.argv[2] === "host") {
  const monitor = createViewerLoopMonitor();
  await startServingLoopProfiler(monitor, { ...process.env, LLV_STATE_OWNER: "runtime-host", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) });
  console.log(JSON.stringify(await loopProfilerEnabled(process.argv[3]!)));
}
