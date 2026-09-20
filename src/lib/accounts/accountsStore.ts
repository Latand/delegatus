import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { FileTransactionBusyError, withFileTransactionSync } from "@/lib/state/fileTransaction";
import {
  importLegacyCollection,
  lazyReconcileAllowed,
  legacyBaselineRevision,
  legacyDatabasePath,
  legacyImportAllowed,
  writeLegacyRollbackMirror,
  type LegacyCollectionSpec,
  type LegacyImportHooks,
  type LegacyImportOutcome,
  type LegacyReconcileSummary,
} from "@/lib/state/legacyImport";
import { readStateImport, recordStateImportMirror, SqliteStateCollection, type StateImportRecord, type StateImportRow } from "@/lib/state/sqliteStateStore";

/**
 * Every account store in one `accounts` collection of `state.sqlite` (#1870,
 * slice 7; docs/design/state-sqlite-migration.md §4.2).
 *
 * Eight JSON files move together because they are one consistency domain. A
 * #1857 removal writes the account row, its retired record and its removal
 * journal step — and the mutation fence that admits the whole transaction — in
 * ONE commit, where the legacy store wrote the registry and
 * `account-mutation-revision.json` separately and a crash between them left a
 * fence that had moved without the write it admitted. That is also why the
 * mutation revision keeps no rows of its own: the collection revision IS the
 * account mutation revision ({@link accountsCollectionRevision}).
 *
 * The import is slice 1's helper, unchanged. It knows one legacy file per
 * collection, so `claude-accounts.json` drives it and the other seven are
 * locked, read, retired and mirrored beside it here: {@link importLegacyAccounts}
 * holds every sibling's own write-transaction lock around the helper's call, so
 * no legacy writer of any of the eight can interleave with the import, and each
 * retired sibling leaves the same tombstone directory, so old code fails with
 * EISDIR instead of writing a file nothing reads.
 *
 * Rows are stored exactly as the legacy files held them. Nothing here validates
 * an account, a binding or a fence: each owner module keeps its own validator
 * and sees the body it always saw ({@link readAccountSource}). A record this
 * module cannot key — no id, a duplicate id, a shape the file was never
 * supposed to hold — keeps its position under an index key rather than being
 * dropped, so a damaged store still reads as damaged to the module that
 * refuses on it.
 *
 * CREDENTIALS NEVER MOVE. `.credentials.json` and `auth.json` are not state and
 * are not touched here; nothing in this file reads an account home.
 */

/** One persisted row: its key, and the value the legacy file held. */
export interface AccountStateRow {
  k: string;
  v: unknown;
}

export const ACCOUNTS_COLLECTION = "accounts";
export const ACCOUNTS_MIGRATION_ID = "accounts-json-v1";
const ACCOUNTS_BUSY = "account state is busy";

export const CLAUDE_ACCOUNTS_SOURCE = "claude-accounts.json";
export const CODEX_ACCOUNTS_SOURCE = "codex-accounts.json";
export const BINDINGS_SOURCE = "account-project-bindings.json";
export const OVERRIDES_SOURCE = "account-project-overrides.json";
export const FENCES_SOURCE = "spawn-admission-fences.json";
export const MUTATION_REVISION_SOURCE = "account-mutation-revision.json";
export const CLAUDE_LOGIN_SOURCE = "claude-auth-operations.json";
export const CODEX_LOGIN_SOURCE = "codex-login-attempts.json";

export type AccountSourceName =
  | typeof CLAUDE_ACCOUNTS_SOURCE
  | typeof CODEX_ACCOUNTS_SOURCE
  | typeof BINDINGS_SOURCE
  | typeof OVERRIDES_SOURCE
  | typeof FENCES_SOURCE
  | typeof MUTATION_REVISION_SOURCE
  | typeof CLAUDE_LOGIN_SOURCE
  | typeof CODEX_LOGIN_SOURCE;

/* ── Row keys ──────────────────────────────────────────────────────────────
   `active:<engine>`            the registry minus its three lists
   `claude:<id>` `codex:<id>`   one managed account
   `retired:<engine>:<id>`      one retired account
   `removal:<engine>:<id>`      one in-flight removal (#1857)
   `binding:<engine>:<account>:<project>`  one account↔project binding
   `override:<seq>`             one out-of-pool choice, `seq` zero-padded
   `fence:<clientAttemptId>`    one spawn admission fence
   `authop:<operationId>`       one Claude login operation
   `login:<home>`               one Codex device-login attempt
   `meta:<store>`               a store's fields outside its own list, empty
                                lists included, so a body round-trips exactly
   `raw:<file>`                 a whole legacy body whose container shape was
                                never the one the store writes, kept verbatim
   A record this module cannot key keeps its position under `<prefix>:#<index>`;
   no account id, binding or fence key may contain `#`, so the two key spaces
   never collide. */

const SEQ_WIDTH = 12;
const OVERRIDE_PREFIX = "override:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function indexKey(prefix: string, index: number): string {
  return `${prefix}:#${index}`;
}

/** A keyable, not-yet-seen, separator-free string id, or null for an index key. */
function keyable(value: unknown, seen: Set<string>): string | null {
  if (typeof value !== "string" || !value || value.includes("#") || seen.has(value)) return null;
  seen.add(value);
  return value;
}

interface AccountSourceSpec {
  name: AccountSourceName;
  /** The row that records this store's legacy file as unreadable. It is owned
      by the source, so the first successful write clears it. */
  gapKey: string;
  /** Whether a row key belongs to this source. */
  owns(key: string): boolean;
  /** The legacy body as rows. Never throws on content: validation stays with
      the owner module, which must still see a damaged store as damaged. */
  toRows(body: unknown): AccountStateRow[];
  /** The rows back as the legacy body, for a read and for a rollback mirror.
      `undefined` is an empty store, which is what an absent file always meant. */
  body(rows: readonly AccountStateRow[], context: { revision: number }): unknown | undefined;
}

