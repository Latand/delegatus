import type { RequestSurface } from "@/lib/view/device";

/*
 * The operator's counting method, and the agent axis beside it
 * (docs/design/activity-dashboard.md, "Counting method" and "Agent axis
 * calculation"). Pure: no I/O, no clock, no environment. Every figure the
 * activity dashboard shows is computed here from four inputs: the human
 * inputs every expected host yielded, what each host was read for, the agent
 * turns read from the search index, and the method parameters.
 *
 * Human time and agent time are two parallel axes. Neither is subtracted from
 * the other: agent work inside a human episode is SUPERVISED and is already
 * inside the human figure, agent work outside every episode is UNATTENDED and
 * adds nothing to it. Only a human input opens or extends an episode. Every
 * input is bucketed by its own time in the configured zone, whatever day its
 * session began.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
const HALF_HOUR_MS = 30 * MINUTE_MS;

/** Where a human input was made. The request ledger names the browser
    surface; a host's transcripts add `terminal` (typed straight into an agent
    CLI or desktop app) and `unknown` (a Delegatus delivery recovered from a
    transcript, whose surface was never recorded). */
export type Surface = RequestSurface | "terminal" | "unknown";
export const SURFACES: readonly Surface[] = ["desktop", "tablet", "phone", "other", "terminal", "unknown"];

export type RequestKind = "message" | "dialog" | "answer" | "spawn" | "voice" | "decision" | "pipeline" | "task";
export const REQUEST_KINDS: readonly RequestKind[] = ["message", "dialog", "answer", "spawn", "voice", "decision", "pipeline", "task"];

/** Why a user record in a transcript is not operator input. */
export type ExclusionReason =
  /** A spawn's first prompt: a role scaffold or another agent's delegation. */
  | "scaffold"
  /** A pipeline stage's generated prompt (builder, reviewer, auditor, deployer…). */
  | "stage-template"
  /** Bridge, automation and recovery notifications, compaction summaries. */
  | "notification"
  /** Injected skill hints, system reminders, instructions, command output. */
  | "injected"
  /** A screenshot attached by the client. */
  | "attachment"
  /** A message from one agent to another that arrived with role=user. */
  | "agent-message"
  /** A subagent's prompt from its parent agent. */
  | "subagent"
  /** A non-interactive run: `codex exec`, an SDK session no Viewer owns. */
  | "automation"
  | "interrupt"
  /** No positive operator signal: counted conservatively as not operator input. */
  | "unmarked"
  /** A copy of an input already counted. */
  | "duplicate";

export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "scaffold", "stage-template", "notification", "injected", "attachment", "agent-message", "subagent", "automation", "interrupt", "unmarked", "duplicate",
];

export type Rounding = "half-hour" | "clock-hour";
export type RangeKey = "today" | "7d" | "30d";
export const RANGE_KEYS: readonly RangeKey[] = ["today", "7d", "30d"];
const RANGE_DAYS: Record<RangeKey, number> = { today: 1, "7d": 7, "30d": 30 };

export type AgentEngine = "claude" | "codex" | "copilot";
/** A conversation the registry does not know. */
export const UNREGISTERED_ROLE = "unregistered";
/** A registered conversation launched with no role preset. */
export const NO_ROLE = "none";

export interface MethodParams {
  /** W: the engagement window after each request. */
  windowMs: number;
  /** T: a gap to the next request above this ends the episode. */
  breakMs: number;
  rounding: Rounding;
  /** The IANA zone that decides days and clock hours. */
  tz: string;
}

/** The defaults are the method the operator restated on 2026-09-24 and used
    for the recount they accepted: a 10-minute window per input, windows
    combined only where they overlap (T = W), clock-hour weights, days and
    hours in Europe/Kyiv. `break=30&rounding=half-hour` is the 2026-07-29
    refinement. */
export const METHOD_DEFAULTS = { windowMin: 10, breakMin: null as number | null, rounding: "clock-hour" as Rounding, tz: "Europe/Kyiv" };
export const WINDOW_LIMITS_MIN = { min: 10, max: 15 } as const;
export const BREAK_MAX_MIN = 120;

export interface Anchor {
  at: number;
  project: string | null;
  surface: Surface;
  kind: RequestKind;
  /** The host the input was made on. One operator works across hosts, so
      episodes join anchors of every host; the host only labels the time. */
  host: string;
}

/**
 * What one expected host's human-input sources could speak for. A host whose
 * spans do not cover a stretch of time leaves that stretch UNKNOWN for every
 * project the host holds: its input there may exist and was not read, so the
 * report never shows it as zero.
 */
