import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { memberInitials, type MemberColor } from "@/lib/team/contract";
import { existingTeamStore } from "@/lib/team/store";

import { cachedAgentConversations, type AgentSourceRead } from "./agentSource";
import { readHumanInputs, type ActivityViewer, type HostReport, type HumanInputRead } from "./hostSources";
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
  type Coverage,
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
  /** Human inputs whose author cannot be established; excluded from hours. */
  unknownAuthorInputs: number;
  /** Whose input the human figures count (docs/design/activity-dashboard.md,
      "The owner's view of every member"). */
  member: ActivityMemberView;
}

/** One person on the owner's member filter, with their own figures. */
export interface ActivityMemberRow {
  /** A member id, or `operator` on a solo host. */
  id: string;
  /** From the team roster; null for an author the roster does not name
      (the solo host's operator, a removed member). No email, no handle. */
  name: string | null;
  color: MemberColor | null;
  initials: string | null;
  /** The viewer. */
  self: boolean;
  /** Their own count over the page's range and project: the method run over
      their input alone, the same count their own page makes. */
  humanMs: number;
  humanHours: number;
  billableHours: number;
  requests: number;
  /** Incomplete where a host holding their input was not read for them: a
      remote host pulled for another member is never a zero for this one. */
  coverage: Coverage;
  /** Workdays of theirs flagged as a probable missing source, as their own
      page counts them: their figure is then a lower bound too. */
  missingSourceDays: number;
  /** Their projects, most report hours first. */
  projects: Array<{ project: string | null; name: string | null; humanMs: number; humanHours: number; requests: number }>;
}

export interface ActivityMemberView {
  /** `self`: the viewer's own input, as always; `member`: one member's;
      `all`: every known author, each counted alone and summed. */
  selection: "self" | "member" | "all";
  /** The member the figures count; null under `all`. */
  memberId: string | null;
  /** The viewer may choose another member: the owner, or a solo host's operator. */
  canChoose: boolean;
  /** Members with input in the range, the viewer, the member chosen, and any
      active member a host was not read for. Empty unless `canChoose`. */
  members: ActivityMemberRow[];
  /** Figures no member owns: agent time is one axis for the whole host (its
      supervised part is supervised by whoever was present), and inputs whose
      author is unknown belong to nobody. Empty unless `canChoose`. */
  notSplit: Array<"agents" | "unknownAuthorInputs">;
}

/** The request's viewer: whose session asked, and whether it may read others. */
export interface ActivityRequestViewer extends Omit<ActivityViewer, "everyone"> {
  /** The owner, or the operator of a solo host. */
  canChoose?: boolean;
}

export const ACTIVITY_MEMBER_FORBIDDEN = "activity_member_forbidden";

/** Another member's activity was asked for by someone who is not the owner. */
export class ActivityMemberForbidden extends Error {
  readonly code = ACTIVITY_MEMBER_FORBIDDEN;
  constructor() {
    super("only the owner can read another member's activity");
  }
}

export type MemberSelection = { kind: "self" } | { kind: "all" } | { kind: "member"; id: string };

const MEMBER_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** `member`: absent or malformed is the viewer's own, `all` every member,
    anything else a member id. */
export function parseMemberSelection(search: URLSearchParams): MemberSelection {
  const raw = search.get("member")?.trim() ?? "";
  if (raw === "all") return { kind: "all" };
  return raw && MEMBER_ID.test(raw) ? { kind: "member", id: raw } : { kind: "self" };
}

export interface RosterMember {
  id: string;
  name: string;
  color: MemberColor;
  initials: string;
  status: "active" | "revoked";
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
  humanInputs(window: { start: number; end: number }, nowMs: number, viewer?: ActivityViewer): HumanInputRead;
  agents(cacheKey: string, range: { start: number; end: number }, nowMs: number): AgentSourceRead;
  canonicalProject(project: string): string;
  /** Live display names by project key. */
  projectNames(): Promise<ReadonlyMap<string, string>>;
  /** The team's members, for names and avatars; empty on a host with none. */
  roster(): RosterMember[];
}

function teamRoster(): RosterMember[] {
  try {
    return (existingTeamStore()?.members() ?? []).map((member) => ({
      id: member.id, name: member.name, color: member.color, initials: memberInitials(member.name), status: member.status,
    }));
  } catch {
    return [];
  }
}

/** Names from the board's last scan and the project aliases. A cold scan
    takes tens of seconds, so none is started or awaited: until one has
    finished, the page names projects by their readable keys. */
export async function catalogProjectNames(): Promise<ReadonlyMap<string, string>> {
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
  humanInputs: (window, nowMs, viewer) => readHumanInputs(window, nowMs, {}, viewer),
  agents: cachedAgentConversations,
  canonicalProject,
  projectNames: catalogProjectNames,
  roster: teamRoster,
};

