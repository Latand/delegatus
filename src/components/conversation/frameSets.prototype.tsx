"use client";

/*
 * Design prototype (docs/design/frame-sets.md): how the operator opens a set
 * of prototypes and screenshots an agent published, from the conversation.
 * Only the conversation evidence fixture mounts this
 * (`?case=frame-sets&variant=0|1|2|3|4`); no product file imports it.
 *
 * The pane is the production one: `BranchPane` on the desktop, and on the
 * phone `BranchPane` inside `MobileShell`. The set arrives the way the build
 * would deliver it: as the feed row of the Delegatus tool call that published
 * it. That row has no presentation for this tool today, so `variant=0` leaves
 * it as it is and the other variants draw their entry inside the same row,
 * which is what the build would replace with a card in `McpCallCard`.
 *
 * Every frame is drawn on a canvas when the page loads. Nothing here reads a
 * file, and every name and sentence is invented.
 */

import { Images } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { BranchPane } from "@/components/BranchPane";
import { ImageGalleryProvider, Lightbox, type GalleryImage } from "@/components/feed/Lightbox";
import { ChevronLeft, ChevronRight, X } from "@/components/icons";
import { Z } from "@/components/layers";
import { MobileConversationMenu } from "@/components/mobile/MobileConversationMenu";
import { MobileBarTitle, MobileShell } from "@/components/mobile/MobileShell";
import { appendComposerDraft } from "@/components/TmuxComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useOverlayEscape } from "@/hooks/useOverlayEscape";
import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import {
  chosenReply,
  frameAtView,
  framesOfVariant,
  setCounts,
  stepIndex,
  swipeDirection,
  viewsOf,
  type Frame,
  type FrameSet,
} from "./frameSets.prototype.model";

export type FrameSetVariant = 0 | 1 | 2 | 3 | 4;
type Lang = "en" | "uk";

const COPY = {
  en: {
    variants: ["Today's pane: the tool row as it is", "Expands in place", "Full-screen viewer", "Two side by side", "Collage that zooms"],
    open: (title: string) => `Show the frames: ${title}`,
    choose: (n: number) => `Choose ${n}`,
    chooseAria: (n: number) => `Choose variant ${n}: put the answer into the message field`,
    variant: (n: number, title: string) => `Variant ${n}: ${title}`,
    zoom: "Open this frame full screen",
    close: "Close",
    previous: "Previous frame",
    next: "Next frame",
    left: "Left",
    right: "Right",
    title: "Orchestrator",
    working: "waiting for you",
    reports: "Report log",
    views: { 1440: "desktop 1440", 440: "board pane 440", 390: "phone 390" } as Record<number, string>,
    setTitle: "Step between my own messages",
    variantTitles: ["In the header", "A row above the message field", "In the message field's own row", "Keys and menu rows"],
  },
  uk: {
    variants: ["Сьогоднішня панель: рядок інструмента як є", "Розгортається на місці", "Повноекранний перегляд", "Два поруч", "Колаж зі збільшенням"],
    open: (title: string) => `Показати кадри: ${title}`,
    choose: (n: number) => `Обрати ${n}`,
    chooseAria: (n: number) => `Обрати варіант ${n}: вставити відповідь у поле повідомлення`,
    variant: (n: number, title: string) => `Варіант ${n}: ${title}`,
    zoom: "Відкрити цей кадр на весь екран",
    close: "Закрити",
    previous: "Попередній кадр",
    next: "Наступний кадр",
    left: "Ліворуч",
    right: "Праворуч",
    title: "Оркестратор",
    working: "чекає на вас",
    reports: "Журнал звітів",
    views: { 1440: "десктоп 1440", 440: "панель дошки 440", 390: "телефон 390" } as Record<number, string>,
    setTitle: "Кроки між моїми повідомленнями",
    variantTitles: ["У шапці", "Рядок над полем повідомлення", "У рядку самого поля повідомлення", "Клавіші та рядки меню"],
  },
} as const;
type Copy = (typeof COPY)[Lang];

/* ── The synthetic set ──────────────────────────────────────────────────── */

const VIEWS = [
  { width: 1440, height: 900 },
  { width: 440, height: 800 },
  { width: 390, height: 844 },
] as const;
const FRAME_LANGS = ["en", "uk"] as const;
export const FRAME_SET_FIXTURE_VARIANTS = 4;
export const FRAME_SET_FIXTURE_FRAMES = FRAME_SET_FIXTURE_VARIANTS * VIEWS.length * FRAME_LANGS.length;

/** A wireframe of a conversation pane with the variant's control where that
    variant puts it, the variant number printed in the corner. */
