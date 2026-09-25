import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { KanbanBoard } from "./kanban/KanbanBoard";
import { resetOrchestratorSeatCacheForTests } from "./orchestrator/useOrchestratorSeat";
import { OverviewBoard } from "./OverviewBoard";

/*
 * Issue #1820 — the Overview is the kanban board a project renders, over every
 * project, showing only the cards a worker is working on right now.
 *
 * The production page is mounted here: `OverviewBoard` → `OverviewKanban` →
 * `KanbanBoard`, with no board, model or card of this file's own. Nothing on
 * disk is read and no route is called: the fixtures below are three invented
 * projects and their invented conversations.
 *
 * The one route it answers is the cross-project seat read (#1841): the
 * Overview spans every project, so it reads every project's seat conversations
 * and keeps them — and the tasks that exist only for them — off its columns and
 * out of its hidden count.
 *
 * It also carries #699's structural lesson onto the surface that replaced the
 * project-summary grid: nothing that navigates is nested inside anything else
 * that navigates, and the card itself never is a target.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  requestAnimationFrame: (callback: (t: number) => void) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  fetch: (async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/seat?")) {
      seatReads += 1;
      return { ok: true, status: 200, json: async () => ({ all: seatAnswer ?? SEAT_ANSWER }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }) as unknown as typeof fetch,
  matchMedia: (query: string) => ({
    matches: false,
    media: String(query),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  }),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
let seatReads = 0;
/* The seat record's answer for one test; null answers SEAT_ANSWER. */
let seatAnswer: unknown = null;
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; seatReads = 0; seatAnswer = null; resetOrchestratorSeatCacheForTests(); });
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

/* Three invented projects. Canonical keys on the left, what the operator
   reads on the right. */
const LEDGER = "-work-acme-ledger";
const ATLAS = "-work-dune-atlas";
const MESH = "-work-river-mesh";
const NAMES = { [LEDGER]: "acme-ledger", [ATLAS]: "dune-atlas", [MESH]: "river-mesh" };

const NOW = 1_800_000_000;
/* Assembled, never written out: the publication gate reads a UUID literal in
   a public file as a resource identifier, invented or not. */
const REVISION = ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-");

function fileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: LEDGER,
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 30,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function task(id: string, project: string, status: TaskStatus, text: string, path: string | null): BoardTask {
  return {
    id,
    project,
    text,
    status,
    placement: "unplaced",
    assignments: path
      ? [{ path, conversationId: null, panePid: null, state: "delivered", error: null, at: "2026-09-18T10:00:00.000Z" }]
      : [],
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    revision: REVISION,
  } as BoardTask;
}

/* A turn that never closed on a live transcript is the ONE piece of evidence
   the board's «N working» counter reads (#1803). A finished conversation
   carries a closed turn and is not working, however fresh it is. */
const workingTurn = { startedAt: (NOW - 120) * 1000, endedAt: null };
const finishedTurn = { startedAt: (NOW - 600) * 1000, endedAt: (NOW - 300) * 1000 };

const FILES: FileEntry[] = [
  fileEntry({ path: "/sessions/ledger-live.jsonl", project: LEDGER, title: "Builder", activity: "live", lastTurn: workingTurn }),
  fileEntry({ path: "/sessions/ledger-done.jsonl", project: LEDGER, title: "Retired builder", activity: "live", lastTurn: finishedTurn }),
  fileEntry({ path: "/sessions/atlas-live.jsonl", project: ATLAS, title: "Reviewer", activity: "live", lastTurn: workingTurn }),
  fileEntry({ path: "/sessions/mesh-live.jsonl", project: MESH, title: "Planner", activity: "live", lastTurn: workingTurn }),
];

const TASKS: BoardTask[] = [
  task("t-ledger", LEDGER, "assigned", "Reconcile the ledger export", "/sessions/ledger-live.jsonl"),
  task("t-ledger-quiet", LEDGER, "assigned", "Archive last quarter", "/sessions/ledger-done.jsonl"),
  task("t-atlas", ATLAS, "inbox", "Redraw the atlas legend", "/sessions/atlas-live.jsonl"),
  task("t-mesh", MESH, "blocked", "Unblock the mesh migration", "/sessions/mesh-live.jsonl"),
  task("t-empty", MESH, "done", "Nothing runs on this one", null),
];

/* The live seat of one project and the retired seat of another, as the seat
   records name them. */
const LEDGER_SEAT = "/sessions/ledger-seat.jsonl";
const MESH_RETIRED_SEAT = "/sessions/mesh-seat-old.jsonl";
const SEAT_ANSWER = {
  conversationIds: [],
  paths: [LEDGER_SEAT],
  previous: { conversationIds: [], paths: [MESH_RETIRED_SEAT] },
};
/* The live seat has a transcript and is working, so without the seat read it
   draws a card in Assigned. The retired seat's transcript is long gone and its
   task carries the empty-band preference every legacy row was given, so the
   board resolves no band for it and it lands in the hidden tray — which is
   exactly where the Overview used to name every seat it had ever had. One
   ordinary task sits there for the same reason, and stays. */
