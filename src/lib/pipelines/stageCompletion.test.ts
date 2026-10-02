import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";
import { realExec } from "@/lib/workflows/provision";

/* Graph slice 2 (#1730): a stage attempt reports its own completion through one
   MCP call. Host and account ports are mocks. Artifact reads inspect only the
   fixture index, and the state directory is private to this file. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-completion-"));
const { createPipelineFromRequest, patchPipeline, reportStageCompletion, tickPipelines } = await import("./engine");
const { settlePendingStageProvenance } = await import("./stageProvenance");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines, pipelineIdentity, withPipelineMutation } = await import("./store");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
const { createMcpToolService, FileMcpReceiptStore } = await import("@/lib/mcp/server");
const { asStoredLegacyReviewLane } = await import("./fixtures/legacyReviewLane");
type PipelinePorts = import("./engine").PipelinePorts;
type StageCompletionRequest = import("./engine").StageCompletionRequest;
type Pipeline = import("./types").Pipeline;

/* The board projection the operator reads, over the record the engine wrote:
   the card's own summarize + progress path, not a hand-built fixture (#1785). */
const { summarizePipeline } = await import("@/components/kanban/kanbanModel");
const { pastAttempts } = await import("@/components/kanban/pipelineGraph");
const { pipelineProgress, stageDisplayName } = await import("@/components/kanban/PipelineSection");
const { translate } = await import("@/lib/i18n");
const { stageOutcomeReason } = await import("@/components/pipelines/pipelineModel");
const { projectPipelineEvents } = await import("@/lib/lifecycle/projector");
const { operatorSafeSummary } = await import("@/lib/lifecycle/vocabulary");
type TFunction = import("@/lib/i18n").TFunction;
const t = ((key: string, params?: Record<string, unknown>) => translate("en", key as never, params as never)) as TFunction;

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
  const spawnedPrompts: string[] = [];
  /* What the mocked worktree answers the server's own provenance reads. */
  const worktree = { remote: "https://forge.example/repo.git", status: "", knownPaths: "docs/report.html\0", pullRequest: PULL_REQUEST };
  const execCalls: string[] = [];
  /* Runs once, while the server is reading provenance and holds no lease. */
  let duringProvenance: (() => void) | null = null;
  let clock = 1_000_000;
  const ports: PipelinePorts = {
    exec: async (command, rawArgs, cwd, env, options) => {
      if (options?.stdoutEncoding === "latin1") return await realExec(command, rawArgs, cwd, env, options);
      execCalls.push([command, ...rawArgs].join(" "));
      if (command === "gh") {
        const race = duringProvenance; duringProvenance = null; race?.();
        return { code: 0, stdout: worktree.pullRequest, stderr: "" };
      }
      if (command === "timeout") {
        const race = duringProvenance;
        duringProvenance = null;
        race?.();
        const bounded = rawArgs.slice(rawArgs.findIndex((argument) => argument === "git" || argument === "gh"));
        if (bounded[0] === "gh") return { code: 0, stdout: worktree.pullRequest, stderr: "" };
        return (await ports.exec("git", bounded.slice(1), ""));
      }
      const args = rawArgs;
      // The publication contract needs a forge remote; an absent one parks.
      if (args[0] === "remote" && args[1] === "get-url") return { code: worktree.remote ? 0 : 2, stdout: worktree.remote, stderr: "" };
      if (args[0] === "ls-remote") return { code: 0, stdout: `${HEAD}\trefs/heads/${loadPipelines()[0]?.delivery?.target.branch ?? "fixture"}\n`, stderr: "" };
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
      spawnedPrompts.push(input.prompt);
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
    durableTurnEvidence: async (_engine, transcriptPath) => {
      const message = messages.get(transcriptPath);
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
    ports, worktree, spawnedStages, spawnedPrompts, endTurn, report, execCalls,
    raceDuringProvenance: (race: () => void) => { duringProvenance = race; },
  };
}

const stage = (id: string, next: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "run", role: { roleId: "builder" }, prompt: `Do ${id}`, next, ...extra });

async function started(ports: PipelinePorts, stages: unknown[], publication: Pipeline["publication"] = "internal", repoDir = "/repo"): Promise<string> {
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Graph slice 2", spec: "AC", publication, repoDir, stages: stages as never, src: "/codex/creator.jsonl" }, ports);
  if (!created.pipeline) throw new Error(created.error);
  /* A review-loop here stands for a lane stored before #2187, which still
     reviews through its embedded flow; creation now converts new ones. */
  if (created.convertedStages?.length) savePipelines([asStoredLegacyReviewLane(created.pipeline, created.convertedStages)]);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn the entry stage
  return created.pipeline.id;
}

const current = () => loadPipelines()[0]!;
const attemptsOf = (stageId: string) => current().runs.find((run) => run.stageId === stageId)!.attempts;

test("stage_report durably accepts pending provenance without waiting for the forge", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  const original = h.ports.exec;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  h.ports.exec = async (command, args, cwd) => {
    if (command === "gh") await held;
    return await original(command, args, cwd);
  };
  const pendingReport = h.report(1, { verdict: "pass", summary: "Checked." });
  try {
    const answer = await Promise.race([pendingReport, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    expect(answer).not.toBeNull();
    expect(current().runs[0]!.attempts[0]!.report?.provenance).toMatchObject({ state: "pending", head: null, pullRequest: null });
  } finally { release(); await pendingReport; }
  await tickPipelines([], h.ports);
  expect(current().runs[0]!.attempts[0]!.report?.provenance).toMatchObject({ state: "complete", head: HEAD });
});

test.each(["control-before", "control-during", "delivery-before", "delivery-during", "worktree-during", "head-during", "branch-during"] as const)("deferred provenance fences %s against its durable admission", async (change) => {
  const h = harness(); await started(h.ports, [stage("build", null)]);
  const clock = "2026-01-01T00:00:00.000Z"; h.ports.now = () => clock;
  await withPipelineMutation((pipelines, persist) => {
    const lane = pipelines[0]!; lane.pausedAt = clock; lane.resumedAt = clock;
    lane.delivery = { target: { repository: "provenance-repo", remote: "origin", branch: `refs/heads/${lane.branch}` },
      disposition: "owner", publish: "enabled", active: true, ownerId: lane.id, epoch: 1, journal: [] };
    persist();
  });
  await h.report(1, { verdict: "pass", summary: "Checked." });
  const mutate = async () => {
    if (change.startsWith("control")) {
      await patchPipeline(current().id, { action: "pause" }, h.ports);
      await patchPipeline(current().id, { action: "resume" }, h.ports);
    } else await withPipelineMutation((pipelines, persist) => {
      const lane = pipelines[0]!;
      if (change.startsWith("delivery")) lane.delivery!.epoch++;
      if (change.startsWith("worktree")) { lane.repoDir += "-replacement"; Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir)); }
      if (change.startsWith("head")) lane.lastPassedCommit = "b".repeat(40);
      if (change.startsWith("branch")) { lane.task += " replacement"; Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir)); }
      persist();
    });
  };
  let commands = 0, observedSignal: AbortSignal | undefined;
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = h.ports.exec;
  h.ports.exec = async (command, args, cwd, env, options) => {
    commands++;
    if (command === "gh" && change.endsWith("during")) { observedSignal = options?.signal; entered(); await held; }
    return await original(command, args, cwd, env, options);
  };
  const before = change.endsWith("before");
  if (before) await mutate();
  const observation = settlePendingStageProvenance(h.ports);
  try {
    if (!before) {
      await checking; await mutate(); await Bun.sleep(75);
      expect(observedSignal?.aborted).toBe(true);
    }
    release(); await observation;
    if (before) expect(commands).toBe(0);
    expect(attemptsOf("build")[0]!.report).toMatchObject({ verdict: { status: "pass" }, provenance: { state: "unknown", head: null, pullRequestState: "unknown" } });
    expect(current().stageReports!.at(-1)).toMatchObject({ provenanceState: "unknown" });
  } finally { release(); await observation; }
});

