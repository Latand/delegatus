/** Directories a test runner fills again on every run: Playwright's default
    output directory and its HTML report. A capture inside one is evidence only
    while a record links it. */
const RUNNER_OUTPUT_DIRECTORIES: ReadonlySet<string> = new Set(["test-results", "playwright-report"]);
const RUNNER_OUTPUT_NAME = /(?:test-results|playwright-report)\//g;
/** The entry page of the HTML report; a link to it stands for the report. */
const REPORT_INDEX = "playwright-report/index.html";

/** Stands for a space inside a name, on both sides of a comparison. */
const SPACE = "\u0001";
/** A backslash that the record's text really holds, after JSON decoding. */
const BACKSLASH = "\u0002";
/** Where a written path ends. */
const END_OF_MENTION = /[\s"'`()[\]<>{}|,;*!?#=\u0002]/;

const comparable = (value: string) => value.toLowerCase().replaceAll(" ", SPACE);

/** The path from its first runner output directory on, as a file inside it;
    null outside one. `relative` uses forward slashes. */
export function runnerOutputPath(relative: string): string | null {
  const segments = relative.split("/");
  const at = segments.findIndex(segment => RUNNER_OUTPUT_DIRECTORIES.has(segment));
  return at < 0 || at === segments.length - 1 ? null : segments.slice(at).join("/");
}

function percentDecoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/g, run => {
    try { return decodeURIComponent(run).toLowerCase().replaceAll(" ", SPACE); }
    catch { return run; }
  });
}

/** Every path inside a runner output directory that these records write,
    lowercased, starting at the runner directory. Records are stored JSON text.
    A path is read in the forms people and tools write it: plain, with URL
    encoding, with a backslash before a space or a punctuation mark, and with
    backslashes as separators. A written path ends at a bare space and at a
    `#` or `?`, where a link's fragment or query begins. */
export function runnerOutputMentions(records: readonly string[]): Set<string> {
  const mentions = new Set<string>();
  for (const record of records) {
    // One level of JSON string escaping: a line break ends a path, and a
    // doubled backslash is one backslash of the text.
    const text = record.toLowerCase().replace(/\\(.)/g, (_, next: string) =>
      next === "n" || next === "r" || next === "t" ? " " : next === "\\" ? BACKSLASH : next);
    const escaped = text.replaceAll(BACKSLASH + " ", SPACE).replaceAll(BACKSLASH, "");
    const separated = text.replaceAll(BACKSLASH, "/");
    for (const form of new Set([text, escaped, separated, percentDecoded(escaped), percentDecoded(separated)])) {
      for (const match of form.matchAll(RUNNER_OUTPUT_NAME)) {
        let end = match.index + match[0].length;
        while (end < form.length && !END_OF_MENTION.test(form[end]!)) end++;
        // A sentence or a directory mention may close with a dot, a colon or a slash.
        const written = form.slice(match.index, end).replace(/[./:]+$/, "");
        if (written.includes("/")) mentions.add(written.replace(/\/{2,}/g, "/"));
      }
    }
  }
  return mentions;
}

/** Whether a record links this runner output file: it writes the file's path,
    one of its parent directories inside the runner directory, or, for a file
    of an HTML report, that report's entry page. */
export function runnerOutputLinked(mentions: ReadonlySet<string>, output: string): boolean {
  const file = comparable(output);
  if (mentions.has(file)) return true;
  if (file.startsWith("playwright-report/") && mentions.has(REPORT_INDEX)) return true;
  const segments = file.split("/");
  for (let depth = 2; depth < segments.length; depth++) {
    if (mentions.has(segments.slice(0, depth).join("/"))) return true;
  }
  return false;
}
