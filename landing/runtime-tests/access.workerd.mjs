import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { transform } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";

// Exercise the production fetch handler in workerd. Only upstream HTTP is stubbed;
// Request construction, redirects, JWT decoding and WebCrypto remain real.
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const source = await readFile(new URL("../worker.ts", import.meta.url), "utf8");
const { code: script } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const issuer = "https://fixture.cloudflareaccess.com";
const audience = "fixture-audience";
const pair = await webcrypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
}, true, ["sign", "verify"]);
const jwk = { ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: "fixture-key", alg: "RS256", use: "sig" };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
async function token(claims = {}, header = {}) {
  const input = `${encode({ alg: "RS256", kid: jwk.kid, ...header })}.${encode({
    iss: issuer, aud: [audience], exp: Math.floor(Date.now() / 1000) + 600, ...claims,
  })}`;
  const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, Buffer.from(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}
async function runtime(run, { certs, sql } = {}) {
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: config.compatibility_date,
    cf: false, port: 0, log: new Log(LogLevel.NONE),
    bindings: {
      STATS_ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com", STATS_ACCESS_AUD: audience,
      STATS_ACCOUNT_ID: "a".repeat(32), STATS_AE_TOKEN: "fixture-credential",
    },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.origin === issuer && url.pathname === "/cdn-cgi/access/certs") {
        return certs ? certs() : Response.json({ keys: [jwk] });
      }
      if (url.origin === "https://api.cloudflare.com" && url.pathname.endsWith("/analytics_engine/sql")) {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("authorization"), "Bearer fixture-credential");
        return sql ? sql() : Response.json({ data: [{ total: 7 }] });
      }
      throw new Error("Unexpected upstream in fixture");
    },
  }));
  const fetchStats = (jwt, path = "/stats", method = "GET") => mf.dispatchFetch(`https://example.com${path}`, {
    method, headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
  });
  try { await run(fetchStats, calls); } finally { await mf.dispose(); }
}

test("valid synthetic RSA assertion reaches aggregates on both stats paths and reuses completed keys", async () => {
  const jwt = await token();
  await runtime(async (fetchStats, calls) => {
    for (const path of ["/stats", "/stats/"]) {
      const response = await fetchStats(jwt, path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const html = await response.text();
      assert.ok(html.includes(">7</strong>"));
      assert.ok(!html.includes("Data unavailable"));
      assert.ok(!html.includes(jwt));
      assert.ok(!html.includes("fixture-credential"));
    }
    assert.equal(calls.filter(path => path.endsWith("/certs")).length, 1);
    assert.equal(calls.filter(path => path.endsWith("/sql")).length, 20);
  });
});

test("overlapping requests can share the pending public key result in workerd", async () => {
  const jwt = await token();
  await runtime(async (fetchStats, calls) => {
    const responses = await Promise.all([fetchStats(jwt), fetchStats(jwt)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    for (const response of responses) await response.arrayBuffer();
    assert.equal(calls.filter(path => path.endsWith("/certs")).length, 1);
  }, { certs: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return Response.json({ keys: [jwk] });
  } });
});

test("invalid assertion checks fail closed before any upstream fetch", async () => {
  await runtime(async (fetchStats, calls) => {
    const inputs = [undefined, "a.b.c", await token({ iss: "https://other.cloudflareaccess.com" }),
      await token({ aud: ["wrong"] }), await token({ exp: 1 }),
      await token({ nbf: Math.floor(Date.now() / 1000) + 3600 }), await token({}, { alg: "HS256" })];
    for (const jwt of inputs) assert.equal((await fetchStats(jwt)).status, 403);
    assert.equal(calls.length, 0);
  });
});

test("key selection and signature checks still deny access", async () => {
  await runtime(async fetchStats => {
    assert.equal((await fetchStats(await token({}, { kid: "unknown" }))).status, 403);
    const jwt = await token();
    const parts = jwt.split(".");
    parts[1] = encode({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 900 });
    assert.equal((await fetchStats(parts.join("."))).status, 403);
    assert.equal((await fetchStats(await token(), "/stats", "POST")).status, 405);
  });
});

for (const status of [301, 302, 307, 308, 503]) {
  test(`certs HTTP ${status} is denied without following its location`, async () => {
    await runtime(async (fetchStats, calls) => {
      const response = await fetchStats(await token());
      assert.equal(response.status, 403);
      assert.equal(await response.text(), "Forbidden");
      assert.deepEqual(calls, ["/cdn-cgi/access/certs"]);
    }, { certs: () => new Response("unavailable", { status, headers: { Location: "https://redirect.example/certs" } }) });
  });
}

test("invalid certs shape fails closed", async () => {
  await runtime(async fetchStats => {
    assert.equal((await fetchStats(await token())).status, 403);
  }, { certs: () => Response.json({ keys: "invalid" }) });
});

test("SQL redirects are not followed or given the server credential", async () => {
  await runtime(async (fetchStats, calls) => {
    const response = await fetchStats(await token());
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("Data unavailable"));
    assert.ok(!html.includes("fixture-credential"));
    assert.equal(calls.filter(path => path.endsWith("/sql")).length, 10);
    assert.equal(calls.length, 11);
  }, { sql: () => new Response(null, { status: 302, headers: { Location: "https://redirect.example/sql" } }) });
});
