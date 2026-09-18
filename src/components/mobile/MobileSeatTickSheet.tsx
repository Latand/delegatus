"use client";

import { ChevronRight, Timer } from "lucide-react";
import { type CSSProperties } from "react";

import { useKeyboardInset } from "@/hooks/useComposer";
import { useLocale } from "@/lib/i18n";

import { SeatTickActions, SeatTickBody, SeatTickDot, useSeatTickDraft } from "../orchestrator/SeatTickBody";
import { seatTickReading } from "../orchestrator/seatTickView";
import { useSeatTickSettings } from "../orchestrator/useSeatTickSettings";
import { MobileSheet, MobileSheetRow } from "./MobileSheet";

/**
 * The seat tick on the phone (#1681): the same record, in the same order, as a
 * compact bottom sheet.
 *
 * It is a SHEET reached from a row rather than a third button in the seat
 * sheet's footer. Two reasons, both the phone's: at 390 px that footer is
 * 358 px wide and already holds Rotate beside a flex-filled «Open
 * conversation», so a third control truncates the primary action; and every
 * labelled control on the phone is a row in a sheet (mobile v2 §5) — the tick
 * is a setting to read and change, and the footer is for acting on the seat.
 *
 * Its × and its scrim return to the seat sheet the row was tapped in, so the
 * way back is the way in. The platform back gesture closes to the board, as it
 * does for every other sheet — the navigation store owns that, and a sheet
 * never writes a history entry.
 *
 * The keyboard is budgeted against the same `useKeyboardInset` signal the seat
 * sheet uses, so the footer's Save stays above the keyboard while the interval
 * field is focused.
 */
export function MobileSeatTickSheet({ project, projectName, onClose }: {
  project: string;
  projectName: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const kbInset = useKeyboardInset();
  const read = useSeatTickSettings(project, true);
  /* One draft, read by the body's fields and by the footer's Save. */
  const state = useSeatTickDraft(read.record);

  return (
    <div
      className="[&>[data-mobile2-scrim]]:bottom-[var(--seat-keyboard-inset)]"
      style={{ "--seat-keyboard-inset": `${kbInset}px` } as CSSProperties}
    >
      <MobileSheet
        name="tick"
        title={t("seatTick.sheetTitle", { project: projectName })}
        onClose={onClose}
        footer={<SeatTickActions read={read} state={state} offDefault={read.record?.effective.isDefault === false} surface="mobile" />}
      >
        <div data-testid="mobile-seat-tick-sheet">
          <SeatTickBody
            project={project}
            projectName={projectName}
            read={read}
            state={state}
            surface="mobile"
            /* Null here: the actions are in the footer above, at the thumb. */
            actions={null}
          />
        </div>
      </MobileSheet>
    </div>
  );
}

/**
 * The row that opens it, inside the live seat sheet (mobile v2 §5: a labelled
 * control on the phone is a row).
 *
 * The trailing text is the desktop chip's closed summary without its «Tick:»
 * prefix — the sheet it sits in has already said which seat this is — and the
 * dot beside it is the same tone the chip carries, from the same reading.
 */
export function MobileSeatTickRow({ project, onOpen }: { project: string; onOpen: () => void }) {
  const { t } = useLocale();
  const read = useSeatTickSettings(project, true);
  const reading = seatTickReading(read, Date.now(), t);
  return (
    <MobileSheetRow
      icon={<Timer className="h-[18px] w-[18px]" aria-hidden />}
      label={t("seatTick.rowLabel")}
      onSelect={onOpen}
      ariaLabel={t("seatTick.chipAria", { line: reading.line })}
      attrs={{ "data-mobile2-open": "tick", "data-seat-tick-row": reading.state }}
      /* The trailing text here is a whole clause, not a word, so IT is what
         gives way: the label, the state dot and the chevron keep their size
         and the summary truncates between them. */
      trailingShrinks
      trailing={
        <>
          <span data-seat-tick-row-summary className="min-w-0 truncate">{reading.summary}</span>
          <SeatTickDot tone={reading.tone} />
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </>
      }
    />
  );
}
