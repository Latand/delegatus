"use client";

import { MessageCircleQuestionMark, GalleryHorizontalEnd } from "lucide-react";

import { openPrototypeReview } from "@/hooks/usePrototypeReview";
import { useLocale } from "@/lib/i18n";

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
  const label = `${t(first.asks === "questions" ? "proto.notice.questions" : "proto.notice.ready")}: ${first.title}. ${t(first.asks === "questions" ? "proto.notice.answer" : "proto.notice.open")}`;
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
            <NoticeMark questions={first.asks === "questions"} className="h-4 w-4 shrink-0" aria-hidden />
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
      <NoticeMark questions={first.asks === "questions"} className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{t(first.asks === "questions" ? "proto.notice.questions" : "proto.notice.ready")}</span>
      {notices.length > 1 ? <span className="tabular-nums opacity-80">{notices.length}</span> : null}
    </button>
  );
}

function NoticeMark({ questions, ...props }: { questions: boolean; className?: string; "aria-hidden"?: boolean }) {
  const Mark = questions ? MessageCircleQuestionMark : GalleryHorizontalEnd;
  return <Mark {...props} />;
}