function drawFrame(variant: number, width: number, height: number, label: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  const unit = Math.max(1, Math.round(Math.min(width, 900) / 90));
  const pad = unit * 3;
  const accent = "#f0a23b";
  const bar = (x: number, y: number, w: number, h: number, fill: string) => {
    context.fillStyle = fill;
    context.beginPath();
    context.roundRect(x, y, w, h, Math.min(h / 2, unit * 1.2));
    context.fill();
  };
  context.fillStyle = "#0f1420";
  context.fillRect(0, 0, width, height);
  /* Header: a title, three buttons on the right. */
  const head = unit * 9;
  context.fillStyle = "#18202f";
  context.fillRect(0, 0, width, head);
  bar(pad + unit * 11, head / 2 - unit, Math.min(width * 0.3, unit * 40), unit * 2, "#3a465c");
  for (let button = 0; button < 3; button += 1) bar(width - pad - (button + 1) * unit * 6, head / 2 - unit * 2, unit * 4, unit * 4, "#2a3447");
  /* Composer at the bottom. */
  const composer = unit * 13;
  const composerTop = height - composer - pad;
  bar(pad, composerTop, width - pad * 2, composer, "#18202f");
  bar(pad * 2, composerTop + unit * 3, Math.min(width * 0.4, unit * 44), unit * 2, "#3a465c");
  bar(width - pad * 2 - unit * 5, composerTop + composer - unit * 6, unit * 5, unit * 4, "#34518f");
  /* The feed: an own message on the right, the answer's lines on the left. */
  const strip = variant === 2 ? unit * 6 : 0;
  const feedBottom = composerTop - pad - strip;
  let y = head + pad;
  for (let turn = 0; y < feedBottom - unit * 16; turn += 1) {
    const own = Math.min(width * 0.5, unit * (34 + (turn % 3) * 8));
    bar(width - pad - own, y, own, unit * 5, "#2b4a8f");
    y += unit * 8;
    for (let line = 0; line < 3 && y < feedBottom - unit * 3; line += 1) {
      bar(pad, y, Math.min(width - pad * 2, unit * (60 - line * 11 + (turn % 2) * 6)) * (width < 600 ? 0.62 : 1), unit * 2, "#263043");
      y += unit * 3.5;
    }
    y += unit * 3;
  }
  /* The variant's control. */
  const trio = (x: number, top: number) => {
    bar(x, top, unit * 4, unit * 4, accent);
    bar(x + unit * 5, top + unit, unit * 6, unit * 2, accent);
    bar(x + unit * 12, top, unit * 4, unit * 4, accent);
  };
  if (variant === 1) trio(pad + unit * 11 + Math.min(width * 0.3, unit * 40) + unit * 2, head / 2 - unit * 2);
  if (variant === 2) {
    bar(pad, feedBottom + unit, width - pad * 2, strip - unit * 2, "#141b29");
    trio(width / 2 - unit * 8, feedBottom + unit);
  }
  if (variant === 3) trio(pad * 2, composerTop + composer - unit * 6);
  if (variant === 4) bar(pad + unit * 11 + Math.min(width * 0.3, unit * 40) + unit * 2, head / 2 - unit, unit * 7, unit * 2, accent);
  /* The number, printed on the frame as the operator asked of every prototype. */
  const badge = unit * 8;
  bar(pad, head / 2 - badge / 2, badge, badge, accent);
  context.fillStyle = "#10141d";
  context.font = `900 ${Math.round(badge * 0.8)}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(variant), pad + badge / 2, head / 2 + badge * 0.04);
  context.textAlign = "left";
  context.fillStyle = "#93a0b8";
  context.font = `600 ${unit * 2}px sans-serif`;
  context.fillText(label, pad, height - pad / 2);
  return canvas.toDataURL("image/png");
}

/** Four variants, each at three widths in two languages: twenty-four frames. */
export function fixtureFrameSet(lang: Lang): FrameSet {
  const copy = COPY[lang];
  const frames: Frame[] = [];
  for (let variant = 1; variant <= FRAME_SET_FIXTURE_VARIANTS; variant += 1) {
    for (const view of VIEWS) for (const frameLang of FRAME_LANGS) {
      const caption = `${copy.views[view.width]} · ${frameLang}`;
      const src = drawFrame(variant, view.width, view.height, `${view.width} px · ${frameLang}`);
      frames.push({
        id: `fixture-${variant}-${view.width}-${frameLang}`, variant, caption, width: view.width, lang: frameLang,
        w: view.width, h: view.height, bytes: Math.round((src.length * 3) / 4), src,
      });
    }
  }
  return {
    id: "fs_fixture_own_steps",
    title: copy.setTitle,
    source: { conversationId: "conversation_fixture_design_lane", pipelineId: "pipeline_fixture", stageId: "design", commit: "0000000" },
    createdAt: "2026-10-05T09:40:00.000Z",
    variants: copy.variantTitles.map((title, index) => ({ number: index + 1, title })),
    frames,
  };
}

/* ── Shared pieces ──────────────────────────────────────────────────────── */

const noop = () => undefined;
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

interface Presenter {
  set: FrameSet;
  copy: Copy;
  lang: Lang;
  phone: boolean;
  choose: (variant: number) => void;
}

const frameCaption = (presenter: Presenter, frame: Frame) =>
  frame.variant === null ? frame.caption : `${frame.variant} · ${presenter.set.variants.find((entry) => entry.number === frame.variant)?.title ?? ""} · ${frame.caption}`;

/** A sideways swipe over an element steps; the click that ends it is swallowed. */
function useSwipe(onStep: (direction: -1 | 1) => void) {
  const from = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  return {
    onPointerDown: (event: ReactPointerEvent) => { from.current = { x: event.clientX, y: event.clientY }; swiped.current = false; },
    onPointerUp: (event: ReactPointerEvent) => {
      const start = from.current;
      from.current = null;
      if (!start) return;
      const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
      if (direction === 0) return;
      swiped.current = true;
      onStep(direction);
    },
    onPointerCancel: () => { from.current = null; },
    onClickCapture: (event: React.MouseEvent) => {
      if (!swiped.current) return;
      swiped.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/** The feed's own full-screen viewer over a list of frames. The viewer has no
    swipe today; while it is open a sideways touch steps it through its own
    edge buttons, which is the one addition every variant asks of it. */
function Zoom({ presenter, frames, start, onClose }: { presenter: Presenter; frames: readonly Frame[]; start: number; onClose: () => void }) {
  const gallery = useMemo<GalleryImage[]>(
    () => frames.map((frame) => ({ src: frame.src, alt: frameCaption(presenter, frame), caption: frameCaption(presenter, frame) })),
    [frames, presenter],
  );
  useEffect(() => {
    let from: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => { from = event.pointerType === "touch" ? { x: event.clientX, y: event.clientY } : null; };
    const up = (event: PointerEvent) => {
      const startAt = from;
      from = null;
      if (!startAt) return;
      const direction = swipeDirection(event.clientX - startAt.x, event.clientY - startAt.y);
      if (direction !== 0) document.querySelector<HTMLElement>(`[data-lightbox-step="${direction > 0 ? "next" : "previous"}"]`)?.click();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("pointerup", up, true); };
  }, []);
  const opened = gallery[start]!;
  return (
    <ImageGalleryProvider value={() => gallery}>
      <Lightbox src={opened.src} alt={opened.alt} caption={opened.caption} onClose={onClose} />
    </ImageGalleryProvider>
  );
}

function VariantTabs({ presenter, selected, onSelect, name, dark = false }: {
  presenter: Presenter;
  selected: number;
  onSelect: (variant: number) => void;
  /** Tells two tab rows apart in a compare. */
  name: string;
  dark?: boolean;
}) {
  const idle = dark ? "border-white/25 text-white/80 hover:bg-white/15" : "border-border text-secondary hover:border-accent/45 hover:text-accent";
  const on = dark ? "border-accent bg-accent text-black" : "border-accent bg-accent/15 text-accent";
  return (
    <span role="group" className="inline-flex shrink-0 items-center gap-1">
      {presenter.set.variants.map((variant) => (
        <button
          key={variant.number}
          type="button"
          data-frame-control={`${name}-${variant.number}`}
          aria-pressed={variant.number === selected}
          aria-label={presenter.copy.variant(variant.number, variant.title)}
          title={presenter.copy.variant(variant.number, variant.title)}
          onClick={() => onSelect(variant.number)}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-control border text-ui font-bold tabular-nums pointer-coarse:h-11 pointer-coarse:w-11 ${FOCUS} ${variant.number === selected ? on : idle}`}
        >
          {variant.number}
        </button>
      ))}
    </span>
  );
}

