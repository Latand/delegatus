import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
import type { ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { initialAuto, readAuto, writeAuto } from "./auto";
import { runGit } from "./git";
import { initialCheck } from "./checkState";
import { LOST_AFTER_MS, readManagedRecord, writeManagedRecord, type ManagedRecord } from "./managed";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { idleCheck, type Revision } from "./types";
import { activeDrain, writeDrain, DRAIN_NOTICE_MS, DRAIN_LEASE_MS } from "./drain";
import { launchHoldRefusal } from "./launchHold";
import { updateOperatorSettings } from "@/lib/operator/settings";
import { UNRESOLVED_TURN_GRACE_MS } from "./quiet";
import { owners } from "./quietTestFixtures";

const root = mkdtempSync("/var/tmp/self-update-managed-auto-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const OLD = "b".repeat(40);
const TARGET = "a".repeat(40);
const revision = (sha: string): Revision => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });

function scenario(enabled = true) {
  const dir = mkdtempSync(join(root, "run-"));
  let now = Date.parse("2026-01-01T00:00:00Z");
  let remote = "https://github.com/example/project";
  let release: string | null = OLD;
  let turns = 0;
  let stages = 0;
  let green: "green" | "red" | "pending" | "unknown" = "green";
  let greenReads = 0;
  let modeReads = 0;
  let modeReadHook: ((read: number) => Promise<void>) | null = null;
  let status: ViewerDeploymentStatus | null = null;
  const requests: ViewerDeploymentRequest[] = [];
  let receiptReads = 0;
  writeAuto(join(dir, "auto.json"), { ...initialAuto(), enabled });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ slice: {
    ...initialCheck(), installed: revision(OLD), available: revision(TARGET),
    check: { ...idleCheck(), state: "update-available", relation: "behind", at: new Date(now).toISOString() },
  }, update: null }));
  const deps = {
    dir, now: () => now, env: {}, get remote() { return remote; }, branch: "main", pollMinutes: 60, bun: "bun",
    mode: async () => {
      modeReads += 1;
      await modeReadHook?.(modeReads);
      return { mode: "managed", reason: null, record: null };
    },
    check: async () => ({ ok: true, installed: revision(OLD), available: revision(TARGET), relation: "behind", ahead: 0, behind: 1, delta: null }),
    describe: async (_repo: string, sha: string) => revision(sha),
    releaseTarget: () => release ? { revision: release } : null,
    prepareCheckRepo: async () => dir,
    targetOnBranch: async () => true,
    hostHealth: async () => ({ pid: 102, generation: { revision: release ?? OLD } }),
    web: { pid: 101, port: 3000, startedAt: new Date(now).toISOString() },
    green: { read: async () => { greenReads += 1; return { state: green }; } },
    quiet: { runtimeSnapshot: async () => ({ sessions: Array.from({ length: turns }, () => ({ turn: "running", host: "hosted" })) }),
      owners: owners(),
      pipelines: () => Array.from({ length: stages }, () => ({ state: "running", cursor: { state: "running" } })) as never,
      presence: () => [], memoryAvailableMb: () => 8_192 },
    requestDeployment: async (body: ViewerDeploymentRequest) => {
      requests.push(body);
      status = {
        deploymentId: "deployment-1", idempotencyKey: body.idempotencyKey, requestedRevision: TARGET, revision: TARGET,
        phase: "admitted", terminal: false, candidate: null, previous: null,
        mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
        owner: { pid: 102, startIdentity: null }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), revisionNumber: 1,
      };
      return { state: "accepted", deploymentId: "deployment-1", revision: TARGET, replayed: requests.length > 1 };
    },
    readDeployment: async () => status,
    findDeploymentByIdempotencyKey: async (idempotencyKey: string) => {
      receiptReads += 1;
      return status?.idempotencyKey === idempotencyKey ? status : null;
    },
  } as unknown as ServiceDeps;
  return {
    dir, deps, requests, service: () => new SelfUpdateService(deps),
    receiptReads: () => receiptReads,
    advance: (ms: number) => { now += ms; }, setTurns: (value: number) => { turns = value; },
    setStages: (value: number) => { stages = value; },
    setGreen: (value: typeof green) => { green = value; }, greenReads: () => greenReads,
    setRemote: (value: string) => { remote = value; }, setRelease: (value: string | null) => { release = value; },
    setModeReadHook: (hook: ((read: number) => Promise<void>) | null) => { modeReadHook = hook; },
    finish: (phase: "succeeded" | "rolled-back" | "failed", error: string | null = null) => {
      if (!status) throw new Error("deployment was not requested");
      status = { ...status, phase, terminal: true, error, updatedAt: new Date(now).toISOString(), revisionNumber: status.revisionNumber + 1 };
      if (phase === "succeeded") release = TARGET;
    },
  };
}

test.each(["succeeded", "rolled-back", "failed"] as const)("accepted receipt persistence failure retains custody through reconstruction and healthy %s", async (phase) => {
  const h = scenario();
  let service = h.service();
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  let hostRevision = OLD;
  let hostAnswers = true;
  h.deps.hostHealth = async () => hostAnswers ? { pid: 102, startIdentity: "fixture", hostEpoch: 1, generation: { revision: hostRevision } } : null;
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  const auto = () => readAuto(join(h.dir, "auto.json"));
  const receiptFile = join(h.dir, "managed.json");
  try {
    await service.autoTick();
    const holdId = held()!.id;
    h.advance(60_000);
    mkdirSync(receiptFile);
    await service.autoTick(); // The host accepts; the real receipt rename fails with EISDIR.
    expect(h.requests).toHaveLength(1);
    expect(held()?.id).toBe(holdId);
    const pending = auto().managedPending;
    expect(pending).not.toBeNull();
    expect(auto().enabled).toBe(true);
    expect((await service.snapshot()).update).toMatchObject({ state: "running", deploymentId: "deployment-1" });
    await service.setAuto(false);
    service.stop();
    h.advance(DRAIN_LEASE_MS + 1);
    service = h.service();
    await service.autoTick(); // Recover acceptance with lookup while persistence still fails.
    expect(h.receiptReads()).toBe(1);
    expect(auto().managedPending).toEqual(pending);
    expect(held()?.id).toBe(holdId);
    expect(h.requests).toHaveLength(1);
    // Repair only this fixture's obstacle, then prove observation retries the receipt write.
    rmSync(receiptFile, { recursive: true });
    await service.snapshot();
    expect(readManagedRecord(receiptFile)).toMatchObject({ deploymentId: "deployment-1", idempotencyKey: h.requests[0]!.idempotencyKey });
    h.setRelease(TARGET); // Web has moved; the old host must still fence launches.
    h.finish(phase);
    await service.snapshot();
    expect(held()?.id).toBe(holdId);
    expect(ticks).toBe(0);
    service.stop();
    service = h.service();
    await service.autoTick();
    expect(held()?.id).toBe(holdId);
    const settledRevision = phase === "succeeded" ? TARGET : OLD;
    h.setRelease(settledRevision);
    hostRevision = settledRevision;
    hostAnswers = false;
    await service.autoTick();
    expect(held()?.id).toBe(holdId);
    hostAnswers = true;
    await service.autoTick();
    expect(held()).toBeNull();
    expect(auto().managedPending).toBeNull();
    await service.autoTick();
    expect(ticks).toBe(1);
    expect(h.requests).toHaveLength(1);
  } finally { service.stop(); }
});

