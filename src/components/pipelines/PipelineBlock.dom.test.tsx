import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { FilesWorkLinks, ResolvedWorkLinks, WorkLink } from "@/lib/forge/workLinks";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * The one pipeline block (#2072 slice 3, docs/design/phone-kanban.md §3.13,
 * docs/design/desktop-flat-cards.md §4) at its three densities: the same stage
 * names, state words and loop words everywhere, a card line that is passive
 * and folds to fit, a task row whose head says its state once, and the answer
 * given in place. Invented records; nothing is fetched.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, localStorage: dom.localStorage,
  ResizeObserver: undefined,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
/* React schedules the last unmount's passive effects on a timer; they read
   `window`, so the globals stay until that timer has run. */
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { PipelineBlock, PipelineStateLine } = await import("./PipelineBlock");
const { summarizePipeline } = await import("@/components/kanban/kanbanModel");
const { WorkLinksProvider } = await import("@/components/workLinks/workLinksContext");
const { setLocale, translate } = await import("@/lib/i18n");
const { stageNames } = await import("./pipelineModel");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  setLocale("en");
});

const NOW_MS = Date.parse("2026-09-23T12:00:00Z");
const iso = (secondsAgo: number) => new Date(NOW_MS - secondsAgo * 1000).toISOString();
const role = (roleId: string) => ({ roleId, engine: roleId === "reviewer" ? "codex" : "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) => ({ id, kind: "run", role: { roleId }, prompt: "", next, onFail: null, effectiveRole: role(roleId), ...over });
const attempt = (n: number, state: string, startedAgo: number, over: Record<string, unknown> = {}) => ({
  n, state, effectiveRole: role("builder"), launchId: null, conversationId: `conversation_${n}_${state}`, sessionId: null, agentPath: `/fixture/${n}-${state}.jsonl`, paneId: null, flowId: null,
  startedAt: iso(startedAgo), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
});

/* Four stages, the fail edge from Verify back to Implement fired once of two, Verify running again. */
function searchPipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p-search", task: "Restore search results after the index rebuild", taskIds: [], project: "fixture", state: "running",
    stages: [stage("implement", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }), stage("merge", "cleaner", null)],
    runs: [
      { stageId: "implement", attempts: [attempt(1, "passed", 7200), attempt(2, "passed", 4000, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
      { stageId: "review", attempts: [attempt(1, "passed", 3600)] },
      { stageId: "verify", attempts: [attempt(1, "failed", 5000), attempt(2, "running", 1200)] },
    ],
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    createdAt: iso(9000), closedAt: null,
    ...over,
  } as unknown as Pipeline;
}
/* Verify came back failed with one ranked finding, and the lane waits on the operator. */
const parked = () => searchPipeline({
  state: "needs_decision",
  runs: searchPipeline().runs.map((run) => (run.stageId === "verify"
    ? { ...run, attempts: [run.attempts[0]!, { ...run.attempts[1]!, state: "failed", startedAt: iso(3000), completedAt: iso(2460), verdict: { status: "fail", findings: ["P1 — the alias swaps early"], rankedFindings: [{ severity: "P1", text: "the alias swaps early" }] } }] }
    : run)),
} as Partial<Pipeline>);

const link = (number: number, over: Partial<WorkLink> = {}): WorkLink => ({
  key: `acme/widgets#${number}`, repository: "acme/widgets", number, kind: "pr", state: "open", url: `https://github.com/acme/widgets/pull/${number}`,
  checkedAt: iso(60), source: "auto", via: ["branch"], ...over,
} as WorkLink);

function mount(node: React.ReactNode, links: Record<string, ResolvedWorkLinks> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const value = { pipelines: links, tasks: {} } as unknown as FilesWorkLinks;
  flushSync(() => root.render(<WorkLinksProvider value={value}>{node}</WorkLinksProvider>));
  return host;
}
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const texts = (host: Element, selector: string) => [...host.querySelectorAll(selector)].map((node) => node.textContent);

test("every density says what the desktop says: the stage names, the stage state words and the loop words (§5)", () => {
  const pipeline = searchPipeline();
  const summary = summarizePipeline(pipeline);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
  const names = [...stageNames(t, pipeline).values()];
  expect(names).toEqual(["Implement", "Review", "Verify", "Merge"]);
  const loop = t("kanban.loopTitle", { from: "Verify", to: "Implement", fired: 1, max: 2 });

  const card = mount(<PipelineBlock summary={summary} density="card" nowMs={NOW_MS} />);
  const task = mount(<PipelineBlock summary={summary} density="task" nowMs={NOW_MS} onOpenStage={() => {}} />);
  const screen = mount(<PipelineBlock summary={summary} density="screen" nowMs={NOW_MS} onOpenStage={() => {}} />);
  for (const host of [card, task]) {
    expect(texts(host, ".pb-pill[data-stage] .pb-name")).toEqual(names);
    /* The pill's state is the graph's own word, in its tooltip. */
    expect(host.querySelector<HTMLElement>('.pb-pill[data-stage="verify"]')?.title).toStartWith(`Verify · ${t("kanban.graphState.running")}`);
    /* The fail edge rides the failing pill with the graph's own sentence. */
    const suffix = host.querySelector<HTMLElement>('.pb-pill[data-stage="verify"] .pret')!;
    expect(suffix.textContent).toBe("↺1/2");
    expect(suffix.title).toContain(loop);
  }
  /* The passed stages before the current one fold into one row; opened, every stage has its row. */
  click(screen.querySelector("[data-passed-fold]"));
  expect(texts(screen, ".pb-stage[data-stage] .pb-name")).toEqual(names);
  expect(texts(screen, ".pb-stage[data-stage] .pb-stage-state")).toEqual(["passed", "passed", "running", "pending"].map((word) => t(`kanban.graphState.${word}` as Parameters<typeof translate>[1])));
  expect(screen.querySelector<HTMLElement>('.pb-stage[data-stage="verify"] .pret')?.title).toContain(loop);
  expect(texts(screen, ".pb-loops li")).toEqual([`↺ ${t("kanban.loopRest", { from: "Verify", to: "Implement", max: 2 })}`]);
});

test("stage names stay the pipeline's in Ukrainian, and the state words are the desktop's Ukrainian words", () => {
  setLocale("uk");
  const summary = summarizePipeline(parked());
  const host = mount(<PipelineBlock summary={summary} density="task" nowMs={NOW_MS} onOpenStage={() => {}} onAnswer={() => {}} />);
  expect(texts(host, ".pb-pill[data-stage] .pb-name")).toEqual(["Implement", "Review", "Verify", "Merge"]);
  expect(host.querySelector(".pstate-word")?.textContent).toBe(translate("uk", "pipelineState.needs_decision"));
  expect(texts(host, "[data-answer-action]")).toEqual([
    translate("uk", "kanban.pipelineAct.label.skip-stage", { stage: "Verify" }),
    translate("uk", "kanban.pipelineAct.label.retry-stage", { stage: "Verify" }),
  ]);
});

test("the card line is passive: no control in it, the PR as text, the reason in warning words, and a finished lane one muted line", () => {
  const links = { "p-search": { links: [link(2070), link(2061, { kind: "issue", state: null })], noPr: false } } as Record<string, ResolvedWorkLinks>;
  const decision = mount(<PipelineBlock summary={summarizePipeline(parked())} density="card" nowMs={NOW_MS} />, links);
  expect(decision.querySelectorAll("button, a, [role=img]")).toHaveLength(0);
  expect(decision.querySelector("[data-work-links-text]")?.textContent).toBe("#2070+1");
  expect(decision.querySelector("[data-pipeline-reason]")?.textContent).toBe("Verify failed · 1 finding · 41m");
  expect(decision.querySelector(".pb-age")).toBeNull();
  expect(decision.querySelector('.pb-pill[data-stage="verify"] .pmark')?.getAttribute("data-mark")).toBe("cross");

  const running = mount(<PipelineBlock summary={summarizePipeline(searchPipeline())} density="card" nowMs={NOW_MS} />);
  expect(running.querySelector("[data-pipeline-reason]")).toBeNull();
  /* The age carries its unit and never reads as a clock (§5 Ages). */
  expect(running.querySelector(".pb-age")?.textContent).toBe("20m");
  expect(running.textContent).not.toMatch(/\b\d{1,2}:\d{2}\b/);

  const paused = mount(<PipelineBlock summary={summarizePipeline(searchPipeline({ state: "paused", pausedState: "running" } as Partial<Pipeline>))} density="card" nowMs={NOW_MS} />);
  expect(paused.querySelector(".pb-age")?.textContent).toBe("paused · 20m");

  const done = mount(<PipelineBlock summary={summarizePipeline(searchPipeline({ state: "completed", cursor: null, closedAt: iso(1200) } as Partial<Pipeline>))} density="card" nowMs={NOW_MS} />, links);
  expect(done.querySelector(".pb-pills")).toBeNull();
  expect(done.querySelector(".pb-ended")?.textContent).toBe("completed · 20m");
  expect(done.querySelector(".pb-line.ended [data-work-links-text]")?.textContent).toBe("#2070+1");
});

/* happy-dom lays nothing out, so the fold is handed a layout: every step of
   the chain is 80 px wide, the chain has 230 px beside the age and the PR, and
   330 px once it takes the line alone. */
function withFoldLayout(): () => void {
  const proto = dom.HTMLElement.prototype;
  const saved = { client: Object.getOwnPropertyDescriptor(proto, "clientWidth"), scroll: Object.getOwnPropertyDescriptor(proto, "scrollWidth") };
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("fold")) return this.parentElement?.dataset.alone === "1" ? 330 : 230;
      if (this.classList.contains("pb-line")) return 330;
      return 0;
    },
  });
  Object.defineProperty(proto, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("fold") ? this.children.length * 80 : 0; },
  });
  return () => {
    for (const [name, descriptor] of [["clientWidth", saved.client], ["scrollWidth", saved.scroll]] as const) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[name];
    }
  };
}

