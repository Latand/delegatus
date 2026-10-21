import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutDeploymentByIdempotencyKey } from "./deployments";
import { beginSeatDeployment, recoverSeatDeploymentRequests, seatDeploymentsFor } from "@/lib/orchestrator/seatDeployments";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("checkout deployment lookup resolves both original and joined admission keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-deployment-key-"));
  roots.push(root);
  const status = {
    deploymentId: "checkout-deploy-1", idempotencyKey: "original-key", idempotencyKeys: ["joined-key"],
    idempotencyRequests: [{ idempotencyKey: "joined-key", requestedRevision: "a".repeat(9) }],
    requestedRevision: "a".repeat(40), revision: "a".repeat(40), phase: "succeeded", terminal: true,
    candidate: null, previous: null, mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
    health: [], error: null, owner: { pid: 10, startIdentity: "10:1" },
    createdAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:01:00.000Z", revisionNumber: 2,
  };
  fs.writeFileSync(path.join(root, "deployments.json"), JSON.stringify([status]));

  expect(checkoutDeploymentByIdempotencyKey(root, "original-key")).toMatchObject({
    deploymentId: status.deploymentId, idempotencyKey: "original-key", terminal: true,
  });
  expect(checkoutDeploymentByIdempotencyKey(root, "joined-key")).toMatchObject({
    deploymentId: status.deploymentId, idempotencyKey: "joined-key", requestedRevision: "a".repeat(9), terminal: true,
  });
  expect(checkoutDeploymentByIdempotencyKey(root, "unrelated-key")).toBeNull();
});

test("uncertain seat admission recovers from the checkout ledger and records one settle wake", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-deployment-recovery-"));
  roots.push(root);
  const seat = "conversation_checkout_recovery";
  const key = "checkout-original-request";
  const revision = "b".repeat(40);
  const status = {
    deploymentId: "checkout-recovered", idempotencyKey: key, requestedRevision: revision, revision,
    phase: "succeeded", terminal: true, candidate: null, previous: null,
    mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
    owner: { pid: 11, startIdentity: "11:1" }, createdAt: "2026-10-19T12:00:00.000Z",
    updatedAt: "2026-10-19T12:01:00.000Z", revisionNumber: 2,
  };
  fs.writeFileSync(path.join(root, "deployments.json"), JSON.stringify([status]));
  await beginSeatDeployment({ conversationId: seat, project: "viewer", revision,
    requestedAt: "2026-10-19T12:00:00.000Z", idempotencyKey: key });

  await recoverSeatDeploymentRequests(seat, async requestKey => checkoutDeploymentByIdempotencyKey(root, requestKey));

  const records = seatDeploymentsFor(seat).filter(record => record.deploymentId === status.deploymentId);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ deploymentId: status.deploymentId, idempotencyKey: key, revision });
});
