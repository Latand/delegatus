import fs from "node:fs";

import { cachedJsonFile, type CachedJsonFile } from "@/lib/state/cachedJsonFile";

import { projectAliasResolver, recordedProjectRemotes } from "@/lib/projects/aliases";
import { projectStoreSignature } from "@/lib/projects/persistence";
import { WORKTREE_RECOVERY_COLLECTION } from "@/lib/projects/worktreeRecoveryStore";
import { statePath } from "@/lib/configDir";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { LegacyDocumentStore, type DocumentRow } from "@/lib/state/legacyDocumentStore";
import {
  lazyReconcileAllowed,
  legacyDatabasePath,
  legacyImportAllowed,
  type LegacyImportHooks,
  type LegacyImportOutcome,
} from "@/lib/state/legacyImport";
import { stateLockAttempt } from "@/lib/state/lockWait";
import { readStateCollectionRevision, readStateImport, SqliteStateCollection } from "@/lib/state/sqliteStateStore";

import { githubRepositoryOfRemote, type CachedPullRequest, type ForgeCacheView, type ForgeRepositoryView, type PullRequestState, type ProposalIssue } from "./workLinks";

/*
 * The forge cache (#2059, docs/design/pr-issue-chips.md §3.3): what the Viewer
 * last read from GitHub about each repository's pull requests and proposal
 * issues. One writer, the
 * sweep in `sweep.ts`, plus the stage report's observation of the PR it
 * already looked up. It is read through a snapshot kept per committed
 * revision, so a board read costs two `stat` calls and a few map lookups, and
 * it is never sent to the browser: only resolved links are.
 *
 * It lives in the `forge_links` collection of `state.sqlite`, moved out of
 * `forge-links.json`, which every sweep rewrote whole for each repository it
 * read (2.6 MB on a busy installation, almost all of it two repositories'
 * pull requests). One row per key:
 *
 *   repo:<name>             the repository's sweep record, without its lists
 *   proposals:<name>        its proposal-issue page
 *   pr:<name>#<number>      one pull request
 *   issue:<name>#<number>   one number a per-number read found is no PR
 *
 * A write stores the rows that changed: a sweep page rewrites the pull
 * requests it read and the repository's record, never the rest of its history.
 */

export type ForgeSweepError = "timed-out" | "command-failed" | "malformed-output";

export type StoredPullRequest = Omit<CachedPullRequest, "number">;
export const PROPOSAL_ISSUE_LIMIT = 40;
export type ProposalIssueSnapshot = { checkedAt: string; issues: ProposalIssue[] };

/** The sweep and persisted reader share the same bounded representation. */
export function proposalIssueSnapshot(value: unknown): ProposalIssueSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<ProposalIssueSnapshot>;
  if (typeof snapshot.checkedAt !== "string" || !Number.isFinite(Date.parse(snapshot.checkedAt)) || !Array.isArray(snapshot.issues)) return null;
  const issues: ProposalIssue[] = [];
  for (const row of snapshot.issues.slice(0, PROPOSAL_ISSUE_LIMIT)) {
    if (!row || !Number.isSafeInteger(row.number) || row.number <= 0 || typeof row.title !== "string"
      || !Array.isArray(row.labels) || row.labels.slice(0, 20).some(label => typeof label !== "string")
      || (row.updatedAt !== null && (typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))))) return null;
    issues.push({ number: row.number, title: row.title.slice(0, 200), labels: row.labels.slice(0, 20).map(label => label.slice(0, 60)),
      updatedAt: row.updatedAt, checkedAt: snapshot.checkedAt });
  }
  return { checkedAt: snapshot.checkedAt, issues };
}

