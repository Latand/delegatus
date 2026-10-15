/* #2761: candidate performance measurements inside every bound, for the
   tests that need a gate that passed or that change one reading of it. */

import type { CandidatePerformanceMeasurements } from "../candidatePerformance";

export function passingCandidatePerformanceMeasurements(): CandidatePerformanceMeasurements {
  return structuredClone(PASSING);
}

const PASSING: CandidatePerformanceMeasurements = {
  dataset: { scale: 1, rows: 53_299, coldRows: 51_099, payloadBytes: 214_600_000, transcripts: 320, seedMs: 7_000,
    receipts: { total: 10_971, failedStructured: 892, failedLegacy: 122, conflicted: 133 } },
  firstBoot: { registryOpenMs: 80, firstSnapshotMs: 600, coldProjectionMs: 4_200, firstUsableMs: 4_900, eventLoopMaxMs: 600, coldBuild: { sequence: 1, buildMs: 2_500 } },
  activation: { incumbentMs: 4_300, successorMs: 4_800, eventLoopMaxMs: 900 },
  grantWrites: { count: 60, p50Ms: 5, p95Ms: 9, maxMs: 30, mismatches: 0, failures: 0 },
  externalWrites: { count: 300, p50Ms: 3, p95Ms: 7, maxMs: 30, mismatches: 0, failures: 0 },
  keyedOperationReads: { count: 100, p50Ms: 1, p95Ms: 2, maxMs: 4 },
  eventLoop: { p95Ms: 12, maxMs: 300 },
  projection: { warmBuilds: { count: 60, p50Ms: 300, p95Ms: 500, maxMs: 900 }, queueWait: { count: 61, p50Ms: 900, p95Ms: 2_000, maxMs: 2_400 } },
  scopeRequests: { count: 120, p50Ms: 140, p95Ms: 600, maxMs: 2_500, scopes: 8, failures: 0, maxQueueDepth: 8, refused: 0, expired: 0 },
  worker: { spawns: 1, timeoutRetirements: 0, pidStable: true },
  stability: { rounds: 20, responses: 160, emptyResponses: 0, missingRows: 0, extraRows: 0, reattributedRows: 0, missingPins: 0 },
  handover: {
    successor: {
      completed: true, exitCode: 0, signal: null, readyMs: 6_000, registryOpenMs: 90, snapshotMs: 700, firstProjectionMs: 4_000,
      archived: 250, grantMismatches: 0, adoptionMs: 3_500, adopted: 4,
    },
    switched: true,
    demotionExitCode: 0,
    servingRelease: "successor",
    serving: { requests: 104, failures: 0 },
  },
  workers: { count: 4, rehosted: 4, answering: 4, progressGapMaxMs: 4_000, lostProgress: 0, repeatedProgress: 0, failedPings: 0 },
  sqliteBusy: 0,
  runtimeTimeouts: 0,
  runtimeRpc: { requests: 600, p95Ms: 4, maxMs: 120, timeouts: 0, failures: 0, hostAlive: true },
  deliveryEvidence: { pending: 16, uncertain: 8, retained: 666, pendingLaunches: 20, preserved: true },
  browser: {
    views: 8,
    writes: { count: 900, p95Ms: 4, maxMs: 60, failures: 0 },
    readyMaxMs: 4_800, filesP95Ms: 1_900, filesMaxMs: 2_600, filesErrors: 0, viewsWithoutAnswerDuringWrites: 0,
    apiMaxMs: 3_100, apiMaxRoute: "/api/accounts", apiErrors: 0, apiFirstError: null, apiUnfinished: 0, bootLagMaxMs: 450, lagP95Ms: 1, lagMaxMs: 140, inputMaxMs: 160, inputsMin: 2,
    selectionsLost: 0, staleNotices: 0,
    server: { samples: 2_900, bootMaxMs: 380, p95Ms: 12, maxMs: 210 },
  },
};
