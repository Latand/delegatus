import { describe, expect, test } from "bun:test";

import { cacheSizes } from "@/lib/cacheTelemetry";
import { Aborted, BoundedCache, Flights, QueueFull, Semaphore, createTaskFilesCaches } from "./cache";

const options = (now: () => number, overrides: Partial<ConstructorParameters<typeof BoundedCache>[0]> = {}) => ({
  name: "probe", maxEntries: 3, maxBytes: 100, maxEntryBytes: 60, ageMs: 1000, age: "idle" as const, now, ...overrides,
});

describe("BoundedCache", () => {
  test("evicts the least recently used entry at the entry bound", () => {
    const cache = new BoundedCache<string, string>(options(() => 0));
    cache.set("a", "A", 1);
    cache.set("b", "B", 1);
    cache.set("c", "C", 1);
    expect(cache.get("a")).toBe("A");
    cache.set("d", "D", 1);
    expect([cache.get("a"), cache.get("b"), cache.get("c"), cache.get("d")]).toEqual(["A", undefined, "C", "D"]);
    expect(cache.size).toBe(3);
  });

  test("never holds more than its byte bound and refuses an entry above the per-entry bound", () => {
    const cache = new BoundedCache<string, string>(options(() => 0, { maxEntries: 10 }));
    expect(cache.set("a", "A", 50)).toBe(true);
    expect(cache.set("b", "B", 50)).toBe(true);
    expect(cache.set("c", "C", 50)).toBe(true);
    expect(cache.bytes).toBeLessThanOrEqual(100);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.set("big", "X", 61)).toBe(false);
    expect(cache.get("big")).toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(100);
  });

  test("idle age refreshes on a hit; absolute age does not", () => {
    let t = 0;
    const idle = new BoundedCache<string, string>(options(() => t));
    const absolute = new BoundedCache<string, string>(options(() => t, { age: "absolute" }));
    idle.set("a", "A", 1);
    absolute.set("a", "A", 1);
    t = 800;
    expect(idle.get("a")).toBe("A");
    expect(absolute.get("a")).toBe("A");
    t = 1500;
    expect(idle.get("a")).toBe("A");
    expect(absolute.get("a")).toBeUndefined();
    t = 3000;
    expect(idle.get("a")).toBeUndefined();
    expect(idle.bytes).toBe(0);
  });

  test("insertion sweeps expired entries without a timer", () => {
    let t = 0;
    const cache = new BoundedCache<string, string>(options(() => t));
    cache.set("a", "A", 10);
    t = 5000;
    cache.set("b", "B", 10);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(10);
  });

  test("its entries are reported under the one owner", () => {
    const caches = createTaskFilesCaches();
    caches.blobs.set("k", Buffer.alloc(1000), 1000);
    const row = cacheSizes().caches.find((entry) => entry.owner === "taskFiles/cache" && entry.name === "blobs");
    expect(row?.count).toBeGreaterThanOrEqual(1);
    expect(row?.bytes).toBeGreaterThanOrEqual(1000);
    caches.reset();
  });
});

describe("Semaphore", () => {
  test("a third read waits, the line is bounded, and an aborted waiter leaves it", async () => {
    const gate = new Semaphore(2, 2);
    const first = await gate.acquire();
    const second = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    const waitingOther = gate.acquire();
    expect(gate.running).toBe(2);
    expect(gate.waiting).toBe(2);
    await expect(gate.acquire()).rejects.toBeInstanceOf(QueueFull);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(Aborted);
    expect(gate.waiting).toBe(1);
    first();
    const granted = await waitingOther;
    expect(gate.running).toBe(2);
    granted();
    second();
    expect(gate.running).toBe(0);
  });

  test("an already aborted signal never takes a slot", async () => {
    const gate = new Semaphore(1, 1);
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire(controller.signal)).rejects.toBeInstanceOf(Aborted);
    expect(gate.running).toBe(0);
  });
});

describe("Flights", () => {
  test("identical concurrent work runs once", async () => {
    const flights = new Flights<number>();
    let runs = 0;
    let finish: (value: number) => void = () => {};
    const start = () => new Promise<number>((resolve) => { runs += 1; finish = resolve; });
    const all = Promise.all([flights.join("k", undefined, start), flights.join("k", undefined, start), flights.join("k", undefined, start)]);
    finish(7);
    expect(await all).toEqual([7, 7, 7]);
    expect(runs).toBe(1);
    expect(flights.size).toBe(0);
  });

  test("one waiter leaving does not stop the run; the last one leaving aborts its signal", async () => {
    const flights = new Flights<number>();
    let seen: AbortSignal | null = null;
    let finish: (value: number) => void = () => {};
    const start = (signal: AbortSignal) => new Promise<number>((resolve) => { seen = signal; finish = resolve; });
    const one = new AbortController();
    const two = new AbortController();
    const first = flights.join("k", one.signal, start);
    const second = flights.join("k", two.signal, start);
    one.abort();
    await expect(first).rejects.toBeInstanceOf(Aborted);
    expect(seen!.aborted).toBe(false);
    two.abort();
    await expect(second).rejects.toBeInstanceOf(Aborted);
    expect(seen!.aborted).toBe(true);
    finish(1);
  });
});
