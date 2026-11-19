import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import http from "node:http";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { createPageReader } from "./pageReader";

async function canary(handler: http.RequestListener) {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const dial: typeof http.request = ((options: http.RequestOptions) => http.request({ ...options, hostname: "127.0.0.1", port })) as typeof http.request;
  const reader = createPageReader({ interfaces: () => ({}), env: {}, hostname: () => "installation.example",
    resolve: async host => [{ address: host === "installation.example" ? "192.0.2.9" : host === "loop.example" ? "127.0.0.1" : host === "link.example" ? "169.254.169.254" : "8.8.8.8", family: 4 }],
    dial: ((options: http.RequestOptions) => { expect(options.hostname).toBe("8.8.8.8"); expect(options.agent).toBe(false); return dial(options); }) as typeof http.request });
  return { reader, port, hits: () => hits, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const read = (reader: ReturnType<typeof createPageReader>, url = "http://public.example/page", timeout = 1000) => reader.readPublicPage(url, { signal: new AbortController().signal, deadlineAt: Date.now() + timeout });
test("reads public HTML directly, removes executable and hidden content, sends no credentials", async () => {
  let headers: http.IncomingHttpHeaders = {};
  const c = await canary((req, res) => { headers = req.headers; res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Example</title><h1>Public &amp; useful</h1><script>secretScript()</script><style>hiddenStyle</style><noscript>hiddenFallback</noscript><template>hiddenTemplate</template><svg>hiddenVector</svg><iframe>hiddenFrame</iframe>"); });
  try {
    const result = await read(c.reader);
    expect(result.status).toBe("ok"); const content = JSON.parse(result.output);
    expect(content.title).toBe("Example"); expect(content.text).toContain("Public & useful"); expect(content.text).not.toContain("hidden"); expect(content.text).not.toContain("secretScript");
    expect(headers.host).toBe("public.example"); expect(headers["user-agent"]).toBe("Delegatus-PageReader/1");
    for (const name of ["cookie", "authorization", "referer"]) expect(headers[name]).toBeUndefined();
  } finally { await c.close(); }
});
for (const [location, kind] of [[`http://${[10, 0, 0, 1].join(".")}/private?hidden=value`, "private"], ["http://link.example", "link_local"], ["file:///secret", "scheme"], ["gopher://public.example", "scheme"], ["https://installation.example", "installation_host"]]) test(`redirect refusal: ${kind}`, async () => {
  const c = await canary((_req, res) => { res.writeHead(302, { Location: location! }); res.end(); });
  try {
    const result = await read(c.reader);
    expect(result).toMatchObject({ status: "denied", code: "url_refused", refusal: { class: kind, hop: 1 } });
    expect(result.output).not.toContain("hidden"); expect(result.output).not.toContain("private?"); expect(c.hits()).toBe(1);
  } finally { await c.close(); }
});
test("DNS to loopback refuses before dial", async () => {
  const c = await canary((_req, res) => res.end("must not read"));
  try { expect(await read(c.reader, "http://loop.example")).toMatchObject({ refusal: { class: "loopback", hop: 0 } }); expect(c.hits()).toBe(0); }
  finally { await c.close(); }
});
test("configured installation IP refuses mapped literals and mapped DNS answers before dial", async () => {
  let dials = 0;
  const reader = createPageReader({ interfaces: () => ({}), env: { LLV_PUBLIC_HOST: "8.8.8.8" }, hostname: () => "installation.example",
    resolve: async () => [{ address: "::ffff:808:808", family: 6 }],
    dial: (() => { dials++; throw new Error("denied addresses must not dial"); }) as typeof http.request });
  for (const url of ["http://[::ffff:8.8.8.8]/", "https://public.example/"]) {
    expect(await read(reader, url)).toMatchObject({ status: "denied", code: "url_refused", refusal: { class: "installation_address" } });
  }
  expect(dials).toBe(0);
});
test("installation DNS address and aliases refuse before the canary dial, including redirects", async () => {
  let hits = 0, dials = 0;
  const server = http.createServer((_req, res) => { hits++; res.writeHead(302, { Location: "http://alias.example/private" }); res.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const reader = createPageReader({ interfaces: () => ({}), env: { LLV_PUBLIC_HOST: "installation.example" }, hostname: () => "installation.example",
    resolve: async host => [{ address: host === "installation.example" ? "8.8.8.8" : host === "alias.example" ? "::ffff:808:808" : "9.9.9.9", family: host === "alias.example" ? 6 : 4 }],
    dial: ((options: http.RequestOptions) => { dials++; return http.request({ ...options, hostname: "127.0.0.1", port: (server.address() as import("node:net").AddressInfo).port }); }) as typeof http.request });
  try {
    expect(await read(reader, "http://8.8.8.8/")).toMatchObject({ status: "denied", refusal: { class: "installation_address" } });
    expect(await read(reader, "http://[::ffff:8.8.8.8]/")).toMatchObject({ status: "denied", refusal: { class: "installation_address" } });
    expect(await read(reader, "http://public.example/")).toMatchObject({ status: "denied", refusal: { class: "installation_address", hop: 1 } });
    expect(hits).toBe(1); expect(dials).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("relative redirect works, excessive redirects stop", async () => {
  const c = await canary((req, res) => {
    if (req.url === "/done") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("done"); }
    else { res.writeHead(302, { Location: req.url === "/page" ? "/done" : "/cycle" }); res.end(); }
  });
  try { expect((await read(c.reader)).status).toBe("ok"); expect(await read(c.reader, "http://public.example/cycle")).toMatchObject({ code: "too_many_redirects" }); expect(c.hits()).toBe(8); }
  finally { await c.close(); }
});
for (const encoding of ["identity", "gzip", "br"]) test(`decoded body and text bounds: ${encoding}`, async () => {
  let body = "x".repeat(20_000);
  const c = await canary((_req, res) => { res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": encoding }); res.end(encoding === "gzip" ? gzipSync(body) : encoding === "br" ? brotliCompressSync(body) : body); });
  try {
    const result = await read(c.reader); expect(result.status).toBe("ok"); expect(result.truncated).toBe(true); expect(Buffer.byteLength(JSON.parse(result.output).text)).toBe(16_384);
    body = "x".repeat(3 * 1024 * 1024); expect(await read(c.reader)).toMatchObject({ status: "error", code: "unsupported_content" });
  } finally { await c.close(); }
});
for (const [status, type, code] of [[404, "text/plain", "http_status"], [200, "image/png", "unsupported_content"]] as const) test(`response error ${code}`, async () => {
  const c = await canary((_req, res) => { res.writeHead(status, { "Content-Type": type }); res.end("content"); });
  try { expect(await read(c.reader)).toMatchObject({ status: "error", code }); } finally { await c.close(); }
});
test("a silent server times out under the request deadline", async () => {
  const c = await canary(() => {});
  try { expect(await read(c.reader, undefined, 20)).toMatchObject({ code: "timeout" }); } finally { await c.close(); }
});
test("proxy environment cannot redirect the production HTTP dial", async () => {
  let proxyHits = 0;
  const proxy = http.createServer((_req, res) => { proxyHits++; res.end("proxy"); });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const c = await canary((_req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("direct"); });
  const previous = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
  try {
    // The seam changes only the destination to the canary; node:http itself handles proxy variables.
    expect((await read(c.reader)).status).toBe("ok"); expect(proxyHits).toBe(0); expect(c.hits()).toBe(1);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await c.close(); await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test("HTTPS uses the checked address with the original TLS name and refuses a name mismatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-reader-tls-"));
  const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=public.example", "-addext", "subjectAltName=DNS:public.example,IP:8.8.8.8", "-keyout", key, "-out", cert]);
  expect(generated.status).toBe(0);
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" }); res.end("secure page");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let proxyHits = 0;
  const proxy = http.createServer((_req, res) => { proxyHits++; res.end("proxy"); });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const previousProxy = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
  let ipLiteralWithoutSni = 0;
  const reader = createPageReader({ interfaces: () => ({}), env: {}, hostname: () => "installation.example", resolve: async host => [{ address: host === "installation.example" ? "192.0.2.9" : "8.8.8.8", family: 4 }],
    dial: ((options: https.RequestOptions) => {
      const peerHost = String(options.hostname ?? "");
      expect(["8.8.8.8", "9.9.9.9"]).toContain(peerHost); expect(options.agent).toBe(false);
      if (options.servername === undefined) ipLiteralWithoutSni++;
      return https.request({ ...options, hostname: "127.0.0.1", port: (server.address() as import("node:net").AddressInfo).port,
        ca: fs.readFileSync(cert), checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(options.servername ?? peerHost, certificate) });
    }) as typeof http.request });
  try {
    expect(await read(reader, "https://public.example")).toMatchObject({ status: "ok" });
    expect(await read(reader, "https://mismatch.example")).toMatchObject({ status: "error", code: "tls" });
    expect(await read(reader, "https://8.8.8.8/")).toMatchObject({ status: "ok" });
    expect(await read(reader, "https://9.9.9.9/")).toMatchObject({ status: "error", code: "tls" });
    expect(ipLiteralWithoutSni).toBe(2);
    expect(proxyHits).toBe(0);
  } finally {
    for (const [key, value] of Object.entries(previousProxy)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => proxy.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
  }
});
