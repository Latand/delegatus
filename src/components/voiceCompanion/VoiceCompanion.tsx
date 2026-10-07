"use client";

import { Check, CircleAlert, LoaderCircle, Mic, MicOff, Minimize2, PhoneOff, SendHorizontal, Settings, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { EngineMark } from "@/components/EngineMark";
import { useLocale } from "@/lib/i18n";
import { createCompanionStore } from "@/hooks/useVoiceCompanion";
import type { Locale, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { companionErrorMessage } from "@/lib/voiceCompanion/errors";
import {
  BUBBLE_MAX_CHARS, BUBBLE_MAX_WIDTH, clampToViewport, CONTROL_SELECTOR, isFree, isPassiveCursor, laneLayout, placeCollapsed, placeExpanded, splitSpeech,
  type LaneLayout, type Point, type Rect, type Size,
} from "@/lib/voiceCompanion/placement";
import { bezierSlope, cssBezier, riseCurve, RISE_MS, type Bezier } from "@/lib/voiceCompanion/motion";
import type { DelegationView, SpeechLine, ToolCallView } from "@/lib/voiceCompanion/reducer";

import { CompanionCharacter, type CharacterHandle } from "./CompanionCharacter";
import { VOICE_COMPANION_CSS } from "./voiceCompanionStyles";

/**
 * The floating voice companion (#2519, docs/design/voice-companion-research.md §9, §10).
 * The desktop shell mounts it through `VoiceCompanionHost` when the operator
 * turned it on; the evidence fixture mounts it over the simulator. It reads one
 * adapter through one reducer and knows nothing about where the events come from.
 * It has one look: the character in a lit halo whose ring takes the state's
 * colour, glass speech bubbles, call cards with an icon tile, the delegation as
 * a rounded teal card, and a small rounded tile when collapsed.
 *
 * The character is the floating object, with no frame around it. What it says
 * appears as separate speech bubbles beside it that rise, older ones drifting
 * away and fading; tool calls and the delegation appear as their own elements
 * in the same lane. The lane is one chronology: whatever arrived last, a
 * bubble or a call, stands next to the character, and the lane moves only away
 * from it, as one sheet: a new element comes out at the character's end while
 * everything older travels the same distance on the same curve. An element
 * leaves from the far end, so nothing ever slides back toward the character.
 * The lane is reserved with the character, so placing the character decides
 * what the bubbles may cover: nothing that takes a click. Outside a bubble, an
 * element and the character, every click reaches the page underneath.
 *
 * Where it stands is a function of the page and of the corner asked for, so
 * one page gives one place. Until the operator moves it, the character keeps
 * off the page's text as well as its controls; while a conversation is in the
 * lane it holds its place unless a control comes under it. In a conversation's
 * feed, which the host names, it keeps off the whole track of each row control,
 * so the rows that arrive while it talks bring none beneath it, and off the room
 * the host says a control of its own will take. It collapses to a
 * small shape, which also keeps off the page's text, and has no way to be
 * dismissed.
 */

/* The character with its state and its controls under it, and the collapsed tile. */
const BLOCK: Size = { width: 132, height: 148 };
const CHARACTER = 68;
const SHAPE: Size = { width: 56, height: 56 };
const SHAPE_CHARACTER = 40;
/** The most speech bubbles shown at once; a newer one sends the oldest away, with everything older than it. */
export const SPEECH_CAP = 4;
/** The most call elements shown at once; the calls still at work beyond them are counted on one more element. */
export const CALL_CAP = 4;
/** A speech bubble leaves this long after its line finished. */
export const SPEECH_LINGER_MS = 9_000;
/** A finished call leaves this long after its result. */
export const CALL_LINGER_MS = 5_000;
/** A settled delegation (answered, refused, cancelled, failed) leaves this long after it settled. */
export const DELEGATION_LINGER_MS = 14_000;
/** A failure said in plain words leaves this long after it appeared. */
export const NOTICE_LINGER_MS = 12_000;
/** The delegation's tools: the request and the operator's spoken answer to a confirmation. Their lifecycle is the delegation card, so they get no call card of their own. */
const DELEGATION_TOOL = "request_orchestrator_delegation";
const DELEGATION_TOOLS = new Set([DELEGATION_TOOL, "resolve_orchestrator_confirmation"]);
/** Why a confirmation that waited ended with nothing sent, where the card can say more than "taken back". */
const UNSENT_NOTE: Record<string, "voiceCompanion.declined" | "voiceCompanion.unanswered"> = {
  operator_cancelled: "voiceCompanion.declined", confirmation_expired: "voiceCompanion.unanswered", session_closed: "voiceCompanion.unanswered",
};
/** The registry's tools, for the line a call card shows when the backend summarised a call by its bare name. */
const TOOL_LINE = {
  list_tasks: "voiceCompanion.tool.list_tasks", get_task: "voiceCompanion.tool.get_task", list_pipelines: "voiceCompanion.tool.list_pipelines",
  get_pipeline: "voiceCompanion.tool.get_pipeline", agent_activity: "voiceCompanion.tool.agent_activity",
  conversation_messages: "voiceCompanion.tool.conversation_messages", end_conversation: "voiceCompanion.tool.end_conversation",
} as const;
/** Failures whose remedy is in the settings. */
const SETTINGS_FAILURES = new Set(["NO_KEY", "CAP_REACHED", "KEY_FROM_ENV"]);
/** The nominal speaking rate the bubbles of a playing line are paced by. A
    presentation pace only: no word is claimed to have been heard by it. */
export const NOMINAL_MS_PER_CHAR = 58;
/* Room kept at the far end of the lane for a bubble that is leaving. */
const EXIT_ROOM = 18;
/* Room kept at the character's end of the lane, between the newest element and the edge it came out from. */
const END_ROOM = 8;
const DRAG_THRESHOLD = 6;
/* The longest the first appearance waits for the host's late surfaces. */
const SHELL_WAIT_MS = 3_000;
/* An element that comes out at the character's end reaches full opacity over this part of the rise. */
const ENTER_SHOWN = 0.5;
/* An element that appears away from the character's end (the count of unseen calls) fades in where it is. */
const FADE_IN_MS = 200;
const EXIT_MS = 420;
const QUICK_EXIT_MS = 140;
/* A move the companion makes by itself with elements in its lane: the lane fades where it stands over the
   first span, the character travels with no lane over the second (its own transition is 260 ms), and the lane
   shows again at the new place. */
const LANE_OUT_MS = 140;
const TRAVEL_MS = 280;

const ENGINE_NAME = { claude: "Claude", codex: "Codex" } as const;

/** The part of a box a pointer can reach: cut to the viewport and to every clipping element from `within` up. */
function reachable(within: Element | null, box: { left: number; top: number; right: number; bottom: number }, clips: Map<Element, DOMRect | null>): Rect | null {
  let left = Math.max(box.left, 0);
  let top = Math.max(box.top, 0);
  let right = Math.min(box.right, innerWidth);
  let bottom = Math.min(box.bottom, innerHeight);
  for (let parent = within; parent && right - left >= 1 && bottom - top >= 1; parent = parent.parentElement) {
    if (!clips.has(parent)) {
      const style = getComputedStyle(parent);
      clips.set(parent, style.overflowX !== "visible" || style.overflowY !== "visible" ? parent.getBoundingClientRect() : null);
    }
    const clip = clips.get(parent);
    if (!clip) continue;
    left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
  }
  return right - left < 1 || bottom - top < 1 ? null : { x: left, y: top, width: right - left, height: bottom - top };
}

/** Every visible control on the page outside the companion, as viewport rectangles:
    what the selector names, and whatever shows a cursor of its own (a resize
    handle, a surface that drags), which no selector can list. A control inside a
    surface that fills with rows (`rows`: a conversation's feed) may come to stand
    anywhere along that surface as rows arrive and as it scrolls, so its whole
    track, the control's width over the surface's height, counts as well. */
function controlRects(self: Element | null, extra: string | undefined, rows: string | undefined): Rect[] {
  const rects: Rect[] = [];
  const clips = new Map<Element, DOMRect | null>();
  const surfaces = rows ? [...document.querySelectorAll<HTMLElement>(rows)].filter((surface) => !self?.contains(surface)) : [];
  const views = new Map<HTMLElement, Rect | null>();
  const tracks = new Set<string>();
  const nodes = new Set<HTMLElement>(document.querySelectorAll<HTMLElement>(extra ? `${CONTROL_SELECTOR},${extra}` : CONTROL_SELECTOR));
  /* The cursor is inherited, so the outermost element that sets one stands for all it contains. */
  const walk = (parent: Element, inherited: boolean) => {
    for (const child of parent.children) {
      if (child === self || !(child instanceof HTMLElement)) continue;
      const active = !isPassiveCursor(getComputedStyle(child).cursor);
      if (active && !inherited) nodes.add(child);
      walk(child, active);
    }
  };
  walk(document.body, !isPassiveCursor(getComputedStyle(document.body).cursor));
  for (const node of nodes) {
    if (self?.contains(node)) continue;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") continue;
    const box = node.getBoundingClientRect();
    const surface = surfaces.find((candidate) => candidate !== node && candidate.contains(node));
    if (surface && box.width >= 1 && box.height >= 1) {
      if (!views.has(surface)) views.set(surface, reachable(surface.parentElement, surface.getBoundingClientRect(), clips));
      const view = views.get(surface);
      const left = view ? Math.max(box.left, view.x) : 0;
      const right = view ? Math.min(box.right, view.x + view.width) : 0;
      const key = `${surfaces.indexOf(surface)}:${Math.round(left)}:${Math.round(right)}`;
      if (view && right - left >= 1 && !tracks.has(key)) { tracks.add(key); rects.push({ x: left, y: view.y, width: right - left, height: view.height }); }
    }
    const rect = reachable(node.parentElement, box, clips);
    if (rect) rects.push(rect);
  }
  return rects;
}

/** The element that draws `element`'s text: itself, or for one with `display: contents`, which has no
    box of its own and which `checkVisibility` therefore calls hidden, the nearest ancestor that has one.
    A conversation's messages sit in such wrappers, so reading their own visibility would miss every line. */
function boxOf(element: Element): Element {
  let at = element;
  while (at.parentElement && getComputedStyle(at).display === "contents") at = at.parentElement;
  return at;
}

/** Every line of visible text on the page outside the companion. Neither the
    character, its lane nor the collapsed shape is placed over one by itself. */
function textRects(self: Element | null): Rect[] {
  const rects: Rect[] = [];
  const clips = new Map<Element, DOMRect | null>();
  const shown = new Map<Element, boolean>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue?.trim() || self?.contains(parent)) continue;
    if (!shown.has(parent)) shown.set(parent, parent.tagName !== "STYLE" && parent.tagName !== "SCRIPT" && (boxOf(parent).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true));
    if (!shown.get(parent)) continue;
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      /* The parent's own box clips its text too (an ellipsis, a one-pixel screen-reader label). */
      const rect = reachable(parent, line, clips);
      if (rect) rects.push(rect);
    }
  }
  return rects;
}

