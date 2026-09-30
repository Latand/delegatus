import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { LaneRow } from "@/lib/links/laneFeed";
import { setLocale, translate } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { KanbanBoard } from "./KanbanBoard";
import type { TaskMutationPorts } from "./useTaskMutations";

/* A task another machine runs, drawn by the board against the feed the Viewer
   answers (docs/design/synced-task-card.md §5-§7). The feed is scripted; no
   route, no store and no state directory is touched. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const roots: Root[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  setLocale("en");
});

const project = `repo-${"a".repeat(32)}`;
const SELF = "11111111-1111-4111-8111-111111111111";
const STAGE = "22222222-2222-4222-8222-222222222222";
const REMOTE_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_ID = "00000000-0000-4000-8000-000000000002";
const NO_PORTS: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function task(id: string, text: string, extra: Partial<BoardTask> = {}): BoardTask {
  return { id, project, text, status: "assigned", placement: "unplaced", assignments: [], createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z",
    revision: `task-v1:${id}`, ...extra } as BoardTask;
}

type Lane = LaneRow & { peer: string; install: string; stale: boolean; asOf: number };
const lane = (state: LaneRow["s"], over: Partial<Lane> = {}): Lane => ({
  k: "l:5e0a41c2", p: project, tk: [REMOTE_ID], s: state, at: Date.now() - 120_000,
  g: [
    { id: "build", ro: "builder", st: "passed", n: 1, e: "codex", m: "gpt-6.1-sol" },
    { id: "review", ro: "reviewer", st: state === "needs_decision" ? "needs_decision" : "running", n: 2, fc: 2, f: { to: "fix", max: 2, u: 1 }, e: "claude", m: "opus" },
    { id: "fix", ro: "builder", st: "pending", b: 1 },
  ],
  peer: "Stage", install: STAGE, stale: false, asOf: Date.now(), ...over,
});

const feed = (lanes: unknown[], extra: Record<string, unknown> = {}) => ({ agents: [], lanes, self: SELF, hosts: { [STAGE]: { label: "Stage", linked: true } }, ...extra });

async function mount(payload: unknown, tasks: BoardTask[]) {
  globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <KanbanBoard project={project} groups={[]} manual={[]} files={[]} flows={[]} pipelines={[]} tasks={[]} allTasks={tasks} drafts={[]} now={1_800_000_000} loaded
      catalogFailures={0} selection={new Set()} onOpenConversations={() => {}} seatRefs={null} mutationPorts={NO_PORTS} onAddAgent={() => {}} />,
  ));
  await tick();
  return host;
}
const remoteTask = (extra: Partial<BoardTask> = {}) => task(REMOTE_ID, "Ship the synced card", { machine: STAGE, ...extra });
const cardOf = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`.card[data-id="task:${id}"]`);

test("a task another machine runs takes the remote look, names its host where + Agent was, and a local card is untouched", async () => {
  const host = await mount(feed([lane("running")]), [remoteTask(), task(LOCAL_ID, "A local task")]);
  const remote = cardOf(host, REMOTE_ID)!;
  expect(remote.classList.contains("remote")).toBe(true);
  expect(remote.classList.contains("remote-surface")).toBe(true);
  expect(remote.dataset.remote).toBe(STAGE);
  const chip = remote.querySelector<HTMLElement>(".host-chip")!;
  expect(chip.textContent).toBe("Managed on Stage");
  expect(chip.dataset.remoteHost).toBe(STAGE);
  expect(chip.title).toBe(translate("en", "kanban.remote.hint", { host: "Stage" }));
  expect(remote.getAttribute("aria-label")).toContain("Runs on Stage");
  expect(remote.querySelector("[data-add-agent]")).toBeNull();
  const local = cardOf(host, LOCAL_ID)!;
  expect(local.classList.contains("remote")).toBe(false);
  expect(local.querySelector(".host-chip")).toBeNull();
  expect(local.querySelector("[data-add-agent]")).not.toBeNull();
  expect(local.querySelector("[data-pipeline]")).toBeNull();
});

test("the remote lane shows the owner's stages and states in the one chain, with no control inside it", async () => {
  const host = await mount(feed([lane("running")]), [remoteTask()]);
  const block = cardOf(host, REMOTE_ID)!.querySelector<HTMLElement>(".pblock[data-managed]")!;
  expect(block).not.toBeNull();
  expect(block.dataset.pipeline).toBe("5e0a41c2");
  const pills = [...block.querySelectorAll<HTMLElement>(".pb-pill[data-stage]")];
  expect(pills.map((pill) => pill.dataset.stage)).toEqual(["build", "review", "fix"]);
  expect(pills.map((pill) => [...pill.classList].find((name) => name.startsWith("st-")))).toEqual(["st-passed", "st-running", "st-pending"]);
  expect(pills.map((pill) => pill.classList.contains("waiting"))).toEqual([false, false, true]);
  expect(block.querySelector(".pret")?.textContent).toBe("↺1/2");
  expect(block.querySelectorAll("button, a, input, [role=button]")).toHaveLength(0);
  expect(block.querySelector("[data-open-stages]")?.tagName).toBe("SPAN");
  expect(block.querySelector("[data-managed-on]")).toBeNull();
});

test("a lane waiting on a person says where to answer it, with its findings, and draws no answer button", async () => {
  const host = await mount(feed([lane("needs_decision")]), [remoteTask()]);
  const card = cardOf(host, REMOTE_ID)!;
  expect(card.querySelector<HTMLElement>("[data-managed-on]")?.textContent).toBe("Waiting for a decision on Review · 2 findings · answer it on Stage");
  expect(card.querySelectorAll("[data-answer-action], .pb-answer, .pb-act")).toHaveLength(0);
  expect(card.querySelector(".pstate-word")?.textContent).toBe(translate("en", "pipelineState.needs_decision"));
  /* Nothing here can answer it, so the card is not flagged as owing an answer. */
  expect(card.getAttribute("data-attention")).toBeNull();
  expect(card.querySelector("[data-foot-needs]")).toBeNull();
});

