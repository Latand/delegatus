import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

/* Graph slice 2 (#1730): a stage attempt reports its own completion through one
   MCP call. Every port is a mock and the state directory is private to this
   file, so nothing here reaches a host, an account or the operator's registry. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-completion-"));
const { createPipelineFromRequest, reportStageCompletion, tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines } = await import("./store");
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
    ports, worktree, spawnedStages, endTurn, report, execCalls,
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
    provenance: {
      head: HEAD,
      uncommitted: [],
      pullRequest: { url: "https://forge.example/repo/pull/1730", number: 1730, state: "OPEN" },
      outputs: [],
    },
  });
  expect(accepted.report!.provenance.branch).toBe(current().branch);

  /* The call is an intent, not the close: nothing settles while the turn runs. */
  await tickPipelines([], h.ports);
  expect(attemptsOf("build")[0]!.state).toBe("running");
  expect(attemptsOf("build")[0]!.verdict).toBeNull();

  /* The turn ends with ordinary prose and no fenced verdict at all. */
  await tickPipelines([h.endTurn(1, "Done. Handing over to verification.")], h.ports);
  const settled = attemptsOf("build")[0]!;
  expect(settled.state).toBe("passed");
  expect(settled.verdict).toEqual({ status: "pass" });
  expect(settled.output).toBe("Bound the report to the attempt.");
  expect(current().cursor?.stageId).toBe("verify");

  await tickPipelines([], h.ports);
  expect(h.spawnedStages).toEqual(["build", "verify"]);
  /* The second stage's declared outputs are read for ITS report, not the first's. */
  const verify = await h.report(2, { verdict: "pass", summary: "Checked." });
  expect(verify.report!.provenance.outputs).toEqual([{ path: "docs/report.html", present: true }]);
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
  expect(accepted.report!.provenance).toMatchObject({ uncommitted: ["src/lib/x.ts"], pullRequest: null });
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

  /* The accepted call reads the worktree and then the forge, bounded. */
  expect((await h.report(1, { verdict: "pass" })).error).toBeUndefined();
  expect(h.execCalls).toEqual([
    "git status --porcelain",
    "git rev-parse HEAD",
    `timeout --signal=KILL 10s gh pr list --head ${current().branch} --state all --limit 1 --json url,number,state`,
  ]);
});

test("an attempt that moved on while its provenance was read is refused, and keeps the record it had", async () => {
  const h = harness();
  await started(h.ports, [stage("build", null)]);
  /* The window the two reads open: between them, this stage's live attempt
     becomes a different one under the same conversation. */
  h.raceDuringProvenance(() => {
    const records = loadPipelines();
    const attempts = records[0]!.runs[0]!.attempts;
    attempts[0]!.state = "failed";
    attempts.push({ ...structuredClone(attempts[0]!), n: 2, state: "running", report: null } as never);
    savePipelines(records);
  });

  const refused = await h.report(1, { verdict: "pass", summary: "Reported against attempt 1." });
  expect(refused).toMatchObject({ code: "STAGE_REPORT_CHANGED", status: 409 });
  expect(refused.slots).toEqual([{ pipelineId: current().id, stageId: "build", attempt: 2, state: "running" }]);
  expect(attemptsOf("build").map((attempt) => attempt.report ?? null)).toEqual([null, null]);
  expect(current().stageReports).toBeUndefined();

  /* Reported again, the call lands on the attempt that is actually live. */
  const accepted = await h.report(1, { verdict: "pass", summary: "Reported against attempt 2." });
  expect(accepted).toMatchObject({ attempt: 2, replaced: false });
  expect(attemptsOf("build")[1]!.report).toMatchObject({ summary: "Reported against attempt 2." });
});
