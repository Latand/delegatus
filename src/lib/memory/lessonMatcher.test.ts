import { expect, test } from "bun:test";
import { buildLessonIndex, foldLessonWord, lessonPatternsIn } from "./lessonMatcher";
import { lessonPattern } from "./roleConsolidate";

let seed = 11;
/** A small deterministic generator (mulberry32). */
const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
const LATIN = "keep read check verify stored ledger revision before after shared write guidance scope reader fixture evidence owner task receipt Kelvin süss MASSE strasse fiscal sigma".split(" ");
const CYRILLIC = "перевір читай збережи журнал ревізію перед після спільний запис настанову область читач доказ власник задача квитанція операція стадія проєкт правило історія ЇЖАК їжак".split(" ");
const GREEK = "οδός ΟΔΟΣ σοφός λόγος Λόγος θάλασσα μέρος".split(" ");
const WORDS = [...LATIN, ...CYRILLIC, ...GREEK];
const sentence = (count: number) => Array.from({ length: count }, () => pick(WORDS)).join(" ");
/** The same lesson as other text writes it: case, the letters the engine
 * folds together, and whatever stands between words. */
function rewritten(text: string): string {
  const swaps: Record<string, string> = { s: "ſ", k: "K", "σ": "ς", "ς": "Σ", "ß": "ẞ", "μ": "µ", "в": "ᲀ" };
  return text.split(" ").map(word => {
    const mode = Math.floor(random() * 4);
    const cased = mode === 0 ? word.toUpperCase() : mode === 1 ? word.toLowerCase() : mode === 2 ? word[0]!.toUpperCase() + word.slice(1) : word;
    return random() < 0.3 ? [...cased].map(letter => swaps[letter] && random() < 0.5 ? swaps[letter] : letter).join("") : cased;
  }).join(pick([" ", "  ", "\n", ", ", " — ", "\t", ".\n> "]));
}
const lessons = [...new Set([
  ...Array.from({ length: 300 }, () => sentence(3 + Math.floor(random() * 10))),
  "ab-cd ef", "x.y", "Z9", "ок", "süss", "a b", "----",
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

test("words the engine treats as equal without regard to case fold to one string", () => {
  const letter = /[\p{L}\p{N}]/u;
  let pairs = 0;
  for (let code = 0; code <= 0x1FFFF; code++) {
    if (code >= 0xD800 && code <= 0xDFFF) continue;
    const a = String.fromCodePoint(code);
    if (!letter.test(a)) continue;
    const others = new Set<string>();
    for (const variant of [a.toLowerCase(), a.toUpperCase(), a.toLowerCase().toUpperCase(), a.toUpperCase().toLowerCase()]) for (const each of variant) others.add(each);
    for (const b of others) {
      if (b === a || !letter.test(b)) continue;
      if (!new RegExp(`^${b}$`, "iu").test(a)) continue;
      pairs++;
      if (foldLessonWord(a) !== foldLessonWord(b)) throw new Error(`U+${code.toString(16)} and U+${b.codePointAt(0)!.toString(16)} match and fold apart`);
    }
  }
  expect(pairs).toBeGreaterThan(2500);
  for (const [a, b] of [["ſ", "S"], ["K", "k"], ["ς", "Σ"], ["µ", "Μ"], ["ẞ", "ß"], ["ᲀ", "В"], ["ϐ", "Β"], ["ͅ", "Ι"]]) {
    expect(new RegExp(`^${b}$`, "iu").test(a!)).toBe(true);
    expect(foldLessonWord(a!)).toBe(foldLessonWord(b!));
  }
});

test("a lesson too long for one pattern is counted, and the rest still match", () => {
  const long = Array.from({ length: 8000 }, (_, i) => `w${i}`).join(" ");
  const built = buildLessonIndex([long, "stored ledger"]);
  expect(built.skipped).toBe(1);
  expect(lessonPatternsIn(built, "a stored ledger")).toHaveLength(1);
});
