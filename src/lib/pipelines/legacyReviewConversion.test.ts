import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

/* The explicit legacy review-loop conversion, driven through the real engine
   action and real ticks. Every port is a mock and the state directory is
   private to this file: nothing reaches a host, an account, a flow row or the
   operator's registry. Fixtures are synthetic. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-review-conversion-"));
const { createPipelineFromRequest, patchPipeline, tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { archiveSettledPipelines, findPipelineRecord, loadPipelines, pipelineRevision, savePipelines } = await import("./store");
const legacy = await import("./legacyReviewDefinition");
const { asStoredLegacyReviewLane } = await import("./fixtures/legacyReviewLane");
const { pipelineCompletedUnreviewed } = await import("./failEdgeBudget");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
const { createMcpToolService, FileMcpReceiptStore } = await import("@/lib/mcp/server");
type PipelinePorts = import("./engine").PipelinePorts;
type Pipeline = import("./types").Pipeline;
type ViewerMcpDomainDependencies = import("@/lib/mcp/bindings").ViewerMcpDomainDependencies;

registerPipelineTick(async () => {});
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const BASE = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
const HEADS = Array.from({ length: 12 }, (_, index) => String(index + 1).repeat(40).slice(0, 40));
const creator = { kind: "agent", role: "orchestrator", conversationId: "conversation_creator" } as const;
const stranger = { kind: "agent", role: "builder", conversationId: "conversation_stranger" } as const;

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

function harness() {
  const messages = new Map<string, { text: string; ts: number }>();
  const spawned: Array<{ stageId: string; prompt: string; conversationId: string }> = [];
  const flows = new Map<string, Flow>();
  const flowCalls: string[] = [];
  let head = BASE;
  let heads = 0;
  let clock = 1_000_000;
  const ports: PipelinePorts = {
    exec: (command, rawArgs) => {
      const args = command === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${head}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${BASE}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: (roleId) => {
      if (roleId === "builder") return { engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "Builder guidance" };
      if (roleId === "reviewer") return { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: "Reviewer guidance" };
      if (roleId === "architect") return { engine: "codex", model: "gpt-5.6-sol", effort: "high", access: "read-only", promptScaffold: "Architect guidance" };
      return null;
    },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    spawnAgent: async (input, onReserved) => {
      const n = spawned.length + 1;
      spawned.push({ stageId: input.membership.stageId ?? "", prompt: input.prompt, conversationId: `conversation_stage_${n}` });
      await onReserved({ launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, accountId: "account-a" });
      return { launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, sessionId: `session-${n}`, transcript: `/codex/stage-${n}.jsonl`, paneId: `%${n}`, accountId: "account-a" };
    },
    paneAgentAlive: async () => true,
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "stopped" }),
    stageHostResident: async () => false,
    monotonicNow: () => Date.now(),
    worktreePresent: () => true,
    conversationAgentActive: async () => null,
    durableTurnEvidence: async () => null,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => {
      const n = /^conversation_stage_(\d+)$/.exec(id)?.[1];
      return n ? `/codex/stage-${n}.jsonl` : null;
    },
    sourcePathAllowed: (pathname) => pathname.startsWith("/codex/") && pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => {
      if (pathname === "/codex/creator.jsonl") return "conversation_creator";
      const n = /stage-(\d+)\.jsonl$/.exec(pathname)?.[1];
      return n ? `conversation_stage_${n}` : null;
    },
    pipelineAdoptionCandidates: () => [],
    createFlow: async () => { flowCalls.push("create"); return { error: "no new review flows in this suite" }; },
    patchFlow: (id, action) => { flowCalls.push(`patch:${id}:${action}`); return {}; },
    closeFlow: async (id) => { flowCalls.push(`close:${id}`); return {}; },
    getFlow: (id) => flows.get(id) ?? null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  /** Settles the cursor stage's newest attempt; a passing writer moves HEAD first. */
  const settle = async (status: "pass" | "fail", findings: string[] = []) => {
    await tickPipelines([], ports);
    const pipeline = loadPipelines()[0]!;
    const stageId = pipeline.cursor!.stageId;
    const attempt = pipeline.runs.find((run) => run.stageId === stageId)!.attempts.filter((item) => !item.historical).at(-1)!;
    if (status === "pass" && attempt.effectiveRole.access === "read-write") { heads += 1; head = HEADS[heads - 1]!; }
    messages.set(attempt.agentPath!, { text: `${stageId} done\n\n\`\`\`json\n${JSON.stringify({ status, ...(findings.length ? { findings } : {}) })}\n\`\`\``, ts: clock + 100_000_000 });
    await tickPipelines([entry(attempt.agentPath!)], ports);
    return stageId;
  };
  return { ports, spawned, flows, flowCalls, settle };
}

