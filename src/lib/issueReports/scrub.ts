import { EMPTY_DENY_LIST, privateClasses, privateClassLabel, type PrivateClass, type PublicDenyList } from "@/lib/bridge/publicSafe";
import { canonicalSensitiveText } from "@/lib/privacy/canonicalText";
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
 * `privateClasses` in its strict reading, which every public manager report
 * already passes through in its lenient one (hosts, domains, addresses, ports,
 * local paths, emails, ids, usage, and the names this machine knows: accounts,
 * people, other projects, the local user), and the publication gate's pattern
 * detectors (home paths, credentials, private networks, resource identifiers,
 * transcript lines).
 *
 * Both read every view of a line the gate itself reads: the text as written,
 * and the text with its entities, percent escapes, backslash escapes and
 * zero-width characters decoded to a fixed point (`canonicalSensitiveText`).
 * Markdown renders `&#47;home` as a path, so a report is judged by what a
 * reader will see. The digest and the line numbers stay those of the text as
 * written.
 *
 * The rules below are the ones a report needs and neither set states: somebody
 * else's words (a quoted block, a quotation, a speaker's line) and an embedded
 * image.
 */

export const ISSUE_REPORT_MAX_TITLE_CHARS = 160;
export const ISSUE_REPORT_MAX_BODY_CHARS = 20_000;

export type IssueReportFindingClass = PrivateClass | StaticFindingClass | "quote" | "image" | "encoding";

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

const QUOTED_BLOCK = /^\s*>/;
/* A quotation is two or more words between quotation marks. One marked word
   (a state called "delivered") is a term, and an apostrophe inside a word
   opens nothing. Code spans stay readable: an error text belongs in one. */
const QUOTATION = [
  /"[^"\s][^"\n]*\s[^"\n]*[^"\s]"/,
  /[“„«][^“”„«»\n]*\S\s+\S[^“”„«»\n]*[”“»]/,
  /(?<![\p{L}\p{N}])['‘](?=[^\s'‘’])[^'‘’\n]*\s[^'‘’\n]*(?<=[^\s])['’](?![\p{L}\p{N}])/u,
];
/* A line that opens with who spoke: `Operator: …`, `**User:** …`, `[human] …`. */
const SPEAKER_LINE = /(?:^|\n)\s*(?:[-*+]\s+)?[*_[(<]{0,3}(?:user|operator|human|assistant|agent|orchestrator|оператор|користувач|людина|асистент|агент|оркестратор)[*_\])>]{0,3}\s*(?::|—|\]|\))\s*[*_]{0,3}\s*\S/iu;
const EMBEDDED_IMAGE = /!\[[^\]]*\]\(|<img\b/i;

const OWN_WORDS = "say what happened in your own words";

/** Every reading of a text a detector has to see: as written, and decoded. */
function viewsOf(text: string): { views: string[]; unresolved: boolean } {
  const canonical = canonicalSensitiveText(text);
  const json = canonicalSensitiveText(text, true);
  const views = new Set<string>();
  for (const view of [text, canonical.text, json.text]) {
    views.add(view);
    views.add(view.normalize("NFKC"));
  }
  return { views: [...views], unresolved: canonical.error || json.error };
}

function classesOf(line: string, deny: PublicDenyList): Map<IssueReportFindingClass, string> {
  const found = new Map<IssueReportFindingClass, string>();
  const { views, unresolved } = viewsOf(line);
  if (unresolved) found.set("encoding", "encoded text nested too deep to read; write the plain characters");
  for (const view of views) {
    for (const kind of privateClasses(view, deny, { strict: true })) found.set(kind, privateClassLabel(kind));
    for (const kind of staticSensitiveClasses(view)) found.set(kind, STATIC_LABELS[kind]);
    if (QUOTATION.some((pattern) => pattern.test(view))) found.set("quote", `a quotation; ${OWN_WORDS}`);
    if (SPEAKER_LINE.test(view)) found.set("quote", `a line of a conversation; ${OWN_WORDS}`);
    if (EMBEDDED_IMAGE.test(view)) found.set("image", "an embedded image; a screenshot is added by the operator after redaction");
  }
  if (QUOTED_BLOCK.test(line)) found.set("quote", `a quoted block; ${OWN_WORDS}`);
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
    if (!byClass.has(kind)) note(kind, label, 1);
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
