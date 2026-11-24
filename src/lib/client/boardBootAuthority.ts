"use client";

import { useEffect, useSyncExternalStore } from "react";
import { readTeamAuthority, refreshTeamView, subscribeTeamAuthority } from "@/components/team/teamClient";
import { indexedDbFilesSnapshotStore } from "./filesSnapshotStore";

type BoardBootAuthority = { scope: string | null; projects: readonly string[] | null; team: boolean };
type BoardBootState = { authority: BoardBootAuthority | null; suspended: boolean };

export const bootSnapshotStore = typeof window === "undefined" ? null : indexedDbFilesSnapshotStore();
const SIGN_OUT = "llv-board-sign-out";
const SIGN_IN = "llv-board-sign-in";
const CHECK_MS = 15_000;
const INITIAL_STATE: BoardBootState = { authority: null, suspended: false };
let state = INITIAL_STATE;
let ended = false;
let loading: { cancel: AbortController; done: Promise<void> } | null = null;
const listeners = new Set<() => void>();

export const subscribeBoardBootAuthority = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const readState = () => state;
export const readBoardBootAuthority = () => state.authority;
export const boardBootRetired = () => ended;
export function boardBootScopeFor(project: string): string | null {
  const { authority } = state;
  return authority && (authority.projects === null || authority.projects.includes(project)) ? authority.scope : null;
}

function publish(authority: BoardBootAuthority | null, suspended = false) {
  if (state.authority === authority && state.suspended === suspended) return;
  state = { authority, suspended };
  for (const listener of listeners) listener();
}

function retire(): void {
  ended = true;
  loading?.cancel.abort();
  publish(null);
}

async function clearBootData(): Promise<void> {
  try { localStorage.removeItem("llvBoards"); } catch { /* unavailable storage */ }
  const write = bootSnapshotStore?.clearBootData();
  if (!write) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([write, new Promise<void>(resolve => { timeout = setTimeout(resolve, 750); })])
    .finally(() => clearTimeout(timeout));
}

function announce(key: string): void {
  try { localStorage.setItem(key, `${Date.now()}-${Math.random()}`); } catch { /* unavailable storage */ }
}

export function clearBoardBootOnSignOut(): Promise<void> {
  retire();
  announce(SIGN_OUT);
  return clearBootData();
}

export function announceBoardSignIn(): void {
  announce(SIGN_IN);
}

function parseAuthority(value: unknown): BoardBootAuthority | null {
  if (!value || typeof value !== "object") return null;
  const { scope, projects, team } = value as BoardBootAuthority;
  if (scope !== null && (typeof scope !== "string" || !/^[0-9a-f]{64}$/.test(scope))) return null;
  if (projects !== null && (!Array.isArray(projects) || projects.some(project => typeof project !== "string"))) return null;
  if (typeof team !== "boolean") return null;
  return { scope, projects, team };
}

export function recheckBoardBoot(suspend = false): Promise<void> {
  if (ended) return Promise.resolve();
  const previous = state.authority;
  if (suspend && previous) {
    publish(previous, true);
    // A request sent before an account switch or a hidden interval cannot
    // confirm the newly visible document.
    loading?.cancel.abort();
    loading = null;
  }
  if (loading) return loading.done;
  const cancel = new AbortController();
  const done = (async () => {
    try {
      const response = await fetch("/api/team?view=board-access", {
        cache: "no-store", signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(12_000)]),
      });
      if (cancel.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        retire();
        void clearBootData();
        void refreshTeamView();
        return;
      }
      if (!response.ok) return;
      const next = parseAuthority(await response.json());
      if (!next || cancel.signal.aborted) return;
      if (previous && (previous.scope !== next.scope || previous.team !== next.team
        || JSON.stringify(previous.projects) !== JSON.stringify(next.projects))) {
        // The Viewer also has document-scoped files, layout and seat stores.
        // A new document starts all three under the replacement authority.
        retire();
        window.location.reload();
        return;
      }
      publish(previous ?? next);
    } catch { /* retry on visibility or the next check */ }
  })().finally(() => { if (loading?.cancel === cancel) loading = null; });
  loading = { cancel, done };
  return done;
}

export function useBoardBootAuthority(): BoardBootState {
  useEffect(() => {
    const check = () => {
      if (!document.hidden && (!state.authority || state.authority.team || state.suspended)) void recheckBoardBoot();
    };
    const hideTeamBoard = () => {
      if (!state.authority?.team) return;
      loading?.cancel.abort();
      loading = null;
      publish(state.authority, true);
    };
    const onVisibility = () => {
      if (document.hidden) hideTeamBoard();
      else check();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void recheckBoardBoot(true);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIGN_IN) {
        if (ended) window.location.reload();
        else void recheckBoardBoot(true);
      }
      if (event.key === SIGN_OUT) {
        retire();
        void refreshTeamView();
      }
    };
    const unsubscribe = subscribeTeamAuthority(() => {
      if (ended || !readTeamAuthority().signInRequired) return;
      retire();
      void clearBootData();
    });
    check();
    const timer = setInterval(check, CHECK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", hideTeamBoard);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", hideTeamBoard);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return useSyncExternalStore(subscribeBoardBootAuthority, readState, () => INITIAL_STATE);
}
