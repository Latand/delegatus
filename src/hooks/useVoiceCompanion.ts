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

/** The view supplies a stable adapter. Only an explicit start action opens
 * a session; closing the view releases the adapter's microphone and transport. */
export function useVoiceCompanion(adapter: VoiceCompanionAdapter): VoiceCompanionHook {
  const [snapshot, dispatch] = useReducer((previous: { sessionId: string | null; state: CompanionState }, event: CompanionEvent) => ({
    sessionId: event.sessionId,
    state: reduceCompanion(previous.sessionId === event.sessionId ? previous.state : INITIAL_COMPANION_STATE, event),
  }), { sessionId: null, state: INITIAL_COMPANION_STATE });
  useEffect(() => {
    const unsubscribe = adapter.subscribe(dispatch);
    return () => { unsubscribe(); void adapter.close(); };
  }, [adapter]);
  const start = useCallback((options: { locale: Locale; project: string }) => adapter.start(options), [adapter]);
  const command = useCallback((value: CompanionCommand) => adapter.command(value), [adapter]);
  const stop = useCallback(() => adapter.close(), [adapter]);
  return { state: snapshot.state, start, command, stop };
}
