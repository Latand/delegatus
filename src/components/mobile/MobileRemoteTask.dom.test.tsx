import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import type { LaneRow } from "@/lib/links/laneFeed";
import type { BoardTask } from "@/lib/tasks/types";
import type { SchemeLayout } from "@/components/scheme/layout";

import { MobileKanban } from "./MobileKanban";
import { MobileTaskScreen } from "./MobileTaskScreen";
import { createMobileNav, MobileNavContext } from "./mobileNav";
import { fakeHistory } from "./mobileNavTestHistory";
import { receipts } from "./MobileReceipt";
import { resetPhoneKanbanPlaces } from "./phoneKanbanPlace";

/*
 * A task another machine runs, on the phone (docs/design/synced-task-card.md
 * §8): the board card keeps to one button and gains its lane line and a
 * passive host line; the task screen draws each remote lane in the frame a
 * finished lane uses, with no control, and names the host where "+ Agent" was.
 * The feed is scripted; happy-dom lays nothing out, so the geometry is the
 * browser driver's.
 */

const NOW = 1_800_000_000;
const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Element: dom.Element,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, FocusEvent: dom.FocusEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  setLocale("en");
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
const originalFetch = globalThis.fetch;
beforeEach(() => {
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  resetPhoneKanbanPlaces();
  roots = [];
  receipts.dismiss();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  receipts.dismiss();
  globalThis.fetch = originalFetch;
});

const project = `repo-${"a".repeat(32)}`;
const SELF = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
const STAGE = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
const REMOTE_ID = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
const LOCAL_ID = ["00000000", "0000", "4000", "8000", "000000000002"].join("-");
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];

const task = (id: string, text: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  id, project, text, status: "assigned", placement: "unplaced", revision: `r-${id}-1`, assignments: [],
  createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z", ...extra,
}) as BoardTask;
const remoteTask = () => task(REMOTE_ID, "Ship the synced card", { machine: STAGE });

const lane = (state: LaneRow["s"]) => ({
  k: "l:5e0a41c2", p: project, tk: [REMOTE_ID], s: state, at: Date.now() - 120_000,
  g: [
    { id: "build", ro: "builder", st: "passed", n: 1, e: "codex", m: "gpt-6.1-sol" },
    { id: "review", ro: "reviewer", st: state === "needs_decision" ? "needs_decision" : "running", n: 1, fc: 1, e: "claude", m: "opus" },
    { id: "fix", ro: "builder", st: "pending" },
  ],
  peer: "Stage", install: STAGE, stale: false, asOf: Date.now(),
});
const feed = (lanes: unknown[]) => ({ agents: [], lanes, self: SELF, hosts: { [STAGE]: { label: "Stage", linked: true } } });

function layout(): SchemeLayout {
  return { nodes: [], groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [], byPath: new Map(), width: 0, height: 880 } as unknown as SchemeLayout;
}
const ports = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} } as never;

async function mountBoard(payload: unknown, tasks: BoardTask[]) {
  globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  const nav = createMobileNav(fakeHistory("http://localhost/#p=fixture").host);
  flushSync(() => root.render(
    <MobileNavContext.Provider value={nav}>
      <MobileKanban layout={layout()} project={project} groups={[]} manual={[]} files={[]} flows={[]} pipelines={[]} tasks={[]} allTasks={tasks} drafts={[]} now={NOW}
        seatRefs={null} attention={[]} mutationPorts={ports} onOpenTask={() => {}} onOpenConversation={() => {}} onOpenPipeline={() => {}} onShown={() => {}} />
    </MobileNavContext.Provider>,
  ));
  await tick();
  return host as unknown as HTMLElement;
}

async function mountTask(payload: unknown, subject: BoardTask) {
  globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  const nav = createMobileNav(fakeHistory("http://localhost/").host);
  nav.push({ kind: "task", id: subject.id });
  flushSync(() => root.render(
    <MobileNavContext.Provider value={nav}>
      <MobileTaskScreen taskId={subject.id} layout={layout()} project={project} groups={[]} manual={[]} files={[]} flows={[]} pipelines={[]} tasks={[]} allTasks={[subject]}
        drafts={[]} now={NOW} seatRefs={null} mutationPorts={ports} onOpenConversation={() => {}} onOpenPipeline={() => {}} onAddAgent={() => {}} />
    </MobileNavContext.Provider>,
  ));
  await tick();
  return host as unknown as HTMLElement;
}

