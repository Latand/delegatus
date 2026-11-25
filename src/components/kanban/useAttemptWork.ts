"use client";

import { useEffect, useRef, useState } from "react";

import type { TranscriptWork } from "@/lib/board/attemptWork";

/** An attempt that has not settled is read again after this long on the board's clock. */
export const WORK_REFRESH_MS = 30_000;

export interface WantedWork {
  /** The conversation id or transcript path the attempt recorded. */
  identity: string;
  /** The attempt is over, so its transcript will not gain turns that belong to it. */
  settled: boolean;
}

/** `null`: the server has no readable transcript for the identity, or the read failed. */
export type WorkRead = { at: number; work: TranscriptWork | null };
export type WorkLoader = (identity: string, signal: AbortSignal) => Promise<TranscriptWork | null>;

export const loadAttemptWork: WorkLoader = async (identity, signal) => {
  const response = await fetch(`/api/board/work-time?conversationId=${encodeURIComponent(identity)}`, { signal });
  if (!response.ok) throw new Error(`work-time ${response.status}`);
  const body = await response.json() as { work?: Record<string, TranscriptWork | null> };
  return body.work?.[identity] ?? null;
};

/**
 * The turn windows of the transcripts behind the chart's open stage rows. A
 * settled attempt is read once; a running one again every 30 s of the board's
 * clock. A failed or unread answer keeps what was known and is retried on the same
 * schedule, so a refusing server is asked twice a minute, not on every render.
 * `reads` has no entry for an identity until its first answer arrives.
 */
export function useAttemptWork(wanted: readonly WantedWork[], nowMs: number, load: WorkLoader = loadAttemptWork): ReadonlyMap<string, WorkRead> {
  const [reads, setReads] = useState<ReadonlyMap<string, WorkRead>>(() => new Map());
  const asked = useRef(new Map<string, number>());
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    lifetime.current = new AbortController();
    const questions = asked.current;
    return () => { lifetime.current?.abort(); questions.clear(); };
  }, []);
  // The schedule runs on the board's clock in 30 s steps, so a tick inside a step asks nothing.
  const step = Math.floor(nowMs / WORK_REFRESH_MS);
  const key = JSON.stringify([...new Map(wanted.map(item => [item.identity, item.settled])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  useEffect(() => {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    const at = step * WORK_REFRESH_MS;
    for (const [identity, settled] of JSON.parse(key) as Array<[string, boolean]>) {
      const askedAt = asked.current.get(identity);
      if (askedAt !== undefined && (settled || at - askedAt < WORK_REFRESH_MS)) continue;
      asked.current.set(identity, at);
      load(identity, signal).then(work => {
        if (signal.aborted) return;
        // An unread answer (the file moved, was too large or could not be read through) is no evidence: it never replaces a value
        // that was known, and the identity is asked again at the next step even when its attempt has settled.
        const unread = !!work && !work.complete;
        if (unread) asked.current.delete(identity);
        setReads(current => {
          const known = current.get(identity)?.work;
          return new Map(current).set(identity, { at, work: unread && known?.complete ? known : work });
        });
      }, () => {
        // A failed read keeps what was known and is asked again at the next step, settled or not.
        if (signal.aborted) return;
        asked.current.delete(identity);
        setReads(current => new Map(current).set(identity, { at, work: current.get(identity)?.work ?? null }));
      });
    }
  }, [key, step, load]);
  return reads;
}