test.each(["succeeded", "rolled-back", "failed"] as const)("early managed admission holds launches across reconstruction until %s", async (phase) => {
  const h = scenario();
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  const lease = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  expect(lease()?.target).toBe(TARGET);
  service.stop();
  h.advance(DRAIN_LEASE_MS + 1);
  service = h.service();
  service.startAuto();
  expect(lease()?.target).toBe(TARGET);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  h.finish(phase);
  await service.snapshot();
  expect(lease()).toBeNull();
  service.stop();
});

test("a reconstructed accepted intent never resubmits when its receipt lookup is empty", async () => {
  const h = scenario();
  let service = h.service();
  const receiptFile = join(h.dir, "managed.json");
  try {
    await service.autoTick();
    h.advance(60_000);
    mkdirSync(receiptFile);
    await service.autoTick();
    const holdId = activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())!.id;
    service.stop();
    h.deps.findDeploymentByIdempotencyKey = async () => null;
    service = h.service();
    for (let i = 0; i < 3; i++) {
      h.advance(60_000);
      await service.autoTick();
    }
    expect(h.requests).toHaveLength(1);
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(holdId);
    expect(readAuto(join(h.dir, "auto.json")).managedPending).not.toBeNull();
    // The host's direct read can recover an accepted deployment despite a missing index entry.
    rmSync(receiptFile, { recursive: true });
    h.finish("succeeded");
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
    expect(h.requests).toHaveLength(1);
  } finally { service.stop(); }
});

test.each(["failed", "rolled-back", "lost"] as const)("terminal managed %s retains custody until both processes are freshly healthy on one revision", async (phase) => {
  const h = scenario();
  let service = h.service();
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  let hostRevision = OLD;
  let hostAnswers = true;
  h.deps.hostHealth = async () => hostAnswers ? { pid: 102, startIdentity: "host", hostEpoch: 1, generation: { revision: hostRevision } } : null;
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  try {
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(h.requests).toHaveLength(1);
    const id = held()!.id;
    h.setRelease(TARGET); // Web promoted while the host remains on the previous revision.
    if (phase === "lost") {
      h.deps.readDeployment = async () => null;
      await service.snapshot();
      h.advance(LOST_AFTER_MS + 1);
    } else h.finish(phase, "runtime host handoff or rollback failed");
    await service.snapshot();
    expect(held()?.id).toBe(id);
    expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
    expect(ticks).toBe(0);
    service.stop();
    h.advance(DRAIN_LEASE_MS + 1);
    service = h.service();
    await service.autoTick();
    expect(held()?.id).toBe(id);
    h.setRelease(OLD);
    hostAnswers = false;
    await service.autoTick();
    expect(held()?.id).toBe(id);
    hostAnswers = true;
    hostRevision = "c".repeat(40);
    await service.autoTick();
    expect(held()?.id).toBe(id);
    hostRevision = OLD;
    await service.autoTick();
    expect(held()).toBeNull();
    expect(readAuto(join(h.dir, "auto.json")).managedPending).toBeNull();
    await service.autoTick();
    expect(h.requests).toHaveLength(1);
    expect(ticks).toBe(1);
  } finally { service.stop(); }
});

test.each(["succeeded", "rolled-back", "failed"] as const)("switch-off retains managed custody and cold renewal until %s", async (phase) => {
  const h = scenario();
  h.setTurns(1);
  let service = h.service();
  await service.autoTick();
    await service.autoTick();
  h.setTurns(0);
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  await service.setAuto(false);
  const lease = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  expect(lease()).not.toBeNull();
  service.stop();
  h.advance(DRAIN_LEASE_MS + 1);
  service = h.service();
  service.startAuto();
  expect(lease()).not.toBeNull();
  h.advance(DRAIN_LEASE_MS + 1);
  await service.autoTick();
  expect(lease()).not.toBeNull();
  expect(h.requests).toHaveLength(1);
  h.finish(phase);
  await service.snapshot();
  expect(lease()).toBeNull();
  expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
  service.stop();
});

test("managed availability permits deployment and explains missing prerequisites", async () => {
  const h = scenario(false);
  const service = h.service();
  expect((await service.snapshot()).auto?.availability).toBe("available");
  expect(await service.setAuto(true)).toEqual({ ok: true });
  service.stop();
  h.setRelease(null);
  const withoutTarget = h.service();
  expect((await withoutTarget.snapshot()).auto?.availability).toBe("no-release-target");
  expect(await withoutTarget.setAuto(true)).toMatchObject({ ok: false, code: "auto-unavailable" });
  withoutTarget.stop();
  h.setRelease(OLD);
  h.setRemote("file:///local/repo");
  const withoutGithub = h.service();
  expect((await withoutGithub.snapshot()).auto?.availability).toBe("not-github");
  expect(await withoutGithub.setAuto(true)).toMatchObject({ ok: false, code: "auto-unavailable" });
  withoutGithub.stop();
});

test("a busy managed install holds immediately and retains its cohort through six hours", async () => {
  const h = scenario();
  h.setTurns(1);
  let service = h.service();
  try {
    await service.autoTick();
    const since = (await service.snapshot()).auto!.waitingSince;
    expect((await service.snapshot()).auto).toMatchObject({ longWait: false, drain: { state: "draining" } });
    const hold = activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())!;
    const next = "c".repeat(40);
    h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision(next), relation: "behind", ahead: 0, behind: 2, delta: null });
    await service.check();
    await Bun.sleep(0);
    h.advance(3 * 60 * 60_000);
    await service.autoTick();
    expect((await service.snapshot()).auto).toMatchObject({ waitingSince: since, longWait: false, target: { sha: TARGET } });
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(hold.id);
    service.stop();
    service = h.service();
    h.advance(3 * 60 * 60_000);
    await service.autoTick();
    expect((await service.snapshot()).auto).toMatchObject({ longWait: true, drain: { state: "overran" }, decision: { id: hold.id } });
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
    h.setTurns(0);
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.revision).toBe(TARGET);
  } finally { service.stop(); }
});