test("stage_report retries the same request after a pre-admission pipeline store busy refusal", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  const bindings = viewerMcpBindings(undefined, undefined, {
    reportStageCompletion: (request: StageCompletionRequest, actor: ReturnType<typeof agent>) => reportStageCompletion(request, actor, h.ports),
    callerAttribution: () => ({ kind: "worker", conversationId: "conversation_stage_1", role: "builder" }),
  } as never);
  const receiptPath = path.join(process.env.LLV_STATE_DIR!, "busy-stage-report-receipts.json");
  const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
  const args = { clientRequestId: "busy-then-accepted", verdict: "pass", summary: "Build checked." };
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const oldWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "0";
  const holder = withPipelineMutation(async () => { entered(); await held; });
  await acquired;
  try {
    expect(await service.callTool("stage_report", args)).toMatchObject({ ok: false, code: "tool_failed", details: { code: "store_busy", evidence: "not-admitted", nextAction: "retry-same-key" } });
  } finally {
    release();
    await holder;
    if (oldWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
    else process.env.LLV_PIPELINE_LOCK_WAIT_MS = oldWait;
  }
  expect(current().stageReports).toBeUndefined();
  const accepted = await service.callTool("stage_report", args);
  expect(accepted).toMatchObject({ ok: true, replayed: false, report: { seq: 1 } });
  const reopened = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
  expect(await reopened.callTool("stage_report", args)).toEqual({ ...accepted, replayed: true });
  expect(current().stageReports).toHaveLength(1);
  expect(attemptsOf("build")[0]!.report).toMatchObject({ calls: 1, verdict: { status: "pass" } });
});

test("terminal JSON with a bare severity cannot settle as a review finding", async () => {
  const h = harness();
  await reachedVerify(h, FIX_LOOP());
  await tickPipelines([h.endTurn(2, 'Reviewed.\n\n```json\n{"status":"fail","findings":["P1"]}\n```')], h.ports);
  expect(attemptsOf("verify")[0]!.verdict?.findings).toBeUndefined();
  expect(h.spawnedStages).toEqual(["build", "verify"]);
});

test("a long stage_report finding survives settlement and the fix relay intact", async () => {
  const h = harness();
  await reachedVerify(h, FIX_LOOP());
  const body = "x".repeat(1_995);
  const result = await h.report(2, { verdict: "fail", findings: [{ severity: "P1", text: body }] });
  expect(result.report?.verdict.findings).toEqual([`P1 — ${body}`]);
  await tickPipelines([h.endTurn(2, "Reviewed.")], h.ports);
  await tickPipelines([], h.ports);
  expect(attemptsOf("verify")[0]!.verdict?.rankedFindings).toEqual([{ severity: "P1", text: body }]);
  expect(attemptsOf("build")[1]!.input).toContain(`P1 — ${body}`);
});

test("a live attempt's reported completion settles it when the turn ends, with server-collected provenance", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("build", "verify"), stage("verify", null, { access: "read-only", outputs: ["docs/report.html"] })]);

  const accepted = await h.report(1, { verdict: "pass", summary: "Bound the report to the attempt." });
  expect(accepted.error).toBeUndefined();
  expect(accepted).toMatchObject({ pipelineId: id, stageId: "build", attempt: 1, replaced: false });
  /* The call carried a verdict, findings and a summary; everything else on the
     record is what the server itself read from the worktree and the forge. */
  expect(accepted.report).toMatchObject({
    seq: 1,
    calls: 1,
    actor: { kind: "agent", role: "builder", conversationId: "conversation_stage_1" },
    verdict: { status: "pass" },
    summary: "Bound the report to the attempt.",
    provenance: { state: "pending", head: null, uncommitted: null, pullRequest: null, outputs: [] },
  });
  expect(accepted.report!.provenance.branch).toBe(current().branch);

  /* The call records an intent: nothing settles while the turn runs. */
  await tickPipelines([], h.ports);
  expect(attemptsOf("build")[0]!.state).toBe("running");
  expect(attemptsOf("build")[0]!.verdict).toBeNull();

  /* The turn ends with ordinary prose and no fenced verdict at all. */
  await tickPipelines([h.endTurn(1, "Done. Handing over to verification.")], h.ports);
  const settled = attemptsOf("build")[0]!;
  expect(settled.state).toBe("passed");
  expect(settled.verdict).toEqual({ status: "pass" });
  expect(settled.output).toBe("Bound the report to the attempt.\n\nFinal assistant message:\nDone. Handing over to verification.");
  expect(current().cursor?.stageId).toBe("verify");
  /* Both one-line displays of the settled stage read the reported summary:
     the board's collapsed stage row and the lifecycle event that wakes the
     orchestrator's seat tick. */
  const pipeline = current();
  expect(stageOutcomeReason(t, pipeline, pipeline.stages.find((candidate) => candidate.id === "build")!)).toBe("Bound the report to the attempt.");
  const completed = projectPipelineEvents([pipeline]).find((event) => event.type === "stage_completed" && event.stageId === "build")!;
  expect(operatorSafeSummary(completed.summary)).toBe("Bound the report to the attempt.");

  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["build", "verify"]);
  /* The second stage's declared outputs are the ones read for its own report. */
  const verify = await h.report(2, { verdict: "pass", summary: "Checked." });
  expect(verify.report!.provenance.outputs).toEqual([{ path: "docs/report.html", present: null }]);
  await settlePendingStageProvenance(h.ports);
  expect(attemptsOf("verify")[0]!.report!.provenance.outputs).toEqual([{ path: "docs/report.html", present: true }]);
});

for (const engine of ["claude", "codex"] as const) {
  test(`${engine} final brief reaches the next stage through {{prev.output}} and the automatic relay`, async () => {
    const h = harness();
    await started(h.ports, [
      stage("brief", "build", { engine, model: engine === "claude" ? "fable" : "gpt-5.6-sol" }),
      stage("build", null, { prompt: "Build from {{prev.output}}" }),
    ]);
    const brief = "Builder brief:\n- Preserve the original input.\n- Verify the rendered result.";
    await h.report(1, { verdict: "pass", summary: "Brief ready." });
    await tickPipelines([h.endTurn(1, brief)], h.ports);
    const relay = attemptsOf("brief")[0]!.output;
    expect(relay).toBe(`Brief ready.\n\nFinal assistant message:\n${brief}`);
    expect(current().cursor?.input).toBe(relay);
    await tickPipelines([], h.ports);
    expect(h.spawnedPrompts.at(-1)).toContain(`Build from ${relay}`);

    const automatic = harness();
    await started(automatic.ports, [stage("brief", "build", { engine, model: engine === "claude" ? "fable" : "gpt-5.6-sol" }), stage("build", null)]);
    await automatic.report(1, { verdict: "pass", summary: "Brief ready." });
    await tickPipelines([automatic.endTurn(1, brief)], automatic.ports);
    await tickPipelines([], automatic.ports);
    expect(automatic.spawnedPrompts.at(-1)).toContain(`Relayed by the controller (a previous stage's output, or the answer to this stage's earlier question):\n${relay}`);
  });
}

