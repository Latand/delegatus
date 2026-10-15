"use client";

import { useSyncExternalStore } from "react";

/*
 * PROTOTYPE ONLY (docs/design/full-autonomy-mode.md §6.2). This lane's branch
 * is never merged: the real build reads the mode from the settings answer's
 * `autonomy` block. Here it is held in the page so the three running borders
 * can be compared on the real switch and the real panel.
 *
 * What picks the state, first match wins:
 *   - the query: `?autonomy=on|unlimited|off` and `?autonomyVariant=1|2|3`;
 *   - the local flag `localStorage["llv_autonomy_prototype"]`, a JSON object
 *     `{ "state": "on" | "unlimited" | "off", "variant": 1 | 2 | 3 }`;
 *   - off, variant 1.
 * Saving the panel's «Повна автономія» section writes the local flag, so the
 * chip follows the panel without a server.
 */

export type AutonomyVariant = 1 | 2 | 3;
export type AutonomyState = "on" | "unlimited" | "off";

export interface AutonomyPrototype {
  variant: AutonomyVariant;
  state: AutonomyState;
  /** When the episode started and when it ends; null `until` is no end. */
  startedAt: string | null;
  until: string | null;
}

const KEY = "llv_autonomy_prototype";
/** An episode in progress: started 2 h 48 min ago, 5 h 12 min left of 8 h. */
const STARTED_AGO_MS = (2 * 60 + 48) * 60_000;
const LEFT_MS = (5 * 60 + 12) * 60_000;

const variantOf = (value: unknown): AutonomyVariant | null => (value === 1 || value === 2 || value === 3 ? value : value === "1" ? 1 : value === "2" ? 2 : value === "3" ? 3 : null);
const stateOf = (value: unknown): AutonomyState | null => (value === "on" || value === "unlimited" || value === "off" ? value : null);

function stored(): { state?: AutonomyState; variant?: AutonomyVariant } {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { state: stateOf(parsed.state) ?? undefined, variant: variantOf(parsed.variant) ?? undefined };
  } catch {
    return {};
  }
}

function episode(state: AutonomyState, hours: number | null, now: number): Pick<AutonomyPrototype, "startedAt" | "until"> {
  if (state === "off") return { startedAt: null, until: null };
  if (state === "unlimited") return { startedAt: new Date(now - STARTED_AGO_MS).toISOString(), until: null };
  return hours === null
    ? { startedAt: new Date(now - STARTED_AGO_MS).toISOString(), until: new Date(now + LEFT_MS).toISOString() }
    : { startedAt: new Date(now).toISOString(), until: new Date(now + hours * 3_600_000).toISOString() };
}

function initial(): AutonomyPrototype {
  if (typeof window === "undefined") return { variant: 1, state: "off", startedAt: null, until: null };
  const query = new URLSearchParams(window.location.search);
  const local = stored();
  const state = stateOf(query.get("autonomy")) ?? local.state ?? "off";
  const variant = variantOf(query.get("autonomyVariant")) ?? local.variant ?? 1;
  return { variant, state, ...episode(state, null, Date.now()) };
}

let current: AutonomyPrototype | null = null;
const listeners = new Set<() => void>();

function snapshot(): AutonomyPrototype {
  current ??= initial();
  return current;
}

const OFF: AutonomyPrototype = { variant: 1, state: "off", startedAt: null, until: null };

export function useAutonomyPrototype(): AutonomyPrototype {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    () => OFF,
  );
}

/** The panel's Save: `hours` null keeps the stored end, `Infinity` is no end. */
export function saveAutonomyPrototype(enabled: boolean, hours: number | null): void {
  const previous = snapshot();
  const state: AutonomyState = !enabled ? "off" : hours === Infinity ? "unlimited" : "on";
  const keep = hours === null && previous.state === state;
  current = { variant: previous.variant, state, ...(keep ? { startedAt: previous.startedAt, until: previous.until } : episode(state, hours === Infinity ? null : hours, Date.now())) };
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ state, variant: previous.variant }));
  } catch {
    /* A page without storage keeps the state for this load only. */
  }
  for (const listener of listeners) listener();
}

/** The durations the panel offers, in hours; `Infinity` is «Без терміну». */
export const AUTONOMY_HOURS = [8, 12, 24, Infinity] as const;