test.each(["red", "pending", "unknown"] as const)("a newly pending managed update holds admission before its first %s result", async state => {
  const h = scenario(); h.setGreen(state);
  h.deps.quiet!.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "conversation_original", sessionKey: { engine: "codex" }, host: "hosted", turn: "running" }] }) as never;
  const service = h.service();
  try {
    await service.autoTick();
    const hold = activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
    expect(hold).not.toBeNull();
    h.advance(DRAIN_NOTICE_MS); await service.autoTick();
    expect((await service.snapshot()).auto?.decision).toMatchObject({ id: hold!.id, blockers: { turnList: [{ conversationId: "conversation_original" }] } });
    expect(h.requests).toHaveLength(0);
  } finally { service.stop(); }
});

test("admission is already held while the first managed green lookup awaits", async () => {
  const h = scenario();
  let reading = false, release = () => {};
  h.deps.green = { read: () => { reading = true; return new Promise(resolve => { release = () => resolve({ state: "pending" }); }); } } as unknown as ServiceDeps["green"];
  const service = h.service(); const tick = service.autoTick();
  try {
    for (let i = 0; i < 100 && !reading; i++) await Bun.sleep(1);
    expect(reading).toBe(true);
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  } finally { release(); await tick; service.stop(); }
});

test.each(["enabled", "switch-off"] as const)("cold recovery reconciles a hold published before its owner checkpoint: %s", async mode => {
  const h = scenario(); h.setTurns(1);
  const since = new Date(h.deps.now()).toISOString();
  const autoFile = join(h.dir, "auto.json"), holdFile = join(h.dir, "auto-drain.json");
  writeAuto(autoFile, { ...readAuto(autoFile), waitingSince: since, waitingTarget: TARGET });
  writeDrain(holdFile, { id: "orphan-first-hold", target: TARGET, since, until: h.deps.now() - 1, persistent: true });
  let ticks = 0; h.deps.requestPipelineTick = () => { ticks++; };
  let service = h.service();
  try {
    if (mode === "switch-off") {
      expect(await service.setAuto(false)).toEqual({ ok: true });
      await service.autoTick(); service.stop(); service = h.service(); await service.autoTick();
      expect(activeDrain(holdFile, h.deps.now())).toBeNull();
      expect(readAuto(autoFile)).toMatchObject({ enabled: false, drain: null });
      expect(ticks).toBe(1);
    } else {
      await service.autoTick();
      expect(readAuto(autoFile).drain).toMatchObject({ id: "orphan-first-hold", target: { sha: TARGET }, since });
      service.stop(); service = h.service(); h.advance(DRAIN_NOTICE_MS); await service.autoTick();
      expect((await service.snapshot()).auto?.decision?.id).toBe("orphan-first-hold");
      expect(activeDrain(holdFile, h.deps.now())?.id).toBe("orphan-first-hold");
      expect(h.requests).toHaveLength(0); expect(ticks).toBe(0);
    }
  } finally { service.stop(); }
});

test.each(["red", "pending", "unknown"] as const)("six-hour named cohort decision stays visible under %s checks", async state => {
  const h = scenario();
  h.deps.quiet!.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "conversation_original", engine: "codex", host: "hosted", turn: "running" }] }) as never;
  let service = h.service();
  try {
    await service.autoTick(); h.setGreen(state);
    // Recover the authoritative non-green result saved by a prior refresh.
    service.stop();
    const file = join(h.dir, "auto.json");
    const saved = readAuto(file);
    writeAuto(file, { ...saved, green: { ...saved.green, [TARGET]: { ...saved.green[TARGET], state } } });
    service = h.service(); h.advance(DRAIN_NOTICE_MS + 60_000);
    await service.autoTick();
    const auto = (await service.snapshot()).auto!;
    expect(auto).toMatchObject({ phase: "not-green", longWait: true, decision: { blockers: { turnList: [{ conversationId: "conversation_original" }] } } });
    expect(auto.decision?.id).toBe(readAuto(join(h.dir, "auto.json")).drain?.id);
    service.stop(); service = h.service();
    expect((await service.snapshot()).auto?.decision?.id).toBe(auto.decision!.id);
    expect(await service.decideDrain(auto.decision!.id, "deploy-now")).toEqual({ ok: true });
    expect(h.requests).toHaveLength(0);
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  } finally { service.stop(); }
});

test("disabling during the green read cannot publish a new launch hold", async () => {
  const h = scenario();
  const file = join(h.dir, "auto.json");
  writeAuto(file, { ...readAuto(file), waitingSince: new Date(h.deps.now()).toISOString(), waitingTarget: TARGET });
  let release = () => {};
  let reading = false;
  h.deps.green = { read: () => { reading = true; return new Promise((resolve) => { release = () => resolve({ state: "green" }); }); } } as unknown as ServiceDeps["green"];
  const service = h.service();
  const tick = service.autoTick();
  for (let i = 0; i < 100 && !reading; i++) await Bun.sleep(1);
  expect(reading).toBe(true);
  await service.setAuto(false);
  release();
  await tick;
  expect(readAuto(file)).toMatchObject({ enabled: false, drain: null });
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
  service.stop();
});

