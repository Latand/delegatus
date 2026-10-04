import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import worker, { type DataPoint, type Env } from "./worker";

function harness() {
  const points: DataPoint[] = [];
  const assets: Request[] = [];
  const env: Env = {
    INSTALLS: { writeDataPoint: (point) => { points.push(point); } },
    SITE_EVENTS: { writeDataPoint: (point) => { points.push(point); } },
    ASSETS: { fetch: async (request) => { assets.push(request); return new Response("static asset"); } },
  };
  return { points, assets, env };
}

function eventRequest(body: unknown, country: unknown = "UA") {
  const request = new Request("https://example.com/api/event", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1", Cookie: "ignored=yes" },
  });
  Object.defineProperty(request, "cf", { value: { country } });
  return request;
}

describe("landing site events", () => {
  for (const lang of ["en", "uk"]) {
    for (const agent of ["claude", "codex"]) {
      test(`copy prompt: ${lang}/${agent} writes exactly one point`, async () => {
        const { env, points, assets } = harness();
        const response = await worker.fetch(eventRequest({ event: "copy_prompt", agent, lang }), env);
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(points).toEqual([{ blobs: ["copy_prompt", agent, lang, "UA"], doubles: [1], indexes: ["copy_prompt"] }]);
        expect(assets).toHaveLength(0);
      });
    }
    for (const event of ["copy_legacy", "demo_start", "fullscreen_open"]) {
      test(`${event}: ${lang} writes exactly one point`, async () => {
        const { env, points } = harness();
        expect((await worker.fetch(eventRequest({ event, lang }), env)).status).toBe(204);
        expect(points).toEqual([{ blobs: [event, "", lang, "UA"], doubles: [1], indexes: [event] }]);
      });
    }
  }

  const valid = { event: "copy_prompt", lang: "en", agent: "claude" };
  const invalid: unknown[] = [
    null, [], 1, "event", {},
    { ...valid, event: "install_ping" }, { ...valid, lang: "fr" },
    { ...valid, agent: "other" }, { ...valid, agent: null },
    { event: "copy_prompt", lang: "en" }, { event: "copy_prompt", agent: "claude" },
    { ...valid, id: "unexpected" }, { ...valid, ip: "192.0.2.1" },
    { ...valid, country: "US" }, { ...valid, extra: null },
    { event: "copy_legacy", lang: "en", agent: "claude" },
    { event: "demo_start", lang: "en", step: 1 },
    { event: "fullscreen_open", lang: "en", frame: "hero" },
    { ...valid, event: ["copy_prompt"] }, { ...valid, lang: true },
  ];
  test.each(invalid.map((body, index) => [index, body] as const))("invalid schema %i writes nothing", async (_index, body) => {
    const { env, points } = harness();
    expect((await worker.fetch(eventRequest(body), env)).status).toBe(400);
    expect(points).toEqual([]);
  });

  test.each(["", "{broken", " ".repeat(1025), new Uint8Array([255])])("malformed or oversized body writes nothing", async (body) => {
    const { env, points } = harness();
    const request = new Request("https://example.com/api/event", { method: "POST", body });
    expect((await worker.fetch(request, env)).status).toBe(400);
    expect(points).toEqual([]);
  });

  test("a chunked oversized body is refused before parsing", async () => {
    const { env, points } = harness();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
      controller.enqueue(new TextEncoder().encode(JSON.stringify(valid)));
      controller.close();
    } });
    expect((await worker.fetch(new Request("https://example.com/api/event", { method: "POST", body }), env)).status).toBe(400);
    expect(points).toEqual([]);
  });

  test.each([undefined, "unknown", "192.0.2.1", { value: "UA" }])("country is only a Cloudflare country code", async (country) => {
    const { env, points } = harness();
    const request = eventRequest(valid);
    // A fresh request also covers absent cf metadata.
    const input = new Request(request);
    if (country !== undefined) Object.defineProperty(input, "cf", { value: { country } });
    expect((await worker.fetch(input, env)).status).toBe(204);
    expect(points[0]!.blobs[3]).toBe("");
  });

  test.each(["/", "/demo/", "/main.js", "/missing", "/api"])("%s is delegated unchanged to static assets", async (pathname) => {
    const { env, assets, points } = harness();
    const request = new Request(`https://example.com${pathname}`);
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static asset");
    expect(assets).toEqual([request]);
    expect(points).toEqual([]);
  });

  test("unknown API paths and wrong methods cannot write or fall through to assets", async () => {
    const { env, points, assets } = harness();
    expect((await worker.fetch(new Request("https://example.com/api/unknown", { method: "POST" }), env)).status).toBe(404);
    const response = await worker.fetch(new Request("https://example.com/api/event"), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(points).toEqual([]);
    expect(assets).toEqual([]);
  });

  test("a failed binding write cannot acknowledge success", async () => {
    const { env } = harness();
    env.SITE_EVENTS.writeDataPoint = () => { throw new Error("binding unavailable"); };
    await expect(worker.fetch(eventRequest(valid), env)).rejects.toThrow("binding unavailable");
  });
});