function ChooseButton({ presenter, variant, name = "choose", dark = false }: { presenter: Presenter; variant: number; name?: string; dark?: boolean }) {
  return (
    <button
      type="button"
      data-frame-control={name}
      aria-label={presenter.copy.chooseAria(variant)}
      title={presenter.copy.chooseAria(variant)}
      onClick={() => presenter.choose(variant)}
      className={`inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-control border px-2.5 text-label font-semibold pointer-coarse:h-11 pointer-coarse:px-3 ${FOCUS} ${
        dark ? "border-white/30 bg-white/10 text-white hover:bg-white/20" : "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20"
      }`}
    >
      {presenter.copy.choose(variant)}
    </button>
  );
}

function Filmstrip({ presenter, frames, index, onSelect, dark = false }: { presenter: Presenter; frames: readonly Frame[]; index: number; onSelect: (index: number) => void; dark?: boolean }) {
  const strip = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    /* Sideways only: the strip never moves the feed it sits in. */
    const box = strip.current;
    const thumb = box?.querySelector<HTMLElement>(`[data-frame-control="thumb-${index}"]`);
    if (!box || !thumb) return;
    const left = thumb.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (left + thumb.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left + thumb.offsetWidth - box.clientWidth;
  }, [index]);
  return (
    <div ref={strip} data-frame-filmstrip className="flex min-w-0 shrink-0 gap-1.5 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {frames.map((frame, at) => (
        <button
          key={frame.id}
          type="button"
          data-frame-control={`thumb-${at}`}
          aria-current={at === index}
          aria-label={frameCaption(presenter, frame)}
          title={frameCaption(presenter, frame)}
          onClick={() => onSelect(at)}
          className={`flex h-14 min-w-11 shrink-0 items-center justify-center overflow-hidden rounded-control border-2 bg-black/20 ${FOCUS} ${at === index ? "border-accent" : dark ? "border-white/20 opacity-70 hover:opacity-100" : "border-border opacity-70 hover:opacity-100"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a frame drawn in the page */}
          <img src={frame.src} alt="" draggable={false} className="h-full w-auto" />
        </button>
      ))}
    </div>
  );
}

/** ←/→ step and a digit picks a variant while `active`; a text field keeps its keys. */
function usePresenterKeys(active: boolean, onStep: (direction: -1 | 1) => void, onVariant: (variant: number) => void, variants: number) {
  const live = useRef({ onStep, onVariant });
  useEffect(() => { live.current = { onStep, onVariant }; });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (document.querySelector("[data-lightbox-position], [data-lightbox-caption]")) return;
      const digit = Number(event.key);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") live.current.onStep(event.key === "ArrowRight" ? 1 : -1);
      else if (Number.isInteger(digit) && digit >= 1 && digit <= variants) live.current.onVariant(digit);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, variants]);
}

interface Position { variant: number; index: number }

/* ── Variant 1: the row expands in place ────────────────────────────────── */

function InlinePanel({ presenter, position, setPosition }: { presenter: Presenter; position: Position; setPosition: (next: Position) => void }) {
  const frames = framesOfVariant(presenter.set, position.variant);
  const frame = frames[position.index]!;
  const [zoom, setZoom] = useState(false);
  const step = (direction: -1 | 1) => setPosition({ ...position, index: stepIndex(position.index, direction, frames.length) });
  const swipe = useSwipe(step);
  usePresenterKeys(!zoom, step, (variant) => setPosition({ variant, index: 0 }), presenter.set.variants.length);
  return (
    <div data-frame-panel="inline" className="mt-1.5 flex min-w-0 flex-col gap-1.5 rounded-surface border border-border bg-card p-2">
      <div className="flex min-w-0 items-center gap-2">
        <VariantTabs presenter={presenter} name="tab" selected={position.variant} onSelect={(variant) => setPosition({ variant, index: 0 })} />
        <span className="ml-auto" />
        <ChooseButton presenter={presenter} variant={position.variant} />
      </div>
      <div data-frame-caption className="flex min-w-0 items-baseline gap-2 text-label text-muted">
        <span className="min-w-0 truncate">{frameCaption(presenter, frame)}</span>
        <span data-frame-position className="ml-auto shrink-0 tabular-nums">{position.index + 1} / {frames.length}</span>
      </div>
      <button
        type="button"
        data-frame-control="stage"
        aria-label={presenter.copy.zoom}
        title={presenter.copy.zoom}
        onClick={() => setZoom(true)}
        {...swipe}
        className={`flex min-w-0 touch-pan-y cursor-zoom-in items-center justify-center rounded-control bg-sunken ${FOCUS}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a frame drawn in the page */}
        <img data-frame-shown={frame.id} src={frame.src} alt={frameCaption(presenter, frame)} draggable={false} className="max-h-[min(40dvh,380px)] max-w-full select-none object-contain" />
      </button>
      <Filmstrip presenter={presenter} frames={frames} index={position.index} onSelect={(index) => setPosition({ ...position, index })} />
      {zoom ? <Zoom presenter={presenter} frames={frames} start={position.index} onClose={() => setZoom(false)} /> : null}
    </div>
  );
}