test.each([false, true])("a red unaccepted drain advances to green main with continuous custody (restart=%s)", async (restart) => {
  const h = scenario();
  const newer = "c".repeat(40);
  const autoFile = join(h.dir, "auto.json");
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  h.setTurns(1);
  let expectedHold: { id: string; since: string } | null = null;
  h.deps.green = { read: async (_remote: string, _branch: string, target: string) => {
    // Every asynchronous green read sees the original cohort's hold.
    if (expectedHold) expect(held()).toMatchObject(expectedHold);
    return { state: target === TARGET ? "red" : "green" };
  } } as unknown as ServiceDeps["green"];
  let service = h.service();
  try {
    await service.autoTick();
    const original = readAuto(autoFile);
    expect(original.managedPending).toBeNull();
    h.advance(DRAIN_NOTICE_MS);
    await service.autoTick();
    const cohort = readAuto(autoFile).drain!;
    expectedHold = { id: cohort.id, since: cohort.since };
    expect(cohort.overranAt).not.toBeNull();
    if (restart) {
      service.stop();
      h.advance(DRAIN_LEASE_MS + 1);
      service = h.service();
      await service.autoTick();
      expect(held()).toMatchObject({ ...expectedHold, target: TARGET });
    }
    h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision(newer), relation: "behind", ahead: 0, behind: 2, delta: null });
    const unsubscribe = service.changes.on(() => {
      expect(held()).toMatchObject({ id: cohort.id, since: cohort.since });
    });
    await service.check();
    await Bun.sleep(0);
    if (restart) {
      unsubscribe();
      service.stop();
      h.advance(DRAIN_LEASE_MS + 1);
      service = h.service();
    }
    await service.autoTick();
    expect(readAuto(autoFile)).toMatchObject({ waitingSince: original.waitingSince, waitingTarget: newer,
      drain: { ...cohort, target: revision(newer) }, managedPending: null });
    expect(held()).toMatchObject({ id: cohort.id, target: newer, since: cohort.since });
    expect(h.requests).toHaveLength(0);
    h.deps.requestDeployment = async (body) => {
      expect(held()).toMatchObject({ id: cohort.id, target: newer, since: cohort.since });
      h.requests.push(body);
      return { state: "accepted", deploymentId: "deployment-newer", revision: newer, replayed: false };
    };
    h.setTurns(0);
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.revision).toBe(newer);
    expect(readAuto(autoFile).drain).toMatchObject({ id: cohort.id, since: cohort.since, admitted: true });
    expect(ticks).toBe(0);
    unsubscribe();
  } finally { service.stop(); }
});

test.each(["red", "pending", "unknown"] as const)("a red drain retains its target when newer main is %s", async (state) => {
  const h = scenario();
  h.setGreen("red");
  const service = h.service();
  try {
    await service.autoTick();
    const original = readAuto(join(h.dir, "auto.json")).drain;
    const newer = "c".repeat(40);
    h.setGreen(state);
    h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision(newer), relation: "behind", ahead: 0, behind: 2, delta: null });
    await service.check();
    await Bun.sleep(0);
    h.advance(60_000);
    await service.autoTick();
    expect(readAuto(join(h.dir, "auto.json")).drain).toEqual(original);
    expect(h.requests).toHaveLength(0);
  } finally { service.stop(); }
});

test.each(["switch-off", "main-moved", "red-refresh"] as const)("red target supersession rechecks %s after the candidate green wait", async (change) => {
  const h = scenario();
  const newer = "c".repeat(40);
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let candidateReads = 0;
  h.deps.green = { read: async (_remote: string, _branch: string, target: string) => {
    if (target === TARGET) return { state: "red" };
    if (++candidateReads === 2) {
      entered();
      await paused;
      if (change === "red-refresh") return { state: "red" };
    }
    return { state: "green" };
  } } as unknown as ServiceDeps["green"];
  const service = h.service();
  try {
    await service.autoTick();
    const original = readAuto(join(h.dir, "auto.json")).drain!;
    h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision(newer), relation: "behind", ahead: 0, behind: 2, delta: null });
    await service.check();
    await reading;
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(original.id);
    if (change === "switch-off") await service.setAuto(false);
    if (change === "main-moved") {
      h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision("d".repeat(40)), relation: "behind", ahead: 0, behind: 3, delta: null });
      await service.check();
    }
    release();
    await Bun.sleep(0);
    const drain = readAuto(join(h.dir, "auto.json")).drain;
    expect(drain).toEqual(change === "switch-off" ? null : original);
    expect(h.requests).toHaveLength(0);
  } finally { release(); service.stop(); }
});

test.each(["succeeded", "rolled-back", "failed"] as const)("the frozen drain target survives newer merges and releases after %s", async (phase) => {
  const h = scenario();
  h.setTurns(1);
  const service = h.service();
  await service.autoTick();
    await service.autoTick();
  const next = "c".repeat(40);
  h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision(next), relation: "behind", ahead: 0, behind: 2, delta: null });
  await service.check();
  await Bun.sleep(0);
  expect((await service.snapshot()).auto?.target?.sha).toBe(TARGET);
  h.setTurns(0);
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.revision).toBe(TARGET);
  h.advance(DRAIN_NOTICE_MS);
  await service.autoTick();
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  h.finish(phase, phase === "succeeded" ? null : "candidate failed");
  await service.snapshot();
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
  service.stop();
});

test.each(["switch-off", "unavailable"])("a busy drain releases on %s", async (reason) => {
  const h = scenario();
  h.setTurns(1);
  const service = h.service();
  await service.autoTick();
    await service.autoTick();
  if (reason === "switch-off") await service.setAuto(false);
  else { h.setRelease(null); await service.autoTick(); }
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
  service.stop();
});

test("managed green merge waits for a quiet minute and requests the manual deployment path once", async () => {
  const h = scenario();
  const service = h.service();
  h.setTurns(1);
  await service.autoTick();
  expect(h.requests).toHaveLength(0);
  h.setTurns(0);
  await service.autoTick();
  h.advance(59_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(0);
  h.advance(1_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ revision: TARGET, idempotencyKey: expect.stringMatching(/^self-update-/) });
  expect(h.greenReads()).toBeGreaterThan(0);
  expect(readManagedRecord(join(h.dir, "managed.json"))?.trigger).toBe("auto");
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();
});

test("a drain whose journal holds only dead-host and unresolved turns deploys and releases launches (#2515)", async () => {
  const h = scenario();
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  const blockers = () => readAuto(join(h.dir, "auto.json")).lastBlockers;
  /* What the incident's journal held: rows that say a turn is running, none
     with a host behind it, and one the registry no longer knows. */
  const rows = Array.from({ length: 93 }, (_, index) => ({ conversationId: `conversation_stale-${index}`, sessionKey: { engine: "codex" }, cwd: null, host: "hosted", turn: "running" }));
  h.deps.quiet!.runtimeSnapshot = async () => ({ sessions: rows }) as never;
  h.deps.quiet!.owners = owners((conversationId) => conversationId?.endsWith("-92") ? "unresolved" : "gone");
  const service = h.service();
  await service.autoTick();
  /* The update holds launches at once, and names the one row it cannot resolve. */
  expect(held()).not.toBeNull();
  expect(blockers()).toMatchObject({ turns: 1, stages: 0, discounted: 92, unresolved: 1, unresolvedBlocking: 1 });
  expect(launchHoldRefusal(held()!, blockers()).error)
    .toBe("new launches are held while the automatic update waits for 1 running turn to finish (1 turn has no liveness record and stops counting within 5 minutes)");
  h.advance(UNRESOLVED_TURN_GRACE_MS - 1);
  await service.autoTick();
  expect(h.requests).toHaveLength(0);
  /* Past the bound nothing live remains, so the quiet minute runs and the update deploys. */
  h.advance(1);
  await service.autoTick();
  expect(blockers()).toMatchObject({ turns: 0, discounted: 92, unresolved: 1, unresolvedBlocking: 0 });
  expect(launchHoldRefusal(held()!, blockers()).waitingFor).toBe("one quiet minute before it starts; no turn or stage is running");
  expect(h.requests).toHaveLength(0);
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.revision).toBe(TARGET);
  h.finish("succeeded");
  await service.snapshot();
  expect(held()).toBeNull();
  service.stop();
});

