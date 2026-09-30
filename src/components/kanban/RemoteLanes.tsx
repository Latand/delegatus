"use client";

import { ArrowLeftRight } from "lucide-react";
import { useMemo } from "react";

import { useLocale } from "@/lib/i18n";
import { PipelineBlock } from "@/components/pipelines/PipelineBlock";
import type { PipelineBlockDensity } from "@/components/pipelines/pipelineBlockModel";
import { remoteLaneNote, remoteLaneSummary } from "@/components/pipelines/remoteLaneSummary";

import type { RemoteCard, RemoteLaneView } from "./remoteFeed";

/* A lane another machine runs, drawn by the one pipeline block in its
   `managedOn` mode: the chain and the state words as at home, no control, and
   one sentence of where to answer when it waits on a person
   (docs/design/synced-task-card.md §6). */

/** The board's own clock in ms and the card's title, which the lane shares. */
export function RemoteLane({ lane, host, title, density, nowMs }: { lane: RemoteLaneView; host: string; title: string; density: PipelineBlockDensity; nowMs: number }) {
  const { t, locale } = useLocale();
  const summary = useMemo(() => remoteLaneSummary(lane, title), [lane, title]);
  const managedOn = useMemo(() => remoteLaneNote(t, lane, host, lane.stale ? { asOf: lane.asOf, locale } : null), [t, locale, lane, host]);
  return <PipelineBlock summary={summary} density={density} nowMs={nowMs} taskTitle={title} managedOn={managedOn} />;
}

export function RemoteLanes({ remote, title, density = "task", nowMs }: { remote: RemoteCard; title: string; density?: PipelineBlockDensity; nowMs: number }) {
  return <>{remote.lanes.map((lane) => <RemoteLane key={lane.k} lane={lane} host={remote.host} title={title} density={density} nowMs={nowMs} />)}</>;
}

/** The text a remote card's chip, phone line and bottom pill carry. */
export function useManagedOnText(remote: RemoteCard): { label: string; hint: string } {
  const { t } = useLocale();
  return {
    label: t(remote.linked ? "kanban.remote.managedOn" : "kanban.remote.notLinked", { host: remote.host }),
    hint: t("kanban.remote.hint", { host: remote.host }),
  };
}

/** The passive chip that stands where "+ Agent" would start work here. */
export function HostChip({ remote }: { remote: RemoteCard }) {
  const { label, hint } = useManagedOnText(remote);
  return (
    <span className="host-chip" data-remote-host={remote.install} title={hint}>
      <ArrowLeftRight aria-hidden className="host-chip-icon" />
      <span className="host-chip-label">{label}</span>
    </span>
  );
}
