import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

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
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  localStorage: dom.localStorage,
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
  expect(rows.map((row) => row.querySelector("[data-attention-decision]")!.textContent)).toEqual(["Question", "Question"]);
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
  expect(row.querySelector("[data-attention-decision]")!.textContent).toBe("permission: Bash: rm -rf .next");
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
  expect(row.querySelector("[data-attention-decision]")!.textContent).toBe("asks you: Keep the per-format presets, or fold them into one «Export» button?");
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
