import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { CONTROL_RECOVERY_PATH, CONTROL_REQUEST_HEADER, OUTCOME_LIMIT, controlEvidenceStore, type ControlEvidenceStore, type AsyncControlEvidenceStore } from "./controlEvidence";

type Emitter = Pick<Server, "emit">;
const shared = globalThis as typeof globalThis & { __mcpIngressTargets?: WeakSet<object>; __mcpIngressWrappers?: WeakSet<Server["emit"]> };
const installed = shared.__mcpIngressTargets ??= new WeakSet<object>();
const wrappers = shared.__mcpIngressWrappers ??= new WeakSet<Server["emit"]>();

/** Install before the Viewer becomes ready. Observes Node's actual request and
 * response, outside Next's separately bundled route modules and before their
 * first await. It never buffers a request or changes ordinary callers. */
export function installControlIngress(target: Emitter, store: ControlEvidenceStore | AsyncControlEvidenceStore): () => void {
  if (installed.has(target) || wrappers.has(target.emit)) return () => {};
  const original = target.emit;
  const wrapped: Server["emit"] = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event !== "request") return Reflect.apply(original, this, [event, ...args]);
    const [request, response] = args as [IncomingMessage, ServerResponse];
    const pathname = request.url?.split("?", 1)[0];
    const id = request.headers[CONTROL_REQUEST_HEADER];
    if (!id && pathname !== CONTROL_RECOVERY_PATH) return Reflect.apply(original, this, [event, ...args]);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const claim = internalServiceClaim({ headers }, { readOnly: true });
    const answer = (status: number, value: unknown) => {
      if (response.destroyed) return true;
      request.resume();
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
      return true;
    };
    if (claim.claim !== "valid" || claim.service !== "mcp") {
      if (pathname === CONTROL_RECOVERY_PATH) return answer(403, { error: "internal MCP authority required" });
      // An untrusted diagnostic header neither fences nor bypasses route policy.
      return Reflect.apply(original, this, [event, ...args]);
    }
    // Own connection failures while admission is awaiting its worker too.
    // Next has not installed its route's listeners during that interval.
    const socket = request.socket;
    const onError = (error: Error) => {
      const requestId = typeof id === "string" && id.length <= 80 ? id : "invalid";
      void Promise.resolve().then(() => store.event(requestId, "error", socket.bytesRead, socket.bytesWritten, (error as NodeJS.ErrnoException).code))
        .catch(() => console.error("[mcp-http] socket error evidence unavailable"));
    };
    request.once("error", onError); response.once("error", onError); socket.on("error", onError);
    response.once("close", () => socket.removeListener("error", onError));
    let invoked = false;
    const run = async () => {
      if (typeof id !== "string") return answer(400, { error: "invalid MCP request id" });
      const evidence = await store.observe(id, false, `${request.method} ${pathname}`);
      if (response.destroyed) {
        if (evidence.fresh && evidence.nonce) await store.abandon(id, evidence.nonce);
        return true;
      }
      if (!evidence.fresh || evidence.state !== "seen") return answer(409, { code: "mcp_request_fenced", state: evidence.state });
      response.setHeader(CONTROL_REQUEST_HEADER, id);
      let chunks: Buffer[] = [], size = 0;
      const capture = (chunk: unknown, encoding?: unknown) => {
        if (chunk === undefined || chunk === null || size > OUTCOME_LIMIT) return;
        const codec = typeof encoding === "string" ? encoding as BufferEncoding : "utf8";
        if (typeof chunk === "string" && ["utf8", "utf-8"].includes(codec) && chunk.length > OUTCOME_LIMIT - size) {
          size = OUTCOME_LIMIT + 1; chunks = []; return;
        }
        const length = typeof chunk === "string" ? Buffer.byteLength(chunk, codec) : chunk instanceof Uint8Array ? chunk.byteLength : 0;
        size += length;
        if (size > OUTCOME_LIMIT) { chunks = []; return; }
        // Inspect length before copying: a single large response.end must
        // never allocate its whole body again for optional diagnostics.
        if (typeof chunk === "string") chunks.push(Buffer.from(chunk, codec));
        else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      };
      const write = response.write, end = response.end;
      response.write = function (this: ServerResponse, ...values: Parameters<ServerResponse["write"]>) {
        capture(values[0], values[1]);
        return Reflect.apply(write, this, values);
      } as ServerResponse["write"];
      response.end = function (this: ServerResponse, ...values: Parameters<ServerResponse["end"]>) {
        capture(values[0], values[1]);
        return Reflect.apply(end, this, values);
      } as ServerResponse["end"];
      // Socket loss never means the handler stopped. A finish means the full
      // answer was handed to the HTTP writer; close records that distinction.
      response.once("finish", () => {
        const encoding = String(response.getHeader("content-encoding") ?? "identity").toLowerCase();
        const json = String(response.getHeader("content-type") ?? "").includes("application/json") && encoding === "identity";
        const outcome = json && size <= OUTCOME_LIMIT ? Buffer.concat(chunks).toString("utf8") : null;
        void Promise.resolve().then(() => store.complete(id, response.statusCode, outcome, evidence.nonce))
          .catch(() => console.error("[mcp-http] response evidence unavailable"));
        chunks = [];
      });
      response.once("close", () => {
        void Promise.resolve().then(() => store.closed(id, socket.bytesRead, socket.bytesWritten))
          .catch(() => console.error("[mcp-http] close evidence unavailable"));
        chunks = [];
      });
      invoked = true;
      if (pathname === CONTROL_RECOVERY_PATH) {
        if (request.method !== "GET") return answer(405, { error: "GET required" });
        const lookup = new URL(request.url!, "http://localhost").searchParams.get("id") ?? "";
        const found = await store.observe(lookup, true);
        return answer(200, { state: found.state, status: found.status, outcome: found.outcome });
      }
      return Reflect.apply(original, this, [event, ...args]);
    };
    void run().catch(() => {
      // Failure before ingress admission is decisive. Never execute a request
      // without the durable evidence its sender relies on for safe recovery.
      if (!response.headersSent && !response.destroyed) answer(503, { code: "mcp_evidence_unavailable", ...(!invoked ? { admission: "refused" } : {}) });
    });
    return true;
  } as Server["emit"];
  target.emit = wrapped;
  wrappers.add(wrapped);
  installed.add(target);
  return () => { if (target.emit === wrapped) { target.emit = original; installed.delete(target); wrappers.delete(wrapped); } };
}

export async function installServingControlIngress(): Promise<() => void> {
  const http = await import(/* webpackIgnore: true */ "node:http");
  const https = await import(/* webpackIgnore: true */ "node:https");
  const client = controlEvidenceStore("client"), server = controlEvidenceStore("server");
  await Promise.all([client.ready(), server.ready()]);
  const undoHttp = installControlIngress(http.Server.prototype, server);
  const undoHttps = installControlIngress(https.Server.prototype, server);
  return () => { undoHttps(); undoHttp(); };
}
