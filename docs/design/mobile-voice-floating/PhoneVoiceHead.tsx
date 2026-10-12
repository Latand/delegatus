"use client";

import { EyeOff, Mic, MicOff, PhoneOff } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { LAYER } from "@/components/layers";
import { CompanionCharacter, type CharacterHandle } from "@/components/voiceCompanion/CompanionCharacter";
import { VOICE_COMPANION_CSS } from "@/components/voiceCompanion/voiceCompanionStyles";
import { translate, useLocale } from "@/lib/i18n";

/*
 * PROTOTYPE of the voice companion on the phone (docs/design/mobile-voice-floating/README.md).
 * It draws the three numbered variants over the real phone shell: the product's own character,
 * the product's own bubble and tile styles, and a scripted state in place of a voice session.
 * Nothing here opens a microphone or asks any route for anything. The harness mounts it beside
 * the Viewer in an export of the repository; the product never imports this file.
 *
 *   1  the head above the composer, its words in a band the feed is inset by
 *   2  the head free on either side edge, its words as bubbles on one plate that covers whole rows, hidden by one drag
 *   3  the head under the top bar, its words in a strip under the bar that ends between two rows
 */

export type PhoneVoiceVariant = 1 | 2 | 3;
type Phase = "offline" | "listening" | "thinking" | "speaking";
interface Box { x: number; y: number; width: number; height: number }
interface Scene { phase: Phase; words: boolean; muted: boolean }
type Side = "left" | "right";

const HEAD = 52;
const CHARACTER = 36;
const EDGE = 8;
/* The band the first variant keeps for the head and its words at the feed's end: two lines of a bubble. */
const BAND = 60;
/* Between the second variant's head and the plate its words stand on. */
const PLATE_GAP = 10;
const PLATE_PAD = 8;
const DRAG_THRESHOLD = 6;
/* Where the second variant's head is dropped to hide it. */
const DROP = 64;
const HIDDEN_KEY = "mvf:voice-hidden";
export const SHOW_EVENT = "mvf:voice-show";

const COPY = {
  en: {
    hide: "Hide", show: "Show voice", dropToHide: "Hide",
    older: "Looking at the atlas board.",
    short: "Three tasks in progress. The board review runs longest.",
    long: "Three tasks are in progress. The phone board review has run longest: it is on its second round.",
  },
  uk: {
    hide: "Сховати", show: "Показати голос", dropToHide: "Сховати",
    older: "Дивлюся дошку проєкту atlas.",
    short: "Три задачі в роботі. Найдовше триває рев'ю дошки.",
    long: "Три задачі в роботі. Найдовше триває рев'ю телефонної дошки: воно на другому колі.",
  },
} as const;

export const phoneVoiceCopy = (locale: string) => COPY[locale === "uk" ? "uk" : "en"];
export const phoneVoiceHidden = () => { try { return localStorage.getItem(HIDDEN_KEY) === "1"; } catch { return false; } };
/** «Показати голос» in the board menu: the head comes back where it stood. */
export const showPhoneVoice = () => { try { localStorage.removeItem(HIDDEN_KEY); } catch { /* private mode */ } window.dispatchEvent(new Event(SHOW_EVENT)); };

