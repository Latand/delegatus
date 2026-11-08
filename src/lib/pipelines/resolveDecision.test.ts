import { afterAll, afterEach, expect, spyOn, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

/* Decision continuation drives real settlement and activation. Every port is a mock and the state directory is private to this
   file, so nothing here reaches a host, an account or the operator's registry. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-decision-continuation-"));
const { createPipelineFromRequest, reportStageCompletion, tickPipelines, patchPipeline } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines, pipelineRevision, pipelineDecisionRevision } = await import("./store");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const { createMcpToolService, FileMcpReceiptStore } = await import("@/lib/mcp/server");
type McpReceiptStore = import("@/lib/mcp/server").McpReceiptStore;
type ViewerMcpDomainDependencies = import("@/lib/mcp/bindings").ViewerMcpDomainDependencies;
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
    exec: async (command, rawArgs) => {
      execCalls.push([command, ...rawArgs].join(" "));
      if (command === "timeout") {
        const race = duringProvenance;
        duringProvenance = null;
        race?.();
        const bounded = rawArgs.slice(rawArgs.findIndex((argument) => argument === "git" || argument === "gh"));
        if (bounded[0] === "gh") return { code: 0, stdout: worktree.pullRequest, stderr: "" };
        return (await ports.exec("git", bounded.slice(1), ""));
      }
      const args = rawArgs;
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "https://forge.example/repo.git\n", stderr: "" };
      if (args.length === 1 && args[0] === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "-c" && args[2] === "remote" && args[3] === "-v") {
        const probe = /^remote\.([^=]+)\.url=(.*)$/.exec(args[1]!);
        if (probe) return { code: 0, stdout: `${probe[1]}\t${probe[2]} (fetch)\n${probe[1]}\t${probe[2]} (push)\n`, stderr: "" };
      }
      if (args[0] === "ls-remote") return { code: 0, stdout: `${HEAD}\trefs/heads/${loadPipelines()[0]?.branch}\n`, stderr: "" };
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
      input.assertCurrent?.();
      spawnedStages.push(input.membership.stageId ?? "");
      prompts.push(input.prompt);
      const n = spawnedStages.length;
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
    durableTurnEvidence: async (_engine, pathname) => {
      const message = messages.get(pathname);
      return message ? { turn: "terminal", message, lastRecordAt: message.ts } : null;
    },
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
  const created = await createPipelineFromRequest({ task: "Graph slice 2", publication: "internal", spec: "AC", repoDir: "/repo", stages: stages as never, src: "/codex/creator.jsonl" }, ports);
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
  expect(h.spawnedStages, current().runs[0]?.attempts.at(-1)?.error ?? current().stateDetail ?? "stage dispatch").toEqual(["build", "build"]);
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
  expect(h.spawnedStages, current().runs[0]?.attempts.at(-1)?.error ?? current().stateDetail ?? "stage dispatch").toEqual(["build", "build"]);
});

/** Leave a real file receipt claimed at either crash boundary, then reopen it. */
async function interruptedAnswer(boundary: "before-admission" | "after-answer", patch = {}) {
  const h = await parked();
  h.request.expectedRevision = pipelineDecisionRevision(current())!;
  const args = { ...h.request, ...patch, pipelineId: h.id };
  const filename = path.join(process.env.LLV_STATE_DIR!, `receipts-${h.id}.json`);
  const receipts = new FileMcpReceiptStore(filename);
  let admissions = 0;
  const bindingsFor = (conversationId = manager.conversationId) => {
    const dependencies: Partial<ViewerMcpDomainDependencies> = {
      readPipelineRecord: () => current(),
      patchPipeline: async (id, request, _ports, actor, assertAuthority, workspaceMemberId) => {
        admissions += 1;
        return patchPipeline(id, request, h.ports, actor, assertAuthority, workspaceMemberId);
      },
      callerAttribution: () => ({ kind: "manager", conversationId, role: "orchestrator" }),
    };
    return viewerMcpBindings(undefined, undefined, dependencies as ViewerMcpDomainDependencies);
  };
  const stoppedReceipts: McpReceiptStore = {
    claim: async (...input) => {
      const claimed = await receipts.claim(...input);
      if (boundary === "before-admission") throw new Error("simulated process exit after claim");
      return claimed;
    },
    complete: async () => { throw new Error("simulated process exit before response persistence"); },
  };
  await expect(createMcpToolService(bindingsFor(), stoppedReceipts).callTool("pipeline_action", args))
    .rejects.toThrow("simulated process exit");
  expect(admissions).toBe(boundary === "before-admission" ? 0 : 1);
  expect(current().decisionAnswers?.length ?? 0).toBe(boundary === "before-admission" ? 0 : 1);
  return {
    ...h, args,
    receiptContents: () => fs.readFileSync(filename, "utf8"),
    reopen: (conversationId?: string) => createMcpToolService(bindingsFor(conversationId), new FileMcpReceiptStore(filename)),
  };
}

test.each(["before-admission", "after-answer"] as const)("MCP restart %s recovers one durable answer and continuation", async (boundary) => {
  const h = await interruptedAnswer(boundary);
  const original = structuredClone(attemptsOf("build")[0]);
  const service = h.reopen();
  // Digest conflicts must not consume or replace the interrupted original request.
  for (const patch of [{ answer: "Use HTML." }, { expectedStageId: "verify" }, { expectedAttempt: 2 }, { expectedRevision: "0".repeat(64) }]) {
    expect(await service.callTool("pipeline_action", { ...h.args, ...patch }))
      .toMatchObject({ ok: false, code: "idempotency_conflict" });
  }
  const answer = await service.callTool("pipeline_action", h.args);
  expect(answer).toMatchObject({ ok: true, decisionAnswer: { clientRequestId: h.request.clientRequestId, stageId: "build", attempt: 1, nextAttempt: 2 } });
  expect(current().decisionAnswers).toHaveLength(1);
  expect(current().decisionAnswers![0]).toMatchObject({ answer: h.request.answer, actor: { kind: "agent", conversationId: manager.conversationId } });
  expect(attemptsOf("build")).toHaveLength(2);
  expect(attemptsOf("build")[0]).toEqual(original);
  expect(h.spawnedStages).toEqual(["build"]);
  expect(await h.reopen().callTool("pipeline_action", h.args)).toEqual({ ...answer, replayed: true });
  await tickPipelines([], h.ports);
  expect(h.spawnedStages, current().runs[0]?.attempts.at(-1)?.error ?? current().stateDetail ?? "stage dispatch").toEqual(["build", "build"]);
  expect(h.prompts[1]).toContain(h.request.answer);
  expect(await h.reopen().callTool("pipeline_action", h.args)).toEqual({ ...answer, replayed: true });
  expect(current().decisionAnswers).toHaveLength(1);
  expect(attemptsOf("build")).toHaveLength(2);
});

test.each(["before-admission", "after-answer"] as const)("MCP restart %s rechecks the server-attributed actor", async (boundary) => {
  const h = await interruptedAnswer(boundary);
  const before = current();
  const receiptBefore = h.receiptContents();
  const result = await h.reopen("conversation_other").callTool("pipeline_action", h.args);
  expect(result).toMatchObject({ ok: false });
  expect(result.error).toContain("only the pipeline creator conversation");
  expect(current()).toEqual(before);
  expect(h.receiptContents()).toBe(receiptBefore);
  const recovered = await h.reopen().callTool("pipeline_action", h.args);
  expect(recovered).toMatchObject({ ok: true });
  expect(await h.reopen().callTool("pipeline_action", h.args)).toEqual({ ...recovered, replayed: true });
  expect(current().decisionAnswers).toHaveLength(1);
  expect(attemptsOf("build")).toHaveLength(2);
  await tickPipelines([], h.ports);
  expect(h.spawnedStages, current().runs[0]?.attempts.at(-1)?.error ?? current().stateDetail ?? "stage dispatch").toEqual(["build", "build"]);
});

test("MCP completed replay refuses another actor without replacing the creator receipt", async () => {
  const h = await interruptedAnswer("after-answer");
  const completed = await h.reopen().callTool("pipeline_action", h.args);
  expect(completed).toMatchObject({ ok: true });
  const before = current();
  const receiptBefore = h.receiptContents();
  const refused = await h.reopen("conversation_other").callTool("pipeline_action", h.args);
  expect(refused).toMatchObject({ ok: false });
  expect(refused.error).toContain("only the pipeline creator conversation");
  expect(current()).toEqual(before);
  expect(h.receiptContents()).toBe(receiptBefore);
  expect(await h.reopen().callTool("pipeline_action", h.args)).toEqual({ ...completed, replayed: true });
  expect(current().decisionAnswers).toHaveLength(1);
  expect(attemptsOf("build")).toHaveLength(2);
  // Changing creator lineage cannot transfer the original caller's receipt.
  const changedOwner = current();
  changedOwner.srcConversationId = "conversation_other";
  savePipelines([changedOwner]);
  const newOwnerReplay = await h.reopen("conversation_other").callTool("pipeline_action", h.args);
  expect(newOwnerReplay).toMatchObject({ ok: false });
  expect(newOwnerReplay.error).toContain("different decision answer");
  expect(h.receiptContents()).toBe(receiptBefore);
});

test.each([
  { expectedStageId: "verify" }, { expectedAttempt: 2 }, { expectedRevision: "0".repeat(64) },
])("MCP restart before admission retains the pipeline fence %j", async (patch) => {
  const h = await interruptedAnswer("before-admission", patch);
  const before = current();
  const result = await h.reopen().callTool("pipeline_action", h.args);
  expect(result).toMatchObject({ ok: false, code: "tool_failed" });
  expect(current()).toEqual(before);
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

test("a rotated seat's successor preserves the answer and resumes its predecessor's parked lane", async () => {
  const h = await parked();
  const original = structuredClone(attemptsOf("build")[0]);
  const project = current().project;
  const now = "2026-10-02T14:28:00.000Z";
  try {
    for (const conversationId of ["conversation_creator", "conversation_successor"]) {
      const clientRequestId = `rotate-${conversationId}`;
      expect(beginOrchestratorSeatIntent({ project, clientRequestId, mode: "spawn", mandate: "Run the project", now }).kind).toBe("begun");
      expect(completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null, now }).kind).toBe("activated");
    }
    expect((await patchPipeline(h.id, h.request, h.ports, manager)).status).toBe(403);
    const answered = await patchPipeline(h.id, h.request, h.ports, agent("conversation_successor"));
    expect(answered.error).toBeUndefined();
    expect(answered.decisionAnswer?.actor).toEqual(agent("conversation_successor"));
    expect(attemptsOf("build")[0]).toEqual(original);
    expect(attemptsOf("build")).toHaveLength(2);
    await tickPipelines([], h.ports);
    expect(h.prompts[1]).toContain(h.request.answer);
    expect(current().decisionAnswers).toHaveLength(1);
    expect((await patchPipeline(h.id, h.request, h.ports, agent("conversation_successor"))).replayed).toBe(true);
  } finally {
    fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json"), { force: true });
  }
});

test("short decision revisions are stored whole, stale reads refuse and full-form replays work", async () => {
  const h = await parked();
  const full = h.request.expectedRevision;
  expect(await patchPipeline(h.id, { ...h.request, expectedRevision: "ffffffff" }, h.ports, manager)).toMatchObject({ code: "STAGE_CHANGED" });
  const accepted = await patchPipeline(h.id, { ...h.request, expectedRevision: full.slice(0, 8).toUpperCase() }, h.ports, manager);
  expect(accepted.error).toBeUndefined(); expect(accepted.decisionAnswer!.expectedRevision).toBe(full);
  expect((await patchPipeline(h.id, h.request, h.ports, manager)).replayed).toBe(true);
});


for (const mode of ["member", "owner", "revoked-before-persist", "store-lost-before-patch"] as const) test(`human decision on an installation pipeline carries durable workspace authority: ${mode}`, async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/pipelines/[id]/route");
  const { teamStore, resetTeamStoreForTests, teamStoreFile } = await import("@/lib/team/store");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { mintSession } = await import("@/lib/team/sessions");
  const { AgentRegistry, agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const previousRegistry = agentRegistry();
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-decision-"));
  process.env.LLV_STATE_DIR = state; resetTeamStoreForTests();
  const registry = new AgentRegistry(path.join(state, "registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const h = await parked();
    const store = teamStore(), at = "2026-10-20T09:00:00.000Z", workspaceId = `w_${"d".repeat(32)}`;
    const owner = { id: "m_owner", name: "Owner", role: "owner" as const, status: "active" as const, color: "teal" as const,
      telegram: null, createdAt: at, createdBy: "claim", revokedAt: null };
    const member = { ...owner, id: "m_member", name: "Member", role: "member" as const };
    store.insertMember(owner); store.insertMember(member);
    createWorkspace(store, owner, { id: workspaceId, name: "Workspace", projects: ["viewer"] });
    store.putWorkspaceMember(workspaceId, member.id, "member", owner.id, at);
    expect(current().workspace).toBeUndefined();
    const human = mode === "owner" ? owner : member;
    if (mode === "revoked-before-persist") {
      const now = h.ports.now;
      h.ports.now = () => { store.removeWorkspaceMember(workspaceId, member.id); return now(); };
      await expect(patchPipeline(h.id, h.request, h.ports, { kind: "operator" }, undefined, member.id)).rejects.toThrow("workspace access denied");
      expect(current().workspace).toBeUndefined();
      expect(current().decisionAnswers ?? []).toEqual([]);
      expect(attemptsOf("build")).toHaveLength(1);
      return;
    }
    const cookie = mintSession(store, human.id, "claim", { surface: "desktop", browser: "chrome" }).value;
    const request = new NextRequest(`http://localhost/api/pipelines/${h.id}`, { method: "PATCH",
      headers: { host: "localhost", "content-type": "application/json", cookie: `llv_member=${cookie}` }, body: JSON.stringify(h.request),
    });
    if (mode === "store-lost-before-patch") {
      const read = request.json.bind(request);
      request.json = async () => {
        const value = await read(); resetTeamStoreForTests();
        fs.renameSync(teamStoreFile(), path.join(state, "saved-team.sqlite"));
        return value;
      };
    }
    const response = await PATCH(request, { params: Promise.resolve({ id: h.id }) });
    const answer = await response.json();
    if (mode === "store-lost-before-patch") {
      expect(response.status).toBe(503); expect(answer.code).toBe("team_store_unavailable");
      expect(current().workspace).toBeUndefined(); expect(current().decisionAnswers ?? []).toEqual([]);
      expect(attemptsOf("build")).toHaveLength(1);
      return;
    }
    expect(response.status).toBe(200);
    expect(answer.ok).toBe(true);
    const expected = mode === "owner" ? undefined : { memberId: member.id, workspaceId };
    expect(current().workspace).toEqual(expected);
    const child = (await import("node:child_process")).spawnSync(process.execPath, ["-e",
      `import { findPipelineRecord } from ${JSON.stringify(path.resolve("src/lib/pipelines/store.ts"))}; console.log(JSON.stringify(findPipelineRecord(${JSON.stringify(h.id)}).workspace ?? null));`],
      { env: process.env, encoding: "utf8" });
    expect(child.status).toBe(0); expect(JSON.parse(child.stdout.trim())).toEqual(expected ?? null);
    const workspaces: unknown[] = [];
    const spawn = h.ports.spawnAgent;
    h.ports.spawnAgent = async (...args) => { workspaces.push(args[0].workspace); return spawn(...args); };
    await tickPipelines([], h.ports);
    expect(workspaces).toEqual([expected]);
    expect(attemptsOf("build")[1]?.decisionAnswerId).toBe(h.request.clientRequestId);
    if (mode === "member") {
      store.removeWorkspaceMember(workspaceId, member.id);
      await expect(patchPipeline(h.id, h.request, h.ports, { kind: "operator" }, undefined, member.id))
        .rejects.toThrow("workspace access denied");
    }
  } finally {
    setAgentRegistryForTests(previousRegistry); registry.close();
    resetTeamStoreForTests(); process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

/** Production bindings and receipts consume the same original snapshot. */
function decisionService(h: Awaited<ReturnType<typeof parked>>, receipts: McpReceiptStore, caller = () => manager.conversationId, patch?: ViewerMcpDomainDependencies["patchPipeline"]) {
  const dependencies: Partial<ViewerMcpDomainDependencies> = {
    readPipelineRecord: id => current().id === id ? current() : null,
    patchPipeline: patch ?? ((id, request, _ports, actor, authority, member) => patchPipeline(id, request, h.ports, actor, authority, member)),
    callerAttribution: () => ({ kind: "manager", conversationId: caller(), role: "orchestrator" }),
  };
  return { bindings: viewerMcpBindings(undefined, undefined, dependencies as ViewerMcpDomainDependencies),
    service: createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies as ViewerMcpDomainDependencies), receipts) };
}

test("decision token agrees across production read projections and reaches a fresh consumer after reap progress", async () => {
  const fixture = harness(); let earlierResident = true;
  fixture.ports.stageHostResident = async target => target.conversationId === "conversation_stage_1" && earlierResident;
  fixture.ports.conversationAgentActive = async id => id === "conversation_stage_1" ? earlierResident : false;
  const id = await started(fixture.ports, [stage("prepare", "build"), stage("build", "verify"), stage("verify", null)]);
  expect((await fixture.report(1, { verdict: "pass", summary: "Prepared." })).error).toBeUndefined();
  await tickPipelines([fixture.endTurn(1, "Prepared.")], fixture.ports);
  await tickPipelines([], fixture.ports);
  expect((await fixture.report(2, { verdict: "needs_decision", summary: "Choose a format?" })).error).toBeUndefined();
  await tickPipelines([fixture.endTurn(2, "Awaiting format.")], fixture.ports);
  const h = { ...fixture, id, request: { action: "resolve-decision" as const, clientRequestId: "answer-format", answer: "Use Markdown.",
    expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(current()) } };
  const token = pipelineDecisionRevision(current())!;
  const receipts = new FileMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "token-positive.json"));
  const { service } = decisionService(h, receipts);
  for (const projection of [{}, { stageId: "build" }, { full: true }] as Array<{stageId?: string; full?: boolean}>) {
    expect((await service.callTool("get_pipeline", { pipelineId: h.id, ...projection })).decisionRevision).toBe(projection.full ? token : token.slice(0, 8));
  }
  expect((await service.callTool("get_pipeline", { pipelineId: h.id, stageId: "verify" })).decisionRevision).toBeUndefined();
  const before = pipelineRevision(current());
  // The earlier host, retained throughout the question, now really settles.
  expect(current().terminalReap?.settledAttempts ?? []).not.toContain("prepare:1");
  earlierResident = false;
  await tickPipelines([], h.ports);
  expect(current().terminalReap?.settledAttempts).toContain("prepare:1");
  expect(pipelineRevision(current())).not.toBe(before);
  expect(pipelineDecisionRevision(current())).toBe(token);
  const args = { ...h.request, pipelineId: h.id, expectedRevision: token.slice(0, 8).toUpperCase() };
  expect(await service.callTool("pipeline_action", args)).toMatchObject({ ok: true, replayed: false });
  expect(current().decisionAnswers?.[0]?.expectedRevision).toBe(token);
  await tickPipelines([], h.ports);
  expect(h.spawnedStages, current().stateDetail ?? "stage dispatch").toEqual(["prepare", "build", "build"]);
  expect(h.prompts[2]).toContain("Use Markdown.");
  expect(await service.callTool("pipeline_action", { ...args, expectedRevision: token })).toMatchObject({ ok: true, replayed: true });
  expect(current().decisionAnswers).toHaveLength(1);
  expect(attemptsOf("build")).toHaveLength(2);
  expect((await h.report(3, { verdict: "needs_decision", summary: "Choose the export format?" })).error).toBeUndefined();
  await tickPipelines([h.endTurn(3, "Awaiting export format.")], h.ports);
  const nextToken = pipelineDecisionRevision(current())!;
  expect(nextToken).not.toBe(token);
  expect((await service.callTool("get_pipeline", { pipelineId: h.id, stageId: "build", attempt: 1 })).decisionRevision).toBeUndefined();
  expect((await service.callTool("get_pipeline", { pipelineId: h.id, stageId: "build", attempt: 2 })).decisionRevision).toBe(nextToken.slice(0, 8));
  expect(await service.callTool("pipeline_action", { ...args, expectedRevision: token })).toMatchObject({ ok: true, replayed: true });
  expect(current().decisionAnswers).toHaveLength(1);
  expect(h.spawnedStages).toEqual(["prepare", "build", "build"]);
});

const relevantDecisionChanges: Array<[string, (pipeline: Pipeline) => void]> = [
  ["question", p => { p.runs[0]!.attempts[0]!.output = "Choose another format."; }],
  ["report", p => { p.runs[0]!.attempts[0]!.report!.summary = "Changed report"; }],
  ["verdict", p => { p.runs[0]!.attempts[0]!.verdict!.status = "fail"; }],
  ["definition", p => { p.stages[0]!.prompt += " changed"; }],
  ["requirements", p => { p.spec += " changed"; }],
  ["input", p => { p.runs[0]!.attempts[0]!.input = "Changed input"; }],
  ["producer", p => { p.runs[0]!.attempts[0]!.conversationId = "conversation_replacement"; }],
  ["budget", p => { p.runs[0]!.attempts[0]!.providerFallbackRetries = 1; }],
  ["control", p => { p.controlGeneration = "changed-control"; }],
  ["owner", p => { p.srcConversationId = "conversation_replacement"; }],
  ["workspace", p => { p.workspace = { memberId: "member-replacement", workspaceId: "workspace-replacement" }; }],
  ["delivery-owner", p => { p.delivery!.active = false; p.delivery!.ownerId = "replacement-lane"; }],
  ["delivery-epoch", p => { p.delivery!.epoch++; }],
  ["delivery-target", p => { p.delivery!.target.branch += "-replacement"; }],
  ["delivery-permission", p => { p.delivery!.active = false; p.delivery!.publish = "disabled"; }],
  ["delivery-active", p => { p.delivery!.active = false; }],
  ["attempt", p => { p.runs[0]!.attempts.push({ ...structuredClone(p.runs[0]!.attempts[0]!), n: 2 }); }],
];
for (const [name, change] of relevantDecisionChanges) test(`decision token refuses changed ${name} without modifying its replacement`, async () => {
  const h = await parked(), token = pipelineDecisionRevision(current())!;
  const records = loadPipelines(); change(records[0]!); savePipelines(records);
  expect(pipelineDecisionRevision(current())).not.toBe(token);
  const replacement = JSON.stringify(current());
  const refused = await patchPipeline(h.id, { ...h.request, expectedRevision: token }, h.ports, manager);
  expect(refused.pipeline).toBeUndefined();
  expect(JSON.stringify(current())).toBe(replacement);
  expect(h.spawnedStages).toEqual(["build"]);
});

test("decision projection keeps canonical object keys, array order, null leaves and exact text", async () => {
  await parked();
  const p = current(), token = pipelineDecisionRevision(p);
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  expect(pipelineDecisionRevision(reorder(p) as Pipeline)).toBe(token);
  const absent = structuredClone(p); absent.spec = undefined;
  const explicitNull = structuredClone(absent); Object.assign(explicitNull, { spec: null });
  expect(pipelineDecisionRevision(absent)).toBe(pipelineDecisionRevision(explicitNull));
  const changed = structuredClone(p); changed.runs[0]!.attempts[0]!.output += " ";
  expect(pipelineDecisionRevision(changed)).not.toBe(token);
});

test.each(["scope", "claim", "complete"])("production receipt %s rejects caller replacement without another answer", async boundary => {
  const h = await parked(), token = pipelineDecisionRevision(current())!;
  let caller = manager.conversationId;
  const store = new FileMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, `receipt-race-${boundary}.json`));
  const receipts: McpReceiptStore = {
    claim: async (...args) => { const result = await store.claim(...args); if (boundary === "claim") caller = "conversation_foreign"; return result; },
    complete: async (...args) => { await store.complete(...args); if (boundary === "complete") caller = "conversation_foreign"; },
  };
  const { bindings } = decisionService(h, receipts, () => caller);
  if (boundary === "scope") bindings.pipeline_action.receiptScope = async () => { caller = "conversation_foreign"; return null; };
  const result = await createMcpToolService(bindings, receipts).callTool("pipeline_action", { ...h.request, pipelineId: h.id, expectedRevision: token });
  expect(result.ok).toBe(false);
  expect(result.decisionAnswer).toBeUndefined();
  expect(current().decisionAnswers?.length ?? 0).toBe(boundary === "complete" ? 1 : 0);
  expect(attemptsOf("build")).toHaveLength(boundary === "complete" ? 2 : 1);
  expect(h.spawnedStages).toEqual(["build"]);
});


