import { MeasuredCache } from "@/lib/cacheTelemetry";

/* The one owner of everything the task file routes keep between requests
   (docs/design/task-file-preview.md §6.5): three bounded maps, in-flight
   coalescing and two semaphores. Entries hold Git facts and committed bytes
   addressed by repository, revision and object id, never an authorization
   decision, so a hit never replaces a per-request check. Nothing persists and
   no timer runs: age is checked on access and on insertion. */

const OWNER = "taskFiles/cache";

export const TASK_FILES_CAPS = {
  listEntries: 128,
  listBytes: 8 * 1024 * 1024,
  /** One list payload above this is answered but never kept. */
  listEntryBytes: 1024 * 1024,
  listIdleMs: 30 * 60_000,
  resolvedEntries: 512,
  resolvedAgeMs: 60_000,
  blobBytes: 24 * 1024 * 1024,
  blobEntries: 48,
  blobEntryBytes: 8 * 1024 * 1024,
  blobIdleMs: 10 * 60_000,
  readSlots: 2,
  readQueue: 16,
  listSlots: 2,
  listQueue: 32,
} as const;

export type TaskFilesCaps = { -readonly [K in keyof typeof TASK_FILES_CAPS]: number };

type Entry<V> = { value: V; bytes: number; insertedAt: number; usedAt: number };

type BoundedOptions = {
  name: string;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  /** Idle age refreshes on every hit; absolute age never does. */
  ageMs: number;
  age: "idle" | "absolute";
  now: () => number;
};

/** Least recently used, bounded by entries and bytes, expiring on access. */
export class BoundedCache<K, V> {
  private readonly map: MeasuredCache<K, Entry<V>>;
  private total = 0;
  constructor(private readonly options: BoundedOptions) {
    this.map = new MeasuredCache<K, Entry<V>>(options.name, OWNER, (entry) => entry.bytes, "estimated-bytes");
  }

  get size(): number { return this.map.size; }
  get bytes(): number { return this.total; }

  private expired(entry: Entry<V>): boolean {
    const from = this.options.age === "idle" ? entry.usedAt : entry.insertedAt;
    return this.options.now() - from > this.options.ageMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.expired(entry)) { this.remove(key); return undefined; }
    entry.usedAt = this.options.now();
    // Re-insert so Map order is recency order.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** False when the value is too large to keep; the caller still uses it. */
  set(key: K, value: V, bytes: number): boolean {
    this.remove(key);
    if (bytes > this.options.maxEntryBytes || bytes > this.options.maxBytes) return false;
    this.sweep();
    while (this.map.size >= this.options.maxEntries || this.total + bytes > this.options.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
    const now = this.options.now();
    this.map.set(key, { value, bytes, insertedAt: now, usedAt: now });
    this.total += bytes;
    return true;
  }

  private remove(key: K): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.total -= entry.bytes;
    this.map.delete(key);
  }

  /** Drops every expired entry; runs on insertion, never on a timer. */
  private sweep(): void {
    for (const [key, entry] of [...this.map]) if (this.expired(entry)) this.remove(key);
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

export class QueueFull extends Error {}
export class Aborted extends Error {}

/** A counting semaphore with a bounded waiting line. A waiter whose signal
    aborts leaves the line, so a read nobody waits for never starts. */
export class Semaphore {
  private active = 0;
  private readonly line: Array<{ grant: () => void; signal?: AbortSignal; onAbort: () => void }> = [];
  constructor(private readonly slots: number, private readonly queue: number) {}

  get running(): number { return this.active; }
  get waiting(): number { return this.line.length; }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Aborted());
    const release = () => {
      this.active -= 1;
      this.pump();
    };
    if (this.active < this.slots) {
      this.active += 1;
      return Promise.resolve(release);
    }
    if (this.line.length >= this.queue) return Promise.reject(new QueueFull());
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", waiter.onAbort);
          this.active += 1;
          resolve(release);
        },
        signal,
        onAbort: () => {
          const at = this.line.indexOf(waiter);
          if (at >= 0) this.line.splice(at, 1);
          reject(new Aborted());
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.line.push(waiter);
    });
  }

  private pump(): void {
    while (this.active < this.slots && this.line.length) this.line.shift()!.grant();
  }
}

type Flight<T> = { promise: Promise<T>; waiters: number; controller: AbortController };

/** Concurrent identical work shares one run. The run's signal aborts only when
    every waiter has left, so one caller's cancellation never starves another. */
export class Flights<T> {
  private readonly flights = new Map<string, Flight<T>>();

  get size(): number { return this.flights.size; }

  async join(key: string, signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new Aborted();
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight<T> = { controller, waiters: 0, promise: undefined as unknown as Promise<T> };
      created.promise = start(controller.signal).finally(() => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      });
      // The shared promise may settle after every waiter left.
      created.promise.catch(() => {});
      this.flights.set(key, created);
      flight = created;
    }
    const joined = flight;
    joined.waiters += 1;
    let onAbort = () => {};
    try {
      return await new Promise<T>((resolve, reject) => {
        onAbort = () => reject(new Aborted());
        signal?.addEventListener("abort", onAbort, { once: true });
        joined.promise.then(resolve, reject);
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      joined.waiters -= 1;
      if (joined.waiters === 0) {
        joined.controller.abort();
        if (this.flights.get(key) === joined) this.flights.delete(key);
      }
    }
  }
}

export type TaskFilesCaches = ReturnType<typeof createTaskFilesCaches>;

export function createTaskFilesCaches(overrides: Partial<TaskFilesCaps> = {}, now: () => number = Date.now) {
  const caps: TaskFilesCaps = { ...TASK_FILES_CAPS, ...overrides };
  return {
    caps,
    now,
    lists: new BoundedCache<string, unknown>({ name: "lists", maxEntries: caps.listEntries, maxBytes: caps.listBytes, maxEntryBytes: caps.listEntryBytes, ageMs: caps.listIdleMs, age: "idle", now }),
    resolved: new BoundedCache<string, unknown>({ name: "resolved", maxEntries: caps.resolvedEntries, maxBytes: caps.resolvedEntries * 4096, maxEntryBytes: 4096, ageMs: caps.resolvedAgeMs, age: "absolute", now }),
    blobs: new BoundedCache<string, Buffer>({ name: "blobs", maxEntries: caps.blobEntries, maxBytes: caps.blobBytes, maxEntryBytes: caps.blobEntryBytes, ageMs: caps.blobIdleMs, age: "idle", now }),
    listFlights: new Flights<unknown>(),
    resolveFlights: new Flights<unknown>(),
    blobFlights: new Flights<Buffer>(),
    readGate: new Semaphore(caps.readSlots, caps.readQueue),
    listGate: new Semaphore(caps.listSlots, caps.listQueue),
    reset(): void {
      this.lists.clear();
      this.resolved.clear();
      this.blobs.clear();
    },
  };
}

const host = globalThis as typeof globalThis & { __llvTaskFilesCaches?: TaskFilesCaches };

/** The process's one set; survives module reloads in development. */
export function taskFilesCaches(): TaskFilesCaches {
  return host.__llvTaskFilesCaches ??= createTaskFilesCaches();
}
