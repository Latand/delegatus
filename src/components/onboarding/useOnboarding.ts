"use client";

import { useCallback, useEffect, useState } from "react";

import type { OnboardingMarker, OnboardingPatch, OnboardingStepId } from "@/lib/onboarding/marker";

/**
 * Where the setup guide opens from (#1876, design §6): by itself on a first
 * run, from the three menu rows, from the zero-projects panel, and on a
 * given step from the QR popover and the mic menu. Every entry dispatches one
 * window event; the dialog is mounted once, in the Viewer.
 */

/** `mapping` and `voice` open the Agents table or the Voice step alone, for the menu rows. */
export type OnboardingMode = "guide" | "mapping" | "voice";

type OpenRequest = { mode: OnboardingMode; step: OnboardingStepId | null };

const OPEN_EVENT = "llv:open-onboarding";

export function openOnboarding(mode: OnboardingMode = "guide", step: OnboardingStepId | null = null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_EVENT, { detail: { mode, step } }));
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
  step: OnboardingStepId | null;
  /** Counts openings, so every open starts the dialog afresh. */
  opening: number;
  marker: OnboardingMarker | null;
  /** The seat tick's check interval, which the orchestrator step names. */
  checkMinutes: number | null;
  close: (outcome: "dismissed" | "completed", steps?: OnboardingPatch["steps"]) => void;
} {
  const [mode, setMode] = useState<OnboardingMode | null>(null);
  const [step, setStep] = useState<OnboardingStepId | null>(null);
  const [opening, setOpening] = useState(0);
  const [marker, setMarker] = useState<OnboardingMarker | null>(null);
  const [checkMinutes, setCheckMinutes] = useState<number | null>(null);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenRequest | OnboardingMode | undefined>).detail;
      const request = typeof detail === "string" ? { mode: detail, step: null } : detail;
      setMode(request?.mode ?? "guide");
      setStep(request?.step ?? null);
      setOpening((value) => value + 1);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    let cancelled = false;
    void fetch("/api/onboarding")
      .then(async (response) => response.ok ? (await response.json()) as { marker: OnboardingMarker | null; seatTickCheckMinutes?: unknown } : null)
      .catch(() => null)
      .then((body) => {
        if (cancelled || !body) return;
        setMarker(body.marker);
        if (typeof body.seatTickCheckMinutes === "number" && body.seatTickCheckMinutes > 0) setCheckMinutes(body.seatTickCheckMinutes);
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

  const close = useCallback((outcome: "dismissed" | "completed", steps?: OnboardingPatch["steps"]) => {
    setMode(null);
    /* Each step wrote its own state as it was left; completing adds only the
       fact of completion, and whatever the closing step itself decided. */
    void putOnboarding({ ...(outcome === "completed" ? { completed: true as const } : { dismissed: true as const }), ...(steps ? { steps } : {}) })
      .then((written) => { if (written) setMarker(written); });
  }, []);

  return { mode, step, opening, marker, checkMinutes, close };
}
