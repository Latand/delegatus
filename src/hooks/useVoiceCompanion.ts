"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { STALE_BROWSER_MS, type CompanionCommand, type CompanionEvent, type ResumableCall, type VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CompanionState } from "@/lib/voiceCompanion/reducer";

type StartOptions = Parameters<VoiceCompanionAdapter["start"]>[0];
export interface VoiceCompanionHook {
  state: CompanionState;
  start(options: StartOptions): Promise<void>;
  setProject(project: string | null): Promise<void>;
  command(command: CompanionCommand): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
}

/** `offset` lifts a resumed session's generations above the call's earlier ones, so the reducer keeps what was said
 * across the reconnect; `resuming` is the dropped call the latest start continues, given back if that start fails. */
interface Snapshot { adapter: VoiceCompanionAdapter | null; sessionId: string | null; state: CompanionState; retired: ReadonlySet<string>; awaitingReady: boolean; offset: number; resuming: ResumableCall | null }
type Action = { type: "start"; adapter: VoiceCompanionAdapter; resume?: string } | { type: "failed-start"; adapter: VoiceCompanionAdapter; code: string | null }
  | { type: "event"; adapter: VoiceCompanionAdapter; event: CompanionEvent } | { type: "resumable"; adapter: VoiceCompanionAdapter; call: ResumableCall | null };
const initial: Snapshot = { adapter: null, sessionId: null, state: INITIAL_COMPANION_STATE, retired: new Set(), awaitingReady: false, offset: 0, resuming: null };
/** Ends that cut a call off; a hang-up, a goodbye, the cap and the plan limit end it. */
const DROPS = new Set(["transport", "error"]);
const said = (state: CompanionState) => state.lines.some((line) => line.text.trim() !== "");
const cut = (event: CompanionEvent) => event.type === "session.closed" ? DROPS.has(event.reason) : event.type === "error" && event.code === "CONNECTION_LOST";
/** A session that drops after something was said here leaves its call to resume. One that resumed after a reload
 * holds no lines of its own: the Viewer, asked after every drop, offers it from the call's journal. */
function dropped(state: CompanionState, event: CompanionEvent, sessionId: string): CompanionState {
  if (!cut(event) || !said(state) || state.resumable?.sessionId === sessionId) return state;
  return { ...state, resumable: { sessionId, project: null }, revision: state.revision + 1 };
}
function receive(previous: Snapshot, action: Action): Snapshot {
  if (action.type === "start") {
    const base = previous.adapter === action.adapter ? previous : initial;
    const resuming = action.resume && base.state.resumable?.sessionId === action.resume ? base.state.resumable : null;
    return { ...base, adapter: action.adapter, awaitingReady: true, resuming };
  }
  /* A page that opens finds its dropped call before any start here: the state is this adapter's from then on. */
  if (action.type === "resumable" && previous.adapter === null) return receive({ ...initial, adapter: action.adapter }, action);
  if (previous.adapter !== action.adapter) return previous;
  if (action.type === "failed-start") {
    /* A reconnect that did not go through: the call is still offered unless the Viewer refused it. */
    if (!previous.resuming) return { ...previous, awaitingReady: false };
    const resumable = action.code === "SESSION_UNAVAILABLE" ? null : previous.resuming;
    return { ...previous, awaitingReady: false, resuming: null, state: { ...previous.state, resumable, reconnected: false, phase: "offline", error: action.code, revision: previous.state.revision + 1 } };
  }
  if (action.type === "resumable") {
    if (previous.awaitingReady || previous.state.phase !== "offline" || previous.state.resumable?.sessionId === action.call?.sessionId) return previous;
    return { ...previous, state: { ...previous.state, resumable: action.call, revision: previous.state.revision + 1 } };
  }
  const event = action.event;
  if (event.sessionId === previous.sessionId) {
    const shifted = previous.offset ? { ...event, generation: event.generation + previous.offset } : event;
    return { ...previous, state: dropped(reduceCompanion(previous.state, shifted), event, event.sessionId),
      awaitingReady: event.type === "session.ready" && shifted.generation > previous.state.generation ? false : previous.awaitingReady };
  }
  if (event.type !== "session.ready" || !previous.awaitingReady || previous.retired.has(event.sessionId)) return previous;
  const retired = new Set([...previous.retired, ...(previous.sessionId ? [previous.sessionId] : [])]);
  if (previous.resuming) {
    /* The same call goes on: what was said stays, under a generation above every earlier part's. */
    const offset = previous.state.generation;
    const state = reduceCompanion(previous.state, { ...event, generation: event.generation + offset });
    return { ...previous, sessionId: event.sessionId, awaitingReady: false, retired, offset, state: { ...state, resumable: null, reconnected: true } };
  }
  return { ...previous, sessionId: event.sessionId, awaitingReady: false, retired, offset: 0, resuming: null, state: reduceCompanion(INITIAL_COMPANION_STATE, event) };
}
const failureCode = (error: unknown) => (error instanceof Error ? error.message : null);
const TERMINAL = new Set(["SESSION_UNAVAILABLE", "COMPANION_DISABLED", "CAP_REACHED", "CODEX_LIMIT_REACHED", "CODEX_AUTH_REQUIRED", "NO_CODEX_ACCOUNT", "CODEX_UNSUPPORTED", "NO_KEY", "KEY_FROM_ENV", "NO_PROJECT", "INVALID_REQUEST", "MICROPHONE_REFUSED", "AUDIO_REFUSED", "MINT_UNCERTAIN", "CONTENT_BLOCKED"]);

