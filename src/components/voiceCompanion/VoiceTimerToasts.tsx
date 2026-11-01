"use client";

import { useEffect, useRef } from "react";

import { pushTaskToast } from "@/components/tasks/taskToast";
import { useLocale } from "@/lib/i18n";

/** A call ended on this page: what it could not say may be this tab's to show. */
export const VOICE_TIMERS_EVENT = "delegatus:voice-timers";
/** A visible tab reads this often at the longest: a timer can be set on another device. */
const READ_MS = 60_000;
/** A timeout that ran a moment before the server's reads again this soon. */
const SOONEST_MS = 250;

/**
 * The in-app toast of a fired voice timer (docs/design/voice-timers.md §3.4). Renders nothing. A visible tab reads
 * what it may show on mount, on becoming visible, after a call ends and at the next timer's time; a hidden tab waits,
 * because a toast nobody sees would use up the timer's one toast. The server keeps one claim, so one tab shows it.
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
    const later = (delay: number) => {
      window.clearTimeout(timer);
      if (!disposed) timer = window.setTimeout(() => { void read(); }, Math.max(SOONEST_MS, delay));
    };
    const read = async (): Promise<void> => {
      if (disposed || document.visibilityState !== "visible") return;
      if (reading) { again = true; return; }
      reading = true;
      let wait = READ_MS;
      try {
        const response = await fetch("/api/voice-companion/timers", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("unavailable");
        const { claimable, nextInMs } = await response.json() as { claimable: string[]; nextInMs: number | null };
        for (const id of claimable) {
          const claim = await fetch("/api/voice-companion/timers", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "claim", id, locale: speech.current }), signal: AbortSignal.timeout(10_000) });
          const answer = claim.ok ? await claim.json() as { claimed: boolean; text?: string } : null;
          if (answer?.claimed && answer.text) pushTaskToast("ok", answer.text);
        }
        if (nextInMs !== null) wait = Math.min(READ_MS, nextInMs);
      } catch { /* The next read asks again; push and the next call do not depend on this tab. */ }
      reading = false;
      if (again) { again = false; void read(); } else later(wait);
    };
    const reread = () => { void read(); };
    document.addEventListener("visibilitychange", reread);
    window.addEventListener(VOICE_TIMERS_EVENT, reread);
    queueMicrotask(reread);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", reread);
      window.removeEventListener(VOICE_TIMERS_EVENT, reread);
    };
  }, []);
  return null;
}
