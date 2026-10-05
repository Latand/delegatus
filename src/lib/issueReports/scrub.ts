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
 * reader will see: one more view drops the inline markup Markdown draws and
 * never shows (emphasis, strike-through, code-span ticks, link brackets, HTML
 * tags and comments), since `A**da**` and `dead<b>beef</b>` read as one
 * word. A reference link (`A[da][ref]`, `A[da][]`, `A[da]`) is read as its
 * text wherever its definition sits, and the definition line is read as
 * written. The digest and the line numbers stay those of the text as written.
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

/* Blockquotes can sit inside nested bullet/ordered lists or use HTML. Read
   this in every decoded view before markdownVisible removes the tags. */
const QUOTED_BLOCK = /(?:^|\n)\s*(?:(?:[-+*]|\d{1,9}[.)])\s+)*>|<blockquote\b/i;
/* A quotation is two or more words between quotation marks. One marked word
   (a state called "delivered") is a term, and an apostrophe inside a word
   opens nothing and closes nothing ('don't stop now' is one quotation). Code spans stay readable: an error text belongs in one. A
   quotation may run over any number of lines, so the patterns cross line
   breaks; a mark cannot pair across another mark of its kind. Spaces just
   inside the marks change nothing: the words are counted between them. A
   straight mark that opens stands after no letter and one that closes before
   none, which is what keeps two marked terms from pairing across the prose
   between them. */
const QUOTED_WORD_CHAR = "(?:[^\\s'‘’]|(?<=\\p{L})['’](?=\\p{L}))";
const QUOTATION = [
  /"[^"\s][^"]*\s[^"]*[^"\s]"/,
  /(?<![\p{L}\p{N}])"\s*[^"\s]+\s+[^"\s][^"]*"(?![\p{L}\p{N}])/u,
  /[“„«][^“”„«»]*\S\s+\S[^“”„«»]*[”“»]/,
  /‹[^‹›]*\S\s+\S[^‹›]*›/,
  new RegExp(`(?<![\\p{L}\\p{N}])['‘]\\s*${QUOTED_WORD_CHAR}+\\s+${QUOTED_WORD_CHAR}(?:\\s|${QUOTED_WORD_CHAR})*['’](?![\\p{L}\\p{N}])`, "u"),
];
/* A line that opens with who spoke: `Operator: …`, `**User:** …`, `[human] …`. */
const SPEAKER_LINE = /(?:^|\n)\s*(?:[-*+]\s+)?[*_[(<]{0,3}(?:user|operator|human|assistant|agent|orchestrator|оператор|користувач|людина|асистент|агент|оркестратор)[*_\])>]{0,3}\s*(?::|—|\]|\))\s*[*_]{0,3}\s*\S/iu;
/* Explicit attribution remains a conversation quote inside a code span.
   Technical code spans without that attribution stay readable. */
const OPERATOR_SPEECH = "(?:wrote|said|replied|asked|написа[вл]а?|сказа[вл]а?|відпові[вл]а?|попроси[вл]а?)";
const OPERATOR = "(?:operator|user|human|оператор|користувач|людина)";
/* Connecting words and possessive attribution still name whose words the
   code span holds. Ordinary technical spans carry no speech attribution. */
