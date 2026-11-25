"use client";

import { useEffect, useRef, useState } from "react";

import { buildSeries, burndownForAccount, burndownSegments, computePace, idealRemaining, WINDOW_SECONDS, type BurndownSegments, type WindowKey } from "@/lib/burndown";
import { getLocale, useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";
import type { BurndownPayload, BurndownSeries, EngineLimits, LimitSample } from "@/lib/types";

import { X } from "./icons";
import { windowLabel } from "./rateLimit";
import { engineTintOf } from "./utils";
import { Z } from "@/components/layers";

const VB_W = 320;
const VB_H = 150;
const PAD = { l: 4, r: 4, t: 8, b: 4 };
const PW = VB_W - PAD.l - PAD.r;
const PH = VB_H - PAD.t - PAD.b;

/** Same amber-<30% / red-<10% thresholds the footer bars use; above that the
    curve keeps the engine's identity tint. */
function paceColor(remaining: number, tint: string): string {
  if (remaining <= 10) return "var(--color-danger)";
  if (remaining <= 30) return "var(--color-warning)";
  return tint;
}

function bcp47(): string {
  return getLocale() === "uk" ? "uk-UA" : "en-US";
}

/** Short absolute moment for the depletion projection: hour today, else + date. */
function fmtMoment(unix: number, now: number): string {
  const d = new Date(unix * 1000);
  const time = d.toLocaleTimeString(bcp47(), { hour: "2-digit", minute: "2-digit", hour12: false });
  if (Math.abs(unix - now) < 86400) return time;
  return d.toLocaleDateString(bcp47(), { day: "numeric", month: "short" }) + " " + time;
}

/** The SVG plot: ideal even-pace diagonal (dashed, muted) vs the remaining-quota
    curve, with a "now" marker. What was observed is drawn solid; what the chart
    has to assume (a gap in the history, the span since the last reading, a
    window nobody has read yet) is drawn dashed, in the same colour. Stretches to
    the panel width; non-scaling strokes keep the lines crisp. */
function BurndownChart({ series, segments, tint, now }: { series: BurndownSeries; segments: BurndownSegments; tint: string; now: number }) {
  const { windowStart, resetsAt, windowSeconds, samples } = series;
  const x0 = windowStart ?? samples[0]?.t ?? now - windowSeconds;
  const x1 = resetsAt ?? Math.max(now, samples[samples.length - 1]?.t ?? now);
  const span = x1 > x0 ? x1 - x0 : 1;
  const xScale = (t: number) => PAD.l + (Math.max(x0, Math.min(x1, t)) - x0) / span * PW;
  const yScale = (pct: number) => PAD.t + (100 - Math.max(0, Math.min(100, pct))) / 100 * PH;
  const point = (s: LimitSample) => `${xScale(s.t).toFixed(2)},${yScale(s.remaining).toFixed(2)}`;

  const idealPath =
    windowStart !== null && resetsAt !== null
      ? `M ${xScale(windowStart).toFixed(2)},${yScale(idealRemaining(windowStart, resetsAt, x0)).toFixed(2)} L ${xScale(resetsAt).toFixed(2)},${yScale(idealRemaining(windowStart, resetsAt, x1)).toFixed(2)}`
      : null;
  const curveColor = paceColor(segments.level ?? 100, tint);
  const lastSample = samples[samples.length - 1] ?? null;
  const endDot = segments.level === null ? null : { t: segments.levelEstimated ? now : lastSample?.t ?? now, remaining: segments.level };
  const nowX = xScale(now);

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="h-[150px] w-full" role="img">
      {/* Plot frame + 50% guide */}
      <rect x={PAD.l} y={PAD.t} width={PW} height={PH} className="fill-none stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={PAD.l} y1={yScale(50)} x2={PAD.l + PW} y2={yScale(50)} className="stroke-border" strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" opacity={0.6} />
      {idealPath ? (
        <path d={idealPath} className="fill-none stroke-muted" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" opacity={0.7} />
      ) : null}
      {segments.estimated.map((pair, i) => (
        <path key={`e${i}`} data-burndown-estimated="" d={`M ${point(pair[0])} L ${point(pair[1])}`} fill="none" stroke={curveColor} strokeWidth={2} strokeDasharray="2 3" strokeLinecap="butt" vectorEffect="non-scaling-stroke" opacity={0.8} />
      ))}
      {segments.known.map((run, i) =>
        run.length > 1 ? (
          <path key={`k${i}`} data-burndown-known="" d={run.map((s, j) => `${j === 0 ? "M" : "L"} ${point(s)}`).join(" ")} fill="none" stroke={curveColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ) : (
          <circle key={`k${i}`} data-burndown-known="" cx={xScale(run[0].t)} cy={yScale(run[0].remaining)} r={2} fill={curveColor} vectorEffect="non-scaling-stroke" />
        ),
      )}
      {endDot ? (
        <circle cx={xScale(endDot.t)} cy={yScale(endDot.remaining)} r={2.5} fill={segments.levelEstimated ? "var(--surface-card)" : curveColor} stroke={curveColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ) : null}
      {now > x0 && now < x1 ? (
        <line x1={nowX} y1={PAD.t} x2={nowX} y2={PAD.t + PH} className="stroke-accent" strokeWidth={1} strokeDasharray="1 2" vectorEffect="non-scaling-stroke" opacity={0.7} />
      ) : null}
    </svg>
  );
}

/** The series the panel draws when the history request failed or its payload
    carries no series for the account: the reading the account's own row shows,
    so the chart still says how much is left. */
function readingSeries(reading: EngineLimits | null, key: WindowKey, now: number): BurndownSeries {
  const live = reading?.[key] ?? null;
  const windowSeconds = live?.windowMinutes ? live.windowMinutes * 60 : WINDOW_SECONDS[key];
  return buildSeries([], [], live, now, windowSeconds, null, reading?.capturedAt ?? null);
}

/** A legend key drawn with the chart's own dash pattern: a border on a 12 px
    box renders solid however it is styled, so the key is a short SVG line. */
function LegendKey({ kind, color, dash }: { kind: string; color: string; dash?: string }) {
  return (
    <svg data-burndown-key={kind} width={14} height={4} viewBox="0 0 14 4" aria-hidden className="shrink-0">
      <line x1={0} y1={2} x2={14} y2={2} stroke={color} strokeWidth={dash === "4 3" ? 1.5 : 2} strokeDasharray={dash} opacity={dash === "4 3" ? 0.7 : undefined} />
    </svg>
  );
}

/** Floating burndown panel for one account of one engine, anchored off the rail
    like the cleanup panel: ideal-pace vs remaining quota for the 5h and weekly
    windows. Any listed account opens it, active or not. The chart always draws;
    where history is missing, partial or stale the missing span is dashed. Opened
    from {@link LimitsFooter}; closed via ✕/Esc/outside click (owned by the
    caller). */
export function BurndownPanel({
  engine,
  label,
  plan,
  accountId,
  accountLabel,
  reading,
  sheet = false,
  onClose,
}: {
  engine: "claude" | "codex";
  label: string;
  plan: string | null;
  /** The account being charted; a history response stamped for any other
      account is discarded so a switch never charts the previous account. */
  accountId: string;
  accountLabel: string;
  /** The reading the account's footer line shows: the chart's fallback when
      the history request fails. */
  reading: EngineLimits | null;
  /** Always the bottom sheet: the phone's accounts screen has no rail to anchor beside. */
  sheet?: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const [data, setData] = useState<BurndownPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<WindowKey | null>(null);
  const [now] = useState(() => Math.round(Date.now() / 1000));
  const closeRef = useRef<HTMLButtonElement>(null);
  const who = `${label} · ${accountLabel}`;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // One fetch per mount. LimitsFooter keys this panel by the charted account, so
  // another account remounts it and re-fetches with fresh state; the cleanup's
  // `alive` flag drops a response that arrives after that. The render-time
  // ownership gate below is the second guard for an in-flight account race.
  useEffect(() => {
    let alive = true;
    fetch(`/api/limits/history?engine=${engine}&account=${encodeURIComponent(accountId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<BurndownPayload>) : Promise.reject(new Error(String(res.status)))))
      .then((json) => {
        if (alive) setData(json);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [engine, accountId]);

  const engineData = burndownForAccount(data, engine, accountId);
  const stampedForAccount = Boolean(data && (engine === "claude" ? data.claudeAccountId : data.codexAccountId) === accountId);
  // A response stamped for another account is treated as not-yet-loaded so a
  // stale-account curve never shows; the effect above will refetch.
  const ownershipPending = Boolean(data && !stampedForAccount);
  const loading = !failed && (!data || ownershipPending);
  // The weekly tab opens first, unless this plan reports no weekly window.
  const window: WindowKey = picked ?? (engineData?.weekly.windowUnreported && !engineData.session.windowUnreported ? "session" : "weekly");
  // Each tab is named by the horizon its own series carries, so a plan whose
  // "5h" window is really a weekly one is never labelled 5h (issue #606).
  const tabLabel = (key: WindowKey) => windowLabel(t, key, engineData ? engineData[key].windowSeconds / 60 : null);
  const series = loading ? null : engineData ? engineData[window] : readingSeries(reading, window, now);
  const tint = engineTintOf(engine).color;
  const segments = series && !series.windowUnreported ? burndownSegments(series, now) : null;
  const observed = segments?.kind === "fresh" || segments?.kind === "partial";
  const pace = series && observed ? computePace(series, now) : null;
  const atText = segments?.lastObservedAt != null ? fmtMoment(segments.lastObservedAt, now) : "";

  const paceText = (() => {
    if (!pace) return null;
    if (pace.delta < -2) return t("burndown.fast", { pct: Math.round(-pace.delta) });
    if (pace.delta > 2) return t("burndown.slow", { pct: Math.round(pace.delta) });
    return t("burndown.even");
  })();
  const projectText = pace?.zeroCrossing ? t("burndown.emptyBy", { at: fmtMoment(pace.zeroCrossing, now) }) : null;
  const readout = (() => {
    if (!segments) return null;
    if (segments.kind === "none") return t("burndown.noReading");
    if (segments.kind === "reset") return t("burndown.resetSince", { at: atText });
    if (segments.kind === "stale") return t("burndown.leftEstimated", { pct: Math.round(segments.level ?? 0), at: atText });
    return t("burndown.left", { pct: Math.round(segments.level ?? 0) });
  })();
  const sinceText =
    engine === "claude" && (series?.samples.length ?? 0) < 2 && data?.historySince
      ? t("burndown.buildsFrom", { date: new Date(data.historySince).toLocaleDateString(locale === "uk" ? "uk-UA" : "en-US", { day: "numeric", month: "short" }) })
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-burndown-dialog=""
      aria-label={t("burndown.openAria", { engine: who })}
      tabIndex={-1}
      onKeyDown={(event) => {
        handleOverlayEscape(event, onClose);
        // The phone sheet is modal: Tab cycles inside it rather than into the screen behind.
        if (sheet && event.key === "Tab" && !event.defaultPrevented) {
          const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])"));
          const first = stops[0];
          const last = stops[stops.length - 1];
          const active = document.activeElement;
          if (!first || !last) event.preventDefault();
          else if (event.shiftKey && (active === first || active === event.currentTarget)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
        }
      }}
      className={`fixed bottom-3 left-1/2 ${Z.modal} flex w-[min(430px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[12px] border border-border bg-card shadow-2 ${sheet ? "" : "sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0"}`}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate text-[12.5px] font-bold" style={{ color: tint }}>{who}</span>
        <span className="text-[11px] text-muted">{t("burndown.title")}</span>
        {plan ? <span className="truncate text-[10px] text-muted">{plan}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-[8px] border border-border p-0.5" role="tablist" aria-label={t("burndown.windowAria")}>
            {(["weekly", "session"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={window === key}
                onClick={() => setPicked(key)}
                className={`rounded-[6px] px-2 py-0.5 text-[10.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${window === key ? "bg-sunken text-primary" : "text-muted hover:text-primary"}`}
              >
                {tabLabel(key)}
              </button>
            ))}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t("burndown.close")}
            onClick={onClose}
            className="rounded-[6px] p-1 text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </header>
      <div className="px-3 py-2.5">
        {loading ? (
          <div className="py-6 text-center text-[12px] text-muted">{t("burndown.loading")}</div>
        ) : series?.windowUnreported ? (
          // A precise reason beats a blank chart: the engine reports no window
          // of this horizon at all, so no sampling will ever fill it.
          <div className="py-6 text-center text-[12px] text-muted">{t("burndown.windowUnreported", { window: tabLabel(window) })}</div>
        ) : series && segments ? (
          <>
            <BurndownChart series={series} segments={segments} tint={tint} now={now} />
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted">
              <span className="flex items-center gap-1">
                <LegendKey kind="ideal" color="var(--color-muted)" dash="4 3" />
                {t("burndown.ideal")}
              </span>
              <span className="flex items-center gap-2">
                {segments.estimated.length > 0 ? (
                  <span className="flex items-center gap-1">
                    <LegendKey kind="estimated" color={tint} dash="2 3" />
                    {t("burndown.estimated")}
                  </span>
                ) : null}
                <span className="flex items-center gap-1">
                  <LegendKey kind="actual" color={tint} />
                  {t("burndown.actual")}
                </span>
              </span>
            </div>
            <div data-burndown-readout="" className="mt-2 text-[11.5px] font-semibold text-primary">
              {readout}
              {paceText ? <span className="ml-1 font-semibold">· {paceText}</span> : null}
              {projectText ? <span className="ml-1 font-normal text-muted">· {projectText}</span> : null}
            </div>
            {failed ? <div className="mt-1 text-[11px] text-muted">{t("burndown.failed")}</div> : null}
            {sinceText ? <div className="mt-1 text-[11px] text-muted">{sinceText}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
