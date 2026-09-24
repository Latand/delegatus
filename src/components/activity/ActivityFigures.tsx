"use client";

import { Plug } from "lucide-react";
import { useRef, useState } from "react";

import type { ActivityResponse } from "@/lib/activity/report";
import type { Locale, TFunction } from "@/lib/i18n";

import { agentHoursText, agentParts, agentText, hoursText, minutesText } from "./format";
import { markStyle, Swatch, Tooltip, type MarkKind, type TipAnchor } from "./marks";

/*
 * Questions 1 and 2 at a glance (docs/design/activity-dashboard-v2.md,
 * "Figures"): your reported hours as the one hero figure, with the minutes
 * and the billable figure under it; agent wall-clock beside it with a meter
 * of its supervised, unattended and unclear parts, labelled under the meter.
 * The labels double as the day chart's legend.
 */

function Lower({ big }: { big?: boolean }) {
  return <span className={`mr-1.5 font-medium text-muted ${big ? "align-[0.18em] text-[0.62em]" : ""}`}>≥</span>;
}

export function ActivityFigures({ data, unread, locale, t, onConnect }: {
  data: ActivityResponse;
  /** None of your input was read for the range. */
  unread: boolean;
  locale: Locale;
  t: TFunction;
  onConnect(): void;
}) {
  const totals = data.totals;
  const lower = !totals.coverage.complete || totals.missingSourceDays > 0;
  const ge = lower ? "≥ " : "";
  const indexing = data.coverage.agentIndex !== "ok";
  const [supervised, unattended, unclear] = agentParts(totals);
  const parts: Array<{ kind: MarkKind; ms: number; label: string }> = ([
    { kind: "supervised", ms: supervised, label: "activity.fig.supervised" },
    { kind: "unattended", ms: unattended, label: "activity.fig.unattended" },
    { kind: "unclear", ms: unclear, label: "activity.fig.unclear" },
  ] as const).filter((part) => part.ms > 0).map((part) => ({ kind: part.kind, ms: part.ms, label: t(part.label, { value: t("activity.approx", { value: agentText(part.ms, t) ?? "0" }) }) }));
  const agents = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<TipAnchor | null>(null);
  const openTip = () => {
    const rect = agents.current?.getBoundingClientRect();
    if (rect) setTip({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  };
  const wall = agentText(totals.wallMs, t);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-6" data-activity-figures="">
      <div data-activity-figure="you">
        <div className="flex h-3.5 items-center gap-[7px] text-[12px] font-semibold text-secondary">
          <Swatch kind="you" />
          {t("activity.fig.you")}
        </div>
        {unread ? (
          <>
            <div className="mt-1.5 text-[32px] font-semibold leading-none tracking-[-0.02em] text-secondary">{t("activity.unknown")}</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              <span>{t("activity.fig.noneRead")}</span>
              <button type="button" onClick={onConnect} className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Plug className="h-3.5 w-3.5" aria-hidden />
                {t("activity.fig.connect")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-1.5 flex items-baseline gap-2 whitespace-nowrap">
              <span className="text-[44px] font-semibold leading-none tracking-[-0.02em] text-primary" data-activity-hero="">
                {lower ? <Lower big /> : null}
                {hoursText(totals.humanHours, locale, t)}
              </span>
              <span className="text-[13px] font-medium text-muted">{t("activity.fig.reported")}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              <span>{t("activity.fig.byMinute", { value: ge + minutesText(totals.humanMs, t) })}</span>
              {data.billableConfigured ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="font-semibold text-secondary">{t("activity.fig.billable", { value: ge + hoursText(totals.billableHours, locale, t) })}</span>
                </>
              ) : null}
            </div>
          </>
        )}
      </div>

      <div
        ref={agents}
        data-activity-figure="agents"
        tabIndex={indexing ? undefined : 0}
        aria-describedby={tip ? "activity-agents-tip" : undefined}
        onMouseEnter={indexing ? undefined : openTip}
        onMouseLeave={() => setTip(null)}
        onFocus={indexing ? undefined : openTip}
        onBlur={() => setTip(null)}
        className="min-w-0 rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <div className="flex h-3.5 items-center text-[12px] font-semibold text-secondary">{t("activity.fig.agents")}</div>
        <div className="mt-1.5 flex items-baseline whitespace-nowrap">
          <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] text-primary" data-activity-agents-value="">
            {indexing ? "…" : wall ? <><span className="mr-1.5 align-[0.18em] text-[0.62em] font-medium text-muted">≈</span>{wall}</> : "–"}
          </span>
        </div>
        {indexing ? (
          <div className="mt-[7px] text-[12px] text-muted">{t("activity.fig.indexing")}</div>
        ) : (
          <>
            <div className="mt-3 flex h-2 max-w-[360px] gap-[2px]" aria-hidden data-activity-meter="">
              {parts.map((part, index) => (
                <span
                  key={part.kind}
                  className={`h-full ${parts.length === 1 ? "rounded-[3px]" : index === 0 ? "rounded-l-[3px]" : index === parts.length - 1 ? "rounded-r-[3px]" : ""}`}
                  style={{ flex: part.ms, ...markStyle(part.kind) }}
                />
              ))}
            </div>
            <div className="mt-[7px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted" data-activity-split="">
              {unread && totals.wallMs > 0 ? (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Swatch kind="unclear" />{t("activity.fig.splitUnknown")}</span>
              ) : parts.map((part) => (
                <span key={part.kind} className="inline-flex items-center gap-1.5 whitespace-nowrap"><Swatch kind={part.kind} />{part.label}</span>
              ))}
            </div>
          </>
        )}
      </div>
      {tip ? (
        <Tooltip anchor={tip} side="below" id="activity-agents-tip">
          <div className="grid grid-cols-[max-content_1fr] items-center gap-x-2 gap-y-px">
            <span className="text-right font-semibold tabular-nums text-primary">{wall ? t("activity.approx", { value: wall }) : "–"}</span>
            <span className="text-secondary">{t("activity.fig.wall")}</span>
            <span className="text-right font-semibold tabular-nums text-primary">{agentHoursText(totals.agentHoursMs, locale)}</span>
            <span className="text-secondary">{t("activity.fig.agentHours")}</span>
          </div>
          {unclear > 0 ? <div className="mt-[5px] max-w-[280px] text-[11px] text-muted">{t("activity.tip.unclearAny")}</div> : null}
        </Tooltip>
      ) : null}
    </div>
  );
}

