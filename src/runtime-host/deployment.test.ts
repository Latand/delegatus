import { NextRequest } from "next/server";
import { DELETE as cancelDeploymentRoute } from "@/app/api/runtime/deployments/[deploymentId]/route";

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import type { ViewerDeploymentStatus, ViewerReleaseIdentity } from "@/lib/runtime/contracts";
import { runtimeHostClient, UnixRuntimeHostClient } from "@/lib/runtime/client";
import { initialAuto, readAuto, writeAuto } from "@/lib/selfUpdate/auto";
import { initialCheck } from "@/lib/selfUpdate/checkState";
import { productionDeps } from "@/lib/selfUpdate/instance";
import { managedIdempotencyKey, readManagedRecord } from "@/lib/selfUpdate/managed";
import { SelfUpdateService, type ServiceDeps } from "@/lib/selfUpdate/service";
import { idleCheck, type Revision } from "@/lib/selfUpdate/types";

import { CANDIDATE_PERFORMANCE_BOUNDS } from "./candidatePerformance";
import { ViewerDeploymentCoordinator } from "./deployment";
import { FakeDeploymentAdapter, healthy, release } from "./fixtures/fakeDeploymentAdapter";
import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";
import { viewerCandidateDockerArgs, viewerComposeServiceFromConfig } from "./candidateContainer";
import { RuntimeHost } from "./host";
import { RuntimeJournal } from "./journal";
import { serveRuntimeHost } from "./socket";
import { currentRuntimeHostGeneration, writeRuntimeHostRelease } from "./hostRelease";

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function journal(name: string): RuntimeJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `llv-deploy-${name}-`));
  sandboxes.push(dir);
  return new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => 1_000 });
}

function journalFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `llv-deploy-${name}-`));
  sandboxes.push(dir);
  return path.join(dir, "runtime.sqlite");
}

async function recoverHostHandoffAsSuccessor(
  store: RuntimeJournal,
  adapter: FakeDeploymentAdapter,
  deploymentId: string,
  candidate: ViewerReleaseIdentity,
  owner: { pid: number; startIdentity: string },
) {
  const successor = new ViewerDeploymentCoordinator(store, adapter, owner, {
    ownerAlive: () => false,
    hostGeneration: () => ({ image: candidate.image, revision: candidate.revision }),
  });
  await successor.recover();
  return successor.waitForDeployment(deploymentId);
}

/* These cover admission, idempotency, ownership and health. Deploy authority
   lives with the designated agent at the MCP deploy binding (#795); admission
   takes any well-formed request from the local surfaces that reach it. */

test("deployment admission is serialized and idempotent", async () => {
  const store = journal("admission");
  const adapter = new FakeDeploymentAdapter();
  let releaseBuild!: () => void;
  adapter.buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const first = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-one" });
  const replay = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-one" });
  const busy = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-two" });

  expect(first).toMatchObject({ state: "accepted", replayed: false, revision: "a".repeat(40) });
  if (first.state !== "accepted") throw new Error("deployment was not accepted");
  expect(replay).toEqual({ ...first, replayed: true });
  expect(busy).toEqual({ state: "busy", deploymentId: first.deploymentId, revision: "a".repeat(40) });
  expect(adapter.calls.filter((call) => call.startsWith("resolve:"))).toEqual(["resolve:origin/main"]);
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);

  releaseBuild();
  await coordinator.waitForDeployment(first.deploymentId);
  expect(adapter.calls.some((call) => call.startsWith("retain-only:"))).toBe(true);
  store.close();
});

test("a matching busy SHA durably binds its join key through settlement and journal reopen", async () => {
  const file = journalFile("busy-join-key");
  const store = new RuntimeJournal(file, { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  let releaseBuild!: () => void;
  adapter.buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  const revision = "a".repeat(40);
  let closed = false;
  try {
    const first = await coordinator.requestViewerDeployment({ revision, idempotencyKey: "seat-a-key" });
    if (first.state !== "accepted") throw new Error("first deployment was not accepted");
    const joined = await coordinator.requestViewerDeployment({ revision, idempotencyKey: "seat-b-join" });
    expect(joined).toEqual({ state: "accepted", deploymentId: first.deploymentId, revision, replayed: false });
    expect(await coordinator.requestViewerDeployment({ revision: "b".repeat(40), idempotencyKey: "different-sha-key" }))
      .toEqual({ state: "busy", deploymentId: first.deploymentId, revision });
    expect(store.viewerDeploymentByIdempotencyKey("seat-b-join")).toMatchObject({
      deploymentId: first.deploymentId,
      idempotencyKey: "seat-b-join",
      requestedRevision: revision,
    });
    releaseBuild();
    await coordinator.waitForDeployment(first.deploymentId);
    store.close();
    closed = true;

    const reopened = new RuntimeJournal(file, { now: () => 2_000 });
    const replayCoordinator = new ViewerDeploymentCoordinator(reopened, new FakeDeploymentAdapter(), { pid: 11, startIdentity: "11:1" });
    expect(await replayCoordinator.requestViewerDeployment({ revision, idempotencyKey: "seat-b-join" }))
      .toEqual({ state: "accepted", deploymentId: first.deploymentId, revision, replayed: true });
    expect(reopened.viewerDeploymentByIdempotencyKey("seat-b-join")?.terminal).toBe(true);
    reopened.close();
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
  } finally {
    releaseBuild();
    if (!closed) store.close();
  }
});

test("same-SHA join retries a contended journal lock without blocking the host loop", async () => {
  const file = journalFile("busy-join-lock");
  const store = new RuntimeJournal(file, { now: () => 1_500 });
  const adapter = new FakeDeploymentAdapter();
  const build = Promise.withResolvers<void>();
  adapter.buildGate = build.promise;
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 12, startIdentity: "12:1" });
  const peer = new Database(file);
  try {
    const first = await coordinator.requestViewerDeployment({ revision: "c".repeat(40), idempotencyKey: "lock-original" });
    if (first.state !== "accepted") throw new Error("initial deployment was not accepted");
    peer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    let loopReleaseRan = false;
    const joining = coordinator.requestViewerDeployment({ revision: "c".repeat(40), idempotencyKey: "lock-join" });
    const release = new Promise<void>((resolve, reject) => setImmediate(() => {
      try { peer.exec("ROLLBACK"); loopReleaseRan = true; resolve(); }
      catch (error) { reject(error); }
    }));
    await release;
    const joined = await joining;
    expect(loopReleaseRan).toBe(true);
    expect(joined).toMatchObject({ state: "accepted", deploymentId: first.deploymentId, replayed: false });
    expect(store.viewerDeploymentByIdempotencyKey("lock-join")?.deploymentId).toBe(first.deploymentId);
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
  } finally {
    try { peer.exec("ROLLBACK"); } catch { /* release callback already closed the transaction */ }
    peer.close();
    build.resolve();
    const active = store.activeViewerDeployment();
    if (active) await coordinator.waitForDeployment(active.deploymentId);
    store.close();
  }
});

