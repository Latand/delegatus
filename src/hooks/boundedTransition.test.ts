import { expect, test } from "bun:test";

import { BACKGROUND_PUBLISH_DEADLINE_MS, createBoundedPublisher } from "./boundedTransition";

function harness() {
  let committed = 0;
  const applied: number[] = [];
  const deferred: Array<() => void> = [];
  const timers = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 1;
  const publisher = createBoundedPublisher<number>({
    apply: (value) => applied.push(value),
    committed: () => committed,
    defer: (run) => deferred.push(run),
    setTimer: (run, ms) => {
      timers.set(nextTimer, { run, ms });
      return nextTimer++;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  return {
    publisher,
    applied,
    deferred,
    timers,
    commit(value: number) {
      committed = value;
      publisher.settled();
    },
    fire() {
      const [id, timer] = [...timers.entries()][0]!;
      timers.delete(id);
      timer.run();
    },
  };
}

test("a publish that never commits is applied urgently at the deadline", () => {
  const h = harness();
  h.publisher.publish(1);
  expect(h.timers.size).toBe(1);
  expect([...h.timers.values()][0]!.ms).toBe(BACKGROUND_PUBLISH_DEADLINE_MS);
  h.deferred[0]!();
  expect(h.applied).toEqual([1]);
  h.fire();
  expect(h.applied).toEqual([1, 1]);
});

test("a publish that commits in time arms no urgent update", () => {
  const h = harness();
  h.publisher.publish(1);
  h.commit(1);
  expect(h.timers.size).toBe(0);
  expect(h.applied).toEqual([]);
});

test("a continuous stream of publishes shares one deadline and lands the newest", () => {
  const h = harness();
  h.publisher.publish(1);
  h.publisher.publish(2);
  h.publisher.publish(3);
  expect(h.timers.size).toBe(1);
  h.fire();
  expect(h.applied).toEqual([3]);
});

test("an older publish committing does not disarm the newer one's deadline", () => {
  const h = harness();
  h.publisher.publish(1);
  h.publisher.publish(2);
  h.commit(1);
  expect(h.timers.size).toBe(1);
  h.fire();
  expect(h.applied).toEqual([2]);
});

test("a deadline that finds the newest already committed does nothing", () => {
  const h = harness();
  h.publisher.publish(1);
  h.commit(1);
  h.publisher.publish(2);
  h.commit(2);
  expect(h.timers.size).toBe(0);
  expect(h.applied).toEqual([]);
});

test("disposing cancels the pending deadline", () => {
  const h = harness();
  h.publisher.publish(1);
  h.publisher.dispose();
  expect(h.timers.size).toBe(0);
});
