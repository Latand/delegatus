import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { WorkspacesView } from "@/lib/team/contract";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";

/*
 * A project row's menu in the desktop rail (variant 2): no control on a row
 * at rest; the ⋯, right-click and the keyboard open one menu; each action
 * reaches its real route (the project settings for the name and the archive,
 * the conversation catalog and project-delete for Delete) and each refusal
 * is shown where it was asked.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
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
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

type Answer = { status: number; body: unknown };
const requests: Array<{ url: string; method: string; body: unknown }> = [];
let answerFor: (url: string, method: string, body: unknown) => Promise<Answer> | Answer = () => ({ status: 404, body: {} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  /* The rail's footer polls its own routes; only the project's routes are this file's. */
  if (!/^\/api\/(projects\/settings|conversations|log\/project-delete)/.test(url)) return { ok: false, status: 503, json: async () => ({}) } as Response;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ url, method, body });
  const answer = await answerFor(url, method, body);
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
}) as unknown as typeof fetch;

const { ProjectRail } = await import("../ProjectRail");
const { writeProjectPresentation } = await import("./presentationClient");
const { projectRights } = await import("./rights");

const base = {
  root: "claude-projects", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1_000, size: 1,
  proc: null, pid: null, model: null, waitingInput: null, activity: "idle", pendingQuestion: null,
} as unknown as FileEntry;
const file = (project: string, over: Partial<FileEntry> = {}) => ({ ...base, project, path: `/sessions/${project}.jsonl`, name: `${project}.jsonl`, title: project, ...over }) as FileEntry;
const files = [file("atlas"), file("busy-lab", { activity: "live", proc: "running" })];
const catalog: ProjectCatalogEntry[] = [
  { project: "atlas", displayName: "Atlas", projectRoot: "/srv/work/atlas-checkout", smt: 1_000, conversations: 3 },
  { project: "busy-lab", displayName: "Busy Lab", smt: 990, conversations: 1 },
];

let root: Root | null = null;
const selected: string[] = [];
const crowned: Array<[string, boolean]> = [];
const archived: string[] = [];
beforeEach(() => {
  requests.length = 0;
  selected.length = 0;
  crowned.length = 0;
  archived.length = 0;
  answerFor = () => ({ status: 404, body: {} });
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  dom.document.body.replaceChildren();
  setLocale("en");
});

/* The Viewer's own writes, minus the files refresh: the real client against the stubbed routes. */
const actions = {
  rename: (project: string, name: string | null) => writeProjectPresentation(project, { name }),
  archive: async (project: string) => { archived.push(project); return writeProjectPresentation(project, { archived: true }); },
  unarchive: (project: string) => writeProjectPresentation(project, { archived: false }),
};

async function render(extra: Partial<React.ComponentProps<typeof ProjectRail>> = {}): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host as unknown as Element);
    root.render(
      <ProjectRail
        files={files}
        projectCatalog={catalog}
        pipelines={[]}
        workflows={[]}
        archivedProjects={new Set()}
        selected="atlas"
        loaded
        now={2_000}
        onSelect={(project) => selected.push(project)}
        onToggleCrown={(project, on) => crowned.push([project, on])}
        actions={actions}
        {...extra}
      />,
    );
  });
  return host as unknown as HTMLElement;
}

