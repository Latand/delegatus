import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { SeatTickCard } from "@/lib/monitor/types";
import {
  MEMORY_SWEEP_MIN_INTERVAL_MS, TMPFS_MAGIC, currentMemoryPressure, memoryPressureLine, memoryPressureNoticeText, memoryPressureSignals,
  memoryThresholds, observeMemoryPressure, observeMemoryPressureReport, parseMeminfo, readMemoryPressureReport,
  readMemoryReading, reconcileMemoryPressure, type MemoryPressure, type MemoryPressureActions, type MemoryReading,
} from "./memoryPressure";

const GIB = 1024 ** 3;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-pressure-"));
  roots.push(root);
  return root;
}

function meminfo(totalKib: number, availableKib: number, swapTotalKib: number, swapFreeKib: number): string {
  return [`MemTotal:       ${totalKib} kB`, `MemFree:         1024 kB`, `MemAvailable:   ${availableKib} kB`,
    `Buffers:          512 kB`, `SwapCached:       0 kB`, `SwapTotal:      ${swapTotalKib} kB`, `SwapFree:       ${swapFreeKib} kB`, ""].join("\n");
}

/** A reading with swap `swapUsed` of 32 GiB and a /tmp of `tmpUsed` bytes. */
function reading(swapUsedGib: number, tmpUsedBytes: number, tmpfs = true): MemoryReading {
  return {
    ram: { usedBytes: 20 * GIB, totalBytes: 64 * GIB },
    swap: { usedBytes: swapUsedGib * GIB, totalBytes: 32 * GIB },
    tmp: { usedBytes: tmpUsedBytes, totalBytes: 32 * GIB, tmpfs, view: "own" },
  };
}

const thresholds = memoryThresholds({});

test("meminfo gives RAM in use as total minus available and swap as total minus free", () => {
  const parsed = parseMeminfo(meminfo(64 * 1024 * 1024, 40 * 1024 * 1024, 32 * 1024 * 1024, 3 * 1024 * 1024));
  expect(parsed).toEqual({ ram: { usedBytes: 24 * GIB, totalBytes: 64 * GIB }, swap: { usedBytes: 29 * GIB, totalBytes: 32 * GIB } });
  expect(parseMeminfo("MemTotal: 1 kB\n")).toBeNull();
});

test("the local reading names the machine's /tmp by its statfs magic and never reports a container's /tmp", () => {
  const text = meminfo(8 * 1024 * 1024, 4 * 1024 * 1024, 0, 0);
  const seen: string[] = [];
  const statfs = (type: number) => (directory: string) => { seen.push(directory); return { type, blocks: 1000, bfree: 250, bsize: 4096 }; };
  expect(readMemoryReading({ env: {}, meminfo: () => text, statfs: statfs(TMPFS_MAGIC) })!.tmp)
    .toEqual({ usedBytes: 750 * 4096, totalBytes: 1000 * 4096, tmpfs: true, view: "own" });
  expect(readMemoryReading({ env: {}, meminfo: () => text, statfs: statfs(0xef53) })!.tmp?.tmpfs).toBeFalse();
  seen.length = 0;
  expect(readMemoryReading({ env: { LLV_DOCKER_NSENTER_SHIMS: "1" }, meminfo: () => text, statfs: statfs(TMPFS_MAGIC) })!.tmp).toBeNull();
  expect(seen).toEqual([]);
  expect(readMemoryReading({ env: {}, meminfo: () => text, statfs: () => { throw new Error("gone"); } })!.tmp).toBeNull();
  expect(readMemoryReading({ env: {}, meminfo: () => { throw new Error("no proc"); } })).toBeNull();
  expect(readMemoryReading({ env: {}, meminfo: () => "MemTotal: 1 kB\n" })).toBeNull();
});

test("thresholds default to half the swap and 4 GB of tmpfs, and accept only sane overrides", () => {
  expect(thresholds).toEqual({ swapWarnPercent: 50, tmpWarnBytes: 4e9 });
  expect(memoryThresholds({ LLV_MEMORY_SWAP_WARN_PERCENT: "80", LLV_TMPFS_WARN_GB: "2.5" })).toEqual({ swapWarnPercent: 80, tmpWarnBytes: 2.5e9 });
  expect(memoryThresholds({ LLV_MEMORY_SWAP_WARN_PERCENT: "0", LLV_TMPFS_WARN_GB: "lots" })).toEqual(thresholds);
  expect(memoryThresholds({ LLV_MEMORY_SWAP_WARN_PERCENT: "101", LLV_TMPFS_WARN_GB: "-1" })).toEqual(thresholds);
});

