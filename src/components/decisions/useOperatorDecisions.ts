"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fireTasksChanged, TASKS_CHANGED_EVENT } from "@/components/tasks/taskApi";
import type { DecidePrototypeInput, OperatorDecisionView, OperatorDecisionsRead } from "@/lib/prototypeReview/types";

/** How often an open «Рішення» tab reads its project's decisions. */
export const DECISIONS_POLL_MS = 3000;

export function decisionsUrl(project: string, review?: string): string {
  return `/api/projects/decisions?project=${encodeURIComponent(project)}${review ? `&review=${encodeURIComponent(review)}` : ""}`;
}

export type DecisionAnswer = Omit<DecidePrototypeInput, "reviewId">;

/* What the operator chose and wrote, by round, from the press of «Відповісти»
   until the server keeps it. The form leaves the list while its answer is on
   the way; when the server refuses, the form that comes back starts from this
   draft, so a second press sends the same answer. */
const drafts = new Map<string, DecisionAnswer>();
export function decisionDraft(reviewId: string): DecisionAnswer | undefined {
  return drafts.get(reviewId);
}
/** Tests only: forget every held draft. */
export function resetDecisionDraftsForTests(): void {
  drafts.clear();
}

/**
 * A project's open decisions while the column shows them: read at once, then
 * every few seconds. An answer leaves the list the moment it is pressed and
 * comes back, with the server's reason and the operator's draft, only if the
 * server refused it (docs/design/operator-decision-forms.md §2.4).
 */
export function useOperatorDecisions(project: string, active: boolean, initial?: OperatorDecisionView[]) {
  const [state, setState] = useState<{ project: string; decisions: OperatorDecisionView[] | null; failed: boolean }>(
    () => ({ project, decisions: initial ?? null, failed: false }));
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<{ reviewId: string; message: string } | null>(null);
  const sequence = useRef(0);
  const current = state.project === project ? state : { project, decisions: null, failed: false };

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++sequence.current;
    try {
      const response = await fetch(decisionsUrl(project), { signal, cache: "no-store" });
      const body = await response.json() as OperatorDecisionsRead & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "decisions unavailable");
      if (seq === sequence.current && !signal?.aborted) setState({ project, decisions: body.decisions, failed: false });
    } catch {
      if (seq === sequence.current && !signal?.aborted) setState((held) => ({ project, decisions: held.project === project ? held.decisions : null, failed: true }));
    }
  }, [project]);

  useEffect(() => {
    if (!active || initial) return;
    const controller = new AbortController();
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the read sets state when its answer arrives */
    void refresh(controller.signal);
    const timer = setInterval(() => { void refresh(controller.signal); }, DECISIONS_POLL_MS);
    /* A decision taken elsewhere (the review window, another tab's column) leaves the list at once. */
    const changed = () => { void refresh(controller.signal); };
    window.addEventListener(TASKS_CHANGED_EVENT, changed);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener(TASKS_CHANGED_EVENT, changed); };
  }, [active, initial, refresh]);

  const answer = useCallback(async (reviewId: string, body: DecisionAnswer | { retry: true }): Promise<boolean> => {
    setError(null);
    if (!("retry" in body)) drafts.set(reviewId, body);
    setAnswering((held) => new Set([...held, reviewId]));
    ++sequence.current;
    try {
      const response = await fetch("/api/projects/decisions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, reviewId, ...body }),
      });
      const result = await response.json() as OperatorDecisionsRead & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "the answer could not be saved");
      ++sequence.current;
      drafts.delete(reviewId);
      setState({ project, decisions: result.decisions, failed: false });
      fireTasksChanged();
      return true;
    } catch (failure) {
      setError({ reviewId, message: failure instanceof Error ? failure.message : String(failure) });
      return false;
    } finally {
      setAnswering((held) => { const next = new Set(held); next.delete(reviewId); return next; });
    }
  }, [project]);

  const decisions = current.decisions?.filter((decision) => !answering.has(decision.id)) ?? null;
  return { decisions, loaded: current.decisions !== null, failed: current.failed && current.decisions === null, answer, error, refresh };
}
