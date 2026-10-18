/* #2761: the candidate performance gate.

   A release that answered every health probe still timed out the board's
   projection worker in production: the probes ran against an empty registry,
   and the cost lived in thirty thousand rows of retained history. This gate
   runs the candidate's own code against a synthetic registry of that shape
   (src/lib/agent/registryPerformanceDataset.ts). Measured durations remain
   diagnostic; failed operations and lost state refuse promotion.
   `verify-candidate` runs it inside a container
   from the candidate image, beside the runtime-host rehearsal, so a refused
   candidate is retired and the serving release keeps serving.

   The runner is `candidatePerformanceRun.ts`; this module holds the bounds,
   the verdict and the report format, so the adapter and the tests read the
   same definitions. docs/design/candidate-performance-gate.md explains each
   bound and where its number comes from. */

import {
  CANDIDATE_BROWSER_BOUNDS,
  candidateBrowserBreaches,
  type CandidateBrowserBounds,
  type CandidateBrowserMeasurements,
} from "./candidateBrowser";

export const CANDIDATE_PERFORMANCE_REPORT_PREFIX = "[candidate performance] report ";
/** The candidate's own Bun inside its image; `bun` there is a host shim. */
export const CANDIDATE_PERFORMANCE_IMAGE_BIN = "/usr/local/bin/bun-container";
export const CANDIDATE_PERFORMANCE_ENTRY = "src/runtime-host/candidatePerformanceRun.ts";

export interface CandidatePerformanceBounds {
  /** First boot, from opening the registry to the first usable board
      projection: each phase, the whole, and the Viewer's event loop, watched
      from before the registry opens. */
  firstBoot: { registryOpenMs: number; firstSnapshotMs: number; firstUsableMs: number; eventLoopMaxMs: number };
  /** A release's activation: from the serving target naming it to its
      structured-host startup ready with every live worker re-hosted. */
  activation: { durationMs: number; eventLoopMaxMs: number };
  /** Warm grant-bearing registry writes, from the writer's call to its return. */
  grantWrite: { p95Ms: number; maxMs: number };
  /** Event-loop delay of each release while it serves, outside its boot and its activation. */
  eventLoop: { p95Ms: number; maxMs: number };
  /** The resident projection worker's build time, first build and warm builds. */
  projectionWorker: { coldMs: number; warmP95Ms: number; warmMaxMs: number };
  /** Board requests across eight scopes, queue wait included. */
  scopeRequests: { p95Ms: number; maxMs: number; maxQueueDepth: number };
  /** The successor release: ready to serve while the incumbent still serves,
      every live worker re-hosted once it is appointed, and the longest any
      worker went without progress across the transition. */
  handover: { successorReadyMs: number; adoptionMs: number; workerProgressGapMs: number };
  /** Calls from the releases to the candidate's runtime host through the
      production client, from the call to its answer. A timeout or a transport
      failure refuses whatever the times. */
  runtimeRpc: { p95Ms: number; maxMs: number };
  /** Eight real browser views of the candidate's own production build (`candidateBrowser.ts`). */
  browser: CandidateBrowserBounds;
}

export const CANDIDATE_PERFORMANCE_BOUNDS: CandidatePerformanceBounds = Object.freeze({
  firstBoot: Object.freeze({ registryOpenMs: 2_000, firstSnapshotMs: 2_000, firstUsableMs: 10_000, eventLoopMaxMs: 1_000 }),
  activation: Object.freeze({ durationMs: 15_000, eventLoopMaxMs: 1_500 }),
  grantWrite: Object.freeze({ p95Ms: 350, maxMs: 500 }),
  eventLoop: Object.freeze({ p95Ms: 50, maxMs: 500 }),
  projectionWorker: Object.freeze({ coldMs: 8_000, warmP95Ms: 1_000, warmMaxMs: 2_000 }),
  scopeRequests: Object.freeze({ p95Ms: 5_000, maxMs: 10_000, maxQueueDepth: 8 }),
  handover: Object.freeze({ successorReadyMs: 15_000, adoptionMs: 15_000, workerProgressGapMs: 20_000 }),
  runtimeRpc: Object.freeze({ p95Ms: 250, maxMs: 2_000 }),
  browser: CANDIDATE_BROWSER_BOUNDS,
});

