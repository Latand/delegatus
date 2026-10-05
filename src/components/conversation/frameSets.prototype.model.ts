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
/** A variant's title stands whole beside its "Choose" button; in a 390 px pane 60 characters are about two lines. */
export const FRAME_VARIANT_TITLE_MAX_CHARS = 60;
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
    if (variant.title.trim().length > FRAME_VARIANT_TITLE_MAX_CHARS) defects.push(`variant ${variant.number} has a title longer than ${FRAME_VARIANT_TITLE_MAX_CHARS} characters`);
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

/** "4 variants · 24 frames", the closed row's whole description of a set;
    `brief` keeps the frames alone, for a row too narrow for both. */
export function setCounts(set: FrameSet, lang: "en" | "uk", brief = false): string {
  const plural = (count: number, one: string, few: string, many: string) => {
    if (lang === "en") return count === 1 ? one : many;
    const tens = count % 100;
    const units = count % 10;
    if (units === 1 && tens !== 11) return one;
    return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
  };
  const frames = `${set.frames.length} ${lang === "uk" ? plural(set.frames.length, "кадр", "кадри", "кадрів") : plural(set.frames.length, "frame", "", "frames")}`;
  if (set.variants.length === 0 || brief) return frames;
  const variants = `${set.variants.length} ${lang === "uk" ? plural(set.variants.length, "варіант", "варіанти", "варіантів") : plural(set.variants.length, "variant", "", "variants")}`;
  return `${variants} · ${frames}`;
}

/* ── The short form of a publication: a directory read by its file names ── */

/** The interface languages a file name can carry. */
export const FRAME_NAME_LANGS = ["en", "uk"] as const;

/**
 * What one file name says about its frame, by the one convention the capture
 * drivers already follow: `variant-<N>-<anything>-<width>-<lang>-<moment>.png`.
 * Words are split on `-` and `_`. `variant-N` (or a leading `vN`) is the
 * variant, and variant 0 is a frame of no variant (the pane as it is today).
 * The viewport width is the first number from 240 to 3840 that follows the
 * variant, so a number before it (`pr-2521-variant-2-…`) is part of the
 * caption; a name with no variant gives its first such number. A `WxH` word
 * (`1440x900`) is a width too. The first word that is an interface language
 * is the language, and the words left over are the caption. A name that says
 * none of it is a plain captioned frame.
 */
export function frameFromFileName(name: string): { variant: number | null; width: number | null; lang: string | null; caption: string } {
  const words = name.replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "").split(/[-_]+/).filter(Boolean);
  const lowered = words.map((word) => word.toLowerCase());
  const named = lowered.findIndex((word, at) => word === "variant" && /^\d$/.test(words[at + 1] ?? ""));
  const variantAt = named >= 0 ? named : /^v\d$/.test(lowered[0] ?? "") ? 0 : -1;
  const variantWords = variantAt < 0 ? 0 : named >= 0 ? 2 : 1;
  const variant = variantAt < 0 ? null : Number(named >= 0 ? words[variantAt + 1] : lowered[0]!.slice(1));
  const widthOf = (word: string) => {
    const size = /^(\d{3,4})(?:x\d{3,4})?$/i.exec(word);
    return size && Number(size[1]) >= 240 && Number(size[1]) <= 3840 ? Number(size[1]) : null;
  };
  let width: number | null = null;
  let lang: string | null = null;
  const rest: string[] = [];
  for (let at = 0; at < words.length; at += 1) {
    if (variantAt >= 0 && at >= variantAt && at < variantAt + variantWords) continue;
    const word = words[at]!;
    if (width === null && at > variantAt && widthOf(word) !== null) { width = widthOf(word); continue; }
    if (lang === null && (FRAME_NAME_LANGS as readonly string[]).includes(lowered[at]!)) { lang = lowered[at]!; continue; }
    rest.push(word);
  }
  return { variant: variant === 0 ? null : variant, width, lang, caption: rest.join(" ") };
}

/** The frames of a directory in publication order: by variant, then by name
    with numbers compared as numbers, frames of no variant last. */
