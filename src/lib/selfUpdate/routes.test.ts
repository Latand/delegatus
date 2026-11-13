import { soloBrowserSession } from "@/lib/agent/operatorSession";
import os from "node:os";
import { POST as updatePost } from "@/app/api/self-update/update/route";
import { POST as deployPost } from "@/app/api/runtime/deployments/route";
import { ledgerDeployment } from "@/lib/runtime/deploymentLedger";
import { compactDeployment } from "@/lib/mcp/compactAnswers";
import { viewerDeploymentPage, viewerDeploymentSummary } from "@/lib/runtime/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { procBackend } from "@/lib/proc";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { ViewerDeploymentPhase, ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { requestViewerDeployment, setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";

import { installAction, launcherService, runInstallAction, unitRunsLauncher } from "./actions";
import { checkoutDeployments, saveCheckoutDeployment } from "./deployments";
import * as deploymentAdmission from "./deploymentAdmission";
import { initialAuto, writeAuto } from "./auto";
import { GreenReader, type GreenVerdict } from "./green";
import { buildEnv } from "./env";
import { checkForUpdate, readRevision, runGit } from "./git";
import { launcherControlFile, readLauncherRecord, requestRestart } from "./launcher";
import { deploymentsEnabled, detectMode } from "./mode";
import { readStartIdentity, sameProcess } from "./pid";
import { getEvents, getSnapshot, getStepLog, postAuto, postCheck, postRestart, postUpdate, postInstallAction } from "./routes";
import { prepareManagedCheckRepo, productionDeps, setSelfUpdateServiceForTests } from "./instance";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { UpdateRunner, type StepPorts } from "./steps";
import { idleUpdate, stoppedProcess, type Snapshot } from "./types";
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

