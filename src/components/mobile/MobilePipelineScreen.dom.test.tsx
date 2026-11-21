import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * One pipeline on the phone, the Stages window (redesign S2, variant 3;
 * #2072 slice 6, docs/design/phone-kanban.md §3.13 before it). What this
 * guards is the shape behind the rendered frames:
 *
 *   - the BAR names the lane whole, and the body opens on the line that says
 *     whom the lane waits on, the stages as a grid of tabs, the fail edges the
 *     tabs do not carry as rule lines, and one pane under them;
 *   - the pane holds the selected stage's conversation, the answer to a stop
 *     and «Open agent»; a stage that has not started holds its first message,
 *     and the pane's ⋯ opens the stage's sheet (its configuration, Retry,
 *     Skip);
 *   - the bar's ⋯ carries the lane's own actions, Show on board, Attach, the
 *     linked tasks and «Past attempts · n» (each its own face), and leads on
 *     to the board's menu.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const runtime = {
  enabled: false,
  connection: "live" as ConnectionState,
  lastEventAt: null as number | null,
  resyncedAt: null,
  store: emptyStore(),
  structuredHostsEnabled: false,
};
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => runtime,
  useRuntime: () => runtime,
  useRuntimeSelector: (selector: (state: typeof runtime) => unknown) => selector(runtime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobilePipelineScreen, mobilePipelineActions } = await import("./MobilePipelineScreen");
const { createMobileNav, MobileNavContext } = await import("./mobileNav");
const { fakeHistory } = await import("./mobileNavTestHistory");
const { receipts } = await import("./MobileReceipt");
const { setLocale } = await import("@/lib/i18n");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = {};
    if (String(input).startsWith("/api/logs")) {
      const { reqs } = JSON.parse(String(init?.body ?? "{}")) as { reqs: Array<{ id: string }> };
      body = { chunks: Object.fromEntries(reqs.map((req) => [req.id, { data: "", start: 0, offset: 0, size: 0 }])) };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  },
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; receipts.dismiss(); });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); setLocale("en"); });

function nav() {
  return createMobileNav(fakeHistory("http://localhost/#p=atlas").host);
}

function mount(node: React.ReactNode, store = nav()): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<MobileNavContext.Provider value={store}>{node}</MobileNavContext.Provider>));
  roots.push(root);
  return host as unknown as HTMLElement;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
};

const NOW = 1_800_000_000;
const at = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();

const file = (path: string, title: string): FileEntry => ({
  root: "claude-projects", name: path.split("/").pop(), path, project: "atlas", title, engine: "claude", kind: "session",
  fmt: "claude", parent: null, mtime: NOW - 60, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
  pendingQuestion: null, waitingInput: null, conversationId: null,
} as unknown as FileEntry);

const IMPLEMENT = file("/repo/implement.jsonl", "Implement fast switching");
const REVIEW = file("/repo/review.jsonl", "Review round 3");

/* Every stage carries the role the engine resolved for it, as a real pipeline
   does: the stage sheet renders the desktop's own editor, which reads it. */
const role = (roleId: string, access: "read-only" | "read-write" = "read-write") =>
  ({ roleId, engine: "claude", model: "opus", effort: "high", access, promptScaffold: null });
const STAGES = [
  { id: "design", kind: "run", role: { roleId: "architect" }, prompt: "p", next: "implement", effectiveRole: role("architect", "read-only") },
  { id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "p", next: "review", effectiveRole: role("builder") },
  { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "p", next: "fix", onFail: { to: "implement", maxRounds: 3 }, effectiveRole: role("reviewer", "read-only") },
  { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "p", next: "merge", effectiveRole: role("builder") },
  { id: "merge", kind: "run", role: { roleId: "builder" }, prompt: "p", next: null, effectiveRole: role("builder") },
];

const attempt = (over: Record<string, unknown>) => ({
  n: 1, state: "passed", launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
  startedAt: at(4_000), completedAt: at(3_600), input: null, activatedBy: null, output: null, verdict: { status: "pass" }, error: null,
  ...over,
});

function parkedPipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p2", task: "Fast conversation switching", taskIds: [], project: "atlas", repoDir: "/repo", worktreeDir: "/repo-w",
    branch: "lane/p2", baseBranch: "main", baseRef: "main", lastPassedCommit: "", stages: STAGES,
    runs: [
      { stageId: "design", attempts: [attempt({})] },
      { stageId: "implement", attempts: [attempt({ agentPath: IMPLEMENT.path })] },
      {
        stageId: "review",
        attempts: [attempt({
          n: 3, state: "failed", agentPath: REVIEW.path,
          verdict: { status: "fail", findings: ["Switching projects remounts the board, so the feed cache is dropped every time.", "The measured switch is 640 ms at 12 trees; the bar is 200 ms."] },
        })],
      },
    ],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: at(7_200), closedAt: null,
    ...over,
  } as unknown as Pipeline;
}

/* The same lane, running its Implement stage: Design passed, and the agent's
   plan names what it is doing now. */