/** The pictures in each surface that fills with rows (a row's avatar, the icon beside its author): a row's
    content as much as its text, though they hold none. Every row begins at its avatar, so a place over the
    feed's avatars stands where the next row's will be. Kept off as the page's text is. */
function rowGraphics(self: Element | null, rows: string | undefined): Rect[] {
  if (!rows) return [];
  const clips = new Map<Element, DOMRect | null>();
  return [...document.querySelectorAll<HTMLElement>(rows)].filter((surface) => !self?.contains(surface))
    .flatMap((surface) => [...surface.querySelectorAll<Element>("img, svg, canvas, video, [role='img']")])
    .filter((node) => !node.parentElement?.closest("svg") && (node.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true))
    .flatMap((node) => reachable(node.parentElement, node.getBoundingClientRect(), clips) ?? []);
}

/** The surfaces that fill with rows (a conversation's feed), as the part of each a reader can see. */
function rowSurfaces(self: Element | null, rows: string | undefined): Rect[] {
  if (!rows) return [];
  const clips = new Map<Element, DOMRect | null>();
  return [...document.querySelectorAll<HTMLElement>(rows)].filter((surface) => !self?.contains(surface))
    .flatMap((surface) => reachable(surface.parentElement, surface.getBoundingClientRect(), clips) ?? []);
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const mark = (name: string, durationMs: number) => { try { performance.mark(name, { detail: { durationMs } }); } catch { /* measurement only */ } };
const viewportSize = (): Size => ({ width: innerWidth, height: innerHeight });

type Layout =
  | { mode: "expanded"; at: Point; lane: LaneLayout }
  /* `yielded`: the companion was open but no free place held its lane. */
  | { mode: "collapsed"; at: Point; yielded: boolean };

/** One thing in the lane: a bubble of speech, a tool call, the delegation, the
    orchestrator's answer to it, or the count of calls at work that are not shown. */
type Floater =
  | { kind: "speech"; key: string; speaker: SpeechLine["speaker"]; text: string; cut: number | null; settled: boolean }
  | { kind: "call"; key: string; call: ToolCallView; settled: boolean }
  | { kind: "delegation"; key: string; delegation: DelegationView; settled: boolean }
  | { kind: "answer"; key: string; delegation: DelegationView; settled: true }
  /* A failure, or a fact the operator needs before asking (no orchestrator here), in plain words. */
  | { kind: "notice"; key: string; code: string; tone: "failure" | "note"; settled: true }
  | { kind: "more"; key: string; count: number; settled: false };

const LINGER_MS: Record<Exclude<Floater["kind"], "more">, number> = { speech: SPEECH_LINGER_MS, call: CALL_LINGER_MS, delegation: DELEGATION_LINGER_MS, answer: DELEGATION_LINGER_MS, notice: NOTICE_LINGER_MS };
/* `far`: how far the element's far edge stands from the lane's end at the character. */
type Place = { top: number; height: number; width: number; left: number; far: number; arrival: number | null };

/** A line's bubbles. While the line still streams, its last bubble holds only the words no later cut
    can take from it, so a bubble never gives a word back and never keeps a line it emptied. */
function bubblesOf(line: SpeechLine): string[] {
  const streams = !line.final && line.playback !== "cut" && line.playback !== "played";
  return splitSpeech(line.text, BUBBLE_MAX_CHARS, streams);
}

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

/** A leaving element the stack is rising into: it drops under half opacity in that frame and is gone
    in 140 ms, so it is never read through the element that takes its place. */
function fadeAtOnce(node: HTMLElement) {
  const from = Math.min(Number(getComputedStyle(node).opacity), 0.4);
  const at = getComputedStyle(node).transform;
  const away = node.closest<HTMLElement>("[data-direction]")?.dataset.direction === "down" ? 16 : -16;
  for (const running of node.getAnimations()) running.cancel();
  node.animate([{ transform: at === "none" ? "translate3d(0, 0, 0)" : at, opacity: from }, { transform: `translate3d(0, ${away}px, 0)`, opacity: 0 }], { duration: QUICK_EXIT_MS, easing: "linear", fill: "forwards" });
}

/** How much of an element its own clip still hides at its edge nearest the character. */
function hiddenByClip(node: HTMLElement, up: boolean): number {
  const inset = /^inset\(([^)]*)\)/u.exec(getComputedStyle(node).clipPath);
  if (!inset) return 0;
  const sides = inset[1]!.split(/\s+/u).map(Number.parseFloat);
  return Math.max(0, (up ? sides[2] ?? sides[0] : sides[0]) || 0);
}

