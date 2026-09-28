import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import type { TLSSocket } from "node:tls";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { NextRequest } from "next/server";

import { statePath } from "@/lib/configDir";
import { viewerBootGateKey } from "@/lib/access/phoneAccessBootGate";
import { PhoneGateRefusal, restoreLinksGate } from "@/lib/access/phoneAccess";
import { rejectCrossOrigin, rejectForeignHost } from "@/lib/sameOrigin";
import { LOOPBACK_PROBE_HOSTS, isLoopbackHost, serveViewerLocalEntry } from "@/runtime-host/deploymentProxy";
import { recordViewerEntries } from "@/runtime-host/viewerEntries";
import { proxy } from "@/proxy";
import { POST as selfCheckRoute } from "@/app/api/peer/v1/self-check/route";

import { checkAddress, checkSavedAddress, currentSelf, probeSelfAddress, saveAddress, selfFile } from "./self";

const names = ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "LLV_TOKEN", "LLV_PUBLIC_HOST", "LLV_DOCKER_NSENTER_SHIMS", "PORT"] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-links-self-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  for (const name of ["LLV_TOKEN", "LLV_PUBLIC_HOST", "LLV_DOCKER_NSENTER_SHIMS", "PORT"]) delete process.env[name];
});
afterEach(() => {
  for (const name of names) {
    const prior = original[name];
    if (prior === undefined) delete process.env[name]; else process.env[name] = prior;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("refuses non-loopback addresses without a key and public HTTP with a key", async () => {
  expect((await saveAddress("http://169.254.0.123:8898")).refusal).toBe("needs-access-key");
  expect((await saveAddress("https://203.0.113.10")).refusal).toBe("needs-access-key");
  expect(fs.existsSync(selfFile())).toBe(false);
  process.env.LLV_TOKEN = "test-access-key";
  expect((await saveAddress("http://203.0.113.10")).refusal).toBe("http-public");
  process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  recordViewerEntries(statePath("viewer-entries.json"), { stablePort: 8898, stableEntry: "local-entry", remoteEntryPort: null });
  fs.writeFileSync(statePath("viewer-gateway.json"), JSON.stringify({ localEntry: "trusted" }));
  expect((await saveAddress("https://203.0.113.10")).refusal).toBe("needs-remote-entry");
});

test("a saved public host is pinned only while the access key exists", () => {
  const request = new NextRequest("http://localhost/api/pipelines", { headers: { host: "board.example.test" } });
  expect(rejectForeignHost(request)?.status).toBe(403);
  process.env.LLV_PUBLIC_HOST = "board.example.test";
  expect(rejectForeignHost(request)?.status).toBe(403);
  process.env.LLV_TOKEN = "test-access-key";
  expect(rejectForeignHost(request)).toBeNull();
  delete process.env.LLV_TOKEN;
  expect(rejectForeignHost(request)?.status).toBe(403);
  process.env.LLV_TOKEN = "test-access-key";
  for (const route of ["/api/pipelines", "/api/spawn", "/api/board"]) {
    const pinned = new NextRequest(`https://board.example.test${route}`, {
      headers: { host: "board.example.test", origin: "https://board.example.test" },
    });
    expect(rejectCrossOrigin(pinned)).toBeNull();
  }
});

test("an IPv6 address remains pinned after save and boot restore", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  expect((await saveAddress("http://[fd00::1234]:32123")).refusal).toBeUndefined();
  expect(process.env.LLV_PUBLIC_HOST).toBe("[fd00::1234]");
  const request = new NextRequest("http://[fd00::1234]:32123/api/board", {
    headers: { host: "[fd00::1234]:32123", origin: "http://[fd00::1234]:32123" },
  });
  expect(rejectCrossOrigin(request)).toBeNull();
  delete process.env.LLV_PUBLIC_HOST;
  await restoreLinksGate();
  expect(String(process.env.LLV_PUBLIC_HOST)).toBe("[fd00::1234]");
  expect(rejectCrossOrigin(request)).toBeNull();
});

test("a saved HTTP name is rechecked against DNS and every probe uses the approved address", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ host: request.headers.host, vouched: false }));
  });
  const port = await listen(server);
  let address = "127.0.0.1";
  const lookup = spyOn(dns, "lookup").mockImplementation((async () => [{ address, family: 4 }]) as unknown as typeof dns.lookup);
  try {
    const url = `http://board.example.test:${port}`;
    expect((await saveAddress(url)).self?.check?.code).toBe("ok");
    const before = requests;
    address = "203.0.113.10";
    expect((await checkSavedAddress()).code).toBe("http-public");
    expect(requests).toBe(before);
    expect((await saveAddress(url)).refusal).toBe("http-public");
    address = "127.0.0.1";
    const callsBefore = lookup.mock.calls.length;
    expect((await checkSavedAddress()).code).toBe("ok");
    expect(lookup.mock.calls.length).toBe(callsBefore + 1);
    expect(requests).toBeGreaterThan(before);
  } finally { lookup.mockRestore(); await close(server); }
});

