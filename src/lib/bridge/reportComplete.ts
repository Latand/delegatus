import { BRIDGE_REPORT_COMPLETE_MAX_BYTES, type BridgeReportCompleteV1 } from "./types";

/** Leave whole items out from the end until the report fits, and count them. */
export function boundComplete(report: BridgeReportCompleteV1): BridgeReportCompleteV1 {
  let summary = report.summary;
  const sections = report.sections.map((section) => ({ heading: section.heading, items: [...section.items] }));
  const size = () => Buffer.byteLength([summary, ...sections.flatMap((section) => [section.heading, ...section.items])].join("\n"), "utf8");
  let omitted = report.omitted ?? 0;
  for (let at = sections.length - 1; at >= 0 && size() > BRIDGE_REPORT_COMPLETE_MAX_BYTES; at -= 1) {
    while (sections[at]!.items.length > 0 && size() > BRIDGE_REPORT_COMPLETE_MAX_BYTES) {
      sections[at]!.items.pop();
      omitted += 1;
    }
  }
  if (size() > BRIDGE_REPORT_COMPLETE_MAX_BYTES) {
    summary = "";
    omitted += 1;
  }
  return { summary, sections: sections.filter((section) => section.items.length > 0), ...(omitted > 0 ? { omitted } : {}) };
}
