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

/** Where a written path may have been cut short: a bare space inside a name,
    or the `#` or `?` that also begins a link's fragment or query. */
const CUT = /[\s#?]/;

/** What records write about runner output: whole paths, and beginnings of
    paths that ended at a possible cut. */
export type RunnerOutputMentions = { paths: ReadonlySet<string>; beginnings: ReadonlySet<string> };

/** Every path inside a runner output directory that these records write,
    lowercased, starting at the runner directory. Records are stored JSON text.
    A path is read in the forms people and tools write it: plain, with URL
    encoding, with a backslash before a space or a punctuation mark, and with
    backslashes as separators. A written path that stops at a space, a `#` or
    a `?` may be the beginning of a longer name, so it is kept as a beginning
    too. */
export function runnerOutputMentions(records: readonly string[]): RunnerOutputMentions {
  const paths = new Set<string>(), beginnings = new Set<string>();
  for (const record of records) {
    // One level of JSON string escaping: a line break ends a path, and a
    // doubled backslash is one backslash of the text.
    const text = record.toLowerCase().replace(/\\(.)/g, (_, next: string) =>
      next === "n" || next === "r" || next === "t" ? "\n" : next === "\\" ? BACKSLASH : next);
    const escaped = text.replaceAll(BACKSLASH + " ", SPACE).replaceAll(BACKSLASH, "");
    const separated = text.replaceAll(BACKSLASH, "/");
    for (const form of new Set([text, escaped, separated, percentDecoded(escaped), percentDecoded(separated)])) {
      for (const match of form.matchAll(RUNNER_OUTPUT_NAME)) {
        let end = match.index + match[0].length;
        while (end < form.length && !END_OF_MENTION.test(form[end]!)) end++;
        const whole = form.slice(match.index, end).replace(/\/{2,}/g, "/");
        // A sentence or a directory mention may close with a dot, a colon or a slash.
        const written = whole.replace(/[./:]+$/, "");
        if (!written.includes("/")) continue;
        paths.add(written);
        const stop = form[end];
        if (stop !== undefined && stop !== "\n" && CUT.test(stop)) beginnings.add(whole.endsWith("/") ? whole : written);
      }
    }
  }
  return { paths, beginnings };
}

/** Whether a record links this runner output file: it writes the file's path,
    one of its parent directories inside the runner directory, the beginning
    of its path up to a possible cut, or, for a file of an HTML report, that
    report's entry page. */
export function runnerOutputLinked(mentions: RunnerOutputMentions, output: string): boolean {
  const file = comparable(output);
  if (mentions.paths.has(file)) return true;
  if (file.startsWith("playwright-report/") && mentions.paths.has(REPORT_INDEX)) return true;
  const segments = file.split("/");
  for (let depth = 2; depth < segments.length; depth++) {
    if (mentions.paths.has(segments.slice(0, depth).join("/"))) return true;
  }
  for (const beginning of mentions.beginnings) if (file.startsWith(beginning)) return true;
  return false;
}
