import { expect, test } from "bun:test";
import { createHeapAttribution, createWeakRegistry, type ProcessMetadata } from "./heapAttribution";

test("process groups distinguish running and exited survivors and compute exit age", () => {
  const tracker = createHeapAttribution();
  const held = [{}, {}, {}];
  const meta: ProcessMetadata = { api: "Bun.spawn", site: "src/lib/worker.ts:12:3", command: "bun", pid: 123,
    startedAt: 100, exitedAt: null, exitCode: null, signal: null };
  tracker.processes.add(held[0]!, { ...meta });
  tracker.processes.add(held[1]!, { ...meta, exitedAt: 200, exitCode: 0 });
  tracker.processes.add(held[2]!, { ...meta, exitedAt: 400, exitCode: 1 });
  const snapshot = tracker.snapshot(1000);
  expect(snapshot.processes).toMatchObject({ running: 1, exited: 2, dropped: 0 });
  expect(snapshot.processes.groups[0]).toMatchObject({ running: 1, exited: 2, oldestExitedAgeMs: 800 });
  snapshot.processes.oldest[0]!.command = "changed";
  expect(tracker.snapshot(1000).processes.oldest[0]!.command).toBe("bun");
});

test("sites retain only repository frames, reuse strings and bound cardinality", () => {
  const tracker = createHeapAttribution();
  const stack = "Error\n at wrap (/srv/app/src/lib/processAttribution.ts:4:2)\n at call (/srv/app/src/lib/worker.ts:9:8)\n at private (/private/hidden.ts:2:3)";
  expect(tracker.site(stack)).toBe("src/lib/worker.ts:9:8");
  expect(tracker.site(stack)).toBe("src/lib/worker.ts:9:8");
  expect(tracker.site("Error\n at /private/hidden.ts:2:3")).toBe("unknown");
  expect(tracker.site("Error\n at /srv/app/.next/server/chunks/42.js:8:1")).toBe(".next/server/chunks/42.js:8:1");
  for (let i = 0; i < 300; i++) tracker.site(`Error\n at /srv/app/src/lib/site${i}.ts:1:1`);
  expect(tracker.site("Error\n at /srv/app/src/lib/last.ts:1:1")).toBe("other-sites");
  expect(tracker.snapshot().processes.siteOverflow).toBeGreaterThan(0);
});

test("weak registries deduplicate, report saturation and let targets die", async () => {
  const registry = createWeakRegistry<object, number>(1);
  let target: object | null = {};
  const ref = new WeakRef(target);
  expect(registry.add(target, 1)).toBe(true);
  expect(registry.add(target, 2)).toBe(false);
  const declined = {};
  expect(registry.add(declined, 3)).toBe(false);
  expect(registry.has(declined)).toBe(false);
  expect(registry.dropped()).toBe(1);
  target = null;
  let live = true;
  for (let round = 0; round < 30 && live; round++) {
    await Bun.sleep(1); Bun.gc(true);
    live = ref.deref() !== undefined;
  }
  expect(live).toBe(false);
  let visits = 0;
  registry.visit(() => visits++);
  expect(visits).toBe(0);
  expect(registry.add(declined, 4)).toBe(true);
});

test("host snapshots retain scalar sizes, include queued subscriber events and bound details", () => {
  const tracker = createHeapAttribution();
  const hosts = Array.from({ length: 300 }, (_, events) => ({ heapAttribution: () => ({ engine: "codex", events,
    eventSubscribers: 2, stateSubscribers: 1, queuedEvents: 8 }) }));
  for (const host of hosts) tracker.hosts.add(host, null);
  expect(tracker.snapshot().hosts).toMatchObject({ count: 300, omittedDetails: 44,
    byEngine: { codex: { hosts: 300, events: 44850, eventSubscribers: 600, stateSubscribers: 300, queuedEvents: 2400 } } });
  expect(tracker.snapshot().hosts.largest).toHaveLength(256);
  expect(tracker.snapshot(0, false).hosts.largest).toEqual([]);
});


test("host byte totals, largest host and trimmed counts survive compact sampling and bounded details", () => {
  const tracker = createHeapAttribution();
  const hosts = [100, 500, 200].map((windowBytes, index) => ({ heapAttribution: () => ({
    engine: index === 2 ? "claude" : "codex", events: index + 1, eventSubscribers: 0, stateSubscribers: 0, queuedEvents: 0,
    windowBytes, windowByteLimit: 1024, trimmedEvents: index,
  }) }));
  for (const host of hosts) tracker.hosts.add(host, null);
  for (const details of [true, false]) {
    const snapshot = tracker.snapshot(0, details).hosts;
    expect(snapshot).toMatchObject({ windowBytes: 800, largestWindowBytes: 500, trimmedEvents: 3,
      byEngine: { codex: { windowBytes: 600, largestWindowBytes: 500, trimmedEvents: 1 }, claude: { windowBytes: 200, largestWindowBytes: 200, trimmedEvents: 2 } } });
    if (details) expect(snapshot.largest.map(row => row.windowBytes)).toEqual([500, 200, 100]);
    else expect(snapshot.largest).toEqual([]);
  }
  expect(createHeapAttribution().snapshot().hosts).toMatchObject({ windowBytes: 0, largestWindowBytes: 0, trimmedEvents: 0 });
});
