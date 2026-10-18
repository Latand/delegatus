"use client";

import { CalendarRange, ChevronDown, Users, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Z } from "@/components/layers";
import { modelDisplayName } from "@/lib/agent/models";
import type { Locale, MessageKey, TFunction } from "@/lib/i18n";

import { intlLocale, roleName } from "../format";
import { Tooltip, type TipAnchor } from "../marks";
import type { ProtoKey, ProtoT } from "./copy";
import {
  ACCOUNTS, addDays, COUNTED_FROM, dayMs, dimensionOrder, engineOf, inputOf, MEMBERS, NOW_DATE, NOW_HOUR, PROJECTS, TOKEN_KINDS, totalOf,
  type ListRow, type Preset, type SeriesBucket, type TokenCounts, type TokenDimension, type TokenKind,
} from "./fixture";

/*
 * The pieces every variant of the token prototype draws with
 * (docs/design/activity-token-usage.md §9.1): compact Ukrainian numbers with
 * exact values in tooltips, the four kinds as one meter, stacked columns per
 * bucket, a ranked list, the coverage dot with its short popover, and the
 * range control whose last segment opens a two-date popover.
 */

export interface Ctx {
  locale: Locale;
  t: TFunction;
  pt: ProtoT;
}

/* ------------------------------------------------------------------------ */
/* Numbers and names                                                        */
/* ------------------------------------------------------------------------ */

export function compact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), { notation: "compact", maximumFractionDigits: value >= 1e3 && value < 1e4 ? 1 : value < 1e3 ? 0 : 1 }).format(Math.round(value));
}

export function exact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(Math.round(value));
}

export function percent(share: number, locale: Locale, digits = 0): string {
  return new Intl.NumberFormat(intlLocale(locale), { style: "percent", maximumFractionDigits: digits }).format(share);
}

/** «$1 574»: the sign leads in both languages, as API price pages print it. */
export function money(value: number, locale: Locale): string {
  return `$${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 }).format(value)}`;
}

export function dateText(date: string, locale: Locale, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: "UTC" }).format(new Date(dayMs(date)));
}

export function rangeLabel(from: string, to: string, locale: Locale): string {
  const format = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", timeZone: "UTC" });
  if (from === to) return format.format(new Date(dayMs(from)));
  return format.formatRange(new Date(dayMs(from)), new Date(dayMs(to)));
}

/** The days a span covers, as a phrase: «16 днів», «7 днів». */
export function daysPhrase(days: number, locale: Locale): string {
  if (locale !== "uk") return `${days} day${days === 1 ? "" : "s"}`;
  const mod10 = days % 10;
  const mod100 = days % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "день" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "дні" : "днів";
  return `${days} ${word}`;
}

const KIND_KEYS: Record<TokenKind, ProtoKey> = { cacheRead: "kind.cacheRead", input: "kind.input", cacheWrite: "kind.cacheWrite", output: "kind.output" };

export function entityName(dimension: TokenDimension, key: string, ctx: Ctx, otherCount = 0): string {
  const { t, pt } = ctx;
  if (key === "other") return pt("other", { count: otherCount });
  switch (dimension) {
    case "kind": return pt(KIND_KEYS[key as TokenKind]);
    case "model": return engineOf(key) === "codex" ? key.replace(/^gpt-6-/, "GPT-6 ").replace(/ (\w)/, (_, c: string) => ` ${c.toUpperCase()}`) : modelDisplayName("claude", key);
    case "role": return roleName(key, t);
    case "project": return key === "" ? pt("project.none") : PROJECTS.find((project) => project.key === key)?.name ?? key;
    case "member": {
      const member = MEMBERS.find((entry) => entry.id === key);
      return !member || member.id === "unattributed" ? pt("member.unattributed") : member.name;
    }
    case "account": {
      const account = ACCOUNTS.find((entry) => entry.id === key);
      return account ? `${account.label} (${account.plan})` : key;
    }
    case "engine": return key === "codex" ? "Codex" : "Claude";
  }
}