export interface HostCoverage {
  host: string;
  /** The projects whose input can come from this host. */
  projects: "all" | readonly string[];
  /** Before this instant the host held no work, so nothing is missing. */
  since: number | null;
  /** The stretches its sources were read for. */
  covered: readonly Interval[];
}

export interface Coverage {
  complete: boolean;
  /** Expected hosts that were not read for part of the window. */
  missingHosts: string[];
}

export interface Interval {
  start: number;
  end: number;
}

export interface Episode extends Interval {
  project: string | null;
  anchors: Anchor[];
}

/** A stretch of human time and the one anchor it belongs to: the most recent
    anchor at or before it among the episodes covering it. */
export interface HumanSegment extends Interval {
  project: string | null;
  surface: Surface;
  kind: RequestKind;
  host: string;
  anchorAt: number;
}

export interface AgentRow {
  transcriptPath: string;
  speaker: "user" | "assistant";
  atMs: number;
  /** Order of rows that share a timestamp (the index's message order). */
  seq?: number;
}

/** One agent conversation's activity and provenance, already joined. The key
    stays on the server: it may be a transcript path. */
export interface AgentConversation {
  key: string;
  project: string | null;
  engine: AgentEngine;
  role: string;
  pipelineId: string | null;
  stageId: string | null;
  activity: Interval[];
}

/* ------------------------------------------------------------------------ */
/* Parameters                                                               */
/* ------------------------------------------------------------------------ */

export function validTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Clamp, never refuse: every value that is missing or out of range takes its
 * default or its nearest bound. W is 10-15 minutes, T is W to 120 minutes (a T
 * below W, and a missing T, become W), both in whole minutes; an unknown
 * rounding is `clock-hour`; an unknown zone falls back to `fallbackTz`.
 */
export function clampMethodParams(
  input: Partial<Record<keyof MethodParams, unknown>>,
  fallbackTz: string = METHOD_DEFAULTS.tz,
): MethodParams {
  const windowInput = finiteNumber(input.windowMs);
  const windowMin = Math.min(WINDOW_LIMITS_MIN.max, Math.max(WINDOW_LIMITS_MIN.min,
    Math.round((windowInput ?? METHOD_DEFAULTS.windowMin * MINUTE_MS) / MINUTE_MS)));
  const breakInput = finiteNumber(input.breakMs);
  const breakMin = Math.min(BREAK_MAX_MIN, Math.max(windowMin,
    Math.round((breakInput ?? (METHOD_DEFAULTS.breakMin ?? windowMin) * MINUTE_MS) / MINUTE_MS)));
  const rounding: Rounding = input.rounding === "clock-hour" || input.rounding === "half-hour"
    ? input.rounding
    : METHOD_DEFAULTS.rounding;
  return {
    windowMs: windowMin * MINUTE_MS,
    breakMs: breakMin * MINUTE_MS,
    rounding,
    tz: validTimeZone(input.tz) ?? validTimeZone(fallbackTz) ?? "UTC",
  };
}

/* ------------------------------------------------------------------------ */
/* Interval algebra (every list normalized: sorted, disjoint, non-touching) */
/* ------------------------------------------------------------------------ */

export function unionIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((item) => item.end > item.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ start: item.start, end: item.end });
  }
  return merged;
}

export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (end > start) out.push({ start, end });
    if (a[i]!.end < b[j]!.end) i += 1;
    else j += 1;
  }
  return out;
}

export function subtractIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const item of a) {
    let cursor = item.start;
    while (j < b.length && b[j]!.end <= cursor) j += 1;
    let k = j;
    while (k < b.length && b[k]!.start < item.end) {
      if (b[k]!.start > cursor) out.push({ start: cursor, end: b[k]!.start });
      cursor = Math.max(cursor, b[k]!.end);
      k += 1;
    }
    if (cursor < item.end) out.push({ start: cursor, end: item.end });
  }
  return out;
}

export function clipIntervals<T extends Interval>(list: readonly T[], from: number, to: number): T[] {
  const out: T[] = [];
  for (const item of list) {
    const start = Math.max(item.start, from);
    const end = Math.min(item.end, to);
    if (end > start) out.push({ ...item, start, end });
  }
  return out;
}

export function totalMs(list: readonly Interval[]): number {
  let sum = 0;
  for (const item of list) sum += item.end - item.start;
  return sum;
}

/* ------------------------------------------------------------------------ */
/* Calendar in a zone                                                       */
/* ------------------------------------------------------------------------ */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    FORMATTERS.set(tz, found);
  }
  return found;
}