const BUILDING = { ...IMPLEMENT, plan: { steps: [], done: 0, total: 0, current: "Checking the fallback path next", updatedAt: null } } as unknown as FileEntry;
function runningPipeline(): Pipeline {
  return parkedPipeline({
    state: "running",
    runs: [
      { stageId: "design", attempts: [attempt({})] },
      { stageId: "implement", attempts: [attempt({ state: "running", agentPath: BUILDING.path, completedAt: null, verdict: null, startedAt: at(360) })] },
    ],
    cursor: { stageId: "implement", state: "running", input: null, activatedBy: null },
  } as unknown as Partial<Pipeline>);
}

const tab = (host: HTMLElement, stageId: string) => q(host, `[role="tab"][data-tab-stage="${stageId}"]`);
const tabIds = (host: HTMLElement) => qa(host, '[role="tab"]').map((el) => el.getAttribute("data-tab-stage"));
const selectedTab = (host: HTMLElement) => q(host, '[role="tab"][aria-selected="true"]')?.getAttribute("data-tab-stage") ?? null;
const paneOf = (host: HTMLElement, stageId: string) => q(host, `.pane[data-stage="${stageId}"]`);
const opened = async (host: HTMLElement) => { click(q(host, '[data-mobile2-open="menu"]')); await settle(); };

test("the bar names the lane whole; the body opens on whom the lane waits on, the tab grid and one pane", () => {
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(host, '[data-mobile2-screen="pipeline"]')).not.toBeNull();
  expect(q(host, '[data-mobile2-pipeline="p2"]')).not.toBeNull();
  expect(q(host, "[data-mobile2-back]")).not.toBeNull();
  /* The title is the bar's, once, and the body carries no second heading. */
  expect(q(host, "[data-mobile2-title-text]")!.textContent).toBe("Fast conversation switching");
  const body = q(host, "[data-mobile2-pipeline-body]")!;
  expect(body.textContent!.split("Fast conversation switching").length).toBe(1);
  expect(q(body, "[data-pipeline-heading], [data-stages-count]")).toBeNull();
  /* No template or worktree line under the bar (README §4.7, critique P3-3). */
  expect(body.textContent).not.toContain("lane/p2");
  expect(body.textContent).not.toContain("/repo-w");
  /* The first line says the stop, as the card's state line does, with the dot in the owner's tone. */
  const waits = q(body, ".gs-waits")!;
  expect(waits.getAttribute("data-waits-on")).toBe("you");
  expect(q(waits, ".gs-waits-words")!.textContent).toBe(translate("en", "cardState.you.lane", { why: translate("en", "cardState.why.other", { stage: "review" }) }));
  /* Five stages, in the order the lane runs them, the stopped one selected; one panel, one pane. */
  expect(tabIds(host)).toEqual(["design", "implement", "review", "fix", "merge"]);
  expect(selectedTab(host)).toBe("review");
  expect(qa(host, '[role="tabpanel"]')).toHaveLength(1);
  expect(qa(host, ".pane")).toHaveLength(1);
  expect(paneOf(host, "review")).not.toBeNull();
  /* The fail edge is one rule line under the tabs. */
  expect(qa(host, ".gs-rule").map((rule) => rule.textContent)).toEqual([`↺ ${translate("en", "kanban.stages.ruleRest", { from: "Review", to: "Implement", fired: 0, max: 3 })}`]);
});

test("a tab selects its stage's pane in place; a stage that ran shows its conversation and a stage that has not started holds its first message", () => {
  const opened: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={(entry) => opened.push(entry.path)} />);
  click(tab(host, "implement"));
  expect(selectedTab(host)).toBe("implement");
  expect(paneOf(host, "review")).toBeNull();
  expect(q(paneOf(host, "implement")!, ".pname")!.textContent).toBe("2. Implement");
  click(q(paneOf(host, "implement")!, "[data-open-conversation]"));
  expect(opened).toEqual([IMPLEMENT.path]);
  /* A stage with no transcript left in the scan is a statement, not a dead button. */
  click(tab(host, "design"));
  expect(q(paneOf(host, "design")!, "[data-open-conversation]")).toBeNull();
  /* A stage that has not started holds its first message. */
  click(tab(host, "fix"));
  expect(q(paneOf(host, "fix")!, "[data-draft-message]")).not.toBeNull();
  expect(q(paneOf(host, "fix")!, ".pstate")!.textContent).toBe(translate("en", "kanban.graphState.pending"));
});

test("the stage the lane stopped on says what it stopped on inside its pane; Skip and Retry are rows of the ⋯ sheet", async () => {
  const answered: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={(entry) => answered.push(entry.path)} />);
  const stop = q(paneOf(host, "review")!, "[data-pane-stop]")!;
  /* The report lives in the stage; no answer is on the screen's face (docs/design/calm-task-cards-build.md §4.2). */
  expect(qa(host, "[data-answer-action]")).toEqual([]);
  expect(qa(stop, ".stage-findings li")[0]!.textContent).toContain("the feed cache is dropped");
  expect(qa(stop, ".stage-findings li")[1]!.textContent).toBe(translate("en", "kanban.stageReport.moreFindings", { count: 1 }));
  expect(q(stop, ".stage-report")!.textContent).toBe(translate("en", "pipelineBlock.reason.failed", { stage: "Review" }) + ` · ${translate("en", "pipelineVerdict.findings", { count: 2 })}`);
  await opened(host);
  expect(Array.from(dom.document.querySelectorAll("[data-mobile2-pipeline-menu] [data-phone-lane-answer]")).map((el) => [el.getAttribute("data-phone-lane-answer"), el.textContent])).toEqual([
    ["skip-stage", translate("en", "kanban.pipelineAct.label.skip-stage", { stage: "Review" })],
    ["retry-stage", translate("en", "kanban.pipelineAct.label.retry-stage", { stage: "Review" })],
  ]);
  /* Each is a 44 px sheet row. */
  expect(Array.from(dom.document.querySelectorAll("[data-phone-lane-answer]")).every((el) => (el as unknown as HTMLElement).className.includes("min-h-11"))).toBe(true);
  /* Its conversation is one control under the report. */
  click(q(paneOf(host, "review")!, "[data-open-conversation]"));
  expect(answered).toEqual([REVIEW.path]);
});

