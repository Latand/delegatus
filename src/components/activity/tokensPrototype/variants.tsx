"use client";

import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { Segmented } from "../ActivityDashboard";
import { roleName } from "../format";
import { Items } from "../marks";
import type { ProtoKey } from "./copy";
import {
  ACCOUNTS, addDays, cacheShare, dimensionOrder, timeFor, costOf, COUNTED_FROM, daysBetween, dayMs, FIRST_DATE, fixtureRows, laneRows, matches, NOW_DATE, PROJECTS,
  rowsIn, TOKEN_KINDS, tokensAnswer, topConversations, totalOf, windowPeaks, zeroCounts, addCounts,
  type ListDimension, type ListRow, type TokenCounts, type TokenKind, type TokenDimension, type TokensAnswer,
} from "./fixture";
import {
  Card, compact, CoverageDot, ColumnChart, dateText, daysPhrase, entityName, exact, KindBar, kindColor, KindMeter, Legend, money, Optional, percent,
  rangeLabel, RankedList, seriesColor, SeriesSwatch, Sparkline, useWidth, type Ctx,
} from "./parts";

export interface VariantProps {
  answer: TokensAnswer;
  ctx: Ctx;
  desktop: boolean;
  by: TokenDimension;
  onBy(by: TokenDimension): void;
  filters: Partial<Record<ListDimension, string>>;
  project: string | null;
  onFilter(dimension: ListDimension, key: string): void;
  otherCount: number;
  onRange?(from: string, to: string): void;
}

const BY_OPTIONS: ReadonlyArray<{ value: TokenDimension; label: ProtoKey }> = [
  { value: "kind", label: "by.kind" },
  { value: "model", label: "by.model" },
  { value: "role", label: "by.role" },
  { value: "project", label: "by.project" },
  { value: "member", label: "by.member" },
  { value: "account", label: "by.account" },
];

const selectedOf = (props: VariantProps, dimension: TokenDimension): string | null => {
  if (dimension === "kind") return null;
  if (dimension === "project") return props.project;
  return props.filters[dimension] ?? null;
};

function kindRows(counts: TokenCounts): ListRow[] {
  return TOKEN_KINDS.map((kind) => {
    const part = zeroCounts();
    part[kind] = counts[kind];
    return { key: kind, counts: part, trend: [] };
  });
}

/** The keys a stacked chart draws, in their fixed order. */
function stackKeys(answer: TokensAnswer): string[] {
  const seen = new Set<string>();
  for (const bucket of answer.series) for (const part of bucket.parts) if (totalOf(part.counts) > 0) seen.add(part.key);
  const order = dimensionOrder(answer.query.stack);
  return [...seen].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
}

function spanDays(answer: TokensAnswer): number {
  return daysBetween(answer.query.from, answer.query.to) + 1;
}

function changeText(answer: TokensAnswer, ctx: Ctx): string {
  const now = totalOf(answer.totals);
  const before = totalOf(answer.previous.totals);
  const change = before ? now / before - 1 : 0;
  return ctx.pt("extra.change", { sign: change >= 0 ? "+" : "−", share: percent(Math.abs(change), ctx.locale), days: daysPhrase(spanDays(answer), ctx.locale) });
}

/** The hero figure: «5 млрд токенів» with its coverage dot. */
function Hero({ answer, ctx, size = 44 }: { answer: TokensAnswer; ctx: Ctx; size?: number }) {
  const { pt, locale } = ctx;
  return (
    <div>
      <div className="flex h-5 items-center gap-1 text-[12px] font-semibold text-secondary">
        {pt("figure")}
        <CoverageDot complete={answer.coverage.complete} pendingGb={answer.coverage.pendingGb} ctx={ctx} />
      </div>
      <div className="mt-1 flex items-baseline gap-2 whitespace-nowrap">
        <span className="font-semibold leading-none tracking-[-0.02em] text-primary" style={{ fontSize: size }} title={exact(totalOf(answer.totals), locale)} data-token-hero="">
          {compact(totalOf(answer.totals), locale)}
        </span>
        <span className="text-[13px] font-medium text-muted">{pt("tokens")}</span>
      </div>
    </div>
  );
}

