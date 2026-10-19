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
import { beginSeatDeployment, recordSeatDeployment, recordSeatDeploymentAdmission, seatDeploymentsFor } from "@/lib/orchestrator/seatDeployments";

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
  const bindings = viewerMcpBindings(undefined, { post: async (_url, body) => {
    posts++;
    const receipt = await coordinator.requestViewerDeployment(body as { revision: string; idempotencyKey: string });
    await recordSeatDeploymentAdmission(joinKey, receipt);
    throw new Error("busy-join response was lost after HTTP attribution committed");
  } }, domain as never);
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
