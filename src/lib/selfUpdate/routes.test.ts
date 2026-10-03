import { POST as deployPost } from "@/app/api/runtime/deployments/route";
import { ledgerDeployment } from "@/lib/runtime/deploymentLedger";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { ViewerDeploymentPhase, ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { requestViewerDeployment, setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";

import { watchRestartRequests } from "../../../bin/self-update-supervisor.mjs";
import { installAction, runInstallAction } from "./actions";
import { initialAuto, writeAuto } from "./auto";
import type { GreenReader, GreenVerdict } from "./green";
import { buildEnv } from "./env";
import { checkForUpdate, readRevision, runGit } from "./git";
import { readLauncherRecord, requestRestart } from "./launcher";
import { deploymentsEnabled, detectMode } from "./mode";
import { readStartIdentity, sameProcess } from "./pid";
import { getEvents, getSnapshot, getStepLog, postAuto, postCheck, postRestart, postUpdate, postInstallAction } from "./routes";
import { prepareManagedCheckRepo, setSelfUpdateServiceForTests } from "./instance";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { UpdateRunner, type StepPorts } from "./steps";
import { idleUpdate, type Snapshot } from "./types";
import { initialCheck } from "./checkState";
import type { LauncherRecord } from "./launcher";

/*
 * #2007: the Update surface's routes in both install modes, end to end
 * through the service. Nothing reaches a real runtime host or a real build:
 *
 * - managed: the deployment request goes through the real door
 *   (`requestViewerDeployment`) with its runtime stubbed, and the deployment
 *   reads are scripted phase by phase;
 * - checkout: a local bare repository is the remote, the git steps are real,
 *   `bun install` and `bun run build` are stubbed, and the launcher is played
 *   by the launcher's own request watcher.
 */

const root = mkdtempSync("/var/tmp/self-update-routes-");
const remote = join(root, "remote.git");
const work = join(root, "work");
const checkout = join(root, "checkout");
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
let firstSha = "";
let tipSha = "";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit([...identity, ...args], cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(async () => {
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(root, "init", "--initial-branch=main", work);
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ version: "1.0.0" })}\n`);
  writeFileSync(join(work, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] — 2026-09-01\n\n### Added\n\n- First release (#1)\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "Initial release");
  firstSha = await git(work, "rev-parse", "HEAD");
  await git(work, "remote", "add", "origin", remote);
  await git(work, "push", "origin", "main");
  await git(root, "clone", remote, checkout);
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ version: "1.0.1" })}\n`);
  writeFileSync(join(work, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- The header says what runs (#7)\n\n## [1.0.0] — 2026-09-01\n\n### Added\n\n- First release (#1)\n");
  await git(work, "commit", "-am", "Say what runs");
  await git(work, "push", "origin", "main");
  tipSha = await git(work, "rev-parse", "HEAD");
});

afterEach(() => {
  setSelfUpdateServiceForTests(null);
  setDeploymentRuntimeForTests(null);
  setCallerConversationResolverForTests(null);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE = "http://127.0.0.1:3000/api/self-update";
const browser = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const post = (path: string, body?: unknown, headers: Record<string, string> = browser) =>
  new NextRequest(`${BASE}${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

async function snapshot(headers: Record<string, string> = browser): Promise<Snapshot> {
  return (await getSnapshot(new Request(BASE, { headers }))).json() as Promise<Snapshot>;
}

async function until(predicate: (s: Snapshot) => boolean, timeoutMs = 10_000): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: Snapshot | null = null;
  while (Date.now() < deadline) {
    last = await snapshot();
    if (predicate(last)) return last;
    await Bun.sleep(20);
  }
  throw new Error(`timed out: ${JSON.stringify({ check: last?.check.state, update: last?.update.state, busy: last?.busy })}`);
}

function baseDeps(dir: string, overrides: Partial<ServiceDeps>): ServiceDeps {
  return {
    now: () => Date.now(),
    env: {},
    dir,
    remote,
    branch: "main",
    pollMinutes: 60,
    bun: "/opt/bun",
    mode: async () => ({ mode: "unsupported", reason: "no-launcher", record: null }),
    check: checkForUpdate,
    describe: readRevision,
    createRunner: () => { throw new Error("no runner in this mode"); },
    requestRestart,
    processAlive: () => true,
    hostHealth: async () => null,
    requestDeployment: requestViewerDeployment,
    readDeployment: async () => null,
    findDeploymentByIdempotencyKey: async () => null,
    releaseTarget: () => null,
    prepareCheckRepo: async () => { throw new Error("no check repository in this mode"); },
    buildEnv,
    web: { pid: process.pid, port: 3000, startedAt: new Date().toISOString() },
    ...overrides,
  };
}

test("operator drain replies reach the same service and reject stale identities", async () => {
  const dir = mkdtempSync(join(root, "drain-decision-"));
  const target = { sha: tipSha, short: tipSha.slice(0, 7), version: "1", date: "" };
  const at = new Date().toISOString();
  writeAuto(join(dir, "auto.json"), { ...initialAuto(), enabled: true,
    drain: { id: "drain-current", target, since: at, overranAt: at, blockers: null } });
  const service = new SelfUpdateService(baseDeps(dir, {}));
  setSelfUpdateServiceForTests(service);
  try {
    expect((await postAuto(post("/auto", { decisionId: "drain-stale", choice: "keep-waiting" }))).status).toBe(409);
    expect((await postAuto(post("/auto", { decisionId: "drain-current", choice: "keep-waiting" }))).status).toBe(202);
    const saved = JSON.parse(readFileSync(join(dir, "auto.json"), "utf8"));
    expect(saved.drain).toMatchObject({ id: "drain-current", acknowledgedAt: expect.any(String), force: false });
    expect((await postAuto(post("/auto", { decisionId: "drain-current", choice: "deploy-now" }))).status).toBe(409);
  } finally { service.stop(); }
});

describe("the operator gate", () => {
  test("an agent presenting its capability is refused every mutating route, and nothing is asked of the host", async () => {
    const requests: ViewerDeploymentRequest[] = [];
    setDeploymentRuntimeForTests(async (request) => { requests.push(request); return { state: "accepted", deploymentId: "d", revision: tipSha, replayed: false }; });
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(mkdtempSync(join(root, "gate-")), { mode: async () => ({ mode: "managed", reason: null, record: null }) })));
    setCallerConversationResolverForTests(() => "conversation_some_worker");
    const agent = { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) };
    for (const response of [
      await postInstallAction(post("/action", undefined, agent)),
      await postCheck(post("/check", undefined, agent)),
      await postUpdate(post("/update", { key: "press-1" }, agent)),
      await postRestart(post("/restart", { role: "runtime-host", confirm: true }, agent)),
      await postAuto(post("/auto", { enabled: true }, agent)),
      await postAuto(post("/auto", { decisionId: "drain", choice: "deploy-now" }, agent)),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(requests).toEqual([]);
  });

  test("only the operator's opening of the surface starts a check", async () => {
    const dir = mkdtempSync(join(root, "gate-open-"));
    const checks: string[] = [];
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(dir, {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      check: async (input) => { checks.push(input.repo); return { ok: false, error: "fixture", installed: null }; },
      releaseTarget: () => ({ revision: firstSha }),
      prepareCheckRepo: async () => join(dir, "check.git"),
    })));
    setCallerConversationResolverForTests(() => "conversation_some_worker");
    const agent = { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) };
    expect((await (await getSnapshot(new Request(`${BASE}?readOnly=1`, { headers: browser }))).json()).check.state).toBe("idle");
    expect(checks).toEqual([]);
    expect((await snapshot(agent)).check.state).toBe("idle");
    expect((await snapshot({ ...browser, origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" })).check.state).toBe("idle");
    await Bun.sleep(50);
    expect(checks).toEqual([]);
    setCallerConversationResolverForTests(null);
    await snapshot();
    await until((next) => next.check.state === "failed");
    expect(checks).toHaveLength(1);
  });

  test("a cross-origin page is refused before anything is read", async () => {
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(mkdtempSync(join(root, "gate-")), {})));
    const foreign = { ...browser, origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" };
    expect((await postUpdate(post("/update", { key: "press-1" }, foreign))).status).toBe(403);
    expect((await postRestart(post("/restart", { role: "web" }, foreign))).status).toBe(403);
    expect((await postAuto(post("/auto", { enabled: true }, foreign))).status).toBe(403);
  });
});

describe("managed install: an update is one Viewer deployment", () => {
  let phase: ViewerDeploymentPhase | null = null;
  let error: string | null = null;
  let requests: ViewerDeploymentRequest[] = [];
  let hostRevision = firstSha;

  function status(id: string): ViewerDeploymentStatus | null {
    if (!phase) return null;
    return {
      deploymentId: id, idempotencyKey: "k", requestedRevision: tipSha, revision: tipSha, phase,
      terminal: phase === "succeeded" || phase === "rolled-back" || phase === "failed",
      candidate: null, previous: null, mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
      health: [], error, owner: { pid: 1, startIdentity: null },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revisionNumber: 1,
    };
  }

  function managedService(): SelfUpdateService {
    const dir = mkdtempSync(join(root, "managed-"));
    phase = null;
    error = null;
    requests = [];
    hostRevision = firstSha;
    let deployments = 0;
    setDeploymentRuntimeForTests(async (request) => {
      requests.push(request);
      deployments += 1;
      phase = "admitted";
      return { state: "accepted", deploymentId: `deployment-${deployments}`, revision: request.revision!, replayed: false };
    });
    return new SelfUpdateService(baseDeps(dir, {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      releaseTarget: () => ({ revision: firstSha }),
      prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "no-mirror", "objects")),
      readDeployment: async (id) => status(id),
      hostHealth: async () => ({ pid: 4242, startIdentity: "1", hostEpoch: 3, generation: { revision: hostRevision } }),
    }));
  }

  test("check, deploy the exact revision, follow the phases to success", async () => {
    const service = managedService();
    setSelfUpdateServiceForTests(service);
    expect((await postCheck(post("/check"))).status).toBe(202);
    let s = await until((next) => next.check.state === "update-available");
    expect(s.mode).toBe("managed");
    expect(s.installed.sha).toBe(firstSha);
    expect(s.available?.sha).toBe(tipSha);
    expect(s.check.delta?.summary.groups).toEqual([{ type: "Fixed", items: ["The header says what runs (#7)"], more: 0 }]);
    expect(s.processes.runtimeHost).toMatchObject({ state: "healthy", pid: 4242, revision: firstSha.slice(0, 7) });

    const managedRestart = await postRestart(post("/restart", { role: "web" }));
    expect(managedRestart.status).toBe(409);
    expect(((await managedRestart.json()) as { code: string }).code).toBe("managed-restart");
    const badKey = await postUpdate(post("/update", { key: "a b" }));
    expect(badKey.status).toBe(400);
    expect(((await badKey.json()) as { code: string }).code).toBe("bad-key");
    const accepted = await postUpdate(post("/update", { key: "press-1" }));
    expect(accepted.status).toBe(202);
    expect(requests).toEqual([{ revision: tipSha, idempotencyKey: `self-update-${tipSha.slice(0, 12)}-press-1` }]);
    s = await snapshot();
    expect(s.busy).toBe("update");
    expect(s.update).toMatchObject({ state: "running", target: tipSha, deploymentId: "deployment-1" });

    /* One deployment at a time; the refusal is a code the surface words. */
    const second = await postUpdate(post("/update", { key: "press-2" }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("busy-update");
    expect(requests).toHaveLength(1);

    phase = "building";
    s = await snapshot();
    expect(s.update.steps.map((step) => step.state)).toEqual(["done", "running", "pending", "pending", "pending", "pending"]);
    phase = "promoting";
    s = await snapshot();
    expect(s.processes.web.state).toBe("starting");
    phase = "host-handoff";
    s = await snapshot();
    expect(s.processes.web.state).toBe("healthy");
    expect(s.processes.runtimeHost.state).toBe("starting");
    phase = "succeeded";
    hostRevision = tipSha;
    s = await snapshot();
    expect(s.update.state).toBe("done");
    expect(s.busy).toBeNull();
    expect(s.update.steps.every((step) => step.state === "done")).toBe(true);
  });

  test("a rolled-back deployment is retried as a new deployment of the same revision", async () => {
    const service = managedService();
    setSelfUpdateServiceForTests(service);
    await postCheck(post("/check"));
    await until((next) => next.check.state === "update-available");
    await postUpdate(post("/update", { key: "press-1" }));
    phase = "candidate-health";
    await snapshot();
    phase = "rolled-back";
    error = "candidate health gate failed";
    const s = await snapshot();
    expect(s.update).toMatchObject({ state: "failed", rolledBack: true });
    expect(s.update.steps.find((step) => step.state === "failed")?.name).toBe("health");
    expect((await postUpdate(post("/update", { key: "press-2", retry: true }))).status).toBe(202);
    expect(requests.map((request) => request.idempotencyKey)).toEqual([
      `self-update-${tipSha.slice(0, 12)}-press-1`,
      `self-update-${tipSha.slice(0, 12)}-press-2`,
    ]);
    expect(requests[1]!.revision).toBe(tipSha);
  });

  test("a host that stops answering during its own handover leaves the install managed, in this web process and the next", async () => {
    const dir = mkdtempSync(join(root, "managed-handover-"));
    let clock = Date.now();
    let hostAnswers = true;
    phase = null;
    error = null;
    const away = () => { throw new Error("connect ENOENT runtime-host.sock"); };
    setDeploymentRuntimeForTests(async (request) => { phase = "admitted"; return { state: "accepted", deploymentId: "deployment-7", revision: request.revision!, replayed: false }; });
    const deps = baseDeps(dir, {
      now: () => clock,
      /* Detection goes through the real probe: the host's own answer to a
         deployment that cannot exist, or a socket error while it is away. */
      mode: () => detectMode({
        env: {},
        readRecord: () => null,
        alive: () => false,
        deploymentsEnabled: () => deploymentsEnabled({ readViewerDeployment: async () => (hostAnswers ? null : away()) } as unknown as RuntimeHostClient),
      }),
      releaseTarget: () => ({ revision: firstSha }),
      prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "no-mirror", "objects")),
      readDeployment: async (id) => (hostAnswers ? status(id) : away()),
      hostHealth: async () => (hostAnswers ? { pid: 4242, startIdentity: "1", hostEpoch: 3, generation: { revision: firstSha } } : away()),
    });
    const service = new SelfUpdateService(deps);
    setSelfUpdateServiceForTests(service);
    await postCheck(post("/check"));
    await until((next) => next.check.state === "update-available");
    await postUpdate(post("/update", { key: "press-1" }));
    phase = "host-handoff";
    expect((await snapshot()).update.steps.find((step) => step.state === "running")?.name).toBe("handoff");

    /* The host is being replaced, and the cached decision has run out. */
    hostAnswers = false;
    clock += 31_000;
    let s = await snapshot();
    expect(s.mode).toBe("managed");
    expect(s.busy).toBe("update");
    expect(s.update).toMatchObject({ state: "running", deploymentId: "deployment-7" });
    expect(s.processes.runtimeHost.state).toBe("starting");

    /* A web process promoted by the same deployment asks first while the host is away. */
    service.saveNow();
    setSelfUpdateServiceForTests(new SelfUpdateService(deps));
    s = await snapshot();
    expect(s.mode).toBe("managed");
    expect(s.update).toMatchObject({ state: "running", deploymentId: "deployment-7" });

    hostAnswers = true;
    phase = "succeeded";
    s = await snapshot();
    expect(s.mode).toBe("managed");
    expect(s.update.state).toBe("done");
  });

  test("a revision the check repository cannot describe yet is not asked about on every snapshot", async () => {
    const dir = mkdtempSync(join(root, "managed-describe-"));
    let clock = Date.now();
    const asked: string[] = [];
    let ready = false;
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(dir, {
      now: () => clock,
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      releaseTarget: () => ({ revision: firstSha }),
      prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "no-mirror", "objects")),
      describe: async (repo, sha) => {
        asked.push(sha);
        if (!ready) throw new Error("fatal: bad object");
        return readRevision(checkout, sha);
      },
      check: async () => ({ ok: false, error: "fixture", installed: null }),
      hostHealth: async () => ({ pid: 4242, startIdentity: "1", hostEpoch: 3 }),
    })));
    /* Read by an agent, which starts no check (a finished check clears the hold). */
    setCallerConversationResolverForTests(() => "conversation_some_worker");
    const other = { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) };
    for (let index = 0; index < 5; index += 1) await snapshot(other);
    expect(asked).toEqual([firstSha]);
    /* Held for a while, then asked again. */
    clock += 31_000;
    await snapshot(other);
    expect(asked).toHaveLength(2);
    /* A finished check may have brought the objects: it clears the hold. */
    setCallerConversationResolverForTests(null);
    ready = true;
    await postCheck(post("/check"));
    const s = await until((next) => next.check.state === "failed");
    expect(asked).toHaveLength(3);
    expect(s.installed.version).toBe("1.0.0");
  });

  test("a recorded deployment the host no longer knows stops blocking the next update", async () => {
    const dir = mkdtempSync(join(root, "managed-lost-"));
    let clock = Date.now();
    let known = true;
    phase = null;
    setDeploymentRuntimeForTests(async (request) => { phase = "building"; return { state: "accepted", deploymentId: `deployment-${clock}`, revision: request.revision!, replayed: false }; });
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(dir, {
      now: () => clock,
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      releaseTarget: () => ({ revision: firstSha }),
      prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "no-mirror", "objects")),
      /* The host answers; after its journal was reset it knows no such deployment. */
      readDeployment: async (id) => (known ? status(id) : null),
      hostHealth: async () => ({ pid: 4242, startIdentity: "1", hostEpoch: 3 }),
    })));
    await postCheck(post("/check"));
    await until((next) => next.check.state === "update-available");
    await postUpdate(post("/update", { key: "press-1" }));
    expect((await snapshot()).busy).toBe("update");
    known = false;
    await snapshot();
    clock += 60_000;
    expect((await snapshot()).busy).toBe("update");
    clock += 61_000;
    const s = await snapshot();
    expect(s.busy).toBeNull();
    expect(s.update.state).toBe("failed");
    expect(s.update.steps.find((step) => step.state === "failed")?.failure).toEqual({ kind: "deployment-lost" });
    known = true;
    expect((await postUpdate(post("/update", { key: "press-2", retry: true }))).status).toBe(202);
  });

  test("a deployment is followed while nobody has the surface open", async () => {
    const service = managedService();
    setSelfUpdateServiceForTests(service);
    await postCheck(post("/check"));
    await until((next) => next.check.state === "update-available");
    await postUpdate(post("/update", { key: "press-1" }));
    /* No snapshot is read from here until the end: only the service's own watch. */
    phase = "candidate-health";
    await Bun.sleep(1_500);
    phase = "rolled-back";
    error = "candidate health gate failed";
    await Bun.sleep(1_500);
    const s = await snapshot();
    expect(s.update).toMatchObject({ state: "failed", rolledBack: true });
    expect(s.update.steps.find((step) => step.state === "failed")?.name).toBe("health");
  });

  test("the check repository survives being prepared by several requests at once", async () => {
    const dir = mkdtempSync(join(root, "managed-race-"));
    const results = await Promise.all(Array.from({ length: 6 }, () => prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "no-mirror", "objects"))));
    expect(new Set(results).size).toBe(1);
    expect(existsSync(join(dir, "check.git", "HEAD"))).toBe(true);
    expect((await runGit(["rev-parse", "--is-bare-repository"], join(dir, "check.git"))).stdout.trim()).toBe("true");
  });

  test("a release target that cannot be read fails the check with a code, and no sentence of ours", async () => {
    const dir = mkdtempSync(join(root, "managed-no-target-"));
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(dir, {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      releaseTarget: () => null,
      prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "no-mirror", "objects")),
    })));
    await postCheck(post("/check"));
    const s = await until((next) => next.check.state === "failed");
    expect(s.check).toMatchObject({ errorCode: "no-release-target", error: null });
  });

  test("the deployment outlives the web process that asked for it", async () => {
    const dir = mkdtempSync(join(root, "managed-restart-"));
    phase = null;
    setDeploymentRuntimeForTests(async (request) => { phase = "building"; return { state: "accepted", deploymentId: "deployment-9", revision: request.revision!, replayed: false }; });
    const deps = baseDeps(dir, {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      releaseTarget: () => ({ revision: firstSha }),
      prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "no-mirror", "objects")),
      readDeployment: async (id) => status(id),
      hostHealth: async () => ({ pid: 4242, startIdentity: "1", hostEpoch: 3 }),
    });
    const first = new SelfUpdateService(deps);
    setSelfUpdateServiceForTests(first);
    await postCheck(post("/check"));
    await until((next) => next.check.state === "update-available");
    await postUpdate(post("/update", { key: "press-1" }));
    await snapshot();
    first.saveNow();
    /* The promoted web process is a new one: it reads what the old one wrote. */
    setSelfUpdateServiceForTests(new SelfUpdateService(deps));
    phase = "post-promotion-health";
    const s = await snapshot();
    expect(s.update).toMatchObject({ state: "running", deploymentId: "deployment-9", target: tipSha });
    expect(s.update.steps.find((step) => step.state === "running")?.name).toBe("promote");
    expect(s.available?.sha).toBe(tipSha);
  });
});

describe("checkout install: a staged build and restarts by the launcher", () => {
  interface Harness { service: SelfUpdateService; deps: ServiceDeps; recordFile: string; spawned: string[][]; releaseBuild: (() => void) | null }

  function harness(options: { holdBuild?: boolean; remote?: string } = {}): Harness {
    const dir = mkdtempSync(join(root, "checkout-"));
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const recordFile = join(state, "launcher.json");
    const pid = process.pid;
    const startIdentity = readStartIdentity(pid)!;
    const entry = (revision: string) => ({ state: "healthy", pid, startIdentity, startedAt: new Date().toISOString(), revision, error: null, requestId: null });
    writeFileSync(recordFile, JSON.stringify({
      version: 1,
      launcher: { pid, startIdentity, autoAdmission: 1 },
      checkout,
      releasesDir: join(dir, "releases"),
      releasePointer: join(state, "release.json"),
      requestFile: join(state, "request.json"),
      port: 3000,
      socket: join(state, "runtime-host.sock"),
      web: entry(firstSha.slice(0, 7)),
      runtimeHost: entry(firstSha.slice(0, 7)),
      updatedAt: new Date().toISOString(),
    }));
    const spawned: string[][] = [];
    const h: Harness = { service: null as unknown as SelfUpdateService, deps: null as unknown as ServiceDeps, recordFile, spawned, releaseBuild: null };
    /* The stubbed spawn: git runs for real against the fixture; install and
       build only say so, and the build leaves the BUILD_ID a real one would. */
    const run: StepPorts["run"] = async (command, { cwd, onLine }) => {
      spawned.push(command);
      if (command[0] === "git") {
        const result = await runGit(command.slice(1), cwd);
        for (const line of `${result.stdout}${result.stderr}`.split("\n").filter(Boolean)) onLine(line);
        return result.code;
      }
      if (command.includes("build")) {
        if (options.holdBuild) await new Promise<void>((resolve) => { h.releaseBuild = resolve; });
        mkdirSync(join(cwd, ".next"), { recursive: true });
        writeFileSync(join(cwd, ".next", "BUILD_ID"), "fixture\n");
      }
      onLine(`${command.slice(1).join(" ")} ok`);
      return 0;
    };
    h.deps = baseDeps(join(dir, "self-update"), {
      remote: options.remote ?? remote,
      env: { LLV_SELF_UPDATE_RECORD: recordFile },
      mode: () => detectMode({ env: { LLV_SELF_UPDATE_RECORD: recordFile }, readRecord: readLauncherRecord, alive: () => true, deploymentsEnabled: async () => false }),
      createRunner: (config, publish, onChange) => new UpdateRunner(config, {
        run,
        memAvailableMb: () => 8_192,
        revParse: async (ref, cwd) => (await runGit(["rev-parse", "--verify", "--quiet", ref], cwd)).stdout.trim(),
        exists: (path) => existsSync(path),
        buildIdReadable: (path) => existsSync(join(path, ".next", "BUILD_ID")),
        publish,
        now: () => Date.now(),
      }, onChange),
      hostHealth: async () => ({ pid, startIdentity, hostEpoch: 1 }),
      processAlive: (candidate, identity) => sameProcess({ pid: candidate, startIdentity: identity }),
    });
    h.service = new SelfUpdateService(h.deps);
    return h;
  }

  test("real launcher and runtime-host identity readers settle a healthy apply", async () => {
    const { procBackend } = await import("@/lib/proc");
    const { ApplyController } = await import("./apply");
    const h = harness();
    const record = JSON.parse(readFileSync(h.recordFile, "utf8")) as LauncherRecord;
    const controller = new ApplyController(h.deps.dir);
    controller.begin(record, firstSha, "operator");
    controller.patch({ state: "switching" });
    record.launcher = { ...record.launcher, relaunch: 1, state: "healthy", revision: firstSha, requestId: controller.current!.requestId };
    writeFileSync(h.recordFile, JSON.stringify(record));
    h.deps.hostHealth = async () => ({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid)!, hostEpoch: 1 });
    h.service.stop(); h.service = new SelfUpdateService(h.deps);
    try {
      const healthy = await h.service.snapshot();
      expect(healthy.processes.runtimeHost.state).toBe("healthy");
      expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8")).state).toBe("done");
      h.deps.hostHealth = async () => ({ pid: process.pid, startIdentity: `${process.pid}:reused`, hostEpoch: 1 });
      expect((await h.service.snapshot()).processes.runtimeHost.state).toBe("failed");
    } finally { h.service.stop(); }
  });

  test("a checkout exact deploy is idempotent, applies once and settles its seat receipt", async () => {
    const h = harness();
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const body = { revision: tipSha, idempotencyKey: "checkout-exact-press" };
    const response = await deployPost(post("/runtime/deployments", body));
    expect(response.status).toBe(202);
    const receipt = await response.json();
    const deploymentId = receipt.deploymentId;
    expect(deploymentId).toMatch(/^checkout-/);
    expect(receipt).toMatchObject({ state: "accepted", revision: tipSha });
    const replay = await deployPost(post("/runtime/deployments", body));
    expect(await replay.json()).toMatchObject({ deploymentId: receipt.deploymentId, replayed: true });
    await until(next => next.update.steps.some(step => step.name === "switch" && step.state === "running"));
    const request = JSON.parse(readFileSync(record.requestFile, "utf8"));
    expect(request).toMatchObject({ role: "relaunch", target: tipSha, rollbackPointer: null });
    const moved = JSON.parse(readFileSync(h.recordFile, "utf8"));
    moved.launcher = { ...moved.launcher, requestId: request.requestId, state: "healthy", error: null };
    moved.web.revision = moved.runtimeHost.revision = tipSha.slice(0, 7);
    writeFileSync(h.recordFile, JSON.stringify(moved));
    h.service.saveNow(); setSelfUpdateServiceForTests(new SelfUpdateService(h.deps));
    expect((await snapshot()).update).toMatchObject({ state: "done", rolledBack: false });
    const ledger = ledgerDeployment(deploymentId, { NODE_ENV: "test", LLV_STATE_DIR: h.deps.dir.replace(/self-update$/, "") });
    expect(ledger).toMatchObject({ state: "ok", value: { phase: "succeeded", terminal: true } });
  });

  test("Retry after a verified rollback rebuilds and sends another complete apply", async () => {
    const h = harness();
    const record = JSON.parse(readFileSync(h.recordFile, "utf8")); record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check")); await until(next => next.check.state === "update-available");
    expect((await postUpdate(post("/update", { key: "apply-rollback" }))).status).toBe(202);
    await until(next => next.update.steps.some(step => step.name === "switch" && step.state === "running"));
    const request = JSON.parse(readFileSync(record.requestFile, "utf8")); rmSync(record.requestFile);
    record.launcher = { ...record.launcher, requestId: request.requestId, state: "healthy", error: { kind: "fell-back", revision: tipSha.slice(0, 7), detail: "candidate health failed" } };
    writeFileSync(h.recordFile, JSON.stringify(record)); rmSync(record.releasePointer, { force: true });
    await until(next => next.update.state === "failed");
    expect((await postUpdate(post("/update", { key: "retry-rollback", retry: true }))).status).toBe(202);
    await until(next => next.update.steps.some(step => step.name === "switch" && step.state === "running"));
    expect(JSON.parse(readFileSync(record.requestFile, "utf8"))).toMatchObject({ role: "relaunch", target: tipSha });
  });

  test("an exact deploy of the healthy serving revision settles without restarting it", async () => {
    const h = harness({ holdBuild: true }); const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    record.launcher = { ...record.launcher, relaunch: 1, revision: firstSha, state: "healthy" };
    writeFileSync(h.recordFile, JSON.stringify(record));
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const response = await deployPost(post("/runtime/deployments", { revision: firstSha, idempotencyKey: "already-serving" }));
    expect(response.status).toBe(202);
    expect(JSON.parse(readFileSync(join(h.deps.dir, "deployments.json"), "utf8"))[0]).toMatchObject({ phase: "succeeded", terminal: true });
    expect(existsSync(join(h.deps.dir, "apply.json"))).toBe(false); expect(existsSync(record.requestFile)).toBe(false);
  });

  test.each(["missing", "done"] as const)("cold exact deployment reconciles a receipt with %s apply persistence", async completion => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8")); record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    const at = new Date().toISOString();
    const row = { deploymentId: "checkout-orphan", idempotencyKey: "crashed-before-apply", requestedRevision: tipSha, revision: tipSha,
      phase: "admitted", terminal: false, candidate: null, previous: null, mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
      health: [], error: null, owner: { pid: record.launcher.pid, startIdentity: record.launcher.startIdentity }, createdAt: at, updatedAt: at, revisionNumber: 1 };
    mkdirSync(h.deps.dir, { recursive: true });
    writeFileSync(join(h.deps.dir, "deployments.json"), JSON.stringify([row]));
    if (completion === "done") writeFileSync(join(h.deps.dir, "apply.json"), JSON.stringify({
      requestId: "completed-before-ledger", target: tipSha, rollbackPointer: null, launcherPid: record.launcher.pid,
      launcherIdentity: record.launcher.startIdentity, trigger: "seat", deploymentId: row.deploymentId, startedAt: at, state: "done", rolledBack: false,
    }));
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    expect(JSON.parse(readFileSync(join(h.deps.dir, "deployments.json"), "utf8"))[0]).toMatchObject({ phase: completion === "done" ? "succeeded" : "failed", terminal: true });
    expect((await deployPost(post("/runtime/deployments", { revision: tipSha, idempotencyKey: "crashed-before-apply" }))).status).toBe(202);
    expect((await deployPost(post("/runtime/deployments", { revision: tipSha, idempotencyKey: "after-crash" }))).status).toBe(202);
    await until(next => next.update.steps.some(step => step.name === "switch" && step.state === "running"));
  });

  test("cold ready checkpoint resumes one launcher request", async () => {
    const h = harness(); const r = JSON.parse(readFileSync(h.recordFile, "utf8")); r.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(r));
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check")); await until(next => next.check.state === "update-available");
    await postUpdate(post("/update", { key: "before-cold" }));
    await until(next => next.update.steps.some(step => step.name === "switch" && step.state === "running"));
    h.service.saveNow();
    const file = join(h.deps.dir, "apply.json"); const intent = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...intent, state: "ready" })); rmSync(r.requestFile);
    h.service.stop(); setSelfUpdateServiceForTests(new SelfUpdateService(h.deps));
    expect((await snapshot()).busy).toBe("update");
    expect(JSON.parse(readFileSync(r.requestFile, "utf8"))).toMatchObject({ requestId: intent.requestId, role: "relaunch", target: tipSha });
  });

  test("a dialog apply admitted during exact green lookup leaves no orphan receipt", async () => {
    const h = harness({ holdBuild: true }); const r = JSON.parse(readFileSync(h.recordFile, "utf8")); r.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(r));
    let releaseGreen!: (value: GreenVerdict) => void; let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    h.deps.green = { read: () => { entered(); return new Promise<GreenVerdict>(resolve => { releaseGreen = resolve; }); } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check")); await until(next => next.check.state === "update-available");
    const exact = deployPost(post("/runtime/deployments", { revision: tipSha, idempotencyKey: "seat-concurrent" }));
    await reading;
    expect((await postUpdate(post("/update", { key: "dialog-concurrent" }))).status).toBe(202);
    releaseGreen({ state: "green" });
    expect((await exact).status).toBe(409);
    const ledgerFile = join(h.deps.dir, "deployments.json");
    expect(existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : []).toEqual([]);
    h.releaseBuild?.(); await until(next => next.update.steps.some(step => step.name === "switch"));
  });

  test.each(["accepted", "refused"])("legacy service with an existing built pointer handles %s handoff without an apply intent", async outcome => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    const releaseDir = join(h.deps.dir, "built-release");
    await git(checkout, "fetch", "origin");
    const checkoutResult = await runGit(["worktree", "add", "--detach", releaseDir, tipSha], checkout);
    if (checkoutResult.code !== 0) throw new Error(checkoutResult.stderr);
    mkdirSync(join(releaseDir, ".next")); writeFileSync(join(releaseDir, ".next", "BUILD_ID"), "fixture");
    mkdirSync(join(releaseDir, "bin")); writeFileSync(join(releaseDir, "bin", "launcher-relaunch.mjs"), "delegatus-launcher-relaunch-v1");
    const pointer = JSON.stringify({ sha: tipSha, dir: releaseDir, checkoutHead: firstSha }); writeFileSync(record.releasePointer, pointer);
    const calls: string[][] = [];
    h.deps.install = {
      action: decision => installAction(decision, { cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service", ready: () => true }),
      run: action => { if (outcome === "refused") throw new Error("manager unavailable"); runInstallAction(action, args => calls.push(args)); }, entry: () => join(checkout, "bin", "cli.mjs"),
    };
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    expect((await snapshot()).action?.id).toBe("restart-service");
    await until(next => next.check.state !== "checking");
    const result = await h.service.performInstallAction();
    if (outcome === "refused") {
      expect(result).toMatchObject({ ok: false, status: 503 });
      expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8"))).toMatchObject({ state: "failed" });
      expect(existsSync(record.requestFile.replace(/^(.+\/)request/, "$1trial"))).toBe(false);
      expect(readFileSync(record.releasePointer, "utf8")).toBe(pointer);
      return;
    }
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.slice(-4)).toEqual(["systemctl", "--user", "restart", "delegatus.service"]);
    expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8"))).toMatchObject({ state: "switching", target: tipSha, rollbackPointer: pointer, externalRestart: true });
    expect(existsSync(record.requestFile)).toBe(false);
  });

  test("a legacy terminal deploy returns the dialog prerequisite and sends no restart", async () => {
    const h = harness(); setSelfUpdateServiceForTests(h.service);
    const response = await deployPost(post("/runtime/deployments", { revision: tipSha, idempotencyKey: "old-launcher" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ state: "action-required", code: "self-update-action-required", action: { id: "update-first", button: true } });
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    expect(existsSync(record.requestFile)).toBe(false);
  });

  test("the operator can enable auto-apply for checkout and managed installs", async () => {
    const h = harness({ remote: "https://github.com/example/project.git" });
    h.deps.check = async () => ({ ok: false, error: "fixture", installed: null });
    h.service = new SelfUpdateService(h.deps);
    setSelfUpdateServiceForTests(h.service);
    expect((await postAuto(post("/auto", { enabled: "yes" }))).status).toBe(400);
    expect((await postAuto(post("/auto", { enabled: true }))).status).toBe(202);
    expect((await snapshot()).auto?.enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(h.deps.dir, "auto.json"), "utf8")).enabled).toBe(true);
    const managed = new SelfUpdateService(baseDeps(mkdtempSync(join(root, "auto-managed-")), {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      remote: "https://github.com/example/project.git",
      releaseTarget: () => ({ revision: firstSha }),
    }));
    setSelfUpdateServiceForTests(managed);
    expect((await postAuto(post("/auto", { enabled: true }))).status).toBe(202);
    expect((await snapshot()).auto).toMatchObject({ availability: "available", enabled: true });
  });

  test.each(["pending", "red", "unknown"] as const)("the real snapshot names %s checks during a built update's wait, then resumes waiting after recovery", async (state) => {
    const h = harness({ remote: "https://github.com/example/project.git" });
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    record.web.revision = tipSha.slice(0, 7);
    record.runtimeHost.revision = tipSha.slice(0, 7);
    writeFileSync(h.recordFile, JSON.stringify(record));
    let now = Date.parse("2026-09-28T00:00:00Z");
    let verdict: GreenVerdict = { state: "green" };
    h.deps.now = () => now;
    const freshReads: (boolean | undefined)[] = [];
    h.deps.green = { read: async (...args: Parameters<GreenReader["read"]>) => { freshReads.push(args[5]); return verdict; } } as unknown as GreenReader;
    h.deps.quiet = { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: () => [], presence: () => [], memoryAvailableMb: () => 8_192 };
    writeAuto(join(h.deps.dir, "auto.json"), { ...initialAuto(), enabled: true, green: { [firstSha]: { state: "green" } } });
    h.service = new SelfUpdateService(h.deps);
    setSelfUpdateServiceForTests(h.service);

    await h.service.autoTick();
    const waiting = await snapshot();
    expect(waiting.auto).toMatchObject({ phase: "waiting", green: { state: "green" } });
    const waitingSince = waiting.auto?.waitingSince;
    expect(waitingSince).toBeTruthy();

    verdict = { state, detail: state === "unknown" ? "GitHub HTTP 503" : "required-build" };
    now += 60_000;
    await h.service.autoTick();
    expect(existsSync(record.requestFile)).toBe(false);
    const blocked = await snapshot();
    expect(blocked.auto).toMatchObject({ phase: "not-green", green: verdict, waitingSince, blockers: null, longWait: false });

    verdict = { state: "green" };
    now += 15 * 60_000;
    await h.service.autoTick();
    const recovered = await snapshot();
    expect(recovered.auto).toMatchObject({ phase: "waiting", green: { state: "green" }, waitingSince });
    if (state === "red") expect(freshReads.at(-1)).toBe(true);
    expect(existsSync(record.requestFile)).toBe(false);
    h.service.stop();
  });

  test.each([undefined, 2])("a launcher without supported final admission (%s) cannot enable auto-apply", async (autoAdmission) => {
    const h = harness({ remote: "https://github.com/example/project.git" });
    setSelfUpdateServiceForTests(h.service);
    expect((await snapshot()).auto?.availability).toBe("available");
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    if (autoAdmission === undefined) delete record.launcher.autoAdmission;
    else record.launcher.autoAdmission = autoAdmission;
    writeFileSync(h.recordFile, JSON.stringify(record));
    const response = await postAuto(post("/auto", { enabled: true }));
    expect(response.status).toBe(409);
    expect((await snapshot()).auto).toMatchObject({ availability: "launcher-upgrade", enabled: false });
    expect(existsSync(record.requestFile)).toBe(false);
  });

  for (const legacyToken of [false, true]) test.each(["red", "green"] as const)(`hand-managed rebuild verifies the installed SHA before dispatch, legacyToken=${legacyToken}: %s`, async verdict => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    writeFileSync(record.releasePointer, JSON.stringify({ sha: firstSha, dir: checkout, checkoutHead: tipSha }));
    const target = await readRevision(checkout, "HEAD");
    if (legacyToken) h.deps.env = { LLV_TOKEN: "fixture-bearer" };
    h.deps.remote = "https://github.com/example/fixture.git";
    h.deps.check = async () => ({ ok: true, installed: target, available: null, relation: "equal", ahead: 0, behind: 0, delta: null });
    const reads: unknown[][] = []; let builds = 0;
    h.deps.green = { read: async (...args: unknown[]) => { reads.push(args); return { state: verdict }; } } as unknown as GreenReader;
    h.deps.createRunner = () => ({ state: idleUpdate(["fetch", "install", "build", "ready"]), restore() {}, logPath: () => "",
      async start() { builds++; }, async retry() { throw new Error("not a retry"); } });
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await h.service.check();
    expect((await h.service.snapshot()).auto?.availability).toBe(legacyToken ? "launcher-upgrade" : "hand-managed");
    const result = await h.service.startUpdate("manual-rebuild");
    expect(result).toMatchObject(verdict === "green" ? { ok: true } : { ok: false, status: 409, code: "deployment-refused", detail: "red" });
    expect(reads).toEqual([[h.deps.remote, h.deps.branch, target.sha, checkout]]);
    expect(builds).toBe(verdict === "green" ? 1 : 0);
    await Bun.sleep(10);
  });

  test("a hand-managed checkout at the tracked tip can be rebuilt from the dialog", async () => {
    const h = harness();
    const record = JSON.parse(readFileSync(h.recordFile, "utf8")) as { releasePointer: string };
    writeFileSync(record.releasePointer, JSON.stringify({ sha: firstSha, dir: checkout, checkoutHead: tipSha }));
    h.deps.check = async () => ({ ok: true, installed: await readRevision(checkout, "HEAD"), available: null, relation: "equal", ahead: 0, behind: 0, delta: null });
    h.service = new SelfUpdateService(h.deps);
    setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check"));
    await until((next) => next.check.state === "up-to-date");
    expect((await snapshot()).auto?.availability).toBe("hand-managed");
    expect((await postUpdate(post("/update", { key: "rebuild" }))).status).toBe(202);
    await until((next) => next.update.state === "failed");
  });

  /** The launcher's side, played by its own request watcher: each request
      moves the recorded process onto the published release. */
  function launcher(h: Harness) {
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    return watchRestartRequests(record.requestFile, async ({ requestId, role }) => {
      const key = role === "web" ? "web" : "runtimeHost";
      const current = JSON.parse(readFileSync(h.recordFile, "utf8"));
      const pointer = JSON.parse(readFileSync(current.releasePointer, "utf8"));
      current[key] = { ...current[key], requestId, state: "healthy", revision: pointer.sha.slice(0, 7), startedAt: new Date().toISOString() };
      writeFileSync(h.recordFile, JSON.stringify(current));
    }, { intervalMs: 60_000 });
  }

  test("check, build in a release directory, then restart each process onto it", async () => {
    const h = harness();
    setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check"));
    let s = await until((next) => next.check.state === "update-available");
    expect(s.mode).toBe("checkout");
    expect(s.meta.checkout).toBe(checkout);
    expect(s.installed.sha).toBe(firstSha);
    expect(s.check.delta?.commits.map((commit) => commit.subject)).toEqual(["Say what runs"]);

    expect((await postUpdate(post("/update", { key: "press-1" }))).status).toBe(202);
    s = await until((next) => next.update.state === "done");
    expect(s.update.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done", "pending"]);
    const releaseDir = s.update.releaseDir!;
    expect(releaseDir.startsWith(join(root))).toBe(true);
    expect(h.spawned.map((command) => command.slice(0, 3).join(" "))).toEqual([
      `git fetch --no-tags`,
      `git worktree add`,
      "/opt/bun install --frozen-lockfile",
      "/opt/bun run build",
    ]);
    /* The checkout the processes serve from was never built in. */
    expect(existsSync(join(checkout, ".next"))).toBe(false);
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(firstSha);
    /* Built, not running: both processes still serve the first release. */
    s = await until((next) => next.installed.sha === tipSha);
    expect(s.serving.web?.short).toBe(firstSha.slice(0, 7));
    expect(s.check.state).not.toBe("update-available");

    const watcher = launcher(h);
    try {
      expect((await postRestart(post("/restart", { role: "runtime-host" }))).status).toBe(400);
      expect((await postRestart(post("/restart", { role: "web" }))).status).toBe(202);
      expect((await snapshot()).busy).toBe("restart-web");
      /* One restart at a time. */
      expect((await postRestart(post("/restart", { role: "runtime-host", confirm: true }))).status).toBe(409);
      setSelfUpdateServiceForTests(new SelfUpdateService(h.deps));
      await watcher.poll();
      s = await until((next) => next.busy === null);
      expect(s.serving.web?.short).toBe(tipSha.slice(0, 7));
      expect(s.serving.runtimeHost?.short).toBe(firstSha.slice(0, 7));

      expect((await postRestart(post("/restart", { role: "runtime-host", confirm: true }))).status).toBe(202);
      await watcher.poll();
      s = await until((next) => next.busy === null && next.serving.runtimeHost?.short === tipSha.slice(0, 7));
      expect(s.processes.runtimeHost.state).toBe("healthy");
      expect(s.history?.map((entry) => [entry.kind, entry.by, entry.outcome])).toEqual([
        ["restart-host", "operator", "done"], ["restart-web", "operator", "done"], ["build", "operator", "done"],
      ]);
    } finally {
      watcher.stop();
    }

    const log = await getStepLog("build").text();
    expect(log).toContain("run build ok");
    expect(getStepLog("everything").status).toBe(404);
  });

  test("a moved remote can be checked again and built after the failed state is restored", async () => {
    const movingRemote = mkdtempSync(join(root, "moving-remote-"));
    const movingWork = mkdtempSync(join(root, "moving-work-"));
    await git(root, "clone", "--bare", remote, movingRemote);
    await git(root, "clone", movingRemote, movingWork);
    const h = harness({ remote: movingRemote });
    setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check"));
    expect((await until((s) => s.check.state === "update-available")).available?.sha).toBe(tipSha);

    writeFileSync(join(movingWork, "package.json"), `${JSON.stringify({ version: "1.0.2" })}\n`);
    writeFileSync(join(movingWork, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Remote recovery (#8)\n\n## [1.0.0] — 2026-09-01\n\n### Added\n\n- First release (#1)\n");
    await git(movingWork, "add", ".");
    await git(movingWork, "commit", "-m", "Remote recovery");
    await git(movingWork, "push", "origin", "main");
    const movedSha = await git(movingWork, "rev-parse", "HEAD");

    expect((await postUpdate(post("/update", { key: "press-stale" }))).status).toBe(202);
    const failed = await until((s) => s.update.state === "failed");
    expect(failed.update.target).toBe(tipSha);
    expect(failed.update.steps[0]?.failure).toEqual({ kind: "remote-moved", expected: tipSha.slice(0, 7), fetched: movedSha.slice(0, 7) });
    h.service.saveNow();
    setSelfUpdateServiceForTests(new SelfUpdateService(h.deps));
    expect((await snapshot()).update).toMatchObject({ state: "failed", target: tipSha });

    expect((await postCheck(post("/check"))).status).toBe(202);
    const checked = await until((s) => s.check.state === "update-available" && s.available?.sha === movedSha);
    expect(checked.check.delta?.summary.groups.some((group) => group.items.some((item) => item.includes("Remote recovery")))).toBe(true);
    expect((await postUpdate(post("/update", { key: "press-new" }))).status).toBe(202);
    const built = await until((s) => s.update.state === "done");
    expect(built.update.target).toBe(movedSha);
    expect(built.installed.sha).toBe(movedSha);
  });

  test("a host whose launch failed blocks nothing, and a restart asked of it settles on the failure", async () => {
    const h = harness();
    setSelfUpdateServiceForTests(h.service);
    /* Above the kernel's PID ceiling: a PID nothing can hold. */
    const deadPid = 4_194_304 + 17;
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    record.runtimeHost = { ...record.runtimeHost, state: "starting", pid: deadPid, startIdentity: "1", error: null };
    writeFileSync(h.recordFile, JSON.stringify(record));
    let s = await snapshot();
    expect(s.busy).toBeNull();
    expect(s.processes.runtimeHost).toMatchObject({ state: "failed", pid: null, error: { kind: "gone", pid: deadPid } });

    expect((await postRestart(post("/restart", { role: "runtime-host", confirm: true }))).status).toBe(202);
    expect((await snapshot()).busy).toBe("restart-runtime-host");
    const request = JSON.parse(readFileSync(record.requestFile, "utf8")) as { requestId: string };
    /* The launcher tried and the new host exited before it was ready. */
    record.runtimeHost = { ...record.runtimeHost, requestId: request.requestId, state: "failed", pid: deadPid + 1, error: { kind: "exit", code: 3, signal: null, afterMs: 120 } };
    writeFileSync(h.recordFile, JSON.stringify(record));
    s = await snapshot();
    expect(s.busy).toBeNull();
    expect(s.processes.runtimeHost).toMatchObject({ state: "failed", pid: null, error: { kind: "exit", code: 3 } });
    /* Nothing is busy: Update is refused only because no check has run. */
    const update = await postUpdate(post("/update", { key: "press-after-failure" }));
    expect(((await update.json()) as { code: string }).code).toBe("no-update");
  });

  test("a restart is refused while an update builds, and so is a second update", async () => {
    const h = harness({ holdBuild: true });
    setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check"));
    await until((next) => next.check.state === "update-available");
    await postUpdate(post("/update", { key: "press-1" }));
    await until((next) => next.update.steps.some((step) => step.name === "build" && step.state === "running"));
    expect((await postRestart(post("/restart", { role: "web" }))).status).toBe(409);
    expect((await postUpdate(post("/update", { key: "press-2" }))).status).toBe(409);
    expect((await postCheck(post("/check"))).status).toBe(409);
    h.releaseBuild?.();
    await until((next) => next.update.state === "done");
  }, 15_000);

  test("the Snapshot streams as server-sent events", async () => {
    const h = harness();
    setSelfUpdateServiceForTests(h.service);
    const abort = new AbortController();
    const response = getEvents(new Request(`${BASE}/events`, { signal: abort.signal }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    const deadline = Date.now() + 5_000;
    while (!text.includes("event: state") && Date.now() < deadline) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    abort.abort();
    await reader.cancel().catch(() => {});
    const data = text.split("event: state\ndata: ")[1]!.split("\n")[0]!;
    expect((JSON.parse(data) as Snapshot).mode).toBe("checkout");
  });
});


test.each(["manual-upgrade", "missing-artifact", "valid"] as const)("package snapshots validate the installed pointer: %s", async shape => {
  const dir = mkdtempSync(join(root, "package-pointer-"));
  const installRoot = join(dir, "package"); const cached = join(dir, "cached");
  const rootVersion = shape === "manual-upgrade" ? "1.0.2" : "1.0.0";
  for (const directory of [installRoot, join(cached, "dist", "standalone")]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version: rootVersion }));
  writeFileSync(join(cached, "package.json"), JSON.stringify({ version: "1.0.1" }));
  writeFileSync(join(cached, "dist", "standalone", "server.js"), "fixture");
  if (shape !== "missing-artifact") writeFileSync(join(cached, "dist", "runtime-host.mjs"), "fixture");
  const record = { version: 1, checkout: null, installRoot, releasePointer: join(dir, "release.json"), releasesDir: join(dir, "releases"), requestFile: join(dir, "request.json"),
    port: 3000, socket: join(dir, "host.sock"), launcher: { pid: 1, startIdentity: "1", relaunch: 1, state: "healthy" },
    web: { state: "healthy", pid: 2, startIdentity: "2", revision: tipSha.slice(0, 7), error: null }, runtimeHost: { state: "healthy", pid: 3, startIdentity: "3", revision: tipSha.slice(0, 7), error: null } } as LauncherRecord;
  writeFileSync(record.releasePointer, JSON.stringify({ kind: "package", version: "1.0.1", sha: tipSha, dir: cached, baseVersion: "1.0.0" }));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ slice: { ...initialCheck(), installed: { version: "1.0.1", sha: tipSha, short: tipSha.slice(0, 7), date: "" } } }));
  const expectedVersion = shape === "valid" ? "1.0.1" : rootVersion;
  const service = new SelfUpdateService(baseDeps(dir, { mode: async () => ({ mode: "package", reason: null, record }) }));
  const registry = spyOn(globalThis, "fetch").mockImplementation(async input => {
    const version = String(input).split("/").pop();
    return Response.json({ version: version === "latest" ? "1.0.3" : version, gitHead: version === "1.0.1" ? tipSha : "c".repeat(40) });
  });
  try {
    const before = await service.snapshot();
    expect(before.installed.version).toBe(expectedVersion);
    if (shape !== "valid") expect(before.installed.sha).not.toBe(tipSha);
    await service.check();
    expect((await service.snapshot()).installed).toMatchObject({ version: expectedVersion, sha: shape === "valid" ? tipSha : "c".repeat(40) });
  } finally { service.stop(); registry.mockRestore(); }
});

for (const operation of ["update", "retry"] as const) {
  test.each(["red", "pending", "unknown", "green"] as const)(`package ${operation} admits only a green published source: %s`, async verdict => {
    const dir = mkdtempSync(join(root, "package-green-")); const installRoot = join(dir, "package"); mkdirSync(installRoot);
    writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.0" }));
    const record = { version: 1, checkout: null, installRoot, releasePointer: join(dir, "release.json"), releasesDir: join(dir, "releases"), requestFile: join(dir, "request-fixture.json"),
      port: 3000, socket: join(dir, "host.sock"), launcher: { pid: 1, startIdentity: "1", relaunch: 1, state: "healthy" },
      web: { state: "healthy", pid: 2, startIdentity: "2", revision: firstSha.slice(0, 7), error: null }, runtimeHost: { state: "healthy", pid: 3, startIdentity: "3", revision: firstSha.slice(0, 7), error: null } } as LauncherRecord;
    const target = { sha: tipSha, short: tipSha.slice(0, 7), version: "1.0.1", date: "" };
    const slice = { ...initialCheck(), available: target, check: { ...initialCheck().check, state: "update-available", at: new Date().toISOString() } };
    const update = operation === "retry" ? { ...idleUpdate(["fetch", "install", "ready"]), state: "failed", target: target.sha, targetVersion: target.version } : null;
    writeFileSync(join(dir, "state.json"), JSON.stringify({ slice, update }));
    const reads: unknown[][] = [];
    const deps = baseDeps(dir, { remote: "https://github.com/example/fixture.git", mode: async () => ({ mode: "package", reason: null, record }), prepareCheckRepo: async () => checkout,
      green: { read: async (...args: unknown[]) => { reads.push(args); return { state: verdict }; } } as unknown as GreenReader });
    const service = new SelfUpdateService(deps);
    // Delivery is forbidden before admission. A green case stops at this
    // fixture boundary instead of reaching the registry or package manager.
    const registry = spyOn(globalThis, "fetch").mockRejectedValue(new Error("fixture delivery boundary"));
    try {
      const result = operation === "update" ? await service.startUpdate("package-update") : await service.retry("package-retry");
      expect(result).toMatchObject(verdict === "green" ? { ok: true } : { ok: false, status: 409, code: "deployment-refused", detail: verdict });
      expect(reads).toEqual([[deps.remote, deps.branch, target.sha, checkout]]);
      expect(registry.mock.calls.length).toBe(verdict === "green" ? 1 : 0);
      await Bun.sleep(10);
      expect(existsSync(record.releasePointer)).toBe(false);
      expect(existsSync(record.requestFile)).toBe(false);
      expect(existsSync(join(dir, "apply.json"))).toBe(verdict === "green");
    } finally { await Bun.sleep(10); registry.mockRestore(); service.stop(); }
  });
}


test("a fresh manual Viewer writes adoption before its launcher prerequisite", async () => {
  const dir = mkdtempSync(join(root, "fresh-manual-"));
  const service = new SelfUpdateService(baseDeps(join(dir, "self-update"), {
    mode: async () => ({ mode: "unsupported", reason: "no-runtime-host", record: null, installRoot: checkout }),
    env: { LLV_STATE_OWNER: "viewer", PORT: "34567" },
    web: { pid: process.pid, port: 34567, startedAt: new Date().toISOString() },
  }));
  try {
    await service.decide();
    const { cliRuntimeHostConfig } = await import("../../../bin/server-runtime.mjs");
    const config = cliRuntimeHostConfig(checkout, { env: { LLV_STATE_DIR: dir } });
    const adopt = join(dir, "self-update", `adopt-${config.installId}.json`);
    expect(existsSync(adopt)).toBe(true);
    expect(JSON.parse(readFileSync(adopt, "utf8"))).toMatchObject({ pid: process.pid, startIdentity: readStartIdentity(process.pid), port: 34567, socket: config.socketPath, installRoot: checkout });
  } finally { service.stop(); }
});
