/**
 * Which language a piece of prose is written in, for the warnings that tell an
 * agent its report or task text is not in the operator's interface language
 * (docs/design/orchestrator-reports.md §1.1, §5.2).
 *
 * Pure and deliberately coarse. What is not prose is removed first: code spans,
 * links, `#123` references, hex ids and quoted UI labels, which keep their own
 * language whatever the sentence around them is written in. Then the Latin and
 * Cyrillic letters are counted. Ukrainian and Russian share most of the
 * alphabet, so they are told apart only by the letters one of them has and the
 * other lacks. Anything short, mixed or undecidable answers null, which says
 * nothing and warns about nothing.
 */

export type ProseLanguage = "en" | "uk" | "ru";

/** Fewer letters than this say nothing about the language. */
export const PROSE_LANGUAGE_MIN_LETTERS = 40;
/** Share of one script needed to call the text that script's language. */
const DOMINANT_SHARE = 0.6;

const UKRAINIAN_ONLY = /[іїєґ]/giu;
const RUSSIAN_ONLY = /[ыэъё]/giu;

function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/#\d+/g, " ")
    .replace(/\b[0-9a-f]{7,64}\b/gi, " ")
    /* Quoted UI labels keep the language of the interface they quote. */
    .replace(/«[^»]{0,80}»/g, " ")
    .replace(/"[^"]{0,80}"/g, " ")
    .replace(/“[^”]{0,80}”/g, " ");
}

export function proseLanguage(text: string | null | undefined): ProseLanguage | null {
  if (!text) return null;
  const prose = stripNonProse(text);
  const latin = prose.match(/[a-z]/gi)?.length ?? 0;
  const cyrillic = prose.match(/[Ѐ-ӿ]/g)?.length ?? 0;
  const letters = latin + cyrillic;
  if (letters < PROSE_LANGUAGE_MIN_LETTERS) return null;
  if (latin / letters >= DOMINANT_SHARE) return "en";
  if (cyrillic / letters < DOMINANT_SHARE) return null;
  const ukrainian = prose.match(UKRAINIAN_ONLY)?.length ?? 0;
  const russian = prose.match(RUSSIAN_ONLY)?.length ?? 0;
  if (ukrainian > russian) return "uk";
  if (russian > ukrainian) return "ru";
  return null;
}

const UK_SPEECH_WORDS = new Set(["й", "з", "із", "зі", "що", "щоб", "як", "але", "або", "вже", "тепер", "зараз", "якщо", "лише", "також", "немає"]);
const RU_SPEECH_WORDS = new Set(["и", "с", "со", "что", "чтобы", "как", "но", "или", "уже", "теперь", "сейчас", "если", "только", "тоже", "нет"]);

/** Message-level speech choice. Ignore code-shaped tokens and allow borrowed
 * English terms in Cyrillic prose. Unmarked Cyrillic ties use Ukrainian. */
export function speechLanguage(text: string, fallback: ProseLanguage = "uk"): ProseLanguage {
  let cyrillic = 0;
  let latin = 0;
  let uk = 0;
  let ru = 0;
  for (const token of stripNonProse(text).split(/\s+/u)) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    /* Paths and filename-like tokens describe the text; they are not spoken
       language evidence. Filter them before either script gets a vote. */
    if (!word || /[\\/_\d]/u.test(word) || /^[\p{L}\p{N}-]+\.[a-z\d]{1,8}$/iu.test(word)) continue;
    if (/\p{Script=Cyrillic}/u.test(word)) {
      cyrillic += 1;
      const lower = word.toLowerCase();
      if (/[іїєґ]/u.test(lower) || /\p{Script=Cyrillic}['ʼ’]\p{Script=Cyrillic}/u.test(lower) || UK_SPEECH_WORDS.has(lower)) uk += 1;
      else if (/[ыэъё]/u.test(lower) || RU_SPEECH_WORDS.has(lower)) ru += 1;
    } else if (/^\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*$/u.test(word)
      && !(word.length >= 2 && word === word.toUpperCase())
      && !/\p{Ll}\p{Lu}/u.test(word)) latin += 1;
  }
  if (!cyrillic && !latin) return fallback;
  if (cyrillic && 2 * cyrillic >= latin) return ru > uk ? "ru" : "uk";
  return "en";
}

const LANGUAGE_NAMES: Record<ProseLanguage, string> = { en: "English", uk: "Ukrainian", ru: "Russian" };

export function languageName(language: ProseLanguage): string {
  return LANGUAGE_NAMES[language];
}

/**
 * The warning an agent gets when its text reads as another language than the
 * operator's interface, or null when it matches, cannot be classified, or the
 * interface language is not known yet.
 */
export function languageMismatchWarning(
  subject: string,
  text: string | null | undefined,
  operatorLocale: "en" | "uk" | null,
): string | null {
  if (!operatorLocale) return null;
  const language = proseLanguage(text);
  if (!language || language === operatorLocale) return null;
  return `This ${subject} reads as ${languageName(language)}; the operator's interface is ${languageName(operatorLocale)}. Write it in ${languageName(operatorLocale)}.`;
}
