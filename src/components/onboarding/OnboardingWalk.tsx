"use client";

import { MessageSquare, Route } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { Z } from "@/components/layers";
import { requestOrchestratorDraft } from "@/components/orchestrator/draftPrefill";
import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";

import { openOnboarding, publishOnboarding, putOnboarding, useOnboardingSnapshot } from "./useOnboarding";
import { onInterfaceWalkRequest, publishWalkStop, type WalkStop } from "./walkStop";

/**
 * The interface walk (#2166 §3.8): three popovers on the live interface, each
 * anchored on a `[data-walk-anchor]` element the board draws, the rest of the
 * page dimmed by one box whose outer shadow covers everything but the anchor.
 *
 * It starts by itself once, the first time the current project's seat is live
 * on an install whose marker is not `existing-install` and whose `walk` is
 * still null. Skip, Escape, or the last button writes `walk` and it never
 * starts by itself again. The menu row "Interface walk" starts it on the
 * current project when its seat is live, and opens the setup guide otherwise.
 *
 * The anchors, one per stop, named the same on both layouts:
 * - `seat`: the desktop seat (the walk points at its composer inside it), the phone's board dock;
 * - `board`: the desktop board frame, the phone's column tabs;
 * - `needs`: the desktop Needs-you island, the phone bar's badge slot, which the
 *   shell draws empty while stop 3 shows (`useWalkStop`).
 */

type WalkAnchor = "seat" | "board" | "needs";

const ANCHOR: Record<WalkStop, WalkAnchor> = { 1: "seat", 2: "board", 3: "needs" };
const TITLE: Record<WalkStop, MessageKey> = { 1: "onboarding.walk.1.title", 2: "onboarding.walk.2.title", 3: "onboarding.walk.3.title" };
const BODY: Record<WalkStop, { desktop: MessageKey; phone: MessageKey }> = {
  1: { desktop: "onboarding.walk.1.body", phone: "onboarding.walk.1.bodyPhone" },
  2: { desktop: "onboarding.walk.2.body", phone: "onboarding.walk.2.body" },
  3: { desktop: "onboarding.walk.3.body", phone: "onboarding.walk.3.bodyPhone" },
};

/* ── Placement ─────────────────────────────────────────────────────────── */

export interface WalkRect { left: number; top: number; right: number; bottom: number }

export interface WalkLayout {
  /** The spotlight: the anchor and a 4 px margin, clipped to its pane and the
      window. Null when the anchor is missing or wholly outside them. */
  hole: WalkRect | null;
  pop: { left: number; top: number; width: number };
  /** The popover's pointer, on its top edge (popover below the anchor) or its
      bottom edge (above). Null when the popover sits over the anchor. */
  arrow: { left: number; top: number; edge: "top" | "bottom" } | null;
}

/** The spotlight's margin around its anchor. */
export const WALK_PAD = 4;
/** The popover's distance from the window's edges and from the spotlight. */
export const WALK_EDGE = 12;
export const WALK_POP_WIDTH = 340;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function walkLayout(input: {
  anchor: WalkRect | null;
  /** The anchor's pane: on the desktop the board, right of the rail. */
  pane: WalkRect;
  viewport: { width: number; height: number };
  /** The popover's drawn height. */
  popHeight: number;
  phone: boolean;
}): WalkLayout {
  const { anchor, pane, viewport, popHeight, phone } = input;
  const width = phone ? viewport.width - 2 * WALK_EDGE : Math.min(WALK_POP_WIDTH, viewport.width - 2 * WALK_EDGE);
  let hole: WalkRect | null = null;
  if (anchor) {
    const next = {
      left: Math.max(anchor.left - WALK_PAD, pane.left, 0),
      top: Math.max(anchor.top - WALK_PAD, pane.top, 0),
      right: Math.min(anchor.right + WALK_PAD, pane.right, viewport.width),
      bottom: Math.min(anchor.bottom + WALK_PAD, pane.bottom, viewport.height),
    };
    if (next.right - next.left > 0 && next.bottom - next.top > 0) hole = next;
  }
  const maxTop = viewport.height - popHeight - WALK_EDGE;
  if (!hole) {
    return {
      hole: null,
      pop: { left: Math.round((viewport.width - width) / 2), top: Math.round(clamp((viewport.height - popHeight) / 2, WALK_EDGE, maxTop)), width },
      arrow: null,
    };
  }
  const centre = (hole.left + hole.right) / 2;
  const minLeft = pane.left + WALK_EDGE + width <= viewport.width - WALK_EDGE ? Math.max(WALK_EDGE, pane.left + WALK_EDGE) : WALK_EDGE;
  const left = phone ? WALK_EDGE : Math.round(clamp(centre - width / 2, minLeft, viewport.width - width - WALK_EDGE));
  const below = hole.bottom + WALK_EDGE;
  const above = hole.top - WALK_EDGE - popHeight;
  let top: number;
  let edge: "top" | "bottom" | null;
  /* Below when it fits; over an anchor tall enough to hold it (the board
     under the seat), in its lower part; above; and over it when nothing fits. */
  const holds = hole.bottom - hole.top >= popHeight + 2 * WALK_EDGE;
  if (below <= maxTop) { top = below; edge = "top"; }
  else if (!holds && above >= WALK_EDGE) { top = above; edge = "bottom"; }
  else { top = clamp(hole.bottom - popHeight - WALK_EDGE, WALK_EDGE, maxTop); edge = null; }
  top = Math.round(top);
  const arrow = edge
    ? { left: Math.round(clamp(centre - 6, left + 16, left + width - 28)), top: edge === "top" ? top - 6 : top + popHeight - 6, edge }
    : null;
  return { hole, pop: { left, top, width }, arrow };
}