const CSS = `
.mvf { transition: none; }
.mvf .mvf-head { inset: auto; left: 0; top: 0; width: ${HEAD}px; height: ${HEAD}px; border-radius: 50%; transition: transform 260ms var(--vc-ease), box-shadow 200ms ease-out; animation: none; }
.mvf[data-dragging] .mvf-head { transition: none; box-shadow: 0 12px 26px rgb(20 20 30 / 0.28); cursor: grabbing; }
.mvf-dot { position: absolute; right: -1px; bottom: -1px; width: 13px; height: 13px; border-radius: 50%; background: var(--vc-ring); border: 2px solid var(--color-raised); }
/* No call: a hollow solid ring and a solid outline in the border's colour. Nothing dashed and nothing dimmed, so nothing reads as work in progress. */
.mvf[data-phase="offline"] .mvf-dot { background: var(--color-raised); border: 2px solid var(--color-muted); box-shadow: 0 0 0 1px var(--color-raised); }
.mvf[data-phase="offline"] .mvf-head { border-style: solid; border-color: color-mix(in srgb, var(--color-muted) 60%, var(--color-border)); }
.mvf[data-phase="offline"] .vc-char { filter: none; opacity: 1; }
.mvf[data-phase="offline"] .vc-char-body, .mvf[data-phase="offline"] .vc-char-eyes { animation: none; }
.mvf[data-phase="offline"] .mvf-status .vc-dot { border: 1.5px solid var(--color-muted); }
.mvf[data-muted] .mvf-dot { background: var(--color-danger); }
.mvf .mvf-lane { clip-path: none; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.mvf .mvf-lane[data-side="left"] { align-items: flex-end; }
.mvf .mvf-lane[data-side="right"] { align-items: flex-start; }
.mvf .mvf-lane[data-side="above"][data-align="end"] { align-items: flex-end; }
.mvf .mvf-lane[data-side="above"][data-align="start"] { align-items: flex-start; }
.mvf .mvf-lane[data-direction="down"] { flex-direction: column-reverse; }
.mvf .mvf-lane > * { max-width: min(280px, 100%); }
.mvf .mvf-lane[data-fit="two"] { justify-content: flex-end; }
.mvf .mvf-lane[data-fit="two"][data-direction="down"] { justify-content: flex-end; }
.mvf .mvf-lane[data-fit="two"] .vc-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
/* Two lines stand exactly as tall as the head, and the shadow stays inside the 8 px kept above the composer's line. */
.mvf .mvf-lane[data-fit="two"] .vc-bubble { padding: 5px 12px; box-shadow: var(--shadow-1); }
/* Over a phone's page a bubble is opaque: the rows under glass read through it. */
.mvf .vc-bubble[data-speaker="companion"], .mvf .vc-bubble[data-speaker="companion"][data-newest]::after { background: var(--color-raised); backdrop-filter: none; -webkit-backdrop-filter: none; }
.mvf .vc-bubble[data-older] { color: var(--color-secondary); font-size: 13px; line-height: 18px; font-weight: 400; box-shadow: var(--shadow-1); }
.mvf .vc-lane[data-side="above"][data-align="end"] .vc-bubble[data-newest]::after { right: 13px; }
.mvf .vc-lane[data-side="above"][data-align="start"] .vc-bubble[data-newest]::after { left: 13px; }
/* What the words stand on where they lie over the page: one opaque surface whose edges fall between two rows, so a row is
   covered whole or not at all, and nothing reads through between two bubbles. It takes the touch, so no row under it is
   pressed unseen. */
.mvf-plate { position: absolute; display: flex; flex-direction: column; pointer-events: auto; background: var(--color-canvas); }
/* The corners are tight: a wide one would let the first letters of the row at the plate's edge out past its arc. */
.mvf-plate[data-kind="card"] { border: 1px solid var(--color-border); border-radius: 8px; box-shadow: var(--shadow-2); }
.mvf-plate[data-kind="strip"] { border-bottom: 1px solid var(--color-border); }
.mvf-plate[data-grow="up"] { justify-content: flex-end; }
.mvf-plate > .mvf-plate-in { flex: none; padding: ${PLATE_PAD}px; }
.mvf .mvf-plate .mvf-lane { position: relative; width: 100%; }
.mvf .mvf-plate .mvf-lane > * { max-width: 100%; }
.mvf .mvf-plate .vc-bubble { box-shadow: none; }
.mvf .vc-lane[data-side="above"][data-direction="down"] .vc-bubble[data-newest]::after { bottom: auto; top: -6px; transform: rotate(-135deg); }
.mvf .vc-lane[data-side="left"] .vc-bubble[data-newest]::after, .mvf .vc-lane[data-side="right"] .vc-bubble[data-newest]::after { bottom: calc(50% - 5px); }
.mvf-pop {
  position: absolute; width: 236px; padding: 4px 0 6px; pointer-events: auto;
  background: var(--color-raised); color: var(--color-primary); border: 1px solid var(--color-border); border-radius: 14px; box-shadow: var(--shadow-2);
}
.mvf-status { display: flex; align-items: center; gap: 7px; margin: 0; padding: 8px 14px 6px; font-size: 12px; line-height: 16px; color: var(--color-secondary); }
.mvf-status b { font-weight: 600; color: var(--color-primary); }
.mvf-status .vc-dot { width: 8px; height: 8px; }
.mvf[data-muted] .mvf-status .vc-dot { background: var(--color-danger); }
.mvf-row {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 0 14px; border: 0; background: none; color: var(--color-primary);
  font: 600 14px/20px var(--font-sans); text-align: left; cursor: pointer;
}
.mvf-row:active { background: var(--color-sunken); }
.mvf-row svg { flex: none; color: var(--color-secondary); }
.mvf-row[data-tone="danger"], .mvf-row[data-tone="danger"] svg { color: var(--color-danger); }
.mvf-row[data-tone="primary"] { margin: 2px 10px 4px; width: calc(100% - 20px); justify-content: center; border-radius: 999px; background: var(--color-primary); color: var(--color-raised); }
.mvf-row[data-tone="primary"] svg { color: inherit; }
.mvf-slot { position: absolute; width: ${HEAD}px; height: ${HEAD}px; border-radius: 50%; border: 2px dashed color-mix(in srgb, var(--color-accent) 70%, transparent); background: color-mix(in srgb, var(--color-accent) 10%, transparent); pointer-events: none; }
.mvf-slot[data-near] { border-style: solid; background: color-mix(in srgb, var(--color-accent) 24%, transparent); }
.mvf-rail { position: absolute; width: 4px; border-radius: 2px; background: color-mix(in srgb, var(--color-accent) 28%, transparent); pointer-events: none; }
.mvf-rail[data-near] { background: var(--color-accent); }
.mvf-drop {
  position: absolute; display: grid; place-items: center; width: ${DROP}px; height: ${DROP}px; border-radius: 50%; pointer-events: none;
  background: var(--color-raised); color: var(--color-secondary); border: 2px dashed var(--color-muted); box-shadow: var(--shadow-2);
  transition: transform 140ms ease-out, background-color 140ms ease-out, border-color 140ms ease-out;
}
.mvf-drop[data-over] { transform: scale(1.1); border-style: solid; border-color: var(--color-primary); background: var(--color-sunken); }
.mvf-drop-word {
  position: absolute; height: 26px; padding: 0 10px; border-radius: 8px; pointer-events: none; transform: translateX(-50%);
  background: var(--color-primary); color: var(--color-raised); font: 600 13px/26px var(--font-sans); white-space: nowrap; box-shadow: var(--shadow-1);
}
`;