export function framesFromFileNames(names: readonly string[]): (ReturnType<typeof frameFromFileName> & { name: string })[] {
  return names
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .map((name) => ({ name, ...frameFromFileName(name) }))
    .sort((a, b) => (a.variant ?? 99) - (b.variant ?? 99) || a.name.localeCompare(b.name, "en", { numeric: true }));
}

/* ── Where a published frame may be read from ───────────────────────────── */

/** The roots the image route reads under (`lexicalAllowedRoots` in `src/lib/artifact/localFile.ts`). */
export interface FrameSourceRoots {
  home: string;
  evidence: readonly string[];
}

const underRoot = (candidate: string, root: string) => candidate === root || candidate.startsWith(`${root.replace(/\/+$/, "")}/`);

/**
 * Which root admits a frame's path or a frames directory: the same answer the
 * image route gives a raster (`admittedAs`), so a set can hold exactly what a
 * thumbnail in the feed could show. A lane's worktree and a stage's own
 * directory are under home; `/var/tmp` is the default evidence root; the
 * operating system's `/tmp` is under neither.
 */
export function frameSourceRoot(path: string, roots: FrameSourceRoots): "home" | "evidence" | null {
  if (underRoot(path, roots.home)) return "home";
  return roots.evidence.some((root) => underRoot(path, root)) ? "evidence" : null;
}

/**
 * What the tool answers for a path no root admits, or null when one does. The
 * sentence names every place that is read and the one command that moves the
 * frames there, so the agent's next call succeeds without a second question.
 */
export function frameSourceRefusal(path: string, roots: FrameSourceRoots): string | null {
  if (frameSourceRoot(path, roots) !== null) return null;
  const evidence = roots.evidence[0];
  const places = ["your worktree (the capture drivers write to .artifacts/ in it)", "the stage's own directory ($TMPDIR)", ...roots.evidence];
  const directory = /\.[a-z0-9]+$/i.test(path) ? path.replace(/\/[^/]*$/, "") : path.replace(/\/+$/, "");
  const copy = evidence ? `${evidence}/frames-${directory.split("/").filter(Boolean).slice(-2).join("-")}` : null;
  const move = copy ? ` Nothing was published. Copy the frames and call again with the copy: cp -r ${directory} ${copy}` : " Nothing was published.";
  return `${path} is outside what Delegatus reads. Frames are read from: ${places.join("; ")}.${move}`;
}

/* ── The collage's layout ───────────────────────────────────────────────── */

export interface TileRow {
  height: number;
  tiles: { index: number; width: number }[];
}

/**
 * Frames at their own proportions in rows that fill `width`: a row takes
 * frames at `target` height until the next one would not fit, then grows to
 * fill the width, by at most `maxScale`. The last row grows the same way, so a
 * few frames never stretch into giants. `minTile` keeps a narrow frame wide
 * enough to press.
 */
export function justifiedRows(aspects: readonly number[], width: number, options: { target: number; gap: number; minTile?: number; maxScale?: number }): TileRow[] {
  const { target, gap, minTile = 0, maxScale = 1.25 } = options;
  const natural = (aspect: number) => Math.max(minTile, aspect * target);
  const rows: TileRow[] = [];
  let row: number[] = [];
  const close = () => {
    if (row.length === 0) return;
    const sum = row.reduce((total, index) => total + natural(aspects[index]!), 0);
    const scale = Math.max(1, Math.min(maxScale, (width - gap * (row.length - 1)) / sum));
    /* A single frame wider than the row is drawn at the row's width. */
    const fit = Math.min(scale, sum > width ? width / sum : scale);
    rows.push({ height: Math.round(target * fit), tiles: row.map((index) => ({ index, width: Math.floor(natural(aspects[index]!) * fit) })) });
    row = [];
  };
  aspects.forEach((aspect, index) => {
    const taken = row.reduce((total, at) => total + natural(aspects[at]!), 0) + gap * row.length;
    if (row.length > 0 && taken + natural(aspect) > width) close();
    row.push(index);
  });
  close();
  return rows;
}

/** One row at `height` that scrolls sideways past its edge: the collage in a
    narrow pane, where the height is what runs out. */
export function stripTiles(aspects: readonly number[], height: number, minTile = 0): TileRow {
  return { height, tiles: aspects.map((aspect, index) => ({ index, width: Math.max(minTile, Math.round(aspect * height)) })) };
}
