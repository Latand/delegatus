"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";

import { modelDisplayName } from "@/lib/agent/models";
import { weekOfDay } from "@/lib/activity/range";
import type { ActivityTokensResponse, TokenDimension } from "@/lib/activity/tokenReport";
import type { TokenCounts } from "@/lib/activity/tokenUsage";
import type { Locale, MessageKey, TFunction } from "@/lib/i18n";

import { memberLabel } from "./ActivityMembers";
import type { TokenBy } from "./pageParams";
import { ENGINE_NAMES, intlLocale, projectName, roleName } from "./format";
import { Swatch, Tooltip, type TipAnchor } from "./marks";

/*
 * The pieces the Tokens tab draws with (docs/design/activity-token-usage.md
 * §9.1, §9.2): compact numbers with exact values in tooltips, the four kinds
 * as one meter, stacked columns per bucket, a ranked list and the coverage
 * dot with its short popover. Everything is drawn from one answer of
 * GET /api/activity/tokens.
 */

export type TokenKind = "cacheRead" | "input" | "cacheWrite" | "output";
export const TOKEN_KINDS: readonly TokenKind[] = ["cacheRead", "input", "cacheWrite", "output"];
export { TOKEN_BY, type TokenBy } from "./pageParams";
/** The dimensions only the owner (or a solo host's operator) may read. */
export const OWNER_BY: ReadonlySet<TokenBy> = new Set(["member", "account"]);
/** Named colours a chart draws; parts past them fold into «other». */
export const SERIES_COLOURS = 7;

export interface TokenCtx {
  answer: ActivityTokensResponse;
  locale: Locale;
  t: TFunction;
}

/* ------------------------------------------------------------------------ */
/* Numbers                                                                  */
/* ------------------------------------------------------------------------ */

export const tokenTotal = (counts: TokenCounts) => counts.input + counts.cacheRead + counts.cacheWrite + counts.output;
export const inputTotal = (counts: TokenCounts) => counts.input + counts.cacheRead + counts.cacheWrite;

/** «1,8 млрд», «512 млн», «36 тис.». */
export function compact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), { notation: "compact", maximumFractionDigits: value < 1e3 ? 0 : 1 }).format(Math.round(value));
}

export function exact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(Math.round(value));
}

export function percent(share: number, locale: Locale): string {
  const format = new Intl.NumberFormat(intlLocale(locale), { style: "percent", maximumFractionDigits: 0 });
  /* A share that is not zero never reads «0%», which says nothing was used. */
  return share > 0 && Math.round(share * 100) === 0 ? `<${format.format(0.01)}` : format.format(share);
}

/** «≈ $1 574», cents below ten dollars: the sign leads in both languages, as API price pages print it. */
export function money(value: number, locale: Locale): string {
  return `≈ $${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: value < 10 ? 2 : 0 }).format(value)}`;
}

/** «2,1 ГБ», «340 МБ». */
export function bytesText(bytes: number, locale: Locale, t: TFunction): string {
  const gb = bytes / 1e9;
  const format = (value: number) => new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(value);
  return gb >= 1 ? t("activity.tokens.gb", { value: format(gb) }) : t("activity.tokens.mb", { value: format(Math.max(0.1, bytes / 1e6)) });
}

/* ------------------------------------------------------------------------ */
/* Dates in the answer's zone                                               */
/* ------------------------------------------------------------------------ */

const NOON = 12 * 3_600_000;

function zoned(at: number, locale: Locale, tz: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: tz }).format(new Date(at));
}

/** The calendar date of a day bucket in its zone, `YYYY-MM-DD`. */
export function bucketDate(start: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(start + NOON));
}