test("a slow Check cannot restore an address cleared by a newer Save", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  let hold = false;
  let arrived!: () => void;
  let release!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = http.createServer((request, response) => {
    const answer = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ host: request.headers.host, vouched: false }));
    };
    if (hold) { hold = false; arrived(); void gate.then(answer); }
    else answer();
  });
  const port = await listen(server);
  try {
    const url = `http://127.0.0.1:${port}`;
    expect((await saveAddress(url, "old label")).self?.publicUrl).toBe(url);
    hold = true;
    const checking = checkSavedAddress();
    await arrival;
    expect((await saveAddress("", "new label")).self?.publicUrl).toBeNull();
    release();
    await checking;
    expect(currentSelf().self).toMatchObject({ publicUrl: null, label: "new label", check: null });
    expect(process.env.LLV_PUBLIC_HOST).toBe("");
  } finally { release(); await close(server); }
});

test("a gateway changed after save creates a standing refusal without rewriting self.json", () => {
  process.env.LLV_TOKEN = "test-access-key";
  process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  fs.mkdirSync(path.dirname(selfFile()), { recursive: true });
  fs.writeFileSync(selfFile(), JSON.stringify({ v: 1, installId: "install-a", label: "box", publicUrl: "https://board.example.test", check: null }));
  recordViewerEntries(statePath("viewer-entries.json"), { stablePort: 8898, stableEntry: "local-entry", remoteEntryPort: 8897 });
  fs.writeFileSync(statePath("viewer-gateway.json"), JSON.stringify({ remoteEntryPort: 8897, localEntry: "trusted" }));
  expect(currentSelf().state).toBeNull();
  const before = fs.readFileSync(selfFile());
  fs.writeFileSync(statePath("viewer-gateway.json"), JSON.stringify({ localEntry: "trusted" }));
  expect(currentSelf().state).toBe("needs-remote-entry");
  expect(fs.readFileSync(selfFile())).toEqual(before);
});

test("boot restores the public host and the saved address's key", async () => {
  const token = "a".repeat(32);
  fs.mkdirSync(path.dirname(selfFile()), { recursive: true });
  fs.writeFileSync(selfFile(), JSON.stringify({ v: 1, installId: "install-a", label: "box", publicUrl: "https://board.example.test", check: null }));
  const configDir = path.join(root, "config", "delegatus");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "token"), token);
  expect(viewerBootGateKey({ XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: statePath() })).toBe(token);
  await restoreLinksGate();
  expect(process.env.LLV_TOKEN).toBe(token);
  expect(process.env.LLV_PUBLIC_HOST).toBe("board.example.test");
});

test("boot refuses a saved public address when no access key can be installed", async () => {
  fs.mkdirSync(path.dirname(selfFile()), { recursive: true });
  fs.writeFileSync(selfFile(), JSON.stringify({ v: 1, installId: "install-a", label: "box", publicUrl: "https://board.example.test", check: null }));
  const configDir = path.join(root, "config", "delegatus");
  fs.mkdirSync(path.join(configDir, "token"), { recursive: true });
  await expect(restoreLinksGate()).rejects.toBeInstanceOf(PhoneGateRefusal);
  expect(process.env.LLV_TOKEN).toBeUndefined();
});

