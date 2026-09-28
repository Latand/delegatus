import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

/* docs/design/board-maintenance-report.md §5, §10. Every port that would read
   the board, run `gh` or deliver is injected; the claim row is the real store,
   in a throw-away state directory. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-report-"));
const RESTORE = { LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const { boardReportMessageId, readBoardReportGithub, reportLaneFrom, reportTaskFrom, runBoardReport, BOARD_REPORT_ORIGIN_ROLE } = await import("./boardReportRun");
const { claimBoardReport, readBoardReportRecord, settleBoardReport } = await import("./boardReportStore");
type Ports = import("./boardReportRun").BoardReportRunPorts;
type Facts = import("./boardReport").BoardReportFacts;
type Delivery = import("./boardReportRun").BoardReportDelivery;

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (RESTORE.LLV_STATE_DIR === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = RESTORE.LLV_STATE_DIR;
});

const NOW = Date.parse("2026-09-27T20:00:00.000Z");
const SEAT = { project: "project-a", seatEpoch: 16, conversationId: "conversation_seat-16", path: "/tmp/seat-16.jsonl" };
let project = 0;
let seat = SEAT;
beforeEach(() => {
  project += 1;
  seat = { ...SEAT, project: `project-${project}` };
});

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    projectName: seat.project,
    seatEpoch: seat.seatEpoch,
    seatConversationId: seat.conversationId,
    now: NOW,
    tick: { enabled: true, wakeIntervalMinutes: 60, reason: null, changedAt: null },
    lanes: [],
    tasks: [{
      id: "task-1", status: "blocked", title: "Blocked work", searchText: "Blocked work", createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-27T10:00:00.000Z", placeholder: false, hiddenByOperator: false, laneIds: [], conversationIds: [], noticeRef: null,
    }],
    agents: [],
    revokedSeats: new Set(),
    agentStarted: new Set(),
    pullRequests: null,
    laneBranches: new Set(),
    github: { kind: "not-configured" },
    gaps: [],
    ...overrides,
  };
}

function ports(overrides: Partial<Ports> = {}): { ports: Ports; sent: Delivery[] } {
  const sent: Delivery[] = [];
  return {
    sent,
    ports: {
      now: () => NOW,
      claim: claimBoardReport,
      settle: settleBoardReport,
      activeSeat: () => ({ seatEpoch: seat.seatEpoch, conversationId: seat.conversationId }),
      facts: async () => facts(),
      deliver: async (request) => {
        sent.push(request);
        return { ok: true, outcome: "queued" };
      },
      ...overrides,
    },
  };
}

test("the report is queued behind the running turn, from Delegatus, under the epoch's own key", async () => {
  const run = ports();
  const record = await runBoardReport(seat, run.ports);

  expect(run.sent).toHaveLength(1);
  const [request] = run.sent;
  expect(request!.policy).toBe("queue");
  expect(request!.origin).toMatchObject({ kind: "agent", role: BOARD_REPORT_ORIGIN_ROLE });
  expect(request!.clientMessageId).toBe(boardReportMessageId(seat.project, seat.seatEpoch));
  expect(request!.clientMessageId).toMatch(/^board_report_[0-9a-f]{40}$/);
  expect(request!).toMatchObject({ conversationId: seat.conversationId, path: seat.path, images: [] });
  expect(request!.text).toStartWith(`[Delegatus] Board maintenance report — ${seat.project}, seat epoch 16`);
  expect(record).toMatchObject({ outcome: "sent", detail: "queued", sentAt: new Date(NOW).toISOString() });
  expect(readBoardReportRecord(seat.project)).toMatchObject({ seatEpoch: 16, outcome: "sent", counts: { idle: 1 } });
  /* Another epoch is another message; the same epoch is the same one. */
  expect(boardReportMessageId(seat.project, 17)).not.toBe(request!.clientMessageId);
});

test("the claim makes a second activation of the same epoch a no-op, and a newer epoch runs again", async () => {
  const run = ports();
  expect(await runBoardReport(seat, run.ports)).not.toBeNull();
  expect(await runBoardReport(seat, run.ports)).toBeNull();
  expect(run.sent).toHaveLength(1);
  /* An older epoch never overwrites a newer claim. */
  expect(await runBoardReport({ ...seat, seatEpoch: 15 }, run.ports)).toBeNull();
  const next = { ...seat, seatEpoch: 17, conversationId: "conversation_seat-17" };
  seat = next;
  expect(await runBoardReport(next, run.ports)).toMatchObject({ outcome: "sent" });
  expect(run.sent).toHaveLength(2);
  expect(readBoardReportRecord(next.project)).toMatchObject({ seatEpoch: 17, conversationId: "conversation_seat-17" });
});

test("an epoch that moved before the send records superseded and sends nothing", async () => {
  const run = ports({ activeSeat: () => ({ seatEpoch: seat.seatEpoch + 1, conversationId: "conversation_seat-next" }) });
  expect(await runBoardReport(seat, run.ports)).toMatchObject({ outcome: "superseded" });
  expect(run.sent).toEqual([]);
  expect(readBoardReportRecord(seat.project)).toMatchObject({ outcome: "superseded", sentAt: null });

  const noSeat = ports({ activeSeat: () => null });
  seat = { ...seat, project: `${seat.project}-gone` };
  expect(await runBoardReport(seat, noSeat.ports)).toMatchObject({ outcome: "superseded" });
  expect(noSeat.sent).toEqual([]);
});

test("an empty board with GitHub absent records empty and sends nothing", async () => {
  const run = ports({ facts: async () => facts({ tasks: [] }) });
  expect(await runBoardReport(seat, run.ports)).toMatchObject({ outcome: "empty" });
  expect(run.sent).toEqual([]);
});

