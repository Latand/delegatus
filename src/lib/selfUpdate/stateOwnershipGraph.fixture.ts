import fs from "node:fs";
import path from "node:path";

/** The modules `src/lib/stateOwnership.ts` loads, by repository path. Every
 * Delegatus process that resolves state loads this graph, so a copy of it is
 * what a checkout release built in place loads from inside its tree. */
export const STATE_OWNERSHIP_GRAPH = ["src/lib/stateOwnership.ts", "src/lib/selfUpdate/releaseHold.ts", "bin/appDir.mjs"] as const;
const REPOSITORY = path.resolve(import.meta.dir, "../../..");

/** Copy the real state-ownership module graph into `release`; returns the
 * entry module's path inside it. */
export function installStateOwnershipGraph(release: string): string {
  for (const file of STATE_OWNERSHIP_GRAPH) {
    fs.mkdirSync(path.dirname(path.join(release, file)), { recursive: true });
    fs.copyFileSync(path.join(REPOSITORY, file), path.join(release, file));
  }
  return path.join(release, STATE_OWNERSHIP_GRAPH[0]);
}

/** A Bun program, run outside the release, that imports the module named on
 * stdin and reports `ready`; it keeps only what that import leaves behind. */
export const MODULE_CONSUMER_SOURCE = `process.stdin.once("data", chunk => import(String(chunk).trim()).then(module => { globalThis.held = module; process.stdout.write("ready"); }, error => { process.stderr.write(String(error)); process.exit(3); })); setInterval(() => {}, 1000);`;

/** A Bun program taking `<release> <entry> <moved>` as its last three
 * arguments: it imports `entry` and renames `release` to `moved` once every
 * module of the graph has been read, before any of them runs: a load that
 * raced the release leaving its path. */
export const LATE_RENAME_CONSUMER_SOURCE = `
const fs = require("node:fs"), path = require("node:path");
const [release, entry, moved] = process.argv.slice(-3);
const pending = new Set(${JSON.stringify(STATE_OWNERSHIP_GRAPH)}.map(file => path.join(release, file)));
Bun.plugin({ name: "late-rename", setup(build) {
  build.onLoad({ filter: /\\.(?:ts|mjs)$/ }, args => {
    const contents = fs.readFileSync(args.path, "utf8");
    pending.delete(args.path);
    if (pending.size === 0) fs.renameSync(release, moved);
    return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
  });
}});
import(entry).then(() => { process.stdout.write("loaded"); }, error => { process.stderr.write(String(error)); process.exit(3); });
`;
