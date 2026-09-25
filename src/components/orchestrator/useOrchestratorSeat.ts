"use client";

import { useCallback, useEffect, useState } from "react";

import { documentHidden } from "@/lib/client/hiddenTraffic";
import type { SeatRefs } from "@/lib/tasks/groupHide";

import { parseSeatStatus, seatConversationsOf, type OrchestratorSeatStatus } from "./seatState";

/** How often the panel re-reads the project's seat. The seat only moves when
    the operator (or a rotation) moves it, so this is a slow status read — the
    conversation itself streams through the feed's own channel. */
export const SEAT_POLL_MS = 6_000;

export interface OrchestratorSeatRead {
  /** Null until the first answer for THIS project; a later failure keeps the
      last good read rather than blanking the panel. */
  status: OrchestratorSeatStatus | null;
  /** The last attempt failed. With no `status` yet, the panel says so instead
      of showing an empty draft — which would invite a second orchestrator. */
  failed: boolean;
  refresh: () => Promise<void>;
}

interface ScopedRead {
  /** The project this answer is about; an answer for any other project is
      reconciled away at render time rather than shown for a frame. */
  project: string;
  cwd: string;
  status: OrchestratorSeatStatus | null;
  failed: boolean;
}

/**
 * Every answer this tab has been given, keyed by project and cwd (#1149).
 *
 * The panel is RE-SEATED on a project switch — a fresh mount, because its draft
 * belongs to one project — so the answer cannot live in its state and survive.
 * Here it does: a project the operator has already visited paints its last
 * answer in the FIRST commit after the switch and the effect below revalidates
 * behind it, instead of paying a round-trip to be told what it already knew.
 * The loading state is left to a project this tab has never answered for.
 *
 * Session-only, in memory: a seat that changed while the tab was closed must
 * still be READ, never restored from disk.
 */
const answers = new Map<string, ScopedRead>();
const readKey = (project: string, cwd: string | undefined): string => `${project}\0${cwd ?? ""}`;

/** The last cross-project answer this tab was given (#1841), shared by every
    mount of {@link useSeatConversations} for the same reason the per-project
    cache exists: a surface that re-opens paints what it already knew. */
let seatConversations: SeatRefs | null = null;

/**
 * The one poll behind every mount reading the same project and cwd (#1841).
 *
 * The seat is read from more than one place at once on purpose — the dock's
 * panel beside the board, the board's own seat frame, the phone's focus view
 * and the seat card under it — and they all want the same document. The answer
 * cache above is shared, but a `setInterval` per MOUNT is not an answer being
 * shared, it is the same request made twice on the same cadence. So the poll
 * belongs to the KEY: the first mount for a key starts it, later mounts join
 * it, and it stops when the last one leaves. Each arrival still revalidates
 * once — an opening surface asks whether the seat moved — and arrivals that
 * find a read in flight share that one. One request per key per interval,
 * however many surfaces read it.
 */
interface SeatPoll {
  /** Every mount reading this key. Publishing answers all of them at once. */
  listeners: Set<(read: ScopedRead) => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** Aborted when the last mount leaves, so a read in flight for a scope nobody
      is watching any more does not settle behind them. */
  controller: AbortController | null;
  /** A read is out. A tick that finds one still in flight — a slow answer, a
      surface mounting mid-interval — waits for it rather than asking for the
      same document a second time. */
  pending: boolean;
}
const polls = new Map<string, SeatPoll>();

/* A hidden tab skips its seat ticks (#1994) and reads once on return, so a
   Viewer in the background stops re-reading seats nobody sees. Neither the
   agent chimes nor the title count read the seat, so this holds on a desktop
   as well as on a phone. */

let seatVisibilityListening = false;
function listenForSeatVisibility(): void {
  if (seatVisibilityListening || typeof document === "undefined") return;
  seatVisibilityListening = true;
  document.addEventListener("visibilitychange", () => {
    if (documentHidden()) return;
    for (const [key, poll] of polls) {
      const [project, cwd] = key.split("\0");
      if (poll.listeners.size) loadSeat(project, cwd || undefined, key);
    }
  });
}

