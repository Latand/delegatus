import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { shortId } from "@/lib/shortIds";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-sources-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
process.env.OPENCLAW_STATE_DIR = path.join(SANDBOX, "openclaw");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
/* A scanner root this sandbox owns, and where a fixture child's transcript
   goes (#1783): a child whose transcript the Viewer cannot resolve is never
   projected as harvestable, so a transcript written nowhere the scanner looks
   stops exercising the projection. `OPENCLAW_STATE_DIR` is resolved per call;
   `os.homedir()` does not read `HOME`, so the other roots stay the machine's. */
const SESSIONS = path.join(SANDBOX, "openclaw", "agents", "fixtures", "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });

const { gatherSeatTickInput: gatherProduction, refreshSeatTickInput, readRetirementJournalWindow, repoDirForProject, RETIREMENT_STALL_WINDOW_MS, runtimeWakeState, seatTickProjects, selfUpdateSignals, stalledRetirementClause, wakeStateFromRecord, withdrawRuntimeWake } = await import("./seatTickSources");
const { SeatTickAccounting } = await import("./seatTickAccounting");
const { SEND_UNVERIFIED_REASON, resolveOriginalSend } = await import("@/lib/runtime/sendSettlement");
const { FileRuntimeEventStore } = await import("@/lib/runtime/eventStore");
const { statePath } = await import("@/lib/configDir");
const gatherSeatTickInput: typeof gatherProduction = (project, state, policy, ports) => {
  if (state.accounting) return gatherProduction(project, state, policy, ports);
  const dir = fs.mkdtempSync(path.join(SANDBOX, "gather-state-"));
  const accounting = new SeatTickAccounting(path.join(dir, "state.sqlite"), project);
  accounting.initialize(state, null);
  return gatherProduction(project, accounting.readState(), policy, ports);
};
const { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { SqliteAgentRegistryStore } = await import("@/lib/agent/sqliteRegistryStore");
const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
const { wakeRecordPorts } = await import("./seatTickSources");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");

test("self-update sends one wait or off signal from its durable state", () => {
  const quiet = { waitingTarget: null, lastBlockers: null, pending: null };
  expect(selfUpdateSignals({ ...quiet, off: null, noticeAt: null, waitingSince: null })).toEqual([]);
  expect(selfUpdateSignals({ ...quiet, waitingTarget: "a".repeat(40), off: null, noticeAt: "2026-01-02", waitingSince: "2026-01-01" })).toEqual([]);
  expect(selfUpdateSignals({ ...quiet, off: { at: "2026-01-02", target: "a".repeat(40), stage: "build", reason: "build failed" }, noticeAt: null, waitingSince: null })).toMatchObject([{ id: "self-update-off" }]);
});

test("drain notice names unfinished work and the operator choices", () => {
  const drain = { id: "drain", target: { sha: "a".repeat(40), short: "aaaaaaa", version: "1", date: "" }, since: "2026-01-01T04:00:00Z", overranAt: "2026-01-01T06:00:00Z",
    blockers: { turns: 1, stages: 1, busy: false, memoryMb: null, unreadable: null, operatorActiveAt: null,
      stageList: [{ pipelineId: "pipeline_example", stageId: "build", task: "Finish the feature", cursor: "running", conversationId: "conversation_work" }] } };
  expect(selfUpdateSignals({ off: null, waitingSince: drain.since, waitingTarget: drain.target.sha, lastBlockers: null, pending: null, noticeAt: null, drain }))
    .toMatchObject([{ id: "self-update-drain-overran", label: expect.stringContaining("build · Finish the feature") }]);
  expect(selfUpdateSignals({ off: null, waitingSince: drain.since, waitingTarget: drain.target.sha, lastBlockers: null, pending: null, noticeAt: null, drain })[0]!.label)
    .toContain("deploy now or keep waiting");
});
const { sessionKeyFromTranscript } = await import("@/lib/agent/sessionKey");
const { projectForCwd } = await import("@/lib/scanner/describe");
import type { OriginalSendEvidence, SendReceipt } from "@/lib/runtime/sendSettlement";
import type { SeatTickJournalReceipt } from "./seatTickSources";
import type { SeatTickSources } from "./seatTickSources";
const { DEFAULT_SEAT_TICK_POLICY, seatTickBoardMoved, seatTickDecision, seatTickReportLines, seatTickWakeCommit, seatTickWakeCommitPlan } = await import("./seatTick");
const { defaultSeatTickSettings } = await import("./seatTickSettings");
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import type { OpenPullRequest, OpenPullRequestsUnavailable } from "./githubEvidence";
import type { LifecycleEvent, LifecycleJournalFile } from "@/lib/lifecycle/journal";
import { emptySeatTickState, type SeatTickOutstandingWake, type SeatTickProjectState } from "./types";

/**
 * The gathering half of the tick (#1245): the projection the pure pre-check
 * decides over.
 *
 * Its two pieces of judgement are the ones the whole verdict rests on — where
 * a stall comes from (the registry's activity verdict, never a subtraction over
 * attempt timestamps) and what counts as unread (the tick's own cursor, which
 * only a delivered wake advances).
 */

const PROJECT = "viewer";
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const STAGE_CONVERSATION = ["conversation", "3d81ac55e0b1742f"].join("_");
const TRANSCRIPT = "/srv/agents/build.jsonl";
const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function lane(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pipeline_a1",
    task: "ship the exporter",
    taskIds: [],
    project: PROJECT,
    repoDir: "/srv/repo",
    worktreeDir: "/srv/worktree",
    branch: "topic",
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", conversationId: STAGE_CONVERSATION, agentPath: TRANSCRIPT, startedAt: "2026-08-28T11:00:00.000Z" }] }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-08-28T09:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

test("a restarted attempt on the same stage inherits no earlier attempt's liveness", async () => {
  let current = lane();
  const ports = sources({});
  ports.pipelines = () => [current] as never;
  const liveness = ports.liveness;
  ports.liveness = async (request) => {
    if (!request.project) return liveness(request);
    current = lane({ runs: [{ stageId: "build", attempts: [{ n: 2, state: "running", conversationId: "replacement-worker", startedAt: new Date(NOW - 60_000).toISOString() }] }] });
    return [livenessRow({ lifecycle: "gone", reason: "host_gone_turn_settled" })];
  };
  const state = { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 60_000).toISOString(), stalledSeen: ["pipeline_a1"] };
  const input = refreshSeatTickInput(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports), ports);
  expect(input.pipelines[0]!.stageActivity).toBeNull();
  const decision = seatTickDecision(input);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons.some((reason) => reason.kind === "stalled")).toBe(false);
});

test("lane liveness is selected only from its current stage, attempt and conversation", async () => {
  const current = lane({ runs: [{ stageId: "build", attempts: [{ n: 2, state: "running", conversationId: "replacement-worker", startedAt: new Date(NOW - 60_000).toISOString() }] }] });
  const live = livenessRow({ conversationId: "replacement-worker", pipeline: { ...livenessRow().pipeline!, attempt: 2 }, lifecycle: "running", reason: "host_alive_turn_active" });
  for (const stale of [
    { ...live, pipeline: { ...live.pipeline!, stageId: "review" } },
    { ...live, pipeline: { ...live.pipeline!, attempt: 1 } },
    { ...live, conversationId: STAGE_CONVERSATION },
  ]) {
    const ports = sources({ pipelines: [current], laneRows: [{ ...stale, lifecycle: "gone", reason: "host_gone_turn_settled" }, live] });
    const state = { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 60_000).toISOString(), stalledSeen: ["pipeline_a1"] };
    const input = refreshSeatTickInput(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports), ports);
    expect(input.pipelines[0]!.stageActivity?.lifecycle).toBe("running");
    const decision = seatTickDecision(input);
    expect(decision.verdict.kind === "wake" && decision.verdict.reasons.some((reason) => reason.kind === "stalled")).toBe(false);
  }
});

const DAY_MS = 24 * 60 * 60_000;

/** A board card as the store holds one. `updatedAt` is the field the backlog
    bound reads and the change fingerprint carries, so every case below sets it
    deliberately. */
function boardCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task_b2",
    project: PROJECT,
    status: "assigned",
    text: "wire the chip",
    placement: "unplaced",
    assignments: [],
    createdAt: new Date(NOW - 90 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
    ...over,
  };
}

function livenessRow(over: Partial<AgentLivenessRecord> = {}): AgentLivenessRecord {
  return {
    conversationId: STAGE_CONVERSATION,
    transcriptPath: TRANSCRIPT,
    project: PROJECT,
    engine: "claude",
    title: "build",
    lastRecordAt: null,
    turnState: "busy",
    host: { state: "alive", kind: "structured", pid: null },
    lifecycle: "stalled",
    reason: "host_alive_transcript_silent",
    silentForMs: 45 * 60_000,
    stalledForMs: 45 * 60_000,
    pipeline: { pipelineId: "pipeline_a1", stageId: "build", attempt: 1, reportedState: "running", reportedPipelineState: "running", paneId: null },
    evidenceSource: "transcript",
    ...over,
  } as AgentLivenessRecord;
}

function event(seq: number, over: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    id: `event-${seq}`,
    seq,
    at: new Date(NOW - 60_000).toISOString(),
    type: "stage_started",
    state: "running",
    project: PROJECT,
    pipelineId: "pipeline_a1",
    stageId: "build",
    attempt: 1,
    conversationId: null,
    role: "builder",
    summary: "builder started",
    ...over,
  };
}

function journal(events: LifecycleEvent[]): LifecycleJournalFile {
  return { version: 1, lastSeq: events.at(-1)?.seq ?? 0, events, retired: [] };
}

function sources(over: {
  pipelines?: Record<string, unknown>[];
  tasks?: Record<string, unknown>[];
  seatTurn?: string;
  laneRows?: AgentLivenessRecord[];
  seatRows?: AgentLivenessRecord[];
  livenessThrows?: boolean;
  events?: LifecycleEvent[];
  latestDeployment?: ReturnType<SeatTickSources["latestDeployment"]>;
  settings?: ReturnType<SeatTickSources["settings"]>;
  livenessCalls?: { project?: string; conversationId?: string; stallAfterMs: number }[];
  openPullRequests?: OpenPullRequest[];
  pullRequestCalls?: { cwd: string; limit: number }[];
  pullRequestsThrow?: boolean;
  pullRequestsUnavailable?: OpenPullRequestsUnavailable;
  archivedPipelines?: Record<string, unknown>[];
  archiveCalls?: number[];
  archiveThrows?: boolean;
  noSeat?: boolean;
  /** A real registry standing in for the stub (#1465). */
  registry?: InstanceType<typeof AgentRegistry>;
  /** The liveness plane's verdict for a child, by id (#1465). */
  childRows?: Record<string, AgentLivenessRecord>;
  seatConversationId?: string;
  seatEpoch?: number;
  retirementJournal?: SeatTickSources["retirementJournal"];
  now?: number;
}): SeatTickSources {
  return {
    seatFor: () => ({
      active: over.noSeat ? null : { conversationId: over.seatConversationId ?? CONVERSATION, seatEpoch: over.seatEpoch ?? 7, path: null } as never,
      pending: null,
      history: [],
    }),
    activeSeats: () => [PROJECT],
    pipelines: () => (over.pipelines ?? [lane()]) as never,
    archivedPipelines: () => {
      over.archiveCalls?.push(1);
      if (over.archiveThrows) throw new Error("the archive is unreadable");
      return (over.archivedPipelines ?? []) as never;
    },
    tasks: () => (over.tasks ?? []) as never,
    registry: () => (over.registry ?? {
      pageSeatChildren: () => ({ file: { entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversations: {}, conversationAliases: {} }, keys: [], after: null, complete: true, evidenceGap: false }),
      seatTickConversation: () => ({ id: CONVERSATION, turn: { state: over.seatTurn ?? "idle" } }),
      conversation: () => ({ turn: { state: over.seatTurn ?? "idle" } }),
      conversationForPath: () => null,
      readOnlySnapshot: () => ({ entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversations: {}, conversationAliases: {} }),
    }) as never,
    liveness: async (request) => {
      over.livenessCalls?.push({
        ...(request.project ? { project: request.project } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        stallAfterMs: request.stallAfterMs,
      });
      if (over.livenessThrows) throw new Error("the liveness plane is unavailable");
      const childRow = request.conversationId ? over.childRows?.[request.conversationId] : undefined;
      if (childRow) return [childRow];
      return request.conversationId ? over.seatRows ?? [] : over.laneRows ?? [];
    },
    lifecycleJournal: () => journal(over.events ?? []),
    latestDeployment: () => over.latestDeployment ?? ({ state: "unreadable", error: "no ledger" }) as never,
    retirementReport: () => null,
    ...(over.retirementJournal ? { retirementJournal: over.retirementJournal } : {}),
    settings: () => over.settings ?? defaultSeatTickSettings(PROJECT),
    openPullRequests: async (options) => {
      over.pullRequestCalls?.push(options);
      if (over.pullRequestsThrow) throw new Error("gh is not authenticated");
      if (over.pullRequestsUnavailable) return { ok: false, unavailable: over.pullRequestsUnavailable };
      return { ok: true, pullRequests: over.openPullRequests ?? [] };
    },
    wakeState: async () => "retained",
    withdrawWake: async () => "withdrawn",
    now: () => over.now ?? NOW,
  };
}

function gather(over: Parameters<typeof sources>[0], state: SeatTickProjectState = emptySeatTickState()) {
  return gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, sources(over));
}

test("gather yields while frozen lanes move and refresh carries the replacement agenda", async () => {
  const { deepFreeze } = await import("@/lib/deepFreeze");
  const { refreshSeatTickEvidence } = await import("./seatTickSources");
  let rows = deepFreeze(Array.from({ length: 24 }, (_, index) => lane({ id: `moving-${index}` })));
  const ports = sources({ pipelines: rows as never, noSeat: true });
  ports.pipelines = () => rows as never;
  const publication = new Promise<void>(resolve => {
    setImmediate(() => {
      rows = deepFreeze(rows.map((row, index) => index === 0
        ? { ...row, task: "replacement source evidence" } : row));
      resolve();
    });
  });
  const gathering = gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(await Promise.race([gathering.then(() => false), publication.then(() => true)])).toBe(true);
  const input = await gathering;
  const refreshed = await refreshSeatTickEvidence(input, ports);
  expect(refreshed.project).toBe(PROJECT);
  expect(refreshed.pipelines).toHaveLength(24);
  expect(refreshed.pipelines[0]?.title).toBe("replacement source evidence");
}, 30_000);

test("gather and refresh retain explicit work and its blocker for the reminder composer", async () => {
  const hold = { kind: "external", note: "waiting for the upstream release", since: new Date(NOW - DAY_MS).toISOString(), by: "agent" };
  const task = boardCard({ chosen: true, status: "inbox", hold });
  const ports = sources({ tasks: [task], pipelines: [] });
  const gathered = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  for (const observed of [gathered, refreshSeatTickInput(gathered, ports)]) {
    expect(observed.tasks[0]).toMatchObject({ accepted: true, hold, waitingSince: task.createdAt });
    expect(seatTickDecision(observed).verdict.kind).toBe("quiet");
  }
  delete task.hold;
  const refreshed = refreshSeatTickInput(gathered, ports);
  expect(seatTickDecision(refreshed).verdict.kind).toBe("wake");
});

test("overdue selection runs once on gather and every refresh, including cached snapshots as time passes", async () => {
  const task = boardCard({ status: "inbox", chosen: false, dueAt: new Date(NOW + 60_000).toISOString(), dueTz: "UTC" }) as unknown as import("@/lib/tasks/types").BoardTask;
  const tasks = Object.freeze([Object.freeze(task)]);
  const calls: number[] = [];
  let now = NOW;
  const ports = sources({ tasks: [], pipelines: [] });
  ports.tasks = () => tasks;
  const pipelines = Object.freeze([]);
  ports.pipelines = () => pipelines;
  ports.now = () => now;
  const forwarded: string[][] = [];
  const knownDates: string[][] = [];
  ports.overdueTasks = (project, at, shown, _cursor, known) => {
    knownDates.push([...known]);
    expect(project).toBe(PROJECT);
    forwarded.push([...shown]);
    calls.push(at);
    return at >= Date.parse(task.dueAt!) ? [task] : [];
  };
  const gathered = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(calls).toEqual([NOW]);
  expect(gathered.overdueTasks).toEqual([]);
  now += 60_000;
  const refreshed = refreshSeatTickInput(gathered, ports);
  expect(calls).toEqual([NOW, now]);
  expect(refreshed.overdueTasks?.[0]?.id).toBe(task.id);
  const again = refreshSeatTickInput(refreshed, ports);
  expect(calls).toEqual([NOW, now, now]);
  const decision = seatTickDecision(again);
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("missing overdue wake");
  const { seatTickWakeCommit, seatTickWakeCommitPlan } = await import("./seatTick");
  const commit = seatTickWakeCommitPlan(decision.verdict, { fingerprint: again.changeFingerprint, eventsThrough: 0 })!;
  const landed = seatTickWakeCommit(decision.state, commit, now);
  refreshSeatTickInput({ ...again, state: landed }, ports);
  expect(forwarded).toEqual([[], [], [], [`t:${task.id}:${Date.parse(task.dueAt!)}`]]);
  now += DAY_MS;
  refreshSeatTickInput({ ...again, state: landed }, ports);
  expect(forwarded.at(-1)).toEqual([]);
  expect(knownDates).toEqual([[], [], [], [`t:${task.id}:${Date.parse(task.dueAt!)}`], [`t:${task.id}:${Date.parse(task.dueAt!)}`]]);
  ports.overdueTasks = () => { throw new Error("overdue source unavailable"); };
  expect(() => refreshSeatTickInput(again, ports)).toThrow("overdue source unavailable");
});

test("accepted work is owned only by an open lane, including a hidden open lane", async () => {
  const task = boardCard({ chosen: true, status: "assigned", assignments: [{ state: "linked", path: null }] });
  const predecessor = lane({ state: "completed", closedAt: new Date(NOW - DAY_MS).toISOString(), taskIds: [task.id] });
  const ports = sources({ tasks: [task], pipelines: [predecessor] });
  const gathered = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(gathered.tasks[0]!.owned).toBe(false);
  expect(seatTickDecision(gathered).verdict.kind).toBe("wake");
  predecessor.state = "running";
  predecessor.closedAt = null;
  predecessor.hiddenAt = new Date(NOW).toISOString();
  const fresh = refreshSeatTickInput(gathered, ports);
  expect(fresh.tasks[0]!.owned).toBe(true);
  expect(seatTickDecision(fresh).verdict.kind).toBe("quiet");
});

test("pause account conditions use fresh cached quota once per engine and refresh after recovery", async () => {
  const pausedAt = new Date(NOW - 4 * DAY_MS).toISOString();
  const condition = { kind: "account-usage", engine: "codex", accountId: "fixture", window: "weekly", belowPercent: 80 };
  const pipelines = ["paused-first", "paused-second"].map(id => lane({ id, state: "paused", pausedAt,
    pause: { reason: "wait for quota recovery", resumeCondition: condition,
      actor: { kind: "agent", role: "orchestrator", conversationId: CONVERSATION } } }));
  const ports = sources({ pipelines });
  const registry = ports.registry();
  let reads = 0;
  const observation = { engine: "codex", accountId: "fixture", authenticated: true,
    observedAt: new Date(NOW).toISOString(), authCheckedAt: new Date(NOW).toISOString(),
    provenance: { source: "live" }, limits: { weekly: { usedPercent: 90, resetsAt: null } } };
  ports.registry = () => ({ ...registry, quotaObservations: () => { reads++; return [observation]; } }) as never;
  const gathered = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(reads).toBe(1);
  expect(gathered.pipelines.every(pipeline => pipeline.pauseConditionMet === false)).toBe(true);
  expect(seatTickDecision(gathered).verdict.kind).toBe("quiet");
  observation.limits.weekly.usedPercent = 79;
  const recovered = refreshSeatTickInput(gathered, ports);
  expect(reads).toBe(2);
  expect(recovered.pipelines.every(pipeline => pipeline.pauseConditionMet === true)).toBe(true);
  expect(seatTickDecision(recovered).verdict.kind).toBe("wake");
  observation.observedAt = pausedAt;
  expect(seatTickDecision(refreshSeatTickInput(recovered, ports)).verdict.kind).toBe("quiet");
  observation.observedAt = new Date(NOW).toISOString();
  observation.limits.weekly.usedPercent = 80;
  expect(seatTickDecision(refreshSeatTickInput(recovered, ports)).verdict.kind).toBe("quiet");
  observation.limits.weekly.usedPercent = 79;
  observation.engine = "claude";
  expect(seatTickDecision(refreshSeatTickInput(recovered, ports)).verdict.kind).toBe("quiet");
  ports.registry = () => ({ ...registry, quotaObservations: () => { throw new Error("cached quota unavailable"); } }) as never;
  expect(seatTickDecision(refreshSeatTickInput(recovered, ports)).verdict.kind).toBe("quiet");
});

test("an unrotated seat's next gather reads changed machine and project worker limits", async () => {
  const { setMachineWorkerLimit, setProjectWorkerLimit } = await import("@/lib/operator/workerLimit");
  const ports = sources({});
  ports.workerCounts = () => ({ byProject: new Map([[PROJECT, 7]]), machine: 19 });
  const actor = { kind: "operator", via: "settings" } as const;
  setMachineWorkerLimit(10, actor, null);
  const first = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(first.workers).toEqual({ limit: 10, source: "machine", machine: 10, running: 7 });
  setProjectWorkerLimit(PROJECT, 12, actor, null);
  const second = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(second.seat?.conversationId).toBe(first.seat?.conversationId);
  expect(second.workers).toEqual({ limit: 12, source: "project", machine: 10, running: 7 });
  setProjectWorkerLimit(PROJECT, null, actor, null);
  setMachineWorkerLimit(null, actor, null);
});

test("a failed prototype Telegram post is an actionable item in the project's seat wake", async () => {
  const { telegramRound, telegramTask } = await import("@/lib/prototypeReview/telegram.fixture");
  const round = telegramRound("seat-wake-post"); round.project = PROJECT;
  round.telegramPost = { key: round.id, state: "failed", reason: "forbidden", at: new Date(NOW).toISOString() };
  const own = { ...telegramTask([round]), project: PROJECT };
  const foreign = telegramRound("foreign-post"); foreign.telegramPost = round.telegramPost;
  const input = await gather({ tasks: [own, { ...telegramTask([foreign]), id: "foreign-task" }] });
  const signals = input.signals.filter(s => s.id.startsWith("prototype-telegram:"));
  expect(signals).toHaveLength(1);
  expect(signals[0]!.actionable).toBe(true);
  expect(signals[0]!.label).toContain(round.id);
  const decision = seatTickDecision(input);
  expect(decision.verdict.kind).toBe("wake");
  expect(JSON.stringify(decision)).toContain("forbidden");
  expect(JSON.stringify(decision)).toContain("resend_prototype_review_telegram");
  expect(JSON.stringify(decision)).not.toContain(foreign.id);
});