const ping = { id: randomUUID(), v: "1.8.0", os: "linux", arch: "x64", kind: "checkout" };
function pingRequest(body: unknown) {
  const r = new Request("https://example.com/api/ping", { method: "POST", body: JSON.stringify(body), headers: { "CF-Connecting-IP": "192.0.2.1", Cookie: "ignored=yes" } });
  Object.defineProperty(r, "cf", { value: { country: "UA" } }); return r;
}
describe("anonymous install ping", () => {
  for (const kind of ["checkout", "packaged", "docker"]) test(`strict ${kind} point with country and no IP`, async () => {
    const { env, points } = harness();
    expect((await worker.fetch(pingRequest({ ...ping, kind }), env)).status).toBe(204);
    expect(points).toEqual([{ blobs: [ping.id, ping.v, ping.os, ping.arch, kind, "UA"], doubles: [1], indexes: [ping.id] }]);
  });
  const bad = [null, [], {}, ...Object.keys(ping).map(k => Object.fromEntries(Object.entries(ping).filter(([key]) => key !== k))),
    ...["ip", "country", "host", "project", "account", "engine", "path"].map(k => ({ ...ping, [k]: "extra" })),
    ...["bad", randomUUID().slice(0, 14) + "0" + randomUUID().slice(15), 123].map(id => ({ ...ping, id })),
    ...["1.2", "01.2.3", "1.2.3-01", "v1.2.3", 1].map(v => ({ ...ping, v })),
    { ...ping, os: "hostname" }, { ...ping, arch: "unknown" }, { ...ping, kind: "dev" }];
  test.each(bad.map((b, i) => [i, b] as const))("invalid ping %i writes nothing", async (_, b) => {
    const { env, points } = harness(); expect((await worker.fetch(pingRequest(b), env)).status).toBe(400); expect(points).toHaveLength(0);
  });
  test("512 byte limit, including streamed bodies", async () => {
    for (const size of [512, 513]) {
      const { env, points } = harness();
      const json = JSON.stringify(ping); const bytes = new TextEncoder().encode(json + " ".repeat(size - json.length));
      const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 100)); c.enqueue(bytes.slice(100)); c.close(); } });
      expect((await worker.fetch(new Request("https://example.com/api/ping", { method: "POST", body }), env)).status).toBe(size === 512 ? 204 : 400);
      expect(points).toHaveLength(size === 512 ? 1 : 0);
    }
  });
  test.each(["{broken", new Uint8Array([255])])("malformed ping writes nothing", async body => {
    const { env, points } = harness(); expect((await worker.fetch(new Request("https://example.com/api/ping", { method: "POST", body }), env)).status).toBe(400); expect(points).toHaveLength(0);
  });
  test("wrong method and failed binding", async () => {
    const { env, points } = harness(); expect((await worker.fetch(new Request("https://example.com/api/ping"), env)).status).toBe(405);
    expect(points).toHaveLength(0); env.INSTALLS.writeDataPoint = () => { throw new Error("unavailable"); };
    await expect(worker.fetch(pingRequest(ping), env)).rejects.toThrow("unavailable");
  });
});

