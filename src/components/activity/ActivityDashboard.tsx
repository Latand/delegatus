"use client";

import { ArrowLeft, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { REQUEST_KINDS, SURFACES, type DayActivity, type RangeKey } from "@/lib/activity/method";
import type { ActivityProjectRow, ActivityResponse } from "@/lib/activity/report";
import { isOpaqueProjectKey, projectDisplayName } from "@/lib/displayNames";
import { useLocale, type Locale, type MessageKey, type TFunction } from "@/lib/i18n";

/*
 * The activity dashboard (docs/design/activity-dashboard.md, "Page"). Two
 * axes, each in its own hue and never added together: human time (accent) and
 * agent time (info), the agent part split into supervised (solid) and
 * unattended (hatched). Days before the request ledger existed are hatched
 * grey and read "Not recorded", which is not zero.
 */

export type ActivityView = "days" | "projects";
type ProjectSort = "human" | "agent";

const RANGES: readonly RangeKey[] = ["today", "7d", "30d"];
const REFRESH_MS = 60_000;

const HATCH_UNATTENDED: CSSProperties = {
  backgroundColor: "var(--color-info-soft)",
  backgroundImage: "repeating-linear-gradient(135deg, var(--color-info) 0 2px, transparent 2px 5px)",
};
const HATCH_UNRECORDED: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--color-strong) 0 1px, transparent 1px 6px)",
};

/* ------------------------------------------------------------------------ */
/* Formatting                                                               */
/* ------------------------------------------------------------------------ */

function duration(ms: number, t: TFunction): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return t("activity.dur.m", { m: 0 });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return t("activity.dur.m", { m });
  return m ? t("activity.dur.hm", { h, m }) : t("activity.dur.h", { h });
}

/** Agent figures are approximate (message timestamps), and say so. */
function approx(ms: number, t: TFunction): string {
  return t("activity.approx", { value: duration(ms, t) });
}

function reportHours(hours: number, locale: Locale, t: TFunction): string {
  return t("activity.reportHours", { hours: new Intl.NumberFormat(locale === "uk" ? "uk-UA" : "en-US", { maximumFractionDigits: 1 }).format(hours) });
}

function dayLabel(day: DayActivity, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(new Date(day.start + 12 * 3_600_000));
}

function clockTime(ms: number, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(ms));
}

function dateTime(ms: number, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(ms));
}

function projectName(project: string | null, name: string | null, t: TFunction): string {
  if (project === null) return t("activity.unattributed");
  if (name) return name;
  return isOpaqueProjectKey(project) ? t("activity.unnamedProject") : projectDisplayName(project);
}

function roleName(role: string, t: TFunction): string {
  if (role === "unregistered") return t("activity.role.unregistered");
  if (role === "none") return t("activity.role.none");
  return role;
}

const ENGINE_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot" };

