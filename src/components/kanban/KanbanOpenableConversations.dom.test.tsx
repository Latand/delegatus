import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
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
  /* A row from before launches reserved a conversation: it never minted one. */
  assignments: [{ launchId: "launch-ghost", path: null, panePid: null, state: "linked", error: null, at: iso(NOW - 3600), engine: "codex" }],
});
const elsewhere = task("elsewhere", {
  text: "Tune the upload retries",
  assignments: [{ conversationId: "conversation_elsewhere", path: "/elsewhere/conversation-9.jsonl", panePid: null, state: "linked", error: null, at: iso(NOW - 3600) }],
});

function mount(tasks: BoardTask[], files: FileEntry[] = [], hooks: { onOpened?: (path: string) => void; onRetry?: (file: FileEntry) => void } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={files}
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
      onConversationOpened={hooks.onOpened}
      onSpawnRetry={hooks.onRetry}
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
  expect(requests.filter((request) => request.method !== "GET")).toEqual([{ url: "/api/tasks/ghost/assignment", method: "PATCH", body: { launchId: "launch-ghost", conversationId: null, dismiss: "launch-did-not-start" } }]);
});

/* A task that ran lanes for days: an assignment per stage attempt and review
   round, each with the conversation it minted and no path, none loaded here. */
function laneAssignments(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    launchId: `launch-${prefix}-${index}`,
    clientAttemptId: index % 5 === 4 ? `flow_${prefix}_round${index}` : `pipeline_${prefix}${index % 3}_build_${index + 1}`,
    conversationId: `conversation_${prefix}_${index}`,
    path: null, panePid: null, state: "linked", error: null, at: iso(NOW - 4 * 86_400 + index * 600), engine: "claude",
  }));
}
const legacyLaunch = (id: string) => ({ launchId: `launch-${id}`, path: null, panePid: null, state: "linked", error: null, at: iso(NOW - 2 * 86_400), engine: "codex" });

test("stage attempts that started are no launch rows: the card counts them and lists none", () => {
  const lanes = task("lanes", { text: "Move the state into SQLite", assignments: laneAssignments("lanes", 43) as BoardTask["assignments"] });
  const host = mount([lanes]);
  const lanesCard = card(host, "lanes")!;
  expect(lanesCard.querySelectorAll("[data-launch-not-started]").length).toBe(0);
  expect(lanesCard.querySelector("[data-launches-not-started]")).toBeNull();
  expect(lanesCard.querySelectorAll("[data-not-loaded]").length).toBe(0);
  expect(lanesCard.querySelector("[data-foot-conversations]")?.getAttribute("data-foot-conversations")).toBe("43");
});

test("several launches that did not start fold behind one summary row that opens on click, with Dismiss all beside it", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const mixed = task("mixed", {
    text: "Tune the upload retries",
    assignments: [...laneAssignments("mixed", 12), legacyLaunch("a"), legacyLaunch("b"), legacyLaunch("c")] as BoardTask["assignments"],
  });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    await new Promise((resolve) => setTimeout(resolve, 1));
    return new Response(JSON.stringify({ ok: true, task: mixed }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = mount([mixed]);
  const mixedCard = card(host, "mixed")!;
  /* One summary row, folded: no launch row until it opens. */
  const summary = mixedCard.querySelector("[data-launches-not-started]") as HTMLElement | null;
  expect(summary?.getAttribute("data-launches-not-started")).toBe("3");
  expect(mixedCard.querySelectorAll("[data-launch-not-started]").length).toBe(0);
  const toggle = mixedCard.querySelector('[data-launches-toggle="task:mixed"]') as HTMLElement;
  expect(toggle.textContent).toBe("3 launches did not start");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect([...mixedCard.querySelectorAll("[data-launch-not-started]")].map((row) => row.getAttribute("data-launch-not-started"))).toEqual(["launch-a", "launch-b", "launch-c"]);
  flushSync(() => toggle.click());
  expect(mixedCard.querySelectorAll("[data-launch-not-started]").length).toBe(0);
  /* Dismiss all dismisses each in turn. */
  const all = mixedCard.querySelector('[data-launches-dismiss-all="task:mixed"]') as HTMLElement;
  expect(all.textContent).toBe("Dismiss all");
  flushSync(() => all.click());
  for (let wait = 0; wait < 50 && requests.length < 3; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(requests).toEqual(["a", "b", "c"].map((id) => ({ url: "/api/tasks/mixed/assignment", method: "PATCH", body: { launchId: `launch-${id}`, conversationId: null, dismiss: "launch-did-not-start" } })));
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

test("a failed launch shows at once with its error, opens its launch view, and counts as no conversation", () => {
  const failed = task("failed", {
    text: "Fix the upload retries",
    assignments: [{ launchId: "launch-failed", conversationId: "conversation_failed", path: "spawn:launch-failed", panePid: null, state: "spawning", error: null, at: iso(NOW - 120), engine: "claude" }],
  });
  const placeholder = {
    path: "spawn:launch-failed", conversationId: "conversation_failed", title: "Fix the upload retries", project: "fixture",
    root: "claude-projects", kind: "session", fmt: "claude", engine: "claude", mtime: NOW - 120, size: 0, activity: "idle",
    proc: null, pid: null, parent: null, model: null, pendingQuestion: null, waitingInput: null, name: "launch-failed",
    spawn: { launchId: "launch-failed", clientAttemptId: null, accountId: null, conversationId: "conversation_failed", state: "failed", initialMessage: "failed", retrySafe: true, error: "account limit reached" },
  } as unknown as FileEntry;
  const opened: string[] = [];
  const retried: string[] = [];
  const host = mount([failed], [placeholder], { onOpened: (path) => opened.push(path), onRetry: (file) => retried.push(file.path) });
  const failedCard = card(host, "failed")!;
  expect(failedCard.querySelector("[data-foot-conversations]")).toBeNull();
  expect(failedCard.querySelector("[data-member]")).toBeNull();
  const row = failedCard.querySelector('[data-launch-failed="launch-failed"]') as HTMLElement | null;
  expect(row?.textContent).toContain("Launch failed");
  expect(row?.querySelector('[data-launch-error="launch-failed"]')?.textContent).toBe("account limit reached");
  expect(row?.querySelector('[data-launch-dismiss="launch-failed"]')).not.toBeNull();
  flushSync(() => (row!.querySelector('[data-launch-open="launch-failed"]') as HTMLElement).click());
  expect(opened).toEqual(["spawn:launch-failed"]);
  /* The launch view it opens carries the error and a working Retry. */
  const launchView = host.querySelector('[data-launch-state="failed"]') as HTMLElement | null;
  expect(launchView?.textContent).toContain("account limit reached");
  flushSync(() => (launchView!.querySelector("[data-launch-retry]") as HTMLElement).click());
  expect(retried).toEqual(["spawn:launch-failed"]);
});