/** Give every mount of `key` the answer, and keep it for the next one. */
function publishSeat(key: string, next: ScopedRead): void {
  answers.set(key, next);
  for (const listener of polls.get(key)?.listeners ?? []) listener(next);
}

function settleSeat(project: string, cwd: string | undefined, status: OrchestratorSeatStatus | null, failed: boolean): void {
  const key = readKey(project, cwd);
  publishSeat(key, {
    project,
    cwd: cwd ?? "",
    /* A failed re-read keeps the last good answer for the SAME project; the
       cache is keyed by project and cwd, so it cannot resurrect another
       checkout's registration status. */
    status: status ?? answers.get(key)?.status ?? null,
    failed,
  });
}

function loadSeat(project: string, cwd: string | undefined, key: string): void {
  const poll = polls.get(key);
  if (!poll || poll.pending || !poll.controller) return;
  poll.pending = true;
  void fetchOrchestratorSeat(project, cwd, poll.controller.signal)
    .then((status) => settleSeat(project, cwd, status, false))
    .catch((cause: unknown) => {
      if ((cause as { name?: string }).name !== "AbortError") settleSeat(project, cwd, null, true);
    })
    .finally(() => { poll.pending = false; });
}

function stopPoll(poll: SeatPoll): void {
  if (poll.timer !== null) clearInterval(poll.timer);
  poll.timer = null;
  poll.controller?.abort();
  poll.controller = null;
}

/** Subscribe to `project`'s seat, starting the key's poll if it is the first. */
function subscribeSeat(project: string, cwd: string | undefined, listener: (read: ScopedRead) => void): () => void {
  const key = readKey(project, cwd);
  let poll = polls.get(key);
  if (!poll) {
    poll = { listeners: new Set(), timer: null, controller: null, pending: false };
    polls.set(key, poll);
  }
  const started = poll;
  started.listeners.add(listener);
  if (started.timer === null) {
    started.controller = new AbortController();
    listenForSeatVisibility();
    started.timer = setInterval(() => {
      if (!documentHidden()) loadSeat(project, cwd, key);
    }, SEAT_POLL_MS);
  }
  /* Every arriving surface revalidates, as it always has — it paints the cached
     answer and asks for a fresh one. Surfaces arriving TOGETHER (the dock and
     the board in one commit) find the first read still in flight and share it,
     which is the doubling this guard exists for. */
  loadSeat(project, cwd, key);
  return () => {
    started.listeners.delete(listener);
    if (started.listeners.size > 0) return;
    stopPoll(started);
    if (polls.get(key) === started) polls.delete(key);
  };
}

export function resetOrchestratorSeatCacheForTests(): void {
  for (const poll of polls.values()) stopPoll(poll);
  polls.clear();
  answers.clear();
  seatConversations = null;
  seatConversationsListeners.clear();
  if (seatConversationsPoll) {
    clearInterval(seatConversationsPoll.timer);
    document.removeEventListener("visibilitychange", seatConversationsPoll.onVisibility);
    seatConversationsPoll.controller.abort();
    seatConversationsPoll = null;
  }
  seatConversationsPending = false;
}

export async function fetchOrchestratorSeat(project: string, cwd?: string, signal?: AbortSignal): Promise<OrchestratorSeatStatus> {
  const query = new URLSearchParams({ project });
  if (cwd) query.set("cwd", cwd);
  const response = await fetch("/api/orchestrator/seat?" + query, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`orchestrator seat read failed: ${response.status}`);
  return parseSeatStatus(await response.json());
}

const cachedSeat = (project: string | null, cwd: string | undefined): ScopedRead | null => (
  project ? answers.get(readKey(project, cwd)) ?? null : null
);

/**
 * The project's orchestrator seat, polled — and answered at once for a project
 * this tab already read (stale while it revalidates, #1149).
 *
 * The poll is per project and cwd, not per mount ({@link subscribeSeat}): every
 * surface reading the same seat at the same time shares one request per
 * interval, so opening the dock beside the board — or the phone's seat card
 * under its focus view — costs no extra reading of the route.
 *
 * `project` null (Overview, or the panel closed) reads nothing at all.
 */
