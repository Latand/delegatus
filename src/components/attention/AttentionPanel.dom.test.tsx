import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * «Waiting for you» (docs/design/needs-you-options.md, option B), mounted the
 * way the Viewer mounts it: the polled files and lanes, with the dismissal
 * layer drawn over them, through the one queue, into the panel. What the
 * operator asked for is what is asserted: the list is grouped by project and
 * nothing in it walks them from project to project; every row names the role
 * of the agent behind it in that role's own emblem and colour; «Dismiss»,
 * «Dismiss all» per project and for everything, and Undo, each go through the
 * one durable dismissal and take the row out of the count at once; and a row
 * whose cause is gone leaves with no dismissal at all.
 */

const dom = new Window({ url: "http://127.0.0.1:8899/" });
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MutationObserver: dom.MutationObserver,
  localStorage: dom.localStorage,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(() => run(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { AttentionPanel } = await import("./AttentionPanel");
const { translate } = await import("@/lib/i18n");
const { buildNeedsYouQueue } = await import("./attentionQueue");
const { resetDismissalOverlayForTests, useDismissalOverlay } = await import("./dismissalOverlay");
type FileEntry = import("@/lib/types").FileEntry;
type Pipeline = import("@/lib/pipelines/types").Pipeline;

const NOW = Math.floor(Date.now() / 1000);
const ALPHA = "repo-alpha";
const BETA = "repo-beta";
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();

function conversation(path: string, project: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    root: "claude-projects", name: path, path, project, title: path.slice(1), engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 60, size: 10, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    conversationId: `conversation_${path.slice(1)}`,
    ...over,
  } as FileEntry;
}

const spawned = (role: string) => ({ durableLineage: { kind: "spawn", role, parentConversationId: null, reviewsConversationId: null, memberships: [] } }) as unknown as Partial<FileEntry>;

function question(header: string, secondsAgo: number): FileEntry["pendingQuestion"] {
  return { kind: "question", toolUseId: `toolu-${header}`, transcriptPath: "", pid: null, paneTarget: null, askedAt: iso(secondsAgo), questions: [{ header, question: `${header}?`, multiSelect: false, options: [] }] } as unknown as FileEntry["pendingQuestion"];
}

function lane(id: string, project: string, state: Pipeline["state"] = "needs_decision"): Pipeline {
  return {
    id, task: `Lane ${id}`, taskIds: [], project, repoDir: "/repo", worktreeDir: "/repo-lane", branch: `lane/${id}`, baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [{ id: "implement", kind: "run", role: { roleId: "builder" } }, { id: "review", kind: "run", role: { roleId: "reviewer" } }],
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "failed", verdict: { status: "fail", findings: ["one"] }, completedAt: iso(1_800) }] }],
    cursor: { stageId: "review", state: "needs_decision", input: null, activatedBy: null },
    state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(7_200), closedAt: null,
  } as unknown as Pipeline;
}

/* alpha, the project on screen: a builder's question, a reviewer's
   permission prompt, a parked lane whose review stage stopped on the
   operator, and the orchestrator seat with two open questions in the report
   log. beta: a planner's plan approval. */
function world() {
  const files: FileEntry[] = [
    conversation("/builder", ALPHA, { ...spawned("builder"), pendingQuestion: question("Base branch", 600) }),
    conversation("/reviewer", ALPHA, {
      ...spawned("reviewer"),
      pendingPermission: { id: "request-1", tool: "Bash", command: "rm -rf .next", reason: null, reasonType: "safetyCheck", since: iso(500) },
    } as Partial<FileEntry>),
    conversation("/seat", ALPHA, {
      bridgeAsks: [
        { id: "ask-limit", at: iso(400), seq: 11, body: "Raise the attachment limit to 100 MB or keep 25?" },
        { id: "ask-digest", at: iso(300), seq: 12, body: "Ship the digest on weekends too?" },
      ],
      bridgeAsk: { id: "ask-digest", at: iso(300), seq: 12, body: "Ship the digest on weekends too?" },
    }),
    conversation("/architect", BETA, { ...spawned("architect"), pendingQuestion: { ...question("plan", 200)!, kind: "plan", questions: [] } as FileEntry["pendingQuestion"] }),
  ];
  return { files, pipelines: [lane("lane-review", ALPHA)] };
}

interface Posted { target: { kind: string; subjects?: Array<Record<string, unknown>> }; undo: boolean; surface: string }
let posted: Posted[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  posted = [];
  resetDismissalOverlayForTests();
  dom.localStorage.clear();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Posted;
    if (String(input).startsWith("/api/attention/dismissals")) {
      posted.push(body);
      const subjects = body.target.subjects ?? [];
      const dismissed = subjects.map((subject) => (subject.kind === "report"
        ? { kind: "report", seq: subject.seq }
        : subject.kind === "pipeline"
          ? { kind: "pipeline", pipelineId: subject.pipelineId }
          : { kind: "conversation", conversationId: subject.conversationId }));
      return new Response(JSON.stringify({ ok: true, dismissed, alreadyClear: [], changed: [], at: new Date().toISOString(), by: { kind: "operator", surface: "desktop" }, undo: body.undo }));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  }) as typeof fetch;
});

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

