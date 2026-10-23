"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import type { RetainedCall } from "@/lib/voiceCompanion/callHistoryTypes";

/**
 * The operator's retained calls for the conversation panel (GitHub #2975). Read when the page opens, so a page that
 * reloaded after a call, and never saw it, can still open it, and again each time the panel opens, so a call that
 * ended since is listed. `target` is the call the panel reads: the one chosen, else this page's own call, else the
 * newest retained one. Undefined means this page's own call, which the adapter reads without an id.
 */
export function useRetainedCalls(adapter: VoiceCompanionAdapter, reading: boolean, ownSeen: boolean) {
  const [calls, setCalls] = useState<RetainedCall[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const own = useRef<string | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (!adapter.calls || (!reading && opened.current)) return;
    opened.current = true;
    let alive = true;
    adapter.calls().then((list) => { if (alive) setCalls(list); }).catch(() => undefined);
    return () => { alive = false; };
  }, [adapter, reading]);
  const target = chosen ?? (ownSeen ? undefined : calls?.[0]?.sessionId);
  return {
    calls, target,
    /** The shown call is still running: its record is read again while it lasts. */
    live: target !== undefined && !!calls?.find((call) => call.sessionId === target)?.live,
    /** Records the id of the call a read without an id answered for, so choosing it again follows it live. */
    observe: useCallback((sessionId: string | undefined, forOwn: boolean) => { if (forOwn && sessionId) own.current = sessionId; }, []),
    choose: useCallback((sessionId: string | null) => setChosen(sessionId !== null && sessionId === own.current ? null : sessionId), []),
  };
}