test("swap above half or a tmpfs /tmp above 4 GB opens one episode, and only well below the line closes it", () => {
  const at = (minute: number) => `2026-11-26T10:${String(minute).padStart(2, "0")}:00Z`;
  // At the line exactly is not over it; a disk-backed /tmp never counts.
  expect(observeMemoryPressure(reading(16, 4e9), null, at(0), thresholds).episode).toBeNull();
  expect(observeMemoryPressure(reading(1, 9e9, false), null, at(0), thresholds).episode).toBeNull();
  // No swap configured is never swap pressure.
  expect(observeMemoryPressure({ ...reading(0, 0), swap: { usedBytes: 0, totalBytes: 0 } }, null, at(0), thresholds).reasons).toEqual([]);

  const swap = observeMemoryPressure(reading(17, 1e9), null, at(1), thresholds);
  expect(swap).toMatchObject({ episode: at(1), reasons: ["swap"] });
  const tmp = observeMemoryPressure(reading(1, 4.1e9), null, at(1), thresholds);
  expect(tmp).toMatchObject({ episode: at(1), reasons: ["tmp"] });

  // Hovering just under the line keeps the episode and its start.
  const both = observeMemoryPressure(reading(15, 3.7e9), swap, at(2), thresholds);
  expect(both).toMatchObject({ episode: at(1), reasons: ["swap", "tmp"] });
  // Below 90% of each threshold the episode ends; a later rise is a new one.
  const recovered = observeMemoryPressure(reading(14, 3.5e9), both, at(3), thresholds);
  expect(recovered).toMatchObject({ episode: null, reasons: [] });
  expect(observeMemoryPressure(reading(20, 0), recovered, at(4), thresholds).episode).toBe(at(4));
});

/** A Viewer restart: a new process reading the same report file. */
function observedByANewProcess(file: string, value: MemoryReading, at: string): MemoryPressure {
  const source = `import { observeMemoryPressureReport } from ${JSON.stringify(path.join(import.meta.dir, "memoryPressure.ts"))};
    console.log(JSON.stringify(observeMemoryPressureReport(${JSON.stringify(value)}, ${JSON.stringify(at)}, {}, ${JSON.stringify(file)})));`;
  const child = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 30_000 });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!);
}

test("the report is written when the episode or its reasons change, and a restarted Viewer continues from it", () => {
  const file = path.join(scratch(), "memory-pressure-report.json");
  // A calm machine writes nothing.
  expect(observeMemoryPressureReport(reading(1, 0), "2026-11-26T09:59:00Z", {}, file).episode).toBeNull();
  expect(fs.existsSync(file)).toBeFalse();
  const opened = observeMemoryPressureReport(reading(20, 0), "2026-11-26T10:00:00Z", {}, file);
  expect(readMemoryPressureReport(file)?.at).toBe("2026-11-26T10:00:00Z");
  // The same episode and reasons: the file keeps the reading it was written with.
  expect(observeMemoryPressureReport(reading(15, 0), "2026-11-26T10:01:00Z", {}, file).episode).toBe(opened.episode);
  expect(readMemoryPressureReport(file)?.at).toBe("2026-11-26T10:00:00Z");
  expect(observedByANewProcess(file, reading(15, 0), "2026-11-26T10:02:00Z").episode).toBe(opened.episode);
  expect(observeMemoryPressureReport(reading(20, 5e9), "2026-11-26T10:03:00Z", {}, file).reasons).toEqual(["swap", "tmp"]);
  expect(readMemoryPressureReport(file)).toMatchObject({ at: "2026-11-26T10:03:00Z", reasons: ["swap", "tmp"] });
  expect(observeMemoryPressureReport(reading(1, 0), "2026-11-26T10:04:00Z", {}, file).episode).toBeNull();
  expect(readMemoryPressureReport(file)).toMatchObject({ at: "2026-11-26T10:04:00Z", episode: null });
  expect(observedByANewProcess(file, reading(15, 0), "2026-11-26T10:05:00Z").episode).toBeNull();
  // A damaged file starts a new episode and is replaced.
  fs.writeFileSync(file, "{\"at\":1}");
  expect(readMemoryPressureReport(file)).toBeNull();
  expect(observeMemoryPressureReport(reading(20, 0), "2026-11-26T10:06:00Z", {}, file).episode).toBe("2026-11-26T10:06:00Z");
  expect(readMemoryPressureReport(file)?.at).toBe("2026-11-26T10:06:00Z");
});

test("a write the disk refuses keeps the episode in memory and is retried", () => {
  const file = path.join(scratch(), "memory-pressure-report.json");
  const refused = spyOn(fs, "writeFileSync").mockImplementation(() => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); });
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(observeMemoryPressureReport(reading(20, 0), "2026-11-26T10:00:00Z", {}, file).episode).toBe("2026-11-26T10:00:00Z");
    expect(observeMemoryPressureReport(reading(15, 0), "2026-11-26T10:01:00Z", {}, file).episode).toBe("2026-11-26T10:00:00Z");
    expect(warned).toHaveBeenCalled();
  } finally { refused.mockRestore(); warned.mockRestore(); }
  expect(fs.existsSync(file)).toBeFalse();
  observeMemoryPressureReport(reading(15, 0), "2026-11-26T10:02:00Z", {}, file);
  expect(readMemoryPressureReport(file)?.episode).toBe("2026-11-26T10:00:00Z");
});

