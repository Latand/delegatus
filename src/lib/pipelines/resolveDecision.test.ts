import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

/* Decision continuation drives real settlement and activation. Every port is a mock and the state directory is private to this
   file, so nothing here reaches a host, an account or the operator's registry. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-decision-continuation-"));
const { createPipelineFromRequest, reportStageCompletion, tickPipelines, patchPipeline } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines, pipelineRevision } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;
type StageCompletionRequest = import("./engine").StageCompletionRequest;
type Pipeline = import("./types").Pipeline;

registerPipelineTick(async () => {});
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const HEAD = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
const PULL_REQUEST = '[{"url":"https://forge.example/repo/pull/1730","number":1730,"state":"OPEN"}]';
const agent = (conversationId: string) => ({ kind: "agent", role: "builder", conversationId }) as const;

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

function harness() {
  const messages = new Map<string, { text: string; ts: number }>();
  const spawnedStages: string[] = [];
  const prompts: string[] = [];
  /* What the mocked worktree answers the server's own provenance reads. */
  const worktree = { status: "", knownPaths: "docs/report.html\0", pullRequest: PULL_REQUEST };
  const execCalls: string[] = [];
  /* Runs once, while the server is reading provenance and holds no lease. */
  let duringProvenance: (() => void) | null = null;
  let clock = 1_000_000;
  const ports: PipelinePorts = {
    exec: (command, rawArgs) => {
      execCalls.push([command, ...rawArgs].join(" "));
      if (command === "timeout") {
        const race = duringProvenance;
        duringProvenance = null;
        race?.();
        const bounded = rawArgs.slice(rawArgs.findIndex((argument) => argument === "git" || argument === "gh"));
        if (bounded[0] === "gh") return { code: 0, stdout: worktree.pullRequest, stderr: "" };
        return ports.exec("git", bounded.slice(1), "");
      }
      const args = rawArgs;
      if (args[0] === "status" && args[1] === "--porcelain") return { code: 0, stdout: worktree.status, stderr: "" };
      if (args[0] === "ls-files") return { code: 0, stdout: worktree.knownPaths, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: (roleId) => roleId === "builder"
      ? { engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "Builder guidance" }
      : null,
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    spawnAgent: async (input, onReserved) => {
      spawnedStages.push(input.membership.stageId ?? "");
      prompts.push(input.prompt);
      const n = spawnedStages.length;
      onReserved({ launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, accountId: "account-a" });
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
    createFlow: async () => ({ error: "no review flows in this suite" }),
    patchFlow: () => ({}),
    closeFlow: async () => ({}),
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  /** Ends the turn of the stage spawned `n`th with whatever it left behind. */
  const endTurn = (n: number, text: string) => {
    const pathname = `/codex/stage-${n}.jsonl`;
    messages.set(pathname, { text, ts: clock + 100_000 });
    return entry(pathname);
  };
  const report = (n: number, request: StageCompletionRequest) =>
    reportStageCompletion(request, agent(`conversation_stage_${n}`), ports);
  return {
    ports, worktree, spawnedStages, prompts, endTurn, report, execCalls,
    raceDuringProvenance: (race: () => void) => { duringProvenance = race; },
  };
}

const stage = (id: string, next: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "run", role: { roleId: "builder" }, prompt: `Do ${id}`, next, ...extra });

async function started(ports: PipelinePorts, stages: unknown[]): Promise<string> {
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Graph slice 2", spec: "AC", repoDir: "/repo", stages: stages as never, src: "/codex/creator.jsonl" }, ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn the entry stage
  return created.pipeline.id;
}

const current = () => loadPipelines()[0]!;
const attemptsOf = (stageId: string) => current().runs.find((run) => run.stageId === stageId)!.attempts;

const manager = agent("conversation_creator");
const drainBefore = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
afterEach(() => {
  if (drainBefore === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = drainBefore;
  delete process.env.LLV_PIPELINE_RESOLVE_DECISION;
});

async function parked() {
  const h = harness();
  const id = await started(h.ports, [stage("build", "verify"), stage("verify", null)]);
  await h.report(1, { verdict: "needs_decision", summary: "Which output format should I use?" });
  await tickPipelines([h.endTurn(1, "Awaiting an answer.")], h.ports);
  expect(current().state).toBe("needs_decision");
  const request = {
    action: "resolve-decision" as const, clientRequestId: "answer-format", answer: "Use Markdown.",
    expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(current()),
  };
  return { ...h, id, request };
}

test.each(["0", "1"])("settled question -> fenced answer -> fresh attempt -> final output (drain %s)", async (mode) => {
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = mode;
  const h = await parked();
  const original = structuredClone(attemptsOf("build")[0]);
  // Neither an expired launch receipt nor an absent old host is needed for a fresh attempt.
  h.ports.spawnReceipt = () => null;
  h.ports.stageHostResident = async () => { throw new Error("must not inspect the old host"); };
  h.ports.stopStageAgent = async () => { throw new Error("must not stop the old host"); };
  h.ports.stopStagePane = async () => { throw new Error("must not stop the old pane"); };
  const execCount = h.execCalls.length;
  const result = await patchPipeline(h.id, h.request, h.ports, manager);
  expect(result.error).toBeUndefined();
  expect(result.decisionAnswer).toMatchObject({ stageId: "build", attempt: 1, nextAttempt: 2, question: "Which output format should I use?", answer: "Use Markdown." });
  expect(h.execCalls.length).toBe(execCount);
  expect(h.spawnedStages).toEqual(["build"]);
  expect(attemptsOf("build")[0]).toEqual(original);
  expect(attemptsOf("build")[1]).toMatchObject({ n: 2, state: "pending", decisionAnswerId: "answer-format" });
  // The retired conversation remains terminal even before its replacement launches.
  expect((await h.report(1, { verdict: "pass" })).code).toBe("STAGE_REPORT_SETTLED");
  h.ports.stageHostResident = async () => false;
  // A spawn callback may acquire the pipeline lease in BOTH modes.
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (...args) => {
    const { withPipelineMutation } = await import("./store");
    await withPipelineMutation(() => undefined);
    return spawn(...args);
  };
  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["build", "build"]);
  expect(h.prompts[1]).toContain("Which output format should I use?");
  expect(h.prompts[1]).toContain("Use Markdown.");
  expect(attemptsOf("build")[1]!.conversationId).not.toBe(original!.conversationId);
  const accepted = await h.report(2, { verdict: "pass", summary: "The Markdown report is complete." });
  expect(accepted.error).toBeUndefined();
  await tickPipelines([h.endTurn(2, "Done.")], h.ports);
  expect(current().cursor?.stageId).toBe("verify");
  // Restore the ordinary spawn stub; legacy launches still follow their existing opt-in policy.
  h.ports.spawnAgent = spawn;
  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["build", "build", "verify"]);
  expect(h.prompts[2]).toContain("The Markdown report is complete.");
  expect(h.prompts[2]).not.toContain("Which output format should I use?");
  expect(attemptsOf("build")[0]).toEqual(original);
});

test("identical replay returns its durable answer after restart and rollback without a second attempt", async () => {
  const h = await parked();
  const first = await patchPipeline(h.id, h.request, h.ports, manager);
  savePipelines(loadPipelines());
  process.env.LLV_PIPELINE_RESOLVE_DECISION = "0";
  const replay = await patchPipeline(h.id, h.request, h.ports, manager);
  expect(replay).toMatchObject({ replayed: true, decisionAnswer: first.decisionAnswer });
  expect(current().decisionAnswers).toHaveLength(1);
  expect(attemptsOf("build")).toHaveLength(2);
  expect((await patchPipeline(h.id, { ...h.request, answer: "Use HTML." }, h.ports, manager)).status).toBe(409);
  // Rollback continues draining already admitted work.
  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["build", "build"]);
});

