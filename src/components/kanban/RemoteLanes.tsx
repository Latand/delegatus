"use client";

import { ArrowLeftRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { useNowSeconds } from "@/hooks/useNowSeconds";
import { relativeTime } from "@/components/team/ui";
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
type SyncState = "synced" | "stale" | "failing" | "waiting";
const SYNC_TONE: Record<SyncState, string> = { synced: "success", stale: "warning", failing: "danger", waiting: "muted" };

export function useManagedOnText(remote: RemoteCard): { label: ReactNode; hint: string; state?: SyncState; colour?: string } {
  const { t, locale } = useLocale();
  const now = useNowSeconds() * 1000;
  const managed = t(remote.linked ? "kanban.remote.managedOn" : "kanban.remote.notLinked", { host: remote.host });
  const hint = t("kanban.remote.hint", { host: remote.host });
  // Older feeds have no health metadata; keep their existing ownership cue.
  if (!remote.linked || remote.state === undefined) return { label: managed, hint };
  const state: SyncState = remote.state === "failing" ? "failing" : !remote.lastCall ? "waiting"
    : now - remote.lastCall > 900_000 ? "stale" : "synced";
  const ago = remote.lastCall ? relativeTime(new Date(remote.lastCall).toISOString(), locale, now) : "";
  const colour = `var(--color-${SYNC_TONE[state]})`;
  const text = t(`kanban.remote.sync.${state}`, { host: remote.host, ago });
  const longAgo = remote.lastCall ? relativeTime(new Date(remote.lastCall).toISOString(), locale, now, "long") : "";
  const health = state === "failing" ? t(remote.lastCall ? "links.syncFailing" : "links.syncFailingNever", { ago: longAgo })
    : state === "waiting" ? t("links.syncWaiting") : t(state === "stale" ? "links.syncStale" : "links.syncedAgo", { ago: longAgo });
  return {
    // The phone's existing ownership line consumes this same label, including
    // its tone, without a separate health component or another feed read.
    label: <span data-remote-sync={state} style={{ color: colour }}>{text}</span>,
    hint: `${managed} · ${health} · ${hint}`,
    state, colour,
  };
}

/** The passive chip that stands where "+ Agent" would start work here. */
export function HostChip({ remote }: { remote: RemoteCard }) {
  const { label, hint, state, colour } = useManagedOnText(remote);
  return (
    <span className="host-chip" data-remote-host={remote.install} data-remote-sync={state} style={{ color: colour }} title={hint}>
      <ArrowLeftRight aria-hidden className="host-chip-icon" />
      <span className="host-chip-label">{label}</span>
    </span>
  );
}
