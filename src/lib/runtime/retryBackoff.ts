/** A retry deadline survives unrelated wakes. Success alone resets the budget. */
export class RetryBackoff {
  private failures = 0;
  private nextAt = 0;

  ready(now = Date.now()): boolean { return now >= this.nextAt; }

  fail(now = Date.now()): void {
    this.nextAt = now + Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5));
  }

  reset(): void { this.failures = 0; this.nextAt = 0; }
}
