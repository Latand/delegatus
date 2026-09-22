import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { ViewerDeploymentPhase, ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { requestViewerDeployment, setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";

import { watchRestartRequests } from "../../../bin/self-update-supervisor.mjs";
import { buildEnv } from "./env";
import { checkForUpdate, readRevision, runGit } from "./git";
import { readLauncherRecord, requestRestart } from "./launcher";
import { deploymentsEnabled, detectMode } from "./mode";
import { readStartIdentity, sameProcess } from "./pid";
import { getEvents, getSnapshot, getStepLog, postCheck, postRestart, postUpdate } from "./routes";
import { prepareManagedCheckRepo, setSelfUpdateServiceForTests } from "./instance";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { UpdateRunner, type StepPorts } from "./steps";
import type { Snapshot } from "./types";

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

async function snapshot(): Promise<Snapshot> {
  return (await getSnapshot()).json() as Promise<Snapshot>;
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
    releaseTarget: () => null,
    prepareCheckRepo: async () => { throw new Error("no check repository in this mode"); },
    buildEnv,
    web: { pid: process.pid, port: 3000, startedAt: new Date().toISOString() },
    ...overrides,
  };
}

describe("the operator gate", () => {
  test("an agent presenting its capability is refused every mutating route, and nothing is asked of the host", async () => {
    const requests: ViewerDeploymentRequest[] = [];
    setDeploymentRuntimeForTests(async (request) => { requests.push(request); return { state: "accepted", deploymentId: "d", revision: tipSha, replayed: false }; });
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(mkdtempSync(join(root, "gate-")), { mode: async () => ({ mode: "managed", reason: null, record: null }) })));
    setCallerConversationResolverForTests(() => "conversation_some_worker");
    const agent = { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) };
    for (const response of [
      await postCheck(post("/check", undefined, agent)),
      await postUpdate(post("/update", { key: "press-1" }, agent)),
      await postRestart(post("/restart", { role: "runtime-host", confirm: true }, agent)),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(requests).toEqual([]);
  });

  test("a cross-origin page is refused before anything is read", async () => {
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(mkdtempSync(join(root, "gate-")), {})));
    const foreign = { ...browser, origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" };
    expect((await postUpdate(post("/update", { key: "press-1" }, foreign))).status).toBe(403);
    expect((await postRestart(post("/restart", { role: "web" }, foreign))).status).toBe(403);
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
  interface Harness { service: SelfUpdateService; recordFile: string; spawned: string[][]; releaseBuild: (() => void) | null }

  function harness(options: { holdBuild?: boolean } = {}): Harness {
    const dir = mkdtempSync(join(root, "checkout-"));
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const recordFile = join(state, "launcher.json");
    const pid = process.pid;
    const startIdentity = readStartIdentity(pid)!;
    const entry = (revision: string) => ({ state: "healthy", pid, startIdentity, startedAt: new Date().toISOString(), revision, error: null, requestId: null });
    writeFileSync(recordFile, JSON.stringify({
      version: 1,
      launcher: { pid, startIdentity },
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
    const h: Harness = { service: null as unknown as SelfUpdateService, recordFile, spawned, releaseBuild: null };
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
    h.service = new SelfUpdateService(baseDeps(join(dir, "self-update"), {
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
    }));
    return h;
  }

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
    expect(s.update.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done"]);
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
      await watcher.poll();
      s = await until((next) => next.busy === null);
      expect(s.serving.web?.short).toBe(tipSha.slice(0, 7));
      expect(s.serving.runtimeHost?.short).toBe(firstSha.slice(0, 7));

      expect((await postRestart(post("/restart", { role: "runtime-host", confirm: true }))).status).toBe(202);
      await watcher.poll();
      s = await until((next) => next.busy === null && next.serving.runtimeHost?.short === tipSha.slice(0, 7));
      expect(s.processes.runtimeHost.state).toBe("healthy");
    } finally {
      watcher.stop();
    }

    const log = await getStepLog("build").text();
    expect(log).toContain("run build ok");
    expect(getStepLog("everything").status).toBe(404);
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
  });

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
