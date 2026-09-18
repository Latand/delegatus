"use client";

import { useEffect, useRef, useState } from "react";
import { useConversationCatalog, type ConversationCatalogData } from "@/hooks/useConversationCatalog";
import { useLocale } from "@/lib/i18n";

/*
 * «All conversations» on the phone board (#1530, reshaped by #1671): the
 * Recent list going further down, in the board's own rows. The board appends
 * the feed's Recent rows past the three first — already in memory, no request
 * — and only once the operator has scrolled past them does this read the
 * project's stored catalog, twenty entries a page, always scoped to the
 * project. The rows are the board's; what lives here is the per-project state
 * that outlives Home being covered, the scroll anchor, and the quiet tail.
 */

export interface CatalogPosition {
  path: string | null;
  offset: number;
  scrollTop: number;
}
interface ProjectCatalogView {
  expanded: boolean;
  /** The catalog's chain has been asked for: the feed's rows ran out. */
  paging: boolean;
  position: CatalogPosition;
}

/** Lives in the dashboard, including while Home is covered by a conversation. */
export function useMobileInlineCatalog(project: string, enabled: boolean) {
  const views = useRef(new Map<string, ProjectCatalogView>());
  const [, render] = useState(0);
  if (!views.current.has(project)) views.current.set(project, { expanded: false, paging: false, position: { path: null, offset: 0, scrollTop: 0 } });
  const view = views.current.get(project)!;
  const change = (patch: Partial<ProjectCatalogView>) => {
    views.current.set(project, { ...view, ...patch });
    render((n) => n + 1);
  };
  const catalog = useConversationCatalog({
    project, enabled: enabled && view.expanded && view.paging, pageSize: 20, scopeKey: project,
  });
  return {
    view,
    catalog,
    toggle: () => change({ expanded: !view.expanded }),
    /* The end of the list came into view: start the chain, or read its next page. */
    reach: () => {
      if (view.paging) catalog.loadMore();
      else change({ paging: true });
    },
  };
}

export function captureCatalogPosition(root: HTMLElement, position: CatalogPosition) {
  const top = root.getBoundingClientRect().top;
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-catalog-path]"))
    .find((element) => element.getBoundingClientRect().bottom > top);
  position.path = row?.dataset.catalogPath ?? null;
  position.offset = row ? row.getBoundingClientRect().top - top : 0;
  position.scrollTop = root.scrollTop;
}
export function restoreCatalogPosition(root: HTMLElement, position: CatalogPosition) {
  root.scrollTop = position.scrollTop;
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-catalog-path]"))
    .find((element) => element.dataset.catalogPath === position.path);
  if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - position.offset;
}

const LINE = "px-3 py-2.5 text-center text-label text-muted";
const RETRY = "min-h-11 w-full rounded-[12px] bg-quiet px-3 text-ui font-semibold text-accent ring-1 ring-inset ring-border active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * The end of the list: a quiet line for loading, failure, an expired snapshot
 * and the end, a 44 px row to retry, and the sentinel that asks for more when
 * it scrolls into view.
 */
export function MobileCatalogTail({ catalog, paging, rows, onReach }: {
  catalog: ConversationCatalogData;
  paging: boolean;
  /** Rows the list shows past the first three. */
  rows: number;
  onReach: () => void;
}) {
  const { t } = useLocale();
  const sentinel = useRef<HTMLDivElement>(null);
  const reach = useRef(onReach);
  reach.current = onReach;
  /* Nothing to ask for while a page is in flight, after a failure (its row
     retries), or once the chain has ended. */
  const settled = paging && (catalog.loading || catalog.error || (catalog.known && !catalog.nextCursor));
  useEffect(() => {
    const node = sentinel.current;
    if (!node || settled || typeof IntersectionObserver === "undefined") return;
    /* A fresh observer reports at once when the sentinel is already in view, so
       a page that added nothing new (every entry already listed above) reads
       the next one without waiting for another scroll. */
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) reach.current();
    }, { root: node.closest("[data-mobile2-board]"), rootMargin: "0px 0px 240px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [settled, paging, catalog.nextCursor, catalog.items.length]);
  return (
    <div data-mobile-inline-catalog className="flex min-w-0 flex-col gap-1.5">
      {paging && catalog.loading ? <p role="status" className={LINE}>{t("common.loading")}</p> : null}
      {paging && catalog.error && !catalog.loading ? (
        <div role="status" className="flex flex-col gap-1.5">
          <p className={LINE}>{t(catalog.expired ? "mobile.catalog.expired" : "list.failed")}</p>
          <button type="button" data-mobile2-catalog-retry={catalog.expired ? "reload" : "retry"} className={RETRY} onClick={catalog.retry}>
            {t(catalog.expired ? "mobile2.board.catalogReload" : "list.retry")}
          </button>
        </div>
      ) : null}
      {paging && !catalog.loading && !catalog.error && catalog.known && !catalog.nextCursor
        ? <p role="status" className={LINE}>{t(rows ? "mobile.catalog.end" : "common.nothingFound")}</p>
        : null}
      <div ref={sentinel} data-catalog-sentinel className="h-px" />
    </div>
  );
}
