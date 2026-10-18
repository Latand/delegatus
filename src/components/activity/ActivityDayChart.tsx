"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DayActivity, HourActivity } from "@/lib/activity/method";
import { weekOfDay } from "@/lib/activity/range";

import { agentParts, approxAtLeast, approxText, clockText, datesText, dayMonth, dayShort, hostName, hoursNumber, hoursText, minutesText, scopeHosts } from "./format";
import { MARK_FILL, TipRow, Tooltip, type TipAnchor } from "./marks";
import { DayTip, HourTip, type TipContext } from "./tips";

/*
 * The one strong chart (docs/design/activity-dashboard-v2.md, "By-day
 * chart"): your reported hours beside agent wall-clock, one pair per day on
 * one hour axis, never stacked together. Agent columns stack supervised,
 * unattended and unclear from the baseline. On one day (Today, or a free
 * range of one date) the same chart is hourly, with one hatched band behind
 * each stretch a host did not read. Past 92 days a column is a Monday week,
 * since a day would be narrower than its two bars.
 */

/** Longer ranges than this draw one pair per week. */
export const DAILY_LIMIT = 92;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setWidth(Math.floor(node.clientWidth));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface Column {
  key: string;
  /** The day, or a week's first day. */
  day: DayActivity;
  /** Every day the column holds: one, or a week's. */
  days: DayActivity[];
  hour: HourActivity | null;
  /** Your value on the chart's unit: reported hours, or minutes on Today. */
  you: number;
  supervised: number;
  unattended: number;
  unclear: number;
  future: boolean;
}

function columns(context: TipContext): Column[] {
  const { data } = context;
  if (data.days.length === 1) {
    const day = data.days[0]!;
    return day.hours.map((hour) => ({
      key: String(hour.start),
      day,
      days: [day],
      hour,
      you: hour.humanMs / MINUTE,
      supervised: hour.supervisedMs / MINUTE,
      unattended: (hour.unattendedMs - hour.unattendedUnreadMs) / MINUTE,
      unclear: hour.unattendedUnreadMs / MINUTE,
      future: hour.start >= data.range.now,
    }));
  }
  const daily = data.days.map((day) => {
    const [supervised, unattended, unclear] = agentParts(day);
    return { key: day.date, day, days: [day], hour: null, you: day.humanHours, supervised: supervised / HOUR, unattended: unattended / HOUR, unclear: unclear / HOUR, future: false };
  });
  if (daily.length <= DAILY_LIMIT) return daily;
  const weeks: Column[] = [];
  for (const col of daily) {
    const key = weekOfDay(col.day.date);
    const last = weeks.at(-1);
    if (last && last.key === key) {
      last.days.push(col.day);
      last.you += col.you;
      last.supervised += col.supervised;
      last.unattended += col.unattended;
      last.unclear += col.unclear;
    } else weeks.push({ ...col, key, days: [col.day] });
  }
  return weeks;
}

/** What a column's cap and tooltip go by, over every day it holds. */
function facts(col: Column) {
  return {
    flagged: col.days.some((day) => day.missingSource !== null),
    complete: col.days.every((day) => day.coverage.complete),
    agentsComplete: col.days.every((day) => day.agentCoverage.complete),
    humanHours: col.days.reduce((sum, day) => sum + day.humanHours, 0),
    wallMs: col.days.reduce((sum, day) => sum + day.wallMs, 0),
  };
}

/** Clean ticks: every 2 h up to 10 h, every 4 h up to 20 h, every 8 h above. */
function scale(max: number): { top: number; step: number } {
  const step = max > 20 ? 8 : max > 10 ? 4 : 2;
  return { top: Math.max(step * 2, Math.ceil(max / step) * step), step };
}

