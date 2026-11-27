import { timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { authenticator, enrollmentSecret, fixtureInstallId, forgedCookie, secondToken, testToken } from "./runtime-tests/authenticator.mjs";
import { DAY, utcDay } from "./stats/metrics";
import { StatsCore, type StatsClient, type StatsStorage } from "./stats/store";
import worker, { type Env } from "./worker";

const origin = "https://stats.example";
const rp = "stats.example";
const fixed = Date.parse("2026-10-11T12:30:00Z");
const countTables = ["credentials", "sessions", "used_enrollments", "used_challenges", "install_days", "site_event_days",
  "swarm_usage_days", "meta", "imported_days"];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setSystemTime();
});

async function harness(options: Partial<Env> = {}) {
  setSystemTime(fixed);
  const assets: Request[] = [];
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  let alarm: number | null = null;
  let failSql = "";
  const storage: StatsStorage = {
    transactionSync: action => db.transaction(action)(),
    getAlarm: async () => alarm,
    setAlarm: async time => { alarm = time; },
    // SQLite writes execute eagerly, just as SQL storage exec does.
    exec(sql, ...params) {
      if (failSql && sql.includes(failSql)) throw new Error("fixture section unavailable");
      const bindings = params.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      if (/^\s*SELECT\b/i.test(sql)) {
        const rows = db.query(sql).all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows.map(row => Object.fromEntries(Object.entries(row)
          .map(([key, value]) => [key, value instanceof Uint8Array ? Uint8Array.from(value).buffer : value]))) };
      }
      if (params.length === 0) db.exec(sql);
      else db.query(sql).run(...bindings);
      return { toArray: () => [] };
    },
  };
  let storeCalls = 0;
  let snapshotCalls = 0;
  // A compatible asset fallback lets the same refusal requests exercise main's Worker.
  const env: Env = {
    STATS_ORIGIN: origin, STATS_RP_ID: rp, STATS_ENROLLMENT: await enrollmentSecret(testToken, fixed),
    STATS_VERSION: { id: "fixture-1" },
    ASSETS: { fetch: async request => { assets.push(request); return new Response("static asset"); } },
    STATS: {
      idFromName: name => { expect(name).toBe("stats"); return { toString: () => name, equals: other => other.toString() === name }; },
      get: () => { storeCalls++; return client; },
    },
    ...options,
  };
  let core: StatsCore;
  async function restart() { core = new StatsCore(storage, env, timingSafeEqual); await core.start(); }
  await restart();
  const client: StatsClient = {
    enrollmentOptions: token => core.enrollmentOptions(token),
    enroll: input => core.enroll(input),
    loginOptions: () => core.loginOptions(),
    login: input => core.login(input),
    session: token => core.session(token),
    snapshot: token => { snapshotCalls++; return core.snapshot(token); },
    revoke: (...args) => core.revoke(...args),
    recordPing: async (...args) => core.recordPing(...args),
    recordEvent: async (...args) => core.recordEvent(...args),
  };
  return {
    env, db, client, assets, restart,
    tick: async () => { alarm = null; await core.alarm(); },
    failSection: (query: string) => { failSql = query; },
    get alarm() { return alarm; },
    get storeCalls() { return storeCalls; },
    get snapshotCalls() { return snapshotCalls; },
    counts: () => countTables.map(table => db.query(`SELECT count(*) AS n FROM ${table}`).get()),
    events: () => db.query("SELECT * FROM site_event_days ORDER BY event, agent, lang, country").all(),
    pings: () => db.query("SELECT * FROM install_days ORDER BY day, id").all(),
  };
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
        const { env, events, assets } = await harness();
        const response = await worker.fetch(eventRequest({ event: "copy_prompt", agent, lang }), env);
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(events()).toEqual([{ day: utcDay(fixed), event: "copy_prompt", agent, lang, country: "UA", total: 1 }]);
        expect(assets).toHaveLength(0);
      });
    }
    for (const event of ["copy_legacy", "demo_start", "fullscreen_open"]) {
      test(`${event}: ${lang} writes exactly one point`, async () => {
        const { env, events } = await harness();
        expect((await worker.fetch(eventRequest({ event, lang }), env)).status).toBe(204);
        expect(events()).toEqual([{ day: utcDay(fixed), event, agent: "", lang, country: "UA", total: 1 }]);
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
    const { env, events } = await harness();
    expect((await worker.fetch(eventRequest(body), env)).status).toBe(400);
    expect(events()).toEqual([]);
  });

  test.each(["", "{broken", " ".repeat(1025), new Uint8Array([255])])("malformed or oversized body writes nothing", async (body) => {
    const { env, events } = await harness();
    const request = new Request("https://example.com/api/event", { method: "POST", body });
    expect((await worker.fetch(request, env)).status).toBe(400);
    expect(events()).toEqual([]);
  });

  test("a chunked oversized body is refused before parsing", async () => {
    const { env, events } = await harness();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
      controller.enqueue(new TextEncoder().encode(JSON.stringify(valid)));
      controller.close();
    } });
    expect((await worker.fetch(new Request("https://example.com/api/event", { method: "POST", body }), env)).status).toBe(400);
    expect(events()).toEqual([]);
  });

  test.each([undefined, "unknown", "192.0.2.1", { value: "UA" }])("country is only a Cloudflare country code", async (country) => {
    const { env, events } = await harness();
    const request = eventRequest(valid);
    // A fresh request also covers absent cf metadata.
    const input = new Request(request);
    if (country !== undefined) Object.defineProperty(input, "cf", { value: { country } });
    expect((await worker.fetch(input, env)).status).toBe(204);
    expect(events()[0]).toMatchObject({ country: "" });
  });

  test.each(["/", "/demo/", "/main.js", "/missing", "/api"])("%s is delegated unchanged to static assets", async (pathname) => {
    const { env, assets, events } = await harness();
    const request = new Request(`https://example.com${pathname}`);
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static asset");
    expect(assets).toEqual([request]);
    expect(events()).toEqual([]);
  });

  test("unknown API paths and wrong methods cannot write or fall through to assets", async () => {
    const { env, events, assets } = await harness();
    expect((await worker.fetch(new Request("https://example.com/api/unknown", { method: "POST" }), env)).status).toBe(404);
    const response = await worker.fetch(new Request("https://example.com/api/event"), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(events()).toEqual([]);
    expect(assets).toEqual([]);
  });

  test("a failed binding write cannot acknowledge success", async () => {
    const { env, client } = await harness();
    client.recordEvent = async () => { throw new Error("binding unavailable"); };
    await expect(worker.fetch(eventRequest(valid), env)).rejects.toThrow("binding unavailable");
  });
});