/** What a run must have measured before its numbers mean anything. */
export const CANDIDATE_PERFORMANCE_MINIMUMS = Object.freeze({
  rows: 53_000,
  coldShare: 0.9,
  scopes: 8,
  writes: 50,
  keyedReads: 20,
  warmBuilds: 8,
  scopeRequests: 64,
  stabilityRounds: 8,
  workers: 2,
  pendingDeliveries: 1,
  uncertainDeliveries: 1,
  runtimeRpcs: 40,
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

/** One finished projection build, numbered in the order its process started them. */
export interface ProjectionBuildSample { sequence: number; buildMs: number; waitMs: number }

/**
 * Split every build a release observed into its cold build and its warm ones.
 * The cold build is the one the process started first; every other build is
 * warm, however many builds the queue's bounded history has let go since.
 */
export function projectionBuildSummary(samples: readonly ProjectionBuildSample[]): {
  cold: { sequence: number; buildMs: number } | null;
  warm: number[];
  waits: number[];
} {
  const cold = samples.find((sample) => sample.sequence === 1) ?? null;
  return {
    cold: cold ? { sequence: cold.sequence, buildMs: round(cold.buildMs) } : null,
    warm: samples.filter((sample) => sample !== cold).map((sample) => sample.buildMs),
    waits: samples.map((sample) => sample.waitMs),
  };
}

export interface CandidatePerformanceMeasurements {
  dataset: { scale: number; rows: number; coldRows: number; payloadBytes: number; transcripts: number; seedMs: number;
    receipts: { total: number; failedStructured: number; failedLegacy: number; conflicted: number } };
  firstBoot: {
    registryOpenMs: number;
    firstSnapshotMs: number;
    coldProjectionMs: number;
    /** From opening the registry to the first board answer. */
    firstUsableMs: number;
    eventLoopMaxMs: number;
    /** The worker's first build, named by its place in the build order. */
    coldBuild: { sequence: number; buildMs: number };
  };
  /** Each release's activation; one that never completed counts the time it ran. */
  activation: { incumbentMs: number; successorMs: number; eventLoopMaxMs: number };
  grantWrites: LatencySummary & { mismatches: number; failures: number };
  externalWrites: LatencySummary & { mismatches: number; failures: number };
  keyedOperationReads: LatencySummary;
  eventLoop: { p95Ms: number; maxMs: number };
  /** Every warm build of both releases, collected as each one finished. */
  projection: { warmBuilds: LatencySummary; queueWait: LatencySummary };
  scopeRequests: LatencySummary & { scopes: number; failures: number; maxQueueDepth: number; refused: number; expired: number };
  worker: { spawns: number; timeoutRetirements: number; pidStable: boolean };
  /** Every measured board answer compared with the first answer of its scope. */
  stability: {
    rounds: number;
    responses: number;
    emptyResponses: number;
    /** Rows the first answer of a scope carried and a later one lacked. */
    missingRows: number;
    /** Rows a later answer carried that the first did not. */
    extraRows: number;
    /** Rows whose conversation or project changed between answers. */
    reattributedRows: number;
    /** Answers that lacked the conversation their scope pins. */
    missingPins: number;
  };
  handover: {
    successor: {
      /** The successor said so itself; an exit without its report is a failure. */
      completed: boolean;
      exitCode: number | null;
      signal: string | null;
      readyMs: number;
      registryOpenMs: number;
      snapshotMs: number;
      firstProjectionMs: number;
      archived: number;
      grantMismatches: number;
      /** From its appointment to every live worker re-hosted by it. */
      adoptionMs: number;
      adopted: number;
    };
    /** The serving target moved to the successor. */
    switched: boolean;
    /** The incumbent's demotion: hosts released and state checkpointed. */
    demotionExitCode: number | null;
    servingRelease: "incumbent" | "successor";
    /** Board requests from the successor's start to the end, to whichever release served. */
    serving: { requests: number; failures: number };
  };
  workers: {
    count: number;
    /** Re-hosted by the successor: its claim, a live process, status live. */
    rehosted: number;
    /** Answered a ping at the end of the run. */
    answering: number;
    progressGapMaxMs: number;
    lostProgress: number;
    repeatedProgress: number;
    /** Pings that went unanswered outside the transition window. */
    failedPings: number;
  };
  sqliteBusy: number;
  /** Runtime-host calls of either release that reached their deadline. */
  runtimeTimeouts: number;
  /** Every runtime-host call of both releases through the production client:
      the count, the gate's own traffic's p95, the slowest call of any, and
      each call that timed out or failed on the socket. */
  runtimeRpc: { requests: number; p95Ms: number; maxMs: number; timeouts: number; failures: number; hostAlive: boolean };
  deliveryEvidence: { pending: number; uncertain: number; retained: number; pendingLaunches: number; preserved: boolean };
  /** The board in eight real browser views of the candidate's production
      build while two writers run; null when no browser view was measured,
      which is a refusal. */
  browser: CandidateBrowserMeasurements | null;
}

export interface CandidatePerformanceEvidence {
  checkedAt: string;
  /** What was exercised: `bun 1.4.0`, the candidate's own interpreter. */
  runtime: string;
  bounds: CandidatePerformanceBounds;
  measurements: CandidatePerformanceMeasurements | null;
  /** Failed checks; duration-only observations are recorded separately. */
  breaches: string[];
  /** Duration thresholds are diagnostic; failed operations still refuse a release. */
  timingWarnings?: string[];
  /** A deliberate slowdown for the gate's own rejection test; never set in a deployment. */
  inducedDelayMs?: number;
  /** Deliberate faults for the gate's own rejection tests; never set in a deployment. */
  induced?: string[];
  ok: boolean;
  detail?: string;
  log?: string[];
}

/** Classify measured checks. Supplying a timing collector keeps duration
    observations separate from failures; omission includes them for reports
    and callers that explicitly request the full threshold comparison. */
export function candidatePerformanceBreaches(
  measured: CandidatePerformanceMeasurements,
  bounds: CandidatePerformanceBounds = CANDIDATE_PERFORMANCE_BOUNDS,
  timingWarnings?: string[],
): string[] {
  const breaches: string[] = [];
  const over = (label: string, value: number, limit: number) => {
    if (value > limit) (timingWarnings ?? breaches).push(`${label} ${value}ms exceeds ${limit}ms`);
  };
  const minimum = CANDIDATE_PERFORMANCE_MINIMUMS;
  const fewer = (label: string, value: number, wanted: number) => {
    if (value < wanted) breaches.push(`${label}: measured ${value}, at least ${wanted} required`);
  };
  if (measured.dataset.scale !== 1) breaches.push(`measured at scale ${measured.dataset.scale}; only the full dataset is a verdict`);
  fewer("registry rows", measured.dataset.rows, minimum.rows);
  fewer("retained receipts", measured.dataset.receipts.total, 10_971);
  fewer("failed structured receipts", measured.dataset.receipts.failedStructured, 892);
  fewer("failed legacy receipts", measured.dataset.receipts.failedLegacy, 122);
  fewer("conflicted receipts", measured.dataset.receipts.conflicted, 133);
  if (measured.dataset.rows > 0 && measured.dataset.coldRows / measured.dataset.rows < minimum.coldShare) {
    breaches.push(`only ${measured.dataset.coldRows} of ${measured.dataset.rows} registry rows were cold`);
  }
  over("registry open at first boot", measured.firstBoot.registryOpenMs, bounds.firstBoot.registryOpenMs);
  over("first registry snapshot", measured.firstBoot.firstSnapshotMs, bounds.firstBoot.firstSnapshotMs);
  over("first boot to a usable board", measured.firstBoot.firstUsableMs, bounds.firstBoot.firstUsableMs);
  over("Viewer event-loop delay during first boot", measured.firstBoot.eventLoopMaxMs, bounds.firstBoot.eventLoopMaxMs);
  if (measured.firstBoot.coldBuild.sequence !== 1) breaches.push("the first projection build was not measured");
  over("incumbent release activation", measured.activation.incumbentMs, bounds.activation.durationMs);
  over("successor release activation", measured.activation.successorMs, bounds.activation.durationMs);
  over("Viewer event-loop delay during a release activation", measured.activation.eventLoopMaxMs, bounds.activation.eventLoopMaxMs);
  for (const [label, writes] of [["grant-bearing write", measured.grantWrites], ["concurrent writer", measured.externalWrites]] as const) {
    if (!writes.count) breaches.push(`${label} recorded no writes`);
    else fewer(`${label} samples`, writes.count, minimum.writes);
    over(`${label} p95`, writes.p95Ms, bounds.grantWrite.p95Ms);
    over(`${label} max`, writes.maxMs, bounds.grantWrite.maxMs);
    if (writes.mismatches) breaches.push(`${label} saw ${writes.mismatches} MCP grant decision(s) differ from the registry's`);
    if (writes.failures) breaches.push(`${writes.failures} ${label}(s) failed`);
  }
  fewer("keyed operation reads", measured.keyedOperationReads.count, minimum.keyedReads);
  over("Viewer event-loop delay p95", measured.eventLoop.p95Ms, bounds.eventLoop.p95Ms);
  over("Viewer event-loop delay max", measured.eventLoop.maxMs, bounds.eventLoop.maxMs);
  over("cold projection", measured.firstBoot.coldProjectionMs, bounds.projectionWorker.coldMs);
  if (!measured.projection.warmBuilds.count) breaches.push("no warm projection build was measured");
  else fewer("warm projection builds", measured.projection.warmBuilds.count, minimum.warmBuilds);
  over("warm projection build p95", measured.projection.warmBuilds.p95Ms, bounds.projectionWorker.warmP95Ms);
  over("warm projection build max", measured.projection.warmBuilds.maxMs, bounds.projectionWorker.warmMaxMs);
  if (measured.scopeRequests.scopes !== minimum.scopes) breaches.push(`${measured.scopeRequests.scopes} board scopes measured, ${minimum.scopes} required`);
  fewer("board requests", measured.scopeRequests.count, minimum.scopeRequests);
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
  if (!measured.worker.pidStable) breaches.push("the incumbent's resident projection worker did not stay up until the handover");
  const stability = measured.stability;
  fewer("board rounds compared", stability.rounds, minimum.stabilityRounds);
  if (stability.responses < stability.rounds * minimum.scopes) {
    breaches.push(`${stability.responses} board answers compared over ${stability.rounds} rounds of ${minimum.scopes} scopes`);
  }
  if (stability.emptyResponses) breaches.push(`${stability.emptyResponses} board answer(s) carried no rows`);
  if (stability.missingRows) breaches.push(`${stability.missingRows} board row(s) disappeared from a later answer`);
  if (stability.extraRows) breaches.push(`${stability.extraRows} board row(s) appeared that the first answer lacked`);
  if (stability.reattributedRows) breaches.push(`${stability.reattributedRows} board row(s) changed conversation or project`);
  if (stability.missingPins) breaches.push(`${stability.missingPins} board answer(s) lacked their pinned conversation`);
  const successor = measured.handover.successor;
  if (!successor.completed) {
    breaches.push(`the successor release did not complete (exit ${successor.exitCode ?? "none"}${successor.signal ? `, ${successor.signal}` : ""})`);
  } else if (successor.exitCode !== 0) {
    breaches.push(`the successor release exited ${successor.exitCode ?? "without a code"}${successor.signal ? ` on ${successor.signal}` : ""}`);
  }
  over("successor release ready", successor.readyMs, bounds.handover.successorReadyMs);
  over("successor's first projection", successor.firstProjectionMs, bounds.projectionWorker.coldMs);
  over("successor re-hosting every live worker", successor.adoptionMs, bounds.handover.adoptionMs);
  if (successor.grantMismatches) breaches.push(`successor release decided ${successor.grantMismatches} MCP grant(s) differently`);
  if (!measured.handover.switched) breaches.push("the serving target never moved to the successor");
  else if (measured.handover.demotionExitCode !== 0) {
    breaches.push(`the incumbent's demotion ended ${measured.handover.demotionExitCode ?? "without finishing"}`);
  }
  if (measured.handover.serving.failures) breaches.push(`${measured.handover.serving.failures} board request(s) failed across the release transition`);
  const workers = measured.workers;
  fewer("live workers", workers.count, minimum.workers);
  if (workers.rehosted !== workers.count) breaches.push(`${workers.count - workers.rehosted} of ${workers.count} live worker(s) were not re-hosted by the successor`);
  if (workers.answering !== workers.count) breaches.push(`${workers.count - workers.answering} of ${workers.count} live worker(s) stopped answering`);
  over("longest live-worker progress gap", workers.progressGapMaxMs, bounds.handover.workerProgressGapMs);
  if (workers.lostProgress) breaches.push(`${workers.lostProgress} live-worker progress step(s) were lost`);
  if (workers.repeatedProgress) breaches.push(`${workers.repeatedProgress} live-worker progress step(s) were repeated`);
  if (workers.failedPings) breaches.push(`${workers.failedPings} live-worker ping(s) went unanswered outside the transition`);
  if (measured.sqliteBusy) breaches.push(`${measured.sqliteBusy} SQLITE_BUSY failure(s)`);
  if (measured.runtimeTimeouts) breaches.push(`${measured.runtimeTimeouts} runtime timeout(s)`);
  fewer("runtime-host calls", measured.runtimeRpc.requests, minimum.runtimeRpcs);
  over("runtime-host call p95", measured.runtimeRpc.p95Ms, bounds.runtimeRpc.p95Ms);
  over("runtime-host call max", measured.runtimeRpc.maxMs, bounds.runtimeRpc.maxMs);
  if (measured.runtimeRpc.failures) breaches.push(`${measured.runtimeRpc.failures} runtime-host call(s) failed on the socket`);
  if (!measured.runtimeRpc.hostAlive) breaches.push("the runtime host exited during the run");
  fewer("pending deliveries held as evidence", measured.deliveryEvidence.pending, minimum.pendingDeliveries);
  fewer("uncertain deliveries held as evidence", measured.deliveryEvidence.uncertain, minimum.uncertainDeliveries);
  fewer("retained deliveries", measured.deliveryEvidence.retained, 666);
  fewer("pending launch receipts", measured.deliveryEvidence.pendingLaunches, 20);
  if (!measured.deliveryEvidence.preserved) breaches.push("retained launch or delivery evidence changed");
  if (!measured.browser) breaches.push("the board was not measured in a browser");
  else breaches.push(...candidateBrowserBreaches(measured.browser, bounds.browser, timingWarnings));
  return breaches;
}

/**
 * Rehearse the candidate's registry and projection performance inside a
 * container from its image. `--rm` and no mounts: the synthetic registry lives
 * and dies inside a container that can reach neither the live state directory
 * nor the network. `--init` puts Docker's init at PID 1: the gate starts a
 * runtime host, releases, workers and a browser, and what they orphan is
 * reaped there instead of piling up under an interpreter that reaps nothing.
 */
export function candidatePerformanceDockerArgs(image: string): string[] {
  return [
    "docker", "run", "--rm", "--init",
    "--network", "none",
    "--label", "dev.live-log-viewer.candidate-performance=1",
    "-e", `LLV_CANDIDATE_PERFORMANCE_BIN=${CANDIDATE_PERFORMANCE_IMAGE_BIN}`,
    "--entrypoint", CANDIDATE_PERFORMANCE_IMAGE_BIN,
    image,
    "run", CANDIDATE_PERFORMANCE_ENTRY,
  ];
}

/** The Dockerfile stage that adds a browser to the candidate's image. */
export const CANDIDATE_GATE_TARGET = "candidate-gate";

/** The gate's own image beside a candidate image: built with it, removed with it. */
export function candidateGateImageName(image: string): string {
  return `${image}-gate`;
}

/** Whether a revision's Dockerfile defines the gate's stage. A revision from
    before the browser half has none; its gate then runs in the candidate's
    own image, finds no browser and refuses. */
export function dockerfileHasCandidateGate(dockerfile: string): boolean {
  return new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${CANDIDATE_GATE_TARGET}\\s*$`, "mi").test(dockerfile);
}

/** Read the runner's own report out of its output. */
export function parseCandidatePerformanceReport(output: string): CandidatePerformanceEvidence {
  const marker = output.lastIndexOf(CANDIDATE_PERFORMANCE_REPORT_PREFIX);
  if (marker < 0) throw new Error("the candidate performance gate produced no report");
  const line = output.slice(marker + CANDIDATE_PERFORMANCE_REPORT_PREFIX.length).split("\n")[0] ?? "";
  return candidatePerformanceEvidence(JSON.parse(line));
}

/* The shape every measurement must have: each leaf a finite, non-negative
   number, a boolean or one of the named words. Evidence that lacks a leaf, or
   carries one that is not what it should be, cannot be judged. */
type Shape = "n" | "b" | "n?" | "s?" | readonly string[] | { readonly [key: string]: Shape };
const LATENCY = { count: "n", p50Ms: "n", p95Ms: "n", maxMs: "n" } as const;
const MEASUREMENT_SHAPE: Shape = {
  dataset: { scale: "n", rows: "n", coldRows: "n", payloadBytes: "n", transcripts: "n", seedMs: "n",
    receipts: { total: "n", failedStructured: "n", failedLegacy: "n", conflicted: "n" } },
  firstBoot: {
    registryOpenMs: "n", firstSnapshotMs: "n", coldProjectionMs: "n", firstUsableMs: "n", eventLoopMaxMs: "n",
    coldBuild: { sequence: "n", buildMs: "n" },
  },
  activation: { incumbentMs: "n", successorMs: "n", eventLoopMaxMs: "n" },
  grantWrites: { ...LATENCY, mismatches: "n", failures: "n" },
  externalWrites: { ...LATENCY, mismatches: "n", failures: "n" },
  keyedOperationReads: LATENCY,
  eventLoop: { p95Ms: "n", maxMs: "n" },
  projection: { warmBuilds: LATENCY, queueWait: LATENCY },
  scopeRequests: { ...LATENCY, scopes: "n", failures: "n", maxQueueDepth: "n", refused: "n", expired: "n" },
  worker: { spawns: "n", timeoutRetirements: "n", pidStable: "b" },
  stability: { rounds: "n", responses: "n", emptyResponses: "n", missingRows: "n", extraRows: "n", reattributedRows: "n", missingPins: "n" },
  handover: {
    successor: {
      completed: "b", exitCode: "n?", signal: "s?", readyMs: "n", registryOpenMs: "n", snapshotMs: "n", firstProjectionMs: "n",
      archived: "n", grantMismatches: "n", adoptionMs: "n", adopted: "n",
    },
    switched: "b",
    demotionExitCode: "n?",
    servingRelease: ["incumbent", "successor"],
    serving: { requests: "n", failures: "n" },
  },
  workers: { count: "n", rehosted: "n", answering: "n", progressGapMaxMs: "n", lostProgress: "n", repeatedProgress: "n", failedPings: "n" },
  sqliteBusy: "n",
  runtimeTimeouts: "n",
  runtimeRpc: { requests: "n", p95Ms: "n", maxMs: "n", timeouts: "n", failures: "n", hostAlive: "b" },
  deliveryEvidence: { pending: "n", uncertain: "n", retained: "n", pendingLaunches: "n", preserved: "b" },
};
/* Present only when a browser ran; `browser: null` is read and refused. */
const BROWSER_SHAPE: Shape = {
  views: "n",
  writes: { count: "n", p95Ms: "n", maxMs: "n", failures: "n" },
  readyMaxMs: "n", filesP95Ms: "n", filesMaxMs: "n", filesErrors: "n", viewsWithoutAnswerDuringWrites: "n",
  apiMaxMs: "n", apiMaxRoute: "s?", apiErrors: "n", apiFirstError: "s?", apiUnfinished: "n", bootLagMaxMs: "n", lagP95Ms: "n", lagMaxMs: "n", inputMaxMs: "n", inputsMin: "n",
  selectionsLost: "n", staleNotices: "n",
  server: { samples: "n", bootMaxMs: "n", p95Ms: "n", maxMs: "n" },
};

function shapeErrors(value: unknown, shape: Shape, at: string): string[] {
  const finite = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0;
  if (shape === "n") return finite(value) ? [] : [at];
  if (shape === "n?") return value === null || finite(value) ? [] : [at];
  if (shape === "s?") return value === null || typeof value === "string" ? [] : [at];
  if (shape === "b") return typeof value === "boolean" ? [] : [at];
  if (Array.isArray(shape)) return shape.includes(value as string) ? [] : [at];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [at];
  return Object.entries(shape as Record<string, Shape>)
    .flatMap(([key, inner]) => shapeErrors((value as Record<string, unknown>)[key], inner, at ? `${at}.${key}` : key));
}

/** Validate evidence crossing a process boundary and recompute the verdict.
    Exact duration observations from older images become warnings. Missing
    measurements, independent failures and induced faults remain refusals. */
export function candidatePerformanceEvidence(value: unknown): CandidatePerformanceEvidence {
  const report = value as CandidatePerformanceEvidence;
  if (!report || typeof report !== "object" || typeof report.ok !== "boolean" || typeof report.runtime !== "string"
    || typeof report.checkedAt !== "string" || !Array.isArray(report.breaches)
    || report.breaches.some((breach) => typeof breach !== "string")
    || (report.measurements !== null && typeof report.measurements !== "object")
    || (report.inducedDelayMs !== undefined && typeof report.inducedDelayMs !== "number")
    || (report.induced !== undefined && (!Array.isArray(report.induced) || report.induced.some((item) => typeof item !== "string")))
    || (report.timingWarnings !== undefined && (!Array.isArray(report.timingWarnings) || report.timingWarnings.some((item) => typeof item !== "string")))
    || (report.log !== undefined && (!Array.isArray(report.log) || report.log.some((line) => typeof line !== "string")))) {
    throw new Error("the candidate performance report is malformed");
  }
  const refuse = (detail: string, breaches: string[] = report.breaches): CandidatePerformanceEvidence => ({
    ...report, breaches, ok: false, detail: report.ok || !report.detail ? detail : report.detail,
  });
  if (!report.measurements) return report.ok ? refuse("the candidate performance report passed without measurements") : report;
  const browser = (report.measurements as unknown as Record<string, unknown>).browser;
  const unreadable = [
    ...shapeErrors(report.measurements, MEASUREMENT_SHAPE, ""),
    ...(browser === null ? [] : shapeErrors(browser, BROWSER_SHAPE, "browser")),
  ];
  if (unreadable.length) {
    const named = `${unreadable.slice(0, 6).join(", ")}${unreadable.length > 6 ? ` and ${unreadable.length - 6} more` : ""}`;
    return refuse(`the candidate performance report lacks or garbles ${named}`, [...report.breaches, `unreadable measurement(s): ${named}`]);
  }
  const timingWarnings: string[] = [];
  const computed = candidatePerformanceBreaches(report.measurements, CANDIDATE_PERFORMANCE_BOUNDS, timingWarnings);
  // Older candidate images reported timing thresholds as failures. Recognize
  // only the exact observations recomputed from their complete measurements;
  // an unknown refusal or a distinct failure detail remains a refusal.
  const reportedFailures = report.breaches.filter((breach) => !timingWarnings.includes(breach));
  const breaches = [...reportedFailures, ...computed.filter((breach) => !reportedFailures.includes(breach))];
  const timingOnlyRefusal = !report.ok && report.breaches.length > 0
    && reportedFailures.length === 0
    && (!report.detail || report.breaches.includes(report.detail));
  const normalized: CandidatePerformanceEvidence = { ...report, breaches };
  delete normalized.timingWarnings;
  if (timingWarnings.length) normalized.timingWarnings = timingWarnings;
  if (report.inducedDelayMs || report.induced?.length) {
    return { ...normalized, ok: false, detail: "the candidate performance report ran under an induced fault" };
  }
  if (breaches.length) return {
    ...normalized, ok: false,
    detail: !report.ok && report.detail && !timingWarnings.includes(report.detail) ? report.detail : breaches[0]!,
  };
  if (!report.ok && !timingOnlyRefusal) return normalized;
  delete normalized.detail;
  return { ...normalized, ok: true };
}

/** The gate's failure as one line for the deployment record. */
export function candidatePerformanceDetail(evidence: CandidatePerformanceEvidence): string {
  if (evidence.ok) return "candidate performance gate passed";
  const reasons = evidence.breaches.length ? evidence.breaches.slice(0, 4).join("; ") : evidence.detail ?? "no detail";
  return `candidate performance gate refused the release: ${reasons}`;
}
