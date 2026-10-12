import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ready } from "./policy.fixture";
import { productionReleaseController, type ReleasePorts } from "./run";
import { readReleaseProject, mutateReleaseProject } from "./store";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import type { SeatTickCheckInput } from "@/lib/monitor/types";

let directory: string; const originalState = process.env.LLV_STATE_DIR;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-run-test-")); process.env.LLV_STATE_DIR = directory; });
afterEach(() => { process.env.LLV_STATE_DIR = originalState; fs.rmSync(directory, { recursive: true, force: true }); });

test("two ticks and a restart replay one durable task and pipeline payload", async () => {
  const project = "restart-release";
  const input = { project, seat: { conversationId: "seat", seatEpoch: 1 }, settings: effectiveSeatTickSettings(defaultSeatTickSettings(project), 0, 60_000) } as SeatTickCheckInput;
  let admissions = 0; let failReceipt = true;
  const keys = new Set<string>();
  const ports: ReleasePorts = { now: () => ready().now, settings: () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12, updatedAt: "2026-10-12T00:00:00Z", setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null }),
    observe: async () => ({ policy: ready(), repoDir: "/synthetic/repo", src: "seat-path" }),
    task: () => "release-task", pipeline: () => null,
    create: async (request, key) => { keys.add(key); admissions++; expect(request.baseRef).toBe("one"); if (failReceipt) { failReceipt = false; throw new Error("lost receipt"); } return "release-lane"; } };
  const controller = productionReleaseController(ports);
  await expect(controller.launchIfDue(input)).rejects.toThrow("lost receipt");
  expect(readReleaseProject(project).live?.request).toBeDefined();
  await productionReleaseController(ports).reconcile(project);
  await Promise.all([controller.launchIfDue(input), productionReleaseController(ports).launchIfDue(input)]);
  expect(keys.size).toBe(1); expect(admissions).toBe(2);
  expect(readReleaseProject(project).live?.pipelineId).toBe("release-lane");
});

test("settlement occurs once, waiting for merge and retaining failed parked lanes", async () => {
  const project = "settled-release";
  mutateReleaseProject(project, row => ({ ...row, live: { key: "release-key", cut: "one", lastTag: "v1.0.0", trigger: "amount", startedAt: 0, taskId: "task", pipelineId: "lane", request: {} as never } }));
  let state = "parked"; let merged = false;
  const ports: ReleasePorts = { settings: () => null, observe: async () => { throw new Error("unexpected observation"); }, task: () => { throw new Error("unexpected task"); }, create: async () => { throw new Error("unexpected creation"); }, now: () => 1, pipeline: () => ({ state, merged, declined: false }) };
  const c = productionReleaseController(ports);
  await c.reconcile(project); expect(readReleaseProject(project).live).not.toBeNull();
  state = "completed"; await c.reconcile(project); expect(readReleaseProject(project).live).not.toBeNull();
  merged = true; await c.reconcile(project); await c.reconcile(project);
  expect(readReleaseProject(project).history.length).toBe(1);
  expect(readReleaseProject(project).history[0].outcome).toBe("published");
});

test("a hold set while admission observes safety prevents task and pipeline creation", async () => {
  const project = "late-hold";
  let releaseObservation!: () => void; let admitted!: () => void;
  const held = new Promise<void>(resolve => { releaseObservation = resolve; });
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  let reads = 0; let creates = 0;
  const ports: ReleasePorts = { now: () => ready().now,
    settings: () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12, updatedAt: "2026-10-12T00:00:00Z", setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null }),
    observe: async () => { if (++reads === 2) { admitted(); await held; } return { policy: ready(), repoDir: "/synthetic/repo", src: "seat-path" }; },
    task: () => { creates++; return "task"; }, create: async () => { creates++; return "lane"; }, pipeline: () => null };
  const launch = productionReleaseController(ports).launchIfDue({ project, seat: { conversationId: "seat", seatEpoch: 1 }, settings: effectiveSeatTickSettings(defaultSeatTickSettings(project), 0, 60_000) } as SeatTickCheckInput);
  await entered;
  mutateReleaseProject(project, row => ({ ...row, hold: { reason: "incident", at: "2026-10-12T00:00:00Z", by: { kind: "gateway", project, conversationId: null, seatEpoch: null } } }));
  releaseObservation(); await launch;
  expect(creates).toBe(0);
});

test("a request arriving after the launch claim survives its creation receipt", async () => {
  const project = "queued-request";
  let entered!: () => void; let finish!: () => void;
  const creating = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const ports: ReleasePorts = { now: () => ready().now,
    settings: () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12, updatedAt: "2026-10-12T00:00:00Z", setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null }),
    observe: async () => ({ policy: ready(), repoDir: "/synthetic/repo", src: "seat-path" }), task: () => "task", pipeline: () => null,
    create: async () => { entered(); await held; return "lane"; } };
  const launch = productionReleaseController(ports).launchIfDue({ project, seat: { conversationId: "seat", seatEpoch: 1 }, settings: effectiveSeatTickSettings(defaultSeatTickSettings(project), 0, 60_000) } as SeatTickCheckInput);
  await creating;
  mutateReleaseProject(project, row => ({ ...row, request: { at: "2026-10-12T01:00:00Z", why: "new urgent fix", by: { kind: "gateway", project, conversationId: null, seatEpoch: null } } }));
  finish(); await launch;
  expect(readReleaseProject(project).request?.why).toBe("new urgent fix");
});
