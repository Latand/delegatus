"use client";

import { Check, GripVertical, Mic, MicOff, Minimize2, PhoneOff, SendHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { EngineMark } from "@/components/EngineMark";
import { useLocale } from "@/lib/i18n";
import type { Locale, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { clampToViewport, CONTROL_SELECTOR, isFree, settlePlacement, type Point, type Rect, type Size } from "@/lib/voiceCompanion/placement";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CaptionLine, type CompanionState, type DelegationStage } from "@/lib/voiceCompanion/reducer";

import { CompanionCharacter, type CharacterHandle } from "./CompanionCharacter";
import { VOICE_COMPANION_CSS } from "./voiceCompanionStyles";

/**
 * The floating voice companion (#2519, docs/design/voice-companion-research.md).
 * A prototype surface: no production view mounts it. It reads one adapter
 * through one reducer and knows nothing about where the events come from.
 *
 * Placement is the window's own duty: it floats in the free rectangle nearest
 * the place it was asked for and covers no control; with no free rectangle it
 * docks into a strip and publishes that strip's height as
 * `--voice-companion-reserve`, which the host surface reflows around. It
 * collapses to a small shape and has no way to be dismissed.
 */

export type CompanionVariant = 1 | 2 | 3;

const EXPANDED: Record<CompanionVariant, Size> = { 1: { width: 304, height: 300 }, 2: { width: 456, height: 156 }, 3: { width: 248, height: 328 } };
const COLLAPSED: Record<CompanionVariant, Size> = { 1: { width: 60, height: 60 }, 2: { width: 176, height: 52 }, 3: { width: 64, height: 64 } };
const DOCK_HEIGHT = { expanded: 204, collapsed: 60 } as const;
const CHARACTER: Record<CompanionVariant, number> = { 1: 58, 2: 56, 3: 92 };
const DRAG_THRESHOLD = 6;
const RISE_MS = 320;
const OUT_MS = 900;
const IN_MS = 700;
/** How many of the latest lines the window draws; the rest stay in the transcript. */
const VISIBLE_LINES = 4;

const ENGINE_NAME = { claude: "Claude", codex: "Codex" } as const;

function createStore(adapter: VoiceCompanionAdapter) {
  let state: CompanionState = INITIAL_COMPANION_STATE;
  const views = new Set<() => void>();
  const levels = new Set<(level: number) => void>();
  const stop = adapter.subscribe((event) => {
    const next = reduceCompanion(state, event);
    if (next === state) return;
    const visible = next.revision !== state.revision;
    const mouth = next.mouth !== state.mouth;
    state = next;
    if (mouth) for (const listener of levels) listener(state.mouth);
    if (visible) for (const listener of views) listener();
  });
  return {
    get: () => state,
    subscribe: (listener: () => void) => { views.add(listener); return () => { views.delete(listener); }; },
    onLevel: (listener: (level: number) => void) => { levels.add(listener); return () => { levels.delete(listener); }; },
    stop,
  };
}

/** Every visible control on the page outside the companion, as viewport rectangles.
    A control scrolled out of its container is cut to the part that can be reached. */
function controlRects(self: Element | null, extra: string | undefined): Rect[] {
  const rects: Rect[] = [];
  const clips = new Map<Element, DOMRect | null>();
  const clipOf = (element: Element): DOMRect | null => {
    if (!clips.has(element)) {
      const style = getComputedStyle(element);
      clips.set(element, style.overflowX !== "visible" || style.overflowY !== "visible" ? element.getBoundingClientRect() : null);
    }
    return clips.get(element)!;
  };
  for (const node of document.querySelectorAll<HTMLElement>(extra ? `${CONTROL_SELECTOR},${extra}` : CONTROL_SELECTOR)) {
    if (self?.contains(node)) continue;
    const box = node.getBoundingClientRect();
    let left = Math.max(box.left, 0);
    let top = Math.max(box.top, 0);
    let right = Math.min(box.right, innerWidth);
    let bottom = Math.min(box.bottom, innerHeight);
    for (let parent = node.parentElement; parent && right - left >= 1 && bottom - top >= 1; parent = parent.parentElement) {
      const clip = clipOf(parent);
      if (!clip) continue;
      left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
    }
    if (right - left < 1 || bottom - top < 1) continue;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") continue;
    rects.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return rects;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const mark = (name: string, durationMs: number) => { try { performance.mark(name, { detail: { durationMs } }); } catch { /* measurement only */ } };

type Layout = { mode: "float"; at: Point } | { mode: "dock" };

const DELEGATION_OPEN: readonly DelegationStage[] = ["awaiting-confirmation", "sending", "queued", "delivered", "unknown", "answered", "cancelled", "refused", "failed"];
/* A settled refusal or answer leaves the strip after the operator has read it. */
const DELEGATION_LINGER_MS = 5_000;

export function VoiceCompanion({ adapter, variant, project, locale: sessionLocale, protect, defaultCollapsed = false, showVariantNumber = false }: {
  adapter: VoiceCompanionAdapter;
  variant: CompanionVariant;
  project: string;
  /** The language the session is started in; defaults to the interface language. */
  locale?: Locale;
  /** Extra selector for surfaces the host treats as controls (a draggable card). */
  protect?: string;
  defaultCollapsed?: boolean;
  /** Prints the variant number on the window, for comparison captures. */
  showVariantNumber?: boolean;
}) {
  const { t, locale } = useLocale();
  const [store] = useState(() => createStore(adapter));
  useEffect(() => store.stop, [store]);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [muted, setMuted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lingering, setLingering] = useState(true);
  /* The proposal the operator already answered: its buttons take no second tap. */
  const [decidedFor, setDecidedFor] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const character = useRef<CharacterHandle>(null);
  const linesEl = useRef<HTMLDivElement>(null);
  const delegEl = useRef<HTMLDivElement>(null);
  const bodyEl = useRef<HTMLDivElement>(null);
  const pellet = useRef<HTMLSpanElement>(null);
  const rail = useRef<HTMLSpanElement>(null);
  /* Where the operator last put the window, as its bottom-right corner: the
     corner survives a change of size between expanded and collapsed. */
  const anchor = useRef<Point | null>(null);
  const swallowClick = useRef(false);

  const sizeFor = useCallback((isCollapsed: boolean): Size => {
    const size = isCollapsed ? COLLAPSED[variant] : EXPANDED[variant];
    /* The rail stacks its four controls in a column, and a touch target is 44 px. */
    const height = !isCollapsed && variant === 2 && matchMedia("(pointer: coarse)").matches ? 196 : size.height;
    return { width: Math.min(size.width, innerWidth - 16), height };
  }, [variant]);

  /** Float at the free rectangle nearest the anchor, else dock. */
  const settle = useCallback((isCollapsed: boolean) => {
    const viewport = { width: innerWidth, height: innerHeight };
    const size = sizeFor(isCollapsed);
    const corner = anchor.current ?? { x: viewport.width - 16, y: viewport.height - 16 };
    const next = settlePlacement({ viewport, size, obstacles: controlRects(root.current, protect), desired: { x: corner.x - size.width, y: corner.y - size.height } });
    setLayout((current) => (current && current.mode === next.mode && (next.mode === "dock" || (current.mode === "float" && current.at.x === next.at.x && current.at.y === next.at.y)) ? current : next));
  }, [protect, sizeFor]);

  /* First placement, and again whenever the viewport changes. */
  useLayoutEffect(() => {
    settle(collapsed);
    const onResize = () => settle(collapsed);
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, [collapsed, settle]);

  /* The page changes under the window (a menu opens, a message arrives with
     its controls): when a control ends up beneath it, the window moves. */
  useEffect(() => {
    if (layout?.mode !== "float" || dragging) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      timer = null;
      const size = sizeFor(collapsed);
      if (!isFree({ ...layout.at, ...size }, controlRects(root.current, protect))) {
        anchor.current = { x: layout.at.x + size.width, y: layout.at.y + size.height };
        settle(collapsed);
      }
    };
    const observer = new MutationObserver((records) => {
      if (timer || records.every((record) => root.current?.contains(record.target))) return;
      timer = setTimeout(check, 250);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [layout, dragging, collapsed, protect, settle, sizeFor]);

  /* The docked strip's height is the space the host surface gives up. */
  const docked = layout?.mode === "dock";
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    if (docked) style.setProperty("--voice-companion-reserve", `${collapsed ? DOCK_HEIGHT.collapsed : DOCK_HEIGHT.expanded}px`);
    else style.removeProperty("--voice-companion-reserve");
    return () => { style.removeProperty("--voice-companion-reserve"); };
  }, [docked, collapsed]);

  /* The mouth: one transform per level sample, outside React. */
  useEffect(() => store.onLevel((level) => character.current?.setLevel(reducedMotion() ? (level > 0 ? 0.5 : 0) : level)), [store]);
  const speaking = state.phase === "speaking";
  useEffect(() => { if (!speaking) character.current?.setLevel(0); }, [speaking, collapsed]);

  /* Rising lines: the stack grows at the bottom and the growth is played back
     as a transform, so nothing animates layout. */
  const lastHeight = useRef(0);
  const visibleLines = state.lines.slice(-VISIBLE_LINES);
  const linesKey = visibleLines.map((line) => `${line.key}:${line.text.length}`).join("|");
  useLayoutEffect(() => {
    const element = linesEl.current;
    if (!element) { lastHeight.current = 0; return; }
    const height = element.offsetHeight;
    const grown = height - lastHeight.current;
    lastHeight.current = height;
    if (grown <= 0 || reducedMotion() || typeof element.animate !== "function") return;
    /* A rise already in flight continues from where it is. */
    const flying = new DOMMatrixReadOnly(getComputedStyle(element).transform).m42;
    for (const running of element.getAnimations()) running.cancel();
    element.animate([{ transform: `translate3d(0, ${flying + grown}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration: RISE_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    mark("vc:caption-rise", RISE_MS);
  }, [linesKey, collapsed]);

  /* The delegation strip pushes the captions up by its own height. */
  const delegation = state.delegation;
  const stage = delegation?.stage ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new stage is on screen again
    setLingering(true);
    if (stage !== "answered" && stage !== "cancelled" && stage !== "refused" && stage !== "failed") return;
    const timer = setTimeout(() => setLingering(false), DELEGATION_LINGER_MS);
    return () => clearTimeout(timer);
  }, [stage]);
  const connected = state.phase !== "offline";
  const delegationOpen = connected && !!stage && DELEGATION_OPEN.includes(stage) && lingering;
  /* The tray under the lines holds the delegation while one is in hand, and
     the way to start talking while nobody is connected. */
  const trayOpen = delegationOpen || !connected;
  useLayoutEffect(() => {
    bodyEl.current?.style.setProperty("--vc-shift", `${trayOpen ? delegEl.current?.offsetHeight ?? 0 : 0}px`);
  }, [trayOpen, stage, collapsed, connected]);

  /* The hand-off: a pellet leaves for the orchestrator, and comes back with the answer. */
  useEffect(() => {
    const dot = pellet.current;
    const distance = (rail.current?.offsetWidth ?? 0) - 10;
    if (!dot || distance <= 0 || reducedMotion() || typeof dot.animate !== "function") return;
    if (stage === "sending") {
      dot.animate([{ transform: "translate3d(0, 0, 0)", opacity: 1 }, { transform: `translate3d(${distance}px, 0, 0)`, opacity: 1 }], { duration: OUT_MS, easing: "cubic-bezier(0.45, 0, 0.2, 1)" });
      mark("vc:delegation-out", OUT_MS);
    } else if (stage === "answered") {
      dot.animate([{ transform: `translate3d(${distance}px, 0, 0)`, opacity: 1 }, { transform: "translate3d(0, 0, 0)", opacity: 1 }], { duration: IN_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      mark("vc:delegation-in", IN_MS);
    }
  }, [stage, collapsed]);

  /* Dragging: the window follows the pointer by transform; where it is dropped
     is only a request, and the placement rule answers it. */
  const drag = useRef<{ id: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; at: Point } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !layout) return;
    const target = event.target as HTMLElement;
    if (target.closest("button:not(.vc-shape):not([data-grip]), a, input")) return;
    const box = root.current!.getBoundingClientRect();
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, originX: box.left, originY: box.top, moved: false, at: { x: box.left, y: box.top } };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) return;
    const dx = event.clientX - held.startX;
    const dy = event.clientY - held.startY;
    if (!held.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      held.moved = true;
      root.current!.setPointerCapture(event.pointerId);
      const size = sizeFor(collapsed);
      if (layout?.mode === "dock") {
        /* Lifted out of the dock: it floats under the pointer. */
        held.originX = event.clientX - size.width / 2 - dx;
        held.originY = event.clientY - Math.min(40, size.height / 2) - dy;
        setLayout({ mode: "float", at: { x: held.originX + dx, y: held.originY + dy } });
      }
      setDragging(true);
    }
    held.at = clampToViewport({ x: held.originX + dx, y: held.originY + dy }, { width: innerWidth, height: innerHeight }, sizeFor(collapsed), 0);
    if (root.current) root.current.style.transform = `translate3d(${held.at.x}px, ${held.at.y}px, 0)`;
  };
  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) return;
    drag.current = null;
    if (!held.moved) return;
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 0);
    const size = sizeFor(collapsed);
    anchor.current = { x: held.at.x + size.width, y: held.at.y + size.height };
    setLayout({ mode: "float", at: held.at });
    setDragging(false);
    settle(collapsed);
  };
  const onKeyMove = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const move = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key];
    if (!move && event.key !== "Home") return;
    event.preventDefault();
    const size = sizeFor(collapsed);
    if (event.key === "Home") anchor.current = null;
    else {
      const box = root.current!.getBoundingClientRect();
      const at = clampToViewport({ x: box.left + move![0], y: box.top + move![1] }, { width: innerWidth, height: innerHeight }, size);
      anchor.current = { x: at.x + size.width, y: at.y + size.height };
    }
    settle(collapsed);
  };

  const toggle = (next: boolean) => {
    if (swallowClick.current) return;
    if (layout?.mode === "float") {
      const size = sizeFor(collapsed);
      anchor.current = { x: layout.at.x + size.width, y: layout.at.y + size.height };
    }
    setCollapsed(next);
  };
  const talk = () => { void adapter.start({ locale: sessionLocale ?? (locale === "uk" ? "uk" : "en"), project }); };
  const end = () => { void adapter.close(); };
  const toggleMute = () => { const next = !muted; setMuted(next); void adapter.command({ type: "mute", muted: next }); };
  const decide = (decision: "send" | "cancel") => {
    if (!delegation?.proposal || decidedFor === delegation.proposal.proposalId) return;
    setDecidedFor(delegation.proposal.proposalId);
    void adapter.command({ type: "confirmation", proposalId: delegation.proposal.proposalId, decision, via: "tap" });
  };

  const size = sizeFor(collapsed);
  const phaseLabel = t(`voiceCompanion.phase.${state.phase}`);
  const attention = stage === "awaiting-confirmation" || (stage === "answered" && lingering);
  const speaker = (line: CaptionLine) => (line.speaker === "operator" ? t("voiceCompanion.you") : line.speaker === "orchestrator" ? t("voiceCompanion.orchestrator") : null);
  const last = state.lines.at(-1);
  const recipient = delegation?.proposal?.recipient ?? delegation?.delivery?.recipient ?? null;
  const arrived = stage === "queued" || stage === "delivered" || stage === "answered";
  const style = !layout ? { visibility: "hidden" as const, width: size.width, height: size.height }
    : layout.mode === "dock" ? { height: collapsed ? DOCK_HEIGHT.collapsed : DOCK_HEIGHT.expanded }
    : { width: size.width, height: size.height, transform: `translate3d(${layout.at.x}px, ${layout.at.y}px, 0)` };

  const characterNode = (
    <span className="vc-perch">
      <CompanionCharacter ref={character} size={collapsed ? (layout?.mode === "dock" || variant === 2 ? 32 : variant === 3 ? 46 : 42) : layout?.mode === "dock" ? 54 : CHARACTER[variant]} />
      {collapsed && attention ? <span className="vc-flag" data-companion-flag aria-hidden /> : null}
    </span>
  );

  return (
    <section
      ref={root}
      className="vc"
      role="complementary"
      aria-label="Delegatus"
      data-voice-companion
      data-variant={variant}
      data-layout={layout?.mode ?? "float"}
      data-phase={state.phase}
      data-collapsed={collapsed ? "" : undefined}
      data-delegating={delegationOpen ? "" : undefined}
      data-delegation-stage={stage ?? undefined}
      data-dragging={dragging ? "" : undefined}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <style>{VOICE_COMPANION_CSS}</style>
      {showVariantNumber ? <span className="vc-badge" data-companion-variant-number aria-label={t("voiceCompanion.variant", { n: variant })}>{variant}</span> : null}
      {collapsed ? (
        <>
          <button type="button" className="vc-shape vc-pop" data-companion-expand aria-label={`${t("voiceCompanion.expand")} · ${phaseLabel}`} aria-expanded={false} onClick={() => toggle(false)} onKeyDown={onKeyMove}>
            {characterNode}
            {variant === 2 && layout?.mode !== "dock" ? <span className="vc-phase"><span className="vc-dot" />{phaseLabel}</span> : null}
          </button>
          {layout?.mode === "dock" ? (
            <span className="vc-strip">
              <span className="vc-phase"><span className="vc-dot" />{phaseLabel}</span>
              {last ? <span className="vc-strip-line">{last.text}</span> : null}
            </span>
          ) : null}
        </>
      ) : (
        <>
          <div className="vc-top vc-pop">
            {characterNode}
            <div className="vc-status">
              <span className="vc-name">Delegatus</span>
              <span className="vc-phase" data-companion-phase><span className="vc-dot" />{phaseLabel}</span>
              {state.mode === "simulated" || !connected ? <span className="vc-sim">{t("voiceCompanion.simulated")}</span> : null}
            </div>
            <div className="vc-controls">
              <button type="button" className="vc-btn" data-grip aria-label={t("voiceCompanion.move")} onKeyDown={onKeyMove}><GripVertical size={16} aria-hidden /></button>
              {connected ? (
                <>
                  <button type="button" className="vc-btn" data-on={muted ? "" : undefined} aria-pressed={muted} aria-label={t(muted ? "voiceCompanion.unmute" : "voiceCompanion.mute")} onClick={toggleMute}>
                    {muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
                  </button>
                  <button type="button" className="vc-btn" data-companion-end aria-label={t("voiceCompanion.end")} onClick={end}><PhoneOff size={16} aria-hidden /></button>
                </>
              ) : null}
              <button type="button" className="vc-btn" data-companion-collapse aria-label={t("voiceCompanion.collapse")} aria-expanded onClick={() => toggle(true)}><Minimize2 size={16} aria-hidden /></button>
            </div>
          </div>
          <div className="vc-body" ref={bodyEl}>
            <div className="vc-captions" aria-hidden>
              <div className="vc-lines" ref={linesEl} data-companion-lines>
                {visibleLines.map((line, index) => (
                  <p key={line.key} className="vc-line" data-speaker={line.speaker} data-old={index < visibleLines.length - 1 && line.speaker !== "orchestrator" ? "" : undefined} data-companion-line>
                    {speaker(line) ? <span className="vc-who">{speaker(line)}</span> : null}
                    {line.text}
                    {line.interrupted ? <span className="vc-cut">{t("voiceCompanion.interrupted")}</span> : null}
                  </p>
                ))}
              </div>
            </div>
            <div className="vc-deleg" ref={delegEl} data-open={trayOpen ? "" : undefined} data-stage={connected ? stage ?? undefined : "offline"} data-companion-delegation>
              {!connected ? (
                <button type="button" className="vc-talk" data-companion-talk onClick={talk}><Mic size={14} aria-hidden />{t("voiceCompanion.talk")}</button>
              ) : delegation ? (
                <>
                  <div className="vc-deleg-head">
                    <span>{stage === "awaiting-confirmation" ? t("voiceCompanion.proposal", { project: recipient?.project ?? project }) : t(`voiceCompanion.stage.${stage === "proposed" ? "sending" : stage!}`)}</span>
                    {recipient ? <span className="vc-deleg-engine"><EngineMark engine={recipient.engine} size={14} />{ENGINE_NAME[recipient.engine]}</span> : null}
                  </div>
                  {stage === "awaiting-confirmation" ? (
                    <>
                      <p className="vc-instruction" title={delegation.instruction} data-companion-instruction>{delegation.instruction}</p>
                      <div className="vc-acts">
                        <button type="button" className="vc-act" data-companion-cancel disabled={decidedFor === delegation.proposal?.proposalId} onClick={() => decide("cancel")}><X size={14} aria-hidden />{t("voiceCompanion.cancel")}</button>
                        <button type="button" className="vc-act" data-primary data-companion-send disabled={decidedFor === delegation.proposal?.proposalId} onClick={() => decide("send")}><SendHorizontal size={14} aria-hidden />{t("voiceCompanion.send")}</button>
                      </div>
                    </>
                  ) : (
                    <div className="vc-track" data-companion-track>
                      <span className="vc-end"><CompanionMini /></span>
                      <span className="vc-rail" ref={rail}><span className="vc-pellet" ref={pellet} /></span>
                      <span className="vc-end" data-done={arrived ? "" : undefined}>{arrived ? <Check size={13} aria-hidden /> : recipient ? <EngineMark engine={recipient.engine} size={14} /> : null}</span>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </>
      )}
      {/* The whole conversation, for a screen reader and for anyone who missed a line. */}
      <ol className="vc-sr" aria-live="polite" aria-label={t("voiceCompanion.transcript")} data-companion-transcript>
        {state.lines.filter((line) => line.final).map((line) => <li key={line.key}>{speaker(line) ?? "Delegatus"}: {line.text}</li>)}
      </ol>
    </section>
  );
}

function CompanionMini() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/delegatus-mark.svg" alt="" aria-hidden width={14} height={14} draggable={false} />
  );
}
