import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { GET } from "./route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-route-"));
const previous = { state: process.env.LLV_STATE_DIR, operator: process.env.DELEGATUS_OPERATOR_TOKEN, cache: process.env.XDG_CACHE_HOME };
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
// Composed fixture proof, held in-process and absent from published text.
const proof = ["operator", "fixture", "proof"].join("-");
process.env.DELEGATUS_OPERATOR_TOKEN = proof;
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
afterAll(() => {
  setCallerConversationResolverForTests(null);
  restore("LLV_STATE_DIR", previous.state);
  restore("DELEGATUS_OPERATOR_TOKEN", previous.operator);
  restore("XDG_CACHE_HOME", previous.cache);
  fs.rmSync(root, { recursive: true, force: true });
});
const read = (query = "", headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost/api/operator/heap${query}`, { headers: { host: "localhost", ...headers } }));
const operator = { "x-llv-operator-token": proof };
const write = { "x-delegatus-heap-snapshot": "write" };
const cacheEntries = () => fs.existsSync(path.join(root, "cache")) ? fs.readdirSync(path.join(root, "cache"), { recursive: true }) : [];

test("a caller without operator proof, an agent, a Viewer service and a foreign origin are all refused in both modes", async () => {
  for (const query of ["", "?mode=snapshot"]) {
    expect((await read(query, write)).status).toBe(403);
    expect((await read(query, { ...write, ...internalServiceHeaders("mcp") })).status).toBe(403);
    expect((await read(query, { ...write, ...operator, ...internalServiceHeaders("mcp") })).status).toBe(403);
    expect((await read(query, { ...write, ...operator, origin: "https://elsewhere.invalid" })).status).toBe(403);
    expect((await read(query, { ...write, ...operator, "sec-fetch-site": "cross-site" })).status).toBe(403);
    setCallerConversationResolverForTests(() => "conversation_heap-fixture");
    expect((await read(query, { ...write, ...operator, "x-llv-spawn-capability": "a".repeat(43) })).status).toBe(403);
    setCallerConversationResolverForTests(null);
  }
  expect(cacheEntries()).toEqual([]);
});

test("the operator's default read is the cheap census: counts in the answer, no file written", async () => {
  const response = await read("", operator);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.mode).toBe("stats");
  expect(body.heap.objectCount).toBeGreaterThan(0);
  expect(body.memoryUsage.rss).toBeGreaterThan(0);
  expect(Object.keys(body.objectTypeCounts).length).toBeGreaterThan(0);
  expect(typeof body.protectedObjectTypeCounts).toBe("object");
  expect(cacheEntries()).toEqual([]);
});

test("an unknown mode is rejected without touching the heap", async () => {
  expect((await read("?mode=dump", operator)).status).toBe(400);
});

test("a snapshot request a link or an address bar can make is refused before any work", async () => {
  const response = await read("?mode=snapshot", operator);
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("confirmation_required");
  expect((await read("?mode=snapshot", { ...operator, "x-delegatus-heap-snapshot": "1" })).status).toBe(400);
  expect(cacheEntries()).toEqual([]);
});

test("a snapshot waits out an update handoff like any other write, while the census still answers", async () => {
  const gate = path.join(root, "state", "self-update", "auto-admission.json");
  fs.mkdirSync(path.dirname(gate), { recursive: true });
  fs.writeFileSync(gate, JSON.stringify({ id: "handoff", until: Date.now() + 60_000 }));
  try {
    const held = await read("?mode=snapshot", { ...operator, ...write });
    expect(held.status).toBe(503);
    expect(held.headers.get("retry-after")).toBe("2");
    expect((await read("", operator)).status).toBe(200);
    expect(cacheEntries()).toEqual([]);
  } finally { fs.rmSync(gate, { force: true }); }
});

test("with the header the operator's snapshot reaches the guards, and a written file stays under the cache directory", async () => {
  const response = await read("?mode=snapshot", { ...operator, ...write });
  const body = await response.json();
  // The scratch volume of a test run may hold less than the disk bound.
  expect([200, 507]).toContain(response.status);
  if (response.status === 200) expect(String(body.path).startsWith(path.join(root, "cache") + path.sep)).toBe(true);
  else expect(body).toMatchObject({ written: false, refusal: "insufficient_disk" });
});
