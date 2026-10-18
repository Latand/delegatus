"use client";

import { ArrowLeft, Check, Info, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { ActivityResponse } from "@/lib/activity/report";
import type { ActivityTokensResponse } from "@/lib/activity/tokenReport";
import type { Locale, TFunction } from "@/lib/i18n";

import { Segmented } from "./ActivityDashboard";
import { ActivityCountingDrawer, TokensCountingDrawer } from "./ActivityCountingDrawer";
import { ActivityDayChart } from "./ActivityDayChart";
import { ActivityFigures } from "./ActivityFigures";
import { ActivityMemberBreakdown, ActivityMemberFilter, type MemberChoice } from "./ActivityMembers";
import { ActivityProjectPicker, ActivityScopeChip } from "./ActivityProjectPicker";
import { ActivityProjects } from "./ActivityProjects";
import { ActivityRangeControl, type PageRange } from "./ActivityRangeControl";
import { ActivityRhythm } from "./ActivityRhythm";
import { ActivityTokensBody, TokenFilterChips, TokensMemberChooser, type TokenFilters } from "./ActivityTokens";
import { listUnread, nothingRead, projectNames, rangeText, trustState } from "./format";
import { MarkPatterns } from "./marks";
import type { TipContext } from "./tips";
import { datesLabel, type TokenBy, type TokenCtx } from "./tokenParts";

/*
 * The desktop activity page (docs/design/activity-dashboard-v2.md): one number
 * to read first, one chart to read second, the projects beside them, the
 * rhythm under them, and trust as one quiet chip whose detail lives in a
 * drawer. Its «Токени» tab (docs/design/activity-token-usage.md §9.2) draws
 * token usage over the same range, project and member. ActivityDashboard
 * keeps the fetches and the range; this draws them.
 */

export type DesktopTab = "time" | "tokens";

/** What the Tokens tab draws with, read and kept by ActivityDashboard. */
export interface TokensTab {
  answer: ActivityTokensResponse | null;
  loading: boolean;
  failed: boolean;
  onRetry(): void;
  by: TokenBy;
  onBy(by: TokenBy): void;
  filters: TokenFilters;
  onFilter(dimension: keyof TokenFilters, key: string | null): void;
  /** The project picker's rows, read when it opens. */
  projects: { entries: ReadonlyArray<{ project: string; label: string; value: string }>; open(): void };
}

function TrustChip({ data, t, onOpen }: { data: ActivityResponse; t: TFunction; onOpen(): void }) {
  const state = trustState(data);
  const ok = state === "ok";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${ok ? "border-border bg-card text-secondary" : "border-warning/30 bg-warning-soft text-warning"}`}
      data-activity-trust={state}
    >
      {ok ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <TriangleAlert className="h-3.5 w-3.5" aria-hidden />}
      {t(state === "ok" ? "activity.trust.ok" : state === "none" ? "activity.trust.none" : "activity.trust.lower")}
    </button>
  );
}

function Skeleton() {
  return (
    <div className="mt-[18px] grid grid-cols-[minmax(0,1fr)_420px] gap-4" aria-hidden data-activity-skeleton="">
      <div className="h-[437px] rounded-[12px] border border-border bg-card shadow-1" />
      <div className="row-span-2 rounded-[12px] border border-border bg-card shadow-1" />
      <div className="h-[247px] rounded-[12px] border border-border bg-card shadow-1" />
    </div>
  );
}

function Failed({ t, onRetry }: { t: TFunction; onRetry(): void }) {
  return (
    <div role="alert" className="mt-[18px] flex items-center gap-3 rounded-[12px] border border-border bg-card px-[22px] py-5 text-[13px] text-secondary shadow-1">
      <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span className="flex-1">{t("activity.failed")}</span>
      <button type="button" onClick={onRetry} className="h-8 rounded-[8px] border border-border bg-card px-3 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        {t("activity.retry")}
      </button>
    </div>
  );
}

export function ActivityDesktop({ tab, onTab, data, range, onRange, today, scope, onProject, member, onMember, loading, failed, onRetry, tokens, locale, t }: {
  tab: DesktopTab;
  onTab(tab: DesktopTab): void;
  data: ActivityResponse | null;
  range: PageRange;
  onRange(next: PageRange): void;
  /** Today in the page's zone, the last date the range offers. */
  today: string | null;
  /** The project the whole page is scoped to, by key and name, or none. */
  scope: { project: string; name: string } | null;
  onProject(project: string | null): void;
  /** Whose input the page counts: `all`, a member id, or null for the viewer. */
  member: MemberChoice;
  onMember(member: MemberChoice): void;
  loading: boolean;
  failed: boolean;
  onRetry(): void;
  tokens: TokensTab;
  locale: Locale;
  t: TFunction;
}) {
  const [drawer, setDrawer] = useState<null | "top" | "hosts">(null);
  const main = useRef<HTMLElement | null>(null);
  const names = useMemo(() => projectNames(data?.projects ?? [], t), [data, t]);
  const unread = data ? nothingRead(data) : false;
  const rowsUnread = data ? listUnread(data) : false;
  const context: TipContext | null = data ? { data, names, unread, listUnread: rowsUnread, locale, t } : null;
  const showRhythm = (data?.days.length ?? 0) > 1;
  const onTokens = tab === "tokens";
  const answer = tokens.answer;
  const tokenCtx: TokenCtx | null = answer ? { answer, locale, t } : null;
  const shown = onTokens
    ? answer ? { from: answer.params.from, to: answer.params.to } : null
    : data?.days.length ? { from: data.days[0]!.date, to: data.days.at(-1)!.date } : null;
  const rangeLabel = onTokens ? (answer ? datesLabel(answer.params.from, answer.params.to, locale) : null) : data ? rangeText(data, locale) : null;
  const ready = onTokens ? answer !== null : data !== null;

  return (
    <div className="h-full overflow-y-auto bg-canvas" data-activity-page="" data-activity-layout="desktop" data-activity-tab={tab}>
      <MarkPatterns />
      <div className="mx-auto max-w-[1328px] px-6 pb-3 pt-5">
        <header className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2" data-activity-header="">
          <a
            href="/"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-border bg-card px-3 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("activity.back")}
          </a>
          <h1 className="ml-1 shrink-0 text-[17px] font-semibold tracking-[-0.01em] text-primary">{t("activity.title")}</h1>
          <div className="w-[136px] shrink-0" data-activity-tabs="">
            <Segmented<DesktopTab> label={t("activity.view.switchAria")} value={tab} onChange={onTab} options={[{ value: "time", label: t("activity.view.time") }, { value: "tokens", label: t("activity.view.tokens") }]} />
          </div>
          <div className="flex min-w-0 items-baseline gap-2.5">
            {scope ? <ActivityScopeChip name={scope.name} onClear={() => onProject(null)} t={t} /> : null}
            {onTokens ? <TokenFilterChips answer={answer} filters={tokens.filters} onClear={(dimension) => tokens.onFilter(dimension, null)} locale={locale} t={t} /> : null}
            {rangeLabel ? <span className="truncate text-[13px] text-muted" data-activity-range-label="">{rangeLabel}</span> : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {onTokens
              ? answer?.member.canChoose ? <TokensMemberChooser answer={answer} selected={member} onSelect={onMember} t={t} /> : null
              : data?.member.canChoose ? <ActivityMemberFilter data={data} selected={member} onSelect={onMember} locale={locale} t={t} /> : null}
            {onTokens
              ? answer ? <ActivityProjectPicker entries={tokens.projects.entries} onOpen={tokens.projects.open} selected={scope?.project ?? null} unread={false} onSelect={onProject} locale={locale} t={t} /> : null
              : data ? <ActivityProjectPicker data={data} names={names} selected={scope?.project ?? null} unread={rowsUnread} onSelect={onProject} locale={locale} t={t} /> : null}
            <ActivityRangeControl range={range} shown={shown} today={today} onChange={onRange} locale={locale} t={t} />
            {!onTokens && data ? <TrustChip data={data} t={t} onOpen={() => setDrawer("top")} /> : null}
            <button
              type="button"
              onClick={() => setDrawer("top")}
              aria-haspopup="dialog"
              disabled={!ready}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-2 text-[12px] font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
              data-activity-how=""
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
              {t("activity.how")}
            </button>
          </div>
        </header>

        {onTokens ? (
          <>
            {tokens.failed && !answer ? <Failed t={t} onRetry={tokens.onRetry} /> : null}
            {answer ? (
              <div className="mt-[18px]">
                <ActivityTokensBody
                  answer={answer}
                  by={tokens.by}
                  onBy={tokens.onBy}
                  project={scope?.project ?? null}
                  onProject={onProject}
                  member={member}
                  onMember={onMember}
                  filters={tokens.filters}
                  onFilter={tokens.onFilter}
                  loading={tokens.loading}
                  phone={false}
                  locale={locale}
                  t={t}
                />
              </div>
            ) : !tokens.failed ? <Skeleton /> : null}
          </>
        ) : (
          <>
            {failed && !data ? <Failed t={t} onRetry={onRetry} /> : null}

            {context && data && data.member.selection === "all" ? (
              <div className={`mt-[18px] transition-opacity ${loading ? "opacity-60" : ""}`}>
                <ActivityMemberBreakdown data={data} onSelect={onMember} locale={locale} t={t} />
              </div>
            ) : null}

            {context && data ? (
              <div
                className={`mt-[18px] grid grid-cols-[minmax(0,1fr)_420px] items-start gap-4 transition-opacity ${loading ? "opacity-60" : ""}`}
                data-activity-loaded={data.range.key}
              >
                <section ref={main} className="col-start-1 row-start-1 rounded-[12px] border border-border bg-card px-[22px] pb-3.5 pt-5 shadow-1" data-activity-main="">
                  <ActivityFigures data={data} unread={unread} locale={locale} t={t} onConnect={() => setDrawer("hosts")} />
                  <div className="mt-[18px] border-t border-border pt-3">
                    <ActivityDayChart
                      context={context}
                      bounds={() => {
                        const rect = main.current?.getBoundingClientRect();
                        return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : undefined;
                      }}
                    />
                  </div>
                </section>
                {showRhythm ? <div className="col-start-1 row-start-2"><ActivityRhythm context={context} /></div> : null}
                <ActivityProjects key={`${data.days[0]?.date}:${data.days.at(-1)?.date}`} context={context} span={showRhythm} selected={scope?.project ?? null} onSelect={onProject} />
              </div>
            ) : !failed ? <Skeleton /> : null}
          </>
        )}
      </div>
      {drawer && onTokens && tokenCtx ? <TokensCountingDrawer ctx={tokenCtx} onClose={() => setDrawer(null)} /> : null}
      {drawer && !onTokens && context ? <ActivityCountingDrawer context={context} focusHosts={drawer === "hosts"} onClose={() => setDrawer(null)} /> : null}
    </div>
  );
}