test("the ⋯ holds the rows the screen's body used to list: Attach, the linked tasks and «Past attempts · n», each face with a way back", async () => {
  const PRIOR = file("/repo/implement-1.jsonl", "Implement, first try");
  const REVIEW_BOUND = { ...REVIEW, conversationId: "conversation-review-b" } as FileEntry;
  const membership = (slot: string) => ({
    kind: "flow" as const, containerId: "flow-9", role: "reviewer", slot, stageId: null, stageOrder: null, round: 3, parentConversationId: "conversation-builder",
  });
  const PRIOR_REVIEWER = {
    ...file("/repo/review-a.jsonl", "Review round 3, binding a"),
    conversationId: "conversation-review-a",
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [membership("reviewer:3:binding-a")] },
  } as unknown as FileEntry;
  const flow = {
    id: "flow-9", implementerPath: IMPLEMENT.path, state: "reviewing",
    rounds: [{ n: 3, reviewerPath: REVIEW_BOUND.path, reviewerConversationId: REVIEW_BOUND.conversationId, verdict: "REQUEST_CHANGES", startedAt: at(3_700) }],
  } as unknown as Flow;
  const pipeline = parkedPipeline({
    runs: [
      { stageId: "design", attempts: [attempt({})] },
      { stageId: "implement", attempts: [attempt({ n: 1, state: "failed", agentPath: PRIOR.path, verdict: { status: "fail", findings: ["the export endpoint returned 500"] } }), attempt({ n: 2, agentPath: IMPLEMENT.path })] },
      { stageId: "review", attempts: [attempt({ n: 3, state: "failed", agentPath: REVIEW_BOUND.path, flowId: "flow-9", verdict: { status: "fail", findings: ["one", "two"] } })] },
    ] as unknown as Pipeline["runs"],
    taskIds: ["t1"],
  } as unknown as Partial<Pipeline>);
  const task = { id: "t1", project: "atlas", text: "Approve the phone prototype\nmore", status: "assigned", assignments: [], updatedAt: new Date(NOW * 1_000).toISOString() } as unknown as BoardTask;
  const openedFiles: string[] = [];
  const openedTasks: string[] = [];
  const store = nav();
  const host = mount(
    <MobilePipelineScreen
      pipeline={pipeline}
      files={[IMPLEMENT, REVIEW_BOUND, PRIOR, PRIOR_REVIEWER]}
      flows={[flow]}
      tasks={[task]}
      now={NOW}
      onOpenConversation={(entry) => openedFiles.push(entry.path)}
      onOpenTask={(picked) => openedTasks.push(picked.id)}
    />, store,
  );
  /* Nothing of them is on the body any more. */
  expect(q(host, "[data-mobile2-section], [data-mobile2-past], [data-mobile2-past-toggle]")).toBeNull();
  await opened(host);
  const menu = () => dom.document.querySelector("[data-mobile2-pipeline-menu]") as unknown as HTMLElement;
  expect(Array.from(menu().querySelectorAll("[data-mobile2-menu-row]")).map((row) => row.getAttribute("data-mobile2-menu-row"))).toEqual(["changes", "checks", "board", "links", "tasks", "past"]);
  const rowOf = (name: string) => menu().querySelector(`[data-mobile2-menu-row="${name}"]`) as unknown as HTMLElement;
  expect(rowOf("tasks").textContent).toContain(translate("en", "mobile2.pipeline.linkedTasks"));
  expect(rowOf("tasks").textContent).toContain("1");
  /* Design, the two Implement attempts, the Review attempt and its round, and the other binding. */
  expect(rowOf("past").textContent).toContain(translate("en", "kanban.past.head", { count: 6 }));
  expect(menu().querySelector("[data-mobile2-stage-caption]")!.textContent).toBe(translate("en", "mobile2.pipeline.stageCaption"));

  /* Attach opens the links sheet. */
  click(rowOf("links"));
  await settle();
  expect(dom.document.querySelector('[data-mobile2-links-sheet="p2"]')).not.toBeNull();
  flushSync(() => store.closeSheet());
  await settle();

  /* The linked tasks, a face of the same sheet with a way back. */
  await opened(host);
  click(rowOf("tasks"));
  await settle();
  const tasks = dom.document.querySelector("[data-mobile2-pipeline-tasks]") as unknown as HTMLElement;
  expect(tasks).not.toBeNull();
  expect(Array.from(tasks.querySelectorAll("[data-mobile2-linked-task]")).map((row) => row.getAttribute("data-mobile2-linked-task"))).toEqual(["t1"]);
  click(tasks.querySelector('[data-mobile2-menu-row="back"]'));
  await settle();
  expect(dom.document.querySelector("[data-mobile2-pipeline-menu]")).not.toBeNull();
  click(rowOf("tasks"));
  await settle();
  click(dom.document.querySelector('[data-mobile2-linked-task="t1"]'));
  await settle();
  expect(openedTasks).toEqual(["t1"]);

  /* Past attempts, each row opening its transcript. */
  await opened(host);
  click(rowOf("past"));
  await settle();
  const priorRow = dom.document.querySelector('[data-mobile2-past-row="p2:implement:attempt:1"]') as unknown as HTMLElement;
  expect(priorRow.tagName).toBe("BUTTON");
  expect(priorRow.className).toContain("min-h-11");
  expect(priorRow.textContent).toContain(translate("en", "kanban.stageAttempt", { stage: "Implement", n: 1 }));
  const roundRow = dom.document.querySelector('[data-mobile2-past-row="p2:review:attempt:3:round:3"]') as unknown as HTMLElement;
  expect(roundRow.textContent).toContain(translate("en", "kanban.past.verdict.REQUEST_CHANGES"));
  const binding = dom.document.querySelector(`[data-mobile2-past-row="p2:review:transcript:${PRIOR_REVIEWER.path}"]`) as unknown as HTMLElement;
  expect(binding.textContent).toContain(translate("en", "mobile2.pipeline.reviewTranscript", { n: 3 }));
  /* An attempt whose transcript left the scan is a statement, not a dead button. */
  const design = dom.document.querySelector('[data-mobile2-past-row="p2:design:attempt:1"]') as unknown as HTMLElement;
  expect(design.tagName).toBe("DIV");
  expect(design.textContent).toContain(translate("en", "kanban.past.none"));
  click(priorRow);
  await settle();
  expect(openedFiles).toEqual([PRIOR.path]);
});

