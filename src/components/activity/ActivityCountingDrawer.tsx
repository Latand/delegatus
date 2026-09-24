"use client";

import { Check, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { EXCLUSION_REASONS } from "@/lib/activity/method";
import type { ActivityHostRow } from "@/lib/activity/report";
import type { MessageKey } from "@/lib/i18n";

import { agentHoursText, approxText, clockText, dateTimeText, datesText, dayLong, hostName } from "./format";
import type { TipContext } from "./tips";

/*
 * Question 4 on demand (docs/design/activity-dashboard-v2.md, "Trust chip and
 * the How it's counted drawer"): every problem of the range said once, in
 * plain words, the two agent measures, one row per host, the method in five
 * bullets, and the exclusions and surfaces collapsed.
 */

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function ActivityCountingDrawer({ context, focusHosts, onClose }: { context: TipContext; focusHosts: boolean; onClose(): void }) {
  const { data, locale, t } = context;
  const tz = data.params.tz;
  const panel = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);
  const hostsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    if (focusHosts) hostsRef.current?.scrollIntoView({ block: "start" });
    return () => opener?.focus();
  }, [focusHosts]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>("button, summary, a[href], [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const today = data.range.key === "today";
  const todayDay = data.days.find((day) => day.start <= data.range.now && data.range.now < day.end);
  const span = (start: number, end: number) => `${clockText(start, locale, tz)}–${clockText(Math.min(end, data.range.now), locale, tz)}`;
  /** When a host was not read: the day runs, or today's hours. */
  const when = (host: ActivityHostRow): string => {
    const touched = data.days.filter((day) => host.unread.some((gap) => gap.start < day.end && gap.end > day.start)).map((day) => day.date);
    if (today || (touched.length === 1 && todayDay && touched[0] === todayDay.date)) {
      const spans = host.unread.map((gap) => span(Math.max(gap.start, todayDay?.start ?? gap.start), gap.end)).join(", ");
      return t("activity.drawer.whenToday", { span: spans });
    }
    return t("activity.drawer.whenDays", { days: datesText(touched, data.days, locale, tz) });
  };
  const readTo = (host: ActivityHostRow): number | null => {
    let latest: number | null = null;
    for (const source of host.sources) for (const covered of source.covered) latest = Math.max(latest ?? 0, Math.min(covered.end, data.range.now));
    return latest;
  };
  const sourcesText = (host: ActivityHostRow): string => {
    const read = host.sources.filter((source) => source.state === "read");
    const ledger = read.some((source) => source.source === "ledger");
    const exported = read.some((source) => source.source === "transcripts");
    if (ledger && exported) return t("activity.drawer.srcBoth");
    if (exported) return t("activity.hosts.transcripts");
    if (ledger) return t("activity.drawer.srcLedger");
    return t("activity.hosts.notConnected");
  };

  const lowerFlags = data.coverage.hosts.filter((host) => host.unread.length).map((host) => {
    const text = t("activity.drawer.flagLower", { host: hostName(host.host, data.coverage.hosts, t), when: when(host) });
    return locale === "uk" ? capitalize(text) : text;
  });
  const flagged = data.days.filter((day) => day.missingSource?.includes("agent-activity"));
  const missingFlags = flagged.length > 3
    ? [t("activity.drawer.flagMissingMany", { count: flagged.length, days: datesText(flagged.map((day) => day.date), data.days, locale, tz) })]
    : flagged.map((day) => capitalize(t("activity.drawer.flagMissing", { day: dayLong(day, locale, tz) })));
  const methodWindows = data.params.breakMin <= data.params.windowMin;

  return (
    <div className="fixed inset-0 z-50" data-activity-drawer="">
      <button type="button" aria-label={t("activity.drawer.close")} tabIndex={-1} className="absolute inset-0 bg-primary/20" onClick={onClose} />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-drawer-title"
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 right-0 w-[460px] overflow-y-auto border-l border-border bg-raised px-[22px] py-[18px] text-[12.5px] leading-[1.5] text-secondary shadow-2"
      >
        <div className="flex items-center justify-between">
          <h2 id="activity-drawer-title" className="text-[15px] font-semibold text-primary">{t("activity.drawer.title")}</h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label={t("activity.drawer.close")}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-secondary hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <h3 className="mb-2 mt-[18px] text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">{t("activity.drawer.range")}</h3>
        {[...lowerFlags, ...missingFlags].map((text) => (
          <div key={text} className="mb-1.5 flex items-start gap-2 rounded-[8px] bg-warning-soft px-2.5 py-2 text-primary" data-activity-flag="">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            <span>{text}</span>
          </div>
        ))}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pb-2 pt-1.5">
          <b className="whitespace-nowrap text-right font-semibold tabular-nums text-primary">{approxText(data.totals.wallMs, t)}</b>
          <span>{t("activity.fig.wall")}</span>
          <b className="whitespace-nowrap text-right font-semibold tabular-nums text-primary">{agentHoursText(data.totals.agentHoursMs, locale)}</b>
          <span>{t("activity.fig.agentHours")}</span>
        </div>
        <div ref={hostsRef} className="scroll-mt-4">
          {data.coverage.hosts.map((host) => (
            <div key={host.host} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 border-t border-border py-2" data-activity-host={host.host} data-complete={host.complete ? "true" : "false"}>
              {host.complete
                ? <Check className="mt-0.5 h-3.5 w-3.5 text-success" aria-hidden />
                : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 text-warning" aria-hidden />}
              <div>
                <span className="font-semibold text-primary">{hostName(host.host, data.coverage.hosts, t)}</span>
                {host.local && host.label ? <span> · {t("activity.hosts.thisHost")}</span> : null}
                <br />
                {sourcesText(host)}
                {host.sources.some((source) => source.state === "read")
                  ? <> · {host.unread.length ? t("activity.drawer.hostGap", { when: when(host) }) : t("activity.drawer.hostRead", { when: dateTimeText(readTo(host) ?? data.range.now, locale, tz) })}</>
                  : null}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mb-2 mt-[18px] text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">{t("activity.drawer.method")}</h3>
        <ul className="grid list-disc gap-1.5 pl-4">
          <li>{t(methodWindows ? "activity.drawer.m1" : "activity.drawer.m1Episodes", { window: data.params.windowMin, break: data.params.breakMin })}</li>
          <li>{t(data.params.rounding === "half-hour" ? "activity.drawer.m2Half" : "activity.drawer.m2")}</li>
          <li>{t("activity.drawer.m3")}</li>
          <li>{t("activity.drawer.m4")}</li>
          <li>{t("activity.drawer.m5", { tz })}</li>
        </ul>

        <details className="mt-3 border-t border-border pt-2.5" data-activity-excluded="">
          <summary className="cursor-pointer font-semibold text-primary">{t("activity.drawer.excluded")}</summary>
          <ul className="mt-2 grid list-disc gap-1.5 pl-4">
            {data.coverage.hosts.map((host) => {
              const counts = EXCLUSION_REASONS
                .map((reason) => [reason, host.sources.reduce((sum, source) => sum + (source.excluded[reason] ?? 0), 0)] as const)
                .filter(([, count]) => count > 0);
              return (
                <li key={host.host}>
                  {hostName(host.host, data.coverage.hosts, t)}: {counts.length
                    ? counts.map(([reason, count]) => t("activity.hosts.excludedItem", { reason: t(`activity.exclusion.${reason}` as MessageKey), count })).join(", ")
                    : t("activity.hosts.excludedNone")}
                </li>
              );
            })}
          </ul>
        </details>
        <details className="mt-3 border-t border-border pt-2.5">
          <summary className="cursor-pointer font-semibold text-primary">{t("activity.coverage.title")}</summary>
          <ul className="mt-2 grid list-disc gap-1.5 pl-4">
            <li>{t("activity.drawer.surf1")}</li>
            <li>{t("activity.drawer.surf2")}</li>
            <li>{t("activity.drawer.surf3")}</li>
          </ul>
        </details>

        <p className="mt-4 text-[11.5px] text-muted">
          {data.coverage.agentIndex !== "ok"
            ? t("activity.drawer.indexing")
            : [
              data.coverage.indexedAtMs !== null ? t("activity.drawer.indexed", { when: dateTimeText(data.coverage.indexedAtMs, locale, tz) }) : null,
              data.coverage.unregisteredConversations ? t("activity.drawer.unregistered", { count: data.coverage.unregisteredConversations }) : null,
            ].filter(Boolean).join(" ")}
        </p>
      </aside>
    </div>
  );
}
