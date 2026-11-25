"use client";

import { useEffect, useSyncExternalStore } from "react";
import { readTeamAuthority, refreshTeamView, subscribeTeamAuthority } from "@/components/team/teamClient";
import { indexedDbFilesSnapshotStore } from "./filesSnapshotStore";
import { PROJECT_NAMES_STORAGE_KEY } from "./projectNameCache";

/*
 * What this browser may display from its own disk. The server reads of the
 * Viewer (files, layout, seat) authorize themselves and never wait for this
 * check. Saved data waits for it: the saved catalog, the saved project screen
 * and the saved layout are shown only under the scope the server names here.
 * A failed check shows nothing saved and retries with a short backoff; a
 * changed or refused identity ends this document.
 */
type BoardBootAuthority = { scope: string | null; projects: readonly string[] | null; team: boolean };
type BoardBootState = { authority: BoardBootAuthority | null; ended: boolean };

export const bootSnapshotStore = typeof window === "undefined" ? null : indexedDbFilesSnapshotStore();
const SIGN_OUT = "llv-board-sign-out";
const SIGN_IN = "llv-board-sign-in";
const CHECK_MS = 15_000;
const RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;
const INITIAL_STATE: BoardBootState = { authority: null, ended: false };
let state = INITIAL_STATE;
let loading: { cancel: AbortController; done: Promise<void> } | null = null;
/* The retry delay goes through one seam so a test drives the backoff by
   running the scheduled call, with no real waiting. */
export type RetryClock = { set(run: () => void, delay: number): unknown; clear(handle: unknown): void };
const REAL_CLOCK: RetryClock = { set: (run, delay) => setTimeout(run, delay), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
let retryClock = REAL_CLOCK;
let retryTimer: unknown = null;
let retryAttempt = 0;
const listeners = new Set<() => void>();

export const subscribeBoardBootAuthority = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const readState = () => state;
export const readBoardBootAuthority = () => state.authority;
export const boardBootRetired = () => state.ended;
export function boardBootScopeFor(project: string): string | null {
  const { authority } = state;
  return authority && (authority.projects === null || authority.projects.includes(project)) ? authority.scope : null;
}

/** A remembered project name belongs to the single operator's own browser: it
    is shown and written only under a confirmed solo scope, never before the
    server answers and never for a team member on a shared device. */
export function rememberedNamesAllowed(authority: BoardBootAuthority | null = state.authority): boolean {
  return Boolean(authority?.scope) && authority?.team === false;
}

/** True when the identity this read started under has since been replaced or
    ended. A read that started before the first answer has no identity to lose.
    A project list that widened or narrowed in place is the same identity: saved
    data is filtered by the current list when it is read or written. */
export function boardAccessChanged(started: BoardBootAuthority | null): boolean {
  return state.ended || (started !== null && (!state.authority || !sameIdentity(started, state.authority)));
}

function publish(next: BoardBootState) {
  if (state.authority === next.authority && state.ended === next.ended) return;
  state = next;
  for (const listener of listeners) listener();
}

function stopRetry(): void {
  if (retryTimer) retryClock.clear(retryTimer);
  retryTimer = null;
}

function retire(): void {
  stopRetry();
  loading?.cancel.abort();
  loading = null;
  publish({ authority: null, ended: true });
}

async function clearBootData(): Promise<void> {
  try {
    localStorage.removeItem("llvBoards");
    localStorage.removeItem(PROJECT_NAMES_STORAGE_KEY);
  } catch { /* unavailable storage */ }
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

/** Who is looking and with which rights. The project list is not part of it. */
const sameIdentity = (left: BoardBootAuthority, right: BoardBootAuthority) =>
  left.scope === right.scope && left.team === right.team;

const sameProjects = (left: readonly string[] | null, right: readonly string[] | null) =>
  left === right || (left !== null && right !== null && left.length === right.length && left.every((project, index) => project === right[index]));

/** Until the first answer, a failed check asks again after 1, 2, 4 and then
    every 8 seconds. Once an identity is confirmed the periodic check owns it. */
function retryLater(): void {
  if (retryTimer || state.ended || state.authority) return;
  const delay = RETRY_MS[Math.min(retryAttempt, RETRY_MS.length - 1)]!;
  retryAttempt += 1;
  retryTimer = retryClock.set(() => {
    retryTimer = null;
    if (!document.hidden) void recheckBoardBoot();
  }, delay);
}

/**
 * Ask the server who this document is. `fresh` drops a request that started
 * before a page restore, a hidden interval or an account switch, because its
 * answer cannot confirm the document now visible. A failed check changes
 * nothing that is on screen: only a refusal or a different identity ends the
 * document.
 */
export function recheckBoardBoot(fresh = false): Promise<void> {
  if (state.ended) return Promise.resolve();
  if (fresh) {
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
      if (!response.ok) { retryLater(); return; }
      const next = parseAuthority(await response.json());
      if (cancel.signal.aborted) return;
      if (!next) { retryLater(); return; }
      const previous = state.authority;
      if (previous && !sameIdentity(previous, next)) {
        // The Viewer also has document-scoped files, layout and seat stores.
        // A new document starts all three under the replacement authority.
        retire();
        window.location.reload();
        return;
      }
      stopRetry();
      retryAttempt = 0;
      // The same identity with another project list updates the list in place:
      // a project that left it shows no saved data from the next render on,
      // a project that joined it may show its saved data, and nothing reloads.
      publish({ authority: previous && sameProjects(previous.projects, next.projects) ? previous : next, ended: false });
    } catch {
      if (!cancel.signal.aborted) retryLater();
    }
  })().finally(() => { if (loading?.cancel === cancel) loading = null; });
  loading = { cancel, done };
  return done;
}

