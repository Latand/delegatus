import { randomUUID, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import { statePath } from "@/lib/configDir";
import { publicEntry } from "@/lib/links/publicEntry";
import { LOOPBACK_PROBE_HOSTS } from "@/runtime-host/deploymentProxy";

export type CheckCode = "ok" | "needs-access-key" | "needs-remote-entry" | "http-public" | "open-to-internet" | "host-rewritten" | "tls-failure" | "unverified";
/** The request line a self-check probe arrived with, as this server's own route read it. */
/** `unknown` names the headers the route could not tell from the ones Next
 * writes itself when a proxy sends none; their value is kept as null. */
export type SeenRequest = { host: string | null; forwardedHost: string | null; forwardedProto: string | null; forwarded: string | null; unknown: ("forwardedHost" | "forwardedProto")[] };
/** `expected` and `seen` accompany `host-rewritten`: the address's own host beside what arrived. */
export type SelfCheck = { code: CheckCode; at: string; expected?: string; seen?: SeenRequest };
export type LinkSelf = { v: 1; installId: string; label: string; publicUrl: string | null; check: SelfCheck | null; revision?: string; saveRevision?: string };
export type SaveRefusal = "needs-access-key" | "needs-remote-entry" | "http-public" | "invalid-address" | "save-conflict";

export const selfFile = () => statePath("links/self.json");

export function readSelf(): LinkSelf | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(selfFile(), "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const value = data as Partial<LinkSelf>;
    if (value.v !== 1 || typeof value.installId !== "string" || typeof value.label !== "string" ||
        (value.publicUrl !== null && typeof value.publicUrl !== "string")) return null;
    return { v: 1, installId: value.installId, label: value.label, publicUrl: value.publicUrl ?? null, check: value.check ?? null,
      revision: typeof value.revision === "string" ? value.revision : undefined,
      saveRevision: typeof value.saveRevision === "string" ? value.saveRevision : undefined };
  } catch { return null; }
}

