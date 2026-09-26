"use client";

import { ArrowLeft, ChevronDown, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { HostReport } from "@/lib/activity/hostSources";
import { EXCLUSION_REASONS, REQUEST_KINDS, SURFACES, type Coverage, type DayActivity, type RangeKey } from "@/lib/activity/method";
import type { ActivityHostRow, ActivityProjectRow, ActivityResponse } from "@/lib/activity/report";
import { isOpaqueProjectKey, projectDisplayName } from "@/lib/displayNames";
import { useLocale, type Locale, type MessageKey, type TFunction } from "@/lib/i18n";

import { ActivityDesktop } from "./ActivityDesktop";
import { ActivityScopeChip } from "./ActivityProjectPicker";
import { nothingRead, projectFromSearch } from "./format";

/*
 * The activity dashboard. From 1024 px wide it draws the desktop page
 * (ActivityDesktop, docs/design/activity-dashboard-v2.md); narrower, it draws
 * the prototype's layout (docs/design/activity-dashboard.md, "Page"). Two
 * axes, each in its own hue and never added together: human time (accent) and
 * agent time (info), the agent part split into supervised (solid) and
 * unattended (hatched). Time an expected host was not read for is hatched
 * grey and reads "Unknown"; a total that misses a host is a lower bound
 * ("≥"); a workday that reads zero while a source was unread or agents were
 * busy says "Probable missing source". None of these is shown as a clean
 * zero.
 */

export type ActivityView = "days" | "projects";
type ProjectSort = "human" | "agent";

const RANGES: readonly RangeKey[] = ["today", "7d", "30d"];
const REFRESH_MS = 60_000;
const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The desktop page applies from 1024 px wide. The server renders the
    loading state either way, so it assumes the narrow one. */
function useDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
}

const HATCH_UNATTENDED: CSSProperties = {
  backgroundColor: "var(--color-info-soft)",
  backgroundImage: "repeating-linear-gradient(135deg, var(--color-info) 0 2px, transparent 2px 5px)",
};
const HATCH_UNKNOWN: CSSProperties = {
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

/** An agent figure that misses a host whose agent turns were not read is a
    lower bound: `≥ ≈ 3 h 10 m`. */
function agentFigure(ms: number, lower: boolean, t: TFunction): string {
  return lower ? t("activity.atLeast", { value: approx(ms, t) }) : approx(ms, t);
}

/** Human time under its coverage: a lower bound when a host was not read,
    "Unknown" when nothing was read there and nothing else counted. */
function humanFigure(ms: number, coverage: Coverage, t: TFunction): string {
  if (coverage.complete) return duration(ms, t);
  return ms > 0 ? t("activity.atLeast", { value: duration(ms, t) }) : t("activity.unknown");
}

function reportHours(hours: number, locale: Locale, t: TFunction, key: MessageKey = "activity.reportHours"): string {
  return t(key, { hours: new Intl.NumberFormat(locale === "uk" ? "uk-UA" : "en-US", { maximumFractionDigits: 1 }).format(hours) });
}

function intlLocale(locale: Locale): string {
  return locale === "uk" ? "uk-UA" : "en-GB";
}

function dayLabel(day: DayActivity, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(new Date(day.start + 12 * 3_600_000));
}

function clockTime(ms: number, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(ms));
}

function dateTime(ms: number, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(ms));
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

function hostName(host: string, hosts: readonly HostReport[], t: TFunction): string {
  const entry = hosts.find((candidate) => candidate.host === host);
  return entry?.label ?? (entry?.local ? t("activity.hosts.thisHostName") : host);
}

