/*
 * PROTOTYPE for docs/design/keys-settings.md, on this design lane's branch
 * only, never merged. The «Ключі» section's catalog, its answers and the
 * import parser, all on placeholder values: nothing here reads or writes a
 * real key. The variant comes from `?keysVariant=1|2|3` (or the local flag
 * `llv_keys_prototype`), the scene from `?keys=` (see `KeysScene`).
 *
 * The client speaks the contract of §5: `GET /api/keys` answers states and
 * masked values with no value in it; `POST /api/keys/<id>/reveal` answers one
 * value per press. The evidence fixture routes those paths to
 * `answerKeysPrototype`, which keeps its catalog in memory for the page.
 */

export type KeyId = "openrouter" | "openai" | "elevenlabs" | "soniox" | "fishaudio" | "telegram";
export type KeySource = "file" | "env" | "missing" | "failed";
export type KeysVariant = 1 | 2 | 3;
/** mixed: 2 here, 1 by variable, 3 not set; staging: read-only; member: a team member, states only;
    failed: the list could not be read; rowfail: one reader threw. */
export type KeysScene = "mixed" | "staging" | "member" | "failed" | "rowfail";

export interface KeyEntry {
  id: KeyId;
  /** The variable that wins over the file; the Telegram token has none and is exported under its own name. */
  variable: string;
  source: KeySource;
  /** The public prefix, eight bullets and the last four characters; null when not set. */
  masked: string | null;
}

export interface KeysAnswer {
  keys: KeyEntry[];
  /** A staging Viewer shares production's files and refuses writes. */
  staging: boolean;
  /** Owner on a team install, or no team: may reveal, copy, export and import. */
  owner: boolean;
}

export const KEY_ORDER: readonly KeyId[] = ["openrouter", "openai", "elevenlabs", "soniox", "fishaudio", "telegram"];

/** A key's shape: its public prefix, then a body the provider prints. */
const shaped = (prefix: string, body: RegExp) => (value: string) => value.startsWith(prefix) && body.test(value.slice(prefix.length));

export const KEY_CATALOG: Record<KeyId, { name: string; variable: string; prefix: string; valid: (value: string) => boolean }> = {
  openrouter: { name: "OpenRouter", variable: "OPENROUTER_API_KEY", prefix: "sk-or-v1-", valid: shaped("sk-or-v1-", /^[0-9a-f]{64}$/) },
  openai: { name: "OpenAI", variable: "OPENAI_API_KEY", prefix: "sk-proj-", valid: shaped("sk-", /^[A-Za-z0-9_-]{20,}$/) },
  elevenlabs: { name: "ElevenLabs", variable: "ELEVENLABS_API_KEY", prefix: "sk_", valid: shaped("sk_", /^[0-9a-f]{48}$/) },
  soniox: { name: "Soniox", variable: "SONIOX_API_KEY", prefix: "", valid: shaped("", /^[0-9a-f]{64}$/) },
  fishaudio: { name: "Fish Audio", variable: "FISH_AUDIO_API_KEY", prefix: "", valid: shaped("", /^[0-9a-f]{32}$/) },
  telegram: { name: "Telegram", variable: "DELEGATUS_TELEGRAM_BOT_TOKEN", prefix: "", valid: shaped("", /^\d{6,12}:[A-Za-z0-9_-]{35}$/) },
};

/* Placeholders only: runs of one digit, so no frame or reading can carry a key. */
const PLACEHOLDER: Partial<Record<KeyId, string>> = {
  openrouter: `sk-or-v1-${"0".repeat(64)}`,
  openai: `sk-proj-${"2".repeat(48)}`,
  elevenlabs: `sk_${"1".repeat(48)}`,
};

/** What a person pastes on the second machine in the import frames. */
export const IMPORT_SAMPLE = [
  "# Delegatus keys · 2026-10-15 · 4",
  `OPENROUTER_API_KEY=sk-or-v1-${"3".repeat(64)}`,
  `export SONIOX_API_KEY="${"4".repeat(64)}"`,
  `OPENAI_API_KEY=sk-proj-${"5".repeat(48)}`,
  "ELEVENLABS_API_KEY=sk_short",
  `DELEGATUS_TELEGRAM_BOT_TOKEN=000000000:${"6".repeat(35)}`,
  `LLV_TOKEN=${"8".repeat(32)}`,
].join("\n");

export function maskValue(id: KeyId, value: string): string {
  const { prefix } = KEY_CATALOG[id];
  const head = id === "telegram" ? value.slice(0, value.indexOf(":") + 1) : value.startsWith(prefix) ? prefix : "";
  return `${head}${"•".repeat(8)}${value.slice(-4)}`;
}

/** The last four characters as the row shows them when the name column is narrow. */
export const maskedTail = (masked: string) => `••••${masked.slice(-4)}`;

export function keysVariant(): KeysVariant | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("keysVariant") ?? (() => {
    try { return window.localStorage.getItem("llv_keys_prototype"); } catch { return null; }
  })();
  return raw === "1" || raw === "2" || raw === "3" ? Number(raw) as KeysVariant : null;
}

export function keysScene(): KeysScene {
  const raw = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("keys");
  return raw === "staging" || raw === "member" || raw === "failed" || raw === "rowfail" ? raw : "mixed";
}

