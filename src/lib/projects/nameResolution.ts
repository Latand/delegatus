import path from "node:path";
import { projectDisplayName } from "@/lib/displayNames";
import { canonicalProject, projectAliasSnapshot, recordedProjectRemotes } from "./aliases";
import { projectCurationSnapshot } from "./curation";
import { reportHeaderName } from "./settings";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

type Member = { project: string; displayName?: string; projectName?: string; projectRoot?: string | null; cwd?: string | null; worktree?: string };
type Sources = {
  authorizedSeats?(): readonly { project?: string | null }[];
  callerProject?(): string | null;
  lastCompletedCatalog?(): { projectCatalog: readonly Member[]; files: readonly Member[] } | null;
};
export type NamedProjectSources = Sources;
export interface NamedProjectDirectory {
  names: Map<string, Set<string>>;
  identities: Map<string, Set<string>>;
  labels: Map<string, string>;
  active: Set<string>;
  suggestions: Set<string>;
  canonical(project: string): string;
}

/** Read retained membership only. A name lookup never starts a scanner or
 * walks registry history. Parent folding needs the scanner's worktree proof. */
export function namedProjectDirectory(sources: Sources = {}, extraKeys: readonly string[] = []): NamedProjectDirectory {
  const aliases = projectAliasSnapshot({ strict: true });
  const canonicalKeys = new Map<string, string>();
  const aliased = (key: string) => {
    let target = canonicalKeys.get(key);
    if (target === undefined) { target = canonicalProject(key); canonicalKeys.set(key, target); }
    return target;
  };
  const last = sources.lastCompletedCatalog?.();
  const members: readonly Member[] = [...(last?.projectCatalog ?? []), ...(last?.files ?? []), ...conversationCatalogSnapshot()];
  const seats = activeOrchestratorSeats();
  const authorized = sources.authorizedSeats?.() ?? [];
  const manualProjects = projectCurationSnapshot().manualProjects;
  const caller = sources.callerProject?.();
  const parents = new Map<string, string>();
  const evidence = new Map<string, Set<string>>();
  const known = new Set([...members.map(row => aliased(row.project)), ...Object.keys(aliases.displayNames).map(aliased),
    ...Object.values(aliases.aliases).map(aliased), ...seats.map(row => aliased(row.project)),
    ...authorized.flatMap(row => row.project ? [aliased(row.project)] : []), ...manualProjects.map(row => aliased(row.project)),
    ...(caller ? [aliased(caller)] : []), ...extraKeys.map(aliased)]);
  const roots = new Map<string, ReturnType<typeof projectInfoFromCwd>>();
  // Retained conversation cwd/worktree fields cannot replace a member's
  // current root or its authoritative alias. Fold only catalog member roots.
  for (const row of last?.projectCatalog ?? []) {
    const cwd = row.projectRoot;
    if (!cwd) continue;
    if (!roots.has(cwd)) roots.set(cwd, projectInfoFromCwd(cwd));
    const info = roots.get(cwd);
    const key = aliased(row.project);
    if (key !== row.project) continue;
    if (info?.worktree && known.has(aliased(info.project))) {
      const targets = evidence.get(key) ?? new Set<string>();
      targets.add(aliased(info.project)); evidence.set(key, targets);
    }
  }
  for (const [key, targets] of evidence) {
    if (targets.size === 1) parents.set(key, [...targets][0]!);
  }
  const canonical = (key: string) => {
    key = aliased(key.trim());
    const seen = new Set<string>();
    while (parents.has(key) && !seen.has(key)) { seen.add(key); key = parents.get(key)!; }
    return key;
  };
  const active = new Set(seats.map(seat => canonical(seat.project)));
  for (const seat of authorized) if (seat.project) active.add(canonical(seat.project));
  const names = new Map<string, Set<string>>();
  const identities = new Map<string, Set<string>>();
  const labels = new Map<string, string>();
  const index = (name: string | undefined | null, key: string) => {
    const folded = name?.trim().toLowerCase();
    // Presentation placeholders do not name any one project.
    if (!folded || folded === "unnamed project" || folded === "unresolved project") return;
    const projects = names.get(folded) ?? new Set<string>();
    projects.add(canonical(key)); names.set(folded, projects);
  };
  const added = new Set<string>();
  const identify = (name: string | undefined | null, key: string) => {
    const folded = name?.trim().toLowerCase();
    if (!folded) return;
    const projects = identities.get(folded) ?? new Set<string>();
    projects.add(canonical(key)); identities.set(folded, projects);
  };
  const add = (key: string, name?: string) => {
    const signature = JSON.stringify([key, name ?? null]);
    if (added.has(signature)) return;
    added.add(signature);
    const project = canonical(key);
    const label = projectDisplayName(project, aliases.displayNames[project] ?? (name && !["Unnamed project", "Unresolved project"].includes(name) ? name : undefined) ?? labels.get(project));
    labels.set(project, label);
    identify(key, project);
    index(key, project); index(project, project); index(name, project); index(label, project);
    index(reportHeaderName(project), project);
  };
  for (const row of members) add(row.project, row.displayName ?? row.projectName);
  for (const [source, target] of Object.entries(aliases.aliases)) { add(target); identify(source, target); index(source, target); }
  for (const [key, name] of Object.entries(aliases.displayNames)) add(key, name);
  for (const row of manualProjects) add(row.project, row.displayName);
  for (const seat of seats) add(seat.project);
  for (const seat of authorized) if (seat.project) add(seat.project);
  if (caller) add(caller);
  for (const key of extraKeys) add(key);
  for (const row of last?.projectCatalog ?? []) if (row.projectRoot) index(path.basename(row.projectRoot), row.project);
  for (const [key, remote] of Object.entries(recordedProjectRemotes())) {
    if (!labels.has(canonical(key))) continue;
    const parts = remote.replace(/\.git$/u, "").split("/");
    index(parts.at(-1), key); index(parts.slice(-2).join("/"), key);
  }
  // Transcript index project names can contain path-encoded directory names.
  // Keep this vocabulary in the shared resolver so it cannot bypass ambiguity.
  for (const [name, projects] of names) {
    const normalized = normalizeProjectName(name);
    if (!normalized || normalized === name) continue;
    const keys = identities.get(normalized) ?? new Set<string>();
    for (const project of projects) keys.add(project);
    identities.set(normalized, keys);
  }
  const suggestions = new Set([...active, ...Object.keys(aliases.displayNames).map(canonical), ...Object.values(aliases.aliases).map(canonical)]);
  return { names, identities, labels, active, suggestions, canonical };
}