const LEGACY_STAGES = [
  { id: "architect", kind: "run", role: { roleId: "architect" }, access: "read-only", prompt: "Plan {{task}}", next: "builder" },
  { id: "builder", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build {{task}} from {{prev.output}}", next: "reviewer" },
  { id: "reviewer", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review against the spec", next: "ship" },
  { id: "ship", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Ship {{prev.output}}", next: null },
];

async function legacyDraft(ports: PipelinePorts, stages: unknown[] = LEGACY_STAGES): Promise<Pipeline> {
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Legacy review", spec: "AC", repoDir: "/repo", baseBranch: "main", baseRef: BASE, stages: stages as never, autoStart: false, src: "/codex/creator.jsonl" }, ports);
  if (!created.pipeline) throw new Error(created.error);
  /* A draft stored before #2187, whose review-loop creation did not convert. */
  const draft = asStoredLegacyReviewLane(created.pipeline, created.convertedStages);
  savePipelines([draft]);
  return draft;
}

const current = () => loadPipelines()[0]!;
const attemptsOf = (stageId: string) => current().runs.find((run) => run.stageId === stageId)!.attempts;
const rawRow = (id: string) => JSON.stringify(findPipelineRecord(id));
/** Converts against the stored record's revision unless the call names one. */
const convert = (pipeline: Pipeline, extra: Record<string, unknown> = {}, ports?: PipelinePorts, actor: Parameters<typeof patchPipeline>[3] = creator) =>
  patchPipeline(pipeline.id, { action: "convert-legacy-review", clientRequestId: "convert-1", expectedRevision: pipelineRevision(findPipelineRecord(pipeline.id)!), ...extra } as never, ports, actor);

/** A lane whose legacy review ran and settled, parked for the operator. */
function parkedLegacyLane(draft: Pipeline, review: Record<string, unknown>, over: Partial<Pipeline> = {}): Pipeline {
  const lane = structuredClone(draft);
  const settled = (n: number, stageId: string, extra: Record<string, unknown>) => ({
    n, state: "passed", effectiveRole: lane.stages.find((stage) => stage.id === stageId)!.effectiveRole, launchId: null, conversationId: `conversation_old_${stageId}_${n}`,
    sessionId: null, agentPath: `/codex/old-${stageId}-${n}.jsonl`, paneId: null, flowId: null, startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T01:00:00.000Z",
    input: null, activatedBy: null, output: "done", verdict: { status: "pass" }, error: null, ...extra,
  });
  Object.assign(lane, {
    state: "needs_decision", stateDetail: "review flow closed", lastPassedCommit: BASE,
    cursor: { stageId: "reviewer", state: "reviewing", input: "built", activatedBy: { stageId: "builder", attempt: 1, edge: "pass" } },
    runs: lane.runs.map((run) => run.stageId === "architect" || run.stageId === "builder"
      ? { ...run, attempts: [settled(1, run.stageId, {})] }
      : run.stageId === "reviewer" ? { ...run, attempts: [settled(1, "reviewer", { flowId: "flow-old", state: "failed", verdict: { status: "fail", findings: ["P1 — old gap"] }, ...review })] } : run),
    ...over,
  });
  savePipelines([lane]);
  return lane;
}

afterEach(() => { delete process.env.LLV_PIPELINE_LEGACY_REVIEW_CONVERSION; });

test("preview answers the converted plan and writes nothing, for hot and archived drafts", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  const before = rawRow(draft.id);
  const preview = await patchPipeline(draft.id, { action: "preview-legacy-review", reviewLimit: 3 } as never, h.ports);
  expect(preview.error).toBeUndefined();
  expect(preview.legacyReviewPreview).toMatchObject({ ok: true, stageId: "reviewer", fixerStageId: "reviewer-fix", implementerStageId: "builder", reviewLimit: 3, reviewerActivations: 3 });
  expect(rawRow(draft.id)).toBe(before);
  /* An archived draft previews the same, and stays where it is. */
  savePipelines([{ ...structuredClone(current()), hiddenAt: "2026-08-01T00:00:00.000Z", delivery: undefined }]);
  await archiveSettledPipelines(Date.parse("2026-09-22T00:00:00.000Z"));
  expect(loadPipelines()).toEqual([]);
  const archived = await patchPipeline(draft.id, { action: "preview-legacy-review" } as never, h.ports);
  expect(archived.legacyReviewPreview).toMatchObject({ ok: true, reviewLimit: 5, reviewLimitSource: "default" });
  const refused = await convert(findPipelineRecord(draft.id)!, {}, h.ports);
  expect(refused.status).toBe(409);
  expect(refused.error).toContain("archived");
  expect(h.flowCalls).toEqual([]);
});

test("conversion is explicit, revision-fenced, attributed and idempotent by clientRequestId", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  expect((await patchPipeline(draft.id, { action: "convert-legacy-review", expectedRevision: pipelineRevision(draft) } as never, h.ports, creator)).status).toBe(400);
  expect((await convert(draft, { expectedRevision: "0".repeat(64) }, h.ports)).code).toBe("STAGE_CHANGED");
  expect((await convert(draft, {}, h.ports, stranger)).status).toBe(403);
  process.env.LLV_PIPELINE_LEGACY_REVIEW_CONVERSION = "0";
  expect((await convert(draft, {}, h.ports)).error).toContain("disabled");
  delete process.env.LLV_PIPELINE_LEGACY_REVIEW_CONVERSION;
  expect(current().stages.find((stage) => stage.id === "reviewer")!.kind).toBe("review-loop");

  const revision = pipelineRevision(current());
  const accepted = await convert(draft, { reviewLimit: 2 }, h.ports);
  expect(accepted.error).toBeUndefined();
  expect(accepted.replayed).toBe(false);
  expect(accepted.legacyReviewConversion).toMatchObject({ clientRequestId: "convert-1", stageId: "reviewer", fixerStageId: "reviewer-fix", reviewLimit: 2, reviewLimitSource: "request", actor: creator });
  const converted = current();
  expect(converted.stages.map((stage) => `${stage.id}:${stage.kind}`)).toEqual(["architect:run", "builder:run", "reviewer:run", "reviewer-fix:run", "ship:run"]);
  expect(converted.stages[2]!.onFail).toEqual({ to: "reviewer-fix", maxRounds: 2, onExhausted: "advance" });
  /* One mutation wrote both the converted plan and the immutable original. */
  expect(converted.legacyReviewConversions![0]!.original.stages).toEqual(draft.stages);

  const convertedRow = rawRow(draft.id);
  const replay = await convert(draft, { reviewLimit: 2, expectedRevision: revision }, h.ports);
  expect(replay).toMatchObject({ replayed: true, legacyReviewConversion: accepted.legacyReviewConversion });
  expect(rawRow(draft.id)).toBe(convertedRow);
  expect((await convert(draft, { reviewLimit: 3, expectedRevision: revision }, h.ports)).error).toContain("different");
  /* A second, fresh request finds nothing legacy left. */
  const again = await convert(converted, { clientRequestId: "convert-2" }, h.ports);
  expect(again.status).toBe(409);
  expect(rawRow(draft.id)).toBe(convertedRow);
  expect(h.flowCalls).toEqual([]);
});

test("a crash inside the conversion mutation leaves the original record; reload after it holds the whole conversion", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  const before = rawRow(draft.id);
  const real = legacy.applyLegacyReviewConversion;
  const crash = spyOn(legacy, "applyLegacyReviewConversion").mockImplementation((...args: Parameters<typeof real>) => {
    real(...args);
    throw new Error("simulated crash after the in-memory conversion");
  });
  try {
    await expect(convert(draft, {}, h.ports)).rejects.toThrow("simulated crash");
  } finally {
    crash.mockRestore();
  }
  expect(rawRow(draft.id)).toBe(before);
  expect((await convert(draft, {}, h.ports)).error).toBeUndefined();
  const reloaded = findPipelineRecord(draft.id)!;
  expect(reloaded.stages.some((stage) => stage.kind === "review-loop")).toBe(false);
  expect(reloaded.legacyReviewConversions).toHaveLength(1);
  expect(reloaded.runs.map((run) => run.stageId)).toEqual(reloaded.stages.map((stage) => stage.id));
});

