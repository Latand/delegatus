import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Keep each compiler's resolver and plugin state in its own process. Repeated
// in-process builds can fail alias resolution on the pinned Bun even though
// the same entry builds alone. The child compiles source without executing it.
const buildSource = String.raw`
  const [entrypoint, forbidden] = process.argv.slice(-2);
  const source = "src/lib/" + entrypoint;
  const result = await Bun.build({
    entrypoints: [source],
    target: "bun",
    plugins: [{
      name: "independent-worker-storage",
      setup(build) {
        if (forbidden) build.onLoad({ filter: /\.ts$/ }, async ({ path: file }) => {
          if (file !== Bun.resolveSync("./" + source, process.cwd())) return;
          return { contents: 'import "' + forbidden + '";\n' + await Bun.file(file).text(), loader: "ts" };
        });
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

function compile(entrypoint: string, forbidden = "") {
  return spawnSync(process.execPath, ["--eval", buildSource, entrypoint, forbidden], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

for (const entrypoint of [
  "transfer/sections.ts",
  "voiceCompanion/sessionValidation.ts",
  "voiceCompanion/storage.ts",
  "keys/reading.ts",
]) test(`${entrypoint} builds without the key connection service`, () => {
  const child = compile(entrypoint);
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(Number(child.stdout.trim())).toBeGreaterThan(0);
});

for (const [entrypoint, forbidden] of [
  ["transfer/sections.ts", "next/server"],
  ["transfer/sections.ts", "@/lib/voiceCompanion/storage"],
  ["voiceCompanion/sessionValidation.ts", "@/lib/voiceCompanion/storage"],
  ["voiceCompanion/storage.ts", "@/lib/keys/store"],
  ["keys/reading.ts", "@/lib/telegram/bot/service"],
]) test(`${entrypoint} rejects an injected ${forbidden} dependency`, () => {
  const child = compile(entrypoint, forbidden);
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(1);
  expect(child.stderr).toContain("dependency: " + forbidden);
});