/** The colour follows the entity in its fixed order, never its rank. */
export function seriesColor(dimension: TokenDimension, key: string): string {
  if (key === "other") return "var(--mark-series-other)";
  if (dimension === "kind") return `var(--mark-kind-${TOKEN_KINDS.indexOf(key as TokenKind) + 1})`;
  const index = dimensionOrder(dimension).indexOf(key);
  return index >= 0 && index < 8 ? `var(--mark-series-${index + 1})` : "var(--mark-series-other)";
}

export function SeriesSwatch({ color, className = "" }: { color: string; className?: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ${className}`} style={{ background: color }} />;
}

/** An optional extra (§8) reads «Додатково» beside it, in words, never as a pill. */
export function Optional({ ctx }: { ctx: Ctx }) {
  return <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.04em] text-muted" data-token-optional="">{ctx.pt("optional")}</span>;
}

/* ------------------------------------------------------------------------ */
/* Measuring a box                                                          */
/* ------------------------------------------------------------------------ */

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const anchorOf = (element: Element): TipAnchor => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
};

/* ------------------------------------------------------------------------ */
/* Coverage dot                                                             */
/* ------------------------------------------------------------------------ */

export function CoverageDot({ complete, pendingGb, ctx }: { complete: boolean; pendingGb: number; ctx: Ctx }) {
  const { pt, locale } = ctx;
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const id = useId();
  const show = (element: Element) => setAnchor(anchorOf(element));
  return (
    <>
      <button
        type="button"
        aria-label={`${pt("coverage.aria")}: ${pt(complete ? "coverage.ok" : "coverage.lower")}`}
        aria-describedby={anchor ? id : undefined}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => setAnchor(null)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setAnchor(null)}
        onClick={(event) => (anchor ? setAnchor(null) : show(event.currentTarget))}
        className="relative inline-flex h-5 w-5 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-8 max-sm:w-8"
        data-token-coverage={complete ? "ok" : "lower"}
      >
        <span aria-hidden className={`h-2 w-2 rounded-full ${complete ? "bg-success" : "bg-warning"}`} />
      </button>
      {anchor ? (
        <Tooltip anchor={anchor} side="below" id={id}>
          <div className="font-semibold text-primary">{pt(complete ? "coverage.ok" : "coverage.lower")}</div>
          <div className="mt-1 grid gap-0.5 text-secondary">
            <span>{pt("coverage.from", { date: dateText(COUNTED_FROM, locale) })}</span>
            {complete ? null : <span>{pt("coverage.pending", { value: `${pendingGb.toLocaleString(intlLocale(locale))} ${locale === "uk" ? "ГБ" : "GB"}` })}</span>}
            <span>{pt("coverage.members")}</span>
            <span>{pt("coverage.compaction")}</span>
          </div>
        </Tooltip>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* The four kinds                                                           */
/* ------------------------------------------------------------------------ */

export const kindColor = (kind: TokenKind) => `var(--mark-kind-${TOKEN_KINDS.indexOf(kind) + 1})`;

/** A value an engine does not report reads «—», never 0 (Codex reports no
    cache writes). */
export function kindValue(counts: TokenCounts, kind: TokenKind, locale: Locale): string {
  return kind === "cacheWrite" && counts.cacheWrite === 0 ? "—" : compact(counts[kind], locale);
}

/** The kinds the meter's bar draws: cache reads are most of every total and
    would leave the other three as slivers, so they are stated on their own
    line and the bar splits the rest (§2). */
const REST_KINDS: readonly TokenKind[] = ["input", "cacheWrite", "output"];
/** Narrower than this a segment is a sliver; it is left out of the bar and
    keeps its printed value. */
const MIN_SEGMENT_PX = 6;

/** Cache reads on one line with their value, then one bar over the other
    three kinds with each kind's value printed under it. */
export function KindMeter({ counts, ctx, compactLabels = false }: { counts: TokenCounts; ctx: Ctx; compactLabels?: boolean }) {
  const { locale, pt } = ctx;
  const total = totalOf(counts);
  const [box, width] = useWidth<HTMLDivElement>();
  const rest = REST_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const gaps = 2 * (REST_KINDS.length - 1);
  const drawn = REST_KINDS.filter((kind) => rest > 0 && (counts[kind] / rest) * (width - gaps) >= MIN_SEGMENT_PX);
  const drawnSum = drawn.reduce((sum, kind) => sum + counts[kind], 0);
  const title = (kind: TokenKind) => (kind === "cacheWrite" && counts.cacheWrite === 0 ? pt("kind.notReported") : `${exact(counts[kind], locale)} · ${percent(total ? counts[kind] / total : 0, locale, 1)}`);
  const reasoning = pt("kind.reasoning", { share: percent(counts.output ? counts.reasoning / counts.output : 0, locale) });
  return (
    <div data-token-meter="">
      <div className="flex items-baseline gap-x-1.5 text-[12px]" title={title("cacheRead")} data-token-kind="cacheRead">
        <span className="whitespace-nowrap text-secondary">{pt("kind.cacheRead")}</span>
        <span className="whitespace-nowrap font-semibold tabular-nums text-primary">{compact(counts.cacheRead, locale)}</span>
      </div>
      <div ref={box} className="mt-2 flex h-2 w-full gap-[2px]" aria-hidden data-token-meter-bar="">
        {drawn.map((kind, index) => (
          <span
            key={kind}
            className={`h-full ${index === 0 ? "rounded-l-[3px]" : ""} ${index === drawn.length - 1 ? "rounded-r-[3px]" : ""}`}
            style={{ flex: `${drawnSum ? counts[kind] / drawnSum : 0} 0 0`, background: kindColor(kind) }}
            data-token-segment={kind}
          />
        ))}
      </div>
      <ul className={`mt-2 text-[12px] ${compactLabels ? "grid gap-y-1" : "flex flex-wrap gap-x-4 gap-y-1"}`}>
        {REST_KINDS.map((kind) => (
          <li key={kind} className={`flex min-w-0 items-baseline gap-x-1.5 ${compactLabels ? "justify-between" : "flex-wrap"}`} title={title(kind)} data-token-kind={kind}>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-secondary">
              <SeriesSwatch color={drawn.includes(kind) ? kindColor(kind) : "transparent"} />
              {pt(KIND_KEYS[kind])}
            </span>
            <span className="flex items-baseline gap-x-1.5 whitespace-nowrap">
              <span className="font-semibold tabular-nums text-primary">{kindValue(counts, kind, locale)}</span>
              {kind === "output" && !compactLabels ? <span className="text-muted">· {reasoning}</span> : null}
            </span>
          </li>
        ))}
        {compactLabels ? <li className="text-right text-muted" data-token-kind="reasoning">{reasoning}</li> : null}
      </ul>
    </div>
  );
}

/** The thin magnitude bar of a list row, as long as the row's share of the
    longest row, in one colour: the kinds of a row are printed elsewhere. */
export function KindBar({ value, max, color, height = 4 }: { value: number; max: number; color: string; height?: number }) {
  return (
    <div className="w-full" aria-hidden>
      <div className="rounded-[2px]" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%`, height, background: color }} data-token-rowbar="" />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Stacked columns                                                          */
