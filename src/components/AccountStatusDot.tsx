"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Loader2 } from "./icons";
import { TooltipBubble, type BubblePosition } from "./TooltipBubble";

export type AccountDotTone = "success" | "muted" | "warning" | "danger" | "pending";

const DOT_INK: Record<Exclude<AccountDotTone, "pending">, string> = {
  success: "bg-success",
  muted: "bg-muted",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** How near a line may come to the open status before it is hidden whole. */
const NEAR = 4;

/**
 * What the open status lies over or comes near is hidden whole while it is
 * open: a line of the panel keeps all of its words or none of them, and a row
 * whose head it reaches is hidden with its dividers, so no control stays
 * without its owner. Lines are the elements that carry `data-account-line`;
 * a row's head parts are the toggle, the dot, the sign-in and the chevron.
 */
function hideUnder(bubble: HTMLElement, anchor: HTMLElement): () => void {
  const box = bubble.getBoundingClientRect();
  const near = (rect: DOMRect) => rect.width > 0.5 && rect.height > 0.5
    && rect.left < box.right + NEAR && rect.right > box.left - NEAR && rect.top < box.bottom + NEAR && rect.bottom > box.top - NEAR;
  const reaches = (element: Element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].some(near);
  };
  const ownRow = anchor.closest("[data-account-row]");
  const scope = anchor.closest("[data-accounts-scroller]") ?? ownRow?.parentElement;
  if (!scope) return () => {};
  const hidden = new Set<HTMLElement>();
  const blank = new Set<HTMLElement>();
  for (const row of scope.querySelectorAll<HTMLElement>("[data-account-row]")) {
    if (row === ownRow) {
      for (const line of row.querySelectorAll<HTMLElement>("[data-account-line]")) if (reaches(line)) hidden.add(line);
      continue;
    }
    const head = row.querySelector("[data-account-head]");
    if (head && [...head.querySelectorAll("[data-account-toggle], [data-account-status], [data-account-signin-start], [data-account-chevron]")].some(reaches)) {
      blank.add(row);
      for (const child of row.children) hidden.add(child as HTMLElement);
      continue;
    }
    for (const line of row.querySelectorAll<HTMLElement>("[data-account-line]")) if (reaches(line)) hidden.add(line);
  }
  const before = [...hidden].map((part) => [part, part.style.visibility] as const);
  type Edge = readonly [HTMLElement, "borderTopColor" | "borderBottomColor", string];
  const edges: Edge[] = [...blank].flatMap((row) => {
    const sides: [HTMLElement | null, "borderTopColor" | "borderBottomColor"][] = [
      [row, "borderTopColor"], [row, "borderBottomColor"],
      [row.previousElementSibling as HTMLElement | null, "borderBottomColor"], [row.nextElementSibling as HTMLElement | null, "borderTopColor"],
    ];
    return sides.flatMap(([part, side]) => (part ? [[part, side, part.style[side]] as const] : []));
  });
  for (const part of hidden) part.style.visibility = "hidden";
  for (const [part, side] of edges) part.style[side] = "transparent";
  return () => {
    for (const [part, visibility] of before) part.style.visibility = visibility;
    for (const [part, side, colour] of [...edges].reverse()) part.style[side] = colour;
  };
}

/**
 * Under the dot and clear of the name's lines: a name that wraps keeps all of
 * its lines showing, so the popover opens below the last of them, or above the
 * first when the window has no room below. Null leaves it to the bubble's own
 * placement (no name to clear).
 */
