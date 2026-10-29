import { stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { afterAll, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Database } from "bun:sqlite";

import type { CreateFlowRequest, Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { laneMovedAt } from "@/lib/pipelines/laneMovement";
import { activeDrain, DRAIN_LEASE_MS } from "@/lib/selfUpdate/drain";
import { initialAuto, writeAuto } from "@/lib/selfUpdate/auto";
import { initialCheck } from "@/lib/selfUpdate/checkState";
import { SelfUpdateService, type ServiceDeps } from "@/lib/selfUpdate/service";
import { idleCheck, idleUpdate, stoppedProcess, type Snapshot } from "@/lib/selfUpdate/types";
import { endRestartGate, restartGateFile } from "@/lib/selfUpdate/restartGate";
import type { LauncherRecord } from "@/lib/selfUpdate/launcher";
import type { AgentRegistry as AgentRegistryType } from "@/lib/agent/registry";
import { ACCOUNT_STORE_BUSY_MESSAGE, AccountMutationBusyError } from "@/lib/accounts/accountMutation";
import { accountManager, AccountAuthenticationRequiredError, ProjectAccountRefusedError } from "@/lib/accounts/manager";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { CONTROLLER_ARTIFACT_GIT_PATHS } from "./controllerArtifacts";
import { realExec } from "@/lib/workflows/provision";
import { worktreeDiskWait } from "@/lib/state/diskPressure";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { repositoryPublicationSource } from "@/lib/git/repositoryCommitIdentity";
import { prepareStageGitGuard } from "@/lib/git/stageAttemptGuard";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-engine-"));
const engineModule = await import("./engine");
// Native Git and reserved-host fixtures model their forge separately;
// PR delivery regressions use a GitHub target and execute the real helper.
const pullRequestModule = await import("./stagePullRequest");
const realEnsureStagePullRequest = pullRequestModule.ensureStagePullRequest;
const fixturePullRequests = spyOn(pullRequestModule, "ensureStagePullRequest").mockImplementation(async (pipeline, attempt, exec, acceptedHead, timing) => {
  if (pipeline.delivery && /^(?:\/|file:|git@example\.invalid:)/.test(pipeline.delivery.target.remote)) {
    pipeline.delivery.target.pr ??= 17;
    return { ok: true };
  }
  return realEnsureStagePullRequest(pipeline, attempt, exec, acceptedHead, timing);
});
afterAll(() => fixturePullRequests.mockRestore());
const { IDLE_TURN_QUIET_MS, interruptedTurnRecoveryParkDetail } = engineModule;
const { adoptAttempt, defaultPipelinePorts, ensureTaskPipelineForAssignment, patchPipeline: rawPatchPipeline, pipelineAttemptTargetForSource, pipelineClaudePermissionMode, reconcileEmbeddedReviewFlows, reviewNote, setPipelineDismissal, terminalFlowStageVerdict, tickPipelines } = engineModule;
const { verdictRoutesAsFail } = await import("./verdict");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { newRound, setRelayDeliveryForTest, tickFlow } = await import("@/lib/flows/engine");
const { saveFlows } = await import("@/lib/flows/store");
const { isRecoverableLegacyRelayFailurePause, MAX_FLOW_NOTE_LENGTH } = await import("@/lib/flows/commands");
const rawCreatePipelineFromRequest = engineModule.createPipelineFromRequest;
const createPipelineFromRequest: typeof rawCreatePipelineFromRequest = async (request, ports, options) =>
  await rawCreatePipelineFromRequest({ src: "/codex/creator.jsonl", ...request }, ports, options);
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines, pipelineIdentity, pipelineRevision } = await import("./store");
const { durableStageTurnEvidence } = await import("./durableEvidence");
const { projectPipelineEvents } = await import("@/lib/lifecycle/projector");
const { edgeRoundsUsed, FAIL_EDGE_BUDGET_SPENT_DETAIL, failEdgeMaxRounds, failEdgeRoundsUsed, pipelineCompletedUnreviewed } = await import("./failEdgeBudget");
const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
const { asStoredLegacyReviewLane } = await import("./fixtures/legacyReviewLane");
const { interruptionObligationDirectory, interruptionObligationStore } = await import("@/lib/runtime/interruptionObligations");
type PipelinePorts = import("./engine").PipelinePorts;
type Pipeline = import("./types").Pipeline;
type PipelineStageStopResult = import("./engine").PipelineStageStopResult;
type StageTurnEvidence = import("./durableEvidence").StageTurnEvidence;
type HostState = import("@/lib/runtime/engineHost").HostState;

/* tickPipelines self-schedules a follow-up tick when a pass leaves a pending
   cursor; keep that wake-up away from the real default ports in this suite. */
registerPipelineTick(async () => {});

afterAll(async () => {
  await (await import("@/lib/links/taskPageWorker")).shutdownTaskPageWorker();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

/** These state-machine assertions wait for remote settlement. Immediate
    acceptance and concurrent reads are covered by remoteActions.test.ts. */
const patchPipeline: typeof rawPatchPipeline = async (id, request, ports = defaultPipelinePorts(), actor) => {
  const accepted = await rawPatchPipeline(id, request, ports, actor);
  if (accepted.error || !accepted.pipeline) return accepted;
  if (accepted.pipeline.remoteAction?.state === "pending") await engineModule.settlePendingRemoteActions(ports);
  let current = loadPipelines().find((pipeline) => pipeline.id === id) ?? accepted.pipeline;
  if (current.remoteAction?.state === "settled" && current.remoteAction.error
    && (request.action === "retry-stage" || request.action === "takeover" || request.action === "skip-stage")) return { error: current.remoteAction.error, status: 409 };
  if ((request.action === "publish" || request.action === "retry-stage") && current.delivery?.operation?.state === "pending") {
    const { publishPipelineBranch } = await import("./git");
    const result = await publishPipelineBranch(current, ports.exec, { acceptedSha: current.delivery.operation.sha });
    if (!result.ok) return { error: result.error, status: 409 };
    if (result.remote === "unreachable") return { error: result.detail, status: 409 };
    current = loadPipelines().find((pipeline) => pipeline.id === id) ?? current;
  }
  return { ...accepted, pipeline: current };
};

/** Lifecycle assertions read the durable result after the controller drains. */
async function closeAndDrain(id: string, req: Parameters<typeof patchPipeline>[1], ports: PipelinePorts) {
  const accepted = await patchPipeline(id, req, ports);
  if (accepted.error) return accepted;
  await engineModule.drainStageActivations(ports);
  const pipeline = loadPipelines().find((item) => item.id === id)!;
  return { ...accepted, pipeline, close: pipeline.closeReport ?? accepted.close };
}

const RUN_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "architect" }, access: "read-only", prompt: "Plan {{task}}", next: "build" },
  { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build from {{prev.output}}", next: null },
] as const;
const ORIGIN_MAIN_SHA = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

function harness() {
  const calls: string[] = [];
  const spawnRoles: Array<Parameters<PipelinePorts["spawnAgent"]>[0]["role"]> = [];
  const spawnInputs: Array<Parameters<PipelinePorts["spawnAgent"]>[0]> = [];
  const spawnTitles: string[] = [];
  const messages = new Map<string, { text: string; ts: number }>();
  const durableTurns = new Map<string, StageTurnEvidence>();
  const flows = new Map<string, Flow>();
  const flowRequests: CreateFlowRequest[] = [];
  let spawn = 0;
  let clock = 1_000_000;
  let builderEffort = "medium";
  let paneAlive = true;
  let conversationActive: boolean | null = null;
  /* Stage hosts are "not running" unless a test seats one; nothing in this
     suite may reach a real host or the operator's registry. */
  const stageHosts = new Map<string, PipelineStageStopResult>();
  /* Panes the harness considers killable, and the clock the teardown budget
     reads. Both default to the benign case so existing tests are unaffected. */
  const killedPanes: string[] = [];
  let paneStop: Awaited<ReturnType<PipelinePorts["stopStagePane"]>> = { outcome: "stopped" };
  let worktreePresent = true;
  let residentHosts = false;
  let monotonic: () => number = () => Date.now();
  const stageCommitMessages = new Map<string, string>();
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs, cwd, env, options) => {
      // Artifact safety reads inspect the actual fixture index, including
      // plain launch directories that have no Git metadata.
      if (options?.stdoutEncoding === "latin1") return realExec(rawCommand, rawArgs, cwd, env, options);
      calls.push(`${rawCommand} ${rawArgs.join(" ")}`);
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      // Virtual worktree heads stand for commits produced by the fake agent.
      // Real-worktree fixtures replace this port with actual Git.
      if (args[0] === "rev-list" && args.includes("--max-count=128")) {
        const [anchor, target] = args.at(-1)!.split("..");
        return { code: 0, stdout: target && target !== anchor ? `${target}\n` : "", stderr: "" };
      }
      if (args[0] === "reflog") {
        const pipeline = loadPipelines().find(p => p.worktreeDir === cwd) ?? loadPipelines()[0];
        const attempt = pipeline?.runs.find(run => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1);
        const stamp = Math.floor(Date.parse(attempt?.startedAt ?? new Date(clock).toISOString()) / 1000);
        return Promise.resolve(ports.exec("git", ["rev-parse", "HEAD"], cwd)).then(head => ({ code: 0,
          stdout: `${head.stdout.trim()}\0HEAD@{${stamp}}\0commit: stage work\n`, stderr: "" }));
      }
      if (args[0] === "log" && args.includes("--no-walk")) {
        const identity = agentPublicationIdentityEnv(process.env);
        return { code: 0, stdout: args.slice(args.indexOf("--no-walk") + 1)
          .filter(sha => /^[0-9a-f]{40}$/.test(sha))
          .map(sha => `${sha}\0${identity.GIT_AUTHOR_NAME}\0${identity.GIT_AUTHOR_EMAIL}\0${identity.GIT_COMMITTER_NAME}\0${identity.GIT_COMMITTER_EMAIL}`)
          .join("\n") + "\n", stderr: "" };
      }
      if (args[0] === "write-tree") return { code: 0, stdout: `${"8".repeat(40)}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: `refs/heads/${loadPipelines()[0]?.branch ?? "pipeline/test"}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--git-path")) return { code: 0, stdout: `${path.join(cwd, ".git", "index")}\n`, stderr: "" };
      if (args[0] === "commit") {
        stageCommitMessages.set(cwd, args.filter((_, index) => args[index - 1] === "-m").join("\n\n"));
      }
      if (args[0] === "show" && args.includes("--format=%P%x00%T%x00%B")) return {
        code: 0, stdout: `${ORIGIN_MAIN_SHA}\0${"8".repeat(40)}\0${stageCommitMessages.get(cwd) ?? ""}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      /* Review ingress requires a publishable remote, so the default repo has
         one. A test that needs the no-origin case overrides this. */
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
      if (args.length === 1 && args[0] === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
      // Model the command-line-only remote used to validate a stored URL.
      if (args[0] === "-c" && args[2] === "remote" && args[3] === "-v") {
        const probe = /^remote\.([^=]+)\.url=(.*)$/.exec(args[1]!);
        if (probe) return { code: 0, stdout: `${probe[1]}\t${probe[2]} (fetch)\n${probe[1]}\t${probe[2]} (push)\n`, stderr: "" };
      }
      if (args[0] === "ls-remote") {
        const branch = loadPipelines()[0]?.branch ?? "pipeline/test";
        return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\trefs/heads/${branch}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({
      ok: true,
      repoDir,
      gitCommonDir: path.join(repoDir, ".git"),
      worktreeParent: path.dirname(repoDir),
    }),
    roleLookup: (roleId) => {
      if (roleId === "builder") return { engine: "codex", model: "gpt-5.6-sol", effort: builderEffort, access: "read-write", promptScaffold: "Builder guidance" };
      if (roleId === "reviewer") return { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: "Reviewer guidance" };
      if (roleId === "architect") return { engine: "claude", model: "fable", effort: "high", access: "read-only", promptScaffold: "Architect guidance" };
      return null;
    },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    spawnAgent: async (input, onReserved) => {
      const { role, title, parentPath, clientAttemptId, membership, supersedes } = input;
      const accountId = input.requestedAccountId ?? (input.unavailableAccountIds?.includes(LIMITED_ACCOUNT) ? SPARE_ACCOUNT : LIMITED_ACCOUNT);
      spawn += 1;
      spawnInputs.push(structuredClone(input));
      spawnRoles.push(structuredClone(role));
      spawnTitles.push(title);
      calls.push(`spawn:${clientAttemptId}:parent=${parentPath ?? "root"}:supersedes=${supersedes ?? "none"}`);
      calls.push(`membership:${membership.kind}:${membership.containerId}:${membership.slot}:${membership.role}:${membership.stageOrder}:round=${membership.round}`);
      await onReserved({ launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}`, accountId });
      return { launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}`, sessionId: `session-${spawn}`, transcript: `/codex/stage-${spawn}.jsonl`, paneId: `%${spawn}`, accountId };
    },
    paneAgentAlive: async () => paneAlive,
    stopStageAgent: async (target) => {
      calls.push(`stop-host:${target.stageId}:${target.attempt}:${target.conversationId ?? "none"}`);
      return stageHosts.get(target.conversationId ?? "") ?? { outcome: "not-running" };
    },
    stopStagePane: async (target) => {
      calls.push(`stop-pane:${target.stageId}:${target.attempt}:${target.paneId ?? "none"}`);
      if (paneStop.outcome === "stopped" && target.paneId) {
        killedPanes.push(target.paneId);
        paneAlive = false;
      }
      return paneStop;
    },
    stageHostResident: async (target) => {
      calls.push(`host-resident:${target.stageId}:${target.attempt}`);
      return residentHosts;
    },
    monotonicNow: () => monotonic(),
    worktreePresent: () => worktreePresent,
    conversationAgentActive: async () => conversationActive,
    durableTurnEvidence: async (_engine, transcriptPath) => durableTurns.get(transcriptPath) ?? null,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => id === "conversation_stage_1" ? "/codex/stage-1.jsonl" : id === "conversation_stage_2" ? "/codex/stage-2.jsonl" : null,
    sourcePathAllowed: (pathname) => pathname.startsWith("/codex/") && pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => pathname === "/codex/creator.jsonl"
      ? "conversation_creator"
      : pathname.includes("stage-1") ? "conversation_stage_1" : pathname.includes("stage-2") ? "conversation_stage_2" : null,
    pipelineAdoptionCandidates: () => [],
    createFlow: async (req, _entries, _preparedGit, assertAuthorized) => {
      assertAuthorized?.();
      flowRequests.push(structuredClone(req));
      calls.push(`flow:${req.implementerPath}:${req.baseRef}:${req.targetSha}:${req.spec}`);
      const flow = { id: `flow-${flows.size + 1}`, implementerPath: req.implementerPath, baseRef: req.baseRef, headRef: req.headRef, targetSha: req.targetSha, state: "waiting_ready", rounds: [], createdAt: new Date(clock).toISOString(), closedAt: null } as unknown as Flow;
      flows.set(flow.id, flow);
      return { flow };
    },
    patchFlow: (id, action, note) => {
      calls.push(`flow-patch:${id}:${action}`);
      if (note) calls.push(`flow-note:${note}`);
      const flow = flows.get(id);
      if (flow && action === "retry-round") {
        if (flow.state !== "needs_decision") return { error: "flow cannot retry from its current state", status: 409 };
        const round = flow.rounds.at(-1);
        if (round) Object.assign(round, { spawnStartedAt: null, launchId: null, reviewerPath: null, sessionId: null, error: null, terminalAt: null });
        flow.state = "spawning";
        flow.stateDetail = null;
      }
      if (flow && action === "resume" && flow.state === "paused") {
        const round = flow.rounds.at(-1);
        if (round && isRecoverableLegacyRelayFailurePause(flow)) {
          round.relayStartedAt = null;
          round.relayDeliveryTransport = null;
          round.relayRetryAt = null;
          round.relayRetryRequiresIdempotency = false;
        }
        flow.state = flow.pausedState && flow.pausedState !== "paused" ? flow.pausedState : "waiting_ready";
        flow.pausedState = null;
        flow.stateDetail = null;
      }
      return {};
    },
    closeFlow: async (id) => {
      calls.push(`flow-close:${id}`);
      const flow = flows.get(id);
      if (flow) flow.state = "closed";
      return { flow };
    },
    getFlow: (id) => flows.get(id) ?? null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  const finish = (pathname: string, status: "pass" | "fail" | "needs_decision", output = "done") => {
    messages.set(pathname, { text: `${output}\n\n\`\`\`json\n${JSON.stringify({ status })}\n\`\`\``, ts: clock + 100_000 });
    return entry(pathname);
  };
  return {
    ports,
    calls,
    messages,
    durableTurns,
    flows,
    flowRequests,
    spawnInputs,
    spawnRoles,
    spawnTitles,
    finish,
    setBuilderEffort: (effort: string) => { builderEffort = effort; },
    setPaneAlive: (alive: boolean) => { paneAlive = alive; },
    setStageHost: (conversationId: string, result: PipelineStageStopResult) => { stageHosts.set(conversationId, result); },
    setPaneStop: (result: Awaited<ReturnType<PipelinePorts["stopStagePane"]>>) => { paneStop = result; },
    setWorktreePresent: (present: boolean) => { worktreePresent = present; },
    setHostsResident: (resident: boolean) => { residentHosts = resident; },
    setMonotonicClock: (clock: () => number) => { monotonic = clock; },
    advanceWallClock: (milliseconds: number) => { clock += milliseconds; },
    killedPanes,
    setConversationActive: (active: boolean | null) => { conversationActive = active; },
  };
}

