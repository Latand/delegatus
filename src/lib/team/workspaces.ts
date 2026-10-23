import { projectDisplayName } from "@/lib/displayNames";
import { operatorLocale } from "@/lib/operator/settings";
import { projectAliasResolver } from "@/lib/projects/aliases";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { conversationCatalogReady, conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";

import {
  cleanWorkspaceName,
  cleanWorkspaceProject,
  isMemberColor,
  isWorkspaceId,
  MEMBER_COLORS,
  WORKSPACE_CREATE_PROJECTS_MAX,
  WORKSPACE_LIMIT,
  WORKSPACE_NAME_MAX,
  workspaceNameKey,
  type Member,
  type MemberColor,
  type Workspace,
  type WorkspaceCatalogProject,
} from "./contract";
import { TeamError } from "./members";
import type { StoredWorkspace, StoredWorkspaceProject, TeamStore } from "./store";

/*
 * The workspace directory and its project placement. Reads are scoped by
 * workspaceAccess; placement checks its writer inside the store transaction.
 *
 * A project is placed under the key `canonicalProject` answers when it is
 * written. The alias map is a separate store that can later join two keys, so
 * every row is resolved again when it is read, against one alias snapshot per
 * batch, and several rows may then name one project. The directory picks one
 * of them; every write deletes all the rows that resolve to the project it
 * touches before writing at most one, so the store repairs itself as it is used.
 */

export type ProjectResolver = (project: string) => string;

export interface WorkspaceOptions {
  /** One alias snapshot for the whole call; the live map by default. */
  resolve?: ProjectResolver;
  /** The installation's language, for the order of names. */
  locale?: string;
  now?: () => Date;
}

export interface WorkspaceDirectory {
  /** Sorted by name; each lists its canonical project keys, sorted. */
  workspaces: Workspace[];
  /** The workspace holding a canonical key, or null for Unassigned. */
  workspaceOf(project: string): string | null;
}

/** What a route passes: one alias snapshot for the request, and the
    installation's language for the order of names. */
export function requestWorkspaceOptions(): WorkspaceOptions {
  return { resolve: projectAliasResolver(), locale: operatorLocale() ?? "en" };
}

function resolverOf(options: WorkspaceOptions): ProjectResolver {
  return options.resolve ?? projectAliasResolver();
}

function nowIso(options: WorkspaceOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Which of several rows naming one project stands: the row stored under the
    canonical key itself, then the earliest placed, then the lowest raw key. */
function winningRow(canonical: string, rows: readonly StoredWorkspaceProject[]): StoredWorkspaceProject {
  return [...rows].sort((a, b) => (
    Number(b.project === canonical) - Number(a.project === canonical)
    || compareCodeUnits(a.addedAt, b.addedAt)
    || compareCodeUnits(a.project, b.project)
  ))[0]!;
}

function rowsByProject(store: TeamStore, resolve: ProjectResolver, known: ReadonlySet<string>): Map<string, StoredWorkspaceProject[]> {
  const grouped = new Map<string, StoredWorkspaceProject[]>();
  for (const row of store.workspaceProjectRows()) {
    if (!known.has(row.workspaceId)) continue;
    const canonical = resolve(row.project);
    const rows = grouped.get(canonical);
    if (rows) rows.push(row);
    else grouped.set(canonical, [row]);
  }
  return grouped;
}

function colorOf(row: StoredWorkspace): MemberColor {
  return isMemberColor(row.color) ? row.color : "slate";
}

export function workspaceDirectory(store: TeamStore, options: WorkspaceOptions = {}): WorkspaceDirectory {
  const resolve = resolverOf(options);
  const rows = store.workspaceRows();
  const known = new Set(rows.map((row) => row.id));
  const placed = new Map<string, string>();
  for (const [canonical, held] of rowsByProject(store, resolve, known)) placed.set(canonical, winningRow(canonical, held).workspaceId);
  const projects = new Map<string, string[]>(rows.map((row) => [row.id, []]));
  for (const [canonical, workspaceId] of placed) projects.get(workspaceId)!.push(canonical);
  const collator = new Intl.Collator(options.locale ?? "en", { sensitivity: "base", numeric: true });
  const workspaces = rows
    .map((row): Workspace => ({
      id: row.id,
      name: row.name,
      color: colorOf(row),
      createdAt: row.createdAt,
      projects: projects.get(row.id)!.sort(compareCodeUnits),
    }))
    .sort((a, b) => collator.compare(a.name, b.name) || compareCodeUnits(a.id, b.id));
  return {
    workspaces,
    workspaceOf: (project) => placed.get(resolve(project)) ?? null,
  };
}

function nameOf(value: unknown): { name: string; nameKey: string } {
  const name = cleanWorkspaceName(value);
  if (!name) throw new TeamError("name_required", "give the workspace a name");
  if ([...name].length > WORKSPACE_NAME_MAX) throw new TeamError("name_too_long", `a workspace name is at most ${WORKSPACE_NAME_MAX} characters`);
  return { name, nameKey: workspaceNameKey(name) };
}

function assertNameFree(store: TeamStore, nameKey: string, exceptId: string | null): void {
  if (store.workspaceRows().some((row) => row.nameKey === nameKey && row.id !== exceptId)) {
    throw new TeamError("name_taken", "a workspace with this name exists", 409);
  }
}

function colorFrom(value: unknown): MemberColor {
  if (!isMemberColor(value)) throw new TeamError("invalid_color", "not one of the member colours");
  return value;
}

function projectKey(value: unknown): string {
  const key = cleanWorkspaceProject(value);
  if (!key) throw new TeamError("invalid_project", "not a project key");
  return key;
}

function workspaceIdFrom(value: unknown): string {
  if (!isWorkspaceId(value)) throw new TeamError("invalid_id", "a workspace id is w_ and 32 hex digits");
  return value;
}

function workspaceById(store: TeamStore, id: string, options: WorkspaceOptions): Workspace | null {
  return workspaceDirectory(store, options).workspaces.find((workspace) => workspace.id === id) ?? null;
}

/** Deletes every row that resolves to `canonical`, then writes one row for
    it unless it goes back to Unassigned. A placement already in its final
    shape is left alone, so a repeated request keeps its first `added_at`. */
function writePlacement(store: TeamStore, resolve: ProjectResolver, canonical: string, workspaceId: string | null, actor: Member, at: string): void {
  const held = store.workspaceProjectRows().filter((row) => resolve(row.project) === canonical);
  if (workspaceId && held.length === 1 && held[0]!.project === canonical && held[0]!.workspaceId === workspaceId) return;
  if (!workspaceId && !held.length) return;
  store.deleteWorkspaceProjects(held.map((row) => row.project));
  if (workspaceId) store.insertWorkspaceProject({ project: canonical, workspaceId, addedAt: at, addedBy: actor.id });
}

export interface CreateWorkspaceInput {
  id: unknown;
  name: unknown;
  color?: unknown;
  projects?: unknown;
}

/**
 * Creates a workspace with the id the client minted. A replay with the same
 * id and the same name answers the stored workspace (`created: false`), so a
 * lost answer retried with its key never makes a second one; the same id with
 * another name is refused.
 */
export function createWorkspace(store: TeamStore, actor: Member, input: CreateWorkspaceInput, options: WorkspaceOptions = {}): { workspace: Workspace; created: boolean } {
  const id = workspaceIdFrom(input.id);
  const { name, nameKey } = nameOf(input.name);
  const color = input.color === undefined || input.color === null ? null : colorFrom(input.color);
  if (input.projects !== undefined && !Array.isArray(input.projects)) throw new TeamError("invalid_project", "projects is a list of project keys");
  const raw = (input.projects ?? []) as unknown[];
  if (raw.length > WORKSPACE_CREATE_PROJECTS_MAX) throw new TeamError("too_many_projects", `at most ${WORKSPACE_CREATE_PROJECTS_MAX} projects in one create`);
  const keys = raw.map(projectKey);
  const resolve = resolverOf(options);
  const scoped = { ...options, resolve };
  const at = nowIso(options);
  const created = store.transaction(() => {
    const rows = store.workspaceRows();
    const existing = rows.find((row) => row.id === id);
    if (existing) {
      if (existing.nameKey !== nameKey) throw new TeamError("id_taken", "this workspace id names another workspace", 409);
      return false;
    }
    if (rows.length >= WORKSPACE_LIMIT) throw new TeamError("workspace_limit", `at most ${WORKSPACE_LIMIT} workspaces`, 409);
    assertNameFree(store, nameKey, null);
    const used = new Set(rows.map((row) => row.color));
    store.insertWorkspace({
      id,
      name,
      nameKey,
      color: color ?? MEMBER_COLORS.find((candidate) => !used.has(candidate)) ?? "slate",
      createdAt: at,
      createdBy: actor.id,
      updatedAt: at,
    });
    for (const canonical of new Set(keys.map(resolve))) writePlacement(store, resolve, canonical, id, actor, at);
    return true;
  });
  return { workspace: workspaceById(store, id, scoped)!, created };
}

export function updateWorkspace(store: TeamStore, id: unknown, patch: { name?: unknown; color?: unknown }, options: WorkspaceOptions = {}): Workspace {
  const workspaceId = workspaceIdFrom(id);
  const named = patch.name === undefined ? null : nameOf(patch.name);
  const color = patch.color === undefined ? null : colorFrom(patch.color);
  const at = nowIso(options);
  store.transaction(() => {
    const row = store.workspaceRows().find((candidate) => candidate.id === workspaceId);
    if (!row) throw new TeamError("workspace_gone", "this workspace was deleted", 404);
    if (named) assertNameFree(store, named.nameKey, workspaceId);
    const next: StoredWorkspace = { ...row, ...(named ?? {}), color: color ?? row.color };
    if (next.name === row.name && next.color === row.color) return;
    store.updateWorkspace({ ...next, updatedAt: at });
  });
  return workspaceById(store, workspaceId, options)!;
}

/** Deletes an empty workspace. False when it was already gone; refused while
    the directory gives it any project, an alias-held one included. */
export function deleteWorkspace(store: TeamStore, id: unknown, options: WorkspaceOptions = {}): boolean {
  const workspaceId = workspaceIdFrom(id);
  const scoped = { ...options, resolve: resolverOf(options) };
  return store.transaction(() => {
    const workspace = workspaceById(store, workspaceId, scoped);
    if (!workspace) return false;
    if (workspace.projects.length) throw new TeamError("workspace_not_empty", "move its projects out first", 409);
    return store.deleteWorkspace(workspaceId);
  });
}

/** Puts one project in a workspace, or back in Unassigned with `null`: Add,
    Remove and Move to… are all this call. Answers the canonical key. */
export function placeProject(store: TeamStore, actor: Member, project: unknown, workspaceId: unknown, options: WorkspaceOptions = {}): { project: string; workspaceId: string | null } {
  const key = projectKey(project);
  const target = workspaceId === null ? null : workspaceIdFrom(workspaceId);
  const resolve = resolverOf(options);
  const canonical = resolve(key);
  const at = nowIso(options);
  store.transaction(() => {
    const live = store.member(actor.id);
    if (!live || live.status !== "active") throw new TeamError("workspace_forbidden", "workspace access denied", 403);
    if (live.role !== "owner") {
      const roles = store.workspaceMemberships(live.id);
      const manages = (id: string) => roles.some(row => row.workspaceId === id && row.role === "manager");
      const directory = workspaceDirectory(store, { ...options, resolve });
      const source = directory.workspaceOf(canonical);
      if (!directory.workspaces.some(workspace => manages(workspace.id)) || (target && !manages(target)) || (source && !manages(source))) {
        throw new TeamError("workspace_forbidden", "workspace access denied", 403);
      }
    }
    if (target && !store.workspaceRows().some((row) => row.id === target)) throw new TeamError("workspace_gone", "this workspace was deleted", 404);
    writePlacement(store, resolve, canonical, target, actor, at);
  });
  return { project: canonical, workspaceId: target };
}

/**
 * Every project the installation knows, one row per canonical key: one pass
 * over the conversation catalog the scanner already holds in memory, then the
 * manual projects. Read only by the Team page's Workspaces tab and the
 * workspace page, when they open and after their own writes.
 */
export function workspaceCatalog(options: { resolve?: ProjectResolver } = {}): { ready: boolean; projects: WorkspaceCatalogProject[] } {
  const resolve = options.resolve ?? projectAliasResolver();
  const rows = new Map<string, { smt: number; named: string | null; namedAt: number }>();
  for (const entry of conversationCatalogSnapshot()) {
    const project = resolve(entry.project);
    const row = rows.get(project);
    const mtime = Number.isFinite(entry.mtime) ? entry.mtime : 0;
    const named = entry.projectName?.trim() || null;
    if (!row) {
      rows.set(project, { smt: mtime, named, namedAt: named ? mtime : -Infinity });
      continue;
    }
    if (mtime > row.smt) row.smt = mtime;
    if (named && mtime > row.namedAt) {
      row.named = named;
      row.namedAt = mtime;
    }
  }
  const manualNames = new Map<string, string>();
  for (const manual of projectCurationSnapshot().manualProjects) {
    const project = resolve(manual.project);
    manualNames.set(project, manual.displayName);
    const row = rows.get(project);
    if (!row) rows.set(project, { smt: manual.createdAt, named: null, namedAt: -Infinity });
  }
  const projects = [...rows].map(([project, row]): WorkspaceCatalogProject => ({
    project,
    displayName: projectDisplayName(project, row.named ?? manualNames.get(project)),
    smt: row.smt,
  }));
  projects.sort((a, b) => b.smt - a.smt || compareCodeUnits(a.project, b.project));
  return { ready: conversationCatalogReady(), projects };
}