export type ForgeRepositoryEntry = {
  /** The name GitHub answers with, learned from the PR URLs it returns. A
      renamed repository is still named the old way on records, and a search
      under the old name answers nothing at all. */
  canonical: string | null;
  /** Every PR created before this instant is in `prs`. Null until the first
      complete read, and reset when a sweep cannot prove it overlapped the
      previous one. */
  completeSince: string | null;
  /** When the last successful sweep started, which the next one's page must
      reach back to. */
  lastSweepAt: string | null;
  /** When a sweep was last tried, successful or not. */
  lastAttemptAt: string | null;
  /** Coarse, as githubEvidence.ts reports it: never gh's stderr. */
  lastError: ForgeSweepError | null;
  prs: Record<string, StoredPullRequest>;
  /** Numbers a per-number read found are not pull requests. */
  issues: Record<string, { checkedAt: string }>;
  /** One replaceable page, independent of PR history and issue membership. */
  proposals?: ProposalIssueSnapshot;
  /** A full read since `headRefOid` was added has run, so every merged PR in
      `prs` carries its head commit. An entry without it is read in full once. */
  headRefOids?: true;
};

export type ForgeCacheFile = {
  schemaVersion: 1;
  repositories: Record<string, ForgeRepositoryEntry>;
};

const EMPTY_FILE = (): ForgeCacheFile => ({ schemaVersion: 1, repositories: {} });

export function emptyRepositoryEntry(): ForgeRepositoryEntry {
  return { canonical: null, completeSince: null, lastSweepAt: null, lastAttemptAt: null, lastError: null, prs: {}, issues: {} };
}

export function forgeCacheFile(): string {
  return statePath("forge-links.json");
}

const PR_STATES: ReadonlySet<string> = new Set<PullRequestState>(["open", "draft", "merged", "closed"]);

function validEntry(value: unknown): ForgeRepositoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<ForgeRepositoryEntry>;
  const prs: Record<string, StoredPullRequest> = {};
  for (const [number, pr] of Object.entries(entry.prs && typeof entry.prs === "object" ? entry.prs : {})) {
    if (!pr || typeof pr.url !== "string" || typeof pr.headRefName !== "string" || !PR_STATES.has(pr.state)) continue;
    prs[number] = {
      url: pr.url,
      headRefName: pr.headRefName,
      createdAt: typeof pr.createdAt === "string" ? pr.createdAt : "",
      state: pr.state,
      closes: Array.isArray(pr.closes) ? pr.closes.filter((n): n is number => Number.isSafeInteger(n) && n > 0) : [],
      checkedAt: typeof pr.checkedAt === "string" ? pr.checkedAt : "",
      ...(typeof pr.headRefOid === "string" && pr.headRefOid ? { headRefOid: pr.headRefOid } : {}),
      ...(typeof pr.title === "string" ? { title: pr.title } : {}),
      ...(typeof pr.mergedAt === "string" && pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
    };
  }
  const text = (field: unknown) => (typeof field === "string" && field ? field : null);
  const proposals = proposalIssueSnapshot(entry.proposals);
  return {
    canonical: text(entry.canonical),
    completeSince: text(entry.completeSince),
    lastSweepAt: text(entry.lastSweepAt),
    lastAttemptAt: text(entry.lastAttemptAt),
    lastError: entry.lastError === "timed-out" || entry.lastError === "command-failed" || entry.lastError === "malformed-output" ? entry.lastError : null,
    prs,
    ...(proposals ? { proposals } : {}),
    issues: entry.issues && typeof entry.issues === "object" && !Array.isArray(entry.issues) ? { ...entry.issues } : {},
    ...(entry.headRefOids === true ? { headRefOids: true as const } : {}),
  };
}

function parseBody(parsed: Partial<ForgeCacheFile>): ForgeCacheFile {
  if (parsed.schemaVersion !== 1 || !parsed.repositories || typeof parsed.repositories !== "object") return EMPTY_FILE();
  const repositories: Record<string, ForgeRepositoryEntry> = {};
  for (const [name, entry] of Object.entries(parsed.repositories)) {
    const valid = validEntry(entry);
    if (valid) repositories[name] = valid;
  }
  return { schemaVersion: 1, repositories };
}

function parseFile(raw: string): ForgeCacheFile {
  try {
    return parseBody(JSON.parse(raw) as Partial<ForgeCacheFile>);
  } catch {
    return EMPTY_FILE();
  }
}