test("a brief written before stage_report survives a shorter closing message", async () => {
  const h = harness();
  await started(h.ports, [stage("brief", "build", { engine: "claude", model: "fable" }), stage("build", null, { prompt: "Build {{prev.output}}" })]);
  const brief = "Full builder brief with detailed file changes and checks.";
  await h.report(1, { verdict: "pass", summary: "Brief ready." });
  h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: { text: "Done.", ts: 1_100_000 }, reportProse: brief });
  await tickPipelines([h.endTurn(1, "Done.")], h.ports);
  const relay = attemptsOf("brief")[0]!.output!;
  expect(relay).toContain("Final assistant message:\nDone.");
  expect(relay).toContain(`Assistant message before stage_report:\n${brief}`);
  await tickPipelines([], h.ports);
  expect(h.spawnedPrompts.at(-1)).toContain(brief);
});

test("a long final brief is bounded in bytes with an explicit truncation marker", async () => {
  const h = harness();
  await started(h.ports, [stage("brief", "build"), stage("build", null, { prompt: "{{prev.output}}" })], "internal", path.join(process.env.LLV_STATE_DIR!, "long-relay-repo"));
  fs.mkdirSync(current().worktreeDir, { recursive: true });
  await h.report(1, { verdict: "pass", summary: "Brief ready." });
  await tickPipelines([h.endTurn(1, `Start. ${"🙂".repeat(20_000)} End.`)], h.ports);
  const relay = attemptsOf("brief")[0]!.output!;
  expect(Buffer.byteLength(relay)).toBeLessThanOrEqual(60 * 1024);
  expect(relay).toContain("Start. 🙂");
  expect(relay).toEndWith("[Previous stage output truncated to fit the 60 KiB relay]");
  expect(relay).not.toContain("End.");
  expect(relay).not.toContain("�");
  await tickPipelines([], h.ports);
  const prompt = h.spawnedPrompts.at(-1)!;
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(32_000);
  const file = prompt.match(/Full previous output file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toBe(relay);
});

test("a pass reported without a summary relays its prose without the fenced JSON verdict", async () => {
  const h = harness();
  await started(h.ports, [stage("brief", "build"), stage("build", null, { prompt: "Build {{prev.output}}" })]);
  await h.report(1, { verdict: "pass" });
  await tickPipelines([h.endTurn(1, 'Brief body.\n\n```json\n{"status":"pass","findings":[]}\n```')], h.ports);
  expect(attemptsOf("brief")[0]!.output).toBe("Brief body.");
  await tickPipelines([], h.ports);
  expect(h.spawnedPrompts.at(-1)).toContain("Build Brief body.\n\nPinned task:");
});

test("a persisted legacy attempt without final prose relays its summary", async () => {
  const h = harness();
  await started(h.ports, [stage("brief", "build"), stage("build", null, { prompt: "Build {{prev.output}}" })]);
  await h.report(1, { verdict: "pass", summary: "Legacy summary." });
  await tickPipelines([h.endTurn(1, "")], h.ports);
  expect(attemptsOf("brief")[0]!.output).toBe("Legacy summary.");
  const persisted = current();
  persisted.cursor!.input = null;
  persisted.cursor!.activatedBy = null;
  savePipelines([persisted]);
  await tickPipelines([], h.ports);
  expect(h.spawnedPrompts.at(-1)).toContain("Build Legacy summary.");
});

test("every accepted call is attributed on the pipeline, with the conversation, the attempt and the time", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);

  await h.report(1, { verdict: "fail", findings: [{ severity: "P1", text: "the loop never ends" }], summary: "One finding left." });
  const [entry] = current().stageReports!;
  expect(entry).toEqual({
    seq: 1,
    at: entry!.at,
    actor: { kind: "agent", role: "builder", conversationId: "conversation_stage_1" },
    stageId: "build",
    attempt: 1,
    status: "fail",
    findings: 1,
    replaces: null,
    provenanceState: "pending",
    summary: "One finding left.",
  });
  expect(Number.isFinite(Date.parse(entry!.at))).toBe(true);
});

test("a conversation that is not running a stage, and a stage it does not hold, are both refused", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);

  const stranger = await reportStageCompletion({ verdict: "pass" }, agent("conversation_stranger"), h.ports);
  expect(stranger).toMatchObject({ code: "STAGE_REPORT_NOT_AN_ATTEMPT", status: 403 });
  expect(stranger.report).toBeUndefined();

  const anonymous = await reportStageCompletion({ verdict: "pass" }, { kind: "operator" }, h.ports);
  expect(anonymous).toMatchObject({ code: "STAGE_REPORT_NOT_AN_ATTEMPT", status: 403 });

  const otherStage = await h.report(1, { verdict: "pass", stageId: "verify" });
  expect(otherStage).toMatchObject({ code: "STAGE_REPORT_NOT_HELD", status: 403 });
  expect(otherStage.slots).toEqual([{ pipelineId: current().id, stageId: "build", attempt: 1, state: "running" }]);

  /* None of the three wrote anything. */
  expect(current().stageReports).toBeUndefined();
  expect(attemptsOf("build")[0]!.report).toBeUndefined();

  /* The stage it does hold, named explicitly, is accepted. */
  expect((await h.report(1, { verdict: "pass", stageId: "build" })).error).toBeUndefined();
});

test("a second call replaces the first before settlement, and is refused after it", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);

  await h.report(1, { verdict: "fail", findings: [{ severity: "P2", text: "first answer" }], summary: "First." });
  const replaced = await h.report(1, { verdict: "pass", summary: "Second, after more work." });
  expect(replaced).toMatchObject({ replaced: true, report: { seq: 2, calls: 2 } });
  expect(attemptsOf("build")[0]!.report).toMatchObject({ seq: 2, verdict: { status: "pass" }, summary: "Second, after more work." });
  expect(current().stageReports!.map((record) => [record.seq, record.status, record.replaces]))
    .toEqual([[1, "fail", null], [2, "pass", 1]]);

  await tickPipelines([h.endTurn(1, "All done.")], h.ports);
  expect(attemptsOf("build")[0]!.state).toBe("passed");
  expect(attemptsOf("build")[0]!.verdict).toEqual({ status: "pass" });

  const stale = await h.report(1, { verdict: "fail", findings: [{ severity: "P0", text: "changed my mind" }] });
  expect(stale).toMatchObject({ code: "STAGE_REPORT_SETTLED", status: 409 });
  expect(stale.error).toContain("already settled as passed");
  /* Nothing moved: the settled verdict is the record the graph routed on. */
  expect(attemptsOf("build")[0]!.verdict).toEqual({ status: "pass" });
  expect(attemptsOf("build")[0]!.report).toMatchObject({ seq: 2 });
  expect(current().stageReports).toHaveLength(2);
});

test("the tool call wins when the turn also ends in a fenced JSON verdict", async () => {
  const h = harness();
  await started(h.ports, [stage("build", "verify"), stage("verify", null, { onFail: { to: "build", maxRounds: 2 } })]);

  await h.report(1, { verdict: "fail", findings: [{ severity: "P0", text: "the call is the authority" }], summary: "Reported fail." });
  await tickPipelines([h.endTurn(1, 'Finished.\n\n```json\n{"status":"pass","findings":[],"confidence":1}\n```')], h.ports);

  const settled = attemptsOf("build")[0]!;
  expect(settled.state).toBe("failed");
  expect(settled.verdict).toEqual({
    status: "fail",
    findings: ["P0 — the call is the authority"],
    rankedFindings: [{ severity: "P0", text: "the call is the authority" }],
  });
  expect(settled.output).toBe("Reported fail.");
});

