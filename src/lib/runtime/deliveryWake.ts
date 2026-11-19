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

/** Map iteration retains its position without copying or sorting the fleet.
 * A controller owns one iterator; retiring that controller drops the cursor.
 * Each call probes at most limit hosts, including skipped/cooling hosts. */
export class DeliveryHostPage<K, V> {
  private iterator: MapIterator<[K, V]> | null = null;
  constructor(private readonly hosts: Map<K, V>, private readonly limit = 8) {}
  get pending(): boolean { return this.iterator !== null; }
  reset(): void { this.iterator = null; }
  next(): Array<[K, V]> {
    this.iterator ??= this.hosts.entries();
    const page: Array<[K, V]> = [];
    for (let count = 0; count < this.limit; count++) {
      const item = this.iterator.next();
      if (item.done) { this.iterator = null; break; }
      const [key, host] = item.value;
      if (this.hosts.get(key) === host) page.push([key, host]);
    }
    return page;
  }
}
