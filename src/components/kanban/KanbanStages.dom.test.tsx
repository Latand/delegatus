import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { Flow } from "@/lib/flows/types";
import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { laneRouteKey } from "@/lib/attention/routeTypes";
import { stageDigest, stageDigests } from "@/lib/pipelines/stageDigest";
import { translate } from "@/lib/i18n";

import type { PipelinePorts, PipelineWriteResult } from "./pipelinePorts";
import type { TaskMutationPorts } from "./useTaskMutations";
import { setKanbanCardsOpenByDefault } from "@/components/kanban/cardOpenDefault";

/* Cards start closed (docs/design/calm-task-cards-build.md §6.1); this suite reads
   what an open card holds, so its cards start open. */
setKanbanCardsOpenByDefault(true);

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
/* The checks route (docs/design/cloud-checks.md), answered by the test that reads it. */
type ChecksCall = { url: string; method: string; body: unknown };
let checksRoute: ((call: ChecksCall) => Promise<Response> | Response) | null = null;
const checksCalls: ChecksCall[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/pipelines/") && url.split("?")[0]!.endsWith("/checks") && checksRoute) {
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
    checksCalls.push(call);
    return checksRoute(call);
  }
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
  checksRoute = null;
  checksCalls.length = 0;
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

function task(id: string, status: TaskStatus, text: string, assigned: readonly FileEntry[] = []): BoardTask {
  const assignments = assigned.map((file) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "handoff", error: null, at: iso(600) }));
  return { id, project: "fixture", text, status, placement: "unplaced", assignments, createdAt: iso(9000), updatedAt: iso(600), revision: REV(1) } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/* The engine's guards (#1695 C7, retry/skip), as the route answers them. */
function guardRefusal(pipeline: Pipeline, body: PatchPipelineRequest): PipelineWriteResult | null {
  const changed = (field: string, error: string): PipelineWriteResult => ({ ok: false, status: 409, error, code: "STAGE_CHANGED", field });
  if (body.action === "override-stage" && body.expectedStageDigest !== undefined) {
    const target = pipeline.stages.find((entry) => entry.id === body.stageId);
    if (target && stageDigest(target) !== body.expectedStageDigest) return changed("expectedStageDigest", "the stage changed since it was read; read it again before overriding it");
  }
  if ((body.action === "retry-stage" || body.action === "skip-stage") && body.expectedStageId !== undefined) {
    const waiting = pipeline.state === "needs_decision" ? pipeline.cursor?.stageId ?? null : null;
    if (waiting !== body.expectedStageId) return changed("expectedStageId", `the pipeline waits on ${waiting ?? "no stage"}`);
    const latest = pipeline.runs.find((run) => run.stageId === waiting)?.attempts.findLast((attempt) => !attempt.historical)?.n ?? 0;
    if (body.expectedAttempt !== undefined && latest !== body.expectedAttempt) return changed("expectedAttempt", `${waiting} waits on attempt ${latest}`);
  }
  return null;
}

/* The record revision a read answers with; one more review round names it. */
const REVISION = "a".repeat(64);

/* The pipeline route, answered by the test: each write waits for `release`
   when `hold` is set, so the pending state can be read. Queued answers win;
   otherwise the engine's guards decide against the record as it is then, and
   `beforeWrite` lets another client act between a read and a write. */
function pipelineRoute(stored: () => Pipeline) {
  const patches: Array<{ id: string; body: PatchPipelineRequest }> = [];
  const reads: string[] = [];
  const state = {
    answers: [] as PipelineWriteResult[],
    record: null as Pipeline | null,
    hold: false,
    release: () => {},
    refreshes: 0,
    omitDigests: false,
    beforeWrite: null as (() => void) | null,
    /** The records writes predicted, which the browser port draws before the request. */
    predicted: [] as Pipeline[],
  };
  const ports: PipelinePorts = {
    read: async (id) => {
      reads.push(id);
      const pipeline = state.record ?? stored();
      return { pipeline, stageDigests: state.omitDigests ? {} : stageDigests(pipeline.stages), revision: REVISION };
    },
    patch: async (id, body, predicted) => {
      patches.push({ id, body });
      if (predicted) state.predicted.push(predicted);
      if (state.hold) await new Promise<void>((resolve) => { state.release = resolve; });
      const queued = state.answers.shift();
      if (queued) return queued;
      state.beforeWrite?.();
      state.beforeWrite = null;
      const current = state.record ?? stored();
      return guardRefusal(current, body) ?? { ok: true, pipeline: current };
    },
    refresh: () => { state.refreshes += 1; },
  };
  return { ports, patches, reads, state };
}

function mount(pipeline: Pipeline, options: { files?: FileEntry[]; status?: TaskStatus; assigned?: FileEntry[] } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  let current: Pipeline | null = pipeline;
  let currentFiles = options.files ?? baseFiles;
  const route = pipelineRoute(() => current ?? pipeline);
  const render = () => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={options.assigned ?? []}
      files={currentFiles}
      flows={flows}
      pipelines={current ? [current] : []}
      tasks={[]}
      allTasks={[task("t-search", options.status ?? "assigned", "Restore search results after the index rebuild", options.assigned)]}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
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
    update(next: Pipeline | null, nextFiles?: FileEntry[]) {
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
/* The lane's actions are a group in the card's ⋯ (#2148). */
const laneMenu = (host: HTMLElement) => card(host).querySelector<HTMLElement>("[data-menu]");
/* A pipeline's actions are a page of the card's ⋯: where the label is not on the resting list, the row that opens the page is pressed on the way. */
const menuItem = (host: HTMLElement, label: string) => {
  const find = () => [...host.querySelectorAll<HTMLElement>('.menu [role^="menuitem"]')].find((item) => item.querySelector(".lbl")?.firstChild?.textContent === label) ?? null;
  const lane = host.querySelector<HTMLElement>('.menu [data-cm-section^="lane:"]');
  if (!find() && lane) click(lane);
  return find();
};
const menuLabels = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.menu [role^="menuitem"]')].map((item) => [item.querySelector(".lbl")?.firstChild?.textContent, item.getAttribute("aria-disabled") === "true", item.querySelector(".why")?.textContent ?? null]);
const receiptTexts = (host: HTMLElement) => [...host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent);
const sheet = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-stages-sheet]");
const pane = (host: HTMLElement, stageId: string) => sheet(host)?.querySelector<HTMLElement>(`.pane[data-stage="${stageId}"]`) ?? null;
const tabOf = (host: HTMLElement, stageId: string) => sheet(host)?.querySelector<HTMLElement>(`[role="tab"][data-tab-stage="${stageId}"]`) ?? null;
/* One stage is open under the tabs: a tab press selects it, and only its pane is mounted. */
const pick = (host: HTMLElement, stageId: string) => {
  click(tabOf(host, stageId));
  return pane(host, stageId)!;
};
const selectedTab = (host: HTMLElement) => sheet(host)?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.dataset.tabStage ?? null;
/* Identity, never structure: a failing `toBe` on two DOM nodes formats both whole trees. */
const same = (actual: unknown, expected: unknown) => expect(actual === expected && expected !== null && expected !== undefined).toBe(true);
/* A waiting stage's first message, open in the agent window (docs/design/task-card-no-inline-conversations.md §2). */
const draftPanel = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-agent-window] [data-stage-draft-slot] [data-stage-detail]");
const readerIn = (element: Element | null): string | null => element?.querySelector<HTMLElement>("[data-kanban-reader]")?.getAttribute("data-kanban-reader") ?? null;

test("a pipeline card's one menu keeps Priority with its move, appearance and pipeline pages (#2276)", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(laneMenu(host));

  const groups = [...host.querySelectorAll<HTMLElement>(".menu [data-cm-segments]")]
    .map((group) => group.getAttribute("aria-label"));
  const pages = [...host.querySelectorAll<HTMLElement>(".menu [data-cm-section]")]
    .map((page) => page.querySelector(".lbl")?.firstChild?.textContent);

  expect(groups).toEqual(["Move to", "Priority"]);
  expect(pages).toEqual(["Appearance", "Pipeline actions", "More"]);
});

test("the lane row's head opens Stages; the pipeline actions are a page of the card's one ⋯, each with the engine's own refusal (#2148)", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  const head = card(host).querySelector(".pblock .pb-head")!;
  /* The whole head is the way into Stages (#2072, variant B): no separate button. */
  expect(head.querySelector("[data-open-stages] .pb-title")?.textContent).toBe("Restore search results");
  expect(head.querySelector("[data-open-stages]")?.getAttribute("aria-label")).toMatch(/^Restore search results: .+\. Expand stages$/);
  /* One ⋯ per card: the lane draws none of its own. */
  expect(card(host).querySelector("[data-pipeline-menu]")).toBeNull();
  click(laneMenu(host));
  /* The pipeline's actions sit behind one row of the card's ⋯, which opens them as a page. */
  const lane = host.querySelector<HTMLElement>('.menu [data-cm-section^="lane:"]')!;
  expect([lane.querySelector(".lbl")?.firstChild?.textContent, lane.getAttribute("data-cm-opens"), lane.getAttribute("aria-haspopup")]).toEqual(["Pipeline actions", "drill", "menu"]);
  /* The card's own items stay at rest around it: its links and Hide in the icon cells. */
  expect([...host.querySelectorAll('.menu .cm-quick [role="menuitem"]')].map((node) => node.getAttribute("aria-label")).slice(-2)).toEqual(["Attach PR or issue…", "Hide from board"]);
  click(lane);
  expect(host.querySelector(".menu [data-cm-back]")?.textContent).toBe("Pipeline actions");
  expect(menuLabels(host).slice(1)).toEqual([
    ["Expand stages", false, null],
    /* docs/design/lane-diff-comments.md: the lane's one way into its review sheet. */
    ["Review changes", false, null],
    ["Attach PR or issue to the pipeline…", false, null],
    ["Checks", false, null],
    ["Pause", false, "The pipeline does not advance until you resume it."],
    ["Retry a stage", true, "Only while the pipeline waits on a stage for a decision"],
    ["Skip a stage", true, "Only while the pipeline waits on a stage for a decision"],
    ["Finishes the task", false, "When the pipeline completes and its PR merges, the task moves to Done."],
    ["Close the pipeline", false, "Stops its agents. Uncommitted work stays in the worktree."],
  ]);
});

test("Pause goes to the pipeline route drawn at once from the record it predicts, sends once, and the receipt says what the server did", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  route.state.hold = true;
  click(laneMenu(host));
  click(menuItem(host, "Pause"));
  await tick();
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "pause" } }]);
  /* The port is handed the paused record to draw before the request (audit B8); no busy line holds the lane. */
  expect(route.state.predicted.map((record) => [record.id, record.state, record.pausedState])).toEqual([["p-search", "paused", "running"]]);
  expect(card(host).querySelector("[data-pipeline-acting]")).toBeNull();
  /* A second press while the first is out sends nothing. */
  click(laneMenu(host));
  click(menuItem(host, "Pause"));
  await tick();
  expect(route.patches).toHaveLength(1);
  route.state.release();
  await tick();
  expect(card(host).querySelector("[data-pipeline-acting]")).toBeNull();
  expect(receiptTexts(host)).toEqual(["Paused «Restore search results after the index rebuild»"]);
});