const settle = async () => { await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const click = async (element: unknown) => {
  expect(element).toBeTruthy();
  await act(async () => { (element as Element).dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await settle();
};
const key = async (target: unknown, name: string, shiftKey = false) => {
  await act(async () => { ((target ?? document.body) as Element).dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true }) as unknown as Event); });
  await settle();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const menu = () => document.querySelector("[data-row-menu]");
const items = () => [...document.querySelectorAll("[data-row-menu] [data-row-menu-item]")].map((item) => [item.getAttribute("data-row-menu-item"), item.getAttribute("aria-disabled") === "true"]);
const t = (name: string, params?: Record<string, string | number>) => translate("en", name as never, params as never);

describe("at rest and opening", () => {
  test("no row shows a control at rest; the ⋯ takes the age's place only on hover, and opens the menu", async () => {
    const host = await render();
    expect(host.querySelector("[data-rail-move], [data-rail-crown]")).toBeNull();
    const trigger = host.querySelector("[data-rail-row-menu='atlas']")!;
    expect(trigger.className).toContain("opacity-0");
    expect(trigger.className).toContain("group-hover:opacity-100");
    expect(trigger.getAttribute("aria-label")).toBe(t("rail.row.actions", { name: "Atlas" }));
    expect(host.querySelector("[data-rail-row='atlas'] [data-rail-slot='age']")!.className).toContain("group-hover:opacity-0");
    await click(trigger);
    expect(menu()?.getAttribute("data-row-menu")).toBe("atlas");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.className).not.toContain("opacity-0 ");
    /* Without workspaces there is nowhere to move to, so no Move row. */
    expect(items()).toEqual([["rename", false], ["crown", false], ["archive", false], ["delete", false]]);
    /* Every row has its second line. */
    expect([...menu()!.querySelectorAll("[data-row-menu-why]")].map((line) => line.textContent)).toEqual([
      t("rail.row.renameHint"), t("rail.row.crownHint"), t("rail.row.archiveHint"), t("rail.row.deleteHint"),
    ]);
    await click(trigger);
    expect(menu()).toBeNull();
  });

  test("right-click and Shift+F10 open the same menu; Escape closes it and gives the focus back to the ⋯", async () => {
    const host = await render();
    await act(async () => { host.querySelector("[data-rail-row='atlas']")!.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60 }) as unknown as Event); });
    await settle();
    expect(menu()?.getAttribute("data-row-menu")).toBe("atlas");
    await key(document.activeElement, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement?.getAttribute("data-rail-row-menu")).toBe("atlas");

    await key(host.querySelector("[data-rail-project='atlas']"), "F10", true);
    expect(menu()?.getAttribute("data-row-menu")).toBe("atlas");
    /* The arrows walk the rows, wrapping at the ends. */
    expect(document.activeElement?.getAttribute("data-row-menu-item")).toBe("rename");
    await key(document.activeElement, "ArrowDown");
    expect(document.activeElement?.getAttribute("data-row-menu-item")).toBe("crown");
    await key(document.activeElement, "End");
    expect(document.activeElement?.getAttribute("data-row-menu-item")).toBe("delete");
    await key(document.activeElement, "ArrowDown");
    expect(document.activeElement?.getAttribute("data-row-menu-item")).toBe("rename");
  });

  test("a project with an agent working keeps Archive and Delete closed with its reason", async () => {
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='busy-lab']"));
    expect(items()).toEqual([["rename", false], ["crown", false], ["archive", true], ["delete", true]]);
    for (const id of ["archive", "delete"]) {
      const row = menu()!.querySelector(`[data-row-menu-item='${id}']`)!;
      expect(row.querySelector("[data-row-menu-why='off']")?.textContent).toBe(t("rail.row.working"));
      await click(row);
      expect(menu()?.getAttribute("data-row-menu-view")).toBe("rest");
    }
  });
});

