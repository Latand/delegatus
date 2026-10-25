import path from "node:path";

import { sessionValid } from "@/lib/voiceCompanion/storage";

import type { SourceSnapshot, StoredRow } from "./stores";
import type { RedoItem, SectionName } from "./types";

/* What each section carries, part by part (docs/design/install-memory-transfer.md
   §2.2), and how a part's records land on the target (§4.6). A part is one
   store: rows of one `state.sqlite` collection, keys of one JSON file, one
   text file per record, or records kept only in the import record until the
   thing they belong to connects on the target ("pending"). Records are the
   stores' own values, so the owners' readers decode what the import wrote. */

export type MergeRule =
  /** Absent: written. Same: nothing. Different: the target's value stays, unless
      the operator chose «take the source's» for the section. */
  | "default"
  /** Absent: written. Present: left alone and listed, whatever the choice. */
  | "absent-only"
  | "role-memory"
  | "curation";

interface PartBase {
  id: string;
  section: SectionName;
  collect(source: SourceSnapshot): StoredRow[];
  /** On import: whether this install's reader of the store accepts the record
      under that key. A bundle is input from elsewhere; a record the owner
      would refuse, or a key outside the part, is skipped and never written. */
  accept?(key: string, value: unknown): boolean;
}

export interface RowsPart extends PartBase {
  kind: "rows";
  collection: string;
  /** A legacy JSON store moved into `state.sqlite` (#1870): rows are written
      only once the target imported it, or the target would keep reading its file. */
  legacyDocument: boolean;
  merge: MergeRule;
}

export interface MapPart extends PartBase {
  kind: "map";
  root: "state" | "config";
  file: string;
  /** Path to the object whose keys are the records; empty for the file's root. */
  path: string[];
  skeleton(): Record<string, unknown>;
  merge: MergeRule;
  /** A record is an object of separate settings: the merge rule applies per
      field, so a target that chose one of them keeps that choice and still
      receives the ones it never chose. */
  fields?: boolean;
}

export interface SetPart extends PartBase {
  kind: "set";
  root: "state";
  file: string;
}

export interface TextPart extends PartBase {
  kind: "text";
  root: "state" | "config";
  /** The file a record's key names, relative to the root. */
  fileOf(key: string): string;
  merge: MergeRule;
}

export interface PendingPart extends PartBase {
  kind: "pending";
  /** Why the records wait, as the reason the dry run lists them under. */
  reason: string;
  redo: RedoItem["code"];
}

export type Part = RowsPart | MapPart | SetPart | TextPart | PendingPart;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function at(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) current = isRecord(current) ? current[key] : undefined;
  return current;
}

function mapRecords(text: string | null, keys: readonly string[], include: (key: string, value: unknown) => boolean = () => true): StoredRow[] {
  const object = at(parseJson(text), keys);
  if (!isRecord(object)) return [];
  return Object.entries(object).filter(([key, value]) => include(key, value)).map(([key, value]) => ({ key, value }));
}

const PROJECT_KEY = /^(?:repo|dir)-[0-9a-f]{32}$/;
const isString = (value: unknown): value is string => typeof value === "string";
/** The document row shape every legacy JSON store's collection decodes. */
const documentRow = (prefix: string | readonly string[]) => (key: string, value: unknown) =>
  (typeof prefix === "string" ? [prefix] : prefix).some(start => key.startsWith(start)) && isRecord(value) && value.key === key && "value" in value;

const rows = (collection: string, include: (key: string) => boolean = () => true) =>
  (source: SourceSnapshot) => source.rows(collection).filter(row => include(row.key));

const MEMORY_SOURCE = "memory-source.json";

/** The memory source as a target may take it: Delegatus memory whose engine
    import finished, or the engines' own memory. The fields are the store's
    (`src/lib/memory/source.ts`); the source's import id stays behind, since
    no import of that id exists on the target. */
