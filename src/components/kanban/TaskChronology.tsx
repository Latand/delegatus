"use client";

import { useState } from "react";

import { clockText, dateTimeText } from "@/components/activity/format";
import { clearedByText } from "@/components/attention/decision";
import { mergeReasonText } from "@/components/pipelines/pipelineBlockModel";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

import { laneStopWhy } from "./cardState";
import type { LaneAnswerItem } from "./laneAnswerMenu";
import { MoreGlyph } from "./kanbanGlyphs";
import { pastAttemptLabel, pastAttemptState, pipelineTitle, stageNames } from "./PipelineSection";
import type { PastAttempt } from "./pipelineGraph";
import { foldChronology, type ChronologyEntry } from "./taskChronologyModel";

/*
 * The expanded card's timeline (docs/design/calm-task-cards-build.md §3.3):
 * the task's events oldest first, the latest eight shown and the rest behind
 * «Earlier · N». An attempt or round with a kept conversation opens it; the
 * lane's stop carries the manual answers (Skip / Retry as quiet links where
 * the orchestrator owns the lane, else its ⋯) and the record's own words
 * under «Details». There is no «now» entry: the state line above says it.
 */

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const TONE: Partial<Record<ChronologyEntry["kind"], "ok" | "bad" | "warn">> = {
  "attempt-passed": "ok",
  "merge-merged": "ok",
  "attempt-failed": "bad",
  "attempt-cut": "warn",
  "attempt-lost": "warn",
  "attempt-stopped": "warn",
  "merge-stopped": "warn",
};

/** The name a stage goes by in an entry: its attempt label from the past row, else its name. */
function stageLabel(t: TFunction, entry: ChronologyEntry, pipeline: Pipeline | undefined): string {
  const name = (entry.stageId && pipeline ? stageNames(t, pipeline).get(entry.stageId) : null) ?? entry.stageId ?? "";
  return entry.past ? pastAttemptLabel(t, entry.past, name) : name;
}

const prText = (pr: number | null | undefined): string => (pr ? `PR #${pr}` : "PR");

/** One entry in the operator's words. */
export function chronologyEntryText(t: TFunction, entry: ChronologyEntry, pipeline: Pipeline | undefined): string {
  const stage = stageLabel(t, entry, pipeline);
  const who = entry.by ? clearedByText(t, entry.by) : t(`chronology.who.${entry.actor ?? "agent"}`);
  switch (entry.kind) {
    case "task-created":
      return t("chronology.taskCreated");
    case "lane-started":
      return t("chronology.laneStarted", { title: pipeline ? pipelineTitle(t, pipeline) : entry.pipelineId ?? "" });
    case "attempt-passed":
      return t("chronology.attemptPassed", { stage });
    case "attempt-skipped":
      return t("chronology.attemptSkipped", { stage });
    case "attempt-failed":
      return entry.count ? t("chronology.attemptFindings", { stage, count: entry.count }) : t("chronology.attemptFailed", { stage });
    case "attempt-cut":
      return (entry.count ?? 1) > 1 ? t("chronology.attemptCutN", { stage, count: entry.count! }) : t("chronology.attemptCut", { stage });
    case "attempt-lost":
      return t("chronology.attemptLost", { stage });
    case "attempt-running":
      return t("chronology.attemptRunning", { stage });
    case "attempt-stopped": {
      const why = pipeline && entry.stopKind ? laneStopWhy(t, pipeline, { kind: entry.stopKind, stageId: entry.stageId }, true) : t("cardState.whyShort.other");
      return stage ? t("chronology.attemptStopped", { stage, why }) : t("chronology.laneStopped", { why });
    }
    case "round":
      return t("chronology.round", { stage: stageLabel(t, { ...entry, past: undefined }, pipeline), n: entry.past?.n ?? 0, verdict: entry.past ? pastAttemptState(t, entry.past as PastAttempt) : "" });
    case "decision-answered":
      return t("chronology.decisionAnswered", { stage, who });
    case "lane-paused":
      return t("chronology.lanePaused");
    case "lane-resumed":
      return t("chronology.laneResumed");
    case "lane-cleared":
    case "need-cleared":
      return t("chronology.cleared", { who });
    case "merge-queued":
      return t("chronology.mergeQueued", { pr: prText(entry.prNumber) });
    case "merge-updated":
      return t("chronology.mergeUpdated", { pr: prText(entry.prNumber) });
    case "merge-stopped":
      return t("chronology.mergeStopped", { reason: mergeReasonText(t, entry.mergeReason ?? null) });
    case "merge-merged":
      return t("chronology.mergeMerged", { pr: prText(entry.prNumber), by: t(entry.mergedBy === "outside" ? "chronology.mergedOutside" : "chronology.mergedByDelegatus") });
    case "lane-closed":
      return t("chronology.laneClosed");
  }
}

