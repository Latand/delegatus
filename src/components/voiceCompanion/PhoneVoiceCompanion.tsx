"use client";

import { AudioLines, EyeOff, MessageSquare, Mic, MicOff, PhoneOff, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { LAYER } from "@/components/layers";
import { useModalLayer } from "@/components/modalLayer";
import { useMobileNavStore } from "@/components/mobile/mobileNav";
import { createCompanionStore } from "@/hooks/useVoiceCompanion";
import { useLocale } from "@/lib/i18n";
import type { Locale, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import { companionErrorMessage } from "@/lib/voiceCompanion/errors";
import { BUBBLE_MAX_LINES, BUBBLE_MAX_WIDTH, bubbleChars } from "@/lib/voiceCompanion/placement";
import type { SessionTranscriptRecord } from "@/lib/voiceCompanion/transcriptRecord";

import { CompanionCharacter, type CharacterHandle } from "./CompanionCharacter";
import { awaitsReport, CompanionTranscript, transcriptLabels, TRANSCRIPT_CSS } from "./CompanionTranscript";
import { hidePhoneVoice, setPhoneVoiceSide, usePhoneVoice, type PhoneVoiceSide } from "./phoneVoiceStore";
import { bubblesOf, bubblesOut, NOTICE_LINGER_MS, SETTINGS_FAILURES } from "./VoiceCompanion";
import { PHONE_VOICE_CSS, VOICE_COMPANION_CSS } from "./voiceCompanionStyles";

/**
 * The voice companion on the phone (docs/design/phone-voice-head-build.md, the operator's variant 1 of
 * 2026-10-12): a round head that rests in a bottom corner above the composer or the dock, with its words
 * in one bubble of two lines beside it. The page keeps a band at the end of the conversation and of the
 * board's column, so the last row ends above the head; where the words lie over the page, the head and
 * its words stand on cleared page whose edges fall between whole messages or whole cards.
 *
 * Its state is a dot on the head and, on a tap, a short popover: Talk or the call's own controls, and
 * «Сховати», which hides the head; the host then unmounts it, and unmounting ends a call it holds. A
 * drag moves it to the other corner. It reads the same adapter and the same store as the desktop window
 * and starts nothing by being mounted: only Talk starts a call.
 */

const HEAD = 52;
const CHARACTER = 36;
const EDGE = 8;
/* The band kept at the end of a list for the head and its words: two lines of a bubble. */
const BAND = 60;
const POPOVER_WIDTH = 236;
const DRAG_THRESHOLD = 6;
/* How long the shell is read each frame after something moved it, so an entrance or the keyboard is followed to its end. */
const SETTLE_MS = 600;
/** The characters one phone bubble holds: two of the lines a bubble of the full width holds. */
export const PHONE_BUBBLE_CHARS = Math.round((bubbleChars(BUBBLE_MAX_WIDTH) * 2) / BUBBLE_MAX_LINES);

const TOPS = "[data-mobile2-bar], [data-mobile2-seat-card], [data-mobile2-seat-invitation], [data-phone-kanban-tabs]";
const BOTTOMS = "[data-mobile2-composer], [data-mobile2-dock], [data-mobile2-receipt]";
const SHEET = "[data-mobile2-sheet]";
const PANES = "[data-log-feed-scroller], [data-phone-kanban-column]";
/* What a change to the page must touch to move the head: the chrome, a sheet, a pane. */
const SHELL_PARTS = `${TOPS}, ${BOTTOMS}, ${SHEET}, ${PANES}`;
/* A message and a card are hidden whole or left whole by the cleared page. */
const ATOMIC = "[data-mobile-message], [data-phone-card-shell], [data-phone-kanban-more], [data-phone-kanban-unlinked]";

interface Box { x: number; y: number; width: number; height: number }
interface Pane { x: number; width: number; top: number; bottom: number; background: string }
interface Shell {
  width: number;
  height: number;
  top: number;
  /** The line the eye reads as the top of the composer or the dock. */
  bottom: number;
  sheet: Box | null;
  /** With a sheet that leaves no room above it: the line its footer starts at. */
  footer: number | null;
  pane: Pane | null;
  insetLeft: number;
  insetRight: number;
}

const box = (element: Element | null): Box | null => {
  if (!(element instanceof HTMLElement) || element.checkVisibility?.() === false) return null;
  const rect = element.getBoundingClientRect();
  return rect.width < 1 || rect.height < 1 ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
};

/**
 * The line the eye reads as the top of the bottom chrome. The dock draws it on its own box; the composer's field
 * sits a few pixels inside the pane's footer, and the divider is the footer's.
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

/** The scrolling panes on screen now: the conversation's feed, or the board's open column. */
function panes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(PANES)].filter((node) => {
    const frame = box(node);
    return frame !== null && frame.x > -1 && frame.x + frame.width < innerWidth + 1;
  });
}