function normalizeProjectName(value: string): string {
  return value.toLowerCase().replace(/[._/\\-]+/gu, "-").replace(/^-|-$/gu, "");
}

export class ProjectNameRefusal extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) { super(message); }
}

/** Exact folded names select a unique designated seat when several members
 * share a name. Several seated members remain an explicit operator choice. */
export function resolveNamedProject(named: string, directory: NamedProjectDirectory, requireActiveSeat = false): string {
  const requested = named.trim();
  const folded = requested.toLowerCase();
  const identity = [...(directory.identities.get(folded) ?? [])].sort();
  const namedCandidates = [...(directory.names.get(folded) ?? [])];
  const identityCollision = identity.length > 0 && namedCandidates.some(project => !identity.includes(project));
  const seatedNames = namedCandidates.filter(project => directory.active.has(project));
  if (identity.length === 1 && (!requireActiveSeat || directory.active.has(identity[0]!))
    && (!identityCollision || (seatedNames.length === 1 && seatedNames[0] === identity[0]))) return identity[0]!;
  if (identity.length > 1 || identityCollision) {
    const candidates = [...new Set([...identity, ...namedCandidates])].sort();
    const candidateNames = candidates.map(project => ({ project, name: directory.labels.get(project) ?? project }));
    throw new ProjectNameRefusal(`ambiguous project identity "${requested}": ${candidateNames.map(row => `${row.name} (${row.project})`).join(", ")}; ask which project`, {
      outcome: "not-executed", evidence: "project-resolution", nextAction: "new-request-permitted", retryable: false,
      code: "ambiguous_project", candidates, candidateNames,
    });
  }
  const all = namedCandidates.sort();
  let candidatesForName = all;
  if (!candidatesForName.length) {
    const wanted = normalizeProjectName(folded);
    let specificity = 0;
    const matched = new Set<string>();
    for (const [name, projects] of directory.names) {
      const candidate = normalizeProjectName(name);
      if (candidate && (wanted === candidate || wanted.endsWith(`-${candidate}`))) {
        if (candidate.length > specificity) { matched.clear(); specificity = candidate.length; }
        if (candidate.length === specificity) for (const project of projects) matched.add(project);
      }
    }
    candidatesForName = [...matched].sort();
  }
  const seated = candidatesForName.filter(key => directory.active.has(key));
  const candidates = seated.length ? seated : candidatesForName;
  const details = { outcome: "not-executed", evidence: "project-resolution", nextAction: "new-request-permitted", retryable: false };
  if (candidates.length > 1) {
    const candidateNames = candidates.map(project => ({ project, name: directory.labels.get(project) ?? project }));
    throw new ProjectNameRefusal(`ambiguous project "${requested}": ${candidateNames.map(row => `${row.name} (${row.project})`).join(", ")}; ask which project or pass a project key`, {
      ...details, code: "ambiguous_project", candidates, candidateNames,
    });
  }
  if (candidates.length === 1 && (!requireActiveSeat || directory.active.has(candidates[0]!))) return candidates[0]!;
  const closeMatches = [...directory.labels].filter(([project]) => !requireActiveSeat || directory.suggestions.has(project)).map(([project, name]) => ({ project, name, distance: Math.min(projectNameDistance(folded, name.toLowerCase()), projectNameDistance(folded, project.toLowerCase())) }))
    .filter(match => match.distance <= Math.max(2, Math.floor(folded.length / 3)))
    .sort((a, b) => a.distance - b.distance || a.project.localeCompare(b.project)).slice(0, 5).map(({ project, name }) => ({ project, name }));
  throw new ProjectNameRefusal(`no such project "${requested}"; ${closeMatches.length
    ? `close matches: ${closeMatches.map(match => `${match.name} (${match.project})`).join(", ")}`
    : "no close matches; pass a known project key, display name or repository name"}`, { ...details, code: "unknown_project", closeMatches });
}

function projectNameDistance(left: string, right: string): number {
  if (left.length > 256 || right.length > 256) return Infinity;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++) next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (left[i] === right[j] ? 0 : 1)));
    row = next;
  }
  return row[right.length]!;
}
