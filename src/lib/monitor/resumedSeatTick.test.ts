import { afterEach, expect, test } from "bun:test";
import { harness, CONVERSATION, OPEN_LANE, OVERDUE, stopSeatTick } from "./seatTickController.fixture";
import { reconcileSeatTick, reconcileResumedSeatTick, seatTickIdle } from "./seatTickController";
import { bindResumedSeatTick, requestResumedSeatTick } from "./resumedSeatTick";

function rig() {
  const value = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  Object.assign(value.deps, { ownsTraffic: () => true, recordSuccessions: () => [], curation: null, release: null, maintenance: null });
  bindResumedSeatTick(id => reconcileResumedSeatTick(id, value.deps));
  return value;
}
afterEach(stopSeatTick);

test("a resumed current seat rechecks its project immediately", async () => {
  const value = rig();
  await requestResumedSeatTick(CONVERSATION);
  expect(value.sent).toHaveLength(1);
});

test("a resumed worker or former seat cannot wake another seat", async () => {
  const value = rig();
  await requestResumedSeatTick("previous");
  expect(value.sent).toHaveLength(0);
});

test("resume obeys the same lost-traffic fence as the normal sweep", async () => {
  const value = rig();
  value.deps.ownsTraffic = () => false;
  expect(await reconcileSeatTick(value.deps)).toEqual([]);
  bindResumedSeatTick(id => reconcileResumedSeatTick(id, value.deps));
  await requestResumedSeatTick(CONVERSATION);
  expect(value.sent).toHaveLength(0);
  expect(value.journal.map(record => record.verdict)).toEqual(["refused", "refused"]);
});

test("resume during a normal project check coalesces one fresh follow-up", async () => {
  const value = rig();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let checks = 0;
  value.deps.workStarted = () => { checks++; };
  value.deps.sources!.prepareRead = async () => { entered.resolve(); await release.promise; };
  const normal = reconcileSeatTick(value.deps);
  await entered.promise;
  const immediate = requestResumedSeatTick(CONVERSATION);
  const repeated = requestResumedSeatTick(CONVERSATION);
  expect(repeated).toBe(immediate);
  try {
    await Bun.sleep(20);
    expect(checks).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled([normal, immediate]);
  }
  for (let attempt = 0; attempt < 100 && !seatTickIdle(); attempt++) await Bun.sleep(5);
  expect(seatTickIdle()).toBeTrue();
  expect(checks).toBe(2);
  expect(value.sent).toHaveLength(1);
});

test("stopping the controller withdraws the resume signal", async () => {
  const value = rig();
  stopSeatTick();
  await requestResumedSeatTick(CONVERSATION);
  expect(value.sent).toHaveLength(0);
});