test("findings keep severity order on the record, the relay and the park detail", async () => {
  const h = harness();
  await started(h.ports, [stage("build", "verify"), stage("verify", null)]);

  await h.report(1, {
    verdict: "fail",
    findings: [
      { severity: "P2", text: "a nit" },
      { severity: "P0", text: "the worst one" },
      { severity: "P1", text: "the middle one" },
    ],
  });
  await tickPipelines([h.endTurn(1, "Handing back.")], h.ports);

  const settled = attemptsOf("build")[0]!;
  expect(settled.verdict!.findings).toEqual(["P0 — the worst one", "P1 — the middle one", "P2 — a nit"]);
  expect(settled.verdict!.rankedFindings).toEqual([
    { severity: "P0", text: "the worst one" },
    { severity: "P1", text: "the middle one" },
    { severity: "P2", text: "a nit" },
  ]);
  /* A stage with no fail edge parks, and the park names the worst finding. */
  expect(current().state).toBe("needs_decision");
  expect(current().stateDetail).toContain("P0 — the worst one");
});

test("a pass that carries findings is refused at the call, where the agent can still fix it", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);

  const refused = await h.report(1, { verdict: "pass", findings: [{ severity: "P2", text: "still open" }] });
  expect(refused).toMatchObject({ code: "STAGE_REPORT_CONTRADICTORY", status: 400 });
  expect(refused.error).toContain('status "pass" cannot include findings');
  expect(attemptsOf("build")[0]!.report).toBeUndefined();
  expect(current().stageReports).toBeUndefined();

  /* The stage is still open, so the corrected call in the same turn is taken. */
  expect((await h.report(1, { verdict: "fail", findings: [{ severity: "P2", text: "still open" }] })).error).toBeUndefined();
});

test("a reported fail routes along the fail edge and relays the summary as the stage's output", async () => {
  const h = harness();
  await started(h.ports, [stage("build", "verify"), stage("verify", null, { onFail: { to: "build", maxRounds: 3 } })]);

  await tickPipelines([h.endTurn(1, 'Built.\n\n```json\n{"status":"pass","findings":[]}\n```')], h.ports);
  await tickPipelines([], h.ports); // spawn verify
  expect(h.spawnedStages).toEqual(["build", "verify"]);

  await h.report(2, { verdict: "fail", findings: [{ severity: "P1", text: "the fence is missing" }], summary: "Review found one gap." });
  await tickPipelines([h.endTurn(2, "Reviewed.")], h.ports);
  await tickPipelines([], h.ports); // spawn build attempt 2

  expect(h.spawnedStages).toEqual(["build", "verify", "build"]);
  expect(attemptsOf("verify")[0]!.state).toBe("failed");
  expect(attemptsOf("verify")[0]!.output).toBe("Review found one gap.");
  expect(attemptsOf("build")[1]!.input).toContain("P1 — the fence is missing");
});

test("a report whose worktree the server could not read is still accepted, and says so", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  h.worktree.status = " M src/lib/x.ts\n";
  h.worktree.pullRequest = "[]";

  const accepted = await h.report(1, { verdict: "pass", summary: "Left work uncommitted." });
  await settlePendingStageProvenance(h.ports);
  expect(attemptsOf("build")[0]!.report!.provenance).toMatchObject({ uncommitted: ["src/lib/x.ts"], pullRequest: null });
  expect(accepted.error).toBeUndefined();
});

test("a refused call runs no command at all, so no forge latency is ever spent on one", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  h.execCalls.length = 0;

  expect(await reportStageCompletion({ verdict: "pass" }, agent("conversation_stranger"), h.ports))
    .toMatchObject({ code: "STAGE_REPORT_NOT_AN_ATTEMPT" });
  expect(await h.report(1, { verdict: "pass", stageId: "verify" })).toMatchObject({ code: "STAGE_REPORT_NOT_HELD" });
  expect(await h.report(1, { verdict: "pass", findings: [{ severity: "P1", text: "still open" }] }))
    .toMatchObject({ code: "STAGE_REPORT_CONTRADICTORY" });
  expect(h.execCalls).toEqual([]);

  /* Acceptance reads no external command; the controller later observes it. */
  expect((await h.report(1, { verdict: "pass" })).error).toBeUndefined();
  expect(h.execCalls).toEqual([]);
  await settlePendingStageProvenance(h.ports);
  expect(h.execCalls.some((command) => command.includes("gh pr list"))).toBe(true);
});

test("a deferred observation cannot attach to an attempt that replaced the reported one", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  const accepted = await h.report(1, { verdict: "pass", summary: "Reported against attempt 1." });
  expect(accepted.report?.provenance.state).toBe("pending");
  h.raceDuringProvenance(() => {
    const records = loadPipelines();
    const attempts = records[0]!.runs[0]!.attempts;
    attempts[0]!.state = "failed";
    attempts.push({ ...structuredClone(attempts[0]!), n: 2, state: "running", report: null } as never);
    savePipelines(records);
  });
  await settlePendingStageProvenance(h.ports);
  expect(attemptsOf("build")[1]!.report).toBeNull();
  expect(attemptsOf("build")[0]!.report?.provenance.state).toBe("unknown");
  const next = await h.report(1, { verdict: "pass", summary: "Reported against attempt 2." });
  expect(next).toMatchObject({ attempt: 2, replaced: false });
});

test("a review-loop stage's reviewer cannot report a completion, and nothing is written", async () => {
  const h = harness();
  await started(h.ports, [
    stage("build", "review"),
    { id: "review", kind: "review-loop", role: { roleId: "builder" }, prompt: "Review the run", next: null },
  ]);
  await tickPipelines([h.endTurn(1, 'Built.\n\n```json\n{"status":"pass","findings":[]}\n```')], h.ports);

  /* What attachReviewFlowAttempt leaves on a review-loop attempt: the flow's
     reviewer conversation, running the flow's own review. Its verdict is the
     flow outcome tickReviewStage settles from, and that path never reads a
     report — so a report taken here would show on the card and move nothing. */
  const records = loadPipelines();
  const review = records[0]!.runs.find((run) => run.stageId === "review")!;
  review.attempts.push({
    ...structuredClone(records[0]!.runs[0]!.attempts[0]!),
    n: 1,
    state: "reviewing",
    conversationId: "conversation_stage_2",
    agentPath: "/codex/stage-2.jsonl",
    flowId: "flow_review_1",
    verdict: null,
    completedAt: null,
    report: null,
  } as never);
  savePipelines(records);
  h.execCalls.length = 0;

  const refused = await h.report(2, { verdict: "pass", summary: "Approved it myself." });
  expect(refused).toMatchObject({ code: "STAGE_REPORT_NOT_A_RUN_STAGE", status: 403 });
  expect(refused.error).toContain("review-loop stage");
  expect(refused.slots).toEqual([{ pipelineId: current().id, stageId: "review", attempt: 1, state: "reviewing" }]);

  /* Nothing written, on the attempt or on the pipeline, and no command run. */
  expect(refused.report).toBeUndefined();
  expect(attemptsOf("review")[0]!.report ?? null).toBeNull();
  expect(attemptsOf("review")[0]!.verdict).toBeNull();
  expect(current().stageReports).toBeUndefined();
  expect(h.execCalls).toEqual([]);
});