export function ActivityDayChart({ context, bounds }: { context: TipContext; bounds(): TipAnchor | undefined }) {
  const { data, unread, locale, t } = context;
  const [wrap, width] = useWidth<HTMLDivElement>();
  const svg = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  /* The frame marks the pair a keyboard reached; a pointer needs none. */
  const [focused, setFocused] = useState<number | null>(null);
  const today = data.days.length === 1;
  const weekly = data.days.length > DAILY_LIMIT;
  const month = !today && data.days.length > 7;
  const tz = data.params.tz;
  const cols = columns(context);

  const H = today ? 300 : month ? 176 : 228;
  const top = 20;
  const bottom = 26;
  const axisW = today ? 50 : 40;
  const plotW = Math.max(0, width - axisW);
  const max = today ? 60 : Math.max(4, ...cols.map((col) => Math.max(col.you, col.supervised + col.unattended + col.unclear)));
  const { top: yMax, step } = today ? { top: 60, step: 30 } : scale(max);
  const y = (value: number) => top + H - (value / yMax) * H;
  const slot = cols.length ? plotW / cols.length : 0;
  const bw = Math.max(2, Math.min(22, Math.floor((slot - (month ? 6 : 10)) / 2)));
  const gap = month ? 2 : 3;
  const day0 = data.days[0];

  const pairX = (index: number) => {
    const center = axisW + slot * index + slot / 2;
    return { center, you: center - bw - gap / 2, agents: center + gap / 2 };
  };

  /** One column of parts from the baseline up, a 2 px surface gap between
      parts, the top part rounded 3 px. Heights stay true to the values. */
  const stack = (x: number, parts: Array<[number, string]>, key: string): ReactNode[] => {
    const drawn = parts.filter(([value]) => value > 0.004 * yMax);
    let sum = 0;
    return drawn.map(([value, fill], index) => {
      const y0 = y(sum) - (index > 0 ? 1 : 0);
      const y1 = y(sum + value) + (index < drawn.length - 1 ? 1 : 0);
      sum += value;
      if (y0 - y1 < 0.5) return null;
      if (index < drawn.length - 1) return <rect key={`${key}-${index}`} x={x} y={y1} width={bw} height={y0 - y1} fill={fill} />;
      const r = Math.min(3, y0 - y1, bw / 2);
      return <path key={`${key}-${index}`} d={`M${x} ${y0} V${y1 + r} Q${x} ${y1} ${x + r} ${y1} H${x + bw - r} Q${x + bw} ${y1} ${x + bw} ${y1 + r} V${y0} Z`} fill={fill} />;
    });
  };

  const ticks: number[] = [];
  for (let value = 0; value <= yMax; value += step) ticks.push(value);

  /* Today: each stretch a host did not read, as one band behind those hours;
     on a project's page, only the hosts that can hold that project. */
  const bands = today && day0 ? scopeHosts(data).flatMap((host) => host.unread
    .map((span) => ({ host: host.host, start: Math.max(span.start, day0.start), end: Math.min(span.end, day0.end, data.range.now) }))
    .filter((span) => span.end > span.start)) : [];
  const hourX = (at: number) => axisW + slot * ((at - (day0?.start ?? 0)) / HOUR);

  /* A year's weeks before the request ledger begins would each print «?».
     The leading run of them is one hatched span with one label instead. */
  const leadingUnread = (() => {
    if (!weekly) return 0;
    let run = 0;
    for (const col of cols) {
      const { flagged, complete, humanHours } = facts(col);
      if (flagged || (!unread && (complete || humanHours > 0))) break;
      run += 1;
    }
    return run >= 2 ? run : 0;
  })();

  const capLabel = (col: Column, index = -1): { text: string; tone: string; strong: boolean } | null => {
    if (index >= 0 && index < leadingUnread) return null;
    const { flagged, complete, humanHours } = facts(col);
    const unknown = unread || flagged || (!complete && humanHours === 0);
    if (!month) {
      if (unknown) return { text: "?", tone: flagged && !unread ? "var(--color-warning)" : "var(--color-muted)", strong: flagged && !unread };
      if (humanHours > 0) return { text: `${complete ? "" : "≥ "}${hoursNumber(humanHours, locale)}`, tone: "var(--color-primary)", strong: true };
      return { text: "0", tone: "var(--color-muted)", strong: false };
    }
    if (unread) return null;
    if (flagged) return { text: "?", tone: "var(--color-warning)", strong: true };
    if (!complete) return { text: unknown ? "?" : "≥", tone: "var(--color-muted)", strong: true };
    return null;
  };

  const xLabel = (col: Column, index: number): { text: string; anchor: "middle" | "start" | "end"; x: number } | null => {
    const isToday = col.day.start <= data.range.now && data.range.now < col.day.end;
    const { center } = pairX(index);
    if (!month) return { text: isToday ? t("activity.range.today") : dayShort(col.day, locale, tz), anchor: "middle", x: center };
    if (weekly) {
      const every = Math.max(1, Math.ceil(52 / Math.max(1, slot)));
      return index % every === 0 && cols.length - 1 - index >= every ? { text: dayMonth(col.day, locale, tz), anchor: "start", x: center - bw } : null;
    }
    if (isToday) return { text: t("activity.range.today"), anchor: "end", x: center + bw + gap };
    const monday = new Date(`${col.day.date}T12:00:00Z`).getUTCDay() === 1;
    return monday && cols.length - 1 - index > 3 ? { text: dayMonth(col.day, locale, tz), anchor: "start", x: center - bw } : null;
  };

  const tipAnchor = (index: number): TipAnchor | null => {
    const rect = svg.current?.getBoundingClientRect();
    const col = cols[index];
    if (!rect || !col) return null;
    const { center } = pairX(index);
    const peak = Math.max(col.you, col.supervised + col.unattended + col.unclear);
    const topY = rect.top + Math.min(y(peak), top + H - 150);
    return { left: rect.left + center - bw - 4, right: rect.left + center + bw + 4, top: topY, bottom: topY };
  };
  const anchor = active === null ? null : tipAnchor(active);
  const activeCol = active === null ? null : cols[active] ?? null;

  const weekName = (col: Column) => datesText(col.days.map((day) => day.date), data.days, locale, tz);
  const pairLabel = (col: Column): string => {
    if (col.days.length > 1) {
      const fact = facts(col);
      return t("activity.chart.pair", { day: weekName(col), you: capLabel(col)?.text === "?" ? "?" : `${fact.complete ? "" : "≥ "}${hoursText(fact.humanHours, locale, t)}`, agents: approxAtLeast(fact.wallMs, !fact.agentsComplete, t) });
    }
    if (col.hour) return t("activity.chart.pair", { day: clockText(col.hour.start, locale, tz), you: minutesText(col.hour.humanMs, t), agents: approxText(col.hour.supervisedMs + col.hour.unattendedMs, t) });
    const cap = capLabel(col);
    return t("activity.chart.pair", { day: dayShort(col.day, locale, tz), you: cap?.text === "?" ? "?" : `${col.day.coverage.complete ? "" : "≥ "}${hoursText(col.day.humanHours, locale, t)}`, agents: approxAtLeast(col.day.wallMs, !col.day.agentCoverage.complete, t) });
  };

  return (
    <div ref={wrap} className="relative" data-activity-chart={data.range.key}>
      {width > 0 ? (
        <svg
          ref={svg}
          width={width}
          height={top + H + bottom}
          viewBox={`0 0 ${width} ${top + H + bottom}`}
          role="group"
          aria-label={t(today ? "activity.chart.ariaToday" : "activity.chart.aria")}
          className="block overflow-visible"
          onMouseLeave={() => setActive(null)}
        >
          {ticks.map((value) => {
            const yy = Math.round(y(value)) + 0.5;
            return (
              <g key={value} aria-hidden>
                <line x1={axisW} x2={width} y1={yy} y2={yy} stroke="var(--border-default)" strokeWidth={1} />
                <text x={axisW - 8} y={yy + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)" className="tabular-nums">
                  {value}{value === yMax ? ` ${t(today ? "activity.chart.unitMin" : "activity.chart.unitH")}` : ""}
                </text>
              </g>
            );
          })}
          {bands.map((band, index) => {
            const x0 = hourX(band.start) + 1;
            const x1 = Math.max(x0 + 2, hourX(band.end) - 1);
            const labelled = bands.findIndex((other) => other.host === band.host) === index;
            return (
              <g key={`${band.host}-${band.start}`} aria-hidden data-activity-unread-band={band.host}>
                <rect x={x0} y={top} width={x1 - x0} height={H} fill={MARK_FILL.unread} opacity={0.75} />
                {labelled ? (
                  <text x={x0 + 2} y={top - 6} fontSize={11} fontWeight={600} fill="var(--color-secondary)">
                    {t("activity.chart.unread", { host: hostName(band.host, data.coverage.hosts, t) })}
                  </text>
                ) : null}
              </g>
            );
          })}
          {leadingUnread ? (
            <g aria-hidden data-activity-unread-span={leadingUnread}>
              <rect x={axisW + 1} y={top} width={Math.max(2, slot * leadingUnread - 2)} height={H} fill={MARK_FILL.unread} opacity={0.75} />
              <text x={axisW + 4} y={top - 6} fontSize={11} fontWeight={600} fill="var(--color-secondary)">
                {leadingUnread === cols.length
                  ? t("activity.chart.unreadAll")
                  : t("activity.chart.unreadBefore", { date: dayMonth(cols[leadingUnread]!.day, locale, tz) })}
              </text>
            </g>
          ) : null}
          {cols.map((col, index) => {
            const { you, agents } = pairX(index);
            const cap = today ? null : capLabel(col, index);
            const label = today ? null : xLabel(col, index);
            return (
              <g key={col.key} data-activity-pair={col.key}>
                {!col.future ? (
                  <>
                    {col.you > 0 ? stack(you, [[col.you, MARK_FILL.you]], `${col.key}-y`) : null}
                    {stack(agents, [[col.supervised, MARK_FILL.supervised], [col.unattended, MARK_FILL.unattended], [col.unclear, MARK_FILL.unclear]], `${col.key}-a`)}
                  </>
                ) : null}
                {cap ? (
                  <text
                    x={you + bw / 2}
                    y={y(col.you) - (month ? 5 : 6)}
                    textAnchor="middle"
                    fontSize={month ? 10 : cap.text === "?" ? 14 : 12}
                    fontWeight={cap.strong ? 650 : 500}
                    fill={cap.tone}
                    className="tabular-nums"
                    data-activity-cap={col.key}
                  >
                    {cap.text}
                  </text>
                ) : null}
                {label ? (
                  <text
                    x={label.x}
                    y={top + H + 18}
                    textAnchor={label.anchor}
                    fontSize={month ? 11 : 12}
                    fontWeight={label.text === t("activity.range.today") ? 650 : 500}
                    fill={label.text === t("activity.range.today") ? "var(--color-primary)" : col.day.workday ? "var(--color-secondary)" : "var(--color-muted)"}
                  >
                    {label.text}
                  </text>
                ) : null}
                {month && !label ? <line x1={pairX(index).center} x2={pairX(index).center} y1={top + H + 4} y2={top + H + 7} stroke="var(--border-strong)" /> : null}
                {col.hour && index % 3 === 0 ? (
                  <text x={axisW + slot * index} y={top + H + 17} fontSize={11} fill="var(--color-muted)" className="tabular-nums">
                    {clockText(col.hour.start, locale, tz).slice(0, 2)}
                  </text>
                ) : null}
                {!col.future ? (
                  <rect
                    x={axisW + slot * index}
                    y={top}
                    width={slot}
                    height={H}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={pairLabel(col)}
                    className="outline-none"
                    onMouseEnter={() => setActive(index)}
                    onFocus={() => { setActive(index); setFocused(index); }}
                    onBlur={() => { setActive((current) => current === index ? null : current); setFocused(null); }}
                  />
                ) : null}
                {focused === index ? (
                  <rect x={axisW + slot * index + 1} y={top - 2} width={slot - 2} height={H + 4} rx={4} fill="none" stroke="var(--border-strong)" strokeWidth={1} pointerEvents="none" aria-hidden />
                ) : null}
              </g>
            );
          })}
          {today && day0 && data.range.now >= day0.start && data.range.now < day0.end ? (
            <g aria-hidden>
              <line x1={hourX(data.range.now)} x2={hourX(data.range.now)} y1={top - 4} y2={top + H} stroke="var(--color-muted)" strokeWidth={1} opacity={0.6} />
              <text x={axisW + slot * cols.length} y={top + H + 17} textAnchor="end" fontSize={11} fill="var(--color-muted)" className="tabular-nums">24</text>
            </g>
          ) : null}
        </svg>
      ) : <div style={{ height: top + H + bottom }} />}
      {anchor && activeCol ? (
        <Tooltip anchor={anchor} side="right" bounds={bounds()}>
          {activeCol.hour ? <HourTip day={activeCol.day} hour={activeCol.hour} context={context} />
            : activeCol.days.length > 1 ? <WeekTip col={activeCol} name={weekName(activeCol)} context={context} />
            : <DayTip day={activeCol.day} context={context} />}
        </Tooltip>
      ) : null}
      <DayTable context={context} />
    </div>
  );
}