/* ------------------------------------------------------------------------ */
/* Small pieces                                                             */
/* ------------------------------------------------------------------------ */

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
}) {
  return (
    <div className="flex rounded-[8px] border border-border bg-card p-0.5" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          data-activity-option={option.value}
          onClick={() => onChange(option.value)}
          className={`min-h-8 flex-1 rounded-[6px] px-3 text-[12px] font-semibold whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-10 ${value === option.value ? "bg-sunken text-primary" : "text-muted hover:text-primary"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Swatch({ kind }: { kind: "human" | "supervised" | "unattended" | "unrecorded" }) {
  const style = kind === "unattended" ? HATCH_UNATTENDED : kind === "unrecorded" ? HATCH_UNRECORDED : undefined;
  const tone = kind === "human" ? "bg-accent" : kind === "supervised" ? "bg-info" : kind === "unrecorded" ? "bg-sunken border border-border" : "";
  return <span aria-hidden className={`inline-block h-2.5 w-3 shrink-0 rounded-[2px] ${tone}`} style={style} />;
}

function Legend({ t }: { t: TFunction }) {
  const items: Array<{ kind: "human" | "supervised" | "unattended" | "unrecorded"; label: MessageKey }> = [
    { kind: "human", label: "activity.legend.human" },
    { kind: "supervised", label: "activity.legend.supervised" },
    { kind: "unattended", label: "activity.legend.unattended" },
    { kind: "unrecorded", label: "activity.legend.unrecorded" },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-secondary" data-activity-legend="">
      {items.map((item) => (
        <li key={item.kind} className="flex items-center gap-1.5">
          <Swatch kind={item.kind} />
          {t(item.label)}
        </li>
      ))}
    </ul>
  );
}

function Tile({ label, value, sub, children, testId }: { label: string; value: string; sub?: string; children?: ReactNode; testId: string }) {
  return (
    <div className="min-w-0 rounded-[12px] border border-border bg-card px-4 py-3" data-activity-tile={testId}>
      <div className="text-[11px] font-semibold text-secondary">{label}</div>
      <div className="mt-1 text-[22px] font-semibold leading-tight text-primary max-sm:text-[19px]">{value}</div>
      {sub ? <div className="mt-1 text-[11px] leading-snug text-muted">{sub}</div> : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Day view                                                                 */
/* ------------------------------------------------------------------------ */

const HOUR_TICKS = [0, 6, 12, 18, 24];

function position(start: number, end: number, day: DayActivity): CSSProperties {
  const length = day.end - day.start;
  return { left: `${((start - day.start) / length) * 100}%`, width: `${((end - start) / length) * 100}%` };
}

interface Hover { x: number; at: number }

function DayRow({ day, tz, nowMs, names, locale, t }: {
  day: DayActivity;
  tz: string;
  nowMs: number;
  names: ReadonlyMap<string | null, string>;
  locale: Locale;
  t: TFunction;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const unrecordedEnd = !day.recorded ? Math.min(day.end, nowMs) : day.recordedFrom;
  const track = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = strip.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover({ x: fraction * rect.width, at: day.start + fraction * (day.end - day.start) });
  };
  const hoverHuman = hover ? day.human.find((segment) => segment.start <= hover.at && hover.at < segment.end) : undefined;
  const hoverAgent = hover ? day.agent.find((segment) => segment.start <= hover.at && hover.at < segment.end) : undefined;
  const hoverUnrecorded = hover && unrecordedEnd !== null && hover.at < unrecordedEnd;
  const label = dayLabel(day, locale, tz);
  const summary = t("activity.day.aria", {
    day: label,
    human: day.recorded ? duration(day.humanMs, t) : t("activity.notRecorded"),
    agent: approx(day.wallMs, t),
    supervised: approx(day.supervisedMs, t),
  });
  return (
    <li className="grid grid-cols-[112px_minmax(0,1fr)_minmax(176px,auto)] items-center gap-x-4 border-t border-border py-2.5 first:border-t-0 max-sm:grid-cols-1 max-sm:gap-y-2" data-activity-day={day.date} data-recorded={day.recorded ? "true" : "false"}>
      <div className="flex items-baseline justify-between gap-2 max-sm:order-1">
        <span className="text-[12px] font-semibold text-primary">{label}</span>
      </div>
      <div
        ref={strip}
        className="relative max-sm:order-3"
        role="img"
        aria-label={summary}
        onPointerMove={track}
        onPointerDown={track}
        onPointerLeave={() => setHover(null)}
      >
        <div className="relative h-3 overflow-hidden rounded-[3px] bg-sunken" data-activity-lane="human">
          {HOUR_TICKS.slice(1, -1).map((hour) => (
            <span key={hour} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: `${(hour / 24) * 100}%` }} />
          ))}
          {unrecordedEnd !== null && unrecordedEnd > day.start ? (
            <span className="absolute inset-y-0" style={{ ...position(day.start, unrecordedEnd, day), ...HATCH_UNRECORDED }} data-activity-unrecorded="" />
          ) : null}
          {day.human.map((segment) => (
            <span key={`${segment.start}`} className="absolute inset-y-0 rounded-[2px] bg-accent" style={position(segment.start, segment.end, day)} data-activity-segment="human" />
          ))}
        </div>
        <div className="relative mt-0.5 h-3 overflow-hidden rounded-[3px] bg-sunken" data-activity-lane="agent">
          {HOUR_TICKS.slice(1, -1).map((hour) => (
            <span key={hour} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: `${(hour / 24) * 100}%` }} />
          ))}
          {day.agent.map((segment) => (
            <span
              key={`${segment.start}`}
              className={`absolute inset-y-0 rounded-[2px] ${segment.supervised ? "bg-info" : ""}`}
              style={{ ...position(segment.start, segment.end, day), ...(segment.supervised ? {} : HATCH_UNATTENDED) }}
              data-activity-segment={segment.supervised ? "supervised" : "unattended"}
            />
          ))}
        </div>
        {nowMs > day.start && nowMs < day.end ? (
          <span aria-hidden className="absolute -inset-y-0.5 w-px bg-primary/40" style={{ left: `${((nowMs - day.start) / (day.end - day.start)) * 100}%` }} />
        ) : null}
        {hover ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute bottom-full z-10 mb-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-[8px] border border-border bg-raised px-2.5 py-1.5 text-[11px] leading-snug shadow-2"
            style={{ left: Math.min(Math.max(hover.x, 90), (strip.current?.clientWidth ?? 0) - 90) }}
            data-activity-tooltip=""
          >
            <div className="font-semibold text-primary">{clockTime(hover.at, locale, tz)}</div>
            <div className="flex items-center gap-1.5 text-secondary">
              <Swatch kind={hoverUnrecorded ? "unrecorded" : "human"} />
              {hoverUnrecorded
                ? t("activity.notRecorded")
                : hoverHuman
                  ? t("activity.tooltip.human", { project: names.get(hoverHuman.project) ?? t("activity.unattributed") })
                  : t("activity.tooltip.noHuman")}
            </div>
            <div className="flex items-center gap-1.5 text-secondary">
              <Swatch kind={hoverAgent?.supervised === false ? "unattended" : "supervised"} />
              {hoverAgent ? t(hoverAgent.supervised ? "activity.tooltip.supervised" : "activity.tooltip.unattended") : t("activity.tooltip.noAgent")}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 text-[11px] tabular-nums max-sm:order-2 max-sm:flex-row max-sm:flex-wrap max-sm:gap-x-3" data-activity-day-totals="">
        <span className="flex items-center gap-1.5 text-primary">
          <Swatch kind={day.recorded ? "human" : "unrecorded"} />
          {day.recorded ? (
            <>
              <span className="font-semibold">{duration(day.humanMs, t)}</span>
              {day.humanHours ? <span className="text-muted">· {reportHours(day.humanHours, locale, t)}</span> : null}
            </>
          ) : <span className="text-muted">{t("activity.notRecorded")}</span>}
        </span>
        <span className="flex items-center gap-1.5 text-primary">
          <Swatch kind="supervised" />
          <span className="font-semibold">{approx(day.wallMs, t)}</span>
          {day.wallMs ? <span className="text-muted">· {t("activity.day.supervisedShort", { value: duration(day.supervisedMs, t) })}</span> : null}
        </span>
      </div>
    </li>
  );
}

function DayAxis() {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)_minmax(176px,auto)] gap-x-4 max-sm:grid-cols-1" aria-hidden>
      <span className="max-sm:hidden" />
      <div className="relative h-4 text-[10px] tabular-nums text-muted">
        {HOUR_TICKS.map((hour) => (
          <span
            key={hour}
            className="absolute top-0"
            style={{ left: `${(hour / 24) * 100}%`, transform: hour === 0 ? "none" : hour === 24 ? "translateX(-100%)" : "translateX(-50%)" }}
          >
            {String(hour).padStart(2, "0")}
          </span>
        ))}
      </div>
      <span className="max-sm:hidden" />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Project view                                                             */
/* ------------------------------------------------------------------------ */

function Bar({ value, max, kind, supervised }: { value: number; max: number; kind: "human" | "agent"; supervised?: number }) {
  const width = max > 0 ? (value / max) * 100 : 0;
  if (kind === "human") {
    return (
      <div className="h-2.5 min-w-0 flex-1" aria-hidden>
        {value > 0 ? <div className="h-full min-w-[3px] rounded-r-[4px] bg-accent" style={{ width: `${width}%` }} data-activity-bar="human" /> : null}
      </div>
    );
  }
  const supervisedShare = value > 0 ? Math.min(1, (supervised ?? 0) / value) : 0;
  return (
    <div className="h-2.5 min-w-0 flex-1" aria-hidden>
      {value > 0 ? (
        <div className="flex h-full min-w-[3px] gap-[2px] overflow-hidden rounded-r-[4px]" style={{ width: `${width}%` }} data-activity-bar="agent">
          {supervisedShare > 0 ? <div className="h-full bg-info" style={{ width: `${supervisedShare * 100}%` }} /> : null}
          {supervisedShare < 1 ? <div className="h-full flex-1" style={HATCH_UNATTENDED} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Breakdown({ title, rows, kind, t }: {
  title: string;
  rows: Array<{ key: string; label: string; ms: number; mono?: boolean; note?: string }>;
  kind: "human" | "agent";
  t: TFunction;
}) {
  const shown = rows.filter((row) => row.ms > 0);
  const max = Math.max(0, ...shown.map((row) => row.ms));
  return (
    <div className="min-w-0" data-activity-breakdown={title}>
      <div className="mb-1.5 text-[11px] font-semibold text-secondary">{title}</div>
      {shown.length ? (
        <ul className="flex flex-col gap-1">
          {shown.map((row) => (
            <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_64px] items-center gap-2 text-[11px]">
              <div className="min-w-0">
                <div className={`truncate text-primary ${row.mono ? "font-mono text-[10.5px]" : ""}`} title={row.label}>{row.label}</div>
                {row.note ? <div className={`truncate text-muted ${row.mono ? "font-mono text-[10px]" : ""}`} title={row.note}>{row.note}</div> : null}
                <div className="mt-0.5 h-1 rounded-r-[2px]" style={{ width: `${max ? (row.ms / max) * 100 : 0}%`, ...(kind === "human" ? { backgroundColor: "var(--color-accent)" } : { backgroundColor: "var(--color-info)" }) }} />
              </div>
              <span className="text-right tabular-nums text-secondary">{kind === "agent" ? approx(row.ms, t) : duration(row.ms, t)}</span>
            </li>
          ))}
        </ul>
      ) : <div className="text-[11px] text-muted">{t("activity.breakdown.none")}</div>}
    </div>
  );
}

function ProjectRow({ row, max, expanded, onToggle, locale, t }: {
  row: ActivityProjectRow;
  max: number;
  expanded: boolean;
  onToggle(): void;
  locale: Locale;
  t: TFunction;
}) {
  const name = projectName(row.project, row.name, t);
  const detailsId = `activity-project-${row.project ?? "unattributed"}`;
  return (
    <li className="border-t border-border first:border-t-0" data-activity-project={row.project ?? ""}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={onToggle}
        className="grid w-full grid-cols-[minmax(0,220px)_minmax(0,1fr)_20px] items-center gap-x-4 px-4 py-3 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 max-sm:grid-cols-[minmax(0,1fr)_20px] max-sm:gap-y-2"
      >
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-primary" title={name}>{name}</div>
          <div className="truncate text-[11px] text-muted">
            {t("activity.project.requests", { count: row.requests })} · {t("activity.project.agents", { count: row.conversations })}
          </div>
        </div>
        <ChevronDown aria-hidden className={`h-4 w-4 text-muted transition-transform sm:order-last ${expanded ? "rotate-180" : ""}`} />
        <div className="flex min-w-0 flex-col gap-1.5 max-sm:col-span-2">
          <div className="flex items-center gap-2">
            <Bar value={row.humanMs} max={max} kind="human" />
            <span className="w-[132px] shrink-0 text-[11px] tabular-nums text-primary max-sm:w-[118px]">
              <span className="font-semibold">{duration(row.humanMs, t)}</span>
              {row.humanHours ? <span className="text-muted"> · {reportHours(row.humanHours, locale, t)}</span> : null}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Bar value={row.wallMs} max={max} kind="agent" supervised={row.supervisedMs} />
            <span className="w-[132px] shrink-0 text-[11px] tabular-nums text-primary max-sm:w-[118px]">
              <span className="font-semibold">{approx(row.wallMs, t)}</span>
            </span>
          </div>
        </div>
      </button>
      {expanded ? (
        <div id={detailsId} className="border-t border-dashed border-border bg-sunken/60 px-4 py-3" data-activity-project-details="">
          <p className="mb-3 text-[11px] leading-snug text-secondary">
            {t("activity.project.split", {
              supervised: approx(row.supervisedMs, t),
              unattended: approx(row.unattendedMs, t),
              agentHours: approx(row.agentHoursMs, t),
            })}
            {row.humanReassignedMs > 0 ? ` ${t("activity.project.reassigned", { value: duration(row.humanReassignedMs, t) })}` : ""}
          </p>
          <div className="grid grid-cols-5 gap-5 max-lg:grid-cols-3 max-sm:grid-cols-1 max-sm:gap-4">
            <Breakdown kind="human" t={t} title={t("activity.breakdown.surface")} rows={SURFACES.map((surface) => ({ key: surface, label: t(`activity.surface.${surface}` as MessageKey), ms: row.bySurface[surface] }))} />
            <Breakdown kind="human" t={t} title={t("activity.breakdown.kind")} rows={REQUEST_KINDS.map((kind) => ({ key: kind, label: t(`activity.kind.${kind}` as MessageKey), ms: row.byKind[kind] }))} />
            <Breakdown kind="agent" t={t} title={t("activity.breakdown.engine")} rows={Object.entries(row.byEngine).sort((a, b) => b[1] - a[1]).map(([engine, ms]) => ({ key: engine, label: ENGINE_NAMES[engine] ?? engine, ms }))} />
            <Breakdown kind="agent" t={t} title={t("activity.breakdown.role")} rows={Object.entries(row.byRole).sort((a, b) => b[1] - a[1]).map(([role, ms]) => ({ key: role, label: roleName(role, t), ms }))} />
            <Breakdown
              kind="agent"
              t={t}
              title={t("activity.breakdown.pipelines")}
              rows={row.pipelines.map((pipeline) => ({ key: pipeline.id, label: pipeline.id, ms: pipeline.agentHoursMs, mono: true, note: pipeline.stages.join(" · ") || undefined }))}
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------------ */
/* What is counted                                                          */
/* ------------------------------------------------------------------------ */

const COVERAGE_ROWS: ReadonlyArray<{ key: string; surface: MessageKey; counted: MessageKey; missing: MessageKey }> = [
  { key: "desktop", surface: "activity.coverage.desktop", counted: "activity.coverage.desktopCounted", missing: "activity.coverage.desktopMissing" },
  { key: "tablet", surface: "activity.coverage.tablet", counted: "activity.coverage.tabletCounted", missing: "activity.coverage.tabletMissing" },
  { key: "phone", surface: "activity.coverage.phone", counted: "activity.coverage.phoneCounted", missing: "activity.coverage.phoneMissing" },
  { key: "voice", surface: "activity.coverage.voice", counted: "activity.coverage.voiceCounted", missing: "activity.coverage.voiceMissing" },
  { key: "other", surface: "activity.coverage.other", counted: "activity.coverage.otherCounted", missing: "activity.coverage.otherMissing" },
  { key: "outside", surface: "activity.coverage.outside", counted: "activity.coverage.outsideCounted", missing: "activity.coverage.outsideMissing" },
];

function Counted({ data, locale, t }: { data: ActivityResponse; locale: Locale; t: TFunction }) {
  const { params, coverage } = data;
  return (
    <section className="rounded-[12px] border border-border bg-card px-4 py-4" aria-labelledby="activity-counted" data-activity-counted="">
      <h2 id="activity-counted" className="text-[13px] font-semibold text-primary">{t("activity.counted.title")}</h2>
      <div className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-secondary">
        <p>{t("activity.counted.method", { window: params.windowMin, break: params.breakMin })}</p>
        <p>{t(params.rounding === "half-hour" ? "activity.counted.halfHour" : "activity.counted.clockHour")}</p>
        <p>{t("activity.counted.agent")}</p>
        <p>
          {coverage.ledgerStartMs !== null
            ? t("activity.counted.ledgerSince", { when: dateTime(coverage.ledgerStartMs, locale, params.tz) })
            : t("activity.counted.ledgerNone")}
          {" "}
          {coverage.indexedAtMs !== null ? t("activity.counted.indexUpdated", { when: dateTime(coverage.indexedAtMs, locale, params.tz) }) : null}
        </p>
        <p>
          {t("activity.counted.gaps")}
          {coverage.unregisteredConversations ? ` ${t("activity.counted.unregistered", { count: coverage.unregisteredConversations })}` : ""}
        </p>
        <p className="text-muted">{t("activity.counted.zone", { tz: params.tz })}</p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-[11.5px] max-sm:min-w-0" data-activity-coverage="">
          <thead>
            <tr className="text-[11px] text-muted">
              <th scope="col" className="w-[22%] py-1.5 pr-3 font-semibold">{t("activity.coverage.surface")}</th>
              <th scope="col" className="w-[39%] py-1.5 pr-3 font-semibold">{t("activity.coverage.counted")}</th>
              <th scope="col" className="py-1.5 font-semibold">{t("activity.coverage.missing")}</th>
            </tr>
          </thead>
          <tbody>
            {COVERAGE_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-border align-top max-sm:flex max-sm:flex-col max-sm:py-2">
                <th scope="row" className="py-1.5 pr-3 font-semibold text-primary max-sm:py-0.5">{t(row.surface)}</th>
                <td className="py-1.5 pr-3 text-secondary max-sm:py-0.5">{t(row.counted)}</td>
                <td className="py-1.5 text-muted max-sm:py-0.5">{t(row.missing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* The page                                                                 */
/* ------------------------------------------------------------------------ */

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function ActivityDashboard({ initialRange, initialView }: { initialRange: RangeKey; initialView: ActivityView }) {
  const { t, locale } = useLocale();
  const [range, setRange] = useState<RangeKey>(initialRange);
  const [view, setView] = useState<ActivityView>(initialView);
  const [sort, setSort] = useState<ProjectSort>("human");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (target: RangeKey) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/activity?range=${target}&tz=${encodeURIComponent(browserZone())}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as ActivityResponse;
      if (id !== request.current) return;
      setData(body);
      setFailed(false);
    } catch {
      if (id === request.current) setFailed(true);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(range);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, range]);

  /* The range and view live in the address, so a reload or a shared link
     opens the same page. */
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("range", range);
    url.searchParams.set("view", view);
    window.history.replaceState(window.history.state, "", url);
  }, [range, view]);

  const names = useMemo(() => {
    const map = new Map<string | null, string>();
    for (const row of data?.projects ?? []) map.set(row.project, projectName(row.project, row.name, t));
    return map;
  }, [data, t]);

  const projects = useMemo(() => {
    const rows = [...(data?.projects ?? [])];
    return sort === "agent"
      ? rows.sort((a, b) => b.wallMs - a.wallMs || b.humanMs - a.humanMs)
      : rows.sort((a, b) => b.humanMs - a.humanMs || b.wallMs - a.wallMs);
  }, [data, sort]);
  const projectMax = Math.max(0, ...projects.map((row) => Math.max(row.humanMs, row.wallMs)));
  const days = useMemo(() => [...(data?.days ?? [])].reverse(), [data]);
  const tz = data?.params.tz ?? browserZone();
  const nothingRecorded = data !== null && data.coverage.ledger !== "ok";
  const noAgentIndex = data !== null && data.coverage.agentIndex !== "ok";
  const totals = data?.totals;
  const roundingName = data ? t(data.params.rounding === "half-hour" ? "activity.rounding.halfHour" : "activity.rounding.clockHour") : "";

  return (
    <div className="h-full overflow-y-auto bg-canvas" data-activity-page="">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-4 px-6 py-5 max-sm:px-3 max-sm:py-3">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <a
            href="/"
            className="flex h-8 items-center gap-1.5 rounded-[8px] border border-border bg-card px-2.5 text-[12px] font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-10"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("activity.back")}
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-bold text-primary">{t("activity.title")}</h1>
            <p className="text-[11.5px] text-muted">{t("activity.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:flex-col max-sm:items-stretch">
            <Segmented<RangeKey>
              label={t("activity.rangeAria")}
              value={range}
              onChange={(next) => { setRange(next); setExpanded(null); }}
              options={RANGES.map((key) => ({ value: key, label: t(`activity.range.${key}` as MessageKey) }))}
            />
            <Segmented<ActivityView>
              label={t("activity.viewAria")}
              value={view}
              onChange={setView}
              options={[{ value: "days", label: t("activity.view.days") }, { value: "projects", label: t("activity.view.projects") }]}
            />
          </div>
        </header>

        {failed && !data ? (
          <div role="alert" className="rounded-[12px] border border-border bg-warning-soft px-4 py-3 text-[12px] text-warning">{t("activity.failed")}</div>
        ) : null}

        {data && totals ? (
          <div className={`flex flex-col gap-4 transition-opacity ${loading ? "opacity-60" : ""}`} data-activity-loaded={data.range.key}>
            {nothingRecorded || noAgentIndex ? (
              <div className="flex flex-col gap-1 rounded-[12px] border border-border bg-card px-4 py-3 text-[12px] leading-snug text-secondary" data-activity-gap="">
                {nothingRecorded ? <p><span className="font-semibold text-primary">{t("activity.gap.ledgerTitle")}</span> {t("activity.gap.ledger")}</p> : null}
                {noAgentIndex ? <p><span className="font-semibold text-primary">{t("activity.gap.indexTitle")}</span> {t("activity.gap.index")}</p> : null}
              </div>
            ) : null}

            <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:gap-2">
              <Tile
                testId="human"
                label={t("activity.tile.human")}
                value={nothingRecorded ? t("activity.notRecorded") : duration(totals.humanMs, t)}
                sub={nothingRecorded ? undefined : t("activity.tile.humanSub", { hours: reportHours(totals.humanHours, locale, t), mode: roundingName })}
              />
              <Tile testId="agent" label={t("activity.tile.agent")} value={approx(totals.wallMs, t)} sub={t("activity.tile.agentSub")} />
              <Tile
                testId="split"
                label={t("activity.tile.split")}
                value={approx(totals.supervisedMs, t)}
                sub={t("activity.tile.splitSub", { unattended: approx(totals.unattendedMs, t) })}
              >
                <div className="mt-2" aria-hidden>
                  <Bar value={totals.wallMs} max={totals.wallMs} kind="agent" supervised={totals.supervisedMs} />
                </div>
              </Tile>
              <Tile testId="agent-hours" label={t("activity.tile.agentHours")} value={approx(totals.agentHoursMs, t)} sub={t("activity.tile.agentHoursSub")} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Legend t={t} />
              {view === "projects" ? (
                <Segmented<ProjectSort>
                  label={t("activity.sortAria")}
                  value={sort}
                  onChange={setSort}
                  options={[{ value: "human", label: t("activity.sort.human") }, { value: "agent", label: t("activity.sort.agent") }]}
                />
              ) : null}
            </div>

            {view === "days" ? (
              <section className="rounded-[12px] border border-border bg-card px-4 pb-1.5 pt-3" aria-label={t("activity.view.days")} data-activity-days="">
                <DayAxis />
                <ul>
                  {days.map((day) => (
                    <DayRow key={day.date} day={day} tz={tz} nowMs={data.range.now} names={names} locale={locale} t={t} />
                  ))}
                </ul>
              </section>
            ) : (
              <section className="overflow-hidden rounded-[12px] border border-border bg-card" aria-label={t("activity.view.projects")} data-activity-projects="">
                {projects.length ? (
                  <ul>
                    {projects.map((row) => {
                      const key = row.project ?? "";
                      return (
                        <ProjectRow
                          key={key}
                          row={row}
                          max={projectMax}
                          expanded={expanded === key}
                          onToggle={() => setExpanded((current) => (current === key ? null : key))}
                          locale={locale}
                          t={t}
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <p className="px-4 py-6 text-center text-[12px] text-muted" data-activity-empty="">{t("activity.projects.empty")}</p>
                )}
              </section>
            )}

            <Counted data={data} locale={locale} t={t} />
          </div>
        ) : !failed ? (
          <div className="py-10 text-center text-[12px] text-muted">{t("common.loadingCap")}</div>
        ) : null}
      </div>
    </div>
  );
}