export function useOrchestratorSeat(project: string | null, cwd?: string): OrchestratorSeatRead {
  const [read, setRead] = useState<ScopedRead | null>(() => cachedSeat(project, cwd));
  /* Every answer carries the project and cwd it answered for, so a scope switch
     invalidates the previous seat HERE, in render, with no effect and no frame
     in which another checkout's preflight appears under this draft. */
  const current = read && read.project === project && read.cwd === (cwd ?? "")
    ? read
    : cachedSeat(project, cwd);

  /* An operator action that MOVED the seat — a designation, a rotation — asks
     for the answer now rather than at the next tick, so it reads past the
     shared poll's in-flight guard: a read that left before the write cannot
     describe it. The answer is published to every surface reading this key. */
  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      settleSeat(project, cwd, await fetchOrchestratorSeat(project, cwd), false);
    } catch {
      settleSeat(project, cwd, null, true);
    }
  }, [cwd, project]);

  useEffect(() => {
    if (!project) return;
    return subscribeSeat(project, cwd, setRead);
  }, [cwd, project]);

  return { status: current?.status ?? null, failed: current?.failed ?? false, refresh };
}

/**
 * Every conversation ANY project's seat record names (#1841).
 *
 * A surface that spans projects and names none — the Overview's board, whose
 * cards come from every project at once — cannot ask the per-project read for
 * this, so it asks for the cross-project one. One slow status read on the same
 * cadence as the panel's; the record only moves when a seat is designated or
 * rotated.
 *
 * `enabled` false reads nothing at all. A failed attempt keeps the last good
 * answer, exactly as the per-project read does; until the first answer lands
 * the result is null, and a null answer hides nothing anywhere.
 */
export function useSeatConversations(enabled: boolean): SeatRefs | null {
  const [refs, setRefs] = useState<SeatRefs | null>(() => seatConversations);
  useEffect(() => {
    if (!enabled) return;
    return joinSeatConversationsPoll(setRefs);
  }, [enabled]);
  return refs;
}

/* The cross-project read is shared the way the per-project one is: the
   Overview's board and its first-run band (#2166) both read it, and a
   `setInterval` per mount would ask for the same document twice. The first
   mount starts the poll, later ones join it (each revalidating once), and it
   stops when the last one leaves. */
const seatConversationsListeners = new Set<(refs: SeatRefs | null) => void>();
let seatConversationsPoll: { timer: ReturnType<typeof setInterval>; controller: AbortController; onVisibility: () => void } | null = null;
let seatConversationsPending = false;

function loadSeatConversations(): void {
  const poll = seatConversationsPoll;
  if (!poll || seatConversationsPending) return;
  seatConversationsPending = true;
  void fetchSeatConversations(poll.controller.signal)
    .then((answer) => {
      seatConversations = answer;
      for (const listener of seatConversationsListeners) listener(answer);
    })
    .catch(() => {
      /* Keep the last good answer: a dropped poll is not evidence that the
         seats moved, and blanking it would flash every seat task back into
         the rows it was kept out of. */
    })
    .finally(() => { seatConversationsPending = false; });
}

function joinSeatConversationsPoll(listener: (refs: SeatRefs | null) => void): () => void {
  seatConversationsListeners.add(listener);
  if (!seatConversationsPoll) {
    const onVisibility = () => {
      if (!documentHidden()) loadSeatConversations();
    };
    seatConversationsPoll = {
      timer: setInterval(() => {
        if (!documentHidden()) loadSeatConversations();
      }, SEAT_POLL_MS),
      controller: new AbortController(),
      onVisibility,
    };
    document.addEventListener("visibilitychange", onVisibility);
  }
  loadSeatConversations();
  return () => {
    seatConversationsListeners.delete(listener);
    if (seatConversationsListeners.size || !seatConversationsPoll) return;
    clearInterval(seatConversationsPoll.timer);
    document.removeEventListener("visibilitychange", seatConversationsPoll.onVisibility);
    seatConversationsPoll.controller.abort();
    seatConversationsPoll = null;
    seatConversationsPending = false;
  };
}

export async function fetchSeatConversations(signal?: AbortSignal): Promise<SeatRefs | null> {
  const response = await fetch("/api/orchestrator/seat?scope=all", signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`orchestrator seat conversations read failed: ${response.status}`);
  return seatConversationsOf((await response.json() as { all?: unknown }).all);
}