/** Split a body into the rows of one embedded collection and the head row that
    keeps every other field — an unexpected shape of the collection itself
    included, so the owner module still refuses on exactly what it refused on. */
function splitBody(
  body: Record<string, unknown>,
  field: string,
  embedded: (value: unknown) => boolean,
): { head: Record<string, unknown>; entries: unknown | null } {
  const head: Record<string, unknown> = {};
  let entries: unknown | null = null;
  for (const [name, value] of Object.entries(body)) {
    /* An empty collection stays on the head row: rows cannot record the
       difference between a field holding nothing and a field that is absent,
       and `retired` post-dates registry version 1, where absent means
       complete rather than corrupt. */
    if (name === field && embedded(value) && collectionSize(value) > 0) entries = value;
    else head[name] = value;
  }
  return { head, entries };
}

function collectionSize(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return isRecord(value) ? Object.keys(value).length : 0;
}

/* ── Registries (claude-accounts.json, codex-accounts.json) ─────────────── */

const REGISTRY_LISTS = ["accounts", "retired", "removals"] as const;
type RegistryList = (typeof REGISTRY_LISTS)[number];

function registrySource(name: AccountSourceName, engine: "claude" | "codex"): AccountSourceSpec {
  const rawKey = `raw:${name}`;
  const headKey = `active:${engine}`;
  const prefixes: Record<RegistryList, string> = {
    accounts: `${engine}:`,
    retired: `retired:${engine}:`,
    removals: `removal:${engine}:`,
  };
  const gapKey = `gap:${engine}`;
  return {
    name,
    gapKey,
    owns: (key) => key === rawKey || key === headKey || key === gapKey
      || REGISTRY_LISTS.some((list) => key.startsWith(prefixes[list])),
    toRows: (body) => {
      if (!isRecord(body)) return [{ k: rawKey, v: body }];
      const head: Record<string, unknown> = {};
      const lists = new Map<RegistryList, unknown[]>();
      for (const [field, value] of Object.entries(body)) {
        if ((REGISTRY_LISTS as readonly string[]).includes(field) && Array.isArray(value) && value.length > 0) {
          lists.set(field as RegistryList, value);
        } else head[field] = value;
      }
      const rows: AccountStateRow[] = [{ k: headKey, v: head }];
      for (const list of REGISTRY_LISTS) {
        const entries = lists.get(list);
        if (!entries) continue;
        const seen = new Set<string>();
        const prefix = prefixes[list].slice(0, -1);
        entries.forEach((entry, index) => {
          const id = keyable(isRecord(entry) ? entry.id : null, seen);
          rows.push({ k: id ? `${prefix}:${id}` : indexKey(prefix, index), v: entry });
        });
      }
      return rows;
    },
    body: (rows) => {
      const raw = rows.find((row) => row.k === rawKey);
      if (raw) return raw.v;
      const head = rows.find((row) => row.k === headKey);
      if (!head) return undefined;
      const body: Record<string, unknown> = { ...(isRecord(head.v) ? head.v : {}) };
      for (const list of REGISTRY_LISTS) {
        const entries = rows.filter((row) => row.k.startsWith(prefixes[list]));
        if (entries.length > 0) body[list] = entries.map((row) => row.v);
      }
      return body;
    },
  };
}

/* ── A list inside an object (bindings, overrides) ──────────────────────── */

function listSource(options: {
  name: AccountSourceName;
  field: string;
  prefix: string;
  /** The stable key for one entry, or null to keep its index. */
  entryKey(entry: unknown, seen: Set<string>): string | null;
}): AccountSourceSpec {
  const rawKey = `raw:${options.name}`;
  const headKey = `meta:${options.prefix}`;
  const gapKey = `gap:${options.prefix}`;
  const prefix = `${options.prefix}:`;
  return {
    name: options.name,
    gapKey,
    owns: (key) => key === rawKey || key === headKey || key === gapKey || key.startsWith(prefix),
    toRows: (body) => {
      if (!isRecord(body)) return [{ k: rawKey, v: body }];
      const { head, entries } = splitBody(body, options.field, Array.isArray);
      const rows: AccountStateRow[] = [{ k: headKey, v: head }];
      const seen = new Set<string>();
      (entries as unknown[] | null)?.forEach((entry, index) => {
        const key = options.entryKey(entry, seen);
        rows.push({ k: key ? `${prefix}${key}` : indexKey(options.prefix, index), v: entry });
      });
      return rows;
    },
    body: (rows) => {
      const raw = rows.find((row) => row.k === rawKey);
      if (raw) return raw.v;
      const head = rows.find((row) => row.k === headKey);
      if (!head) return undefined;
      const entries = rows.filter((row) => row.k.startsWith(prefix));
      const body: Record<string, unknown> = { ...(isRecord(head.v) ? head.v : {}) };
      if (entries.length > 0) body[options.field] = entries.map((row) => row.v);
      return body;
    },
  };
}

/* ── A keyed map inside an object (fences, Codex login attempts) ────────── */

