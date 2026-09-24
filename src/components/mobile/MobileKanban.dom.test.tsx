import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { SchemeLayout } from "@/components/scheme/layout";
import type { PatchBody, PatchResult, TaskMutationPorts } from "@/components/kanban/useTaskMutations";

import { MobileKanban } from "./MobileKanban";
import { createMobileNav, MobileNavContext, type MobileNav } from "./mobileNav";
import { fakeHistory } from "./mobileNavTestHistory";
import { receipts, useReceipt } from "./MobileReceipt";
import { attentionKey } from "./phoneKanbanModel";
import { resetPhoneKanbanPlaces } from "./phoneKanbanPlace";
import { LONG_PRESS_MS } from "./swipeIntent";

/*
 * The phone's status columns (#2072 slice 4), mounted over the real band
 * projection and the desktop's model. happy-dom lays nothing out, so what the
 * pager's snap and the cards' geometry look like is the browser driver's
 * (`issue1671Evidence.browser.test.tsx`); this suite holds the contract:
 *
 *   - four tabs in the desktop's order, each with the column's count, a
 *     ●working mark and a ⚠needs-you mark, opening on Assigned;
 *   - a tab tap moves the column and writes no history entry;
 *   - what needs the operator is first in its column;
 *   - a long-press opens the card's sheet; Move to moves the card at once,
 *     answers with a receipt whose Undo moves it back, and a refused write puts
 *     it back and says why;
 *   - an empty column says so in the desktop's words and points to the
 *     nearest column with work; Done opens twenty cards at a time;
 *   - a card opens its task, a row no task owns opens its conversation;
 *   - coming back to the board lands on the column and offset it left.
 */

const NOW = 1_800_000_000;
const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Element: dom.Element,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  setLocale("en");
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => {
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  resetPhoneKanbanPlaces();
  roots = [];
  receipts.dismiss();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  receipts.dismiss();
});

