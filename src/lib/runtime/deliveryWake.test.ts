import { expect, test } from "bun:test";
import { DeliveryWake } from "./deliveryWake";
function fixture() {
  let now = 0;
  let calls = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; work(): void }>();
  let sequence = 0;
  const wake = new DeliveryWake(() => { calls++; }, {
    now: () => now,
    set: (work, delay) => { const id = ++sequence as unknown as ReturnType<typeof setTimeout>; timers.set(id, { at: now + delay, work }); return id; },
    clear: id => { timers.delete(id); },
  });
  return { wake, timers, calls: () => calls, advance(ms: number) { now += ms; for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.work(); } } };
}
test("an admission replaces a later retry and subsequent retries cannot postpone it", () => {
  const f = fixture();
  expect(f.wake.schedule(1000)).toBe(true);
  expect(f.wake.schedule(25)).toBe(true);
  expect(f.wake.schedule(1000)).toBe(false);
  expect(f.timers.size).toBe(1);
  f.advance(25);
  expect(f.calls()).toBe(1);
  f.advance(2000);
  expect(f.calls()).toBe(1);
});
test("a delayed timer fires once, then accepts another wake; retirement cancels owned work", () => {
  const f = fixture();
  f.wake.schedule(25);
  f.advance(2000);
  expect(f.calls()).toBe(1);
  f.wake.schedule(0);
  f.advance(0);
  expect(f.calls()).toBe(2);
  f.wake.schedule(25);
  f.wake.cancel();
  f.advance(2000);
  expect(f.calls()).toBe(2);
});

test("the default clock schedules a real callback", async () => {
  await new Promise<void>(resolve => { new DeliveryWake(resolve).schedule(0); });
});
