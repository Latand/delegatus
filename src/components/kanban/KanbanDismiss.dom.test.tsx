import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { TaskMutationPorts } from "./useTaskMutations";

/* A card's Dismiss (docs/design/needs-attention.md §4, §5), rendered by React
   over invented tasks: the foot names why the card needs the operator, one
   click posts exactly what the card drew, the card stops flagging it at once
   and says who cleared it, and the cleared line's Undo brings it back. The
   board is mounted under the Viewer's own dismissal layer; the request is
   answered by a stub, and no route or state directory is touched. */

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* The dismissal route, answered the way the server answers it. */
const posted: Array<Record<string, unknown>> = [];
let refuse = false;
/* The lanes parked again between the poll and the click. */
let lanesMoved = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/attention/dismissals") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push(body);
    if (refuse) return new Response(JSON.stringify({ ok: false, error: "the store is busy" }), { status: 503 });
    const target = body.target as { subjects?: Array<{ kind: string; conversationId?: string; pipelineId?: string }> };
    const answered = (target.subjects ?? []).map((subject) => subject.kind === "pipeline" ? { kind: "pipeline", pipelineId: subject.pipelineId } : { kind: "conversation", conversationId: subject.conversationId });
    const moved = (subject: { kind: string }) => lanesMoved && body.undo !== true && subject.kind === "pipeline";
    return new Response(JSON.stringify({
      ok: true,
      dismissed: answered.filter((subject) => !moved(subject)),
      alreadyClear: [],
      changed: answered.filter(moved),
      at: new Date().toISOString(),
      by: { kind: "operator", surface: "desktop" },
      undo: body.undo === true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");
const { resetDismissalOverlayForTests, useDismissalOverlay } = await import("@/components/attention/dismissalOverlay");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  posted.length = 0;
  refuse = false;
  lanesMoved = false;
  resetDismissalOverlayForTests();
});

/* The board's clock is the wall clock, as in production: a click is "just now". */
const NOW = Math.floor(Date.now() / 1000);
const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();

function conversation(index: number, extra: Partial<FileEntry> = {}): FileEntry {
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
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    parent: null,
    model: "claude-opus",
    pendingQuestion: null,
    waitingInput: null,
    name: `conversation-${index}`,
    ...extra,
  } as FileEntry;
}

const asking = (index: number, header: string, askedAgo: number) => conversation(index, {
  pendingQuestion: {
    kind: "question",
    toolUseId: `toolu-${index}`,
    transcriptPath: `/fixture/conversation-${index}.jsonl`,
    pid: 1,
    paneTarget: null,
    askedAt: iso(askedAgo),
    questions: [{ question: "Which unit file stays?", header, multiSelect: false, options: [] }],
  },
});

function task(id: string, status: TaskStatus, text: string, files: readonly FileEntry[] = []): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: files.map((file) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV(1),
  } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** The board under the Viewer's own dismissal layer, as the Viewer mounts it. */
function Layered({ tasks, files, pipelines }: { tasks: BoardTask[]; files: FileEntry[]; pipelines: Pipeline[] }) {
  const layered = useDismissalOverlay(files, pipelines);
  return (
    <KanbanBoard
      project="fixture"
      seatRefs={null}
      groups={[]}
      manual={layered.files}
      files={layered.files}
      flows={[]}
      pipelines={layered.pipelines}
      tasks={[]}
      allTasks={tasks}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      mutationPorts={idlePorts}
    />
  );
}

function mount(props: { tasks: BoardTask[]; files: FileEntry[]; pipelines?: Pipeline[] }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: Partial<typeof props> = {}) => flushSync(() => root.render(<Layered tasks={next.tasks ?? props.tasks} files={next.files ?? props.files} pipelines={next.pipelines ?? props.pipelines ?? []} />));
  render();
  return { host, render };
}

const cardEl = (host: HTMLElement, id: string) => [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === id) ?? null;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};

test("the foot names why the card needs the operator, and a member tile names its own reason", () => {
  const first = asking(1, "Unit", 900);
  const second = asking(2, "Port", 300);
  const { host } = mount({ tasks: [task("a", "assigned", "Retire the systemd install path", [first, second])], files: [first, second] });
  const card = cardEl(host, "task:a")!;
  expect(card.getAttribute("data-attention")).toBe("needs");
  /* The oldest reason, and how many more. */
  expect(card.querySelector("[data-foot-needs]")?.textContent).toBe("Unit +1");
  expect(card.querySelector("[data-foot-needs]")?.getAttribute("data-foot-needs")).toBe("2");
  expect(card.querySelector(`[data-member="${first.path}"]`)?.getAttribute("title")).toBe("Unit");
  expect(card.querySelector("[data-dismiss]")?.getAttribute("aria-label")).toContain("stop flagging it until something new");
});

