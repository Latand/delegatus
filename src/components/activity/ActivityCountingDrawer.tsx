"use client";

import { Check, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { Z } from "@/components/layers";
import { EXCLUSION_REASONS, type Interval } from "@/lib/activity/method";
import type { ActivityHostRow } from "@/lib/activity/report";
import { estimateCost, PRICE_SOURCES, PRICE_TABLE_DATE } from "@/lib/activity/tokenPrices";
import type { MessageKey } from "@/lib/i18n";

import { agentHoursText, approxAtLeast, clockText, dateTimeText, datesText, dayLong, hostName, scopeHosts } from "./format";
import type { TipContext } from "./tips";
import { coverageLines, entityName, exact, Optional, tokenTrust, type TokenCtx } from "./tokenParts";

/*
 * Question 4 on demand (docs/design/activity-dashboard-v2.md, "Trust chip and
 * the How it's counted drawer"): every problem of the range said once, in
 * plain words, the two agent measures, one row per host, the method in five
 * bullets, and the exclusions and surfaces collapsed. Opened from the Tokens
 * tab it holds the tokens section instead (docs/design/activity-token-usage.md
 * §9.1): what is read, what is not, and how the price estimate is made.
 */

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** The drawer's panel: the backdrop, the dialog and its focus trap. Focus
    moves to the close button and returns to the opener when it closes. */
function DrawerPanel({ title, closeLabel, onClose, onOpened, children }: {
  title: string;
  closeLabel: string;
  onClose(): void;
  onOpened?(): void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);
  const opened = useRef(onOpened);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    opened.current?.();
    return () => opener?.focus();
  }, []);

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

  return (
    <div className={`fixed inset-0 ${Z.modal}`} data-activity-drawer="">
      <button type="button" aria-label={closeLabel} tabIndex={-1} className="absolute inset-0 bg-primary/20" onClick={onClose} />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-drawer-title"
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 right-0 w-[460px] max-w-full overflow-y-auto border-l border-border bg-raised px-[22px] py-[18px] text-[12.5px] leading-[1.5] text-secondary shadow-2 max-sm:px-4"
      >
        <div className="flex items-center justify-between">
          <h2 id="activity-drawer-title" className="text-[15px] font-semibold text-primary">{title}</h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-secondary hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-11"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function ActivityCountingDrawer({ context, focusHosts, onClose }: { context: TipContext; focusHosts: boolean; onClose(): void }) {
  const { data, locale, t } = context;
  const tz = data.params.tz;
  const hostsRef = useRef<HTMLDivElement | null>(null);

  const today = data.range.key === "today";
  const todayDay = data.days.find((day) => day.start <= data.range.now && data.range.now < day.end);
  const span = (start: number, end: number) => `${clockText(start, locale, tz)}–${clockText(Math.min(end, data.range.now), locale, tz)}`;
  /** When a host was not read: the day runs, or today's hours. */
  const when = (unread: readonly Interval[]): string => {
    const touched = data.days.filter((day) => unread.some((gap) => gap.start < day.end && gap.end > day.start)).map((day) => day.date);
    if (today || (touched.length === 1 && todayDay && touched[0] === todayDay.date)) {
      const spans = unread.map((gap) => span(Math.max(gap.start, todayDay?.start ?? gap.start), gap.end)).join(", ");
      return t("activity.drawer.whenToday", { span: spans });
    }
    return t("activity.drawer.whenDays", { days: datesText(touched, data.days, locale, tz) });
  };
  const same = (a: readonly Interval[], b: readonly Interval[]) => a.length === b.length && a.every((gap, index) => gap.start === b[index]!.start && gap.end === b[index]!.end);
  const agentsUnread = (host: ActivityHostRow): readonly Interval[] => host.agentsUnread ?? [];
  const readTo = (host: ActivityHostRow): number | null => {
    let latest: number | null = null;
    for (const source of host.sources) for (const covered of source.covered) latest = Math.max(latest ?? 0, Math.min(covered.end, data.range.now));
    return latest;
  };
  const sourcesText = (host: ActivityHostRow): string => {
    const read = host.sources.filter((source) => source.state === "read");
    const ledger = read.some((source) => source.source === "ledger");
    const exported = read.some((source) => source.source === "transcripts");
    /* The host's own record: this host's ingest, or another host's pull. */
    const recorded = read.find((source) => source.source === "ingest" || source.source === "pull");
    if (recorded) {
      const name = t(recorded.source === "ingest" ? "activity.hosts.ingest" : "activity.hosts.pull");
      return ledger ? t("activity.drawer.srcLedgerAnd", { source: name.charAt(0).toLocaleLowerCase(locale) + name.slice(1) }) : name;
    }
    if (ledger && exported) return t("activity.drawer.srcBoth");
    if (exported) return t("activity.hosts.transcripts");
    if (ledger) return t("activity.drawer.srcLedger");
    return t("activity.hosts.notConnected");
  };

  /* One row per host whose gap bears on the figures shown: your time, its
     agents' time, or both when the same stretch misses both. */
  const lowerFlags = scopeHosts(data).flatMap((host) => {
    const name = hostName(host.host, data.coverage.hosts, t);
    const agents = agentsUnread(host);
    const texts = host.unread.length && agents.length && same(host.unread, agents)
      ? [t("activity.drawer.flagBoth", { host: name, when: when(host.unread) })]
      : [
        ...(host.unread.length ? [t("activity.drawer.flagLower", { host: name, when: when(host.unread) })] : []),
        ...(agents.length ? [t("activity.drawer.flagAgents", { host: name, when: when(agents) })] : []),
      ];
    return texts.map((text) => (locale === "uk" ? capitalize(text) : text));
  });
  const agentsLower = !data.totals.agentCoverage.complete;
  const flagged = data.days.filter((day) => day.missingSource?.includes("agent-activity"));
  const missingFlags = flagged.length > 3
    ? [t("activity.drawer.flagMissingMany", { count: flagged.length, days: datesText(flagged.map((day) => day.date), data.days, locale, tz) })]
    : flagged.map((day) => capitalize(t("activity.drawer.flagMissing", { day: dayLong(day, locale, tz) })));
  const methodWindows = data.params.breakMin <= data.params.windowMin;

  return (
    <DrawerPanel title={t("activity.drawer.title")} closeLabel={t("activity.drawer.close")} onClose={onClose} onOpened={() => { if (focusHosts) hostsRef.current?.scrollIntoView({ block: "start" }); }}>
      <h3 className="mb-2 mt-[18px] text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">{t("activity.drawer.range")}</h3>
      {[...lowerFlags, ...missingFlags].map((text) => (
        <div key={text} className="mb-1.5 flex items-start gap-2 rounded-[8px] bg-warning-soft px-2.5 py-2 text-primary" data-activity-flag="">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>{text}</span>
        </div>
      ))}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pb-2 pt-1.5">
        <b className="whitespace-nowrap text-right font-semibold tabular-nums text-primary">{approxAtLeast(data.totals.wallMs, agentsLower, t)}</b>
        <span>{t("activity.fig.wall")}</span>
        <b className="whitespace-nowrap text-right font-semibold tabular-nums text-primary">{agentsLower ? "≥ " : ""}{agentHoursText(data.totals.agentHoursMs, locale)}</b>
        <span>{t("activity.fig.agentHours")}</span>
      </div>
      <div ref={hostsRef} className="scroll-mt-4">
        {data.coverage.hosts.map((host) => (
          <div key={host.host} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 border-t border-border py-2" data-activity-host={host.host} data-complete={host.complete ? "true" : "false"} data-agents-complete={agentsUnread(host).length ? "false" : "true"}>
            {host.complete && !agentsUnread(host).length
              ? <Check className="mt-0.5 h-3.5 w-3.5 text-success" aria-hidden />
              : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 text-warning" aria-hidden />}
            <div>
              <span className="font-semibold text-primary">{hostName(host.host, data.coverage.hosts, t)}</span>
              {host.local && host.label ? <span> · {t("activity.hosts.thisHost")}</span> : null}
              <br />
              {sourcesText(host)}
              {host.sources.some((source) => source.state === "read")
                ? <> · {host.unread.length ? t("activity.drawer.hostGap", { when: when(host.unread) }) : t("activity.drawer.hostRead", { when: dateTimeText(readTo(host) ?? data.range.now, locale, tz) })}</>
                : null}
              {agentsUnread(host).length ? <> · {t("activity.drawer.agentsGap", { when: when(agentsUnread(host)) })}</> : null}
              {host.configurationGap ? <div className="font-semibold text-warning" data-activity-member-gap="">{t(host.local ? "activity.hosts.signInGap" : "activity.hosts.memberGap")}</div> : null}
              <div className="text-muted" data-activity-unknown-author={host.unknownAuthors}>
                {t("activity.counted.unknownAuthor", { count: host.unknownAuthors })}
              </div>
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
    </DrawerPanel>
  );
}

const PRICE_SOURCE_NAMES = ["Anthropic", "OpenAI"] as const;

/** The drawer opened from the Tokens tab: its coverage, what a count is,
    and the dated price table behind the estimate. */
export function TokensCountingDrawer({ ctx, onClose }: { ctx: TokenCtx; onClose(): void }) {
  const { answer, locale, t } = ctx;
  const { coverage } = answer;
  const trust = tokenTrust(answer);
  const estimate = estimateCost(answer.costBasis);
  const heading = "mb-2 mt-[18px] text-[11px] font-semibold uppercase tracking-[0.04em] text-muted";
  const notes = [
    coverage.skippedOld > 0 ? t("activity.tokens.drawer.skippedOld", { count: coverage.skippedOld }) : null,
    coverage.malformed > 0 ? t("activity.tokens.drawer.malformed", { count: exact(coverage.malformed, locale) }) : null,
    coverage.daysZone ? (coverage.daysZone.before === "9999-12-31"
      ? t("activity.tokens.drawer.zoneAll", { zone: coverage.daysZone.zone })
      : t("activity.tokens.drawer.zone", { zone: coverage.daysZone.zone, date: coverage.daysZone.before })) : null,
    coverage.roundedHourEdges && answer.params.bucket === "hour" ? t("activity.tokens.drawer.roundedHours", { tz: answer.params.tz }) : null,
  ].filter((line): line is string => line !== null);
  return (
    <DrawerPanel title={t("activity.drawer.title")} closeLabel={t("activity.drawer.close")} onClose={onClose}>
      <h3 className={heading}>{t("activity.tokens.drawer.title")}</h3>
      <div className={`mb-2 flex items-start gap-2 rounded-[8px] px-2.5 py-2 text-primary ${trust === "ok" ? "bg-sunken" : "bg-warning-soft"}`} data-token-drawer-trust={trust}>
        {trust === "ok" ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden /> : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />}
        <span>{t(trust === "ok" ? "activity.tokens.coverage.ok" : trust === "lower" ? "activity.tokens.coverage.lower" : "activity.tokens.coverage.none")}</span>
      </div>
      <ul className="grid list-disc gap-1.5 pl-4" data-token-drawer-lines="">
        {coverageLines(ctx).map((line) => <li key={line}>{line}</li>)}
        <li>{t("activity.tokens.drawer.engines")}</li>
        <li>{t("activity.tokens.drawer.unit")}</li>
        <li>{t("activity.tokens.drawer.kinds")}</li>
        {notes.map((line) => <li key={line}>{line}</li>)}
        <li>{t("activity.drawer.m5", { tz: answer.params.tz })}</li>
      </ul>
      <h3 className={heading}><Optional t={t} />{t("activity.tokens.drawer.costTitle")}</h3>
      <p data-token-drawer-cost="">{t("activity.tokens.drawer.cost", { date: PRICE_TABLE_DATE })}</p>
      {estimate.unpricedModels.length ? (
        <p className="mt-1.5">{t("activity.tokens.extra.costUnpriced", { models: estimate.unpricedModels.map((model) => entityName("model", model, ctx)).join(", ") })}</p>
      ) : null}
      <p className="mt-1.5">
        {t("activity.tokens.drawer.sources")}{" "}
        {PRICE_SOURCES.map((url, index) => (
          <span key={url}>
            {index > 0 ? ", " : null}
            <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{PRICE_SOURCE_NAMES[index]}</a>
          </span>
        ))}
      </p>
    </DrawerPanel>
  );
}