const root = mkdtempSync(join(os.tmpdir(), "self-update-routes-"));
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
  new NextRequest(`${BASE}${path}`, { method: "POST", headers: { ...(headers === browser ? { cookie: `llv_operator=${soloBrowserSession()}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

async function snapshot(headers: Record<string, string> = browser): Promise<Snapshot> {
  return (await getSnapshot(new Request(BASE, { headers: { ...(headers === browser ? { cookie: `llv_operator=${soloBrowserSession()}` } : {}), ...headers } }))).json() as Promise<Snapshot>;
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
    processIdentity: () => null,
    hostHealth: async () => null,
    requestDeployment: requestViewerDeployment,
    readDeployment: async () => null,
    findDeploymentByIdempotencyKey: async () => null,
    releaseTarget: () => null,
    prepareCheckRepo: async () => { throw new Error("no check repository in this mode"); },
    buildEnv,
    web: { pid: process.pid, port: 3000, startedAt: new Date().toISOString(), revision: firstSha },
    ...overrides,
  };
}

describe("administrator self-update policy", () => {
  for (const env of [
    { LLV_DISABLE_SELF_UPDATE: "1" },
    { DELEGATUS_DISABLE_SELF_UPDATE: "1", LLV_DISABLE_SELF_UPDATE: "0" },
  ]) test(`server refuses built-in mutations with ${Object.keys(env).join(" and ")}`, async () => {
    const dir = mkdtempSync(join(root, "admin-policy-"));
    const service = new SelfUpdateService(baseDeps(dir, { env, now: () => Date.parse("2030-01-01T00:00:00Z") }));
    setSelfUpdateServiceForTests(service);
    try {
      for (const [handler, path, input] of [
        [postUpdate, "/update", { key: "admin-update" }],
        [postUpdate, "/update", { key: "admin-retry", retry: true }],
        [postAuto, "/auto", { enabled: true, writer: { kind: "seat", conversationId: "spoofed" } }],
        [postAuto, "/auto", { enabled: false }],
        [postAuto, "/auto", { decisionId: "old-decision", choice: "deploy-now" }],
        [postInstallAction, "/install-action", {}],
      ] as const) {
        const response = await handler(post(path, input));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "updates-disabled", error: expect.stringContaining("administrator"), snapshot: {
          selfUpdateDisabled: true, auto: { enabled: false, availability: "disabled-by-admin", decision: null },
        } });
      }
      expect(existsSync(join(dir, "apply.json"))).toBe(false);
      expect(existsSync(join(dir, "auto.json"))).toBe(false);
      expect(existsSync(join(dir, "managed.json"))).toBe(false);
    } finally { service.stop(); }
  });

  test.each([{}, { LLV_DISABLE_SELF_UPDATE: "0" }, { LLV_DISABLE_SELF_UPDATE: "true" },
    { DELEGATUS_DISABLE_SELF_UPDATE: "0", LLV_DISABLE_SELF_UPDATE: "1" }])("default and non-1 values retain built-in actions: %j", async env => {
    const service = new SelfUpdateService(baseDeps(mkdtempSync(join(root, "admin-default-")), { env }));
    setSelfUpdateServiceForTests(service);
    try {
      const response = await postUpdate(post("/update", { key: "unchanged-default" }));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("no-update");
      expect((await service.snapshot()).selfUpdateDisabled).toBe(false);
    } finally { service.stop(); }
  });

  test("a saved automatic preference stays blocked across real Viewer-service processes", async () => {
    const dir = mkdtempSync(join(root, "admin-restart-"));
    const at = "2030-01-01T00:00:00.000Z";
    writeAuto(join(dir, "auto.json"), { ...initialAuto(), enabled: true, changedAt: at });
    const run = async (disabled: boolean) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "__fixtures__/installationPolicy.child.ts")], {
        cwd: process.cwd(), env: { ...process.env, LLV_DISABLE_SELF_UPDATE: disabled ? "1" : "0", DELEGATUS_DISABLE_SELF_UPDATE: undefined, POLICY_DIR: dir },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(stdout);
    };
    for (let generation = 0; generation < 2; generation++) {
      expect(await run(true)).toMatchObject({ disabled: true, enabled: false, availability: "disabled-by-admin", admission: false, update: { ok: false, code: "updates-disabled" }, checks: 0, deployments: 0 });
    }
    expect(await run(false)).toMatchObject({ disabled: false, enabled: true });
    expect(JSON.parse(readFileSync(join(dir, "auto.json"), "utf8"))).toMatchObject({ enabled: true, changedAt: at });
  });
});

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
  test("a service created before legacy-adapter activation observes the process revision once pinned", async () => {
    const env: Record<string, string> = {};
    const web = productionDeps(env).web;
    const service = new SelfUpdateService(baseDeps(mkdtempSync(join(root, "activation-identity-")), {
      web, mode: async () => ({ mode: "managed", reason: null, record: null }),
      prepareCheckRepo: async () => checkout,
      releaseTarget: () => ({ revision: firstSha }),
    }));
    try {
      expect((await service.snapshot()).serving.web).toBeNull();
      env.LLV_HOT_STATE_RELEASE_REVISION = tipSha;
      expect((await service.snapshot()).serving.web?.sha).toBe(tipSha);
      expect((await service.snapshot()).installed.sha).toBe(tipSha);
    } finally { service.stop(); }
  });

  test.each(["2026-10-15T11:28:24Z", "2026-10-15T11:00:00Z"])("a newer external success supersedes the failed target without rewriting its receipt or retrying it (%s)", async createdAt => {
    const { writeManagedRecord, readManagedRecord } = await import("./managed");
    const dir = mkdtempSync(join(root, "external-deployment-"));
    const failedAt = "2026-10-15T11:08:12Z";
    const failed = { deploymentId: "old-attempt", idempotencyKey: "old-key", target: firstSha,
      targetShort: firstSha.slice(0, 7), targetVersion: "1", requestedAt: "2026-10-15T11:00:00Z",
      observed: {}, lastStep: "health" as const, finishedAt: failedAt, phase: "failed" as const,
      error: "first boot loop gate refused", servingProgress: null };
    writeManagedRecord(join(dir, "managed.json"), failed);
    const bytes = readFileSync(join(dir, "managed.json"), "utf8");
    let latest = true;
    let lists = 0;
    const requests: ViewerDeploymentRequest[] = [];
    const deps = baseDeps(dir, {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      web: { pid: process.pid, port: 3000, startedAt: failedAt, revision: tipSha },
      releaseTarget: () => ({ revision: firstSha }), // Pointer is not the process.
      prepareCheckRepo: async () => checkout,
      latestDeployments: async () => { lists++; return { deployments: latest ? [{ deploymentId: "external-success", phase: "succeeded", sha: tipSha, terminal: true,
        startedAt: createdAt, finishedAt: "2026-10-15T11:38:51Z", error: null }] : [], nextCursor: null, hasMore: false }; },
      readDeployment: async id => ({ deploymentId: id, idempotencyKey: "external-key", requestedRevision: tipSha, revision: tipSha,
        phase: "succeeded", terminal: true, candidate: null, previous: null, mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
        health: [], error: null, owner: { pid: 1, startIdentity: null }, createdAt, updatedAt: "2026-10-15T11:38:51Z", revisionNumber: 1 }),
      hostHealth: async () => ({ pid: 4242, generation: { revision: tipSha } }) as never,
      requestDeployment: async request => { requests.push(request); throw new Error("stale retry was dispatched"); },
    });
    const service = new SelfUpdateService(deps);
    try {
      const s = await service.snapshot();
      expect(s.update).toMatchObject({ state: "done", target: tipSha, deploymentId: "external-success" });
      expect(s.previousAttempt).toMatchObject({ state: "failed", target: firstSha });
      expect(s.serving.web?.sha).toBe(tipSha);
      expect(s.installed.sha).toBe(tipSha);
      expect(s.serving.runtimeHost?.sha).toBe(tipSha);
      const { staleProcesses, appliedCopy } = await import("@/components/selfUpdate/selfUpdateCopy");
      expect(staleProcesses(s)).toEqual({ web: false, host: false });
      expect(appliedCopy(s, tipSha.slice(0, 7), key => key)).toBe("selfUpdate.applied.both");
      await service.snapshot();
      expect(lists).toBe(1);
      expect((await service.retry("retry-stale")).ok).toBe(false);
      expect(requests).toEqual([]);
      expect(readFileSync(join(dir, "managed.json"), "utf8")).toBe(bytes);
      expect(readManagedRecord(join(dir, "managed.json"))).toEqual(failed);
      // Missing ledger observation still cannot authorize a downgrade.
      latest = false;
      const restarted = new SelfUpdateService(deps);
      try { expect((await restarted.retry("retry-without-ledger")).ok).toBe(false); }
      finally { restarted.stop(); }
      expect(requests).toEqual([]);
    } finally { await service.check(); service.stop(); }
  });

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
      createdAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:00:00.000Z", revisionNumber: 1,
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

  test("managed installs refuse short revisions before runtime admission", async () => {
    setSelfUpdateServiceForTests(managedService());
    const response = await deployPost(post("/runtime/deployments", { revision: tipSha.slice(0, 9), idempotencyKey: "managed-short" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "pass the full SHA or a ref" });
  });

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
    await service.check();
  });

  test("a newer external failed target can be retried forward after two identical ledger observations", async () => {
    await git(checkout, "fetch", "origin");
    phase = "failed";
    const failed = { ...status("external-forward")!, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:01:00Z" };
    const admitted: ViewerDeploymentRequest[] = [];
    const service = new SelfUpdateService(baseDeps(mkdtempSync(join(root, "external-forward-")), {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      prepareCheckRepo: async () => checkout,
      releaseTarget: () => ({ revision: firstSha }),
      hostHealth: async () => ({ pid: 4242, generation: { revision: firstSha } }) as never,
      latestDeployments: async () => ({ deployments: [{ deploymentId: failed.deploymentId, phase: "failed", sha: tipSha,
        terminal: true, startedAt: failed.createdAt, finishedAt: failed.updatedAt, error: "candidate refused" }], nextCursor: null, hasMore: false }),
      readDeployment: async () => ({ ...failed }),
      requestDeployment: async request => { admitted.push(request); return { state: "accepted", deploymentId: "retry-forward", revision: tipSha, replayed: false }; },
    }));
    try {
      expect((await service.retry("forward-retry")).ok).toBe(true);
      expect(admitted).toMatchObject([{ revision: tipSha }]);
    } finally { service.stop(); }
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
      hostHealth: async () => ({ pid: 4242, startIdentity: "1", hostEpoch: 3, generation: { revision: firstSha } }),
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
      hostHealth: async () => ({ pid: 4242, startIdentity: "1", hostEpoch: 3, generation: { revision: firstSha } }),
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

  test("an unknown serving revision fails the check with a code", async () => {
    const dir = mkdtempSync(join(root, "managed-no-target-"));
    setSelfUpdateServiceForTests(new SelfUpdateService(baseDeps(dir, {
      mode: async () => ({ mode: "managed", reason: null, record: null }),
      releaseTarget: () => null,
      web: { pid: process.pid, port: 3000, startedAt: new Date().toISOString(), revision: null },
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
      hostHealth: async () => ({ pid: 4242, startIdentity: "1", hostEpoch: 3, generation: { revision: firstSha } }),
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

  function harness(options: { holdBuild?: boolean; failBuildOnce?: boolean; relaunch?: boolean; remote?: string } = {}): Harness {
    const dir = mkdtempSync(join(root, "checkout-"));
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const recordFile = join(state, "launcher.json");
    const pid = process.pid;
    const startIdentity = readStartIdentity(pid)!;
    const entry = (revision: string) => ({ state: "healthy", pid, startIdentity, startedAt: new Date().toISOString(), revision, error: null, requestId: null });
    writeFileSync(recordFile, JSON.stringify({
      version: 1,
      launcher: { pid, startIdentity, autoAdmission: 1, ...(options.relaunch ? { relaunch: 1, state: "healthy" } : {}) },
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
    let failBuild = options.failBuildOnce ?? false;
    const run: StepPorts["run"] = async (command, { cwd, onLine }) => {
      spawned.push(command);
      if (command[0] === "git") {
        const result = await runGit(command.slice(1), cwd);
        for (const line of `${result.stdout}${result.stderr}`.split("\n").filter(Boolean)) onLine(line);
        return result.code;
      }
      if (command.includes("build")) {
        if (failBuild) { failBuild = false; return 1; }
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
      hostHealth: async () => ({ pid, startIdentity: procBackend.processIdentity(pid)!, hostEpoch: 1 }),
      processAlive: (candidate, identity) => sameProcess({ pid: candidate, startIdentity: identity }),
      processIdentity: (candidate) => procBackend.processIdentity(candidate),
    });
    h.service = new SelfUpdateService(h.deps);
    return h;
  }

  test("exact admission reports target CI pending and retries while the equal-tree PR head remains red", async () => {
    const h = harness({ relaunch: true, holdBuild: true });
    const head = "a".repeat(40), tree = "b".repeat(40);
    let green = false;
    const reader = new GreenReader({ now: () => 1000, treeOf: async () => tree, fetch: (async input => {
      const url = String(input);
      const body = url.includes("/pulls") ? [{ merged_at: "2026-01-01", merge_commit_sha: tipSha, base: { ref: "main" }, head: { sha: head } }]
        : url.includes("/check-runs") ? { check_runs: url.includes(`/commits/${tipSha}/`) ? [
          { id: 12, name: "runtime-gate", status: green ? "completed" : "in_progress", conclusion: green ? "success" : null, app: { id: 15368 } },
          { id: 13, name: "build", status: "in_progress", conclusion: null, app: { id: 15368 } },
        ] : [{ name: "Minimum macOS SQLite", status: "completed", conclusion: "failure", app: { id: 15368 } }] }
        : url.includes("/statuses") ? [] : url.includes("/branches/") ? { protected: true, protection: { required_status_checks: { checks: [{ context: "runtime-gate", app_id: 15368 }] } } }
        : { commit: { tree: { sha: tree } } };
      return Response.json(body);
    }) as typeof fetch });
    h.deps.green = { read: (...args: Parameters<GreenReader["read"]>) => {
      args[0] = "github.com/example/project"; return reader.read(...args);
    } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const request = { revision: tipSha, idempotencyKey: "target-required-ci" };
    try {
      expect(await (await deployPost(post("/runtime/deployments", request))).json()).toMatchObject({ state: "refused", code: "deploy_not_green",
        outcome: "not-executed", nextAction: "retry-same-key", green: { state: "pending", checks: ["runtime-gate"] } });
      green = true;
      expect(await (await deployPost(post("/runtime/deployments", request))).json()).toMatchObject({ state: "accepted" });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    } finally {
      if (checkoutDeployments(h.deps.dir).length) {
        await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
        await until(() => existsSync(readLauncherRecord(h.recordFile)!.requestFile));
      }
    }
  });

  test.each(["pending", "red", "checks-timeout"] as const)("slow green refusal is definite and the same key admits after %s", async state => {
    const h = harness({ relaunch: true, holdBuild: true });
    const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<GreenVerdict>();
    let verdict: GreenVerdict | null = null;
    h.deps.green = { read: () => { entered.resolve(); return verdict ? Promise.resolve(verdict) : held.promise; } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const request = { revision: tipSha, idempotencyKey: `slow-not-green-${state}` };
    const attempt = deployPost(post("/runtime/deployments", request));
    try {
      await entered.promise;
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
      held.resolve({ state, detail: "runtime-gate" });
      const response = await attempt;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ state: "refused", code: "deploy_not_green", outcome: "not-executed",
        nextAction: "retry-same-key", green: { state: state === "checks-timeout" ? "pending" : state, detail: "runtime-gate" } });
      verdict = { state: "green" };
      expect(await (await deployPost(post("/runtime/deployments", request))).json()).toMatchObject({ state: "accepted" });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    } finally {
      held.resolve({ state, detail: "runtime-gate" }); await attempt;
      if (checkoutDeployments(h.deps.dir).length) {
        await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
        await until(() => existsSync(readLauncherRecord(h.recordFile)!.requestFile));
      }
    }
  });

  test("retention busy names its holder and never the last finished deployment", async () => {
    const h = harness({ relaunch: true });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    mkdirSync(h.deps.dir, { recursive: true });
    saveCheckoutDeployment(h.deps.dir, { deploymentId: "checkout-finished", idempotencyKey: "finished-key", requestedRevision: firstSha, revision: firstSha,
      phase: "succeeded", terminal: true, candidate: null, previous: null, health: [], error: null,
      mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, owner: { pid: process.pid, startIdentity: readStartIdentity(process.pid) },
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", revisionNumber: 1 });
    writeFileSync(join(h.deps.dir, "apply.json"), JSON.stringify({ requestId: "finished-apply", target: firstSha,
      deploymentId: "checkout-finished", state: "done", trigger: "seat", rollbackPointer: null,
      launcherPid: process.pid, launcherIdentity: readStartIdentity(process.pid), rolledBack: false, startedAt: "2026-01-01T00:00:00Z" }));
    h.deps.prune = () => { entered.resolve(); return release.promise; };
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const retention = h.service.retentionTick();
    try {
      await entered.promise;
      const receipt = await h.service.deployRevision({ revision: tipSha, idempotencyKey: "retention-busy" });
      expect(receipt).toMatchObject({ state: "busy", holder: { kind: "retention" }, waitBudgetMs: 1000, outcome: "not-executed" });
      expect(receipt).not.toHaveProperty("deploymentId");
      expect(checkoutDeployments(h.deps.dir)).toMatchObject([{ deploymentId: "checkout-finished", terminal: true }]);
    } finally { release.resolve(); await retention; }
  });

  test("a not-green refusal fences a concurrent older green read and the same key retries", async () => {
    const h = harness({ relaunch: true, holdBuild: true });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<GreenVerdict>();
    h.deps.green = { read: () => { entered.resolve(); return release.promise; } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    let green = false;
    const other = new SelfUpdateService({ ...h.deps, green: { read: async () => green ? { state: "green" } : { state: "pending", detail: "runtime-gate" } } as unknown as GreenReader });
    const request = { revision: tipSha, idempotencyKey: "concurrent-green-refusal" };
    const older = h.service.deployRevision(request);
    const observed = older.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await entered.promise;
      expect(await other.deployRevision(request)).toMatchObject({ state: "refused", code: "deploy_not_green" });
      release.resolve({ state: "green" });
      expect((await observed).error).toMatchObject({ code: "deploy_attempt_superseded" });
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
      green = true;
      expect(await other.deployRevision(request)).toMatchObject({ state: "accepted" });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    } finally {
      release.resolve({ state: "green" }); await observed;
      setSelfUpdateServiceForTests(other);
      if (checkoutDeployments(h.deps.dir).length) {
        await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
        await until(() => existsSync(readLauncherRecord(h.recordFile)!.requestFile));
      }
    }
  });

  test("a retention pass that settles after the busy snapshot permits admission", async () => {
    const h = harness({ relaunch: true, holdBuild: true });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    h.deps.prune = () => { entered.resolve(); return release.promise; };
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const retention = h.service.retentionTick();
    await entered.promise;
    const snapshot = h.service.snapshot.bind(h.service);
    h.service.snapshot = async () => { const result = await snapshot(); release.resolve(); await retention; return result; };
    try {
      expect(await h.service.deployRevision({ revision: tipSha, idempotencyKey: "retention-settled" })).toMatchObject({ state: "accepted" });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    } finally {
      release.resolve(); await retention;
      if (checkoutDeployments(h.deps.dir).length) {
        await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
        await until(() => existsSync(readLauncherRecord(h.recordFile)!.requestFile));
      }
    }
  });

  test("a same-revision deployment admitted during a slow green read durably joins the original key", async () => {
    const h = harness({ relaunch: true, holdBuild: true });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<GreenVerdict>();
    h.deps.green = { read: () => { entered.resolve(); return release.promise; } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const other = new SelfUpdateService({ ...h.deps, green: { read: async () => ({ state: "green" }) } as unknown as GreenReader });
    const request = { revision: tipSha, idempotencyKey: "delayed-join-key" };
    const attempt = h.service.deployRevision(request);
    try {
      await entered.promise;
      const admitted = await other.deployRevision({ revision: tipSha, idempotencyKey: "earlier-join-holder" });
      expect(admitted).toMatchObject({ state: "accepted" });
      release.resolve({ state: "green" });
      expect(await attempt).toMatchObject({ state: "accepted", deploymentId: "deploymentId" in admitted ? admitted.deploymentId : undefined });
      expect(checkoutDeployments(h.deps.dir)).toMatchObject([{ idempotencyKeys: [request.idempotencyKey] }]);
      expect(await h.service.deployRevision({ ...request, reconcileOnly: true })).toMatchObject({ state: "accepted", replayed: true });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    } finally {
      release.resolve({ state: "green" }); await attempt;
      setSelfUpdateServiceForTests(other);
      if (checkoutDeployments(h.deps.dir).length) {
        await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
        await until(() => existsSync(readLauncherRecord(h.recordFile)!.requestFile));
      }
    }
  });

  test.each(["web", "runtime-host"])("a pending %s restart names its request without a deployment id", async role => {
    const h = harness({ relaunch: true });
    setSelfUpdateServiceForTests(h.service);
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    writeFileSync(record.requestFile, JSON.stringify({ requestId: "pending-restart", role, requestedAt: "2026-01-01T00:00:00Z" }));
    try {
      expect(await h.service.deployRevision({ revision: tipSha, idempotencyKey: `restart-holder-${role}` }))
        .toMatchObject({ state: "busy", holder: { kind: "restart", role, requestId: "pending-restart" }, waitBudgetMs: 1000 });
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
    } finally { rmSync(record.requestFile, { force: true }); }
  });

  test("a transient restart appearing inside admission is waited for before returning busy", async () => {
    const h = harness({ relaunch: true, holdBuild: true });
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const record = readLauncherRecord(h.recordFile)!;
    const entered = Promise.withResolvers<void>();
    const request = { revision: tipSha, idempotencyKey: "late-transient-restart" };
    const original = deploymentAdmission.checkoutAdmission;
    let calls = 0;
    const hook = spyOn(deploymentAdmission, "checkoutAdmission").mockImplementation((directory, input, authorize, write, options) => {
      const intercept = input.idempotencyKey === request.idempotencyKey && ++calls === 2;
      return original(directory, input, authorize, generation => {
        if (intercept) {
          writeFileSync(record.requestFile, JSON.stringify({ requestId: "transient-restart-holder", role: "web", requestedAt: "2026-01-01T00:00:00Z" }));
          entered.resolve();
        }
        return write(generation);
      }, options);
    });
    const attempt = h.service.deployRevision(request);
    try {
      await entered.promise;
      rmSync(record.requestFile);
      expect(await attempt).toMatchObject({ state: "accepted" });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    } finally {
      hook.mockRestore();
      if (existsSync(record.requestFile) && JSON.parse(readFileSync(record.requestFile, "utf8")).requestId === "transient-restart-holder") rmSync(record.requestFile);
      await attempt;
      if (checkoutDeployments(h.deps.dir).length) {
        await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
        await until(() => existsSync(record.requestFile));
      }
    }
  });

  test("a delayed host-health read settles closed and cannot admit after reconciliation", async () => {
    const h = harness({ relaunch: true });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Awaited<ReturnType<ServiceDeps["hostHealth"]>>>();
    const health = h.deps.hostHealth;
    let slow = false;
    h.deps.green = { read: async () => { slow = true; return { state: "green" }; } } as unknown as GreenReader;
    h.deps.hostHealth = () => { if (!slow) return health(); entered.resolve(); return release.promise; };
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const request = { revision: tipSha, idempotencyKey: "slow-host-health" };
    const attempt = deployPost(post("/runtime/deployments", request));
    try {
      await entered.promise;
      const response = await deployPost(post("/runtime/deployments", { ...request, reconcileOnly: true }));
      expect(await response.json()).toMatchObject({ code: "deploy_not_admitted", outcome: "not-executed", nextAction: "new-request-permitted" });
      release.resolve(await health());
      expect(await (await attempt).json()).toMatchObject({ code: "deploy_not_admitted", outcome: "not-executed" });
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
    } finally { release.resolve(null); await attempt; }
  });

  test.each(["green", "host-health"])("admission expires during a held %s read and releases the next request", async heldRead => {
    const h = harness({ relaunch: true, holdBuild: true });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const health = h.deps.hostHealth;
    let hold = true, afterGreen = false;
    h.deps.green = { read: async () => {
      if (hold && heldRead === "green") { entered.resolve(); await release.promise; }
      afterGreen = true; return { state: "green" };
    } } as unknown as GreenReader;
    h.deps.hostHealth = async () => {
      if (hold && heldRead === "host-health" && afterGreen) { entered.resolve(); await release.promise; }
      return health();
    };
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const request = { revision: tipSha, idempotencyKey: `expired-${heldRead}` };
    const attempt = deployPost(post("/runtime/deployments", request));
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      const response = await Promise.race([attempt, new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("admission did not settle within its bound")), 15_000);
      })]);
      expect(await response.json()).toMatchObject({ code: "deploy_not_admitted", outcome: "not-executed", nextAction: "new-request-permitted" });
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
      hold = false;
      expect(await (await deployPost(post("/runtime/deployments", { ...request, idempotencyKey: `after-${heldRead}` }))).json())
        .toMatchObject({ state: "accepted" });
      release.resolve();
      expect(await (await deployPost(post("/runtime/deployments", request))).json()).toMatchObject({ code: "deploy_not_admitted" });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    } finally {
      if (guard !== undefined) clearTimeout(guard);
      hold = false; release.resolve(); await attempt;
      if (checkoutDeployments(h.deps.dir).length) {
        await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
        await until(() => existsSync(readLauncherRecord(h.recordFile)!.requestFile));
      }
    }
  });

  for (const retry of [false, true]) test(`concurrent operator ${retry ? "Retry" : "Update"} reserves one apply after the final quiet observation`, async () => {
    const h = harness({ holdBuild: true, failBuildOnce: retry });
    setSelfUpdateServiceForTests(h.service);
    let releaseObservation = () => {};
    const observation = new Promise<void>(resolve => { releaseObservation = resolve; });
    let bothObserved = () => {};
    const observed = new Promise<void>(resolve => { bothObserved = resolve; });
    let reads = 0;
    let starts = 0;
    const createRunner = h.deps.createRunner;
    h.deps.createRunner = (...args) => {
      const runner = createRunner(...args);
      for (const method of ["start", "retry"] as const) {
        const original = runner[method].bind(runner);
        spyOn(runner, method).mockImplementation((...input: Parameters<typeof runner.start>) => {
          starts++;
          return original(...input);
        });
      }
      return runner;
    };
    try {
      await postCheck(post("/check"));
      await until(next => next.check.state === "update-available");
      if (retry) {
        expect((await updatePost(post("/update", { key: "initial-failure" }))).status).toBe(202);
        await until(next => next.update.state === "failed");
        expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8")).state).toBe("failed");
      }
      starts = 0;
      const previousIntent = retry ? JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8")) : null;
      const snapshot = h.service.snapshot.bind(h.service);
      h.service.snapshot = async () => {
        // Each route reads an initial snapshot, then its final admission
        // snapshot. Hold the latter once the real snapshot has computed
        // busy:null for both, before either reaches its reservation.
        const read = ++reads;
        const result = await snapshot();
        if (read === 3 || read === 4) {
          if (read === 4) bothObserved();
          await observation;
        }
        return result;
      };
      const routes = Promise.allSettled(["tab-a", "tab-b"].map(key => updatePost(post("/update", { key, retry }))));
      await Promise.race([observed, Bun.sleep(3000).then(() => { throw new Error("Final observations did not reach the barrier"); })]);
      expect(starts).toBe(0);
      releaseObservation();
      const results = await routes;
      expect(results.every(result => result.status === "fulfilled")).toBe(true);
      const responses = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
      expect(await responses.find(response => response.status === 409)!.json()).toMatchObject({ code: "busy-update", snapshot: { busy: "update" } });
      expect(starts).toBe(1);
      const intent = JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8"));
      expect(intent).toMatchObject({ target: tipSha, state: "building", trigger: "operator", launcherPid: process.pid, launcherIdentity: readStartIdentity(process.pid) });
      expect(intent.requestId).not.toBe(previousIntent?.requestId);
      // The accepted request keeps the same durable intent through the build.
      await until(() => h.releaseBuild !== null);
      expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8")).requestId).toBe(intent.requestId);
      h.releaseBuild!(); h.releaseBuild = null;
      await until(next => next.update.state === "done");
      expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8")).requestId).toBe(intent.requestId);
    } finally {
      releaseObservation(); h.releaseBuild?.(); h.service.stop();
    }
  });

  test.each(["work", "custody", "request", "issuer"] as const)("operator apply preserves accepted intent after stale final mode read: %s", async change => {
    const h = harness({ holdBuild: true, relaunch: true });
    setSelfUpdateServiceForTests(h.service);
    let version = "idle";
    h.deps.quiet = { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: () => [], presence: () => [], dispatchVersion: () => version };
    let entered!: () => void, resume!: () => void;
    const arrival = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { resume = resolve; });
    try {
      await postCheck(post("/check")); await until(s => s.check.state === "update-available");
      expect((await updatePost(post("/update", { key: "operator-fence" }))).status).toBe(202);
      await until(() => h.releaseBuild !== null);
      const decide = h.service.decide.bind(h.service);
      h.service.decide = async () => { const result = await decide(); entered(); await wait; return result; };
      h.releaseBuild!(); h.releaseBuild = null;
      await arrival;
      const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
      const file = join(h.deps.dir, "apply.json");
      if (change === "work") version = "new-admitted-turn";
      if (change === "custody") { record.launcher.startIdentity = "successor"; writeFileSync(h.recordFile, JSON.stringify(record)); }
      if (change === "request") writeFileSync(record.requestFile, JSON.stringify({ requestId: "another-request", role: "web" }));
      if (change === "issuer") { const intent = JSON.parse(readFileSync(file, "utf8")); intent.requestId = "another-issuer"; writeFileSync(file, JSON.stringify(intent)); }
      const binding = readFileSync(file, "utf8");
      resume(); await Bun.sleep(50);
      expect(readFileSync(file, "utf8")).toBe(binding);
      expect(existsSync(record.requestFile)).toBe(change === "request");
      if (change === "request") expect(JSON.parse(readFileSync(record.requestFile, "utf8")).requestId).toBe("another-request");
    } finally { resume(); h.releaseBuild?.(); h.service.stop(); }
  });

  const custodyActions = ["Update", "Retry", "web", "runtime-host"] as const;
  for (const delayed of custodyActions) for (const accepted of custodyActions) {
    if (delayed === accepted && (delayed === "Update" || delayed === "Retry")) continue;
    // Update and Retry have different initial prerequisites; their identical
    // apply reservation is exercised above with two eligible callers.
    if ([delayed, accepted].includes("Retry") && [delayed, accepted].includes("Update")) continue;
    test(`final custody gate preserves accepted ${accepted} against delayed ${delayed}`, async () => {
      const retry = [delayed, accepted].includes("Retry");
      const h = harness({ holdBuild: true, failBuildOnce: retry, relaunch: true });
      setSelfUpdateServiceForTests(h.service);
      let releaseObservation = () => {};
      const observation = new Promise<void>(resolve => { releaseObservation = resolve; });
      let reached = () => {};
      const barrier = new Promise<void>(resolve => { reached = resolve; });
      let reads = 0;
      const invoke = (action: typeof delayed) => action === "Update" || action === "Retry"
        ? updatePost(post("/update", { key: action, retry: action === "Retry" }))
        : postRestart(post("/restart", { role: action, confirm: true }));
      try {
        await postCheck(post("/check")); await until(next => next.check.state === "update-available");
        if (retry) {
          expect((await updatePost(post("/update", { key: "failed-first" }))).status).toBe(202);
          await until(next => next.update.state === "failed");
        }
        // The delayed action's admission snapshot (Update and Retry read an
        // initial one first) is held after it computed busy:null.
        const snapshot = h.service.snapshot.bind(h.service);
        h.service.snapshot = async () => {
          const read = ++reads;
          const result = await snapshot();
          if (read === (delayed === "Update" || delayed === "Retry" ? 2 : 1)) { reached(); await observation; }
          return result;
        };
        const losing = invoke(delayed);
        await Promise.race([barrier, Bun.sleep(3000).then(() => { throw new Error("Admission observation missed barrier"); })]);
        expect((await invoke(accepted)).status).toBe(202);
        if (accepted === "Update" || accepted === "Retry") {
          await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
          await until(() => existsSync(readLauncherRecord(h.recordFile)!.requestFile));
        }
        const requestFile = readLauncherRecord(h.recordFile)!.requestFile;
        const original = readFileSync(requestFile, "utf8");
        const applyFile = join(h.deps.dir, "apply.json");
        const intent = existsSync(applyFile) ? readFileSync(applyFile, "utf8") : null;
        releaseObservation();
        const response = await losing;
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: `busy-${accepted === "Update" || accepted === "Retry" ? "update" : `restart-${accepted}`}` });
        expect(readFileSync(requestFile, "utf8")).toBe(original);
        if (intent) expect(readFileSync(applyFile, "utf8")).toBe(intent);
        else expect(existsSync(applyFile)).toBe(false);
        expect(JSON.parse(original).role).toBe(accepted === "Update" || accepted === "Retry" ? "relaunch" : accepted);
      } finally { releaseObservation(); h.releaseBuild?.(); h.service.stop(); }
    });
  }

  test.each(["operator", "seat"] as const)("disabled built-in updates settle a cold ready %s apply and release external deployment admission", async trigger => {
    const { ApplyController } = await import("./apply");
    const h = harness({ relaunch: true });
    const record = readLauncherRecord(h.recordFile)!;
    writeFileSync(h.recordFile, JSON.stringify({ ...record, launcher: { ...record.launcher, revision: firstSha, state: "healthy" } }));
    const controller = new ApplyController(h.deps.dir);
    const deploymentId = trigger === "seat" ? "suppressed-seat-deployment" : undefined;
    if (deploymentId) saveCheckoutDeployment(h.deps.dir, {
      deploymentId, idempotencyKey: "seat-ready-before-policy", requestedRevision: firstSha, revision: firstSha,
      phase: "building", terminal: false, candidate: null, previous: null,
      mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
      owner: { pid: record.launcher.pid, startIdentity: record.launcher.startIdentity },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revisionNumber: 1,
    });
    controller.begin(record, firstSha, trigger, deploymentId);
    controller.patch({ state: "ready" });
    h.service.stop();
    h.deps.env = { ...h.deps.env, LLV_DISABLE_SELF_UPDATE: "1" };
    h.deps.now = () => Date.now() + 7 * 24 * 60 * 60_000;
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service = new SelfUpdateService(h.deps);
    setSelfUpdateServiceForTests(h.service);
    try {
      expect((await h.service.snapshot()).selfUpdateDisabled).toBe(true);
      await h.service.autoTick();
      expect(existsSync(record.requestFile)).toBe(false);
      expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8"))).toMatchObject({ state: "failed", admissionRefused: true });
      if (deploymentId) expect(checkoutDeployments(h.deps.dir)[0]).toMatchObject({ deploymentId, phase: "failed", terminal: true, error: expect.stringContaining("administrator disabled") });
      expect(h.spawned).toEqual([]);
      const external = await deployPost(post("/runtime/deployments", { revision: firstSha, idempotencyKey: "after-disabled-" + trigger }));
      expect(external.status).toBe(202);
      expect(await external.json()).toMatchObject({ state: "accepted" });
      const builtIn = await updatePost(post("/update", { key: "still-disabled-" + trigger }));
      expect(builtIn.status).toBe(403);
      expect(await builtIn.json()).toMatchObject({ code: "updates-disabled" });
    } finally { h.service.stop(); }
  });

  for (const trigger of ["operator", "seat"] as const) test.each(["done", "rolled-back"] as const)(
    `disabled cold processes retain an accepted ${trigger} relaunch until verified %s`, async outcome => {
      const { ApplyController } = await import("./apply");
      const h = harness({ relaunch: true });
      h.service.stop();
      const record = readLauncherRecord(h.recordFile)!;
      const controller = new ApplyController(h.deps.dir);
      const at = "2030-01-01T00:00:00.000Z";
      const candidate = join(h.deps.dir, "accepted-release");
      await git(root, "clone", remote, candidate);
      mkdirSync(join(candidate, ".next"), { recursive: true });
      writeFileSync(join(candidate, ".next", "BUILD_ID"), "accepted-b\n");
      controller.begin(record, tipSha, trigger);
      controller.patch({ requestId: `policy-${trigger}-${outcome}`, startedAt: at, switchedAt: at,
        switchDeadlineAt: Date.parse(at) + 10 * 60_000 });
      writeFileSync(record.releasePointer, JSON.stringify({ sha: tipSha, dir: candidate, checkoutHead: firstSha }));
      controller.send(record);
      const drainFile = join(h.deps.dir, "auto-drain.json");
      const acceptedDrain = readFileSync(drainFile, "utf8");
      const run = async (healthy = true) => {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "__fixtures__/installationPolicy.child.ts")], {
          cwd: process.cwd(), env: { ...process.env, LLV_DISABLE_SELF_UPDATE: "1", DELEGATUS_DISABLE_SELF_UPDATE: undefined,
            POLICY_DIR: h.deps.dir, POLICY_RECORD: h.recordFile, POLICY_NOW: "2030-01-01T00:00:01.000Z", POLICY_HOST_HEALTH: healthy ? "1" : "0" },
          stdout: "pipe", stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        const result = JSON.parse(stdout);
        expect(result).toMatchObject({ disabled: true, update: { ok: false, status: 403, code: "updates-disabled" },
          admission: false, checks: 0, deployments: 0 });
        expect(result.drainAfterTick).toEqual(result.drain);
        return result;
      };
      for (let generation = 0; generation < 2; generation++) {
        expect(await run()).toMatchObject({ apply: { state: "switching" }, drain: { id: controller.current!.requestId, persistent: true } });
        expect(readFileSync(drainFile, "utf8")).toBe(acceptedDrain);
      }
      const serving = outcome === "done" ? tipSha : firstSha;
      if (outcome === "rolled-back") rmSync(record.releasePointer);
      record.web = { ...record.web, revision: serving.slice(0, 7) };
      record.runtimeHost = { ...record.runtimeHost, revision: serving.slice(0, 7) };
      record.launcher = { ...record.launcher, requestId: controller.current!.requestId, state: "healthy",
        revision: serving, error: outcome === "rolled-back" ? { kind: "fell-back", revision: tipSha.slice(0, 7), detail: "candidate health failed" } : null };
      writeFileSync(h.recordFile, JSON.stringify(record));
      expect(await run(false)).toMatchObject({ apply: { state: "switching" }, drain: { id: controller.current!.requestId } });
      expect(await run()).toMatchObject({ apply: { state: outcome === "done" ? "done" : "failed", rolledBack: outcome === "rolled-back" }, drain: null });
      expect(existsSync(drainFile)).toBe(false);
      expect(existsSync(record.requestFile)).toBe(false);
      // Reproduce a crash after the terminal write, before hold cleanup.
      writeFileSync(drainFile, acceptedDrain);
      writeAuto(join(h.deps.dir, "auto.json"), { ...initialAuto(), drain: {
        id: controller.current!.requestId, target: await readRevision(candidate, tipSha), since: at, overranAt: null, blockers: null,
      } });
      expect(await run(false)).toMatchObject({ drain: { id: controller.current!.requestId } });
      expect(await run()).toMatchObject({ drain: null });
    },
  );

  test("disabled recovery preserves a ready pointer already serving through a healthy successor bootstrap", async () => {
    const { ApplyController } = await import("./apply");
    const h = harness({ relaunch: true });
    const record = readLauncherRecord(h.recordFile)!;
    const baseline = join(h.deps.dir, "baseline-release");
    await git(root, "clone", remote, baseline);
    await git(baseline, "checkout", firstSha);
    mkdirSync(join(baseline, ".next"), { recursive: true });
    writeFileSync(join(baseline, ".next", "BUILD_ID"), "fixture-a\n");
    const baselinePointer = JSON.stringify({ sha: firstSha, dir: baseline, checkoutHead: firstSha });
    writeFileSync(record.releasePointer, baselinePointer);
    const candidate = join(h.deps.dir, "successor-release");
    await git(root, "clone", "--branch", "main", remote, candidate);
    mkdirSync(join(candidate, ".next"), { recursive: true });
    writeFileSync(join(candidate, ".next", "BUILD_ID"), "fixture-b\n");
    const controller = new ApplyController(h.deps.dir);
    controller.begin(record, tipSha, "operator");
    controller.patch({ state: "ready" });
    writeFileSync(record.releasePointer, JSON.stringify({ sha: tipSha, dir: candidate, checkoutHead: firstSha }));
    const successorIdentity = `${record.launcher.startIdentity}:successor`;
    writeFileSync(h.recordFile, JSON.stringify({ ...record,
      launcher: { ...record.launcher, startIdentity: successorIdentity, revision: tipSha, state: "healthy" },
      web: { ...record.web, revision: tipSha.slice(0, 7), state: "healthy" },
      runtimeHost: { ...record.runtimeHost, revision: tipSha.slice(0, 7), state: "healthy" },
    }));
    h.deps.env = { ...h.deps.env, LLV_DISABLE_SELF_UPDATE: "1" };
    h.deps.hostHealth = async () => ({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid)!, hostEpoch: 1 });
    h.service.stop();
    h.service = new SelfUpdateService(h.deps);
    setSelfUpdateServiceForTests(h.service);
    try {
      const result = await h.service.snapshot();
      expect(result.selfUpdateDisabled).toBe(true);
      expect(result.installed.sha).toBe(tipSha);
      expect(JSON.parse(readFileSync(record.releasePointer, "utf8"))).toMatchObject({ sha: tipSha, dir: candidate });
      expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8"))).toMatchObject({ state: "done", target: tipSha });
      expect(existsSync(record.requestFile)).toBe(false);
      expect(await updatePost(post("/update", { key: "bootstrap-policy-disabled" })).then(response => response.status)).toBe(403);
    } finally { h.service.stop(); }
  });

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

  test.each([[40, false], [9, false], [40, true], [9, true]] as const)("a checkout exact deploy is idempotent, applies once and settles its seat receipt (%s characters, built-in disabled: %s)", async (length, disabled) => {
    const h = harness();
    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.deps.env = { ...h.deps.env, LLV_DISABLE_SELF_UPDATE: disabled ? "1" : "0" };
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const body = { revision: tipSha.slice(0, length), idempotencyKey: "checkout-exact-press" };
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

  test("deployment status preserves the failed build cause after service replacement", async () => {
    const h = harness({ failBuildOnce: true, relaunch: true });
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    try {
      const response = await deployPost(post("/runtime/deployments", { revision: tipSha, idempotencyKey: "failed-build-detail" }));
      expect(response.status).toBe(202);
      const receipt = await response.json();
      await until(next => next.update.state === "failed");
      const read = () => ledgerDeployment(receipt.deploymentId, { NODE_ENV: "test", LLV_STATE_DIR: h.deps.dir.replace(/self-update$/, "") });
      expect(read()).toMatchObject({ state: "ok", value: { phase: "failed", terminal: true, error: "Release build failed: exit 1" } });
      h.service.saveNow(); h.service.stop();
      h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
      await snapshot();
      await until(next => next.check.state !== "checking");
      expect(read()).toMatchObject({ state: "ok", value: { error: "Release build failed: exit 1" } });
    } finally { h.service.stop(); }
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
    expect(JSON.parse(readFileSync(join(h.deps.dir, "deployments.json"), "utf8"))[0]).toMatchObject({ phase: "succeeded", terminal: true,
      servingProgress: "Already serving the requested revision; nothing was restarted." });
    expect(existsSync(join(h.deps.dir, "apply.json"))).toBe(false); expect(existsSync(record.requestFile)).toBe(false);
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const status = checkoutDeployments(h.deps.dir)[0]!;
    const notice = "Already serving the requested revision; nothing was restarted.";
    expect(status.servingProgress).toBe(notice);
    expect(compactDeployment(status)).toMatchObject({ servingProgress: notice });
    expect(viewerDeploymentSummary(status)).toMatchObject({ servingProgress: notice });
    expect(viewerDeploymentPage([status], 1, null, true).deployments[0]).toMatchObject({ servingProgress: notice });
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

  test.each([false, true])("attributable exact deployment rechecks authority after green lookup (revoked: %s)", async revoked => {
    const h = harness({ holdBuild: true });
    const record = JSON.parse(readFileSync(h.recordFile, "utf8")); record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    let releaseGreen!: (value: GreenVerdict) => void; let entered!: () => void; let greenReady = false;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    h.deps.green = { read: () => { entered(); return greenReady ? Promise.resolve({ state: "green" })
      : new Promise<GreenVerdict>(resolve => { releaseGreen = resolve; }); } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check")); await until(next => next.check.state === "update-available");
    let allowed = true;
    const attempt = h.service.deployRevision({ revision: tipSha, idempotencyKey: `attributable-${revoked}` },
      () => { if (!allowed) throw new Error("proactive deployment authority revoked"); });
    const observed = attempt.then(value => ({ value, error: null }), error => ({ value: null, error: error as Error }));
    await reading;
    allowed = !revoked;
    greenReady = true;
    releaseGreen({ state: "green" });
    const result = await observed;
    if (revoked) {
      expect(result.error?.message).toBe("proactive deployment authority revoked");
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
      expect(existsSync(record.requestFile)).toBe(false);
      allowed = true;
      expect(await h.service.deployRevision({ revision: tipSha, idempotencyKey: `attributable-${revoked}` },
        () => { if (!allowed) throw new Error("proactive deployment authority revoked"); }))
        .toMatchObject({ state: "accepted", revision: tipSha });
    } else {
      expect(result.value).toMatchObject({ state: "accepted", revision: tipSha });
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
    }
    await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
    await until(() => existsSync(record.requestFile));
  });

  test("checkout reconciliation closes a key during green lookup before a delayed POST can admit", async () => {
    const h = harness({ holdBuild: true });
    const record = JSON.parse(readFileSync(h.recordFile, "utf8")); record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<GreenVerdict>();
    h.deps.green = { read: () => { entered.resolve(); return held.promise; } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check")); await until(next => next.check.state === "update-available");
    const request = { revision: tipSha, idempotencyKey: "checkout-fenced-key" };
    const attempt = deployPost(post("/runtime/deployments", request));
    try {
      await entered.promise;
      const reconciliation = await deployPost(post("/runtime/deployments", { ...request, reconcileOnly: true }));
      expect(reconciliation.status).toBe(409);
      expect(await reconciliation.json()).toMatchObject({ code: "deploy_not_admitted", outcome: "not-executed", evidence: "not-admitted" });
      held.resolve({ state: "green" });
      expect(await (await attempt).json()).toMatchObject({ code: "deploy_not_admitted" });
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
      expect(existsSync(record.requestFile)).toBe(false);
      h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
      expect(await (await deployPost(post("/runtime/deployments", request))).json()).toMatchObject({ code: "deploy_not_admitted" });
      expect(await (await deployPost(post("/runtime/deployments", { ...request, revision: firstSha, reconcileOnly: true }))).json()).toMatchObject({ error: "idempotency-conflict" });
      const child = Bun.spawn([process.execPath, "-e", `
        import { SelfUpdateService } from "./src/lib/selfUpdate/service";
        import { productionDeps } from "./src/lib/selfUpdate/instance";
        const service = new SelfUpdateService({ ...productionDeps(), dir: process.argv[1],
          mode: async () => { throw Error("closed keys must not reach launcher reads"); } });
        try {
          await service.deployRevision(JSON.parse(process.argv[2]));
          console.log("unexpected admission");
        } catch (error) { console.log(error.code); }
        finally { service.stop(); }
      `, h.deps.dir, JSON.stringify(request)], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr, answer: stdout.trim() }).toEqual({ code: 0, stderr: "", answer: "deploy_not_admitted" });
    } finally { held.resolve({ state: "green" }); await attempt; }
  });

  test("HTTP proactive deployment retains its authority check through the service's green wait", async () => {
    const h = harness({ holdBuild: true });
    const record = JSON.parse(readFileSync(h.recordFile, "utf8")); record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    let releaseGreen!: (value: GreenVerdict) => void; let entered!: () => void; let greenReady = false;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    h.deps.green = { read: () => { entered(); return greenReady ? Promise.resolve({ state: "green" })
      : new Promise<GreenVerdict>(resolve => { releaseGreen = resolve; }); } } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await postCheck(post("/check")); await until(next => next.check.state === "update-available");
    const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
    const { candidate, context, authority } = await import("@/lib/tasks/proactive.fixture");
    const { agentRegistry } = await import("@/lib/agent/registry");
    const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
    const project = "proactive-http-deploy";
    const { task } = await admitProactiveTask({ ...candidate("http-deploy"), project }, { ...context(), project }, undefined, authority());
    const decide = (decision: "adopt" | "reject") => decideProactiveTask(task.id, decision, "operator", proactiveDecisionToken(task));
    await decide("adopt");
    const registry = agentRegistry();
    const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: checkout, taskIds: [task.id], origin: { kind: "operator" } });
    if (begun.kind !== "created") throw new Error("expected a fresh launch");
    const capability = registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
    const request = () => {
      const value = post("/runtime/deployments", { revision: tipSha, idempotencyKey: "proactive-http-green-wait" });
      value.headers.set(VIEWER_SPAWN_CAPABILITY_HEADER, capability);
      return value;
    };
    try {
      const response = deployPost(request());
      await Promise.race([reading, response.then(async result => { throw new Error(`HTTP completed before green (${result.status}): ${await result.text()}`); })]);
      await decide("reject"); greenReady = true; releaseGreen({ state: "green" });
      expect((await response).status).toBe(403);
      expect(checkoutDeployments(h.deps.dir)).toEqual([]);
      await decide("adopt");
      expect((await deployPost(request())).status).toBe(202);
      expect(checkoutDeployments(h.deps.dir)).toHaveLength(1);
      await until(() => h.releaseBuild !== null); h.releaseBuild!(); h.releaseBuild = null;
      await until(() => existsSync(record.requestFile));
    } finally {
      registry.failStructuredSpawn(begun.receipt.launchId, "fixture completed before dispatch", { announce: false });
      greenReady = true; releaseGreen?.({ state: "green" });
    }
  });

  /* A launcher started in a multiplexer pane sits in that unit's cgroup.
     Restarting the unit would end every pane and bring no launcher back. */
  test.each(["built", "unbuilt"] as const)("a unit not proven to be this launcher's service is never restarted, by the dialog or by a seat: %s", async built => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    const calls: string[][] = []; const asked: string[] = [];
    const proven = (unit: string) => { asked.push(unit); return false; };
    h.deps.install = {
      action: decision => installAction(decision, { cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/tmux.service\n", ready: () => built === "built", env: {}, proven }),
      run: action => runInstallAction(action, args => calls.push(args), undefined, { root: checkout, launcherPid: record.launcher.pid }, proven),
      entry: () => join(checkout, "bin", "cli.mjs"), unit: () => launcherService(record.launcher.pid, checkout, () => "0::/user.slice/user-1000.slice/user@1000.service/tmux.service\n", proven),
    };
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const action = (await snapshot()).action;
    if (built === "built") {
      expect(action).toMatchObject({ id: "restart-terminal", button: false });
      expect(action?.unit).toBeUndefined();
      expect(asked).toContain("tmux.service");
    } else expect(action).toMatchObject({ id: "update-first", button: true });
    await until(next => next.check.state !== "checking");
    const receipt = await h.service.deployRevision({ revision: tipSha, idempotencyKey: `unproven-unit-${built}` });
    expect(receipt).toMatchObject({ state: "action-required", code: "self-update-action-required", action: { id: built === "built" ? "restart-terminal" : "update-first" } });
    expect(await h.service.performInstallAction()).toMatchObject({ ok: false, status: 409, code: "cannot-restart" });
    expect(calls).toEqual([]);
    expect(existsSync(join(h.deps.dir, "apply.json"))).toBe(false);
    expect(existsSync(join(h.deps.dir, "deployments.json"))).toBe(false);
  });

  /* An ordinary systemd install: the unit is written with a specifier, and
     after the first self-update its main process is the bootstrap whose child
     is the recorded launcher. Either is this launcher's service. */
  for (const disabled of [false, true]) test.each(["completed", "rolled-back", "refused"] as const)(`external legacy service deployment is %s with built-in updates disabled=${disabled}`, async outcome => {
    const h = harness();
    const record = readLauncherRecord(h.recordFile)!;
    const calls: string[][] = [];
    h.deps.env = { ...h.deps.env, DELEGATUS_DISABLE_SELF_UPDATE: disabled ? "1" : "0" };
    h.deps.install = {
      action: decision => installAction(decision, { cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service", ready: () => true, env: {}, proven: () => true }),
      run: action => runInstallAction(action, args => {
        calls.push(args);
        if (outcome === "refused") throw new Error("fixture service manager refusal");
      }, undefined, { root: checkout, launcherPid: record.launcher.pid }, () => true),
      entry: () => join(checkout, "bin", "cli.mjs"), unit: () => "delegatus.service",
    };
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    const intentFile = join(h.deps.dir, "apply.json");
    const drainFile = join(h.deps.dir, "auto-drain.json");
    const intent = () => JSON.parse(readFileSync(intentFile, "utf8"));
    try {
      if (disabled) {
        for (const result of [await h.service.startUpdate("direct-update"), await h.service.retry("direct-retry"),
          await h.service.setAuto(true), await h.service.performInstallAction()])
          expect(result).toMatchObject({ ok: false, status: 403, code: "updates-disabled" });
        expect(calls).toEqual([]);
        expect(existsSync(intentFile)).toBe(false);
      }
      expect(await h.service.deployRevision({ revision: tipSha, idempotencyKey: `external-legacy-${disabled}-${outcome}` }))
        .toMatchObject({ state: "accepted", revision: tipSha });
      await until(() => existsSync(intentFile) && ["switching", "failed"].includes(intent().state));
      expect(calls).toHaveLength(1);
      expect(checkoutDeployments(h.deps.dir)[0]).toMatchObject({ phase: outcome === "refused" ? "failed" : "host-handoff", terminal: outcome === "refused" });
      if (outcome === "refused") {
        expect(intent()).toMatchObject({ state: "failed", detail: expect.stringContaining("service manager") });
        expect(existsSync(record.releasePointer)).toBe(false);
        expect(existsSync(launcherControlFile(record.requestFile, "trial"))).toBe(false);
        return;
      }
      expect(intent()).toMatchObject({ state: "switching", externalRestart: true, trigger: "seat" });
      // A replacement Viewer reads the real persisted apply and hold before
      // the launcher reports either a coherent target or a verified rollback.
      h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
      await h.service.autoTick();
      expect(intent().state).toBe("switching");
      expect(JSON.parse(readFileSync(drainFile, "utf8")).id).toBe(intent().requestId);
      const revision = outcome === "completed" ? tipSha : firstSha;
      writeFileSync(h.recordFile, JSON.stringify({ ...record,
        launcher: { ...record.launcher, relaunch: 1, state: "healthy", revision, requestId: intent().requestId },
        web: { ...record.web, revision: revision.slice(0, 7) }, runtimeHost: { ...record.runtimeHost, revision: revision.slice(0, 7) },
      }));
      if (outcome === "rolled-back") {
        rmSync(record.releasePointer);
        const trialFile = launcherControlFile(record.requestFile, "trial");
        writeFileSync(trialFile, JSON.stringify({ ...JSON.parse(readFileSync(trialFile, "utf8")), state: "rolled-back", detail: "fixture candidate failed health" }));
      }
      await h.service.snapshot();
      expect(intent()).toMatchObject({ state: outcome === "completed" ? "done" : "failed", rolledBack: outcome === "rolled-back" });
      expect(checkoutDeployments(h.deps.dir)[0]).toMatchObject({ phase: outcome === "completed" ? "succeeded" : "rolled-back", terminal: true });
      expect(existsSync(drainFile)).toBe(false);
      expect(calls).toHaveLength(1);
    } finally { h.service.stop(); }
  });

  test.each(["expanded command", "bootstrap parent"] as const)("a unit proven by its %s is offered for restart and lets a seat deploy", async proof => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    const unit = "delegatus.service", entry = join(checkout, "bin", "cli.mjs"), bootstrap = 4242;
    const shown = (start: string, main: number) => `MainPID=${main}\nExecStart={ path=${start.split(" ")[0]} ; argv[]=${start} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=${main} ; code=(null) ; status=0/0 }\nWorkingDirectory=${checkout}\n`;
    const proven = (name: string, root: string, pid?: number) => unitRunsLauncher(name, root, pid, proof === "expanded command"
      ? { show: () => shown(`/srv/operator/.bun/bin/bun ${entry} --no-open`, bootstrap), parent: () => null, argv: () => [], cwd: () => null }
      : { show: () => shown("/usr/local/bin/start-delegatus", bootstrap), parent: pid => pid === record.launcher.pid ? bootstrap : null,
        argv: () => ["/usr/bin/bun", "bin/cli.mjs", "--no-open"], cwd: () => checkout });
    const cgroup = () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;
    const calls: string[][] = [];
    h.deps.install = {
      action: decision => installAction(decision, { cgroup, ready: () => true, env: {}, proven }),
      run: action => runInstallAction(action, args => calls.push(args), undefined, { root: checkout, launcherPid: record.launcher.pid }, proven),
      entry: () => entry, unit: () => launcherService(record.launcher.pid, checkout, cgroup, proven),
    };
    h.deps.green = { read: async () => ({ state: "green" }) } as unknown as GreenReader;
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    expect((await snapshot()).action).toEqual({ id: "restart-service", button: true, unit });
    await until(next => next.check.state !== "checking");
    const deploymentId = `existing-${proof.replace(" ", "-")}`;
    saveCheckoutDeployment(h.deps.dir, {
      deploymentId, idempotencyKey: "original-deploy", requestedRevision: tipSha, revision: tipSha,
      phase: "building", terminal: false, candidate: null, previous: null,
      mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
      owner: { pid: record.launcher.pid, startIdentity: record.launcher.startIdentity },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revisionNumber: 1,
    });
    const joinKey = `same-sha-join-${proof.replace(" ", "-")}`;
    const originalAdmission = deploymentAdmission.checkoutAdmission;
    let admissionCalls = 0;
    const hook = spyOn(deploymentAdmission, "checkoutAdmission").mockImplementation((directory, request, authorize, admit, options) => {
      if (request.idempotencyKey !== joinKey || ++admissionCalls !== 2) return originalAdmission(directory, request, authorize, admit, options);
      return originalAdmission(directory, request, () => {
        authorize?.();
        const current = checkoutDeployments(directory).find(row => row.deploymentId === deploymentId)!;
        saveCheckoutDeployment(directory, { ...current, phase: "post-promotion-health", servingProgress: "waiting for readiness", revisionNumber: 2 });
      }, admit, options);
    });
    try {
      expect(await h.service.deployRevision({ revision: tipSha, idempotencyKey: joinKey }))
        .toMatchObject({ state: "accepted", deploymentId, revision: tipSha, replayed: false });
      expect(checkoutDeployments(h.deps.dir).find(row => row.deploymentId === deploymentId))
        .toMatchObject({ phase: "post-promotion-health", servingProgress: "waiting for readiness", revisionNumber: 2 });
    } finally { hook.mockRestore(); }
    expect(await h.service.deployRevision({ revision: "b".repeat(40), idempotencyKey: `different-sha-${proof.replace(" ", "-")}` }))
      .toMatchObject({ state: "busy", deploymentId });
    const joined = checkoutDeployments(h.deps.dir).find(row => row.deploymentId === deploymentId)!;
    expect(joined.idempotencyKeys).toContain(joinKey);
    saveCheckoutDeployment(h.deps.dir, { ...joined, phase: "succeeded", terminal: true });
    expect(await h.service.deployRevision({ revision: tipSha, idempotencyKey: joinKey }))
      .toMatchObject({ state: "accepted", deploymentId, replayed: true });
  });

  test.each(["accepted", "refused", "overlap"])("legacy service with an existing built pointer handles %s handoff without an apply intent", async outcome => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    h.deps.bun = process.execPath;
    const releaseDir = join(h.deps.dir, "built-release");
    await git(checkout, "fetch", "origin");
    const checkoutResult = await runGit(["worktree", "add", "--detach", releaseDir, tipSha], checkout);
    if (checkoutResult.code !== 0) throw new Error(checkoutResult.stderr);
    mkdirSync(join(releaseDir, ".next")); writeFileSync(join(releaseDir, ".next", "BUILD_ID"), "fixture");
    mkdirSync(join(releaseDir, "bin")); writeFileSync(join(releaseDir, "bin", "launcher-relaunch.mjs"), "delegatus-launcher-relaunch-v1");
    const entered = join(releaseDir, "preflight-entered");
    const released = join(releaseDir, "preflight-released");
    writeFileSync(join(releaseDir, "bin", "cli.mjs"), outcome === "overlap"
      ? `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(entered)}, ""); while (!fs.existsSync(${JSON.stringify(released)})) await new Promise(r => setTimeout(r, 5));`
      : 'process.stdout.write("fixture version\\n");');
    const pointer = JSON.stringify({ sha: tipSha, dir: releaseDir, checkoutHead: firstSha }); writeFileSync(record.releasePointer, pointer);
    const calls: string[][] = [];
    h.deps.install = {
      action: decision => installAction(decision, { cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service", ready: () => true, proven: () => true }),
      run: action => { if (outcome === "refused") throw new Error("manager unavailable"); runInstallAction(action, args => calls.push(args), undefined, { root: checkout, launcherPid: record.launcher.pid }, () => true); }, entry: () => join(checkout, "bin", "cli.mjs"),
    };
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    expect((await snapshot()).action?.id).toBe("restart-service");
    await until(next => next.check.state !== "checking");
    const first = h.service.performInstallAction();
    if (outcome === "overlap") {
      try {
        const deadline = Date.now() + 2_000;
        while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
        expect(existsSync(entered)).toBe(true);
        expect(await h.service.performInstallAction()).toMatchObject({ ok: false, status: 409 });
        expect(calls).toHaveLength(0);
      } finally { writeFileSync(released, ""); await first; }
    }
    const result = await first;
    if (outcome === "refused") {
      expect(result).toMatchObject({ ok: false, status: 503 });
      expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8"))).toMatchObject({ state: "failed" });
      expect(existsSync(record.requestFile.replace(/^(.+\/)request/, "$1trial"))).toBe(false);
      expect(existsSync(record.releasePointer)).toBe(false);
      return;
    }
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.slice(-4)).toEqual(["systemctl", "--user", "restart", "delegatus.service"]);
    expect(JSON.parse(readFileSync(join(h.deps.dir, "apply.json"), "utf8"))).toMatchObject({ state: "switching", target: tipSha, rollbackPointer: null,
      rollbackWebRevision: firstSha.slice(0, 7), rollbackHostRevision: firstSha.slice(0, 7), externalRestart: true });
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

  test("an up-to-date relaunch-capable checkout without a pointer needs no prerequisite rebuild", async () => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8")); record.launcher.relaunch = 1;
    writeFileSync(h.recordFile, JSON.stringify(record));
    const target = await readRevision(checkout, "HEAD");
    h.deps.check = async () => ({ ok: true, installed: target, available: null, relation: "equal", ahead: 0, behind: 0, delta: null });
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await h.service.check();
    expect((await h.service.snapshot()).action).toBeNull();
    expect(await h.service.startUpdate("already-supervised")).toMatchObject({ ok: false, code: "no-update" });
    expect(h.spawned).toEqual([]);
  });

  test.each(["green", "red", "pending", "unknown"] as const)("legacy update-first builds a green installed SHA without a previous pointer: %s", async verdict => {
    const h = harness(); const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    const target = await readRevision(checkout, "HEAD");
    h.deps.remote = "https://github.com/example/fixture.git";
    h.deps.check = async () => ({ ok: true, installed: target, available: null, relation: "equal", ahead: 0, behind: 0, delta: null });
    let builds = 0; const reads: unknown[][] = [];
    h.deps.green = { read: async (...args: unknown[]) => { reads.push(args); return { state: verdict }; } } as unknown as GreenReader;
    h.deps.createRunner = () => ({ state: idleUpdate(["fetch", "install", "build", "ready"]), restore() {}, logPath: () => "",
      async start() { builds++; }, async retry() { throw new Error("not a retry"); } });
    h.service.stop(); h.service = new SelfUpdateService(h.deps); setSelfUpdateServiceForTests(h.service);
    await h.service.check();
    expect((await h.service.snapshot())).toMatchObject({ check: { state: "up-to-date" }, action: { id: "update-first", button: true } });
    expect(existsSync(record.releasePointer)).toBe(false);
    const result = await h.service.startUpdate("legacy-prerequisite-build");
    expect(result).toMatchObject(verdict === "green" ? { ok: true } : { ok: false, code: "deployment-refused", detail: verdict });
    expect(reads).toEqual([[h.deps.remote, h.deps.branch, target.sha, checkout]]);
    expect(builds).toBe(verdict === "green" ? 1 : 0);
    await Bun.sleep(10);
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
  test("a legacy staged build retains full apply custody until its launcher prerequisite", async () => {
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

    const intent = readFileSync(join(h.deps.dir, "apply.json"), "utf8");
    expect(JSON.parse(intent).state).toBe("ready");
    expect((await postRestart(post("/restart", { role: "runtime-host" }))).status).toBe(400);
    for (const role of ["web", "runtime-host"]) {
      const refusal = await postRestart(post("/restart", { role, confirm: true }));
      expect(refusal.status).toBe(409);
      expect(await refusal.json()).toMatchObject({ code: "busy-update" });
    }
    expect(readFileSync(join(h.deps.dir, "apply.json"), "utf8")).toBe(intent);
    expect(existsSync(readLauncherRecord(h.recordFile)!.requestFile)).toBe(false);

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


test.each([
  ["1.9.1", "1.10.0", "behind"],
  ["1.10.0", "1.10.0", "equal"],
  ["1.10.0", "1.9.1", "ahead"],
  ["1.10.0-rc.2", "1.10.0-rc.10", "behind"],
  ["1.10.0-rc.10", "1.10.0-rc.2", "ahead"],
  ["1.10.0-rc.1", "1.10.0", "behind"],
  ["1.10.0", "1.10.0-rc.1", "ahead"],
  ["1.10.0-alpha", "1.10.0-alpha.1", "behind"],
  ["1.10.0-beta", "1.10.0-alpha", "ahead"],
] as const)("production package check orders installed %s against latest %s", async (installed, latest, relation) => {
  const dir = mkdtempSync(join(root, "package-order-"));
  const installRoot = join(dir, "package"); mkdirSync(installRoot);
  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version: installed }));
  const record = {
    version: 1, launcher: { pid: process.pid, startIdentity: readStartIdentity(process.pid), revision: null },
    web: { ...stoppedProcess(), startIdentity: null, requestId: null },
    runtimeHost: { ...stoppedProcess(), startIdentity: null, requestId: null }, checkout: null, installRoot,
    releasePointer: join(dir, "release.json"), releasesDir: join(dir, "releases"), requestFile: join(dir, "request.json"),
    port: 3000, socket: join(dir, "runtime.sock"), updatedAt: new Date().toISOString(),
  } as LauncherRecord;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const version = String(input).endsWith("/latest") ? latest : installed;
    return Response.json({ version, gitHead: version === installed ? "a".repeat(40) : tipSha });
  }) as typeof fetch);
  const service = new SelfUpdateService(baseDeps(dir, { mode: async () => ({ mode: "package", reason: null, record }) }));
  try {
    await service.check();
    const result = await service.snapshot();
    expect(result.installed?.version).toBe(installed);
    expect(result.check).toMatchObject({ relation, state: relation === "behind" ? "update-available" : "up-to-date",
      behind: relation === "behind" ? 1 : 0, ahead: relation === "ahead" ? 1 : 0 });
    expect(result.available?.version ?? null).toBe(relation === "behind" ? latest : null);
  } finally { service.stop(); fetcher.mockRestore(); }
});

/* The registry as it answers today: no published version carries a revision,
   and an installed version may be one the registry never had. */
test.each(["published", "never-published"] as const)("a package install checks against the registry as it answers, installed version %s", async installedShape => {
  const published = readFileSync(join(import.meta.dir, "__fixtures__", "registry-delegatus-cli-1.9.0.json"), "utf8");
  const dir = mkdtempSync(join(root, "package-registry-"));
  const installRoot = join(dir, "package"); mkdirSync(installRoot);
  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.8.0" }));
  const record = {
    version: 1, launcher: { pid: process.pid, startIdentity: readStartIdentity(process.pid), revision: null, relaunch: 1 },
    web: { ...stoppedProcess(), startIdentity: null, requestId: null },
    runtimeHost: { ...stoppedProcess(), startIdentity: null, requestId: null }, checkout: null, installRoot,
    releasePointer: join(dir, "release.json"), releasesDir: join(dir, "releases"), requestFile: join(dir, "request.json"),
    port: 3000, socket: join(dir, "runtime.sock"), updatedAt: new Date().toISOString(),
  } as LauncherRecord;
  const asked: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    asked.push(String(input));
    if (String(input).endsWith("/latest")) return new Response(published, { headers: { "content-type": "application/json" } });
    if (installedShape === "never-published") return new Response('"version not found: 1.8.0"', { status: 404 });
    return Response.json({ ...JSON.parse(published), version: "1.8.0" });
  }) as typeof fetch);
  const service = new SelfUpdateService(baseDeps(dir, { mode: async () => ({ mode: "package", reason: null, record }) }));
  try {
    await service.check();
    const result = await service.snapshot();
    expect(asked.sort()).toEqual(["https://registry.npmjs.org/delegatus-cli/1.8.0", "https://registry.npmjs.org/delegatus-cli/latest"]);
    expect(result.check).toMatchObject({ state: "update-available", relation: "behind", error: null });
    expect(result.available).toMatchObject({ version: "1.9.0", sha: "" });
    expect(result.installed.version).toBe("1.8.0");
    // The version is named; nothing unverified is installed from the dialog.
    expect(await service.startUpdate("package-registry")).toMatchObject({ ok: false, status: 409, code: "cannot-update" });
    expect(existsSync(join(dir, "apply.json"))).toBe(false);
    await expect(service.deployRevision({ revision: tipSha, idempotencyKey: "package-registry" })).rejects.toThrow("no published package");
  } finally { service.stop(); fetcher.mockRestore(); }
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
  const registry = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const version = String(input).split("/").pop();
    return Response.json({ version: version === "latest" ? "1.0.3" : version, gitHead: version === "1.0.1" ? tipSha : "c".repeat(40) });
  }) as typeof fetch);
  try {
    const before = await service.snapshot();
    expect(before.installed.version).toBe(expectedVersion);
    if (shape !== "valid") expect(before.installed.sha).not.toBe(tipSha);
    await service.check();
    expect((await service.snapshot()).installed).toMatchObject({ version: expectedVersion, sha: shape === "valid" ? tipSha : "c".repeat(40) });
  } finally { service.stop(); registry.mockRestore(); }
});

for (const operation of ["update", "retry", "deploy", "rebuild"] as const) test.each(["green", "red", "fetch-failed"] as const)(`clean package ${operation} fetches its published source before real green admission: %s`, async verdict => {
  const dir = mkdtempSync(join(root, "package-empty-repo-")); const installRoot = join(dir, "package"); mkdirSync(installRoot);
  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.0" }));
  const repo = await prepareManagedCheckRepo(join(dir, "check.git"), join(dir, "missing", "objects"));
  const forge = "https://github.com/example/fixture.git";
  await git(repo, "config", `url.${verdict === "fetch-failed" ? join(dir, "unavailable.git") : remote}.insteadOf`, forge);
  const expected = verdict === "fetch-failed" ? "unknown" : verdict;
  const targetSha = operation === "rebuild" ? firstSha : tipSha;
  const record = { version: 1, checkout: null, installRoot, releasePointer: join(dir, "release.json"), releasesDir: join(dir, "releases"), requestFile: join(dir, "request.json"),
    port: 3000, socket: join(dir, "host.sock"), launcher: { pid: 1, startIdentity: "1", relaunch: operation === "rebuild" ? undefined : 1, state: "healthy" },
    web: { state: "healthy", pid: 2, startIdentity: "2", revision: firstSha.slice(0, 7), error: null }, runtimeHost: { state: "healthy", pid: 3, startIdentity: "3", revision: firstSha.slice(0, 7), error: null } } as LauncherRecord;
  const target = { version: operation === "rebuild" ? "1.0.0" : "1.0.1", sha: targetSha, short: targetSha.slice(0, 7), date: "" };
  const update = operation === "retry" ? { ...idleUpdate(["fetch", "install", "ready"]), state: "failed", target: tipSha, targetVersion: target.version } : null;
  writeFileSync(join(dir, "state.json"), JSON.stringify({ slice: { ...initialCheck(), installed: operation === "rebuild" ? target : null, available: operation === "rebuild" ? null : target, check: { ...initialCheck().check, state: operation === "rebuild" ? "up-to-date" : "update-available", relation: operation === "rebuild" ? "equal" : "behind" } }, update }));
  const tree = await git(work, "rev-parse", `${targetSha}^{tree}`);
  const reader = new GreenReader({ now: Date.now, treeOf: async (directory, sha) => {
    const result = await runGit(["rev-parse", "--verify", `${sha}^{tree}`], directory);
    if (result.code !== 0) throw new Error("target tree is unreadable"); return result.stdout.trim();
  }, fetch: (async input => {
    const url = String(input);
    return Response.json(url.includes("/pulls") ? [{ merged_at: "2026-01-01", merge_commit_sha: targetSha, base: { ref: "main" }, head: { sha: targetSha } }]
      : url.includes("/check-runs") ? { check_runs: [{ name: "test", status: "completed", conclusion: verdict === "green" ? "success" : "failure" }] }
      : url.includes("/statuses") ? [] : url.includes("/branches/") ? { protected: false } : { commit: { tree: { sha: tree } } });
  }) as typeof fetch });
  const service = new SelfUpdateService(baseDeps(dir, { remote: forge, mode: async () => ({ mode: "package", reason: null, record }), prepareCheckRepo: async () => repo, green: reader }));
  let deliveryReads = 0;
  const registry = spyOn(globalThis, "fetch").mockImplementation((async input => {
    if (String(input).endsWith("/latest")) return Response.json({ version: target.version, gitHead: targetSha });
    deliveryReads++; throw new Error("fixture package delivery boundary");
  }) as typeof fetch);
  try {
    expect((await runGit(["cat-file", "-e", `${targetSha}^{commit}`], repo)).code).not.toBe(0);
    if (operation === "deploy") {
      const attempt = service.deployRevision({ revision: tipSha, idempotencyKey: "fresh-package-deploy" });
      if (verdict === "green") expect(await attempt).toMatchObject({ state: "accepted", revision: tipSha });
      else expect(await attempt).toMatchObject({ state: "refused", code: "deploy_not_green", green: { state: expected } });
    } else {
      const result = operation !== "retry" ? await service.startUpdate("fresh-package-update") : await service.retry("fresh-package-retry");
      expect(result).toMatchObject(verdict === "green" ? { ok: true } : { ok: false, code: "deployment-refused", detail: expected });
    }
    expect((await runGit(["cat-file", "-e", `${targetSha}^{commit}`], repo)).code === 0).toBe(verdict !== "fetch-failed");
    await Bun.sleep(10);
    expect(deliveryReads).toBe(verdict === "green" ? 1 : 0);
    expect(existsSync(record.releasePointer)).toBe(false);
  } finally { await Bun.sleep(10); service.stop(); registry.mockRestore(); }
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