/** A week's column: its reported hours and its agents' time, each split
    as the day tooltip splits it. */
function WeekTip({ col, name, context }: { col: Column; name: string; context: TipContext }) {
  const { unread, locale, t } = context;
  const fact = facts(col);
  const unknown = unread || fact.flagged || (!fact.complete && fact.humanHours === 0);
  const ms = (hours: number) => hours * HOUR;
  return (
    <div data-activity-week-tip="">
      <div className="mb-1 font-semibold text-primary">{name}</div>
      <div className="grid grid-cols-[10px_max-content_1fr] items-center gap-x-2 gap-y-px">
        <TipRow kind="you" value={unknown ? "?" : `${fact.complete ? "" : "≥ "}${hoursText(fact.humanHours, locale, t)}`} label={t("activity.fig.reported")} />
        <TipRow kind="supervised" value={approxAtLeast(ms(col.supervised), !fact.agentsComplete, t)} label={t("activity.tip.supervised")} />
        <TipRow kind="unattended" value={approxText(ms(col.unattended), t)} label={t("activity.tip.unattended")} />
        <TipRow kind="unclear" value={approxText(ms(col.unclear), t)} label={t("activity.tip.unclear")} />
      </div>
    </div>
  );
}

/** The chart as a table, for screen readers and forced colours. */
function DayTable({ context }: { context: TipContext }) {
  const { data, locale, t } = context;
  const tz = data.params.tz;
  return (
    <table className="sr-only" data-activity-table="">
      <caption>{t(data.days.length === 1 ? "activity.chart.ariaToday" : "activity.chart.aria")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("activity.table.day")}</th>
          <th scope="col">{t("activity.fig.reported")}</th>
          <th scope="col">{t("activity.tip.byMinute")}</th>
          <th scope="col">{t("activity.tip.supervised")}</th>
          <th scope="col">{t("activity.tip.unattended")}</th>
          <th scope="col">{t("activity.tip.unclear")}</th>
        </tr>
      </thead>
      <tbody>
        {data.days.map((day) => {
          const [supervised, unattended, unclear] = agentParts(day);
          const known = day.coverage.complete || day.humanHours > 0;
          return (
            <tr key={day.date}>
              <th scope="row">{dayShort(day, locale, tz)}</th>
              <td>{known ? `${day.coverage.complete ? "" : "≥ "}${hoursText(day.humanHours, locale, t)}` : "?"}</td>
              <td>{known ? `${day.coverage.complete ? "" : "≥ "}${minutesText(day.humanMs, t)}` : "?"}</td>
              <td>{approxText(supervised, t)}</td>
              <td>{approxText(unattended, t)}</td>
              <td>{approxText(unclear, t)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