export async function activityResponse(
  search: URLSearchParams,
  overrides: Partial<ActivityResponseDependencies> = {},
  viewer?: ActivityRequestViewer,
): Promise<ActivityResponse> {
  const dependencies = { ...productionDependencies, ...overrides };
  const canChoose = viewer?.canChoose === true;
  const selection = parseMemberSelection(search);
  /* Anyone may name themselves; only the owner may name someone else. */
  if (!canChoose && (selection.kind === "all" || (selection.kind === "member" && selection.id !== viewer?.memberId))) {
    throw new ActivityMemberForbidden();
  }
  const nowMs = dependencies.now();
  const settings = dependencies.settings();
  const query = parseActivityQuery(search, settings.tz);
  const { params, range } = query;
  const days = rangeDays(range, nowMs, params.tz);
  const window = { start: days[0]!.start, end: days.at(-1)!.end };

  /* From T before the first day: an episode running into the range from
     before it is then counted exactly (see ReportInput.anchors). A source
     that cannot be read covers nothing, which leaves its host unknown. The
     owner's read holds every member's input, each tagged with its author. */
  const readViewer = viewer ? { mode: viewer.mode, memberId: viewer.memberId, ...(canChoose ? { everyone: true } : {}) } : undefined;
  const human = dependencies.humanInputs({ start: window.start - params.breakMs, end: Math.min(window.end, nowMs) }, nowMs, readViewer);
  if (canChoose && human.operator === undefined) throw new Error("the owner's read of every member did not happen");
  const canonical = (project: string | null): string | null => {
    if (project === null) return null;
    const resolved = dependencies.canonicalProject(project);
    return resolved && resolved !== UNRESOLVED_PROJECT ? resolved : null;
  };
  const anchorsOf = (inputs: HumanInputRead["inputs"]): Anchor[] => inputs.map((input) => ({
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
  const billable = settings.billable.map((project) => canonical(project) ?? project);
  const reportFor = (anchors: Anchor[], hosts: HostCoverage[], agents: AgentSourceRead["agents"]) => activityReport({
    params,
    range,
    nowMs,
    anchors,
    hosts,
    agents,
    billable,
    workdays: settings.workdays,
    ...(scope === null ? {} : { scope: { project: scope } }),
  });

  /* The owner's read: whose input each figure counts, and what each host was
     read for on that person's behalf. A remote host pulled for the operator
     alone was not read for anyone else. */
  const operator = human.operator ?? viewer?.memberId ?? null;
  const scopedHosts = new Set(human.hosts.filter((host) => host.memberScoped).map((host) => host.host));
  const notReadForOthers = hostCoverage.map((host) => (scopedHosts.has(host.host) ? { ...host, covered: [] } : host));
  const coverageFor = (member: string | null): HostCoverage[] => (member === operator ? hostCoverage : notReadForOthers);
  const byAuthor = new Map<string, HumanInputRead["inputs"]>();
  if (canChoose) {
    for (const input of human.inputs) {
      if (!input.author) continue;
      const list = byAuthor.get(input.author);
      if (list) list.push(input);
      else byAuthor.set(input.author, [input]);
    }
  }
  const names = await dependencies.projectNames();
  const memberRows = canChoose ? memberRowsFor({
    byAuthor, operator: operator!, selection, roster: dependencies.roster(), window: { start: window.start, end: Math.min(window.end, nowMs) },
    scoped: scope === null ? scopedHosts.size > 0 : hostCoverage.some((host) => scopedHosts.has(host.host) && holdsProject(host, scope)),
    count: (member) => reportFor(anchorsOf(byAuthor.get(member) ?? []), coverageFor(member), agentRead.agents),
  }) : [];

  const counted = selection.kind === "all" ? null : selection.kind === "member" ? selection.id : canChoose ? operator : viewer?.memberId ?? null;
  /* Every member together misses what a one-person host holds of the others'. */
  const viewCoverage = selection.kind === "all"
    ? memberRows.some((row) => row.id !== operator) ? notReadForOthers : hostCoverage
    : coverageFor(counted);
  const viewInputs = !canChoose || selection.kind === "all" ? human.inputs : byAuthor.get(counted!) ?? [];
  let report = reportFor(anchorsOf(viewInputs), viewCoverage, agentRead.agents);
  if (selection.kind === "all") report = sumMembers(report, memberRows.map((row) => row.report));

  const projects = distinctNames(report.projects.map((row) => ({ ...row, name: row.project === null ? null : names.get(row.project) ?? null })));
  const nameOf = (project: string | null) => project === null ? null : projects.find((row) => row.project === project)?.name ?? names.get(project) ?? null;
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
        const coverage = viewCoverage.filter((entry) => entry.host === host.host);
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
    unknownAuthorInputs: human.unknownAuthors ?? 0,
    member: {
      selection: selection.kind === "member" && selection.id === (canChoose ? operator : viewer?.memberId) ? "self" : selection.kind,
      memberId: counted,
      canChoose,
      members: memberRows.map(({ report: _report, ...row }) => ({
        ...row,
        projects: row.projects.map((entry) => ({ ...entry, name: nameOf(entry.project) })),
      })),
      notSplit: canChoose ? ["agents", "unknownAuthorInputs"] : [],
    },
  };
}

type CountedMember = ActivityMemberRow & { report: ActivityReport };

/** The owner's filter: every author with input in the range, the owner, the
    member asked for, and, when a host was read for the owner alone, every
    active member, whose input there is unread rather than zero. Most report
    hours first, the owner leading a tie. */
function memberRowsFor(input: {
  byAuthor: ReadonlyMap<string, HumanInputRead["inputs"]>;
  operator: string;
  selection: MemberSelection;
  roster: RosterMember[];
  window: Interval;
  /** A host the page's figures depend on was read for the operator alone. */
  scoped: boolean;
  count(member: string): ActivityReport;
}): CountedMember[] {
  const ids = new Set<string>([input.operator]);
  for (const [author, inputs] of input.byAuthor) {
    if (inputs.some((entry) => entry.at >= input.window.start && entry.at <= input.window.end)) ids.add(author);
  }
  if (input.selection.kind === "member") ids.add(input.selection.id);
  if (input.scoped) for (const member of input.roster) if (member.status === "active") ids.add(member.id);
  const roster = new Map(input.roster.map((member) => [member.id, member]));
  return [...ids].map((id) => {
    const report = input.count(id);
    const person = roster.get(id);
    return {
      id,
      name: person?.name ?? null,
      color: person?.color ?? null,
      initials: person?.initials ?? null,
      self: id === input.operator,
      humanMs: report.totals.humanMs,
      humanHours: report.totals.humanHours,
      billableHours: report.totals.billableHours,
      requests: report.totals.requests,
      coverage: report.totals.coverage,
      missingSourceDays: report.totals.missingSourceDays,
      projects: report.projects
        .filter((row) => row.humanMs > 0 || row.requests > 0)
        .sort((a, b) => b.humanHours - a.humanHours || b.humanMs - a.humanMs)
        .map((row) => ({ project: row.project, name: null, humanMs: row.humanMs, humanHours: row.humanHours, requests: row.requests })),
      report,
    };
  }).sort((a, b) => b.humanHours - a.humanHours || b.humanMs - a.humanMs || Number(b.self) - Number(a.self) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

/**
 * Every member at once: the method runs over each member's input alone, and
 * their human figures are added up, so two people working the same hour are
 * two hours. The page's structure comes from one run over everyone's input:
 * its agent split is supervised by whoever was present, and its hour cells
 * and day stretches draw when anyone was.
 */
export function sumMembers(union: ActivityReport, members: readonly ActivityReport[]): ActivityReport {
  const sum = <T>(pick: (report: ActivityReport) => T[], value: (item: T) => number) =>
    members.reduce((total, report) => total + pick(report).reduce((part, item) => part + value(item), 0), 0);
  const totals = { ...union.totals };
  totals.humanMs = sum((report) => [report.totals], (entry) => entry.humanMs);
  totals.humanHours = sum((report) => [report.totals], (entry) => entry.humanHours);
  totals.billableHours = sum((report) => [report.totals], (entry) => entry.billableHours);
  totals.requests = sum((report) => [report.totals], (entry) => entry.requests);
  const days = union.days.map((day) => {
    const same = (report: ActivityReport) => report.days.filter((entry) => entry.date === day.date);
    const byProject = new Map<string | null, { project: string | null; humanMs: number; humanHours: number }>();
    for (const report of members) for (const entry of same(report)) for (const row of entry.projects) {
      const into = byProject.get(row.project) ?? { project: row.project, humanMs: 0, humanHours: 0 };
      into.humanMs += row.humanMs;
      into.humanHours += row.humanHours;
      byProject.set(row.project, into);
    }
    return {
      ...day,
      humanMs: sum(same, (entry) => entry.humanMs),
      humanHours: sum(same, (entry) => entry.humanHours),
      billableHours: sum(same, (entry) => entry.billableHours),
      projects: [...byProject.values()].sort((a, b) => b.humanMs - a.humanMs),
    };
  });
  const projects = union.projects.map((row) => {
    const same = (report: ActivityReport) => report.projects.filter((entry) => entry.project === row.project);
    const add = (field: "bySurface" | "byKind" | "byHost") => {
      const out: Record<string, number> = field === "byHost" ? {} : Object.fromEntries(Object.keys(row[field]).map((key) => [key, 0]));
      for (const report of members) for (const entry of same(report)) for (const [key, ms] of Object.entries(entry[field])) out[key] = (out[key] ?? 0) + ms;
      return out;
    };
    return {
      ...row,
      humanMs: sum(same, (entry) => entry.humanMs),
      humanOwnMs: sum(same, (entry) => entry.humanOwnMs),
      humanReassignedMs: sum(same, (entry) => entry.humanReassignedMs),
      humanHours: sum(same, (entry) => entry.humanHours),
      requests: sum(same, (entry) => entry.requests),
      episodes: sum(same, (entry) => entry.episodes),
      bySurface: add("bySurface") as ProjectActivity["bySurface"],
      byKind: add("byKind") as ProjectActivity["byKind"],
      byHost: add("byHost"),
    };
  });
  return { ...union, totals, days, projects };
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
