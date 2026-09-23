import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { FilesWorkLinks, ResolvedWorkLinks, WorkLink } from "@/lib/forge/workLinks";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import type { TaskMutationPorts } from "@/components/kanban/useTaskMutations";

/* PR and issue chips on the kanban board (#2059), rendered by React: the
   pipeline header's chips and its plain "no PR", the card's deduplicated row
   that stays when the card is collapsed, "+N" opening every link with the
   attach form, and the PATCH an attach sends. Invented records; fetches answer
   from a stub; no route or state directory is touched. */

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
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const patches: Array<{ url: string; body: unknown }> = [];
let answer: ResolvedWorkLinks | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (init?.method === "PATCH") {
    patches.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, workLinks: answer }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("@/components/kanban/KanbanBoard");
const { WorkLinksProvider } = await import("./workLinksContext");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  patches.length = 0;
});

const NOW = 1_800_000_000;
const REV = ["task-v1:00000000", "0000", "4000", "8000", "000000000003"].join("-");
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();

function lane(id: string, title: string): Pipeline {
  return {
    id, task: title, taskIds: ["t-chips"], project: "fixture", state: "running",
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build.", next: null, onFail: null,
      effectiveRole: { roleId: "builder", engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null } }],
    runs: [], cursor: { stageId: "build", state: "running", input: null, activatedBy: null }, worktreeDir: "/fixture/worktree", createdAt: iso(9000),
  } as unknown as Pipeline;
}

const link = (number: number, over: Partial<WorkLink> = {}): WorkLink => ({
  key: `acme/widgets#${number}`, kind: "pr", repository: "acme/widgets", number, url: `https://github.com/acme/widgets/pull/${number}`,
  source: "auto", via: ["delivery-branch"], state: "open", checkedAt: new Date(NOW * 1000).toISOString(), ...over,
});
const issue = (number: number, over: Partial<WorkLink> = {}) => link(number, { kind: "issue", url: `https://github.com/acme/widgets/issues/${number}`, state: null, checkedAt: null, via: ["closes"], ...over });

const shared = link(41, { state: "merged" });
const boardLinks: FilesWorkLinks = {
  pipelines: {
    "p-one": { links: [shared, issue(2059)], noPr: false },
    "p-two": { links: [], noPr: true },
  },
  tasks: {
    "t-chips": { links: [link(44, { state: "draft" }), shared, link(40, { state: "closed" }), issue(2059, { source: "manual", via: ["manual"] }), issue(2060)], noPr: false },
  },
};

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(links: FilesWorkLinks = boardLinks) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const task = { id: "t-chips", project: "fixture", text: "Chips on cards", status: "assigned", placement: "unplaced", assignments: [], createdAt: iso(9000), updatedAt: iso(600), revision: REV } as BoardTask;
  flushSync(() => root.render(
    <WorkLinksProvider value={links}>
      <KanbanBoard
        project="fixture" groups={[]} manual={[]} files={[]} flows={[]}
        pipelines={[lane("p-one", "Header chips"), lane("p-two", "A lane with nothing published")]}
        tasks={[]} allTasks={[task]} drafts={[]} now={NOW} loaded catalogFailures={0} selection={new Set()}
        onOpenConversations={() => {}} seatRefs={null} mutationPorts={idlePorts}
      />
    </WorkLinksProvider>,
  ));
  return host;
}

const card = (host: HTMLElement) => host.querySelector<HTMLElement>('.card[data-id="task:t-chips"]')!;
const chips = (root: Element | null | undefined) => [...(root?.querySelectorAll<HTMLAnchorElement>(".wl-chip") ?? [])].map((chip) => `${chip.dataset.tone}:${chip.textContent}`);
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};

test("each pipeline header draws its own chips on a line of their own, and a lane with no PR says so as plain text", async () => {
  const host = mount();
  await tick();
  const one = card(host).querySelector('[data-work-links="p-one"]');
  expect(chips(one)).toEqual(["merged:#41", "issue:#2059"]);
  /* Never inside the header line, where it would take the title's width. */
  expect(card(host).querySelector(".sec-head .wl-row")).toBeNull();
  const chip = one!.querySelector<HTMLAnchorElement>(".wl-chip")!;
  expect(chip.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/41");
  expect(chip.getAttribute("target")).toBe("_blank");
  expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
  expect(chip.getAttribute("aria-label")).toContain("Pull request #41 · merged");
  const two = card(host).querySelector('[data-work-links="p-two"]')!;
  expect(two.querySelector(".wl-chip")).toBeNull();
  expect(two.querySelector("[data-work-links-nopr]")?.textContent).toBe("no PR");
  expect(two.querySelector("a")).toBeNull();
});

test("the card's row shows three chips and +N, stays when the card is collapsed, and +N lists every link with × on the attached one only", async () => {
  const host = mount();
  await tick();
  const row = () => card(host).querySelector('[data-work-links="t-chips"]');
  expect(chips(row())).toEqual(["draft:#44", "merged:#41", "closed:#40"]);
  expect(row()!.querySelector("[data-work-links-more]")?.textContent).toBe("+2");
  click(card(host).querySelector(".icon-btn.fold"));
  await tick();
  expect(card(host).getAttribute("data-collapsed")).toBe("1");
  expect(card(host).querySelector(".stage-section")).toBeNull();
  expect(chips(row())).toEqual(["draft:#44", "merged:#41", "closed:#40"]);

  click(row()!.querySelector("[data-work-links-more]"));
  await tick();
  const panel = document.querySelector('[data-work-links-panel="task:t-chips"]')!;
  expect([...panel.querySelectorAll("[data-work-link-row]")].map((entry) => entry.getAttribute("data-work-link-row")))
    .toEqual(["acme/widgets#44", "acme/widgets#41", "acme/widgets#40", "acme/widgets#2059", "acme/widgets#2060"]);
  expect([...panel.querySelectorAll("[data-work-link-detach]")].map((button) => button.getAttribute("data-work-link-detach"))).toEqual(["acme/widgets#2059"]);
});

test("the pipeline menu's attach form sends attach-link with what was typed, and draws the answer at once", async () => {
  const host = mount({ pipelines: { "p-two": { links: [], noPr: true } }, tasks: {} });
  await tick();
  const section = card(host).querySelector('.stage-section[data-pipeline="p-two"]')!;
  click(section.querySelector("[data-pipeline-menu]"));
  const attach = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Attach PR or issue…"));
  click(attach);
  await tick();
  const input = document.querySelector<HTMLInputElement>('[data-work-links-panel="pipeline:p-two"] [data-work-link-input]')!;
  expect(input.getAttribute("placeholder")).toBe("#2059 or URL");
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, " #2059 ");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  answer = { links: [link(2059, { kind: null, state: null, checkedAt: null, source: "manual", via: ["manual"], url: "https://github.com/acme/widgets/issues/2059" })], noPr: false };
  click(document.querySelector('[data-work-links-panel="pipeline:p-two"] [data-work-link-attach]'));
  await tick(20);
  expect(patches).toEqual([{ url: "/api/pipelines/p-two", body: { action: "attach-link", link: "#2059" } }]);
  expect(chips(card(host).querySelector('[data-work-links="p-two"]'))).toEqual(["unknown:#2059"]);
  expect(card(host).querySelector('[data-work-links="p-two"] [data-work-links-nopr]')).toBeNull();
});
