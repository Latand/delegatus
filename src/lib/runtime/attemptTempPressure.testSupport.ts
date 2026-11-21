import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "bun:test";
import { AttemptTempStore, ATTEMPT_TEMP_LOW_SPACE_BYTES } from "./attemptTempRetention";
import { WorktreeSweepWorker } from "../pipelines/worktreeSweepWorker";
import { statePath } from "../configDir";
import { removeKeepMarkers } from "./keepMarker.testSupport";
import { sweepMonotonicNow } from "./attemptTempDeadline";

export const NOW = Date.parse("2030-01-20T00:00:00Z");
export const roots: string[] = [];
export function realParentWorker(realClock = false, timeoutMs = 60_000) {
  return new WorktreeSweepWorker({ executable: process.execPath, entry: "--preload",
    args: [path.join(import.meta.dir, "attemptTempPressure.preload.ts"), path.join(import.meta.dir, "../worktreeSweep.worker.ts")] },
  timeoutMs, { now: realClock ? sweepMonotonicNow : () => 0, setTimeout, clearTimeout });
}
export async function realParentPass(realClock = false) {
  const worker = realParentWorker(realClock);
  try { return await worker.attemptTemp() as NonNullable<Awaited<ReturnType<typeof import("./attemptTempProduction").runAttemptTempSweep>>>;
  } finally { await worker.close(); }
}
export function restoreEnvironment(original: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
export function cleanupPressureFixtures() { removeKeepMarkers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(statePath("report-media"), { recursive: true, force: true }); }
export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-retention-")); roots.push(root);
  const store = new AttemptTempStore(path.join(root, "attempt-temp.sqlite"));
  const make = (id: string, createdAt = NOW - 1000, pipelineId: string | null = null) => {
    const directory = path.join(root, `llv-stage-${id}`); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
    store.register({ directory, pipelineId, launchId: id, retainUntilClose: false, createdAt });
    store.measure(directory, 12288);
    return directory;
  };
  const options = { now: () => NOW, state: async () => "closed" as const,
    scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true,
    availableBytes: () => ATTEMPT_TEMP_LOW_SPACE_BYTES };
  return { root, store, make, options };
}

/** Every ledger row for a root directly under `scratch`. */
export function ledgerRoots(store: AttemptTempStore, scratch: string) {
  return fs.readdirSync(scratch).filter(name => name.startsWith("llv-stage-")).sort()
    .map(name => store.owner(path.join(scratch, name))).filter(owner => owner !== null);
}

export function nativeFenceDeferrals(report: { outcomes: { directory: string; reason: string }[] }, store: AttemptTempStore) {
  const refused = new Set<string>();
  for (const row of report.outcomes) {
    if (!row.reason.includes("attempt mutation fence mount namespace changed")) continue;
    const owner = store.owner(row.directory), stat = fs.statSync(row.directory);
    expect(owner).not.toBeNull(); expect(`${stat.dev}:${stat.ino}`).toBe(owner!.identity);
    expect(fs.readFileSync(path.join(row.directory, "data")).length).toBe(4096);
    refused.add(row.directory);
  }
  return refused;
}
