import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { persistProjectAliases, projectAliasResolver } from "@/lib/projects/aliases";

import type { Member } from "./contract";
import { claimInstall, TeamError } from "./members";
import { resetTeamStoreForTests, TeamStore, teamStore, teamStoreFile } from "./store";
import { createWorkspace, deleteWorkspace, placeProject, updateWorkspace, workspaceDirectory, type WorkspaceOptions } from "./workspaces";

/*
 * Workspaces, slice (a) (docs/design/workspaces.md §13.8 tests 1–3): the
 * record against a real SQLite file in a throw-away state directory, and
 * alias resolution against the real alias map in the same directory.
 */

const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const W1 = `w_${"1".repeat(32)}`;
const W2 = `w_${"2".repeat(32)}`;
const W3 = `w_${"3".repeat(32)}`;

let stateDir = "";
let store: TeamStore;
let owner: Member;
let tick = 0;
const previousStateDir = process.env.LLV_STATE_DIR;

/** A frozen clock that moves one second per write, so `added_at` orders. */
function options(extra: WorkspaceOptions = {}): WorkspaceOptions {
  return { now: () => new Date(Date.UTC(2026, 9, 20, 9, 0, tick++)), locale: "en", resolve: projectAliasResolver(), ...extra };
}

function refusal(run: () => unknown): { code: string; status: number } {
  try {
    run();
  } catch (error) {
    if (error instanceof TeamError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected a refusal");
}

function directory() {
  return workspaceDirectory(store, options());
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-workspaces-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
  tick = 0;
  store = teamStore();
  owner = claimInstall(store, "Mira", DESKTOP, Date.UTC(2026, 9, 20, 8)).member;
});

afterEach(() => {
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("the record", () => {
  test("create, rename, recolour and delete", () => {
    const { workspace, created } = createWorkspace(store, owner, { id: W1, name: "  Client   work ", color: "teal", projects: ["repo-b", "repo-a"] }, options());
    expect(created).toBe(true);
    expect(workspace).toEqual({ id: W1, name: "Client work", color: "teal", createdAt: "2026-10-20T09:00:00.000Z", projects: ["repo-a", "repo-b"] });
    expect(updateWorkspace(store, W1, { name: "Clients" }, options()).name).toBe("Clients");
    expect(updateWorkspace(store, W1, { color: "pink" }, options()).color).toBe("pink");
    expect(refusal(() => deleteWorkspace(store, W1, options()))).toEqual({ code: "workspace_not_empty", status: 409 });
    placeProject(store, owner, "repo-a", null, options());
    placeProject(store, owner, "repo-b", null, options());
    expect(deleteWorkspace(store, W1, options())).toBe(true);
    expect(deleteWorkspace(store, W1, options())).toBe(false);
    expect(directory().workspaces).toEqual([]);
    expect(store.workspaceProjectRows()).toEqual([]);
  });

  test("names: empty, 41 characters, and collisions in case or NFKC form", () => {
    expect(refusal(() => createWorkspace(store, owner, { id: W1, name: "   " }, options()))).toEqual({ code: "name_required", status: 400 });
    expect(refusal(() => createWorkspace(store, owner, { id: W1, name: "x".repeat(41) }, options()))).toEqual({ code: "name_too_long", status: 400 });
    /* Forty Cyrillic letters are forty characters, whatever their bytes. */
    expect(createWorkspace(store, owner, { id: W1, name: "ж".repeat(40) }, options()).workspace.name).toHaveLength(40);
    createWorkspace(store, owner, { id: W2, name: "Research" }, options());
    expect(refusal(() => createWorkspace(store, owner, { id: W3, name: "RESEARCH" }, options()))).toEqual({ code: "name_taken", status: 409 });
    /* Fullwidth letters read as the same name once NFKC-normalised. */
    expect(refusal(() => createWorkspace(store, owner, { id: W3, name: "Ｒｅｓｅａｒｃｈ" }, options()))).toEqual({ code: "name_taken", status: 409 });
    /* An invisible character does not make another name. */
    expect(refusal(() => createWorkspace(store, owner, { id: W3, name: "Re\u200bsearch" }, options()))).toEqual({ code: "name_taken", status: 409 });
    expect(refusal(() => updateWorkspace(store, W1, { name: "research" }, options()))).toEqual({ code: "name_taken", status: 409 });
    /* A workspace may keep its own name in another case. */
    expect(updateWorkspace(store, W2, { name: "RESEARCH" }, options()).name).toBe("RESEARCH");
    expect(refusal(() => createWorkspace(store, owner, { id: W3, name: "Ok", color: "magenta" }, options()))).toEqual({ code: "invalid_color", status: 400 });
    expect(refusal(() => createWorkspace(store, owner, { id: "w_short", name: "Ok" }, options()))).toEqual({ code: "invalid_id", status: 400 });
  });

  test("without a colour the first unused one is picked, then slate", () => {
    expect(createWorkspace(store, owner, { id: W1, name: "A", color: "coral" }, options()).workspace.color).toBe("coral");
    expect(createWorkspace(store, owner, { id: W2, name: "B" }, options()).workspace.color).toBe("amber");
    const colours = ["lime", "teal", "sky", "violet", "pink", "slate"];
    colours.forEach((_, index) => createWorkspace(store, owner, { id: `w_${String(index + 4).repeat(32)}`, name: `C${index}` }, options()));
    expect(createWorkspace(store, owner, { id: `w_${"a".repeat(32)}`, name: "D" }, options()).workspace.color).toBe("slate");
  });

  test("at most 64 workspaces", () => {
    for (let index = 0; index < 64; index += 1) {
      createWorkspace(store, owner, { id: `w_${index.toString(16).padStart(32, "0")}`, name: `W${index}` }, options());
    }
    expect(refusal(() => createWorkspace(store, owner, { id: `w_${"f".repeat(32)}`, name: "One more" }, options()))).toEqual({ code: "workspace_limit", status: 409 });
    /* A replay of one that exists is still answered. */
    expect(createWorkspace(store, owner, { id: `w_${"0".repeat(32)}`, name: "W0" }, options()).created).toBe(false);
  });

  test("a create replayed with its id and name makes one row; another name is id_taken", () => {
    createWorkspace(store, owner, { id: W1, name: "Client work", projects: ["repo-a"] }, options());
    const replay = createWorkspace(store, owner, { id: W1, name: "client WORK", projects: ["repo-a"] }, options());
    expect(replay.created).toBe(false);
    expect(replay.workspace.name).toBe("Client work");
    expect(store.workspaceRows()).toHaveLength(1);
    expect(store.workspaceProjectRows()).toHaveLength(1);
    expect(refusal(() => createWorkspace(store, owner, { id: W1, name: "Other" }, options()))).toEqual({ code: "id_taken", status: 409 });
  });

  test("project keys: trimmed, bounded, no control characters, never the Overview", () => {
    createWorkspace(store, owner, { id: W1, name: "A" }, options());
    for (const bad of ["", "   ", "__overview__", "a\u0007b", "x".repeat(201), 42, null]) {
      expect(refusal(() => placeProject(store, owner, bad, W1, options()))).toEqual({ code: "invalid_project", status: 400 });
    }
    expect(placeProject(store, owner, "  manual project  ", W1, options())).toEqual({ project: "manual project", workspaceId: W1 });
    expect(refusal(() => createWorkspace(store, owner, { id: W2, name: "B", projects: Array.from({ length: 501 }, (_, i) => `p${i}`) }, options()))).toEqual({ code: "too_many_projects", status: 400 });
    expect(refusal(() => createWorkspace(store, owner, { id: W2, name: "B", projects: ["ok", "__overview__"] }, options()))).toEqual({ code: "invalid_project", status: 400 });
    /* A refused create wrote nothing. */
    expect(store.workspaceRows().map((row) => row.id)).toEqual([W1]);
  });

  test("placing moves a project between workspaces and back, keeping one row", () => {
    createWorkspace(store, owner, { id: W1, name: "A" }, options());
    createWorkspace(store, owner, { id: W2, name: "B" }, options());
    placeProject(store, owner, "repo-a", W1, options());
    const first = store.workspaceProjectRows()[0]!.addedAt;
    /* The same request again changes nothing, its first time included. */
    placeProject(store, owner, "repo-a", W1, options());
    expect(store.workspaceProjectRows()).toEqual([{ project: "repo-a", workspaceId: W1, addedAt: first, addedBy: owner.id }]);
    placeProject(store, owner, "repo-a", W2, options());
    expect(store.workspaceProjectRows().map((row) => [row.project, row.workspaceId])).toEqual([["repo-a", W2]]);
    expect(directory().workspaceOf("repo-a")).toBe(W2);
    placeProject(store, owner, "repo-a", null, options());
    expect(store.workspaceProjectRows()).toEqual([]);
    expect(directory().workspaceOf("repo-a")).toBeNull();
    expect(refusal(() => placeProject(store, owner, "repo-a", W3, options()))).toEqual({ code: "workspace_gone", status: 404 });
    expect(refusal(() => updateWorkspace(store, W3, { name: "Gone" }, options()))).toEqual({ code: "workspace_gone", status: 404 });
  });

  test("a create that checks a project from another workspace moves it", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["repo-a", "repo-b"] }, options());
    createWorkspace(store, owner, { id: W2, name: "B", projects: ["repo-b"] }, options());
    expect(directory().workspaces.map((workspace) => [workspace.name, workspace.projects])).toEqual([["A", ["repo-a"]], ["B", ["repo-b"]]]);
  });

  test("workspaces are sorted by name in the installation's language", () => {
    createWorkspace(store, owner, { id: W1, name: "Ґанок" }, options());
    createWorkspace(store, owner, { id: W2, name: "Вітер" }, options());
    createWorkspace(store, owner, { id: W3, name: "Глина" }, options());
    expect(workspaceDirectory(store, options({ locale: "uk" })).workspaces.map((workspace) => workspace.name)).toEqual(["Вітер", "Глина", "Ґанок"]);
  });
});

