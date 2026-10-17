import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { requestSchema } from "./protocol";
import { x1Dir } from "./toolLoop.fixture";
import { destinationRelay } from "./ownerDestination.fixture";
import { startTestRelay } from "./testRelay";
import * as index from "./toolIndex";
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(x1Dir, name + ".json"), "utf8"));

test("on-demand claims preserve spec and hydrate the service's two bounded describe pages", async () => {
  const request = requestSchema.parse(fixture("claimed_tools_on_demand_owner").request);
  expect(request.input.tools!.filter(tool => "spec" in tool)).toHaveLength(78);
  const bodies = fixture("lookup_bodies"), results = fixture("lookup_results");
  const posts: { describe: string[]; call_id: string }[] = [];
  const server = await startTestRelay((_req, body) => {
    const call = body as typeof posts[number]; posts.push(call);
    return { body: { ...results[posts.length === 1 ? "truncated" : "continuation"], call_id: call.call_id } };
  });
  const abort = new AbortController(); let acks = 0;
  try {
    const relay = { ...destinationRelay(), api_base: `${server.origin}/v1` };
    const hydrated = await index.hydrateToolIndex(relay, request, { signal: abort.signal, ack: async () => { acks++; return true; }, lose: () => abort.abort() }, {});
    expect(posts.map(call => call.describe)).toEqual([bodies.truncated.describe, bodies.continuation.describe]);
    expect(acks).toBe(2);
    expect(hydrated.request.input.tools!.filter(tool => tool.mode === "direct" && tool.parameters)).toHaveLength(78);
    expect(hydrated.request.input.tools!.every(tool => !("spec" in tool))).toBe(true);
    expect(new Set(hydrated.guidance.map(block => block.text)).size).toBe(hydrated.guidance.length);
    expect(index.describeToolIndex(hydrated.request, ["get_media"], hydrated.guidance).tools[0]!.parameters).toBeDefined();
  } finally { await server.close(); }
});


for (const scenario of ["missing", "not_permitted", "rate_limit", "malformed", "unavailable", "lease_lost", "no_progress", "revoked_ack"] as const)
  test(`on-demand hydration handles ${scenario} without widening the advertised set`, async () => {
    const request = requestSchema.parse(fixture("claimed_tools_on_demand_owner").request);
    const lookup = fixture("lookup_results");
    let posts = 0, lost = 0, acks = 0;
    const waits: number[] = [];
    const abort = new AbortController();
    const server = await startTestRelay((_req, body) => {
      posts++; const call = body as { call_id: string };
      if (scenario === "rate_limit") return { status: 429, body: { error: { code: "rate_limited" } } };
      if (scenario === "lease_lost") return { status: 409, body: { error: { code: "lease_lost" } } };
      if (scenario === "malformed") return { body: {} };
      const base = { ...lookup.describe, call_id: call.call_id };
      if (scenario === "not_permitted") return { body: { ...base, status: "denied", code: "not_permitted" } };
      if (scenario === "unavailable") return { body: { ...base, status: "denied", code: "unavailable", retry_after_s: 2 } };
      if (scenario === "no_progress") return { body: { ...base, tools: [], truncated: true } };
      return { body: { ...base, tools: [...base.tools, { ...base.tools[0], name: "not_advertised" }], truncated: false } };
    });
    try {
      const work = index.hydrateToolIndex({ ...destinationRelay(), api_base: `${server.origin}/v1` }, request,
        { signal: abort.signal, ack: async () => { acks++; if (scenario === "revoked_ack") abort.abort(); return true; }, lose: () => { lost++; abort.abort(); } },
        { sleep: async ms => { waits.push(ms); } });
      if (scenario === "lease_lost" || scenario === "revoked_ack") await expect(work).rejects.toBeDefined();
      else {
        const result = await work;
        if (scenario === "missing") {
          expect(result.request.input.tools!.filter(tool => tool.mode === "direct").map(tool => tool.name)).toEqual(["get_media"]);
          expect(result.request.input.tools!.some(tool => tool.name === "not_advertised")).toBe(false);
        } else expect(result.request).toEqual(request);
      }
      expect(posts).toBe(scenario === "revoked_ack" ? 0 : scenario === "unavailable" ? 3 : 1);
      expect(lost).toBe(scenario === "lease_lost" ? 1 : 0);
      expect(waits).toEqual(scenario === "unavailable" ? [2000, 2000] : []);
      expect(acks).toBe(posts || 1);
    } finally { await server.close(); }
  });

test("compact and describe respect audiences and truncate at whole tool boundaries", () => {
  const request = requestSchema.parse(fixture("claimed_tools_on_demand_owner").request);
  request.input.requester!.is_admin = false; request.input.requester!.is_owner = false;
  const compact = index.compactToolIndex(request);
  expect(compact.every(tool => !tool.audience)).toBe(true);
  expect(compact.every(tool => !("parameters" in tool) && !("spec" in tool))).toBe(true);
  request.input.tools = Array.from({ length: 16 }, (_, i) => ({ name: `tool_${i}`, summary: "Read", mode: "direct", effect: "read", parameters: { data: "x".repeat(8000) } }));
  const described = index.describeToolIndex(request, request.input.tools.map(tool => tool.name));
  expect(described.truncated).toBe(true);
  expect(described.tools.length).toBeGreaterThan(0);
  expect(described.tools.length).toBeLessThan(16);
  expect(Buffer.byteLength(JSON.stringify(described))).toBeLessThanOrEqual(65_536);
});
