import { lookup } from "node:dns/promises";
import { request } from "node:http";
import { isIP } from "node:net";
import { existingInternalServiceHeaders } from "@/lib/agent/callerClaims";
import { viewerBootGateKey } from "../../../bin/viewerGateKey.mjs";

/** Validate and pin loopback before opening the existing control credential. */
export async function codexUpdateUrl(input: string, resolve = (host: string) => lookup(host, { all: true })): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/api/codex-update/check") throw new Error("invalid Codex update destination");
  const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, ""));
  if (!addresses.length || !addresses.every(({ address }) =>
    isIP(address) === 4 ? address.split(".")[0] === "127" : address === "::1")) {
    throw new Error("Codex update destination must resolve only to loopback");
  }
  url.hostname = isIP(addresses[0]!.address) === 6 ? `[${addresses[0]!.address}]` : addresses[0]!.address;
  return url;
}

export async function requestInstalledCodexUpdate(input: string): Promise<void> {
  const url = await codexUpdateUrl(input);
  const headers = existingInternalServiceHeaders("controller");
  const bearer = viewerBootGateKey(process.env);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  // Direct HTTP ignores ambient proxies and never follows redirects. Only a
  // fixed acknowledgement leaves this process; response bodies can hold secrets.
  await new Promise<void>((resolve, reject) => {
    const call = request(url, { method: "POST", headers, signal: AbortSignal.timeout(10_000) }, async incoming => {
      try {
        let body = "", bytes = 0;
        for await (const chunk of incoming) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 16_384) throw new Error("Codex update response exceeds bound");
          body += chunk;
        }
        if (incoming.statusCode !== 202 || JSON.parse(body).accepted !== true) throw new Error("Codex update request refused");
        resolve();
      } catch { incoming.destroy(); reject(new Error("Codex update request refused")); }
    });
    call.once("error", () => reject(new Error("Codex update request did not complete")));
    call.end();
  });
}
