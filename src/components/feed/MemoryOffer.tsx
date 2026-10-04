"use client";

import { useLocale } from "@/lib/i18n";

import { BUBBLE_MEASURE } from "./measure";

/**
 * The line under an operator turn that says which shared-memory entries were
 * offered to the agent with it.
 *
 * It keeps the bubble's own measure and trailing edge, so it reads as a caption
 * of that message and never reaches into the agent's column. A single short
 * title fits on its line and is drawn as plain text with nothing to toggle.
 * Anything longer folds to one truncated line, and opening it lets that same
 * line wrap in place, so each title appears once. On the phone the folded line
 * is a 44 px target that starts below the copy control's own 44 px box and
 * hands its excess back to the gap under the row while it is folded.
 */
const SHORT_TITLE = 48;
const PHONE_MEASURE = "max-w-[86%]";

export function MemoryOffer({ names, mobile }: { names: string[]; mobile: boolean }) {
  const { t } = useLocale();
  const joined = names.join(" · ");
  const label = t("memory.offered", { names: joined });
  const measure = mobile ? PHONE_MEASURE : BUBBLE_MEASURE;
  if (names.length === 1 && names[0].length <= SHORT_TITLE) {
    return <p data-memory-offer className={`mt-1 min-w-0 ${measure} whitespace-normal break-words text-right text-caption text-muted`}>{label}</p>;
  }
  return (
    <details data-memory-offer className={`group/offer min-w-0 ${measure} text-right text-caption text-muted ${mobile ? "mt-1.5 -mb-3 open:mb-0" : "mt-1"}`}>
      <summary
        title={joined}
        className={`cursor-pointer list-none [&::-webkit-details-marker]:hidden ${mobile ? "flex min-h-11 items-center justify-end" : ""}`}
      >
        <span className="block min-w-0 truncate group-open/offer:whitespace-normal group-open/offer:break-words">{label}</span>
      </summary>
    </details>
  );
}
