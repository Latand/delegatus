import { describe, expect, test } from "bun:test";

import type { ViewerDeploymentPhase, ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import {
  DeploymentBusyError,
  managedActive,
  managedIdempotencyKey,
  managedUpdateState,
  observeDeployment,
  requestManagedUpdate,
  stepForPhase,
  type ManagedRecord,
} from "./managed";

/* #2007: the managed install's update is one Viewer deployment, read the
   way GET /api/runtime/deployments/:id reads it. */

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const TARGET = { version: "1.2.3", sha: SHA, short: SHA.slice(0, 7), date: "2026-09-22T10:00:00Z" };
const T0 = Date.parse("2026-09-22T12:00:00Z");

function status(phase: ViewerDeploymentPhase, at: number, extra: Partial<ViewerDeploymentStatus> = {}): ViewerDeploymentStatus {
  const terminal = phase === "succeeded" || phase === "rolled-back" || phase === "failed";
  return {
    deploymentId: "deployment-1",
    idempotencyKey: "k",
    requestedRevision: SHA,
    revision: SHA,
    phase,
    terminal,
    candidate: null,
    previous: null,
    mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
    health: [],
    error: null,
    owner: { pid: 1, startIdentity: null },
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(at).toISOString(),
    revisionNumber: 1,
    ...extra,
  };
}

async function requested(): Promise<{ record: ManagedRecord; bodies: ViewerDeploymentRequest[] }> {
  const bodies: ViewerDeploymentRequest[] = [];
  const record = await requestManagedUpdate(TARGET, "press-1", async (body) => {
    bodies.push(body);
    return { state: "accepted", deploymentId: "deployment-1", revision: SHA, replayed: false };
  }, () => T0);
  return { record, bodies };
}

describe("requestManagedUpdate", () => {
  test("pins the exact revision the check showed, with a key per press", async () => {
    const { record, bodies } = await requested();
    expect(bodies).toEqual([{ revision: SHA, idempotencyKey: `self-update-${SHA.slice(0, 12)}-press-1` }]);
    expect(record).toMatchObject({ deploymentId: "deployment-1", target: SHA, targetShort: SHA.slice(0, 7), targetVersion: "1.2.3", finishedAt: null });
    expect(managedActive(record)).toBe(true);
  });

  test("a deployment already running is refused as busy", async () => {
    await expect(requestManagedUpdate(TARGET, "press-2", async () => ({ state: "busy", deploymentId: "other", revision: SHA })))
      .rejects.toBeInstanceOf(DeploymentBusyError);
  });

  test("a key that is not letters, digits and dashes is refused before anything is asked", () => {
    expect(() => managedIdempotencyKey(SHA, "a b")).toThrow();
  });
});

describe("phases → steps", () => {
  test("each journalled phase is one of six steps", () => {
    expect(["admitted", "building", "candidate-starting", "candidate-health", "promoting", "post-promotion-health", "host-handoff"].map((phase) => stepForPhase(phase as ViewerDeploymentPhase)))
      .toEqual(["admit", "image", "candidate", "health", "promote", "promote", "handoff"]);
    expect(stepForPhase("succeeded")).toBeNull();
  });

  test("a running deployment shows done steps with durations and the current one running", async () => {
    let { record } = await requested();
    record = observeDeployment(record, status("admitted", T0 + 1_000));
    record = observeDeployment(record, status("building", T0 + 2_000));
    record = observeDeployment(record, status("candidate-starting", T0 + 62_000, { servingProgress: "candidate container started" }));
    const update = managedUpdateState(record, T0 + 70_000);
    expect(update.state).toBe("running");
    expect(update.steps.map((step) => [step.name, step.state])).toEqual([
      ["admit", "done"], ["image", "done"], ["candidate", "running"], ["health", "pending"], ["promote", "pending"], ["handoff", "pending"],
    ]);
    expect(update.steps[1]!.durationMs).toBe(60_000);
    expect(update.steps[2]!.durationMs).toBe(8_000);
    expect(update.steps[2]!.tail).toEqual(["candidate container started"]);
  });

  test("success marks every step done, handoff included", async () => {
    let { record } = await requested();
    for (const [phase, at] of [["building", 1], ["candidate-starting", 2], ["candidate-health", 3], ["promoting", 4], ["post-promotion-health", 5], ["host-handoff", 6]] as const) {
      record = observeDeployment(record, status(phase, T0 + at * 1_000));
    }
    record = observeDeployment(record, status("succeeded", T0 + 9_000));
    const update = managedUpdateState(record, T0 + 20_000);
    expect(update.state).toBe("done");
    expect(update.steps.every((step) => step.state === "done")).toBe(true);
    expect(update.steps.at(-1)!.durationMs).toBe(3_000);
    expect(update.finishedAt).toBe(new Date(T0 + 9_000).toISOString());
    expect(managedActive(record)).toBe(false);
  });

  test("a rollback is reported at the step that was running, with the host's error", async () => {
    let { record } = await requested();
    record = observeDeployment(record, status("candidate-health", T0 + 5_000));
    record = observeDeployment(record, status("rolling-back", T0 + 9_000, { error: "candidate health gate failed: GET / answered 500" }));
    record = observeDeployment(record, status("rolled-back", T0 + 12_000, { error: "candidate health gate failed: GET / answered 500" }));
    const update = managedUpdateState(record, T0 + 30_000);
    expect(update.state).toBe("failed");
    expect(update.rolledBack).toBe(true);
    const failed = update.steps.find((step) => step.state === "failed")!;
    expect(failed.name).toBe("health");
    expect(failed.tail).toEqual(["candidate health gate failed: GET / answered 500"]);
    expect(update.steps.filter((step) => step.state === "pending").map((step) => step.name)).toEqual(["promote", "handoff"]);
  });

  test("a failed handoff is failed without a rollback: web already runs the new release", async () => {
    let { record } = await requested();
    record = observeDeployment(record, status("host-handoff", T0 + 5_000));
    record = observeDeployment(record, status("failed", T0 + 9_000, { error: "successor did not take the fence" }));
    const update = managedUpdateState(record, T0 + 30_000);
    expect(update.state).toBe("failed");
    expect(update.rolledBack).toBe(false);
    expect(update.steps.find((step) => step.state === "failed")!.name).toBe("handoff");
  });

  test("no read yet: the deployment is admitted and running", async () => {
    const { record } = await requested();
    const update = managedUpdateState(observeDeployment(record, null), T0 + 1_000);
    expect(update.steps[0]!.state).toBe("running");
  });
});
