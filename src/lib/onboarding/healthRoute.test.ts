import { afterEach, beforeEach, expect, test } from "bun:test";

import { resetHealthCheckForTests, settleHealthCheckForTests, type HealthCheckPorts } from "./healthCheck";
import { onboardingHealthGet, onboardingHealthStart, onboardingHealthStop, setHealthRouteDependenciesForTests } from "./healthRoute";

/* A run whose first launch is refused: it settles at once, with no agent. */
const refusingPorts: HealthCheckPorts = {
  now: () => Date.parse("2026-09-20T10:00:00.000Z"),
  sleep: async () => {},
  newId: () => "run00002",
  readiness: () => "connected",
  prepareRepo: () => ({ repoDir: "/scratch", baseRef: "abc" }),
  spawnSeat: async () => ({ error: "refused", code: null, reason: "signed-out" }),
  seatMaterialized: () => null,
  seatBusy: () => false,
  seatTurnMark: () => "",
  createPipeline: async () => ({ error: "unused" }),
  pipeline: () => null,
  receipt: () => null,
  transcriptExists: () => false,
  viewerMcpRegistered: () => null,
  runTick: async () => ({ record: null, outcome: null }),
  seatFilings: () => [],
  cleanup: async () => [],
  recordResult: () => {},
  redact: (text) => text,
};

beforeEach(() => resetHealthCheckForTests());
afterEach(() => setHealthRouteDependenciesForTests(null));

test("with no engine connected the read names no runtime and a start is refused", async () => {
  setHealthRouteDependenciesForTests({ ports: async () => ({ ...refusingPorts, readiness: () => "signed-out" }), readiness: () => "signed-out" });
  expect(await onboardingHealthGet(null)).toEqual({ status: 200, body: { runtime: null, run: null } });
  const started = await onboardingHealthStart();
  expect(started.status).toBe(409);
  expect(started.body).toMatchObject({ code: "NO_ENGINE" });
});

test("a start answers the run, a poll reads it by id, and an unknown id is not found", async () => {
  setHealthRouteDependenciesForTests({ ports: async () => ({ ...refusingPorts, readiness: () => "connected" }), readiness: () => "connected" });
  expect((await onboardingHealthGet(null)).body).toMatchObject({ runtime: { engine: "claude", model: "haiku", effort: "low" }, run: null });
  const started = await onboardingHealthStart();
  expect(started.status).toBe(202);
  await settleHealthCheckForTests();
  const polled = await onboardingHealthGet("run00002");
  const run = (polled.body as { run: { id: string; state: string; rows: { id: string; state: string; failure: { code: string } | null }[] } }).run;
  expect({ id: run.id, state: run.state }).toEqual({ id: "run00002", state: "failed" });
  expect(run.rows[0]).toMatchObject({ id: "spawn", state: "failed", failure: { code: "ENGINE_NOT_CONNECTED" } });
  expect((await onboardingHealthGet("other")).status).toBe(404);
  expect(onboardingHealthStop(null).status).toBe(400);
  expect(onboardingHealthStop("other").status).toBe(404);
});
