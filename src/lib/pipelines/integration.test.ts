import { beforeEach, expect, test } from "bun:test";
import { buildPipeline, loadPipelines, savePipelines, pipelineDeliveryLookup, pipelineRevision } from "./store";
import { defaultPipelinePorts, startPipelineIntegration, reportStageCompletion, patchPipeline } from "./engine";
import { registerPipelineTick } from "./controllerSignal";
import { setMergeOnReview } from "@/lib/projects/settings";
import { refreshReservation } from "@/lib/forge/autoRefresh";
import { integrationRecord, isPipelineIntegration, INTEGRATION_STAGES } from "./integration";
import type { Pipeline, PipelineStageAttempt } from "./types";

const NOW = "2026-11-04T00:00:00.000Z";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const target = { repository: "repo-integration", remote: "https://forge.example/acme/widgets.git", branch: "refs/heads/feature", pr: 11 };
const effectiveRole = { roleId: null, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null };
registerPipelineTick(async () => {});
beforeEach(() => {
  savePipelines([]);
  setMergeOnReview("fixture", true, "operator", NOW);
});

function finished(id = "outcome"): Pipeline {
  const p = buildPipeline({ id, task: "Integration fixture", project: "fixture", repoDir: "/fixture/repo", srcPath: null, srcConversationId: null,
    now: NOW, state: "draft", publication: "remote-branch",
    stages: [{ id: "feature", kind: "run", prompt: "Feature", next: null, effectiveRole }] });
  Object.assign(p, { state: "completed", cursor: null, closedAt: NOW, baseBranch: "main", baseRef: HEAD, lastPassedCommit: HEAD,
    delivery: { target, disposition: "owner", publish: "disabled", active: false, ownerId: id, epoch: 1, journal: [] } });
  p.merge = { state: "refreshing", by: null, repository: "acme/widgets", prNumber: 11, policyChangedAt: NOW,
    reviewedHead: HEAD, chain: [HEAD], updates: [], seenChecks: [], head: null, headSeenAt: null, lastChecks: null,
    readAt: null, nextReadAt: null, requestedAt: NOW, mergedHead: null, mergeCommit: null, method: null, mergedAt: null,
    attempts: 0, reason: null, blockedAt: null, updatedAt: NOW };
  p.merge.refresh = refreshReservation(p, BASE, HEAD, Date.parse(NOW), "main");
  p.merge.integration = integrationRecord(p, NOW);
  return p;
}
function ports() {
  const p = defaultPipelinePorts();
  p.now = () => NOW;
  p.exec = async () => ({ code: 0, stdout: `${HEAD}\trefs/heads/feature\n`, stderr: "" });
  p.roleLookup = roleId => ({ engine: "codex", model: null, effort: null, access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: "Fixture role" });
  p.spawnReceipt = () => null;
  p.durableTurnEvidence = async () => null;
  return p;
}

test("integration real admission retains outcome, graph history and reservation through durable replay", async () => {
  const p = finished(); savePipelines([p]);
  const key = p.merge!.refresh!.key;
  const first = await startPipelineIntegration(p, ports());
  expect(first.error).toBeUndefined();
  expect(first.pipeline).toMatchObject({ id: p.id, state: "provisioning", delivery: { epoch: 2, active: true },
    merge: { integration: { outcomeId: p.id, cycles: 1, reservationKey: key } } });
  expect(loadPipelines()).toHaveLength(1);
  expect(loadPipelines()[0]!.stages.map(s => s.id)).toEqual(["feature", ...INTEGRATION_STAGES]);
  expect(isPipelineIntegration(loadPipelines()[0]!.merge!.integration)).toBe(true);
  const replay = await startPipelineIntegration(loadPipelines()[0]!, ports());
  expect(replay.error).toBeUndefined();
  expect(replay.pipeline!.delivery!.epoch).toBe(2);
  expect(pipelineDeliveryLookup({ ...target, active: true })?.id).toBe(p.id);
});

