import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Keep each compiler's resolver and plugin state in its own process. Repeated
// in-process builds can fail alias resolution on the pinned Bun even though
// the same entry builds alone. The child compiles source without executing it.
const buildSource = String.raw`
  const entrypoint = process.argv.at(-1);
  const result = await Bun.build({
    entrypoints: ["src/lib/" + entrypoint],
    target: "bun",
    plugins: [{
      name: "independent-worker-storage",
      setup(build) {
        build.onResolve({ filter: /(?:keys\/store|telegram\/bot\/service)$/ }, ({ path: dependency }) => {
          throw new Error("Server connection dependency: " + dependency);
        });
        if (entrypoint !== "voiceCompanion/storage.ts") {
          build.onResolve({ filter: /^(?:next(?:\/|$)|.*voiceCompanion\/storage$)/ }, ({ path: dependency }) => {
            throw new Error("Worker validation dependency: " + dependency);
          });
        }
      },
    }],
  });
  for (const log of result.logs) console.error(log);
  if (!result.success || result.logs.length || !result.outputs.length) process.exit(1);
  console.log(result.outputs.length);
`;

for (const entrypoint of [
  "transfer/sections.ts",
  "voiceCompanion/sessionValidation.ts",
  "voiceCompanion/storage.ts",
  "keys/reading.ts",
]) test(`${entrypoint} builds without the key connection service`, () => {
  const child = spawnSync(process.execPath, ["--eval", buildSource, entrypoint], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(Number(child.stdout.trim())).toBeGreaterThan(0);
});
