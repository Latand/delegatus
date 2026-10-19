import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-deployments-"));
const previous = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { recordSeatDeployment, SEAT_DEPLOYMENTS_LIMIT, seatDeploymentsFile, seatDeploymentsFor } = await import("./seatDeployments");

const SEAT = "conversation_seat_a";
const OTHER = "conversation_seat_b";
const row = (deploymentId: string, conversationId = SEAT) => ({
  deploymentId, conversationId, project: "viewer", revision: "a".repeat(40), requestedAt: "2026-09-23T06:00:00.000Z",
});

test("seat writes yield under contention and recheck authority after admission", async () => {
  const { withFileTransaction } = await import("@/lib/state/fileTransaction");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withFileTransaction(seatDeploymentsFile(), "fixture lock", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let authorized = true;
  const writing = recordSeatDeployment(row("revoked-during-wait"), () => {
    if (!authorized) throw new Error("seat revoked while waiting");
  });
  queueMicrotask(() => { authorized = false; release.resolve(); });
  try { await expect(writing).rejects.toThrow("seat revoked while waiting"); }
  finally { release.resolve(); await holding; }
  expect(seatDeploymentsFor(SEAT).some(record => record.deploymentId === "revoked-during-wait")).toBe(false);
});

test("a seat's deployments are recorded once each and read back per seat (#2063)", async () => {
  await recordSeatDeployment(row("deploy-1"));
  /* A replayed deploy_exact_sha names the same deployment. */
  await recordSeatDeployment(row("deploy-1"));
  await recordSeatDeployment(row("deploy-2", OTHER));
  await recordSeatDeployment(row("deploy-3"));

  expect(seatDeploymentsFor(SEAT).map((record) => record.deploymentId)).toEqual(["deploy-1", "deploy-3"]);
  expect(seatDeploymentsFor(OTHER).map((record) => record.deploymentId)).toEqual(["deploy-2"]);
  expect(seatDeploymentsFor("conversation_nobody")).toEqual([]);
});

test("the record is bounded, oldest first out, and an unreadable file reads as none (#2063)", async () => {
  for (let index = 0; index < SEAT_DEPLOYMENTS_LIMIT + 5; index += 1) await recordSeatDeployment(row(`bulk-${index}`));
  const kept = seatDeploymentsFor(SEAT).map((record) => record.deploymentId);
  expect(kept).toHaveLength(SEAT_DEPLOYMENTS_LIMIT);
  expect(kept.at(-1)).toBe(`bulk-${SEAT_DEPLOYMENTS_LIMIT + 4}`);
  expect(kept).not.toContain("deploy-1");

  fs.writeFileSync(seatDeploymentsFile(), "{ torn");
  expect(seatDeploymentsFor(SEAT)).toEqual([]);
  await recordSeatDeployment(row("after-tear"));
  expect(seatDeploymentsFor(SEAT).map((record) => record.deploymentId)).toEqual(["after-tear"]);
});


test("a pending key stays bound to its authorized seat and revision until acceptance (#2346)", async () => {
  const { beginSeatDeployment, recoverSeatDeploymentRequests } = await import("./seatDeployments");
  const request = { conversationId: SEAT, project: "viewer", revision: "d".repeat(40),
    requestedAt: "2026-10-09T00:00:00Z", idempotencyKey: "pending-key" };
  await beginSeatDeployment(request);
  await beginSeatDeployment(request);
  await expect(beginSeatDeployment({ ...request, conversationId: OTHER })).rejects.toThrow("already attributed");
  await expect(beginSeatDeployment({ ...request, revision: "e".repeat(40) })).rejects.toThrow("already attributed");
  await recoverSeatDeploymentRequests(SEAT, async key => ({ idempotencyKey: key, requestedRevision: request.revision,
    revision: request.revision, deploymentId: "accepted-pending" }) as never);
  expect(seatDeploymentsFor(SEAT).filter(row => row.deploymentId === "accepted-pending")).toHaveLength(1);
  await expect(recordSeatDeployment({ ...row("accepted-pending", OTHER) })).rejects.toThrow("another seat");
  expect(seatDeploymentsFor(OTHER)).toEqual([]);
  await recoverSeatDeploymentRequests(SEAT, async () => { throw new Error("resolved requests need no lookup"); });
  expect(seatDeploymentsFor(SEAT).filter(row => row.deploymentId === "accepted-pending")).toHaveLength(1);
});