type Snapshot = { data: ForgeCacheFile; view: ForgeCacheView };
/* The legacy file, read before the import has run. */
const memoHost = globalThis as typeof globalThis & { __llvForgeFileCache?: CachedJsonFile<Snapshot> };
const cache = memoHost.__llvForgeFileCache ??= cachedJsonFile((raw): Snapshot => {
  const data = parseFile(raw ?? "");
  return { data, view: forgeViewOf(data) };
}, "forge/cache");

/* ------------------------------------------------------- state.sqlite rows */

export const FORGE_LINKS_COLLECTION = "forge_links";
const REPO_PREFIX = "repo:";
const PROPOSALS_PREFIX = "proposals:";
const PR_PREFIX = "pr:";
const ISSUE_PREFIX = "issue:";

type RepositoryRecord = Omit<ForgeRepositoryEntry, "prs" | "issues" | "proposals">;

function repositoryRecord(entry: ForgeRepositoryEntry): RepositoryRecord {
  return {
    canonical: entry.canonical,
    completeSince: entry.completeSince,
    lastSweepAt: entry.lastSweepAt,
    lastAttemptAt: entry.lastAttemptAt,
    lastError: entry.lastError,
    ...(entry.headRefOids === true ? { headRefOids: true as const } : {}),
  };
}

function numberedKey(prefix: string, name: string, number: string): string {
  return `${prefix}${name}#${number}`;
}

function toRows(file: ForgeCacheFile): DocumentRow[] {
  const rows: DocumentRow[] = [];
  for (const [name, entry] of Object.entries(file.repositories)) {
    rows.push({ key: `${REPO_PREFIX}${name}`, value: repositoryRecord(entry) });
    if (entry.proposals) rows.push({ key: `${PROPOSALS_PREFIX}${name}`, value: entry.proposals });
    for (const [number, pr] of Object.entries(entry.prs)) rows.push({ key: numberedKey(PR_PREFIX, name, number), value: pr });
    for (const [number, issue] of Object.entries(entry.issues)) rows.push({ key: numberedKey(ISSUE_PREFIX, name, number), value: issue });
  }
  return rows;
}

/** The repository and number a numbered key names. */
function numbered(key: string, prefix: string): { name: string; number: string } | null {
  const split = key.lastIndexOf("#");
  return split > prefix.length ? { name: key.slice(prefix.length, split), number: key.slice(split + 1) } : null;
}

/** The cache the rows hold, validated as the legacy file was. */
function fromRows(rows: readonly DocumentRow[]): ForgeCacheFile {
  const raw: Record<string, Omit<Partial<ForgeRepositoryEntry>, "prs" | "issues"> & { prs: Record<string, unknown>; issues: Record<string, unknown> }> = {};
  const entry = (name: string) => raw[name] ??= { ...emptyRepositoryEntry(), prs: {}, issues: {} };
  for (const row of rows) {
    if (row.key.startsWith(REPO_PREFIX)) {
      const name = row.key.slice(REPO_PREFIX.length);
      const value = row.value && typeof row.value === "object" && !Array.isArray(row.value) ? row.value as Partial<RepositoryRecord> : {};
      Object.assign(entry(name), value);
    } else if (row.key.startsWith(PROPOSALS_PREFIX)) {
      entry(row.key.slice(PROPOSALS_PREFIX.length)).proposals = row.value as ProposalIssueSnapshot;
    } else if (row.key.startsWith(PR_PREFIX)) {
      const at = numbered(row.key, PR_PREFIX);
      if (at) entry(at.name).prs[at.number] = row.value;
    } else if (row.key.startsWith(ISSUE_PREFIX)) {
      const at = numbered(row.key, ISSUE_PREFIX);
      if (at) entry(at.name).issues[at.number] = row.value;
    }
  }
  return parseBody({ schemaVersion: 1, repositories: raw as unknown as Record<string, ForgeRepositoryEntry> });
}