test.each([1, 2, 3])("a flow limit of %i runs the converted reviewer exactly that many times, the final review included", async (limit) => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  expect((await convert(draft, { reviewLimit: limit }, h.ports)).error).toBeUndefined();
  expect((await patchPipeline(draft.id, { action: "start" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  for (let step = 0; step < 40 && current().state === "running"; step += 1) {
    const stageId = current().cursor!.stageId;
    await h.settle(stageId === "reviewer" ? "fail" : "pass", stageId === "reviewer" ? [`gap ${step}`] : []);
  }
  const reviews = h.spawned.filter((spawn) => spawn.stageId === "reviewer");
  const fixes = h.spawned.filter((spawn) => spawn.stageId === "reviewer-fix");
  expect(reviews).toHaveLength(limit);
  expect(fixes).toHaveLength(limit);
  /* Each review is a fresh conversation, and each fix receives that review's findings. */
  expect(new Set(reviews.map((spawn) => spawn.conversationId)).size).toBe(limit);
  expect(fixes.every((spawn) => spawn.prompt.includes("gap"))).toBe(true);
  /* The architect and builder ran once: no predecessor was reused as the fixer. */
  expect(h.spawned.filter((spawn) => spawn.stageId === "architect" || spawn.stageId === "builder")).toHaveLength(2);
  /* The last fix wrote a head nobody reviewed. Under the converted edge's
     `advance` the lane moves on to ship with those findings named as
     unreviewed and completes (#2187), and the record says so. */
  expect(current().state).toBe("completed");
  expect(current().reviewPending).toBeUndefined();
  const ships = h.spawned.filter((spawn) => spawn.stageId === "ship");
  expect(ships).toHaveLength(1);
  expect(ships[0]!.prompt).toContain(`gap ${2 * limit}`);
  expect(ships[0]!.prompt).toContain("not re-reviewed");
  expect(pipelineCompletedUnreviewed(current())).toMatchObject({ stageId: "reviewer", findings: 1 });
});

test("settled legacy attempts stay history; the converted stage runs fresh after an explicit retry and an old approval passes nothing", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  h.flows.set("flow-old", { id: "flow-old", state: "closed", roundLimit: 3, rounds: [] } as unknown as Flow);
  const lane = parkedLegacyLane(draft, {});
  const flowsBefore = JSON.stringify([...h.flows]);
  const accepted = await convert(lane, {}, h.ports);
  expect(accepted.error).toBeUndefined();
  /* The flow's own limit carries over. */
  expect(accepted.legacyReviewConversion).toMatchObject({ reviewLimit: 3, reviewLimitSource: "flow" });
  const kept = attemptsOf("reviewer");
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ ...lane.runs[2]!.attempts[0]!, historical: true, legacyReview: true });
  expect(current()).toMatchObject({ state: "needs_decision", stateDetail: "review stage reviewer was converted to run stages; retry it to run the new reviewer", cursor: { stageId: "reviewer", state: "pending", input: "built" } });
  expect(JSON.stringify([...h.flows])).toBe(flowsBefore);

  expect((await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "reviewer", expectedAttempt: 0 }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(h.spawned.map((spawn) => spawn.stageId)).toEqual(["reviewer"]);
  const fresh = attemptsOf("reviewer").at(-1)!;
  expect(fresh).toMatchObject({ n: 2, flowId: null });
  expect(fresh.historical).toBeUndefined();
  expect(h.flowCalls).toEqual([]);
});

test("an approved legacy review is not the converted reviewer's pass", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  h.flows.set("flow-old", { id: "flow-old", state: "approved", roundLimit: 5, rounds: [] } as unknown as Flow);
  const lane = parkedLegacyLane(draft, { state: "passed", verdict: { status: "pass" } }, {
    state: "paused", pausedState: "running", cursor: { stageId: "ship", state: "pending", input: "approved", activatedBy: { stageId: "reviewer", attempt: 1, edge: "pass" } },
  });
  expect((await convert(lane, {}, h.ports)).error).toBeUndefined();
  const reviewer = attemptsOf("reviewer");
  expect(reviewer).toHaveLength(1);
  expect(reviewer[0]).toMatchObject({ state: "passed", historical: true, legacyReview: true });
  expect(reviewer.filter((attempt) => !attempt.historical)).toEqual([]);
  expect(current().cursor).toEqual(lane.cursor);
});

