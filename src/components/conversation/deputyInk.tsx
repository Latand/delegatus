"use client";

import { createContext, useContext } from "react";

import { EngineMark } from "@/components/EngineMark";

/**
 * The seat's parallel self, drawn in outline (docs/design/ghost-seat.md §6.2).
 *
 * Rows inside a deputy's block are the feed's own rows; this context is the
 * one thing that tells them they belong to the parallel self, so a prose row
 * trades its filled engine circle for the outline mark and its ink for
 * `text-secondary`. Nothing is dimmed by opacity: secondary ink clears the
 * contrast floor on every surface, a block at 60 % opacity would not.
 */
export const DeputyInkContext = createContext(false);

export function useDeputyInk(): boolean {
  return useContext(DeputyInkContext);
}

/** The seat's engine mark inside a dashed ring: the parallel self's avatar. */
export function DeputyMark({ engine, size = 20, className = "" }: { engine: string; size?: 20 | 26; className?: string }) {
  return (
    <span
      data-deputy-mark
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-strong bg-canvas text-secondary ${size === 26 ? "h-6.5 w-6.5" : "h-5 w-5"} ${className}`}
    >
      <EngineMark engine={engine} size={size === 26 ? 14 : 12} tone="inherit" />
    </span>
  );
}