const SEAT_FILES: FileEntry[] = [
  ...FILES,
  fileEntry({ path: LEDGER_SEAT, project: LEDGER, title: "Orchestrator seat", activity: "live", lastTurn: workingTurn }),
];
const offBoard = (row: BoardTask): BoardTask => ({ ...row, board: "hidden" });
const SEAT_TASKS: BoardTask[] = [
  ...TASKS,
  task("t-seat-ledger", LEDGER, "assigned", "Orchestrator seat, launch week", LEDGER_SEAT),
  offBoard(task("t-seat-mesh", MESH, "assigned", "Manager seat, release week", MESH_RETIRED_SEAT)),
  offBoard(task("t-gone", MESH, "assigned", "Nothing runs on this one either", null)),
];

interface Taps { projects: string[] }

function mount(files: FileEntry[], tasks: BoardTask[]): { host: HTMLElement; taps: Taps } {
  const taps: Taps = { projects: [] };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <OverviewBoard
      files={files}
      projectCatalog={[]}
      projectDisplayNames={NAMES}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      tasks={tasks}
      flows={[]}
      loaded
      now={NOW}
      onSelectProject={(project) => taps.projects.push(project)}
    />,
  ));
  roots.push(root);
  return { host: host as unknown as HTMLElement, taps };
}

/* One project's own board, mounted straight, so the two narrowings can be
   compared on the same component: the Overview passes `overview`, a project
   does not. */
function mountProjectBoard(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <KanbanBoard
      project={LEDGER}
      groups={[]}
      manual={[]}
      files={[]}
      flows={[]}
      pipelines={[]}
      tasks={[task("t-own", LEDGER, "inbox", "Reconcile the ledger export", null)]}
      allTasks={[task("t-own", LEDGER, "inbox", "Reconcile the ledger export", null)]}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
    />,
  ));
  roots.push(root);
  return host as unknown as HTMLElement;
}

/* Type into the board's own find box, the way the operator does — and the way
   the project board's own test does it: under happy-dom the `input` alone
   leaves React's state update pending, and the keydown behind it flushes. */
function search(host: HTMLElement, query: string): void {
  const input = host.querySelector<HTMLInputElement>("[data-kanban-search]")!;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, query);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "s", bubbles: true }) as unknown as Event);
  });
}

const cardIds = (host: HTMLElement) => [...host.querySelectorAll(".card")].map((card) => (card as HTMLElement).dataset.id ?? "");
const cardOf = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`.card[data-id="task:${id}"]`);
const columnOf = (host: HTMLElement, id: string) => cardOf(host, id)?.closest<HTMLElement>(".column")?.dataset.status ?? null;
const chipOf = (host: HTMLElement, id: string) => cardOf(host, id)?.querySelector<HTMLElement>("[data-project-chip]") ?? null;

test("one set of columns carries the working cards of three projects, each labelled with its own", () => {
  const { host } = mount(FILES, TASKS);

  /* One board, four columns — the project board's own, not a column per
     project. */
  expect([...host.querySelectorAll(".column")].map((column) => (column as HTMLElement).dataset.status)).toEqual(["inbox", "assigned", "blocked", "done"]);

  expect(columnOf(host, "t-atlas")).toBe("inbox");
  expect(columnOf(host, "t-ledger")).toBe("assigned");
  expect(columnOf(host, "t-mesh")).toBe("blocked");

  expect(chipOf(host, "t-ledger")?.textContent).toBe("acme-ledger");
  expect(chipOf(host, "t-atlas")?.textContent).toBe("dune-atlas");
  expect(chipOf(host, "t-mesh")?.textContent).toBe("river-mesh");
});

test("a card with nobody working on it is absent, whichever column it belongs to", () => {
  const { host } = mount(FILES, TASKS);

  /* A conversation whose turn closed: the board counts it as not working, and
     the Overview shows it nowhere. */
  expect(cardOf(host, "t-ledger-quiet")).toBeNull();
  /* A task with no agent at all. */
  expect(cardOf(host, "t-empty")).toBeNull();
  expect(cardIds(host).sort()).toEqual(["task:t-atlas", "task:t-ledger", "task:t-mesh"]);

  /* Narrowed, and the column head says so rather than pretending the board
     holds three tasks in all. */
  const assigned = host.querySelector<HTMLElement>(".column[data-status='assigned'] .col-head .n");
  expect(assigned?.textContent).toBe("1 of 2");
});