test("a lane with no linked task and no past attempt offers neither row", async () => {
  const host = mount(<MobilePipelineScreen pipeline={runningPipeline()} files={[BUILDING]} now={NOW} onOpenConversation={() => {}} />);
  await opened(host);
  const rows = Array.from(dom.document.querySelectorAll("[data-mobile2-pipeline-menu] [data-mobile2-menu-row]")).map((row) => row.getAttribute("data-mobile2-menu-row"));
  expect(rows).toContain("links");
  expect(rows).not.toContain("tasks");
});

test.each([false, true])("retained phone rounds open their exact archive with a transcript present: %s", async (present) => {
  const flow = { id: "retained-phone-review", state: "closed", rounds: [1, 2].map(n => ({
    n, reviewerPath: present ? REVIEW.path : null, verdict: n === 1 ? "REQUEST_CHANGES" : "APPROVE", startedAt: at(3700 - n),
  })) } as unknown as Flow;
  const pipeline = parkedPipeline({ runs: [{ stageId: "review", attempts: [attempt({ n: 3, state: "passed", flowId: flow.id })] }] } as unknown as Partial<Pipeline>);
  const targets: unknown[] = [];
  const openedFiles: string[] = [];
  const record = (event: Event) => targets.push((event as CustomEvent).detail);
  window.addEventListener("llv:review-history", record);
  try {
    const host = mount(<MobilePipelineScreen pipeline={pipeline} flows={[flow]} files={present ? [REVIEW] : []} now={NOW} onOpenConversation={file => openedFiles.push(file.path)} />);
    await opened(host);
    click(dom.document.querySelector('[data-mobile2-menu-row="past"]'));
    await settle();
    for (const n of [1, 2]) {
      const entry = dom.document.querySelector(`[data-mobile2-review-history="${flow.id}"][data-review-round="${n}"]`) as unknown as HTMLElement;
      expect(entry.tagName).toBe("BUTTON");
      click(entry);
    }
    expect(targets).toEqual([{ id: flow.id, round: 1 }, { id: flow.id, round: 2 }]);
    expect(openedFiles).toEqual([]);
  } finally { window.removeEventListener("llv:review-history", record); }
});

test("retained phone attempt offers its archive when the list row is absent", async () => {
  const id = "retained-without-list-row";
  const pipeline = parkedPipeline({ runs: [{ stageId: "review", attempts: [attempt({ state: "passed", flowId: id })] }] } as unknown as Partial<Pipeline>);
  const targets: unknown[] = [];
  const record = (event: Event) => targets.push((event as CustomEvent).detail);
  window.addEventListener("llv:review-history", record);
  try {
    const host = mount(<MobilePipelineScreen pipeline={pipeline} flows={[]} files={[]} now={NOW} onOpenConversation={() => {}} />);
    await opened(host);
    click(dom.document.querySelector('[data-mobile2-menu-row="past"]'));
    await settle();
    const entry = dom.document.querySelector(`[data-mobile2-review-history="${id}"]`) as unknown as HTMLElement;
    expect(entry.tagName).toBe("BUTTON");
    click(entry);
    expect(targets).toEqual([{ id, round: undefined }]);
  } finally { window.removeEventListener("llv:review-history", record); }
});