test("a refused action keeps the server's words beside a Retry that sends it again", async () => {
  const { host, route } = mount(searchPipeline({ state: "paused" } as Partial<Pipeline>));
  await tick();
  route.state.answers.push({ ok: false, status: 409, error: "pipeline is not paused" });
  click(laneMenu(host));
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
  click(laneMenu(host));
  expect(menuItem(host, "Retry Verify")?.getAttribute("aria-disabled")).toBeNull();
  click(menuItem(host, "Skip Verify"));
  /* Skip waits out its receipt, which Undo cancels (docs/design/calm-task-cards-build.md §4.1). */
  await tick(4_300);
  /* The stage and attempt the operator saw ride along; the engine checks them before it acts. */
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "skip-stage", expectedStageId: "verify", expectedAttempt: 2 } }]);
  expect(route.reads).toEqual([]);
  expect(receiptTexts(host)).toEqual(["Skipped Verify in «Restore search results after the index rebuild»"]);
});

test("Stages opens the sheet on the live stage: its waits-on line, the stages as tabs over one pane, the loop as one rule line, the graph one press away (S2)", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const view = sheet(host)!;
  expect(view.getAttribute("role")).toBe("dialog");
  same(document.activeElement, pane(host, "verify"));
  expect(view.querySelector("header h2")?.textContent).toBe("Restore search results after the index rebuild");
  /* The head says whom the lane waits on instead of the state pill and the progress words. */
  expect(view.querySelector("header .progress, header .pstate-chip")).toBeNull();
  expect(view.querySelector("header [data-waits-on]")?.getAttribute("data-waits-on")).toBe("working");
  expect(view.querySelector("header .gs-waits-words")?.textContent).toBe("Stage 3 of 4 · waiting on the Verifier (Verify)");
  /* The lane's controls: ‹ › in the head, and neither fold control. */
  expect(view.querySelector("header .lane-bar [data-lane-prev]")).toBeTruthy();
  expect(view.querySelector("header .lane-bar [data-lane-next]")).toBeTruthy();
  expect(view.querySelectorAll(".lane-bar")).toHaveLength(1);
  expect(view.querySelector("[data-collapse-finished], [data-expand-all], [data-pane-fold], .ploop")).toBeNull();
  /* The graph is off until asked for, at every width. */
  expect(view.querySelector("[data-sheet-graph]")?.getAttribute("aria-pressed")).toBe("false");
  expect(view.querySelector(".gs-graph")).toBeNull();
  /* The stages are tabs in the order the lane runs, the live one selected. */
  const tabs = [...view.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
  expect(tabs.map((tab) => `${tab.querySelector(".snum")?.textContent}${tab.querySelector(".slbl")?.textContent}`)).toEqual(["1Implement", "2Review", "3Verify", "4Merge"]);
  expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false"]);
  expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1]);
  /* Exactly one panel and one conversation are mounted. */
  expect(view.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
  expect(view.querySelectorAll(".pane")).toHaveLength(1);
  expect(view.querySelectorAll("[data-kanban-reader]")).toHaveLength(1);
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify2));
  expect(pane(host, "verify")!.querySelector("[data-kanban-reader]")?.getAttribute("data-in-sheet")).toBe("1");
  /* The fail edge is one rule line under the tabs, said once: not again in the pane's sub-line. */
  expect([...view.querySelectorAll(".gs-rule")].map((rule) => rule.textContent)).toEqual(["↺ If Verify fails → back to Implement · 1 of 2"]);
  expect(pane(host, "verify")!.querySelector(".pane-sub")?.textContent).toBe("started by Review · pass");

  const implement = pick(host, "implement");
  expect(selectedTab(host)).toBe("implement");
  expect(implement.querySelector(".pname")?.textContent).toBe("1. Implement");
  /* A pane head says which stage and its role; who runs it is said by the
     conversation under it, so the head draws no engine mark or ladder, and
     the words stay in its title. */
  expect(implement.querySelector(".prole-role")?.textContent).toBe("Builder");
  expect(implement.querySelector(".prole [data-engine-mark], .prole [data-effort-pills]")).toBeNull();
  expect(implement.querySelector(".prole")?.getAttribute("title")).toContain("Claude");
  expect(implement.querySelector(".pane-sub")?.textContent).toBe("started by Verify · fail");
  expect([...implement.querySelectorAll(".attempts button")].map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["attempt 1 · passed", "false"], ["attempt 2 · passed", "true"]]);
  /* Leaving a stage lets its reader go: one conversation at a time. */
  expect(view.querySelectorAll("[data-kanban-reader]")).toHaveLength(1);
  expect(readerIn(implement)).toBe(idOf(implement2));

  const reviewPane = pick(host, "review");
  expect([...reviewPane.querySelectorAll(".rounds .rchip")].map((chip) => chip.textContent)).toEqual(["Round 1 · changes requested", "Round 2 · approved"]);
  const opened: unknown[] = [];
  const readHistory = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener("llv:review-history", readHistory);
  try {
    const chips = reviewPane.querySelectorAll<HTMLButtonElement>(".rounds button");
    expect(chips).toHaveLength(2);
    for (const chip of chips) flushSync(() => chip.click());
    expect(opened).toEqual([{ id: "flow-review", round: 1 }, { id: "flow-review", round: 2 }]);
  } finally { window.removeEventListener("llv:review-history", readHistory); }

  /* The waiting stage holds its first message and says once when it starts
     (#2148): in the draft's own line, with no sub-line over it, no composer
     under it and no note repeating it. Its mark is quiet, not amber. */
  const merge = pick(host, "merge");
  expect(merge.querySelector(".pane-sub")).toBeNull();
  expect(merge.querySelector(".msg.event")?.textContent).toBe("Starts when Verify passes · last stage");
  expect(merge.querySelector("[data-draft-message] .btext")?.textContent).toBe("Merge once the alias swap is verified.");
  expect(merge.querySelector(".bstatus")?.textContent).toBe("First message · not sent yet");
  expect(merge.querySelector(".bstatus")?.classList.contains("waiting")).toBe(true);
  expect(merge.querySelector(".composer2, textarea[disabled], .draft-note")).toBeNull();
  expect(view.querySelectorAll("[data-kanban-reader]")).toHaveLength(0);

  /* The graph, shown, draws each stage once, marks the one selected, and its nodes select tabs. */
  click(view.querySelector("[data-sheet-graph]"));
  expect(view.querySelector("[data-sheet-graph]")?.getAttribute("aria-pressed")).toBe("true");
  expect(view.querySelectorAll(".gs-graph .pnode")).toHaveLength(4);
  expect(view.querySelector(".gs-graph .pnode.selected")?.getAttribute("data-stage")).toBe("merge");
  expect(view.querySelector('.gs-graph .pstrip[data-strip="verify:fail:implement"]')).toBeTruthy();
  click(view.querySelector('.gs-graph .pnode[data-stage="review"]'));
  await tick();
  expect(selectedTab(host)).toBe("review");
  expect(view.querySelector(".gs-graph .pnode.selected")?.getAttribute("data-stage")).toBe("review");
  expect(host.querySelector("[data-agent-window]")).toBeNull();
  click(view.querySelector("[data-sheet-graph]"));
  expect(view.querySelector(".gs-graph")).toBeNull();
  expect(view.querySelectorAll('[role="tab"]')).toHaveLength(4);
});

/* The agent the window's reader shows, once its first read settled. */
async function inWindow(host: HTMLElement, file: FileEntry): Promise<HTMLElement> {
  for (let waited = 0; waited < 3000; waited += 10) {
    const reader = host.querySelector<HTMLElement>(`[data-agent-window] .reader-slot:not([data-incoming]) [data-kanban-reader="${idOf(file)}"]`);
    if (reader) return reader;
    await tick(10);
  }
  throw new Error(`the agent window never showed ${idOf(file)}`);
}
const parked = (host: HTMLElement, file: FileEntry) => host.querySelector<HTMLElement>(`.reader-park [data-kanban-reader="${idOf(file)}"]`);

test("a stage chip opens its agent in the window; its pane in the Stages sheet takes the same mounted conversation from the window", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="verify"]'));
  await inWindow(host, verify2);
  const container = host.querySelector<HTMLElement>(`[data-agent-window] .reader-host[data-reader-key="${verify2.conversationId}"]`);
  expect(container).toBeTruthy();
  expect(card(host).querySelector(".reader-slot, [data-kanban-reader]")).toBeNull();
  /* The chip that opened it wears its ring. */
  expect(card(host).querySelector('.pb-pills [data-stage="verify"]')?.classList.contains("selected")).toBe(true);
  press(card(host).querySelector("[data-open-stages]"));
  await tick();
  /* The window has it, so the pane says where it is and offers it back. */
  expect(pane(host, "verify")!.querySelector("[data-pane-away]")).toBeTruthy();
  click(pane(host, "verify")!.querySelector("[data-pane-away] button"));
  await tick();
  expect(host.querySelector("[data-agent-window]")).toBeNull();
  same(pane(host, "verify")!.querySelector(".reader-host"), container);
  key(sheet(host), "Escape");
  await tick();
  expect(sheet(host)).toBeNull();
  /* Still open: it waits in the park, the same conversation. */
  same(parked(host, verify2)?.closest(".reader-host"), container);
  same(document.activeElement, card(host).querySelector("[data-open-stages]"));
});

test("a shelf column never widens for an agent opened from its card", async () => {
  const { host } = mount(searchPipeline(), { status: "blocked" });
  await tick();
  const column = () => host.querySelector<HTMLElement>('.column[data-status="blocked"]')!;
  expect(column().classList.contains("reading")).toBe(false);
  click(card(host).querySelector('.pb-pills [data-stage="verify"]'));
  await inWindow(host, verify2);
  expect(column().classList.contains("reading")).toBe(false);
  expect(column().classList.contains("agent")).toBe(false);
});

test("tabs walk the lane with the keys and the ‹ › buttons, mount one reader at a time, and attempt tabs switch it; the attempt choice outlives the sheet", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const view = sheet(host)!;
  expect(selectedTab(host)).toBe("verify");
  expect(view.querySelectorAll("[data-kanban-reader]")).toHaveLength(1);
  /* A tab press selects; it opens no agent window. */
  click(tabOf(host, "review"));
  await tick();
  expect(selectedTab(host)).toBe("review");
  expect(host.querySelector("[data-agent-window]")).toBeNull();
  expect(readerIn(pane(host, "review"))).toBe(idOf(review1));
  expect(view.querySelectorAll("[data-kanban-reader]")).toHaveLength(1);
  /* The tab list walks with the arrow keys, Home and End; ‹ › do the same. */
  key(tabOf(host, "review"), "ArrowRight");
  expect(selectedTab(host)).toBe("verify");
  same(document.activeElement, tabOf(host, "verify"));
  key(tabOf(host, "verify"), "End");
  expect(selectedTab(host)).toBe("merge");
  key(tabOf(host, "merge"), "Home");
  expect(selectedTab(host)).toBe("implement");
  key(tabOf(host, "implement"), "ArrowLeft");
  expect(selectedTab(host)).toBe("implement");
  click(view.querySelector("[data-lane-next]"));
  expect(selectedTab(host)).toBe("review");
  click(view.querySelector("[data-lane-prev]"));
  expect(selectedTab(host)).toBe("implement");
  /* A graph node selects its stage too. */
  click(view.querySelector("[data-sheet-graph]"));
  click(view.querySelector('.gs-graph .pnode[data-stage="verify"]'));
  await tick();
  expect(selectedTab(host)).toBe("verify");
  expect(view.querySelector(".gs-graph .pnode.selected")?.getAttribute("data-stage")).toBe("verify");
  click(view.querySelector("[data-sheet-graph]"));
  click(pane(host, "verify")!.querySelector('[data-attempt="1"]'));
  await tick();
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify1));
  expect(pane(host, "verify")!.querySelector(".pstate")?.textContent).toBe("failed");
  /* The attempt choice outlives the sheet; the selection starts on the live stage again. */
  click(view.querySelector("[data-sheet-close]"));
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(selectedTab(host)).toBe("verify");
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify1));
});

