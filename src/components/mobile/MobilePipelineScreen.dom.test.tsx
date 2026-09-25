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
 * One pipeline on the phone, the Stages view (#2072 slice 6,
 * docs/design/phone-kanban.md §3.13; mobile v2 lane 7 before it). What this
 * guards is the shape behind the rendered frames:
 *
 *   - the BAR says where the lane stands (state · stage k of N · age) and the
 *     body owns the title, once;
 *   - the passed stages before the current one fold into one row that opens
 *     in place;
 *   - the current stage is expanded: who runs it, its attempt, what it last
 *     did, the agent's latest line, and "Open conversation"; the answer to a
 *     decision or a spent review budget sits inside it;
 *   - a waiting stage is one compact row whose ⚙ opens its configuration in a
 *     sheet, the desktop's own editor (lane 10);
 *   - the linked tasks, then "Past attempts · n", which lists the finished
 *     attempts, review rounds and a round's other reviewer transcripts;
 *   - the bar's ⋯ carries the lane's own actions and leads on to the board's.
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
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
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

const stageRow = (host: HTMLElement, id: string) => q(host, `.pb-stage[data-stage="${id}"]`);
const position = (k: number, n: number) => {
  const text = translate("en", "kanban.stages.position", { k, n });
  return text.charAt(0).toLowerCase() + text.slice(1);
};

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

test("the bar says where the lane stands, and the body owns the title once", () => {
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(host, '[data-mobile2-screen="pipeline"]')).not.toBeNull();
  expect(q(host, '[data-mobile2-pipeline="p2"]')).not.toBeNull();
  expect(q(host, "[data-mobile2-back]")).not.toBeNull();

  const meta = q(host, "[data-mobile2-meta]")!;
  expect(q(meta, ".pstate-word")!.textContent).toBe(translate("en", "pipelineState.needs_decision"));
  expect(q(meta, ".pstate-word")!.getAttribute("data-pstate")).toBe("needs_decision");
  /* "stage 3 of 5", the desktop's position words in a meta line, then the age
     with a unit since the lane last moved (the review attempt ended an hour ago). */
  expect(meta.textContent).toBe(`${translate("en", "pipelineState.needs_decision")}·${position(3, 5)}·1h`);
  /* The heading is in view, so the bar does not carry the title as well. */
  expect(q(host, "[data-mobile2-title-text]")).toBeNull();

  const body = q(host, "[data-mobile2-pipeline-body]")!;
  const heading = q(body, "[data-pipeline-heading]")!;
  expect(heading.tagName).toBe("H2");
  expect(heading.textContent).toBe("Fast conversation switching");
  expect(body.textContent!.split("Fast conversation switching").length).toBe(2);
  /* No template or worktree line under the bar (README §4.7, critique P3-3). */
  expect(body.textContent).not.toContain("lane/p2");
  expect(body.textContent).not.toContain("/repo-w");
  expect(q(body, "[data-stages-count]")!.textContent).toBe(`${translate("en", "mobile2.pipeline.stages")}5`);
});

test("Attach is a list row after the stages, a link at its leading edge, and it opens the links sheet (#2148)", () => {
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  const body = q(host, "[data-mobile2-pipeline-body]")!;
  const attach = q(body, '[data-work-links-open="p2"]')!;
  expect(attach.textContent).toBe(translate("en", "workLinks.attach"));
  /* A row of its own, after the stage list and its loop words, never beside
     the heading as bare text. */
  expect(attach.className).toBe("pb-attach");
  expect(attach.firstElementChild?.getAttribute("class")).toContain("pb-attach-icon");
  const block = attach.parentElement!;
  const order = Array.from(block.children).map((child) => child.tagName === "OL" ? "stages" : child === attach ? "attach" : child.className);
  expect(order.indexOf("stages")).toBeLessThan(order.indexOf("attach"));
  expect(order.at(-1)).toBe("attach");
  /* With no link the heading has no empty row under it. */
  expect(q(body, ".pb-links-row")).toBeNull();
  click(attach);
  expect(q(host, '[data-mobile2-links-sheet="p2"]')).not.toBeNull();
});

