import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";

/* A card counts only the conversations the operator can open, and each one it
   counts opens on click; a launch that never produced a transcript is listed
   as such with a Dismiss instead. Rendered by React against invented tasks;
   the dismiss goes to a scripted fetch. No route, store or state directory is
   touched. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  location: dom.location,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  FocusEvent: dom.FocusEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");
const { formatConversationHash } = await import("@/lib/accounts/identity");

const roots: Root[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
  dom.location.hash = "";
});

const NOW = 1_800_000_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function task(id: string, extra: Partial<BoardTask>): BoardTask {
  return {
    id,
    project: "fixture",
    text: `Task ${id}`,
    status: "assigned",
    placement: "unplaced",
    assignments: [],
    createdAt: iso(NOW - 7200),
    updatedAt: iso(NOW - 7200),
    revision: `task-v1:${id}`,
    ...extra,
  } as BoardTask;
}

const ghost = task("ghost", {
  text: "Exercise legacy spawn fixture",
  origin: { kind: "launch", key: "launch-ghost", refinement: "pending" },
  assignments: [{ launchId: "launch-ghost", conversationId: "conversation_ghost", path: null, panePid: null, state: "linked", error: null, at: iso(NOW - 3600), engine: "codex" }],
});
const elsewhere = task("elsewhere", {
  text: "Tune the upload retries",
  assignments: [{ conversationId: "conversation_elsewhere", path: "/elsewhere/conversation-9.jsonl", panePid: null, state: "linked", error: null, at: iso(NOW - 3600) }],
});

function mount(tasks: BoardTask[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={[]}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      allTasks={tasks}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
    />,
  ));
  return host as unknown as HTMLElement;
}

const card = (host: HTMLElement, id: string) => host.querySelector(`.card[data-id="task:${id}"]`) as HTMLElement | null;

test("a launch that never started is no conversation: the card lists it apart and a Dismiss marks it failed", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, task: ghost }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = mount([ghost]);
  const ghostCard = card(host, "ghost")!;
  expect(ghostCard).not.toBeNull();
  /* No «1 conversation»: nothing on this card opens. */
  expect(ghostCard.querySelector("[data-foot-conversations]")).toBeNull();
  expect(ghostCard.querySelector("[data-not-loaded]")).toBeNull();
  const row = ghostCard.querySelector('[data-launch-not-started="launch-ghost"]') as HTMLElement | null;
  expect(row?.textContent).toContain("Launch did not start");
  flushSync(() => (ghostCard.querySelector('[data-launch-dismiss="launch-ghost"]') as HTMLElement).click());
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(requests.filter((request) => request.method !== "GET")).toEqual([{ url: "/api/tasks/ghost/assignment", method: "PATCH", body: { launchId: "launch-ghost", conversationId: "conversation_ghost", dismiss: "launch-did-not-start" } }]);
});

test("every conversation a card counts opens on click, loaded on this board or not", () => {
  const host = mount([elsewhere]);
  const elsewhereCard = card(host, "elsewhere")!;
  expect(elsewhereCard.querySelector("[data-foot-conversations]")?.getAttribute("data-foot-conversations")).toBe("1");
  const open = elsewhereCard.querySelectorAll("[data-not-loaded]");
  expect(open.length).toBe(1);
  flushSync(() => (open[0] as HTMLElement).click());
  expect(dom.location.hash).toBe(formatConversationHash({ conversationId: "conversation_elsewhere", path: "/elsewhere/conversation-9.jsonl" }));
});
