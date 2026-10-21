import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ViewerDeploymentCoordinator } from "../../runtime-host/deployment";
import { FakeDeploymentAdapter } from "../../runtime-host/fixtures/fakeDeploymentAdapter";
import { RuntimeJournal } from "../../runtime-host/journal";
import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";
import { beginSeatDeployment, recordSeatDeployment, seatDeploymentsFor } from "@/lib/orchestrator/seatDeployments";

const SHA = "a".repeat(40);
const SEAT = "conversation_deploy_seat";
const PROJECT = "deploy-project";
const domain = {
  callerAttribution: () => ({ kind: "manager", conversationId: SEAT, role: null }),
  callerProject: () => PROJECT,
  viewerProjects: () => [PROJECT],
  authorizedSeats: () => [{ conversationId: SEAT, project: PROJECT, path: null }],
};

test("a lost busy-join reply replays its durable admission before and after settlement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lost-busy-join-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { now: () => 3_000 });
  const adapter = new FakeDeploymentAdapter();
  const build = Promise.withResolvers<void>();
  adapter.buildGate = build.promise;
  const coordinator = new ViewerDeploymentCoordinator(journal, adapter, { pid: 30, startIdentity: "30:1" });
  const joinKey = "lost-busy-join-replay";
  const originalKey = "original-deploy-key";
  const original = await coordinator.requestViewerDeployment({ revision: SHA, idempotencyKey: originalKey });
  const deploymentId = original.deploymentId;
  await recordSeatDeployment({ deploymentId, conversationId: SEAT, project: PROJECT, revision: SHA,
    requestedAt: "2026-10-19T12:00:00.000Z", idempotencyKey: originalKey });
  await beginSeatDeployment({ conversationId: SEAT, project: PROJECT, revision: SHA,
    requestedAt: "2026-10-19T12:01:00.000Z", idempotencyKey: joinKey });
  let posts = 0;
  let attributionWritable = false;
  const joinDomain = {
    ...domain,
    findDeploymentByIdempotencyKey: (key: string) => coordinator.findViewerDeploymentByIdempotencyKey(key),
    recordSeatDeployment: async (record: Parameters<typeof recordSeatDeployment>[0]) => {
      if (!attributionWritable) throw new Error("seat attribution storage temporarily refused the write");
      await recordSeatDeployment(record);
    },
  };
  const bindings = viewerMcpBindings(undefined, { post: async (_url, body) => {
    posts++;
    await coordinator.requestViewerDeployment(body as { revision: string; idempotencyKey: string });
    throw new Error("same-SHA join response was lost after runtime admission");
  } }, joinDomain as never);
  const store = new SqliteMcpReceiptStore(path.join(root, "mcp.sqlite"));
  const service = createMcpToolService(bindings, store);
  const args = { revision: SHA, clientRequestId: joinKey };
  const childScript = `
    import { viewerMcpBindings } from "./src/lib/mcp/bindings";
    import { createMcpToolService, SqliteMcpReceiptStore } from "./src/lib/mcp/server";
    const store = new SqliteMcpReceiptStore(process.argv[1]);
    const domain = {
      callerAttribution: () => ({ kind: "manager", conversationId: "conversation_deploy_seat", role: null }),
      callerProject: () => "deploy-project", viewerProjects: () => ["deploy-project"],
      authorizedSeats: () => [{ conversationId: "conversation_deploy_seat", project: "deploy-project", path: null }],
    };
    try {
      const bindings = viewerMcpBindings(undefined, { post: async () => { throw new Error("joined deployment must not be posted again"); } }, domain);
      console.log(JSON.stringify(await createMcpToolService(bindings, store).callTool("deploy_exact_sha", JSON.parse(process.argv[2]))));
    } finally { store.close(); }
  `;
  try {
    const lost = await service.callTool("deploy_exact_sha", args);
    expect(lost).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    attributionWritable = true;
    const replay = await service.callTool("deploy_exact_sha", args);
    expect(replay).toMatchObject({ ok: true, state: "accepted", deploymentId, wakeOnSettle: true });
    expect(posts).toBe(1);

    const beforeSettle = await promisify(execFile)(process.execPath,
      ["--eval", childScript, path.join(root, "fresh-before.sqlite"), JSON.stringify(args)], {
        cwd: process.cwd(), env: { ...process.env }, timeout: 15_000,
      });
    expect(JSON.parse(beforeSettle.stdout)).toMatchObject({ ok: true, state: "accepted", deploymentId, wakeOnSettle: true });
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);

    build.resolve();
    await coordinator.waitForDeployment(deploymentId);
    const afterSettle = await promisify(execFile)(process.execPath,
      ["--eval", childScript, path.join(root, "fresh-after.sqlite"), JSON.stringify(args)], {
        cwd: process.cwd(), env: { ...process.env }, timeout: 15_000,
      });
    expect(JSON.parse(afterSettle.stdout)).toMatchObject({ ok: true, state: "accepted", deploymentId, wakeOnSettle: true });
    expect(posts).toBe(1);
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
    const linked = seatDeploymentsFor(SEAT).find(record => record.deploymentId === deploymentId) as
      { idempotencyKeys?: string[] } | undefined;
    expect(linked?.idempotencyKeys).toContain(joinKey);
  } finally {
    build.resolve();
    await coordinator.waitForDeployment(deploymentId);
    store.close();
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an attribution failure during uncertain replay stays pending until admission and wake reconcile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uncertain-attribution-replay-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { now: () => 4_000 });
  const adapter = new FakeDeploymentAdapter();
  const build = Promise.withResolvers<void>();
  adapter.buildGate = build.promise;
  const coordinator = new ViewerDeploymentCoordinator(journal, adapter, { pid: 31, startIdentity: "31:1" });
  const key = "uncertain-attribution-replay";
  const args = { revision: SHA, clientRequestId: key };
  let lookupReady = false;
  let attributionFails = false;
  let posts = 0;
  const dependencies = {
    ...domain,
    findDeploymentByIdempotencyKey: async (requestKey: string) => lookupReady
      ? coordinator.findViewerDeploymentByIdempotencyKey(requestKey) : null,
    beginSeatDeployment: async (pending: Parameters<typeof beginSeatDeployment>[0], assertCaller?: () => void) => {
      if (attributionFails) throw new Error("seat attribution store is temporarily unavailable");
      await beginSeatDeployment(pending, assertCaller);
    },
  };
  const bindings = viewerMcpBindings(undefined, { post: async (_url, body) => {
    posts++;
    await coordinator.requestViewerDeployment(body as { revision: string; idempotencyKey: string });
    throw new Error("response lost after durable admission");
  } }, dependencies as never);
  const store = new SqliteMcpReceiptStore(path.join(root, "mcp.sqlite"));
  const service = createMcpToolService(bindings, store);
  try {
    expect(await service.callTool("deploy_exact_sha", args)).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    const admitted = journal.viewerDeploymentByIdempotencyKey(key);
    expect(admitted?.deploymentId).toBeTruthy();
    attributionFails = true;
    expect(await service.callTool("deploy_exact_sha", args)).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    attributionFails = false;
    lookupReady = true;
    expect(await service.callTool("deploy_exact_sha", args)).toMatchObject({
      ok: true, state: "accepted", deploymentId: admitted!.deploymentId, wakeOnSettle: true,
    });
    expect(posts).toBe(1);
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
    expect(seatDeploymentsFor(SEAT).filter(record => record.deploymentId === admitted!.deploymentId)).toHaveLength(1);
  } finally {
    build.resolve();
    const active = journal.activeViewerDeployment();
    if (active) await coordinator.waitForDeployment(active.deploymentId);
    store.close();
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