const ping = { id: fixtureInstallId(1), v: "1.8.0", os: "linux", arch: "x64", kind: "checkout" };
function pingRequest(body: unknown) {
  const r = new Request("https://example.com/api/ping", { method: "POST", body: JSON.stringify(body), headers: { "CF-Connecting-IP": "192.0.2.1", Cookie: "ignored=yes" } });
  Object.defineProperty(r, "cf", { value: { country: "UA" } }); return r;
}
describe("anonymous install ping", () => {
  for (const kind of ["checkout", "packaged", "docker"]) test(`strict ${kind} point with country and no IP`, async () => {
    const { env, pings } = await harness();
    expect((await worker.fetch(pingRequest({ ...ping, kind }), env)).status).toBe(204);
    expect(pings()).toEqual([{ day: utcDay(fixed), ...ping, kind, country: "UA", last_at: fixed }]);
  });
  const bad = [null, [], {}, ...Object.keys(ping).map(k => Object.fromEntries(Object.entries(ping).filter(([key]) => key !== k))),
    ...["ip", "country", "host", "project", "account", "engine", "path"].map(k => ({ ...ping, [k]: "extra" })),
    ...["bad", ping.id.replace("-4000-", "-0000-"), 123].map(id => ({ ...ping, id })),
    ...["1.2", "01.2.3", "1.2.3-01", "v1.2.3", 1].map(v => ({ ...ping, v })),
    { ...ping, os: "hostname" }, { ...ping, arch: "unknown" }, { ...ping, kind: "dev" }];
  test.each(bad.map((b, i) => [i, b] as const))("invalid ping %i writes nothing", async (_, b) => {
    const { env, pings } = await harness(); expect((await worker.fetch(pingRequest(b), env)).status).toBe(400); expect(pings()).toHaveLength(0);
  });
  test("512 byte limit, including streamed bodies", async () => {
    for (const size of [512, 513]) {
      const { env, pings } = await harness();
      const json = JSON.stringify(ping); const bytes = new TextEncoder().encode(json + " ".repeat(size - json.length));
      const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 100)); c.enqueue(bytes.slice(100)); c.close(); } });
      expect((await worker.fetch(new Request("https://example.com/api/ping", { method: "POST", body }), env)).status).toBe(size === 512 ? 204 : 400);
      expect(pings()).toHaveLength(size === 512 ? 1 : 0);
    }
  });
  test.each(["{broken", new Uint8Array([255])])("malformed ping writes nothing", async body => {
    const { env, pings, client } = await harness(); expect((await worker.fetch(new Request("https://example.com/api/ping", { method: "POST", body }), env)).status).toBe(400); expect(pings()).toHaveLength(0);
  });
  test("wrong method and failed binding", async () => {
    const { env, pings, client } = await harness(); expect((await worker.fetch(new Request("https://example.com/api/ping"), env)).status).toBe(405);
    expect(pings()).toHaveLength(0); client.recordPing = async () => { throw new Error("unavailable"); };
    await expect(worker.fetch(pingRequest(ping), env)).rejects.toThrow("unavailable");
  });
});

type Harness = Awaited<ReturnType<typeof harness>>;
const target = process.env.STATS_TEST_BASE_WORKER
  ? (await import(process.env.STATS_TEST_BASE_WORKER)).default as typeof worker : worker;