/** Publication is opt-in (#1692): the tests of the remote-branch contract ask for it. */
const REMOTE_BRANCH = { publication: "remote-branch" } as const;

/** A reported completion settles after the canonical turn has finished. */
function finishReported(h: ReturnType<typeof harness>, pathname: string, verdict: "pass" | "fail", text: string) {
  const finished = h.finish(pathname, verdict, text);
  h.durableTurns.set(pathname, { turn: "terminal", message: h.messages.get(pathname)! });
  return finished;
}

async function realWorktreeLane(name: string, stages: unknown[], publication?: "remote-branch", legacyReview = false, defaultOwner = false, brief: { task?: string; spec?: string } = {}) {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${name}-`));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const { realExec } = await import("@/lib/workflows/provision");
  const { realProvisionExec } = await import("./git");
  const h = harness();
  // Upstream writers use a fixed machine identity. Dispatched agents below
  // bind the repository identity through the production launch helper.
  const { GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL } = agentPublicationIdentityEnv(process.env);
  const identity = { GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL };
  let agentEnv: Record<string, string | undefined> = identity;
  let agentWorktree: string | undefined;
  // Model native dispatch: each reservation gets its own starting head and
  // generated hooks, including successor stages in the same worktree.
  const spawnAgent = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    const launchId = `native-${input.clientAttemptId}`;
    const spawned = await spawnAgent(input, async reservation => {
      await onReserved({ ...reservation, launchId });
      const guard = await prepareStageGitGuard(launchId, input.cwd, realExec, h.ports.now(), () => onReserved({ ...reservation, launchId }));
      const source = await repositoryPublicationSource(input.cwd, { ...process.env, ...guard }, realExec);
      agentEnv = { ...guard, ...agentPublicationIdentityEnv(source) };
      agentWorktree = input.cwd;
    });
    return { ...spawned, launchId };
  };
  // Agent Git commands and the controller share one deterministic clock.
  const git = async (cwd: string, ...args: string[]) => {
    const date = ["commit", "merge", "rebase", "am"].includes(args[0]!) ? h.ports.now() : undefined;
    // Upstream writers and deliberate custody bypasses are fixture controls;
    // only commands in the dispatched lane inherit its receipt bindings.
    const result = (await realExec("git", args, cwd, { ...(cwd === agentWorktree ? agentEnv : identity),
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  fs.mkdirSync(repo);
  (await git(root, "init", "--bare", "--initial-branch=main", origin));
  fs.mkdirSync(path.join(origin, "hooks"), { recursive: true });
  (await git(repo, "init", "--initial-branch=main"));
  (await git(repo, "config", "user.name", "Fixture"));
  (await git(repo, "config", "user.email", "noreply@example.com"));
  (await git(repo, "config", "commit.gpgSign", "false"));
  fs.writeFileSync(path.join(repo, ".gitignore"), "sentinel.tmp\n");
  (await git(repo, "add", ".gitignore"));
  (await git(repo, "commit", "-m", "base"));
  (await git(repo, "remote", "add", "origin", origin));
  (await git(repo, "push", "origin", "main"));
  const base = (await git(repo, "rev-parse", "HEAD"));
  h.ports.exec = realExec;
  h.ports.provisionExec = realProvisionExec;
  const created = await createPipelineFromRequest({ task: name, ...brief, repoDir: repo, baseRef: base, stages: stages as never,
    ...(publication ? { publication } : defaultOwner ? {} : { publication: "internal" as const }) }, h.ports);
  if (!created.pipeline) throw new Error(created.error);
  if (legacyReview) savePipelines([asStoredLegacyReviewLane(created.pipeline, created.convertedStages)]);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  return { root, origin, repo, base, h, git, id: created.pipeline.id, worktree: created.pipeline.worktreeDir };
}

/** A successor lane created on an existing pull request branch: the branch is
    the previous lane's own pipeline branch, the successor's delivery claim
    (epoch 2) targets it, and the stage agent commits straight onto it. */
async function successorOnPullRequestBranch(name: string, previousState: Pipeline["state"]) {
  const fixture = await realWorktreeLane(name, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ], "remote-branch");
  const { git, repo, worktree } = fixture;
  const lane = loadPipelines().find((item) => item.id === fixture.id)!;
  const previous = structuredClone(lane);
  previous.id = "previouslane";
  previous.worktreeDir = path.join(path.dirname(repo), `${path.basename(repo)}-pipeline-${previous.id}`);
  previous.branch = lane.branch.slice(0, -lane.id.length) + previous.id;
  const prBranch = previous.branch;
  (await git(worktree, "branch", "-m", prBranch));
  lane.delivery!.target.branch = `refs/heads/${prBranch}`;
  lane.delivery!.epoch = 2;
  previous.state = previousState;
  previous.cursor = previousState === "completed" || previousState === "closed" ? null : previous.cursor;
  previous.closedAt = previousState === "closed" ? new Date().toISOString() : null;
  previous.delivery = { ...structuredClone(lane.delivery!), ownerId: previous.id, epoch: 1,
    active: false, publish: "disabled", releasedAt: new Date().toISOString() };
  savePipelines([lane, previous]);
  fs.writeFileSync(path.join(worktree, "build.txt"), "successor work\n");
  (await git(worktree, "add", "build.txt"));
  (await git(worktree, "commit", "-m", "successor stage work"));
  return { ...fixture, lane, previous, prBranch, head: (await git(worktree, "rev-parse", "HEAD")) };
}

/** A review-loop stage in these fixtures stands for a lane stored before
    #2187 converted new ones at creation: that lane still reviews through its
    embedded flow, which is what those tests exercise, so it is stored as the
    older engine stored it. */
async function create(ports: PipelinePorts, stages = RUN_STAGES as never, request: { publication?: "internal" | "remote-branch"; repoDir?: string } = {}) {
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Ship pipelines", spec: "AC1", repoDir: request.repoDir ?? "/repo", stages, src: "/codex/creator.jsonl", publication: "internal", ...request }, ports);
  if (!result.pipeline) throw new Error(result.error);
  if (!result.convertedStages?.length) return result.pipeline;
  const lane = asStoredLegacyReviewLane(result.pipeline, result.convertedStages);
  savePipelines([lane]);
  return lane;
}

async function exhaustVerdictRecovery(h: ReturnType<typeof harness>, entries: FileEntry[] = []): Promise<void> {
  h.advanceWallClock(30_000);
  await tickPipelines(entries, h.ports);
  h.advanceWallClock(30_000);
  await tickPipelines(entries, h.ports);
}

async function withRuntimeSnapshot(
  snapshot: Record<string, unknown> | ((requestNumber: number) => Record<string, unknown>),
  run: () => Promise<void>,
): Promise<void> {
  const socketPath = path.join(process.env.LLV_STATE_DIR!, `runtime-${crypto.randomUUID()}.sock`);
  let requestNumber = 0;
  const server = net.createServer((socket) => {
    let frame = "";
    socket.on("data", (chunk) => {
      frame += String(chunk);
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(frame.slice(0, newline)) as { id: string };
      const supplied = typeof snapshot === "function" ? snapshot(requestNumber++) : snapshot;
      const result = { schemaVersion: 1, snapshotSeq: 0, retentionFloorSeq: 0, filesRevision: 0, ...supplied,
        runtime: { hostEpoch: 1, health: "healthy", ...(supplied.runtime as object) } };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const priorSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  try {
    await run();
  } finally {
    if (priorSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = priorSocket;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function boardTask(id: string, project = "viewer"): BoardTask {
  return {
    id,
    project,
    status: "inbox",
    text: `Task ${id}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

/* The operator's report behind #1799: one `create_pipeline` answered after 27
   seconds, almost all of it spent waiting for the registry lease that the
   controller held across a base fetch and a worktree add. Both halves are
   measured here against a delayed asynchronous fetch. */
const SLOW_FETCH_MS = 750;
const FETCHED_SHA = "b3f19a7c1d0e4b6a8f2c5d9e0a1b3c4d5e6f7a8b";

/** A delayed fetch, and a remote whose head is only readable once it has run:
    a lane that resolved its base without fetching reads the stale ref. */
/** A remote whose fetch takes SLOW_FETCH_MS, or, when `held`, lasts until the
    test calls `release` — a fetch of any length. */
function slowRemote(h: ReturnType<typeof harness>, options: { held?: boolean } = {}): { fetched: () => boolean; release: () => void } {
  const baseExec = h.ports.exec;
  let fetched = false;
  let release = () => {};
  const gate = options.held ? new Promise<void>((resolve) => { release = resolve; }) : null;
  h.ports.provisionExec = async (command, args, cwd) => {
    const gitArgs = command === "timeout" ? args.slice(args.indexOf("git") + 1) : args;
    if (gitArgs[0] === "fetch") {
      await (gate ?? Bun.sleep(SLOW_FETCH_MS));
      fetched = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (gitArgs[0] === "rev-parse" && (gitArgs[1] === "--verify" || gitArgs[1] === "HEAD")) {
      return { code: 0, stdout: `${fetched ? FETCHED_SHA : ORIGIN_MAIN_SHA}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };
  return { fetched: () => fetched, release: () => release() };
}

/* A resolver that fails one lookup in six (#2220), a ref lock another Git
   process holds for a moment (#2115), and a checkout the load killed at its
   bound (#2176): each is retried by the controller on a bounded backoff
   instead of parking the lane on its first sighting. */
function provisionRetryClock(h: ReturnType<typeof harness>): { scheduled: number[]; advance: (ms: number) => void } {
  const scheduled: number[] = [];
  let clock = Date.parse("2026-09-25T15:20:00.000Z");
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    now: () => new Date(clock).toISOString(),
  });
  return { scheduled, advance: (ms) => { clock += ms; } };
}

const DNS_FAILURE = "ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.";

async function realProvisioningRepo(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${name}-`));
  const repo = path.join(root, "repo");
  const { realExec } = await import("@/lib/workflows/provision");
  const git = async (cwd: string, ...args: string[]) => {
    const result = (await realExec("git", args, cwd));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  fs.mkdirSync(repo);
  (await git(repo, "init", "--initial-branch=main"));
  (await git(repo, "config", "user.name", "Fixture"));
  (await git(repo, "config", "user.email", "noreply@example.com"));
  (await git(repo, "config", "commit.gpgSign", "false"));
  return { root, repo, git, realExec };
}

/* #1750: the lock a release succession holds is the same condition as the host
   it is replacing, so the busy class rides the budget that outlasts a deploy
   rather than the delivery controller's thirty seconds. Production spent the
   whole of those thirty seconds inside three spawn calls — "failed after 3
   retries over 146s" — because the budget is wall-clock from the activation
   and each failing call burns tens of seconds of it. This drives that same
   arithmetic: every call costs fifty seconds, and the wait still has to
   outlast the eight minutes a deploy takes end to end. */
const DEPLOY_WINDOW_MS = 8 * 60_000;

/* The controller wait must never be slept through: the pipelines phase holds
   the pipeline mutation, and a tick that blocks in it for the whole budget is
   what pushed the flow pipeline controller past its 15s deadline (#1191). */
const forbiddenSleep = async (milliseconds: number) => {
  throw new Error(`stage activation slept ${milliseconds}ms inside the pipelines phase`);
};

/* Freezes the harness wall clock so a bounded, wall-clock wait can be driven
   step by step. The default clock advances on every `now()` read, which would
   make the elapsed budget depend on how many times a tick happens to ask. */
function frozenWallClock(h: ReturnType<typeof harness>) {
  let wall = Date.parse(h.ports.now());
  h.ports.now = () => new Date(wall).toISOString();
  return (milliseconds: number) => { wall += milliseconds; };
}

const HISTORICAL_VERDICT_MISS = "historical attempt completed without a valid final JSON verdict";
const DEPLOY_CUT_HOLD = "a Viewer deployment cut this stage's turn; the stage stays open for the continuation the successor owes it";
const READ_ONLY_RERUN = "the stage host was lost before it reported a verdict; the read-only stage runs again on the same head";

/**
 * The interruption obligations a Viewer release records (#1835), read by the
 * engine through its production port: an isolated registry is seated, the
 * obligation goes into that registry's own store, and every read builds the
 * default ports afresh so a later update is what the next tick sees. The
 * harness clock is moved to the present first, because the store retires
 * resolved records by their real age.
 */
function deployCutObligations(h: ReturnType<typeof harness>, name: string) {
  h.advanceWallClock(Date.now());
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `${name}-agent-registry.json`));
  setAgentRegistryForTests(registry);
  h.ports.conversationInterruption = (conversationId) => defaultPipelinePorts().conversationInterruption!(conversationId);
  const store = interruptionObligationStore(interruptionObligationDirectory(registry.filename));
  const record = (conversationId: string, recordedAt: string) => store.record({
    conversationId: conversationId as `conversation_${string}`,
    engine: "codex",
    hostKey: `codex:${name}`,
    path: "/codex/stage-1.jsonl",
    owner: { pid: 4242, startIdentity: `${name}-owner` },
    claimEpoch: 1,
    turnRef: `${name}-turn`,
    boundary: `viewer-release:${name}`,
    reason: "viewer-release",
    recordedAt,
    checkpoint: { lastEventKind: "tool_call", lastEventAt: null },
    seat: null,
  }).obligation;
  return { registry, store, record, restore: () => setAgentRegistryForTests(null) };
}

/** Strips the pane from a stage's latest attempt, so it is a structured host. */
function structuredLatest(stageIndex: number): void {
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[stageIndex]!.attempts.at(-1)!.paneId = null;
  savePipelines([pipeline]);
}

/** A read-only review parked exactly as lane 4a6cd090's was after a restart. */
async function reviewParkedAfterRestart(h: ReturnType<typeof harness>) {
  const pipeline = await create(h.ports, [
    { id: "review", kind: "run", role: { roleId: "reviewer" }, engine: "codex", access: "read-only", prompt: "Review {{task}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  const parkedAt = h.ports.now();
  const reason = "canonical stage transcript is not yet readable after structured stage termination";
  attempt.state = "needs_decision";
  attempt.completedAt = parkedAt;
  attempt.error = `stage verdict recovery exhausted after 3 checks: ${reason}`;
  attempt.verdictRecovery = { state: "exhausted", checks: 3, maxChecks: 3, startedAt: parkedAt, lastCheckedAt: parkedAt, nextCheckAt: null, reason, messageTs: null };
  stored.state = "needs_decision";
  stored.stateDetail = attempt.error;
  savePipelines([stored]);
  h.ports.spawnReceipt = (launchId) => launchId === attempt.launchId ? {
    state: "completed",
    launchId,
    conversationId: attempt.conversationId!,
    sessionId: attempt.sessionId,
    "transcript": attempt.agentPath,
    paneId: null,
  } : null;
  return { pipeline, launchId: attempt.launchId! };
}

/* #337 durable convergence fixtures: a structured stage attempt (no pane) whose
   completion authority is the transcript artifact itself. */
const STAGE_HEAD = "f8aa42dc90b04d34a1f2a5f3f8c2f6b7c9d0e1a2";
const PASS_TEXT = "integration complete\n\n```json\n{\"status\":\"pass\",\"confidence\":0.9}\n```";

function makeStructuredAttempt() {
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([pipeline]);
}

/** The production projection shape (#337): scanner resource-scope inheritance
    keeps the transcript `jsonl_turn_stalled` at its final byte size forever. */
function stalledEntry(pathname: string): FileEntry {
  return { ...entry(pathname), activity: "stalled", activityReason: "jsonl_turn_stalled" };
}

function countDurableReads(h: ReturnType<typeof harness>): () => number {
  let reads = 0;
  const base = h.ports.durableTurnEvidence;
  h.ports.durableTurnEvidence = async (engine, transcriptPath) => {
    reads += 1;
    return base(engine, transcriptPath);
  };
  return () => reads;
}

function pinStageHead(h: ReturnType<typeof harness>) {
  const baseExec = h.ports.exec;
  h.ports.exec = (rawCommand, rawArgs, cwd) => {
    const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${STAGE_HEAD}\n`, stderr: "" };
    /* The remote carries the same stage commit: these tests are about durable
       turn evidence, not publication, so origin is modelled as already current
       and publication short-circuits without a push. */
    if (args[0] === "ls-remote") {
      return { code: 0, stdout: `${STAGE_HEAD}\trefs/heads/${loadPipelines()[0]?.branch ?? "pipeline/test"}\n`, stderr: "" };
    }
    return baseExec(rawCommand, rawArgs, cwd);
  };
}

/** Provision + spawn the first stage, then strip its pane so the attempt is a
    structured host, and pin later HEAD reads to the stage's own commit. */
async function runningStructuredStage(h: ReturnType<typeof harness>) {
  const pipeline = await create(h.ports, [
    { id: "plan", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Plan {{task}}", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build from {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  pinStageHead(h);
  return pipeline;
}

const SSH_CONNECT_TIMEOUT = "ssh: connect to host example.invalid port 22: Connection timed out\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";

/** A two-stage pipeline whose review flow approved `ORIGIN_MAIN_SHA`, with the
    remote read after approval answering whatever `remote` holds. Every remote
    read, bounded or not, is counted, and the flow, spawn and send calls made
    before approval are the baseline nothing after it may add to (#1692). */
async function approvedReviewAwaitingRemote(h: ReturnType<typeof harness>, request: { publication?: "internal" | "remote-branch" } = REMOTE_BRANCH) {
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never, request);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewHeadSha: ORIGIN_MAIN_SHA, launchId: "review-launch", sessionId: "review-session", reviewerPath: "/codex/reviewer.jsonl", reviewerConversationId: "conversation_reviewer" } as never);
  flow.state = "approved";
  const control = { remote: { code: 128 as number | null, stdout: "", stderr: SSH_CONNECT_TIMEOUT }, reads: 0 };
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    const gitArgs = command === "timeout" ? args.slice(args.indexOf("git") + 1) : args;
    if (gitArgs[0] === "ls-remote") {
      control.reads += 1;
      return { ...control.remote };
    }
    return baseExec(command, args, cwd);
  };
  const effects = () => h.calls.filter((call) => /^(flow:|flow-patch:|flow-close:|spawn:)/.test(call));
  return { flow, control, effects, baseline: effects() };
}

/* --- internal publication: the Viewer's own state is the authority (#1692) --- */

/** Takes the network away after creation: every push, fetch and remote read,
    bounded or not, fails the way an unreachable forge does and is recorded. */
function networkDown(h: ReturnType<typeof harness>): { remoteCalls: string[] } {
  const remoteCalls: string[] = [];
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    const gitArgs = command === "timeout" ? args.slice(args.indexOf("git") + 1) : args;
    if (["ls-remote", "push", "fetch"].includes(gitArgs[0] ?? "")) {
      remoteCalls.push(`${command} ${args.join(" ")}`);
      return { code: 128, stdout: "", stderr: SSH_CONNECT_TIMEOUT };
    }
    return baseExec(command, args, cwd);
  };
  return { remoteCalls };
}

const NO_CODE_TEST_STAGES = [
  { id: "observe", kind: "run", access: "read-only", prompt: "observe", next: "verify" },
  { id: "verify", kind: "run", access: "read-only", prompt: "verify", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "review", next: null },
] as const;

async function persistedCommittingReview() {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[1]!.attempts[0]!;
  attempt.state = "committing";
  attempt.reviewHeadSha = ORIGIN_MAIN_SHA;
  attempt.output = "Review loop approved after 1 round(s).";
  attempt.verdict = { status: "pass", confidence: 1 };
  pipeline.cursor = { ...pipeline.cursor!, state: "committing" };
  savePipelines([pipeline]);
  return h;
}

/* #1141 — the sibling case of transcript terminalization. A provider limit cuts
   the stage turn off mid-flight, so the transcript's last record is the CLI's
   own notice and there is no verdict to read; the close then had no terminal
   reading at all and refused, parking the lane on the board forever. The
   fixtures below are written here, never lifted from a live transcript. */
const PROVIDER_LIMIT_NOTICE = "You've hit your session limit. Try again once the window resets.";
const LIMITED_ACCOUNT = ["account", "limited"].join("-");
const SPARE_ACCOUNT = ["account", "spare"].join("-");
const LIMITED_ACCOUNT_LABEL = "Limited seat";
const SPARE_ACCOUNT_LABEL = "Spare seat";

function stageTranscript(name: string, records: Record<string, unknown>[]): string {
  const file = path.join(process.env.LLV_STATE_DIR!, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

function limitInterruptedTranscript(name: string, notice = PROVIDER_LIMIT_NOTICE): string {
  return stageTranscript(name, [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "run the stage" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:20:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "opening the failing test" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:41:00.000Z",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: {
        role: "assistant",
        model: "<synthetic>",
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: notice }],
      },
    },
  ]);
}

function codexUsageLimitTranscript(name: string, resetsAt: number): string {
  return stageTranscript(name, [
    { timestamp: "2026-08-31T10:00:00.000Z", payload: { type: "task_started" } },
    {
      timestamp: "2026-08-31T10:04:00.000Z",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 27, window_minutes: 10_080, resets_at: resetsAt },
          secondary: null,
          credits: { has_credits: true, balance: "0" },
          plan_type: "pro",
        },
      },
    },
    {
      timestamp: "2026-08-31T10:05:00.000Z",
      payload: {
        type: "task_complete",
        message: "You've hit your usage limit. Try again after the weekly reset.",
        codex_error_info: "usage_limit",
      },
    },
  ]);
}

function verdictTranscript(name: string, status: "pass" | "needs_decision" = "pass"): string {
  return stageTranscript(name, [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "run the stage" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:30:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: `done\n\n\`\`\`json\n${JSON.stringify({ status, findings: [], confidence: 0.9 })}\n\`\`\``,
        }],
      },
    },
  ]);
}

