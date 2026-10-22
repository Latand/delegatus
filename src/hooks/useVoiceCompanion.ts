"use client";

import { useCallback, useEffect, useReducer } from "react";
import type { CompanionCommand, CompanionEvent, Locale, ResumableCall, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CompanionState } from "@/lib/voiceCompanion/reducer";

type StartOptions = { locale: Locale; project: string; resume?: string };
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
const said = (state: CompanionState) => state.lines.some((line) => line.final && line.text.trim() !== "");
/** A session that drops after something was said leaves its call to resume. */
function dropped(state: CompanionState, event: CompanionEvent, sessionId: string): CompanionState {
  const cut = event.type === "session.closed" ? DROPS.has(event.reason) : event.type === "error" && event.code === "CONNECTION_LOST";
  if (!cut || !said(state) || state.resumable?.sessionId === sessionId) return state;
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
    return { ...previous, awaitingReady: false, resuming: null, state: { ...previous.state, resumable, reconnected: false, revision: previous.state.revision + 1 } };
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

export interface CompanionStore {
  get(): CompanionState;
  /** A start was asked for and its session is not ready yet: what the state still holds belongs to the one before. */
  awaiting(): boolean;
  /** Called when anything but a level sample changed. */
  subscribe(listener: () => void): () => void;
  /** Called for every change of the mouth level or the played time: one transform per sample, no render. */
  onLevel(listener: (state: CompanionState) => void): () => void;
  /** Subscribes to the adapter and asks once for a dropped call to offer; the returned function releases its
   * microphone, transport and delivery observer. */
  connect(): () => void;
  start(options: StartOptions): Promise<void>;
  setProject(project: string | null): Promise<void>;
  command(command: CompanionCommand): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
}

/** The same session rules as the hook below, outside React: the floating companion reads this, so a
 * played-audio level sample moves the mouth without rendering the component sixty times a second. */
export function createCompanionStore(adapter: VoiceCompanionAdapter): CompanionStore {
  let snapshot = initial;
  const views = new Set<() => void>();
  const levels = new Set<(state: CompanionState) => void>();
  const apply = (action: Action) => {
    const before = snapshot.state;
    snapshot = receive(snapshot, action);
    const state = snapshot.state;
    if (state === before) return;
    if (state.mouth !== before.mouth || state.playedMs !== before.playedMs) for (const listener of [...levels]) listener(state);
    if (state.revision !== before.revision || state.generation !== before.generation) for (const listener of [...views]) listener();
  };
  return {
    get: () => snapshot.state,
    awaiting: () => snapshot.awaitingReady,
    subscribe: (listener) => { views.add(listener); return () => { views.delete(listener); }; },
    onLevel: (listener) => { levels.add(listener); return () => { levels.delete(listener); }; },
    connect: () => {
      let active = true;
      const unsubscribe = adapter.subscribe((event) => { if (active) apply({ type: "event", adapter, event }); });
      /* A page that reloaded, or a browser that came back, finds the call it dropped. */
      void adapter.resumable?.().then((call) => { if (active && call) apply({ type: "resumable", adapter, call }); }).catch(() => undefined);
      return () => { active = false; unsubscribe(); void (adapter.dispose?.() ?? adapter.close()).catch(() => undefined); };
    },
    start: async (options) => {
      apply({ type: "start", adapter, resume: options.resume });
      try { await adapter.start(options); }
      catch (error) { apply({ type: "failed-start", adapter, code: failureCode(error) }); throw error; }
    },
    setProject: project => adapter.setProject?.(project) ?? Promise.resolve(),
    command: (value) => adapter.command(value),
    stop: () => adapter.close(),
    refresh: () => adapter.refresh?.() ?? Promise.resolve(),
  };
}

/** The view supplies a stable adapter. Only an explicit start action opens
 * a session; closing the view releases the adapter's microphone and transport. */
export function useVoiceCompanion(adapter: VoiceCompanionAdapter): VoiceCompanionHook {
  const [snapshot, dispatch] = useReducer(receive, initial);
  useEffect(() => {
    let active = true;
    const unsubscribe = adapter.subscribe(event => { if (active) dispatch({ type: "event", adapter, event }); });
    void adapter.resumable?.().then((call) => { if (active && call) dispatch({ type: "resumable", adapter, call }); }).catch(() => undefined);
    return () => { active = false; unsubscribe(); void (adapter.dispose?.() ?? adapter.close()); };
  }, [adapter]);
  const start = useCallback(async (options: StartOptions) => {
    dispatch({ type: "start", adapter, resume: options.resume });
    try { await adapter.start(options); }
    catch (error) { dispatch({ type: "failed-start", adapter, code: failureCode(error) }); throw error; }
  }, [adapter]);
  const setProject = useCallback((project: string | null) => adapter.setProject?.(project) ?? Promise.resolve(), [adapter]);
  const command = useCallback((value: CompanionCommand) => adapter.command(value), [adapter]);
  const stop = useCallback(() => adapter.close(), [adapter]);
  const refresh = useCallback(() => adapter.refresh?.() ?? Promise.resolve(), [adapter]);
  return { state: snapshot.adapter === adapter ? snapshot.state : INITIAL_COMPANION_STATE, start, setProject, command, stop, refresh };
}