test("the card's chain steps down to the widest fold that fits, takes the line alone when none does, and never cuts the current stage", () => {
  const restore = withFoldLayout();
  try {
    const stages = ["plan", "build-api", "review-api", "build-ui", "review-ui", "verify", "docs", "merge"];
    const eight = searchPipeline({
      stages: stages.map((id, index) => stage(id, "builder", stages[index + 1] ?? null)),
      runs: stages.slice(0, 4).map((id, index) => ({ stageId: id, attempts: [attempt(1, index < 3 ? "passed" : "running", 600 - index * 100)] })),
      cursor: { stageId: "build-ui", state: "running", input: null, activatedBy: null },
    } as unknown as Partial<Pipeline>);
    const host = mount(<PipelineBlock summary={summarizePipeline(eight)} density="card" nowMs={NOW_MS} />);
    const line = host.querySelector<HTMLElement>(".pb-line")!;
    /* 640, 480, 320 and 240 px do not fit in 230 px beside the age; alone in
       330 px the third fold (320 px) does. */
    expect(line.dataset.alone).toBe("1");
    expect(line.dataset.foldLevel).toBe("2");
    expect([...line.querySelectorAll(".pb-pills .pb-step > .pb-pill")].map((pill) => pill.querySelector(".pb-name")?.textContent))
      .toEqual(["3", "Build ui", "Review ui", "+3"]);
    /* The age and the PR moved to the line below rather than squeezing the chain. */
    expect(line.querySelector(".pb-age")).toBeNull();
    expect(host.querySelector(".pb-line.sub .pb-age")?.textContent).toBe("5m");
  } finally {
    restore();
  }
});

