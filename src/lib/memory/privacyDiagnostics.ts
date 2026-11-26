import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { createLoopLogSink } from "@/lib/viewerLoopMonitor";
import { sharedLinkState } from "@/lib/links/runtimeState";
import type { PrivacyFailure } from "./privacyFailure";

type Owner = { pipeline: string; stage: string; attempt: number };
export type PrivacyCorrelation = { requestId: string; jobId: string };
type Phase = "queued" | "dispatched" | "started" | "compile" | "match" | "cancelled" | "settled" | "timeout";
type Failure = PrivacyFailure | "CURATE_LIVE" | "CURATE_INVALID";
export type PrivacyWorkerObservation = PrivacyCorrelation & {
  owner: Owner | "unknown"; phase: Phase; lastPhase: Phase;
  queuedAt: string; budgetMs: number; elapsedMs: number; queueMs: number | "unknown"; executeMs: number | "unknown";
  cancelled: boolean; failure?: Failure;
};
export const PRIVACY_OBSERVATION_LIMIT = 128;
const shared = sharedLinkState("privacy.worker.observations", () => ({
  context: new AsyncLocalStorage<{ requestId: string; owner: Owner }>(),
  rows: [] as PrivacyWorkerObservation[], evicted: 0, sink: createLoopLogSink(),
}));
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** Only server-owned attempt coordinates enter here. Hash labels so even an
 * untrusted stage name cannot put text, paths or credentials into diagnostics.
 * This context grants no authority and never participates in dispatch. */
export function withPrivacyWorkerOwner<T>(pipeline: string, stage: string, attempt: number, work: () => T): T {
  const owner = { pipeline: digest(pipeline), stage: digest(stage), attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0 };
  const current = shared.context.getStore();
  if (current && JSON.stringify(current.owner) === JSON.stringify(owner)) return work();
  return shared.context.run({ requestId: crypto.randomUUID(), owner }, work);
}

/** A bounded, process-local diagnostic tail, shared by route bundles. The
 * existing journal sink receives one terminal summary per admitted job; its
 * bounded backlog drops instead of blocking. Snapshot readers cannot edit it. */
export function privacyWorkerObservations() {
  return { rows: shared.rows.map(row => ({ ...row, owner: row.owner === "unknown" ? "unknown" as const : { ...row.owner } })),
    evicted: shared.evicted, droppedLogs: shared.sink.dropped() };
}

export function observePrivacyWorkerJob(budgetMs: number) {
  const caller = shared.context.getStore();
  const correlation: PrivacyCorrelation = { requestId: caller?.requestId ?? crypto.randomUUID(), jobId: crypto.randomUUID() };
  const owner = caller?.owner ?? "unknown";
  const queuedAt = new Date().toISOString(), queued = performance.now();
  let started: number | undefined, phase: Phase = "queued", cancelled = false;
  const emit = (next: Phase, failure?: Failure) => {
    const now = performance.now();
    if (next === "started" && started === undefined) started = now;
    if (next === "cancelled") cancelled = true;
    const row: PrivacyWorkerObservation = { ...correlation, owner, phase: next, lastPhase: phase, queuedAt, budgetMs,
      elapsedMs: Math.max(0, Math.round(now - queued)),
      queueMs: started === undefined ? phase === "queued" && (next === "timeout" || next === "settled")
        ? Math.max(0, Math.round(now - queued)) : "unknown" : Math.max(0, Math.round(started - queued)),
      executeMs: started === undefined ? "unknown" : Math.max(0, Math.round(now - started)),
      cancelled, ...(failure ? { failure } : {}) };
    if (shared.rows.length === PRIVACY_OBSERVATION_LIMIT) { shared.rows.shift(); shared.evicted++; }
    shared.rows.push(row);
    if (next === "settled" || next === "timeout") shared.sink.enqueue(`[privacy-worker] ${JSON.stringify(row)}`);
    if (next !== "cancelled") phase = next;
  };
  emit("queued");
  return { correlation, emit };
}