test.each(["allowed", "new-attempt", "writer"])("decision persistence checks current authority at %s", async boundary => {
  const h = await parked(), token = pipelineDecisionRevision(current())!;
  const { Database } = await import("bun:sqlite");
  const { stateLockWaitsInFlight } = await import("@/lib/state/lockWait");
  let owned = true, writer: InstanceType<typeof Database> | undefined, armed = true;
  const now = h.ports.now;
  h.ports.now = () => {
    if (armed) {
      armed = false;
      if (boundary === "new-attempt") queueMicrotask(() => { owned = false; });
      if (boundary === "writer") { writer = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite")); writer.exec("BEGIN IMMEDIATE"); }
    }
    return now();
  };
  const operation = patchPipeline(h.id, { ...h.request, expectedRevision: token }, h.ports, manager, () => { if (!owned) throw new Error("decision invocation revoked"); });
  // Attach the rejection handler before yielding to the injected newAttempt cut.
  const result = operation.then(value => value, error => error as Error);
  try {
    if (boundary === "writer") {
      const deadline = performance.now() + 2000;
      while (!stateLockWaitsInFlight().some(wait => wait.callSite === "state.transaction.pipelines") && performance.now() < deadline) await Bun.sleep(1);
      expect(stateLockWaitsInFlight().some(wait => wait.callSite === "state.transaction.pipelines")).toBe(true);
      owned = false; writer!.exec("ROLLBACK"); writer!.close(); writer = undefined;
    }
    const settled = await result;
    expect(current().decisionAnswers?.length ?? 0).toBe(boundary === "allowed" ? 1 : 0);
    expect(attemptsOf("build")).toHaveLength(boundary === "allowed" ? 2 : 1);
    if (boundary === "allowed") expect(settled).toMatchObject({ decisionAnswer: { nextAttempt: 2 } });
    else expect(settled).toBeInstanceOf(Error);
  } finally { if (writer) { writer.exec("ROLLBACK"); writer.close(); } await result; }
});

test("production canonicalizer refuses ambiguous decision prefixes and keeps distinct full hashes", async () => {
  const h = await parked();
  const revisions = await import("./decisionRevision");
  const store = await import("./store");
  const left = "abcdef12" + "1".repeat(56), right = "abcdef12" + "2".repeat(56);
  const decision = spyOn(revisions, "pipelineDecisionRevision").mockReturnValue(left);
  const legacy = spyOn(store, "pipelineRevision").mockReturnValue(right);
  try {
    const { bindings } = decisionService(h, new FileMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "ambiguous.json")));
    const canonicalize = bindings.pipeline_action.canonicalizeReceiptArgs!;
    const args = { ...h.request, pipelineId: h.id, expectedRevision: "abcdef12" };
    expect(() => canonicalize(args)).toThrow("ambiguous");
    expect(canonicalize({ ...args, expectedRevision: left }).expectedRevision).toBe(left);
    expect(canonicalize({ ...args, expectedRevision: right }).expectedRevision).toBe(right);
    expect(await patchPipeline(h.id, { ...h.request, expectedRevision: "abcdef12" }, h.ports, manager))
      .toMatchObject({ code: "short_id_ambiguous", field: "expectedRevision" });
  } finally { decision.mockRestore(); legacy.mockRestore(); }
});

