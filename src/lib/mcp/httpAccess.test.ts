import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { mcpHttpAccessToken, MCP_HTTP_ACCESS_HEADER } from "./httpAccess";
import { viewerMcpHttpClaudeEntry, viewerMcpHttpCodexEntry, viewerMcpHttpUrl, viewerMcpTransportForLaunch } from "@/lib/agent/spawnPolicy";
import { ownFixtureChild } from "./ownedFixtureChildren";

const original = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
  Object.assign(process.env, original);
});

function keyed() {
  process.env.LLV_TOKEN = crypto.randomBytes(32).toString("base64url");
  process.env.HOSTNAME = "127.0.0.1";
  process.env.LLV_PUBLIC_HOST = "phone.example.test";
  return mcpHttpAccessToken()!;
}

function request(access: string, headers: Record<string, string> = {}, pathname = "/api/mcp", method = "POST") {
  return new NextRequest(`http://127.0.0.1:8898${pathname}`, {
    method, headers: { host: "127.0.0.1:8898", [MCP_HTTP_ACCESS_HEADER]: access, ...headers },
  });
}

test("the issued credential admits only local MCP and confers no browser cookie", () => {
  const access = keyed();
  expect(access === process.env.LLV_TOKEN).toBe(false);
  for (const host of ["127.0.0.1:8898", "localhost:8898", "[::1]:8898"]) {
    const accepted = proxy(request(access, { host, "x-forwarded-for": "127.0.0.1, ::1, ::ffff:127.0.0.1" }));
    expect(accepted.headers.get("x-middleware-next")).toBe("1");
    expect(accepted.headers.get("set-cookie")).toBeNull();
  }
  for (const pathname of ["/api/files", "/api/mcp/", "/api/spawn", "/api/runtime/send"]) {
    expect(proxy(request(access, {}, pathname)).status).toBe(403);
  }
  for (const method of ["GET", "DELETE", "OPTIONS"]) expect(proxy(request(access, {}, "/api/mcp", method)).status).toBe(403);
  expect(proxy(request(process.env.LLV_TOKEN!)).status).toBe(403);
  expect(proxy(request(crypto.randomBytes(32).toString("base64url"))).status).toBe(403);
  const rotated = keyed();
  expect(proxy(request(access)).status).toBe(403);
  expect(proxy(request(rotated)).headers.get("x-middleware-next")).toBe("1");
});

test("a non-loopback listener refuses the local credential despite spoofed loopback headers", async () => {
  const access = keyed();
  for (const hostname of ["0.0.0.0", "[::]", "192.0.2.10"]) {
    for (const headers of [{}, {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "127.0.0.1:8898",
      "x-forwarded-proto": "http",
      origin: "http://127.0.0.1:8898",
    }] as Record<string, string>[]) {
      // Next constructs this URL from the listener hostname, independently
      // of the caller's Host and forwarding headers.
      const incoming = (extraHeaders: Record<string, string> = {}) => new NextRequest(`http://${hostname}:8898/api/mcp`, {
        method: "POST", headers: { host: "127.0.0.1:8898", [MCP_HTTP_ACCESS_HEADER]: access, ...headers, ...extraHeaders },
      });
      const response = proxy(incoming());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "access denied: key required" });
      expect(proxy(incoming({ authorization: `Bearer ${process.env.LLV_TOKEN}` })).headers.get("x-middleware-next")).toBe("1");
    }
  }
  delete process.env.LLV_TOKEN;
  expect(proxy(new NextRequest("http://0.0.0.0:8898/api/mcp", {
    method: "POST", headers: { host: "127.0.0.1:8898", "x-forwarded-for": "127.0.0.1" },
  })).headers.get("x-middleware-next")).toBe("1");
});