function settledMemorySource(value: unknown): { schemaVersion: 1; source: "delegatus" | "engines"; changedAt: string; phase?: "active" } | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isString(value.changedAt) || !Number.isFinite(Date.parse(value.changedAt))) return null;
  if (value.source === "delegatus" && value.phase === "active") return { schemaVersion: 1, source: "delegatus", changedAt: value.changedAt, phase: "active" };
  if (value.source === "engines" && value.phase === undefined) return { schemaVersion: 1, source: "engines", changedAt: value.changedAt };
  return null;
}

const VOICE_COMPANION = "voice-companion.json";
const companionSkeleton = () => ({ version: 1, settings: { enabled: false, monthlyCapUsd: 20 }, charges: {}, sessions: {} });
const VOICE_CONFIG_FILE = /^(?:tts-backend|tts-voice-[a-z]+|tts-model-[a-z]+|transcribe-backend)$/;
const VOICE_PERSONA = "prompts/voice-persona.md";
const TRANSCRIPTS = path.join("voice-companion", "transcripts");
const RELAY_SWITCHES = ["relay:rich_media", "chain_conversations", "compact"];
const RELAY_TARGET_FIELDS = ["id", "name", "answered_by", "fallback", "enabled", "engine", "model", "effort", "project", "concurrency", "hardCapMinutes", "memberLimitPerHour", "ownerTier"] as const;

/** The closed calls and their journals from one read of the store and one
    listing of the journals, shared by both parts so they agree. */
function closedCalls(source: SourceSnapshot): { sessions: StoredRow[]; journals: StoredRow[] } {
  return source.memo("memory.calls", () => {
    const names = new Set(source.stateNames(TRANSCRIPTS));
    const sessions = mapRecords(source.stateText(VOICE_COMPANION), ["sessions"], (key, value) =>
      isRecord(value) && value.closed === true && sessionValid(key, value) && names.has(`${key}.jsonl`));
    const journals = sessions.flatMap(session => {
      const text = source.stateText(path.join(TRANSCRIPTS, `${session.key}.jsonl`));
      return text === null ? [] : [{ key: `${session.key}.jsonl`, value: text }];
    });
    /* A session whose journal vanished between the listing and the read travels without it. */
    const present = new Set(journals.map(journal => journal.key));
    return { sessions: sessions.filter(session => present.has(`${session.key}.jsonl`)), journals };
  });
}

