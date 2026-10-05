"use client";

import { Check, CircleAlert, LoaderCircle, Mic, MicOff, Minimize2, PhoneOff, SendHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { EngineMark } from "@/components/EngineMark";
import { useLocale } from "@/lib/i18n";
import type { Locale, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import {
  BUBBLE_MAX_WIDTH, clampToViewport, CONTROL_SELECTOR, isFree, laneLayout, placeCollapsed, placeExpanded, splitSpeech,
  type LaneLayout, type Point, type Rect, type Size,
} from "@/lib/voiceCompanion/placement";
import { INITIAL_COMPANION_STATE, reduceCompanion, type CompanionState, type DelegationView, type SpeechLine, type ToolCallView } from "@/lib/voiceCompanion/reducer";

import { CompanionCharacter, type CharacterHandle } from "./CompanionCharacter";
import { VOICE_COMPANION_CSS } from "./voiceCompanionStyles";

/**
 * The floating voice companion (#2519, docs/design/voice-companion-research.md §9).
 * A prototype surface: no production view mounts it. It reads one adapter
 * through one reducer and knows nothing about where the events come from.
 *
 * The character is the floating object, with no frame around it. What it says
 * appears as separate speech bubbles beside it that rise, older ones drifting
 * away and fading; tool calls and the delegation appear as their own elements
 * in the same lane. The lane is reserved with the character, so placing the
 * character decides what the bubbles may cover: nothing that takes a click.
 * Outside a bubble, an element and the character, every click reaches the
 * page underneath. It collapses to a small shape and has no way to be dismissed.
 */

export type CompanionVariant = 1 | 2 | 3;

/* The character with its controls under it, and the collapsed shape, per variant. */
const BLOCK: Record<CompanionVariant, Size> = { 1: { width: 132, height: 148 }, 2: { width: 132, height: 134 }, 3: { width: 132, height: 150 } };
const CHARACTER: Record<CompanionVariant, number> = { 1: 76, 2: 62, 3: 70 };
const SHAPE: Record<CompanionVariant, Size> = { 1: { width: 52, height: 52 }, 2: { width: 140, height: 44 }, 3: { width: 56, height: 56 } };
const SHAPE_CHARACTER: Record<CompanionVariant, number> = { 1: 40, 2: 30, 3: 40 };
/** The most speech bubbles shown at once; an older one leaves when a newer one would exceed it. */
export const SPEECH_CAP = 4;
/** The most call elements shown at once; the rest are counted on one more element. */
export const CALL_CAP = 4;
/** A speech bubble leaves this long after its line finished. */
export const SPEECH_LINGER_MS = 9_000;
/** A finished call leaves this long after its result. */
export const CALL_LINGER_MS = 5_000;
/** A settled delegation (answered, refused, cancelled, failed) leaves this long after it settled. */
export const DELEGATION_LINGER_MS = 14_000;
/** The nominal speaking rate the bubbles of a playing line are paced by. A
    presentation pace only: no word is claimed to have been heard by it. */
export const NOMINAL_MS_PER_CHAR = 58;
/* Room kept at the far end of the lane for a bubble that is leaving. */
const EXIT_ROOM = 18;
const DRAG_THRESHOLD = 6;
const RISE_MS = 340;
const ENTER_MS = 260;
const EXIT_MS = 420;

const ENGINE_NAME = { claude: "Claude", codex: "Codex" } as const;

function createStore(adapter: VoiceCompanionAdapter) {
  let state: CompanionState = INITIAL_COMPANION_STATE;
  const views = new Set<() => void>();
  const levels = new Set<(state: CompanionState) => void>();
  const stop = adapter.subscribe((event) => {
    const next = reduceCompanion(state, event);
    if (next === state) return;
    const visible = next.revision !== state.revision;
    const level = next.mouth !== state.mouth || next.playedMs !== state.playedMs;
    state = next;
    if (level) for (const listener of levels) listener(state);
    if (visible) for (const listener of views) listener();
  });
  return {
    get: () => state,
    subscribe: (listener: () => void) => { views.add(listener); return () => { views.delete(listener); }; },
    onLevel: (listener: (state: CompanionState) => void) => { levels.add(listener); return () => { levels.delete(listener); }; },
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
const viewportSize = (): Size => ({ width: innerWidth, height: innerHeight });

type Layout =
  | { mode: "expanded"; at: Point; laneHeight: number }
  /* `yielded`: the companion was open but no free place held its lane. */
  | { mode: "collapsed"; at: Point; yielded: boolean };

/** One thing in the lane: a bubble of speech, a tool call, the delegation, or the count of calls not shown. */
type Floater =
  | { kind: "speech"; key: string; speaker: SpeechLine["speaker"]; text: string; cut: number | null; newest: boolean; settled: boolean }
  | { kind: "call"; key: string; call: ToolCallView; settled: boolean }
  | { kind: "delegation"; key: string; delegation: DelegationView; settled: boolean }
  | { kind: "more"; key: string; count: number; settled: false };

/** How many bubbles of a line are out: all of an operator's line and of a
    played one, none before its audio starts, and while it plays, those the
    nominal pace has reached. A cut line keeps those its audio reached. */
function bubblesOut(line: SpeechLine, chunks: readonly string[], playedMs: number): number {
  if (line.speaker === "operator" || line.playback === "played") return chunks.length;
  if (line.playback === "pending" || line.playback === "none") return 0;
  const played = line.playback === "cut" ? line.playedMs ?? 0 : playedMs;
  let offset = 0;
  let out = 0;
  for (const chunk of chunks) {
    if (out > 0 && offset * NOMINAL_MS_PER_CHAR > played) break;
    out += 1;
    offset += chunk.length + 1;
  }
  return out;
}

const DELEGATION_SETTLED = new Set(["answered", "refused", "cancelled", "failed"]);

export function VoiceCompanion({ adapter, variant, project, locale: sessionLocale, protect, defaultCollapsed = false, showVariantNumber = false }: {
  adapter: VoiceCompanionAdapter;
  variant: CompanionVariant;
  project: string;
  /** The language the session is started in; defaults to the interface language. */
  locale?: Locale;
  /** Extra selector for surfaces the host treats as controls (a draggable card). */
  protect?: string;
  defaultCollapsed?: boolean;
  /** Prints the variant number beside the character, for comparison captures. */
  showVariantNumber?: boolean;
}) {
  const { t, locale } = useLocale();
  const [store] = useState(() => createStore(adapter));
  useEffect(() => store.stop, [store]);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [layout, setLayout] = useState<Layout | null>(null);
  /* While held: where the character is and the lane it would have there. */
  const [heldView, setHeld] = useState<{ at: Point; lane: LaneLayout | null } | null>(null);
  const [muted, setMuted] = useState(false);
  const [dragging, setDragging] = useState(false);
  /* The proposal the operator already answered: its buttons take no second tap. */
  const [decidedFor, setDecidedFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /* How many bubbles of the playing line are out, moved by the level samples outside React. */
  const [paced, setPaced] = useState<{ key: string; out: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  const stackEl = useRef<HTMLDivElement>(null);
  const character = useRef<CharacterHandle>(null);
  const pellet = useRef<HTMLSpanElement>(null);
  const rail = useRef<HTMLSpanElement>(null);
  /* Where the operator last put the character, as its bottom-right corner:
     the corner survives a change of size between open and collapsed. */
  const anchor = useRef<Point | null>(null);
  const swallowClick = useRef(false);

  const shape = SHAPE[variant];
  const block = BLOCK[variant];

  /** Open at the free place nearest the anchor; with none, collapse there instead. */
  const settle = useCallback((isCollapsed: boolean) => {
    const viewport = viewportSize();
    const obstacles = controlRects(root.current, protect);
    const corner = anchor.current ?? { x: viewport.width - 16, y: viewport.height - 16 };
    let next: Layout | null = null;
    if (!isCollapsed) {
      const open = placeExpanded({ viewport, block, obstacles, desired: { x: corner.x - block.width, y: corner.y - block.height } });
      if (open) next = { mode: "expanded", at: open.at, laneHeight: open.laneHeight };
    }
    if (!next) {
      const at = placeCollapsed({ viewport, size: shape, obstacles, desired: { x: corner.x - shape.width, y: corner.y - shape.height } })
        ?? clampToViewport({ x: corner.x - shape.width, y: corner.y - shape.height }, viewport, shape);
      next = { mode: "collapsed", at, yielded: !isCollapsed };
    }
    setLayout((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [block, protect, shape]);

  /* First placement, and again whenever the viewport changes. */
  useLayoutEffect(() => {
    settle(collapsed);
    const onResize = () => settle(collapsed);
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, [collapsed, settle]);

  const expanded = layout?.mode === "expanded";
  const lane = useMemo(() => (layout?.mode === "expanded" ? laneLayout(viewportSize(), { ...layout.at, ...block }, layout.laneHeight) : null), [layout, block]);
  const shownLane = heldView ? heldView.lane : lane;

  /** The rectangles the companion reserves where it stands: the character, and the lane when open. */
  const footprint = useCallback((): Rect[] => {
    if (!layout) return [];
    if (layout.mode === "collapsed") return [{ ...layout.at, ...shape }];
    return [{ ...layout.at, ...block }, ...(lane ? [lane.rect] : [])];
  }, [layout, lane, block, shape]);

  /* The page changes under the companion (a menu opens, a message arrives with
     its controls): when a control ends up beneath what it reserves, it moves.
     A companion that collapsed for want of room tries to open again. */
  useEffect(() => {
    if (!layout || dragging) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      timer = null;
      const obstacles = controlRects(root.current, protect);
      const blocked = footprint().some((rect) => !isFree(rect, obstacles));
      if (blocked || (layout.mode === "collapsed" && layout.yielded)) {
        const size = layout.mode === "collapsed" ? shape : block;
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
  }, [layout, dragging, collapsed, protect, settle, footprint, shape, block]);

  /* The mouth, and the pace of the playing line's bubbles: one transform per
     level sample, and a render only when another bubble is due. */
  useEffect(() => store.onLevel((current) => {
    character.current?.setLevel(reducedMotion() ? (current.mouth > 0 ? 0.5 : 0) : current.mouth);
    const playing = current.playing && current.lines.find((line) => line.key === `companion:${current.playing!.itemId}`);
    if (!playing) return;
    const out = bubblesOut(playing, splitSpeech(playing.text), current.playedMs);
    setPaced((shown) => (shown?.key === playing.key && shown.out === out ? shown : { key: playing.key, out }));
  }), [store]);
  const speaking = state.phase === "speaking";
  useEffect(() => { if (!speaking) character.current?.setLevel(0); }, [speaking, collapsed]);

  /* What is in the lane, oldest first: speech, then the calls nearest the character. */
  const candidates = useMemo((): Floater[] => {
    const speech: Floater[] = [];
    const lines = state.lines.filter((line) => line.text.trim());
    lines.forEach((line, lineIndex) => {
      const chunks = splitSpeech(line.text);
      const out = line.playback === "playing" && paced?.key === line.key ? Math.max(1, Math.min(paced.out, chunks.length)) : bubblesOut(line, chunks, 0);
      const done = line.speaker === "operator" ? line.final : line.playback === "played" || line.playback === "cut";
      for (let index = 0; index < out; index += 1) {
        const last = index === out - 1;
        speech.push({
          kind: "speech", key: `${line.key}#${index}`, speaker: line.speaker, text: chunks[index]!,
          cut: line.playback === "cut" && last ? line.playedMs ?? 0 : null,
          newest: lineIndex === lines.length - 1 && last, settled: done || !last,
        });
      }
    });
    const calls: Floater[] = state.calls.map((call) => ({ kind: "call", key: `call:${call.callId}`, call, settled: call.status !== "running" }));
    const delegation = state.delegation;
    /* Delivered work stays in view after the conversation ends; a proposal does not. */
    const deleg: Floater[] = delegation && (state.phase !== "offline" || ["queued", "delivered", "answered"].includes(delegation.stage))
      ? [{ kind: "delegation", key: `delegation:${delegation.callId}`, delegation, settled: DELEGATION_SETTLED.has(delegation.stage) }]
      : [];
    return [...speech, ...calls, ...deleg];
  }, [state.lines, state.calls, state.delegation, state.phase, paced]);

  /* When each floater settled, so that it can leave on time; then what has not lingered long enough. */
  const [settledAt, setSettledAt] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stamping the moment a floater settled
    setSettledAt((current) => {
      const keys = new Set(candidates.map((floater) => floater.key));
      const next = new Map([...current].filter(([key]) => keys.has(key)));
      const stamp = Date.now();
      for (const floater of candidates) {
        if (floater.settled && !next.has(floater.key)) next.set(floater.key, stamp);
        if (!floater.settled) next.delete(floater.key);
      }
      return next.size === current.size && [...next].every(([key, at]) => current.get(key) === at) ? current : next;
    });
  }, [candidates]);
  const live = useMemo(() => {
    const linger = (floater: Floater) => (floater.kind === "speech" ? SPEECH_LINGER_MS : floater.kind === "call" ? CALL_LINGER_MS : DELEGATION_LINGER_MS);
    return candidates.filter((floater) => !settledAt.has(floater.key) || now - settledAt.get(floater.key)! < linger(floater));
  }, [candidates, settledAt, now]);

  /* A clock for the lingering, ticking only while something can still leave. */
  const lingering = live.some((floater) => floater.settled);
  useEffect(() => {
    if (!lingering) return;
    const timer = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(timer);
  }, [lingering]);

  /* Keys measured not to fit the lane; the oldest speech goes first. */
  const [overflow, setOverflow] = useState<ReadonlySet<string>>(new Set());
  const floaters = useMemo(() => {
    const speech = live.filter((floater) => floater.kind === "speech").slice(-SPEECH_CAP).filter((floater) => !overflow.has(floater.key));
    const calls = live.filter((floater) => floater.kind === "call");
    const shownCalls = calls.slice(-CALL_CAP);
    const more: Floater[] = calls.length > CALL_CAP ? [{ kind: "more", key: "more-calls", count: calls.length - CALL_CAP, settled: false }] : [];
    return [...speech, ...more, ...shownCalls, ...live.filter((floater) => floater.kind === "delegation")];
  }, [live, overflow]);

  /* The lane's stack: fit, rise and leave. Measured after each commit and
     played back as transforms, so nothing animates layout. */
  const positions = useRef(new Map<string, { top: number; height: number; width: number; left: number }>());
  const contents = useRef(new Map<string, Floater>());
  const [leaving, setLeaving] = useState<ReadonlyArray<{ floater: Floater; top: number; left: number; width: number }>>([]);
  const lastEntry = useRef(0);
  const floaterKeys = floaters.map((floater) => `${floater.key}:${floater.kind === "speech" ? floater.text.length : floater.kind === "call" ? floater.call.status : floater.kind === "delegation" ? floater.delegation.stage : floater.count}`).join("|");
  useLayoutEffect(() => {
    const stack = stackEl.current;
    if (!stack || !shownLane) { positions.current.clear(); return; }
    const nodes = [...stack.querySelectorAll<HTMLElement>(":scope > [data-floater]")];
    /* Fit: the stack keeps to the lane, less the room a leaving bubble drifts into. */
    const room = shownLane.rect.height - EXIT_ROOM;
    const total = nodes.reduce((sum, node) => sum + node.offsetHeight, 0) + Math.max(0, nodes.length - 1) * 8;
    if (total > room) {
      let excess = total - room;
      const drop = new Set(overflow);
      for (const node of nodes) {
        if (excess <= 0 || !node.dataset.floater!.includes("#")) continue;
        drop.add(node.dataset.floater!);
        excess -= node.offsetHeight + 8;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a measured fit, settled before paint
      if (drop.size !== overflow.size) { setOverflow(drop); return; }
    }
    const motion = !reducedMotion() && typeof stack.animate === "function";
    const before = positions.current;
    const after = new Map<string, { top: number; height: number; width: number; left: number }>();
    let entered = 0;
    let rose = false;
    for (const node of nodes) {
      const key = node.dataset.floater!;
      const place = { top: node.offsetTop, height: node.offsetHeight, width: node.offsetWidth, left: node.offsetLeft };
      after.set(key, place);
      const was = before.get(key);
      if (!motion) continue;
      if (!was) {
        /* It grows out of the corner nearest the character, so it never crosses the lane's edge. */
        node.animate([{ transform: "scale(0.9)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: ENTER_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        entered += 1;
        mark(node.dataset.kind === "speech" ? "vc:bubble-in" : "vc:call-in", ENTER_MS);
      } else {
        /* The stack is anchored at the character's end: a rising lane at the bottom, a falling one at the top.
           An element is moved by that edge, so one that grows or shrinks never crosses the lane's edge. */
        const shift = shownLane.direction === "up" ? was.top + was.height - (place.top + place.height) : was.top - place.top;
        if (shift === 0) continue;
        /* A rise already in flight continues from where it is. */
        const flying = new DOMMatrixReadOnly(getComputedStyle(node).transform).m42;
        for (const running of node.getAnimations()) if ((running as Animation & { id: string }).id === "rise") running.cancel();
        const animation = node.animate([{ transform: `translate3d(0, ${shift + flying}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration: RISE_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", composite: "replace" });
        animation.id = "rise";
        rose = true;
      }
    }
    if (rose) mark("vc:rise", RISE_MS);
    /* Several arriving at once, or close behind each other. */
    const stamp = performance.now();
    if (entered > 1 || (entered === 1 && stamp - lastEntry.current < 400)) mark("vc:together", Math.max(ENTER_MS, RISE_MS));
    if (entered) lastEntry.current = stamp;
    /* What left: it drifts away from the character and fades where it was. */
    const gone = [...before.keys()].filter((key) => !after.has(key) && contents.current.has(key));
    if (gone.length && motion) {
      setLeaving((current) => [...current.filter((item) => !gone.includes(item.floater.key)), ...gone.map((key) => ({ floater: contents.current.get(key)!, ...before.get(key)! }))]);
      mark("vc:bubble-out", EXIT_MS);
    }
    positions.current = after;
    for (const floater of floaters) contents.current.set(floater.key, floater);
    for (const key of contents.current.keys()) if (!after.has(key) && !gone.includes(key)) contents.current.delete(key);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per change of what the lane shows
  }, [floaterKeys, shownLane?.direction, shownLane?.side, shownLane?.rect.height, expanded]);
  /* Overflow keys that no longer exist are forgotten. */
  useEffect(() => {
    const keys = new Set(live.map((floater) => floater.key));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pruning a measured set
    setOverflow((current) => { const next = new Set([...current].filter((key) => keys.has(key))); return next.size === current.size ? current : next; });
  }, [live]);
  const leavingKeys = leaving.map((item) => item.floater.key).join("|");
  useEffect(() => {
    if (!leaving.length) return;
    const timer = setTimeout(() => setLeaving([]), EXIT_MS + 40);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per departure
  }, [leavingKeys]);
  const leavingRef = useCallback((node: HTMLElement | null) => {
    if (!node || reducedMotion() || typeof node.animate !== "function" || node.dataset.leaving === "played") return;
    node.dataset.leaving = "played";
    const away = node.closest<HTMLElement>("[data-direction]")?.dataset.direction === "down" ? 16 : -16;
    node.animate([{ transform: "translate3d(0, 0, 0)", opacity: 1 }, { transform: `translate3d(0, ${away}px, 0)`, opacity: 0 }], { duration: EXIT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
  }, []);

  /* The hand-off: a pellet leaves for the orchestrator, and comes back with the answer. */
  const stage = state.delegation?.stage ?? null;
  useEffect(() => {
    const dot = pellet.current;
    const distance = (rail.current?.offsetWidth ?? 0) - 10;
    if (!dot || distance <= 0 || reducedMotion() || typeof dot.animate !== "function") return;
    if (stage === "sending") {
      dot.animate([{ transform: "translate3d(0, 0, 0)" }, { transform: `translate3d(${distance}px, 0, 0)` }], { duration: 900, easing: "cubic-bezier(0.45, 0, 0.2, 1)" });
      mark("vc:delegation-out", 900);
    } else if (stage === "answered") {
      dot.animate([{ transform: `translate3d(${distance}px, 0, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration: 700, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      mark("vc:delegation-in", 700);
    }
  }, [stage]);

  /* Dragging: the character follows the pointer by transform, its lane flipping
     as it nears an edge; where it is dropped is only a request, and the
     placement rule answers it. */
  const drag = useRef<{ id: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; at: Point } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !layout) return;
    /* Captured at once: a fast flick leaves the character before its first move arrives. */
    event.currentTarget.setPointerCapture?.(event.pointerId);
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
      setDragging(true);
    }
    const size = expanded ? block : shape;
    held.at = clampToViewport({ x: held.originX + dx, y: held.originY + dy }, viewportSize(), size, 0);
    setHeld({ at: held.at, lane: layout?.mode === "expanded" ? laneLayout(viewportSize(), { ...held.at, ...block }, layout.laneHeight) : null });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) return;
    drag.current = null;
    if (!held.moved) return;
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 0);
    const size = expanded ? block : shape;
    anchor.current = { x: held.at.x + size.width, y: held.at.y + size.height };
    setLayout(layout?.mode === "expanded" ? { ...layout, at: held.at } : { mode: "collapsed", at: held.at, yielded: false });
    setDragging(false);
    setHeld(null);
    settle(collapsed);
  };
  const onKeyMove = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const move = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key];
    if (!move && event.key !== "Home") return;
    event.preventDefault();
    const size = expanded ? block : shape;
    if (event.key === "Home") anchor.current = null;
    else {
      const box = root.current!.getBoundingClientRect();
      const at = clampToViewport({ x: box.left + move![0], y: box.top + move![1] }, viewportSize(), size);
      anchor.current = { x: at.x + size.width, y: at.y + size.height };
    }
    settle(collapsed);
  };

  const toggle = (next: boolean) => {
    if (swallowClick.current) return;
    if (layout) {
      const size = layout.mode === "expanded" ? block : shape;
      anchor.current = { x: layout.at.x + size.width, y: layout.at.y + size.height };
    }
    setCollapsed(next);
    /* Reopening a companion that collapsed for want of room asks for room again. */
    if (!next && !collapsed) settle(false);
  };
  const talk = () => { void adapter.start({ locale: sessionLocale ?? (locale === "uk" ? "uk" : "en"), project }); };
  const end = () => { void adapter.close(); };
  const toggleMute = () => { const next = !muted; setMuted(next); void adapter.command({ type: "mute", muted: next }); };
  const decide = (decision: "send" | "cancel") => {
    const proposal = state.delegation?.proposal;
    if (!proposal || decidedFor === proposal.proposalId) return;
    setDecidedFor(proposal.proposalId);
    void adapter.command({ type: "confirmation", proposalId: proposal.proposalId, decision, via: "tap" });
  };

  const connected = state.phase !== "offline";
  const phaseLabel = t(`voiceCompanion.phase.${state.phase}`);
  const attention = stage === "awaiting-confirmation" || stage === "answered";
  const seconds = (value: number) => new Intl.NumberFormat(locale === "uk" ? "uk" : "en", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 1000);

  const renderFloater = (floater: Floater) => {
    if (floater.kind === "speech") {
      return (
        <p className="vc-bubble" aria-hidden data-speaker={floater.speaker} data-newest={floater.newest ? "" : undefined} data-cut={floater.cut !== null ? "" : undefined} data-companion-bubble>
          {floater.speaker === "operator" ? <span className="vc-who">{t("voiceCompanion.you")}</span> : null}
          <span className="vc-text">{floater.text}</span>
          {floater.cut !== null ? <span className="vc-cut" data-companion-cut>{t("voiceCompanion.cutAfter", { s: seconds(floater.cut) })}</span> : null}
        </p>
      );
    }
    if (floater.kind === "more") return <div className="vc-call vc-more" data-companion-more>{t("voiceCompanion.moreCalls", { n: floater.count })}</div>;
    if (floater.kind === "call") {
      const { call } = floater;
      return (
        <div className="vc-call" data-status={call.status} data-companion-call>
          <span className="vc-call-icon" aria-hidden>{call.status === "running" ? <LoaderCircle size={14} className="vc-spin" /> : call.status === "done" ? <Check size={14} /> : <X size={14} />}</span>
          <span className="vc-call-body">
            <span className="vc-call-name">{call.name}</span>
            <span className="vc-call-line">{call.status === "running" ? call.summary : call.result ?? call.summary}</span>
          </span>
          <span className="vc-call-state">{t(`voiceCompanion.call.${call.status}`)}</span>
        </div>
      );
    }
    const { delegation } = floater;
    const recipient = delegation.proposal?.recipient ?? delegation.delivery?.recipient ?? null;
    const target = recipient?.project ?? project;
    const head = delegation.stage === "awaiting-confirmation" ? t("voiceCompanion.proposal", { project: target }) : t(`voiceCompanion.stage.${delegation.stage}`);
    const running = delegation.stage === "proposed" || delegation.stage === "sending";
    const failed = delegation.stage === "refused" || delegation.stage === "failed" || delegation.stage === "unknown";
    return (
      <div className="vc-call vc-deleg" data-stage={delegation.stage} data-companion-delegation>
        <div className="vc-deleg-head">
          <span className="vc-call-icon" aria-hidden>{running ? <LoaderCircle size={14} className="vc-spin" /> : failed ? <CircleAlert size={14} /> : delegation.stage === "cancelled" ? <X size={14} /> : delegation.stage === "awaiting-confirmation" ? <SendHorizontal size={14} /> : <Check size={14} />}</span>
          <span className="vc-deleg-title">{head}</span>
          {recipient ? <span className="vc-deleg-engine"><EngineMark engine={recipient.engine} size={14} />{ENGINE_NAME[recipient.engine]}</span> : null}
        </div>
        <span className="vc-call-name">request_orchestrator_delegation</span>
        {delegation.stage === "refused" ? <p className="vc-deleg-note">{t("voiceCompanion.refused")}</p> : null}
        {delegation.stage === "cancelled" && delegation.refusal ? <p className="vc-deleg-note" data-companion-withdrawn>{t("voiceCompanion.withdrawn")}</p> : null}
        {delegation.stage === "awaiting-confirmation" || delegation.stage === "sending" || delegation.stage === "queued" || delegation.stage === "delivered" || delegation.stage === "unknown" ? (
          <p className="vc-instruction" tabIndex={0} data-companion-instruction>{delegation.instruction}</p>
        ) : null}
        {delegation.stage === "awaiting-confirmation" ? (
          <div className="vc-acts">
            <button type="button" className="vc-act" data-companion-cancel disabled={decidedFor === delegation.proposal?.proposalId} onClick={() => decide("cancel")}><X size={14} aria-hidden />{t("voiceCompanion.cancel")}</button>
            <button type="button" className="vc-act" data-primary data-companion-send disabled={decidedFor === delegation.proposal?.proposalId} onClick={() => decide("send")}><SendHorizontal size={14} aria-hidden />{t("voiceCompanion.send")}</button>
          </div>
        ) : null}
        {delegation.stage === "sending" || delegation.stage === "queued" || delegation.stage === "delivered" || delegation.stage === "answered" ? (
          <div className="vc-track" aria-hidden data-companion-track>
            <span className="vc-end"><CompanionMini /></span>
            <span className="vc-rail" ref={rail}><span className="vc-pellet" ref={pellet} /></span>
            <span className="vc-end" data-done={delegation.stage !== "sending" ? "" : undefined}>{recipient ? <EngineMark engine={recipient.engine} size={14} /> : null}</span>
          </div>
        ) : null}
        {delegation.answer ? <p className="vc-answer" tabIndex={0} data-companion-answer><span className="vc-who">{t("voiceCompanion.orchestrator")}</span>{delegation.answer.text}</p> : null}
      </div>
    );
  };

  const at = heldView?.at ?? layout?.at ?? { x: -9999, y: -9999 };
  const size = expanded ? block : shape;
  const style = { width: size.width, height: size.height, transform: `translate3d(${at.x}px, ${at.y}px, 0)`, visibility: layout ? undefined : ("hidden" as const) };
  const transcriptLine = (line: SpeechLine) => {
    const who = line.speaker === "operator" ? t("voiceCompanion.you") : "Delegatus";
    const cut = line.playback === "cut" ? ` (${t("voiceCompanion.cutAfter", { s: seconds(line.playedMs ?? 0) })})` : "";
    return `${who}${cut}: ${line.text}`;
  };

  return (
    <section
      ref={root}
      className="vc"
      role="complementary"
      aria-label="Delegatus"
      data-voice-companion
      data-variant={variant}
      data-layout={layout?.mode ?? "expanded"}
      data-yielded={layout?.mode === "collapsed" && layout.yielded ? "" : undefined}
      data-phase={state.phase}
      data-collapsed={!expanded ? "" : undefined}
      data-delegation-stage={stage ?? undefined}
      data-dragging={dragging ? "" : undefined}
      style={style}
    >
      <style>{VOICE_COMPANION_CSS}</style>
      {expanded && shownLane ? (
        <div
          className="vc-lane"
          data-companion-lane
          data-side={shownLane.side}
          data-direction={shownLane.direction}
          style={{ left: shownLane.rect.x - at.x, top: shownLane.rect.y - at.y, width: shownLane.rect.width, height: shownLane.rect.height }}
        >
          <div className="vc-stack" ref={stackEl}>
            {floaters.map((floater) => (
              <div key={floater.key} className="vc-floater" data-floater={floater.key} data-kind={floater.kind} data-speaker={floater.kind === "speech" ? floater.speaker : undefined}>{renderFloater(floater)}</div>
            ))}
            {leaving.map(({ floater, top, left, width }) => (
              <div key={`leaving:${floater.key}`} ref={leavingRef} className="vc-floater" aria-hidden inert data-leaving data-kind={floater.kind} data-speaker={floater.kind === "speech" ? floater.speaker : undefined} style={{ position: "absolute", top, left, width }}>{renderFloater(floater)}</div>
            ))}
          </div>
        </div>
      ) : null}
      {expanded ? (
        <div className="vc-block">
          <button
            type="button"
            className="vc-figure"
            data-grip
            aria-label={`${t("voiceCompanion.move")} · ${phaseLabel}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyMove}
          >
            <CompanionCharacter ref={character} size={CHARACTER[variant]} />
            {showVariantNumber ? <span className="vc-badge" data-companion-variant-number aria-label={t("voiceCompanion.variant", { n: variant })}>{variant}</span> : null}
          </button>
          <span className="vc-state" data-companion-phase aria-hidden><span className="vc-phase"><span className="vc-dot" />{phaseLabel}</span>{state.mode === "simulated" || !connected ? <span className="vc-sim">{t("voiceCompanion.simulated")}</span> : null}</span>
          <div className="vc-controls">
            {connected ? (
              <>
                <button type="button" className="vc-btn" data-on={muted ? "" : undefined} aria-pressed={muted} aria-label={t(muted ? "voiceCompanion.unmute" : "voiceCompanion.mute")} title={t(muted ? "voiceCompanion.unmute" : "voiceCompanion.mute")} onClick={toggleMute}>
                  {muted ? <MicOff size={15} aria-hidden /> : <Mic size={15} aria-hidden />}
                </button>
                <button type="button" className="vc-btn" data-companion-end aria-label={t("voiceCompanion.end")} title={t("voiceCompanion.end")} onClick={end}><PhoneOff size={15} aria-hidden /></button>
              </>
            ) : (
              <button type="button" className="vc-talk" data-companion-talk onClick={talk}><Mic size={13} aria-hidden />{t("voiceCompanion.talk")}</button>
            )}
            <button type="button" className="vc-btn" data-companion-collapse aria-label={t("voiceCompanion.collapse")} title={t("voiceCompanion.collapse")} aria-expanded onClick={() => toggle(true)}><Minimize2 size={15} aria-hidden /></button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="vc-shape"
          data-companion-expand
          aria-label={`${t("voiceCompanion.expand")} · ${phaseLabel}`}
          aria-expanded={false}
          onClick={() => toggle(false)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyMove}
        >
          <CompanionCharacter ref={character} size={SHAPE_CHARACTER[variant]} />
          {variant === 2 ? <span className="vc-shape-label"><span className="vc-dot" />{phaseLabel}</span> : null}
          {attention ? <span className="vc-flag" data-companion-flag aria-hidden /> : null}
          {showVariantNumber ? <span className="vc-badge" data-companion-variant-number aria-label={t("voiceCompanion.variant", { n: variant })}>{variant}</span> : null}
        </button>
      )}
      {/* The whole conversation, for a screen reader and for anyone who missed a bubble. */}
      <ol className="vc-sr" aria-live="polite" aria-label={t("voiceCompanion.transcript")} data-companion-transcript>
        {state.lines.filter((line) => line.final || line.playback === "cut").map((line) => <li key={line.key}>{transcriptLine(line)}</li>)}
        {state.delegation?.answer ? <li>{t("voiceCompanion.orchestrator")}: {state.delegation.answer.text}</li> : null}
      </ol>
      {/* The proposal is a decision the operator must be able to reach without the lane being on screen. */}
      {!expanded && stage === "awaiting-confirmation" ? <span className="vc-sr" role="status">{t("voiceCompanion.proposal", { project: state.delegation?.proposal?.recipient.project ?? project })}</span> : null}
    </section>
  );
}

function CompanionMini() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/delegatus-mark.svg" alt="" aria-hidden width={14} height={14} draggable={false} />
  );
}

export const COMPANION_GEOMETRY = { BLOCK, SHAPE, BUBBLE_MAX_WIDTH } as const;