test("issue 1033: a branch ref is resolved by the host and the ledger records the exact commit", async () => {
  const store = journal("ref-admission");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ ref: "refs/heads/main", idempotencyKey: "deploy-ref" });

  expect(receipt).toMatchObject({ state: "accepted", revision: "a".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  expect(adapter.calls.filter((call) => call.startsWith("resolve:"))).toEqual(["resolve:refs/heads/main"]);
  await coordinator.waitForDeployment(receipt.deploymentId);
  /* The exactness the ledger keeps is the RESOLVED commit; the ref is kept
     beside it as what the caller asked for. */
  expect(coordinator.readViewerDeployment(receipt.deploymentId)).toMatchObject({
    requestedRevision: "refs/heads/main",
    revision: "a".repeat(40),
    phase: "succeeded",
    candidate: { revision: "a".repeat(40) },
  });
  store.close();
});

test("issue 1033: a ref outside the canonical repository's branches is refused before resolution", async () => {
  const store = journal("ref-refusal");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  await expect(coordinator.requestViewerDeployment({ ref: "refs/tags/v1", idempotencyKey: "deploy-tag" }))
    .rejects.toThrow("deployment revision must be origin/main, a canonical branch ref, or a full commit SHA");

  expect(adapter.calls).toEqual([]);
  store.close();
});

test("genuinely concurrent requests serialize revision resolution and return busy", async () => {
  const store = journal("concurrent-admission");
  const adapter = new FakeDeploymentAdapter();
  let releaseResolve!: () => void;
  adapter.resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const firstPromise = coordinator.requestViewerDeployment({ idempotencyKey: "concurrent-one" });
  await Promise.resolve();
  const secondPromise = coordinator.requestViewerDeployment({ idempotencyKey: "concurrent-two" });
  await Promise.resolve();

  expect(adapter.calls.filter((call) => call.startsWith("resolve:"))).toEqual(["resolve:origin/main"]);
  releaseResolve();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  if (first.state !== "accepted") throw new Error("first deployment was not accepted");
  expect(second).toEqual({ state: "busy", deploymentId: first.deploymentId, revision: first.revision });
  await coordinator.waitForDeployment(first.deploymentId);
  store.close();
});

test("failed revision resolution releases admission for a deterministic retry", async () => {
  const store = journal("admission-timeout");
  const adapter = new FakeDeploymentAdapter();
  adapter.resolveFailures = 1;
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  await expect(coordinator.requestViewerDeployment({ idempotencyKey: "timed-out" })).rejects.toThrow("timed out");
  const retry = await coordinator.requestViewerDeployment({ idempotencyKey: "retry-after-timeout" });

  expect(retry).toMatchObject({ state: "accepted", replayed: false });
  if (retry.state === "accepted") await coordinator.waitForDeployment(retry.deploymentId);
  store.close();
});

test("an unhealthy candidate leaves the serving release unchanged", async () => {
  const store = journal("candidate-gate");
  const adapter = new FakeDeploymentAdapter();
  const previous = adapter.current;
  const previousMcpRuntime = adapter.currentMcp;
  adapter.candidateHealth = { ...healthy("http://127.0.0.1/candidate"), ok: false, assets: [{ path: "/_next/static/app.js", status: 404 }], detail: "asset gate failed" };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "unhealthy" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "failed", terminal: true, error: "asset gate failed" });
  expect(status?.health[0]?.assets).toEqual([{ path: "/_next/static/app.js", status: 404 }]);
  expect(adapter.current).toEqual(previous);
  expect(adapter.currentMcp).toEqual(previousMcpRuntime);
  expect(adapter.calls.some((call) => call.startsWith("promote:"))).toBe(false);
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  expect(status?.mcpRuntime).toMatchObject({
    candidate: { source: "managed", revision: "a".repeat(40) },
    previous: null,
    publications: [],
  });
  store.close();
});

test("deployment status exposes exact MCP runtime staging and atomic publication evidence", async () => {
  const store = journal("mcp-publication-status");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  const revision = "7".repeat(40);

  const receipt = await coordinator.requestViewerDeployment({
    idempotencyKey: "mcp-publication-status",
    revision,
  });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({
    phase: "succeeded",
    terminal: true,
    mcpRuntime: {
      candidate: {
        source: "managed",
        revision,
        artifactDigest: "7".repeat(64),
      },
      previous: {
        source: "legacy",
        revision: "8".repeat(40),
        artifactDigest: "8".repeat(64),
      },
      publications: [{
        action: "activate",
        source: "managed",
        revision,
        artifactDigest: "7".repeat(64),
        durable: true,
      }],
    },
  });
  expect(adapter.calls.findIndex((call) => call === "current-mcp"))
    .toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("promote:")));
  store.close();
});

test("a successor records first-boot MCP publication on the old terminal deployment receipt", async () => {
  const store = journal("mcp-successor-reconciliation");
  const adapter = new FakeDeploymentAdapter();
  const revision = "7".repeat(40);
  const receipt = store.admitViewerDeployment(
    { idempotencyKey: "old-adapter-deployment", requestedRevision: revision, revision },
    { pid: 9, startIdentity: "9:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  store.updateViewerDeployment(receipt.deploymentId, {
    phase: "succeeded",
    terminal: true,
    candidate: release(revision, "old-adapter-candidate"),
    previous: release("8".repeat(40), "previous"),
    /* The shape the predecessor generation journaled, before MCP health
       evidence had a home on the receipt. */
    mcpRuntime: { candidate: null, previous: null, publications: [] } as unknown as ViewerDeploymentStatus["mcpRuntime"],
  });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:new" });
  const reconciliation = await adapter.reconcileMcpRuntime(revision);

  const updated = coordinator.recordMcpRuntimeReconciliation(reconciliation);

  expect(updated).toMatchObject({
    phase: "succeeded",
    terminal: true,
    candidate: {
      mcpRuntime: {
        source: "managed",
        revision,
        artifactDigest: "9".repeat(64),
      },
    },
    mcpRuntime: {
      candidate: {
        source: "managed",
        revision,
        artifactDigest: "9".repeat(64),
      },
      publications: [{
        action: "activate",
        revision,
        artifactDigest: "9".repeat(64),
        durable: true,
      }],
      health: [{
        revision,
        artifactDigest: "9".repeat(64),
        ok: true,
      }],
    },
  });
  store.close();
});

