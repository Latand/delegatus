import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { compactSeatTickTiming } from "./seatTickTiming";
import type { SeatTickRunRecord, SeatTickVerdictKind } from "./types";

/**
 * Seat tick rings as the legacy writer left them: every check appended to the
 * global `runs.ndjson` and to its project's `runs.ndjson.projects/<sha256>.ndjson`,
 * each ring trimmed to its newest `ring` lines. The default shape is a busy
 * installation's: 17 projects, 16 of them with a full ring, one global ring of
 * 500, and a phase timing of about 5.8 KB on every line. Every value is invented.
 */
export interface SeatTickRingShape {
  /** Checks per project over one span of time. */
  checks: number[];
  ring?: number;
  phases?: number;
  /** Projects whose own ring file was never written (an install that has not
      ticked them since the per-project rings arrived). */
  withoutProjectFile?: number[];
}

export const PRODUCTION_SEAT_TICK_SHAPE: SeatTickRingShape = {
  checks: [...Array.from({ length: 16 }, (_, index) => 700 + index * 13), 254, 3, 19],
  phases: 280,
};

export function seatTickProjectName(index: number): string {
  return index === 0 ? "" : `repo-synthetic-${index}`;
}

function syntheticCheck(project: string, n: number, phases: number): SeatTickRunRecord {
  const verdicts: SeatTickVerdictKind[] = ["quiet", "quiet", "error", "no-seat", "wake", "landed"];
  const verdict = project === "" ? "refused" : verdicts[n % verdicts.length]!;
  const names = ["check.sources.registry", "check.sources.seatFor", "reports.log", "curation.launchIfDue", "children.get", "check.deliver"];
  return {
    schemaVersion: 1,
    at: new Date(Date.UTC(2026, 10, 12, 6, 0, 0) + n * 2_000).toISOString(),
    project,
    seatEpoch: project ? 1 + (n % 4) : null,
    verdict,
    reasons: verdict === "wake" ? ["interval"] : [],
    items: n % 5,
    deferred: n % 2,
    eventsThrough: n,
    delivery: verdict === "landed" ? { clientMessageId: `seat-tick:${project}:${n}:interval:synthetic`, outcome: "landed" } : null,
    detail: verdict === "error" ? `the check failed: synthetic failure ${n}` : "nothing owed",
    timing: {
      checkId: `check-${n.toString(16).padStart(8, "0")}`,
      startedAt: new Date(Date.UTC(2026, 10, 12, 6, 0, 0) + n * 2_000).toISOString(),
      elapsedMs: 900 + (n % 400),
      cpuUs: 40_000 + n,
      dropped: 0,
      phases: Array.from({ length: phases }, (_, index) => ({
        phase: names[index % names.length]!,
        beginMs: index * 3,
        endMs: index * 3 + 2,
        cpuUs: 100 + (index % 50),
      })),
    },
  };
}

function legacyLine(record: SeatTickRunRecord): string {
  return JSON.stringify(record.timing ? { ...record, timing: compactSeatTickTiming(record.timing) } : record);
}

/** Write both rings at `filePath` as the legacy writer would have. */
export function writeLegacySeatTickRings(filePath: string, shape: SeatTickRingShape = PRODUCTION_SEAT_TICK_SHAPE): { lines: number; bytes: number } {
  const ring = shape.ring ?? 500;
  const global: string[] = [];
  const perProject = new Map<number, string[]>();
  /* Each project's checks are spread evenly over the same span, so every
     project still ticks near the end, as on a live installation. */
  const schedule = shape.checks.flatMap((count, project) =>
    Array.from({ length: count }, (_, index) => ({ project, at: (index + 0.5) / count })));
  schedule.sort((left, right) => left.at - right.at || left.project - right.project);
  schedule.forEach(({ project }, n) => {
    const line = legacyLine(syntheticCheck(seatTickProjectName(project), n, shape.phases ?? 40));
    global.push(line);
    if (global.length > ring) global.shift();
    const own = perProject.get(project) ?? [];
    own.push(line);
    if (own.length > ring) own.shift();
    perProject.set(project, own);
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${global.join("\n")}\n`, { mode: 0o600 });
  const root = `${filePath}.projects`;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let lines = 0;
  let bytes = Buffer.byteLength(global.join("\n")) + 1;
  for (const [project, own] of perProject) {
    if (shape.withoutProjectFile?.includes(project)) continue;
    const hash = crypto.createHash("sha256").update(seatTickProjectName(project)).digest("hex");
    const text = `${own.join("\n")}\n`;
    fs.writeFileSync(path.join(root, `${hash}.ndjson`), text, { mode: 0o600 });
    lines += own.length;
    bytes += Buffer.byteLength(text);
  }
  return { lines, bytes };
}
