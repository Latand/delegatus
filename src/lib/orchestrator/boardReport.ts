import { redactMonitorText } from "@/lib/monitor/redact";
import type { IssueRanking, OpenPullRequest, OpenPullRequestsUnavailable, RankedIssue } from "@/lib/monitor/githubEvidence";
import type { PipelineState } from "@/lib/pipelines/types";
import type { TaskStatus } from "@/lib/tasks/types";

/**
 * The board maintenance report (docs/design/board-maintenance-report.md §3, §6).
 *
 * One read-only pass over a project's board, computed with no model when a
 * seat epoch begins and sent to the incoming orchestrator as one bounded
 * message. This module is the pure half: it takes the facts the run gathered
 * (lanes, tasks, agent liveness, pull requests, ranked issues) and renders the
 * sections. Every row states a fact the stores hold and every close candidate
 * names the rule that matched, so the orchestrator can check the rule as well
 * as the row. Nothing here decides what to close or start: that judgement is
 * the orchestrator's (§3), and the operator's for cards only their own
 * sessions hold (decision D3).
 */

export const BOARD_REPORT_CAP_BYTES = 6_000;
const TITLE_LIMIT = 80;
const LINE_LIMIT = 200;
const LAST_WORDS_LIMIT = 160;
const REASON_LIMIT = 100;
const PLACEHOLDER_IDLE_MS = 24 * 60 * 60_000;
const NOTICE_TITLE_CAP = 5;

/** Row caps per section (§6). */
const CAPS = { decisions: 8, ready: 8, stuck: 8, running: 10, idle: 8, close: 10, pullRequests: 5, suggestions: 3, next: 5, newest: 3 } as const;

/** One lane of this project, as the report reads it. */
export interface ReportLane {
  id: string;
  title: string;
  state: PipelineState;
  /** The state a paused lane stopped in, if any. */
  pausedState: PipelineState | null;
  /** Neither closed, hidden, dismissed, completed nor closed by its state. */
  open: boolean;
  /** Reached `completed` and was not hidden. */
  completed: boolean;
  stageId: string | null;
  attempt: number | null;
  attemptStartedAt: string | null;
  /** The newest attempt failed while the lane is open. */
  failure: { stageId: string; reason: string } | null;
  /** First line of what a lane parked on a decision asks. */
  question: string | null;
  /** The review stage whose budget a `needs_review` lane spent. */
  reviewStageId: string | null;
  lastFixUnreviewed: boolean;
  createdAt: string;
  /** When it last moved (an attempt started or completed), else createdAt. */
  movedAt: string;
  branch: string;
  taskIds: string[];
  merge: { state: string; prNumber: number; mergedAt: string | null } | null;
}

/** One open task of this project. */
export interface ReportTask {
  id: string;
  status: Exclude<TaskStatus, "done">;
  /** First line of the human text. */
  title: string;
  /** The text and details, searched for issue numbers. */
  searchText: string;
  createdAt: string;
  updatedAt: string;
  /** Still carries its launch placeholder title. */
  placeholder: boolean;
  /** Its group was hidden from the board by the operator. */
  hiddenByOperator: boolean;
  laneIds: string[];
  conversationIds: string[];
  /** The `monitor-ref:` of a Delegatus notice card. */
  noticeRef: string | null;
}

/** One live or stalled agent of this project, from the liveness snapshot. */
export interface ReportAgent {
  conversationId: string | null;
  title: string;
  lifecycle: string;
  reason: string;
  hostAlive: boolean;
  silentForMs: number | null;
  laneId: string | null;
  stageId: string | null;
  /** The last words of a stalled agent, already bounded. */
  lastWords: string | null;
  spawnedBy: "this seat" | "an earlier seat" | null;
}

export interface ReportTick {
  enabled: boolean;
  wakeIntervalMinutes: number;
  reason: string | null;
  changedAt: string | null;
}

export type ReportGithub =
  | { kind: "not-configured" }
  | { kind: "unavailable"; reason: OpenPullRequestsUnavailable | "timed-out" }
  | { kind: "ranked"; ranking: IssueRanking };

