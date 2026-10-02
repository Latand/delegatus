"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

/* Module-level, so the snapshot keeps its identity across renders: a new
   function each render makes React re-register the store on every commit, once
   for every row of a feed that calls this hook. */
function matches(): boolean {
  return window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True on touch-first devices (phones, tablets) where hovering is unreliable
    and floating overlays fight the finger for the conversation canvas. Callers
    fold their hover-only affordances into an always-reachable surface instead.
    Server render assumes a fine pointer. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    matches,
    () => false,
  );
}
