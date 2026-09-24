"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { REQUEST_KINDS, SURFACES } from "@/lib/activity/method";
import type { ActivityProjectRow } from "@/lib/activity/report";
import type { MessageKey } from "@/lib/i18n";

import { agentHoursText, agentParts, approxText, dayShort, ENGINE_NAMES, hostName, hoursText, minutesText, partsRound, roleName } from "./format";
import { Items } from "./marks";
import type { TipContext } from "./tips";

/*
 * "On which projects" (docs/design/activity-dashboard-v2.md, "Projects"): a
 * ranked list beside the charts, your reported hours and agent time per
 * project. A row opens in place into three lines (you, agents, hosts), and
 * "More detail" opens the remaining breakdowns. The rows fill the column; the
 * rest folds into one "+ N more" row carrying their sums.
 */

type Sort = "you" | "agents";
const MINUTE = 60_000;
const MORE_ROW = 46;

function youValue(row: ActivityProjectRow, unread: boolean, context: TipContext): ReactNode {
  const { locale, t } = context;
  if (unread || (!row.coverage.complete && row.humanHours === 0)) return <span className="font-medium text-muted">?</span>;
  if (row.humanHours === 0) return <span className="font-medium text-muted">0</span>;
  return (
    <>
      {row.coverage.complete ? null : <span className="font-medium text-muted">≥ </span>}
      {hoursText(row.humanHours, locale, t)}
    </>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2">
      <b className="font-semibold text-secondary">{label}</b>
      <span>{children}</span>
    </div>
  );
}

const V = ({ children }: { children: ReactNode }) => <span className="tabular-nums text-primary">{children}</span>;

