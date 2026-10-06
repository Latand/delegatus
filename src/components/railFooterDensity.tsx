import type { ReactNode } from "react";

/**
 * How much room a rail footer block takes (docs/design/sidebar-redesign.md).
 * `full` is the footer the product ships; `line` and `gauge` exist for the
 * sidebar design prototypes and nothing in the product asks for them.
 * A line is one row per block in a shared three-column grid; a gauge is one
 * square per block for a rail too narrow for words.
 */
export type RailFooterDensity = "full" | "line" | "gauge";

/** The share of a resource already spent: fuller is worse in every block. */
export function PressureBar({ percent, color, className = "w-10" }: { percent: number | null; color: string; className?: string }) {
  return (
    <span aria-hidden className={`block h-[4px] shrink-0 overflow-hidden rounded-full bg-sunken ${className}`}>
      {percent === null ? null : <span className="block h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, percent))}%`, backgroundColor: color }} />}
    </span>
  );
}

/** One footer line: a name in the first column, a reading and its bar at the right edge. */
export function MeterLine({ label, value, percent, color }: { label: ReactNode; value: ReactNode; percent: number | null; color: string }) {
  return (
    <span className="flex h-[22px] items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-primary">{label}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted">{value}</span>
      <PressureBar percent={percent} color={color} />
    </span>
  );
}

/** One footer square: a mark above its bar, and a second bar when the block has two readings. */
export function MeterGauge({ mark, percent, color, second }: { mark: ReactNode; percent: number | null; color: string; second?: { percent: number; color: string } }) {
  return (
    <span className={`flex w-10 flex-col items-center justify-center ${second ? "h-10 gap-[3px]" : "h-9 gap-[5px]"}`}>
      <span className="flex h-3.5 items-center text-[9.5px] font-bold leading-none text-secondary">{mark}</span>
      <PressureBar percent={percent} color={color} className="w-6" />
      {second ? <PressureBar percent={second.percent} color={second.color} className="w-6" /> : null}
    </span>
  );
}

export const GAUGE_BUTTON = "flex items-center justify-center rounded-[9px] hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
