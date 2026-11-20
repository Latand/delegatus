import { MeasuredCache } from "@/lib/cacheTelemetry";
import { stat } from "node:fs/promises";
import path from "node:path";

import { conversationTree, type ConversationBranch } from "@/lib/conversationTree";

import type { FileEntry, Fmt, RootKey, TranscriptEngine } from "../types";
import { claudeSubagentLineage } from "./claudeNative";
import { codexThreadIdFromPath } from "./codexNative";

export interface ConversationCatalogEntry {
  path: string;
  root: RootKey;
  name: string;
  project: string;
  /** Display project for an authorized cross-project Codex subagent family. */
  treeProject?: string;
  projectName?: string;
  sessionStartedAt?: string | null;
  projectUnresolved?: true;
  worktree?: string;
  parent?: string;
  directChildCount?: number;
  nativeParentThreadId?: string | null;
  nativeForkSourceThreadId?: string | null;
  title: string;
  firstPrompt: string;
  engine: TranscriptEngine;
  kind: string;
  fmt: Fmt;
  /** Unix seconds. */
  mtime: number;
  size: number;
}

export interface ConversationCatalogPage {
  items: ConversationCatalogEntry[];
  nextCursor: string | null;
  total: number;
  projectTotal?: number;
}

export interface ConversationListPage {
  items: FileEntry[];
  nextCursor: string | null;
  total: number;
  projectTotal?: number;
}

export type ConversationStat = (pathname: string) => Promise<{ size: number; mtimeMs: number }>;
export type ConversationMetadataHydrator = (entry: ConversationCatalogEntry) => ConversationCatalogEntry | Promise<ConversationCatalogEntry>;

export interface ConversationCatalogQuery {
  project?: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
  /** A server-derived member and permission signature; never a query parameter. */
  authorityScope?: string;
  tree?: boolean;
  /** One sibling list in the tree. A null parent selects the roots. */
  branch?: { parent: string | null };
}

interface Cursor {
  snapshot: number;
  offset: number;
}

interface CatalogPaginationSnapshot {
  authorityScope: string;
  items: ConversationCatalogEntry[];
  total: number;
  projectTotal?: number;
}

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
const catalogStore = globalThis as typeof globalThis & {
  __llvConversationCatalog?: ConversationCatalogEntry[];
  __llvConversationByPath?: ReadonlyMap<string, ConversationCatalogEntry>;
  __llvConversationProjects?: ReadonlySet<string>;
  __llvConversationCatalogGeneration?: number;
  __llvConversationPagination?: Map<number, CatalogPaginationSnapshot>;
  __llvConversationPaginationSequence?: number;
};
const MAX_PAGINATION_SNAPSHOTS = 16;
const MAX_PAGINATION_ROWS = 20_000;

export class ExpiredConversationCatalogCursorError extends Error {
  constructor() {
    super("conversation catalog cursor expired");
    this.name = "ExpiredConversationCatalogCursorError";
  }
}

export function replaceConversationCatalog(entries: ConversationCatalogEntry[]): void {
  catalogStore.__llvConversationCatalog = entries;
  catalogStore.__llvConversationByPath = new Map(entries.map(entry => [entry.path, entry]));
  catalogStore.__llvConversationProjects = new Set(entries.map(entry => entry.project));
  catalogStore.__llvConversationCatalogGeneration = (catalogStore.__llvConversationCatalogGeneration ?? 0) + 1;
}

export function conversationCatalogEntry(path: string): ConversationCatalogEntry | null {
  return catalogStore.__llvConversationByPath?.get(path) ?? null;
}

export function conversationCatalogSnapshot(): readonly ConversationCatalogEntry[] {
  return catalogStore.__llvConversationCatalog ?? [];
}

/** Project membership is precomputed at publication so hot project resolution
 * does not walk every retained conversation for each short-key request. */
export function conversationCatalogProjectsSnapshot(): ReadonlySet<string> {
  return catalogStore.__llvConversationProjects ?? new Set(conversationCatalogSnapshot().map(entry => entry.project));
}

export function conversationCatalogGeneration(): number {
  return catalogStore.__llvConversationCatalogGeneration ?? 0;
}

export function conversationCatalogReady(): boolean {
  return catalogStore.__llvConversationCatalog !== undefined;
}

function paginationSnapshots(): Map<number, CatalogPaginationSnapshot> {
  return catalogStore.__llvConversationPagination ??= new MeasuredCache("pagination", "scanner/conversationCatalog");
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (!Number.isSafeInteger(parsed.snapshot) || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 1) return null;
    return { snapshot: parsed.snapshot!, offset: parsed.offset! };
  } catch {
    return null;
  }
}

