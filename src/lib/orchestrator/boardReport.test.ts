import { expect, test } from "bun:test";

import { rankOpenIssues, type OpenIssueRow } from "@/lib/monitor/githubEvidence";

import {
  BOARD_REPORT_CAP_BYTES,
  composeBoardReport,
  issueNumbersOnBoard,
  type BoardReportFacts,
  type ReportAgent,
  type ReportLane,
  type ReportTask,
} from "./boardReport";

/* docs/design/board-maintenance-report.md §3, §6, §10. Pure: every fact is
   handed in, so nothing here reads state, runs `gh` or delivers anything. */

const NOW = Date.parse("2026-09-27T20:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const SEAT = "conversation_seat-current";
const REVOKED = "conversation_seat-revoked";
const OPERATOR = "conversation_operator-own";
const WORKER = "conversation_worker-spawned";

function lane(id: string, overrides: Partial<ReportLane> = {}): ReportLane {
  return {
    id,
    title: `Lane ${id}`,
    state: "running",
    pausedState: null,
    open: true,
    completed: false,
    stageId: "build",
    attempt: 1,
    attemptStartedAt: minutesAgo(15),
    failure: null,
    question: null,
    reviewStageId: null,
    lastFixUnreviewed: false,
    createdAt: minutesAgo(30),
    movedAt: minutesAgo(15),
    branch: `pipeline/${id}`,
    taskIds: [],
    merge: null,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<ReportTask> = {}): ReportTask {
  return {
    id,
    status: "assigned",
    title: `Task ${id}`,
    searchText: `Task ${id}`,
    createdAt: minutesAgo(60 * 48),
    updatedAt: minutesAgo(60),
    placeholder: false,
    hiddenByOperator: false,
    laneIds: [],
    conversationIds: [],
    noticeRef: null,
    ...overrides,
  };
}

function agent(overrides: Partial<ReportAgent> = {}): ReportAgent {
  return {
    conversationId: WORKER,
    title: "worker",
    lifecycle: "running",
    reason: "host_alive_turn_active",
    hostAlive: true,
    silentForMs: 60_000,
    laneId: null,
    stageId: null,
    lastWords: null,
    spawnedBy: null,
    ...overrides,
  };
}

function facts(overrides: Partial<BoardReportFacts> = {}): BoardReportFacts {
  return {
    projectName: "project-a",
    seatEpoch: 16,
    seatConversationId: SEAT,
    now: NOW,
    tick: { enabled: true, wakeIntervalMinutes: 60, reason: null, changedAt: null },
    lanes: [],
    tasks: [],
    agents: [],
    revokedSeats: new Set([REVOKED]),
    agentStarted: new Set([WORKER]),
    pullRequests: null,
    laneBranches: new Set(),
    github: { kind: "not-configured" },
    gaps: [],
    ...overrides,
  };
}

const openPr = (number: number, headRefName: string, title = `PR ${number}`) => ({
  number, title, headRefName, createdAt: minutesAgo(25), updatedAt: minutesAgo(4),
});

function issue(number: number, overrides: Partial<OpenIssueRow> = {}): OpenIssueRow {
  return {
    number,
    title: `Issue ${number}`,
    createdAt: "2026-07-15T10:00:00Z",
    updatedAt: "2026-07-15T10:00:00Z",
    labels: [],
    milestone: null,
    openBlockers: 0,
    closingPullRequests: 0,
    projectFields: {},
    ...overrides,
  };
}

const lines = (text: string) => text.split("\n");

test("the §6 example: a finished lane's open pull request, running lanes, close candidates and label-ranked issues", () => {
  const finished = lane("f6cdfe4e", { title: "MCP launcher follows the installed self-update release", state: "completed", open: false, completed: true, taskIds: ["task-launcher"], createdAt: minutesAgo(120), movedAt: minutesAgo(40), branch: "pipeline/launcher-f6cdfe4e" });
  const newer = lane("8fe84695", { title: "MCP launcher follows the installed self-update release (on current main)", taskIds: ["task-launcher"], createdAt: minutesAgo(20) });
  const design = lane("d774ba3f", { title: "Design: board maintenance report", stageId: "design", attemptStartedAt: minutesAgo(12) });
  const ranking = rankOpenIssues([
    issue(300, { labels: ["priority: urgent"] }),
    issue(302, { labels: ["priority: urgent"] }),
    issue(2261, { updatedAt: "2026-09-27T19:00:00Z" }),
    issue(2259, { updatedAt: "2026-09-27T18:00:00Z" }),
    issue(2257, { updatedAt: "2026-09-27T17:00:00Z" }),
  ], { totalCount: 298, onBoard: new Set() });
  const report = composeBoardReport(facts({
    tick: { enabled: false, wakeIntervalMinutes: 60, reason: "1", changedAt: "2026-09-26T08:00:00.000Z" },
    lanes: [finished, newer, design],
    tasks: [
      task("task-launcher", { laneIds: ["f6cdfe4e", "8fe84695"], conversationIds: [WORKER] }),
      task("task-seat-1", { title: "Manager seat for project-a (rotation)", conversationIds: [REVOKED] }),
      task("task-own", { title: "The current seat's own card", conversationIds: [SEAT] }),
      task("task-reviewer", { title: "You are the reviewer in an implement-review loop", placeholder: true, updatedAt: minutesAgo(27 * 60), conversationIds: [WORKER] }),
      task("task-notice", { status: "inbox", title: "This project's seat tick is not on its default settings", noticeRef: "seat-tick-settings" }),
    ],
    agents: [agent({ conversationId: "conversation_build", laneId: "8fe84695", stageId: "build" }), agent({ conversationId: "conversation_design", laneId: "d774ba3f", stageId: "design" })],
    pullRequests: { ok: true, pullRequests: [openPr(2258, "pipeline/launcher-f6cdfe4e", "MCP launcher follows the installed self-update release"), openPr(2270, "feature/activity-count")] },
    laneBranches: new Set(["pipeline/launcher-f6cdfe4e", "pipeline/8fe84695", "pipeline/d774ba3f"]),
    github: { kind: "ranked", ranking },
  }));
  const text = report.text;

  expect(lines(text)[0]).toBe("[Delegatus] Board maintenance report — project-a, seat epoch 16, as of 2026-09-27 20:00 UTC");
  expect(text).toContain("Read-only: computed by Delegatus from the board, lanes, agent liveness and GitHub at that time. Nothing was changed. Verify each item before you act on it.");
  expect(text).toContain('Seat tick: off since 2026-09-26: "1". Evidence unavailable: none.');
  expect(text).toContain("Counts: 5 open tasks (4 assigned, 0 blocked, 1 inbox), 2 open lanes, 2 open pull requests, 2 agents live, 0 stalled.");
  expect(text).toContain("Notices on the board: «This project's seat tick is not on its default settings».");
  expect(text).toContain("1. Decisions waiting on the operator: none.");
  expect(text).toContain("- lane f6cdfe4e «MCP launcher follows the installed self-update release» completed 40 min ago, pull request #2258 open; merge not queued; its task has a newer lane 8fe84695 running");
  expect(text).toContain("3. Stuck: none.");
  expect(text).toContain("- lane d774ba3f «Design: board maintenance report» at design, attempt 1, 12 min");
  expect(text).toContain("5. Tasks with nothing running: none.");
  expect(text).toContain("6. Close candidates (3), each with the rule that matched");
  expect(text).toContain("- task task-seat-1 [assigned] «Manager seat for project-a (rotation)»: seat-card, held only by a revoked seat");
  expect(text).toContain("- task task-reviewer [assigned] «You are the reviewer in an implement-review loop»: placeholder, no lane, no live agent, idle 27 h");
  expect(text).toContain("- pull request #2258 «MCP launcher follows the installed self-update release»: superseded-pr, lane f6cdfe4e finished and lane 8fe84695 is running on the same task");
  /* The current seat's own card is never a candidate. */
  expect(text).not.toContain("task-own");
  expect(text).toContain("7. Open pull requests no lane here carries (1)\n- pull request #2270 «PR 2270», updated 4 min ago");
  expect(text).toContain("8. GitHub issues (298 open)\nRanked by priority label. No recorded priority on 3 of the 5 most recently updated (read: Project Priority and Urgency fields, priority labels, milestones).");
  expect(text).toContain("Worth starting now:\n- #300 «Issue 300» — label priority: urgent · no status · open 74 days, never updated\n- #302 «Issue 302» — label priority: urgent · no status · open 74 days, never updated");
  expect(text).toContain("Newest without a recorded priority: #2261, #2259, #2257.");
  expect(report.empty).toBe(false);
  expect(report.bytes).toBeLessThanOrEqual(BOARD_REPORT_CAP_BYTES);
});

test("sections 1 to 3: decisions, permission requests, review budgets, merged work, stalls with last words and failures", () => {
  const report = composeBoardReport(facts({
    lanes: [
      lane("dec1", { state: "needs_decision", question: "Which schema should the migration keep?", stageId: "design", movedAt: minutesAgo(50) }),
      lane("rev1", { state: "needs_review", reviewStageId: "review" }),
      lane("fail1", { failure: { stageId: "build", reason: "spawn failed: no account had capacity" } }),
      lane("stall1", { stageId: "build" }),
      lane("done1", { state: "completed", open: false, completed: true, merge: { state: "merged", prNumber: 91, mergedAt: minutesAgo(180) }, taskIds: ["task-merged"] }),
    ],
    tasks: [task("task-merged", { laneIds: ["done1"], conversationIds: [WORKER] })],
    agents: [
      agent({ conversationId: "conversation_perm", reason: "permission_request", lifecycle: "stalled", laneId: "dec1", stageId: "design", silentForMs: 5 * 60_000 }),
      agent({ conversationId: "conversation_stall", lifecycle: "stalled", reason: "host_alive_transcript_silent", laneId: "stall1", stageId: "build", silentForMs: 50 * 60_000, lastWords: "Running the whole suite now, this may take a while" }),
      agent({ conversationId: "conversation_child", title: "helper", lifecycle: "stalled", reason: "host_gone_turn_open", hostAlive: false, silentForMs: 3 * 60 * 60_000, spawnedBy: "this seat" }),
    ],
  }));
  const text = report.text;
  expect(text).toContain("1. Decisions waiting on the operator (2)\n- lane dec1 «Lane dec1» needs_decision at design for 50 min: Which schema should the migration keep?");
  expect(text).toContain("- permission request in lane dec1 stage design, waiting 5 min");
  expect(text).toContain("- lane rev1 «Lane rev1» needs_review: review budget spent at review");
  expect(text).toContain("- task task-merged [assigned] «Task task-merged»: every lane completed, pull request #91 merged 3 h ago");
  expect(text).toContain("- lane stall1 stage build: agent silent 50 min, host alive; last words: «Running the whole suite now, this may take a while»");
  expect(text).toContain("- conversation conversation_child «helper», spawned by this seat: stalled 3 h");
  expect(text).toContain("- lane fail1 «Lane fail1» failed at build: spawn failed: no account had capacity");
  /* A lane listed as stuck or waiting is not also listed as running. */
  expect(text).toContain("4. Running: none.");
  expect(report.counts).toMatchObject({ decisions: 2, ready: 2, stuck: 3, running: 0 });
});

test("section 5: an assigned task nothing started, one whose agent ended, a blocked task and queued inbox work", () => {
  const report = composeBoardReport(facts({
    lanes: [lane("old", { state: "completed", open: false, completed: true, movedAt: minutesAgo(300) }), lane("live")],
    tasks: [
      task("queued", { status: "inbox", createdAt: minutesAgo(90) }),
      task("never", { updatedAt: minutesAgo(120) }),
      task("ended", { laneIds: ["old", "missing"], updatedAt: minutesAgo(200) }),
      task("blocked", { status: "blocked", updatedAt: minutesAgo(60 * 30) }),
      task("busy", { laneIds: ["live"] }),
      task("inbox-busy", { status: "inbox", laneIds: ["live"] }),
      task("inbox-notice", { status: "inbox", title: "A Delegatus notice", noticeRef: "ref-notice" }),
    ],
  }));
  expect(report.text).toContain("5. Tasks with nothing running (4)");
  expect(report.text).toContain("- task never [assigned] «Task never», idle 2 h: never started");
  expect(report.text).toContain("- task ended [assigned] «Task ended», idle 3 h: its last agent ended 5 h ago");
  expect(report.text).toContain("- task blocked [blocked] «Task blocked», blocked 30 h");
  /* Inbox work follows the assigned and blocked rows, so the byte bound cuts it first. */
  expect(report.text).toContain("- task blocked [blocked] «Task blocked», blocked 30 h\n- task queued [inbox] «Task queued», waiting 1 h");
  expect(report.text).not.toContain("task busy");
  expect(report.text).not.toContain("task inbox-busy");
  /* A notice card is named on the Notices line and nowhere else. */
  expect(report.text).toContain("Notices on the board: «A Delegatus notice».");
  expect(report.text).not.toContain("task inbox-notice");
  expect(report.text.split("A Delegatus notice").length - 1).toBe(1);
});

test("each close rule fires on its evidence and holds back without it", () => {
  const completed = (id: string, overrides: Partial<ReportLane> = {}) => lane(id, { state: "completed", open: false, completed: true, ...overrides });
  const report = composeBoardReport(facts({
    lanes: [
      completed("fin-a", { branch: "pipeline/fin-a" }),
      completed("fin-b", { branch: "pipeline/fin-b" }),
      lane("fin-c-open"),
      completed("sup-old", { taskIds: ["t-sup"], createdAt: minutesAgo(100), branch: "pipeline/sup-old" }),
      completed("nosup", { taskIds: ["t-nosup"], branch: "pipeline/nosup" }),
    ],
    tasks: [
      /* seat-card: every holder a revoked seat; a live worker beside it holds it back. */
      task("t-seat", { conversationIds: [REVOKED] }),
      task("t-seat-shared", { conversationIds: [REVOKED, WORKER] }),
      /* placeholder: idle over a day with nothing running; younger or running is held back. */
      task("t-ph", { placeholder: true, updatedAt: minutesAgo(26 * 60), conversationIds: [WORKER] }),
      task("t-ph-young", { placeholder: true, updatedAt: minutesAgo(60), conversationIds: [WORKER] }),
      task("t-ph-running", { placeholder: true, updatedAt: minutesAgo(26 * 60), laneIds: ["fin-c-open"] }),
      /* finished: every lane completed and none left a pull request open. */
      task("t-fin", { laneIds: ["fin-a"], conversationIds: [WORKER] }),
      task("t-fin-pr", { laneIds: ["fin-b"], conversationIds: [WORKER] }),
      task("t-fin-open", { laneIds: ["fin-a", "fin-c-open"], conversationIds: [WORKER] }),
      /* superseded-pr: a newer lane runs on the same task; none on another. */
      task("t-sup", { laneIds: ["sup-old", "sup-new"], conversationIds: [WORKER] }),
      task("t-nosup", { laneIds: ["nosup"], conversationIds: [WORKER] }),
      /* duplicate-notice: the older of two cards with one monitor reference. */
      task("t-notice-old", { status: "inbox", noticeRef: "ref-1", createdAt: minutesAgo(600) }),
      task("t-notice-new", { status: "inbox", noticeRef: "ref-1", createdAt: minutesAgo(60) }),
      task("t-notice-lone", { status: "inbox", noticeRef: "ref-2" }),
    ],
    agents: [agent({ conversationId: WORKER })].filter(() => false),
    pullRequests: { ok: true, pullRequests: [openPr(501, "pipeline/fin-b"), openPr(502, "pipeline/sup-old"), openPr(503, "pipeline/nosup")] },
    laneBranches: new Set(["pipeline/fin-a", "pipeline/fin-b", "pipeline/sup-old", "pipeline/nosup"]),
  }));
  const withNewer = composeBoardReport(facts({
    lanes: [lane("sup-old", { state: "completed", open: false, completed: true, taskIds: ["t-sup"], createdAt: minutesAgo(100), branch: "pipeline/sup-old" }), lane("sup-new", { taskIds: ["t-sup"], createdAt: minutesAgo(10) })],
    tasks: [task("t-sup", { laneIds: ["sup-old", "sup-new"], conversationIds: [WORKER] })],
    pullRequests: { ok: true, pullRequests: [openPr(502, "pipeline/sup-old")] },
    laneBranches: new Set(["pipeline/sup-old", "pipeline/sup-new"]),
  }));
  const text = report.text;
  expect(text).toContain("- task t-seat [assigned] «Task t-seat»: seat-card, held only by a revoked seat");
  expect(text).not.toMatch(/t-seat-shared.*seat-card/);
  expect(text).toContain("- task t-ph [assigned] «Task t-ph»: placeholder, no lane, no live agent, idle 26 h");
  expect(text).not.toMatch(/t-ph-young.*placeholder/);
  expect(text).not.toMatch(/t-ph-running.*placeholder/);
  expect(text).toContain("- task t-fin [assigned] «Task t-fin»: finished, every lane completed and no pull request of theirs is open");
  expect(text).not.toMatch(/t-fin-pr.*finished/);
  expect(text).not.toMatch(/t-fin-open.*finished/);
  expect(text).not.toContain("superseded-pr");
  expect(withNewer.text).toContain("- pull request #502 «PR 502»: superseded-pr, lane sup-old finished and lane sup-new is running on the same task");
  expect(text).toContain("- task t-notice-old [inbox] «Task t-notice-old»: duplicate-notice, same notice as newer task t-notice-new");
  expect(text).not.toMatch(/t-notice-new \[inbox\].*duplicate-notice/);
  expect(text).not.toMatch(/t-notice-lone.*duplicate-notice/);
});

test("a candidate held only by the operator's own session says ask first; an agent-started one does not", () => {
  const report = composeBoardReport(facts({
    tasks: [
      task("t-operator", { placeholder: true, updatedAt: minutesAgo(30 * 60), conversationIds: [OPERATOR] }),
      task("t-agent", { placeholder: true, updatedAt: minutesAgo(30 * 60), conversationIds: [WORKER] }),
    ],
  }));
  expect(report.text).toContain("- task t-operator [assigned] «Task t-operator»: placeholder, no lane, no live agent, idle 30 h; operator's own session, ask first");
  expect(report.text).toContain("- task t-agent [assigned] «Task t-agent»: placeholder, no lane, no live agent, idle 30 h\n");
});

test("task groups the operator hid are counted in one line and never listed", () => {
  const report = composeBoardReport(facts({
    tasks: [
      task("hidden-1", { hiddenByOperator: true, placeholder: true, updatedAt: minutesAgo(40 * 60) }),
      task("hidden-2", { hiddenByOperator: true, conversationIds: [REVOKED] }),
      task("shown", { status: "blocked" }),
    ],
  }));
  expect(report.text).toContain("6. Close candidates: none.\n(2 task groups hidden by the operator are not listed.)");
  expect(report.text).not.toContain("hidden-1");
  expect(report.text).not.toContain("hidden-2");
});

test("a board of 150 assigned and 50 inbox tasks stays within 6 000 bytes and keeps sections 1 to 3 whole", () => {
  const lanes = Array.from({ length: 30 }, (_, index) => lane(`run${index}`, { title: `A long running lane title number ${index} that goes on and on for a while` }));
  const tasks = Array.from({ length: 150 }, (_, index) => task(`task-${String(index).padStart(3, "0")}-${"x".repeat(24)}`, {
    title: `An assigned task that nothing started, number ${index}, with a title long enough to be cut`,
    placeholder: index % 3 === 0,
    updatedAt: minutesAgo(index % 3 === 0 ? 30 * 60 : 60),
    conversationIds: index % 3 === 0 ? [WORKER] : [],
  }));
  const inbox = Array.from({ length: 50 }, (_, index) => task(`inbox-${String(index).padStart(3, "0")}-${"y".repeat(24)}`, {
    status: "inbox",
    title: `A queued request nobody started yet, number ${index}, with a title long enough to be cut`,
  }));
  const decisions = Array.from({ length: 8 }, (_, index) => lane(`dec${index}`, { state: "needs_decision", question: "q".repeat(300) }));
  const stalls = Array.from({ length: 8 }, (_, index) => agent({ conversationId: `conversation_s${index}`, lifecycle: "stalled", reason: "host_alive_transcript_silent", laneId: `run${index}`, stageId: "build", lastWords: "w".repeat(400) }));
  const pullRequests = Array.from({ length: 20 }, (_, index) => openPr(1000 + index, `feature/other-${index}`, "p".repeat(120)));
  const ranking = rankOpenIssues(Array.from({ length: 100 }, (_, index) => issue(2000 + index, { labels: index < 20 ? ["P1"] : [], title: "i".repeat(150) })), { totalCount: 300, onBoard: new Set() });
  const report = composeBoardReport(facts({
    lanes: [...lanes, ...decisions],
    tasks: [...tasks, ...inbox],
    agents: stalls,
    pullRequests: { ok: true, pullRequests },
    github: { kind: "ranked", ranking },
  }));
  expect(report.bytes).toBeLessThanOrEqual(BOARD_REPORT_CAP_BYTES);
  expect(Buffer.byteLength(report.text, "utf8")).toBe(report.bytes);
  /* Sections 1 to 3 are never cut: every capped row is still there. */
  const section = (from: string, to: string) => report.text.slice(report.text.indexOf(from), report.text.indexOf(to));
  expect(section("1. Decisions", "2. Ready").split("\n- ").length - 1).toBe(8);
  expect(section("3. Stuck", "4. Running").split("\n- ").length - 1).toBe(8);
  /* The byte bound cut running lanes first: fewer than their row cap of ten
     are shown, and what was cut says so. */
  expect(section("4. Running", "5. Tasks").split("\n- ").length - 1).toBeLessThan(10);
  expect(section("4. Running", "5. Tasks")).toMatch(/\((\d+) more\)/);
  for (const line of lines(report.text)) expect(line.length).toBeLessThanOrEqual(200);
});

/* Titles, questions and last words written in Ukrainian take two bytes a
   character, so the character limits that keep sections 1 to 3 near 3 500
   bytes in ASCII double: those sections are then cut too, each down to its
   heading and "(k more)", and no heading and no GitHub block is lost. */
test("a Cyrillic board stays within 6 000 bytes and keeps every heading and the GitHub block", () => {
  const ukrainian = (words: number) => Array.from({ length: words }, () => "перевірити").join(" ");
  const decisions = Array.from({ length: 12 }, (_, index) => lane(`dec${index}`, { title: `Рішення ${index}: ${ukrainian(10)}`, state: "needs_decision", question: ukrainian(30) }));
  const reviews = Array.from({ length: 12 }, (_, index) => lane(`rev${index}`, { title: `Огляд ${index}: ${ukrainian(10)}`, state: "needs_review", reviewStageId: "review" }));
  const stalls = Array.from({ length: 12 }, (_, index) => agent({ conversationId: `conversation_s${index}`, title: `Агент ${index}: ${ukrainian(10)}`, lifecycle: "stalled", reason: "host_alive_transcript_silent", lastWords: ukrainian(30) }));
  const ranking = rankOpenIssues(Array.from({ length: 10 }, (_, index) => issue(3000 + index, { labels: index < 4 ? ["P1"] : [], title: ukrainian(10) })), { totalCount: 10, onBoard: new Set() });
  const report = composeBoardReport(facts({
    lanes: [...decisions, ...reviews],
    agents: stalls,
    pullRequests: { ok: true, pullRequests: [] },
    github: { kind: "ranked", ranking },
  }));
  expect(report.bytes).toBeLessThanOrEqual(BOARD_REPORT_CAP_BYTES);
  expect(Buffer.byteLength(report.text, "utf8")).toBe(report.bytes);
  /* No hard cut: the GitHub block and the final attention section stay whole. */
  expect(report.text).toContain("Newest without a recorded priority: #3004, #3005, #3006.");
  expect(report.text.endsWith("9. Waiting for you: none.")).toBe(true);
  for (const heading of ["1. Decisions waiting on the operator (", "2. Ready to finish (", "3. Stuck (12)", "4. Running: none.", "5. Tasks with nothing running: none.", "8. GitHub issues (10 open)", "Worth starting now:"]) {
    expect(report.text).toContain(heading);
  }
  const section = (from: string, to: string) => report.text.slice(report.text.indexOf(from), report.text.indexOf(to));
  for (const [from, to] of [["1. Decisions", "2. Ready"], ["2. Ready", "3. Stuck"], ["3. Stuck", "4. Running"]] as const) {
    expect(section(from, to).trimEnd()).toMatch(/\(\d+ more\)$/);
  }
});

test("a source that failed is named in the header and its sections say unavailable", () => {
  const report = composeBoardReport(facts({
    agents: null,
    lanes: [lane("fail1", { failure: { stageId: "build", reason: "boom" } })],
    pullRequests: { ok: false, unavailable: "timed-out" },
    github: { kind: "unavailable", reason: "command-failed" },
    gaps: [{ source: "agent liveness", reason: "timed-out" }, { source: "pull requests", reason: "timed-out" }],
  }));
  expect(report.text).toContain("Evidence unavailable: agent liveness: timed-out; pull requests: timed-out.");
  expect(report.text).toContain("open pull requests unavailable, agents unavailable.");
  expect(report.text).toContain("3. Stuck (1) (agent liveness unavailable, so only failed lanes are listed)");
  expect(report.text).toContain("8. GitHub: unavailable (command-failed).");
});

test("with GitHub absent: an empty board composes to empty, and a busy one says GitHub is not configured and runs no issue lines", () => {
  const empty = composeBoardReport(facts());
  expect(empty.empty).toBe(true);
  /* A notice card alone is not work: nothing is sent. */
  const quiet = composeBoardReport(facts({ tasks: [task("t-notice", { status: "inbox", noticeRef: "ref-notice" })] }));
  expect(quiet.empty).toBe(true);
  /* A board holding only queued inbox work is not empty: the successor is told of it. */
  const queued = composeBoardReport(facts({ tasks: [task("t-inbox", { status: "inbox", title: "Operator's queued request" })] }));
  expect(queued.empty).toBe(false);
  expect(queued.counts.idle).toBe(1);
  expect(queued.text).toContain("5. Tasks with nothing running (1)\n- task t-inbox [inbox] «Operator's queued request», waiting 2 days");
  expect(queued.text).toContain("8. GitHub: not configured for this project.");
  const busy = composeBoardReport(facts({ lanes: [lane("run1")] }));
  expect(busy.empty).toBe(false);
  expect(busy.text).toContain("8. GitHub: not configured for this project.");
  expect(busy.text).not.toContain("pull requests unavailable");
  expect(busy.text).not.toContain("7. Open pull requests");
  expect(busy.text).not.toMatch(/Worth starting|Highest ranked|recorded priority/);
  /* A configured project with nothing on its board still reports its issues. */
  const ranking = rankOpenIssues([issue(5)], { totalCount: 1, onBoard: new Set() });
  expect(composeBoardReport(facts({ github: { kind: "ranked", ranking }, pullRequests: { ok: true, pullRequests: [] } })).empty).toBe(false);
});

test("no recorded priority: one neutral line and the newest three, never a suggestion to label", () => {
  const ranking = rankOpenIssues([
    issue(11, { updatedAt: "2026-09-20T00:00:00Z" }),
    issue(12, { updatedAt: "2026-09-25T00:00:00Z" }),
    issue(13, { updatedAt: "2026-09-22T00:00:00Z" }),
    issue(14, { updatedAt: "2026-09-01T00:00:00Z", labels: ["bug"] }),
  ], { totalCount: 4, onBoard: new Set() });
  const text = composeBoardReport(facts({ github: { kind: "ranked", ranking }, pullRequests: { ok: true, pullRequests: [] } })).text;
  expect(text).toContain("8. GitHub issues (4 open)\nNo recorded priority on 4 of them (read: Project Priority and Urgency fields, priority labels, milestones).\nNewest without a recorded priority: #12, #13, #11.");
  expect(text).not.toMatch(/Worth starting|Highest ranked|Ranked by/);
  expect(text).not.toMatch(/\b(add|adding|apply|applying|consider|should)\b[^\n]*\b(label|labels|field|fields)\b/i);
});

test("nothing at tier 1 or above: the top three are headed Highest ranked with their tier shown", () => {
  const ranking = rankOpenIssues([
    issue(1, { milestone: { title: "M1", dueOn: "2026-10-01T00:00:00Z" } }),
    issue(2, { labels: ["priority: low"] }),
  ], { totalCount: 2, onBoard: new Set() });
  const text = composeBoardReport(facts({ github: { kind: "ranked", ranking }, pullRequests: { ok: true, pullRequests: [] } })).text;
  expect(text).toContain("Highest ranked:\n- #2 «Issue 2» — label priority: low · no status · open 74 days, never updated\n- #1 «Issue 1» — no status · milestone M1 due 2026-10-01");
});

test("issue numbers already on the board: #n in an open task or lane title, or a number segment of a lane's branch", () => {
  const numbers = issueNumbersOnBoard(
    [task("t", { searchText: "Fix #776 and #12\ndetails mention #99" })],
    [lane("a", { title: "Board slice for #2270", branch: "feat/1234-board" }), lane("b", { open: false, completed: true, title: "#5 closed", branch: "fix/55" }), lane("c", { branch: "pipeline/design-423730f0" })],
  );
  expect([...numbers].sort((left, right) => left - right)).toEqual([12, 99, 776, 1234, 2270]);
});


test("Waiting for you lists stale evidence first and keeps the full target ids", () => {
  const row = (id: string, stale: boolean) => ({ id, kind: "prototype" as const, title: id, line: "Choose", since: minutesAgo(60), taskId: "task-a", subject: { reviewId: id }, target: { kind: "prototype" as const, taskId: "task-a", reviewId: id }, stale, evidence: stale ? ["lane-moved-past: The publishing lane moved past this round"] : [] });
  const report = composeBoardReport(facts({ needsYou: { project: "project-a", at: minutesAgo(0), count: 2, staleCount: 1, rows: [row("current-round", false), row("old-round", true)], cleared: [], omittedCount: 0 } }));
  expect(report.text).toContain("9. Waiting for you");
  expect(report.text.indexOf("old-round")).toBeLessThan(report.text.indexOf("current-round"));
  expect(report.text).toContain("lane-moved-past");
  expect(report.counts).toMatchObject({ waiting: 2, waitingStale: 1 });
  expect(report.empty).toBe(false);
  expect(composeBoardReport(facts({ needsYou: null, gaps: [{ source: "needs-you", reason: "timed out" }] })).text).toContain("9. Waiting for you: unavailable (timed out).");
});