test.each(["epoch", "reservation", "scope", "unknown publication", "foreign head", "policy", "comparison"] as const)("integration admission refuses racing %s", async change => {
  const p = finished(); savePipelines([p]);
  const h = ports();
  h.exec = async () => {
    const current = loadPipelines()[0]!;
    if (change === "epoch") current.delivery!.epoch++;
    if (change === "comparison") current.delivery!.disposition = "comparison";
    if (change === "reservation") current.merge!.refresh!.key = "new-reservation";
    if (change === "scope") current.project = "other-fixture";
    if (change === "unknown publication") current.merge!.effectUncertain = true;
    if (change === "policy") setMergeOnReview("fixture", false, "operator", NOW);
    savePipelines([current]);
    return { code: 0, stdout: `${change === "foreign head" ? BASE : HEAD}\trefs/heads/feature\n`, stderr: "" };
  };
  const result = await startPipelineIntegration(p, h);
  expect(result.error).toBeDefined();
  expect(loadPipelines()[0]!.state).toBe("completed");
  expect(loadPipelines()[0]!.delivery!.active).toBe(false);
});

test("integration preserves an active legacy owner and its immutable reservation receipt", async () => {
  const p = finished(), legacy = finished("legacy");
  legacy.state = "running"; legacy.closedAt = null;
  legacy.cursor = { stageId: "feature", state: "pending", input: null, activatedBy: null };
  legacy.delivery = { ...legacy.delivery!, active: true, publish: "enabled", epoch: 2 };
  legacy.creationRequest = { key: p.merge!.refresh!.key, digest: p.merge!.refresh!.digest };
  legacy.refreshOf = { pipelineId: p.id, base: BASE };
  delete legacy.merge;
  savePipelines([p, legacy]);
  const before = JSON.stringify(loadPipelines().find(row => row.id === legacy.id));
  const answer = await startPipelineIntegration(p, ports());
  expect(answer.pipeline?.id).toBe(legacy.id);
  expect(JSON.stringify(loadPipelines().find(row => row.id === legacy.id))).toBe(before);
  expect(loadPipelines().find(row => row.id === p.id)!.delivery!.active).toBe(false);
});

test("physical branch ownership spans project scopes", async () => {
  const p = finished(), peer = finished("peer");
  peer.project = "another-scope"; peer.state = "running"; peer.closedAt = null;
  peer.cursor = { stageId: "feature", state: "pending", input: null, activatedBy: null };
  peer.delivery = { ...peer.delivery!, active: true, publish: "enabled", epoch: 2 };
  delete peer.merge;
  savePipelines([p, peer]);
  expect((await startPipelineIntegration(p, ports())).error).toContain("another owner");
  expect(pipelineDeliveryLookup({ ...target, active: true })?.id).toBe("peer");
});

async function runningIntegration() {
  const p = finished(); savePipelines([p]);
  const h = ports();
  const admitted = await startPipelineIntegration(p, h);
  expect(admitted.error).toBeUndefined();
  const current = loadPipelines()[0]!;
  current.state = "running"; current.cursor!.state = "running";
  const stage = current.stages.find(s => s.id === "integration-resolve")!;
  current.runs.find(r => r.stageId === stage.id)!.attempts.push({ n: 1, state: "running", effectiveRole: stage.effectiveRole,
    launchId: "launch-integration", conversationId: "conversation_integration", sessionId: null, agentPath: null, paneId: null,
    flowId: null, startedAt: NOW, completedAt: null, output: null, verdict: null, error: null } as PipelineStageAttempt);
  savePipelines([current]);
  return h;
}

test("integration stage_report binds to the real owner attempt and preserves the report on disk", async () => {
  const h = await runningIntegration();
  const answer = await reportStageCompletion({ verdict: "pass", summary: "Integrated" }, { kind: "agent", conversationId: "conversation_integration", role: "merger" }, h);
  expect(answer.error).toBeUndefined();
  expect(answer).toMatchObject({ pipelineId: "outcome", stageId: "integration-resolve", attempt: 1 });
  expect(loadPipelines()[0]!.merge!.integration!.binding).toEqual({ stageId: "integration-resolve", attempt: 1,
    launchId: "launch-integration", conversationId: "conversation_integration" });
  expect(loadPipelines()[0]!.stageReports?.at(-1)?.status).toBe("pass");
});

