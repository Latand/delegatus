import { Window } from "happy-dom";

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

export function transformEvidenceHtml(source: string, baseHref?: string, inlineImages?: ReadonlyMap<string, string>): string {
  const window = new Window({ settings: { disableComputedStyleRendering: true } });
  try {
    const document = new window.DOMParser().parseFromString(source, "text/html");
    for (const node of document.querySelectorAll("script, base")) node.remove();
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