test("self-check route is closed without a one-time nonce", () => {
  const request = new NextRequest("http://localhost/api/peer/v1/self-check", { method: "POST", headers: { host: "localhost" } });
  expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
  expect(selfCheckRoute(request).status).toBe(401);
  const unknown = new NextRequest("http://localhost/api/peer/v1/other", { method: "GET" });
  expect(proxy(unknown).status).toBe(401);
  for (const host of LOOPBACK_PROBE_HOSTS("443")) expect(isLoopbackHost(host)).toBe(true);
});

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}
async function close(server: http.Server): Promise<void> { await new Promise((resolve) => server.close(resolve)); }

test("pass-through proxy to a remote entry passes all spoof probes; a trusted entry is detected", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  const viewer = http.createServer(async (incoming, outgoing) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
    const request = new NextRequest(`http://localhost${incoming.url}`, { method: "POST", headers });
    const response = selfCheckRoute(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  const viewerPort = await listen(viewer);
  const target = path.join(root, "target.json");
  fs.writeFileSync(target, JSON.stringify({ revision: "test", image: "viewer:test", container: "viewer-test", endpoint: `http://127.0.0.1:${viewerPort}` }));
  const gatewayFile = path.join(root, "gateway.json");
  fs.writeFileSync(gatewayFile, JSON.stringify({ localEntry: "trusted" }));
  const trusted = serveViewerLocalEntry(target, 0, "127.0.0.1", { gatewayFile, releaseCredential: () => "test-access-key" });
  await once(trusted, "listening");
  const trustedAddress = trusted.address();
  if (!trustedAddress || typeof trustedAddress === "string") throw new Error("no trusted port");
  let targetPort = viewerPort;
  let rewriteHost = false;
  let onlySpoofHost: string | null = null;
  const front = http.createServer((incoming, outgoing) => {
    if (onlySpoofHost && incoming.headers.host !== `board.example.test:${frontPort}` && incoming.headers.host !== onlySpoofHost) {
      outgoing.writeHead(421);
      outgoing.end();
      return;
    }
    const upstream = http.request({ host: "127.0.0.1", port: targetPort, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: rewriteHost ? "localhost" : incoming.headers.host } }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  const frontPort = await listen(front);
  const publicUrl = new URL(`http://board.example.test:${frontPort}`);
  const lookup = spyOn(dns, "lookup").mockImplementation((async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof dns.lookup);
  try {
    expect((await checkAddress(publicUrl)).code).toBe("ok");
    rewriteHost = true;
    expect((await checkAddress(publicUrl)).code).toBe("host-rewritten");
    rewriteHost = false;
    targetPort = trustedAddress.port;
    onlySpoofHost = "LOCALHOST";
    expect((await checkAddress(publicUrl)).code).toBe("open-to-internet");
    onlySpoofHost = `127.0.0.1:${frontPort}`;
    expect((await checkAddress(publicUrl)).code).toBe("open-to-internet");
  } finally {
    lookup.mockRestore();
    await close(front);
    await close(trusted);
    await close(viewer);
  }
  expect((await checkAddress(publicUrl)).code).toBe("http-public");
});

test("HTTPS probes keep the public SNI while sending a spoofed Host under Bun", async () => {
  const key = path.join(root, "key.pem");
  const cert = path.join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert,
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  let seenHost = "";
  let seenSni = "";
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    seenHost = request.headers.host ?? "";
    seenSni = (request.socket as TLSSocket).servername || "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ host: seenHost, vouched: false }));
  });
  const port = await listen(server);
  try {
    const reply = await probeSelfAddress(new URL(`https://localhost:${port}`), "LOCALHOST:443", { certificateAuthority: fs.readFileSync(cert, "utf8") });
    expect(reply).toMatchObject({ status: 200, host: "LOCALHOST:443", vouched: false });
    expect(seenHost).toBe("LOCALHOST:443");
    expect(seenSni).toBe("localhost");
  } finally { await close(server); }
});