test("Next's localhost URL fallback cannot vouch for an unknown or network bind", async () => {
  const access = keyed();
  for (const hostname of [undefined, "", "0.0.0.0", "::", "192.0.2.10"]) {
    if (hostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = hostname;
    const response = proxy(request(access, { "x-forwarded-for": "127.0.0.1" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access denied: key required" });
  }
  for (const hostname of ["127.0.0.1", "localhost", "::1"]) {
    process.env.HOSTNAME = hostname;
    expect(proxy(request(access)).headers.get("x-middleware-next")).toBe("1");
  }
});

for (const headers of [
  { origin: "http://phone.example.test" },
  { origin: "http://foreign.example.test" },
  { origin: "null" },
  { host: "foreign.example.test" },
  { host: "phone.example.test" },
  { "x-forwarded-for": "203.0.113.10" },
  { "x-forwarded-for": "127.0.0.1, 203.0.113.10" },
  { "x-forwarded-for": "" },
  { forwarded: "for=127.0.0.1" },
  { "x-real-ip": "127.0.0.1" },
  { "sec-fetch-site": "cross-site" },
] as Record<string, string>[]) test(`local MCP credential refuses hostile ingress: ${JSON.stringify(headers)}`, async () => {
  const access = keyed();
  expect(proxy(request(access)).headers.get("x-middleware-next")).toBe("1");
  const response = proxy(request(access, headers));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: headers.host === "foreign.example.test"
    ? "forbidden: cross-origin request" : "access denied: key required" });
});

test("remote callers still authenticate with the normal key, cookie and key-link rules", () => {
  const access = keyed();
  const headers = { host: "phone.example.test", origin: "http://phone.example.test", "x-forwarded-for": "203.0.113.10" };
  expect(proxy(request(access, headers)).status).toBe(403);
  for (const auth of [{ authorization: `Bearer ${process.env.LLV_TOKEN}` }, { cookie: `llv_auth=${process.env.LLV_TOKEN}` }] as Record<string, string>[]) {
    expect(proxy(request(access, { ...headers, ...auth })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request(access, { ...headers, ...auth, host: "foreign.example.test" })).status).toBe(403);
  }
});

test("all generated HTTP definitions use a separate credential and keep it off foreign endpoints", () => {
  const access = keyed();
  const source = { LLV_TOKEN: process.env.LLV_TOKEN, LLV_VIEWER_PORT: "8898", HOSTNAME: "127.0.0.1" };
  const claude = viewerMcpHttpClaudeEntry(source) as { headers: Record<string, string> };
  const codex = viewerMcpHttpCodexEntry(source) as { http_headers: Record<string, string> };
  expect(claude.headers[MCP_HTTP_ACCESS_HEADER] === access).toBe(true);
  expect(codex.http_headers[MCP_HTTP_ACCESS_HEADER] === access).toBe(true);
  expect(JSON.stringify([claude, codex]).includes(process.env.LLV_TOKEN!)).toBe(false);
  const foreign = { ...source, LLV_MCP_HTTP_URL: "http://127.0.0.1:41234/api/mcp" };
  expect(viewerMcpTransportForLaunch({ LLV_SPAWN_CAPABILITY: "a".repeat(43) }, foreign)).toBe("stdio");
  expect(JSON.stringify([viewerMcpHttpClaudeEntry(foreign), viewerMcpHttpCodexEntry(foreign)]).includes(access)).toBe(false);
  for (const url of [
    "http://foreign.example.test:8898/api/mcp", "http://127.0.0.1:8898/other",
    "http://127.0.0.1:8898/api/mcp?redirect=1", "http://127.0.0.1:8898/api/mcp#fragment",
    "http://fixture@127.0.0.1:8898/api/mcp",
  ]) expect(viewerMcpHttpUrl({ ...source, LLV_MCP_HTTP_URL: url })).toBe("http://127.0.0.1:8898/api/mcp");
  delete process.env.LLV_TOKEN;
  expect(mcpHttpAccessToken()).toBeNull();
  expect(JSON.stringify([viewerMcpHttpClaudeEntry({}), viewerMcpHttpCodexEntry({})])).not.toContain(MCP_HTTP_ACCESS_HEADER);
});

test.each([undefined, "", "0.0.0.0", "::", "[::]", "192.0.2.10"])("a keyed %s bind retains stdio and issues no HTTP definition credential", hostname => {
  keyed();
  const source = { LLV_TOKEN: process.env.LLV_TOKEN, LLV_VIEWER_PORT: "8898", HOSTNAME: hostname };
  expect(viewerMcpTransportForLaunch({ LLV_SPAWN_CAPABILITY: "a".repeat(43) }, source)).toBe("stdio");
  for (const entry of [viewerMcpHttpClaudeEntry(source), viewerMcpHttpCodexEntry(source), viewerMcpHttpCodexEntry(source, true)]) {
    expect(JSON.stringify(entry)).not.toContain(MCP_HTTP_ACCESS_HEADER);
    expect(JSON.stringify(entry).includes(mcpHttpAccessToken(source)!)).toBe(false);
  }
  expect(viewerMcpTransportForLaunch({ LLV_SPAWN_CAPABILITY: "a".repeat(43) }, { ...source, LLV_TOKEN: undefined })).toBe("http");
});

test.each(["127.0.0.1", "localhost", "::1", "[::1]"])("a keyed %s bind admits HTTP and issues its credential", hostname => {
  keyed();
  const source = { LLV_TOKEN: process.env.LLV_TOKEN, LLV_VIEWER_PORT: "8898", HOSTNAME: hostname };
  expect(viewerMcpTransportForLaunch({ LLV_SPAWN_CAPABILITY: "a".repeat(43) }, source)).toBe("http");
  for (const entry of [viewerMcpHttpClaudeEntry(source), viewerMcpHttpCodexEntry(source), viewerMcpHttpCodexEntry(source, true)]) {
    expect(JSON.stringify(entry)).toContain(MCP_HTTP_ACCESS_HEADER);
  }
});

test("independent Viewer processes accept the issued credential and key rotation revokes it", async () => {
  const access = keyed();
  // Each child imports a fresh proxy graph. The credential is passed through
  // its environment and never placed in command arguments or diagnostics.
  const script = `
    import { NextRequest } from "next/server";
    import { proxy } from "./src/proxy";
    import { MCP_HTTP_ACCESS_HEADER } from "./src/lib/mcp/httpAccess";
    const result = proxy(new NextRequest("http://127.0.0.1:8898/api/mcp", {
      method: "POST", headers: { host: "127.0.0.1:8898", [MCP_HTTP_ACCESS_HEADER]: process.env.LLV_MCP_HTTP_ACCESS }
    }));
    console.log(result.status);
  `;
  for (const rotated of [false, false, true]) {
    const child = ownFixtureChild(Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, LLV_MCP_HTTP_ACCESS: access, ...(rotated ? { LLV_TOKEN: crypto.randomBytes(32).toString("base64url") } : {}) },
      stdout: "pipe", stderr: "pipe",
    }));
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output, error }).toEqual({ code: 0, output: rotated ? "403\n" : "200\n", error: "" });
  }
});