function Detail({ row, unread, more, onMore, context }: { row: ActivityProjectRow; unread: boolean; more: boolean; onMore(): void; context: TipContext }) {
  const { data, locale, t } = context;
  const tz = data.params.tz;
  const lower = !row.coverage.complete;
  const ge = lower ? "≥ " : "";
  const youItems: ReactNode[] = [];
  youItems.push(unread || (lower && row.humanMs === 0) ? <V>?</V> : <V>{t("activity.fig.byMinute", { value: ge + minutesText(row.humanMs, t) })}</V>);
  youItems.push(t("activity.project.requests", { count: row.requests }));
  if (row.humanReassignedMs >= MINUTE) youItems.push(t("activity.detail.reassigned", { value: minutesText(row.humanReassignedMs, t) }));

  const [supervised, unattended, unclear] = agentParts(row);
  const dayIndex = new Map(data.days.map((day) => [day.date, day]));
  const unclearDays = row.unclearDays.map((date) => dayIndex.get(date)).filter((day) => day !== undefined);
  const where = unclearDays.length <= 2
    ? unclearDays.map((day) => day.start <= data.range.now && data.range.now < day.end ? t("activity.range.today") : dayShort(day, locale, tz)).join(", ")
    : t("activity.detail.days", { count: unclearDays.length });
  const agentItems: ReactNode[] = row.wallMs >= 2.5 * MINUTE ? [
    ...(supervised ? [t("activity.fig.supervised", { value: approxText(supervised, t) })] : []),
    ...(unattended ? [t("activity.fig.unattended", { value: approxText(unattended, t) })] : []),
    ...(unclear ? [unclearDays.length ? t("activity.detail.unclearOn", { value: approxText(unclear, t), days: where }) : t("activity.fig.unclear", { value: approxText(unclear, t) })] : []),
    t("activity.project.agents", { count: row.conversations }),
    t("activity.detail.agentHours", { value: agentHoursText(row.agentHoursMs, locale) }),
  ] : [<V key="none">–</V>];

  const hostItems = Object.entries(row.byHost).filter(([, ms]) => ms >= MINUTE).sort((a, b) => b[1] - a[1])
    .map(([host, ms]) => <>{hostName(host, data.coverage.hosts, t)} <V>{row.coverage.missingHosts.includes(host) ? "≥ " : ""}{minutesText(ms, t)}</V></>);

  /* Engine and role share out agent-hours, rounded so they add up to them. */
  const share = (entries: Array<[string, number]>, label: (key: string) => ReactNode) => {
    const sorted = entries.filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
    const rounded = partsRound(row.agentHoursMs, sorted.map(([, ms]) => ms));
    return sorted.map(([key], index) => rounded[index] ? <>{label(key)} <V>{approxText(rounded[index]!, t)}</V></> : null).filter(Boolean) as ReactNode[];
  };
  const humanShare = (entries: Array<[string, number]>, label: (key: string) => string) => entries
    .filter(([, ms]) => ms >= 2.5 * MINUTE).sort((a, b) => b[1] - a[1])
    .map(([key, ms]) => <>{label(key)} <V>{minutesText(ms, t)}</V></>);

  return (
    <div className="grid gap-[5px] bg-sunken px-[18px] pb-3 pt-0.5 text-[12px] leading-[1.45] text-muted" data-activity-project-details="">
      <Line label={t("activity.fig.you")}><Items items={youItems} /></Line>
      <Line label={t("activity.fig.agents")}><Items items={agentItems} /></Line>
      {hostItems.length ? <Line label={t("activity.detail.hosts")}><Items items={hostItems} /></Line> : null}
      <Line label="">
        <button
          type="button"
          aria-expanded={more}
          onClick={onMore}
          className="mt-px inline-flex items-center gap-1 text-[12px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          data-activity-more-detail=""
        >
          {more ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
          {t("activity.detail.more")}
        </button>
      </Line>
      {more ? (
        <div className="grid gap-[5px] border-t border-border pt-[7px]" data-activity-breakdowns="">
          <Line label={t("activity.detail.surface")}><Items items={humanShare(SURFACES.map((key) => [key, row.bySurface[key]]), (key) => t(`activity.surface.${key}` as MessageKey))} /></Line>
          <Line label={t("activity.detail.kind")}><Items items={humanShare(REQUEST_KINDS.map((key) => [key, row.byKind[key]]), (key) => t(`activity.kind.${key}` as MessageKey))} /></Line>
          <Line label={t("activity.detail.engine")}><Items items={share(Object.entries(row.byEngine), (key) => ENGINE_NAMES[key] ?? key)} /></Line>
          <Line label={t("activity.detail.role")}><Items items={share(Object.entries(row.byRole), (key) => roleName(key, t))} /></Line>
          {row.pipelines.length ? (
            <Line label={t("activity.detail.pipelines")}>
              <Items items={row.pipelines.map((pipeline) => <><span className="font-mono text-[11px] text-secondary">{pipeline.id.slice(0, 8)}</span> {pipeline.stages.join(" · ")} <V>{approxText(pipeline.agentHoursMs, t)}</V></>)} />
            </Line>
          ) : null}
          <div className="text-[11px]">{t("activity.detail.note")}</div>
        </div>
      ) : null}
    </div>
  );
}

export function ActivityProjects({ context, span }: { context: TipContext; span: boolean }) {
  const { data, unread, names, locale, t } = context;
  const [sort, setSort] = useState<Sort>(unread ? "agents" : "you");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [all, setAll] = useState(false);
  const [budget, setBudget] = useState<number | null>(null);
  const [height, setHeight] = useState(0);
  const inner = useRef<HTMLDivElement | null>(null);

  useEffect(() => setSort(unread ? "agents" : "you"), [unread]);

  const rows = useMemo(() => {
    const list = data.projects.filter((row) => row.humanMs > 0 || row.wallMs > 0 || row.requests > 0 || !row.coverage.complete);
    return sort === "agents"
      ? list.sort((a, b) => b.wallMs - a.wallMs || b.humanHours - a.humanHours || b.humanMs - a.humanMs)
      : list.sort((a, b) => b.humanHours - a.humanHours || b.humanMs - a.humanMs || b.wallMs - a.wallMs);
  }, [data.projects, sort]);
  const maxHours = Math.max(0.5, ...rows.map((row) => row.humanHours));

  useEffect(() => {
    const node = inner.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  /* Measure again whenever what is drawn or the room for it changes. */
  useLayoutEffect(() => setBudget(null), [rows, expanded, more, height, all]);
  useLayoutEffect(() => {
    const node = inner.current;
    if (budget !== null || !node || all) return;
    if (node.scrollHeight <= node.clientHeight + 1) {
      setBudget(rows.length);
      return;
    }
    let fit = 0;
    for (const item of node.querySelectorAll<HTMLElement>("[data-activity-project]")) {
      if (item.offsetTop + item.offsetHeight + MORE_ROW <= node.clientHeight) fit += 1;
      else break;
    }
    setBudget(Math.max(3, fit));
  }, [budget, rows.length, all]);

  const key = (row: ActivityProjectRow) => row.project ?? "";
  let shown = rows;
  let rest: ActivityProjectRow[] = [];
  if (!all && budget !== null && budget < rows.length) {
    shown = rows.slice(0, budget);
    if (expanded !== null && !shown.some((row) => key(row) === expanded)) {
      const open = rows.find((row) => key(row) === expanded);
      if (open) shown = [...rows.slice(0, budget - 1), open];
    }
    rest = rows.filter((row) => !shown.includes(row));
  }
  const restHours = rest.reduce((sum, row) => sum + row.humanHours, 0);
  const restAgents = rest.reduce((sum, row) => sum + row.wallMs, 0);

  const header = (column: Sort, label: string) => (
    <button
      type="button"
      onClick={() => setSort(column)}
      aria-pressed={sort === column}
      aria-label={t("activity.col.sort", { column: label })}
      className={`inline-flex items-center justify-end gap-0.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${sort === column ? "text-primary" : "text-muted hover:text-primary"}`}
      data-activity-sort={column}
    >
      {label}
      {sort === column ? <ChevronDown className="h-3 w-3" aria-hidden /> : null}
    </button>
  );

  return (
    <aside className={`relative col-start-2 row-start-1 min-h-[200px] self-stretch ${span ? "row-span-2" : ""} rounded-[12px] border border-border bg-card shadow-1`} aria-labelledby="activity-projects-title" data-activity-projects="">
      <div ref={inner} className={`absolute inset-x-0 bottom-0 top-3.5 ${all ? "overflow-y-auto" : "overflow-hidden"}`}>
        <div className="grid grid-cols-[minmax(0,1fr)_64px_92px] items-center gap-2 px-[18px] pb-2">
          <h2 id="activity-projects-title" className="flex items-baseline gap-2 text-[13px] font-semibold text-primary">
            {t("activity.view.projects")}
            <span className="text-[12px] font-medium text-muted">{rows.length}</span>
          </h2>
          {header("you", t("activity.col.you"))}
          {header("agents", t("activity.col.agents"))}
        </div>
        {rows.length ? (
          <ul>
            {shown.map((row) => {
              const open = expanded === key(row);
              const name = names.get(row.project) ?? "";
              return (
                <li key={key(row)} data-activity-project={key(row)} data-coverage={row.coverage.complete ? "complete" : "unknown"}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => { setExpanded(open ? null : key(row)); setMore(false); }}
                    className={`grid w-full grid-cols-[minmax(0,1fr)_64px_92px] items-center gap-2 border-t border-border px-[18px] pb-[9px] pt-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${open ? "bg-sunken" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-primary" title={name}>{name}</span>
                        {row.billable ? <span className="whitespace-nowrap rounded-full border border-border px-1.5 text-[10px] font-semibold leading-4 text-secondary">{t("activity.project.billable")}</span> : null}
                      </div>
                      <div className="mt-1.5 h-1 rounded-r-[2px]" style={{ width: `${(row.humanHours / maxHours) * 100}%`, background: row.humanHours > 0 && !unread ? "var(--mark-you)" : "none" }} aria-hidden />
                    </div>
                    <div className="text-right text-[13px] font-semibold tabular-nums whitespace-nowrap text-primary" data-activity-project-you="">{youValue(row, unread, context)}</div>
                    <div className="text-right text-[12px] tabular-nums whitespace-nowrap text-secondary" data-activity-project-agents="">{approxText(row.wallMs, t)}</div>
                  </button>
                  {open ? <Detail row={row} unread={unread} more={more} onMore={() => setMore((value) => !value)} context={context} /> : null}
                </li>
              );
            })}
            {rest.length ? (
              <li>
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_64px_92px] items-center gap-2 border-t border-border px-[18px] pb-[9px] pt-2 text-left text-secondary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                  data-activity-projects-more={rest.length}
                >
                  <span className="text-[13px] font-medium">{t("activity.projects.more", { count: rest.length })}</span>
                  <span className="text-right text-[13px] font-semibold tabular-nums whitespace-nowrap">
                    {unread ? <span className="font-medium text-muted">?</span> : restHours ? hoursText(restHours, locale, t) : <span className="font-medium text-muted">0</span>}
                  </span>
                  <span className="text-right text-[12px] tabular-nums whitespace-nowrap">{approxText(restAgents, t)}</span>
                </button>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="border-t border-border px-[18px] py-6 text-center text-[12px] text-muted">{t("activity.projects.none")}</p>
        )}
      </div>
    </aside>
  );
}