test("a draft typed in a stage's first message is not lost when another tab is selected", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const merge = pick(host, "merge");
  click(merge.querySelector("[data-draft-edit]"));
  type(merge.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Merge after one warm query.");
  pick(host, "review");
  expect(pane(host, "merge")).toBeNull();
  const back = pick(host, "merge");
  /* The edit is the board's own store: leaving and coming back finds the words. */
  expect(back.querySelector<HTMLTextAreaElement>("textarea.draft-edit")?.value ?? back.querySelector("[data-draft-message]")?.textContent).toContain("Merge after one warm query.");
});

/* The engine appended an adopted helper conversation to Verify's run as n=2,
   so Verify's own attempts read 1 and 3: the tabs say attempt 1 and 2, as the
   graph does, and the record's n still chooses the reader. */
test("attempt tabs number the stage's own attempts, not the record's n", async () => {
  const helper = conversation("verify-helper");
  const adopted = searchPipeline({
    runs: searchPipeline().runs.map((run) => (run.stageId === "verify"
      ? { ...run, attempts: [run.attempts[0]!, attempt(2, "passed", helper, 3000, { historical: true }), { ...run.attempts[1]!, n: 3 }] }
      : run)),
  } as Partial<Pipeline>);
  const { host } = mount(adopted, { files: [...baseFiles, helper] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const tabs = [...pane(host, "verify")!.querySelectorAll<HTMLElement>("[data-attempt]")];
  expect(tabs.map((tab) => tab.dataset.attempt)).toEqual(["1", "3"]);
  expect(tabs.map((tab) => tab.textContent)).toEqual(["attempt 1 · failed", "attempt 2 · running"]);
  expect(tabs[1]!.getAttribute("aria-label")).toBe("Attempt 2, running");
  click(tabs[0]!);
  await tick();
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify1));
});

/* The pane shows the project setup of the attempt it shows, and its attempt
   tabs switch the failed setup for its retry: a pass is one closed line, a
   failure opens on its command and the end of its output. A failed setup
   parks the stage before its agent starts, so that attempt has no
   conversation and says so in one line under the setup. */
test("a stage pane shows the setup of the attempt it shows; attempt tabs switch it", async () => {
  const install = Array.from({ length: 12 }, (_, index) => `install step ${index + 1}`).join("\n");
  const setup = (state: "failed" | "passed") => ({ command: ["sh", "scripts/setup.sh", "--profile", "two words"], cwd: "/fixture/worktree/web", hash: "a".repeat(64), state,
    startedAt: iso(7300), completedAt: iso(7290), code: state === "passed" ? 0 : 7,
    stdout: state === "failed" ? install : "Preparing dependencies", stderr: state === "failed" ? "Dependency unavailable" : "" });
  const record = searchPipeline({
    runs: searchPipeline().runs.map((run) => (run.stageId === "implement"
      ? { ...run, attempts: [{ ...run.attempts[0]!, conversationId: null, agentPath: null, setup: setup("failed") }, { ...run.attempts[1]!, n: 4, setup: setup("passed") }] }
      : run)),
  } as Partial<Pipeline>);
  const { host } = mount(record);
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  pick(host, "implement");
  const results = () => [...pane(host, "implement")!.querySelectorAll<HTMLElement>("[data-stage-setup]")];
  expect(results().map((result) => result.querySelector("summary")?.textContent)).toEqual(["Project setup done"]);
  expect(results()[0]!.querySelector("details")!.hasAttribute("open")).toBe(false);
  expect(pane(host, "implement")!.querySelector(".pane-conv.line")).toBeNull();
  click(pane(host, "implement")!.querySelector('[data-attempt="1"]'));
  await tick();
  expect(pane(host, "implement")!.querySelector(".pane-conv.line")?.textContent).toBe("No conversation recorded");
  expect(results().map((result) => result.querySelector("summary")?.textContent)).toEqual(["Project setup failed · exit 7"]);
  const failed = results()[0]!;
  expect(failed.querySelector("details")!.hasAttribute("open")).toBe(true);
  expect(failed.querySelector("[data-stage-setup-command]")!.textContent).toBe("$ sh scripts/setup.sh --profile 'two words'");
  expect(failed.textContent).toContain("in web");
  expect(failed.textContent).toContain("Dependency unavailable");
  /* The tail: the last eight install lines, the earlier ones behind "show all output". */
  const streams = [...failed.querySelectorAll("pre")].map((pre) => pre.textContent);
  expect(streams).toEqual(["Dependency unavailable", Array.from({ length: 8 }, (_, index) => `install step ${index + 5}`).join("\n")]);
  /* A stage whose attempts ran no setup draws none. */
  pick(host, "verify");
  expect(pane(host, "verify")!.querySelector("[data-stage-setup]")).toBeNull();
});

test("a pane's actions offer retry and skip only for the stage the pipeline waits on", async () => {
  const { host } = mount(searchPipeline({ state: "needs_decision", cursor: { stageId: "verify", state: "running", input: null, activatedBy: null } } as Partial<Pipeline>));
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  click(pick(host, "implement").querySelector("[data-pane-menu]"));
  expect(menuLabels(host)).toEqual([
    ["Retry this stage", true, "The pipeline waits on another stage"],
    ["Skip this stage", true, "The pipeline waits on another stage"],
  ]);
  key(host.querySelector(".menu"), "Escape");
  await tick();
  click(pick(host, "verify").querySelector("[data-pane-menu]"));
  expect(menuItem(host, "Retry this stage")?.getAttribute("aria-disabled")).toBeNull();
  key(host.querySelector(".menu"), "Escape");
  await tick();
  click(pick(host, "merge").querySelector("[data-pane-menu]"));
  expect(menuItem(host, "Edit the first message")).toBeTruthy();
  click(menuItem(host, "Edit the first message"));
  await tick();
  same(document.activeElement, pane(host, "merge")!.querySelector("textarea.draft-edit"));
});

test("a waiting node opens its first message in the agent window, never on the card; Save re-reads the stage and writes the words into the stage's own wiring", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  const before = card(host).innerHTML.replace(/ selected/g, "");
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = draftPanel(host)!;
  same(document.activeElement, panel);
  /* The card holds no panel and keeps what it drew; only the pill's ring says the stage is open. */
  expect(card(host).querySelector("[data-stage-detail], [data-draft-message], textarea")).toBeNull();
  expect(card(host).innerHTML.replace(/ selected/g, "")).toBe(before);
  /* The window lists it as one more agent, in the words its head uses. */
  expect([...host.querySelectorAll<HTMLElement>("[data-agent-window] [data-open-agent-jump]")].map((row) => row.getAttribute("aria-label"))).toEqual([expect.stringContaining("Merge · Restore search results after the index rebuild")]);
  expect(host.querySelector("[data-agent-window] [data-open-agent-jump]")?.getAttribute("aria-current")).toBe("true");
  expect(host.querySelector("[data-agent-window] [data-open-agent-dot]")?.getAttribute("data-open-agent-dot")).toBe("idle");
  expect(panel.querySelector(".ch-title")?.textContent).toBe("Merge · Restore search results after the index rebuild");
  expect(panel.querySelector(".ch-stage")?.textContent).toBe("stage 4/4");
  expect(card(host).querySelector('.pb-pills [data-stage="merge"]')?.classList.contains("selected")).toBe(true);
  click(panel.querySelector("[data-draft-edit]"));
  const field = panel.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!;
  same(document.activeElement, field);
  expect(field.value).toBe("Merge once the alias swap is verified.");
  expect(panel.querySelector<HTMLButtonElement>("[data-draft-save]")?.disabled).toBe(true);
  type(field, "Merge after the alias swap and one warm query.");
  key(field, "Enter", { ctrlKey: true });
  await tick();
  expect(route.reads).toEqual(["p-search"]);
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "override-stage", stageId: "merge", prompt: "{{prev.output}}\n\nMerge after the alias swap and one warm query.", expectedStageDigest: stageDigest(searchPipeline().stages.find((entry) => entry.id === "merge")!) } }]);
  expect(panel.querySelector("textarea.draft-edit")).toBeNull();
  expect(panel.querySelector(".bstatus")?.textContent).toMatch(/^First message · not sent yet · edited \d/);
  same(document.activeElement, panel.querySelector("[data-draft-edit]"));
});