function hostList(ids: readonly string[], hosts: readonly HostReport[], t: TFunction): string {
  return ids.map((id) => hostName(id, hosts, t)).join(", ");
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
          className={`min-h-8 flex-1 rounded-[6px] px-3 text-[12px] font-semibold whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11 ${value === option.value ? "bg-sunken text-primary" : "text-muted hover:text-primary"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type SwatchKind = "human" | "supervised" | "unattended" | "unknown";

function Swatch({ kind }: { kind: SwatchKind }) {
  const style = kind === "unattended" ? HATCH_UNATTENDED : kind === "unknown" ? HATCH_UNKNOWN : undefined;
  const tone = kind === "human" ? "bg-accent" : kind === "supervised" ? "bg-info" : kind === "unknown" ? "bg-sunken border border-border" : "";
  return <span aria-hidden className={`inline-block h-2.5 w-3 shrink-0 rounded-[2px] ${tone}`} style={style} />;
}

function Legend({ t }: { t: TFunction }) {
  const items: Array<{ kind: SwatchKind; label: MessageKey }> = [
    { kind: "human", label: "activity.legend.human" },
    { kind: "supervised", label: "activity.legend.supervised" },
    { kind: "unattended", label: "activity.legend.unattended" },
    { kind: "unknown", label: "activity.legend.unknown" },
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

function Tile({ label, value, sub, children, testId }: { label: string; value: string; sub?: ReactNode; children?: ReactNode; testId: string }) {
  return (
    <div className="min-w-0 rounded-[12px] border border-border bg-card px-4 py-3" data-activity-tile={testId}>
      <div className="text-[11px] font-semibold text-secondary">{label}</div>
      <div className="mt-1 text-[22px] font-semibold leading-tight text-primary max-sm:text-[19px]">{value}</div>
      {sub ? <div className="mt-1 text-[11px] leading-snug text-muted">{sub}</div> : null}
      {children}
    </div>
  );
}

function MissingSource({ reasons, t }: { reasons: DayActivity["missingSource"]; t: TFunction }) {
  if (!reasons) return null;
  return (
    <span className="flex items-center gap-1 font-semibold text-warning" data-activity-missing-source={reasons.join(" ")}>
      <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
      {t("activity.missingSource")}
    </span>
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

function DayRow({ day, tz, nowMs, names, hosts, locale, t }: {
  day: DayActivity;
  tz: string;
  nowMs: number;
  names: ReadonlyMap<string | null, string>;
  hosts: readonly HostReport[];
  locale: Locale;
  t: TFunction;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const track = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = strip.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover({ x: fraction * rect.width, at: day.start + fraction * (day.end - day.start) });
  };
  const hoverHuman = hover ? day.human.find((segment) => segment.start <= hover.at && hover.at < segment.end) : undefined;
  const hoverAgent = hover ? day.agent.find((segment) => segment.start <= hover.at && hover.at < segment.end) : undefined;
  const hoverUnknown = hover ? day.unknown.some((span) => span.start <= hover.at && hover.at < span.end) : false;
  const label = dayLabel(day, locale, tz);
  const humanText = day.missingSource ? t("activity.missingSource") : humanFigure(day.humanMs, day.coverage, t);
  const summary = t("activity.day.aria", {
    day: label,
    human: humanText,
    agent: approx(day.wallMs, t),
    supervised: approx(day.supervisedMs, t),
  });
  return (
    <li className="grid grid-cols-[112px_minmax(0,1fr)_minmax(176px,auto)] items-center gap-x-4 border-t border-border py-2.5 first:border-t-0 max-sm:grid-cols-1 max-sm:gap-y-2" data-activity-day={day.date} data-coverage={day.coverage.complete ? "complete" : "unknown"}>
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
        onPointerLeave={(event) => { if (event.pointerType !== "touch") setHover(null); }}
      >
        <div className="relative h-3 overflow-hidden rounded-[3px] bg-sunken" data-activity-lane="human">
          {HOUR_TICKS.slice(1, -1).map((hour) => (
            <span key={hour} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: `${(hour / 24) * 100}%` }} />
          ))}
          {day.unknown.map((span) => (
            <span key={`u${span.start}`} className="absolute inset-y-0" style={{ ...position(span.start, span.end, day), ...HATCH_UNKNOWN }} data-activity-unknown="" />
          ))}
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
            className="pointer-events-none absolute bottom-full z-10 mb-1.5 w-max max-w-[260px] -translate-x-1/2 rounded-[8px] border border-border bg-raised px-2.5 py-1.5 text-[11px] leading-snug shadow-2"
            style={{ left: Math.min(Math.max(hover.x, 100), (strip.current?.clientWidth ?? 0) - 100) }}
            data-activity-tooltip=""
          >
            <div className="font-semibold text-primary">{clockTime(hover.at, locale, tz)}</div>
            <div className="flex items-center gap-1.5 text-secondary">
              <Swatch kind="human" />
              {hoverHuman
                ? t("activity.tooltip.human", { project: names.get(hoverHuman.project) ?? t("activity.unattributed"), host: hostName(hoverHuman.host, hosts, t) })
                : t("activity.tooltip.noHuman")}
            </div>
            {hoverUnknown ? (
              <div className="flex items-center gap-1.5 text-secondary">
                <Swatch kind="unknown" />
                {t("activity.tooltip.unknown", { hosts: hostList(day.coverage.missingHosts, hosts, t) })}
              </div>
            ) : null}
            <div className="flex items-center gap-1.5 text-secondary">
              <Swatch kind={hoverAgent?.supervised === false ? "unattended" : "supervised"} />
              {hoverAgent ? t(hoverAgent.supervised ? "activity.tooltip.supervised" : "activity.tooltip.unattended") : t("activity.tooltip.noAgent")}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 text-[11px] tabular-nums max-sm:order-2 max-sm:flex-row max-sm:flex-wrap max-sm:gap-x-3" data-activity-day-totals="">
        <span className="flex items-center gap-1.5 text-primary" title={day.coverage.complete ? undefined : t("activity.unread", { hosts: hostList(day.coverage.missingHosts, hosts, t) })}>
          <Swatch kind={day.coverage.complete || day.humanMs > 0 ? "human" : "unknown"} />
          {day.missingSource ? <MissingSource reasons={day.missingSource} t={t} /> : (
            <>
              <span className={day.coverage.complete || day.humanMs > 0 ? "font-semibold" : "text-muted"}>{humanFigure(day.humanMs, day.coverage, t)}</span>
              {day.humanHours ? <span className="text-muted">· {reportHours(day.humanHours, locale, t)}</span> : null}
            </>
          )}
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
                <div className="mt-0.5 h-1 rounded-r-[2px]" style={{ width: `${max ? (row.ms / max) * 100 : 0}%`, backgroundColor: kind === "human" ? "var(--color-accent)" : "var(--color-info)" }} />
              </div>
              <span className="text-right tabular-nums text-secondary">{kind === "agent" ? approx(row.ms, t) : duration(row.ms, t)}</span>
            </li>
          ))}
        </ul>
      ) : <div className="text-[11px] text-muted">{t("activity.breakdown.none")}</div>}
    </div>
  );
}

function ProjectRow({ row, max, expanded, selected, onToggle, hosts, locale, t }: {
  row: ActivityProjectRow;
  max: number;
  expanded: boolean;
  /** A project row selects its project, and reads pressed while the page is
      scoped to it; the row with no project only opens its detail. */
  selected: boolean | null;
  onToggle(): void;
  hosts: readonly HostReport[];
  locale: Locale;
  t: TFunction;
}) {
  const name = projectName(row.project, row.name, t);
  const detailsId = `activity-project-${row.project ?? "unattributed"}`;
  const unread = row.coverage.complete ? null : t("activity.unread", { hosts: hostList(row.coverage.missingHosts, hosts, t) });
  return (
    <li className="border-t border-border first:border-t-0" data-activity-project={row.project ?? ""} data-coverage={row.coverage.complete ? "complete" : "unknown"} data-selected={selected ? "true" : undefined}>
      <button
        type="button"
        aria-pressed={selected ?? undefined}
        aria-expanded={selected === null ? expanded : undefined}
        aria-controls={detailsId}
        onClick={onToggle}
        className={`grid w-full grid-cols-[minmax(0,220px)_minmax(0,1fr)_20px] items-center gap-x-4 px-4 py-3 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 max-sm:grid-cols-[minmax(0,1fr)_20px] max-sm:gap-y-2 ${selected ? "bg-sunken shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
      >
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-primary" title={name}>{name}</div>
          <div className="truncate text-[11px] text-muted">
            {row.billable ? `${t("activity.project.billable")} · ` : ""}
            {t("activity.project.requests", { count: row.requests })} · {t("activity.project.agents", { count: row.conversations })}
          </div>
        </div>
        <ChevronDown aria-hidden className={`h-4 w-4 text-muted transition-transform sm:order-last ${expanded ? "rotate-180" : ""}`} />
        <div className="flex min-w-0 flex-col gap-1.5 max-sm:col-span-2">
          <div className="flex items-center gap-2">
            <Bar value={row.humanMs} max={max} kind="human" />
            <span className="w-[132px] shrink-0 text-[11px] tabular-nums text-primary max-sm:w-[118px]" title={unread ?? undefined}>
              <span className={row.coverage.complete || row.humanMs > 0 ? "font-semibold" : "text-muted"}>{humanFigure(row.humanMs, row.coverage, t)}</span>
              {row.humanHours ? <span className="text-muted"> · {reportHours(row.humanHours, locale, t, "activity.reportHoursShort")}</span> : null}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Bar value={row.wallMs} max={max} kind="agent" supervised={row.supervisedMs} />
            <span className="w-[132px] shrink-0 text-[11px] tabular-nums text-primary max-sm:w-[118px]" title={row.agentCoverage.complete ? undefined : t("activity.detail.agentsNotRead", { hosts: hostList(row.agentCoverage.missingHosts, hosts, t) })}>
              <span className="font-semibold">{agentFigure(row.wallMs, !row.agentCoverage.complete, t)}</span>
            </span>
          </div>
        </div>
      </button>
      {expanded ? (
        <div id={detailsId} className="border-t border-border bg-sunken/60 px-4 py-3" data-activity-project-details="">
          <p className="mb-3 text-[11px] leading-snug text-secondary">
            {unread ? <span className="font-semibold text-primary">{unread} </span> : null}
            {t("activity.project.split", {
              supervised: approx(row.supervisedMs, t),
              unattended: approx(row.unattendedMs, t),
              agentHours: approx(row.agentHoursMs, t),
            })}
            {row.humanReassignedMs > 0 ? ` ${t("activity.project.reassigned", { value: duration(row.humanReassignedMs, t) })}` : ""}
          </p>
          <div className="grid grid-cols-3 gap-5 max-sm:grid-cols-1 max-sm:gap-4">
            <Breakdown kind="human" t={t} title={t("activity.breakdown.host")} rows={Object.entries(row.byHost).sort((a, b) => b[1] - a[1]).map(([host, ms]) => ({ key: host, label: hostName(host, hosts, t), ms }))} />
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
  { key: "terminal", surface: "activity.coverage.terminal", counted: "activity.coverage.terminalCounted", missing: "activity.coverage.terminalMissing" },
  { key: "other", surface: "activity.coverage.other", counted: "activity.coverage.otherCounted", missing: "activity.coverage.otherMissing" },
  { key: "outside", surface: "activity.coverage.outside", counted: "activity.coverage.outsideCounted", missing: "activity.coverage.outsideMissing" },
];

const SOURCE_NAMES: Record<HostReport["sources"][number]["source"], MessageKey> = {
  ledger: "activity.hosts.ledger",
  transcripts: "activity.hosts.transcripts",
  ingest: "activity.hosts.ingest",
  pull: "activity.hosts.pull",
};
const SOURCE_ERRORS = new Set(["unreachable", "timeout", "no-ingest", "malformed", "unreadable"]);

function sourceLine(source: HostReport["sources"][number], locale: Locale, tz: string, t: TFunction): string {
  const name = t(SOURCE_NAMES[source.source]);
  /* When the ingest or the pull last read, and why its last try did not. */
  const tail = [
    source.source !== "ledger" && source.readAt !== null ? t("activity.hosts.lastRead", { at: dateTime(source.readAt, locale, tz) }) : null,
    source.error && SOURCE_ERRORS.has(source.error) ? t("activity.hosts.lastError", { reason: t(`activity.hosts.error.${source.error}` as MessageKey) }) : null,
  ].filter(Boolean).join("; ");
  const withTail = (line: string) => (tail ? `${line} (${tail})` : line);
  if (source.state === "absent") return t("activity.hosts.absent", { source: name });
  if (source.state === "unreadable") return withTail(t("activity.hosts.unreadable", { source: name }));
  if (source.state === "pending") return withTail(t("activity.hosts.pending", { source: name }));
  const first = source.covered[0];
  const last = source.covered.at(-1);
  return withTail(t("activity.hosts.readSpan", {
    source: name,
    from: first ? dateTime(first.start, locale, tz) : "—",
    until: last ? dateTime(last.end, locale, tz) : "—",
    count: source.inputs,
  }));
}

function HostsTable({ hosts, locale, tz, t }: { hosts: readonly ActivityHostRow[]; locale: Locale; tz: string; t: TFunction }) {
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-[11.5px] max-sm:block max-sm:min-w-0" data-activity-hosts="">
        <thead className="max-sm:hidden">
          <tr className="text-[11px] text-muted">
            <th scope="col" className="w-[22%] py-1.5 pr-3 font-semibold">{t("activity.hosts.host")}</th>
            <th scope="col" className="w-[39%] py-1.5 pr-3 font-semibold">{t("activity.hosts.read")}</th>
            <th scope="col" className="py-1.5 font-semibold">{t("activity.hosts.excluded")}</th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {hosts.map((host) => {
            const connected = host.sources.some((source) => source.state === "read");
            /* Its ledger is read and its transcripts are not read for all of the range. */
            const terminalUnread = !host.complete && host.sources.some((source) => source.scope === "delegatus" && source.state === "read");
            const excluded = EXCLUSION_REASONS
              .map((reason) => [reason, host.sources.reduce((sum, source) => sum + (source.excluded[reason] ?? 0), 0)] as const)
              .filter(([, count]) => count > 0);
            return (
              <tr key={host.host} className="border-t border-border align-top max-sm:flex max-sm:flex-col max-sm:py-2" data-activity-host={host.host} data-connected={connected ? "true" : "false"} data-complete={host.complete ? "true" : "false"}>
                <th scope="row" className="py-1.5 pr-3 font-semibold text-primary max-sm:block max-sm:py-0.5">
                  {hostName(host.host, hosts, t)}
                  {host.local && host.label ? <span className="font-normal text-muted"> · {t("activity.hosts.thisHost")}</span> : null}
                  {!connected ? (
                    <span className="mt-0.5 flex items-center gap-1 font-semibold text-warning">
                      <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
                      {t("activity.hosts.notConnected")}
                    </span>
                  ) : null}
                </th>
                <td className="py-1.5 pr-3 text-secondary max-sm:block max-sm:py-0.5">
                  {host.sources.map((source) => <div key={source.source}>{sourceLine(source, locale, tz, t)}</div>)}
                  {terminalUnread ? (
                    <div className="mt-0.5 flex items-start gap-1 text-warning" data-activity-terminal-unread="">
                      <TriangleAlert className="mt-[2px] h-3 w-3 shrink-0" aria-hidden />
                      {t("activity.hosts.terminalUnread")}
                    </div>
                  ) : null}
                  {host.agentsComplete === false && !host.local ? (
                    <div className="mt-0.5 flex items-start gap-1 text-warning" data-activity-agents-unread="">
                      <TriangleAlert className="mt-[2px] h-3 w-3 shrink-0" aria-hidden />
                      {t("activity.hosts.agentsUnread")}
                    </div>
                  ) : null}
                </td>
                <td className="py-1.5 text-muted max-sm:block max-sm:py-0.5">
                  <span className="font-semibold sm:hidden">{t("activity.hosts.excluded")}: </span>
                  {excluded.length
                    ? excluded.map(([reason, count]) => t("activity.hosts.excludedItem", { reason: t(`activity.exclusion.${reason}` as MessageKey), count })).join(", ")
                    : t("activity.hosts.excludedNone")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Counted({ data, locale, t }: { data: ActivityResponse; locale: Locale; t: TFunction }) {
  const { params, coverage } = data;
  const windowsOnly = params.breakMin === params.windowMin;
  return (
    <section className="rounded-[12px] border border-border bg-card px-4 py-4" aria-labelledby="activity-counted" data-activity-counted="">
      <h2 id="activity-counted" className="text-[13px] font-semibold text-primary">{t("activity.counted.title")}</h2>
      <div className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-secondary">
        <p>{t(windowsOnly ? "activity.counted.methodWindows" : "activity.counted.methodEpisodes", { window: params.windowMin, break: params.breakMin })}</p>
        <p>{t(params.rounding === "half-hour" ? "activity.counted.halfHour" : "activity.counted.clockHour")}</p>
        <p>{t("activity.counted.parallel")}</p>
        <p>{t("activity.counted.operatorOnly")}</p>
        <p>{t("activity.counted.agent")}</p>
        <p>
          {t("activity.counted.hosts")}
          {coverage.indexedAtMs !== null ? ` ${t("activity.counted.indexUpdated", { when: dateTime(coverage.indexedAtMs, locale, params.tz) })}` : ""}
        </p>
        <p>
          {t("activity.counted.gaps")}
          {coverage.unregisteredConversations ? ` ${t("activity.counted.unregistered", { count: coverage.unregisteredConversations })}` : ""}
        </p>
        <p className="text-muted">{t("activity.counted.zone", { tz: params.tz })}</p>
      </div>
      <h3 className="mt-4 text-[12px] font-semibold text-primary">{t("activity.hosts.title")}</h3>
      <HostsTable hosts={coverage.hosts} locale={locale} tz={params.tz} t={t} />
      <h3 className="mt-4 text-[12px] font-semibold text-primary">{t("activity.coverage.title")}</h3>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-[11.5px] max-sm:block max-sm:min-w-0" data-activity-coverage="">
          <thead className="max-sm:hidden">
            <tr className="text-[11px] text-muted">
              <th scope="col" className="w-[22%] py-1.5 pr-3 font-semibold">{t("activity.coverage.surface")}</th>
              <th scope="col" className="w-[39%] py-1.5 pr-3 font-semibold">{t("activity.coverage.counted")}</th>
              <th scope="col" className="py-1.5 font-semibold">{t("activity.coverage.missing")}</th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {COVERAGE_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-border align-top max-sm:flex max-sm:flex-col max-sm:py-2">
                <th scope="row" className="py-1.5 pr-3 font-semibold text-primary max-sm:block max-sm:py-0.5">{t(row.surface)}</th>
                <td className="py-1.5 pr-3 text-secondary max-sm:block max-sm:py-0.5">
                  <span className="font-semibold sm:hidden">{t("activity.coverage.counted")}: </span>
                  {t(row.counted)}
                </td>
                <td className="py-1.5 text-muted max-sm:block max-sm:py-0.5">
                  <span className="font-semibold sm:hidden">{t("activity.coverage.missing")}: </span>
                  {t(row.missing)}
                </td>
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

/** The query of one read: the range, and the project the page is scoped to. */
export function activityQuery(range: RangeKey, project: string | null): string {
  const search = new URLSearchParams({ range });
  if (project !== null) search.set("project", project);
  return search.toString();
}

export function ActivityDashboard({ initialRange, initialView, initialProject = null }: {
  initialRange: RangeKey;
  initialView: ActivityView;
  /** `?project=`: the project the whole page is scoped to, or none. */
  initialProject?: string | null;
}) {
  const { t, locale } = useLocale();
  const desktop = useDesktop();
  const [range, setRange] = useState<RangeKey>(initialRange);
  const [view, setView] = useState<ActivityView>(initialView);
  const [project, setProject] = useState<string | null>(initialProject);
  const [sort, setSort] = useState<ProjectSort>("human");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [data, setData] = useState<ActivityResponse | null>(null);
  /* The project the answer on screen was asked for. */
  const [dataFor, setDataFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);

  /* No zone is sent: days and hours follow the zone in the settings
     (Europe/Kyiv unless changed), whatever zone this device is in. A
     project's figures are the server's own count for that project. */
  const load = useCallback(async (target: RangeKey, scope: string | null) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/activity?${activityQuery(target, scope)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as ActivityResponse;
      if (id !== request.current) return;
      setData(body);
      setDataFor(scope);
      setFailed(false);
    } catch {
      if (id === request.current) setFailed(true);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, project);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(range, project);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, range, project]);

  /* The range, view and project live in the address, so a reload or a shared
     link opens the same page. Choosing or clearing a project is a step Back
     undoes; a range or view switch replaces the entry it is on. */
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("range", range);
    url.searchParams.set("view", view);
    if (project !== null) url.searchParams.set("project", project);
    else url.searchParams.delete("project");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [range, view, project]);

  useEffect(() => {
    const onPopState = () => {
      const search = new URLSearchParams(window.location.search);
      const range = search.get("range");
      setProject(projectFromSearch(window.location.search));
      if (RANGES.includes(range as RangeKey)) setRange(range as RangeKey);
      setView(search.get("view") === "projects" ? "projects" : "days");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectProject = useCallback((next: string | null) => {
    setProject(next);
    setExpanded(null);
    const url = new URL(window.location.href);
    if (next !== null) url.searchParams.set("project", next);
    else url.searchParams.delete("project");
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
  }, []);

  const names = useMemo(() => {
    const map = new Map<string | null, string>();
    for (const row of data?.projects ?? []) map.set(row.project, projectName(row.project, row.name, t));
    return map;
  }, [data, t]);
  /* The chosen project as the page names it. The answer says which key it
     counted (an older key of a project reads under its current one); until
     it arrives, the key asked for. */
  const scope = project === null ? null : (() => {
    const answered = dataFor === project ? data?.scope ?? null : null;
    const key = answered?.project ?? project;
    return { project: key, name: names.get(key) ?? answered?.name ?? projectName(key, null, t) };
  })();

  const projects = useMemo(() => {
    const rows = [...(data?.projects ?? [])];
    return sort === "agent"
      ? rows.sort((a, b) => b.wallMs - a.wallMs || b.humanMs - a.humanMs)
      : rows.sort((a, b) => b.humanMs - a.humanMs || b.wallMs - a.wallMs);
  }, [data, sort]);
  const projectMax = Math.max(0, ...projects.map((row) => Math.max(row.humanMs, row.wallMs)));
  const days = useMemo(() => [...(data?.days ?? [])].reverse(), [data]);
  const hosts = data?.coverage.hosts ?? [];
  const tz = data?.params.tz ?? "Europe/Kyiv";
  const totals = data?.totals;
  const incomplete = totals ? !totals.coverage.complete : false;
  const agentsIncomplete = totals ? !totals.agentCoverage.complete : false;
  const noAgentIndex = data !== null && data.coverage.agentIndex !== "ok";
  const unread = data ? nothingRead(data) : false;
  const scopedRow = scope ? data?.projects.find((row) => row.project === scope.project) : undefined;
  const roundingName = data ? t(data.params.rounding === "half-hour" ? "activity.rounding.halfHour" : "activity.rounding.clockHour") : "";

  if (desktop) {
    return (
      <ActivityDesktop
        data={data}
        range={range}
        onRange={(next) => { setRange(next); setExpanded(null); }}
        scope={scope}
        onProject={selectProject}
        loading={loading}
        failed={failed}
        onRetry={() => void load(range, project)}
        locale={locale}
        t={t}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas" data-activity-page="">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-4 px-6 py-5 max-sm:px-3 max-sm:py-3">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <a
            href="/"
            data-activity-back=""
            className="flex h-8 items-center gap-1.5 rounded-[8px] border border-border bg-card px-2.5 text-[12px] font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("activity.back")}
          </a>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h1 className="text-[15px] font-bold text-primary">{t("activity.title")}</h1>
              {scope ? <ActivityScopeChip name={scope.name} onClear={() => selectProject(null)} t={t} /> : null}
            </div>
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
            {incomplete || agentsIncomplete || totals.missingSourceDays || noAgentIndex ? (
              <div className="flex flex-col gap-1 rounded-[12px] border border-border bg-card px-4 py-3 text-[12px] leading-snug text-secondary" data-activity-gap="">
                {incomplete ? (
                  <p className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-[2px] h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                    <span>
                      <span className="font-semibold text-primary">{t("activity.gap.incompleteTitle")}</span>{" "}
                      {t("activity.gap.incomplete", { hosts: hostList(totals.coverage.missingHosts, hosts, t) })}
                    </span>
                  </p>
                ) : null}
                {agentsIncomplete ? (
                  <p className="flex items-start gap-1.5" data-activity-gap-agents="">
                    <TriangleAlert className="mt-[2px] h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                    <span>
                      <span className="font-semibold text-primary">{t("activity.gap.agentsTitle")}</span>{" "}
                      {t("activity.gap.agents", { hosts: hostList(totals.agentCoverage.missingHosts, hosts, t) })}
                    </span>
                  </p>
                ) : null}
                {totals.missingSourceDays ? (
                  <p><span className="font-semibold text-primary">{t("activity.gap.missingSourceTitle", { count: totals.missingSourceDays })}</span> {t("activity.gap.missingSource")}</p>
                ) : null}
                {noAgentIndex ? <p><span className="font-semibold text-primary">{t("activity.gap.indexTitle")}</span> {t("activity.gap.index")}</p> : null}
              </div>
            ) : null}

            <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:gap-2">
              <Tile
                testId="human"
                label={t("activity.tile.human")}
                value={humanFigure(totals.humanMs, totals.coverage, t)}
                sub={unread ? t("activity.tile.humanUnknown") : !totals.coverage.complete && totals.humanMs === 0 ? t("activity.fig.notReadOn", { hosts: hostList(totals.coverage.missingHosts, hosts, t) }) : (
                  <>
                    {t("activity.tile.humanSub", { hours: reportHours(totals.humanHours, locale, t), mode: roundingName })}
                    {data.billableConfigured && (!scope || scopedRow?.billable) ? <><br />{reportHours(totals.billableHours, locale, t, "activity.tile.billable")}</> : null}
                  </>
                )}
              />
              <Tile testId="agent" label={t("activity.tile.agent")} value={agentFigure(totals.wallMs, agentsIncomplete, t)} sub={t("activity.tile.agentSub")} />
              <Tile
                testId="split"
                label={t("activity.tile.split")}
                value={agentFigure(totals.supervisedMs, agentsIncomplete, t)}
                sub={t("activity.tile.splitSub", { unattended: agentFigure(totals.unattendedMs, agentsIncomplete, t) })}
              >
                <div className="mt-2" aria-hidden>
                  <Bar value={totals.wallMs} max={totals.wallMs} kind="agent" supervised={totals.supervisedMs} />
                </div>
              </Tile>
              <Tile testId="agent-hours" label={t("activity.tile.agentHours")} value={agentFigure(totals.agentHoursMs, agentsIncomplete, t)} sub={t("activity.tile.agentHoursSub")} />
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
                    <DayRow key={day.date} day={day} tz={tz} nowMs={data.range.now} names={names} hosts={hosts} locale={locale} t={t} />
                  ))}
                </ul>
              </section>
            ) : (
              <section className="overflow-hidden rounded-[12px] border border-border bg-card" aria-label={t("activity.view.projects")} data-activity-projects="">
                {projects.length ? (
                  <ul>
                    {projects.map((row) => {
                      const key = row.project ?? "";
                      const selectable = row.project !== null;
                      const selected = selectable && scope?.project === row.project;
                      return (
                        <ProjectRow
                          key={key}
                          row={row}
                          max={projectMax}
                          expanded={selectable ? selected : expanded === key}
                          selected={selectable ? selected : null}
                          onToggle={() => (selectable
                            ? selectProject(selected ? null : row.project)
                            : setExpanded((current) => (current === key ? null : key)))}
                          hosts={hosts}
                          locale={locale}
                          t={t}
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <p className="px-4 py-6 text-center text-[12px] text-muted" data-activity-empty="">
                    {incomplete ? t("activity.projects.emptyUnknown") : t("activity.projects.empty")}
                  </p>
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
