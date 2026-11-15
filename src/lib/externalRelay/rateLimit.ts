import { ExternalRelayError } from "./errors";

export const RELAY_RATE_LIMIT_RETRIES = 3;
export async function relayRetrySleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
type RetryOptions = {
  signal: AbortSignal; deadlineAt: number; now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};
/** Leave time for another dispatch; a late wake must never send it. */
export async function waitForRelayRateLimit(seconds: number | null | undefined, options: RetryOptions) {
  const now = options.now ?? Date.now;
  const delay = Math.min(60, Math.max(1, seconds != null && Number.isFinite(seconds) ? seconds : 1)) * 1000;
  options.signal.throwIfAborted();
  if (now() + delay >= options.deadlineAt) return false;
  await (options.sleep ?? relayRetrySleep)(delay, options.signal);
  options.signal.throwIfAborted();
  return now() < options.deadlineAt;
}
/** Retry only an HTTP refusal, before the download consumer opens a file. */
export async function retryRelayMediaDownload<T>(download: () => Promise<T>, options: RetryOptions) {
  for (let retries = 0; ; retries++) {
    options.signal.throwIfAborted();
    try { return await download(); }
    catch (error) {
      if (!(error instanceof ExternalRelayError) || error.status !== 429 || retries >= RELAY_RATE_LIMIT_RETRIES ||
        !await waitForRelayRateLimit(error.retryAfterSeconds, options)) throw error;
    }
  }
}
