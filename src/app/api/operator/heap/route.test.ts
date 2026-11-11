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
const cacheEntries = () => fs.existsSync(path.join(root, "cache")) ? fs.readdirSync(path.join(root, "cache"), { recursive: true }) : [];

test("a caller without operator proof, an agent, a Viewer service and a foreign origin are all refused in both modes", async () => {
  for (const query of ["", "?mode=snapshot"]) {
    expect((await read(query)).status).toBe(403);
    expect((await read(query, internalServiceHeaders("mcp"))).status).toBe(403);
    expect((await read(query, { ...operator, ...internalServiceHeaders("mcp") })).status).toBe(403);
    expect((await read(query, { ...operator, origin: "https://elsewhere.invalid" })).status).toBe(403);
    expect((await read(query, { ...operator, "sec-fetch-site": "cross-site" })).status).toBe(403);
    setCallerConversationResolverForTests(() => "conversation_heap-fixture");
    expect((await read(query, { ...operator, "x-llv-spawn-capability": "a".repeat(43) })).status).toBe(403);
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
