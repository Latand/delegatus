"use client";

import { useState, type SyntheticEvent } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";

import { GlyphIcon } from "../../icons";
import { artifactBasename, artifactContentUrl, artifactMetaUrl } from "../../preview/artifactResource";
import { Lightbox } from "../Lightbox";
import { tr, type ImageSource } from "../parse";

type ImageView = "chip" | "thumb" | "full";
type ImageFailure = "gone" | "outside" | "unavailable";

const FAILURE_KEY = {
  gone: "render.imageGone",
  outside: "render.imageOutsideRoots",
  unavailable: "render.imageUnavailable",
} as const;

/* Why a file the card could not draw failed, from the artifact route's typed
   code: gone from disk, fenced out of the served folders, or anything else. */
async function pathFailure(path: string): Promise<ImageFailure> {
  try {
    const res = await fetch(artifactMetaUrl(path), { cache: "no-store" });
    if (res.ok) return "unavailable";
    const code = ((await res.json().catch(() => ({}))) as { code?: unknown }).code;
    if (code === "not-found" || code === "not-a-file") return "gone";
    if (code === "access-denied") return "outside";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Every raster in the feed: a pasted or attached picture, and every picture
 * an agent looked at (#1498, #2075). It opens as a thumbnail; a tap opens the
 * full-screen viewer, and "Collapse" folds it to a chip if the operator wants
 * it out of the way. The bytes are inline (`data`) or a file on disk (`path`),
 * which loads lazily through the artifact route, the same fenced route the
 * document preview reads. A file that cannot be drawn becomes a pill naming
 * the file and why, never its full path. `inset` drops the feed-gutter indent
 * for a card that already sits under a tool line. `quietOutsideRoots` draws
 * nothing for a file the route's fence refuses: a live row's settled echo
 * shows that picture from the transcript's own bytes, so a pill there would
 * only flash and vanish.
 */
export function ImageCard({ inset = false, quietOutsideRoots = false, ...source }: ImageSource & { inset?: boolean; quietOutsideRoots?: boolean }) {
  const [view, setView] = useState<ImageView>("thumb");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failure, setFailure] = useState<ImageFailure | null>(null);
  const isMobile = useIsMobile();
  const path = source.path;
  const width = source.w ?? natural?.w;
  const height = source.h ?? natural?.h;
  const dims = width && height ? `${width}×${height}` : "";
  /* An `<img>` cannot read a file's length, and a request only for a byte
     count is not worth it, so a picture from disk shows its dimensions only. */
  const kb = source.data !== undefined ? Math.round((source.bytes ?? (source.data.length * 3) / 4) / 1024) : source.bytes !== undefined ? Math.round(source.bytes / 1024) : null;
  const size = kb === null ? "" : `${kb} ${tr("common.kb")}`;
  const caption = [dims, size].filter(Boolean).join(" · ");
  const name = path !== undefined ? artifactBasename(path) : "";
  const label = `${tr("render.image")} ${dims || name}`.trim();
  const gutter = inset ? "" : "ml-9 ";

  if (failure === "outside" && quietOutsideRoots) return null;
  if (failure) {
    return (
      <div className={`my-2 ${gutter}min-w-0`}>
        <span
          data-image-unavailable={failure}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-sunken px-2.5 py-1 text-[11.5px] font-semibold text-muted"
          title={path}
        >
          <GlyphIcon name="image" className="h-3.5 w-3.5 shrink-0" />
          {name ? <span className="min-w-0 truncate font-mono">{name}</span> : null}
          <span className="shrink-0">{name ? "· " : ""}{tr(FAILURE_KEY[failure])}</span>
        </span>
      </div>
    );
  }

  if (view === "chip") {
    return (
      <button
        type="button"
        onClick={() => setView("thumb")}
        className={`my-2 ${gutter}flex max-w-full items-center gap-2 rounded-[14px] border border-border bg-card px-3.5 py-2 text-[13px] shadow-1 [@media(pointer:coarse)]:min-h-11 ${isMobile ? "min-h-11" : ""}`}
      >
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-sunken">
          <GlyphIcon name="image" className="h-4 w-4" />
        </span>
        <span className="min-w-0 truncate font-semibold">{dims || name || tr("render.image")}</span>
        {size ? <span className="shrink-0 text-muted">· {size}</span> : null}
        <span className="ml-1 shrink-0 text-[12px] font-semibold text-accent">{tr("common.show")}</span>
      </button>
    );
  }

  const src = path !== undefined ? artifactContentUrl(path) : `data:${source.media};base64,${source.data}`;
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth && naturalHeight && (naturalWidth !== natural?.w || naturalHeight !== natural?.h)) setNatural({ w: naturalWidth, h: naturalHeight });
  };
  const onError = () => {
    if (path === undefined) return setFailure("unavailable");
    void pathFailure(path).then(setFailure);
  };
  return (
    <div className={`my-2 ${gutter}min-w-0`}>
      {/* next/image cannot serve a base64 data URI or a fenced local file. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={label}
        title={path}
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        onError={onError}
        onClick={() => setView("full")}
        className="block max-h-[240px] max-w-full cursor-zoom-in rounded-[14px] border border-border object-contain"
      />
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[12px] text-muted">
        {caption ? <span data-image-caption className="tabular-nums">{caption}</span> : null}
        <button type="button" onClick={() => setView("chip")} className="hover:text-primary [@media(pointer:coarse)]:min-h-11">
          {tr("common.collapse")}
        </button>
      </div>
      {view === "full" ? (
        <Lightbox src={src} alt={label} caption={caption || name} onClose={() => setView("thumb")} />
      ) : null}
    </div>
  );
}