test("a post-promotion failure restores the previous healthy release", async () => {
  const store = journal("rollback");
  const adapter = new FakeDeploymentAdapter();
  const previous = adapter.current;
  const previousMcpRuntime = adapter.currentMcp;
  adapter.promotedHealth = { ...healthy("http://127.0.0.1:8898"), ok: false, rootStatus: 503, detail: "stable listener failed" };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "rollback" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "rolled-back", terminal: true, previous });
  expect(adapter.current).toEqual(previous);
  expect(adapter.currentMcp).toEqual(previousMcpRuntime);
  expect(status?.mcpRuntime.publications).toMatchObject([
    { action: "activate", source: "managed", revision: "a".repeat(40), durable: true },
    { action: "restore", ...previousMcpRuntime, durable: true },
  ]);
  expect(adapter.calls.findIndex((call) => call.startsWith("promote:"))).toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("rollback:")));
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  expect(status?.health).toHaveLength(2);
  expect(status?.candidateLog).toEqual(adapter.candidateOutput);
  expect(adapter.calls.findIndex((call) => call.startsWith("candidate-log:")))
    .toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("rollback:")));
  store.close();
});

test("issue 1077: a first rollback attempt that fails keeps the reason the candidate was reverted", async () => {
  /* The 2026-08-21 sequence: the promoted MCP read probe failed, the first
     rollback attempt threw while checkpointing a rollback mirror, and the retry
     restored the previous release. The record then named only the mirror. */
  const store = journal("rollback-cause");
  const adapter = new FakeDeploymentAdapter();
  const previous = adapter.current;
  adapter.promotedHealth = { ...healthy("http://127.0.0.1:8898"), ok: false, detail: "MCP runtime read probes failed" };
  const rollback = adapter.rollback.bind(adapter);
  let attempts = 0;
  adapter.rollback = async (...args: Parameters<FakeDeploymentAdapter["rollback"]>) => {
    attempts += 1;
    if (attempts === 1) throw new Error("agent registry rollback mirror did not converge after 2 attempts");
    return rollback(...args);
  };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  try {
    const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "rollback-cause" });
    if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
    const status = await coordinator.waitForDeployment(receipt.deploymentId);
    expect(attempts).toBe(2);
    expect(status).toMatchObject({
      phase: "rolled-back",
      terminal: true,
      previous,
      error: "MCP runtime read probes failed; first rollback attempt failed: agent registry rollback mirror did not converge after 2 attempts",
    });
  } finally { store.close(); }
});

test("a promoted verification deadline enters rollback and frees the deployment lane", async () => {
  const store = journal("startup-deadline");
  const adapter = new FakeDeploymentAdapter();
  const previous = adapter.current;
  adapter.verifyPromoted = async () => {
    throw new Error("deployment adapter verify-promoted timed out while adopting Codex hosts - runtime-host-unavailable");
  };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  try {
    const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "startup-deadline" });
    if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
    const status = await coordinator.waitForDeployment(receipt.deploymentId);
    expect(status).toMatchObject({ phase: "rolled-back", terminal: true, previous });
    expect(status?.error).toContain("adopting Codex hosts - runtime-host-unavailable");
    const next = await coordinator.requestViewerDeployment({ idempotencyKey: "after-startup-deadline" });
    expect(next.state).toBe("accepted");
    if (next.state === "accepted") await coordinator.waitForDeployment(next.deploymentId);
  } finally { store.close(); }
});

/* Production #518: the runtime-host container runs a baked image and its Bun
   process loads modules once at boot. PID 3970 kept executing a stale image
   (no #389 broker guard), so promptless Claude resume adoption kept failing
   with "message content is required" for hours after the fixed revision was
   deployed. /app is not live-mounted, so a same-image restart would boot the
   identical stale generation — the exact-SHA contract must instead stage the
   freshly built candidate image as the successor runtime-host generation. */
test("issue 1268: the predecessor leaves success non-terminal until the staged runtime-host successor takes over", async () => {
  const store = journal("host-successor");
  const adapter = new FakeDeploymentAdapter();
  const handoffs: Array<Record<string, unknown>> = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => {
      handoffs.push({
        ...context,
        terminalAtHandoff: store.viewerDeployment(context.deploymentId)?.terminal ?? null,
        stagedBeforeHandoff: adapter.calls.some((call) => call.startsWith("stage-host-successor:")),
      });
    },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-successor", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  const handedOff = store.viewerDeployment(receipt.deploymentId);
  expect(handedOff).toMatchObject({ phase: "host-handoff", terminal: false });
  /* The staged runtime-host generation IS the deployed candidate: its image
     and revision equal the promoted exact SHA, so the next host boot cannot
     resurrect the stale image. */
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:")))
    .toEqual([`stage-host-successor:${handedOff?.candidate?.image}:${"b".repeat(40)}`]);
  /* Durable ordering: the successor staging lands before the handoff signal,
     while terminal success remains unavailable to the predecessor. */
  expect(handoffs).toEqual([{
    deploymentId: receipt.deploymentId,
    revision: "b".repeat(40),
    successor: handedOff?.candidate,
    previous: { image: "agent-log-viewer:node22", revision: null },
    terminalAtHandoff: false,
    stagedBeforeHandoff: true,
  }]);
  /* The handoff never tears down promoted releases: engine hosts owned by
     Viewer processes keep running through the runtime-host replacement. */
  expect(adapter.calls.filter((call) => call.startsWith("rollback:"))).toEqual([]);
  expect(adapter.calls.filter((call) => call.startsWith("retire:"))).toEqual([]);

  const successor = new ViewerDeploymentCoordinator(
    store,
    adapter,
    { pid: 11, startIdentity: "11:2" },
    {
      ownerAlive: () => false,
      hostGeneration: () => ({ image: handedOff?.candidate?.image ?? null, revision: handedOff?.candidate?.revision ?? null }),
    },
  );
  await successor.recover();
  const completed = await successor.waitForDeployment(receipt.deploymentId);

  expect(completed).toMatchObject({
    phase: "succeeded",
    terminal: true,
    owner: { pid: 11, startIdentity: "11:2" },
    runtimeHostHandoff: {
      generation: {
        image: handedOff?.candidate?.image,
        revision: handedOff?.candidate?.revision,
      },
      phases: [{ phase: "fence-waiting" }, { phase: "fence-acquired" }, { phase: "journal-open" },
        { phase: "handoff-cleanup-complete" }, { phase: "consumers-recovered" }, { phase: "socket-listening" },
        { phase: "ready" }],
      probe: { requestId: "runtime-host-health-probe", responseId: "runtime-host-health-probe" },
    },
  });
  expect(adapter.calls).toContain(
    `verify-host-successor:${handedOff?.candidate?.image}:${handedOff?.candidate?.revision}`,
  );
  store.close();
});