interface WallClock { y: number; m: number; d: number; h: number; mi: number; s: number }

function wallClock(t: number, tz: string): WallClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatter(tz).formatToParts(new Date(t))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour! % 24, mi: parts.minute!, s: parts.second! };
}

function offsetMs(t: number, tz: string): number {
  const w = wallClock(t, tz);
  const whole = t - (((t % 1000) + 1000) % 1000);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - whole;
}

/** The instant a wall-clock date begins in the zone. */
function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

export interface ZonedDay extends Interval {
  /** The wall-clock date, YYYY-MM-DD. */
  date: string;
}

function dateKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function shiftDate(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return { y: shiftedUTC(shifted, "y"), m: shiftedUTC(shifted, "m"), d: shiftedUTC(shifted, "d") };
}

function shiftedUTC(date: Date, part: "y" | "m" | "d"): number {
  return part === "y" ? date.getUTCFullYear() : part === "m" ? date.getUTCMonth() + 1 : date.getUTCDate();
}

function zonedDayAt(y: number, m: number, d: number, tz: string): ZonedDay {
  const next = shiftDate(y, m, d, 1);
  return { date: dateKey(y, m, d), start: zonedMidnight(y, m, d, tz), end: zonedMidnight(next.y, next.m, next.d, tz) };
}

/** The wall-clock day a `YYYY-MM-DD` date names in the zone, or null. */
export function zonedDate(date: string, tz: string): ZonedDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return zonedDayAt(y, m, d, tz);
}

/** The last `days` wall-clock days ending with the day of `nowMs`, oldest first. */
export function zonedDays(nowMs: number, days: number, tz: string): ZonedDay[] {
  const w = wallClock(nowMs, tz);
  const out: ZonedDay[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const date = shiftDate(w.y, w.m, w.d, -back);
    out.push(zonedDayAt(date.y, date.m, date.d, tz));
  }
  return out;
}

export function rangeDays(key: RangeKey, nowMs: number, tz: string): ZonedDay[] {
  return zonedDays(nowMs, RANGE_DAYS[key], tz);
}

/** Clock hours of one day: steps of an hour from local midnight, the last one
    cut at the day's end (a 23- or 25-hour day keeps its real length). */
function clockHours(day: Interval): Interval[] {
  const hours: Interval[] = [];
  for (let start = day.start; start < day.end; start += HOUR_MS) hours.push({ start, end: Math.min(day.end, start + HOUR_MS) });
  return hours;
}

/* ------------------------------------------------------------------------ */
/* Human axis                                                               */
/* ------------------------------------------------------------------------ */

const projectKey = (project: string | null): string => project ?? "";
const projectOf = (key: string): string | null => key === "" ? null : key;

/**
 * Step 1: episodes, per project. Consecutive anchors whose gap is at most T
 * share an episode, which covers [first anchor, last anchor + W], clipped at
 * now. A lone request covers exactly W. Anchors after now are ignored.
 */
export function humanEpisodes(anchors: readonly Anchor[], params: MethodParams, nowMs: number): Episode[] {
  const byProject = new Map<string, Anchor[]>();
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.at) || anchor.at > nowMs) continue;
    const key = projectKey(anchor.project);
    const list = byProject.get(key);
    if (list) list.push(anchor);
    else byProject.set(key, [anchor]);
  }
  const episodes: Episode[] = [];
  for (const [key, list] of byProject) {
    list.sort((a, b) => a.at - b.at);
    let current: Anchor[] = [];
    const close = () => {
      if (!current.length) return;
      const start = current[0]!.at;
      const end = Math.min(current.at(-1)!.at + params.windowMs, nowMs);
      if (end > start) episodes.push({ project: projectOf(key), start, end, anchors: current });
      current = [];
    };
    for (const anchor of list) {
      if (current.length && anchor.at - current.at(-1)!.at > params.breakMs) close();
      current.push(anchor);
    }
    close();
  }
  return episodes.sort((a, b) => a.start - b.start || projectKey(a.project).localeCompare(projectKey(b.project)));
}

/**
 * Steps 3 and 4: one minute is counted once. The union of every episode is
 * cut into segments, and each segment goes to the most recent anchor at or
 * before it among the episodes covering it: that anchor's project, surface and
 * kind label it, so the per-project, per-surface and per-kind figures all
 * partition the same total. An exact tie in time goes to the greater project
 * key, so the answer never depends on input order.
 */
