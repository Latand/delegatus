import { expect, test } from "bun:test";
import path from "node:path";

for (const entrypoint of [
  "transfer/sections.ts",
  "voiceCompanion/sessionValidation.ts",
  "voiceCompanion/storage.ts",
  "keys/reading.ts",
]) test(`${entrypoint} builds without the key connection service`, async () => {
  const result = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "..", entrypoint)],
    target: "bun",
    plugins: [{
      name: "independent-worker-storage",
      setup(build) {
        build.onResolve({ filter: /(?:keys\/store|telegram\/bot\/service)$/ }, ({ path: dependency }) => {
          throw new Error(`Server connection dependency: ${dependency}`);
        });
        if (entrypoint !== "voiceCompanion/storage.ts") {
          build.onResolve({ filter: /^(?:next(?:\/|$)|.*voiceCompanion\/storage$)/ }, ({ path: dependency }) => {
            throw new Error(`Worker validation dependency: ${dependency}`);
          });
        }
      },
    }],
  });
  expect(result.logs).toEqual([]);
  expect(result.success).toBe(true);
  expect(result.outputs.length).toBeGreaterThan(0);
});