test("concurrent answers admit one winner under the same revision", async () => {
  const h = await parked();
  const replies = await Promise.all([
    patchPipeline(h.id, h.request, h.ports, manager),
    patchPipeline(h.id, { ...h.request, clientRequestId: "other-answer", answer: "Use HTML." }, h.ports, manager),
  ]);
  expect(replies.filter((reply) => reply.pipeline)).toHaveLength(1);
  expect(replies.filter((reply) => reply.status === 409)).toHaveLength(1);
  expect(attemptsOf("build")).toHaveLength(2);
  expect(current().decisionAnswers).toHaveLength(1);
});

test("wrong actor, stage, attempt, revision and missing fences leave the question unchanged", async () => {
  const h = await parked();
  const before = current();
  for (const actor of [null, agent("conversation_stage_1"), { kind: "agent", role: "orchestrator", conversationId: "conversation_other" } as const]) {
    expect((await patchPipeline(h.id, h.request, h.ports, actor)).status).toBe(403);
  }
  for (const patch of [{ expectedStageId: "verify" }, { expectedAttempt: 2 }, { expectedRevision: "0".repeat(64) }]) {
    expect((await patchPipeline(h.id, { ...h.request, ...patch }, h.ports, manager)).status).toBe(409);
  }
  for (const patch of [{ expectedRevision: undefined }, { expectedAttempt: undefined }, { expectedStageId: undefined }, { answer: " " }, { answer: "x".repeat(12_001) }, { clientRequestId: undefined }]) {
    expect((await patchPipeline(h.id, { ...h.request, ...patch }, h.ports, manager)).status).toBe(400);
  }
  expect(current()).toEqual(before);
});

