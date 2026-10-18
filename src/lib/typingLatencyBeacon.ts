import type { TypingLatencyReport, TypingLatencySample } from "@/lib/view/typingLatency";

/**
 * The browser side of the typing-latency record: slow keystroke-to-paint
 * samples from the operator's own composer, so a lag report can be answered
 * from the Viewer's journal instead of a reproduction on another machine.
 *
 * It reads the Event Timing API for `input` events aimed at a composer field
 * (`[data-composer-field]`) and keeps only those whose input-to-paint exceeds
 * `SLOW_INPUT_MS`. A sample is numbers only (when, how long, how much of that
 * was waiting for the main thread, how many animations were running) — never
 * the text, its length, or what the field belongs to.
 *
 * Bounded at every step: a handful of samples per report, one report per
 * `FLUSH_INTERVAL_MS`, a fixed number of reports per page session, and a hidden
 * page sends what it has once. The server caps what reaches its log as well.
 */
export const SLOW_INPUT_MS = 64;
export const MAX_SAMPLES_PER_REPORT = 8;
export const FLUSH_INTERVAL_MS = 30_000;
export const MAX_REPORTS_PER_SESSION = 20;
export const TYPING_LATENCY_PATH = "/api/view/typing-latency";

export interface TypingLatencyEnvironment {
  observe(onEntries: (entries: readonly PerformanceEventTiming[]) => void): (() => void) | null;
  send(path: string, body: string): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  onHidden(callback: () => void): () => void;
  animations(): number;
  timeOrigin(): number;
}

function isComposerField(target: EventTarget | null): boolean {
  /* Not `instanceof Element`: the field can live in another document (the PiP window) and its realm's Element is not this one. */
  return typeof (target as Element | null)?.hasAttribute === "function" && (target as Element).hasAttribute("data-composer-field");
}

export function createTypingLatencyBeacon(environment: TypingLatencyEnvironment) {
  let pending: TypingLatencySample[] = [];
  let reports = 0;
  let timer: unknown = null;
  let stopObserving: (() => void) | null = null;
  let stopHidden: (() => void) | null = null;

  const flush = () => {
    if (timer !== null) { environment.clearTimeout(timer); timer = null; }
    if (pending.length === 0 || reports >= MAX_REPORTS_PER_SESSION) { pending = []; return; }
    const report: TypingLatencyReport = { schemaVersion: 1, samples: pending.slice(0, MAX_SAMPLES_PER_REPORT) };
    pending = [];
    reports += 1;
    try { environment.send(TYPING_LATENCY_PATH, JSON.stringify(report)); } catch { /* a lost report is a lost sample, never an error for the operator */ }
  };

  return {
    start() {
      if (stopObserving) return;
      stopObserving = environment.observe((entries) => {
        for (const entry of entries) {
          if (entry.name !== "input" || entry.duration < SLOW_INPUT_MS || !isComposerField(entry.target)) continue;
          if (pending.length >= MAX_SAMPLES_PER_REPORT || reports >= MAX_REPORTS_PER_SESSION) continue;
          pending.push({
            at: Math.round(environment.timeOrigin() + entry.startTime),
            ms: Math.round(entry.duration),
            delayMs: Math.max(0, Math.round(entry.processingStart - entry.startTime)),
            animations: environment.animations(),
          });
        }
        if (pending.length > 0 && timer === null) timer = environment.setTimeout(flush, FLUSH_INTERVAL_MS);
      });
      stopHidden = environment.onHidden(flush);
    },
    stop() {
      stopObserving?.();
      stopHidden?.();
      stopObserving = null;
      stopHidden = null;
      flush();
    },
    flush,
  };
}

/** The shared instance for the page: started by the first composer to mount and
    stopped when the last one leaves. */
let shared: ReturnType<typeof createTypingLatencyBeacon> | null = null;
let users = 0;

function browserEnvironment(): TypingLatencyEnvironment | null {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return null;
  if (!(PerformanceObserver.supportedEntryTypes ?? []).includes("event")) return null;
  return {
    observe(onEntries) {
      const observer = new PerformanceObserver((list) => onEntries(list.getEntries() as PerformanceEventTiming[]));
      try { observer.observe({ type: "event", durationThreshold: SLOW_INPUT_MS, buffered: false } as PerformanceObserverInit); } catch { return null; }
      return () => observer.disconnect();
    },
    send(path, body) {
      const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(path, new Blob([body], { type: "application/json" }));
      if (!sent) void fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    },
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    onHidden(callback) {
      const onChange = () => { if (document.visibilityState === "hidden") callback(); };
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
    animations: () => document.getAnimations().length,
    timeOrigin: () => performance.timeOrigin,
  };
}

export function watchTypingLatency(): () => void {
  users += 1;
  if (!shared) {
    const environment = browserEnvironment();
    if (environment) shared = createTypingLatencyBeacon(environment);
  }
  shared?.start();
  return () => {
    users -= 1;
    if (users > 0) return;
    shared?.stop();
    shared = null;
  };
}