function placeBelowName(anchor: HTMLElement | null, bubble: HTMLElement): BubblePosition | null {
  const name = anchor?.closest("[data-account-head]")?.querySelector("[data-account-name]");
  if (!anchor || !name || typeof document.createRange !== "function") return null;
  const range = document.createRange();
  range.selectNodeContents(name);
  const lines = [...range.getClientRects()].filter((rect) => rect.width > 0.5);
  if (lines.length === 0) return null;
  const nameTop = Math.min(...lines.map((rect) => rect.top)) - NEAR;
  const nameBottom = Math.max(...lines.map((rect) => rect.bottom)) + NEAR;
  const dot = anchor.getBoundingClientRect();
  const box = bubble.getBoundingClientRect();
  const left = Math.max(8, Math.min(dot.left + dot.width / 2 - 12, window.innerWidth - box.width - 8));
  const above = nameTop - box.height;
  const top = nameBottom + box.height <= window.innerHeight - 8 || above < 8 ? nameBottom : above;
  return { left, top: Math.max(8, Math.min(top, window.innerHeight - box.height - 8)), maxWidth: Math.min(280, window.innerWidth - 40) };
}

/**
 * The status of an account row: a dot, with its words in a short popover on
 * hover, focus or tap (hover, focus and tap open it, Escape or a press outside
 * close it). The button is named "label: state" so the dot is never the only
 * carrier of the state; the popover adds the plan, the next-for-unpinned note
 * and the account id when it differs from the label.
 */
export function AccountStatusDot({ accountId, label, word, tone, plan, note, phone }: {
  accountId: string;
  label: string;
  /** The sign-in state in words, shown first in the popover and named by the button. */
  word: string;
  tone: AccountDotTone;
  plan: string | null;
  /** The next-for-unpinned note, when this account carries it. */
  note: string | null;
  phone: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const bubbleId = useId();
  const place = useCallback((bubble: HTMLElement) => placeBelowName(anchorRef.current, bubble), []);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const open = hovered || focused || tapped;
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: Event) => {
      if (!anchorRef.current?.contains(event.target as Node)) { setTapped(false); setFocused(false); setHovered(false); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setTapped(false); setFocused(false); setHovered(false); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);
  // The popover places itself in its own layout effect; one frame later its
  // box is final, and what it lies over is hidden until it closes.
  useLayoutEffect(() => {
    if (!open || typeof requestAnimationFrame !== "function") return undefined;
    let reveal = () => {};
    let frame = 0;
    let settled = 0;
    const settle = () => {
      const bubble = document.getElementById(bubbleId);
      if (!bubble) return;
      reveal();
      reveal = hideUnder(bubble, anchorRef.current!);
    };
    frame = requestAnimationFrame(() => { settled = requestAnimationFrame(settle); });
    const again = () => settle();
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settled);
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again, true);
      reveal();
    };
  }, [open, bubbleId]);
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-account-status={accountId}
        data-account-status-tone={tone}
        aria-label={`${label}: ${word}`}
        aria-expanded={open}
        aria-describedby={open ? bubbleId : undefined}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => { setTapped((value) => !value); setFocused(false); }}
        className={`flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "h-11 w-11" : "h-[26px] w-[26px]"}`}
      >
        {tone === "pending"
          ? <Loader2 className="h-3 w-3 animate-spin text-muted motion-reduce:animate-none" aria-hidden />
          : <span aria-hidden className={`h-2 w-2 rounded-full ${DOT_INK[tone]}`} />}
      </button>
      {open ? (
        <TooltipBubble
          id={bubbleId}
          anchorRef={anchorRef}
          side="bottom"
          align="left"
          place={place}
          className={`flex w-max max-w-[min(280px,calc(100vw-40px))] flex-col rounded-[8px] border border-border bg-[color-mix(in_srgb,var(--color-primary)_6%,var(--color-raised))] px-2.5 py-1.5 shadow-2 ${phone ? "text-[12px]" : "text-[11px]"} leading-snug`}
        >
          <span data-account-status-popover={accountId} className="block">
            <span className="font-semibold text-primary">{capital(word)}</span>
            {plan ? <span className="text-secondary"> · {capital(plan)}</span> : null}
            {note ? <span className="text-secondary"> · {note}</span> : null}
            {accountId !== label ? <code data-account-id className="block break-all font-mono text-[10.5px] text-secondary">{accountId}</code> : null}
          </span>
        </TooltipBubble>
      ) : null}
    </>
  );
}
