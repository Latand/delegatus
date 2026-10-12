/**
 * The name side of «Створити клона» (docs/research/celestia-clone-creation.md):
 * a random name for the 🎲 button, the Telegram @username derived from a name,
 * and the checks Telegram's `t.me/newbot` link and the relay's
 * `POST /clone-requests` hold the two to. Shared by the form and the route,
 * so it imports nothing from the server.
 */

/** The relay descriptor's feature that shows the block (dark until the relay lists it). */
export const CLONE_CREATE_FEATURE = "clone_create";
export const offersCloneCreate = (relay: { features?: string[] }) =>
  relay.features?.includes(CLONE_CREATE_FEATURE) === true;

/** Telegram's bot username: 5–32 characters, a Latin letter first, ending in «bot». */
export const CLONE_USERNAME_MAX = 32;
const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*bot$/i;
export const CLONE_NAME_MAX = 64;

export function validCloneUsername(value: string): boolean {
  return value.length >= 5 && value.length <= CLONE_USERNAME_MAX && USERNAME_PATTERN.test(value);
}

/** A bot's display name: 1–64 code points once trimmed, no control characters. */
export function validCloneName(value: string): boolean {
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= CLONE_NAME_MAX && !/[\x00-\x1f\x7f]/.test(trimmed);
}

/* Ukrainian by the national transliteration table (2010), with the Russian
   letters a name may also carry. A letter whose Latin form changes at the
   start of a word lists both. */
const LETTERS: Record<string, string | [initial: string, inner: string]> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: ["ye", "ie"], ж: "zh", з: "z",
  и: "y", і: "i", ї: ["yi", "i"], й: ["y", "i"], к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ь: "", ю: ["yu", "iu"], я: ["ya", "ia"], ё: "e", ы: "y", э: "e", ъ: "",
  "'": "", "’": "", "ʼ": "",
};

export function transliterate(value: string): string {
  let out = "";
  let wordStart = true;
  for (const char of value.normalize("NFC")) {
    const lower = char.toLowerCase();
    const mapped = LETTERS[lower];
    if (mapped !== undefined) {
      out += Array.isArray(mapped) ? mapped[wordStart ? 0 : 1] : mapped;
      // An apostrophe sits inside a word, so the letter after it is not initial.
      wordStart = false;
    } else {
      const latin = lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += latin;
      wordStart = !/[\p{L}\p{N}]/u.test(char);
    }
  }
  return out;
}

/**
 * The @username a name suggests: transliterated, lower case, words joined by
 * «_», a letter first, and «bot» at the end, cut to Telegram's 32 characters.
 * «Нічна Сова» → «nichna_sova_bot».
 */
export function deriveCloneUsername(name: string): string {
  let base = transliterate(name)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "");
  if (base.endsWith("bot")) base = base.slice(0, -3).replace(/_+$/, "");
  if (!base) base = "clone";
  base = base.slice(0, CLONE_USERNAME_MAX - 4).replace(/_+$/, "");
  return `${base}_bot`;
}

type Gender = "m" | "f";
const UK_ADJECTIVES: Record<Gender, string>[] = [
  { m: "Нічний", f: "Нічна" }, { m: "Тихий", f: "Тиха" }, { m: "Мудрий", f: "Мудра" },
  { m: "Срібний", f: "Срібна" }, { m: "Ранковий", f: "Ранкова" }, { m: "Лагідний", f: "Лагідна" },
  { m: "Зоряний", f: "Зоряна" }, { m: "Веселий", f: "Весела" }, { m: "Уважний", f: "Уважна" },
];
const UK_NOUNS: [string, Gender][] = [
  ["Сова", "f"], ["Лис", "m"], ["Кит", "m"], ["Ластівка", "f"], ["Їжак", "m"],
  ["Рись", "f"], ["Ворон", "m"], ["Бджола", "f"], ["Вовк", "m"], ["Чапля", "f"],
];
const EN_ADJECTIVES = ["Night", "Quiet", "Wise", "Silver", "Morning", "Gentle", "Starry", "Cheerful", "Watchful"];
const EN_NOUNS = ["Owl", "Fox", "Whale", "Swallow", "Hedgehog", "Lynx", "Raven", "Bee", "Wolf", "Heron"];

/** Two words in the interface language, never the one the field already holds. */
export function randomCloneName(locale: "uk" | "en", current = "", random: () => number = Math.random): string {
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length) % items.length]!;
  for (let attempt = 0; attempt < 8; attempt++) {
    let name: string;
    if (locale === "uk") {
      const [noun, gender] = pick(UK_NOUNS);
      name = `${pick(UK_ADJECTIVES)[gender]} ${noun}`;
    } else name = `${pick(EN_ADJECTIVES)} ${pick(EN_NOUNS)}`;
    if (name !== current.trim()) return name;
  }
  return locale === "uk" ? "Тихий Лис" : "Quiet Fox";
}

/** The link Telegram opens: `https://t.me/newbot/<manager>/<username>[?name=…]`, and nothing else. */
export function createUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "t.me" || url.hostname === "telegram.me") &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/newbot/")
    );
  } catch {
    return false;
  }
}

/** The prompt Celestia's generator gets for the four portraits. */
export function cloneAvatarPrompt(name: string): string {
  return `A friendly round profile picture for a Telegram bot named "${name.trim()}". No text, no letters.`;
}
