"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fireTasksChanged } from "@/components/tasks/taskApi";
import { layerPrototypeDismissal, sendDismissal } from "@/components/attention/dismissalOverlay";
import { prototypeReviewNotices, prototypeReviewSummary } from "@/lib/prototypeReview/model";
import type { DecidePrototypeInput, PrototypeReviewNotice, PrototypeReviewRead } from "@/lib/prototypeReview/types";
import type { BoardTask } from "@/lib/tasks/types";

export const OPEN_PROTOTYPE_REVIEW_EVENT = "llv:open-prototype-review";
/** `from` says who asked: a notice takes the operator to the task first, a
    card's own button opens the review where the operator already is. */
export type PrototypeReviewTarget = PrototypeReviewNotice["target"] & { from?: "card" | "notice" };
/** The notice and card use the same task/round navigation contract. */
export function openPrototypeReview(target: PrototypeReviewTarget): void {
  window.dispatchEvent(new CustomEvent<PrototypeReviewTarget>(OPEN_PROTOTYPE_REVIEW_EVENT,{ detail: target }));
}
export function usePrototypeReviewJump(onOpen: (target: PrototypeReviewTarget) => void): void {
  useEffect(() => {
    const listener = (event: Event) => onOpen((event as CustomEvent<PrototypeReviewTarget>).detail);
    window.addEventListener(OPEN_PROTOTYPE_REVIEW_EVENT,listener);
    return () => window.removeEventListener(OPEN_PROTOTYPE_REVIEW_EVENT,listener);
  },[onOpen]);
}
/** Card state without a request per card. Uses the board's existing task poll. */
export function usePrototypeReviewSummary(task: BoardTask | null) {
  return useMemo(() => task?.prototypeReview ?? prototypeReviewSummary(task?.prototypeReviews ?? []),[task]);
}
/** Orchestrator notices and the same waiting set counted by the kanban model. */
export function usePrototypeReviewNotices(tasks: readonly BoardTask[],project?: string) {
  return useMemo(() => {
    const notices = prototypeReviewNotices(tasks).filter(notice => !project || notice.project === project);
    return { notices, needsYouCount: notices.length };
  },[tasks,project]);
}
export function usePrototypeReview(taskId: string | null,enabled = true) {
  const [snapshot,setSnapshot] = useState<{ taskId: string | null; data: PrototypeReviewRead | null; error: string | null; saving: boolean }>({ taskId, data: null, error: null, saving: false });
  const { data,error,saving } = snapshot.taskId === taskId ? snapshot : { data: null, error: null, saving: false };
  const active = useRef(taskId);
  const sequence = useRef(0);
  const writing = useRef<string | null>(null);
  useEffect(() => { active.current = taskId; },[taskId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!taskId || writing.current === taskId) return;
    const seq = ++sequence.current;
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/prototypes`,{ signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Prototype review could not be read");
      if (active.current === taskId && sequence.current === seq && !signal?.aborted) setSnapshot({ taskId,data: body,error: null,saving: false });
    } catch (error) {
      if (active.current === taskId && sequence.current === seq && !signal?.aborted) setSnapshot(previous => ({ taskId,data: previous.taskId === taskId ? previous.data : null,saving: false,error: error instanceof Error ? error.message : "Prototype review could not be read" }));
    }
  },[taskId]);
  useEffect(() => {
    if (!taskId || !enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => { void refresh(controller.signal); },2000);
    return () => { controller.abort(); clearInterval(timer); };
  },[taskId,enabled,refresh]);
  const write = useCallback(async (body: DecidePrototypeInput | { reviewId: string; retry: true }): Promise<boolean> => {
    if (!taskId) return false;
    writing.current = taskId;
    setSnapshot(previous => ({ taskId,data: previous.taskId === taskId ? previous.data : null,error: null,saving: true }));
    ++sequence.current;
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/prototypes`,{
        method: "POST", headers: { "content-type": "application/json" },body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Prototype decision could not be saved");
      if (active.current === taskId) { ++sequence.current; setSnapshot({ taskId,data: result,error: null,saving: false }); }
      fireTasksChanged(); return true;
    } catch (error) {
      if (active.current === taskId) setSnapshot(previous => ({ ...previous,error: error instanceof Error ? error.message : "Prototype decision could not be saved",saving: false }));
      return false;
    } finally { if (writing.current === taskId) writing.current = null; }
  },[taskId]);
  const retry = useCallback((reviewId: string) => write({ reviewId,retry: true }),[write]);
  const save = useCallback((decision: DecidePrototypeInput) => write(decision),[write]);
  const hide = useCallback(async (reviewId: string, undo: boolean, surface: "desktop" | "phone") => {
    if (!taskId || writing.current === taskId) return false;
    writing.current = taskId;
    ++sequence.current;
    const mark = { at: new Date().toISOString(), by: { kind: "operator" as const, surface } };
    layerPrototypeDismissal(taskId, reviewId, undo ? null : mark);
    setSnapshot(previous => ({ ...previous, saving: true, error: null }));
    const result = await sendDismissal({ kind: "prototype", taskId, reviewId }, [], { undo, surface });
    if (result.ok && !result.outcome.dismissed.some(subject => subject.kind === "prototype" && subject.reviewId === reviewId)) {
      layerPrototypeDismissal(taskId, reviewId, undefined);
      if (writing.current === taskId) writing.current = null;
      fireTasksChanged();
      await refresh();
      return true;
    }
    if (result.ok) {
      const hidden = undo ? undefined : { at: result.outcome.at, by: result.outcome.by };
      layerPrototypeDismissal(taskId, reviewId, hidden ?? null);
      if (active.current === taskId) setSnapshot(previous => ({ ...previous, saving: false,
        data: previous.data ? { ...previous.data, waitingReviewId: undo && previous.data.summary?.waitingReviewId === reviewId ? reviewId : previous.data.waitingReviewId === reviewId ? null : previous.data.waitingReviewId,
          rounds: previous.data.rounds.map(round => round.id === reviewId ? { ...round, hidden } : round) } : null }));
      fireTasksChanged();
    } else {
      layerPrototypeDismissal(taskId, reviewId, undefined);
      if (active.current === taskId) setSnapshot(previous => ({ ...previous, saving: false, error: result.error }));
    }
    if (writing.current === taskId) writing.current = null;
    return result.ok;
  }, [taskId, refresh]);
  return { data,error,saving,loading: enabled && !!taskId && data === null && error === null,refresh,save,retry,hide };
}
