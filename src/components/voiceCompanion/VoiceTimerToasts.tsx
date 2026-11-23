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
const RECEIPT_KEY = "delegatus:voice-timer-receipt:";

/** What became of a committed toast, kept until the server has it. In storage, so a reload or another tab tells it too. */
interface Receipt { lease: number; outcome: "shown" | "release" }
/** Where storage is refused, this page keeps them. */
const unstored = new Map<string, string>();
function keepReceipt(id: string, receipt: Receipt): void {
  const value = JSON.stringify(receipt);
  try { localStorage.setItem(RECEIPT_KEY + id, value); } catch { unstored.set(id, value); }
}
function receipts(): Array<Receipt & { id: string }> {
  const raw = new Map(unstored);
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(RECEIPT_KEY)) raw.set(key.slice(RECEIPT_KEY.length), localStorage.getItem(key) ?? "");
    }
  } catch { /* Only this page's own remain. */ }
  return [...raw].flatMap(([id, value]) => {
    try {
      const receipt = JSON.parse(value) as Partial<Receipt>;
      if (typeof receipt.lease === "number" && (receipt.outcome === "shown" || receipt.outcome === "release")) return [{ id, lease: receipt.lease, outcome: receipt.outcome }];
    } catch { /* Dropped below. */ }
    dropReceipt(id);
    return [];
  });
}
function dropReceipt(id: string): void {
  unstored.delete(id);
  try { localStorage.removeItem(RECEIPT_KEY + id); } catch { /* It was never there. */ }
}
/** The server answered, or refused in a way asking again cannot change. `COMPANION_UNAVAILABLE` is a 409 and may pass. */
const settled = (response: Response) => response.ok || response.status === 400 || response.status === 403;

/**
 * The in-app toast of a fired voice timer (docs/design/voice-timers.md §3.4). Renders nothing. A visible tab reads
 * what it may show on mount, on becoming visible, after a call ends and at the next timer's time; a hidden tab waits,
 * because a toast nobody sees would use up the timer's one toast. A claim holds the toast for a short lease, so a tab
 * that goes part way through leaves it for the next read. `showing` commits it before it appears: from then on no tab
 * is offered it again, and a receipt says what became of it.
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
    /** Claims whose commit has no answer yet. This tab alone knows it showed nothing, so it alone asks again under the lease. */
    const committing = new Map<string, { lease: number; text: string }>();
    const eligible = () => !disposed && document.visibilityState === "visible";
    const later = (delay: number) => {
      window.clearTimeout(timer);
      if (!disposed) timer = window.setTimeout(() => { void read(); }, Math.max(SOONEST_MS, delay));
    };
    const post = (body: unknown, options: RequestInit) => fetch("/api/voice-companion/timers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...options });
    /** They are about what already happened, so nothing cancels these but the tab itself going. */
    const tellReceipts = async () => {
      for (const { id, lease, outcome } of receipts()) {
        try {
          const answer = await post({ action: outcome, id, lease }, { keepalive: true, signal: AbortSignal.timeout(REQUEST_MS) });
          if (settled(answer)) dropReceipt(id);
        } catch { return; }
      }
    };
    /** A toast leaves the host after this long, whatever else happens, and the next one takes its slot. */
    const holdSlot = () => {
      visible += 1;
      const slot = window.setTimeout(() => { slots.delete(slot); visible -= 1; void read(); }, TASK_TOAST_MS);
      slots.add(slot);
    };
    /** Not cancelled by this tab hiding: only its answer can say whether the server now holds the toast for it to give back. */
    const commit = async (id: string, held: { lease: number; text: string }) => {
      committing.set(id, held);
      let answer: { showing?: boolean } = {};
      try {
        const response = await post({ action: "showing", id, lease: held.lease }, { keepalive: true, signal: AbortSignal.timeout(REQUEST_MS) });
        if (!settled(response)) return;
        if (response.ok) answer = await response.json() as { showing?: boolean };
      } catch { return; }
      committing.delete(id);
      if (!answer.showing) return;
      const appeared = eligible() && pushTaskToast("ok", held.text);
      if (appeared) holdSlot();
      keepReceipt(id, { lease: held.lease, outcome: appeared ? "shown" : "release" });
      await tellReceipts();
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
        await tellReceipts();
        for (const [id, held] of [...committing]) if (eligible() && visible < VISIBLE_TIMER_TOASTS) await commit(id, held);
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
          if (answer?.claimed && answer.text && typeof answer.lease === "number") await commit(id, { lease: answer.lease, text: answer.text });
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