function silentTranscript(name: string): string {
  return stageTranscript(name, [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "run the stage" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:20:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "opening the failing test" }] },
    },
  ]);
}

/** Read the stage's durable evidence out of a fixture transcript through the
    same reader production uses, so the close is exercised against real records
    rather than a hand-shaped evidence object. */
function readFixtures(h: ReturnType<typeof harness>, fixtures: Record<string, string>): void {
  h.ports.durableTurnEvidence = async (engine, transcriptPath, reportAt, startedAt, readTail, afterCutAt) => {
    const fixture = fixtures[transcriptPath];
    return fixture ? await durableStageTurnEvidence(engine, fixture, reportAt, startedAt, readTail, afterCutAt) : null;
  };
}

function providerQuotaRecord(engine: "claude" | "codex", at: number): Record<string, unknown> {
  return engine === "claude" ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
    message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
    : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete",
      error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } };
}

async function stampPipelinePrompt(file: string, uuid: string, text: string): Promise<void> {
  const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
  const ledger = new FileClaudeDeliveryLedger();
  const session = path.basename(file, ".jsonl");
  ledger.recordQueued(session, { id: `controller-${uuid}`, text, origin: { kind: "agent", role: "pipeline" } }, "turn-started");
  ledger.confirmDelivered(session, `controller-${uuid}`, uuid);
}

/** The #1589 production tail, in the order the incident wrote it: a
    `function_call` the deploy cut off mid-flight, the standing continuation
    prompt startup delivered, and the re-hosted turn that finished with a
    fenced verdict. */
function severedToolTranscript(name: string): string {
  return stageTranscript(name, [
    { timestamp: "2026-09-09T05:36:42.000Z", type: "response_item", payload: { type: "function_call", call_id: "cut-off-by-the-restart" } },
    { timestamp: "2026-09-09T05:38:44.000Z", type: "event_msg", payload: { type: "user_message", message: "Continue the interrupted turn from the transcript." } },
    { timestamp: "2026-09-09T05:38:45.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "continued-turn" } },
    { timestamp: "2026-09-09T05:40:17.000Z", type: "event_msg", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-09-09T05:40:18.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "continued-turn" } },
  ]);
}

