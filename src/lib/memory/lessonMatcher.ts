import { lessonPatternSource } from "./roleConsolidate";

/* Finding stored lessons in text without a compiled pattern per lesson.

   A lesson's pattern is its words in order, case-insensitively, with any
   punctuation or spacing between them. The engine compiles a case-insensitive
   Unicode pattern into a character class per letter outside ASCII, so a store
   of lessons in a non-Latin script cost gigabytes once its patterns ran, and
   matching took seconds per hundred kilobytes.

   A pattern can match only where the words of its lesson occur in the text
   one after another as whole words. This index answers that from the text's
   own words, and only the lessons that pass get their pattern compiled and
   run. The answer on any text is the one the patterns of all lessons would
   give. */

// Leave headroom under JSC's limit for one pattern.
export const LESSON_MATCHER_SOURCE_LIMIT = 32_000;
/** Compiled patterns kept between calls. */
const COMPILED_PATTERNS = 512;
const WORDS = /[\p{L}\p{N}]+/gu;

/** Two words the engine treats as equal under `iu` fold to the same string.
 * The fold may also join words the engine keeps apart; a lesson then reaches
 * its pattern, which decides. */
export const foldLessonWord = (word: string): string => word.toLowerCase().toUpperCase().toLowerCase();

interface IndexedLesson {
  source: string;
  /** The lesson's folded words in order. */
  words: string[];
  /** Where in `words` its rarest word stands. */
  rarest: number;
  unusable?: true;
}
export interface LessonIndex {
  /** Longest text first: the order in which equal starts are decided. */
  lessons: IndexedLesson[];
  /** Lessons by their rarest word. */
  byWord: Map<string, number[]>;
  /** Lessons with no word at all: always candidates. */
  wordless: number[];
  /** Lesson texts no pattern could be built for. */
  skipped: number;
  compiled: Map<number, RegExp>;
}

/** `texts` longest first, as the stored lesson texts are listed. */
export function buildLessonIndex(texts: readonly string[]): LessonIndex {
  const index: LessonIndex = { lessons: [], byWord: new Map(), wordless: [], skipped: 0, compiled: new Map() };
  const frequency = new Map<string, number>();
  for (const text of texts) {
    const source = lessonPatternSource(text);
    if (!source) continue;
    if (source.length + 4 > LESSON_MATCHER_SOURCE_LIMIT) { index.skipped += 1; continue; }
    const words = (text.normalize("NFKC").match(WORDS) ?? []).map(foldLessonWord);
    index.lessons.push({ source, words, rarest: 0 });
    for (const word of new Set(words)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  index.lessons.forEach((lesson, position) => {
    if (!lesson.words.length) { index.wordless.push(position); return; }
    // The lesson is filed under its rarest word: few texts reach it at all.
    lesson.words.forEach((word, at) => { if (frequency.get(word)! < frequency.get(lesson.words[lesson.rarest]!)!) lesson.rarest = at; });
    const rarest = lesson.words[lesson.rarest]!;
    const filed = index.byWord.get(rarest);
    if (filed) filed.push(position); else index.byWord.set(rarest, [position]);
  });
  return index;
}

function pattern(index: LessonIndex, position: number): RegExp | null {
  const held = index.compiled.get(position);
  if (held) { index.compiled.delete(position); index.compiled.set(position, held); return held; }
  const lesson = index.lessons[position]!;
  if (lesson.unusable) return null;
  let compiled: RegExp;
  try { compiled = new RegExp(lesson.source, "giu"); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // The engine refused this one lesson. Count it: a caller that needs every lesson refuses.
    lesson.unusable = true; index.skipped += 1;
    console.warn("stored-lesson matcher skipped 1 oversized or uncompilable lesson text(s)");
    return null;
  }
  index.compiled.set(position, compiled);
  while (index.compiled.size > COMPILED_PATTERNS) index.compiled.delete(index.compiled.keys().next().value!);
  return compiled;
}

/** The patterns of every lesson whose words stand in `text` one after
 * another, longest lesson first. No other lesson's pattern can match there. */
export function lessonPatternsIn(index: LessonIndex, text: string): RegExp[] {
  if (!text || !index.lessons.length) return [];
  const words = (text.match(WORDS) ?? []).map(foldLessonWord);
  const found = new Set<number>(index.wordless);
  words.forEach((word, at) => {
    for (const position of index.byWord.get(word) ?? []) {
      if (found.has(position)) continue;
      const lesson = index.lessons[position]!, start = at - lesson.rarest;
      if (start < 0 || start + lesson.words.length > words.length) continue;
      if (lesson.words.every((needed, offset) => words[start + offset] === needed)) found.add(position);
    }
  });
  const ordered = [...found].sort((a, b) => a - b);
  return ordered.flatMap(position => { const compiled = pattern(index, position); return compiled ? [compiled] : []; });
}
