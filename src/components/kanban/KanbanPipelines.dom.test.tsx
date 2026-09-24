import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { TaskMutationPorts } from "./useTaskMutations";

/* A card's pipeline on the kanban board (#1695 K5a), rendered by React: the
   stage graph by default on an active workspace card, the summary it toggles
   to, a node opening its stage's conversation, Past attempts, and an edge
   marked live when a new attempt arrives through it. Invented records; fetches
   answer from a stub; no route or state directory is touched. */

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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
/* happy-dom lays nothing out: every graph slot reports the width of a workspace card, so the
   graph takes the left-to-right layout it takes in a browser there. */
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
const { setLocale } = await import("@/lib/i18n");

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

const role = (roleId: string) => ({ roleId, engine: roleId === "reviewer" ? "codex" : "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) => ({ id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `Stage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over });
const attempt = (n: number, state: string, file: FileEntry | null, startedAgo: number, over: Record<string, unknown> = {}) => ({
  n, state, effectiveRole: role("builder"), launchId: null, conversationId: file?.conversationId ?? null, sessionId: null, agentPath: file?.path ?? null, paneId: null, flowId: null,
  startedAt: iso(startedAgo), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
});

const implement1 = conversation("implement-1");
const implement2 = conversation("implement-2");
const review1 = conversation("review-1");
const verify1 = conversation("verify-1");
const verify2 = conversation("verify-2");
const files = [implement1, implement2, review1, verify1, verify2];

function searchPipeline(): Pipeline {
  return {
    id: "p-search", task: "Restore search results", taskIds: ["t-search"], project: "fixture", state: "running",
    stages: [stage("implement", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }), stage("merge", "cleaner", null)],
    runs: [
      { stageId: "implement", attempts: [attempt(1, "passed", implement1, 7200), attempt(2, "passed", implement2, 4000, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
      { stageId: "review", attempts: [attempt(1, "passed", review1, 3600, { flowId: "flow-review" })] },
      { stageId: "verify", attempts: [attempt(1, "failed", verify1, 5000), attempt(2, "running", verify2, 1200)] },
    ],
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    worktreeDir: "/fixture/worktree", createdAt: iso(9000),
  } as unknown as Pipeline;
}

const flows = [{ id: "flow-review", rounds: [{ n: 1, verdict: "APPROVE", reviewerPath: null, reviewerConversationId: null, startedAt: iso(3500) }] }] as unknown as Flow[];

function task(id: string, status: TaskStatus, text: string): BoardTask {
  return { id, project: "fixture", text, status, placement: "unplaced", assignments: [], createdAt: iso(9000), updatedAt: iso(600), revision: REV(1) } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(pipelines: Pipeline[], status: TaskStatus = "assigned") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: Pipeline[]) => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={files}
      flows={flows}
      pipelines={next}
      tasks={[]}
      allTasks={[task("t-search", status, "Restore search results after the index rebuild")]}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
      mutationPorts={idlePorts}
    />,
  ));
  render(pipelines);
  return { host, render };
}

const card = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".card")].find((element) => element.getAttribute("data-id") === "task:t-search")!;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};

const toggle = (host: HTMLElement) => card(host).querySelector<HTMLElement>("[data-graph-toggle]");
const helperAttempt = (n: number, file: FileEntry, startedAgo: number) => attempt(n, "passed", file, startedAgo, { historical: true, activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });

test("every card starts on the compact summary, the active Assigned card included; the toggle opens the graph, pressed, and the choice outlives a re-render", async () => {
  const { host, render } = mount([searchPipeline()]);
  await tick();
  const section = () => card(host).querySelector(".pblock")!;
  expect(section().querySelector(".pb-graph")).toBeNull();
  expect(card(host).querySelector(".pnode")).toBeNull();
  expect(toggle(host)?.getAttribute("aria-pressed")).toBe("false");
  expect([...card(host).querySelectorAll(".pb-pills .pb-pill")].map((chip) => chip.getAttribute("data-stage"))).toEqual(["implement", "review", "verify", "merge"]);
  /* The fail edge rides the failing pill, never a chip of its own in the row (#1798, #2072). */
  expect(card(host).querySelector(".pb-pills .ploop")).toBeNull();
  expect(card(host).querySelector('.pb-pills [data-stage="verify"] [data-stage-return="verify:fail:implement"]')?.getAttribute("data-arc-fired")).toBe("1");
  click(toggle(host));
  await tick();
  expect(section().querySelector('.pb-graph[data-open="1"]')).toBeTruthy();
  expect(toggle(host)?.getAttribute("aria-pressed")).toBe("true");
  expect(card(host).querySelectorAll(".pnode")).toHaveLength(4);
  render([searchPipeline()]);
  await tick();
  expect(card(host).querySelectorAll(".pnode")).toHaveLength(4);
});

