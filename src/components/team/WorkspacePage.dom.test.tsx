import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { WorkspacesView } from "@/lib/team/contract";

/*
 * The workspace page's account-list line (workspaces W1): the owner and the
 * workspace's manager are told which projects have no account list for an
 * engine, so members cannot pick an account there; a plain member is told
 * nothing and no pool is read for them.
 */

const dom = new Window({ url: "http://localhost/team/workspaces/w", width: 1440, height: 900 });
installActEnv();
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
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});

type Pool = { pool: "set"; accounts: unknown[] } | { pool: "none"; available: boolean };
let pools: Record<string, { claude: Pool; codex: Pool } | "refused">;
let urls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  urls.push(url);
  if (url.startsWith("/api/team/project-accounts?")) {
    const project = decodeURIComponent(url.split("project=")[1]!);
    const pool = pools[project];
    return !pool || pool === "refused"
      ? { ok: false, status: 403, json: async () => ({ code: "workspace_forbidden" }) } as Response
      : { ok: true, status: 200, json: async () => ({ project, engines: pool }) } as Response;
  }
  if (url.includes("/members")) return { ok: true, status: 200, json: async () => ({ canManage: false, members: [], candidates: [] }) } as Response;
  return { ok: true, status: 200, json: async () => ({}) } as Response;
}) as unknown as typeof fetch;

const { WorkspacePage } = await import("./WorkspacePage");
const { setWorkspacesForTests } = await import("./workspacesClient");

const CLIENT = `w_${"c".repeat(32)}`;
const NONE: Pool = { pool: "none", available: true };
const SET: Pool = { pool: "set", accounts: [] };

function view(options: { canManage: boolean; managed?: string[] }): WorkspacesView & { mode: "team" } {
  return {
    mode: "team",
    canManage: options.canManage,
    managedWorkspaceIds: options.managed ?? (options.canManage ? [CLIENT] : []),
    workspaces: [{ id: CLIENT, name: "Client work", color: "teal", createdAt: "2026-10-20T09:00:00.000Z", projects: ["shop-app", "shop-backend"] }],
    catalog: { ready: true, projects: [
      { project: "shop-app", displayName: "Shop app", smt: 1_760_950_000 },
      { project: "shop-backend", displayName: "Shop backend", smt: 1_760_940_000 },
    ] },
  };
}

let root: Root | null = null;
beforeEach(() => {
  urls = [];
  pools = { "shop-app": { claude: NONE, codex: SET }, "shop-backend": { claude: NONE, codex: NONE } };
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  setWorkspacesForTests(null);
  dom.document.body.replaceChildren();
  setLocale("en");
});

async function render(): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host as unknown as Element);
    root.render(<WorkspacePage id={CLIENT} />);
  });
  /* The pool reads resolve after the first paint. */
  for (let turn = 0; turn < 4; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return dom.document.body as unknown as HTMLElement;
}

const notes = (host: HTMLElement) => [...host.querySelectorAll("[data-workspace-account-list-note]")].map((note) => [note.getAttribute("data-workspace-account-list-note"), note.textContent]);

test("the owner is told, per engine, which projects have no account list", async () => {
  setWorkspacesForTests(view({ canManage: true }));
  expect(notes(await render())).toEqual([
    ["claude", "Members can't choose a Claude account in Shop app, Shop backend until an account list is set there. Until then Delegatus picks the account."],
    ["codex", "Members can't choose a Codex account in Shop backend until an account list is set there. Until then Delegatus picks the account."],
  ]);
});

test("the workspace's manager is told the same", async () => {
  setWorkspacesForTests(view({ canManage: false, managed: [CLIENT] }));
  expect(notes(await render()).map(([engine]) => engine)).toEqual(["claude", "codex"]);
});

test("a plain member is told nothing and no pool is read for them", async () => {
  setWorkspacesForTests(view({ canManage: false }));
  expect(notes(await render())).toEqual([]);
  expect(urls.filter((url) => url.includes("project-accounts"))).toEqual([]);
});

test("a read that fails leaves no line, and a workspace whose projects all have lists has none either", async () => {
  setWorkspacesForTests(view({ canManage: true }));
  pools["shop-backend"] = "refused";
  expect(notes(await render())).toEqual([]);
  root && await act(async () => { root!.unmount(); }); root = null; dom.document.body.replaceChildren();
  pools = { "shop-app": { claude: SET, codex: SET }, "shop-backend": { claude: SET, codex: SET } };
  expect(notes(await render())).toEqual([]);
});

test("the line is worded in Ukrainian", async () => {
  setLocale("uk");
  setWorkspacesForTests(view({ canManage: true }));
  const text = translate("uk", "workspaces.page.noAccountList" as never, { engine: "Claude", projects: "Shop app, Shop backend" } as never);
  expect(notes(await render())[0]).toEqual(["claude", text]);
  expect(text).toBe("Учасники не можуть обрати акаунт Claude у Shop app, Shop backend, доки там не задано списку акаунтів. До того акаунт обирає Delegatus.");
});
