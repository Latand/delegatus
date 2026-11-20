"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronRight, GitBranch, Loader2 } from "@/components/icons";
import { useChatPullRequests } from "@/hooks/useChatPullRequests";
import { useConversationCatalog } from "@/hooks/useConversationCatalog";
import { cleanTitle } from "@/lib/title";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { ChatPullRequestBadge } from "./workLinks/ChatPullRequestBadge";
import { QuietFileRow } from "./ProjectTrash";
import { conversationTree, type ConversationBranch } from "@/lib/conversationTree";

/** One page of Conversations: enough that a scroll reaches the next page without a visible pause. */
export const DESKTOP_CONVERSATIONS_PAGE_SIZE = 50;

/**
 * The project's recent agents: the list the board's header opens under its
 * icon. It was Conversations, the desktop's second view beside the Board
 * (#1695), until the board became the one desktop view.
 *
 * Every conversation stored for the project, the most recent first, from the
 * conversation catalog's own page chain: on a task or not, live or history.
 * There is no cap: each page is appended in the same rows as the scroll reaches
 * the end, and a row the chain returns twice is listed once. It is the phone's
 * catalog continuation, adapted: the count, loading, a failure or an expired
 * snapshot with its retry, and the end of the list are said in words at the
 * bottom, and search stays in the Viewer's own search. The popover's head
 * names the list, so it draws no heading of its own, and its count goes into
 * that head (`countSlot`).
 */
export function DesktopConversations({
  project,
  enabled,
  onOpen,
  countSlot,
  compact = false,
}: {
  project: string;
  enabled: boolean;
  onOpen: (file: FileEntry) => void;
  /** Where the popover's head shows how many agents the project has. */
  countSlot?: HTMLElement | null;
  compact?: boolean;
}) {
  const { t } = useLocale();
  /* `scopeKey` keeps the accumulated pages across an update or a trip to the Board, and a return re-reads them. */
  const catalog = useConversationCatalog({ project, enabled, pageSize: DESKTOP_CONVERSATIONS_PAGE_SIZE, scopeKey: project, tree: true });
  const pullRequests = useChatPullRequests(project, enabled);
  const sentinel = useRef<HTMLDivElement>(null);
  const lastAutomaticPage = useRef<{ project: string; visible: number } | null>(null);
  const { loadMore } = catalog;
  const ended = catalog.known && !catalog.nextCursor;
  /* Nothing to ask for while a page is in flight, after a failure (its row retries) or once the chain ended. */
  const settled = catalog.loading || catalog.error || ended;
  useEffect(() => {
    const node = sentinel.current;
    if (!enabled || !node || settled || typeof IntersectionObserver === "undefined") return;
    const list = node.closest("[data-desktop-conversations-scroll]");
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      // A collapsed branch can hide an entire page. Let the operator expand
      // the branch or ask for more before the sentinel fetches again.
      const visible = list?.querySelectorAll("[data-desktop-conversations-row]").length ?? 0;
      if (lastAutomaticPage.current?.project === project && lastAutomaticPage.current.visible === visible) return;
      lastAutomaticPage.current = { project, visible };
      loadMore();
    }, { root: list, rootMargin: "0px 0px 320px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, settled, catalog.nextCursor, catalog.items.length, loadMore, project]);

  const tree = useMemo(() => conversationTree(catalog.items), [catalog.items]);
  const rows = catalog.items.length;
  const firstPage = catalog.loading && !catalog.known;
  const count = catalog.known ? <span data-desktop-conversations-count className="text-[11px] font-bold tabular-nums text-muted">{catalog.total}</span> : null;
  return (
    <div data-desktop-conversations-scroll className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <div className="w-full">
        {countSlot ? createPortal(count, countSlot) : count && !compact ? <div className="px-1 pb-1">{count}</div> : null}
        <ul key={project} data-desktop-conversations-rows aria-label={t("dash.recentAgents")} className={compact ? "space-y-0.5" : "space-y-1.5"}>
          {tree.map(branch => <ChatBranch key={branch.file.path} branch={branch} onOpen={onOpen} compact={compact} pullRequests={pullRequests} />)}
        </ul>
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
          ) : (
            /* Keep paging available even when collapsed branches shorten the list. */
            <button
              type="button"
              data-desktop-conversations-more
              className="min-h-11 w-full rounded-[8px] border border-border bg-card px-4 font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={catalog.loadMore}
            >
              {t("list.loadMore")}
            </button>
          )}
        </div>
        <div ref={sentinel} data-desktop-conversations-sentinel className="h-px" />
      </div>
    </div>
  );
}


function ChatBranch({ branch, onOpen, compact, pullRequests }: {
  branch: ConversationBranch;
  onOpen: (file: FileEntry) => void;
  compact: boolean;
  pullRequests: ReturnType<typeof useChatPullRequests>;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const groupId = useId();
  const { file, children } = branch;
  const title = cleanTitle(file.title, 160);
  const { requests, watch } = pullRequests;
  const rowRef = useCallback((node: HTMLDivElement | null) => watch(file.path, node), [file.path, watch]);
  const prs = requests[file.path];
  const toggle = children.length > 0 ? (
    <button
      type="button"
      aria-label={t("list.chatBranches", { title })}
      aria-expanded={expanded}
      aria-controls={expanded ? groupId : undefined}
      onClick={() => setExpanded(value => !value)}
      className="inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-control px-1.5 text-[11px] tabular-nums text-muted hover:bg-card hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <ChevronRight className={expanded ? "h-3.5 w-3.5 rotate-90" : "h-3.5 w-3.5"} aria-hidden />
      {compact ? <GitBranch className="h-3 w-3 text-accent" aria-hidden /> : null}
      {children.length}
    </button>
  ) : null;
  return (
    <li data-desktop-conversations-row={file.path}>
      <div ref={rowRef} className="flex min-w-0 items-center gap-1">
        {compact ? (
          <>
            <button
              type="button"
              title={title}
              onClick={() => onOpen(file)}
              className="min-h-8 min-w-0 flex-1 truncate rounded-control px-1.5 text-left text-[12.5px] text-primary hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {title}
            </button>
            {toggle}
          </>
        ) : (
          <>
            {toggle}
            <div className="min-w-0 flex-1">
              <QuietFileRow file={file} activeSubtree={false} onOpen={onOpen} />
            </div>
          </>
        )}
        {prs?.items.length ? <ChatPullRequestBadge title={title} requests={prs} /> : null}
      </div>
      {expanded && children.length > 0 ? (
        <ul id={groupId} className={compact ? "ms-2 border-s border-border ps-2" : "mt-1.5 space-y-1.5 ms-2.5 border-s border-border ps-2.5"}>
          {children.map(child => <ChatBranch key={child.file.path} branch={child} onOpen={onOpen} compact={compact} pullRequests={pullRequests} />)}
        </ul>
      ) : null}
    </li>
  );
}