/** The colour the page shows behind a pane's rows: its own background, or the first one behind it. */
function backgroundOf(node: Element | null): string {
  for (let at = node; at; at = at.parentElement) {
    const colour = getComputedStyle(at).backgroundColor;
    if (colour && colour !== "transparent" && !/rgba\([^)]*,\s*0\)$/u.test(colour)) return colour;
  }
  return "var(--color-canvas)";
}

function readShell(probe: HTMLElement | null): Shell {
  const width = innerWidth;
  const height = window.visualViewport?.height ?? innerHeight;
  const tops = [...document.querySelectorAll(TOPS)].flatMap((node) => box(node) ?? []);
  const bottoms = [...document.querySelectorAll(BOTTOMS)].flatMap((node) => (box(node) ? lineAbove(node) : []));
  /* The sheet on top is the last one mounted. */
  const sheetNode = [...document.querySelectorAll(SHEET)].filter((node) => box(node)).at(-1) ?? null;
  const sheet = box(sheetNode);
  const full = sheet !== null && sheet.y < EDGE + HEAD + 4;
  const body = full ? box(sheetNode!.querySelector("[data-mobile2-sheet-body]")) : null;
  const pane = panes().map((node) => ({ node, frame: box(node)! })).sort((a, b) => b.frame.height - a.frame.height)[0] ?? null;
  /* The side safe areas of a landscape phone, read off a probe sized by `env()`. */
  const edges = probe?.getBoundingClientRect();
  return {
    width, height, sheet,
    top: tops.length ? Math.max(...tops.map((rect) => rect.y + rect.height)) : 0,
    bottom: bottoms.length ? Math.min(...bottoms) : height,
    footer: full ? (body ? body.y + body.height : sheet!.y + sheet!.height) : null,
    pane: pane ? { x: pane.frame.x + pane.node.clientLeft, width: pane.node.clientWidth, top: pane.frame.y, bottom: pane.frame.y + pane.frame.height, background: backgroundOf(pane.node) } : null,
    insetLeft: edges ? edges.width : 0,
    insetRight: edges ? edges.height : 0,
  };
}

function restingPlace(shell: Shell, side: PhoneVoiceSide): { x: number; y: number } {
  const x = side === "right" ? shell.width - EDGE - HEAD - shell.insetRight : EDGE + shell.insetLeft;
  /* A sheet as tall as the screen leaves no strip above it: the head stands above its footer, so a call stays in view. */
  if (shell.footer !== null) return { x, y: Math.max(4, shell.footer - EDGE - HEAD) };
  /* Over an open sheet the head rides the dimmed strip above it, so it lies on nothing the sheet shows. */
  if (shell.sheet) return { x, y: Math.max(4, shell.sheet.y - EDGE - HEAD) };
  return { x, y: Math.max(shell.top + 4, shell.bottom - EDGE - HEAD) };
}

const frameOf = (run: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number));
const cancelFrame = (id: number) => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); clearTimeout(id); };