test("a note edited during evidence gathering renders the refreshed length", async () => {
  const { seatTickNoteRevision, seatTickWakeMessage } = await import("./report");
  const oldNote = "a".repeat(7_155);
  const newNote = "b".repeat(7_622);
  let settings = { ...defaultSeatTickSettings(PROJECT), monitorPrompt: oldNote };
  const ports = sources({});
  ports.settings = () => settings;
  const liveness = ports.liveness;
  ports.liveness = async (request) => {
    settings = { ...settings, monitorPrompt: newNote };
    return liveness(request);
  };
  const state = { ...emptySeatTickState(), noteShown: seatTickNoteRevision(oldNote) };
  const gathered = await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports);
  expect(gathered.settings.monitorPrompt).toBe(oldNote);
  const fresh = refreshSeatTickInput(gathered, ports);
  const text = seatTickWakeMessage({ project: PROJECT, reasons: [], items: [], deferred: 0, signals: [],
    monitorPrompt: fresh.settings.monitorPrompt,
    monitorPromptUnchanged: seatTickNoteRevision(fresh.settings.monitorPrompt) === state.noteShown,
  });
  expect(text).toContain("7622 chars");
  expect(text).not.toContain("7155 chars");
  expect(text).not.toContain("Standing monitor note unchanged");
});

/** A row whose cursor was established at some earlier check. Distinct from the
    empty row, whose cursor is null because nothing has established one yet. */
function withCursor(eventsThrough: number, over: Partial<SeatTickProjectState> = {}): SeatTickProjectState {
  return { ...emptySeatTickState(), eventsThrough, ...over };
}

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a lane carries the registry's own verdict for the turn its stage is holding", async () => {
  for (const verified of [true, false]) {
    const observed = livenessRow({ verified, lastRecordAt: new Date(NOW - 660_000).toISOString(), activity: { state: "idle", check: null, idleForMs: 660_000 } });
    const input = await gather({ laneRows: [observed] });
    expect(input.pipelines[0]!.stageActivity).toEqual({ verified, conversationId: observed.conversationId, lastRecordAt: observed.lastRecordAt, activity: observed.activity, lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" });
  }
});

/* The tick asks `agent_activity` at its own threshold rather than re-deriving
   one: the ten-minute silence the accepted defaults name travels into the read. */
test("the tick's stall threshold is what the liveness read is asked for", async () => {
  const calls: { project?: string; conversationId?: string; stallAfterMs: number }[] = [];
  await gather({ seatTurn: "busy", laneRows: [livenessRow()], livenessCalls: calls });
  expect(calls).toEqual([
    { conversationId: CONVERSATION, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs },
    { project: PROJECT, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs },
  ]);
});

/* A settled turn is never skipped and never signalled, so nothing reads its
   verdict — and a transcript tail per project per five minutes is not a read
   worth taking for an answer nobody consults. */
test("a seat whose turn has settled is not asked for a verdict at all", async () => {
  const calls: { project?: string; conversationId?: string; stallAfterMs: number }[] = [];
  const input = await gather({ laneRows: [livenessRow()], livenessCalls: calls });
  expect(calls.some((call) => call.conversationId)).toBe(false);
  expect(input.seat!.activity).toBeNull();
});

test("a lane the liveness plane says nothing about carries no verdict, and is therefore never stalled", async () => {
  const input = await gather({ laneRows: [] });
  expect(input.pipelines[0]!.stageActivity).toBeNull();
});

test("a liveness read that throws leaves every lane unjudged rather than failing the check", async () => {
  const input = await gather({ seatTurn: "busy", livenessThrows: true });
  expect(input.pipelines[0]!.stageActivity).toBeNull();
  expect(input.seat!.activity).toBeNull();
});

test("the seat carries its own turn verdict, read targeted by conversation id", async () => {
  const input = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({ conversationId: CONVERSATION, lifecycle: "stalled", reason: "host_gone_turn_open", pipeline: null })],
  });
  expect(input.seat).toMatchObject({ turn: "busy", activity: { lifecycle: "stalled", reason: "host_gone_turn_open" } });
  /* And the same fact becomes a signal, which is agenda enough for the hourly
     interval to carry a wake that resumes the host. */
  expect(input.signals.map((signal) => signal.id)).toContain("seat-host");
});

test("a seat whose turn is moving raises no seat-host signal", async () => {
  const input = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({ conversationId: CONVERSATION, lifecycle: "running", reason: "host_alive_turn_active", pipeline: null })],
  });
  expect(input.signals).toEqual([]);
});

/* #1262: the two readings of "the seat's turn", and which one the signal is
   entitled to. The registry's record says a turn is open; the transcript says
   whether one actually is. The silence threshold measures silence alone, so a
   seat that ended its turn cleanly and sat quiet past forty minutes is reported
   `stalled` — and the wake told the seat its own turn had stalled while it had
   simply finished. The verdict travels with the turn it was computed from. */
test("a seat that finished its turn and went quiet is not a stalled seat", async () => {
  const settled = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({
      conversationId: CONVERSATION,
      lifecycle: "stalled",
      reason: "host_alive_transcript_silent",
      turnState: "idle",
      pipeline: null,
      silentForMs: 41 * 60_000,
    })],
  });
  expect(settled.signals).toEqual([]);
  expect(settled.seat!.activity).toEqual({ verified: undefined, conversationId: CONVERSATION, lastRecordAt: null, activity: undefined, lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "idle" });

  /* The stall that is real — an open turn nothing has advanced for forty
     minutes — still says so, because that is the seat the wake exists to
     resume. */
  const stuck = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({
      conversationId: CONVERSATION,
      lifecycle: "stalled",
      reason: "host_alive_transcript_silent",
      turnState: "busy",
      pipeline: null,
      silentForMs: 41 * 60_000,
    })],
  });
  expect(stuck.signals.map((signal) => signal.id)).toEqual(["seat-host"]);
});

/* A dead host is a dead host whatever its turn was doing, and a wake resuming
   it is the reversal this mechanism's ADR records. */
test("a seat whose host is gone raises the signal even with a settled turn", async () => {
  const input = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({ conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", turnState: "idle", pipeline: null })],
  });
  expect(input.signals.map((signal) => signal.id)).toEqual(["seat-host"]);
});

test("a closed lane is not gathered at all, so it can neither stall nor fill a wake", async () => {
  const input = await gather({ pipelines: [lane({ state: "completed", closedAt: "2026-08-28T11:30:00.000Z" })] });
  expect(input.pipelines).toEqual([]);
});

/* #1274. The record as it was found on disk: discarded, so `hiddenAt` is set,
   but written before a discard settled anything — `state` still `draft` and
   `closedAt` still null. Read as an open lane it was parked by the stall rule
   at every check, and the wake it produced named the one verb the operator had
   refused to press. */
test("a hidden lane is not gathered, whatever its state says (#1274)", async () => {
  const discarded = lane({ id: "pipeline_hidden", state: "draft", closedAt: null, hiddenAt: "2026-08-28T15:01:15.000Z", cursor: null, runs: [] });
  const input = await gather({ pipelines: [discarded] });
  expect(input.pipelines).toEqual([]);
  const decision = seatTickDecision(input);
  expect(decision.verdict.kind).not.toBe("wake");
});

test("a project whose only lane is hidden is not a project the tick checks (#1274)", () => {
  const projects = seatTickProjects({
    ...sources({}),
    activeSeats: () => [],
    pipelines: () => [lane({ project: "discarded-draft-only", state: "draft", closedAt: null, hiddenAt: "2026-08-28T15:01:15.000Z" })] as never,
    tasks: () => [] as never,
  });
  expect(projects).toEqual([]);
});

/* A reversible dismiss discharges a parked lane's wakes: the seat was woken
   at every interval for superseded lanes the operator had dismissed off the
   board. `undismiss` clears the field and the lane is evidence again. */
test("a dismissed parked lane raises no wake, and undismissing it restores the lane", async () => {
  const parked = { id: "pipeline_parked", state: "needs_decision", pausedState: "needs_decision", stateDetail: "parked" };
  const dismissed = await gather({ pipelines: [lane({ ...parked, dismissedAt: "2026-08-28T11:40:00.000Z" })] });
  expect(dismissed.pipelines).toEqual([]);
  expect(reasonsOf(seatTickDecision(dismissed))).toEqual([]);
  expect(seatTickProjects({
    ...sources({}),
    activeSeats: () => [],
    pipelines: () => [lane({ ...parked, project: "dismissed-only", dismissedAt: "2026-08-28T11:40:00.000Z" })] as never,
    tasks: () => [] as never,
  })).toEqual([]);

  const restored = await gather({ pipelines: [lane({ ...parked, dismissedAt: null })] });
  expect(restored.pipelines.map((pipeline) => pipeline.id)).toEqual(["pipeline_parked"]);
  // The parked lane is a stalled item again, carried by the interval wake.
  expect(reasonsOf(seatTickDecision(restored))).toEqual(["interval"]);
});

test("the check carries the project's own tick settings, expiry already applied (#1275)", async () => {
  const unconfigured = await gather({});
  expect(unconfigured.settings).toMatchObject({ enabled: true, isDefault: true, configured: false });

  const off = await gather({
    settings: {
      ...defaultSeatTickSettings(PROJECT),
      enabled: false,
      reason: "nothing here for me",
      updatedAt: "2026-08-28T11:00:00.000Z",
    },
  });
  expect(off.settings).toMatchObject({ enabled: false, isDefault: false, configured: true, reason: "nothing here for me" });

  const expired = await gather({
    settings: {
      ...defaultSeatTickSettings(PROJECT),
      enabled: false,
      reason: "quiet while the release runs",
      until: new Date(NOW - 60_000).toISOString(),
      updatedAt: "2026-08-28T10:00:00.000Z",
    },
  });
  expect(expired.settings).toMatchObject({ enabled: true, isDefault: true, lapsed: true });
});

test("the fingerprint moves when a lane or a card moves, and only then", async () => {
  const base = await gather({});
  const same = await gather({});
  const moved = await gather({ pipelines: [lane({ state: "paused" })] });
  expect(same.changeFingerprint).toBe(base.changeFingerprint);
  expect(moved.changeFingerprint).not.toBe(base.changeFingerprint);
});

/* The tick keeps its own cursor because the digest's advances when the relay is
   READ, and an acknowledged event is never offered again. Reading here must
   therefore acknowledge nothing at all. */
test("events are read past the tick's own cursor, and reading acknowledges nothing", async () => {
  const events = [event(10), event(11, { type: "review_verdict", summary: "the round passed" }), event(12)];
  const input = await gather({ events }, withCursor(10));
  expect(input.events.map((entry) => entry.seq)).toEqual([11, 12]);
  expect(input.events.some((entry) => entry.type === "review_verdict")).toBe(true);
  /* Same cursor, same answer: a second read of the same state re-offers them. */
  const again = await gather({ events }, withCursor(10));
  expect(again.events.map((entry) => entry.seq)).toEqual([11, 12]);
});

/* ------------------------------------------------------------------------- *
 * #1262: where the cursor starts.
 *
 * Every case below is driven from a journal that already HOLDS history — a
 * terminal verdict, a merged pull request, four days of lane events. An empty
 * journal agrees with any cursor at all and would have caught none of this.
 * ------------------------------------------------------------------------- */

/* The report: a first wake claiming "since the last delivered wake" while
   naming pull requests merged four days earlier, with ninety-three more items
   behind them. There had never been a delivered wake; the cursor started at
   zero and read the whole journal as unread. */
test("a seat with no cursor yet starts at the present, so its first check carries no history", async () => {
  const history = [
    event(9848, { type: "review_verdict", summary: "the round passed" }),
    event(9850, { type: "stage_completed", summary: "the builder finished" }),
    event(9853, { type: "stage_completed", summary: "the reviewer finished" }),
  ];
  const input = await gather({ events: history });
  expect(input.events).toEqual([]);
  /* And the seal is written down, so the next check pages from it rather than
     re-deciding where the present was. */
  expect(input.state.eventsThrough).toBe(9853);
});

test("the seal is the journal head, so everything after the tick began is still delivered", async () => {
  const history = [event(9848, { type: "review_verdict", summary: "the round passed" })];
  const first = await gather({ events: history });
  const later = [...history, event(9849, { type: "stage_blocked", summary: "the review round is parked" })];
  const second = await gather({ events: later }, first.state);
  expect(second.events.map((entry) => entry.seq)).toEqual([9849]);
});

/* The over-correction the fix must not make. A cursor a previous wake earned is
   a fact about what the seat was told, and jumping it to the head would drop
   exactly the events nobody has been told about yet. */
test("a seat that already has a cursor keeps reading from it, never from the present", async () => {
  const history = [
    event(40, { type: "stage_completed", summary: "the builder finished" }),
    event(41, { type: "review_verdict", summary: "the round passed" }),
    event(42, { type: "stage_completed", summary: "the reviewer finished" }),
  ];
  const input = await gather({ events: history }, withCursor(40, { lastWakeAt: "2026-08-28T11:00:00.000Z" }));
  expect(input.events.map((entry) => entry.seq)).toEqual([41, 42]);
  expect(input.state.eventsThrough).toBe(40);
});

/* ------------------------------------------------------------------------- *
 * #1262: the wake reason that could never be discharged.
 *
 * Driven from the condition that produced it rather than from an empty room:
 * a journal already holding four days of terminal lane events the seat has
 * been told about, and a board of assigned cards nobody will ever start. The
 * reported wake said `9 assigned board task(s) nothing has started` on every
 * interval for ever, because "assigned and unowned" is permanently true of a
 * card that is really a status note from two months ago.
 * ------------------------------------------------------------------------- */

/** Terminal lane events the seat has already been woken for. Every check below
    reads them and must carry none of them forward: they are history, and the
    cursor is what says so. */
const SETTLED_HISTORY = [
  event(9840, { type: "stage_completed", summary: "the builder finished" }),
  event(9845, { type: "review_verdict", summary: "the round passed" }),
  event(9850, { type: "stage_completed", summary: "the reviewer finished" }),
  event(9853, { type: "review_verdict", summary: "the round passed" }),
];
const OVERDUE = { lastWakeAt: new Date(NOW - 61 * 60_000).toISOString() };

/** The reason kinds a verdict carries, and none for a verdict that is not a
    wake. */
function reasonsOf(decision: ReturnType<typeof seatTickDecision>): string[] {
  return decision.verdict.kind === "wake" ? decision.verdict.reasons.map((reason) => reason.kind) : [];
}

