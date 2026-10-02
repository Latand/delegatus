import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  descriptorSchema,
  targetsSchema,
  type ExternalRelayDescriptor,
  type ExternalRelayTarget,
} from "./protocol";
import type { PairedRelay } from "./store";

export class ExternalRelayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
  }
}
const bare = (host: string) => host.replace(/^\[|\]$/g, "");
const loopback = (address: string) =>
  address === "::1" || (net.isIP(address) === 4 && address.startsWith("127."));
async function target(input: string): Promise<{ url: URL; address: string }> {
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
    url.search ||
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
    throw new ExternalRelayError("unreachable");
  }
  if (
    !addresses.length ||
    (url.protocol === "http:" && !addresses.every(loopback))
  )
    throw new ExternalRelayError("http_public");
  return { url, address: addresses[0]! };
}
export async function relayOrigin(value: string): Promise<string> {
  const { url } = await target(value);
  if (url.pathname !== "/") throw new ExternalRelayError("invalid_address");
  return url.origin;
}
export async function relayCall<T = unknown>(
  apiBase: string,
  route: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  credential?: string,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; body: T | null }> {
  const { url, address } = await target(apiBase);
  if (!url.pathname.endsWith("/v1") || !route.startsWith("/"))
    throw new ExternalRelayError("invalid_address");
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
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
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
      },
      (response) => {
        response.on("error", reject);
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 1_048_576)) {
            response.destroy(new ExternalRelayError("too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
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
              error?: { code?: string; retry_after_s?: number };
            } | null;
            const retry =
              error?.error?.retry_after_s ??
              Number(response.headers["retry-after"]);
            reject(
              new ExternalRelayError(
                error?.error?.code ??
                  (status === 401
                    ? "unauthorized"
                    : status === 426
                      ? "unsupported_version"
                      : "unreachable"),
                status,
                Number.isFinite(retry) ? retry : null,
              ),
            );
            return;
          }
          resolve({ status, body: parsed as T });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(options.timeoutMs ?? 5_000, () =>
      request.destroy(new ExternalRelayError("unreachable")),
    );
    request.end(encoded ?? undefined);
  });
}
/** The service's descriptor as published, checked against the schema and nothing else. */
export async function readRelayDescriptor(
  originInput: string,
): Promise<{ origin: string; descriptor: ExternalRelayDescriptor }> {
  const origin = await relayOrigin(originInput);
  const { url, address } = await target(origin);
  const transport = url.protocol === "https:" ? https : http;
  const descriptor = await new Promise<unknown>((resolve, reject) => {
    const request = transport.request(
      {
        hostname: address,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        servername: net.isIP(bare(url.hostname))
          ? undefined
          : bare(url.hostname),
        path: "/.well-known/delegatus-relay.json",
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
          if (size > 1_048_576)
            response.destroy(new ExternalRelayError("too_large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new ExternalRelayError("malformed"));
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(5000, () =>
      request.destroy(new ExternalRelayError("unreachable")),
    );
    request.end();
  });
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
