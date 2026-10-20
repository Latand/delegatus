import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { PRODUCT_NAME } from "@/lib/brand";
import { setLocale, translate } from "@/lib/i18n";
import type { WorkspacesView } from "@/lib/team/contract";
import type { FileEntry } from "@/lib/types";

/*
 * The rail with workspaces (docs/design/workspaces.md §13.5 D1–D3, §13.8
 * test 6): without the prop the rail is today's; a chosen workspace lists
 * only its projects and keeps the crown and the archive inside it; All draws
 * one section per workspace and then Unassigned; the owner, and only the
 * owner, moves an Unassigned project, and a refused move comes back with
 * its reason on the row.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
/* Reduced motion: the list's FLIP animation, which happy-dom cannot run, stays off. */
const matchMediaStub = (query: string) => ({
  matches: query.includes("reduce"), media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
});

type Answer = { status: number; body: unknown };
const notFound = async (): Promise<Answer> => ({ status: 404, body: {} });
let answerFor: (url: string, method: string) => Promise<Answer> = notFound;
const requests: Array<{ url: string; method: string; body: unknown }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  /* Only the workspace routes are this file's; the rail's footer polls its own. */
  if (!url.startsWith("/api/team")) return { ok: false, status: 404, json: async () => ({}) } as Response;
  requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  const answer = await answerFor(url, method);
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
}) as unknown as typeof fetch;

const { ProjectRail } = await import("./ProjectRail");
const { placeProject, setWorkspacesForTests, useWorkspaces } = await import("./team/workspacesClient");

const CLIENT = `w_${"c".repeat(32)}`;
const RESEARCH = `w_${"d".repeat(32)}`;

function teamView(canManage: boolean): WorkspacesView & { mode: "team" } {
  return {
    mode: "team",
    canManage,
    workspaces: [
      { id: CLIENT, name: "Client work", color: "teal", createdAt: "2026-10-20T09:00:00.000Z", projects: ["shop-app", "shop-backend"] },
      { id: RESEARCH, name: "Research", color: "violet", createdAt: "2026-10-20T09:01:00.000Z", projects: ["voice-lab"] },
    ],
  };
}

const base = {
  root: "claude-projects", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1_000, size: 1,
  proc: null, pid: null, model: null, waitingInput: null, activity: "idle", pendingQuestion: null,
} as unknown as FileEntry;
const files = ["shop-app", "shop-backend", "voice-lab", "scratch-notes", "bench-tmp"].map((project, index) => (
  { ...base, project, path: `/sessions/${project}.jsonl`, name: `${project}.jsonl`, title: project, mtime: 1_000 - index }
)) as unknown as FileEntry[];

let root: Root | null = null;
beforeEach(() => {
  dom.localStorage.clear();
  requests.length = 0;
  answerFor = notFound;
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  setWorkspacesForTests(null);
  dom.document.body.replaceChildren();
  setLocale("en");
});

function Harness({ initial, selected, crowned = [], archived = [] }: { initial: string; selected: string; crowned?: string[]; archived?: string[] }) {
  const view = useWorkspaces();
  const [current, setCurrent] = useState(initial);
  if (view?.mode !== "team") return null;
  return (
    <ProjectRail
      files={files}
      projectCatalog={[]}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set(archived)}
      crownedProjects={new Set(crowned)}
      selected={selected}
      loaded
      now={2_000}
      onHide={() => {}}
      onSelect={() => {}}
      onToggleCrown={() => {}}
      workspace={{ view, chosen: current, choose: setCurrent, place: placeProject, leave: () => {} }}
    />
  );
}

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host as unknown as Element);
    root.render(element);
  });
  return host as unknown as HTMLElement;
}

