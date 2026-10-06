"use client";

import { GalleryHorizontalEnd } from "lucide-react";
import { useState } from "react";

import { ArrowRight } from "@/components/icons";
import { openPrototypeReview } from "@/hooks/usePrototypeReview";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

import { usePrototypeNoticesFor } from "./prototypeReviewStore";

/**
 * The orchestrator pane's word that a prototype waits, above its message
 * field where the task chips stand: one line per waiting task, with the action
 * that takes the operator to that task and opens its review. Absent while
 * nothing waits, so the composer keeps the layout it had. Two lines at most
 * stand there, one on the phone; the rest fold behind one count, so many
 * waiting tasks never push the message field away.
 */

export function PrototypeNoticeRow({ project }: { project: string }) {
  const { t } = useLocale();
  const notices = usePrototypeNoticesFor(project);
  const [all, setAll] = useState(false);
  const SHOWN = useIsMobile() ? 1 : 2;
  if (!notices.length) return null;
  const rows = all ? notices : notices.slice(0, SHOWN);
  const folded = notices.length - rows.length;
  return (
    <ul role="list" aria-label={t("proto.notice.list")} data-prototype-notices={notices.length} className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((notice) => (
        <li
          key={notice.id}
          role="status"
          data-prototype-notice={notice.taskId}
          className="flex min-w-0 items-center gap-1.5 rounded-control border border-accent/30 bg-accent-soft py-0.5 pl-2 pr-0.5 text-label text-accent"
        >
          <GalleryHorizontalEnd className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-semibold">{t("proto.notice.ready")}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-primary" title={notice.title}>{notice.title}</span>
          <button
            type="button"
            data-prototype-notice-open={notice.taskId}
            aria-label={t("proto.notice.openAria", { title: notice.title })}
            className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-control px-2 font-semibold text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11"
            onClick={() => openPrototypeReview({ ...notice.target, from: "notice" })}
          >
            {t("proto.notice.open")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </li>
      ))}
      {folded > 0 || (all && notices.length > SHOWN) ? (
        <li className="flex">
          <button
            type="button"
            data-prototype-notice-more={folded}
            aria-expanded={all}
            className="inline-flex min-h-6 items-center rounded-control px-2 text-label font-semibold text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11"
            onClick={() => setAll((held) => !held)}
          >
            {all ? t("proto.notice.fewer") : t("proto.notice.more", { count: folded })}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** The same word where the composer and its lines are put away: one chip
    with the count, opening the first waiting review. The folded seat's strip
    draws it with its words; the phone board's seat card, which has a few
    dozen pixels to spare, draws the mark and the count in a full touch
    target. Absent while nothing waits. */
export function PrototypeNoticeChip({ project, compact = false }: { project: string; compact?: boolean }) {
  const { t } = useLocale();
  const notices = usePrototypeNoticesFor(project);
  const first = notices[0];
  if (!first) return null;
  const open = () => openPrototypeReview({ ...first.target, from: "notice" });
  const label = `${t("proto.notice.ready")}: ${first.title}. ${t("proto.notice.open")}`;
  if (compact) {
    return (
      <button
        type="button"
        data-prototype-notice-chip={notices.length}
        aria-label={label}
        className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[8px] active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={open}
      >
        <span className="inline-flex h-8 items-center gap-1 rounded-full bg-accent-soft px-2 text-label font-semibold tabular-nums text-accent">
          <GalleryHorizontalEnd className="h-4 w-4 shrink-0" aria-hidden />
          {notices.length}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-prototype-notice-chip={notices.length}
      aria-label={label}
      title={first.title}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-accent/30 bg-accent-soft px-2 text-label font-semibold text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onClick={open}
    >
      <GalleryHorizontalEnd className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{t("proto.notice.ready")}</span>
      {notices.length > 1 ? <span className="tabular-nums opacity-80">{notices.length}</span> : null}
    </button>
  );
}
