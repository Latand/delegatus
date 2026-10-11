/* #2761: the candidate performance gate.

   A release that answered every health probe still timed out the board's
   projection worker in production: the probes ran against an empty registry,
   and the cost lived in thirty thousand rows of retained history. This gate
   runs the candidate's own code against a synthetic registry of that shape
   (src/lib/agent/registryPerformanceDataset.ts) and refuses promotion when a
   measured bound is breached. `verify-candidate` runs it inside a container
   from the candidate image, beside the runtime-host rehearsal, so a refused
   candidate is retired and the serving release keeps serving.

   The runner is `candidatePerformanceRun.ts`; this module holds the bounds,
   the verdict and the report format, so the adapter and the tests read the
   same definitions. docs/design/candidate-performance-gate.md explains each
   bound and where its number comes from. */

export const CANDIDATE_PERFORMANCE_REPORT_PREFIX = "[candidate performance] report ";
/** The candidate's own Bun inside its image; `bun` there is a host shim. */
export const CANDIDATE_PERFORMANCE_IMAGE_BIN = "/usr/local/bin/bun-container";
export const CANDIDATE_PERFORMANCE_ENTRY = "src/runtime-host/candidatePerformanceRun.ts";

export interface CandidatePerformanceBounds {
  /** Warm grant-bearing registry writes, from the writer's call to its return. */
  grantWrite: { p95Ms: number; maxMs: number };
  /** Event-loop delay of the process acting as the Viewer, through every phase. */
  eventLoop: { p95Ms: number; maxMs: number };
  /** The resident projection worker's build time, first build and warm builds. */
  projectionWorker: { coldMs: number; warmP95Ms: number; warmMaxMs: number };
  /** Board requests across eight scopes, queue wait included. */
  scopeRequests: { p95Ms: number; maxMs: number; maxQueueDepth: number };
  /** A successor release opening the same registry while the first keeps writing. */
  handover: { successorReadyMs: number };
}

export const CANDIDATE_PERFORMANCE_BOUNDS: CandidatePerformanceBounds = Object.freeze({
  grantWrite: Object.freeze({ p95Ms: 350, maxMs: 500 }),
  eventLoop: Object.freeze({ p95Ms: 50, maxMs: 500 }),
  projectionWorker: Object.freeze({ coldMs: 8_000, warmP95Ms: 1_000, warmMaxMs: 2_000 }),
  scopeRequests: Object.freeze({ p95Ms: 5_000, maxMs: 10_000, maxQueueDepth: 8 }),
  handover: Object.freeze({ successorReadyMs: 15_000 }),
});