test("a refused or throwing send records failed with its reason and never throws", async () => {
  const refused = ports({ deliver: async () => ({ ok: false, error: "conversation is superseded" }) });
  expect(await runBoardReport(seat, refused.ports)).toMatchObject({ outcome: "failed", detail: "conversation is superseded" });
  seat = { ...seat, project: `${seat.project}-throws` };
  const throwing = ports({ deliver: async () => { throw new Error("runtime host unreachable"); } });
  expect(await runBoardReport(seat, throwing.ports)).toMatchObject({ outcome: "failed", detail: "runtime host unreachable" });
});

test("a gather that throws records failed on the claimed epoch and sends nothing", async () => {
  const run = ports({ facts: async () => { throw new Error("tasks are busy"); } });
  expect(await runBoardReport(seat, run.ports)).toMatchObject({ outcome: "failed", detail: "gather failed: tasks are busy" });
  expect(run.sent).toEqual([]);
  expect(readBoardReportRecord(seat.project)).toMatchObject({ seatEpoch: 16, outcome: "failed" });
});

test("the gaps a gather recorded are kept on the record", async () => {
  const run = ports({ facts: async () => facts({ gaps: [{ source: "pull requests", reason: "timed-out" }] }) });
  expect(await runBoardReport(seat, run.ports)).toMatchObject({ outcome: "sent", gaps: ["pull requests: timed-out"] });
  expect(run.sent[0]!.text).toContain("Evidence unavailable: pull requests: timed-out.");
});

test("a lane and a task read off the stores the way the report needs them", () => {
  const pipeline = {
    id: "lane-1", task: "Build the report", state: "running", pausedState: null, closedAt: null, hiddenAt: null, dismissedAt: null,
    stateDetail: null, cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    runs: [{ stageId: "build", attempts: [
      { n: 1, state: "failed", startedAt: "2026-09-27T19:00:00.000Z", completedAt: "2026-09-27T19:10:00.000Z", error: "spawn failed\nstack" },
    ] }],
    stages: [], createdAt: "2026-09-27T18:00:00.000Z", branch: "pipeline/lane-1", taskIds: ["task-1"], lastPassedCommit: "",
  } as unknown as Pipeline;
  expect(reportLaneFrom(pipeline)).toMatchObject({
    open: true, completed: false, stageId: "build", attempt: 1, failure: { stageId: "build", reason: "spawn failed" },
    movedAt: "2026-09-27T19:10:00.000Z", merge: null,
  });
  expect(reportLaneFrom({ ...pipeline, state: "completed", closedAt: "2026-09-27T19:20:00.000Z" } as Pipeline)).toMatchObject({ open: false, completed: true, failure: null });

  const task = {
    id: "task-1", project: "project-a", status: "assigned", text: "Title line\nmore", details: "see #42", placement: "unplaced",
    assignments: [{ conversationId: "conversation_a", path: null, panePid: null, state: "delivered", error: null, at: "" }, { conversationId: "conversation_a", path: null, panePid: null, state: "linked", error: null, at: "" }],
    origin: { kind: "launch", key: "k", refinement: "pending" }, groupHidden: { at: "2026-09-27T00:00:00.000Z", by: "operator" },
    createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", pipelineIds: ["lane-1"],
  } as unknown as BoardTask & { pipelineIds: string[] };
  expect(reportTaskFrom(task)).toMatchObject({
    title: "Title line", placeholder: true, hiddenByOperator: true, laneIds: ["lane-1"], conversationIds: ["conversation_a"], noticeRef: null,
  });
  expect(reportTaskFrom(task)!.searchText).toContain("#42");
  expect(reportTaskFrom({ ...task, text: "Notice\nmonitor-ref: seat-tick-off" })!.noticeRef).toBe("seat-tick-off");
  expect(reportTaskFrom({ ...task, status: "done" })).toBeNull();
});

/* §10: GitHub is read only when the project's origin is on github.com, and
   that check is what keeps `gh` from running at all without it. */
test("gh runs only for a root whose origin is on github.com", async () => {
  const checkout = (name: string, origin: string | null) => {
    const root = path.join(SANDBOX, name);
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config"), `[core]\n\tbare = false\n${origin ? `[remote "origin"]\n\turl = ${origin}\n` : ""}`);
    return root;
  };
  const calls: string[][] = [];
  const runnerRoots: string[] = [];
  const read = (root: string | null) => readBoardReportGithub({
    root,
    onBoard: new Set(),
    deadlineMs: Date.now() + 5_000,
    clock: () => Date.now(),
    runnerFor: (at) => {
      runnerRoots.push(at);
      return async (args) => {
        calls.push(args);
        return args[0] === "pr"
          ? "[]"
          : JSON.stringify({ data: { repository: { labels: { nodes: [] }, issues: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
      };
    },
  });

  for (const root of [
    null,
    path.join(SANDBOX, "no-such-checkout"),
    checkout("no-origin", null),
    checkout("gitlab-origin", "https://gitlab.com/owner-a/repo-a.git"),
    checkout("self-hosted-origin", "https://git.example.invalid/owner-a/repo-a.git"),
  ]) {
    expect(await read(root)).toEqual({ pullRequests: null, github: { kind: "not-configured" }, gaps: [] });
  }
  expect(runnerRoots).toEqual([]);
  expect(calls).toEqual([]);

  /* The same port, on a github.com origin, is what runs `gh`. */
  const onGithub = checkout("github-origin", "https://github.com/owner-a/repo-a.git");
  const answer = await read(onGithub);
  expect(runnerRoots).toEqual([onGithub]);
  expect(calls.map((args) => args[0]).sort()).toEqual(["api", "pr"]);
  expect(answer.pullRequests).toEqual({ ok: true, pullRequests: [] });
  expect(answer.github.kind).toBe("ranked");
});