/** Mint the local identity for an outbound pair without publishing an address. */
export function ensureSelf(): LinkSelf | null {
  const existing = readSelf();
  if (existing || fs.existsSync(selfFile())) return existing;
  const filename = selfFile();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const self: LinkSelf = { v: 1, installId: randomUUID(), label: os.hostname(), publicUrl: null,
    check: null, revision: randomUUID(), saveRevision: randomUUID() };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(self)}\n`, { mode: 0o600, flag: "wx" });
    // link is atomic and refuses to replace an identity another request saved.
    fs.linkSync(temporary, filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return readSelf();
}

/** A pairing probe saw the public entry vouched as the operator. */
export function markOpenToInternet(): void {
  const current = readSelf();
  if (current) writeSelf({ ...current, check: { code: "open-to-internet", at: new Date().toISOString() } });
}

export function linksNeedGate(): boolean {
  const self = readSelf();
  if (!self && fs.existsSync(selfFile())) return true;
  if (self?.publicUrl) {
    try { if (!isLoopbackAddress(new URL(self.publicUrl).hostname)) return true; }
    catch { return true; }
  }
  try { return fs.existsSync(statePath("links/grants.json")); }
  catch { return false; }
}

function writeSelf(value: LinkSelf): void {
  const filename = selfFile();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...value, revision: randomUUID() })}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filename);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function isLoopbackAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function privateIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackAddress(host)) return true;
  if (net.isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIP(host) === 6) {
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

async function resolvedAddress(hostname: string): Promise<{ kind: "loopback" | "private" | "public"; host: string } | null> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) return { kind: isLoopbackAddress(literal) ? "loopback" : privateIp(literal) ? "private" : "public", host: literal };
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length) return null;
    const kind = addresses.every((entry) => isLoopbackAddress(entry.address)) ? "loopback" :
      addresses.every((entry) => privateIp(entry.address)) ? "private" : "public";
    return { kind, host: addresses[0]!.address };
  } catch { return null; }
}

function parsedOrigin(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function currentSelf(): { self: LinkSelf | null; state: CheckCode | null; entry: ReturnType<typeof publicEntry> } {
  const self = readSelf();
  const entry = publicEntry();
  let state: CheckCode | null = self?.check?.code ?? null;
  if (!process.env.LLV_TOKEN) state = "needs-access-key";
  if (self?.publicUrl && process.env.LLV_TOKEN && !entry.publishable &&
      !isLoopbackAddress(new URL(self.publicUrl).hostname)) state = "needs-remote-entry";
  return { self, state, entry };
}

export async function saveAddress(input: string, label?: string): Promise<{ self?: LinkSelf; refusal?: SaveRefusal }> {
  const url = input.trim() ? parsedOrigin(input) : null;
  if (input.trim() && !url) return { refusal: "invalid-address" };
  if (url && !isLoopbackAddress(url.hostname) && !process.env.LLV_TOKEN) return { refusal: "needs-access-key" };
  const kind = url ? (await resolvedAddress(url.hostname))?.kind ?? "public" : "loopback";
  if (kind === "public" && url?.protocol === "http:") return { refusal: "http-public" };
  if (url && !isLoopbackAddress(url.hostname) && !publicEntry().publishable) return { refusal: "needs-remote-entry" };
  const old = readSelf();
  const self: LinkSelf = {
    v: 1, installId: old?.installId ?? randomUUID(), label: label?.trim().slice(0, 100) || old?.label || os.hostname(),
    publicUrl: url ? url.origin : null, check: null, saveRevision: randomUUID(),
  };
  if (url) {
    self.check = await checkAddress(url);
    if (self.check.code === "http-public") return { refusal: "http-public" };
  }
  // Disable reads self.json synchronously before lifting the key. Once the
  // key is checked here, the write below runs without yielding to Disable.
  if (url && !isLoopbackAddress(url.hostname) && !process.env.LLV_TOKEN) return { refusal: "needs-access-key" };
  // Check writes keep saveRevision, so a Check finishing during this probe
  // does not cancel Save. A concurrent Save must be reported as a conflict:
  // returning its record as this request's success would silently lose edits.
  const current = readSelf();
  if (current?.saveRevision !== old?.saveRevision) return { refusal: "save-conflict" };
  writeSelf(self);
  process.env.LLV_PUBLIC_HOST = url?.hostname ?? "";
  return { self };
}

type PendingProbe = { expiry: number; seen: SeenRequest | null; arrivedHost: string | null };
const shared = globalThis as typeof globalThis & { __delegatusSelfProbes?: Map<string, PendingProbe> };
const pending = shared.__delegatusSelfProbes ??= new Map<string, PendingProbe>();
/** The longest Host that can name an address: 253 characters of name, a
 * trailing dot, a colon and five digits of port. */
const HOST_LIMIT = 260;
/** The self-check route admits a nonce once and leaves here what it read. The
 * check rules on this record, which only a request that reached this process
 * can write. The answer's body proves nothing: anything at the address can
 * write it. `seen` is cut for display; `host` is the Host header whole, and
 * one longer than any address is kept as absent, which names no address. */
export function consumeSelfNonce(nonce: string, seen: SeenRequest, host: string | null): boolean {
  const probe = pending.get(nonce);
  if (!probe || probe.seen || probe.expiry < Date.now()) return false;
  probe.seen = seen;
  probe.arrivedHost = host !== null && host.length <= HOST_LIMIT ? host : null;
  return true;
}

/** Whether a Host header names the address: the same name in any case, with the
 * port left out or equal to the address's own. A proxy may drop the port (nginx
 * `$host`) or write the default one; the Host pin reads the name alone. A
 * different port is the upstream's, as is a different name. */
export function hostNamesAddress(host: string | null, url: URL): boolean {
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host?.trim() ?? "");
  if (!match || match[1]!.toLowerCase() !== url.hostname.toLowerCase()) return false;
  return match[2] === undefined || Number(match[2]) === Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function newNonce(): string {
  if (pending.size >= 32) {
    for (const [key, probe] of pending) if (probe.expiry < Date.now()) pending.delete(key);
    if (pending.size >= 32) pending.delete(pending.keys().next().value!);
  }
  const nonce = randomBytes(32).toString("base64url");
  pending.set(nonce, { expiry: Date.now() + 30_000, seen: null, arrivedHost: null });
  return nonce;
}

/** `seen` and `arrivedHost` are read from this process's own record of the probe. */
export type Probe = { status: number; host?: string; vouched?: boolean; seen: SeenRequest | null; arrivedHost: string | null };
export function probeSelfAddress(url: URL, host: string, options: { certificateAuthority?: string; connectionHost?: string } = {}): Promise<Probe> {
  const nonce = newNonce();
  const name = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise<Probe>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const finish = (answer: Omit<Probe, "seen" | "arrivedHost">) => { if (settled) return; settled = true; clearTimeout(timer); const record = pending.get(nonce); resolve({ ...answer, seen: record?.seen ?? null, arrivedHost: record?.arrivedHost ?? null }); };
    const request = (url.protocol === "https:" ? https : http).request({
      hostname: options.connectionHost ?? name, port: url.port || (url.protocol === "https:" ? 443 : 80),
      // SNI carries names only; Bun refuses an IP literal as the servername.
      servername: url.protocol === "https:" && !net.isIP(name) ? name : undefined,
      ca: options.certificateAuthority,
      path: "/api/peer/v1/self-check", method: "POST", timeout: 3000,
      headers: { host, "x-delegatus-self": nonce, "content-length": "0" },
    }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { if (body.length < 1024) body += chunk.toString().slice(0, 1024 - body.length); });
      response.on("end", () => {
        if (!response.complete) { fail(new Error("incomplete self-check response")); return; }
        try { finish({ status: response.statusCode ?? 0, ...JSON.parse(body) }); }
        catch { finish({ status: response.statusCode ?? 0 }); }
      });
      response.on("error", fail);
      response.on("aborted", () => fail(new Error("aborted self-check response")));
      response.on("close", () => fail(new Error("closed self-check response")));
    });
    timer = setTimeout(() => request.destroy(new Error("timeout")), 3000);
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", fail);
    request.end();
  }).finally(() => pending.delete(nonce));
}

export async function checkAddress(url: URL): Promise<SelfCheck> {
  const result = (code: CheckCode): SelfCheck => ({ code, at: new Date().toISOString() });
  if (!process.env.LLV_TOKEN) return result("needs-access-key");
  if (!publicEntry().publishable && !isLoopbackAddress(url.hostname)) return result("needs-remote-entry");
  const resolved = await resolvedAddress(url.hostname);
  if (url.protocol === "http:" && resolved?.kind !== "loopback" && resolved?.kind !== "private") return result("http-public");
  if (!resolved) return result("unverified");
  // Keep the original Host and SNI while connecting to the checked address.
  const pinnedHost = resolved.host;
  let reach: Probe;
  try { reach = await probeSelfAddress(url, url.host, { connectionHost: pinnedHost }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return result(code?.startsWith("ERR_TLS") || code?.startsWith("CERT") ||
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(code ?? "")
      ? "tls-failure" : "unverified");
  }
  if (reach.status === 200 && reach.vouched === true) return result("open-to-internet");
  // Without this server's own record the answer came from something else at the address.
  if (reach.status !== 200 || reach.vouched !== false || !reach.seen) return result("unverified");
  if (!hostNamesAddress(reach.arrivedHost, url)) return { ...result("host-rewritten"), expected: url.host, seen: reach.seen };
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const host of LOOPBACK_PROBE_HOSTS(port)) {
    try {
      const reply = await probeSelfAddress(url, host, { connectionHost: pinnedHost });
      if (reply.status === 200 && reply.vouched === true) return result("open-to-internet");
      // Only the self-check route answers with a boolean `vouched`, and only for
      // the nonce this probe carried. Any other answer, including the empty
      // 200 Caddy sends for a Host no site matches, never reached this Viewer.
    }
    catch { /* A proxy closing unknown hosts is safe. */ }
  }
  return result("ok");
}

export async function checkSavedAddress(): Promise<SelfCheck> {
  const self = readSelf();
  if (!self?.publicUrl) return { code: "unverified", at: new Date().toISOString() };
  const check = await checkAddress(new URL(self.publicUrl));
  const current = readSelf();
  if (current?.installId === self.installId && current.publicUrl === self.publicUrl && current.revision === self.revision)
    writeSelf({ ...current, check });
  return check;
}