/* Audit B10: Save closes the editor at once and shows the new words; a refusal reopens it with the reason. */
test("a save closes the editor at once and shows the new words while the write is held; a refusal reopens it with the words and the reason", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = () => draftPanel(host)!;
  click(panel().querySelector("[data-draft-edit]"));
  type(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Merge after one warm query.");
  route.state.hold = true;
  route.state.answers.push({ ok: false, status: 500, error: "store busy" });
  click(panel().querySelector("[data-draft-save]"));
  await tick();
  expect(route.patches).toHaveLength(1);
  expect(panel().querySelector("textarea.draft-edit")).toBeNull();
  expect(panel().querySelector("[data-draft-saving-text]")?.textContent).toBe("Merge after one warm query.");
  expect(panel().querySelector("[data-draft-save]")).toBeNull();
  route.state.release();
  await tick();
  expect(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")?.value).toBe("Merge after one warm query.");
  expect(panel().querySelector("[data-draft-failed] .msg-text")?.textContent).toContain("store busy");
  expect(route.patches).toHaveLength(1);
});

test("words saved elsewhere since the edit began stop the save; Use theirs keeps them, Keep mine saves over them", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = () => draftPanel(host)!;
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
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = () => draftPanel(host);
  click(panel()!.querySelector("[data-draft-edit]"));
  type(panel()!.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Too late.");
  route.state.answers.push({ ok: false, status: 409, error: "stage has already started" });
  click(panel()!.querySelector("[data-draft-save]"));
  await tick();
  expect(route.patches).toHaveLength(1);
  expect(panel()!.querySelector("[data-draft-undelivered] .msg-text")?.textContent).toBe("Merge started with its previous first message. Your edit was not delivered.");
  expect(panel()!.querySelector("[data-draft-undelivered] .kept")?.textContent).toBe("Too late.");
  expect(receiptTexts(host)).toEqual([]);
  /* The catalog catches up: the stage has its conversation, and the draft still holds its place in the window. */
  update(mergeStarted(), [...baseFiles, merge1]);
  await tick();
  expect(panel()).toBeTruthy();
  click([...panel()!.querySelectorAll<HTMLElement>("[data-draft-undelivered] button")].find((button) => button.textContent === "Discard"));
  await inWindow(host, merge1);
  expect(panel()).toBeNull();
  /* The stage's agent takes the draft's place in the window, and the card holds nothing in its place. */
  expect([...host.querySelectorAll("[data-agent-window] [data-open-agent]")].map((row) => row.getAttribute("data-open-agent"))).toEqual([idOf(merge1)]);
  expect(card(host).querySelector("[data-kanban-reader], [data-stage-detail]")).toBeNull();
});

test("Escape cancels an edit and hands focus back to Edit; a first message with nothing unsaved gives its place in the window to its agent when its stage starts", async () => {
  const { host, route, update } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = () => draftPanel(host);
  click(panel()!.querySelector("[data-draft-edit]"));
  type(panel()!.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Never mind.");
  key(panel()!.querySelector("textarea.draft-edit"), "Escape");
  await tick();
  expect(panel()!.querySelector("textarea.draft-edit")).toBeNull();
  expect(panel()).toBeTruthy();
  same(document.activeElement, panel()!.querySelector("[data-draft-edit]"));
  expect(route.patches).toEqual([]);
  /* Escape in the field closes the edit only: the window stays. */
  expect(host.querySelector("[data-agent-window]")).toBeTruthy();
  expect(panel()!.querySelector("[data-panel-fold]")).toBeNull();
  /* Edit from the draft's actions opens it on the field. */
  click(panel()!.querySelector("[data-panel-menu]"));
  expect(menuLabels(host).map(([label]) => label)).toEqual(["Edit the first message", "Run on account…", "Retry this stage", "Skip this stage", "Show in Stages"]);
  click(menuItem(host, "Edit the first message"));
  await tick();
  same(document.activeElement, panel()!.querySelector("textarea.draft-edit"));
  key(panel()!.querySelector("textarea.draft-edit"), "Escape");
  await tick();
  update(mergeStarted(), [...baseFiles, merge1]);
  await inWindow(host, merge1);
  expect(panel()).toBeNull();
  expect(host.querySelector("[data-open-agents-pill] .pill-words")?.textContent).toBe("1 agent");
});

/* ── Review follow-ups ─────────────────────────────────────────────────── */

const parkedOn = (stageId: string) => searchPipeline({ state: "needs_decision", cursor: { stageId, state: "running", input: null, activatedBy: null } } as Partial<Pipeline>);

test("a refused skip's Retry sends the same guarded expectations; with the cursor moved the engine refuses it, and the receipt names the stage it waits on now", async () => {
  const { host, route } = mount(parkedOn("verify"));
  await tick();
  route.state.answers.push({ ok: false, status: 409, error: "the stage worktree has uncommitted changes" });
  click(laneMenu(host));
  click(menuItem(host, "Skip Verify"));
  await tick(4_300);
  expect(route.reads).toEqual([]);
  const guarded: PatchPipelineRequest = { action: "skip-stage", expectedStageId: "verify", expectedAttempt: 2 };
  expect(route.patches.map((patch) => patch.body)).toEqual([guarded]);
  const refused = host.querySelector("[data-kanban-receipt].error");
  expect(refused?.querySelector(".msg")?.textContent).toBe("Skip Verify was refused: the stage worktree has uncommitted changes");
  route.state.record = parkedOn("implement");
  click(refused?.querySelector(".act"));
  await tick();
  expect(route.patches.map((patch) => patch.body)).toEqual([guarded, guarded]);
  /* Refused by the guard: read once, to say what waits now; nothing is resent. */
  expect(route.reads).toEqual(["p-search"]);
  expect(receiptTexts(host)).toEqual(["Skip Verify was not sent: the pipeline now waits on Implement."]);
});

test("a retry chosen on a stale menu is refused by the engine when another stage, or a newer attempt of the same stage, waits now; a current one retries", async () => {
  const { host, route } = mount(parkedOn("verify"));
  await tick();
  route.state.record = parkedOn("implement");
  click(laneMenu(host));
  click(menuItem(host, "Retry Verify"));
  await tick();
  expect(route.patches.map((patch) => patch.body)).toEqual([{ action: "retry-stage", expectedStageId: "verify", expectedAttempt: 2 }]);
  expect(receiptTexts(host)).toEqual(["Retry Verify was not sent: the pipeline now waits on Implement."]);

  const newer = parkedOn("verify");
  newer.runs.find((run) => run.stageId === "verify")!.attempts.push(attempt(3, "failed", verify2, 60) as never);
  route.state.record = newer;
  click(laneMenu(host));
  click(menuItem(host, "Retry Verify"));
  await tick();
  expect(receiptTexts(host).at(-1)).toBe("Retry Verify was not sent: a newer attempt of Verify waits now.");

  route.state.record = null;
  click(laneMenu(host));
  click(menuItem(host, "Retry Verify"));
  await tick();
  expect(route.patches.at(-1)?.body).toEqual({ action: "retry-stage", expectedStageId: "verify", expectedAttempt: 2 });
  expect(receiptTexts(host).at(-1)).toBe("Retrying Verify in «Restore search results after the index rebuild»");
});

test("a stage another client changes between the save's read and its write is refused by the engine and keeps that client's words, which the notice shows", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = () => draftPanel(host)!;
  click(panel().querySelector("[data-draft-edit]"));
  type(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Mine.");
  route.state.beforeWrite = () => { route.state.record = withMergePrompt(searchPipeline(), "{{prev.output}}\n\nTheirs, saved in between."); };
  click(panel().querySelector("[data-draft-save]"));
  await tick();
  expect(route.patches).toHaveLength(1);
  expect(route.patches[0]!.body.expectedStageDigest).toBe(stageDigest(searchPipeline().stages.find((entry) => entry.id === "merge")!));
  expect(route.reads).toEqual(["p-search", "p-search"]);
  expect(panel().querySelector("[data-draft-changed] .msg-text")?.textContent).toBe("Changed elsewhere since you began: «Theirs, saved in between.»");
  expect(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")?.value).toBe("Mine.");
});

test("when only the stage's account changed in between, the words are the same: the notice says so, and Keep mine saves against the new digest", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = () => draftPanel(host)!;
  click(panel().querySelector("[data-draft-edit]"));
  type(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Mine.");
  const otherAccount = searchPipeline();
  otherAccount.stages.find((entry) => entry.id === "merge")!.account = "account-b";
  route.state.beforeWrite = () => { route.state.record = otherAccount; };
  click(panel().querySelector("[data-draft-save]"));
  await tick();
  expect(panel().querySelector("[data-draft-changed] .msg-text")?.textContent).toBe("The stage's account, role or runtime changed elsewhere since you began; its words did not. Your text is kept.");
  click([...panel().querySelectorAll<HTMLElement>("[data-draft-changed] button")].find((button) => button.textContent === "Keep mine"));
  await tick();
  expect(route.patches.map((patch) => patch.body.expectedStageDigest)).toEqual([
    stageDigest(searchPipeline().stages.find((entry) => entry.id === "merge")!),
    stageDigest(otherAccount.stages.find((entry) => entry.id === "merge")!),
  ]);
  expect(panel().querySelector("textarea.draft-edit")).toBeNull();
});

test("a read without the stage's digest sends no unguarded write", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  const panel = () => draftPanel(host)!;
  click(panel().querySelector("[data-draft-edit]"));
  type(panel().querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Mine.");
  route.state.omitDigests = true;
  click(panel().querySelector("[data-draft-save]"));
  await tick();
  expect(route.patches).toEqual([]);
  expect(panel().querySelector("[data-draft-failed]")).toBeTruthy();
});

test("an action with no answer is not confirmed, never refused; Check again only reads, and says what the pipeline shows", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  route.state.answers.push({ ok: false, status: 0, error: "Failed to fetch", unknown: true });
  click(laneMenu(host));
  click(menuItem(host, "Pause"));
  await tick();
  const receipt = () => host.querySelector("[data-kanban-receipt].error");
  expect(receipt()?.querySelector(".msg")?.textContent).toBe("Pause for «Restore search results after the index rebuild» is not confirmed: no answer came back, so it may or may not have run. Nothing is sent again.");
  expect(receipt()?.querySelector(".act")?.textContent).toBe("Check again");
  expect(receiptTexts(host).some((text) => text?.includes("refused"))).toBe(false);
  click(receipt()?.querySelector(".act"));
  await tick();
  expect(route.patches).toHaveLength(1);
  expect(receipt()?.querySelector(".msg")?.textContent).toBe("Still not confirmed: Pause for «Restore search results after the index rebuild». The pipeline does not show it yet, and nothing was sent again.");
  route.state.record = searchPipeline({ state: "paused" } as Partial<Pipeline>);
  click(receipt()?.querySelector(".act"));
  await tick();
  expect(route.patches).toHaveLength(1);
  expect(route.reads).toEqual(["p-search", "p-search"]);
  expect(receiptTexts(host)).toEqual(["«Restore search results after the index rebuild» is paused now"]);
});

const openMergePanel = async (host: HTMLElement) => {
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  return () => draftPanel(host);
};
const mergeStartedWith = (prompt: string, attemptOver: Record<string, unknown> = {}, over: Partial<Pipeline> = {}) => withMergePrompt(
  searchPipeline(over, { stageId: "merge", attempts: [attempt(1, "running", merge1, 30, attemptOver)] }),
  prompt,
);

test("a save with no answer is not confirmed; when the stage starts holding those words the draft goes and the agent joins the window's list", async () => {
  const { host, route, update } = mount(searchPipeline());
  await tick();
  const panel = await openMergePanel(host);
  click(panel()!.querySelector("[data-draft-edit]"));
  type(panel()!.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Merge after one warm query.");
  route.state.answers.push({ ok: false, status: 0, error: "Failed to fetch", unknown: true });
  click(panel()!.querySelector("[data-draft-save]"));
  await tick();
  expect(panel()!.querySelector("[data-draft-unconfirmed] .msg-text")?.textContent).toBe("Not confirmed: no answer came back, so this save may or may not have reached the stage. Your text is kept.");
  expect(panel()!.textContent).not.toContain("Not saved");
  update(mergeStartedWith("{{prev.output}}\n\nMerge after one warm query."), [...baseFiles, merge1]);
  await inWindow(host, merge1);
  expect(panel()).toBeNull();
  expect(host.querySelector("[data-draft-undelivered]")).toBeNull();
});

test("an edit opened and left unchanged goes quietly when its stage starts", async () => {
  const { host, update } = mount(searchPipeline());
  await tick();
  const panel = await openMergePanel(host);
  click(panel()!.querySelector("[data-draft-edit]"));
  update(mergeStarted(), [...baseFiles, merge1]);
  await inWindow(host, merge1);
  expect(panel()).toBeNull();
  expect(host.querySelector("[data-draft-undelivered]")).toBeNull();
});

test("a pipeline closed before its stage launched says the edit was never sent, never that the stage started", async () => {
  const { host, update } = mount(searchPipeline());
  await tick();
  const panel = await openMergePanel(host);
  click(panel()!.querySelector("[data-draft-edit]"));
  type(panel()!.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "Wait for the alias swap.");
  const closed = { ...searchPipeline({ state: "closed" } as Partial<Pipeline>, { stageId: "merge", attempts: [attempt(1, "pending", null, 30, { startedAt: null })] }) } as Pipeline;
  update(closed);
  await tick();
  expect(panel()!.querySelector("[data-draft-ended] .msg-text")?.textContent).toBe("The pipeline ended before Merge started. Nothing was sent.");
  expect(panel()!.querySelector("[data-draft-ended] .kept")?.textContent).toBe("Wait for the alias swap.");
  expect(panel()!.querySelector("[data-draft-undelivered]")).toBeNull();
  expect(panel()!.textContent).not.toContain("started with");
  click(panel()!.querySelector("[data-panel-close]"));
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(pane(host, "merge")!.querySelector("[data-draft-message] .bstatus")?.textContent).toBe("Never delivered · the pipeline ended before this stage started");
  expect(pane(host, "merge")!.textContent).not.toContain("Starting the agent's host");
});

test("clearing a waiting stage's words saves its wiring alone", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  const panel = await openMergePanel(host);
  click(panel()!.querySelector("[data-draft-edit]"));
  type(panel()!.querySelector<HTMLTextAreaElement>("textarea.draft-edit")!, "");
  expect(panel()!.querySelector<HTMLButtonElement>("[data-draft-save]")?.disabled).toBe(false);
  key(panel()!.querySelector("textarea.draft-edit"), "Enter", { ctrlKey: true });
  await tick();
  expect(route.patches.map((patch) => patch.body)).toEqual([{ action: "override-stage", stageId: "merge", prompt: "{{prev.output}}", expectedStageDigest: stageDigest(searchPipeline().stages.find((entry) => entry.id === "merge")!) }]);
  expect(panel()!.querySelector("textarea.draft-edit")).toBeNull();
});

test("one folded line under the first message names what the controller adds at start, in the agent window and the pane, and unfolds to it", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  const panel = await openMergePanel(host);
  const added = panel()!.querySelector<HTMLDetailsElement>("[data-draft-added]")!;
  expect(added.open).toBe(false);
  expect(added.querySelector("summary")?.textContent).toBe("Added when it starts: previous stage output · pinned task · spec · role preset · access rules · verdict contract");
  const text = added.querySelector(".added-text")?.textContent ?? "";
  expect(text.startsWith("[previous stage output: not produced yet]\n\nPinned task:\nRestore search results\n")).toBe(true);
  expect(text).toContain("Pinned specification and acceptance criteria:\nNo separate pinned specification was supplied.");
  expect(text).toContain("Role preset: cleaner (claude/opus, high).");
  expect(text).toContain('{"status":"pass","findings":[]}');
  expect(text).not.toContain("Merge once the alias swap is verified.");
  click(panel()!.querySelector("[data-panel-close]"));
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(pick(host, "merge").querySelector("[data-draft-added] summary")?.textContent).toBe("Added when it starts: previous stage output · pinned task · spec · role preset · access rules · verdict contract");
});

test("while the Stages sheet is open the board's keys stay behind it, and a sheet that closes itself hands focus back", async () => {
  const { host, update } = mount(searchPipeline());
  await tick();
  press(card(host).querySelector("[data-open-stages]"));
  await tick();
  const search = host.querySelector("[data-kanban-search]");
  const target = pane(host, "verify")!;
  target.focus();
  let reachedWindow = false;
  const onWindowKey = () => { reachedWindow = true; };
  window.addEventListener("keydown", onWindowKey);
  key(target, "/");
  window.removeEventListener("keydown", onWindowKey);
  /* Neither the board's search nor the Viewer's window-level search takes it. */
  expect(reachedWindow).toBe(false);
  expect(document.activeElement === search).toBe(false);
  same(document.activeElement, target);
  expect(sheet(host)).toBeTruthy();
  /* The pipeline leaves the board: the sheet goes, and focus returns to the card. */
  update(null);
  await tick();
  await tick();
  expect(sheet(host)).toBeNull();
  same(document.activeElement, card(host));
});

test("a stage waiting before any attempt of its own is expected as attempt 0, and that menu is refused once attempt 1 has started and parked", async () => {
  const { host, route } = mount(parkedOn("merge"));
  await tick();
  click(laneMenu(host));
  const started = parkedOn("merge");
  started.runs.push({ stageId: "merge", attempts: [attempt(1, "needs_decision", merge1, 30)] } as never);
  route.state.record = started;
  click(menuItem(host, "Skip Merge"));
  await tick(4_300);
  expect(route.patches.map((patch) => patch.body)).toEqual([{ action: "skip-stage", expectedStageId: "merge", expectedAttempt: 0 }]);
  expect(receiptTexts(host)).toEqual(["Skip Merge was not sent: a newer attempt of Merge waits now."]);

  route.state.record = null;
  click(laneMenu(host));
  click(menuItem(host, "Retry Merge"));
  await tick();
  expect(route.patches.at(-1)?.body).toEqual({ action: "retry-stage", expectedStageId: "merge", expectedAttempt: 0 });
  expect(receiptTexts(host).at(-1)).toBe("Retrying Merge in «Restore search results after the index rebuild»");
});

/* Stage cards say which stage they are (#1865): a design stage and a critique
   stage share the architect preset, and critique ran twice. A stage's reader
   names the stage the way the stage list does, with the attempt once there are
   two; the preset moves to the header's tooltip. */
test("readers of stages that share a role preset carry the stage's name and attempt, as the stage list names them", async () => {
  const design1 = conversation("design-1");
  const critique1 = conversation("critique-1");
  const critique2 = conversation("critique-2");
  const record = {
    ...searchPipeline(),
    stages: [stage("design", "architect", "critique"), stage("critique", "architect", null, { onFail: { to: "design", maxRounds: 2 } })],
    runs: [
      { stageId: "design", attempts: [attempt(1, "passed", design1, 7200)] },
      { stageId: "critique", attempts: [attempt(1, "failed", critique1, 5000), attempt(2, "running", critique2, 1200)] },
    ],
    cursor: { stageId: "critique", state: "running", input: null, activatedBy: null },
  } as unknown as Pipeline;
  const { host } = mount(record, { files: [design1, critique1, critique2] });
  await tick();
  const title = "Restore search results after the index rebuild";
  /* Every agent opened from the card: the one in the window and those waiting in the park. */
  const headers = () => [...host.querySelectorAll<HTMLElement>(".conv-head .ch-title")];

  click(card(host).querySelector('.pb-pills [data-stage="design"]'));
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="critique"]'));
  await tick();
  /* The earlier critique opens from the card's timeline. */
  click([...card(host).querySelectorAll<HTMLElement>("[data-chronology-entry] .chronology-open")].find((button) => button.textContent?.startsWith("Critique")));
  await tick();
  expect(headers().map((header) => header.textContent).sort()).toEqual([`Critique · 1 · ${title}`, `Critique · 2 · ${title}`, `Design · ${title}`]);
  /* The preset is secondary: in the tooltip only, and left out nowhere it adds. */
  expect(headers().some((header) => header.textContent?.includes("Architect"))).toBe(false);
  const hint = (label: string) => headers().find((header) => header.textContent === `${label} · ${title}`)?.getAttribute("title");
  expect(hint("Critique · 2")).toBe(`Critique, attempt 2 of 2 · Architect · Claude · ${title}`);
  expect(hint("Critique · 1")).toBe(`Critique, attempt 1 of 2 · Architect · Claude · ${title}`);
  expect(hint("Design")).toBe(`Design · Architect · Claude · ${title}`);

  /* The names are the stage list's, letter for letter. */
  press(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect([...sheet(host)!.querySelectorAll<HTMLElement>('[role="tab"] .slbl')].map((name) => name.textContent)).toEqual(["Design", "Critique"]);
  expect(pane(host, "critique")!.querySelector(".pname")?.textContent).toBe("2. Critique");
  expect(pick(host, "design").querySelector(".pname")?.textContent).toBe("1. Design");
});

/* ── The lane's answers are its ⋯ (#2072, docs/design/calm-task-cards-build.md §4) ── */

/* Verify's second attempt came back failed and the lane waits on the operator. */
const parkedOnVerify = () => searchPipeline({
  state: "needs_decision",
  runs: searchPipeline().runs.map((run) => (run.stageId === "verify"
    ? { ...run, attempts: [run.attempts[0]!, { ...run.attempts[1]!, state: "failed", completedAt: iso(600), verdict: { status: "fail", findings: ["P1 — the alias swaps before the new index answers"], rankedFindings: [{ severity: "P1", text: "the alias swaps before the new index answers" }] } }] }
    : run)),
} as Partial<Pipeline>);
const answer = (host: HTMLElement, action: string) => card(host).querySelector<HTMLButtonElement>(`.pblock [data-answer-action="${action}"]`);

test("a lane that waits on a decision says what it stopped on and offers no answer on its row; the ⋯ holds Skip and Retry in their words", async () => {
  const { host, route } = mount(parkedOnVerify());
  await tick();
  expect(card(host).querySelectorAll("[data-answer-action]")).toHaveLength(0);
  /* What it stopped on, in place: the parked stage's first finding. */
  expect(card(host).querySelector(".pb-answer .stage-findings li")?.textContent).toBe("P1the alias swaps before the new index answers");
  click(laneMenu(host));
  expect(menuItem(host, "Skip Verify")?.getAttribute("data-cm-item")).toBe("answer:skip-stage");
  click(menuItem(host, "Retry Verify"));
  await tick();
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "retry-stage", expectedStageId: "verify", expectedAttempt: 2 } }]);
  expect(receiptTexts(host).at(-1)).toBe("Retrying Verify in «Restore search results after the index rebuild»");
});

