"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale, type MessageKey } from "@/lib/i18n";
import type { WorktreePage } from "@/lib/pipelines/worktreeDrilldown";
import { fmtBytes } from "./fmtBytes";

const BUTTON = "min-h-11 rounded-control border border-border px-3 text-xs font-semibold hover:bg-sunken disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function WorktreeDrilldown({ onClose }: { onClose: () => void }) {
  const { t, locale } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ page?: WorktreePage; error?: string; cursor: string | null } | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/resources/worktrees" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          const key = response.status === 409 ? "changed" : response.status === 403 ? "denied" : "unavailable";
          if (!controller.signal.aborted) setResult({ error: key, cursor });
          return;
        }
        const page = await response.json() as WorktreePage;
        if (!controller.signal.aborted) {
          setResult({ page, cursor });
          body.current?.scrollTo(0, 0);
        }
      } catch {
        if (!controller.signal.aborted) setResult({ error: "offline", cursor });
      }
    })();
    return () => controller.abort();
  }, [cursor, retry]);
  const navigate = (next: string | null) => {
    // Transfer focus before React disables or removes the initiating control.
    dialog.current?.focus();
    setCursor(next);
  };
  const date = (at: string | null) => at ? new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : t("worktrees.unknownTime");
  const page = result?.page;
  // The previous page stays on screen, dimmed, until the next one arrives, so the dialog never changes size under the pager.
  const loadingMore = !!page && result?.cursor !== cursor;
  const paged = !!page && page.rows.length > 0 && (!!page.previousCursor || !!page.nextCursor);
  return createPortal(
    <dialog ref={dialog} tabIndex={-1} onCancel={onClose} aria-labelledby="worktree-title" data-worktree-drilldown=""
      className="m-auto h-[min(680px,calc(100dvh-24px))] w-[min(760px,calc(100vw-24px))] max-w-none overflow-hidden rounded-xl border border-border bg-canvas p-0 text-primary shadow-2xl backdrop:bg-black/40">
      <div className="flex h-full flex-col">
        <header className="shrink-0 border-b border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id="worktree-title" className="text-base font-bold">{t("worktrees.title")}</h2>
            <button type="button" autoFocus className={BUTTON} onClick={onClose}>{t("resources.close")}</button>
          </div>
          <p className="mt-2 text-xs text-muted">{t("worktrees.hint")}</p>
          {page ? <p className="mt-1 text-xs text-muted">{t("worktrees.snapshot", { at: date(page.at) })}{page.mode === "dry-run" ? ` · ${t("worktrees.dryRun")}` : ""}</p> : null}
        </header>
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4" aria-live="polite" aria-busy={!result || loadingMore} data-worktree-body="">
          {!result ? <p role="status">{t("worktrees.loading")}</p> : result.error ? <div role="alert">
            <p>{t(`worktrees.${result.error}` as MessageKey)}</p>
            {result.error !== "denied" ? <button type="button" className={`${BUTTON} mt-3`} onClick={() => { dialog.current?.focus(); setResult(null); setCursor(null); setRetry(value => value + 1); }}>{t("worktrees.reload")}</button> : null}
          </div> : page ? <>
            {page.rows.length === 0 ? <p>{t("worktrees.empty")}</p> : <ol className={`space-y-3 ${loadingMore ? "opacity-50" : ""}`}>
              {page.rows.map((row, index) => <li key={page.start + index} className="rounded-lg border border-border px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere]" data-retained-worktree="">
                <p className="font-semibold">{row.task ?? (row.pipelineId ? t("worktrees.pipeline", { id: row.pipelineId }) : t("worktrees.noTask"))}</p>
                <p className="font-mono text-muted">{row.repository ? `${row.repository} · ` : ""}{row.checkout}</p>
                <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1">
                  <span>{t(`worktrees.reason.${row.reason}` as MessageKey)}</span>
                  <span className="ml-auto shrink-0 tabular-nums" data-worktree-size="">{row.bytes === null ? t("worktrees.unknownSize") : fmtBytes(row.bytes)}</span>
                </div>
                {row.observedAt === page.at ? null : <p className="text-muted">{t("worktrees.observed", { at: date(row.observedAt) })}</p>}
              </li>)}
            </ol>}
          </> : null}
        </div>
        {paged && page ? <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border p-3">
          <button type="button" className={BUTTON} disabled={loadingMore || !page.previousCursor} onClick={() => navigate(page.previousCursor)}>{t("worktrees.previous")}</button>
          <span className="text-xs text-muted" data-worktree-range="">{t("worktrees.range", { first: page.start + 1, last: page.start + page.rows.length, total: page.total })}</span>
          <button type="button" className={BUTTON} disabled={loadingMore || !page.nextCursor} onClick={() => { if (page.nextCursor) navigate(page.nextCursor); }}>{t("worktrees.next")}</button>
        </footer> : null}
      </div>
    </dialog>, document.body,
  );
}
