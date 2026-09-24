import type { HostReport } from "@/lib/activity/hostSources";
import type { DayActivity } from "@/lib/activity/method";
import type { ActivityProjectRow, ActivityResponse } from "@/lib/activity/report";
import { isOpaqueProjectKey, projectDisplayName } from "@/lib/displayNames";
import type { Locale, TFunction } from "@/lib/i18n";

/*
 * Number and date formats of the desktop activity page
 * (docs/design/activity-dashboard-v2.md, "Number formats"): reported hours in
 * halves, your time to the minute, agent time as an estimate that is never
 * printed to the minute, and every split rounded so its parts add up to the
 * total beside it.
 */

const MINUTE = 60_000;

export function intlLocale(locale: Locale): string {
  return locale === "uk" ? "uk-UA" : "en-GB";
}

/** `27.5`, `27,5`: halves, one decimal only when needed. */
export function hoursNumber(hours: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(hours);
}

/** `27.5 h`, `27,5 год`. */
export function hoursText(hours: number, locale: Locale, t: TFunction): string {
  return t("activity.reportHoursShort", { hours: hoursNumber(hours, locale) });
}

/** Your time, to the minute: `23 h 42 m`. */
export function minutesText(ms: number, t: TFunction): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes <= 0) return t("activity.dur.m", { m: 0 });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return t("activity.dur.m", { m });
  return m ? t("activity.dur.hm", { h, m }) : t("activity.dur.h", { h });
}

/** Agent time has no minute precision: whole hours from 10 h, five-minute
    steps below, and null for none (drawn as a dash). */
export function agentText(ms: number, t: TFunction): string | null {
  const minutes = ms / MINUTE;
  if (minutes < 2.5) return null;
  if (minutes >= 600) return t("activity.dur.h", { h: Math.round(minutes / 60) });
  return minutesText(Math.round(minutes / 5) * 5 * MINUTE, t);
}

/** `≈ 8 h 50 m`, or `–`. */
export function approxText(ms: number, t: TFunction): string {
  const text = agentText(ms, t);
  return text === null ? "–" : t("activity.approx", { value: text });
}

/** Agent-hours are a count of hours: halves below 10, whole above. */
export function agentHoursText(ms: number, locale: Locale): string {
  const hours = ms / (60 * MINUTE);
  return `≈ ${hoursNumber(hours >= 10 ? Math.round(hours) : Math.round(hours * 2) / 2, locale)}`;
}

/** A split rounded so its parts add up to the total shown beside it, in the
    total's own step (largest remainder). Values in ms. */
export function partsRound(totalMs: number, parts: readonly number[]): number[] {
  const unit = (totalMs / MINUTE >= 600 ? 60 : 5) * MINUTE;
  const target = Math.round(totalMs / unit);
  const raw = parts.map((part) => Math.max(0, part) / unit);
  const out = raw.map(Math.floor);
  let rest = target - out.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => [value - out[index]!, index] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k += 1, rest -= 1) out[order[k]![1]]! += 1;
  for (let k = order.length - 1; rest < 0 && k >= 0; k -= 1) {
    if (out[order[k]![1]]! > 0) {
      out[order[k]![1]]! -= 1;
      rest += 1;
    }
  }
  return out.map((value) => value * unit);
}

/** The agent split of a figure: supervised, unattended (read), unclear. */
export function agentParts(split: { wallMs: number; supervisedMs: number; unattendedMs: number; unattendedUnreadMs: number }): [number, number, number] {
  const [supervised = 0, unattended = 0, unclear = 0] = partsRound(split.wallMs, [
    split.supervisedMs,
    split.unattendedMs - split.unattendedUnreadMs,
    split.unattendedUnreadMs,
  ]);
  return [supervised, unattended, unclear];
}

/* ------------------------------------------------------------------------ */
/* Dates                                                                    */
/* ------------------------------------------------------------------------ */

const NOON = 12 * 60 * MINUTE;

function format(locale: Locale, tz: string, options: Intl.DateTimeFormatOptions, at: number): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: tz }).format(new Date(at));
}

/** `Fri 18`, `пт 18`: a day under its column. */
export function dayShort(day: Pick<DayActivity, "start">, locale: Locale, tz: string): string {
  return format(locale, tz, { weekday: "short", day: "numeric" }, day.start + NOON).replace(", ", " ");
}

