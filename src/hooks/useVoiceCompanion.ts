"use client";

import { useCallback, useEffect, useReducer } from "react";
import type { CompanionCommand, CompanionEvent, Locale, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CompanionState } from "@/lib/voiceCompanion/reducer";

export interface VoiceCompanionHook {
  state: CompanionState;
  start(options: { locale: Locale; project: string }): Promise<void>;
  command(command: CompanionCommand): Promise<void>;
  stop(): Promise<void>;
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

/** The view supplies a stable adapter. Only an explicit start action opens
 * a session; closing the view releases the adapter's microphone and transport. */
export function useVoiceCompanion(adapter: VoiceCompanionAdapter): VoiceCompanionHook {
  const [snapshot, dispatch] = useReducer(receive, initial);
  useEffect(() => {
    let active = true;
    const unsubscribe = adapter.subscribe(event => { if (active) dispatch({ type: "event", adapter, event }); });
    return () => { active = false; unsubscribe(); void adapter.close(); };
  }, [adapter]);
  const start = useCallback(async (options: { locale: Locale; project: string }) => {
    dispatch({ type: "start", adapter });
    try { await adapter.start(options); }
    catch (error) { dispatch({ type: "failed-start", adapter }); throw error; }
  }, [adapter]);
  const command = useCallback((value: CompanionCommand) => adapter.command(value), [adapter]);
  const stop = useCallback(() => adapter.close(), [adapter]);
  return { state: snapshot.adapter === adapter ? snapshot.state : INITIAL_COMPANION_STATE, start, command, stop };
}
