import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import {
  descriptorSchema,
  targetsSchema,
  type ExternalRelayDescriptor,
  type ExternalRelayTarget,
} from "./protocol";
import type { PairedRelay } from "./store";
import { waitForStateLock } from "@/lib/state/lockWait";
import { recordPublishedRelayReference } from "./publishedReferences";

import { ExternalRelayError } from "./errors";
export { ExternalRelayError } from "./errors";
export function isUnknownFeatureRefusal(error: unknown): error is ExternalRelayError {
  return error instanceof ExternalRelayError && error.status >= 400 && error.status < 500 &&
    /^(?:(?:unknown|unsupported)(?:_[a-z]+)*_features?|features?_(?:unknown|unsupported))$/.test(error.code);
}
const bare = (host: string) => host.replace(/^\[|\]$/g, "");
const loopback = (address: string) =>
  address === "::1" || (net.isIP(address) === 4 && address.startsWith("127."));
async function target(input: string, options: { query?: boolean; detailedErrors?: boolean } = {}): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ExternalRelayError("invalid_address");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.search && !options.query) ||
    url.hash
  )
    throw new ExternalRelayError("invalid_address");
  let addresses: string[];
  try {
    addresses = net.isIP(bare(url.hostname))
      ? [bare(url.hostname)]
      : (await dns.lookup(bare(url.hostname), { all: true })).map(
          (item) => item.address,
        );
  } catch {
    throw new ExternalRelayError(options.detailedErrors ? "dns_error" : "unreachable");
  }
  if (
    !addresses.length ||
    (url.protocol === "http:" && !addresses.every(loopback))
  )
    throw new ExternalRelayError("http_public");
  return { url, address: addresses[0]! };
}
/** A publication deadline covers name resolution as well as the socket. Late
 * DNS completion cannot prepare a body or start an HTTP request. */
async function targetWithSignal(input: string, signal?: AbortSignal, detailedErrors = false) {
  if (!signal) return target(input, { detailedErrors });
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([target(input, { detailedErrors }), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
export async function relayOrigin(value: string): Promise<string> {
  const { url } = await target(value);
  if (url.pathname !== "/") throw new ExternalRelayError("invalid_address");
  return url.origin;
}
export async function relayCall<T = unknown>(
  apiBase: string,
  route: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  credential?: string,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal;
    /** Preserve DNS failures for readers that report transport causes. */
    detailedErrors?: boolean;
    onResponseStatus?: (status: number) => void;
    /** Trusted caller rechecks its body after DNS, immediately before emission. */
    prepareBody?: () => unknown;
    binary?: { bytes: Buffer; headers: Record<string, string> };
    /** Trusted request authority is rechecked after DNS, before every send. */
    beforeSend?: () => void | Promise<void>;
  } = {},
): Promise<{ status: number; body: T | null }> {
  const { url, address } = await targetWithSignal(apiBase, options.signal, options.detailedErrors);
  options.signal?.throwIfAborted();
  await options.beforeSend?.();
  options.signal?.throwIfAborted();
  if (!url.pathname.endsWith("/v1") || !route.startsWith("/"))
    throw new ExternalRelayError("invalid_address");
  const outgoing = options.prepareBody ? options.prepareBody() : body;
  options.signal?.throwIfAborted();
  const encoded = options.binary?.bytes ?? (outgoing === undefined ? null : Buffer.from(JSON.stringify(outgoing)));
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const request = transport.request(
      {
        hostname: address,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        servername: net.isIP(bare(url.hostname))
          ? undefined
          : bare(url.hostname),
        path: url.pathname + route,
        method,
        agent: false,
        signal: options.signal,
        headers: {
          host: url.host,
          "Delegatus-Relay-Version": "1",
          ...(encoded
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(encoded.length),
              }
            : {}),
          ...options.binary?.headers,
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
      },
      (response) => {
        options.onResponseStatus?.(response.statusCode ?? 0);
        response.on("error", reject);
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 1_048_576)) {
            response.destroy(new ExternalRelayError("too_large", options.detailedErrors ? response.statusCode : 0));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", async () => {
          // A binary refusal can arrive before the body has drained. Close
          // that owned upload before a retry starts another transfer.
          if (options.binary) request.destroy();
          if (!response.complete) {
            reject(new ExternalRelayError("unreachable"));
            return;
          }
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            reject(new ExternalRelayError("unreachable", status));
            return;
          }
          let parsed: unknown = null;
          try {
            if (size)
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new ExternalRelayError("malformed", status));
            return;
          }
          if (status >= 400) {
            const error = parsed as {
              error?: { code?: string; retry_after_s?: number } | { code?: string; retry_after?: number }[];
            } | null;
            const wireError = Array.isArray(error?.error) ? error.error[0] : error?.error;
            const retry =
              (Array.isArray(error?.error) ? error.error[0]?.retry_after : error?.error?.retry_after_s) ??
              Number(response.headers["retry-after"]);
            reject(
              new ExternalRelayError(
                wireError?.code ??
                  (status === 401
                    ? "unauthorized"
                    : status === 426
                      ? "unsupported_version"
                      : "unreachable"),
                status,
                Number.isFinite(retry) ? retry : null,
                parsed,
              ),
            );
            return;
          }
          try { if (!options.binary) await waitForStateLock("relay.publication-reference", () => recordPublishedRelayReference(apiBase, route, method, outgoing, status, parsed), { waitMs: 5000 }); }
          catch { reject(new ExternalRelayError("publication_context_unavailable")); return; }
          resolve({ status, body: parsed as T });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(options.timeoutMs ?? 5_000, () =>
      request.destroy(new ExternalRelayError("unreachable")),
    );
    if (options.binary && encoded) {
      const bytes = encoded;
      const source = Readable.from((function* () { for (let offset = 0; offset < bytes.length; offset += 65536) yield bytes.subarray(offset, offset + 65536); })());
      request.once("close", () => source.destroy());
      source.on("error", error => request.destroy(error));
      source.pipe(request);
    } else request.end(encoded ?? undefined);
  });
}
/** Originals have exactly one authenticated route. A caller consumes the body
 * as a stream; redirects and arbitrary ref paths never reach a second host. */
