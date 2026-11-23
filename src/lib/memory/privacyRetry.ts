import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { assertOperationLease, currentOperationLease, OperationLeaseExpiredError } from "@/lib/operationLease";
import { PrivacyWorkError, privacyFailureOf, transientPrivacyFailure, type PrivacyFailure } from "./privacyFailure";

export const PRIVACY_RETRY_WINDOW_MS = 180_000;
export class PrivacyRetryExhausted extends PrivacyWorkError {
  constructor(failure: PrivacyFailure, readonly summary: string) { super(failure); }
}
type Phase = "composition" | "privacy worker request" | "backoff";
type Window = {
  deadline: number; phase: Phase; since: number; elapsed: Record<Phase, number>;
  workers: number; requests: number; reruns: number; lastFailure?: PrivacyFailure; exhaustedPhase?: Phase; lastRequestClipped?: boolean; backingOff?: boolean;
};
type RetryContext = { window: Window; request?: { clipped: boolean } };
// Route bundles share a resident worker; its timeout must see the caller's
// cutoff even when that worker was constructed by another bundle.
const host = globalThis as typeof globalThis & { __delegatusPrivacyRetry?: AsyncLocalStorage<RetryContext> };
const context = host.__delegatusPrivacyRetry ??= new AsyncLocalStorage<RetryContext>();
function phase(window: Window, next: Phase) {
  const now = performance.now();
  window.elapsed[window.phase] += Math.max(0, now - window.since);
  if (now >= window.deadline) window.exhaustedPhase ??= window.phase;
  window.phase = next;
  window.since = now;
}
function exhausted(window: Window): PrivacyRetryExhausted {
  phase(window, window.phase);
  const seconds = (phase: Phase) => (window.elapsed[phase] / 1_000).toFixed(1);
  return new PrivacyRetryExhausted(window.lastFailure ?? "window-exhausted",
    `retry window exhausted after 180 seconds during ${window.exhaustedPhase ?? window.phase}; privacy worker requests ${window.requests} (${seconds("privacy worker request")} s), composition ${seconds("composition")} s, backoff ${seconds("backoff")} s, revision reruns ${window.reruns}`);
}
/** Nested filters can finish before their outer preparation rejects a late
 * result. Such a result must not seed the completed cache. */
export function privacyPreparationHasTime(): boolean {
  const window = context.getStore()?.window;
  return !window || performance.now() < window.deadline;
}
export function privacyRevisionRerun(): void { const window = context.getStore()?.window; if (window) window.reruns++; }
export function privacyFailureObserved(failure: PrivacyFailure): void {
  const window = context.getStore()?.window;
  if (!window) return;
  if (failure === "window-exhausted") window.exhaustedPhase ??= window.phase;
  else window.lastFailure = failure;
}
/** A request owns its clipping flag even when callers filter concurrently. */
export async function privacyWorkerRequest<T>(work: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current) return work();
  const window = current.window;
  window.requests++;
  if (window.workers++ === 0) phase(window, "privacy worker request");
  try { return await context.run({ window, request: { clipped: false } }, work); }
  finally { if (--window.workers === 0) phase(window, window.backingOff ? "backoff" : "composition"); }
}
export function privacyRequestWasClipped(): boolean {
  // Timer delays can truncate a fractional remainder. The request's budget
  // identifies its timeout even when the callback precedes the exact cutoff.
  return context.getStore()?.request?.clipped === true;
}
/** The worker includes queueing in this timeout. Nested privacy passes share
 * the original cutoff, including prompt/artifact composition and revision reads. */
export function privacyWorkTimeoutMs(): number {
  const current = context.getStore();
  const remaining = (current?.window.deadline ?? Infinity) - performance.now();
  if (current?.request) current.request.clipped = remaining < 60_000;
  if (current) current.window.lastRequestClipped = remaining < 60_000;
  return Math.max(1, Math.min(60_000, remaining));
}

/** Retries only pre-dispatch preparation. No unchecked result escapes while
 * waiting. A process restart may start a fresh window: no agent was dispatched
 * by a failed privacy pass, and reservation recovery still owns dispatch. */
export async function withPrivacyRetry<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()) return work();
  const started = performance.now();
  const window: Window = { deadline: started + PRIVACY_RETRY_WINDOW_MS, phase: "composition", since: started,
    elapsed: { composition: 0, "privacy worker request": 0, backoff: 0 }, workers: 0, requests: 0, reruns: 0 };
  return context.run({ window }, async () => {
    let retries = 0;
    for (;;) {
      assertOperationLease();
      try {
        if (performance.now() >= window.deadline) throw exhausted(window);
        const result = await work();
        assertOperationLease();
        if (performance.now() >= window.deadline) throw exhausted(window);
        return result;
      } catch (error) {
        if (error instanceof OperationLeaseExpiredError) throw error;
        assertOperationLease();
        const failure = privacyFailureOf(error);
        // The revision owner must receive its original deferral. Replaying it
        // here would turn the caller's stability wait into terminal exhaustion.
        if (error && typeof error === "object" && "roleMemoryChanged" in error && error.roleMemoryChanged === true) {
          console.warn("[role-memory] privacy preparation failed: store-changed; deferring to the caller");
          throw error;
        }
        const remaining = window.deadline - performance.now();
        if (error instanceof PrivacyRetryExhausted || failure === "window-exhausted" || remaining <= 0 && transientPrivacyFailure(failure)) {
          if (!(error instanceof PrivacyRetryExhausted) && !(failure === "worker-timeout" && window.lastRequestClipped)) privacyFailureObserved(failure);
          const refusal = error instanceof PrivacyRetryExhausted ? error : exhausted(window);
          console.warn(`[role-memory] privacy preparation failed: ${refusal.failure}; ${refusal.summary}; refusing; nothing was sent`);
          throw refusal;
        }
        const retry = transientPrivacyFailure(failure) && remaining > 0;
        console.warn(`[role-memory] privacy preparation failed: ${failure}; ${retry ? "retrying before dispatch" : "refusing; nothing was sent"}`);
        assertOperationLease();
        if (!retry) {
          throw error;
        }
        privacyFailureObserved(failure);
        window.backingOff = true;
        phase(window, window.workers ? "privacy worker request" : "backoff");
        try {
          await delay(Math.min(remaining, 1_000 * 2 ** Math.min(retries++, 5), 30_000), undefined,
            { signal: currentOperationLease()?.abort.signal });
        } catch (error) { assertOperationLease(); throw error; }
        finally { window.backingOff = false; phase(window, window.workers ? "privacy worker request" : "composition"); }
      }
    }
  });
}
