import { AsyncLocalStorage } from "node:async_hooks";
import { deadlineSignal, type DeadlineScheduler } from "@/lib/deadline";
import { forEachCooperatively, yieldToRuntime, type CooperativeBatchOptions } from "@/lib/cooperative";

const currentWork = new AsyncLocalStorage<SeatTickWork>();

/** One deadline covers preparation, evidence, retries and dispatch. The scope
 * also fences continuations of a source which cannot cancel its own I/O. */
export class SeatTickWork {
  phase = "opening";
  readonly started: number;
  progressed: number;
  private closed = false;
  private readonly cancellation = new AbortController();
  private readonly deadline;

  constructor(readonly project: string, readonly budgetMs: number,
    readonly clock: () => number = () => performance.now(), scheduler?: DeadlineScheduler) {
    this.started = this.progressed = clock();
    this.deadline = deadlineSignal(budgetMs, { scheduler, signal: this.cancellation.signal, reason: "seat project deadline exceeded" });
  }

  get signal(): AbortSignal { return this.deadline.signal; }
  get remainingMs(): number { return Math.max(0, this.budgetMs - (this.clock() - this.started)); }

  assert(): void {
    this.deadline.signal.throwIfAborted();
    if (this.closed) throw new Error("seat project check ended");
    if (this.clock() - this.started >= this.budgetMs) throw new Error("seat project deadline exceeded");
  }

  async wait<T>(label: string, value: PromiseLike<T>): Promise<T> {
    // The caller may have already started this work. Install a rejection
    // observer before checking the deadline so an expired opening scope
    // cannot abandon a later rejecting continuation.
    const observed = Promise.resolve(value);
    void observed.catch(() => {});
    this.assert();
    this.phase = label;
    this.progressed = this.clock();
    const signal = this.deadline.signal;
    let abort!: () => void;
    try {
      const result = await Promise.race([observed, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      })]);
      this.assert();
      this.progressed = this.clock();
      return result;
    } finally { signal.removeEventListener("abort", abort); }
  }

  /** Functions keep their receiver. Nested port objects (reports, recovery,
   * maintenance) are fenced too; returned domain values are left untouched. */
  ports<T extends object>(ports: T, label: string): T {
    const wrappers = new Map<PropertyKey, unknown>();
    return new Proxy(ports, { get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" && (!value || typeof value !== "object")) return value;
      const cached = wrappers.get(key) as { value: unknown; wrapped: unknown } | undefined;
      if (cached?.value === value) return cached.wrapped;
      const wrapped = typeof value === "function" ? (...args: unknown[]) => {
        this.assert();
        this.phase = `${label}.${String(key)}`;
        this.progressed = this.clock();
        const result = Reflect.apply(value, target, args);
        return result && typeof (result as PromiseLike<unknown>).then === "function"
          ? this.wait(this.phase, result as PromiseLike<unknown>) : result;
      } : this.ports(value, `${label}.${String(key)}`);
      wrappers.set(key, { value, wrapped });
      return wrapped;
    } });
  }

  run<T>(work: () => Promise<T>): Promise<T> { return currentWork.run(this, work); }
  close(): void {
    this.closed = true;
    this.cancellation.abort(new Error("seat project check ended"));
    this.deadline.release();
  }
  detail(): string {
    const age = Math.max(0, Math.round(this.clock() - this.started));
    const quiet = Math.max(0, Math.round(this.clock() - this.progressed));
    return `project=${this.project}; ageMs=${age}; phase=${this.phase}; progressAgeMs=${quiet}; budgetMs=${this.budgetMs}; state=${age >= this.budgetMs || quiet >= this.budgetMs ? "stuck" : "running"}`;
  }
}

export function seatTickWorkDetail(): string | undefined { return currentWork.getStore()?.detail(); }
export function seatTickWorkSignal(): AbortSignal | undefined { return currentWork.getStore()?.signal; }
export function seatTickWorkRemainingMs(): number | undefined { return currentWork.getStore()?.remainingMs; }
export function assertSeatTickWork(): void { currentWork.getStore()?.assert(); }
export function guardedSeatTickPort<T extends object>(port: T, label: string): T {
  return currentWork.getStore()?.ports(port, label) ?? port;
}
export async function seatTickYield(): Promise<void> {
  assertSeatTickWork();
  await yieldToRuntime();
  assertSeatTickWork();
}
export async function forEachSeatTickRow<T>(rows: readonly T[], visit: (row: T, index: number) => void | Promise<void>, options?: CooperativeBatchOptions): Promise<void> {
  await forEachCooperatively(rows, async (row, index) => {
    assertSeatTickWork();
    await visit(row, index);
    assertSeatTickWork();
  }, options);
  assertSeatTickWork();
}
