import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { readStateCollectionRows } from "@/lib/state/sqliteStateStore";
import {
  isRepositoryProjectId,
  localRepositoryProjectId,
  projectIdentityFromRepositoryRoot,
  repositoryRootForPath,
  type RepositoryProjectIdentity,
} from "@/lib/projects/identity";

export interface ProjectAliasRegistration {
  source: string;
  target: string;
  displayName: string;
}

export interface ProjectAliasSnapshot {
  aliases: Record<string, string>;
  displayNames: Record<string, string>;
}

/** A remote-to-remote move the durable pass saw but may not alias on its own
    (rename-delegatus.md §2.4): only the forge can prove the two remotes are
    one repository, so it is handed to `forgeRename.ts`. */
export interface RemoteProjectMove {
  source: string;
  target: RepositoryProjectIdentity;
}

export interface DurableProjectAliasCandidates {
  registrations: ProjectAliasRegistration[];
  conflicts: string[];
  remoteMoves: RemoteProjectMove[];
}

interface ProjectAliasFile extends ProjectAliasSnapshot {
  schemaVersion: 1;
}

type AliasCache = {
  file: string;
  mtimeMs: number;
  size: number;
  snapshot: ProjectAliasSnapshot;
};

let cache: AliasCache | null = null;

function aliasesFile(): string {
  return statePath("project-aliases.json");
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([key, item]) => Boolean(key.trim()) && typeof item === "string" && Boolean(item.trim()))
    ? Object.fromEntries(entries)
    : null;
}

function readSnapshot(): ProjectAliasSnapshot {
  const file = aliasesFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { file, mtimeMs: -1, size: -1, snapshot: { aliases: {}, displayNames: {} } };
    return cache.snapshot;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.snapshot;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectAliasFile>;
    const aliases = parsed.schemaVersion === 1 ? stringRecord(parsed.aliases) : null;
    const displayNames = parsed.schemaVersion === 1 ? stringRecord(parsed.displayNames) : null;
    const snapshot = aliases && displayNames ? { aliases, displayNames } : { aliases: {}, displayNames: {} };
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  } catch {
    const snapshot = { aliases: {}, displayNames: {} };
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  }
}

function resolveAlias(project: string, aliases: Readonly<Record<string, string>>): string {
  let current = project;
  const seen = new Set<string>();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current]!;
  }
  return seen.has(current) ? project : current;
}

export function canonicalProject(project: string): string {
  return resolveAlias(project, readSnapshot().aliases);
}

export function projectAliasSnapshot(): ProjectAliasSnapshot {
  const snapshot = readSnapshot();
  return {
    aliases: { ...snapshot.aliases },
    displayNames: { ...snapshot.displayNames },
  };
}

function readObject(filename: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(filename), "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function storedWorktreeRepositories(): ReadonlyMap<string, string> {
  const stored = readObject("worktree-map.json");
  if (!stored) return new Map();
  const repositories = new Map<string, string>();
  for (const [cwd, value] of Object.entries(stored)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const repo = (value as Record<string, unknown>).repo;
    if (typeof repo === "string" && repo.trim()) repositories.set(cwd, repo);
  }
  return repositories;
}

function projectPathPairs(filename: string, collection: string, pathField: string): Array<[string, string]> {
  const sqlite = ["flows", "pipelines", "workflows", "tasks"].includes(collection)
    ? readStateCollectionRows(statePath("state.sqlite"), collection)
    : null;
  const stored = sqlite ?? readObject(filename)?.[collection];
  if (!Array.isArray(stored)) return [];
  const pairs: Array<[string, string]> = [];
  for (const value of stored) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.project === "string" && record.project.trim()
      && typeof record[pathField] === "string" && record[pathField].trim()) {
      pairs.push([record.project, record[pathField]]);
    }
  }
  return pairs;
}

function collectionRecords(filename: string, collection: string): Record<string, unknown>[] {
  const sqlite = ["flows", "pipelines", "workflows", "tasks"].includes(collection)
    ? readStateCollectionRows(statePath("state.sqlite"), collection)
    : null;
  const stored = sqlite ?? readObject(filename)?.[collection];
  return Array.isArray(stored)
    ? stored.filter((value): value is Record<string, unknown> => (
        Boolean(value) && typeof value === "object" && !Array.isArray(value)
      ))
    : [];
}