const capturedLogs = () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(method => spyOn(console, method).mockImplementation(() => {}));
  cleanups.push(() => { for (const spy of spies) spy.mockRestore(); });
  return () => spies.flatMap(spy => spy.mock.calls);
};

function request(path: string, init: RequestInit = {}) {
  return new Request(new URL(path, origin), init);
}
function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return request(path, {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
  });
}
function form(path: string, cookie: string, fields: Record<string, string> = {}) {
  return request(path, { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams(fields) });
}

function assertPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
}

async function refused(h: Harness, input: Request, status: number) {
  const logs = capturedLogs();
  const before = h.counts();
  const response = await target.fetch(input, h.env);
  expect(response.status).toBe(status);
  assertPrivate(response);
  expect(response.headers.get("set-cookie")).toBeNull();
  const html = await response.text();
  expect(html).not.toMatch(/Installation stats|Active installs|Newest ping|Swarm rule usage/);
  expect(h.counts()).toEqual(before);
  expect(logs()).toEqual([]);
  return { response, html };
}

async function options(h: Harness, path: "/stats/enroll/options" | "/stats/login/options", token = testToken) {
  const response = await worker.fetch(post(path, path.includes("/enroll/") ? { token } : undefined), h.env);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ challenge: string; user: { id: string }; [key: string]: unknown }>;
}

async function registration(h: Harness, token = testToken, keyOptions?: { id?: number; rsa?: number }) {
  const device = await authenticator(origin, rp, keyOptions?.id, keyOptions?.rsa);
  const creation = await options(h, "/stats/enroll/options", token);
  return { device, creation, proof: await device.registration(creation, token) };
}

function issued(response: Response) {
  expect(response.status).toBe(204);
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^__Host-dlg_stats=[\w-]{43}; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Strict$/);
  return setCookie.split(";")[0];
}

async function enrolled(h: Harness, token = testToken, keyOptions?: { id?: number; rsa?: number }) {
  const setup = await registration(h, token, keyOptions);
  const cookie = issued(await worker.fetch(post("/stats/enroll/finish", setup.proof), h.env));
  return { ...setup, cookie };
}

async function assertion(h: Harness, device: Awaited<ReturnType<typeof authenticator>>, changes?: Parameters<typeof device.assertion>[1]) {
  return device.assertion(await options(h, "/stats/login/options"), changes);
}

async function htmlExport(name: string, response: Response) {
  if (!process.env.STATS_RENDER_DIR) return;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(process.env.STATS_RENDER_DIR, { recursive: true });
  await Bun.write(`${process.env.STATS_RENDER_DIR}/${name}.html`, await response.text());
}