/* The orchestrator owns the lane (docs/design/calm-task-cards-build.md §4, the chosen form): Skip and Retry are quiet links on the stop's timeline entry, held out of the ⋯. */
const seatOwnedOnVerify = (): Pipeline => {
  const lane = parkedOnVerify();
  lane.attentionRoute = { key: laneRouteKey(lane, "lane-decision"), owner: "seat", seat: "conversation_seat" };
  return lane;
};

test("a seat-owned stop carries Skip and Retry as links on its entry, not in the ⋯; Retry sends one request", async () => {
  const { host, route } = mount(seatOwnedOnVerify());
  await tick();
  const links = [...card(host).querySelectorAll<HTMLElement>('[data-chronology-stop="p-search"] [data-chronology-link]')];
  expect(links.map((link) => [link.getAttribute("data-chronology-link"), link.textContent])).toEqual([["skip-stage", "Skip Verify"], ["retry-stage", "Retry Verify"]]);
  /* One row: both links share the same acts container, and the stop has no ⋯ of its own. */
  expect(new Set(links.map((link) => link.parentElement)).size).toBe(1);
  expect(card(host).querySelector("[data-chronology-stop-menu]")).toBeNull();
  click(laneMenu(host));
  expect(menuItem(host, "Skip Verify")).toBeNull();
  expect(menuItem(host, "Retry Verify")).toBeNull();
  click(laneMenu(host));
  click(links[1]);
  await tick();
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "retry-stage", expectedStageId: "verify", expectedAttempt: 2 } }]);
});

test("Skip as a link is held for its receipt before anything is sent", async () => {
  const { host, route } = mount(seatOwnedOnVerify());
  await tick();
  click(card(host).querySelector('[data-chronology-link="skip-stage"]'));
  await tick();
  expect(route.patches).toEqual([]);
  expect(receiptTexts(host).at(-1)).toBe("Skipping Verify in «Restore search results after the index rebuild»");
  await tick(4_300);
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "skip-stage", expectedStageId: "verify", expectedAttempt: 2 } }]);
});

test("the operator's own stop keeps its ⋯ and shows no link", async () => {
  const { host } = mount(parkedOnVerify());
  await tick();
  expect(card(host).querySelector("[data-chronology-link]")).toBeNull();
  expect(card(host).querySelector('[data-chronology-stop="p-search"] [data-chronology-stop-menu]')).toBeTruthy();
});

test("Skip from the ⋯ waits out its receipt before anything is sent, and its Undo sends nothing", async () => {
  const { host, route } = mount(parkedOnVerify());
  await tick();
  click(laneMenu(host));
  click(menuItem(host, "Skip Verify"));
  await tick();
  expect(route.patches).toEqual([]);
  expect(receiptTexts(host).at(-1)).toBe("Skipping Verify in «Restore search results after the index rebuild»");
  expect(card(host).querySelector("[data-pipeline-acting]")?.textContent).toBe("Skipping…");
  /* One answer at a time. */
  click(laneMenu(host));
  expect(menuItem(host, "Retry Verify")?.getAttribute("aria-disabled")).toBe("true");
  click(laneMenu(host));
  const undo = [...host.querySelectorAll<HTMLElement>("[data-kanban-receipt] .act")].find((button) => button.textContent === "Undo");
  click(undo);
  await tick();
  expect(card(host).querySelector("[data-pipeline-acting]")).toBeNull();
  expect(route.patches).toEqual([]);

  /* Left alone, the window closes and the guarded skip goes out. */
  click(laneMenu(host));
  click(menuItem(host, "Skip Verify"));
  await tick(4_300);
  expect(route.patches).toEqual([{ id: "p-search", body: { action: "skip-stage", expectedStageId: "verify", expectedAttempt: 2 } }]);
});