test("the passed stages before the current one fold into one row, which opens and closes in place", () => {
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  const rows = () => qa(host, ".pb-stage[data-stage]").map((el) => el.getAttribute("data-stage"));
  expect(rows()).toEqual(["review", "fix", "merge"]);
  const fold = q(host, "[data-passed-fold]")!;
  expect(fold.tagName).toBe("BUTTON");
  expect(fold.getAttribute("data-passed-fold")).toBe("2");
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(q(fold, ".pb-num")!.textContent).toBe("1–2");
  expect(q(fold, ".pb-name")!.textContent).toBe(translate("en", "pipelineBlock.passedRow", { count: 2 }));
  expect(q(fold, ".pb-ident-words")!.textContent).toBe("Design · Implement");
  expect(q(fold, '.pmark[data-mark="check"]')).not.toBeNull();

  click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toEqual(["design", "implement", "review", "fix", "merge"]);
  /* The numbers are the stages' places in the chain, folded or not. */
  expect(qa(host, ".pb-stage[data-stage] .pb-num").map((el) => el.textContent)).toEqual(["1", "2", "3", "4", "5"]);
  click(fold);
  expect(rows()).toEqual(["review", "fix", "merge"]);

  /* A lane with one passed stage before the current one has nothing to fold. */
  const one = mount(<MobilePipelineScreen pipeline={runningPipeline()} files={[BUILDING]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(one, "[data-passed-fold]")).toBeNull();
  expect(qa(one, ".pb-stage[data-stage]").map((el) => el.getAttribute("data-stage"))).toEqual(["design", "implement", "review", "fix", "merge"]);
});

test("the decision is answered inside the stage it parked on: its finding, then Skip stage and Retry stage", () => {
  const answered: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={(entry) => answered.push(entry.path)} />);
  const current = q(host, ".pb-stage[data-stage-current]")!;
  expect(current.getAttribute("data-stage")).toBe("review");
  /* The answer and its report live in the stage; nothing above the list answers. */
  expect(qa(host, "[data-answer-action]").every((button) => current.contains(button as never))).toBe(true);
  expect(qa(current, "[data-answer-action]").map((el) => [el.getAttribute("data-answer-action"), el.textContent])).toEqual([
    ["skip-stage", translate("en", "mobile2.pipeline.skip")],
    ["retry-stage", translate("en", "mobile2.pipeline.retry")],
  ]);
  /* The pipeline screen's 44 px buttons, Retry the primary one. */
  expect(q(current, ".pb-actions")!.className).toContain("large");
  expect(q(current, '[data-answer-action="retry-stage"]')!.className).toContain("primary");
  /* The first finding with its rank, then how many more (§3.13). */
  const finding = qa(current, ".stage-findings li");
  expect(finding[0]!.textContent).toContain("the feed cache is dropped");
  expect(finding[1]!.textContent).toBe(translate("en", "kanban.stageReport.moreFindings", { count: 1 }));
  expect(q(current, ".pb-answer .stage-report")!.textContent).toBe(translate("en", "pipelineBlock.reason.failed", { stage: "Review" }) + ` · ${translate("en", "pipelineVerdict.findings", { count: 2 })}`);
  /* Who runs the stage, and its attempt, on the stage's own line. The attempt
     is counted the way every stage label counts it (#1865): the stage's own
     attempts, whatever the record numbered its single one. */
  expect(q(current, ".pb-stage-ident [data-engine-mark]")).not.toBeNull();
  expect(q(current, ".pb-ident-words")!.textContent).toBe(`· ${translate("en", "roleCopy.reviewer.name")} · ${translate("en", "mobile2.pipeline.review")} · ${translate("en", "pipelineBlock.attempt", { n: 1 })}`);
  /* The fail edge's budget rides the failing stage's row, and the loop words under the list. */
  expect(q(current, ".pret")!.textContent).toBe("↺0/3");
  expect(qa(host, ".pb-loops li").map((el) => el.textContent)).toEqual([`↺ ${translate("en", "kanban.loopRest", { from: "Review", to: "Implement", max: 3 })}`]);
  /* Its conversation is one row under the answer. */
  click(q(current, "[data-open-conversation]"));
  expect(answered).toEqual([REVIEW.path]);
});