function ByControl({ props, options = BY_OPTIONS }: { props: VariantProps; options?: ReadonlyArray<{ value: TokenDimension; label: ProtoKey }> }) {
  const { ctx, by, onBy, desktop } = props;
  return (
    <div className={desktop ? "" : "-mx-3 overflow-x-auto px-3 [scrollbar-width:none]"} data-token-by="">
      <div className={desktop ? "" : "w-max min-w-full"}>
        <Segmented label={ctx.pt("by.title")} value={by} onChange={onBy} options={options.map((option) => ({ value: option.value, label: ctx.pt(option.label) }))} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Variant 1: a separate Tokens tab, one figure and one chart               */
/* ------------------------------------------------------------------------ */

export function Variant1(props: VariantProps) {
  const { answer, ctx, desktop, by, otherCount } = props;
  const { pt } = ctx;
  const rows = by === "kind" ? kindRows(answer.totals) : answer.list;
  const listDimension: TokenDimension = by;
  const total = totalOf(answer.totals);
  const keys = stackKeys(answer);

  const figure = (
    <>
      <Hero answer={answer} ctx={ctx} size={desktop ? 44 : 36} />
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-secondary" data-token-extras="">
        <span className="whitespace-nowrap"><Optional ctx={ctx} />{pt("extra.cache", { share: percent(cacheShare(answer.totals), ctx.locale) })}</span>
        <span className="whitespace-nowrap"><Optional ctx={ctx} />{changeText(answer, ctx)}</span>
      </div>
      <div className="mt-4"><KindMeter counts={answer.totals} ctx={ctx} compactLabels={!desktop} /></div>
    </>
  );
  const chart = (
    <div className="mt-[18px] border-t border-border pt-3">
      <div className="mb-2"><Legend dimension={by} keys={keys} ctx={ctx} otherCount={otherCount} /></div>
      <ColumnChart series={answer.series} dimension={by} height={desktop ? 280 : 200} ctx={ctx} bucket={answer.bucket} otherCount={otherCount} />
    </div>
  );
  const list = (
    <RankedList rows={rows} dimension={listDimension} total={total} selected={selectedOf(props, listDimension)} onSelect={(key) => by !== "kind" && props.onFilter(by as ListDimension, key)} ctx={ctx} otherCount={otherCount} />
  );

  if (desktop) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_420px] items-start gap-4">
        <Card className="px-[22px] pb-3.5 pt-5" testId="main">{figure}{chart}</Card>
        <Card className="overflow-hidden" testId="breakdown">
          <div className="px-[18px] pb-3 pt-4">
            <div className="mb-2 text-[12px] font-semibold text-secondary">{pt("by.title")}</div>
            <ByControl props={props} />
          </div>
          <div className="border-t border-border">{list}</div>
        </Card>
      </div>
    );
  }
  return (
    <>
      <Card className="px-4 pb-3 pt-4" testId="main">{figure}{chart}</Card>
      <div className="text-[12px] font-semibold text-secondary">{pt("by.title")}</div>
      <ByControl props={props} />
      <Card className="overflow-hidden" testId="breakdown">{list}</Card>
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Variant 2: tokens inside the Activity page                               */
/* ------------------------------------------------------------------------ */

function TimeAndTokensChart({ answer, ctx, height }: { answer: TokensAnswer; ctx: Ctx; height: number }) {
  const { locale, pt } = ctx;
  const [box, width] = useWidth<HTMLDivElement>();
  const days = answer.time.days;
  const tokenTotals = answer.series.map((bucket) => bucket.parts.reduce((sum, part) => sum + totalOf(part.counts), 0));
  const left = 46;
  const topH = height - 106;
  const tokenTop = topH + 46;
  const tokenH = 44;
  const innerW = Math.max(0, width - left - 4);
  const band = days.length ? innerW / days.length : 0;
  const barW = Math.max(2, Math.min(11, band * 0.3));
  const hoursMax = Math.max(1, ...days.flatMap((day) => [day.humanHours, day.agentHours]));
  const niceHours = Math.ceil(hoursMax / 10) * 10;
  const tokenMax = Math.max(1, ...tokenTotals);
  const yH = (hours: number) => 6 + (topH - 6) * (1 - hours / niceHours);
  return (
    <div ref={box} style={{ height }} className="w-full" data-token-chart="time">
      {width > 0 ? (
        <svg width={width} height={height} className="block" role="img" aria-label={pt("time.tokensRow")}>
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line x1={left} x2={width} y1={yH(niceHours * fraction)} y2={yH(niceHours * fraction)} stroke="var(--color-border)" shapeRendering="crispEdges" />
              <text x={left - 6} y={yH(niceHours * fraction) + 3.5} fontSize={10} textAnchor="end" fill="var(--color-muted)">{fraction === 0 ? "0" : pt("time.hours", { value: niceHours * fraction })}</text>
            </g>
          ))}
          {days.map((day, index) => {
            const x = left + index * band + band / 2;
            return (
              <g key={day.date}>
                {day.humanHours > 0 ? <rect x={x - barW - 1} y={yH(day.humanHours)} width={barW} height={topH - yH(day.humanHours)} rx={2} fill="var(--mark-you)" /> : null}
                {day.agentHours > 0 ? <rect x={x + 1} y={yH(day.agentHours)} width={barW} height={topH - yH(day.agentHours)} rx={2} fill="var(--mark-supervised)" /> : null}
                <text x={x} y={topH + 14} fontSize={10} textAnchor="middle" fill="var(--color-muted)">{index === 0 || new Date(dayMs(day.date)).getUTCDate() === 1 ? dateText(day.date, locale, { day: "numeric", month: "short" }) : new Date(dayMs(day.date)).getUTCDate()}</text>
              </g>
            );
          })}
          <text x={left} y={tokenTop - 10} fontSize={10.5} fontWeight={600} fill="var(--color-secondary)">{pt("time.tokensRow")}</text>
          <text x={left - 6} y={tokenTop + 8} fontSize={10} textAnchor="end" fill="var(--color-muted)">{compact(tokenMax, locale)}</text>
          <line x1={left} x2={width} y1={tokenTop + tokenH} y2={tokenTop + tokenH} stroke="var(--color-border)" shapeRendering="crispEdges" />
          {answer.series.map((bucket, index) => {
            const x = left + index * band + band / 2 - barW;
            let base = tokenTop + tokenH;
            return (
              <g key={bucket.start}>
                {bucket.parts.map((part) => {
                  const h = (totalOf(part.counts) / tokenMax) * tokenH;
                  base -= h;
                  return h > 0 ? <rect key={part.key} x={x} y={base} width={barW * 2} height={h} fill={kindColor(part.key as TokenKind)} /> : null;
                })}
              </g>
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}

function projectTotals(answer: TokensAnswer, filters: VariantProps["filters"]) {
  const out = new Map<string, { counts: TokenCounts; cost: number }>();
  for (const row of rowsIn(answer.query.from, answer.query.to, { project: null, filters })) {
    const key = row.project ?? "";
    const entry = out.get(key) ?? { counts: zeroCounts(), cost: 0 };
    addCounts(entry.counts, row.counts);
    entry.cost += costOf(row.model, row.counts);
    out.set(key, entry);
  }
  return out;
}

function costTotal(answer: TokensAnswer): number {
  return rowsIn(answer.query.from, answer.query.to, answer.query).reduce((sum, row) => sum + costOf(row.model, row.counts), 0);
}

function splitBy(answer: TokensAnswer, project: string, dimension: "role" | "model"): Array<[string, number]> {
  const out = new Map<string, number>();
  for (const row of rowsIn(answer.query.from, answer.query.to, { project, filters: answer.query.filters })) {
    const key = dimension === "role" ? row.role : row.model;
    out.set(key, (out.get(key) ?? 0) + totalOf(row.counts));
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

export function Variant2(props: VariantProps) {
  const { answer: chosen, ctx, desktop, project, filters } = props;
  const { pt, locale } = ctx;
  /* The token row under the day chart always stacks by kind. */
  const answer = useMemo(() => (chosen.query.stack === "kind" ? chosen : tokensAnswer({ ...chosen.query, stack: "kind" })), [chosen]);
  const cost = costTotal(answer);
  const perProject = projectTotals(answer, filters);
  const ranked = PROJECTS.filter((entry) => (perProject.get(entry.key ?? "") ? totalOf(perProject.get(entry.key ?? "")!.counts) : 0) > 0)
    .sort((a, b) => totalOf(perProject.get(b.key ?? "")!.counts) - totalOf(perProject.get(a.key ?? "")!.counts));
  const hoursOf = (key: string | null) => {
    const time = timeFor(answer.query.from, answer.query.to, { project: key }, filters);
    return { human: time.humanHours, agents: Math.round(time.agentHours) };
  };
  const tokensFigure = (
    <div data-token-figure="tokens">
      <Hero answer={answer} ctx={ctx} size={desktop ? 32 : 26} />
      <div className="mt-2 text-[12px] text-secondary"><Optional ctx={ctx} />{pt("extra.cost", { value: money(cost, locale) })}</div>
      <div className="mt-0.5 text-[11px] text-muted">{pt("extra.costNote")}</div>
    </div>
  );
  const timeFigure = (key: "you" | "agents") => (
    <div data-token-figure={key}>
      <div className="flex h-5 items-center gap-[7px] text-[12px] font-semibold text-secondary">
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: key === "you" ? "var(--mark-you)" : "var(--mark-supervised)" }} />
        {pt(key === "you" ? "time.you" : "time.agents")}
      </div>
      <div className="mt-1 flex items-baseline gap-2 whitespace-nowrap">
        <span className={`font-semibold leading-none tracking-[-0.02em] text-primary ${key === "you" ? (desktop ? "text-[44px]" : "text-[26px]") : desktop ? "text-[32px]" : "text-[26px]"}`}>
          {key === "agents" ? <span className="mr-1 align-[0.18em] text-[0.62em] font-medium text-muted">≈</span> : null}
          {pt("time.hours", { value: (key === "you" ? answer.time.humanHours : Math.round(answer.time.agentHours)).toLocaleString(locale === "uk" ? "uk-UA" : "en-GB") })}
        </span>
      </div>
      <div className="mt-2 text-[12px] text-muted">{pt(key === "you" ? "time.reported" : "time.agentNote")}</div>
    </div>
  );

  const projectRows = (
    <ul data-token-projects="">
      {ranked.map((entry) => {
        const key = entry.key ?? "";
        const data = perProject.get(key)!;
        const hours = hoursOf(entry.key);
        const open = project !== null && project === entry.key;
        return (
          <li key={key} className="border-t border-border first:border-t-0" data-token-project={key}>
            <button
              type="button"
              aria-pressed={entry.key ? open : undefined}
              onClick={() => entry.key && props.onFilter("project", entry.key)}
              className={`grid w-full grid-cols-[minmax(0,1fr)_56px_64px_68px] items-baseline gap-x-2 px-[18px] py-2.5 text-left text-[12px] tabular-nums hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 max-sm:px-3 ${open ? "bg-sunken shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
            >
              <span className="truncate text-[13px] font-semibold text-primary">{entityName("project", key, ctx)}</span>
              <span className="text-right text-primary">{hours.human ? pt("time.hours", { value: hours.human }) : "–"}</span>
              <span className="text-right text-primary">≈ {pt("time.hours", { value: hours.agents })}</span>
              <span className="text-right font-semibold text-primary" title={exact(totalOf(data.counts), locale)}>{compact(totalOf(data.counts), locale)}</span>
            </button>
            {open && entry.key ? (
              <div className="grid gap-[5px] bg-sunken px-[18px] pb-3 pt-0.5 text-[12px] leading-[1.45] text-muted max-sm:px-3" data-token-project-detail="">
                <DetailLine label={pt("by.role")}><Items items={splitBy(answer, entry.key, "role").slice(0, 5).map(([role, value]) => <>{roleName(role, ctx.t)} <b className="font-semibold tabular-nums text-primary">{compact(value, locale)}</b></>)} /></DetailLine>
                <DetailLine label={pt("by.model")}><Items items={splitBy(answer, entry.key, "model").slice(0, 5).map(([model, value]) => <>{entityName("model", model, ctx)} <b className="font-semibold tabular-nums text-primary">{compact(value, locale)}</b></>)} /></DetailLine>
                <DetailLine label=""><span><Optional ctx={ctx} />{pt("extra.cost", { value: money(data.cost, locale) })}</span></DetailLine>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
  const projectHead = (
    <div className="grid grid-cols-[minmax(0,1fr)_56px_64px_68px] gap-x-2 px-[18px] pb-2 pt-4 text-[11px] font-semibold text-muted max-sm:px-3">
      <span className="text-[12px] text-secondary">{ctx.t("activity.view.projects")}</span>
      <span className="text-right">{pt("time.you")}</span>
      <span className="text-right">{pt("time.agents")}</span>
      <span className="text-right">{pt("figure")}</span>
    </div>
  );

  if (desktop) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_420px] items-start gap-4">
        <Card className="px-[22px] pb-3.5 pt-5" testId="main">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.1fr)] gap-6">
            {timeFigure("you")}
            {timeFigure("agents")}
            {tokensFigure}
          </div>
          <div className="mt-[18px] border-t border-border pt-3">
            <div className="mb-2"><Legend dimension="kind" keys={[...TOKEN_KINDS]} ctx={ctx} /></div>
            <TimeAndTokensChart answer={answer} ctx={ctx} height={300} />
          </div>
        </Card>
        <Card className="overflow-hidden" testId="projects">
          {projectHead}
          <div className="border-t border-border">{projectRows}</div>
          <div className="border-t border-border px-[18px] py-2.5 text-[11.5px] text-muted">{pt("time.drawerHint")}</div>
        </Card>
      </div>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Card className="px-4 py-3">{timeFigure("you")}</Card>
        <Card className="px-4 py-3">{timeFigure("agents")}</Card>
        <Card className="col-span-2 px-4 py-3">
          {tokensFigure}
          <div className="mt-3"><KindMeter counts={answer.totals} ctx={ctx} compactLabels /></div>
        </Card>
      </div>
      <Card className="px-3 pb-2 pt-3" testId="days">
        <div className="mb-2"><Legend dimension="kind" keys={[...TOKEN_KINDS]} ctx={ctx} /></div>
        <TimeAndTokensChart answer={answer} ctx={ctx} height={250} />
      </Card>
      <Card className="overflow-hidden" testId="projects">
        {projectHead}
        <div className="border-t border-border">{projectRows}</div>
      </Card>
    </>
  );
}

function DetailLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2">
      <b className="font-semibold text-secondary">{label}</b>
      <span>{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Variant 3: a table for analysis                                          */
/* ------------------------------------------------------------------------ */

const ROW_OPTIONS: ReadonlyArray<{ value: TokenDimension; label: ProtoKey }> = [
  { value: "model", label: "rows.model" },
  { value: "role", label: "rows.role" },
  { value: "project", label: "rows.project" },
  { value: "member", label: "rows.member" },
  { value: "account", label: "rows.account" },
];

/** The whole history as one short area, the chosen range selected over it;
    a drag across it chooses a new range. */
function OverviewBrush({ answer, ctx, onRange, interactive }: { answer: TokensAnswer; ctx: Ctx; onRange?(from: string, to: string): void; interactive: boolean }) {
  const { locale, pt } = ctx;
  const [box, width] = useWidth<HTMLDivElement>();
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const days = useMemo(() => {
    const out: Array<{ date: string; total: number }> = [];
    const rows = fixtureRows().filter((row) => matches(row, answer.query));
    for (let date = FIRST_DATE; date <= NOW_DATE; date = addDays(date, 1)) out.push({ date, total: rows.filter((row) => row.date === date).reduce((sum, row) => sum + totalOf(row.counts), 0) });
    return out;
  }, [answer.query]);
  const height = 120;
  const left = 8;
  const innerW = Math.max(0, width - left * 2);
  const step = days.length > 1 ? innerW / (days.length - 1) : innerW;
  const max = Math.max(1, ...days.map((day) => day.total));
  const x = (index: number) => left + index * step;
  const y = (value: number) => 10 + (height - 34) * (1 - value / max);
  const indexOf = (date: string) => Math.max(0, Math.min(days.length - 1, daysBetween(FIRST_DATE, date)));
  const from = drag ? Math.min(drag.a, drag.b) : indexOf(answer.query.from);
  const to = drag ? Math.max(drag.a, drag.b) : indexOf(answer.query.to);
  const counted = indexOf(COUNTED_FROM);
  const area = `M${x(counted)},${y(0)} ` + days.slice(counted).map((day, index) => `L${x(index + counted)},${y(day.total)}`).join(" ") + ` L${x(days.length - 1)},${y(0)} Z`;
  const at = (clientX: number) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(days.length - 1, Math.round((clientX - rect.left - left) / (step || 1))));
  };
  return (
    <div ref={box} className="w-full" data-token-brush="">
      {width > 0 ? (
        <svg
          ref={svg}
          width={width}
          height={height}
          className={`block touch-none ${interactive ? "cursor-ew-resize" : ""}`}
          role="img"
          aria-label={pt("brush.aria")}
          onPointerDown={interactive ? (event) => { event.currentTarget.setPointerCapture(event.pointerId); const index = at(event.clientX); setDrag({ a: index, b: index }); } : undefined}
          onPointerMove={interactive ? (event) => { if (drag) setDrag({ ...drag, b: at(event.clientX) }); } : undefined}
          onPointerUp={interactive ? () => { if (drag && onRange) onRange(days[Math.min(drag.a, drag.b)]!.date, days[Math.max(drag.a, drag.b)]!.date); setDrag(null); } : undefined}
        >
          <rect x={x(0)} y={y(max) - 2} width={Math.max(0, x(counted) - x(0))} height={y(0) - y(max) + 2} fill="url(#activity-hatch-unread)" />
          <path d={area} fill="var(--mark-series-1)" fillOpacity={0.18} stroke="none" />
          <path d={days.slice(counted).map((day, index) => `${index ? "L" : "M"}${x(index + counted)},${y(day.total)}`).join(" ")} fill="none" stroke="var(--mark-series-1)" strokeWidth={2} strokeLinejoin="round" />
          <line x1={left} x2={width - left} y1={y(0)} y2={y(0)} stroke="var(--color-strong)" shapeRendering="crispEdges" />
          <rect x={x(from) - step / 2} y={6} width={Math.max(step, x(to) - x(from) + step)} height={y(0) - 6} fill="var(--color-accent)" fillOpacity={0.1} stroke="var(--color-accent)" strokeOpacity={0.55} rx={4} data-token-brush-selection="" />
          {interactive ? [from, to].map((index, side) => (
            <rect key={side} x={x(index) + (side ? step / 2 : -step / 2) - 3} y={y(0) / 2 - 10} width={6} height={20} rx={3} fill="var(--color-card)" stroke="var(--color-accent)" strokeWidth={1.5} />
          )) : null}
          {days.map((day, index) => {
            const date = new Date(dayMs(day.date)).getUTCDate();
            return date === 1 || index === 0 || date === 15 ? (
              <text key={day.date} x={x(index)} y={height - 6} fontSize={10} textAnchor={index === 0 ? "start" : "middle"} fill="var(--color-muted)">{dateText(day.date, locale, { day: "numeric", month: "short" })}</text>
            ) : null;
          })}
        </svg>
      ) : null}
    </div>
  );
}

type SortKey = "name" | "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning" | "requests" | "cacheShare" | "cost";

export function Variant3(props: VariantProps) {
  const { answer, ctx, desktop, otherCount } = props;
  const { pt, locale } = ctx;
  const dimension: ListDimension = props.by === "kind" ? "model" : props.by as ListDimension;
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cacheRead", desc: true });
  const costs = useMemo(() => {
    const out = new Map<string, number>();
    for (const row of rowsIn(answer.query.from, answer.query.to, answer.query)) {
      const key = dimension === "model" ? row.model : dimension === "role" ? row.role : dimension === "project" ? row.project ?? "" : dimension === "member" ? row.member : dimension === "account" ? row.account : row.engine;
      out.set(key, (out.get(key) ?? 0) + costOf(row.model, row.counts));
    }
    return out;
  }, [answer.query, dimension]);
  const costOfRow = (row: ListRow) => (row.key === "other" ? 0 : costs.get(row.key) ?? 0);
  const value = (row: ListRow, key: SortKey): number | string => {
    switch (key) {
      case "name": return entityName(dimension, row.key, ctx, otherCount);
      case "cacheShare": return cacheShare(row.counts);
      case "cost": return costOfRow(row);
      default: return row.counts[key];
    }
  };
  const rows = [...answer.list].sort((a, b) => {
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    const order = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sort.desc ? -order : order;
  });
  const columns: Array<{ key: SortKey; label: string; optional?: boolean }> = [
    { key: "input", label: pt("kind.input") },
    { key: "cacheRead", label: pt("kind.cacheRead") },
    { key: "cacheWrite", label: pt("kind.cacheWrite") },
    { key: "output", label: pt("kind.output") },
    { key: "reasoning", label: pt("table.reasoning") },
    { key: "requests", label: pt("kind.requests") },
    { key: "cacheShare", label: pt("table.cacheShare"), optional: true },
    { key: "cost", label: pt("extra.costShort"), optional: true },
  ];
  const cell = (row: ListRow, key: SortKey) => {
    if (key === "cacheShare") return percent(cacheShare(row.counts), locale);
    if (key === "cost") return row.key === "other" ? "—" : money(costOfRow(row), locale);
    return compact(row.counts[key as keyof TokenCounts], locale);
  };
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Hero answer={answer} ctx={ctx} size={desktop ? 32 : 28} />
      <div className="text-[12px] text-muted">{rangeLabel(answer.query.from, answer.query.to, locale)} · {pt("brush.hint")}</div>
    </div>
  );
  const folds = <Folds answer={answer} ctx={ctx} desktop={desktop} />;

  if (desktop) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="px-[22px] pb-3 pt-5" testId="overview">
          {header}
          <div className="mt-3"><OverviewBrush answer={answer} ctx={ctx} onRange={props.onRange} interactive /></div>
        </Card>
        <Card className="overflow-hidden" testId="table">
          <div className="flex items-center gap-3 px-[18px] pb-3 pt-4">
            <span className="text-[12px] font-semibold text-secondary">{pt("rows.title")}</span>
            <div className="w-[440px]"><ByControl props={props} options={ROW_OPTIONS} /></div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px] tabular-nums" data-token-table="">
              <thead>
                <tr className="border-t border-border text-[11px] text-muted">
                  <SortHeader label={pt("table.name")} column="name" sort={sort} onSort={setSort} align="left" ctx={ctx} />
                  {columns.map((column) => <SortHeader key={column.key} label={column.label} column={column.key} sort={sort} onSort={setSort} optional={column.optional} ctx={ctx} />)}
                  <th scope="col" className="px-3 py-2 text-right font-semibold max-xl:hidden">{pt("table.trend")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t border-border hover:bg-sunken" data-token-table-row={row.key}>
                    <th scope="row" className="py-2 pl-[18px] pr-3 text-left font-semibold text-primary">
                      <button type="button" disabled={row.key === "other"} onClick={() => props.onFilter(dimension, row.key)} className="flex max-w-[200px] items-center gap-2 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:no-underline">
                        <SeriesSwatch color={seriesColor(dimension, row.key)} />
                        <span className="truncate">{entityName(dimension, row.key, ctx, otherCount)}</span>
                      </button>
                    </th>
                    {columns.map((column) => <td key={column.key} className={`px-3 py-2 text-right ${column.key === "cacheRead" ? "font-semibold text-primary" : "text-secondary"}`} title={column.key === "cost" || column.key === "cacheShare" ? undefined : exact(row.counts[column.key as keyof TokenCounts], locale)}>{cell(row, column.key)}</td>)}
                    <td className="py-1 pl-3 pr-[18px] max-xl:hidden"><div className="flex justify-end"><Sparkline values={row.trend} color={seriesColor(dimension, row.key)} /></div></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-sunken font-semibold text-primary">
                  <th scope="row" className="py-2 pl-[18px] pr-3 text-left">{pt("total")}</th>
                  {columns.map((column) => <td key={column.key} className="px-3 py-2 text-right">{column.key === "cacheShare" ? percent(cacheShare(answer.totals), locale) : column.key === "cost" ? money(costTotal(answer), locale) : compact(answer.totals[column.key as keyof TokenCounts], locale)}</td>)}
                  <td className="max-xl:hidden" />
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
        {folds}
      </div>
    );
  }
  const max = Math.max(0, ...rows.map((row) => totalOf(row.counts)));
  return (
    <>
      <Card className="px-4 pb-2 pt-4" testId="overview">
        <Hero answer={answer} ctx={ctx} size={28} />
        <div className="mt-2"><OverviewBrush answer={answer} ctx={ctx} interactive={false} /></div>
      </Card>
      <div className="text-[12px] font-semibold text-secondary">{pt("rows.title")}</div>
      <ByControl props={props} options={ROW_OPTIONS} />
      <ul className="flex flex-col gap-2" data-token-cards="">
        {rows.map((row) => (
          <li key={row.key}>
            <Card className="px-3.5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-primary">
                  <SeriesSwatch color={seriesColor(dimension, row.key)} />
                  <span className="truncate">{entityName(dimension, row.key, ctx, otherCount)}</span>
                </span>
                <span className="text-[13px] font-semibold tabular-nums text-primary">{compact(totalOf(row.counts), locale)}</span>
              </div>
              <div className="mt-2"><KindBar counts={row.counts} max={max} height={5} /></div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px]">
                {TOKEN_KINDS.map((kind) => (
                  <div key={kind} className="flex items-baseline justify-between gap-2">
                    <dt className="flex items-center gap-1.5 text-secondary"><SeriesSwatch color={kindColor(kind)} className="h-2 w-2" />{pt(`kind.${kind}` as ProtoKey)}</dt>
                    <dd className="font-semibold tabular-nums text-primary">{compact(row.counts[kind], locale)}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-1.5 text-[11.5px] text-muted"><Optional ctx={ctx} />{pt("extra.cache", { share: percent(cacheShare(row.counts), locale) })}{row.key === "other" ? "" : ` · ${money(costOfRow(row), locale)}`}</div>
            </Card>
          </li>
        ))}
      </ul>
      {folds}
    </>
  );
}

function SortHeader({ label, column, sort, onSort, align = "right", optional = false, ctx }: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort(next: { key: SortKey; desc: boolean }): void;
  align?: "left" | "right";
  optional?: boolean;
  ctx: Ctx;
}) {
  const active = sort.key === column;
  return (
    <th scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className={`py-2 font-semibold ${align === "left" ? "pl-[18px] pr-3 text-left" : "px-3 text-right"}`}>
      <button
        type="button"
        onClick={() => onSort({ key: column, desc: active ? !sort.desc : true })}
        aria-label={ctx.pt("table.sort", { column: label })}
        className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${active ? "text-primary" : ""}`}
      >
        {optional ? <span className="text-[9px] uppercase tracking-[0.04em]">{ctx.pt("optional")}</span> : null}
        {label}
        {active ? (sort.desc ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronUp className="h-3 w-3" aria-hidden />) : null}
      </button>
    </th>
  );
}

function Folds({ answer, ctx, desktop }: { answer: TokensAnswer; ctx: Ctx; desktop: boolean }) {
  const { pt, locale } = ctx;
  const [open, setOpen] = useState<{ top: boolean; lanes: boolean }>({ top: desktop, lanes: false });
  const top = topConversations(answer.query.from, answer.query.to, answer.query).slice(0, 5);
  const lanes = laneRows(answer.query.from, answer.query.to, answer.query).slice(0, 5);
  const fold = (key: "top" | "lanes", title: string, body: ReactNode) => (
    <Card className="overflow-hidden" testId={`fold-${key}`}>
      <button
        type="button"
        aria-expanded={open[key]}
        onClick={() => setOpen((current) => ({ ...current, [key]: !current[key] }))}
        className="flex w-full items-center gap-2 px-[18px] py-3 text-left text-[13px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 max-sm:min-h-11 max-sm:px-3.5"
      >
        {open[key] ? <ChevronDown className="h-4 w-4 text-muted" aria-hidden /> : <ChevronRight className="h-4 w-4 text-muted" aria-hidden />}
        <Optional ctx={ctx} />
        {title}
      </button>
      {open[key] ? <div className="border-t border-border">{body}</div> : null}
    </Card>
  );
  return (
    <div className={desktop ? "grid grid-cols-2 items-start gap-4" : "flex flex-col gap-2"}>
      {fold("top", pt("fold.top"), (
        <ul>
          {top.map((row) => (
            <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-t border-border px-[18px] py-2 text-[12px] first:border-t-0 max-sm:px-3.5">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-accent">{row.title}</span>
                <span className="block truncate text-muted">{[entityName("project", row.project ?? "", ctx), roleName(row.role, ctx.t), entityName("model", row.model, ctx)].join(" · ")}</span>
              </span>
              <span className="font-semibold tabular-nums text-primary">{compact(totalOf(row.counts), locale)}</span>
            </li>
          ))}
        </ul>
      ))}
      {fold("lanes", pt("fold.lanes"), (
        <ul>
          {lanes.map((row) => (
            <li key={row.lane} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-t border-border px-[18px] py-2 text-[12px] first:border-t-0 max-sm:px-3.5">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-primary">{row.task}</span>
                <span className="block truncate text-muted"><span className="font-mono text-[11px]">{row.lane}</span> · {row.pr ? `${pt("fold.pr")} #${row.pr}` : pt("fold.noPr")} · {money(row.cost, locale)}</span>
              </span>
              <span className="font-semibold tabular-nums text-primary">{compact(totalOf(row.counts), locale)}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Variant 4: accounts and limits                                           */
/* ------------------------------------------------------------------------ */

function WindowChart({ account, answer, ctx, height = 84 }: { account: string; answer: TokensAnswer; ctx: Ctx; height?: number }) {
  const { pt, locale } = ctx;
  const [box, width] = useWidth<HTMLDivElement>();
  const peaks = windowPeaks(account, answer.query.from, answer.query.to);
  const left = 46;
  const innerW = Math.max(0, width - left - 4);
  const band = peaks.length ? innerW / peaks.length : 0;
  const y = (value: number) => 6 + (height - 24) * (1 - value / 100);
  const line = (key: "fiveHour" | "weekly") => peaks.map((peak, index) => `${index ? "L" : "M"}${left + index * band + band / 2},${y(peak[key])}`).join(" ");
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-secondary">
        <span className="font-semibold"><Optional ctx={ctx} />{pt("account.windows")}</span>
        <span className="flex items-center gap-1.5"><svg width="14" height="6" aria-hidden><line x1="0" x2="14" y1="3" y2="3" stroke="var(--color-primary)" strokeWidth="2" /></svg>{pt("account.weekly")}</span>
        <span className="flex items-center gap-1.5"><svg width="14" height="6" aria-hidden><line x1="0" x2="14" y1="3" y2="3" stroke="var(--color-muted)" strokeWidth="2" strokeDasharray="3 2" /></svg>{pt("account.fiveHour")}</span>
      </div>
      <div ref={box} style={{ height }} className="mt-1 w-full">
        {width > 0 ? (
          <svg width={width} height={height} className="block" aria-hidden>
            {[0, 50, 100].map((value) => (
              <g key={value}>
                <line x1={left} x2={width} y1={y(value)} y2={y(value)} stroke="var(--color-border)" shapeRendering="crispEdges" />
                <text x={left - 6} y={y(value) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-muted)">{percent(value / 100, locale)}</text>
              </g>
            ))}
            <path d={line("fiveHour")} fill="none" stroke="var(--color-muted)" strokeWidth={1.5} strokeDasharray="3 2" />
            <path d={line("weekly")} fill="none" stroke="var(--color-primary)" strokeWidth={2} strokeLinejoin="round" />
            {peaks.length ? <circle cx={left + (peaks.length - 1) * band + band / 2} cy={y(peaks.at(-1)!.weekly)} r={3} fill="var(--color-primary)" /> : null}
            {peaks.length ? <text x={left + (peaks.length - 1) * band + band / 2 - 7} y={y(peaks.at(-1)!.weekly) - 7} textAnchor="end" fontSize={10} fontWeight={600} fill="var(--color-primary)">{percent(peaks.at(-1)!.weekly / 100, locale)}</text> : null}
          </svg>
        ) : null}
      </div>
    </div>
  );
}

const TAB_OPTIONS: ReadonlyArray<{ value: TokenDimension; label: ProtoKey }> = [
  { value: "member", label: "rows.member" },
  { value: "role", label: "rows.role" },
  { value: "project", label: "rows.project" },
];

export function Variant4(props: VariantProps) {
  const { answer, ctx, desktop, otherCount } = props;
  const { pt, locale } = ctx;
  const tab: TokenDimension = TAB_OPTIONS.some((option) => option.value === props.by) ? props.by : "member";
  const tabAnswer = useMemo(() => tokensAnswer({ ...answer.query, stack: "kind", list: tab as ListDimension }), [answer.query, tab]);
  const accounts = ACCOUNTS.map((account) => ({
    account,
    answer: tokensAnswer({ ...answer.query, stack: "model", list: "model", filters: { ...answer.query.filters, account: account.id } }),
  }));
  const cards = accounts.map(({ account, answer: accountAnswer }) => {
    const keys = stackKeys(accountAnswer);
    return (
      <Card key={account.id} className={desktop ? "px-[18px] pb-3 pt-4" : "px-4 pb-3 pt-4"} testId={`account-${account.id}`}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-semibold text-primary">{account.label}</span>
          <span className="whitespace-nowrap text-[11.5px] text-muted">{pt("account.plan", { plan: account.plan })}</span>
        </div>
        <div className="mt-2 flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-primary" title={exact(totalOf(accountAnswer.totals), locale)}>{compact(totalOf(accountAnswer.totals), locale)}</span>
          <span className="text-[12px] text-muted">{pt("tokens")}</span>
        </div>
        <div className="mt-1 text-[11.5px] text-secondary"><Optional ctx={ctx} />{pt("extra.cache", { share: percent(cacheShare(accountAnswer.totals), locale) })}</div>
        <div className="mt-3 text-[11.5px] font-semibold text-secondary">{pt("account.byModel")}</div>
        <div className="mt-1"><Legend dimension="model" keys={keys} ctx={ctx} /></div>
        <div className="mt-1"><ColumnChart series={accountAnswer.series} dimension="model" height={130} ctx={ctx} bucket={accountAnswer.bucket} testId={`account-${account.id}`} /></div>
        <div className="mt-2 border-t border-border pt-2"><WindowChart account={account.id} answer={accountAnswer} ctx={ctx} /></div>
      </Card>
    );
  });
  const tabs = (
    <Card className="overflow-hidden" testId="tabs">
      <div className={desktop ? "flex items-center gap-4 px-[18px] pb-3 pt-4" : "px-3 pb-3 pt-3"}>
        <div className={desktop ? "flex items-baseline gap-3" : "mb-2 flex items-baseline justify-between"}>
          <Hero answer={answer} ctx={ctx} size={desktop ? 22 : 22} />
        </div>
        <div className={desktop ? "ml-auto w-[340px]" : ""}>
          <Segmented label={pt("by.title")} value={tab} onChange={props.onBy} options={TAB_OPTIONS.map((option) => ({ value: option.value, label: pt(option.label) }))} />
        </div>
      </div>
      <div className="border-t border-border">
        <RankedList rows={tabAnswer.list} dimension={tab} total={totalOf(tabAnswer.totals)} selected={selectedOf(props, tab)} onSelect={(key) => props.onFilter(tab as ListDimension, key)} ctx={ctx} otherCount={otherCount} dense={!desktop} />
      </div>
    </Card>
  );
  if (desktop) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 items-start gap-4">{cards}</div>
        {tabs}
      </div>
    );
  }
  return (
    <>
      {cards}
      {tabs}
    </>
  );
}