test("under a journal the cursor has already passed, only a card that recently moved wakes the seat", async () => {
  const board = [
    boardCard({ id: "task_b2", updatedAt: new Date(NOW - 30 * 60_000).toISOString() }),
    boardCard({ id: "task_c3", updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    boardCard({ id: "task_d4", updatedAt: new Date(NOW - 90 * DAY_MS).toISOString() }),
  ];
  const input = await gather({ pipelines: [], tasks: board, events: SETTLED_HISTORY }, withCursor(9853, OVERDUE));
  /* The journal is full and the check carries none of it, which is the whole
     point of the fixture: what wakes the seat here can only be the board. */
  expect(input.events).toEqual([]);

  const decision = seatTickDecision(input);
  expect(reasonsOf(decision)).toEqual(["unstarted-task"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("wire the chip — assigned, nothing started it; 2 older than the backlog bound");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map((item) => item.id)).toEqual(["task_b2"]);
});

/* The permanently-true reason, gone: a board of nothing but stale assigned
   cards owes the seat nothing, however much the journal behind it holds. */
test("a board whose assigned cards are all past the backlog bound wakes nobody", async () => {
  const board = [
    boardCard({ id: "task_c3", updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    boardCard({ id: "task_d4", updatedAt: new Date(NOW - 90 * DAY_MS).toISOString() }),
  ];
  const input = await gather({ pipelines: [], tasks: board, events: SETTLED_HISTORY }, withCursor(9853, OVERDUE));
  expect(seatTickDecision(input).verdict.kind).toBe("quiet");
});

/* `updatedAt` decides whether a card is an unstarted task or backlog. Moving
   the card changes the fingerprint; a legacy row with no showing history also
   keeps the newly unstarted task offerable past its exhausted guard. */
test("moving a stale card changes the fingerprint and unknown history keeps its task offerable", async () => {
  const stale = await gather(
    { pipelines: [], tasks: [boardCard({ updatedAt: new Date(NOW - 40 * DAY_MS).toISOString() })], events: SETTLED_HISTORY },
    withCursor(9853, OVERDUE),
  );
  const moved = await gather(
    { pipelines: [], tasks: [boardCard({ updatedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() })], events: SETTLED_HISTORY },
    withCursor(9853, OVERDUE),
  );
  expect(moved.changeFingerprint).not.toBe(stale.changeFingerprint);

  /* A guard that has run out of patience on the state the card was in before
     the operator touched it. */
  const spent = { wakesWithoutChange: { "unstarted-task": DEFAULT_SEAT_TICK_POLICY.retryGuard } };
  const released = seatTickDecision({ ...moved, state: { ...moved.state, ...spent, lastWakeFingerprint: stale.changeFingerprint } });
  expect(reasonsOf(released)).toEqual(["unstarted-task"]);
  expect(released.cards).toEqual([]);

  /* With no history proving the task was shown, unchanged source movement
     does not make the pending task disappear behind the guard. */
  const held = seatTickDecision({ ...moved, state: { ...moved.state, ...spent, lastWakeFingerprint: moved.changeFingerprint } });
  expect(reasonsOf(held)).toEqual(["unstarted-task"]);
  expect(held.cards).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * #1262: which deployment the signal is about.
 * ------------------------------------------------------------------------- */

function deployment(over: { phase: string; terminal?: boolean }): ReturnType<SeatTickSources["latestDeployment"]> {
  return { state: "ok", value: { phase: over.phase, terminal: over.terminal ?? true } } as never;
}

test("the deployment signal reports the latest deployment, and stays silent when it succeeded", async () => {
  const healthy = await gather({ latestDeployment: deployment({ phase: "succeeded" }) });
  expect(healthy.signals).toEqual([]);
  const regressed = await gather({ latestDeployment: deployment({ phase: "rolled-back" }) });
  expect(regressed.signals).toEqual([{ id: "deploy", label: "the last deployment ended rolled-back" }]);
  /* A deployment still running is not an outcome to report at all. */
  const running = await gather({ latestDeployment: deployment({ phase: "promoting", terminal: false }) });
  expect(running.signals).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * #1818: a retirement sweep that retires nothing while one clause refuses.
 * ------------------------------------------------------------------------- */

function retirementSweeps(
  count: number,
  refusedByClause: Record<string, number>,
  retiredAt: number | null = null,
  refusedByFlag: Record<string, number> = {},
) {
  return Array.from({ length: count }, (_, index) => ({
    finishedAt: new Date(NOW - (count - index) * 5 * 60_000).toISOString(),
    retired: index === retiredAt ? 1 : 0,
    refusedByClause,
    refusedByFlag,
  }));
}

test("a window that retires nothing while one clause refuses past the threshold names that clause", async () => {
  const sinceCalls: number[] = [];
  const stalled = await gather({
    retirementJournal: (sinceMs) => {
      sinceCalls.push(sinceMs);
      return { covered: true, sweeps: retirementSweeps(288, { "seat-free": 1, "process-identity": 7 }) };
    },
  });
  expect(sinceCalls).toEqual([NOW - RETIREMENT_STALL_WINDOW_MS]);
  expect(stalled.signals).toEqual([{
    id: "host-retirement-stalled",
    actionable: false,
    label: "host retirement: nothing retired in 288 sweeps over 24h while process-identity refused 2016 times",
  }]);

  /* One retirement anywhere in the window is a sweep doing its job. */
  const retiring = await gather({ retirementJournal: () => ({ covered: true, sweeps: retirementSweeps(288, { "process-identity": 7 }, 100) }) });
  expect(retiring.signals).toEqual([]);
  /* A journal that begins inside the window cannot say nothing retired across it. */
  const young = await gather({ retirementJournal: () => ({ covered: false, sweeps: retirementSweeps(288, { "process-identity": 7 }) }) });
  expect(young.signals).toEqual([]);
  /* Refusals spread thin, or few, are a quiet machine. */
  const quiet = await gather({ retirementJournal: () => ({ covered: true, sweeps: retirementSweeps(288, { "seat-free": 3, "turn-settled": 3 }) }) });
  expect(quiet.signals).toEqual([]);
  /* Live conditions of a seat, turn or transcript hold as long as the
     condition does, so even a flood of them is a working fence. */
  const live = await gather({ retirementJournal: () => ({ covered: true, sweeps: retirementSweeps(284, { "seat-free": 6, "turn-settled": 6, "transcript-idle": 6 }) }) });
  expect(live.signals).toEqual([]);
  /* Bookkeeping clauses only a defect leaves unsettled on an idle host. The
     production registry held spawn receipts stuck for months: no-open-operation
     refused their hosts on every sweep, and events-flushed and resumable refuse
     on a lagging durable cursor or a missing transcript. */
  for (const clause of ["no-open-operation", "events-flushed", "resumable", "handoff-queue-drained"]) {
    const stuck = await gather({ retirementJournal: () => ({ covered: true, sweeps: retirementSweeps(284, { [clause]: 4 }) }) });
    expect(stuck.signals).toEqual([{
      id: "host-retirement-stalled",
      actionable: false,
      label: `host retirement: nothing retired in 284 sweeps over 24h while ${clause} refused 1136 times`,
    }]);
  }
});

test("the stall threshold is strict and picks the clause with the most refusals", () => {
  const window = { covered: true, sweeps: retirementSweeps(10, { "transcript-idle": 100, "process-identity": 100 }) };
  expect(stalledRetirementClause(window, 1000)).toBeNull();
  expect(stalledRetirementClause(window, 999)).toEqual({ clause: "process-identity", refusals: 1000, sweeps: 10, flags: [] });
  expect(stalledRetirementClause({ covered: true, sweeps: [] }, 0)).toBeNull();
});

test("a stall on no-active-flags names the flags that refused, most frequent first (#2137)", async () => {
  /* The measured day: 274 sweeps, no retirement, and every no-active-flags
     refusal was an idle Codex host carrying its three app-server
     advertisements. The signal has to name them, since the clause alone sends
     the reader into the code. */
  const flags = { "native-queue": 5, "native-inject": 5, "native-turn-profile": 5, waitingOnApproval: 1 };
  const stalled = await gather({
    retirementJournal: () => ({ covered: true, sweeps: retirementSweeps(274, { "no-active-flags": 6, "turn-settled": 3 }, null, flags) }),
  });
  expect(stalled.signals).toEqual([{
    id: "host-retirement-stalled",
    actionable: false,
    label: "host retirement: nothing retired in 274 sweeps over 24h while no-active-flags refused 1644 times"
      + " (flags: native-inject 1370, native-queue 1370, native-turn-profile 1370, waitingOnApproval 274)",
  }]);

  /* A flood of names is counted past the first five rather than listed. */
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`flag-${index}`, 8 - index]));
  const flooded = stalledRetirementClause({ covered: true, sweeps: retirementSweeps(200, { "no-active-flags": 6 }, null, many) });
  expect(flooded?.flags.map(([flag]) => flag)).toEqual(Object.keys(many));
  const label = (await gather({ retirementJournal: () => ({ covered: true, sweeps: retirementSweeps(200, { "no-active-flags": 6 }, null, many) }) })).signals[0]?.label;
  expect(label).toEndWith("(flags: flag-0 1600, flag-1 1400, flag-2 1200, flag-3 1000, flag-4 800, +3 more)");

  /* A larger live-condition count does not displace a bookkeeping clause. */
  const other = stalledRetirementClause({ covered: true, sweeps: retirementSweeps(200, { "seat-free": 10, "no-active-flags": 6 }, null, flags) });
  expect(other).toMatchObject({ clause: "no-active-flags", refusals: 1200 });
});

test("the journal window reads through rotation and stops at the first sweep older than the window", () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, "retirement-journal-"));
  const file = path.join(dir, "host-retirement-journal.ndjson");
  const line = (at: number, retired: number, refusedByClause: Record<string, number>, refusedByFlag?: Record<string, number>) => JSON.stringify({
    version: 1, startedAt: new Date(at - 1_000).toISOString(), finishedAt: new Date(at).toISOString(), idleHours: 6,
    evaluated: 9, deferred: 0, standDown: null, retired: Array.from({ length: retired }, () => ({ key: "k" })), failed: [],
    reclaimed: { processes: 0, rssBytes: 0, swapBytes: 0 }, refusedByClause, undeterminedByClause: {},
    ...(refusedByFlag ? { refusedByFlag } : {}),
  });
  const since = NOW - RETIREMENT_STALL_WINDOW_MS;
  fs.writeFileSync(`${file}.1`, [line(since - 60_000, 1, { "seat-free": 1 }), line(since + 60_000, 0, { "seat-free": 2 })].join("\n") + "\n");
  fs.writeFileSync(file, [
    line(since + 120_000, 0, { "seat-free": 3 }),
    "{\"torn",
    line(NOW, 0, { "seat-free": 4, "no-active-flags": 2 }, { "native-queue": 2, bogus: "2" as unknown as number }),
  ].join("\n") + "\n");

  const window = readRetirementJournalWindow(file, since);
  expect(window.covered).toBe(true);
  expect(window.sweeps.map((sweep) => sweep.refusedByClause["seat-free"])).toEqual([2, 3, 4]);
  /* A sweep journaled before the per-flag count reads as naming no flag. */
  expect(window.sweeps.map((sweep) => sweep.refusedByFlag)).toEqual([{}, {}, { "native-queue": 2 }]);
  expect(window.sweeps.every((sweep) => sweep.retired === 0)).toBe(true);

  /* Without the rotated copy the journal starts inside the window. */
  fs.rmSync(`${file}.1`);
  expect(readRetirementJournalWindow(file, since)).toMatchObject({ covered: false });
  expect(readRetirementJournalWindow(path.join(dir, "absent.ndjson"), since)).toEqual({ covered: false, sweeps: [] });
});

/* ------------------------------------------------------------------------- *
 * #1285: an event whose lane is over, and a backlog of them.
 * ------------------------------------------------------------------------- */

/** A lane that ran and reached the end, which is what the tick's own store no
    longer lists as open. */
function finishedLane(over: Record<string, unknown> = {}): Record<string, unknown> {
  return lane({
    id: "pipeline_z9",
    task: "publish the merge queue",
    branch: "topic-merge-queue",
    state: "completed",
    cursor: null,
    runs: [],
    createdAt: "2026-08-27T09:00:00.000Z",
    closedAt: new Date(NOW - 14 * 60 * 60_000).toISOString(),
    ...over,
  });
}

test.each([CONVERSATION, ["conversation", "5b7729fbc9e0f4c2"].join("_")])("a merge wakes the idle seat after completion was announced, designated seat %s", async (designatedSeat) => {
  const seatEpoch = designatedSeat === CONVERSATION ? 7 : 8;
  const completed = finishedLane({ srcConversationId: CONVERSATION });
  const before = await gather({ pipelines: [completed], openPullRequests: [openPullRequest()] },
    withCursor(0, { ...OVERDUE, lastProposalAt: new Date(NOW).toISOString() }));
  const completion = seatTickDecision(before);
  expect(completion.verdict.kind).toBe("wake");
  const announced = seatTickWakeCommit(completion.state, seatTickWakeCommitPlan(completion.verdict, {
    fingerprint: before.changeFingerprint, eventsThrough: 0,
  })!, NOW);
  expect(announced.announcedLanes).toContain("pipeline_z9:completed");
  const idle = seatTickDecision(await gather({ pipelines: [completed] }, announced));
  expect(idle.verdict.kind).toBe("quiet");

  const mergedAt = NOW + 61 * 60_000;
  const head = "a".repeat(40);
  const merged = { ...completed, merge: { state: "merged", prNumber: 17, mergedHead: head } };
  const events = [
    event(1, { pipelineId: "pipeline_z9", type: "pipeline_merged", at: new Date(mergedAt).toISOString(), summary: "pull request #17 merged by Delegatus" }),
    event(2, { pipelineId: "pipeline_z9", type: "task_finished", at: new Date(mergedAt).toISOString() }),
  ];
  const after = await gather({ pipelines: [merged], events, now: mergedAt, seatConversationId: designatedSeat, seatEpoch }, idle.state);
  const decision = seatTickDecision(after);
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") return;
  expect(decision.verdict.items).toHaveLength(1);
  expect(decision.verdict.items[0]).toMatchObject({ kind: "event", id: "pipeline_z9" });
  expect(decision.verdict.items[0]!.label).toContain("publish the merge queue");
  expect(decision.verdict.items[0]!.label).toContain("#17");
  expect(decision.verdict.items[0]!.label).toContain(shortId(head));
  const landed = seatTickWakeCommit(decision.state, seatTickWakeCommitPlan(decision.verdict, {
    fingerprint: after.changeFingerprint, eventsThrough: 2,
  })!, mergedAt);
  const next = seatTickDecision(await gather({ pipelines: [merged], events, now: mergedAt + 61 * 60_000, seatConversationId: designatedSeat, seatEpoch }, landed));
  expect(next.verdict.kind).toBe("quiet");
});

test("a merge from another project never wakes this project's seat", async () => {
  const input = await gather({ pipelines: [finishedLane({ project: "another-project" })],
    events: [event(1, { pipelineId: "pipeline_z9", project: "another-project", type: "pipeline_merged" })] },
  withCursor(0, { ...OVERDUE, lastProposalAt: new Date(NOW).toISOString() }));
  expect(input.events).toEqual([]);
  expect(seatTickDecision(input).verdict.kind).toBe("quiet");
});

test("an event is marked history exactly when its own lane is no longer open", async () => {
  const input = await gather({
    pipelines: [lane(), finishedLane()],
    events: [
      event(10, { type: "stage_completed", pipelineId: "pipeline_a1", summary: "the builder finished" }),
      event(11, { type: "stage_completed", pipelineId: "pipeline_z9", summary: "the builder finished" }),
      /* Archived out of the hot store, which only ever takes settled records. */
      event(12, { type: "review_verdict", pipelineId: "pipeline_gone", summary: "the round passed" }),
      /* A deploy outcome names no pipeline, and nothing about it has finished. */
      event(13, { type: "deploy_failed", pipelineId: null, summary: "the release rolled back" }),
    ],
  }, withCursor(9));
  expect(input.events.map((entry) => entry.pipelineTerminal)).toEqual([false, true, true, false]);
});

/* The report, end to end: a wake whose every item named a pipeline that had
   reached a terminal state the day before, and whose entire cost was
   establishing that nothing was owed on any of them. */
test("a project whose only pending events belong to finished lanes is quiet, and the look discharges them", async () => {
  const history = Array.from({ length: 50 }, (_, index) => event(9900 + index, {
    type: "stage_completed",
    pipelineId: "pipeline_z9",
    summary: "the builder finished",
  }));
  const input = await gather(
    { pipelines: [finishedLane()], tasks: [boardCard({ status: "inbox" })], events: history },
    withCursor(9899, OVERDUE),
  );
  expect(input.events).toHaveLength(50);

  const decision = seatTickDecision(input);
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
  /* And no second wake is owed for the same backlog: the cursor is past all
     fifty on the strength of the one look that read them. */
  expect(decision.state.eventsThrough).toBe(9949);
});

/* ------------------------------------------------------------------------- *
 * #1289: a lane that finished and left its pull request open.
 * ------------------------------------------------------------------------- */

function openPullRequest(over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 1289,
    title: "wake on a merge that is waiting",
    headRefName: "topic-merge-queue",
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
    ...over,
  };
}

test("a finished lane whose branch still has an open pull request is carried, named by its lane", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([{
    number: 1289,
    title: "wake on a merge that is waiting",
    pipelineId: "pipeline_z9",
    pipelineTitle: "publish the merge queue",
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
  }]);
  expect(reasonsOf(seatTickDecision(input))).toEqual(["unmerged-pr"]);
});

/* #2187 §3.5: a lane can complete on a spent review budget with a head no
   reviewer saw; the seat that merges its pull request reads that first. */
test("a finished lane whose last fix was never re-reviewed says so on its open pull request", async () => {
  const unreviewed = finishedLane({
    lastPassedCommit: "b".repeat(40),
    stages: [
      { id: "build", kind: "run", prompt: "Build", next: "critique", onFail: null },
      { id: "critique", kind: "run", prompt: "Critique", next: null, onFail: { to: "build", maxRounds: 1 } },
    ],
    runs: [
      { stageId: "build", attempts: [
        { n: 1, state: "passed", activatedBy: null, completedAt: "2026-08-27T10:00:00.000Z" },
        { n: 2, state: "passed", activatedBy: { stageId: "critique", attempt: 1, edge: "fail", budgetSpent: true }, completedAt: "2026-08-27T11:00:00.000Z" },
      ] },
      { stageId: "critique", attempts: [
        { n: 1, state: "failed", budgetSpent: true, reviewedHead: "a".repeat(40), verdict: { status: "fail", findings: ["P2 gap"] } },
      ] },
    ],
  });
  const input = await gather({ pipelines: [unreviewed], openPullRequests: [openPullRequest()] }, withCursor(0, OVERDUE));
  expect(input.pullRequests).toEqual([expect.objectContaining({ number: 1289, pipelineId: "pipeline_z9", lastFixUnreviewed: true })]);
  const verdict = seatTickDecision(input).verdict;
  expect(verdict.kind === "wake" && verdict.reasons[0]!.detail)
    .toBe("pull request #1289 left open by a lane that finished; last fix not re-reviewed");
});

/* #2187 §4.6: a pull request the merge runner is working on is the runner's;
   one whose merge stopped comes back to the seat with the reason. */
test("a pull request the merge runner holds is left out, and a stopped merge names its reason", async () => {
  const merge = (state: string, reason: string | null) => ({
    state, by: null, repository: "acme/widgets", prNumber: 1289, policyChangedAt: "2026-08-27T09:00:00.000Z", reviewedHead: "a".repeat(40),
    chain: ["a".repeat(40)], updates: [], seenChecks: [], head: null, headSeenAt: null, lastChecks: null, readAt: null, nextReadAt: null,
    requestedAt: "2026-08-27T10:00:00.000Z", mergedHead: null, mergeCommit: null, method: null, mergedAt: null, attempts: 0,
    reason, blockedAt: reason ? "2026-08-27T11:00:00.000Z" : null, updatedAt: "2026-08-27T11:00:00.000Z",
  });
  for (const state of ["queued", "checking", "waiting-checks", "updating", "merging"]) {
    const held = await gather({ pipelines: [finishedLane({ merge: merge(state, null) } as never)], openPullRequests: [openPullRequest()] }, withCursor(0, OVERDUE));
    expect(held.pullRequests).toEqual([]);
  }
  for (const reason of ["conflict with the base branch", "a reviewer requested changes"]) {
    const input = await gather({ pipelines: [finishedLane({ merge: merge("blocked", reason) } as never)], openPullRequests: [openPullRequest()] }, withCursor(0, OVERDUE));
    expect(input.pullRequests).toEqual([expect.objectContaining({ number: 1289, mergeBlocked: reason })]);
    const verdict = seatTickDecision(input).verdict;
    expect(verdict.kind === "wake" && verdict.reasons[0]!.detail)
      .toBe(`pull request #1289 left open by a lane that finished; merge stopped: ${reason}`);
    expect(verdict.kind === "wake" && verdict.items.find((item) => item.kind === "pull-request")?.label).toContain(`merge stopped: ${reason}`);
  }
});

/* #2187 §5.3: a finished lane marked as finishing its task, whose move to
   Done waits on another open pipeline, says so in the wake, so a seat that
   marked the wrong lane sees it. */
test("a finished lane whose task waits on other open pipelines says so on its pull request", async () => {
  const waiting = finishedLane({ finishesTaskIds: ["task_big"], taskIds: ["task_big"], taskFinishWaits: [{ taskId: "task_big", since: "2026-08-27T11:00:00.000Z", open: ["pipeline_other"] }] } as never);
  const input = await gather({ pipelines: [waiting], openPullRequests: [openPullRequest()] }, withCursor(0, OVERDUE));
  expect(input.pullRequests).toEqual([expect.objectContaining({ number: 1289, taskWaits: 1 })]);
  const verdict = seatTickDecision(input).verdict;
  const item = verdict.kind === "wake" ? verdict.items.find((entry) => entry.kind === "pull-request") : null;
  expect(item?.label).toEndWith("unmerged since that lane finished; task waits for 1 open pipeline");
  const quiet = await gather({ pipelines: [finishedLane()], openPullRequests: [openPullRequest()] }, withCursor(0, OVERDUE));
  expect(quiet.pullRequests[0]).not.toHaveProperty("taskWaits");
});

test("a pull request no finished lane produced is not this seat's obligation", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest({ headRefName: "someone-elses-branch" })] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
});

/* An open lane's pull request is the lane's business; the lane is already open
   work and the tick already carries it. The reason is about FINISHING. */
test("an open lane's pull request raises nothing", async () => {
  const input = await gather(
    { pipelines: [lane({ branch: "topic-merge-queue" })], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
});

/* A discarded draft never ran, so it published nothing and left nothing behind
   (#1274 draws the same line for open lanes). */
test("a hidden lane leaves no pull request behind it", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    {
      pipelines: [finishedLane({ hiddenAt: new Date(NOW - 60_000).toISOString(), state: "closed" })],
      openPullRequests: [openPullRequest()],
      pullRequestCalls: calls,
    },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
  expect(calls).toEqual([]);
});

/* The read is a subprocess, so it happens only where a wake could come of it. */
test("the pull request read is skipped entirely until the wake interval has elapsed", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const early = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()], pullRequestCalls: calls },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(calls).toEqual([]);
  expect(early.pullRequests).toEqual([]);

  await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()], pullRequestCalls: calls },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([{ cwd: "/srv/repo", limit: 60 }]);
});

/* The same rule as the clause above, applied to the other two ways a check
   ends before any wake reason is composed. A seat mid-turn is the expensive
   one: a turn that runs for hours would otherwise pay a subprocess at every
   five-minute check for its whole length. */
test("a check whose seat is already mid-turn asks GitHub nothing", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    {
      pipelines: [finishedLane()],
      openPullRequests: [openPullRequest()],
      pullRequestCalls: calls,
      seatTurn: "busy",
      seatRows: [livenessRow({ lifecycle: "running", reason: "host_alive_turn_active" })],
    },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequests).toEqual([]);
});

test("a project with no seat to wake asks GitHub nothing", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()], pullRequestCalls: calls, noSeat: true },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequests).toEqual([]);
});

test("a project whose tick is off asks GitHub nothing", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    {
      pipelines: [finishedLane()],
      openPullRequests: [openPullRequest()],
      pullRequestCalls: calls,
      settings: { ...defaultSeatTickSettings(PROJECT), enabled: false, configured: true } as never,
    },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequests).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * The obligation outlives the lane's residence in the hot store.
 *
 * Settled lanes are archived after three days. Reading only the hot store put
 * the reason on a timer nothing about the pull request knows: a tick switched
 * off, a seat busy for days, or a `gh` unreachable until archival all reach
 * their first eligible check with no lane to attribute anything to, and go
 * quiet over a pull request still sitting open.
 * ------------------------------------------------------------------------- */

/** The same lane, three days later: out of the hot store, into cold storage,
    and its pull request still unmerged. */
function archivedLane(over: Record<string, unknown> = {}): Record<string, unknown> {
  return finishedLane({ createdAt: new Date(NOW - 6 * DAY_MS).toISOString(), closedAt: new Date(NOW - 5 * DAY_MS).toISOString(), ...over });
}

test("a lane that has been archived still owes its open pull request", async () => {
  const input = await gather(
    { pipelines: [], archivedPipelines: [archivedLane()], openPullRequests: [openPullRequest({ createdAt: new Date(NOW - 5.5 * DAY_MS).toISOString() })] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([{
    number: 1289,
    title: "wake on a merge that is waiting",
    pipelineId: "pipeline_z9",
    pipelineTitle: "publish the merge queue",
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
  }]);
  expect(reasonsOf(seatTickDecision(input))).toEqual(["unmerged-pr"]);
});

/* The repository is asked for in the archived record too, because a project
   whose every lane has settled out still has one — and a `gh` never run is the
   same silence read off a different shelf. */
test("an archived lane names the repository the pull requests are read from", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  await gather(
    { pipelines: [], archivedPipelines: [archivedLane()], openPullRequests: [openPullRequest({ createdAt: new Date(NOW - 5.5 * DAY_MS).toISOString() })], pullRequestCalls: calls },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([{ cwd: "/srv/repo", limit: 60 }]);
});

/* And it discharges itself the same way a hot lane's does: the source reads
   OPEN pull requests, so a merge or a close simply stops returning the row. */
test("once that pull request merges the same project is quiet again", async () => {
  const input = await gather(
    { pipelines: [], archivedPipelines: [archivedLane()], openPullRequests: [] },
    withCursor(0, { ...OVERDUE, lastProposalAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(input.pullRequests).toEqual([]);
  expect(input.pullRequestsUnavailable).toBeNull();
  expect(seatTickDecision(input).verdict).toEqual({
    kind: "quiet",
    detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify; the proposal slot is not due",
  });
});

/* Cold storage is read only where the check has already committed to a
   subprocess, so the gates that skip `gh` skip the archive with it. */
test("the archive is not read by a check that could raise no wake from it", async () => {
  const early: number[] = [];
  await gather(
    { pipelines: [finishedLane()], archiveCalls: early },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(early).toEqual([]);

  const seated: number[] = [];
  await gather({ pipelines: [finishedLane()], archiveCalls: seated, noSeat: true }, withCursor(0, OVERDUE));
  expect(seated).toEqual([]);

  const off: number[] = [];
  await gather(
    {
      pipelines: [finishedLane()],
      archiveCalls: off,
      settings: { ...defaultSeatTickSettings(PROJECT), enabled: false, configured: true } as never,
    },
    withCursor(0, OVERDUE),
  );
  expect(off).toEqual([]);

  const due: number[] = [];
  await gather({ pipelines: [finishedLane()], archiveCalls: due }, withCursor(0, OVERDUE));
  expect(due).toEqual([1]);
});

/* ------------------------------------------------------------------------- *
 * A read that failed is not a pull request that merged.
 *
 * Every failure below used to arrive as an empty list, which the decision then
 * read as "nothing open" — `quiet — nothing owed` published on the strength of
 * a `gh` nobody could run. The gap travels out of the gather instead.
 * ------------------------------------------------------------------------- */

test("a gh that throws is carried out of the gather as a gap, not as no pull requests", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsThrow: true },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
  expect(input.pullRequestsUnavailable).toBe("command-failed");
  /* The rest of the check is untouched: one unreadable evidence source is not
     a failed check. */
  expect(input.tasks).toEqual([]);
});

test("each way gh can fail keeps its own name", async () => {
  for (const unavailable of ["command-failed", "timed-out", "malformed-output"] as const) {
    const input = await gather(
      { pipelines: [finishedLane()], pullRequestsUnavailable: unavailable },
      withCursor(0, OVERDUE),
    );
    expect(input.pullRequestsUnavailable).toBe(unavailable);
    expect(input.pullRequests).toEqual([]);
  }
});

/* The lanes are half of the correlation, so lanes that cannot be read leave
   the same question unanswered — and asking `gh` about lanes nobody could
   enumerate would answer it wrongly rather than not at all. */
test("lanes that cannot be read are a gap of their own, and gh is not asked", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    { pipelines: [finishedLane()], archiveThrows: true, openPullRequests: [openPullRequest()], pullRequestCalls: calls },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequestsUnavailable).toBe("lanes-unreadable");
  expect(input.pullRequests).toEqual([]);
  expect(calls).toEqual([]);
});

/* The successful empty answer is what a gap must stay distinguishable from:
   here GitHub was asked and said nothing is open, and quiet is earned. */
test("a successful empty answer leaves no gap behind it", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
  expect(input.pullRequestsUnavailable).toBeNull();
});

/* A check that was never going to ask has no gap either — it reports nothing
   because nothing was owed from this reason, not because something failed. */
test("a check that asks GitHub nothing reports no gap", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsThrow: true },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(input.pullRequestsUnavailable).toBeNull();
});

