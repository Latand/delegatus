"use client";

import { effortScale } from "@/lib/agent/efforts";
import type { FlowEngine } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import { PipelineEditor } from "@/components/pipelines/PipelineEditor";
import { openReviewHistory } from "@/components/flows/ReviewHistory";
import type { SchemeGroup } from "./layout";

export function resetRuntimeForEngine(
  next: FlowEngine,
  ctl: { setEngine: (e: FlowEngine) => void; setModel: (m: string) => void; setEffort: (e: string) => void; effort: string },
): void {
  ctl.setEngine(next);
  ctl.setModel("");
  if (ctl.effort && !effortScale(next, null)!.includes(ctl.effort)) ctl.setEffort("");
}

/** Pipeline edits keep their existing editor. Legacy halos open history. */
export function GroupOverridePanel({ group, onClose }: { group: SchemeGroup; onClose: () => void }) {
  const { t } = useLocale();
  if (group.pipeline) return <PipelineEditor pipeline={group.pipeline} label={group.label} onClose={onClose} />;
  return <div data-scheme-ui data-group-override={group.kind} className="flex w-[268px] flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-2">
    <p className="text-sm">{t("reviewHistory.retired")}</p>
    {group.flow ? <button className="min-h-11 text-sm text-accent" onClick={() => { openReviewHistory(group.flow!.id); onClose(); }}>{t("reviewHistory.open")}</button> : null}
    <button className="min-h-11 text-sm" onClick={onClose}>{t("common.close")}</button>
  </div>;
}
