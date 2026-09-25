import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";

import { cachedAgentConversations, type AgentSourceRead } from "./agentSource";
import { readHumanInputs, type HostReport, type HumanInputRead } from "./hostSources";
import { readActivitySettings, type ActivitySettings } from "./settings";
import {
  activityReport,
  clampMethodParams,
  holdsProject,
  MINUTE_MS,
  METHOD_DEFAULTS,
  RANGE_KEYS,
  rangeDays,
  uncoveredSpans,
  type ActivityReport,
  type Anchor,
  type HostCoverage,
  type Interval,
  type MethodParams,
  type ProjectActivity,
  type RangeKey,
} from "./method";

/*
 * GET /api/activity, as a function the route calls: parse and clamp the
 * query, read both sources, run the method, and name the projects. A source
 * that cannot be read degrades to a coverage flag and an empty axis; the
 * answer is never an error for it.
 */

export type SourceState = "ok" | "absent" | "unreadable";

export interface ActivityProjectRow extends ProjectActivity {
  /** A display name, or null for an unattributed row or an unnamed project. */
  name: string | null;
}

export interface ActivityHostRow extends HostReport {
  /** Whether the host was read for the whole range up to now: a host whose
      ledger is read and whose transcripts are not is incomplete. */
  complete: boolean;
  /** The stretches of the range, up to now, it was not read for. */
  unread: Interval[];
  /** Whether its agent turns were read for the whole range up to now. They
      come only from the host's own record (this host's ingest or index,
      another host's pull), so a host read by an export alone, or listed with
      a pull that never answered, is not. */
  agentsComplete: boolean;
  agentsUnread: Interval[];
  /** Whether the host can hold the project the page is scoped to (always,
      unscoped): only such a host's gaps bear on the figures shown. */
  inScope: boolean;
}

export interface ActivityResponse extends Omit<ActivityReport, "projects" | "params" | "scope"> {
  generatedAt: number;
  params: { windowMin: number; breakMin: number; rounding: MethodParams["rounding"]; tz: string };
  /** The project `totals` and `days` count alone, by its canonical key and
      its name as its row reads, or null for every project. */
  scope: { project: string; name: string | null } | null;
  coverage: {
    /** Whether `activity/hosts.json` names the expected hosts. */
    hostsConfig: HumanInputRead["config"];
    /** Every expected host and what each of its sources was read for. */
    hosts: ActivityHostRow[];
    agentIndex: SourceState;
    indexedAtMs: number | null;
    unregisteredConversations: number;
  };
  /** Whether any project is tagged billable, so the billable figure means something. */
  billableConfigured: boolean;
  projects: ActivityProjectRow[];
}

export interface ActivityQuery {
  range: RangeKey;
  params: MethodParams;
  /** A project key to scope the view to, as asked; null for every project. */
  project: string | null;
}

/** A project key is a short printable word; anything else scopes nothing. */
const PROJECT_KEY_MAX = 300;

/** Every input is clamped: a bad value gets its default, never an error. The
    zone defaults to the settings' zone (Europe/Kyiv unless set). */
export function parseActivityQuery(search: URLSearchParams, fallbackTz: string = METHOD_DEFAULTS.tz): ActivityQuery {
  const rawRange = search.get("range");
  const range = RANGE_KEYS.includes(rawRange as RangeKey) ? rawRange as RangeKey : "7d";
  const minutes = (value: string | null) => value === null || !value.trim() ? undefined : Number(value) * MINUTE_MS;
  const project = search.get("project")?.trim() ?? "";
  return {
    range,
    // eslint-disable-next-line no-control-regex
    project: project && project.length <= PROJECT_KEY_MAX && !/[\u0000-\u001f\u007f]/.test(project) ? project : null,
    params: clampMethodParams({
      windowMs: minutes(search.get("window")),
      breakMs: minutes(search.get("break")),
      rounding: search.get("rounding") ?? undefined,
      tz: search.get("tz") ?? undefined,
    }, fallbackTz),
  };
}

export interface ActivityResponseDependencies {
  now(): number;
  settings(): ActivitySettings;
  humanInputs(window: { start: number; end: number }, nowMs: number): HumanInputRead;
  agents(cacheKey: string, range: { start: number; end: number }, nowMs: number): AgentSourceRead;
  canonicalProject(project: string): string;
  /** Live display names by project key. */
  projectNames(): Promise<ReadonlyMap<string, string>>;
}

/** Names from the board's last scan and the project aliases. A cold scan
    takes tens of seconds, so none is started or awaited: until one has
    finished, the page names projects by their readable keys. */
async function catalogProjectNames(): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  try {
    const { lastScannedProjectCatalog } = await import("@/lib/scanner/scanCache");
    for (const entry of lastScannedProjectCatalog() ?? []) {
      if (entry.displayName?.trim()) names.set(entry.project, entry.displayName.trim());
    }
  } catch {
    /* No scan state yet. */
  }
  try {
    for (const [project, name] of Object.entries(projectAliasSnapshot().displayNames)) if (name.trim()) names.set(project, name.trim());
  } catch {
    /* No alias file. */
  }
  return names;
}

const productionDependencies: ActivityResponseDependencies = {
  now: Date.now,
  settings: () => readActivitySettings(statePath("activity")),
  humanInputs: (window, nowMs) => readHumanInputs(window, nowMs),
  agents: cachedAgentConversations,
  canonicalProject,
  projectNames: catalogProjectNames,
};

