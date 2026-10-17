"use client";

import { useState, useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n";
import type { AutoView } from "@/lib/selfUpdate/auto";
import type { Snapshot } from "@/lib/selfUpdate/types";

import { blockerRows, useBlockerNames } from "./blockerNames";
import { DRAIN_DECISION_EVENT, selfUpdateTicket, type DrainDecisionAnswer } from "./useSelfUpdateFeed";

/* «Keep waiting» leaves every list at once (audit B15): the decision is held
   here while its answer is on the way, so the Needs-you queue, its count and
   the dialog all drop it in the same frame. A refusal brings it back with the
   reason, which outlives the row's own unmount. Deploy now still waits: it
   starts the release switch. */
let leaving: ReadonlySet<string> = new Set();
const refusals = new Map<string, string>();
const listeners = new Set<() => void>();
const publish = (next: ReadonlySet<string>) => {
  leaving = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const EMPTY: ReadonlySet<string> = new Set();

/** Update decisions whose «Keep waiting» is on its way: no list shows them. */
export function useDrainDecisionsLeaving(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => leaving, () => EMPTY);
}

/** Tests only. */
export function resetDrainDecisionsForTests(): void {
  refusals.clear();
  publish(new Set());
}

/** The same operator decision in the update dialog and both Needs-you lists. */
export function AutoDrainDecision({ decision }: { decision: NonNullable<AutoView["decision"]> }) {
  const { t } = useLocale();
  const names = useBlockerNames();
  const away = useDrainDecisionsLeaving().has(decision.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => refusals.get(decision.id) ?? null);
  const choose = async (choice: "deploy-now" | "keep-waiting") => {
    if (pending || leaving.has(decision.id)) return;
    const optimistic = choice === "keep-waiting";
    refusals.delete(decision.id);
    if (optimistic) publish(new Set([...leaving, decision.id]));
    else setPending(true);
    setError(null);
    let refusal: string | null = null;
    // Its place among the feed's snapshots is taken now, before the answer.
    const ticket = selfUpdateTicket();
    const accept = (snapshot: Snapshot) => window.dispatchEvent(new window.CustomEvent<DrainDecisionAnswer>(DRAIN_DECISION_EVENT, { detail: { snapshot, ticket } }));
    try {
      const response = await fetch("/api/self-update/auto", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionId: decision.id, choice }) });
      if (response.status === 409) {
        // Answered elsewhere or overtaken: the refusal carries what is true now.
        const body = await response.json().catch(() => null) as { snapshot?: Snapshot } | null;
        refusal = t("selfUpdate.auto.decision.superseded");
        if (body?.snapshot?.meta) accept(body.snapshot);
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      accept(await response.json() as Snapshot);
    } catch {
      refusal = t("selfUpdate.auto.decision.failed");
    } finally {
      if (refusal) {
        refusals.set(decision.id, refusal);
        setError(refusal);
      }
      if (optimistic) {
        const next = new Set(leaving);
        next.delete(decision.id);
        publish(next);
      } else setPending(false);
    }
  };
  if (away) return null;
  const blockers = decision.blockers;
  return <div data-needs-you-kind="update" data-auto-drain-decision={decision.id} className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-warning p-3 text-ui [overflow-wrap:anywhere]">
    <p className="m-0 font-semibold text-primary">{t("selfUpdate.auto.decision.title")}</p>
    <p className="m-0 text-secondary">{t("selfUpdate.auto.decision.body")}</p>
    <ul className="m-0 list-disc pl-5 text-secondary">
      {blockerRows(blockers, names, t).map((row) => <li key={row.key}>{row.text}</li>)}
      {blockers?.unreadable ? <li>{t("selfUpdate.auto.block.unreadable", { detail: blockers.unreadable })}</li> : null}
    </ul>
    <div className="flex flex-wrap gap-2">
      <button type="button" data-action="deploy-now" disabled={pending} onClick={() => void choose("deploy-now")} className="min-h-11 rounded-[8px] bg-warning px-3 py-2 font-semibold text-canvas disabled:opacity-50">{t("selfUpdate.auto.decision.deployNow")}</button>
      <button type="button" data-action="keep-waiting" disabled={pending} onClick={() => void choose("keep-waiting")} className="min-h-11 rounded-[8px] border border-border px-3 py-2 font-semibold text-primary disabled:opacity-50">{t("selfUpdate.auto.decision.keepWaiting")}</button>
    </div>
    {error ? <p role="alert" className="m-0 text-danger">{error}</p> : null}
  </div>;
}