/* ------------------------------------------------------------------------- *
 * The run of failures the row remembers (#1298).
 *
 * A source that has been unreadable since the feature shipped is a different
 * fact from one that just missed a call, and the check could not tell them
 * apart: it reported the same journal line every five minutes for four hours
 * and put nothing anywhere an operator reads.
 * ------------------------------------------------------------------------- */

test("a failed read starts a run of failures on the row", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "command-failed" },
    withCursor(0, OVERDUE),
  );
  expect(input.state.pullRequestGap).toEqual({
    gap: "command-failed",
    since: new Date(NOW).toISOString(),
    lastAttemptAt: new Date(NOW).toISOString(),
    attempts: 1,
    reported: false,
  });
});

/* Inside the first interval the source is asked at every check: a transient
   failure has to recover at the check interval, not an hour later. */
test("a run younger than the wake interval is asked again at every check", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const young = {
    gap: "command-failed" as const,
    since: new Date(NOW - 10 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 5 * 60_000).toISOString(),
    attempts: 2,
    reported: false,
  };
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "timed-out", pullRequestCalls: calls },
    withCursor(0, { ...OVERDUE, pullRequestGap: young }),
  );
  expect(calls).toHaveLength(1);
  /* The run keeps its own beginning, so "how long has this been broken" is not
     reset by every failure inside it. */
  expect(input.state.pullRequestGap).toMatchObject({ gap: "timed-out", since: young.since, attempts: 3 });
});

/* Past that point the subprocess is paid for once per wake interval — and the
   gap it already established is replayed, so the check in between still
   refuses to call this quiet. Slowing the read may never buy a silence. */
test("a standing run is asked once per wake interval, and the gap is replayed in between", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const standing = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 10 * 60_000).toISOString(),
    attempts: 23,
    reported: true,
  };
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "command-failed", pullRequestCalls: calls },
    withCursor(0, { ...OVERDUE, pullRequestGap: standing }),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequestsUnavailable).toBe("command-failed");
  expect(input.state.pullRequestGap).toEqual(standing);
  /* And the decision it feeds is the decision a fresh failed read would have
     produced: no wake from the unreadable source, and no quiet either. */
  expect(seatTickDecision(input).verdict.kind).toBe("error");

  const due: { cwd: string; limit: number }[] = [];
  const asked = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "command-failed", pullRequestCalls: due },
    withCursor(0, { ...OVERDUE, pullRequestGap: { ...standing, lastAttemptAt: new Date(NOW - 61 * 60_000).toISOString() } }),
  );
  expect(due).toHaveLength(1);
  expect(asked.state.pullRequestGap).toMatchObject({ attempts: 24, reported: true });
});

/* The replay is bounded by the question it answers. A check with no finished
   lane to correlate never asks the source at all, and a fresh read on it
   reports no gap — so the backoff must not hand one back and refuse a quiet
   this check's own evidence allows. */
test("a standing run is not replayed onto a check that had nothing to ask", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const standing = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 10 * 60_000).toISOString(),
    attempts: 23,
    reported: true,
  };
  const input = await gather(
    { pipelines: [], pullRequestsUnavailable: "command-failed", pullRequestCalls: calls },
    withCursor(0, { ...OVERDUE, pullRequestGap: standing }),
  );
  /* The subprocess the backoff exists to save is still saved. */
  expect(calls).toEqual([]);
  expect(input.pullRequestsUnavailable).toBeNull();
  /* And the run is left standing, because this check learned nothing about
     whether the source can be read. */
  expect(input.state.pullRequestGap).toEqual(standing);
  expect(seatTickDecision(input).verdict.kind).not.toBe("error");
});

/* An answer ends the run, whatever it says — which is what makes the next
   outage a fresh run with a report of its own. */
test("an answer clears the run of failures", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [] },
    withCursor(0, {
      ...OVERDUE,
      pullRequestGap: {
        gap: "command-failed",
        since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
        lastAttemptAt: new Date(NOW - 61 * 60_000).toISOString(),
        attempts: 23,
        reported: true,
      },
    }),
  );
  expect(input.pullRequestsUnavailable).toBeNull();
  expect(input.state.pullRequestGap).toBeNull();
});

/* A gate says nothing about whether the source can be read, so it leaves the
   run exactly as it stands — and reports no gap of its own, because this check
   asked nothing. */
test("a check that asks GitHub nothing leaves the run untouched", async () => {
  const standing = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 61 * 60_000).toISOString(),
    attempts: 23,
    reported: true,
  };
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsThrow: true },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString(), pullRequestGap: standing }),
  );
  expect(input.pullRequestsUnavailable).toBeNull();
  expect(input.state.pullRequestGap).toEqual(standing);
});

/* The lane store is a source too, and its own permanent failure has to be
   bounded by the same backoff (#1298). It is read above the gates that skip
   `gh`, so a lane store that can never be read paid a cold-storage read every
   five-minute check for as long as no delivered wake moved the hourly stamp —
   the unbounded retry, one source over. */
test("a lane store that can never be read is asked once per wake interval too", async () => {
  const standing = {
    gap: "lanes-unreadable" as const,
    since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 10 * 60_000).toISOString(),
    attempts: 23,
    reported: true,
  };
  const held: number[] = [];
  const input = await gather(
    { pipelines: [finishedLane()], archiveThrows: true, archiveCalls: held },
    withCursor(0, { ...OVERDUE, pullRequestGap: standing }),
  );
  /* Zero reads inside the interval … */
  expect(held).toEqual([]);
  /* … and the gap they already established is replayed, so this check still
     refuses to call the source readable or the project quiet. */
  expect(input.pullRequestsUnavailable).toBe("lanes-unreadable");
  expect(input.state.pullRequestGap).toEqual(standing);
  expect(seatTickDecision(input).verdict.kind).toBe("error");

  const due: number[] = [];
  const asked = await gather(
    { pipelines: [finishedLane()], archiveThrows: true, archiveCalls: due },
    withCursor(0, { ...OVERDUE, pullRequestGap: { ...standing, lastAttemptAt: new Date(NOW - 61 * 60_000).toISOString() } }),
  );
  /* … and exactly one after it. */
  expect(due).toEqual([1]);
  expect(asked.state.pullRequestGap).toMatchObject({ gap: "lanes-unreadable", attempts: 24, since: standing.since });
});

/* The bound it must not grow into: a lane store that has only just stopped
   answering is weather, and weather has to recover at the check interval. */
test("a lane store failing inside the first interval is still asked at every check", async () => {
  const young: number[] = [];
  const input = await gather(
    { pipelines: [finishedLane()], archiveThrows: true, archiveCalls: young },
    withCursor(0, {
      ...OVERDUE,
      pullRequestGap: {
        gap: "lanes-unreadable",
        since: new Date(NOW - 10 * 60_000).toISOString(),
        lastAttemptAt: new Date(NOW - 5 * 60_000).toISOString(),
        attempts: 2,
        reported: false,
      },
    }),
  );
  expect(young).toEqual([1]);
  expect(input.state.pullRequestGap).toMatchObject({ gap: "lanes-unreadable", attempts: 3 });
});

/* And the backoff belongs to the source that failed. A standing `gh` outage
   says nothing about the archive, so the archive is still read — the gates
   below it are read OUT of the archive, and skipping it would hand a check
   with nothing to ask a gap it could not have produced. */
test("a standing gh outage does not stop the lane store being read", async () => {
  const reads: number[] = [];
  await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "command-failed", archiveCalls: reads },
    withCursor(0, {
      ...OVERDUE,
      pullRequestGap: {
        gap: "command-failed",
        since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
        lastAttemptAt: new Date(NOW - 10 * 60_000).toISOString(),
        attempts: 23,
        reported: true,
      },
    }),
  );
  expect(reads).toEqual([1]);
});

/* The guard half, the same shape #1262 established for a card's movement: the
   fingerprint has to carry what the reason is decided from, or a guard keyed on
   it goes on suppressing the reason while a second pull request piles up. */
test("a second unmerged pull request moves the fingerprint", async () => {
  const one = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  const two = await gather(
    {
      pipelines: [finishedLane()],
      openPullRequests: [openPullRequest(), openPullRequest({ number: 1290, headRefName: "topic-merge-queue" })],
    },
    withCursor(0, OVERDUE),
  );
  expect(two.changeFingerprint).not.toBe(one.changeFingerprint);
});

/* The other half of that, and the trap the wake-through-a-gap opened (#1298).
   An unreadable source contributes exactly the rows a merged pull request
   contributes — none — so a single digest over whatever was readable makes a
   failing `gh` look like an operator clearing the board. Wakes now go out under
   a gap, so that reading would reach the guard: a source failing every other
   check would alternate the digest and reset the count on every wake, and the
   reason would be re-sent for ever. The guard has to see the board standing
   still through the flap. */
test("a source that flaps does not look like a board that moved", async () => {
  const readable = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  const blind = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "timed-out" },
    withCursor(0, OVERDUE),
  );
  expect(blind.changeFingerprint).not.toBe(readable.changeFingerprint);
  expect(seatTickBoardMoved(readable.changeFingerprint, blind.changeFingerprint)).toBe(false);
  expect(seatTickBoardMoved(blind.changeFingerprint, readable.changeFingerprint)).toBe(false);

  /* So a guard that has run out of patience on a parked lane stays out of
     patience across the flap, rather than being handed a fresh count by it. */
  const spent = { wakesWithoutChange: { stalled: DEFAULT_SEAT_TICK_POLICY.retryGuard } };
  const held = seatTickDecision({
    ...blind,
    state: { ...blind.state, ...spent, lastWakeFingerprint: readable.changeFingerprint },
  });
  expect(reasonsOf(held)).toEqual([]);

  /* And a board that DID move is still seen to have moved while the source is
     blind: the half both checks could read is the half that answers. */
  const movedBlind = await gather(
    {
      pipelines: [finishedLane(), lane({ id: "pipe_second" })],
      pullRequestsUnavailable: "timed-out",
    },
    withCursor(0, OVERDUE),
  );
  expect(seatTickBoardMoved(readable.changeFingerprint, movedBlind.changeFingerprint)).toBe(true);
});

/* An unreadable half cannot postpone the guard either. A wake that went out
   over a blind source and changed nothing counts as a wake that changed
   nothing, so the count still climbs toward the bound. */
test("a wake sent under a blind source still counts against the retry guard", async () => {
  const blind = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "timed-out" },
    withCursor(0, OVERDUE),
  );
  const readable = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  const committed = seatTickWakeCommit(
    { ...blind.state, lastWakeFingerprint: readable.changeFingerprint, wakesWithoutChange: { stalled: 1 } },
    { fingerprint: blind.changeFingerprint, reasons: ["stalled"], eventsThrough: 0, proposal: false, children: [] },
    NOW,
  );
  expect(committed.wakesWithoutChange.stalled).toBe(2);
});

test("another project's events are not this project's", async () => {
  const input = await gather({ events: [event(10, { project: "other", type: "review_verdict" })] }, withCursor(0));
  expect(input.events).toEqual([]);
});

test("the projects worth checking are the seated ones plus anything with work and nobody on it", async () => {
  const projects = seatTickProjects(sources({
    pipelines: [lane({ project: "abandoned" })],
    tasks: [{ id: "task_b2", project: "unstarted", status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: "", updatedAt: "" }],
  }));
  expect(projects).toEqual(["abandoned", "unstarted", PROJECT]);
});

/* docs/design/linked-installs.md M.4: the sources mark another machine's
   tasks and never count their project as work nobody is on. */
test("a task another linked machine runs is marked runsOn and adds no project", async () => {
  const selfFile = path.join(process.env.LLV_STATE_DIR!, "links/self.json");
  fs.mkdirSync(path.dirname(selfFile), { recursive: true });
  fs.writeFileSync(selfFile, JSON.stringify({ v: 1, installId: ["0a0a0a0a", "1111", "4111", "8111", "111111111111"].join("-"), label: "alpha", publicUrl: null, check: null }));
  try {
    const peer = ["0b0b0b0b", "2222", "4222", "8222", "222222222222"].join("-");
    const elsewhere = { id: "task_peer", project: "peer-only", status: "assigned", text: "card", placement: "unplaced", assignments: [], machine: peer, createdAt: "", updatedAt: "" };
    expect(seatTickProjects({ ...sources({ tasks: [elsewhere] }), activeSeats: () => [], pipelines: () => [] as never })).toEqual([]);
    const input = await gather({ tasks: [{ ...elsewhere, project: PROJECT, updatedAt: new Date(NOW - 60_000).toISOString() }] });
    expect(input.tasks[0]).toMatchObject({ id: "task_peer", runsOn: "0b0b0b0b" });
  } finally {
    fs.rmSync(selfFile, { force: true });
  }
});

test("a done board and a closed lane leave a project the tick has no opinion about", () => {
  const projects = seatTickProjects({
    ...sources({}),
    activeSeats: () => [],
    pipelines: () => [lane({ state: "completed", closedAt: "2026-08-28T11:30:00.000Z" })] as never,
    tasks: () => [{ id: "task_b2", project: "quiet", status: "done", text: "card", placement: "unplaced", assignments: [], createdAt: "", updatedAt: "" }] as never,
  });
  expect(projects).toEqual([]);
});

test("gh reads run in the repository the newest lane named, and nowhere when none did", () => {
  expect(repoDirForProject(PROJECT, sources({}))).toBe("/srv/repo");
  expect(repoDirForProject(PROJECT, sources({ pipelines: [lane({ repoDir: null })] }))).toBeNull();
});


/* ------------------------------------------------------------------------- *
 * The layer rule: which runtime receipt status means what to the tick, and
 * what a withdrawal aimed at that layer can honestly claim.
 *
 * This is where the two halves of the mechanism meet the runtime host. A send
 * it queued is ITS payload — the Viewer registry row beside it is a mirror, and
 * settling a mirror leaves the host's drain free to deliver the wake to a seat
 * that has since been replaced.
 * ------------------------------------------------------------------------- */

type FakeClient = Parameters<typeof withdrawRuntimeWake>[2];

function runtimeClient(over: {
  statuses?: string[];
  transition?: (status: string) => { status: string };
  transitions?: { operationId: string; status: string; reason: string | null }[];
  leafOperationId?: string;
}): FakeClient {
  const statuses = [...(over.statuses ?? [])];
  return {
    operationStatus: async (operationId: string) => {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return status === undefined
        ? null
        : { operationId: over.leafOperationId ?? operationId, receipt: { status }, replayed: false };
    },
    transitionOperation: async (operationId: string, status: string, details?: { reason?: string | null }) => {
      over.transitions?.push({ operationId, status, reason: details?.reason ?? null });
      const settled = over.transition ? over.transition(status) : { status };
      return { operationId, receipt: settled, replayed: false };
    },
  } as unknown as FakeClient;
}

const WAKE = {
  clientMessageId: "seat-tick:viewer:7:first:interval:fp-1",
  conversationId: CONVERSATION,
  seatEpoch: 7,
  operationId: "op-wake-1",
  commit: { proposal: false, reasons: ["interval" as const], fingerprint: "fp-1", eventsThrough: 44, children: [] },
};

/* `queued` is what a structured host answers for EVERY admitted send, idle host
   or busy, so it is the status the whole accounting turns on: still the host's,
   never yet the seat's. */
test("the runtime host's own status is what says whether the wake reached the seat", async () => {
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["queued"] }))).toBe("retained");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["pending"] }))).toBe("retained");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["delivering"] }))).toBe("retained");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["delivered"] }))).toBe("landed");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["failed"] }))).toBe("dropped");
  /* Ended without proof either way is not a drop (#1465): the seat may have it. */
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["uncertain"] }))).toBe("uncertain");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["interrupted"] }))).toBe("uncertain");
  /* An operation the host has no record of is an observation about the
     journal, never proof that nothing was delivered (#1465). */
  expect(await runtimeWakeState("op-wake-1", runtimeClient({}))).toBe("unknown");
});

/* The finding this round exists for: the revocation has to reach the queue that
   will actually deliver the message. */
test("a queued wake is taken back by failing the runtime operation itself", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  const withdrawn = await withdrawRuntimeWake("op-wake-1", "the seat was replaced", runtimeClient({ statuses: ["queued"], transitions }));
  expect(withdrawn).toBe("withdrawn");
  expect(transitions).toEqual([{ operationId: "op-wake-1", status: "failed", reason: "the seat was replaced" }]);
});

/* A retried send leaves the parent terminal, so the operation the drain will
   actually deliver is the leaf — and that is the one to take back. */
test("a retried wake is taken back at the operation the drain still holds", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  await withdrawRuntimeWake("op-wake-1", "the seat was replaced", runtimeClient({ statuses: ["queued"], leafOperationId: "op-wake-1-retry", transitions }));
  expect(transitions.map((entry) => entry.operationId)).toEqual(["op-wake-1-retry"]);
});

/* The honest impossibility. An operation the drain already has, or has already
   delivered, cannot be recalled — and failing a receipt underneath a drain that
   is about to settle it would break that drain for a claim the tick cannot make
   anyway. So nothing is transitioned and the answer says so. */
test("a wake the drain already has is reported too late, and never transitioned", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ statuses: ["delivering"], transitions }))).toBe("too-late");
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ statuses: ["delivered"], transitions }))).toBe("too-late");
  expect(transitions).toEqual([]);
});

/* The host refuses the transition exactly when the operation left the queue
   between the read and the write. Whether that was a delivery decides between
   an honest "too late" and an honest "unknown"; neither is a revocation. */
test("an operation that left the queue mid-withdrawal is re-read rather than assumed", async () => {
  const raced = runtimeClient({ statuses: ["queued", "delivered"], transition: () => { throw new Error("runtime operation transition is invalid"); } });
  expect(await withdrawRuntimeWake("op-wake-1", "gone", raced)).toBe("too-late");
  const unclear = runtimeClient({ statuses: ["queued", "failed"], transition: () => { throw new Error("runtime operation transition is invalid"); } });
  expect(await withdrawRuntimeWake("op-wake-1", "gone", unclear)).toBe("unknown");
});

test("an operation already settled unsent needs no withdrawal", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ statuses: ["failed"], transitions }))).toBe("withdrawn");
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ transitions }))).toBe("unknown");
  expect(transitions).toEqual([]);
});

/* The wake record is the argument to both questions, so the handle travels with
   it rather than being re-derived at either call site. */
test("both questions are asked of the operation the wake names", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  expect(await runtimeWakeState(WAKE.operationId, runtimeClient({ statuses: ["queued"] }))).toBe("retained");
  await withdrawRuntimeWake(WAKE.operationId, "the seat was replaced", runtimeClient({ statuses: ["queued"], transitions }));
  expect(transitions.map((entry) => entry.operationId)).toEqual([WAKE.operationId]);
});

/* ------------------------------------------------------------------------- *
 * The receipt boundary (#1465): what the durable delivery record says became
 * of a wake, classified by the #1490 contract.
 * ------------------------------------------------------------------------- */

function receipt(over: Partial<SendReceipt>): SendReceipt {
  return {
    operationId: "op-wake-1",
    kind: "send",
    conversationId: CONVERSATION,
    clientMessageId: WAKE.clientMessageId,
    state: "in-flight",
    reason: null,
    acceptedAt: new Date(NOW - MINUTE_MS).toISOString(),
    settledAt: null,
    duplicateRisk: false,
    resend: null,
    evidence: "delivery-record",
    ...over,
  };
}
const MINUTE_MS = 60_000;

function found(current: SendReceipt): OriginalSendEvidence {
  return { kind: "found", operationId: current.operationId, deliveryId: "delivery-1", receipt: current, reservationState: "assigned", current: { readable: true, value: current } };
}

/** The journal's receipt for the state a case wants the runtime to answer. */
const JOURNAL_FOR: Record<"retained" | "landed" | "dropped" | "unknown" | "uncertain", SeatTickJournalReceipt | null> = {
  retained: { status: "queued", reason: null },
  landed: { status: "delivered", reason: null },
  dropped: { status: "rejected", reason: "conversation is not hosted" },
  uncertain: { status: "uncertain", reason: null },
  unknown: null,
};

async function classify(evidence: OriginalSendEvidence, over: { settle?: SendReceipt | null; runtime?: keyof typeof JOURNAL_FOR | "unreachable" | SeatTickJournalReceipt; wake?: SeatTickOutstandingWake; readOnly?: boolean; rearm?: "refused" } = {}) {
  const calls: string[] = [];
  const observation = await wakeStateFromRecord(over.wake ?? WAKE, {
    lookup: async () => { calls.push("lookup"); return evidence; },
    ...(over.readOnly ? {} : {
      settle: async () => { calls.push("settle"); return over.settle ?? null; },
      /* The record as it reads after the journal's verdict is written onto it. */
      settleFromJournal: async (target, journalReceipt) => {
        calls.push(`record:${target.operationId}`);
        if (over.rearm === "refused") return null;
        return journalReceipt.status === "delivered"
          ? receipt({ state: "delivered", resend: "not-needed" })
          : receipt({ state: "failed", reason: journalReceipt.reason, resend: "safe", duplicateRisk: false });
      },
    }),
    journal: async () => {
      calls.push("journal");
      if (over.runtime === "unreachable") throw new Error("runtime host request timed out");
      if (over.runtime && typeof over.runtime === "object") return over.runtime;
      return JOURNAL_FOR[over.runtime ?? "unknown"];
    },
  });
  return { state: observation.state, calls, evidence: observation.evidence };
}

test("a delivered record lands, a fenced loss drops, and an unverified failure is uncertain (#1465)", async () => {
  expect((await classify(found(receipt({ state: "delivered", resend: "not-needed" })))).state).toBe("landed");
  expect((await classify(found(receipt({ state: "failed", resend: "safe" })))).state).toBe("dropped");
  expect((await classify(found(receipt({ state: "failed", resend: "verify-first", duplicateRisk: true })))).state).toBe("uncertain");
  /* A failure whose guidance is missing proves nothing, so it is not a drop. */
  expect((await classify(found(receipt({ state: "failed", resend: null })))).state).toBe("uncertain");
});

// The wake lookup models a journal-history miss. The real send resolver
// still needs a local journal client to arbitrate canonical confirmation.
function lateWakePorts(registry: InstanceType<typeof AgentRegistry>, end: boolean) {
  return {
    ...wakeRecordPorts({ end }),
    lookup: (binding: Parameters<typeof resolveOriginalSend>[0]) => resolveOriginalSend(binding, { registry, client: runtimeClient({}) }),
    journal: async () => null,
  };
}

