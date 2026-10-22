import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { WorkspacesView } from "@/lib/team/contract";
import type { FileEntry } from "@/lib/types";

/*
 * The phone's project sheet with workspaces (docs/design/workspaces.md
 * §13.5 P2, P3, §13.8 test 6): without the prop it is today's sheet; the
 * first row names the current workspace and opens the others; a chosen
 * workspace lists only its projects; All groups them and the owner, only the
 * owner, moves an Unassigned one, and a refused move comes back with its reason.
 */

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
installActEnv();
const matchMediaStub = (query: string) => ({
  matches: query.includes("max-width") || query.includes("reduce"), media: String(query), onchange: null,
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
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

type Answer = { status: number; body: unknown };
let answerFor: (url: string, method: string) => Promise<Answer> = async () => ({ status: 404, body: {} });
const puts: unknown[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "PUT") puts.push(JSON.parse(String(init?.body)));
  const answer = await answerFor(String(input), method);
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
}) as unknown as typeof fetch;

const { MobileProjectSheet } = await import("./MobileProjectSheet");
const { placeProject, setWorkspacesForTests, useWorkspaces } = await import("../team/workspacesClient");

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
  puts.length = 0;
  answerFor = async () => ({ status: 404, body: {} });
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  setWorkspacesForTests(null);
  dom.document.body.replaceChildren();
  setLocale("en");
});

const sheetProps = {
  files,
  projectCatalog: [],
  pipelines: [],
  workflows: [],
  archivedProjects: new Set<string>(),
  now: 2_000,
  loaded: true,
  onSelect: () => {},
  onClose: () => {},
};

function Harness({ initial, selected = "voice-lab", leave = () => {}, crowned = [] }: { initial: string; selected?: string; leave?: (path: string) => void; crowned?: string[] }) {
  const view = useWorkspaces();
  const [current, setCurrent] = useState(initial);
  if (view?.mode !== "team") return null;
  return <MobileProjectSheet {...sheetProps} crownedProjects={new Set(crowned)} selected={selected} workspace={{ view, chosen: current, choose: setCurrent, place: placeProject, leave }} />;
}

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host as unknown as Element);
    root.render(element);
  });
  return dom.document.body as unknown as HTMLElement;
}