function convergenceIdCollisions(registrations: readonly ProjectAliasRegistration[]): {
  labels: string[];
  sources: Set<string>;
} {
  const proposed = new Map(registrations.map((registration) => [registration.source, registration.target]));
  const labels = new Set<string>();
  const sources = new Set<string>();
  for (const [filename, collection] of [
    ["tasks.json", "tasks"],
    ["flows.json", "flows"],
    ["pipelines.json", "pipelines"],
    ["workflows.json", "workflows"],
  ] as const) {
    const seen = new Map<string, string>();
    for (const record of collectionRecords(filename, collection)) {
      if (typeof record.id !== "string" || !record.id.trim()
        || typeof record.project !== "string" || !record.project.trim()) continue;
      const current = canonicalProject(record.project);
      const target = proposed.get(current) ?? current;
      const key = `${target}\0${record.id}`;
      const held = seen.get(key);
      if (held && held !== current) {
        labels.add(`${collection} id collision`);
        if (proposed.has(held)) sources.add(held);
        if (proposed.has(current)) sources.add(current);
      } else {
        seen.set(key, current);
      }
    }
  }
  return { labels: [...labels], sources };
}

type TargetEvidence = {
  registration: ProjectAliasRegistration;
  records: number;
  identity: RepositoryProjectIdentity;
  /** The source is a key this checkout's path minted (or a legacy bucket), so
      the move is a #1874 succession rather than a changed remote. */
  pathDerived: boolean;
};

/**
 * Pre-change flow, pipeline, and workflow records carry both the legacy
 * project key and a repository path. Re-resolving those paths establishes an
 * alias even when the prior project catalog has already disappeared. One stale
 * record stamped with a foreign checkout must not poison a source the rest of
 * the records agree on, so each source resolves by strict record majority and
 * only a genuinely split source is reported as a conflict.
 */
export function durableProjectAliasCandidates(): DurableProjectAliasCandidates {
  const rememberedRepositories = storedWorktreeRepositories();
  const pairs = [
    ...projectPathPairs("flows.json", "flows", "cwd"),
    ...projectPathPairs("pipelines.json", "pipelines", "repoDir"),
    ...projectPathPairs("workflows.json", "workflows", "repoDir"),
  ];
  const targets = new Map<string, Map<string, TargetEvidence>>();
  const remoteMoves = new Map<string, RemoteProjectMove>();
  for (const [source, candidatePath] of pairs) {
    const root = repositoryRootForPath(candidatePath) ?? rememberedRepositories.get(candidatePath);
    const identity = root ? projectIdentityFromRepositoryRoot(root) : null;
    if (!identity) continue;
    /* A record whose checkout still mints its key is what fills the ledger on
       the first scan: the remote it names is the one a later rename moves. */
    if (source === identity.project) recordProjectRemote(identity);
    const sourceTargets = targets.get(source) ?? new Map<string, TargetEvidence>();
    const evidence = sourceTargets.get(identity.project) ?? {
      registration: { source, target: identity.project, displayName: identity.displayName },
      records: 0,
      identity,
      pathDerived: !isRepositoryProjectId(source) || source === (root ? localRepositoryProjectId(root) : null),
    };
    evidence.records += 1;
    sourceTargets.set(identity.project, evidence);
    targets.set(source, sourceTargets);
  }
  const registrations: ProjectAliasRegistration[] = [];
  const conflicts: string[] = [];
  for (const [source, sourceTargets] of targets) {
    /* A repository id that still points at its own repository is already a
       valid canonical identity. Historical records stamped with that same id
       while rooted in another repository are per-record corruption; turning
       them into a global alias would merge two unrelated boards. */
    if (sourceTargets.has(source)) {
      if (sourceTargets.size > 1) conflicts.push(source);
      continue;
    }
    const ranked = [...sourceTargets.values()].sort((left, right) => right.records - left.records);
    const total = ranked.reduce((sum, evidence) => sum + evidence.records, 0);
    const leader = ranked[0]!;
    if (leader.records * 2 <= total) {
      conflicts.push(source);
      continue;
    }
    /* §2.4: a repository id whose checkout now resolves to a different REMOTE
       id is a changed origin (renamed, transferred or re-pointed). Aliasing it
       on this evidence alone merged a re-pointed fork into the repository it
       replaced (#2035), so only the forge decides, and nothing is registered
       here. A path-derived source (a legacy or `dir-` key, or the checkout's
       own local id from before it had an origin) is what this pass exists
       for. */
    if (!leader.pathDerived && isRemoteRepositoryIdentity(leader.identity)) {
      remoteMoves.set(source, { source, target: leader.identity });
      continue;
    }
    registrations.push(leader.registration);
  }
  const collisions = convergenceIdCollisions(registrations);
  conflicts.push(...collisions.labels);
  return {
    registrations: registrations.filter((registration) => !collisions.sources.has(registration.source)),
    conflicts,
    remoteMoves: [...remoteMoves.values()],
  };
}

