import "@/lib/state/owner/tool";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:http";
import { existingInternalServiceHeaders } from "@/lib/agent/callerClaims";
import { currentOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { viewerBootGateKey } from "../bin/viewerGateKey.mjs";

/** Resolve before reading credentials, then connect to the checked address.
 * Pinning the address avoids a second DNS lookup changing the destination. */
export async function loopbackDeploymentUrl(input: string, resolve = (host: string) => lookup(host, { all: true })): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash
    || !/^\/api\/runtime\/deployments(?:\/[^/]+)?$/.test(url.pathname)) {
    throw new Error("Deployment HTTP destination is invalid");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolve(host);
  if (!addresses.length || !addresses.every(({ address }) =>
    isIP(address) === 4 ? address.split(".")[0] === "127" : address === "::1")) {
    throw new Error("Deployment HTTP destination must resolve only to loopback");
  }
  const address = addresses[0]!.address;
  url.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return url;
}

async function main(): Promise<void> {
  const [input, kind] = process.argv.slice(2);
  if (!input || !["request", "status"].includes(kind ?? "")) {
    throw new Error("usage: rebuild-http.ts <loopback-deployment-url> <request|status>");
  }
  let url: URL;
  try { url = await loopbackDeploymentUrl(input); }
  catch {
    console.error("Deployment HTTP destination refused; use a validated loopback listener");
    process.exitCode = 3;
    return;
  }
  // The controller service is the existing host control identity. Never mint
  // a key or present a member cookie or a conversation's spawn capability.
  const headers = existingInternalServiceHeaders("controller");
  const control = currentOperatorSpawnCapability();
  const bearer = viewerBootGateKey(process.env);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const secrets = [control, bearer, ...Object.values(headers)].filter((value): value is string => !!value);
  const scrub = (text: string) => secrets.reduce((result, secret) => result.replaceAll(secret, "[credential withheld]"), text);
  let response: { status: number; body: string };
  try {
    const body = kind === "request" ? await Bun.stdin.text() : undefined;
    // node:http connects directly: ambient HTTP proxies cannot receive the
    // credentials, and redirects are responses rather than new requests.
    response = await new Promise((resolve, reject) => {
      const call = request(url, {
        method: kind === "request" ? "POST" : "GET",
        headers: { ...headers, ...(kind === "request" ? { "content-type": "application/json" } : {}) },
        signal: AbortSignal.timeout(kind === "request" ? 125_000 : 10_000),
      }, async incoming => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        } catch (error) { reject(error); }
      });
      call.once("error", reject);
      call.end(body);
    });
  } catch {
    throw new Error("Deployment HTTP request did not complete");
  }
  if (response.status >= 300 && response.status < 400) {
    console.error("Deployment HTTP redirect refused");
    process.exitCode = 3;
    return;
  }
  const body = scrub(response.body);
  if (kind === "request") process.stdout.write(`${body}\n${response.status}`);
  else if (response.status >= 200 && response.status < 300) process.stdout.write(body);
  else {
    console.error(`Deployment status request failed (HTTP ${response.status})`);
    process.exitCode = response.status === 401 || response.status === 403 ? 3 : 1;
  }
}

if (import.meta.main) await main().catch(() => {
  // Network, filesystem and server errors may contain input or credentials.
  console.error("Deployment HTTP request failed; check the local install and its control credential");
  process.exitCode = 1;
});
