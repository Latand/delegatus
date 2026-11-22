"use client";

import { useEffect, useMemo, useReducer, useState } from "react";

import type { FileEntry } from "@/lib/types";
import { resolveSeatFile } from "./seatState";

export const SEAT_TRANSCRIPT_TIMEOUT_MS = 1_800;

export function useSeatFile(input: {
  project: string;
  files: readonly FileEntry[];
  conversationId: string | null;
  seatPath: string | null;
  currentPath: string | null;
  enabled: boolean;
}): { file: FileEntry | null; transcriptMissing: boolean; transcriptPending: boolean; retryTranscript: () => void } {
  const { project, files, conversationId, seatPath, currentPath, enabled } = input;
  const boardFile = useMemo(() => resolveSeatFile({ files, conversationId, seatPath, currentPath }),
    [files, conversationId, seatPath, currentPath]);
  const [attempt, retryTranscript] = useReducer((value: number) => value + 1, 0);
  // A change in the incumbent's generation invalidates a previous answer.
  const key = enabled && conversationId
    ? JSON.stringify([project, conversationId, seatPath, currentPath ?? seatPath, attempt])
    : null;
  const [lookup, setLookup] = useState<{ key: string; file: FileEntry | null } | null>(null);
  const hasBoardFile = boardFile !== null;
  const found = lookup && lookup.key === key ? lookup.file : null;

  useEffect(() => {
    if (!key || hasBoardFile) return;
    const controller = new AbortController();
    const finish = (file: FileEntry | null) => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      setLookup({ key, file });
    };
    const timer = setTimeout(() => {
      finish(null);
      controller.abort();
    }, SEAT_TRANSCRIPT_TIMEOUT_MS);
    void (async () => {
      try {
        const query = new URLSearchParams({ project });
        const response = await fetch(`/api/orchestrator/seat/transcript?${query}`, { signal: controller.signal });
        const result = response.ok ? await response.json() as { conversationId: string; file: FileEntry | null } | null : null;
        finish(result?.conversationId === conversationId && result?.file?.conversationId === conversationId ? result.file : null);
      } catch {
        finish(null);
      }
    })();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, hasBoardFile, project, conversationId]);

  return {
    file: boardFile ?? found,
    transcriptMissing: !boardFile && key !== null && lookup?.key === key && !found,
    transcriptPending: !boardFile && key !== null && lookup?.key !== key,
    retryTranscript,
  };
}
