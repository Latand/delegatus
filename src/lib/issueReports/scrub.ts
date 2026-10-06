import { EMPTY_DENY_LIST, privateMatches, privateClassLabel, type PrivateClass, type PublicDenyList } from "@/lib/bridge/publicSafe";
import { canonicalSensitiveText } from "@/lib/privacy/canonicalText";
import { staticSensitiveClasses, type StaticFindingClass } from "@/lib/privacy/staticDetectors";

/* Advisory pointers for the reporter and the operator. Detector completeness
   carries no guarantee: the reporter must judge the whole text independently.
   Keep the shared detectors and a few general quote/image hints readable. */
export const ISSUE_REPORT_MAX_TITLE_CHARS = 160;
export const ISSUE_REPORT_MAX_BODY_CHARS = 20_000;
export type IssueReportFindingClass = PrivateClass | StaticFindingClass | "quote" | "image";

export interface IssueReportFinding {
  class: IssueReportFindingClass;
  label: string;
  where: "title" | "body";
  /** Lines and UTF-16 offsets refer to the named reading of the field. */
  lines: number[];
  reading: "written" | "decoded";
  span: { start: number; end: number; text: string };
}

const STATIC_LABELS: Record<StaticFindingClass, string> = {
  credential: "a credential", home_path: "a home directory path",
  private_network: "a private network address", resource_identifier: "a resource identifier",
  transcript_content: "a line copied from a conversation",
};
const REPORT_PATTERNS: readonly [IssueReportFindingClass, string, RegExp][] = [
  ["id", "a conversation, deployment, card or pipeline id", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,64}\b/i],
  ["quote", "a quoted block", /^\s*>[^\n]*/m],
  ["quote", "a quotation", /"[^"\s][^"]*\s[^"]*[^"\s]"/],
  ["quote", "a quotation", /[“„«][^“”„«»]*\S\s+\S[^“”„«»]*[”“»]/],
  ["image", "an embedded image; review screenshot redaction", /!\[[^\]]*\]\(|<img\b/i],
];

function findingsIn(where: "title" | "body", text: string, deny: PublicDenyList): IssueReportFinding[] {
  const canonical = canonicalSensitiveText(text).text.normalize("NFKC");
  const readings: [IssueReportFinding["reading"], string][] = [["written", text]];
  if (canonical !== text) readings.push(["decoded", canonical]);
  const hints: IssueReportFinding[] = [];
  for (const [reading, value] of readings) {
    const note = (kind: IssueReportFindingClass, label: string, start: number, end: number) => {
      const span = { start, end, text: value.slice(start, end) };
      // Avoid repeating a written occurrence in the decoded reading.
      if (hints.some((hint) => hint.class === kind && hint.span.text === span.text && hint.span.start === start)) return;
      const first = value.slice(0, start).split("\n").length;
      const last = first + span.text.split("\n").length - 1;
      const lines = Array.from({ length: last - first + 1 }, (_, i) => first + i);
      const overlap = hints.find((hint) => hint.class === kind && hint.reading === reading
        && hint.span.start < end && start < hint.span.end);
      if (overlap) {
        overlap.span.start = Math.min(overlap.span.start, start);
        overlap.span.end = Math.max(overlap.span.end, end);
        overlap.span.text = value.slice(overlap.span.start, overlap.span.end);
        overlap.lines = [...new Set([...overlap.lines, ...lines])].sort((a, b) => a - b);
      } else hints.push({ class: kind, label, where, reading, span, lines });
    };
    for (const match of privateMatches(value, deny)) note(match.class, privateClassLabel(match.class), match.start, match.end);
    staticSensitiveClasses(value, (kind, start, end) => note(kind, STATIC_LABELS[kind], start, end));
    for (const [kind, label, pattern] of REPORT_PATTERNS) {
      for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags + "g"))) note(kind, label, match.index, match.index + match[0].length);
    }
  }
  return hints;
}

/** A hint can be a false alarm; an empty result proves nothing about privacy. */
export function scrubIssueReport(report: { title: string; body: string }, deny: PublicDenyList = EMPTY_DENY_LIST): IssueReportFinding[] {
  return [...findingsIn("title", report.title, deny), ...findingsIn("body", report.body, deny)];
}
