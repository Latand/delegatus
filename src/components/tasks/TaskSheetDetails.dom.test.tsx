import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";

/* The task's opened view (#1834): agent-facing details fold behind ONE row that
   is closed when the task is opened, opens the whole text in place, and is
   absent when the task carries none. Editing it writes `details` alone, so the
   human text above it is left exactly as stored.

   Its own file because React must load AFTER this window exists for the field's
   own input events to reach it; `TaskSheet.dom.test.tsx` imports React first
   and tests what a mount renders. */

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
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  FocusEvent: dom.FocusEvent,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver !== "function") {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { TaskSheet } = await import("./TaskSheet");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
});

const AGENT_CONTEXT = [
  "Lane ffb09e5c, worktree live-log-viewer-next-pipeline-ffb09e5c.",
  "Gates: tsc, the touched tests by path, the build, the privacy gate.",
].join("\n");

const HUMAN_TEXT = "Fold agent context away\nThe card reads for a human first.";

function task(details?: string): BoardTask {
  return {
    id: "t1834",
    project: "orbit-api",
    status: "assigned",
    text: HUMAN_TEXT,
    placement: "unplaced",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    assignments: [],
    ...(details === undefined ? {} : { details }),
  };
}

function open(row: BoardTask): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <TaskSheet project="orbit-api" tasks={[row]} files={[]} initialView={{ taskId: row.id }} onClose={() => {}} />,
  ));
  return host;
}

const toggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-task-details-toggle]");
const field = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>("[data-task-details] textarea");
const textField = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task text"]');

test("the opened task shows one closed Details row, and opening it shows the whole text in place", () => {
  const host = open(task(AGENT_CONTEXT));
  expect(toggle(host)?.textContent).toContain("Details");
  expect(toggle(host)?.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelectorAll("[data-task-details-toggle]")).toHaveLength(1);
  /* Closed costs one row: the agent's text is nowhere in the view. */
  expect(field(host)).toBeNull();
  expect(host.textContent).not.toContain("Gates: tsc");
  expect(textField(host)!.value).toBe(HUMAN_TEXT);

  flushSync(() => toggle(host)!.click());
  expect(toggle(host)?.getAttribute("aria-expanded")).toBe("true");
  expect(field(host)!.value).toBe(AGENT_CONTEXT);
  /* In place, inside the task's own details block, and the human text above it
     is untouched by the disclosure. */
  expect(field(host)!.closest("[data-task-details]")).not.toBeNull();
  expect(textField(host)!.value).toBe(HUMAN_TEXT);

  flushSync(() => toggle(host)!.click());
  expect(field(host)).toBeNull();
});

test("an opened task with no details, and one with an empty details, draw no row at all", () => {
  for (const row of [task(), task("")]) {
    const host = open(row);
    expect(host.querySelector("[data-task-details]")).toBeNull();
    expect(toggle(host)).toBeNull();
    expect(textField(host)!.value).toBe(HUMAN_TEXT);
  }
});

test("leaving the details field writes details alone; the task text is not in the body", async () => {
  const sent: Array<{ url: string; method?: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, task: task("saved") }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const host = open(task(AGENT_CONTEXT));
    flushSync(() => toggle(host)!.click());
    const editor = field(host)!;
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(editor, "Lane ffb09e5c. Gates: tsc, tests by path, build, privacy.");
      editor.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    flushSync(() => editor.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([{
      url: "/api/tasks/t1834",
      method: "PATCH",
      body: { details: "Lane ffb09e5c. Gates: tsc, tests by path, build, privacy." },
    }]);
    /* The text field never moved, and nothing wrote it. */
    expect(textField(host)!.value).toBe(HUMAN_TEXT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("leaving the details field unchanged writes nothing", async () => {
  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    sent.push(String(url));
    return new Response(JSON.stringify({ ok: true, task: task(AGENT_CONTEXT) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const host = open(task(AGENT_CONTEXT));
    flushSync(() => toggle(host)!.click());
    flushSync(() => field(host)!.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
