import type { IsolationCounters, IsolationMix, IsolationWindow } from "./composerIsolation.fixture";

export interface TypingResult {
  nativeClock: true;
  samples: number[];
  keyTimes: number[];
  frameTimes: number[];
  eventTimings: Array<{ start: number; delay: number; duration: number; interaction: number | null }>;
  longTasks: Array<{ start: number; duration: number }>;
  geometryMethods: Record<string, number>;
  events: number;
  envelopes: Array<{ seq: number; at: number }>;
  focus: boolean;
  text: boolean;
  caret: boolean;
  counters: IsolationCounters | null;
  derivations: NonNullable<IsolationWindow["__pdRows"]>;
}

export type TypingWindow = IsolationWindow & {
  isolationTyping: {
    start(mix: IsolationMix, rate: number, chars: string, structural: boolean): void;
    complete(): boolean;
    finish(): TypingResult;
  };
};

/** Playwright installs this function verbatim in the document. All clocks below belong to the page. */
export function installTypingProbe() {
  const w = window as TypingWindow;
  const timestamp = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp")?.get;
  if ("__pwClock" in window || ![timestamp, performance.now, window.requestAnimationFrame, window.setInterval]
    .every(fn => fn && Function.prototype.toString.call(fn).includes("[native code]"))) {
    throw Error("typing evidence requires native Event.timeStamp, performance.now, timers and animation frames");
  }
  let finished = 0;
  let finish: () => TypingResult;
  let total = 0;
  w.isolationTyping = {
    complete: () => finished === total,
    start(mix, rate, chars, structural) {
      const field = document.activeElement;
      if (!(field instanceof HTMLTextAreaElement) || document.visibilityState !== "visible" || !document.hasFocus()) {
        throw Error("typing needs a focused foreground textarea");
      }
      if (structural && getComputedStyle(field).getPropertyValue("field-sizing") !== "content") throw Error("expected native field sizing");
      const initial = field.value;
      const keyTimes: number[] = [], frames: number[] = [];
      const eventTimings: TypingResult["eventTimings"] = [], longTasks: PerformanceEntry[] = [];
      const envelopes: Array<{ seq: number; at: number }> = [];
      const release: Array<() => void> = [];
      const geometryMethods: Record<string, number> = {};
      function geometry(method: string) {
        if (!w.isolationCounters) return;
        w.isolationCounters.fieldGeometry++;
        geometryMethods[method] = (geometryMethods[method] ?? 0) + 1;
      }
      let inputs = 0, emitted = 0, raf = 0, first = 0;
      total = chars.length; finished = 0;
      if (structural) {
        const probes = (w as TypingWindow & { __composerIsolationModules?: Set<string> }).__composerIsolationModules;
        for (const name of ["Viewer.tsx","ProjectDashboard.tsx","KanbanCard.tsx","ConversationComposer.tsx","KanbanSeat.tsx","runtimeFilesStatus.ts",
          "ConnectionPill.tsx","DeploymentStatusPill.tsx","MobileShell.tsx","MobileFocusView.tsx"]) {
          if (!probes?.has(name)) throw Error("instrumented bundle missing " + name);
        }
        w.isolationCounters = w.composerIsolation.counters();
        w.__pdRows = []; w.__pdRecording = true;
        const bounds = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          if (this === field) geometry("getBoundingClientRect");
          return bounds.call(this);
        };
        release.push(() => { Element.prototype.getBoundingClientRect = bounds; });
        const style = window.getComputedStyle;
        window.getComputedStyle = (element, pseudo) => {
          if (element === field) geometry("getComputedStyle");
          return style.call(window, element, pseudo);
        };
        release.push(() => { window.getComputedStyle = style; });
        for (const [prototype, keys] of [[Element.prototype, ["scrollHeight", "clientHeight", "clientWidth"]],
          [HTMLElement.prototype, ["offsetHeight", "offsetWidth"]]] as const) for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          if (!descriptor?.get) throw Error("missing geometry getter " + key);
          Object.defineProperty(prototype, key, { ...descriptor, get: function () {
            if (this === field) geometry(key);
            return descriptor.get!.call(this);
          } });
          release.push(() => Object.defineProperty(prototype, key, descriptor));
        }
      }
      const frame = () => {
        raf = 0;
        const now = performance.now();
        while (finished < inputs && field.value.startsWith(initial + chars.slice(0, finished + 1))) {
          frames.push(now); finished++;
        }
        if (finished < inputs) raf = requestAnimationFrame(frame);
      };
      const onKey = (event: KeyboardEvent) => {
        if (!event.isTrusted || event.key.length !== 1) return;
        if (event.key !== chars[keyTimes.length]) throw Error("unexpected trusted key");
        keyTimes.push(event.timeStamp);
        if (!first) first = event.timeStamp;
      };
      const onInput = (event: Event) => {
        if (!event.isTrusted) return;
        inputs++;
        if (!raf) raf = requestAnimationFrame(frame);
      };
      field.addEventListener("keydown", onKey); field.addEventListener("input", onInput);
      function timings(entries: PerformanceEntry[]) {
        for (const entry of entries) {
          if (entry.name === "keydown" && first && entry.startTime >= first) {
            const timing = entry as PerformanceEventTiming & { interactionId?: number };
            if (timing.target === field) eventTimings.push({ start:timing.startTime,
              delay:timing.processingStart-timing.startTime, duration:timing.duration, interaction:timing.interactionId ?? null });
          }
          if (entry.entryType === "longtask") longTasks.push(entry);
        }
      }
      const observer = new PerformanceObserver(list => timings(list.getEntries()));
      observer.observe({ type: "longtask" });
      observer.observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
      function deliver(until: number) {
        if (!first || mix === "quiet") return;
        const due = Math.min(structural ? 12 : Infinity, Math.floor(Math.max(0, until - first) * rate / 1000));
        while (emitted < due) {
          const at = performance.now();
          const seq = w.composerIsolation.event(mix, emitted++, structural);
          envelopes.push({ seq, at });
        }
      }
      const stream = window.setInterval(() => deliver(performance.now()), 16);
      finish = () => {
        clearInterval(stream); cancelAnimationFrame(raf);
        const last = frames.at(-1) ?? performance.now();
        deliver(last);
        timings(observer.takeRecords()); observer.disconnect();
        field.removeEventListener("keydown", onKey); field.removeEventListener("input", onInput);
        for (const restore of release) restore();
        const counters = w.isolationCounters ?? null; delete w.isolationCounters;
        const derivations = w.__pdRows ?? []; w.__pdRecording = false; delete w.__pdRows;
        if (inputs !== total || keyTimes.length !== total || frames.length !== total) throw Error("incomplete trusted input sample");
        return { nativeClock: true, samples: frames.map((time,i) => time-keyTimes[i]!), keyTimes, frameTimes: frames, eventTimings,
          longTasks: longTasks.filter(e => e.startTime < last && e.startTime + e.duration > first).map(e => ({ start:e.startTime, duration:e.duration })),
          events: emitted, envelopes, geometryMethods, focus: field === document.activeElement && document.hasFocus() && document.visibilityState === "visible", text: field.value === initial + chars,
          caret: field.selectionStart === field.value.length && field.selectionEnd === field.value.length, counters, derivations };
      };
    },
    finish: () => finish(),
  };
}