function mapSource(options: { name: AccountSourceName; field: string; prefix: string }): AccountSourceSpec {
  const rawKey = `raw:${options.name}`;
  const headKey = `meta:${options.prefix}`;
  const gapKey = `gap:${options.prefix}`;
  const prefix = `${options.prefix}:`;
  return {
    name: options.name,
    gapKey,
    owns: (key) => key === rawKey || key === headKey || key === gapKey || key.startsWith(prefix),
    toRows: (body) => {
      if (!isRecord(body)) return [{ k: rawKey, v: body }];
      const { head, entries } = splitBody(body, options.field, isRecord);
      const rows: AccountStateRow[] = [{ k: headKey, v: head }];
      const seen = new Set<string>();
      Object.entries((entries ?? {}) as Record<string, unknown>).forEach(([key, value], index) => {
        const stable = keyable(key, seen);
        rows.push({ k: stable ? `${prefix}${stable}` : indexKey(options.prefix, index), v: { key, value } });
      });
      return rows;
    },
    body: (rows) => {
      const raw = rows.find((row) => row.k === rawKey);
      if (raw) return raw.v;
      const head = rows.find((row) => row.k === headKey);
      if (!head) return undefined;
      const entries = rows.filter((row) => row.k.startsWith(prefix));
      const body: Record<string, unknown> = { ...(isRecord(head.v) ? head.v : {}) };
      if (entries.length > 0) {
        const map: Record<string, unknown> = {};
        for (const row of entries) {
          const entry = row.v as { key?: unknown; value?: unknown };
          if (typeof entry?.key === "string") map[entry.key] = entry.value;
        }
        body[options.field] = map;
      }
      return body;
    },
  };
}

/* ── A bare array file (claude-auth-operations.json) ────────────────────── */

function arraySource(options: { name: AccountSourceName; prefix: string; idField: string }): AccountSourceSpec {
  const rawKey = `raw:${options.name}`;
  const headKey = `meta:${options.prefix}`;
  const gapKey = `gap:${options.prefix}`;
  const prefix = `${options.prefix}:`;
  return {
    name: options.name,
    gapKey,
    owns: (key) => key === rawKey || key === headKey || key === gapKey || key.startsWith(prefix),
    toRows: (body) => {
      if (!Array.isArray(body)) return [{ k: rawKey, v: body }];
      const seen = new Set<string>();
      return [
        { k: headKey, v: {} },
        ...body.map((entry, index) => {
          const id = keyable(isRecord(entry) ? entry[options.idField] : null, seen);
          return { k: id ? `${prefix}${id}` : indexKey(options.prefix, index), v: entry };
        }),
      ];
    },
    body: (rows) => {
      const raw = rows.find((row) => row.k === rawKey);
      if (raw) return raw.v;
      if (!rows.some((row) => row.k === headKey)) return undefined;
      return rows.filter((row) => row.k.startsWith(prefix)).map((row) => row.v);
    },
  };
}

/* ── The mutation revision: no rows; the collection revision is its value ── */

const mutationRevisionSource: AccountSourceSpec = {
  name: MUTATION_REVISION_SOURCE,
  gapKey: "gap:revision",
  owns: () => false,
  toRows: () => [],
  body: (_rows, context) => ({ version: 1, revision: context.revision }),
};

const claudeAccountsSource = registrySource(CLAUDE_ACCOUNTS_SOURCE, "claude");

const bindingsSource = listSource({
  name: BINDINGS_SOURCE,
  field: "bindings",
  prefix: "binding",
  entryKey: (entry, seen) => {
    if (!isRecord(entry)) return null;
    const { engine, accountId, project } = entry;
    if ((engine !== "claude" && engine !== "codex")
      || typeof accountId !== "string" || !accountId || accountId.includes("#")
      || typeof project !== "string" || !project) return null;
    /* Engine and account id carry no `:`, so the project — which may — is the
       unambiguous tail of the key. */
    return keyable(`${engine}:${accountId}:${project}`, seen);
  },
});

const overridesSource = listSource({
  name: OVERRIDES_SOURCE,
  field: "overrides",
  prefix: "override",
  /* The journal is an append-and-trim log with no id of its own. A monotonic
     sequence keys it ({@link sequencedOverrides}), so a trim deletes the
     oldest rows instead of renumbering every one of them. */
  entryKey: () => null,
});

const fencesSource = mapSource({ name: FENCES_SOURCE, field: "fences", prefix: "fence" });
const codexLoginSource = mapSource({ name: CODEX_LOGIN_SOURCE, field: "attempts", prefix: "login" });
const claudeLoginSource = arraySource({ name: CLAUDE_LOGIN_SOURCE, prefix: "authop", idField: "operationId" });

const SOURCES: readonly AccountSourceSpec[] = [
  claudeAccountsSource,
  registrySource(CODEX_ACCOUNTS_SOURCE, "codex"),
  bindingsSource,
  overridesSource,
  fencesSource,
  mutationRevisionSource,
  claudeLoginSource,
  codexLoginSource,
];

/** The file the import helper drives; the other seven are its siblings. */
export const PRIMARY_ACCOUNT_SOURCE: AccountSourceName = CLAUDE_ACCOUNTS_SOURCE;

export const ACCOUNT_SOURCE_NAMES: readonly AccountSourceName[] = SOURCES.map((source) => source.name);

function sourceSpec(name: AccountSourceName): AccountSourceSpec {
  const found = SOURCES.find((source) => source.name === name);
  if (!found) throw new Error(`unknown account source: ${name}`);
  return found;
}

/** Every source retired beside the primary. The mutation revision is retired
    with them but never merged: it holds no rows, and it is the marker a
    roll-forward reads to decide whether a row the file lacks was deleted. */
function mergeableSiblings(): readonly AccountSourceSpec[] {
  return SOURCES.filter((source) => source.name !== PRIMARY_ACCOUNT_SOURCE && source.name !== MUTATION_REVISION_SOURCE);
}

