"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronRight, Loader2 } from "@/components/icons";
import { intlLocale } from "@/components/activity/format";
import { useChatPullRequests } from "@/hooks/useChatPullRequests";
import { useConversationCatalog, type ConversationCatalogData } from "@/hooks/useConversationCatalog";
import { cleanTitle } from "@/lib/title";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { EngineMark } from "./EngineMark";
import { Hint } from "./Hint";
import { QuietFileRow } from "./ProjectTrash";
import { engineBadgeFor } from "./utils";
import { ChatPullRequestBadge } from "./workLinks/ChatPullRequestBadge";

export const DESKTOP_CONVERSATIONS_PAGE_SIZE = 15;
export const DESKTOP_CONVERSATIONS_CHILD_PAGE_SIZE = DESKTOP_CONVERSATIONS_PAGE_SIZE;
const CHAT_HINT_CLASS = "max-w-[min(22rem,calc(100vw_-_1rem))] rounded-[8px] border border-border bg-card px-2.5 py-2 text-[11px] text-primary shadow-2";

interface ChatListProps {
  project: string;
  enabled: boolean;
  onOpen: (file: FileEntry) => void;
  compact: boolean;
  pullRequests: ReturnType<typeof useChatPullRequests>;
  depth: number;
}

/** Project rail and board popover share the same root list and independent child lists. */
export function DesktopConversations({
  project, enabled, onOpen, countSlot, compact = false,
}: {
  project: string;
  enabled: boolean;
  onOpen: (file: FileEntry) => void;
  countSlot?: HTMLElement | null;
  compact?: boolean;
}) {
  const catalog = useConversationCatalog({
    project, enabled, pageSize: DESKTOP_CONVERSATIONS_PAGE_SIZE, branch: "roots",
    // Both surfaces can be open. An older popover refresh must not overwrite
    // a page just appended in the rail (the cache key already includes project).
    scopeKey: compact ? "desktop-chat-rail" : "desktop-chat-popover",
  });
  const pullRequests = useChatPullRequests(project, enabled);
  const count = catalog.known ? (
    <span data-desktop-conversations-count className="text-[11px] font-bold tabular-nums text-muted">
      {catalog.projectTotal ?? catalog.total}
    </span>
  ) : null;
  return (
    <div data-desktop-conversations-scroll className={`min-h-0 flex-1 overflow-y-auto ${compact ? "p-0.5" : "p-1.5"}`}>
      {countSlot ? createPortal(count, countSlot) : count && !compact ? <div className="px-1 pb-1">{count}</div> : null}
      <ChatList key={project} project={project} enabled={enabled} catalog={catalog} onOpen={onOpen}
        compact={compact} pullRequests={pullRequests} depth={0} />
    </div>
  );
}

function DependentChats({ parent, ...props }: ChatListProps & { parent: string }) {
  const catalog = useConversationCatalog({
    project: props.project, enabled: props.enabled, branch: { parent }, pageSize: DESKTOP_CONVERSATIONS_CHILD_PAGE_SIZE,
  });
  return <ChatList {...props} catalog={catalog} parent={parent} />;
}

