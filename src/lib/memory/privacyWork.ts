import type { RenderReportInput, RenderReportResult } from "@/lib/bridge/reportRender";
import type { PublicDenyList } from "@/lib/bridge/publicSafe";
import type { IssueReportFinding } from "@/lib/issueReports/scrub";

export type PrivacyRequest =
  | { kind: "filter"; value: unknown }
  | { kind: "report"; input: Omit<RenderReportInput, "at"> & { at: string } }
  | { kind: "issue"; report: { title: string; body: string }; deny: PublicDenyList };
export type PrivacyResult = { privacyRevision: string; value: unknown };
export type { RenderReportInput, RenderReportResult, IssueReportFinding };
