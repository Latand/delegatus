import { cachedJsonFile, type CachedJsonFile } from "@/lib/state/cachedJsonFile";

import { projectAliasResolver, recordedProjectRemotes } from "@/lib/projects/aliases";
import { projectStoreSignature } from "@/lib/projects/persistence";
import { WORKTREE_RECOVERY_COLLECTION } from "@/lib/projects/worktreeRecoveryStore";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { readStateCollectionRevision } from "@/lib/state/sqliteStateStore";

import { githubRepositoryOfRemote, type CachedPullRequest, type ForgeCacheView, type ForgeRepositoryView, type PullRequestState } from "./workLinks";

/*
 * The forge cache (#2059, docs/design/pr-issue-chips.md §3.3): what the Viewer
 * last read from GitHub about each repository's pull requests. One writer, the
 * sweep in `sweep.ts`, plus the stage report's observation of the PR it
 * already looked up. It is read through a file snapshot, so a board
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
      ...(typeof pr.title === "string" ? { title: pr.title } : {}),
      ...(typeof pr.mergedAt === "string" && pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
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

type Snapshot = { data: ForgeCacheFile; view: ForgeCacheView };
const memoHost = globalThis as typeof globalThis & { __llvForgeFileCache?: CachedJsonFile<Snapshot> };
const cache = memoHost.__llvForgeFileCache ??= cachedJsonFile((raw): Snapshot => {
  const data = parseFile(raw ?? "");
  return { data, view: forgeViewOf(data) };
});

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
    const view: ForgeRepositoryView = {
      canonical: name,
      completeSince: entries.map(entry => entry.completeSince).filter((at): at is string => !!at).sort().at(-1) ?? null,
      pr: (number) => prs.get(number),
      byHead: (head) => heads.get(head) ?? [],
      isIssue: (number) => issues.has(number) && !prs.has(number),
    };
    views.set(name, view);
  }
  return { repository: (name) => views.get(canonical(name)) ?? (aliases.has(name.toLowerCase())
    ? { canonical: canonical(name), completeSince: null, pr: () => undefined, byHead: () => [], isIssue: () => false }
    : null) };
}

/** The cache as stored, re-read only when the file changed. */
export function readForgeCache(file = forgeCacheFile()): { data: ForgeCacheFile; view: ForgeCacheView } {
  return cache.read(file);
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

/** Read, change and write the cache. The caller holds no pipeline or task lock
    and makes no network call inside `change`. */
export function updateForgeCache(change: (data: ForgeCacheFile) => void, file = forgeCacheFile()): ForgeCacheFile {
  const current = readForgeCache(file).data;
  const next: ForgeCacheFile = structuredClone(current);
  change(next);
  writeJsonDurably(file, next, { space: 0 });
  cache.invalidate();
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
      ...(prior?.title !== undefined ? { title: prior.title } : {}),
      ...(prior?.mergedAt ? { mergedAt: prior.mergedAt } : {}),
    };
    delete entry.issues[String(pullRequest.number)];
  }, file);
}

export function resetForgeCacheForTests(): void {
  cache.invalidate();
  aliasMemo = null;
  resolvedMemo = null;
  nudges.clear();
}
