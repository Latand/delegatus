import path from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";

import { currentHealthRun, resetHealthCheckForTests, settleHealthCheckForTests, startHealthCheck, type HealthCheckPorts, type HealthCleanupInput } from "./healthCheck";
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
  recordLeftovers: () => {},
  runFiles: () => [],
  dropRunFile: () => {},
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

/* A Viewer that restarts mid-check forgets the run; the run file it wrote as
   each thing appeared is what the next read cleans up from. */
test("a check a restart lost is cleaned up on the next read, from what its run file names", async () => {
  const SEAT = ["conversation", "5eed00000000a1b2"].join("_");
  const files = new Map<string, Omit<HealthCleanupInput, "stateDir">>();
  const cleaned: HealthCleanupInput[] = [];
  const hanging: HealthCheckPorts = {
    ...refusingPorts,
    newId: () => "run00003",
    spawnSeat: async () => ({ conversationId: SEAT }),
    seatMaterialized: (id) => ({ conversationId: id, path: "/seat.jsonl", cwd: "/scratch", project: "dir-scratch" }),
    createPipeline: async () => ({ pipeline: { id: "health03" } as Pipeline }),
    /* The stage never starts, and every wait outlives the process. */
    sleep: () => new Promise(() => {}),
    recordLeftovers: (stateDir, leftovers) => { files.set(stateDir, { ...leftovers }); },
    runFiles: () => [...files.entries()].map(([stateDir, leftovers]) => ({ ...leftovers, stateDir })),
    dropRunFile: (stateDir) => { files.delete(stateDir); },
    cleanup: async (input) => { cleaned.push(input); return []; },
  };
  startHealthCheck(hanging);
  const stateDir = path.join("health-runs", "run00003");
  /* Until the pipeline exists and is on the record. */
  for (let turn = 0; turn < 50 && !files.get(stateDir)?.pipelineId; turn++) await Promise.resolve();
  expect(files.get(stateDir)).toEqual({ repoDir: "/scratch", seatConversationId: SEAT, project: "dir-scratch", pipelineId: "health03" });

  resetHealthCheckForTests();
  setHealthRouteDependenciesForTests({ ports: async () => hanging, readiness: () => "connected" });
  expect((await onboardingHealthGet(null)).body).toMatchObject({ run: null });
  expect(cleaned).toEqual([{ stateDir, repoDir: "/scratch", seatConversationId: SEAT, project: "dir-scratch", pipelineId: "health03" }]);
  expect(files.size).toBe(0);
  /* Swept once: the next read finds nothing left. */
  await onboardingHealthGet(null);
  expect(cleaned.length).toBe(1);
  expect(currentHealthRun()).toBeNull();
});

test("a start sweeps a lost check before it begins its own", async () => {
  const cleaned: string[] = [];
  const files = new Set([path.join("health-runs", "lost0001")]);
  setHealthRouteDependenciesForTests({
    ports: async () => ({
      ...refusingPorts,
      runFiles: () => [...files].map((stateDir) => ({ stateDir, repoDir: "/scratch", seatConversationId: null, project: null, pipelineId: null })),
      dropRunFile: (stateDir) => { files.delete(stateDir); },
      cleanup: async (input) => { cleaned.push(input.stateDir); return []; },
    }),
    readiness: () => "connected",
  });
  expect((await onboardingHealthStart()).status).toBe(202);
  await settleHealthCheckForTests();
  expect(cleaned[0]).toBe(path.join("health-runs", "lost0001"));
  expect(files.has(path.join("health-runs", "lost0001"))).toBe(false);
});