test("the board card of a remote task stays one button, draws the lane's card line, and names the host on a passive line", async () => {
  const host = await mountBoard(feed([lane("needs_decision")]), [remoteTask(), task(LOCAL_ID, "A local task")]);
  const card = q(host, `[data-phone-card="task:${REMOTE_ID}"]`)!;
  expect(card).not.toBeNull();
  expect(card.tagName).toBe("BUTTON");
  expect(card.classList.contains("remote-surface")).toBe(true);
  expect(card.style.boxShadow).toContain("var(--remote-edge)");
  expect(card.getAttribute("aria-label")).toContain("Runs on Stage");
  expect(card.querySelector("button, a")).toBeNull();
  const line = card.querySelector<HTMLElement>("[data-phone-card-host]")!;
  expect(line.textContent).toBe("Managed on Stage");
  expect(line.dataset.phoneCardHost).toBe(STAGE);
  expect([...card.querySelectorAll(".pb-pill[data-stage]")].map((pill) => (pill as HTMLElement).dataset.stage)).toEqual(["build", "review", "fix"]);
  /* The reason line leaves the host to the line below it. */
  expect(card.querySelector("[data-pipeline-reason]")?.textContent).toContain("Waiting for a decision on Review · 1 finding");
  expect(card.querySelector("[data-pipeline-reason]")?.textContent).not.toContain("Stage");
  const local = q(host, `[data-phone-card="task:${LOCAL_ID}"]`)!;
  expect(local.classList.contains("remote-surface")).toBe(false);
  expect(local.querySelector("[data-phone-card-host]")).toBeNull();
});

test("a remote card with no local conversation does not say it has no agents, and a local card still does", async () => {
  const host = await mountBoard(feed([lane("running")]), [remoteTask(), task(LOCAL_ID, "A local task")]);
  const noAgents = translate("en", "mobile2.kanban.noAgents");
  const remote = q(host, `[data-phone-card="task:${REMOTE_ID}"]`)!;
  expect(remote.textContent).not.toContain(noAgents);
  const local = q(host, `[data-phone-card="task:${LOCAL_ID}"]`)!;
  expect(local.querySelector("[data-phone-card-agents]")?.textContent).toContain(noAgents);
});

test("an older peer's card is marked remote from the task alone, with no lane line and no error", async () => {
  const host = await mountBoard({ agents: [], lanes: [], self: SELF, hosts: { [STAGE]: { label: "Stage", linked: true } } }, [remoteTask()]);
  const card = q(host, `[data-phone-card="task:${REMOTE_ID}"]`)!;
  expect(card.querySelector("[data-phone-card-host]")?.textContent).toBe("Managed on Stage");
  expect(card.querySelector("[data-pipeline]")).toBeNull();
});

test("the task screen draws each remote lane in a remote frame with no control, and a passive pill where + Agent was", async () => {
  const host = await mountTask(feed([lane("needs_decision")]), remoteTask());
  const pill = q(host, "[data-phone-task-host]")!;
  expect(pill.tagName).toBe("SPAN");
  expect(pill.textContent).toBe("Managed on Stage");
  expect(q(host, "[data-phone-task-add-agent]")).toBeNull();
  const frame = q(host, "[data-phone-task-remote-lanes] .phone-lane")!;
  expect(frame.classList.contains("remote-surface")).toBe(true);
  expect(frame.querySelector("button, a, input")).toBeNull();
  expect(qa(frame, ".pb-pill[data-stage] .pb-name").map((node) => node.textContent)).toEqual(["Build", "Review", "Fix"]);
  expect(qa(frame, ".pb-pill[data-stage]")).toHaveLength(3);
  expect(frame.querySelector("[data-managed-on]")?.textContent).toBe(`${translate("en", "pipelineBlock.remote.decisionHead", { stage: "Review" })} · 1 finding · ${translate("en", "pipelineBlock.remote.decisionTail", { host: "Stage" })}`);
  expect(frame.querySelectorAll("[data-answer-action]")).toHaveLength(0);
});

test("a remote task's screen does not say it has no agents while the peer's lane runs, and a local task's screen still does", async () => {
  const noAgents = translate("en", "mobile2.kanban.noAgents");
  const remote = await mountTask(feed([lane("running")]), remoteTask());
  expect(q(remote, "[data-phone-task-remote-lanes]")).not.toBeNull();
  expect(remote.textContent).not.toContain(noAgents);
  const local = await mountTask(feed([]), task(LOCAL_ID, "A local task"));
  expect(local.textContent).toContain(noAgents);
});

test("a local task's screen keeps its + Agent and draws no host pill", async () => {
  const host = await mountTask(feed([]), task(LOCAL_ID, "A local task"));
  expect(q(host, "[data-phone-task-add-agent]")).not.toBeNull();
  expect(q(host, "[data-phone-task-host]")).toBeNull();
  expect(q(host, "[data-phone-task-remote-lanes]")).toBeNull();
});
