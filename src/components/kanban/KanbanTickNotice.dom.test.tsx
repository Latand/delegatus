import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";

/* The standing tick notice's «Tick settings» button. The seat's tick chip is
   what answers it, so the button is offered while a live seat holds the
   project and is absent otherwise. Rendered by React against an invented task;
   no route, store or state directory is touched. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
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
const { publishSeatSignal } = await import("./kanbanSeatStore");
const { onSeatTickPanelRequest, resetPendingSeatTickPanel } = await import("@/components/orchestrator/openSeatTick");
const { translate } = await import("@/lib/i18n");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  flushSync(() => publishSeatSignal("fixture", null));
  resetPendingSeatTickPanel();
});

const REV = ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-");
const notice = {
  id: "tick-notice",
  project: "fixture",
  text: "Tick: every 30 min until 18:00\nWakes for this project are set to one every 30 minutes.\nmonitor-ref: seat-tick-settings",
  status: "inbox",
  placement: "unplaced",
  assignments: [],
  createdAt: "2026-09-19T10:00:00.000Z",
  updatedAt: "2026-09-19T10:00:00.000Z",
  revision: REV,
} as unknown as BoardTask;

function mount(): HTMLElement {
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
      allTasks={[notice]}
      drafts={[]}
      now={1_800_000_000}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
      mutationPorts={{ patch: async () => ({ ok: false, status: 500, error: "read-only" }), read: async () => notice, changed: () => {} }}
    />,
  ));
  return host;
}

const signal = (live: boolean) => ({ tone: "quiet" as const, label: "idle", unread: false, live });
const button = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-open-seat-tick]");

test("the notice's button is offered only while a live seat can answer it", () => {
  const host = mount();
  expect(button(host)).toBeNull();
  flushSync(() => publishSeatSignal("fixture", signal(true)));
  expect(button(host)?.textContent).toContain(translate("en", "kanban.tickNotice.open"));
  flushSync(() => publishSeatSignal("fixture", signal(false)));
  expect(button(host)).toBeNull();
});

test("the button asks for this project's tick panel, whether or not the seat is folded", () => {
  const host = mount();
  flushSync(() => publishSeatSignal("fixture", signal(true)));
  const asked: string[] = [];
  const stop = onSeatTickPanelRequest((project) => asked.push(project));
  try {
    flushSync(() => button(host)!.click());
  } finally {
    stop();
  }
  expect(asked).toEqual(["fixture"]);
});
