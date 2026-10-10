import { lessonPattern } from "@/lib/memory/roleConsolidate";
import { hardenedRedact } from "@/lib/view/compactText";

/*
 * What a public report may not carry (docs/design/orchestrator-reports.md §3.7,
 * §5.5).
 *
 * A manager report can be posted to a Telegram group anyone may read, and the
 * bridge copy is the same text, so every summary, item and task title passes
 * through here. The answer is the list of CLASSES found, never the matched
 * text: the caller drops the whole item and warns the seat by class, so the
 * value is never repeated anywhere.
 *
 * Pure: the names it looks for arrive as a deny list the caller reads at call
 * time. Hiding an item by mistake costs less than posting a private one, so
 * the patterns lean towards finding too much. Quotes, and people's names
 * outside the known lists, cannot be recognized reliably; the mandate carries
 * that part.
 */

export type PrivateClass =
  | "path"
  | "url"
  | "domain"
  | "port"
  | "ip"
  | "email"
  | "phone"
  | "id"
  | "usage"
  | "account"
  | "person"
  | "project"
  | "host"
  | "secret"
  | "lesson";

const CLASS_LABELS: Record<PrivateClass, string> = {
  path: "a local path",
  url: "a URL",
  domain: "a domain",
  port: "a port",
  ip: "an IP address",
  email: "an email address",
  phone: "a phone number",
  id: "a conversation, deployment, card or pipeline id",
  usage: "a usage limit",
  account: "an account name",
  person: "a person's name",
  project: "another project",
  host: "a host name",
  secret: "a secret",
  lesson: "a learned rule",
};

export function privateClassLabel(value: PrivateClass): string {
  return CLASS_LABELS[value];
}

export interface PublicDenyList {
  /** Account ids and labels of every engine the Viewer knows. */
  accounts: readonly string[];
  /** People the bot has seen in its chats: display names and handles. */
  people: readonly string[];
  /** The OS user name, the home directory's name and the machine's host names. */
  local: readonly string[];
  /** Other projects: their `owner/repo` and their repository or folder names. */
  projects: readonly { repository: string | null; names: readonly string[] }[];
  /** Role memory's stored rules and whys (src/lib/memory/roleStore.ts), which stay on this machine. */
  lessons?: readonly string[];
}

export const EMPTY_DENY_LIST: PublicDenyList = { accounts: [], people: [], local: [], projects: [] };

/** Whole-word names shorter than this, or in this list, are too ordinary to
    look for: "main" or "pro" in a sentence is almost never an account. */
const MIN_NAME_CHARS = 4;
const GENERIC_WORDS = new Set(["main", "default", "work", "personal", "team", "pro", "max", "plus"]);

/* Common top-level domains, deliberately without the ones that are also file
   extensions a report may name (`.md`, `.ts`, `.sh`, `.js`). */
const TLD = "(?:com|org|net|io|dev|app|ai|co|me|xyz|info|biz|cloud|site|online|tech|ua|ru|uk|de|eu|us|local|internal|lan|home|arpa|tv|gg|so|to|run|page|link)";

const LIMIT_WORD = "(?<!\\p{L})(?:limit|quota|window|usage|weekly|ліміт\\p{L}*|квот\\p{L}*|вікн\\p{L}*|використ\\p{L}*|лимит\\p{L}*|окн\\p{L}*|использ\\p{L}*|тижн\\p{L}*|недел\\p{L}*)";

