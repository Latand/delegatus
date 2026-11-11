"use client";

import { roleNameById } from "@/components/builderCopy";
import { fmtAgeSeconds } from "@/components/utils";
import { useLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n/core";
import type { TaskProgress } from "@/lib/tasks/types";

/*
 * The agent's estimate of how far a task is, as a short capsule between the
 * card's status dot and its words (docs/design/card-progress-estimate.md,
 * prototype variant 3). The card prints no number: the value, its age and who
 * reported it are the dot's popover and the bar's accessible value; the bar lies
 * inside the dot's hover target, so a mouse on either opens that popover. An
 * estimate nobody set draws nothing. While work on the task runs, the unfilled
 * part carries a soft sweep (CSS only; a still tint under reduced motion).
 */

/** A report older than a day fills with stripes and reads «Last agent estimate». */
export const PROGRESS_STALE_MS = 24 * 60 * 60 * 1000;

/** What the card hands its state line to draw the bar. */
export interface CardProgress {
  progress: TaskProgress;
  /** Work on the task runs now (a working conversation or a running stage). */
  running: boolean;
  /** The task's own colour, when it has one. */
  color: string | null;
}

const NBSP = " ";

/** «Agent estimate ≈65% · 12m ago · builder»: value, age, and who reported it. */
export function progressLine(t: TFunction, progress: TaskProgress, nowMs: number): string {
  const setAt = Date.parse(progress.setAt);
  const ageMs = Math.max(0, nowMs - setAt);
  /* The age never splits («12 хв» / «тому»), and each «·» stays with the word before it: a narrow bubble wraps after the «·», never opens a line with one. */
  const age = fmtAgeSeconds(ageMs / 1000).replace(/ /g, NBSP);
  const by = progress.by;
  const who = by.kind === "operator" ? t("cardState.progress.byOperator") : by.role ? roleNameById(t, by.role) : t("cardState.progress.byAgent");
  return t(ageMs > PROGRESS_STALE_MS ? "cardState.progress.lineStale" : "cardState.progress.line", { value: progress.value, age, who }).replace(/ · /g, `${NBSP}· `);
}

export function TaskProgressBar({ info, title, nowMs }: { info: CardProgress; title: string; nowMs: number }) {
  const { t } = useLocale();
  const { progress, running, color } = info;
  const line = progressLine(t, progress, nowMs);
  const stale = nowMs - Date.parse(progress.setAt) > PROGRESS_STALE_MS;
  return (
    <span
      className="task-progress"
      data-task-progress={stale ? "stale" : "fresh"}
      data-running={running ? "" : undefined}
      role="progressbar"
      aria-label={t("cardState.progress.aria", { title })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress.value}
      aria-valuetext={line}
      data-coloured={color ? "" : undefined}
      style={{ "--task-progress-value": `${progress.value}%`, ...(color ? { "--task-progress-colour": color } : {}) } as React.CSSProperties}
    >
      <span className="task-progress-fill" />
      {running && progress.value < 100 ? <span className="task-progress-glow" aria-hidden /> : null}
    </span>
  );
}