test("an attempt persisted in committing has already answered, so its completion is refused", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  /* The durable window settleStageVerdict opens: the verdict is written and
     the state marked committing before the commit lands, and the graph has
     routed on that verdict, so the attempt is settled for reporting. */
  const records = loadPipelines();
  const attempt = records[0]!.runs[0]!.attempts[0]!;
  attempt.state = "committing";
  attempt.verdict = { status: "pass" };
  savePipelines(records);
  h.execCalls.length = 0;

  const refused = await h.report(1, { verdict: "fail", findings: [{ severity: "P0", text: "changed my mind" }] });
  expect(refused).toMatchObject({ code: "STAGE_REPORT_SETTLED", status: 409 });
  expect(refused.error).toContain("already settled as committing");
  expect(refused.slots).toEqual([{ pipelineId: current().id, stageId: "build", attempt: 1, state: "committing" }]);

  expect(attemptsOf("build")[0]!.report ?? null).toBeNull();
  expect(attemptsOf("build")[0]!.verdict).toEqual({ status: "pass" });
  expect(current().stageReports).toBeUndefined();
  expect(h.execCalls).toEqual([]);
});

/* ── #1785: a needs_decision carrying an actionable finding routes to the fix
   stage, because reviewers reported fixable defects under that status when only
   their confidence in the call was partial, and the lane stopped for a human to
   relay one paragraph. ── */

const FIX_LOOP = () => [stage("build", "verify"), stage("verify", null, { onFail: { to: "build", maxRounds: 2 } })];

/** build passes, verify is spawned and holds the cursor. */
async function reachedVerify(h: ReturnType<typeof harness>, stages: unknown[]): Promise<void> {
  await started(h.ports, stages);
  await tickPipelines([h.endTurn(1, 'Built.\n\n```json\n{"status":"pass","findings":[]}\n```')], h.ports);
  await tickPipelines([], h.ports);
}

test("a needs_decision with findings fires the fail edge and hands the findings to the fix stage (#1785)", async () => {
  const h = harness();
  await reachedVerify(h, FIX_LOOP());

  await h.report(2, {
    verdict: "needs_decision",
    findings: [{ severity: "P1", text: "the fence is missing" }],
    summary: "Fixable; my confidence in the call is partial.",
  });
  await tickPipelines([h.endTurn(2, "Reviewed.")], h.ports);

  const decided = attemptsOf("verify")[0]!;
  /* The verdict stays the one the reviewer reported; the routing is what changed. */
  expect(decided.verdict).toMatchObject({ status: "needs_decision", findings: ["P1 — the fence is missing"] });
  expect(decided.state).toBe("needs_decision");
  expect(decided.decisionRequested).toBe(true);
  expect(current().state).toBe("running");
  expect(current().cursor).toMatchObject({
    stageId: "build",
    state: "pending",
    activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
  });

  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["build", "verify", "build"]);
  const relayed = attemptsOf("build")[1]!.input!;
  expect(relayed).toContain("Needs-decision verdict findings:\n- P1 — the fence is missing");
  expect(relayed).toContain("Fixable; my confidence in the call is partial.");
});

test("a needs_decision with findings parks once a park edge's budget is spent (#1785)", async () => {
  const h = harness();
  await reachedVerify(h, [stage("build", "verify"), stage("verify", null, { onFail: { to: "build", maxRounds: 1, onExhausted: "park" } })]);

  /* Round one: the only round this edge has. */
  await h.report(2, { verdict: "needs_decision", findings: [{ severity: "P1", text: "the fence is missing" }] });
  await tickPipelines([h.endTurn(2, "Reviewed.")], h.ports);
  await tickPipelines([], h.ports); // spawn build attempt 2
  await tickPipelines([h.endTurn(3, 'Fixed.\n\n```json\n{"status":"pass","findings":[]}\n```')], h.ports);
  await tickPipelines([], h.ports); // spawn verify attempt 2
  expect(h.spawnedStages).toEqual(["build", "verify", "build", "verify"]);

  await h.report(4, { verdict: "needs_decision", findings: [{ severity: "P0", text: "still broken" }] });
  await tickPipelines([h.endTurn(4, "Reviewed again.")], h.ports);

  /* Parked exactly as before the change: the verdict's own worst finding is the
     detail, never a budget message about a fail the reviewer never reported. */
  expect(current().state).toBe("needs_decision");
  expect(current().stateDetail).toBe("P0 — still broken");
  expect(current().cursor?.stageId).toBe("verify");
  const parked = attemptsOf("verify")[1]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.decisionRequested).toBeUndefined();
  expect(attemptsOf("build")).toHaveLength(2);
});

test("a needs_decision with findings on a spent default edge is handed to the fix stage once, then follows the pass edge (#1868)", async () => {
  const h = harness();
  await reachedVerify(h, [
    stage("build", "verify"),
    stage("verify", "ship", { onFail: { to: "build", maxRounds: 1 } }),
    stage("ship", null),
  ]);

  /* The edge's only review fails: the findings go to build as the last fix. */
  await h.report(2, { verdict: "needs_decision", findings: [{ severity: "P1", text: "the fence is missing" }] });
  await tickPipelines([h.endTurn(2, "Reviewed.")], h.ports);

  const handed = attemptsOf("verify")[0]!;
  expect(handed.state).toBe("needs_decision");
  expect(handed.decisionRequested).toBe(true);
  expect(handed.budgetSpent).toBe(true);
  expect(current().state).toBe("running");
  expect(current().cursor).toMatchObject({
    stageId: "build",
    state: "pending",
    activatedBy: { stageId: "verify", attempt: 1, edge: "fail", budgetSpent: true },
  });

  await tickPipelines([], h.ports); // spawn build attempt 2
  expect(attemptsOf("build")[1]!.input!).toContain("Needs-decision verdict findings:\n- P1 — the fence is missing");
  await tickPipelines([h.endTurn(3, 'Fixed.\n\n```json\n{"status":"pass","findings":[]}\n```')], h.ports);
  await tickPipelines([], h.ports);

  /* verify is not asked again: the fix follows verify's pass edge to ship. */
  expect(h.spawnedStages).toEqual(["build", "verify", "build", "ship"]);
  expect(attemptsOf("verify")).toHaveLength(1);
  expect(current().cursor?.stageId).toBe("ship");
});

test("a spent-budget handoff keeps the fix's whole brief and cuts a longer one with a marker, on a character boundary", async () => {
  for (const [body, whole] of [[`${"b".repeat(50_000)} END OF BRIEF`, true], [`Start. ${"🙂".repeat(20_000)} END OF BRIEF`, false]] as const) {
    const h = harness();
    await reachedVerify(h, [
      stage("build", "verify"),
      stage("verify", "ship", { onFail: { to: "build", maxRounds: 1 } }),
      stage("ship", null),
    ]);
    await h.report(2, { verdict: "fail", findings: [{ severity: "P1", text: "the fence is missing" }] });
    await tickPipelines([h.endTurn(2, "Reviewed.")], h.ports);
    await tickPipelines([], h.ports); // spawn build attempt 2
    await h.report(3, { verdict: "pass", summary: "Fence added." });
    await tickPipelines([h.endTurn(3, body)], h.ports);
    expect(current().cursor?.stageId).toBe("ship");
    const input = current().cursor!.input!;
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(60 * 1024);
    expect(input).toStartWith("Fence added.");
    expect(input).toEndWith("Unreviewed findings:\n- P1 — the fence is missing");
    expect(input).not.toContain("\uFFFD");
    expect(input.includes("END OF BRIEF")).toBe(whole);
    expect(input.includes("[Previous stage output truncated to fit the 60 KiB relay]")).toBe(!whole);
  }
});