function ChatList({ catalog, parent, ...props }: ChatListProps & { catalog: ConversationCatalogData; parent?: string }) {
  const { t } = useLocale();
  const list = useRef<HTMLUListElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const focusAfterPage = useRef<{ index: number; button: HTMLButtonElement } | null>(null);
  const { enabled, compact } = props;
  const { items, loading, error, expired, known, nextCursor, loadMore, retry } = catalog;
  const autoPage = !parent && !compact;
  useEffect(() => {
    const node = sentinel.current;
    if (!enabled || !autoPage || !node || !nextCursor || loading || error || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMore();
    }, { root: node.closest("[data-desktop-conversations-scroll]") });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, autoPage, nextCursor, loading, error, loadMore]);

  useLayoutEffect(() => {
    const pending = focusAfterPage.current;
    if (!pending || loading) return;
    focusAfterPage.current = null;
    if (error || !list.current) return;
    // Preserve Tab order as rows are inserted before the focused pager. A
    // user who moved focus while waiting keeps it; automatic paging never moves it.
    const active = document.activeElement;
    if (active !== pending.button && (pending.button.isConnected || active !== document.body)) return;
    list.current.children[pending.index]?.querySelector<HTMLButtonElement>("[data-desktop-chat-open]")?.focus({ preventScroll: true });
  }, [loading, error, items]);

  const act = (button: HTMLButtonElement) => {
    if (loading) return;
    if (button === document.activeElement) focusAfterPage.current = { index: expired ? 0 : items.length, button };
    if (error) retry();
    else loadMore();
  };
  const action = error ? t(expired ? "list.reload" : "list.retry") : t(parent ? "list.loadMoreChildren" : "list.loadMoreRoots");
  const hasAction = Boolean(nextCursor || error);
  const empty = known && !items.length && !nextCursor;
  const ended = known && !nextCursor && !error;
  let status = "";
  if (error) status = t(expired ? "list.expired" : "list.failed");
  else if (!known || (loading && hasAction)) status = t("common.loading");
  else if (empty) status = t(parent ? "list.noChildren" : "list.empty");
  else if (ended && items.length !== catalog.total) status = t("list.endShown", { count: items.length, total: catalog.total });
  else if (ended) status = catalog.projectTotal !== undefined && catalog.projectTotal !== catalog.total
    ? t("list.endRoots") : t("list.endAll", { count: items.length });

  return (
    <>
      <ul ref={list} data-desktop-conversations-rows={parent ? undefined : true} aria-label={parent ? undefined : t("list.mainChats")}
        className={compact ? "space-y-0.5" : "space-y-1.5"}>
        {items.map(file => <ChatBranch key={file.path} file={file} {...props} />)}
      </ul>
      {(!parent || !ended || empty) && (
        <div data-desktop-conversations-tail={parent ? undefined : true} data-desktop-children-tail={parent}
          className={`[overflow-anchor:none] flex flex-col ${compact || parent ? "min-h-8 items-start" : "mt-3 min-h-11 items-center justify-center"} text-[12px] text-muted`}>
          <span role="status" className={error || (!known && !hasAction) || ended ? "px-1.5 py-1.5" : "sr-only"}
            data-desktop-conversations-state={error ? (expired ? "expired" : "failed") : ended ? "end" : loading ? "loading" : undefined}>
            {status}
          </span>
          {hasAction && (
            <button type="button" data-desktop-conversations-more={!parent && !error || undefined}
              data-desktop-children-more={parent && !error ? true : undefined}
              data-desktop-conversations-retry={error ? (expired ? "reload" : "retry") : undefined}
              aria-disabled={loading || undefined} aria-busy={loading || undefined} onClick={event => act(event.currentTarget)}
              className={`relative inline-flex items-center rounded-control px-2 text-left font-semibold text-secondary hover:bg-card hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${compact || parent ? "min-h-8" : "min-h-11"}`}>
              {action}
              <Loader2 aria-hidden className={`ms-1.5 h-3 w-3 shrink-0 ${loading ? "motion-safe:animate-spin" : "invisible"}`} />
            </button>
          )}
        </div>
      )}
      {autoPage && <div ref={sentinel} data-desktop-conversations-sentinel className="h-px" />}
    </>
  );
}

