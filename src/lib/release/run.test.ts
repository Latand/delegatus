import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  const ports: ReleasePorts = { taskDone: () => false, supersedingTag: async () => null, now: () => ready().now, settings: () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12, updatedAt: "2026-10-12T00:00:00Z", setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null }),
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

test("recovery holds a frozen cut that a later rollback removed from the six-hour chain", async () => {
  const project = "stale-release-cut";
  mutateReleaseProject(project, row => ({ ...row, live: {
    key: "saved-release", cut: "revision-a", lastTag: "v1.0.0", trigger: "requested", startedAt: 14,
    taskId: "task", pipelineId: null, request: { baseRef: "revision-a" } as never,
  } }));
  let creates = 0;
  const policy = { ...ready(), now: 24 * 3_600_000,
    deployments: [{ revision: "revision-c", at: 23 * 3_600_000 }, { revision: "revision-b", at: 16 * 3_600_000 }],
    isAncestor: (a: string, b: string) => a === b || a === "revision-b" && b === "revision-c" };
  const ports: ReleasePorts = { taskDone: () => false, supersedingTag: async () => null, settings: () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12,
    updatedAt: "2026-10-12T00:00:00Z", setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null }),
    now: () => policy.now, observe: async (_project, frozenCut) => { expect(frozenCut).toBe("revision-a"); return { policy, repoDir: "repo", src: "seat" }; },
    task: () => { creates++; return "task"; }, create: async () => { creates++; return "lane"; }, pipeline: () => null };
  await productionReleaseController(ports).reconcile(project);
  expect(creates).toBe(0);
  expect(readReleaseProject(project).live?.pipelineId).toBeNull();
});

test("settlement occurs once, waiting for merge and retaining failed parked lanes", async () => {
  const project = "settled-release";
  mutateReleaseProject(project, row => ({ ...row, live: { key: "release-key", cut: "one", lastTag: "v1.0.0", trigger: "amount", startedAt: 0, taskId: "task", pipelineId: "lane", request: {} as never } }));
  let state = "parked"; let merged = false;
  const ports: ReleasePorts = { taskDone: () => false, supersedingTag: async () => null, settings: () => null, observe: async () => { throw new Error("unexpected observation"); }, task: () => { throw new Error("unexpected task"); }, create: async () => { throw new Error("unexpected creation"); }, now: () => 1, pipeline: () => ({ state, merged, declined: false }) };
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
  const ports: ReleasePorts = { taskDone: () => false, supersedingTag: async () => null, now: () => ready().now,
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
  const ports: ReleasePorts = { taskDone: () => false, supersedingTag: async () => null, now: () => ready().now,
    settings: () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12, updatedAt: "2026-10-12T00:00:00Z", setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null }),
    observe: async () => ({ policy: ready(), repoDir: "/synthetic/repo", src: "seat-path" }), task: () => "task", pipeline: () => null,
    create: async () => { entered(); await held; return "lane"; } };
  const launch = productionReleaseController(ports).launchIfDue({ project, seat: { conversationId: "seat", seatEpoch: 1 }, settings: effectiveSeatTickSettings(defaultSeatTickSettings(project), 0, 60_000) } as SeatTickCheckInput);
  await creating;
  mutateReleaseProject(project, row => ({ ...row, request: { at: "2026-10-12T01:00:00Z", why: "new urgent fix", by: { kind: "gateway", project, conversationId: null, seatEpoch: null } } }));
  finish(); await launch;
  expect(readReleaseProject(project).request?.why).toBe("new urgent fix");
});

