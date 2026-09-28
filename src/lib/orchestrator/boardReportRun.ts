import crypto from "node:crypto";

import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { monitorRefIn } from "@/lib/monitor/cards";
import { pipelineCompletedUnreviewed } from "@/lib/pipelines/failEdgeBudget";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import { firstLineTitle } from "@/lib/tasks/helpers";
import type { BoardTask } from "@/lib/tasks/types";

import { composeBoardReport, issueNumbersOnBoard, type BoardReportFacts, type ReportAgent, type ReportLane, type ReportTask } from "./boardReport";
import type { BoardReportOutcome, BoardReportRecord } from "./boardReportStore";

/**
 * The board maintenance report's run (docs/design/board-maintenance-report.md
 * §5): claim the seat epoch, gather the facts, render, re-read the seat and
 * queue the report to it.
 *
 * Started once per new seat epoch from the seat command's one activation point
 * and never awaited, so a rotation answers exactly as fast as it did. It holds
 * no account, starts no conversation, mints no card and holds no MCP client: it
 * reads the stores the seat tick reads and writes only its own claim row and one
 * queued message. Every failure stays inside it.
 */

/** The whole pass, from the claim to the send. */
export const BOARD_REPORT_BUDGET_MS = 30_000;
/** One `gh` read, or the liveness read, inside that budget. */
export const BOARD_REPORT_SOURCE_TIMEOUT_MS = 20_000;
/** How the report's sender is named on the seat's feed. */
export const BOARD_REPORT_ORIGIN_ROLE = "board-maintenance";

export interface BoardReportSeat {
  project: string;
  seatEpoch: number;
  conversationId: string;
  path: string | null;
}

/** A replay of the same epoch is the same message to the delivery layer. */
export function boardReportMessageId(project: string, seatEpoch: number): string {
  return `board_report_${crypto.createHash("sha256").update(`${project}:${seatEpoch}`).digest("hex").slice(0, 40)}`;
}

export interface BoardReportDelivery {
  pid: null;
  path: string;
  conversationId: string;
  clientMessageId: string;
  text: string;
  images: [];
  origin: MessageOrigin;
  /** Lands after the running turn (the successor reading its handoff) and
      never interrupts it; seat wakes wait for idle the same way. */
  policy: "queue";
}

export function boardReportDelivery(seat: BoardReportSeat, text: string): BoardReportDelivery {
  return {
    pid: null,
    path: seat.path ?? "",
    conversationId: seat.conversationId,
    clientMessageId: boardReportMessageId(seat.project, seat.seatEpoch),
    text,
    images: [],
    origin: delegatusMessageOrigin(BOARD_REPORT_ORIGIN_ROLE, seat.project),
    policy: "queue",
  };
}

export interface BoardReportRunPorts {
  now(): number;
  /** True for exactly one caller per epoch. */
  claim(record: BoardReportRecord): boolean;
  settle(project: string, seatEpoch: number, patch: Partial<BoardReportRecord>): void;
  /** The project's active seat as it stands now. */
  activeSeat(project: string): { seatEpoch: number; conversationId: string | null } | null;
  /** Everything the report states. Sources that fail become gaps in it. */
  facts(seat: BoardReportSeat, deadlineMs: number): Promise<BoardReportFacts>;
  deliver(request: BoardReportDelivery): Promise<{ ok: boolean; outcome?: string; error?: string }>;
}

/** Run the pass for one seat epoch and answer its record, or null when this
    epoch was already claimed. Throws only what a port threw. */
export async function runBoardReport(seat: BoardReportSeat, ports: BoardReportRunPorts): Promise<BoardReportRecord | null> {
  const claimedAt = ports.now();
  const record: BoardReportRecord = {
    project: seat.project,
    seatEpoch: seat.seatEpoch,
    conversationId: seat.conversationId,
    clientMessageId: boardReportMessageId(seat.project, seat.seatEpoch),
    claimedAt: new Date(claimedAt).toISOString(),
    sentAt: null,
    outcome: null,
    detail: null,
    bytes: null,
    counts: null,
    gaps: [],
  };
  if (!ports.claim(record)) return null;
  const settle = (outcome: BoardReportOutcome, patch: Partial<BoardReportRecord> = {}): BoardReportRecord => {
    const settled = { ...record, ...patch, outcome };
    ports.settle(seat.project, seat.seatEpoch, { ...patch, outcome });
    return settled;
  };

  let facts: BoardReportFacts;
  let report: ReturnType<typeof composeBoardReport>;
  try {
    facts = await ports.facts(seat, claimedAt + BOARD_REPORT_BUDGET_MS);
    report = composeBoardReport(facts);
  } catch (error) {
    /* The claim stays spent: the mandate tells the seat to cover a report that
       never came with its own reads, and a retry sweep is deferred (§9). */
    return settle("failed", { detail: `gather failed: ${error instanceof Error ? error.message.slice(0, 180) : "unknown"}` });
  }
  const measured = { bytes: report.bytes, counts: report.counts, gaps: facts.gaps.map((gap) => `${gap.source}: ${gap.reason}`) };

  /* A second rotation while the pass ran owns the seat now, and its own pass
     reports to its own conversation. */
  const current = ports.activeSeat(seat.project);
  if (!current || current.seatEpoch !== seat.seatEpoch || current.conversationId !== seat.conversationId) {
    return settle("superseded", measured);
  }
  /* A fresh seat on an empty board already greets; a turn that says nothing
     costs a turn. */
  if (report.empty) return settle("empty", measured);

  try {
    const answer = await ports.deliver(boardReportDelivery(seat, report.text));
    return answer.ok
      ? settle("sent", { ...measured, sentAt: new Date(ports.now()).toISOString(), detail: answer.outcome ?? null })
      : settle("failed", { ...measured, detail: answer.error ?? "delivery refused" });
  } catch (error) {
    return settle("failed", { ...measured, detail: error instanceof Error ? error.message.slice(0, 200) : "delivery threw" });
  }
}