/** The Viewer offers an open call only once its browser has been quiet for STALE_BROWSER_MS, so the question a page
 * asks on reload, or the moment its connection drops, is usually answered null: it asks again after that, a few times. */
export const RESUME_RECHECK_MS = STALE_BROWSER_MS + 1_000;
const RESUME_RECHECKS = 3;
/** Runs `run` after `ms`; returns its cancel. */
export type Schedule = (run: () => void, ms: number) => () => void;
const timeout: Schedule = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); };
/** Nothing runs and nothing is offered: a dropped call the Viewer names now can be offered. */
const idle = (snapshot: Snapshot) => !snapshot.awaitingReady && snapshot.state.phase === "offline" && !snapshot.state.resumable;

/** Asks the Viewer for the operator's dropped call; while the answer is null (or the question failed) and `waiting`
 * holds, asks again up to RESUME_RECHECKS times. A new question replaces the one before; `stop` ends both. */
function resumeProbe(adapter: VoiceCompanionAdapter, waiting: () => boolean, offer: (call: ResumableCall) => void, schedule: Schedule) {
  let question = 0;
  let cancel: (() => void) | null = null;
  const clear = () => { cancel?.(); cancel = null; };
  const ask = (asked: number, left: number) => {
    const recheck = () => {
      if (asked !== question || left === 0 || !waiting()) return;
      cancel = schedule(() => { cancel = null; if (asked === question && waiting()) ask(asked, left - 1); }, RESUME_RECHECK_MS);
    };
    void adapter.resumable!().then((call) => { if (asked !== question) return; if (call) offer(call); else recheck(); }, recheck);
  };
  return {
    ask: () => { if (!adapter.resumable || question < 0) return; clear(); ask(++question, RESUME_RECHECKS); },
    stop: () => { question = -1; clear(); },
  };
}

export interface CompanionStore {
  get(): CompanionState;
  /** A start was asked for and its session is not ready yet: what the state still holds belongs to the one before. */
  awaiting(): boolean;
  /** Called when anything but a level sample changed. */
  subscribe(listener: () => void): () => void;
  /** Called for every change of the mouth level or the played time: one transform per sample, no render. */
  onLevel(listener: (state: CompanionState) => void): () => void;
  /** Subscribes to the adapter and asks for a dropped call to offer, on connecting and after each drop; the returned
   * function releases its microphone, transport, delivery observer and the question's recheck. */
  connect(): () => void;
  start(options: StartOptions): Promise<void>;
  setProject(project: string | null): Promise<void>;
  command(command: CompanionCommand): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
}

/** The same session rules as the hook below, outside React: the floating companion reads this, so a
 * played-audio level sample moves the mouth without rendering the component sixty times a second. */
