import { BRIDGE_REPORT_COMPLETE_MAX_BYTES, type BridgeReportCompleteV1 } from "./types";

/** UTF-8 bytes of the whole report: summary, headings and items. */
export function completeBytes(report: BridgeReportCompleteV1): number {
  return Buffer.byteLength([report.summary, ...report.sections.flatMap((section) => [section.heading, ...section.items])].join("\n"), "utf8");
}

/** Whether the whole report fits its bound. A report that does not is never
    stored as complete: the seat splits it, so no item is left out. */
export function completeFits(report: BridgeReportCompleteV1): boolean {
  return completeBytes(report) <= BRIDGE_REPORT_COMPLETE_MAX_BYTES;
}
