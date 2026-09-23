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

test("a seat's deployments are recorded once each and read back per seat (#2063)", () => {
  recordSeatDeployment(row("deploy-1"));
  /* A replayed deploy_exact_sha names the same deployment. */
  recordSeatDeployment(row("deploy-1"));
  recordSeatDeployment(row("deploy-2", OTHER));
  recordSeatDeployment(row("deploy-3"));

  expect(seatDeploymentsFor(SEAT).map((record) => record.deploymentId)).toEqual(["deploy-1", "deploy-3"]);
  expect(seatDeploymentsFor(OTHER).map((record) => record.deploymentId)).toEqual(["deploy-2"]);
  expect(seatDeploymentsFor("conversation_nobody")).toEqual([]);
});

test("the record is bounded, oldest first out, and an unreadable file reads as none (#2063)", () => {
  for (let index = 0; index < SEAT_DEPLOYMENTS_LIMIT + 5; index += 1) recordSeatDeployment(row(`bulk-${index}`));
  const kept = seatDeploymentsFor(SEAT).map((record) => record.deploymentId);
  expect(kept).toHaveLength(SEAT_DEPLOYMENTS_LIMIT);
  expect(kept.at(-1)).toBe(`bulk-${SEAT_DEPLOYMENTS_LIMIT + 4}`);
  expect(kept).not.toContain("deploy-1");

  fs.writeFileSync(seatDeploymentsFile(), "{ torn");
  expect(seatDeploymentsFor(SEAT)).toEqual([]);
  recordSeatDeployment(row("after-tear"));
  expect(seatDeploymentsFor(SEAT).map((record) => record.deploymentId)).toEqual(["after-tear"]);
});