/** A private copy a writer may change: each repository record and its lists
    are copied, the pull requests themselves are shared and replaced whole. */
function workingCopy(file: ForgeCacheFile): ForgeCacheFile {
  return {
    schemaVersion: 1,
    repositories: Object.fromEntries(Object.entries(file.repositories)
      .map(([name, entry]) => [name, { ...entry, prs: { ...entry.prs }, issues: { ...entry.issues } }])),
  };
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The rows that make `held` hold `next`. A pull request the change did not
    replace is the same object and costs no comparison. */
function rowsPatch(held: ForgeCacheFile, next: ForgeCacheFile): { records: DocumentRow[]; deleteKeys: string[] } {
  const records: DocumentRow[] = [];
  const deleteKeys: string[] = [];
  const empty = emptyRepositoryEntry();
  for (const [name, entry] of Object.entries(next.repositories)) {
    const prior = held.repositories[name];
    if (!prior || !sameJson(repositoryRecord(prior), repositoryRecord(entry))) records.push({ key: `${REPO_PREFIX}${name}`, value: repositoryRecord(entry) });
    if (entry.proposals && !sameJson(prior?.proposals, entry.proposals)) records.push({ key: `${PROPOSALS_PREFIX}${name}`, value: entry.proposals });
    if (!entry.proposals && prior?.proposals) deleteKeys.push(`${PROPOSALS_PREFIX}${name}`);
    for (const [list, prefix] of [["prs", PR_PREFIX], ["issues", ISSUE_PREFIX]] as const) {
      const before = (prior ?? empty)[list] as Record<string, unknown>;
      const after = entry[list] as Record<string, unknown>;
      for (const [number, value] of Object.entries(after)) {
        if (before[number] === value || (Object.hasOwn(before, number) && sameJson(before[number], value))) continue;
        records.push({ key: numberedKey(prefix, name, number), value });
      }
      for (const number of Object.keys(before)) if (!Object.hasOwn(after, number)) deleteKeys.push(numberedKey(prefix, name, number));
    }
  }
  for (const [name, prior] of Object.entries(held.repositories)) {
    if (Object.hasOwn(next.repositories, name)) continue;
    deleteKeys.push(`${REPO_PREFIX}${name}`, ...toRows({ schemaVersion: 1, repositories: { [name]: prior } })
      .map((row) => row.key).filter((key) => !key.startsWith(REPO_PREFIX)));
  }
  return { records, deleteKeys };
}

/* The import, the rollback mirror and the roll-forward merge are the shared
   legacy helper's; reads and writes go through this module's own collection.
   At roll-forward a pull request merges as its newer reading. */
/* Built on first use: a module that reaches this one while the shared helper
   is still loading (the state store's history projection) must not construct
   it then. */
let legacyStoreInstance: LegacyDocumentStore<ForgeCacheFile> | null = null;
function legacyStore(): LegacyDocumentStore<ForgeCacheFile> {
  return legacyStoreInstance ??= new LegacyDocumentStore<ForgeCacheFile>({
    collection: FORGE_LINKS_COLLECTION,
    migrationId: "forge-links-json-v1",
    busyMessage: "forge links state is busy",
    parse: (raw) => parseBody((raw ?? {}) as Partial<ForgeCacheFile>),
    toRows,
    fromRows,
    toFile: (document) => document,
    mergeRow: (key, held, incoming) => {
      if (!key.startsWith(PR_PREFIX) && !key.startsWith(ISSUE_PREFIX)) return undefined;
      const checked = (value: unknown) => String((value as { checkedAt?: unknown } | null)?.checkedAt ?? "");
      return checked(incoming) > checked(held) ? incoming : held;
    },
    readLegacy: (filePath) => {
      try { return parseFile(fs.readFileSync(filePath, "utf8")); }
      catch { return EMPTY_FILE(); }
    },
    error: (message, cause) => new Error(message, { cause }),
  });
}

interface ForgeStoreRuntime {
  collections: Map<string, { identity: string | null; collection: SqliteStateCollection<DocumentRow> }>;
  snapshots: Map<string, { ordered: readonly DocumentRow[]; revision: number; snapshot: Snapshot }>;
}
const runtimeHost = globalThis as typeof globalThis & { __delegatusForgeLinksStoreV1__?: ForgeStoreRuntime };
const runtime = runtimeHost.__delegatusForgeLinksStoreV1__ ??= { collections: new Map(), snapshots: new Map() };

function databaseIdentity(database: string): string | null {
  const stat = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

function isDocumentRow(value: unknown): value is DocumentRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as DocumentRow).key === "string" && (value as DocumentRow).key.length > 0
    && Object.hasOwn(value as object, "value");
}

