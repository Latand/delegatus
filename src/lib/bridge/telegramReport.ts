import { sectionHeading, sectionLines, type CutReport } from "./reportRender";
import { SECTION_EMOJI } from "./reportWords";

/*
 * The Telegram copy of a manager report (docs/design/orchestrator-reports.md
 * §5.5), rendered from the same cut report as the bridge copy, so both list
 * exactly the same items.
 *
 * Compact, as the operator asked on 26.09: line 1 is the class emoji, the bold
 * name and kind, and the local time; line 2 is the summary; every section
 * goes inside one expandable blockquote, which Telegram shows collapsed. No
 * `<a>` tag is ever emitted and the scrubber has already removed URLs and
 * domains, so Telegram has nothing to preview. A number this project's forge
 * cache knows as one of its pull requests reads "PR 2233"; any other `#N`
 * stays as plain text.
 */

export const TELEGRAM_HTML_MAX_CHARS = 4_096;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Whether a number is one of this project's pull requests. */
export interface PullRequestLookup {
  has(number: number): boolean;
}

/** `#2233` → `PR 2233` for a known pull request; everything else untouched. */
export function pullRequestText(text: string, pullRequests: PullRequestLookup): string {
  return text.replace(/#(\d+)\b/g, (whole, digits: string) => (pullRequests.has(Number(digits)) ? `PR ${digits}` : whole));
}

export function renderTelegram(cut: CutReport, pullRequests: PullRequestLookup = new Set<number>()): string {
  const text = (value: string) => escapeHtml(pullRequestText(value, pullRequests));
  const lines = [`${cut.emoji} <b>${text(`${cut.name} · ${cut.kind}`)}</b> · ${text(cut.when)}`];
  if (cut.summary) lines.push(text(cut.summary));
  const blocks = cut.sections.map((section) => [
    `${SECTION_EMOJI[section.id]} <b>${text(sectionHeading(section, cut.locale))}</b>`,
    ...sectionLines(section, cut.locale).map((line) => `• ${text(line)}`),
  ].join("\n"));
  const html = blocks.length > 0
    ? `${lines.join("\n")}\n<blockquote expandable>${blocks.join("\n\n")}</blockquote>`
    : lines.join("\n");
  /* A 1 900-byte report never reaches Telegram's bound; this is the floor
     under that arithmetic, never a cut a real report meets. */
  return html.length <= TELEGRAM_HTML_MAX_CHARS ? html : lines.join("\n").slice(0, TELEGRAM_HTML_MAX_CHARS);
}