const box = (element: Element | null): Box | null => {
  if (!(element instanceof HTMLElement) || element.checkVisibility?.() === false) return null;
  const rect = element.getBoundingClientRect();
  return rect.width < 1 || rect.height < 1 ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
};

/**
 * The line the eye reads as the top of the bottom chrome. The dock draws it on its own box; the composer's field sits
 * a few pixels inside the pane's footer, and the divider is the footer's. The head keeps its 8 px from that line.
 */
function lineAbove(node: Element): number {
  const own = node.getBoundingClientRect().top;
  let line = own;
  for (let parent = node.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) {
    const top = parent.getBoundingClientRect().top;
    if (top < own - 24) break;
    if (top < line && parseFloat(getComputedStyle(parent).borderTopWidth) > 0) line = top;
  }
  return line;
}

interface Row { top: number; bottom: number }
/** Every line of text, icon and control the conversation shows, as the spans of height a plate's edge must not cross. */
function pageRows(): Row[] {
  const rows: Row[] = [];
  const range = document.createRange();
  for (const feed of document.querySelectorAll<HTMLElement>("[data-log-feed-scroller]")) {
    const frame = box(feed);
    if (!frame) continue;
    const add = (rect: DOMRect) => {
      const top = Math.max(rect.top, frame.y), bottom = Math.min(rect.bottom, frame.y + frame.height);
      if (rect.width >= 1 && bottom - top >= 1) rows.push({ top, bottom });
    };
    const walker = document.createTreeWalker(feed, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) add(line);
    }
    for (const mark of feed.querySelectorAll("svg, img, button")) add(mark.getBoundingClientRect());
  }
  return rows;
}
/** Moves an edge the given way until it stands between two rows. */
function between(rows: Row[], y: number, way: 1 | -1): number {
  let edge = y;
  for (let pass = 0; pass < 40; pass += 1) {
    const crossed = rows.find((row) => row.top - 1.5 < edge && edge < row.bottom + 1.5);
    if (!crossed) break;
    edge = way > 0 ? crossed.bottom + 2 : crossed.top - 2;
  }
  return edge;
}