const click = async (element: unknown) => {
  await act(async () => { (element as Element).dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
};
const rows = (host: HTMLElement) => [...host.querySelectorAll("[data-rail-project]")].map((row) => row.getAttribute("data-rail-project"));
const sections = (host: HTMLElement) => [...host.querySelectorAll("[data-rail-section]")].map((section) => section.textContent);
const t = (key: string) => translate("en", key as never);

test("without workspaces the header is today's and no request is made", async () => {
  const host = await render(
    <ProjectRail files={files} projectCatalog={[]} pipelines={[]} workflows={[]} archivedProjects={new Set()} selected="voice-lab" loaded now={2_000} onHide={() => {}} onSelect={() => {}} />,
  );
  expect(host.querySelector("header")?.textContent).toBe(PRODUCT_NAME);
  expect(host.querySelector("[data-workspace-chip]")).toBeNull();
  expect(sections(host)).toEqual([`${t("rail.projects")}5`]);
  expect(requests).toEqual([]);
});

describe("a chosen workspace", () => {
  test("lists only its projects, with the crown and the archive inside it", async () => {
    setWorkspacesForTests(teamView(true));
    const host = await render(<Harness initial={CLIENT} selected="shop-app" crowned={["shop-app", "voice-lab"]} archived={["shop-backend"]} />);
    expect(host.querySelector("[data-workspace-chip-label]")?.textContent).toBe("Client work");
    expect(host.querySelector("[data-rail-brand]")).toBeNull();
    /* The crowned project of another workspace leaves the Pinned section while filtered out. */
    expect(sections(host)).toEqual([`${t("rail.pinned")}1`, `${t("rail.projects")}0`]);
    expect(rows(host)).toEqual(["shop-app"]);
    expect(host.querySelector("[data-rail-archive]")?.textContent).toBe(`${t("rail.archive")}1`);
    await click(host.querySelector("[data-rail-archive]")!);
    expect(rows(host)).toEqual(["shop-app", "shop-backend"]);
    /* Nothing moves inside a workspace. */
    expect(host.querySelector("[data-rail-move]")).toBeNull();
  });

  test("the chip's menu switches; a member gets the rows and Manage only", async () => {
    setWorkspacesForTests(teamView(false));
    const host = await render(<Harness initial={CLIENT} selected="shop-app" />);
    await click(host.querySelector("[data-workspace-chip]")!);
    const menu = host.querySelector("[data-workspace-menu]")!;
    expect([...menu.querySelectorAll("[data-workspace-option]")].map((row) => row.textContent)).toEqual([
      `${t("workspaces.all")}5 projects`, "Client work2 projects", "Research1 project",
    ]);
    expect(menu.querySelector("[data-workspace-option][aria-checked='true']")?.textContent).toContain("Client work");
    expect([...menu.querySelectorAll("[data-workspace-link]")].map((link) => link.getAttribute("data-workspace-link"))).toEqual(["manage"]);
    await click(menu.querySelector(`[data-workspace-option='${RESEARCH}']`)!);
    expect(host.querySelector("[data-workspace-menu]")).toBeNull();
    expect(rows(host)).toEqual(["voice-lab"]);
  });

  test("the owner's menu adds the settings of the current workspace and New workspace", async () => {
    setWorkspacesForTests(teamView(true));
    const host = await render(<Harness initial={CLIENT} selected="shop-app" />);
    await click(host.querySelector("[data-workspace-chip]")!);
    const links = [...host.querySelectorAll("[data-workspace-link]")] as HTMLAnchorElement[];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      [t("workspaces.settings"), `/team/workspaces/${CLIENT}`],
      [t("workspaces.new"), "/team?tab=workspaces&create=1"],
      [t("workspaces.manage"), "/team?tab=workspaces"],
    ]);
    await act(async () => { dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector("[data-workspace-menu]")).toBeNull();
  });
});

describe("All", () => {
  test("one section per workspace, then Unassigned; the chip says All", async () => {
    setWorkspacesForTests(teamView(true));
    const host = await render(<Harness initial="all" selected="voice-lab" />);
    expect(host.querySelector("[data-workspace-chip-label]")?.textContent).toBe(t("workspaces.all"));
    expect(sections(host)).toEqual(["Client work2", "Research1", `${t("workspaces.unassigned")}2`]);
    expect(rows(host)).toEqual(["shop-app", "shop-backend", "voice-lab", "bench-tmp", "scratch-notes"]);
  });

  test("Move shows on the selected Unassigned row for the owner, never for a member", async () => {
    setWorkspacesForTests(teamView(true));
    const host = await render(<Harness initial="all" selected="scratch-notes" />);
    const moves = [...host.querySelectorAll("[data-rail-move]")];
    /* Every Unassigned row carries it for the keyboard; only the selected one shows it and keeps its place. */
    expect(moves.length).toBe(2);
    const selectedMove = host.querySelector("[data-rail-project='scratch-notes']")!.parentElement!.querySelector("[data-rail-move]")!;
    expect(selectedMove.className).not.toContain("opacity-0");
    expect(host.querySelector("[data-rail-project='scratch-notes'] [data-rail-move-space]")).not.toBeNull();
    const otherMove = host.querySelector("[data-rail-project='bench-tmp']")!.parentElement!.querySelector("[data-rail-move]")!;
    expect(otherMove.className).toContain("opacity-0");
    expect(selectedMove.textContent).toBe(t("workspaces.move"));

    await act(async () => { root?.unmount(); });
    root = null;
    setWorkspacesForTests(teamView(false));
    const member = await render(<Harness initial="all" selected="scratch-notes" />);
    expect(member.querySelector("[data-rail-move]")).toBeNull();
  });

  test("a move shows at once; a refusal puts the row back with its reason", async () => {
    setWorkspacesForTests(teamView(true));
    let refuse!: (answer: Answer) => void;
    answerFor = async (url, method) => {
      if (method === "PUT") return new Promise<Answer>((resolve) => { refuse = resolve; });
      return url.startsWith("/api/team/workspaces") ? { status: 200, body: teamView(true) } : notFound();
    };
    const host = await render(<Harness initial="all" selected="scratch-notes" />);
    const move = host.querySelector("[data-rail-project='scratch-notes']")!.parentElement!.querySelector("[data-rail-move]")!;
    await click(move);
    const menu = dom.document.querySelector("[data-workspace-popover='move']")!;
    expect([...menu.querySelectorAll("[data-workspace-move-to]")].map((row) => row.textContent)).toEqual(["Client work", "Research"]);
    await click(menu.querySelector(`[data-workspace-move-to='${RESEARCH}']`)!);
    /* Optimistic: the row is already under Research. */
    expect(sections(host)).toEqual(["Client work2", "Research2", `${t("workspaces.unassigned")}1`]);
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ project: "scratch-notes", workspaceId: RESEARCH });
    await act(async () => { refuse({ status: 404, body: { code: "workspace_gone", error: "gone" } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(sections(host)).toEqual(["Client work2", "Research1", `${t("workspaces.unassigned")}2`]);
    expect(host.querySelector("[data-rail-move-error]")?.textContent).toBe(t("workspaces.error.gone"));
  });
});