/* ── Variant 2: a full-screen viewer with tabs and a filmstrip ──────────── */

const DARK_TOOL = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-white/25 bg-white/10 text-white hover:bg-white/20 pointer-coarse:h-11 pointer-coarse:w-11 ${FOCUS}`;
const EDGE = `absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-control border border-white/25 bg-black/40 text-white hover:bg-white/20 ${FOCUS}`;

function ViewerPanel({ presenter, position, setPosition, onClose }: { presenter: Presenter; position: Position; setPosition: (next: Position) => void; onClose: () => void }) {
  const frames = framesOfVariant(presenter.set, position.variant);
  const frame = frames[position.index]!;
  const step = (direction: -1 | 1) => setPosition({ ...position, index: stepIndex(position.index, direction, frames.length) });
  const swipe = useSwipe(step);
  useOverlayEscape(onClose);
  usePresenterKeys(true, step, (variant) => setPosition({ variant, index: 0 }), presenter.set.variants.length);
  return createPortal(
    <div data-frame-panel="viewer" role="dialog" aria-modal="true" aria-label={presenter.set.title} className={`fixed inset-0 ${Z.overlay} flex flex-col bg-black/90 text-white backdrop-blur-md`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <VariantTabs presenter={presenter} name="tab" selected={position.variant} onSelect={(variant) => setPosition({ variant, index: 0 })} dark />
        <span data-frame-caption className="order-last flex min-w-0 basis-full items-baseline gap-2 text-label text-white/75 sm:order-none sm:flex-1 sm:basis-0">
          <span className="min-w-0 truncate">{frameCaption(presenter, frame)}</span>
          <span data-frame-position className="shrink-0 tabular-nums">{position.index + 1} / {frames.length}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <ChooseButton presenter={presenter} variant={position.variant} dark />
          <button type="button" data-frame-control="close" aria-label={presenter.copy.close} onClick={onClose} className={DARK_TOOL}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </span>
      </div>
      <div data-frame-stage className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center px-2" {...swipe}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a frame drawn in the page */}
        <img data-frame-shown={frame.id} src={frame.src} alt={frameCaption(presenter, frame)} draggable={false} className="max-h-full max-w-full select-none object-contain" />
        {position.index > 0 ? (
          <button type="button" data-frame-control="previous" aria-label={presenter.copy.previous} onClick={() => step(-1)} className={`${EDGE} left-2`}>
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
        {position.index < frames.length - 1 ? (
          <button type="button" data-frame-control="next" aria-label={presenter.copy.next} onClick={() => step(1)} className={`${EDGE} right-2`}>
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="flex min-w-0 justify-center px-3 pb-2">
        <Filmstrip presenter={presenter} frames={frames} index={position.index} onSelect={(index) => setPosition({ ...position, index })} dark />
      </div>
    </div>,
    document.body,
  );
}

/* ── Variant 3: two variants side by side at the same width and language ── */

function ComparePanel({ presenter, onClose, onState }: { presenter: Presenter; onClose: () => void; onState: (state: { left: number; right: number; view: number }) => void }) {
  const views = useMemo(() => viewsOf(presenter.set), [presenter.set]);
  const [sides, setSides] = useState({ left: 1, right: Math.min(2, presenter.set.variants.length) });
  const [view, setView] = useState(0);
  const step = (direction: -1 | 1) => setView((current) => stepIndex(current, direction, views.length));
  const swipe = useSwipe(step);
  useOverlayEscape(onClose);
  usePresenterKeys(true, step, noop, 0);
  useEffect(() => { onState({ ...sides, view }); }, [sides, view, onState]);
  const key = views[view]!.key;
  const column = (side: "left" | "right") => {
    const frame = frameAtView(presenter.set, sides[side], key);
    return (
      <div data-frame-side={side} className="flex min-h-0 min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <VariantTabs presenter={presenter} name={`${side}-tab`} selected={sides[side]} onSelect={(variant) => setSides((current) => ({ ...current, [side]: variant }))} dark />
          <span className="ml-auto" />
          <ChooseButton presenter={presenter} variant={sides[side]} name={`choose-${side}`} dark />
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {frame ? (
            /* eslint-disable-next-line @next/next/no-img-element -- a frame drawn in the page */
            <img data-frame-shown={frame.id} src={frame.src} alt={frameCaption(presenter, frame)} draggable={false} className="max-h-full max-w-full select-none object-contain" />
          ) : null}
        </div>
      </div>
    );
  };
  return createPortal(
    <div data-frame-panel="compare" role="dialog" aria-modal="true" aria-label={presenter.set.title} className={`fixed inset-0 ${Z.overlay} flex flex-col bg-black/90 text-white backdrop-blur-md`}>
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <span data-frame-caption className="flex min-w-0 flex-1 items-baseline gap-2 text-label text-white/75">
          <span className="min-w-0 truncate">{presenter.set.title}</span>
          <span data-frame-position className="shrink-0 tabular-nums">{view + 1} / {views.length}</span>
        </span>
        <button type="button" data-frame-control="close" aria-label={presenter.copy.close} onClick={onClose} className={DARK_TOOL}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div data-frame-stage className="grid min-h-0 flex-1 touch-pan-y grid-cols-1 grid-rows-2 gap-2 px-3 sm:grid-cols-2 sm:grid-rows-1" {...swipe}>
        {column("left")}
        {column("right")}
      </div>
      <div data-frame-filmstrip className="flex min-w-0 shrink-0 gap-1.5 overflow-x-auto px-3 py-2 [scrollbar-width:none] sm:justify-center [&::-webkit-scrollbar]:hidden">
        {views.map((entry, at) => (
          <button
            key={entry.key}
            type="button"
            data-frame-control={`view-${at}`}
            aria-current={at === view}
            onClick={() => setView(at)}
            className={`inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-control border px-2.5 text-label font-semibold pointer-coarse:h-11 ${FOCUS} ${at === view ? "border-accent bg-accent text-black" : "border-white/25 text-white/80 hover:bg-white/15"}`}
          >
            {entry.width !== null ? presenter.copy.views[entry.width] ?? `${entry.width}` : ""} · {entry.lang}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ── Variant 4: the whole set as a collage; a tile opens the feed's viewer ─ */

function CollagePanel({ presenter, onZoomed }: { presenter: Presenter; onZoomed: (index: number | null) => void }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const open = (index: number | null) => { setZoom(index); onZoomed(index); };
  return (
    <div data-frame-panel="collage" className="mt-1.5 flex min-w-0 flex-col gap-2.5 rounded-surface border border-border bg-card p-2">
      {presenter.set.variants.map((variant) => (
        <section key={variant.number} data-frame-collage-variant={variant.number} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-control bg-accent/15 px-1 text-ui font-bold tabular-nums text-accent">{variant.number}</span>
            <span className="min-w-0 truncate text-ui font-semibold text-primary">{variant.title}</span>
            <span className="ml-auto" />
            <ChooseButton presenter={presenter} variant={variant.number} name={`choose-${variant.number}`} />
          </div>
          <div className="grid min-w-0 gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(92px,1fr))]">
            {presenter.set.frames.map((frame, index) => frame.variant !== variant.number ? null : (
              <button
                key={frame.id}
                type="button"
                data-frame-control={`tile-${index}`}
                aria-label={frameCaption(presenter, frame)}
                title={frameCaption(presenter, frame)}
                onClick={() => open(index)}
                className={`flex h-[84px] min-w-0 cursor-zoom-in items-center justify-center overflow-hidden rounded-control border border-border bg-sunken ${FOCUS}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a frame drawn in the page */}
                <img src={frame.src} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
              </button>
            ))}
          </div>
        </section>
      ))}
      {zoom !== null ? <Zoom presenter={presenter} frames={presenter.set.frames} start={zoom} onClose={() => open(null)} /> : null}
    </div>
  );
}