function siblingNames(): readonly AccountSourceName[] {
  return ACCOUNT_SOURCE_NAMES.filter((name) => name !== PRIMARY_ACCOUNT_SOURCE);
}

/* ── The collection ────────────────────────────────────────────────────── */

export function accountsStateDirectory(): string {
  return stateDir();
}

export function accountSourcePath(name: AccountSourceName, directory = accountsStateDirectory()): string {
  return path.join(directory, name);
}

export function accountsDatabasePath(directory = accountsStateDirectory()): string {
  return legacyDatabasePath(accountSourcePath(PRIMARY_ACCOUNT_SOURCE, directory));
}

/** The state directory is the operator's, and a store write may be the first
    thing to need it; 0700 because that is what every account writer created
    it with before the move. */
function ensureStateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function isAccountRow(value: unknown): value is AccountStateRow {
  return isRecord(value) && typeof value.k === "string" && Boolean(value.k) && Object.hasOwn(value, "v");
}

/* Cached per database, and validated against the file's identity rather than
   its name: a test that removes its state directory and starts over must not
   be served by a connection to the file that used to be there. */
const collections = new Map<string, { identity: string; collection: SqliteStateCollection<AccountStateRow> }>();

function databaseIdentity(database: string): string {
  try {
    const stat = fs.statSync(database);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "absent";
  }
}

function cachedCollection(database: string): SqliteStateCollection<AccountStateRow> | null {
  const held = collections.get(database);
  return held && held.identity === databaseIdentity(database) ? held.collection : null;
}

function openAccountCollection(database: string): SqliteStateCollection<AccountStateRow> {
  const cached = cachedCollection(database);
  if (cached) return cached;
  const collection = new SqliteStateCollection<AccountStateRow>(database, {
    collection: ACCOUNTS_COLLECTION,
    schemaVersion: 1,
    busyMessage: ACCOUNTS_BUSY,
    key: (row) => row.k,
    decode: (value) => (isAccountRow(value) ? value : null),
    clone: (row) => structuredClone(row),
    strictDecode: true,
    decodeError: (error) => new Error("invalid persisted account row", { cause: error }),
  });
  collections.set(database, { identity: databaseIdentity(database), collection });
  return collection;
}

/** The collection for `directory`, importing the legacy files on first use.
    Null only for a read before the import may run (a release that has not been
    promoted): the caller then reads its own legacy file. */
function accountCollection(directory: string, purpose: "read" | "write"): SqliteStateCollection<AccountStateRow> | null {
  const database = accountsDatabasePath(directory);
  const cached = cachedCollection(database);
  if (cached) return cached;
  ensureStateDirectory(directory);
  const primary = accountSourcePath(PRIMARY_ACCOUNT_SOURCE, directory);
  if (!readStateImport(database, ACCOUNTS_COLLECTION)) {
    if (!legacyImportAllowed(primary)) {
      if (purpose === "read") return null;
      throw new FileTransactionBusyError("account state is waiting for release promotion");
    }
    importLegacyAccounts(directory, { reconcile: lazyReconcileAllowed(primary) });
  }
  return openAccountCollection(database);
}

/** Drops this process's cached handles. Tests that rebuild a state directory
    under one path call it; nothing in the product does. */
export function resetAccountCollectionsForTests(): void {
  collections.clear();
}

/**
 * The account mutation revision (#1870): every account write advances it in
 * the same transaction as the write it admits, which is what makes a removal
 * and its journal step one commit. 0 before the import.
 */
export function accountsCollectionRevision(directory = accountsStateDirectory()): number {
  const collection = accountCollection(directory, "read");
  return collection ? collection.revision() : 0;
}

export type AccountSourceRead =
  /** The store as the collection holds it. `undefined` is an empty store, the
      state an absent legacy file always meant. */
  | { kind: "collection"; body: unknown | undefined }
  /** This store's legacy file could not be read at the import and its contents
      were never recovered. Empty is NOT the answer: a binding record read as
      empty is every fence it held disappearing in the one condition where it
      matters most, so each owner decides — refuse, or report nothing when
      nothing consults it. Cleared by the first successful write. */
  | { kind: "gap"; reason: string; preservedAs: string | null }
  /** The import has not run and this process may not run it. The caller reads
      its own legacy file, with its own errno handling. */
  | { kind: "legacy" };

/** One account store's legacy body, rebuilt from the collection. */
export function readAccountSource(name: AccountSourceName, directory = accountsStateDirectory()): AccountSourceRead {
  const collection = accountCollection(directory, "read");
  if (!collection) return { kind: "legacy" };
  const spec = sourceSpec(name);
  /* The collection speaks for a store only once that store's legacy file has
     been retired. A file still sitting at its own path with nothing on record
     for it is a store whose import did not finish — a read that could not be
     completed (EACCES, EIO), most often — and answering "empty" for it is the
     store's content disappearing. The caller reads its own file instead, with
     its own errno handling, exactly as it did before the move. */
  if (!collection.snapshot().some((row) => spec.owns(row.k)) && legacyFileStillHoldsTheRecord(name, directory)) {
    return { kind: "legacy" };
  }
  const gap = collection.get(spec.gapKey);
  if (gap) {
    const recorded = isRecord(gap.v) ? gap.v : {};
    return {
      kind: "gap",
      reason: typeof recorded.reason === "string" ? recorded.reason : "the record could not be read",
      preservedAs: typeof recorded.preservedAs === "string" ? recorded.preservedAs : null,
    };
  }
  return { kind: "collection", body: sourceBody(collection, spec) };
}