test("a timed-out Claude wake resolves under its original key when its ledger confirms delivery late", async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, "late-wake-"));
  const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  await registry.prepareRecoveryIndexes();
  const conversation = registry.ensureConversation("claude", path.join(dir, `${crypto.randomUUID()}.jsonl`), null);
  const text = "Check the owed lane outcomes.";
  const key = "seat-tick:fixture:3:first:lane-event:prompt-fixture";
  const held = registry.holdDelivery(conversation.id, text, key, "text", [], structuredContentDigest({ text, images: [] }), {
    kind: "send", policy: "interrupt-active", origin: { kind: "agent", role: "seat-tick" },
  });
  registry.recordDeliveryOutcome(held.id, "failed", "Claude delivery confirmation timed out; outcome is uncertain", "unverified");
  const ledger = new FileClaudeDeliveryLedger();
  const session = conversation.generations[0]!.id;
  ledger.recordQueued(session, { id: held.command.operationId, text }, "turn-started");
  const wake = { ...WAKE, conversationId: conversation.id, clientMessageId: key, operationId: null, text };
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = "";
  setAgentRegistryForTests(registry);
  try {
    // The journal has no record of the operation, as after its retention window.
    const ports = lateWakePorts(registry, true);
    expect((await wakeStateFromRecord(wake, ports)).state).toBe("uncertain");
    ledger.recordQueued(session, { id: "different-operation", text }, "turn-started");
    ledger.confirmDelivered(session, "different-operation", "other-message");
    ledger.recordQueued("unrelated-session", { id: held.command.operationId, text }, "turn-started");
    ledger.confirmDelivered("unrelated-session", held.command.operationId, "other-session-message");
    expect((await wakeStateFromRecord(wake, ports)).state).toBe("uncertain");
    ledger.confirmDelivered(session, held.command.operationId, "engine-message-fixture");
    const unavailable = { ...ports, lookup: (binding: Parameters<typeof resolveOriginalSend>[0]) => resolveOriginalSend(binding, { registry, client: null }) };
    expect((await wakeStateFromRecord(wake, unavailable)).state).toBe("unknown");
    // A diagnostic can observe the proof while leaving both stores untouched.
    const before = JSON.stringify(registry.readOnlySnapshot());
    const readonly = lateWakePorts(registry, false);
    expect(await wakeStateFromRecord(wake, readonly)).toMatchObject({ state: "landed", evidence: { confirmation: "claude-ledger", record: { state: "failed" } } });
    expect(JSON.stringify(registry.readOnlySnapshot())).toBe(before);
    expect((await wakeStateFromRecord({ ...wake, text: "A changed instruction." }, ports)).state).toBe("unknown");
    const observed = await wakeStateFromRecord(wake, ports);
    expect(observed).toMatchObject({ state: "landed", evidence: { operationId: held.command.operationId, journal: "no-record", confirmation: "claude-ledger", record: { state: "delivered", resend: "not-needed" } } });
    expect(registry.readOnlySnapshot().heldDeliveries[held.id]).toMatchObject({ state: "delivered", clientMessageId: key, command: { operationId: held.command.operationId } });
  } finally {
    setAgentRegistryForTests(null);
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  }
});

/* A record ended without proof is asked about once more, of the journal, under
   the operation the record names — and only the journal's own terminal
   verdicts change the answer. Silence, an unreachable host, an open status
   and an unverified ending all leave the record's `uncertain` standing. */
test("a timed-out Codex wake retains canonical transcript confirmation", async () => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const { deliveryDedupToken } = await import("@/lib/runtime/deliveryDedup");
  const dir = fs.mkdtempSync(path.join(SANDBOX, "codex-wake-"));
  const registry = new AgentRegistry(path.join(dir, "fixture-registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  await registry.prepareRecoveryIndexes();
  const transcript = path.join(dir, "fixture.jsonl");
  const conversation = registry.ensureConversation("codex", transcript, null);
  const text = "Check the owed lane outcomes.";
  const key = "seat-tick:codex-fixture";
  const held = registry.holdDelivery(conversation.id, text, key, "text", [], null, { kind: "send", policy: "queue" });
  registry.beginDeliveryAttempt(held.id, conversation.generations[0]!.id);
  registry.recordDeliveryOutcome(held.id, "failed", "Codex delivery confirmation timed out; outcome is uncertain", "unverified");
  const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(held.command.operationId));
  fs.writeFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = "";
  setAgentRegistryForTests(registry);
  try {
    const wake = { ...WAKE, conversationId: conversation.id, clientMessageId: key, operationId: null, text };
    const ports = lateWakePorts(registry, true);
    const unavailable = { ...ports, lookup: (binding: Parameters<typeof resolveOriginalSend>[0]) => resolveOriginalSend(binding, { registry, client: null }) };
    expect((await wakeStateFromRecord(wake, unavailable)).state).toBe("unknown");
    expect((await wakeStateFromRecord(wake, ports)).state).toBe("landed");
    expect((await wakeStateFromRecord({ ...wake, text: "A different request." }, ports)).state).toBe("unknown");
  } finally {
    setAgentRegistryForTests(null);
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  }
});

test("an unverified record yields to the journal's own terminal verdict, and to nothing weaker", async () => {
  const unverified = found(receipt({ state: "failed", reason: "delivery was accepted and the delivery journal holds no record of it", resend: "verify-first", duplicateRisk: true, settledAt: new Date(NOW).toISOString() }));
  expect(await classify(unverified, { runtime: "landed" })).toMatchObject({ state: "landed", calls: ["lookup", "journal", "record:op-wake-1"], evidence: { recorded: "delivered" } });
  expect(await classify(unverified, { runtime: "dropped" })).toMatchObject({ state: "dropped", evidence: { recorded: "lost", record: { resend: "safe" } } });
  expect((await classify(unverified, { runtime: { status: "failed", reason: "delivery-discarded" } })).state).toBe("dropped");
  /* A record that will not take the verdict changes nothing: the release
     rests on the journal, and the replacement is a new message anyway. */
  expect(await classify(unverified, { runtime: "dropped", rearm: "refused" })).toMatchObject({ state: "dropped", evidence: { recorded: "refused", record: { resend: "verify-first" } } });
  /* An inert read reports what the journal proves and writes nothing. */
  expect(await classify(unverified, { runtime: "dropped", readOnly: true })).toMatchObject({ state: "dropped", calls: ["lookup", "journal"] });
  /* The settlement's own `failed` on an old host is its unverified ending. */
  expect((await classify(unverified, { runtime: { status: "failed", reason: SEND_UNVERIFIED_REASON } })).state).toBe("uncertain");
  expect((await classify(unverified, { runtime: "uncertain" })).state).toBe("uncertain");
  expect((await classify(unverified, { runtime: { status: "interrupted", reason: null } })).state).toBe("uncertain");
  /* An open status is the journal still holding it. */
  expect((await classify(unverified, { runtime: "retained" })).state).toBe("retained");
  const silent = await classify(unverified, { runtime: "unknown" });
  expect(silent).toMatchObject({ state: "uncertain", evidence: { operationId: "op-wake-1", journal: "no-record", record: { state: "failed", resend: "verify-first" } } });
  expect(silent.evidence!.record!.reason).toContain("holds no record");
  const unreachable = await classify(unverified, { runtime: "unreachable" });
  expect(unreachable).toMatchObject({ state: "uncertain", evidence: { journal: "unreachable" } });
});

test("a read with no settlement port is inert: an in-flight record is reported retained and nothing is ended", async () => {
  expect(await classify(found(receipt({})), { readOnly: true })).toMatchObject({ state: "retained", calls: ["lookup"], evidence: { record: { state: "in-flight" }, journal: "unasked" } });
});

test("an in-flight record is ended by the tick's own settlement, and classified by its answer (#1465)", async () => {
  const still = await classify(found(receipt({})), { settle: receipt({}) });
  expect(still).toMatchObject({ state: "retained", calls: ["lookup", "settle"] });
  expect((await classify(found(receipt({})), { settle: receipt({ state: "delivered", resend: "not-needed" }) })).state).toBe("landed");
  expect((await classify(found(receipt({})), { settle: receipt({ state: "failed", resend: "safe" }) })).state).toBe("dropped");
  expect((await classify(found(receipt({})), { settle: receipt({ state: "failed", resend: "verify-first" }) })).state).toBe("uncertain");
  expect((await classify(found(receipt({})), { settle: null })).state).toBe("unknown");
});

test("a record the journal could not be read for is unknown, whatever the durable projection says (#1465)", async () => {
  const current = receipt({});
  const unreadable: OriginalSendEvidence = { kind: "found", operationId: current.operationId, deliveryId: "delivery-1", receipt: current, reservationState: "assigned", current: { readable: false, reason: "runtime host is unavailable" } };
  expect(await classify(unreadable)).toMatchObject({ state: "unknown", calls: ["lookup"], evidence: { journal: "unreachable" } });
});

test("absence under the key asks the runtime when there is an operation to ask about, and is unknown otherwise (#1465)", async () => {
  expect(await classify({ kind: "absent" }, { runtime: "retained" })).toMatchObject({ state: "retained", calls: ["lookup", "journal"] });
  expect(await classify({ kind: "absent" }, { runtime: "dropped" })).toMatchObject({ state: "dropped", calls: ["lookup", "journal"] });
  expect(await classify({ kind: "absent" }, { runtime: "unknown" })).toMatchObject({ state: "unknown", evidence: { operationId: "op-wake-1", record: null, journal: "no-record" } });
  expect(await classify({ kind: "absent" }, { runtime: "unreachable" })).toMatchObject({ state: "unknown", evidence: { journal: "unreachable" } });
  /* No record and no operation: the layer affirms it never held it (#1465). */
  expect(await classify({ kind: "absent" }, { wake: { ...WAKE, operationId: null } })).toMatchObject({ state: "absent", calls: ["lookup"] });
});

test("ambiguity, an unresolved target, an unreadable record and a contradictory one are all unknown (#1465)", async () => {
  expect((await classify({ kind: "ambiguous", operationIds: ["op-a", "op-b"] })).state).toBe("unknown");
  expect((await classify({ kind: "unresolved" })).state).toBe("unknown");
  expect((await classify({ kind: "unreadable", reason: "the delivery record could not be read" })).state).toBe("unknown");
  expect((await classify({ kind: "contradictory" })).state).toBe("unknown");
});

/* ------------------------------------------------------------------------- *
 * The child projection (#1465): what one registry snapshot says about the
 * seat's spawned children.
 * ------------------------------------------------------------------------- */

interface ChildRegistry {
  registry: InstanceType<typeof AgentRegistry>;
  cwd: string;
  project: string;
  seatId: string;
  now: number;
  spawn(options: { title: string; turn?: "busy" | "idle" | "terminal" | "unknown"; terminalAt?: string | null; host?: "live" | "dead" | "idle" | null; cwd?: string; unobserved?: boolean; parent?: string; transcriptPath?: string; ledger?: boolean; admissionOwned?: boolean }): { id: string; launchId: string; path: string };
}

function childRegistry(name: string): ChildRegistry {
  const dir = fs.mkdtempSync(path.join(SANDBOX, `${name}-`));
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  const seat = registry.ensureConversation("claude", path.join(dir, `${crypto.randomUUID()}.jsonl`), null);
  const project = projectForCwd(cwd);
  if (!project) throw new Error("fixture cwd resolves to no project");
  /* Three minutes past the writes, so a `starting` receipt has outlived its
     admission lease and is not evidence of a host. */
  const now = Date.now() + 3 * MINUTE_MS;
  return {
    registry,
    cwd,
    project,
    seatId: seat.id,
    now,
    spawn(options) {
      const childCwd = options.cwd ?? cwd;
      const childPath = options.transcriptPath ?? path.join(SESSIONS, `${crypto.randomUUID()}.jsonl`);
      fs.writeFileSync(childPath, "");
      const observed = options.unobserved ? null : registry.ensureConversation("claude", childPath, null);
      const begun = registry.beginSpawnRequest({
        engine: "claude",
        cwd: childCwd,
        transport: "structured",
        ...(observed ? { conversationId: observed.id } : {}),
        parentConversationId: (options.parent ?? seat.id) as never,
        parentSource: "explicit",
        launchProfile: { title: options.title },
      });
      if (!options.admissionOwned && begun.receipt.admissionOwner) {
        registry.releaseStructuredSpawnAdmissionOwner(begun.receipt.launchId, begun.receipt.admissionOwner);
      }
      const child = observed ?? { id: begun.receipt.conversationId, generations: [] };
      if (!options.unobserved) {
        registry.reconcileConversations([{
          engine: "claude",
          path: childPath,
          accountId: null,
          launchProfile: emptyLaunchProfile({ cwd: childCwd, title: options.title }),
          turn: { state: options.turn ?? "busy", source: "assistant", terminalAt: options.terminalAt ?? null },
          observedAt: new Date(now - 5 * MINUTE_MS).toISOString(),
        }]);
      }
      if (options.host) {
        registry.upsert({ key: sessionKeyFromTranscript("claude", childPath)!, artifactPath: childPath, cwd: childCwd, accountId: null, status: options.host, host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
      }
      if (observed && (options.ledger ?? (options.turn === "terminal" || (options.turn === "idle" && options.host !== "idle")))) {
        const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
        ledger.append(observed.generations[0]!.id, { kind: "turn-started", turnId: "turn-one", seq: 1 });
        ledger.append(observed.generations[0]!.id, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
      }
      return { id: child.id, launchId: begun.receipt.launchId, path: childPath };
    },
  };
}

function childGather(fixture: Omit<ChildRegistry, "spawn">, over: Parameters<typeof sources>[0] = {}, state: SeatTickProjectState = emptySeatTickState()) {
  return gatherSeatTickInput(fixture.project, state, DEFAULT_SEAT_TICK_POLICY, sources({
    registry: fixture.registry,
    seatConversationId: fixture.seatId,
    pipelines: [],
    now: fixture.now,
    ...over,
  }));
}

/** A production SQLite layout with fixed identities and clocks for recovery
 * regressions. The JSON seed is normalized by the production reader. */
function replayChildren(name: string, cases: { title: string; unobserved?: boolean; host?: "dead" | "live"; ledger?: boolean | "partial"; generations?: number; admissionOwned?: boolean }[]) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, `${name}-`));
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const filename = path.join(dir, "registry.sqlite");
  const seatId = `conversation_${name}_seat`;
  const successorId = `conversation_${name}_successor`;
  const createdAt = new Date(NOW - 10 * MINUTE_MS).toISOString();
  const conversation = (id: string, generations: unknown[] = []) => ({ id, engine: "claude", generations,
    turn: { state: "unknown", source: "empty", terminalAt: null, observedAt: null }, createdAt, updatedAt: createdAt });
  const file = normalizeRegistry({ version: 2, entries: {}, receipts: {}, conversations: {
    [seatId]: conversation(seatId), [successorId]: conversation(successorId),
  } });
  const workers = cases.map((options, index) => {
    const id = `conversation_${name}_${index}`;
    const launchId = `${name}-launch-${index}`;
    const generations = Array.from({ length: options.generations ?? 1 }, (_, generationIndex) => {
      const digest = createHash("sha256").update(`${name}/${index}/${generationIndex}`).digest("hex");
      const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
      const transcriptPath = path.join(SESSIONS, `${id}.jsonl`);
      fs.writeFileSync(transcriptPath, "");
      fs.utimesSync(transcriptPath, NOW / 1000 - 60, NOW / 1000 - 60);
      return { id, path: transcriptPath, key: sessionKeyFromTranscript("claude", transcriptPath)! };
    });
    const latest = generations.at(-1)!;
    const { id: generation, path: childPath, key } = latest;
    const profile = emptyLaunchProfile({ cwd, title: options.title });
    const seed = normalizeRegistry({ version: 2, entries: {}, receipts: {
      [launchId]: { launchId, conversationId: id, engine: "claude", cwd, createdAt,
        state: options.unobserved ? "starting" : "completed", transport: "structured", launchProfile: profile,
        admissionOwner: options.admissionOwned ? { pid: 42, startIdentity: null } : null,
        artifactPath: options.unobserved ? null : childPath, key: options.unobserved ? null : key },
    }, conversations: options.unobserved ? {} : { [id]: conversation(id, generations.map((item) => ({ id: item.id, path: item.path, accountId: null, launchProfile: profile, host: null, createdAt }))) } });
    Object.assign(file.receipts, seed.receipts);
    Object.assign(file.conversations, seed.conversations);
    if (options.host) file.entries[`claude:${generation}`] = { key, artifactPath: childPath, cwd, accountId: null,
      status: options.host, host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, updatedAt: createdAt };
    file.lineageEdges[id] = { childConversationId: id as never, parentConversationId: seatId as never, childSessionKey: options.unobserved ? null : key,
      parentSessionKey: null, childArtifactPath: options.unobserved ? null : childPath, parentArtifactPath: null,
      source: "viewer-spawn", kind: "spawn", role: null, reviewsConversationId: null, createdAt, evidence: { launchId, clientAttemptId: null } };
    if (options.ledger) {
      const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
      for (const [generationIndex, item] of generations.entries()) {
        ledger.append(item.id, { kind: "turn-started", turnId: `turn-${generationIndex}-one`, seq: 1 });
        ledger.append(item.id, { kind: "turn-ended", turnId: `turn-${generationIndex}-one`, status: "completed", seq: 2 });
        if (options.ledger === "partial" && generationIndex === generations.length - 1) {
          ledger.append(item.id, { kind: "turn-started", turnId: "abandoned-turn", seq: 3 });
        }
      }
    }
    return { id, launchId, path: childPath, generation, generations: generations.map((item) => item.id) };
  });
  const store = new SqliteAgentRegistryStore(filename, { normalize: normalizeRegistry, initialSnapshot: file });
  store.close();
  const registry = new AgentRegistry(path.join(dir, "registry.json"), () => false, undefined, { sqliteMode: "sqlite", sqliteFilename: filename });
  return { registry, cwd, project: projectForCwd(cwd)!, seatId, successorId, now: NOW, workers };
}

test("each kind of child is classified from the snapshot alone (#1465)", async () => {
  const fixture = childRegistry("classify");
  const running = fixture.spawn({ title: "running worker", turn: "busy", host: "live" });
  const idleHosted = fixture.spawn({ title: "idle worker with a host", turn: "idle", host: "idle" });
  const finished = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() });
  const released = fixture.spawn({ title: "released worker", turn: "idle", host: "dead" });
  const gone = fixture.spawn({ title: "worker whose host died", turn: "busy", host: "dead" });
  const failed = fixture.spawn({ title: "failed launch", unobserved: true });
  fixture.registry.failSpawn(failed.launchId, "could not start");
  const reserved = fixture.spawn({ title: "reservation nothing settled", unobserved: true });
  const unknownTurn = fixture.spawn({ title: "never observed", turn: "unknown" });
  const livenessCalls: { project?: string; conversationId?: string; stallAfterMs: number }[] = [];
  const input = await childGather(fixture, {
    livenessCalls,
    childRows: { [running.id]: livenessRow({ conversationId: running.id, lifecycle: "running", reason: "host_alive_turn_active", pipeline: null }) },
  });
  const byId = new Map(input.children.map((child) => [child.conversationId, child]));
  expect(byId.get(running.id)).toMatchObject({ status: "running", outcome: null, title: "running worker", activity: { lifecycle: "running", reason: "host_alive_turn_active" } });
  expect(byId.get(idleHosted.id)).toMatchObject({ status: "running", activity: null });
  expect(byId.get(finished.id)).toMatchObject({ status: "terminal", outcome: "finished", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() });
  expect(byId.get(released.id)).toMatchObject({ status: "terminal", outcome: "finished" });
  expect(byId.get(released.id)!.terminalAt).not.toBeNull();
  expect(byId.get(gone.id)).toMatchObject({ status: "running", activity: { lifecycle: "gone", reason: "host_gone_turn_open", turnState: "busy" } });
  expect(byId.get(failed.id)).toMatchObject({ status: "terminal", outcome: "failed", title: "failed launch" });
  expect(byId.get(reserved.id)).toMatchObject({ status: "terminal", outcome: "failed" });
  expect(byId.get(unknownTurn.id)).toMatchObject({ status: "unknown" });
  /* The unobserved turn with a readable transcript still needs evidence;
     the abandoned reservation has its own terminal failure. */
  expect(input.childrenUnavailable).toBe("child-unplaced");
  expect(input.state.childrenGap).toMatchObject({ gap: "child-unplaced", attempts: 1, reported: false });
  /* Liveness is asked by id, for the hosted open turns only: the stall the
     registry can see itself and the settled turns cost no read. */
  expect(livenessCalls).toEqual([{ conversationId: running.id, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs }]);
});

test("a fresh launch inside its admission lease is a running child even before a host is recorded (#1465)", async () => {
  const fixture = childRegistry("fresh-launch");
  const fresh = fixture.spawn({ title: "just launched", turn: "unknown" });
  const input = await childGather(fixture, { now: Date.now() });
  expect(input.children).toMatchObject([{ conversationId: fresh.id, status: "running" }]);
});

test("a settled child with an unknown registry turn clears the gap and stays acknowledged across seat rotation", async () => {
  const fixture = replayChildren("settled-unknown", [{ title: "completed deputy", host: "dead", ledger: true }]);
  const worker = fixture.workers[0]!;
  const first = await childGather(fixture);
  expect(first.childrenUnavailable).toBeNull();
  expect(first.children).toMatchObject([{ conversationId: worker.id, title: "completed deputy", status: "terminal", outcome: "finished" }]);
  const accounting = new SeatTickAccounting(first.state.accounting!.filename, fixture.project);
  const outcome = accounting.ready(1)[0]!;
  const wake = { clientMessageId: "harvest-completed-deputy", conversationId: fixture.seatId, seatEpoch: 7,
    operationId: null, commit: { proposal: false, reasons: [], fingerprint: "completed-deputy", eventsThrough: 0, children: [outcome.identity] } };
  expect(accounting.prepare(accounting.readState(), wake)).toBe(true);
  expect(accounting.settle(wake.clientMessageId, { ...accounting.readState(), lastWakeAt: new Date(fixture.now).toISOString() }, "landed")).toBe(true);
  const rotated = await childGather(fixture, { seatConversationId: fixture.successorId, seatEpoch: 8 }, accounting.readState());
  expect(rotated.childrenUnavailable).toBeNull();
  expect(rotated.children).toEqual([]);
  expect(new SeatTickAccounting(first.state.accounting!.filename, fixture.project).ready(10)).toEqual([]);
});