function staleRunFixture() {
  const project = "automatic-release";
  const now = Date.parse("2026-10-22T23:30:00Z");
  const requestedAt = "2026-10-17T04:52:28.124Z";
  const actor = { kind: "gateway" as const, project: null, conversationId: null, seatEpoch: null };
  mutateReleaseProject(project, row => ({ ...row,
    request: { at: requestedAt, by: actor, why: "release requested" },
    live: { key: "old-release", cut: "old-cut", lastTag: "v1.13.0", trigger: "requested",
      startedAt: Date.parse("2026-10-17T05:14:25Z"), requestedAt, taskId: "finished-task", pipelineId: null,
      request: { baseRef: "old-cut" } as never },
    observation: { state: "due", blocker: null, reason: "requested", count: 56,
      cut: { revision: "old-cut", at: now - 7 * 24 * 3_600_000 }, at: now - 5 * 24 * 3_600_000,
      lastTag: "v1.13.0", nextEligibleAt: 0 },
  }));
  const policy = { ...ready(), now, mainVersion: "1.15.0",
    lastTag: { name: "v1.15.0", version: "1.15.0", at: Date.parse("2026-10-20T17:31:17Z") },
    deployments: [{ revision: "next-cut", at: now - 7 * 3_600_000 }] };
  let creates = 0;
  const ports: ReleasePorts = {
    now: () => now, settings: () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12,
      updatedAt: "2026-10-20T00:00:00Z", setBy: actor, why: null }),
    taskDone: (_project, id) => { expect(_project).toBe(project); return id === "finished-task"; },
    supersedingTag: async () => null,
    observe: async () => ({ policy, repoDir: "repo", src: "seat" }),
    task: (_project, run, adopted) => { expect(run.cut).toBe("next-cut"); expect(adopted).toBeUndefined(); return "next-task"; },
    create: async request => { creates++; expect(request.baseRef).toBe("next-cut");
      expect(request.stages?.find(stage => stage.id === "publish")?.prompt).toContain("ask before every tag"); return "next-lane"; },
    pipeline: () => null,
  };
  const input = { project, seat: { conversationId: "seat", seatEpoch: 1 },
    settings: effectiveSeatTickSettings(defaultSeatTickSettings(project), now, 60_000) } as SeatTickCheckInput;
  return { project, now, ports, input, policy, creates: () => creates };
}

test("the copied stale shape settles a done task, consumes its request and releases the next amount run", async () => {
  const h = staleRunFixture();
  await productionReleaseController(h.ports).reconcile(h.project);
  const settled = readReleaseProject(h.project);
  expect(settled.live).toBeNull();
  expect(settled.request).toBeNull();
  expect(settled.history).toHaveLength(1);
  expect(settled.history[0]).toMatchObject({ outcome: "completed", reason: "task-done", at: h.now });
  await productionReleaseController(h.ports).launchIfDue(h.input);
  expect(h.creates()).toBe(1);
  expect(readReleaseProject(h.project).live).toMatchObject({ cut: "next-cut", trigger: "amount", lastTag: "v1.15.0", pipelineId: "next-lane" });
  expect(readReleaseProject(h.project).observation).toMatchObject({ state: "due", reason: "amount", lastTag: "v1.15.0", count: 30 });
});

test.each([null, "old-lane"])("a published tag supersedes the older cut with pipeline %s", async pipelineId => {
  const h = staleRunFixture();
  h.ports.taskDone = () => false;
  h.ports.supersedingTag = async (project, run) => { expect(project).toBe(h.project); expect(run.cut).toBe("old-cut"); return "v1.15.0"; };
  mutateReleaseProject(h.project, row => ({ ...row, live: { ...row.live!, pipelineId } }));
  await productionReleaseController(h.ports).reconcile(h.project);
  expect(readReleaseProject(h.project).history[0]).toMatchObject({ outcome: "superseded", reason: "published-tag: v1.15.0" });
  expect(readReleaseProject(h.project).live).toBeNull();
  // Reopening the controller reads the durable settlement and can launch again.
  h.ports.supersedingTag = async () => null;
  await productionReleaseController(h.ports).launchIfDue(h.input);
  expect(h.creates()).toBe(1);
  expect(readReleaseProject(h.project).history).toHaveLength(1);
});


test.each(["hold", "soak", "gap", "changes", "disabled", "other-release"])("settling stale state keeps the %s gate", async gate => {
  const h = staleRunFixture();
  if (gate === "hold") mutateReleaseProject(h.project, row => ({ ...row, hold: { at: "2026-10-22T23:30:00Z", by: { kind: "gateway", project: null, conversationId: null, seatEpoch: null }, reason: "incident" } }));
  if (gate === "soak") h.policy.deployments[0].at = h.now - 3_600_000;
  if (gate === "gap") h.policy.lastTag.at = h.now - 3_600_000;
  if (gate === "changes") h.policy.changes.pop();
  if (gate === "disabled") h.ports.settings = () => null;
  if (gate === "other-release") h.policy.live = true;
  await productionReleaseController(h.ports).launchIfDue(h.input);
  expect(readReleaseProject(h.project).live).toBeNull();
  expect(readReleaseProject(h.project).history).toHaveLength(1);
  expect(h.creates()).toBe(0);
});

