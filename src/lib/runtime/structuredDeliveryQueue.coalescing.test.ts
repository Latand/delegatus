import { expect, test } from "bun:test";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";

test("overlapping post-admission observers share one follow-up listing", async () => {
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let listings = 0;
  const queue = new StructuredDeliveryQueue({
    async effects() { if (++listings === 1) { entered(); await barrier; } return []; },
    async status() { return null; }, async transition() {},
  }, () => null);
  const first = queue.drain();
  await started;
  const observers = Array.from({ length: 128 }, () => queue.drainAfterAdmission());
  release();
  await Promise.all([first, ...observers]);
  expect(listings).toBe(2);
});

test("continuous wakes return after a bounded drain and keep one owed wake", async () => {
  let listings = 0;
  let retries = 0;
  const queue: StructuredDeliveryQueue = new StructuredDeliveryQueue({
    async effects() { if (++listings < 20) void queue.drain(); return []; },
    async status() { return null; }, async transition() {},
  }, () => null, undefined, () => { retries++; });
  await queue.drain();
  expect(listings).toBeLessThanOrEqual(2);
  expect(retries).toBe(1);
  queue.retire();
});

test("an admission during the follow-up read owns a subsequent read", async () => {
  const releases: Array<() => void> = [];
  const entered: Array<() => void> = [];
  const started = Array.from({ length: 3 }, () => new Promise<void>(resolve => { entered.push(resolve); }));
  let listings = 0;
  const queue = new StructuredDeliveryQueue({
    async effects() {
      const index = listings++;
      entered[index]();
      await new Promise<void>(resolve => { releases[index] = resolve; });
      return [];
    }, async status() { return null; }, async transition() {},
  }, () => null);
  const first = queue.drain();
  await started[0];
  const admission = queue.drainAfterAdmission(true);
  releases[0]();
  await started[1];
  const later = queue.drainAfterAdmission(true);
  releases[1]();
  await admission;
  // Observe the boundary independently before allowing the last read to end.
  await Promise.race([started[2], new Promise(resolve => setTimeout(resolve, 50))]);
  expect(listings).toBe(3);
  releases[2]?.();
  await Promise.all([first, admission, later]);
});