describe("stats auth refusal", () => {
  for (const path of ["/stats", "/stats/"]) test(`missing cookie on ${path}`, async () => {
    const h = await harness();
    const { html } = await refused(h, request(path), 401);
    expect(html).toContain("Sign in to stats");
    expect(h.storeCalls).toBe(0);
    expect(h.snapshotCalls).toBe(0);
  });

  for (const [name, cookie] of [
    ["malformed", "__Host-dlg_stats=invalid"],
    ["duplicated", `${forgedCookie}; ${forgedCookie}`],
    ["wrong name", forgedCookie.replace("__Host-dlg_stats", "other")],
  ]) test(`${name} cookie reaches no store`, async () => {
    const h = await harness();
    await refused(h, request("/stats", { headers: { Cookie: cookie } }), 401);
    expect(h.storeCalls).toBe(0);
  });

  for (const path of ["/stats", "/stats/session"]) test(`forged session on ${path}`, async () => {
    const h = await harness();
    await refused(h, request(path, { headers: { Cookie: forgedCookie } }), 401);
    expect(h.storeCalls).toBe(1);
  });

  test("session expires at 90 days", async () => {
    const h = await harness();
    const { cookie } = await enrolled(h);
    for (const days of [30, 89]) {
      setSystemTime(fixed + days * DAY);
      await h.restart();
      expect((await worker.fetch(request("/stats", { headers: { Cookie: cookie } }), h.env)).status).toBe(200);
    }
    setSystemTime(fixed + 90 * DAY);
    await refused(h, request("/stats", { headers: { Cookie: cookie } }), 401);
  });

  for (const path of ["/stats/logout", "/stats/sessions/revoke", "/stats/passkeys/remove"]) {
    test(`session revoked by ${path}`, async () => {
      const h = await harness();
      const { cookie, device } = await enrolled(h);
      const other = issued(await worker.fetch(post("/stats/login/finish", await assertion(h, device)), h.env));
      const removed = await worker.fetch(form(path, cookie, path.endsWith("/remove") ? { id: device.id } : {}), h.env);
      expect(removed.status).toBe(303);
      expect(removed.headers.get("location")).toBe("/stats");
      expect(removed.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await worker.fetch(request("/stats/session", { headers: { Cookie: other } }), h.env)).status)
        .toBe(path.endsWith("/logout") ? 204 : 401);
      await refused(h, request("/stats", { headers: { Cookie: cookie } }), 401);
    });
  }

  for (const name of ["no token", "wrong token", "expired secret", "unset secret", "malformed secret"]) {
    for (const step of ["options", "finish"]) test(`enrollment ${step}: ${name}`, async () => {
      const h = await harness();
      const { proof } = await registration(h);
      let token: string | undefined = testToken;
      if (name === "no token") token = undefined;
      if (name === "wrong token") token = secondToken;
      if (name === "expired secret") setSystemTime(fixed + DAY);
      if (name === "unset secret") delete h.env.STATS_ENROLLMENT;
      if (name === "malformed secret") h.env.STATS_ENROLLMENT = "malformed fixture";
      await refused(h, post(`/stats/enroll/${step}`, step === "options" ? { token } : { ...proof, token }), 403);
    });
  }

  for (const step of ["options", "finish"]) test(`used enrollment link refused at ${step}`, async () => {
    const h = await harness();
    const { proof } = await enrolled(h);
    await refused(h, post(`/stats/enroll/${step}`, step === "options" ? { token: testToken } : proof), 403);
  });

  test("two concurrent enrollment finishes issue exactly one cookie", async () => {
    const h = await harness();
    const logs = capturedLogs();
    const { proof } = await registration(h);
    const responses = await Promise.all([0, 1].map(() => target.fetch(post("/stats/enroll/finish", proof), h.env)));
    expect(responses.map(r => r.status).sort()).toEqual([204, 403]);
    issued(responses.find(r => r.status === 204)!);
    const rejected = responses.find(r => r.status === 403)!;
    expect(await rejected.text()).toBe("");
    expect(rejected.headers.get("set-cookie")).toBeNull();
    expect(h.counts().slice(0, 4)).toEqual(Array.from({ length: 4 }, () => ({ n: 1 })));
    expect(logs()).toEqual([]);
  });

  const badEnrollment = [
    "wrong type", "foreign origin", "crossOrigin", "bad HMAC", "expired challenge", "other enrollment",
    "login challenge", "wrong RP ID", "UP missing", "UV missing", "algorithm -8", "unparsable key",
    "short RSA", "registered credential", "oversized body",
  ];
  for (const name of badEnrollment) test(`enrollment proof: ${name}`, async () => {
    const h = await harness();
    let token = testToken;
    if (name === "registered credential") {
      await enrolled(h);
      token = secondToken;
      h.env.STATS_ENROLLMENT = await enrollmentSecret(token, fixed);
    }
    const { device, creation } = await registration(h, token, name === "short RSA" ? { rsa: 1024 } : undefined);
    const client: Record<string, unknown> = {};
    const changes: { client: typeof client; rpId?: string; flags?: number } = { client };
    if (name === "wrong type") client.type = "webauthn.get";
    if (name === "foreign origin") client.origin = "https://foreign.example";
    if (name === "crossOrigin") client.crossOrigin = true;
    if (name === "bad HMAC") {
      const challenge = Buffer.from(creation.challenge, "base64url");
      challenge[55] ^= 1;
      client.challenge = challenge.toString("base64url");
    }
    if (name === "expired challenge") setSystemTime(fixed + 300_000);
    if (name === "other enrollment") {
      token = secondToken;
      h.env.STATS_ENROLLMENT = await enrollmentSecret(token, fixed);
    }
    if (name === "login challenge") client.challenge = (await options(h, "/stats/login/options")).challenge;
    if (name === "wrong RP ID") changes.rpId = "foreign.example";
    if (name === "UP missing") changes.flags = 4;
    if (name === "UV missing") changes.flags = 1;
    const proof = await device.registration(creation, token, changes);
    if (name === "algorithm -8") proof.alg = -8;
    if (name === "unparsable key") proof.publicKey = "AA";
    await refused(h, post("/stats/enroll/finish", name === "oversized body" ? { ...proof, extra: "x".repeat(8192) } : proof), 403);
  });

  const badLogin = [
    "unknown credential", "revoked credential", "another signature", "tampered client data", "tampered authenticator data",
    "wrong type", "foreign origin", "crossOrigin", "expired challenge", "forged challenge", "UP missing", "UV missing",
    "wrong RP ID", "counter did not grow", "wrong user handle", "bad DER", "oversized body",
  ];
  for (const name of badLogin) test(`sign-in proof: ${name}`, async () => {
    const h = await harness();
    const { device, cookie } = await enrolled(h);
    if (name === "revoked credential") {
      expect((await worker.fetch(form("/stats/passkeys/remove", cookie, { id: device.id }), h.env)).status).toBe(303);
    }
    if (name === "counter did not grow") {
      issued(await worker.fetch(post("/stats/login/finish", await assertion(h, device, { count: 2 })), h.env));
    }
    const challenge = await options(h, "/stats/login/options");
    const client: Record<string, unknown> = {};
    const changes: { client: typeof client; flags?: number; count?: number; rpId?: string } = { client };
    if (name === "wrong type") client.type = "webauthn.create";
    if (name === "foreign origin") client.origin = "https://foreign.example";
    if (name === "crossOrigin") client.crossOrigin = true;
    if (name === "expired challenge") setSystemTime(fixed + 120_000);
    if (name === "forged challenge") {
      const data = Buffer.from(challenge.challenge, "base64url");
      data[24] ^= 1;
      client.challenge = data.toString("base64url");
    }
    if (name === "UP missing") changes.flags = 4;
    if (name === "UV missing") changes.flags = 1;
    if (name === "wrong RP ID") changes.rpId = "foreign.example";
    if (name === "counter did not grow") changes.count = 2;
    const proof = await device.assertion(challenge, changes);
    if (name === "unknown credential") proof.id = (await authenticator(origin, rp, 2)).id;
    if (name === "another signature") proof.signature = (await (await authenticator(origin, rp, 2)).assertion(challenge)).signature;
    if (name === "tampered client data") proof.clientDataJSON = Buffer.from(
      Buffer.from(proof.clientDataJSON, "base64url").toString() + " ",
    ).toString("base64url");
    if (name === "tampered authenticator data") {
      const data = Buffer.from(proof.authenticatorData, "base64url");
      data[36] ^= 1;
      proof.authenticatorData = data.toString("base64url");
    }
    if (name === "wrong user handle") proof.userHandle = secondToken;
    if (name === "bad DER") proof.signature = Buffer.from([48, 7, 2, 2, 0, 1, 2, 1, 2]).toString("base64url");
    await refused(h, post("/stats/login/finish", name === "oversized body" ? { ...proof, extra: "x".repeat(8192) } : proof), 401);
  });

  test("assertion replay after reopening the store is refused", async () => {
    const h = await harness();
    const { device } = await enrolled(h);
    const proof = await assertion(h, device);
    issued(await worker.fetch(post("/stats/login/finish", proof), h.env));
    await h.restart();
    await refused(h, post("/stats/login/finish", proof), 401);
  });

  test("two concurrent assertion finishes issue exactly one cookie", async () => {
    const h = await harness();
    const { device } = await enrolled(h);
    const proof = await assertion(h, device);
    const logs = capturedLogs();
    const responses = await Promise.all([0, 1].map(() => target.fetch(post("/stats/login/finish", proof), h.env)));
    expect(responses.map(r => r.status).sort()).toEqual([204, 401]);
    issued(responses.find(r => r.status === 204)!);
    const rejected = responses.find(r => r.status === 401)!;
    expect(await rejected.text()).toBe("");
    expect(rejected.headers.get("set-cookie")).toBeNull();
    expect(h.counts().slice(0, 4)).toEqual([{ n: 1 }, { n: 2 }, { n: 1 }, { n: 2 }]);
    expect(logs()).toEqual([]);
  });

  const posts = ["/stats/enroll/options", "/stats/enroll/finish", "/stats/login/options", "/stats/login/finish",
    "/stats/logout", "/stats/sessions/revoke", "/stats/passkeys/remove"];
  for (const path of posts) {
    test(`missing Origin on ${path}`, async () => {
      const h = await harness();
      await refused(h, request(path, { method: "POST" }), 403);
      expect(h.storeCalls).toBe(0);
    });
    test(`foreign Origin on ${path}`, async () => {
      const h = await harness();
      await refused(h, post(path, undefined, { Origin: "https://foreign.example" }), 403);
      expect(h.storeCalls).toBe(0);
    });
  }

  for (const path of ["/stats/enroll/options", "/stats/enroll/finish", "/stats/login/finish"]) {
    test(`wrong content type on ${path}`, async () => {
      await refused(await harness(), post(path, {}, { "Content-Type": "text/plain" }), 415);
    });
  }

  test("sign-in options refuse a nonempty body", async () => {
    await refused(await harness(), post("/stats/login/options", {}), 401);
  });

  test("wrong method advertises the allowed method", async () => {
    const h = await harness();
    const { response } = await refused(h, request("/stats/login/finish"), 405);
    expect(response.headers.get("allow")).toBe("POST");
  });
  test("unknown stats path never falls back to assets", async () => {
    const h = await harness();
    await refused(h, request("/stats/unknown"), 404);
    expect(h.assets).toHaveLength(0);
  });
  test("www redirects GET and refuses POST", async () => {
    const h = await harness();
    await refused(h, post("https://www.stats.example/stats/login/options"), 403);
    const { response } = await refused(h, request("https://www.stats.example/stats/enroll?from=link"), 308);
    expect(response.headers.get("location")).toBe(origin + "/stats/enroll?from=link");
    expect(h.storeCalls).toBe(0);
  });
});

