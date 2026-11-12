import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { CONTROL_REQUEST_HEADER, controlRequestId } from "./controlRequest";

let pendingEvidence = 0;
let evidenceWarning = false;

/** The internal hop uses a fresh connection. Socket ownership, errors and byte
 * counters are observable here; no opaque fetch pool or short idle timer can
 * silently close an active request. The caller owns the only deadline. */
export function controlFetch(input: URL, init: RequestInit = {}): Promise<Response> {
  if (!["http:", "https:"].includes(input.protocol)) {
    return Promise.reject(new Error("MCP control requires HTTP or HTTPS"));
  }
  const headers = new Headers(init.headers);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  const id = headers.get(CONTROL_REQUEST_HEADER) ?? controlRequestId();
  headers.set(CONTROL_REQUEST_HEADER, id);
  const record = (event: "start" | "response" | "close" | "error", read = 0, written = 0, code?: string) => {
    // Preserve the adapter's light startup graph. Bound diagnostic work even
    // while the optional writer module is still loading.
    if (pendingEvidence >= 256) return;
    pendingEvidence++;
    void import("./controlEvidence").then(({ controlEvidenceStore }) => controlEvidenceStore("client").event(id, event, read, written, code, `${init.method ?? "GET"} ${input.pathname}`))
      .catch(() => { if (!evidenceWarning) { evidenceWarning = true; console.error("[mcp-http] client evidence unavailable"); } })
      .finally(() => { pendingEvidence--; });
  };
  record("start");
  return new Promise((resolve, reject) => {
    let received = false;
    let failureCode: string | undefined;
    let socketFailure: Error | undefined;
    let detachRequest = () => {};
    const request = (input.protocol === "https:" ? https : http).request(input, { method: init.method ?? "GET", headers: Object.fromEntries(headers), agent: false, signal: init.signal ?? undefined }, response => {
      received = true;
      detachRequest();
      record("response", response.socket?.bytesRead, response.socket?.bytesWritten, `HTTP_${response.statusCode}`);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
        else responseHeaders.set(key, value);
      }
      const status = response.statusCode ?? 502;
      response.once("error", error => record("error", response.socket?.bytesRead, response.socket?.bytesWritten, (error as NodeJS.ErrnoException).code ?? "RESPONSE_ERROR"));
      const empty = [204, 205, 304].includes(status) || init.method === "HEAD";
      if (empty) response.resume();
      let done = false;
      let detachBody = () => {};
      const body = empty ? null : new ReadableStream<Uint8Array>({
        start(controller) {
          response.pause();
          const finish = (error?: unknown) => {
            if (done) return;
            done = true; init.signal?.removeEventListener("abort", abort);
            if (error) controller.error(error); else controller.close();
          };
          const abort = () => { finish(init.signal?.reason ?? new Error("MCP response cancelled")); response.destroy(); };
          detachBody = () => init.signal?.removeEventListener("abort", abort);
          response.on("data", (chunk: Buffer) => { if (!done) { controller.enqueue(chunk); if ((controller.desiredSize ?? 0) <= 0) response.pause(); } });
          response.once("end", () => finish());
          response.once("error", error => finish(error));
          response.once("aborted", () => finish(new Error("MCP control response was interrupted")));
          response.once("close", () => { if (!done) finish(new Error("MCP control response closed before its body completed")); });
          init.signal?.addEventListener("abort", abort, { once: true });
          if (init.signal?.aborted) abort();
        },
        pull() { response.resume(); },
        cancel() { done = true; detachBody(); response.destroy(); },
      });
      let decoded = body;
      const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
      if (body && encoding && ["gzip", "deflate", "br"].includes(encoding)) {
        const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : createBrotliDecompress();
        source.once("error", error => decoder.destroy(error));
        decoder.once("close", () => source.destroy());
        decoded = Readable.toWeb(source.pipe(decoder)) as ReadableStream<Uint8Array>;
      }
      resolve(new Response(decoded, { status, headers: responseHeaders }));
    });
    request.once("socket", socket => {
      socket.once("error", error => {
        socketFailure = error;
        failureCode = (error as NodeJS.ErrnoException).code;
        record("error", socket.bytesRead, socket.bytesWritten, failureCode);
      });
      socket.once("close", () => {
        detachRequest();
        record("close", socket.bytesRead, socket.bytesWritten);
        // Bun's Node adapter can close a reset socket before it emits the
        // ClientRequest error. Settle that path here as well.
        if (!received) {
          if (!failureCode) record("error", socket.bytesRead, socket.bytesWritten, init.signal?.aborted ? "ABORT_ERR" : "ECONNRESET");
          reject(init.signal?.aborted ? init.signal.reason : socketFailure ?? Object.assign(new Error("MCP control socket closed before response headers"), { code: "ECONNRESET" }));
        }
      });
    });
    request.once("error", error => {
      detachRequest();
      failureCode = (error as NodeJS.ErrnoException).code;
      record("error", request.socket?.bytesRead, request.socket?.bytesWritten, (error as NodeJS.ErrnoException).code);
      reject(error);
    });
    // Some Bun HTTP failure paths never emit ClientRequest.error. The owned
    // deadline must settle the headers wait independently of that adapter.
    const abortRequest = () => {
      const reason = init.signal?.reason ?? new Error("MCP control request cancelled");
      request.destroy(reason instanceof Error ? reason : undefined); reject(reason);
    };
    detachRequest = () => init.signal?.removeEventListener("abort", abortRequest);
    init.signal?.addEventListener("abort", abortRequest, { once: true });
    if (init.signal?.aborted) { abortRequest(); return; }
    request.end(typeof init.body === "string" ? init.body : undefined);
  });
}