/** The collection once the legacy file was imported, else null. */
function openCollection(database: string): SqliteStateCollection<DocumentRow> | null {
  const identity = databaseIdentity(database);
  const held = runtime.collections.get(database);
  if (held && held.identity === identity) return held.collection;
  held?.collection.close();
  runtime.collections.delete(database);
  runtime.snapshots.delete(database);
  if (identity === null) return null;
  const marker = stateLockAttempt("state.marker.forge-links", () => readStateImport(database, FORGE_LINKS_COLLECTION), FORGE_LINKS_COLLECTION);
  if (!marker) return null;
  const collection = new SqliteStateCollection<DocumentRow>(database, {
    collection: FORGE_LINKS_COLLECTION,
    schemaVersion: 1,
    busyMessage: "forge links state is busy",
    key: (row) => row.key,
    /* A row that does not decode is dropped, as an invalid entry in the file
       was: the next sweep reads that repository again. */
    decode: (value) => isDocumentRow(value) ? value : null,
    clone: (row) => structuredClone(row),
  });
  runtime.collections.set(database, { identity, collection });
  return collection;
}

/** The committed snapshot, kept per revision. An unchanged database costs the
    revision probe's two `stat` calls. */
function committedSnapshot(database: string, collection: SqliteStateCollection<DocumentRow>): Snapshot {
  const held = runtime.snapshots.get(database);
  const revision = collection.revision();
  if (held && held.revision === revision) return held.snapshot;
  const ordered = collection.loadReadonly();
  if (held?.ordered === ordered) {
    held.revision = revision;
    return held.snapshot;
  }
  const data = fromRows(ordered);
  const snapshot = { data, view: forgeViewOf(data) };
  runtime.snapshots.set(database, { ordered, revision, snapshot });
  return snapshot;
}

/** The collection for a write, importing the legacy file first when this
    process may (no release target, or the activated release). */
function writableCollection(file: string): SqliteStateCollection<DocumentRow> {
  const database = legacyDatabasePath(file);
  const held = openCollection(database);
  if (held) return held;
  if (!legacyImportAllowed(file, database)) throw new FileTransactionBusyError("forge links state is waiting for release promotion");
  legacyStore().importLegacy(file, { reconcile: lazyReconcileAllowed(file, database) });
  const collection = openCollection(database);
  if (!collection) throw new FileTransactionBusyError("forge links state is not imported");
  return collection;
}

/** Import `forge-links.json` now. The Viewer's activation calls this with
    `reconcile: true`. */
export function importLegacyForgeLinks(file = forgeCacheFile(), options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true }): LegacyImportOutcome {
  return legacyStore().importLegacy(file, options);
}

/** Write `forge-links.json` from SQLite for a rollback release that predates
    the move. */
export function checkpointForgeLinksRollbackMirrorForDemotion(file = forgeCacheFile()): void {
  legacyStore().checkpointRollbackMirror(file);
}

/** Index both names of a proven rename together, retaining the freshest PR
    when both names have stored history. Exported for tests and fixtures. */