/* ---- The fake server: one catalog per page ---------------------------- */

const values = new Map<KeyId, string>();
const sources = new Map<KeyId, KeySource>();
let seeded = false;

function seed() {
  if (seeded) return;
  seeded = true;
  const scene = keysScene();
  for (const id of KEY_ORDER) {
    const value = PLACEHOLDER[id];
    if (value) values.set(id, value);
    sources.set(id, id === "openai" ? "env" : value ? "file" : "missing");
  }
  if (scene === "rowfail") sources.set("soniox", "failed");
}

function answer(): KeysAnswer {
  seed();
  const scene = keysScene();
  return {
    keys: KEY_ORDER.map((id) => {
      const value = values.get(id);
      const source = sources.get(id)!;
      return { id, variable: KEY_CATALOG[id].variable, source, masked: value && source !== "failed" ? maskValue(id, value) : null };
    }),
    staging: scene === "staging",
    owner: scene !== "member",
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The routes of §5 answered in the page, for the evidence fixture. */
export async function answerKeysPrototype(url: URL, init?: RequestInit): Promise<Response> {
  seed();
  const method = (init?.method ?? "GET").toUpperCase();
  const scene = keysScene();
  if (url.pathname === "/api/keys" && method === "GET") return scene === "failed" ? json({ error: "read_failed" }, 500) : json(answer());
  const match = /^\/api\/keys\/([a-z]+)\/(reveal|value)$/.exec(url.pathname);
  if (match && method === "POST") {
    const id = match[1] as KeyId;
    if (scene === "member") return json({ error: "owner_only" }, 403);
    const value = values.get(id);
    return value ? json({ value }) : json({ error: "not_set" }, 404);
  }
  if (match && method === "PUT" && match[2] === "value") {
    const id = match[1] as KeyId;
    if (scene === "staging") return json({ error: "staging" }, 409);
    const body = JSON.parse(String(init?.body ?? "{}")) as { value?: string };
    const value = (body.value ?? "").trim();
    if (!KEY_CATALOG[id].valid(value)) return json({ error: "invalid_key" }, 400);
    if (sources.get(id) === "env") return json({ error: "set_by_env" }, 409);
    values.set(id, value);
    sources.set(id, "file");
    return json(answer());
  }
  if (url.pathname === "/api/keys/export" && method === "POST") {
    if (scene === "member") return json({ error: "owner_only" }, 403);
    const body = JSON.parse(String(init?.body ?? "{}")) as { includeEnv?: boolean };
    return json({ text: exportLines(body.includeEnv !== false) });
  }
  return json({ error: "not_found" }, 404);
}

function exportLines(includeEnv: boolean): string {
  const rows = KEY_ORDER.filter((id) => values.has(id) && (includeEnv || sources.get(id) !== "env"));
  return [`# Delegatus keys · 2026-10-15 · ${rows.length}`, ...rows.map((id) => `${KEY_CATALOG[id].variable}=${values.get(id)}`)].join("\n");
}

/* ---- Import: the preview of §7 ---------------------------------------- */

export type ImportRow =
  | { id: KeyId; kind: "new"; masked: string; value: string }
  | { id: KeyId; kind: "replaces"; masked: string; was: string; value: string }
  | { id: KeyId; kind: "same"; masked: string }
  | { id: KeyId; kind: "env"; masked: string }
  | { id: KeyId; kind: "invalid" };

export interface ImportPreview {
  rows: ImportRow[];
  /** Names of lines that are no key of the section, never their values. */
  unknown: string[];
  /** Numbers of lines with no NAME=, which may be a bare key: never their text. */
  unparsed: number[];
}

export function previewImport(text: string, current: KeyEntry[]): ImportPreview {
  const byVariable = new Map(KEY_ORDER.map((id) => [KEY_CATALOG[id].variable, id] as const));
  const rows: ImportRow[] = [];
  const unknown: string[] = [];
  const unparsed: number[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) { unparsed.push(index + 1); continue; }
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    const id = byVariable.get(name);
    if (!id) { unknown.push(name); continue; }
    if (!KEY_CATALOG[id].valid(value)) { rows.push({ id, kind: "invalid" }); continue; }
    const masked = maskValue(id, value);
    const here = current.find((entry) => entry.id === id);
    if (here?.source === "env") rows.push({ id, kind: "env", masked });
    else if (here?.masked === masked) rows.push({ id, kind: "same", masked });
    else if (here?.masked) rows.push({ id, kind: "replaces", masked, was: here.masked, value });
    else rows.push({ id, kind: "new", masked, value });
  }
  rows.sort((a, b) => KEY_ORDER.indexOf(a.id) - KEY_ORDER.indexOf(b.id));
  return { rows, unknown, unparsed };
}

/** The pasted lines as the panel shows them: comments and names kept (without `export`), every value down to «••••» and its last four characters. */
export function maskImportText(text: string): string[] {
  return text.replace(/\s+$/, "").split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return line;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    const value = (match ? match[2] : line).replace(/^(["'])(.*)\1$/, "$2");
    const masked = value.length > 8 ? `••••${value.slice(-4)}` : "••••";
    return match ? `${match[1]}=${masked}` : masked;
  });
}