test("the opened graph shows each stage's state, the pass edges, the fail edge back with its spent budget, and review rounds", async () => {
  const { host } = mount([searchPipeline()]);
  await tick();
  click(toggle(host));
  await tick();
  const section = card(host).querySelector(".pblock")!;
  const nodes = [...section.querySelectorAll<HTMLElement>(".pnode")];
  expect(nodes.map((node) => node.dataset.stage)).toEqual(["implement", "review", "verify", "merge"]);
  expect(nodes.map((node) => node.querySelector(".pstate")?.textContent)).toEqual(["passed", "passed", "running", "waiting"]);
  expect(nodes[2]!.className).toContain("tone-active");
  /* A waiting stage opens its first message (K5b), so its node is a live control. */
  expect(nodes[3]!.getAttribute("aria-disabled")).toBeNull();
  expect(nodes[3]!.getAttribute("aria-label")).toContain("Open its first message");
  expect(nodes[0]!.querySelector(".pdetail")?.textContent).toBe("attempt 2");
  expect(nodes[2]!.querySelector(".pdetail")?.textContent).toBe("attempt 2 · 2 retries");
  expect(nodes[1]!.querySelector(".rounds-mark")?.getAttribute("data-rounds")).toBe("1");
  const edges = [...section.querySelectorAll<SVGPathElement>(".pedge")];
  expect(edges.map((edge) => edge.getAttribute("data-edge"))).toEqual(["implement:pass:review", "review:pass:verify", "verify:pass:merge", "verify:fail:implement"]);
  expect(edges[3]!.getAttribute("class")).toContain("fail back taken");
  /* Counts come from `activatedBy` and nothing else: this record carries the
     provenance of the one fail return only, so that is the one edge with a
     number on it. The branching source still names its pass side (#1743). */
  expect([...section.querySelectorAll<HTMLElement>(".pelabel")].map((label) => [label.dataset.edgeLabel, label.dataset.edgeFired]))
    .toEqual([["verify:pass:merge", "0"], ["verify:fail:implement", "1"]]);
  expect(section.querySelector('[data-edge-label="verify:fail:implement"] .ccircle')?.getAttribute("data-count")).toBe("1");
  expect(section.querySelector('[data-edge-label="verify:fail:implement"]')?.className).not.toContain("spent");
});

test("with a helper conversation adopted last on Implement, the graph keeps the engine's budget and attempt count, and the node a click opens is the one marked", async () => {
  const helper = conversation("implement-helper");
  files.push(helper);
  try {
    const record = searchPipeline();
    record.runs[0]!.attempts.push(helperAttempt(3, helper, 3000) as never);
    const { host } = mount([record]);
    await tick();
    /* The failing pill's suffix reads the same budget. */
    expect(card(host).querySelector('.pb-pills [data-stage-return="verify:fail:implement"]')?.getAttribute("data-arc-fired")).toBe("1");
    click(toggle(host));
    await tick();
    expect(card(host).querySelector<HTMLElement>('[data-edge-label="verify:fail:implement"]')?.dataset.edgeFired).toBe("1");
    expect(card(host).querySelector('.pnode[data-stage="implement"] .pdetail')?.textContent).toBe("attempt 2");
    click(card(host).querySelector('.pnode[data-stage="implement"]'));
    await tick();
    expect(card(host).querySelector("[data-kanban-reader]")?.getAttribute("data-kanban-reader")).toBe("conversation_implement-2");
    expect(card(host).querySelector('.pnode[data-stage="implement"]')?.getAttribute("aria-pressed")).toBe("true");
    /* The helper stays reachable, listed as what it is. */
    const helpers = [...card(host).querySelectorAll('details.history [data-past-kind="helper"] .lbl')].map((node) => node.textContent);
    expect(helpers).toEqual(["Implement · helper conversation 1"]);
    expect(card(host).querySelector("details.history .hsub")?.textContent).toBe("Helper conversations · 1");
  } finally {
    files.pop();
  }
});

