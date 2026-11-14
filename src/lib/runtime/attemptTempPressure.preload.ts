// Fixture-only process seams for the real sweep helper. No production entry
// imports this file; the parent test supplies it through --preload.
import fs from "node:fs";
import { spyOn } from "bun:test";
import * as tempSweep from "../tempSweep";
import * as filesystem from "./attemptTempFilesystem";
import { attemptTempRemaining } from "./attemptTempDeadline";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

const fixture = process.env.LLV_PRESSURE_FIXTURE;
if (!fixture) throw new Error("pressure fixture requires an isolated root");
const config = JSON.parse(fs.readFileSync(fixture, "utf8")) as { now: number; freeBytes: number;
  slowProof?: { phase: "allocation" | "protection"; prefix: number }; windows?: number[]; elapsed?: number };
let elapsed = 0;
const delay = (directory: string, phase: "allocation" | "protection", budgetMs = Infinity) => {
  const index = /^llv-stage-(\d+)$/.exec(directory.split(/[\\/]/).at(-1) ?? "")?.[1];
  if (config.slowProof?.phase !== phase || index === undefined || Number(index) >= config.slowProof.prefix) return;
  const window = Math.min(5000, budgetMs, attemptTempRemaining());
  elapsed += Math.floor(window) + 1;
  config.windows = [...(config.windows ?? []), window]; config.elapsed = elapsed;
  fs.writeFileSync(fixture, JSON.stringify(config));
  throw new AttemptTempBudgetDeferred(`fixture slow ${phase} exhausted its bounded window`);
};
spyOn(Date, "now").mockImplementation(() => config.now + elapsed);
spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(elapsed) * BigInt(1_000_000));
spyOn(performance, "now").mockImplementation(() => elapsed);
spyOn(fs, "statfsSync").mockImplementation((() => ({ bavail: config.freeBytes, bsize: 1 }) as fs.StatsFs) as typeof fs.statfsSync);
spyOn(tempSweep, "scanProcesses").mockImplementation(() => ({ ownNamespace: null, processes: [] }));
// Exercise tree protection, claims, quarantine, dispatch and native removal.
// The fixture has no consumer processes, sockets or container mounts.
spyOn(filesystem, "attemptReferencesClear").mockImplementation(async () => true);
const measure = filesystem.measureAttemptAllocation;
spyOn(filesystem, "measureAttemptAllocation").mockImplementation(async (...args) => {
  delay(args[0], "allocation", args[1]?.budgetMs);
  const result = await measure(...args);
  elapsed += 25;
  return result;
});
const protection = filesystem.snapshotAttemptProtection;
spyOn(filesystem, "snapshotAttemptProtection").mockImplementation(async (...args) => {
  delay(args[0], "protection", args[1]);
  return protection(...args);
});
