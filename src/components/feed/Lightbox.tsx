"use client";

import { Minus, Plus } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronLeft, ChevronRight, X } from "@/components/icons";
import { useImageGesture } from "@/hooks/useImageGesture";
import { useOverlayEscape } from "@/hooks/useOverlayEscape";
import { useLocale } from "@/lib/i18n";
import { Z } from "@/components/layers";

interface Props {
  src: string;
  alt: string;
  caption?: string;
  /** Where the picture came from, on a line of its own under a narrow toolbar. */
  detail?: string;
  /** The picture's place among the pictures its feed row draws. */
  at?: number;
  /** Told each picture the viewer moves to, so the surface that opened it can follow. */
  onShow?: (image: GalleryImage) => void;
  onClose: () => void;
}

/** A picture the viewer can step to: where its bytes load from, the words it
    shows for it, the feed row that draws it and its place in that row. */
export interface GalleryImage {
  src: string;
  alt: string;
  caption?: string;
  detail?: string;
  owner?: unknown;
  at?: number;
  /** The counter's words for it when its list numbers it its own way. */
  place?: string;
  /** The same picture before a change. A press swaps the two in place, at the
      zoom and the pan the operator is at, so one region is compared exactly. */
  before?: { src: string; alt: string; caption?: string };
}

/* The pictures of the conversation a viewer was opened from, in feed order.
   LogFeed provides one per conversation and builds the list from the feed's
   own records only when a viewer asks, so the value never changes and no row
   re-renders for it. */
const GalleryContext = createContext<(() => readonly GalleryImage[]) | null>(null);
export const ImageGalleryProvider = GalleryContext.Provider;

/* The feed row a picture is drawn in. With the picture's place in that row,
   a picture the conversation shows twice opens at the copy that was clicked. */
const OwnerContext = createContext<unknown>(null);
export const GalleryOwnerProvider = OwnerContext.Provider;

const MAX_SCALE = 8;
/** Pointer travel, in px, past which a press is a pan rather than a click. */
const CLICK_SLOP = 6;

/* Where the opened picture sits in its conversation's list. A picture the list
   does not hold (a live row the transcript has not caught up with, a document
   preview) is shown on its own. The card that opened the viewer names its own
   picture best, since it may know the loaded size. */
function openAt(images: readonly GalleryImage[], opened: GalleryImage, owner: unknown) {
  const inRow = (image: GalleryImage) => image.owner === owner && image.src === opened.src;
  let start = opened.at === undefined ? -1 : images.findIndex((image) => inRow(image) && image.at === opened.at);
  if (start < 0) start = images.findIndex(inRow);
  if (start < 0) start = images.findIndex((image) => image.src === opened.src);
  /* The original of a pair opens on its pair, showing the original. */
  if (start < 0) {
    start = images.findIndex((image) => image.before?.src === opened.src);
    if (start >= 0) return { images, start, before: true };
  }
  if (start < 0) return { images: [opened], start: 0, before: false };
  return { images: images.map((image, at) => (at === start ? { ...image, alt: opened.alt, caption: opened.caption, detail: opened.detail } : image)), start, before: false };
}

/**
 * Fullscreen image viewer: wheel and pinch zoom around the cursor or the
 * fingers, a drag pans a zoomed picture, a double click or tap toggles
 * fit/200% (`useImageGesture`), Esc or a click on the dimmed backdrop closes.
 * ←/→, the edge buttons and a sideways swipe at fit step through the
 * conversation's pictures and stop at either end; a swipe up or down at fit
 * closes. A picture loads when it comes within one step of the shown one,
 * hidden, so it is on screen the moment it is reached. Every picture loaded
 * stays mounted until the viewer closes: a picture no mounted feed row draws
 * has no other holder, and once let go the browser may download it again.
 * A picture with an original carries a two-way switch at the bottom of the
 * screen: the original takes the picture's place at the same zoom and pan.
 */
