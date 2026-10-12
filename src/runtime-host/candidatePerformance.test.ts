import { expect, test } from "bun:test";

import {
  CANDIDATE_PERFORMANCE_BOUNDS,
  CANDIDATE_PERFORMANCE_REPORT_PREFIX,
  candidatePerformanceBreaches,
  candidatePerformanceDetail,
  candidatePerformanceDockerArgs,
  candidatePerformanceEvidence,
  latencySummary,
  projectionBuildSummary,
  parseCandidatePerformanceReport,
  type CandidatePerformanceEvidence,
  type CandidatePerformanceMeasurements,
} from "./candidatePerformance";

const latency = (p95Ms: number, maxMs = p95Ms) => ({ count: 20, p50Ms: p95Ms / 2, p95Ms, maxMs });

function healthy(): CandidatePerformanceMeasurements {
  return {
    dataset: { scale: 1, rows: 30_036, coldRows: 27_836, payloadBytes: 94_000_000, transcripts: 320, seedMs: 7_000 },
    firstBoot: { registryOpenMs: 80, firstSnapshotMs: 550, coldProjectionMs: 4_200, firstUsableMs: 4_900, eventLoopMaxMs: 600, coldBuild: { sequence: 1, buildMs: 4_000 } },
    activation: { incumbentMs: 4_300, successorMs: 4_800, eventLoopMaxMs: 900 },
    grantWrites: { ...latency(7, 40), count: 300, mismatches: 0, failures: 0 },
    externalWrites: { ...latency(7, 30), count: 300, mismatches: 0, failures: 0 },
    keyedOperationReads: { ...latency(2), count: 150 },
    eventLoop: { p95Ms: 3, maxMs: 120 },
    projection: { warmBuilds: { ...latency(400, 900), count: 60 }, queueWait: latency(2_000, 3_000) },
    scopeRequests: { ...latency(600, 4_000), count: 200, scopes: 8, failures: 0, maxQueueDepth: 8, refused: 0, expired: 0 },
    worker: { spawns: 1, timeoutRetirements: 0, pidStable: true },
    stability: { rounds: 20, responses: 160, emptyResponses: 0, missingRows: 0, extraRows: 0, reattributedRows: 0, missingPins: 0 },
    handover: {
      successor: {
        completed: true, exitCode: 0, signal: null, readyMs: 9_000, registryOpenMs: 90, snapshotMs: 1_000, firstProjectionMs: 5_000,
        archived: 250, grantMismatches: 0, adoptionMs: 6_000, adopted: 4,
      },
      switched: true,
      demotionExitCode: 0,
      servingRelease: "successor",
      serving: { requests: 120, failures: 0 },
    },
    workers: { count: 4, rehosted: 4, answering: 4, progressGapMaxMs: 6_500, lostProgress: 0, repeatedProgress: 0, failedPings: 0 },
    sqliteBusy: 0,
    runtimeTimeouts: 0,
    deliveryEvidence: { pending: 16, uncertain: 8, preserved: true },
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
  measured.firstBoot = { ...measured.firstBoot, registryOpenMs: 90_000, firstSnapshotMs: 90_000, firstUsableMs: 184_000, eventLoopMaxMs: 90_000 };
  measured.grantWrites = { ...latency(1_370, 1_410), count: 300, mismatches: 0, failures: 0 };
  measured.eventLoop = { p95Ms: 75, maxMs: 1_398 };
  measured.firstBoot.coldProjectionMs = 60_010;
  measured.projection.warmBuilds = { ...latency(3_200, 4_400), count: 60 };
  measured.scopeRequests = { ...measured.scopeRequests, ...latency(13_100, 97_960), count: 200, maxQueueDepth: 9 };
  measured.worker = { spawns: 2, timeoutRetirements: 1, pidStable: false };
  measured.handover.successor = { ...measured.handover.successor, readyMs: 20_000, adoptionMs: 31_000 };
  measured.activation = { incumbentMs: 16_000, successorMs: 31_000, eventLoopMaxMs: 13_300 };
  measured.workers.progressGapMaxMs = 25_000;
  measured.sqliteBusy = 3;
  measured.runtimeTimeouts = 1;
  measured.deliveryEvidence.preserved = false;
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "registry open at first boot 90000ms exceeds 2000ms",
    "first registry snapshot 90000ms exceeds 2000ms",
    "first boot to a usable board 184000ms exceeds 10000ms",
    "Viewer event-loop delay during first boot 90000ms exceeds 1000ms",
    "incumbent release activation 16000ms exceeds 15000ms",
    "successor release activation 31000ms exceeds 15000ms",
    "Viewer event-loop delay during a release activation 13300ms exceeds 1500ms",
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
    "the incumbent's resident projection worker did not stay up until the handover",
    "successor release ready 20000ms exceeds 15000ms",
    "successor re-hosting every live worker 31000ms exceeds 15000ms",
    "longest live-worker progress gap 25000ms exceeds 20000ms",
    "3 SQLITE_BUSY failure(s)",
    "1 runtime timeout(s)",
    "pending or uncertain delivery evidence changed",
  ]);
});

/* A slow first boot is refused even when everything after it is fast: the
   phases are bounded apart from the warm numbers. */
test("a slow registry open or first snapshot is refused even when warm operation is fast", () => {
  for (const phase of ["registryOpenMs", "firstSnapshotMs"] as const) {
    const measured = healthy();
    measured.firstBoot[phase] = 90_000;
    expect(candidatePerformanceBreaches(measured).length).toBeGreaterThan(0);
  }
});