function Harness({ files, pipelines, current = ALPHA }: { files: FileEntry[]; pipelines: Pipeline[]; current?: string | null }) {
  const layered = useDismissalOverlay(files, pipelines);
  const queue = buildNeedsYouQueue(layered.files, layered.pipelines, NOW, []);
  return (
    <AttentionPanel
      queue={queue}
      current={current}
      projectNames={{ [ALPHA]: "alpha", [BETA]: "beta" }}
      pipelines={layered.pipelines}
      placement="docked"
      canDock
      onPlacement={() => {}}
      onClose={() => {}}
      onOpen={() => {}}
    />
  );
}

async function mount(state = world(), current: string | null = ALPHA): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness files={state.files} pipelines={state.pipelines} current={current} />);
  });
  return host;
}

async function rerender(state: { files: FileEntry[]; pipelines: Pipeline[] }): Promise<void> {
  await act(async () => { root!.render(<Harness files={state.files} pipelines={state.pipelines} />); });
}

const click = (element: Element) => act(async () => {
  element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
  await Bun.sleep(5);
});

const rowIds = (host: HTMLElement) => [...host.querySelectorAll("[data-needs-you-row]")].map((row) => row.getAttribute("data-needs-you-row"));
const title = (host: HTMLElement) => host.querySelector("[data-needs-you-title]")!.textContent;

test("the list is grouped by project, the project on screen first and open, the others folded to their count", async () => {
  const host = await mount();
  const sections = [...host.querySelectorAll("[data-needs-you-section]")];
  expect(sections.map((section) => section.getAttribute("data-needs-you-section"))).toEqual([ALPHA, BETA]);
  expect(sections.map((section) => section.querySelector("[data-needs-you-section-count]")!.textContent)).toEqual(["5", "1"]);
  expect(title(host)).toBe("Waiting for you · 6");
  /* beta is folded: its count shows, its row does not, until it is opened. */
  expect(sections[1]!.hasAttribute("data-folded")).toBe(true);
  expect(sections[1]!.querySelector("[data-needs-you-row]")).toBeNull();
  await click(host.querySelector(`[data-needs-you-fold="${BETA}"]`)!);
  expect(host.querySelector(`[data-needs-you-section="${BETA}"] [data-needs-you-row]`)).not.toBeNull();
  /* The fold is remembered. */
  expect(JSON.parse(dom.localStorage.getItem("llvNeedsYouFolds")!)).toEqual({ [BETA]: false });
  /* Nothing here walks: the panel offers rows, never a Next. */
  expect(host.querySelector("[data-attention-next]")).toBeNull();
  expect(host.textContent).not.toContain("Next");
});

test("on the Overview every project's section is open", async () => {
  const host = await mount(world(), null);
  expect([...host.querySelectorAll("[data-needs-you-section][data-folded]")]).toHaveLength(0);
  expect(rowIds(host)).toHaveLength(6);
});

test("every row carries the role of the agent behind it, in the role palette's own emblem and colour", async () => {
  const host = await mount();
  const roleOf = (selector: string) => {
    const row = host.querySelector(selector)!;
    const tag = row.querySelector("[data-role-tag]")!;
    return { row: row.getAttribute("data-needs-you-role"), tag: tag.getAttribute("data-role"), word: tag.textContent, emblem: Boolean(tag.querySelector(".role-tag-emblem svg")) };
  };
  expect(roleOf('[data-needs-you-row="toolu-Base branch"]')).toEqual({ row: "builder", tag: "builder", word: "Builder", emblem: true });
  expect(roleOf('[data-needs-you-row="/reviewer:permission:request-1"]')).toEqual({ row: "reviewer", tag: "reviewer", word: "Reviewer", emblem: true });
  /* The lane wears the role of the stage it stopped on. */
  expect(roleOf('[data-needs-you-row="lane-review"]')).toEqual({ row: "reviewer", tag: "reviewer", word: "Reviewer", emblem: true });
  /* The orchestrator's questions are the seat's. */
  expect(roleOf('[data-needs-you-row="ask-limit"]')).toEqual({ row: "orchestrator", tag: "orchestrator", word: "Orchestrator", emblem: true });
  /* The colour is the palette's, keyed by `data-role`: the tag draws no colour of its own. */
  expect(host.querySelector('[data-role-tag="builder"]')!.getAttribute("style")).toBeNull();
});

test("each open question in the report log is its own row, the question its title, and dismissing it resolves that report", async () => {
  const host = await mount();
  const rows = ["ask-limit", "ask-digest"].map((id) => host.querySelector(`[data-needs-you-row="${id}"]`)!);
  expect(rows.map((row) => row.querySelector("[data-needs-you-title-line]")!.textContent)).toEqual(["Raise the attachment limit to 100 MB or keep 25?", "Ship the digest on weekends too?"]);
  /* The question is the title; the line says what to do and what happens next. */
  expect(rows.map((row) => row.querySelector("[data-attention-decision]")!.textContent)).toEqual([
    "Answer the orchestrator's question in its conversation; it carries on with your answer.",
    "Answer the orchestrator's question in its conversation; it carries on with your answer.",
  ]);
  await click(host.querySelector('[data-needs-you-dismiss="ask-limit"]')!);
  expect(posted).toEqual([{ target: { kind: "subjects", subjects: [{ kind: "report", seq: 11 }] }, undo: false, surface: "desktop" }]);
  expect(rowIds(host)).not.toContain("ask-limit");
  expect(rowIds(host)).toContain("ask-digest");
  expect(title(host)).toBe("Waiting for you · 5");
});

