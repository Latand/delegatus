/** Public forge prose has its own language, independent of the board locale.
 * There is currently no project publication-language setting. */
export const PUBLICATION_LANGUAGE = "English";

export type PublicationLanguageHint = { part: "title" | "body"; line: number };

/** A script hint, never a language verdict or a publication refusal. Keep code,
 * URLs and quoted UI labels in their original language. Retain no matched text. */
export function publicationLanguageHints(part: PublicationLanguageHint["part"], text: string): PublicationLanguageHint[] {
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/g, value => value.replace(/[^\n]/g, " "));
  return prose.split(/\r?\n/).flatMap((line, index) => {
    const words = line.replace(/`[^`]*`|https?:\/\/\S+|\[[^\]]*\]\([^)]*\)|«[^»]*»|"[^"\n]*"|“[^”]*”/g, " ");
    const foreign = [...words].some(letter => /\p{Letter}/u.test(letter) && !/\p{Script=Latin}/u.test(letter));
    return foreign ? [{ part, line: index + 1 }] : [];
  }).slice(0, 20);
}

export function publicationSummary(summary: string): string {
  return publicationLanguageHints("body", summary).length
    ? "Implementation report omitted because its prose needs an English publication summary."
    : summary.trim() || "Implementation completed; see the committed changes and checks.";
}

/** Prefer the explicit title, then the board's English title. For other scripts
 * derive a title from the English report; old lanes without one get a stable
 * English fallback. This runs at publication, so the report is available. */
export function publicationTitle(task: string, summary = "", override?: string): string {
  const firstLine = (value: string) => value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
  if (override?.trim()) return override.trim();
  const board = firstLine(task);
  if (board && !publicationLanguageHints("title", board).length) return board.slice(0, 120);
  const report = firstLine(summary).replace(/^\s*(?:#+|[-*])\s+/, "");
  return report && !publicationLanguageHints("title", report).length ? report.slice(0, 120) : "Implement project changes";
}
