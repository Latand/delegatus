// Fixture-only process seams for the real sweep helper. No production entry
// imports this file; the parent test supplies it through --preload.
import fs from "node:fs";
import path from "node:path";
import { spyOn } from "bun:test";
import * as tempSweep from "../tempSweep";
import * as filesystem from "./attemptTempFilesystem";
import { attemptTempRemaining } from "./attemptTempDeadline";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";
import { agentRegistry } from "../agent/registry";
import * as mutation from "./attemptMutationFence";
import * as removal from "./attemptTempRemoval";
import * as retention from "./attemptTempRetention";

const fixture = process.env.LLV_PRESSURE_FIXTURE;
if (!fixture) throw new Error("pressure fixture requires an isolated root");
const config = JSON.parse(fs.readFileSync(fixture, "utf8")) as { now: number; freeBytes: number;
  partialMeasurement?: "timeout" | "permission-denied";
  resumeDuringPass?: string;
  /** Fixture milliseconds each allocation measurement spends. */
  measureCost?: number;
  fixtureMutationFence?: boolean;
  fixtureRemoval?: boolean;
  forbidFullMeasurement?: boolean;
  realClock?: boolean;
  pressureInventory?: boolean;
  stallMeasurement?: string;
  stalledMeasurement?: string;
  tickClock?: boolean;
  slowProof?: { phase: "allocation" | "protection"; prefix: number; requiredCost?: number; timeoutPrefix?: number }; windows?: number[]; elapsed?: number };
// Exercise the lower-level pressure inventory inside the leased test helper.
// The production completion-age check still governs every retirement.
if (config.pressureInventory) {
  const sweep = retention.sweepAttemptTemps;
  spyOn(retention, "sweepAttemptTemps").mockImplementation((store, options) =>
    sweep(store, { ...options, scheduledOnly: undefined }));
}
let elapsed = 0;
// Large cursor fixtures own every mutation. Native watcher races have their
// own real-kernel tests; ambient mount churn is outside this fixture's clock.
if (config.fixtureMutationFence) spyOn(mutation, "attemptMutationCurrent").mockImplementation((_directories, read) => read());
if (config.fixtureRemoval) spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (directory, started) => {
  const scratch = process.env.LLV_STATE_DIR && path.join(process.env.LLV_STATE_DIR, "scratch");
  if (!scratch || !directory.startsWith(scratch + path.sep) || !path.basename(directory).startsWith(".delegatus-trash-"))
    throw new Error("fixture removal escaped its owned scratch quarantine");
  started(); await fs.promises.rm(directory, { recursive: true });
});
const delay = (directory: string, phase: "allocation" | "protection", budgetMs = Infinity) => {
  const index = /^llv-stage-(\d+)$/.exec(directory.split(/[\\/]/).at(-1) ?? "")?.[1];
  if (config.slowProof?.phase !== phase || index === undefined || Number(index) >= config.slowProof.prefix) return;
  const window = Math.min(budgetMs, attemptTempRemaining());
  if (Number(index) >= (config.slowProof.timeoutPrefix ?? 0)
    && config.slowProof.requiredCost !== undefined && config.slowProof.requiredCost <= window) {
    elapsed += config.slowProof.requiredCost;
    config.windows = [...(config.windows ?? []), window]; config.elapsed = elapsed;
    fs.writeFileSync(fixture, JSON.stringify(config));
    return;
  }
  elapsed += Math.floor(window) + 1;
  config.windows = [...(config.windows ?? []), window]; config.elapsed = elapsed;
  fs.writeFileSync(fixture, JSON.stringify(config));
  throw new AttemptTempBudgetDeferred(`fixture slow ${phase} exhausted its bounded window`);
};
const refreshTickClock = () => {
  if (!config.tickClock) return;
  const next = JSON.parse(fs.readFileSync(fixture, "utf8")) as { now: number };
  if (next.now !== config.now) { config.now = next.now; elapsed = 0; }
};
spyOn(Date, "now").mockImplementation(() => { refreshTickClock(); return config.now + elapsed; });
if (!config.realClock) {
  spyOn(process.hrtime, "bigint").mockImplementation(() => { refreshTickClock(); return BigInt(elapsed) * BigInt(1_000_000); });
  spyOn(performance, "now").mockImplementation(() => { refreshTickClock(); return elapsed; });
}
spyOn(fs, "statfsSync").mockImplementation((() => ({ bavail: config.freeBytes, bsize: 1 }) as fs.StatsFs) as unknown as typeof fs.statfsSync);
spyOn(tempSweep, "scanProcesses").mockImplementation(() => ({ ownNamespace: null, processes: [] }));
// Exercise tree protection, claims, quarantine, dispatch and native removal.
// The fixture has no consumer processes, sockets or container mounts.
let referenceReads = 0;
spyOn(filesystem, "attemptReferencesClear").mockImplementation(async () => {
  if (config.resumeDuringPass && ++referenceReads === 2) {
    const registry = agentRegistry(), receipt = registry.spawnReceipt(config.resumeDuringPass);
    if (!receipt?.key) throw new Error("resume fixture requires a native key");
    registry.setStructuredHost(receipt.key, null, "starting");
    delete config.resumeDuringPass;
  }
  return true;
});
const measure = filesystem.measureAttemptAllocation;
spyOn(filesystem, "measureAttemptAllocation").mockImplementation(async (...args) => {
  if (config.stallMeasurement === path.basename(args[0])) {
    delete config.stallMeasurement;
    config.stalledMeasurement = path.basename(args[0]);
    fs.writeFileSync(fixture, JSON.stringify(config));
    // An unresponsive observer is deliberately cancelled by the real parent.
    // No deletion, mutation fence or clock is replaced by this seam.
    await new Promise<never>(() => {});
  }
  if (config.forbidFullMeasurement && !args[1]?.recordedOnly) throw new AttemptTempBudgetDeferred("fixture forbids a full allocation walk");
  if (config.partialMeasurement) {
    if (config.partialMeasurement === "timeout") elapsed += Math.floor(attemptTempRemaining()) + 1;
    return { bytes: 4096, unreadable: true };
  }
  delay(args[0], "allocation", args[1]?.budgetMs);
  const result = await measure(...args);
  elapsed += config.measureCost ?? 25;
  return result;
});
const protection = filesystem.snapshotAttemptProtection;
spyOn(filesystem, "snapshotAttemptProtection").mockImplementation(async (...args) => {
  delay(args[0], "protection", args[1]);
  return protection(...args);
});
