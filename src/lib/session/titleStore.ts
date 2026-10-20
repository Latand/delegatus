import { smallStore } from "@/lib/state/smallStore";

import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";
import { jsonArrayRecordBytes, registryRecordKey, reportRegistryRecord } from "@/lib/state/registryRecords";

/** Longest custom title we store; the derived title uses the same 120 cap. */
export const MAX_CUSTOM_TITLE = 120;
/** Bounded store — the oldest records are evicted past this many keys, so a
    machine that renames thousands of sessions never grows the file without a
    ceiling. Chosen well above any plausible working set. */
export const MAX_TITLE_OVERRIDES = 2_000;

/** Resolve on every call, never bake at module load: a test that pins
    LLV_STATE_DIR after this module first imports must still redirect writes to
    its sandbox (see flows/store.ts for the same reasoning). */
const titlesFile = () => statePath("session-titles.json");

/** One durable rename record. `key` is the stable identity the title is filed
    under (see {@link titleKeysForEntry}). `title` is the custom name, or `null`
    for a **tombstone** — a cleared override whose `revision` is preserved so a
    later set never reuses a revision an earlier editor still holds (that would
    let a stale write slip past the concurrency guard). `revision` bumps on
    every set and clear. */
export interface SessionTitleOverride {
  key: string;
  title: string | null;
  revision: number;
  updatedAt: string;
}

type TitlesFile = { version?: unknown; titles?: unknown };

/** The store exists but cannot be trusted (unreadable, invalid JSON, unknown
    schema). Mutations must abort on this rather than
    persist over it — a blind rewrite would erase every existing title. */
export class TitleStoreUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleStoreUnreadableError";
  }
}

function isRecord(value: unknown): value is SessionTitleOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SessionTitleOverride>;
  return (
    typeof record.key === "string" &&
    record.key.length > 0 &&
    (record.title === null || (typeof record.title === "string" && record.title.length > 0)) &&
    typeof record.revision === "number" &&
    Number.isInteger(record.revision) &&
    record.revision > 0 &&
    typeof record.updatedAt === "string"
  );
}

/**
 * Read committed overrides. First activation preserves torn legacy bytes with
 * a durable import incident; unsupported schemas refuse migration. Individual
 * rejected records retain their original bytes beside healthy overrides.
 */
export function readSessionTitles(filePath = titlesFile()): SessionTitleOverride[] {
  return sessionTitleStore.read(filePath).records;
}

type TitleDocument = { records: SessionTitleOverride[]; preserved: { key: string; json: string }[] };
function parseTitlesDocument(raw: unknown, sourceText?: string): TitleDocument {
  const parsed = raw;
  const text = sourceText ?? JSON.stringify(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TitleStoreUnreadableError("session titles store has an unexpected shape");
  }
  const file = parsed as TitlesFile;
  if (file.version !== undefined && file.version !== 1) {
    throw new TitleStoreUnreadableError(`session titles store schema version ${String(file.version)} is unsupported`);
  }
  if (!Array.isArray(file.titles)) {
    throw new TitleStoreUnreadableError("session titles store is missing its titles array");
  }
  const records = file.titles.filter(isRecord);
  const bytes = jsonArrayRecordBytes(text, "titles");
  const preserved = file.titles.flatMap((record, index) => {
    if (isRecord(record)) return [];
    const ownKey = record && typeof record === "object" ? (record as { key?: unknown }).key : undefined;
    const key = typeof ownKey === "string" && ownKey ? ownKey : registryRecordKey(record);
    reportRegistryRecord("session-titles", { id: key });
    return [{ key, json: bytes[index]! }];
  });
  return { records, preserved };
}

/** Read consumers (overlay, projection) degrade to no overrides when the store
    is unreadable — a broken file must not break rendering. Mutations use the
    strict {@link readSessionTitles} so they never persist over broken bytes. */
export function loadSessionTitles(filePath = titlesFile()): SessionTitleOverride[] {
  try {
    return readSessionTitles(filePath);
  } catch {
    return [];
  }
}

