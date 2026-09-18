import fs from "node:fs";
import http from "node:http";
import net from "node:net";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import { viewerComposeSnapshotPath } from "./deploymentArtifacts";

function readTarget(filename: string): ViewerReleaseIdentity | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<ViewerReleaseIdentity>;
    if (typeof value.endpoint !== "string") return null;
    const endpoint = new URL(value.endpoint);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname) || !endpoint.port) return null;
    if (typeof value.image !== "string" || typeof value.container !== "string" || typeof value.revision !== "string") return null;
    return value as ViewerReleaseIdentity;
  } catch {
    return null;
  }
}

const UNAVAILABLE = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** Each accepted connection reads one atomically replaced release target. */
export function serveViewerDeploymentProxy(targetFile: string, port = 8898, host = "127.0.0.1"): net.Server {
  const server = net.createServer({ pauseOnConnect: true }, (downstream) => {
    /* #1254: this listener is the stable endpoint, so a connection failure
       here must never reach the process. Bun 1.3.3 dropped a failed socket
       write; 1.4.0 reports it by destroying the socket with the EPIPE, and an
       unhandled `error` event is an uncaught exception. The handler is
       attached before the first byte is written — including the 503 answers
       below, which used to write to a raw connection with no handler at all —
       and it stays attached, because a socket can fail more than once. */
    let upstream: net.Socket | null = null;
    downstream.on("error", () => {
      downstream.destroy();
      upstream?.destroy();
    });
    const target = readTarget(targetFile);
    if (!target) {
      downstream.end(UNAVAILABLE);
      return;
    }
    const endpoint = new URL(target.endpoint);
    if (Number(endpoint.port) === port) {
      downstream.end(UNAVAILABLE);
      return;
    }
    upstream = net.createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    upstream.on("error", () => {
      upstream?.destroy();
      downstream.destroy();
    });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.resume();
    downstream.once("close", () => upstream?.destroy());
  });
  server.listen(port, host);
  return server;
}

/*
 * The Viewer gateway (#1547).
 *
 * The Viewer authenticates every connection once LLV_TOKEN is configured,
 * because loopback is shared by every OS account on a shared host (#1496).
 * On a personal workstation that loopback is one human — but the stable
 * listener is also where Tailscale Serve delivers the tailnet, so the Viewer
 * cannot tell the operator's browser from a tailnet peer: both arrive from
 * 127.0.0.1 on the same port, and `Host` or `X-Forwarded-*` say only what the
 * caller wrote.
 *
 * The split therefore happens where the kernel already knows the answer —
 * which listener accepted the connection — and only in this front, which owns
 * the stable ports across Viewer generations. A gateway file in the state
 * directory opts a host in:
 *
 *   - the *remote entry* is a second loopback port for Tailscale Serve to
 *     target. It is the raw pipe above, exactly what the stable port has always
 *     been, so the Viewer's own gate (cookie, bearer, `?k=` link) keeps deciding;
 *   - the *local entry* is the stable port, served through node:http so that
 *     every request on a connection is seen. When the file marks it trusted, a
 *     request whose Host names loopback is forwarded with the release's own
 *     credential in `Authorization`. Trust comes from the listener; the Host
 *     restriction additionally keeps a DNS-rebound page in the operator's
 *     browser, which reaches this same loopback port carrying the attacker's
 *     Host, from being vouched for.
 *
 * Without a gateway file nothing here runs: the stable port stays the raw pipe.
 * A file that cannot be read as a configuration counts as no file at boot, and
 * as "authenticated" per request, so every unknown state is the strict one.
 */

export const VIEWER_GATEWAY_FILE = "viewer-gateway.json";

export interface ViewerGatewayConfig {
  /** Loopback port of the authenticated remote entry, bound at host start;
      null means no remote entry. */
  remoteEntryPort: number | null;
  /** "authenticated": the local entry forwards requests as they are and the
      Viewer's gate applies. "trusted": it vouches for loopback-addressed
      requests. Re-read per request, so this flips without a restart. */
  localEntry: "authenticated" | "trusted";
}

