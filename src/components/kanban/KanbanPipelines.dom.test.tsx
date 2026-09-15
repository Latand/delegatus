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
  const section = () => card(host).querySelector(".stage-section")!;
  expect(section().classList.contains("compact")).toBe(true);
  expect(card(host).querySelector(".pnode")).toBeNull();
  expect(toggle(host)?.getAttribute("aria-pressed")).toBe("false");
  expect([...card(host).querySelectorAll(".psummary .pchip")].map((chip) => chip.getAttribute("data-stage"))).toEqual(["implement", "review", "verify", "merge"]);
  expect(card(host).querySelector(".ploop")?.textContent).toContain("1/2");
  click(toggle(host));
  await tick();
  expect(section().classList.contains("open")).toBe(true);
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
  const section = card(host).querySelector(".stage-section")!;
  const nodes = [...section.querySelectorAll<HTMLElement>(".pnode")];
  expect(nodes.map((node) => node.dataset.stage)).toEqual(["implement", "review", "verify", "merge"]);
  expect(nodes.map((node) => node.querySelector(".pstate")?.textContent)).toEqual(["passed", "passed", "running", "waiting"]);
  expect(nodes[2]!.className).toContain("tone-active");
  /* A waiting stage opens its first message (K5b), so its node is a live control. */
  expect(nodes[3]!.getAttribute("aria-disabled")).toBeNull();
  expect(nodes[3]!.getAttribute("aria-label")).toContain("Open its first message");
  expect(nodes[0]!.querySelector(".pdetail")?.textContent).toBe("attempt 2");
  expect(nodes[2]!.querySelector(".pdetail")?.textContent).toBe("attempt 2 · 2 retries");
  expect([...nodes[1]!.querySelectorAll(".rchip")].map((chip) => chip.textContent)).toEqual(["R1 ✓"]);
  const edges = [...section.querySelectorAll<SVGPathElement>(".pedge")];
  expect(edges.map((edge) => edge.getAttribute("data-edge"))).toEqual(["implement:pass:review", "review:pass:verify", "verify:pass:merge", "verify:fail:implement"]);
  expect(edges[3]!.getAttribute("class")).toContain("fail back taken");
  expect([...section.querySelectorAll(".pelabel")].map((label) => label.textContent)).toEqual(["pass", "fail · retry 1 of 2"]);
});

test("with a helper conversation adopted last on Implement, the graph keeps the engine's budget and attempt count, and the node a click opens is the one marked", async () => {
  const helper = conversation("implement-helper");
  files.push(helper);
  try {
    const record = searchPipeline();
    record.runs[0]!.attempts.push(helperAttempt(3, helper, 3000) as never);
    const { host } = mount([record]);
    await tick();
    /* The summary's loop chip reads the same budget. */
    expect(card(host).querySelector(".ploop")?.textContent).toContain("· 1/2");
    click(toggle(host));
    await tick();
    expect([...card(host).querySelectorAll(".pelabel")].map((label) => label.textContent)).toEqual(["pass", "fail · retry 1 of 2"]);
    expect(card(host).querySelector('.pnode[data-stage="implement"] .pdetail')?.textContent).toBe("attempt 2");
    click(card(host).querySelector('.pnode[data-stage="implement"]'));
    await tick();
    expect(card(host).querySelector("[data-kanban-reader]")?.getAttribute("data-kanban-reader")).toBe("conversation_implement-2");
    expect(card(host).querySelector('.pnode[data-stage="implement"]')?.getAttribute("aria-pressed")).toBe("true");
    /* The helper stays reachable, listed as what it is. */
    const helpers = [...card(host).querySelectorAll('details.history [data-past-kind="helper"] .lbl')].map((node) => node.textContent);
    expect(helpers).toEqual(["Builder · helper conversation 1"]);
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
  expect(labels.sort()).toEqual(["Builder · attempt 1", "Builder · attempt 2", "Reviewer · attempt 1", "Reviewer · round 1", "Verifier · attempt 1"]);
  expect(past.querySelector(".hl")?.textContent).toBe("Past attempts · 5");
  expect(labels).not.toContain("Verifier · attempt 2");
  const verify = [...past.querySelectorAll("li")].find((row) => row.querySelector(".lbl")?.textContent === "Verifier · attempt 1")!;
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
  expect(card(host).querySelector(".pelabel.live")?.textContent).toBe("fail · retry 2 of 2");

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
  expect([...review.querySelectorAll(".rchip")].map((chip) => chip.textContent)).toEqual(["+4", "R5 ✓"]);
  expect(review.querySelector(".rchip.more")?.getAttribute("title")?.split("\n")).toEqual(["Round 1: changes requested", "Round 2: changes requested", "Round 3: changes requested", "Round 4: changes requested"]);
  expect(review.getAttribute("aria-label")).toContain("Round 1: changes requested, Round 2: changes requested, Round 3: changes requested, Round 4: changes requested, Round 5: approved");
});

test("a summary chip is a control only when the stage's latest own attempt has a conversation to open: not while that attempt is still spawning", async () => {
  const record = searchPipeline();
  record.runs[2]!.attempts.push(attempt(3, "spawning", null, 1, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } }) as never);
  const { host } = mount([record]);
  await tick();
  const chip = (stage: string) => card(host).querySelector<HTMLElement>(`.psummary [data-stage="${stage}"]`)!;
  expect(chip("verify").tagName).toBe("SPAN");
  expect(chip("implement").tagName).toBe("BUTTON");
});