test("an expired launch without a conversation is a named failure owed until its wake lands", async () => {
  const fixture = replayChildren("abandoned-launch", [{ title: "launch never materialized", unobserved: true }]);
  const worker = fixture.workers[0]!;
  const first = await childGather(fixture);
  expect(first.childrenUnavailable).toBeNull();
  expect(first.children).toMatchObject([{ conversationId: worker.id, title: "launch never materialized", status: "terminal", outcome: "failed", transcriptReason: "no-transcript" }]);
  const again = await childGather(fixture, {}, first.state);
  expect(again.children.map(child => child.outcomeId)).toEqual(first.children.map(child => child.outcomeId));
  expect(new SeatTickAccounting(first.state.accounting!.filename, fixture.project).ready(10)).toHaveLength(1);
});

test("a hostless child without a transcript is a named failure while a live child and an admission owner stay running", async () => {
  const fixture = replayChildren("lost-transcript", [
    { title: "host ended without transcript", host: "dead" },
    { title: "live worker without transcript", host: "live" },
    { title: "launch still owned", unobserved: true, admissionOwned: true },
  ]);
  const [lost, live, admitting] = fixture.workers as [typeof fixture.workers[number], typeof fixture.workers[number], typeof fixture.workers[number]];
  fs.unlinkSync(lost.path);
  fs.unlinkSync(live.path);
  const input = await childGather(fixture);
  expect(input.childrenUnavailable).toBeNull();
  const byId = new Map(input.children.map(child => [child.conversationId, child]));
  expect(byId.get(lost.id)).toMatchObject({ status: "terminal", outcome: "failed", transcriptReason: "missing" });
  expect(byId.get(live.id)).toMatchObject({ status: "running", outcome: null });
  expect(byId.get(admitting.id)).toMatchObject({ status: "running", outcome: null });
  expect(new SeatTickAccounting(input.state.accounting!.filename, fixture.project).ready(10)).toHaveLength(1);
});

test("a gap in a completed ledger preserves the unplaced child and its owed result", async () => {
  const fixture = replayChildren("gapped-completion", [{ title: "completion with missing events", host: "dead", ledger: true }]);
  const worker = fixture.workers[0]!;
  fs.appendFileSync(statePath("structured-host-events", `${worker.generation}.jsonl`), JSON.stringify({ kind: "unhosted", seq: 4 }) + "\n");
  const input = await childGather(fixture);
  expect(input.childrenUnavailable).not.toBeNull();
  expect(input.children.some(child => child.conversationId === worker.id && child.status === "unknown")).toBe(true);
  const accounting = new SeatTickAccounting(input.state.accounting!.filename, fixture.project);
  expect(accounting.ready(10)).toHaveLength(1);
  expect(accounting.page("source", 10)).toMatchObject([{ cursor: { gap: "sequence-gap" } }]);
});

test("a lost transcript and ledger resolve once while retained outcomes stay owed", async () => {
  const fixture = replayChildren("lost-ledger", [{ title: "worker whose records vanished", host: "dead", ledger: true }]);
  const worker = fixture.workers[0]!;
  const first = await childGather(fixture);
  expect(first.childrenUnavailable).toBeNull();
  fs.unlinkSync(worker.path);
  fs.unlinkSync(statePath("structured-host-events", `${worker.generation}.jsonl`));
  const lost = await childGather(fixture, {}, first.state);
  expect(lost.childrenUnavailable).toBeNull();
  expect(lost.children.some(child => child.conversationId === worker.id && child.outcome === "failed")).toBe(true);
  const accounting = new SeatTickAccounting(lost.state.accounting!.filename, fixture.project);
  expect(accounting.ready(10).map(row => row.input.outcome)).toEqual(["finished", "failed"]);
  const again = await childGather(fixture, {}, lost.state);
  expect(again.childrenUnavailable).toBeNull();
  expect(accounting.ready(10)).toHaveLength(2);
});

test("a hostless partial ledger names its abandoned turn and keeps earlier and later outcomes", async () => {
  const fixture = replayChildren("partial-ledger", [{ title: "host died during second turn", host: "dead", ledger: "partial" }]);
  const worker = fixture.workers[0]!;
  fs.unlinkSync(worker.path);
  let input = await childGather(fixture);
  const accounting = new SeatTickAccounting(input.state.accounting!.filename, fixture.project);
  expect(input.childrenUnavailable).toBeNull();
  expect(accounting.ready(10).map(row => row.input.outcome)).toEqual(["finished", "failed"]);
  for (let tick = 0; tick < 2; tick += 1) {
    input = await childGather(fixture, {}, input.state);
    expect(input.childrenUnavailable).toBeNull();
  }
  expect(accounting.ready(10).map(row => row.input.outcome)).toEqual(["finished", "failed"]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(worker.generation, { kind: "turn-ended", turnId: "abandoned-turn", status: "interrupted", seq: 4 });
  input = await childGather(fixture, {}, input.state);
  expect(input.childrenUnavailable).toBeNull();
  expect(accounting.ready(10).map(row => row.input.outcome)).toEqual(["finished", "failed", "failed"]);
});

test("a proven latest-generation completion stays placed through historical polls and acknowledgment", async () => {
  const fixture = replayChildren("historical-generations", [{ title: "two completed generations", host: "dead", ledger: true, generations: 2 }]);
  let input = await childGather(fixture);
  const accounting = new SeatTickAccounting(input.state.accounting!.filename, fixture.project);
  input = await childGather(fixture, {}, input.state);
  expect(input.childrenUnavailable).toBeNull();
  expect(input.children.some(child => child.status === "terminal" && child.outcome === "finished")).toBe(true);
  const outcomes = accounting.ready(10);
  expect(outcomes).toHaveLength(2);
  const wake = { clientMessageId: "harvest-both-generations", conversationId: fixture.seatId, seatEpoch: 7,
    operationId: null, commit: { proposal: false, reasons: [], fingerprint: "two-generations", eventsThrough: 0, children: outcomes.map(row => row.identity) } };
  expect(accounting.prepare(accounting.readState(), wake)).toBe(true);
  expect(accounting.settle(wake.clientMessageId, { ...accounting.readState(), lastWakeAt: new Date(fixture.now).toISOString() }, "landed")).toBe(true);
  for (let tick = 0; tick < 4; tick += 1) {
    input = await childGather(fixture, {}, input.state);
    expect(input.childrenUnavailable).toBeNull();
    expect(input.children.some(child => child.status === "unknown")).toBe(false);
  }
  expect(accounting.ready(10)).toEqual([]);
});

test("retained structured custody keeps a completed child running until the registry clears it", async () => {
  const fixture = replayChildren("retained-custody", [
    { title: "structured host retained", host: "dead", ledger: true },
    { title: "termination survivor retained", host: "dead", ledger: true },
  ]);
  const identity = { pid: 42, startIdentity: null };
  for (const [index, worker] of fixture.workers.entries()) {
    const entry = fixture.registry.readOnlySnapshot().entries[`claude:${worker.generation}`]!;
    fixture.registry.upsert({ ...entry, ...(index === 0 ? { structuredHost: {
      kind: "claude-broker" as const, endpoint: "fixture-endpoint", process: identity, eventCursor: 2, protocolVersion: null,
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [],
    } } : { structuredTerminationSurvivors: [identity] }) });
  }
  const input = await childGather(fixture);
  expect(input.childrenUnavailable).toBeNull();
  for (const worker of fixture.workers) {
    expect(input.children.some(child => child.conversationId === worker.id && child.status === "running")).toBe(true);
  }
  const released = fixture.workers[0]!;
  const entry = fixture.registry.readOnlySnapshot().entries[`claude:${released.generation}`]!;
  fixture.registry.upsert({ ...entry, structuredHost: null });
  const cleared = await childGather(fixture, {}, input.state);
  expect(cleared.childrenUnavailable).toBeNull();
  expect(cleared.children.some(child => child.conversationId === released.id && child.status === "running")).toBe(false);
  expect(cleared.children.some(child => child.conversationId === fixture.workers[1]!.id && child.status === "running")).toBe(true);
});

test("a child acquiring a host after discovery is rechecked before a missing-record resolution", async () => {
  const fixture = replayChildren("host-after-discovery", [{ title: "worker recovering during the tick", host: "dead" }]);
  const worker = fixture.workers[0]!;
  fs.unlinkSync(worker.path);
  let scheduled = false;
  let published = false;
  const registry = fixture.registry;
  const ports = sources({ registry, seatConversationId: fixture.seatId, pipelines: [], now: fixture.now });
  ports.registry = () => ({
    seatTickConversation: registry.seatTickConversation.bind(registry),
    conversation: registry.conversation.bind(registry),
    conversationForPath: registry.conversationForPath.bind(registry),
    readOnlySnapshot: registry.readOnlySnapshot.bind(registry),
    pageSeatChildren: (...args: Parameters<typeof registry.pageSeatChildren>) => {
      const page = registry.pageSeatChildren(...args);
      if (!scheduled && page?.keys.length) {
        scheduled = true;
        setImmediate(() => {
          const entry = registry.readOnlySnapshot().entries[`claude:${worker.generation}`]!;
          registry.upsert({ ...entry, status: "live" });
          published = true;
        });
      }
      return page;
    },
  }) as never;
  const input = await gatherSeatTickInput(fixture.project, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(published).toBe(true);
  expect(input.childrenUnavailable).toBeNull();
  expect(input.children).toMatchObject([{ conversationId: worker.id, status: "running", outcome: null }]);
  expect(new SeatTickAccounting(input.state.accounting!.filename, fixture.project).ready(10)).toEqual([]);
});

test("harvested children leave the projection, and one seen running again is released from the cursor (#1465)", async () => {
  const fixture = childRegistry("harvested");
  const finished = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() });
  const again = fixture.spawn({ title: "re-instructed worker", turn: "busy", host: "live" });
  const input = await childGather(fixture, {}, { ...emptySeatTickState(), harvestedChildren: [finished.id, again.id] });
  expect(input.children.map((child) => child.conversationId)).toEqual([again.id]);
  expect(input.state.harvestedChildren).toEqual([]);
  expect(new SeatTickAccounting(input.state.accounting!.filename, fixture.project).page("legacy", 10)).toHaveLength(2);
});

test("other seats' children, other projects' children and the seat itself are not projected (#1465)", async () => {
  const fixture = childRegistry("scope");
  const elsewhere = path.join(path.dirname(fixture.cwd), "other-repo");
  fs.mkdirSync(elsewhere);
  fixture.spawn({ title: "another project", turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString(), cwd: elsewhere });
  const otherSeat = fixture.registry.ensureConversation("claude", path.join(path.dirname(fixture.cwd), `${crypto.randomUUID()}.jsonl`), null);
  fixture.spawn({ title: "another seat's", turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString(), parent: otherSeat.id });
  const mine = fixture.spawn({ title: "mine", turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() });
  const input = await childGather(fixture);
  expect(input.children.map((child) => child.conversationId)).toEqual([mine.id]);
  const noSeat = await childGather(fixture, { noSeat: true });
  expect(noSeat.children).toEqual([]);
});

test("paged discovery eventually reaches every child without a newest window (#1465)", async () => {
  const fixture = childRegistry("bounded");
  for (let index = 0; index < 63; index += 1) fixture.spawn({ title: `worker ${index}`, turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() });
  let input = await childGather(fixture);
  for (let tick = 0; tick < 12; tick++) {
    expect(input.children.length).toBeLessThanOrEqual(20);
    input = await childGather(fixture, {}, input.state);
  }
  const accounting = new SeatTickAccounting(input.state.accounting!.filename, fixture.project);
  expect(accounting.collection.snapshot().filter((row) => row.kind === "outcome")).toHaveLength(63);
}, 15_000);

/* A registry with no indexed lineage projection (a JSON-mode registry) still
   answers the seat's own turn; the children beside it are a gap of their own
   rather than a failed check (#1465). */
test("a registry that cannot page children reports the children as unindexed, and reads the seat (#1465)", async () => {
  const fixture = childRegistry("unindexed");
  fixture.spawn({ title: "worker", turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() });
  const registry = fixture.registry;
  const unindexed = {
    seatTickConversation: registry.seatTickConversation.bind(registry),
    pageSeatChildren: () => null,
    conversation: (id: string) => registry.conversation(id as never),
    conversationForPath: (artifactPath: string) => registry.conversationForPath(artifactPath),
    readOnlySnapshot: () => registry.readOnlySnapshot(),
  } as never;
  const input = await childGather(fixture, { registry: unindexed, seatTurn: "busy" });
  expect(input.children).toEqual([]);
  expect(input.childrenUnavailable).toBe("children-unindexed");
  expect(input.seat).toMatchObject({ conversationId: fixture.seatId });
});

/* The run of failures is the gather's to keep (#1465): a check that could not
   account for every child advances it, and one that could clears it. */
test("the children gap run advances across failing checks and clears when every child is accounted for (#1465)", async () => {
  const fixture = childRegistry("children-run");
  fixture.spawn({ title: "turn not observed yet", turn: "unknown" });
  const first = await childGather(fixture);
  expect(first.state.childrenGap).toMatchObject({ gap: "child-unplaced", attempts: 1 });
  const second = await childGather(fixture, { now: fixture.now + 5 * MINUTE_MS }, first.state);
  expect(second.state.childrenGap).toMatchObject({ gap: "child-unplaced", attempts: 2, since: first.state.childrenGap!.since });
  const healthy = childRegistry("children-clear");
  healthy.spawn({ title: "finished", turn: "terminal", terminalAt: new Date(healthy.now - 20 * MINUTE_MS).toISOString() });
  const cleared = await childGather(healthy, {}, { ...emptySeatTickState(), childrenGap: second.state.childrenGap });
  expect(cleared.childrenUnavailable).toBeNull();
  expect(cleared.state.childrenGap).toBeNull();
});

test("a snapshot that cannot be taken is a gap, and the children read as none (#1465)", async () => {
  const fixture = childRegistry("unreadable");
  fixture.spawn({ title: "worker", turn: "terminal", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() });
  const registry = fixture.registry;
  const blind = {
    seatTickConversation: registry.seatTickConversation.bind(registry),
            conversation: (id: string) => registry.conversation(id as never),
    conversationForPath: (artifactPath: string) => registry.conversationForPath(artifactPath),
    readOnlySnapshot: () => { throw new Error("rewriting"); },
  } as never;
  const input = await childGather(fixture, { registry: blind });
  expect(input.children).toEqual([]);
  expect(input.childrenUnavailable).toBe("registry-unreadable");
});

test("a child finishing, and a harvested child leaving, both move the fingerprint (#1465)", async () => {
  const fixture = childRegistry("fingerprint");
  const worker = fixture.spawn({ title: "worker", turn: "busy", host: "live" });
  const running = await childGather(fixture);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: worker.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: new Date(fixture.now - MINUTE_MS).toISOString() },
    observedAt: new Date(fixture.now - MINUTE_MS).toISOString(),
  }]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  const generation = fixture.registry.conversation(worker.id as never)!.generations[0]!.id;
  ledger.append(generation, { kind: "turn-started", turnId: "turn-one", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
  const finished = await childGather(fixture);
  expect(seatTickBoardMoved(running.changeFingerprint, finished.changeFingerprint)).toBe(true);
  const harvested = await childGather(fixture, {}, { ...emptySeatTickState(), harvestedChildren: [worker.id] });
  expect(seatTickBoardMoved(finished.changeFingerprint, harvested.changeFingerprint)).toBe(true);
  expect(seatTickBoardMoved(finished.changeFingerprint, (await childGather(fixture)).changeFingerprint)).toBe(false);
});

/* ---------------------------------------------------------------------------
 * What the seat's own create call produced, read off the lane (#1799)
 * ------------------------------------------------------------------------- */

test("a lane the seat created reads as provisioned while its first stage is its only attempt (#1799)", async () => {
  const provisioned = lane({ srcConversationId: CONVERSATION, state: "running" });
  const input = await gather({ pipelines: [provisioned] });
  expect(input.ownLanes).toEqual([{
    id: "pipeline_a1",
    title: "ship the exporter",
    settled: "provisioned",
    updatedAt: expect.any(String),
  }]);

  /* Past the first attempt the lane is simply working, and the interval agenda
     already lists it as open: the announcement is about the create call, not
     about every stage the lane goes on to run. */
  const second = lane({
    srcConversationId: CONVERSATION,
    state: "running",
    runs: [{ stageId: "build", attempts: [
      { n: 1, state: "passed", startedAt: "2026-08-28T11:00:00.000Z", completedAt: "2026-08-28T11:10:00.000Z" },
      { n: 2, state: "running", startedAt: "2026-08-28T11:20:00.000Z" },
    ] }],
  });
  expect((await gather({ pipelines: [second] })).ownLanes).toEqual([]);

  /* A lane still provisioning has not been provisioned. */
  const waiting = lane({ srcConversationId: CONVERSATION, state: "provisioning", runs: [{ stageId: "build", attempts: [] }] });
  expect((await gather({ pipelines: [waiting] })).ownLanes).toEqual([]);
});

test("own settled lanes select the newest twenty before projecting review details", async () => {
  let reviewReads = 0;
  const rows = Array.from({ length: 804 }, (_, index) => {
    const pipeline = lane({
      id: `own-settled-${String(index).padStart(4, "0")}`,
      srcConversationId: CONVERSATION,
      state: "needs_review",
      pausedState: "needs_review",
      cursor: null,
      runs: [{ stageId: "build", attempts: [] }],
      createdAt: new Date(NOW - index * 1_000).toISOString(),
    });
    Object.defineProperty(pipeline, "reviewPending", { get: () => { reviewReads++; return NEEDS_REVIEW; } });
    return pipeline;
  });
  const input = await gather({ pipelines: rows });
  expect(input.ownLanes).toHaveLength(20);
  expect(input.ownLanes.map(item => item.id)).toEqual(Array.from({ length: 20 }, (_, index) =>
    `own-settled-${String(index).padStart(4, "0")}`));
  expect(reviewReads).toBe(40);
});

test("an announced lane is not offered as provisioned a second time (#1799)", async () => {
  const provisioned = lane({ srcConversationId: CONVERSATION, state: "running" });
  /* The same lane, against a row that has announced nothing, is offered. */
  expect((await gather({ pipelines: [provisioned] })).ownLanes).toMatchObject([{ settled: "provisioned" }]);
  const announced = { ...emptySeatTickState(), announcedLanes: ["pipeline_a1"] };
  expect((await gather({ pipelines: [provisioned] }, announced)).ownLanes).toEqual([]);

  /* The lane itself is not silenced — only that one settlement is. */
  const completed = lane({ srcConversationId: CONVERSATION, state: "completed" });
  expect((await gather({ pipelines: [completed] }, announced)).ownLanes).toMatchObject([{ settled: "completed" }]);
});

test("a lane that parked before it ran a stage carries why it never started (#1799)", async () => {
  const parked = lane({
    srcConversationId: CONVERSATION,
    state: "needs_decision",
    stateDetail: "fetching origin/main: git fetch timed out after 60s",
    runs: [{ stageId: "build", attempts: [] }],
    cursor: { stageId: "build", state: "pending", input: null, activatedBy: null },
  });
  expect((await gather({ pipelines: [parked] })).ownLanes).toEqual([{
    id: "pipeline_a1",
    title: "ship the exporter",
    settled: "provisioning-failed",
    updatedAt: expect.any(String),
    detail: "fetching origin/main: git fetch timed out after 60s",
  }]);

  /* A lane that parked with a stage behind it parked on a decision, which is
     the settlement it always had. */
  const afterAStage = lane({ srcConversationId: CONVERSATION, state: "needs_decision", stateDetail: "the reviewer asked" });
  expect((await gather({ pipelines: [afterAStage] })).ownLanes).toMatchObject([{ settled: "needs_decision" }]);
});

/* #1938: a spent review budget whose last fix wrote a new head is its own
   settlement, carrying both heads and the verdict, and its pull request is
   never one "left open by a lane that finished". */
const NEEDS_REVIEW = {
  stageId: "review", attempt: 2, fixStageId: "build", fixAttempt: 3,
  reviewedHead: "1".repeat(40), currentHead: "2".repeat(40), verdict: "fail", findings: 2, at: "2026-08-28T11:30:00.000Z",
};

test("a lane parked in needs_review settles as needs_review with the reviewed head, the current head and the last verdict (#1938)", async () => {
  const parked = lane({ srcConversationId: CONVERSATION, state: "needs_review", cursor: null, reviewPending: NEEDS_REVIEW });
  expect((await gather({ pipelines: [parked] })).ownLanes).toMatchObject([{
    id: "pipeline_a1",
    settled: "needs_review",
    review: { stageId: "review", reviewedHead: "1".repeat(40), currentHead: "2".repeat(40), lastVerdict: "fail", findings: 2 },
  }]);
});

test("a needs_review lane's pull request is not one a finished lane left open (#1938)", async () => {
  const parked = finishedLane({ state: "needs_review", closedAt: null, reviewPending: NEEDS_REVIEW });
  const input = await gather({ pipelines: [parked], openPullRequests: [openPullRequest()] }, withCursor(0, OVERDUE));
  expect(input.pullRequests).toEqual([]);
});

/* ---------------------------------------------------------------------------
 * A seat is woken when an agent it spawned finishes (#1881)
 *
 * Fresh state, a designated seat, one child spawned outside any pipeline with
 * the seat as its lineage source, and the child ending its turn — read by the
 * production gather and decided by the production pre-check.
 * ------------------------------------------------------------------------- */

/** The check the controller runs: gather, decide, and land the wake if one is
    raised, so the next check sees the state a delivered wake leaves. */
async function childCheck(fixture: ChildRegistry, now: number, state: SeatTickProjectState) {
  const input = await childGather(fixture, { now }, state);
  const decision = seatTickDecision(input);
  const plan = seatTickWakeCommitPlan(decision.verdict, {
    fingerprint: input.changeFingerprint,
    eventsThrough: decision.state.eventsThrough ?? 0,
    terminalChildren: input.children.filter((child) => child.status === "terminal").flatMap((child) => [child.outcomeId ?? child.conversationId]),
  });
  const landed = plan ? seatTickWakeCommit(decision.state, plan, now) : decision.state;
  return { input, decision, state: landed };
}

