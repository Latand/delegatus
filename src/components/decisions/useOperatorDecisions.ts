"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { forgetDecisionDraft, reconcileSeatDrafts } from "@/components/prototypeReview/decisionDrafts";
import { fireTasksChanged, TASKS_CHANGED_EVENT } from "@/components/tasks/taskApi";
import type { DecidePrototypeInput, OperatorDecisionView, OperatorDecisionsRead } from "@/lib/prototypeReview/types";

/** How often an open «Рішення» tab reads its project's decisions. */
export const DECISIONS_POLL_MS = 3000;

export function decisionsUrl(project: string, review?: string): string {
  return `/api/projects/decisions?project=${encodeURIComponent(project)}${review ? `&review=${encodeURIComponent(review)}` : ""}`;
}

export type DecisionAnswer = Omit<DecidePrototypeInput, "reviewId">;

/**
 * A project's open decisions while the column shows them: read at once, then
 * every few seconds. An answer leaves the list the moment it is pressed and
 * comes back, with the server's reason and the operator's stored draft, only if the
 * server refused it (docs/design/operator-decision-forms.md §2.4).
 *
 * A record already decided stays where it is: Retry draws its message as on
 * its way and Revoke draws the access as refused, both at once, and a refusal
 * puts the record back as it was beside the reason (audit B13).
 */
export function useOperatorDecisions(project: string, active: boolean, initial?: OperatorDecisionView[]) {
  const [state, setState] = useState<{ project: string; decisions: OperatorDecisionView[] | null; failed: boolean }>(
    () => ({ project, decisions: initial ?? null, failed: false }));
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set());
  /* Decided records whose Retry or Revoke is on its way, drawn as it will leave them. */
  const [predicted, setPredicted] = useState<ReadonlyMap<string, OperatorDecisionView>>(() => new Map());
  const inflight = useRef(new Set<string>());
  const [error, setError] = useState<{ reviewId: string; message: string; kind?: "retry" | "revoke" } | null>(null);
  const sequence = useRef(0);
  const current = state.project === project ? state : { project, decisions: null, failed: false };

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++sequence.current;
    try {
      const response = await fetch(decisionsUrl(project), { signal, cache: "no-store" });
      const body = await response.json() as OperatorDecisionsRead & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "decisions unavailable");
      if (seq === sequence.current && !signal?.aborted) {
        setState({ project, decisions: body.decisions, failed: false });
        reconcileSeatDrafts(body.project, body.decisions);
      }
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

  const answer = useCallback(async (reviewId: string, body: DecisionAnswer | { retry: true }, record?: OperatorDecisionView): Promise<boolean> => {
    if (inflight.current.has(reviewId)) return false;
    inflight.current.add(reviewId);
    setError(null);
    const decided = record?.decision ? recordAfter(record, body) : null;
    if (decided) setPredicted((held) => new Map(held).set(reviewId, decided));
    else setAnswering((held) => new Set([...held, reviewId]));
    ++sequence.current;
    try {
      const response = await fetch("/api/projects/decisions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, reviewId, ...body }),
      });
      const result = await response.json() as OperatorDecisionsRead & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "the answer could not be saved");
      ++sequence.current;
      /* Saved: the draft the form kept as the operator typed goes. A refusal leaves it for the form that comes back. */
      if (!("retry" in body) && !decided) forgetDecisionDraft(reviewId);
      setState({ project, decisions: result.decisions, failed: false });
      fireTasksChanged();
      return true;
    } catch (failure) {
      setError({ reviewId, message: failure instanceof Error ? failure.message : String(failure), ...(decided ? { kind: "retry" in body ? "retry" as const : "revoke" as const } : {}) });
      return false;
    } finally {
      inflight.current.delete(reviewId);
      setAnswering((held) => { if (!held.has(reviewId)) return held; const next = new Set(held); next.delete(reviewId); return next; });
      setPredicted((held) => { if (!held.has(reviewId)) return held; const next = new Map(held); next.delete(reviewId); return next; });
    }
  }, [project]);

  const decisions = current.decisions?.filter((decision) => !answering.has(decision.id)).map((decision) => predicted.get(decision.id) ?? decision) ?? null;
  return { decisions, loaded: current.decisions !== null, failed: current.failed && current.decisions === null, answer, error, refresh };
}

/** A decided record as its Retry (the message on its way) or its Revoke (the access refused) leaves it. */
export function recordAfter(record: OperatorDecisionView, body: DecisionAnswer | { retry: true }): OperatorDecisionView | null {
  const made = record.decision;
  if (!made) return null;
  if ("retry" in body) return { ...record, decision: { ...made, delivery: { state: "pending", retryable: false } } };
  if (record.nativeAssociationState === "approved") return { ...record, nativeAssociationState: "refused" };
  return null;
}
