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
  expect(ghostCard.querySelector("[data-elsewhere-toggle]")).toBeNull();
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
  expect(lanesCard.querySelector("[data-elsewhere-toggle]")).toBeNull();
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
  /* One line folds the conversation; its list opens it. */
  flushSync(() => (elsewhereCard.querySelector("[data-elsewhere-toggle]") as HTMLElement).click());
  const open = elsewhereCard.querySelectorAll("[data-elsewhere-row] button");
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

/* The wall of «conversation outside this board» rows (#2459): a task that
   ran for a day collects an assignment per helper conversation, each with a
   transcript path and no stage id, none loaded here. */
const wall = (count: number) => Array.from({ length: count }, (_, index) => ({
  conversationId: `conversation_wall_${index}`, path: `/elsewhere/wall-${index}.jsonl`, panePid: null, state: "linked", error: null, at: iso(NOW - 3600 + index * 60),
}));

test("many conversations the board did not load fold into one line inside the collapsed Past attempts section, and the line opens a list that opens each", () => {
  const busy = task("busy", { text: "Finish the privacy gate", assignments: wall(30) as BoardTask["assignments"] });
  const host = mount([busy]);
  const busyCard = card(host, "busy")!;
  /* The card counts all thirty and lists none by itself. */
  expect(busyCard.querySelector("[data-foot-conversations]")?.getAttribute("data-foot-conversations")).toBe("30");
  expect(busyCard.querySelectorAll("[data-not-loaded]").length).toBe(0);
  expect(busyCard.querySelectorAll("[data-elsewhere-row]").length).toBe(0);
  /* One line, inside the section that is closed until the operator opens it. */
  const toggles = busyCard.querySelectorAll("[data-elsewhere-toggle]");
  expect(toggles.length).toBe(1);
  expect(toggles[0]!.textContent).toBe("+30 conversations outside this board · Open list");
  const section = toggles[0]!.closest("details.history") as HTMLDetailsElement;
  expect(section).not.toBeNull();
  expect(section.open).toBe(false);
  /* Nothing to count as an attempt: the header names the conversations. */
  expect(section.querySelector("summary .hl")?.textContent).toBe("Conversations outside this board · 30");
  /* The list opens on the line and each row opens its own conversation. */
  flushSync(() => (toggles[0] as HTMLElement).click());
  expect(toggles[0]!.getAttribute("aria-expanded")).toBe("true");
  const rows = busyCard.querySelectorAll("[data-elsewhere-row] button");
  expect(rows.length).toBe(30);
  flushSync(() => (rows[7] as HTMLElement).click());
  expect(dom.location.hash).toBe(formatConversationHash({ conversationId: "conversation_wall_7", path: "/elsewhere/wall-7.jsonl" }));
});

test("Past attempts counts exactly the attempts it lists once each, and the conversations off the board are no part of that count", async () => {
  const { PastAttempts } = await import("./PipelineSection");
  const attempt = (n: number) => ({
    key: `p1:build:attempt:${n}`, pipelineId: "p1", stageId: "build", kind: "attempt" as const, n, of: 9, attempt: null, ordinal: n, ambiguous: false,
    state: "passed", verdict: "pass", atMs: (NOW - 3600 + n * 60) * 1000, conversation: { path: `/attempts/${n}.jsonl`, conversationId: `conversation_attempt_${n}` },
  });
  const rows = Array.from({ length: 9 }, (_, index) => attempt(index + 1));
  const elsewhere = Array.from({ length: 22 }, (_, index) => ({ key: `conversation_off_${index}`, path: `/off/${index}.jsonl`, conversationId: `conversation_off_${index}` }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(<PastAttempts rows={rows} elsewhere={elsewhere} names={new Map([["p1", new Map([["build", "Build"]])]])} nowMs={NOW * 1000} onOpen={() => {}} />));
  const section = host.querySelector("details.history") as HTMLDetailsElement;
  expect(section.open).toBe(false);
  expect(section.querySelector("summary .hl")?.textContent).toBe("Past attempts · 9");
  const listed = [...section.querySelectorAll("li[data-past]")].map((row) => row.getAttribute("data-past"));
  expect(listed.length).toBe(9);
  expect(new Set(listed).size).toBe(9);
  /* The one line states its own number and lists nothing until asked. */
  expect(section.querySelectorAll("[data-elsewhere-toggle]").length).toBe(1);
  expect(section.querySelector("[data-elsewhere-toggle]")?.textContent).toContain("+22 conversations");
  expect(section.querySelectorAll("[data-elsewhere-row]").length).toBe(0);
});
