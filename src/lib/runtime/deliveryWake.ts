type Timer = ReturnType<typeof setTimeout>;
type Clock = { now(): number; set(work: () => void, delay: number): Timer; clear(timer: Timer): void };
const defaultClock: Clock = { now: () => performance.now(), set: (work, delay) => { const timer = setTimeout(work, delay); timer.unref(); return timer; }, clear: clearTimeout };

/** One owned timer. A new earlier wake replaces a retry even when the loop
    delivered that retry late. Later requests never postpone accepted work. */
export class DeliveryWake {
  private timer: Timer | undefined;
  private dueAt = Infinity;
  constructor(private readonly work: () => void, private readonly clock: Clock = defaultClock) {}
  schedule(delay: number): boolean {
    const dueAt = this.clock.now() + delay;
    if (this.timer && this.dueAt <= dueAt) return false;
    this.cancel();
    this.dueAt = dueAt;
    this.timer = this.clock.set(() => { this.timer = undefined; this.dueAt = Infinity; this.work(); }, delay);
    return true;
  }
  cancel(): void {
    if (this.timer) this.clock.clear(this.timer);
    this.timer = undefined;
    this.dueAt = Infinity;
  }
}

/** A fresh admission supersedes pending work; an observer can do so only if
    the queue is ready to start a replacement pass. */
export function cancelDeliveryWakeForKick(wake: DeliveryWake, freshAdmission: boolean, passCanStart: boolean): void {
  if (freshAdmission || passCanStart) wake.cancel();
}
