import { AsyncLocalStorage } from "node:async_hooks";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

// hrtime has the same monotonic origin in the parent and its helper.
export const sweepMonotonicNow = () => Number(process.hrtime.bigint()) / 1e6;
export const ATTEMPT_TEMP_REPLY_MARGIN_MS = 1000;
const tick = new AsyncLocalStorage<{ until: number; pause?: (now: number) => boolean }>();

/** One scope follows all awaited root, copy and namespace work in a tick. */
export function withAttemptTempDeadline<T>(deadline: number, run: () => T, pause?: (now: number) => boolean): T {
  if (!Number.isFinite(deadline)) throw new Error("invalid attempt temp deadline");
  const parent = tick.getStore();
  return tick.run({ until: Math.min(parent?.until ?? Infinity, deadline - ATTEMPT_TEMP_REPLY_MARGIN_MS),
    pause: parent?.pause ?? pause }, run);
}
export function attemptTempRemaining(bound = Infinity) {
  const current = tick.getStore();
  const now = sweepMonotonicNow();
  if (current?.pause?.(now)) return 0;
  return Math.max(0, Math.min(bound, (current?.until ?? Infinity) - now));
}
export function checkAttemptTempDeadline() {
  if (attemptTempRemaining() <= 0) throw new AttemptTempBudgetDeferred("tick deadline exhausted; retry next tick");
}