test("the task row says its state once, drops a title the task already has, and ends its chain line with the lane's chips", () => {
  const links = { "p-search": { links: [], noPr: true } } as Record<string, ResolvedWorkLinks>;
  const same = mount(<PipelineBlock summary={summarizePipeline(searchPipeline({ state: "paused", pausedState: "running" } as Partial<Pipeline>))} density="task" nowMs={NOW_MS} taskTitle="Restore search results after the index rebuild" onOpenStage={() => {}} />, links);
  expect(same.querySelector(".pb-title")).toBeNull();
  /* With the task's own title and no ⋯ of its own, the chain is the head
     (#2148): the state, the age and the way into the stages end its row. */
  expect(same.querySelector(".pb-head")).toBeNull();
  expect(texts(same, ".pb-chain > .pb-tail .pstate-word")).toEqual(["paused"]);
  expect(same.querySelector(".pb-chain > .pb-links [data-work-links-nopr]")?.textContent).toBe("no PR");
  /* Who runs a stage is in the pill's tooltip, not on the pill (#1743). */
  expect(same.querySelector(".pb-pill .pident, .pb-pill [data-effort-pills]")).toBeNull();
  expect(same.querySelector<HTMLElement>('.pb-pill[data-stage="implement"]')?.title).toContain("Claude");

  const running = mount(<PipelineBlock summary={summarizePipeline(searchPipeline({ task: "Keep the old index serving" }))} density="task" nowMs={NOW_MS} taskTitle="Restore search results after the index rebuild" onOpenStage={() => {}} />);
  expect(running.querySelector(".pb-title")?.textContent).toBe("Keep the old index serving");
  /* "stages running" is the live pill's to say. */
  expect(running.querySelector(".pstate-word")).toBeNull();
  /* No graph toggle, ⋯ or answer where the host passes nothing to do. */
  expect(running.querySelector("[data-graph-toggle], [data-pipeline-menu], [data-answer-action]")).toBeNull();
});