describe("stats Worker and store", () => {
  test("options make no writes and issue discoverable, user-verified requests", async () => {
    const h = await harness();
    const before = h.counts();
    const creation = await options(h, "/stats/enroll/options");
    expect(creation).toMatchObject({
      rp: { id: rp }, attestation: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    });
    expect(await options(h, "/stats/login/options")).toMatchObject({ rpId: rp, userVerification: "required" });
    const empty = await worker.fetch(request("/stats/login/options", {
      method: "POST", headers: { Origin: origin }, body: "",
    }), h.env);
    expect(empty.status).toBe(200);
    expect(h.counts()).toEqual(before);
  });

  test("RS256 passkey, exact cookie attributes, and hashed session storage", async () => {
    const h = await harness();
    const { device } = await enrolled(h, testToken, { rsa: 2048 });
    const cookie = issued(await worker.fetch(post("/stats/login/finish", await assertion(h, device, { count: 1 })), h.env));
    expect(await h.client.session(cookie.split("=")[1])).toBe(true);
    const hashes = h.db.query("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
    expect(hashes).toHaveLength(2);
    for (const row of hashes) expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(hashes)).not.toContain(cookie.split("=")[1]);
  });

  test("a revoked passkey's sessions are removed without signing out the other passkey", async () => {
    const h = await harness();
    const removed = await enrolled(h);
    h.env.STATS_ENROLLMENT = await enrollmentSecret(secondToken, fixed);
    const current = await enrolled(h, secondToken, { id: 2 });
    const response = await worker.fetch(form("/stats/passkeys/remove", current.cookie, { id: removed.device.id }), h.env);
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await h.client.session(current.cookie.split("=")[1])).toBe(true);
    expect(await h.client.session(removed.cookie.split("=")[1])).toBe(false);
  });

  test("stats identifies the passkey that owns the current session", async () => {
    const h = await harness();
    await enrolled(h);
    h.env.STATS_ENROLLMENT = await enrollmentSecret(secondToken, fixed);
    const current = await enrolled(h, secondToken, { id: 2 });

    const response = await target.fetch(request("/stats", { headers: { Cookie: current.cookie } }), h.env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.match(/This device · Added 2026-10-11 12:30 UTC/g)).toHaveLength(1);
    const visibleRows = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([row]) =>
      row.replace(/<form[^>]*>[\s\S]*?<\/form>/g, "").replace(/\s+/g, " ").trim());
    expect(visibleRows).toHaveLength(2);
    expect(new Set(visibleRows).size).toBe(2);
  });

  test("pings update the newest fields and events accumulate by day and dimensions", async () => {
    const h = await harness();
    expect((await worker.fetch(pingRequest(ping), h.env)).status).toBe(204);
    setSystemTime(fixed + 10_000);
    expect((await worker.fetch(pingRequest({ ...ping, v: "1.9.0" }), h.env)).status).toBe(204);
    await h.client.recordPing(ping as Parameters<typeof h.client.recordPing>[0], "US", fixed + 1000);
    expect(h.pings()).toEqual([{ day: utcDay(fixed), ...ping, v: "1.9.0", country: "UA", last_at: fixed + 10_000 }]);
    for (const country of ["UA", "UA", "US"]) {
      expect((await worker.fetch(eventRequest({ event: "demo_start", lang: "uk" }, country), h.env)).status).toBe(204);
    }
    expect(h.events()).toEqual(["UA", "US"].map((country, index) => ({
      day: utcDay(fixed), event: "demo_start", agent: "", lang: "uk", country, total: 2 - index,
    })));
  });

  test("snapshot preserves distinct counts, first-seen dates, dimensions, totals and per-section failures", async () => {
    const h = await harness();
    const { cookie } = await enrolled(h);
    const response = () => worker.fetch(request("/stats", { headers: { Cookie: cookie } }), h.env);
    await htmlExport("empty", await response());
    const install = { ...ping, kind: "checkout" } as const;
    await h.client.recordPing(install, "UA", fixed - 92 * DAY);
    await h.client.recordPing(install, "UA", fixed - 6 * DAY);
    await h.client.recordPing({ ...install, v: "2.0.0" }, "UA", fixed);
    await h.client.recordPing({ ...install, os: "darwin", arch: "arm64", kind: "packaged",
      id: fixtureInstallId(2) }, "", fixed - 29 * DAY);
    await h.client.recordPing({ ...install, id: fixtureInstallId(3) }, "", fixed + DAY);
    await h.client.recordEvent({ event: "demo_start", lang: "en" }, "", fixed);
    await h.client.recordEvent({ event: "demo_start", lang: "uk" }, "UA", fixed);
    h.db.query("INSERT INTO swarm_usage_days VALUES (?, ?, ?, ?, ?, ?, ?)").run(utcDay(fixed), "<rule>", 4, 10, 3, 1, 1);
    h.db.query("INSERT INTO swarm_usage_days VALUES (?, ?, ?, ?, ?, ?, ?)").run(utcDay(fixed - DAY), "<rule>", 1, 2, 0, 0, 0);
    const snapshot = (await h.client.snapshot(cookie.split("=")[1]))!;
    expect(snapshot.results.map(section => section.rows)).toEqual([
      [{ total: 1 }], [{ total: 1 }], [{ total: 2 }],
      [29, 6, 0].map(offset => ({ day: utcDay(fixed - offset * DAY), total: 1 })),
      [{ day: utcDay(fixed - 29 * DAY), total: 1 }],
      ["1.8.0", "2.0.0"].map(label => ({ label, total: label === "1.8.0" ? 2 : 1 })),
      [{ os: "darwin", arch: "arm64", total: 1 }, { os: "linux", arch: "x64", total: 1 }],
      [{ label: "checkout", total: 1 }, { label: "packaged", total: 1 }],
      [{ day: utcDay(fixed), event: "demo_start", total: 2 }],
      [{ newest: "2026-10-11 12:30:00" }],
      [{ rule: "<rule>", reports: 5, delivered: 12, applied: 3, misled: 1, misled_reports: 1 }],
    ]);
    const page = await response();
    expect(page.status).toBe(200);
    assertPrivate(page);
    const html = await page.text();
    for (const section of ["Today", "Last 7 days", "Last 30 days", "Daily active installs", "New installs per day",
      "Version", "OS / architecture", "Install kind", "Landing actions per day", "Newest ping", "Swarm rule usage", "Access"]) {
      expect(html).toContain(section);
    }
    expect(html).toContain("&lt;rule&gt;");
    expect(html).toContain("25.0%");
    expect(html).not.toContain("<rule>");
    expect(html).not.toContain(cookie);
    expect(html).not.toContain(install.id);
    await htmlExport("import-unavailable", await response());
    h.env.STATS_ACCOUNT_ID = "a".repeat(32);
    h.env.STATS_AE_TOKEN = "fixture credential";
    await htmlExport("import-pending", await response());
    h.db.run("INSERT INTO meta (key, value) VALUES ('import_error', 'network')");
    await htmlExport("import-stopped", await response());
    h.db.run("INSERT INTO meta (key, value) VALUES ('import_done', '1')");
    await htmlExport("import-complete", await response());
    h.failSection("GROUP BY v");
    const failed = await response();
    expect(failed.status).toBe(200);
    const partial = await failed.clone().text();
    expect(partial).toContain("Data unavailable");
    expect(partial).toContain("darwin / arm64");
    await htmlExport("unavailable-section", failed);
  });

  test("exports the sign-in and enrollment pages", async () => {
    const h = await harness();
    for (const [name, path, status] of [["sign-in", "/stats", 401], ["enroll", "/stats/enroll", 200]] as const) {
      const response = await worker.fetch(request(path), h.env);
      expect(response.status).toBe(status);
      assertPrivate(response);
      expect(response.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[\w-]{22}'/);
      await htmlExport(name, response);
    }
  });

  test("retention removes old metric days, expired/revoked sessions, expired nonces and long-revoked passkeys", async () => {
    const h = await harness();
    await enrolled(h);
    const old = fixed - 93 * DAY;
    const edge = fixed - 92 * DAY;
    for (const at of [old, edge]) {
      const day = utcDay(at);
      await h.client.recordPing({ ...ping, kind: "checkout" }, "", at);
      await h.client.recordEvent({ event: "demo_start", lang: "en" }, "", at);
      h.db.query("INSERT INTO swarm_usage_days VALUES (?, 'fixture', 1, 1, 1, 0, 0)").run(day);
    }
    h.db.query("UPDATE sessions SET expires_at = ?").run(fixed);
    h.db.query("UPDATE credentials SET revoked_at = ?").run(old);
    h.db.query("INSERT INTO used_challenges VALUES ('expired', ?)").run(fixed);
    await h.tick();
    expect(h.pings().map(row => (row as { day: string }).day)).toEqual([utcDay(edge)]);
    expect(h.events()).toHaveLength(1);
    expect(h.counts().slice(0, 7)).toEqual([0, 0, 1, 1, 1, 1, 1].map(n => ({ n })));
    expect(h.alarm).toBe(Date.parse("2026-10-12T03:00:00Z"));
  });
});

