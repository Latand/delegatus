"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { intlLocale } from "@/components/activity/format";
import { Z } from "@/components/layers";
import { CHAT_PULL_REQUEST_PAGE_SIZE, type ChatPullRequest, type ChatPullRequests } from "@/lib/forge/chatPullRequests";
import { useLocale } from "@/lib/i18n";

import { WorkLinkGlyph } from "./WorkLinkChips";

const TONE_ORDER = ["open", "draft", "merged", "closed"] as const;
const EDGE = 8;
const HOVER_GRACE = 220;
const numberFormats = {
  en: new Intl.NumberFormat(intlLocale("en")),
  uk: new Intl.NumberFormat(intlLocale("uk")),
};

export function ChatPullRequestBadge({ title, requests, transcript, project }: {
  title: string; requests: ChatPullRequests; transcript?: string | null; project?: string;
}) {
  const { locale, t } = useLocale();
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshSession = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"hover" | "pinned" | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [updates, setUpdates] = useState<Record<string, ChatPullRequest>>({});
  const open = mode !== null;
  const items = useMemo(() => requests.items.map(item => {
    const updated = updates[item.url];
    return updated && item.state !== "merged" && (!item.checkedAt || (updated.checkedAt ?? "") >= item.checkedAt) ? updated : item;
  }), [requests.items, updates]);
  const visible = items.slice(0, offset + CHAT_PULL_REQUEST_PAGE_SIZE);
  const label = t("chatPullRequests.label", { title });
  const tone = TONE_ORDER.find(state => items.some(item => item.state === state)) ?? "unknown";
  const format = numberFormats[locale];

  const keepOpen = () => clearTimeout(closeTimer.current);
  const leave = () => {
    keepOpen();
    closeTimer.current = setTimeout(() => setMode(current => current === "hover" ? null : current), HOVER_GRACE);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open || !project || !transcript || requests.refresh === false) return;
    const abort = new AbortController();
    refreshSession.current = abort;
    return () => { abort.abort(); refreshSession.current = null; };
  }, [open, project, requests.refresh, transcript]);
  useEffect(() => {
    const abort = refreshSession.current;
    if (!open || !abort || !project || !transcript) return;
    const timer = setTimeout(async () => {
      const query = new URLSearchParams({ project, transcript, offset: String(offset) });
      try {
        const response = await fetch(`/api/conversations/pull-requests?${query}`, { method: "POST", signal: abort.signal });
        if (!response.ok) return;
        const rows: unknown = await response.json();
        if (!Array.isArray(rows) || abort.signal.aborted) return;
        setUpdates(previous => ({ ...previous, ...Object.fromEntries((rows as ChatPullRequest[]).map(row => [row.url, row])) }));
      } catch { /* cached history remains usable */ }
    }, offset === 0 ? 150 : 0);
    abort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }, [open, offset, project, requests.refresh, transcript]);
  useLayoutEffect(() => {
    const button = anchor.current;
    const surface = panel.current;
    if (!mode || !button || !surface) return;
    const measure = () => {
      const at = button.getBoundingClientRect();
      const width = surface.offsetWidth;
      const besideRight = at.right + 4;
      const besideLeft = at.left - 4 - width;
      const side = besideRight + width <= window.innerWidth - EDGE ? besideRight : besideLeft >= EDGE ? besideLeft : null;
      const left = side ?? Math.max(EDGE, Math.min(at.right - width, window.innerWidth - EDGE - width));
      const below = at.bottom + 4;
      const above = at.top - 4 - surface.offsetHeight;
      const idealTop = side !== null ? at.top : below + surface.offsetHeight <= window.innerHeight - EDGE ? below : above;
      const top = Math.max(EDGE, Math.min(idealTop, window.innerHeight - EDGE - surface.offsetHeight));
      setPosition({ left, top });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(surface);
    const focus = mode === "pinned" ? requestAnimationFrame(() => surface.querySelector("a")?.focus({ preventScroll: true })) : null;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !button.contains(event.target) && !surface.contains(event.target)) setMode(null);
    };
    const focusLeaves = (event: FocusEvent) => {
      if (mode === "pinned" && event.target instanceof Node && !button.contains(event.target) && !surface.contains(event.target)) setMode(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (surface.contains(document.activeElement)) button.focus({ preventScroll: true });
      setMode(null);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", focusLeaves);
    return () => {
      if (focus !== null) cancelAnimationFrame(focus);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      resize?.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("focusin", focusLeaves);
    };
  }, [mode]);

  return (
    <>
      <button
        ref={anchor} type="button" aria-label={label} aria-expanded={Boolean(mode)} aria-controls={mode ? id : undefined}
        data-chat-pr-badge="" data-no-drag="" data-tone={tone} className="wl-chip self-center"
        onPointerEnter={event => {
          if (event.pointerType !== "mouse") return;
          keepOpen();
          if (!mode) setOffset(0);
          setMode(current => current ?? "hover");
        }}
        onPointerLeave={leave}
        onClick={() => { keepOpen(); if (!mode) setOffset(0); setMode(current => current === "pinned" ? null : "pinned"); }}
      >
        <WorkLinkGlyph tone={tone} />
        {requests.items.length}{requests.partial ? "+" : ""}
      </button>
      {mode ? createPortal(
        <div
          id={id} ref={panel} role="region" aria-label={label} data-chat-pr-panel="" data-no-drag=""
          className={`fixed ${Z.popover} flex max-h-[min(58dvh,27rem)] w-[min(24rem,calc(100vw-16px))] flex-col rounded-[10px] border border-border bg-card p-2 shadow-2`}
          style={position ?? { left: 0, top: 0, visibility: "hidden" }}
          onPointerEnter={keepOpen} onPointerLeave={leave}
        >
          <h3 className="px-2 py-1 text-[13px] font-semibold text-primary">{t("chatPullRequests.heading")}</h3>
          <ol className="min-h-0 space-y-0.5 overflow-y-auto overscroll-contain">
            {visible.map((pr, index) => (
              <li key={pr.url} data-chat-pr-index={index}>
                <a href={pr.url} target="_blank" rel="noopener noreferrer"
                  className="block rounded-control px-2 py-1.5 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
                  {pr.title ? <span className="block break-words text-[13px] text-primary">{pr.title}</span> : null}
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                    <span className="wl-chip" data-tone={pr.state ?? "unknown"} title={pr.checkedAt ? new Date(pr.checkedAt).toLocaleString(intlLocale(locale)) : undefined}>
                      <WorkLinkGlyph tone={pr.state ?? "unknown"} />
                      {t(`workLinks.state.${pr.state ?? "unknown"}`)}
                    </span>
                    <span className="min-w-0 flex-1 break-all">{pr.repository} #{pr.number}</span>
                    {pr.additions !== undefined ? <span className="tabular-nums text-success">+{format.format(pr.additions)}</span> : null}
                    {pr.deletions !== undefined ? <span className="tabular-nums text-danger">−{format.format(pr.deletions)}</span> : null}
                  </span>
                </a>
              </li>
            ))}
            {visible.length < items.length ? (
              <li>
                <button type="button" className="w-full rounded-control px-2 py-1.5 text-left text-[12px] font-semibold text-accent hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  onClick={(event) => {
                    const next = offset + CHAT_PULL_REQUEST_PAGE_SIZE;
                    setOffset(next);
                    if (event.detail === 0) requestAnimationFrame(
                      () => panel.current?.querySelector<HTMLElement>(`[data-chat-pr-index="${next}"] a`)?.focus(),
                    );
                  }}>
                  {t("chatPullRequests.more", { count: Math.min(CHAT_PULL_REQUEST_PAGE_SIZE, items.length - visible.length) })}
                </button>
              </li>
            ) : null}
          </ol>
          {requests.partial ? <p className="px-2 pt-1.5 text-[11px] text-muted">{t("chatPullRequests.partial")}</p> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
