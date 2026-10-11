import { expect, test } from "bun:test";

import {
  CANDIDATE_PERFORMANCE_BOUNDS,
  CANDIDATE_PERFORMANCE_REPORT_PREFIX,
  candidatePerformanceBreaches,
  candidatePerformanceDetail,
  candidatePerformanceDockerArgs,
  latencySummary,
  parseCandidatePerformanceReport,
  type CandidatePerformanceEvidence,
  type CandidatePerformanceMeasurements,
} from "./candidatePerformance";

const latency = (p95Ms: number, maxMs = p95Ms) => ({ count: 20, p50Ms: p95Ms / 2, p95Ms, maxMs });

function healthy(): CandidatePerformanceMeasurements {
  return {
    dataset: { rows: 30_036, coldRows: 27_836, payloadBytes: 94_000_000, seedMs: 7_000 },
    firstBoot: { registryOpenMs: 80, firstSnapshotMs: 2_100, coldProjectionMs: 4_200 },
    grantWrites: { ...latency(7, 40), mismatches: 0, failures: 0 },
    externalWrites: { ...latency(7, 30), mismatches: 0, failures: 0 },
    keyedOperationReads: latency(2),
    eventLoop: { p95Ms: 3, maxMs: 120 },
    projection: { warmBuilds: latency(400, 900), queueWait: latency(2_000, 3_000) },
    scopeRequests: { ...latency(600, 4_000), scopes: 8, failures: 0, maxQueueDepth: 8, refused: 0, expired: 0 },
    worker: { spawns: 1, timeoutRetirements: 0, pidStable: true },
    handover: { successorReadyMs: 6_000, successorSnapshotMs: 2_800, successorArchived: 2_000, grantMismatches: 0 },
    sqliteBusy: 0,
    runtimeTimeouts: 0,
    deliveryEvidence: { pending: 16, uncertain: 8, preserved: true },
    activeWorkers: { entries: 24, preserved: true },
    stableProjection: true,
  };
}

function report(measurements: CandidatePerformanceMeasurements | null, extra: Partial<CandidatePerformanceEvidence> = {}): CandidatePerformanceEvidence {
  const breaches = measurements ? candidatePerformanceBreaches(measurements) : [];
  return {
    checkedAt: "2026-10-11T20:00:00.000Z",
    runtime: "bun 1.4.0",
    bounds: CANDIDATE_PERFORMANCE_BOUNDS,
    measurements,
    breaches,
    ok: measurements !== null && breaches.length === 0,
    ...extra,
  };
}

test("measurements inside every bound pass", () => {
  expect(candidatePerformanceBreaches(healthy())).toEqual([]);
});

test("each bound names its breach with the measured value", () => {
  const measured = healthy();
  measured.grantWrites = { ...latency(1_370, 1_410), mismatches: 0, failures: 0 };
  measured.eventLoop = { p95Ms: 75, maxMs: 1_398 };
  measured.firstBoot.coldProjectionMs = 60_010;
  measured.projection.warmBuilds = latency(3_200, 4_400);
  measured.scopeRequests = { ...measured.scopeRequests, ...latency(13_100, 97_960), maxQueueDepth: 9 };
  measured.worker = { spawns: 2, timeoutRetirements: 1, pidStable: false };
  measured.sqliteBusy = 3;
  measured.runtimeTimeouts = 1;
  measured.deliveryEvidence.preserved = false;
  measured.activeWorkers.preserved = false;
  measured.stableProjection = false;
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "grant-bearing write p95 1370ms exceeds 350ms",
    "grant-bearing write max 1410ms exceeds 500ms",
    "Viewer event-loop delay p95 75ms exceeds 50ms",
    "Viewer event-loop delay max 1398ms exceeds 500ms",
    "cold projection 60010ms exceeds 8000ms",
    "warm projection build p95 3200ms exceeds 1000ms",
    "warm projection build max 4400ms exceeds 2000ms",
    "scope request p95 13100ms exceeds 5000ms",
    "scope request max 97960ms exceeds 10000ms",
    "projection queue reached depth 9, above 8",
    "projection worker retired 1 time(s) for a timeout",
    "the resident projection worker did not survive the release handover",
    "3 SQLITE_BUSY failure(s)",
    "1 runtime timeout(s)",
    "pending or uncertain delivery evidence changed",
    "an active worker's registry entry changed across the handover",
    "the board projection was not byte-stable once writes stopped",
  ]);
});

