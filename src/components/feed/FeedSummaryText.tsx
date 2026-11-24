"use client";

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";

import { HINT_BUBBLE_CLASS, SHOW_DELAY_MS } from "@/components/Hint";
import { TooltipBubble } from "@/components/TooltipBubble";

/** Keep the full summary in the row and reveal clipped text on a short hover. */
export function FeedSummaryText({ label, always, ...props }: ComponentPropsWithoutRef<"span"> & {
  label: string;
  always?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const dismiss = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      {...props}
      ref={anchor}
      data-feed-summary-tooltip={label}
      onPointerEnter={(event) => {
        const text = event.currentTarget;
        if (event.pointerType === "touch" || (!always && text.scrollWidth <= text.clientWidth)) return;
        timer.current = window.setTimeout(() => {
          timer.current = null;
          setOpen(true);
        }, SHOW_DELAY_MS);
      }}
      onPointerLeave={dismiss}
      onPointerCancel={dismiss}
      onPointerDown={dismiss}
      onWheel={dismiss}
    >
      {props.children}
      {open ? (
        <TooltipBubble anchorRef={anchor} align="left" className={HINT_BUBBLE_CLASS.replace("whitespace-nowrap", "max-w-[min(36rem,calc(100vw_-_1rem))] whitespace-normal [overflow-wrap:anywhere]")}>
          {label}
        </TooltipBubble>
      ) : null}
    </span>
  );
}