test("the paused unsafe-relay lane, unresolved delivery and live ownership refuse conversion and stay byte-for-byte", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  h.flows.set("flow-old", { id: "flow-old", state: "paused", pausedState: "relaying", roundLimit: 5, rounds: [{ n: 1 }] } as unknown as Flow);
  const frozen = parkedLegacyLane(draft, {});
  const flowsBefore = JSON.stringify([...h.flows]);
  for (const action of ["preview-legacy-review", "convert-legacy-review"] as const) {
    const before = rawRow(frozen.id);
    const result = action === "convert-legacy-review"
      ? await convert(frozen, {}, h.ports)
      : await patchPipeline(frozen.id, { action } as never, h.ports);
    const refusal = action === "convert-legacy-review" ? result : result.legacyReviewPreview;
    expect(JSON.stringify(refusal)).toContain("live-flow");
    expect(rawRow(frozen.id)).toBe(before);
  }
  expect(JSON.stringify([...h.flows])).toBe(flowsBefore);
  expect(h.flowCalls).toEqual([]);

  /* A flow row that cannot be read is not assumed settled. */
  h.flows.delete("flow-old");
  expect(JSON.stringify(await convert(frozen, {}, h.ports))).toContain("live-flow");

  h.flows.set("flow-old", { id: "flow-old", state: "closed", roundLimit: 5, rounds: [] } as unknown as Flow);
  const delivering = parkedLegacyLane(draft, {}, {
    delivery: { target: { repository: "owner/repo", remote: "origin", branch: "refs/heads/lane" }, disposition: "owner", publish: "enabled", ownerId: draft.id, epoch: 1, active: true, journal: [], operation: { id: "op-1", epoch: 1, sha: BASE, state: "running" } },
  } as Partial<Pipeline>);
  const deliveringRow = rawRow(delivering.id);
  const unresolved = await convert(delivering, {}, h.ports);
  expect(JSON.stringify(unresolved)).toContain("unresolved-delivery");
  expect(rawRow(delivering.id)).toBe(deliveringRow);

  const live = parkedLegacyLane(draft, {}, { state: "running", unconfirmedHosts: [{ stageId: "builder", attempt: 1, conversationId: "c", agentPath: null, paneId: null, operationId: null, detail: "kill unconfirmed", at: "t" }] });
  expect(JSON.stringify(await convert(live, {}, h.ports))).toContain("live-ownership");

  const closed = parkedLegacyLane(draft, {}, { state: "closed", closedAt: "2026-09-02T00:00:00.000Z", cursor: null });
  expect(JSON.stringify(await convert(closed, {}, h.ports))).toContain("pipeline-settled");
});