/**
 * The surface the words stand on over the page. It starts at \`from\` and grows the given way by its content (a card) or
 * by \`extent\` (a strip); the far edge, and a card's near one, are moved to stand between two rows of the conversation.
 */
function WordsPlate({ kind, left, width, from, grow, extent, children }: { kind: "card" | "strip"; left: number; width: number; from: number; grow: "up" | "down"; extent?: number; children?: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState<{ top: number; height: number } | null>(null);
  const [, setScrolled] = useState(0);
  useEffect(() => {
    let frame = 0;
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setScrolled((value) => value + 1)); };
    document.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("scroll", onScroll, true); cancelAnimationFrame(frame); };
  }, []);
  /* Read after every render: the rows move with the feed's scroll, its tail and its own layout, and the guarded set stops the chain. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const natural = extent ?? inner.current?.offsetHeight ?? 0;
    const rows = pageRows();
    const near = kind === "strip" ? from : between(rows, from, grow === "up" ? -1 : 1);
    const far = grow === "up" ? between(rows, near - natural, -1) : between(rows, near + natural, 1);
    const next = { top: Math.min(near, far), height: Math.abs(far - near) };
    setSpan((value) => value && Math.abs(value.top - next.top) < 0.25 && Math.abs(value.height - next.height) < 0.25 ? value : next);
  });
  return (
    <div className="mvf-plate" data-mvf-plate={kind} data-kind={kind} data-grow={grow} style={{ left, width, top: span?.top ?? from, height: span?.height, visibility: span ? undefined : "hidden" }}>
      {children ? <div ref={inner} className="mvf-plate-in">{children}</div> : null}
    </div>
  );
}

/** What the phone shell gives the head to stand between: the fixed chrome above, the composer or dock below, an open sheet. */
function readShell() {
  const width = innerWidth;
  const height = visualViewport?.height ?? innerHeight;
  /* The fixed chrome over a screen: its bar and, on a board, the seat card and the column tabs under it. */
  const tops = [...document.querySelectorAll("[data-mobile2-bar], [data-mobile2-seat-card], [data-mobile2-seat-invitation], [data-phone-kanban-tabs]")].flatMap((node) => box(node) ?? []);
  const bottoms = [...document.querySelectorAll("[data-mobile2-composer], [data-mobile2-dock], [data-mobile2-receipt]")].flatMap((node) => box(node) ? lineAbove(node) : []);
  const sheet = box(document.querySelector("[data-mobile2-sheet]"));
  return { width, height, top: tops.length ? Math.max(...tops.map((rect) => rect.y + rect.height)) : 0, bottom: bottoms.length ? Math.min(...bottoms) : height, sheet };
}
type Shell = ReturnType<typeof readShell>;

const ridesSheet = (variant: PhoneVoiceVariant, shell: Shell) => shell.sheet !== null && (variant !== 3 || shell.sheet.y < shell.top + EDGE + HEAD + EDGE);

function restingPlace(variant: PhoneVoiceVariant, shell: Shell, side: Side, free: number | null): { x: number; y: number } {
  const x = side === "right" ? shell.width - EDGE - HEAD : EDGE;
  const low = shell.bottom - EDGE - HEAD;
  const high = shell.top + EDGE;
  /* Under the bar the head keeps its place while a sheet opens below it, and moves only for a sheet tall enough to cover it. */
  if (variant === 3 && !ridesSheet(variant, shell)) return { x, y: high };
  /* Over an open sheet the head rides the dimmed strip above it, so it lies on nothing the sheet shows. */
  if (shell.sheet) return { x, y: Math.max(4, shell.sheet.y - EDGE - HEAD) };
  if (variant === 2 && free !== null) return { x, y: Math.min(low, Math.max(high, free)) };
  return { x, y: low };
}