test("a needs_decision parks with no fail edge, and parks with no findings (#1785)", async () => {
  const noEdge = harness();
  await reachedVerify(noEdge, [stage("build", "verify"), stage("verify", null)]);
  await noEdge.report(2, { verdict: "needs_decision", findings: [{ severity: "P2", text: "nowhere to route this" }] });
  await tickPipelines([noEdge.endTurn(2, "Reviewed.")], noEdge.ports);
  expect(current().state).toBe("needs_decision");
  expect(current().stateDetail).toBe("P2 — nowhere to route this");
  expect(current().cursor?.stageId).toBe("verify");
  expect(attemptsOf("build")).toHaveLength(1);
  expect(attemptsOf("verify")[0]!.decisionRequested).toBeUndefined();

  /* A fail edge with its whole budget left, and a verdict with nothing to fix. */
  const noFindings = harness();
  await reachedVerify(noFindings, FIX_LOOP());
  await noFindings.report(2, { verdict: "needs_decision", summary: "Only the operator can choose here." });
  await tickPipelines([noFindings.endTurn(2, "Reviewed.")], noFindings.ports);
  expect(current().state).toBe("needs_decision");
  expect(current().stateDetail).toBe("stage verdict: needs_decision");
  expect(attemptsOf("build")).toHaveLength(1);
  expect(attemptsOf("verify")[0]!.decisionRequested).toBeUndefined();
});

test("a plain fail still routes under its own heading, and a plain pass still advances (#1785)", async () => {
  const h = harness();
  await reachedVerify(h, FIX_LOOP());

  await h.report(2, { verdict: "fail", findings: [{ severity: "P1", text: "the fence is missing" }], summary: "One gap." });
  await tickPipelines([h.endTurn(2, "Reviewed.")], h.ports);
  await tickPipelines([], h.ports);
  expect(attemptsOf("verify")[0]!.state).toBe("failed");
  expect(attemptsOf("verify")[0]!.decisionRequested).toBeUndefined();
  expect(attemptsOf("build")[1]!.input).toContain("Fail verdict findings:\n- P1 — the fence is missing");

  /* The loop round passes and the pipeline completes, as a pass always did. */
  await tickPipelines([h.endTurn(3, 'Fixed.\n\n```json\n{"status":"pass","findings":[]}\n```')], h.ports);
  await tickPipelines([], h.ports);
  await h.report(4, { verdict: "pass", summary: "Clean." });
  await tickPipelines([h.endTurn(4, "Approved.")], h.ports);
  expect(attemptsOf("verify")[1]!.state).toBe("passed");
  expect(attemptsOf("verify")[1]!.decisionRequested).toBeUndefined();
  expect(current().state).toBe("completed");
});

/** The card's own two lines for a pipeline: every stage chip, and the progress
    sentence the operator reads under the title. */
function card(): { chips: Array<{ id: string; state: string }>; progress: string } {
  const pipeline = current();
  const summary = summarizePipeline(pipeline);
  return {
    chips: summary.chips.map((chip) => ({ id: chip.stage.id, state: chip.state })),
    progress: pipelineProgress(t, summary, (stage) => stageDisplayName(t, stage)),
  };
}

test("a routed needs_decision leaves no chip claiming the operator is needed, while a parked one still reads needs you (#1785)", async () => {
  const routed = harness();
  await reachedVerify(routed, FIX_LOOP());
  await routed.report(2, { verdict: "needs_decision", findings: [{ severity: "P1", text: "the fence is missing" }] });
  await tickPipelines([routed.endTurn(2, "Reviewed.")], routed.ports);
  await tickPipelines([], routed.ports); // the fix stage is spawned and running

  /* The lane is running the fix stage, and the card says so: the settled
     needs_decision is the loop source it became, not a claim on the operator. */
  const running = card();
  expect(running.chips.some((chip) => chip.state === "needs_decision")).toBe(false);
  expect(running.chips.find((chip) => chip.id === "build")!.state).toBe("running");
  expect(running.progress).toContain("Build");
  expect(running.progress).not.toBe(t("kanban.progress.needs", { stage: "Verify" }));
  /* The settled reviewer attempt is also in what the card has finished, so its
     verdict line and its open button are there while the fix stage runs. */
  const past = pastAttempts([current()], new Map());
  expect(past.map((row) => [row.stageId, row.n, row.state, row.verdict])).toEqual([
    ["verify", 1, "needs_decision", "needs_decision"],
    ["build", 1, "passed", "pass"],
  ]);
  expect(past.find((row) => row.stageId === "verify")!.conversation)
    .toEqual({ path: "/codex/stage-2.jsonl", conversationId: "conversation_stage_2" });

  /* Same verdict with nothing to route: the pipeline parks and the card asks. */
  const parked = harness();
  await reachedVerify(parked, [stage("build", "verify"), stage("verify", null)]);
  await parked.report(2, { verdict: "needs_decision", findings: [{ severity: "P1", text: "only you can choose" }] });
  await tickPipelines([parked.endTurn(2, "Reviewed.")], parked.ports);

  const waiting = card();
  expect(current().state).toBe("needs_decision");
  expect(waiting.chips.find((chip) => chip.id === "verify")!.state).toBe("needs_decision");
  expect(waiting.progress).toBe(t("kanban.progress.needs", { stage: "Verify" }));
  /* The parked decision is the stage's current work, listed nowhere as past. */
  expect(pastAttempts([current()], new Map()).map((row) => [row.stageId, row.n, row.state]))
    .toEqual([["build", 1, "passed"]]);
});


const uncertainDelivery = "delivery was started by an earlier executor; whether it reached the recipient is unverified; the stage transcript exists, so the prompt may already have reached the agent and is not sent again";

test.each(["report", "fenced"] as const)("a delivered parked attempt accepts its %s verdict and takes the fail edge (#1979)", async (channel) => {
  const h = harness();
  const pathname = path.join(process.env.LLV_STATE_DIR!, `delivered-${channel}.jsonl`);
  const at = 2_000_000;
  fs.writeFileSync(pathname, JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type: "user_message", message: "Review this change" } }) + "\n");
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    await spawn(input, reserved);
    // The prompt reached the agent before this executor lost its acknowledgement.
    throw new Error(uncertainDelivery);
  };
  h.ports.transcriptPresent = (file) => fs.existsSync(file);
  h.ports.pathForConversation = (id) => id === "conversation_stage_1" ? pathname : null;
  h.ports.sourcePathAllowed = (file) => file === pathname || file.startsWith("/codex/");
  h.ports.durableTurnEvidence = (engine, file) => import("./durableEvidence").then((module) => module.durableStageTurnEvidence(engine, file));
  h.ports.spawnReceipt = (launchId) => ({ launchId, conversationId: "conversation_stage_1", state: "failed", sessionId: null, transcript: null, stagedTranscript: pathname, paneId: null, staged: true, error: uncertainDelivery });
  await started(h.ports, [stage("review", null, { access: "read-only", onFail: { to: "repair", maxRounds: 2 } }), stage("repair", null)]);
  expect(current().state).toBe("needs_decision");
  h.ports.spawnAgent = spawn;
  if (channel === "report") {
    const accepted = await h.report(1, { verdict: "fail", findings: [{ severity: "P1", text: "Delivery admission rejected the received prompt." }] });
    expect(accepted.error).toBeUndefined();
  }
  const verdict = '```json\n{"status":"fail","findings":["P1 — Delivery admission rejected the received prompt."],"confidence":0.95}\n```';
  fs.appendFileSync(pathname, [
    { timestamp: new Date(at + 1).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: verdict }] } },
    { timestamp: new Date(at + 2).toISOString(), type: "event_msg", payload: { type: "task_complete" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  await tickPipelines([], h.ports);
  expect(attemptsOf("review")).toHaveLength(1);
  expect(attemptsOf("review")[0]).toMatchObject({ state: "failed", verdict: { status: "fail" } });
  expect(current().cursor?.stageId).toBe("repair");
  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["review", "repair"]);
});