test("Past attempts lists every finished attempt and settled round, the latest ones too, and leaves out the running attempt; a row opens its conversation", async () => {
  const { host } = mount([searchPipeline()], "blocked");
  await tick();
  const past = card(host).querySelector<HTMLDetailsElement>("details.history")!;
  const labels = [...past.querySelectorAll('[data-past-kind] .lbl')].map((node) => node.textContent);
  /* Named by stage id, which says more than the role here (#1765). */
  expect(labels.sort()).toEqual(["Implement · attempt 1", "Implement · attempt 2", "Review · attempt 1", "Review · round 1", "Verify · attempt 1"]);
  expect(past.querySelector(".hl")?.textContent).toBe("Past attempts · 5");
  expect(labels).not.toContain("Verify · attempt 2");
  const verify = [...past.querySelectorAll("li")].find((row) => row.querySelector(".lbl")?.textContent === "Verify · attempt 1")!;
  expect(verify.querySelector(".verdict")?.textContent).toBe("failed");
  click(verify.querySelector(".hopen"));
  await tick();
  expect(card(host).querySelector("[data-kanban-reader]")?.getAttribute("data-kanban-reader")).toBe("conversation_verify-1");
});

test("an edge is marked live only when the stage's own new attempt arrives through it, a helper adoption marks nothing, and the mark clears on time through later changes", async () => {
  const { host, render } = mount([searchPipeline()]);
  await tick();
  click(toggle(host));
  await tick();
  render([searchPipeline()]);
  await tick();
  expect(card(host).querySelector(".pedge.live")).toBeNull();

  /* A helper adopted with the fail edge's provenance copied onto it. */
  const adopted = searchPipeline();
  adopted.runs[0]!.attempts.push(helperAttempt(3, conversation("implement-helper"), 900) as never);
  render([adopted]);
  await tick();
  expect(card(host).querySelector(".pedge.live")).toBeNull();

  /* Implement's own third attempt, activated by Verify failing. */
  const retried = searchPipeline();
  retried.runs[0]!.attempts.push(helperAttempt(3, conversation("implement-helper"), 900) as never, attempt(4, "running", conversation("implement-4"), 10, { activatedBy: { stageId: "verify", attempt: 2, edge: "fail" } }) as never);
  render([retried]);
  await tick();
  expect(card(host).querySelector(".pedge.live")?.getAttribute("data-edge")).toBe("verify:fail:implement");
  /* The second return spends the budget, so the label reads as exhausted. */
  const liveLabel = card(host).querySelector<HTMLElement>(".pelabel.live")!;
  expect(liveLabel.dataset.edgeFired).toBe("2");
  expect(liveLabel.className).toContain("spent");

  /* Within the window the record changes again with nothing attributed. */
  await tick(400);
  const later = searchPipeline();
  later.runs[0]!.attempts.push(helperAttempt(3, conversation("implement-helper"), 900) as never, attempt(4, "running", conversation("implement-4"), 10, { activatedBy: { stageId: "verify", attempt: 2, edge: "fail" } }) as never);
  later.runs[1]!.attempts.push(attempt(2, "running", conversation("review-2"), 5) as never);
  render([later]);
  await tick();
  expect(card(host).querySelector(".pedge.live")).toBeTruthy();
  await tick(2_300);
  expect(card(host).querySelector(".pedge.live")).toBeNull();
});

