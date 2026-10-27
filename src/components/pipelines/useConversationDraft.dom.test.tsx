import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { ConversationDraftRequest } from "@/lib/pipelines/conversationDraftContract";
import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { PipelinePorts, PipelineWriteResult } from "@/components/kanban/pipelinePorts";
import type { TaskMutationPorts } from "@/components/kanban/useTaskMutations";
import { setKanbanCardsOpenByDefault } from "@/components/kanban/cardOpenDefault";
import { stageDigests } from "@/lib/pipelines/stageDigest";

/* A pipeline drafted from the card's conversation on the desktop board
   (docs/design/start-pipeline-from-conversation/implementation.md, variant 3),
   rendered by React: the card's compact ⋯ names the conversation and its
   branch once the server read them, choosing it posts once and shows the
   draft being prepared on the card, the answer opens the Builder's first
   message, and Start sends the engine's own start. The route is a stub that
   answers as the real one does; no state directory is touched. */

/* The lane row and its Start are drawn on an open card. */
setKanbanCardsOpenByDefault(true);

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  File: dom.File, FileReader: dom.FileReader, IntersectionObserver: undefined, ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

/* The source route: each preview answers what the test set; each post waits for the test to release it. */
const route = {
  previews: [] as string[],
  preview: null as unknown as { status: number; body: unknown },
  posts: [] as ConversationDraftRequest[],
  release: [] as Array<(response: Response) => void>,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("/api/pipelines/from-conversation")) return json(404, { error: "unexpected" });
  if (init?.method === "POST") {
    route.posts.push(JSON.parse(String(init.body)));
    return new Promise<Response>((resolve) => route.release.push(resolve));
  }
  route.previews.push(url);
  return json(route.preview.status, route.preview.body);
}) as typeof fetch;

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("@/components/kanban/KanbanBoard");
const { ConversationDrafts, postConversationDraft, readConversationPreview } = await import("./conversationDraftClient");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  route.previews.length = 0;
  route.posts.length = 0;
  route.release.length = 0;
});

const NOW = 1_800_000_000;
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();
const HEAD = "c".repeat(40);
const conversation = (name: string, mtimeAgo: number, cwd: string | null = "/repo/export"): FileEntry => ({
  path: `/fixture/${name}.jsonl`, conversationId: `conversation_${name}`, title: name === "export" ? "CSV export retry and streaming writes" : name, project: "fixture", root: "claude-projects", kind: "session", fmt: "claude",
  engine: "claude", mtime: NOW - mtimeAgo, size: 0, activity: "idle", proc: null, pid: null, parent: null, model: "opus", pendingQuestion: null, waitingInput: null, name, cwd,
} as FileEntry);
const exportConversation = conversation("export", 300);
const olderConversation = conversation("older", 9000);

function task(assigned: readonly FileEntry[]): BoardTask {
  const assignments = assigned.map((file) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "handoff", error: null, at: iso(600) }));
  return { id: "t-export", project: "fixture", text: "CSV export fails on large projects", status: "assigned", placement: "unplaced", assignments, createdAt: iso(9000), updatedAt: iso(600), revision: ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-") } as BoardTask;
}
const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
function draft(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p-export", task: "CSV export fails on large projects", taskIds: ["t-export"], project: "fixture", state: "draft", branch: "pipeline/csv-export-p-export",
    stages: [
      { id: "builder", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}\n\nCSV export fails past 50k rows. Left: a test for the retry after 503.", next: "reviewer", onFail: null, effectiveRole: role("builder") },
      { id: "reviewer", kind: "run", role: { roleId: "reviewer" }, prompt: "{{prev.output}}", next: null, onFail: { to: "builder", maxRounds: 2, onExhausted: "advance" }, effectiveRole: role("reviewer") },
    ],
    runs: [], cursor: null, worktreeDir: null, createdAt: iso(30),
    conversationSource: { conversationId: exportConversation.conversationId!, branch: "fix/csv-export-retry", head: HEAD, capturedAt: iso(30) },
    ...over,
  } as unknown as Pipeline;
}
const source = (over: Record<string, unknown> = {}) => ({ ok: true, source: { conversationId: exportConversation.conversationId, title: "CSV export retry and streaming writes", branch: "fix/csv-export-retry", head: HEAD, sourceRevision: "rev-1", canCreate: true, ...over } });