export function forgeViewOf(data: ForgeCacheFile, aliases: ReadonlyMap<string, string> = new Map()): ForgeCacheView {
  const names = new Map(Object.entries(data.repositories).flatMap(([name, entry]) =>
    entry.canonical ? [[name.toLowerCase(), entry.canonical.toLowerCase()] as const] : []));
  for (const [source, target] of aliases) names.set(source.toLowerCase(), target.toLowerCase());
  const canonical = (name: string) => {
    let current = name.toLowerCase();
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const next = names.get(current);
      if (!next || next === current) return current;
      current = next;
    }
    return name.toLowerCase();
  };
  const groups = new Map<string, ForgeRepositoryEntry[]>();
  for (const [name, entry] of Object.entries(data.repositories)) {
    const key = canonical(name);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const views = new Map<string, ForgeRepositoryView>();
  for (const [name, entries] of groups) {
    const prs = new Map<number, CachedPullRequest>();
    const heads = new Map<string, CachedPullRequest[]>();
    for (const entry of entries) for (const [key, stored] of Object.entries(entry.prs)) {
      const prior = prs.get(Number(key));
      if (prior && prior.checkedAt > stored.checkedAt) continue;
      const pr: CachedPullRequest = { number: Number(key), ...stored };
      prs.set(pr.number, pr);
    }
    for (const pr of prs.values()) {
      const list = heads.get(pr.headRefName) ?? [];
      list.push(pr);
      heads.set(pr.headRefName, list);
    }
    const issues = new Set(entries.flatMap(entry => Object.keys(entry.issues).map(Number)));
    const proposals = entries.flatMap(entry => entry.proposals ? [entry.proposals] : [])
      .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
    const view: ForgeRepositoryView = {
      canonical: name,
      completeSince: entries.map(entry => entry.completeSince).filter((at): at is string => !!at).sort().at(-1) ?? null,
      pr: (number) => prs.get(number),
      byHead: (head) => heads.get(head) ?? [],
      isIssue: (number) => issues.has(number) && !prs.has(number),
      proposalIssues: proposals?.issues ?? [],
    };
    views.set(name, view);
  }
  return { repository: (name) => views.get(canonical(name)) ?? (aliases.has(name.toLowerCase())
    ? { canonical: canonical(name), completeSince: null, pr: () => undefined, byHead: () => [], isIssue: () => false }
    : null) };
}

/** The cache as stored, read again only when it changed. Shared by every
    reader of the same revision: never change it. */
export function readForgeCache(file = forgeCacheFile()): { data: ForgeCacheFile; view: ForgeCacheView } {
  const database = legacyDatabasePath(file);
  const collection = openCollection(database);
  return collection ? committedSnapshot(database, collection) : cache.read(file);
}

// One derived snapshot and one resolved view, replaced when their inputs move.
let aliasMemo: {
  remotes: string;
  projects: string;
  recoveries: number | null;
  aliases: ReadonlyMap<string, string>;
} | null = null;
let resolvedMemo: { data: ForgeCacheFile; aliases: ReadonlyMap<string, string>; view: ForgeCacheView } | null = null;

function repositoryAliases(): ReadonlyMap<string, string> {
  const remotesSignature = projectStoreSignature("project-remotes.json");
  const projectsSignature = projectStoreSignature("project-aliases.json");
  const recoveries = readStateCollectionRevision(statePath("state.sqlite"), WORKTREE_RECOVERY_COLLECTION);
  if (aliasMemo?.remotes === remotesSignature && aliasMemo.projects === projectsSignature && aliasMemo.recoveries === recoveries) return aliasMemo.aliases;
  const remotes = recordedProjectRemotes();
  const project = projectAliasResolver();
  const aliases = new Map<string, string>();
  for (const [key, remote] of Object.entries(remotes)) {
    const source = githubRepositoryOfRemote(remote);
    const target = githubRepositoryOfRemote(remotes[project(key)]);
    if (source && target && source !== target) aliases.set(source, target);
  }
  aliasMemo = { remotes: remotesSignature, projects: projectsSignature, recoveries, aliases };
  return aliases;
}