/**
 * The shell as it stands, read again when something can have moved it: the window or the keyboard, the phone's
 * navigation (screens and sheets), a part of the chrome that changed size, and a sheet, a pane or a part of the
 * chrome mounted or removed. Each runs reads on animation frames until the shell stops changing; nothing runs
 * while it stands still.
 */
function useShell(probe: React.RefObject<HTMLElement | null>, own: React.RefObject<HTMLElement | null>): Shell | null {
  const nav = useMobileNavStore();
  const [shell, setShell] = useState<Shell | null>(null);
  useLayoutEffect(() => {
    let last = "";
    let frame = 0;
    let quietSince = 0;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => burst()) : null;
    const observe = () => {
      if (!resize) return;
      resize.disconnect();
      for (const node of document.querySelectorAll(`${TOPS}, ${BOTTOMS}, ${SHEET}`)) resize.observe(node);
    };
    const read = () => {
      const next = readShell(probe.current);
      const key = JSON.stringify(next);
      if (key === last) return false;
      last = key;
      setShell(next);
      return true;
    };
    function burst() {
      quietSince = performance.now();
      if (frame) return;
      const step = () => {
        if (read()) { quietSince = performance.now(); observe(); }
        frame = performance.now() - quietSince < SETTLE_MS ? frameOf(step) : 0;
      };
      frame = frameOf(step);
    }
    read();
    observe();
    burst();
    const touches = (node: Node) => node instanceof Element && !own.current?.contains(node) && (node.matches(SHELL_PARTS) || node.querySelector(SHELL_PARTS) !== null);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(touches))) burst();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    const stopNav = nav.subscribe(burst);
    const viewport = window.visualViewport;
    window.addEventListener("resize", burst);
    viewport?.addEventListener("resize", burst);
    viewport?.addEventListener("scroll", burst);
    return () => {
      cancelFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      stopNav();
      window.removeEventListener("resize", burst);
      viewport?.removeEventListener("resize", burst);
      viewport?.removeEventListener("scroll", burst);
    };
  }, [nav, probe, own]);
  return shell;
}

interface Row { top: number; bottom: number }
/**
 * Every line of text, icon and control the panes show, and every message and card whole, as spans of height a plate's
 * edge must not cross. A line a clamped title or any other clipping ancestor cuts off is not on screen and is not a row:
 * its rectangle is cut to the clips between it and the pane, and text nobody sees (screen-reader only, hidden) adds none.
 */
function pageRows(): Row[] {
  const rows: Row[] = [];
  const range = document.createRange();
  const clips = new Map<Element, Box | null>();
  const clipOf = (node: Element): Box | null => {
    if (!clips.has(node)) {
      const style = getComputedStyle(node);
      clips.set(node, style.overflowX !== "visible" || style.overflowY !== "visible" ? box(node) : null);
    }
    return clips.get(node)!;
  };
  for (const pane of panes()) {
    const frame = box(pane)!;
    const add = (rect: DOMRect, within: Element) => {
      let top = Math.max(rect.top, frame.y), bottom = Math.min(rect.bottom, frame.y + frame.height);
      for (let parent: Element | null = within; parent && parent !== pane; parent = parent.parentElement) {
        const clip = clipOf(parent);
        if (clip) { top = Math.max(top, clip.y); bottom = Math.min(bottom, clip.y + clip.height); }
      }
      if (rect.width >= 1 && bottom - top >= 1) rows.push({ top, bottom });
    };
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || parent.closest(".sr-only, [hidden]")) continue;
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) add(line, parent);
    }
    for (const mark of pane.querySelectorAll("svg, img, button")) add(mark.getBoundingClientRect(), mark);
    for (const block of pane.querySelectorAll(ATOMIC)) add(block.getBoundingClientRect(), block);
  }
  return rows;
}
/** Moves an edge the given way until it stands between two rows. */
function between(rows: Row[], y: number, way: 1 | -1): number {
  let edge = y;
  for (let pass = 0; pass < 80; pass += 1) {
    const crossed = rows.find((row) => row.top - 1.5 < edge && edge < row.bottom + 1.5);
    if (!crossed) break;
    edge = way > 0 ? crossed.bottom + 2 : crossed.top - 2;
  }
  return edge;
}