test("a turn that is really running holds the drain for as long as it runs (#2515)", async () => {
  const h = scenario();
  h.deps.quiet!.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "conversation_work", sessionKey: { engine: "codex" }, cwd: null, host: "hosted", turn: "running" }] }) as never;
  h.deps.quiet!.owners = owners();
  const service = h.service();
  for (const wait of [0, UNRESOLVED_TURN_GRACE_MS, 60_000, 3 * 60 * 60_000]) {
    h.advance(wait);
    await service.autoTick();
    expect(h.requests).toHaveLength(0);
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
    expect(readAuto(join(h.dir, "auto.json")).lastBlockers).toMatchObject({ turns: 1, discounted: 0, unresolved: 0 });
  }
  service.stop();
});

test("a fresh red check at the end of the quiet minute vetoes managed deployment", async () => {
  const h = scenario();
  const service = h.service();
  await service.autoTick();
  h.setGreen("red");
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(0);
  expect(readAuto(join(h.dir, "auto.json")).green[TARGET]?.state).toBe("red");
  service.stop();
});

test("an unaccepted managed intent stays pending without deploying while auto is disabled", async () => {
  const h = scenario();
  h.deps.requestDeployment = async (body) => {
    h.requests.push(body);
    return { state: "busy", deploymentId: "other-deployment", revision: TARGET };
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(readManagedRecord(join(h.dir, "managed.json"))).toBeNull();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
    off: { target: TARGET, stage: "deploy", reason: "another deployment is running (other-deployment)" } });
  expect(await service.setAuto(false)).toEqual({ ok: true });
  service.stop();

  h.setGreen("red");
  h.setTurns(1);
  service = h.service();
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null });
  service.stop();

  const disabled = scenario();
  writeAuto(join(disabled.dir, "auto.json"), { ...initialAuto(), enabled: true,
    managedPending: { target: revision(TARGET), clientKey: "unaccepted-key", at: "2026-01-01T00:00:00.000Z" } });
  service = disabled.service();
  await service.setAuto(false);
  service.stop();
  disabled.setGreen("red");
  disabled.setTurns(1);
  service = disabled.service();
  await service.autoTick();
  expect(disabled.requests).toHaveLength(0);
  expect(readAuto(join(disabled.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: { clientKey: "unaccepted-key" } });
  service.stop();
});

test("a deterministic host refusal disables auto and survives service reconstruction", async () => {
  const h = scenario();
  h.deps.requestDeployment = async () => { throw new Error("canonical revision is unavailable"); };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
    off: { target: TARGET, stage: "deploy", reason: "canonical revision is unavailable" } });
  service.stop();

  service = h.service();
  expect((await service.snapshot()).auto?.off).toMatchObject({ target: TARGET, reason: "canonical revision is unavailable" });
  service.stop();
});

test("an uncertain host response retries after restart with the saved idempotency key", async () => {
  const h = scenario();
  h.deps.requestDeployment = async (body) => {
    h.requests.push(body);
    throw new RuntimeHostUnavailableError("runtime host request timed out");
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  const key = h.requests[0]?.idempotencyKey;
  expect(key).toMatch(/^self-update-/);
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: true, managedPending: { clientKey: expect.any(String) } });
  service.stop();

  h.deps.requestDeployment = async (body) => {
    h.requests.push(body);
    return { state: "accepted", deploymentId: "deployment-1", revision: TARGET, replayed: true };
  };
  service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]?.idempotencyKey).toBe(key);
  service.stop();
});

test.each(["succeeded", "rolled-back"] as const)("an accepted request with a lost reply is reconciled before current policy for %s", async (phase) => {
  const h = scenario();
  const request = h.deps.requestDeployment;
  let loseReply = true;
  h.deps.requestDeployment = async (body) => {
    const receipt = await request(body);
    if (loseReply) {
      loseReply = false;
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    }
    return receipt;
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(readAuto(join(h.dir, "auto.json")).managedPending).not.toBeNull();
  service.stop();

  // Current admission policy now blocks new requests. Reconciliation reads
  // the accepted receipt without replaying a request that could create one.
  h.setGreen("red");
  h.setTurns(1);
  service = h.service();
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(h.receiptReads()).toBeGreaterThan(0);
  expect(readManagedRecord(join(h.dir, "managed.json"))?.trigger).toBe("auto");

  h.finish(phase, phase === "succeeded" ? null : "candidate health failed");
  await service.refreshManaged();
  await service.snapshot();
  if (phase === "succeeded") {
    expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: true, managedPending: null, off: null });
  } else {
    expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
      off: { target: TARGET, reason: "candidate health failed" } });
  }
  service.stop();
});