/* ------------------------------------------------------------------------ */

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

function tickLabel(bucket: SeriesBucket, index: number, buckets: SeriesBucket[], locale: Locale, hour: boolean): string {
  if (hour) return bucket.label;
  const day = new Date(dayMs(bucket.start)).getUTCDate();
  const prev = buckets[index - 1];
  const monthChanged = !prev || new Date(dayMs(prev.start)).getUTCMonth() !== new Date(dayMs(bucket.start)).getUTCMonth();
  return monthChanged ? dateText(bucket.start, locale, { day: "numeric", month: "short" }) : String(day);
}

export function ColumnChart({ series, dimension, height, ctx, bucket, otherCount = 0, testId, scaleMax }: {
  series: SeriesBucket[];
  dimension: TokenDimension;
  height: number;
  ctx: Ctx;
  bucket: "hour" | "day" | "week";
  otherCount?: number;
  testId?: string;
  /** A tallest value shared with sibling charts, so their bars compare. */
  scaleMax?: number;
}) {
  const { locale, pt } = ctx;
  const [box, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ index: number; anchor: TipAnchor } | null>(null);
  const clip = useId().replace(/:/g, "");
  const left = 46;
  const bottom = 20;
  const top = 6;
  const innerW = Math.max(0, width - left - 4);
  const innerH = height - bottom - top;
  const totals = series.map((entry) => entry.parts.reduce((sum, part) => sum + totalOf(part.counts), 0));
  const max = niceMax(Math.max(scaleMax ?? 0, ...totals));
  const band = series.length ? innerW / series.length : 0;
  const barW = Math.max(3, Math.min(30, band * 0.64));
  const every = band >= 30 ? 1 : band >= 16 ? 2 : band >= 9 ? 4 : 7;
  const y = (value: number) => top + innerH - (value / max) * innerH;
  const hour = bucket === "hour";
  const hovered = tip ? series[tip.index] : null;

  return (
    <div ref={box} className="relative w-full" style={{ height }} data-token-chart={testId ?? dimension}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={pt("chart.aria", { bucket: pt(hour ? "chart.hour" : bucket === "week" ? "chart.week" : "chart.day") })} className="block">
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line x1={left} x2={width} y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--color-border)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={left - 6} y={y(max * fraction) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-muted)" className="tabular-nums" data-token-scale-top={fraction === 1 ? "" : undefined}>{fraction === 0 ? "0" : compact(max * fraction, locale)}</text>
            </g>
          ))}
          {series.map((entry, index) => {
            const x = left + index * band + (band - barW) / 2;
            if (!entry.counted) {
              return <rect key={entry.start + entry.label} x={x} y={top + innerH * 0.55} width={barW} height={innerH * 0.45} rx={3} fill="url(#activity-hatch-unread)" data-token-unread="" />;
            }
            let base = top + innerH;
            const columnTop = y(totals[index]!);
            return (
              <g key={entry.start + entry.label} opacity={tip && tip.index !== index ? 0.55 : 1}>
                <clipPath id={`${clip}-${index}`}>
                  <rect x={x} y={columnTop} width={barW} height={Math.max(0, top + innerH - columnTop)} rx={Math.min(4, barW / 2)} />
                  <rect x={x} y={Math.max(columnTop, top + innerH - 4)} width={barW} height={Math.min(4, top + innerH - columnTop)} />
                </clipPath>
                <g clipPath={`url(#${clip}-${index})`}>
                  {entry.parts.map((part) => {
                    const h = (totalOf(part.counts) / max) * innerH;
                    base -= h;
                    return h > 0 ? <rect key={part.key} x={x} y={base} width={barW} height={h} fill={dimension === "kind" ? kindColor(part.key as TokenKind) : seriesColor(dimension, part.key)} stroke="var(--color-card)" strokeWidth={h > 3 ? 1 : 0} /> : null;
                  })}
                </g>
                {entry.partial ? <text x={x + barW / 2} y={columnTop - 4} textAnchor="middle" fontSize={9} fill="var(--color-muted)">{pt("chart.partial", { hour: NOW_HOUR })}</text> : null}
              </g>
            );
          })}
          {series.map((entry, index) => (index % every === 0 ? (
            <text key={`l${entry.start}${entry.label}`} x={left + index * band + band / 2} y={height - 5} textAnchor="middle" fontSize={10} fill="var(--color-muted)" className="tabular-nums" data-token-tick="">
              {tickLabel(entry, index, series, locale, hour)}
            </text>
          ) : null))}
          {series.map((entry, index) => (
            <rect
              key={`h${entry.start}${entry.label}`}
              x={left + index * band}
              y={top}
              width={band}
              height={innerH}
              fill="transparent"
              tabIndex={0}
              aria-label={`${hour ? `${entry.label}:00` : dateText(entry.start, locale)}: ${compact(totals[index]!, locale)}`}
              onMouseEnter={(event) => setTip({ index, anchor: anchorOf(event.currentTarget) })}
              onFocus={(event) => setTip({ index, anchor: anchorOf(event.currentTarget) })}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
              className="outline-none"
            />
          ))}
        </svg>
      ) : null}
      {tip && hovered ? (
        <Tooltip anchor={tip.anchor} side="above">
          <div className="mb-1 font-semibold text-primary">
            {hour ? `${dateText(hovered.start, locale, { day: "numeric", month: "short" })}, ${hovered.label}:00` : bucket === "week" ? rangeLabel(hovered.start, hovered.end, locale) : dateText(hovered.start, locale, { weekday: "short", day: "numeric", month: "long" })}
          </div>
          {hovered.counted ? (
            <div className="grid grid-cols-[10px_auto_1fr] items-center gap-x-2 gap-y-px">
              {[...hovered.parts].reverse().filter((part) => totalOf(part.counts) > 0).slice(0, 8).map((part) => (
                <ChartTipRow key={part.key} color={dimension === "kind" ? kindColor(part.key as TokenKind) : seriesColor(dimension, part.key)} value={compact(totalOf(part.counts), locale)} label={entityName(dimension, part.key, ctx, otherCount)} />
              ))}
              <span aria-hidden />
              <span className="border-t border-border pt-0.5 text-right font-semibold tabular-nums text-primary">{exact(totals[tip.index]!, locale)}</span>
              <span className="border-t border-border pt-0.5 text-secondary">{pt("total")}</span>
            </div>
          ) : <div className="text-secondary">{pt("chart.notRead")}</div>}
        </Tooltip>
      ) : null}
    </div>
  );
}

