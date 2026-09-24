import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { PipelinePorts } from "@/components/kanban/pipelinePorts";
import type { PatchBody, PatchResult, TaskMutationPorts } from "@/components/kanban/useTaskMutations";
import type { SchemeLayout } from "@/components/scheme/layout";
import type { setLocale as SetLocale, translate as Translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";


/*
 * The task screen itself (#2072 slice 5, phone-kanban §3.5), mounted over the
 * real band projection and the desktop's model. The doors into it and what
 * its blocks and rows open are the dashboard's (`MobileTaskScreen.entry`);
 * this suite holds the screen's own contract:
 *
 *   - a task with seven pipelines: what needs the operator first, then
 *     running, provisioning and paused, the three completed behind one row;
 *   - the parked lane answers in place with the phone's 44 px buttons;
 *   - the status is a sheet, and a choice moves the task through the guarded
 *     mutation with a receipt whose Undo moves it back;
 *   - the title is edited in place and written as the task's text.
 */

const NOW = 1_800_000_000;
const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Element: dom.Element,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, FocusEvent: dom.FocusEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
/* The DOM is in place before React loads: react-dom decides at load time
   whether the page has one, and without it typing never reaches onChange. */
for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { setLocale, translate } = await import("@/lib/i18n") as { setLocale: typeof SetLocale; translate: typeof Translate };
const { createPendingPipelineActs } = await import("./MobilePipelineScreen");
const { receipts, useReceipt } = await import("./MobileReceipt");
const { MobileTaskScreen } = await import("./MobileTaskScreen");
const { createMobileNav, MobileNavContext } = await import("./mobileNav");
setLocale("en");
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => {
  dom.document.body.replaceChildren();
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
const iso = (ago: number) => new Date((NOW - ago) * 1000).toISOString();

function file(index: number, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/conversation-${index}.jsonl`, conversationId: `conversation_fixture_${index}`, title: `Conversation ${index}`,
    project: "fixture", root: "claude-projects", kind: "session", fmt: "claude", engine: "claude", mtime: NOW - 600, size: 100,
    activity: "idle", proc: null, pid: null, parent: null, model: "opus", pendingQuestion: null, waitingInput: null, name: `conversation-${index}`,
    ...extra,
  } as FileEntry;
}

const role = { roleId: "builder", access: "read-write", promptScaffold: null };
function lane(id: string, state: Pipeline["state"], cursorState: string | null, ago: number, over: Record<string, unknown> = {}): Pipeline {
  const attempt = cursorState ? [{ stageId: "implement", attempts: [{
    n: 1, state: cursorState, startedAt: iso(ago + 300), completedAt: cursorState === "running" ? null : iso(ago), effectiveRole: role, activatedBy: null,
    verdict: cursorState === "needs_decision" ? { status: "fail", findings: ["The delta chain is rebuilt on the request thread."] } : null,
  }] }] : [];
  return {
    id, task: `Lane ${id}`, taskIds: ["t-many"], project: "fixture", repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `lane/${id}`,
    baseBranch: "main", baseRef: "main", lastPassedCommit: "", state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: iso(ago + 600), closedAt: state === "completed" ? iso(ago) : null,
    cursor: cursorState ? { stageId: "implement", state: cursorState, input: null, activatedBy: null } : null,
    stages: [{ id: "implement", kind: "run", effectiveRole: role, next: "review" }, { id: "review", kind: "run", effectiveRole: role, next: null }],
    runs: attempt,
    ...over,
  } as unknown as Pipeline;
}

const pipelines = [
  lane("running-a", "running", "running", 420),
  lane("done-a", "completed", "passed", 3_600),
  lane("paused-a", "paused", "passed", 7_200),
  lane("parked", "needs_decision", "needs_decision", 2_460),
  lane("done-b", "completed", "passed", 5_400),
  lane("provisioning-a", "provisioning", null, 60),
  lane("done-c", "completed", "passed", 9_000),
];

const theTask = {
  id: "t-many", project: "fixture", status: "assigned", placement: "unplaced", revision: "r-t-many-1",
  text: "Kanban: say what each pipeline of a task does\nThe phone names each lane of a task by its first prompt line.",
  assignments: [], createdAt: iso(86_400), updatedAt: iso(3_600),
} as unknown as BoardTask;

function layout(files: readonly FileEntry[]): SchemeLayout {
  const nodes = files.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  return {
    nodes, groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [],
    byPath: new Map(nodes.map((node) => [node.file.path, node])), width: files.length * 648, height: 880,
  } as unknown as SchemeLayout;
}

function Receipt() {
  const receipt = useReceipt();
  return receipt ? <div data-test-receipt="">{receipt.text}{receipt.inverse ? <button type="button" data-test-undo="" onClick={() => receipts.undo()}>undo</button> : null}</div> : null;
}

function mount(ports: TaskMutationPorts, pipelinePorts: PipelinePorts, subject: BoardTask = theTask) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  const nav = createMobileNav({
    history: { state: null, pushState() {}, replaceState() {}, back() {} },
    href: () => "http://localhost/",
    onPopstate: () => () => {},
  });
  nav.push({ kind: "task", id: subject.id });
  const files = [file(1)];
  flushSync(() => root.render(
    <MobileNavContext.Provider value={nav}>
      <MobileTaskScreen
        taskId={subject.id}
        layout={layout(files)}
        project="fixture"
        groups={[]}
        manual={[]}
        files={files}
        flows={[]}
        pipelines={pipelines}
        tasks={[]}
        allTasks={[subject]}
        drafts={[]}
        now={NOW}
        seatRefs={null}
        mutationPorts={ports}
        acts={createPendingPipelineActs()}
        ports={pipelinePorts}
        onOpenConversation={() => {}}
        onOpenPipeline={() => {}}
      />
      <Receipt />
    </MobileNavContext.Provider>,
  ));
  return { host: host as unknown as HTMLElement, nav };
}

const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (element: HTMLElement | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.click());
};

function taskPorts(patches: Array<{ id: string; body: PatchBody }>, refuse = () => false): TaskMutationPorts {
  let stored = theTask;
  return {
    async patch(id, body): Promise<PatchResult> {
      patches.push({ id, body });
      await sleep(5);
      if (refuse()) return { ok: false, status: 500, error: "the store is read-only" };
      stored = { ...stored, ...("status" in body ? { status: body.status } : {}), ...("text" in body ? { text: body.text } : {}), revision: `${(stored as BoardTask & { revision: string }).revision}+` } as BoardTask;
      return { ok: true, task: stored };
    },
    async read() { return stored; },
    changed() {},
  };
}
const noPipelinePorts: PipelinePorts = {
  async read() { return null; },
  async patch(_id, _body) { return { ok: false, status: 500, error: "not in this test" }; },
  refresh() {},
};

test("seven pipelines: the parked one first, then running, provisioning and paused, the three completed behind one row", () => {
  const { host } = mount(taskPorts([]), noPipelinePorts);
  const lanes = () => qa(host, "[data-phone-task-lane]").map((element) => element.getAttribute("data-phone-task-lane"));
  expect(lanes()).toEqual(["parked", "running-a", "provisioning-a", "paused-a"]);
  expect(q(host, '[data-phone-task-lane="parked"]')!.getAttribute("data-needs")).toBe("1");
  const fold = q(host, "[data-phone-task-ended]")!;
  expect(fold.getAttribute("data-phone-task-ended")).toBe("3");
  expect(fold.textContent).toContain(en("mobile2.pipelines.completed", { count: 3 }));
  click(fold);
  expect(lanes()).toEqual(["parked", "running-a", "provisioning-a", "paused-a", "done-a", "done-b", "done-c"]);
  /* The bar says where the task stands. */
  expect(q(host, "[data-phone-task-context]")!.textContent).toBe(`${en("kanban.status.assigned")} · ${en("mobile2.task.pipelines", { count: 7 })}`);
  /* The title whole, the description one line. */
  expect(q(host, "[data-phone-task-title]")!.textContent).toBe("Kanban: say what each pipeline of a task does");
  expect(q(host, "[data-phone-task-description]")!.textContent).toContain("The phone names each lane of a task by its first prompt line.");
});

test("the parked lane answers in place with the phone's Skip stage and Retry stage", () => {
  const { host } = mount(taskPorts([]), noPipelinePorts);
  const answers = qa(host, '[data-phone-task-lane="parked"] [data-answer-action]');
  expect(answers.map((button) => button.getAttribute("data-answer-action"))).toEqual(["skip-stage", "retry-stage"]);
  expect(answers.map((button) => button.textContent)).toEqual([en("mobile2.pipeline.skip"), en("mobile2.pipeline.retry")]);
  expect(q(host, '[data-phone-task-lane="parked"] .pb-actions.large')).not.toBeNull();
  /* Only the parked lane answers. */
  expect(qa(host, "[data-answer-action]")).toHaveLength(2);
});

test("the status is a sheet: a choice moves the task with a guarded write and a receipt whose Undo moves it back", async () => {
  const patches: Array<{ id: string; body: PatchBody }> = [];
  const { host, nav } = mount(taskPorts(patches), noPipelinePorts);
  const pill = q(host, "[data-phone-task-status-pill]")!;
  expect(pill.getAttribute("data-phone-task-status-pill")).toBe("assigned");
  click(pill);
  expect(nav.getState().sheet).toBe("status");
  const sheet = q(dom.document.body as unknown as HTMLElement, "[data-phone-task-status-sheet]")!;
  expect(qa(sheet, "[data-phone-task-status]").map((row) => row.getAttribute("data-phone-task-status"))).toEqual(["inbox", "assigned", "blocked", "done"]);
  click(q(sheet, '[data-phone-task-status="blocked"]'));
  expect(nav.getState().sheet).toBeNull();
  expect(q(host, "[data-phone-task-status-pill]")!.getAttribute("data-phone-task-status-pill")).toBe("blocked");
  expect(q(host, "[data-test-receipt]")!.textContent).toContain(en("mobile2.kanban.moved", { column: en("kanban.status.blocked") }));
  await sleep(20);
  expect(patches).toHaveLength(1);
  expect(patches[0]!.body).toMatchObject({ status: "blocked", expectedRevision: "r-t-many-1" });
  click(q(host, "[data-test-undo]"));
  expect(q(host, "[data-phone-task-status-pill]")!.getAttribute("data-phone-task-status-pill")).toBe("assigned");
  await sleep(20);
  expect(patches.map((entry) => (entry.body as { status?: string }).status)).toEqual(["blocked", "assigned"]);
});

test("the title is edited in place and written as the task's text, the description kept", async () => {
  const patches: Array<{ id: string; body: PatchBody }> = [];
  const { host } = mount(taskPorts(patches), noPipelinePorts);
  click(q(host, "[data-phone-task-title]"));
  const field = q(host, '[data-phone-task-editor="title"] textarea') as unknown as HTMLTextAreaElement;
  expect(field).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(field, "Name every pipeline row by its first prompt line");
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  click(q(host, "[data-phone-task-edit-save]"));
  expect(q(host, "[data-phone-task-editor]")).toBeNull();
  await sleep(20);
  flushSync(() => {});
  expect(q(host, "[data-phone-task-title]")!.textContent).toBe("Name every pipeline row by its first prompt line");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.body).toMatchObject({
    text: "Name every pipeline row by its first prompt line\nThe phone names each lane of a task by its first prompt line.",
    expectedRevision: "r-t-many-1",
  });
});

test("the phone lists only what opens: a transcript the board did not load opens by its path, a launch that never started offers a Dismiss", async () => {
  const subject = {
    ...theTask,
    id: "t-ghost",
    text: "Exercise legacy spawn fixture",
    origin: { kind: "launch", key: "launch-ghost", refinement: "pending" },
    assignments: [
      { launchId: "launch-ghost", conversationId: "conversation_ghost", path: null, panePid: null, state: "linked", error: null, at: iso(3_600), engine: "codex" },
      { conversationId: "conversation_elsewhere", path: "/elsewhere/conversation-9.jsonl", panePid: null, state: "linked", error: null, at: iso(3_600) },
    ],
  } as unknown as BoardTask;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, task: subject }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const { host } = mount(taskPorts([]), noPipelinePorts, subject);
    const open = qa(host, "[data-phone-task-not-loaded]");
    expect(open.length).toBe(1);
    click(open[0]!);
    const { formatConversationHash } = await import("@/lib/accounts/identity");
    expect(dom.location.hash).toBe(formatConversationHash({ conversationId: "conversation_elsewhere", path: "/elsewhere/conversation-9.jsonl" }));
    expect(qa(host, "[data-phone-task-unstarted]").map((row) => row.getAttribute("data-phone-task-unstarted"))).toEqual(["launch-ghost"]);
    click(q(host, '[data-phone-launch-dismiss="launch-ghost"]'));
    await sleep(5);
    expect(requests.filter((request) => request.method !== "GET")).toEqual([{ url: "/api/tasks/t-ghost/assignment", method: "PATCH", body: { launchId: "launch-ghost", conversationId: "conversation_ghost", dismiss: "launch-did-not-start" } }]);
  } finally {
    globalThis.fetch = realFetch;
    dom.location.hash = "";
  }
});