test.each(["epoch", "revoke", "foreign conversation"] as const)("integration stage_report rejects %s", async change => {
  const h = await runningIntegration();
  const p = loadPipelines()[0]!;
  if (change === "epoch") { p.delivery!.epoch++; savePipelines([p]); }
  if (change === "revoke") setMergeOnReview("fixture", false, "operator", NOW);
  const answer = await reportStageCompletion({ verdict: "pass" }, { kind: "agent", role: "merger", conversationId: change === "foreign conversation" ? "conversation_foreign" : "conversation_integration" }, h);
  expect(answer.error).toBeDefined();
  expect(loadPipelines()[0]!.stageReports ?? []).toHaveLength(0);
});


async function restarted(action: "inspect" | "admit") {
  const child = Bun.spawn([process.execPath, new URL("./integration.process.fixture.ts", import.meta.url).pathname, action], {
    env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, `${stdout}\n${stderr}`).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("integration cursor, epoch and exhausted repair budget survive a real process restart", async () => {
  const p = finished();
  p.merge!.integration!.repairs = 3;
  p.merge!.integration!.batch = { owner: p.id, items: [p.id, "next-outcome"], cursor: 1, deadline: p.merge!.integration!.deadline };
  savePipelines([p]);
  const read = await restarted("inspect");
  expect(read.items).toHaveLength(1);
  expect(read.items[0].integration).toMatchObject({ repairs: 3, batch: { cursor: 1 } });
  const attempt = await restarted("admit");
  expect(attempt.result.error).toContain("repair budget exhausted");
  expect(attempt.items[0].epoch).toBe(1);
  expect(attempt.items[0].state).toBe("completed");
});

test("every integration state emitted by the runner survives the real store reader", () => {
  const p = finished();
  const states = ["queued", "legacy-draining", "resolving", "reviewing", "checking", "waiting", "blocked", "landing", "reconciling", "landed"] as const;
  for (const state of states) {
    p.merge!.integration!.state = state; savePipelines([p]);
    expect(loadPipelines()[0]!.merge!.integration!.state).toBe(state);
  }
});


test("an accepted integration decision renews requirements without resetting repair history", async () => {
  const h = await runningIntegration();
  h.stopStageAgent = async () => ({ outcome: "not-running" });
  h.stageHostResident = async () => false;
  const p = loadPipelines()[0]!;
  p.state = "needs_decision"; p.stateDetail = "Choose the compatible contract";
  const a = p.runs.find(r => r.stageId === "integration-resolve")!.attempts[0]!;
  a.state = "needs_decision"; a.verdict = { status: "needs_decision" }; a.completedAt = NOW;
  p.merge!.integration!.repairs = 2;
  savePipelines([p]);
  const answer = await patchPipeline(p.id, { action: "resolve-decision", clientRequestId: "integration-contract-answer", answer: "Keep the explicit allowed field",
    expectedStageId: "integration-resolve", expectedAttempt: 1, expectedRevision: pipelineRevision(p) }, h);
  expect(answer.error).toBeUndefined();
  const current = loadPipelines()[0]!;
  const { integrationRequirementRevision } = await import("./integration");
  expect(current.merge!.integration!.requirementRevision).toBe(integrationRequirementRevision(current));
  expect(current.merge!.integration!.repairs).toBe(2);
  expect(current.merge!.integration!.reviewedHead).toBeNull();
});


test("a parked integration retains its binding and records a blocked item for batch recovery", async () => {
  await runningIntegration();
  const p = loadPipelines()[0]!; p.state = "needs_decision";
  const { integrationAttempt } = await import("./integration"); integrationAttempt(p); savePipelines([p]);
  expect(loadPipelines()[0]!.merge!.integration).toMatchObject({ state: "blocked",
    binding: { stageId: "integration-resolve", launchId: "launch-integration", conversationId: "conversation_integration" } });
});