const idleTasks: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(options: { files?: FileEntry[]; pipelines?: Pipeline[] } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const files = options.files ?? [exportConversation, olderConversation];
  let pipelines = options.pipelines ?? [];
  const patches: PatchPipelineRequest[] = [];
  const answers: PipelineWriteResult[] = [];
  const ports: PipelinePorts = {
    read: async () => ({ pipeline: pipelines[0]!, stageDigests: stageDigests(pipelines[0]!.stages), graphDigest: "g1" }),
    patch: async (_id, body) => {
      patches.push(body);
      const answer = answers.shift();
      if (answer) return answer;
      if (body.action === "start") {
        pipelines = [{ ...pipelines[0]!, state: "provisioning" } as Pipeline];
        render();
      }
      return { ok: true, pipeline: pipelines[0]! };
    },
    refresh: () => {},
  };
  const store = new ConversationDrafts({
    post: (body) => postConversationDraft(body),
    preview: (conversationId, taskId) => readConversationPreview(conversationId, taskId),
    apply: (record) => {
      pipelines = [record];
      render();
    },
    newKey: () => `key-${route.posts.length + 1}`,
  });
  const render = () => flushSync(() => root.render(
    <KanbanBoard
      project="fixture" groups={[]} manual={files} files={files} flows={[]} pipelines={pipelines} tasks={[]} allTasks={[task(files)]} drafts={[]}
      now={NOW} loaded catalogFailures={0} selection={new Set()} onOpenConversations={() => {}} seatRefs={null}
      mutationPorts={idleTasks} pipelinePorts={ports} readerStorage={null} conversationDrafts={store}
    />,
  ));
  render();
  return { host, store, patches, answers };
}

const card = (host: HTMLElement) => host.querySelector<HTMLElement>('.card[data-id="task:t-export"]')!;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const escape = (element: Element | null) => {
  expect(element).toBeTruthy();
  flushSync(() => element!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event));
};
const row = (host: HTMLElement) => host.querySelector<HTMLElement>('.menu [data-cm-item="fromConversation"]');
const rowText = (host: HTMLElement) => {
  const item = row(host);
  /* The conversation's name, then its branch on a line of its own, then what holds the row back. */
  return item ? [item.querySelector(".lbl")?.firstChild?.textContent, item.querySelector(".why:not(.warn):not([data-branch-name])")?.textContent ?? null, item.querySelector("[data-branch-name]")?.textContent ?? null, item.querySelector(".why.warn")?.textContent ?? null, item.getAttribute("aria-disabled") === "true"] : null;
};
/* Where focus is, by its opening tag: a failed match then prints a line, never a whole DOM node. */
const tag = (element: Element | null | undefined) => (element ? element.outerHTML.slice(0, element.outerHTML.indexOf(">") + 1) : "none");
const focused = () => tag(document.activeElement);
const openMenu = async (host: HTMLElement) => {
  click(card(host).querySelector("[data-menu]"));
  await tick();
};