// Generated test keys and invented aggregates; no production credentials or metrics.
describe("private stats", () => {
  const pair = crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  function config() {
    return { ...harness().env, STATS_ACCESS_TEAM_DOMAIN: `test-${randomUUID()}.cloudflareaccess.com`, STATS_ACCESS_AUD: "fixture-audience", STATS_ACCOUNT_ID: "a".repeat(32), STATS_AE_TOKEN: "fixture-credential" };
  }
  async function token(env: Env, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    const input = `${encoded({ alg: "RS256", kid: "test-key", ...header })}.${encoded({ iss: `https://${env.STATS_ACCESS_TEAM_DOMAIN}`, aud: [env.STATS_ACCESS_AUD], exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await pair).privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  }
  const request = (jwt?: string, path = "/stats", method = "GET") => new Request(`https://example.com${path}`, { method, headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });
  function sqlRows(sql: string): Record<string, unknown>[] {
    if (sql.includes("max(timestamp)")) return [{ newest: `${day(0)} 12:34:56` }];
    if (sql.includes("AS event")) return ["copy_prompt", "copy_legacy", "demo_start", "fullscreen_open"].flatMap((event, e) => Array.from({ length: 30 }, (_, i) => ({ day: day(29 - i), event, total: (i * 7 + e * 3) % 23 })));
    if (sql.includes("AS label") || sql.includes("AS os")) return sql.includes("blob2 AS label") ? [{ label: "1.9.0", total: "38" }, { label: "1.8.0", total: "12" }] : sql.includes("AS os") ? [{ os: "linux", arch: "x64", total: 28 }, { os: "darwin", arch: "arm64", total: 22 }] : [{ label: "packaged", total: 28 }, { label: "checkout", total: 16 }, { label: "docker", total: 6 }];
    if (sql.includes("AS day")) return Array.from({ length: 30 }, (_, i) => ({ day: day(29 - i), total: sql.includes("first_seen") ? i % 4 : 8 + (i * 7) % 31 }));
    return [{ total: "50" }];
  }
  async function withUpstream(run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>, options: { sql?: (sql: string) => Response; jwks?: () => Response } = {}) {
    const original = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/cdn-cgi/access/certs")) {
        if (options.jwks) return options.jwks();
        return Response.json({ keys: [{ ...await crypto.subtle.exportKey("jwk", (await pair).publicKey), kid: "test-key", alg: "RS256", use: "sig" }] });
      }
      if (!url.endsWith("/analytics_engine/sql")) throw new Error("Unexpected upstream");
      return options.sql ? options.sql(String(init?.body)) : Response.json({ data: sqlRows(String(init?.body)) });
    }) as typeof fetch;
    try { await run(calls); } finally { globalThis.fetch = original; }
  }
  test.each([undefined, "invalid", "a.b.c", "a.b.c.d"])("missing or malformed assertion returns 403", async jwt => {
    await withUpstream(async calls => {
      const response = await worker.fetch(request(jwt), config());
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(calls).toHaveLength(0);
    });
  });
  test.each([
    { exp: Math.floor(Date.now() / 1000) - 1 }, { exp: "9999999999" }, { exp: null },
    { aud: ["wrong-audience"] }, { aud: "wrong-audience" }, { iss: "https://other.cloudflareaccess.com" },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
  ])("invalid claims fail before any upstream read: %j", async claims => {
    const env = config();
    await withUpstream(async calls => { expect((await worker.fetch(request(await token(env, claims)), env)).status).toBe(403); expect(calls).toHaveLength(0); });
  });
  test("wrong algorithm, unknown key and tampered signature fail closed", async () => {
    const env = config();
    await withUpstream(async calls => {
      for (const header of [{ alg: "none" }, { alg: "HS256" }, { kid: "unknown" }]) expect((await worker.fetch(request(await token(env, {}, header)), env)).status).toBe(403);
      const jwt = await token(env);
      const pieces = jwt.split("."); pieces[1] = encoded({ iss: `https://${env.STATS_ACCESS_TEAM_DOMAIN}`, aud: env.STATS_ACCESS_AUD, exp: 9999999999 });
      expect((await worker.fetch(request(pieces.join(".")), env)).status).toBe(403);
      expect(calls.every(call => call.url.endsWith("/certs"))).toBe(true);
    });
  });
  test("missing Access config and key service failure fail closed", async () => {
    const env = config();
    await withUpstream(async calls => {
      expect((await worker.fetch(request(await token(env)), { ...env, STATS_ACCESS_AUD: undefined })).status).toBe(403);
      expect((await worker.fetch(request(await token(env)), { ...env, STATS_ACCESS_TEAM_DOMAIN: "invalid.test" })).status).toBe(403);
      expect(calls).toHaveLength(0);
      expect((await worker.fetch(request(await token(env)), env)).status).toBe(403);
    }, { jwks: () => new Response("unavailable", { status: 503 }) });
  });
  test("valid JWT renders mocked aggregates on both paths, caches keys and bounds server-side SQL", async () => {
    const env = config(); const jwt = await token(env);
    await withUpstream(async calls => {
      for (const path of ["/stats", "/stats/"]) {
        const response = await worker.fetch(request(jwt, path), env);
        expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        const html = await response.text();
        for (const section of ["Today", "Last 7 days", "Last 30 days", "Daily active installs", "New installs per day", "Version", "OS / architecture", "Install kind", "Landing actions per day", "Newest ping", "linux / x64", "1.9.0", "packaged", "copy prompt", "demo start", "fullscreen open", "12:34:56"]) expect(html).toContain(section);
        expect(html).toContain(">50</strong>");
        expect(html).not.toContain(env.STATS_AE_TOKEN!); expect(html).not.toContain(env.STATS_ACCOUNT_ID!); expect(html).not.toContain("<script");
        // Optional local review output comes from the actual authenticated handler.
        if (process.env.STATS_RENDER_DIR && path === "/stats") {
          const { mkdir } = await import("node:fs/promises");
          await mkdir(process.env.STATS_RENDER_DIR, { recursive: true });
          await Bun.write(`${process.env.STATS_RENDER_DIR}/mocked-stats.html`, html);
        }
      }
      expect(calls.filter(call => call.url.endsWith("/certs"))).toHaveLength(1);
      const sqlCalls = calls.filter(call => call.url.endsWith("/sql")); expect(sqlCalls).toHaveLength(20);
      for (const call of sqlCalls) {
        expect(call.init?.method).toBe("POST"); expect(call.init?.headers).toEqual({ Authorization: `Bearer ${env.STATS_AE_TOKEN}`, "Content-Type": "text/plain" });
        expect(call.init?.signal).toBeDefined(); const sql = String(call.init?.body);
        expect(sql).not.toContain("toDate("); expect(sql).not.toContain("concat("); expect(sql).toContain("timestamp >="); expect(sql).toContain("timestamp <="); expect(sql).toMatch(/LIMIT (1|30|100|120) FORMAT JSON$/);
      }
      expect(sqlCalls.some(call => String(call.init?.body).includes("sum(_sample_interval * double1)"))).toBe(true);
      const newSql = String(sqlCalls.find(call => String(call.init?.body).includes("first_seen"))?.init?.body);
      expect(newSql).toContain("INTERVAL '3' MONTH"); expect(newSql).toContain("min(timestamp)"); expect(newSql).toContain(") WHERE first_seen >=");
    });
  });
  test("concurrent validations share keys and expired key cache is refreshed", async () => {
    const env = config(); const jwt = await token(env); const originalNow = Date.now;
    await withUpstream(async calls => {
      try {
        const responses = await Promise.all([worker.fetch(request(jwt), env), worker.fetch(request(jwt), env)]);
        expect(responses.map(response => response.status)).toEqual([200, 200]);
        expect(calls.filter(call => call.url.endsWith("/certs"))).toHaveLength(1);
        const advanced = originalNow() + 301_000;
        Date.now = () => advanced;
        expect((await worker.fetch(request(jwt), env)).status).toBe(200);
        expect(calls.filter(call => call.url.endsWith("/certs"))).toHaveLength(2);
      } finally { Date.now = originalNow; }
    });
  });
  test("string audience accepted and other methods rejected after auth", async () => {
    const env = config();
    await withUpstream(async calls => {
      const jwt = await token(env, { aud: env.STATS_ACCESS_AUD });
      const response = await worker.fetch(request(jwt, "/stats", "POST"), env);
      expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("GET"); expect(calls).toHaveLength(1);
      expect((await worker.fetch(request(jwt), env)).status).toBe(200);
    });
  });
  test("failed SQL is inline, preserves other sections and never exposes upstream error", async () => {
    const env = config();
    await withUpstream(async () => {
      const response = await worker.fetch(request(await token(env)), env);
      expect(response.status).toBe(200); const html = await response.text();
      expect(html).toContain("Data unavailable"); expect(html).toContain("packaged"); expect(html).not.toContain("private upstream details");
    }, { sql: sql => sql.includes("blob2 AS label") ? new Response("private upstream details", { status: 500 }) : Response.json({ data: sqlRows(sql) }) });
  });
  test.each(["missing-data", "invalid-json", "network", "missing-config"])("unavailable SQL state %s still renders", async mode => {
    const env = config();
    await withUpstream(async () => {
      const response = await worker.fetch(request(await token(env)), mode === "missing-config" ? { ...env, STATS_AE_TOKEN: undefined } : env);
      expect(response.status).toBe(200); expect(await response.text()).toContain("Data unavailable");
    }, { sql: () => { if (mode === "network") throw new Error("private upstream details"); return mode === "invalid-json" ? new Response("bad JSON") : Response.json({ errors: ["private upstream details"] }); } });
  });
  test("empty datasets and missing dates render zero counts with safe labels", async () => {
    const env = config();
    await withUpstream(async () => {
      const html = await (await worker.fetch(request(await token(env)), env)).text();
      expect(html).toContain("No retained pings"); expect(html).toContain("No landing actions"); expect(html).toContain(">0</strong>"); expect(html).not.toContain("NaN");
    }, { sql: () => Response.json({ data: [] }) });
  });
  test("metric labels are escaped as text", async () => {
    const env = config();
    await withUpstream(async () => {
      const html = await (await worker.fetch(request(await token(env)), env)).text();
      expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    }, { sql: sql => Response.json({ data: sql.includes("AS label") ? [{ label: "<script>alert('x')</script>", total: 1 }] : sqlRows(sql) }) });
  });
  test("Worker-first config covers stats and both API routes", async () => {
    const config = JSON.parse(await Bun.file(`${import.meta.dir}/wrangler.jsonc`).text());
    expect(config.assets.run_worker_first).toEqual(["/api/*", "/stats", "/stats/"]);
    expect(config.vars.STATS_ACCESS_TEAM_DOMAIN).toMatch(/\.cloudflareaccess\.com$/);
    expect(config.vars.STATS_ACCESS_AUD).toBeTruthy(); expect(config.vars.STATS_AE_TOKEN).toBeUndefined(); expect(config.vars.STATS_ACCOUNT_ID).toBeUndefined();
  });
});