/** Starts an animation at the frame being drawn. Left pending, it holds its first keyframe for a frame or
    two, and a rise that takes over one in flight would stand still for that long before it moved on. */
function startNow(animation: Animation) {
  const now = document.timeline?.currentTime;
  if (now !== null && now !== undefined) animation.startTime = now;
}

/** A bubble's text with its last two words kept on one line, so the wrap never leaves one word alone at the end. */
const tied = (text: string) => (text.trim().split(/\s+/u).length > 2 ? text.replace(/\s+(\S+)$/u, "\u00a0$1") : text);

const DELEGATION_SETTLED = new Set(["answered", "refused", "cancelled", "failed"]);
const speechLocaleOf = (locale: string): Locale => (locale === "uk" ? "uk" : "en");

export function VoiceCompanion({ adapter, project, locale: sessionLocale, seat, preflight, onOpenSettings, protect, rows, reserve, ready, defaultCollapsed = false }: {
  adapter: VoiceCompanionAdapter;
  /** The project in view; null on a view that shows none, where a conversation cannot start. */
  project: string | null;
  /** The language the session is started in; defaults to the interface language. */
  locale?: Locale;
  /** Whether the project has a designated orchestrator. `false` is said when a conversation starts;
      unknown (undefined) says nothing, and the server refuses a proposal either way. */
  seat?: boolean;
  /** Read when the operator asks to talk: a failure code that is already known (no key, the cap reached)
      is said without opening the microphone. */
  preflight?: () => string | null;
  /** Opens the settings surface; offered beside a failure whose remedy is there. */
  onOpenSettings?: () => void;
  /** Extra selector for surfaces the host treats as controls (a draggable card). */
  protect?: string;
  /** Selector for surfaces that fill with rows carrying their own controls (a conversation's feed).
      The companion keeps off the whole track of every control in one, so a row that arrives under
      it, or a scroll, brings no control beneath it and it has no reason to move. */
  rows?: string;
  /** Room the host keeps for controls of its own that are not on the page yet (the strip a feed
      shows under itself while the reader is away from its end), as viewport rectangles. Read with
      the page; the function itself must stay the same between renders. */
  reserve?: () => Rect[];
  /** Whether the host's surfaces that arrive late (a panel whose figures come from its first poll) are on the
      page. The companion makes its first appearance once they are, or 3 s after it mounted, so it appears
      where it will stay and is not moved by them a moment later. */
  ready?: () => boolean;
  defaultCollapsed?: boolean;
}) {
  const { t, locale } = useLocale();
  const [store] = useState(() => createCompanionStore(adapter));
  useEffect(() => store.connect(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  /* Between the tap on Talk and the session being ready (the microphone prompt, the mint): the end control is already there. */
  const [starting, setStarting] = useState(false);
  /* A failure known before any session exists, with a count so the same one can be said again. */
  const [refusedStart, setRefusedStart] = useState<{ code: string; n: number } | null>(null);
  /* Each conversation's notices are its own: one that left the lane may be said again in the next. */
  const [talks, setTalks] = useState(0);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [layout, setLayout] = useState<Layout | null>(null);
  /* The layout on screen: `layout` itself, except while the companion moves itself with elements in its lane.
     Then the lane empties where it stands before the character sets off, and shows again once it has arrived,
     so nothing in it is carried across the page or swings to another side on the way. */
  const [view, setView] = useState<Layout | null>(null);
  const [relocating, setRelocating] = useState<"out" | "travel" | null>(null);
  /* Set by the operator's own moves (a drop, a key, a resize): those are shown as they happen. */
  const moveAtOnce = useRef(false);
  /* While held: where the character is and the lane it would have there. */
  const [heldView, setHeld] = useState<{ at: Point; lane: LaneLayout | null } | null>(null);
  const [muted, setMuted] = useState(false);
  const [dragging, setDragging] = useState(false);
  /* Each proposal owns its pending tap and delivery error independently. */
  const [decidedFor, setDecidedFor] = useState<ReadonlySet<string>>(() => new Set());
  const deciding = useRef(new Set<string>());
  const [unconfirmedFor, setUnconfirmedFor] = useState<ReadonlySet<string>>(() => new Set());
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
  /* Whether the operator put the character where it is, or opened it where no place free of text was left.
     A place of their choosing may lie over text; one the companion takes by itself never does. */
  const chosen = useRef(false);
  /* What the last placement was computed from: the same page gives the same place without a second search. */
  const settledFor = useRef<string | null>(null);
  const swallowClick = useRef(false);
  /* What the companion keeps off unless the operator put it there: the page's text, and the pictures of the rows
     in a feed. */
  const pageContent = useCallback(() => [...textRects(root.current), ...rowGraphics(root.current, rows)], [rows]);

  const shape = SHAPE;
  const block = BLOCK;
  const [shellReady, setShellReady] = useState(() => !ready || ready());
  useEffect(() => {
    if (shellReady) return;
    const done = () => setShellReady(true);
    const observer = new MutationObserver(() => { if (ready?.() ?? true) done(); });
    observer.observe(document.body, { subtree: true, childList: true });
    const timer = setTimeout(done, SHELL_WAIT_MS);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [shellReady, ready]);

  /** Open at the free place nearest the anchor; with none, collapse there instead.
      The answer depends on the page, the viewport and the anchor alone. `read`: the controls and the text,
      when the caller has just read them from the page. */
  const settle = useCallback((isCollapsed: boolean, read?: { obstacles: Rect[]; text: Rect[] }) => {
    const began = performance.now();
    const viewport = viewportSize();
    const obstacles = read?.obstacles ?? [...controlRects(root.current, protect, rows), ...(reserve?.() ?? [])];
    const text = read?.text ?? pageContent();
    const surfaces = rowSurfaces(root.current, rows);
    const corner = anchor.current ?? { x: viewport.width - 16, y: viewport.height - 16 };
    const inputs = JSON.stringify([viewport, isCollapsed, corner, chosen.current, obstacles, text, surfaces]);
    if (inputs === settledFor.current) return;
    settledFor.current = inputs;
    let next: Layout | null = null;
    const desired = { x: corner.x - shape.width, y: corner.y - shape.height };
    if (!isCollapsed) {
      const open = placeExpanded({ viewport, block, obstacles, text: chosen.current ? [] : text, rows: chosen.current ? [] : surfaces, desired: { x: corner.x - block.width, y: corner.y - block.height } });
      if (open) next = { mode: "expanded", at: open.at, lane: open.lane };
    }
    if (!next) {
      /* The shape keeps off the page's text and out of the feeds as well, wherever such a place exists. */
      const at = placeCollapsed({ viewport, size: shape, obstacles: [...obstacles, ...text, ...surfaces], desired })
        ?? placeCollapsed({ viewport, size: shape, obstacles: [...obstacles, ...text], desired })
        ?? placeCollapsed({ viewport, size: shape, obstacles, desired })
        ?? clampToViewport(desired, viewport, shape);
      next = { mode: "collapsed", at, yielded: !isCollapsed };
    }
    mark("vc:settle", performance.now() - began);
    setLayout((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [block, protect, rows, reserve, shape, pageContent]);

  /* First placement, once the host's late surfaces are on the page, and again whenever the viewport changes. */
  useLayoutEffect(() => {
    if (!shellReady) return;
    settle(collapsed);
    const onResize = () => { moveAtOnce.current = true; settle(collapsed); };
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, [collapsed, settle, shellReady]);

  const expanded = view?.mode === "expanded";
  /* The lane reserved where the character is going, and the one on screen. */
  const lane = layout?.mode === "expanded" ? layout.lane : null;
  const shownLane = heldView ? heldView.lane : view?.mode === "expanded" ? view.lane : null;

  /** The rectangles the companion reserves where it stands: the character, and the lane when open. */
  const footprint = useCallback((): Rect[] => {
    if (!layout) return [];
    if (layout.mode === "collapsed") return [{ ...layout.at, ...shape }];
    return [{ ...layout.at, ...block }, ...(lane ? [lane.rect] : [])];
  }, [layout, lane, block, shape]);

  /* The mouth, and the pace of the playing line's bubbles: one transform per
     level sample, and a render only when another bubble is due. */
  useEffect(() => store.onLevel((current) => {
    character.current?.setLevel(reducedMotion() ? (current.mouth > 0 ? 0.5 : 0) : current.mouth);
    const playing = current.playing && current.lines.find((line) => line.key === `companion:${current.playing!.itemId}`);
    if (!playing) return;
    const out = bubblesOut(playing, bubblesOf(playing), current.playedMs);
    setPaced((shown) => (shown?.key === playing.key && shown.out === out ? shown : { key: playing.key, out }));
  }), [store]);
  const speaking = state.phase === "speaking";
  useEffect(() => { if (!speaking) character.current?.setLevel(0); }, [speaking, collapsed]);

  const awaiting = store.awaiting();
  /* What may be in the lane: speech, the calls, each delegation with the answer to it, and what went wrong. */
  const candidates = useMemo((): Floater[] => {
    const speech: Floater[] = [];
    for (const line of state.lines.filter((entry) => entry.text.trim())) {
      const chunks = bubblesOf(line);
      const out = Math.min(chunks.length, line.playback === "playing" && paced?.key === line.key ? Math.max(1, paced.out) : bubblesOut(line, chunks, 0));
      const done = line.speaker === "operator" ? line.final : line.playback === "played" || line.playback === "cut";
      for (let index = 0; index < out; index += 1) {
        const last = index === out - 1;
        speech.push({
          kind: "speech", key: `${line.key}#${index}`, speaker: line.speaker, text: chunks[index]!,
          cut: line.playback === "cut" && last ? line.playedMs ?? 0 : null, settled: done || !last,
        });
      }
    }
    const calls: Floater[] = state.calls.filter((call) => !DELEGATION_TOOLS.has(call.name)).map((call) => ({ kind: "call", key: `call:${call.callId}`, call, settled: call.status !== "running" }));
    /* Every sent request keeps its own card and its own answer while a newer one is shown. */
    const current = state.delegation;
    const delegations = [...state.deliveryCards.filter((card) => card.callId !== current?.callId), ...(current ? [current] : [])];
    const deleg: Floater[] = [];
    for (const delegation of delegations) {
      /* Delivered work stays in view after the conversation ends; a confirmation nobody answered does not. */
      /* A confirmation the model asked for is answered while the conversation goes on, and the talk that
         follows can send the asking card off the far end. The answer is news, so the decided card arrives
         again beside the character. */
      const decided = delegation.proposal?.confirmation && delegation.stage !== "awaiting-confirmation" ? ":decided" : "";
      if (state.phase !== "offline" || ["queued", "delivered", "answered"].includes(delegation.stage)) deleg.push({ kind: "delegation", key: `delegation:${delegation.callId}${decided}`, delegation, settled: DELEGATION_SETTLED.has(delegation.stage) });
      /* The answer is news of its own: it arrives beside the character, wherever the request has risen to. */
      if (delegation.answer) deleg.push({ kind: "answer", key: `answer:${delegation.callId}:${delegation.answer.reportId}`, delegation, settled: true });
    }
    const notices: Floater[] = [];
    const say = (source: string, code: string, tone: "failure" | "note" = "failure") => notices.push({ kind: "notice", key: `notice:${talks}:${source}:${code}`, code, tone, settled: true });
    if (refusedStart) say(`start${refusedStart.n}`, refusedStart.code);
    /* Until the session asked for is ready, an error the state still holds is the previous conversation's. */
    if (state.error && !awaiting) say("error", state.error);
    if (state.closure?.incomplete && !awaiting && state.error !== "FINALIZATION_INCOMPLETE") say("closure", "FINALIZATION_INCOMPLETE");
    if (seat === false && state.phase !== "offline") say("seat", "no_orchestrator", "note");
    return [...speech, ...calls, ...deleg, ...notices];
  }, [state.lines, state.calls, state.delegation, state.deliveryCards, state.phase, state.error, state.closure, paced, refusedStart, seat, talks, awaiting]);

  /* When each element arrived and when it settled. The lane is ordered by arrival,
     and one not stamped yet is the newest there is. */
  const [arrival, setArrival] = useState<ReadonlyMap<string, number>>(new Map());
  const [settledAt, setSettledAt] = useState<ReadonlyMap<string, number>>(new Map());
  /* What arrived beside a proposal that waits for the operator and found no room: it never comes out, so the
     card with its buttons is never sent off the far end by what was said after it. The transcript keeps it. */
  const [withheld, setWithheld] = useState<ReadonlySet<string>>(new Set());
  const arrivals = useRef(0);
  useEffect(() => {
    const keys = new Set(candidates.map((floater) => floater.key));
    setArrival((current) => {
      const fresh = candidates.filter((floater) => !current.has(floater.key));
      if (!fresh.length && [...current.keys()].every((key) => keys.has(key))) return current;
      const next = new Map([...current].filter(([key]) => keys.has(key)));
      for (const floater of fresh) next.set(floater.key, arrivals.current += 1);
      return next;
    });
    setWithheld((current) => (current.size && [...current].some((key) => !keys.has(key)) ? new Set([...current].filter((key) => keys.has(key))) : current));
    setSettledAt((current) => {
      const next = new Map([...current].filter(([key]) => keys.has(key)));
      const stamp = Date.now();
      for (const floater of candidates) {
        if (floater.settled && !next.has(floater.key)) next.set(floater.key, stamp);
        if (!floater.settled) next.delete(floater.key);
      }
      return next.size === current.size && [...next].every(([key, at]) => current.get(key) === at) ? current : next;
    });
  }, [candidates]);

  /* The lane, oldest first and newest beside the character. It moves one way:
     an element leaves from the far end, when its time is up and nothing older is
     still there, or when the count or the room sends it off, and then everything
     older goes with it. `gate` is the arrival of the newest element that left;
     nothing at or before it comes back. */
  const [gate, setGate] = useState(0);
  const { floaters, departs } = useMemo(() => {
    const order = (floater: Floater) => arrival.get(floater.key) ?? Number.POSITIVE_INFINITY;
    const ordered = [...candidates].filter((floater) => !withheld.has(floater.key)).sort((left, right) => order(left) - order(right));
    const lane = ordered.filter((floater) => order(floater) > gate);
    const expired = (floater: Floater) => floater.kind !== "more" && settledAt.has(floater.key) && now - settledAt.get(floater.key)! >= LINGER_MS[floater.kind];
    let cut = 0;
    while (cut < lane.length && expired(lane[cut]!)) cut += 1;
    for (const [kind, cap] of [["speech", SPEECH_CAP], ["call", CALL_CAP]] as const) {
      const held = lane.flatMap((floater, index) => (floater.kind === kind && index >= cut ? [index] : []));
      if (held.length > cap) cut = held[held.length - cap - 1]! + 1;
    }
    const shown = lane.slice(cut);
    const departs = lane.slice(0, cut).reduce((latest, floater) => Math.max(latest, arrival.get(floater.key) ?? 0), 0);
    /* Calls that left the lane while still at work: counted at the far end. */
    const unseen = ordered.filter((floater) => floater.kind === "call" && !floater.settled && !shown.includes(floater)).length;
    const more: Floater[] = unseen ? [{ kind: "more", key: `more:${Math.max(gate, departs)}`, count: unseen, settled: false }] : [];
    return { floaters: [...more, ...shown], departs };
  }, [candidates, arrival, settledAt, now, gate, withheld]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- what left stays out
    if (departs > gate) setGate(departs);
  }, [departs, gate]);

  /* The screen follows the placement: at once, or for a move the companion makes by itself with elements in its
     lane, in three steps (the lane empties, the character travels, the lane shows again). A new placement on the
     way starts over from what is on screen. */
  const carrying = floaters.length > 0;
  useLayoutEffect(() => {
    if (layout === view) return;
    const atOnce = moveAtOnce.current;
    moveAtOnce.current = false;
    const moves = !!view && !!layout && (layout.at.x !== view.at.x || layout.at.y !== view.at.y || layout.mode !== view.mode);
    const staged = !atOnce && moves && view?.mode === "expanded" && (layout?.mode === "expanded" || layout?.yielded === true) && carrying && !reducedMotion();
    if (!staged) {
      setView(layout);
      setRelocating(null);
      return;
    }
    setRelocating("out");
    const timer = setTimeout(() => { setView(layout); setRelocating(layout!.mode === "expanded" ? "travel" : null); }, LANE_OUT_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per placement; what the lane holds is read as it is then
  }, [layout]);
  useEffect(() => {
    if (relocating !== "travel") return;
    const timer = setTimeout(() => setRelocating(null), TRAVEL_MS);
    return () => clearTimeout(timer);
  }, [relocating, view]);

  /* A clock for the lingering, ticking only while something can still leave. */
  const lingering = floaters.some((floater) => floater.settled);
  useEffect(() => {
    if (!lingering) return;
    const timer = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(timer);
  }, [lingering]);

  /* The page changes under the companion (a menu opens, a message arrives with
     its controls, a font loads). At rest, with nothing in the lane and no answer
     on its way (not connecting, thinking or speaking), the placement is read
     again from the page as it is now, so the place never depends on the order the
     page arrived in, and text that arrived under the companion while it talked is
     left within a second of the lane emptying. Otherwise the companion holds its
     place, and moves only when a control or a line of text ends up beneath what
     it reserves. */
  const atRest = floaters.length === 0 && !starting && state.phase !== "thinking" && state.phase !== "speaking";
  useEffect(() => {
    if (!layout || dragging) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      timer = null;
      if (atRest) { settle(collapsed); return; }
      const obstacles = [...controlRects(root.current, protect, rows), ...(reserve?.() ?? [])];
      /* Text that arrived under what it reserves (a row of the conversation it stands in) moves it too, unless the
         operator put it there: it takes the place the rule gives now, and with none free of text it collapses to
         its tile, which flags the answer when it comes. The row it made way for is the record of what was sent.
         A page that reads as it did at the last placement gives the same answer: the search is not run again. */
      const reserved = footprint();
      if (reserved.some((rect) => !isFree(rect, obstacles))) { settle(collapsed, { obstacles, text: pageContent() }); return; }
      if (!chosen.current) {
        const text = pageContent();
        if (reserved.some((rect) => !isFree(rect, text, 0))) settle(collapsed, { obstacles, text });
      }
    };
    const schedule = () => { timer ??= setTimeout(check, 250); };
    const observer = new MutationObserver((records) => {
      if (records.every((record) => root.current?.contains(record.target))) return;
      schedule();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
    /* A transition that ended and a font that loaded move the page without changing its tree. */
    const onSettled = (event: Event) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) schedule(); };
    document.addEventListener("transitionend", onSettled, true);
    document.addEventListener("animationend", onSettled, true);
    /* A surface that scrolled carried its controls with it. */
    document.addEventListener("scroll", onSettled, { capture: true, passive: true });
    let live = true;
    void document.fonts?.ready.then(() => { if (live) schedule(); });
    /* The lane emptied, or this placement is new: the page is read once more. */
    schedule();
    return () => {
      live = false;
      observer.disconnect();
      document.removeEventListener("transitionend", onSettled, true);
      document.removeEventListener("animationend", onSettled, true);
      document.removeEventListener("scroll", onSettled, true);
      if (timer) clearTimeout(timer);
    };
  }, [layout, dragging, collapsed, protect, rows, reserve, settle, footprint, atRest, pageContent]);

  /* The lane's stack: fit, rise and leave. Measured after each commit and
     played back as transforms, so nothing animates layout. */
  const positions = useRef(new Map<string, Place>());
  const contents = useRef(new Map<string, Floater>());
  const [leaving, setLeaving] = useState<ReadonlyArray<{ floater: Floater; top: number; left: number; width: number; quick: boolean }>>([]);
  const lastEntry = useRef(0);
  const stackFacing = useRef<string | null>(null);
  /* The rise the lane is on: how fast it moves now decides the curve of the one that takes over. */
  const sheetFlight = useRef<{ animation: Animation; travel: number; curve: Bezier } | null>(null);
  const floaterKeys = floaters.map((floater) => `${floater.key}:${floater.kind === "speech" ? `${floater.text.length}${floater.cut === null ? "" : "c"}` : floater.kind === "call" ? `${floater.call.status}${(floater.call.result ?? floater.call.summary).length}` : floater.kind === "more" ? floater.count : floater.kind === "notice" ? floater.code : `${floater.delegation.stage}${floater.delegation.notice ?? ""}`}:${arrival.get(floater.key) ?? ""}`).join("|");
  useLayoutEffect(() => {
    const stack = stackEl.current;
    if (!stack || !shownLane) { positions.current.clear(); stackFacing.current = null; return; }
    const nodes = [...stack.querySelectorAll<HTMLElement>(":scope > [data-floater]")];
    const arrived = (node: HTMLElement) => (node.dataset.arrival ? Number(node.dataset.arrival) : null);
    const before = positions.current;
    /* An element never gives back height it had: one that shrank would pull the older ones toward the character. */
    for (const node of nodes) {
      const was = before.get(node.dataset.floater!);
      if (was && node.offsetHeight < was.height) node.style.minHeight = `${was.height}px`;
    }
    /* Fit: the stack keeps to the lane, less the room a leaving element drifts into and the room kept at
       the character's end. What does not fit leaves from the far end; the newest always stays. A proposal
       that waits for the operator's answer does not leave for want of room: what is older than it may, and
       what arrives after it and does not fit beside it is withheld instead. */
    const room = shownLane.rect.height - EXIT_ROOM - END_ROOM;
    let excess = nodes.reduce((sum, node) => sum + node.offsetHeight, 0) + Math.max(0, nodes.length - 1) * 8 - room;
    let sent = 0;
    const waits = nodes.findIndex((node) => node.dataset.awaiting !== undefined);
    for (const node of nodes.slice(0, waits === -1 ? -1 : waits)) {
      if (excess <= 0) break;
      if (node.dataset.kind === "more") continue;
      excess -= node.offsetHeight + 8;
      sent = Math.max(sent, arrived(node) ?? 0);
    }
    if (excess > 0 && waits !== -1) {
      const unseen = nodes.slice(waits + 1).filter((node) => !before.has(node.dataset.floater!)).map((node) => node.dataset.floater!);
      if (unseen.length) { setWithheld((current) => new Set([...current, ...unseen])); return; }
    }
    /* An element that went from the middle (the session dropped it) takes the older ones along. */
    const here = new Set(nodes.map((node) => node.dataset.floater!));
    for (const [key, was] of before) if (!here.has(key) && was.arrival !== null && nodes.some((node) => (arrived(node) ?? Number.POSITIVE_INFINITY) < was.arrival!)) sent = Math.max(sent, was.arrival);
    /* Settled before paint: the pass that follows plays the departure. */
    if (sent > gate) { setGate(sent); return; }
    const up = shownLane.direction === "up";
    /* A lane that flipped is a new arrangement: it is shown as it stands. */
    const facing = `${shownLane.side}:${shownLane.direction}`;
    const motion = !reducedMotion() && typeof stack.animate === "function" && (stackFacing.current === null || stackFacing.current === facing);
    stackFacing.current = facing;
    const after = new Map<string, Place>();
    /* Read, nearest the character first. */
    const read = [...nodes].reverse().map((node) => {
      const key = node.dataset.floater!;
      const was = before.get(key);
      const far = up ? stack.offsetHeight - node.offsetTop : node.offsetTop + node.offsetHeight;
      const place = { top: node.offsetTop, height: node.offsetHeight, width: node.offsetWidth, left: node.offsetLeft, far, arrival: arrived(node) ?? was?.arrival ?? null };
      after.set(key, place);
      return { node, was, place };
    });
    /* The elements that arrived: the new ones at the character's end, up to the first that was already there.
       They come out together, so each travels as far as the farthest of them stands from that end. */
    const firstOld = read.findIndex((entry) => entry.was);
    const arrivals = read.slice(0, firstOld === -1 ? read.length : firstOld);
    const sheet = arrivals.reduce((most, entry) => Math.max(most, entry.place.far), 0);
    let entered = 0;
    let rose = false;
    let moved = false;
    /* An element that fades in where it stands (the count of unseen calls, at the far end). */
    let faded = false;
    if (motion) {
      const sign = up ? 1 : -1;
      const flight = (node: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42;
      /* A rise already in flight continues from where it is, on the curve that starts at speed when the lane
         still moves at speed and from rest when it has all but stopped. An element that arrives meanwhile
         starts behind the one before it, as far out as that one still has to come. */
      const ahead = firstOld === -1 ? 0 : flight(read[firstOld]!.node);
      const plans = read.map(({ node, was, place }) => {
        const arriving = !was && arrivals.some((entry) => entry.node === node);
        const flying = was ? flight(node) : arriving ? ahead : 0;
        /* An element that grew shows its new part from behind its own edge at the character's side, as it
           travels the height it gained: it lies over no element that stands nearer the character. */
        const grew = was ? Math.max(0, place.height - was.height) : 0;
        const hidden = was ? hiddenByClip(node, up) : 0;
        /* How far the element stands from the lane's end at the character once it has risen. */
        const near = up ? stack.offsetHeight - place.top - place.height : place.top;
        return { node, was, arriving, flying, near, shifted: was ? place.far !== was.far : arriving, reveal: grew || hidden >= 0.5 ? grew + hidden : 0, travel: (was ? sign * (place.far - was.far) : arriving ? sign * sheet : 0) + flying };
      });
      /* A pass in which nothing arrived and nothing grew (text that streamed into a line it already had)
         leaves every rise in flight as it is: restarting one would stretch it and break its pace. */
      const shifted = plans.some((plan) => plan.shifted);
      const most = plans.reduce((far, plan) => Math.max(far, Math.abs(plan.travel)), 0);
      const flown = sheetFlight.current;
      const speed = flown?.animation.playState === "running" ? (flown.travel * bezierSlope(flown.curve, Number(flown.animation.currentTime ?? 0) / RISE_MS)) / RISE_MS : 0;
      const curve = riseCurve(speed, most);
      const easing = cssBezier(curve);
      const flies = (animation: Animation) => { animation.id = "rise"; startNow(animation); sheetFlight.current = { animation, travel: most, curve }; };
      const cut = (by: number) => (up ? `inset(-48px -48px ${by}px -48px)` : `inset(${by}px -48px -48px -48px)`);
      for (const { node, was, arriving, travel, reveal, near } of plans) {
        if (!was) {
          entered += 1;
          mark(node.dataset.kind === "speech" ? "vc:bubble-in" : "vc:call-in", RISE_MS);
          if (arriving) {
            /* It comes out from behind the lane's end at the character as the sheet rises: what of it is still
               beyond that edge is cut there, on the same curve, and once it is all out its own shadow (the
               bubble's warm glow) shows whole, so the glow fades as it was drawn and ends in no line. */
            const animation = node.animate(
              [{ transform: `translate3d(0, ${travel}px, 0)`, opacity: 0 }, { opacity: 1, offset: ENTER_SHOWN }, { transform: "translate3d(0, 0, 0)", opacity: 1 }],
              { duration: RISE_MS, easing },
            );
            flies(animation);
            const beyond = Math.abs(travel) - near;
            if (beyond >= 0.5) {
              const out = Math.min(1, beyond / Math.abs(travel));
              const edge = node.animate([{ clipPath: cut(beyond) }, { clipPath: cut(0), offset: out }, { clipPath: cut(-48) }], { duration: RISE_MS, easing });
              edge.id = "reveal";
              startNow(edge);
            }
          } else { node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, easing: "ease-out" }); faded = true; }
          continue;
        }
        if (!shifted || Math.abs(travel) < 1) continue;
        moved = true;
        for (const running of node.getAnimations()) if (running.id === "rise" || running.id === "reveal") running.cancel();
        const animation = node.animate([{ transform: `translate3d(0, ${travel}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration: RISE_MS, easing, composite: "replace" });
        flies(animation);
        if (reveal >= 1) {
          const revealing = node.animate([{ clipPath: cut(reveal) }, { clipPath: cut(0) }], { duration: RISE_MS, easing });
          revealing.id = "reveal";
          startNow(revealing);
        }
        rose = true;
      }
    }
    if (rose) mark("vc:rise", RISE_MS);
    /* Several arriving at once, or close behind each other. */
    const stamp = performance.now();
    if (entered > 1 || (entered === 1 && stamp - lastEntry.current < RISE_MS)) mark("vc:together", RISE_MS);
    if (entered) lastEntry.current = stamp;
    /* What left: it drifts away from the character and fades where it was. When the stack is rising
       into its place, a new element comes out where it stood (it was the last one there), or the count of
       unseen calls fades in at the far end where it leaves, it is gone at once, so no element shows through
       another. */
    const taken = moved || (motion && arrivals.length > 0) || faded;
    if (taken && motion) for (const node of stack.querySelectorAll<HTMLElement>(":scope > [data-leaving]")) fadeAtOnce(node);
    const gone = [...before.keys()].filter((key) => !after.has(key) && contents.current.has(key));
    if (gone.length && motion) {
      setLeaving((current) => [...current.filter((item) => !gone.includes(item.floater.key)), ...gone.map((key) => ({ floater: contents.current.get(key)!, ...before.get(key)!, quick: taken }))]);
      mark("vc:bubble-out", EXIT_MS);
    }
    positions.current = after;
    for (const floater of floaters) contents.current.set(floater.key, floater);
    for (const key of contents.current.keys()) if (!after.has(key) && !gone.includes(key)) contents.current.delete(key);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per change of what the lane shows
  }, [floaterKeys, shownLane?.direction, shownLane?.side, shownLane?.rect.height, expanded]);
  const leavingKeys = leaving.map((item) => item.floater.key).join("|");
  useEffect(() => {
    if (!leaving.length) return;
    const timer = setTimeout(() => setLeaving([]), EXIT_MS + 40);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per departure
  }, [leavingKeys]);
  const leavingRef = useCallback((node: HTMLElement | null) => {
    if (!node || reducedMotion() || typeof node.animate !== "function" || node.dataset.leaving === "played") return;
    const quick = node.dataset.leaving === "quick";
    node.dataset.leaving = "played";
    if (quick) { fadeAtOnce(node); return; }
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
    setHeld({ at: held.at, lane: layout?.mode === "expanded" ? laneLayout(viewportSize(), { ...held.at, ...block }, layout.lane.rect.height) : null });
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
    chosen.current = true;
    settledFor.current = null;
    moveAtOnce.current = true;
    setLayout(layout?.mode === "expanded" ? { mode: "expanded", at: held.at, lane: laneLayout(viewportSize(), { ...held.at, ...block }, layout.lane.rect.height) } : { mode: "collapsed", at: held.at, yielded: false });
    setDragging(false);
    setHeld(null);
    settle(collapsed);
  };
  const onKeyMove = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const move = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key];
    if (!move && event.key !== "Home") return;
    event.preventDefault();
    moveAtOnce.current = true;
    const size = expanded ? block : shape;
    if (event.key === "Home") { anchor.current = null; chosen.current = false; }
    else {
      chosen.current = true;
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
    /* Opening a companion that collapsed for want of a place free of text is the operator's request, answered
       as a drop is: the nearest place free of controls, which may lie over text. Home gives the default rule back. */
    if (!next && layout?.mode === "collapsed" && layout.yielded) { chosen.current = true; settledFor.current = null; }
    if (!next && !collapsed) settle(false);
  };
  const speechLocale: Locale = sessionLocale ?? (locale === "uk" ? "uk" : "en");
  const talk = () => {
    if (starting) return;
    /* What is already known to refuse the conversation is said at once, with the microphone left alone. */
    const refusal = project === null ? "NO_PROJECT" : preflight?.() ?? null;
    setTalks((count) => count + 1);
    setRefusedStart(refusal ? { code: refusal, n: (refusedStart?.n ?? 0) + 1 } : null);
    if (refusal || project === null) return;
    setMuted(false);
    setStarting(true);
    /* A failed start is told by the adapter as an error event; the lane says it. */
    void store.start({ locale: speechLocale, project }).catch(() => undefined).finally(() => setStarting(false));
  };
  const end = () => { void store.stop().catch(() => undefined); };
  const toggleMute = () => { const next = !muted; setMuted(next); void store.command({ type: "mute", muted: next }).catch(() => undefined); };
  const decide = (proposalId: string, decision: "send" | "cancel") => {
    if (deciding.current.has(proposalId)) return;
    deciding.current.add(proposalId);
    setDecidedFor((current) => new Set(current).add(proposalId));
    setUnconfirmedFor((current) => { const next = new Set(current); next.delete(proposalId); return next; });
    /* A lost request leaves the card as it was, says so, and takes another tap. The server keeps one
       delivery key per proposal, so a repeated Send recovers the first send and never adds a second. */
    void store.command({ type: "confirmation", proposalId, decision, via: "tap" }).catch(() => {
      deciding.current.delete(proposalId);
      setDecidedFor((current) => { const next = new Set(current); next.delete(proposalId); return next; });
      setUnconfirmedFor((current) => new Set(current).add(proposalId));
      void store.refresh().catch(() => undefined);
    });
  };

  const connected = state.phase !== "offline";
  const phaseLabel = starting && !connected ? t("voiceCompanion.phase.connecting") : t(`voiceCompanion.phase.${state.phase}`);
  const failing = floaters.some((floater) => floater.kind === "notice" && floater.tone === "failure");
  const attention = stage === "awaiting-confirmation" || stage === "answered" || failing;
  const seconds = (value: number) => new Intl.NumberFormat(locale === "uk" ? "uk" : "en", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 1000);

  /* `nearest`: the element standing next to the character, which a comic bubble's tail points from. */
  const renderFloater = (floater: Floater, nearest = false) => {
    if (floater.kind === "speech") {
      return (
        <p className="vc-bubble" aria-hidden data-speaker={floater.speaker} data-newest={nearest ? "" : undefined} data-cut={floater.cut !== null ? "" : undefined} data-companion-bubble>
          {floater.speaker === "operator" ? <span className="vc-who">{t("voiceCompanion.you")}</span> : null}
          <span className="vc-text">{tied(floater.text)}</span>
          {floater.cut !== null ? <span className="vc-cut" data-companion-cut>{t("voiceCompanion.cutAfter", { s: seconds(floater.cut) })}</span> : null}
        </p>
      );
    }
    if (floater.kind === "more") return <div className="vc-call vc-more" data-companion-more>{t("voiceCompanion.moreCalls", { n: floater.count })}</div>;
    if (floater.kind === "notice") {
      return (
        <div className="vc-notice" role={floater.tone === "failure" ? "alert" : "status"} data-tone={floater.tone} data-code={floater.code} data-companion-notice>
          <span className="vc-notice-icon" aria-hidden><CircleAlert size={14} /></span>
          <span className="vc-notice-text">{companionErrorMessage(floater.code, speechLocaleOf(locale))}</span>
          {onOpenSettings && SETTINGS_FAILURES.has(floater.code) ? <button type="button" className="vc-act" data-companion-open-settings onClick={onOpenSettings}><Settings size={13} aria-hidden />{t("voiceCompanion.openSettings")}</button> : null}
        </div>
      );
    }
    if (floater.kind === "call") {
      const { call } = floater;
      /* A backend that summarised the call by its bare name gets the tool's own line in the interface language,
         and a failure that is only a code is said in words. */
      const known = Object.hasOwn(TOOL_LINE, call.name) ? TOOL_LINE[call.name as keyof typeof TOOL_LINE] : null;
      const summary = known && call.summary === call.name.replaceAll("_", " ") ? t(known) : call.summary;
      const result = call.status === "failed" && /^[A-Z_]+$/u.test(call.result ?? "") ? t("voiceCompanion.tool.failed") : call.result;
      const line = call.status === "running" ? summary : result ?? summary;
      return (
        <div className="vc-call" data-status={call.status} data-tool={call.name} data-companion-call>
          <span className="vc-call-icon" aria-hidden>{call.status === "running" ? <LoaderCircle size={14} className="vc-spin" /> : call.status === "done" ? <Check size={14} /> : <X size={14} />}</span>
          <span className="vc-call-body">
            <span className="vc-call-name">{call.name}</span>
            <span className="vc-call-line" title={line}>{line}</span>
          </span>
          <span className="vc-call-state">{t(`voiceCompanion.call.${call.status}`)}</span>
        </div>
      );
    }
    const { delegation } = floater;
    const recipient = delegation.proposal?.recipient ?? delegation.delivery?.recipient ?? null;
    if (floater.kind === "answer") {
      return (
        <div className="vc-call vc-deleg vc-reply" data-stage="answered" data-companion-reply>
          <div className="vc-deleg-head">
            <span className="vc-call-icon" aria-hidden><Check size={14} /></span>
            <span className="vc-deleg-title">{t("voiceCompanion.stage.answered")}</span>
            {recipient ? <span className="vc-deleg-engine"><EngineMark engine={recipient.engine} size={14} />{ENGINE_NAME[recipient.engine]}</span> : null}
          </div>
          <p className="vc-answer" tabIndex={0} data-companion-answer>{delegation.answer?.text}</p>
        </div>
      );
    }
    const target = recipient?.project ?? project ?? "";
    const isCurrent = delegation.callId === state.delegation?.callId;
    /* Once answered, the request reads as delivered; the answer stands beside the character as its own element. */
    const head = delegation.stage === "awaiting-confirmation" ? t("voiceCompanion.proposal", { project: target }) : t(`voiceCompanion.stage.${delegation.stage === "answered" ? "delivered" : delegation.stage}`);
    const running = delegation.stage === "proposed" || delegation.stage === "sending";
    const failed = delegation.stage === "refused" || delegation.stage === "failed" || delegation.stage === "unknown";
    return (
      <div className="vc-call vc-deleg" data-stage={delegation.stage} data-companion-delegation>
        <div className="vc-deleg-head">
          <span className="vc-call-icon" aria-hidden>{running ? <LoaderCircle size={14} className="vc-spin" /> : failed ? <CircleAlert size={14} /> : delegation.stage === "cancelled" ? <X size={14} /> : delegation.stage === "awaiting-confirmation" ? <SendHorizontal size={14} /> : <Check size={14} />}</span>
          <span className="vc-deleg-title">{head}</span>
          {recipient ? <span className="vc-deleg-engine"><EngineMark engine={recipient.engine} size={14} />{ENGINE_NAME[recipient.engine]}</span> : null}
        </div>
        <span className="vc-call-name">{DELEGATION_TOOL}</span>
        {delegation.stage === "refused" ? <p className="vc-deleg-note" data-companion-refused={delegation.refusal ?? ""}>{delegation.refusal === "no_orchestrator" ? companionErrorMessage("no_orchestrator", speechLocaleOf(locale)) : t("voiceCompanion.refused")}</p> : null}
        {delegation.stage === "cancelled" && delegation.refusal ? <p className="vc-deleg-note" data-companion-withdrawn={delegation.refusal}>{t(UNSENT_NOTE[delegation.refusal] ?? "voiceCompanion.withdrawn")}</p> : null}
        {/* The model's own reason for asking first, and the two ways to answer. */}
        {delegation.stage === "awaiting-confirmation" && delegation.proposal?.confirmation ? <p className="vc-deleg-note" data-companion-confirm-reason>{delegation.proposal.confirmation.reason}</p> : null}
        {delegation.stage === "awaiting-confirmation" || delegation.stage === "sending" || delegation.stage === "queued" || delegation.stage === "delivered" || delegation.stage === "unknown" || delegation.stage === "answered" ? (
          <p className="vc-instruction" tabIndex={0} data-companion-instruction>{delegation.instruction}</p>
        ) : null}
        {delegation.stage === "awaiting-confirmation" ? <p className="vc-deleg-note vc-deleg-wait" data-companion-confirm-hint>{t("voiceCompanion.confirmHint")}</p> : null}
        {delegation.stage === "awaiting-confirmation" ? (
          <div className="vc-acts">
            <button type="button" className="vc-act" data-companion-cancel disabled={!!delegation.proposal && decidedFor.has(delegation.proposal.proposalId)} onClick={() => delegation.proposal && decide(delegation.proposal.proposalId, "cancel")}><X size={14} aria-hidden />{t("voiceCompanion.cancel")}</button>
            <button type="button" className="vc-act" data-primary data-companion-send disabled={!!delegation.proposal && decidedFor.has(delegation.proposal.proposalId)} onClick={() => delegation.proposal && decide(delegation.proposal.proposalId, "send")}><SendHorizontal size={14} aria-hidden />{t("voiceCompanion.send")}</button>
          </div>
        ) : null}
        {delegation.stage === "sending" || delegation.stage === "queued" || delegation.stage === "delivered" || delegation.stage === "answered" ? (
          <div className="vc-track" aria-hidden data-companion-track>
            <span className="vc-end"><CompanionMini /></span>
            <span className="vc-rail" ref={isCurrent ? rail : undefined}><span className="vc-pellet" ref={isCurrent ? pellet : undefined} /></span>
            <span className="vc-end" data-done={delegation.stage !== "sending" ? "" : undefined}>{recipient ? <EngineMark engine={recipient.engine} size={14} /> : null}</span>
          </div>
        ) : null}
        {/* What is still owed after the send: the reply tied to this request, or the proof that it arrived. */}
        {delegation.stage === "awaiting-confirmation" && delegation.proposal && unconfirmedFor.has(delegation.proposal.proposalId) ? <p className="vc-deleg-note vc-deleg-wait" role="alert" data-companion-delegation-notice="DELIVERY_UNCONFIRMED">{companionErrorMessage("SEND_UNCONFIRMED", speechLocaleOf(locale))}</p> : null}
        {delegation.notice && delegation.stage !== "answered" ? <p className="vc-deleg-note vc-deleg-wait" data-companion-delegation-notice={delegation.notice}>{companionErrorMessage(delegation.notice, speechLocaleOf(locale))}</p> : null}
      </div>
    );
  };

  const at = heldView?.at ?? view?.at ?? { x: -9999, y: -9999 };
  const size = expanded ? block : shape;
  const style = { width: size.width, height: size.height, transform: `translate3d(${at.x}px, ${at.y}px, 0)`, visibility: view ? undefined : ("hidden" as const) };
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
      data-mode={adapter.mode}
      data-starting={starting ? "" : undefined}
      data-layout={view?.mode ?? "expanded"}
      data-placed={view ? "" : undefined}
      data-yielded={view?.mode === "collapsed" && view.yielded ? "" : undefined}
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
          data-align={shownLane.align}
          data-direction={shownLane.direction}
          data-relocating={relocating ?? undefined}
          style={{ left: shownLane.rect.x - at.x, top: shownLane.rect.y - at.y, width: shownLane.rect.width, height: shownLane.rect.height, ["--vc-room" as string]: `${shownLane.rect.height - EXIT_ROOM - END_ROOM}px` }}
        >
          <div className="vc-stack" ref={stackEl}>
            {floaters.map((floater, index) => (
              <div key={floater.key} className="vc-floater" data-floater={floater.key} data-arrival={arrival.get(floater.key)} data-kind={floater.kind} data-speaker={floater.kind === "speech" ? floater.speaker : undefined}
                data-awaiting={floater.kind === "delegation" && floater.delegation.stage === "awaiting-confirmation" ? "" : undefined}>{renderFloater(floater, index === floaters.length - 1)}</div>
            ))}
            {leaving.map(({ floater, top, left, width, quick }) => (
              <div key={`leaving:${floater.key}`} ref={leavingRef} className="vc-floater" aria-hidden inert data-leaving={quick ? "quick" : ""} data-kind={floater.kind} data-speaker={floater.kind === "speech" ? floater.speaker : undefined} style={{ position: "absolute", top, left, width }}>{renderFloater(floater)}</div>
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
            <CompanionCharacter ref={character} size={CHARACTER} />
          </button>
          <span className="vc-state" data-companion-phase aria-hidden><span className="vc-phase"><span className="vc-dot" />{phaseLabel}</span>{adapter.mode === "simulated" ? <span className="vc-sim">{t("voiceCompanion.simulated")}</span> : null}</span>
          <div className="vc-controls">
            {connected || starting ? (
              <>
                <button type="button" className="vc-btn" data-on={muted ? "" : undefined} aria-pressed={muted} disabled={!connected} aria-label={t(muted ? "voiceCompanion.unmute" : "voiceCompanion.mute")} title={t(muted ? "voiceCompanion.unmute" : "voiceCompanion.mute")} onClick={toggleMute}>
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
        <>
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
          <CompanionCharacter ref={character} size={SHAPE_CHARACTER} />
          {attention ? <span className="vc-flag" data-companion-flag data-tone={failing ? "failure" : undefined} aria-hidden /> : null}
        </button>
        {/* Hanging up stays in reach while a conversation is open, however small the companion has to be,
            and with the microphone muted no spoken goodbye can end it either. */}
        {connected || starting ? <button type="button" className="vc-btn vc-shape-end" data-companion-end aria-label={t("voiceCompanion.end")} title={t("voiceCompanion.end")} onClick={end}><PhoneOff size={13} aria-hidden /></button> : null}
        </>
      )}
      {/* The whole conversation, for a screen reader and for anyone who missed a bubble. */}
      <ol className="vc-sr" aria-live="polite" aria-label={t("voiceCompanion.transcript")} data-companion-transcript>
        {state.lines.filter((line) => line.final || line.playback === "cut").map((line) => <li key={line.key}>{transcriptLine(line)}</li>)}
        {[...state.deliveryCards.filter((card) => card.callId !== state.delegation?.callId), ...(state.delegation ? [state.delegation] : [])].map((card) => (card.answer ? <li key={card.answer.reportId}>{t("voiceCompanion.orchestrator")}: {card.answer.text}</li> : null))}
      </ol>
      {/* A confirmation that waits is a decision the operator must be able to reach without the lane being on screen. */}
      {!expanded && stage === "awaiting-confirmation" ? <span className="vc-sr" role="status">{t("voiceCompanion.proposal", { project: state.delegation?.proposal?.recipient.project ?? project ?? "" })}</span> : null}
      {/* A failure is said even when the lane is not on screen to show it. */}
      {!expanded ? floaters.filter((floater) => floater.kind === "notice").map((floater) => <span key={floater.key} className="vc-sr" role="alert">{floater.kind === "notice" ? companionErrorMessage(floater.code, speechLocaleOf(locale)) : null}</span>) : null}
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