test.each(["metadata", "unknown", "older-turn", "other-decision", "closed", "superseded"] as const)("unverified delivery does not reopen a %s attempt (#1979)", async (shape) => {
  const h = harness();
  await started(h.ports, [stage("review", null)]);
  const parked = current();
  parked.state = shape === "closed" ? "closed" : "needs_decision";
  parked.stateDetail = uncertainDelivery;
  const attempt = parked.runs[0]!.attempts[0]!;
  Object.assign(attempt, { state: "needs_decision", error: shape === "other-decision" ? "Operator must select a requirement" : uncertainDelivery, paneId: null });
  if (shape === "closed") parked.cursor = null;
  if (shape === "superseded") parked.runs[0]!.attempts.push({ ...attempt, n: 2, conversationId: "conversation_replacement" });
  savePipelines([parked]);
  h.ports.durableTurnEvidence = async () => ({ turn: shape === "unknown" ? "unknown" : "busy", message: null, launchOnly: shape === "metadata", lastRecordAt: shape === "older-turn" ? 1 : 2_000_000 });
  expect((await h.report(1, { verdict: "pass" })).code).toBe("STAGE_REPORT_SETTLED");
  expect(attemptsOf("review")[0]!.report).toBeUndefined();
});

test("the PR a report looked up reaches the board's forge cache with no second forge call (#2059)", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  const lane = current();
  savePipelines([{ ...lane, delivery: { ...lane.delivery!, target: { ...lane.delivery!.target, remote: "https://github.com/acme/widgets.git" } } }]);
  h.worktree.pullRequest = '[{"url":"https://github.com/acme/widgets/pull/2059","number":2059,"state":"OPEN"}]';
  const before = h.execCalls.length;

  const accepted = await h.report(1, { verdict: "pass", summary: "Chips drawn." });
  expect(accepted.error).toBeUndefined();
  const { forgeCacheView } = await import("@/lib/forge/cache");
  const { pipelineWorkLinks } = await import("@/lib/forge/resolve");
  await settlePendingStageProvenance(h.ports);
  expect(forgeCacheView().repository("acme/widgets")?.pr(2059)).toMatchObject({ headRefName: current().branch, state: "open" });
  expect(pipelineWorkLinks(current()).links).toEqual([expect.objectContaining({ number: 2059, kind: "pr", state: "open" })]);
  /* The provenance read is the report's only forge call. */
  expect(h.execCalls.slice(before).filter((call) => call.includes("gh pr list"))).toHaveLength(1);
});

test("a parked lane writes a short status note and preserves a newer agent note", async () => {
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  for (const author of [null, { kind: "agent" as const, conversationId: "conversation_stage_1" }, { kind: "orchestrator" as const, conversationId: "conversation_manager" }, { kind: "operator" as const }]) {
    const h = harness();
    await started(h.ports, [stage("build", null)]);
    const pipeline = current();
    const id = "park-note-task";
    pipeline.taskIds = [id];
    savePipelines([pipeline]);
    const row: import("@/lib/tasks/types").BoardTask = { id, project: "viewer", text: "Choose the source", status: "assigned", placement: "unplaced", assignments: [], createdAt: pipeline.createdAt, updatedAt: pipeline.createdAt };
    const tasks = [row];
    if (author) row.note = { text: "Waiting for the operator to choose a source.", author, updatedAt: new Date(Date.parse(attemptsOf("build")[0]!.startedAt!) + 1_000).toISOString() };
    saveTasks(tasks);
    await h.report(1, { verdict: "needs_decision", summary: "Choose the source." });
    await tickPipelines([h.endTurn(1, "Waiting.")], h.ports);
    expect(current().state).toBe("needs_decision");
    const note = loadTasks().find(task => task.id === id)!.note;
    expect(note).toBeDefined();
    if (author) expect(note).toEqual(row.note);
    else {
      expect(note!.author).toEqual({ kind: "orchestrator" });
      expect(note!.text.length).toBeLessThanOrEqual(280);
      expect(note!.text).not.toContain("needs_decision");
      expect(note!.text).not.toContain("\n");
    }
  }
});

test("a stage parked before spawn replaces the preceding stage note, while newer notes still win", async () => {
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  const h = harness();
  await started(h.ports, [stage("build", "verify"), stage("verify", null)]);
  const pipeline = current();
  pipeline.taskIds = ["park-note-task"];
  savePipelines([pipeline]);
  const oldNoteAt = new Date(Date.parse(pipeline.createdAt) - 1_000).toISOString();
  saveTasks([{
    id: "park-note-task", project: "viewer", text: "Complete the change", status: "assigned", placement: "unplaced", assignments: [],
    createdAt: pipeline.createdAt, updatedAt: pipeline.createdAt,
    note: { text: "The builder is running.", author: agent("conversation_stage_1"), updatedAt: oldNoteAt },
  }]);

  await h.report(1, { verdict: "pass", summary: "Build passed." });
  h.ports.engineReadiness = () => "signed-out";
  await tickPipelines([h.endTurn(1, "Build passed.")], h.ports);
  await tickPipelines([], h.ports);

  expect(current().state).toBe("needs_decision");
  expect(attemptsOf("verify")[0]!.startedAt).toBeNull();
  const { parkedTaskNote } = await import("./taskStatusNote");
  const { operatorLocale } = await import("@/lib/operator/settings");
  expect(loadTasks()[0]!.note?.text).toBe(parkedTaskNote(
    current().stateDetail ?? "",
    operatorLocale() ?? "uk",
    false,
    { kind: "signed-out", engine: "codex" },
  ));
  expect(loadTasks()[0]!.note?.text).not.toBe("The builder is running.");

  const { writeParkedTaskNote } = await import("./taskStatusNote");
  const stillNewer = {
    text: "The operator is choosing an account now.",
    author: agent("conversation_current"),
    updatedAt: new Date().toISOString(),
  };
  saveTasks([{ ...loadTasks()[0]!, note: stillNewer }]);
  await new Promise(resolve => setTimeout(resolve, 10));
  writeParkedTaskNote(current(), "signed out", attemptsOf("verify")[0]);
  expect(loadTasks()[0]!.note).toEqual(stillNewer);
});

