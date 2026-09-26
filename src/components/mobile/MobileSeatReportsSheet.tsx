"use client";

import { ChevronRight, Send } from "lucide-react";
import { type CSSProperties } from "react";

import { useKeyboardInset } from "@/hooks/useComposer";
import { useLocale } from "@/lib/i18n";

import { SeatReportsBody, seatReportsReading, useProjectReports } from "../orchestrator/SeatReports";
import { MobileSheet, MobileSheetRow } from "./MobileSheet";

/**
 * The seat's Reports section on the phone (docs/design/orchestrator-reports.md
 * §5.6): the same body the desktop chip opens, as a compact sheet reached from
 * a row in the seat sheet, the way the seat tick's is (#1681). Its × and scrim
 * return to the seat sheet. The keyboard is budgeted as the tick sheet's is,
 * so the name and chat id fields stay above it.
 */
export function MobileSeatReportsSheet({ project, projectName, onClose }: {
  project: string;
  projectName: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const kbInset = useKeyboardInset();
  const reports = useProjectReports(project);
  return (
    <div
      className="[&>[data-mobile2-scrim]]:bottom-[var(--seat-keyboard-inset)]"
      style={{ "--seat-keyboard-inset": `${kbInset}px` } as CSSProperties}
    >
      <MobileSheet name="reports" title={t("seatReports.sheetTitle", { project: projectName })} onClose={onClose}>
        <div data-testid="mobile-seat-reports-sheet">
          <SeatReportsBody project={project} projectName={projectName} reports={reports} surface="mobile" />
        </div>
      </MobileSheet>
    </div>
  );
}

/** The row that opens it, under the tick's row in the live seat sheet. */
export function MobileSeatReportsRow({ project, onOpen }: { project: string; onOpen: () => void }) {
  const { t } = useLocale();
  const reports = useProjectReports(project);
  const reading = seatReportsReading(reports.settings, t);
  return (
    <MobileSheetRow
      icon={<Send className="h-[18px] w-[18px]" aria-hidden />}
      label={t("seatReports.label")}
      onSelect={onOpen}
      ariaLabel={t("seatReports.chipAria", { line: reading.line })}
      attrs={{ "data-mobile2-open": "reports", "data-seat-reports-row": reading.chat ? "chat" : "log" }}
      trailingShrinks
      trailing={
        <>
          <span data-seat-reports-row-summary className="min-w-0 truncate">{reading.face}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </>
      }
    />
  );
}