/**
 * The cleared page the head and its words stand on: the pane's own colour, from 8 px above to 8 px below what it
 * holds, each edge moved outward to the nearest gap between rows, where a message or a card counts as one row. It
 * takes the touch, so no row under it is pressed unseen. Read again as the panes scroll.
 */
function ClearedPage({ pane, held }: { pane: Pane | null; held: Box[] }) {
  const [span, setSpan] = useState<{ top: number; height: number } | null>(null);
  const [, setScrolled] = useState(0);
  useEffect(() => {
    let frame = 0;
    const onScroll = () => { cancelFrame(frame); frame = frameOf(() => setScrolled((value) => value + 1)); };
    document.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("scroll", onScroll, true); cancelFrame(frame); };
  }, []);
  /* Read after every render: the rows move with the feed's scroll and its tail, and the guard ends the chain. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const parts = [...held, ...[...document.querySelectorAll("[data-phone-voice-bubble]")].flatMap((node) => box(node) ?? [])];
    const rows = pageRows();
    const top = Math.max(pane ? pane.top : 0, between(rows, Math.min(...parts.map((item) => item.y)) - EDGE, -1));
    const bottom = Math.min(pane ? pane.bottom : innerHeight, between(rows, Math.max(...parts.map((item) => item.y + item.height)) + EDGE, 1));
    const next = { top, height: Math.max(0, bottom - top) };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the span is read from the laid-out page, and the guard ends the chain
    setSpan((value) => (value && Math.abs(value.top - next.top) < 0.25 && Math.abs(value.height - next.height) < 0.25 ? value : next));
  });
  const across = pane ? { left: pane.x, width: pane.width } : { left: 0, width: innerWidth };
  return <div className="pvc-plate" data-phone-voice-plate style={{ ...across, top: span?.top ?? held[0]!.y, height: span?.height ?? 0, background: pane?.background, visibility: span ? undefined : "hidden" }} />;
}

/** A bubble's text with its last two words kept on one line, so the wrap never leaves one word alone at the end. */
const tied = (text: string) => (text.trim().split(/\s+/u).length > 2 ? text.replace(/\s+(\S+)$/u, " $1") : text);

