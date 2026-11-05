import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { assertOperationLease, currentOperationLease, OperationLeaseExpiredError } from "@/lib/operationLease";
import { PrivacyWorkError, privacyFailureOf, transientPrivacyFailure } from "./privacyFailure";

export const PRIVACY_RETRY_WINDOW_MS = 180_000;
export class PrivacyRetryExhausted extends PrivacyWorkError {}
// Route bundles share a resident worker; its timeout must see the caller's
// cutoff even when that worker was constructed by another bundle.
const host = globalThis as typeof globalThis & { __delegatusPrivacyRetry?: AsyncLocalStorage<{ deadline: number }> };
const context = host.__delegatusPrivacyRetry ??= new AsyncLocalStorage<{ deadline: number }>();
/** The worker includes queueing in this timeout. Nested privacy passes share
 * the original cutoff, including prompt/artifact composition and revision reads. */
export function privacyWorkTimeoutMs(): number {
  return Math.max(1, Math.min(60_000, (context.getStore()?.deadline ?? Infinity) - performance.now()));
}

/** Retries only pre-dispatch preparation. No unchecked result escapes while
 * waiting. A process restart may start a fresh window: no agent was dispatched
 * by a failed privacy pass, and reservation recovery still owns dispatch. */
export async function withPrivacyRetry<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()) return work();
  return context.run({ deadline: performance.now() + PRIVACY_RETRY_WINDOW_MS }, async () => {
    let retries = 0;
    let lastFailure: PrivacyWorkError | undefined;
    for (;;) {
      assertOperationLease();
      try {
        if (performance.now() >= context.getStore()!.deadline) throw new PrivacyRetryExhausted(lastFailure?.failure ?? "worker-timeout");
        const result = await work();
        assertOperationLease();
        if (performance.now() >= context.getStore()!.deadline) throw new PrivacyRetryExhausted(lastFailure?.failure ?? "worker-timeout");
        return result;
      } catch (error) {
        if (error instanceof OperationLeaseExpiredError) throw error;
        const failure = privacyFailureOf(error);
        const remaining = context.getStore()!.deadline - performance.now();
        const retry = transientPrivacyFailure(failure) && remaining > 0;
        console.warn(`[role-memory] privacy preparation failed: ${failure}; ${retry ? "retrying before dispatch" : "refusing; nothing was sent"}`);
        assertOperationLease();
        if (!retry) {
          if (transientPrivacyFailure(failure)) throw new PrivacyRetryExhausted(failure);
          throw error;
        }
        lastFailure = new PrivacyWorkError(failure);
        try {
          await delay(Math.min(remaining, 1_000 * 2 ** Math.min(retries++, 5), 30_000), undefined,
            { signal: currentOperationLease()?.abort.signal });
        } catch (error) { assertOperationLease(); throw error; }
      }
    }
  });
}