/**
 * Ids the engine's registry records as retired. Read here rather than by
 * parsing the registry file, which is the one reader outside this module's
 * owners (`AgentRegistry.beginSpawnRequest`, which refuses a launch on a
 * retired account) and would see the tombstone after the move.
 */
export function retiredAccountIds(engine: "claude" | "codex", directory = accountsStateDirectory()): Set<string> {
  const read = readAccountSource(engine === "claude" ? CLAUDE_ACCOUNTS_SOURCE : CODEX_ACCOUNTS_SOURCE, directory);
  const body = read.kind === "collection" ? read.body : readLegacyRegistryFile(engine, directory);
  const retired = isRecord(body) ? body.retired : null;
  if (!Array.isArray(retired)) return new Set();
  return new Set(retired.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])));
}

function readLegacyRegistryFile(engine: "claude" | "codex", directory: string): unknown {
  const file = accountSourcePath(engine === "claude" ? CLAUDE_ACCOUNTS_SOURCE : CODEX_ACCOUNTS_SOURCE, directory);
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as unknown; }
  catch { return null; }
}

function legacyFileStillHoldsTheRecord(name: AccountSourceName, directory: string): boolean {
  try { return !fs.lstatSync(accountSourcePath(name, directory)).isDirectory(); }
  catch { return false; }
}

function sourceBody(collection: SqliteStateCollection<AccountStateRow>, spec: AccountSourceSpec): unknown | undefined {
  return spec.body(collection.snapshot().filter((row) => spec.owns(row.k)), { revision: collection.revision() });
}

/**
 * Replace one account store's rows with `body`, in one transaction. Only the
 * rows that changed are written, and the rows the body no longer holds are
 * deleted in the same commit, so a removal and its journal step land together
 * and the collection revision — the account mutation revision — advances once.
 */
export function writeAccountSource(name: AccountSourceName, body: unknown, directory = accountsStateDirectory()): void {
  mutateAccountSource(name, () => body, directory);
}

/** Delete every row of one account store, which is the state its legacy file's
    absence always meant. */
export function clearAccountSource(name: AccountSourceName, directory = accountsStateDirectory()): void {
  const collection = accountCollection(directory, "write")!;
  const spec = sourceSpec(name);
  collection.patchSync(() => ({
    records: [],
    deleteKeys: collection.snapshot().filter((row) => spec.owns(row.k)).map((row) => row.k),
  }));
}

/**
 * One serialized read-modify-write over an account store: `mutate` receives the
 * committed body under the collection lease and returns the next one, so an
 * append-and-trim journal cannot lose an entry to a concurrent append the way a
 * read outside the transaction could. `undefined` from `mutate` skips the write.
 */
export function mutateAccountSource(
  name: AccountSourceName,
  mutate: (body: unknown | undefined) => unknown,
  directory = accountsStateDirectory(),
): void {
  const collection = accountCollection(directory, "write")!;
  const spec = sourceSpec(name);
  collection.patchSync(() => {
    const current = collection.snapshot();
    const next = mutate(spec.body(current.filter((row) => spec.owns(row.k)), { revision: collection.revision() }));
    if (next === undefined) return { records: [] };
    const records = spec === overridesSource ? sequencedOverrides(current, next) : spec.toRows(next);
    const nextKeys = new Set(records.map((row) => row.k));
    const deleteKeys = current.filter((row) => spec.owns(row.k) && !nextKeys.has(row.k)).map((row) => row.k);
    return { records, deleteKeys };
  });
}

/**
 * The override journal keyed by a monotonic sequence. The body arrives as the
 * whole list, the way the legacy file held it: entries already on record keep
 * their sequence — matched from the oldest end, which is the only end the
 * capacity trim removes from — and the rest take the next numbers.
 */
function sequencedOverrides(current: readonly AccountStateRow[], body: unknown): AccountStateRow[] {
  const rows = overridesSource.toRows(body);
  const entries = rows.filter((row) => row.k.startsWith(OVERRIDE_PREFIX));
  const head = rows.filter((row) => !row.k.startsWith(OVERRIDE_PREFIX));
  const held = current.filter((row) => row.k.startsWith(OVERRIDE_PREFIX));
  let next = held.reduce((highest, row) => Math.max(highest, Number(row.k.slice(OVERRIDE_PREFIX.length)) || 0), 0);
  let aligned = 0;
  while (aligned < held.length && aligned < entries.length
    && JSON.stringify(held[aligned]!.v) === JSON.stringify(entries[aligned]!.v)) aligned += 1;
  return [
    ...head,
    ...entries.map((row, index) => index < aligned
      ? { k: held[index]!.k, v: row.v }
      : { k: `${OVERRIDE_PREFIX}${String((next += 1)).padStart(SEQ_WIDTH, "0")}`, v: row.v }),
  ];
}

/* ── Import (§6.2) ─────────────────────────────────────────────────────── */

/**
 * Digests of the sibling files the rows on record were last taken from, kept on
 * one row so a boot after a crash — or after a rollback release ran on the
 * mirror — can tell a sibling nobody touched from one that was rewritten,
 * without merging and raising an incident for the first. Empty once every
 * sibling is retired behind its tombstone.
 */
const SOURCE_DIGEST_KEY = "meta:sources";

type SourceDigests = Record<string, string>;

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

type SiblingRead =
  | { kind: "absent" }
  | { kind: "tombstone" }
  | { kind: "unreadable"; reason: string; digest: string | null }
  | { kind: "body"; body: unknown; digest: string };

