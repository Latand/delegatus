"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n/core";
import type { MemoryProfileView, ProfileError } from "@/lib/memory/profileTypes";

/** Frames are complete snapshots; UTF-8 and line boundaries may span network chunks. */
export async function readProfileStream(body: ReadableStream<Uint8Array>, accept: (view: MemoryProfileView) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) accept(JSON.parse(line));
      }
      if (done) { if (buffer.trim()) accept(JSON.parse(buffer)); break; }
    }
  } finally { reader.releaseLock(); }
}

export function useMemoryProfile(project: string, locale: Locale, rulesRevision: unknown) {
  const [view, setView] = useState<MemoryProfileView | null>(null);
  const [error, setError] = useState<ProfileError | null>(null);
  const [sending, setSending] = useState(false);
  const [context, setContext] = useState({ project, locale });
  if (context.project !== project || context.locale !== locale) {
    setContext({ project, locale });
    setView(null); setError(null); setSending(false);
  }
  const sequence = useRef(0);
  const streamActive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const currentView = useRef(view);
  useEffect(() => { currentView.current = view; }, [view]);
  const read = useCallback(async () => {
    if (streamActive.current || !controller.current) return;
    const signal = controller.current.signal;
    const revision = ++sequence.current;
    try {
      const response = await fetch(`/api/role-memory/profile?project=${encodeURIComponent(project)}&locale=${locale}`, { cache: "no-store", signal });
      if (!response.ok) throw Error();
      const value = await response.json() as MemoryProfileView;
      if (revision === sequence.current && !signal.aborted) { setView(value); setError(null); }
    } catch { if (revision === sequence.current && !signal.aborted) setError("failed"); }
  }, [project, locale]);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    streamActive.current = false;
    void read();
    let ticks = 0;
    const timer = setInterval(() => {
      if (currentView.current?.run?.state === "running" || ++ticks % 7 === 0) void read();
    }, 2_000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [read]);
  useEffect(() => { void read(); }, [rulesRevision, read]);
  const summarize = useCallback(async () => {
    if (streamActive.current || !controller.current) return;
    const signal = controller.current.signal;
    const revision = ++sequence.current;
    streamActive.current = true; setSending(true); setError(null);
    try {
      const response = await fetch("/api/role-memory/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, locale }), signal });
      if (!response.ok || !response.body) {
        const result = await response.json().catch(() => ({}));
        if (!signal.aborted && revision === sequence.current) setError(result.error === "size" ? "size" : "failed");
        return;
      }
      let terminal = false;
      await readProfileStream(response.body, value => {
        terminal = value.run?.state !== "running";
        if (!signal.aborted && revision === sequence.current) setView(value);
      });
      if (!terminal) throw Error("incomplete profile stream");
    } catch { if (!signal.aborted && revision === sequence.current) setError("failed"); }
    finally {
      if (!signal.aborted && revision === sequence.current) { streamActive.current = false; setSending(false); }
    }
  }, [project, locale]);
  return { view: view?.locale === locale ? view : null, error, running: sending || view?.run?.state === "running", summarize };
}