test("«Dismiss» takes the row out of the count at once, and Undo brings it back through the same record", async () => {
  const host = await mount();
  await click(host.querySelector('[data-needs-you-dismiss="toolu-Base branch"]')!);
  expect(posted[0]).toEqual({
    target: { kind: "subjects", subjects: [{ kind: "conversation", conversationId: "conversation_builder", path: "/builder", reasonId: "toolu-Base branch", reason: "question" }] },
    undo: false,
    surface: "desktop",
  });
  expect(rowIds(host)).not.toContain("toolu-Base branch");
  expect(title(host)).toBe("Waiting for you · 5");

  await click(host.querySelector("[data-needs-you-undo]")!);
  expect(posted[1]).toEqual({ ...posted[0]!, undo: true });
  expect(rowIds(host)).toContain("toolu-Base branch");
  expect(title(host)).toBe("Waiting for you · 6");
  expect(host.querySelector("[data-needs-you-undo]")).toBeNull();
});

test("«Dismiss all» on a section clears that project only; «Dismiss all» in the head clears everything, and Undo takes the whole batch back", async () => {
  const host = await mount();
  await click(host.querySelector(`[data-needs-you-dismiss-section="${ALPHA}"]`)!);
  /* In the section's order: oldest wait first, the lane among the conversations. */
  expect(posted[0]!.target.subjects!.map((subject) => subject.kind)).toEqual(["pipeline", "conversation", "conversation", "report", "report"]);
  expect(host.querySelector(`[data-needs-you-section="${ALPHA}"]`)).toBeNull();
  expect(title(host)).toBe("Waiting for you · 1");

  await click(host.querySelector("[data-needs-you-dismiss-all]")!);
  expect(posted[1]!.target.subjects).toEqual([{ kind: "conversation", conversationId: "conversation_architect", path: "/architect", reasonId: "toolu-plan", reason: "plan" }]);
  expect(title(host)).toBe("Waiting for you · 0");
  expect(host.querySelector("[data-needs-you-empty]")).not.toBeNull();

  /* Undo is for the last dismissal: the head's batch comes back, alpha's stays cleared. */
  await click(host.querySelector("[data-needs-you-undo]")!);
  expect(posted[2]).toEqual({ ...posted[1]!, undo: true });
  expect(title(host)).toBe("Waiting for you · 1");
});

test("the head's «Dismiss all» and a section's read differently, each naming how many rows it clears; Undo appears in the head and moves no row", async () => {
  const host = await mount();
  const head = host.querySelector("[data-needs-you-dismiss-all]")!;
  const section = host.querySelector(`[data-needs-you-dismiss-section="${ALPHA}"]`)!;
  expect(head.textContent).toBe("Dismiss all 6");
  expect(section.textContent).toBe("Dismiss 5");
  expect(head.textContent).not.toBe(section.textContent);
  /* In Ukrainian too. */
  expect(translate("uk", "attention.dismissAll", { count: 6 })).not.toBe(translate("uk", "attention.dismissSection", { count: 5 }));
  expect(translate("uk", "attention.dismissAll", { count: 5 })).not.toBe(translate("uk", "attention.dismissSection", { count: 5 }));

  const body = host.querySelector("[data-needs-you-body]")!;
  const firstRow = () => body.querySelector("[data-needs-you-row]")!;
  const before = rowIds(host);
  await click(host.querySelector(`[data-needs-you-dismiss="${before[0]}"]`)!);
  const undo = host.querySelector("[data-needs-you-undo]")!;
  expect(undo).not.toBeNull();
  expect(body.contains(undo)).toBe(false);
  expect(head.parentElement!.contains(undo)).toBe(true);
  /* The body starts with the rows, as it did before the dismissal. */
  expect(body.firstElementChild!.contains(firstRow())).toBe(true);
});

test("a row whose cause is gone leaves by itself: the question answered, the permission decided, the lane moved on, the report answered", async () => {
  const state = world();
  const host = await mount(state);
  expect(rowIds(host)).toHaveLength(5);
  const [builder, reviewer, seat, architect] = state.files;
  await rerender({
    files: [
      { ...builder!, pendingQuestion: null },
      { ...reviewer!, pendingPermission: null } as FileEntry,
      { ...seat!, bridgeAsks: [seat!.bridgeAsks![0]!], bridgeAsk: seat!.bridgeAsks![0]! },
      architect!,
    ],
    pipelines: [{ ...state.pipelines[0]!, state: "running", cursor: { stageId: "review", state: "running", input: null, activatedBy: null } } as Pipeline],
  });
  expect(rowIds(host)).toEqual(["ask-limit"]);
  expect(title(host)).toBe("Waiting for you · 2");
  expect(posted).toEqual([]);
});

test("a permission prompt answers Allow once or Deny from its row", async () => {
  const host = await mount();
  const row = host.querySelector('[data-needs-you-row="/reviewer:permission:request-1"]')!;
  expect(row.querySelector("[data-attention-decision]")!.textContent).toBe("Allow Bash: rm -rf .next once or deny it; the agent runs it once or changes its approach.");
  expect(row.querySelector("[data-permission-allow]")!.textContent).toBe("Allow once");
  expect(row.querySelector("[data-permission-deny]")).not.toBeNull();
});