/* ── The entry: one row, inside the feed row of the publishing tool call ── */

function Entry({ presenter, variant, onState }: { presenter: Presenter; variant: Exclude<FrameSetVariant, 0>; onState: (state: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>({ variant: 1, index: 0 });
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const inPlace = variant === 1 || variant === 4;
  const entry = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => { setOpen(false); entry.current?.focus(); }, []);
  /* A full-screen surface gets out of the way of the reply it just wrote. */
  useEffect(() => {
    if (inPlace) return;
    const onChosen = () => setOpen(false);
    window.addEventListener("frame-set-chosen", onChosen);
    return () => window.removeEventListener("frame-set-chosen", onChosen);
  }, [inPlace]);
  useEffect(() => { onState({ open, ...position, ...extra }); }, [open, position, extra, onState]);
  /* Opened in place, the row goes to the top of the feed so what it opened is
     under it. The feed follows its own tail otherwise and would carry the row
     out of sight; the move is announced the way a reader's wheel is, which is
     what the feed's own functions do in the build. */
  useEffect(() => {
    if (!open || !inPlace) return;
    const scroller = entry.current?.closest<HTMLElement>("[data-log-feed-scroller]");
    if (!scroller) return;
    const move = () => {
      const row = entry.current;
      if (!row) return;
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      scroller.scrollTop = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    };
    const frame = requestAnimationFrame(move);
    const timer = window.setTimeout(move, 160);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [open, inPlace]);
  const compareState = useCallback((state: { left: number; right: number; view: number }) => setExtra(state), []);
  const zoomed = useCallback((index: number | null) => setExtra({ zoomed: index }), []);
  return (
    <div data-frame-set={presenter.set.id} className="my-1 min-w-0">
      <button
        ref={entry}
        type="button"
        data-frame-control="entry"
        aria-expanded={open}
        aria-label={presenter.copy.open(presenter.set.title)}
        title={presenter.copy.open(presenter.set.title)}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-control border border-border bg-card px-2.5 text-left text-ui hover:border-accent/45 pointer-coarse:h-11 ${FOCUS}`}
      >
        <Images className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 truncate font-semibold text-primary">{presenter.set.title}</span>
        <span className="shrink-0 whitespace-nowrap text-label tabular-nums text-muted">{setCounts(presenter.set, presenter.lang)}</span>
        <ChevronRight className={`ml-auto h-4 w-4 shrink-0 text-muted transition-transform ${open && inPlace ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {open && variant === 1 ? <InlinePanel presenter={presenter} position={position} setPosition={setPosition} /> : null}
      {open && variant === 2 ? <ViewerPanel presenter={presenter} position={position} setPosition={setPosition} onClose={close} /> : null}
      {open && variant === 3 ? <ComparePanel presenter={presenter} onClose={close} onState={compareState} /> : null}
      {open && variant === 4 ? <CollagePanel presenter={presenter} onZoomed={zoomed} /> : null}
    </div>
  );
}

/* ── Mounting into the production pane ──────────────────────────────────── */

const TOOL_NAME = "publish_frames";

/** A host node inside the feed row of the publishing tool call, put back if a
    render drops it. The row's own card is hidden while the host stands in it. */
function useRowHost(pane: HTMLElement | null, enabled: boolean): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!pane || !enabled) return;
    const node = document.createElement("div");
    node.dataset.frameSetHost = "";
    const style = document.createElement("style");
    style.textContent = "[data-frame-set-row] > :not([data-frame-set-host]) { display: none !important; }";
    document.head.append(style);
    const place = () => {
      const rows = Array.from(pane.querySelectorAll<HTMLElement>('[data-log-feed-scroller] [data-feed-kind="tool"]'));
      const row = rows.find((candidate) => candidate.dataset.frameSetRow !== undefined) ?? rows.find((candidate) => (candidate.textContent ?? "").includes(TOOL_NAME));
      if (!row) {
        if (node.isConnected) { node.remove(); setHost(null); }
        return;
      }
      if (node.parentElement === row) return;
      /* The entry starts where the row's own card started. */
      const card = row.firstElementChild?.getBoundingClientRect();
      if (card && row.dataset.frameSetRow === undefined) node.style.paddingLeft = `${Math.max(0, Math.round(card.left - row.getBoundingClientRect().left))}px`;
      row.dataset.frameSetRow = "";
      row.append(node);
      setHost(node);
    };
    const observer = new MutationObserver(place);
    observer.observe(pane, { childList: true, subtree: true });
    place();
    return () => { observer.disconnect(); node.remove(); style.remove(); setHost(null); };
  }, [pane, enabled]);
  return host;
}