test("a review stage with five rounds draws the latest round and a count of the earlier ones, and names every round in its label", async () => {
  const record = searchPipeline();
  const manyRounds = [{ id: "flow-review", rounds: ["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "APPROVE"].map((verdict, index) => ({ n: index + 1, verdict, reviewerPath: null, reviewerConversationId: null, startedAt: iso(3500 - index * 60) })) }] as unknown as Flow[];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <KanbanBoard project="fixture" groups={[]} manual={[]} files={files} flows={manyRounds} pipelines={[record]} tasks={[]}
      allTasks={[task("t-search", "assigned", "Restore search results after the index rebuild")]} drafts={[]} now={NOW} loaded catalogFailures={0}
      selection={new Set()} onOpenConversations={() => {}} seatRefs={null} mutationPorts={idlePorts} />,
  ));
  await tick();
  click(toggle(host));
  await tick();
  const review = card(host).querySelector<HTMLElement>('.pnode[data-stage="review"]')!;
  /* One circled number for the rounds, in the same vocabulary as the arrows,
     and the hover still names every round (#1743). */
  expect(review.querySelector(".rounds-mark")?.getAttribute("data-rounds")).toBe("5");
  expect(review.querySelector(".rounds-mark .ccircle")?.getAttribute("data-count")).toBe("5");
  expect(review.querySelector(".rounds-mark")?.getAttribute("title")?.split("\n")).toHaveLength(5);
  expect(review.getAttribute("aria-label")).toContain("Round 1: changes requested, Round 2: changes requested, Round 3: changes requested, Round 4: changes requested, Round 5: approved");
});

test("a summary chip is a control only when the stage's latest own attempt has a conversation to open: not while that attempt is still spawning", async () => {
  const record = searchPipeline();
  record.runs[2]!.attempts.push(attempt(3, "spawning", null, 1, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } }) as never);
  const { host } = mount([record]);
  await tick();
  const chip = (stage: string) => card(host).querySelector<HTMLElement>(`.pb-pills [data-stage="${stage}"]`)!;
  expect(chip("verify").tagName).toBe("SPAN");
  expect(chip("implement").tagName).toBe("BUTTON");
});

test("a pipeline whose graph was edited shows the latest edit, signed by the conversation that made it (graph slice 1)", async () => {
  const edited = {
    ...searchPipeline(),
    graphEdits: [
      { seq: 1, at: iso(900), actor: { kind: "operator" }, action: "set-edge", stageId: "review", pipelineState: "running", effect: "applied", appliesFromAttempt: null, summary: "set the pass edge of review to verify" },
      { seq: 2, at: iso(300), actor: { kind: "agent", role: "orchestrator", conversationId: "conversation_orchestrator" }, action: "override-stage", stageId: "verify", pipelineState: "running", effect: "pending-next-attempt", appliesFromAttempt: 3, summary: "changed prompt of stage verify; applies from attempt 3" },
    ],
  } as unknown as Pipeline;
  const { host, render } = mount([searchPipeline()]);
  await tick();
  expect(card(host).querySelector(".graph-edit")).toBeNull();
  render([edited]);
  await tick();
  const line = card(host).querySelector<HTMLElement>(".graph-edit")!;
  expect(line.dataset.graphEdit).toBe("2");
  expect(line.dataset.graphEditActor).toBe("agent");
  /* The role signs the line; the raw conversation id is gone (#1765). */
  expect(line.textContent).toContain("Orchestrator");
  expect(line.textContent).not.toContain("conversation_orchestrator");
  expect(line.textContent).toContain("changed verify · applies from attempt 3");
  expect(line.getAttribute("title")).toBe("changed prompt of stage verify; applies from attempt 3");
});

