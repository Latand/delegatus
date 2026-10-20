import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { WorkspacesView } from "@/lib/team/contract";

/*
 * Team → Workspaces (docs/design/workspaces.md §13.5 D4, D5, §13.8 test 6):
 * the owner's rows with their controls, a member's without them, and the New
 * workspace dialog's refusal and its optimistic create.
 */

const dom = new Window({ url: "http://localhost/team?tab=workspaces", width: 1440, height: 900 });
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

const posts: unknown[] = [];
let gate: Promise<void> = Promise.resolve();
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === "POST") {
    posts.push(JSON.parse(String(init.body)));
    await gate;
    return { ok: true, status: 201, json: async () => ({}) } as Response;
  }
  return { ok: true, status: 200, json: async () => view(true) } as Response;
}) as unknown as typeof fetch;

const { WorkspacesTab } = await import("./WorkspacesTab");
const { setWorkspacesForTests } = await import("./workspacesClient");

const CLIENT = `w_${"c".repeat(32)}`;

function view(canManage: boolean): WorkspacesView & { mode: "team" } {
  return {
    mode: "team",
    canManage,
    workspaces: [{ id: CLIENT, name: "Client work", color: "teal", createdAt: "2026-10-20T09:00:00.000Z", projects: ["shop-app", "shop-backend"] }],
    catalog: {
      ready: true,
      projects: [
        { project: "shop-app", displayName: "shop-app", smt: 1_760_950_000 },
        { project: "shop-backend", displayName: "shop-backend", smt: 1_760_940_000 },
        { project: "scratch-notes", displayName: "scratch-notes", smt: 1_760_930_000 },
      ],
    },
  };
}

let root: Root | null = null;
beforeEach(() => { posts.length = 0; gate = Promise.resolve(); });
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
    root.render(<WorkspacesTab />);
  });
  return dom.document.body as unknown as HTMLElement;
}

const t = (key: string, params?: Record<string, string | number>) => translate("en", key as never, params as never);
const click = async (element: Element | null) => {
  expect(element).not.toBeNull();
  await act(async () => { element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
};

test("the owner sees each workspace with its projects, its menu, and the Unassigned projects with Move to…", async () => {
  setWorkspacesForTests(view(true));
  const host = await render();
  expect(host.querySelector("[data-workspace-create-open]")?.textContent).toBe(t("workspaces.new"));
  const row = host.querySelector(`[data-workspace-row='${CLIENT}']`)!;
  expect(row.querySelector("[data-workspace-row-name]")?.textContent).toBe("Client work");
  expect(row.querySelector("[data-workspace-row-projects]")?.textContent).toBe("2 projects · shop-app, shop-backend");
  await click(row.querySelector("[data-workspace-row-menu]"));
  const menu = host.querySelector("[data-workspace-popover='row']")!;
  expect([...menu.querySelectorAll("[data-workspace-action]")].map((item) => item.textContent)).toEqual([t("workspaces.open"), t("workspaces.rename"), t("workspaces.delete")]);
  /* A workspace with projects is not deleted, and the menu says why. */
  expect((menu.querySelector("[data-workspace-action='delete']") as HTMLButtonElement).disabled).toBe(true);
  expect(menu.textContent).toContain(t("workspaces.deleteBlocked"));
  expect(host.querySelector("#workspaces-unassigned-title")?.textContent).toBe(`${t("workspaces.unassignedTitle")} · 1`);
  const unassigned = host.querySelector("[data-workspace-unassigned-row='scratch-notes']")!;
  expect(unassigned.querySelector("[data-workspace-move-open]")?.textContent).toBe(t("workspaces.moveTo"));
});

test("a member reads the same rows without a control", async () => {
  setWorkspacesForTests(view(false));
  const host = await render();
  expect(host.querySelector(`[data-workspace-row='${CLIENT}']`)).not.toBeNull();
  expect(host.querySelector("[data-workspace-unassigned-row='scratch-notes']")).not.toBeNull();
  expect(host.querySelector("[data-workspace-create-open]")).toBeNull();
  expect(host.querySelector("[data-workspace-row-menu]")).toBeNull();
  expect(host.querySelector("[data-workspace-move-open]")).toBeNull();
});

test("New workspace refuses an empty name in the dialog, then creates at once with the chosen projects", async () => {
  setWorkspacesForTests(view(true));
  let release!: () => void;
  gate = new Promise((resolve) => { release = resolve; });
  const host = await render();
  await click(host.querySelector("[data-workspace-create-open]"));
  const dialog = host.querySelector("[data-team-dialog='workspace-create']")!;
  /* Unassigned first, then the projects another workspace holds, named. */
  expect([...dialog.querySelectorAll("[data-workspace-check]")].map((item) => item.textContent)).toEqual([
    `scratch-notes${t("workspaces.unassigned")}`, `shop-app${t("workspaces.inWs", { ws: "Client work" })}`, `shop-backend${t("workspaces.inWs", { ws: "Client work" })}`,
  ]);
  /* The first colour no workspace uses (teal is taken by Client work). */
  expect(dialog.querySelector("[data-workspace-color][aria-checked='true']")?.getAttribute("data-workspace-color")).toBe("coral");
  await click(dialog.querySelector("[data-workspace-create-submit]"));
  expect(dialog.querySelector("[data-workspace-create-error]")?.textContent).toBe(t("workspaces.error.nameRequired"));
  expect(posts).toEqual([]);

  /* Typed through React's own onChange, as the rail's tests type: a bare value write is invisible to a controlled input. */
  const change = async (input: HTMLInputElement, value: string | null) => {
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
    await act(async () => {
      if (value !== null) Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      props.onChange({ target: input, currentTarget: input });
    });
  };
  await change(dialog.querySelector("[data-workspace-create-name]") as unknown as HTMLInputElement, "  Research ");
  await change(dialog.querySelector("[data-workspace-check='scratch-notes'] input") as unknown as HTMLInputElement, null);
  await click(dialog.querySelector("[data-workspace-create-submit]"));
  expect(host.querySelector("[data-team-dialog='workspace-create']")).toBeNull();
  /* Drawn before the server answers. */
  const created = [...host.querySelectorAll("[data-workspace-row]")].map((row) => row.querySelector("[data-workspace-row-name]")?.textContent);
  expect(created).toEqual(["Client work", "Research"]);
  expect(host.querySelector("[data-workspace-unassigned-row='scratch-notes']")).toBeNull();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ name: "Research", color: "coral", projects: ["scratch-notes"] });
  expect((posts[0] as { id: string }).id).toMatch(/^w_[0-9a-f]{32}$/);
  await act(async () => { release(); });
});
