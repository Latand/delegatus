import { performanceSpans } from "@/lib/performanceSpans";
import fs from "node:fs";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

import type { RuntimeSocketRequest, RuntimeSocketResponse } from "@/lib/runtime/contracts";
import { isNamedPipePath } from "@/lib/runtime/localEndpoint";

import type { RuntimeHost } from "./host";
import { PreserializedJson } from "./preserializedJson";

const MAX_FRAME_BYTES = 512 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 31_000;
const DEPLOYMENT_SOCKET_TIMEOUT_MS = 125_000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_WAIT_CONNECTIONS = 192;

export interface RuntimeHostSocketOptions {
  defaultTimeoutMs?: number;
  deploymentTimeoutMs?: number;
  maxConnections?: number;
  maxWaitConnections?: number;
}

export type RuntimeHostSocketHandler = Pick<RuntimeHost, "handle">;

/**
 * Newline-framed local protocol over one local endpoint: a Unix socket path on
 * POSIX, a Windows named pipe (`\\.\pipe\…`) on win32. It never binds a TCP
 * port. The filesystem preparation — creating the parent directory, unlinking a
 * stale inode, tightening the mode once bound — belongs to the socket-path form
 * only; a pipe name lives in the kernel's pipe namespace, has no parent
 * directory and no mode, and its name disappears with the last handle. That
 * difference in access control is documented rather than emulated: see
 * `localEndpoint.ts`.
 */
export function serveRuntimeHost(socketPath: string, host: RuntimeHostSocketHandler, options: RuntimeHostSocketOptions = {}): net.Server {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  const deploymentTimeoutMs = options.deploymentTimeoutMs ?? DEPLOYMENT_SOCKET_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxWaitConnections = options.maxWaitConnections ?? DEFAULT_MAX_WAIT_CONNECTIONS;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 2) {
    throw new Error("runtime socket maxConnections must be an integer of at least 2");
  }
  if (!Number.isSafeInteger(maxWaitConnections) || maxWaitConnections < 1 || maxWaitConnections >= maxConnections) {
    throw new Error("runtime socket maxWaitConnections must reserve at least one command connection");
  }
  const namedPipe = isNamedPipePath(socketPath);
  if (!namedPipe) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let activeWaitConnections = 0;
  let closing = false;
  const connections = new Map<net.Socket, () => boolean>();
  const server = net.createServer((socket) => {
    /* #1254: a peer that goes away mid-frame is a connection event, and the
       write that discovers it must end this connection and nothing else. Bun
       1.3.3 dropped a failed socket write on the floor; 1.4.0 reports it by
       destroying the socket with the EPIPE, so an unhandled `error` here is an
       uncaught exception that kills the process owning the stable listener.
       This listener is attached before anything can be written. */
    socket.on("error", () => socket.destroy());
    let abort: AbortController | undefined;
    socket.once("close", () => abort?.abort());
    socket.setTimeout(defaultTimeoutMs, () => socket.destroy());
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let frameBytes = 0;
    let handled = false;
    connections.set(socket, () => handled);
    socket.once("close", () => connections.delete(socket));
    const next = () => {
      if (handled || socket.destroyed) return;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      frameBytes = Buffer.byteLength(buffer);
      let settled = false;
      let keepAlive = false;
      abort = new AbortController();
      const settle = (response: RuntimeSocketResponse) => {
        if (settled) return;
        settled = true;
        if (socket.destroyed || socket.writableEnded || !socket.writable) return;
        keepAlive &&= !closing;
        const answer = keepAlive ? { ...response, keepAlive: true } : response;
        const encoded = performanceSpans.correlate(response.id, () => performanceSpans.sync("runtime.stringify", () => response.ok && response.result instanceof PreserializedJson
          ? `{"id":${JSON.stringify(response.id)},"ok":true,${keepAlive ? '"keepAlive":true,' : ""}"result":${response.result.json}}`
          : JSON.stringify(answer)));
        performanceSpans.event("rpc.send", response.id, Buffer.byteLength(encoded));
        if (!keepAlive) { socket.end(encoded + "\n"); return; }
        // Only one response may occupy this connection's write buffer. A peer
        // may send its next serial request before the write callback runs.
        socket.write(encoded + "\n", () => {
          if (socket.destroyed) return;
          if (closing) { socket.end(); return; }
          abort = undefined;
          handled = false;
          socket.setTimeout(defaultTimeoutMs);
          next();
        });
      };
      try {
        const request = JSON.parse(frame) as RuntimeSocketRequest;
        if (!request.id || !request.method) throw new Error("runtime request is malformed");
        keepAlive = request.keepAlive === true;
        performanceSpans.request(request.id, request.method);
        performanceSpans.event("rpc.receive", request.id);
        if (request.method === "viewer-deployment-request") socket.setTimeout(deploymentTimeoutMs);
        const failure = (): RuntimeSocketResponse => ({ id: request.id, ok: false, error: "runtime request failed" });
        const run = () => performanceSpans.correlate(request.id, () => performanceSpans.wait("runtime.handler", () => host.handle(request, { signal: abort!.signal })));
        if (request.method === "wait") {
          if (activeWaitConnections >= maxWaitConnections) {
            settle({ id: request.id, ok: false, error: "runtime wait capacity exceeded" });
            return;
          }
          activeWaitConnections++;
          void run().then(settle, () => settle(failure())).finally(() => { activeWaitConnections--; }).catch(() => socket.destroy());
        } else {
          void run().then(settle, () => settle(failure())).catch(() => socket.destroy());
        }
      } catch {
        keepAlive = false;
        settle({ id: "unknown", ok: false, error: "runtime request is malformed" });
      }
    };
    socket.on("data", (chunk: Buffer) => {
      frameBytes += chunk.length;
      if (frameBytes > MAX_FRAME_BYTES) { socket.destroy(); return; }
      buffer += decoder.write(chunk);
      next();
    });
  });
  // Browser long polls receive their own ceiling below the server-wide cap.
  // The remaining slots keep snapshot, control, and deployment traffic
  // admissible while total file descriptors and journal waiters stay bounded.
  // Like an HTTP keep-alive listener, closing stops idle leases immediately
  // while allowing the one response already in flight to finish.
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    closing = true;
    for (const [socket, busy] of connections) if (!busy()) socket.destroy();
    return close(callback);
  }) as typeof server.close;
  server.maxConnections = maxConnections;
  if (!namedPipe) server.once("listening", () => fs.chmodSync(socketPath, 0o600));
  server.listen(socketPath);
  return server;
}