function withTitleRecords(document: TitleDocument, records: SessionTitleOverride[]): TitleDocument {
  const protectedKeys = new Set(document.preserved.map(record => record.key));
  for (const record of records) {
    if (!isRecord(record) || protectedKeys.has(record.key)) throw new TitleStoreUnreadableError(`refusing to overwrite preserved title record: ${record.key}`);
  }
  return { records, preserved: document.preserved };
}
export const sessionTitleStore = smallStore<TitleDocument>({
  collection: "session_titles", empty: () => ({ records: [], preserved: [] }), parse: parseTitlesDocument,
  toRows: document => [...document.records.map(record => ({ key: record.key, value: { record } })), ...document.preserved.map(record => ({ key: record.key, value: { preserved: record } }))],
  fromRows: rows => ({ records: rows.flatMap(row => (row.value as { record?: SessionTitleOverride }).record ? [(row.value as { record: SessionTitleOverride }).record] : []), preserved: rows.flatMap(row => (row.value as { preserved?: TitleDocument["preserved"][number] }).preserved ? [(row.value as { preserved: TitleDocument["preserved"][number] }).preserved] : []) }),
  toFile: document => ({ version: 1, titles: [...document.records, ...document.preserved.map(record => JSON.parse(record.json))] }),
  serializeFile: document => `{\n  "version": 1,\n  "titles": [\n${[...document.records.map(record => JSON.stringify(record)), ...document.preserved.map(record => record.json)].join(",\n")}\n  ]\n}\n`,
  error: message => new TitleStoreUnreadableError(message),
});
export function saveSessionTitles(records: SessionTitleOverride[], filePath = titlesFile()): void {
  sessionTitleStore.mutate(filePath, document => ({ next: withTitleRecords(document, capRecords(records)), result: undefined }));
}

/** Sanitize + bound a user title. Returns null when it collapses to empty (an
    empty title is a clear, never a blank card). */
export function sanitizeCustomTitle(value: string): string | null {
  const cleaned = cleanTitle(value, MAX_CUSTOM_TITLE);
  return cleaned.length > 0 ? cleaned : null;
}

/** Path-level subagent exclusion for the rename scope (issue #33, AC9): Claude
    subagent transcripts are `agent-*.jsonl` and/or live under a `subagents/`
    directory. Native Codex subagents share the ordinary `rollout-*.jsonl` name
    and are filtered separately from transcript metadata — see
    `isRenameableSessionEntry` in `renameEligibility.ts`. Pure string ops so this
    stays importable from client-safe server code without pulling `node:fs`. */
export function isRenameableSessionPath(pathname: string): boolean {
  const base = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !base.startsWith("agent-") && !pathname.includes("/subagents/");
}

/** Candidate keys for an entry, most-stable first: the Viewer conversation
    identity owns the title when present (so account/compaction successors adopt
    it through the registry), the session UUID is the compatibility key that
    survives archive/revive/move, and the transcript path is the bounded
    fallback for a session the registry never named. `aliasConversationIds` are
    former (e.g. provisional) conversation ids the registry has since coalesced
    into the canonical one — including them keeps a title filed under an old id
    reachable, and (because a write collapses onto the first key) migrates it
    onto the canonical id. */
export function titleKeysForEntry(
  entry: Pick<FileEntry, "engine" | "path" | "conversationId">,
  aliasConversationIds: readonly string[] = [],
  ownedPaths: readonly string[] = [],
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (!seen.has(key)) { seen.add(key); keys.push(key); }
  };
  if (entry.conversationId?.startsWith("conversation_")) add(`conversation:${entry.conversationId}`);
  for (const alias of aliasConversationIds) {
    if (alias.startsWith("conversation_") && alias !== entry.conversationId) add(`conversation:${alias}`);
  }
  const addTranscript = (pathname: string) => {
    if (entry.engine === "claude" || entry.engine === "codex") {
      const sessionKey = sessionKeyFromTranscript(entry.engine, pathname);
      if (sessionKey) add(`uuid:${sessionKeyId(sessionKey)}`);
    }
    add(`path:${pathname}`);
  };
  // The current transcript first (its keys stay the fallback preference), then
  // every other path the conversation owns — predecessor generations and
  // continuity paths — so a title filed under an earlier UUID/path survives a
  // succession to a new transcript and migrates onto the conversation key.
  addTranscript(entry.path);
  for (const pathname of ownedPaths) addTranscript(pathname);
  return keys;
}

/** The single key a fresh rename is filed under — the most stable available. */
export function preferredTitleKey(entry: Pick<FileEntry, "engine" | "path" | "conversationId">): string {
  return titleKeysForEntry(entry)[0]!;
}

/** Index records by key for O(1) overlay lookups. */
export function indexSessionTitles(records: SessionTitleOverride[]): Map<string, SessionTitleOverride> {
  return new Map(records.map((record) => [record.key, record]));
}

/** The record that owns an entry's title, checked most-stable key first —
    including a tombstone, so the overlay can surface its revision as the base
    for the next write. */
