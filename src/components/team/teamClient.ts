"use client";

import { useEffect, useSyncExternalStore } from "react";

import { MEMBER_REQUIRED_CODE, memberInitials, type MessageSender, type TeamView } from "@/lib/team/contract";

/*
 * The browser's view of the team (sign-in-and-team §4.4): fetched once per
 * page from `GET /api/team` and shared by every component that draws a name.
 * A solo install answers `mode: "solo"` and nothing here draws anything.
 *
 * It is also the one place that learns a session ended: any `/api/*` answer
 * of 401 member_required (a revoked member, an expired session, a sign-out on
 * another tab) flips `signInRequired`, and the shell shows the sign-in panel.
 */

type TeamClientState = {
  view: TeamView | null;
  signInRequired: boolean;
};

let state: TeamClientState = { view: null, signInRequired: false };
let loading: Promise<void> | null = null;
let fetchWrapped = false;
const listeners = new Set<() => void>();

function emit(next: TeamClientState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshTeamView(): Promise<void> {
  if (typeof fetch !== "function") return;
  try {
    const response = await fetch("/api/team", { cache: "no-store" });
    if (response.status === 401) {
      emit({ ...state, signInRequired: true });
      return;
    }
    if (!response.ok) return;
    emit({ view: (await response.json()) as TeamView, signInRequired: false });
  } catch {
    /* the next page load asks again */
  }
}

function ensureLoaded(): void {
  if (typeof window === "undefined") return;
  loading ??= refreshTeamView();
  if (fetchWrapped || typeof window.fetch !== "function") return;
  fetchWrapped = true;
  const original = window.fetch.bind(window);
  /* Reads answers only: nothing is retried or changed. A clone is
     read only for a 401, which is rare and small. */
  const watched = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await original(...args);
    if (response.status === 401) {
      void response.clone().json().then((body: { code?: unknown }) => {
        if (body?.code === MEMBER_REQUIRED_CODE && !state.signInRequired) emit({ ...state, signInRequired: true });
      }).catch(() => {});
    }
    return response;
  };
  window.fetch = Object.assign(watched, original) as typeof fetch;
}

/** The team view; `load` asks the server once per page. Only the shell's
    guard and the team pages load it — a row that merely draws a name reads
    whatever is already here, so a component rendered on its own (a test, a
    fixture) asks nothing. */
export function useTeamView(options: { load?: boolean } = {}): TeamView | null {
  const load = options.load !== false;
  useEffect(() => {
    if (load) ensureLoaded();
  }, [load]);
  return useSyncExternalStore(subscribe, () => state.view, () => null);
}

export function useSignInRequired(): boolean {
  useEffect(ensureLoaded, []);
  return useSyncExternalStore(subscribe, () => state.signInRequired, () => false);
}

/** This browser's member as a sender, in a team; null otherwise. Passive. */
export function useMeAsSender(): MessageSender | null {
  const view = useTeamView({ load: false });
  const me = view?.mode === "team" ? view.me : null;
  return me ? { memberId: me.id, name: me.name, color: me.color, initials: memberInitials(me.name) } : null;
}

/** Tests only. */
export function setTeamViewForTests(view: TeamView | null, signInRequired = false): void {
  loading = Promise.resolve();
  emit({ view, signInRequired });
}