test("the stage chain is the lane's head where the card's ⋯ holds its actions; a lane with a ⋯ or a title of its own keeps its head row (#2148)", () => {
  const opened: string[] = [];
  const menus: string[] = [];
  const summary = summarizePipeline(searchPipeline());
  const chain = mount(<PipelineBlock summary={summary} density="task" nowMs={NOW_MS} taskTitle="Restore search results after the index rebuild" onOpenStage={() => {}} onToggleGraph={() => {}} onOpenStages={(pipeline) => opened.push(pipeline.id)} />);
  expect(chain.querySelector(".pb-head")).toBeNull();
  const row = chain.querySelector(".pb-chain")!;
  /* One row: the pills, then the graph toggle and the age with its chevron,
     which ends the row. */
  expect([...row.children].map((child) => child.className)).toEqual(["pb-pills", "pb-tail"]);
  expect([...row.querySelector(".pb-tail")!.children].map((child) => child.getAttribute("data-graph-toggle") !== null ? "graph" : child.getAttribute("data-open-stages") !== null ? "open" : child.className)).toEqual(["graph", "open"]);
  expect(row.querySelector("[data-pipeline-menu]")).toBeNull();
  click(row.querySelector("[data-open-stages]"));
  expect(opened).toEqual(["p-search"]);

  /* A pipeline on no task (no card ⋯) keeps its own ⋯, so it keeps the head row. */
  const own = mount(<PipelineBlock summary={summary} density="task" nowMs={NOW_MS} taskTitle="Restore search results after the index rebuild" onOpenStage={() => {}} onMenu={(pipeline) => menus.push(pipeline.id)} />);
  expect(own.querySelector(".pb-head [data-open-stages]")).toBeTruthy();
  expect(own.querySelector(".pb-tail")).toBeNull();
  click(own.querySelector(".pb-head [data-pipeline-menu]"));
  expect(menus).toEqual(["p-search"]);

  /* A lane titled apart from its task says the title in its own head row. */
  const titled = mount(<PipelineBlock summary={summarizePipeline(searchPipeline({ task: "Keep the old index serving" }))} density="task" nowMs={NOW_MS} taskTitle="Restore search results after the index rebuild" onOpenStage={() => {}} />);
  expect(titled.querySelector(".pb-head .pb-title")?.textContent).toBe("Keep the old index serving");
  expect(titled.querySelector(".pb-tail")).toBeNull();
});

