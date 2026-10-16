/*
 * The «Keys» section's vocabulary (docs/design/keys-settings.md §4, §7),
 * shared by the server catalog and the page: which keys there are, the
 * variable each one answers to, the masked form and the NAME=value lines a
 * move between machines carries. Nothing here touches a file or the network.
 */

export const KEY_IDS = ["openrouter", "openai", "elevenlabs", "soniox", "fishaudio", "telegram"] as const;
export type KeyId = typeof KEY_IDS[number];

/** Saved in Delegatus's own file; set by the variable, which wins; absent; or present but unreadable. */
export type KeySource = "file" | "env" | "missing" | "failed";

export interface KeyEntry {
  id: KeyId;
  /** The variable that wins over the file. The Telegram token has none and travels under this name. */
  variable: string;
  source: KeySource;
  /** The public prefix, bullets and the last four characters; only for the owner, null otherwise or when unset. */
  masked: string | null;
}

export interface KeysAnswer {
  keys: KeyEntry[];
  /** A staging Viewer shares production's files and refuses writes. */
  staging: boolean;
  /** May reveal, copy, export, import and replace: the local operator, or the owner of a team install. */
  owner: boolean;
}

export const KEY_VARIABLE: Record<KeyId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  soniox: "SONIOX_API_KEY",
  fishaudio: "FISH_AUDIO_API_KEY",
  telegram: "DELEGATUS_TELEGRAM_BOT_TOKEN",
};

/** Provider names are not translated; the Telegram bot's is (`keys.name.telegram`). */
export const KEY_PROVIDER_NAME: Record<Exclude<KeyId, "telegram">, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  soniox: "Soniox",
  fishaudio: "Fish Audio",
};

export function isKeyId(value: unknown): value is KeyId {
  return typeof value === "string" && (KEY_IDS as readonly string[]).includes(value);
}

const BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/;
/* Printable, no whitespace: what every provider prints and every reader trims to. */
const PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * Whether a value can be this key. Deliberately loose: every route that
 * wrote a key before accepted any one-line value, so only prefixes every
 * provider prints on every key are required. A shape check stricter than the
 * provider's own would refuse a key that works today.
 */
export function validKeyValue(id: KeyId, value: string): boolean {
  if (id === "telegram") return BOT_TOKEN.test(value);
  if (value.length < 16 || value.length > 4096 || !PRINTABLE.test(value)) return false;
  if (id === "openrouter") return value.startsWith("sk-or-");
  if (id === "openai") return value.startsWith("sk-");
  return true;
}

/** The part of a key its provider prints in the open: nothing for a key without one. */
function publicPrefix(id: KeyId, value: string): string {
  if (id === "telegram") { const colon = value.indexOf(":"); return colon > 0 ? value.slice(0, colon + 1) : ""; }
  for (const prefix of ["sk-or-v1-", "sk-or-", "sk-proj-", "sk-svcacct-", "sk-", "sk_"]) if (value.startsWith(prefix)) return prefix;
  return "";
}

/** «sk-or-v1-••••••••0000»: the public prefix, eight bullets, the last four characters. A short value shows no tail. */
export function maskKey(id: KeyId, value: string): string {
  const prefix = publicPrefix(id, value);
  const tail = value.length - prefix.length >= 12 ? value.slice(-4) : "";
  return `${prefix}${"•".repeat(8)}${tail}`;
}

/** The last four characters as a row shows them where the panel is narrow. */
export const maskedTail = (masked: string) => {
  const tail = masked.replace(/^.*•/u, "");
  return `••••${tail}`;
};

/* ---- NAME=value lines ---------------------------------------------------- */

export const IMPORT_TEXT_LIMIT = 64 * 1024;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/* An unknown name is echoed back, so only one shaped like an environment
   variable is: upper case, short words. A key pasted on the left of `=` (some
   are identifier-shaped, such as ElevenLabs' `sk_…`) is counted by its line. */
const echoableName = (name: string) => /^[A-Z][A-Z0-9_]{0,47}$/.test(name) && name.split("_").every((word) => word.length <= 20);

export interface ParsedKeyLines {
  /** Known names with their values, in catalog order; a repeated name keeps its last line. */
  entries: { id: KeyId; value: string }[];
  /** Names that are no key of the section, never their values. */
  unknown: string[];
  /** Numbers of lines that carry no NAME=, which may be a bare key: never their text. */
  unparsed: number[];
}

function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

/** Reads what «Copy all keys» writes, and the same lines as a shell or systemd environment file. */
export function parseKeyLines(text: string): ParsedKeyLines {
  const byVariable = new Map(KEY_IDS.map((id) => [KEY_VARIABLE[id], id] as const));
  const found = new Map<KeyId, string>();
  const unknown: string[] = [];
  const unparsed: number[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";
    /* A line whose left side is no variable name may be a key pasted alone: it is counted by its number only. */
    if (!NAME.test(name)) { unparsed.push(index + 1); continue; }
    const id = byVariable.get(name);
    if (!id) {
      if (!echoableName(name)) unparsed.push(index + 1);
      else if (!unknown.includes(name)) unknown.push(name);
      continue;
    }
    found.set(id, unquote(line.slice(eq + 1).trim()));
  }
  return { entries: KEY_IDS.filter((id) => found.has(id)).map((id) => ({ id, value: found.get(id)! })), unknown, unparsed };
}

/** The pasted lines as the page shows them: comments and names kept (without `export`), every value down to its last four characters. */
export function maskPastedLines(text: string): string[] {
  return text.replace(/\s+$/, "").split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return line;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,63})\s*=\s*(.*)$/.exec(line);
    const named = match && echoableName(match[1]) ? match : null;
    /* A line with an `=` that is no NAME=value shows no tail: its tail is the other side's, not a key's. */
    const value = named ? unquote(named[2]) : line.includes("=") ? "" : unquote(line);
    const masked = value.length > 8 ? `••••${value.slice(-4)}` : "••••";
    return named ? `${named[1]}=${masked}` : masked;
  });
}

export type ImportKind = "new" | "replaces" | "same" | "env" | "invalid";

/** One row of the import preview. It carries masked forms only, never a value. */
export interface ImportRow {
  id: KeyId;
  kind: ImportKind;
  /** The pasted key, masked; absent for an invalid one. */
  masked?: string;
  /** For `replaces`: the key saved here now, masked, or null when it could not be read. */
  was?: string | null;
}

export interface ImportPreview {
  rows: ImportRow[];
  unknown: string[];
  unparsed: number[];
}

/** What the operator confirmed per key: the kind the preview showed, and for a replacement the key it replaces. */
export type ImportConfirmation = Partial<Record<KeyId, { kind: "new" | "replaces"; was?: string | null }>>;

/** The header line of «Copy all keys»: a date and a count, no machine names. */
export function exportHeader(count: number, now: Date): string {
  return `# Delegatus keys · ${now.toISOString().slice(0, 10)} · ${count}`;
}
