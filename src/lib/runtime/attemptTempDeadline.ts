import { AsyncLocalStorage } from "node:async_hooks";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

// hrtime has the same monotonic origin in the parent and its helper.
export const sweepMonotonicNow = () => Number(process.hrtime.bigint()) / 1e6;
export const ATTEMPT_TEMP_REPLY_MARGIN_MS = 1000;
const tick = new AsyncLocalStorage<number>();

/** One scope follows all awaited root, copy and namespace work in a tick. */
export function withAttemptTempDeadline<T>(deadline: number, run: () => T): T {
  if (!Number.isFinite(deadline)) throw new Error("invalid attempt temp deadline");
  return tick.run(deadline - ATTEMPT_TEMP_REPLY_MARGIN_MS, run);
}
export function attemptTempRemaining(bound = Infinity) {
  return Math.max(0, Math.min(bound, (tick.getStore() ?? Infinity) - sweepMonotonicNow()));
}
export function checkAttemptTempDeadline() {
  if (attemptTempRemaining() <= 0) throw new AttemptTempBudgetDeferred("tick deadline exhausted; retry next tick");
}