/** A tail window that begins inside an oversized tool output, so the matching
    `function_call` and every lifecycle boundary sit above it. Everything the
    engine can see is mid-turn — including a message that parses as a verdict. */
function truncatedMidTurnTranscript(name: string): string {
  return stageTranscript(name, [
    { timestamp: "2026-09-09T08:00:00.000Z", type: "response_item", payload: { type: "function_call", call_id: "oversized" } },
    { timestamp: "2026-09-09T08:00:01.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "r".repeat(200_000) } },
    { timestamp: "2026-09-09T08:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-09-09T08:00:03.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "oversized", output: "x".repeat(40_000) } },
    { timestamp: "2026-09-09T08:00:04.000Z", type: "event_msg", payload: { type: "token_count" } },
  ]);
}

function usageLimitPorts(
  h: ReturnType<typeof harness>,
  resolution: ReturnType<typeof accountManager.resolveProjectSpawn>,
): void {
  Object.assign(h.ports, {
    accountForTranscript: (_engine: string, transcriptPath: string) => transcriptPath.includes("stage-2")
      ? { accountId: SPARE_ACCOUNT, label: SPARE_ACCOUNT_LABEL }
      : { accountId: LIMITED_ACCOUNT, label: LIMITED_ACCOUNT_LABEL },
    accountLabel: (_engine: string, accountId: string) => accountId === SPARE_ACCOUNT ? SPARE_ACCOUNT_LABEL : LIMITED_ACCOUNT_LABEL,
    resolveProjectSpawn: () => resolution,
  });
}

const usageLimitStage = (account?: string) => [{
  id: "build",
  kind: "run" as const,
  role: { roleId: "builder" as const },
  engine: "codex" as const,
  access: "read-write" as const,
  ["prompt"]: "Recover the usage-limited attempt",
  next: null,
  ...(account ? { account } : {}),
}];

const reviewPipeline = { task: "ship the widget", cursor: null, stages: [], runs: [] } as unknown as Parameters<typeof reviewNote>[0];
const reviewStage = (prompt: string) => ({ id: "review", kind: "review-loop", prompt, next: null } as unknown as Parameters<typeof reviewNote>[1]);
const noteOf = (result: ReturnType<typeof reviewNote>) => ("note" in result ? result.note : "");

/* ── #353: persisted exactly-once relay, fail-edge cycles, set-edge editing ── */

const CYCLE_STAGES = [
  { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}} from {{prev.output}}", next: "verify" },
  { id: "verify", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Verify {{prev.output}}", next: null, onFail: { to: "build", maxRounds: 1 } },
] as const;

/* A spent review budget (#1868): N configured rounds mean N reviews and N+1
   builds. The last round's findings go to the fix stage once more, and that
   fix's pass follows the reviewer's own pass edge. A terminal reviewer then
   checks that final fix once (#3037). */
const BUDGET_STAGES = (onFail: Record<string, unknown>, critiqueNext: string | null = "ship") => [
  { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}} from {{prev.output}}", next: "critique" },
  { id: "critique", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Critique {{prev.output}}", next: critiqueNext, onFail },
  ...(critiqueNext ? [{ id: "ship", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Ship {{prev.output}}", next: null }] : []),
];

/** Runs build → critique, failing every critique with one finding, until the
    controller stops routing back to build or a round limit is hit. */
async function failEveryCritique(h: ReturnType<typeof harness>, reviews: number, beforeBuildPass: () => void = () => {}): Promise<void> {
  for (let round = 1; round <= reviews + 1; round += 1) {
    await tickPipelines([], h.ports);
    let current = loadPipelines()[0]!;
    if (current.cursor?.stageId !== "build") return;
    await tickPipelines([], h.ports);
    current = loadPipelines()[0]!;
    const build = current.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
    beforeBuildPass();
    await tickPipelines([h.finish(build.agentPath!, "pass", `built v${round}`)], h.ports);
    current = loadPipelines()[0]!;
    if (current.cursor?.stageId !== "critique") return;
    await tickPipelines([], h.ports);
    current = loadPipelines()[0]!;
    const critique = current.runs.find((run) => run.stageId === "critique")!.attempts.at(-1)!;
    h.messages.set(critique.agentPath!, {
      text: `round ${round} findings\n\n\`\`\`json\n{"status":"fail","findings":["P2 evidence gap ${round}"]}\n\`\`\``,
      ts: Date.now() + 100_000_000,
    });
    await tickPipelines([entry(critique.agentPath!)], h.ports);
  }
}

/* A spent review budget whose last fix wrote a NEW head, on an edge that asked
   for `stop-after-fix` (#1938, #2187): the lane ends in needs_review, never
   completed, and never takes the reviewer's pass edge for a head nobody
   reviewed. The operator can accept that head explicitly. Under the default the lane completes
   only after a terminal re-check (below). */
const STOP_AFTER_FIX = { onExhausted: "stop-after-fix" } as const;
const REVIEW_HEADS = ["1".repeat(40), "2".repeat(40), "3".repeat(40), "4".repeat(40), "5".repeat(40), "6".repeat(40)];

/** The harness with a worktree HEAD the test moves: each build round `n`
    commits REVIEW_HEADS[n - 1] unless `heads` says otherwise. */
function movingHeadHarness(heads: (round: number) => string = (round) => REVIEW_HEADS[round - 1]!) {
  const h = harness();
  let head = ORIGIN_MAIN_SHA;
  let builds = 0;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, rawArgs, ...rest) => {
    const args = command === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${head}\n`, stderr: "" };
    return baseExec(command, rawArgs, ...rest);
  };
  const beforeBuildPass = () => { builds += 1; head = heads(builds); };
  return Object.assign(h, { beforeBuildPass });
}

async function critiqueRound(h: ReturnType<typeof movingHeadHarness>, status: "pass" | "fail", label: string): Promise<void> {
  await tickPipelines([], h.ports);
  const current = loadPipelines()[0]!;
  const critique = current.runs.find((run) => run.stageId === "critique")!.attempts.at(-1)!;
  h.messages.set(critique.agentPath!, {
    text: `${label}\n\n\`\`\`json\n{"status":"${status}"${status === "fail" ? `,"findings":["P1 ${label}"]` : ""}}\n\`\`\``,
    ts: Date.now() + 100_000_000,
  });
  await tickPipelines([entry(critique.agentPath!)], h.ports);
}

async function buildRound(h: ReturnType<typeof movingHeadHarness>, label: string): Promise<void> {
  await tickPipelines([], h.ports);
  const current = loadPipelines()[0]!;
  const build = current.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
  h.beforeBuildPass();
  await tickPipelines([h.finish(build.agentPath!, "pass", label)], h.ports);
}

function continueReview(pipeline: Pipeline, clientRequestId: string, addRounds: unknown, expectedRevision = pipelineRevision(pipeline)) {
  return patchPipeline(pipeline.id, { action: "continue-review", clientRequestId, addRounds: addRounds as number, expectedRevision }, movingHead.ports!);
}
const movingHead: { ports: PipelinePorts | null } = { ports: null };

function acceptHead(pipeline: Pipeline, clientRequestId: string, expectedRevision = pipelineRevision(pipeline)) {
  return patchPipeline(pipeline.id, { action: "accept-head", clientRequestId, expectedRevision }, movingHead.ports!);
}


async function driveWithController(
  h: ReturnType<typeof movingHeadHarness>,
  failing: ReadonlySet<string> | ((stageId: string, attempt: number) => boolean) = new Set(["critique"]),
  initialReviews = 0,
): Promise<{ pipeline: Pipeline; reviews: number }> {
  const { FlowPipelineController } = await import("./controller");
  const answered: FileEntry[] = [];
  const controller = new FlowPipelineController({
    scan: async () => ({ files: [...answered], complete: true }),
    tickPipelines: (entries) => tickPipelines(entries, h.ports),
    tickFlows: async () => ({ changed: false }),
    /* A clock at zero keeps the hourly archive sweep from moving the lane. */
    now: () => 0,
    publishHeartbeat: () => {},
    sweepForgeLinks: () => {},
    log: () => {},
  });
  const seen = new Set<string>();
  let reviews = initialReviews;
  for (let cycle = 0; cycle < 120; cycle += 1) {
    await controller.tick("test");
    const pipeline = loadPipelines()[0]!;
    if (pipeline.state !== "running" && pipeline.state !== "provisioning") return { pipeline, reviews };
    const stageId = pipeline.cursor?.stageId;
    const attempt = stageId ? pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) : undefined;
    if (!stageId || !attempt?.agentPath || seen.has(attempt.agentPath)) continue;
    seen.add(attempt.agentPath);
    if (typeof failing === "function" ? failing(stageId, attempt.n) : failing.has(stageId)) {
      reviews += 1;
      h.messages.set(attempt.agentPath, {
        text: `round ${reviews} findings\n\n\`\`\`json\n{"status":"fail","findings":["P2 evidence gap ${reviews}"]}\n\`\`\``,
        ts: Date.now() + 100_000_000,
      });
    } else {
      if (attempt.effectiveRole.access === "read-write") h.beforeBuildPass();
      h.messages.set(attempt.agentPath, { text: `${stageId} done ${seen.size}\n\n\`\`\`json\n{"status":"pass"}\n\`\`\``, ts: Date.now() + 100_000_000 });
    }
    answered.push(entry(attempt.agentPath));
  }
  throw new Error(`the controller left the lane ${loadPipelines()[0]!.state}`);
}

/** Reconstruct a legacy terminal cursor when absent. The current advance
    policy creates it directly; recovery tests can use that durable cursor. */
function seedLegacyTerminalRecheck(): void {
  const lane = loadPipelines()[0]!;
  if (lane.cursor?.activatedBy?.budgetRecheck) return;
  expect(lane.state).toBe("completed");
  const fixRun = lane.runs.find(run => run.attempts.at(-1)?.activatedBy?.budgetSpent);
  const fix = fixRun?.attempts.at(-1);
  const gateId = fix?.activatedBy?.stageId;
  expect(gateId).toBeDefined();
  lane.state = "running";
  lane.closedAt = null;
  lane.stateDetail = null;
  if (lane.delivery) { lane.delivery.active = true; lane.delivery.publish = "enabled"; }
  lane.cursor = { stageId: gateId!, state: "pending", input: fix!.output,
    activatedBy: { stageId: fixRun!.stageId, attempt: fix!.n, edge: "pass", budgetRecheck: true } };
  savePipelines([lane]);
}

async function driveLegacyTerminalRecheck(
  h: ReturnType<typeof movingHeadHarness>,
  failing: ReadonlySet<string> | ((stageId: string, attempt: number) => boolean) = new Set(["critique"]),
) {
  const prior = await driveWithController(h, failing);
  if (prior.pipeline.reviewPending?.terminalRecheck) return prior;
  seedLegacyTerminalRecheck();
  // Preserve the historical park until it is written, then restore its
  // default policy so the next owner tick exercises restart reconciliation.
  const seeded = loadPipelines()[0]!;
  const review = seeded.stages.find(stage => stage.id === seeded.cursor!.stageId)!;
  const exhaustion = review.onFail!.onExhausted;
  review.onFail!.onExhausted = "stop-after-fix";
  savePipelines([seeded]);
  const result = await driveWithController(h, failing, prior.reviews);
  const restored = result.pipeline.stages.find(stage => stage.id === review.id)!;
  if (exhaustion === undefined) delete restored.onFail!.onExhausted;
  else restored.onFail!.onExhausted = exhaustion;
  savePipelines([result.pipeline]);
  return result;
}

/* #2187 §3.2: every new review-loop stage is converted where it enters the
   plan, so none of them reaches the embedded flow that parks at its round
   limit without a last fix. */
const CONVERTED_REVIEWER_EDGE = { to: "review-fix", maxRounds: 3, onExhausted: "advance" };

function expectConvertedReview(pipeline: Pipeline, implementer: string, reviewNext: string | null) {
  const review = pipeline.stages.find((stage) => stage.id === "review")!;
  const fix = pipeline.stages.find((stage) => stage.id === "review-fix")!;
  const source = pipeline.stages.find((stage) => stage.id === implementer)!;
  expect(review).toMatchObject({ kind: "run", next: reviewNext, onFail: CONVERTED_REVIEWER_EDGE, effectiveRole: { access: "read-only" } });
  expect(fix).toMatchObject({ kind: "run", next: "review", onFail: null, effectiveRole: source.effectiveRole });
  expect(pipeline.stages.some((stage) => stage.kind === "review-loop")).toBe(false);
  expect(pipeline.runs.some((run) => run.stageId === "review-fix")).toBe(true);
}

const REVIEW_LOOP_STAGE = { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review {{prev.output}}" };
const BUILD_ONLY = [{ id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}}", next: null }];

/* --- #729: the orchestrator publishes the head the review layer fences on --- */

function publishHarness(h: ReturnType<typeof harness>, options: { origin?: boolean; pushFails?: boolean; privacyRejects?: boolean; remoteReadFails?: boolean } = {}) {
  const passedSha = "7".repeat(40);
  const order: string[] = [];
  /* Oldest first. `merge-base --is-ancestor` is answered from this, so the
     fake cannot accidentally agree that a divergence is a fast-forward. */
  const history = [ORIGIN_MAIN_SHA, passedSha];
  let localHead = ORIGIN_MAIN_SHA;
  let remoteBranch: string | null = null;
  let dirty = true;
  let pushFails = false;
  let remoteReadFails = options.remoteReadFails ?? false;
  let remoteReadAttempts = 0;
  let commitParent = localHead;
  let commitMessage = "";
  const baseExec = h.ports.exec;
  h.ports.exec = (rawCommand, rawArgs, cwd) => {
    const command = rawCommand === "timeout" ? "git" : rawCommand;
    const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    const branch = loadPipelines()[0]?.branch ?? "pipeline/test";
    if (command !== "git") return baseExec(command, args, cwd);
    if (args[0] === "reflog") return { code: 0, stdout: `${localHead}\0HEAD@{${Math.floor(Date.parse(loadPipelines()[0]!.runs.flatMap(run => run.attempts).at(-1)!.startedAt!) / 1000)}}\0commit: stage work\n`, stderr: "" };
    if (args[0] === "rev-list" && args.includes("--max-count=128")) return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: dirty ? " M src/lib/thing.ts\n" : "", stderr: "" };
    if (args[0] === "add") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "show" && args.includes("--format=%P%x00%T%x00%B")) return {
      code: 0, stdout: `${commitParent}\0${"8".repeat(40)}\0${commitMessage}\n`, stderr: "" };
    if (args[0] === "commit") {
      commitParent = localHead;
      commitMessage = args.filter((_, index) => args[index - 1] === "-m").join("\n\n");
      dirty = false;
      localHead = passedSha;
      order.push("commit");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${branch}\n`, stderr: "" };
    if (args[0] === "remote" && args[1] === "get-url") {
      return options.origin === false
        ? { code: 2, stdout: "", stderr: "error: No such remote 'origin'" }
        : { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
    }
    if (args[0] === "ls-remote") {
      remoteReadAttempts += 1;
      if (remoteReadFails) {
        return { code: 128, stdout: "", stderr: "fatal: remote authentication unavailable" };
      }
      return { code: 0, stdout: remoteBranch ? `${remoteBranch}\trefs/heads/${branch}\n` : "", stderr: "" };
    }
    if (args[0] === "push") {
      if (options.privacyRejects) {
        const accepted = loadPipelines()[0]?.lastPassedCommit;
        const pushed = args.find((arg) => /^[0-9a-f]{40}:/i.test(arg))?.split(":", 1)[0] ?? "missing";
        order.push(`privacy:${accepted ?? "unaccepted"}:${pushed}`);
        return { code: 1, stdout: "", stderr: "pre-push: privacy\nPRIVACY GATE: FAIL: accepted head fixture\npre-push: bun failed (1); gate failed" };
      }
      if (options.pushFails || pushFails) {
        order.push("push-rejected");
        return { code: 1, stdout: "", stderr: "! [remote rejected] (shallow update not allowed)" };
      }
      remoteBranch = localHead;
      order.push(`push:${localHead}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if ((args[0] === "reset" && args.includes("--hard")) || args[0] === "clean") {
      dirty = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "reset" && args.includes("--quiet") && args.includes("--")) {
      /* A path-scoped reset of controller artifacts must not erase the mock's
         unrelated source edit from `status`. */
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "cat-file") return { code: history.includes(String(args[2]).replace("^{commit}", "")) ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const ancestor = history.indexOf(String(args[2]));
      const descendant = history.indexOf(String(args[3]));
      return { code: ancestor >= 0 && descendant >= 0 && ancestor <= descendant ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "merge" && args[1] === "--ff-only") {
      localHead = remoteBranch ?? localHead;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    if (args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) {
      return remoteBranch
        ? { code: 0, stdout: `${remoteBranch}\n`, stderr: "" }
        : { code: 128, stdout: "", stderr: "fatal: bad revision" };
    }
    return baseExec(command, args, cwd);
  };
  const baseCreateFlow = h.ports.createFlow;
  h.ports.createFlow = async (req, entries) => {
    order.push("createFlow");
    return await baseCreateFlow(req, entries);
  };
  return {
    passedSha,
    order,
    remote: () => remoteBranch,
    setRemote: (sha: string | null) => { remoteBranch = sha; },
    setDirty: (value: boolean) => { dirty = value; },
    setPushFails: (value: boolean) => { pushFails = value; },
    setRemoteReadFails: (value: boolean) => { remoteReadFails = value; },
    remoteReadAttempts: () => remoteReadAttempts,
    setLocalHead: (sha: string) => { localHead = sha; if (!history.includes(sha)) history.push(sha); },
    /* Records a revision nobody's local checkout contains — a repair pushed
       from another clone, which must never be fast-forwarded away. */
    setDivergentRemote: (sha: string) => { remoteBranch = sha; },
  };
}

const PUBLISH_STAGES = [
  { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
] as const;

async function deliveryRefusalPark() {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  // Reproduce an old fail-park's released claim before its retry passed.
  const released = loadPipelines()[0]!;
  released.delivery!.active = false;
  released.delivery!.publish = "disabled";
  savePipelines([released]);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "accepted output")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", cursor: { stageId: "build", state: "committing" },
    lastPassedCommit: box.passedSha });
  expect(parked.stateDetail).toStartWith("publishing the passed stage: Viewer publication denied:");
  return { h, box, pipeline: parked, id: pipeline.id };
}

async function interruptedPublication() {
  const h = harness();
  const box = publishHarness(h, { remoteReadFails: true });
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const terminal = loadPipelines()[0]!;
  const reviewStage = terminal.stages.pop()!;
  const reviewRun = terminal.runs.pop()!;
  terminal.stages[0]!.next = null;
  savePipelines([terminal]);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.stages[0]!.next = "review";
  pipeline.stages.push(reviewStage);
  pipeline.runs.push(reviewRun);
  // The failed read above only builds the accepted-head fixture. The writer
  // interrupted below is this scenario's first publication failure.
  delete pipeline.publicationRecovery;
  delete pipeline.runs[0]!.attempts[0]!.publicationRetry;
  pipeline.delivery!.operation!.state = "pending";
  delete pipeline.delivery!.operation!.result;
  savePipelines([pipeline]);
  box.setRemoteReadFails(false);
  const { publishPipelineBranch } = await import("./git");
  await publishPipelineBranch(pipeline, async (command, args, cwd, env, options) => {
    if (args[0] === "push") throw new Error("publisher interrupted during the remote write");
    return await h.ports.exec(command, args, cwd, env, options);
  }, { acceptedSha: box.passedSha });
  return { h, box, pipeline: loadPipelines()[0]! };
}

/* --- exact-head publication is a precondition of EVERY review ingress ------ */

/* These synthetic routes have an earlier passed run; the real-git legacy
   architect case above covers a skipped run as the review producer. */
const SKIP_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "builder" }, ["prompt"]: "plan", next: "build" },
  { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
] as const;