export function TaskChronology({ entries, pipelines, nowMs, onOpen, onStopMenu, stopLinks, onStopLink, linksBusy, phone = false }: {
  entries: readonly ChronologyEntry[];
  pipelines: readonly Pipeline[];
  nowMs: number;
  /** Opens an attempt's or a round's kept conversation. */
  onOpen: (conversation: PastAttempt["conversation"]) => void;
  /** The stop entry's ⋯: the lane's menu on the desktop, its sheet on the phone. */
  onStopMenu?: (pipelineId: string, anchor: HTMLElement) => void;
  /** The links a seat-handled lane's stop carries; the stop has no ⋯ while it has them. */
  stopLinks?: (pipelineId: string) => readonly LaneAnswerItem[];
  onStopLink?: (pipelineId: string, answer: LaneAnswerItem) => void;
  /** A lane's action is in flight: its links wait. */
  linksBusy?: (pipelineId: string) => boolean;
  phone?: boolean;
}) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const byId = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
  const { hidden, shown } = foldChronology(entries, open);
  const zone = browserZone();
  const today = new Date(nowMs).toDateString();
  const when = (atMs: number) => (new Date(atMs).toDateString() === today ? clockText(atMs, locale, zone) : dateTimeText(atMs, locale, zone));
  return (
    <section className={`chronology${phone ? " phone" : ""}`} data-chronology={entries.length} data-chronology-hidden={hidden} aria-label={t("chronology.heading")}>
      <h4 className="chronology-head">{t("chronology.heading")}</h4>
      <ol>
        {hidden ? (
          <li className="chronology-earlier">
            <button type="button" data-chronology-earlier={hidden} aria-expanded={false} onClick={() => setOpen(true)}>
              {t("chronology.earlier", { count: hidden })}
            </button>
          </li>
        ) : null}
        {shown.map((entry) => {
          const pipeline = entry.pipelineId ? byId.get(entry.pipelineId) : undefined;
          const text = chronologyEntryText(t, entry, pipeline);
          const conversation = entry.conversation;
          const links = entry.stop && entry.pipelineId && onStopLink ? stopLinks?.(entry.pipelineId) ?? [] : [];
          return (
            <li
              key={entry.key}
              className={`chronology-entry${TONE[entry.kind] ? ` tone-${TONE[entry.kind]}` : ""}`}
              data-chronology-entry={entry.key}
              data-chronology-kind={entry.kind}
              data-chronology-stop={entry.stop ? entry.pipelineId ?? "" : undefined}
            >
              <time className="chronology-time num" dateTime={new Date(entry.atMs).toISOString()}>{when(entry.atMs)}</time>
              <span className="chronology-mark" aria-hidden />
              <span className="chronology-what">
                {conversation ? (
                  <button type="button" className="chronology-open" aria-label={t("chronology.openAria", { label: text })} onClick={() => onOpen(conversation)}>{text}</button>
                ) : <span>{text}</span>}
                {entry.detail ? (
                  <details className="chronology-detail" data-chronology-detail="">
                    <summary>{t("chronology.details")}</summary>
                    <p>{entry.detail}</p>
                  </details>
                ) : null}
                {links.length ? (
                  <span className="chronology-acts" data-chronology-acts={entry.pipelineId}>
                    {links.map((link) => (
                      <button
                        key={link.action}
                        type="button"
                        className="chronology-link"
                        data-chronology-link={link.action}
                        disabled={linksBusy?.(entry.pipelineId!) ?? false}
                        onClick={() => onStopLink!(entry.pipelineId!, link)}
                      >
                        {link.label}
                      </button>
                    ))}
                  </span>
                ) : null}
              </span>
              {entry.stop && entry.pipelineId && onStopMenu && !links.length ? (
                <button
                  type="button"
                  className="icon-btn chronology-menu"
                  data-chronology-stop-menu={entry.pipelineId}
                  aria-haspopup="menu"
                  aria-label={t("chronology.stopMenu", { stage: stageLabel(t, entry, pipeline) || (pipeline ? pipelineTitle(t, pipeline) : "") })}
                  onClick={(event) => onStopMenu(entry.pipelineId!, event.currentTarget)}
                >
                  <MoreGlyph />
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