test.each(["agent", "orchestrator", "operator"] as const)("a current %s note survives the next stage's signed-out pre-spawn park", async writer => {
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  const h = harness();
  await started(h.ports, [stage("build", "verify"), stage("verify", null)]);
  const pipeline = current();
  pipeline.taskIds = ["park-note-task"];
  savePipelines([pipeline]);
  saveTasks([{
    id: "park-note-task", project: "viewer", text: "Complete the change", status: "assigned", placement: "unplaced", assignments: [],
    createdAt: pipeline.createdAt, updatedAt: pipeline.createdAt,
  }]);
  await h.report(1, { verdict: "pass", summary: "Build passed." });
  await tickPipelines([h.endTurn(1, "Build passed.")], h.ports);

  const currentNote = {
    text: "Waiting for the operator to choose a source.",
    author: writer === "agent"
      ? agent("conversation_current")
      : writer === "orchestrator"
        ? { kind: "orchestrator" as const, conversationId: "conversation_manager" }
        : { kind: "operator" as const },
    updatedAt: new Date().toISOString(),
  };
  saveTasks([{ ...loadTasks()[0]!, note: currentNote }]);
  await new Promise(resolve => setTimeout(resolve, 10));
  h.ports.engineReadiness = () => "signed-out";
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  expect(current().state).toBe("needs_decision");
  expect(loadTasks()[0]!.note).toEqual(currentNote);
});

test("retrying a signed-out park clears its automatic note through running and completion", async () => {
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  const h = harness();
  await started(h.ports, [stage("build", "verify"), stage("verify", null)]);
  const pipeline = current();
  pipeline.taskIds = ["park-note-task"];
  savePipelines([pipeline]);
  saveTasks([{
    id: "park-note-task", project: "viewer", text: "Complete the change", status: "assigned", placement: "unplaced", assignments: [],
    createdAt: pipeline.createdAt, updatedAt: pipeline.createdAt,
  }]);

  await h.report(1, { verdict: "pass", summary: "Build passed." });
  await tickPipelines([h.endTurn(1, "Build passed.")], h.ports);
  h.ports.engineReadiness = () => "signed-out";
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(current().state).toBe("needs_decision");
  expect(loadTasks()[0]!.note?.text).toMatch(/account is connected|під’єднано обліковий запис/i);

  h.ports.engineReadiness = () => "connected";
  const retried = await patchPipeline(current().id, { action: "retry-stage" }, h.ports);
  expect(retried.error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(current().state).toBe("running");
  expect(attemptsOf("verify").at(-1)!.state).toBe("running");
  expect(loadTasks()[0]!.note).toBeUndefined();

  const currentNote = {
    text: "The verify stage is running against the selected account.",
    author: { kind: "operator" as const },
    updatedAt: new Date().toISOString(),
  };
  saveTasks([{ ...loadTasks()[0]!, note: currentNote }]);
  await h.report(2, { verdict: "pass", summary: "Verification passed." });
  await tickPipelines([h.endTurn(2, "Verification passed.")], h.ports);
  expect(current().state).toBe("completed");
  expect(loadTasks()[0]!.note).toEqual(currentNote);
});

test("automatic notes explain signed-out and quota-reset parks in both languages without diagnostics", async () => {
  const { parkedTaskNote } = await import("./taskStatusNote");
  expect(parkedTaskNote("Stage \"verify\" runs on Codex, and no Codex account is signed in", "en", false, { kind: "signed-out", engine: "codex" }))
    .toBe("No Codex account is connected. Connect one to continue.");
  expect(parkedTaskNote("Stage \"verify\" runs on Codex, and no Codex account is signed in", "uk", false, { kind: "signed-out", engine: "codex" }))
    .toBe("Для Codex не під’єднано обліковий запис. Під’єднайте його, щоб продовжити.");
  for (const locale of ["en", "uk"] as const) {
    const note = parkedTaskNote("rate limited until 2026-10-02T12:00:00.000Z, account fixture-private", locale, true, { kind: "quota-reset" });
    expect(note).toMatch(/limit|ліміт/i);
    expect(note).not.toContain("fixture-private");
    expect(note).not.toContain("2026-10-02");
  }
});

test("publication blocked, a failed stage and a spent budget each leave a plain current note", async () => {
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  const { parkedTaskNote } = await import("./taskStatusNote");
  const attach = () => {
    const pipeline = current();
    pipeline.taskIds = ["park-note-task"];
    savePipelines([pipeline]);
    saveTasks([{ id: "park-note-task", project: "viewer", text: "Complete the change", status: "assigned", placement: "unplaced", assignments: [], createdAt: pipeline.createdAt, updatedAt: pipeline.createdAt }]);
  };
  const h = harness();
  h.worktree.remote = "";
  await started(h.ports, [stage("build", null)], "remote-branch");
  attach();
  await h.report(1, { verdict: "pass", summary: "Checked." });
  await tickPipelines([h.endTurn(1, "Done.")], h.ports);
  await tickPipelines([], h.ports);
  expect(current().stateDetail).toContain("unavailable");
  expect(loadTasks()[0]!.note?.text).toBe(parkedTaskNote("publication blocked", "uk"));
  const f = harness();
  await started(f.ports, [stage("build", null)]);
  attach();
  await f.report(1, { verdict: "fail", findings: [{ severity: "P2", text: "The card loses its title." }] });
  await tickPipelines([f.endTurn(1, "Failed.")], f.ports);
  expect(loadTasks()[0]!.note?.text).toBe(parkedTaskNote("stage verdict: fail", "uk"));
  const b = harness();
  await reachedVerify(b, [stage("build", "verify"), stage("verify", null, { onFail: { to: "build", maxRounds: 1, onExhausted: "park" } })]);
  attach();
  await b.report(2, { verdict: "fail" });
  await tickPipelines([b.endTurn(2, "Failed." )], b.ports);
  await tickPipelines([], b.ports);
  await b.report(3, { verdict: "pass" });
  await tickPipelines([b.endTurn(3, "Fixed." )], b.ports);
  await tickPipelines([], b.ports);
  await b.report(4, { verdict: "fail" });
  await tickPipelines([b.endTurn(4, "Still failing." )], b.ports);
  expect(current().stateDetail).toContain("budget");
  expect(loadTasks()[0]!.note?.text).toBe(parkedTaskNote("budget spent", "uk"));
});

test("an older agent note is replaced on park, in the operator's chosen language, and a clear survives idle ticks", async () => {
  const { loadTasks, saveTasks, mutateTasks } = await import("@/lib/tasks/store");
  const { patchTask } = await import("@/lib/tasks/commands");
  const { updateOperatorSettings } = await import("@/lib/operator/settings");
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  const pipeline = current();
  pipeline.taskIds = ["park-note-task"];
  savePipelines([pipeline]);
  const before = new Date(Date.parse(attemptsOf("build")[0]!.startedAt!) - 1_000).toISOString();
  saveTasks([{ id: "park-note-task", project: "viewer", text: "Complete the change", status: "assigned", placement: "unplaced", assignments: [], createdAt: pipeline.createdAt, updatedAt: pipeline.createdAt,
    note: { text: "The build is running.", author: { kind: "agent", conversationId: "conversation_earlier" }, updatedAt: before },
  }]);
  updateOperatorSettings({ locale: "en" });
  try {
    await h.report(1, { verdict: "needs_decision" });
    await tickPipelines([h.endTurn(1, "Waiting." )], h.ports);
    expect(loadTasks()[0]!.note).toMatchObject({ text: "Waiting for your decision before work can continue.", author: { kind: "orchestrator" } });
    mutateTasks(tasks => {
      const cleared = patchTask(tasks, "park-note-task", { note: null });
      if (!cleared.ok) throw new Error(cleared.error);
      return { tasks: cleared.tasks, result: undefined };
    });
    await tickPipelines([], h.ports);
    expect(loadTasks()[0]!.note).toBeUndefined();
  } finally { updateOperatorSettings({ locale: "uk" }); }
});
