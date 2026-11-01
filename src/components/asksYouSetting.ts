"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { onServiceSettled } from "@/components/keys/openKeys";
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
/* A read asked for while one is on its way that may have begun before what changed: it runs once that one ends. */
let again = false;
/* Bumped when a write begins and when it settles: a read that began in another epoch answers from before what the write did. */
let epoch = 0;
/* A read that answered while a write was on its way, which may carry a provider chosen since: it runs again once the write settles. */
let missed = false;
/* The read after a refused write keeps the refusal on the row. */
let keepFailed = false;

function publish(next: AsksYouSettingState): void {
  state = next;
  for (const listener of listeners) listener();
}

function readView(fresh = false): Promise<void> {
  if (read) { again ||= fresh; return read; }
  const begun = epoch;
  read = (async () => {
    try {
      const response = await fetch("/api/asks-you", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as AsksYouSettingView;
      if (state.saving) missed = true;
      else if (begun !== epoch) again = true;
      else { publish({ view: body, saving: false, failed: keepFailed && state.failed }); keepFailed = false; }
    } catch {
      /* The row stays disabled until a later read answers. */
    } finally {
      read = null;
      if (again) { again = false; void readView(); }
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
    /* A key saved or a provider chosen in «Keys» changes what the hint names. */
    const refresh = () => void readView(true);
    window.addEventListener("delegatus:provider-key-changed", refresh);
    const offService = onServiceSettled("asks", refresh);
    return () => { offService(); window.removeEventListener("delegatus:provider-key-changed", refresh); };
  }, [initial]);

  const toggle = useCallback(() => {
    const view = state.view;
    if (!view || state.saving) return;
    const next = !view.enabled;
    epoch++;
    publish({ view: { ...view, enabled: next }, saving: true, failed: false });
    void writeEnabled(next).then((answer) => {
      epoch++;
      /* The answer, or the view before the switch, may name a provider chosen under «Keys» while this was saving: a read that answered meanwhile runs again. */
      publish(answer ? { view: answer, saving: false, failed: false } : { view, saving: false, failed: true });
      if (missed) { missed = false; keepFailed = !answer; void readView(true); }
    });
  }, []);

  return { ...current, toggle };
}

export function resetAsksYouSettingForTests(): void {
  state = EMPTY;
  read = null;
  again = false;
  epoch = 0;
  missed = false;
  keepFailed = false;
}