const PATTERNS: readonly [PrivateClass, RegExp][] = [
  ["url", /\b(?:https?|ftp|ssh|wss?):\/\/\S+/i],
  ["email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ["ip", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ["ip", /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i],
  /* The compressed forms: `fd00::1234`, `fe80::1:2`, `::1`. */
  ["ip", /(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/i],
  ["ip", /(?<![\w:])::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}(?![\w:])/i],
  ["host", /\b[\w-]+\.ts\.net\b/i],
  ["host", /\b[\w-]+\.local\b/i],
  ["host", /\blocalhost\b/i],
  ["domain", new RegExp(`\\b(?:[a-z0-9-]+\\.)+${TLD}\\b(?![.\\w])`, "i")],
  ["port", /(?<!\p{L})(?:port|порт[уіа]?|порта)(?:\s+|\s*[:=]\s*)\d{1,5}\b/iu],
  /* A path starts a token: `/x/y`, `~/x`, `~user/x`, `$HOME/x`, `C:\x`. A repository-
     relative path (`src/lib/x.ts`) names nothing about this machine. */
  /* A shell tilde prefix ends at its first slash. NSS user names can contain
     combining marks and punctuation; Markdown can surround the prefix. */
  ["path", /(?:^|[\s[(«"'`=:>*_])(?:~[^\s/]*\/|\$HOME\b|\$\{HOME\})/u],
  /* A complete shell home expression needs no slash. Keep approximate
     numbers and Markdown strike-through readable. */
  ["path", /(?:^|[\s[(«“‹"'`=:>*_])~(?!~)(?:[+-]|[\p{L}\p{M}_][\p{L}\p{M}\p{N}_.+-]*)?(?=$|[\s/)\]»”›"'`,.;:!?*_])/u],
  /* Folder names are letters of any script, so `\w` would miss most of them,
     and may hold spaces (`/My data/notes.txt`), written or shell-escaped. A
     space-separated run counts only once a later slash closes the folder. */
  ["path", /(?:^|[\s(«"'`=])\/(?:[\p{L}\p{N}_.@-]+(?:(?: |\\ )[\p{L}\p{N}_.@-]+)*\/)+[\p{L}\p{N}_.@-]*/u],
  ["path", /(?:^|[\s(«"'`=])\/(?:home|root|Users|tmp|var|etc|opt|usr|mnt|srv|proc|run|private)\b/],
  /* A drive path, with either slash: `C:\x`, `C:/x`. A scheme (`ftp://`) has
     more than one letter before its colon and two slashes after it. */
  ["path", /(?<![\p{L}\p{N}_])[a-z]:(?:\\|\/(?!\/))[^\s\\/]/iu],
  ["phone", /\+\d{1,3}[\s-]?\(?\d{2,4}\)?(?:[\s-]?\d{2,4}){2,4}\b/],
  ["id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  /* Delegatus's own tool names share the prefix and name nothing private. */
  ["id", /\bconversation_(?!(?:action|messages|migration|deliverability)\b)[\w-]+/i],
  ["id", /\b(?:rpt|rsg|dep|task|card|pipeline)_(?!action\b)[0-9a-z]{6,}\b/i],
  /* A share or an amount next to the words for a limit, in English, Ukrainian
     and Russian. `\b` and `\w` are ASCII-only, so the Cyrillic words are
     bounded by letter classes instead. */
  ["usage", new RegExp(`\\d+(?:[.,]\\d+)?\\s*%[^.;\\n]{0,40}${LIMIT_WORD}`, "iu")],
  ["usage", new RegExp(`${LIMIT_WORD}[^.;\\n]{0,40}?\\d+(?:[.,]\\d+)?\\s*%`, "iu")],
  ["usage", /(?:\$|€|₴)\s?\d+(?:[.,]\d+)?[^.;\n]{0,30}(?<!\p{L})(?:plan|tier|subscription|month|план\p{L}*|підписк\p{L}*|подписк\p{L}*|місяц\p{L}*|месяц\p{L}*)/iu],
  ["usage", /\b(?:max|pro|plus|team|enterprise)\s+(?:plan|tier|20x|5x)\b/i],
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${name.split(/\s+/u).map(escape).join("\\s+")}(?![\\p{L}\\p{M}\\p{N}_])`, "iu");
}

function usableName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= MIN_NAME_CHARS && !GENERIC_WORDS.has(trimmed.toLowerCase());
}

/** A project name is looked for only in repository form: with `-`, `_`, `.`
    or a digit in it. A project called `tools` must not drop every sentence
    that says "tools". */
function repositoryShaped(name: string): boolean {
  return /[-_.\d]/.test(name);
}

export interface PrivateMatch {
  class: PrivateClass;
  start: number;
  end: number;
}

/** Shared pattern occurrences. Issue reports use these as advisory pointers.
    Manager reports retain their existing class-based filtering policy. */
export function privateMatches(text: string, deny: PublicDenyList = EMPTY_DENY_LIST): PrivateMatch[] {
  const found: PrivateMatch[] = [];
  const scan = (kind: PrivateClass, pattern: RegExp) => {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"))) {
      found.push({ class: kind, start: match.index, end: match.index + match[0].length });
    }
  };
  const redacted = hardenedRedact(text);
  if (redacted !== text) {
    let start = 0;
    while (text[start] === redacted[start] && start < text.length) start += 1;
    let tail = 0;
    while (tail < text.length - start && tail < redacted.length - start
      && text[text.length - 1 - tail] === redacted[redacted.length - 1 - tail]) tail += 1;
    found.push({ class: "secret", start, end: text.length - tail });
  }
  for (const [kind, pattern] of PATTERNS) scan(kind, pattern);
  scan("port", /(?:\blocalhost|\b[\w-]+\.[\w.-]+|\b\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}\b/i);
  const names = (kind: PrivateClass, values: readonly string[]) => {
    for (const name of values) if (usableName(name)) scan(kind, wholeWord(name.trim()));
  };
  names("account", deny.accounts);
  names("person", deny.people);
  names("host", deny.local);
  for (const project of deny.projects) {
    if (project.repository?.includes("/")) scan("project", new RegExp(escape(project.repository), "i"));
    names("project", project.names.filter(repositoryShaped));
  }
  for (const lesson of deny.lessons ?? []) {
    const pattern = lessonPattern(lesson);
    if (pattern) scan("lesson", pattern);
  }
  return found;
}

/** Every private class found in `text`, each once, in a stable order. */
export function privateClasses(text: string, deny: PublicDenyList = EMPTY_DENY_LIST): PrivateClass[] {
  return [...new Set(privateMatches(text, deny).map((match) => match.class))];
}