test("a lane whose review flow rested in needs_decision after its rounds converts; paused and unreadable flows still refuse", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  h.flows.set("flow-old", { id: "flow-old", state: "needs_decision", stateDetail: "round limit reached", roundLimit: 4, rounds: [{ n: 1 }] } as unknown as Flow);
  const lane = parkedLegacyLane(draft, {});
  const flowsBefore = JSON.stringify([...h.flows]);
  const preview = await patchPipeline(lane.id, { action: "preview-legacy-review" } as never, h.ports);
  expect(preview.legacyReviewPreview).toMatchObject({ ok: true, reviewLimit: 4, reviewLimitSource: "flow" });
  expect((await convert(lane, {}, h.ports)).legacyReviewConversion).toMatchObject({ stageId: "reviewer", reviewLimit: 4 });
  expect(attemptsOf("reviewer")[0]).toMatchObject({ flowId: "flow-old", historical: true, legacyReview: true });
  expect(JSON.stringify([...h.flows])).toBe(flowsBefore);
  expect(h.flowCalls).toEqual([]);

  for (const flow of [{ id: "flow-old", state: "paused", pausedState: "relaying", roundLimit: 5, rounds: [] }, null]) {
    if (flow) h.flows.set("flow-old", flow as unknown as Flow);
    else h.flows.delete("flow-old");
    const frozen = parkedLegacyLane(draft, {});
    const before = rawRow(frozen.id);
    expect(JSON.stringify(await convert(frozen, { clientRequestId: "convert-frozen" }, h.ports))).toContain("live-flow");
    expect(rawRow(frozen.id)).toBe(before);
  }
});

