"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeBus, isRuntimeUiEnabled } from "@/hooks/runtimeBus";
import { filesPollCadence } from "@/hooks/useFiles";
import type { ReportLogEntry, ReportLogPage } from "@/lib/bridge/reportLog";
import { documentHidden } from "@/lib/client/hiddenTraffic";

import { noteBridgeReportsSetting } from "./bridgeReportsSetting";
import { mergeNewest } from "./reportLogModel";

/** One page of the log. */
export const REPORT_LOG_PAGE = 30;
/** After a `files.revision`, as the board waits before its own read. */
const REVISION_DEBOUNCE_MS = 400;
/** The board's fallback cadence while the live stream is down. */
const FALLBACK_POLL_MS = 10_000;

export interface ReportLogRead {
  entries: ReportLogEntry[];
  /** Null until the first page answers. */
  loaded: boolean;
  failed: boolean;
  bridgeReports: boolean | null;
  github: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}

function pageUrl(project: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams({ project, limit: String(REPORT_LOG_PAGE) });
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return `/api/orchestrator/reports?${query.toString()}`;
}

async function fetchPage(url: string): Promise<ReportLogPage | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json() as ReportLogPage;
  } catch {
    return null;
  }
}

/**
 * One project's report log (#2146), newest first. The first page loads while
 * `active`; a newer report arrives on the board's own live transport — the
 * runtime bus's `files.revision`, with the board's ten-second poll while that
 * stream is down — and older pages load on request. Reading never touches the
 * voice relay's cursor: the route is a read. One project per mount: a caller
 * showing another project keys the log by it.
 */
export function useReportLog(project: string, active: boolean, initial?: ReportLogPage): ReportLogRead {
  const [entries, setEntries] = useState<ReportLogEntry[]>(() => initial?.entries ?? []);
  const [nextBefore, setNextBefore] = useState<number | null>(initial?.nextBefore ?? null);
  const [loaded, setLoaded] = useState(Boolean(initial));
  const [failed, setFailed] = useState(false);
  const [bridgeReports, setBridgeReports] = useState<boolean | null>(initial?.bridgeReports ?? null);
  const [github, setGithub] = useState<string | null>(initial?.github ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const held = useRef({ entries, nextBefore, revision: initial?.revision ?? null as string | null, project });

  const refresh = useCallback(async () => {
    const asked = project;
    const revision = held.current.revision;
    const page = await fetchPage(pageUrl(asked, revision ? { since: revision } : {}));
    if (held.current.project !== asked) return;
    if (!page) {
      if (!held.current.revision) setFailed(true);
      return;
    }
    setFailed(false);
    setLoaded(true);
    setBridgeReports(page.bridgeReports);
    noteBridgeReportsSetting(asked, page.bridgeReports);
    setGithub(page.github);
    held.current.revision = page.revision;
    if (page.unchanged) return;
    const merged = mergeNewest(held.current.entries, held.current.nextBefore, page);
    held.current.entries = merged.entries;
    held.current.nextBefore = merged.nextBefore;
    setEntries(merged.entries);
    setNextBefore(merged.nextBefore);
  }, [project]);

  useEffect(() => {
    if (!active || initial) return;
    void refresh();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; void refresh(); }, REVISION_DEBOUNCE_MS);
    };
    const setCadence = (next: "poll" | "live") => {
      if (next === "live") {
        if (poll) clearInterval(poll);
        poll = null;
      } else if (!poll) {
        poll = setInterval(() => { if (!documentHidden()) void refresh(); }, FALLBACK_POLL_MS);
      }
    };
    let unsubscribeBus = () => {};
    let unsubscribeFiles = () => {};
    if (isRuntimeUiEnabled() && typeof window !== "undefined") {
      const bus = getRuntimeBus();
      const applyConnection = () => setCadence(filesPollCadence(bus.getState().connection));
      applyConnection();
      unsubscribeBus = bus.subscribe(applyConnection);
      unsubscribeFiles = bus.subscribeFilesRevision(schedule);
    } else {
      setCadence("poll");
    }
    return () => {
      unsubscribeBus();
      unsubscribeFiles();
      if (debounce) clearTimeout(debounce);
      if (poll) clearInterval(poll);
    };
  }, [active, initial, refresh]);

  const loadOlder = useCallback(() => {
    const before = held.current.nextBefore;
    if (before === null || loadingOlder) return;
    const asked = project;
    setLoadingOlder(true);
    void fetchPage(pageUrl(asked, { before })).then((page) => {
      setLoadingOlder(false);
      if (!page || held.current.project !== asked || held.current.nextBefore !== before) return;
      const known = new Set(held.current.entries.map((entry) => entry.seq));
      held.current.entries = [...held.current.entries, ...page.entries.filter((entry) => !known.has(entry.seq))];
      held.current.nextBefore = page.nextBefore;
      setEntries(held.current.entries);
      setNextBefore(page.nextBefore);
    });
  }, [project, loadingOlder]);

  return {
    entries,
    loaded,
    failed,
    bridgeReports,
    github,
    hasOlder: nextBefore !== null,
    loadingOlder,
    loadOlder,
  };
}