function ChartTipRow({ color, value, label }: { color: string; value: string; label: string }) {
  return (
    <>
      <SeriesSwatch color={color} />
      <span className="text-right font-semibold tabular-nums whitespace-nowrap text-primary">{value}</span>
      <span className="whitespace-nowrap text-secondary">{label}</span>
    </>
  );
}

/** The chart's legend for a stacked dimension: identity is never colour alone. */
export function Legend({ dimension, keys, ctx, otherCount = 0 }: { dimension: TokenDimension; keys: string[]; ctx: Ctx; otherCount?: number }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-secondary" data-token-legend="">
      {keys.map((key) => (
        <li key={key} className="flex items-center gap-1.5 whitespace-nowrap">
          <SeriesSwatch color={dimension === "kind" ? kindColor(key as TokenKind) : seriesColor(dimension, key)} />
          {entityName(dimension, key, ctx, otherCount)}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------ */
/* Ranked list                                                              */
/* ------------------------------------------------------------------------ */

/** A neutral list (beside charts whose colours mean models) draws no swatch
    and no bar, so no colour means two things; its share stays printed. */
export function RankedList({ rows, dimension, total, selected, onSelect, ctx, otherCount, dense = false, neutral = false }: {
  rows: ListRow[];
  dimension: TokenDimension;
  total: number;
  selected: string | null;
  onSelect(key: string): void;
  ctx: Ctx;
  otherCount: number;
  dense?: boolean;
  neutral?: boolean;
}) {
  const { locale } = ctx;
  const max = Math.max(0, ...rows.map((row) => totalOf(row.counts)));
  const color = (key: string) => (dimension === "kind" ? kindColor(key as TokenKind) : seriesColor(dimension, key));
  const grid = neutral ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[10px_minmax(0,1fr)] gap-x-2.5";
  return (
    <ul className="flex flex-col" data-token-list={dimension}>
      {rows.map((row) => {
        const value = totalOf(row.counts);
        const pressed = selected === row.key;
        const clickable = row.key !== "other";
        const body = (
          <>
            {neutral ? null : <SeriesSwatch color={color(row.key)} className="mt-[3px] self-start" />}
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] font-semibold text-primary" title={entityName(dimension, row.key, ctx, otherCount)}>{entityName(dimension, row.key, ctx, otherCount)}</span>
                <span className="flex shrink-0 items-baseline gap-2 text-[12px] tabular-nums">
                  <span className="font-semibold text-primary" title={exact(value, locale)}>{compact(value, locale)}</span>
                  <span className="w-[38px] text-right text-muted">{percent(total ? value / total : 0, locale)}</span>
                </span>
              </div>
              {/* Only a row with its own series colour draws a size bar: a grey one would read as a token kind. */}
              {neutral || dimension === "kind" ? null : <div className="mt-1.5"><KindBar value={value} max={max} color={color(row.key)} /></div>}
            </div>
          </>
        );
        return (
          <li key={row.key} className="border-t border-border first:border-t-0" data-token-row={row.key}>
            {clickable ? (
              <button
                type="button"
                aria-pressed={pressed}
                onClick={() => onSelect(row.key)}
                className={`grid w-full ${grid} px-[18px] text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 max-sm:px-3 ${dense ? "py-2" : "py-2.5"} ${pressed ? "bg-sunken shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
              >
                {body}
              </button>
            ) : <div className={`grid ${grid} px-[18px] max-sm:px-3 ${dense ? "py-2" : "py-2.5"}`}>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------------ */
/* Sparkline                                                                */
/* ------------------------------------------------------------------------ */

export function Sparkline({ values, color, width = 72, height = 20 }: { values: number[]; color: string; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden className="block">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* Range control and the custom range popover                               */
/* ------------------------------------------------------------------------ */

export type RangeChoice = Preset | "custom";
const PRESETS: readonly Preset[] = ["today", "7d", "30d", "90d"];

export function RangeControl({ choice, from, to, open, onOpen, onPreset, onRange, ctx, phone = false }: {
  choice: RangeChoice;
  from: string;
  to: string;
  open: boolean;
  onOpen(open: boolean): void;
  onPreset(preset: Preset): void;
  onRange(from: string, to: string): void;
  ctx: Ctx;
  phone?: boolean;
}) {
  const { t, pt, locale } = ctx;
  const root = useRef<HTMLDivElement | null>(null);
  const customButton = useRef<HTMLButtonElement | null>(null);
  const fromInput = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState({ from, to });
  const dialogId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      onOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onOpen]);

  const label = (preset: Preset) => (preset === "90d" ? pt("range.90d") : t(`activity.range.${preset}` as MessageKey));
  const customLabel = choice === "custom" ? rangeLabel(from, to, locale) : pt("range.custom");
  const segment = (selected: boolean) => `${phone ? "h-11 flex-auto px-2" : "h-7 px-3"} whitespace-nowrap rounded-[6px] text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${selected ? "bg-canvas text-primary" : "text-muted hover:text-primary"}`;
  const apply = (next: { from: string; to: string }) => {
    setDraft(next);
    if (/^\d{4}-\d{2}-\d{2}$/.test(next.from) && /^\d{4}-\d{2}-\d{2}$/.test(next.to)) onRange(next.from, next.to);
  };

  return (
    <div ref={root} className={`relative ${phone ? "w-full" : "shrink-0"}`} data-token-range={open ? "open" : "closed"}>
      <div className={`flex rounded-[8px] border border-border bg-card p-[2px] ${phone ? "w-full" : ""}`} role="tablist" aria-label={t("activity.rangeAria")}>
        {PRESETS.map((preset) => (
          <button key={preset} type="button" role="tab" aria-selected={choice === preset} onClick={() => { onOpen(false); onPreset(preset); }} className={segment(choice === preset)} data-token-range-option={preset}>
            {label(preset)}
          </button>
        ))}
        <button
          ref={customButton}
          type="button"
          role="tab"
          aria-selected={choice === "custom"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
          onClick={() => { setDraft({ from, to }); onOpen(!open); }}
          className={`${segment(choice === "custom")} inline-flex items-center justify-center gap-1.5`}
          data-token-range-option="custom"
        >
          {phone ? null : <CalendarRange className="h-3.5 w-3.5" aria-hidden />}
          {customLabel}
        </button>
      </div>
      {open ? (
        <div
          id={dialogId}
          role="dialog"
          aria-label={pt("range.dialog")}
          className={phone ? "mt-2 rounded-[10px] border border-border bg-raised p-3" : `absolute top-full right-0 ${Z.popover} mt-1 w-[300px] rounded-[10px] border border-border bg-raised p-3 shadow-2`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onOpen(false);
              customButton.current?.focus();
            }
          }}
          data-token-range-popover=""
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-primary">{pt("range.title")}</span>
            <button type="button" onClick={() => { onOpen(false); customButton.current?.focus(); }} aria-label={pt("range.close")} className="flex h-7 w-7 items-center justify-center rounded-[6px] text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-11">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["from", "to"] as const).map((side) => (
              <label key={side} className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-secondary">
                {pt(side === "from" ? "range.from" : "range.to")}
                <input
                  ref={side === "from" ? fromInput : undefined}
                  type="date"
                  value={draft[side]}
                  min={addDays(NOW_DATE, -365)}
                  max={NOW_DATE}
                  onChange={(event) => apply({ ...draft, [side]: event.target.value })}
                  className="h-8 w-full min-w-0 rounded-[8px] border border-border bg-card px-2 text-[12.5px] font-normal tabular-nums text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
                  data-token-range-input={side}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted">{pt("range.hint")}</p>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Member chooser (header)                                                  */
/* ------------------------------------------------------------------------ */

/** The owner's member choice, drawn like the time page's member filter. */
export function MemberChooser({ selected, onSelect, totals, ctx, wide = false }: {
  selected: string | null;
  onSelect(member: string | null): void;
  totals: Map<string, number>;
  ctx: Ctx;
  wide?: boolean;
}) {
  const { pt, locale } = ctx;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  const label = selected === null ? pt("member.all") : entityName("member", selected, ctx);
  const all = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const options: Array<{ id: string | null; label: string; value: number }> = [
    { id: null, label: pt("member.all"), value: all },
    ...MEMBERS.map((member) => ({ id: member.id, label: `${entityName("member", member.id, ctx)}${member.owner ? ` · ${pt("member.owner")}` : ""}`, value: totals.get(member.id) ?? 0 })),
  ];
  return (
    <div ref={root} className={`relative shrink-0 ${wide ? "w-full" : ""}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-8 max-w-[220px] items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-border bg-card px-2.5 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${wide ? "h-11 w-full max-w-none" : ""}`}
        data-token-members=""
      >
        <Users className="h-3.5 w-3.5 text-muted" aria-hidden />
        <span className={`truncate ${wide ? "flex-1 text-left" : ""}`}>{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      </button>
      {open ? (
        <ul role="listbox" className={`absolute top-full ${Z.popover} mt-1 w-[280px] overflow-hidden rounded-[10px] border border-border bg-raised py-1 shadow-2 ${wide ? "left-0 right-0 w-auto" : "right-0"}`}>
          {options.map((option) => (
            <li
              key={option.id ?? "all"}
              role="option"
              aria-selected={option.id === selected}
              onClick={() => { setOpen(false); onSelect(option.id); }}
              className={`flex cursor-pointer items-center justify-between gap-3 border-l-2 px-3 py-1.5 text-[12.5px] hover:bg-accent-soft ${option.id === selected ? "border-accent" : "border-transparent"} ${wide ? "min-h-11" : ""}`}
            >
              <span className="truncate font-semibold text-primary">{option.label}</span>
              <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted">{compact(option.value, locale)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Card                                                                     */
/* ------------------------------------------------------------------------ */

export function Card({ children, className = "", style, testId }: { children: ReactNode; className?: string; style?: CSSProperties; testId?: string }) {
  return <section className={`rounded-[12px] border border-border bg-card shadow-1 ${className}`} style={style} data-token-card={testId}>{children}</section>;
}

/** «Кеш: 97 % вхідних» */
export function cacheText(counts: TokenCounts, ctx: Ctx): string {
  return ctx.pt("extra.cache", { share: percent(inputOf(counts) ? counts.cacheRead / inputOf(counts) : 0, ctx.locale) });
}
