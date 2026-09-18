"use client";

import { useEffect, useRef } from "react";

import { Loader2 } from "@/components/icons";
import { useConversationCatalog } from "@/hooks/useConversationCatalog";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { QuietFileRow } from "./ProjectTrash";

/** One page of Conversations: enough that a scroll reaches the next page without a visible pause. */
export const DESKTOP_CONVERSATIONS_PAGE_SIZE = 50;

/**
 * Conversations, the desktop's second view beside the Board (#1695).
 *
 * Every conversation stored for the project, the most recent first, from the
 * conversation catalog's own page chain: on a task or not, live or history.
 * There is no cap: each page is appended in the same rows as the scroll reaches
 * the end, and a row the chain returns twice is listed once. It is the phone's
 * catalog continuation, adapted: the count, loading, a failure or an expired
 * snapshot with its retry, and the end of the list are said in words at the
 * bottom, and search stays in the Viewer's own search.
 */
export function DesktopConversations({
  project,
  enabled,
  onOpen,
}: {
  project: string;
  enabled: boolean;
  onOpen: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  /* `scopeKey` keeps the accumulated pages across an update or a trip to the Board, and a return re-reads them. */
  const catalog = useConversationCatalog({ project, enabled, pageSize: DESKTOP_CONVERSATIONS_PAGE_SIZE, scopeKey: project });
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(catalog.loadMore);
  loadMore.current = catalog.loadMore;
  const ended = catalog.known && !catalog.nextCursor;
  /* Nothing to ask for while a page is in flight, after a failure (its row retries) or once the chain ended. */
  const settled = catalog.loading || catalog.error || ended;
  useEffect(() => {
    const node = sentinel.current;
    if (!enabled || !node || settled || typeof IntersectionObserver === "undefined") return;
    /* A fresh observer reports at once when the end is already in view, so a page that added no new row reads the next. */
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore.current();
    }, { root: node.closest("[data-desktop-conversations-scroll]"), rootMargin: "0px 0px 320px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, settled, catalog.nextCursor, catalog.items.length]);

  const rows = catalog.items.length;
  const firstPage = catalog.loading && !catalog.known;
  return (
    <div data-desktop-conversations-scroll className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5">
      <div className="mx-auto w-full max-w-[760px]">
        {/* Clear of the view switch that floats over this leaf's top-left corner. */}
        <div className="mt-9 flex items-baseline gap-2">
          <h2 className="text-[13.5px] font-semibold text-muted">{t("list.title")}</h2>
          {catalog.known ? <span data-desktop-conversations-count className="text-[11px] font-bold tabular-nums text-muted">{catalog.total}</span> : null}
        </div>
        <p className="mb-3 mt-0.5 text-[12px] text-muted">{t("list.hint")}</p>
        <div data-desktop-conversations-rows className="space-y-1.5">
          {catalog.items.map((file) => (
            <div key={file.path} data-desktop-conversations-row={file.path}>
              <QuietFileRow file={file} activeSubtree={false} onOpen={onOpen} />
            </div>
          ))}
        </div>
        <div role="status" data-desktop-conversations-tail className="mt-3 flex min-h-11 flex-col items-center justify-center gap-2 text-center text-[12.5px] font-semibold text-muted">
          {firstPage ? (
            <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loading")}</span>
          ) : catalog.loading ? (
            <span data-desktop-conversations-state="loading">{t("list.loadingMore", { count: rows })}</span>
          ) : catalog.error ? (
            <>
              <span data-desktop-conversations-state={catalog.expired ? "expired" : "failed"} className={catalog.expired ? "" : "text-danger"}>
                {t(catalog.expired ? "list.expired" : "list.failed")}
              </span>
              <button
                type="button"
                data-desktop-conversations-retry={catalog.expired ? "reload" : "retry"}
                className="min-h-11 rounded-[8px] border border-border bg-card px-4 font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={catalog.retry}
              >
                {t(catalog.expired ? "list.reload" : "list.retry")}
              </button>
            </>
          ) : ended ? (
            <span data-desktop-conversations-state="end">
              {rows === 0 ? t("list.empty") : rows === catalog.total ? t("list.endAll", { count: rows }) : t("list.endShown", { count: rows, total: catalog.total })}
            </span>
          ) : typeof IntersectionObserver === "undefined" ? (
            /* Without an observer the end cannot announce itself, so the next page is one press away. */
            <button
              type="button"
              data-desktop-conversations-more
              className="min-h-11 w-full rounded-[8px] border border-border bg-card px-4 font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={catalog.loadMore}
            >
              {t("list.loadMore")}
            </button>
          ) : null}
        </div>
        <div ref={sentinel} data-desktop-conversations-sentinel className="h-px" />
      </div>
    </div>
  );
}