export function humanSegments(episodes: readonly Episode[]): HumanSegment[] {
  const bounds = new Set<number>();
  for (const episode of episodes) {
    bounds.add(episode.start);
    bounds.add(episode.end);
    for (const anchor of episode.anchors) if (anchor.at > episode.start && anchor.at < episode.end) bounds.add(anchor.at);
  }
  const points = [...bounds].sort((a, b) => a - b);
  const sorted = [...episodes].sort((a, b) => a.start - b.start);
  const pointer = new Map<Episode, number>();
  let active: Episode[] = [];
  let next = 0;
  const out: HumanSegment[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    active = active.filter((episode) => episode.end > start);
    while (next < sorted.length && sorted[next]!.start <= start) {
      if (sorted[next]!.end > start) active.push(sorted[next]!);
      next += 1;
    }
    let owner: Anchor | null = null;
    for (const episode of active) {
      let at = pointer.get(episode) ?? 0;
      while (at + 1 < episode.anchors.length && episode.anchors[at + 1]!.at <= start) at += 1;
      pointer.set(episode, at);
      const candidate = episode.anchors[at]!;
      if (!owner || candidate.at > owner.at
        || (candidate.at === owner.at && projectKey(candidate.project) > projectKey(owner.project))) owner = candidate;
    }
    if (!owner) continue;
    const last = out.at(-1);
    if (last && last.end === start && last.anchorAt === owner.at && last.project === owner.project
      && last.surface === owner.surface && last.kind === owner.kind && last.host === owner.host) {
      last.end = end;
    } else {
      out.push({ start, end, project: owner.project, surface: owner.surface, kind: owner.kind, host: owner.host, anchorAt: owner.at });
    }
  }
  return out;
}

/** `half-hour`: raw time to the nearest half hour (a tie rounds up), and any
    non-zero raw time is at least half an hour. */
export function roundHalfHour(ms: number): number {
  if (ms <= 0) return 0;
  return Math.max(0.5, Math.round(ms / HALF_HOUR_MS) * 0.5);
}

/** `clock-hour`: the original weights for the covered minutes of one clock
    hour: under 10 min = 0, 10-39 min = 0.5 h, 40 min or more = 1 h. */
export function clockHourWeight(ms: number): number {
  const minutes = ms / MINUTE_MS;
  if (minutes < 10) return 0;
  if (minutes < 40) return 0.5;
  return 1;
}

/**
 * Step 5, per day: report hours per project. `half-hour` rounds each
 * project's raw time for the day. `clock-hour` combines every window in a
 * clock hour, weighs the hour's covered minutes, and gives the hour to the one
 * project with the most of them (a tie goes to the more recent input).
 */
export function dayReportHours(segments: readonly HumanSegment[], day: Interval, rounding: Rounding): Map<string, number> {
  const hours = new Map<string, number>();
  const inDay = clipIntervals(segments, day.start, day.end);
  if (rounding === "half-hour") {
    const raw = new Map<string, number>();
    for (const segment of inDay) raw.set(projectKey(segment.project), (raw.get(projectKey(segment.project)) ?? 0) + segment.end - segment.start);
    for (const [key, ms] of raw) hours.set(key, roundHalfHour(ms));
    return hours;
  }
  for (const hour of clockHours(day)) {
    const perProject = new Map<string, { ms: number; latest: number }>();
    for (const segment of clipIntervals(inDay, hour.start, hour.end)) {
      const key = projectKey(segment.project);
      const entry = perProject.get(key) ?? { ms: 0, latest: -Infinity };
      entry.ms += segment.end - segment.start;
      entry.latest = Math.max(entry.latest, segment.anchorAt);
      perProject.set(key, entry);
    }
    let winner: [string, { ms: number; latest: number }] | null = null;
    for (const entry of perProject) {
      if (!winner || entry[1].ms > winner[1].ms
        || (entry[1].ms === winner[1].ms && (entry[1].latest > winner[1].latest
          || (entry[1].latest === winner[1].latest && entry[0] > winner[0])))) winner = entry;
    }
    if (!winner) continue;
    let covered = 0;
    for (const entry of perProject.values()) covered += entry.ms;
    const weight = clockHourWeight(covered);
    if (weight > 0) hours.set(winner[0], (hours.get(winner[0]) ?? 0) + weight);
  }
  return hours;
}

/* ------------------------------------------------------------------------ */
/* Agent axis                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Turns from message rows, per transcript. In time order a user row opens a
 * turn, which ends at the last assistant row before the next user row;
 * assistant rows before any user row open a turn at the first of them. A turn
 * with no assistant row, or of zero length, is dropped. Every turn is clipped
 * to the range and to now.
 */
