import { afterAll, afterEach, spyOn } from "bun:test";
import path from "node:path";
import { expect, test, createPipelineFromRequest, loadPipelines, savePipelines, patchPipeline, closeAndDrain } from "./engine.fixture";

import { NOW } from "@/lib/tasks/proactive.fixture";

import { agentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { captureProcessIdentity } from "@/lib/processIdentity";

import { assertProactivePipelineExecution } from "@/lib/tasks/proactiveExecution";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { TASKS_FILE, loadTasksByIds, mutateTasks } from "@/lib/tasks/store";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { setProjectWorkerLimit } from "@/lib/operator/workerLimit";

import { fixture } from "./engine.proactive.fixture";

const clock = spyOn(Date, "now").mockImplementation(() => NOW);
afterEach(() => { clock.mockImplementation(() => NOW); });
afterAll(() => clock.mockRestore());

const pausedWorkerStates = ["deferred", "unconfirmed", "failed", "unresolved", "throws", "starting", "exiting", "survivor", "claimed", "pending", "dead", "unhosted"] as const;
test.each([
  ...pausedWorkerStates.map(kind => ["pause", kind] as const),
  ["close", "unconfirmed"], ["close", "dead"], ["close", "unhosted"],
] as const)("%s lane worker capacity follows retained custody: %s", async (action, kind) => {
  const f = await fixture(`${action}-worker-${kind}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Requested correction", placement: "unplaced" }, [],
      { id: () => `${action}-ordinary-${kind}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const made = await createPipelineFromRequest({ task: ordinary.text, repoDir: "/repo", taskIds: [ordinary.id], publication: "internal",
    stages: [{ id: "work", kind: "run", role: { roleId: "builder" }, prompt: "Apply the correction", next: null }] }, f.h.ports);
  if (!made.pipeline) throw new Error(made.error);
  const ordinaryId = made.pipeline.id;
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: made.pipeline.worktreeDir, taskIds: [ordinary.id],
    conversationId: `conversation_${action}_worker_${kind}`, role: "builder",
    origin: { kind: "container", container: "pipeline", containerId: ordinaryId, creatorConversationId: null },
    memberships: [{ kind: "pipeline", containerId: ordinaryId, role: "builder", slot: "work:1", stageId: "work", stageOrder: 0, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: made.pipeline.worktreeDir, model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary worker required");
  const workerIndex = pausedWorkerStates.indexOf(kind) + 1 + (action === "close" ? pausedWorkerStates.length : 0);
  const sessionId = ["20000000", "0000", "4000", "8000", workerIndex.toString(16).padStart(12, "0")].join("-");
  const artifactPath = `/codex/${sessionId}.jsonl`;
  const entry = { key: sessionKeyFromTranscript("codex", artifactPath)!, artifactPath, cwd: made.pipeline.worktreeDir,
    accountId: null, status: "dead" as const, host: null, claimEpoch: 0, claimOwner: null, pendingAction: null };
  const settled = kind === "dead" || kind === "unhosted";
  if (kind !== "starting") registry.completeSpawn(begun.receipt.launchId, {
    ...entry, status: kind === "unhosted" ? "unhosted" : settled || ["exiting", "survivor", "claimed", "pending"].includes(kind) ? "dead" : "live",
    claimOwner: kind === "claimed" ? "pending-owner" : null, pendingAction: kind === "pending" ? "resume" : null,
    ...(kind === "exiting" ? { pendingHostExits: [{ process: captureProcessIdentity(process.pid), launchId: null }] } : {}),
    ...(kind === "survivor" ? { structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] } : {}),
  });
  mutateTasks(tasks => {
    const patched = patchTask(tasks, ordinary.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  await f.tick();
  const spawns = () => f.h.spawnInputs.filter(input => input.membership.containerId === f.id);
  expect(spawns()).toHaveLength(0);
  expect(f.current().stateDetail).toContain("capacity is exhausted");
  const ordinaryLane = loadPipelines().find(lane => lane.id === ordinaryId)!;
  const attempt = ordinaryLane.runs[0]!.attempts.at(-1)!;
  expect(attempt.state).toBe("running");
  attempt.conversationId = begun.receipt.conversationId;
  attempt.launchId = begun.receipt.launchId;
  attempt.agentPath = artifactPath;
  attempt.paneId = null;
  savePipelines(loadPipelines().map(lane => lane.id === ordinaryId ? ordinaryLane : lane));
  f.h.setConversationActive(true);
  f.h.ports.stopStageAgent = async () => {
    if (kind === "throws") throw new Error("stop confirmation unavailable");
    if (kind === "failed") return { outcome: "failed", error: "stop confirmation unavailable" };
    if (kind === "unconfirmed") return { outcome: "unconfirmed", operationId: null, detail: "stop confirmation unavailable" };
    if (kind === "unresolved") return { outcome: "unresolved", error: "host still alive", survivors: [captureProcessIdentity(process.pid)] };
    return { outcome: settled ? "stopped" : "deferred" };
  };
  const stop = () => action === "close"
    ? closeAndDrain(ordinaryId, { action: "close" }, f.h.ports)
    : patchPipeline(ordinaryId, { action: "pause", reason: "Hold requested work" }, f.h.ports);
  expect((await stop()).error).toBeUndefined();
  const stopped = loadPipelines().find(lane => lane.id === ordinaryId)!;
  if (action === "close") {
    expect(stopped.closedAt).toBeTruthy();
    expect(stopped.closeReport!.unconfirmed).toHaveLength(settled ? 0 : 1);
    if (!settled) expect(Object.values(registry.conversationRetentionSnapshot(begun.receipt.conversationId).entries)
      .some(row => row.status === "live")).toBe(true);
  } else {
    expect(stopped.state).toBe("paused");
    expect(!!stopped.runs[0]!.attempts.at(-1)!.suspension?.stoppedAt).toBe(settled);
  }
  const check = () => assertProactivePipelineExecution(f.current(), "dispatch");
  expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
  await f.tick();
  expect(spawns()).toHaveLength(settled ? 1 : 0);
  if (settled) expect(check).not.toThrow();
  else expect(check).toThrow("worker capacity is exhausted");
  // A fresh process must observe the same retained capacity after pause or close.
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "lane-dispatch"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    const result = JSON.parse(out.split("RESULT ")[1]!);
    if (settled) expect(result).toEqual({ error: null });
    else expect(result.error).toContain("worker capacity is exhausted");
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  if (!settled) {
    if (["deferred", "unconfirmed", "failed", "throws", "starting", "claimed", "pending"].includes(kind)) {
      if (kind === "starting") registry.completeSpawn(begun.receipt.launchId, entry);
      else registry.upsert(entry);
      f.h.ports.stopStageAgent = async () => ({ outcome: "stopped" });
      expect((await stop()).error).toBeUndefined();
      expect(() => assertProactivePipelineExecution(f.current(), "dispatch")).not.toThrow();
      expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      await f.tick();
      expect(spawns()).toHaveLength(1);
    }
  }
});

const standaloneStates = ["dead", "unhosted", "live", "claimed", "pending", "starting", "exiting", "survivor"] as const;
test.each([...standaloneStates])("review probe: standalone worker capacity follows retained custody: %s", async kind => {
  const f = await fixture(`standalone-${kind}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Completed requested work", placement: "unplaced" }, [],
      { id: () => `ordinary-${kind}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: "/repo", taskIds: [ordinary.id],
    conversationId: `conversation_standalone_${kind}`, origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary conversation required");
  const sessionId = ["10000000", "0000", "4000", "8000", (standaloneStates.indexOf(kind) + 1).toString(16).padStart(12, "0")].join("-");
  const artifactPath = `/codex/${sessionId}.jsonl`;
  if (kind !== "starting") registry.completeSpawn(begun.receipt.launchId, {
    key: sessionKeyFromTranscript("codex", artifactPath)!, artifactPath, cwd: "/repo", accountId: null,
    status: kind === "unhosted" ? "unhosted" : kind === "live" ? "live" : "dead", host: null, claimEpoch: 0,
    claimOwner: kind === "claimed" ? "pending-owner" : null, pendingAction: kind === "pending" ? "resume" : null,
    ...(kind === "exiting" ? { pendingHostExits: [{ process: captureProcessIdentity(process.pid), launchId: null }] } : {}),
    ...(kind === "survivor" ? { structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] } : {}),
  });
  mutateTasks(tasks => {
    const patched = patchTask(tasks, ordinary.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  expect(loadTasksByIds(new Set([ordinary.id]))[0]!.assignments.some(row => row.state === "linked")).toBe(true);
  expect(registry.conversationMemberships(begun.receipt.conversationId).filter(member => member.kind === "pipeline")).toEqual([]);
  const error = () => { try { assertProactivePipelineExecution(f.current(), "dispatch"); return null; } catch (error) { return String(error); } };
  const settled = kind === "dead" || kind === "unhosted";
  if (settled) expect(error()).toBeNull();
  else expect(error()).toContain("worker capacity is exhausted");
  // Capacity is recomputed from the durable registry after a real process restart.
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "lane-dispatch"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    const result = JSON.parse(out.split("RESULT ")[1]!);
    if (settled) expect(result).toEqual({ error: null });
    else expect(result.error).toContain("worker capacity is exhausted");
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
});