describe("alias resolution", () => {
  const alias = (source: string, target: string) => expect(persistProjectAliases([{ source, target, displayName: target }])).toBe(true);

  test("(a) a project placed as dir-a is repo-b's once the alias is recorded", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-a"] }, options());
    alias("dir-a", "repo-b");
    const after = directory();
    expect(after.workspaces[0]!.projects).toEqual(["repo-b"]);
    expect(after.workspaceOf("repo-b")).toBe(W1);
    expect(after.workspaceOf("dir-a")).toBe(W1);
  });

  test("(b) both keys placed before the alias: the row under the canonical key wins", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-a"] }, options());
    createWorkspace(store, owner, { id: W2, name: "B", projects: ["repo-b"] }, options());
    alias("dir-a", "repo-b");
    const after = directory();
    expect(after.workspaceOf("repo-b")).toBe(W2);
    expect(after.workspaces.map((workspace) => [workspace.id, workspace.projects])).toEqual([[W1, []], [W2, ["repo-b"]]]);
    /* The losing row stays in the table, ignored. */
    expect(store.workspaceProjectRows()).toHaveLength(2);
  });

  test("(b') without a row under the canonical key, the earliest placed wins", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-b"] }, options());
    createWorkspace(store, owner, { id: W2, name: "B", projects: ["dir-a"] }, options());
    alias("dir-a", "repo-c");
    alias("dir-b", "repo-c");
    expect(directory().workspaceOf("repo-c")).toBe(W1);
  });

  test("(c) a move after (b) leaves one row, under repo-b", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-a"] }, options());
    createWorkspace(store, owner, { id: W2, name: "B", projects: ["repo-b"] }, options());
    alias("dir-a", "repo-b");
    expect(placeProject(store, owner, "dir-a", W1, options())).toEqual({ project: "repo-b", workspaceId: W1 });
    expect(store.workspaceProjectRows().map((row) => [row.project, row.workspaceId])).toEqual([["repo-b", W1]]);
  });

  test("(d) a delete check counts a project held only through an alias", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-a"] }, options());
    alias("dir-a", "repo-b");
    expect(refusal(() => deleteWorkspace(store, W1, options()))).toEqual({ code: "workspace_not_empty", status: 409 });
    placeProject(store, owner, "repo-b", null, options());
    expect(store.workspaceProjectRows()).toEqual([]);
    expect(deleteWorkspace(store, W1, options())).toBe(true);
  });

  test("(d') deleting a workspace whose only row lost to an alias leaves no row behind", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-a"] }, options());
    createWorkspace(store, owner, { id: W2, name: "B", projects: ["repo-b"] }, options());
    alias("dir-a", "repo-b");
    expect(deleteWorkspace(store, W1, options())).toBe(true);
    expect(store.workspaceProjectRows().map((row) => [row.project, row.workspaceId])).toEqual([["repo-b", W2]]);
  });

  test("(e) a chain dir- → repo-<local> → repo-<remote> resolves to the last key", () => {
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-a"] }, options());
    alias("dir-a", "repo-local");
    alias("repo-local", "repo-remote");
    const after = directory();
    expect(after.workspaces[0]!.projects).toEqual(["repo-remote"]);
    expect(after.workspaceOf("dir-a")).toBe(W1);
    expect(placeProject(store, owner, "repo-local", null, options())).toEqual({ project: "repo-remote", workspaceId: null });
    expect(store.workspaceProjectRows()).toEqual([]);
  });

  test("a write canonicalizes the key it is given", () => {
    alias("dir-a", "repo-b");
    createWorkspace(store, owner, { id: W1, name: "A", projects: ["dir-a", "repo-b"] }, options());
    expect(store.workspaceProjectRows().map((row) => row.project)).toEqual(["repo-b"]);
  });
});

describe("schema", () => {
  test("a store written before workspaces opens, gains workspace tables and keeps schema 1 and its indexes", () => {
    resetTeamStoreForTests();
    const filename = teamStoreFile();
    /* Rewind the file to what the release before wrote: no workspace tables. */
    const legacy = new Database(filename);
    const indexesBefore = legacy.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_workspaces%' ORDER BY name").all();
    legacy.exec("DROP TABLE workspaces");
    legacy.exec("DROP TABLE workspace_projects");
    legacy.exec("DROP TABLE workspace_members");
    legacy.exec("DROP TABLE workspace_defaults");
    legacy.close();
    const reopened = new TeamStore(filename);
    try {
      const db = new Database(filename, { readonly: true });
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workspace%' ORDER BY name").all();
      expect(tables.map((row) => row.name)).toEqual(["workspace_defaults", "workspace_members", "workspace_projects", "workspaces"]);
      expect(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get()?.value).toBe("1");
      const indexesAfter = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_workspaces%' ORDER BY name").all();
      expect(indexesAfter).toEqual(indexesBefore);
      db.close();
      expect(reopened.member(owner.id)?.name).toBe("Mira");
    } finally {
      reopened.close();
    }
  });
});