test("the card's project label opens that project's own board", () => {
  const { host, taps } = mount(FILES, TASKS);

  flushSync(() => chipOf(host, "t-mesh")!.click());
  expect(taps.projects).toEqual([MESH]);
});

test("what needs one project to write into is absent, never faked", () => {
  const { host } = mount(FILES, TASKS);

  /* «+ Task» and «+ Agent» would each have to choose a project for the
     operator; the orchestrator seat is one project's chair. */
  expect(host.querySelector("[data-new-task]")).toBeNull();
  expect(host.querySelector("[data-new-agent]")).toBeNull();
  expect(host.querySelector("[data-kanban-seat]")).toBeNull();
  expect(host.querySelector(".card [data-add-agent]")).toBeNull();

  /* The board that is there is the whole board: search, the hidden tray and
     the card's ⋯, whose "Move to" writes with the card's own project. The
     column names the status, so the card draws no pill of its own (#2148). */
  expect(host.querySelector("[data-kanban-search]")).toBeTruthy();
  expect(host.querySelector("[data-hidden-pill]")).toBeTruthy();
  expect(cardOf(host, "t-ledger")?.querySelector(".foot .pill")).toBeNull();
  flushSync(() => cardOf(host, "t-ledger")!.querySelector<HTMLElement>("[data-menu]")!.click());
  expect([...host.querySelectorAll('.menu [role="menuitemradio"]')].slice(0, 4).map((item) => item.textContent)).toEqual(["Inbox", "Assigned", "Blocked", "Done"]);
});

test("the Overview's bar keeps its three facts; the project board's bar, put in order (#1801), says each once", () => {
  const { host } = mount(FILES, TASKS);
  const summary = (root: HTMLElement) => root.querySelector<HTMLElement>(".bar .summary")?.textContent ?? "";

  /* Three live turns across three projects; the task count is the board's, before the narrowing. */
  expect(summary(host)).toContain(translate("en", "kanban.overviewWorking", { count: 3 }));
  expect(summary(host)).toContain(translate("en", "kanban.overviewTasks", { count: 5 }));

  /* The project's own board keeps only who is working: the waiting signal and the
     task count live elsewhere on its bar and its columns. */
  const project = mountProjectBoard();
  expect(summary(project)).toBe(translate("en", "kanban.summaryWorking", { count: 0 }));
});

test("nothing that navigates is nested inside anything else that navigates (#699)", () => {
  const { host } = mount(FILES, TASKS);

  const card = cardOf(host, "t-ledger")!;
  expect(card.tagName.toLowerCase()).toBe("article");
  expect(card.getAttribute("role")).toBeNull();

  const interactive = [...host.querySelectorAll("button, [role='link'], [role='button'], a")] as unknown as HTMLElement[];
  expect(interactive.length).toBeGreaterThan(0);
  for (const element of interactive) {
    expect((element.parentElement as HTMLElement | null)?.closest("button, [role='link'], [role='button'], a")).toBeNull();
  }
});

test("an installation with projects but nothing working keeps the board and says so", () => {
  const quiet = FILES.map((file) => ({ ...file, activity: "idle" as const, lastTurn: finishedTurn }));
  const { host } = mount(quiet, TASKS);

  expect(cardIds(host)).toEqual([]);
  expect(host.querySelector("[data-testid='overview-first-run']")).toBeNull();
  expect(host.textContent).toContain(en["overview.workingOnly"]);

  /* The board is empty because of the Overview's own permanent filter, and
     the operator typed no search: every column names the filter and none of
     them offers advice about a search that was never made (#696). */
  for (const status of ["inbox", "assigned", "blocked", "done"]) {
    const empty = host.querySelector(`.column[data-status='${status}'] .empty`)?.textContent ?? "";
    expect(empty).toContain(en["overview.noneWorking"]);
    expect(empty).toContain(en["overview.noneWorkingHint"]);
    expect(empty).not.toContain(en["kanban.noMatch"]);
    expect(empty).not.toContain(en["kanban.noMatchHint"]);
  }
});

test("a search that finds nothing still says so — on the Overview, and on a project's own board", () => {
  const { host } = mount(FILES, TASKS);
  search(host, "nothing matches this");

  expect(cardIds(host)).toEqual([]);
  const overviewEmpty = host.querySelector(".column[data-status='assigned'] .empty")?.textContent ?? "";
  expect(overviewEmpty).toContain(en["kanban.noMatch"]);
  expect(overviewEmpty).toContain(en["kanban.noMatchHint"]);
  expect(overviewEmpty).not.toContain(en["overview.noneWorking"]);

  /* The same board without the Overview's inputs — one project, no filter —
     keeps the search copy it has always drawn, and keeps its own empty copy
     when nothing is narrowing it at all. */
  const project = mountProjectBoard();
  expect(project.querySelector(".column[data-status='blocked'] .empty")?.textContent).toContain(en["kanban.empty.blocked.title"]);
  search(project, "nothing matches this");
  const projectEmpty = project.querySelector(".column[data-status='inbox'] .empty")?.textContent ?? "";
  expect(projectEmpty).toContain(en["kanban.noMatch"]);
  expect(projectEmpty).toContain(en["kanban.noMatchHint"]);
  expect(projectEmpty).not.toContain(en["overview.noneWorking"]);
});