export function overrideForEntry(
  entry: Pick<FileEntry, "engine" | "path" | "conversationId">,
  index: Map<string, SessionTitleOverride>,
  aliasConversationIds: readonly string[] = [],
  ownedPaths: readonly string[] = [],
): SessionTitleOverride | null {
  for (const key of titleKeysForEntry(entry, aliasConversationIds, ownedPaths)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

/** Overlay a custom title onto a scanned entry. An active record replaces
    `title` and preserves the derived title on `autoTitle` — even when the two
    strings match, so an explicit override that equals the derived title keeps
    its provenance and Reset control. A tombstone leaves the title untouched
    (cleared → auto title stands). Either way `titleRevision` carries the
    concurrency token consumers echo back on the next PATCH, so a reset-then-
    rename never reuses a stale revision. */
export function applyTitleOverride(
  entry: FileEntry,
  index: Map<string, SessionTitleOverride>,
  aliasConversationIds: readonly string[] = [],
  ownedPaths: readonly string[] = [],
): void {
  const record = overrideForEntry(entry, index, aliasConversationIds, ownedPaths);
  if (!record) return;
  entry.titleRevision = record.revision;
  if (record.title === null) return;
  // Capture the derived title as provenance on the first application only —
  // even when it equals the custom title, so an explicit override keeps its
  // Reset control (finding: equal titles lost Reset). The `autoTitle`-unset
  // guard also makes a second pass idempotent: it never recaptures the custom
  // title as the auto title.
  if (entry.autoTitle === undefined) entry.autoTitle = entry.title;
  entry.title = record.title;
}

/** Serialized SQLite mutation. Admission never waits synchronously; async
 * request callers retry the complete operation through waitForStateLock. */
export function mutateSessionTitles<R>(
  mutate: (records: SessionTitleOverride[]) => { records: SessionTitleOverride[] | undefined; result: R },
  filePath = titlesFile(),
): R {
  return sessionTitleStore.mutate(filePath, document => {
    const outcome = mutate(document.records);
    return { next: outcome.records ? withTitleRecords(document, capRecords(outcome.records)) : undefined, result: outcome.result };
  });
}

/** Keep the store bounded — evict the least-recently-updated records once the
    key count exceeds the cap. */
function capRecords(records: SessionTitleOverride[]): SessionTitleOverride[] {
  if (records.length <= MAX_TITLE_OVERRIDES) return records;
  return [...records]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_TITLE_OVERRIDES);
}

export type SetTitleOutcome =
  /** `override` is the active record, or null once cleared. `revision` is the
      effective store revision after the write — the active record's, the
      tombstone's, or 0 when no record exists — so an optimistic client always
      knows the real base (a no-op clear against an existing tombstone must not
      report a fabricated N+1). */
  | { ok: true; override: SessionTitleOverride | null; revision: number }
  | { ok: false; conflict: SessionTitleOverride | null };

/**
 * Set (non-empty) or clear (null) a session's custom title.
 *
 * `candidateKeys` are the entry's keys in stable-first priority (see
 * {@link titleKeysForEntry}); `preferredKey` (their first entry) is where the
 * result lands. The mutation bases its concurrency check on the **first
 * existing record among the candidates** — the same record the overlay surfaced
 * as `titleRevision` — then collapses every candidate-key record into a single
 * record under `preferredKey`. That migrates a title filed under the UUID/path
 * onto the conversation key once identity appears, so a later clear can never
 * miss it (finding: fallback-key overrides couldn't be cleared).
 *
 * A clear writes a **tombstone** (title `null`) that preserves the monotonic
 * revision; a set writes the sanitized title. When `baseRevision` is supplied it
 * must match the current record's revision, else the write is rejected as a
 * conflict carrying the current record. Returns the effective active record, or
 * null once cleared.
 */
export function writeSessionTitle(
  candidateKeys: string[],
  preferredKey: string,
  title: string | null,
  baseRevision: number | undefined,
  now: string,
  filePath = titlesFile(),
): SetTitleOutcome {
  const keySet = new Set(candidateKeys);
  return mutateSessionTitles<SetTitleOutcome>((records) => {
    let current: SessionTitleOverride | null = null;
    for (const key of candidateKeys) {
      const hit = records.find((record) => record.key === key);
      if (hit) { current = hit; break; }
    }
    if (baseRevision !== undefined && baseRevision !== (current?.revision ?? 0)) {
      return { records: undefined, result: { ok: false, conflict: current } };
    }
    const sanitized = title === null ? null : sanitizeCustomTitle(title);
    // Drop every candidate-key record; the single new record is re-added under
    // the preferred key, collapsing duplicates and migrating stale keys.
    const rest = records.filter((record) => !keySet.has(record.key));
    if (sanitized === null) {
      // Nothing set, or already a tombstone: clearing again is a no-op that must
      // not bump the revision (and must not create a tombstone from nothing). It
      // still reports the effective revision so a retry after a tombstone
      // conflict records the real base, not a fabricated one.
      if (!current) return { records: undefined, result: { ok: true, override: null, revision: 0 } };
      if (current.title === null) return { records: undefined, result: { ok: true, override: null, revision: current.revision } };
      const tombstone: SessionTitleOverride = { key: preferredKey, title: null, revision: current.revision + 1, updatedAt: now };
      return { records: [...rest, tombstone], result: { ok: true, override: null, revision: tombstone.revision } };
    }
    const record: SessionTitleOverride = { key: preferredKey, title: sanitized, revision: (current?.revision ?? 0) + 1, updatedAt: now };
    return { records: [...rest, record], result: { ok: true, override: record, revision: record.revision } };
  }, filePath);
}
