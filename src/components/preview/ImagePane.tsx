"use client";

import { Maximize2, Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { useImageGesture } from "@/hooks/useImageGesture";
import { useLocale } from "@/lib/i18n";

import { artifactContentUrl, failureFromStatus, type ArtifactFailure, type ArtifactMeta } from "./artifactResource";

const MAX_SCALE = 16;
/** Px kept clear around a picture at fit. */
const FIT_MARGIN = 12;

/**
 * Image preview: fit-to-pane by default, and the fullscreen viewer's hand on
 * the picture (`useImageGesture`), docked into the preview sheet: wheel and
 * pinch zoom about the cursor or the fingers, a drag pans a zoomed picture, a
 * double click or tap goes between fit and the picture's own pixels. The
 * percentage is of those pixels; intrinsic dimensions come from the decoded
 * image itself.
 */
export function ImagePane({
  path,
  meta,
  mobile,
  onFailure,
}: {
  path: string;
  meta: ArtifactMeta;
  mobile: boolean;
  onFailure: (failure: ArtifactFailure) => void;
}) {
  const { t } = useLocale();
  const [src, setSrc] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const { frameRef, imageRef, bind, fit, view, moving, measured, zoomBy, reset } = useImageGesture({
    natural: dims ? { width: dims.w, height: dims.h } : null,
    margin: FIT_MARGIN,
    maxScale: MAX_SCALE,
    zoomedScale: (fitted) => Math.max(1, fitted * 2),
  });
  /* Until the picture and its frame are measured, CSS fits it. */
  const laidOut = dims !== null && measured;

  /* The bytes come through fetch because a bare <img src> hides the HTTP
     status: a 413 or 412 would collapse into the generic error state. The
     fetch is pinned to the meta validator and its failures map to the explicit
     oversized/changed/missing states; the img renders a bounded object URL.
     Closing the preview aborts the in-flight read. */
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    void fetch(artifactContentUrl(path), {
      signal: controller.signal,
      headers: { "if-match": meta.etag },
    })
      .then(async (response) => {
        if (!response.ok) {
          onFailure(failureFromStatus(response.status));
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) onFailure("error");
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, meta.etag, onFailure]);

  /* Same touch-target contract as the host header: 44 px controls on mobile. */
  const control = mobile ? "h-11 w-11" : "h-7 w-7";
  const icon = mobile ? "h-5 w-5" : "h-3.5 w-3.5";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11.5px] text-muted">
        {dims ? (
          <span data-image-dimensions className="tabular-nums">
            {dims.w} × {dims.h}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-label={t("lightbox.zoomOut")}
            title={t("lightbox.zoomOut")}
            onClick={() => zoomBy(1 / 1.4)}
            className={`flex ${control} items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          >
            <Minus className={icon} aria-hidden />
          </button>
          <span className="w-10 text-center tabular-nums">{fit ? t("preview.fit") : `${Math.round(view.scale * 100)}%`}</span>
          <button
            type="button"
            aria-label={t("lightbox.zoomIn")}
            title={t("lightbox.zoomIn")}
            onClick={() => zoomBy(1.4)}
            className={`flex ${control} items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          >
            <Plus className={icon} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t("preview.fitImage")}
            title={t("preview.fitImage")}
            onClick={reset}
            className={`flex ${control} items-center justify-center rounded-[8px] border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              fit ? "bg-accent/15 text-accent" : "bg-canvas text-muted hover:text-primary"
            }`}
          >
            <Maximize2 className={icon} aria-hidden />
          </button>
        </span>
      </div>
      <div
        ref={frameRef}
        className={`relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas ${fit ? "" : moving ? "cursor-grabbing" : "cursor-grab"}`}
        {...bind}
      >
        <div className={laidOut ? "flex h-full w-full items-center justify-center" : "flex h-full w-full items-center justify-center p-3"}>
          {src ? (
            /* eslint-disable-next-line @next/next/no-img-element -- local artifact bytes stream from /api/artifact, next/image cannot serve them */
            <img
              ref={imageRef}
              src={src}
              alt={meta.name}
              draggable={false}
              onLoad={(event) => {
                const image = event.target as HTMLImageElement;
                setDims({ w: image.naturalWidth, h: image.naturalHeight });
              }}
              onError={() => onFailure("error")}
              className={laidOut ? "max-w-none shrink-0 select-none" : "max-h-full max-w-full object-contain"}
              style={laidOut ? { transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` } : undefined}
            />
          ) : (
            <span className="text-[13px] text-muted" role="status">
              {t("preview.loading")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