export function forgeCacheView(file = forgeCacheFile()): ForgeCacheView {
  const { data, view } = readForgeCache(file);
  const aliases = repositoryAliases();
  if (!aliases.size) return view;
  if (resolvedMemo?.data === data && resolvedMemo.aliases === aliases) return resolvedMemo.view;
  const resolved = forgeViewOf(data, aliases);
  resolvedMemo = { data, aliases, view: resolved };
  return resolved;
}

/** Read, change and write the cache, under the collection lease: only the
    rows that changed are written. The caller holds no pipeline or task lock
    and makes no network call inside `change`. */
export function updateForgeCache(change: (data: ForgeCacheFile) => void, file = forgeCacheFile()): ForgeCacheFile {
  const database = legacyDatabasePath(file);
  const collection = writableCollection(file);
  /* Read before the lease, so under it the read takes only what changed since. */
  committedSnapshot(database, collection);
  let next: ForgeCacheFile | null = null;
  collection.patchSync(() => {
    const held = committedSnapshot(database, collection).data;
    const draft = workingCopy(held);
    change(draft);
    next = draft;
    return rowsPatch(held, draft);
  });
  cache.invalidate();
  return next!;
}

/* ── Nudges: a repository whose answer just changed ─────────────────────── */

const nudgeHost = globalThis as typeof globalThis & { __llvForgeNudges?: Map<string, number> };
const nudges = nudgeHost.__llvForgeNudges ??= new Map<string, number>();

/** Ask the next sweep to read `repository` soon, debounced by the sweep. */
export function nudgeForgeSweep(repository: string, at = Date.now()): void {
  nudges.set(repository.toLowerCase(), at);
}

export function clearForgeNudges(repositories: readonly string[]): void {
  for (const repository of repositories) nudges.delete(repository.toLowerCase());
}

export function pendingForgeNudges(): ReadonlyMap<string, number> {
  return nudges;
}

/**
 * The PR a stage report already looked up (`collectStageProvenance`), merged
 * into the cache so the chip appears on the report that published it rather
 * than one sweep later. No network call: the number, URL and head come from
 * the report. A fresher cached state wins, since provenance reports `OPEN` for
 * every PR — a stage reports before its PR merges — and cannot tell a draft.
 */
export function observeForgePullRequest(
  repository: string,
  pullRequest: { url: string; number: number; state: string } | null,
  head: string,
  now: string,
  file = forgeCacheFile(),
): void {
  if (!pullRequest || !Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) return;
  const name = repository.toLowerCase();
  const known = readForgeCache(file).data.repositories[name]?.prs[String(pullRequest.number)];
  nudgeForgeSweep(name);
  if (known && known.headRefName === head) return;
  const state = pullRequest.state.toLowerCase();
  updateForgeCache((data) => {
    const entry = data.repositories[name] ??= emptyRepositoryEntry();
    const prior = entry.prs[String(pullRequest.number)];
    entry.prs[String(pullRequest.number)] = {
      url: prior?.url ?? pullRequest.url,
      headRefName: head || prior?.headRefName || "",
      createdAt: prior?.createdAt ?? now,
      state: prior?.state ?? (PR_STATES.has(state) ? state as PullRequestState : "open"),
      closes: prior?.closes ?? [],
      checkedAt: prior?.checkedAt ?? now,
      ...(prior?.title !== undefined ? { title: prior.title } : {}),
      ...(prior?.mergedAt ? { mergedAt: prior.mergedAt } : {}),
    };
    delete entry.issues[String(pullRequest.number)];
  }, file);
}

export function resetForgeCacheForTests(): void {
  cache.invalidate();
  for (const { collection } of runtime.collections.values()) collection.close();
  runtime.collections.clear();
  runtime.snapshots.clear();
  aliasMemo = null;
  resolvedMemo = null;
  nudges.clear();
}

/** Test seam: an empty cache, as a sweep that never ran finds it. */
export function clearForgeCacheForTests(file = forgeCacheFile()): void {
  const collection = openCollection(legacyDatabasePath(file));
  if (collection) collection.replaceSync([]);
  else fs.rmSync(file, { force: true });
  cache.invalidate();
  runtime.snapshots.clear();
}