export interface LatencySummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function latencySummary(samples: readonly number[]): LatencySummary {
  if (!samples.length) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return { count: sorted.length, p50Ms: round(at(0.5)), p95Ms: round(at(0.95)), maxMs: round(sorted.at(-1)!) };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface CandidatePerformanceMeasurements {
  dataset: { rows: number; coldRows: number; payloadBytes: number; seedMs: number };
  firstBoot: { registryOpenMs: number; firstSnapshotMs: number; coldProjectionMs: number };
  grantWrites: LatencySummary & { mismatches: number; failures: number };
  externalWrites: LatencySummary & { mismatches: number; failures: number };
  keyedOperationReads: LatencySummary;
  eventLoop: { p95Ms: number; maxMs: number };
  projection: { warmBuilds: LatencySummary; queueWait: LatencySummary };
  scopeRequests: LatencySummary & { scopes: number; failures: number; maxQueueDepth: number; refused: number; expired: number };
  worker: { spawns: number; timeoutRetirements: number; pidStable: boolean };
  handover: { successorReadyMs: number; successorSnapshotMs: number; successorArchived: number; grantMismatches: number };
  sqliteBusy: number;
  runtimeTimeouts: number;
  deliveryEvidence: { pending: number; uncertain: number; preserved: boolean };
  activeWorkers: { entries: number; preserved: boolean };
  stableProjection: boolean;
}

export interface CandidatePerformanceEvidence {
  checkedAt: string;
  /** What was exercised: `bun 1.4.0`, the candidate's own interpreter. */
  runtime: string;
  bounds: CandidatePerformanceBounds;
  measurements: CandidatePerformanceMeasurements | null;
  /** Every bound the measurements breached, one sentence each. */
  breaches: string[];
  /** A deliberate slowdown for the gate's own rejection test; never set in a deployment. */
  inducedDelayMs?: number;
  ok: boolean;
  detail?: string;
  log?: string[];
}

/** Every breached bound, named with the measured value. An empty list passes. */
export function candidatePerformanceBreaches(
  measured: CandidatePerformanceMeasurements,
  bounds: CandidatePerformanceBounds = CANDIDATE_PERFORMANCE_BOUNDS,
): string[] {
  const breaches: string[] = [];
  const over = (label: string, value: number, limit: number) => {
    if (value > limit) breaches.push(`${label} ${value}ms exceeds ${limit}ms`);
  };
  for (const [label, writes] of [["grant-bearing write", measured.grantWrites], ["concurrent writer", measured.externalWrites]] as const) {
    if (!writes.count) breaches.push(`${label} recorded no writes`);
    over(`${label} p95`, writes.p95Ms, bounds.grantWrite.p95Ms);
    over(`${label} max`, writes.maxMs, bounds.grantWrite.maxMs);
    if (writes.mismatches) breaches.push(`${label} saw ${writes.mismatches} MCP grant decision(s) differ from the registry's`);
    if (writes.failures) breaches.push(`${writes.failures} ${label}(s) failed`);
  }
  over("Viewer event-loop delay p95", measured.eventLoop.p95Ms, bounds.eventLoop.p95Ms);
  over("Viewer event-loop delay max", measured.eventLoop.maxMs, bounds.eventLoop.maxMs);
  over("cold projection", measured.firstBoot.coldProjectionMs, bounds.projectionWorker.coldMs);
  if (!measured.projection.warmBuilds.count) breaches.push("no warm projection build was measured");
  over("warm projection build p95", measured.projection.warmBuilds.p95Ms, bounds.projectionWorker.warmP95Ms);
  over("warm projection build max", measured.projection.warmBuilds.maxMs, bounds.projectionWorker.warmMaxMs);
  over("scope request p95", measured.scopeRequests.p95Ms, bounds.scopeRequests.p95Ms);
  over("scope request max", measured.scopeRequests.maxMs, bounds.scopeRequests.maxMs);
  if (measured.scopeRequests.maxQueueDepth > bounds.scopeRequests.maxQueueDepth) {
    breaches.push(`projection queue reached depth ${measured.scopeRequests.maxQueueDepth}, above ${bounds.scopeRequests.maxQueueDepth}`);
  }
  if (measured.scopeRequests.failures) breaches.push(`${measured.scopeRequests.failures} scope request(s) failed`);
  if (measured.scopeRequests.refused || measured.scopeRequests.expired) {
    breaches.push(`projection queue refused ${measured.scopeRequests.refused} and discarded ${measured.scopeRequests.expired} build(s)`);
  }
  if (measured.worker.timeoutRetirements) breaches.push(`projection worker retired ${measured.worker.timeoutRetirements} time(s) for a timeout`);
  if (!measured.worker.pidStable) breaches.push("the resident projection worker did not survive the release handover");
  over("successor release ready", measured.handover.successorReadyMs, bounds.handover.successorReadyMs);
  if (measured.handover.grantMismatches) breaches.push(`successor release decided ${measured.handover.grantMismatches} MCP grant(s) differently`);
  if (measured.sqliteBusy) breaches.push(`${measured.sqliteBusy} SQLITE_BUSY failure(s)`);
  if (measured.runtimeTimeouts) breaches.push(`${measured.runtimeTimeouts} runtime timeout(s)`);
  if (!measured.deliveryEvidence.preserved) breaches.push("pending or uncertain delivery evidence changed");
  if (!measured.activeWorkers.preserved) breaches.push("an active worker's registry entry changed across the handover");
  if (!measured.stableProjection) breaches.push("the board projection was not byte-stable once writes stopped");
  return breaches;
}

/**
 * Rehearse the candidate's registry and projection performance inside a
 * container from its image. `--rm` and no mounts: the synthetic registry lives
 * and dies inside a container that can reach neither the live state directory
 * nor the network.
 */
export function candidatePerformanceDockerArgs(image: string): string[] {
  return [
    "docker", "run", "--rm",
    "--network", "none",
    "--label", "dev.live-log-viewer.candidate-performance=1",
    "-e", `LLV_CANDIDATE_PERFORMANCE_BIN=${CANDIDATE_PERFORMANCE_IMAGE_BIN}`,
    "--entrypoint", CANDIDATE_PERFORMANCE_IMAGE_BIN,
    image,
    "run", CANDIDATE_PERFORMANCE_ENTRY,
  ];
}

/** Read the runner's own report out of its output. */
export function parseCandidatePerformanceReport(output: string): CandidatePerformanceEvidence {
  const marker = output.lastIndexOf(CANDIDATE_PERFORMANCE_REPORT_PREFIX);
  if (marker < 0) throw new Error("the candidate performance gate produced no report");
  const line = output.slice(marker + CANDIDATE_PERFORMANCE_REPORT_PREFIX.length).split("\n")[0] ?? "";
  return candidatePerformanceEvidence(JSON.parse(line));
}

/** Validate evidence crossing a process boundary. A pass that carries a
    breach, lacks measurements or was induced to be slow is not a pass. */
export function candidatePerformanceEvidence(value: unknown): CandidatePerformanceEvidence {
  const report = value as CandidatePerformanceEvidence;
  if (!report || typeof report !== "object" || typeof report.ok !== "boolean" || typeof report.runtime !== "string"
    || typeof report.checkedAt !== "string" || !Array.isArray(report.breaches)
    || report.breaches.some((breach) => typeof breach !== "string")
    || (report.measurements !== null && typeof report.measurements !== "object")
    || (report.log !== undefined && (!Array.isArray(report.log) || report.log.some((line) => typeof line !== "string")))) {
    throw new Error("the candidate performance report is malformed");
  }
  if (report.ok && (report.breaches.length > 0 || !report.measurements || report.inducedDelayMs)) {
    return { ...report, ok: false, detail: "the candidate performance report passed with breaches, without measurements or under an induced delay" };
  }
  return report;
}

/** The gate's failure as one line for the deployment record. */
export function candidatePerformanceDetail(evidence: CandidatePerformanceEvidence): string {
  if (evidence.ok) return "candidate performance gate passed";
  const reasons = evidence.breaches.length ? evidence.breaches.slice(0, 4).join("; ") : evidence.detail ?? "no detail";
  return `candidate performance gate refused the release: ${reasons}`;
}