test("a first run has no projects, so it keeps its own panel and mounts no board", () => {
  const { host } = mount([], []);

  expect(host.querySelector("[data-testid='overview-first-run']")).toBeTruthy();
  expect(host.querySelector("[data-kanban-board]")).toBeNull();
  expect(host.textContent).toContain(en["overview.firstRunTitle"]);
});

/* #1841 — a seat belongs to the seat panel of its own project's board, and to
   no task list. The Overview spans every project, so it needs every project's
   seats; the count it draws first is its hidden one. */
test("the Overview draws no seat card and counts no seat task as hidden (#1841)", async () => {
  const { host } = mount(SEAT_FILES, SEAT_TASKS);

  /* Before the read answers, nothing is hidden on a guess: the live seat has
     its card and the retired seat's task sits in the hidden count beside the
     genuinely empty task. */
  expect(cardIds(host)).toContain("task:t-seat-ledger");
  expect(host.querySelector("[data-hidden-pill]")?.getAttribute("data-count")).toBe("2");
  expect(host.querySelector("[data-hidden-pill]")?.textContent).toContain("2");

  await settle();
  await settle();
  flushSync(() => undefined);

  expect(seatReads).toBeGreaterThan(0);
  expect(cardIds(host)).not.toContain("task:t-seat-ledger");
  /* One left: the task with nothing on it, which is what the tray is for. */
  expect(host.querySelector("[data-hidden-pill]")?.getAttribute("data-count")).toBe("1");
  flushSync(() => (host.querySelector("[data-hidden-pill]") as HTMLElement).dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event));
  const tray = dom.document.body.textContent ?? "";
  expect(tray).toContain("Nothing runs on this one either");
  expect(tray).not.toContain("Manager seat, release week");
  expect(tray).not.toContain("Orchestrator seat, launch week");
  /* The project's own work is untouched by the same answer. */
  expect(cardIds(host)).toContain("task:t-ledger");
});

/* #2166 §3.5: before any orchestrator exists on this install, the Overview
   leads with one band that opens the guide on its orchestrator step. It
   reads the same cross-project seat record the board reads, in one poll, and
   shows nothing until that record has answered. */
test("with no seat on the install the Overview leads with the orchestrator band, and with one it does not", async () => {
  seatAnswer = { conversationIds: [], paths: [], previous: { conversationIds: [], paths: [] } };
  const { host } = mount(FILES, TASKS);
  /* Nothing on a guess: the record has not answered yet. */
  expect(host.querySelector("[data-overview-orchestrator-band]")).toBeNull();

  await settle();
  await settle();
  flushSync(() => undefined);

  const band = host.querySelector("[data-overview-orchestrator-band]") as HTMLElement;
  expect(band).not.toBeNull();
  expect(band.textContent).toContain("Start with an orchestrator");
  expect(band.textContent).toContain(en["orchPanel.intro"]);
  /* The band and the board read the record through one poll. */
  expect(seatReads).toBe(1);
  const opened: unknown[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  dom.addEventListener("llv:open-onboarding", listen as never);
  /* The guide opens on a window event: this window's own CustomEvent. */
  const savedCustomEvent = G.CustomEvent;
  G.CustomEvent = dom.CustomEvent;
  try {
    const create = band.querySelector("[data-overview-orchestrator-create]") as HTMLButtonElement;
    expect(create.textContent).toContain("Create an orchestrator");
    flushSync(() => create.click());
  } finally {
    G.CustomEvent = savedCustomEvent;
    dom.removeEventListener("llv:open-onboarding", listen as never);
  }
  expect(opened).toEqual([{ mode: "guide", step: "tour" }]);
});

test("a seat anywhere on the install, even a retired one, keeps the band away", async () => {
  for (const answer of [SEAT_ANSWER, { conversationIds: [], paths: [], previous: { conversationIds: ["c-retired"], paths: [] } }]) {
    dom.document.body.replaceChildren();
    resetOrchestratorSeatCacheForTests();
    seatAnswer = answer;
    const { host } = mount(FILES, TASKS);
    await settle();
    await settle();
    flushSync(() => undefined);
    expect(seatReads).toBeGreaterThan(0);
    expect(host.querySelector("[data-overview-orchestrator-band]")).toBeNull();
  }
});
