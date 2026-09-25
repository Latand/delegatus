import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import type { AgentRegistry, AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { attentionReason, buildAttentionQueue } from "@/components/attention";
import { readLifecycleJournal, type LifecycleEventInput } from "@/lib/lifecycle/journal";
import { agentLivenessSnapshot, type AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { buildPipeline, findPipelineRecord, withPipelineMutation } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import type { FileEntry } from "@/lib/types";

import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import type { HostState, RuntimeEvent } from "./engineHost";
import { FileRuntimeEventStore } from "./eventStore";
import { FAKE_SAFETY_COMMAND, FAKE_SAFETY_REASON } from "./fixtures/fakeClaudePermissionCli";
import { permissionAttendance, PermissionRequestGuard, type PermissionDenialRecord } from "./permissionGuard";
import { permissionDenialRecorder } from "./permissionDenials";
import { ATTENDED_PERMISSION_TIMEOUT_MS, NO_APPROVER_LINE } from "./permissionRequests";
import { claudeHostColumns } from "./registry";

/*
 * #2215, end to end below the controller: a real child process speaking
 * Claude's stream-json raises the safety-check permission request in the middle
 * of a turn, the real structured host records it, and the guard answers it the
 * way production does. Everything durable lands in a sandboxed state directory.
 */

const FAKE_CLI = path.join(import.meta.dir, "fixtures", "fakeClaudePermissionCli.ts");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-permission-guard-"));
const ORIGINAL_STATE_DIR = process.env.LLV_STATE_DIR;
const hosts: ClaudeStreamBrokerHost[] = [];

beforeAll(() => {
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.release().catch(() => {});
});

afterAll(() => {
  if (ORIGINAL_STATE_DIR === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE_DIR;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Harness {
  host: ClaudeStreamBrokerHost;
  events: RuntimeEvent[];
  states: HostState[];
  answers: () => Array<{ requestId: string; answer: Record<string, unknown> }>;
}

async function startHost(name: string, onEvent: (host: ClaudeStreamBrokerHost, event: RuntimeEvent) => void): Promise<Harness> {
  const directory = path.join(sandbox, name);
  fs.mkdirSync(directory, { recursive: true });
  const answersPath = path.join(directory, "answers.jsonl");
  const host = await ClaudeStreamBrokerHost.start({
    cwd: directory,
    binary: "claude",
    env: { ...process.env, PATH: process.env.PATH ?? "", HOME: directory },
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    readTranscript: () => [],
    eventStore: new FileRuntimeEventStore(path.join(directory, "events")),
    deliveryLedger: new FileClaudeDeliveryLedger(path.join(directory, "deliveries")),
    permissionMode: "bypassPermissions",
    spawnProcess: (_command, args, options) => spawn(process.execPath, [FAKE_CLI, ...args], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_ANSWERS: answersPath } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams,
  });
  hosts.push(host);
  const events: RuntimeEvent[] = [];
  const states: HostState[] = [];
  host.onStateChange((state) => states.push(structuredClone(state)));
  const iterator = host.attach(0)[Symbol.asyncIterator]();
  void (async () => {
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      events.push(next.value);
      onEvent(host, next.value);
    }
  })().catch(() => {});
  return {
    host,
    events,
    states,
    answers: () => fs.existsSync(answersPath)
      ? fs.readFileSync(answersPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [],
  };
}

const NOW = Date.now();

/** Liveness over one structured Claude host, the registry row built from the
    host's own state the way persistence builds it. */
async function activityFor(state: HostState, transcriptPath: string) {
  const entry: AgentRegistryEntry = {
    key: { engine: "claude", sessionId: state.sessionKey } as AgentRegistryEntry["key"],
    artifactPath: transcriptPath,
    cwd: "/repo",
    accountId: null,
    status: "live",
    host: null,
    structuredHost: claudeHostColumns({ ...state, pid: process.pid, processStartIdentity: "start" }, 1),
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
    updatedAt: new Date(NOW).toISOString(),
  } as AgentRegistryEntry;
  const sources: AgentLivenessSources = {
    now: () => NOW,
    probe: { now: () => NOW, pidAlive: () => true, processIdentity: () => "start" },
    listFiles: async () => [{
      path: transcriptPath, project: "viewer", title: "stage", engine: "claude", activity: "live", activityReason: null,
      mtime: NOW / 1000, size: 10, conversationId: null,
    } as unknown as FileEntry],
    registrySnapshot: () => ({ entries: { [`claude:${state.sessionKey}`]: entry }, conversations: {} }) as unknown as RegistryFile,
    pipelines: () => [],
    describeTranscript: async () => null,
    /* A transcript silent for fifty minutes: the shape both wedged stages had. */
    transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: NOW - 50 * 60_000 }),
  };
  return (await agentLivenessSnapshot({}, sources)).conversations[0]!;
}

function stagePipeline(conversationId: string): Pipeline {
  /* The stage names no role; the attempt carries the builder role it ran as. */
  const stageRole = { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const effectiveRole = { ...stageRole, roleId: "builder", promptScaffold: "Build it." } as const;
  const pipeline = buildPipeline({
    id: "pipeline_permission",
    task: "clean the scratch tree",
    project: "viewer",
    repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: "build", next: null, effectiveRole: stageRole } as unknown as PipelineStage],
    srcPath: null,
    srcConversationId: null,
    now: new Date(NOW).toISOString(),
  });
  const attempt = {
    n: 1,
    state: "running",
    effectiveRole,
    launchId: "launch_stage",
    conversationId,
    sessionId: "session-stage",
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt: new Date(NOW).toISOString(),
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  } as unknown as PipelineStageAttempt;
  pipeline.runs[0]!.attempts.push(attempt);
  pipeline.state = "running";
  pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null } as Pipeline["cursor"];
  return pipeline;
}

const identityRegistry = {
  canonicalConversationId: (id: string) => id,
  conversation: () => null,
} as unknown as AgentRegistry;

test("attendance: a stage or a delegated spawn is unattended; the operator's own session and a seat are attended", () => {
  expect(permissionAttendance({ memberships: [{ kind: "pipeline" }], delegationDepth: 1, seat: false })).toBe("unattended");
  expect(permissionAttendance({ memberships: [], delegationDepth: 2, seat: false })).toBe("unattended");
  expect(permissionAttendance({ memberships: [], delegationDepth: 0, seat: false })).toBe("attended");
  expect(permissionAttendance({ memberships: [], delegationDepth: null, seat: false })).toBe("attended");
  /* A seat is launched for the operator and answers to them, whatever its depth. */
  expect(permissionAttendance({ memberships: [], delegationDepth: 1, seat: true })).toBe("attended");
  /* A pipeline membership outranks everything: a stage has no one to ask. */
  expect(permissionAttendance({ memberships: [{ kind: "pipeline" }], delegationDepth: 0, seat: true })).toBe("unattended");
});

test("a stage's safety-check permission request is denied at once and its turn finishes (#2215)", async () => {
  const conversationId = "conversation_stage";
  await withPipelineMutation((pipelines, persist) => {
    pipelines.push(stagePipeline(conversationId));
    persist();
  });
  const recorded: PermissionDenialRecord[] = [];
  const record = permissionDenialRecorder({ registry: identityRegistry });
  const guard = new PermissionRequestGuard({
    attendance: () => "unattended",
    record: async (denial) => {
      recorded.push(denial);
      await record(denial);
    },
  });
  const harness = await startHost("unattended", (host, event) => guard.observe("claude:stage", host, conversationId, event));

  const receipt = await harness.host.send({ id: "turn-1", text: "clean the scratch tree" });
  expect(receipt.outcome).toBe("turn-started");
  const ended = await waitFor(() => harness.events.find((event) => event.kind === "turn-ended"), "the turn to end");
  expect(ended).toMatchObject({ turnId: "turn-1", status: "completed" });

  /* The request the CLI raised mid-turn, as the host recorded it. */
  const attention = harness.events.find((event) => event.kind === "attention");
  expect(attention).toMatchObject({ method: "can_use_tool", attention: { tool_name: "Bash", decision_reason_type: "safetyCheck", classifier_approvable: false } });
  /* Answered with deny, the engine's reason verbatim and the one line after it. */
  expect(harness.answers()).toEqual([{
    requestId: "request-1",
    answer: { behavior: "deny", message: `${FAKE_SAFETY_REASON}\n${NO_APPROVER_LINE}` },
  }]);
  expect(harness.events.find((event) => event.kind === "attention-resolved")).toMatchObject({ id: "request-1", resolution: "answered" });
  /* The turn went on: the model's next step after the denial. */
  expect(JSON.stringify(harness.events.filter((event) => event.kind === "item"))).toContain("rewrote it with a guarded path");

  /* While it was pending, activity said so: a permission, not the provider. */
  const pendingState = harness.states.find((state) => (state.pendingPermissions?.length ?? 0) > 0);
  expect(pendingState?.pendingPermissions?.[0]).toMatchObject({
    id: "request-1", tool: "Bash", command: FAKE_SAFETY_COMMAND, reason: FAKE_SAFETY_REASON, reasonType: "safetyCheck",
  });
  expect(await activityFor(pendingState!, path.join(sandbox, "stage.jsonl"))).toMatchObject({
    lifecycle: "waiting",
    reason: "permission_request",
    permission: { tool: "Bash", command: FAKE_SAFETY_COMMAND, reason: FAKE_SAFETY_REASON },
  });
  const finalState = await harness.host.health();
  expect(finalState.pendingPermissions).toEqual([]);
  expect(await activityFor(finalState, path.join(sandbox, "stage.jsonl"))).not.toMatchObject({ reason: "permission_request" });

  /* Recorded on the stage attempt and in the lifecycle journal. */
  await waitFor(() => recorded.length > 0 && readLifecycleJournal().events.length > 0, "the denial to be recorded");
  expect(recorded[0]).toMatchObject({ conversationId, requestId: "request-1", tool: "Bash", mode: "unattended", reason: FAKE_SAFETY_REASON });
  const attempt = findPipelineRecord("pipeline_permission")!.runs[0]!.attempts[0]!;
  expect(attempt.permissionDenials).toEqual([expect.objectContaining({
    requestId: "request-1", tool: "Bash", command: FAKE_SAFETY_COMMAND, reason: FAKE_SAFETY_REASON, reasonType: "safetyCheck", mode: "unattended",
  })]);
  expect(readLifecycleJournal().events).toEqual([expect.objectContaining({
    type: "permission_denied",
    state: "running",
    project: "viewer",
    pipelineId: "pipeline_permission",
    stageId: "build",
    attempt: 1,
    conversationId,
    role: "builder",
  })]);
  expect(readLifecycleJournal().events[0]!.summary).toContain("Denied Bash permission (no one can approve it here)");
}, 30_000);

test("an attended request is a Needs-you item, answerable by the operator, and denied after ten minutes unanswered (#2215)", async () => {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const recorded: PermissionDenialRecord[] = [];
  const guard = new PermissionRequestGuard({
    attendance: () => "attended",
    record: (denial) => { recorded.push(denial); },
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  const harness = await startHost("attended", (host, event) => guard.observe("claude:operator", host, "conversation_operator", event));

  /* Turn one: the operator answers it. */
  await harness.host.send({ id: "turn-1", text: "clean the scratch tree" });
  const pending = await waitFor(() => harness.states.find((state) => (state.pendingPermissions?.length ?? 0) > 0), "the request to be pending");
  await waitFor(() => timers.length === 1, "the attended timer");
  expect(timers[0]!.delayMs).toBeGreaterThan(ATTENDED_PERMISSION_TIMEOUT_MS - 5_000);
  expect(timers[0]!.delayMs).toBeLessThanOrEqual(ATTENDED_PERMISSION_TIMEOUT_MS);
  expect(harness.answers()).toEqual([]);

  /* The Needs-you item names the tool, the command and the reason. */
  const file = {
    path: "/transcripts/operator.jsonl", project: "viewer", title: "operator session", mtime: NOW / 1000,
    pendingQuestion: null, waitingInput: null, pendingPermission: pending.pendingPermissions![0],
  } as unknown as FileEntry;
  const reason = attentionReason(file, NOW / 1000)!;
  expect(reason).toMatchObject({ kind: "permission", id: "/transcripts/operator.jsonl:permission:request-1" });
  expect(reason.header).toContain("Bash");
  expect(reason.header).toContain(FAKE_SAFETY_COMMAND);
  expect(reason.header).toContain("Dangerous rm operation");
  expect(buildAttentionQueue([file], NOW / 1000).map((item) => item.reason.kind)).toEqual(["permission"]);

  /* Allow once, the resolution `conversation_action permission` submits. */
  await harness.host.answer("request-1", { behavior: "allow" });
  await waitFor(() => harness.events.find((event) => event.kind === "turn-ended"), "turn one to end");
  expect(harness.answers()[0]).toMatchObject({ requestId: "request-1", answer: { behavior: "allow" } });
  expect(JSON.stringify(harness.events)).toContain("Cleared the scratch tree.");
  expect(timers[0]!.cleared).toBeTrue();
  expect(guard.pendingTimers()).toBe(0);

  /* Turn two: nobody answers, and the wait runs out. */
  await harness.host.send({ id: "turn-2", text: "clean it again" });
  await waitFor(() => timers.length === 2, "the second request's timer");
  expect(harness.answers()).toHaveLength(1);
  timers[1]!.callback();
  await waitFor(() => harness.events.filter((event) => event.kind === "turn-ended").length === 2, "turn two to end");
  expect(harness.answers()[1]).toEqual({
    requestId: "request-2",
    answer: { behavior: "deny", message: `${FAKE_SAFETY_REASON}\n${NO_APPROVER_LINE}` },
  });
  await waitFor(() => recorded.length === 1, "the timeout denial to be recorded");
  expect(recorded[0]).toMatchObject({ conversationId: "conversation_operator", requestId: "request-2", mode: "timeout" });
}, 30_000);

test("a request the host already holds when the guard attaches is answered from its own clock", () => {
  const timers: Array<{ delayMs: number }> = [];
  const answered: Array<[string, unknown]> = [];
  const host = { answer: async (id: string, value: unknown) => { answered.push([id, value]); } };
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const request = { id: "held", tool: "Bash", command: "rm -rf $X", reason: "flagged", reasonType: "safetyCheck", since: new Date(now - 4 * 60_000).toISOString() };
  const attended = new PermissionRequestGuard({
    attendance: () => "attended",
    record: () => {},
    now: () => now,
    setTimer: (_callback, delayMs) => { timers.push({ delayMs }); return timers.length; },
    clearTimer: () => {},
  });
  attended.adopt("claude:a", host, "conversation_a", { pendingPermissions: [request] });
  /* Four of its ten minutes are already spent. */
  expect(timers).toEqual([{ delayMs: 6 * 60_000 }]);
  /* A replay of the same request schedules nothing more. */
  attended.adopt("claude:a", host, "conversation_a", { pendingPermissions: [request] });
  expect(timers).toHaveLength(1);

  const unattended = new PermissionRequestGuard({ attendance: () => "unattended", record: () => {}, now: () => now });
  unattended.adopt("claude:b", host, "conversation_b", { pendingPermissions: [request] });
  expect(answered).toEqual([["held", { behavior: "deny", message: `flagged\n${NO_APPROVER_LINE}` }]]);
});

test("a denial the pipeline lease refuses is retried onto the attempt, and the journal names the stage regardless", async () => {
  const conversationId = "conversation_busy";
  const denial: PermissionDenialRecord = {
    conversationId,
    requestId: "request-busy",
    tool: "Bash",
    command: FAKE_SAFETY_COMMAND,
    reason: FAKE_SAFETY_REASON,
    reasonType: "safetyCheck",
    mode: "unattended",
    deniedAt: new Date(NOW).toISOString(),
  };
  const busy = () => new StoreBusyBeforeAdmissionError("pipeline store busy before admission");
  const recorderFor = (pipelines: Pipeline[], refusals: number) => {
    const events: LifecycleEventInput[] = [];
    let calls = 0;
    const record = permissionDenialRecorder({
      registry: identityRegistry,
      readPipelines: () => structuredClone(pipelines),
      mutatePipelines: (async (mutate) => {
        calls += 1;
        if (calls <= refusals) throw busy();
        return mutate(pipelines, () => {});
      }) as typeof withPipelineMutation,
      appendLifecycle: (input) => { events.push(...input); return { appended: [], skipped: 0 }; },
      busyRetryDelayMs: 1,
    });
    return { record, events, calls: () => calls };
  };
  const lineage = { project: "viewer", pipelineId: "pipeline_permission", stageId: "build", attempt: 1, role: "builder" };

  /* The first write is refused before admission; the retry lands it. */
  const contended = [stagePipeline(conversationId)];
  const once = recorderFor(contended, 1);
  await once.record(denial);
  expect(once.calls()).toBe(2);
  expect(contended[0]!.runs[0]!.attempts[0]!.permissionDenials).toEqual([
    expect.objectContaining({ requestId: "request-busy", tool: "Bash", reason: FAKE_SAFETY_REASON, mode: "unattended" }),
  ]);
  expect(once.events).toEqual([expect.objectContaining({ type: "permission_denied", conversationId, ...lineage })]);

  /* Refused every time: the attempt cannot hold it, the journal still names the stage. */
  const blocked = [stagePipeline(conversationId)];
  const always = recorderFor(blocked, Number.POSITIVE_INFINITY);
  await always.record(denial);
  expect(always.calls()).toBe(3);
  expect(blocked[0]!.runs[0]!.attempts[0]!.permissionDenials).toBeUndefined();
  expect(always.events).toEqual([expect.objectContaining({ type: "permission_denied", conversationId, ...lineage })]);
});