function ChatBranch({ file, ...props }: ChatListProps & { file: FileEntry }) {
  const { t } = useLocale();
  const { compact, pullRequests, onOpen, depth } = props;
  // Keep an opened branch mounted when folded, including its cursor, rows and nested disclosures.
  const [disclosure, setDisclosure] = useState<"unopened" | "open" | "closed">("unopened");
  const expanded = disclosure === "open";
  const groupId = useId();
  const title = cleanTitle(file.title, 160);
  const { requests, watch } = pullRequests;
  const rowRef = useCallback((node: HTMLDivElement | null) => watch(file.path, node, file.project), [file.path, file.project, watch]);
  const prs = requests[file.path];
  const count = file.directChildCount ?? 0;
  const subagent = file.engine === "codex" && Boolean(file.nativeParentThreadId);
  const hint = <ChatHintDetails file={file} title={title} subagent={subagent} />;
  const dependentLabel = t("list.chatBranches", { title, count });
  const toggle = count > 0 ? (
    <button type="button" aria-label={dependentLabel} title={dependentLabel} aria-expanded={expanded}
      aria-controls={disclosure === "unopened" ? undefined : groupId}
      onClick={() => setDisclosure(expanded ? "closed" : "open")}
      className="inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-control px-1.5 text-[11px] tabular-nums text-muted hover:bg-card hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <ChevronRight className={expanded ? "h-3.5 w-3.5 rotate-90" : "h-3.5 w-3.5"} aria-hidden />
      {count}
    </button>
  ) : null;
  return (
    <li data-desktop-conversations-row={file.path} data-native-subagent={subagent ? "" : undefined}>
      <div ref={rowRef} className="flex min-w-0 items-center gap-1">
        {compact ? (
          <>
            <Hint label={hint} delayMs={100} align="left" className="flex min-w-0 flex-1" bubbleClassName={CHAT_HINT_CLASS}>
            <button type="button"
              aria-description={subagent ? t("kind.subagent") : undefined}
              data-desktop-chat-open onClick={() => onOpen(file)}
              className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-control px-1.5 text-left text-[12.5px] text-primary hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <EngineMark engine={file.engine} size={14} label={engineBadgeFor(file.engine).label} />
              <span className="min-w-0 truncate">{title}</span>
            </button>
            </Hint>
            {toggle}
          </>
        ) : (
          <>
            {toggle}
            <div className="min-w-0 flex-1">
              <QuietFileRow file={file} activeSubtree={false} showEngineMark
                chatHint={{ content: hint, bubbleClassName: CHAT_HINT_CLASS }} onOpen={onOpen} />
            </div>
          </>
        )}
        {prs?.items.length ? <ChatPullRequestBadge title={title} requests={prs} transcript={file.path} project={file.project} /> : null}
      </div>
      {count > 0 && disclosure !== "unopened" && (
        <div id={groupId} hidden={!expanded} className={depth < 4 ? "ms-2 border-s border-border ps-1.5" : "border-s border-border"}>
          <DependentChats parent={file.path} {...props} depth={depth + 1} />
        </div>
      )}
    </li>
  );
}

function ChatHintDetails({ file, title, subagent }: { file: FileEntry; title: string; subagent: boolean }) {
  const { locale, t } = useLocale();
  const date = new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium" });
  const time = new Intl.DateTimeFormat(intlLocale(locale), { timeStyle: "short" });
  const created = file.firstMessageAt != null ? file.firstMessageAt * 1000 : Date.parse(file.sessionStartedAt ?? "");
  const latest = (file.lastMessageAt ?? file.mtime) * 1000;
  const timestamps = [
    { label: t(file.lastMessageAt == null ? "list.chatUpdated" : "list.chatLastMessage"), value: latest, className: "text-secondary" },
    { label: t("list.chatCreated"), value: created, className: "text-muted opacity-95" },
  ].filter(({ value }) => Number.isFinite(value) && value > 0);
  return (
    <>
      <span className="block font-semibold [overflow-wrap:anywhere]">{title}{subagent ? ` · ${t("kind.subagent")}` : ""}</span>
      {timestamps.length ? (
        <span className="mt-1 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {timestamps.map(({ label, value, className }) => (
            <span key={label} className="contents">
              <span className={className}>{label}</span>
              <time dateTime={new Date(value).toISOString()} className={`flex justify-between gap-x-2 tabular-nums ${className}`}>
                <span>{date.format(value)}</span>
                <span className="shrink-0">{time.format(value)}</span>
              </time>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}
