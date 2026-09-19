import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import type { PatchBody, PatchResult, TaskMutationPorts } from "./useTaskMutations";

/* The card's Details row (#1834), rendered by React against invented tasks and
   scripted task ports: agent-facing context is folded away behind ONE row that
   is closed by default, opens the text in place, and is absent entirely when
   the task has no details. The title and the description are untouched by it,
   and editing the opened text writes `details` alone. No route, store or state
   directory is touched. */

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
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  FocusEvent: dom.FocusEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

/* React reads the DOM it runs in when it loads, so it loads after the window. */
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
});

const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const NOW = 1_800_000_000;

/** The kind of text the operator used to read in the description: a prompt, a
    seat card, ids and rules — long, agent-facing, and not a summary. */
const AGENT_CONTEXT = [
  "Lane ffb09e5c, worktree live-log-viewer-next-pipeline-ffb09e5c.",
  "Fences held by other lanes: PipelineSection.tsx, OverviewBoard.tsx, lib/limits.ts.",
  "Gates: tsc, the touched tests by path, the build, the privacy gate.",
].join("\n");

function task(id: string, status: TaskStatus, text: string, extra: Partial<BoardTask> & { revision?: string } = {}): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    revision: REV(1),
    ...extra,
  } as BoardTask;
}

interface Scripted {
  ports: TaskMutationPorts;
  patches: Array<{ id: string; body: PatchBody }>;
}