test("a stage that reported its own completion shows it on the card, findings most severe first (graph slice 2)", async () => {
  const base = searchPipeline();
  const verdict = {
    status: "fail",
    findings: ["P0 — the fence is missing", "P1 — the retry loop never ends", "P2 — a nit", "P3 — spelling"],
    rankedFindings: [
      { severity: "P0", text: "the fence is missing" },
      { severity: "P1", text: "the retry loop never ends" },
      { severity: "P2", text: "a nit" },
      { severity: "P3", text: "spelling" },
    ],
  };
  base.runs[2]!.attempts[1]!.verdict = verdict as never;
  const reported = {
    ...base,
    stageReports: [
      { seq: 1, at: iso(900), actor: { kind: "agent", role: "builder", conversationId: "conversation_implement" }, stageId: "implement", attempt: 2, status: "pass", findings: 0, replaces: null, summary: "Built it." },
      { seq: 2, at: iso(300), actor: { kind: "agent", role: "verifier", conversationId: "conversation_verify" }, stageId: "verify", attempt: 2, status: "fail", findings: 4, replaces: null, summary: "Four findings left." },
    ],
  } as unknown as Pipeline;
  const { host, render } = mount([searchPipeline()]);
  await tick();
  expect(card(host).querySelector(".stage-report")).toBeNull();
  render([reported]);
  await tick();

  const line = card(host).querySelector<HTMLElement>(".stage-report")!;
  expect(line.dataset.stageReport).toBe("2");
  expect(line.dataset.stageReportActor).toBe("agent");
  expect(line.dataset.stageReportStatus).toBe("fail");
  /* Role, outcome and age — no raw conversation id on the card (#1765). */
  expect(line.textContent).toContain("Verifier failed");
  expect(line.textContent).not.toContain("conversation_verify");
  expect(line.getAttribute("title")).toBe("Four findings left.");

  const findings = card(host).querySelector<HTMLElement>(".stage-findings")!;
  expect(findings.dataset.stageFindings).toBe("4");
  expect([...findings.querySelectorAll("li[data-severity]")].map((item) => [
    item.getAttribute("data-severity"),
    item.querySelector(".text")?.textContent,
  ])).toEqual([
    ["P0", "the fence is missing"],
    ["P1", "the retry loop never ends"],
    ["P2", "a nit"],
  ]);
  expect(findings.querySelector(".more")?.textContent).toContain("1 more finding");
});

/* ── Naming the pipelines of one task (#1765) ──────────────────────────── */

/** One pipeline of the shared task, named by what it was created to do. */
function namedPipeline(id: string, task: string, state: string, endedAgo: number | null): Pipeline {
  return {
    id, task, taskIds: ["t-search"], project: "fixture", state,
    stages: [stage("critique", "reviewer", "fix"), stage("fix", "builder", null)],
    runs: [
      { stageId: "critique", attempts: [attempt(1, "passed", review1, 6000)] },
      { stageId: "fix", attempts: [attempt(1, state === "running" ? "running" : "passed", implement1, 5000)] },
    ],
    cursor: { stageId: "fix", state: "running", input: null, activatedBy: null },
    worktreeDir: `/fixture/${id}`, createdAt: iso(9000),
    closedAt: endedAgo === null ? null : iso(endedAgo),
  } as unknown as Pipeline;
}

/** Two running pipelines and three completed ones, all on the same task. */
const manyPipelines = (): Pipeline[] => [
  namedPipeline("p-live-1", "Rework the stage pills so a row says what it does\nSecond line nobody reads on the card.", "running", null),
  namedPipeline("p-live-2", "Remove the legacy drawers under the columns", "running", null),
  namedPipeline("p-done-1", "Name the completed pipelines of a task", "completed", 1_200),
  namedPipeline("p-done-2", "Drop the raw conversation id from the report line", "completed", 600),
  namedPipeline("p-done-3", "Fold the finished rows behind their count", "completed", 3_600),
];

test("every pipeline row leads with its own title, truncated to the first line, with the whole task on hover (#1765)", async () => {
  const { host } = mount(manyPipelines());
  await tick();
  const titles = [...card(host).querySelectorAll<HTMLElement>(".pblock .pb-title")];
  expect(titles.map((node) => node.textContent)).toEqual([
    "Rework the stage pills so a row says what it does",
    "Remove the legacy drawers under the columns",
  ]);
  /* The generic «Pipeline» chip is gone, and the full task is the hover text. */
  expect(card(host).querySelector(".pblock .kind")).toBeNull();
  expect(titles[0]!.closest(".pb-open")!.getAttribute("title")).toContain("Second line nobody reads on the card.");
  /* Stage pills read by stage id, which says more than the role here. */
  expect([...card(host).querySelectorAll(".pblock .pb-pills .pb-name")].map((pill) => pill.textContent))
    .toEqual(["Critique", "Fix", "Critique", "Fix"]);
});

