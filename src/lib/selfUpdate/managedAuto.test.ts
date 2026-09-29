import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { initialAuto, readAuto, writeAuto } from "./auto";
import { initialCheck } from "./checkState";
import { readManagedRecord, writeManagedRecord } from "./managed";
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
  let green: "green" | "red" = "green";
  let greenReads = 0;
  let status: ViewerDeploymentStatus | null = null;
  const requests: ViewerDeploymentRequest[] = [];
  writeAuto(join(dir, "auto.json"), { ...initialAuto(), enabled });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ slice: {
    ...initialCheck(), installed: revision(OLD), available: revision(TARGET),
    check: { ...idleCheck(), state: "update-available", relation: "behind", at: new Date(now).toISOString() },
  }, update: null }));
  const deps = {
    dir, now: () => now, env: {}, get remote() { return remote; }, branch: "main", pollMinutes: 60, bun: "bun",
    mode: async () => ({ mode: "managed", reason: null, record: null }),
    check: async () => ({ ok: true, installed: revision(OLD), available: revision(TARGET), relation: "behind", ahead: 0, behind: 1, delta: null }),
    describe: async (_repo: string, sha: string) => revision(sha),
    releaseTarget: () => release ? { revision: release } : null,
    prepareCheckRepo: async () => dir,
    hostHealth: async () => ({ pid: 102, generation: { revision: release ?? OLD } }),
    web: { pid: 101, port: 3000, startedAt: new Date(now).toISOString() },
    green: { read: async () => { greenReads += 1; return { state: green }; } },
    quiet: { runtimeSnapshot: async () => ({ sessions: Array.from({ length: turns }, () => ({ turn: "running", host: "hosted" })) }),
      pipelines: () => [], presence: () => [], memoryAvailableMb: () => 8_192 },
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
  } as unknown as ServiceDeps;
  return {
    dir, deps, requests, service: () => new SelfUpdateService(deps),
    advance: (ms: number) => { now += ms; }, setTurns: (value: number) => { turns = value; },
    setGreen: (value: "green" | "red") => { green = value; }, greenReads: () => greenReads,
    setRemote: (value: string) => { remote = value; }, setRelease: (value: string | null) => { release = value; },
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

test("an interrupted request replays its persisted idempotency key", async () => {
  const h = scenario();
  const pending = { target: revision(TARGET), clientKey: "saved-key", at: new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString() };
  writeAuto(join(h.dir, "auto.json"), { ...initialAuto(), enabled: true, managedPending: pending });
  const service = h.service();
  await service.autoTick();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.idempotencyKey).toBe(`self-update-${TARGET.slice(0, 12)}-saved-key`);
  service.stop();
});
