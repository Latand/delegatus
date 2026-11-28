"use client";

import { useEffect, useId, useState } from "react";

import { burndownForAccount, idealRemaining } from "@/lib/burndown";
import type { BurndownPayload, BurndownSeries } from "@/lib/types";

/** The plot's vertical room, in percent of the row: a full line and an empty one never sit on the row's edge. */
const INSET = 6;

type Point = { x: number; y: number };

/** The week's marks in the SVG's own 0–100 box, or null when the series cannot
    be placed: a window with no known start or reset, a window the plan does not
    report, or fewer than two samples (one reading has no slope). The x axis is
    the popover's: the window's start to its reset, so the line ends at "now". */
export function sparklineGeometry(series: BurndownSeries | null): { line: Point[]; guide: [Point, Point] } | null {
  if (!series || series.windowUnreported || series.windowStart === null || series.resetsAt === null) return null;
  const start = series.windowStart;
  const end = series.resetsAt;
  if (!(end > start)) return null;
  const samples = series.samples.filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.remaining));
  if (samples.length < 2) return null;
  const x = (t: number) => (Math.max(start, Math.min(end, t)) - start) / (end - start) * 100;
  const y = (pct: number) => INSET + (100 - Math.max(0, Math.min(100, pct))) / 100 * (100 - 2 * INSET);
  return {
    line: samples.map((sample) => ({ x: x(sample.t), y: y(sample.remaining) })),
    guide: [{ x: 0, y: y(idealRemaining(start, end, start)) }, { x: 100, y: y(idealRemaining(start, end, end)) }],
  };
}

const at = (p: Point) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;

/** The area's fill opacity. The muted ink of a row's limit lines is 5.1:1 on the card in both themes, so a fill over 7% (the engine tint, amber or red) takes it under the 4.5:1 floor; this is the strongest that keeps every inactive row's text above it. */
export const SPARKLINE_AREA_OPACITY = 0.07;

/** The strokes' own opacity, inside the 8–15% the design names: the slope reads between the glyphs and never strikes through a name, a figure or a date. The guide is the fainter of the two. */
export const SPARKLINE_LINE_OPACITY = 0.15;
export const SPARKLINE_GUIDE_OPACITY = 0.12;

/** An account's week behind its row: the area under the remaining-quota line, the line, and the dashed even-pace guide from corner to corner. Area above the guide means under pace. The area is the muted ink, never the engine tint, so no other row can pass for the default account's wash (a 7% tint of its engine); it fades to nothing at "now", so no edge crosses a word and a fresh week is a soft wedge, not a block. The default row's wash leaves its muted text near the floor, so it draws the line and the guide without the area. It is a picture only: no pointer events, hidden from assistive technology, and it takes the box it is put in, so the row's size never changes. */
export function AccountSparkline({ series, color, stale = false, active = false }: { series: BurndownSeries | null; color: string; stale?: boolean; active?: boolean }) {
  const shape = sparklineGeometry(series);
  const fade = `spark-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (!shape) return null;
  const floor = 100 - INSET;
  const first = shape.line[0]!;
  const last = shape.line[shape.line.length - 1]!;
  const area = `M ${at({ x: first.x, y: floor })} ${shape.line.map((p) => `L ${at(p)}`).join(" ")} L ${at({ x: last.x, y: floor })} Z`;
  return (
    <svg
      aria-hidden
      focusable="false"
      data-account-sparkline=""
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
      style={stale ? { opacity: 0.6 } : undefined}
    >
      <defs>
        <linearGradient id={fade} data-sparkline-fade="" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="var(--color-muted)" stopOpacity={1} />
          <stop offset="1" stopColor="var(--color-muted)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path data-sparkline-guide="" d={`M ${at(shape.guide[0])} L ${at(shape.guide[1])}`} fill="none" stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity={SPARKLINE_GUIDE_OPACITY} />
      {active ? null : <path data-sparkline-area="" d={area} fill={`url(#${fade})`} fillOpacity={SPARKLINE_AREA_OPACITY} stroke="none" />}
      <path data-sparkline-line="" d={`M ${shape.line.map(at).join(" L ")}`} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity={SPARKLINE_LINE_OPACITY} />
    </svg>
  );
}

/** One account's weekly series from the history route the burndown popover reads, once when the row mounts. It stays null while loading, after a failure and for an account that is not asked for, so a row looks exactly as it did until a series arrives. A response stamped for another account is discarded, as the popover discards it. */
export function useWeeklySeries(engine: "claude" | "codex", accountId: string, enabled: boolean): BurndownSeries | null {
  const [series, setSeries] = useState<BurndownSeries | null>(null);
  useEffect(() => {
    if (!enabled || typeof fetch !== "function") return;
    let alive = true;
    fetch(`/api/limits/history?engine=${engine}&account=${encodeURIComponent(accountId)}&backfill=stored`)
      .then((res) => (res.ok ? (res.json() as Promise<BurndownPayload>) : Promise.reject(new Error(String(res.status)))))
      .then((json) => {
        if (alive) setSeries(burndownForAccount(json, engine, accountId)?.weekly ?? null);
      })
      .catch(() => {
        if (alive) setSeries(null);
      });
    return () => {
      alive = false;
    };
  }, [engine, accountId, enabled]);
  return enabled ? series : null;
}