test("conversion history refuses at its cap with a 409 instead of failing the store write", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  const full = structuredClone(current());
  const entry = { clientRequestId: "old", expectedRevision: "a".repeat(64), stageId: "reviewer", fixerStageId: "reviewer-fix", implementerStageId: "builder", reviewLimit: 5, reviewLimitSource: "default" as const,
    original: { stages: structuredClone(full.stages), run: { stageId: "reviewer", attempts: [] }, cursor: null }, convertedGraphDigest: "d", actor: { kind: "operator" as const }, at: "t",
    reverted: { clientRequestId: "old-revert", actor: { kind: "operator" as const }, at: "t" } };
  full.legacyReviewConversions = Array.from({ length: legacy.MAX_LEGACY_REVIEW_CONVERSIONS }, (_, index) => ({ ...entry, clientRequestId: `old-${index}`, reverted: { ...entry.reverted, clientRequestId: `old-revert-${index}` } }));
  savePipelines([full]);
  const before = rawRow(draft.id);
  const refused = await convert(draft, {}, h.ports);
  expect(refused.status).toBe(409);
  expect(refused.error).toContain(`${legacy.MAX_LEGACY_REVIEW_CONVERSIONS} legacy review conversions`);
  expect(rawRow(draft.id)).toBe(before);
});

test("an unlimited flow limit is refused with an editable recommendation, then converts at the chosen finite limit", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  h.flows.set("flow-old", { id: "flow-old", state: "closed", roundLimit: 0, rounds: [] } as unknown as Flow);
  const lane = parkedLegacyLane(draft, {});
  const preview = await patchPipeline(lane.id, { action: "preview-legacy-review" } as never, h.ports);
  expect(preview.legacyReviewPreview).toMatchObject({ ok: false, reviewLimit: null, recommendedReviewLimit: 5, refusals: [{ code: "unlimited-limit" }] });
  expect((await convert(lane, {}, h.ports)).status).toBe(409);
  expect((await convert(lane, { clientRequestId: "convert-5", reviewLimit: 5 }, h.ports)).legacyReviewConversion).toMatchObject({ reviewLimit: 5, reviewLimitSource: "request" });
});