const historyEnv = { STATS_ACCOUNT_ID: "a".repeat(32), STATS_AE_TOKEN: "fixture history credential" };

function stubHistory(serve: (sql: string) => Response) {
  const stub = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).toMatch(/^https:\/\/api.cloudflare.com\/client\/v4\/accounts\/[a-f0-9]{32}\/analytics_engine\/sql$/);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${historyEnv.STATS_AE_TOKEN}`);
    expect(init?.redirect).toBe("manual");
    return serve(String(init?.body));
  };
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(stub, { preconnect: fetch.preconnect }));
  cleanups.push(() => mock.mockRestore());
  return mock;
}

describe("stats history import", () => {
  test("checkpoints old days, waits out cutover, and merges the final day once", async () => {
    const h = await harness(historyEnv);
    const logs = capturedLogs();
    const day = utcDay(fixed);
    const event = { event: "demo_start", lang: "en" } as const;
    await h.client.recordPing({ ...ping, kind: "checkout" }, "UA", fixed);
    await h.client.recordEvent(event, "UA", fixed);
    const outbound = stubHistory(sql => {
      if (!sql.includes(day + " 00:00:00")) return Response.json({ data: [], rows: 0 });
      return sql.includes("FROM installs")
        ? Response.json({ data: [
          { ...ping, v: "1.0.0", at: day + " 11:00:00", country: "CA" },
          { ...ping, id: "invalid", at: day + " 11:00:00", country: "CA" },
        ], rows: 2 })
        : Response.json({ data: [{ ...event, agent: "", country: "UA", total: 4 }], rows: 1 });
    });
    expect(h.alarm).toBe(fixed + 1000);
    for (let d = 0; d < 92; d++) await h.tick();
    await h.restart();
    await h.tick();
    expect(outbound.mock.calls).toHaveLength(184);
    expect(h.alarm).toBe(fixed + 600_000);
    setSystemTime(fixed + 600_000);
    await h.tick();
    await h.restart();
    await h.tick();
    expect(outbound.mock.calls).toHaveLength(186);
    expect(h.pings()).toEqual([{ day, ...ping, country: "UA", last_at: fixed }]);
    expect(h.events()).toEqual([{ day, ...event, agent: "", country: "UA", total: 5 }]);
    expect(h.db.query("SELECT value FROM meta WHERE key = 'import_skipped'").get()).toEqual({ value: "1" });
    expect(h.db.query("SELECT count(*) AS n FROM imported_days").get()).toEqual({ n: 93 });
    expect(logs().at(-1)).toEqual(["stats-import complete days=93"]);
  });

  const failureCases = [
    ["HTTP error", "http"], ["redirect", "http"], ["bad JSON", "shape"], ["invalid shape", "shape"],
    ["install limit", "limit"], ["event limit", "limit"], ["network", "network"],
  ];
  for (const [name, error] of failureCases) test(`${name} stops after three attempts and only a new version resumes`, async () => {
    const h = await harness(historyEnv);
    const logs = capturedLogs();
    const outbound = stubHistory(sql => {
      if (name === "HTTP error") return new Response("upstream private", { status: 401 });
      if (name === "redirect") return new Response(null, { status: 307, headers: { Location: "https://foreign.example/" } });
      if (name === "bad JSON") return new Response("not json");
      if (name === "invalid shape") return Response.json({ data: [{ invalid: { nested: true } }] });
      if (name === "network") throw new Error("upstream private");
      const installs = sql.includes("FROM installs");
      return Response.json({ data: Array.from({ length: installs ? (name === "install limit" ? 10_000 : 0)
        : (name === "event limit" ? 1000 : 0) }, () => ({})) });
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.tick();
      await h.restart();
    }
    await h.tick();
    expect(outbound.mock.calls).toHaveLength(6);
    expect(h.db.query("SELECT count(*) AS n FROM imported_days").get()).toEqual({ n: 0 });
    expect(logs()).toEqual([[`stats-import stopped ${error}`]]);
    const { cookie } = await enrolled(h);
    const html = await (await worker.fetch(request("/stats", { headers: { Cookie: cookie } }), h.env)).text();
    expect(html).toContain(`History import stopped (${error}).`);
    expect(html).not.toContain("upstream private");
    expect(html).not.toContain(historyEnv.STATS_AE_TOKEN);
    h.env.STATS_VERSION = { id: "fixture-2" };
    await h.restart();
    expect(h.alarm).toBe(fixed + 1000);
    await h.tick();
    expect(outbound.mock.calls).toHaveLength(8);
  });

  test("no bound token makes no outbound request", async () => {
    const h = await harness({ STATS_ACCOUNT_ID: historyEnv.STATS_ACCOUNT_ID });
    const logs = capturedLogs();
    const outbound = stubHistory(() => Response.json({ data: [] }));
    await h.tick();
    expect(outbound.mock.calls).toEqual([]);
    expect(logs()).toEqual([]);
  });

  test("Wrangler worker-first routes do not overlap a broader wildcard", async () => {
    const cfg = await Bun.file(new URL("./wrangler.jsonc", import.meta.url)).json();
    const routes: string[] = cfg.assets.run_worker_first;
    const redundant = routes.filter(route => routes.some(rule =>
      rule !== route && rule.endsWith("/*") && route.startsWith(rule.slice(0, -1))));
    expect(redundant).toEqual([]);
  });

  test("Wrangler config creates the SQLite object and declares no Access vars or analytics datasets", async () => {
    const cfg = await Bun.file(new URL("./wrangler.jsonc", import.meta.url)).json();
    expect(cfg.main).toBe("entry.ts");
    expect(cfg.assets.run_worker_first).toEqual(["/api/*", "/stats", "/stats/*"]);
    expect(cfg.vars).toEqual({ STATS_ORIGIN: "https://delegatus.org", STATS_RP_ID: "delegatus.org" });
    expect(cfg.durable_objects.bindings).toEqual([{ name: "STATS", class_name: "StatsStore" }]);
    expect(cfg.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["StatsStore"] }]);
    expect(cfg.version_metadata).toEqual({ binding: "STATS_VERSION" });
    expect(cfg.analytics_engine_datasets).toBeUndefined();
    expect(cfg.exports).toBeUndefined();
  });
});