const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function file(index: number, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/conversation-${index}.jsonl`, conversationId: `conversation_fixture_${index}`, title: `Conversation ${index}`,
    project: "fixture", root: "claude-projects", kind: "session", fmt: "claude", engine: "claude", mtime: NOW - 600, size: 100,
    activity: "idle", proc: null, pid: null, parent: null, model: "opus", pendingQuestion: null, waitingInput: null, name: `conversation-${index}`,
    ...extra,
  } as FileEntry;
}
const working = (index: number) => file(index, { activity: "live", lastTurn: { startedAt: (NOW - 120) * 1000, endedAt: null }, lastAgentWorkAt: (NOW - 30) * 1000 } as Partial<FileEntry>);
const asking = (index: number) => file(index, {
  pendingQuestion: { kind: "question", toolUseId: `tool-${index}`, transcriptPath: `/fixture/conversation-${index}.jsonl`, pid: 1, paneTarget: null, askedAt: new Date((NOW - 540) * 1000).toISOString(), questions: [{ question: "Which unit file stays?", header: "Unit", multiSelect: false, options: [] }] },
} as Partial<FileEntry>);

function task(id: string, status: TaskStatus, paths: readonly string[] = [], text = `Task ${id}`): BoardTask {
  return {
    id, project: "fixture", text, status, placement: "unplaced", revision: `r-${id}-1`,
    assignments: paths.map((path) => ({ path, conversationId: `conversation_fixture_${path.match(/(\d+)/)![1]}`, panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z",
  } as BoardTask;
}

function layout(files: readonly FileEntry[]): SchemeLayout {
  const nodes = files.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  return {
    nodes, groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [],
    byPath: new Map(nodes.map((node) => [node.file.path, node])), width: files.length * 648, height: 880,
  } as unknown as SchemeLayout;
}

function fakeNav(): { nav: MobileNav; pushes: () => number } {
  const history = fakeHistory("http://localhost/#p=fixture");
  return { nav: createMobileNav(history.host), pushes: history.pushes };
}

/** The flow receipt the shell draws between the body and the dock. */
function Receipt() {
  const receipt = useReceipt();
  return receipt ? <div data-test-receipt="">{receipt.text}{receipt.inverse ? <button type="button" data-test-undo="" onClick={() => receipts.undo()}>undo</button> : null}</div> : null;
}

interface Opened { tasks: string[]; conversations: string[]; pipelines: string[]; shown: string[][] }

function mount(input: { files: FileEntry[]; tasks: BoardTask[]; pipelines?: Pipeline[]; attention?: string[]; ports?: TaskMutationPorts; onHiddenCount?: (count: number) => void; nav?: MobileNav }) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  const opened: Opened = { tasks: [], conversations: [], pipelines: [], shown: [] };
  const { nav, pushes } = input.nav ? { nav: input.nav, pushes: () => 0 } : fakeNav();
  const render = (tasks: BoardTask[]) => flushSync(() => root.render(
    <MobileNavContext.Provider value={nav}>
      <MobileKanban
        layout={layout(input.files)}
        project="fixture"
        groups={[]}
        manual={[]}
        files={input.files}
        flows={[]}
        pipelines={input.pipelines ?? []}
        tasks={[]}
        allTasks={tasks}
        drafts={[]}
        now={NOW}
        seatRefs={null}
        attention={input.attention ?? []}
        mutationPorts={input.ports}
        onOpenTask={(entry) => opened.tasks.push(entry.id)}
        onOpenConversation={(entry) => opened.conversations.push(entry.path)}
        onOpenPipeline={(entry) => opened.pipelines.push(entry.id)}
        onShown={(paths) => opened.shown.push([...paths])}
        onHiddenCount={input.onHiddenCount}
      />
      <Receipt />
    </MobileNavContext.Provider>,
  ));
  render(input.tasks);
  return { host: host as unknown as HTMLElement, nav, pushes, opened, render };
}

const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (element: HTMLElement | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.click());
};
const cardsIn = (host: HTMLElement, status: TaskStatus) => qa(host, `[data-phone-kanban-column="${status}"] [data-phone-card]`).map((card) => card.getAttribute("data-phone-card"));

async function longPress(element: HTMLElement) {
  const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", clientX: 40, clientY: 40, button: 0 };
  flushSync(() => { element.dispatchEvent(new dom.PointerEvent("pointerdown", init) as unknown as Event); });
  await sleep(LONG_PRESS_MS + 60);
  flushSync(() => { element.dispatchEvent(new dom.PointerEvent("pointerup", init) as unknown as Event); });
}

function board() {
  const files = [working(1), file(2), asking(3), file(4), working(5)];
  const tasks = [
    task("a1", "assigned", [files[0]!.path], "Restore /favicon.ico with the Delegatus emblem"),
    task("a2", "assigned", [files[1]!.path]),
    task("i1", "inbox", [files[2]!.path], "Retire the systemd install path"),
    task("i2", "inbox"),
    task("d1", "done", [files[3]!.path]),
  ];
  return { files, tasks };
}

test("four tabs in the desktop's order carry each column's count and its working and needs-you marks, opening on Assigned", () => {
  const { files, tasks } = board();
  const { host } = mount({ files, tasks, attention: [attentionKey.conversation(files[2]!.path)] });
  const tabs = qa(host, "[role=tab]");
  expect(tabs.map((tab) => tab.getAttribute("data-phone-kanban-tab"))).toEqual(["inbox", "assigned", "blocked", "done"]);
  expect(tabs.map((tab) => q(tab, "[data-phone-tab-label]")!.textContent)).toEqual(["Inbox", "Assigned", "Blocked", "Done"]);
  const count = (status: string, mark: string) => q(host, `[data-phone-kanban-tab="${status}"] [${mark}]`)?.getAttribute(mark) ?? null;
  expect([count("inbox", "data-phone-tab-count"), count("assigned", "data-phone-tab-count"), count("blocked", "data-phone-tab-count"), count("done", "data-phone-tab-count")]).toEqual(["2", "2", "0", "1"]);
  expect(count("assigned", "data-phone-tab-working")).toBe("1");
  /* The loose working conversation is drawn in Inbox, so Inbox counts it. */
  expect(count("inbox", "data-phone-tab-working")).toBe("1");
  expect(count("inbox", "data-phone-tab-needs")).toBe("1");
  expect(count("assigned", "data-phone-tab-needs")).toBeNull();
  expect(q(host, "[data-phone-kanban-tab=assigned]")!.getAttribute("aria-selected")).toBe("true");
  expect(q(host, "[data-phone-kanban-tab=assigned]")!.getAttribute("aria-label")).toBe(`Assigned, ${en("mobile2.kanban.tasks", { count: 2 })}, ${en("kanban.columnWorking", { count: 1 })}`);
  /* The needs-you card is first in Inbox, with its badge and its ask. */
  expect(cardsIn(host, "inbox")[0]).toBe("task:i1");
  const first = q(host, '[data-phone-card="task:i1"]')!;
  expect(first.getAttribute("data-edge")).toBe("warning");
  expect(q(first, "[data-phone-card-badge]")!.textContent).toBe(en("mobile2.board.badgeQuestion"));
  expect(q(first, "[data-phone-card-ask]")!.textContent).toContain("Which unit file stays?");
  /* A card with no pipeline says its agents; a card of one working agent says so. */
  expect(q(host, '[data-phone-card="task:a1"] [data-phone-card-agents]')!.textContent).toContain(en("mobile2.kanban.working", { count: 1 }));
  expect(q(host, '[data-phone-card="task:i2"] [data-phone-card-agents]')!.textContent).toContain(en("mobile2.kanban.noAgents"));
  /* The loose working conversation is under Not on a task. */
  expect(q(host, "[data-phone-kanban-unlinked]")!.textContent).toBe(en("kanban.notOnTask", { count: 1 }));
  expect(q(host, `[data-phone-card="lineage:${files[4]!.conversationId}"]`)!.textContent).toContain(en("mobile2.kanban.notOnTask"));
});

test("a tab tap moves the column, writes no history entry, and presence follows the column on screen", () => {
  const { files, tasks } = board();
  const { host, pushes, opened } = mount({ files, tasks });
  expect(opened.shown.at(-1)).toEqual([files[0]!.path, files[1]!.path]);
  click(q(host, "[data-phone-kanban-tab=done]"));
  expect(q(host, "[data-phone-kanban]")!.getAttribute("data-phone-kanban-active")).toBe("done");
  expect(q(host, "[data-phone-kanban-tab=done]")!.getAttribute("aria-selected")).toBe("true");
  expect(q(host, "[data-phone-kanban-tab=assigned]")!.getAttribute("tabindex")).toBe("-1");
  expect(pushes()).toBe(0);
  expect(opened.shown.at(-1)).toEqual([files[3]!.path]);
  /* The session keeps the column for this project. */
  expect(JSON.parse(dom.sessionStorage.getItem("llv.phoneKanban.fixture") ?? "{}").column).toBe("done");
  /* Arrow keys walk the tabs. */
  flushSync(() => { q(host, "[role=tablist]")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event); });
  expect(q(host, "[data-phone-kanban]")!.getAttribute("data-phone-kanban-active")).toBe("blocked");
});

test("a card opens its task, and a row no task owns opens its conversation", () => {
  const { files, tasks } = board();
  const { host, opened } = mount({ files, tasks });
  click(q(host, '[data-phone-card="task:a1"]'));
  expect(opened.tasks).toEqual(["a1"]);
  expect(q(host, '[data-phone-card="task:a1"]')!.getAttribute("aria-label")).toBe(en("mobile2.kanban.openTask", { title: "Restore /favicon.ico with the Delegatus emblem" }));
  click(q(host, `[data-phone-card="lineage:${files[4]!.conversationId}"]`));
  expect(opened.conversations).toEqual([files[4]!.path]);
});

test("a long-press opens the card's sheet; Move to moves the card at once with Undo, and a refused write puts it back and says why", async () => {
  const { files, tasks } = board();
  let refuse = false;
  const patches: Array<{ id: string; body: PatchBody }> = [];
  const ports: TaskMutationPorts = {
    async patch(id, body): Promise<PatchResult> {
      patches.push({ id, body });
      await sleep(5);
      if (refuse) return { ok: false, status: 500, error: "the store is read-only" };
      const stored = tasks.find((entry) => entry.id === id)!;
      return { ok: true, task: { ...stored, ...("status" in body ? { status: body.status } : {}), revision: `${(stored as BoardTask & { revision: string }).revision}+` } as BoardTask };
    },
    async read(id) { return tasks.find((entry) => entry.id === id) ?? null; },
    changed() {},
  };
  const { host, nav, opened } = mount({ files, tasks, ports });
  const card = q(host, '[data-phone-card="task:a2"]')!;
  await longPress(card);
  expect(nav.getState().sheet).toBe("card");
  const sheet = q(dom.document.body as unknown as HTMLElement, "[data-phone-card-sheet]")!;
  const actions = qa(sheet, "[data-phone-card-action]").map((row) => row.getAttribute("data-phone-card-action"));
  expect(actions).toEqual(["move-inbox", "move-blocked", "move-done", "hide", "open-agent"]);
  /* The press opened a sheet, not the task under the finger. */
  expect(opened.tasks).toEqual([]);

  click(q(sheet, '[data-phone-card-action="move-blocked"]'));
  expect(nav.getState().sheet).toBeNull();
  expect(cardsIn(host, "blocked")).toEqual(["task:a2"]);
  expect(cardsIn(host, "assigned")).toEqual(["task:a1"]);
  expect(q(host, "[data-test-receipt]")!.textContent).toContain(en("mobile2.kanban.moved", { column: "Blocked" }));
  await sleep(20);
  expect(patches.map((entry) => [entry.id, (entry.body as { status?: string }).status])).toEqual([["a2", "blocked"]]);

  /* Undo moves it back through the same guarded queue. */
  click(q(host, "[data-test-undo]"));
  expect(cardsIn(host, "assigned").sort()).toEqual(["task:a1", "task:a2"]);
  await sleep(20);
  expect(patches.map((entry) => (entry.body as { status?: string }).status)).toEqual(["blocked", "assigned"]);

  /* A refused move shows at once, then comes back and says why. */
  refuse = true;
  await longPress(q(host, '[data-phone-card="task:a2"]')!);
  click(q(dom.document.body as unknown as HTMLElement, '[data-phone-card-action="move-done"]'));
  expect(cardsIn(host, "done")).toContain("task:a2");
  await sleep(40);
  flushSync(() => {});
  expect(cardsIn(host, "done")).not.toContain("task:a2");
  expect(cardsIn(host, "assigned")).toContain("task:a2");
  expect(q(host, "[data-test-receipt]")!.textContent).toContain("the store is read-only");
});

test("a card sheet that comes back without its card (a reload, #2105) closes, and its entry goes with it", async () => {
  const { files, tasks } = board();
  /* The tab stands on the card sheet's entry, and nothing has chosen a card:
     what a reload leaves behind. */
  const history = fakeHistory("http://localhost/#p=fixture");
  const nav = createMobileNav(history.host);
  nav.openSheet("card");
  expect(history.index()).toBe(1);
  mount({ files, tasks, nav });
  expect(nav.getState().sheet).toBeNull();
  expect(q(dom.document.body as unknown as HTMLElement, "[data-phone-card-sheet]")).toBeNull();
  await sleep(0);
  expect(history.index()).toBe(0);
  expect(history.state()).toMatchObject({ mobile2: { sheet: null } });
});

test("an empty column says so in the desktop's words and points to the nearest column with work", () => {
  const { files, tasks } = board();
  const { host } = mount({ files, tasks });
  const blocked = q(host, "[data-phone-kanban-empty=blocked]")!;
  expect(blocked.textContent).toContain(en("kanban.empty.blocked.title"));
  expect(blocked.textContent).toContain(en("kanban.empty.blocked.body"));
  const nearest = q(blocked, "[data-phone-kanban-nearest]")!;
  expect(nearest.getAttribute("data-phone-kanban-nearest")).toBe("assigned");
  expect(nearest.textContent).toContain(en("mobile2.kanban.tasks", { count: 2 }));
  click(nearest);
  expect(q(host, "[data-phone-kanban]")!.getAttribute("data-phone-kanban-active")).toBe("assigned");
});

test("Done opens twenty cards at a time and counts them all", () => {
  const files = Array.from({ length: 45 }, (_, index) => file(index + 1, { lastAgentWorkAt: (NOW - (index + 1) * 60) * 1000 } as Partial<FileEntry>));
  const tasks = files.map((entry, index) => task(`d${index + 1}`, "done", [entry.path]));
  const { host } = mount({ files, tasks });
  expect(q(host, "[data-phone-kanban-tab=done] [data-phone-tab-count]")!.textContent).toBe("45");
  expect(cardsIn(host, "done")).toHaveLength(20);
  const more = q(host, "[data-phone-kanban-more]")!;
  expect(more.textContent).toBe(en("mobile2.kanban.showMore", { count: 20 }));
  click(more);
  expect(cardsIn(host, "done")).toHaveLength(40);
  click(q(host, "[data-phone-kanban-more]"));
  expect(cardsIn(host, "done")).toHaveLength(45);
  expect(q(host, "[data-phone-kanban-more]")).toBeNull();
});

test("a card whose pipeline waits on the operator says the lane's state and draws the chain", () => {
  const files = [file(1)];
  const parked = {
    id: "parked", task: "Mobile data: stop repeated full-board downloads", project: "fixture", state: "needs_decision", taskIds: ["t1"],
    cursor: { stageId: "implement", state: "needs_decision", input: null, activatedBy: null },
    stages: [
      { id: "implement", kind: "run", prompt: "", next: "review", effectiveRole: {} },
      { id: "review", kind: "run", prompt: "", next: null, effectiveRole: {} },
    ],
    runs: [{ stageId: "implement", attempts: [{ n: 1, state: "needs_decision", startedAt: new Date((NOW - 2_460) * 1000).toISOString(), completedAt: new Date((NOW - 2_460) * 1000).toISOString(), effectiveRole: {}, verdict: { status: "fail", findings: ["The delta chain is rebuilt on the request thread"] } }] }],
    createdAt: "2026-09-14T10:00:00.000Z",
  } as unknown as Pipeline;
  const { host } = mount({ files, tasks: [task("t1", "assigned", [files[0]!.path], "Mobile data: stop repeated full-board downloads and hidden-tab traffic")], pipelines: [parked], attention: [attentionKey.pipeline("parked")] });
  const card = q(host, '[data-phone-card="task:t1"]')!;
  expect(card.getAttribute("data-edge")).toBe("warning");
  expect(q(card, "[data-phone-card-badge]")!.getAttribute("data-pstate")).toBe("needs_decision");
  expect(q(card, '[data-density="card"]')!.getAttribute("data-pipeline")).toBe("parked");
  expect(q(host, "[data-phone-kanban-tab=assigned] [data-phone-tab-needs]")!.textContent).toBe("1");
});

test("coming back to the board lands on the column and the offset the operator left (§3.7)", () => {
  const files = Array.from({ length: 30 }, (_, index) => file(index + 1, { lastAgentWorkAt: (NOW - (index + 1) * 60) * 1000 } as Partial<FileEntry>));
  const tasks = files.map((entry, index) => task(`d${index + 1}`, "done", [entry.path]));
  const first = mount({ files, tasks });
  click(q(first.host, "[data-phone-kanban-tab=done]"));
  const page = q(first.host, '[data-phone-kanban-column="done"]')!;
  page.scrollTop = 240;
  flushSync(() => { page.dispatchEvent(new dom.Event("scroll", { bubbles: false }) as unknown as Event); });
  /* A conversation pushed over the board unmounts it. */
  for (const root of roots.splice(0)) flushSync(() => root.unmount());

  const again = mount({ files, tasks });
  expect(q(again.host, "[data-phone-kanban]")!.getAttribute("data-phone-kanban-active")).toBe("done");
  expect(q(again.host, '[data-phone-kanban-column="done"]')!.scrollTop).toBe(240);
  /* A fresh load of the tab reads the column back from the session. */
  resetPhoneKanbanPlaces();
  expect(JSON.parse(dom.sessionStorage.getItem("llv.phoneKanban.fixture") ?? "{}").column).toBe("done");
});

/* #2098: search and the hidden tasks left the top of the board for ⋯. The
   columns draw ⋯ › Hidden tasks: the groups hidden from them, newest first,
   then the empty tasks taken off the board, each with Show. */
test("⋯ › Hidden tasks lists what the columns do not draw, and Show brings a group back", async () => {
  const { files } = board();
  const hiddenAt = new Date((NOW - 300) * 1000).toISOString();
  const tasks = [
    task("a1", "assigned", [files[0]!.path]),
    { ...task("h1", "assigned", [files[1]!.path], "Hidden while the export settles"), groupHidden: { at: hiddenAt, by: "operator" } } as BoardTask,
    { ...task("e1", "inbox", [], "Nothing was started on this one"), board: "hidden" } as BoardTask,
  ];
  const patches: Array<{ id: string; body: PatchBody }> = [];
  const ports: TaskMutationPorts = {
    async patch(id, body): Promise<PatchResult> {
      patches.push({ id, body });
      return { ok: true, task: { ...tasks.find((entry) => entry.id === id)!, revision: "r-next" } as BoardTask };
    },
    async read(id) { return tasks.find((entry) => entry.id === id) ?? null; },
    changed() {},
  };
  const counts: number[] = [];
  const { host, nav } = mount({ files, tasks, ports, onHiddenCount: (count) => counts.push(count) });
  expect(cardsIn(host, "assigned")).toEqual(["task:a1"]);
  expect(counts.at(-1)).toBe(2);

  flushSync(() => nav.openSheet("hidden"));
  const sheet = q(dom.document.body as unknown as HTMLElement, "[data-phone-hidden-sheet]")!;
  expect(sheet.getAttribute("data-phone-hidden-sheet")).toBe("2");
  expect(qa(sheet, "[data-phone-hidden-row]").map((row) => row.getAttribute("data-phone-hidden-row"))).toEqual(["h1", "e1"]);
  const group = q(sheet, '[data-phone-hidden-row="h1"]')!;
  expect(group.textContent).toContain("Hidden while the export settles");
  expect(group.textContent).toContain(en("kanban.trayGroupMeta", { who: en("kanban.hiddenBy.operator"), age: "5m" }));
  expect(q(sheet, '[data-phone-hidden-row="e1"]')!.textContent).toContain(en("kanban.offBoardMeta"));
  /* A project's own board names no project on its rows. */
  expect(q(sheet, "[data-phone-card-project]")).toBeNull();

  click(q(group, "[data-phone-hidden-show]"));
  await sleep(10);
  expect(patches.map((entry) => [entry.id, (entry.body as { hide?: boolean }).hide])).toEqual([["h1", false]]);
  /* Shown at once: the group is back in its column before the write answers. */
  expect(cardsIn(host, "assigned")).toEqual(expect.arrayContaining(["task:a1", "task:h1"]));
});