export async function relayDownloadMedia<T>(apiBase: string, requestId: string, leaseId: string, mediaRef: string,
  credential: string, consume: (response: http.IncomingMessage) => Promise<T>,
  options: { signal: AbortSignal; beforeSend: () => void }) {
  if (![requestId, mediaRef].every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id)) || !credential || !/^[A-Za-z0-9_-]{22,64}$/.test(leaseId))
    throw new ExternalRelayError("malformed", 400);
  const { url, address } = await targetWithSignal(apiBase, options.signal);
  options.signal.throwIfAborted(); options.beforeSend();
  if (!url.pathname.endsWith("/v1")) throw new ExternalRelayError("invalid_address");
  return new Promise<T>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request({
      hostname: address, port: url.port || (url.protocol === "https:" ? 443 : 80),
      servername: net.isIP(bare(url.hostname)) ? undefined : bare(url.hostname),
      path: `${url.pathname}/requests/${requestId}/media/${mediaRef}`, method: "GET", agent: false, signal: options.signal,
      headers: { host: url.host, "Delegatus-Relay-Version": "1", "Delegatus-Relay-Lease": leaseId, Authorization: `Bearer ${credential}` },
    }, response => {
      response.on("error", () => { /* The consumer/pipeline observes the error. */ });
      void (async () => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) throw new ExternalRelayError("malformed", status);
        if (status !== 200) {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 65536) throw new ExternalRelayError("malformed", status);
            chunks.push(Buffer.from(chunk));
          }
          let body: { error?: { code?: unknown; retry_after_s?: unknown } };
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ExternalRelayError("malformed", status); }
          const code = body.error?.code;
          const retry = body.error?.retry_after_s;
          throw new ExternalRelayError(typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "malformed", status,
            typeof retry === "number" && Number.isFinite(retry) ? retry : null);
        }
        options.signal.throwIfAborted(); options.beforeSend();
        const result = await consume(response);
        options.signal.throwIfAborted(); options.beforeSend();
        if (!response.complete) throw new ExternalRelayError("malformed", 400);
        return result;
      })().then(resolve, error => { response.destroy(); reject(error instanceof ExternalRelayError || options.signal.aborted ? error : new ExternalRelayError("malformed", 400)); });
    });
    request.on("error", error => reject(options.signal.aborted ? error : new ExternalRelayError("malformed", 400)));
    request.setTimeout(30000, () => request.destroy(new ExternalRelayError("malformed", 400)));
    request.end();
  });
}
/**
 * Bounded GET with DNS pinning and redirect refusal, without credentials.
 * `query` admits and sends a query string, for an image the relay hands out
 * as a signed or parameterized URL; the relay's own documents are read without.
 */