test("a running stage is selected with its conversation and the waits-on line names who works; the waiting stages are tabs the lane has not reached", () => {
  const openedFiles: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={runningPipeline()} files={[BUILDING]} now={NOW} onOpenConversation={(entry) => openedFiles.push(entry.path)} />);
  expect(selectedTab(host)).toBe("implement");
  expect(q(host, ".gs-waits")!.getAttribute("data-waits-on")).toBe("working");
  expect(q(host, ".gs-waits-words")!.textContent).toBe(`${translate("en", "kanban.stages.position", { k: 2, n: 5 })} · ${translate("en", "kanban.stages.waits.on", { who: translate("en", "kanban.stages.waits.role.builder"), stage: "Implement" })}`);
  const running = paneOf(host, "implement")!;
  expect(running.className).toContain("tone-active");
  expect(q(running, ".pstate")!.textContent).toBe(translate("en", "kanban.graphState.running"));
  click(q(running, "[data-open-conversation]"));
  expect(openedFiles).toEqual([BUILDING.path]);
  expect(q(host, "[data-answer-action]")).toBeNull();
  /* The stages after it wait. */
  for (const id of ["review", "fix", "merge"]) expect(tab(host, id)!.getAttribute("data-tab-state")).toBe("pending");
  /* A passed stage's tab says so. */
  expect(tab(host, "design")!.getAttribute("data-tab-state")).toBe("passed");
});

test("a paused lane says so in its waits-on line and keeps its stage selected, with Resume in the ⋯; resumed, it is live again (§3.13)", async () => {
  const paused = { ...runningPipeline(), state: "paused", pausedState: "running", pause: { reason: "waiting for a deploy window" } } as unknown as Pipeline;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  const store = nav();
  const render = (pipeline: Pipeline) => flushSync(() => root.render(
    <MobileNavContext.Provider value={store}>
      <MobilePipelineScreen pipeline={pipeline} files={[BUILDING]} now={NOW} onOpenConversation={() => {}} />
    </MobileNavContext.Provider>,
  ));
  const view = host as unknown as HTMLElement;
  render(paused);
  expect(selectedTab(view)).toBe("implement");
  expect(q(view, ".gs-waits")!.getAttribute("data-waits-on")).toBe("waiting");
  expect(q(view, ".gs-waits-words")!.textContent).toBe(`${translate("en", "kanban.stages.position", { k: 2, n: 5 })} · ${translate("en", "kanban.stages.waits.pausedWhy", { reason: "waiting for a deploy window" })}`);
  /* Resume is the ⋯'s first row. */
  click(q(view, '[data-mobile2-open="menu"]'));
  await settle();
  expect(Array.from(dom.document.querySelectorAll("[data-mobile2-pipeline-menu] [data-mobile2-pipeline-action]")).map((el) => el.getAttribute("data-mobile2-pipeline-action"))).toEqual(["resume", "archive"]);
  flushSync(() => store.closeSheet());
  await settle();
  /* Resumed: the same stage is live again, whose agent the line names. */
  render(runningPipeline());
  expect(q(view, ".gs-waits")!.getAttribute("data-waits-on")).toBe("working");
  expect(q(view, ".gs-waits-words")!.textContent).toContain(translate("en", "kanban.stages.waits.role.builder"));
});

test("a never-run stage's pane ⋯ opens its configuration in a sheet — the desktop's own editor — Tab stays inside it, and Escape closes only the sheet (lane 10, PR #431, #507 F2)", async () => {
  const store = nav();
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />, store);
  click(tab(host, "fix"));
  const gear = q(paneOf(host, "fix")!, "[data-pane-menu]")!;
  expect(gear.getAttribute("aria-haspopup")).toBe("menu");
  gear.focus();
  click(gear);
  await settle();
  /* The nav store owns «a sheet is open» (§3.3); the screen says which stage. */
  expect(store.getState().sheet).toBe("stage");
  const sheet = dom.document.querySelector('[data-mobile2-sheet="stage"]') as unknown as HTMLElement | null;
  expect(sheet).not.toBeNull();
  expect(sheet!.textContent).toContain(translate("en", "mobile2.pipeline.configureTitle", { stage: "Fix" }));
  expect(sheet!.querySelector('[data-mobile2-stage-config="fix"] [data-pipeline-stage-card="p2::fix"]')).not.toBeNull();
  /* Retry and Skip act on the stage the lane waits on, and this one is not. */
  expect(Array.from(sheet!.querySelectorAll("[data-mobile2-stage-act]")).map((row) => [row.getAttribute("data-mobile2-stage-act"), row.hasAttribute("data-refused")])).toEqual([["retry-stage", true], ["skip-stage", true]]);
  /* A real modal dialog (PR #431): it takes focus on open. */
  expect(sheet!.getAttribute("aria-modal")).toBe("true");
  expect(sheet!.contains(dom.document.activeElement as never)).toBe(true);

  /* The stage editor unfolds INSIDE this sheet (#507 F2): one layer. */
  const toggle = sheet!.querySelector(`button[aria-label="${translate("en", "groupOverride.applyStage")}"]`) as unknown as HTMLButtonElement | null;
  expect(toggle).not.toBeNull();
  click(toggle);
  await settle();
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  expect(sheet!.querySelector('label[for="draft-role-pipeline-config::p2::fix"]')).not.toBeNull();
  expect(dom.document.querySelectorAll('[role="dialog"]').length).toBe(1);

  /* Tab is trapped inside the sheet in both directions, editor included. */
  const press = (init: { key: string; shiftKey?: boolean }) =>
    flushSync(() => dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as never));
  const focusables = Array.from(sheet!.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.hasAttribute("disabled") && el.getAttribute("tabindex") !== "-1") as unknown as HTMLElement[];
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  expect(focusables.some((el) => el.id === "draft-role-pipeline-config::p2::fix")).toBe(true);
  last.focus();
  press({ key: "Tab" });
  expect(dom.document.activeElement).toBe(first as never);
  first.focus();
  press({ key: "Tab", shiftKey: true });
  expect(dom.document.activeElement).toBe(last as never);

  /* Escape closes the sheet and nothing else. */
  flushSync(() => dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never));
  await settle();
  expect(dom.document.querySelector('[data-mobile2-sheet="stage"]')).toBeNull();
  expect(store.getState().sheet).toBeNull();
  expect(q(host, '[data-mobile2-screen="pipeline"]')).not.toBeNull();
});

