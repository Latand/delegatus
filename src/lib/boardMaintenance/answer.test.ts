import { afterEach, expect, test } from "bun:test";
import { boardMaintenanceAnswer } from "./answer";
import { claim, sandbox, input, PROJECT, NOW } from "./testFixture";
import { patchMaintenanceRun } from "./store";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
const ports = { now: NOW, seat: () => true, deploying: () => false, lastCheckAt: new Date(NOW).toISOString(), checkIntervalMs: 300000 };
test("off by default, enabled first run and estimated next check", () => {
  held = sandbox(); const off = boardMaintenanceAnswer(PROJECT, input(false).settings, ports); expect(off).toMatchObject({ enabled: false, intervalHours: 3, nextRunAt: null, waitingOn: "off" });
  const on = boardMaintenanceAnswer(PROJECT, input().settings, ports); expect(on.nextRunAt).toBe(new Date(NOW + 300000).toISOString());
});
test("live, ended, interval, deployment and missing seat states", () => {
  held = sandbox(); const run = claim(); expect(boardMaintenanceAnswer(PROJECT, input().settings, ports).waitingOn).toBe("live-run");
  patchMaintenanceRun(run.runId, { state: "succeeded", launchedAt: new Date(NOW + 14 * 60000).toISOString(), endedAt: new Date(NOW).toISOString() });
  const answer = boardMaintenanceAnswer(PROJECT, input().settings, { ...ports, verbose: true });
  expect(answer.waitingOn).toBe("interval"); expect(answer.lastRun?.runId).toBe(run.runId); expect(answer.lastRunLog).toBeDefined(); expect(answer.nextEligibleAt).toBe(new Date(NOW + 3 * 3600000 + 14 * 60000).toISOString());
  const later = { ...ports, now: NOW + 4 * 3600000 };
  expect(boardMaintenanceAnswer(PROJECT, input().settings, { ...later, deploying: () => true }).waitingOn).toBe("deployment");
  expect(boardMaintenanceAnswer(PROJECT, input().settings, { ...later, seat: () => false }).waitingOn).toBe("no-seat");
});
test("unreadable store answers beside editable setting", () => {
  const answer = boardMaintenanceAnswer(PROJECT, input().settings, { ...ports, runs: () => { throw new Error("fixture unreadable"); } });
  expect(answer.enabled).toBe(true); expect(answer.runsError).toBe("fixture unreadable");
});

test("a readable empty deployment ledger does not hold the timer", () => {
  held = sandbox();
  const realLedgerPorts = { ...ports, deploying: undefined };
  const answer = boardMaintenanceAnswer(PROJECT, input().settings, realLedgerPorts);
  expect(answer.waitingOn).toBeNull();
});
