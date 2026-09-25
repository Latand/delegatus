"use client";

import { useEffect, useMemo, useState } from "react";

import type { ReportLogEntry, ReportLogPage } from "@/lib/bridge/reportLog";
import type { BridgeReportClass } from "@/lib/bridge/types";
import { useLocale } from "@/lib/i18n";

import { BridgeReportsRow } from "../../BridgeReportsRow";
import { useBridgeReportsSetting } from "./bridgeReportsSetting";
import { bodySegments, entryTime, readSeenSeq, writeSeenSeq } from "./reportLogModel";
import { useReportLog } from "./useReportLog";

/*
 * The orchestrator's report log (#2146): this project's bridge reports, newest
 * first, beside the seat's chat. Each entry is its local time, its class as a
 * word and its body as written, with `#123` and the board's card ids linked.
 * Nothing else lives here: no lanes, no deploys, no counts, no groups. Entries
 * that arrived since the operator last looked carry a quiet «new». One project
 * per mount: callers key it by the project.
 */

const CLASS_TONE: Record<BridgeReportClass, string> = {
  completed: "text-success",
  failed: "text-danger",
  blocked: "text-warning",
  question: "text-accent",
  review_verdict: "text-secondary",
  status: "text-muted",
};

export function ReportLog({ project, active = true, variant, initial, now }: {
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
  let body: React.ReactNode;
  if (off) {
    body = (
      <div className={column ? "flex flex-col gap-2 px-3 py-3" : "flex flex-col gap-1 py-3"} data-report-log-off="">
        <p className={`text-body text-secondary${column ? "" : " px-4"}`}>{t("reportLog.off")}</p>
        {/* The phone's switch is 44 px, as in its ⋯ sheet. */}
        <BridgeReportsRow project={project} variant={column ? "inline" : "sheet"} />
      </div>
    );
  } else if (!log.loaded) {
    body = (
      <p className="px-3 py-3 text-body text-muted" role="status" data-report-log-state={log.failed ? "failed" : "loading"}>
        {t(log.failed ? "reportLog.failed" : "reportLog.loading")}
      </p>
    );
  } else if (log.entries.length === 0) {
    body = <p className="px-3 py-3 text-body text-muted" data-report-log-empty="">{t("reportLog.empty")}</p>;
  } else {
    body = (
      <>
        <ol className="flex flex-col" data-report-log-entries="">
          {log.entries.map((entry) => (
            <ReportEntry
              key={entry.seq}
              entry={entry}
              github={log.github}
              locale={locale}
              now={now}
              fresh={seenAtOpen !== null && entry.seq > seenAtOpen}
              classLabel={t(`reportLog.class.${entry.class}`)}
              newLabel={t("reportLog.new")}
            />
          ))}
        </ol>
        {log.hasOlder ? (
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
        ) : null}
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">{body}</div>
    </section>
  );
}

function ReportEntry({ entry, github, locale, now, fresh, classLabel, newLabel }: {
  entry: ReportLogEntry;
  github: string | null;
  locale: string;
  now?: Date;
  fresh: boolean;
  classLabel: string;
  newLabel: string;
}) {
  const segments = useMemo(() => bodySegments(entry.body, github, entry.cards), [entry.body, github, entry.cards]);
  return (
    <li
      className="flex flex-col gap-1 border-b border-border px-3 py-2.5"
      data-report-entry={entry.seq}
      data-report-class={entry.class}
      {...(fresh ? { "data-report-new": "" } : {})}
    >
      <div className="flex items-baseline gap-2 text-caption">
        <time dateTime={entry.at} className="tabular-nums text-muted">{entryTime(entry.at, locale, now)}</time>
        <span className={`font-semibold ${CLASS_TONE[entry.class] ?? "text-muted"}`} data-report-class-label="">{classLabel}</span>
        {fresh ? <span className="ml-auto text-accent" data-report-new-mark="">{newLabel}</span> : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-body text-primary [overflow-wrap:anywhere]">
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