function Band({ variant, copy }: { variant: FrameSetVariant; copy: Copy }) {
  return (
    <div data-frame-proto-band className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-sunken px-3">
      <span data-frame-variant-number className="text-[30px] font-black leading-none text-accent">{variant}</span>
      <span className="min-w-0 truncate text-label font-semibold text-secondary">{copy.variants[variant]}</span>
    </div>
  );
}

interface ProtoControls {
  state: () => Record<string, unknown>;
  chosen: () => number[];
}

export function FrameSetsPrototype({ file, variant, paneWidth }: {
  file: FileEntry;
  variant: FrameSetVariant;
  /** A board-node-sized pane; absent, the pane fills the window. */
  paneWidth?: number;
}) {
  const phone = useIsMobile();
  const { locale } = useLocale();
  const lang: Lang = (locale as Locale) === "uk" ? "uk" : "en";
  const copy: Copy = COPY[lang];
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const set = useMemo(() => fixtureFrameSet(lang), [lang]);
  const state = useRef<Record<string, unknown>>({ open: false });
  const chosen = useRef<number[]>([]);
  const cardId = conversationIdentity(file);
  const presenter = useMemo<Presenter>(() => ({
    set, copy, lang, phone,
    /* The composer's own seam, the one a suggested reply uses: the sentence
       lands in the field, joined to what was typed, and is never sent. */
    choose: (number) => {
      chosen.current.push(number);
      appendComposerDraft(cardId, chosenReply(set, number, lang));
      window.dispatchEvent(new CustomEvent("frame-set-chosen"));
    },
  }), [set, copy, lang, phone, cardId]);
  const onState = useCallback((next: Record<string, unknown>) => { state.current = next; }, []);
  useEffect(() => {
    (window as unknown as { frameSets: ProtoControls }).frameSets = { state: () => state.current, chosen: () => chosen.current };
  }, []);
  const host = useRowHost(pane, variant !== 0);
  const portal: ReactNode = host && variant !== 0 ? createPortal(<Entry presenter={presenter} variant={variant} onState={onState} />, host) : null;

  if (phone) {
    return (
      <div data-frame-proto={variant} className="flex h-dvh min-h-0 flex-col bg-canvas text-primary">
        <Band variant={variant} copy={copy} />
        <div ref={setPane} data-testid="mobile-chat-shell" className="relative flex min-h-0 min-w-0 max-w-[100dvw] flex-1 flex-col overflow-hidden overflow-x-clip">
          <MobileShell
            screen="chat"
            screenId={file.conversationId ?? file.path}
            title={<MobileBarTitle meta={<span className="truncate text-label text-muted">{copy.working}</span>}>{copy.title}</MobileBarTitle>}
            back
            renderSheet={(name, close) => name === "menu" ? (
              <MobileConversationMenu file={file} stage={null} crowned={false} hostTaskCount={0} onRename={noop} onOpenHost={noop} onCloseCard={noop} projectName="delegatus" onClose={close} />
            ) : null}
          >
            <BranchPane file={file} tasks={[]} isRoot chromeInMenu onClose={noop} />
          </MobileShell>
        </div>
        {portal}
      </div>
    );
  }
  return (
    <div data-frame-proto={variant} className="flex h-dvh min-h-0 flex-col bg-canvas text-primary">
      <Band variant={variant} copy={copy} />
      <div ref={setPane} className="flex min-h-0 flex-1 self-center p-3" style={{ width: paneWidth ? paneWidth + 24 : "100%" }}>
        <BranchPane file={file} tasks={[]} isRoot onClose={noop} onToggleExpand={noop} />
      </div>
      {portal}
    </div>
  );
}