test("an uncertain request absent from the host must pass fresh green and quiet admission", async () => {
  const h = scenario();
  h.deps.requestDeployment = async (body) => {
    h.requests.push(body);
    throw new RuntimeHostUnavailableError("runtime host request timed out");
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();

  h.setGreen("red");
  h.setTurns(1);
  service = h.service();
  await service.autoTick();
  expect(h.receiptReads()).toBeGreaterThan(0);
  expect(h.requests).toHaveLength(1);
  expect(readAuto(join(h.dir, "auto.json")).managedPending).not.toBeNull();
  service.stop();
});

test("an undelivered intent yields to a newer main after fresh admission and a web restart", async () => {
  const h = scenario();
  const newer = "c".repeat(40);
  h.deps.requestDeployment = async (body) => {
    h.requests.push(body);
    throw new RuntimeHostUnavailableError("runtime host request timed out");
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  const oldKey = h.requests[0]?.idempotencyKey;
  expect(readAuto(join(h.dir, "auto.json")).managedPending?.target.sha).toBe(TARGET);
  service.stop();

  h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision(newer), relation: "behind", ahead: 0, behind: 1, delta: null });
  h.deps.requestDeployment = async (body) => {
    h.requests.push(body);
    return { state: "accepted", deploymentId: "deployment-newer", revision: newer, replayed: false };
  };
  h.setGreen("red");
  h.setTurns(1);
  service = h.service();
  await service.check();
  expect((await service.snapshot()).available?.sha).toBe(newer);
  service.stop();
  service = h.service();
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: true, managedPending: null, off: null });

  h.setGreen("green");
  h.advance(15 * 60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  h.setTurns(0);
  await service.autoTick();
  h.advance(59_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();

  service = h.service();
  h.advance(1_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]).toMatchObject({ revision: newer, idempotencyKey: expect.stringMatching(/^self-update-/) });
  expect(h.requests[1]?.idempotencyKey).not.toBe(oldKey);
  expect(readManagedRecord(join(h.dir, "managed.json"))).toMatchObject({ target: newer, trigger: "auto" });
  await service.autoTick();
  expect(h.requests).toHaveLength(2);
  service.stop();
});

test("a late accepted deployment failure survives main advancing during receipt lookup", async () => {
  const h = scenario();
  const originalRequest = h.deps.requestDeployment;
  h.deps.requestDeployment = async (body) => {
    await originalRequest(body);
    throw new RuntimeHostUnavailableError("runtime host request timed out");
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();

  const newer = "c".repeat(40);
  const stateFile = join(h.dir, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.slice.available = revision(newer);
  writeFileSync(stateFile, JSON.stringify(state));
  let releaseLookup!: () => void;
  const admission = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const originalLookup = h.deps.findDeploymentByIdempotencyKey;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
  h.deps.findDeploymentByIdempotencyKey = async (key) => {
    lookupStarted();
    await admission;
    return originalLookup(key);
  };
  service = h.service();
  const tick = service.autoTick();
  await started;
  expect(readAuto(join(h.dir, "auto.json")).managedPending?.target.sha).toBe(TARGET);
  h.finish("failed", "late build failed");
  releaseLookup();
  await tick;
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
    off: { target: TARGET, reason: "late build failed" } });
  expect(h.requests).toHaveLength(1);
  service.stop();
});

test("a previous managed record does not hide recovery of a later accepted lost reply", async () => {
  const h = scenario();
  const old: ManagedRecord = {
    deploymentId: "old-deployment", idempotencyKey: "old-key", trigger: "operator", target: OLD,
    targetShort: OLD.slice(0, 7), targetVersion: "1", requestedAt: new Date(Date.parse("2025-12-31T23:00:00Z")).toISOString(),
    observed: {}, lastStep: null, finishedAt: new Date(Date.parse("2025-12-31T23:01:00Z")).toISOString(),
    phase: "succeeded", error: null, servingProgress: null,
  };
  writeManagedRecord(join(h.dir, "managed.json"), old);
  const request = h.deps.requestDeployment;
  h.deps.requestDeployment = async (body) => {
    const receipt = await request(body);
    throw new RuntimeHostUnavailableError("runtime host request timed out");
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();

  h.setGreen("red");
  h.setTurns(1);
  service = h.service();
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(readManagedRecord(join(h.dir, "managed.json"))).toMatchObject({ target: TARGET, trigger: "auto" });
  expect(readAuto(join(h.dir, "auto.json")).managedPending).not.toBeNull();
  h.finish("rolled-back", "candidate health failed");
  await service.refreshManaged();
  await service.snapshot();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
    off: { target: TARGET, reason: "candidate health failed" } });
  service.stop();
});

test("an accepted lost reply is observed after auto is disabled and the service restarts", async () => {
  const h = scenario();
  const request = h.deps.requestDeployment;
  h.deps.requestDeployment = async (body) => {
    const receipt = await request(body);
    throw new RuntimeHostUnavailableError("runtime host request timed out");
  };
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  await service.setAuto(false);
  service.stop();

  service = h.service();
  h.finish("rolled-back", "candidate health failed");
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
    off: { target: TARGET, reason: "candidate health failed" } });
  service.stop();
});

test.each(["turn", "stage"] as const)("a running %s that starts during the final mode read blocks managed admission", async (work) => {
  const h = scenario();
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  let entered!: () => void;
  let releaseMode!: () => void;
  const modeEntered = new Promise<void>((resolve) => { entered = resolve; });
  const modeRelease = new Promise<void>((resolve) => { releaseMode = resolve; });
  h.setModeReadHook(async (read) => {
    if (read === 3) {
      entered();
      await modeRelease;
    }
  });
  const tick = service.autoTick();
  await modeEntered;
  if (work === "turn") h.setTurns(1);
  else h.setStages(1);
  releaseMode();
  await tick;
  expect(h.requests).toHaveLength(0);
  expect(readAuto(join(h.dir, "auto.json")).managedPending).toBeNull();
  service.stop();
});

test("a rolled-back automatic deployment turns auto off with its target and reason", async () => {
  const h = scenario();
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  h.finish("rolled-back", "candidate health failed");
  await service.refreshManaged();
  await service.snapshot();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
    off: { target: TARGET, stage: "deploy", reason: "candidate health failed" } });
  expect((await service.snapshot()).auto?.off?.target).toBe(TARGET);
  service.stop();
});

test("a new web process follows an in-flight deployment without requesting it again", async () => {
  const h = scenario();
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();
  service = h.service();
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect((await service.snapshot()).auto?.phase).toBe("deploying");
  h.finish("failed", "image build failed");
  await service.refreshManaged();
  expect(readAuto(join(h.dir, "auto.json")).off).toMatchObject({ target: TARGET, reason: "image build failed" });
  service.stop();
});

test("a successful deployment settles after a web restart and keeps auto enabled", async () => {
  const h = scenario();
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  service.stop();
  service = h.service();
  h.finish("succeeded");
  h.setRelease(OLD); // The hot target may lag the host's terminal receipt.
  await service.refreshManaged();
  await service.snapshot();
  expect(readAuto(join(h.dir, "auto.json")).managedPending).not.toBeNull();
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  h.setRelease(TARGET);
  await service.snapshot();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: true, managedPending: null, off: null, waitingSince: null });
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();
});