test("the pane's ⋯ on the stage the lane waits on offers Retry and Skip, which go through the board's guarded answers", async () => {
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  click(q(paneOf(host, "review")!, "[data-pane-menu]"));
  await settle();
  const sheet = dom.document.querySelector('[data-mobile2-sheet="stage"]') as unknown as HTMLElement;
  expect(sheet.textContent).toContain(translate("en", "mobile2.pipeline.stageMenu", { stage: "Review" }));
  expect(Array.from(sheet.querySelectorAll("[data-mobile2-stage-act]")).map((row) => [row.getAttribute("data-mobile2-stage-act"), row.hasAttribute("data-refused"), row.textContent])).toEqual([
    ["retry-stage", false, translate("en", "kanban.stages.retryThis")],
    ["skip-stage", false, translate("en", "kanban.stages.skipThis")],
  ]);
});

test("a tap on a stage that has not started opens this screen on that stage's tab and sheet, once; a stage that ran, another lane or a finished lane opens none (docs/design/task-card-no-inline-conversations.md §6)", async () => {
  const { requestPipelineStage } = await import("./pipelineStageRequest");
  const sheetOf = () => dom.document.querySelector('[data-mobile2-sheet="stage"]') as unknown as HTMLElement | null;

  const store = nav();
  requestPipelineStage("p2", "fix");
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />, store);
  await settle();
  expect(store.getState().sheet).toBe("stage");
  expect(selectedTab(host)).toBe("fix");
  expect(sheetOf()!.textContent).toContain(translate("en", "mobile2.pipeline.configureTitle", { stage: "Fix" }));
  expect(sheetOf()!.querySelector('[data-mobile2-stage-config="fix"] [data-pipeline-stage-card="p2::fix"]')).not.toBeNull();
  flushSync(() => store.closeSheet());
  await settle();
  expect(sheetOf()).toBeNull();

  /* The request is taken once: the next screen for the same lane opens plain. */
  const again = nav();
  mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />, again);
  await settle();
  expect(again.getState().sheet).toBeNull();

  for (const [pipelineId, stageId, pipeline] of [
    ["p2", "review", parkedPipeline()],
    ["other", "fix", parkedPipeline()],
    ["p2", "fix", parkedPipeline({ state: "completed", cursor: null })],
  ] as const) {
    const plain = nav();
    requestPipelineStage(pipelineId, stageId);
    mount(<MobilePipelineScreen pipeline={pipeline} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />, plain);
    await settle();
    expect(plain.getState().sheet).toBeNull();
    expect(sheetOf()).toBeNull();
  }
});