test("the answer in place names the stage and attempt it saw, and waits while an action is on its way", () => {
  const answers: unknown[] = [];
  const host = mount(<PipelineBlock summary={summarizePipeline(parked())} density="task" nowMs={NOW_MS} onOpenStage={() => {}} onAnswer={(pipeline, answer) => answers.push([pipeline.id, answer])} />);
  expect(host.querySelector(".pb-answer .stage-findings li")?.textContent).toBe("P1the alias swaps early");
  click(host.querySelector('[data-answer-action="retry-stage"]'));
  click(host.querySelector('[data-answer-action="skip-stage"]'));
  expect(answers).toEqual([
    ["p-search", { action: "retry-stage", stageId: "verify", stageName: "Verify", expectedAttempt: 2 }],
    ["p-search", { action: "skip-stage", stageId: "verify", stageName: "Verify", expectedAttempt: 2 }],
  ]);

  const busy = mount(<PipelineBlock summary={summarizePipeline(parked())} density="task" nowMs={NOW_MS} acting="skip-stage" onAnswer={() => {}} />);
  expect(busy.querySelector("[data-pipeline-acting]")?.textContent).toBe("Skipping…");
  expect([...busy.querySelectorAll<HTMLButtonElement>("[data-answer-action]")].every((button) => button.disabled)).toBe(true);
});

test("the graph is the operator's toggle on the task row, and it replaces the chain in place", () => {
  const toggles: boolean[] = [];
  const closed = mount(<PipelineBlock summary={summarizePipeline(searchPipeline())} density="task" nowMs={NOW_MS} onOpenStage={() => {}} onToggleGraph={(open) => toggles.push(open)} />);
  click(closed.querySelector("[data-graph-toggle]"));
  expect(toggles).toEqual([true]);
  expect(closed.querySelector(".pb-graph")).toBeNull();
  const open = mount(<PipelineBlock summary={summarizePipeline(searchPipeline())} density="task" nowMs={NOW_MS} graphOpen onOpenStage={() => {}} onToggleGraph={() => {}} />);
  expect(open.querySelector("[data-graph-toggle]")?.getAttribute("aria-pressed")).toBe("true");
  expect(open.querySelector('.pb-graph[data-open="1"]')).toBeTruthy();
  expect(open.querySelector(".pb-chain")).toBeNull();
});

test("the screen density numbers the stages, folds the passed ones before the current one, and answers inside the parked stage", () => {
  const answers: string[] = [];
  const host = mount(<PipelineBlock summary={summarizePipeline(parked())} density="screen" nowMs={NOW_MS} onOpenStage={() => {}} onAnswer={(_pipeline, answer) => answers.push(answer.action)} />);
  /* The screen's bar says where the lane stands; the body owns the title. */
  const bar = mount(<PipelineStateLine summary={summarizePipeline(parked())} nowMs={NOW_MS} />);
  expect(bar.textContent).toBe(`${translate("en", "pipelineState.needs_decision")}·stage 3 of 4·41m`);
  expect(host.querySelector(".pb-stateline")).toBeNull();
  expect(host.querySelector("h2[data-pipeline-heading]")?.textContent).toBe("Restore search results after the index rebuild");
  const fold = host.querySelector<HTMLElement>("[data-passed-fold]")!;
  expect(fold.querySelector(".pb-name")?.textContent).toBe("2 passed");
  expect(fold.querySelector(".pb-ident-words")?.textContent).toBe("Implement · Review");
  expect(fold.getAttribute("aria-label")).toBe("2 passed · Implement · Review");
  expect(host.querySelector('.pb-stage[data-stage="implement"]')).toBeNull();
  click(fold);
  expect(host.querySelector('.pb-stage[data-stage="implement"]')).toBeTruthy();
  const current = host.querySelector<HTMLElement>(".pb-stage[data-stage-current]")!;
  expect(current.dataset.stage).toBe("verify");
  /* The stage the lane waits on takes the lane's amber and its state word;
     its mark keeps the failed stage's cross. */
  expect(current.className).toContain("tone-needs");
  expect(current.querySelector(".pb-stage-state")?.textContent).toBe(translate("en", "pipelineState.needs_decision"));
  expect(current.querySelector(".pb-stage-title .pmark")?.getAttribute("data-mark")).toBe("cross");
  expect(texts(current, "[data-answer-action]")).toEqual([translate("en", "mobile2.pipeline.skip"), translate("en", "mobile2.pipeline.retry")]);
  click(current.querySelector('[data-answer-action="retry-stage"]'));
  expect(answers).toEqual(["retry-stage"]);
});