export interface BoardReportFacts {
  needsYou?: import("@/lib/attention/needsYouRead").NeedsYouAnswer | null;
  projectName: string;
  seatEpoch: number;
  seatConversationId: string;
  now: number;
  tick: ReportTick | null;
  lanes: ReportLane[];
  tasks: ReportTask[];
  /** Null when the liveness read could not answer. */
  agents: ReportAgent[] | null;
  /** Conversations of this project's revoked orchestrator seats. */
  revokedSeats: ReadonlySet<string>;
  /** Conversations with a spawn lineage from a seat, a lane or an agent. */
  agentStarted: ReadonlySet<string>;
  /** Null when GitHub is not configured; `unavailable` when it could not answer. */
  pullRequests: { ok: true; pullRequests: OpenPullRequest[] } | { ok: false; unavailable: string } | null;
  /** Every branch a lane on this machine carries, any project. */
  laneBranches: ReadonlySet<string>;
  github: ReportGithub;
  /** Sources that failed or timed out, named in the header. */
  gaps: { source: string; reason: string }[];
}

export interface BoardReportCounts {
  waiting: number;
  waitingStale: number;
  decisions: number;
  ready: number;
  stuck: number;
  running: number;
  idle: number;
  close: number;
  pullRequests: number;
  suggestions: number;
}

export interface BoardReport {
  text: string;
  bytes: number;
  /** Every section empty and GitHub not configured: nothing to send. */
  empty: boolean;
  counts: BoardReportCounts;
}

/* ── formatting ─────────────────────────────────────────────────────────── */

function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

function since(now: number, at: string | null | undefined): string | null {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? age(now - ms) : null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, limit: number): string {
  const flat = oneLine(text);
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function title(text: string): string {
  return `«${clip(text, TITLE_LIMIT) || "untitled"}»`;
}

/** Credentials and paths out first, then the line bound, as a wake does. */
function row(text: string): string {
  return `- ${clip(redactMonitorText(text), LINE_LIMIT - 2)}`;
}

/** The longest prefix of whole code points within `maxBytes` of UTF-8. */
function withinBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const point of text) {
    bytes += Buffer.byteLength(point, "utf8");
    if (bytes > maxBytes) break;
    end += point.length;
  }
  return text.slice(0, end);
}

function utcMinute(now: number): string {
  return new Date(now).toISOString().slice(0, 16).replace("T", " ");
}

/* ── derivation ─────────────────────────────────────────────────────────── */

interface Section {
  heading: string;
  rows: string[];
  cap: number;
  /** Omitted entirely when it has no rows. */
  optional: boolean;
  /** Printed after the rows, whatever was cut. */
  footer?: string | null;
  /** Said beside the heading: what the section could not read. */
  note?: string | null;
}

function parkedOn(lane: ReportLane, state: PipelineState): boolean {
  return lane.state === state || (lane.state === "paused" && lane.pausedState === state);
}

/** An open pull request whose head is the lane's branch, opened while the lane
    existed: a reused branch name cannot hand one lane another's pull request. */
function laneRequest(lane: ReportLane, pullRequests: readonly OpenPullRequest[]): OpenPullRequest | null {
  const created = Date.parse(lane.createdAt);
  return pullRequests.find((request) => request.headRefName === lane.branch
    && (!Number.isFinite(created) || Date.parse(request.createdAt) >= created)) ?? null;
}

/** Issue numbers the board already carries: `#<n>` in an open task or lane
    title, or a number segment of a lane's branch. */