test("a running stage is expanded with who runs it, what it is doing and its conversation; the waiting stages stay compact", () => {
  const opened: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={runningPipeline()} files={[BUILDING]} now={NOW} onOpenConversation={(entry) => opened.push(entry.path)} />);
  const current = q(host, ".pb-stage[data-stage-current]")!;
  expect(current.getAttribute("data-stage")).toBe("implement");
  expect(current.getAttribute("data-stage-state")).toBe("running");
  expect(q(current, '.pmark[data-mark="dot"][data-live="1"]')).not.toBeNull();
  expect(q(current, ".pb-stage-state")!.textContent).toBe(translate("en", "kanban.graphState.running"));
  expect(q(current, "[data-stage-now]")!.textContent).toBe(translate("en", "kanban.stageReport.line", { who: translate("en", "roleCopy.builder.name"), outcome: translate("en", "kanban.graphState.running"), age: "6m" }));
  expect(q(current, "[data-stage-latest]")!.textContent).toBe("“Checking the fallback path next”");
  expect(q(current, ".pb-ident-words")!.textContent).toBe(`· ${translate("en", "roleCopy.builder.name")} · ${translate("en", "pipelineBlock.attempt", { n: 1 })}`);
  /* The current stage's head is no control of its own: its conversation is the row under it. */
  expect(q(current, ".pb-stage-row")!.tagName).toBe("DIV");
  click(q(current, "[data-open-conversation]"));
  expect(opened).toEqual([BUILDING.path]);
  expect(q(host, "[data-answer-action]")).toBeNull();

  /* Waiting stages: one row each, no body, their ⚙ the way to their settings. */
  for (const id of ["review", "fix", "merge"]) {
    const row = stageRow(host, id)!;
    expect(row.querySelector(".pb-stage-body")).toBeNull();
    expect(row.querySelector("[data-stage-configure]")!.tagName).toBe("BUTTON");
    expect(row.querySelector(".pb-gear")).not.toBeNull();
    expect(q(row, ".pb-stage-state")!.textContent).toBe(translate("en", "kanban.graphState.pending"));
  }
  /* A passed stage with no transcript left in the scan is a statement. */
  expect(q(stageRow(host, "design")!, ".pb-stage-row")!.tagName).toBe("DIV");
});

test("a paused lane holds its stage: a hollow mark and no live tone, still expanded, with Resume in the ⋯; resumed, it is live again (§3.13)", async () => {
  const paused = { ...runningPipeline(), state: "paused", pausedState: "running" } as Pipeline;
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

  const held = q(view, ".pb-stage[data-stage-current]")!;
  expect(held.getAttribute("data-stage")).toBe("implement");
  const mark = q(held, ".pb-stage-title .pmark")!;
  expect(mark.getAttribute("data-mark")).toBe("ring");
  expect(mark.hasAttribute("data-live")).toBe(false);
  expect(mark.className).toContain("tone-idle");
  expect(held.className).toContain("tone-idle");
  expect(held.className).not.toContain("tone-active");
  /* The stage's own state stays in the record; the drawing is the hold's. */
  expect(held.getAttribute("data-stage-state")).toBe("running");
  expect(held.getAttribute("data-stage-held")).toBe("1");
  expect(q(view, '.pmark[data-live="1"]')).toBeNull();
  expect(q(held, ".pb-stage-state")!.textContent).toBe(translate("en", "pipelineState.paused"));
  /* Still the expanded stage: what it last did, in the lane's word, and its conversation. */
  expect(q(held, "[data-stage-now]")!.textContent).toBe(translate("en", "kanban.stageReport.line", { who: translate("en", "roleCopy.builder.name"), outcome: translate("en", "pipelineState.paused"), age: "6m" }));
  expect(q(held, "[data-open-conversation]")).not.toBeNull();
  expect(q(view, "[data-mobile2-meta] .pstate-word")!.getAttribute("data-pstate")).toBe("paused");
  /* Resume is the ⋯'s first row. */
  click(q(view, '[data-mobile2-open="menu"]'));
  await settle();
  expect(Array.from(dom.document.querySelectorAll("[data-mobile2-pipeline-menu] [data-mobile2-pipeline-action]")).map((el) => el.getAttribute("data-mobile2-pipeline-action"))).toEqual(["resume", "archive"]);
  flushSync(() => store.closeSheet());
  await settle();

  /* Resumed: the same stage is live again, in its tone, with the pulse. */
  render(runningPipeline());
  const live = q(view, ".pb-stage[data-stage-current]")!;
  expect(live.hasAttribute("data-stage-held")).toBe(false);
  expect(live.className).toContain("tone-active");
  const pulse = q(live, ".pb-stage-title .pmark")!;
  expect(pulse.getAttribute("data-mark")).toBe("dot");
  expect(pulse.getAttribute("data-live")).toBe("1");
  expect(q(live, ".pb-stage-state")!.textContent).toBe(translate("en", "kanban.graphState.running"));
});

test("every stage that ran opens its own conversation from its row; one whose transcript is gone is a statement", () => {
  const opened: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={(entry) => opened.push(entry.path)} />);
  click(q(host, "[data-passed-fold]"));
  const implement = q(stageRow(host, "implement")!, "[data-stage-open]")!;
  expect(implement.tagName).toBe("BUTTON");
  expect(implement.getAttribute("aria-label")).toStartWith(translate("en", "mobile2.pipeline.openStage", { stage: "Implement" }));
  click(implement);
  expect(opened).toEqual([IMPLEMENT.path]);
  expect(q(stageRow(host, "design")!, "[data-stage-open], [data-stage-configure]")).toBeNull();

  const gone = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[]} now={NOW} onOpenConversation={() => {}} />);
  click(q(gone, "[data-passed-fold]"));
  expect(q(stageRow(gone, "implement")!, ".pb-stage-row")!.tagName).toBe("DIV");
  expect(q(gone, "[data-open-conversation]")).toBeNull();
});