test("the card's ⋯ names the newest conversation and its branch once the server read them, and only while it is open", async () => {
  route.preview = { status: 200, body: source() };
  const { host } = mount();
  expect(route.previews).toEqual([]);
  await openMenu(host);
  expect(route.previews).toEqual([`/api/pipelines/from-conversation?conversationId=${exportConversation.conversationId}&taskId=t-export`]);
  expect(rowText(host)).toEqual(["Pipeline from conversation…", "CSV export retry and streaming writes", "fix/csv-export-retry", null, false]);
  /* The row sits after the priorities and before Appearance, as frame 3a draws it. */
  const order = [...host.querySelectorAll<HTMLElement>(".menu [data-cm-segments], .menu [data-cm-item='fromConversation'], .menu [data-cm-section]")].map((node) => node.getAttribute("data-cm-segments") ?? node.getAttribute("data-cm-item") ?? node.getAttribute("data-cm-section"));
  expect(order.indexOf("fromConversation")).toBe(order.indexOf("priority") + 1);
  expect(order[order.indexOf("fromConversation") + 1]).toBe("appearance");
  /* Closed, the menu reads nothing more; opened again, it reads again. */
  escape(host.querySelector(".menu [role^='menuitem']"));
  await tick();
  expect(row(host)).toBeNull();
  await openMenu(host);
  expect(route.previews).toHaveLength(2);
});

test("a dirty source is a disabled row with its reason; a card holding no conversation has no row", async () => {
  route.preview = { status: 200, body: source({ canCreate: false, refusal: { code: "SOURCE_HAS_CHANGES", error: "Commit the conversation's changes before creating a pipeline." } }) };
  const { host } = mount();
  await openMenu(host);
  expect(rowText(host)).toEqual(["Pipeline from conversation…", "CSV export retry and streaming writes", "fix/csv-export-retry", "Commit the conversation's changes first.", true]);
  click(row(host));
  expect(route.posts).toEqual([]);
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();

  const empty = mount({ files: [] });
  await openMenu(empty.host);
  expect(row(empty.host)).toBeNull();
  expect(route.previews).toHaveLength(1);
});

test("choosing the row posts once, shows the draft being prepared on the card, and opens the Builder's first message when it lands", async () => {
  route.preview = { status: 200, body: source() };
  const { host, patches } = mount();
  await openMenu(host);
  click(row(host));
  await tick();
  expect(route.posts).toEqual([{ conversationId: exportConversation.conversationId!, taskId: "t-export", sourceRevision: "rev-1", clientRequestId: "key-1" }]);
  expect(host.querySelector(".menu")).toBeNull();
  expect(card(host).querySelector('[data-conversation-draft="creating"]')?.textContent).toBe("Preparing a pipeline from CSV export retry and streaming writes · fix/csv-export-retry…");
  /* No lane, no editable text and no id before the server answers. */
  expect(card(host).querySelector("[data-pipeline]")).toBeNull();
  expect(card(host).querySelector("[data-draft-message]")).toBeNull();
  /* The row on a menu opened again holds while the request is on its way. */
  await openMenu(host);
  expect(rowText(host)?.[4]).toBe(true);
  escape(host.querySelector(".menu [role^='menuitem']"));

  route.release.shift()!(json(201, { ok: true, pipeline: draft() }));
  await tick(20);
  expect(card(host).querySelector("[data-conversation-draft]")).toBeNull();
  const message = card(host).querySelector<HTMLElement>('[data-draft-message="p-export:builder"]');
  expect(message?.querySelector(".btext")?.textContent).toBe("CSV export fails past 50k rows. Left: a test for the retry after 503.");
  expect(message?.querySelector("[data-draft-edit]")).toBeTruthy();
  const start = card(host).querySelector<HTMLButtonElement>('[data-draft-start="p-export"]')!;
  expect([start.textContent, start.disabled]).toEqual(["Start", false]);
  /* Start sits in the lane's tail, a sibling of the way into Stages, never inside it. */
  expect(start.closest(".pb-tail")).toBeTruthy();
  expect(start.closest("[data-open-stages]")).toBeNull();

  /* An open edit holds Start, with the reason beside it. */
  click(message!.querySelector("[data-draft-edit]"));
  expect(card(host).querySelector<HTMLButtonElement>('[data-draft-start="p-export"]')!.disabled).toBe(true);
  expect(card(host).querySelector('[data-draft-start-note="blocked"]')?.textContent).toBe("Save or cancel the first message to start");
  click(card(host).querySelector("[data-draft-cancel]"));
  click(card(host).querySelector('[data-draft-start="p-export"]'));
  await tick();
  expect(patches).toEqual([{ action: "start" }]);
  expect(card(host).querySelector("[data-draft-start]")).toBeNull();
});

