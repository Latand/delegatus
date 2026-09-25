import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";

import type { CachedPullRequest, ForgeCacheView, ForgeRepositoryView, PullRequestState } from "./workLinks";

/*
 * The forge cache (#2059, docs/design/pr-issue-chips.md §3.3): what the Viewer
 * last read from GitHub about each repository's pull requests. One writer, the
 * sweep in `sweep.ts`, plus the stage report's observation of the PR it
 * already looked up. It is read through an mtime-keyed memory copy, so a board
 * read costs one `stat` and a few map lookups, and it is never sent to the
 * browser: only resolved links are.
 */

export type ForgeSweepError = "timed-out" | "command-failed" | "malformed-output";

export type StoredPullRequest = Omit<CachedPullRequest, "number">;

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
    };
  }
  const text = (field: unknown) => (typeof field === "string" && field ? field : null);
  return {
    canonical: text(entry.canonical),
    completeSince: text(entry.completeSince),
    lastSweepAt: text(entry.lastSweepAt),
    lastAttemptAt: text(entry.lastAttemptAt),
    lastError: entry.lastError === "timed-out" || entry.lastError === "command-failed" || entry.lastError === "malformed-output" ? entry.lastError : null,
    prs,
    issues: entry.issues && typeof entry.issues === "object" && !Array.isArray(entry.issues) ? { ...entry.issues } : {},
    ...(entry.headRefOids === true ? { headRefOids: true as const } : {}),
  };
}

function parseFile(raw: string): ForgeCacheFile {
  try {
    const parsed = JSON.parse(raw) as Partial<ForgeCacheFile>;
    if (parsed.schemaVersion !== 1 || !parsed.repositories || typeof parsed.repositories !== "object") return EMPTY_FILE();
    const repositories: Record<string, ForgeRepositoryEntry> = {};
    for (const [name, entry] of Object.entries(parsed.repositories)) {
      const valid = validEntry(entry);
      if (valid) repositories[name] = valid;
    }
    return { schemaVersion: 1, repositories };
  } catch {
    return EMPTY_FILE();
  }
}

type Memo = { file: string; mtimeMs: number; size: number; data: ForgeCacheFile; view: ForgeCacheView };
const memoHost = globalThis as typeof globalThis & { __llvForgeCacheMemo?: Memo | null };

/** The indexed view of a cache as stored; exported for tests and fixtures. */
export function forgeViewOf(data: ForgeCacheFile): ForgeCacheView {
  const views = new Map<string, ForgeRepositoryView>();
  for (const [name, entry] of Object.entries(data.repositories)) {
    const prs = new Map<number, CachedPullRequest>();
    const heads = new Map<string, CachedPullRequest[]>();
    for (const [key, stored] of Object.entries(entry.prs)) {
      const pr: CachedPullRequest = { number: Number(key), ...stored };
      prs.set(pr.number, pr);
      const list = heads.get(pr.headRefName) ?? [];
      list.push(pr);
      heads.set(pr.headRefName, list);
    }
    const issues = new Set(Object.keys(entry.issues).map(Number));
    const view: ForgeRepositoryView = {
      canonical: entry.canonical ?? name,
      completeSince: entry.completeSince,
      pr: (number) => prs.get(number),
      byHead: (head) => heads.get(head) ?? [],
      isIssue: (number) => issues.has(number) && !prs.has(number),
    };
    views.set(name, view);
  }
  /* A record may name a repository either way once it was renamed: by the old
     name its remote still says, or by the new one a pasted URL says. */
  for (const [name, entry] of Object.entries(data.repositories)) {
    if (entry.canonical && !views.has(entry.canonical)) views.set(entry.canonical, views.get(name)!);
  }
  return { repository: (name) => views.get(name.toLowerCase()) ?? null };
}

/** The cache as stored, re-read only when the file changed. */
export function readForgeCache(file = forgeCacheFile()): { data: ForgeCacheFile; view: ForgeCacheView } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    const data = EMPTY_FILE();
    const memo = { file, mtimeMs: -1, size: -1, data, view: forgeViewOf(data) };
    memoHost.__llvForgeCacheMemo = memo;
    return memo;
  }
  const memo = memoHost.__llvForgeCacheMemo;
  if (memo && memo.file === file && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo;
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = "";
  }
  const data = parseFile(raw);
  const next = { file, mtimeMs: stat.mtimeMs, size: stat.size, data, view: forgeViewOf(data) };
  memoHost.__llvForgeCacheMemo = next;
  return next;
}

export function forgeCacheView(file = forgeCacheFile()): ForgeCacheView {
  return readForgeCache(file).view;
}

/** Read, change and write the cache. The caller holds no pipeline or task lock
    and makes no network call inside `change`. */
export function updateForgeCache(change: (data: ForgeCacheFile) => void, file = forgeCacheFile()): ForgeCacheFile {
  const current = readForgeCache(file).data;
  const next: ForgeCacheFile = structuredClone(current);
  change(next);
  writeJsonDurably(file, next, { space: 0 });
  memoHost.__llvForgeCacheMemo = null;
  return next;
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
    };
    delete entry.issues[String(pullRequest.number)];
  }, file);
}

export function resetForgeCacheForTests(): void {
  memoHost.__llvForgeCacheMemo = null;
  nudges.clear();
}
