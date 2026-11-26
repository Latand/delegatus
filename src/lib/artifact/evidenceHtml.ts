import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Window, type Element } from "happy-dom";

/**
 * Parse with a standards-oriented HTML5 tree builder before sanitizing. A
 * token scanner can disagree with the browser about malformed tags, raw-text
 * elements, comments and character references, leaving a navigation node in
 * the browser's recovered tree. The parser has resource loading disabled by
 * default; the returned document is inert and never connected to a window.
 */
export function containEvidenceHtml(source: string, baseHref?: string): string {
  return transformEvidenceHtml(source, baseHref);
}

/** Read srcset URL tokens, keeping internal commas (including in data URLs). */
function* srcsetUrls(value: string): Generator<string> {
  // HTML first takes a non-whitespace URL, then skips descriptors up to the
  // next comma outside parentheses. Trailing URL commas end the candidate.
  const url = /[^\t\n\f\r ]+/y;
  const separators = /[,\t\n\f\r ]*/y;
  const descriptors = /(?:[^,(]|\([^)]*(?:\)|$))*,?/y;
  let offset = 0;
  while (offset < value.length) {
    separators.lastIndex = offset;
    separators.exec(value);
    url.lastIndex = separators.lastIndex;
    const token = url.exec(value)?.[0];
    if (!token) break;
    let end = token.length;
    while (token[end - 1] === ",") end--;
    yield token.slice(0, end);
    offset = url.lastIndex;
    if (end === token.length) {
      descriptors.lastIndex = offset;
      descriptors.exec(value);
      offset = descriptors.lastIndex;
    }
  }
}

/** Prefer the report's fallback, then look for a usable responsive candidate. */
function* rasterCandidates(image: Element): Generator<string> {
  const fallback = image.getAttribute("src")?.trim();
  if (fallback) yield fallback;
  yield* srcsetUrls(image.getAttribute("srcset") ?? "");
  if (image.parentElement?.localName === "picture") {
    for (const child of image.parentElement.children) {
      if (child === image) break;
      if (child.localName === "source") yield* srcsetUrls(child.getAttribute("srcset") ?? "");
    }
  }
}

export function evidenceHtmlImageSources(source: string): string[] {
  const window = new Window({ settings: { disableComputedStyleRendering: true } });
  try {
    const document = new window.DOMParser().parseFromString(source, "text/html");
    const urls = new Set<string>();
    for (const image of document.querySelectorAll("img")) {
      for (const source of rasterCandidates(image)) urls.add(source);
    }
    return [...urls];
  } finally { window.happyDOM.abort(); }
}

export type EvidenceHtmlWorkerRequest =
  | { operation: "images"; source: string }
  | { operation: "transform"; source: string; baseHref?: string; inlineImages?: Array<[string, string]> };

/** Parse untrusted reports away from the Viewer event loop; terminate on the request deadline or disconnect. */
function runEvidenceHtmlWorker<T>(request: EvidenceHtmlWorkerRequest, deadline: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (signal.aborted) return reject(new Error("client aborted"));
    if (remaining <= 0) return reject(new Error("artifact time budget exceeded"));
    let settled = false;
    const bundled = path.join(process.cwd(), ".next/server/evidence-html-worker.js");
    const source = path.join(process.cwd(), "src/lib/artifact/evidenceHtml.worker.ts");
    const worker = new Worker(existsSync(bundled) ? bundled : source, { workerData: request });
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(new Error("client aborted"));
    const timer = setTimeout(() => finish(new Error("artifact time budget exceeded")), remaining);
    worker.once("message", (value: T) => finish(undefined, value));
    worker.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", code => {
      if (!settled) finish(new Error(`evidence HTML worker exited (${code})`));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function evidenceHtmlImageSourcesWithinBudget(source: string, deadline: number, signal: AbortSignal): Promise<string[]> {
  return runEvidenceHtmlWorker<string[]>({ operation: "images", source }, deadline, signal);
}

export function transformEvidenceHtmlWithinBudget(source: string, baseHref: string | undefined, inlineImages: ReadonlyMap<string, string> | undefined,
  deadline: number, signal: AbortSignal): Promise<string> {
  return runEvidenceHtmlWorker<string>({ operation: "transform", source, baseHref, inlineImages: inlineImages ? [...inlineImages] : undefined }, deadline, signal);
}

export function transformEvidenceHtml(source: string, baseHref?: string, inlineImages?: ReadonlyMap<string, string>): string {
  const window = new Window({ settings: { disableComputedStyleRendering: true } });
  try {
    const document = new window.DOMParser().parseFromString(source, "text/html");
    // Template contents are not in document.querySelectorAll(); Chromium can
    // activate declarative shadow roots when it parses this serialized result.
    // Drop every template so inert navigation markup cannot become live later.
    for (const node of document.querySelectorAll("template, script, base")) node.remove();
    for (const node of document.querySelectorAll("meta[http-equiv]")) {
      if (node.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") node.remove();
    }
    for (const node of document.querySelectorAll("a, area")) {
      for (const attribute of ["href", "xlink:href", "target", "ping", "attributionsrc"]) node.removeAttribute(attribute);
    }
    if (inlineImages) {
      // IPv6 CSP permits data images. Select a usable raster for each image
      // before clearing the responsive attributes that can override its src.
      for (const image of document.querySelectorAll("img")) {
        for (const source of rasterCandidates(image)) {
          const inline = source.startsWith("data:image/") ? source : inlineImages.get(source);
          if (inline) {
            image.setAttribute("src", inline);
            break;
          }
        }
        if (!image.getAttribute("src")?.startsWith("data:image/")) image.removeAttribute("src");
        image.removeAttribute("srcset");
      }
      for (const source of document.querySelectorAll("picture source[srcset]")) source.removeAttribute("srcset");
    }
    if (baseHref) {
      const base = document.createElement("base");
      base.setAttribute("href", baseHref);
      document.head.prepend(base);
    }
    return `<!doctype html>${document.documentElement.outerHTML}`;
  } finally {
    window.happyDOM.abort();
  }
}