test.each(["missing", "previous"] as const)("issue 1999: successor with a %s release record completes one handoff after process restart", async recordState => {
  const filename = journalFile(`one-handoff-${recordState}`);
  const store = new RuntimeJournal(filename, { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  const handoffs: string[] = [];
  const predecessor = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => currentRuntimeHostGeneration({ NODE_ENV: "test" }),
    onHostHandoff: context => { handoffs.push(context.deploymentId); },
  });
  const receipt = await predecessor.requestViewerDeployment({ idempotencyKey: "one-handoff", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await predecessor.waitForDeployment(receipt.deploymentId);
  const candidate = store.viewerDeployment(receipt.deploymentId)!.candidate!;
  expect(handoffs).toEqual([receipt.deploymentId]);
  expect(adapter.calls.filter(call => call.startsWith("stage-host-successor:"))).toHaveLength(1);
  store.close();
  const releaseFile = path.join(path.dirname(filename), "host-release.json");
  if (recordState === "previous") writeRuntimeHostRelease({ ...candidate,
    image: "viewer:previous", revision: "a".repeat(40), container: "host-previous", stagedAt: "2026-10-19T00:00:00Z" }, releaseFile);
  const child = Bun.spawn([process.execPath, "--eval", `
    import { RuntimeJournal } from "./src/runtime-host/journal";
    import { ViewerDeploymentCoordinator } from "./src/runtime-host/deployment";
    import { FakeDeploymentAdapter } from "./src/runtime-host/fixtures/fakeDeploymentAdapter";
    import { currentRuntimeHostGeneration } from "./src/runtime-host/hostRelease";
    const store = new RuntimeJournal(process.argv[1], { now: () => 2_000 });
    const adapter = new FakeDeploymentAdapter();
    const handoffs = [];
    const generation = currentRuntimeHostGeneration();
    try {
      const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 11, startIdentity: "11:2" }, {
        ownerAlive: () => false, hostGeneration: () => generation, log: () => {},
        onHostHandoff: context => { handoffs.push(context.deploymentId); },
      });
      await coordinator.recover();
      const status = await coordinator.waitForDeployment(process.argv[2]);
      await coordinator.recover();
      console.log(JSON.stringify({ generation, handoffs, calls: adapter.calls, phase: status?.phase }));
    } finally { store.close(); }
  `, filename, receipt.deploymentId], { cwd: process.cwd(), env: { ...process.env,
    LLV_RUNTIME_HOST_RELEASE_TARGET: releaseFile, LLV_RUNTIME_HOST_IMAGE: candidate.image,
    LLV_RUNTIME_HOST_REVISION: candidate.revision, LLV_RUNTIME_HOST_CONTAINER: "host-successor" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const recovered = JSON.parse(stdout);
  expect(recovered).toMatchObject({ generation: { image: candidate.image, revision: candidate.revision }, handoffs: [], phase: "succeeded" });
  expect(recovered.calls.filter((call: string) => call.startsWith("stage-host-successor:"))).toEqual([]);
  expect(recovered.calls.filter((call: string) => call.startsWith("verify-host-successor:"))).toHaveLength(1);
});

test("issue 1412: a failed runtime-host handoff settles terminal and clears deployment admission", async () => {
  const store = journal("host-successor-proof-required");
  const adapter = new FakeDeploymentAdapter();
  adapter.verifyHostFailure = new Error("runtime-host startup evidence is unavailable");
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({
    idempotencyKey: "deploy-host-successor-proof-required",
    revision: "b".repeat(40),
  });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({
    phase: "failed",
    terminal: true,
    error: "runtime-host startup evidence is unavailable",
  });
  expect(store.activeViewerDeployment()).toBeNull();
  expect(adapter.calls).toContain(
    `verify-host-successor:${store.viewerDeployment(receipt.deploymentId)?.candidate?.image}:${"b".repeat(40)}`,
  );
  const next = await coordinator.requestViewerDeployment({
    idempotencyKey: "deploy-after-host-successor-proof-failure",
    revision: "c".repeat(40),
  });
  expect(next).toMatchObject({ state: "accepted", replayed: false, revision: "c".repeat(40) });
  if (next.state === "accepted") await coordinator.waitForDeployment(next.deploymentId);
  store.close();
});

/* #1216 reopened. The promote fix could not be delivered by the mechanism it
   fixes, and this is the ordering that makes that true: runtime-host
   succession lives in the `host-handoff` phase, which is downstream of
   `promoting`. A promote that times out rolls back and never reaches it, so
   the runtime host keeps executing the old promote path on the next attempt,
   and the next, and the next. `scripts/bootstrap-runtime-host.ts` exists
   because of this test. */
test("issue 1216: a promote that times out never reaches runtime-host successor staging", async () => {
  const store = journal("promote-timeout-host");
  const adapter = new FakeDeploymentAdapter();
  adapter.promoteFailure = new Error("deployment adapter promote timed out while waiting for hot-state activation");
  const handoffs: string[] = [];
  const lines: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
    log: (line) => { lines.push(line); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "promote-timeout", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({
    phase: "rolled-back",
    terminal: true,
    error: "deployment adapter promote timed out while waiting for hot-state activation",
    candidateLog: ["startup failed before hot-state activation"],
  });
  expect(adapter.calls.findIndex((call) => call.startsWith("candidate-log:")))
    .toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("rollback:")));
  /* The runtime host is left on whatever generation it was already running:
     the deployment that carried the promote repair never staged a successor
     that could execute it. */
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([]);
  expect(handoffs).toEqual([]);
  expect(lines.some((line) => line.includes("host-handoff"))).toBe(false);
  store.close();
});

/* Three deployments in a row left an operator unable to answer "did this even
   try to replace the runtime host?" from the log. The step now says what it
   decided and why. */
test("issue 1216: the host-handoff step narrates the decision it made", async () => {
  const store = journal("host-handoff-log");
  const adapter = new FakeDeploymentAdapter();
  adapter.hotStateHandOver = "incumbent released hot state after 4s; activation published after 12s";
  const lines: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    log: (line) => { lines.push(line); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "host-handoff-log", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  const image = store.viewerDeployment(receipt.deploymentId)?.candidate?.image;
  expect(lines).toEqual([
    `[viewer deployment] ${receipt.deploymentId} promote hot-state hand-over: incumbent released hot state after 4s; activation published after 12s`,
    `[viewer deployment] ${receipt.deploymentId} host-handoff staging a successor for ${"b".repeat(40)}; the running generation is untracked`,
    `[viewer deployment] ${receipt.deploymentId} host-handoff staged; the successor waits for the singleton fence while this generation hands off ${"b".repeat(40)}`,
  ]);
  expect(image).toBe(`viewer:${"b".repeat(40)}`);
  store.close();
});

test("issue 1412: a promote whose successor staging fails is terminal and logged", async () => {
  const store = journal("host-handoff-failure-log");
  const adapter = new FakeDeploymentAdapter();
  adapter.stageHostFailure = new Error("runtime-host predecessor container is unavailable for successor staging");
  const lines: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    log: (line) => { lines.push(line); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "host-handoff-failure", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  const status = store.viewerDeployment(receipt.deploymentId);
  expect(status).toMatchObject({
    phase: "failed",
    terminal: true,
    error: "runtime-host predecessor container is unavailable for successor staging",
  });
  if (!status?.candidate) throw new Error("published Viewer candidate is missing");
  expect(adapter.current).toEqual(status.candidate);
  expect(adapter.calls.findIndex((call) => call.startsWith("promote:")))
    .toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("stage-host-successor:")));
  expect(lines).toContain(
    `[viewer deployment] ${receipt.deploymentId} host-handoff failed: runtime-host predecessor container is unavailable for successor staging`,
  );
  store.close();
});

test("issue 518: a runtime host already on the deployed generation stages no successor", async () => {
  const store = journal("host-current");
  const adapter = new FakeDeploymentAdapter();
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: `viewer:${"b".repeat(40)}`, revision: "b".repeat(40) }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-current", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({ phase: "succeeded", terminal: true });
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([]);
  expect(handoffs).toEqual([]);
  store.close();
});

test("issue 521 review: consecutive same-revision deployments stage each distinct candidate image", async () => {
  const store = journal("host-same-revision-image");
  const adapter = new FakeDeploymentAdapter();
  adapter.buildCandidate = async (deploymentId, candidateRevision) => {
    adapter.calls.push(`build:${candidateRevision}`);
    return {
      ...release(candidateRevision, deploymentId),
      image: `viewer:${candidateRevision}:${deploymentId}`,
      mcpRuntime: {
        source: "managed",
        revision: candidateRevision,
        releaseId: `deploy-${deploymentId.replaceAll("_", "-")}`,
        artifactDigest: "7".repeat(64),
        stagedAt: "2026-07-23T08:00:00.000Z",
      },
    };
  };
  let running = { image: "agent-log-viewer:node22", revision: null as string | null };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => running,
    onHostHandoff: (context) => { running = { image: context.successor.image, revision: context.successor.revision }; },
  });
  const candidateRevision = "b".repeat(40);

  const first = await coordinator.requestViewerDeployment({ idempotencyKey: "same-revision-one", revision: candidateRevision });
  if (first.state !== "accepted") throw new Error("first deployment was not accepted");
  const firstHandoff = await coordinator.waitForDeployment(first.deploymentId);
  if (!firstHandoff?.candidate) throw new Error("first handoff candidate is missing");
  const firstStatus = await recoverHostHandoffAsSuccessor(
    store,
    adapter,
    first.deploymentId,
    firstHandoff.candidate,
    { pid: 11, startIdentity: "11:first" },
  );
  const second = await coordinator.requestViewerDeployment({ idempotencyKey: "same-revision-two", revision: candidateRevision });
  if (second.state !== "accepted") throw new Error("second deployment was not accepted");
  const secondHandoff = await coordinator.waitForDeployment(second.deploymentId);
  if (!secondHandoff?.candidate) throw new Error("second handoff candidate is missing");
  const secondStatus = await recoverHostHandoffAsSuccessor(
    store,
    adapter,
    second.deploymentId,
    secondHandoff.candidate,
    { pid: 12, startIdentity: "12:second" },
  );

  expect(firstStatus?.candidate?.image).not.toBe(secondStatus?.candidate?.image);
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([
    `stage-host-successor:${firstStatus?.candidate?.image}:${candidateRevision}`,
    `stage-host-successor:${secondStatus?.candidate?.image}:${candidateRevision}`,
  ]);
  store.close();
});

test("issue 1412: terminal successor staging failure cannot replay into hidden success", async () => {
  const store = journal("host-staging-failed");
  const adapter = new FakeDeploymentAdapter();
  adapter.stageHostFailure = new Error("docker tag failed");
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-staging-failed", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  const failed = store.viewerDeployment(receipt.deploymentId);
  expect(failed).toMatchObject({
    phase: "failed",
    terminal: true,
    error: "docker tag failed",
  });
  if (!failed?.candidate) throw new Error("published Viewer candidate is missing");
  expect(adapter.current).toEqual(failed.candidate);
  expect(handoffs).toEqual([]);
  const buildCalls = adapter.calls.filter((call) => call.startsWith("build:"));
  const stageCalls = adapter.calls.filter((call) => call.startsWith("stage-host-successor:"));
  adapter.stageHostFailure = null;
  const replay = await coordinator.requestViewerDeployment({
    idempotencyKey: "deploy-host-staging-failed",
    revision: "b".repeat(40),
  });
  expect(replay).toMatchObject({ state: "accepted", replayed: true, deploymentId: receipt.deploymentId });
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toEqual(failed);
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toEqual(buildCalls);
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual(stageCalls);
  expect(handoffs).toEqual([]);
  store.close();
});

test("issue 518: a failed candidate never stages a runtime-host successor", async () => {
  const store = journal("host-failed-candidate");
  const adapter = new FakeDeploymentAdapter();
  adapter.candidateHealth = { ...healthy("http://127.0.0.1/candidate"), ok: false, detail: "candidate health gate failed" };
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-failed-candidate" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({ phase: "failed", terminal: true });
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([]);
  expect(handoffs).toEqual([]);
  store.close();
});

/* #2761: a candidate the performance gate refuses is retired before anything
   is switched, and the release that was serving keeps serving. */
test("a candidate refused by the performance gate is retired and the serving release is kept", async () => {
  const store = journal("performance-refused-candidate");
  const adapter = new FakeDeploymentAdapter();
  const serving = adapter.current;
  adapter.candidateHealth = {
    ...healthy("http://127.0.0.1/candidate"),
    performance: {
      checkedAt: "2026-10-11T21:00:00.000Z",
      runtime: "bun 1.4.0",
      bounds: CANDIDATE_PERFORMANCE_BOUNDS,
      measurements: null,
      breaches: ["grant-bearing write max 1407ms exceeds 500ms", "warm projection build p95 4467ms exceeds 1000ms"],
      inducedDelayMs: 600,
      ok: false,
      detail: "grant-bearing write max 1407ms exceeds 500ms",
    },
    ok: false,
    detail: "candidate performance gate refused the release: grant-bearing write max 1407ms exceeds 500ms; warm projection build p95 4467ms exceeds 1000ms",
  };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-performance-refused" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({
    phase: "failed",
    terminal: true,
    error: "candidate performance gate refused the release: grant-bearing write max 1407ms exceeds 500ms; warm projection build p95 4467ms exceeds 1000ms",
  });
  expect(status?.health.at(-1)?.performance?.breaches).toHaveLength(2);
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  expect(adapter.calls.filter((call) => call.startsWith("promote:") || call.startsWith("rollback:"))).toEqual([]);
  expect(adapter.current).toEqual(serving);
  store.close();
});

