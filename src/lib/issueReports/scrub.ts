import { EMPTY_DENY_LIST, privateClasses, privateClassLabel, type PrivateClass, type PublicDenyList } from "@/lib/bridge/publicSafe";
import { staticSensitiveClasses, type StaticFindingClass } from "@/lib/privacy/staticDetectors";

/*
 * What a Delegatus bug report may not carry into a public repository (#2518).
 *
 * A report is refused, never rewritten: the preview the operator approves has
 * to be the text its author wrote, so a finding goes back to the reporter with
 * the class and the lines it sits on, and the reporter rewords those lines.
 * The matched text is never repeated in the answer.
 *
 * Two existing detector sets do the finding, and this file adds no third:
 * `privateClasses`, which every public manager report already passes through
 * (hosts, domains, addresses, ports, local paths, emails, ids, usage, and the
 * names this machine knows: accounts, people, other projects, the local user),
 * and the publication gate's pattern detectors (home paths, credentials,
 * private networks, resource identifiers, transcript lines). The three rules
 * below are the ones a report needs and neither set states: a bare pipeline id
 * or digest, a quoted block, and an embedded image.
 */

export const ISSUE_REPORT_MAX_TITLE_CHARS = 160;
export const ISSUE_REPORT_MAX_BODY_CHARS = 20_000;

export type IssueReportFindingClass = PrivateClass | StaticFindingClass | "quote" | "image";

export interface IssueReportFinding {
  class: IssueReportFindingClass;
  /** What the class means, in words the reporter can act on. */
  label: string;
  where: "title" | "body";
  /** 1-based lines of the title or body that carry it. */
  lines: number[];
}

const STATIC_LABELS: Record<StaticFindingClass, string> = {
  credential: "a credential",
  home_path: "a home directory path",
  private_network: "a private network address",
  resource_identifier: "a resource identifier",
  transcript_content: "a line copied from a conversation",
};

/* A pipeline id is eight bare hex characters, and a commit or a digest is a
   longer run of them. A hex word with no digit ("deadbeef") is left alone. */
const BARE_HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,64}\b/i;
const QUOTED_BLOCK = /^\s*>/;
const EMBEDDED_IMAGE = /!\[[^\]]*\]\(|<img\b/i;

function classesOf(line: string, deny: PublicDenyList): Map<IssueReportFindingClass, string> {
  const found = new Map<IssueReportFindingClass, string>();
  for (const kind of privateClasses(line, deny)) found.set(kind, privateClassLabel(kind));
  for (const kind of staticSensitiveClasses(line.normalize("NFKC"))) found.set(kind, STATIC_LABELS[kind]);
  if (BARE_HEX_ID.test(line)) found.set("id", privateClassLabel("id"));
  if (QUOTED_BLOCK.test(line)) found.set("quote", "a quoted block; say what happened in your own words");
  if (EMBEDDED_IMAGE.test(line)) found.set("image", "an embedded image; a screenshot is added by the operator after redaction");
  return found;
}

function findingsIn(where: "title" | "body", text: string, deny: PublicDenyList): IssueReportFinding[] {
  const byClass = new Map<IssueReportFindingClass, IssueReportFinding>();
  const note = (kind: IssueReportFindingClass, label: string, line: number) => {
    const finding = byClass.get(kind) ?? { class: kind, label, where, lines: [] };
    if (!finding.lines.includes(line)) finding.lines.push(line);
    byClass.set(kind, finding);
  };
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [kind, label] of classesOf(line, deny)) note(kind, label, index + 1);
  });
  /* A value split across lines is found in the whole text and reported
     against the first line, so no class slips through a line break. */
  for (const [kind, label] of classesOf(text, deny)) {
    if (kind !== "quote" && !byClass.has(kind)) note(kind, label, 1);
  }
  return [...byClass.values()];
}

/** Every private class in a report's title and body. Empty means it may be previewed. */
export function scrubIssueReport(
  report: { title: string; body: string },
  deny: PublicDenyList = EMPTY_DENY_LIST,
): IssueReportFinding[] {
  return [...findingsIn("title", report.title, deny), ...findingsIn("body", report.body, deny)];
}
