import { decodeHTML } from "entities";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip } from "node:zlib";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { checkPageUrl, PageReadError, type CheckedPageUrl, type PagePolicyRuntime, type PageRefusal } from "./pageUrlPolicy";

export type PageReadResult = { status: "ok" | "denied" | "error"; output: string; truncated: boolean; code?: string; refusal?: PageRefusal };
export type PageReadOptions = { signal: AbortSignal; deadlineAt?: number };
export type PageReaderRuntime = PagePolicyRuntime & {
  /** Test-only transport seam; request data never selects it. */
  dial?: typeof http.request;
};
const MAX_BODY = 2 * 1024 * 1024;
const redirects = new Set([301, 302, 303, 307, 308]);
export function pageReadFailure(error: unknown): PageReadResult {
  const failure = error instanceof PageReadError ? error : new PageReadError("unreachable");
  return { status: failure.refusal ? "denied" : "error", code: failure.code,
    output: failure.message, truncated: false, ...(failure.refusal ? { refusal: failure.refusal } : {}) };
}
async function dialPage(target: CheckedPageUrl, runtime: PageReaderRuntime, signal: AbortSignal): Promise<{ status: number; location?: string; type: string; bytes: Buffer }> {
  const { url, addresses } = target;
  return new Promise((resolve, reject) => {
    let settled = false;
    const requestOptions: https.RequestOptions = {
      protocol: url.protocol, hostname: addresses[0]!.address, family: addresses[0]!.family,
      port: url.protocol === "https:" ? 443 : 80,
      ...(isIP(url.hostname.replace(/^\[|\]$/g, "")) ? {} : { servername: url.hostname.replace(/^\[|\]$/g, "") }),
      path: url.pathname + url.search, method: "GET", agent: false, signal,
      headers: { Host: url.host, "User-Agent": "Delegatus-PageReader/1", Accept: "text/html, application/xhtml+xml, text/plain, text/markdown, application/json", "Accept-Encoding": "gzip, br, identity" },
    };
    const request = (runtime.dial ?? (url.protocol === "https:" ? https.request : http.request))(requestOptions);
    let timer = setTimeout(() => fail(new PageReadError("timeout")), 8000);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); request.destroy(); reject(error);
    };
    request.on("error", (error: NodeJS.ErrnoException) => fail(signal.aborted ? new PageReadError("timeout")
      : new PageReadError(/CERT|TLS|SSL|SELF_SIGNED|ALTNAME/.test(error.code ?? "") ? "tls" : "unreachable")));
    request.on("response", response => { void (async () => {
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const type = response.headers["content-type"] ?? "";
      if (redirects.has(status) && location) {
        response.destroy(); settled = true; resolve({ status, location, type, bytes: Buffer.alloc(0) }); return;
      }
      if (status !== 200) { response.destroy(); fail(new PageReadError("http_status")); return; }
      if (!/^(text\/(html|plain|markdown)|application\/(xhtml\+xml|json))(?:;|$)/i.test(type)) {
        response.destroy(); fail(new PageReadError("unsupported_content")); return;
      }
      timer = setTimeout(() => fail(new PageReadError("timeout")), 10_000);
      const encoding = response.headers["content-encoding"]?.toLowerCase();
      if (encoding && !["gzip", "br", "identity"].includes(encoding)) {
        response.destroy(); fail(new PageReadError("unsupported_content")); return;
      }
      const decompressor = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : null;
      const decoded = decompressor ?? response;
      if (decompressor) {
        response.on("error", error => decompressor.destroy(error));
        response.pipe(decompressor);
      }
      const chunks: Buffer[] = []; let size = 0;
      try {
        for await (const part of decoded) {
          const chunk = Buffer.from(part); size += chunk.length;
          if (size > MAX_BODY) throw new PageReadError("unsupported_content");
          chunks.push(chunk);
        }
        if (!settled) { settled = true; clearTimeout(timer); resolve({ status, type, bytes: Buffer.concat(chunks) }); }
      } catch (error) { decoded.destroy(); response.destroy(); fail(error); }
    })().catch(fail); });
    request.end();
  });
}
async function pageText(bytes: Buffer, type: string) {
  let text: string;
  try { text = new TextDecoder(/charset\s*=\s*["']?([^;"'\s]+)/i.exec(type)?.[1] ?? "utf-8").decode(bytes); }
  catch { throw new PageReadError("unsupported_content"); }
  let title = "";
  if (/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)) {
    const clean = await new HTMLRewriter().on("script,style,noscript,template,svg,iframe", { element(element) { element.remove(); } })
      .transform(new Response(text)).text();
    const parts: string[] = [];
    await new HTMLRewriter().on("title", { text(chunk) { title += chunk.text; } })
      .on("p,div,br,h1,h2,h3,h4,h5,h6,li,tr,td,section,article,header,footer,title", { element(element) { parts.push(" "); element.onEndTag(() => { parts.push(" "); }); } })
      .onDocument({ text(chunk) { parts.push(chunk.text); } }).transform(new Response(clean)).text();
    title = decodeHTML(title);
    text = decodeHTML(parts.join("")).replace(/\s+/g, " ").trim();
  }
  const encoded = Buffer.from(text);
  return { title: title.slice(0, 512), text: new TextDecoder().decode(encoded.subarray(0, 16_384), { stream: encoded.length > 16_384 }), truncated: encoded.length > 16_384 };
}
export function createPageReader(runtime: PageReaderRuntime = {}) {
  return {
    checkPageUrl: (url: string, options: { signal?: AbortSignal; hop?: number } = {}) => checkPageUrl(url, runtime, options),
    async readPublicPage(input: string, options: PageReadOptions): Promise<PageReadResult> {
      return withViewerOperation("relay.page-read", async () => {
        if (options.signal.aborted || Date.now() >= (options.deadlineAt ?? Infinity)) return pageReadFailure(new PageReadError("timeout"));
        const budget = Math.max(1, Math.min(20_000, (options.deadlineAt ?? Infinity) - Date.now()));
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(budget)]);
        try {
          let next = input;
          for (let hop = 0; ; hop++) {
            signal.throwIfAborted();
            const checked = await checkPageUrl(next, runtime, { signal, hop });
            const response = await dialPage(checked, runtime, signal);
            if (response.location) {
              if (hop >= 5) throw new PageReadError("too_many_redirects");
              try { next = new URL(response.location, checked.url).href; }
              catch { throw new PageReadError("invalid_url"); }
              continue;
            }
            const { truncated, ...content } = await pageText(response.bytes, response.type);
            return { status: "ok", output: JSON.stringify({ url: checked.url.href, ...content }), truncated };
          }
        } catch (error) { return pageReadFailure(signal.aborted ? new PageReadError("timeout") : error); }
      });
    },
  };
}
export const pageReader = createPageReader();
export const readPublicPage = pageReader.readPublicPage;
export type PageReader = ReturnType<typeof createPageReader>;