/** The existing conversation panel, fitted to the phone and owned by the modal stack. */
function PhoneConversation({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useModalLayer({ containerRef: panel, onClose, manageFocus: false });
  useEffect(() => {
    const background: Array<{ node: HTMLElement; inert: boolean }> = [];
    for (let own: HTMLElement | null = panel.current; own?.parentElement; own = own.parentElement) {
      for (const sibling of own.parentElement.children) if (sibling !== own && sibling instanceof HTMLElement) {
        background.push({ node: sibling, inert: sibling.inert }); sibling.inert = true;
      }
    }
    return () => { for (const { node, inert } of background) node.inert = inert; };
  }, []);
  return <div ref={panel} className="pvc-conversation" data-phone-voice-conversation tabIndex={-1}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>{children}</div>;
}

export function PhoneVoiceCompanion({ adapter, project, locale: sessionLocale, seat, preflight, onOpenSettings }: {
  adapter: VoiceCompanionAdapter;
  /** The project of the screen on top; null on a view that shows none, where a conversation cannot start. */
  project: string | null;
  locale?: Locale;
  /** Whether the project has a designated orchestrator; unknown (undefined) says nothing. */
  seat?: boolean;
  /** A failure already known when the operator asks to talk (no key, the cap reached), said without the microphone. */
  preflight?: () => string | null;
  onOpenSettings?: () => void;
}) {
  const { t, locale } = useLocale();
  const [store] = useState(() => createCompanionStore(adapter));
  useEffect(() => store.connect(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const { side } = usePhoneVoice();
  const root = useRef<HTMLElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const character = useRef<CharacterHandle>(null);
  const shell = useShell(probe, root);
  const [menu, setMenu] = useState(false);
  const [reading, setReading] = useState(false);
  const [record, setRecord] = useState<SessionTranscriptRecord | null>(null);
  const [sessionSeen, setSessionSeen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const held = useRef<{ id: number; dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const swallow = useRef(false);
  /* A failure said in the bubble, for as long as the desktop lane keeps one. */
  const [notice, setNotice] = useState<{ key: string; code: string; resetsAt?: number | null } | null>(null);
  const refusals = useRef(0);
  const [paced, setPaced] = useState<{ key: string; out: number } | null>(null);
  const [callStart, setCallStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const connected = state.phase !== "offline";
  const live = connected || starting;
  if (live && !sessionSeen) setSessionSeen(true);
  /* A call the Viewer still offers after a reload has a record to read before any call starts here. */
  const readable = (sessionSeen || state.resumable !== null) && typeof adapter.transcript === "function";
  const waitingForReport = record !== null && awaitsReport(record);
  useEffect(() => {
    if (!reading || !adapter.transcript) return;
    let alive = true;
    const read = () => { void adapter.transcript!().then((next) => { if (alive && next) setRecord(next); }).catch(() => undefined); };
    read();
    if (!live && !waitingForReport) return () => { alive = false; };
    const timer = setInterval(read, 1_500);
    return () => { alive = false; clearInterval(timer); };
  }, [reading, adapter, live, waitingForReport]);
  const speechLocale: Locale = sessionLocale ?? (locale === "uk" ? "uk" : "en");

  /* The mouth, and how far the playing line's words have come at the nominal pace: one render per new piece. */
  useEffect(() => store.onLevel((current) => {
    character.current?.setLevel(current.mouth);
    const playing = current.playing && current.lines.find((line) => line.key === `companion:${current.playing!.itemId}`);
    if (!playing) return;
    const out = bubblesOut(playing, bubblesOf(playing, PHONE_BUBBLE_CHARS), current.playedMs);
    setPaced((shown) => (shown?.key === playing.key && shown.out === out ? shown : { key: playing.key, out }));
  }), [store]);
  const speaking = state.phase === "speaking";
  useEffect(() => { if (!speaking) character.current?.setLevel(0); }, [speaking]);

  /* The call's clock starts when the session is ready, and ticks only while the popover shows it. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock follows the session's phase
    setCallStart((at) => (connected ? at ?? Date.now() : null));
    if (!connected) setMuted(false);
  }, [connected]);
  useEffect(() => {
    if (!menu || !connected) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [menu, connected]);

  /* What the session says went wrong, once per failure, after the session asked for is ready. */
  const awaiting = store.awaiting();
  /* A dropped call is said as a drop, whatever failure ended it; a reconnect says the call goes on. */
  const sessionNotice = state.resumable && !awaiting ? { key: `drop:${state.resumable.sessionId}`, code: "CONNECTION_LOST" }
    : state.error && !awaiting ? { key: `error:${state.generation}:${state.error}`, code: state.error, resetsAt: state.errorResetsAt }
    : state.closure?.incomplete && state.usage?.backend !== "codex" && !awaiting ? { key: `closure:${state.generation}`, code: "FINALIZATION_INCOMPLETE" }
    : state.reconnected && connected && !awaiting ? { key: `restored:${state.generation}`, code: "CONNECTION_RESTORED" } : null;
  const seenNotice = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionNotice || seenNotice.current === sessionNotice.key) return;
    seenNotice.current = sessionNotice.key;
    setNotice(sessionNotice);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the failure itself
  }, [sessionNotice?.key]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice((current) => (current?.key === notice.key ? null : current)), NOTICE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /* The popover closes on a tap outside it and on Escape. */
  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    root.current?.querySelector<HTMLElement>("[data-phone-voice-pop] [role='menuitem']")?.focus();
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape); };
  }, [menu]);

  const rest = shell ? restingPlace(shell, side) : null;
  const sheetOpen = shell?.sheet !== null && shell?.sheet !== undefined;
  /* The band at the end of the feed and of the column, while no sheet lies over them. */
  const band = shell && rest && !sheetOpen ? Math.max(BAND, Math.ceil((shell.pane?.bottom ?? rest.y) - rest.y)) + EDGE * 2 : null;
  /* A list that stood at its end when the band came stays at its end; later rows are kept there by the feed's own pin. */
  const bandOn = band !== null;
  useLayoutEffect(() => {
    if (!bandOn || band === null) return;
    for (const pane of panes()) if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= band + 4) pane.scrollTop = pane.scrollHeight;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once each time the band appears
  }, [bandOn]);

  const talk = () => {
    setMenu(false);
    if (starting) return;
    const refusal = project === null ? "NO_PROJECT" : preflight?.() ?? null;
    if (refusal || project === null) { setNotice({ key: `refused:${(refusals.current += 1)}`, code: refusal ?? "NO_PROJECT" }); return; }
    setNotice(null);
    setMuted(false);
    setStarting(true);
    setReading(false); setRecord(null);
    /* A failed start is told by the adapter as an error event; the bubble says it. */
    void store.start({ locale: speechLocale, project }).catch(() => undefined).finally(() => setStarting(false));
  };
  /* The dropped call goes on as the same conversation, in the project on top, or its own when none is. */
  const resume = () => {
    setMenu(false);
    const call = state.resumable;
    if (starting || !call) return;
    const target = project ?? call.project;
    if (target === null) { setNotice({ key: `refused:${(refusals.current += 1)}`, code: "NO_PROJECT" }); return; }
    setNotice(null);
    setMuted(false);
    setStarting(true);
    setReading(false);
    void store.start({ locale: speechLocale, project: target, resume: call.sessionId }).catch(() => undefined).finally(() => setStarting(false));
  };
  const end = () => { setMenu(false); void store.stop().catch(() => undefined); };
  const toggleMute = () => { const next = !muted; setMuted(next); void store.command({ type: "mute", muted: next }).catch(() => undefined); };
  /* Hiding unmounts the head through the host, and the store's release ends a call it holds. */
  const hide = useCallback(() => { setMenu(false); hidePhoneVoice(); }, []);

  if (!shell || !rest) return <section ref={root} className="vc pvc" data-phone-voice data-phase={state.phase} aria-hidden style={{ visibility: "hidden" }}><span ref={probe} className="pvc-probe" /></section>;

  const at = drag ?? rest;
  const nearSide: PhoneVoiceSide = at.x + HEAD / 2 > shell.width / 2 ? "right" : "left";
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
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
    setPhoneVoiceSide(nearSide);
  };

  const phaseLabel = starting && !connected ? t("voiceCompanion.phase.connecting") : t(`voiceCompanion.phase.${state.phase}`);
  const seconds = callStart === null ? 0 : Math.max(0, Math.floor((now - callStart) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const lowHalf = rest.y + HEAD / 2 > shell.height / 2;
  /* What the bubble says: a failure while it lingers, else the piece of the playing line its audio has reached. */
  const playingLine = state.playing ? state.lines.find((line) => line.key === `companion:${state.playing!.itemId}`) : undefined;
  const pieces = playingLine ? bubblesOf(playingLine, PHONE_BUBBLE_CHARS) : [];
  const reached = playingLine ? (paced?.key === playingLine.key ? Math.max(1, paced.out) : bubblesOut(playingLine, pieces, state.playedMs)) : 0;
  const speech = speaking && reached > 0 ? pieces[Math.min(reached, pieces.length) - 1] ?? null : null;
  const said = notice ? companionErrorMessage(notice.code, speechLocale, { resetsAt: notice.resetsAt }) : speech;
  /* Over a sheet as tall as the screen the head says nothing: the call goes on and is heard. */
  const showWords = said !== null && !drag && !menu && shell.footer === null;
  const laneWidth = shell.width - HEAD - EDGE * 3 - shell.insetLeft - shell.insetRight;
  const lane = { left: side === "right" ? EDGE + shell.insetLeft : rest.x + HEAD + EDGE, top: rest.y + HEAD / 2 - BAND / 2, width: laneWidth, height: BAND, side: side === "right" ? "left" : "right" };
  const plate = showWords ? <ClearedPage pane={shell.pane} held={[{ ...rest, width: HEAD, height: HEAD }]} /> : null;
  const pop = { left: side === "right" ? rest.x + HEAD - POPOVER_WIDTH : rest.x, top: lowHalf ? rest.y - EDGE : rest.y + HEAD + EDGE, transform: lowHalf ? "translateY(-100%)" : undefined };
  const settingsFailure = notice !== null && SETTINGS_FAILURES.has(notice.code) && onOpenSettings;
  /* A live or starting call holds the microphone, so its sign stays above every layer a phone surface paints (the image
     preview, search, full-screen dialogs) and below only the toasts; with no call the head keeps the dock's place. */
  const sheetState = shell.footer !== null ? "full" : sheetOpen ? "open" : undefined;
  const closeConversation = () => { setReading(false); frameOf(() => root.current?.querySelector<HTMLElement>("[data-phone-voice-head]")?.focus()); };

  return (
    <>
      {sheetOpen && plate ? <div data-phone-voice-under style={{ position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: LAYER.sheet - 1 }}>{plate}</div> : null}
      <section
        ref={root}
        className="vc pvc"
        role="complementary"
        aria-label="Delegatus"
        data-phone-voice
        data-mode={adapter.mode}
        data-phase={state.phase}
        data-starting={starting ? "" : undefined}
        data-muted={muted && connected ? "" : undefined}
        data-dragging={drag ? "" : undefined}
        data-side={side}
        data-sheet={sheetState}
        data-call-start={callStart ?? undefined}
        style={{ zIndex: live || reading ? LAYER.overlay + 1 : sheetOpen ? LAYER.sheet + 1 : LAYER.dock, transform: "none", width: 0, height: 0 }}
      >
        <style>{VOICE_COMPANION_CSS}</style>
        <style>{PHONE_VOICE_CSS}</style>
        <style>{TRANSCRIPT_CSS}{`
          .pvc-conversation { position: fixed; left: 0; top: 0; width: 100vw; height: 100dvh; pointer-events: auto; background: #0006; }
          .pvc-conversation .vc-tr { background: var(--color-raised); }
          .pvc-conversation .vc-tr-close { width: 44px; height: 44px; }
          .pvc-conversation .vc-tr-copy { min-width: 36px; min-height: 36px; }
          .pvc-conversation .vc-tr-toggle { min-height: 44px; }
        `}</style>
        {/* The conversation's feed ends above the band: its tail is aligned on the blank space under its last row, which
            a padding would add to. The board's column keeps the band as room at its end. */}
        {band !== null ? <style>{`html [data-log-feed-scroller] { margin-bottom: ${band}px; } html [data-phone-kanban-column] { padding-bottom: ${band}px; }`}</style> : null}
        {/* A sheet as tall as the screen has the head standing over the end of its body: the body keeps the head's room (and
            the 8 px under it) at its end, so the last line scrolls clear of the head. */}
        {shell.footer !== null ? <style>{`html [data-mobile2-sheet] [data-mobile2-sheet-body] { padding-bottom: ${HEAD + EDGE}px; }`}</style> : null}
        <span ref={probe} className="pvc-probe" aria-hidden />
        {drag ? (["left", "right"] as const).map((slot) => {
          const place = restingPlace(shell, slot);
          return <span key={slot} className="pvc-slot" data-phone-voice-slot={slot} data-near={slot === nearSide ? "" : undefined} style={{ left: place.x, top: place.y }} />;
        }) : null}
        {sheetOpen ? null : plate}
        {showWords ? (
          <div className="vc-lane pvc-lane" data-phone-voice-words data-side={lane.side} aria-live="polite" style={{ left: lane.left, top: lane.top, width: lane.width, height: lane.height }}>
            <p className="vc-bubble" data-speaker="companion" data-newest data-tone={notice ? "notice" : undefined} data-phone-voice-bubble role={notice ? "alert" : undefined}>
              <span className="vc-text">{tied(said)}</span>
            </p>
          </div>
        ) : null}
        <button
          type="button"
          className="vc-shape pvc-head"
          data-phone-voice-head
          aria-label={`Delegatus · ${phaseLabel}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          style={{ transform: `translate3d(${at.x}px, ${at.y}px, 0)` }}
          onClick={() => { if (swallow.current) return; setNow(Date.now()); setMenu((open) => !open); }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <CompanionCharacter ref={character} size={CHARACTER} />
          <span className="pvc-dot" data-phone-voice-dot aria-hidden />
        </button>
        {menu ? (
          <div className="pvc-pop" role="menu" aria-label="Delegatus" data-phone-voice-pop style={pop}>
            <p className="pvc-status" data-phone-voice-status><span className="vc-dot" aria-hidden /><b>{phaseLabel}</b>{connected ? <span data-phone-voice-clock>· {clock}</span> : null}</p>
            {live ? (
              <>
                <button type="button" role="menuitem" className="pvc-row" data-phone-voice-mute disabled={!connected} onClick={toggleMute}>
                  {muted ? <MicOff size={18} aria-hidden /> : <Mic size={18} aria-hidden />}{t(muted ? "voiceCompanion.unmute" : "voiceCompanion.mute")}
                </button>
                <button type="button" role="menuitem" className="pvc-row" data-tone="danger" data-phone-voice-end onClick={end}>
                  <PhoneOff size={18} aria-hidden />{t("voiceCompanion.end")}
                </button>
              </>
            ) : (
              <>
                {state.resumable ? (
                  <button type="button" role="menuitem" className="pvc-row" data-tone="primary" data-phone-voice-resume onClick={resume}>
                    <RotateCcw size={17} aria-hidden />{t("voiceCompanion.reconnect")}
                  </button>
                ) : null}
                <button type="button" role="menuitem" className="pvc-row" data-tone={state.resumable ? undefined : "primary"} data-phone-voice-talk onClick={talk}>
                  <Mic size={17} aria-hidden />{t("voiceCompanion.talk")}
                </button>
              </>
            )}
            {settingsFailure ? (
              <button type="button" role="menuitem" className="pvc-row" data-phone-voice-settings onClick={() => { setMenu(false); onOpenSettings(); }}>
                <AudioLines size={18} aria-hidden />{t("voiceCompanion.settings.label")}
              </button>
            ) : null}
            {readable ? <button type="button" role="menuitem" className="pvc-row" data-phone-voice-transcript
              onClick={() => { setMenu(false); setReading(true); }}><MessageSquare size={18} aria-hidden />{transcriptLabels(locale).title}</button> : null}
            <button type="button" role="menuitem" className="pvc-row" data-phone-voice-hide onClick={hide}><EyeOff size={18} aria-hidden />{t("voiceCompanion.hide")}</button>
          </div>
        ) : null}
        {reading ? <PhoneConversation onClose={closeConversation}>
          <CompanionTranscript modal record={record ?? { entries: [], truncated: false }} usage={state.usage ?? undefined}
            left={EDGE + shell.insetLeft} top={Math.max(EDGE, shell.top + EDGE)} width={shell.width - 2 * EDGE - shell.insetLeft - shell.insetRight}
            height={Math.max(120, shell.height - Math.max(EDGE, shell.top + EDGE) - EDGE)} onClose={closeConversation} />
        </PhoneConversation> : null}
        {seat === false && connected ? <span className="vc-sr" role="status">{companionErrorMessage("no_orchestrator", speechLocale)}</span> : null}
      </section>
    </>
  );
}