/* #2761: an adapter answer that passed its probes but carries no performance
   report, read through the real host-command adapter, never reaches
   promotion: the candidate is retired and the serving release kept. */
test("a candidate verification that carries no performance report is retired and the serving release is kept", async () => {
  const store = journal("performance-missing-candidate");
  const adapter = new FakeDeploymentAdapter();
  const serving = adapter.current;
  const host = new HostCommandViewerDeploymentAdapter(async (action) => (action === "verify-candidate" ? {
    ...healthy("http://127.0.0.1/candidate"),
    runtimeHost: {
      checkedAt: "2026-10-12T00:01:00.000Z",
      runtime: "bun 1.4.0",
      succession: { predecessorReadyMs: 1_480, successorTookOverMs: 2_140, completed: true },
      listener: { windowMs: 15_000, polls: 30, answered: 30, abandoned: 15 },
      socket: { polls: 30, answered: 30, abandoned: 15 },
      ok: true,
    },
  } : {}));
  adapter.verifyCandidate = async (candidate) => {
    adapter.calls.push(`verify-candidate:${candidate.container}`);
    return host.verifyCandidate(candidate);
  };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-performance-missing" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({
    phase: "failed",
    terminal: true,
    error: "the candidate performance gate reported nothing; a candidate is promoted only on a measured pass",
  });
  expect(status?.health.at(-1)?.performance).toBeUndefined();
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  expect(adapter.calls.filter((call) => call.startsWith("promote:") || call.startsWith("rollback:"))).toEqual([]);
  expect(adapter.current).toEqual(serving);
  store.close();
});