export async function readRelayBytesUrl(urlInput: string, maxBytes = 1_048_576, options: { query?: boolean } = {}): Promise<Buffer> {
  const { url, address } = await target(urlInput, options);
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise<Buffer>((resolve, reject) => {
    const request = transport.request(
      {
        hostname: address,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        servername: net.isIP(bare(url.hostname))
          ? undefined
          : bare(url.hostname),
        path: url.pathname + (options.query ? url.search : ""),
        method: "GET",
        agent: false,
        headers: { host: url.host, "Delegatus-Relay-Version": "1" },
      },
      (response) => {
        response.on("error", reject);
        if (response.statusCode !== 200) {
          response.resume();
          reject(new ExternalRelayError("unreachable", response.statusCode));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes)
            response.destroy(new ExternalRelayError("too_large"));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    request.on("error", reject);
    request.setTimeout(5000, () =>
      request.destroy(new ExternalRelayError("unreachable")),
    );
    request.end();
  });
}
/** Bounded JSON transport with DNS pinning and redirect refusal, without credentials. */
export async function readRelayJsonUrl(urlInput: string): Promise<unknown> {
  const bytes = await readRelayBytesUrl(urlInput);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ExternalRelayError("malformed");
  }
}
export async function readRelayDescriptor(originInput: string): Promise<{ origin: string; descriptor: ExternalRelayDescriptor }> {
  const origin = await relayOrigin(originInput);
  const descriptor = await readRelayJsonUrl(`${origin}/.well-known/delegatus-relay.json`);
  const parsed = descriptorSchema.safeParse(descriptor);
  if (!parsed.success) throw new ExternalRelayError("malformed");
  return { origin, descriptor: parsed.data };
}
/**
 * The refusals a descriptor's `api_base` earns against the origin it was read
 * from. A service that advertises its own host over http:// is not offering a
 * secure connection yet, which is a different thing from pointing elsewhere.
 */
export function checkApiBase(origin: string, apiBase: string): void {
  const base = new URL(origin);
  const api = new URL(apiBase);
  if (api.protocol === "http:" && base.protocol === "https:" && api.host === base.host)
    throw new ExternalRelayError("http_public");
  if (api.origin !== origin) throw new ExternalRelayError("cross_origin");
  if (!api.pathname.endsWith("/v1"))
    throw new ExternalRelayError("invalid_api_path");
  if (api.search || api.hash) throw new ExternalRelayError("invalid_address");
}
export async function discoverRelay(
  originInput: string,
): Promise<{ origin: string; descriptor: ExternalRelayDescriptor }> {
  const { origin, descriptor } = await readRelayDescriptor(originInput);
  if (!descriptor.versions.includes(1))
    throw new ExternalRelayError("unsupported_version", 426);
  checkApiBase(origin, descriptor.api_base);
  return { origin, descriptor };
}
/** Endpoint 6: the targets the service lists for this pairing now. A body
 * that fails the schema is `malformed`, so the caller keeps what it stored. */
export async function fetchRelayTargets(
  relay: Pick<PairedRelay, "api_base" | "credential" | "limits">,
): Promise<ExternalRelayTarget[]> {
  const result = await relayCall(
    relay.api_base,
    "/targets",
    "GET",
    undefined,
    relay.credential,
    { maxBytes: relay.limits.max_response_bytes },
  );
  const parsed = targetsSchema.safeParse(result.body);
  if (result.status !== 200 || !parsed.success)
    throw new ExternalRelayError("malformed", result.status);
  return parsed.data.targets;
}

/** Raw lease upload, sharing the JSON transport's DNS pin, redirect refusal,
 * response cap and error parser. It never records a publish-route receipt. */
export function relayPutBytes<T = unknown>(apiBase: string, route: string, bytes: Buffer, headers: Record<string, string>, credential?: string,
  options: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; prepareBody?: () => unknown } = {}) {
  return relayCall<T>(apiBase, route, "PUT", undefined, credential, { ...options,
    binary: { bytes, headers: { ...headers, "Content-Length": String(bytes.length) } } });
}
