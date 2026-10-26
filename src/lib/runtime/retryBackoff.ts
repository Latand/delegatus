import { backoffDelayMs } from "../deadline";

/** A retry deadline survives unrelated wakes. Success alone resets the budget. */
export class RetryBackoff {
  private failures = 0;
  private nextAt = 0;

  ready(now = Date.now()): boolean { return now >= this.nextAt; }

  fail(now = Date.now()): void {
    this.nextAt = now + this.nextDelayMs();
    this.failures += 1;
  }

  reset(): void { this.failures = 0; this.nextAt = 0; }

  /** The wait the next {@link fail} sets. */
  nextDelayMs(): number { return backoffDelayMs(this.failures + 1, { baseMs: 1_000, maxMs: 30_000, jitter: 0 }); }
}
