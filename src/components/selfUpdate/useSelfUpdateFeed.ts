"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Snapshot } from "@/lib/selfUpdate/types";

/* The Snapshot feed for the Update surface (#2007): server-sent events, and
   after two failed connections a read of /api/self-update every second
   (the footer says which). A restart takes the web process away mid-stream;
   polling is what finds the next one answering, and the stream is tried
   again once it does. */

export type Live = "connecting" | "sse" | "polling";

export interface Feed {
  snapshot: Snapshot | null;
  live: Live;
  /** The last read failed: nothing answers right now. */
  offline: boolean;
  /** The server answered that it could not read the install, and why (#2594). */
  failure: string | null;
  accept(snapshot: Snapshot): void;
}

const POLL_MS = 1_000;

/** `work: false` leaves out the work in progress, which only the dialog
    shows: a background reader then never starts the reading of it. */
export function useSelfUpdateFeed(readOnly = false, work = true): Feed {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<Live>("connecting");
  const [offline, setOffline] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const source = useRef<EventSource | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const closed = useRef(false);

  const accept = useCallback((next: Snapshot) => {
    setSnapshot(next);
    setOffline(false);
    setFailure(null);
  }, []);

  useEffect(() => {
    closed.current = false;
    const query = [readOnly ? "readOnly=1" : "", work ? "" : "work=0"].filter(Boolean).join("&");
    const suffix = query ? `?${query}` : "";
    let errors = 0;
    const stopPolling = () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
    const connect = () => {
      if (closed.current) return;
      if (typeof EventSource === "undefined") { startPolling(); return; }
      const events = new EventSource(`/api/self-update/events${suffix}`);
      source.current = events;
      events.addEventListener("state", (event) => {
        errors = 0;
        setLive("sse");
        stopPolling();
        try { accept(JSON.parse((event as MessageEvent<string>).data) as Snapshot); } catch { /* next event */ }
      });
      events.addEventListener("snapshot-error", (event) => {
        errors = 0;
        setLive("sse");
        try { setFailure((JSON.parse((event as MessageEvent<string>).data) as { error?: string }).error ?? ""); } catch { setFailure(""); }
      });
      events.addEventListener("error", () => {
        errors += 1;
        if (errors >= 2) {
          events.close();
          source.current = null;
          startPolling();
        }
      });
    };
    const startPolling = () => {
      if (pollTimer.current || closed.current) return;
      setLive("polling");
      let answered = 0;
      const tick = async () => {
        try {
          const response = await fetch(`/api/self-update${suffix}`, { cache: "no-store" });
          if (response.status === 503) {
            const body = await response.json().catch(() => null) as { code?: string; error?: string } | null;
            if (body?.code === "snapshot-failed") { setOffline(false); setFailure(body.error ?? ""); return; }
          }
          if (!response.ok) throw new Error(String(response.status));
          accept(await response.json() as Snapshot);
          answered += 1;
          /* The server is back: go live again. */
          if (answered >= 2 && typeof EventSource !== "undefined" && !source.current) {
            stopPolling();
            errors = 0;
            connect();
          }
        } catch {
          setOffline(true);
          answered = 0;
        }
      };
      void tick();
      pollTimer.current = setInterval(() => { void tick(); }, POLL_MS);
    };
    const onDecision = (event: Event) => accept((event as CustomEvent<Snapshot>).detail);
    window.addEventListener("llv:auto-drain-decision", onDecision);
    connect();
    return () => {
      window.removeEventListener("llv:auto-drain-decision", onDecision);
      closed.current = true;
      source.current?.close();
      source.current = null;
      stopPolling();
    };
  }, [accept, readOnly, work]);

  return { snapshot, live, offline, failure, accept };
}