test("HTTP detail and answer use the same decision identity and reject a lost operator session", async () => {
  const { NextRequest } = await import("next/server");
  const { GET, PATCH } = await import("@/app/api/pipelines/[id]/route");
  const { soloBrowserSession } = await import("@/lib/agent/operatorSession");
  const h = await parked(), token = pipelineDecisionRevision(current())!;
  const headers = { host: "localhost", cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json" };
  const read = await GET(new NextRequest(`http://localhost/api/pipelines/${h.id}`, { headers }), { params: Promise.resolve({ id: h.id }) });
  expect((await read.json()).decisionRevision).toBe(token);
  const request = new NextRequest(`http://localhost/api/pipelines/${h.id}`, { method: "PATCH", headers,
    body: JSON.stringify({ ...h.request, expectedRevision: token }) });
  const before = JSON.stringify(current());
  const body = request.json.bind(request);
  request.json = async () => { const value = await body(); request.cookies.delete("llv_operator"); return value; };
  expect((await PATCH(request, { params: Promise.resolve({ id: h.id }) })).status).toBe(403);
  expect(JSON.stringify(current())).toBe(before);
});


test("earlier host settlement preserves the HTTP decision token and launches one fresh consumer", async () => {
  const { NextRequest } = await import("next/server");
  const { GET, PATCH } = await import("@/app/api/pipelines/[id]/route");
  const { soloBrowserSession } = await import("@/lib/agent/operatorSession");
  const h = harness(); let earlierResident = true;
  h.ports.stageHostResident = async target => target.conversationId === "conversation_stage_1" && earlierResident;
  h.ports.conversationAgentActive = async id => id === "conversation_stage_1" ? earlierResident : false;
  const id = await started(h.ports, [stage("prepare", "build"), stage("build", "verify"), stage("verify", null)]);
  expect((await h.report(1, { verdict: "pass", summary: "Prepared." })).error).toBeUndefined();
  await tickPipelines([h.endTurn(1, "Prepared.")], h.ports);
  await tickPipelines([], h.ports);
  expect((await h.report(2, { verdict: "needs_decision", summary: "Choose a format?" })).error).toBeUndefined();
  await tickPipelines([h.endTurn(2, "Awaiting format.")], h.ports);
  expect(current().state).toBe("needs_decision");
  const token = pipelineDecisionRevision(current())!, full = pipelineRevision(current());
  expect(current().terminalReap?.settledAttempts ?? []).not.toContain("prepare:1");
  earlierResident = false;
  await tickPipelines([], h.ports);
  expect(current().terminalReap?.settledAttempts).toContain("prepare:1");
  expect(pipelineRevision(current())).not.toBe(full);
  expect(pipelineDecisionRevision(current())).toBe(token);
  const headers = { host: "localhost", cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json" };
  const read = await GET(new NextRequest(`http://localhost/api/pipelines/${id}`, { headers }), { params: Promise.resolve({ id }) });
  expect((await read.json()).decisionRevision).toBe(token);
  const response = await PATCH(new NextRequest(`http://localhost/api/pipelines/${id}`, { method: "PATCH", headers,
    body: JSON.stringify({ action: "resolve-decision", clientRequestId: "http-format", answer: "Use Markdown.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: token }) }), { params: Promise.resolve({ id }) });
  expect(response.status, JSON.stringify(await response.json())).toBe(200);
  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["prepare", "build", "build"]);
  expect(h.prompts[2]).toContain("Use Markdown.");
  expect(current().decisionAnswers).toHaveLength(1);
});

const decisionLaunchChanges: typeof relevantDecisionChanges = [
  ...relevantDecisionChanges.filter(([name]) => ["requirements", "control", "owner", "workspace"].includes(name)),
  ["successor input", p => { p.runs[0]!.attempts.at(-1)!.input += " Changed input."; }],
  ["successor role", p => { p.runs[0]!.attempts.at(-1)!.effectiveRole.promptScaffold += " Changed role."; }],
  ["successor definition", p => { p.runs[0]!.attempts.at(-1)!.definition!.prompt += " Changed instruction."; }],
  ["successor answer", p => { p.runs[0]!.attempts.at(-1)!.decisionAnswerId = "replacement-answer"; }],
];
for (const [name, change] of decisionLaunchChanges) {
  test(`decision successor refuses authority replacement at dispatch: ${name}`, async () => {
    const h = await parked();
    expect((await patchPipeline(h.id, { ...h.request, expectedRevision: pipelineDecisionRevision(current())! }, h.ports, manager)).error).toBeUndefined();
    const spawn = h.ports.spawnAgent;
    let reached = false, replacement = "";
    h.ports.spawnAgent = async (...args) => {
      reached = true;
      const rows = loadPipelines(); change(rows[0]!); savePipelines(rows); replacement = JSON.stringify(current());
      return spawn(...args);
    };
    await tickPipelines([], h.ports);
    expect(reached).toBe(true);
    expect(h.spawnedStages).toEqual(["build"]);
    expect(current().decisionAnswers).toHaveLength(1);
    expect(JSON.stringify(current())).toBe(replacement);
  });
}


for (const boundary of ["claim", "complete", "join"] as const) test(`receipt ${boundary} checks authority inside its final storage boundary`, async () => {
  const h = await parked(), token = pipelineDecisionRevision(current())!;
  let caller = manager.conversationId;
  const filename = path.join(process.env.LLV_STATE_DIR!, `receipt-final-${boundary}.json`);
  const durable = new FileMcpReceiptStore(filename);
  let enter!: () => void, resume!: () => void, joined!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  const joining = new Promise<void>(resolve => { joined = resolve; });
  let scopes = 0;
  const receipts: McpReceiptStore = {
    claim: async (...args) => { if (boundary === "claim") { enter(); await held; } return durable.claim(...args); },
    complete: async (...args) => { if (boundary !== "claim") { enter(); await held; } return durable.complete(...args); },
  };
  const { bindings } = decisionService(h, receipts, () => caller);
  bindings.pipeline_action.receiptScope = async () => { if (++scopes === 2) joined(); return null; };
  const service = createMcpToolService(bindings, receipts);
  const args = { ...h.request, pipelineId: h.id, expectedRevision: token };
  const first = service.callTool("pipeline_action", args);
  await entered;
  const before = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null;
  const second = boundary === "join" ? service.callTool("pipeline_action", args) : null;
  if (second) { await joining; await new Promise<void>(resolve => setImmediate(resolve)); }
  caller = "conversation_foreign"; resume();
  expect((await first).ok).toBe(false);
  if (second) expect((await second).ok).toBe(false);
  expect(fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null).toBe(before);
  expect(current().decisionAnswers?.length ?? 0).toBe(boundary === "claim" ? 0 : 1);
  expect(h.spawnedStages).toEqual(["build"]);
});


test("receipt cleanup rechecks authority before deleting an unadmitted claim", async () => {
  const h = await parked(); let caller = manager.conversationId;
  const filename = path.join(process.env.LLV_STATE_DIR!, "receipt-release.json");
  const durable = new FileMcpReceiptStore(filename);
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { resume = resolve; });
  const receipts: McpReceiptStore = {
    claim: (...args) => durable.claim(...args), complete: (...args) => durable.complete(...args),
    release: async (...args) => { enter(); await held; return durable.release(...args); },
  };
  const { StoreBusyBeforeAdmissionError } = await import("@/lib/state/fileTransaction");
  const { service } = decisionService(h, receipts, () => caller, async (...args) => {
    args[4]?.();
    throw new StoreBusyBeforeAdmissionError("fixture writer refused before admission");
  });
  const operation = service.callTool("pipeline_action", { ...h.request, pipelineId: h.id, expectedRevision: "0".repeat(64) });
  await entered;
  const before = fs.readFileSync(filename, "utf8"); caller = "conversation_foreign"; resume();
  expect((await operation).ok).toBe(false);
  expect(fs.readFileSync(filename, "utf8")).toBe(before);
  expect(current().decisionAnswers ?? []).toEqual([]);
});


test.each(["allowed", "scope", "claim"])("real registry capability remains current through decision %s", async boundary => {
  const h = await parked();
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { attentionCallerAuthority } = await import("@/lib/attention/callerAuthority");
  const { attentionCallerSources } = await import("@/lib/mcp/bindings");
  const { runAsMcpHttpCaller } = await import("@/lib/mcp/callerContext");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `decision-caller-${boundary}.json`), undefined, undefined, { sqliteMode: "off" });
  try {
    const launch = registry.beginSpawn("codex", "/repo", { project: "viewer", title: "Decision caller authority fixture" });
    const capability = registry.rotateSpawnCapabilityForReceipt(launch.launchId);
    const rows = loadPipelines(); rows[0]!.srcConversationId = launch.conversationId; savePipelines(rows);
    const token = pipelineDecisionRevision(current())!;
    const filename = path.join(process.env.LLV_STATE_DIR!, `real-caller-${boundary}-receipts.json`);
    const durable = new FileMcpReceiptStore(filename);
    const receipts: McpReceiptStore = {
      claim: async (...args) => { if (boundary === "claim") { await Promise.resolve(); registry.rotateSpawnCapabilityForReceipt(launch.launchId); } return durable.claim(...args); },
      complete: (...args) => durable.complete(...args),
    };
    const dependencies: Partial<ViewerMcpDomainDependencies> = {
      readPipelineRecord: () => current(),
      patchPipeline: (id, request, _ports, actor, authority, member) => patchPipeline(id, request, h.ports, actor, authority, member),
      attentionAuthority: () => attentionCallerAuthority(attentionCallerSources(registry)),
      registrySnapshot: () => registry.readOnlySnapshot(),
    };
    const bindings = viewerMcpBindings(undefined, undefined, dependencies as ViewerMcpDomainDependencies);
    if (boundary === "scope") bindings.pipeline_action.receiptScope = async () => { registry.rotateSpawnCapabilityForReceipt(launch.launchId); return null; };
    const result = await runAsMcpHttpCaller({ capability }, () => createMcpToolService(bindings, receipts).callTool("pipeline_action", { ...h.request, pipelineId: h.id, expectedRevision: token }));
    expect(result.ok).toBe(boundary === "allowed");
    expect(current().decisionAnswers?.length ?? 0).toBe(boundary === "allowed" ? 1 : 0);
    if (boundary !== "allowed") expect(fs.existsSync(filename)).toBe(false);
  } finally { registry.close(); }
});


test.each(["allowed", "ended"])("decision deputy authority is current after newAttempt: %s", async boundary => {
  const { beginDeputy, recordDeputyFork, endDeputy } = await import("@/lib/orchestrator/deputies");
  const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
  const at = "2026-11-03T10:00:00.000Z"; setSystemTime(new Date(at));
  try {
    const h = await parked(), project = current().project, key = `decision-deputy-${boundary}`;
    let time = Date.parse(at); h.ports.now = () => new Date(time += 1000).toISOString();
    expect(beginOrchestratorSeatIntent({ project, clientRequestId: key, mode: "spawn", mandate: "Run the project", now: at }).kind).toBe("begun");
    expect(completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: manager.conversationId, path: null, now: at }).kind).toBe("activated");
    const seat = orchestratorSeatFor(project).active!;
    const begun = beginDeputy({ project, seatConversationId: manager.conversationId, seatEpoch: seat.seatEpoch, seatPath: null,
      clientRequestId: key, ask: { text: "Answer the format decision", images: 0, sender: null }, now: new Date(at), askId: key });
    if (begun.kind !== "begun") throw new Error("decision deputy did not begin");
    const deputy = `conversation_deputy_${boundary}`;
    recordDeputyFork(begun.deputy.askId, { deputyConversationId: deputy, artifactPath: `/codex/deputy-${boundary}.jsonl`, forkRecordCount: 1 });
    const actor = { ...manager, via: { deputy } };
    if (boundary === "ended") {
      const now = h.ports.now; let once = true;
      h.ports.now = () => { if (once) { once = false; queueMicrotask(() => endDeputy(begun.deputy.askId, { outcome: "done", now: new Date(at) })); } return now(); };
    }
    const outcome = await patchPipeline(h.id, { ...h.request, expectedRevision: pipelineDecisionRevision(current())! }, h.ports, actor).catch(error => error as Error);
    if (boundary === "ended") expect(outcome).toBeInstanceOf(Error);
    else {
      expect(outcome).toMatchObject({ decisionAnswer: { actor } });
      await tickPipelines([], h.ports);
      expect(h.spawnedStages).toEqual(["build", "build"]);
    }
    expect(current().decisionAnswers?.length ?? 0).toBe(boundary === "allowed" ? 1 : 0);
  } finally { endDeputy(`decision-deputy-${boundary}`, { outcome: "done", now: new Date(at) }); setSystemTime(); }
});


test("cached decision replay refuses a rebound target without changing the original receipt", async () => {
  const h = await interruptedAnswer("after-answer");
  const accepted = await h.reopen().callTool("pipeline_action", h.args);
  expect(accepted.ok).toBe(true);
  const original = current(), receiptsBefore = h.receiptContents();
  const durable = new FileMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, `receipts-${h.id}.json`));
  const { bindings } = decisionService(h, durable);
  let replacement = "";
  bindings.pipeline_action.receiptScope = async () => {
    const row = structuredClone(original), attempt = row.runs[0]!.attempts[0]!;
    row.runs[0]!.attempts = [attempt]; row.decisionAnswers = [];
    attempt.output = "Choose another output format?"; attempt.report!.summary = attempt.output;
    row.state = "needs_decision"; row.cursor = { stageId: "build", state: "running", input: attempt.input, activatedBy: attempt.activatedBy ?? null };
    savePipelines([row]); replacement = JSON.stringify(current());
    return null;
  };
  const refused = await createMcpToolService(bindings, durable).callTool("pipeline_action", h.args);
  expect(refused.ok).toBe(false);
  expect(refused.decisionAnswer).toBeUndefined();
  expect(JSON.stringify(current())).toBe(replacement);
  expect(h.receiptContents()).toBe(receiptsBefore);
  savePipelines([original]);
  expect(await h.reopen().callTool("pipeline_action", h.args)).toEqual({ ...accepted, replayed: true });
  expect(h.receiptContents()).toBe(receiptsBefore);
  expect(h.spawnedStages).toEqual(["build"]);
});


