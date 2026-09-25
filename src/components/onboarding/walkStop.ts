"use client";

import { useSyncExternalStore } from "react";

/* The interface walk's light half (#2166 §3.8), its own module so the menus
   and the phone shell do not load the walk to reach it: the menu row's
   request, and the stop showing now, for the phone shell, which draws the
   Needs-you badge slot empty-outlined while stop 3 points at it. */

export type WalkStop = 1 | 2 | 3;

const WALK_EVENT = "llv:interface-walk";

/** The menu row "Interface walk": the walk on the current project when its
    seat is live, the setup guide otherwise. */
export function startInterfaceWalk(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WALK_EVENT));
}

export function onInterfaceWalkRequest(listener: () => void): () => void {
  window.addEventListener(WALK_EVENT, listener);
  return () => window.removeEventListener(WALK_EVENT, listener);
}

let shownStop: WalkStop | null = null;
const listeners = new Set<() => void>();

export function publishWalkStop(stop: WalkStop | null): void {
  if (shownStop === stop) return;
  shownStop = stop;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useWalkStop(): WalkStop | null {
  return useSyncExternalStore(subscribe, () => shownStop, () => null);
}
