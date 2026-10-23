"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale, type MessageKey } from "@/lib/i18n";
import type { WorktreePage } from "@/lib/pipelines/worktreeDrilldown";

const BUTTON = "min-h-11 rounded-control border border-border px-3 text-xs font-semibold hover:bg-sunken disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function WorktreeDrilldown({ onClose }: { onClose: () => void }) {
  const { t, locale } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ page?: WorktreePage; error?: string } | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  // Disabling a paging button during a read can move focus to the document.
  // Keep it inside the native modal as each loading/result state commits.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element?.open && !element.contains(document.activeElement)) element.focus();
  }, [result]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/resources/worktrees" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          const key = response.status === 409 ? "changed" : response.status === 403 ? "denied" : "unavailable";
          if (!controller.signal.aborted) setResult({ error: key });
          return;
        }
        const page = await response.json() as WorktreePage;
        if (!controller.signal.aborted) {
          setResult({ page });
          body.current?.scrollTo(0, 0);
        }
      } catch {
        if (!controller.signal.aborted) setResult({ error: "unavailable" });
      }
    })();
    return () => controller.abort();
  }, [cursor, retry]);
  const navigate = (next: string | null) => { setResult(null); setCursor(next); };
  const date = (at: string | null) => at ? new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" }) : t("worktrees.unknownTime");
  const page = result?.page;
  return createPortal(
    <dialog ref={dialog} tabIndex={-1} onCancel={onClose} aria-labelledby="worktree-title" data-worktree-drilldown=""
      className="m-auto max-h-[calc(100dvh-24px)] w-[min(760px,calc(100vw-24px))] max-w-none overflow-hidden rounded-xl border border-border bg-canvas p-0 text-primary shadow-2xl backdrop:bg-black/40">
      <div className="flex max-h-[calc(100dvh-26px)] flex-col">
        <header className="shrink-0 border-b border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id="worktree-title" className="text-base font-bold">{t("worktrees.title")}</h2>
            <button type="button" autoFocus className={BUTTON} onClick={onClose}>{t("resources.close")}</button>
          </div>
          <p className="mt-2 text-xs text-muted">{t("worktrees.hint")}</p>
          {page ? <p className="mt-1 text-xs text-muted">{t("worktrees.snapshot", { at: date(page.at) })}{page.mode === "dry-run" ? ` · ${t("worktrees.dryRun")}` : ""}</p> : null}
        </header>
        <div ref={body} className="min-h-0 overflow-y-auto overscroll-contain p-4" aria-live="polite" aria-busy={!result} data-worktree-body="">
          {!result ? <p role="status">{t("worktrees.loading")}</p> : result.error ? <div role="alert">
            <p>{t(`worktrees.${result.error}` as MessageKey)}</p>
            {result.error !== "denied" ? <button type="button" className={`${BUTTON} mt-3`} onClick={() => { navigate(null); setRetry(value => value + 1); }}>{t("worktrees.reload")}</button> : null}
          </div> : page ? <>
            {page.rows.length === 0 ? <p>{t("worktrees.empty")}</p> : <ol className="space-y-3">
              {page.rows.map((row, index) => <li key={page.start + index} className="rounded-lg border border-border px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere]" data-retained-worktree="">
                <p className="font-semibold">{row.task ?? (row.pipelineId ? t("worktrees.pipeline", { id: row.pipelineId }) : t("worktrees.noTask"))}</p>
                <p className="font-mono text-muted">{row.repository ? `${row.repository} · ` : ""}{row.checkout}</p>
                <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1">
                  <span>{t(`worktrees.reason.${row.reason}` as MessageKey)}</span>
                  <span className="shrink-0 tabular-nums">{row.bytes === null ? t("worktrees.unknownSize") : t("worktrees.bytes", { n: row.bytes.toLocaleString(locale) })}</span>
                </div>
                <p className="text-muted">{t("worktrees.observed", { at: date(row.observedAt) })}</p>
              </li>)}
            </ol>}
          </> : null}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border p-3">
          <button type="button" className={BUTTON} disabled={!page?.previousCursor} onClick={() => navigate(page?.previousCursor ?? null)}>{t("worktrees.previous")}</button>
          <span className="text-xs text-muted" data-worktree-range="">{page ? t("worktrees.range", { first: page.rows.length ? page.start + 1 : 0, last: page.start + page.rows.length, total: page.total }) : ""}</span>
          <button type="button" className={BUTTON} disabled={!page?.nextCursor} onClick={() => { if (page?.nextCursor) navigate(page.nextCursor); }}>{t("worktrees.next")}</button>
        </footer>
      </div>
    </dialog>, document.body,
  );
}