test("answer completion cannot settle a receipt after its durable target was replaced", async () => {
  const h = await parked();
  const filename = path.join(process.env.LLV_STATE_DIR!, "completion-target-replacement.json");
  const durable = new FileMcpReceiptStore(filename);
  let before = "", replacement = "";
  const receipts: McpReceiptStore = {
    claim: (...args) => durable.claim(...args),
    complete: async (...args) => {
      before = fs.readFileSync(filename, "utf8");
      const row = current(), attempt = row.runs[0]!.attempts[0]!;
      row.runs[0]!.attempts = [attempt]; row.decisionAnswers = [];
      attempt.output = "Choose another format?"; attempt.report!.summary = attempt.output;
      row.state = "needs_decision"; row.cursor = { stageId: "build", state: "running", input: attempt.input, activatedBy: attempt.activatedBy ?? null };
      savePipelines([row]); replacement = JSON.stringify(current());
      await durable.complete(...args);
    },
  };
  const { service } = decisionService(h, receipts);
  const result = await service.callTool("pipeline_action", { ...h.request, pipelineId: h.id, expectedRevision: pipelineDecisionRevision(current())! });
  expect(result.ok).toBe(false);
  expect(result.decisionAnswer).toBeUndefined();
  expect(JSON.stringify(current())).toBe(replacement);
  expect(fs.readFileSync(filename, "utf8")).toBe(before);
  expect(h.spawnedStages).toEqual(["build"]);
});

test("ordinary pipeline actions retain their existing workspace assertion", async () => {
  const h = await parked();
  const { bindings } = decisionService(h, new FileMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "ordinary-action.json")));
  let decisionChecks = 0;
  await bindings.pipeline_action({ pipelineId: h.id, action: "pause" }, { assertCaller: () => { decisionChecks++; throw new Error("decision-only fixture assertion"); } });
  expect(current().state).toBe("paused");
  expect(decisionChecks).toBe(0);
});