test("a saved failure disables updates while preserving custody until the host can answer", async () => {
  const h = scenario();
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  service.stop();
  const file = join(h.dir, "managed.json");
  const record = readManagedRecord(file)!;
  writeManagedRecord(file, { ...record, phase: "rolled-back", finishedAt: new Date(Date.parse("2026-01-01T00:01:00Z")).toISOString(), error: "promotion failed" });
  h.deps.mode = async () => ({ mode: "unsupported", reason: "no-runtime-host", record: null });
  service = h.service();
  await service.autoTick();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false,
    off: { target: TARGET, reason: "promotion failed" } });
  expect(readAuto(join(h.dir, "auto.json")).managedPending).not.toBeNull();
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  h.deps.mode = async () => ({ mode: "managed", reason: null, record: null });
  h.advance(5_000);
  await service.autoTick();
  expect(readAuto(join(h.dir, "auto.json")).managedPending).toBeNull();
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
  expect(h.requests).toHaveLength(1);
  service.stop();
});

test("an interrupted unaccepted request waits for fresh green and quiet admission", async () => {
  const h = scenario();
  const pending = { target: revision(TARGET), clientKey: "saved-key", at: new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString() };
  writeAuto(join(h.dir, "auto.json"), { ...initialAuto(), enabled: true, managedPending: pending });
  const service = h.service();
  await service.autoTick();
  expect(h.requests).toHaveLength(0);
  h.advance(60_000);
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.idempotencyKey).toBe(`self-update-${TARGET.slice(0, 12)}-saved-key`);
  service.stop();
});


test.each(["hot", "cold"] as const)("manual managed completion releases an unaccepted drain during %s recovery", async (recovery) => {
  const cold = recovery === "cold";
  const h = scenario();
  h.setTurns(1);
  let service = h.service();
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  let hostRevision = OLD;
  let answers = true;
  h.deps.hostHealth = async () => answers ? { pid: 102, startIdentity: "fixture", hostEpoch: 1, generation: { revision: hostRevision } } : null;
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  const auto = () => readAuto(join(h.dir, "auto.json"));
  try {
    await service.autoTick();
    const id = held()!.id;
    expect(await service.startUpdate("manual-update")).toEqual({ ok: true });
    expect(auto().managedPending).toBeNull();
    expect(auto().drain?.admitted).not.toBe(true);
    h.finish("succeeded");
    if (cold) {
      service.stop();
      h.advance(DRAIN_LEASE_MS + 1);
      service = h.service();
    }
    // Web promotion alone and an unavailable host cannot release custody.
    await service.snapshot();
    expect(held()?.id).toBe(id);
    // That observation saw the deployment finish, which starts a check and,
    // after it, a tick of its own. Let both finish before the host moves, so
    // the observations below are the ones this test makes.
    const background = service as unknown as { checking: unknown; autoRunning: boolean };
    for (let i = 0; i < 500 && (background.checking || background.autoRunning); i++) await Bun.sleep(1);
    hostRevision = TARGET;
    answers = false;
    await service.autoTick();
    expect(held()?.id).toBe(id);
    answers = true;
    h.setRelease(null);
    await service.snapshot();
    expect(held()?.id).toBe(id);
    h.setRelease(TARGET);
    await service.autoTick();
    expect(held()).toBeNull();
    expect(auto()).toMatchObject({ drain: null, waitingSince: null, waitingTarget: null, quietSince: null, lastBlockers: null });
    expect(ticks).toBe(1);
    // The manual deployment completed the target; no automatic duplicate follows.
    h.setTurns(0);
    h.advance(60_000);
    await service.autoTick();
    expect(h.requests).toHaveLength(1);
    expect(ticks).toBe(1);
  } finally { service.stop(); }
});

test.each(["before-tick", "mode-wait", "probe-unavailable"] as const)("managed frozen target admission checks fresh main ancestry at %s", async (seam) => {
  const h = scenario();
  const service = h.service();
  let allowed = true;
  let ancestryReads = 0;
  h.deps.targetOnBranch = async () => {
    ancestryReads++;
    if (seam === "probe-unavailable" && !allowed) throw new Error("remote unavailable");
    return allowed;
  };
  try {
    h.setTurns(1);
    await service.autoTick();
    const original = readAuto(join(h.dir, "auto.json")).drain!;
    h.setTurns(0);
    await service.autoTick();
    h.advance(60_000);
    if (seam === "mode-wait") h.setModeReadHook(async () => { allowed = false; });
    else allowed = false;
    await service.autoTick();
    expect(h.requests).toHaveLength(0);
    expect(ancestryReads).toBeGreaterThan(0);
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(original.id);
    expect(readAuto(join(h.dir, "auto.json")).managedPending).toBeNull();
    h.setModeReadHook(null);
    allowed = true;
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.revision).toBe(TARGET);
  } finally { service.stop(); }
});


test.each(["ancestor", "removed"] as const)("managed admission fetches real main ancestry for a frozen %s target", async (relation) => {
  const rewrite = relation === "removed";
  const h = scenario();
  const remote = join(h.dir, "remote.git");
  const work = join(h.dir, "work");
  const repo = join(h.dir, "check.git");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git(h.dir, "init", "--bare", "--initial-branch=main", remote);
  await git(h.dir, "init", "--initial-branch=main", work);
  await git(work, "commit", "--allow-empty", "-m", "Initial fixture");
  const base = await git(work, "rev-parse", "HEAD");
  await git(work, "commit", "--allow-empty", "-m", "Frozen fixture");
  const frozen = await git(work, "rev-parse", "HEAD");
  await git(work, "push", remote, "HEAD:refs/heads/main");
  await git(h.dir, "clone", "--bare", remote, repo);
  const stateFile = join(h.dir, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.slice.available = revision(frozen);
  writeFileSync(stateFile, JSON.stringify(state));
  h.deps.prepareCheckRepo = async () => repo;
  h.deps.targetOnBranch = async (checkout, target) => (await import("./git")).targetOnCurrentBranch(checkout, remote, "main", target);
  let service = h.service();
  try {
    h.setTurns(1);
    await service.autoTick();
    const id = readAuto(join(h.dir, "auto.json")).drain!.id;
    if (rewrite) await git(work, "checkout", "--detach", base);
    await git(work, "commit", "--allow-empty", "-m", "Fresh main fixture");
    const tip = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "--force", remote, "HEAD:refs/heads/main");
    expect((await runGit(["merge-base", "--is-ancestor", frozen, tip], work)).code).toBe(rewrite ? 1 : 0);
    // Cold recovery still sees old cached available evidence. Fresh ancestry must win.
    service.stop();
    service = h.service();
    h.setTurns(0);
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(h.requests).toHaveLength(rewrite ? 0 : 1);
    if (rewrite) {
      expect(readAuto(join(h.dir, "auto.json")).managedPending).toBeNull();
      expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(id);
      // Restoring main's ancestry admits the same frozen cohort exactly once.
      await git(work, "push", "--force", remote, `${frozen}:refs/heads/main`);
      await service.autoTick();
      h.advance(60_000);
      await service.autoTick();
    }
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.revision).toBe(frozen);
  } finally { service.stop(); }
});