/* ── The DOM ───────────────────────────────────────────────────────────── */

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The element a stop points at: the first drawn `[data-walk-anchor]` of its
    name; on the desktop seat, the composer inside it when there is one. */
export function findWalkAnchor(stop: WalkStop, root: ParentNode = document): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>(`[data-walk-anchor="${ANCHOR[stop]}"]`)];
  const anchor = all.find(visible) ?? null;
  if (!anchor || stop !== 1) return anchor;
  const composer = anchor.querySelector<HTMLElement>("[data-orchestrator-conversation] form");
  return composer && visible(composer) ? composer : anchor;
}

function paneOf(anchor: HTMLElement, viewport: WalkRect): WalkRect {
  const pane = anchor.closest("[data-kanban-board]") ?? anchor.closest("main");
  if (!pane) return viewport;
  const rect = pane.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** The seat's composer on the desktop, the dock that opens the seat's conversation on the phone. */
function giveFirstTask(mobile: boolean): void {
  const seat = document.querySelector<HTMLElement>('[data-walk-anchor="seat"]');
  if (!seat) return;
  if (mobile) {
    seat.click();
    return;
  }
  seat.querySelector<HTMLElement>("[data-orchestrator-conversation] textarea")?.focus({ preventScroll: false });
}

export function OnboardingWalk({ project, projectCwd, mobile }: {
  /** The project the Viewer shows; null on the Overview. */
  project: string | null;
  projectCwd?: string;
  mobile: boolean;
}) {
  const { t } = useLocale();
  const { loaded, marker, guideOpen } = useOnboardingSnapshot();
  const [stop, setStop] = useState<WalkStop | null>(null);
  const [requested, setRequested] = useState(false);
  /* Once per page: a walk that ended is not started again by the same seat read. */
  const ranRef = useRef(false);
  const auto = loaded && !ranRef.current && marker?.reason !== "existing-install" && (marker?.walk ?? null) === null;
  const watching = project !== null && (auto || requested);
  const seat = useOrchestratorSeat(watching ? project : null, projectCwd);
  const live = Boolean(seat.status?.exists && seat.status.seat?.conversationId);

  const begin = useCallback((target: string) => {
    ranRef.current = true;
    /* The desktop shows the project's Board with its seat expanded, which is
       what the guide's "Open it" asks for; the phone's board is its screen. */
    if (!mobile) requestOrchestratorDraft({ project: target, launch: null });
    setStop(1);
  }, [mobile]);

  useEffect(() => {
    if (!auto || guideOpen || stop !== null || !live || project === null) return;
    begin(project);
  }, [auto, begin, guideOpen, live, project, stop]);

  useEffect(() => {
    return onInterfaceWalkRequest(() => {
      if (project === null) openOnboarding("guide");
      else setRequested(true);
    });
  }, [project]);

  useEffect(() => {
    if (!requested || project === null) return;
    if (!seat.status && !seat.failed) return;
    setRequested(false);
    if (live) begin(project);
    else openOnboarding("guide");
  }, [begin, live, project, requested, seat.failed, seat.status]);

  useEffect(() => { publishWalkStop(stop); }, [stop]);
  useEffect(() => () => publishWalkStop(null), []);

  const returnFocus = useRef<HTMLElement | null>(null);
  const finish = useCallback((outcome: "done" | "skipped") => {
    setStop(null);
    void putOnboarding({ walk: outcome }).then((written) => { if (written) publishOnboarding({ marker: written }); });
    if (outcome === "done") giveFirstTask(mobile);
    else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    returnFocus.current = null;
  }, [mobile]);

  if (stop === null) return null;
  return <WalkStopView key={stop} stop={stop} mobile={mobile} t={t} returnFocus={returnFocus} onNext={() => setStop((stop + 1) as WalkStop)} onFinish={finish} />;
}

function WalkStopView({ stop, mobile, t, returnFocus, onNext, onFinish }: {
  stop: WalkStop;
  mobile: boolean;
  t: TFunction;
  returnFocus: React.MutableRefObject<HTMLElement | null>;
  onNext: () => void;
  onFinish: (outcome: "done" | "skipped") => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState<WalkLayout | null>(null);
  const last = stop === 3;

  useLayoutEffect(() => {
    let scrolled = false;
    const measure = () => {
      const pop = popRef.current;
      if (!pop) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const whole = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
      const anchor = findWalkAnchor(stop);
      /* An anchor wholly off screen is brought into view once; one partly on
         screen stays where it is, so the seat above the board keeps its place. */
      if (anchor && !scrolled) {
        scrolled = true;
        const box = anchor.getBoundingClientRect();
        if (box.bottom <= 0 || box.top >= viewport.height || box.right <= 0 || box.left >= viewport.width) anchor.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
      const rect = anchor?.getBoundingClientRect();
      const next = walkLayout({
        anchor: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        pane: anchor && !mobile ? paneOf(anchor, whole) : whole,
        viewport,
        popHeight: pop.getBoundingClientRect().height,
        phone: mobile,
      });
      setLayout((previous) => (previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    measure();
    /* The seat expands, the Board mounts and the badge slot appears after the
       stop does; a short re-measure follows them without a layout observer on
       every element of the page. */
    const timer = window.setInterval(measure, 150);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [mobile, stop]);

  /* Escape skips wherever focus is: the walk leaves the page usable, so focus may be anywhere. */
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      finishRef.current("skipped");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Focus moves in once the popover is placed: a hidden one cannot take it. */
  const placed = layout !== null;
  useEffect(() => {
    if (!placed) return;
    if (!returnFocus.current && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      returnFocus.current = document.activeElement;
    }
    primaryRef.current?.focus({ preventScroll: true });
  }, [placed, returnFocus]);

  const hole = layout?.hole ?? null;
  const round = stop === 3;
  const popStyle: CSSProperties = layout
    ? { left: layout.pop.left, top: layout.pop.top, width: layout.pop.width }
    : { left: 0, top: 0, width: mobile ? `calc(100vw - ${2 * WALK_EDGE}px)` : WALK_POP_WIDTH, visibility: "hidden" };
  const titleId = `walk-title-${stop}`;
  return (
    <>
      {hole ? (
        <div
          aria-hidden
          data-walk-spotlight={ANCHOR[stop]}
          className={`pointer-events-none fixed ${Z.modal} ${round ? "rounded-full" : "rounded-[12px]"}`}
          style={{
            left: hole.left,
            top: hole.top,
            width: hole.right - hole.left,
            height: hole.bottom - hole.top,
            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.4), inset 0 0 0 2px var(--color-accent)",
          }}
        />
      ) : layout ? (
        <div aria-hidden data-walk-spotlight="" className={`pointer-events-none fixed inset-0 ${Z.modal} bg-black/40`} />
      ) : null}
      <div
        ref={popRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-walk-popover={stop}
        className={`fixed ${Z.popover} rounded-[12px] border border-border bg-raised p-4 shadow-2`}
        style={popStyle}
      >
        {layout?.arrow ? (
          <span
            aria-hidden
            data-walk-arrow={layout.arrow.edge}
            className={`absolute h-3 w-3 rotate-45 border-border bg-raised ${layout.arrow.edge === "top" ? "-top-1.5 border-l border-t" : "-bottom-1.5 border-b border-r"}`}
            style={{ left: layout.arrow.left - layout.pop.left }}
          />
        ) : null}
        <div className="flex items-center gap-2">
          <span aria-hidden data-walk-mark="" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
            <Route className="h-3.5 w-3.5" />
          </span>
          <span className="text-label font-semibold tabular-nums text-muted">{t("onboarding.walk.of", { n: stop })}</span>
          <span className="flex-1" />
          {/* The label ends on the popover's inner edge, as the title starts on it; the hit area reaches past it. */}
          <button
            type="button"
            data-walk-skip=""
            className="-my-1 -mr-2 inline-flex h-8 items-center rounded-[8px] px-2 text-ui font-semibold text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
            onClick={() => onFinish("skipped")}
          >
            <span data-walk-skip-label="">{t("onboarding.walk.skip")}</span>
          </button>
        </div>
        <h3 id={titleId} data-walk-title="" className="mt-2 text-[14px] font-bold leading-snug text-primary">{t(TITLE[stop])}</h3>
        <p data-walk-body="" className="mt-1 text-body leading-[1.45] text-secondary">{t(mobile ? BODY[stop].phone : BODY[stop].desktop)}</p>
        <div className="mt-4 flex items-center gap-2">
          <span aria-hidden data-walk-dots="" className="flex gap-1">
            {([1, 2, 3] as const).map((dot) => (
              <span key={dot} className={`h-1.5 rounded-full ${dot === stop ? "w-4 bg-accent" : "w-1.5 bg-border"}`} />
            ))}
          </span>
          <span className="flex-1" />
          <button
            ref={primaryRef}
            type="button"
            data-walk-primary=""
            className="inline-flex h-8 items-center justify-center gap-2 rounded-[8px] bg-brand px-4 text-ui font-semibold text-on-brand hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
            onClick={() => (last ? onFinish("done") : onNext())}
          >
            {last ? <MessageSquare className="h-3.5 w-3.5" aria-hidden /> : null}
            {last ? t("onboarding.walk.first") : t("onboarding.walk.next")}
          </button>
        </div>
        {last ? <p data-walk-again="" className="mt-3 border-t border-border pt-3 text-caption text-muted">{t("onboarding.walk.again")}</p> : null}
      </div>
    </>
  );
}