test("a lane stopped after its last fix says why on its row, and its ⋯ offers Accept as is, which reads the revision and sends one request (#1938, #2187)", async () => {
  const spent = searchPipeline({
    state: "needs_review",
    cursor: null,
    reviewPending: { stageId: "verify", attempt: 2, fixStageId: "implement", fixAttempt: 2, reviewedHead: "4f1c2a9d00", currentHead: "9b2e7d4c11", verdict: "fail", findings: 1, at: iso(600) },
  } as Partial<Pipeline>);
  const { host, route } = mount(spent);
  await tick();
  /* One line on why (§3.4); the two heads stay in its tooltip. */
  const reason = card(host).querySelector(".pb-answer [data-review-stop]");
  expect(reason?.textContent).toBe("Stopped after the last fix, as this pipeline asked: the fix is not reviewed.");
  expect(reason?.getAttribute("title")).toBe("last review fail on 4f1c2a9d · current head 9b2e7d4c unreviewed");
  /* No answer on the row (docs/design/calm-task-cards-build.md §6.2). */
  expect(card(host).querySelectorAll("[data-answer-action]")).toHaveLength(0);
  /* The lane's state word is the warning one, not the grey of an idle lane (#2080). */
  expect(card(host).querySelector('.pb-head .pstate-word[data-pstate="needs_review"]')?.textContent).toBe("needs review");
  click(laneMenu(host));
  const accept = menuItem(host, "Accept as is");
  expect(accept?.getAttribute("data-cm-item")).toBe("answer:accept-head");
  click(accept);
  await tick(20);
  expect(route.reads).toEqual(["p-search"]);
  expect(route.patches).toHaveLength(1);
  const body = route.patches[0]!.body as PatchPipelineRequest & { clientRequestId: string };
  expect({ ...body, clientRequestId: body.clientRequestId.startsWith("board-") }).toEqual({ action: "accept-head", expectedRevision: REVISION, clientRequestId: true });
  expect(receiptTexts(host).at(-1)).toBe("Accepted «Restore search results after the index rebuild» as is");
});

test.each(["running", "passed", "failed", "needs_decision"] as const)("desktop stage agent row opens the latest %s attempt and earlier conversations", async (state) => {
  const p = searchPipeline();
  p.state = state === "running" ? "running" : state === "passed" ? "completed" : "needs_decision";
  const run = p.runs.find((run) => run.stageId === "verify")!;
  run.attempts[1] = { ...run.attempts[1]!, state, report: { verdict: { status: "needs_decision", findings: [] }, summary: "Choose a layout.\nCompact or expanded?" } } as unknown as typeof run.attempts[number];
  const { host } = mount(p);
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const stage = pane(host, "verify")!;
  expect(stage.querySelector('[data-open-conversation="verify"]')?.textContent).toBe("Open agent");
  expect(stage.querySelector('[data-stage-question]')?.textContent ?? null).toBe(state === "needs_decision" ? "Choose a layout.\nCompact or expanded?" : null);
  click(stage.querySelector('[data-attempt="1"]'));
  await tick();
  expect(readerIn(pane(host, "verify"))).toBe(idOf(verify1));
  click(stage.querySelector('[data-open-conversation="verify"]'));
  await tick();
  expect(sheet(host)).toBeNull();
  const reader = host.querySelector(`[data-kanban-reader="${idOf(verify2)}"]`);
  expect(reader).toBeTruthy();
  expect(reader!.closest('[data-stages-sheet]')).toBeNull();
});

test("a cloud stage's pane opens its stored cloud task through the conversation control's place, a local stage keeps its button", async () => {
  const taskUrl = "https://example.com/cloud/tasks/task_abc123";
  const cloudOf = (cloud: Record<string, unknown>) => {
    const p = searchPipeline();
    const run = p.runs.find((entry) => entry.stageId === "verify")!;
    run.attempts = [{ ...run.attempts.at(-1)!, n: 1, conversationId: null, agentPath: null, definition: { runtime: "codex-cloud" }, cloud } as unknown as typeof run.attempts[number]];
    return p;
  };
  const cleanup = () => {
    for (const root of roots.splice(0)) flushSync(() => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
  };
  const openPane = async (p: Pipeline) => {
    const { host } = mount(p);
    await tick();
    click(card(host).querySelector("[data-open-stages]"));
    await tick();
    return pane(host, "verify")!;
  };
  const withUrl = await openPane(cloudOf({ phase: "completed", taskId: "task_abc123", taskUrl }));
  const link = withUrl.querySelector<HTMLAnchorElement>('[data-open-cloud="verify"]');
  expect(link?.getAttribute("href")).toBe(taskUrl);
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link?.textContent).toBe("Open cloud task");
  expect(withUrl.querySelector('[data-open-conversation="verify"]')).toBeNull();
  cleanup();
  const without = await openPane(cloudOf({ phase: "submitting", taskId: null, taskUrl: null, submissionUnresolved: true }));
  expect(without.querySelector("[data-open-cloud]")).toBeNull();
  expect(without.querySelector("[data-open-conversation]")).toBeNull();
  cleanup();
  const local = await openPane(searchPipeline());
  expect(local.querySelector('[data-open-conversation="verify"]')?.textContent).toBe("Open agent");
  expect(local.querySelector("[data-open-cloud]")).toBeNull();
});

test("stage memory follows the displayed attempt and stays absent for legacy attempts", async () => {
  const pipeline = searchPipeline();
  const attempts = pipeline.runs.find(run => run.stageId === "verify")!.attempts;
  attempts[0]!.memoryCap = { limitBytes: 8 * 2 ** 30, requestedBytes: 12 * 2 ** 30, source: "stage", enforced: true, clamped: true };
  attempts[1]!.memoryCap = { limitBytes: null, requestedBytes: null, source: "automatic", enforced: false, clamped: false };
  const { host } = mount(pipeline);
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  const note = () => pane(host, "verify")!.querySelector("[data-agent-memory-cap]")?.textContent;
  expect(note()).toBe("Memory cap: containment is off or unavailable.");
  click(pane(host, "verify")!.querySelector('[data-attempt="1"]'));
  expect(note()).toContain("8");
  expect(note()).toContain("12");
  expect(pick(host, "review").querySelector("[data-agent-memory-cap]")).toBeNull();
  click(pick(host, "verify").querySelector('[data-attempt="2"]'));
  expect(note()).toBe("Memory cap: containment is off or unavailable.");
});

/* Where the lane's heavy checks run (docs/design/cloud-checks.md): the lane's
   «Checks» row opens its choices over the same anchor, read from the route
   the phone and the MCP tool use. */
const settings = (value: Record<string, unknown>) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const checksPopover = () => document.querySelector<HTMLElement>("[data-pipeline-checks]");
const choices = () => [...(checksPopover()?.querySelectorAll<HTMLElement>("[data-pipeline-checks-choice]") ?? [])].map((item) => [item.getAttribute("data-pipeline-checks-choice"), item.textContent, item.getAttribute("aria-checked")]);
async function openChecks(host: HTMLElement) {
  click(laneMenu(host));
  click(menuItem(host, "Checks"));
  await tick();
  await tick();
}

test("the lane's Checks row opens the publishing stage's override and the value each inherited choice resolves to; a pick stays open and Escape returns to the ⋯", async () => {
  let state: Record<string, unknown> = { project: "cloud", override: "local", stageOverride: "cloud", effective: "cloud" };
  checksRoute = (call) => {
    if (call.method === "POST") state = { project: "cloud", override: "local", stageOverride: null, effective: "local" };
    return settings(state);
  };
  const { host } = mount(searchPipeline());
  await tick();
  await openChecks(host);
  /* The menu gave way to the choices, read for the stage the lane stands on. */
  expect(host.querySelector(".menu")).toBeNull();
  expect(checksCalls[0]).toEqual({ url: "/api/pipelines/p-search/checks?stageId=verify", method: "GET", body: null });
  expect(checksPopover()!.getAttribute("data-pipeline-checks-row")).toBe("ready");
  /* The title stands once and the answer only as the checked choice: no «Checks | Cloud» block under it. */
  expect(checksPopover()!.querySelector(".acct-now")).toBeNull();
  expect(checksPopover()!.textContent!.match(/Checks/g)).toHaveLength(1);
  expect([...checksPopover()!.querySelectorAll("[data-pipeline-checks-group] > .acct-lbl")].map((heading) => heading.textContent)).toEqual([expect.stringMatching(/^Stage .+/), "This pipeline", "Project default"]);
  expect(choices()).toEqual([
    ["stage:inherit", "Use pipeline choice (Local)", "false"], ["stage:cloud", "Cloud", "true"], ["stage:local", "Local", "false"],
    ["lane:inherit", "Use project default (Cloud)", "false"], ["lane:cloud", "Cloud", "false"], ["lane:local", "Local", "true"],
    ["project:cloud", "Cloud", "true"], ["project:local", "Local", "false"],
  ]);
  /* The answer moves focus to the stage's checked choice. */
  expect(document.activeElement?.getAttribute("data-pipeline-checks-choice")).toBe("stage:cloud");
  click(checksPopover()!.querySelector('[data-pipeline-checks-choice="stage:inherit"]'));
  await tick();
  await tick();
  expect(checksCalls[1]).toEqual({ url: "/api/pipelines/p-search/checks", method: "POST", body: { scope: "stage", execution: null, stageId: "verify" } });
  expect(checksPopover()!.querySelector('[data-pipeline-checks-choice="stage:inherit"]')?.getAttribute("aria-checked")).toBe("true");
  /* A checked choice sends nothing. */
  click(checksPopover()!.querySelector('[data-pipeline-checks-choice="stage:inherit"]'));
  await tick();
  expect(checksCalls).toHaveLength(2);
  key(document.activeElement, "Escape");
  await tick();
  expect(checksPopover()).toBeNull();
  same(document.activeElement, laneMenu(host));
});

test("a lane with no stage to publish offers only the lane and project choices", async () => {
  checksRoute = () => settings({ project: "local", override: null, effective: "local" });
  const { host } = mount(searchPipeline({ cursor: null } as Partial<Pipeline>));
  await tick();
  await openChecks(host);
  expect(checksCalls[0]?.url).toBe("/api/pipelines/p-search/checks");
  expect([...checksPopover()!.querySelectorAll("[data-pipeline-checks-group]")].map((group) => group.getAttribute("data-pipeline-checks-group"))).toEqual(["lane", "project"]);
  expect(checksPopover()!.querySelector('[data-pipeline-checks-choice="lane:inherit"]')?.textContent).toBe("Use project default (Local)");
});