test("a /tmp that cannot be read keeps its open warning", () => {
  const at = "2026-11-26T10:00:00Z";
  const hot = observeMemoryPressure(reading(1, 5e9), null, at, thresholds);
  const blind = observeMemoryPressure({ ...reading(1, 0), tmp: null }, hot, "2026-11-26T10:01:00Z", thresholds);
  expect(blind).toMatchObject({ episode: at, reasons: ["tmp"] });
  expect(observeMemoryPressure(reading(1, 0), blind, "2026-11-26T10:02:00Z", thresholds).episode).toBeNull();
  // An unreadable /tmp opens nothing by itself.
  expect(observeMemoryPressure({ ...reading(1, 0), tmp: null }, null, at, thresholds).episode).toBeNull();
});

test("readers show the watch's fresh observation, then read for themselves", () => {
  const file = path.join(scratch(), "memory-pressure-report.json");
  const start = Date.parse("2026-11-26T10:00:00Z");
  const observed = observeMemoryPressureReport(reading(1, 2e9), new Date(start).toISOString(), {}, file);
  let reads = 0;
  const own = () => { reads++; return { ...reading(1, 0), tmp: null }; };
  expect(currentMemoryPressure(start + 119_000, {}, own, file)).toEqual(observed);
  expect(reads).toBe(0);
  expect(currentMemoryPressure(start + 121_000, {}, own, file)).toMatchObject({ tmp: null, at: new Date(start + 121_000).toISOString() });
  expect(reads).toBe(1);
  expect(currentMemoryPressure(start + 121_000, {}, () => null, file)).toBeNull();
});

test("a calm tick takes no lock and calls no fsync", async () => {
  const directory = scratch();
  const report = path.join(directory, "memory-pressure-report.json"), actions = path.join(directory, "memory-pressure-actions.json");
  const synced = spyOn(fs, "fsyncSync");
  const ports = recorder({ active: () => { throw new Error("a calm tick reached the transaction"); } });
  try {
    for (let tick = 0; tick < 5; tick++) {
      await reconcileMemoryPressure(observeMemoryPressureReport(reading(1, 0), new Date(Date.parse("2026-11-26T10:00:00Z") + tick * 30_000).toISOString(), {}, report), ports, actions);
    }
    expect(synced).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
    // The counter sees the durable write an opening episode makes.
    observeMemoryPressureReport(reading(20, 0), "2026-11-26T10:03:00Z", {}, report);
    expect(synced).toHaveBeenCalled();
  } finally { synced.mockRestore(); }
});

test("the machine line, the seat item and the notice carry the readings and the episode", () => {
  const calm = observeMemoryPressure(reading(4, 1e9), null, "2026-11-26T10:00:00Z", thresholds);
  expect(memoryPressureLine(calm)).toBe("Machine memory: RAM 20.0 GiB of 64.0 GiB used; swap 4.0 GiB of 32.0 GiB (13%); /tmp 0.9 GiB in tmpfs of 32.0 GiB.");
  expect(memoryPressureSignals(calm)).toEqual([]);
  expect(memoryPressureSignals(null)).toEqual([]);

  const hot = observeMemoryPressure(reading(29, 8.3e9), null, "2026-11-26T10:00:00Z", thresholds);
  expect(memoryPressureLine(hot)).toEndWith(" Over the warning line (swap, tmp) since 2026-11-26T10:00:00Z.");
  expect(memoryPressureSignals(hot)).toEqual([{ id: "memory-pressure", episode: hot.episode!, label: expect.stringMatching(/^Memory pressure: RAM 20\.0 GiB/) }]);
  const notice = memoryPressureNoticeText(hot);
  expect(notice).toContain("swap 29.0 GiB з 32.0 GiB (91%)");
  expect(notice).toContain("більше ніж на 50%");
  expect(notice).toContain("більше ніж 4 GB");
  expect(memoryPressureNoticeText({ ...hot, tmp: { ...hot.tmp!, tmpfs: false }, reasons: ["swap"] })).not.toContain("більше ніж 4 GB");
});

type Recorder = MemoryPressureActions & { sweeps: number; cards: SeatTickCard[]; reports: string[] };
function recorder(overrides: Partial<MemoryPressureActions> = {}): Recorder {
  const recorded: Recorder = {
    sweeps: 0, cards: [], reports: [],
    active: () => true,
    project: async () => "repo-fixture",
    card: async (_project, card) => { recorded.cards.push(card); return true; },
    report: async (_project, key) => { recorded.reports.push(key); return true; },
    sweep: () => { recorded.sweeps += 1; },
    ...overrides,
  };
  return recorded;
}

