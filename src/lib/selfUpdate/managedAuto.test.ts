import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
import type { ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { initialAuto, readAuto, writeAuto } from "./auto";
import { initialCheck } from "./checkState";
import { readManagedRecord, writeManagedRecord, type ManagedRecord } from "./managed";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { idleCheck, type Revision } from "./types";

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
  let green: "green" | "red" = "green";
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
    hostHealth: async () => ({ pid: 102, generation: { revision: release ?? OLD } }),
    web: { pid: 101, port: 3000, startedAt: new Date(now).toISOString() },
    green: { read: async () => { greenReads += 1; return { state: green }; } },
    quiet: { runtimeSnapshot: async () => ({ sessions: Array.from({ length: turns }, () => ({ turn: "running", host: "hosted" })) }),
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
    setGreen: (value: "green" | "red") => { green = value; }, greenReads: () => greenReads,
    setRemote: (value: string) => { remote = value; }, setRelease: (value: string | null) => { release = value; },
    setModeReadHook: (hook: ((read: number) => Promise<void>) | null) => { modeReadHook = hook; },
    finish: (phase: "succeeded" | "rolled-back" | "failed", error: string | null = null) => {
      if (!status) throw new Error("deployment was not requested");
      status = { ...status, phase, terminal: true, error, updatedAt: new Date(now).toISOString(), revisionNumber: status.revisionNumber + 1 };
      if (phase === "succeeded") release = TARGET;
    },
  };
}

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
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: true, managedPending: null, off: null, waitingSince: null });
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  service.stop();
});

test("a saved failure settles after restart even while the host cannot answer", async () => {
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
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
    off: { target: TARGET, reason: "promotion failed" } });
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