/* ── The fixture conversation ───────────────────────────────────────────── */

const TEXT = {
  en: {
    harness: "<environment_context>\n  <cwd>/workspace/delegatus</cwd>\n  <shell>bash</shell>\n</environment_context>",
    own: [
      "What is waiting for me on the board this morning?",
      "Start a design lane for stepping between my own messages. I want numbered variants I can look at.",
      "Show me what the design lane left.",
    ],
    replies: [
      "Two cards are waiting for you and the rest move on their own. The release card needs a yes or a no on the second review; the search card needs nothing until its browser check ends.\n\nI changed nothing on the board in this pass.",
      "Started the design lane with one requirement: four working prototypes in the production pane, each with its number printed on every frame, at the desktop, the board pane and the phone, in both languages.\n\nI will bring the frames here when the lane ends.",
      "The lane is done: four variants, twenty-four frames, all taken from working prototypes. The set is in the row above.\n\nWhich one do I build? My recommendation is variant 2: it keeps the header as it is and costs one row above the message field.",
    ],
  },
  uk: {
    harness: "<environment_context>\n  <cwd>/workspace/delegatus</cwd>\n  <shell>bash</shell>\n</environment_context>",
    own: [
      "Що сьогодні зранку чекає на мене на дошці?",
      "Запусти дизайн-лінію про кроки між моїми повідомленнями. Хочу пронумеровані варіанти, які можна подивитися.",
      "Покажи, що залишила дизайн-лінія.",
    ],
    replies: [
      "На вас чекають дві картки, решта рухається сама. Картці релізу потрібне «так» чи «ні» щодо другої рецензії; картці пошуку нічого не треба, доки не закінчиться перевірка в браузері.\n\nНа дошці в цьому проході я нічого не змінював.",
      "Запустив дизайн-лінію з однією вимогою: чотири робочі прототипи у справжній панелі, на кожному кадрі надруковано номер варіанта, на десктопі, у панелі дошки й на телефоні, обома мовами.\n\nКадри принесу сюди, коли лінія закінчить.",
      "Лінія закінчила: чотири варіанти, двадцять чотири кадри, усі зняті з робочих прототипів. Набір у рядку вище.\n\nЯкий будувати? Моя рекомендація: варіант 2. Він лишає шапку як є й коштує один рядок над полем повідомлення.",
    ],
  },
} as const;