export function PhoneVoiceHead({ variant }: { variant: PhoneVoiceVariant }) {
  const { locale } = useLocale();
  const copy = phoneVoiceCopy(locale);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [scene, setScene] = useState<Scene>({ phase: "speaking", words: true, muted: false });
  const [hidden, setHidden] = useState(phoneVoiceHidden);
  const [menu, setMenu] = useState(false);
  const [side, setSide] = useState<Side>("right");
  const [free, setFree] = useState<number | null>(null);
  const [shell, setShell] = useState<Shell | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [seconds, setSeconds] = useState(134);
  const character = useRef<CharacterHandle>(null);
  const held = useRef<{ id: number; dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const swallow = useRef(false);
  const [mount] = useState(() => Math.random().toString(36).slice(2, 8));

  /* The shell is read while it changes: a screen pushed, a sheet opened, the keyboard raising the composer. */
  useLayoutEffect(() => {
    let frame = 0;
    let last = "";
    const read = () => {
      const next = readShell();
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setShell(next); }
      frame = requestAnimationFrame(read);
    };
    read();
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const show = () => setHidden(false);
    window.addEventListener(SHOW_EVENT, show);
    return () => window.removeEventListener(SHOW_EVENT, show);
  }, []);
  const live = scene.phase !== "offline";
  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => clearInterval(tick);
  }, [live]);
  useEffect(() => { character.current?.setLevel(scene.phase === "speaking" && !hidden ? 0.72 : 0); }, [scene.phase, hidden, shell]);
  /* The scripted state the driver sets in place of a voice session. */
  useEffect(() => {
    (window as unknown as { mvfVoice: unknown }).mvfVoice = {
      set: (next: Partial<Scene>) => setScene((value) => ({ ...value, ...next })),
      reset: () => { setSide("right"); setFree(null); setMenu(false); },
    };
  }, []);

  /* Variant 1 insets the conversation's feed by the band, so at the feed's end the head and its words lie on no row:
     the last row and the touch area of its copy button end above them, wherever the feed's own box ends. */
  const inset = variant === 1 && !hidden && !shell?.sheet;
  useLayoutEffect(() => {
    if (!inset || !shell) return;
    const bandTop = restingPlace(variant, shell, side, free).y;
    const feeds = [...document.querySelectorAll<HTMLElement>("[data-log-feed-scroller]")];
    const kept = feeds.map((feed) => {
      const before = feed.style.paddingBottom;
      const pad = Math.max(BAND, Math.ceil(feed.getBoundingClientRect().bottom - bandTop)) + EDGE * 2;
      const short = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight;
      const atEnd = short() < 4;
      feed.style.paddingBottom = `${pad}px`;
      if (atEnd) feed.scrollTop = feed.scrollHeight;
      /* The feed pins its tail by its own measure, which stops short of the inset. A move down that ends inside the inset
         is that pin, and goes on to the true end; a move up is the reader's and is left alone. */
      let last = feed.scrollTop;
      const follow = () => { if (feed.scrollTop >= last && short() > 0.5 && short() <= pad + 4) feed.scrollTop = feed.scrollHeight; last = feed.scrollTop; };
      feed.addEventListener("scroll", follow, { passive: true });
      let tries = 0;
      let frame = requestAnimationFrame(function settle() { follow(); tries += 1; if (tries < 40) frame = requestAnimationFrame(settle); });
      return { feed, before, follow, stop: () => cancelAnimationFrame(frame) };
    });
    return () => { for (const { feed, before, follow, stop } of kept) { stop(); feed.removeEventListener("scroll", follow); feed.style.paddingBottom = before; } };
  }, [inset, shell, variant, side, free]);

  const hide = useCallback(() => {
    try { localStorage.setItem(HIDDEN_KEY, "1"); } catch { /* private mode */ }
    setMenu(false);
    setHidden(true);
  }, []);

  if (!shell || hidden) return <span data-mvf-hidden={hidden ? "" : undefined} data-mvf-mount={mount} hidden />;

  const rest = restingPlace(variant, shell, side, free);
  const at = drag ?? rest;
  const dropTarget = { width: DROP, height: DROP, x: (shell.width - DROP) / 2, y: shell.bottom - EDGE - DROP };
  const overDrop = variant === 2 && drag !== null && Math.hypot(at.x + HEAD / 2 - shell.width / 2, at.y + HEAD / 2 - (dropTarget.y + DROP / 2)) < DROP / 2 + 12;
  /* Over the place to hide, the head goes into it: lifting the finger there is the whole gesture. */
  const shown = overDrop ? { x: (shell.width - HEAD) / 2, y: dropTarget.y + (DROP - HEAD) / 2 } : at;
  const nearSide: Side = at.x + HEAD / 2 > shell.width / 2 ? "right" : "left";

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    held.current = { id: event.pointerId, dx: event.clientX - rest.x, dy: event.clientY - rest.y, x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const grip = held.current;
    if (!grip || grip.id !== event.pointerId) return;
    if (!grip.moved && Math.hypot(event.clientX - grip.x, event.clientY - grip.y) < DRAG_THRESHOLD) return;
    grip.moved = true;
    setMenu(false);
    setDrag({ x: Math.min(shell.width - HEAD - 2, Math.max(2, event.clientX - grip.dx)), y: Math.min(shell.height - HEAD - 2, Math.max(2, event.clientY - grip.dy)) });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const grip = held.current;
    if (!grip || grip.id !== event.pointerId) return;
    held.current = null;
    if (!grip.moved) return;
    swallow.current = true;
    setTimeout(() => { swallow.current = false; }, 0);
    setDrag(null);
    if (overDrop) { hide(); return; }
    setSide(nearSide);
    if (variant === 2) setFree(at.y);
  };

  const phaseLabel = t(`voiceCompanion.phase.${scene.phase}`);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const lowHalf = rest.y + HEAD / 2 > shell.height / 2;
  const showWords = scene.words && scene.phase === "speaking" && !drag && !menu;
  /* Beside the head (1, 3) there is one bubble of two lines; over the page (2) the newest and the one before it. */
  const riding = ridesSheet(variant, shell);
  const beside = variant !== 2 || riding;
  /* Under the bar the words' strip runs from the bar to the first gap between rows under the head. */
  const strip = variant === 3 && !riding;
  const laneWidth = shell.width - HEAD - EDGE * 3;
  const lane = beside
    ? { left: side === "right" ? EDGE : rest.x + HEAD + EDGE, top: rest.y + HEAD / 2 - BAND / 2, width: laneWidth, height: BAND, side: side === "right" ? "left" : "right", align: undefined, direction: "up" }
    : { left: EDGE, top: 0, width: shell.width - EDGE * 2, height: 0, side: "above", align: side === "right" ? "end" : "start", direction: lowHalf ? "up" : "down" };
  const pop = { left: side === "right" ? rest.x + HEAD - 236 : rest.x, top: lowHalf ? rest.y - 8 : rest.y + HEAD + 8, transform: lowHalf ? "translateY(-100%)" : undefined };
  const slots: Side[] = ["left", "right"];
  const slotPlace = (slot: Side) => restingPlace(variant, shell, slot, null);

  return (
    <section
      className="vc mvf"
      role="complementary"
      aria-label="Delegatus"
      data-mvf-root
      data-mvf-variant={variant}
      data-mvf-mount={mount}
      data-mvf-call-seconds={live ? seconds : undefined}
      data-phase={scene.phase}
      data-muted={scene.muted && live ? "" : undefined}
      data-dragging={drag ? "" : undefined}
      style={{ zIndex: shell.sheet ? LAYER.sheet + 1 : LAYER.dock, transform: "none", width: 0, height: 0 }}
    >
      <style>{VOICE_COMPANION_CSS}</style>
      <style>{CSS}</style>
      {drag && variant !== 2 ? slots.map((slot) => <span key={slot} className="mvf-slot" data-mvf-slot={slot} data-near={slot === nearSide ? "" : undefined} style={{ left: slotPlace(slot).x, top: slotPlace(slot).y }} />) : null}
      {drag && variant === 2 ? (
        <>
          {slots.map((slot) => <span key={slot} className="mvf-rail" data-mvf-rail={slot} data-near={slot === nearSide && !overDrop ? "" : undefined} style={{ left: slot === "left" ? 2 : shell.width - 6, top: shell.top + EDGE, height: shell.bottom - shell.top - EDGE * 2 }} />)}
          <span className="mvf-drop" data-mvf-drop data-over={overDrop ? "" : undefined} style={{ left: dropTarget.x, top: dropTarget.y }}>{overDrop ? null : <EyeOff size={22} aria-hidden />}</span>
          <span className="mvf-drop-word" data-mvf-drop-word style={{ left: shell.width / 2, top: dropTarget.y - 34 }}>{copy.dropToHide}</span>
        </>
      ) : null}
      {showWords && strip ? <WordsPlate kind="strip" left={0} width={shell.width} from={shell.top} grow="down" extent={rest.y + HEAD + EDGE - shell.top} /> : null}
      {showWords && beside ? (
        <div className="vc-lane mvf-lane" data-mvf-words data-fit="two" data-side={lane.side} data-direction={lane.direction}
          style={{ left: lane.left, top: lane.top, width: lane.width, height: lane.height, justifyContent: "center" }}>
          <p className="vc-bubble" data-speaker="companion" data-newest data-mvf-bubble><span className="vc-text">{copy.short}</span></p>
        </div>
      ) : null}
      {showWords && !beside ? (
        <WordsPlate kind="card" left={lane.left} width={lane.width} from={lowHalf ? rest.y - PLATE_GAP : rest.y + HEAD + PLATE_GAP} grow={lowHalf ? "up" : "down"}>
          <div className="vc-lane mvf-lane" data-mvf-words data-side={lane.side} data-align={lane.align} data-direction={lane.direction}>
            <p className="vc-bubble" data-speaker="companion" data-older data-mvf-bubble><span className="vc-text">{copy.older}</span></p>
            <p className="vc-bubble" data-speaker="companion" data-newest data-mvf-bubble><span className="vc-text">{copy.long}</span></p>
          </div>
        </WordsPlate>
      ) : null}
      <button
        type="button"
        className="vc-shape mvf-head"
        data-mvf-head
        aria-label={`Delegatus · ${phaseLabel}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        style={{ transform: `translate3d(${shown.x}px, ${shown.y}px, 0)` }}
        onClick={() => { if (!swallow.current) setMenu((open) => !open); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <CompanionCharacter ref={character} size={CHARACTER} />
        <span className="mvf-dot" data-mvf-dot aria-hidden />
      </button>
      {menu ? (
        <div className="mvf-pop" role="menu" aria-label="Delegatus" data-mvf-pop style={pop}>
          <p className="mvf-status" data-mvf-status><span className="vc-dot" aria-hidden /><b>{phaseLabel}</b>{live ? <span>· {clock}</span> : null}</p>
          {live ? (
            <>
              <button type="button" role="menuitem" className="mvf-row" data-mvf-mute onClick={() => setScene((value) => ({ ...value, muted: !value.muted }))}>
                {scene.muted ? <MicOff size={18} aria-hidden /> : <Mic size={18} aria-hidden />}{t(scene.muted ? "voiceCompanion.unmute" : "voiceCompanion.mute")}
              </button>
              <button type="button" role="menuitem" className="mvf-row" data-tone="danger" data-mvf-end onClick={() => { setScene((value) => ({ ...value, phase: "offline", words: false })); setMenu(false); }}>
                <PhoneOff size={18} aria-hidden />{t("voiceCompanion.end")}
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" className="mvf-row" data-tone="primary" data-mvf-talk onClick={() => { setScene((value) => ({ ...value, phase: "listening" })); setMenu(false); }}>
              <Mic size={17} aria-hidden />{t("voiceCompanion.talk")}
            </button>
          )}
          <button type="button" role="menuitem" className="mvf-row" data-mvf-hide onClick={hide}><EyeOff size={18} aria-hidden />{copy.hide}</button>
        </div>
      ) : null}
    </section>
  );
}

/** The harness mounts the variant the page's query names; no query, no head: the frame of today. */
export function PhoneVoicePrototype() {
  const variant = Number(new URLSearchParams(location.search).get("voice"));
  return variant === 1 || variant === 2 || variant === 3 ? <PhoneVoiceHead variant={variant} /> : null;
}
