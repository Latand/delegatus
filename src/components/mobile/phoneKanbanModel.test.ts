import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { SeatRefs } from "@/lib/tasks/groupHide";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { buildKanbanModel, cardHasLiveWork, KANBAN_STATUSES } from "@/components/kanban/kanbanModel";
import type { SchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";

import { attentionKey, buildPhoneKanban, columnEmpty, DONE_WINDOW, nearestWithWork, shownPipeline, type PhoneCard } from "./phoneKanbanModel";

/* Pure projection tests: invented tasks, transcripts and pipelines, the real
   band projection and the desktop's own model under the phone's reading. */

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
    model: "opus",
    pendingQuestion: null,
    waitingInput: null,
    name: `conversation-${index}`,
    ...extra,
  } as FileEntry;
}

const working = (index: number, extra: Partial<FileEntry> = {}) =>
  file(index, { activity: "live", lastTurn: { startedAt: (NOW - 120) * 1000, endedAt: null }, lastAgentWorkAt: (NOW - 30) * 1000, ...extra } as Partial<FileEntry>);

const asking = (index: number, askedAgo: number) => file(index, {
  pendingQuestion: { kind: "question", toolUseId: `tool-${index}`, transcriptPath: `/fixture/conversation-${index}.jsonl`, pid: 1, paneTarget: null, askedAt: new Date((NOW - askedAgo) * 1000).toISOString(), questions: [{ question: `Which unit file stays for ${index}?`, header: "Unit", multiSelect: false, options: [] }] },
} as Partial<FileEntry>);

