"use client";

import { useCallback, useEffect, useReducer } from "react";
import type { CompanionCommand, CompanionEvent, Locale, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CompanionState } from "@/lib/voiceCompanion/reducer";

export interface VoiceCompanionHook {
  state: CompanionState;
  start(options: { locale: Locale; project: string }): Promise<void>;
  command(command: CompanionCommand): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
}

interface Snapshot { adapter: VoiceCompanionAdapter | null; sessionId: string | null; state: CompanionState; retired: ReadonlySet<string>; awaitingReady: boolean }
type Action = { type: "start" | "failed-start"; adapter: VoiceCompanionAdapter } | { type: "event"; adapter: VoiceCompanionAdapter; event: CompanionEvent };
const initial: Snapshot = { adapter: null, sessionId: null, state: INITIAL_COMPANION_STATE, retired: new Set(), awaitingReady: false };
function receive(previous: Snapshot, action: Action): Snapshot {
  if (action.type === "start") return { ...(previous.adapter === action.adapter ? previous : initial), adapter: action.adapter, awaitingReady: true };
  if (previous.adapter !== action.adapter) return previous;
  if (action.type === "failed-start") return { ...previous, awaitingReady: false };
  if (action.type !== "event") return previous;
  const event = action.event;
  if (event.sessionId === previous.sessionId) return { ...previous, state: reduceCompanion(previous.state, event),
    awaitingReady: event.type === "session.ready" && event.generation > previous.state.generation ? false : previous.awaitingReady };
  if (event.type !== "session.ready" || !previous.awaitingReady || previous.retired.has(event.sessionId)) return previous;
  return { ...previous, sessionId: event.sessionId, awaitingReady: false,
    retired: new Set([...previous.retired, ...(previous.sessionId ? [previous.sessionId] : [])]), state: reduceCompanion(INITIAL_COMPANION_STATE, event) };
}

export interface CompanionStore {
  get(): CompanionState;
  /** A start was asked for and its session is not ready yet: what the state still holds belongs to the one before. */
  awaiting(): boolean;
  /** Called when anything but a level sample changed. */
  subscribe(listener: () => void): () => void;
  /** Called for every change of the mouth level or the played time: one transform per sample, no render. */
  onLevel(listener: (state: CompanionState) => void): () => void;
  /** Subscribes to the adapter; the returned function releases its microphone, transport and delivery observer. */
  connect(): () => void;
  start(options: { locale: Locale; project: string }): Promise<void>;
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
      return () => { active = false; unsubscribe(); void (adapter.dispose?.() ?? adapter.close()).catch(() => undefined); };
    },
    start: async (options) => {
      apply({ type: "start", adapter });
      try { await adapter.start(options); }
      catch (error) { apply({ type: "failed-start", adapter }); throw error; }
    },
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
    return () => { active = false; unsubscribe(); void (adapter.dispose?.() ?? adapter.close()); };
  }, [adapter]);
  const start = useCallback(async (options: { locale: Locale; project: string }) => {
    dispatch({ type: "start", adapter });
    try { await adapter.start(options); }
    catch (error) { dispatch({ type: "failed-start", adapter }); throw error; }
  }, [adapter]);
  const command = useCallback((value: CompanionCommand) => adapter.command(value), [adapter]);
  const stop = useCallback(() => adapter.close(), [adapter]);
  const refresh = useCallback(() => adapter.refresh?.() ?? Promise.resolve(), [adapter]);
  return { state: snapshot.adapter === adapter ? snapshot.state : INITIAL_COMPANION_STATE, start, command, stop, refresh };
}