const FAIL_EDGE_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "builder" }, ["prompt"]: "plan", next: "build" },
  { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review", onFail: { to: "review", maxRounds: 2 } },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
] as const;

/* #1678: the 7eef4743 prototype's confirm stage. The spawn reserved a launch,
   every runtime-host RPC then timed out, the spawn layer recorded the receipt
   as failed with the actionable host message, and the stage parked on that
   first sighting until an operator ran retry-stage two minutes later. */
const HOST_UNAVAILABLE = "pipeline structured runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";

function failedReceipt(launchId: string, conversationId: string, error: string): NonNullable<ReturnType<PipelinePorts["spawnReceipt"]>> {
  return { state: "failed", launchId, conversationId, sessionId: null, "transcript": null, paneId: null, error };
}

/* #1750: the delivery queue writes this when a release succession leaves two
   executors over one journal and the later one cannot learn what became of the
   first one's send. It is a succession artefact, so a stage that meets it met
   a deploy — and the transcript, not the message, decides whether the prompt
   it carried can be sent again. */
const UNVERIFIED_DELIVERY = "delivery was started by an earlier executor; whether it reached the recipient is unverified";

/* #1678: pipeline 4d6f4fc1's review stage. The implementer had passed from its
   transcript artifact, ahead of the scanner; the flow engine paused on the
   stale completed scan snapshot, a paused flow is never ticked, and the stage
   parked until an operator resumed the flow by hand. */
async function reviewFlowPausedOnUnscannedImplementer(h: ReturnType<typeof harness>) {
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const flow = h.flows.get("flow-1")!;
  const pauseOnScan = () => {
    flow.state = "paused";
    flow.pausedState = "spawning";
    flow.stateDetail = "implementer transcript is missing";
  };
  pauseOnScan();
  return { flow, pauseOnScan };
}

/* #1678: pipeline 4d6f4fc1's review stage again, after the scan caught up. The
   flow engine met the busy account mutation lock inside prepareReviewerLaunch,
   ended the round as needs_decision before any launch was reserved, and the
   pipeline parked on that terminal state twice in a row. */
const REVIEWER_BUSY = "account mutation is busy; retry shortly";

async function reviewFlowEndedOnBusyAccount(h: ReturnType<typeof harness>) {
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewerPath: null, reviewerConversationId: null, sessionId: null, launchId: null, spawnStartedAt: null, verdict: null, error: null } as never);
  const busy = () => {
    flow.state = "needs_decision";
    flow.stateDetail = REVIEWER_BUSY;
    flow.rounds.at(-1)!.error = REVIEWER_BUSY;
  };
  busy();
  return { flow, busy };
}

function interruptedSpawnAttempt(h: ReturnType<typeof harness>, startedAt: string, controllerWait?: { startedAt: string; rounds: number; retryAfter: string }) {
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "spawning",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-interrupted",
    conversationId: "conversation_interrupted",
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt,
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
    ...(controllerWait ? { controllerWait } : {}),
  });
  pipeline.cursor = { stageId: "plan", state: "spawning", input: null, activatedBy: null };
  savePipelines([pipeline]);
  h.ports.spawnReceipt = (launchId) => launchId === "launch-interrupted"
    ? failedReceipt("launch-interrupted", "conversation_interrupted", HOST_UNAVAILABLE)
    : null;
}

/* The engine before #1678 numbered a spawn call `rounds + call - 1` and
   persisted no call count, so the ids it spent are known only up to that
   bound: a handshake retry before the controller failure spends one more id
   than the round it books. These fixtures let the current engine create the
   attempt through one such activation, then strip what that engine did not
   write. A registry that meets a spent id replays or rejects that launch,
   which parks the stage. */
async function legacySpawnAttempt(h: ReturnType<typeof harness>) {
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const scheduled: number[] = [];
  let fixtureCalls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    fixtureCalls += 1;
    if (fixtureCalls === 1) throw new Error("structured initial message was not acknowledged");
    await onReserved({ launchId: "launch-fixture", conversationId: "conversation_fixture" });
    throw new Error(HOST_UNAVAILABLE);
  };
  h.ports.spawnReceipt = (launchId) => launchId === "launch-fixture"
    ? failedReceipt("launch-fixture", "conversation_fixture", HOST_UNAVAILABLE)
    : null;
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: async () => {},
  });
  await tickPipelines([], h.ports);
  expect(fixtureCalls).toBe(2);

  const baseId = `pipeline_${created.id}_plan_1`;
  const spent = [baseId, `handshake_retry_1_${baseId}`];
  const clientAttemptIds: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    clientAttemptIds.push(input.clientAttemptId);
    if (spent.includes(input.clientAttemptId)) {
      throw new Error(`client attempt id ${input.clientAttemptId} replays launch-legacy-2, whose receipt is failed`);
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId === "launch-legacy-2"
    ? failedReceipt("launch-legacy-2", "conversation_legacy_2", HOST_UNAVAILABLE)
    : null;
  const legacy = loadPipelines()[0]!;
  const attempt = legacy.runs[0]!.attempts[0]!;
  const wait = attempt.controllerWait!;
  delete attempt.spawnCalls;
  delete attempt.retiredLaunches;
  attempt.launchId = "launch-legacy-2";
  attempt.conversationId = "conversation_legacy_2";
  attempt.controllerWait = { startedAt: wait.startedAt, rounds: wait.rounds, retryAfter: wait.retryAfter };
  return { legacy, attempt, spent, clientAttemptIds, advance, scheduled };
}

/* ── #1695 C7 and the retry/skip guard: stated expectations, checked in the mutation ── */

const { stageDigest } = await import("./stageDigest");
const buildStageOf = () => loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;

/* ── #1785: which review-flow verdict the graph may route ────────────────── */

const REVIEW_FINDING_BLOCK = [
  "### Finding 1",
  "- **Severity:** High",
  "- **File:** src/lib/pipelines/engine.ts",
  "- **Line:** 42",
  "- **Title:** The fence is missing",
  "- **Explanation:** Add the fence the round names.",
  "",
].join("\n");

/** A terminal flow whose last round wrote the given findings artifact. */
function flowWithFindings(h: ReturnType<typeof harness>, verdict: "COMMENT" | "REQUEST_CHANGES", body: string): Flow {
  const flow = h.flows.get("flow-1")!;
  const findingsPath = path.join(process.env.LLV_STATE_DIR!, `issue1785-${verdict}-${flow.rounds.length}-review.md`);
  fs.writeFileSync(findingsPath, `VERDICT: ${verdict}\n\n${body}`);
  flow.rounds.push({
    n: flow.rounds.length + 1,
    verdict,
    findingsCount: body.includes("### Finding") ? 1 : 0,
    findingsPath,
    reviewHeadSha: ORIGIN_MAIN_SHA,
    reviewedAt: "2026-09-19T04:19:00.000Z",
    terminalAt: "2026-09-19T04:19:00.000Z",
    reviewerPath: "/codex/reviewer.jsonl",
    reviewerConversationId: "conversation_reviewer",
  } as never);
  flow.state = verdict === "COMMENT" ? "done_comment" : "needs_decision";
  flow.stateDetail = null;
  return flow;
}

async function parkedReviewStage(h: ReturnType<typeof harness>): Promise<void> {
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
}


