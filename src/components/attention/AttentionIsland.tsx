"use client";

import { Filter } from "lucide-react";

import { BAR_CONTROL, BAR_OUTLINED, BAR_PRESSED } from "@/components/ProjectBar";
import { useLocale } from "@/lib/i18n";

interface Props {
  /** The «Needs you» list's length (the decision forms waiting for the
      operator and the waits no seat answers yet, every project;
      `needsYouHolds`), passed in so every surface shows one number. */
  count: number;
  panelOpen: boolean;
  filterActive: boolean;
  onTogglePanel: () => void;
  /** Absent while nothing on the board waits: the filter keeps the waiting
      cards lit, so with none it would only dim the board. */
  onToggleFilter?: () => void;
}

const BAR_ICON = "h-[15px] w-[15px] shrink-0";
/* The outlined control in the muted ink: with both inks on one element the
   stylesheet's order decided, and the zero state drew in the primary one. */
const MUTED_OUTLINED = "border-border bg-card text-muted hover:border-strong";

/**
 * The header's needs-you control (docs/design/needs-you-options.md, option B):
 * «● Waiting N» in the bar's own outlined style, pressed while the panel it
 * opens is showing. The count is every project's, as the panel behind it is,
 * so the number promises nothing the click cannot show. There is no «Next»:
 * the panel is a list the operator picks from, and nothing walks them from
 * project to project. The N key still walks the project on screen.
 *
 * The funnel beside it is the "show only who waits for me" board filter (F),
 * present while anything on the board waits, a parked lane included.
 *
 * At zero it stays, muted, with no dot and no number, so the corner always
 * answers "what needs me?" and the onboarding walk has its anchor.
 *
 * DESKTOP ONLY since mobile v2 lane 8 (#1439). The phone's badge is the
 * shell's bar target (`MobileShell`), opening the Needs-you sheet.
 */
export function AttentionIsland({ count, panelOpen, filterActive, onTogglePanel, onToggleFilter }: Props) {
  const { t } = useLocale();
  return (
    <div data-attention-island data-walk-anchor="needs" {...(count === 0 ? { "data-attention-zero": "" } : {})} className="flex items-center gap-2">
      <button
        type="button"
        data-attention-count
        className={`${BAR_CONTROL} ${panelOpen ? BAR_PRESSED : count === 0 ? MUTED_OUTLINED : BAR_OUTLINED}`}
        aria-expanded={panelOpen}
        aria-label={count ? t("attention.badge", { count }) : t("attention.chip")}
        title={t("attention.chipTitle")}
        onClick={onTogglePanel}
      >
        {count > 0 ? <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-warning" aria-hidden data-attention-dot="" /> : null}
        <span data-attention-chip-label="">{t("attention.chip")}</span>
        {count > 0 ? <span className="tabular-nums">{count}</span> : null}
      </button>
      {onToggleFilter ? (
        <button
          type="button"
          data-attention-filter
          className={`${BAR_CONTROL} ${filterActive ? BAR_PRESSED : BAR_OUTLINED} w-8 px-0`}
          aria-pressed={filterActive}
          title={filterActive ? t("attention.filterOff") : t("attention.filterOn")}
          aria-label={filterActive ? t("attention.filterOff") : t("attention.filterOn")}
          onClick={onToggleFilter}
        >
          <Filter className={BAR_ICON} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
