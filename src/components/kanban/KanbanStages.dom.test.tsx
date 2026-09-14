import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { Flow } from "@/lib/flows/types";
import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { PipelinePorts, PipelineWriteResult } from "./pipelinePorts";
import type { TaskMutationPorts } from "./useTaskMutations";

/* Stages on the kanban board (#1695 K5b), rendered by React: the card's
   Stages button and pipeline actions over the pipeline route, the Stages
   sheet with its navigator, graph and lane of panes holding the board's own
   readers, and a waiting stage's first message edited in place, saved through
   `override-stage` with the stage's wiring kept. Invented records; the
   pipeline route answers from a stub; no route or state directory is touched. */

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
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
  File: dom.File,
  FileReader: dom.FileReader,
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  let body: unknown = {};
  if (url.startsWith("/api/logs")) {
    const { reqs } = JSON.parse(String(init?.body ?? "{}")) as { reqs: Array<{ id: string }> };
    body = { chunks: Object.fromEntries(reqs.map((req) => [req.id, { data: "", start: 0, offset: 0, size: 0 }])) };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
});

const NOW = 1_800_000_000;
const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();

function conversation(name: string): FileEntry {
  return {
    path: `/fixture/${name}.jsonl`, conversationId: `conversation_${name}`, title: name, project: "fixture", root: "claude-projects", kind: "session", fmt: "claude",
    engine: "claude", mtime: NOW - 600, size: 0, activity: "idle", proc: null, pid: null, parent: null, model: "opus", pendingQuestion: null, waitingInput: null, name,
  } as FileEntry;
}