test("an episode sweeps at once, then at most every 15 minutes, and its card and report go out once, across restarts", async () => {
  const file = path.join(scratch(), "memory-pressure-actions.json");
  const start = Date.parse("2026-11-26T10:00:00Z");
  let prior: MemoryPressure | null = null;
  const observe = (offsetMs: number, swapGib: number) => (prior = observeMemoryPressure(reading(swapGib, 0), prior, new Date(start + offsetMs).toISOString(), thresholds));

  // Each call reads the receipts from the file, as a restarted Viewer would.
  const first = recorder();
  await reconcileMemoryPressure(observe(0, 20), first, file);
  expect(first.sweeps).toBe(1);
  expect(first.cards).toMatchObject([{ ref: "seat-memory-pressure", kind: "memory-pressure", state: "open", instance: "2026-11-26T10:00:00.000Z" }]);
  expect(first.reports).toEqual(["memory-pressure:2026-11-26T10:00:00.000Z"]);

  const restarted = recorder();
  await reconcileMemoryPressure(observe(60_000, 20), restarted, file);
  await reconcileMemoryPressure(observe(MEMORY_SWEEP_MIN_INTERVAL_MS - 1, 20), restarted, file);
  expect({ sweeps: restarted.sweeps, cards: restarted.cards.length, reports: restarted.reports.length }).toEqual({ sweeps: 0, cards: 0, reports: 0 });

  await reconcileMemoryPressure(observe(MEMORY_SWEEP_MIN_INTERVAL_MS, 20), restarted, file);
  expect(restarted.sweeps).toBe(1);
  expect(restarted.cards).toHaveLength(0);

  // Recovery resolves the episode's card and sweeps nothing.
  const recovery = recorder();
  await reconcileMemoryPressure(observe(MEMORY_SWEEP_MIN_INTERVAL_MS + 60_000, 4), recovery, file);
  expect(recovery.sweeps).toBe(0);
  expect(recovery.cards).toMatchObject([{ state: "resolved", instance: "2026-11-26T10:00:00.000Z" }]);

  // A new episode inside the interval warns again but keeps the sweep guard.
  const second = recorder();
  await reconcileMemoryPressure(observe(MEMORY_SWEEP_MIN_INTERVAL_MS + 120_000, 20), second, file);
  expect(second.sweeps).toBe(0);
  expect(second.cards).toMatchObject([{ state: "open", instance: new Date(start + MEMORY_SWEEP_MIN_INTERVAL_MS + 120_000).toISOString() }]);
  expect(second.reports).toHaveLength(1);
});

test("a refused card or report is retried, a release without traffic does nothing, and a calm machine sweeps nothing", async () => {
  const file = path.join(scratch(), "memory-pressure-actions.json");
  const hot = observeMemoryPressure(reading(20, 0), null, "2026-11-26T10:00:00Z", thresholds);

  const standby = recorder({ active: () => false });
  await reconcileMemoryPressure(hot, standby, file);
  expect({ sweeps: standby.sweeps, cards: standby.cards.length }).toEqual({ sweeps: 0, cards: 0 });
  expect(fs.existsSync(file)).toBe(false);

  const calm = recorder();
  await reconcileMemoryPressure(observeMemoryPressure(reading(1, 0), null, "2026-11-26T10:00:00Z", thresholds), calm, file);
  expect({ sweeps: calm.sweeps, cards: calm.cards.length, reports: calm.reports.length }).toEqual({ sweeps: 0, cards: 0, reports: 0 });

  let cardAnswers = [false, true], reportAnswers = [false, true];
  const flaky = recorder();
  flaky.card = async (_project, card) => { flaky.cards.push(card); return cardAnswers.shift()!; };
  flaky.report = async (_project, key) => { flaky.reports.push(key); return reportAnswers.shift()!; };
  await reconcileMemoryPressure(hot, flaky, file);
  await reconcileMemoryPressure({ ...hot, at: "2026-11-26T10:01:00Z" }, flaky, file);
  await reconcileMemoryPressure({ ...hot, at: "2026-11-26T10:02:00Z" }, flaky, file);
  expect({ sweeps: flaky.sweeps, cards: flaky.cards.length, reports: flaky.reports.length }).toEqual({ sweeps: 1, cards: 2, reports: 2 });
  cardAnswers = []; reportAnswers = [];

  // No project resolved yet: the sweep still runs, the notice waits.
  const noProject = recorder({ project: async () => null });
  await reconcileMemoryPressure(hot, noProject, path.join(scratch(), "memory-pressure-actions.json"));
  expect({ sweeps: noProject.sweeps, cards: noProject.cards.length }).toEqual({ sweeps: 1, cards: 0 });
});
