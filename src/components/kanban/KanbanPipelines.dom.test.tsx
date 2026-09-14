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
      onOpenCatalog={() => {}}
      onOpenOnBoard={() => {}}
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

test("an active pipeline on a workspace card shows its stage graph: nodes with their state, pass edges, the fail edge back with how often it fired, and review rounds", async () => {
  const { host } = mount([searchPipeline()]);
  await tick();
  const section = card(host).querySelector(".stage-section")!;
  expect(section.classList.contains("open")).toBe(true);
  const nodes = [...section.querySelectorAll<HTMLElement>(".pnode")];
  expect(nodes.map((node) => node.dataset.stage)).toEqual(["implement", "review", "verify", "merge"]);
  expect(nodes.map((node) => node.querySelector(".pstate")?.textContent)).toEqual(["passed", "passed", "running", "waiting"]);
  expect(nodes[2]!.className).toContain("tone-active");
  expect(nodes[3]!.getAttribute("aria-disabled")).toBe("true");
  expect(nodes[0]!.querySelector(".pdetail")?.textContent).toBe("attempt 2");
  expect(nodes[2]!.querySelector(".pdetail")?.textContent).toBe("attempt 2 · 2 retries");
  expect([...nodes[1]!.querySelectorAll(".rchip")].map((chip) => chip.textContent)).toEqual(["R1 ✓"]);
  const edges = [...section.querySelectorAll<SVGPathElement>(".pedge")];
  expect(edges.map((edge) => edge.getAttribute("data-edge"))).toEqual(["implement:pass:review", "review:pass:verify", "verify:pass:merge", "verify:fail:implement"]);
  expect(edges[3]!.getAttribute("class")).toContain("fail back taken");
  expect([...section.querySelectorAll(".pelabel")].map((label) => label.textContent)).toEqual(["pass", "fail · retry 1 of 2"]);
});

test("the graph toggles to the one-line summary and back, and a node opens its stage's conversation inside the card, marked selected", async () => {
  const { host } = mount([searchPipeline()]);
  await tick();
  click(card(host).querySelector("[data-graph-toggle]"));
  expect(card(host).querySelector(".pnode")).toBeNull();
  expect([...card(host).querySelectorAll(".psummary .pchip")].map((chip) => chip.getAttribute("data-stage"))).toEqual(["implement", "review", "verify", "merge"]);
  expect(card(host).querySelector(".ploop")?.textContent).toContain("1/2");
  click(card(host).querySelector("[data-graph-toggle]"));
  await tick();
  click(card(host).querySelector('.pnode[data-stage="verify"]'));
  await tick();
  expect(card(host).querySelector("[data-kanban-reader]")?.getAttribute("data-kanban-reader")).toBe("conversation_verify-2");
  expect(card(host).querySelector('.pnode[data-stage="verify"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(card(host).querySelector('.pnode[data-stage="implement"]')?.getAttribute("aria-pressed")).toBe("false");
});

test("a shelf card starts on the summary; Past attempts lists the superseded attempts newest first and opens the one it names", async () => {
  const { host } = mount([searchPipeline()], "blocked");
  await tick();
  expect(card(host).querySelector(".stage-section")?.classList.contains("compact")).toBe(true);
  const past = card(host).querySelector<HTMLDetailsElement>("details.history")!;
  expect(past.querySelector(".hl")?.textContent).toBe("Past attempts · 2");
  expect([...past.querySelectorAll("li .lbl")].map((node) => node.textContent)).toEqual(["Verifier · attempt 1", "Builder · attempt 1"]);
  expect([...past.querySelectorAll("li .verdict")].map((node) => node.textContent)).toEqual(["failed", "passed"]);
  click(past.querySelectorAll("li .hopen")[0]);
  await tick();
  expect(card(host).querySelector("[data-kanban-reader]")?.getAttribute("data-kanban-reader")).toBe("conversation_verify-1");
});

test("an edge is marked live only when a new attempt arrives through it, and the mark does not come from a plain re-render", async () => {
  const { host, render } = mount([searchPipeline()]);
  await tick();
  expect(card(host).querySelector(".pedge.live")).toBeNull();
  render([searchPipeline()]);
  await tick();
  expect(card(host).querySelector(".pedge.live")).toBeNull();
  /* Implement runs a third time, activated by Verify failing. */
  const next = searchPipeline();
  next.runs[0]!.attempts.push(attempt(3, "running", conversation("implement-3"), 10, { activatedBy: { stageId: "verify", attempt: 2, edge: "fail" } }) as never);
  render([next]);
  await tick();
  expect(card(host).querySelector(".pedge.live")?.getAttribute("data-edge")).toBe("verify:fail:implement");
  expect(card(host).querySelector('.pelabel.live')?.textContent).toBe("fail · retry 2 of 2");
});