test.each(["hot", "cold", "admitted-hot", "admitted-cold"] as const)("a successful manual newer target settles the frozen cohort during %s recovery", async (recovery) => {
  const h = scenario();
  const newer = "c".repeat(40);
  let service = h.service();
  let deployed = false;
  let hostRevision = OLD;
  let status: ViewerDeploymentStatus | null = null;
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  const automaticRequest = h.deps.requestDeployment;
  const automaticRead = h.deps.readDeployment;
  h.deps.hostHealth = async () => ({ pid: 102, startIdentity: "fixture", hostEpoch: 1, generation: { revision: hostRevision } });
  h.deps.check = async () => deployed
    ? { ok: true, installed: revision(newer), available: null, relation: "equal", ahead: 0, behind: 0, delta: null }
    : { ok: true, installed: revision(OLD), available: revision(newer), relation: "behind", ahead: 0, behind: 2, delta: null };
  h.deps.requestDeployment = async body => {
    if (body.revision === TARGET) return automaticRequest(body);
    h.requests.push(body);
    status = { deploymentId: "manual-newer", idempotencyKey: body.idempotencyKey, requestedRevision: newer, revision: newer,
      phase: "admitted", terminal: false, candidate: null, previous: null,
      mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
      owner: { pid: 102, startIdentity: null }, createdAt: new Date(h.deps.now()).toISOString(), updatedAt: new Date(h.deps.now()).toISOString(), revisionNumber: 1 };
    return { state: "accepted", deploymentId: "manual-newer", revision: newer, replayed: false };
  };
  h.deps.readDeployment = async id => id === "deployment-1" ? automaticRead(id) : status;
  try {
    h.setTurns(recovery.startsWith("admitted-") ? 0 : 1);
    await service.autoTick();
    const id = held()!.id;
    expect(held()!.target).toBe(TARGET);
    if (recovery.startsWith("admitted-")) {
      h.advance(60_000);
      await service.autoTick();
      h.setRelease(TARGET);
      h.finish("failed", "host promotion failed");
      await service.snapshot();
      expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: { target: { sha: TARGET } } });
      expect(held()?.id).toBe(id);
    }
    h.advance(1_000);
    await service.check();
    expect(await service.startUpdate("manual-newer")).toEqual({ ok: true });
    // Both processes can report the new revision before the deployment settles.
    h.setRelease(newer);
    hostRevision = newer;
    await service.snapshot();
    await service.autoTick();
    expect(held()?.id).toBe(id);
    expect(readManagedRecord(join(h.dir, "managed.json"))?.deploymentId).toBe("manual-newer");
    status = { ...status!, phase: "succeeded", terminal: true, revisionNumber: 2 };
    deployed = true;
    hostRevision = OLD;
    await service.refreshManaged();
    await service.check();
    if (recovery.endsWith("cold")) { service.stop(); service = h.service(); }
    expect((await service.snapshot()).check.state).toBe("up-to-date");
    expect(held()?.id).toBe(id); // Success alone cannot hide the old host.
    const settledCheck = h.deps.check;
    // Main can advance again while the newer manual release's host observation
    // lags. The frozen ancestor must not replace the operator's current receipt.
    h.deps.check = async () => ({ ok: true, installed: revision(newer), available: revision("d".repeat(40)), relation: "behind", ahead: 0, behind: 1, delta: null });
    h.setTurns(0);
    await service.check();
    await Bun.sleep(0); // Let the check's queued automatic tick finish before advancing its clock.
    await service.autoTick(); h.advance(60_000); await service.autoTick();
    expect(h.requests).toHaveLength(recovery.startsWith("admitted-") ? 2 : 1);
    expect(held()?.id).toBe(id);
    h.deps.check = settledCheck;
    await service.check();
    await service.autoTick();
    expect(readManagedRecord(join(h.dir, "managed.json"))?.deploymentId).toBe("manual-newer");
    hostRevision = newer;
    await service.snapshot();
    await service.autoTick();
    expect(held()).toBeNull();
    expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ drain: null, managedPending: null, waitingTarget: null, waitingSince: null });
    h.setTurns(0);
    await service.autoTick();
    expect(h.requests).toHaveLength(recovery.startsWith("admitted-") ? 2 : 1);
  } finally { service.stop(); }
});


test("a successful operator receipt predating the cohort cannot release its new drain", async () => {
  const h = scenario();
  const unrelated = "c".repeat(40);
  h.setRelease(unrelated);
  h.setTurns(1);
  writeManagedRecord(join(h.dir, "managed.json"), { deploymentId: "prior-manual", idempotencyKey: "prior-manual",
    trigger: "operator", target: unrelated, targetShort: unrelated.slice(0, 7), targetVersion: null,
    requestedAt: new Date(h.deps.now() - 60_000).toISOString(), observed: {}, lastStep: null,
    finishedAt: new Date(h.deps.now() - 30_000).toISOString(), phase: "succeeded", error: null, servingProgress: null });
  const service = h.service();
  try {
    await service.autoTick();
    const id = activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())!.id;
    const snapshot = await service.snapshot();
    expect(snapshot.serving.web?.sha).toBe(unrelated);
    expect(snapshot.serving.runtimeHost?.sha).toBe(unrelated);
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(id);
    expect(h.requests).toHaveLength(0);
  } finally { service.stop(); }
});

test("an update refusal names the live work in the operator's Ukrainian locale", () => {
  const blocker = { turns: 2, stages: 3, busy: false, operatorActiveAt: null, unreadable: null, memoryMb: null };
  try {
    expect(updateOperatorSettings({ locale: "uk" })).not.toBeNull();
    expect(launchHoldRefusal({ target: TARGET, since: "2026-01-01T00:00:00Z" }, blocker)).toMatchObject({
      error: "Нові запуски призупинено: автоматичне оновлення чекає на завершення 2 активних ходів і 3 етапів пайплайнів",
      waitingFor: "завершення 2 активних ходів і 3 етапів пайплайнів", blockers: blocker,
    });
  } finally { updateOperatorSettings({ locale: "en" }); }
});
