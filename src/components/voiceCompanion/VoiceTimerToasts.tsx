"use client";

import { useEffect, useRef } from "react";

import { pushTaskToast, TASK_TOAST_MS } from "@/components/tasks/taskToast";
import { useLocale } from "@/lib/i18n";

/** A call ended on this page: what it could not say may be this tab's to show. */
export const VOICE_TIMERS_EVENT = "delegatus:voice-timers";
/** A visible tab reads this often at the longest: a timer can be set on another device. */
const READ_MS = 60_000;
/** A timeout that ran a moment before the server's reads again this soon. */
const SOONEST_MS = 250;
const REQUEST_MS = 10_000;
/** Timer toasts on screen at once. The host drops its oldest past four, and a burst waits here for a slot. */
export const VISIBLE_TIMER_TOASTS = 3;

/**
 * The in-app toast of a fired voice timer (docs/design/voice-timers.md §3.4). Renders nothing. A visible tab reads
 * what it may show on mount, on becoming visible, after a call ends and at the next timer's time; a hidden tab waits,
 * because a toast nobody sees would use up the timer's one toast. A claim holds the toast for a short lease and only
 * `shown` makes it final, so a tab hidden or closed part way through leaves it for the next read.
 */
export function VoiceTimerToasts() {
  const { locale } = useLocale();
  const speech = useRef<"en" | "uk">("en");
  useEffect(() => { speech.current = locale === "uk" ? "uk" : "en"; }, [locale]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let reading = false;
    let again = false;
    let cancelRead: (() => void) | undefined;
    let visible = 0;
    const slots = new Set<number>();
    /** Shown here with the server not told yet. Told first on every read, and it survives this tab being hidden. */
    const unsent = new Map<string, number>();
    const eligible = () => !disposed && document.visibilityState === "visible";
    const later = (delay: number) => {
      window.clearTimeout(timer);
      if (!disposed) timer = window.setTimeout(() => { void read(); }, Math.max(SOONEST_MS, delay));
    };
    const post = (body: unknown, options: RequestInit) => fetch("/api/voice-companion/timers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...options });
    /** What it shows is already on screen, so nothing cancels this but the tab itself going. */
    const tellShown = async () => {
      for (const [id, lease] of [...unsent]) {
        try {
          const answer = await post({ action: "shown", id, lease }, { keepalive: true, signal: AbortSignal.timeout(REQUEST_MS) });
          // A refusal will not change; a failure is asked again on the next read.
          if (answer.ok) unsent.delete(id);
        } catch { return; }
      }
    };
    /** A toast leaves the host after this long, whatever else happens, and the next one takes its slot. */
    const holdSlot = () => {
      visible += 1;
      const slot = window.setTimeout(() => { slots.delete(slot); visible -= 1; void read(); }, TASK_TOAST_MS);
      slots.add(slot);
    };
    const read = async (): Promise<void> => {
      if (!eligible()) return;
      if (reading) { again = true; return; }
      reading = true;
      let wait = READ_MS;
      const request = new AbortController();
      cancelRead = () => request.abort();
      const deadline = window.setTimeout(() => request.abort(), REQUEST_MS);
      try {
        await tellShown();
        if (!eligible()) return;
        const response = await fetch("/api/voice-companion/timers", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("unavailable");
        const { claimable, nextInMs } = await response.json() as { claimable: string[]; nextInMs: number | null };
        if (nextInMs !== null) wait = Math.min(READ_MS, nextInMs);
        for (const id of claimable) {
          if (!eligible() || visible >= VISIBLE_TIMER_TOASTS) break;
          const claim = await post({ action: "claim", id, locale: speech.current }, { signal: request.signal });
          const answer = claim.ok ? await claim.json() as { claimed: boolean; text?: string; lease?: number } : null;
          if (!eligible()) break;
          if (answer?.claimed && answer.text && pushTaskToast("ok", answer.text)) {
            holdSlot();
            if (typeof answer.lease === "number") unsent.set(id, answer.lease);
            await tellShown();
          }
        }
      } catch { /* The next read asks again; push and the next call do not depend on this tab. */ }
      finally {
        window.clearTimeout(deadline);
        cancelRead = undefined;
        reading = false;
        if (eligible()) { if (again) { again = false; void read(); } else later(wait); } else again = false;
      }
    };
    const reread = () => {
      // A tab that was hidden gives up what it was reading. What it claimed comes back when the lease runs out.
      if (!eligible()) cancelRead?.();
      else void read();
    };
    document.addEventListener("visibilitychange", reread);
    window.addEventListener(VOICE_TIMERS_EVENT, reread);
    queueMicrotask(reread);
    return () => {
      disposed = true;
      cancelRead?.();
      window.clearTimeout(timer);
      for (const slot of slots) window.clearTimeout(slot);
      document.removeEventListener("visibilitychange", reread);
      window.removeEventListener(VOICE_TIMERS_EVENT, reread);
    };
  }, []);
  return null;
}
