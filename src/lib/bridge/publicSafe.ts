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
  ["host", /\b[\w-]+\.ts\.net\b/i],
  ["host", /\b[\w-]+\.local\b/i],
  ["host", /\blocalhost\b/i],
  ["domain", new RegExp(`\\b(?:[a-z0-9-]+\\.)+${TLD}\\b(?![.\\w])`, "i")],
  ["port", /(?:\blocalhost|\b[\w-]+\.[\w.-]+|\b\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/i],
  ["port", /(?<!\p{L})(?:port|порт[уіа]?|порта)\s+\d{2,5}\b/iu],
  /* A path starts a token: `/x/y`, `~/x`, `$HOME/x`, `C:\x`. A repository-
     relative path (`src/lib/x.ts`) names nothing about this machine. */
  ["path", /(?:^|[\s(«"'`=:])(?:~\/|\$HOME\b|\$\{HOME\})/],
  ["path", /(?:^|[\s(«"'`=])\/(?:[\w.@-]+\/)+[\w.@-]*/],
  ["path", /(?:^|[\s(«"'`=])\/(?:home|root|Users|tmp|var|etc|opt|usr|mnt|srv|proc|run|private)\b/],
  ["path", /\b[a-z]:\\[\w\\. -]+/i],
  ["phone", /\+\d{1,3}[\s-]?\(?\d{2,4}\)?(?:[\s-]?\d{2,4}){2,4}\b/],
  ["id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["id", /\bconversation_[\w-]+/i],
  ["id", /\b(?:rpt|rsg|dep|task|card|pipeline)_[0-9a-z]{6,}\b/i],
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

function namesHit(text: string, names: readonly string[]): boolean {
  return names.some((name) => usableName(name) && wholeWord(name.trim()).test(text));
}

/** Every private class found in `text`, each once, in a stable order. */
export function privateClasses(text: string, deny: PublicDenyList = EMPTY_DENY_LIST): PrivateClass[] {
  if (!text) return [];
  const found = new Set<PrivateClass>();
  if (hardenedRedact(text) !== text) found.add("secret");
  for (const [kind, pattern] of PATTERNS) {
    if (!found.has(kind) && pattern.test(text)) found.add(kind);
  }
  if (namesHit(text, deny.accounts)) found.add("account");
  if (namesHit(text, deny.people)) found.add("person");
  if (namesHit(text, deny.local)) found.add("host");
  const lower = text.toLowerCase();
  for (const project of deny.projects) {
    if (project.repository && project.repository.includes("/") && lower.includes(project.repository.toLowerCase())) {
      found.add("project");
      break;
    }
    if (namesHit(text, project.names.filter(repositoryShaped))) {
      found.add("project");
      break;
    }
  }
  return [...found];
}