function scripted(rows: () => readonly BoardTask[]): Scripted {
  const patches: Scripted["patches"] = [];
  let revision = 10;
  return {
    patches,
    ports: {
      patch: async (id, body) => {
        patches.push({ id, body });
        const row = rows().find((candidate) => candidate.id === id)!;
        const { expectedProject: _project, expectedRevision: _revision, ...change } = body as PatchBody & Record<string, unknown>;
        const saved = { ...row, ...change, revision: REV((revision += 1)) } as BoardTask & Record<string, unknown>;
        if (change.details === "") delete saved.details;
        return { ok: true, task: saved } satisfies PatchResult;
      },
      read: async (id) => rows().find((candidate) => candidate.id === id) ?? null,
      changed: () => {},
    },
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(tasks: BoardTask[]) {
  let current = tasks;
  const server = scripted(() => current);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next?: BoardTask[]) => {
    if (next) current = next;
    flushSync(() => root.render(
      <KanbanBoard
        project="fixture"
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        allTasks={current}
        drafts={[]}
        now={NOW}
        loaded
        catalogFailures={0}
        selection={new Set()}
        onOpenConversations={() => {}}
        seatRefs={null}
        mutationPorts={server.ports}
      />,
    ));
  };
  render();
  return { host, render, server };
}

const cardEl = (host: HTMLElement, id: string) => [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === `task:${id}`) ?? null;
const toggle = (host: HTMLElement, id: string) => cardEl(host, id)?.querySelector<HTMLElement>("[data-details-toggle]") ?? null;
const detailsText = (host: HTMLElement, id: string) => cardEl(host, id)?.querySelector<HTMLElement>("[data-details-text]") ?? null;
const editor = (host: HTMLElement, id: string) => cardEl(host, id)?.querySelector<HTMLInputElement & HTMLTextAreaElement>("[data-card-editor]") ?? null;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const key = (element: Element | null | undefined, name: string, init: { ctrlKey?: boolean } = {}) => {
  expect(element).toBeTruthy();
  flushSync(() => element!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as Event));
};
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  flushSync(() => {
    setter.call(field, value);
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};

test("details is one row, closed, costing the description nothing; opening it shows the whole text in place", () => {
  const view = mount([task("a", "assigned", "Fold agent context away\nThe card reads for a human first.", { details: AGENT_CONTEXT })]);
  const row = toggle(view.host, "a");
  expect(row?.textContent).toContain("Details");
  expect(row?.getAttribute("aria-expanded")).toBe("false");
  /* Closed costs one row: the agent's text is nowhere on the card. */
  expect(detailsText(view.host, "a")).toBeNull();
  expect(cardEl(view.host, "a")!.textContent).not.toContain("Fences held by other lanes");
  /* The human part is exactly what it was. */
  expect(cardEl(view.host, "a")?.querySelector(".title")?.textContent).toBe("Fold agent context away");
  expect(cardEl(view.host, "a")?.querySelector(".desc")?.textContent).toBe("The card reads for a human first.");
  /* One disclosure, not two. */
  expect(cardEl(view.host, "a")!.querySelectorAll("[data-details-toggle]")).toHaveLength(1);

  click(row);
  expect(toggle(view.host, "a")?.getAttribute("aria-expanded")).toBe("true");
  expect(detailsText(view.host, "a")?.textContent).toBe(AGENT_CONTEXT);
  /* In place: the text opened inside the card's own details block. */
  expect(detailsText(view.host, "a")?.closest("[data-details]")).toBe(cardEl(view.host, "a")!.querySelector("[data-details]"));
  expect(cardEl(view.host, "a")?.querySelector(".desc")?.textContent).toBe("The card reads for a human first.");

  click(toggle(view.host, "a"));
  expect(detailsText(view.host, "a")).toBeNull();
});

test("a re-mounted board shows details closed again, and no write was made by opening it", async () => {
  const rows = [task("a", "assigned", "Fold agent context away\nThe card reads for a human first.", { details: AGENT_CONTEXT })];
  const first = mount(rows);
  click(toggle(first.host, "a"));
  expect(detailsText(first.host, "a")).not.toBeNull();
  await tick();
  expect(first.server.patches).toEqual([]);

  const second = mount(rows);
  expect(toggle(second.host, "a")?.getAttribute("aria-expanded")).toBe("false");
  expect(detailsText(second.host, "a")).toBeNull();
});

test("an empty details renders nothing, and a task without it renders exactly as today", () => {
  const view = mount([
    task("a", "assigned", "No agent context here\nJust the human description."),
    task("b", "assigned", "Blank agent context\nAlso just the description.", { details: "" }),
  ]);
  for (const id of ["a", "b"]) {
    expect(cardEl(view.host, id)?.querySelector("[data-details]")).toBeNull();
    expect(toggle(view.host, id)).toBeNull();
    /* The description is where it always was. */
    expect(cardEl(view.host, id)?.querySelector(".desc")?.textContent).toContain("description");
  }
});

test("the opened text is edited in place, and the write carries details alone", async () => {
  const view = mount([task("a", "assigned", "Fold agent context away\nThe card reads for a human first.", { details: AGENT_CONTEXT })]);
  click(toggle(view.host, "a"));
  click(detailsText(view.host, "a"));
  const field = editor(view.host, "a")!;
  expect(field.getAttribute("data-card-editor")).toBe("details");
  expect(field.value).toBe(AGENT_CONTEXT);
  expect(document.activeElement).toBe(field);
  type(field, "Lane ffb09e5c. Gates: tsc, tests by path, build, privacy.");
  /* ⌘/Ctrl+Enter saves, as it does for a description. */
  key(field, "Enter", { ctrlKey: true });
  await tick();
  expect(view.server.patches).toEqual([{
    id: "a",
    body: { details: "Lane ffb09e5c. Gates: tsc, tests by path, build, privacy.", expectedProject: "fixture", expectedRevision: REV(1) },
  }]);
  /* The card shows the operator's text ahead of the poll, still in the row. */
  expect(detailsText(view.host, "a")?.textContent).toBe("Lane ffb09e5c. Gates: tsc, tests by path, build, privacy.");
  expect(cardEl(view.host, "a")?.querySelector(".title")?.textContent).toBe("Fold agent context away");
});

test("clearing the details in the editor takes the whole row away", async () => {
  const view = mount([task("a", "assigned", "Fold agent context away\nThe card reads for a human first.", { details: AGENT_CONTEXT })]);
  click(toggle(view.host, "a"));
  click(detailsText(view.host, "a"));
  type(editor(view.host, "a")!, "   ");
  key(editor(view.host, "a"), "Enter", { ctrlKey: true });
  await tick();
  expect(view.server.patches.map((patch) => patch.body)).toEqual([{ details: "", expectedProject: "fixture", expectedRevision: REV(1) }]);
  expect(cardEl(view.host, "a")?.querySelector("[data-details]")).toBeNull();
  expect(cardEl(view.host, "a")?.querySelector(".desc")?.textContent).toBe("The card reads for a human first.");
});
