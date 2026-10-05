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
  | "secret";

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
  ["port", /(?:\blocalhost|\b[\w-]+\.[\w.-]+|\b\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/i],
  ["port", /(?<!\p{L})(?:port|порт[уіа]?|порта)\s+\d{2,5}\b/iu],
  /* A path starts a token: `/x/y`, `~/x`, `$HOME/x`, `C:\x`. A repository-
     relative path (`src/lib/x.ts`) names nothing about this machine. */
  ["path", /(?:^|[\s(«"'`=:])(?:~\/|\$HOME\b|\$\{HOME\})/],
  /* Folder names are letters of any script, so `\w` would miss most of them. */
  ["path", /(?:^|[\s(«"'`=])\/(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_.@-]*/u],
  ["path", /(?:^|[\s(«"'`=])\/(?:home|root|Users|tmp|var|etc|opt|usr|mnt|srv|proc|run|private)\b/],
  ["path", /\b[a-z]:\\[\w\\. -]+/i],
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

/*
 * The strict reading, for a text that goes to a public repository and can be
 * reworded by its author before anyone sees it (a Delegatus bug report,
 * #2518). A manager report drops an item it doubts and the operator loses a
 * line; a bug report refused in doubt costs its author one more wording. So
 * the strict reading keeps none of the allowances above:
 *
 *  - a domain is any dotted name ending in a top-level domain, country codes
 *    included (`buildbox.fr`). The two-letter endings that are source file
 *    extensions stay readable, or no report could name `bindings.ts`;
 *  - an id is also eight or more bare hex characters, whatever they are: a
 *    pipeline id is the first eight of a UUID, which can be all digits or all
 *    letters;
 *  - every known name counts, however short or ordinary, and a project's name
 *    in any form. `Delegatus` is the one name a report may carry.
 */
export interface PrivateClassOptions {
  strict?: boolean;
}

const STRICT_TLD = new Set([
  ...TLD.slice(3, -1).split("|"),
  "edu", "gov", "mil", "int", "mobi", "shop", "store", "blog", "club", "news", "wiki", "host",
]);
const SOURCE_EXTENSIONS = new Set(["ts", "js", "md", "sh", "py", "rs", "go", "rb", "cs", "cc"]);
const DOTTED_NAME = /(?<![\p{L}\p{N}_-])(?:[a-z0-9-]+\.)+([a-z]{2,24})(?![\p{L}\p{N}_-])/giu;
const BARE_HEX_ID = /(?<![\p{L}\p{N}_])[0-9a-f]{8,64}(?![\p{L}\p{N}_])/iu;
const STRICT_ALLOWED_NAMES = new Set(["delegatus"]);

function strictDomain(text: string): boolean {
  for (const match of text.matchAll(DOTTED_NAME)) {
    const ending = match[1].toLowerCase();
    if (STRICT_TLD.has(ending) || (ending.length === 2 && !SOURCE_EXTENSIONS.has(ending))) return true;
  }
  return false;
}

function strictName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 2 && !STRICT_ALLOWED_NAMES.has(trimmed.toLowerCase());
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, "iu");
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

function namesHit(text: string, names: readonly string[], usable: (name: string) => boolean = usableName): boolean {
  return names.some((name) => usable(name) && wholeWord(name.trim()).test(text));
}

/** Every private class found in `text`, each once, in a stable order. */
export function privateClasses(text: string, deny: PublicDenyList = EMPTY_DENY_LIST, options: PrivateClassOptions = {}): PrivateClass[] {
  if (!text) return [];
  const found = new Set<PrivateClass>();
  if (hardenedRedact(text) !== text) found.add("secret");
  for (const [kind, pattern] of PATTERNS) {
    if (!found.has(kind) && pattern.test(text)) found.add(kind);
  }
  const usable = options.strict ? strictName : usableName;
  if (options.strict) {
    if (strictDomain(text)) found.add("domain");
    if (BARE_HEX_ID.test(text)) found.add("id");
  }
  if (namesHit(text, deny.accounts, usable)) found.add("account");
  if (namesHit(text, deny.people, usable)) found.add("person");
  if (namesHit(text, deny.local, usable)) found.add("host");
  const lower = text.toLowerCase();
  for (const project of deny.projects) {
    if (project.repository && project.repository.includes("/") && lower.includes(project.repository.toLowerCase())) {
      found.add("project");
      break;
    }
    if (namesHit(text, options.strict ? project.names : project.names.filter(repositoryShaped), usable)) {
      found.add("project");
      break;
    }
  }
  return [...found];
}