function settleChild(fixture: ChildRegistry, child: { id: string; path: string }, title: string, at: number): void {
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: new Date(at).toISOString(),
  }]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  ledger.append(generation, { kind: "turn-started", turnId: "turn-one", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
}

test("a child settling its turn wakes the seat at the next check, not an hour after the last wake (#1881)", async () => {
  const fixture = childRegistry("settles-1881");
  /* The structured host stays up after the turn ends, as it does in
     production: the registry's turn state is what says the child finished. */
  const child = fixture.spawn({ title: "reviewer one", turn: "busy", host: "idle" });
  const first = await childCheck(fixture, fixture.now, emptySeatTickState());
  expect(first.input.children).toMatchObject([{ conversationId: child.id, status: "running" }]);
  /* Whatever the first check did, the next one comes one check interval later
     and the child has ended its turn in between. */
  const later = fixture.now + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs;
  settleChild(fixture, child, "reviewer one", later - MINUTE_MS);
  const second = await childCheck(fixture, later, first.state);
  expect(second.input.children).toMatchObject([{ conversationId: child.id, status: "terminal", outcome: "finished", transcript: "readable" }]);
  expect(second.decision.verdict.kind).toBe("wake");
  if (second.decision.verdict.kind !== "wake") return;
  expect(second.decision.verdict.reasons.map((reason) => reason.kind)).toContain("child-terminal");
  expect(second.decision.verdict.items).toContainEqual(expect.objectContaining({ kind: "child", id: child.id }));
});

test("a child recorded through a symlink into a scanner root is readable (#1881)", async () => {
  const fixture = childRegistry("symlinked-1881");
  const alias = path.join(SANDBOX, `sessions-alias-${crypto.randomUUID()}`);
  fs.symlinkSync(SESSIONS, alias);
  const child = fixture.spawn({ title: "linked worker", turn: "idle", host: "dead", transcriptPath: path.join(alias, `${crypto.randomUUID()}.jsonl`) });
  const input = await childGather(fixture);
  expect(input.children).toMatchObject([{ conversationId: child.id, status: "terminal", transcript: "readable" }]);
});

test("a finished child whose transcript is gone still wakes the seat, with the reason named once (#1881)", async () => {
  const fixture = childRegistry("unreadable-1881");
  const child = fixture.spawn({ title: "reviewer two", turn: "idle", host: "dead" });
  fs.rmSync(child.path);
  const check = await childCheck(fixture, fixture.now, emptySeatTickState());
  expect(check.input.children).toMatchObject([{ conversationId: child.id, status: "terminal", transcript: "unresolvable", transcriptReason: "missing" }]);
  expect(check.decision.verdict.kind).toBe("wake");
  if (check.decision.verdict.kind !== "wake") return;
  expect(check.decision.verdict.reasons.map((reason) => reason.kind)).toContain("child-terminal");
  const line = check.decision.verdict.items.find((item) => item.id === child.id);
  expect(line?.label).toContain("reviewer two — spawned child finished, transcript not readable: the transcript file is no longer on disk");
  expect(check.decision.verdict.skippedChildren.unreadable).toBe(0);
});

test("a seat's settled deploy is gathered, and one requested past the backlog bound is never read off the ledger (#2063)", async () => {
  const ledgerReads: string[] = [];
  const record = (deploymentId: string, minutesAgo: number, conversationId = CONVERSATION) => ({
    deploymentId, conversationId, project: PROJECT, revision: "c".repeat(40),
    requestedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  });
  const records = [
    record("deploy-stale", 4 * 24 * 60),
    record("deploy-fresh", 10),
    record("deploy-announced", 30),
    record("deploy-other-seat", 10, "conversation_other_seat"),
  ];
  const base = sources({});
  const input = await gatherSeatTickInput(PROJECT, { ...emptySeatTickState(), announcedDeploys: ["deploy-announced"] }, DEFAULT_SEAT_TICK_POLICY, {
    ...base,
    seatDeployments: (conversationId) => records.filter((row) => row.conversationId === conversationId),
    deployment: (deploymentId) => {
      ledgerReads.push(deploymentId);
      return { state: "ok", value: { deploymentId, phase: "succeeded", terminal: true, revision: "c".repeat(40), error: null, updatedAt: new Date(NOW - 60_000).toISOString() } } as never;
    },
  });
  expect(input.settledDeploys).toEqual([{
    deploymentId: "deploy-fresh", phase: "succeeded", sha: "c".repeat(40), error: null, settledAt: new Date(NOW - 60_000).toISOString(),
  }]);
  expect(ledgerReads).toEqual(["deploy-fresh"]);
});

test("a child this seat launched with notices on is marked, one launched by someone else or opted out is not (spawn-completion-notice §6)", async () => {
  const fixture = childRegistry("launcher-notice");
  const launch = (title: string, launcher: { conversationId: string; notify: boolean } | null, transport: "structured" | "tmux" = "structured") => {
    const childPath = path.join(SESSIONS, `${crypto.randomUUID()}.jsonl`);
    fs.writeFileSync(childPath, "");
    const begun = fixture.registry.beginSpawnRequest({
      engine: "claude", cwd: fixture.cwd, transport,
      parentConversationId: fixture.seatId as never, parentSource: "explicit",
      launchProfile: { title }, launcher: launcher as never,
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const settled = fixture.registry.settleSpawn(begun.receipt.launchId, {
      key: sessionKeyFromTranscript("claude", childPath)!, artifactPath: childPath, cwd: fixture.cwd, accountId: null,
      status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("expected settle");
    fixture.registry.reconcileConversations([{
      engine: "claude", path: childPath, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title }),
      turn: { state: "terminal", source: "assistant", terminalAt: new Date(fixture.now - 20 * MINUTE_MS).toISOString() },
      observedAt: new Date(fixture.now - 5 * MINUTE_MS).toISOString(),
    }]);
    const generation = fixture.registry.conversation(settled.conversation.id)!.generations[0]!;
    const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
    ledger.append(generation.id, { kind: "turn-started", turnId: "turn-one", seq: 1 });
    ledger.append(generation.id, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
    return settled.conversation.id;
  };
  const notified = launch("notified reviewer", { conversationId: fixture.seatId, notify: true });
  const quiet = launch("opted-out reviewer", { conversationId: fixture.seatId, notify: false });
  const elsewhere = launch("reviewer another agent launched", { conversationId: "conversation_other_launcher", notify: true });
  /* A tmux child never ends a turn in the runtime journal, so no notice
     covers it and the harvest keeps reporting it. */
  const tmux = launch("reviewer on tmux", { conversationId: fixture.seatId, notify: true }, "tmux");
  const input = await childGather(fixture);
  const byId = new Map(input.children.map((child) => [child.conversationId, child]));
  expect(byId.get(notified)).toMatchObject({ status: "terminal", launcherNotice: true });
  expect(byId.get(quiet)?.launcherNotice).toBeUndefined();
  expect(byId.get(elsewhere)?.launcherNotice).toBeUndefined();
  expect(fixture.registry.conversation(tmux as never)?.launcher).toBeNull();
  expect(byId.get(tmux)).toMatchObject({ status: "terminal", outcome: "finished" });
  expect(byId.get(tmux)?.launcherNotice).toBeUndefined();
  const harvested = seatTickDecision({ ...input, children: [byId.get(tmux)!, byId.get(notified)!] });
  expect(JSON.stringify(harvested.verdict)).toContain(tmux);
  expect(JSON.stringify(harvested.verdict)).not.toContain(notified);
});


test("maintenance gather offers only unannounced ended project runs and moves the fingerprint", async () => {
  const { claimMaintenanceRun, patchMaintenanceRun, maintenanceRuns } = await import("@/lib/boardMaintenance/store");
  const result = claimMaintenanceRun({ project: PROJECT, now: NOW, intervalHours: 3, seat: { seatEpoch: 7, conversationId: CONVERSATION }, repoDir: "/fixtures/repository" });
  if (!result.claimed) throw new Error(result.reason);
  patchMaintenanceRun(result.run.runId, { state: "succeeded", endedAt: new Date(NOW).toISOString() });
  const feed = { ...sources({ pipelines: [] }), maintenanceRuns };
  const state = emptySeatTickState();
  const gathered = await gatherProduction(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, feed);
  expect(gathered.settledMaintenance?.map(r => r.runId)).toEqual([result.run.runId]);
  const acknowledged = await gatherProduction(PROJECT, { ...state, announcedMaintenance: [result.run.runId] }, DEFAULT_SEAT_TICK_POLICY, feed);
  expect(acknowledged.settledMaintenance).toEqual([]); expect(acknowledged.changeFingerprint).not.toBe(gathered.changeFingerprint);
});

/* docs/design/delivery-progress-and-drain.md, P23 (C2): a withdrawal decides
   inside the write it waited for. Another process holds the SQLite writer;
   once it lets go, the switch is cancelled and an attempt claims the row in
   the same tick, before the withdrawal's next probe. */
async function withdrawalRace(name: string, withdraw: (registry: InstanceType<typeof AgentRegistry>, held: { id: string; operationId: string; key: string }) => Promise<string>) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, `${name}-`));
  const sqlitePath = path.join(dir, "agent-registry.sqlite");
  const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite", sqliteFilename: sqlitePath });
  const conversation = registry.ensureConversation("codex", path.join(dir, `${crypto.randomUUID()}.jsonl`), null);
  registry.setConversationMigration(conversation.id, {
    intentId: `${name}-intent`, phase: "requested", targetId: "default", revision: 1, error: null, updatedAt: new Date().toISOString(),
  });
  const key = `${name}-key`;
  const held = registry.holdDelivery(conversation.id, "wake the seat", key);
  expect(held.state).toBe("held");
  setAgentRegistryForTests(registry);
  const { Database } = await import("bun:sqlite");
  const holder = new Database(sqlitePath);
  holder.exec("PRAGMA busy_timeout = 5000");
  holder.exec("BEGIN IMMEDIATE");
  try {
    const withdrawing = withdraw(registry, { id: held.id, operationId: held.command.operationId, key });
    await new Promise((resolve) => setTimeout(resolve, 60));
    holder.exec("ROLLBACK");
    registry.setConversationMigration(conversation.id, null);
    const assigned = registry.requeueHeldDelivery(held.id);
    expect(assigned.state).toBe("assigned");
    expect(registry.beginDeliveryAttempt(held.id, assigned.generationId!)?.state).toBe("delivery-uncertain");
    const answer = await withdrawing;
    return { answer, row: registry.readOnlySnapshot().heldDeliveries[held.id] };
  } finally {
    holder.close();
    setAgentRegistryForTests(null);
    registry.close();
  }
}

test("a held-wake withdrawal that waited for the writer leaves a row an attempt claimed meanwhile, and answers unknown (P23)", async () => {
  const { defaultSeatTickSources } = await import("./seatTickSources");
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = "";
  try {
    const { answer, row } = await withdrawalRace("seat-withdraw-race", (_registry, held) =>
      defaultSeatTickSources().withdrawWake({ ...WAKE, clientMessageId: held.key, operationId: null }, "the seat rotated"));
    expect(answer).toBe("unknown");
    expect(row).toMatchObject({ state: "delivery-uncertain", text: "wake the seat" });
  } finally {
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  }
});

test("a held-wake withdrawal that finds its row still held after the wait ends it", async () => {
  const { defaultSeatTickSources } = await import("./seatTickSources");
  const dir = fs.mkdtempSync(path.join(SANDBOX, "seat-withdraw-held-"));
  const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(dir, "agent-registry.sqlite") });
  const conversation = registry.ensureConversation("codex", path.join(dir, `${crypto.randomUUID()}.jsonl`), null);
  registry.setConversationMigration(conversation.id, {
    intentId: "held-intent", phase: "requested", targetId: "default", revision: 1, error: null, updatedAt: new Date().toISOString(),
  });
  const held = registry.holdDelivery(conversation.id, "wake the seat", "seat-withdraw-held-key");
  setAgentRegistryForTests(registry);
  try {
    expect(await defaultSeatTickSources().withdrawWake({ ...WAKE, clientMessageId: "seat-withdraw-held-key", operationId: null }, "the seat rotated")).toBe("withdrawn");
    expect(registry.readOnlySnapshot().heldDeliveries[held.id]).toMatchObject({ state: "failed", text: "" });
  } finally {
    setAgentRegistryForTests(null);
    registry.close();
  }
});


test("automatic refresh belongs to its seat: parent PR is held and a semantic park wakes its creator", async () => {
  const parent = finishedLane({ merge: { state: "refreshing", refresh: { pipelineId: "refresh-one" } } } as never);
  const refresh = lane({ id: "refresh-one", srcConversationId: CONVERSATION, state: "needs_decision",
    stateDetail: "src/example.ts:12 @@ -9,6 +9,7 @@ either resolution changes behaviour",
    refreshOf: { pipelineId: "pipeline_z9", base: "a".repeat(40) } });
  const input = await gather({ pipelines: [parent, refresh], openPullRequests: [openPullRequest()] }, withCursor(0, OVERDUE));
  expect(input.pullRequests).toEqual([]);
  expect(input.ownLanes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "refresh-one", settled: "needs_decision" })]));
});


test("foreign flipping retirement reports never wake an idle project or make its digest due", async () => {
  const ports = sources({ pipelines: [], tasks: [boardCard({ status: "inbox" })] });
  const foreign = { id: "fixtureForeign", projectOwnership: { project: "elsewhere" }, generations: [{ launchProfile: { title: "Other agent" } }] };
  const registry = ports.registry();
  ports.registry = () => ({ ...registry,
    conversation: () => foreign,
    readOnlySnapshot: () => ({ ...registry.readOnlySnapshot(), conversations: { fixtureForeign: foreign } }),
  }) as never;
  ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
  let state: SeatTickProjectState = { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 61 * 60_000).toISOString() };
  const baseline = await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports);
  state = { ...state, reportFingerprint: baseline.digestFingerprint!, checkFingerprint: baseline.digestFingerprint! };
  for (let check = 0; check < 24; check++) {
    ports.now = () => NOW + check * 15 * 60_000;
    ports.retirementReport = () => ({ failed: [], refused: Array.from({ length: 4 + check % 2 }, () => ({
      key: "codex:foreign", conversationId: "fixtureForeign", clause: "events-flushed", reason: `unreadable at check ${check}`, undetermined: true,
    })) }) as never;
    const input = refreshSeatTickInput(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports), ports);
    const decision = seatTickDecision(input);
    expect(decision.verdict.kind).not.toBe("wake");
    expect(input.signals.some(signal => signal.id === "host-retirement")).toBe(false);
    expect(seatTickBoardMoved(baseline.changeFingerprint, input.changeFingerprint)).toBe(false);
    state = decision.state;
  }
});

test("non-actionable signal churn and machine-wide retirement stalls leave idle checks quiet", async () => {
  for (const status of [null, "inbox", "blocked"]) {
    const ports = sources({ pipelines: [], tasks: status ? [boardCard({ status })] : [] });
    ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
    let state: SeatTickProjectState = { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 61 * 60_000).toISOString(), lastProposalAt: new Date(NOW).toISOString() };
    const baseline = await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports);
    state = { ...state, reportFingerprint: baseline.digestFingerprint!, checkFingerprint: baseline.digestFingerprint! };
    for (let check = 0; check < 24; check++) {
      ports.now = () => NOW + check * 15 * 60_000;
      ports.memoryProblems = () => [{ id: "memory-problem:informational", actionable: false, label: `host retirement: ${4 + check % 2} undetermined at check ${check}` }];
      ports.retirementJournal = () => ({ covered: true, sweeps: retirementSweeps(288, { "events-flushed": 4 + check % 2 }) });
      const input = refreshSeatTickInput(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports), ports);
      const decision = seatTickDecision(input);
      expect(decision.verdict.kind).toBe("quiet");
      expect(seatTickBoardMoved(baseline.changeFingerprint, input.changeFingerprint)).toBe(false);
      expect(seatTickReportLines(input, decision.state, input.signals.map(signal => ({ kind: "signal", ...signal })), [{ kind: "interval", detail: "interval elapsed" }])).toEqual([]);
      state = decision.state;
    }
  }
});

test("an own-project lane change wakes and makes a digest due while signal churn alone does neither", async () => {
  let pipelines: Record<string, unknown>[] = [];
  const ports = sources({ pipelines: [], tasks: [boardCard({ status: "inbox" })] });
  ports.pipelines = () => pipelines as never;
  ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
  const initial = { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 61 * 60_000).toISOString() };
  const baseline = await gatherSeatTickInput(PROJECT, initial, DEFAULT_SEAT_TICK_POLICY, ports);
  let state: SeatTickProjectState = { ...initial, reportFingerprint: baseline.digestFingerprint!, checkFingerprint: baseline.digestFingerprint! };
  ports.memoryProblems = () => [{ id: "memory-problem:informational", actionable: false, label: "host retirement: 4 undetermined" }];
  pipelines = [lane({ project: "elsewhere", resumedAt: new Date(NOW).toISOString() })];
  const foreign = await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports);
  expect(seatTickBoardMoved(baseline.changeFingerprint, foreign.changeFingerprint)).toBe(false);
  expect(seatTickDecision(foreign).verdict.kind).toBe("quiet");
  pipelines = [lane()];
  const moved = await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports);
  const decision = seatTickDecision(moved);
  expect(seatTickBoardMoved(baseline.changeFingerprint, moved.changeFingerprint)).toBe(true);
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("lane movement must wake");
  expect(decision.verdict.items.some(item => item.kind === "pipeline")).toBe(true);
  expect(decision.verdict.reportLines?.some(line => line.startsWith("Digest due"))).toBe(true);
  // A report covering this board followed by informational churn owes no digest,
  // including during the live lane's normal periodic interval wake.
  state = { ...decision.state, reportFingerprint: moved.digestFingerprint! };
  ports.memoryProblems = () => [{ id: "memory-problem:informational", actionable: false, label: "host retirement: 5 undetermined" }];
  ports.now = () => NOW + 2 * 60 * 60_000;
  const unchanged = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(unchanged.verdict.kind).toBe("wake");
  if (unchanged.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
  expect(unchanged.verdict.reportLines ?? []).toEqual([]);
  expect(unchanged.verdict.items.some(item => item.id === "memory-problem:informational")).toBe(false);
});