export const DEFAULT_VIEWER_GATEWAY: ViewerGatewayConfig = { remoteEntryPort: null, localEntry: "authenticated" };

export interface ViewerGatewayReading {
  /** Whether a file was there at all. */
  present: boolean;
  config: ViewerGatewayConfig;
  /** Why the file's contents were ignored. Any problem yields the default
      configuration as a whole: a half-read gateway is not a configuration. */
  problem: string | null;
}

const GATEWAY_KEYS = new Set(["remoteEntryPort", "localEntry"]);

function closed(problem: string): ViewerGatewayReading {
  return { present: true, config: { ...DEFAULT_VIEWER_GATEWAY }, problem };
}

/** Pure. `localEntryPort` is the stable port, which the remote entry may not share. */
export function parseViewerGatewayConfig(raw: string | null, localEntryPort: number): ViewerGatewayReading {
  if (raw === null) return { present: false, config: { ...DEFAULT_VIEWER_GATEWAY }, problem: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return closed("not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return closed("not a JSON object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!GATEWAY_KEYS.has(key)) return closed(`unknown key ${JSON.stringify(key)}`);
  }
  let remoteEntryPort: number | null = null;
  if (record.remoteEntryPort !== undefined && record.remoteEntryPort !== null) {
    const port = record.remoteEntryPort;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return closed("remoteEntryPort must be an integer port");
    if (port === localEntryPort) return closed(`remoteEntryPort ${port} is the local entry port`);
    remoteEntryPort = port;
  }
  let localEntry: ViewerGatewayConfig["localEntry"] = "authenticated";
  if (record.localEntry !== undefined) {
    if (record.localEntry !== "authenticated" && record.localEntry !== "trusted") {
      return closed(`localEntry must be "authenticated" or "trusted"`);
    }
    localEntry = record.localEntry;
  }
  return { present: true, config: { remoteEntryPort, localEntry }, problem: null };
}

