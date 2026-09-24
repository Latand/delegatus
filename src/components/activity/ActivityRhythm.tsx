"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import type { DayActivity, HourActivity } from "@/lib/activity/method";

import { useWidth } from "./ActivityDayChart";
import { dayMonth, dayShort, hoursText } from "./format";
import { MARK_FILL, Swatch, Tooltip, type MarkKind, type TipAnchor } from "./marks";
import { HourTip, type TipContext } from "./tips";

/*
 * Question 3 as a compact timeline (docs/design/activity-dashboard-v2.md,
 * "Rhythm"): one row per day, one cell per clock hour. Your weight wins the
 * cell, so a row's indigo cells add up to the day's reported hours; an hour
 * without it shows the agents that worked at least 10 minutes outside your
 * time on their project, hatched when most of it was unclear; the grey hatch
 * marks an hour some host was not read and nothing else applies.
 */

const MINUTE = 60_000;

function weightOf(hour: HourActivity): number {
  if (hour.weight !== null) return hour.weight;
  const minutes = hour.humanMs / MINUTE;
  return minutes >= 40 ? 1 : minutes >= 10 ? 0.5 : 0;
}

export function rhythmMark(day: DayActivity, hour: HourActivity): MarkKind {
  const weight = weightOf(hour);
  if (weight === 1) return "you";
  if (weight === 0.5) return "you-half";
  if (hour.unattendedMs >= 10 * MINUTE) return hour.unattendedUnreadMs >= hour.unattendedMs - hour.unattendedUnreadMs ? "unclear" : "unattended";
  if (hour.unreadHosts.length || day.missingSource) return "unread";
  return "track";
}

function firstActive(day: DayActivity, now: number): number {
  const index = day.hours.findIndex((hour) => hour.start < now && rhythmMark(day, hour) !== "track");
  return index < 0 ? 0 : index;
}

