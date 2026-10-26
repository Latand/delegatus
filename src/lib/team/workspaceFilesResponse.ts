import { createHash } from "node:crypto";

import { acceptsGzip, gzipBody } from "@/lib/http/gzipBody";
import type { workspaceScope } from "./workspaceAccess";
import { workspaceFiles } from "./workspaceProjection";
import { workspaceDenied } from "./workspaceRoute";

type Scope = ReturnType<typeof workspaceScope>;
type AfterResponse = (work: () => Promise<void>) => void;
type Entry = { sourceEtag: string; etag: string; bytes: Uint8Array };
const MAX_ENTRIES = 16;
const MAX_BYTES = 32 * 1024 * 1024;

/** One bounded cache per route module. Its key includes the freshly verified
 * authority; a validator from another scope never certifies this response. */
export function createWorkspaceFilesResponder(
  sourceResponse: (request: Request, after: AfterResponse) => Promise<Response>,
  refresh: (request: Request) => Scope | null,
) {
  const cache = new Map<string, Entry>();
  let retainedBytes = 0;
  const signature = (scope: Scope | null) => JSON.stringify(scope && [scope.memberId, scope.owner, scope.projectFilter]);
  return async (request: Request, scope: Scope, after: AfterResponse): Promise<Response> => {
    const authority = signature(scope);
    const key = JSON.stringify([request.url, authority]);
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); }
    const headers = new Headers(request.headers);
    // Operator deltas and board encodings cannot be projected as member JSON.
    for (const name of [...headers.keys()]) {
      if (/^(?:if-|accept-encoding|x-llv-|x-board-)/i.test(name)
        && !/^x-llv-files-(?:revision|generation)$/i.test(name)) headers.delete(name);
    }
    if (cached) headers.set("if-none-match", cached.sourceEtag);
    const source = await sourceResponse(new Request(request.url, { headers, signal: request.signal }), after);
    let entry = cached;
    if (source.status === 200) {
      const sourceEtag = source.headers.get("etag") ?? "";
      if (cached && sourceEtag && sourceEtag === cached.sourceEtag) await source.body?.cancel();
      else {
        const data = await source.json();
        const latest = refresh(request);
        if (!latest || signature(latest) !== authority) return workspaceDenied();
        const bytes = new TextEncoder().encode(JSON.stringify(workspaceFiles(latest, data)));
        entry = { sourceEtag, bytes, etag: `"${createHash("sha256").update(authority).update(bytes).digest("hex")}"` };
        // Another request may have replaced or evicted our starting entry
        // while the source read was pending. Account only for what is held now.
        const previous = cache.get(key);
        if (previous) { cache.delete(key); retainedBytes -= previous.bytes.byteLength; }
        // An oversized response is served once without retaining it.
        if (sourceEtag && bytes.byteLength <= MAX_BYTES) {
          cache.set(key, entry);
          retainedBytes += bytes.byteLength;
          while (cache.size > MAX_ENTRIES || retainedBytes > MAX_BYTES) {
            const oldest = cache.keys().next().value!;
            retainedBytes -= cache.get(oldest)!.bytes.byteLength;
            cache.delete(oldest);
          }
        }
      }
    } else if (source.status !== 304 || !cached) {
      await source.body?.cancel();
      return Response.json({ error: "board unavailable" }, { status: 503 });
    }
    if (!entry || signature(refresh(request)) !== authority) return workspaceDenied();
    const responseHeaders = new Headers({
      "cache-control": "private, no-cache",
      "content-type": "application/json",
      vary: "cookie, authorization, accept-encoding",
      etag: entry.etag,
    });
    for (const name of ["x-llv-files-generation", "x-llv-files-target-generation", "x-llv-files-built"]) {
      const value = source.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (request.headers.get("if-none-match") === entry.etag) return new Response(null, { status: 304, headers: responseHeaders });
    const compressed = acceptsGzip(request) && entry.bytes.byteLength >= 1024;
    const bytes = compressed ? await gzipBody(entry.bytes) : entry.bytes;
    if (signature(refresh(request)) !== authority) return workspaceDenied();
    if (compressed) responseHeaders.set("content-encoding", "gzip");
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const end = Math.min(offset + 256 * 1024, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        if (offset === bytes.byteLength) controller.close();
        else await new Promise<void>(resolve => setImmediate(resolve));
      },
    }), { headers: responseHeaders });
  };
}