const role = (roleId: string) => ({ roleId, engine: roleId === "reviewer" ? "codex" : "claude", model: roleId === "reviewer" ? "gpt-5.6" : "opus", effort: "high", access: "read-write", promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) => ({ id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `{{prev.output}}\n\nStage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over });
const attempt = (n: number, state: string, file: FileEntry | null, startedAgo: number, over: Record<string, unknown> = {}) => ({
  n, state, effectiveRole: role("builder"), launchId: null, conversationId: file?.conversationId ?? null, sessionId: null, agentPath: file?.path ?? null, paneId: null, flowId: null,
  startedAt: iso(startedAgo), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
});

const implement1 = conversation("implement-1");
const implement2 = conversation("implement-2");
const review1 = conversation("review-1");
const verify1 = conversation("verify-1");
const verify2 = conversation("verify-2");
const idOf = (file: FileEntry) => file.conversationId!;
const merge1 = conversation("merge-1");
const baseFiles = [implement1, implement2, review1, verify1, verify2];

function searchPipeline(over: Partial<Pipeline> = {}, mergeRun: unknown = null): Pipeline {
  return {
    id: "p-search", task: "Restore search results", taskIds: ["t-search"], project: "fixture", state: "running", branch: "pipeline/search",
    stages: [
      stage("implement", "builder", "review", { prompt: "{{task}}\n\nKeep the old index serving." }),
      stage("review", "reviewer", "verify"),
      stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }),
      stage("merge", "cleaner", null, { prompt: "{{prev.output}}\n\nMerge once the alias swap is verified." }),
    ],
    runs: [
      { stageId: "implement", attempts: [attempt(1, "passed", implement1, 7200), attempt(2, "passed", implement2, 4000, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
      { stageId: "review", attempts: [attempt(1, "passed", review1, 3600, { flowId: "flow-review" })] },
      { stageId: "verify", attempts: [attempt(1, "failed", verify1, 5000), attempt(2, "running", verify2, 1200, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] },
      ...(mergeRun ? [mergeRun] : []),
    ],
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    worktreeDir: "/fixture/worktree", createdAt: iso(9000),
    ...over,
  } as unknown as Pipeline;
}
const withMergePrompt = (record: Pipeline, prompt: string) => ({ ...record, stages: record.stages.map((entry) => (entry.id === "merge" ? { ...entry, prompt } : entry)) }) as Pipeline;
const mergeStarted = () => searchPipeline({}, { stageId: "merge", attempts: [attempt(1, "running", merge1, 30)] });

const flows = [{ id: "flow-review", rounds: [{ n: 1, verdict: "REQUEST_CHANGES", reviewerPath: null, reviewerConversationId: null, startedAt: iso(3500) }, { n: 2, verdict: "APPROVE", reviewerPath: null, reviewerConversationId: null, startedAt: iso(3000) }] }] as unknown as Flow[];

function task(id: string, status: TaskStatus, text: string): BoardTask {
  return { id, project: "fixture", text, status, placement: "unplaced", assignments: [], createdAt: iso(9000), updatedAt: iso(600), revision: REV(1) } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/* The pipeline route, answered by the test: each write waits for `release`
   when `hold` is set, so the pending state can be read. */
function pipelineRoute(stored: () => Pipeline) {
  const patches: Array<{ id: string; body: PatchPipelineRequest }> = [];
  const reads: string[] = [];
  const state = {
    answers: [] as PipelineWriteResult[],
    record: null as Pipeline | null,
    hold: false,
    release: () => {},
    refreshes: 0,
  };
  const ports: PipelinePorts = {
    read: async (id) => {
      reads.push(id);
      return state.record ?? stored();
    },
    patch: async (id, body) => {
      patches.push({ id, body });
      if (state.hold) await new Promise<void>((resolve) => { state.release = resolve; });
      return state.answers.shift() ?? { ok: true, pipeline: stored() };
    },
    refresh: () => { state.refreshes += 1; },
  };
  return { ports, patches, reads, state };
}

function mount(pipeline: Pipeline, options: { files?: FileEntry[]; status?: TaskStatus } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  let current = pipeline;
  let currentFiles = options.files ?? baseFiles;
  const route = pipelineRoute(() => current);
  const render = () => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={currentFiles}
      flows={flows}
      pipelines={[current]}
      tasks={[]}
      allTasks={[task("t-search", options.status ?? "assigned", "Restore search results after the index rebuild")]}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenCatalog={() => {}}
      onOpenOnBoard={() => {}}
      seatRefs={null}
      mutationPorts={idlePorts}
      pipelinePorts={route.ports}
      readerStorage={null}
    />,
  ));
  render();
  return {
    host,
    route,
    update(next: Pipeline, nextFiles?: FileEntry[]) {
      current = next;
      if (nextFiles) currentFiles = nextFiles;
      render();
    },
  };
}

const card = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".card")].find((element) => element.getAttribute("data-id") === "task:t-search")!;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
/* A pointer press as a browser makes it: the button takes focus, then the click. */
const press = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  (element as HTMLElement).focus();
  click(element);
};
const key = (element: Element | null | undefined, name: string, init: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  expect(element).toBeTruthy();
  flushSync(() => element!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as Event));
};
const type = (field: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(field, value);
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const menuItem = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLElement>('.menu [role^="menuitem"]')].find((item) => item.querySelector(".lbl")?.firstChild?.textContent === label) ?? null;
const menuLabels = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.menu [role^="menuitem"]')].map((item) => [item.querySelector(".lbl")?.firstChild?.textContent, item.getAttribute("aria-disabled") === "true", item.querySelector(".why")?.textContent ?? null]);
const receiptTexts = (host: HTMLElement) => [...host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent);
const sheet = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-stages-sheet]");
const pane = (host: HTMLElement, stageId: string) => sheet(host)?.querySelector<HTMLElement>(`.pane[data-stage="${stageId}"]`) ?? null;
/* Identity, never structure: a failing `toBe` on two DOM nodes formats both whole trees. */
const same = (actual: unknown, expected: unknown) => expect(actual === expected && expected !== null && expected !== undefined).toBe(true);
const readerIn = (element: Element | null): string | null => element?.querySelector<HTMLElement>("[data-kanban-reader]")?.getAttribute("data-kanban-reader") ?? null;

test("the card's pipeline header carries Stages and the pipeline actions, each with the engine's own refusal", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  const head = card(host).querySelector(".stage-section .sec-head")!;
  expect(head.querySelector("[data-open-stages]")?.textContent).toBe("Stages");
  expect(head.querySelector("[data-open-stages]")?.getAttribute("aria-label")).toBe("Expand all 4 stages");
  click(head.querySelector("[data-pipeline-menu]"));
  expect(menuLabels(host)).toEqual([
    ["Expand stages", false, null],
    ["Pause", false, "The pipeline does not advance until you resume it."],
    ["Retry a stage", true, "Only while the pipeline waits on a stage for a decision"],
    ["Skip a stage", true, "Only while the pipeline waits on a stage for a decision"],
    ["Close the pipeline", false, "Stops its agents. Uncommitted work stays in the worktree."],
  ]);
});

test("Pause goes to the pipeline route, the header says it is on its way, and the receipt says what the server did", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  route.state.hold = true;
  click(card(host).querySelector("[data-pipeline-menu]"));
  click(menuItem(host, "Pause"));
  await tick();
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "pause" } }]);
  expect(card(host).querySelector("[data-pipeline-acting]")?.textContent).toBe("Pausing…");
  /* One action at a time: the menu names the one on its way. */
  click(card(host).querySelector("[data-pipeline-menu]"));
  expect(menuItem(host, "Pause")?.getAttribute("aria-disabled")).toBe("true");
  expect(menuItem(host, "Pause")?.querySelector(".why")?.textContent).toBe("Waiting for the server: Pausing…");
  key(host.querySelector(".menu"), "Escape");
  route.state.release();
  await tick();
  expect(card(host).querySelector("[data-pipeline-acting]")).toBeNull();
  expect(receiptTexts(host)).toEqual(["Paused «Restore search results after the index rebuild»"]);
});

test("a refused action keeps the server's words beside a Retry that sends it again", async () => {
  const { host, route } = mount(searchPipeline({ state: "paused" } as Partial<Pipeline>));
  await tick();
  route.state.answers.push({ ok: false, status: 409, error: "pipeline is not paused" });
  click(card(host).querySelector("[data-pipeline-menu]"));
  click(menuItem(host, "Resume"));
  await tick();
  const receipt = host.querySelector("[data-kanban-receipt].error");
  expect(receipt?.querySelector(".msg")?.textContent).toBe("Resume was refused: pipeline is not paused");
  click(receipt?.querySelector(".act"));
  await tick();
  expect(route.patches.map((patch) => patch.body)).toEqual([{ action: "resume" }, { action: "resume" }]);
  expect(receiptTexts(host)).toEqual(["Resumed «Restore search results after the index rebuild»"]);
});

test("retry and skip name the stage the pipeline waits on and send the action alone, which the engine applies to that stage", async () => {
  const parked = searchPipeline({ state: "needs_decision", cursor: { stageId: "verify", state: "running", input: null, activatedBy: null } } as Partial<Pipeline>);
  const { host, route } = mount(parked);
  await tick();
  click(card(host).querySelector("[data-pipeline-menu]"));
  expect(menuItem(host, "Retry Verifier")?.getAttribute("aria-disabled")).toBeNull();
  click(menuItem(host, "Skip Verifier"));
  await tick();
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "skip-stage" } }]);
  expect(receiptTexts(host)).toEqual(["Skipped Verifier in «Restore search results after the index rebuild»"]);
});

test("Stages opens the sheet on the live stage: navigator, loop, graph, and a pane per stage in graph order", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const view = sheet(host)!;
  expect(view.getAttribute("role")).toBe("dialog");
  expect(view.querySelector("header h2")?.textContent).toBe("Restore search results after the index rebuild");
  expect(view.querySelector("header .progress")?.textContent).toBe("4 stages · Verifier running · attempt 2");
  const chips = [...view.querySelectorAll<HTMLElement>("[data-nav-stage]")];
  expect(chips.map((chip) => chip.textContent)).toEqual(["1Builder", "2Reviewer", "3Verifier", "4Cleaner"]);
  expect(chips.map((chip) => chip.getAttribute("aria-current"))).toEqual(["false", "false", "true", "false"]);
  expect(view.querySelector(".gs-nav .ploop")?.textContent).toBe("↺ Verifier fails → Builder · 1/2");
  expect(view.querySelectorAll(".gs-graph .pnode")).toHaveLength(4);
  expect([...view.querySelectorAll<HTMLElement>(".pane")].map((element) => element.dataset.stage)).toEqual(["implement", "review", "verify", "merge"]);
  same(document.activeElement, pane(host, "verify"));

  const implement = pane(host, "implement")!;
  expect(implement.querySelector(".pname")?.textContent).toBe("1. Builder");
  expect(implement.querySelector(".pane-sub")?.textContent).toBe("started by Verifier · fail");
  expect([...implement.querySelectorAll(".attempts button")].map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["#1 · passed", "false"], ["#2 · passed", "true"]]);
  expect([...pane(host, "review")!.querySelectorAll(".rounds .rchip")].map((chip) => chip.textContent)).toEqual(["Round 1 · changes requested", "Round 2 · approved"]);
  expect(pane(host, "verify")!.querySelector(".pane-sub")?.textContent).toBe("started by Reviewer · pass · on fail → Builder · 1/2");
  /* Each started pane holds its shown attempt's conversation as a reader. */
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify2));
  expect(pane(host, "verify")!.querySelector("[data-kanban-reader]")?.getAttribute("data-in-sheet")).toBe("1");
  /* The waiting stage holds its first message, marked as waiting for delivery. */
  const merge = pane(host, "merge")!;
  expect(merge.querySelector(".pane-sub")?.textContent).toBe("runs when Verifier passes");
  expect(merge.querySelector(".msg.event")?.textContent).toBe("Starts when Verifier passes · last stage");
  expect(merge.querySelector("[data-draft-message] .btext")?.textContent).toBe("Merge once the alias swap is verified.");
  expect(merge.querySelector(".bstatus")?.textContent).toBe("Waiting for stage start · not delivered");
  expect(merge.querySelector<HTMLTextAreaElement>(".composer2 textarea")?.disabled).toBe(true);
});

test("a reader open on the card moves into its pane and back, the same mounted conversation throughout", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.psummary [data-stage="verify"]'));
  await tick();
  const container = card(host).querySelector<HTMLElement>(`.reader-host[data-reader-key="${verify2.conversationId}"]`);
  expect(container).toBeTruthy();
  press(card(host).querySelector("[data-open-stages]"));
  await tick();
  same(pane(host, "verify")!.querySelector(".reader-host"), container);
  expect(card(host).querySelector(`[data-reader-slot="${verify2.conversationId}"]`)).toBeNull();
  key(sheet(host), "Escape");
  await tick();
  expect(sheet(host)).toBeNull();
  same(card(host).querySelector(`[data-reader-slot="${verify2.conversationId}"] .reader-host`), container);
  same(document.activeElement, card(host).querySelector("[data-open-stages]"));
});

test("a shelf column widens for a reader on its card, and narrows again while that reader stands in the Stages sheet", async () => {
  const { host } = mount(searchPipeline(), { status: "blocked" });
  await tick();
  const column = () => host.querySelector<HTMLElement>('.column[data-status="blocked"]')!;
  click(card(host).querySelector('.psummary [data-stage="verify"]'));
  await tick();
  expect(column().classList.contains("reading")).toBe(true);
  press(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify2));
  expect(column().classList.contains("reading")).toBe(false);
  key(sheet(host), "Escape");
  await tick();
  expect(column().classList.contains("reading")).toBe(true);
});

test("Collapse finished folds passed stages and lets their readers go; a navigator chip opens a folded pane; attempt tabs switch the reader", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  click(sheet(host)!.querySelector("[data-collapse-finished]"));
  await tick();
  expect([...sheet(host)!.querySelectorAll<HTMLElement>(".pane")].map((element) => element.dataset.collapsed)).toEqual(["1", "1", "0", "0"]);
  expect(readerIn(pane(host, "implement"))).toBeNull();
  expect(pane(host, "implement")!.querySelector(".vlabel")?.textContent).toBe("1 Builder · passed");
  click(sheet(host)!.querySelector('[data-nav-stage="review"]'));
  await tick();
  expect(pane(host, "review")!.dataset.collapsed).toBe("0");
  expect(sheet(host)!.querySelector('[data-nav-stage="review"]')?.getAttribute("aria-current")).toBe("true");
  click(pane(host, "verify")!.querySelector('[data-attempt="1"]'));
  await tick();
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify1));
  expect(pane(host, "verify")!.querySelector(".pstate")?.textContent).toBe("failed");
  click(sheet(host)!.querySelector("[data-expand-all]"));
  await tick();
  expect([...sheet(host)!.querySelectorAll<HTMLElement>(".pane")].map((element) => element.dataset.collapsed)).toEqual(["0", "0", "0", "0"]);
  /* Pane folds and attempt choices outlive the sheet. */
  click(sheet(host)!.querySelector("[data-collapse-finished]"));
  click(sheet(host)!.querySelector("[data-sheet-close]"));
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(pane(host, "implement")!.dataset.collapsed).toBe("1");
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify1));
});

test("a pane's actions offer retry and skip only for the stage the pipeline waits on", async () => {
  const { host } = mount(searchPipeline({ state: "needs_decision", cursor: { stageId: "verify", state: "running", input: null, activatedBy: null } } as Partial<Pipeline>));
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  click(pane(host, "implement")!.querySelector("[data-pane-menu]"));
  expect(menuLabels(host)).toEqual([
    ["Retry this stage", true, "The pipeline waits on another stage"],
    ["Skip this stage", true, "The pipeline waits on another stage"],
  ]);
  key(host.querySelector(".menu"), "Escape");
  await tick();
  click(pane(host, "verify")!.querySelector("[data-pane-menu]"));
  expect(menuItem(host, "Retry this stage")?.getAttribute("aria-disabled")).toBeNull();
  key(host.querySelector(".menu"), "Escape");
  await tick();
  click(pane(host, "merge")!.querySelector("[data-pane-menu]"));
  expect(menuItem(host, "Edit the first message")).toBeTruthy();
  click(menuItem(host, "Edit the first message"));
  await tick();
  same(document.activeElement, pane(host, "merge")!.querySelector("textarea.draft-edit"));
});

test("a waiting node opens its first message on the card; Save re-reads the stage and writes the words into the stage's own wiring", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.psummary [data-stage="merge"]'));
  await tick();
  const panel = card(host).querySelector<HTMLElement>("[data-stage-detail]")!;
  same(document.activeElement, panel);
  expect(panel.querySelector(".ch-title")?.textContent).toBe("Cleaner · Restore search results after the index rebuild");
  expect(panel.querySelector(".ch-stage")?.textContent).toBe("stage 4/4");
  expect(card(host).querySelector('.psummary [data-stage="merge"]')?.classList.contains("selected")).toBe(true);
  click(panel.querySelector("[data-draft-edit]"));
  const field = panel.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!;
  same(document.activeElement, field);
  expect(field.value).toBe("Merge once the alias swap is verified.");
  expect(panel.querySelector<HTMLButtonElement>("[data-draft-save]")?.disabled).toBe(true);
  type(field, "Merge after the alias swap and one warm query.");
  key(field, "Enter", { ctrlKey: true });
  await tick();
  expect(route.reads).toEqual(["p-search"]);
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the alias swap and one warm query." } }]);
  expect(panel.querySelector("textarea.draft-edit")).toBeNull();
  expect(panel.querySelector(".bstatus")?.textContent).toMatch(/^Waiting for stage start · not delivered · edited \d/);
  same(document.activeElement, panel.querySelector("[data-draft-edit]"));
});

test("words saved elsewhere since the edit began stop the save; Use theirs keeps them, Keep mine saves over them", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.psummary [data-stage="merge"]'));
  await tick();
  const panel = () => card(host).querySelector<HTMLElement>("[data-stage-detail]")!;
  click(panel().querySelector("[data-draft-edit]"));
  type(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Mine.");
  route.state.record = withMergePrompt(searchPipeline(), "{{prev.output}}\n\nTheirs.");
  click(panel().querySelector("[data-draft-save]"));
  await tick();
  expect(route.patches).toEqual([]);
  expect(route.state.refreshes).toBe(1);
  expect(panel().querySelector("[data-draft-changed] .msg-text")?.textContent).toBe("Changed elsewhere since you began: «Theirs.»");
  expect(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")?.value).toBe("Mine.");
  click([...panel().querySelectorAll<HTMLElement>("[data-draft-changed] button")].find((button) => button.textContent === "Keep mine"));
  await tick();
  expect(route.patches.map((patch) => patch.body.prompt)).toEqual(["{{prev.output}}\n\nMine."]);
  expect(panel().querySelector("textarea.draft-edit")).toBeNull();
});

test("a stage that starts between the check and the write answers 409: the text stays, marked not delivered, and the panel becomes the conversation once it is let go", async () => {
  const { host, route, update } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.psummary [data-stage="merge"]'));
  await tick();
  const panel = () => card(host).querySelector<HTMLElement>("[data-stage-detail]");
  click(panel()!.querySelector("[data-draft-edit]"));
  type(panel()!.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Too late.");
  route.state.answers.push({ ok: false, status: 409, error: "stage has already started" });
  click(panel()!.querySelector("[data-draft-save]"));
  await tick();
  expect(route.patches).toHaveLength(1);
  expect(panel()!.querySelector("[data-draft-undelivered] .msg-text")?.textContent).toBe("Cleaner started with its previous first message. Your edit was not delivered.");
  expect(panel()!.querySelector("[data-draft-undelivered] .kept")?.textContent).toBe("Too late.");
  expect(receiptTexts(host)).toEqual([]);
  /* The catalog catches up: the stage has its conversation, and the draft still holds the panel. */
  update(mergeStarted(), [...baseFiles, merge1]);
  await tick();
  expect(panel()).toBeTruthy();
  click([...panel()!.querySelectorAll<HTMLElement>("[data-draft-undelivered] button")].find((button) => button.textContent === "Discard"));
  await tick();
  expect(panel()).toBeNull();
  expect(card(host).querySelector(`[data-reader-slot="${merge1.conversationId}"]`)).toBeTruthy();
});

test("Escape cancels an edit and hands focus back to Edit; a panel with nothing unsaved becomes the stage's reader when it starts, folded as it was", async () => {
  const { host, route, update } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.psummary [data-stage="merge"]'));
  await tick();
  const panel = () => card(host).querySelector<HTMLElement>("[data-stage-detail]");
  click(panel()!.querySelector("[data-draft-edit]"));
  type(panel()!.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Never mind.");
  key(panel()!.querySelector("textarea.draft-edit"), "Escape");
  await tick();
  expect(panel()!.querySelector("textarea.draft-edit")).toBeNull();
  expect(panel()).toBeTruthy();
  same(document.activeElement, panel()!.querySelector("[data-draft-edit]"));
  expect(route.patches).toEqual([]);
  /* Edit from the actions of a folded panel opens it on the field. */
  click(panel()!.querySelector("[data-panel-fold]"));
  expect(panel()!.dataset.collapsed).toBe("1");
  click(panel()!.querySelector("[data-panel-menu]"));
  expect(menuLabels(host).map(([label]) => label)).toEqual(["Edit the first message", "Retry this stage", "Skip this stage", "Show in Stages"]);
  click(menuItem(host, "Edit the first message"));
  await tick();
  expect(panel()!.dataset.collapsed).toBe("0");
  same(document.activeElement, panel()!.querySelector("textarea.draft-edit"));
  key(panel()!.querySelector("textarea.draft-edit"), "Escape");
  await tick();
  click(panel()!.querySelector("[data-panel-fold]"));
  expect(panel()!.dataset.collapsed).toBe("1");
  update(mergeStarted(), [...baseFiles, merge1]);
  await tick();
  expect(panel()).toBeNull();
  const reader = card(host).querySelector<HTMLElement>(`[data-kanban-reader="${merge1.conversationId}"]`);
  expect(reader?.getAttribute("data-folded")).toBe("1");
});