test("disable blocks fresh admission and operational parks are not answerable questions", async () => {
  const h = await parked();
  process.env.LLV_PIPELINE_RESOLVE_DECISION = "0";
  expect((await patchPipeline(h.id, h.request, h.ports, manager)).status).toBe(409);
  delete process.env.LLV_PIPELINE_RESOLVE_DECISION;
  const pipeline = current();
  pipeline.runs[0]!.attempts[0]!.verdict = null;
  savePipelines([pipeline]);
  expect((await patchPipeline(h.id, { ...h.request, expectedRevision: pipelineRevision(current()) }, h.ports, manager)).status).toBe(409);
  expect(current().decisionAnswers).toBeUndefined();
});


test("a second question appends another answer and retains the original input and both settled attempts", async () => {
  const h = await parked();
  const pipeline = current();
  pipeline.runs[0]!.attempts[0]!.input = "The report must cover all three scenarios.";
  savePipelines([pipeline]);
  const firstRequest = { ...h.request, expectedRevision: pipelineRevision(current()) };
  expect((await patchPipeline(h.id, firstRequest, h.ports, { kind: "operator" })).error).toBeUndefined();
  await tickPipelines([], h.ports);
  await h.report(2, { verdict: "needs_decision", summary: "Include the appendix?" });
  await tickPipelines([h.endTurn(2, "Awaiting the appendix decision.")], h.ports);
  const history = structuredClone(attemptsOf("build"));
  const second = { ...h.request, clientRequestId: "answer-appendix", answer: "Include it.", expectedAttempt: 2, expectedRevision: pipelineRevision(current()) };
  expect((await patchPipeline(h.id, second, h.ports, manager)).error).toBeUndefined();
  expect(current().decisionAnswers).toHaveLength(2);
  expect(attemptsOf("build").slice(0, 2)).toEqual(history);
  await tickPipelines([], h.ports);
  expect(h.prompts[2]).toContain("The report must cover all three scenarios.");
  expect(h.prompts[2]).toContain("Use Markdown.");
  expect(h.prompts[2]).toContain("Include the appendix?");
  expect(h.prompts[2]).toContain("Include it.");
});