test("successful cleanup retains the serving and immediate rollback releases", async () => {
  const store = journal("release-retention");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const first = await coordinator.requestViewerDeployment({ idempotencyKey: "retention-one", revision: "1".repeat(40) });
  if (first.state !== "accepted") throw new Error("deployment was not accepted");
  const firstStatus = await coordinator.waitForDeployment(first.deploymentId);
  const second = await coordinator.requestViewerDeployment({ idempotencyKey: "retention-two", revision: "2".repeat(40) });
  if (second.state !== "accepted") throw new Error("deployment was not accepted");
  const secondStatus = await coordinator.waitForDeployment(second.deploymentId);

  expect(adapter.calls.filter((call) => call.startsWith("retain-only:")).at(-1)).toBe(
    `retain-only:${secondStatus?.candidate?.container},${firstStatus?.candidate?.container}`,
  );
  store.close();
});

test("restart recovery reclaims a stale build lease and completes the deployment", async () => {
  const filename = journalFile("build-recovery");
  const beforeRestart = new RuntimeJournal(filename, { now: () => 1_000 });
  const receipt = beforeRestart.admitViewerDeployment(
    { idempotencyKey: "recover-build", requestedRevision: "origin/main", revision: "b".repeat(40) },
    { pid: 91, startIdentity: "91:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  beforeRestart.updateViewerDeployment(receipt.deploymentId, { phase: "building" });
  beforeRestart.close();

  const afterRestart = new RuntimeJournal(filename, { now: () => 2_000 });
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(
    afterRestart,
    adapter,
    { pid: 92, startIdentity: "92:new" },
    { ownerAlive: () => false },
  );
  await coordinator.recover();
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "succeeded", terminal: true, owner: { pid: 92, startIdentity: "92:new" } });
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toEqual([`build:${"b".repeat(40)}`]);
  afterRestart.close();
});