test("past three rows a task folds its completed pipelines behind one count, newest first, running ones on top (#1765)", async () => {
  const { host } = mount(manyPipelines());
  await tick();
  const rows = () => [...card(host).querySelectorAll<HTMLElement>(".pblock")].map((row) => row.dataset.pipeline);
  expect(rows()).toEqual(["p-live-1", "p-live-2"]);
  const disclosure = card(host).querySelector<HTMLElement>("[data-completed-toggle]")!;
  expect(disclosure.textContent).toBe("3 completed");
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");

  click(disclosure);
  await tick();
  /* Newest first: the pipeline that ended last leads the folded rows. */
  expect(rows()).toEqual(["p-live-1", "p-live-2", "p-done-2", "p-done-1", "p-done-3"]);
  expect(card(host).querySelector("[data-completed-toggle]")?.getAttribute("aria-expanded")).toBe("true");
});

test("three rows or fewer stay unfolded, whatever their state (#1765)", async () => {
  const { host } = mount(manyPipelines().slice(0, 3));
  await tick();
  expect([...card(host).querySelectorAll<HTMLElement>(".pblock")].map((row) => row.dataset.pipeline))
    .toEqual(["p-live-1", "p-live-2", "p-done-1"]);
  expect(card(host).querySelector("[data-completed-toggle]")).toBeNull();
});

/* #1798, #2072 variant B: a fail edge is never a chip among the stages. Once it
   has fired, the failing stage's own pill carries it as a suffix; at rest the
   row says nothing and the sentence stays in that pill's tooltip. The same
   three-stage lane, with its fail edge in each of the states the suffix has to
   tell apart. A round is counted from the target's activations, so a round is
   one further Fix attempt naming the source attempt that sent the work back. */
function arcPipeline(over: { max: number; fired: number; running?: boolean; fromCritique?: boolean; parked?: boolean }): Pipeline {
  const attempts: unknown[] = [attempt(1, "passed", implement1, 7200)];
  for (let round = 1; round <= over.fired; round += 1) {
    const last = round === over.fired;
    attempts.push(attempt(1 + round, last && over.running ? "running" : "passed", implement2, 4000 - round * 100, {
      activatedBy: { stageId: over.fromCritique && round === 1 ? "critique" : "review", attempt: round, edge: "fail" },
    }));
  }
  return {
    id: "p-search", task: "Fail edges as suffixes", taskIds: ["t-search"], project: "fixture", state: "running",
    stages: [
      stage("fix", "builder", "critique"),
      stage("critique", "verifier", "review", over.fromCritique ? { onFail: { to: "fix", maxRounds: over.max } } : {}),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: over.max } }),
    ],
    runs: [{ stageId: "fix", attempts }],
    /* A lane the engine parked on a spent edge stands on the FAILING stage and
       waits for a decision; one that is still running stands on the target. */
    ...(over.parked ? { state: "needs_decision" } : {}),
    cursor: over.parked
      ? { stageId: "review", state: "running", input: null, activatedBy: null }
      : { stageId: "fix", state: over.running ? "running" : "passed", input: null, activatedBy: null },
    worktreeDir: "/fixture/worktree", createdAt: iso(9000),
  } as unknown as Pipeline;
}

const pill = (host: HTMLElement, stageId: string) => card(host).querySelector<HTMLElement>(`.pb-pills .pb-pill[data-stage="${stageId}"]`);

