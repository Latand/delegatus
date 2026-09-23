/**
 * The product's name and its emblem files. The name is a brand, so it is not
 * translated: Ukrainian keeps the Latin «Delegatus» as well. The emblem files
 * are plain SVG under `public/brand/`, served as-is by every install shape
 * (the image copies `public/`), which keeps them out of the privacy gate's
 * raster provenance regime.
 */
export const PRODUCT_NAME = "Delegatus";

export const BRAND_ASSET = {
  /** The flat mark on a 64 grid: favicon, rail header, Viewer-authored cards. */
  mark: "/brand/delegatus-mark.svg",
  /** The head-and-shoulders badge in its slate ring: empty states, onboarding. */
  badge: "/brand/delegatus-badge.svg",
} as const;