function rememberPagination(items: ConversationCatalogEntry[], authorityScope: string, projectTotal?: number): number {
  const snapshots = paginationSnapshots();
  const snapshot = (catalogStore.__llvConversationPaginationSequence ?? 0) + 1;
  catalogStore.__llvConversationPaginationSequence = snapshot;
  snapshots.set(snapshot, { items, total: items.length, authorityScope, projectTotal });
  let retainedRows = [...snapshots.values()].reduce((total, page) => total + page.items.length, 0);
  while ((snapshots.size > MAX_PAGINATION_SNAPSHOTS || retainedRows > MAX_PAGINATION_ROWS) && snapshots.size > 1) {
    const oldest = snapshots.keys().next().value!;
    retainedRows -= snapshots.get(oldest)!.items.length;
    snapshots.delete(oldest);
  }
  return snapshot;
}

function matchesQuery(entry: ConversationCatalogEntry, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `${entry.title}\n${entry.firstPrompt}\n${entry.project}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Stable cursor pagination over the complete lightweight conversation catalog.
 * The catalog is independent of the scheme shortlist, so callers can traverse
 * every matching conversation while hydrating filesystem metadata one page at
 * a time.
 */
function catalogFamilies(items: ConversationCatalogEntry[], branches: ConversationBranch[]) {
  const order = new Map(items.map((entry, index) => [entry.path, index]));
  return branches.map(branch => {
    const nodes: ConversationBranch[] = [];
    let newest = items.length;
    const pending = [branch];
    while (pending.length) {
      const node = pending.pop()!;
      nodes.push(node);
      newest = Math.min(newest, order.get(node.file.path)!);
      for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]!);
    }
    return { branch, nodes, newest };
  }).sort((a, b) => a.newest - b.newest);
}

/** Use native spawn metadata only. The caller supplies the visible catalog,
 * so a missing or hidden parent leaves the child in its own project. */
export function groupCodexSubagentProjects(items: ConversationCatalogEntry[]): ConversationCatalogEntry[] {
  const threads = new Map<string, ConversationCatalogEntry>();
  for (const entry of items) {
    if (entry.engine !== "codex") continue;
    const id = codexThreadIdFromPath(entry.path)?.toLowerCase();
    if (id && !threads.has(id)) threads.set(id, entry);
  }
  return items.map(entry => {
    if (entry.engine !== "codex" || !entry.nativeParentThreadId) return entry;
    const seen = new Set([entry.path]);
    let root = entry;
    while (root.nativeParentThreadId) {
      const parent = threads.get(root.nativeParentThreadId.toLowerCase());
      if (!parent) break;
      if (seen.has(parent.path)) return entry;
      seen.add(parent.path);
      root = parent;
    }
    return root.project === entry.project ? entry : { ...entry, treeProject: root.project };
  });
}

function treeCatalog(items: ConversationCatalogEntry[], branch?: ConversationCatalogQuery["branch"]): ConversationCatalogEntry[] {
  const byPath = new Map(items.map(entry => [entry.path, entry]));
  const roots = conversationTree(items.map(entry =>
    catalogEntryToFileEntry(entry.treeProject ? { ...entry, project: entry.treeProject } : entry),
  ));
  const parent = branch?.parent;
  if (parent) {
    const pending = [...roots];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.file.path === parent) return node.children.map(child => ({
        ...byPath.get(child.file.path)!, parent, directChildCount: child.children.length,
      }));
      for (const child of node.children) pending.push(child);
    }
    return [];
  }
  const families = catalogFamilies(items, roots);
  return branch
    ? families.map(({ branch: root }) => ({ ...byPath.get(root.file.path)!, parent: undefined, directChildCount: root.children.length }))
    : families.flatMap(({ nodes }) => nodes.map(node => byPath.get(node.file.path)!));
}

export function paginateConversationCatalog(
  catalog: readonly ConversationCatalogEntry[],
  options: ConversationCatalogQuery = {},
): ConversationCatalogPage {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE)));
  const cursor = decodeCursor(options.cursor);
  const authority = options.branch
    ? JSON.stringify([options.authorityScope ?? "", options.project ?? "", options.branch.parent])
    : options.authorityScope ?? "";
  if (options.cursor && !cursor) throw new ExpiredConversationCatalogCursorError();
  let snapshotId: number;
  let offset: number;
  let snapshot: CatalogPaginationSnapshot;
  if (cursor) {
    const remembered = paginationSnapshots().get(cursor.snapshot);
    if (remembered && remembered.authorityScope === authority) {
      snapshotId = cursor.snapshot;
      offset = cursor.offset;
      snapshot = remembered;
    } else {
      throw new ExpiredConversationCatalogCursorError();
    }
  } else {
    const matching = catalog
      .filter((entry) => !options.project || (options.branch ? entry.treeProject ?? entry.project : entry.project) === options.project)
      .filter((entry) => matchesQuery(entry, options.query ?? ""))
      .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path))
      .map((entry) => entry.firstPrompt ? { ...entry, firstPrompt: "" } : entry);
    const rows = options.tree || options.branch ? treeCatalog(matching, options.branch) : matching;
    const projectTotal = options.branch ? matching.length : undefined;
    // A single-page list needs no cursor and should leave active chains in the cache.
    if (rows.length <= limit) {
      return { items: rows, nextCursor: null, total: rows.length, ...(projectTotal !== undefined ? { projectTotal } : {}) };
    }
    snapshotId = rememberPagination(rows, authority, projectTotal);
    offset = 0;
    snapshot = paginationSnapshots().get(snapshotId)!;
  }
  const items = snapshot.items.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < snapshot.total;
  if (!hasMore) paginationSnapshots().delete(snapshotId);
  return {
    items,
    nextCursor: hasMore ? encodeCursor({ snapshot: snapshotId, offset: nextOffset }) : null,
    total: snapshot.total,
    ...(snapshot.projectTotal !== undefined ? { projectTotal: snapshot.projectTotal } : {}),
  };
}

/** Minimal FileEntry used by list/search results before a pin hydrates the
 * conversation through the full scheme scanner. Activity carries only the
 * scanner's own no-process-evidence tier (mtime_recent, activity.ts): a fresh
 * transcript reads "recent", never a false "idle"; "live"/"stalled" need
 * process and tail evidence the lightweight catalog deliberately skips. */
export function catalogEntryToFileEntry(entry: ConversationCatalogEntry, nowMs: number = Date.now()): FileEntry {
  const claudeParent = entry.engine === "claude" ? claudeSubagentLineage(entry.name) : null;
  const claudeRoot = claudeParent ? entry.path.slice(0, -entry.name.length) : null;
  return {
    path: entry.path,
    root: entry.root,
    name: entry.name,
    project: entry.project,
    worktree: entry.worktree,
    title: entry.title,
    sessionStartedAt: entry.sessionStartedAt,
    engine: entry.engine,
    kind: entry.kind,
    fmt: entry.fmt,
    parent: entry.parent ?? (entry.directChildCount === undefined && claudeParent && claudeRoot ? path.join(claudeRoot, claudeParent.parentName) : null),
    directChildCount: entry.directChildCount,
    ...(entry.engine === "codex" ? {
      nativeThreadId: codexThreadIdFromPath(entry.path),
      nativeParentThreadId: entry.nativeParentThreadId,
      nativeForkSourceThreadId: entry.nativeForkSourceThreadId,
    } : {}),
    mtime: entry.mtime,
    size: entry.size,
    activity: nowMs / 1000 - entry.mtime < 900 ? "recent" : "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

/** Hydrates one catalog page with current filesystem metadata. Directory
 * traversal and transcript parsing remain in the recurring discovery pass;
 * opening the list adds one stat per rendered row. */
export async function loadConversationCatalogPage(
  catalog: readonly ConversationCatalogEntry[],
  options: ConversationCatalogQuery = {},
  statFile: ConversationStat = stat,
  hydrateMetadata?: ConversationMetadataHydrator,
): Promise<ConversationListPage> {
  const page = paginateConversationCatalog(catalog, options);
  const items = await Promise.all(page.items.map(async (entry) => {
    const hydrated = hydrateMetadata ? await hydrateMetadata(entry) : entry;
    try {
      const current = await statFile(hydrated.path);
      return catalogEntryToFileEntry({
        ...hydrated,
        mtime: current.mtimeMs / 1000,
        size: current.size,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  return {
    items: items.filter((item): item is FileEntry => item !== null),
    nextCursor: page.nextCursor,
    total: page.total,
    ...(page.projectTotal !== undefined ? { projectTotal: page.projectTotal } : {}),
  };
}


type ScopedCatalogCache = WeakMap<readonly ConversationCatalogEntry[], WeakMap<ReadonlyMap<string, string>, Map<string, ConversationCatalogEntry[]>>>;
const scopeStore = globalThis as typeof globalThis & { __llvScopedCatalogs?: ScopedCatalogCache };
const scopedCatalogs = scopeStore.__llvScopedCatalogs ??= new WeakMap();
/** Stable project slices let the bounded search projection survive keystrokes.
 * Both discovery and registry ownership revisions invalidate the slice. */
export function scopeConversationCatalog(source: readonly ConversationCatalogEntry[], projects: ReadonlyMap<string, string>, project?: string): ConversationCatalogEntry[] {
  let byOwnership = scopedCatalogs.get(source);
  if (!byOwnership) scopedCatalogs.set(source, byOwnership = new WeakMap());
  let scopes = byOwnership.get(projects);
  if (!scopes) byOwnership.set(projects, scopes = new MeasuredCache("scopes", "scanner/conversationCatalog"));
  const key = project ?? "";
  const existing = scopes.get(key);
  if (existing) return existing;
  const scoped = source.flatMap(entry => {
    const owner = projects.get(entry.path) ?? entry.project;
    return !project || owner === project ? [owner === entry.project ? entry : { ...entry, project: owner }] : [];
  });
  scopes.set(key, scoped);
  if (scopes.size > 8) scopes.delete(scopes.keys().next().value!);
  return scoped;
}