test.each(["task note edits", "maintenance timestamps", "details appends", "report writes"])("repeated %s owe no digest", async (write) => {
  let task = boardCard({ status: "inbox" });
  const ports = sources({ laneRows: [livenessRow({ lifecycle: "running" })] });
  ports.tasks = () => [task] as never;
  let reports: { id: string; project: string; at: string; origin: { kind: "manager" } }[] = [];
  ports.reports = { log: () => reports as never, enabled: () => true, operatorLocale: () => "en" };
  const baseline = seatTickDecision(await gatherSeatTickInput(PROJECT,
    { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, DEFAULT_SEAT_TICK_POLICY, ports));
  let state = baseline.state;
  for (let check = 1; check <= 4; check++) {
    const now = NOW + check * 2 * 60 * 60_000;
    ports.now = () => now;
    task = { ...task, updatedAt: new Date(now).toISOString(),
      ...(write === "task note edits" ? { text: `wire the chip\nProgress note ${check}` } : {}),
      ...(write === "details appends" ? { details: `${task.details ?? "Investigation notes"}\nCheck ${check}` } : {}) };
    if (write === "report writes") reports = [...reports,
      { id: `fixture-report-${check}`, project: PROJECT, at: new Date(now - 60 * 60_000).toISOString(), origin: { kind: "manager" } }];
    const gathered = await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports);
    for (const input of [gathered, refreshSeatTickInput(gathered, ports)]) {
      const decision = seatTickDecision(input);
      expect(decision.verdict.kind).toBe("wake");
      if (decision.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
      expect(decision.verdict.reasons.some(reason => reason.kind === "interval")).toBe(true);
      expect(decision.verdict.reportLines ?? []).toEqual([]);
      state = decision.state;
    }
  }
});

test.each(["task status", "stage transition", "stage state", "attempt state", "merge", "deployment"])("a real %s change still owes a report", async (change) => {
  let task = boardCard({ status: "inbox" });
  let activeLane = lane();
  let pullRequests = change === "merge" ? [openPullRequest()] : [];
  let deployed = false;
  const ports = sources({ laneRows: [livenessRow({ lifecycle: "running" })] });
  ports.tasks = () => [task] as never;
  ports.pipelines = () => [activeLane, finishedLane()] as never;
  ports.openPullRequests = async () => ({ ok: true, pullRequests });
  ports.seatDeployments = () => deployed ? [{ deploymentId: "deploy-material", conversationId: CONVERSATION, project: PROJECT,
    revision: "c".repeat(40), requestedAt: new Date(NOW).toISOString() }] : [];
  ports.deployment = () => ({ state: "ok", value: { deploymentId: "deploy-material", phase: "succeeded", terminal: true,
    revision: "c".repeat(40), error: null, updatedAt: new Date(NOW).toISOString() } }) as never;
  ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
  const baseline = seatTickDecision(await gatherSeatTickInput(PROJECT,
    { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, DEFAULT_SEAT_TICK_POLICY, ports));
  ports.now = () => NOW + 2 * 60 * 60_000;
  if (change === "task status") task = { ...task, status: "blocked" };
  if (change === "stage transition") activeLane = lane({ cursor: { stageId: "review", state: "running" } });
  if (change === "stage state") activeLane = lane({ cursor: { stageId: "build", state: "committing" } });
  if (change === "attempt state") activeLane = lane({ runs: [{ stageId: "build", attempts: [{ n: 1, state: "passed",
    conversationId: STAGE_CONVERSATION, agentPath: TRANSCRIPT, startedAt: "2026-08-28T11:00:00.000Z" }] }] });
  if (change === "merge") pullRequests = [];
  if (change === "deployment") deployed = true;
  const gathered = await gatherSeatTickInput(PROJECT, baseline.state, DEFAULT_SEAT_TICK_POLICY, ports);
  for (const input of [gathered, refreshSeatTickInput(gathered, ports)]) {
    const decision = seatTickDecision(input);
    expect(decision.verdict.kind).toBe("wake");
    if (decision.verdict.kind !== "wake") throw new Error("material change must wake");
    expect(decision.verdict.reportLines?.some(line => line.startsWith(change === "deployment" ? "Report owed" : "Digest due"))).toBe(true);
  }
});

test("a legacy digest baseline upgrades without owing a digest for task timestamps", async () => {
  const ports = sources({ tasks: [boardCard({ status: "inbox", updatedAt: new Date(NOW).toISOString() })] });
  ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
  const state = { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE,
    reportFingerprint: "legacy-board", checkFingerprint: "legacy-board" };
  const decision = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
  expect(decision.verdict.reportLines ?? []).toEqual([]);
  expect(decision.state.checkFingerprint).toStartWith("digest-v1:");
  ports.tasks = () => [boardCard({ status: "blocked" })] as never;
  const changed = seatTickDecision(await gatherSeatTickInput(PROJECT, decision.state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(changed.verdict.kind).toBe("wake");
  if (changed.verdict.kind !== "wake") throw new Error("material change must wake after upgrade");
  expect(changed.verdict.reportLines?.some(line => line.startsWith("Digest due"))).toBe(true);
});

test("a flapping pull-request source owes no digest, but a verified merge does", async () => {
  const ports = sources({ pipelines: [lane(), finishedLane()], openPullRequests: [openPullRequest()],
    laneRows: [livenessRow({ lifecycle: "running" })] });
  ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
  let state = seatTickDecision(await gatherSeatTickInput(PROJECT,
    { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, DEFAULT_SEAT_TICK_POLICY, ports)).state;
  for (let check = 1; check <= 4; check++) {
    ports.now = () => NOW + check * 2 * 60 * 60_000;
    ports.openPullRequests = async () => check % 2
      ? { ok: false, unavailable: "command-failed" }
      : { ok: true, pullRequests: [openPullRequest()] };
    const decision = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
    expect(decision.verdict.kind).toBe("wake");
    if (decision.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
    expect(decision.verdict.reportLines ?? []).toEqual([]);
    state = decision.state;
  }
  ports.openPullRequests = async () => ({ ok: true, pullRequests: [] });
  const merged = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(merged.verdict.kind).toBe("wake");
  if (merged.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
  expect(merged.verdict.reportLines?.some(line => line.startsWith("Digest due"))).toBe(true);
});

test("gated PR reads and report writes cannot invent digest movement", async () => {
  const pullRequestCalls: { cwd: string; limit: number }[] = [];
  const ports = sources({ pipelines: [lane(), finishedLane()], openPullRequests: [openPullRequest()], pullRequestCalls,
    laneRows: [livenessRow({ lifecycle: "running" })] });
  let reports: { id: string; project: string; at: string; origin: { kind: "manager" } }[] = [];
  ports.reports = { log: () => reports as never, enabled: () => true, operatorLocale: () => "en" };
  let state = seatTickDecision(await gatherSeatTickInput(PROJECT,
    { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, DEFAULT_SEAT_TICK_POLICY, ports)).state;
  state = { ...state, lastWakeAt: new Date(NOW).toISOString() };
  const readsAfterBaseline = pullRequestCalls.length;

  for (const minute of [5, 10]) {
    ports.now = () => NOW + minute * 60_000;
    if (minute === 10) reports = [{ id: "fixture-report", project: PROJECT,
      at: new Date(NOW + 6 * 60_000).toISOString(), origin: { kind: "manager" } }];
    const decision = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
    const lines = decision.verdict.kind === "wake" ? decision.verdict.reportLines ?? [] : [];
    expect(lines.some(line => line.startsWith("Digest due"))).toBe(false);
    expect(pullRequestCalls).toHaveLength(readsAfterBaseline);
    state = decision.state;
  }

  ports.now = () => NOW + 2 * 60 * 60_000;
  const due = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
  const lines = due.verdict.kind === "wake" ? due.verdict.reportLines ?? [] : [];
  expect(lines.some(line => line.startsWith("Digest due"))).toBe(false);
  expect(pullRequestCalls).toHaveLength(readsAfterBaseline + 1);
});

test("recovered PR evidence establishes a baseline before a later verified merge", async () => {
  const ports = sources({ pipelines: [lane(), finishedLane()], laneRows: [livenessRow({ lifecycle: "running" })] });
  ports.openPullRequests = async () => ({ ok: false, unavailable: "command-failed" });
  ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
  let state = seatTickDecision(await gatherSeatTickInput(PROJECT,
    { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, DEFAULT_SEAT_TICK_POLICY, ports)).state;
  state = { ...state, lastWakeAt: new Date(NOW).toISOString() };

  ports.now = () => NOW + 2 * 60 * 60_000;
  ports.openPullRequests = async () => ({ ok: true, pullRequests: [openPullRequest()] });
  const recovered = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(recovered.verdict.kind).toBe("wake");
  if (recovered.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
  expect(recovered.verdict.reportLines ?? []).toEqual([]);
  state = { ...recovered.state, lastWakeAt: new Date(NOW + 2 * 60 * 60_000).toISOString() };

  ports.now = () => NOW + 4 * 60 * 60_000;
  ports.openPullRequests = async () => ({ ok: true, pullRequests: [] });
  const merged = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(merged.verdict.kind).toBe("wake");
  if (merged.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
  expect(merged.verdict.reportLines?.some(line => line.startsWith("Digest due"))).toBe(true);
});

test("first recovered PR evidence preserves unreported board movement", async () => {
  let task = boardCard({ status: "inbox" });
  const ports = sources({ pipelines: [lane(), finishedLane()], tasks: [task], laneRows: [livenessRow({ lifecycle: "running" })] });
  ports.openPullRequests = async () => ({ ok: false, unavailable: "command-failed" });
  ports.reports = { log: () => [], enabled: () => true, operatorLocale: () => "en" };
  let state = seatTickDecision(await gatherSeatTickInput(PROJECT,
    { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, DEFAULT_SEAT_TICK_POLICY, ports)).state;
  state = { ...state, lastWakeAt: new Date(NOW).toISOString() };

  task = { ...task, status: "blocked" };
  ports.tasks = () => [task] as never;
  ports.now = () => NOW + 2 * 60 * 60_000;
  ports.openPullRequests = async () => ({ ok: true, pullRequests: [openPullRequest()] });
  const recovered = seatTickDecision(await gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(recovered.verdict.kind).toBe("wake");
  if (recovered.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
  expect(seatTickBoardMoved(recovered.state.reportFingerprint ?? null, recovered.state.checkFingerprint ?? "")).toBe(true);
});

test("observing an old report without a board baseline cannot invent digest movement", async () => {
  const ports = sources({});
  const reportedAt = new Date(NOW - 2 * 60 * 60_000).toISOString();
  ports.reports = { log: () => [{ id: "fixture-report", project: PROJECT, at: reportedAt, origin: { kind: "manager" } }] as never, enabled: () => true, operatorLocale: () => "en" };
  const first = seatTickDecision(await gatherSeatTickInput(PROJECT, { ...emptySeatTickState(), seatEpoch: 7 }, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(first.verdict.kind).toBe("wake");
  if (first.verdict.kind !== "wake") throw new Error("live lane keeps its cadence");
  expect(first.verdict.reportLines ?? []).toEqual([]);
  ports.pipelines = () => [lane({ resumedAt: new Date(NOW).toISOString() })] as never;
  const moved = seatTickDecision(await gatherSeatTickInput(PROJECT, first.state, DEFAULT_SEAT_TICK_POLICY, ports));
  expect(moved.verdict.kind).toBe("wake");
  if (moved.verdict.kind !== "wake") throw new Error("own lane movement must wake");
  expect(moved.verdict.reportLines?.some(line => line.startsWith("Digest due"))).toBe(true);
});

test("retirement refusals and failures disclose only verified project subjects and stay actionable", async () => {
  const ports = sources({ pipelines: [] });
  const conversations = {
    fixtureForeign: { id: "fixtureForeign", projectOwnership: { project: "elsewhere" }, launcher: { conversationId: CONVERSATION }, generations: [{ launchProfile: { title: "Other agent" } }] },
    fixtureUnknown: { id: "fixtureUnknown", launcher: { conversationId: CONVERSATION }, generations: [{ launchProfile: { title: "Unknown project" } }] },
    fixtureOwn: { id: "fixtureOwn", projectOwnership: { project: PROJECT }, launcher: { conversationId: CONVERSATION, notify: true }, generations: [{ launchProfile: { title: "Lost builder" } }] },
    fixtureLane: { id: "fixtureLane", projectOwnership: { project: PROJECT }, generations: [{ launchProfile: { title: "Lane worker" } }] },
  };
  const baseRegistry = ports.registry();
  ports.registry = () => ({ ...baseRegistry,
    conversation: (id: string) => conversations[id as keyof typeof conversations] ?? null,
    readOnlySnapshot: () => { throw new Error("retirement must use keyed subjects"); },
  }) as never;
  const initial = { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 61 * 60_000).toISOString() };
  for (const own of ["refused", "failed", "both"] as const) {
    ports.retirementReport = () => ({ failed: [
      { key: "codex:foreign", conversationId: "fixtureForeign", error: "foreign failure", remaining: [] },
      { key: "codex:unknown", conversationId: "fixtureUnknown", error: "unscoped failure", remaining: [] },
      ...(own !== "refused" ? [{ key: "codex:lane", conversationId: "fixtureLane", error: "termination failed", remaining: [] }] : []),
    ], refused: [
      ...["fixtureForeign", "fixtureUnknown", "fixtureMissing", null].map(conversationId => ({ key: "codex:unscoped", conversationId, clause: "events-flushed", reason: "unscoped refusal", undetermined: true })),
      ...(own !== "failed" ? [{ key: "codex:own", conversationId: "fixtureOwn", clause: "turn-settled", reason: "turn unknown", undetermined: true }] : []),
    ] }) as never;
    const gathered = await gatherSeatTickInput(PROJECT, initial, DEFAULT_SEAT_TICK_POLICY, ports);
    const signal = gathered.signals.find(s => s.id === "host-retirement")!;
    expect(signal.actionable).toBe(true);
    expect(signal.label).toContain(`${own === "refused" ? 0 : 1} failed, ${own === "failed" ? 0 : 1} undetermined`);
    if (own !== "failed") expect(signal.label).toContain("Lost builder (fixtureOwn) turn-settled: turn unknown (launched by you)");
    if (own !== "refused") expect(signal.label).toContain("Lane worker (fixtureLane) failed: termination failed");
    for (const excluded of ["Other agent", "fixtureForeign", "fixtureUnknown", "fixtureMissing", "unscoped", "foreign failure"]) expect(signal.label).not.toContain(excluded);
    const wake = seatTickDecision(gathered).verdict;
    expect(wake.kind).toBe("wake");
    expect(wake.kind === "wake" && wake.items.some(item => item.kind === "signal" && item.id === "host-retirement")).toBe(true);
  }
});


test("seat check keeps wake ordering and zero decoded or copied rows with tenfold warm history", async () => {
  const { defaultSeatTickSources } = await import("./seatTickSources");
  const { saveTasks, loadTasksForList } = await import("@/lib/tasks/store");
  const { savePipelines, loadPipelinesForList } = await import("@/lib/pipelines/store");
  const { spyOn } = await import("bun:test");
  const { buildPipeline } = await import("@/lib/pipelines/store");
  const persistedLane = (id: string, project: string) => buildPipeline({ id, task: "Check work", project, repoDir: "/srv/repo", stages: [], srcPath: null, srcConversationId: null, now: new Date(NOW).toISOString(), state: "draft" });
  const production = defaultSeatTickSources();
  const results = [];
  const counts = [];
  for (const size of [10, 100]) {
    saveTasks([boardCard({ id: "task-flat-own", status: "inbox" }), ...Array.from({ length: size }, (_, i) => boardCard({ id: `task-flat-${i}`, project: "elsewhere" }))] as never);
    savePipelines([persistedLane("lane-flat-own", PROJECT), ...Array.from({ length: size }, (_, i) => persistedLane(`lane-flat-${i}`, "elsewhere"))]);
    const expectedPorts = sources({ tasks: [...loadTasksForList()] as never, pipelines: [...loadPipelinesForList()] as never });
    const expected = seatTickDecision(await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, expectedPorts));
    production.tasks(); production.pipelines(); // the revision is warm, as between seat checks
    let decoded = 0, copied = 0;
    const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
    const prototype = SqliteStateCollection.prototype as unknown as { decodeRow: (text: string, ...args: unknown[]) => unknown };
    const decodeRow = prototype.decodeRow, clone = globalThis.structuredClone;
    const parsing = spyOn(prototype, "decodeRow").mockImplementation(function (this: unknown, text, ...args) {
      if (/"id":"(?:task-flat-|lane-flat-)/.test(text)) decoded++;
      return Reflect.apply(decodeRow, this, [text, ...args]);
    });
    const copying = spyOn(globalThis, "structuredClone").mockImplementation((value, ...args) => { if (value && typeof value === "object" && "id" in value && /^(?:task-flat-|lane-flat-)/.test(String(value.id))) copied++; return clone(value, ...args); });
    try {
      const ports = { ...sources({}), tasks: production.tasks, pipelines: production.pipelines };
      const actual = seatTickDecision(await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports));
      expect(actual.verdict).toEqual(expected.verdict);
      results.push(actual.verdict);
      counts.push({ decoded, copied });
    } finally { parsing.mockRestore(); copying.mockRestore(); }
  }
  expect(results[1]).toEqual(results[0]);
  expect(counts).toEqual([{ decoded: 0, copied: 0 }, { decoded: 0, copied: 0 }]);
});

test("seat projection yields through a large immutable specification and attempt history, then reuses warm evidence", async () => {
  const { refreshSeatTickEvidence } = await import("./seatTickSources");
  const { deepFreeze } = await import("@/lib/deepFreeze");
  const { performanceSpans, performanceSites } = await import("@/lib/performanceSpans");
  const attempts = Array.from({ length: 6000 }, (_, index) => ({
    n: index + 1, state: "running", startedAt: new Date(NOW - index * 1000).toISOString(), completedAt: null,
  }));
  const largeSpec = `${"work ".repeat(21_000)}#123456`;
  const largeRows = deepFreeze(Array.from({ length: 804 }, (_, index) => lane({
    id: `large-spec-${index}`,
    spec: largeSpec,
    runs: index === 0 ? [{ stageId: "build", attempts }] : [{ stageId: "build", attempts: attempts.slice(0, 8) }],
  }))) as never;
  const ports = sources({ pipelines: largeRows });
  const frozenTasks = deepFreeze([]);
  ports.tasks = () => frozenTasks;
  let yielded = false;
  const turn = new Promise<boolean>(resolve => setImmediate(() => { yielded = true; resolve(true); }));
  const gathering = gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  expect(await Promise.race([gathering.then(() => false), turn])).toBe(true);
  const input = await gathering;
  expect(input.pipelines).toHaveLength(804);
  for (let pass = 0; pass < 3; pass++) {
    const refreshed = refreshSeatTickInput(input, ports);
    expect(refreshed.pipelines).toEqual(input.pipelines);
  }
  let refreshed = input;
  for (let pass = 0; pass < 3; pass++) {
    let warmYielded = false;
    const warmTurn = new Promise<void>(resolve => setImmediate(() => { warmYielded = true; resolve(); }));
    const warmStarted = performance.now();
    const warming = refreshSeatTickEvidence(refreshed, ports);
    expect(await Promise.race([warming.then(() => false), warmTurn.then(() => true)])).toBe(true);
    refreshed = await warming;
    expect(warmYielded).toBe(true);
    expect(refreshed.pipelines).toEqual(input.pipelines);
    expect(performanceSpans.snapshot(warmStarted).records.filter(record =>
      record.kind === "sync" && performanceSites[record.site] === "seat-tick.project" && record.rows >= 100)).toHaveLength(0);
  }
  expect(refreshed.pipelines).toEqual(input.pipelines);
  expect(yielded).toBe(true);
});


test("seat refresh retries preparation when its pipeline source is replaced during an await", async () => {
  const { refreshSeatTickEvidence } = await import("./seatTickSources");
  const { deepFreeze } = await import("@/lib/deepFreeze");
  const largeSpec = "old source evidence ".repeat(1800);
  const oldRows = deepFreeze(Array.from({ length: 16 }, (_, index) => lane({
    id: `source-race-${index}`, spec: largeSpec,
    ...(index === 15 ? { state: "needs_review", pausedState: "needs_review", cursor: null,
      runs: [{ stageId: "build", attempts: [] }], srcConversationId: CONVERSATION } : {}),
  })));
  const replacementRows = deepFreeze(oldRows.map((row, index) => ({
    ...row, task: index === 0 ? "replacement source evidence" : row.task,
  }))) as never;
  let currentRows = oldRows;
  const ports = sources({});
  ports.pipelines = () => currentRows as never;
  const input = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  setImmediate(() => { currentRows = replacementRows; });
  const refreshed = await refreshSeatTickEvidence(input, ports);
  expect(refreshed.pipelines[0]?.title).toBe("replacement source evidence");
  expect(refreshed.pipelines.map(pipeline => pipeline.id)).toContain("source-race-0");
  expect(refreshed.ownLanes.map(lane => lane.id)).toContain("source-race-15");
});

test("frozen lane replacement refreshes the agenda without invalidating PR evidence", async () => {
  const { refreshSeatTickEvidence } = await import("./seatTickSources");
  const { spyOn } = await import("bun:test");
  const { deepFreeze } = await import("@/lib/deepFreeze");
  let current = deepFreeze(lane({ spec: "retained evidence".repeat(1000) }));
  const ports = sources({}); ports.pipelines = () => [current] as never;
  const first = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  const stringify = JSON.stringify;
  let bodies = 0;
  const serializing = spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    if (value === current || Array.isArray(value) && value.flat().includes(current)) bodies++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  });
  try {
    expect((await refreshSeatTickEvidence(first, ports)).pullRequestEvidenceKey).toBe(first.pullRequestEvidenceKey);
    expect(bodies).toBe(0);
    current = deepFreeze(lane({ task: "replacement title", spec: "replacement evidence" }));
    const replaced = await refreshSeatTickEvidence(first, ports);
    expect(replaced.pullRequestEvidenceKey).toBe(first.pullRequestEvidenceKey);
    expect(replaced.pipelines[0]?.title).toBe("replacement title");
    expect(bodies).toBe(0);
  } finally { serializing.mockRestore(); }
});

test("continuous immutable lane publications finish projection within three preparation attempts", async () => {
  const { refreshSeatTickEvidence } = await import("./seatTickSources");
  const { deepFreeze } = await import("@/lib/deepFreeze");
  let generation = 0;
  const ports = sources({});
  ports.pipelines = () => deepFreeze([lane({ id: "moving-source", task: `publication ${++generation}` })]) as never;
  const input = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  const before = generation;
  const refreshed = await refreshSeatTickEvidence(input, ports);
  expect(generation - before).toBeLessThanOrEqual(50);
  expect(refreshed.pipelines.map(row => row.id)).toEqual(["moving-source"]);
  expect(refreshed.pipelines[0]?.title).not.toBe(input.pipelines[0]?.title);
  expect(refreshed.pullRequestEvidenceKey).toBe(input.pullRequestEvidenceKey);
});

test("unrelated collection publications cannot cancel this project's alarm evidence", async () => {
  const { refreshSeatTickEvidence } = await import("./seatTickSources");
  const { deepFreeze } = await import("@/lib/deepFreeze");
  const own = deepFreeze(lane({ id: "own-evidence", spec: "project evidence" }));
  let generation = 0;
  const ports = sources({});
  // A different project publishes between every read and every yield. This
  // project's immutable row remains exactly the one which was prepared.
  ports.pipelines = () => Object.freeze([own, deepFreeze(lane({ id: "foreign-evidence",
    project: "unrelated", spec: `foreign publication ${++generation}` }))]) as never;
  const input = await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, ports);
  for (let pass = 0; pass < 3; pass++) {
    const fresh = await refreshSeatTickEvidence(input, ports);
    expect(fresh.pullRequestEvidenceKey).toBe(input.pullRequestEvidenceKey);
    expect(fresh.pipelines.map(row => row.id)).toEqual(["own-evidence"]);
  }
});


test("project liveness rejects a replaced inventory after the worker await and labels the wait", async () => {
  const { spyOn } = await import("bun:test");
  const scan = await import("@/lib/scanner/scanCache");
  const worker = await import("@/lib/scanner/filesResponseWorker");
  const { viewerLoopMonitor } = await import("@/lib/viewerLoopMonitor");
  const { defaultSeatTickSources } = await import("./seatTickSources");
  let descriptor: ReturnType<typeof scan.completedFileScanDescriptor> = { epoch: "fixture", generation: 1, snapshotFile: statePath("fixture-inventory.json") };
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const descriptors = spyOn(scan, "completedFileScanDescriptor").mockImplementation(() => descriptor);
  let calls = 0;
  const reading = spyOn(worker, "runSeatSourceInWorker").mockImplementation(async () => {
    calls++;
    entered();
    expect(viewerLoopMonitor.current()).toBe("seat-tick.liveness");
    await held;
    return { body: "[]" } as never;
  });
  try {
    const source = defaultSeatTickSources();
    const pending = source.liveness({ project: PROJECT, stallAfterMs: 60_000, limit: 20, reconcileStructuredIdle: false });
    const refused = pending.then(() => null, error => error);
    await Promise.race([ready, pending.then(() => { throw new Error("worker was not called"); })]);
    descriptor = { ...descriptor!, generation: 2 };
    release();
    expect((await refused)?.message).toContain("inventory changed");
    expect(await source.liveness({ project: PROJECT, stallAfterMs: 60_000, limit: 20, reconcileStructuredIdle: false })).toEqual([]);
    descriptor = null;
    await expect(source.liveness({ project: PROJECT, stallAfterMs: 60_000, limit: 20, reconcileStructuredIdle: false })).rejects.toThrow("not published");
    expect(calls).toBe(2);
  } finally { release(); reading.mockRestore(); descriptors.mockRestore(); }
});

test("project liveness completes and refreshes catalogue discovery before using the worker", async () => {
  const { spyOn } = await import("bun:test");
  const scan = await import("@/lib/scanner/scanCache");
  const worker = await import("@/lib/scanner/filesResponseWorker");
  const { defaultSeatTickSources } = await import("./seatTickSources");
  let descriptor: NonNullable<ReturnType<typeof scan.completedFileScanDescriptor>> | null = null;
  let refreshes = 0;
  const complete = spyOn(scan, "completedFileScan").mockImplementation(async () => {
    refreshes++;
    descriptor = { epoch: "catalogue", generation: refreshes, snapshotFile: statePath(`inventory-${refreshes}.json`) };
    return {} as never;
  });
  const current = spyOn(scan, "completedFileScanDescriptor").mockImplementation(() => descriptor);
  const read = spyOn(worker, "runSeatSourceInWorker").mockImplementation(async request => {
    expect(request).toMatchObject({ type: "seat-liveness", scan: { epoch: "catalogue", generation: refreshes } });
    return { body: "[]" } as never;
  });
  try {
    const source = defaultSeatTickSources();
    const query = { project: PROJECT, stallAfterMs: 60_000, limit: 20, reconcileStructuredIdle: false } as const;
    await expect(source.liveness(query)).resolves.toEqual([]);
    await expect(source.liveness(query)).resolves.toEqual([]);
    expect(refreshes).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  } finally { read.mockRestore(); current.mockRestore(); complete.mockRestore(); }
});
