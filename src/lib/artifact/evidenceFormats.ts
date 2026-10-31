/** Raster formats served from evidence roots. Keep retention's native and
 * container inventories on the same list as the artifact reader. */
export const EVIDENCE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] as const;
const image = new RegExp(`\\.(?:${EVIDENCE_IMAGE_EXTENSIONS.join("|")})$`, "i");

export function isEvidenceImage(pathname: string): boolean {
  return image.test(pathname);
}

/** Retention also preserves report documents and rendered recordings. */
export const PRESERVED_MEDIA_EXTENSIONS = [...EVIDENCE_IMAGE_EXTENSIONS, "svg", "pdf", "mp4", "webm"] as const;
const media = new RegExp(`\\.(?:${PRESERVED_MEDIA_EXTENSIONS.join("|")})$`, "i");
export function isPreservedMedia(pathname: string): boolean {
  return media.test(pathname);
}