export function Lightbox({ src, alt, caption, detail, at, onShow, onClose }: Props) {
  const { t } = useLocale();
  const gallery = useContext(GalleryContext);
  const owner = useContext(OwnerContext);
  /* Read once, when the viewer opens: the list holds still under the operator
     while a live feed keeps growing. */
  const [{ images, start, before: openedBefore }] = useState(() => openAt(gallery?.() ?? [], { src, alt, caption, detail, at }, owner));
  const [index, setIndex] = useState(start);
  const [before, setBefore] = useState(openedBefore);
  const told = useRef(onShow);
  useEffect(() => { told.current = onShow; }, [onShow]);
  /* The first and the last picture shown so far. A move is one step, so every
     picture between them has been shown too. */
  const [reach, setReach] = useState({ from: start, to: start });
  const press = useRef<{ x: number; y: number; backdrop: boolean } | null>(null);

  useOverlayEscape(onClose);

  const step = (direction: -1 | 1) => {
    const next = index + direction;
    if (next >= 0 && next < images.length) show(next);
  };
  const { frameRef, imageRef, bind, fit, view, moving, zoomBy, reset } = useImageGesture({ maxScale: MAX_SCALE, zoomedScale: () => 2, swipe: { step, close: onClose } });

  /* Every move, by key, by button or by swipe, starts the next picture unzoomed, on its changed side. */
  const show = useCallback((next: number) => {
    setIndex(next);
    setBefore(false);
    setReach((reach) => ({ from: Math.min(reach.from, next), to: Math.max(reach.to, next) }));
    reset();
    told.current?.(images[next]!);
  }, [reset, images]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  /* Claimed in the window's capture phase, like Escape, so the board under the
     viewer never moves on the same press. A text field keeps its arrows. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      event.preventDefault();
      event.stopPropagation();
      const next = index + (event.key === "ArrowRight" ? 1 : -1);
      if (next >= 0 && next < images.length) show(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, images.length, show]);

  const image = images[index]!;
  const showing = before && image.before ? { ...image, ...image.before } : image;
  const first = Math.max(0, reach.from - 1);
  const mounted = Array.from({ length: Math.min(images.length - 1, reach.to + 1) - first + 1 }, (_, at) => first + at);
  /* A phone's toolbar buttons keep a whole finger's target. */
  const tool = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-white/25 bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:min-h-0 sm:min-w-0";
  const edge = "absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg border border-white/25 bg-black/40 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

  /* Panes on the scheme canvas sit under a CSS transform, which turns the
     transformed ancestor into the containing block for fixed elements — the
     overlay would fill the pane, not the screen. Portal to <body> escapes it. */
  return createPortal(
    <div
      className={`fixed inset-0 ${Z.overlay} flex flex-col bg-black/85 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] backdrop-blur-sm`}
      role="dialog"
      aria-modal="true"
      aria-label={showing.alt}
      onPointerDown={(event) => {
        press.current = { x: event.clientX, y: event.clientY, backdrop: !(event.target as Element).closest("img, button, [data-lightbox-compare]") };
      }}
      onClick={(event) => {
        /* The dimmed area closes the viewer: a press that began off the
           picture and its controls and did not travel. A pan ends with a
           click wherever the pointer was released, so it never closes. */
        const pressed = press.current;
        press.current = null;
        if (!pressed?.backdrop || (event.target as Element).closest("img, button, [data-lightbox-compare]")) return;
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_SLOP) return;
        onClose();
      }}
    >
      <div className={`flex items-center gap-x-2 px-4 py-2.5 ${image.detail ? "flex-wrap gap-y-1" : ""}`}>
        {images.length > 1 ? (
          <span data-lightbox-position className="shrink-0 text-[12.5px] font-semibold tabular-nums text-white/85">
            {image.place ?? `${index + 1} / ${images.length}`}
          </span>
        ) : null}
        {image.detail ? (
          /* A caption with a source: on a narrow screen the buttons leave it
             no room, so it takes its own line under them, the name above the
             source; a wide screen keeps it in the toolbar. */
          <span data-lightbox-caption className="order-last flex min-w-0 basis-full flex-col text-[12.5px] font-semibold text-white/85 sm:order-none sm:flex-1 sm:basis-0 sm:flex-row sm:gap-1">
            <span className="min-w-0 truncate">{showing.caption ?? showing.alt}</span>
            <span data-lightbox-detail className="min-w-0 truncate text-white/65"><span aria-hidden className="hidden sm:inline">· </span>{image.detail}</span>
          </span>
        ) : (
          <span data-lightbox-caption className="min-w-0 truncate text-[12.5px] font-semibold text-white/85">{showing.caption ?? showing.alt}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            className={`${tool} px-2.5 py-1`}
            aria-label={t("lightbox.zoomOut")}
            onClick={() => zoomBy(1 / 1.4)}
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <button
            className={`${tool} px-2 py-1 text-[11.5px] font-semibold`}
            aria-label={t("lightbox.resetZoom")}
            onClick={reset}
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button
            className={`${tool} px-2.5 py-1`}
            aria-label={t("lightbox.zoomIn")}
            onClick={() => zoomBy(1.4)}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          <button
            className={`${tool} ml-1 px-2.5 py-1`}
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </span>
      </div>
      {/* The hand is read here rather than on the frame, so a finger that
          lands on an edge button still pinches with one on the picture. */}
      <div className="relative min-h-0 flex-1 touch-none" {...bind}>
        <div ref={frameRef} className="h-full overflow-hidden">
          <div className="flex h-full items-center justify-center">
            {mounted.flatMap((at) => {
              const entry = images[at]!;
              /* An original is loaded with its pair, so the switch shows it at once. */
              const sides = entry.before ? [{ side: "before" as const, ...entry.before }, { side: "after" as const, ...entry }] : [{ side: "after" as const, ...entry }];
              return sides.map((picture) => {
                const current = at === index && (picture.side === "before") === (before && Boolean(entry.before));
                return (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={`${at}:${picture.side}`}
                    ref={current ? imageRef : undefined}
                    src={picture.src}
                    alt={picture.alt}
                    hidden={!current}
                    data-lightbox-side={entry.before ? picture.side : undefined}
                    draggable={false}
                    className={`max-h-full max-w-full select-none ${moving ? "" : "transition-transform duration-75"} ${fit ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing"}`}
                    style={current ? { transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` } : undefined}
                  />
                );
              });
            })}
          </div>
        </div>
        {index > 0 ? (
          <button type="button" data-lightbox-step="previous" className={`${edge} left-2`} aria-label={t("lightbox.previous")} onClick={() => show(index - 1)}>
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
        {index < images.length - 1 ? (
          <button type="button" data-lightbox-step="next" className={`${edge} right-2`} aria-label={t("lightbox.next")} onClick={() => show(index + 1)}>
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
        {image.before ? (
          /* Under the thumb on a phone, clear of the edge buttons. */
          <div role="group" aria-label={t("lightbox.compare")} data-lightbox-compare="" className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1 rounded-xl border border-white/25 bg-black/55 p-1">
            {([["before", "lightbox.original"], ["after", "lightbox.changed"]] as const).map(([side, key]) => (
              <button
                key={side}
                type="button"
                data-lightbox-compare-side={side}
                aria-pressed={before === (side === "before")}
                className="inline-flex min-h-11 items-center rounded-lg px-3.5 text-[12.5px] font-semibold text-white/80 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 aria-pressed:bg-white/90 aria-pressed:text-black sm:min-h-8"
                onClick={() => setBefore(side === "before")}
              >
                {t(key)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