test("a refused draft keeps the card as it was and says why, with Retry; an unanswered one asks again under the same key", async () => {
  route.preview = { status: 200, body: source() };
  const { host } = mount();
  await openMenu(host);
  click(row(host));
  await tick();
  route.release.shift()!(json(409, { error: "card no longer holds source", code: "SOURCE_NOT_ON_TASK" }));
  await tick(20);
  const refused = card(host).querySelector<HTMLElement>('[data-conversation-draft="refused"]')!;
  expect(refused.querySelector(".msg-text")?.textContent).toBe("Pipeline not created. This card no longer holds the conversation.");
  expect(card(host).querySelector("[data-pipeline]")).toBeNull();
  click(refused.querySelector("[data-conversation-draft-dismiss]"));
  expect(card(host).querySelector("[data-conversation-draft]")).toBeNull();

  await openMenu(host);
  click(row(host));
  await tick();
  route.release.shift()!(json(502, {}));
  await tick(20);
  const unknown = card(host).querySelector<HTMLElement>('[data-conversation-draft="unknown"]')!;
  expect(unknown.querySelector("[data-conversation-draft-dismiss]")).toBeNull();
  click(unknown.querySelector("[data-conversation-draft-check]"));
  await tick();
  expect(route.posts.map((post) => post.clientRequestId)).toEqual(["key-1", "key-2", "key-2"]);
  route.release.shift()!(json(200, { ok: true, pipeline: draft() }));
  await tick(20);
  expect(card(host).querySelector('[data-draft-message="p-export:builder"]')).toBeTruthy();
});

test("by keyboard, the row hands focus back to ⋯; a refusal leaves it on the card, and Check again shows the branch it read before anything is posted", async () => {
  route.preview = { status: 200, body: source() };
  const { host } = mount();
  await openMenu(host);
  const more = card(host).querySelector<HTMLElement>("[data-menu]")!;
  row(host)!.focus();
  expect(focused()).toBe(tag(row(host)));
  click(row(host));
  await tick();
  expect(focused()).toBe(tag(more));
  route.release.shift()!(json(409, { error: "changed", code: "SOURCE_CHANGED" }));
  await tick(20);
  const refused = card(host).querySelector<HTMLElement>('[data-conversation-draft="refused"]')!;
  expect(refused.querySelector("[data-conversation-draft-retry]")?.textContent).toBe("Check the conversation again");
  expect(focused()).toBe(tag(more));

  /* The conversation moved to another branch. The check reads it and says so; it posts nothing. */
  route.preview = { status: 200, body: source({ branch: "other-branch", sourceRevision: "rev-2" }) };
  const check = refused.querySelector<HTMLElement>("[data-conversation-draft-retry]")!;
  check.focus();
  click(check);
  await tick(20);
  expect(route.posts).toHaveLength(1);
  const checked = card(host).querySelector<HTMLElement>('[data-conversation-draft="checked"]')!;
  expect(checked.querySelector(".msg-text")?.textContent).toBe("Checked again: CSV export retry and streaming writes · other-branch.");
  /* The button that held focus is gone: focus is on Create, where the answer is. */
  const create = checked.querySelector<HTMLElement>("[data-conversation-draft-create]")!;
  expect([create.textContent, focused()]).toEqual(["Create pipeline", tag(create)]);
  click(create);
  await tick();
  expect(route.posts.map((post) => [post.clientRequestId, post.sourceRevision])).toEqual([["key-1", "rev-1"], ["key-2", "rev-2"]]);
  expect(card(host).querySelector('[data-conversation-draft="creating"]')?.textContent).toBe("Preparing a pipeline from CSV export retry and streaming writes · other-branch…");
});