test("a fail edge takes no slot in the lane row: silent at rest, and a suffix on the failing pill once it fires (#1798, #2072)", async () => {
  /* At rest the row is the stages and nothing else, and the budget is in the
     failing pill's tooltip. */
  const rest = mount([arcPipeline({ max: 3, fired: 0 })]);
  await tick();
  expect([...card(rest.host).querySelectorAll<HTMLElement>(".pb-pills .pb-pill")].map((chip) => chip.dataset.stage)).toEqual(["fix", "critique", "review"]);
  expect(card(rest.host).querySelector(".pb-pills .ploop")).toBeNull();
  expect(card(rest.host).querySelector(".pb-pills .pret")).toBeNull();
  expect(card(rest.host).querySelector("[data-loop-arc], .parcs")).toBeNull();
  expect(pill(rest.host, "review")?.title).toContain("up to 3 rounds");

  /* One round of three spent, and the returned stage running because of it. */
  const fired = mount([arcPipeline({ max: 3, fired: 1, running: true })]);
  await tick();
  const once = pill(fired.host, "review")!.querySelector<HTMLElement>(".pret")!;
  expect(once.dataset.stageReturn).toBe("review:fail:fix");
  expect(once.dataset.arcState).toBe("fired");
  expect(once.dataset.arcLive).toBe("1");
  expect(once.textContent).toBe("↺1/3");
  expect(pill(fired.host, "review")?.title).toContain("Fired 1 of 3 times");
  /* A return that is over is not marked as one still running. */
  const over = mount([arcPipeline({ max: 3, fired: 1 })]);
  await tick();
  expect(pill(over.host, "review")?.querySelector<HTMLElement>(".pret")?.dataset.arcLive).toBe("0");

  /* The budget spent: the suffix says so, and its sentence says what that costs. */
  const spent = mount([arcPipeline({ max: 2, fired: 2 })]);
  await tick();
  const gone = pill(spent.host, "review")!.querySelector<HTMLElement>(".pret")!;
  expect(gone.dataset.arcState).toBe("exhausted");
  expect(gone.textContent).toBe("↺2/2");
  expect(gone.title).toContain("No rounds left");
  /* Spent but still alive: the sentence is about what a FURTHER failure costs. */
  expect(gone.title).toContain("another failure");

  /* The same budget after the lane stopped on it: the sentence says what
     happened, first. */
  const parked = mount([arcPipeline({ max: 2, fired: 2, parked: true })]);
  await tick();
  const stopped = pill(parked.host, "review")!.querySelector<HTMLElement>(".pret")!;
  expect(stopped.dataset.arcState).toBe("exhausted");
  expect(stopped.title).toMatch(/^No rounds left/);
  expect(stopped.title).toContain("parked here");
  expect(stopped.title).not.toContain("another failure");

  /* Two edges into one target are two suffixes, each on its own failing pill. */
  const both = mount([arcPipeline({ max: 3, fired: 2, fromCritique: true })]);
  await tick();
  expect([...card(both.host).querySelectorAll<HTMLElement>(".pb-pills .pret")].map((node) => [node.dataset.stageReturn, node.dataset.arcFired]))
    .toEqual([["critique:fail:fix", "1"], ["review:fail:fix", "1"]]);
  expect(card(both.host).querySelectorAll(".pb-pills .pb-pill")).toHaveLength(3);
});

/* A lane row's head states its state once, as a word in its tone (#2072,
   variant B): "stages running" is left to the live pill, and no stage name is
   said beside the word — the chain below already names where the work is. On
   f5626046 the rows the operator read said it twice: «етапи виконуються» then
   «Green виконується», «потребує рішення» then «Banter trigger round2 чекає на
   вас», «чернетка» then «чернетка». */
function headPipeline(state: string, stageId: string, attemptState: string | null, over: Record<string, unknown> = {}): Pipeline {
  return {
    id: "p-search", task: "Keep the header to one statement of state", taskIds: ["t-search"], project: "fixture", state,
    stages: [stage(stageId, "builder", "review"), stage("review", "reviewer", null, { onFail: { to: stageId, maxRounds: 2 } })],
    runs: attemptState ? [{ stageId, attempts: [attempt(1, attemptState, implement1, 1200)] }] : [],
    cursor: attemptState ? { stageId, state: attemptState === "needs_decision" ? "running" : attemptState, input: null, activatedBy: null } : null,
    worktreeDir: "/fixture/worktree", createdAt: iso(9000), ...over,
  } as unknown as Pipeline;
}

const head = (host: HTMLElement) => {
  const row = card(host).querySelector<HTMLElement>(".pblock .pb-head")!;
  return {
    word: row.querySelector(".pstate-word")?.textContent ?? null,
    text: row.querySelector(".pb-open")?.textContent ?? "",
    title: row.querySelector(".pb-title")?.textContent ?? null,
  };
};