export async function activityResponse(
  search: URLSearchParams,
  overrides: Partial<ActivityResponseDependencies> = {},
): Promise<ActivityResponse> {
  const dependencies = { ...productionDependencies, ...overrides };
  const nowMs = dependencies.now();
  const settings = dependencies.settings();
  const query = parseActivityQuery(search, settings.tz);
  const { params, range } = query;
  const days = rangeDays(range, nowMs, params.tz);
  const window = { start: days[0]!.start, end: days.at(-1)!.end };

  /* From T before the first day: an episode running into the range from
     before it is then counted exactly (see ReportInput.anchors). A source
     that cannot be read covers nothing, which leaves its host unknown. */
  const human = dependencies.humanInputs({ start: window.start - params.breakMs, end: Math.min(window.end, nowMs) }, nowMs);
  const canonical = (project: string | null): string | null => {
    if (project === null) return null;
    const resolved = dependencies.canonicalProject(project);
    return resolved && resolved !== UNRESOLVED_PROJECT ? resolved : null;
  };
  const anchors: Anchor[] = human.inputs.map((input) => ({
    at: input.at,
    project: canonical(input.project),
    surface: input.surface,
    kind: input.kind,
    host: input.host,
  }));

  let agentIndex: SourceState = "ok";
  let agentRead: AgentSourceRead = { agents: [], index: { available: false, indexedAtMs: null } };
  try {
    agentRead = dependencies.agents(`${range}:${params.tz}:${window.start}`, window, nowMs);
    if (!agentRead.index.available) agentIndex = "absent";
  } catch {
    agentIndex = "unreadable";
  }

  const reports = new Map(human.hosts.map((host) => [host.host, host]));
  const hostCoverage: HostCoverage[] = human.coverage.map((host) => ({
    ...host,
    projects: host.projects === "all" ? "all" as const : host.projects.map((project) => canonical(project) ?? project),
    agents: agentSpans(reports.get(host.host), agentRead.local),
  }));
  /* A project is asked for by its key as the page knows it; an older key of
     the same project names it too. */
  const scope = query.project === null ? null : canonical(query.project) ?? query.project;

  const report = activityReport({
    params,
    range,
    nowMs,
    anchors,
    hosts: hostCoverage,
    agents: agentRead.agents,
    billable: settings.billable.map((project) => canonical(project) ?? project),
    workdays: settings.workdays,
    ...(scope === null ? {} : { scope: { project: scope } }),
  });
  const names = await dependencies.projectNames();
  const projects = distinctNames(report.projects.map((row) => ({ ...row, name: row.project === null ? null : names.get(row.project) ?? null })));
  const upToNow = { start: window.start, end: Math.min(window.end, nowMs) };
  return {
    generatedAt: nowMs,
    params: {
      windowMin: params.windowMs / MINUTE_MS,
      breakMin: params.breakMs / MINUTE_MS,
      rounding: params.rounding,
      tz: params.tz,
    },
    range: report.range,
    scope: scope === null ? null : { project: scope, name: projects.find((row) => row.project === scope)?.name ?? names.get(scope) ?? null },
    coverage: {
      hostsConfig: human.config,
      hosts: human.hosts.map((host) => {
        const coverage = hostCoverage.filter((entry) => entry.host === host.host);
        const unread = uncoveredSpans(upToNow, coverage).spans;
        const agentsUnread = uncoveredSpans(upToNow, coverage, undefined, "agents").spans;
        return {
          ...host,
          complete: unread.length === 0,
          unread,
          agentsComplete: agentsUnread.length === 0,
          agentsUnread,
          inScope: scope === null || coverage.some((entry) => holdsProject(entry, scope)),
        };
      }),
      agentIndex,
      indexedAtMs: agentRead.index.indexedAtMs,
      unregisteredConversations: report.totals.unregisteredConversations,
    },
    totals: report.totals,
    days: report.days,
    billableConfigured: settings.billable.length > 0,
    projects,
  };
}

/** Always read: the search index's approximation of this host's turns reads
    whatever it indexed, and says so through `coverage.agentIndex`. */
const ALWAYS: Interval = { start: 0, end: Number.MAX_SAFE_INTEGER };

/** What a host's agent turns were read for. This host's come from its ingest
    once that has read, and from the search index before it; another host's
    arrive only by its pull. An export or a ledger carries no agent turn, so a
    host read by nothing else has none read. */
export function agentSpans(host: HostReport | undefined, local: AgentSourceRead["local"]): Interval[] {
  if (!host) return [];
  if (host.local && local !== "ingest") return [ALWAYS];
  return host.sources.find((source) => source.source === (host.local ? "ingest" : "pull"))?.covered ?? [];
}

/** Rows are one per canonical project, so two rows that would read the same
    name are two projects: each such name takes a short piece of its key, and
    no name appears twice. */
export function distinctNames<T extends { project: string | null; name: string | null }>(rows: readonly T[]): T[] {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.name) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  return rows.map((row) => {
    if (!row.name || row.project === null || (counts.get(row.name) ?? 0) < 2) return row;
    const suffix = row.project.replace(/^[a-z]+-/, "").slice(0, 6);
    return { ...row, name: `${row.name} · ${suffix}` };
  });
}
