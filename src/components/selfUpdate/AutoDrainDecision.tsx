"use client";

import { useState } from "react";
import { useLocale } from "@/lib/i18n";
import type { AutoView } from "@/lib/selfUpdate/auto";
import type { Snapshot } from "@/lib/selfUpdate/types";

/** The same operator decision in the update dialog and both Needs-you lists. */
export function AutoDrainDecision({ decision }: { decision: NonNullable<AutoView["decision"]> }) {
  const { t } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (choice: "deploy-now" | "keep-waiting") => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/self-update/auto", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionId: decision.id, choice }) });
      if (!response.ok) throw new Error(String(response.status));
      const snapshot = await response.json() as Snapshot;
      window.dispatchEvent(new window.CustomEvent("llv:auto-drain-decision", { detail: snapshot }));
    } catch {
      setError(t("selfUpdate.auto.decision.failed"));
    } finally { setPending(false); }
  };
  const blockers = decision.blockers;
  return <div data-needs-you-kind="update" data-auto-drain-decision={decision.id} className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-warning p-3 text-ui [overflow-wrap:anywhere]">
    <p className="m-0 font-semibold text-primary">{t("selfUpdate.auto.decision.title")}</p>
    <p className="m-0 text-secondary">{t("selfUpdate.auto.drain.overran")}</p>
    <ul className="m-0 list-disc pl-5 text-secondary">
      {(blockers?.stageList ?? []).map((stage) => <li key={`${stage.pipelineId}:${stage.stageId}`}>{stage.stageId} · {stage.task}</li>)}
      {(blockers?.turnList ?? []).map((turn) => <li key={turn.conversationId}>{turn.engine} · {turn.project ? `${turn.project} · ` : ""}{turn.conversationId}</li>)}
      {blockers?.unreadable ? <li>{blockers.unreadable}</li> : null}
    </ul>
    <div className="flex flex-wrap gap-2">
      <button type="button" data-action="deploy-now" disabled={pending} onClick={() => void choose("deploy-now")} className="min-h-11 rounded-[8px] bg-warning px-3 py-2 font-semibold text-canvas disabled:opacity-50">{t("selfUpdate.auto.decision.deployNow")}</button>
      <button type="button" data-action="keep-waiting" disabled={pending} onClick={() => void choose("keep-waiting")} className="min-h-11 rounded-[8px] border border-border px-3 py-2 font-semibold text-primary disabled:opacity-50">{t("selfUpdate.auto.decision.keepWaiting")}</button>
    </div>
    {error ? <p role="alert" className="m-0 text-danger">{error}</p> : null}
  </div>;
}
