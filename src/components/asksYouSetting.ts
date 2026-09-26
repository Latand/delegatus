"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { AsksYouSettingView } from "@/lib/asks/types";

/*
 * The "Asks you" switch on the client (docs/research/attention-classifier.md
 * §7). One setting for the installation, drawn by the board's ⋯ menu and the
 * phone's ⋯ sheet, so they share one read: a switch flipped in one shows in
 * the other at once.
 */

export interface AsksYouSettingState {
  /** Null until the first read answers. */
  view: AsksYouSettingView | null;
  saving: boolean;
  failed: boolean;
}

const EMPTY: AsksYouSettingState = { view: null, saving: false, failed: false };
let state: AsksYouSettingState = EMPTY;
const listeners = new Set<() => void>();
let read: Promise<void> | null = null;

function publish(next: AsksYouSettingState): void {
  state = next;
  for (const listener of listeners) listener();
}

function readView(): Promise<void> {
  if (read) return read;
  read = (async () => {
    try {
      const response = await fetch("/api/asks-you", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as AsksYouSettingView;
      if (!state.saving) publish({ view: body, saving: false, failed: false });
    } catch {
      /* The row stays disabled until a later read answers. */
    } finally {
      read = null;
    }
  })();
  return read;
}

async function writeEnabled(enabled: boolean): Promise<AsksYouSettingView | null> {
  try {
    const response = await fetch("/api/asks-you", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return response.ok ? await response.json() as AsksYouSettingView : null;
  } catch {
    return null;
  }
}

export function useAsksYouSetting(initial?: AsksYouSettingView): AsksYouSettingState & { toggle: () => void } {
  if (initial && state.view === null) state = { ...EMPTY, view: initial };
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const current = useSyncExternalStore(subscribe, () => state, () => state);

  /* Every open re-reads, so the spend counter is this month's. */
  useEffect(() => {
    if (initial) return;
    void readView();
  }, [initial]);

  const toggle = useCallback(() => {
    const view = state.view;
    if (!view || state.saving) return;
    const next = !view.enabled;
    publish({ view: { ...view, enabled: next }, saving: true, failed: false });
    void writeEnabled(next).then((answer) => {
      publish(answer ? { view: answer, saving: false, failed: false } : { view, saving: false, failed: true });
    });
  }, []);

  return { ...current, toggle };
}

export function resetAsksYouSettingForTests(): void {
  state = EMPTY;
  read = null;
}