export function createCompanionStore(adapter: VoiceCompanionAdapter, options: { schedule?: Schedule; now?: () => number; random?: () => number; runnable?: () => boolean } = {}): CompanionStore {
  let snapshot = initial;
  const schedule = options.schedule ?? timeout;
  const now = options.now ?? (() => performance.now());
  const runnable = options.runnable ?? (() => (typeof navigator === "undefined" || navigator.onLine !== false)
    && !(typeof document !== "undefined" && document.hidden && typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches));
  let settings: StartOptions | null = null;
  let automatic = false;
  let project: string | null = null;
  let loop: { elapsed: number; last: number; runnable: boolean; next: number; tick: number; attempts: number; noticed: number; resume: string; pending: boolean } | null = null;
  let cancel: (() => void) | null = null, attempt: AbortController | null = null;
  let recent: number[] = [];
  const views = new Set<() => void>();
  const levels = new Set<(state: CompanionState) => void>();
  const apply = (action: Action) => {
    const before = snapshot.state;
    snapshot = receive(snapshot, action);
    if (loop && action.type === "event" && action.event.type === "session.closed" && DROPS.has(action.event.reason))
      snapshot = { ...snapshot, state: { ...snapshot.state, phase: "reconnecting", reconnected: false, error: null } };
    const state = snapshot.state;
    if (state === before) return;
    if (state.mouth !== before.mouth || state.playedMs !== before.playedMs) for (const listener of [...levels]) listener(state);
    if (state.revision !== before.revision || state.generation !== before.generation || action.type === "event" && action.event.type === "session.ready") for (const listener of [...views]) listener();
  };
  const change = (patch: Partial<CompanionState>) => {
    snapshot = { ...snapshot, state: { ...snapshot.state, ...patch, revision: snapshot.state.revision + 1 } };
    for (const view of [...views]) view();
  };
  const cancelLoop = () => { loop = null; cancel?.(); cancel = null; attempt?.abort(); attempt = null; };
  const giveUp = (code: string | null) => {
    automatic = false;
    cancelLoop(); snapshot = { ...snapshot, awaitingReady: false, resuming: null };
    adapter.reconnect?.("gave-up");
    change({ phase: "offline", reconnected: false, error: code && TERMINAL.has(code) ? code : "RECONNECT_GAVE_UP",
      resumable: code === "SESSION_UNAVAILABLE" ? null : snapshot.state.resumable });
  };
  const begin = async (input: StartOptions) => {
    apply({ type: "start", adapter, resume: input.resume });
    try { await adapter.start(input); }
    catch (error) {
      const resumedId = (error as { resumeSessionId?: string })?.resumeSessionId;
      if (resumedId) { snapshot = { ...snapshot, resuming: { sessionId: resumedId, project } }; if (loop) loop.resume = resumedId; }
      if (loop) {
        snapshot = { ...snapshot, awaitingReady: false };
        if (resumedId) change({ resumable: { sessionId: resumedId, project } });
      } else apply({ type: "failed-start", adapter, code: failureCode(error) });
      throw error;
    }
  };
  const wake = () => {
    const current = loop; if (!current) return;
    const at = now(); const delta = Math.max(0, at - current.last); current.last = at;
    // Sample frequently: paused time never buys another minute of active attempts.
    if (runnable() && current.runnable) current.elapsed += delta;
    current.runnable = runnable();
    if (current.elapsed >= 60_000) { giveUp(null); return; }
    if (runnable() && current.elapsed >= current.tick) { adapter.reconnect?.("tick"); current.tick = current.elapsed + 5_000; }
    if (runnable() && !current.pending && current.elapsed >= current.next) {
      if (current.attempts >= 8 || !settings || !project) { giveUp(project ? null : "NO_PROJECT"); return; }
      current.attempts++; current.pending = true;
      const controller = attempt = new AbortController();
      const expire = schedule(() => controller.abort(), Math.min(15_000, 60_000 - current.elapsed));
      void begin({ ...settings, project, resume: current.resume, signal: controller.signal,
        reconnect: { tier: 2, attempts: current.attempts, automatic: true, noticedToStartMs: Math.max(0, Math.round(at - current.noticed)) } }).then(() => {
        if (loop !== current) return;
        cancelLoop();
      }, error => {
        if (loop !== current) return;
        current.pending = false;
        const code = failureCode(error);
        if (TERMINAL.has(code ?? "") || current.attempts >= 8) { giveUp(code); return; }
        current.next = current.elapsed + ([1_000, 2_000, 4_000][current.attempts - 1] ?? 8_000) * (0.75 + (options.random?.() ?? Math.random()) * 0.5);
        snapshot = { ...snapshot, awaitingReady: false };
        change({ phase: "reconnecting", reconnected: false, error: null });
      }).finally(expire);
    }
    if (loop === current) cancel = schedule(wake, current.pending || !runnable() ? 100 : Math.min(100, Math.max(1, current.next - current.elapsed)));
  };
  const reconnect = () => {
    if (!automatic || loop || !settings || !snapshot.state.resumable || adapter.mode !== "official-realtime") return;
    const at = now(); recent = recent.filter(time => at - time < 600_000);
    if (recent.length >= 6) { giveUp(null); return; }
    recent.push(at);
    loop = { elapsed: 0, last: at, runnable: runnable(), next: Math.floor((options.random?.() ?? Math.random()) * 300), tick: 5_000, attempts: 0, noticed: at, resume: snapshot.state.resumable.sessionId, pending: false };
    adapter.reconnect?.("trying");
    change({ phase: "reconnecting", reconnected: false, error: null });
    cancel = schedule(wake, Math.min(100, loop.next));
  };
  return {
    get: () => snapshot.state,
    awaiting: () => snapshot.awaitingReady,
    subscribe: (listener) => { views.add(listener); return () => { views.delete(listener); }; },
    onLevel: (listener) => { levels.add(listener); return () => { levels.delete(listener); }; },
    connect: () => {
      let active = true;
      const probe = resumeProbe(adapter, () => active && idle(snapshot), (call) => { if (active) apply({ type: "resumable", adapter, call }); }, schedule);
      const unsubscribe = adapter.subscribe((event) => {
        if (!active) return;
        apply({ type: "event", adapter, event });
        if (event.type === "session.closed" && event.cause === "audio-refused") { giveUp("AUDIO_REFUSED"); return; }
        if (loop && event.type === "session.closed" && !DROPS.has(event.reason)) {
          giveUp(event.reason === "content" ? "CONTENT_BLOCKED" : event.reason === "cap" ? "CAP_REACHED" : event.reason === "limit" ? "CODEX_LIMIT_REACHED" : "SESSION_UNAVAILABLE");
          change({ resumable: null }); return;
        }
        if (cut(event)) { reconnect(); if (!loop) probe.ask(); }
      });
      /* A page that reloaded, or a browser that came back, finds the call it dropped. */
      probe.ask();
      const availability = () => { if (loop) { if (!loop.runnable && runnable() && !loop.pending) loop.next = loop.elapsed; cancel?.(); cancel = null; wake(); } };
      if (typeof window !== "undefined") { window.addEventListener("online", availability); window.addEventListener("offline", availability); document.addEventListener("visibilitychange", availability); }
      return () => {
        active = false; automatic = false; cancelLoop(); probe.stop(); unsubscribe();
        if (typeof window !== "undefined") { window.removeEventListener("online", availability); window.removeEventListener("offline", availability); document.removeEventListener("visibilitychange", availability); }
        void (adapter.dispose?.() ?? adapter.close()).catch(() => undefined);
      };
    },
    start: async (options) => {
      cancelLoop(); settings = options; project = options.project; automatic = true;
      if (!options.resume) recent = [];
      try { await begin(options); } catch (error) { automatic = false; throw error; }
    },
    setProject: value => { project = value; return adapter.setProject?.(value) ?? Promise.resolve(); },
    command: (value) => adapter.command(value),
    stop: async () => {
      const pending = snapshot.awaitingReady;
      automatic = false; cancelLoop(); snapshot = { ...snapshot, awaitingReady: false, resuming: null };
      change({ phase: "offline", reconnected: false, resumable: pending ? null : snapshot.state.resumable });
      await adapter.close();
    },
    refresh: () => adapter.refresh?.() ?? Promise.resolve(),
  };
}

/** An explicit start opens a call; a drop continues it here. Closing the view releases its media and retries. */
export function useVoiceCompanion(adapter: VoiceCompanionAdapter): VoiceCompanionHook {
  const store = useMemo(() => createCompanionStore(adapter), [adapter]);
  useEffect(() => store.connect(), [store]);
  const subscribe = useMemo(() => (listener: () => void) => { const view = store.subscribe(listener), level = store.onLevel(listener); return () => { view(); level(); }; }, [store]);
  const state = useSyncExternalStore(subscribe, store.get, store.get);
  return { state, start: store.start, setProject: store.setProject, command: store.command, stop: store.stop, refresh: store.refresh };
}
