"use client";

import { ArrowLeft, Check, Info, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { RangeKey } from "@/lib/activity/method";
import type { ActivityResponse } from "@/lib/activity/report";
import type { Locale, MessageKey, TFunction } from "@/lib/i18n";

import { ActivityCountingDrawer } from "./ActivityCountingDrawer";
import { ActivityDayChart } from "./ActivityDayChart";
import { ActivityFigures } from "./ActivityFigures";
import { ActivityProjects } from "./ActivityProjects";
import { ActivityRhythm } from "./ActivityRhythm";
import { nothingRead, projectNames, rangeText, trustState } from "./format";
import { MarkPatterns } from "./marks";
import type { TipContext } from "./tips";

/*
 * The desktop activity page (docs/design/activity-dashboard-v2.md): one number
 * to read first, one chart to read second, the projects beside them, the
 * rhythm under them, and trust as one quiet chip whose detail lives in a
 * drawer. ActivityDashboard keeps the fetch and the range; this draws them.
 */

const RANGES: readonly RangeKey[] = ["today", "7d", "30d"];

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

export function ActivityDesktop({ data, range, onRange, loading, failed, onRetry, locale, t }: {
  data: ActivityResponse | null;
  range: RangeKey;
  onRange(next: RangeKey): void;
  loading: boolean;
  failed: boolean;
  onRetry(): void;
  locale: Locale;
  t: TFunction;
}) {
  const [drawer, setDrawer] = useState<null | "top" | "hosts">(null);
  const main = useRef<HTMLElement | null>(null);
  const names = useMemo(() => projectNames(data?.projects ?? [], t), [data, t]);
  const unread = data ? nothingRead(data) : false;
  const context: TipContext | null = data ? { data, names, unread, locale, t } : null;
  const showRhythm = data?.range.key !== "today";

  return (
    <div className="h-full overflow-y-auto bg-canvas" data-activity-page="" data-activity-layout="desktop">
      <MarkPatterns />
      <div className="mx-auto max-w-[1328px] px-6 pb-4 pt-5">
        <header className="flex h-9 items-center gap-3">
          <a
            href="/"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-border bg-card px-3 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("activity.back")}
          </a>
          <div className="ml-1 flex min-w-0 items-baseline gap-2.5">
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-primary">{t("activity.title")}</h1>
            {data ? <span className="truncate text-[13px] text-muted" data-activity-range-label="">{rangeText(data, locale)}</span> : null}
          </div>
          <div className="flex-1" />
          <div className="flex shrink-0 rounded-[8px] border border-border bg-card p-[2px]" role="tablist" aria-label={t("activity.rangeAria")}>
            {RANGES.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={range === key}
                onClick={() => onRange(key)}
                className={`h-7 whitespace-nowrap rounded-[6px] px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${range === key ? "bg-canvas text-primary" : "text-muted hover:text-primary"}`}
                data-activity-option={key}
              >
                {t(`activity.range.${key}` as MessageKey)}
              </button>
            ))}
          </div>
          {data ? <TrustChip data={data} t={t} onOpen={() => setDrawer("top")} /> : null}
          <button
            type="button"
            onClick={() => setDrawer("top")}
            aria-haspopup="dialog"
            disabled={!data}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-2 text-[12px] font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
            data-activity-how=""
          >
            <Info className="h-3.5 w-3.5" aria-hidden />
            {t("activity.how")}
          </button>
        </header>

        {failed && !data ? (
          <div role="alert" className="mt-[18px] flex items-center gap-3 rounded-[12px] border border-border bg-card px-[22px] py-5 text-[13px] text-secondary shadow-1">
            <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span className="flex-1">{t("activity.failed")}</span>
            <button type="button" onClick={onRetry} className="h-8 rounded-[8px] border border-border bg-card px-3 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              {t("activity.retry")}
            </button>
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
            <ActivityProjects key={data.range.key} context={context} span={showRhythm} />
          </div>
        ) : !failed ? <Skeleton /> : null}
      </div>
      {drawer && context ? <ActivityCountingDrawer context={context} focusHosts={drawer === "hosts"} onClose={() => setDrawer(null)} /> : null}
    </div>
  );
}