test("a pending, refused or malformed read shows no choice, Retry reads again, and load and save failures read apart", async () => {
  let release: (response: Response) => void = () => {};
  checksRoute = () => new Promise<Response>((resolve) => { release = resolve; });
  const { host } = mount(searchPipeline());
  await tick();
  await openChecks(host);
  const line = checksPopover()!.querySelector("[data-pipeline-checks-state]")!;
  expect([checksPopover()!.getAttribute("data-pipeline-checks-row"), line.textContent, line.getAttribute("aria-busy")]).toEqual(["loading", "Loading…", "true"]);
  expect(checksPopover()!.textContent!.match(/Checks/g)).toHaveLength(1);
  expect(choices()).toEqual([]);
  release(new Response("{}", { status: 500 }));
  await tick();
  await tick();
  expect(checksPopover()!.getAttribute("data-pipeline-checks-row")).toBe("failed");
  expect(checksPopover()!.querySelector('[data-pipeline-checks-error="load"]')?.textContent).toBe("Could not load the check settings");
  expect(choices()).toEqual([]);
  /* Retry is the one control, so it takes focus, and reads again. */
  const retry = checksPopover()!.querySelector<HTMLElement>("[data-pipeline-checks-retry]")!;
  same(document.activeElement, retry);
  checksRoute = () => settings({ project: "cloud", override: null, stageOverride: null, effective: "cloud" });
  click(retry);
  await tick();
  await tick();
  expect(checksCalls).toHaveLength(2);
  expect(checksPopover()!.getAttribute("data-pipeline-checks-row")).toBe("ready");
  key(document.activeElement, "Escape");
  await tick();

  for (const body of [{ project: "cloud", effective: "cloud" }, { project: "toString", override: null, effective: "cloud" }]) {
    checksRoute = () => settings(body);
    await openChecks(host);
    expect(checksPopover()!.getAttribute("data-pipeline-checks-row")).toBe("failed");
    expect(choices()).toEqual([]);
    key(document.activeElement, "Escape");
    await tick();
  }

  checksRoute = (call) => (call.method === "POST" ? new Response("{}", { status: 409 }) : settings({ project: "cloud", override: null, stageOverride: null, effective: "cloud" }));
  await openChecks(host);
  click(checksPopover()!.querySelector('[data-pipeline-checks-choice="lane:local"]'));
  await tick();
  await tick();
  expect(checksPopover()!.querySelector('[data-pipeline-checks-error="save"]')?.textContent).toBe("Could not save the check choice");
  expect(checksPopover()!.querySelector('[data-pipeline-checks-error="load"]')).toBeNull();
  expect(checksPopover()!.querySelector('[data-pipeline-checks-choice="lane:inherit"]')?.getAttribute("aria-checked")).toBe("true");
});

/* ── A task card without inline conversations (docs/design/task-card-no-inline-conversations.md) ── */

test("«Graph» opens the stages view with its graph; a node selects its stage in place, opens no window, and «Open agent» still leaves for the conversation", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector("[data-graph-toggle]"));
  await tick();
  expect(sheet(host)?.querySelector("[data-sheet-graph]")?.getAttribute("aria-pressed")).toBe("true");
  expect(card(host).querySelector(".pnode, .pgraph")).toBeNull();
  const node = (stageId: string) => sheet(host)!.querySelector<HTMLElement>(`.gs-graph .pnode[data-stage="${stageId}"]`)!;
  /* A press selects the stage's tab and opens no window, so each node says that, never that it opens a conversation or a message. */
  expect(node("implement").getAttribute("aria-label")).toContain("Show its pane");
  expect(node("merge").getAttribute("aria-label")).toContain("Show its pane");
  for (const id of ["implement", "merge"]) {
    expect(node(id).getAttribute("aria-label")).not.toContain("Open its");
  }
  press(node("implement"));
  await tick();
  expect(host.querySelector("[data-agent-window]")).toBeNull();
  expect(sheet(host)).toBeTruthy();
  expect(node("implement").classList.contains("selected")).toBe(true);
  expect(node("implement").getAttribute("aria-label")).toContain("Its pane is in focus");
  expect(selectedTab(host)).toBe("implement");
  expect(readerIn(pane(host, "implement"))).toBe(idOf(implement2));

  /* A waiting node selects its stage, whose pane edits the first message itself. */
  press(node("merge"));
  await tick();
  expect(host.querySelector("[data-agent-window]")).toBeNull();
  expect(pane(host, "merge")!.querySelector("[data-draft-message] .btext")?.textContent).toBe("Merge once the alias swap is verified.");
  expect(pane(host, "merge")!.querySelector("[data-pane-away]")).toBeNull();
  expect(host.querySelector("[data-open-agents-pill]")).toBeNull();

  /* The pane's «Open agent» is the way to the conversation. */
  press(node("verify"));
  await tick();
  click(pane(host, "verify")!.querySelector("[data-open-conversation]"));
  await tick();
  expect(sheet(host)).toBeNull();
});

test("first messages follow the conversations in the window's list: ‹ › walk them all, a row's × closes one, Close all closes every one; Show in Stages leaves the window for that stage", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  click(card(host).querySelector('.pb-pills [data-stage="verify"]'));
  await inWindow(host, verify2);
  const rows = () => [...host.querySelectorAll<HTMLElement>("[data-agent-window] [data-open-agent]")].map((row) => row.getAttribute("data-open-agent"));
  const draftKey = rows().find((entry) => entry !== idOf(verify2))!;
  expect(rows()).toEqual([idOf(verify2), draftKey]);
  click(host.querySelector('[data-agent-window-step="next"]'));
  await tick();
  expect(draftPanel(host)).toBeTruthy();
  expect(host.querySelector("[data-agent-window]")?.getAttribute("data-agent-window")).toBe(draftKey);
  click(host.querySelector('[data-agent-window-step="next"]'));
  await inWindow(host, verify2);
  expect(draftPanel(host)).toBeNull();
  /* The draft's ×: the conversation stays on screen and the merge pill loses its ring. */
  click([...host.querySelectorAll("[data-open-agent-close]")].find((button) => button.getAttribute("data-open-agent-close") === draftKey));
  await tick();
  expect(rows()).toEqual([idOf(verify2)]);
  expect(card(host).querySelector('.pb-pills [data-stage="merge"]')?.classList.contains("selected")).toBe(false);
  /* Closing the conversation on screen brings the first message in at once. */
  click(card(host).querySelector('.pb-pills [data-stage="merge"]'));
  await tick();
  click(host.querySelector('[data-agent-window-step="previous"]'));
  await inWindow(host, verify2);
  click(host.querySelector(`[data-open-agent-close="${idOf(verify2)}"]`));
  await tick();
  expect(rows()).toEqual([draftKey]);
  expect(draftPanel(host)).toBeTruthy();
  /* Show in Stages: the window gives way to the stages view on that stage. */
  click(draftPanel(host)!.querySelector("[data-panel-menu]"));
  click(menuItem(host, "Show in Stages"));
  await tick();
  expect(host.querySelector("[data-agent-window]")).toBeNull();
  expect(sheet(host)).toBeTruthy();
  expect(selectedTab(host)).toBe("merge");
  expect(pane(host, "merge")!.querySelector("[data-draft-message]")).toBeTruthy();
  await tick();
  same(document.activeElement, pane(host, "merge"));
  key(sheet(host), "Escape");
  await tick();
  /* Close all takes the first messages too. */
  click(host.querySelector("[data-open-agents-pill]"));
  await tick();
  expect(draftPanel(host)).toBeTruthy();
  click(host.querySelector("[data-open-rail-close-all]"));
  await tick();
  expect(host.querySelector("[data-agent-window], [data-open-agents-pill]")).toBeNull();
  expect(card(host).querySelector('.pb-pills [data-stage="merge"]')?.classList.contains("selected")).toBe(false);
});

/* ── S2: the lane graphs the tabs draw ────────────────────────────────── */

/** A lane of invented stages on the card the suite mounts, with the runs the case needs. */
const shapeLane = (stages: unknown[], runs: Record<string, unknown[]>, state: string, cursor: string | null): Pipeline => searchPipeline({
  state,
  stages,
  runs: Object.entries(runs).map(([stageId, attempts]) => ({ stageId, attempts })),
  cursor: cursor ? { stageId: cursor, state: "running", input: null, activatedBy: null } : null,
} as unknown as Partial<Pipeline>);
const reviewFix = (state: string, runs: Record<string, unknown[]>, cursor: string | null) => shapeLane([
  stage("build", "builder", "review"),
  stage("review", "reviewer", null, { onFail: { to: "fix", maxRounds: 2 } }),
  stage("fix", "builder", "review"),
], runs, state, cursor);
const tabsOf = (host: HTMLElement) => [...sheet(host)!.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => `${tab.dataset.tabKind}:${tab.dataset.tabStage}`);

test("the waits-on line opens a one-line explanation in the head; Escape closes it first and the window second", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const view = sheet(host)!;
  const line = view.querySelector<HTMLElement>("header .gs-waits")!;
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(view.querySelector(".gs-waits-pop")).toBeNull();
  click(line);
  const pop = view.querySelector<HTMLElement>("header .gs-waits-pop");
  expect(pop?.textContent).toMatch(/^The stages are running\. The Verifier works on Verify .+; next — Merge\.$/);
  expect(line.getAttribute("aria-expanded")).toBe("true");
  /* The first Escape closes the explanation and hands the keyboard back to the line. */
  key(pop, "Escape");
  expect(view.querySelector(".gs-waits-pop")).toBeNull();
  expect(sheet(host)).toBeTruthy();
  same(document.activeElement, line);
  key(line, "Escape");
  await tick();
  expect(sheet(host)).toBeNull();
});

test("a fix reached only on a review's fail edge is a conditional tab: «if needed» while the lane can still reach it, «not needed» once it ended, with its rounds as dots and no rule line", async () => {
  const record = reviewFix("completed", { build: [attempt(1, "passed", implement1, 3000)], review: [attempt(1, "passed", review1, 600)] }, null);
  const { host } = mount(record);
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(tabsOf(host)).toEqual(["step:build", "step:review", "conditional:fix"]);
  const fix = tabOf(host, "fix")!;
  expect(fix.dataset.tabWord).toBe("notNeeded");
  expect(fix.getAttribute("aria-label")).toContain("not needed");
  expect(fix.getAttribute("aria-label")).toContain("only if Review fails");
  expect(fix.querySelector(".snum")).toBeNull();
  /* Two hollow dots: the budget, none of it spent. */
  expect(fix.querySelector(".sdots")?.getAttribute("data-dots")).toBe("left left");
  expect(sheet(host)!.querySelector(".gs-rule")).toBeNull();
  /* Its own pane says why it never ran, not «waiting». */
  expect(pick(host, "fix").querySelector(".pstate")?.textContent).toBe("not needed");
  /* Nothing passes into it, so its first message does not say it starts first: it starts when its source fails. */
  expect(pick(host, "fix").textContent).toContain(translate("en", "kanban.draft.startsOnFail", { stage: "Review" }));
  expect(pick(host, "fix").textContent).not.toContain(translate("en", "kanban.draft.startsFirst"));
});