export function issueNumbersOnBoard(tasks: readonly ReportTask[], lanes: readonly ReportLane[]): Set<number> {
  const numbers = new Set<number>();
  const hashes = (text: string) => {
    for (const match of text.matchAll(/#(\d{1,7})\b/g)) numbers.add(Number(match[1]));
  };
  for (const task of tasks) hashes(task.searchText);
  for (const lane of lanes) {
    if (!lane.open) continue;
    hashes(lane.title);
    for (const match of lane.branch.matchAll(/(?:^|[/_-])(\d{1,6})(?=$|[/_-])/g)) numbers.add(Number(match[1]));
  }
  return numbers;
}

function issueRow(issue: RankedIssue, now: number): string {
  const signals = [
    issue.tierSignal,
    issue.status ? `Status ${issue.status}` : "no status",
    issue.milestone ? `milestone ${issue.milestone.title}${issue.milestone.dueOn ? ` due ${issue.milestone.dueOn.slice(0, 10)}` : ""}` : null,
  ].filter((part): part is string => Boolean(part));
  const created = Date.parse(issue.createdAt);
  const updated = issue.updatedAt ? Date.parse(issue.updatedAt) : created;
  const untouched = Number.isFinite(updated) && Math.abs(updated - created) < 60_000;
  return row(`#${issue.number} ${title(issue.title)} — ${signals.join(" · ")} · open ${age(now - created)}${untouched ? ", never updated" : ""}`);
}

interface GithubLines {
  heading: string;
  lead: string[];
  suggestionHeading: string | null;
  suggestions: string[];
  next: string | null;
  newest: string | null;
}

function githubLines(github: ReportGithub, now: number): GithubLines {
  if (github.kind === "not-configured") {
    return { heading: "8. GitHub: not configured for this project.", lead: [], suggestionHeading: null, suggestions: [], next: null, newest: null };
  }
  if (github.kind === "unavailable") {
    return { heading: `8. GitHub: unavailable (${github.reason}).`, lead: [], suggestionHeading: null, suggestions: [], next: null, newest: null };
  }
  const ranking = github.ranking;
  const partial = ranking.read < ranking.totalCount ? ` of the ${ranking.read} most recently updated` : " of them";
  const lead = [
    ranking.ranked.length ? `Ranked by ${ranking.signals.join(", ")}.` : null,
    ranking.unranked.length
      ? `No recorded priority on ${ranking.unranked.length}${partial} (read: Project Priority and Urgency fields, priority labels, milestones).`
      : null,
    ranking.projectFieldsUnreadable ? "Project fields unreadable." : null,
    ranking.excluded ? `${ranking.excluded} are already on the board, have an open pull request or are not open for work.` : null,
  ].filter((line): line is string => Boolean(line));
  const worth = ranking.ranked.filter((issue) => (issue.tier ?? 4) <= 1 && (issue.ready || issue.status === null));
  const chosen = (worth.length ? worth : ranking.ranked).slice(0, CAPS.suggestions);
  const chosenNumbers = new Set(chosen.map((issue) => issue.number));
  const rest = ranking.ranked.filter((issue) => !chosenNumbers.has(issue.number)).slice(0, CAPS.next);
  const newest = ranking.unranked.slice(0, CAPS.newest);
  return {
    heading: `8. GitHub issues (${ranking.totalCount} open)`,
    lead: lead.length ? [lead.join(" ")] : [],
    suggestionHeading: chosen.length ? (worth.length ? "Worth starting now:" : "Highest ranked:") : null,
    suggestions: chosen.map((issue) => issueRow(issue, now)),
    next: rest.length ? `Next by rank: ${rest.map((issue) => `#${issue.number}`).join(", ")}.` : null,
    newest: newest.length ? `Newest without a recorded priority: ${newest.map((issue) => `#${issue.number}`).join(", ")}.` : null,
  };
}

/**
 * Pure: render the report from gathered facts, within
 * {@link BOARD_REPORT_CAP_BYTES}.
 */
export function composeBoardReport(facts: BoardReportFacts): BoardReport {
  const { now } = facts;
  const lanes = new Map(facts.lanes.map((lane) => [lane.id, lane]));
  const openLanes = facts.lanes.filter((lane) => lane.open);
  const agents = (facts.agents ?? []).filter((agent) => agent.conversationId !== facts.seatConversationId);
  const live = new Set(agents.flatMap((agent) => (agent.conversationId && agent.lifecycle !== "gone" ? [agent.conversationId] : [])));
  const pullRequests = facts.pullRequests?.ok ? facts.pullRequests.pullRequests : null;
  const listed = new Set<string>();

  /* 1. Decisions waiting on the operator. */
  const decisions: string[] = [];
  for (const lane of openLanes) {
    if (!parkedOn(lane, "needs_decision")) continue;
    listed.add(lane.id);
    decisions.push(row(`lane ${lane.id} ${title(lane.title)} needs_decision${lane.stageId ? ` at ${lane.stageId}` : ""} for ${age(now - Date.parse(lane.movedAt))}${lane.question ? `: ${lane.question}` : ""}`));
  }
  for (const agent of agents) {
    if (agent.reason !== "permission_request") continue;
    const where = agent.laneId ? `lane ${agent.laneId} stage ${agent.stageId ?? "unknown"}` : `conversation ${agent.conversationId} ${title(agent.title)}`;
    decisions.push(row(`permission request in ${where}, waiting ${age(agent.silentForMs ?? 0)}`));
  }

  /* Lanes that finished and left a pull request open, and the newer open lane
     on the same task that makes that pull request look superseded. */
  const newerLane = (lane: ReportLane): ReportLane | null => openLanes.find((other) =>
    other.id !== lane.id && Date.parse(other.createdAt) > Date.parse(lane.createdAt)
    && other.taskIds.some((taskId) => lane.taskIds.includes(taskId))) ?? null;

  /* 2. Ready to finish. */
  const ready: string[] = [];
  const superseded: string[] = [];
  for (const lane of facts.lanes) {
    if (lane.completed && pullRequests && lane.merge?.state !== "merged") {
      const request = laneRequest(lane, pullRequests);
      if (!request) continue;
      const newer = newerLane(lane);
      ready.push(row(`lane ${lane.id} ${title(lane.title)} completed ${age(now - Date.parse(lane.movedAt))} ago, pull request #${request.number} open; merge ${lane.merge?.state ?? "not queued"}${lane.lastFixUnreviewed ? "; last fix not re-reviewed" : ""}${newer ? `; its task has a newer lane ${newer.id} running` : ""}`));
      if (newer) superseded.push(row(`pull request #${request.number} ${title(request.title)}: superseded-pr, lane ${lane.id} finished and lane ${newer.id} is running on the same task`));
    } else if (lane.open && parkedOn(lane, "needs_review")) {
      listed.add(lane.id);
      ready.push(row(`lane ${lane.id} ${title(lane.title)} needs_review: review budget spent${lane.reviewStageId ? ` at ${lane.reviewStageId}` : ""}`));
    }
  }

  /* Tasks the report speaks about as candidates, never twice. */
  const visibleTasks = facts.tasks.filter((task) => !task.hiddenByOperator && !task.conversationIds.includes(facts.seatConversationId));
  const hiddenGroups = facts.tasks.filter((task) => task.hiddenByOperator).length;
  const candidateTasks = new Set<string>();
  const close: string[] = [];
  const operatorOnly = (task: ReportTask) => task.laneIds.length === 0 && task.conversationIds.length > 0
    && task.conversationIds.every((id) => !facts.agentStarted.has(id) && !facts.revokedSeats.has(id));
  const candidate = (task: ReportTask, rule: string, evidence: string) => {
    candidateTasks.add(task.id);
    close.push(row(`task ${task.id} [${task.status}] ${title(task.title)}: ${rule}, ${evidence}${operatorOnly(task) ? "; operator's own session, ask first" : ""}`));
  };
  const tasksWithMergedLanes: string[] = [];
  const newestNotice = new Map<string, ReportTask>();
  for (const task of visibleTasks) {
    if (!task.noticeRef) continue;
    const held = newestNotice.get(task.noticeRef);
    if (!held || Date.parse(task.createdAt) > Date.parse(held.createdAt)) newestNotice.set(task.noticeRef, task);
  }
  for (const task of visibleTasks) {
    const taskLanes = task.laneIds.map((id) => lanes.get(id)).filter((lane): lane is ReportLane => Boolean(lane));
    const running = taskLanes.some((lane) => lane.open) || task.conversationIds.some((id) => live.has(id));
    if (task.conversationIds.length > 0 && task.conversationIds.every((id) => facts.revokedSeats.has(id))) {
      candidate(task, "seat-card", "held only by a revoked seat");
      continue;
    }
    if (task.placeholder && !running && now - Date.parse(task.updatedAt) > PLACEHOLDER_IDLE_MS) {
      candidate(task, "placeholder", `no lane, no live agent, idle ${age(now - Date.parse(task.updatedAt))}`);
      continue;
    }
    if (taskLanes.length > 0 && taskLanes.length === task.laneIds.length && taskLanes.every((lane) => lane.completed)) {
      const merged = taskLanes.filter((lane) => lane.merge?.state === "merged");
      if (merged.length === taskLanes.length) {
        const last = merged.reduce((held, lane) => (Date.parse(lane.merge?.mergedAt ?? "") > Date.parse(held.merge?.mergedAt ?? "") ? lane : held));
        const when = since(now, last.merge?.mergedAt);
        candidateTasks.add(task.id);
        tasksWithMergedLanes.push(row(`task ${task.id} [${task.status}] ${title(task.title)}: every lane completed, pull request #${last.merge!.prNumber} merged${when ? ` ${when} ago` : ""}`));
        continue;
      }
      if (pullRequests && taskLanes.every((lane) => lane.merge?.state === "merged" || !laneRequest(lane, pullRequests))) {
        candidate(task, "finished", "every lane completed and no pull request of theirs is open");
        continue;
      }
    }
    const notice = task.noticeRef ? newestNotice.get(task.noticeRef) : null;
    if (notice && notice.id !== task.id) candidate(task, "duplicate-notice", `same notice as newer task ${notice.id}`);
  }
  ready.push(...tasksWithMergedLanes);
  close.push(...superseded);

  /* 3. Stuck. */
  const stuck: string[] = [];
  const stuckLanes = new Set<string>();
  for (const agent of agents) {
    if (agent.lifecycle !== "stalled" || agent.reason === "permission_request") continue;
    const words = agent.lastWords ? `; last words: «${clip(agent.lastWords, LAST_WORDS_LIMIT)}»` : "";
    if (agent.laneId) {
      stuckLanes.add(agent.laneId);
      stuck.push(row(`lane ${agent.laneId} stage ${agent.stageId ?? "unknown"}: agent silent ${age(agent.silentForMs ?? 0)}, host ${agent.hostAlive ? "alive" : "dead"}${words}`));
    } else {
      stuck.push(row(`conversation ${agent.conversationId} ${title(agent.title)}${agent.spawnedBy ? `, spawned by ${agent.spawnedBy}` : ""}: stalled ${age(agent.silentForMs ?? 0)}${words}`));
    }
  }
  for (const lane of openLanes) {
    if (!lane.failure || listed.has(lane.id)) continue;
    stuckLanes.add(lane.id);
    stuck.push(row(`lane ${lane.id} ${title(lane.title)} failed at ${lane.failure.stageId}: ${clip(lane.failure.reason, REASON_LIMIT)}`));
  }

  /* 4. Running. */
  const running: string[] = [];
  for (const lane of openLanes) {
    if (listed.has(lane.id) || stuckLanes.has(lane.id)) continue;
    const at = lane.stageId ? ` at ${lane.stageId}` : "";
    const paused = lane.state === "paused" ? ", paused" : "";
    const attempt = lane.attempt !== null ? `, attempt ${lane.attempt}` : "";
    running.push(row(`lane ${lane.id} ${title(lane.title)}${at}${paused}${attempt}, ${age(now - Date.parse(lane.attemptStartedAt ?? lane.createdAt))}`));
  }

  /* 5. Tasks with nothing running. Inbox work the operator queued and nobody
     started follows the assigned and blocked rows, so the byte bound cuts it
     first; a notice card is named only on the header's Notices line. */
  const idle: string[] = [];
  const queued: string[] = [];
  for (const task of visibleTasks) {
    if (candidateTasks.has(task.id)) continue;
    const taskLanes = task.laneIds.map((id) => lanes.get(id)).filter((lane): lane is ReportLane => Boolean(lane));
    if (task.status === "blocked") {
      idle.push(row(`task ${task.id} [blocked] ${title(task.title)}, blocked ${age(now - Date.parse(task.updatedAt))}`));
      continue;
    }
    if (taskLanes.some((lane) => lane.open) || task.conversationIds.some((id) => live.has(id))) continue;
    if (task.status === "inbox") {
      if (!task.noticeRef) queued.push(row(`task ${task.id} [inbox] ${title(task.title)}, waiting ${age(now - Date.parse(task.createdAt))}`));
      continue;
    }
    const ended = taskLanes.reduce<string | null>((held, lane) => (!held || Date.parse(lane.movedAt) > Date.parse(held) ? lane.movedAt : held), null);
    const why = task.conversationIds.length === 0 && task.laneIds.length === 0
      ? "never started"
      : `its last agent ended${ended ? ` ${age(now - Date.parse(ended))} ago` : ""}`;
    idle.push(row(`task ${task.id} [assigned] ${title(task.title)}, idle ${age(now - Date.parse(task.updatedAt))}: ${why}`));
  }
  idle.push(...queued);

  /* 7. Open pull requests no lane here carries. */
  const orphanRequests = (pullRequests ?? [])
    .filter((request) => !facts.laneBranches.has(request.headRefName))
    .map((request) => row(`pull request #${request.number} ${title(request.title)}, updated ${since(now, request.updatedAt ?? request.createdAt) ?? "unknown"} ago`));

  const github = githubLines(facts.github, now);
  const waiting = [...(facts.needsYou?.rows ?? [])].sort((a,b) => Number(b.stale) - Number(a.stale)).map(item => {
    const subject = item.subject.reviewId ?? item.subject.pipelineId ?? item.subject.reportSeq ?? item.subject.conversationId ?? item.subject.decisionId ?? item.id;
    const evidence = item.evidence.slice(0,2).map(e => typeof e === "string" ? e : `${e.code}: ${e.detail}`).join("; ") || "no evidence";
    return row(`${item.kind} ${subject}${item.taskId ? ` on task ${item.taskId}` : ""} ${title(item.title)}${item.since ? `, ${age(now - Date.parse(item.since))}` : ""}: ${evidence}`);
  });
  const counts: BoardReportCounts = {
    waiting: facts.needsYou?.count ?? 0,
    waitingStale: facts.needsYou?.staleCount ?? 0,
    decisions: decisions.length,
    ready: ready.length,
    stuck: stuck.length,
    running: running.length,
    idle: idle.length,
    close: close.length,
    pullRequests: orphanRequests.length,
    suggestions: github.suggestions.length,
  };
  const empty = Object.entries(counts).every(([key, value]) => key === "suggestions" || value === 0)
    && facts.github.kind === "not-configured" && facts.needsYou !== null;

  /* ── header ── */
  const tasks = facts.tasks;
  const countOf = (status: string) => tasks.filter((task) => task.status === status).length;
  const agentsLine = facts.agents === null
    ? "agents unavailable"
    : `${live.size} agents live, ${agents.filter((agent) => agent.lifecycle === "stalled").length} stalled`;
  const pullRequestCount = facts.pullRequests === null
    ? null
    : facts.pullRequests.ok ? `${facts.pullRequests.pullRequests.length} open pull requests` : "open pull requests unavailable";
  const tick = facts.tick === null
    ? "unavailable"
    : facts.tick.enabled
      ? `on, every ${facts.tick.wakeIntervalMinutes} min`
      : `off${facts.tick.changedAt ? ` since ${facts.tick.changedAt.slice(0, 10)}` : ""}${facts.tick.reason ? `: "${clip(facts.tick.reason, REASON_LIMIT)}"` : ""}`;
  const gaps = facts.gaps.length ? facts.gaps.map((gap) => `${gap.source}: ${gap.reason}`).join("; ") : "none";
  const notices = tasks.filter((task) => task.noticeRef && !task.hiddenByOperator).map((task) => title(task.title));
  const header = [
    `[Delegatus] Board maintenance report — ${facts.projectName}, seat epoch ${facts.seatEpoch}, as of ${utcMinute(now)} UTC`,
    "Read-only: computed by Delegatus from the board, lanes, agent liveness and GitHub at that time. Nothing was changed. Verify each item before you act on it.",
    redactMonitorText(`Seat tick: ${tick}. Evidence unavailable: ${gaps}.`),
    `Counts: ${tasks.length} open tasks (${countOf("assigned")} assigned, ${countOf("blocked")} blocked, ${countOf("inbox")} inbox), ${openLanes.length} open lanes, ${[pullRequestCount, agentsLine].filter(Boolean).join(", ")}.`,
    redactMonitorText(`Notices on the board: ${notices.length ? `${notices.slice(0, NOTICE_TITLE_CAP).join(", ")}${notices.length > NOTICE_TITLE_CAP ? ` (${notices.length - NOTICE_TITLE_CAP} more)` : ""}` : "none"}.`),
  ];

  const sections: Record<string, Section> = {
    decisions: { heading: "1. Decisions waiting on the operator", rows: decisions, cap: CAPS.decisions, optional: false },
    ready: { heading: "2. Ready to finish", rows: ready, cap: CAPS.ready, optional: false },
    stuck: { heading: "3. Stuck", rows: stuck, cap: CAPS.stuck, optional: false, note: facts.agents === null ? "agent liveness unavailable, so only failed lanes are listed" : null },
    running: { heading: "4. Running", rows: running, cap: CAPS.running, optional: false },
    idle: { heading: "5. Tasks with nothing running", rows: idle, cap: CAPS.idle, optional: false },
    close: {
      heading: "6. Close candidates",
      rows: close,
      cap: CAPS.close,
      optional: hiddenGroups === 0,
      footer: hiddenGroups ? `(${hiddenGroups} task groups hidden by the operator are not listed.)` : null,
    },
    waiting: { heading: "9. Waiting for you", rows: waiting, cap: 10, optional: false, note: facts.needsYou === null ? `unavailable (${facts.gaps.find(g => g.source === "needs-you")?.reason ?? "unreadable"})` : null },
    pullRequests: { heading: "7. Open pull requests no lane here carries", rows: orphanRequests, cap: CAPS.pullRequests, optional: true },
  };
  /* Rows each section shows; the byte bound cuts them in the §6 order. */
  const shown: Record<string, number> = Object.fromEntries(Object.entries(sections).map(([key, section]) => [key, Math.min(section.rows.length, section.cap)]));
  let showNext = true;

  const renderSection = (key: string): string[] => {
    const section = sections[key]!;
    if (key === "waiting" && facts.needsYou === null) return [`9. Waiting for you: ${section.note}.`];
    const note = section.note ? ` (${section.note})` : "";
    if (!section.rows.length) {
      if (section.optional) return [];
      return [`${section.heading}: none${note}.`, ...(section.footer ? [section.footer] : [])];
    }
    const count = shown[key]!;
    const more = (key === "waiting" ? counts.waiting : section.rows.length) - count;
    const label = key === "waiting" ? `9. Waiting for you (${counts.waiting}; ${counts.waitingStale} with evidence they no longer ask) — the operator's «Чекають на вас» for this project. Read again with dismiss_attention (no target) before clearing; each row carries its target.` : key === "close"
      ? `${section.heading} (${section.rows.length}), each with the rule that matched`
      : `${section.heading} (${section.rows.length})${note}`;
    return [label, ...section.rows.slice(0, count), ...(more > 0 ? [`(${more} more)`] : []), ...(section.footer ? [section.footer] : [])];
  };
  const render = (): string => {
    const body = ["decisions", "ready", "stuck", "running", "idle", "close", "pullRequests"].flatMap(renderSection);
    const githubBlock = [
      github.heading,
      ...github.lead,
      ...(github.suggestionHeading ? [github.suggestionHeading, ...github.suggestions] : []),
      ...(showNext && github.next ? [github.next] : []),
      ...(github.newest ? [github.newest] : []),
    ];
    return [...header, "", ...body, ...githubBlock, ...renderSection("waiting")].join("\n");
  };

  let text = render();
  /* Over the bound: cut rows from the bottom of 4, 7, 6, then 8's "next", then
     5. Sections 1 to 3 fit in about 3 500 bytes of ASCII, but the title and
     line limits count characters and Cyrillic takes two bytes each, so after
     those 3, 2 and 1 are cut down to one row each, then to none. Every cut
     section keeps its heading and "(k more)", so each heading and the GitHub
     block stay; the hard cut below is left to the header alone. */
  const order: [string | "next", number][] = [
    ["running", 0], ["pullRequests", 0], ["close", 0], ["next", 0], ["idle", 0], ["waiting", 3],
    ["stuck", 1], ["ready", 1], ["decisions", 1],
    ["waiting", 0], ["stuck", 0], ["ready", 0], ["decisions", 0],
  ];
  for (const [key, floor] of order) {
    while (Buffer.byteLength(text, "utf8") > BOARD_REPORT_CAP_BYTES) {
      if (key === "next") {
        if (!showNext) break;
        showNext = false;
      } else {
        if (shown[key]! <= floor) break;
        shown[key] = shown[key]! - 1;
      }
      text = render();
    }
  }
  if (Buffer.byteLength(text, "utf8") > BOARD_REPORT_CAP_BYTES) {
    text = `${withinBytes(text, BOARD_REPORT_CAP_BYTES - 4)}\n…`;
  }
  return { text, bytes: Buffer.byteLength(text, "utf8"), empty, counts };
}