async function stagedRecoveryHarness(
  mode: "timeout" | "reset" | "busy" | "503" | "uncertain" | "turn-started" | "absent" | "permanent" | "held" = "timeout",
  options: { hostProcess?: { pid: number; startIdentity: string | null }; nativeTranscript?: boolean; startedAt?: number } = {},
) {
  const h = harness();
  let clock = options.startedAt ?? Date.now();
  h.ports.now = () => new Date(clock).toISOString();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { spawnStructuredConversation, recoverStagedStructuredLaunch } = await import("@/lib/runtime/structuredSpawn");
  const { RuntimeHostUnavailableError, isRuntimeHostTransportFailure } = await import("@/lib/runtime/client");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const root = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "staged-recovery-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(root, options.nativeTranscript ? `rollout-2026-10-07T11-22-37-${sessionId}.jsonl` : "session.jsonl");
  let starts = 0;
  let messages = 0;
  let failures = ["timeout", "reset", "busy", "503", "held"].includes(mode) ? 2 : 0;
  let holds = mode === "held" ? 1 : 0;
  let statusFailures = 0;
  const lookups: string[] = [];
  const operations = new Map<string, import("@/lib/runtime/contracts").RuntimeOperationResult>();
  const record = (id: string, conversationId: string, status: "queued" | "delivered" | "turn-started", kind: import("@/lib/runtime/contracts").RuntimeOperationKind = id === launchId ? "spawn" : "send") => {
    const result = { operationId: id, receipt: { operationId: id, conversationId, status, kind }, replayed: false } as import("@/lib/runtime/contracts").RuntimeOperationResult;
    operations.set(id, result);
    return result;
  };
  const client = {
    command: async (command: Parameters<import("@/lib/runtime/client").RuntimeHostClient["command"]>[0]) => {
      if (!command.operationId || !command.conversationId) throw new Error("fixture requires original operation identity");
      return operations.get(command.operationId) ?? record(command.operationId, command.conversationId, "queued", command.kind);
    },
    producerCursor: async () => {
      if (mode === "permanent") throw new RuntimeHostUnavailableError("authentication denied", "UNAUTHORIZED");
      if (failures-- > 0) {
        if (mode === "503") throw Object.assign(new Error("runtime temporarily unavailable"), { status: 503 });
        if (mode === "reset") throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        if (mode === "busy") throw new RuntimeHostUnavailableError("runtime host busy", "HOST_BUSY");
        throw new RuntimeHostUnavailableError("runtime host request timed out");
      }
      return 0;
    },
    operationStatus: async (id: string) => {
      lookups.push(id);
      if (statusFailures-- > 0) throw new RuntimeHostUnavailableError("runtime host request timed out");
      return operations.get(id) ?? null;
    },
    transitionOperation: async (id: string, status: import("@/lib/runtime/contracts").RuntimeReceiptStatus) => record(id, operations.get(id)!.receipt.conversationId, status as "delivered"),
  } as unknown as import("@/lib/runtime/client").RuntimeHostClient;
  let launchId = "";
  h.ports.spawnAgent = async (_input, reserve) => {
    const profile = emptyLaunchProfile({ cwd: root });
    const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured", launchProfile: profile, memberships: [_input.membership] });
    if (begun.kind !== "created") throw new Error("fixture reservation failed");
    launchId = begun.receipt.launchId;
    await reserve({ launchId, conversationId: begun.receipt.conversationId });
    const result = await spawnStructuredConversation({
      engine: "codex", receipt: begun.receipt, registry, client, prompt: "Build the change",
      spec: { engine: "codex", command: "codex", cwd: root, windowName: "test", launchProfile: profile },
      account: { engine: "codex", accountId: "test", kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" } },
    }, {
      startHost: async () => {
        starts++;
        return {
          identity: { threadId: sessionId, path: artifactPath },
          health: async () => ({ status: "idle" }), release: async () => {},
          sessionMaterializationEvidence: async () => ({ state: "materialized" }),
        } as unknown as import("@/lib/runtime/structuredSpawn").SpawnedStructuredHost;
      },
      now: () => clock,
      bindHost: async (store, key, _host, owner, epoch) => {
        const entry = store.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
        store.setStructuredHostClaimed(key, { ...entry.structuredHost!, process: options.hostProcess ?? { pid: process.pid, startIdentity: "fixture" } }, "live", owner, epoch);
        return () => {};
      },
      publishHost: async () => { await client.producerCursor("codex-app-server", "test:"); return async () => {}; },
      deliverFirst: async () => {
        if (holds-- > 0) return "held";
        messages++;
        if (mode !== "absent") record(`spawn_message_${launchId}`, begun.receipt.conversationId, mode === "turn-started" ? "turn-started" : "delivered");
        if (mode === "absent") throw new RuntimeHostUnavailableError("runtime host request timed out");
        fs.writeFileSync(artifactPath, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n");
        if (mode === "uncertain" || mode === "turn-started") throw new RuntimeHostUnavailableError("runtime host request timed out");
      },
    }).catch((error) => { if (isRuntimeHostTransportFailure(error)) throw new Error(HOST_UNAVAILABLE); throw error; });
    return { launchId, conversationId: result.conversationId!, sessionId: null, transcript: result.path ?? null, paneId: null };
  };
  h.ports.spawnReceipt = (id) => {
    const receipt = registry.readOnlySnapshot().receipts[id];
    return receipt ? { launchId: id, conversationId: receipt.conversationId, state: receipt.state,
      sessionId: receipt.state === "completed" ? receipt.key?.sessionId ?? null : null,
      ["transcript"]: receipt.state === "completed" ? receipt.artifactPath : null, stagedTranscript: receipt.artifactPath ?? null,
      paneId: null, staged: !!receipt.key, error: receipt.error } : null;
  };
  const recover = async (id: string, eligible: () => boolean) => {
    await recoverStagedStructuredLaunch(id, registry, client, { now: () => clock, eligible });
  };
  h.ports.originalLaunchOperations = async (id, conversationId, eligible) => {
    const launch = await client.operationStatus(id);
    if (!eligible()) return "unknown";
    const message = await client.operationStatus(`spawn_message_${id}`);
    if (!eligible()) return "unknown";
    const conflicts = [[id, launch], [`spawn_message_${id}`, message]] as const;
    if (conflicts.some(([operationId, operation]) => operation &&
      (operation.operationId !== operationId || operation.receipt.operationId !== operationId
        || operation.receipt.conversationId !== conversationId))) return "conflict";
    if (!launch || !message || launch.receipt.kind !== "spawn" || message.receipt.kind !== "send") return "unknown";
    if (message.receipt.status === "rejected" || message.receipt.status === "failed") return "rejected";
    return eligible() ? "matched" : "unknown";
  };
  h.ports.recoverStagedLaunch = recover;
  h.ports.scheduleTick = () => {};
  h.ports.conversationAgentActive = async () => true;
  h.ports.pathForConversation = () => null;
  Object.assign(h.ports, { sleep: forbiddenSleep });
  const stages = spyOn(registry, "stageStructuredSpawn");
  const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
  const wake = async () => { clock += 61_000; await tickPipelines([], { ...h.ports }); };
  return { h, registry, client, stages, attempt, wake, recover,
    launchId: () => launchId, starts: () => starts, messages: () => messages, lookups,
    advance: (ms: number) => { clock += ms; }, failStatus: (n: number) => { statusFailures = n; } };
}

/* 2026-10-07: a fix attempt's host took its first message 110 s after launch,
   while every recovery probe the loaded controller ran still read it queued.
   No probe ran again, the ten-minute budget ran out on the wall clock, and the
   lane parked on "runtime host recovery exhausted" while its agent was
   committing the fix; its stage_report then answered STAGE_REPORT_SETTLED. */
async function aliveStagedLaunch(options: Parameters<typeof stagedRecoveryHarness>[1] = {}) {
  const f = await stagedRecoveryHarness("absent", options);
  await tickPipelines([], f.h.ports);
  await f.wake();
  expect(f.attempt().state).toBe("spawning");
  // The probe stops advancing: a controller pass that overran its deadline.
  f.h.ports.recoverStagedLaunch = async () => {};
  const transcript = f.registry.readOnlySnapshot().receipts[f.launchId()]!.artifactPath!;
  f.h.ports.sourcePathAllowed = (pathname) => pathname === transcript;
  f.h.ports.durableTurnEvidence = durableStageTurnEvidence;
  const working = () => {
    const at = Date.parse(f.h.ports.now());
    const receipt = f.registry.readOnlySnapshot().receipts[f.launchId()]!;
    void f.client.command({ operationId: `spawn_message_${f.launchId()}`, conversationId: receipt.conversationId,
      kind: "send", text: "Build the change" } as Parameters<import("@/lib/runtime/client").RuntimeHostClient["command"]>[0]);
    fs.writeFileSync(transcript, [
      { timestamp: new Date(at - 2_000).toISOString(), type: "session_meta", payload: { id: "stage" } },
      { timestamp: new Date(at - 1_000).toISOString(), type: "event_msg", payload: { type: "task_started" } },
      { timestamp: new Date(at).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixing the findings" }] } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  };
  return { ...f, transcript, working };
}

/** A host process this test started, with the start identity the kernel
    reports for it; `end` stops it by that pid and waits for it to be reaped. */
async function stageHostChild() {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const pid = child.pid!;
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const identity = captureProcessIdentity(pid);
  expect(identity.startIdentity).not.toBeNull();
  return { process: identity, end: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; } };
}

/** The registry seams production reads, over the harness's own registry: the
    launch receipt, its failure write and the host's process evidence. A fresh
    port set per call, so no snapshot outlives the write it should see. */
function productionHostSeams(f: Awaited<ReturnType<typeof stagedRecoveryHarness>>) {
  setAgentRegistryForTests(f.registry);
  const ports = () => defaultPipelinePorts();
  Object.assign(f.h.ports, {
    spawnReceipt: (launchId: string) => ports().spawnReceipt(launchId),
    transcriptPresent: (pathname: string) => ports().transcriptPresent!(pathname),
    failStageLaunch: (launchId: string, conversationId: string, reason: string) => ports().failStageLaunch!(launchId, conversationId, reason),
    failStoppedStageLaunch: (launchId: string, conversationId: string, reason: string, eligible: () => boolean) => ports().failStoppedStageLaunch!(launchId, conversationId, reason, eligible),
    releaseFailedStageLaunchContinuation: (launchId: string, conversationId: string) => ports().releaseFailedStageLaunchContinuation!(launchId, conversationId),
    conversationHostUnavailableSince: (conversationId: string) => ports().conversationHostUnavailableSince!(conversationId),
    conversationHostProcess: (conversationId: string) => ports().conversationHostProcess!(conversationId),
  } satisfies Partial<PipelinePorts>);
}

async function activationDrainFixture(afterPermit = false) {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  let launches = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    calls++;
    if (!afterPermit) { entered(); await gate; }
    await onReserved({ launchId: "activation-launch", conversationId: "conversation_activation" });
    if (afterPermit) { entered(); await gate; }
    launches++;
    return { launchId: "activation-launch", conversationId: "conversation_activation", sessionId: "activation-session", transcript: "/codex/activation.jsonl", paneId: null };
  };
  const ticking = tickPipelines([], h.ports);
  await started;
  return { h, release, ticking, calls: () => calls, launches: () => launches, id: loadPipelines()[0]!.id };
}

function expectPipelineLeaseFree() {
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  try { expect(db.query("SELECT count(*) AS n FROM state_leases WHERE collection='pipelines'").get()).toEqual({ n: 0 }); }
  finally { db.close(); }
}

async function reserveActivationOnly() {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  let checks = 0;
  h.ports.structuredDeliveryPublication = () => ++checks <= 2 ? "ready" : "unbound";
  try { await tickPipelines([], h.ports); }
  finally { delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
  h.ports.structuredDeliveryPublication = () => "ready";
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.phase).toBe("reserved");
  return h;
}

function expectPipelineLeaseAbsent() {
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  try { expect(db.query("SELECT count(*) AS n FROM state_leases WHERE collection='pipelines'").get()).toEqual({ n: 0 }); }
  finally { db.close(); }
}

/** Exercise the real startup reader and its scheduled re-probes against the
    frozen evidence produced by close and scanner reconciliation. */
async function frozenSurvivorStartup(pipelineId: string, terminateSurvivor: () => Promise<void>) {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { adoptStructuredHostsAtStartup, structuredStartupDeferral } = await import("@/lib/runtime/startup");
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "startup-frozen-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    readSession: async (identity) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
    retryOperation: async (id, nextKey, options) => journal.retryOperation(id, nextKey, options),
    transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
  } as import("@/lib/runtime/client").RuntimeHostClient;
  const members = ["codex", "claude"].map((engine) => {
    const key = { engine: engine as "codex" | "claude", sessionId: crypto.randomUUID() };
    const artifactPath = path.join(directory, `${key.sessionId}.jsonl`);
    fs.writeFileSync(artifactPath, "");
    const conversation = registry.ensureConversation(key.engine, artifactPath, null);
    registry.upsert({ key, artifactPath, cwd: directory, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: directory }), status: "live", host: null,
      structuredHost: { kind: engine === "codex" ? "codex-app-server" : "claude-broker",
        endpoint: "fake:frozen-survivor", process: null, eventCursor: 0, protocolVersion: "test",
        writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: pipelineId,
      role: "builder", slot: `member-${engine}`, stageId: "build", stageOrder: 0, round: 1,
      parentConversationId: null });
    registry.holdDelivery(conversation.id, "queued work", `frozen-${engine}`);
    return { key, conversation };
  });
  const selected: string[] = [];
  const scheduled: Array<() => void> = [];
  let rescheduled: (() => void) | undefined;
  let retired = false;
  const dependencies: import("@/lib/runtime/startup").StructuredStartupDependencies = {
    registry, client, orchestratorSeats: () => [], refreshTranscriptState: async () => {},
    assertActive: () => { if (retired) throw new Error("test startup retired"); },
    adopt: async (received, _options, _env, filter = () => true) => {
      for (const entry of Object.values(received.readOnlySnapshot().entries)) {
        if (entry.key.engine === "codex" && filter(entry)) selected.push(`codex:${entry.key.sessionId}`);
      }
      return [];
    },
    adoptClaude: async (received, _options, _env, filter = () => true) => {
      for (const entry of Object.values(received.readOnlySnapshot().entries)) {
        if (entry.key.engine === "claude" && filter(entry)) selected.push(`claude:${entry.key.sessionId}`);
      }
      return [];
    },
    schedule: (callback) => { scheduled.push(callback); rescheduled?.(); return { unref() {} }; },
  };
  const runScheduledProbe = async () => {
    expect(scheduled).toHaveLength(1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = new Promise<void>((resolve, reject) => {
      rescheduled = resolve;
      timer = setTimeout(() => reject(new Error("startup evidence probe did not reschedule")), 2_000);
    });
    try {
      scheduled.shift()!();
      // The production evidence read is asynchronous. Its next scheduled
      // probe proves the read finished before assertions or fixture teardown.
      await next;
    } finally {
      clearTimeout(timer);
      rescheduled = undefined;
    }
  };
  const before = structuredClone(registry.readOnlySnapshot().entries);
  const pipelineBefore = loadPipelines().find((pipeline) => pipeline.id === pipelineId)!;
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    expect(selected).toEqual([]);
    expect(new Set(structuredStartupDeferral()?.hostKeys)).toEqual(new Set(members.map(({ key }) => `${key.engine}:${key.sessionId}`)));
    expect(registry.readOnlySnapshot().entries).toEqual(before);
    for (let probe = 0; probe < 2; probe++) {
      await runScheduledProbe();
      expect(selected).toEqual([]);
      expect(structuredStartupDeferral()?.nextProbeMs).toBe(2_000 * 2 ** probe);
      expect(registry.readOnlySnapshot().entries).toEqual(before);
    }
    await terminateSurvivor();
    scheduled.shift()!();
    for (let probe = 0; probe < 400 && structuredStartupDeferral() !== null; probe++) await Bun.sleep(5);
    expect(structuredStartupDeferral()).toBeNull();
    expect(selected.sort()).toEqual(members.map(({ key }) => `${key.engine}:${key.sessionId}`).sort());
    expect(scheduled).toEqual([]);
    // Startup observes death without moving or erasing custody evidence.
    expect(loadPipelines().find((pipeline) => pipeline.id === pipelineId)).toEqual(pipelineBefore);
  } finally {
    retired = true;
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/* A service restart (a deploy, a self-update, a crash) took the stage's host
   down near the end of its work. The booting Viewer recorded the cut; once the
   host has been gone past the grace, the attempt is retried once in its
   worktree instead of parking as a missing verdict. */
async function restartCutStage(h: ReturnType<typeof harness>, stages?: unknown[]) {
  await create(h.ports, (stages ?? [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ]) as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  return attempt;
}

/** The host of `attempt` is gone since `at`, and a restart recorded its cut then. */
function cutByRestart(h: ReturnType<typeof harness>, ports: PipelinePorts, attempt: import("./types").PipelineStageAttempt, at: string, report: string) {
  const ts = Date.parse(at) - 1;
  h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: { text: report, ts }, lastRecordAt: ts });
  const cuts = (ports as { cuts?: Map<string, string> }).cuts ?? new Map<string, string>();
  cuts.set(attempt.conversationId!, at);
  Object.assign(ports, {
    cuts,
    conversationRestartCut: (conversationId: string) => cuts.has(conversationId) ? { recordedAt: cuts.get(conversationId)! } : null,
    conversationHostUnavailableSince: async (conversationId: string) => cuts.has(conversationId) ? cuts.get(conversationId)! : null,
  });
}

/** A Claude stage whose host is a real row in a private registry: a launch
    receipt, a live process the test owns, and the product's own persistence
    binding writing that row. */
async function idleStageHostFixture(h: ReturnType<typeof harness>) {
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const { bindClaudeHostPersistence } = await import("@/lib/runtime/registry");
  await create(h.ports, [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "idle-stage-host-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = crypto.randomUUID();
  const transcriptPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, "{}\n");
  // The host process: a child this test started and ends by the pid recorded here.
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  child.unref();
  const identity = captureProcessIdentity(child.pid!);
  const key = { engine: "claude" as const, sessionId };
  const claimOwner = "structured-host:fixture";
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: directory, transport: "structured", accountId: "account-a" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key, artifactPath: transcriptPath, cwd: directory, accountId: "account-a", status: "idle", host: null,
    structuredHost: { kind: "claude-broker", endpoint: "stdio:fixture", process: identity, eventCursor: 172,
      protocolVersion: "1", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner, pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  attempt.conversationId = begun.receipt.conversationId;
  attempt.agentPath = transcriptPath;
  attempt.launchId = begun.receipt.launchId;
  savePipelines([lane]);
  setAgentRegistryForTests(registry);

  let state: HostState = { status: "idle", sessionKey: sessionId, endpoint: "stdio:fixture", pid: identity.pid,
    processStartIdentity: identity.startIdentity, eventCursor: 172, protocolVersion: "1", activeTurnRef: null,
    pendingAttention: [], activeFlags: [], account: null };
  const listeners = new Set<(next: HostState) => void>();
  const host = {
    releaseCalls: 0,
    setWriterFence(): void {},
    health: async () => structuredClone(state),
    onStateChange(listener: (next: HostState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async release(): Promise<void> { host.releaseCalls += 1; },
    emit(overrides: Partial<HostState>): void {
      state = { ...state, ...overrides };
      for (const listener of listeners) listener(structuredClone(state));
    },
  };
  /* Process evidence for a stop that proceeds. The signal is recorded and
     never sent, so the only process this fixture ever signals is its own child
     in `end`. */
  const signals: string[] = [];
  let ended = false;
  const termination = {
    protectedPids: () => new Set<number>(),
    ppidMap: () => new Map<number, number>([[identity.pid, 1]]),
    processGroupId: () => null,
    pidAlive: (pid: number) => pid === identity.pid && !ended,
    processIdentity: (pid: number) => pid === identity.pid && !ended ? identity.startIdentity : null,
    bootEpoch: () => identity.bootEpoch ?? null,
    signal: (pid: number, signal: NodeJS.Signals) => { signals.push(`${signal}:${pid}`); ended = true; },
    terminateOwnedHost: async () => false,
    sleep: async () => {},
  };
  const row = () => registry.readOnlySnapshot().entries[`claude:${sessionId}`]!;
  const journal = () => {
    const filename = path.join(directory, "host-termination-journal.ndjson");
    return fs.existsSync(filename)
      ? fs.readFileSync(filename, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; source: string; key: string })
      : [];
  };
  const target = { stageId: "build", attempt: attempt.n, launchId: attempt.launchId, conversationId: attempt.conversationId,
    agentPath: transcriptPath, paneId: null };
  const snapshot = () => ({ runtime: { hostEpoch: 7 }, sessions: [
    { conversationId: begun.receipt.conversationId, host: "hosted", turn: "idle", attentionIds: [] },
  ] });
  return {
    registry, key, claimOwner, transcriptPath, attempt, host, child, hostPid: identity.pid, termination, signals, row, journal, target, snapshot,
    bind: (cursorDebounceMs: number) => bindClaudeHostPersistence(registry, key, host as never, claimOwner, 1, "unhosted", { cursorDebounceMs }),
    end: async () => {
      setAgentRegistryForTests(null);
      await stopFixtureProcess(child);
    },
  };
}

/** The runtime's own release as the delivery controller performs it: the
    host's process ends, the host reports `unhosted` through its persistence
    binding, and the row is asked to retire with no confirmed identities. */
function runtimeReleaseOf(f: Awaited<ReturnType<typeof idleStageHostFixture>>, onReleased: () => void = () => {}) {
  const retired: boolean[] = [];
  return {
    retired,
    terminateOwnedHost: async (key: Parameters<typeof f.registry.terminateStructuredHost>[0], expected: Parameters<typeof f.registry.terminateStructuredHost>[1]) => {
      // The fixture's own child, by the pid it recorded; its process probes then answer "gone".
      f.child.kill("SIGKILL");
      f.termination.signal(f.hostPid, "SIGKILL");
      onReleased();
      f.host.emit({ status: "unhosted", endpoint: "stdio:released", pid: null, processStartIdentity: null });
      retired.push(f.registry.terminateStructuredHost(key, expected));
      return true;
    },
  };
}

const SILENT_RUN = [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }];

/** A structured stage that started before the service restarted one minute
    into it, and then worked on for half an hour under the new process. */
async function attemptThatWorkedOnAfterRestart(h: ReturnType<typeof harness>) {
  await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  const bootAt = Date.parse(attempt.startedAt!) + 60_000;
  h.advanceWallClock(30 * 60_000);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
  return { attempt, ports: (interruption: "idle" | "dead"): PipelinePorts => ({ ...h.ports,
    restartRecoveryBootId: () => "boot-2",
    restartRecoveryBootStartedAt: () => bootAt,
    conversationTurnInterrupted: async () => interruption }) };
}

/** A structured stage whose stop ends a live host, and whose host writes one
    more record as it exits. */
async function stageWhoseStopMovesTheTranscript(h: ReturnType<typeof harness>, exit: (agentPath: string) => StageTurnEvidence) {
  await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  const stops: string[] = [];
  const stopStageAgent: PipelinePorts["stopStageAgent"] = async (target) => {
    stops.push(`${target.stageId}:${target.attempt}`);
    if (stops.length > 1) return { outcome: "not-running" };
    h.durableTurns.set(attempt.agentPath!, exit(attempt.agentPath!));
    return { outcome: "stopped" };
  };
  return { attempt, stops, stopStageAgent };
}

function recoveryReport(at: string): import("./types").PipelineStageReport {
  return { seq: 1, calls: 1, at, actor: { kind: "agent", role: "builder", conversationId: "conversation_stage_1" },
    verdict: { status: "pass" }, summary: "Finished work",
    provenance: { head: STAGE_HEAD, branch: "pipeline/test", uncommitted: [], pullRequest: null, outputs: [] } };
}

function expectProviderParkAt(pipeline: Pipeline, at: string): void {
  const events = projectPipelineEvents([pipeline]);
  const blocked = events.filter(event => event.type === "stage_blocked").at(-1)!;
  expect(blocked.at).toBe(at);
  expect(events.filter(event => event.type === "stage_waiting").every(event => Date.parse(event.at) <= Date.parse(blocked.at))).toBe(true);
  expect(projectPipelineEvents([pipeline]).find(event => event.key === blocked.key)).toEqual(blocked);
}

async function providerRecoveryHarness(engine: "claude" | "codex", errorClass: string, text: string, resetDelay: number | null = null, pinned = false) {
  const h = harness();
  await runningStructuredStage(h);
  // Recovery successors use the same structured hosting as the initial stage.
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => ({ ...await baseSpawn(input, reserved), paneId: null });
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  pipeline.stages[0]!.effectiveRole.engine = engine;
  pipeline.stages[0]!.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
  attempt.effectiveRole.engine = engine;
  attempt.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
  if (pinned) {
    pipeline.stages[0]!.account = LIMITED_ACCOUNT;
    if (attempt.definition) attempt.definition.account = LIMITED_ACCOUNT;
  }
  savePipelines([pipeline]);
  const resetsAt = resetDelay === null ? null : Math.floor((now + resetDelay) / 1_000);
  h.ports.claudeAccountReset = () => resetsAt;
  h.ports.accountLabel = () => "account A";
  h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  const sends: string[] = [];
  h.ports.resumeSeveredTurn = async (input) => { sends.push(input.clientMessageId); h.setConversationActive(true); return true; };
  const cut = () => h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal", message: { text, ts: now },
    terminalProviderMessage: { text, ts: now, errorClass,
      ...(errorClass === "rate_limit" || errorClass.startsWith("usage_limit") ? { usageLimit: { resetsAt } } : {}) },
  });
  cut();
  return { h, sends, cut, now: () => now, advance: (ms: number) => { now += ms; }, resetsAt };
}

const parkedAccountCases = (["claude", "codex"] as const).flatMap(engine =>
  (["usage_limit", "auth_required"] as const).map(kind => ({ engine, kind })));

async function parkedAccountHarness(engine: "claude" | "codex", kind: "usage_limit" | "auth_required", pinned = false, resetDelay: number | null = 24 * 60 * 60_000) {
  const f = await providerRecoveryHarness(engine, kind === "auth_required" ? "unauthorized"
    : engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
  kind === "auth_required" ? "Authentication required" : "You've hit your usage limit", resetDelay, pinned);
  const accounts = [{ id: LIMITED_ACCOUNT, authPresent: kind !== "auth_required" }, { id: SPARE_ACCOUNT, authPresent: true }];
  const observations: DurableQuotaObservation[] = [{ engine, accountId: LIMITED_ACCOUNT, authenticated: kind !== "auth_required",
    authCheckedAt: f.h.ports.now(), observedAt: f.h.ports.now(), bootId: "fixture",
    limits: { session: { usedPercent: 100, resetsAt: f.resetsAt }, weekly: null, plan: "pro", capturedAt: f.now() },
    provenance: { source: "live", reason: null, staleSince: null } }];
  let allowed = [LIMITED_ACCOUNT];
  f.h.ports.allowedAccountIds = () => allowed;
  f.h.ports.resolveProjectSpawn = (_engine, input) => {
    const selection = selectProjectAccount({ project: loadPipelines()[0]!.project, engine, accounts, observations,
      bindings: allowed.map(accountId => ({ project: loadPipelines()[0]!.project, engine, accountId, createdAt: f.h.ports.now() })),
      unavailableIds: input.unavailableIds, requestedId: input.requestedId, now: f.now(), model: input.model,
      ...{ requireCapacity: input.requireCapacity } });
    return selection.kind === "available" ? { kind: "available", account: {
      engine, accountId: selection.accountId!, kind: "managed", home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } } : selection;
  };
  const lane = loadPipelines()[0]!;
  if (kind === "usage_limit") lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  return { ...f, accounts, observations, allow: (ids: string[]) => { allowed = ids; } };
}

// Cancellation projections generated by frozen main from signed reviewer
// input followed by a native abort, with a running wait and a parked retry.
const BASE_NOTIFICATION_CANCELLATIONS = [
  { state: "needs_decision", stateDetail: "provider recovery cancelled after newer stage activity; waiting for operator decision",
    attemptState: "needs_decision", error: "provider recovery cancelled after newer stage activity; waiting for operator decision", retryCancelled: true, stageRetry: null },
  { state: "needs_decision", stateDetail: "automatic provider retry cancelled after newer stage activity; waiting for operator decision",
    attemptState: "needs_decision", error: "automatic provider retry cancelled after newer stage activity; waiting for operator decision", retryCancelled: true, stageRetry: null },
] as const;
const SAVED_NOTIFICATION_SCENARIOS = ["automatic", "message", "kill", "pause", "old-pause", "generation", "unreadable", "late-message", "report", "legacy-marker"] as const;

// Transcript records for the cut-chain cases below.
function cutChainKit(f: Awaited<ReturnType<typeof providerRecoveryHarness>>, engine: "claude" | "codex", file: () => string, records: Record<string, unknown>[]) {
  const at = () => f.h.ports.now();
  const write = () => fs.writeFileSync(file(), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const notice = (label: string, reset: number) => {
    if (engine === "codex") records.push({ type: "event_msg", timestamp: at(), payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, resets_at: reset } } } });
    records.push(engine === "claude"
      ? { ...providerQuotaRecord(engine, f.now()), message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: `You've hit your session limit · resets ${label} (Europe/Kyiv)` }] } }
      : providerQuotaRecord(engine, f.now()));
  };
  const operator = (text: string) => records.push(engine === "claude"
    ? { type: "user", uuid: `chain-operator-${f.now()}`, timestamp: at(), promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: text } }
    : { type: "event_msg", timestamp: at(), payload: { type: "user_message", message: text } });
  const harnessWake = async () => {
    if (engine === "claude") records.push({ type: "user", timestamp: at(), origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system", message: { content: "<task-notification>done</task-notification>" } });
    else {
      const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
      records.push({ type: "event_msg", timestamp: at(), payload: { type: "user_message", message: await encodeCodexStructuredUserText("Continue the interrupted turn from the transcript.", undefined, null, { kind: "agent", role: "startup-recovery" } as never) } });
    }
  };
  const output = (busy = false) => records.push(engine === "claude"
    ? busy ? { type: "assistant", timestamp: at(), message: { model: "claude-opus", stop_reason: "tool_use", content: [{ type: "tool_use", id: `chain-tool-${f.now()}`, name: "Read", input: {} }] } }
      : { type: "assistant", timestamp: at(), message: { model: "claude-opus", stop_reason: null, content: [{ type: "text", text: "Working on the stage" }] } }
    : busy ? { type: "response_item", timestamp: at(), payload: { type: "function_call", call_id: `chain-call-${f.now()}`, name: "shell", arguments: "{}" } }
      : { type: "event_msg", timestamp: at(), payload: { type: "agent_message", message: "Working on the stage" } });
  const finishTool = () => { if (engine === "codex") records.push(...records.filter(record => (record.payload as { type?: string } | undefined)?.type === "function_call")
    .map(record => ({ type: "response_item", timestamp: at(), payload: { type: "function_call_output", call_id: (record.payload as { call_id: string }).call_id, output: "ok" } }))); };
  return { at, write, notice, operator, harnessWake, output, finishTool };
}

const CHAIN_RESET = { "10pm": Date.parse("2026-10-05T19:00:00Z") / 1000, "2am": Date.parse("2026-10-05T23:00:00Z") / 1000, "3am": Date.parse("2026-10-06T00:00:00Z") / 1000 };

// Capacity and authentication cut records.
function otherKindCut(f: Awaited<ReturnType<typeof providerRecoveryHarness>>, engine: "claude" | "codex", records: Record<string, unknown>[], kind: "capacity" | "auth") {
  const at = f.h.ports.now();
  const text = kind === "auth" ? "OAuth session expired and could not be refreshed"
    : engine === "claude" ? "API Error: Repeated 529 Overloaded errors" : "Selected model is at capacity. Please try a different model.";
  records.push(engine === "claude"
    ? { type: "assistant", timestamp: at, isApiErrorMessage: true, error: kind === "auth" ? "authentication_failed" : "overloaded",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text }] } }
    : { type: "event_msg", timestamp: at, payload: { type: "task_complete", error: { message: text, codex_error_info: kind === "auth" ? "unauthorized" : "server_overloaded" } } });
}