test("an agent that asked the operator in prose is a row with its role, the agent's own sentence as the line, and «Dismiss» clears that ask", async () => {
  const state = world();
  const askId = "ask:conversation_explore:claude:msg-7";
  state.files.push(conversation("/explore", BETA, {
    ...spawned("architect"),
    title: "Export formats",
    operatorAsk: { id: askId, messageAt: (NOW - 900) * 1000, gist: "Keep the per-format presets, or fold them into one «Export» button?" },
  } as Partial<FileEntry>));
  const host = await mount(state, null);
  const row = host.querySelector(`[data-needs-you-section="${BETA}"] [data-needs-you-row="${askId}"]`)!;
  expect(row.getAttribute("data-needs-you-role")).toBe("architect");
  const tag = row.querySelector("[data-role-tag]")!;
  expect([tag.getAttribute("data-role"), tag.textContent, Boolean(tag.querySelector(".role-tag-emblem svg"))]).toEqual(["architect", "Architect", true]);
  expect(row.querySelector("[data-needs-you-title-line]")!.textContent).toBe("Export formats");
  expect(row.querySelector("[data-attention-decision]")!.textContent).toBe("The agent asks «Keep the per-format presets, or fold them into one «Export» button?»; reply in its conversation and it continues with your answer.");
  expect(title(host)).toBe("Waiting for you · 7");
  await click(host.querySelector(`[data-needs-you-dismiss="${askId}"]`)!);
  expect(posted).toEqual([{
    target: { kind: "subjects", subjects: [{ kind: "conversation", conversationId: "conversation_explore", path: "/explore", reasonId: askId, reason: "ask" }] },
    undo: false,
    surface: "desktop",
  }]);
  expect(rowIds(host)).not.toContain(askId);
  expect(title(host)).toBe("Waiting for you · 6");
});

test("the update decision is a counted Needs-you row with named blockers and both choices", async () => {
  const decision = { id: "drain", at: new Date().toISOString(), project: ALPHA, blockers: { turns: 1, stages: 0, operatorActiveAt: null, busy: false, memoryMb: null, unreadable: null,
    turnList: [{ conversationId: "conversation_long_turn", engine: "codex", project: ALPHA, stage: null, seat: false }] } };
  const queue = buildNeedsYouQueue([], [], NOW, [], decision);
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<AttentionPanel queue={queue} current={ALPHA} projectNames={{}} pipelines={[]} placement="docked" canDock
    onPlacement={() => {}} onClose={() => {}} onOpen={() => {}} />));
  // The turn is named by what it is; its id stays off the screen.
  expect(host.textContent).toContain("Codex agent");
  expect(host.textContent).not.toContain("conversation_long_turn");
  expect(host.querySelector('[data-action="deploy-now"]')).not.toBeNull();
  expect(host.querySelector('[data-action="keep-waiting"]')).not.toBeNull();
  expect(host.querySelector('[data-needs-you-dismiss-all]')).toBeNull();
});

test("a waiting prototype review is a counted row that opens its task's review and offers no «Dismiss»", async () => {
  const boardTask = { id: "task-layout", project: ALPHA, status: "inbox", placement: "unplaced", text: "Tidy the card menu\nThree items moved.", assignments: [], createdAt: "", updatedAt: "",
    prototypeReview: { latestReviewId: "pr_1", waitingReviewId: "pr_1", title: "Card menu layout", rounds: 1, createdAt: new Date((NOW - 120) * 1000).toISOString() } } as unknown as BoardTask;
  const queue = buildNeedsYouQueue([], [], NOW, [], undefined, [boardTask]);
  const opened: string[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<AttentionPanel queue={queue} current={ALPHA} projectNames={{}} pipelines={[]} placement="docked" canDock
    onPlacement={() => {}} onClose={() => {}} onOpen={(entry) => opened.push(entry.id)} />));
  expect(title(host)).toContain("1");
  expect(rowIds(host)).toEqual(["prototype:pr_1"]);
  const row = host.querySelector('[data-needs-you-row="prototype:pr_1"]')!;
  // The row names the task the jump lands on, by its first line.
  expect(row.textContent).toContain("Tidy the card menu");
  expect(row.textContent).not.toContain("Three items moved");
  expect(row.textContent).toContain("Prototype ready");
  expect(host.querySelector("[data-needs-you-dismiss]")).toBeNull();
  expect(host.querySelector("[data-needs-you-dismiss-all]")).toBeNull();
  expect(host.querySelector("[data-needs-you-dismiss-section]")).toBeNull();
  await click(host.querySelector('[data-attention-prototype="task-layout"]')!);
  expect(opened).toEqual(["prototype:pr_1"]);
});


test("a questionnaire waiting row asks for an answer", async () => {
  const notice = { id: "prototype:questions", taskId: "task-layout", reviewId: "questions", project: ALPHA, title: "Before work", asks: "questions" as const, createdAt: new Date().toISOString(), target: { kind: "prototype-review" as const, taskId: "task-layout", reviewId: "questions" } };
  const host = document.createElement("div"); document.body.appendChild(host);
  await act(async () => { root = createRoot(host); root.render(<AttentionPanel queue={[{ kind: "prototype", id: notice.id, notice }]} current={ALPHA} projectNames={{ [ALPHA]: "alpha" }} pipelines={[]} placement="docked" canDock onPlacement={() => {}} onClose={() => {}} onOpen={() => {}} />); });
  expect(host.textContent).toContain("Questions for you");
  expect(host.querySelector("[data-attention-decision]")?.textContent).toBe("Answer the questions in the form; the project orchestrator receives your answers and carries them on.");
  expect(host.querySelector("[data-attention-prototype]")?.getAttribute("aria-label")).toBe("Answer the questions for «Before work»");
});

