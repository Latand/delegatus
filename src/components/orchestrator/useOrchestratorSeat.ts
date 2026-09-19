"use client";

import { useCallback, useEffect, useState } from "react";

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

export function resetOrchestratorSeatCacheForTests(): void {
  answers.clear();
  seatConversations = null;
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

  const settle = useCallback((target: string, targetCwd: string | undefined, status: OrchestratorSeatStatus | null, failed: boolean) => {
    const key = readKey(target, targetCwd);
    const next: ScopedRead = {
      project: target,
      cwd: targetCwd ?? "",
      /* A failed re-read keeps the last good answer for the SAME project; the
         cache is keyed by project and cwd, so it cannot resurrect another
         checkout's registration status. */
      status: status ?? answers.get(key)?.status ?? null,
      failed,
    };
    answers.set(key, next);
    setRead(next);
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      settle(project, cwd, await fetchOrchestratorSeat(project, cwd), false);
    } catch {
      settle(project, cwd, null, true);
    }
  }, [cwd, project, settle]);

  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    const load = () => {
      void fetchOrchestratorSeat(project, cwd, controller.signal)
        .then((status) => settle(project, cwd, status, false))
        .catch((cause: unknown) => {
          if ((cause as { name?: string }).name !== "AbortError") settle(project, cwd, null, true);
        });
    };
    load();
    const timer = setInterval(load, SEAT_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [cwd, project, settle]);

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
    const controller = new AbortController();
    const load = () => {
      void fetchSeatConversations(controller.signal)
        .then((answer) => {
          seatConversations = answer;
          setRefs(answer);
        })
        .catch(() => {
          /* Keep the last good answer: a dropped poll is not evidence that the
             seats moved, and blanking it would flash every seat task back into
             the rows it was kept out of. */
        });
    };
    load();
    const timer = setInterval(load, SEAT_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [enabled]);
  return refs;
}

export async function fetchSeatConversations(signal?: AbortSignal): Promise<SeatRefs | null> {
  const response = await fetch("/api/orchestrator/seat?scope=all", signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`orchestrator seat conversations read failed: ${response.status}`);
  return seatConversationsOf((await response.json() as { all?: unknown }).all);
}