/** The identity this document may display saved data for. Subscription only. */
export function useBoardBootAuthorityValue(): BoardBootAuthority | null {
  return useSyncExternalStore(subscribeBoardBootAuthority, readBoardBootAuthority, () => null);
}

/** Runs the check for the document and reports whether it has ended. */
export function useBoardBootAuthority(): BoardBootState {
  useEffect(() => {
    const check = () => {
      if (document.hidden || state.ended) return;
      if (!state.authority || state.authority.team) void recheckBoardBoot();
    };
    const onVisibility = () => {
      if (document.hidden || state.ended) return;
      // A request sent before the tab was hidden cannot vouch for the account
      // now in this browser; the board stays on screen while the answer comes.
      if (state.authority?.team) void recheckBoardBoot(true);
      else check();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void recheckBoardBoot(true);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIGN_IN) {
        if (state.ended) window.location.reload();
        else void recheckBoardBoot(true);
      }
      if (event.key === SIGN_OUT) {
        retire();
        void refreshTeamView();
      }
    };
    const unsubscribe = subscribeTeamAuthority(() => {
      if (state.ended || !readTeamAuthority().signInRequired) return;
      retire();
      void clearBootData();
    });
    check();
    const timer = setInterval(check, CHECK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      clearInterval(timer);
      stopRetry();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return useSyncExternalStore(subscribeBoardBootAuthority, readState, () => INITIAL_STATE);
}

/** Test seam: the identity a test document has already confirmed. */
export function setBoardBootAuthorityForTests(authority: BoardBootAuthority | null): void {
  state = { authority, ended: false };
  for (const listener of listeners) listener();
}

/** Test seam: schedule the retries on a clock the test runs by hand. */
export function setBoardBootRetryClockForTests(clock: RetryClock): void {
  stopRetry();
  retryClock = clock;
}

/** Test seam: a new document starts with no answer and no retired state. */
export function resetBoardBootAuthorityForTests(): void {
  stopRetry();
  retryClock = REAL_CLOCK;
  loading?.cancel.abort();
  loading = null;
  retryAttempt = 0;
  state = INITIAL_STATE;
  for (const listener of listeners) listener();
}
