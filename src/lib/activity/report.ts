import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";

import { cachedAgentConversations, type AgentSourceRead } from "./agentSource";
import { readHumanInputs, type HostReport, type HumanInputRead } from "./hostSources";
import { readActivitySettings, type ActivitySettings } from "./settings";
import {
  activityReport,
  clampMethodParams,
  MINUTE_MS,
  METHOD_DEFAULTS,
  RANGE_KEYS,
  rangeDays,
  uncoveredSpans,
  type ActivityReport,
  type Anchor,
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
}

export interface ActivityResponse extends Omit<ActivityReport, "projects" | "params"> {
  generatedAt: number;
  params: { windowMin: number; breakMin: number; rounding: MethodParams["rounding"]; tz: string };
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
}

/** Every input is clamped: a bad value gets its default, never an error. The
    zone defaults to the settings' zone (Europe/Kyiv unless set). */
export function parseActivityQuery(search: URLSearchParams, fallbackTz: string = METHOD_DEFAULTS.tz): ActivityQuery {
  const rawRange = search.get("range");
  const range = RANGE_KEYS.includes(rawRange as RangeKey) ? rawRange as RangeKey : "7d";
  const minutes = (value: string | null) => value === null || !value.trim() ? undefined : Number(value) * MINUTE_MS;
  return {
    range,
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
  const { params, range } = parseActivityQuery(search, settings.tz);
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
  const hostCoverage = human.coverage.map((host) => ({
    ...host,
    projects: host.projects === "all" ? "all" as const : host.projects.map((project) => canonical(project) ?? project),
  }));

  let agentIndex: SourceState = "ok";
  let agentRead: AgentSourceRead = { agents: [], index: { available: false, indexedAtMs: null } };
  try {
    agentRead = dependencies.agents(`${range}:${params.tz}:${window.start}`, window, nowMs);
    if (!agentRead.index.available) agentIndex = "absent";
  } catch {
    agentIndex = "unreadable";
  }

  const report = activityReport({
    params,
    range,
    nowMs,
    anchors,
    hosts: hostCoverage,
    agents: agentRead.agents,
    billable: settings.billable.map((project) => canonical(project) ?? project),
    workdays: settings.workdays,
  });
  const names = await dependencies.projectNames();
  return {
    generatedAt: nowMs,
    params: {
      windowMin: params.windowMs / MINUTE_MS,
      breakMin: params.breakMs / MINUTE_MS,
      rounding: params.rounding,
      tz: params.tz,
    },
    range: report.range,
    coverage: {
      hostsConfig: human.config,
      hosts: human.hosts.map((host) => ({
        ...host,
        complete: uncoveredSpans({ start: window.start, end: Math.min(window.end, nowMs) }, hostCoverage.filter((entry) => entry.host === host.host)).hosts.length === 0,
      })),
      agentIndex,
      indexedAtMs: agentRead.index.indexedAtMs,
      unregisteredConversations: report.totals.unregisteredConversations,
    },
    totals: report.totals,
    days: report.days,
    billableConfigured: settings.billable.length > 0,
    projects: report.projects.map((row) => ({ ...row, name: row.project === null ? null : names.get(row.project) ?? null })),
  };
}
