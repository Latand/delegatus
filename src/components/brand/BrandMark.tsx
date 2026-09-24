import { BRAND_ASSET } from "@/lib/brand";

/* The emblem is decoration beside text that already names the product (the
   rail header, a dialog title, an empty state), so it carries an empty alt and
   stays out of the accessibility tree. Loaded as an <img>, the SVG keeps its
   own clip-path ids to itself however many copies a page shows. */

/** The flat Delegatus mark, square, at `size` CSS pixels. */
export function DelegatusMark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={BRAND_ASSET.mark} alt="" aria-hidden width={size} height={size} draggable={false} data-brand-mark="" className={`shrink-0 select-none ${className}`} />
  );
}

/** The Delegatus badge (head and shoulders in a slate ring), round, at `size` CSS pixels. */
export function DelegatusBadge({ size = 88, className = "" }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={BRAND_ASSET.badge} alt="" aria-hidden width={size} height={size} draggable={false} data-brand-badge="" className={`shrink-0 select-none ${className}`} />
  );
}
