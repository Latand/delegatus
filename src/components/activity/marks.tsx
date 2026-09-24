"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Z } from "@/components/layers";

/*
 * The marks the desktop activity page draws with
 * (docs/design/activity-dashboard-v2.md, "Colour"). Two hues carry the page:
 * indigo is you, teal is agents. Texture means one thing, "your input was not
 * read": the teal stripe is agent time on a project whose input was not read
 * (unclear), the grey hatch a stretch a host was not read and nothing else is
 * known. The SVG patterns and the CSS stripes lean the same way.
 */

export type MarkKind = "you" | "you-half" | "supervised" | "unattended" | "unclear" | "unread" | "track";

export const MARK_FILL: Record<MarkKind, string> = {
  you: "var(--mark-you)",
  "you-half": "var(--mark-you-half)",
  supervised: "var(--mark-supervised)",
  unattended: "var(--mark-unattended)",
  unclear: "url(#activity-hatch-unclear)",
  unread: "url(#activity-hatch-unread)",
  track: "var(--mark-track)",
};

const STRIPE_UNCLEAR = "repeating-linear-gradient(45deg, var(--mark-stripe) 0 1.3px, transparent 1.3px 3.6px), var(--mark-unattended)";
const STRIPE_UNREAD = "repeating-linear-gradient(45deg, var(--mark-hatch) 0 1.2px, transparent 1.2px 3.5px), var(--mark-track)";

export function markStyle(kind: MarkKind): CSSProperties {
  if (kind === "unclear") return { background: STRIPE_UNCLEAR };
  if (kind === "unread") return { background: STRIPE_UNREAD };
  return { background: MARK_FILL[kind] };
}

/** The two hatches, defined once per page and referenced by every chart. */
export function MarkPatterns() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden focusable="false">
      <defs>
        <pattern id="activity-hatch-unread" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
          <rect width="4" height="4" fill="var(--mark-track)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--mark-hatch)" strokeWidth="1.2" />
        </pattern>
        <pattern id="activity-hatch-unclear" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
          <rect width="4" height="4" fill="var(--mark-unattended)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--mark-stripe)" strokeWidth="1.3" />
        </pattern>
      </defs>
    </svg>
  );
}

export function Swatch({ kind, className = "" }: { kind: MarkKind; className?: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ${className}`} style={markStyle(kind)} />;
}

/** A value row of a tooltip: a swatch (or none), the value right-aligned,
    then its label, so a value is never read off a sentence. */
export function TipRow({ kind, value, label }: { kind?: MarkKind; value: string; label: string }) {
  return (
    <>
      {kind ? <Swatch kind={kind} /> : <span aria-hidden />}
      <span className="text-right font-semibold tabular-nums whitespace-nowrap text-primary">{value}</span>
      <span className="whitespace-nowrap text-secondary">{label}</span>
    </>
  );
}

export function TipGap() {
  return <span aria-hidden className="col-span-3 h-[5px]" />;
}

/** Items joined by a middle dot, each kept whole on its line; a line
    breaks after a dot, never before one. */
export function Items({ items }: { items: ReactNode[] }) {
  return (
    <>
      {items.map((item, index) => (
        <span key={index}>
          <span className="whitespace-nowrap">{item}{index < items.length - 1 ? " ·" : ""}</span>
          {index < items.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

export interface TipAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * A tooltip in viewport coordinates. `right` sits beside the anchor and flips
 * to its left when it would leave `bounds`; `below` and `above` hang from it.
 * It is kept inside the viewport whatever the side.
 */
export function Tooltip({ anchor, side, bounds, children, id }: {
  anchor: TipAnchor;
  side: "right" | "below" | "above";
  bounds?: TipAnchor;
  children: ReactNode;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const view = { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
    const limit = bounds ?? view;
    let left: number;
    let top: number;
    if (side === "right") {
      left = anchor.right + 12;
      if (left + width > limit.right - 8) left = anchor.left - 12 - width;
      top = Math.max(limit.top + 8, Math.min(anchor.top, limit.bottom - 8 - height));
    } else if (side === "below") {
      left = anchor.left;
      top = anchor.bottom + 8;
    } else {
      left = (anchor.left + anchor.right) / 2 - width / 2;
      top = anchor.top - 8 - height;
      if (top < view.top) top = anchor.bottom + 8;
    }
    left = Math.max(view.left, Math.min(left, view.right - width));
    top = Math.max(view.top, Math.min(top, view.bottom - height));
    setPlace((current) => current && current.left === left && current.top === top ? current : { left, top });
  }, [anchor.left, anchor.right, anchor.top, anchor.bottom, side, bounds, children]);
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`pointer-events-none fixed ${Z.tooltip} w-max max-w-[300px] rounded-[8px] border border-border bg-raised px-[11px] py-[9px] text-[12px] leading-[1.45] shadow-2`}
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999 }}
      data-activity-tooltip=""
    >
      {children}
    </div>
  );
}