test("one click posts what the card drew, clears it at once with who cleared it, and Undo brings it back", async () => {
  const asker = asking(1, "Unit", 900);
  const { host } = mount({ tasks: [task("a", "assigned", "Retire the systemd install path", [asker])], files: [asker] });

  click(cardEl(host, "task:a")!.querySelector("[data-dismiss]"));
  /* Drawn on the click, before any answer. */
  let card = cardEl(host, "task:a")!;
  expect(card.hasAttribute("data-attention")).toBe(false);
  expect(card.querySelector("[data-foot-needs]")).toBeNull();
  expect(card.querySelector("[data-foot-cleared]")?.textContent).toBe("Cleared · you · just now");

  await tick();
  expect(posted).toEqual([{
    target: {
      kind: "task",
      taskId: "a",
      subjects: [{ kind: "conversation", conversationId: asker.conversationId, path: asker.path, reasonId: "toolu-1", reason: "question" }],
    },
    undo: false,
    surface: "desktop",
  }]);
  /* The server's own instant replaced the click's, and the card still reads cleared. */
  card = cardEl(host, "task:a")!;
  expect(card.querySelector("[data-foot-cleared]")?.getAttribute("data-foot-cleared")).toBe("operator");

  click(card.querySelector("[data-undo-dismiss]"));
  await tick();
  expect(posted.at(-1)).toMatchObject({ undo: true, target: { kind: "task", taskId: "a" } });
  card = cardEl(host, "task:a")!;
  expect(card.getAttribute("data-attention")).toBe("needs");
  expect(card.querySelector("[data-foot-needs]")?.textContent).toBe("Unit");
});

test("a newer question comes back past the cleared line", () => {
  const cleared = { ...asking(1, "Unit", 900), attentionDismissal: { at: iso(600), by: { kind: "manager" as const, conversationId: "conversation_seat", role: "orchestrator" } } };
  const { host, render } = mount({ tasks: [task("a", "assigned", "Retire the systemd install path", [cleared])], files: [cleared] });
  let card = cardEl(host, "task:a")!;
  expect(card.querySelector("[data-foot-cleared]")?.textContent).toMatch(/^Cleared · orchestrator · /);

  const asksAgain = { ...asking(1, "Port", 60), attentionDismissal: cleared.attentionDismissal };
  render({ files: [asksAgain] });
  card = cardEl(host, "task:a")!;
  expect(card.getAttribute("data-attention")).toBe("needs");
  expect(card.querySelector("[data-foot-needs]")?.textContent).toBe("Port");
  expect(card.querySelector("[data-foot-cleared]")).toBeNull();
});

test("a refused dismissal puts the flag back and says why", async () => {
  refuse = true;
  const asker = asking(1, "Unit", 900);
  const { host } = mount({ tasks: [task("a", "assigned", "Retire the systemd install path", [asker])], files: [asker] });
  click(cardEl(host, "task:a")!.querySelector("[data-dismiss]"));
  await tick();
  await tick();
  const card = cardEl(host, "task:a")!;
  expect(card.getAttribute("data-attention")).toBe("needs");
  expect(host.textContent).toContain("Could not clear");
});

test("a lane that parked again before the click landed stays flagged, and the receipt says it changed", async () => {
  const parked = {
    id: "lane-parked",
    task: "Retire the systemd install path",
    project: "fixture",
    state: "needs_decision",
    cursor: { stageId: "build", state: "needs_decision", input: null, activatedBy: null },
    stages: [{ id: "build", kind: "run", prompt: "", next: null, effectiveRole: {} }],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", activatedBy: null, agentPath: null, conversationId: null, launchId: null, sessionId: null, paneId: null, flowId: null, effectiveRole: {}, output: null, verdict: null, error: null, startedAt: iso(900), completedAt: iso(600) }] }],
    taskIds: ["a"],
    createdAt: iso(1200),
  } as unknown as Pipeline;
  lanesMoved = true;
  const { host } = mount({ tasks: [task("a", "assigned", "Retire the systemd install path")], files: [], pipelines: [parked] });
  expect(cardEl(host, "task:a")!.getAttribute("data-attention")).toBe("needs");

  click(cardEl(host, "task:a")!.querySelector("[data-dismiss]"));
  /* Drawn cleared on the click, as any dismissal is. */
  expect(cardEl(host, "task:a")!.hasAttribute("data-attention")).toBe(false);
  expect(host.textContent).toContain("Cleared «");
  await tick();
  await tick();
  /* The card named the lane as it drew it. */
  expect(posted[0]).toMatchObject({ target: { kind: "task", taskId: "a", subjects: [{ kind: "pipeline", pipelineId: "lane-parked", laneMovedAt: Date.parse(iso(600)) }] } });
  /* The server stamped nothing: the lane asks again, and the receipt says why
     instead of offering an Undo of nothing. */
  expect(cardEl(host, "task:a")!.getAttribute("data-attention")).toBe("needs");
  expect(host.textContent).toContain("changed since you saw it, so it stays flagged");
  expect(host.textContent).not.toContain("Cleared «");
});
