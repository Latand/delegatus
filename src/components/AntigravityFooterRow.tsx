"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import { isAntigravitySessionWindowActive } from "@/lib/limits/antigravityQuota";
import type { EngineLimits, LimitsProvenance } from "@/lib/types";

import { EngineMark } from "./EngineMark";
import { Z } from "./layers";
import { barColor, LimitWindowLine, quotaAsOfHint } from "./LimitRow";
import { AntigravityBody, antigravityCardState, antigravityStateLine, antigravityStateTone, useAntigravityAccount } from "./onboarding/AntigravityCard";
import { windowLabel } from "./rateLimit";
import { LINE_EDGE, ReserveBar, type SidebarFooterDensity } from "./railFooterDensity";
import { engineTintOf } from "./utils";

/**
 * Antigravity CLI quota row in the sidebar footer (docs/design/antigravity-engine.md §3.6).
 *
 * Antigravity exposes quota state when a 5-hour window is exhausted (`RESOURCE_EXHAUSTED`).
 * The quota line appears when an active session quota reading is present and disappears
 * cleanly once the reset window elapses. The row itself also shows while `agy` is installed
 * or not (once the server has answered), and opens the sign-in card in a flyout (the account
 * settings this engine had no entry in). A machine without `agy` reads "Not installed" and
 * the flyout carries the install command, so the operator can find how to get this engine.
 */
export function AntigravityFooterRow({ limits, limitsAccountId, now, provenance, density }: {
  density: SidebarFooterDensity;
  limits: EngineLimits | null;
  limitsAccountId: string | null;
  now: number;
  provenance?: LimitsProvenance;
}) {
  const { t, locale } = useLocale();
  const agy = useAntigravityAccount();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  /* Bounded by the room above the row, as the other flyouts are. */
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const node = panelRef.current;
      if (node) setMaxHeight(Math.max(160, Math.floor(node.getBoundingClientRect().bottom - 8)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    /* Focus stays on the row button after a click, outside the panel, so Escape is read on the window. */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      rowButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const session = limits?.session ?? null;
  const quota = !!session && !!limitsAccountId && isAntigravitySessionWindowActive(session, now);
  const state = antigravityCardState(agy);
  /* The server has answered about `agy` (installed or not): the row names that state. */
  if (!quota && agy.cli === null) return null;

  const tint = engineTintOf("antigravity");
  const left = quota && session ? Math.max(0, Math.min(100, 100 - session.usedPercent)) : null;
  const color = left === null ? tint.color : barColor(left, tint.color);
  const label = quota && session ? windowLabel(t, "session", session.windowMinutes) : "";
  const stateText = antigravityStateLine(t, state, agy.plan, "row");
  /* A signed-in engine with no quota reading has nothing to open: the row already says Connected and the tier.
     A flyout the person opened to sign in stays until they close it, so the check's result lands where they are looking. */
  const interactive = open || !(state === "connected" && left === null);
  const summary = [
    "Antigravity",
    limits?.plan ?? agy.plan,
    left === null ? stateText : `${label} ${t("limits.left")} ${Math.round(left)}%`,
  ].filter(Boolean).join(" · ");

  const rowClass = `flex h-[26px] w-full items-center gap-1.5 ${LINE_EDGE} text-left`;
  const rowInner = (
    <>
      <span className="flex min-w-max flex-1 items-center gap-1.5">
        <span data-meter-name="" className="text-[11.5px] font-semibold text-primary">Antigravity</span>
        <EngineMark engine="antigravity" size={12} label="Antigravity" />
      </span>
      {left === null ? (
        <span data-antigravity-state={state} title={stateText ?? undefined} className={`min-w-0 shrink truncate text-[10px] ${state === "connected" ? "text-muted" : antigravityStateTone(state)}`}>{stateText}</span>
      ) : (
        <>
          <span data-meter-value="" className="shrink-0 text-[11px] tabular-nums text-muted">
            {t("limits.left")} <span className="font-bold text-primary">{Math.round(left)}%</span>
          </span>
          <ReserveBar percent={left} color={color} />
        </>
      )}
    </>
  );

  return (
    <div ref={containerRef} className="relative" data-engine-limits="antigravity" data-limits-source={provenance?.source ?? "transcript"}>
      {interactive ? (
        <button
          ref={rowButtonRef}
          type="button"
          data-meter-line=""
          aria-expanded={open}
          title={summary}
          onClick={() => { setOpen((value) => !value); if (!open) void agy.reload(); }}
          className={`${rowClass} hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
        >
          {rowInner}
        </button>
      ) : (
        <div data-meter-line="" title={summary} className={rowClass}>{rowInner}</div>
      )}
      {density === "detail" && quota && session ? (
        <div data-limits-windows="" className={`${LINE_EDGE} pb-1`}>
          {limits?.plan ? (
            <span data-meter-note="" className="-mt-0.5 block truncate pb-0.5 text-[10px] leading-[13px] text-muted">
              Antigravity · {limits.plan}
            </span>
          ) : null}
          <LimitWindowLine
            label={label}
            window={session}
            engineColor={tint.color}
            now={now}
            staleHint={session.observedAt != null && now - session.observedAt > 300 ? quotaAsOfHint(session.observedAt, locale) : null}
          />
        </div>
      ) : null}
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Antigravity"
          data-antigravity-panel=""
          style={maxHeight === null ? undefined : { maxHeight }}
          className={`absolute bottom-1 left-full ml-2 ${Z.modal} flex w-[min(360px,calc(100vw-264px))] flex-col gap-2 overflow-y-auto overscroll-contain rounded-[14px] border border-border bg-card px-3.5 py-2.5 text-[11.5px] shadow-2 [&>*]:shrink-0`}
        >
          <AntigravityBody agy={agy} />
        </div>
      ) : null}
    </div>
  );
}
