"use client";

import { useCallback, useEffect, useState } from "react";

import type { OnboardingMarker, OnboardingPatch } from "@/lib/onboarding/marker";

/**
 * Where the setup guide opens from (#1876, design §6): by itself on a first
 * run, from the two menu rows, and from the zero-projects panel. Every entry
 * dispatches one window event; the dialog is mounted once, in the Viewer.
 */

export type OnboardingMode = "guide" | "mapping";

const OPEN_EVENT = "llv:open-onboarding";

export function openOnboarding(mode: OnboardingMode = "guide"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OnboardingMode>(OPEN_EVENT, { detail: mode }));
}

export async function putOnboarding(patch: OnboardingPatch): Promise<OnboardingMarker | null> {
  try {
    const response = await fetch("/api/onboarding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { marker?: OnboardingMarker }).marker ?? null;
  } catch {
    return null;
  }
}

/** A page that opened on something specific (a conversation hash, a
    pipeline route, a `?k=` landing) is left alone even on a first run. */
export function landingAllowsGuide(location: Pick<Location, "hash" | "search" | "pathname">): boolean {
  if (location.hash && location.hash !== "#") return false;
  if (new URLSearchParams(location.search).has("k")) return false;
  return !location.pathname.startsWith("/pipelines");
}

export function useOnboarding(): {
  mode: OnboardingMode | null;
  marker: OnboardingMarker | null;
  close: (outcome: "dismissed" | "completed") => void;
} {
  const [mode, setMode] = useState<OnboardingMode | null>(null);
  const [marker, setMarker] = useState<OnboardingMarker | null>(null);

  useEffect(() => {
    const onOpen = (event: Event) => setMode((event as CustomEvent<OnboardingMode>).detail ?? "guide");
    window.addEventListener(OPEN_EVENT, onOpen);
    let cancelled = false;
    void fetch("/api/onboarding")
      .then(async (response) => response.ok ? (await response.json()) as { marker: OnboardingMarker | null } : null)
      .catch(() => null)
      .then((body) => {
        if (cancelled || !body) return;
        setMarker(body.marker);
        /* First run: never decided. A marker neither completed nor dismissed is
           a guide the page died in the middle of; both reopen by themselves. */
        const unfinished = body.marker === null || (!body.marker.completedAt && !body.marker.dismissedAt);
        if (!unfinished || !landingAllowsGuide(window.location)) return;
        setMode((current) => current ?? "guide");
        /* Writing the marker now keeps a restart mid-guide from re-deciding
           this install as an upgrade. */
        if (body.marker === null) void putOnboarding({ steps: {} }).then((written) => { if (!cancelled && written) setMarker(written); });
      });
    return () => {
      cancelled = true;
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  const close = useCallback((outcome: "dismissed" | "completed") => {
    setMode(null);
    void putOnboarding(outcome === "completed" ? { completed: true, steps: { engines: "done", agents: "done" } } : { dismissed: true })
      .then((written) => { if (written) setMarker(written); });
  }, []);

  return { mode, marker, close };
}
