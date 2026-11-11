import { expect, test } from "bun:test";
import { buildLessonIndex, foldLessonWord, lessonPatternsIn, TEXT_WORD_CHARACTER } from "./lessonMatcher";
import { lessonPattern } from "./roleConsolidate";

let seed = 11;
/** A small deterministic generator (mulberry32). */
const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
const LATIN = "keep read check verify stored ledger revision before after shared write guidance scope reader fixture evidence owner task receipt Kelvin süss MASSE strasse fiscal sigma".split(" ");
const CYRILLIC = "перевір читай збережи журнал ревізію перед після спільний запис настанову область читач доказ власник задача квитанція операція стадія проєкт правило історія ЇЖАК їжак".split(" ");
const GREEK = "οδός ΟΔΟΣ σοφός λόγος Λόγος θάλασσα μέρος και τηι θεαι δημωι ΑΙ".split(" ");
const WORDS = [...LATIN, ...CYRILLIC, ...GREEK];
const sentence = (count: number) => Array.from({ length: count }, () => pick(WORDS)).join(" ");
/** The same lesson as other text writes it: case, the letters the engine
 * folds together, and whatever stands between words. */
function rewritten(text: string): string {
  const swaps: Record<string, string> = { s: "ſ", k: "K", "σ": "ς", "ς": "Σ", "ß": "ẞ", "μ": "µ", "в": "ᲀ", "ι": "\u0345", "Ι": "\u0345" };
  return text.split(" ").map(word => {
    const mode = Math.floor(random() * 4);
    const cased = mode === 0 ? word.toUpperCase() : mode === 1 ? word.toLowerCase() : mode === 2 ? word[0]!.toUpperCase() + word.slice(1) : word;
    return random() < 0.3 ? [...cased].map(letter => swaps[letter] && random() < 0.5 ? swaps[letter] : letter).join("") : cased;
  }).join(pick([" ", "  ", "\n", ", ", " — ", "\t", ".\n> "]));
}
const lessons = [...new Set([
  ...Array.from({ length: 300 }, () => sentence(3 + Math.floor(random() * 10))),
  "ab-cd ef", "x.y", "Z9", "ок", "süss", "a b", "----", "ab\u0345cd", "проєкт ι",
])].sort((a, b) => b.length - a.length);
const reference = lessons.flatMap(text => { const pattern = lessonPattern(text); return pattern ? [{ text, pattern }] : []; });
const index = buildLessonIndex(lessons);

test("every lesson whose pattern matches a text is among that text's patterns", () => {
  let matched = 0;
  for (let round = 0; round < 400; round++) {
    const parts = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
      const kind = random();
      const lesson = pick(reference).text;
      // A lesson as written, rewritten, with a word dropped, glued to a letter, or plain prose.
      return kind < 0.25 ? lesson : kind < 0.6 ? rewritten(lesson) : kind < 0.75 ? lesson.split(" ").slice(1).join(" ") : kind < 0.85 ? `x${lesson}y` : sentence(12);
    });
    const text = parts.join(pick([" ", "\n", "; ", " | "]));
    const offered = new Set(lessonPatternsIn(index, text).map(pattern => pattern.source));
    for (const { pattern } of reference) {
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      matched++;
      expect(offered.has(pattern.source)).toBe(true);
    }
  }
  expect(matched).toBeGreaterThan(500);
});

test("patterns come longest lesson first and only for lessons whose words are all present", () => {
  const few = buildLessonIndex(["keep the stored ledger readable", "stored ledger", "ledger"]);
  expect(lessonPatternsIn(few, "The Stored  LEDGER.").map(pattern => pattern.source)).toEqual([lessonPattern("stored ledger")!.source, lessonPattern("ledger")!.source]);
  expect(lessonPatternsIn(few, "nothing of the kind")).toEqual([]);
  expect(lessonPatternsIn(few, "ledgers and ledgerless")).toEqual([]);
  // Every word of the longest lesson is there, but not one after another.
  expect(lessonPatternsIn(few, "readable ledger: keep the stored copy").map(pattern => pattern.source)).toEqual([lessonPattern("ledger")!.source]);
  expect(lessonPatternsIn(few, "")).toEqual([]);
});