describe("rename", () => {
  test("a dialog over an inert page names the folder; an empty name is refused in place, a new one is saved", async () => {
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    await click(menu()!.querySelector("[data-row-menu-item='rename']"));
    expect(menu()).toBeNull();
    const dialog = document.querySelector("[data-project-rename]")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(host.closest("[inert]")).not.toBeNull();
    const input = dialog.querySelector<HTMLInputElement>("[data-project-rename-input]")!;
    expect(input.value).toBe("Atlas");
    expect(dialog.querySelector("[data-project-rename-folder]")?.textContent).toBe(`${t("rail.row.folderLead")} /srv/work/atlas-checkout`);
    await type(input, "   ");
    await act(async () => { dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(dialog.querySelector("[data-project-rename-error]")?.textContent).toBe(t("rail.row.emptyName"));
    expect(requests.filter((request) => request.method === "PUT")).toEqual([]);

    let release!: (answer: Answer) => void;
    answerFor = (url, method) => (method === "PUT" ? new Promise<Answer>((resolve) => { release = resolve; }) : { status: 404, body: {} });
    await type(input, "  Atlas web  ");
    await act(async () => { dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(requests.at(-1)).toEqual({ url: "/api/projects/settings", method: "PUT", body: { project: "atlas", name: "Atlas web" } });
    /* Held: the dialog stays, saving. */
    expect(dialog.querySelector("[data-project-rename-save]")?.textContent).toBe(t("rail.row.saving"));
    await act(async () => { release({ status: 200, body: { ok: true } }); });
    await settle();
    expect(document.querySelector("[data-project-rename]")).toBeNull();
    expect(host.closest("[inert]")).toBeNull();
    expect(document.activeElement?.getAttribute("data-rail-row-menu")).toBe("atlas");
  });

  test("a refused name keeps the dialog open with the reason", async () => {
    answerFor = (url, method) => (method === "PUT" ? { status: 403, body: { code: "workspace_denied", error: "project access changed" } } : { status: 404, body: {} });
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    await click(menu()!.querySelector("[data-row-menu-item='rename']"));
    const dialog = document.querySelector("[data-project-rename]")!;
    await type(dialog.querySelector<HTMLInputElement>("[data-project-rename-input]")!, "Atlas web");
    await act(async () => { dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(document.querySelector("[data-project-rename-error]")?.textContent).toBe(t("rail.row.ownerRenames"));
  });

  test("«Use the folder name» appears only once the read says a name was chosen, and resets it", async () => {
    let answer!: (value: Answer) => void;
    answerFor = (url, method) => (method === "GET" ? new Promise<Answer>((resolve) => { answer = resolve; }) : { status: 200, body: { ok: true } });
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    /* In flight: no reset row yet. */
    expect(items().map(([id]) => id)).not.toContain("reset");
    await act(async () => { answer({ status: 200, body: { ok: true, project: "atlas", name: "Atlas web", archived: false } }); });
    await settle();
    expect(items().map(([id]) => id)).toEqual(["rename", "reset", "crown", "archive", "delete"]);
    expect(menu()!.querySelector("[data-row-menu-item='reset'] [data-row-menu-why]")?.textContent).toBe(t("rail.row.resetNameHint", { folder: "atlas-checkout" }));
    await click(menu()!.querySelector("[data-row-menu-item='reset']"));
    expect(requests.at(-1)).toEqual({ url: "/api/projects/settings", method: "PUT", body: { project: "atlas", name: null } });
    expect(menu()).toBeNull();
  });

  test("no reset row when the folder names the project, or when the read fails", async () => {
    for (const reply of [{ status: 200, body: { ok: true, project: "atlas", name: null, archived: false } }, { status: 503, body: {} }]) {
      answerFor = () => reply;
      const host = await render();
      await click(host.querySelector("[data-rail-row-menu='atlas']"));
      await settle();
      expect(items().map(([id]) => id)).toEqual(["rename", "crown", "archive", "delete"]);
      await act(async () => { root?.unmount(); });
      root = null;
      dom.document.body.replaceChildren();
    }
  });
});

describe("crown, archive, delete", () => {
  test("crowning closes the menu and calls the board's crown", async () => {
    const host = await render({ crownedProjects: new Set(["atlas"]) });
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    const row = menu()!.querySelector("[data-row-menu-item='crown']")!;
    expect(row.textContent).toBe(`${t("rail.uncrown")}${t("rail.row.crownedHint")}`);
    await click(row);
    expect(crowned).toEqual([["atlas", false]]);
    expect(menu()).toBeNull();
  });

  test("Archive asks first; a refusal stays on its page with the reason, Cancel goes back", async () => {
    answerFor = (url, method) => (method === "PUT" ? { status: 409, body: { error: "PROJECT_ACTIVE", message: "a running project cannot be archived" } } : { status: 404, body: {} });
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    await click(menu()!.querySelector("[data-row-menu-item='archive']"));
    expect(menu()?.getAttribute("data-row-menu-view")).toBe("archive");
    expect(menu()!.querySelector("[data-row-menu-question]")?.textContent).toBe(t("rail.row.archiveTitle", { name: "Atlas" }));
    expect(archived).toEqual([]);
    await click(menu()!.querySelector("[data-row-menu-confirm='archive']"));
    expect(archived).toEqual(["atlas"]);
    expect(requests.at(-1)).toEqual({ url: "/api/projects/settings", method: "PUT", body: { project: "atlas", archived: true } });
    expect(menu()!.querySelector("[data-row-menu-error]")?.textContent).toBe(t("rail.row.working"));
    await click(menu()!.querySelector("[data-row-menu-cancel]"));
    expect(menu()?.getAttribute("data-row-menu-view")).toBe("rest");
  });

  test("Archive confirmed closes the menu; an archived row offers Restore and no crown", async () => {
    answerFor = () => ({ status: 200, body: { ok: true } });
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    await click(menu()!.querySelector("[data-row-menu-item='archive']"));
    await click(menu()!.querySelector("[data-row-menu-confirm='archive']"));
    expect(menu()).toBeNull();
    await act(async () => { root?.unmount(); });
    root = null;
    dom.document.body.replaceChildren();
    const shelf = await render({ archivedProjects: new Set(["atlas"]), selected: "busy-lab" });
    await click(shelf.querySelector("[data-rail-archive]"));
    await click(shelf.querySelector("[data-rail-archived] [data-rail-row-menu='atlas']"));
    expect(items().map(([id]) => id)).toEqual(["rename", "unarchive", "delete"]);
    await click(menu()!.querySelector("[data-row-menu-item='unarchive']"));
    expect(requests.at(-1)).toEqual({ url: "/api/projects/settings", method: "PUT", body: { project: "atlas", archived: false } });
  });

  test("Delete counts the conversations, asks, then deletes those paths and leaves the selected project", async () => {
    const conversations = [file("atlas", { path: "/sessions/atlas-1.jsonl" }), file("atlas", { path: "/sessions/atlas-2.jsonl" })];
    answerFor = (url, method) => {
      if (url.startsWith("/api/conversations")) return { status: 200, body: { items: conversations, nextCursor: null } };
      if (method === "POST") return { status: 200, body: { ok: true, deleted: 2 } };
      return { status: 404, body: {} };
    };
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    await click(menu()!.querySelector("[data-row-menu-item='delete']"));
    expect(menu()?.getAttribute("data-row-menu-view")).toBe("delete");
    expect(menu()!.textContent).toContain(t("rail.row.deleteBody", { count: 2 }));
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    await click(menu()!.querySelector("[data-row-menu-confirm='delete']"));
    expect(requests.at(-1)).toEqual({ url: "/api/log/project-delete", method: "POST", body: { project: "atlas", paths: ["/sessions/atlas-1.jsonl", "/sessions/atlas-2.jsonl"] } });
    expect(menu()).toBeNull();
    expect(selected).toEqual(["__overview__"]);
  });

  test("a refused delete stays on its page with how many were left", async () => {
    answerFor = (url, method) => {
      if (url.startsWith("/api/conversations")) return { status: 200, body: { items: [file("atlas")], nextCursor: null } };
      if (method === "POST") return { status: 403, body: { error: "path not allowed" } };
      return { status: 404, body: {} };
    };
    const host = await render();
    await click(host.querySelector("[data-rail-row-menu='atlas']"));
    await click(menu()!.querySelector("[data-row-menu-item='delete']"));
    await click(menu()!.querySelector("[data-row-menu-confirm='delete']"));
    expect(menu()!.querySelector("[data-row-menu-error]")?.textContent).toBe(t("trash.notDeleted", { failed: 1, total: 1 }));
    expect(selected).toEqual([]);
  });
});

describe("who may do what", () => {
  const CLIENT = `w_${"c".repeat(32)}`;
  const RESEARCH = `w_${"d".repeat(32)}`;
  const view = (over: Partial<WorkspacesView & { mode: "team" }>): WorkspacesView & { mode: "team" } => ({
    mode: "team",
    canManage: false,
    workspaces: [
      { id: CLIENT, name: "Client", color: "teal", createdAt: "2026-10-20T09:00:00.000Z", projects: ["shop"] },
      { id: RESEARCH, name: "Research", color: "violet", createdAt: "2026-10-20T09:01:00.000Z", projects: ["lab"] },
    ],
    ...over,
  });

  test("without workspaces everything opens and there is no move", () => {
    expect(projectRights(null, "shop")).toEqual({ rename: true, archive: true, delete: true, move: null, targets: [], current: null });
  });

  test("the owner moves anywhere, Unassigned included", () => {
    expect(projectRights(view({ canManage: true }), "shop")).toEqual({ rename: true, archive: true, delete: true, move: true, targets: [CLIENT, RESEARCH, null], current: CLIENT });
  });

  test("a manager of one workspace manages its projects and Unassigned ones, and moves between them only", () => {
    const manager = view({ managedWorkspaceIds: [CLIENT] });
    expect(projectRights(manager, "shop")).toEqual({ rename: true, archive: true, delete: true, move: true, targets: [CLIENT, null], current: CLIENT });
    expect(projectRights(manager, "loose")).toEqual({ rename: true, archive: true, delete: false, move: true, targets: [CLIENT], current: null });
    expect(projectRights(manager, "lab")).toEqual({ rename: false, archive: false, delete: true, move: false, targets: [], current: RESEARCH });
  });

  test("a member renames, moves and archives nothing; deletes inside their own workspace", () => {
    expect(projectRights(view({ managedWorkspaceIds: [] }), "shop")).toEqual({ rename: false, archive: false, delete: true, move: false, targets: [], current: CLIENT });
    expect(projectRights(view({}), "loose")).toEqual({ rename: false, archive: false, delete: false, move: false, targets: [], current: null });
  });
});