/**
 * Read one sibling. Absence is established by an `lstat` that reports nothing
 * at the path, never by a failed read: `readFileSync` answers ENOENT for a
 * pathname with nothing at it AND for a dangling symlink, and a store read as
 * absent is a store read as "nobody configured anything" — the fence
 * disappearing exactly where it matters. An I/O error that may be transient
 * (EIO, EACCES) is a busy error and is retried later; it never imports empty.
 */
function readSibling(file: string): SiblingRead {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw new FileTransactionBusyError(`legacy account state is unreadable for now: ${(error as Error).message}`);
  }
  if (stat.isDirectory()) return { kind: "tombstone" };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    /* An entry IS there and this read produced nothing: a dangling link, most
       often, which is damage rather than absence. */
    if (code === "ENOENT" || code === "ELOOP") return { kind: "unreadable", reason: `the record could not be read (${code})`, digest: null };
    throw new FileTransactionBusyError(`legacy account state is unreadable for now: ${(error as Error).message}`);
  }
  const digest = sha256(bytes);
  try {
    return { kind: "body", body: JSON.parse(bytes.toString("utf8")) as unknown, digest };
  } catch {
    return { kind: "unreadable", reason: `the record is not valid JSON (${bytes.length} bytes)`, digest };
  }
}

function gapRow(spec: AccountSourceSpec, reason: string, preservedAs: string | null): AccountStateRow {
  return { k: spec.gapKey, v: { reason, preservedAs, at: new Date().toISOString() } };
}

function readSourceDigests(rows: readonly AccountStateRow[]): SourceDigests {
  const row = rows.find((entry) => entry.k === SOURCE_DIGEST_KEY);
  return isRecord(row?.v) ? row.v as SourceDigests : {};
}

function timestampTag(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function freeName(base: string): string {
  return fs.existsSync(base) ? `${base}-${timestampTag()}` : base;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** Rename a sibling aside and leave the same tombstone directory the helper
    leaves for the primary, so an old-release writer fails with EISDIR. */
function retireSibling(file: string, tag: string): void {
  if (fs.existsSync(file) && !fs.lstatSync(file).isDirectory()) {
    fs.renameSync(file, freeName(`${file}.imported-${tag}`));
  }
  fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  const readme = path.join(file, "README");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      `${path.basename(file)} moved into SQLite.`,
      `It now lives in the "${ACCOUNTS_COLLECTION}" collection of state.sqlite in this directory.`,
      "This directory stands in its place so that an older release fails visibly instead of writing a file nothing reads.",
      "",
    ].join("\n"), { mode: 0o600 });
  }
  fsyncDirectory(path.dirname(file));
}

/** Take every sibling's own write-transaction lock, in a fixed order, so no
    legacy writer of any account store can interleave with what runs inside. */
function withSiblingLocks<T>(directory: string, operation: () => T): T {
  const files = siblingNames().map((name) => accountSourcePath(name, directory)).sort();
  const run = (index: number): T => index >= files.length
    ? operation()
    : withFileTransactionSync(files[index]!, ACCOUNTS_BUSY, () => run(index + 1));
  return run(0);
}

/** The import spec the helper drives. `directory` is resolved per call, so a
    test's state directory and the live one never share a spec. */
function accountsLegacyCollection(directory: string): LegacyCollectionSpec<unknown> {
  return {
    collection: ACCOUNTS_COLLECTION,
    schemaVersion: 1,
    migrationId: ACCOUNTS_MIGRATION_ID,
    legacyPath: accountSourcePath(PRIMARY_ACCOUNT_SOURCE, directory),
    parse: (raw) => raw,
    toRows: (body): StateImportRow[] => {
      const rows = [...claudeAccountsSource.toRows(body)];
      const digests: SourceDigests = {};
      for (const source of mergeableSiblings()) {
        /* A store whose file could not be read is NOT imported as empty; the
           gap it leaves is recorded by `settleSiblings`, which is the one
           place that sees every sibling — including when the primary is
           absent and this function never runs. */
        const read = readSibling(accountSourcePath(source.name, directory));
        if (read.kind !== "body") continue;
        digests[source.name] = read.digest;
        rows.push(...source.toRows(read.body));
      }
      rows.push({ k: SOURCE_DIGEST_KEY, v: digests });
      return rows.map((row) => ({ key: row.k, value: row, controllerActive: true }));
    },
    repairs: () => {
      const unreadable = mergeableSiblings()
        .filter((source) => readSibling(accountSourcePath(source.name, directory)).kind === "unreadable")
        .map((source) => source.name);
      return unreadable.length
        ? `${unreadable.length} account store${unreadable.length === 1 ? "" : "s"} could not be read and is recorded as a gap: ${unreadable.join(", ")}`
        : null;
    },
    reconcile: (body, baseline, options) => {
      const collection = openAccountCollection(accountsDatabasePath(directory));
      const summary = emptySummary();
      mergeRows(collection, claudeAccountsSource, claudeAccountsSource.toRows(body), baseline,
        descendsFromMirror(directory, baseline), options, summary);
      return summary;
    },
    mirrorBody: () => {
      const collection = openAccountCollection(accountsDatabasePath(directory));
      let mirror: { body: unknown; revision: number } | null = null;
      collection.checkpointMirror((rows, revision) => {
        mirror = {
          body: claudeAccountsSource.body(rows.filter((row) => claudeAccountsSource.owns(row.k)), { revision }) ?? {},
          revision,
        };
      });
      return mirror!;
    },
  };
}

/**
 * Import every account store once, verified, and retire each file behind a
 * tombstone. The helper owns `claude-accounts.json`; the locks, rows,
 * retirement and reconcile of the other seven are owned here, so all eight land
 * in one collection through one verified transaction.
 */
