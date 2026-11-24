import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { seatTickSignalVersion } from "@/lib/monitor/seatTick";
import { recordDiskCleanerReport, diskCleanerSignals } from "./diskReport";
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
  for (let i = 0; i < 26; i++) recordDiskCleanerReport(pass(i));
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
