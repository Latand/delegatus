import fs from "node:fs/promises";
import { copyMedia, writeMediaCopy } from "@/lib/prototypeReview/copy";
import { findPrototypeRound, prototypeRoot, roundMedia, storedMediaPath } from "@/lib/prototypeReview/store";
import { PROTOTYPE_LIMITS } from "@/lib/prototypeReview/input";
import type { PrototypeMedia } from "@/lib/prototypeReview/types";
import { readTaskAlbum, readTaskAlbumImage, ALBUM_PAGE_MAX } from "@/lib/taskAlbum/album";
import type { TaskAlbumDeps } from "@/lib/taskAlbum/album";
import { productionAlbumDeps } from "@/lib/taskAlbum/world";
import type { DoneFrameCopy } from "./media";

/** Decode only existing same-origin media forms. No HTTP fetch or redirect can
 * become a local file read. A source refusal has no drawable bytes. */
export function doneFrameSource(deps: () => TaskAlbumDeps = productionAlbumDeps): DoneFrameCopy {
 return async (src, staging) => {
  try {
    const url = new URL(src, "http://localhost");
    if (!src.startsWith("/") || src.startsWith("//") || url.origin !== "http://localhost") return null;
    if (url.pathname === "/api/artifact" || url.pathname === "/api/image") {
      if (url.searchParams.has("prototype")) {
        const round = findPrototypeRound(url.searchParams.get("taskId") || null, url.searchParams.get("prototype") ?? "");
        const media = round && !round.mediaRemovedAt && roundMedia(round).find(m => m.id === url.searchParams.get("media") && m.mime.startsWith("image/"));
        if (!media) return null;
        const source = storedMediaPath(await fs.realpath(prototypeRoot()), round!.id, media);
        // The manifest proves this exact file. The shared copier pins its
        // descriptor, bounds the read, and refuses a swapped parent directory.
        const copied = await copyMedia(source, staging, async () => source);
        return copied.id === media.id && copied.bytes === media.bytes ? copied : null;
      }
      const source = url.searchParams.get("path");
      return source ? await copyMedia(source, staging) : null;
    }
    const album = /^\/api\/tasks\/([^/]+)\/album\/image$/.exec(url.pathname);
    if (album) {
      const image = await readTaskAlbumImage(decodeURIComponent(album[1]!), url.searchParams.get("id") ?? "", deps());
      if (!image || image.data.length > PROTOTYPE_LIMITS.imageBytes || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.media)) return null;
      return await writeMediaCopy(image.data, image.media as PrototypeMedia["mime"], staging);
    }
  } catch { /* A missing or refused source has no drawable bytes. */ }
  return null;
 };
}
export const copyDoneFrameSource = doneFrameSource();

/** A legacy album URL carries a memory-index id. Advance its existing bounded
 * index before trying it; an incomplete pass is retried by a later sweep. */
export async function prepareDoneFrameSource(src: string, deps: TaskAlbumDeps = productionAlbumDeps()): Promise<boolean> {
  const match = /^\/api\/tasks\/([^/?]+)\/album\/image\?/.exec(src);
  if (!match) return true;
  const page = await readTaskAlbum(decodeURIComponent(match[1]!), { limit: ALBUM_PAGE_MAX }, deps);
  return !page.indexing;
}