/** Start the pass and return at once. Nothing it does can reach the caller:
    a rotation that started it has already answered. */
export function startBoardReport(seat: BoardReportSeat, ports?: BoardReportRunPorts): void {
  void (async () => {
    try {
      await runBoardReport(seat, ports ?? await productionBoardReportPorts());
    } catch (error) {
      console.error(`[board report] ${seat.project} epoch ${seat.seatEpoch} failed`, error instanceof Error ? error.name : "unknown");
    }
  })();
}

/* ── adapters from the stores ───────────────────────────────────────────── */

function attemptsOf(pipeline: Pipeline): { stageId: string; attempt: PipelineStageAttempt }[] {
  return pipeline.runs.flatMap((run) => run.attempts.filter((attempt) => !attempt.historical).map((attempt) => ({ stageId: run.stageId, attempt })));
}

function attemptAt(attempt: PipelineStageAttempt): number {
  const at = Date.parse(attempt.completedAt ?? attempt.startedAt ?? "");
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  return line || null;
}

export function reportLaneFrom(pipeline: Pipeline): ReportLane {
  const attempts = attemptsOf(pipeline);
  const newest = attempts.reduce<(typeof attempts)[number] | null>((held, entry) =>
    !held || attemptAt(entry.attempt) >= attemptAt(held.attempt) ? entry : held, null);
  const stageId = pipeline.cursor?.stageId ?? newest?.stageId ?? null;
  const onStage = attempts.filter((entry) => entry.stageId === stageId).at(-1)?.attempt ?? null;
  const open = !pipeline.closedAt && !pipeline.hiddenAt && !pipeline.dismissedAt
    && pipeline.state !== "completed" && pipeline.state !== "closed";
  const moments = [pipeline.pausedAt, pipeline.resumedAt, ...attempts.flatMap(({ attempt }) => [attempt.startedAt, attempt.completedAt])]
    .filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)));
  const movedAt = moments.reduce((held, at) => (Date.parse(at) > Date.parse(held) ? at : held), pipeline.createdAt);
  return {
    id: pipeline.id,
    title: pipeline.task,
    state: pipeline.state,
    pausedState: pipeline.pausedState,
    open,
    completed: pipeline.state === "completed" && !pipeline.hiddenAt,
    stageId,
    attempt: onStage?.n ?? null,
    attemptStartedAt: onStage?.startedAt ?? null,
    failure: open && newest?.attempt.state === "failed"
      ? { stageId: newest.stageId, reason: firstLine(newest.attempt.error) ?? "no reason recorded" }
      : null,
    question: firstLine(pipeline.stateDetail) ?? firstLine(newest?.attempt.report?.summary ?? null),
    reviewStageId: pipeline.reviewPending?.stageId ?? null,
    lastFixUnreviewed: pipelineCompletedUnreviewed(pipeline) !== null,
    createdAt: pipeline.createdAt,
    movedAt,
    branch: pipeline.branch,
    taskIds: pipeline.taskIds,
    merge: pipeline.merge ? { state: pipeline.merge.state, prNumber: pipeline.merge.prNumber, mergedAt: pipeline.merge.mergedAt } : null,
  };
}

export function reportTaskFrom(task: BoardTask & { pipelineIds: string[] }): ReportTask | null {
  if (task.status === "done") return null;
  return {
    id: task.id,
    status: task.status,
    title: firstLineTitle(task.text),
    searchText: `${task.text}\n${task.details ?? ""}`,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    placeholder: task.origin?.refinement === "pending",
    hiddenByOperator: task.groupHidden?.by === "operator",
    laneIds: task.pipelineIds,
    conversationIds: [...new Set(task.assignments.flatMap((assignment) => (assignment.conversationId ? [assignment.conversationId] : [])))],
    noticeRef: monitorRefIn(task.text),
  };
}

