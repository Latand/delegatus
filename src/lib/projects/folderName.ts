/*
 * The folder a project named by a person gets (docs/design/create-project-by-name.md §3).
 * Pure and free of Node imports, so the form previews with the same function
 * the server creates with.
 */

/** Longest result; a collision suffix may add three more characters. */
export const FOLDER_NAME_MAX = 48;
const FOLDER_NAME_FALLBACK = "project";
/** Where a cut at a hyphen must still land after, so a long first word is not lost. */
const FOLDER_NAME_MIN_CUT = 24;

/* KMU 2010, the Ukrainian national table, plus the Russian-only letters. */
const TRANSLITERATION: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z",
  и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ю: "iu", я: "ia", ё: "yo", ы: "y", э: "e",
};
const WORD_START: Readonly<Record<string, string>> = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };
/* Written inside a word and silent in the folder name, so the letter after one
   of these is still in the middle of its word: п'ять is piat, never pyat. */
const DROPPED = new Set(["ь", "ъ", "'", "’", "ʼ"]);

/* Windows device names, and the container `worktreeFromNested` reads as a
   worktree layout: sessions in `<parent>/worktrees/<x>` would group under the
   parent folder. */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
  "worktrees",
]);

function transliterate(lowered: string): string {
  let result = "";
  let inWord = false;
  for (const character of lowered) {
    if (DROPPED.has(character)) continue;
    result += (!inWord && WORD_START[character]) || TRANSLITERATION[character] || character;
    inWord = /\p{L}/u.test(character);
  }
  return result;
}

function trimHyphens(value: string): string {
  return value.replace(/^-+|-+$/g, "");
}

/** A name in any language as one safe path segment: only `a-z`, `0-9` and `-`,
    so no dot files, no separators and nothing case-insensitive filesystems fold. */
export function folderName(name: string): string {
  const slug = trimHyphens(
    transliterate(name.normalize("NFKC").toLowerCase())
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-"),
  );
  let cut = slug;
  if (slug.length > FOLDER_NAME_MAX) {
    /* One past the limit, so a hyphen right after the 48th character keeps the whole word. */
    const hyphen = slug.slice(0, FOLDER_NAME_MAX + 1).lastIndexOf("-");
    cut = trimHyphens(slug.slice(0, hyphen > FOLDER_NAME_MIN_CUT ? hyphen : FOLDER_NAME_MAX));
  }
  if (!cut) return FOLDER_NAME_FALLBACK;
  return RESERVED.has(cut) ? `${cut}-${FOLDER_NAME_FALLBACK}` : cut;
}
