import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import { BarNeedsFilterProvider } from "@/components/ProjectBar";

import { KanbanBoard } from "./KanbanBoard";
import type { TaskMutationPorts } from "./useTaskMutations";

/* The bar's «Needs you» filter row on a board whose Viewer queue is empty. No route, no store, no state directory is touched. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
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
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
});

const REV = (n: number) => `task-v1:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function task(id: string, status: TaskStatus, text: string, extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV(1),
    ...extra,
  } as BoardTask;
}

const NO_PORTS: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const testTrail: NonNullable<React.ComponentProps<typeof KanbanBoard>["barTrail"]> = () => <span />;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};

test("the needs-you filter row works for a card held on the operator while the Viewer's queue is empty", () => {
  const hold = { kind: "operator" as const, note: "Choose release A or B", since: new Date(1_799_998_800 * 1000).toISOString(), by: "agent" as const };
  const tasks = [task("held", "blocked", "Choose release", { hold }), task("plain", "inbox", "Write the release notes")];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <BarNeedsFilterProvider value={{ available: false, active: false, toggle: () => { throw new Error("the funnel has nothing to narrow"); } }}>
      <KanbanBoard
        project="fixture" groups={[]} manual={[]} files={[]} flows={[]} pipelines={[]} tasks={[]} allTasks={tasks} drafts={[]}
        now={1_800_000_000} loaded catalogFailures={0} selection={new Set()} onOpenConversations={() => {}}
        seatRefs={null} mutationPorts={NO_PORTS} barTrail={testTrail}
      />
    </BarNeedsFilterProvider>,
  ));
  const cards = () => [...host.querySelectorAll(".card[data-id]")].map((card) => card.getAttribute("data-id"));
  expect(cards()).toEqual(expect.arrayContaining(["task:held", "task:plain"]));
  click(host.querySelector("[data-bar-filter-toggle]"));
  const row = () => host.querySelector<HTMLButtonElement>("[data-bar-filter-needs]")!;
  expect(row().disabled).toBe(false);
  expect(row().getAttribute("aria-checked")).toBe("false");
  click(row());
  expect(cards()).toEqual(["task:held"]);
  expect(row().getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("[data-bar-filter-dot]")).not.toBeNull();
  click(row());
  expect(cards()).toEqual(expect.arrayContaining(["task:held", "task:plain"]));
});
