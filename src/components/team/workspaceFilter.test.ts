import { describe, expect, test } from "bun:test";

import { OVERVIEW } from "@/components/projectModel";

import {
  ALL_WORKSPACES,
  createdLocally,
  deletedLocally,
  effectiveWorkspace,
  followSelection,
  groupAll,
  placedLocally,
  updatedLocally,
  workspaceOf,
  workspaceScope,
  type TeamWorkspaces,
} from "./workspaceFilter";

/* The workspace filter (docs/design/workspaces.md §13.8 test 5). */

const CLIENT = `w_${"c".repeat(32)}`;
const RESEARCH = `w_${"d".repeat(32)}`;
const EMPTY = `w_${"e".repeat(32)}`;

const view: TeamWorkspaces = {
  mode: "team",
  canManage: true,
  workspaces: [
    { id: CLIENT, name: "Client work", color: "teal", createdAt: "2026-10-20T09:00:00.000Z", projects: ["shop-app", "shop-backend"] },
    { id: EMPTY, name: "Empty", color: "slate", createdAt: "2026-10-20T09:01:00.000Z", projects: [] },
    { id: RESEARCH, name: "Research", color: "violet", createdAt: "2026-10-20T09:02:00.000Z", projects: ["voice-lab"] },
  ],
};

describe("scope", () => {
  test("All shows everything; a workspace shows its projects", () => {
    expect(workspaceScope(view, ALL_WORKSPACES)).toBeNull();
    expect([...workspaceScope(view, CLIENT)!]).toEqual(["shop-app", "shop-backend"]);
    expect([...workspaceScope(view, EMPTY)!]).toEqual([]);
  });

  test("an unknown stored id, or any choice without a view, reads as All", () => {
    expect(effectiveWorkspace(view, `w_${"0".repeat(32)}`)).toBe(ALL_WORKSPACES);
    expect(workspaceScope(view, `w_${"0".repeat(32)}`)).toBeNull();
    expect(effectiveWorkspace(null, CLIENT)).toBe(ALL_WORKSPACES);
    expect(effectiveWorkspace(view, null)).toBe(ALL_WORKSPACES);
    expect(effectiveWorkspace({ ...view, workspaces: [] }, CLIENT)).toBe(ALL_WORKSPACES);
  });

  test("workspaceOf names the holder, or null for Unassigned", () => {
    expect(workspaceOf(view, "voice-lab")).toBe(RESEARCH);
    expect(workspaceOf(view, "scratch-notes")).toBeNull();
  });
});

describe("followSelection", () => {
  test("a project in another workspace moves the choice there; an Unassigned one to All", () => {
    expect(followSelection(view, CLIENT, "voice-lab")).toBe(RESEARCH);
    expect(followSelection(view, CLIENT, "scratch-notes")).toBe(ALL_WORKSPACES);
  });

  test("a project inside the choice, the Overview, and All itself move nothing", () => {
    expect(followSelection(view, CLIENT, "shop-app")).toBe(CLIENT);
    expect(followSelection(view, CLIENT, OVERVIEW)).toBe(CLIENT);
    expect(followSelection(view, ALL_WORKSPACES, "voice-lab")).toBe(ALL_WORKSPACES);
  });
});

describe("groupAll", () => {
  test("one section per workspace in the API's order, an empty one kept, Unassigned last", () => {
    const rows = ["voice-lab", "scratch-notes", "shop-backend", "bench-tmp", "shop-app"].map((project) => ({ project }));
    const sections = groupAll(rows, view);
    expect(sections.map((section) => [section.workspace?.name ?? null, section.rows.map((row) => row.project)])).toEqual([
      ["Client work", ["shop-backend", "shop-app"]],
      ["Empty", []],
      ["Research", ["voice-lab"]],
      [null, ["scratch-notes", "bench-tmp"]],
    ]);
  });
});

describe("optimistic results", () => {
  test("placing moves one project and keeps it in one workspace", () => {
    const moved = placedLocally(view, "voice-lab", CLIENT);
    expect(moved.workspaces.map((workspace) => workspace.projects)).toEqual([["shop-app", "shop-backend", "voice-lab"], [], []]);
    expect(placedLocally(moved, "voice-lab", null).workspaces.map((workspace) => workspace.projects)).toEqual([["shop-app", "shop-backend"], [], []]);
  });

  test("a create takes its projects from other workspaces and sorts by name", () => {
    const created = createdLocally(view, { id: `w_${"f".repeat(32)}`, name: "Design", color: "pink", projects: ["voice-lab"], createdAt: "2026-10-20T10:00:00.000Z" });
    expect(created.workspaces.map((workspace) => [workspace.name, workspace.projects])).toEqual([
      ["Client work", ["shop-app", "shop-backend"]],
      ["Design", ["voice-lab"]],
      ["Empty", []],
      ["Research", []],
    ]);
  });

  test("rename re-sorts; delete drops the workspace", () => {
    expect(updatedLocally(view, CLIENT, { name: "Zeta" }).workspaces.map((workspace) => workspace.name)).toEqual(["Empty", "Research", "Zeta"]);
    expect(deletedLocally(view, EMPTY).workspaces.map((workspace) => workspace.id)).toEqual([CLIENT, RESEARCH]);
  });
});
