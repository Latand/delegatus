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
import { summarizeBrowserViews, type CandidateBrowserMeasurements, type CandidateBrowserView } from "./candidateBrowser";

const latency = (p95Ms: number, maxMs = p95Ms) => ({ count: 20, p50Ms: p95Ms / 2, p95Ms, maxMs });

function healthy(): CandidatePerformanceMeasurements {
  return {
    dataset: { scale: 1, rows: 53_299, coldRows: 51_099, payloadBytes: 214_000_000, transcripts: 320, seedMs: 7_000,
      receipts: { total: 10_971, failedStructured: 892, failedLegacy: 122, conflicted: 133 } },
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
    runtimeRpc: { requests: 600, p95Ms: 4, maxMs: 120, timeouts: 0, failures: 0, hostAlive: true },
    deliveryEvidence: { pending: 16, uncertain: 8, retained: 666, pendingLaunches: 20, preserved: true },
    browser: healthyBrowser(),
  };
}

function healthyBrowser(): CandidateBrowserMeasurements {
  return {
    views: 8,
    writes: { count: 900, p95Ms: 4, maxMs: 60, failures: 0 },
    readyMaxMs: 4_800, filesP95Ms: 1_900, filesMaxMs: 2_600, filesErrors: 0, viewsWithoutAnswerDuringWrites: 0,
    apiMaxMs: 3_100, apiMaxRoute: "/api/accounts", apiErrors: 0, apiFirstError: null, apiUnfinished: 0, bootLagMaxMs: 450, lagP95Ms: 1, lagMaxMs: 140, inputMaxMs: 160, inputsMin: 2,
    selectionsLost: 0, staleNotices: 0,
    server: { samples: 2_900, bootMaxMs: 380, p95Ms: 12, maxMs: 210 },
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

test("the full threshold comparison retains the reported 1048 ms first boot", () => {
  const measured = healthy();
  measured.firstBoot.eventLoopMaxMs = 1048;
  expect(candidatePerformanceBreaches(measured)).toEqual(["Viewer event-loop delay during first boot 1048ms exceeds 1000ms"]);
});

test("inflated row totals cannot hide a small retained launch and delivery fixture", () => {
  const measured = healthy();
  measured.dataset.receipts.total = 4;
  measured.deliveryEvidence.retained = 16;
  measured.deliveryEvidence.pendingLaunches = 0;
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "retained receipts: measured 4, at least 10971 required", "retained deliveries: measured 16, at least 666 required", "pending launch receipts: measured 0, at least 20 required",
  ]);
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
    "retained launch or delivery evidence changed",
  ]);
});