test("a spent review budget is answered from the ⋯: its stop is in the review stage's pane, and Accept as is is a row (One more round is refused by the fixed budget)", async () => {
  const review = parkedPipeline({
    state: "needs_review",
    cursor: null,
    runs: [
      { stageId: "design", attempts: [attempt({})] },
      { stageId: "implement", attempts: [attempt({ agentPath: IMPLEMENT.path })] },
      { stageId: "review", attempts: [attempt({ n: 3, state: "passed", agentPath: REVIEW.path, reviewFlowSync: { roundCount: 3 } })] },
    ],
    reviewPending: { stageId: "review", attempt: 3, fixStageId: "implement", fixAttempt: 1, reviewedHead: "4f1c2a9d11", currentHead: "9b2e7d4c22", verdict: "fail", findings: 2 },
  } as unknown as Partial<Pipeline>);
  const host = mount(<MobilePipelineScreen pipeline={review} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(selectedTab(host)).toBe("review");
  /* One line on why it stopped (#2187 §3.4); the two heads ride its tooltip. */
  const reason = q(paneOf(host, "review")!, "[data-review-stop]")!;
  expect(reason.getAttribute("data-review-stop")).toBe("stop-after-fix");
  expect(reason.textContent).toBe(translate("en", "pipelineBlock.stop.afterFix"));
  expect(reason.getAttribute("title")).toContain("9b2e7d4c");
  expect(qa(host, "[data-answer-action]")).toEqual([]);
  expect(q(host, ".gs-waits")!.getAttribute("data-waits-on")).toBe("you");
  await opened(host);
  expect(Array.from(dom.document.querySelectorAll("[data-phone-lane-answer]")).map((el) => el.getAttribute("data-phone-lane-answer"))).toEqual(["accept-head"]);
});

test("a completed lane has every stage as a tab with the last one that started selected, and says it is done", () => {
  const done = parkedPipeline({
    state: "completed",
    cursor: null,
    closedAt: at(1_200),
    stages: STAGES.slice(0, 3).map((stage, index) => (index === 2 ? { ...stage, next: null } : stage)),
    runs: [
      { stageId: "design", attempts: [attempt({})] },
      { stageId: "implement", attempts: [attempt({ n: 1, state: "failed", verdict: { status: "fail" } }), attempt({ n: 2, agentPath: IMPLEMENT.path })] },
      { stageId: "review", attempts: [attempt({ n: 1, agentPath: REVIEW.path, completedAt: at(1_200) })] },
    ],
  } as unknown as Partial<Pipeline>);
  const host = mount(<MobilePipelineScreen pipeline={done} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(host, ".gs-waits")!.getAttribute("data-waits-on")).toBe("done");
  expect(q(host, ".gs-waits-words")!.textContent).toBe(translate("en", "cardState.done.plain"));
  expect(qa(host, '[role="tab"]').map((el) => el.getAttribute("data-tab-state"))).toEqual(["passed", "passed", "passed"]);
  expect(selectedTab(host)).toBe("review");
  expect(q(host, "[data-answer-action]")).toBeNull();
  /* The retried stage says which attempt passed. */
  click(tab(host, "implement"));
  expect(qa(paneOf(host, "implement")!, ".attempts button").map((button) => button.textContent)).toEqual([`${translate("en", "kanban.attemptWord", { n: 1 })} · ${translate("en", "kanban.graphState.failed")}`, `${translate("en", "kanban.attemptWord", { n: 2 })} · ${translate("en", "kanban.graphState.passed")}`]);
});

test("a hidden lane offers Show on board as a row of the ⋯", async () => {
  const hidden = parkedPipeline({ dismissedAt: at(30) } as Partial<Pipeline>);
  const host = mount(<MobilePipelineScreen pipeline={hidden} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(host, "[data-mobile2-pipeline-body] [data-mobile2-pipeline-action]")).toBeNull();
  await opened(host);
  const row = dom.document.querySelector('[data-mobile2-pipeline-menu] [data-mobile2-pipeline-action="showOnBoard"]') as unknown as HTMLElement;
  expect(row.textContent).toBe(translate("en", "mobile2.pipeline.showOnBoard"));
  expect(row.getAttribute("data-mobile2-pipeline-patch")).toBe("undismiss");
});

test("the bar's ⋯ holds the lane's own actions and leads on to the board's menu", async () => {
  const store = nav();
  const boardMenu = (name: string, close: () => void) => (name === "menu" ? <div data-board-menu onClick={close} /> : null);
  const host = mount(<MobilePipelineScreen pipeline={runningPipeline()} files={[BUILDING]} now={NOW} onOpenConversation={() => {}} renderSheet={boardMenu} />, store);
  click(q(host, '[data-mobile2-open="menu"]'));
  await settle();
  const sheet = dom.document.querySelector('[data-mobile2-sheet="menu"]') as unknown as HTMLElement;
  expect(sheet.querySelector("[data-mobile2-pipeline-menu]")).not.toBeNull();
  expect(Array.from(sheet.querySelectorAll("[data-mobile2-pipeline-action]")).map((el) => [el.getAttribute("data-mobile2-pipeline-action"), el.textContent])).toEqual([
    ["pause", translate("en", "mobile2.pipeline.pause")],
    ["archive", translate("en", "mobile2.pipeline.archive")],
  ]);
  click(sheet.querySelector('[data-mobile2-menu-row="board"]'));
  await settle();
  expect(dom.document.querySelector("[data-mobile2-pipeline-menu]")).toBeNull();
  expect(dom.document.querySelector("[data-board-menu]")).not.toBeNull();
  /* Closing the sheet puts the next ⋯ back on the lane's own face. */
  flushSync(() => store.closeSheet());
  await settle();
  click(q(host, '[data-mobile2-open="menu"]'));
  await settle();
  expect(dom.document.querySelector("[data-mobile2-pipeline-menu]")).not.toBeNull();
});

test("the ⋯ actions for a lane are the board menu's pause or resume, and Close lane", () => {
  const specs = (state: Pipeline["state"]) => mobilePipelineActions(parkedPipeline({ state, pausedState: state === "paused" ? "running" : null } as Partial<Pipeline>)).map((spec) => spec.action);
  expect(specs("running")).toEqual(["pause", "close"]);
  expect(specs("provisioning")).toEqual(["pause", "close"]);
  expect(specs("needs_decision")).toEqual(["pause", "close"]);
  expect(specs("needs_review")).toEqual(["pause", "close"]);
  expect(specs("paused")).toEqual(["resume", "close"]);
  /* A finished lane leaves the phone's lists by its close; a closed one has nothing left. */
  expect(specs("completed")).toEqual(["close"]);
  expect(specs("closed")).toEqual([]);
  expect(specs("draft")).toEqual([]);
});

test("in Ukrainian the stage names stay the pipeline's and every word is the desktop's Ukrainian word", () => {
  setLocale("uk");
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(qa(host, '[role="tab"] .slbl').map((el) => el.textContent)).toEqual(["Design", "Implement", "Review", "Fix", "Merge"]);
  expect(q(host, ".gs-waits-words")!.textContent).toBe(translate("uk", "cardState.you.lane", { why: translate("uk", "cardState.why.other", { stage: "review" }) }));
  expect(qa(host, ".gs-rule").map((rule) => rule.textContent)).toEqual([`↺ ${translate("uk", "kanban.stages.ruleRest", { from: "Review", to: "Implement", fired: 0, max: 3 })}`]);
  expect(qa(host, "[data-answer-action]")).toEqual([]);
  expect(q(host, "[data-open-conversation]")!.textContent).toBe(translate("uk", "pipelineStage.openAgent"));
});

test.each(["running", "passed", "failed", "needs_decision"] as const)("a single stage lane has no tabs; its pane opens %s conversations and the question comes before the answer", (state) => {
  const old = { ...IMPLEMENT, path: "/fixture/old-design.jsonl", conversationId: "conversation_old" } as FileEntry;
  const current = { ...REVIEW, conversationId: "conversation_design" } as FileEntry;
  const p = parkedPipeline({
    stages: [STAGES[0]!], state: state === "passed" ? "completed" : state === "running" ? "running" : "needs_decision",
    cursor: state === "passed" ? null : { stageId: "design", state, input: null, activatedBy: null },
    runs: [{ stageId: "design", attempts: [
      attempt({ n: 1, state: "failed", agentPath: old.path }),
      attempt({ n: 2, state, agentPath: current.path, conversationId: current.conversationId, report: { verdict: { status: "needs_decision", findings: [] }, summary: "Choose a layout.\nCompact or expanded?" } }),
    ] }],
  } as unknown as Partial<Pipeline>);
  const openedFiles: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={p} files={[old, current]} now={NOW} onOpenConversation={(file) => openedFiles.push(file.path)} />);
  expect(qa(host, '[role="tab"]')).toEqual([]);
  const stage = paneOf(host, "design")!;
  expect(q(stage, "[data-open-conversation]")?.textContent).toContain("Open agent");
  click(q(stage, "[data-open-conversation]"));
  expect(openedFiles).toEqual([current.path]);
  expect(q(stage, "[data-stage-question]")?.textContent ?? null).toBe(state === "needs_decision" ? "Choose a layout.\nCompact or expanded?" : null);
  /* Its earlier attempt is one press away on the attempts row. */
  click(q(stage, '[data-attempt="1"]'));
  expect(q(stage, '[data-attempt="1"]')!.getAttribute("aria-pressed")).toBe("true");
});

