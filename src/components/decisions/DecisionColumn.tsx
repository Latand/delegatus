"use client";

import { MessageCircleQuestionMark } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ChevronRight } from "@/components/icons";
import { ReportLog } from "@/components/orchestrator/reportLog/ReportLog";
import { usePrototypeNoticesFor } from "@/components/prototypeReview/prototypeReviewStore";
import { useLocale } from "@/lib/i18n";
import type { OperatorDecisionView } from "@/lib/prototypeReview/types";

import { DecisionCard, DecisionRecord, DecisionRow } from "./DecisionCard";
import { useOperatorDecisions } from "./useOperatorDecisions";

/*
 * Variant 3 of docs/design/operator-decision-forms.md: the column beside the
 * seat conversation holds two tabs, «Рішення» with every open decision of the
 * project and «Звіти» with the report log as it was. The newest decision is
 * listed first. One decision stands open as its form; the rest are folded to
 * their titles and open on a press, and a press on the open form's header folds
 * it too, until the operator opens one again or a request names one. A saved
 * answer returns as a record while delivery needs attention; confirmed
 * delivery leaves the column, and the seat's feed keeps its record.
 */

export type DecisionTab = "decisions" | "reports";

/** The column's tab when the operator has not picked one: decisions while any wait. */
export function defaultDecisionTab(open: number): DecisionTab {
  return open > 0 ? "decisions" : "reports";
}

/** The column's order: the newest asked first. The read lists them oldest
    first, so equal times keep the later one of the read on top. */
export function newestDecisionsFirst(decisions: readonly OperatorDecisionView[]): OperatorDecisionView[] {
  const at = (decision: OperatorDecisionView) => { const time = Date.parse(decision.createdAt); return Number.isNaN(time) ? 0 : time; };
  return [...decisions].reverse().sort((a, b) => at(b) - at(a));
}

/** How many decisions wait in a project: the page's one poll already counts them. */
export function useOpenDecisionCount(project: string): number {
  return usePrototypeNoticesFor(project).length;
}

