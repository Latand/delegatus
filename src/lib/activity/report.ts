import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";

import { cachedAgentConversations, type AgentSourceRead } from "./agentSource";
import {
  activityReport,
  clampMethodParams,
  MINUTE_MS,
  RANGE_KEYS,
  rangeDays,
  serverTimeZone,
  type ActivityReport,
  type Anchor,
  type MethodParams,
  type ProjectActivity,
  type RangeKey,
} from "./method";
import { readRequests, type LedgerRead } from "./requestLedger";

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

export interface ActivityResponse extends Omit<ActivityReport, "projects" | "params"> {
  generatedAt: number;
  params: { windowMin: number; breakMin: number; rounding: MethodParams["rounding"]; tz: string };
  coverage: {
    ledger: SourceState;
    ledgerStartMs: number | null;
    agentIndex: SourceState;
    indexedAtMs: number | null;
    unregisteredConversations: number;
  };
  projects: ActivityProjectRow[];
}

export interface ActivityQuery {
  range: RangeKey;
  params: MethodParams;
}

/** Every input is clamped: a bad value gets its default, never an error. */
export function parseActivityQuery(search: URLSearchParams, fallbackTz: string = serverTimeZone()): ActivityQuery {
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
  readRequests(fromMs: number, toMs: number): LedgerRead;
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
  readRequests: (fromMs, toMs) => readRequests(fromMs, toMs),
  agents: cachedAgentConversations,
  canonicalProject,
  projectNames: catalogProjectNames,
};

export async function activityResponse(
  query: ActivityQuery,
  overrides: Partial<ActivityResponseDependencies> = {},
): Promise<ActivityResponse> {
  const dependencies = { ...productionDependencies, ...overrides };
  const nowMs = dependencies.now();
  const { params, range } = query;
  const days = rangeDays(range, nowMs, params.tz);
  const window = { start: days[0]!.start, end: days.at(-1)!.end };

  let ledger: SourceState = "ok";
  let ledgerRead: LedgerRead = { anchors: [], ledgerStartMs: null };
  try {
    /* From T before the first day: an episode running into the range from
       before it is then counted exactly (see ReportInput.anchors). */
    ledgerRead = dependencies.readRequests(window.start - params.breakMs, Math.min(window.end, nowMs));
    if (ledgerRead.ledgerStartMs === null) ledger = "absent";
  } catch {
    ledger = "unreadable";
  }
  const anchors: Anchor[] = ledgerRead.anchors.map((anchor) => {
    if (anchor.project === null) return anchor;
    const project = dependencies.canonicalProject(anchor.project);
    return { ...anchor, project: project && project !== UNRESOLVED_PROJECT ? project : null };
  });

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
    ledgerStartMs: ledgerRead.ledgerStartMs,
    agents: agentRead.agents,
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
    ledgerStartMs: report.ledgerStartMs,
    coverage: {
      ledger,
      ledgerStartMs: ledgerRead.ledgerStartMs,
      agentIndex,
      indexedAtMs: agentRead.index.indexedAtMs,
      unregisteredConversations: report.totals.unregisteredConversations,
    },
    totals: report.totals,
    days: report.days,
    projects: report.projects.map((row) => ({ ...row, name: row.project === null ? null : names.get(row.project) ?? null })),
  };
}