function task(id: string, status: TaskStatus, paths: readonly string[] = [], extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "fixture",
    text: `Task ${id}\nWhat ${id} is about`,
    status,
    placement: "unplaced",
    assignments: paths.map((path) => ({ path, conversationId: `conversation_fixture_${path.match(/(\d+)/)![1]}`, panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    ...extra,
  } as BoardTask;
}

function lane(id: string, state: Pipeline["state"], taskIds: readonly string[], over: { agentPath?: string; stageState?: string } = {}): Pipeline {
  const attempt = over.agentPath
    ? [{ n: 1, state: over.stageState ?? "running", activatedBy: null, agentPath: over.agentPath, conversationId: null, launchId: null, sessionId: null, paneId: null, flowId: null, effectiveRole: {}, output: null, verdict: null, error: null, startedAt: new Date((NOW - 300) * 1000).toISOString() }]
    : [];
  return {
    id,
    task: `Lane ${id}`,
    project: "fixture",
    state,
    taskIds: [...taskIds],
    cursor: state === "running" ? { stageId: "implement", state: "running", input: null, activatedBy: null } : null,
    stages: [
      { id: "implement", kind: "run", prompt: "", next: "review", effectiveRole: {} },
      { id: "review", kind: "run", prompt: "", next: null, effectiveRole: {} },
    ],
    runs: attempt.length ? [{ stageId: "implement", attempts: attempt }] : [],
    createdAt: "2026-09-14T10:00:00.000Z",
  } as unknown as Pipeline;
}

function layout(files: readonly FileEntry[]): SchemeLayout {
  const nodes = files.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  return {
    nodes, groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [],
    byPath: new Map(nodes.map((node) => [node.file.path, node])),
    width: files.length * 648,
    height: 880,
  } as unknown as SchemeLayout;
}

function desktop(tasks: readonly BoardTask[], files: readonly FileEntry[], options: { pipelines?: Pipeline[]; seat?: SeatRefs | null; cardFilter?: typeof cardHasLiveWork } = {}) {
  const pipelines = options.pipelines ?? [];
  const projection = projectTaskWorkflows([...tasks], pipelines, [], [...files], "fixture");
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  return buildKanbanModel({ bands, tasks, pipelines, projection, files, seat: options.seat ?? null, cardFilter: options.cardFilter, now: NOW });
}

const keys = (items: readonly PhoneCard[]) => items.map((item) => item.card.task?.id ?? item.key);

test("each column counts exactly what the desktop column counts, and holds the same cards", () => {
  const files = [working(1), file(2), asking(3, 600), file(4), working(5)];
  const tasks = [
    task("a1", "assigned", [files[0]!.path]),
    task("a2", "assigned", [files[1]!.path]),
    task("i1", "inbox", [files[2]!.path]),
    task("i2", "inbox"),
    task("b1", "blocked", [files[3]!.path]),
    ...Array.from({ length: 5 }, (_, index) => task(`d${index}`, "done")),
  ];
  const model = desktop(tasks, files);
  const phone = buildPhoneKanban({ model, now: NOW });
  for (const status of KANBAN_STATUSES) {
    const column = phone.columns[status];
    expect(column.count).toBe(model.columns[status].cards.length);
    const drawn = [...column.pinned, ...column.cards].filter((item) => item.kind === "task").map((item) => item.card.id).sort();
    expect(drawn).toEqual(model.columns[status].cards.map((card) => card.id).sort());
  }
  expect(phone.columns.assigned.working).toBe(model.columns.assigned.working);
  /* The loose working conversation is Inbox's: it is drawn there. */
  expect(phone.columns.inbox.working).toBe(model.columns.inbox.working + 1);
  expect(phone.columns.inbox.unlinked.map((item) => item.kind)).toEqual(["conversation"]);
});

test("a phone column orders its cards as the desktop column does: working, then recently worked, then idle", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  /* In a long tool call: its last record is older than the finished card's. */
  const busy = working(21, { lastTurn: { startedAt: (NOW - 900) * 1000, endedAt: null }, lastAgentWorkAt: (NOW - 240) * 1000, mtime: NOW - 240 } as Partial<FileEntry>);
  const finished = file(22, { activity: "recent", lastTurn: { startedAt: (NOW - 400) * 1000, endedAt: (NOW - 60) * 1000 }, lastAgentWorkAt: (NOW - 60) * 1000, mtime: NOW - 60 } as Partial<FileEntry>);
  const tasks = [
    task("idle-b", "assigned", [], { updatedAt: iso(NOW - 10) }),
    task("idle-a", "assigned", [], { updatedAt: iso(NOW - 3000) }),
    task("finished", "assigned", [finished.path], { updatedAt: iso(NOW - 9000) }),
    task("busy", "assigned", [busy.path], { updatedAt: iso(NOW - 9500) }),
  ];
  const model = desktop(tasks, [busy, finished]);
  const phone = buildPhoneKanban({ model, now: NOW });
  expect(phone.columns.assigned.pinned).toEqual([]);
  expect(keys(phone.columns.assigned.cards)).toEqual(["busy", "finished", "idle-b", "idle-a"]);
  expect(keys(phone.columns.assigned.cards)).toEqual(model.columns.assigned.cards.map((card) => card.task!.id));
});

test("what needs the operator comes first, in the attention queue's order, task cards and Not on a task rows alike", () => {
  /* Conversation 1 asked first (oldest), 4 next, 3 last; 6 asks on no task. */
  const files = [asking(1, 3_000), file(2), asking(3, 600), asking(4, 1_800), working(5), asking(6, 2_400)];
  const tasks = [
    task("quiet", "inbox", [files[1]!.path]),
    task("third", "inbox", [files[2]!.path]),
    task("first", "inbox", [files[0]!.path]),
    task("second", "inbox", [files[3]!.path]),
    task("busy", "inbox", [files[4]!.path]),
  ];
  const model = desktop(tasks, files);
  const attention = [files[0]!, files[5]!, files[3]!, files[2]!].map((entry) => attentionKey.conversation(entry.path));
  const inbox = buildPhoneKanban({ model, attention, now: NOW }).columns.inbox;
  expect(keys(inbox.pinned)).toEqual(["first", `lineage:${files[5]!.conversationId}`, "second", "third"]);
  expect(inbox.pinned[1]!.kind).toBe("conversation");
  /* The tab's ⚠n is the pin, and nothing that needs the operator sits under it. */
  expect(inbox.needsYou).toBe(4);
  expect([...inbox.cards, ...inbox.unlinked].some((item) => item.card.needsYou)).toBe(false);
  expect(keys(inbox.cards).sort()).toEqual(["busy", "quiet"]);
  /* The loose ask left Not on a task for the pin; nothing else is loose. */
  expect(inbox.unlinked).toEqual([]);
  /* Its reason is the conversation, in the conversation's hue. */
  expect(inbox.pinned[0]!.need?.kind).toBe("conversation");
  expect(inbox.pinned[0]!.edge).toBe("warning");
});

test("a need the queue does not rank keeps the desktop's order behind the ranked ones", () => {
  const files = [asking(1, 600), asking(2, 900), asking(3, 1_200)];
  const tasks = files.map((entry, index) => task(`t${index + 1}`, "assigned", [entry.path]));
  const model = desktop(tasks, files);
  const desktopOrder = model.columns.assigned.cards.map((card) => card.task!.id);
  const assigned = buildPhoneKanban({ model, attention: [attentionKey.conversation(files[2]!.path)], now: NOW }).columns.assigned;
  expect(keys(assigned.pinned)).toEqual(["t3", ...desktopOrder.filter((id) => id !== "t3")]);
});

test("Done shows a window of the newest cards and counts them all", () => {
  const files = Array.from({ length: 45 }, (_, index) => file(index + 1, { lastAgentWorkAt: (NOW - (index + 1) * 60) * 1000 }));
  const tasks = files.map((entry, index) => task(`d${index + 1}`, "done", [entry.path]));
  const model = desktop(tasks, files);
  const first = buildPhoneKanban({ model, now: NOW }).columns.done;
  expect(first.count).toBe(45);
  expect(first.cards).toHaveLength(DONE_WINDOW);
  expect(first.more).toBe(25);
  /* Newest work first: the desktop's order. */
  expect(keys(first.cards).slice(0, 3)).toEqual(["d1", "d2", "d3"]);
  const more = buildPhoneKanban({ model, now: NOW, doneShown: 40 }).columns.done;
  expect(more.cards).toHaveLength(40);
  expect(more.more).toBe(5);
  /* No other column is windowed. */
  const assigned = buildPhoneKanban({ model: desktop(tasks.map((entry) => ({ ...entry, status: "assigned" as const })), files), now: NOW }).columns.assigned;
  expect(assigned.cards).toHaveLength(45);
  expect(assigned.more).toBe(0);
});

test("Not on a task is Inbox's alone, and a pipeline no task owns is a card titled by the pipeline", () => {
  /* The band projection draws a task-less lane once one of its stages has a
     conversation on the board. */
  const files = [file(1), file(2), working(3)];
  const loose = lane("loose", "running", [], { agentPath: files[2]!.path });
  const model = desktop([task("a", "assigned", [files[0]!.path])], files, { pipelines: [loose] });
  const phone = buildPhoneKanban({ model, now: NOW });
  expect(phone.columns.inbox.unlinked.map((item) => [item.kind, item.key]).sort()).toEqual([["conversation", `lineage:${files[1]!.conversationId}`], ["pipeline", "pipeline:loose"]]);
  for (const status of ["assigned", "blocked", "done"] as const) expect(phone.columns[status].unlinked).toEqual([]);
  const pipelineCard = phone.columns.inbox.unlinked.find((item) => item.kind === "pipeline")!;
  expect(pipelineCard.shown?.pipeline.id).toBe("loose");
  expect(pipelineCard.firstAgent?.path).toBe(files[2]!.path);
  /* A row no task owns draws no agents line: its meta line says it. */
  expect(pipelineCard.agents).toBeNull();
  expect(phone.columns.inbox.working).toBe(1);
});

test("the seat's task and the seat's conversation reach no column", () => {
  const files = [working(1), file(2), working(3)];
  const tasks = [task("seat", "assigned", [files[0]!.path]), task("work", "assigned", [files[1]!.path]), task("mixed", "blocked", [files[2]!.path, files[0]!.path])];
  const seat: SeatRefs = { conversationIds: [files[0]!.conversationId!], paths: [files[0]!.path], previous: { conversationIds: [], paths: [] } };
  const phone = buildPhoneKanban({ model: desktop(tasks, files, { seat }), now: NOW });
  const drawn = KANBAN_STATUSES.flatMap((status) => [...phone.columns[status].pinned, ...phone.columns[status].cards, ...phone.columns[status].unlinked]);
  expect(drawn.map((item) => item.card.task?.id)).not.toContain("seat");
  expect(drawn.flatMap((item) => item.card.members.map((member) => member.file.path))).not.toContain(files[0]!.path);
  expect(phone.columns.assigned.count).toBe(1);
  /* The seat's own work is no share of any tab's count. */
  expect(phone.columns.assigned.working).toBe(0);
  expect(phone.columns.blocked.working).toBe(1);
});

test("a hidden group is in no column and in the desktop's hidden list", () => {
  const files = [file(1), file(2)];
  const tasks = [
    task("shown", "assigned", [files[0]!.path]),
    task("hidden", "assigned", [files[1]!.path], { groupHidden: { at: new Date((NOW + 60) * 1000).toISOString(), by: "operator", admitted: { conversationIds: [files[1]!.conversationId!], paths: [files[1]!.path] } } as never }),
  ];
  const model = desktop(tasks, files);
  const phone = buildPhoneKanban({ model, now: NOW });
  expect(keys(phone.columns.assigned.cards)).toEqual(["shown"]);
  expect(phone.columns.assigned.count).toBe(1);
  expect(model.hiddenGroups.map((card) => card.task?.id)).toEqual(["hidden"]);
});

test("a card shows the pipeline that needs the operator, else the newest unfinished one, and counts the others", () => {
  const stageFile = working(1);
  const files = [stageFile, file(2)];
  const pipelines = [
    lane("done-one", "completed", ["t"]),
    lane("paused-one", "paused", ["t"]),
    lane("running-one", "running", ["t"], { agentPath: stageFile.path }),
    lane("parked", "needs_decision", ["t"]),
  ];
  const model = desktop([task("t", "assigned", [files[1]!.path])], files, { pipelines });
  const card = buildPhoneKanban({ model, attention: [attentionKey.pipeline("parked")], now: NOW }).columns.assigned.pinned[0]!;
  expect(card.shown?.pipeline.id).toBe("parked");
  expect(card.need).toMatchObject({ kind: "pipeline" });
  expect(card.edge).toBe("warning");
  expect(card.others).toEqual({ needs: 0, running: 1, paused: 1 });
  expect(card.finished).toBe(false);

  /* Without the decision: the running lane is the newest unfinished one. */
  const calmer = desktop([task("t", "assigned", [files[1]!.path])], files, { pipelines: pipelines.filter((entry) => entry.id !== "parked") });
  const calm = buildPhoneKanban({ model: calmer, now: NOW }).columns.assigned.cards[0]!;
  expect(calm.shown?.pipeline.id).toBe("running-one");
  expect(calm.others).toEqual({ needs: 0, running: 0, paused: 1 });

  /* Every lane over: the card is finished, and shows the newest. */
  const over = desktop([task("t", "assigned")], [], { pipelines: [lane("a-done", "completed", ["t"]), lane("b-done", "closed", ["t"])] });
  const finished = buildPhoneKanban({ model: over, now: NOW }).columns.assigned.cards[0]!;
  expect(finished.finished).toBe(true);
  expect(finished.shown).not.toBeNull();
  expect(shownPipeline([])).toBeNull();
});

test("the agents line says only what the pipeline line does not", () => {
  const stage = working(1);
  const outside = working(2);
  const files = [stage, outside, file(3), file(4)];
  const pipelines = [lane("only-stages", "running", ["staged"], { agentPath: stage.path }), lane("with-outside", "running", ["mixed"], { agentPath: stage.path })];
  const tasks = [
    task("staged", "assigned"),
    task("mixed", "assigned", [outside.path]),
    task("plain", "assigned", [files[2]!.path, files[3]!.path]),
    task("empty", "inbox"),
  ];
  const phone = buildPhoneKanban({ model: desktop(tasks, files, { pipelines }), now: NOW });
  const byId = new Map([...phone.columns.assigned.cards, ...phone.columns.inbox.cards].map((item) => [item.card.task!.id, item] as const));
  /* Its only working agent is its pipeline's stage: nothing to add. */
  expect(byId.get("staged")!.agents).toBeNull();
  /* An agent working outside the shown pipeline is said. */
  expect(byId.get("mixed")!.agents).toMatchObject({ working: 1 });
  /* No pipeline: the line says the agents, working or not. */
  expect(byId.get("plain")!.agents).toMatchObject({ working: 0, conversations: 2 });
  expect(byId.get("empty")!.agents).toMatchObject({ working: 0, conversations: 0 });
});

test("an empty column points at the nearest column with work, the earlier one on a tie", () => {
  const files = [file(1), file(2)];
  const phone = buildPhoneKanban({ model: desktop([task("a", "assigned", [files[0]!.path]), task("d", "done", [files[1]!.path])], files), now: NOW });
  expect(columnEmpty(phone.columns.blocked)).toBe(true);
  expect(columnEmpty(phone.columns.inbox)).toBe(true);
  expect(nearestWithWork(phone.columns, "blocked")).toBe("assigned");
  expect(nearestWithWork(phone.columns, "inbox")).toBe("assigned");
  expect(nearestWithWork(phone.columns, "assigned")).toBe("done");
  const empty = buildPhoneKanban({ model: desktop([], []), now: NOW });
  expect(nearestWithWork(empty.columns, "assigned")).toBeNull();
  expect(KANBAN_STATUSES.every((status) => columnEmpty(empty.columns[status]))).toBe(true);
});

test("a lane the operator set aside asks nothing here, as in the ⚠ queue, and a closing lane no task owns leaves on the tap", () => {
  const stage = working(1);
  const looseStage = working(2);
  const hidden = { ...lane("hidden", "needs_decision", ["t"]), dismissedAt: new Date((NOW + 60) * 1000).toISOString() } as Pipeline;
  const loose = lane("loose", "needs_decision", [], { agentPath: looseStage.path, stageState: "needs_decision" });
  const pipelines = [hidden, lane("running", "running", ["t"], { agentPath: stage.path }), loose];
  const model = desktop([task("t", "assigned")], [stage, looseStage], { pipelines });
  /* The desktop reads the same dismissal (docs/design/needs-attention.md §2):
     the hidden lane asks nothing there either, and the card says it was cleared. */
  expect(model.columns.assigned.cards[0]!.needsYou).toBe(false);
  expect(model.columns.assigned.cards[0]!.cleared.map((entry) => entry.need.key)).toEqual(["pipeline:hidden"]);

  const phone = buildPhoneKanban({ model, attention: [attentionKey.pipeline("loose")], now: NOW });
  const card = phone.columns.assigned.cards[0]!;
  expect(phone.columns.assigned.pinned).toEqual([]);
  expect(phone.columns.assigned.needsYou).toBe(0);
  expect(card.need).toBeNull();
  expect(card.edge).toBeNull();
  expect(keys(phone.columns.inbox.pinned)).toEqual(["pipeline:loose"]);

  /* Closing: the loose lane is gone from Inbox and from its ⚠ at once. */
  const closing = buildPhoneKanban({ model, attention: [], closing: ["loose"], now: NOW });
  expect(closing.columns.inbox.pinned).toEqual([]);
  expect(closing.columns.inbox.unlinked).toEqual([]);
  expect(closing.columns.inbox.needsYou).toBe(0);
});

/* #2098: the Overview narrows the model to live work, as its desktop board
   does (#1820). The phone's columns read what the narrowing keeps, and a tab
   counts the cards it draws; a project's board, which narrows nothing, is
   the whole inventory as before. */
test("the Overview's narrowing keeps live work only, and each tab counts what it draws", () => {
  const files = [working(1), file(2), asking(3, 600), file(4), working(5)];
  const tasks = [
    task("a1", "assigned", [files[0]!.path]),
    task("a2", "assigned", [files[1]!.path]),
    task("b1", "blocked", [files[2]!.path]),
    task("d1", "done", [files[3]!.path]),
  ];
  const narrowed = buildPhoneKanban({ model: desktop(tasks, files, { cardFilter: cardHasLiveWork }), now: NOW });
  expect(keys(narrowed.columns.assigned.cards)).toEqual(["a1"]);
  expect(narrowed.columns.assigned.count).toBe(1);
  expect(narrowed.columns.assigned.working).toBe(1);
  expect(keys(narrowed.columns.blocked.pinned)).toEqual(["b1"]);
  expect(narrowed.columns.done.count).toBe(0);
  expect(columnEmpty(narrowed.columns.done)).toBe(true);
  /* The working row no task owns is live, so Not on a task keeps it. */
  expect(narrowed.columns.inbox.unlinked.map((item) => item.firstAgent?.path)).toEqual([files[4]!.path]);

  const whole = buildPhoneKanban({ model: desktop(tasks, files), now: NOW });
  expect(keys(whole.columns.assigned.cards)).toEqual(["a1", "a2"]);
  expect(whole.columns.assigned.count).toBe(2);
  expect(whole.columns.done.count).toBe(1);
});

/* docs/design/needs-attention.md §4, §5: the phone card reads the desktop
   card's reasons, and a card someone cleared keeps who cleared it until
   something new asks. */
test("a phone card carries the reasons its Dismiss clears, and a cleared card says who cleared it", () => {
  const asker = asking(1, 300);
  const clearedAsker = { ...asking(2, 600), attentionDismissal: { at: new Date((NOW - 60) * 1000).toISOString(), by: { kind: "operator" as const, surface: "phone" as const } } };
  const parked = lane("parked", "needs_decision", ["t-ask"]);
  const model = desktop([task("t-ask", "assigned", [asker.path]), task("t-clear", "assigned", [clearedAsker.path])], [asker, clearedAsker], { pipelines: [parked] });
  const phone = buildPhoneKanban({ model, attention: [attentionKey.conversation(asker.path), attentionKey.pipeline("parked")], now: NOW });
  const byId = new Map([...phone.columns.assigned.pinned, ...phone.columns.assigned.cards].map((item) => [item.card.task!.id, item] as const));

  const ask = byId.get("t-ask")!;
  expect(ask.reasons.map((need) => need.key).sort()).toEqual(["pipeline:parked", "tool-1"]);
  /* The one the queue ranks first names the badge. */
  expect(ask.need).toMatchObject({ kind: "conversation", reason: { key: "tool-1" } });
  expect(ask.cleared).toBeNull();

  const clear = byId.get("t-clear")!;
  expect(clear.need).toBeNull();
  expect(clear.reasons).toEqual([]);
  expect(clear.cleared).toMatchObject({ by: { kind: "operator", surface: "phone" }, need: { key: "tool-2" } });
  expect(phone.columns.assigned.needsYou).toBe(1);
});

test("a closing lane is not among the reasons a card's Dismiss would clear", () => {
  const parked = lane("parked", "needs_decision", ["t"]);
  const model = desktop([task("t", "assigned")], [], { pipelines: [parked] });
  const open = buildPhoneKanban({ model, now: NOW });
  expect(open.columns.assigned.pinned[0]!.reasons.map((need) => need.key)).toEqual(["pipeline:parked"]);
  const closing = buildPhoneKanban({ model, closing: ["parked"], now: NOW });
  expect(closing.columns.assigned.pinned).toEqual([]);
  expect(closing.columns.assigned.cards[0]!.reasons).toEqual([]);
});
