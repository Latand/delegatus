"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CHAT_PULL_REQUEST_BATCH, type ChatPullRequests } from "@/lib/forge/chatPullRequests";

const EMPTY_REQUESTS: Record<string, ChatPullRequests> = {};

/** Subscribe only to on-screen rows. Expanding or scrolling a branch sends a
 * small batch without rereading the conversation catalog or polling GitHub. */
export function useChatPullRequests(project: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<{ project: string; requests: Record<string, ChatPullRequests> }>();
  const tracked = useRef(new Map<Element, { path: string; project: string | undefined }>());
  const observe = useRef<((node: Element) => void) | null>(null);
  const unobserve = useRef<((node: Element) => void) | null>(null);
  const watch = useCallback((path: string, node: Element | null, sourceProject?: string) => {
    if (!node) return;
    tracked.current.set(node, { path, project: sourceProject });
    observe.current?.(node);
    return () => {
      tracked.current.delete(node);
      unobserve.current?.(node);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const subscribed = tracked.current;
    const attempted = new Map<string, number>();
    const pending = new Map<string, string>();
    const abort = new AbortController();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let reading = false;

    const flush = async () => {
      scheduled = undefined;
      reading = true;
      try {
        while (pending.size && !abort.signal.aborted) {
          const sourceProject = pending.values().next().value ?? project;
          const paths = [...pending].filter(([, owner]) => owner === sourceProject)
            .slice(0, CHAT_PULL_REQUEST_BATCH).map(([path]) => path);
          for (const path of paths) pending.delete(path);
          const query = new URLSearchParams({ project: sourceProject });
          for (const path of paths) query.append("transcript", path);
          try {
            const response = await fetch(`/api/conversations/pull-requests?${query}`, { signal: abort.signal });
            if (!response.ok) continue;
            const data = await response.json() as Record<string, ChatPullRequests>;
            if (abort.signal.aborted) continue;
            for (const path of paths) if (Object.hasOwn(data, path)) attempted.set(path, Infinity);
            setSnapshot(current => {
              const next = { ...(current?.project === project ? current.requests : EMPTY_REQUESTS) };
              for (const path of paths) {
                if (Object.hasOwn(data, path)) next[path] = data[path]!;
                else delete next[path];
              }
              return { project, requests: next };
            });
          } catch {
            // A failed optional read leaves the chat row usable.
          }
        }
      } finally {
        reading = false;
      }
    };

    const visible = (node: Element) => {
      const subscription = subscribed.get(node);
      if (!subscription) return;
      const { path } = subscription;
      if ((attempted.get(path) ?? 0) > Date.now()) return;
      attempted.set(path, Date.now() + 5000);
      pending.set(path, subscription.project ?? project);
      if (!reading && scheduled === undefined) scheduled = setTimeout(() => void flush(), 40);
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) visible(entry.target);
    }) : null;
    observe.current = observer ? node => observer.observe(node) : visible;
    unobserve.current = observer ? node => observer.unobserve(node) : null;
    for (const node of subscribed.keys()) observe.current(node);
    return () => {
      abort.abort();
      clearTimeout(scheduled);
      observer?.disconnect();
      observe.current = null;
      unobserve.current = null;
    };
  }, [enabled, project]);

  return { requests: snapshot?.project === project ? snapshot.requests : EMPTY_REQUESTS, watch };
}
