"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  cleanWorkspaceName,
  MEMBER_COLORS,
  WORKSPACE_NAME_MAX,
  workspaceNameKey,
  type MemberColor,
  type Workspace,
  type WorkspacesView,
} from "@/lib/team/contract";

import { teamRequest } from "./ui";
import { ALL_WORKSPACES, createdLocally, deletedLocally, placedLocally, updatedLocally, type CurrentWorkspace, type TeamWorkspaces } from "./workspaceFilter";

/*
 * The browser's workspaces (docs/design/workspaces.md §13.4): one store for
 * every hook, like `teamClient.ts`. It asks `GET /api/team/workspaces` when
 * something first subscribes on a team install, again when the tab becomes
 * visible, and after each write; nothing polls. Writes are optimistic: the
 * directory shows the result on the click and the request runs behind it. A
 * refusal puts back the last answer the server confirmed and is returned to
 * the caller, which shows it where the action was taken.
 */

type Store = {
  /** The last answer the server gave. */
  confirmed: WorkspacesView | null;
  /** What is drawn: the confirmed answer with the writes still in flight. */
  shown: WorkspacesView | null;
};

let store: Store = { confirmed: null, shown: null };
const listeners = new Set<() => void>();
let subscribers = 0;
let catalogSubscribers = 0;
let inFlight: Promise<void> | null = null;
let again = false;
let pendingWrites = 0;
let visibilityWatched = false;

function emit(next: Store): void {
  store = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the server's answer once, or once more after the read in flight. */
export function refreshWorkspaces(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      again = false;
      const answer = await teamRequest<WorkspacesView>(`/api/team/workspaces${catalogSubscribers > 0 ? "?catalog=1" : ""}`);
      if (!answer.ok) continue;
      /* A write still in flight keeps its optimistic picture; the answer after
         it lands replaces both. */
      emit({ confirmed: answer.body, shown: pendingWrites > 0 ? store.shown : answer.body });
    } while (again);
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function watchVisibility(): void {
  if (visibilityWatched || typeof document === "undefined") return;
  visibilityWatched = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && subscribers > 0) void refreshWorkspaces();
  });
}

/** The workspaces as drawn; null while loading, and always null when
    `enabled` is false (a solo install never asks). `catalog` adds every
    project the installation knows, for the pages that place them. */
export function useWorkspaces({ enabled = true, catalog = false }: { enabled?: boolean; catalog?: boolean } = {}): WorkspacesView | null {
  useEffect(() => {
    if (!enabled) return;
    subscribers += 1;
    if (catalog) catalogSubscribers += 1;
    watchVisibility();
    if (!store.confirmed || (catalog && store.confirmed.mode === "team" && !store.confirmed.catalog)) void refreshWorkspaces();
    return () => {
      subscribers -= 1;
      if (catalog) catalogSubscribers -= 1;
    };
  }, [enabled, catalog]);
  const view = useSyncExternalStore(subscribe, () => store.shown, () => null);
  return enabled ? view : null;
}

export type WriteResult = { ok: true } | { ok: false; code: string | null; error: string };

async function optimistic(local: (view: TeamWorkspaces) => TeamWorkspaces, request: () => ReturnType<typeof teamRequest>): Promise<WriteResult> {
  const before = store.shown;
  if (before?.mode !== "team") return { ok: false, code: "team_unavailable", error: "no team" };
  pendingWrites += 1;
  emit({ ...store, shown: local(before) });
  const answer = await request();
  pendingWrites -= 1;
  if (!answer.ok) {
    /* Back to what the server last confirmed, then the server's word. */
    emit({ ...store, shown: store.confirmed });
    void refreshWorkspaces();
    return { ok: false, code: answer.code, error: answer.error };
  }
  await refreshWorkspaces();
  return { ok: true };
}

/** "w_" and 16 random bytes in hex: the client's key for a create, so a
    retry of a lost answer is the same create. */
export function mintWorkspaceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `w_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The first colour no workspace uses, or slate: the server's own default. */
export function nextWorkspaceColor(workspaces: readonly Workspace[]): MemberColor {
  const used = new Set(workspaces.map((workspace) => workspace.color));
  return MEMBER_COLORS.find((color) => !used.has(color)) ?? "slate";
}

/** The name refusals the browser can see before asking: the server checks
    them again. */
export function workspaceNameProblem(view: TeamWorkspaces, name: string, exceptId: string | null = null): "name_required" | "name_too_long" | "name_taken" | null {
  const cleaned = cleanWorkspaceName(name);
  if (!cleaned) return "name_required";
  if ([...cleaned].length > WORKSPACE_NAME_MAX) return "name_too_long";
  const key = workspaceNameKey(cleaned);
  return view.workspaces.some((workspace) => workspace.id !== exceptId && workspaceNameKey(workspace.name) === key) ? "name_taken" : null;
}

export function createWorkspace(input: { id: string; name: string; color: MemberColor; projects: readonly string[] }): Promise<WriteResult> {
  const name = cleanWorkspaceName(input.name) ?? input.name;
  return optimistic(
    (view) => createdLocally(view, { ...input, name, createdAt: new Date().toISOString() }),
    () => teamRequest("/api/team/workspaces", { body: { id: input.id, name, color: input.color, projects: input.projects } }),
  );
}

export function updateWorkspace(id: string, patch: { name?: string; color?: MemberColor }): Promise<WriteResult> {
  const name = patch.name === undefined ? undefined : cleanWorkspaceName(patch.name) ?? patch.name;
  return optimistic(
    (view) => updatedLocally(view, id, { ...patch, ...(name === undefined ? {} : { name }) }),
    () => teamRequest(`/api/team/workspaces/${id}`, { method: "PATCH", body: { ...patch, ...(name === undefined ? {} : { name }) } }),
  );
}

export function deleteWorkspace(id: string): Promise<WriteResult> {
  return optimistic((view) => deletedLocally(view, id), () => teamRequest(`/api/team/workspaces/${id}`, { method: "DELETE" }));
}

/** Add, Remove and Move to…: `null` puts the project back in Unassigned. */
export function placeProject(project: string, workspaceId: string | null): Promise<WriteResult> {
  return optimistic((view) => placedLocally(view, project, workspaceId), () => teamRequest("/api/team/workspace-projects", { method: "PUT", body: { project, workspaceId } }));
}

/* ---- the current workspace, per browser (§13.1.1) ------------------------- */

export const WORKSPACE_STORAGE_KEY = "llv:workspace:v1";
const currentListeners = new Set<() => void>();
let unsavedCurrent: string | null = null;

function readCurrent(): string {
  try {
    return unsavedCurrent ?? window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? ALL_WORKSPACES;
  } catch {
    return unsavedCurrent ?? ALL_WORKSPACES; /* private mode: the choice holds for this page */
  }
}

/** The stored choice, `"all"` or an id; `effectiveWorkspace` says how it applies. */
export function useStoredWorkspace(): [CurrentWorkspace, (next: CurrentWorkspace) => void] {
  const value = useSyncExternalStore(
    (notify) => {
      currentListeners.add(notify);
      return () => { currentListeners.delete(notify); };
    },
    readCurrent,
    () => ALL_WORKSPACES,
  );
  const set = useCallback((next: CurrentWorkspace) => {
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, next);
      unsavedCurrent = null;
    } catch {
      unsavedCurrent = next;
    }
    for (const notify of currentListeners) notify();
  }, []);
  return [value, set];
}

/** Tests and fixtures only. */
export function setWorkspacesForTests(view: WorkspacesView | null): void {
  pendingWrites = 0;
  emit({ confirmed: view, shown: view });
}