test("a stage that ran in the cloud opens its stored cloud task from its pane, in both languages", () => {
  const taskUrl = "https://example.com/cloud/tasks/task_abc123";
  const cloudPipeline = (cloud: Record<string, unknown>) => parkedPipeline({
    stages: [STAGES[0]!], state: "completed", cursor: null,
    runs: [{ stageId: "design", attempts: [attempt({ n: 1, state: "passed", agentPath: null, conversationId: null, definition: { runtime: "codex-cloud" }, cloud })] }],
  } as unknown as Partial<Pipeline>);
  for (const lang of ["en", "uk"] as const) {
    setLocale(lang);
    const host = mount(<MobilePipelineScreen pipeline={cloudPipeline({ phase: "completed", taskId: "task_abc123", taskUrl })} files={[]} now={NOW} onOpenConversation={() => { throw new Error("cloud stages have no transcript"); }} />);
    const link = q(host, '.pane[data-stage="design"] a[data-open-cloud="design"]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(taskUrl);
    expect(link.textContent).toBe(translate(lang, "pipelineStage.openCloudTask"));
    expect(q(host, "[data-open-conversation]")).toBeNull();
    const bare = mount(<MobilePipelineScreen pipeline={cloudPipeline({ phase: "failed", taskId: null, taskUrl: null, error: "refused", submissionUnresolved: false })} files={[]} now={NOW} onOpenConversation={() => {}} />);
    expect(q(bare, "[data-open-cloud]")).toBeNull();
  }
});

test("a conversation id missing from the scan still offers Open agent and uses the normal reader link in Ukrainian", () => {
  setLocale("uk");
  const p = parkedPipeline({ stages: [STAGES[0]!], cursor: { stageId: "design", state: "needs_decision", input: null, activatedBy: null }, runs: [{ stageId: "design", attempts: [attempt({ state: "needs_decision", conversationId: "conversation_design", report: { verdict: { status: "needs_decision", findings: [] }, summary: "Який варіант обрати?" } })] }] } as unknown as Partial<Pipeline>);
  const host = mount(<MobilePipelineScreen pipeline={p} files={[]} now={NOW} onOpenConversation={() => { throw new Error("not scanned"); }} />);
  expect(q(host, '[data-open-conversation]')?.textContent).toContain("Відкрити агента");
  click(q(host, '[data-open-conversation]'));
  expect(dom.location.hash).toContain("conversation_design");
});
