import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySeatTickState, type SeatTickCheckInput } from "@/lib/monitor/types";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";
import { claimMaintenanceRun } from "./store";
import type { MaintenanceRun, MaintenanceAuditInput } from "./types";
export const NOW = Date.parse("2026-09-30T12:00:00Z");
export const PROJECT = "fixture-maintenance";
export const SEAT = { seatEpoch: 1, conversationId: ["conversation", "fixture-seat"].join("_") };
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-maintenance-test-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = dir;
  return { dir, restore: () => { if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); } };
}
export function claim(now = NOW): MaintenanceRun {
  const result = claimMaintenanceRun({ project: PROJECT, now, intervalHours: 3, seat: SEAT, repoDir: "/fixtures/repository" });
  if (!result.claimed) throw new Error(result.reason);
  return result.run;
}
export function input(enabled = true): SeatTickCheckInput {
  const actor = { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null };
  const row = { ...defaultSeatTickSettings(PROJECT), maintenance: { enabled, intervalHours: 3, updatedAt: new Date(NOW).toISOString(), setBy: actor } };
  return { project: PROJECT, now: NOW, seat: { ...SEAT, path: null, designatedAt: null, turn: "idle", activity: null }, pipelines: [], ownLanes: [], tasks: [], events: [], pullRequests: [], pullRequestsUnavailable: null, signals: [], children: [], childrenUnavailable: null, changeFingerprint: "fixture", state: emptySeatTickState(), policy: DEFAULT_SEAT_TICK_POLICY, settings: effectiveSeatTickSettings(row, NOW, SEAT_TICK_WAKE_INTERVAL_MS) };
}

/** A pinned private artifact and one verified occurrence for protocol/service tests. */
export function auditFixture(run: MaintenanceRun): MaintenanceAuditInput {
  const file = path.join(process.env.LLV_STATE_DIR!, "audit-source.jsonl");
  fs.writeFileSync(file, "fixture artifact\n");
  const stat = fs.statSync(file);
  const source = { key: "fixture-source", kind: "transcript" as const, conversationId: SEAT.conversationId, generation: "fixture-generation", path: file, artifact: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size, from: null, complete: false, gap: null };
  const occurrence = { key: JSON.stringify([source.key, 1, 0, new Date(NOW - 1000).toISOString()]), source: source.key, seq: 1, part: 0, at: new Date(NOW - 1000).toISOString(), requestIndex: 0, text: "First request. Second request.", verified: true, gap: null };
  return { version: 1 as const, runId: run.runId, project: run.project, revision: 1, seat: run.seat, operator: { kind: "operator" as const }, snapshotAt: run.claimedAt, window: { lower: new Date(NOW - 3600000).toISOString(), upper: run.claimedAt, sources: [source], gaps: [] }, occurrences: [occurrence], unread: { [source.key]: null } };
}
