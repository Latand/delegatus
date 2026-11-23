import { afterEach, afterAll, expect, test, spyOn } from "bun:test";
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

let traffic: () => boolean | Promise<boolean> = () => true;
const fixture = await import("./seatTickController.fixture");
const instrumentation = await import("@/lib/viewerInstrumentation");
const ownership = spyOn(instrumentation, "viewerReleaseOwnsTraffic").mockImplementation(() => traffic() as never);
afterAll(() => ownership.mockRestore());
const controller = await import("./seatTickController");
const signals = await import("./resumedSeatTick");
const sourcesModule = await import("./seatTickSources");
const releaseModule = await import("@/lib/release/production");
const curationModule = await import("@/lib/memory/curation/run");
const maintenanceModule = await import("@/lib/boardMaintenance/run");
const { PROJECT, DEFAULT_SEAT_TICK_POLICY } = fixture;
afterEach(() => { traffic = () => true; });
function start(extra = {}) {
 return controller.startSeatTick({ policy: DEFAULT_SEAT_TICK_POLICY, recordSuccessions: () => [],
  scheduleInterval: () => ({ unref() {} }) as never, sweep: async () => {}, log: () => {}, appendRecord: () => {}, ...extra });
}
test("startup binds signal; stop/restart replaces identity before queued old signal can run", async () => {
 let oldCalls = 0, reads = 0, sweeps = 0;
 signals.bindResumedSeatTick(async () => { oldCalls++; });
 const stale = signals.requestResumedSeatTick(CONVERSATION);
 controller.stopSeatTick();
 const spy = spyOn(sourcesModule, "defaultSeatTickSources").mockReturnValue({ activeSeats: () => { reads++; return []; } } as never);
 try {
  expect(start({ sweep: async () => { sweeps++; } })).toBeTrue();
  const fresh = signals.requestResumedSeatTick(CONVERSATION);
  expect(fresh).not.toBe(stale); await Promise.all([stale, fresh]);
  expect(oldCalls).toBe(0); expect(reads).toBe(1); expect(sweeps).toBe(1);
  controller.stopSeatTick(); await signals.requestResumedSeatTick(CONVERSATION); expect(reads).toBe(1);
 } finally { spy.mockRestore(); }
});
for (const fence of ["handoff", "drain"]) test("startup-bound signal obeys " + fence + " fence", async () => {
 let held = true, reads = 0;
 const spy = spyOn(sourcesModule, "defaultSeatTickSources").mockReturnValue({ activeSeats: () => { reads++; return []; } } as never);
 try {
  start({ handoffHeld: () => fence === "handoff" && held, drainHeld: () => fence === "drain" && held });
  await signals.requestResumedSeatTick(CONVERSATION); expect(reads).toBe(0);
  held = false; await signals.requestResumedSeatTick(CONVERSATION); expect(reads).toBe(1);
 } finally { spy.mockRestore(); }
});
test("selection enters only the current seat project and preserves lost-owner refusal", async () => {
 const value = harness({});
 const seatFor = value.deps.sources!.seatFor;
 value.deps.sources!.activeSeats = () => ["unrelated-project", PROJECT];
 value.deps.sources!.seatFor = project => project === PROJECT ? seatFor(project) : { ...seatFor(project), active: null, pending: null };
 Object.assign(value.deps, { ownsTraffic: () => false, recordSuccessions: () => [], curation: null, release: null, maintenance: null });
 await controller.reconcileResumedSeatTick(CONVERSATION, value.deps);
 expect(value.sent).toHaveLength(0); expect(value.journal.map(r => r.verdict)).toEqual(["refused"]);
 await controller.reconcileResumedSeatTick("previous-conversation", value.deps); expect(value.journal).toHaveLength(1);
});
test("a signal already awaiting ownership cannot create a check after stop", async () => {
 const value = harness({});
 const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<boolean>();
 traffic = () => { entered.resolve(); return release.promise; };
 let preparations = 0;
 value.deps.sources!.prepareRead = async () => { preparations++; throw new Error("isolated probe reached work after stop"); };
 const spies = [spyOn(sourcesModule, "defaultSeatTickSources").mockReturnValue(value.deps.sources!),
  spyOn(releaseModule, "releaseControllerForSources").mockReturnValue(null as never),
  spyOn(curationModule, "productionCurationController").mockReturnValue(null as never),
  spyOn(maintenanceModule, "productionBoardMaintenanceController").mockReturnValue(null as never)];
 let pending: Promise<void> | undefined;
 try {
  start(); pending = signals.requestResumedSeatTick(CONVERSATION);
  await entered.promise; controller.stopSeatTick(); release.resolve(true); await pending;
  expect(preparations).toBe(0);
 } finally { release.resolve(true); await pending?.catch(() => {}); for (const spy of spies) spy.mockRestore(); }
});

test("a stale ownership refusal cannot withdraw a restarted controller signal", async () => {
 const value = harness({});
 const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<boolean>();
 let ownershipReads = 0, projectReads = 0;
 traffic = () => { if (++ownershipReads === 1) { entered.resolve(); return release.promise; } return true; };
 const oldActiveSeats = value.deps.sources!.activeSeats;
 value.deps.sources!.activeSeats = () => { projectReads++; return oldActiveSeats(); };
 value.deps.sources!.prepareRead = async () => { throw new Error("isolated check ended"); };
 const spies = [spyOn(sourcesModule, "defaultSeatTickSources").mockReturnValue(value.deps.sources!),
  spyOn(releaseModule, "releaseControllerForSources").mockReturnValue(null as never),
  spyOn(curationModule, "productionCurationController").mockReturnValue(null as never),
  spyOn(maintenanceModule, "productionBoardMaintenanceController").mockReturnValue(null as never)];
 let pending: Promise<void> | undefined;
 try {
  start(); pending = signals.requestResumedSeatTick(CONVERSATION); await entered.promise;
  controller.stopSeatTick(); expect(start()).toBeTrue();
  release.resolve(false); await pending;
  const before = projectReads;
  await signals.requestResumedSeatTick(CONVERSATION);
  expect(projectReads).toBeGreaterThan(before);
 } finally { release.resolve(false); await pending?.catch(() => {}); for (const spy of spies) spy.mockRestore(); }
});
