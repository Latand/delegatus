/*
 * Design prototype (docs/design/frame-sets.md): the record an agent publishes
 * when it leaves numbered prototypes and screenshots for the operator, and
 * the few pure rules the four presenter variants share. No product file
 * imports this; the build lane moves what it keeps into `src/lib/`.
 */

/** Bounds a published set is refused past, with the reason for each in the design note. */
export const FRAME_SET_MAX_FRAMES = 60;
export const FRAME_SET_MAX_VARIANTS = 9;
export const FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const FRAME_SET_MAX_BYTES = 48 * 1024 * 1024;
export const FRAME_SET_TITLE_MAX_CHARS = 120;
export const FRAME_CAPTION_MAX_CHARS = 200;
export const FRAME_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export interface FrameSetVariant {
  /** The number printed on the variant's frames and typed back by the operator. */
  number: number;
  title: string;
}

export interface Frame {
  /** The SHA-256 of the bytes: the file's name in the store and its identity across sets. */
  id: string;
  /** The variant the frame belongs to; null for a frame that shows no variant (a baseline, a measurement). */
  variant: number | null;
  caption: string;
  /** The viewport width the frame was taken at, when it was a viewport capture. */
  width: number | null;
  /** The interface language in the frame. */
  lang: string | null;
  w: number;
  h: number;
  bytes: number;
  /** Where the bytes load from, relative to the installation's own origin. */
  src: string;
}

export interface FrameSet {
  id: string;
  title: string;
  /** Recorded by the server from the calling conversation, never taken from the caller. */
  source: { conversationId: string; pipelineId: string | null; stageId: string | null; commit: string | null };
  createdAt: string;
  variants: FrameSetVariant[];
  /** In the order the agent listed them. */
  frames: Frame[];
}

/** What an agent hands the publishing tool: local paths, read and copied by the server. */
export interface FrameSetInput {
  title: string;
  variants?: { number: number; title: string }[];
  frames: { path: string; variant?: number; caption?: string; width?: number; lang?: string }[];
}

/** Why a publication is refused, one sentence per defect; empty when it is admitted. */
export function frameSetInputDefects(input: FrameSetInput, sizes: readonly number[] = []): string[] {
  const defects: string[] = [];
  const title = input.title.trim();
  if (!title) defects.push("a set needs a title");
  if (title.length > FRAME_SET_TITLE_MAX_CHARS) defects.push(`the title is longer than ${FRAME_SET_TITLE_MAX_CHARS} characters`);
  if (input.frames.length === 0) defects.push("a set needs at least one frame");
  if (input.frames.length > FRAME_SET_MAX_FRAMES) defects.push(`a set holds at most ${FRAME_SET_MAX_FRAMES} frames`);
  const variants = input.variants ?? [];
  if (variants.length > FRAME_SET_MAX_VARIANTS) defects.push(`a set holds at most ${FRAME_SET_MAX_VARIANTS} variants`);
  const numbers = new Set<number>();
  for (const variant of variants) {
    if (!Number.isInteger(variant.number) || variant.number < 1 || variant.number > FRAME_SET_MAX_VARIANTS) defects.push(`variant number ${variant.number} is outside 1..${FRAME_SET_MAX_VARIANTS}`);
    else if (numbers.has(variant.number)) defects.push(`variant ${variant.number} is listed twice`);
    numbers.add(variant.number);
    if (!variant.title.trim()) defects.push(`variant ${variant.number} needs a title`);
  }
  input.frames.forEach((frame, index) => {
    const where = `frame ${index + 1}`;
    if (!frame.path.startsWith("/")) defects.push(`${where} needs an absolute local path`);
    if (frame.variant !== undefined && !numbers.has(frame.variant)) defects.push(`${where} names variant ${frame.variant}, which the set does not list`);
    if ((frame.caption ?? "").length > FRAME_CAPTION_MAX_CHARS) defects.push(`${where} has a caption longer than ${FRAME_CAPTION_MAX_CHARS} characters`);
    const size = sizes[index];
    if (size !== undefined && size > FRAME_MAX_BYTES) defects.push(`${where} is larger than ${FRAME_MAX_BYTES / 1024 / 1024} MB`);
  });
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > FRAME_SET_MAX_BYTES) defects.push(`the set is larger than ${FRAME_SET_MAX_BYTES / 1024 / 1024} MB`);
  return defects;
}

/** A variant's frames in the set's own order. */
export function framesOfVariant(set: FrameSet, variant: number): Frame[] {
  return set.frames.filter((frame) => frame.variant === variant);
}

/** The first frame of each variant: what a collage's closed row and a Telegram album show. */
export function coverFrames(set: FrameSet): Frame[] {
  return set.variants.flatMap((variant) => framesOfVariant(set, variant.number).slice(0, 1));
}

/** The views a set was captured at, in first-seen order: one per width and language. */
export function viewsOf(set: FrameSet): { key: string; width: number | null; lang: string | null }[] {
  const views = new Map<string, { key: string; width: number | null; lang: string | null }>();
  for (const frame of set.frames) {
    const key = viewKey(frame);
    if (!views.has(key)) views.set(key, { key, width: frame.width, lang: frame.lang });
  }
  return [...views.values()];
}

export function viewKey(frame: Pick<Frame, "width" | "lang">): string {
  return `${frame.width ?? "-"}:${frame.lang ?? "-"}`;
}

/** The frame of `variant` taken at the same width and language, for a side-by-side compare. */
export function frameAtView(set: FrameSet, variant: number, view: string): Frame | null {
  return framesOfVariant(set, variant).find((frame) => viewKey(frame) === view) ?? null;
}

/** One step along a list that stops at either end. */
export function stepIndex(index: number, direction: -1 | 1, length: number): number {
  return Math.min(Math.max(index + direction, 0), Math.max(0, length - 1));
}

/** A horizontal swipe: further than `threshold` px sideways and more sideways than vertical. */
export function swipeDirection(dx: number, dy: number, threshold = 40): -1 | 1 | 0 {
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

/** The reply a chosen variant puts into the composer: a sentence the operator can edit or send as is. */
export function chosenReply(set: FrameSet, variant: number, lang: "en" | "uk"): string {
  const title = set.variants.find((entry) => entry.number === variant)?.title.trim();
  const word = lang === "uk" ? "Варіант" : "Variant";
  return title ? `${word} ${variant} (${title}).` : `${word} ${variant}.`;
}

/** "4 variants · 24 frames", the closed row's whole description of a set. */
export function setCounts(set: FrameSet, lang: "en" | "uk"): string {
  const plural = (count: number, one: string, few: string, many: string) => {
    if (lang === "en") return count === 1 ? one : many;
    const tens = count % 100;
    const units = count % 10;
    if (units === 1 && tens !== 11) return one;
    return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
  };
  const frames = `${set.frames.length} ${lang === "uk" ? plural(set.frames.length, "кадр", "кадри", "кадрів") : plural(set.frames.length, "frame", "", "frames")}`;
  if (set.variants.length === 0) return frames;
  const variants = `${set.variants.length} ${lang === "uk" ? plural(set.variants.length, "варіант", "варіанти", "варіантів") : plural(set.variants.length, "variant", "", "variants")}`;
  return `${variants} · ${frames}`;
}
