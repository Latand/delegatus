"use client";

import { useEffect, useState } from "react";

/** A hint from the same server read used at admission. Every click is checked
 * again by the command, so a turn ending between poll and click falls back. */
export function useSeatParallelBusy(project: string | null, conversationId: string | null, enabled: boolean): boolean | null {
  const [reading, setReading] = useState<{ project: string; conversationId: string; busy: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || !project || !conversationId) return;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { controller?.abort(); clearTimeout(timer); };
    const start = () => {
      stop();
      if (document.visibilityState === "hidden") return;
      const active = new AbortController();
      controller = active;
      const poll = async () => {
        try {
          const response = await fetch(`/api/orchestrator/ghost?project=${encodeURIComponent(project)}`, { signal: active.signal });
          const body = await response.json() as { conversationId?: string; busy?: boolean };
          if (!active.signal.aborted && response.ok && body.conversationId === conversationId && typeof body.busy === "boolean") {
            setReading({ project, conversationId, busy: body.busy });
          }
        } catch { /* The command reports an unavailable reading on submission. */ }
        if (!active.signal.aborted) timer = setTimeout(poll, 2_000);
      };
      void poll();
    };
    document.addEventListener("visibilitychange", start);
    start();
    return () => { stop(); document.removeEventListener("visibilitychange", start); };
  }, [project, conversationId, enabled]);
  return enabled && reading?.project === project && reading.conversationId === conversationId ? reading.busy : null;
}
