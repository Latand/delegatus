import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { seatTickSignalVersion } from "@/lib/monitor/seatTick";
import { recordDiskCleanerReport, diskCleanerSignals, reconcileDiskCleanerReport } from "./diskReport";
import type { DiskCleanerPass } from "./diskState";

const roots: string[] = [];
const saved = { state: process.env.LLV_STATE_DIR, home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, tmp: process.env.TMPDIR };
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries({ LLV_STATE_DIR: saved.state, HOME: saved.home, XDG_CONFIG_HOME: saved.xdg, TMPDIR: saved.tmp })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("Cleaner completions stay pending past 24 later reports until the intended seat receipt appears", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-report-receipts-")); roots.push(root);
  const env = isolatedEnvironment(root, process.env);
  process.env.HOME = env.HOME!; process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME!; process.env.TMPDIR = env.TMPDIR!;
  process.env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state");
  const project = "repo-cleaner-report-fixture";
  const seat = { conversationId: "seat-fixture", seatEpoch: 7 };
  const pass = (index: number): DiskCleanerPass => ({
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`, project, episode: null, mode: "on", startedAt: index,
    before: [], finished: { at: index + 1, after: [], removed: { "attempt-temp": 0, release: 0, evidence: 0 }, uncertain: 0, kept: [], errors: 0, incomplete: false },
  });
  for (let i = 0; i < 26; i++) await recordDiskCleanerReport(pass(i));
  const pending = await diskCleanerSignals(project);
  expect(pending).toHaveLength(26);
  const otherSeat = { conversationId: "other-seat", seatEpoch: 7 };
  const wrongSeatVersion = seatTickSignalVersion(pending[0]!, otherSeat);
  expect(await diskCleanerSignals(project, [wrongSeatVersion], seat)).toHaveLength(26);
  const firstVersion = seatTickSignalVersion(pending[0]!, seat);
  const afterFirstDelivery = await diskCleanerSignals(project, [firstVersion], seat);
  expect(afterFirstDelivery).toHaveLength(25);
  expect(afterFirstDelivery.some(signal => signal.id === pending[0]!.id)).toBeFalse();
  expect(await diskCleanerSignals(project)).toHaveLength(25);
  expect(await diskCleanerSignals("repo-another-project")).toEqual([]);
});

test("seat lookup reads only outstanding reports as acknowledged history grows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-bounded-reports-")); roots.push(root);
  const env = isolatedEnvironment(root, process.env);
  process.env.HOME = env.HOME!; process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME!; process.env.TMPDIR = env.TMPDIR!;
  process.env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state");
  const project = "repo-bounded-report-fixture", seat = { conversationId: "seat-bounded", seatEpoch: 3 };
  const pass = (index: number): DiskCleanerPass => ({
    id: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`, project, episode: null, mode: "on", startedAt: index,
    before: [], finished: { at: index + 1, after: [], removed: { "attempt-temp": 0, release: 0, evidence: 0 }, uncertain: 0, kept: [], errors: 0, incomplete: false },
  });
  for (let i = 0; i < 512; i++) await recordDiskCleanerReport(pass(i));
  const all = await diskCleanerSignals(project);
  await diskCleanerSignals(project, all.map(signal => seatTickSignalVersion(signal, seat)), seat);
  const archive = `${path.join(process.env.LLV_STATE_DIR!, "disk-cleaner", "reports.json")}`;
  fs.writeFileSync(archive, "invalid archive deliberately unavailable to the hot lookup");
  expect(await diskCleanerSignals(project)).toEqual([]);
});

test("late release recovery updates and redelivers the original pass exactly once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-late-report-")); roots.push(root);
  const env = isolatedEnvironment(root, process.env);
  process.env.HOME = env.HOME!; process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME!; process.env.TMPDIR = env.TMPDIR!;
  process.env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state");
  const id = "00000000-0000-0000-0000-000000000000", project = "repo-late-report-fixture";
  const original: DiskCleanerPass = { id, project, episode: null, mode: "on", startedAt: 1, before: [],
    finished: { at: 2, after: [], removed: { "attempt-temp": 0, release: 0, evidence: 0 }, uncertain: 1, kept: [], errors: 0, incomplete: true } };
  await recordDiskCleanerReport(original);
  const { createCleanerJournal, cleanerJournal } = await import("./diskJournal");
  createCleanerJournal(id);
  const journal = cleanerJournal(id, "release");
  journal("intent", "/fixture/old-release", 5 * 1024 ** 3, "validated recovery");
  journal("removed", "/fixture/old-release", 5 * 1024 ** 3, "validated recovery");
  const seat = { conversationId: "seat-late", seatEpoch: 1 };
  const signal = (await diskCleanerSignals(project))[0]!;
  await diskCleanerSignals(project, [seatTickSignalVersion(signal, seat)], seat);
  await reconcileDiskCleanerReport(id);
  const corrected = await diskCleanerSignals(project);
  expect(corrected).toHaveLength(1);
  expect(corrected[0]!.label).toContain("релізи 5.00 GiB");
  expect(corrected[0]!.label).not.toContain("Неповний прохід");
  await reconcileDiskCleanerReport(id);
  expect(await diskCleanerSignals(project)).toHaveLength(1);
});