/** «1–16 жовт.», «16 жовт.» for two `YYYY-MM-DD` dates. */
export function datesLabel(from: string, to: string, locale: Locale): string {
  const format = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", timeZone: "UTC" });
  const a = new Date(`${from}T12:00:00Z`);
  if (from === to) return format.format(a);
  const b = new Date(`${to}T12:00:00Z`);
  /* Across a year change a day and a month name would print both years in full: numbers keep the control one row. */
  if (from.slice(0, 4) !== to.slice(0, 4)) {
    return new Intl.DateTimeFormat(intlLocale(locale), { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" }).formatRange(a, b);
  }
  return format.formatRange(a, b);
}

/* ------------------------------------------------------------------------ */
/* Names and colours                                                        */
/* ------------------------------------------------------------------------ */

const KIND_KEYS: Record<TokenKind, MessageKey> = {
  cacheRead: "activity.tokens.kind.cacheRead",
  input: "activity.tokens.kind.input",
  cacheWrite: "activity.tokens.kind.cacheWrite",
  output: "activity.tokens.kind.output",
};
export const kindName = (kind: TokenKind, t: TFunction) => t(KIND_KEYS[kind]);

export const BY_KEYS: Record<TokenDimension, MessageKey> = {
  kind: "activity.tokens.by.kind",
  model: "activity.tokens.by.model",
  role: "activity.tokens.by.role",
  project: "activity.tokens.by.project",
  member: "activity.tokens.by.member",
  account: "activity.tokens.by.account",
  engine: "activity.tokens.by.engine",
};

/** `gpt-6.1-sol` → «GPT-6.1 Sol». */
function codexModelName(model: string): string {
  return model.replace(/^gpt-/i, "GPT-").replace(/-([a-z])([a-z]*)$/i, (_, first: string, rest: string) => ` ${first.toUpperCase()}${rest}`);
}

export function modelName(model: string, engine: string | undefined, t: TFunction): string {
  if (!model) return t("activity.tokens.model.unknown");
  if (engine === "codex" || /^gpt-/i.test(model)) return codexModelName(model);
  return modelDisplayName(engine ?? "claude", model);
}

/** A stored account is «engine:id»; one the account stores no longer list reads as its engine and id. */
function unlabelledAccount(key: string): string {
  const colon = key.indexOf(":");
  const engine = colon > 0 ? ENGINE_NAMES[key.slice(0, colon)] : undefined;
  return engine ? `${engine} · ${key.slice(colon + 1)}` : key;
}

/** A key of a dimension as the page names it. The answer carries project,
    member and account names for its list; roles and models are named here. */
export function entityName(dimension: TokenDimension, key: string, ctx: TokenCtx): string {
  const { answer, t } = ctx;
  if (key === "other") return t("activity.tokens.other");
  const listed = answer.params.list === dimension ? answer.list.find((row) => row.key === key)?.name ?? null : null;
  switch (dimension) {
    case "kind": return TOKEN_KINDS.includes(key as TokenKind) ? kindName(key as TokenKind, t) : t("activity.tokens.total");
    case "model": return modelName(key, answer.costBasis.find((row) => row.model === key)?.engine, t);
    case "role": return roleName(key || "none", t);
    case "project": {
      if (!key) return t("activity.tokens.project.none");
      const name = listed ?? (answer.scope?.project === key ? answer.scope.name : null);
      return projectName(key, name, t);
    }
    case "member": {
      if (!key) return t("activity.tokens.member.unattributed");
      const roster = answer.member.members.find((member) => member.id === key);
      return memberLabel({ id: key, name: roster?.name ?? listed }, t);
    }
    case "account": return key ? listed ?? unlabelledAccount(key) : t("activity.tokens.account.unknown");
    case "engine": return ENGINE_NAMES[key] ?? key;
  }
}

export const kindColor = (kind: TokenKind) => `var(--mark-kind-${TOKEN_KINDS.indexOf(kind) + 1})`;

/** The keys a chart names, in the order the answer ranks them: the first
    SERIES_COLOURS each take a colour, the rest fold into «other». The list
    and the chart read the same order, so a row and its column share one
    colour. */
export function namedKeys(ctx: TokenCtx): string[] {
  return ctx.answer.list.filter((row) => row.key !== "other").slice(0, SERIES_COLOURS).map((row) => row.key);
}

export function seriesColor(key: string, named: readonly string[]): string {
  const index = named.indexOf(key);
  return index >= 0 ? `var(--mark-series-${index + 1})` : "var(--mark-series-other)";
}

export function SeriesSwatch({ color, className = "" }: { color: string; className?: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ${className}`} style={{ background: color }} />;
}

/** An optional extra (§8) reads «Додатково» beside it, in words, never as a pill. */
export function Optional({ t }: { t: TFunction }) {
  return <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.04em] text-muted" data-token-optional="">{t("activity.tokens.optional")}</span>;
}

/* ------------------------------------------------------------------------ */
/* Measuring                                                                */
/* ------------------------------------------------------------------------ */

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
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

export type TokenTrust = "ok" | "lower" | "none";

/** How much of the asked range the counting reaches: every bucket, some, or none. */
export function rangeCounted(answer: ActivityTokensResponse): "all" | "some" | "none" {
  const counted = answer.series.filter((bucket) => bucket.counted).length;
  return counted === answer.series.length ? "all" : counted === 0 ? "none" : "some";
}

/** A range that starts before the first counted moment is a lower bound too. */
export function tokenTrust(answer: ActivityTokensResponse): TokenTrust {
  if (answer.coverage.countedFrom === null) return "none";
  return answer.coverage.complete && rangeCounted(answer) === "all" ? "ok" : "lower";
}

/** The words for the dot, its popover and the drawer: a lower bound names its cause. */
export function trustKey(answer: ActivityTokensResponse): MessageKey {
  const trust = tokenTrust(answer);
  if (trust === "ok") return "activity.tokens.coverage.ok";
  if (trust === "none") return "activity.tokens.coverage.none";
  return answer.coverage.complete ? "activity.tokens.coverage.partial" : "activity.tokens.coverage.lower";
}

/** The lines the coverage popover and the drawer both start with. */
export function coverageLines(ctx: TokenCtx): string[] {
  const { answer, locale, t } = ctx;
  const { coverage } = answer;
  return [
    coverage.countedFrom !== null ? t("activity.tokens.coverage.from", { date: zoned(coverage.countedFrom, locale, answer.params.tz, { day: "numeric", month: "long" }) }) : null,
    !coverage.complete && coverage.pendingBytes > 0 ? t("activity.tokens.coverage.pending", { value: bytesText(coverage.pendingBytes, locale, t) }) : null,
    t("activity.tokens.coverage.members"),
    t("activity.tokens.coverage.compaction"),
  ].filter((line): line is string => line !== null);
}

export function CoverageDot({ ctx }: { ctx: TokenCtx }) {
  const { t } = ctx;
  const trust = tokenTrust(ctx.answer);
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const id = useId();
  const show = (element: Element) => setAnchor(anchorOf(element));
  return (
    <>
      <button
        type="button"
        aria-label={`${t("activity.tokens.coverage.aria")}: ${t(trustKey(ctx.answer))}`}
        aria-describedby={anchor ? id : undefined}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => setAnchor(null)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setAnchor(null)}
        onClick={(event) => (anchor ? setAnchor(null) : show(event.currentTarget))}
        onKeyDown={(event) => { if (event.key === "Escape") setAnchor(null); }}
        className="relative inline-flex h-5 w-5 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-11"
        data-token-coverage={trust}
      >
        <span aria-hidden className={`h-2 w-2 rounded-full ${trust === "ok" ? "bg-success" : "bg-warning"}`} />
      </button>
      {anchor ? (
        <Tooltip anchor={anchor} side="below" id={id}>
          <div className="font-semibold text-primary">{t(trustKey(ctx.answer))}</div>
          <div className="mt-1 grid gap-0.5 text-secondary" data-token-coverage-lines="">
            {coverageLines(ctx).map((line) => <span key={line}>{line}</span>)}
          </div>
        </Tooltip>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* The four kinds                                                           */
/* ------------------------------------------------------------------------ */

/** Codex reports no cache writes: when every counted token is Codex's, its
    cache writes read «—», never 0. */
export function cacheWriteUnreported(ctx: TokenCtx, counts: TokenCounts): boolean {
  return counts.cacheWrite === 0 && ctx.answer.costBasis.some((row) => tokenTotal(row.counts) > 0)
    && ctx.answer.costBasis.every((row) => row.engine === "codex" || tokenTotal(row.counts) === 0);
}

export function kindValue(counts: TokenCounts, kind: TokenKind, ctx: TokenCtx): string {
  return kind === "cacheWrite" && cacheWriteUnreported(ctx, counts) ? "—" : compact(counts[kind], ctx.locale);
}

/** The kinds the meter's bar draws: cache reads are most of every total and
    would leave the other three as slivers, so they are stated on their own
    line and the bar splits the rest (§2). */
const REST_KINDS: readonly TokenKind[] = ["input", "cacheWrite", "output"];
/** Narrower than this a segment is a sliver; it is left out of the bar and
    keeps its printed value. */
const MIN_SEGMENT_PX = 6;

/** Cache reads on one line with their value, then one bar over the other
    three kinds with each kind's value printed beside its swatch. */
export function KindMeter({ counts, ctx, stacked = false }: { counts: TokenCounts; ctx: TokenCtx; stacked?: boolean }) {
  const { locale, t } = ctx;
  const total = tokenTotal(counts);
  const [box, width] = useWidth<HTMLDivElement>();
  const rest = REST_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const gaps = 2 * (REST_KINDS.length - 1);
  const drawn = REST_KINDS.filter((kind) => rest > 0 && (counts[kind] / rest) * (width - gaps) >= MIN_SEGMENT_PX);
  const drawnSum = drawn.reduce((sum, kind) => sum + counts[kind], 0);
  const title = (kind: TokenKind) => (kind === "cacheWrite" && cacheWriteUnreported(ctx, counts)
    ? t("activity.tokens.kind.notReported")
    : `${exact(counts[kind], locale)} · ${total ? percent(counts[kind] / total, locale) : "—"}`);
  return (
    <div data-token-meter="">
      <div className="flex items-baseline gap-x-1.5 text-[12px]" title={title("cacheRead")} data-token-kind="cacheRead">
        <span className="whitespace-nowrap text-secondary">{kindName("cacheRead", t)}</span>
        <span className="whitespace-nowrap font-semibold tabular-nums text-primary">{compact(counts.cacheRead, locale)}</span>
      </div>
      <div ref={box} className="mt-2 flex h-2 w-full gap-[2px] rounded-[3px] bg-sunken" aria-hidden data-token-meter-bar="">
        {drawn.map((kind, index) => (
          <span
            key={kind}
            className={`h-full ${index === 0 ? "rounded-l-[3px]" : ""} ${index === drawn.length - 1 ? "rounded-r-[3px]" : ""}`}
            style={{ flex: `${drawnSum ? counts[kind] / drawnSum : 0} 0 0`, background: kindColor(kind) }}
            data-token-segment={kind}
          />
        ))}
      </div>
      <ul className={`mt-2 text-[12px] ${stacked ? "grid gap-y-1" : "flex flex-wrap gap-x-4 gap-y-1"}`}>
        {REST_KINDS.map((kind) => (
          <li key={kind} className={`flex min-w-0 items-baseline gap-x-1.5 ${stacked ? "justify-between" : ""}`} title={title(kind)} data-token-kind={kind}>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-secondary">
              <SeriesSwatch color={drawn.includes(kind) ? kindColor(kind) : "transparent"} className={drawn.includes(kind) ? "" : "border border-border"} />
              {kindName(kind, t)}
            </span>
            <span className="whitespace-nowrap font-semibold tabular-nums text-primary">{kindValue(counts, kind, ctx)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Stacked columns                                                          */
/* ------------------------------------------------------------------------ */

export interface ChartBucket {
  start: number;
  end: number;
  counted: boolean;
  parts: Array<{ key: string; counts: TokenCounts }>;
}

/** The chart's columns: kinds split out of the one `all` part, other
    dimensions with every part past the named keys folded into «other». */
export function chartBuckets(series: ActivityTokensResponse["series"], by: TokenBy, named: readonly string[]): ChartBucket[] {
  return series.map((bucket) => {
    if (by === "kind") {
      const all = bucket.parts.find((part) => part.key === "all")?.counts;
      return { ...bucket, parts: all ? TOKEN_KINDS.map((kind) => ({ key: kind, counts: only(all, kind) })) : [] };
    }
    const parts: ChartBucket["parts"] = named.flatMap((key) => {
      const part = bucket.parts.find((entry) => entry.key === key);
      return part ? [part] : [];
    });
    const rest = bucket.parts.filter((part) => !named.includes(part.key));
    if (rest.length) {
      const counts = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 0 };
      for (const part of rest) for (const field of Object.keys(counts) as Array<keyof TokenCounts>) counts[field] += part.counts[field];
      parts.push({ key: "other", counts });
    }
    return { ...bucket, parts };
  });
}

function only(counts: TokenCounts, kind: TokenKind): TokenCounts {
  return { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 0, [kind]: counts[kind] };
}

/** Days folded into Monday weeks, for the phone above 31 days (§9.2). */
export function foldWeeks(buckets: readonly ChartBucket[], tz: string): ChartBucket[] {
  const out: ChartBucket[] = [];
  let key = "";
  for (const bucket of buckets) {
    const week = weekOfDay(bucketDate(bucket.start, tz));
    const last = out.at(-1);
    if (last && week === key) {
      last.end = bucket.end;
      last.counted ||= bucket.counted;
      for (const part of bucket.parts) {
        const into = last.parts.find((entry) => entry.key === part.key);
        if (!into) last.parts.push({ key: part.key, counts: { ...part.counts } });
        else for (const field of Object.keys(into.counts) as Array<keyof TokenCounts>) into.counts[field] += part.counts[field];
      }
    } else {
      key = week;
      out.push({ ...bucket, parts: bucket.parts.map((part) => ({ key: part.key, counts: { ...part.counts } })) });
    }
  }
  return out;
}

export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** Gridlines whose labels would read the same are not drawn: nothing counted keeps the zero line only. */
export function axisFractions(peak: number): readonly number[] {
  return peak === 0 ? [0] : niceMax(peak) < 4 ? [0, 1] : [0, 0.5, 1];
}

export function ColumnChart({ buckets, bucket, by, named, height, ctx }: {
  buckets: readonly ChartBucket[];
  bucket: "hour" | "day" | "week";
  by: TokenBy;
  named: readonly string[];
  height: number;
  ctx: TokenCtx;
}) {
  const { locale, t } = ctx;
  const tz = ctx.answer.params.tz;
  const [box, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ index: number; anchor: TipAnchor } | null>(null);
  const clip = useId().replace(/:/g, "");
  const left = 46;
  const bottom = 20;
  const top = 6;
  const innerW = Math.max(0, width - left - 4);
  const innerH = height - bottom - top;
  const totals = buckets.map((entry) => entry.parts.reduce((sum, part) => sum + tokenTotal(part.counts), 0));
  const peak = Math.max(0, ...totals);
  const max = niceMax(peak);
  const fractions = axisFractions(peak);
  const band = buckets.length ? innerW / buckets.length : 0;
  const barW = Math.max(3, Math.min(30, band * 0.64));
  const hour = bucket === "hour";
  const every = hour ? (band >= 22 ? 2 : band >= 11 ? 3 : 6) : band >= 30 ? 1 : band >= 16 ? 2 : band >= 9 ? 4 : 7;
  const y = (value: number) => top + innerH - (value / max) * innerH;
  const colour = (key: string) => (by === "kind" ? kindColor(key as TokenKind) : seriesColor(key, named));
  const hovered = tip ? buckets[tip.index] : null;
  /* Days that are not counted yet are one hatched band over the whole height
     of the plot, so no edge of it lines up with a value on the axis. */
  const uncountedRuns: Array<{ from: number; to: number }> = [];
  buckets.forEach((entry, index) => {
    if (entry.counted) return;
    const last = uncountedRuns.at(-1);
    if (last && last.to === index - 1) last.to = index;
    else uncountedRuns.push({ from: index, to: index });
  });

  /* A tick names its month where the month changes since the last tick drawn. */
  const ticks: Array<{ index: number; text: string }> = [];
  let lastMonth = -1;
  buckets.forEach((entry, index) => {
    if (index % every !== 0) return;
    if (hour) { ticks.push({ index, text: zoned(entry.start, locale, tz, { hour: "2-digit", hourCycle: "h23" }) }); return; }
    const date = bucketDate(entry.start, tz);
    const month = Number(date.slice(5, 7));
    ticks.push({ index, text: month !== lastMonth ? zoned(entry.start + NOON, locale, tz, { day: "numeric", month: "short" }) : String(Number(date.slice(8))) });
    lastMonth = month;
  });
  const bucketName = (entry: ChartBucket) => {
    if (hour) return `${zoned(entry.start, locale, tz, { day: "numeric", month: "short" })}, ${zoned(entry.start, locale, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
    const from = bucketDate(entry.start, tz);
    if (bucket === "week") return datesLabel(from, bucketDate(entry.end - NOON * 2, tz), locale);
    return zoned(entry.start + NOON, locale, tz, { weekday: "short", day: "numeric", month: "long" });
  };

  return (
    <div ref={box} className="relative w-full" style={{ height }} data-token-chart={by}>
      {width > 0 ? (
        <svg width={width} height={height} role="group" aria-label={t("activity.tokens.chart.aria", { bucket: t(hour ? "activity.tokens.chart.hour" : bucket === "week" ? "activity.tokens.chart.week" : "activity.tokens.chart.day") })} className="block">
          {fractions.map((fraction) => (
            <g key={fraction} aria-hidden>
              <line x1={left} x2={width} y1={Math.round(y(max * fraction)) + 0.5} y2={Math.round(y(max * fraction)) + 0.5} stroke="var(--color-border)" strokeWidth={1} />
              <text x={left - 6} y={y(max * fraction) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-muted)" className="tabular-nums" data-token-scale-top={fraction === 1 ? "" : undefined}>{fraction === 0 ? "0" : compact(max * fraction, locale)}</text>
            </g>
          ))}
          {uncountedRuns.map((run) => (
            <rect
              key={run.from}
              x={left + run.from * band}
              y={top}
              width={(run.to - run.from + 1) * band}
              height={innerH}
              fill="url(#activity-hatch-unread)"
              opacity={0.7}
              aria-hidden
              data-token-unread={run.to - run.from + 1}
            />
          ))}
          {buckets.map((entry, index) => {
            const x = left + index * band + (band - barW) / 2;
            if (!entry.counted) return null;
            let base = top + innerH;
            const columnTop = y(totals[index]!);
            return (
              <g key={entry.start} opacity={tip && tip.index !== index ? 0.55 : 1} aria-hidden>
                <clipPath id={`${clip}-${index}`}>
                  <rect x={x} y={columnTop} width={barW} height={Math.max(0, top + innerH - columnTop)} rx={Math.min(4, barW / 2)} />
                  <rect x={x} y={Math.max(columnTop, top + innerH - 4)} width={barW} height={Math.min(4, top + innerH - columnTop)} />
                </clipPath>
                <g clipPath={`url(#${clip}-${index})`}>
                  {entry.parts.map((part) => {
                    const h = (tokenTotal(part.counts) / max) * innerH;
                    base -= h;
                    return h > 0 ? <rect key={part.key} x={x} y={base} width={barW} height={h} fill={colour(part.key)} stroke="var(--color-card)" strokeWidth={h > 3 ? 1 : 0} /> : null;
                  })}
                </g>
              </g>
            );
          })}
          {ticks.map(({ index, text }) => (
            <text key={`l${index}`} x={Math.max(left + index * band + band / 2, left + 14)} y={height - 5} textAnchor="middle" fontSize={10} fill="var(--color-muted)" className="tabular-nums" aria-hidden data-token-tick="">
              {text}
            </text>
          ))}
          {buckets.map((entry, index) => (
            <rect
              key={`h${entry.start}`}
              x={left + index * band}
              y={top}
              width={band}
              height={innerH}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${bucketName(entry)}: ${entry.counted ? exact(totals[index]!, locale) : t("activity.tokens.chart.notRead")}`}
              onMouseEnter={(event) => setTip({ index, anchor: anchorOf(event.currentTarget) })}
              onFocus={(event) => setTip({ index, anchor: anchorOf(event.currentTarget) })}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
              className="outline-none focus-visible:stroke-[var(--border-strong)]"
            />
          ))}
        </svg>
      ) : null}
      {tip && hovered ? (
        <Tooltip anchor={tip.anchor} side="above">
          <div className="mb-1 font-semibold text-primary">{bucketName(hovered)}</div>
          {hovered.counted ? (
            <div className="grid grid-cols-[10px_auto_1fr] items-center gap-x-2 gap-y-px">
              {[...hovered.parts].reverse().filter((part) => tokenTotal(part.counts) > 0).map((part) => (
                <ChartTipRow key={part.key} color={colour(part.key)} value={compact(tokenTotal(part.counts), locale)} label={entityName(by, part.key, ctx)} />
              ))}
              <span aria-hidden />
              <span className="border-t border-border pt-0.5 text-right font-semibold tabular-nums text-primary">{exact(totals[tip.index]!, locale)}</span>
              <span className="border-t border-border pt-0.5 text-secondary">{t("activity.tokens.total")}</span>
            </div>
          ) : <div className="text-secondary">{t("activity.tokens.chart.notRead")}</div>}
        </Tooltip>
      ) : null}
    </div>
  );
}

function ChartTipRow({ color, value, label }: { color: string; value: string; label: string }) {
  return (
    <>
      <SeriesSwatch color={color} />
      <span className="whitespace-nowrap text-right font-semibold tabular-nums text-primary">{value}</span>
      <span className="whitespace-nowrap text-secondary">{label}</span>
    </>
  );
}

/** The chart's legend: identity is never colour alone, and the hatch is named. */
export function Legend({ keys, by, named, uncounted = false, ctx }: { keys: readonly string[]; by: TokenBy; named: readonly string[]; uncounted?: boolean; ctx: TokenCtx }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-secondary" data-token-legend="">
      {keys.map((key) => (
        <li key={key} className="flex items-center gap-1.5 whitespace-nowrap">
          <SeriesSwatch color={by === "kind" ? kindColor(key as TokenKind) : seriesColor(key, named)} />
          {entityName(by, key, ctx)}
        </li>
      ))}
      {uncounted ? (
        <li className="flex items-center gap-1.5 whitespace-nowrap" data-token-legend-uncounted="">
          <Swatch kind="unread" />
          {ctx.t("activity.tokens.chart.legendUncounted")}
        </li>
      ) : null}
    </ul>
  );
}

/* ------------------------------------------------------------------------ */
/* Ranked list                                                              */
/* ------------------------------------------------------------------------ */

export interface ListEntry {
  key: string;
  counts: TokenCounts;
  /** The extra E1 figure for the row, or undefined where the list prints none. */
  cost?: string;
}

/** Name, total, a thin one-colour bar of the row's size and its share. A row
    click filters the page; «other» is not a key and cannot be chosen. */
export function RankedList({ rows, by, named, total, selected, onSelect, ctx }: {
  rows: readonly ListEntry[];
  by: TokenBy;
  named: readonly string[];
  total: number;
  selected: string | null;
  onSelect(key: string): void;
  ctx: TokenCtx;
}) {
  const { locale } = ctx;
  const max = Math.max(0, ...rows.map((row) => tokenTotal(row.counts)));
  const color = (key: string) => (by === "kind" ? kindColor(key as TokenKind) : seriesColor(key, named));
  return (
    <ul className="flex flex-col" data-token-list={by}>
      {rows.map((row) => {
        const value = tokenTotal(row.counts);
        const name = entityName(by, row.key, ctx);
        const clickable = row.key !== "other" && by !== "kind";
        const pressed = selected === row.key;
        const body = (
          <>
            <SeriesSwatch color={color(row.key)} className="mt-[3px] self-start" />
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] font-semibold text-primary" title={name}>{name}</span>
                <span className="flex shrink-0 items-baseline gap-2 text-[12px] tabular-nums">
                  {row.cost !== undefined ? <span className="text-muted" data-token-row-cost="">{row.cost}</span> : null}
                  <span className="font-semibold text-primary" title={exact(value, locale)} data-token-row-value={value}>{compact(value, locale)}</span>
                  <span className="w-[38px] text-right text-muted" data-token-row-share="">{total ? percent(value / total, locale) : "—"}</span>
                </span>
              </div>
              {by === "kind" ? null : (
                <div className="mt-1.5 w-full" aria-hidden>
                  <div className="h-1 rounded-[2px]" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%`, background: color(row.key) }} data-token-rowbar="" />
                </div>
              )}
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
                className={`grid min-h-11 w-full grid-cols-[10px_minmax(0,1fr)] gap-x-2.5 px-[18px] py-2.5 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 max-sm:px-3 ${pressed ? "bg-sunken shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
              >
                {body}
              </button>
            ) : <div className="grid min-h-11 grid-cols-[10px_minmax(0,1fr)] gap-x-2.5 px-[18px] py-2.5 max-sm:px-3">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}