test("a never-run stage's ⚙ opens its configuration in a sheet — the desktop's own editor — Tab stays inside it, and Escape closes only the sheet (lane 10, PR #431, #507 F2)", async () => {
  const store = nav();
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />, store);
  const fix = q(host, '[data-stage-configure="fix"]')!;
  /* The row names what it opens, and then who would run the stage — the marks
     beside it are never the only carrier of that (#1743). */
  expect(fix.getAttribute("aria-label")).toStartWith(translate("en", "mobile2.pipeline.configure", { stage: "Fix" }));
  expect(fix.getAttribute("aria-label")).toContain("Claude");
  expect(fix.getAttribute("aria-haspopup")).toBe("dialog");
  expect(fix.querySelector("[data-engine-mark]")).not.toBeNull();
  /* A stage that ran configures nothing: the engine snapshots its config at
     the first attempt. */
  expect(q(host, '[data-stage-configure="review"]')).toBeNull();

  fix.focus();
  click(fix);
  await settle();
  /* The nav store owns «a sheet is open» (§3.3); the screen says which stage. */
  expect(store.getState().sheet).toBe("stage");
  const sheet = dom.document.querySelector('[data-mobile2-sheet="stage"]') as unknown as HTMLElement | null;
  expect(sheet).not.toBeNull();
  expect(sheet!.textContent).toContain(translate("en", "mobile2.pipeline.configureTitle", { stage: "Fix" }));
  expect(sheet!.querySelector('[data-mobile2-stage-config="fix"] [data-pipeline-stage-card="p2::fix"]')).not.toBeNull();
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

  /* Escape closes the sheet and nothing else; focus returns to the row. */
  flushSync(() => dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never));
  await settle();
  expect(dom.document.querySelector('[data-mobile2-sheet="stage"]')).toBeNull();
  expect(store.getState().sheet).toBeNull();
  expect(q(host, '[data-mobile2-screen="pipeline"]')).not.toBeNull();
  expect(dom.document.activeElement).toBe(fix as never);

  /* A finished pipeline configures nothing: its never-run stages are statements. */
  const done = mount(<MobilePipelineScreen pipeline={parkedPipeline({ state: "completed", cursor: null })} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(done, "[data-stage-configure]")).toBeNull();
  expect(q(stageRow(done, "fix")!, ".pb-stage-row")!.tagName).toBe("DIV");
});

test("a spent review budget is answered inside the review stage: its heads, Close lane and One more round", () => {
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
  const answers = qa(host, "[data-answer-action]");
  expect(answers.map((el) => [el.getAttribute("data-answer-action"), el.textContent])).toEqual([
    ["accept-head", translate("en", "pipelineBlock.answer.acceptAsIs")],
    ["continue-review", translate("en", "pipelineBlock.answer.reviewAgain")],
  ]);
  const stage = answers[0]!.closest(".pb-stage") as unknown as HTMLElement;
  expect(stage.getAttribute("data-stage")).toBe("review");
  expect(stage.getAttribute("data-stage-current")).toBe("1");
  /* One line on why it stopped (#2187 §3.4); the two heads ride its tooltip. */
  const reason = q(stage, "[data-review-stop]")!;
  expect(reason.getAttribute("data-review-stop")).toBe("stop-after-fix");
  expect(reason.textContent).toBe(translate("en", "pipelineBlock.stop.afterFix"));
  expect(reason.getAttribute("title")).toContain("9b2e7d4c");
  /* The lane has no cursor; the bar counts the stage the screen expands, the
     number its row carries. */
  expect(q(host, "[data-mobile2-meta] .pstate-word")!.textContent).toBe(translate("en", "pipelineState.needs_review"));
  expect(q(host, "[data-mobile2-meta]")!.textContent).toContain(position(3, 5));
  expect(q(stage, ".pb-num")!.textContent).toBe("3");
  /* The stage the lane waits on is amber and says the lane's state. */
  expect(stage.className).toContain("tone-needs");
  expect(q(stage, ".pb-stage-state")!.textContent).toBe(translate("en", "pipelineState.needs_review"));
});