// A native tool result over the read bound, in history a chain already closed.
function largeToolResult(f: Awaited<ReturnType<typeof providerRecoveryHarness>>, engine: "claude" | "codex", records: Record<string, unknown>[], bytes: number) {
  const call = records.findLast(record => engine === "claude" ? record.type === "assistant" : (record.payload as { type?: string } | undefined)?.type === "function_call");
  const id = engine === "claude" ? ((call?.message as { content: Array<{ id: string }> }).content[0]!.id) : (call?.payload as { call_id: string }).call_id;
  records.push(engine === "claude"
    ? { type: "user", timestamp: f.h.ports.now(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(bytes) }] } }
    : { type: "response_item", timestamp: f.h.ports.now(), payload: { type: "function_call_output", call_id: id, output: "x".repeat(bytes) } });
}

const PREPUBLICATION_INTERRUPTION = "staged launch was released before publication completed";

async function publicationInterruptedReview(access: "read-only" | "read-write", parked: boolean) {
  const h = harness();
  const advance = frozenWallClock(h);
  const box = publishHarness(h);
  await create(h.ports, [PUBLISH_STAGES[0], {
    id: "review", kind: "run", role: { roleId: "reviewer" }, engine: "codex", access,
    "prompt": "Review {{input}}", next: null,
  }] as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "published work")], h.ports);
  const pipeline = loadPipelines()[0]!;
  const stage = pipeline.stages.find((item) => item.id === "review")!;
  const run = pipeline.runs.find((item) => item.stageId === "review")!;
  const attempt = {
    ...structuredClone(pipeline.runs[0]!.attempts[0]!), n: 2,
    state: parked ? "needs_decision" : "pending", effectiveRole: stage.effectiveRole,
    launchId: parked ? "launch-publication-cut" : null,
    conversationId: parked ? "conversation_publication_cut" : null,
    sessionId: null, agentPath: null, paneId: null, flowId: null,
    verdict: null, output: null, completedAt: null, report: undefined,
    startedAt: h.ports.now(), error: parked ? PREPUBLICATION_INTERRUPTION : null,
    input: pipeline.cursor!.input, spawnCalls: parked ? 1 : 0,
    definition: undefined,
  } as typeof run.attempts[number];
  run.attempts = [{ ...structuredClone(attempt), n: 1, state: "failed", completedAt: h.ports.now(), error: "interrupted by restart" }, attempt];
  pipeline.cursor!.state = parked ? "spawning" : "pending";
  pipeline.state = parked ? "needs_decision" : "running";
  pipeline.stateDetail = parked ? PREPUBLICATION_INTERRUPTION : null;
  savePipelines([pipeline]);
  const baseSpawn = h.ports.spawnAgent;
  const callIds: string[] = [];
  let reservations = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    callIds.push(input.clientAttemptId);
    if (!parked && ++reservations === 1) {
      await onReserved({ launchId: "launch-publication-cut", conversationId: "conversation_publication_cut" });
      throw new Error(PREPUBLICATION_INTERRUPTION);
    }
    return baseSpawn(input, onReserved);
  };
  const originalReceipt = h.ports.spawnReceipt;
  h.ports.spawnReceipt = (id) => id === "launch-publication-cut"
    ? { ...failedReceipt(id, "conversation_publication_cut", "structured spawn interrupted before identity staging: launch-publication-cut"), staged: true }
    : originalReceipt(id);
  const claims: string[] = [];
  const stops: string[] = [];
  const evidence: string[] = [];
  h.ports.claimSpawnRetry = (id) => { claims.push(id); return "claimed"; };
  h.ports.stopStageAgent = async (target) => { stops.push(target.launchId!); return { outcome: "stopped" }; };
  Object.assign(h.ports, {
    unpublishedLaunchRetrySafe: async (id: string) => { evidence.push(id); return true; },
    sleep: forbiddenSleep,
  });
  return { h, box, callIds, claims, stops, evidence, advance };
}
export { stopFixtureProcess, afterAll, expect, spyOn, test, crypto, spawn, spawnSync, fs, net, os, path, monitorEventLoopDelay, Database, laneMovedAt, activeDrain, DRAIN_LEASE_MS, initialAuto, writeAuto, initialCheck, SelfUpdateService, idleCheck, idleUpdate, stoppedProcess, endRestartGate, restartGateFile, ACCOUNT_STORE_BUSY_MESSAGE, AccountMutationBusyError, accountManager, AccountAuthenticationRequiredError, ProjectAccountRefusedError, selectProjectAccount, CONTROLLER_ARTIFACT_GIT_PATHS, realExec, worktreeDiskWait, engineModule, IDLE_TURN_QUIET_MS, interruptedTurnRecoveryParkDetail, adoptAttempt, defaultPipelinePorts, ensureTaskPipelineForAssignment, rawPatchPipeline, pipelineAttemptTargetForSource, pipelineClaudePermissionMode, reconcileEmbeddedReviewFlows, reviewNote, setPipelineDismissal, terminalFlowStageVerdict, tickPipelines, verdictRoutesAsFail, AgentRegistry, setAgentRegistryForTests, newRound, setRelayDeliveryForTest, tickFlow, saveFlows, isRecoverableLegacyRelayFailurePause, MAX_FLOW_NOTE_LENGTH, rawCreatePipelineFromRequest, createPipelineFromRequest, registerPipelineTick, loadPipelines, savePipelines, pipelineIdentity, pipelineRevision, durableStageTurnEvidence, projectPipelineEvents, edgeRoundsUsed, FAIL_EDGE_BUDGET_SPENT_DETAIL, failEdgeMaxRounds, failEdgeRoundsUsed, pipelineCompletedUnreviewed, loadTasks, saveTasks, asStoredLegacyReviewLane, interruptionObligationDirectory, interruptionObligationStore, patchPipeline, closeAndDrain, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, REMOTE_BRANCH, finishReported, realWorktreeLane, successorOnPullRequestBranch, create, exhaustVerdictRecovery, withRuntimeSnapshot, boardTask, SLOW_FETCH_MS, FETCHED_SHA, slowRemote, provisionRetryClock, DNS_FAILURE, realProvisioningRepo, DEPLOY_WINDOW_MS, forbiddenSleep, frozenWallClock, HISTORICAL_VERDICT_MISS, DEPLOY_CUT_HOLD, READ_ONLY_RERUN, deployCutObligations, structuredLatest, reviewParkedAfterRestart, STAGE_HEAD, PASS_TEXT, makeStructuredAttempt, stalledEntry, countDurableReads, pinStageHead, runningStructuredStage, SSH_CONNECT_TIMEOUT, approvedReviewAwaitingRemote, networkDown, NO_CODE_TEST_STAGES, persistedCommittingReview, PROVIDER_LIMIT_NOTICE, LIMITED_ACCOUNT, SPARE_ACCOUNT, LIMITED_ACCOUNT_LABEL, SPARE_ACCOUNT_LABEL, stageTranscript, limitInterruptedTranscript, codexUsageLimitTranscript, verdictTranscript, silentTranscript, readFixtures, providerQuotaRecord, stampPipelinePrompt, severedToolTranscript, truncatedMidTurnTranscript, usageLimitPorts, usageLimitStage, reviewPipeline, reviewStage, noteOf, CYCLE_STAGES, BUDGET_STAGES, failEveryCritique, STOP_AFTER_FIX, REVIEW_HEADS, movingHeadHarness, critiqueRound, buildRound, continueReview, movingHead, acceptHead, driveWithController, seedLegacyTerminalRecheck, driveLegacyTerminalRecheck, CONVERTED_REVIEWER_EDGE, expectConvertedReview, REVIEW_LOOP_STAGE, BUILD_ONLY, publishHarness, PUBLISH_STAGES, deliveryRefusalPark, interruptedPublication, SKIP_STAGES, FAIL_EDGE_STAGES, HOST_UNAVAILABLE, failedReceipt, UNVERIFIED_DELIVERY, reviewFlowPausedOnUnscannedImplementer, REVIEWER_BUSY, reviewFlowEndedOnBusyAccount, interruptedSpawnAttempt, legacySpawnAttempt, stageDigest, buildStageOf, REVIEW_FINDING_BLOCK, flowWithFindings, parkedReviewStage, stagedRecoveryHarness, aliveStagedLaunch, stageHostChild, productionHostSeams, activationDrainFixture, expectPipelineLeaseFree, reserveActivationOnly, expectPipelineLeaseAbsent, frozenSurvivorStartup, restartCutStage, cutByRestart, idleStageHostFixture, runtimeReleaseOf, SILENT_RUN, attemptThatWorkedOnAfterRestart, stageWhoseStopMovesTheTranscript, recoveryReport, expectProviderParkAt, providerRecoveryHarness, parkedAccountCases, parkedAccountHarness, BASE_NOTIFICATION_CANCELLATIONS, SAVED_NOTIFICATION_SCENARIOS, cutChainKit, CHAIN_RESET, otherKindCut, largeToolResult, PREPUBLICATION_INTERRUPTION, publicationInterruptedReview };
export type { CreateFlowRequest, Flow, BoardTask, FileEntry, ServiceDeps, Snapshot, LauncherRecord, AgentRegistryType, DurableQuotaObservation, PipelinePorts, Pipeline, PipelineStageStopResult, StageTurnEvidence, HostState };
