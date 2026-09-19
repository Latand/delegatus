import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { buildSchemeLayout, type SchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";

import { buildKanbanModel, cardHasLiveWork, KANBAN_STATUSES, summarizePipeline } from "./kanbanModel";

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