/** `Wed 23 Sept`, `ср, 23 вер.`: a day in a tooltip or a sentence. */
export function dayLong(day: Pick<DayActivity, "start">, locale: Locale, tz: string): string {
  return format(locale, tz, { weekday: "short", day: "numeric", month: "short" }, day.start + NOON);
}

/** `31 Aug`, `31 серп.`. */
export function dayMonth(day: Pick<DayActivity, "start">, locale: Locale, tz: string): string {
  return format(locale, tz, { day: "numeric", month: "short" }, day.start + NOON);
}

/** `09:00`. */
export function clockText(at: number, locale: Locale, tz: string): string {
  return format(locale, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, at);
}

/** `24 Sept, 14:05`. */
export function dateTimeText(at: number, locale: Locale, tz: string): string {
  return format(locale, tz, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, at);
}

/** The header's range: `Thursday, 24 Sept`, `18–24 Sept`, `26 Aug – 24 Sept`. */
export function rangeText(data: ActivityResponse, locale: Locale): string {
  const tz = data.params.tz;
  const first = data.days[0];
  const last = data.days.at(-1);
  if (!first || !last) return "";
  if (data.range.key === "today") return format(locale, tz, { weekday: "long", day: "numeric", month: "short" }, first.start + NOON);
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", timeZone: tz });
  return formatter.formatRange(new Date(first.start + NOON), new Date(last.start + NOON));
}

/** Consecutive dates as runs: `22–23 Sept`, `18 Sept, 22–23 Sept`. */
export function datesText(dates: readonly string[], days: readonly DayActivity[], locale: Locale, tz: string): string {
  const index = new Map(days.map((day, position) => [day.date, position]));
  const positions = dates.map((date) => index.get(date)).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const position of positions) {
    const last = runs.at(-1);
    if (last && position === last[1] + 1) last[1] = position;
    else runs.push([position, position]);
  }
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", timeZone: tz });
  return runs.map(([from, to]) => from === to
    ? formatter.format(new Date(days[from]!.start + NOON))
    : formatter.formatRange(new Date(days[from]!.start + NOON), new Date(days[to]!.start + NOON))).join(", ");
}

/* ------------------------------------------------------------------------ */
/* Names                                                                    */
/* ------------------------------------------------------------------------ */

export function projectName(project: string | null, name: string | null, t: TFunction): string {
  if (project === null) return t("activity.unattributed");
  if (name) return name;
  return isOpaqueProjectKey(project) ? t("activity.unnamedProject") : projectDisplayName(project);
}

export function projectNames(rows: readonly ActivityProjectRow[], t: TFunction): Map<string | null, string> {
  return new Map(rows.map((row) => [row.project, projectName(row.project, row.name, t)]));
}

export function hostName(host: string, hosts: readonly HostReport[], t: TFunction): string {
  const entry = hosts.find((candidate) => candidate.host === host);
  return entry?.label ?? (entry?.local ? t("activity.hosts.thisHostName") : host);
}

/** `a`, `a and b`, `a, b and 2 more`. */
export function nameList(names: readonly string[], t: TFunction): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return t("activity.list.and2", { a: names[0]!, b: names[1]! });
  return t("activity.list.andMore", { a: names[0]!, b: names[1]!, count: names.length - 2 });
}

export const ENGINE_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot" };

export function roleName(role: string, t: TFunction): string {
  if (role === "unregistered") return t("activity.role.unregistered");
  if (role === "none") return t("activity.role.none");
  return role;
}

/* ------------------------------------------------------------------------ */
/* Trust                                                                    */
/* ------------------------------------------------------------------------ */

export type TrustState = "ok" | "lower" | "none";

/** None of your input was read: every expected host was unread for the whole
    range and nothing counted. Agent time may still have been read. */
export function nothingRead(data: ActivityResponse): boolean {
  const window = Math.min(data.range.end, data.range.now) - data.range.start;
  return data.totals.humanMs === 0 && data.totals.requests === 0 && data.coverage.hosts.length > 0
    && data.coverage.hosts.every((host) => host.unread.reduce((sum, span) => sum + span.end - span.start, 0) >= window);
}

export function trustState(data: ActivityResponse): TrustState {
  if (nothingRead(data)) return "none";
  return data.totals.coverage.complete && data.totals.missingSourceDays === 0 ? "ok" : "lower";
}