function mergeRegistrations(
  registrations: readonly ProjectAliasRegistration[],
): ProjectAliasSnapshot | null {
  const current = readSnapshot();
  const aliases = { ...current.aliases };
  const displayNames = { ...current.displayNames };
  for (const registration of registrations) {
    const source = registration.source.trim();
    const target = resolveAlias(registration.target.trim(), aliases);
    const displayName = registration.displayName.trim();
    if (!source || !target || !displayName) return null;
    const held = aliases[source] ? resolveAlias(aliases[source]!, aliases) : null;
    if (held && held !== target) return null;
    if (source !== target) aliases[source] = target;
    displayNames[target] = displayName;
  }
  return { aliases, displayNames };
}

export function projectAliasesCanAccept(registrations: readonly ProjectAliasRegistration[]): boolean {
  return mergeRegistrations(registrations) !== null;
}

export function persistProjectAliases(registrations: readonly ProjectAliasRegistration[]): boolean {
  if (registrations.length === 0) return true;
  const merged = mergeRegistrations(registrations);
  if (!merged) return false;
  const file = aliasesFile();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: 1, ...merged } satisfies ProjectAliasFile, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporary, file);
    cache = null;
    readSnapshot();
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // A later catalog pass retries the alias publication.
    }
    return false;
  }
}

/* ── The remote ledger (rename-delegatus.md §2.3) ──────────────────────────
   A repository id is a hash of its remote and cannot be reversed, and GitHub
   publishes no list of a repository's former names. So each machine records
   the remote behind every repository id it has seen, and a later rename can
   be checked against the forge from the old remote this ledger still holds. */

interface ProjectRemoteFile {
  schemaVersion: 1;
  remotes: Record<string, string>;
}

type RemoteCache = { file: string; mtimeMs: number; size: number; remotes: Record<string, string> };

let remoteCache: RemoteCache | null = null;

function remotesFile(): string {
  return statePath("project-remotes.json");
}

function readRemotes(): Record<string, string> {
  const file = remotesFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    remoteCache = { file, mtimeMs: -1, size: -1, remotes: {} };
    return remoteCache.remotes;
  }
  if (remoteCache && remoteCache.file === file && remoteCache.mtimeMs === stat.mtimeMs && remoteCache.size === stat.size) {
    return remoteCache.remotes;
  }
  let remotes: Record<string, string> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectRemoteFile>;
    remotes = (parsed.schemaVersion === 1 ? stringRecord(parsed.remotes) : null) ?? {};
  } catch {
    remotes = {};
  }
  remoteCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, remotes };
  return remotes;
}

/** Whether an identity names a remote (as opposed to a repository with no
    `origin`, whose id is derived from its local path). */
export function isRemoteRepositoryIdentity(identity: Pick<RepositoryProjectIdentity, "canonicalRemote">): boolean {
  return !identity.canonicalRemote.startsWith("local:");
}

/** The remote this machine saw behind a repository id, or null. */
export function recordedProjectRemote(project: string): string | null {
  return readRemotes()[project] ?? null;
}

/**
 * Remember the remote behind a repository id. Writes only when the entry is
 * missing or changed, with the same temp-file-and-rename as the alias map; a
 * failed write is retried by the next identity that asks.
 */
export function recordProjectRemote(identity: Pick<RepositoryProjectIdentity, "project" | "canonicalRemote">): void {
  if (!isRepositoryProjectId(identity.project) || !isRemoteRepositoryIdentity(identity)) return;
  const current = readRemotes();
  if (current[identity.project] === identity.canonicalRemote) return;
  const file = remotesFile();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const remotes = { ...current, [identity.project]: identity.canonicalRemote };
    fs.writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: 1, remotes } satisfies ProjectRemoteFile, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporary, file);
    remoteCache = null;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The next identity resolution retries the ledger entry.
    }
  }
}

export function resetProjectAliasesForTests(): void {
  cache = null;
  remoteCache = null;
}