/* The diagnostic comparison names first-boot overruns separately from warm operation. */
test("the full threshold comparison names a slow registry open or first snapshot", () => {
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
    "registry rows: measured 3000, at least 53000 required",
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

/* The verdict is recomputed from complete measurements; actual failures stay decisive. */
test("empty, partial, garbled or failed measurements claiming a pass are refused", () => {
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
  for (const measurements of [{}, partial, garbled, negative, failedSuccessor]) {
    const evidence = candidatePerformanceEvidence(JSON.parse(JSON.stringify(claimed(measurements))));
    expect(evidence.ok).toBe(false);
    expect(evidence.breaches.length).toBeGreaterThan(0);
  }
  expect(candidatePerformanceEvidence(claimed(overBound))).toMatchObject({
    ok: true, breaches: [], timingWarnings: ["first registry snapshot 90000ms exceeds 2000ms"],
  });
  expect(candidatePerformanceEvidence(claimed(healthy())).ok).toBe(true);
});

test("the deployment reports measured timing overruns without refusing a healthy candidate", () => {
  const measured = healthy();
  measured.firstBoot.firstSnapshotMs = 3665;
  measured.firstBoot.firstUsableMs = 13369;
  measured.eventLoop.maxMs = 1147.4;
  measured.firstBoot.coldProjectionMs = 8748;
  measured.browser!.readyMaxMs = 12000;
  const timingWarnings: string[] = [];
  const breaches = candidatePerformanceBreaches(measured, CANDIDATE_PERFORMANCE_BOUNDS, timingWarnings);
  expect(breaches).toEqual([]);
  const evidence = parseCandidatePerformanceReport(CANDIDATE_PERFORMANCE_REPORT_PREFIX + JSON.stringify(
    report(measured, { breaches, timingWarnings, ok: true }),
  ));
  expect(evidence).toMatchObject({ ok: true, breaches: [], timingWarnings });
  expect(timingWarnings).toEqual([
    "first registry snapshot 3665ms exceeds 2000ms",
    "first boot to a usable board 13369ms exceeds 10000ms",
    "Viewer event-loop delay max 1147.4ms exceeds 500ms",
    "cold projection 8748ms exceeds 8000ms",
    "browser board drawn 12000ms exceeds 10000ms",
  ]);
});

test("older timing-only refusals become warnings while independent failures remain decisive", () => {
  const measured = healthy();
  measured.firstBoot.firstSnapshotMs = 90000;
  const legacy = report(measured, { detail: "first registry snapshot 90000ms exceeds 2000ms" });
  expect(candidatePerformanceEvidence(legacy)).toMatchObject({ ok: true, breaches: [], timingWarnings: legacy.breaches });
  expect(candidatePerformanceEvidence({ ...legacy, detail: "the runner failed after collecting measurements" }).ok).toBe(false);
  expect(candidatePerformanceEvidence({ ...legacy, inducedDelayMs: 100 })).toMatchObject({
    ok: false, detail: "the candidate performance report ran under an induced fault",
  });
  measured.deliveryEvidence.preserved = false;
  expect(candidatePerformanceEvidence(report(measured))).toMatchObject({ ok: false, breaches: ["retained launch or delivery evidence changed"] });
  measured.deliveryEvidence.preserved = true;
  measured.runtimeTimeouts = 1;
  expect(candidatePerformanceEvidence(report(measured))).toMatchObject({ ok: false, breaches: ["1 runtime timeout(s)"] });
});

test("malformed timing warnings are refused on successful and failed reports", () => {
  for (const timingWarnings of [5, { value: "slow" }, [1, null]]) {
    for (const measurements of [healthy(), null]) {
      expect(() => candidatePerformanceEvidence({ ...report(measurements), timingWarnings })).toThrow("malformed");
    }
  }
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

/* Run as the entrypoint itself, the gate was PID 1 and its runtime host
   refused that owner before anything was measured; Docker's init takes PID 1. */
test("the gate runs inside the candidate image under its own Bun and an init, with no network and no mounts", () => {
  expect(candidatePerformanceDockerArgs("agent-log-viewer:candidate")).toEqual([
    "docker", "run", "--rm", "--init",
    "--network", "none",
    "--label", "dev.live-log-viewer.candidate-performance=1",
    "-e", "LLV_CANDIDATE_PERFORMANCE_BIN=/usr/local/bin/bun-container",
    "--entrypoint", "/usr/local/bin/bun-container",
    "agent-log-viewer:candidate",
    "run", "src/runtime-host/candidatePerformanceRun.ts",
  ]);
});

/* #2761: the board as eight browser views of the candidate's own build is part
   of the verdict. A run without it, or with the views the reviewer measured
   over the same history (first board 18-19 s, /api/files 12-17 s, side
   requests near 20 s), is refused, and so is a browser reading that cannot be
   read. */
test("the board in browser views is bounded, and a run without it is refused", () => {
  const unmeasured = healthy();
  unmeasured.browser = null;
  expect(candidatePerformanceBreaches(unmeasured)).toEqual(["the board was not measured in a browser"]);
  expect(candidatePerformanceEvidence(report(unmeasured, { ok: true, breaches: [] }))).toMatchObject({ ok: false, detail: "the board was not measured in a browser" });

  const slow = healthy();
  slow.browser = {
    ...healthyBrowser(),
    readyMaxMs: 18_985, filesP95Ms: 17_352, filesMaxMs: 17_352, apiMaxMs: 19_774, apiMaxRoute: "/api/accounts",
    writes: { count: 0, p95Ms: 0, maxMs: 0, failures: 2 }, inputsMin: 1, selectionsLost: 1,
  };
  expect(candidatePerformanceBreaches(slow)).toEqual([
    "browser writers: measured 0 writes, at least 50 required",
    "2 browser writer write(s) failed",
    "browser board drawn 18985ms exceeds 10000ms",
    "browser /api/files p95 17352ms exceeds 5000ms",
    "browser /api/files max 17352ms exceeds 10000ms",
    "browser /api/accounts 19774ms exceeds 10000ms",
    "a browser view answered 1 input(s), at least 2 required",
    "1 browser view(s) lost their selected conversation",
  ]);

  const garbled = report(healthy(), { ok: true, breaches: [] });
  (garbled.measurements!.browser as unknown as Record<string, unknown>).readyMaxMs = "fast";
  expect(candidatePerformanceEvidence(garbled)).toMatchObject({ ok: false, detail: "the candidate performance report lacks or garbles browser.readyMaxMs" });
});

/* #2761: the releases reach the candidate's runtime host through the
   production client, and what those calls cost is part of the verdict: a
   call that timed out or failed on the socket refuses whatever the times,
   and so does a host that left during the run. */
test("runtime-host calls are bounded, and a timeout or a failed call refuses", () => {
  const measured = healthy();
  measured.runtimeTimeouts = 3;
  measured.runtimeRpc = { requests: 12, p95Ms: 900, maxMs: 10_004, timeouts: 3, failures: 2, hostAlive: false };
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "3 runtime timeout(s)",
    "runtime-host calls: measured 12, at least 40 required",
    "runtime-host call p95 900ms exceeds 250ms",
    "runtime-host call max 10004ms exceeds 2000ms",
    "2 runtime-host call(s) failed on the socket",
    "the runtime host exited during the run",
  ]);
  const unread = report(healthy(), { ok: true, breaches: [] });
  delete (unread.measurements as unknown as Record<string, unknown>).runtimeRpc;
  expect(candidatePerformanceEvidence(unread)).toMatchObject({ ok: false });
  expect(candidatePerformanceEvidence(unread).detail).toBe("the candidate performance report lacks or garbles runtimeRpc");
});

/* An unfinished ordinary request and an HTTP failure remain blocking outcomes. */
test("a browser request left unanswered or answered 5xx refuses the candidate", () => {
  const measured = healthy();
  measured.browser = {
    ...healthyBrowser(),
    apiMaxMs: 30_412, apiMaxRoute: "/api/tmux/targets (unanswered)", apiUnfinished: 8,
    apiErrors: 8, apiFirstError: "/api/runtime/snapshot HTTP 503",
  };
  expect(candidatePerformanceBreaches(measured)).toEqual([
    "browser /api/tmux/targets (unanswered) 30412ms exceeds 10000ms",
    "8 other browser API request(s) failed, first /api/runtime/snapshot HTTP 503",
    "8 browser API request(s) did not finish",
  ]);
});

test("an unanswered browser request refuses promotion even when it only exceeded a diagnostic time threshold", () => {
  const measured = healthy();
  measured.browser!.apiUnfinished = 1;
  measured.browser!.apiMaxMs = 30000;
  const evidence = candidatePerformanceEvidence(report(measured));
  expect(evidence).toMatchObject({
    ok: false,
    breaches: ["1 browser API request(s) did not finish"],
    timingWarnings: ["browser /api/accounts 30000ms exceeds 10000ms"],
  });
});

test("a board that never drew remains a failure after its readiness sentinel crosses the report boundary", () => {
  const view: CandidateBrowserView = {
    view: 0, readyMs: Number.POSITIVE_INFINITY, cards: 0,
    selection: { stillSelected: true, checksLost: 0, staleNoticeSeen: 0 },
    files: { answered: 1, answeredDuringWrites: 1, errors: 0, p95Ms: 1, maxMs: 1, queuedMaxMs: 0 },
    api: { requests: 1, maxMs: 1, slowestRoute: null, errors: 0, firstError: null, unfinished: 0 },
    lag: { bootMaxMs: 1, samples: 1000, p95Ms: 1, maxMs: 1 }, inputMs: [1, 1],
  };
  const measured = healthy();
  const browser = healthyBrowser();
  measured.browser = summarizeBrowserViews(Array.from({ length: 8 }, (_, index) => ({ ...view, view: index })), browser.writes, browser.server);
  expect(measured.browser.readyMaxMs).toBe(Number.MAX_SAFE_INTEGER);
  expect(candidatePerformanceEvidence(JSON.parse(JSON.stringify(report(measured))))).toMatchObject({
    ok: false, breaches: ["a browser board did not finish drawing"],
  });
});

/* #2761: the reviewer held the event loop of the server under the views for
   801 ms and every bound read in the page passed (request max 232 ms, page
   delay 13 ms, input 20 ms). The server's own loop is part of the verdict,
   and a run that did not read it is refused. */
test("a slow server produces a warning and an unmeasured server refuses the candidate", () => {
  const held = healthy();
  held.browser = {
    ...healthyBrowser(),
    apiMaxMs: 232, apiMaxRoute: "/api/files", lagP95Ms: 1, lagMaxMs: 13, inputMaxMs: 20,
    server: { samples: 2_840, bootMaxMs: 120, p95Ms: 4, maxMs: 801 },
  };
  expect(candidatePerformanceBreaches(held)).toEqual(["server event-loop delay max under the browser views 801ms exceeds 500ms"]);
  expect(candidatePerformanceEvidence(report(held, { ok: true, breaches: [] }))).toMatchObject({
    ok: true, breaches: [], timingWarnings: ["server event-loop delay max under the browser views 801ms exceeds 500ms"],
  });

  const slow = healthy();
  slow.browser = { ...healthyBrowser(), server: { samples: 120, bootMaxMs: 1_400, p95Ms: 75, maxMs: 300 } };
  expect(candidatePerformanceBreaches(slow)).toEqual([
    "server event loop under the browser views: measured 120 samples, at least 300 required",
    "server event-loop delay while the browser views opened 1400ms exceeds 1000ms",
    "server event-loop delay p95 under the browser views 75ms exceeds 50ms",
  ]);

  const unmeasured = healthy();
  unmeasured.browser = { ...healthyBrowser(), server: null };
  expect(candidatePerformanceBreaches(unmeasured)).toEqual(["the server's event loop was not measured while the browser views ran"]);
  expect(candidatePerformanceEvidence(report(unmeasured, { ok: true, breaches: [] }))).toMatchObject({
    ok: false, detail: "the candidate performance report lacks or garbles browser.server",
  });
  /* A report from before the probe carries no reading at all. */
  const older = report(healthy(), { ok: true, breaches: [] });
  delete (older.measurements!.browser as unknown as Record<string, unknown>).server;
  expect(candidatePerformanceEvidence(older)).toMatchObject({ ok: false });
});