/*
 * «Готово» (docs/design/done-section.md §4.3, §5): finished work waits in the
 * same panel, below the decisions, until the operator accepts it. The read
 * and the acknowledgement go through the real client store against a route
 * double that records them the way the server does.
 */

const { refreshDoneItems, resetDoneItemsForTests, useDoneItems } = await import("./doneItems");
type DoneItemV1 = import("@/lib/done/types").DoneItemV1;

function doneItem(key: string, over: Partial<DoneItemV1> = {}): DoneItemV1 {
  return {
    key, kind: "pr", look: "technical", project: ALPHA, at: iso(600), createdAt: iso(600), title: `Item ${key}`, icon: null, refs: {},
    frame: null, frameCheckedAt: iso(600), acknowledgedAt: null, acknowledgedBy: null, ...over,
  };
}

const pr = (number: number) => ({ repository: "acme/widgets", number, url: `https://github.com/acme/widgets/pull/${number}` });

function doneWorld(): DoneItemV1[] {
  return [
    doneItem("pr:acme/widgets#2691", { look: "visible", at: iso(900), title: "Landing cards no longer show through each other", refs: { pr: pr(2691), pipelineId: "lane-landing" },
      frame: { src: "/api/image?taskId=t&prototype=r&media=after", before: "/api/image?taskId=t&prototype=r&media=before", caption: "Landing" } }),
    doneItem("deploy:d1", { kind: "deploy", look: "deploy", project: null, at: iso(300), title: "", refs: { deploymentId: "d1", sha: "1c41d361".padEnd(40, "0"), phase: "succeeded" } }),
    doneItem("pr:acme/widgets#2698", { at: iso(700), title: "Account removal checks the file on disk first", icon: "user-x", refs: { pr: pr(2698) } }),
    doneItem("pr:acme/widgets#2699", { at: iso(650), title: "Agent messages arrive during cleanup", icon: "send", refs: { pr: pr(2699) } }),
    doneItem("task:t-closed", { kind: "task", look: "closed", at: iso(500), title: "Removed the empty hidden tray", project: BETA }),
    doneItem("limit:codex:acct-b:session:1", { kind: "limit", look: "limit", project: null, at: iso(1_200), title: "",
      refs: { account: { engine: "codex", accountId: "acct-b", window: "session", label: "B" }, limit: { from: iso(1_200), to: iso(400), lanes: 3 } } }),
  ];
}

interface Acknowledged { keys: string[]; undo: boolean; surface: string }
let doneServer: DoneItemV1[] = [];
let acknowledged: Acknowledged[] = [];

function serveDone(): void {
  const dismissals = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("/api/attention/done")) {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ ok: true, items: doneServer.filter((item) => !item.acknowledgedAt), revision: 1 }));
      const body = JSON.parse(String(init!.body)) as Acknowledged;
      acknowledged.push(body);
      const changed = doneServer.filter((item) => body.keys.includes(item.key) && Boolean(item.acknowledgedAt) === body.undo);
      for (const item of changed) item.acknowledgedAt = body.undo ? null : new Date().toISOString();
      return new Response(JSON.stringify({ ok: true, changed }));
    }
    return dismissals(input, init);
  }) as typeof fetch;
}

function DoneHarness({ files, pipelines, current = ALPHA }: { files: FileEntry[]; pipelines: Pipeline[]; current?: string | null }) {
  const layered = useDismissalOverlay(files, pipelines);
  const queue = buildNeedsYouQueue(layered.files, layered.pipelines, NOW, []);
  const done = useDoneItems();
  return (
    <AttentionPanel queue={queue} current={current} projectNames={{ [ALPHA]: "alpha", [BETA]: "beta" }} pipelines={layered.pipelines}
      placement="docked" canDock onPlacement={() => {}} onClose={() => {}} onOpen={() => {}} done={done} />
  );
}

async function mountDone(state = world(), current: string | null = ALPHA): Promise<HTMLElement> {
  resetDoneItemsForTests();
  acknowledged = [];
  serveDone();
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<DoneHarness files={state.files} pipelines={state.pipelines} current={current} />);
  });
  await act(async () => { await Bun.sleep(10); });
  return host;
}

const doneRows = (host: HTMLElement) => [...host.querySelectorAll("[data-done-row], [data-done-group], [data-done-receipt], [data-done-group-receipt]")].map((row) => {
  if (row.hasAttribute("data-done-row")) return row.getAttribute("data-done-row");
  if (row.hasAttribute("data-done-receipt")) return `receipt:${row.getAttribute("data-done-receipt")}`;
  return `group:${row.getAttribute("data-done-group") ?? row.getAttribute("data-done-group-receipt")}`;
});

