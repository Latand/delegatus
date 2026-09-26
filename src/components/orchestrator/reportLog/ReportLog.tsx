"use client";

import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { layeredReportResolution, sendDismissal, useDismissalLayerVersion } from "@/components/attention/dismissalOverlay";
import { roleNameById } from "@/components/builderCopy";
import type { DismissalSubjectRequest } from "@/lib/attention/dismissalTypes";
import type { ReportLogAsk } from "@/lib/asks/types";
import type { ReportLogEntry, ReportLogPage, ReportLogQuestions } from "@/lib/bridge/reportLog";
import type { BridgeReportClass } from "@/lib/bridge/types";
import { useLocale, type TFunction } from "@/lib/i18n";

import { BridgeReportsRow } from "../../BridgeReportsRow";
import { useBridgeReportsSetting } from "./bridgeReportsSetting";
import { askHref, bodySegments, entryTime, readSeenSeq, reportLogRows, writeSeenSeq } from "./reportLogModel";
import { useReportLog } from "./useReportLog";

/*
 * The orchestrator's report log (#2146): this project's bridge reports, newest
 * first, beside the seat's chat. Each entry is its local time, its class as a
 * word and its body as written, with `#123` and the board's card ids linked.
 * Between them, by time, the Viewer's own "Asks you" lines: an agent that
 * asked the operator, linked to its conversation (docs/research/attention-classifier.md
 * §7.4). Nothing else lives here: no lanes, no deploys, no groups. Entries
 * that arrived since the operator last looked carry a quiet «new». One project
 * per mount: callers key it by the project.
 *
 * The orchestrator's questions (`question`, `blocked`) carry a tick. A question
 * still asking is also a row of the needs-you panel, and both surfaces resolve
 * it through the one needs-you dismissal (`sendDismissal`, a `report` subject),
 * which the server records on the report itself: tick it here or dismiss it
 * there and it is resolved in both, durably. A resolved question stays in the
 * log, dimmed, with its check. The bar above the entries counts the open
 * questions, steps between them, resolves them all, and clears the resolved
 * ones out of the view (on this device; the rows stay in the log).
 */

type QuestionState = "open" | "resolved" | null;

function isQuestion(entry: ReportLogEntry): boolean {
  return entry.class === "question" || entry.class === "blocked";
}

/** Where one question stands: the server's page, with a click this device
    made since drawn over it (`layeredReportResolution`). */
function questionState(entry: ReportLogEntry, open: ReadonlySet<number>, resolved: ReadonlySet<number>): QuestionState {
  if (!isQuestion(entry)) return null;
  const layered = layeredReportResolution(entry.seq);
  if (layered === true) return "resolved";
  if (layered === false) return "open";
  if (resolved.has(entry.seq)) return "resolved";
  return open.has(entry.seq) ? "open" : null;
}

const HIDE_KEY = (project: string) => `llvReportLogHideResolved:${project}`;

function readHidden(project: string): boolean {
  try {
    return window.localStorage.getItem(HIDE_KEY(project)) === "1";
  } catch {
    return false;
  }
}

function writeHidden(project: string, hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(HIDE_KEY(project), "1");
    else window.localStorage.removeItem(HIDE_KEY(project));
  } catch {
    /* private mode: the choice lasts while the log is open */
  }
}

const CLASS_TONE: Record<BridgeReportClass, string> = {
  completed: "text-success",
  failed: "text-danger",
  blocked: "text-warning",
  question: "text-accent",
  review_verdict: "text-secondary",
  status: "text-muted",
};

