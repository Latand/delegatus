/*
 * Which picture paths a written text names. Free of every other module, so a
 * writer of reports or tasks can ask before anything heavier is loaded.
 */

/** A written path longer than this is not read as one. */
const PATH_CHARS = 1024;
/** Paths read from one written record; the rest are left alone. */
export const WRITTEN_PATHS_PER_RECORD = 512;

/* An absolute or home-relative path that ends in a picture extension, as a
   text writes it bare, as a link target or as a file URL. It starts where no
   path character and no URL scheme precedes it, so the tail of a relative
   path and the path of a web address are left alone; it ends where the name
   ends, so `shot.png.bak` names no picture. The bounded run keeps the search
   linear in the text. */
const PICTURE_PATH = new RegExp(
  String.raw`(?<![\w.~/\\:-])(?:file:\/\/)?(~?\/(?!\/)[^\s"'\`<>()[\]{}|*,;]{1,${PATH_CHARS}}?\.(?:png|jpe?g|gif|webp|avif|bmp))(?![\w/-]|\.\w)`,
  "gi",
);

/** Every string a record holds, at any depth: the texts of a structured
    report, whose pictures are named in its fields. */
export function recordTexts(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) recordTexts(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) recordTexts(item, into);
  return into;
}

/** The picture paths these texts name as written, each once, in order. */
export function writtenPicturePaths(texts: readonly (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text || !text.includes("/")) continue;
    for (const match of text.matchAll(PICTURE_PATH)) {
      found.add(match[1]!);
      if (found.size >= WRITTEN_PATHS_PER_RECORD) return [...found];
    }
  }
  return [...found];
}

/**
 * Keeps the pictures a just-written record names, beside the write: the
 * caller neither waits nor fails, whatever happens to the pictures. `lane` is
 * the pipeline the record belongs to, when it has one.
 */
export function keepReportPicturesSoon(record: unknown, lane?: string): void {
  const written = writtenPicturePaths(recordTexts(record));
  if (written.length === 0) return;
  void import("./store").then(({ keepWrittenPictures }) => keepWrittenPictures(written, { lane })).catch((error) => {
    console.warn(`[report-media] pictures were not kept: ${error instanceof Error ? error.message : String(error)}`);
  });
}
