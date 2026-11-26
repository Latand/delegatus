import { expect, test } from "bun:test";
import { launcherStartupDeadline, ROLLBACK_TIMEOUT_MS, rollbackSelectionMatches, STOP_TIMEOUT_MS, SWITCH_TIMEOUT_MS, TERMINAL_BOOTSTRAP_TIMEOUT_MS, startupHandoffSucceeded, terminalHealthPublishedBefore } from "./launcher-deadline.mjs";
import { waitForRuntimeHostStartup } from "./server-runtime.mjs";

const healthyRecord = {
  launcher: { pid: 41, startIdentity: "41:fixed", state: "healthy" },
  web: { pid: 51, state: "healthy" },
  runtimeHost: { pid: 61, state: "healthy" },
};

test("startup expiry yields supervision only to its live, recorded healthy child", () => {
  expect(startupHandoffSucceeded(41, true, false, healthyRecord)).toBe(true);
  expect(startupHandoffSucceeded(42, true, false, healthyRecord)).toBe(false);
  expect(startupHandoffSucceeded(41, false, false, healthyRecord)).toBe(false);
  expect(startupHandoffSucceeded(41, true, true, healthyRecord)).toBe(false);
  expect(startupHandoffSucceeded(41, true, false, { ...healthyRecord, web: { state: "starting" } })).toBe(false);
  expect(startupHandoffSucceeded(41, true, false, { ...healthyRecord, runtimeHost: { state: "starting" } })).toBe(false);
  expect(startupHandoffSucceeded(41, true, false, { ...healthyRecord, launcher: { pid: 41, startIdentity: "", state: "healthy" } })).toBe(false);
});

test("the terminal bootstrap covers the switch, rollback, both combined shutdowns and a margin", () => {
  expect(TERMINAL_BOOTSTRAP_TIMEOUT_MS).toBeGreaterThan(SWITCH_TIMEOUT_MS + ROLLBACK_TIMEOUT_MS + 4 * STOP_TIMEOUT_MS);
  expect(TERMINAL_BOOTSTRAP_TIMEOUT_MS).toBe(SWITCH_TIMEOUT_MS + ROLLBACK_TIMEOUT_MS + 4 * STOP_TIMEOUT_MS + 30_000);
});

test("terminal readiness is judged by the durable publication timestamp", () => {
  const expiry = Date.parse("2026-11-26T12:00:00.000Z");
  expect(terminalHealthPublishedBefore({ updatedAt: "2026-11-26T11:59:59.999Z" }, expiry)).toBe(true);
  expect(terminalHealthPublishedBefore({ updatedAt: "2026-11-26T12:00:00.450Z" }, expiry)).toBe(false);
  expect(terminalHealthPublishedBefore({}, expiry)).toBe(false);
});

test("checkout fallback requires the selected pointer to match the prior release", () => {
  const prior = JSON.stringify({ sha: "a".repeat(40), dir: "/prior" }) + "\n";
  const candidate = JSON.stringify({ sha: "b".repeat(40), dir: "/candidate" }) + "\n";
  expect(rollbackSelectionMatches(null, null)).toBe(true);
  expect(rollbackSelectionMatches(candidate, null)).toBe(false);
  expect(rollbackSelectionMatches(prior, prior)).toBe(true);
  expect(rollbackSelectionMatches(candidate, prior)).toBe(false);
});

test("runtime-host readiness accepts a socket probe already in flight at the silence boundary", async () => {
  let now = 0;
  await waitForRuntimeHostStartup({
    now: () => now, silenceMs: 30_000, ceilingMs: 300_000,
    timeout: () => "timed out",
    check: async () => { now = 29_900; now = 30_001; return true; },
    progress: async () => [], sleep: async milliseconds => { now += milliseconds; },
  });
  expect(now).toBe(30_001);
});

test("runtime-host readiness applies its in-flight file snapshot before the pending socket result", async () => {
  let now = 0;
  let checks = 0;
  await waitForRuntimeHostStartup({
    now: () => now, silenceMs: 30_000, ceilingMs: 300_000,
    timeout: () => "timed out",
    check: async () => {
      checks++;
      if (checks === 1) { now = 29_500; return false; }
      now = 30_600;
      return true;
    },
    progress: async () => { now = 30_500; return [["phase", 2, "fence-acquired"]]; },
    sleep: async milliseconds => { now += milliseconds; },
  });
  expect(checks).toBe(2);
  expect(now).toBe(30_600);
});

test("runtime-host readiness adapts synchronous evidence and sleep callbacks", async () => {
  let checks = 0;
  await waitForRuntimeHostStartup({
    now: () => checks * 100,
    check: () => ++checks > 1,
    progress: () => [["phase", 1, "fence-acquired"]],
    timeout: () => "timed out",
    sleep: async () => {},
  });
  expect(checks).toBe(2);
});

test("checkout startup follows the durable rollback expiry after the switch window", () => {
  const switchDeadline = 10_000, rollbackDeadlineAt = 610_000, bootstrapDeadline = 640_000;
  const trial = { requestId: "fixed-request", target: "fixed-target", state: "rolled-back", rollbackDeadlineAt };
  expect(launcherStartupDeadline({ active: true, switchDeadline, trial, requestId: trial.requestId, target: trial.target,
    bootstrapDeadline, teardownGraceMs: 2 * STOP_TIMEOUT_MS, now: 10_100 })).toEqual({
    phase: "rollback", deadline: rollbackDeadlineAt, expired: false,
  });
  expect(launcherStartupDeadline({ active: true, switchDeadline, trial: { ...trial, refused: true, detail: "guard refused" },
    requestId: trial.requestId, target: trial.target, bootstrapDeadline, teardownGraceMs: 2 * STOP_TIMEOUT_MS,
    now: 10_100 })).toEqual({ phase: "refused", deadline: 10_100, expired: true });
  expect(launcherStartupDeadline({ active: true, switchDeadline, trial: { ...trial, state: "starting" },
    requestId: trial.requestId, target: trial.target, bootstrapDeadline, teardownGraceMs: 2 * STOP_TIMEOUT_MS,
    now: switchDeadline + 2 * STOP_TIMEOUT_MS })).toMatchObject({ phase: "switch", expired: true });
});