test("a create with no answer: the row names the request's own source and asks for it again under the same key", async () => {
  route.preview = { status: 200, body: source() };
  const { host } = mount();
  await openMenu(host);
  click(row(host));
  await tick();
  route.release.shift()!(json(502, {}));
  await tick(20);
  expect(card(host).querySelector('[data-conversation-draft="unknown"]')).toBeTruthy();
  /* The menu now reads another branch; the row still names the pending request's. */
  route.preview = { status: 200, body: source({ branch: "other-branch", sourceRevision: "rev-2" }) };
  await openMenu(host);
  expect(rowText(host)).toEqual(["Pipeline from conversation…", "CSV export retry and streaming writes", "fix/csv-export-retry", "No answer yet. Choosing it asks for the same pipeline again.", false]);
  click(row(host));
  await tick();
  expect(route.posts.map((post) => [post.clientRequestId, post.sourceRevision])).toEqual([["key-1", "rev-1"], ["key-1", "rev-1"]]);
  expect(card(host).querySelector('[data-conversation-draft="creating"]')).toBeTruthy();
});

test("on a folded card, the no-answer row opens the card and shows the resend being prepared and then its refusal", async () => {
  route.preview = { status: 200, body: source() };
  const { host } = mount();
  await openMenu(host);
  click(row(host));
  await tick();
  route.release.shift()!(json(502, {}));
  await tick(20);
  click(card(host).querySelector(".tools .fold"));
  expect(card(host).getAttribute("data-collapsed")).toBe("1");
  await openMenu(host);
  click(row(host));
  await tick();
  expect(route.posts.map((post) => post.clientRequestId)).toEqual(["key-1", "key-1"]);
  expect(card(host).getAttribute("data-collapsed")).toBe("0");
  expect(card(host).querySelector('[data-conversation-draft="creating"]')?.textContent).toBe("Preparing a pipeline from CSV export retry and streaming writes · fix/csv-export-retry…");
  route.release.shift()!(json(409, { error: "card no longer holds source", code: "SOURCE_NOT_ON_TASK" }));
  await tick(20);
  expect(card(host).getAttribute("data-collapsed")).toBe("0");
  expect(card(host).querySelector('[data-conversation-draft="refused"] .msg-text')?.textContent).toBe("Pipeline not created. This card no longer holds the conversation.");
});

test("a card that already holds this conversation's draft opens it instead of making another", async () => {
  route.preview = { status: 200, body: source() };
  const { host } = mount({ pipelines: [draft()] });
  await openMenu(host);
  expect(rowText(host)).toEqual(["Pipeline from conversation…", "CSV export retry and streaming writes", "fix/csv-export-retry", null, false]);
  click(row(host));
  await tick();
  expect(route.posts).toEqual([]);
  expect(card(host).querySelector('[data-draft-message="p-export:builder"]')).toBeTruthy();
});

test("a refused Start keeps the draft and its reason; one with no answer is read before Start is offered again", async () => {
  route.preview = { status: 200, body: source() };
  const { host, patches, answers } = mount({ pipelines: [draft()] });
  await tick();
  answers.push({ ok: false, status: 409, error: "no signed-in account can run claude" });
  click(card(host).querySelector('[data-draft-start="p-export"]'));
  await tick();
  expect(card(host).querySelector('[data-draft-start-note="refused"]')?.textContent).toBe("Not started: no signed-in account can run claude");
  expect(card(host).querySelector('[data-pipeline="p-export"]')?.getAttribute("data-lane-state")).toBe("draft");

  answers.push({ ok: false, status: 0, error: "offline", unknown: true });
  click(card(host).querySelector('[data-draft-start="p-export"]'));
  await tick();
  expect(card(host).querySelector<HTMLButtonElement>('[data-draft-start="p-export"]')!.disabled).toBe(true);
  click(card(host).querySelector("[data-draft-start-check]"));
  await tick();
  expect(card(host).querySelector<HTMLButtonElement>('[data-draft-start="p-export"]')!.disabled).toBe(false);
  expect(patches).toEqual([{ action: "start" }, { action: "start" }]);
});