test("issue 518: restart recovery resumes a durable host-handoff phase", async () => {
  const filename = journalFile("host-handoff-recovery");
  const beforeRestart = new RuntimeJournal(filename, { now: () => 1_000 });
  const receipt = beforeRestart.admitViewerDeployment(
    { idempotencyKey: "recover-host-handoff", requestedRevision: "origin/main", revision: "b".repeat(40) },
    { pid: 91, startIdentity: "91:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const previous = release("old", "old");
  const candidate = release("b".repeat(40), receipt.deploymentId);
  beforeRestart.updateViewerDeployment(receipt.deploymentId, {
    phase: "host-handoff",
    previous,
    candidate,
    health: [healthy(candidate.endpoint), healthy("http://127.0.0.1:8898")],
  });
  beforeRestart.close();

  const afterRestart = new RuntimeJournal(filename, { now: () => 2_000 });
  const adapter = new FakeDeploymentAdapter();
  adapter.current = candidate;
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(
    afterRestart,
    adapter,
    { pid: 92, startIdentity: "92:new" },
    {
      ownerAlive: () => false,
      hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
      onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
    },
  );

  await coordinator.recover();
  const handedOff = await coordinator.waitForDeployment(receipt.deploymentId);
  if (!handedOff?.candidate) throw new Error("handoff candidate is missing");
  const status = await recoverHostHandoffAsSuccessor(
    afterRestart,
    adapter,
    receipt.deploymentId,
    handedOff.candidate,
    { pid: 93, startIdentity: "93:successor" },
  );

  expect(status).toMatchObject({
    phase: "succeeded",
    terminal: true,
    owner: { pid: 93, startIdentity: "93:successor" },
  });
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toEqual([]);
  expect(adapter.calls.filter((call) => call.startsWith("promote:"))).toEqual([]);
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:")))
    .toEqual([`stage-host-successor:${candidate.image}:${candidate.revision}`]);
  expect(handoffs).toEqual([receipt.deploymentId]);
  afterRestart.close();
});

test("restart recovery finishes rollback from a journaled promotion phase", async () => {
  const filename = journalFile("promotion-recovery");
  const beforeRestart = new RuntimeJournal(filename, { now: () => 1_000 });
  const receipt = beforeRestart.admitViewerDeployment(
    { idempotencyKey: "recover-promotion", requestedRevision: "origin/main", revision: "c".repeat(40) },
    { pid: 91, startIdentity: "91:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const previous = release("old", "old");
  const candidate = {
    ...release("c".repeat(40), receipt.deploymentId),
    mcpRuntime: {
      source: "managed" as const,
      revision: "c".repeat(40),
      releaseId: `deploy-${receipt.deploymentId.replaceAll("_", "-")}`,
      artifactDigest: "c".repeat(64),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  };
  const previousMcpRuntime = {
    source: "legacy" as const,
    revision: "8".repeat(40),
    releaseId: null,
    artifactDigest: "8".repeat(64),
    stagedAt: null,
  };
  beforeRestart.updateViewerDeployment(receipt.deploymentId, {
    phase: "promoting",
    previous,
    candidate,
    health: [healthy(candidate.endpoint)],
    mcpRuntime: { candidate: candidate.mcpRuntime, previous: previousMcpRuntime, publications: [], health: [] },
  });
  beforeRestart.close();

  const afterRestart = new RuntimeJournal(filename, { now: () => 2_000 });
  const adapter = new FakeDeploymentAdapter();
  adapter.current = previous;
  adapter.promotedHealth = { ...healthy("http://127.0.0.1:8898"), ok: false, detail: "restart probe failed" };
  const coordinator = new ViewerDeploymentCoordinator(
    afterRestart,
    adapter,
    { pid: 92, startIdentity: "92:new" },
    { ownerAlive: () => false },
  );
  await coordinator.recover();
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "rolled-back", terminal: true });
  expect(adapter.current).toEqual(previous);
  expect(adapter.currentMcp).toEqual(previousMcpRuntime);
  expect(status?.mcpRuntime.publications).toMatchObject([
    { action: "activate", source: "managed", revision: candidate.revision, durable: true },
    { action: "restore", ...previousMcpRuntime, durable: true },
  ]);
  expect(adapter.calls).toContain(`promote:${candidate.container}`);
  expect(adapter.calls).toContain(`rollback:${candidate.container}`);
  afterRestart.close();
});

test("staged end-to-end build survives a host restart and a later release rolls back", async () => {
  const filename = journalFile("staged-e2e");
  const firstJournal = new RuntimeJournal(filename, { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  const firstCoordinator = new ViewerDeploymentCoordinator(firstJournal, adapter, { pid: 71, startIdentity: "71:first" });
  const first = await firstCoordinator.requestViewerDeployment({ idempotencyKey: "staged-first" });
  if (first.state !== "accepted") throw new Error("deployment was not accepted");
  expect((await firstCoordinator.waitForDeployment(first.deploymentId))?.phase).toBe("succeeded");
  const firstRelease = adapter.current;
  firstJournal.close();

  const restartedJournal = new RuntimeJournal(filename, { now: () => 2_000 });
  adapter.promotedHealth = { ...healthy(stableEndpointForTest()), ok: false, detail: "staged post-promotion failure" };
  const restartedCoordinator = new ViewerDeploymentCoordinator(restartedJournal, adapter, { pid: 72, startIdentity: "72:restarted" });
  expect(await restartedCoordinator.recover()).toBeNull();
  const second = await restartedCoordinator.requestViewerDeployment({ idempotencyKey: "staged-second", revision: "d".repeat(40) });
  if (second.state !== "accepted") throw new Error("deployment was not accepted");
  const secondStatus = await restartedCoordinator.waitForDeployment(second.deploymentId);

  expect(secondStatus?.phase).toBe("rolled-back");
  expect(adapter.current).toEqual(firstRelease);
  expect(secondStatus?.health.flatMap((item) => item.assets).every((asset) => asset.status === 200)).toBe(true);
  restartedJournal.close();
});

test("newly promoted Viewer environment requests the next deployment through runtime-host", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-socket-"));
  sandboxes.push(dir);
  const store = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => 1_000 });
  const coordinator = new ViewerDeploymentCoordinator(store, new FakeDeploymentAdapter(), { pid: 10, startIdentity: "10:1" });
  const socketPath = path.join(dir, "runtime.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(store, undefined, coordinator));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const composeService = viewerComposeServiceFromConfig(JSON.stringify({ services: { viewer: {
    build: {}, command: null, entrypoint: null, environment: {}, image: "viewer:compose", network_mode: "host",
    pid: "host", privileged: true, restart: "unless-stopped", user: "1000:1000", volumes: [], working_dir: "/app",
  } } }));
  const args = viewerCandidateDockerArgs(release("current", "current"), composeService, {
    runtimeSocket: socketPath,
    tmuxTmpdir: "/run/user/1000/agent-log-viewer",
  });
  const environment = {} as NodeJS.ProcessEnv;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-e") continue;
    const [key, ...value] = args[index + 1]!.split("=");
    environment[key!] = value.join("=");
  }
  const client = runtimeHostClient(environment);
  if (!client) throw new Error("promoted Viewer runtime client is unavailable");

  const receipt = await client.requestViewerDeployment({ idempotencyKey: "socket-deploy" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);
  const status = await client.readViewerDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ deploymentId: receipt.deploymentId, phase: "succeeded", terminal: true });
  expect((await client.snapshot()).deployments).toHaveLength(1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
});