test("while the lane can still reach it, a conditional fix reads «if needed», never «waiting»; once it ran, it reads its own state with one fired round", async () => {
  const waiting = reviewFix("running", { build: [attempt(1, "passed", implement1, 3000)], review: [attempt(1, "running", review1, 600)] }, "review");
  const first = mount(waiting, { files: [implement1, review1] });
  await tick();
  click(card(first.host).querySelector("[data-open-stages]"));
  await tick();
  expect(tabOf(first.host, "fix")!.dataset.tabWord).toBe("ifNeeded");
  expect(pick(first.host, "fix").querySelector(".pstate")?.textContent).toBe("if needed");
  first.host.remove();
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();

  const taken = reviewFix("running", {
    build: [attempt(1, "passed", implement1, 3000)],
    review: [attempt(1, "failed", review1, 1200)],
    fix: [attempt(1, "running", implement2, 600, { activatedBy: { stageId: "review", attempt: 1, edge: "fail" } })],
  }, "fix");
  const second = mount(taken, { files: [implement1, implement2, review1] });
  await tick();
  click(card(second.host).querySelector("[data-open-stages]"));
  await tick();
  const fix = tabOf(second.host, "fix")!;
  expect(fix.dataset.tabWord).toBeUndefined();
  expect(fix.querySelector(".sdots")?.getAttribute("data-dots")).toBe("bad next");
  expect(selectedTab(second.host)).toBe("fix");
});

test("a fix two reviewers share comes after the first of them in tab order, not before the stage that triggers it, and each edge is a rule line", async () => {
  const record = shapeLane([
    stage("brief", "architect", "build"),
    stage("fix", "builder", "review"),
    stage("build", "builder", "review"),
    stage("review", "reviewer", "visual", { onFail: { to: "fix", maxRounds: 2 } }),
    stage("visual", "visual-critic", null, { onFail: { to: "fix", maxRounds: 1, onExhausted: "park" } }),
  ], { brief: [attempt(1, "passed", implement1, 4000)], build: [attempt(1, "passed", implement2, 3000)], review: [attempt(1, "running", review1, 600)] }, "running", "review");
  const { host } = mount(record, { files: [implement1, implement2, review1] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(tabsOf(host)).toEqual(["step:brief", "step:build", "step:review", "conditional:fix", "step:visual"]);
  expect(tabOf(host, "fix")!.getAttribute("aria-label")).toContain("only if Review or Visual fails");
  expect([...sheet(host)!.querySelectorAll(".gs-rule")].map((rule) => rule.getAttribute("data-rule"))).toEqual(["review:fail:fix", "visual:fail:fix"]);
  /* Fix is a conditional stage after both sources, so the rules read forward, never «back to». */
  const words = [...sheet(host)!.querySelectorAll(".gs-rule")].map((rule) => rule.textContent ?? "");
  expect(words).toEqual([
    `↺ ${translate("en", "kanban.stages.ruleOn", { from: "Review", to: "Fix", fired: 0, max: 2 })}`,
    `↺ ${translate("en", "kanban.stages.ruleOn", { from: "Visual", to: "Fix", fired: 0, max: 1 })}`,
  ]);
  for (const line of words) expect(line).not.toContain("back to");
});

test("a stage whose spent budget handed it back for one more look labels that attempt «re-check» in its attempts row", async () => {
  const record = reviewFix("completed", {
    build: [attempt(1, "passed", implement1, 5000)],
    review: [
      attempt(1, "failed", review1, 3000),
      attempt(2, "passed", review1, 600, { activatedBy: { stageId: "fix", attempt: 1, edge: "pass", budgetRecheck: true } }),
    ],
    fix: [attempt(1, "passed", implement2, 1800, { activatedBy: { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true } })],
  }, null);
  const { host } = mount(record, { files: [implement1, implement2, review1] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const rows = [...pick(host, "review").querySelectorAll<HTMLElement>(".attempts [data-attempt]")].map((button) => button.textContent);
  expect(rows).toEqual([
    `${translate("en", "kanban.attemptWord", { n: 1 })} · failed`,
    `${translate("en", "kanban.attemptWord", { n: 2 })} · ${translate("en", "kanban.stages.recheck")} · passed`,
  ]);
  /* The returning fix's own attempt carries no re-check word. */
  expect(pick(host, "fix").textContent).not.toContain(translate("en", "kanban.stages.recheck"));
});

test("a skipped stage carries a mark of its own that a waiting one does not, and a detached stage reads «off the chain»", async () => {
  const record = shapeLane([
    stage("build", "builder", "review"),
    stage("review", "reviewer", "deliver"),
    stage("deliver", "cleaner", null),
    stage("extra", "builder", null),
  ], { build: [attempt(1, "passed", implement1, 3000)], review: [attempt(1, "passed", review1, 600)], deliver: [attempt(1, "skipped", null, 300)] }, "running", "deliver");
  const { host } = mount(record, { files: [implement1, review1] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(tabOf(host, "deliver")!.querySelector(".stab-skip")?.textContent).toBe("↷");
  expect(tabOf(host, "deliver")!.getAttribute("aria-label")).toContain("skipped");
  expect(tabOf(host, "extra")!.querySelector(".stab-skip")).toBeNull();
  expect(tabOf(host, "extra")!.dataset.tabKind).toBe("detached");
  expect(tabOf(host, "extra")!.dataset.tabWord).toBe("offChain");
  expect(tabOf(host, "extra")!.querySelector(".snum")).toBeNull();
});

test("the stage a lane stopped on shows what it stopped on in its pane, and its ⋯ keeps Retry and Skip under their refusals", async () => {
  const { host } = mount(parkedOnVerify());
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  expect(selectedTab(host)).toBe("verify");
  const stop = pane(host, "verify")!.querySelector<HTMLElement>("[data-pane-stop]");
  expect(stop).toBeTruthy();
  expect(stop!.textContent).toContain("the alias swaps before the new index answers");
  /* The head's line names the stop, not the stage chips' state. */
  expect(sheet(host)!.querySelector("header .gs-waits-words")?.textContent).toContain("Needs your answer");
  click(pane(host, "verify")!.querySelector("[data-pane-menu]"));
  expect(menuItem(host, "Retry this stage")?.getAttribute("aria-disabled")).toBeNull();
  expect(menuItem(host, "Skip this stage")?.getAttribute("aria-disabled")).toBeNull();
  key(host.querySelector(".menu"), "Escape");
  await tick();
  click(pick(host, "implement").querySelector("[data-pane-menu]"));
  expect(menuLabels(host)).toEqual([
    ["Retry this stage", true, "The pipeline waits on another stage"],
    ["Skip this stage", true, "The pipeline waits on another stage"],
  ]);
});

const sharedFixLane = (runs: Record<string, unknown[]>, state = "running", cursor: string | null = "review") => shapeLane([
  stage("brief", "architect", "build"),
  stage("fix", "builder", "review"),
  stage("build", "builder", "review"),
  stage("review", "reviewer", "visual", { onFail: { to: "fix", maxRounds: 2 } }),
  stage("visual", "visual-critic", null, { onFail: { to: "fix", maxRounds: 1, onExhausted: "park" } }),
  stage("rate", "builder", null),
], runs, state, cursor);

test("a fired edge keeps the rule line's grammar, and the failing tab wears the return mark with its count", async () => {
  const record = shapeLane([
    stage("build", "builder", "verify"),
    stage("verify", "verifier", null, { onFail: { to: "build", maxRounds: 2 } }),
  ], { build: [attempt(1, "passed", implement1, 3000), attempt(2, "running", implement2, 100, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })], verify: [attempt(1, "failed", review1, 600)] }, "running", "build");
  const { host } = mount(record, { files: [implement1, implement2, review1] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const lines = [...sheet(host)!.querySelectorAll(".gs-rule")].map((rule) => rule.textContent ?? "");
  expect(lines).toEqual(["↺ If Verify fails → back to Build · 1 of 2"]);
  for (const line of lines) expect(line).not.toMatch(/Fail edge|runs again|Used \d/);
  expect(tabOf(host, "verify")!.querySelector(".pret")?.textContent).toBe("↺1/2");
});

test("a tab that carries a fix's rounds says how many ran of how many, and a spent budget adds its line", async () => {
  const open = reviewFix("running", { build: [attempt(1, "passed", implement1, 5000)], review: [attempt(1, "failed", review1, 3000)], fix: [attempt(1, "running", implement2, 100, { activatedBy: { stageId: "review", attempt: 1, edge: "fail" } })] }, "fix");
  const first = mount(open, { files: [implement1, implement2, review1] });
  await tick();
  click(card(first.host).querySelector("[data-open-stages]"));
  await tick();
  expect(tabOf(first.host, "fix")!.querySelector("[data-dots-count]")?.textContent).toBe("1/2");
  expect(sheet(first.host)!.querySelectorAll(".gs-rule")).toHaveLength(0);
  const spent = reviewFix("completed", {
    build: [attempt(1, "passed", implement1, 5000)],
    review: [attempt(1, "failed", review1, 3000), attempt(2, "failed", review1, 1200)],
    fix: [attempt(1, "passed", implement2, 2500, { activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }), attempt(2, "passed", implement2, 900, { activatedBy: { stageId: "review", attempt: 2, edge: "fail", budgetSpent: true } })],
  }, null);
  const second = mount(spent, { files: [implement1, implement2, review1] });
  await tick();
  click(card(second.host).querySelector("[data-open-stages]"));
  await tick();
  expect([...sheet(second.host)!.querySelectorAll(".gs-rule")].map((rule) => rule.textContent)).toEqual([`↺ If Review fails → Fix · 2 of 2 · ${translate("en", "kanban.stages.ruleEnd.advance")}`]);
});

test("a pane says what starts its stage: every source of a shared fix, and that nothing starts a detached one", async () => {
  const record = sharedFixLane({ brief: [attempt(1, "passed", implement1, 4000)], build: [attempt(1, "passed", implement2, 3000)], review: [attempt(1, "running", review1, 600)] });
  const { host } = mount(record, { files: [implement1, implement2, review1] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  click(tabOf(host, "fix"));
  await tick();
  const sub = sheet(host)!.querySelector(".pane .draft-feed")?.textContent ?? "";
  expect(sub).toContain("Starts if Review or Visual fails");
  click(tabOf(host, "rate"));
  await tick();
  const rate = sheet(host)!.querySelector(".pane")!.textContent ?? "";
  expect(rate).toContain("No stage starts it");
  expect(rate).not.toMatch(/Starts first|last stage/);
});

test("a skipped stage's pane says it was skipped and draws no empty box in place of a conversation", async () => {
  const record = shapeLane([stage("build", "builder", "review"), stage("review", "reviewer", "deliver"), stage("deliver", "cleaner", null)],
    { build: [attempt(1, "passed", implement1, 3000)], review: [attempt(1, "passed", review1, 600)], deliver: [attempt(1, "skipped", null, 300, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] }, "completed", null);
  const { host } = mount(record, { files: [implement1, review1] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  click(tabOf(host, "deliver"));
  await tick();
  const view = pane(host, "deliver")!;
  expect(view.querySelector(".pane-sub")?.textContent).toBe(translate("en", "kanban.stages.skippedSub"));
  expect(view.textContent).not.toContain("started by");
  expect(view.querySelector(".pane-conv")).toBeNull();
});

test("a stage the lane stopped on after it passed says the stop's reason in its pane, and where to answer", async () => {
  const record = shapeLane([stage("fix", "builder", null)], { fix: [attempt(1, "passed", implement1, 600)] }, "needs_decision", "fix");
  record.stateDetail = "publishing the passed stage failed: the push was refused";
  const { host } = mount(record, { files: [implement1] });
  await tick();
  click(card(host).querySelector("[data-open-stages]"));
  await tick();
  const stop = pane(host, "fix")!.querySelector<HTMLElement>("[data-pane-stop]");
  expect(stop?.querySelector("[data-lane-stop]")?.textContent).toBe("the branch could not be published");
  expect(stop?.textContent).not.toContain("needs a decision");
  expect(stop?.querySelector("[data-answer-hint]")?.textContent).toBe(translate("en", "kanban.stages.answerHint"));
});
