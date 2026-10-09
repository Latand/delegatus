"use client";

import { Timer } from "lucide-react";
import { type CSSProperties } from "react";

import { useKeyboardInset } from "@/hooks/useComposer";
import { useLocale } from "@/lib/i18n";

import { SeatTickActions, SeatTickBody, useSeatTickDraft } from "../orchestrator/SeatTickBody";
import { SeatTickSwitch } from "../orchestrator/SeatTickSwitch";
import { seatTickReading } from "../orchestrator/seatTickView";
import { useSeatTickSettings } from "../orchestrator/useSeatTickSettings";
import { MobileSheet } from "./MobileSheet";

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
  const state = useSeatTickDraft(read);

  return (
    <div
      className="[&>[data-mobile2-scrim]]:bottom-[var(--seat-keyboard-inset)]"
      style={{ "--seat-keyboard-inset": `${kbInset}px` } as CSSProperties}
    >
      <MobileSheet
        name="tick"
        title={t("seatTick.sheetTitle", { project: projectName })}
        onClose={onClose}
        footer={state.dirty || read.error ? <SeatTickActions read={read} state={state} surface="mobile" /> : null}
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
 * The tick's row inside the live seat sheet (mobile v2 §5: a labelled control
 * on the phone is a row).
 *
 * The label and its icon open the tick sheet. The trailing control is the same
 * switch the desktop header carries, 36 px tall in the 44 px row: a tap on it
 * opens the sheet too, and a horizontal drag changes the stop, while a vertical
 * one still scrolls the seat sheet. The row is a group and not one button,
 * because a slider cannot live inside a button; a tap on its own padding or on
 * the gap between the two opens the sheet as well, so the whole row stays the
 * target it was when it was one button.
 */
export function MobileSeatTickRow({ project, onOpen }: { project: string; onOpen: () => void }) {
  const { t } = useLocale();
  const read = useSeatTickSettings(project, true);
  const now = Date.now();
  const reading = seatTickReading(read, now, t);
  return (
    <div
      data-seat-tick-row={reading.state}
      onClick={(event) => { if (event.target === event.currentTarget) onOpen(); }}
      className="flex min-h-11 w-full items-center gap-3 px-4 text-body font-semibold text-primary"
    >
      <button
        type="button"
        data-mobile2-open="tick"
        aria-label={t("seatTick.chipAria", { line: reading.line })}
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-secondary"><Timer className="h-[18px] w-[18px]" aria-hidden /></span>
        <span className="min-w-0 truncate">{t("seatTick.rowLabel")}</span>
      </button>
      <SeatTickSwitch read={read} reading={reading} now={now} surface="mobile" open={false} onOpen={onOpen} />
    </div>
  );
}
