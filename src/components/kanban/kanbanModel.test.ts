import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { buildSchemeLayout, type SchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";

import { buildKanbanModel, cardHasLiveWork, KANBAN_STATUSES, summarizePipeline } from "./kanbanModel";
import { pipelineProgress } from "./PipelineSection";
import { translate, type TFunction } from "@/lib/i18n";

/* Pure projection tests: invented tasks, transcripts and pipelines, a layout
   built the way the scheme builds it, and the real band projection on top. */

const NOW = 1_800_000_000;

function file(index: number, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/conversation-${index}.jsonl`,
    conversationId: `conversation_fixture_${index}`,
    title: `Conversation ${index}`,
    project: "fixture",
    root: "claude-projects",
    kind: "session",
    fmt: "claude",
    engine: "claude",
    mtime: NOW - 600,
    size: 100,
    activity: "idle",
    proc: null,
    pid: null,
    parent: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    name: `conversation-${index}`,
    ...extra,
  } as FileEntry;
}

function task(id: string, status: TaskStatus, paths: readonly string[] = [], extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "fixture",
    text: `Task ${id}\nWhat ${id} is about`,
    status,
    placement: "unplaced",
    assignments: paths.map((path, index) => ({ path, conversationId: path.startsWith("/fixture/conversation-") ? `conversation_fixture_${path.match(/(\d+)/)![1]}` : `conversation_elided_${id}_${index}`, panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: `2026-09-14T10:${String(Number(id.replace(/\D/g, "")) % 60).padStart(2, "0")}:00.000Z`,
    updatedAt: "2026-09-14T10:00:00.000Z",
    ...extra,
  } as BoardTask;
}

function layout(files: readonly FileEntry[]): SchemeLayout {
  const nodes = files.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  return {
    nodes,
    groups: [],
    stacks: [],
    decks: [],
    drafts: [],
    slots: [],
    regionTasks: [],
    edges: [],
    links: [],
    loops: [],
    byPath: new Map(nodes.map((node) => [node.file.path, node])),
    width: files.length * 648,
    height: 880,
  } as unknown as SchemeLayout;
}

function model(tasks: readonly BoardTask[], files: readonly FileEntry[], options: { pipelines?: Pipeline[]; query?: string; overrides?: Map<string, TaskStatus> } = {}) {
  const pipelines = options.pipelines ?? [];
  const projection = projectTaskWorkflows([...tasks], pipelines, [], [...files]);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  return buildKanbanModel({ bands, tasks, pipelines, projection, files, query: options.query, statusOverrides: options.overrides, now: NOW });
}

test("every stored task is a card in exactly one column or counted off the board, at a thousand tasks", () => {
  const files: FileEntry[] = [];
  const tasks: BoardTask[] = [];
  let conversation = 0;
  const statuses: Array<[TaskStatus, number]> = [["done", 420], ["assigned", 300], ["inbox", 180], ["blocked", 100]];
  let n = 0;
  for (const [status, count] of statuses) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      if (status === "assigned") {
        const member = file(conversation++);
        files.push(member);
        /* Every fifth assigned task also names a conversation the scheme window elided. */
        const paths = i % 5 === 0 ? [member.path, `/elided/conversation-${n}.jsonl`] : [member.path];
        tasks.push(task(`t${n}`, status, paths));
      } else if (status === "done" && i < 25) {
        tasks.push(task(`t${n}`, status, [], { board: "hidden" }));
      } else {
        tasks.push(task(`t${n}`, status));
      }
    }
  }
  /* Twelve conversations belong to two tasks; forty run with no task at all. */
  for (let i = 0; i < 12; i += 1) {
    tasks.push(task(`shared${i}`, "blocked", [files[i]!.path]));
  }
  for (let i = 0; i < 40; i += 1) files.push(file(conversation++));

  const started = performance.now();
  const result = model(tasks, files);
  const elapsed = performance.now() - started;

  const placed = new Map<string, TaskStatus>();
  for (const status of KANBAN_STATUSES) {
    for (const card of result.columns[status].cards) {
      expect(card.task).not.toBeNull();
      expect(placed.has(card.task!.id)).toBe(false);
      placed.set(card.task!.id, status);
    }
  }
  const offBoard = new Set(result.offBoard.map((entry) => entry.id));
  for (const entry of tasks) expect(placed.has(entry.id) !== offBoard.has(entry.id)).toBe(true);
  expect(placed.size + offBoard.size).toBe(1012);
  expect(offBoard.size).toBe(25);
  expect(result.columns.done.cards).toHaveLength(395);
  expect(result.columns.assigned.cards).toHaveLength(300);
  expect(result.columns.inbox.cards).toHaveLength(180);
  expect(result.columns.blocked.cards).toHaveLength(112);
  expect(result.totals).toMatchObject({ tasks: 1012, onBoard: 987 });

  /* Each conversation is one member somewhere, plus a mirror where it is shared. */
  const members = new Map<string, number>();
  for (const status of KANBAN_STATUSES) for (const card of result.columns[status].cards) for (const member of card.members) members.set(member.file.path, (members.get(member.file.path) ?? 0) + 1);
  for (const card of result.unlinked) for (const member of card.members) members.set(member.file.path, (members.get(member.file.path) ?? 0) + 1);
  expect(members.size).toBe(340);
  expect([...members.values()].every((count) => count === 1)).toBe(true);
  const mirrors = KANBAN_STATUSES.flatMap((status) => result.columns[status].cards.flatMap((card) => card.mirrors));
  expect(mirrors).toHaveLength(12);
  expect(result.unlinked).toHaveLength(40);

  /* An elided conversation still counts on its card. */
  const withElided = result.columns.assigned.cards.find((card) => card.task!.id === "t421")!;
  expect(withElided.conversations).toBe(2);
  expect(withElided.notLoaded).toBe(1);

  /* Bands plus projection for the whole corpus; the projection alone has its own budget below. */
  expect(elapsed).toBeLessThan(2_000);
});

test("the projection alone stays inside its budget at a thousand tasks", () => {
  const files = Array.from({ length: 300 }, (_, index) => file(index));
  const tasks = Array.from({ length: 1000 }, (_, index) => task(`t${index}`, KANBAN_STATUSES[index % 4]!, index < 300 ? [files[index]!.path] : []));
  const projection = projectTaskWorkflows(tasks, [], [], files);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  buildKanbanModel({ bands, tasks, pipelines: [], projection, now: NOW });
  const started = performance.now();
  buildKanbanModel({ bands, tasks, pipelines: [], projection, now: NOW, query: "task" });
  expect(performance.now() - started).toBeLessThan(160);
});

test("columns sort by agent work, ignore metadata, and put unknown work last with stable ties", () => {
  const files = [file(1, { lastAgentWorkAt: 1000, activity: "live" }), file(2, { lastAgentWorkAt: 2000 }), file(3, { lastAgentWorkAt: 3000 }), file(4)];
  const rows = [task("old", "assigned", [files[0]!.path]), task("recent", "assigned", [files[1]!.path]),
    task("group", "assigned", [files[0]!.path, files[2]!.path]), task("never-b", "assigned", [files[3]!.path]), task("never-a", "assigned")];
  const order = (rows: BoardTask[]) => model(rows, files).columns.assigned.cards.map(card => card.task!.id);
  expect(order(rows)).toEqual(["group", "recent", "old", "never-a", "never-b"]);
  expect(order(rows.map(row => ({ ...row, text: "Renamed", updatedAt: "2099-01-01T00:00:00Z" })))).toEqual(order(rows));
  files[0] = { ...files[0]!, lastAgentWorkAt: 4000 };
  expect(order(rows).slice(0, 2)).toEqual(["group", "old"]);
  expect(model([task("other", "blocked", [files[2]!.path])], files).columns.blocked.cards[0]?.task?.id).toBe("other");
});

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/* A lane with its build stage running, and the attempt that runs it. */
function buildingLane(id: string, taskId: string, attempt: { conversationId?: string | null; agentPath?: string | null; startedAt: string }): Pipeline {
  return {
    id,
    task: `Lane ${id}`,
    project: "fixture",
    state: "running",
    taskIds: [taskId],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    stages: [
      { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: {} },
      { id: "review", kind: "run", prompt: "", next: null, effectiveRole: {} },
    ],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", activatedBy: null, conversationId: null, agentPath: null, launchId: null, sessionId: null, paneId: null, flowId: null, effectiveRole: {}, output: null, verdict: null, error: null, completedAt: null, ...attempt }] }],
    createdAt: iso(NOW - 3600),
  } as unknown as Pipeline;
}

/* The operator's report of 2026-09-24, as the live board had it: in Assigned,
   the card whose build stage was running sat last. The stage's conversation
   was live on its host's own turn evidence, and its row had neither a turn
   boundary nor an agent-work stamp yet, so the card counted no agent work at
   all and fell below a card whose agents had been quiet for minutes. The
   field values are the board's; the ids and titles are invented. */
test("a card whose stage agent is working comes first even while its row carries no agent-work stamp", () => {
  const building = file(301, {
    activity: "live", activityReason: "turn_evidence_working", proc: "running", pid: 4_301, mtime: NOW - 114,
    authoritativeTurn: { state: "unknown", source: "empty", terminalAt: null },
  });
  const maintaining = file(302, {
    activity: "live", activityReason: "turn_evidence_working", proc: "running", pid: 4_302, mtime: NOW - 117,
    authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null }, lastAgentWorkAt: (NOW - 119) * 1000,
  });
  const reviewed = file(303, {
    activity: "recent", mtime: NOW - 400, lastAgentWorkAt: (NOW - 408) * 1000,
    lastTurn: { startedAt: (NOW - 900) * 1000, endedAt: (NOW - 408) * 1000 },
  });
  const tasks = [
    task("icons", "assigned", [], { updatedAt: iso(NOW - 122) }),
    task("maintenance", "assigned", [maintaining.path], { updatedAt: iso(NOW - 446) }),
    task("viewer", "assigned", [reviewed.path], { updatedAt: iso(NOW - 1765) }),
  ];
  const lane = buildingLane("pipeline-icons", "icons", { conversationId: building.conversationId, agentPath: building.path, startedAt: iso(NOW - 1800) });
  const cards = model(tasks, [building, maintaining, reviewed], { pipelines: [lane] }).columns.assigned.cards;
  expect(cards.map((card) => card.task!.id)).toEqual(["icons", "maintenance", "viewer"]);

  /* The card knows its agent is working and has no agent work on record: the
     start of the running attempt is what places it among the working cards. */
  const icons = cards[0]!;
  expect(icons.working).toBe(1);
  expect(icons.lastAgentWorkAtMs).toBe(0);
  expect(icons.workingSinceMs).toBe((NOW - 1800) * 1000);
});

test("working cards come first, then the newest agent work, then the newest task edit", () => {
  /* In a long tool call: its last record is older than the finished card's. */
  const working = file(311, { activity: "live", lastTurn: { startedAt: (NOW - 900) * 1000, endedAt: null }, lastAgentWorkAt: (NOW - 240) * 1000, mtime: NOW - 240 });
  const finished = file(312, { activity: "recent", lastTurn: { startedAt: (NOW - 400) * 1000, endedAt: (NOW - 60) * 1000 }, lastAgentWorkAt: (NOW - 60) * 1000, mtime: NOW - 60 });
  const earlier = file(313, { lastAgentWorkAt: (NOW - 7200) * 1000, mtime: NOW - 7200 });
  const tasks = [
    /* Edited a moment ago, and nothing has worked on it. */
    task("idle-b", "assigned", [], { updatedAt: iso(NOW - 10) }),
    task("idle-a", "assigned", [], { updatedAt: iso(NOW - 3000) }),
    task("earlier", "assigned", [earlier.path], { updatedAt: iso(NOW - 20) }),
    task("finished", "assigned", [finished.path], { updatedAt: iso(NOW - 9000) }),
    task("working", "assigned", [working.path], { updatedAt: iso(NOW - 9500) }),
  ];
  const order = model(tasks, [working, finished, earlier]).columns.assigned.cards.map((card) => card.task!.id);
  expect(order).toEqual(["working", "finished", "earlier", "idle-b", "idle-a"]);
  /* The order does not depend on the order the tasks were read in. */
  expect(model([...tasks].reverse(), [earlier, finished, working]).columns.assigned.cards.map((card) => card.task!.id)).toEqual(order);
});

test("streaming work keeps the working cards in place; a new turn moves its card up and a finished one steps down", () => {
  const since = (startedAgo: number) => ({ startedAt: (NOW - startedAgo) * 1000, endedAt: null });
  const first = file(321, { activity: "live", lastTurn: since(300), lastAgentWorkAt: (NOW - 50) * 1000 });
  const second = file(322, { activity: "live", lastTurn: since(100), lastAgentWorkAt: (NOW - 40) * 1000 });
  const idle = file(323, { lastAgentWorkAt: (NOW - 30) * 1000 });
  const tasks = [task("first", "assigned", [first.path]), task("second", "assigned", [second.path]), task("idle", "assigned", [idle.path])];
  const order = (files: FileEntry[]) => model(tasks, files).columns.assigned.cards.map((card) => card.task!.id);

  /* The turn that started last is on top, whatever the latest record says. */
  expect(order([first, second, idle])).toEqual(["second", "first", "idle"]);
  /* Both agents keep writing; the older turn writes last. Nobody moves. */
  const streamed = { ...first, lastAgentWorkAt: (NOW - 1) * 1000, mtime: NOW - 1 };
  expect(order([streamed, { ...second, lastAgentWorkAt: (NOW - 3) * 1000, mtime: NOW - 3 }, idle])).toEqual(["second", "first", "idle"]);
  /* The first agent's turn ends and a new one starts: it is the newest work now. */
  expect(order([{ ...streamed, lastTurn: since(2) }, second, idle])).toEqual(["first", "second", "idle"]);
  /* The second agent's turn ends: its card leaves the working cards and heads the rest. */
  const ended = { ...second, activity: "recent" as const, lastTurn: { startedAt: (NOW - 100) * 1000, endedAt: (NOW - 20) * 1000 }, lastAgentWorkAt: (NOW - 20) * 1000 };
  expect(order([first, ended, idle])).toEqual(["first", "second", "idle"]);
});

test("a stage in flight puts its card among the working ones, and a paused lane's does not", () => {
  const quiet = file(331, { lastAgentWorkAt: (NOW - 30) * 1000 });
  const tasks = [task("quiet", "assigned", [quiet.path]), task("staged", "assigned")];
  const lane = buildingLane("pipeline-staged", "staged", { startedAt: iso(NOW - 600) });
  const order = (pipelines: Pipeline[]) => model(tasks, [quiet], { pipelines }).columns.assigned.cards.map((card) => card.task!.id);
  expect(order([lane])).toEqual(["staged", "quiet"]);
  expect(order([{ ...lane, state: "paused", pausedState: "running" } as Pipeline])).toEqual(["quiet", "staged"]);
});

test("a card's agent work counts every attempt of its lanes, including a stage conversation the board draws nowhere", () => {
  const stage = file(341, { lastAgentWorkAt: (NOW - 30) * 1000 });
  const member = file(342, { lastAgentWorkAt: (NOW - 600) * 1000 });
  const tasks = [task("member", "assigned", [member.path]), task("laned", "assigned")];
  const finished = { ...buildingLane("pipeline-laned", "laned", { conversationId: stage.conversationId, agentPath: stage.path, startedAt: iso(NOW - 900) }), state: "completed", cursor: null } as unknown as Pipeline;
  finished.runs[0]!.attempts[0]!.state = "passed";
  const projection = projectTaskWorkflows([...tasks], [finished], [], [stage, member]);
  /* Only the member's conversation is laid out; the stage's is not on the board. */
  const bands = buildTaskBands(layout([member]), { tasks, projection, untitled: "Untitled task" });
  const built = buildKanbanModel({ bands, tasks, pipelines: [finished], projection, files: [stage, member], now: NOW });
  const laned = built.columns.assigned.cards.find((card) => card.task!.id === "laned")!;
  expect(built.columns.assigned.cards.map((card) => card.task!.id)).toEqual(["laned", "member"]);
  expect(laned.lastAgentWorkAtMs).toBe((NOW - 30) * 1000);
  expect(laned.workingSinceMs).toBeNull();
});

test("search narrows what is shown and never what is counted", () => {
  const tasks = [task("alpha", "inbox"), task("beta", "inbox"), task("gamma", "done")];
  const result = model(tasks, [], { query: "BETA" });
  expect(result.columns.inbox.cards).toHaveLength(2);
  expect(result.columns.inbox.shown.map((card) => card.task!.id)).toEqual(["beta"]);
  expect(result.columns.done.shown).toHaveLength(0);
  expect(result.totals.onBoard).toBe(3);
});

test("an optimistic status puts the card in its new column before the server answers", () => {
  const tasks = [task("a", "inbox"), task("b", "inbox")];
  const result = model(tasks, [], { overrides: new Map([["a", "done"]]) });
  expect(result.columns.inbox.cards.map((card) => card.task!.id)).toEqual(["b"]);
  expect(result.columns.done.cards.map((card) => card.task!.id)).toEqual(["a"]);
  expect(result.columns.done.cards[0]!.status).toBe("done");
});

test("the title is the first line of the text and the description the rest", () => {
  const result = model([task("a", "inbox", [], { text: "Restore search results\nAfter the index rebuild the results page is empty.\nSecond line." })], []);
  const card = result.columns.inbox.cards[0]!;
  expect(card.title).toBe("Restore search results");
  expect(card.description).toBe("After the index rebuild the results page is empty.\nSecond line.");
});

test("a placeholder no agent will name borrows its conversation's cleaned title instead of staying untitled", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const pending = (id: string, paths: string[], extra: Partial<BoardTask> = {}) =>
    task(id, "assigned", paths, { text: "Untitled task", origin: { kind: "conversation", key: `origin-${id}`, refinement: "pending" }, ...extra });
  const ended = file(1, { title: "**Fix** the `upload` retries after a timeout", activity: "idle", mtime: NOW - 3 * 3600 });
  const running = file(2, { title: "Rebuild the search index", activity: "live", proc: "running", mtime: NOW - 5 });
  const fresh = file(3, { title: "Draft the release notes", activity: "live", proc: "running", mtime: NOW - 5 });
  const settled = file(4, { title: "Answer the API question", activity: "idle", mtime: NOW - 30 });
  const tasks = [
    /* Its conversation ended hours ago: the card reads its conversation's title. */
    pending("ended", [ended.path]),
    /* Still working, but past the bounded wait: the same. */
    pending("slow", [running.path]),
    /* Young and working: the agent may still name it. */
    pending("young", [fresh.path], { createdAt: iso(NOW - 60) }),
    /* Young, but its conversation already stopped: nothing will name it. */
    pending("stopped", [settled.path], { createdAt: iso(NOW - 60) }),
    /* A launch that never produced a transcript: its own admission title. */
    pending("launch", [], { text: "Exercise legacy spawn fixture", origin: { kind: "launch", key: "launch-x", refinement: "pending" } }),
  ];
  const result = model(tasks, [ended, running, fresh, settled]);
  const byId = new Map(KANBAN_STATUSES.flatMap((status) => result.columns[status].cards).map((card) => [card.task!.id, card] as const));
  const shown = (id: string) => ({ title: byId.get(id)!.titlePending ? null : byId.get(id)!.title, pending: byId.get(id)!.titlePending });
  expect(shown("ended")).toEqual({ title: "Fix the upload retries after a timeout", pending: false });
  expect(shown("slow")).toEqual({ title: "Rebuild the search index", pending: false });
  expect(shown("young")).toEqual({ title: null, pending: true });
  expect(shown("stopped")).toEqual({ title: "Answer the API question", pending: false });
  expect(shown("launch")).toEqual({ title: "Exercise legacy spawn fixture", pending: false });
  /* A task somebody named keeps its own title, whatever its conversation says. */
  const named = model([task("named", "assigned", [ended.path], { text: "Upload retries", origin: { kind: "conversation", key: "k", refinement: "titled" } })], [ended]);
  expect(named.columns.assigned.cards[0]!.title).toBe("Upload retries");
});

test("the conversation count holds only what opens: a transcript elsewhere opens by its path, a launch that never started is listed apart", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  /* A row from before launches reserved a conversation: a launch id and nothing else. */
  const legacy = (id: string, at: number) => ({ launchId: `launch-${id}`, path: null, panePid: null, state: "linked", error: null, at: iso(at), engine: "codex" });
  const ghost = task("ghost", "assigned", [], { text: "Exercise legacy spawn fixture", origin: { kind: "launch", key: "launch-ghost", refinement: "pending" }, assignments: [legacy("ghost", NOW - 3600)] as BoardTask["assignments"] });
  const starting = task("starting", "assigned", [], { assignments: [legacy("starting", NOW - 30)] as BoardTask["assignments"] });
  const dismissed = task("dismissed", "assigned", [], { assignments: [{ ...legacy("dismissed", NOW - 3600), conversationId: "conversation_dismissed", state: "failed", error: "launch did not start (dismissed)" }] as BoardTask["assignments"] });
  const elsewhere = task("elsewhere", "assigned", ["/elsewhere/conversation-9.jsonl"]);
  /* A launch that minted its conversation started, whether or not this board loaded it. */
  const minted = task("minted", "assigned", [], { assignments: [{ ...legacy("minted", NOW - 3600), conversationId: "conversation_minted" }] as BoardTask["assignments"] });
  const result = model([ghost, starting, dismissed, elsewhere, minted], []);
  const byId = new Map(KANBAN_STATUSES.flatMap((status) => result.columns[status].cards).map((card) => [card.task!.id, card] as const));
  /* The ghost: no conversation counted, one launch that did not start. */
  expect(byId.get("ghost")!.conversations).toBe(0);
  expect(byId.get("ghost")!.unstarted.map((row) => ({ launchId: row.launchId, conversationId: row.conversationId, failed: row.failed, dismissable: row.dismissable }))).toEqual([
    { launchId: "launch-ghost", conversationId: null, failed: null, dismissable: true },
  ]);
  /* A launch still inside its start grace is neither. */
  expect(byId.get("starting")!.conversations).toBe(0);
  expect(byId.get("starting")!.unstarted).toEqual([]);
  /* A dismissed launch is gone from the card, and is no conversation either. */
  expect(byId.get("dismissed")!.unstarted).toEqual([]);
  expect(byId.get("dismissed")!.conversations).toBe(0);
  /* A transcript the board did not load counts, and names the path it opens. */
  expect(byId.get("elsewhere")!.conversations).toBe(1);
  expect(byId.get("elsewhere")!.notLoadedRefs).toEqual([{ key: "conversation_elided_elsewhere_0", path: "/elsewhere/conversation-9.jsonl", conversationId: "conversation_elided_elsewhere_0" }]);
  /* A minted conversation with no path counts as not loaded and opens by its id. */
  expect(byId.get("minted")!.unstarted).toEqual([]);
  expect({ conversations: byId.get("minted")!.conversations, notLoaded: byId.get("minted")!.notLoaded }).toEqual({ conversations: 1, notLoaded: 1 });
  expect(byId.get("minted")!.notLoadedRefs).toEqual([{ key: "conversation_minted", path: null, conversationId: "conversation_minted" }]);
});

/* The two cards of the report: a task that ran lane after lane for days, its
   assignments one per stage attempt, review round and handshake retry, each
   holding the conversation it minted and no path, none of them loaded on the
   board. Some of those lanes are the task's own (one closed, one completed);
   the older ones are gone from the store. */
function laneTask(id: string, days: number, lanes: ReadonlyArray<{ pipeline: string; stages: readonly string[] }>, flows: number, extra: Array<Record<string, unknown>> = []) {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const assignments: Array<Record<string, unknown>> = [];
  let n = 0;
  const add = (clientAttemptId: string) => {
    n += 1;
    assignments.push({ launchId: `launch-${id}-${n}`, clientAttemptId, path: null, conversationId: `conversation_${id}_${n}`, panePid: null, state: "linked", error: null, at: iso(NOW - days * 86_400 + n * 600), engine: n % 2 ? "claude" : "codex" });
  };
  for (const lane of lanes) {
    lane.stages.forEach((stage, index) => {
      add(`pipeline_${lane.pipeline}_${stage}_${index + 1}`);
      if (stage === "review" && index === 1) for (let retry = 1; retry <= 3; retry += 1) add(`handshake_retry_${retry}_pipeline_${lane.pipeline}_${stage}_${index + 1}`);
    });
  }
  for (let round = 1; round <= flows; round += 1) add(`flow_${id}${round}_round${round}`);
  assignments.push(...extra);
  return task(id, "inbox", [], { assignments: assignments as unknown as BoardTask["assignments"] });
}

function ownLane(id: string, taskId: string, state: string, stages: ReadonlyArray<{ stage: string; n: number; conversationId: string }>): Pipeline {
  return {
    id,
    task: `Lane ${id}`,
    project: "fixture",
    state,
    cursor: null,
    stages: [...new Set(stages.map((entry) => entry.stage))].map((stage) => ({ id: stage, kind: "run", prompt: "", next: null, effectiveRole: {} })),
    runs: [...new Set(stages.map((entry) => entry.stage))].map((stage) => ({
      stageId: stage,
      attempts: stages.filter((entry) => entry.stage === stage).map((entry) => ({ n: entry.n, state: "passed", activatedBy: null, agentPath: null, conversationId: entry.conversationId, launchId: null, sessionId: null, paneId: null, flowId: null, effectiveRole: {}, output: null, verdict: null, error: null, startedAt: "2026-09-14T10:00:00.000Z", completedAt: "2026-09-14T10:30:00.000Z" })),
    })),
    taskIds: [taskId],
    createdAt: "2026-09-14T10:00:00.000Z",
  } as unknown as Pipeline;
}

test("the report's two cards: days of stage attempts that started list no launch and count as not loaded", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const sqlite = laneTask("sqlite", 5, [
    { pipeline: "lane01", stages: ["design", "build", "review", "build", "review"] },
    { pipeline: "lane02", stages: ["build", "review", "build", "review"] },
    { pipeline: "lane03", stages: ["fix", "review", "fix", "review", "fix", "review"] },
    { pipeline: "own01", stages: ["build"] },
    { pipeline: "own02", stages: ["build"] },
  ], 5);
  const flows = laneTask("flows", 4, [
    { pipeline: "lane11", stages: ["design"] },
    { pipeline: "lane12", stages: ["build", "review", "build", "review", "build"] },
    { pipeline: "lane13", stages: ["build", "review", "build", "build"] },
    { pipeline: "own11", stages: ["build"] },
  ], 3);
  const assignment = (card: BoardTask, clientAttemptId: string) => (card.assignments as Array<{ clientAttemptId?: string; conversationId?: string }>).find((row) => row.clientAttemptId === clientAttemptId)!.conversationId!;
  /* The task's own lanes, loaded on the board: one closed, one completed. A
     helper its stage agent brought in holds a client id of its own. */
  const helper = { launchId: "launch-sqlite-helper", clientAttemptId: "mcp_spawn_helper", path: null, conversationId: "conversation_sqlite_helper", panePid: null, state: "linked", error: null, at: iso(NOW - 3 * 86_400), engine: "codex" };
  sqlite.assignments.push(helper as unknown as BoardTask["assignments"][number]);
  const pipelines = [
    ownLane("own01", "sqlite", "closed", [{ stage: "build", n: 1, conversationId: assignment(sqlite, "pipeline_own01_build_1") }, { stage: "helper", n: 1, conversationId: "conversation_sqlite_helper" }]),
    ownLane("own02", "sqlite", "completed", [{ stage: "build", n: 1, conversationId: assignment(sqlite, "pipeline_own02_build_1") }]),
    ownLane("own11", "flows", "closed", [{ stage: "build", n: 1, conversationId: assignment(flows, "pipeline_own11_build_1") }]),
  ];
  const result = model([sqlite, flows], [], { pipelines });
  const byId = new Map(KANBAN_STATUSES.flatMap((status) => result.columns[status].cards).map((card) => [card.task!.id, card] as const));
  for (const [id, stored] of [["sqlite", sqlite], ["flows", flows]] as const) {
    const card = byId.get(id)!;
    expect(stored.assignments.length).toBeGreaterThanOrEqual(20);
    /* Not one of them is a launch that did not start. */
    expect(card.unstarted).toEqual([]);
    /* Each started: it counts, as a conversation this board did not load. */
    expect(card.notLoaded).toBe(stored.assignments.length);
    expect(card.conversations).toBe(stored.assignments.length);
    /* Their home is their pipeline's chips and Past attempts: the card lists none of them. */
    expect(card.notLoadedRefs).toEqual([]);
  }
});

test("of the same card, a launch of the task's own still shows: a minted one opens by its id, a never-minted one past the grace did not start", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const direct = { launchId: "launch-direct", clientAttemptId: "mcp_spawn_direct", path: null, conversationId: "conversation_direct", panePid: null, state: "linked", error: null, at: iso(NOW - 2 * 86_400), engine: "codex" };
  const legacy = { launchId: "launch-legacy", path: null, panePid: null, state: "linked", error: null, at: iso(NOW - 2 * 86_400), engine: "codex" };
  /* A stage attempt that never minted a conversation is its pipeline's, not the card's. */
  const stageLegacy = { launchId: "launch-stage-legacy", clientAttemptId: "pipeline_gone_build_9", path: null, panePid: null, state: "linked", error: null, at: iso(NOW - 2 * 86_400), engine: "claude" };
  const card = laneTask("mixed", 3, [{ pipeline: "lane21", stages: ["build", "review", "build", "review"] }], 2, [direct, legacy, stageLegacy]);
  const result = model([card], []);
  const built = result.columns.inbox.cards[0]!;
  expect(built.unstarted.map((row) => ({ key: row.key, launchId: row.launchId, failed: row.failed }))).toEqual([{ key: "launch-legacy", launchId: "launch-legacy", failed: null }]);
  expect(built.notLoadedRefs).toEqual([{ key: "conversation_direct", path: null, conversationId: "conversation_direct" }]);
  /* Four stage attempts, three handshake retries, two review rounds and the direct launch. */
  expect(built.notLoaded).toBe(10);
});

test("a stage attempt whose launch failed is its stage's, never a failed launch of the card", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const placeholder = file(3, {
    path: "spawn:launch-stage-failed",
    conversationId: "conversation_stage_failed",
    mtime: NOW - 120,
    spawn: { launchId: "launch-stage-failed", clientAttemptId: "pipeline_gone_build_2", accountId: null, conversationId: "conversation_stage_failed", state: "failed", initialMessage: "failed", retrySafe: true, error: "account limit reached" },
  } as Partial<FileEntry>);
  const stage = task("stage", "assigned", [], { assignments: [{ launchId: "launch-stage-failed", clientAttemptId: "pipeline_gone_build_2", conversationId: "conversation_stage_failed", path: "spawn:launch-stage-failed", panePid: null, state: "spawning", error: null, at: iso(NOW - 120), engine: "claude" }] as BoardTask["assignments"] });
  const result = model([stage], [placeholder]);
  const card = KANBAN_STATUSES.flatMap((status) => result.columns[status].cards).find((entry) => entry.task?.id === "stage")!;
  expect(card.unstarted).toEqual([]);
  expect(card.conversations).toBe(0);
});

test("a failed launch is listed at once with its error, opens its launch view, and is never a conversation", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const placeholder = (id: string) => ({
    path: `spawn:launch-${id}`,
    conversationId: `conversation_${id}`,
    title: "Fix the upload retries",
    mtime: NOW - 120,
    spawn: { launchId: `launch-${id}`, clientAttemptId: null, accountId: null, conversationId: `conversation_${id}`, state: "failed", initialMessage: "failed", retrySafe: true, error: "account limit reached" },
  }) as Partial<FileEntry>;
  const failedFile = file(1, placeholder("failed"));
  const dismissedFile = file(2, placeholder("dismissed"));
  const launch = (id: string, extra: Record<string, unknown> = {}) => ({ launchId: `launch-${id}`, conversationId: `conversation_${id}`, path: failedFile.path.replace("failed", id), panePid: null, state: "spawning", error: null, at: iso(NOW - 120), engine: "claude", ...extra });
  const failed = task("failed", "assigned", [], { text: "Untitled task", origin: { kind: "launch", key: "launch-failed", refinement: "pending" }, createdAt: iso(NOW - 120), assignments: [launch("failed")] as BoardTask["assignments"] });
  const dismissed = task("dismissed", "assigned", [], { assignments: [launch("dismissed", { state: "failed", error: "launch did not start (dismissed)" })] as BoardTask["assignments"] });
  const result = model([failed, dismissed], [failedFile, dismissedFile]);
  const byId = new Map(KANBAN_STATUSES.flatMap((status) => result.columns[status].cards).map((card) => [card.task!.id, card] as const));
  const card = byId.get("failed")!;
  /* Two minutes old, well inside a starting launch's grace: a failed receipt is final. */
  expect(card.conversations).toBe(0);
  expect(card.members).toEqual([]);
  expect(card.unstarted.map((row) => ({ key: row.key, error: row.failed?.error, opens: row.failed?.file.path, dismissable: row.dismissable }))).toEqual([
    { key: "launch-failed", error: "account limit reached", opens: "spawn:launch-failed", dismissable: true },
  ]);
  /* Nothing will name it now: it reads its launch's own title at once. */
  expect({ title: card.title, pending: card.titlePending }).toEqual({ title: "Fix the upload retries", pending: false });
  /* Once dismissed, the row is gone. */
  expect(byId.get("dismissed")?.unstarted ?? []).toEqual([]);
});

function pipeline(): Pipeline {
  const attempt = (n: number, state: string, activatedBy: unknown = null) => ({ n, state, activatedBy, agentPath: null, conversationId: null, launchId: null, sessionId: null, paneId: null, flowId: null, effectiveRole: {}, output: null, verdict: null, error: null });
  return {
    id: "pipeline-fixture",
    task: "Restore search results",
    project: "fixture",
    state: "running",
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    stages: [
      { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: {} },
      { id: "build", kind: "run", prompt: "", next: "review", onFail: null, effectiveRole: {} },
      { id: "review", kind: "review-loop", prompt: "", next: "verify", effectiveRole: {} },
      { id: "verify", kind: "run", prompt: "", next: null, onFail: { to: "build", maxRounds: 2 }, effectiveRole: {} },
      { id: "diagnose", kind: "run", prompt: "", next: null, effectiveRole: {} },
      { id: "merge", kind: "run", prompt: "", next: null, effectiveRole: {} },
    ],
    runs: [
      { stageId: "plan", attempts: [attempt(1, "passed")] },
      { stageId: "build", attempts: [attempt(1, "passed"), attempt(2, "passed", { stageId: "verify", attempt: 1, edge: "fail" })] },
      { stageId: "review", attempts: [{ ...attempt(1, "passed"), reviewFlowSync: { roundCount: 2 } }] },
      { stageId: "verify", attempts: [attempt(1, "failed"), attempt(2, "running")] },
    ],
    taskIds: [],
    createdAt: "2026-09-14T10:00:00.000Z",
  } as unknown as Pipeline;
}

test("a pipeline summary follows the pass path, counts fail-edge rounds from provenance, and names waiting stages", () => {
  const withBranch = pipeline();
  withBranch.stages.find((stage) => stage.id === "build")!.onFail = { to: "diagnose", maxRounds: 1 };
  const summary = summarizePipeline(withBranch);
  expect(summary.chips.map((chip) => chip.stage.id)).toEqual(["plan", "build", "review", "verify", "merge", "diagnose"]);
  expect(summary.chips.find((chip) => chip.stage.id === "diagnose")!.branch).toBe(true);
  expect(summary.chips.find((chip) => chip.stage.id === "review")!.rounds).toBe(2);
  expect(summary.chips.find((chip) => chip.stage.id === "verify")!.state).toBe("running");
  /* Every fail edge is named, the retry loop and the forward branch alike, each
     with the rounds its attempts' provenance records. */
  expect(summary.loops.map((loop) => [loop.from.id, loop.to.id, loop.fired, loop.max])).toEqual([["build", "diagnose", 0, 1], ["verify", "build", 1, 2]]);
  expect(summary.waiting).toBe(2);
});

test("a conversation with no recorded task is a card of its own under Not on a task", () => {
  const loose = file(7);
  const result = model([task("a", "inbox")], [loose]);
  expect(result.unlinked).toHaveLength(1);
  expect(result.unlinked[0]!.task).toBeNull();
  expect(result.unlinked[0]!.origin).toBe("conversation");
  expect(result.unlinked[0]!.members.map((member) => member.file.path)).toEqual([loose.path]);
  expect(KANBAN_STATUSES.flatMap((status) => result.columns[status].cards)).toHaveLength(1);
});

test("a hidden group leaves its column for the hidden list, a resurfaced one comes back with its reason, and no task is lost", () => {
  const files = [file(1, { pendingQuestion: { kind: "question", toolUseId: "tool", transcriptPath: "/fixture/conversation-1.jsonl", pid: 1, paneTarget: null, askedAt: "2026-09-14T12:30:00.000Z" } as never }), file(2), file(3), file(4), file(5)];
  const hiddenAt = "2026-09-14T12:00:00.000Z";
  const snapshot = (paths: readonly string[]) => paths.flatMap((path) => [path, `conversation_fixture_${path.match(/(\d+)/)![1]}`]).sort();
  const tasks = [
    task("t1", "assigned", [files[0]!.path], { groupHidden: { at: hiddenAt, by: "operator", admitted: snapshot([files[0]!.path]) } }),
    task("t2", "done", [files[1]!.path], { groupHidden: { at: hiddenAt, by: "agent", admitted: snapshot([files[1]!.path]) }, color: "sky" }),
    task("t3", "inbox", [], { color: "ultraviolet" as never }),
    /* Hidden before the seat was designated on its conversation. */
    task("t4", "assigned", [files[2]!.path], { groupHidden: { at: hiddenAt, by: "operator", admitted: snapshot([files[2]!.path]) } }),
    /* A conversation joined after the hide: its admission is not in the snapshot. */
    task("t5", "blocked", [files[3]!.path, files[4]!.path], { groupHidden: { at: hiddenAt, by: "operator", admitted: snapshot([files[3]!.path]) } }),
  ];
  const seat = { conversationIds: ["conversation_fixture_3"], paths: [] };
  const built = layout(files);
  const projection = projectTaskWorkflows(tasks, [], [], files, "fixture");
  const bands = buildTaskBands(built, { tasks, projection, untitled: "Untitled", reviewFlow: "Review" });
  const model = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat, now: NOW });
  /* t1's conversation asked for a decision after the hide; t4 holds the seat;
     t5 admitted a conversation the hide never covered. All three are back. */
  expect(model.columns.assigned.cards.map((card) => card.task?.id).sort()).toEqual(["t1", "t4"]);
  expect(model.columns.blocked.cards.map((card) => card.task?.id)).toEqual(["t5"]);
  expect(model.resurfaced.map((entry) => [entry.card.task?.id, entry.reason.kind]).sort()).toEqual([["t1", "decision"], ["t4", "seat"], ["t5", "admitted"]]);
  expect(model.columns.assigned.cards.find((card) => card.task?.id === "t4")?.holdsSeat).toBe(true);
  expect(model.columns.assigned.cards.find((card) => card.task?.id === "t1")?.holdsSeat).toBe(false);
  /* t2 stays hidden, with its colour, and is counted once. */
  expect(model.columns.done.cards).toHaveLength(0);
  expect(model.hiddenGroups.map((card) => [card.task?.id, card.color])).toEqual([["t2", "sky"]]);
  /* Without a seat read the same group is hidden again: the board never
     guesses a seat it has not read. */
  const unknownSeat = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat: null, now: NOW });
  expect(unknownSeat.hiddenGroups.map((card) => card.task?.id).sort()).toEqual(["t2", "t4"]);
  /* A colour this build does not know draws no label. */
  expect(model.columns.inbox.cards.find((card) => card.task?.id === "t3")?.color ?? null).toBeNull();
  /* Every task: in a column, hidden, or off the board, exactly once. */
  const placed = [...KANBAN_STATUSES.flatMap((status) => model.columns[status].cards.map((card) => card.task!.id)), ...model.hiddenGroups.map((card) => card.task!.id), ...model.offBoard.map((row) => row.id)];
  expect(placed.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  /* A hidden group's working agents still count in the header; its decision does not. */
  expect(model.totals.onBoard).toBe(4);
});

test("an agent draft is the card's own: a band-local draft on its task, any other draft on a card of its own, and neither is idle or sent to Conversations", () => {
  const tasks = [task("t1", "assigned")];
  const base = layout([]);
  (base as unknown as { drafts: unknown[] }).drafts = [
    { key: "draft::draft-on-task", id: "draft-on-task", x: 0, y: 0, w: 600, h: 400 },
    { key: "draft::draft-alone", id: "draft-alone", x: 648, y: 0, w: 600, h: 400 },
  ];
  const projection = projectTaskWorkflows([...tasks], [], [], []);
  const bands = buildTaskBands(base, { tasks, projection, draftBands: new Map([["draft-on-task", "task:t1"]]), untitled: "Untitled task" });
  const result = buildKanbanModel({ bands, tasks, pipelines: [], projection, now: NOW });

  const onTask = result.columns.assigned.cards.find((card) => card.id === "task:t1")!;
  expect(onTask.drafts).toEqual(["draft-on-task"]);
  expect(onTask.otherSurfaces).toBe(0);
  expect(onTask.idle).toBe(false);

  const alone = result.unlinked.find((card) => card.drafts.includes("draft-alone"))!;
  expect(alone.origin).toBe("draft");
  expect(alone.otherSurfaces).toBe(0);
  expect(alone.idle).toBe(false);
});


function reviewerActivityFixture() {
  const implementer = file(101, { lastAgentWorkAt: 1000 });
  const reviewer = file(102, { lastAgentWorkAt: 3000, parent: implementer.path });
  const other = file(103, { lastAgentWorkAt: 2000 });
  const role = { engine: "codex" as const, model: null, effort: null };
  const flow: Flow = {
    id: "folded-review-flow", template: "implement-review-loop", project: "fixture", cwd: "/repo",
    implementerPath: implementer.path, implementerConversationId: implementer.conversationId,
    roles: { implementer: role, reviewer: role }, baseRef: "fixture-base", baseMode: "head", mode: "auto",
    reviewerMode: "headless", roundLimit: 2, state: "reviewing", stateDetail: null,
    createdAt: "2026-09-15T00:00:00Z", closedAt: null,
    rounds: [{ n: 1, reviewerPath: reviewer.path, reviewerConversationId: reviewer.conversationId,
      findingsPath: null, triggeredBy: "marker", readyNote: null, verdict: null, findingsCount: null,
      startedAt: "2026-09-15T00:01:00Z", reviewedAt: null, relayedAt: null, error: null }],
  };
  const project = (files: FileEntry[], tasks: BoardTask[] = []) => {
    const layout = buildSchemeLayout([], [implementer, other], files, [flow]);
    const projection = projectTaskWorkflows(tasks, [], [flow], files);
    const bands = buildTaskBands(layout, { tasks, projection, untitled: "Untitled" });
    const result = buildKanbanModel({ bands, tasks, pipelines: [], flows: [flow], files, projection, now: NOW });
    return { layout, bands, result, card: result.unlinked.find(card => card.id === `flow:${flow.id}`)! };
  };
  return { implementer, reviewer, other, flow, project };
}

test("taskless flow ordering includes reviewers folded into the real review deck", () => {
  const { implementer, reviewer, other, project } = reviewerActivityFixture();
  const { layout, result, card } = project([implementer, reviewer, other]);
  expect(layout.decks[0]!.rounds.some(round => round.file?.path === reviewer.path)).toBe(true);
  expect(card.members.map(member => member.file.path)).toEqual([implementer.path]);
  expect(card.lastAgentWorkAtMs).toBe(3000);
  expect(result.unlinked[0]).toBe(card);
  const older = project([implementer, { ...reviewer, lastAgentWorkAt: null, mtime: NOW + 1000, title: "Renamed" }, other]);
  expect(older.card.lastAgentWorkAtMs).toBe(1000);
  expect(older.result.unlinked[0]).not.toBe(older.card);
});

test("folded reviewer ordering preserves historical bindings and current-generation resolution", () => {
  const { implementer, reviewer, other, flow, project } = reviewerActivityFixture();
  const membership = (slot: string) => ({ kind: "flow" as const, containerId: flow.id, role: "reviewer" as const,
    round: 1, slot, stageId: null, stageOrder: null, parentConversationId: implementer.conversationId! });
  const history = file(104, { lastAgentWorkAt: 4000, parent: implementer.path,
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: implementer.conversationId!, reviewsConversationId: implementer.conversationId!, memberships: [membership("reviewer:1:prior")] } });
  const current = file(105, { conversationId: reviewer.conversationId, lastAgentWorkAt: 5000, parent: implementer.path,
    predecessorPath: reviewer.path,
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: implementer.conversationId!, reviewsConversationId: implementer.conversationId!, memberships: [membership("reviewer:1:current")] } });
  const files = [implementer, { ...reviewer, migratedTo: current.path }, other, history, current,
    file(106, { lastAgentWorkAt: 9000 })];
  expect(project(files).card.lastAgentWorkAtMs).toBe(5000);
  expect(project(files.map(row => row.path === current.path ? { ...row, lastAgentWorkAt: 2500 } : row)).card.lastAgentWorkAtMs).toBe(4000);
});


test("linking a flow to a task preserves its folded reviewer activity and column", () => {
  const { implementer, reviewer, other, project } = reviewerActivityFixture();
  const linked = task("linked-flow", "blocked", [implementer.path]);
  const { bands, result } = project([implementer, reviewer, other], [linked]);
  const band = bands.find(band => band.task?.id === linked.id)!;
  expect(band.flow).toBeNull();
  expect(band.members.some(member => member.kind === "deck")).toBe(true);
  const card = result.columns.blocked.cards.find(card => card.task?.id === linked.id)!;
  expect(card.lastAgentWorkAtMs).toBe(3000);
  expect(card.status).toBe("blocked");
});

function linkedPipeline(id: string, attempts: Array<Record<string, unknown>>, extra: Partial<Pipeline> = {}): Pipeline {
  const base = pipeline();
  const attempt = (row: Record<string, unknown>, n: number) => ({ n, state: "passed", activatedBy: null, agentPath: null, conversationId: null, launchId: null, sessionId: null, paneId: null, flowId: null, effectiveRole: {}, output: null, verdict: null, error: null, startedAt: null, completedAt: null, ...row });
  return {
    ...base,
    id,
    taskIds: ["sorted"],
    runs: attempts.length ? [{ stageId: "build", attempts: attempts.map((row, index) => attempt(row, index + 1)) }] : [],
    ...extra,
  } as unknown as Pipeline;
}

function pipelineOrder(pipelines: Pipeline[], files: FileEntry[], flows: Flow[] = []) {
  const tasks = [task("sorted", "assigned")];
  const projection = projectTaskWorkflows(tasks, pipelines, flows, files);
  const bands = buildTaskBands(layout([]), { tasks, projection, untitled: "Untitled task" });
  const result = buildKanbanModel({ bands, tasks, pipelines, projection, files, flows, now: NOW });
  return result.columns.assigned.cards.find((card) => card.task?.id === "sorted")!.pipelines;
}

test("a task's pipelines run newest agent work first, whatever their insertion order, state or timestamps", () => {
  const worked = file(201, { lastAgentWorkAt: 3000 });
  const older = file(202, { lastAgentWorkAt: 1000 });
  const silent = file(203);
  const pipelines = [
    /* Never started, created last: no work evidence, so it sorts at the bottom. */
    linkedPipeline("p-never", [], { state: "draft", createdAt: "2026-09-16T00:00:00.000Z" } as Partial<Pipeline>),
    linkedPipeline("p-older", [{ conversationId: older.conversationId }], { state: "running" } as Partial<Pipeline>),
    /* Attempt timestamps are newest here, and they are not agent work. */
    linkedPipeline("p-unknown", [{ conversationId: silent.conversationId, agentPath: silent.path, state: "running", startedAt: "2026-09-16T00:00:00.000Z", completedAt: "2026-09-16T01:00:00.000Z" }]),
    linkedPipeline("p-worked", [{ conversationId: worked.conversationId }], { state: "completed" } as Partial<Pipeline>),
    /* An attempt naming a conversation this board never read stays unknown. */
    linkedPipeline("p-missing", [{ conversationId: "conversation_fixture_missing", agentPath: "/fixture/missing.jsonl" }]),
  ];
  const files = [worked, older, silent];
  const summaries = pipelineOrder(pipelines, files);
  expect(summaries.map((summary) => summary.pipeline.id)).toEqual(["p-worked", "p-older", "p-missing", "p-never", "p-unknown"]);
  expect(pipelineOrder([...pipelines].reverse(), files).map((summary) => summary.pipeline.id)).toEqual(["p-worked", "p-older", "p-missing", "p-never", "p-unknown"]);
  /* Sorting pipelines leaves each pipeline's own stage order as the graph draws it. */
  for (const summary of summaries) {
    expect(summary.chips.map((chip) => chip.stage.id)).toEqual(summarizePipeline(summary.pipeline).chips.map((chip) => chip.stage.id));
  }

  /* New work on the older pipeline moves it to the top. */
  const moved = pipelineOrder(pipelines, [worked, { ...older, lastAgentWorkAt: 4000 }, silent]);
  expect(moved.map((summary) => summary.pipeline.id).slice(0, 2)).toEqual(["p-older", "p-worked"]);
});

test("pipelines with equal work keep a stable id order", () => {
  const a = file(211, { lastAgentWorkAt: 2000 });
  const b = file(212, { lastAgentWorkAt: 2000 });
  const pipelines = [linkedPipeline("p-b", [{ conversationId: b.conversationId }]), linkedPipeline("p-a", [{ conversationId: a.conversationId }])];
  expect(pipelineOrder(pipelines, [a, b]).map((summary) => summary.pipeline.id)).toEqual(["p-a", "p-b"]);
  expect(pipelineOrder([...pipelines].reverse(), [b, a]).map((summary) => summary.pipeline.id)).toEqual(["p-a", "p-b"]);
});

test("pipeline work counts historical attempts and every generation of a migrated conversation", () => {
  const recent = file(221, { lastAgentWorkAt: 3000 });
  const retired = file(222, { lastAgentWorkAt: 1000, migratedTo: "/fixture/conversation-223.jsonl" });
  const successor = file(223, { conversationId: retired.conversationId, lastAgentWorkAt: 5000, predecessorPath: retired.path });
  const pathOnly = file(224, { lastAgentWorkAt: 4000 });
  const pipelines = [
    linkedPipeline("p-recent", [{ conversationId: recent.conversationId }]),
    /* A lineage-adopted attempt still names the old generation's path. */
    linkedPipeline("p-migrated", [{ historical: true, conversationId: null, agentPath: retired.path }, { historical: true, conversationId: retired.conversationId, agentPath: retired.path }]),
    linkedPipeline("p-path", [{ conversationId: null, agentPath: pathOnly.path }]),
  ];
  expect(pipelineOrder(pipelines, [recent, retired, successor, pathOnly]).map((summary) => summary.pipeline.id)).toEqual(["p-migrated", "p-path", "p-recent"]);
});

test("a review-loop pipeline whose only recent work is its reviewer's sorts by that reviewer", () => {
  const { implementer, reviewer, other, flow } = reviewerActivityFixture();
  const files = [{ ...implementer, lastAgentWorkAt: 500 }, reviewer, other];
  const pipelines = [
    linkedPipeline("p-other", [{ conversationId: other.conversationId }]),
    linkedPipeline("p-review", [{ conversationId: null, agentPath: null, flowId: flow.id }]),
  ];
  expect(pipelineOrder(pipelines, files, [flow]).map((summary) => summary.pipeline.id)).toEqual(["p-review", "p-other"]);
  expect(pipelineOrder(pipelines, [files[0]!, { ...reviewer, lastAgentWorkAt: null }, other], [flow]).map((summary) => summary.pipeline.id)).toEqual(["p-other", "p-review"]);
});

/* #1820: the Overview's predicate and the narrowing it rides on. */

test("live work is read from the counters' own evidence: a working member, an owed answer, a stage in flight", () => {
  const working = file(70, { activity: "live", lastTurn: { startedAt: (NOW - 120) * 1000, endedAt: null } });
  const finished = file(71, { activity: "live", lastTurn: { startedAt: (NOW - 600) * 1000, endedAt: (NOW - 300) * 1000 } });
  const tasks = [
    task("busy", "assigned", [working.path]),
    task("quiet", "assigned", [finished.path]),
    task("bare", "inbox"),
    task("piped", "blocked", [], { id: "piped" }),
  ];
  const running = pipeline();
  running.taskIds = ["piped"];
  const built = model(tasks, [working, finished], { pipelines: [running] });
  const byId = new Map(KANBAN_STATUSES.flatMap((status) => built.columns[status].cards).map((card) => [card.task!.id, card] as const));

  expect(cardHasLiveWork(byId.get("busy")!)).toBe(true);
  /* The counter reads the same closed turn and does not count it; neither does
     the Overview. */
  expect(byId.get("quiet")!.working).toBe(0);
  expect(cardHasLiveWork(byId.get("quiet")!)).toBe(false);
  expect(cardHasLiveWork(byId.get("bare")!)).toBe(false);
  /* A stage attempt in flight is a worker working, transcript or not. */
  expect(cardHasLiveWork(byId.get("piped")!)).toBe(true);
});

test("the filter narrows exactly where search narrows, and no count moves with it", () => {
  const working = file(72, { activity: "live", lastTurn: { startedAt: (NOW - 120) * 1000, endedAt: null } });
  const tasks = [task("busy", "assigned", [working.path]), task("quiet", "assigned")];
  const files = [working];
  const projection = projectTaskWorkflows(tasks, [], [], files);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  const built = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, cardFilter: cardHasLiveWork, now: NOW });

  expect(built.columns.assigned.cards.map((card) => card.task!.id)).toEqual(["busy", "quiet"]);
  expect(built.columns.assigned.shown.map((card) => card.task!.id)).toEqual(["busy"]);
  expect(built.totals.onBoard).toBe(2);
  expect(built.columns.assigned.working).toBe(1);
});

test("each card names its own project, so cards from several can share one column", () => {
  const mine = file(73, { project: "atlas", activity: "live", lastTurn: { startedAt: (NOW - 120) * 1000, endedAt: null } });
  const tasks = [task("here", "assigned", [mine.path], { project: "atlas" })];
  const built = model(tasks, [mine]);
  expect(built.columns.assigned.cards[0]!.project).toBe("atlas");
});

test("seat conversations draw no band: a seat-only task is the seat panel's, and a mixed band keeps its card without the seat tile (#1841)", () => {
  /* Conversations 1–3 are product work, 4 the live seat, 5 and 6 two seats
     the project revoked; 7 is a previous seat whose task also carries work. */
  const files = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => file(index, index === 4 || index === 1 ? { activity: "live", lastTurn: { startedAt: (NOW - 120) * 1000, endedAt: null } } as Partial<FileEntry> : {}));
  const tasks = [
    task("t1", "assigned", [files[0]!.path]),
    task("t2", "inbox", [files[1]!.path]),
    task("t3", "done", [files[2]!.path]),
    task("t4", "assigned", [files[3]!.path]),
    task("t5", "assigned", [files[4]!.path]),
    task("t6", "done", [files[5]!.path]),
    task("t7", "assigned", [files[6]!.path, files[7]!.path]),
  ];
  const projection = projectTaskWorkflows([...tasks], [], [], [...files]);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  const seat = {
    conversationIds: [files[3]!.conversationId!],
    paths: [files[3]!.path],
    previous: { conversationIds: [files[4]!.conversationId!, files[5]!.conversationId!, files[6]!.conversationId!], paths: [] },
  };
  const board = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat, now: NOW });
  const carded = KANBAN_STATUSES.flatMap((status) => board.columns[status].cards.map((card) => card.task?.id));
  expect(carded.sort()).toEqual(["t1", "t2", "t3", "t7"]);
  expect(board.seatTasks.map((entry) => entry.id).sort()).toEqual(["t4", "t5", "t6"]);
  expect(board.offBoard).toEqual([]);
  expect(board.totals.tasks).toBe(4);
  expect(board.columns.assigned.cards.length).toBe(2);
  expect(board.columns.done.cards.length).toBe(1);
  /* The live seat's working conversation is no share of any counter. */
  expect(board.totals.working).toBe(1);
  expect(board.columns.assigned.working).toBe(1);
  expect(KANBAN_STATUSES.flatMap((status) => board.columns[status].cards).some((card) => card.members.some((member) => member.file.path === files[3]!.path))).toBe(false);
  /* The mixed band keeps its card and its product conversation, without the seat tile. */
  const mixed = board.columns.assigned.cards.find((card) => card.task?.id === "t7")!;
  expect(mixed.members.map((member) => member.file.path)).toEqual([files[7]!.path]);
  expect(mixed.conversations).toBe(1);

  /* A failed seat read passes no `previous`: the bands draw as before, seats included. */
  const unread = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat: { conversationIds: seat.conversationIds, paths: seat.paths }, now: NOW });
  expect(KANBAN_STATUSES.reduce((sum, status) => sum + unread.columns[status].cards.length, 0)).toBe(7);
  expect(unread.totals.working).toBe(2);
  expect(unread.seatTasks).toEqual([]);
});

test("a rotation moves the old seat's card off the board with no task write (#1841)", () => {
  const files = [1, 2].map((index) => file(index));
  const tasks = [task("seat-a", "assigned", [files[0]!.path]), task("work", "assigned", [files[1]!.path])];
  const projection = projectTaskWorkflows([...tasks], [], [], [...files]);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  const before = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat: { conversationIds: [], paths: [], previous: { conversationIds: [], paths: [] } }, now: NOW });
  expect(before.columns.assigned.cards.map((card) => card.task?.id).sort()).toEqual(["seat-a", "work"]);
  /* The rotation's revocation is all that changed: the same tasks, byte for byte. */
  const after = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat: { conversationIds: [], paths: [], previous: { conversationIds: [files[0]!.conversationId!], paths: [] } }, now: NOW });
  expect(after.columns.assigned.cards.map((card) => card.task?.id)).toEqual(["work"]);
  expect(after.seatTasks.map((entry) => entry.id)).toEqual(["seat-a"]);
});

test("a seat conversation no task holds draws no Not-on-a-task card either (#1841)", () => {
  const files = [1, 2].map((index) => file(index));
  const tasks: BoardTask[] = [];
  const projection = projectTaskWorkflows([], [], [], [...files]);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  const known = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat: { conversationIds: [files[0]!.conversationId!], paths: [], previous: { conversationIds: [], paths: [] } }, now: NOW });
  expect(known.unlinked.map((card) => card.members.map((member) => member.file.path))).toEqual([[files[1]!.path]]);
  /* The same read without `previous` (a failed read) draws both. */
  const unread = buildKanbanModel({ bands, tasks, pipelines: [], projection, files, seat: { conversationIds: [files[0]!.conversationId!], paths: [] }, now: NOW });
  expect(unread.unlinked.length).toBe(2);
});

/* #1938: a lane parked in needs_review makes its card ask for the operator,
   and the card's progress sentence names the verdict and both heads. */
test("a needs_review lane's card needs the operator and says the last review failed on an unreviewed head (#1938)", () => {
  const en = ((key: string, params?: Record<string, string | number>) => translate("en", key as never, params)) as TFunction;
  const parked = linkedPipeline("p-review", [{ state: "passed" }], {
    state: "needs_review",
    cursor: null,
    reviewPending: {
      stageId: "verify", attempt: 1, fixStageId: "build", fixAttempt: 2,
      reviewedHead: "a".repeat(40), currentHead: "b".repeat(40), verdict: "fail", findings: 1, at: "2026-09-16T00:00:00.000Z",
    },
  } as Partial<Pipeline>);
  const tasks = [task("sorted", "assigned")];
  const projection = projectTaskWorkflows(tasks, [parked], [], []);
  const bands = buildTaskBands(layout([]), { tasks, projection, untitled: "Untitled task" });
  const card = buildKanbanModel({ bands, tasks, pipelines: [parked], projection, files: [], flows: [], now: NOW })
    .columns.assigned.cards.find((candidate) => candidate.task?.id === "sorted")!;
  expect(card.needsYou).toBe(true);
  const summary = card.pipelines[0]!;
  expect(pipelineProgress(en, summary, (stage) => stage.id))
    .toBe("needs review · last review fail on aaaaaaaa · current head bbbbbbbb unreviewed");
});

/* docs/design/needs-attention.md §4: a card names why it needs the operator,
   and what someone cleared, from the same reason model the phone reads. */
test("a card lists its reasons oldest first and keeps what was cleared, with who cleared it", () => {
  const asked = (path: string, askedAt: string) => ({ kind: "question", toolUseId: `tool-${path}`, transcriptPath: path, pid: 1, paneTarget: null, askedAt }) as never;
  const questioner = file(301, { pendingQuestion: asked("/fixture/conversation-301.jsonl", "2026-09-14T12:30:00.000Z") });
  const cleared = file(302, {
    pendingQuestion: asked("/fixture/conversation-302.jsonl", "2026-09-14T12:00:00.000Z"),
    attentionDismissal: { at: "2026-09-14T12:10:00.000Z", by: { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" } },
  });
  const stalled = file(303, { activity: "stalled", proc: "running", mtime: NOW - 400 });
  const walled = file(304, { activity: "live", proc: "running", rateLimit: { source: "pane", accountId: null, window: null, resetAt: NOW + 900 } });
  const parked = linkedPipeline("p-parked", [{ state: "failed", startedAt: "2026-09-14T11:00:00.000Z", completedAt: "2026-09-14T11:30:00.000Z" }], {
    state: "needs_decision",
    taskIds: ["t-reasons"],
    cursor: { stageId: "build", state: "needs_decision", input: null, activatedBy: null },
  } as unknown as Partial<Pipeline>);
  const files = [questioner, cleared, stalled, walled];
  const result = model([task("t-reasons", "assigned", files.map((entry) => entry.path))], files, { pipelines: [parked] });
  const card = result.columns.assigned.cards.find((entry) => entry.task?.id === "t-reasons")!;

  expect(card.needsYou).toBe(true);
  expect(card.reasons.map((need) => [need.subject, need.kind, need.key])).toEqual([
    ["pipeline", "lane-decision", "pipeline:p-parked"],
    ["conversation", "question", "tool-/fixture/conversation-301.jsonl"],
  ]);
  expect(card.cleared.map((entry) => [entry.need.key, entry.by.kind])).toEqual([["tool-/fixture/conversation-302.jsonl", "manager"]]);
  /* A stalled member and a member at a wall keep their words and ask nothing. */
  const byPath = new Map(card.members.map((member) => [member.file.path, member] as const));
  expect(byPath.get(stalled.path)).toMatchObject({ state: "stalled", needsYou: false, need: null });
  expect(byPath.get(walled.path)).toMatchObject({ state: "limit", needsYou: false, need: null });
  expect(byPath.get(questioner.path)).toMatchObject({ state: "waiting", needsYou: true, need: { kind: "question" } });
  expect(result.columns.assigned.needsYou).toBe(1);
});

test("a lane cleared on the phone no longer marks the desktop card, and comes back once it moves", () => {
  const parkedAt = "2026-09-14T11:30:00.000Z";
  const lane = (dismissedAt: string | null, completedAt = parkedAt) => linkedPipeline("p-hidden", [{ state: "failed", startedAt: "2026-09-14T11:00:00.000Z", completedAt }], {
    state: "needs_decision",
    taskIds: ["t-hidden"],
    cursor: { stageId: "build", state: "needs_decision", input: null, activatedBy: null },
    dismissedAt,
    dismissedBy: dismissedAt ? { kind: "operator", surface: "phone" } : undefined,
  } as unknown as Partial<Pipeline>);
  const cardOf = (pipeline: Pipeline) => model([task("t-hidden", "assigned")], [], { pipelines: [pipeline] }).columns.assigned.cards.find((entry) => entry.task?.id === "t-hidden")!;

  expect(cardOf(lane(null)).needsYou).toBe(true);
  const hidden = cardOf(lane("2026-09-14T11:45:00.000Z"));
  expect(hidden.needsYou).toBe(false);
  expect(hidden.reasons).toEqual([]);
  expect(hidden.cleared.map((entry) => [entry.need.kind, entry.by])).toEqual([["lane-decision", { kind: "operator", surface: "phone" }]]);
  /* A round ended after the dismissal: a decision nobody cleared. */
  const moved = cardOf(lane("2026-09-14T11:45:00.000Z", "2026-09-14T12:15:00.000Z"));
  expect(moved.needsYou).toBe(true);
  expect(moved.cleared).toEqual([]);
});