test("a failed successor release cannot pass, whatever else it measured", () => {
  const measured = healthy();
  measured.handover = {
    ...measured.handover,
    successor: { ...measured.handover.successor, completed: false, exitCode: 7, signal: null, adopted: 0 },
    switched: false,
    demotionExitCode: null,
    servingRelease: "incumbent",
  };
  measured.workers = { ...measured.workers, rehosted: 0 };
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "the successor release did not complete (exit 7)",
    "the serving target never moved to the successor",
    "4 of 4 live worker(s) were not re-hosted by the successor",
  ]);
});

test("a worker killed, stalled or replayed across the transition is refused", () => {
  const measured = healthy();
  measured.workers = { count: 4, rehosted: 3, answering: 3, progressGapMaxMs: 21_000, lostProgress: 2, repeatedProgress: 1, failedPings: 9 };
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "1 of 4 live worker(s) were not re-hosted by the successor",
    "1 of 4 live worker(s) stopped answering",
    "longest live-worker progress gap 21000ms exceeds 20000ms",
    "2 live-worker progress step(s) were lost",
    "1 live-worker progress step(s) were repeated",
    "9 live-worker ping(s) went unanswered outside the transition",
  ]);
});

test("transient row loss, a reattributed row and an empty answer are each refused", () => {
  for (const [field, expected] of [
    ["missingRows", "1 board row(s) disappeared from a later answer"],
    ["reattributedRows", "1 board row(s) changed conversation or project"],
    ["emptyResponses", "1 board answer(s) carried no rows"],
    ["extraRows", "1 board row(s) appeared that the first answer lacked"],
    ["missingPins", "1 board answer(s) lacked their pinned conversation"],
  ] as const) {
    const measured = healthy();
    measured.stability[field] = 1;
    expect(candidatePerformanceBreaches(measured)).toEqual([expected]);
  }
});

test("a run that measured too little, or at a reduced scale, is not a verdict", () => {
  const measured = healthy();
  measured.dataset = { ...measured.dataset, scale: 0.1, rows: 3_000 };
  measured.stability = { ...measured.stability, rounds: 2, responses: 9 };
  measured.workers = { ...measured.workers, count: 0, rehosted: 0, answering: 0 };
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "measured at scale 0.1; only the full dataset is a verdict",
    "registry rows: measured 3000, at least 29000 required",
    "board rounds compared: measured 2, at least 8 required",
    "9 board answers compared over 2 rounds of 8 scopes",
    "live workers: measured 0, at least 2 required",
  ]);
});

test("every warm build counts, and the cold one is named by its place in the build order", () => {
  const samples = Array.from({ length: 100 }, (_, index) => ({ sequence: index + 1, buildMs: index === 0 ? 4_500 : index === 1 ? 2_500 : 5, waitMs: 0 }));
  const summary = projectionBuildSummary(samples);
  expect(summary.cold).toEqual({ sequence: 1, buildMs: 4_500 });
  expect(latencySummary(summary.warm).maxMs).toBe(2_500);
  const measured = healthy();
  measured.projection.warmBuilds = latencySummary(summary.warm);
  expect(candidatePerformanceBreaches(measured)).toEqual(["warm projection build max 2500ms exceeds 2000ms"]);
});

test("a grant decision that differs under writes is a breach even when every write was fast", () => {
  const measured = healthy();
  measured.externalWrites.mismatches = 2;
  measured.handover.successor.grantMismatches = 1;
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
  const inducedFault = { ...report(healthy()), induced: ["worker-kill"] };
  for (const forged of [withBreach, withoutMeasurements, induced, inducedFault]) {
    const parsed = parseCandidatePerformanceReport(`${CANDIDATE_PERFORMANCE_REPORT_PREFIX}${JSON.stringify(forged)}`);
    expect(parsed.ok).toBe(false);
  }
});

/* The verdict is computed again from the measurements: what the report says
   about itself can only make it stricter. */
test("empty, partial, garbled or over-bound measurements claiming a pass are refused", () => {
  const claimed = (measurements: unknown) => ({
    checkedAt: "2026-10-12T00:00:00Z", runtime: "bun 1.4.0", bounds: CANDIDATE_PERFORMANCE_BOUNDS, measurements, breaches: [], ok: true,
  });
  const partial = healthy() as unknown as Record<string, unknown>;
  delete partial.workers;
  const garbled = healthy();
  (garbled.grantWrites as { p95Ms: number }).p95Ms = Number.NaN;
  const negative = healthy();
  negative.eventLoop.maxMs = -1;
  const overBound = healthy();
  overBound.firstBoot.firstSnapshotMs = 90_000;
  const failedSuccessor = healthy();
  failedSuccessor.handover.successor.completed = false;
  for (const measurements of [{}, partial, garbled, negative, overBound, failedSuccessor]) {
    const evidence = candidatePerformanceEvidence(JSON.parse(JSON.stringify(claimed(measurements))));
    expect(evidence.ok).toBe(false);
    expect(evidence.breaches.length).toBeGreaterThan(0);
  }
  expect(candidatePerformanceEvidence(claimed(overBound)).breaches).toEqual(["first registry snapshot 90000ms exceeds 2000ms"]);
  expect(candidatePerformanceEvidence(claimed(healthy())).ok).toBe(true);
});

test("the refusal names the breaches for the deployment record", () => {
  const measured = healthy();
  measured.grantWrites = { ...latency(900, 1_400), count: 300, mismatches: 0, failures: 0 };
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