export function DecisionList({ project, active = true, focus, touch = false, initial }: {
  project: string;
  active?: boolean;
  /** The decision a request asked to open; its nonce opens it again. */
  focus?: { reviewId?: string; nonce: number } | null;
  /** The phone's sheet: 44 px rows and the frames drawn small. */
  touch?: boolean;
  /** A known list, drawn without a read (the evidence drivers pass one). */
  initial?: OperatorDecisionView[];
}) {
  const { t } = useLocale();
  const read = useOperatorDecisions(project, active, initial);
  const [picked, setPicked] = useState<string | null>(focus?.reviewId ?? null);
  /* Folded by the operator: a view state for this list only, never an answer. */
  const [collapsed, setCollapsed] = useState(false);
  /* The control a press on a row or a header hands the keyboard focus to. */
  const follow = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = listRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  const [seenFocus, setSeenFocus] = useState(focus?.nonce ?? null);
  if (focus && focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce);
    if (focus.reviewId) {
      setPicked(focus.reviewId);
      setCollapsed(false);
    }
  }
  const decisions = newestDecisionsFirst(read.decisions ?? []);
  const expanded = collapsed ? null : decisions.find((decision) => decision.id === picked) ?? decisions[0] ?? null;
  /* A request that named a form brings it into the column's view; a first
     paint scrolls nothing, so the board around the column stays put. */
  const expandedId = expanded?.id ?? null;
  useEffect(() => {
    if (seenFocus === null || !expandedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-decision-review="${expandedId}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [seenFocus, expandedId]);
  /* The pressed row or header leaves the page as it turns: its counterpart takes the focus. */
  useEffect(() => {
    const id = follow.current;
    if (!id) return;
    follow.current = null;
    const target = expandedId === id
      ? listRef.current?.querySelector<HTMLElement>(`[data-decision-review="${id}"] [data-decision-collapse]`)
      : listRef.current?.querySelector<HTMLElement>(`[data-decision-row="${id}"]`);
    target?.focus({ preventScroll: true });
  }, [expandedId]);
  const open = (id: string) => { follow.current = id; setPicked(id); setCollapsed(false); };
  const collapse = (id: string) => { follow.current = id; setCollapsed(true); };
  /* The card is the column's width less its gutter; a narrow column keeps the title. */
  const narrow = touch || (width > 0 && width < 460);
  const columns = width >= 624 && !touch ? 2 : 1;
  let body: ReactNode;
  if (!read.loaded) {
    body = <p role="status" data-decision-list-state={read.failed ? "failed" : "loading"} className="m-0 px-1 py-2 text-body text-muted">{t(read.failed ? "decisions.failed" : "decisions.loading")}</p>;
  } else if (!decisions.length) {
    body = <p data-decision-list-empty="" className="m-0 px-1 py-2 text-body text-muted">{t("decisions.empty")}</p>;
  } else {
    body = decisions.map((decision) => decision.id === expanded?.id
      ? decision.decision
        ? <DecisionRecord key={decision.id} decision={decision} onCollapse={() => collapse(decision.id)}
          onRetry={() => void read.answer(decision.id, { retry: true }, decision)}
          retryError={read.error?.reviewId === decision.id && read.error.kind !== "revoke" ? read.error.message : null}
          onRevoke={() => read.answer(decision.id, { chosen: [], comment: "",
          answers: (decision.questions ?? []).map(question => ({ questionId: question.id, options: [0] })) }, decision)}
          revokeError={read.error?.reviewId === decision.id && read.error.kind !== "retry" ? read.error.message : null} />
        : <DecisionCard key={decision.id} decision={decision} narrow={narrow} columns={columns} onAnswer={read.answer} error={read.error?.reviewId === decision.id ? read.error.message : null} onCollapse={() => collapse(decision.id)} />
      : <DecisionRow key={decision.id} decision={decision} onOpen={() => open(decision.id)} />);
  }
  return (
    <div
      ref={listRef}
      role="region"
      aria-label={t("decisions.listAria")}
      data-decision-list={decisions.length}
      data-decision-expanded={expandedId ?? ""}
      className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain ${touch ? "px-3 pb-4 pt-3" : "p-3"}`}
    >
      {body}
    </div>
  );
}

/** «Рішення N» and «Звіти»: the column's two tabs. */
export function DecisionTabs({ tab, onTab, count, touch = false }: { tab: DecisionTab; onTab: (tab: DecisionTab) => void; count: number; touch?: boolean }) {
  const { t } = useLocale();
  const button = (id: DecisionTab, label: string, badge?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      data-decision-tab={id}
      onClick={() => onTab(id)}
      className={`inline-flex ${touch ? "h-11" : "h-9"} items-center gap-1.5 border-b-2 px-2 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${tab === id ? "border-accent text-primary" : "border-transparent text-muted hover:text-primary"}`}
    >
      {label}
      {badge ? <span data-decision-tab-count={badge} className="rounded-full bg-accent px-1.5 text-caption font-bold leading-4 tabular-nums text-white">{badge}</span> : null}
    </button>
  );
  return (
    <div role="tablist" aria-label={t("decisions.tabsAria")} className="flex shrink-0 items-end gap-2 border-b border-border px-2">
      {button("decisions", t("decisions.tab"), count)}
      {button("reports", t("reportLog.title"))}
    </div>
  );
}

/** The desktop column: the tabs over the decisions or the report log. */
export function DecisionColumn({ project, tab, onTab, focus }: {
  project: string;
  tab: DecisionTab;
  onTab: (tab: DecisionTab) => void;
  focus?: { reviewId?: string; nonce: number } | null;
}) {
  const count = useOpenDecisionCount(project);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card" data-decision-column={tab}>
      <DecisionTabs tab={tab} onTab={onTab} count={count} />
      {tab === "decisions"
        ? <DecisionList key={project} project={project} focus={focus} />
        : <ReportLog key={project} project={project} variant="column" headless />}
    </div>
  );
}

/** One line under the seat's header while decisions wait and the column is
    out of sight: «N чекають рішення ›», opening them. */
export function DecisionStripLine({ count, onOpen, touch = false }: { count: number; onOpen: () => void; touch?: boolean }) {
  const { t } = useLocale();
  if (!count) return null;
  return (
    <button
      type="button"
      data-decision-strip={count}
      aria-label={t("decisions.openAria")}
      onClick={onOpen}
      className={`flex ${touch ? "h-11" : "h-9"} w-full min-w-0 shrink-0 items-center gap-2 border-b border-border bg-accent-soft/60 px-3 text-left hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40`}
    >
      <MessageCircleQuestionMark className="h-4 w-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{t("decisions.waiting", { count })}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-accent" aria-hidden />
    </button>
  );
}
