"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeBus, isRuntimeUiEnabled } from "@/hooks/runtimeBus";
import { filesPollCadence } from "@/hooks/useFiles";
import type { ReportLogAsk } from "@/lib/asks/types";
import type { ReportLogEntry, ReportLogPage } from "@/lib/bridge/reportLog";
import { documentHidden } from "@/lib/client/hiddenTraffic";

import { noteBridgeReportsSetting } from "./bridgeReportsSetting";
import { mergeAsks, mergeNewest, mergeNewestAsks } from "./reportLogModel";

/** One page of the log. */
export const REPORT_LOG_PAGE = 30;
/** After a `files.revision`, as the board waits before its own read. */
const REVISION_DEBOUNCE_MS = 400;
/** The board's fallback cadence while the live stream is down. */
const FALLBACK_POLL_MS = 10_000;

export interface ReportLogRead {
  entries: ReportLogEntry[];
  /** The Viewer's "Asks you" lines, newest first. */
  asks: ReportLogAsk[];
  /** Null until the first page answers. */
  loaded: boolean;
  failed: boolean;
  bridgeReports: boolean | null;
  github: string | null;
  /** Older reports or older ask lines remain on the server. */
  hasOlder: boolean;
  /** Which of the two still has older lines: a row shows only once both
      kinds hold everything newer than it. */
  olderReports: boolean;
  olderAsks: boolean;
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
  const [asks, setAsks] = useState<ReportLogAsk[]>(() => initial?.asks ?? []);
  const [nextBefore, setNextBefore] = useState<number | null>(initial?.nextBefore ?? null);
  const [asksBefore, setAsksBefore] = useState<string | null>(initial?.nextAsksBefore ?? null);
  const [loaded, setLoaded] = useState(Boolean(initial));
  const [failed, setFailed] = useState(false);
  const [bridgeReports, setBridgeReports] = useState<boolean | null>(initial?.bridgeReports ?? null);
  const [github, setGithub] = useState<string | null>(initial?.github ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const held = useRef({ entries, asks, nextBefore, asksBefore, revision: initial?.revision ?? null as string | null, project });

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
    /* A server from before the ask lines answers none. */
    const askMerge = mergeNewestAsks(held.current.asks, held.current.asksBefore, { asks: page.asks ?? [], nextAsksBefore: page.nextAsksBefore ?? null });
    held.current.asks = askMerge.asks;
    held.current.asksBefore = askMerge.nextAsksBefore;
    setEntries(merged.entries);
    setAsks(held.current.asks);
    setNextBefore(merged.nextBefore);
    setAsksBefore(askMerge.nextAsksBefore);
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

  /* Both kinds page back on their own cursor, in one request; a kind already
     at its start keeps what it holds, whatever the page says of it. */
  const loadOlder = useCallback(() => {
    const before = held.current.nextBefore;
    const asksCursor = held.current.asksBefore;
    if ((before === null && asksCursor === null) || loadingOlder) return;
    const asked = project;
    setLoadingOlder(true);
    const params: Record<string, string | number> = {};
    if (before !== null) params.before = before;
    if (asksCursor !== null) params.asksBefore = asksCursor;
    void fetchPage(pageUrl(asked, params)).then((page) => {
      setLoadingOlder(false);
      if (!page || held.current.project !== asked || held.current.nextBefore !== before || held.current.asksBefore !== asksCursor) return;
      if (before !== null) {
        const known = new Set(held.current.entries.map((entry) => entry.seq));
        held.current.entries = [...held.current.entries, ...page.entries.filter((entry) => !known.has(entry.seq))];
        held.current.nextBefore = page.nextBefore;
      }
      if (asksCursor !== null) {
        held.current.asks = mergeAsks(held.current.asks, page.asks ?? []);
        held.current.asksBefore = page.nextAsksBefore ?? null;
      }
      setEntries(held.current.entries);
      setAsks(held.current.asks);
      setNextBefore(held.current.nextBefore);
      setAsksBefore(held.current.asksBefore);
    });
  }, [project, loadingOlder]);

  return {
    entries,
    asks,
    loaded,
    failed,
    bridgeReports,
    github,
    hasOlder: nextBefore !== null || asksBefore !== null,
    olderReports: nextBefore !== null,
    olderAsks: asksBefore !== null,
    loadingOlder,
    loadOlder,
  };
}