test("settlement preserves a newer explicit request", async () => {
  const h = staleRunFixture();
  mutateReleaseProject(h.project, row => ({ ...row, request: { ...row.request!, at: "2026-10-22T23:30:00Z" } }));
  await productionReleaseController(h.ports).reconcile(h.project);
  expect(readReleaseProject(h.project).request?.at).toBe("2026-10-22T23:30:00Z");
});

test("unreadable tag evidence retains the live record for retry", async () => {
  const h = staleRunFixture(); h.ports.taskDone = () => false;
  h.ports.supersedingTag = async () => { throw new Error("tags unavailable"); };
  await expect(productionReleaseController(h.ports).reconcile(h.project)).rejects.toThrow("tags unavailable");
  expect(readReleaseProject(h.project).live?.key).toBe("old-release");
  expect(readReleaseProject(h.project).history).toEqual([]);
  expect(h.creates()).toBe(0);
});

test("a replaced live claim is preserved across the asynchronous tag read", async () => {
  const h = staleRunFixture(); h.ports.taskDone = () => false;
  h.ports.supersedingTag = async () => {
    mutateReleaseProject(h.project, row => ({ ...row, live: { ...row.live!, key: "replacement", cut: "replacement-cut", pipelineId: "replacement-lane" } }));
    return "v1.15.0";
  };
  await productionReleaseController(h.ports).reconcile(h.project);
  expect(readReleaseProject(h.project).live?.key).toBe("replacement");
  expect(readReleaseProject(h.project).history).toEqual([]);
  expect(h.creates()).toBe(0);
});


test("a fresh process reads settlement and launches the next release from persisted state", async () => {
  const h = staleRunFixture();
  await productionReleaseController(h.ports).reconcile(h.project);
  const script = `
    const { productionReleaseController } = await import(${JSON.stringify(new URL("./run.ts", import.meta.url).href)});
    const { readReleaseProject } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const policy = ${JSON.stringify(h.policy)};
    policy.isAncestor = (a, b) => a === b;
    const ports = { now: () => policy.now, settings: () => (${JSON.stringify(h.ports.settings(h.project))}),
      taskDone: () => false, supersedingTag: async () => null,
      observe: async () => ({ policy, repoDir: "repo", src: "seat" }), task: () => "next-task",
      create: async () => "next-lane", pipeline: () => null };
    await productionReleaseController(ports).launchIfDue(${JSON.stringify(h.input)});
    const row = readReleaseProject(${JSON.stringify(h.project)});
    console.log(JSON.stringify({ cut: row.live?.cut, trigger: row.live?.trigger, lastTag: row.observation?.lastTag, history: row.history.length }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", script], { env: { ...process.env }, timeout: 15_000 });
  expect(JSON.parse(stdout)).toEqual({ cut: "next-cut", trigger: "amount", lastTag: "v1.15.0", history: 1 });
});

test("task completion during a tag read settles without recovering admission", async () => {
  const h = staleRunFixture(); let done = false;
  h.ports.taskDone = () => done;
  h.ports.supersedingTag = async () => { done = true; return null; };
  await productionReleaseController(h.ports).reconcile(h.project);
  expect(readReleaseProject(h.project).history[0]).toMatchObject({ outcome: "completed", reason: "task-done" });
  expect(h.creates()).toBe(0);
});

test("a changed pipeline binding during a tag read is not overwritten", async () => {
  const h = staleRunFixture(); h.ports.taskDone = () => false;
  h.ports.supersedingTag = async () => {
    mutateReleaseProject(h.project, row => ({ ...row, live: { ...row.live!, pipelineId: "recovered-lane" } }));
    return "v1.15.0";
  };
  await productionReleaseController(h.ports).reconcile(h.project);
  expect(readReleaseProject(h.project).live?.pipelineId).toBe("recovered-lane");
  expect(readReleaseProject(h.project).history).toEqual([]);
});