/** Every pair of characters the engine treats as equal under `iu` where the
 * first is a letter, digit or mark, found by the engine itself: the class of a
 * block of such characters picks out of the whole code space everything equal
 * to one of them, and the class of each one picks its own out of that. */
let equalPairs: [string, string][] | undefined;
const codeSpace = () => { const all: string[] = []; for (let code = 0; code <= 0x10FFFF; code++) if (code < 0xD800 || code > 0xDFFF) all.push(String.fromCodePoint(code)); return all; };
function equalUnderIu(): [string, string][] {
  if (equalPairs) return equalPairs;
  const everything = codeSpace(), space = everything.join("");
  const sources = everything.filter(character => /[\p{L}\p{N}\p{M}]/u.test(character));
  const escape = (character: string) => character.replace(/[\]\\^-]/g, "\\$&");
  equalPairs = [];
  for (let start = 0; start < sources.length; start += 4096) {
    const block = sources.slice(start, start + 4096);
    const near = space.match(new RegExp(`[${block.map(escape).join("")}]`, "giu"))!.join("");
    for (const a of block) for (const b of near.match(new RegExp(`[${escape(a)}]`, "giu"))!) if (b !== a) equalPairs.push([a, b]);
  }
  return equalPairs;
}
const hex = (character: string) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

test("characters the engine treats as equal without regard to case fold to one string", () => {
  const pairs = equalUnderIu();
  expect(pairs.length).toBeGreaterThan(2500);
  expect(pairs.filter(([a, b]) => foldLessonWord(a) !== foldLessonWord(b)).map(([a, b]) => `${hex(a)} ${hex(b)}`)).toEqual([]);
  for (const [a, b] of [["ſ", "S"], ["\u212A", "k"], ["ς", "Σ"], ["µ", "Μ"], ["ẞ", "ß"], ["ᲀ", "В"], ["ϐ", "Β"], ["\u0345", "Ι"], ["\u0345", "ι"]]) {
    expect(pairs).toContainEqual([a!, b!]);
    expect(foldLessonWord(a!)).toBe(foldLessonWord(b!));
  }
}, 60_000);

test("characters equal under `iu` have the same membership in the class that splits text into words", () => {
  expect(equalUnderIu().filter(([a, b]) => TEXT_WORD_CHARACTER.test(a) !== TEXT_WORD_CHARACTER.test(b)).map(([a, b]) => `${hex(a)} ${hex(b)}`)).toEqual([]);
  // The text is split where a pattern's `[\p{L}\p{N}]` and `[^\p{L}\p{N}]` split it under `iu`.
  const space = codeSpace().join("");
  const words = space.match(new RegExp(TEXT_WORD_CHARACTER.source, "gu"))!.join("");
  expect(space.match(/[\p{L}\p{N}]/giu)!.join("")).toBe(words);
  expect(space.replace(/[^\p{L}\p{N}]/giu, "")).toBe(words);
}, 60_000);

test("a lesson and a text that meet only through U+0345 find each other", () => {
  for (const [lesson, text] of [
    ["ab\u0345cd", "ABΙCD"],
    ["Use the ΑΙ helper for every stored ledger", "use the α\u0345 helper for every stored ledger"],
    ["τηι θεαι και τωι δημωι", "τῃ θεᾳ και τῳ δημῳ".normalize("NFD")],
    ["проєкт ι", "проєкт \u0345"],
  ] as const) {
    const pattern = lessonPattern(lesson)!;
    expect(pattern.test(text)).toBe(true);
    expect(lessonPatternsIn(buildLessonIndex([lesson]), text).map(offered => offered.source)).toEqual([pattern.source]);
  }
});

test("a lesson too long for one pattern is counted, and the rest still match", () => {
  const long = Array.from({ length: 8000 }, (_, i) => `w${i}`).join(" ");
  const built = buildLessonIndex([long, "stored ledger"]);
  expect(built.skipped).toBe(1);
  expect(lessonPatternsIn(built, "a stored ledger")).toHaveLength(1);
});