export const PARTS: readonly Part[] = [
  /* memory.role — every rule in every state and every scope with its history;
     lesson requests (`q:`) are history and stay. Curation state per project
     travels without its passes, which are history too. */
  { kind: "rows", id: "rows:role_memory", section: "memory.role", collection: "role_memory", legacyDocument: false, merge: "role-memory",
    collect: rows("role_memory", key => key.startsWith("r:") || key.startsWith("s:")) },
  { kind: "rows", id: "rows:role_memory_curation", section: "memory.role", collection: "role_memory_curation", legacyDocument: false, merge: "curation",
    accept: (key, value) => isRecord(value) && value.kind === "project" && isString(value.project) && key === `p:${value.project}` && Array.isArray(value.passes),
    collect: source => rows("role_memory_curation", key => key.startsWith("p:"))(source).map(row => {
      const value = isRecord(row.value) ? { ...row.value } : row.value;
      if (isRecord(value)) { value.current = null; value.passes = []; delete value.claimRevisions; }
      return { key: row.key, value };
    }) },

  { kind: "rows", id: "rows:memory_profile", section: "memory.profile", collection: "memory_profile", legacyDocument: false, merge: "default",
    accept: (key, value) => isRecord(value) && isString(value.project) && (value.locale === "uk" || value.locale === "en") && isString(value.model)
      && Array.isArray(value.parts) && key === JSON.stringify([value.project, value.locale]),
    collect: rows("memory_profile") },

  { kind: "map", id: "map:shared-memory-settings", section: "memory.settings", root: "state", file: "shared-memory-settings.json", path: [], skeleton: () => ({}), merge: "default",
    accept: (key, value) => PROJECT_KEY.test(key) && typeof value === "boolean",
    collect: source => mapRecords(source.stateText("shared-memory-settings.json"), [], (_key, value) => typeof value === "boolean") },
  /* The memory source, once the source settled it (§4.6 memory.settings):
     written only to a target that never chose, as the settled choice itself,
     so the target starts no engine memory import of its own; a target's own
     choice stays. A choice still importing on the source is shown for the
     operator to make here. */
  { kind: "text", id: "text:memory-source", section: "memory.settings", root: "state", fileOf: key => key, merge: "absent-only",
    accept: (key, value) => key === MEMORY_SOURCE && isString(value) && settledMemorySource(parseJson(value)) !== null,
    collect: source => {
      const settled = settledMemorySource(parseJson(source.stateText(MEMORY_SOURCE)));
      return settled ? [{ key: MEMORY_SOURCE, value: `${JSON.stringify(settled)}\n` }] : [];
    } },
  { kind: "pending", id: "pending:memory-source", section: "memory.settings", reason: "choose-on-target", redo: "memory_source",
    collect: source => {
      const value = parseJson(source.stateText(MEMORY_SOURCE));
      return isRecord(value) && (value.source === "delegatus" || value.source === "engines") && !settledMemorySource(value) ? [{ key: "source", value: value.source }] : [];
    } },

  /* memory.calls — the call memory switch, the closed calls and their journals. */
  { kind: "map", id: "map:voice-call-memory", section: "memory.calls", root: "state", file: VOICE_COMPANION, path: ["settings"], skeleton: companionSkeleton, merge: "default",
    accept: (key, value) => key === "callMemory" && typeof value === "boolean",
    collect: source => mapRecords(source.stateText(VOICE_COMPANION), ["settings"], key => key === "callMemory") },
  { kind: "map", id: "map:voice-call-sessions", section: "memory.calls", root: "state", file: VOICE_COMPANION, path: ["sessions"], skeleton: companionSkeleton, merge: "absent-only",
    accept: (key, value) => isRecord(value) && value.closed === true && sessionValid(key, value),
    collect: source => closedCalls(source).sessions },
  /* Only the journals of the closed calls above: an ongoing call's journal
     and one no closed call cites stay on the source (§2.2). */
  { kind: "text", id: "text:voice-call-journals", section: "memory.calls", root: "state", fileOf: key => path.join(TRANSCRIPTS, key), merge: "absent-only",
    accept: (key, value) => /^[A-Za-z0-9_-]{1,200}\.jsonl$/.test(key) && isString(value),
    collect: source => closedCalls(source).journals },

  { kind: "rows", id: "rows:seat_tick_settings", section: "settings.seat", collection: "seat_tick_settings", legacyDocument: true, merge: "default",
    accept: documentRow(""),
    collect: rows("seat_tick_settings") },

  ...(["role_presets", "review_loop_presets", "workflow_templates", "spawn_nesting"] as const).map((collection): RowsPart => ({
    kind: "rows", id: `rows:${collection}`, section: "settings.roles", collection, legacyDocument: true, merge: "default", collect: rows(collection), accept: documentRow(""),
  })),

  { kind: "map", id: "map:worker-limit-projects", section: "settings.limits", root: "state", file: "worker-limit.json", path: ["projects"],
    skeleton: () => ({ schemaVersion: 1, machine: null, projects: {}, history: [] }), merge: "default",
    accept: (key, value) => PROJECT_KEY.test(key) && isRecord(value) && Number.isInteger(value.value) && (value.value as number) >= 1 && (value.value as number) <= 64
      && isString(value.changedAt) && isRecord(value.changedBy),
    collect: source => mapRecords(source.stateText("worker-limit.json"), ["projects"]) },
  /* The machine value describes other hardware: shown, never applied. */
  { kind: "pending", id: "pending:machine-worker-limit", section: "settings.limits", reason: "machine-value-shown-only", redo: "machine_worker_limit",
    collect: source => {
      const machine = at(parseJson(source.stateText("worker-limit.json")), ["machine", "value"]);
      return typeof machine === "number" ? [{ key: "machine", value: machine }] : [];
    } },

  { kind: "map", id: "map:project-settings", section: "settings.projects", root: "state", file: "project-settings.json", path: ["projects"],
    skeleton: () => ({ schemaVersion: 1, projects: {} }), merge: "default", fields: true,
    accept: (key, value) => PROJECT_KEY.test(key) && isRecord(value),
    collect: source => mapRecords(source.stateText("project-settings.json"), ["projects"]) },
  { kind: "rows", id: "rows:project_aliases", section: "settings.projects", collection: "project_aliases", legacyDocument: true, merge: "default",
    accept: (key, value) => documentRow("name:")(key, value) && isString((value as { value: unknown }).value) && !!((value as { value: string }).value).trim(),
    collect: rows("project_aliases", key => key.startsWith("name:")) },
  /* A hand-made project's root is a path of the source: only its folder name
     travels, and the target uses the folder the operator maps it to. */
  { kind: "rows", id: "rows:project_curation", section: "settings.projects", collection: "project_curation", legacyDocument: true, merge: "default",
    accept: (key, value) => {
      if (!documentRow(["crown:", "manual:"])(key, value)) return false;
      const inner = (value as { value: unknown }).value;
      if (key.startsWith("crown:")) return isRecord(inner) && inner.project === key.slice("crown:".length) && Number.isInteger(inner.order);
      const entry = isRecord(inner) ? inner.entry : null;
      return isRecord(inner) && Number.isInteger(inner.order) && isRecord(entry) && entry.project === key.slice("manual:".length)
        && isString(entry.displayName) && !!entry.displayName.trim() && isString(entry.root) && Number.isFinite(entry.createdAt);
    },
    collect: source => rows("project_curation", key => key.startsWith("crown:") || key.startsWith("manual:"))(source).map(row => {
      const entry = at(row.value, ["value", "entry"]);
      if (!row.key.startsWith("manual:") || !isRecord(entry) || typeof entry.root !== "string") return row;
      const value = row.value as { key: string; value: { entry: Record<string, unknown>; order: number } };
      return { key: row.key, value: { ...value, value: { ...value.value, entry: { ...entry, root: path.basename(entry.root) } } } };
    }) },

  { kind: "map", id: "map:operator-settings", section: "settings.operator", root: "state", file: "operator-settings.json", path: [],
    skeleton: () => ({ schemaVersion: 1 }), merge: "default",
    accept: (key, value) => (key === "locale" || key === "timeZone") && isRecord(value) && isString(value.value) && isString(value.changedAt),
    collect: source => mapRecords(source.stateText("operator-settings.json"), [], key => key === "locale" || key === "timeZone") },
  { kind: "map", id: "map:asks-you-settings", section: "settings.operator", root: "state", file: "asks-you-settings.json", path: [],
    skeleton: () => ({ schemaVersion: 1 }), merge: "default",
    accept: (key, value) => key === "enabled" ? typeof value === "boolean" : key === "capUsd" ? typeof value === "number" && value >= 0 && value <= 50
      : key === "changedAt" && isString(value),
    collect: source => mapRecords(source.stateText("asks-you-settings.json"), [], key => ["enabled", "capUsd", "changedAt"].includes(key)) },
  /* A consent is confirmed on the install it governs. */
  { kind: "pending", id: "pending:subscription-consent", section: "settings.operator", reason: "confirm-on-target", redo: "subscription_consent",
    collect: source => {
      const value = parseJson(source.stateText("subscription-api-consent.json"));
      return isRecord(value) && typeof value.enabled === "boolean" ? [{ key: "enabled", value: value.enabled }] : [];
    } },

  { kind: "map", id: "map:voice-settings", section: "settings.voice", root: "state", file: VOICE_COMPANION, path: ["settings"], skeleton: companionSkeleton, merge: "default",
    accept: (key, value) => key === "enabled" ? typeof value === "boolean" : key === "monthlyCapUsd" ? typeof value === "number" && Number.isFinite(value) && value >= 0
      : key === "backend" && (value === "api" || value === "codex"),
    collect: source => mapRecords(source.stateText(VOICE_COMPANION), ["settings"], key => ["enabled", "monthlyCapUsd", "backend"].includes(key)) },
  { kind: "text", id: "text:voice-choices", section: "settings.voice", root: "config", fileOf: key => key, merge: "default",
    accept: (key, value) => (VOICE_CONFIG_FILE.test(key) || key === VOICE_PERSONA) && isString(value) && value.length <= 256 * 1024,
    collect: source => [...source.configNames().filter(name => VOICE_CONFIG_FILE.test(name)), VOICE_PERSONA].flatMap(name => {
      const text = source.configText(name);
      return text === null ? [] : [{ key: name, value: text }];
    }) },
  /* Tool approvals are sealed per process (#3188) and tool secrets never
     travel: the registry waits in the import record. */
  { kind: "pending", id: "pending:voice-tools", section: "settings.voice", reason: "approve-on-target", redo: "voice_tools",
    collect: source => mapRecords(source.stateText("voice-tools.json"), ["servers"]),
  },

  { kind: "set", id: "set:forge-app-repositories", section: "settings.forge", root: "state", file: "forge-app-repositories.json",
    accept: (key, value) => key === value && isString(value) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
    collect: source => {
      const list = parseJson(source.stateText("forge-app-repositories.json"));
      return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string").map(entry => ({ key: entry, value: entry })) : [];
    } },

  /* Relay targets apply once the same relay is paired here; the pairing
     credential is never read into a record. */
  { kind: "pending", id: "pending:relay-targets", section: "settings.relay", reason: "waits-for-relay-pairing", redo: "relay_pairing",
    collect: source => {
      const relays = at(parseJson(source.stateText(path.join("external-relay", "relays.json"))), ["relays"]);
      if (!Array.isArray(relays)) return [];
      return relays.filter(isRecord).flatMap(relay => (Array.isArray(relay.targets) ? relay.targets : []).filter(isRecord).map(target => ({
        key: `${String(relay.origin)}/${String(target.id)}`,
        value: { origin: relay.origin, relay: relay.name, target: Object.fromEntries(RELAY_TARGET_FIELDS.flatMap(field => field in target ? [[field, target[field]]] : [])) },
      })));
    } },
  { kind: "map", id: "map:relay-switches", section: "settings.relay", root: "state", file: path.join("external-relay", "switches.json"), path: [],
    skeleton: () => ({ v: 1 }), merge: "default",
    /* Owner tools give the relay's owner agent runs here; only this install's
       operator turns them on. */
    accept: (key, value) => RELAY_SWITCHES.includes(key) && typeof value === "boolean",
    collect: source => mapRecords(source.stateText(path.join("external-relay", "switches.json")), [], key => RELAY_SWITCHES.includes(key)) },

  /* Chat aliases and posting permission are valid only for the same bot. */
  { kind: "pending", id: "pending:telegram-chats", section: "settings.telegram", reason: "waits-for-same-bot", redo: "telegram_bot",
    collect: source => {
      const { bot, chats } = source.telegramChats();
      return chats.map(chat => ({ key: chat.chat_id, value: { bot, chatId: chat.chat_id, type: chat.type, title: chat.title, alias: chat.alias, postAllowed: chat.post_allowed === 1 } }));
    } },
];

export const partById = new Map(PARTS.map(part => [part.id, part] as const));

/** The JSON files the transfer writes, each written once with every part's records. */
export function fileTargetsOf(part: MapPart | SetPart): { root: "state" | "config"; file: string } {
  return { root: part.root, file: part.file };
}
