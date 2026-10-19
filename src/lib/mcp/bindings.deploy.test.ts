import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ViewerDeploymentCoordinator } from "../../runtime-host/deployment";
import { FakeDeploymentAdapter } from "../../runtime-host/fixtures/fakeDeploymentAdapter";
import { RuntimeJournal } from "../../runtime-host/journal";
import { productionViewerControlDependencies, viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";
import { recordSeatDeploymentAdmission, seatDeploymentsFor } from "@/lib/orchestrator/seatDeployments";

const SHA = "a".repeat(40);
const SEAT = "conversation_deploy_seat";
const PROJECT = "deploy-project";
const domain = {
  callerAttribution: () => ({ kind: "manager", conversationId: SEAT, role: null }),
  callerProject: () => PROJECT,
  viewerProjects: () => [PROJECT],
  authorizedSeats: () => [{ conversationId: SEAT, project: PROJECT, path: null }],
  findDeploymentByIdempotencyKey: async () => { throw new Error("ledger read unavailable during reconnect"); },
};

describe.serial("deployment bindings", () => {
test("admission survives a control timeout and the original MCP key resolves through a reopened receipt store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-receipt-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  const build = Promise.withResolvers<void>();
  adapter.buildGate = build.promise;
  const coordinator = new ViewerDeploymentCoordinator(journal, adapter, { pid: 10, startIdentity: "10:1" });
  const connection = new AbortController();
  let first = true;
  let deploymentId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const receipt = await coordinator.requestViewerDeployment(await request.json());
    deploymentId = receipt.deploymentId;
    await recordSeatDeploymentAdmission("lost-admission-reply", receipt);
    if (first) {
      first = false;
      // Abort only after the real admission committed. The response is lost.
      connection.abort(new Error("Viewer control reconnect attempt timed out"));
    }
    return Response.json(receipt);
  } });
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const receiptFile = path.join(root, "mcp.sqlite");
  const store = new SqliteMcpReceiptStore(receiptFile);
  let storeClosed = false;
  const control = productionViewerControlDependencies(true);
  const timed: ViewerControlDependencies = {
    post: (url, body, headers) => control.post(url, body, headers, { signal: connection.signal }),
  };
  const args = { revision: SHA, clientRequestId: "lost-admission-reply" };
  try {
    const original = await createMcpToolService(viewerMcpBindings(undefined, timed, domain as never), store)
      .callTool("deploy_exact_sha", args);
    expect(journal.viewerDeploymentByIdempotencyKey(args.clientRequestId)?.deploymentId).toBe(deploymentId);
    expect(original).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    expect(JSON.stringify(original)).toContain("deployment_status");
    store.close();
    storeClosed = true;
    // A fresh process must reconcile the durable pending receipt; no in-memory
    // result or attribution from the first MCP service survives here.
    const script = `
      import { productionViewerControlDependencies, viewerMcpBindings } from "./src/lib/mcp/bindings";
      import { createMcpToolService, SqliteMcpReceiptStore } from "./src/lib/mcp/server";
      const store = new SqliteMcpReceiptStore(process.argv[1]);
      const domain = {
        callerAttribution: () => ({ kind: "manager", conversationId: "conversation_deploy_seat", role: null }),
        callerProject: () => "deploy-project", viewerProjects: () => ["deploy-project"],
        authorizedSeats: () => [{ conversationId: "conversation_deploy_seat", project: "deploy-project", path: null }],
      };
      try {
        const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domain), store);
        console.log(JSON.stringify(await service.callTool("deploy_exact_sha", JSON.parse(process.argv[2]))));
      } finally { store.close(); }
    `;
    const child = await promisify(execFile)(process.execPath, ["--eval", script, receiptFile, JSON.stringify(args)], {
      cwd: process.cwd(), env: { ...process.env }, timeout: 15_000,
    });
    const replay = JSON.parse(child.stdout);
    expect(replay).toMatchObject({ ok: true, state: "accepted", deploymentId, wakeOnSettle: true });
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
    expect(seatDeploymentsFor(SEAT).some(record => record.deploymentId === deploymentId)).toBe(true);
  } finally {
    build.resolve();
    if (deploymentId) await coordinator.waitForDeployment(deploymentId);
    server.stop(true);
    if (!storeClosed) store.close();
    journal.close();
    if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reconnect refusal after admission stays unknown and original-key replay resolves it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-reconnect-refusal-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { now: () => 2_000 });
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(journal, adapter, { pid: 20, startIdentity: "20:1" });
  let attempts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    attempts++;
    if (attempts === 1) {
      const body = await request.json() as { revision: string; idempotencyKey: string };
      const admitted = await coordinator.requestViewerDeployment(body);
      await recordSeatDeploymentAdmission(body.idempotencyKey, admitted);
      return Response.json({ error: "upstream response was lost" }, { status: 502 });
    }
    return Response.json({ error: "reconnect refusal" }, { status: 403 });
  } });
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const store = new SqliteMcpReceiptStore(path.join(root, "mcp.sqlite"));
  const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domain as never), store);
  const args = { revision: SHA, clientRequestId: "admitted-then-refused" };
  const context = { deadlineAt: Date.now() + 5_000 };
  try {
    const first = await service.callTool("deploy_exact_sha", args, context);
    expect(first).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    expect(JSON.stringify(first)).toContain("deployment_status");
    expect(journal.viewerDeploymentByIdempotencyKey(args.clientRequestId)?.revision).toBe(SHA);

    const replay = await service.callTool("deploy_exact_sha", args, { deadlineAt: Date.now() + 5_000 });
    expect(replay).toMatchObject({ ok: true, state: "accepted", deploymentId: journal.viewerDeploymentByIdempotencyKey(args.clientRequestId)?.deploymentId,
      wakeOnSettle: true });
    expect(attempts).toBe(2);
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
  } finally {
    store.close();
    await coordinator.waitForDeployment(journal.viewerDeploymentByIdempotencyKey(args.clientRequestId)!.deploymentId);
    server.stop(true);
    journal.close();
    if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated accepted body followed by refusal keeps its receipt pending until restart recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-truncated-body-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { now: () => 2_500 });
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(journal, adapter, { pid: 25, startIdentity: "25:1" });
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    if (requests === 1) {
      const body = await request.json() as { revision: string; idempotencyKey: string };
      const admitted = await coordinator.requestViewerDeployment(body);
      await recordSeatDeploymentAdmission(body.idempotencyKey, admitted);
      return new Response("{", { status: 202, headers: { "content-type": "application/json" } });
    }
    return Response.json({ error: "reconnect refused" }, { status: 403 });
  } });
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const receiptPath = path.join(root, "mcp.sqlite");
  let store = new SqliteMcpReceiptStore(receiptPath);
  const domainWithLookup = {
    ...domain,
    findDeploymentByIdempotencyKey: (key: string) => coordinator.findViewerDeploymentByIdempotencyKey(key),
  };
  const args = { revision: SHA, clientRequestId: "truncated-admission-body" };
  try {
    const first = await createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domainWithLookup as never), store)
      .callTool("deploy_exact_sha", args, { deadlineAt: Date.now() + 5_000 });
    expect(first).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    expect(JSON.stringify(first)).toContain("deployment_status");
    expect(journal.viewerDeploymentByIdempotencyKey(args.clientRequestId)?.deploymentId).toBeTruthy();
    store.close();
    store = new SqliteMcpReceiptStore(receiptPath);
    const replay = await createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domainWithLookup as never), store)
      .callTool("deploy_exact_sha", args, { deadlineAt: Date.now() + 5_000 });
    expect(replay).toMatchObject({
      ok: true,
      state: "accepted",
      deploymentId: journal.viewerDeploymentByIdempotencyKey(args.clientRequestId)?.deploymentId,
      wakeOnSettle: true,
    });
    expect(requests).toBe(2);
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
  } finally {
    store.close();
    const admitted = journal.viewerDeploymentByIdempotencyKey(args.clientRequestId);
    if (admitted) await coordinator.waitForDeployment(admitted.deploymentId);
    server.stop(true);
    journal.close();
    if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pending deploy replay never turns a reconnect refusal into a failed receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-pending-refusal-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { now: () => 2_750 });
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(journal, adapter, { pid: 27, startIdentity: "27:1" });
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    if (requests === 1) {
      await coordinator.requestViewerDeployment(await request.json());
      return Response.json({ error: "upstream lost the admission response" }, { status: 502 });
    }
    return Response.json({ error: "reconnect refused" }, { status: 403 });
  } });
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const receiptPath = path.join(root, "mcp.sqlite");
  let store = new SqliteMcpReceiptStore(receiptPath);
  let admissionVisible = false;
  const domainWithDelayedLookup = {
    ...domain,
    findDeploymentByIdempotencyKey: (key: string) => admissionVisible
      ? coordinator.findViewerDeploymentByIdempotencyKey(key)
      : Promise.resolve(null),
  };
  const args = { revision: SHA, clientRequestId: "pending-refusal-key" };
  try {
    const first = await createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domainWithDelayedLookup as never), store)
      .callTool("deploy_exact_sha", args, { deadlineAt: Date.now() + 5_000 });
    expect(first).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    store.close();
    store = new SqliteMcpReceiptStore(receiptPath);

    const pendingReplay = await createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domainWithDelayedLookup as never), store)
      .callTool("deploy_exact_sha", args, { deadlineAt: Date.now() + 5_000 });
    expect(pendingReplay).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    expect(JSON.stringify(pendingReplay)).toContain("deployment_status");
    expect(requests).toBe(2);

    admissionVisible = true;
    const recovered = await createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domainWithDelayedLookup as never), store)
      .callTool("deploy_exact_sha", args, { deadlineAt: Date.now() + 5_000 });
    expect(recovered).toMatchObject({ ok: true, state: "accepted", wakeOnSettle: true });
    expect(requests).toBe(2);
    expect(adapter.calls.filter(call => call.startsWith("build:"))).toHaveLength(1);
  } finally {
    store.close();
    const admitted = journal.viewerDeploymentByIdempotencyKey(args.clientRequestId);
    if (admitted) await coordinator.waitForDeployment(admitted.deploymentId);
    server.stop(true);
    journal.close();
    if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy stored reconnect failures resolve through the same admission key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-deploy-receipt-"));
  const file = path.join(root, "mcp.sqlite");
  let store = new SqliteMcpReceiptStore(file);
  const args = { revision: SHA, clientRequestId: "legacy-lost-reply" };
  try {
    const legacy = createMcpToolService({ deploy_exact_sha: async () => {
      throw new Error("Viewer control did not reconnect after 2 attempts (attempt timed out)");
    } } as never, store);
    expect(await legacy.callTool("deploy_exact_sha", args)).toMatchObject({ code: "tool_failed", retryable: true });
    store.close();
    store = new SqliteMcpReceiptStore(file);
    const keys: unknown[] = [];
    const bindings = viewerMcpBindings(undefined, { post: async (_url, body) => {
      keys.push(body.idempotencyKey);
      return { state: "accepted", deploymentId: "legacy-admitted", revision: SHA, replayed: true };
    } }, {
      ...domain,
      findDeploymentByIdempotencyKey: async (idempotencyKey: string) => ({
        deploymentId: "legacy-admitted", idempotencyKey, requestedRevision: SHA, revision: SHA,
      } as never),
    } as never);
    const service = createMcpToolService(bindings, store);
    expect(await service.callTool("deploy_exact_sha", args)).toMatchObject({ ok: true, deploymentId: "legacy-admitted", wakeOnSettle: true });
    expect(await service.callTool("deploy_exact_sha", args)).toMatchObject({ ok: true, replayed: true, deploymentId: "legacy-admitted" });
    expect(keys).toEqual([]);
    expect(await service.callTool("deploy_exact_sha", { ...args, revision: "b".repeat(40) })).toMatchObject({ code: "idempotency_conflict" });
    expect(keys).toHaveLength(0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a matching busy SHA subscribes the seat while a different SHA stays busy", async () => {
  const recorded: unknown[] = [];
  const bindings = viewerMcpBindings(undefined, { post: async () => ({
    state: "busy", deploymentId: "already-building", revision: SHA,
  }) }, { ...domain, recordSeatDeployment: (record: unknown) => { recorded.push(record); } } as never);
  const matching = await bindings.deploy_exact_sha({ revision: SHA, clientRequestId: "join-building" });
  expect(matching).toMatchObject({ state: "accepted", deploymentId: "already-building", wakeOnSettle: true });
  expect(recorded).toMatchObject([{ deploymentId: "already-building", conversationId: SEAT, revision: SHA }]);
  const different = await bindings.deploy_exact_sha({ revision: "b".repeat(40), clientRequestId: "different-building" });
  expect(different).toMatchObject({ state: "busy", deploymentId: "already-building", wakeOnSettle: false });
  expect(recorded).toHaveLength(1);
  expect(seatDeploymentsFor(SEAT).some(record => record.idempotencyKey === "different-building")).toBe(false);
});

test.each([SHA.slice(0, 12), SHA.toUpperCase()])("a busy full SHA matches the requested prefix or case: %s", async revision => {
  const bindings = viewerMcpBindings(undefined, { post: async () => ({
    state: "busy", deploymentId: "prefix-building", revision: SHA,
  }) }, { ...domain, recordSeatDeployment: () => {} } as never);
  expect(await bindings.deploy_exact_sha({ revision, clientRequestId: `join-${revision}` }))
    .toMatchObject({ state: "accepted", deploymentId: "prefix-building", wakeOnSettle: true });
});

test.each(["accepted", "unknown"])("authority is checked before replay of an %s receipt", async outcome => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-authority-"));
  const store = new SqliteMcpReceiptStore(path.join(root, "mcp.sqlite"));
  let designated = true;
  let calls = 0;
  const bindings = viewerMcpBindings(undefined, { post: async () => {
    calls++;
    if (outcome === "unknown") throw new Error("Viewer control did not reconnect");
    return { state: "accepted", deploymentId: `authority-${outcome}`, revision: SHA };
  } }, { ...domain, authorizedSeats: () => designated ? domain.authorizedSeats() : [] } as never);
  const service = createMcpToolService(bindings, store);
  const args = { revision: SHA, clientRequestId: `authority-${outcome}` };
  try {
    expect((await service.callTool("deploy_exact_sha", args)).ok).toBe(outcome === "accepted");
    designated = false;
    expect(await service.callTool("deploy_exact_sha", args)).toMatchObject({ ok: false, code: "deploy_caller_not_designated", retryable: false });
    expect(calls).toBe(1);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test.each([403, 503])("a definite HTTP refusal and an uncertain server failure keep distinct outcomes (%i)", async status => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "admission unavailable" }, { status }) });
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-refusal-"));
  const store = new SqliteMcpReceiptStore(path.join(root, "mcp.sqlite"));
  try {
    const bindings = viewerMcpBindings(undefined, productionViewerControlDependencies(true), domain as never);
    expect(await createMcpToolService(bindings, store).callTool("deploy_exact_sha", {
      revision: SHA, clientRequestId: `http-${status}`,
    })).toMatchObject({ ok: false, code: status === 403 ? "deploy_refused" : "outcome_unknown", retryable: false });
  } finally {
    store.close(); server.stop(true);
    if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(["write-refused", "seat-revoked"])("an admitted deployment remains accepted after attribution fails: %s", async cause => {
  let designated = true;
  const bindings = viewerMcpBindings(undefined, { post: async () => {
    if (cause === "seat-revoked") designated = false;
    return { state: "accepted", deploymentId: `admitted-${cause}`, revision: SHA };
  } }, {
    ...domain,
    authorizedSeats: () => designated ? domain.authorizedSeats() : [],
    recordSeatDeployment: async () => { throw new Error("fixture attribution write refused"); },
  } as never);
  expect(await bindings.deploy_exact_sha({ revision: SHA, clientRequestId: `admitted-${cause}` }))
    .toMatchObject({ state: "accepted", deploymentId: `admitted-${cause}`, wakeOnSettle: false });
});
});
