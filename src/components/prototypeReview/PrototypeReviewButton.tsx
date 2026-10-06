"use client";

import { GalleryHorizontalEnd } from "lucide-react";

import { Check, ChevronRight } from "@/components/icons";
import { openPrototypeReview, usePrototypeReviewSummary } from "@/hooks/usePrototypeReview";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { PrototypeReviewSummary } from "@/lib/prototypeReview/types";
import type { BoardTask } from "@/lib/tasks/types";

import { prototypeButtonState, usePrototypeReviewsSeen, type PrototypeButtonState } from "./prototypeReviewStore";

/** The chosen variants as the card says them: their numbers, in order. */
function chosenNumbers(summary: PrototypeReviewSummary): string {
  return (summary.decision?.chosen ?? []).map((variant) => variant.number).join(", ");
}

function buttonAria(t: TFunction, state: PrototypeButtonState, summary: PrototypeReviewSummary, title: string): string {
  const chosen = (summary.decision?.chosen ?? []).map((variant) => `${variant.number} · ${variant.name}`).join(", ");
  return t(`proto.button.aria.${state}`, { title, review: summary.title, chosen });
}

function target(task: BoardTask, summary: PrototypeReviewSummary) {
  return { kind: "prototype-review" as const, taskId: task.id, reviewId: summary.waitingReviewId ?? summary.latestReviewId, from: "card" as const };
}

/** The review button in a desktop card's foot. Absent while the task has no
    review; highlighted while a round waits unopened; the chosen numbers once
    the latest round is decided. */
export function CardPrototypeButton({ task, title }: { task: BoardTask; title: string }) {
  const { t } = useLocale();
  const summary = usePrototypeReviewSummary(task);
  const seen = usePrototypeReviewsSeen();
  const state = prototypeButtonState(summary, seen);
  if (!summary || !state) return null;
  const label = buttonAria(t, state, summary, title);
  const waiting = state === "ready" || state === "opened";
  return (
    <button
      type="button"
      className="add proto"
      data-prototype-button={task.id}
      data-prototype-state={state}
      aria-label={label}
      title={label}
      onClick={() => openPrototypeReview(target(task, summary))}
    >
      <GalleryHorizontalEnd aria-hidden />
      {waiting ? (
        <>
          {state === "ready" ? <span className="proto-dot" aria-hidden="true" /> : null}
          <span className="proto-word">{t("proto.button.word")}</span>
        </>
      ) : (
        <span className="proto-chosen num">
          {state === "unsent" ? <span className="proto-dot warn" aria-hidden="true" /> : <Check aria-hidden />}
          {chosenNumbers(summary)}
        </span>
      )}
    </button>
  );
}

/** The same entry on the phone's task screen, as one of its rows. */
export function PhonePrototypeRow({ task, title, rowClass }: { task: BoardTask; title: string; rowClass: string }) {
  const { t } = useLocale();
  const summary = usePrototypeReviewSummary(task);
  const seen = usePrototypeReviewsSeen();
  const state = prototypeButtonState(summary, seen);
  if (!summary || !state) return null;
  const waiting = state === "ready" || state === "opened";
  return (
    <button
      type="button"
      data-phone-task-prototype={task.id}
      data-prototype-state={state}
      aria-label={buttonAria(t, state, summary, title)}
      className={`${rowClass} ${state === "ready" ? "bg-accent-soft" : ""}`}
      onClick={() => openPrototypeReview(target(task, summary))}
    >
      <GalleryHorizontalEnd className={`h-4 w-4 shrink-0 ${waiting ? "text-accent" : "text-muted"}`} aria-hidden />
      <span className="flex min-w-0 flex-1 items-baseline gap-[5px] text-body">
        <span className={`shrink-0 font-semibold ${state === "ready" ? "text-accent" : "text-primary"}`}>{t("proto.button.word")}</span>
        <span aria-hidden className="shrink-0 opacity-60">·</span>
        <span className="min-w-0 truncate text-secondary">{summary.title}</span>
      </span>
      <span className={`inline-flex shrink-0 items-center gap-1 text-label font-semibold tabular-nums ${state === "ready" ? "text-accent" : state === "unsent" ? "text-warning" : "text-muted"}`}>
        {state === "ready" ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        {waiting ? t(`proto.row.${state}`) : t(state === "unsent" ? "proto.row.unsent" : "proto.row.decided", { chosen: chosenNumbers(summary) })}
      </span>
      <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
    </button>
  );
}
