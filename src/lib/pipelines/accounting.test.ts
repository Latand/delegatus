import { expect, test } from "bun:test";
import { attemptAccountingSchema, declaredClassSchema, REPEAT_REASONS, splitAttemptTime } from "./accounting";

const at = (ms: number) => new Date(ms).toISOString();
test("observed nested and concurrent intervals reconcile exclusively with unknown time", () => {
  const result = splitAttemptTime(at(0), at(100), [
    { kind: "model", start: 10, end: 90 }, { kind: "tools", start: 30, end: 70 },
    { kind: "tools", start: 40, end: 80 }, { kind: "checkQueue", start: 40, end: 50 },
    { kind: "checkRunner", start: 50, end: 60 }, { kind: "checkRunner", start: 50, end: 60 },
  ]);
  expect(result).toEqual({ intervalMs: 100, modelMs: 30, toolsMs: 30, checkQueueMs: 10, checkRunnerMs: 10, unknownMs: 20, toleranceMs: 0 });
  expect(result.modelMs! + result.toolsMs! + result.checkQueueMs! + result.checkRunnerMs! + result.unknownMs!).toBe(result.intervalMs!);
});
test("missing and inverted clocks stay unknown and never become estimated zero time", () => {
  expect(splitAttemptTime(null, at(100)).intervalMs).toBeNull();
  expect(splitAttemptTime(at(100), at(0)).unknownMs).toBeNull();
  expect(splitAttemptTime(at(0), at(100))).toMatchObject({ unknownMs: 100, modelMs: null, toolsMs: null, checkQueueMs: null, checkRunnerMs: null });
  expect(splitAttemptTime(at(0), at(100), [{ kind: "tools", start: -10, end: 110 }])).toMatchObject({ toolsMs: 100, unknownMs: 0 });
});
test("every closed repeat reason round-trips and arbitrary reasons are refused", () => {
  for (const repeatReason of REPEAT_REASONS) {
    const record = { admittedAt: at(0), startedAt: at(1), repeatReason, time: splitAttemptTime(at(1), at(100)) };
    expect(attemptAccountingSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  }
  expect(attemptAccountingSchema.safeParse({ admittedAt: at(0), startedAt: null, repeatReason: "seems-slow", time: null }).success).toBe(false);
  expect(declaredClassSchema.parse({})).toEqual({ size: null, money: null, access: null, dataMigration: null });
  expect(declaredClassSchema.safeParse({ money: "false" }).success).toBe(false);
});


test("a nested slot wait is excluded from its enclosing check runner interval", () => {
  expect(splitAttemptTime(at(0), at(100), [
    { kind: "checkRunner", start: 10, end: 90 }, { kind: "checkQueue", start: 40, end: 60 },
  ])).toMatchObject({ checkRunnerMs: 60, checkQueueMs: 20, unknownMs: 20 });
});


test("a stored time split that double-counts an interval is refused", () => {
  expect(attemptAccountingSchema.safeParse({ admittedAt: at(0), startedAt: at(0), repeatReason: null,
    time: { intervalMs: 100, modelMs: 100, toolsMs: 100, checkQueueMs: null, checkRunnerMs: null, unknownMs: 0, toleranceMs: 0 } }).success).toBe(false);
});