/**
 * A Codex transcript of an orchestrator's morning that ends with a published
 * set: three messages the operator typed, each answered, and before the last
 * answer the Delegatus tool call that published the frames. The call carries
 * the set's id and counts and no bytes. All text is invented.
 */
export function frameSetsTranscript(lang: Lang): string[] {
  const text = TEXT[lang];
  const copy = COPY[lang];
  const lines: string[] = [];
  let clock = Date.parse("2026-10-05T06:00:00.000Z");
  const at = (minutes: number) => new Date(clock += minutes * 60_000).toISOString();
  const user = (marker: string, body: string, minutes: number) => lines.push(JSON.stringify({
    timestamp: at(minutes), type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker ? `${marker}\n${body}` : body }] },
  }));
  const agent = (body: string) => lines.push(JSON.stringify({ timestamp: at(1), type: "event_msg", payload: { type: "agent_message", message: body } }));
  const tool = (id: string) => {
    lines.push(JSON.stringify({ timestamp: at(0.2), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "git status --short"] }), call_id: id } }));
    lines.push(JSON.stringify({ timestamp: at(0.2), type: "response_item", payload: { type: "function_call_output", call_id: id, output: "clean" } }));
  };
  user("", text.harness, 0);
  text.own.forEach((own, index) => {
    user("<!-- llv:structured-user origin=operator -->", own, index === 2 ? 95 : 7);
    if (index < 2) tool(`call_frames_${index}`);
    if (index === 2) {
      const invocation = {
        server: "viewer",
        tool: TOOL_NAME,
        arguments: { setId: "fs_fixture_own_steps" },
      };
      lines.push(JSON.stringify({ timestamp: at(0.3), type: "event_msg", payload: { type: "mcp_tool_call_begin", call_id: "call_publish_frames", invocation } }));
      lines.push(JSON.stringify({ timestamp: at(0.3), type: "event_msg", payload: {
        type: "mcp_tool_call_end", call_id: "call_publish_frames", invocation,
        result: { Ok: { content: [{ type: "text", text: JSON.stringify({ ok: true, toolName: TOOL_NAME, setId: "fs_fixture_own_steps", title: copy.setTitle, variants: FRAME_SET_FIXTURE_VARIANTS, frames: FRAME_SET_FIXTURE_FRAMES }) }] } },
      } }));
    }
    agent(text.replies[index]!);
  });
  return lines;
}
