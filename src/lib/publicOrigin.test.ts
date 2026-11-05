import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { configuredPublicOrigin, publicOriginForRequest } from "./publicOrigin";
import { rejectCrossOrigin, rejectForeignHost } from "./sameOrigin";
import { relyingParty, requestOrigin, shareableLink } from "./team/http";
import { requestIsHttps } from "./team/sessions";
import { admitsMcpHttpAccess, MCP_HTTP_ACCESS_HEADER, mcpHttpAccessToken } from "./mcp/httpAccess";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["LLV_TOKEN", "LLV_PUBLIC_ORIGIN", "LLV_PUBLIC_HOST", "LLV_TS_HOST", "LLV_TS_URL", "HOSTNAME"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configure(origin = "https://viewer.example.net:8443") {
  process.env.LLV_TOKEN = "test-access-key";
  process.env.LLV_PUBLIC_ORIGIN = origin;
  delete process.env.LLV_PUBLIC_HOST;
  delete process.env.LLV_TS_HOST;
  delete process.env.LLV_TS_URL;
  process.env.HOSTNAME = "127.0.0.1";
}

function incoming(host = "viewer.example.net:8443", origin = "https://viewer.example.net:8443", extra: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/team/session/passkey", { method: "POST", headers: {
    host, origin, "sec-fetch-site": "same-origin", ...extra,
  } });
}

test("a public origin requires an explicit named HTTPS origin and an enabled access key", () => {
  configure();
  expect(configuredPublicOrigin()?.origin).toBe("https://viewer.example.net:8443");
  const credentialOrigin = new URL("https://viewer.example.net");
  credentialOrigin.username = "user";
  for (const value of ["http://viewer.example.net", "https://127.0.0.1", "https://[::1]", "https://localhost",
    "https://device.localhost", "https://*.example.net", credentialOrigin.href, "https://viewer.example.net/path",
    "https://viewer.example.net?query=1", "https://viewer.example.net#fragment", "invalid", ""]) {
    configure(value);
    expect(configuredPublicOrigin(), value).toBeNull();
    expect(rejectForeignHost(incoming()), value).not.toBeNull();
  }
  configure();
  delete process.env.LLV_TOKEN;
  expect(configuredPublicOrigin()).toBeNull();
  expect(rejectForeignHost(incoming())).not.toBeNull();
});

test("the configured authority pins public links, RP, secure cookies and the complete browser origin", () => {
  configure();
  const request = incoming(undefined, undefined, { "x-forwarded-proto": "http", "x-forwarded-host": "evil.example.net" });
  expect(rejectForeignHost(request)).toBeNull();
  expect(rejectCrossOrigin(request)).toBeNull();
  expect(publicOriginForRequest(request)?.origin).toBe("https://viewer.example.net:8443");
  expect(relyingParty(request)).toEqual({ rpId: "viewer.example.net", origin: "https://viewer.example.net:8443" });
  expect(requestIsHttps(request)).toBeTrue();
  expect(requestOrigin(request)).toBe("https://viewer.example.net:8443");
  expect(shareableLink(request, "/join/code")).toBe("https://viewer.example.net:8443/join/code");
  for (const origin of ["http://viewer.example.net:8443", "https://viewer.example.net", "https://viewer.example.net:9443",
    "https://evil.example.net", "https://localhost", "null"]) {
    expect(rejectCrossOrigin(incoming(undefined, origin)), origin).not.toBeNull();
  }
  expect(rejectCrossOrigin(incoming("localhost", "https://viewer.example.net:8443"))).not.toBeNull();
  expect(rejectCrossOrigin(incoming(undefined, undefined, { "sec-fetch-site": "cross-site" }))).not.toBeNull();
});

test("Host and forwarded forgeries cannot configure a relying party or make the public origin loopback", () => {
  configure();
  for (const host of ["evil.example.net", "viewer.example.net:9443", "viewer.example.net", "viewer.example.net:0",
    "viewer.example.net:65536", ["viewer.example.net", "evil.example.net"].join("@"), "viewer.example.net, localhost"]) {
    const request = incoming(host, `https://${host}`, {
      "x-forwarded-host": "viewer.example.net:8443", "x-forwarded-proto": "https",
      forwarded: 'for=127.0.0.1;host="viewer.example.net:8443";proto=https', "x-real-ip": "127.0.0.1",
    });
    expect(rejectForeignHost(request), host).not.toBeNull();
    expect(rejectCrossOrigin(request), host).not.toBeNull();
    expect(relyingParty(request), host).toBeNull();
  }
  const loopback = incoming("127.0.0.1", "http://127.0.0.1", {
    "x-forwarded-host": "viewer.example.net:8443", "x-forwarded-proto": "https",
  });
  expect(publicOriginForRequest(loopback)).toBeNull();
  expect(relyingParty(loopback)).toBeNull();
  expect(rejectCrossOrigin(loopback)).toBeNull();
});

test("the configured public address cannot claim MCP loopback trust even with a local credential", () => {
  configure();
  const access = mcpHttpAccessToken()!;
  const request = (headers: Record<string, string>) => new NextRequest("http://127.0.0.1/api/mcp", {
    method: "POST", headers: { [MCP_HTTP_ACCESS_HEADER]: access, ...headers },
  });
  expect(admitsMcpHttpAccess(request({ host: "127.0.0.1", origin: "http://127.0.0.1" }))).toBeTrue();
  expect(admitsMcpHttpAccess(request({ host: "viewer.example.net:8443", origin: "https://viewer.example.net:8443",
    "x-forwarded-host": "127.0.0.1", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" }))).toBeFalse();
  expect(admitsMcpHttpAccess(request({ host: "viewer.example.net:8443", origin: "http://127.0.0.1" }))).toBeFalse();
  expect(admitsMcpHttpAccess(request({ host: "127.0.0.1", origin: "https://viewer.example.net:8443" }))).toBeFalse();
});
