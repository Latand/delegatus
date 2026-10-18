"use client";

import { Check, ChevronDown, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Z } from "@/components/layers";
import { costByKind, costByModel, estimateCost, PRICE_TABLE_DATE } from "@/lib/activity/tokenPrices";
import type { ActivityTokensResponse } from "@/lib/activity/tokenReport";
import type { Locale, TFunction } from "@/lib/i18n";

import { Segmented } from "./ActivityDashboard";
import { ALL_MEMBERS, MEMBER_FORBIDDEN, memberLabel, type MemberChoice } from "./ActivityMembers";
import { ActivityScopeChip } from "./ActivityProjectPicker";
import { MarkPatterns } from "./marks";
import { writeRange, type PageRange } from "./pageParams";
import {
  BY_KEYS, chartBuckets, ColumnChart, compact, CoverageDot, entityName, exact, foldWeeks, inputTotal, KindMeter, Legend, money, namedKeys,
  Optional, OWNER_BY, percent, RankedList, TOKEN_BY, TOKEN_KINDS, tokenTotal, tokenTrust,
  type ListEntry, type TokenBy, type TokenCtx,
} from "./tokenParts";

/*
 * The Tokens tab (docs/design/activity-token-usage.md §9.2, variant 1): one
 * figure with its coverage dot, the kind meter, one stacked column chart, and
 * «Розбити за» beside them, whose choice both stacks the chart and ranks the
 * list. A row click filters the page. The extras the operator chose read
 * «Додатково»: the cache share (E2), the reasoning share (E7) and an
 * estimate at published API prices (E1), never called spending.
 */

const REFRESH_MS = 60_000;

/** Filters a list row sets on the Tokens tab; project and member are the page's own. */
export type TokenFilters = Partial<Record<"role" | "model" | "account", string>>;

/** The query of one Tokens read. The chart stacks by the list's choice;
    «Тип» stacks by kind and lists models. Member: null reads everyone,
    as the server does when none is named. */
