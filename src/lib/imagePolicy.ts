/**
 * Inbox image whitelist shared by the server (validation before saving) and
 * the client (attach-time checks) so both agree on what is acceptable. No
 * node: imports here — this module is bundled into client components too.
 */
export const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const MAX_INBOX_IMAGE_BYTES = 10 * 1024 * 1024;

/** File extension for a whitelisted inbox image mime, or null when unsupported. */
export function inboxImageExt(mime: string): string | null {
  return IMAGE_MIME_EXT[mime] ?? null;
}

const RASTER_PATH_RE = /\.(?:png|jpe?g|gif|webp)$/i;
/** Longest path the feed keeps as a picture source; a longer one is not a path an agent opened. */
const MAX_IMAGE_PATH_CHARS = 4096;

/**
 * The path of a raster an agent looked at, when it can be drawn from disk
 * (#2075): absolute or `~/`, one line, and a png/jpeg/gif/webp extension. SVG
 * is never one — it is a document, and it never reaches an `<img>` from a path.
 * Null for anything else, so the caller keeps its text.
 */
export function rasterImagePath(value: string): string | null {
  const path = value.trim();
  if (!path || path.length > MAX_IMAGE_PATH_CHARS || /[\0\r\n]/.test(path)) return null;
  if (!path.startsWith("/") && !path.startsWith("~/")) return null;
  return RASTER_PATH_RE.test(path) ? path : null;
}
