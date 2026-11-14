// Fixture-only process seams for the real sweep helper. No production entry
// imports this file; the parent test supplies it through --preload.
import fs from "node:fs";
import { spyOn } from "bun:test";
import * as tempSweep from "../tempSweep";
import * as filesystem from "./attemptTempFilesystem";

const fixture = process.env.LLV_PRESSURE_FIXTURE;
if (!fixture) throw new Error("pressure fixture requires an isolated root");
const config = JSON.parse(fs.readFileSync(fixture, "utf8")) as { now: number; freeBytes: number };
let elapsed = 0;
spyOn(Date, "now").mockImplementation(() => config.now + elapsed);
spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(elapsed) * 1_000_000n);
spyOn(performance, "now").mockImplementation(() => elapsed);
spyOn(fs, "statfsSync").mockImplementation(() => ({ bavail: config.freeBytes, bsize: 1 }) as fs.StatsFs);
spyOn(tempSweep, "scanProcesses").mockImplementation(() => ({ ownNamespace: null, processes: [] }));
// Exercise tree protection, claims, quarantine, dispatch and native removal.
// The fixture has no consumer processes, sockets or container mounts.
spyOn(filesystem, "attemptReferencesClear").mockImplementation(async () => true);
const measure = filesystem.measureAttemptAllocation;
spyOn(filesystem, "measureAttemptAllocation").mockImplementation(async (...args) => {
  const result = await measure(...args);
  elapsed += 25;
  return result;
});
