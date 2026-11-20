"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { intlLocale } from "@/components/activity/format";
import { Z } from "@/components/layers";
import type { ChatPullRequests } from "@/lib/forge/chatPullRequests";
import { useLocale } from "@/lib/i18n";

import { WorkLinkGlyph } from "./WorkLinkChips";

const TONE_ORDER = ["open", "draft", "merged", "closed"] as const;
const EDGE = 8;
const HOVER_GRACE = 220;

export function ChatPullRequestBadge({ title, requests }: { title: string; requests: ChatPullRequests }) {
  const { locale, t } = useLocale();
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mode, setMode] = useState<"hover" | "pinned" | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const label = t("chatPullRequests.label", { title });
  const tone = TONE_ORDER.find(state => requests.items.some(item => item.state === state)) ?? "unknown";
  const format = new Intl.NumberFormat(intlLocale(locale));

  const keepOpen = () => clearTimeout(closeTimer.current);
  const leave = () => {
    keepOpen();
    closeTimer.current = setTimeout(() => setMode(current => current === "hover" ? null : current), HOVER_GRACE);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    const button = anchor.current;
    const surface = panel.current;
    if (!mode || !button || !surface) return;
    const measure = () => {
      const at = button.getBoundingClientRect();
      const width = surface.offsetWidth;
      const right = at.right + 4;
      const beside = right + width <= window.innerWidth - EDGE;
      const left = beside ? right : Math.max(EDGE, Math.min(at.right - width, window.innerWidth - EDGE - width));
      const top = Math.max(EDGE, Math.min(beside ? at.top : at.bottom + 4, window.innerHeight - EDGE - surface.offsetHeight));
      setPosition({ left, top });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
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
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("focusin", focusLeaves);
    };
  }, [mode]);

  return (
    <>
      <button
        ref={anchor} type="button" aria-label={label} aria-expanded={Boolean(mode)} aria-controls={mode ? id : undefined}
        data-chat-pr-badge="" data-tone={tone} className="wl-chip"
        onPointerEnter={event => {
          if (event.pointerType !== "mouse") return;
          keepOpen();
          setMode(current => current ?? "hover");
        }}
        onPointerLeave={leave}
        onClick={() => { keepOpen(); setMode(current => current === "pinned" ? null : "pinned"); }}
      >
        <WorkLinkGlyph tone={tone} />
        {requests.items.length}{requests.partial ? "+" : ""}
      </button>
      {mode ? createPortal(
        <div
          id={id} ref={panel} role="region" aria-label={label} data-chat-pr-panel=""
          className={`fixed ${Z.popover} flex max-h-[min(58dvh,27rem)] w-[min(24rem,calc(100vw-16px))] flex-col rounded-[10px] border border-border bg-card p-2 shadow-2`}
          style={position ?? { left: 0, top: 0, visibility: "hidden" }}
          onPointerEnter={keepOpen} onPointerLeave={leave}
        >
          <h3 className="px-2 py-1 text-[13px] font-semibold text-primary">{t("chatPullRequests.heading")}</h3>
          <ol className="min-h-0 space-y-0.5 overflow-y-auto overscroll-contain">
            {requests.items.map(pr => (
              <li key={pr.url}>
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
          </ol>
          {requests.partial ? <p className="px-2 pt-1.5 text-[11px] text-muted">{t("chatPullRequests.partial")}</p> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
