"use client";

import { MessageCircleQuestionMark, TriangleAlert } from "lucide-react";

import { openPrototypeReview } from "@/hooks/usePrototypeReview";
import { useLocale } from "@/lib/i18n";

import { usePrototypeNoticesFor } from "./prototypeReviewStore";

/** Where the seat's «Потрібні ви» column is put away (the folded desktop
    seat, the phone board's seat card), one chip says what still waits on the
    operator. It counts the forms that wait and names them as every other
    surface does, «Потрібні ви · N» beside the strip's mark
    (docs/design/legatus/build-plan.md, slice 1), opening the first of them.
    An answered form whose delivery needs attention waits on nobody: it is no
    part of the count, the same rule as `useOpenDecisionCount`. While only such
    records are left the chip names the stuck delivery with no number and
    opens the first record, so Retry stays one tap away. The phone card, which
    has no room beside its title, draws the chip in a full touch target on a
    line of its own under the seat's words, level with its title. Absent while
    nothing is left. */
export function PrototypeNoticeChip({ project, compact = false }: { project: string; compact?: boolean }) {
  const { t } = useLocale();
  const notices = usePrototypeNoticesFor(project);
  const waiting = notices.filter((notice) => !notice.undelivered);
  const first = waiting[0] ?? notices[0];
  if (!first) return null;
  const open = () => openPrototypeReview({ ...first.target, from: "notice" });
  const count = waiting.length;
  const word = count
    ? t("decisions.waiting", { count })
    : t(compact ? "proto.notice.undeliveredShort" : "proto.notice.undelivered");
  const label = count
    ? `${word}: ${first.title}. ${t(first.asks === "questions" ? "proto.notice.answer" : "proto.notice.open")}`
    : `${t("proto.notice.undelivered")}: ${first.title}. ${t("proto.notice.open")}`;
  const Mark = count ? MessageCircleQuestionMark : TriangleAlert;
  if (compact) {
    return (
      <div data-prototype-notice-chip-line="" className="order-last -mt-1 flex basis-full pl-10">
        <button
          type="button"
          data-prototype-notice-chip={count}
          data-prototype-notice-chip-stuck={count ? undefined : ""}
          aria-label={label}
          className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[8px] px-1 active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={open}
        >
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-accent-soft px-2 text-label font-semibold tabular-nums text-accent">
            <Mark className="h-4 w-4 shrink-0" aria-hidden />
            <span data-prototype-notice-chip-word="" className="whitespace-nowrap">{word}</span>
          </span>
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      data-prototype-notice-chip={count}
      data-prototype-notice-chip-stuck={count ? undefined : ""}
      aria-label={label}
      title={first.title}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-accent/30 bg-accent-soft px-2 text-label font-semibold tabular-nums text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onClick={open}
    >
      <Mark className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span data-prototype-notice-chip-word="" className="whitespace-nowrap">{word}</span>
    </button>
  );
}