const click = async (element: Element | null) => {
  expect(element).not.toBeNull();
  await act(async () => { element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
};
const projects = (host: HTMLElement) => [...host.querySelectorAll("[data-mobile2-project]")].map((row) => row.getAttribute("data-mobile2-project"));
const t = (key: string) => translate("en", key as never);

test("without workspaces the sheet is today's", async () => {
  const host = await render(<MobileProjectSheet {...sheetProps} selected="voice-lab" />);
  expect(host.querySelector("[data-mobile2-workspace]")).toBeNull();
  expect(host.querySelector("[data-mobile2-workspace-section]")).toBeNull();
  expect(projects(host)).toEqual(["__overview__", "bench-tmp", "scratch-notes", "shop-app", "shop-backend", "voice-lab"]);
});

describe("a chosen workspace", () => {
  test("the first row names it; its projects alone are listed, and Overview counts them", async () => {
    setWorkspacesForTests(teamView(false));
    const host = await render(<Harness initial={CLIENT} selected="shop-app" />);
    expect(host.querySelector("[data-mobile2-workspace]")?.textContent).toBe(`Client work${t("workspaces.label")}`);
    expect(projects(host)).toEqual(["__overview__", "shop-app", "shop-backend"]);
    expect(host.querySelector("[data-mobile2-project='__overview__']")?.textContent).toContain("2 projects");
    expect(host.querySelector("[data-mobile2-move]")).toBeNull();
  });

  test("expanded, it lists All and each workspace with its count, hides the list, and a tap switches", async () => {
    setWorkspacesForTests(teamView(true));
    const left: string[] = [];
    const host = await render(<Harness initial={CLIENT} selected="shop-app" leave={(path) => left.push(path)} />);
    await click(host.querySelector("[data-mobile2-workspace]"));
    const list = host.querySelector("[data-mobile2-workspace-list]")!;
    expect([...list.querySelectorAll("[data-mobile2-workspace-option]")].map((row) => row.textContent)).toEqual([
      `${t("workspaces.all")}5 projects`, "Client work2 projects", "Research1 project",
    ]);
    expect(list.querySelector("[aria-checked='true']")?.textContent).toContain("Client work");
    expect([...list.querySelectorAll("[data-mobile2-workspace-link]")].map((row) => row.textContent)).toEqual([t("workspaces.settings"), t("workspaces.new")]);
    expect(projects(host)).toEqual(["__overview__"]);
    await click(list.querySelector("[data-mobile2-workspace-link='settings']"));
    expect(left).toEqual([`/team/workspaces/${CLIENT}`]);
    await click(host.querySelector(`[data-mobile2-workspace-option='${RESEARCH}']`));
    expect(host.querySelector("[data-mobile2-workspace-list]")).toBeNull();
    expect(projects(host)).toEqual(["__overview__", "voice-lab"]);
  });

  test("a member's expanded list has no settings and no New workspace", async () => {
    setWorkspacesForTests(teamView(false));
    const host = await render(<Harness initial={CLIENT} />);
    await click(host.querySelector("[data-mobile2-workspace]"));
    expect(host.querySelector("[data-mobile2-workspace-link]")).toBeNull();
  });
});

describe("All", () => {
  test("a heading per workspace, then Unassigned; Move only for the owner", async () => {
    setWorkspacesForTests(teamView(true));
    const host = await render(<Harness initial="all" />);
    expect([...host.querySelectorAll("[data-mobile2-workspace-section]")].map((section) => section.getAttribute("data-mobile2-workspace-section"))).toEqual([CLIENT, RESEARCH, "unassigned"]);
    expect(projects(host)).toEqual(["__overview__", "shop-app", "shop-backend", "voice-lab", "bench-tmp", "scratch-notes"]);
    expect([...host.querySelectorAll("[data-mobile2-movable]")].map((row) => row.getAttribute("data-mobile2-movable"))).toEqual(["bench-tmp", "scratch-notes"]);

    await act(async () => { root?.unmount(); });
    root = null;
    dom.document.body.replaceChildren();
    setWorkspacesForTests(teamView(false));
    const member = await render(<Harness initial="all" />);
    expect(member.querySelector("[data-mobile2-move]")).toBeNull();
  });

  test("a crowned project stands first under its own workspace, and an Unassigned row's Move takes its marks' place", async () => {
    setWorkspacesForTests(teamView(true));
    const host = await render(<Harness initial="all" crowned={["shop-backend", "scratch-notes"]} />);
    expect(projects(host)).toEqual(["__overview__", "shop-backend", "shop-app", "voice-lab", "scratch-notes", "bench-tmp"]);
    const heading = (id: string) => host.querySelector(`[data-mobile2-workspace-section='${id}']`)!.firstElementChild!.textContent;
    expect(heading(CLIENT)).toBe("Client work2");
    expect(heading("unassigned")).toBe(`${t("workspaces.unassigned")}2`);
    /* The Unassigned rows carry no working or quiet mark beside Move. */
    for (const project of ["scratch-notes", "bench-tmp"]) {
      const row = host.querySelector(`[data-mobile2-movable='${project}'] [data-mobile2-project]`)!;
      expect(row.querySelector("[data-mobile2-working]")).toBeNull();
      expect(row.textContent).toBe(project);
    }
  });

  test("Move expands the workspaces under the row; a pick shows at once and a refusal comes back with its reason", async () => {
    setWorkspacesForTests(teamView(true));
    let refuse!: (answer: Answer) => void;
    answerFor = async (url, method) => {
      if (method === "PUT") return new Promise<Answer>((resolve) => { refuse = resolve; });
      return String(url).startsWith("/api/team/workspaces") ? { status: 200, body: teamView(true) } : { status: 404, body: {} };
    };
    const host = await render(<Harness initial="all" />);
    const row = host.querySelector("[data-mobile2-movable='bench-tmp']")!;
    await click(row.querySelector("[data-mobile2-move]"));
    expect(row.querySelector("[data-mobile2-move]")?.getAttribute("aria-expanded")).toBe("true");
    expect([...row.querySelectorAll("[data-mobile2-move-to]")].map((target) => target.textContent)).toEqual(["Client work", "Research"]);
    await click(row.querySelector(`[data-mobile2-move-to='${CLIENT}']`));
    expect(puts).toEqual([{ project: "bench-tmp", workspaceId: CLIENT }]);
    expect(host.querySelector(`[data-mobile2-workspace-section='${CLIENT}']`)?.textContent).toContain("bench-tmp");
    await act(async () => { refuse({ status: 409, body: { code: "name_taken", error: "x" } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const back = host.querySelector("[data-mobile2-movable='bench-tmp']")!;
    expect(back).not.toBeNull();
    expect(back.querySelector("[role='alert']")?.textContent).toBe(t("workspaces.error.nameTaken"));
  });
});
