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


test("an urgent publish supersedes a background deadline and deferred callback", () => {
  const h = harness();
  h.publisher.publish(1);
  const deadline = [...h.timers.values()][0]!.run;
  h.publisher.publish(2, "urgent");
  h.commit(2);
  // A cancelled callback may already have been queued; neither it nor the
  // interrupted background callback may put the old catalog back.
  deadline();
  h.deferred[0]!();
  expect(h.timers.size).toBe(0);
  expect(h.applied).toEqual([2]);
});

test("a new background publish after an urgent one gets its own deadline", () => {
  const h = harness();
  h.publisher.publish(1);
  h.publisher.publish(2, "urgent");
  h.commit(2);
  h.publisher.publish(3);
  expect(h.timers.size).toBe(1);
  h.fire();
  h.deferred[0]!();
  expect(h.applied).toEqual([2, 3]);
});


for (let mask = 0; mask < 8; mask += 1) {
  test(`publication order survives delayed callbacks for priority pattern ${mask}`, () => {
    const h = harness();
    for (let index = 0; index < 3; index += 1) {
      h.publisher.publish(index + 1, mask & (1 << index) ? "urgent" : "background");
    }
    // Deferred callbacks can be delayed or restarted after urgent writes.
    for (const run of [...h.deferred].reverse()) run();
    if (h.timers.size) h.fire();
    expect(h.applied.at(-1)).toBe(3);
    h.commit(3);
    expect(h.timers.size).toBe(0);
  });
}

test("a deferred publication cannot run after disposal", () => {
  const h = harness();
  h.publisher.publish(1);
  h.publisher.dispose();
  h.deferred[0]!();
  expect(h.applied).toEqual([]);
});