test("an unexecuted conversion reverts explicitly; once a new attempt ran it is repaired forward", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  expect((await convert(draft, {}, h.ports)).error).toBeUndefined();
  const revert = (clientRequestId: string) => patchPipeline(draft.id, { action: "revert-legacy-review", clientRequestId, stageId: "reviewer", expectedRevision: pipelineRevision(current()) } as never, h.ports, creator);
  const reverted = await revert("revert-1");
  expect(reverted.error).toBeUndefined();
  expect(current().stages).toEqual(draft.stages);
  expect(current().runs).toEqual(draft.runs);
  /* The original and the reverted conversion both stay in history. */
  expect(current().legacyReviewConversions![0]).toMatchObject({ clientRequestId: "convert-1", reverted: { clientRequestId: "revert-1" } });
  expect((await patchPipeline(draft.id, { action: "revert-legacy-review", clientRequestId: "revert-1", stageId: "reviewer", expectedRevision: reverted.legacyReviewConversion!.expectedRevision } as never, h.ports, creator)).replayed).toBe(true);

  expect((await convert(current(), { clientRequestId: "convert-2" }, h.ports)).error).toBeUndefined();
  await patchPipeline(draft.id, { action: "start" }, h.ports);
  await tickPipelines([], h.ports);
  await h.settle("pass");
  await h.settle("pass");
  await tickPipelines([], h.ports);
  expect(attemptsOf("reviewer").length).toBe(1);
  const refused = await revert("revert-2");
  expect(refused.status).toBe(409);
  expect(refused.error).toContain("repair it forward");
});

test("start refuses a draft whose legacy review-loop no run reaches", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  const orphan = structuredClone(draft);
  orphan.stages[1]!.next = "ship";
  savePipelines([orphan]);
  expect(findPipelineRecord(orphan.id)!.stages[1]!.next).toBe("ship");
  const started = await patchPipeline(orphan.id, { action: "start" }, h.ports);
  expect(started.status).toBe(409);
  expect(started.error).toContain("review-loop stage reviewer is unreachable");
  expect(current().state).toBe("draft");
});

test("MCP pipeline_action previews, converts and replays one conversion", async () => {
  const h = harness();
  const draft = await legacyDraft(h.ports);
  const bindings = viewerMcpBindings(undefined, undefined, {
    readPipelineRecord: (id: string) => findPipelineRecord(id),
    patchPipeline: (id: string, request: never, _ports: unknown, actor: never) => patchPipeline(id, request, h.ports, actor),
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_creator", role: "orchestrator" }),
  } as unknown as ViewerMcpDomainDependencies);
  const service = createMcpToolService(bindings, new FileMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.json")));
  const preview = await service.callTool("pipeline_action", { clientRequestId: "preview-1", pipelineId: draft.id, action: "preview-legacy-review", reviewLimit: 4 });
  expect(preview).toMatchObject({ ok: true, legacyReviewPreview: { ok: true, reviewLimit: 4, reviewerActivations: 4, fixerStageId: "reviewer-fix" } });
  const args = { clientRequestId: "mcp-convert-1", pipelineId: draft.id, action: "convert-legacy-review", reviewLimit: 4, expectedRevision: pipelineRevision(draft) };
  const first = await service.callTool("pipeline_action", args);
  expect(first).toMatchObject({ ok: true, legacyReviewConversion: { clientRequestId: "mcp-convert-1", stageId: "reviewer", reviewLimit: 4 } });
  const replay = await service.callTool("pipeline_action", args);
  expect(replay).toMatchObject({ ok: true, legacyReviewConversion: { clientRequestId: "mcp-convert-1" } });
  expect(current().legacyReviewConversions).toHaveLength(1);
});