export function reportAgentFrom(
  record: AgentLivenessRecord,
  context: { lastWords: string | null; spawnedBy: ReportAgent["spawnedBy"] },
): ReportAgent {
  return {
    conversationId: record.conversationId,
    title: record.title,
    lifecycle: record.lifecycle,
    reason: record.reason,
    hostAlive: record.host.state === "alive",
    silentForMs: record.silentForMs,
    laneId: record.pipeline?.pipelineId ?? null,
    stageId: record.pipeline?.stageId ?? null,
    lastWords: context.lastWords,
    spawnedBy: context.spawnedBy,
  };
}

/* ── production ─────────────────────────────────────────────────────────── */

/** Settle `work` or give up at `deadlineMs`; either way the caller goes on. */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number, now: () => number): Promise<T | "timed-out"> {
  const remaining = Math.max(0, Math.min(BOARD_REPORT_SOURCE_TIMEOUT_MS, deadlineMs - now()));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), remaining);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function gatherBoardReportFacts(seat: BoardReportSeat, deadlineMs: number): Promise<BoardReportFacts> {
  const [
    fs,
    { loadArchivedPipelines, loadPipelinesForList },
    { loadTasks },
    { projectTaskPipelineIds },
    { canonicalOrchestratorProject, orchestratorRevocations },
    { agentRegistry },
    { agentLivenessSnapshot, productionLivenessSources },
    { childFinalMessage },
    { effectiveSeatTickSettings, readSeatTickSettings },
    { DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS },
    { openIssuesRanked, openPullRequestsForRepo },
    { repositoryForProjectRoot },
    { repositoryRootForPath },
    { recordedProjectRoot },
    { projectDisplayName },
  ] = await Promise.all([
    import("node:fs"),
    import("@/lib/pipelines/store"),
    import("@/lib/tasks/store"),
    import("@/lib/pipelines/taskBinding"),
    import("./seats"),
    import("@/lib/agent/registry"),
    import("@/lib/lifecycle/liveness"),
    import("@/lib/monitor/childFinalMessage"),
    import("@/lib/monitor/seatTickSettings"),
    import("@/lib/monitor/seatTick"),
    import("@/lib/monitor/githubEvidence"),
    import("@/lib/projects/git"),
    import("@/lib/projects/identity"),
    import("./seatCommand"),
    import("@/lib/displayNames"),
  ]);
  const now = Date.now();
  const clock = () => Date.now();
  const project = canonicalOrchestratorProject(seat.project);
  const gaps: BoardReportFacts["gaps"] = [];
  const read = <T>(source: string, work: () => T, fallback: T): T => {
    try {
      return work();
    } catch {
      gaps.push({ source, reason: "unreadable" });
      return fallback;
    }
  };
  const ours = (key: string) => canonicalOrchestratorProject(key) === project;

  const hot = read("lanes", () => loadPipelinesForList(), [] as Pipeline[]);
  const archived = read("archived lanes", () => loadArchivedPipelines(), [] as Pipeline[]);
  const projectLanes = hot.filter((pipeline) => ours(pipeline.project) && !pipeline.hiddenAt);
  const tasks = read("tasks", () => loadTasks(), [] as BoardTask[])
    .filter((task) => ours(task.project) && task.status !== "done");
  const reportTasks = projectTaskPipelineIds(tasks, hot).flatMap((task) => reportTaskFrom(task) ?? []);
  const revokedSeats = new Set(read("seats", () => orchestratorRevocations(), [])
    .filter((revocation) => ours(revocation.project) && revocation.conversationId !== seat.conversationId)
    .map((revocation) => revocation.conversationId));

  /* Who started each conversation: a lineage edge, a receipt with a parent, or
     a lane's stage. Anything else is the operator's own session (D3). */
  const snapshot = read("registry", () => agentRegistry().readOnlySnapshot(), null);
  const parentOf = new Map<string, string>();
  for (const edge of Object.values(snapshot?.lineageEdges ?? {})) parentOf.set(edge.childConversationId, edge.parentConversationId);
  for (const receipt of Object.values(snapshot?.receipts ?? {})) {
    if (receipt.parentConversationId && !parentOf.has(receipt.conversationId)) parentOf.set(receipt.conversationId, receipt.parentConversationId);
  }
  const agentStarted = new Set<string>(parentOf.keys());
  for (const pipeline of hot) {
    for (const run of pipeline.runs) for (const attempt of run.attempts) if (attempt.conversationId) agentStarted.add(attempt.conversationId);
  }

  const tickSettings = read("seat tick settings", () => readSeatTickSettings(project), null);
  const effective = tickSettings ? effectiveSeatTickSettings(tickSettings, now, SEAT_TICK_WAKE_INTERVAL_MS) : null;

  /* GitHub only when the project's origin is on github.com: a read of local
     git metadata, no subprocess, and no `gh` at all otherwise. */
  const seatCwd = snapshot?.conversations[seat.conversationId]?.generations.at(-1)?.launchProfile?.cwd ?? null;
  const directory = (candidate: string | null | undefined): string | null => {
    if (!candidate) return null;
    try { return fs.statSync(candidate).isDirectory() ? candidate : null; } catch { return null; }
  };
  const newestRepoDir = [...projectLanes, ...archived.filter((pipeline) => ours(pipeline.project))]
    .filter((pipeline) => directory(pipeline.repoDir))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]?.repoDir ?? null;
  const root = (directory(seatCwd) ? repositoryRootForPath(seatCwd!) : null) ?? recordedProjectRoot(project) ?? newestRepoDir;
  const repository = root ? repositoryForProjectRoot(root) : null;

  const reportLanes = projectLanes.map(reportLaneFrom);
  const livenessWork = agentLivenessSnapshot({ project, liveOnly: true, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs, limit: 200 }, productionLivenessSources())
    .then((answer) => answer.conversations, () => "unreadable" as const);
  const [liveness, pullRequests, issues] = await Promise.all([
    withDeadline(livenessWork, deadlineMs, clock),
    repository && root ? withDeadline(openPullRequestsForRepo({ cwd: root, timeoutMs: BOARD_REPORT_SOURCE_TIMEOUT_MS }), deadlineMs, clock) : Promise.resolve(null),
    repository && root
      ? withDeadline(openIssuesRanked({ cwd: root, repository, onBoard: issueNumbersOnBoard(reportTasks, reportLanes), timeoutMs: BOARD_REPORT_SOURCE_TIMEOUT_MS }), deadlineMs, clock)
      : Promise.resolve(null),
  ]);

  let agents: ReportAgent[] | null = null;
  if (typeof liveness === "string") {
    gaps.push({ source: "agent liveness", reason: liveness });
  } else {
    agents = liveness.map((record) => {
      const parent = record.conversationId ? parentOf.get(record.conversationId) : undefined;
      return reportAgentFrom(record, {
        lastWords: record.lifecycle === "stalled" ? childFinalMessage(record.transcriptPath, record.engine) : null,
        spawnedBy: parent === seat.conversationId ? "this seat" : parent && revokedSeats.has(parent) ? "an earlier seat" : null,
      });
    });
  }
  if (pullRequests === "timed-out") gaps.push({ source: "pull requests", reason: "timed-out" });
  else if (pullRequests && !pullRequests.ok) gaps.push({ source: "pull requests", reason: pullRequests.unavailable });

  const laneBranches = new Set([...hot, ...archived].map((pipeline) => pipeline.branch).filter(Boolean));
  const origin = delegatusMessageOrigin(BOARD_REPORT_ORIGIN_ROLE, project);
  return {
    projectName: origin.project ?? projectDisplayName(project),
    seatEpoch: seat.seatEpoch,
    seatConversationId: seat.conversationId,
    now,
    tick: effective && tickSettings
      ? { enabled: effective.enabled, wakeIntervalMinutes: Math.round(effective.wakeIntervalMs / 60_000), reason: effective.reason, changedAt: tickSettings.updatedAt }
      : null,
    lanes: reportLanes,
    tasks: reportTasks,
    agents,
    revokedSeats,
    agentStarted,
    pullRequests: !repository ? null : pullRequests === "timed-out" || pullRequests === null ? { ok: false, unavailable: "timed-out" } : pullRequests,
    laneBranches,
    github: !repository
      ? { kind: "not-configured" }
      : issues === "timed-out" || issues === null
        ? { kind: "unavailable", reason: "timed-out" }
        : issues.ok ? { kind: "ranked", ranking: issues.ranking } : { kind: "unavailable", reason: issues.unavailable },
    gaps,
  };
}

async function productionBoardReportPorts(): Promise<BoardReportRunPorts> {
  const [store, { orchestratorSeatFor }, { deliverConversationMessage }] = await Promise.all([
    import("./boardReportStore"),
    import("./seats"),
    import("@/lib/delivery"),
  ]);
  return {
    now: () => Date.now(),
    claim: store.claimBoardReport,
    settle: store.settleBoardReport,
    activeSeat: (project) => orchestratorSeatFor(project).active,
    facts: gatherBoardReportFacts,
    deliver: async (request) => {
      /* The seat tick's own delivery call for its wakes: structured when the
         seat is, held until a booting host exists. */
      const outcome = await deliverConversationMessage(request);
      return outcome.ok ? { ok: true, outcome: outcome.outcome ?? "delivered" } : { ok: false, error: outcome.error };
    },
  };
}
