import { Window } from "happy-dom";
import { Worker } from "node:worker_threads";

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

export function evidenceHtmlImageSources(source: string): string[] {
  const window = new Window({ settings: { disableComputedStyleRendering: true } });
  try {
    const document = new window.DOMParser().parseFromString(source, "text/html");
    return [...new Set([...document.querySelectorAll("img[src]")]
      .map(image => image.getAttribute("src")?.trim() ?? "").filter(Boolean))];
  } finally { window.happyDOM.abort(); }
}

type EvidenceHtmlWorkerRequest =
  | { operation: "images"; source: string }
  | { operation: "transform"; source: string; baseHref?: string; inlineImages?: Array<[string, string]> };

/** Parse untrusted reports away from the Viewer event loop; terminate on the request deadline or disconnect. */
function runEvidenceHtmlWorker<T>(request: EvidenceHtmlWorkerRequest, deadline: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (signal.aborted) return reject(new Error("client aborted"));
    if (remaining <= 0) return reject(new Error("artifact time budget exceeded"));
    let settled = false;
    const worker = new Worker(new URL("./evidenceHtml.worker.ts", import.meta.url), { workerData: request });
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
      if (!settled && code !== 0) finish(new Error(`evidence HTML worker exited (${code})`));
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
      for (const image of document.querySelectorAll("img[src]")) {
        const original = image.getAttribute("src")?.trim() ?? "";
        const inline = inlineImages.get(original);
        if (inline) image.setAttribute("src", inline);
        else if (!original.startsWith("data:image/")) image.removeAttribute("src");
      }
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
