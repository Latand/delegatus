"use client";

import type { ReactNode } from "react";

import type { DayActivity, HourActivity } from "@/lib/activity/method";
import type { ActivityResponse } from "@/lib/activity/report";
import type { Locale, TFunction } from "@/lib/i18n";

import { agentParts, agentText, approxText, clockText, dayLong, hostName, hoursText, minutesText, nameList } from "./format";
import { Items, TipGap, TipRow } from "./marks";

/*
 * The day and hour tooltips (docs/design/activity-dashboard-v2.md,
 * "Tooltips"). Each is a small table: a swatch, the value, its label. Every
 * agent value carries ≈.
 */

const MINUTE = 60_000;

export interface TipContext {
  data: ActivityResponse;
  names: ReadonlyMap<string | null, string>;
  /** None of your input was read for the range. */
  unread: boolean;
  locale: Locale;
  t: TFunction;
}

function notes(list: readonly ReactNode[]) {
  return list.map((note, index) => <div key={index} className="mt-[5px] max-w-[280px] text-[11px] text-muted">{note}</div>);
}

export function DayTip({ day, context }: { day: DayActivity; context: TipContext }) {
  const { data, names, unread, locale, t } = context;
  const tz = data.params.tz;
  const flagged = day.missingSource?.includes("agent-activity") ?? false;
  const lower = !day.coverage.complete && !unread;
  const ge = lower ? "≥ " : "";
  const [supervised, unattended, unclear] = agentParts(day);
  const reported = day.projects.filter((entry) => entry.humanHours > 0);
  const list: ReactNode[] = [];
  /* The day's reported hours per project: what the daily report copies. */
  if (reported.length && !unread) list.push(<Items items={reported.map((entry) => `${names.get(entry.project) ?? entry.project ?? ""} ${hoursText(entry.humanHours, locale, t)}`)} />);
  if (flagged) list.push(t("activity.tip.missing"));
  else if (lower) list.push(t("activity.tip.lower", { host: nameList(day.coverage.missingHosts.map((host) => hostName(host, data.coverage.hosts, t)), t) }));
  if (unclear > 0 && !flagged && !unread) {
    const projects = data.projects
      .filter((row) => row.unclearDays.includes(day.date))
      .sort((a, b) => b.unattendedUnreadMs - a.unattendedUnreadMs)
      .map((row) => names.get(row.project) ?? "");
    if (projects.length) list.push(t("activity.tip.unclearNote", { projects: nameList(projects, t) }));
  }
  const unknownYou = unread || flagged || (!day.coverage.complete && day.humanHours === 0);
  return (
    <div data-activity-day-tip={day.date}>
      <div className="mb-1 font-semibold text-primary">{dayLong(day, locale, tz)}</div>
      <div className="grid grid-cols-[10px_max-content_1fr] items-center gap-x-2 gap-y-px">
        {unknownYou ? (
          <TipRow kind="unread" value="?" label={t("activity.fig.reported")} />
        ) : (
          <>
            <TipRow kind="you" value={ge + hoursText(day.humanHours, locale, t)} label={t("activity.fig.reported")} />
            <TipRow value={ge + minutesText(day.humanMs, t)} label={t("activity.tip.byMinute")} />
          </>
        )}
        <TipGap />
        <TipRow value={approxText(day.wallMs, t)} label={t("activity.tip.agents")} />
        {supervised > 0 ? <TipRow kind="supervised" value={approxText(supervised, t)} label={t("activity.tip.supervised")} /> : null}
        {unattended > 0 ? <TipRow kind="unattended" value={approxText(unattended, t)} label={t("activity.tip.unattended")} /> : null}
        {unclear > 0 ? <TipRow kind="unclear" value={approxText(unclear, t)} label={t("activity.tip.unclear")} /> : null}
      </div>
      {notes(list)}
    </div>
  );
}

/** The hour's human value: minutes and project, `≥` inside an unread
    stretch, or why nothing can be said. Judged per host. */
function hourYou(day: DayActivity, hour: HourActivity, context: TipContext): string {
  const { data, names, t } = context;
  const unreadHosts = hour.unreadHosts;
  const notRead = unreadHosts.length > 0 || day.missingSource !== null;
  if (hour.humanMs >= MINUTE) {
    return `${notRead ? "≥ " : ""}${minutesText(hour.humanMs, t)} · ${names.get(hour.project) ?? t("activity.unattributed")}`;
  }
  if (unreadHosts.length) return t("activity.cell.notRead", { host: nameList(unreadHosts.map((host) => hostName(host, data.coverage.hosts, t)), t) });
  if (day.missingSource) return t("activity.cell.missing");
  return t("activity.cell.none");
}

function hourAgents(hour: HourActivity, context: TipContext): string {
  const { names, t } = context;
  const wall = hour.supervisedMs + hour.unattendedMs;
  const text = agentText(wall, t);
  if (text === null) return "–";
  const parts = ([
    [hour.supervisedMs, "activity.tip.supervised"],
    [hour.unattendedMs - hour.unattendedUnreadMs, "activity.tip.unattended"],
    [hour.unattendedUnreadMs, "activity.tip.unclear"],
  ] as const).filter(([ms]) => ms >= 2.5 * MINUTE);
  const which = parts.length === 1 ? ` ${t(parts[0]![1])}` : "";
  return `${t("activity.approx", { value: text })}${which} · ${names.get(hour.agentProject) ?? t("activity.unattributed")}`;
}

export function HourTip({ day, hour, context }: { day: DayActivity; hour: HourActivity; context: TipContext }) {
  const { data, locale, t } = context;
  const tz = data.params.tz;
  return (
    <div data-activity-hour-tip={hour.start}>
      <div className="mb-1 font-semibold text-primary">
        {dayLong(day, locale, tz)}, {clockText(hour.start, locale, tz)}–{clockText(hour.start + 60 * MINUTE, locale, tz)}
      </div>
      <div className="grid grid-cols-[max-content_1fr] gap-x-[10px] gap-y-px">
        <span className="text-muted">{t("activity.fig.you")}</span>
        <span className="text-primary">{hourYou(day, hour, context)}</span>
        <span className="text-muted">{t("activity.fig.agents")}</span>
        <span className="text-primary">{hourAgents(hour, context)}</span>
      </div>
    </div>
  );
}