test("a grant decision that differs under writes is a breach even when every write was fast", () => {
  const measured = healthy();
  measured.externalWrites.mismatches = 2;
  measured.handover.grantMismatches = 1;
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "concurrent writer saw 2 MCP grant decision(s) differ from the registry's",
    "successor release decided 1 MCP grant(s) differently",
  ]);
});

test("a writer that recorded nothing cannot pass for a fast one", () => {
  const measured = healthy();
  measured.grantWrites = { ...latencySummary([]), mismatches: 0, failures: 4 };
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "grant-bearing write recorded no writes",
    "4 grant-bearing write(s) failed",
  ]);
});

test("latency summaries use nearest-rank percentiles", () => {
  expect(latencySummary(Array.from({ length: 20 }, (_, index) => index + 1))).toEqual({ count: 20, p50Ms: 10, p95Ms: 19, maxMs: 20 });
  expect(latencySummary([5])).toEqual({ count: 1, p50Ms: 5, p95Ms: 5, maxMs: 5 });
});

test("the report is read from the runner's last report line", () => {
  const passing = report(healthy());
  const output = `noise\n${CANDIDATE_PERFORMANCE_REPORT_PREFIX}${JSON.stringify(report(null, { detail: "first" }))}\n`
    + `${CANDIDATE_PERFORMANCE_REPORT_PREFIX}${JSON.stringify(passing)}\ntrailing`;
  expect(parseCandidatePerformanceReport(output)).toEqual(passing);
  expect(() => parseCandidatePerformanceReport("no report here")).toThrow("produced no report");
  expect(() => parseCandidatePerformanceReport(`${CANDIDATE_PERFORMANCE_REPORT_PREFIX}{"ok":true}`)).toThrow("malformed");
});

test("a report cannot pass with breaches, without measurements or under an induced delay", () => {
  const withBreach = { ...report(healthy()), breaches: ["scope request max 12000ms exceeds 10000ms"], ok: true };
  const withoutMeasurements = { ...report(null), ok: true };
  const induced = { ...report(healthy()), inducedDelayMs: 600 };
  for (const forged of [withBreach, withoutMeasurements, induced]) {
    const parsed = parseCandidatePerformanceReport(`${CANDIDATE_PERFORMANCE_REPORT_PREFIX}${JSON.stringify(forged)}`);
    expect(parsed.ok).toBe(false);
  }
});

test("the refusal names the breaches for the deployment record", () => {
  const measured = healthy();
  measured.grantWrites = { ...latency(900, 1_400), mismatches: 0, failures: 0 };
  expect(candidatePerformanceDetail(report(measured))).toBe(
    "candidate performance gate refused the release: grant-bearing write p95 900ms exceeds 350ms; grant-bearing write max 1400ms exceeds 500ms",
  );
  expect(candidatePerformanceDetail(report(null, { detail: "the candidate performance gate could not run: boom" })))
    .toBe("candidate performance gate refused the release: the candidate performance gate could not run: boom");
});

test("the gate runs inside the candidate image under its own Bun, with no network and no mounts", () => {
  expect(candidatePerformanceDockerArgs("agent-log-viewer:candidate")).toEqual([
    "docker", "run", "--rm",
    "--network", "none",
    "--label", "dev.live-log-viewer.candidate-performance=1",
    "-e", "LLV_CANDIDATE_PERFORMANCE_BIN=/usr/local/bin/bun-container",
    "--entrypoint", "/usr/local/bin/bun-container",
    "agent-log-viewer:candidate",
    "run", "src/runtime-host/candidatePerformanceRun.ts",
  ]);
});