test("a stale feed ends the note with when it was last current, and Ukrainian words follow the locale", async () => {
  setLocale("uk");
  const host = await mount(feed([lane("needs_decision", { stale: true, asOf: Date.UTC(2026, 8, 30, 10, 31) })]), [remoteTask()]);
  const note = cardOf(host, REMOTE_ID)!.querySelector<HTMLElement>("[data-managed-on]")!.textContent!;
  expect(note).toContain(translate("uk", "pipelineBlock.remote.decisionTail", { host: "Stage" }));
  expect(note).toMatch(/станом на \d{2}:\d{2}$/);
  expect(cardOf(host, REMOTE_ID)!.querySelector(".host-chip")?.textContent).toBe(translate("uk", "kanban.remote.managedOn", { host: "Stage" }));
});

test("an older peer that sends no lane data renders the card without a scheme and without an error", async () => {
  for (const payload of [feed([]), { agents: [] }, { agents: [], self: SELF }]) {
    const host = await mount(payload, [remoteTask()]);
    const card = cardOf(host, REMOTE_ID)!;
    expect(card).not.toBeNull();
    expect(card.querySelector("[data-pipeline]")).toBeNull();
    if ("self" in payload && "hosts" in payload) expect(card.classList.contains("remote")).toBe(true);
    for (const root of roots.splice(0)) flushSync(() => root.unmount());
    document.body.replaceChildren();
  }
});

test("a lane draws only on a task its sender owns: a forged lane for a local task or another machine's task is ignored", async () => {
  const foreign = lane("running", { install: "33333333-3333-4333-8333-333333333333" });
  const forLocal = lane("running", { k: "l:0badc0de", tk: [LOCAL_ID] });
  const host = await mount(feed([foreign, forLocal]), [remoteTask(), task(LOCAL_ID, "A local task")]);
  expect(cardOf(host, REMOTE_ID)!.querySelector("[data-pipeline]")).toBeNull();
  expect(cardOf(host, LOCAL_ID)!.querySelector("[data-pipeline]")).toBeNull();
  expect(host.querySelectorAll(".pblock[data-managed]")).toHaveLength(0);
});

test("an owner that is no longer linked keeps the remote look and says so", async () => {
  const host = await mount(feed([], { hosts: { [STAGE]: { label: "Stage", linked: false } } }), [remoteTask()]);
  expect(cardOf(host, REMOTE_ID)!.querySelector(".host-chip")?.textContent).toBe("Runs on Stage (not linked)");
});

test("a remote lane that finished keeps its quiet state word and draws neither answer nor note", async () => {
  const host = await mount(feed([lane("completed", { g: [
    { id: "build", ro: "builder", st: "passed", n: 1 }, { id: "review", ro: "reviewer", st: "passed", n: 1 }, { id: "fix", ro: "builder", st: "skipped", b: 1 },
  ] })]), [remoteTask()]);
  const card = cardOf(host, REMOTE_ID)!;
  expect(card.classList.contains("remote")).toBe(true);
  expect(card.querySelector(".pstate-word")?.textContent).toBe(translate("en", "pipelineState.completed"));
  expect(card.querySelector("[data-managed-on]")).toBeNull();
  expect(card.querySelectorAll(".pblock[data-managed] button")).toHaveLength(0);
});