const SPEECH_CONNECTOR = "(?:(?:with|using|exactly|as|follows|the|following|these|in|words|exact|saying|словами|так|дослівно)(?!\\p{L})\\s*){0,6}";
const QUOTE_OPEN = "(?:[\x60‹“«\"'‘]|<code\\b[^<>]*>)";
const ATTRIBUTED_OPERATOR_WORDS = new RegExp([
  `(?<!\\p{L})(?:${OPERATOR}\\s*(?:`,
  `(?:${OPERATOR_SPEECH}\\s*)?[:—]\\s*\\S`,
  `|${OPERATOR_SPEECH}\\s+${SPEECH_CONNECTOR}[:—]?\\s*${QUOTE_OPEN}`,
  `|['’]s\\s+(?:exact\\s+)?(?:reply|response|words|message)\\s*(?:(?:was|were|is|are)\\s*)?[:—]?\\s*${QUOTE_OPEN})`,
  `|(?:точна\\s+)?(?:відповідь|слова|повідомлення)\\s+(?:оператора|користувача|людини)\\s*(?:(?:була|були|було|є)\\s*)?[:—]?\\s*${QUOTE_OPEN})`,
].join(""), "iu");
/* An image in any form: inline, or by reference (`![board][ref]`, `![board]`). */
const EMBEDDED_IMAGE = /!\[|<img\b/i;

const OWN_WORDS = "say what happened in your own words";

/*
 * What a reader sees of a line once Markdown drew it: the inline markup is
 * gone and the characters on either side of it meet. `*` and `~` mark up
 * inside a word too; `_` only at a word's edge, which is why `issue_report`
 * keeps its underscore. A link shows its text; its address stays in the
 * written view, where the URL rule reads it. That holds for a reference link
 * too: its label goes, and so do the brackets of whatever is left, since a
 * definition anywhere in the document turns `[da]` into a link. An image is
 * the image rule's.
 */
/* An address may hold one level of brackets of its own: `[x](a(b)c)`. */
const INLINE_LINK = /\[([^\[\]]*)\]\((?:\([^()]*\)|[^()])*\)/g;
/* HTML break and block boundaries separate visible words. Inline tags still
   join their contents, as in `Per<b>son</b>`. */
const HTML_BOUNDARY = /<\/?(?:br|hr|address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)(?:\s[^<>]*)?\/?>/gi;

function markdownVisible(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(HTML_BOUNDARY, " ")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(INLINE_LINK, "$1")
    .replace(/\[([^\[\]]*)\]\[[^\[\]]*\]/g, "$1")
    .replace(/[[\]]/g, "")
    .replace(/[*~`]+/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "");
}

/** Every reading of a text a detector has to see: as written, decoded, and as
    Markdown shows each of those. */
function viewsOf(text: string): { views: string[]; unresolved: boolean } {
  const canonical = canonicalSensitiveText(text);
  const json = canonicalSensitiveText(text, true);
  const views = new Set<string>();
  for (const view of [text, canonical.text, json.text]) {
    for (const reading of [view, markdownVisible(view)]) {
      views.add(reading);
      views.add(reading.normalize("NFKC"));
    }
  }
  return { views: [...views], unresolved: canonical.error || json.error };
}

const QUOTATION_LABEL = `a quotation; ${OWN_WORDS}`;

function classesOf(line: string, deny: PublicDenyList): Map<IssueReportFindingClass, string> {
  const found = new Map<IssueReportFindingClass, string>();
  const { views, unresolved } = viewsOf(line);
  if (unresolved) found.set("encoding", "encoded text nested too deep to read; write the plain characters");
  for (const view of views) {
    for (const kind of privateClasses(view, deny, { strict: true })) found.set(kind, privateClassLabel(kind));
    for (const kind of staticSensitiveClasses(view)) found.set(kind, STATIC_LABELS[kind]);
    if (QUOTATION.some((pattern) => pattern.test(view))) found.set("quote", QUOTATION_LABEL);
    if (SPEAKER_LINE.test(view)) found.set("quote", `a line of a conversation; ${OWN_WORDS}`);
    if (ATTRIBUTED_OPERATOR_WORDS.test(view)) found.set("quote", `a line of a conversation; ${OWN_WORDS}`);
    if (QUOTED_BLOCK.test(view)) found.set("quote", `a quoted block; ${OWN_WORDS}`);
    if (EMBEDDED_IMAGE.test(view)) found.set("image", "an embedded image; a screenshot is added by the operator after redaction");
  }
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
  /* A quotation over several lines is reported against the line it opens on. */
  for (const view of viewsOf(text).views) {
    for (const pattern of QUOTATION) {
      const match = new RegExp(pattern.source, `${pattern.flags}g`).exec(view);
      if (match) note("quote", QUOTATION_LABEL, Math.min(lines.length, view.slice(0, match.index).split("\n").length));
    }
  }
  /* Any other value split across lines is found in the whole text and
     reported against the first line, so no class slips through a line break. */
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
