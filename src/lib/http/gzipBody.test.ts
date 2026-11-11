import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

import { acceptsGzip, gzipBody } from "./gzipBody";

const accepts = (header?: string) => acceptsGzip(new Request("http://127.0.0.1/", header === undefined ? {} : { headers: { "accept-encoding": header } }));

test("ordinary browser headers accept gzip", () => {
  expect(accepts("gzip, deflate, br, zstd")).toBe(true);
  expect(accepts("gzip")).toBe(true);
  expect(accepts("br;q=1.0, gzip;q=0.8, *;q=0.1")).toBe(true);
  expect(accepts("*")).toBe(true);
});

test("an explicit gzip exclusion overrides the wildcard in either order", () => {
  expect(accepts("gzip;q=0, *;q=1")).toBe(false);
  expect(accepts("*;q=1, gzip;q=0")).toBe(false);
  expect(accepts("gzip;q=0")).toBe(false);
  expect(accepts("GZIP; q=0 , *")).toBe(false);
});

test("gzip named with weight wins over an excluded wildcard", () => {
  expect(accepts("gzip;q=1, *;q=0")).toBe(true);
  expect(accepts("*;q=0, gzip;q=0.5")).toBe(true);
});

test("no header, identity only, an excluded wildcard or an unreadable weight means no gzip", () => {
  expect(accepts()).toBe(false);
  expect(accepts("identity")).toBe(false);
  expect(accepts("br, *;q=0")).toBe(false);
  expect(accepts("gzip;q=abc")).toBe(false);
});

test("the compressed body round-trips", async () => {
  const body = JSON.stringify({ rows: Array.from({ length: 1000 }, (_, i) => ({ i })) });
  expect(gunzipSync(await gzipBody(body)).toString("utf8")).toBe(body);
});

test("large string and byte-view responses preserve every output chunk", async () => {
  const body = JSON.stringify({ payload: randomBytes(2 * 1024 * 1024).toString("base64") });
  const framed = Buffer.from(`prefix${body}suffix`);
  const view = new Uint8Array(framed.buffer, framed.byteOffset + 6, Buffer.byteLength(body));
  for (const input of [body, view]) {
    let yielded = false;
    const timer = setTimeout(() => { yielded = true; }, 0);
    try {
      const compressed = await gzipBody(input);
      expect(compressed.byteLength).toBeGreaterThan(1024 * 1024);
      expect(gunzipSync(compressed).toString("utf8")).toBe(body);
      expect(yielded).toBeTrue();
    } finally { clearTimeout(timer); }
  }
});