test("a completed lane lists every stage with nothing expanded, and says what closed it", () => {
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
    stageReports: [{ seq: 1, stageId: "review", attempt: 1, at: at(1_200), status: "pass", actor: { kind: "agent", role: "reviewer" }, summary: "approved" }],
  } as unknown as Partial<Pipeline>);
  const host = mount(<MobilePipelineScreen pipeline={done} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(host, "[data-mobile2-meta]")!.textContent).toBe(`${translate("en", "pipelineState.completed")}·20m`);
  expect(q(host, "[data-passed-fold]")).toBeNull();
  expect(q(host, ".pb-stage[data-stage-current]")).toBeNull();
  expect(qa(host, ".pb-stage[data-stage]").map((el) => el.getAttribute("data-stage-state"))).toEqual(["passed", "passed", "passed"]);
  expect(q(host, ".pb-note [data-stage-report]")!.getAttribute("data-stage-report-status")).toBe("pass");
  /* The retried stage says which attempt passed. */
  expect(q(stageRow(host, "implement")!, ".pb-ident-words")!.textContent).toContain(translate("en", "pipelineBlock.attempt", { n: 2 }));
  expect(q(host, "[data-answer-action]")).toBeNull();
});

test("«Past attempts · n» comes last: every finished attempt and round, each opening its transcript, and a round's other reviewer binding (lane 10, #353)", () => {
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
  const opened: string[] = [];
  const openedTasks: string[] = [];
  const host = mount(
    <MobilePipelineScreen
      pipeline={pipeline}
      files={[IMPLEMENT, REVIEW_BOUND, PRIOR, PRIOR_REVIEWER]}
      flows={[flow]}
      tasks={[task]}
      now={NOW}
      onOpenConversation={(entry) => opened.push(entry.path)}
      onOpenTask={(picked) => openedTasks.push(picked.id)}
    />,
  );
  const body = q(host, "[data-mobile2-pipeline-body]")!;
  /* The block, the linked tasks, then Past attempts, last. */
  expect(Array.from(body.children).map((el) => (el.matches(".pblock") ? "block" : el.getAttribute("data-mobile2-section") ?? (el.hasAttribute("data-mobile2-past") ? "past" : el.tagName))))
    .toEqual(["block", "tasks", "past"]);
  click(q(host, '[data-mobile2-linked-task="t1"]'));
  expect(openedTasks).toEqual(["t1"]);

  const toggle = q(host, "[data-mobile2-past-toggle]")!;
  /* Design, the two Implement attempts, the Review attempt and its round, and the other binding. */
  expect(toggle.textContent).toBe(translate("en", "kanban.past.head", { count: 6 }));
  expect(toggle.className).toContain("min-h-11");
  expect(q(host, "[data-mobile2-past-row]")).toBeNull();
  click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  const prior = q(host, '[data-mobile2-past-row="p2:implement:attempt:1"]')!;
  expect(prior.tagName).toBe("BUTTON");
  expect(prior.className).toContain("min-h-11");
  expect(prior.textContent).toContain(translate("en", "kanban.past.attempt", { stage: "Implement", n: 1 }));
  click(prior);
  expect(opened).toEqual([PRIOR.path]);

  const round = q(host, '[data-mobile2-past-row="p2:review:attempt:3:round:3"]')!;
  expect(round.textContent).toContain(translate("en", "kanban.past.verdict.REQUEST_CHANGES"));
  const binding = q(host, `[data-mobile2-past-row="p2:review:transcript:${PRIOR_REVIEWER.path}"]`)!;
  expect(binding.textContent).toContain(translate("en", "mobile2.pipeline.reviewTranscript", { n: 3 }));
  click(binding);
  expect(opened).toEqual([PRIOR.path, PRIOR_REVIEWER.path]);

  /* An attempt whose transcript left the scan is a statement, not a dead button. */
  const design = q(host, '[data-mobile2-past-row="p2:design:attempt:1"]')!;
  expect(design.tagName).toBe("DIV");
  expect(design.textContent).toContain(translate("en", "kanban.past.none"));
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
  click(q(host, "[data-passed-fold]"));
  expect(qa(host, ".pb-stage[data-stage] .pb-name").map((el) => el.textContent)).toEqual(["Design", "Implement", "Review", "Fix", "Merge"]);
  expect(q(host, "[data-mobile2-meta] .pstate-word")!.textContent).toBe(translate("uk", "pipelineState.needs_decision"));
  expect(qa(host, "[data-answer-action]").map((el) => el.textContent)).toEqual([translate("uk", "mobile2.pipeline.skip"), translate("uk", "mobile2.pipeline.retry")]);
  expect(q(host, "[data-open-conversation]")!.textContent).toBe(translate("uk", "pipelineBlock.openConversation"));
});