export function importLegacyAccounts(
  directory = accountsStateDirectory(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  ensureStateDirectory(directory);
  return withSiblingLocks(directory, () => {
    const database = accountsDatabasePath(directory);
    const imported = readStateImport(database, ACCOUNTS_COLLECTION) !== null;
    const outcome = importLegacyCollection(accountsLegacyCollection(directory), options);
    /* The siblings are read inside the helper's verified transaction and
       retired after it commits. A crash in between leaves them on disk under
       the digests the import recorded, and the next boot finishes here without
       a second import: the helper's own crash seams, applied to the other
       seven. A lazy open under a release target does not retire, because the
       rollback release is running on those files. */
    if (!imported || options.reconcile) settleSiblings(directory, outcome.record, !imported);
    return outcome;
  });
}

/**
 * Retire the siblings, folding back first anything a rollback release or an
 * old writer left in one of them.
 *
 * `firstImport` says this ran with the import that just committed. The helper
 * reads the primary and hands its body to `toRows`, which reads the siblings in
 * the same verified transaction — but only when `claude-accounts.json` itself
 * is a file. An install that has siblings and no Claude registry therefore
 * arrives here with them still unimported, and they are folded in through the
 * same merge. That is the import of those stores, not a rollback, and it says
 * so rather than reporting a release that never ran.
 */
function settleSiblings(directory: string, record: StateImportRecord, firstImport: boolean): void {
  const collection = openAccountCollection(accountsDatabasePath(directory));
  const tag = record.release ?? timestampTag();
  const held = readSourceDigests(collection.snapshot());
  const changed: { spec: AccountSourceSpec; body: unknown }[] = [];
  const unreadable: string[] = [];
  /* Every sibling is tombstoned, present or not: a path left empty is a path
     an old release writes a fresh store to, which nothing would read. */
  const gaps: AccountStateRow[] = [];
  const rows = collection.snapshot();
  for (const spec of mergeableSiblings()) {
    const file = accountSourcePath(spec.name, directory);
    const read = readSibling(file);
    if (read.kind === "unreadable") {
      /* Bytes nobody could parse, or a pathname holding an entry no read can
         produce anything from (a dangling link). The file is kept and the gap
         goes on record: a store read as empty here is a fence disappearing. */
      const preservedAs = freeName(`${file}.unreadable-${timestampTag()}`);
      fs.renameSync(file, preservedAs);
      fsyncDirectory(path.dirname(file));
      gaps.push(gapRow(spec, read.reason, path.basename(preservedAs)));
      unreadable.push(spec.name);
    } else if (read.kind === "body" && read.digest !== held[spec.name]) {
      changed.push({ spec, body: read.body });
    } else if (read.kind === "tombstone" && firstImport && !rows.some((row) => spec.owns(row.k))) {
      /* The file was retired into a database that no longer holds its rows. */
      gaps.push(gapRow(spec, "the record was retired into a database that no longer holds it", null));
    }
    /* The tombstone is restored even when it is already there: `mkdir` on a
       dangling symlink refuses, so the entry is cleared first. */
    try { retireSibling(file, tag); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fs.rmSync(file, { force: true });
      retireSibling(file, tag);
    }
  }
  const descends = descendsFromMirror(directory, record);
  retireSibling(accountSourcePath(MUTATION_REVISION_SOURCE, directory), tag);
  for (const { spec, body } of changed) {
    const summary = emptySummary();
    mergeRows(collection, spec, spec.toRows(body), record, descends, { fenceOwner: false }, summary);
    if (firstImport) {
      console.error(`[state import] ${ACCOUNTS_COLLECTION}: imported ${summary.added} row(s) from ${spec.name}`);
      continue;
    }
    console.error(`[state import] legacy-reconciled ${ACCOUNTS_COLLECTION}: ${spec.name} changed after the import `
      + `(a rollback release or an older writer); merged ${summary.added} added, ${summary.replaced} replaced and `
      + `${summary.removed} removed rows, kept ${summary.kept} rows changed since the mirror`
      + (summary.spared.length ? `; the file does not descend from the recorded mirror, so no row was deleted (${summary.spared.length} spared)` : ""));
  }
  for (const name of unreadable) {
    console.error(`[state import] legacy-unreadable ${ACCOUNTS_COLLECTION}: ${name} reappeared unreadable after the import; `
      + "kept aside, the collection is unchanged");
  }
  /* The primary's gap is recorded by the helper in `state_imports`; give it a
     row too, so it reads like every other store and the first successful write
     clears it. */
  if (firstImport && record.gap === "legacy-unreadable") {
    gaps.push(gapRow(claudeAccountsSource, "the record is not valid JSON", newestPreservedCopy(directory, PRIMARY_ACCOUNT_SOURCE)));
  }
  if (gaps.length > 0 || Object.keys(held).length > 0) {
    collection.patchSync(() => ({ records: [...gaps, { k: SOURCE_DIGEST_KEY, v: {} }] }));
  }
}

/** The newest `<name>.unreadable-*` copy kept beside a retired store. */
function newestPreservedCopy(directory: string, name: AccountSourceName): string | null {
  const prefix = `${name}.unreadable-`;
  const kept = fs.readdirSync(directory).filter((entry) => entry.startsWith(prefix)).sort();
  return kept.at(-1) ?? null;
}

/* ── Reconcile (§6.2 step 6) ───────────────────────────────────────────── */

function emptySummary(): LegacyReconcileSummary {
  return { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
}

/**
 * Whether a legacy file set provably descends from the recorded rollback
 * mirror, which is what makes a row it lacks a deletion rather than a file an
 * old writer created out of nothing.
 *
 * The carried marker is `account-mutation-revision.json`. Every account write
 * in every release advances it, and the demotion mirror writes it from the
 * collection revision, so a file set whose revision is at or past the recorded
 * mirror's revision is one that read that mirror and kept counting. A file set
 * without it deletes nothing.
 */
function descendsFromMirror(directory: string, record: StateImportRecord): boolean {
  if (record.mirrorRevision === null) return false;
  const read = readSibling(accountSourcePath(MUTATION_REVISION_SOURCE, directory));
  if (read.kind !== "body" || !isRecord(read.body)) return false;
  const revision = read.body.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= record.mirrorRevision;
}

/**
 * Merge one source's rows from a legacy file that changed after the import.
 * Account rows carry no revision of their own, so who changed a row is read
 * from its last-written collection revision: a row SQLite has not rewritten
 * since the mirror is the file's to change, and one it has rewritten stays and
 * is reported as a conflict.
 */
function mergeRows(
  collection: SqliteStateCollection<AccountStateRow>,
  spec: AccountSourceSpec,
  incoming: readonly AccountStateRow[],
  baseline: StateImportRecord,
  descends: boolean,
  options: { fenceOwner: boolean },
  summary: LegacyReconcileSummary,
): void {
  const since = legacyBaselineRevision(baseline);
  collection.patchSync(() => {
    const current = new Map(collection.snapshot().filter((row) => spec.owns(row.k)).map((row) => [row.k, row] as const));
    const revisions = collection.rowRevisions();
    const records: AccountStateRow[] = [];
    const incomingKeys = new Set(incoming.map((row) => row.k));
    for (const row of incoming) {
      const held = current.get(row.k);
      if (!held) {
        records.push(row);
        summary.added += 1;
        summary.keys.push(row.k);
        continue;
      }
      if (JSON.stringify(held.v) === JSON.stringify(row.v)) continue;
      if ((revisions.get(row.k) ?? 0) > since) {
        summary.conflicts.push(row.k);
        summary.kept += 1;
        continue;
      }
      records.push(row);
      summary.replaced += 1;
      summary.keys.push(row.k);
    }
    const deleteKeys: string[] = [];
    for (const key of current.keys()) {
      if (incomingKeys.has(key)) continue;
      if (!descends) {
        summary.spared.push(key);
        continue;
      }
      if ((revisions.get(key) ?? 0) > since) {
        summary.conflicts.push(key);
        summary.kept += 1;
        continue;
      }
      deleteKeys.push(key);
      summary.removed += 1;
      summary.keys.push(key);
    }
    return { records, deleteKeys };
  }, { fenceOwner: options.fenceOwner });
}

/* ── Rollback mirror (§6.4) ────────────────────────────────────────────── */

/**
 * Write every account store's legacy file from one SQLite revision, so a
 * rollback release that predates this slice runs on its JSON. Each sibling's
 * tombstone is removed and its body written durably from one checkpoint; the
 * digests of what was written go on record, so a roll-forward that finds the
 * mirror untouched retires it without a merge. The primary goes through the
 * helper, which folds back anything an older writer left and records the
 * mirror's revision — and `account-mutation-revision.json` is written last,
 * from that same revision, because it is the marker the roll-forward reads.
 */
export function checkpointAccountRollbackMirrorsForDemotion(directory = accountsStateDirectory()): void {
  const database = accountsDatabasePath(directory);
  if (!readStateImport(database, ACCOUNTS_COLLECTION)) return;
  ensureStateDirectory(directory);
  withSiblingLocks(directory, () => {
    const collection = openAccountCollection(database);
    const digests: SourceDigests = {};
    let primary: unknown;
    collection.checkpointMirrorForDemotion((rows, revision) => {
      for (const spec of mergeableSiblings()) {
        writeSiblingMirror(accountSourcePath(spec.name, directory),
          spec.body(rows.filter((row) => spec.owns(row.k)), { revision }), digests, spec.name);
      }
      primary = claudeAccountsSource.body(rows.filter((row) => claudeAccountsSource.owns(row.k)), { revision });
    });
    if (JSON.stringify(readSourceDigests(collection.snapshot())) !== JSON.stringify(digests)) {
      collection.patchSync(() => ({ records: [{ k: SOURCE_DIGEST_KEY, v: digests }] }), { fenceOwner: true });
    }
    /* A store the collection holds nothing for leaves its path EMPTY rather
       than tombstoned: an install that never had the file is what the rollback
       release must find, and a tombstone would fail it with EISDIR. */
    if (primary === undefined) {
      clearTombstone(accountSourcePath(PRIMARY_ACCOUNT_SOURCE, directory));
      recordStateImportMirror(database, ACCOUNTS_COLLECTION, null, collection.revision());
    } else {
      writeLegacyRollbackMirror(accountsLegacyCollection(directory));
    }
    const revision = readStateImport(database, ACCOUNTS_COLLECTION)?.mirrorRevision ?? collection.revision();
    writeSiblingMirror(accountSourcePath(MUTATION_REVISION_SOURCE, directory),
      mutationRevisionSource.body([], { revision }), {}, MUTATION_REVISION_SOURCE);
  });
}

function clearTombstone(file: string): void {
  try { if (fs.lstatSync(file).isDirectory()) fs.rmSync(file, { recursive: true, force: true }); }
  catch { /* nothing at the path */ }
}

function writeSiblingMirror(file: string, body: unknown, digests: SourceDigests, name: string): void {
  clearTombstone(file);
  if (body === undefined) return;
  writeJsonDurably(file, body);
  const read = readSibling(file);
  if (read.kind === "body") digests[name] = read.digest;
}
