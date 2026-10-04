"use client";

import { useSyncExternalStore } from "react";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

/* Shared with attention-handoff selection: a window this small disables the
   attention host, so the selection predicate must count it out by the SAME
   numbers — see `@/lib/attention/eligibility`. */
const QUERY = MOBILE_LAYOUT_QUERY;

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

/** Phone-sized viewport — either axis under the desktop minimum of 640 × 600
    (docs/design/mobile-v2/README.md §5), so a landscape phone at 844 × 390
    gets the shell too: the shell swaps the rail for the project sheet and the
    scheme for the single-conversation focus layout. Server render assumes
    desktop. */
const noSubscription = () => () => {};

export function useIsMobile(active = true): boolean {
  return useSyncExternalStore(
    active ? subscribe : noSubscription,
    matches,
    () => false,
  );
}