test("«Готово» is pinned above the decisions, newest first, and the panel's title counts both", async () => {
  doneServer = doneWorld();
  const host = await mountDone();
  const body = host.querySelector("[data-needs-you-body]")!;
  const section = host.querySelector("[data-done-section]")!;
  /* Under the head and outside the decisions' scroller, so it never scrolls away. */
  expect(body.contains(section)).toBe(false);
  expect(section.nextElementSibling).toBe(body);
  expect(section.getAttribute("data-done-place")).toBe("needs-you");
  expect(section.querySelector("[data-done-list]")!.className).toContain("overflow-y-auto");
  expect(title(host)).toBe("Waiting for you · 12");
  expect(section.querySelector("[data-done-count]")!.textContent).toBe("6");
  expect(section.querySelector("[data-done-accept-all]")!.textContent).toBe("Seen all");
  /* «Dismiss all» still counts the decisions it clears. */
  expect(host.querySelector("[data-needs-you-dismiss-all]")!.textContent).toBe("Dismiss all 6");
  /* Newest first: a row at its own time, a group at its newest member's. */
  expect([...section.querySelectorAll("[data-done-row], [data-done-group]")].map((row) => row.getAttribute("data-done-row") ?? row.getAttribute("data-done-group")))
    .toEqual(["deploy:d1", "closed", "technical", "pr:acme/widgets#2691", "limit:codex:acct-b:session:1"]);
  const deploy = section.querySelector('[data-done-row="deploy:d1"]')!;
  expect(deploy.querySelector("[data-done-sentence]")!.textContent).toBe("Delegatus was updated");
  expect(deploy.querySelector("[data-done-meta]")!.textContent).toMatch(/^deploy · \d/);
  /* A row's check ends its first line: no row keeps a line for a button. */
  expect(deploy.lastElementChild).toBe(deploy.querySelector("[data-done-accept]"));
  expect(deploy.querySelector("[data-done-accept]")!.textContent).toBe("");
  const limit = section.querySelector('[data-done-row="limit:codex:acct-b:session:1"]')!;
  expect(limit.querySelector("[data-done-sentence]")!.textContent).toBe("Codex B limit · 5h window");
  expect(limit.querySelector("[data-done-meta]")!.textContent).toContain("3 lanes waited.");
  const visible = section.querySelector('[data-done-row="pr:acme/widgets#2691"]')!;
  expect(visible.querySelector("[data-done-pr]")!.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/2691");
  expect(visible.querySelector("[data-done-meta]")!.textContent).toMatch(/^#2691 · merged /);
  /* A row of another project names it first. */
  await click(section.querySelector('[data-done-group-toggle="closed"]')!);
  expect(section.querySelector('[data-done-member="task:t-closed"]')!.textContent).toContain("beta · Removed the empty hidden tray");
});

test("«Accept» takes a row out of every count at once and leaves «… · accepted» with Undo, which takes it back", async () => {
  doneServer = doneWorld();
  const host = await mountDone();
  await click(host.querySelector('[data-done-accept="deploy:d1"]')!);
  expect(acknowledged).toEqual([{ keys: ["deploy:d1"], undo: false, surface: "desktop" }]);
  expect(title(host)).toBe("Waiting for you · 11");
  expect(host.querySelector("[data-done-count]")!.textContent).toBe("5");
  const receipt = host.querySelector('[data-done-receipt="deploy:d1"]')!;
  expect(receipt.textContent!.replace(/\u00a0/g, " ")).toContain("Delegatus was updated · accepted");
  /* The mark is its own run that never breaks. */
  /* The «·» is bound to the name, so a wrapped receipt never starts a line with it. */
  expect(receipt.querySelector("[data-done-receipt-text]")!.lastElementChild!.textContent).toBe("accepted");
  expect(receipt.querySelector("[data-done-receipt-text]")!.textContent).toBe("Delegatus was updated\u00a0· accepted");
  /* In its place: the row it replaced was the newest, first. */
  expect(doneRows(host)).toEqual(["receipt:deploy:d1", "group:closed", "group:technical", "pr:acme/widgets#2691", "limit:codex:acct-b:session:1"]);
  await click(receipt.querySelector("[data-done-undo]")!);
  expect(acknowledged[1]).toEqual({ keys: ["deploy:d1"], undo: true, surface: "desktop" });
  expect(title(host)).toBe("Waiting for you · 12");
  expect(host.querySelector('[data-done-row="deploy:d1"]')).not.toBeNull();
});

test("a group accepts whole with one button, opens to its members, and a member accepted alone keeps its line with a filled check", async () => {
  doneServer = doneWorld();
  const host = await mountDone();
  const group = () => host.querySelector('[data-done-group="technical"]')!;
  expect(group().querySelector("[data-done-group-title]")!.textContent).toBe("Technical fixes · 2");
  expect(group().querySelector("[data-done-group-line]")!.textContent).toBe("Agent messages arrive, account removal checks");
  await click(group().querySelector('[data-done-group-toggle="technical"]')!);
  /* Open, the members say it themselves: the head repeats none of them. */
  expect(group().querySelector("[data-done-group-line]")).toBeNull();
  const member = () => group().querySelector('[data-done-member="pr:acme/widgets#2698"]')!;
  expect(member().querySelector("[data-done-pr]")!.textContent).toBe("#2698");
  await click(member().querySelector("[data-done-member-check]")!);
  expect(acknowledged).toEqual([{ keys: ["pr:acme/widgets#2698"], undo: false, surface: "desktop" }]);
  expect(group().querySelector("[data-done-group-title]")!.textContent).toBe("Technical fixes · 1 of 2");
  expect(group().querySelector("[data-done-group-line]")!.textContent).toBe("1 accepted");
  expect(member().hasAttribute("data-done-accepted")).toBe(true);
  expect(member().querySelector("[data-done-member-check]")!.getAttribute("aria-pressed")).toBe("true");
  expect(group().querySelector('[data-done-accept-group="technical"]')!.textContent).toBe("1");
  expect(group().querySelector('[data-done-accept-group="technical"]')!.getAttribute("aria-label")).toBe("Technical fixes: Accept 1");
  await click(group().querySelector('[data-done-accept-group="technical"]')!);
  expect(acknowledged[1]).toEqual({ keys: ["pr:acme/widgets#2699"], undo: false, surface: "desktop" });
  expect(host.querySelector('[data-done-group-receipt="technical"]')!.textContent!.replace(/\u00a0/g, " ")).toContain("Technical fixes: 2 accepted");
  expect(title(host)).toBe("Waiting for you · 10");
});

test("a collapsed group lists short topics while they fit and ends in «and N more», never a cut word", async () => {
  doneServer = [
    doneItem("pr:acme/widgets#1", { at: iso(100), title: "Automerge waits only for the required checks on main." }),
    doneItem("pr:acme/widgets#2", { at: iso(110), title: "HTTP MCP keeps its identity after a migration; a cancelled client touches no other." }),
    doneItem("pr:acme/widgets#3", { at: iso(120), title: "The merger accepts test contracts the review agreed." }),
    doneItem("pr:acme/widgets#4", { at: iso(130), title: "Account settings are read for the project they belong to." }),
    doneItem("pr:acme/widgets#5", { at: iso(140), title: "Backend tests run in isolated state." }),
  ];
  const host = await mountDone();
  const line = host.querySelector('[data-done-group="technical"] [data-done-group-line]')!;
  expect(line.textContent).toBe("Automerge waits, HTTP MCP keeps and 3 more");
  expect(line.lastElementChild!.textContent).toBe("and 3 more");
  expect(line.textContent).not.toContain("…");
});

test("a Ukrainian topic never ends on an adjective without its noun", async () => {
  const { groupTopics } = await import("./DoneSection");
  const uk = ((key, params) => translate("uk", key, params)) as Parameters<typeof groupTopics>[0];
  const { topics, more } = groupTopics(uk, "uk", [
    doneItem("task:one", { kind: "task", look: "closed", title: "Прибрано порожній лоток прихованих" }),
    doneItem("pr:acme/widgets#2", { title: "Мерджер приймає тестові контракти, які погодило рев’ю." }),
    doneItem("pr:acme/widgets#3", { title: "Аналіз моделей для голосового режиму" }),
  ]);
  expect(topics).toBe("Прибрано порожній лоток, мерджер приймає");
  expect(more).toBe("і ще 1");
});

test("a new outcome arrives at the top of the list, a technical one with its group", async () => {
  doneServer = doneWorld();
  const host = await mountDone();
  const order = () => [...host.querySelectorAll("[data-done-section] [data-done-row], [data-done-section] [data-done-group]")].map((row) => row.getAttribute("data-done-row") ?? row.getAttribute("data-done-group"));
  expect(order()[0]).toBe("deploy:d1");
  doneServer.push(doneItem("report:r-new", { kind: "report", look: "incident", at: iso(60), title: "A lane stalled and was restarted" }));
  await act(async () => { await refreshDoneItems(); });
  expect(order()[0]).toBe("report:r-new");
  doneServer.push(doneItem("pr:acme/widgets#2750", { at: iso(30), title: "Retries wait for the lock", refs: { pr: pr(2750) } }));
  await act(async () => { await refreshDoneItems(); });
  expect(order().slice(0, 2)).toEqual(["technical", "report:r-new"]);
  expect(host.querySelector('[data-done-group="technical"] [data-done-group-line]')!.textContent).toMatch(/^Retries wait/);
});

test("the head folds the list to «Done · N» and remembers it; «Seen all» still works folded", async () => {
  doneServer = doneWorld();
  let host = await mountDone();
  const fold = () => host.querySelector<HTMLElement>("[data-done-fold]")!;
  expect(fold().getAttribute("aria-expanded")).toBe("true");
  await click(fold());
  expect(fold().getAttribute("data-done-fold")).toBe("folded");
  expect(host.querySelector("[data-done-list]")).toBeNull();
  expect(host.querySelector("[data-done-count]")!.textContent).toBe("6");
  expect(dom.localStorage.getItem("llvDoneFolded:needs-you:desktop")).toBe("1");
  /* Another mount on this device opens folded. */
  await act(async () => { root?.unmount(); });
  root = null;
  host = await mountDone();
  expect(fold().getAttribute("data-done-fold")).toBe("folded");
  await click(host.querySelector("[data-done-accept-all]")!);
  expect(acknowledged[0]!.keys).toHaveLength(6);
  expect(title(host)).toBe("Waiting for you · 6");
  await click(fold());
  expect(host.querySelector("[data-done-all-accepted]")).not.toBeNull();
});

test("«Accept all» leaves only the decisions in the count, and one receipt takes the whole batch back", async () => {
  doneServer = doneWorld();
  const host = await mountDone();
  await click(host.querySelector("[data-done-accept-all]")!);
  expect(acknowledged[0]!.keys.sort()).toEqual(doneWorld().map((item) => item.key).sort());
  expect(title(host)).toBe("Waiting for you · 6");
  expect(host.querySelector("[data-done-accept-all]")).toBeNull();
  const all = host.querySelector("[data-done-all-accepted]")!;
  expect(all.textContent).toContain("All accepted · 6 items");
  await click(all.querySelector("[data-done-undo]")!);
  expect(acknowledged[1]!.undo).toBe(true);
  expect(title(host)).toBe("Waiting for you · 12");
});

test("a thumbnail opens the image viewer with the before and after of its frame", async () => {
  doneServer = doneWorld();
  const host = await mountDone();
  await click(host.querySelector('[data-done-thumb="pr:acme/widgets#2691"]')!);
  const lightbox = document.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(lightbox).not.toBeNull();
  expect([...lightbox.querySelectorAll("img[data-lightbox-side]")].map((image) => image.getAttribute("src")).sort())
    .toEqual(["/api/image?taskId=t&prototype=r&media=after", "/api/image?taskId=t&prototype=r&media=before"]);
  expect(lightbox.querySelector('[data-lightbox-compare-side="before"]')!.textContent).toBe("Original");
  await act(async () => { lightbox.querySelector<HTMLElement>('button[aria-label="Close"]')!.click(); });
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
});

test("lost and evicted done frames show a clear placeholder and leave acceptance available",async () => {
  doneServer=[doneItem("pr:lost",{look:"visible",frame:{src:"/api/image?done=lost",caption:"Result",unavailable:true}}),doneItem("pr:evicted",{look:"visible",frame:{src:"/api/image?done=evicted",caption:"Result"}})];
  const host=await mountDone();
  expect(host.querySelector('[data-done-frame-missing="pr:lost"]')?.textContent).toBe("Frames were not retained");
  expect(host.querySelector('[data-done-thumb="pr:lost"]')).toBeNull();
  const image=host.querySelector('[data-done-thumb="pr:evicted"] img')!;
  await act(async()=>{image.dispatchEvent(new Event("error"));});
  expect(host.querySelector('[data-done-frame-missing="pr:evicted"]')?.textContent).toBe("Frames were not retained");
  expect(host.querySelector('[data-done-thumb="pr:evicted"]')).toBeNull();
  await click(host.querySelector('[data-done-accept="pr:lost"]')!);
  expect(host.querySelector('[data-done-receipt="pr:lost"]')).not.toBeNull();
});

test("an empty «Готово» draws nothing, and «Nothing is waiting» shows only when both are empty", async () => {
  doneServer = [];
  const host = await mountDone({ files: [], pipelines: [] });
  expect(host.querySelector("[data-done-section]")).toBeNull();
  expect(host.querySelector("[data-needs-you-empty]")).not.toBeNull();
  await act(async () => { root?.unmount(); });
  doneServer = [doneItem("task:t-only", { kind: "task", look: "closed" })];
  const other = await mountDone({ files: [], pipelines: [] });
  expect(other.querySelector("[data-needs-you-empty]")).toBeNull();
  expect(title(other)).toBe("Waiting for you · 1");
});

test("a read that left before an acceptance never brings the row back, nor one that left before its Undo", async () => {
  resetDoneItemsForTests();
  const { acknowledgeDone, refreshDoneItems } = await import("./doneItems");
  const item = doneItem("task:one", { kind: "task", look: "closed" });
  let waiting: DoneItemV1[] = [item];
  let revision = 1;
  /* Each read answers what the server held when it arrived, and is let go by hand. */
  const held: Array<() => void> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init!.body)) as Acknowledged;
      waiting = body.undo ? [item] : [];
      revision += 1;
      return new Response(JSON.stringify({ ok: true, changed: [item] }));
    }
    const answer = JSON.stringify({ ok: true, items: waiting, revision });
    return new Promise<Response>((resolve) => { held.push(() => resolve(new Response(answer))); });
  }) as typeof fetch;
  function Probe() {
    const items = useDoneItems(false);
    return <span data-probe>{items.map((entry) => entry.key).join(",")}</span>;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => { root = createRoot(host); root.render(<Probe />); });
  const shown = () => host.querySelector("[data-probe]")!.textContent;
  const release = async (index: number) => { await act(async () => { held[index]!(); await Bun.sleep(5); }); };

  void refreshDoneItems();
  await release(0);
  expect(shown()).toBe("task:one");
  /* A poll leaves at revision 1, the operator accepts, the confirming read lands first. */
  void refreshDoneItems();
  await act(async () => { await acknowledgeDone([item], { surface: "desktop" }); });
  expect(shown()).toBe("");
  await release(2);
  expect(shown()).toBe("");
  await release(1);
  expect(shown()).toBe("");
  /* The same ordering around Undo. */
  void refreshDoneItems();
  await act(async () => { await acknowledgeDone([item], { undo: true, surface: "desktop" }); });
  expect(shown()).toBe("task:one");
  await release(4);
  expect(shown()).toBe("task:one");
  await release(3);
  expect(shown()).toBe("task:one");
});