/** A missing file is the default; an unreadable one is the default with a reason. */
export function readViewerGatewayConfig(filename: string, localEntryPort: number): ViewerGatewayReading {
  let raw: string | null;
  try {
    raw = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = null;
    else return closed(`unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseViewerGatewayConfig(raw, localEntryPort);
}

/**
 * The credential the promoted Viewer enforces, from its release container's
 * Compose snapshot — the same file the MCP control client reads (#1511). A
 * release published before snapshots existed has none, and then the host's
 * own `LLV_TOKEN` is the machine's one remaining statement of that credential.
 * A snapshot that names no token is a Viewer with no gate: nothing to vouch.
 */
export function viewerReleaseCredentialResolver(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): (target: ViewerReleaseIdentity) => string | null {
  return (target) => {
    let raw: string;
    try {
      raw = fs.readFileSync(viewerComposeSnapshotPath(stateDir, target.container), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      return env.LLV_TOKEN?.trim() || null;
    }
    try {
      const compose = JSON.parse(raw) as { services?: { viewer?: { environment?: { LLV_TOKEN?: unknown } } } };
      const token = compose?.services?.viewer?.environment?.LLV_TOKEN;
      return typeof token === "string" && token.trim() ? token : null;
    } catch {
      return null;
    }
  };
}

/** The names a browser on this machine reaches the stable port by. Mirrors
    the allowlist in `src/lib/sameOrigin.ts`, minus the tailnet name: the
    tailnet never arrives on the local entry once the remote entry exists. */
const LOOPBACK_HOST_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** Pure. Whether a Host header names loopback, on any port. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let name: string;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    name = end === -1 ? host : host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(":");
    name = colon === -1 ? host : host.slice(0, colon);
  }
  return LOOPBACK_HOST_NAMES.has(name.toLowerCase());
}

/** Connection-scoped headers never cross the hop; node:http frames each hop
    itself. Forwarding `transfer-encoding` verbatim made Bun 1.3.3 answer
    `chunked, chunked`. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardedHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name) || value === undefined) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function endpointAddress(target: ViewerReleaseIdentity): { host: string; port: number } {
  const endpoint = new URL(target.endpoint);
  return { host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port) };
}

export interface ViewerLocalEntryOptions {
  /** Read per request, so trust is granted and withdrawn without a restart. */
  gatewayFile: string;
  releaseCredential: (target: ViewerReleaseIdentity) => string | null;
  report?: (line: string) => void;
}

/**
 * The stable port as the gateway's local entry: the same release target per
 * request, forwarded through node:http. Streaming responses pass through as
 * they arrive, keep-alive connections carry many requests and each one is
 * decided on its own, a downstream that walks away takes its upstream request
 * with it, and an Upgrade is relayed on the raw sockets node:http hands over.
 */
export function serveViewerLocalEntry(
  targetFile: string,
  port: number,
  host: string,
  options: ViewerLocalEntryOptions,
): http.Server {
  const report = options.report ?? (() => undefined);
  /* One line per distinct reason: a page load is dozens of requests and the
     reason does not change between them. */
  const reported = new Set<string>();
  const reportOnce = (line: string) => {
    if (reported.has(line)) return;
    if (reported.size >= 64) reported.clear();
    reported.add(line);
    report(line);
  };
  const vouchedCredential = (target: ViewerReleaseIdentity, hostHeader: string | undefined): string | null => {
    const gateway = readViewerGatewayConfig(options.gatewayFile, port);
    if (gateway.problem) {
      reportOnce(`[runtime host] viewer gateway ${options.gatewayFile} ignored, local entry stays authenticated: ${gateway.problem}`);
      return null;
    }
    if (gateway.config.localEntry !== "trusted") return null;
    if (!isLoopbackHost(hostHeader)) return null;
    const credential = options.releaseCredential(target);
    if (credential === null) {
      reportOnce(`[runtime host] viewer gateway: local entry is trusted but no credential is known for release container ${target.container}; requests stay authenticated`);
    }
    return credential;
  };
  const currentTarget = (): ViewerReleaseIdentity | null => {
    const target = readTarget(targetFile);
    return target && endpointAddress(target).port !== port ? target : null;
  };

  const server = http.createServer((request, response) => {
    const target = currentTarget();
    if (!target) {
      response.writeHead(503, { connection: "close", "content-length": "0" });
      response.end();
      return;
    }
    const headers = forwardedHeaders(request.headers);
    const credential = vouchedCredential(target, request.headers.host);
    if (credential !== null) headers.authorization = `Bearer ${credential}`;
    const upstream = http.request({
      ...endpointAddress(target),
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      upstreamResponse.on("error", () => response.destroy());
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, forwardedHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { connection: "close", "content-length": "0" });
      response.end();
    });
    const abandon = () => { if (!response.writableFinished) upstream.destroy(); };
    request.on("error", abandon);
    response.on("error", abandon);
    response.on("close", abandon);
    request.pipe(upstream);
  });

  server.on("upgrade", (request, downstream, head) => {
    downstream.on("error", () => downstream.destroy());
    const target = currentTarget();
    if (!target) {
      downstream.end(UNAVAILABLE);
      return;
    }
    const credential = vouchedCredential(target, request.headers.host);
    const upstream = net.createConnection(endpointAddress(target));
    upstream.on("error", () => {
      upstream.destroy();
      downstream.destroy();
    });
    upstream.on("connect", () => {
      /* The request line and headers as node:http parsed them, re-serialised
         in their original order and spelling; only Authorization changes when
         the entry vouches. Connection and Upgrade must cross the hop here. */
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        if (credential !== null && name.toLowerCase() === "authorization") continue;
        lines.push(`${name}: ${request.rawHeaders[index + 1]}`);
      }
      if (credential !== null) lines.push(`Authorization: Bearer ${credential}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    downstream.once("close", () => upstream.destroy());
  });

  server.on("clientError", (_error, socket) => {
    socket.on("error", () => undefined);
    socket.destroy();
  });
  server.listen(port, host);
  return server;
}
