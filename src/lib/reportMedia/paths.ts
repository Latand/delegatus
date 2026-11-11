/*
 * Which picture paths a written text names. Free of every other module, so a
 * writer of reports or tasks can ask before anything heavier is loaded.
 */

/* An absolute or home-relative path that ends in a picture extension, as a
   text writes it bare, as a link target or as a file URL. It starts where no
   path character precedes it, so the tail of a relative path is left alone. */
const PICTURE_PATH = /(?<![\w.~/\\-])(?:file:\/\/)?(~?\/[^\s"'`<>()[\]{}|*,;]+?\.(?:png|jpe?g|gif|webp|avif|bmp))(?![\w/-])/gi;

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
    if (!text) continue;
    for (const match of text.matchAll(PICTURE_PATH)) found.add(match[1]!);
  }
  return [...found];
}

/**
 * Keeps the pictures a just-written record names, beside the write: the
 * caller neither waits nor fails, whatever happens to the pictures. `lane` is
 * the pipeline the record belongs to, when it has one.
 */
export function keepReportPicturesSoon(record: unknown, lane?: string): void {
  const texts = recordTexts(record);
  if (writtenPicturePaths(texts).length === 0) return;
  void import("./store").then(({ keepReportPictures }) => keepReportPictures(texts, { lane })).catch((error) => {
    console.warn(`[report-media] pictures were not kept: ${error instanceof Error ? error.message : String(error)}`);
  });
}
