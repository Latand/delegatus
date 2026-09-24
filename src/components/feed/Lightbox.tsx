"use client";

import { Minus, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronLeft, ChevronRight, X } from "@/components/icons";
import { useOverlayEscape } from "@/hooks/useOverlayEscape";
import { useLocale } from "@/lib/i18n";
import { Z } from "@/components/layers";

interface Props {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}

/** A picture the viewer can step to: where its bytes load from, the words it
    shows for it, and the feed row that draws it. */
export interface GalleryImage {
  src: string;
  alt: string;
  caption?: string;
  owner?: unknown;
}

/* The pictures of the conversation a viewer was opened from, in feed order.
   LogFeed provides one per conversation and builds the list from the feed's
   own records only when a viewer asks, so the value never changes and no row
   re-renders for it. */
const GalleryContext = createContext<(() => readonly GalleryImage[]) | null>(null);
export const ImageGalleryProvider = GalleryContext.Provider;

/* The feed row a picture is drawn in, so a picture the conversation shows
   twice opens at the occurrence that was clicked. */
const OwnerContext = createContext<unknown>(null);
export const GalleryOwnerProvider = OwnerContext.Provider;

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** Pointer travel, in px, past which a press is a pan rather than a click. */
const CLICK_SLOP = 6;

/* Where the opened picture sits in its conversation's list. A picture the list
   does not hold (a live row the transcript has not caught up with, a document
   preview) is shown on its own. The card that opened the viewer names its own
   picture best, since it may know the loaded size. */
function openAt(images: readonly GalleryImage[], opened: GalleryImage, owner: unknown) {
  let start = images.findIndex((image) => image.owner === owner && image.src === opened.src);
  if (start < 0) start = images.findIndex((image) => image.src === opened.src);
  if (start < 0) return { images: [opened], start: 0 };
  return { images: images.map((image, at) => (at === start ? { ...image, alt: opened.alt, caption: opened.caption } : image)), start };
}

/**
 * Fullscreen image viewer: wheel zooms around the cursor, drag pans, double
 * click toggles fit/200%, Esc or a click on the dimmed backdrop closes. ←/→
 * and the edge buttons step through the conversation's pictures and stop at
 * either end. Only the shown picture and its two neighbours are mounted, the
 * neighbours hidden, so each loads once and is on screen the moment it is
 * reached.
 */
export function Lightbox({ src, alt, caption, onClose }: Props) {
  const { t } = useLocale();
  const gallery = useContext(GalleryContext);
  const owner = useContext(OwnerContext);
  /* Read once, when the viewer opens: the list holds still under the operator
     while a live feed keeps growing. */
  const [{ images, start }] = useState(() => openAt(gallery?.() ?? [], { src, alt, caption }, owner));
  const [index, setIndex] = useState(start);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const press = useRef<{ x: number; y: number; backdrop: boolean } | null>(null);

  useOverlayEscape(onClose);

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
      if (next < 0 || next >= images.length) return;
      setIndex(next);
      setScale(1);
      setTx(0);
      setTy(0);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, images.length]);

  const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  const zoomBy = (factor: number, cx = 0, cy = 0) => {
    const next = clamp(scale * factor);
    const ratio = next / scale;
    /* Keep the point under the cursor stationary while zooming. */
    setScale(next);
    setTx(cx - (cx - tx) * ratio);
    setTy(cy - (cy - ty) * ratio);
  };

  const reset = () => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  const show = (next: number) => {
    setIndex(next);
    reset();
  };

  const image = images[index]!;
  const mounted = [index - 1, index, index + 1].filter((at) => at >= 0 && at < images.length);
  const edge = "absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg border border-white/25 bg-black/40 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

  /* Panes on the scheme canvas sit under a CSS transform, which turns the
     transformed ancestor into the containing block for fixed elements — the
     overlay would fill the pane, not the screen. Portal to <body> escapes it. */
  return createPortal(
    <div
      className={`fixed inset-0 ${Z.overlay} flex flex-col bg-black/85 backdrop-blur-sm`}
      role="dialog"
      aria-modal="true"
      aria-label={image.alt}
      onPointerDown={(event) => {
        press.current = { x: event.clientX, y: event.clientY, backdrop: !(event.target as Element).closest("img, button") };
      }}
      onClick={(event) => {
        /* The dimmed area closes the viewer: a press that began off the
           picture and its controls and did not travel. A pan ends with a
           click wherever the pointer was released, so it never closes. */
        const pressed = press.current;
        press.current = null;
        if (!pressed?.backdrop || (event.target as Element).closest("img, button")) return;
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_SLOP) return;
        onClose();
      }}
    >
      <div className="flex items-center gap-2 px-4 py-2.5">
        {images.length > 1 ? (
          <span data-lightbox-position className="shrink-0 text-[12.5px] font-semibold tabular-nums text-white/85">
            {index + 1} / {images.length}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-white/85">{image.caption ?? image.alt}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            className="inline-flex items-center rounded-lg border border-white/25 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label={t("lightbox.zoomOut")}
            onClick={() => zoomBy(1 / 1.4)}
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <button
            className="rounded-lg border border-white/25 bg-white/10 px-2 py-1 text-[11.5px] font-semibold text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label={t("lightbox.resetZoom")}
            onClick={reset}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            className="inline-flex items-center rounded-lg border border-white/25 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label={t("lightbox.zoomIn")}
            onClick={() => zoomBy(1.4)}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          <button
            className="ml-1 inline-flex items-center rounded-lg border border-white/25 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          className="h-full touch-none overflow-hidden"
          onWheel={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const cx = event.clientX - rect.left - rect.width / 2;
            const cy = event.clientY - rect.top - rect.height / 2;
            zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18, cx, cy);
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, tx, ty };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setTx(drag.current.tx + (event.clientX - drag.current.x));
            setTy(drag.current.ty + (event.clientY - drag.current.y));
          }}
          onPointerUp={() => {
            drag.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onDoubleClick={() => (scale === 1 ? zoomBy(2) : reset())}
        >
          <div className="flex h-full items-center justify-center">
            {mounted.map((at) => (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={at}
                src={images[at]!.src}
                alt={images[at]!.alt}
                hidden={at !== index}
                draggable={false}
                className={`max-h-full max-w-full select-none ${dragging ? "" : "transition-transform duration-75"} ${scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
                style={at === index ? { transform: `translate(${tx}px, ${ty}px) scale(${scale})` } : undefined}
              />
            ))}
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
      </div>
    </div>,
    document.body,
  );
}