test("Viewer socket admission outlives the ordinary client timeout during delayed revision resolution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-socket-timeout-"));
  sandboxes.push(dir);
  const store = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  adapter.resolveGate = new Promise<void>((resolve) => setTimeout(resolve, 30));
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  const server = serveRuntimeHost(
    path.join(dir, "runtime.sock"),
    new RuntimeHost(store, undefined, coordinator),
    { defaultTimeoutMs: 10, deploymentTimeoutMs: 100 },
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(path.join(dir, "runtime.sock"), 10, 100);

  try {
    const receipt = await client.requestViewerDeployment({ idempotencyKey: "delayed-socket-deploy" });
    expect(receipt).toMatchObject({ state: "accepted", replayed: false });
    if (receipt.state === "accepted") await coordinator.waitForDeployment(receipt.deploymentId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test("a disconnected deployment remains visible to a read-only key lookup after late admission", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-late-admission-"));
  sandboxes.push(dir);
  const store = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  let releaseResolution!: () => void;
  adapter.resolveGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  const socketPath = path.join(dir, "runtime.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(store, undefined, coordinator));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  try {
    const disconnected = net.createConnection(socketPath);
    await new Promise<void>((resolve) => disconnected.once("connect", resolve));
    disconnected.write(JSON.stringify({ id: "lost-reply", method: "viewer-deployment-request", params: { idempotencyKey: "late-admission" } }) + "\n");
    while (!adapter.calls.includes("resolve:origin/main")) await Bun.sleep(1);
    disconnected.destroy();
    const lookup = client.findViewerDeploymentByIdempotencyKey("late-admission");
    let settled = false;
    void lookup.then(() => { settled = true; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    releaseResolution();
    const accepted = await lookup;
    expect(accepted).toMatchObject({ idempotencyKey: "late-admission" });
    if (accepted) await coordinator.waitForDeployment(accepted.deploymentId);
    expect(await client.findViewerDeploymentByIdempotencyKey("unknown-key")).toBeNull();
    expect(store.listViewerDeployments().deployments).toHaveLength(1);
  } finally {
    releaseResolution();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("managed auto retains a disconnected request through late admission and a newer main", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-managed-late-admission-"));
  sandboxes.push(dir);
  const store = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => Date.now() });
  const adapter = new FakeDeploymentAdapter();
  let releaseResolution!: () => void;
  adapter.resolveGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
  adapter.buildCandidate = async () => { throw new Error("late build failed"); };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  const socketPath = path.join(dir, "runtime.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(store, undefined, coordinator));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const oldSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const oldState = process.env.LLV_STATE_DIR;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  let service: SelfUpdateService | null = null;
  try {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const revision = (sha: string): Revision => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
    const clientKey = "lost-request";
    const key = managedIdempotencyKey(a, clientKey);
    const production = productionDeps();
    fs.mkdirSync(production.dir, { recursive: true });
    writeAuto(path.join(production.dir, "auto.json"), { ...initialAuto(), enabled: true,
      managedPending: { target: revision(a), clientKey, at: new Date().toISOString() } });
    fs.writeFileSync(path.join(production.dir, "state.json"), JSON.stringify({ slice: {
      ...initialCheck(), installed: revision("c".repeat(40)), available: revision(b),
      check: { ...idleCheck(), state: "update-available", relation: "behind", at: new Date().toISOString() },
    }, update: null }));

    const disconnected = net.createConnection(socketPath);
    await new Promise<void>((resolve) => disconnected.once("connect", resolve));
    disconnected.write(JSON.stringify({ id: "lost-reply", method: "viewer-deployment-request",
      params: { revision: a, idempotencyKey: key } }) + "\n");
    while (!adapter.calls.includes(`resolve:${a}`)) await Bun.sleep(1);
    disconnected.destroy();

    let lookupStarted!: () => void;
    const lookupEntered = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const deps = { ...production,
      findDeploymentByIdempotencyKey: (idempotencyKey: string) => {
        lookupStarted();
        return production.findDeploymentByIdempotencyKey(idempotencyKey);
      },
      mode: async () => ({ mode: "managed" as const, reason: null, record: null }),
      releaseTarget: () => ({ revision: "c".repeat(40) }),
      hostHealth: async () => null,
      prepareCheckRepo: async () => dir,
      green: { read: async () => ({ state: "red" as const }) },
      quiet: { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: () => [], presence: () => [], memoryAvailableMb: () => 8_192 },
    } as unknown as ServiceDeps;
    service = new SelfUpdateService(deps);
    const tick = service.autoTick();
    await lookupEntered;
    expect(await Promise.race([tick.then(() => true), Bun.sleep(10).then(() => false)])).toBe(false);
    expect(readAuto(path.join(production.dir, "auto.json")).managedPending?.clientKey).toBe(clientKey);
    expect(store.viewerDeploymentByIdempotencyKey(key)).toBeNull();

    releaseResolution();
    await tick;
    const accepted = store.viewerDeploymentByIdempotencyKey(key);
    expect(accepted).not.toBeNull();
    await coordinator.waitForDeployment(accepted!.deploymentId);
    await service.refreshManaged();
    expect(readAuto(path.join(production.dir, "auto.json"))).toMatchObject({ enabled: false, managedPending: null,
      off: { target: a, reason: "late build failed" } });
    expect(readManagedRecord(path.join(production.dir, "managed.json"))).toMatchObject({ idempotencyKey: key, phase: "failed" });
    expect(store.listViewerDeployments().deployments).toHaveLength(1);
  } finally {
    service?.stop();
    releaseResolution();
    if (oldSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = oldSocket;
    if (oldState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = oldState;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

function stableEndpointForTest(): string {
  return "http://127.0.0.1:8898";
}


test("explicit serving cancellation stays pending until the verifier settles, then rolls back", async () => {
  const filename = journalFile("serving-cancel");
  const store = new RuntimeJournal(filename);
  const adapter = new FakeDeploymentAdapter();
  let releaseProbe!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const joined = new Promise<void>((resolve) => { releaseProbe = resolve; });
  adapter.verifyPromoted = async (_candidate, signal) => {
    entered();
    await joined;
    signal?.throwIfAborted();
    return adapter.promotedHealth;
  };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: process.pid, startIdentity: "test" });
  const receipt = await coordinator.requestViewerDeployment({ revision: "a".repeat(40), idempotencyKey: "cancel-serving" });
  await started;
  expect(coordinator.readViewerDeployment(receipt.deploymentId)?.servingProgress).toContain("HTTP rejection pending");
  const socketPath = path.join(path.dirname(filename), "cancel.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(store, undefined, coordinator));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  try {
    const context = { params: Promise.resolve({ deploymentId: receipt.deploymentId }) };
    const denied = await cancelDeploymentRoute(new NextRequest("http://127.0.0.1/api/runtime/deployments/test", { method: "DELETE", headers: { host: "127.0.0.1", origin: "https://example.invalid" } }), context);
    expect(denied.status).toBe(403);
    expect(coordinator.readViewerDeployment(receipt.deploymentId)?.error).toBeNull();
    const response = await cancelDeploymentRoute(new NextRequest("http://127.0.0.1/api/runtime/deployments/test", { method: "DELETE", headers: { host: "127.0.0.1" } }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "post-promotion-health", terminal: false, error: "serving verification cancelled by operator" });
  } finally {
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(coordinator.cancelViewerDeployment(receipt.deploymentId)?.terminal).toBe(false);
  expect(adapter.calls.some((call) => call.startsWith("rollback:"))).toBe(false);
  releaseProbe();
  const terminal = await coordinator.waitForDeployment(receipt.deploymentId);
  expect(terminal).toMatchObject({ phase: "rolled-back", terminal: true, error: "serving verification cancelled by operator" });
  expect(coordinator.cancelViewerDeployment(receipt.deploymentId)).toEqual(terminal);
  store.close();
});
