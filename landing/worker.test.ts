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