export function ActivityRhythm({ context }: { context: TipContext }) {
  const { data, unread, locale, t } = context;
  const [wrap, width] = useWidth<HTMLDivElement>();
  const svg = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<{ row: number; hour: number } | null>(null);
  const tz = data.params.tz;
  const halfHour = data.params.rounding === "half-hour";
  const dense = data.days.length > 7;
  const labelW = 60;
  const cellGap = 2;
  const cellW = Math.max(1, (width - labelW - cellGap * 23) / 24);
  const lane = dense ? 7 : 18;
  const rowGap = dense ? 3 : 6;
  const height = data.days.length * (lane + rowGap) - rowGap + 24;
  const now = data.range.now;

  const legend: Array<{ kind: MarkKind; label: string }> = unread
    ? [{ kind: "unclear", label: t("activity.rhythm.unclear") }, { kind: "unread", label: t("activity.rhythm.unread") }]
    : [
      { kind: "you", label: t(halfHour ? "activity.rhythm.full40" : "activity.rhythm.full") },
      { kind: "you-half", label: t(halfHour ? "activity.rhythm.half10" : "activity.rhythm.half") },
      { kind: "unattended", label: t("activity.rhythm.alone") },
      { kind: "unclear", label: t("activity.rhythm.unclear") },
      { kind: "unread", label: t("activity.rhythm.unread") },
    ];

  const cellX = (hour: number) => labelW + hour * (cellW + cellGap);
  const rowY = (row: number) => row * (lane + rowGap);
  const anchorOf = (cell: { row: number; hour: number }): TipAnchor | null => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect) return null;
    const left = rect.left + cellX(cell.hour);
    const top = rect.top + rowY(cell.row);
    return { left, right: left + cellW, top, bottom: top + lane };
  };
  const anchor = active ? anchorOf(active) : null;
  const activeDay = active ? data.days[active.row] : undefined;
  const activeHour = active && activeDay ? activeDay.hours[active.hour] : undefined;

  const onKey = (row: number) => (event: KeyboardEvent<SVGGElement>) => {
    const day = data.days[row]!;
    const last = Math.min(23, day.hours.filter((hour) => hour.start < now).length - 1);
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setActive((current) => {
      const hour = current && current.row === row ? current.hour : firstActive(day, now);
      return { row, hour: Math.max(0, Math.min(last, hour + (event.key === "ArrowRight" ? 1 : -1))) };
    });
  };

  return (
    <section className="rounded-[12px] border border-border bg-card px-[22px] pb-3 pt-3.5 shadow-1" aria-labelledby="activity-rhythm-title" data-activity-rhythm="">
      <div className="flex h-[22px] items-center gap-3">
        <h2 id="activity-rhythm-title" className="text-[13px] font-semibold text-primary">{t("activity.rhythm.title")}</h2>
        <div className="flex-1" />
        <div className="flex items-center gap-[14px] whitespace-nowrap text-[11px] text-muted" data-activity-legend="">
          {unread ? null : <span className="-mr-[6px] font-semibold text-secondary">{t("activity.rhythm.you")}</span>}
          {legend.map((item) => (
            <span key={item.kind} className="inline-flex items-center gap-[5px]"><Swatch kind={item.kind} />{item.label}</span>
          ))}
        </div>
      </div>
      <div ref={wrap} className="mt-2.5">
        {width > 0 ? (
          <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("activity.rhythm.aria")} className="block" onMouseLeave={() => setActive(null)}>
            {data.days.map((day, row) => {
              const isToday = day.start <= now && now < day.end;
              const monday = new Date(`${day.date}T12:00:00Z`).getUTCDay() === 1;
              const label = !dense || isToday || monday ? (isToday ? t("activity.range.today") : dense ? dayMonth(day, locale, tz) : dayShort(day, locale, tz)) : null;
              const y = rowY(row);
              const summary = `${dayShort(day, locale, tz)}: ${day.coverage.complete || day.humanHours > 0 ? `${day.coverage.complete ? "" : "≥ "}${hoursText(day.humanHours, locale, t)}` : "?"}`;
              return (
                <g
                  key={day.date}
                  tabIndex={0}
                  role="img"
                  aria-label={summary}
                  className="outline-none"
                  onFocus={() => setActive((current) => current?.row === row ? current : { row, hour: firstActive(day, now) })}
                  onBlur={() => setActive((current) => current?.row === row ? null : current)}
                  onKeyDown={onKey(row)}
                  data-activity-rhythm-row={day.date}
                >
                  {label ? (
                    <text x={0} y={y + lane / 2 + 4} fontSize={dense ? 10.5 : 12} fontWeight={isToday ? 650 : 500} fill={isToday ? "var(--color-primary)" : day.workday ? "var(--color-secondary)" : "var(--color-muted)"}>
                      {label}
                    </text>
                  ) : null}
                  {day.hours.slice(0, 24).map((hour, index) => {
                    if (hour.start >= now) return null;
                    const mark = rhythmMark(day, hour);
                    return (
                      <rect
                        key={hour.start}
                        x={cellX(index)}
                        y={y}
                        width={cellW}
                        height={lane}
                        rx={dense ? 1.5 : 3}
                        fill={MARK_FILL[mark]}
                        data-activity-cell={mark}
                        onMouseEnter={() => setActive({ row, hour: index })}
                      />
                    );
                  })}
                  {active?.row === row ? (
                    <rect x={cellX(active.hour) - 1.5} y={y - 1.5} width={cellW + 3} height={lane + 3} rx={dense ? 2.5 : 4} fill="none" stroke="var(--color-primary)" strokeOpacity={0.55} strokeWidth={1} pointerEvents="none" />
                  ) : null}
                </g>
              );
            })}
            {[0, 6, 12, 18, 24].map((tick) => (
              <text
                key={tick}
                x={cellX(tick) - (tick === 24 ? cellGap : 0)}
                y={height - 6}
                textAnchor={tick === 0 ? "start" : tick === 24 ? "end" : "middle"}
                fontSize={11}
                fill="var(--color-muted)"
                className="tabular-nums"
                aria-hidden
              >
                {String(tick).padStart(2, "0")}
              </text>
            ))}
          </svg>
        ) : <div style={{ height }} />}
      </div>
      {anchor && activeDay && activeHour ? (
        <Tooltip anchor={anchor} side="above">
          <HourTip day={activeDay} hour={activeHour} context={context} />
        </Tooltip>
      ) : null}
    </section>
  );
}
