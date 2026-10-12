"use client";

import { MessageCircleQuestionMark, GalleryHorizontalEnd, TriangleAlert } from "lucide-react";

import { openPrototypeReview } from "@/hooks/usePrototypeReview";
import { useLocale, type TFunction } from "@/lib/i18n";

import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";

import { usePrototypeNoticesFor } from "./prototypeReviewStore";

/** The word that a prototype or a question waits where the seat's «Рішення»
    column is put away: one chip with the count, opening the first waiting
    review. The folded seat's strip draws it with its words; the phone
    board's seat card, which has no room beside its title, draws the mark,
    the short word and the count in a full touch target on a line of its own
    under the seat's words, level with its title. Absent while nothing waits. */
export function PrototypeNoticeChip({ project, compact = false }: { project: string; compact?: boolean }) {
  const { t } = useLocale();
  const notices = usePrototypeNoticesFor(project);
  const first = notices[0];
  if (!first) return null;
  const open = () => openPrototypeReview({ ...first.target, from: "notice" });
  const label = `${noticeWord(t, first)}: ${first.title}. ${t(first.asks === "questions" && !first.undelivered ? "proto.notice.answer" : "proto.notice.open")}`;
  if (compact) {
    return (
      <div data-prototype-notice-chip-line="" className="order-last -mt-1 flex basis-full pl-10">
        <button
          type="button"
          data-prototype-notice-chip={notices.length}
          aria-label={label}
          className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[8px] px-1 active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={open}
        >
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-accent-soft px-2 text-label font-semibold tabular-nums text-accent">
            <NoticeMark notice={first} className="h-4 w-4 shrink-0" aria-hidden />
            <span data-prototype-notice-chip-word="" className="whitespace-nowrap">{t(first.asks === "questions" ? "proto.questions" : "proto.button.word")}</span>
            <span>{notices.length}</span>
          </span>
        </button>
      </div>
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
      <NoticeMark notice={first} className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{noticeWord(t, first)}</span>
      {notices.length > 1 ? <span className="tabular-nums opacity-80">{notices.length}</span> : null}
    </button>
  );
}

/** What waits: a prototype, questions, or a decision whose message keeps failing to reach the seat. */
function noticeWord(t: TFunction, notice: PrototypeReviewNotice): string {
  return t(notice.undelivered ? "proto.notice.undelivered" : notice.asks === "questions" ? "proto.notice.questions" : "proto.notice.ready");
}
function NoticeMark({ notice, ...props }: { notice: PrototypeReviewNotice; className?: string; "aria-hidden"?: boolean }) {
  const Mark = notice.undelivered ? TriangleAlert : notice.asks === "questions" ? MessageCircleQuestionMark : GalleryHorizontalEnd;
  return <Mark {...props} />;
}