export function tokensQuery(range: PageRange, project: string | null, member: MemberChoice, by: TokenBy, filters: TokenFilters): string {
  const search = new URLSearchParams();
  writeRange(search, range);
  search.set("stack", by);
  search.set("list", by === "kind" ? "model" : by);
  if (project !== null) search.set("project", project);
  if (member !== null) search.set("member", member);
  for (const [dimension, value] of Object.entries(filters)) if (value) search.set(dimension, value);
  return search.toString();
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/** Reads the Tokens answer while the tab is shown, again every minute while
    the page is visible; a member who names someone else is answered 403 and
    the page drops the choice. */
export function useActivityTokens({ enabled, query, onForbidden }: { enabled: boolean; query: string; onForbidden(): void }) {
  /* The answer on screen and the query it was asked for: the page dims
     while the query it draws differs from the one asked. */
  const [answered, setAnswered] = useState<{ query: string; body: ActivityTokensResponse } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const request = useRef(0);
  const forbidden = useRef(onForbidden);
  useEffect(() => { forbidden.current = onForbidden; });

  const load = useCallback(async (target: string) => {
    const id = ++request.current;
    try {
      const response = await fetch(`/api/activity/tokens?${target}`, { cache: "no-store" });
      if (response.status === 403 && (await errorCode(response)) === MEMBER_FORBIDDEN) {
        if (id === request.current) forbidden.current();
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as ActivityTokensResponse;
      if (id !== request.current) return;
      setAnswered({ query: target, body });
      setFailed(null);
    } catch {
      if (id === request.current) setFailed(target);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the read's
       state is set after its fetch resolves, never synchronously here. */
    void load(query);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(query);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, load, query]);

  return {
    answer: answered?.body ?? null,
    loading: enabled && answered?.query !== query && failed !== query,
    failed: failed === query,
    retry: () => void load(query),
  };
}

/** The project picker's rows on the Tokens tab: every project of the range
    with its tokens, read once per query when the picker opens. */
export function useTokenProjects(query: string, locale: Locale, t: TFunction) {
  const [rows, setRows] = useState<{ query: string; answer: ActivityTokensResponse } | null>(null);
  const asked = useRef<string | null>(null);
  const open = useCallback(() => {
    if (asked.current === query) return;
    asked.current = query;
    void (async () => {
      try {
        const response = await fetch(`/api/activity/tokens?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const answer = (await response.json()) as ActivityTokensResponse;
        if (asked.current === query) setRows({ query, answer });
      } catch {
        if (asked.current === query) asked.current = null;
      }
    })();
  }, [query]);
  const entries = useMemo(() => {
    if (!rows || rows.query !== query) return [];
    const ctx: TokenCtx = { answer: rows.answer, locale, t };
    return rows.answer.list
      .filter((row) => row.key !== "other" && row.key !== "")
      .map((row) => ({ project: row.key, label: entityName("project", row.key, ctx), value: compact(tokenTotal(row.counts), locale) }));
  }, [rows, query, locale, t]);
  return { entries, open };
}

/* ------------------------------------------------------------------------ */
/* Header pieces                                                            */
/* ------------------------------------------------------------------------ */

/** The owner's choice of whose tokens: everyone, or one member of the roster. */
export function TokensMemberChooser({ answer, selected, onSelect, t, wide = false }: {
  answer: ActivityTokensResponse;
  selected: MemberChoice;
  onSelect(member: MemberChoice): void;
  t: TFunction;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  const chosen = selected === null || selected === ALL_MEMBERS ? null : selected;
  const label = (id: string) => memberLabel({ id, name: answer.member.members.find((member) => member.id === id)?.name ?? null }, t);
  const options: Array<{ id: string | null; label: string }> = [
    { id: null, label: t("activity.tokens.member.all") },
    ...answer.member.members.map((member) => ({ id: member.id, label: label(member.id) })),
  ];
  const choose = (id: string | null) => {
    setOpen(false);
    trigger.current?.focus();
    onSelect(id ?? ALL_MEMBERS);
  };
  return (
    <div ref={root} className={`relative ${wide ? "w-full" : "shrink-0"}`}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t("activity.tokens.member.aria")}
        onClick={() => setOpen((value) => !value)}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-border bg-card px-2.5 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${wide ? "h-11 w-full" : "h-8 max-w-[220px]"}`}
        data-token-members=""
      >
        <Users className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className={`truncate ${wide ? "flex-1 text-left" : ""}`}>{chosen === null ? t("activity.tokens.member.all") : label(chosen)}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      </button>
      {open ? (
        <div
          className={`absolute top-full ${Z.popover} mt-1 overflow-hidden rounded-[10px] border border-border bg-raised py-1 shadow-2 ${wide ? "left-0 right-0" : "right-0 w-[260px]"}`}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } }}
          data-token-member-menu=""
        >
          {options.map((option) => (
            <button
              key={option.id ?? "all"}
              type="button"
              aria-pressed={option.id === chosen}
              onClick={() => choose(option.id)}
              className={`flex min-h-9 w-full items-center gap-2 px-3 text-left text-[12.5px] font-semibold text-primary hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none max-sm:min-h-11`}
            >
              <Check className={`h-3.5 w-3.5 shrink-0 ${option.id === chosen ? "text-accent" : "text-transparent"}`} aria-hidden />
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One chip per filter a list row set, each clearing its own. */
export function TokenFilterChips({ answer, filters, onClear, locale, t }: {
  answer: ActivityTokensResponse | null;
  filters: TokenFilters;
  onClear(dimension: keyof TokenFilters): void;
  locale: Locale;
  t: TFunction;
}) {
  if (!answer) return null;
  const ctx: TokenCtx = { answer, locale, t };
  return (
    <>
      {(Object.entries(filters) as Array<[keyof TokenFilters, string]>).map(([dimension, key]) => (
        <ActivityScopeChip key={dimension} name={`${t(BY_KEYS[dimension])}: ${entityName(dimension, key, ctx)}`} onClear={() => onClear(dimension)} t={t} />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* The tab                                                                  */
/* ------------------------------------------------------------------------ */

function kindRows(answer: ActivityTokensResponse, locale: Locale): ListEntry[] {
  const costs = costByKind(answer.costBasis);
  return TOKEN_KINDS.map((kind) => {
    const usd = costs[kind];
    return {
      key: kind,
      counts: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 0, [kind]: answer.totals[kind] },
      cost: usd === null ? "—" : money(usd, locale),
    };
  });
}

function modelRows(answer: ActivityTokensResponse, locale: Locale): ListEntry[] {
  const costs = costByModel(answer.costBasis);
  const listed = new Set(answer.list.map((row) => row.key));
  return answer.list.map((row) => {
    let usd: number | null;
    if (row.key === "other") {
      const rest = [...costs].filter(([model]) => !listed.has(model)).map(([, value]) => value);
      usd = rest.some((value) => value !== null) ? rest.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    } else usd = costs.get(row.key) ?? null;
    return { key: row.key, counts: row.counts, cost: usd === null ? "—" : money(usd, locale) };
  });
}

export function ActivityTokensBody({ answer, by, onBy, project, onProject, member, onMember, filters, onFilter, loading, phone, locale, t }: {
  answer: ActivityTokensResponse;
  by: TokenBy;
  onBy(by: TokenBy): void;
  project: string | null;
  onProject(project: string | null): void;
  member: MemberChoice;
  onMember(member: MemberChoice): void;
  filters: TokenFilters;
  onFilter(dimension: keyof TokenFilters, key: string | null): void;
  loading: boolean;
  phone: boolean;
  locale: Locale;
  t: TFunction;
}) {
  const ctx: TokenCtx = { answer, locale, t };
  const total = tokenTotal(answer.totals);
  const trust = tokenTrust(answer);
  const named = by === "kind" ? [] : namedKeys(ctx);
  const series = chartBuckets(answer.series, by, named);
  const weekly = phone && answer.params.bucket === "day" && series.length > 31;
  const buckets = weekly ? foldWeeks(series, answer.params.tz) : series;
  const stacked = new Set(buckets.flatMap((bucket) => bucket.parts.filter((part) => tokenTotal(part.counts) > 0).map((part) => part.key)));
  const legendKeys = by === "kind" ? TOKEN_KINDS.filter((kind) => stacked.has(kind)) : [...named, "other"].filter((key) => stacked.has(key));
  const priced = by === "kind" || by === "model";
  const rows: ListEntry[] = by === "kind" ? kindRows(answer, locale)
    : by === "model" ? modelRows(answer, locale) : answer.list.map((row) => ({ key: row.key, counts: row.counts }));
  const estimate = estimateCost(answer.costBasis);
  const costValue = estimate.usd > 0 || tokenTotal(estimate.unpriced) === 0 ? money(estimate.usd, locale) : "—";
  const costTitle = [
    t("activity.tokens.extra.costNote", { date: PRICE_TABLE_DATE }),
    estimate.unpricedModels.length ? t("activity.tokens.extra.costUnpriced", { models: estimate.unpricedModels.map((model) => entityName("model", model, ctx)).join(", ") }) : null,
  ].filter(Boolean).join(" ");
  const input = inputTotal(answer.totals);
  const options = TOKEN_BY.filter((option) => answer.member.canChoose || !OWNER_BY.has(option));
  const selected = by === "project" ? project : by === "member" ? (member === ALL_MEMBERS ? null : member) : by === "kind" ? null : filters[by] ?? null;
  const select = (key: string) => {
    if (by === "project") onProject(project === key ? null : key || null);
    else if (by === "member") onMember(member === key ? ALL_MEMBERS : key);
    else if (by !== "kind") onFilter(by, filters[by] === key ? null : key);
  };
  const empty = total === 0;

  const figure = (
    <div>
      <div className="flex h-5 items-center gap-1 text-[12px] font-semibold text-secondary">
        {t("activity.tokens.figure")}
        <CoverageDot ctx={ctx} />
      </div>
      {trust === "none" ? (
        <p className="mt-2 text-[13px] text-secondary" data-token-none="">{t("activity.tokens.emptyNone")}</p>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-2 whitespace-nowrap">
            <span className="font-semibold leading-none tracking-[-0.02em] text-primary" style={{ fontSize: phone ? 36 : 44 }} title={exact(total, locale)} data-token-hero="">
              {trust === "lower" ? t("activity.atLeast", { value: compact(total, locale) }) : compact(total, locale)}
            </span>
            <span className="text-[13px] font-medium text-muted">{t("activity.tokens.unit", { count: total < 1e3 ? Math.round(total) : 1e3 })}</span>
          </div>
          <div className={`mt-2 flex flex-wrap items-baseline gap-y-1 text-[12px] text-secondary ${phone ? "flex-col gap-x-0" : "gap-x-4"}`} data-token-extras="">
            <span className="whitespace-nowrap" data-token-extra="cache"><Optional t={t} />{t("activity.tokens.extra.cache", { share: percent(input ? answer.totals.cacheRead / input : 0, locale) })}</span>
            <span className="whitespace-nowrap" data-token-extra="reasoning"><Optional t={t} />{t("activity.tokens.extra.reasoning", { share: percent(answer.totals.output ? answer.totals.reasoning / answer.totals.output : 0, locale) })}</span>
            <span className="whitespace-nowrap" title={costTitle} data-token-extra="cost"><Optional t={t} />{t("activity.tokens.extra.cost", { value: costValue })}</span>
          </div>
          <div className="mt-4"><KindMeter counts={answer.totals} ctx={ctx} stacked={phone} /></div>
        </>
      )}
    </div>
  );
  const chart = trust === "none" ? null : (
    <div className="mt-[18px] border-t border-border pt-3">
      {legendKeys.length ? <div className="mb-2"><Legend keys={legendKeys} by={by} named={named} ctx={ctx} /></div> : null}
      <ColumnChart buckets={buckets} bucket={weekly ? "week" : answer.params.bucket} by={by} named={named} height={phone ? 200 : 280} ctx={ctx} />
    </div>
  );
  const byControl = (
    <div className={phone ? "[&_[role=tab]]:px-1.5" : ""} data-token-by="">
      <Segmented<TokenBy> label={t("activity.tokens.by.title")} value={by} onChange={onBy} options={options.map((option) => ({ value: option, label: t(BY_KEYS[option]) }))} />
    </div>
  );
  const list = trust === "none" ? null : empty ? (
    <p className="px-4 py-6 text-center text-[12px] text-muted" data-token-empty="">{t("activity.tokens.empty")}</p>
  ) : (
    <>
      {priced ? (
        <p className="border-b border-border px-[18px] py-2 text-[11.5px] text-muted max-sm:px-3" title={costTitle} data-token-list-cost="">
          <Optional t={t} />{t("activity.tokens.extra.costList")}
        </p>
      ) : null}
      <RankedList rows={rows} by={by} named={named} total={total} selected={selected} onSelect={select} ctx={ctx} />
    </>
  );
  const dim = `transition-opacity ${loading ? "opacity-60" : ""}`;

  /* Until anything is counted there is nothing to break down. */
  const counted = trust !== "none";
  if (!phone) {
    return (
      <div className={`grid grid-cols-[minmax(0,1fr)_420px] items-start gap-4 ${dim}`} data-token-tab="desktop" data-activity-loaded="tokens">
        <section className="rounded-[12px] border border-border bg-card px-[22px] pb-3.5 pt-5 shadow-1" data-token-card="main">{figure}{chart}</section>
        {counted ? (
          <section className="overflow-hidden rounded-[12px] border border-border bg-card shadow-1" data-token-card="breakdown">
            <div className="px-[18px] pb-3 pt-4">
              <div className="mb-2 text-[12px] font-semibold text-secondary">{t("activity.tokens.by.title")}</div>
              {byControl}
            </div>
            <div className="border-t border-border">{list}</div>
          </section>
        ) : null}
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-3 ${dim}`} data-token-tab="phone" data-activity-loaded="tokens">
      {/* The desktop page defines the hatch of uncounted days; the phone draws it here. */}
      <MarkPatterns />
      <section className="rounded-[12px] border border-border bg-card px-4 pb-3 pt-4 shadow-1" data-token-card="main">{figure}{chart}</section>
      {counted ? (
        <>
          <div className="text-[12px] font-semibold text-secondary">{t("activity.tokens.by.title")}</div>
          {byControl}
          <section className="overflow-hidden rounded-[12px] border border-border bg-card shadow-1" data-token-card="breakdown">{list}</section>
        </>
      ) : null}
    </div>
  );
}