const HEAD_CASES: Array<{ name: string; pipeline: () => Pipeline; en: string | null; uk: string | null; stage: string }> = [
  { name: "running", pipeline: () => headPipeline("running", "green", "running"), en: null, uk: null, stage: "Green" },
  { name: "needs_decision", pipeline: () => headPipeline("needs_decision", "banter-trigger-round2", "needs_decision"), en: "needs a decision", uk: "потребує рішення", stage: "Banter trigger round2" },
  { name: "draft", pipeline: () => headPipeline("draft", "build", null), en: "draft", uk: "чернетка", stage: "Build" },
  { name: "paused", pipeline: () => headPipeline("paused", "green", "running", { pausedState: "running" }), en: "paused", uk: "пауза", stage: "Green" },
  { name: "completed", pipeline: () => headPipeline("completed", "build", "passed", { cursor: null, closedAt: iso(300) }), en: "completed", uk: "завершено", stage: "Build" },
  { name: "closed", pipeline: () => headPipeline("closed", "build", "failed", { cursor: null, closedAt: iso(300), restored: true }), en: "closed", uk: "закрито", stage: "Build" },
  { name: "failed-stage", pipeline: () => headPipeline("paused", "build", "failed", { cursor: null, pausedState: null }), en: "paused", uk: "пауза", stage: "Build" },
  /* A stage parked on the operator under a paused pipeline, and a stage on its second attempt. */
  { name: "paused-decision", pipeline: () => headPipeline("paused", "build", "needs_decision", { pausedState: "running" }), en: "paused", uk: "пауза", stage: "Build" },
  { name: "second-attempt", pipeline: () => ({ ...headPipeline("running", "green", "running"), runs: [{ stageId: "green", attempts: [attempt(1, "failed", implement1, 2400), attempt(2, "running", implement1, 1200)] }] }) as unknown as Pipeline, en: null, uk: null, stage: "Green" },
];

for (const locale of ["en", "uk"] as const) {
  for (const entry of HEAD_CASES) {
    test(`a ${entry.name} pipeline's head states its state once, in ${locale}`, async () => {
      setLocale(locale);
      try {
        const { host } = mount([entry.pipeline()]);
        await tick();
        const word = entry[locale];
        const read = head(host);
        expect(read.word).toBe(word);
        if (word) expect(read.text.split(word)).toHaveLength(2);
        /* The stage the work stands on is the chain's to name, not the head's. */
        expect(read.text).not.toContain(entry.stage);
        expect(read.title).toBe("Keep the header to one statement of state");
      } finally {
        setLocale("en");
      }
    });
  }
}

/* #2072 variant B: the card is the only frame. What the activity line said
   moved: "needs you" to the card's edge and the lane's own state word, the
   working and conversation counts to the footer. */
test("the card draws no activity line: the footer counts the conversations, and a lane that waits on the operator colours the card's edge", async () => {
  const running = mount([searchPipeline()]);
  await tick();
  expect(card(running.host).querySelector(".activity")).toBeNull();
  expect(card(running.host).dataset.attention).toBeUndefined();
  expect(card(running.host).querySelector(".foot [data-foot-conversations]")?.textContent).toBe("5 conversations");
  /* The lane row is frameless: a hairline above it, and no box of its own. */
  expect(card(running.host).querySelector(".pblock")?.getAttribute("data-density")).toBe("task");

  const parked = mount([{ ...searchPipeline(), state: "needs_decision" } as Pipeline]);
  await tick();
  expect(card(parked.host).dataset.attention).toBe("needs");
  expect(card(parked.host).querySelector(".pb-head .pstate-word")?.textContent).toBe("needs a decision");
  /* The footer names why and on which stage, beside its Dismiss
     (docs/design/needs-attention.md §4). */
  expect(card(parked.host).querySelector("[data-foot-needs]")?.textContent).toMatch(/^needs a decision · /);
  expect(card(parked.host).querySelector("[data-dismiss]")).not.toBeNull();
});
