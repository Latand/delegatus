import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ready } from "./policy.fixture";
import { productionReleaseController, releaseRequestDigest, ReleaseValidationRefusal, type ReleasePorts } from "./run";
import { releaseStages } from "./stages";
import type { CreatePipelineRequest } from "@/lib/pipelines/types";
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
      return "next-lane"; },
    pipeline: () => null,
  };
  const input = { project, seat: { conversationId: "seat", seatEpoch: 1 },
    settings: effectiveSeatTickSettings(defaultSeatTickSettings(project), now, 60_000) } as SeatTickCheckInput;
  return { project, now, ports, input, policy, creates: () => creates };
}

test("the copied stale shape settles a done task, consumes its request and releases the next amount run", async () => {
  const h = staleRunFixture();
  h.ports.lookup = () => null;
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

test.each(["running", "parked", "completed"])("review: a bound %s pipeline keeps the slot despite stale settlement signals", async state => {
  for (const signal of ["task-done", "covering-tag"] as const) {
    const h = staleRunFixture();
    mutateReleaseProject(h.project, row => ({ ...row, live: { ...row.live!, pipelineId: "active-lane" } }));
    h.ports.pipeline = id => { expect(id).toBe("active-lane"); return { state, merged: false, declined: false }; };
    h.ports.taskDone = () => signal === "task-done";
    h.ports.supersedingTag = async () => signal === "covering-tag" ? "v1.15.0" : null;

    const result = await productionReleaseController(h.ports).reconcile(h.project);
    expect(result).toBeNull();
    expect(readReleaseProject(h.project).live).toMatchObject({ key: "old-release", cut: "old-cut", pipelineId: "active-lane" });
    expect(readReleaseProject(h.project).history).toEqual([]);
  }
});

test.each(["running", "parked", "completed", "unreadable"])("a lost creation receipt is recovered before %s lifecycle and stale signals", async state => {
  for (const signal of ["task-done", "covering-tag"] as const) {
    const h = staleRunFixture();
    h.ports.lookup = key => { expect(key).toBe("old-release"); return "existing-lane"; };
    h.ports.pipeline = id => {
      expect(id).toBe("existing-lane");
      return state === "unreadable" ? null : { state, merged: false, declined: false };
    };
    h.ports.taskDone = () => signal === "task-done";
    h.ports.supersedingTag = async () => signal === "covering-tag" ? "v1.15.0" : null;

    const result = await productionReleaseController(h.ports).reconcile(h.project);
    expect(result).toBe(state === "unreadable" ? "release: pipeline unreadable" : null);
    expect(readReleaseProject(h.project).live).toMatchObject({ key: "old-release", cut: "old-cut", pipelineId: "existing-lane" });
    expect(readReleaseProject(h.project).request).toBeNull();
    expect(readReleaseProject(h.project).history).toEqual([]);
  }
});

test("review: a recovered pipeline receipt with unreadable lifecycle retains its bound run", async () => {
  const h = staleRunFixture();
  mutateReleaseProject(h.project, row => ({ ...row, live: { ...row.live!, pipelineId: "recovered-lane" } }));
  h.ports.pipeline = () => null;
  h.ports.taskDone = () => true;
  h.ports.supersedingTag = async () => "v1.15.0";

  expect(await productionReleaseController(h.ports).reconcile(h.project)).toBe("release: pipeline unreadable");
  expect(readReleaseProject(h.project).live).toMatchObject({ key: "old-release", pipelineId: "recovered-lane" });
  expect(readReleaseProject(h.project).history).toEqual([]);
});

test("a published tag supersedes an unbound older cut", async () => {
  const h = staleRunFixture();
  h.ports.lookup = () => null;
  h.ports.taskDone = () => false;
  h.ports.supersedingTag = async (project, run) => { expect(project).toBe(h.project); expect(run.cut).toBe("old-cut"); return "v1.15.0"; };
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

function refusedRunFixture(trigger = "requested") {
  const h = staleRunFixture();
  h.ports.taskDone = () => false;
  h.ports.lookup = () => null;
  h.policy.deployments.push({ revision: "old-cut", at: h.now - 8 * 3_600_000 });
  h.policy.isAncestor = (a, b) => a === b || a === "old-cut" && b === "next-cut";
  const request: CreatePipelineRequest = { task: "Release fixture", repoDir: "repo", src: "seat", baseRef: "old-cut", autoStart: true,
    stages: releaseStages({ cut: "old-cut", lastTag: "v1.13.0", changes: [], askBeforePublish: true }) };
  request.stages[0].prompt = "x".repeat(16_350);
  mutateReleaseProject(h.project, row => ({ ...row, request: trigger === "requested" ? row.request : null,
    live: { ...row.live!, trigger, requestedAt: trigger === "requested" ? row.live!.requestedAt : null, request } }));
  return h;
}

test.each(["requested", "amount", "legacy-amount"])("a definitive %s refusal retains its reason and task, then recomposes for the current production cut", async trigger => {
  const h = refusedRunFixture(trigger === "legacy-amount" ? "amount" : trigger);
  if (trigger === "legacy-amount") mutateReleaseProject(h.project, row => {
    const live = { ...row.live! }; delete live.requestedAt; return { ...row, live };
  });
  const original = readReleaseProject(h.project);
  const submitted: { key: string; request: CreatePipelineRequest }[] = [];
  h.ports.create = async (request, key) => {
    submitted.push({ key, request });
    if (submitted.length === 1) throw new ReleaseValidationRefusal(releaseRequestDigest(request), "validation refused oversized input");
    expect(request.baseRef).toBe("next-cut");
    expect(request.taskIds).toEqual(["finished-task"]);
    return "next-lane";
  };
  let tasks = 0;
  h.ports.task = (_project, _run, adopted) => { tasks++; expect(adopted).toBe("finished-task"); return adopted!; };
  expect(await productionReleaseController(h.ports).reconcile(h.project)).toBe("release: refused");
  const retired = readReleaseProject(h.project);
  expect(retired.live).toBeNull();
  expect(retired.request).toEqual(original.request);
  expect(retired.history).toHaveLength(1);
  expect(retired.history[0]).toMatchObject({ outcome: "refused", reason: "validation refused oversized input", taskId: "finished-task", request: original.live!.request });
  await Promise.all([productionReleaseController(h.ports).launchIfDue(h.input), productionReleaseController(h.ports).launchIfDue(h.input)]);
  await productionReleaseController(h.ports).reconcile(h.project);
  expect(submitted).toHaveLength(2);
  expect(submitted[1].key).not.toBe(submitted[0].key);
  expect(tasks).toBe(1);
  expect(readReleaseProject(h.project).live).toMatchObject({ cut: "next-cut", taskId: "finished-task", pipelineId: "next-lane" });
});

test.each(["error", "timeout", "untyped-proof", "wrong-digest", "no-lookup"])("an unproven %s keeps the exact saved payload and replay key", async kind => {
  const h = refusedRunFixture();
  const original = readReleaseProject(h.project);
  if (kind === "no-lookup") delete h.ports.lookup;
  h.ports.create = async request => {
    if (kind === "error" || kind === "timeout") throw new Error(kind);
    if (kind === "untyped-proof") throw Object.assign(new Error("refused"), { digest: releaseRequestDigest(request) });
    throw new ReleaseValidationRefusal(kind === "wrong-digest" ? "other-payload" : releaseRequestDigest(request), "refused");
  };
  await expect(productionReleaseController(h.ports).reconcile(h.project)).rejects.toThrow(kind === "error" || kind === "timeout" ? kind : "refused");
  expect(readReleaseProject(h.project)).toEqual(original);
});

test("an unreadable receipt check after refusal leaves the saved claim intact", async () => {
  const h = refusedRunFixture();
  const original = readReleaseProject(h.project);
  h.ports.create = async request => {
    h.ports.lookup = () => { throw new Error("receipt unavailable"); };
    throw new ReleaseValidationRefusal(releaseRequestDigest(request), "refused");
  };
  await expect(productionReleaseController(h.ports).reconcile(h.project)).rejects.toThrow("receipt unavailable");
  expect(readReleaseProject(h.project)).toEqual(original);
});

test("completion of the refused task before recomposition consumes its request without dispatch", async () => {
  const h = refusedRunFixture();
  let attempts = 0;
  h.ports.create = async request => { attempts++; throw new ReleaseValidationRefusal(releaseRequestDigest(request), "refused"); };
  await productionReleaseController(h.ports).reconcile(h.project);
  h.ports.taskDone = (_project, task) => task === "finished-task";
  h.ports.task = () => { throw new Error("must not recreate completed task"); };
  expect(await productionReleaseController(h.ports).launchIfDue(h.input)).toBe("release: completed");
  expect(attempts).toBe(1);
  expect(readReleaseProject(h.project)).toMatchObject({ live: null, request: null });
  expect(readReleaseProject(h.project).history.at(-1)).toMatchObject({ outcome: "completed", reason: "task-done" });
});

test("a running release prevents even the refused saved launch from being dispatched or retired", async () => {
  const h = refusedRunFixture();
  h.policy.live = true;
  const original = readReleaseProject(h.project);
  h.ports.create = async () => { throw new Error("must not dispatch"); };
  expect(await productionReleaseController(h.ports).reconcile(h.project)).toBe("release: release-in-flight");
  expect(readReleaseProject(h.project)).toEqual(original);
});

test.each(["receipt", "key", "cut", "task", "payload", "binding"])("a %s arriving during refusal prevents retirement of a changed or admitted claim", async change => {
  const h = refusedRunFixture();
  h.ports.create = async request => {
    if (change === "receipt") h.ports.lookup = () => "admitted-lane";
    else mutateReleaseProject(h.project, row => ({ ...row, live: { ...row.live!,
      ...(change === "key" ? { key: "other-key" } : {}), ...(change === "cut" ? { cut: "other-cut" } : {}),
      ...(change === "task" ? { taskId: "other-task" } : {}), ...(change === "binding" ? { pipelineId: "admitted-lane" } : {}),
      ...(change === "payload" ? { request: { ...row.live!.request!, spec: "changed request" } } : {}),
    } }));
    throw new ReleaseValidationRefusal(releaseRequestDigest(request), "refused");
  };
  await productionReleaseController(h.ports).reconcile(h.project);
  expect(readReleaseProject(h.project).live).not.toBeNull();
  expect(readReleaseProject(h.project).history).toEqual([]);
  if (change === "receipt") {
    await productionReleaseController(h.ports).reconcile(h.project);
    expect(readReleaseProject(h.project).live?.pipelineId).toBe("admitted-lane");
  }
});

test.each([false, true])("a newer request keeps its own task choice when a refused launch is retired (named task: %s)", async namedTask => {
  const h = refusedRunFixture();
  let creates = 0;
  h.ports.create = async request => {
    if (++creates > 1) return "new-lane";
    mutateReleaseProject(h.project, row => ({ ...row, request: { ...row.request!, at: "2026-10-22T23:30:00Z", ...(namedTask ? { taskId: "new-task" } : {}) } }));
    throw new ReleaseValidationRefusal(releaseRequestDigest(request), "refused");
  };
  h.ports.task = (_project, _run, adopted) => { expect(adopted).toBe(namedTask ? "new-task" : undefined); return "new-task"; };
  await productionReleaseController(h.ports).launchIfDue(h.input);
  expect(readReleaseProject(h.project).live).toMatchObject({ taskId: "new-task", pipelineId: "new-lane", requestedAt: "2026-10-22T23:30:00Z" });
});

test.each(["hold", "disabled", "gap", "changes", "soak", "other-release", "tick-off", "merge-off", "checks", "draining", "deploying", "tools", "rollback"])("recomposing a refused automatic launch keeps the %s gate", async gate => {
  const h = refusedRunFixture("amount");
  let attempts = 0;
  h.ports.create = async request => { attempts++; throw new ReleaseValidationRefusal(releaseRequestDigest(request), "refused"); };
  await productionReleaseController(h.ports).reconcile(h.project);
  if (gate === "hold") mutateReleaseProject(h.project, row => ({ ...row, hold: { reason: "incident", at: "2026-10-22T23:30:00Z", by: { kind: "gateway", project: null, conversationId: null, seatEpoch: null } } }));
  if (gate === "disabled") h.ports.settings = () => null;
  if (gate === "gap") h.policy.lastTag.at = h.now - 3_600_000;
  if (gate === "changes") h.policy.changes.pop();
  if (gate === "soak") h.policy.deployments = [{ revision: "next-cut", at: h.now - 3_600_000 }];
  if (gate === "other-release") h.policy.live = true;
  if (gate === "tick-off") h.policy.tickEnabled = false;
  if (gate === "merge-off") h.policy.mergeEnabled = false;
  if (gate === "checks") h.policy.checks = "pending";
  if (gate === "draining") h.policy.draining = true;
  if (gate === "deploying") h.policy.deploying = true;
  if (gate === "tools") h.policy.tools = ["Chrome"];
  if (gate === "rollback") h.policy.isAncestor = (a, b) => a === b;
  h.ports.task = () => { throw new Error("must not create a task"); };
  await productionReleaseController(h.ports).launchIfDue(h.input);
  expect(attempts).toBe(1);
  expect(readReleaseProject(h.project).live).toBeNull();
  expect(readReleaseProject(h.project).history).toHaveLength(1);
});

test.each([false, true])("fresh processes retire a real validation refusal and dedupe storage admission across seats (lost reply: %s)", async loseReply => {
  const h = refusedRunFixture();
  const oldCut = "a".repeat(40), nextCut = "b".repeat(40);
  mutateReleaseProject(h.project, row => ({ ...row, live: { ...row.live!, cut: oldCut,
    request: { ...row.live!.request!, baseRef: oldCut } } }));
  const policy = { ...h.policy, deployments: [{ revision: nextCut, at: h.now - 7 * 3_600_000 }, { revision: oldCut, at: h.now - 8 * 3_600_000 }] };
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import crypto from "node:crypto";
    const [mode, worker] = process.argv.slice(1);
    let sequence = 0;
    crypto.randomUUID = () => worker + "0000000-0000-4000-8000-" + String(++sequence).padStart(12, "0");
    const { productionReleaseController, releaseRequestDigest } = await import(${JSON.stringify(new URL("./run.ts", import.meta.url).href)});
    const { readReleaseProject } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const { createReleasePipeline } = await import(${JSON.stringify(new URL("./production.ts", import.meta.url).href)});
    const { createPipelineFromRequest } = await import(${JSON.stringify(new URL("../pipelines/engine.ts", import.meta.url).href)});
    const { pipelineRoleLookup } = await import(${JSON.stringify(new URL("../pipelines/roles.ts", import.meta.url).href)});
    const { loadPipelines, pipelineDeliveryLookup } = await import(${JSON.stringify(new URL("../pipelines/store.ts", import.meta.url).href)});
    const { createTask } = await import(${JSON.stringify(new URL("../tasks/commands.ts", import.meta.url).href)});
    const { mutateTasksFile, loadTasks } = await import(${JSON.stringify(new URL("../tasks/store.ts", import.meta.url).href)});
    const project = ${JSON.stringify(h.project)}, policy = ${JSON.stringify(policy)};
    policy.isAncestor = (a, b) => a === b || a === ${JSON.stringify(oldCut)} && b === ${JSON.stringify(nextCut)};
    if (!loadTasks().length) mutateTasksFile(state => {
      const result = createTask(state.tasks, { project, text: "Release fixture", placement: "unplaced" }, state.recentCreates,
        { id: () => "finished-task", now: () => "2026-10-22T00:00:00Z" });
      if (!result.ok) throw new Error(result.error);
      return { state: { tasks: result.tasks, recentCreates: result.recentCreates }, result: null };
    });
    const enginePorts = { roleLookup: pipelineRoleLookup, projectForCwd: () => project, sourcePathAllowed: () => true,
      conversationIdForPath: () => "creator", now: () => "2026-10-22T23:30:00Z",
      preflightRepo: async () => ({ ok: true, repoDir: process.env.LLV_STATE_DIR, gitCommonDir: path.join(process.env.LLV_STATE_DIR, ".git"), worktreeParent: process.env.LLV_STATE_DIR }),
      exec: async (_file, args) => ({ code: 0, stdout: args[0] === "rev-parse" ? args.at(-1).replace(/\\^\\{commit\\}$/, "") : path.join(process.env.LLV_STATE_DIR, "remote.git"), stderr: "" }) };
    const ports = { now: () => policy.now, settings: () => (${JSON.stringify(h.ports.settings(h.project))}),
      taskDone: () => false, supersedingTag: async () => null,
      observe: async () => ({ policy, repoDir: process.env.LLV_STATE_DIR, src: "seat" }),
      task: (_project, _run, adopted) => {
        if (adopted !== "finished-task") throw new Error("lost task identity");
        fs.appendFileSync(path.join(process.env.LLV_STATE_DIR, "task-calls"), "adopted\\n");
        return adopted;
      },
      create: async (request, key) => {
        const id = await createReleasePipeline(request, key, (req, _ports, options) => createPipelineFromRequest(req, enginePorts, options));
        if (mode === "lose") throw new Error("lost reply");
        return id;
      },
      lookup: key => pipelineDeliveryLookup({ requestKey: key })?.id ?? null,
      pipeline: id => { const lane = loadPipelines().find(p => p.id === id); return lane ? { state: lane.state, merged: false, declined: false } : null; } };
    let error = null;
    try {
      const controller = productionReleaseController(ports);
      if (mode === "retire" || mode === "reconcile") await controller.reconcile(project);
      else await controller.launchIfDue(${JSON.stringify(h.input)});
    } catch (caught) { error = caught.message; }
    const row = readReleaseProject(project), lanes = loadPipelines();
    console.log(JSON.stringify({ error, row, lanes: lanes.map(lane => ({ id: lane.id, creationRequest: lane.creationRequest, taskIds: lane.taskIds, baseRef: lane.baseRef })),
      tasks: loadTasks().map(task => task.id), digest: row.live?.request ? releaseRequestDigest(row.live.request) : null }));
  `;
  const run = async (mode: string, worker: string) => JSON.parse((await promisify(execFile)(process.execPath, ["-e", script, mode, worker],
    { env: { ...process.env }, timeout: 30_000 })).stdout);
  const retired = await run("retire", "1");
  expect(retired.error).toBeNull();
  expect(retired.row.live).toBeNull();
  expect(retired.row.history[0].outcome).toBe("refused");
  expect(retired.lanes).toEqual([]);
  if (loseReply) {
    const lost = await run("lose", "1");
    expect(lost.error).toBe("lost reply");
    expect(lost.row.live.pipelineId).toBeNull();
    expect(lost.lanes).toHaveLength(1);
    expect(lost.lanes[0].creationRequest).toEqual({ key: lost.row.live.key, digest: lost.digest });
  }
  const results = await Promise.all([run(loseReply ? "reconcile" : "launch", "1"), run(loseReply ? "reconcile" : "launch", "2")]);
  for (const result of results) expect(result.error).toBeNull();
  const final = await run("reconcile", "3");
  expect(final.lanes).toHaveLength(1);
  expect(final.row.live).toMatchObject({ cut: nextCut, taskId: "finished-task", pipelineId: final.lanes[0].id });
  expect(final.lanes[0]).toMatchObject({ baseRef: nextCut, taskIds: ["finished-task"], creationRequest: { key: final.row.live.key, digest: final.digest } });
  expect(final.tasks).toEqual(["finished-task"]);
  expect(fs.readFileSync(path.join(directory, "task-calls"), "utf8").trim().split("\n")).toEqual(["adopted"]);
});