export function ReportLog({ project, active = true, variant, initial, now, dismiss = sendDismissal }: {
  project: string;
  /** Loads and follows the log only while it shows. */
  active?: boolean;
  /** `column`: the desktop panel beside the chat, with its own heading.
      `screen`: the phone's screen, whose bar already names it. */
  variant: "column" | "screen";
  /** A known page, drawn without a read (the evidence drivers pass one). */
  initial?: ReportLogPage;
  /** The clock entry times read against (the evidence drivers pin it). */
  now?: Date;
  /** Test seam. */
  dismiss?: typeof sendDismissal;
}) {
  const { t, locale } = useLocale();
  const log = useReportLog(project, active, initial);
  const setting = useBridgeReportsSetting(project, log.bridgeReports ?? undefined);
  const off = setting.enabled === false;

  /* Where the operator had looked when this log opened: everything newer is
     «new» for as long as it stays open, and what it shows counts as seen. */
  const [seenAtOpen] = useState(() => (typeof window === "undefined" ? null : readSeenSeq(project)));
  const newest = log.entries[0]?.seq ?? null;
  useEffect(() => {
    if (!active || off || newest === null) return;
    writeSeenSeq(project, newest);
  }, [active, off, newest, project]);

  const column = variant === "column";
  const rows = useMemo(
    () => reportLogRows(log.entries, log.asks, { reports: !log.olderReports, asks: !log.olderAsks }),
    [log.entries, log.asks, log.olderReports, log.olderAsks],
  );
  const askLines = (asks: readonly ReportLogAsk[]) => (
    <ol className="flex flex-col" data-report-log-asks="">
      {asks.map((ask) => <AskLine key={ask.id} ask={ask} t={t} locale={locale} now={now} />)}
    </ol>
  );
  const olderButton = (
    <div className="px-3 py-2">
      <button
        type="button"
        data-report-log-older=""
        disabled={log.loadingOlder}
        onClick={log.loadOlder}
        className={`w-full rounded-control border border-border bg-card px-3 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${column ? "min-h-8" : "min-h-11"}`}
      >
        {log.loadingOlder ? t("reportLog.loading") : t("reportLog.older")}
      </button>
    </div>
  );
  const surface = column ? "desktop" : "phone";
  useDismissalLayerVersion();
  const openSet = useMemo(() => new Set(log.questions.open), [log.questions.open]);
  const resolvedSet = useMemo(() => new Set(log.questions.resolved.map((entry) => entry.seq)), [log.questions.resolved]);
  const states = new Map(log.entries.map((entry) => [entry.seq, questionState(entry, openSet, resolvedSet)] as const));
  const openShown = log.entries.filter((entry) => states.get(entry.seq) === "open");
  const resolvedShown = log.entries.filter((entry) => states.get(entry.seq) === "resolved");
  /* The open count is the project's, loaded or not, less what this device
     has resolved and the server has not answered for yet. */
  const openCount = openQuestionCount(log.questions, log.entries, states);
  const [hideResolved, setHideResolved] = useState(() => (typeof window === "undefined" ? false : readHidden(project)));
  const [current, setCurrent] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const resolve = (seqs: readonly number[], undo = false) => {
    if (!seqs.length) return;
    const subjects: DismissalSubjectRequest[] = seqs.map((seq) => ({ kind: "report", seq }));
    void dismiss({ kind: "subjects", subjects }, subjects, { undo, surface });
  };
  const step = (dir: 1 | -1) => {
    if (!openShown.length) return;
    const at = current === null ? -1 : openShown.findIndex((entry) => entry.seq === current);
    const next = at === -1 ? (dir === 1 ? 0 : openShown.length - 1) : (at + dir + openShown.length) % openShown.length;
    const seq = openShown[next]!.seq;
    setCurrent(seq);
    listRef.current?.querySelector<HTMLElement>(`[data-report-entry="${seq}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const toggleHidden = () => {
    writeHidden(project, !hideResolved);
    setHideResolved(!hideResolved);
  };
  const touch = column ? "min-h-7" : "min-h-11";
  const QUIET = `inline-flex ${touch} shrink-0 items-center rounded-[6px] px-2 text-caption font-semibold text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50`;
  const questionBar = openCount > 0 || resolvedShown.length > 0 ? (
    <div className={`flex shrink-0 flex-wrap items-center gap-1 border-b border-border ${column ? "px-2 py-1" : "px-3 py-1"}`} data-report-questions="">
      <span className="mr-auto pl-1 text-caption font-semibold text-secondary" data-report-open-count={openCount}>
        {openCount ? t("reportLog.openQuestions", { count: openCount }) : t("reportLog.noOpenQuestions")}
      </span>
      <button type="button" className={QUIET} disabled={!openShown.length} aria-label={t("reportLog.prevQuestion")} title={t("reportLog.prevQuestion")} data-report-question-prev="" onClick={() => step(-1)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" className={QUIET} disabled={!openShown.length} aria-label={t("reportLog.nextQuestion")} title={t("reportLog.nextQuestion")} data-report-question-next="" onClick={() => step(1)}>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" className={QUIET} disabled={!openCount} data-report-resolve-all="" onClick={() => resolve(openQuestionSeqs(log.questions, log.entries, states))}>
        {t("reportLog.resolveAll")}
      </button>
      {resolvedShown.length ? (
        <button type="button" className={QUIET} data-report-hide-resolved={hideResolved ? "hidden" : "shown"} onClick={toggleHidden}>
          {hideResolved ? t("reportLog.showResolved", { count: resolvedShown.length }) : t("reportLog.clearResolved")}
        </button>
      ) : null}
    </div>
  ) : null;
  let body: React.ReactNode;
  if (off) {
    body = (
      <>
        <div className={column ? "flex flex-col gap-2 px-3 py-3" : "flex flex-col gap-1 py-3"} data-report-log-off="">
          <p className={`text-body text-secondary${column ? "" : " px-4"}`}>{t("reportLog.off")}</p>
          {/* The phone's switch is 44 px, as in its ⋯ sheet. */}
          <BridgeReportsRow project={project} variant={column ? "inline" : "sheet"} />
        </div>
        {/* The asks are the Viewer's, not the orchestrator's: its switch does not hide them. */}
        {log.asks.length ? askLines(log.asks) : null}
        {log.olderAsks ? olderButton : null}
      </>
    );
  } else if (!log.loaded) {
    body = (
      <p className="px-3 py-3 text-body text-muted" role="status" data-report-log-state={log.failed ? "failed" : "loading"}>
        {t(log.failed ? "reportLog.failed" : "reportLog.loading")}
      </p>
    );
  } else if (rows.length === 0) {
    body = <p className="px-3 py-3 text-body text-muted" data-report-log-empty="">{t("reportLog.empty")}</p>;
  } else {
    body = (
      <>
        <ol ref={listRef} className="flex flex-col" data-report-log-entries="">
          {rows.filter((row) => !(hideResolved && row.kind === "report" && states.get(row.entry.seq) === "resolved")).map((row) => row.kind === "ask" ? <AskLine key={row.key} ask={row.ask} t={t} locale={locale} now={now} /> : (
            <ReportEntry
              key={row.key}
              entry={row.entry}
              question={states.get(row.entry.seq) ?? null}
              current={current === row.entry.seq}
              touch={!column}
              onResolve={(resolved) => resolve([row.entry.seq], !resolved)}
              github={log.github}
              locale={locale}
              now={now}
              fresh={seenAtOpen !== null && row.entry.seq > seenAtOpen}
              classLabel={t(`reportLog.class.${row.entry.class}`)}
              newLabel={t("reportLog.new")}
            />
          ))}
        </ol>
        {log.hasOlder ? olderButton : null}
      </>
    );
  }

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-card"
      aria-label={t("reportLog.regionAria")}
      data-report-log={project}
      data-report-log-variant={variant}
    >
      {column ? (
        <h2 className="flex h-9 shrink-0 items-center border-b border-border px-3 text-ui font-semibold text-secondary">{t("reportLog.title")}</h2>
      ) : null}
      {off ? null : questionBar}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">{body}</div>
    </section>
  );
}

/** Who asked, in the board's words: the agent's role, else its title. */
function askAgent(t: TFunction, ask: ReportLogAsk): string {
  return ask.role ? roleNameById(t, ask.role) : ask.title?.trim() || t("reportLog.askAgent");
}

/**
 * One "Asks you" line: «‹agent› asks you: ‹the sentence that asks›». The agent
 * is the link, and it opens that agent's conversation.
 */
function AskLine({ ask, t, locale, now }: { ask: ReportLogAsk; t: TFunction; locale: string; now?: Date }) {
  const agent = askAgent(t, ask);
  return (
    <li className="flex flex-col gap-1 border-b border-border px-3 py-2.5" data-report-ask={ask.id}>
      <div className="flex items-baseline gap-2 text-caption">
        <time dateTime={ask.at} className="tabular-nums text-muted">{entryTime(ask.at, locale, now)}</time>
        <span className="font-semibold text-accent" data-report-class-label="">{t("reportLog.class.ask")}</span>
      </div>
      <p className="break-words text-body text-primary [overflow-wrap:anywhere]">
        <a
          href={askHref(ask)}
          data-report-link="conversation"
          aria-label={t("reportLog.askOpen", { agent })}
          className="font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {agent}
        </a>
        {" "}
        {ask.gist ? t("reportLog.askLine", { gist: ask.gist }) : t("reportLog.askBare")}
      </p>
    </li>
  );
}

/** Every open question of the project that this device has not resolved. */
function openQuestionSeqs(questions: ReportLogQuestions, entries: readonly ReportLogEntry[], states: ReadonlyMap<number, QuestionState>): number[] {
  const seqs = new Set(questions.open.filter((seq) => layeredReportResolution(seq) !== true));
  for (const entry of entries) if (states.get(entry.seq) === "open") seqs.add(entry.seq);
  return [...seqs];
}

function openQuestionCount(questions: ReportLogQuestions, entries: readonly ReportLogEntry[], states: ReadonlyMap<number, QuestionState>): number {
  return openQuestionSeqs(questions, entries, states).length;
}

function ReportEntry({ entry, question, current, touch, onResolve, github, locale, now, fresh, classLabel, newLabel }: {
  entry: ReportLogEntry;
  question: QuestionState;
  current: boolean;
  touch: boolean;
  onResolve: (resolved: boolean) => void;
  github: string | null;
  locale: string;
  now?: Date;
  fresh: boolean;
  classLabel: string;
  newLabel: string;
}) {
  const { t } = useLocale();
  const segments = useMemo(() => bodySegments(entry.body, github, entry.cards), [entry.body, github, entry.cards]);
  const resolved = question === "resolved";
  return (
    <li
      className={`flex flex-col gap-1 border-b border-border px-3 py-2.5 ${current ? "ring-2 ring-inset ring-accent/40" : ""}`}
      data-report-entry={entry.seq}
      data-report-class={entry.class}
      {...(question ? { "data-report-question": question } : {})}
      {...(current ? { "data-report-current": "" } : {})}
      {...(fresh ? { "data-report-new": "" } : {})}
    >
      <div className="flex items-center gap-2 text-caption">
        {question ? (
          <label className={`-my-1 inline-flex shrink-0 cursor-pointer items-center ${touch ? "min-h-11 min-w-8" : ""}`} title={t(resolved ? "reportLog.unresolve" : "reportLog.resolve")}>
            <input
              type="checkbox"
              className="h-4 w-4 cursor-pointer accent-accent"
              checked={resolved}
              aria-label={t(resolved ? "reportLog.unresolve" : "reportLog.resolve")}
              data-report-resolve={entry.seq}
              onChange={(event) => onResolve(event.target.checked)}
            />
          </label>
        ) : null}
        <time dateTime={entry.at} className="tabular-nums text-muted">{entryTime(entry.at, locale, now)}</time>
        <span className={`font-semibold ${resolved ? "text-muted" : CLASS_TONE[entry.class] ?? "text-muted"}`} data-report-class-label="">{classLabel}</span>
        {resolved ? (
          <span className="inline-flex items-center gap-0.5 text-success" data-report-resolved-mark="">
            <Check className="h-3 w-3" aria-hidden />
            {t("reportLog.resolved")}
          </span>
        ) : null}
        {fresh ? <span className="ml-auto text-accent" data-report-new-mark="">{newLabel}</span> : null}
      </div>
      <p className={`whitespace-pre-wrap break-words text-body [overflow-wrap:anywhere] ${resolved ? "text-muted" : "text-primary"}`}>
        {segments.map((segment, index) =>
          segment.kind === "text" ? (
            <span key={index}>{segment.text}</span>
          ) : segment.kind === "github" ? (
            <a
              key={index}
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer"
              data-report-link="github"
              className="text-accent underline-offset-2 hover:underline"
            >
              {segment.text}
            </a>
          ) : (
            <button
              key={index}
              type="button"
              data-report-link="card"
              data-report-card={segment.card.id}
              onClick={() => window.dispatchEvent(new CustomEvent("llv:mcp-navigate", { detail: { kind: segment.card.kind, id: segment.card.id } }))}
              className="inline p-0 text-left font-mono text-[0.92em] text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {segment.text}
            </button>
          ))}
      </p>
    </li>
  );
}