export function agentTurns(rows: readonly AgentRow[], range: Interval, nowMs: number): Map<string, Interval[]> {
  const byPath = new Map<string, AgentRow[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.atMs)) continue;
    const list = byPath.get(row.transcriptPath);
    if (list) list.push(row);
    else byPath.set(row.transcriptPath, [row]);
  }
  const limit = Math.min(range.end, nowMs);
  const out = new Map<string, Interval[]>();
  for (const [transcriptPath, list] of byPath) {
    list.sort((a, b) => a.atMs - b.atMs || (a.seq ?? 0) - (b.seq ?? 0));
    const turns: Interval[] = [];
    let open: number | null = null;
    let lastAssistant: number | null = null;
    const close = () => {
      if (open !== null && lastAssistant !== null && lastAssistant > open) turns.push({ start: open, end: lastAssistant });
      open = null;
      lastAssistant = null;
    };
    for (const row of list) {
      if (row.speaker === "user") {
        close();
        open = row.atMs;
      } else {
        if (open === null) open = row.atMs;
        lastAssistant = row.atMs;
      }
    }
    close();
    const clipped = unionIntervals(clipIntervals(turns, range.start, limit));
    if (clipped.length) out.set(transcriptPath, clipped);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* The report                                                               */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/* Coverage across hosts                                                    */
/* ------------------------------------------------------------------------ */

function holdsProject(host: HostCoverage, project: string | null | undefined): boolean {
  /* A day's total (undefined) and unattributed time (null) can come from any host. */
  if (project === undefined || project === null || host.projects === "all") return true;
  return host.projects.includes(project);
}

/**
 * The stretches of `window` that some expected host holding `project` was
 * not read for, and which hosts. Undefined asks about every project at once.
 * An empty answer is the only state in which a zero may be shown as zero.
 */
export function uncoveredSpans(
  window: Interval,
  hosts: readonly HostCoverage[],
  project?: string | null,
): { spans: Interval[]; hosts: string[] } {
  const spans: Interval[] = [];
  const missing: string[] = [];
  if (window.end <= window.start) return { spans, hosts: missing };
  for (const host of hosts) {
    if (!holdsProject(host, project)) continue;
    const required = { start: Math.max(window.start, host.since ?? window.start), end: window.end };
    if (required.end <= required.start) continue;
    const gaps = subtractIntervals([required], unionIntervals([...host.covered]));
    if (gaps.length) {
      spans.push(...gaps);
      missing.push(host.host);
    }
  }
  return { spans: unionIntervals(spans), hosts: [...new Set(missing)].sort() };
}

function coverageOf(window: Interval, hosts: readonly HostCoverage[], project?: string | null): Coverage {
  const { hosts: missingHosts } = uncoveredSpans(window, hosts, project);
  return { complete: missingHosts.length === 0, missingHosts };
}

/** Monday to Friday: the days a zero is checked for a missing source. */
export const DEFAULT_WORKDAYS: readonly number[] = [1, 2, 3, 4, 5];
/** Agent wall-clock on a zero-hour workday past which the operator was
    probably working somewhere no source reached. */
export const ACTIVE_ELSEWHERE_AGENT_MS = 30 * MINUTE_MS;

export type MissingSourceReason = "unread-source" | "agent-activity";

export interface ReportInput {
  params: MethodParams;
  range: RangeKey;
  nowMs: number;
  /** Anchors from at least T before the first day: an episode reaching into
      the range from before it is then counted exactly. */
  anchors: readonly Anchor[];
  /** Every expected host and what its sources were read for. */
  hosts: readonly HostCoverage[];
  agents: readonly AgentConversation[];
  /** Projects tagged billable in the settings: their report hours are also
      counted on their own, from their own inputs only, as a paid report is. */
  billable?: readonly string[];
  /** Weekdays (0 = Sunday) checked for a probable missing source. */
  workdays?: readonly number[];
}

export interface AgentSplit {
  /** Time when at least one agent worked. */
  wallMs: number;
  /** The part of it inside a human episode of the same project. */
  supervisedMs: number;
  unattendedMs: number;
  /** Parallel work counted once per agent. */
  agentHoursMs: number;
  agentHoursSupervisedMs: number;
  agentHoursUnattendedMs: number;
}

export interface DayActivity extends AgentSplit {
  date: string;
  start: number;
  end: number;
  /** Complete when every expected host was read for the whole day (up to
      now); otherwise the human figures are a lower bound. */
  coverage: Coverage;
  /** The stretches of the day some expected host was not read for. */
  unknown: Interval[];
  humanMs: number;
  humanHours: number;
  /** Report hours of the billable projects alone. */
  billableHours: number;
  /** A workday that reads zero human time while a source was unread or agents
      were busy: probably a source is missing, and the zero is not shown as a
      clean zero. Null otherwise. */
  missingSource: MissingSourceReason[] | null;
  /** Human time, each stretch labelled with the project that owns it and the
      host its input came from. */
  human: Array<{ start: number; end: number; project: string | null; host: string }>;
  /** Agent wall-clock, split into supervised and unattended stretches. */
  agent: Array<{ start: number; end: number; supervised: boolean }>;
}

export interface ProjectActivity extends AgentSplit {
  project: string | null;
  /** Tagged billable in the settings. */
  billable: boolean;
  /** Human time owned by the project after one-minute-once reassignment. */
  humanMs: number;
  /** The project's own episodes before reassignment. */
  humanOwnMs: number;
  /** Minutes of its episodes that went to a more recently asked project. */
  humanReassignedMs: number;
  humanHours: number;
  requests: number;
  episodes: number;
  bySurface: Record<Surface, number>;
  byKind: Record<RequestKind, number>;
  /** Human time by the host its input came from. */
  byHost: Record<string, number>;
  /** Complete when every host holding the project was read for the range. */
  coverage: Coverage;
  /** Agent-hours by engine and by role id. */
  byEngine: Record<string, number>;
  byRole: Record<string, number>;
  pipelines: Array<{ id: string; stages: string[]; agentHoursMs: number }>;
  conversations: number;
}

export interface ActivityReport {
  range: { key: RangeKey; start: number; end: number; now: number };
  params: MethodParams;
  totals: AgentSplit & {
    humanMs: number;
    humanHours: number;
    billableHours: number;
    requests: number;
    unregisteredConversations: number;
    coverage: Coverage;
    /** Days flagged as a probable missing source. */
    missingSourceDays: number;
  };
  days: DayActivity[];
  projects: ProjectActivity[];
}

function emptySplit(): AgentSplit {
  return { wallMs: 0, supervisedMs: 0, unattendedMs: 0, agentHoursMs: 0, agentHoursSupervisedMs: 0, agentHoursUnattendedMs: 0 };
}

function addSplit(into: AgentSplit, from: AgentSplit): void {
  into.wallMs += from.wallMs;
  into.supervisedMs += from.supervisedMs;
  into.unattendedMs += from.unattendedMs;
  into.agentHoursMs += from.agentHoursMs;
  into.agentHoursSupervisedMs += from.agentHoursSupervisedMs;
  into.agentHoursUnattendedMs += from.agentHoursUnattendedMs;
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function mergeLabelled<T extends Interval, L>(list: readonly T[], label: (item: T) => L): Array<Interval & { label: L }> {
  const out: Array<Interval & { label: L }> = [];
  for (const item of [...list].sort((a, b) => a.start - b.start)) {
    const value = label(item);
    const last = out.at(-1);
    if (last && last.end === item.start && last.label === value) last.end = item.end;
    else out.push({ start: item.start, end: item.end, label: value });
  }
  return out;
}

/** Agent split of a set of conversations against the human intervals that
    supervise them, within one window. */
function agentSplit(activities: readonly Interval[][], supervision: readonly Interval[], window: Interval): AgentSplit {
  const split = emptySplit();
  const clipped = activities.map((activity) => clipIntervals(activity, window.start, window.end));
  const wall = unionIntervals(clipped.flat());
  const supervised = intersectIntervals(wall, supervision);
  split.wallMs = totalMs(wall);
  split.supervisedMs = totalMs(supervised);
  split.unattendedMs = split.wallMs - split.supervisedMs;
  for (const activity of clipped) {
    split.agentHoursMs += totalMs(activity);
    split.agentHoursSupervisedMs += totalMs(intersectIntervals(activity, supervision));
  }
  split.agentHoursUnattendedMs = split.agentHoursMs - split.agentHoursSupervisedMs;
  return split;
}

export function activityReport(input: ReportInput): ActivityReport {
  const { params, nowMs } = input;
  const days = rangeDays(input.range, nowMs, params.tz);
  const rangeStart = days[0]!.start;
  const rangeEnd = days.at(-1)!.end;
  const limit = Math.min(rangeEnd, nowMs);

  const episodes = humanEpisodes(input.anchors, params, nowMs);
  const segments = clipIntervals(humanSegments(episodes), rangeStart, limit);
  /* The billable figure is counted as the paid report counts: from the
     billable projects' inputs alone, so another project's request never takes
     a billable minute. */
  const billable = new Set(input.billable ?? []);
  const billableSegments = billable.size
    ? clipIntervals(humanSegments(humanEpisodes(input.anchors.filter((anchor) => anchor.project !== null && billable.has(anchor.project)), params, nowMs)), rangeStart, limit)
    : [];
  const workdays = new Set(input.workdays ?? DEFAULT_WORKDAYS);

  /* Each project's own episodes, before the one-minute-once reassignment: the
     supervision that decides which of its agents' time was watched. */
  const own = new Map<string, Interval[]>();
  const episodeCounts = new Map<string, number>();
  for (const episode of episodes) {
    const key = projectKey(episode.project);
    const list = own.get(key);
    if (list) list.push({ start: episode.start, end: episode.end });
    else own.set(key, [{ start: episode.start, end: episode.end }]);
    if (episode.end > rangeStart && episode.start < limit) episodeCounts.set(key, (episodeCounts.get(key) ?? 0) + 1);
  }
  for (const [key, list] of own) own.set(key, unionIntervals(clipIntervals(list, rangeStart, limit)));

  const agents = input.agents
    .map((agent) => ({ ...agent, activity: unionIntervals(clipIntervals(agent.activity, rangeStart, limit)) }))
    .filter((agent) => agent.activity.length);
  const agentsByProject = new Map<string, typeof agents>();
  for (const agent of agents) {
    const key = projectKey(agent.project);
    const list = agentsByProject.get(key);
    if (list) list.push(agent);
    else agentsByProject.set(key, [agent]);
  }

  const projectKeys = new Set<string>([...own.keys(), ...agentsByProject.keys()]);
  for (const segment of segments) projectKeys.add(projectKey(segment.project));
  for (const anchor of input.anchors) {
    if (anchor.at >= rangeStart && anchor.at <= limit) projectKeys.add(projectKey(anchor.project));
  }
  /* A project a host is known to hold gets a row even with no input read:
     when that host was not read, the row stays and reads unknown. */
  for (const host of input.hosts) if (host.projects !== "all") for (const project of host.projects) projectKeys.add(projectKey(project));
  const rangeWindow = { start: rangeStart, end: limit };
  const projects = new Map<string, ProjectActivity>();
  for (const key of projectKeys) {
    projects.set(key, {
      project: projectOf(key),
      billable: billable.has(key),
      humanMs: 0,
      humanOwnMs: totalMs(own.get(key) ?? []),
      humanReassignedMs: 0,
      humanHours: 0,
      requests: 0,
      episodes: episodeCounts.get(key) ?? 0,
      bySurface: zeroRecord(SURFACES),
      byKind: zeroRecord(REQUEST_KINDS),
      byHost: {},
      coverage: coverageOf(rangeWindow, input.hosts, projectOf(key)),
      byEngine: {},
      byRole: {},
      pipelines: [],
      conversations: 0,
      ...emptySplit(),
    });
  }
  for (const anchor of input.anchors) {
    if (anchor.at >= rangeStart && anchor.at <= limit) projects.get(projectKey(anchor.project))!.requests += 1;
  }
  for (const segment of segments) {
    const row = projects.get(projectKey(segment.project))!;
    const ms = segment.end - segment.start;
    row.humanMs += ms;
    row.bySurface[segment.surface] += ms;
    row.byKind[segment.kind] += ms;
    row.byHost[segment.host] = (row.byHost[segment.host] ?? 0) + ms;
  }

  /* Supervision across all projects, for the day strip: a moment of agent work
     is drawn supervised when its own project had a human episode then. */
  const supervisedAll: Interval[] = [];
  for (const [key, list] of agentsByProject) {
    const supervision = own.get(key) ?? [];
    const pipelines = new Map<string, { stages: Set<string>; agentHoursMs: number }>();
    const row = projects.get(key)!;
    addSplit(row, agentSplit(list.map((agent) => agent.activity), supervision, { start: rangeStart, end: limit }));
    row.conversations = list.length;
    for (const agent of list) {
      const ms = totalMs(agent.activity);
      row.byEngine[agent.engine] = (row.byEngine[agent.engine] ?? 0) + ms;
      row.byRole[agent.role] = (row.byRole[agent.role] ?? 0) + ms;
      if (agent.pipelineId) {
        const entry = pipelines.get(agent.pipelineId) ?? { stages: new Set<string>(), agentHoursMs: 0 };
        entry.agentHoursMs += ms;
        if (agent.stageId) entry.stages.add(agent.stageId);
        pipelines.set(agent.pipelineId, entry);
      }
      supervisedAll.push(...intersectIntervals(agent.activity, supervision));
    }
    row.pipelines = [...pipelines]
      .map(([id, entry]) => ({ id, stages: [...entry.stages].sort(), agentHoursMs: entry.agentHoursMs }))
      .sort((a, b) => b.agentHoursMs - a.agentHoursMs || a.id.localeCompare(b.id))
      .slice(0, 5);
  }
  const supervisedUnion = unionIntervals(supervisedAll);
  const wallAll = unionIntervals(agents.flatMap((agent) => agent.activity));

  const totals: ActivityReport["totals"] = {
    humanMs: 0,
    humanHours: 0,
    billableHours: 0,
    requests: 0,
    unregisteredConversations: agents.filter((agent) => agent.role === UNREGISTERED_ROLE).length,
    coverage: coverageOf(rangeWindow, input.hosts),
    missingSourceDays: 0,
    ...emptySplit(),
  };
  const dayRows: DayActivity[] = [];
  for (const day of days) {
    const window = { start: day.start, end: Math.min(day.end, limit) };
    const uncovered = uncoveredSpans(window, input.hosts);
    const daySegments = clipIntervals(segments, day.start, day.end);
    const reportHours = dayReportHours(segments, day, params.rounding);
    let humanHours = 0;
    for (const [key, hours] of reportHours) {
      projects.get(key)!.humanHours += hours;
      humanHours += hours;
    }
    const split = emptySplit();
    if (window.end > window.start) {
      /* Wall-clock and its supervised part across projects; agent-hours per
         project summed, each against its own project's episodes. */
      const wall = clipIntervals(wallAll, window.start, window.end);
      const supervised = clipIntervals(supervisedUnion, window.start, window.end);
      split.wallMs = totalMs(wall);
      split.supervisedMs = totalMs(supervised);
      split.unattendedMs = split.wallMs - split.supervisedMs;
      for (const [key, list] of agentsByProject) {
        const part = agentSplit(list.map((agent) => agent.activity), own.get(key) ?? [], window);
        split.agentHoursMs += part.agentHoursMs;
        split.agentHoursSupervisedMs += part.agentHoursSupervisedMs;
        split.agentHoursUnattendedMs += part.agentHoursUnattendedMs;
      }
    }
    const humanMs = totalMs(daySegments);
    let billableHours = 0;
    for (const hours of dayReportHours(billableSegments, day, params.rounding).values()) billableHours += hours;
    const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
    const reasons: MissingSourceReason[] = [];
    if (workdays.has(weekday) && humanMs === 0 && window.end > window.start) {
      if (uncovered.hosts.length) reasons.push("unread-source");
      if (split.wallMs >= ACTIVE_ELSEWHERE_AGENT_MS) reasons.push("agent-activity");
    }
    const agentLane = [
      ...clipIntervals(supervisedUnion, window.start, window.end).map((item) => ({ ...item, supervised: true })),
      ...subtractIntervals(clipIntervals(wallAll, window.start, window.end), supervisedUnion).map((item) => ({ ...item, supervised: false })),
    ];
    dayRows.push({
      date: day.date,
      start: day.start,
      end: day.end,
      coverage: { complete: uncovered.hosts.length === 0, missingHosts: uncovered.hosts },
      unknown: uncovered.spans,
      humanMs,
      humanHours,
      billableHours,
      missingSource: reasons.length ? reasons : null,
      human: mergeLabelled(daySegments, (segment) => `${projectKey(segment.project)}\0${segment.host}`)
        .map(({ start, end, label }) => {
          const [project, host] = label.split("\0") as [string, string];
          return { start, end, project: projectOf(project), host };
        }),
      agent: mergeLabelled(agentLane, (item) => item.supervised).map(({ start, end, label }) => ({ start, end, supervised: label })),
      ...split,
    });
    totals.humanMs += humanMs;
    totals.humanHours += humanHours;
    totals.billableHours += billableHours;
    if (reasons.length) totals.missingSourceDays += 1;
    addSplit(totals, split);
  }
  for (const row of projects.values()) {
    row.humanReassignedMs = row.humanOwnMs - row.humanMs;
    totals.requests += row.requests;
  }
  return {
    range: { key: input.range, start: rangeStart, end: rangeEnd, now: nowMs },
    params,
    totals,
    days: dayRows,
    projects: [...projects.values()].sort((a, b) => b.humanMs - a.humanMs || b.wallMs - a.wallMs
      || projectKey(a.project).localeCompare(projectKey(b.project))),
  };
}
