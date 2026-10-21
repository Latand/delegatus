import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { reportSpawnHeaders } from "@/lib/telegram/reportSpawn";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { config, proxy } from "./proxy";

const ACCESS_KEY = "test-access-key";
const names = ["LLV_TOKEN", "LLV_TS_HOST", "LLV_PUBLIC_HOST", "HOSTNAME"] as const;
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
beforeEach(() => { for (const name of names) delete process.env[name]; });
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

const paths = ["/", "/api/conversations", "/api/files", "/api/artifact", "/api/search/transcripts", "/api/search/memory", "/api/logs/stream", "/api/runtime/stream", "/api/self-update/events", "/api/peer/v1/self-check", "/api/artifact/frame/scope/index.html", "/sign-in"];
for (const keyed of [false, true]) {
  for (const pathname of paths) {
    test(`foreign Host is refused before credentials or route exemptions: ${pathname}, key=${keyed}`, () => {
      if (keyed) process.env.LLV_TOKEN = ACCESS_KEY;
      const response = proxy(new NextRequest(`http://127.0.0.1:8898${pathname}`, {
        headers: { host: "foreign.example.test:8898", ...(keyed ? { authorization: `Bearer ${ACCESS_KEY}`, cookie: `llv_auth=${ACCESS_KEY}` } : {}) },
      }));
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  }
  test(`loopback controls remain admitted: key=${keyed}`, () => {
    if (keyed) process.env.LLV_TOKEN = ACCESS_KEY;
    for (const host of ["localhost:8898", "127.0.0.1:8898", "[::1]:8898"]) {
      const headers = { host, ...(keyed ? { authorization: `Bearer ${ACCESS_KEY}` } : {}) };
      expect(proxy(new NextRequest("http://127.0.0.1:8898/api/files", { headers })).headers.get("x-middleware-next")).toBe("1");
    }
  });
  test(`allowed loopback, configured bind, phone and linked-install Hosts pass: key=${keyed}`, () => {
    if (keyed) process.env.LLV_TOKEN = ACCESS_KEY;
    process.env.HOSTNAME = "board.example.test";
    process.env.LLV_TS_HOST = "phone.example.test";
    process.env.LLV_PUBLIC_HOST = "linked.example.test";
    const allowed = ["localhost:8898", "LOCALHOST:8898", "127.0.0.1:8898", "[::1]:8898", "board.example.test:8898", "PHONE.EXAMPLE.TEST:443"];
    if (keyed) allowed.push("linked.example.test:443");
    for (const host of allowed) {
      const headers = { host, ...(keyed ? { authorization: `Bearer ${ACCESS_KEY}` } : {}) };
      expect({ host, next: proxy(new NextRequest("http://127.0.0.1:8898/api/files", { headers })).headers.get("x-middleware-next") }).toEqual({ host, next: "1" });
    }
    if (!keyed) expect(proxy(new NextRequest("http://127.0.0.1/api/files", { headers: { host: "linked.example.test" } })).status).toBe(403);
  });
}

test("missing and malformed Host cannot be rescued by URL, Origin or forwarding headers", () => {
  for (const host of [undefined, "localhost:8898@foreign.example.test", "localhost:abc", "[::1]:8898:extra", "localhost:65536", "localhost,foreign.example.test", "localhost.foreign.example.test"]) {
    const request = new NextRequest("http://localhost:8898/api/files", { headers: {
      ...(host ? { host } : {}), origin: "http://localhost:8898", "x-forwarded-host": "localhost:8898", "sec-fetch-site": "same-origin",
    } });
    expect({ host, status: proxy(request).status }).toEqual({ host, status: 403 });
  }
});

test("query credentials never redirect a foreign Host or set its cookie", () => {
  process.env.LLV_TOKEN = ACCESS_KEY;
  const response = proxy(new NextRequest(`http://foreign.example.test/?k=${ACCESS_KEY}`, { headers: { host: "foreign.example.test" } }));
  expect(response.status).toBe(403);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("wildcard bind addresses do not authorize arbitrary DNS names", () => {
  for (const hostname of ["0.0.0.0", "::"]) {
    process.env.HOSTNAME = hostname;
    const literal = hostname === "::" ? "[::]:8898" : "0.0.0.0:8898";
    expect(proxy(new NextRequest("http://localhost/api/files", { headers: { host: literal } })).headers.get("x-middleware-next")).toBe("1");
    for (const host of ["foreign.example.test", "192.0.2.10:8898"]) {
      expect(proxy(new NextRequest("http://localhost/api/files", { headers: { host } })).status).toBe(403);
    }
  }
});

test("static assets check Host while retaining their keyless loading behavior", () => {
  process.env.LLV_TOKEN = ACCESS_KEY;
  for (const pathname of ["/_next/static/chunks/app.js", "/favicon.ico"]) {
    for (const host of ["foreign.example.test", "localhost:8898"]) {
      const response = proxy(new NextRequest(`http://localhost:8898${pathname}`, { headers: { host } }));
      expect(response.status).toBe(host === "foreign.example.test" ? 403 : 200);
    }
  }
});

test("Next's compiled matcher covers every App Router entry except the self-gated multiplexer", async () => {
  const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
  const matches = (pathname: string) => unstable_doesMiddlewareMatch({ config, nextConfig: { basePath: "" }, url: pathname });
  const app = path.join(import.meta.dir, "app");
  const routes = fs.readdirSync(app, { recursive: true })
    .filter((file): file is string => typeof file === "string")
    .map(file => file.split(path.sep).join("/"))
    .filter(file => /(?:^|\/)(?:route|page)\.tsx?$/.test(file)).sort();
  expect(routes.length).toBeGreaterThan(100);
  for (const file of routes) {
    const pathname = "/" + file.replace(/(?:^|\/)(?:route|page)\.tsx?$/, "").replace(/\[.*?\]/g, "sample");
    expect({ pathname, matched: matches(pathname) }).toEqual({ pathname, matched: pathname !== "/api/streams" });
  }
  for (const pathname of ["/_next/static/chunks/app.js", "/favicon.ico"]) expect(matches(pathname)).toBe(true);
});

test("the Telegram relay's production headers pass Host and write-origin checks", () => {
  for (const keyed of [false, true]) {
    if (keyed) process.env.LLV_TOKEN = ACCESS_KEY;
    else delete process.env.LLV_TOKEN;
    const headers = reportSpawnHeaders("C".repeat(43), "x-llv-spawn-capability");
    if (keyed) headers.set("authorization", `Bearer ${ACCESS_KEY}`);
    const request = new NextRequest("http://127.0.0.1/api/spawn", { method: "POST", headers });
    expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
    expect(rejectCrossOrigin(request)).toBeNull();
  }
});

test("a configured IPv6 bind admits its bracketed HTTP authority", () => {
  process.env.HOSTNAME = "fd00::1234";
  const headers = { host: "[fd00::1234]:8898", origin: "http://[fd00::1234]:8898" };
  const request = new NextRequest("http://[fd00::1234]:8898/api/files", { headers });
  expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
  expect(rejectCrossOrigin(request)).toBeNull();
});
