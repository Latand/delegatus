"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";

const GAP = 6;
const EDGE = 8;

type Box = { top: number; bottom: number; left: number; right: number; width: number };

/**
 * Where a bubble of `size` goes against `anchor`: on the asked side when it
 * fits there, else on the other one, and always inside the window. With
 * `bounds` (the host's own box) a side that keeps the bubble inside them wins
 * over one that does not, so a bubble taller than the room above its card
 * opens below instead of over the card above.
 */
export function tooltipPlacement(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: "top" | "bottom",
  align: "center" | "left" | "right",
  bounds?: { top: number; bottom: number },
): { left: number; top: number } {
  const wanted = align === "right" ? anchor.right - size.width : align === "left" ? anchor.left : anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(EDGE, Math.min(wanted, viewport.width - size.width - EDGE));
  const above = anchor.top - GAP - size.height;
  const below = anchor.bottom + GAP;
  const fitsAbove = above >= Math.max(EDGE, bounds?.top ?? EDGE);
  const fitsBelow = below + size.height <= Math.min(viewport.height - EDGE, bounds?.bottom ?? viewport.height - EDGE);
  const top = side === "top" ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above;
  return { left, top: Math.max(EDGE, Math.min(top, viewport.height - size.height - EDGE)) };
}

/**
 * A hover or focus bubble portalled to the document at the tooltip layer and
 * placed from its anchor's box. Left inside its host, a bubble is cut by the
 * host's `overflow` whatever layer it carries: the composer's send hint was a
 * sliver in the orchestrator seat (#1858).
 */
export function TooltipBubble({
  id,
  anchorRef,
  side = "top",
  align = "center",
  className,
  within,
  children,
}: {
  /** For the anchor's `aria-describedby`, so a screen reader reads the bubble. */
  id?: string;
  anchorRef: RefObject<Element | null>;
  side?: "top" | "bottom";
  align?: "center" | "left" | "right";
  className: string;
  /** The host's own box, read when the bubble is placed: the side that keeps the bubble inside it is preferred. */
  within?: () => { top: number; bottom: number } | null;
  children: ReactNode;
}) {
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current;
      const bubble = bubbleRef.current;
      if (!anchor || !bubble) return;
      setPosition(
        tooltipPlacement(
          anchor.getBoundingClientRect(),
          { width: bubble.getBoundingClientRect().width, height: bubble.getBoundingClientRect().height },
          { width: window.innerWidth, height: window.innerHeight },
          side,
          align,
          within?.() ?? undefined,
        ),
      );
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef, side, align, within]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <span
      ref={bubbleRef}
      id={id}
      role="tooltip"
      style={position ?? { left: -9999, top: 0, visibility: "hidden" }}
      className={`pointer-events-none fixed ${Z.tooltip} ${className}`}
    >
      {children}
    </span>,
    document.body,
  );
}
