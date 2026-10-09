import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindOwnerKey, ownerToolsFor, callOwnerApi, ownerApiView, forgetOwnerKey } from "./ownerApi";
import { setRelaySwitch } from "./switches";
import { startTestRelay } from "./testRelay";
import { requestSchema } from "./protocol";
import { sampleRequest } from "./request.fixture";
import { updateRelayStore, type PairedRelay } from "./store";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-owner-api-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const sentinel = "clst_fixture_sentinel_do_not_forward";
async function rateFixture(id: string, api: Parameters<typeof startTestRelay>[0]) {
  let origin = "";
  const server = await startTestRelay((req, body) => {
    if (req.url?.startsWith("/.well-known")) return { body: { features: ["owner_api"], owner_api: { api_base: `${origin}/api/public/v1`, openapi_url: `${origin}/api/public/v1/openapi.json`, key_url: `${origin}/key`, operations: ["read"] } } };
    if (req.url?.endsWith("openapi.json")) return { body: { paths: { "/api/public/v1/items": { get: { operationId: "read" } } } } };
    return api(req, body);
  }); origin = server.origin;
  const relay = { id, origin, api_base: `${origin}/relay/v1`, owner: { namespace: "telegram", id: "41" } } as PairedRelay;
  updateRelayStore((store) => ({ ...store, relays: [relay] })); setRelaySwitch("owner_api", true);
  const request = requestSchema.parse({ ...sampleRequest, input: { ...sampleRequest.input, requester: { key: "u", is_owner: true, is_admin: false, is_anonymous_admin: false, can_restrict_members: false, can_delete_messages: false } } });
  return { relay, request, close: async () => { forgetOwnerKey(relay.id); setRelaySwitch("owner_api", false); await server.close(); } };
}

test("long 429 delays refuse this run and peers until the full deadline", async () => {
  let time = Date.now(), limited = true;
  const arrivals: number[] = [], waits: number[] = [];
  const f = await rateFixture("long_delay", (req) => {
    if (req.url?.endsWith("/me")) return { body: { user_id: 41 } };
    arrivals.push(time);
    return limited ? { status: 429, body: { error: [{ code: "rate_limited", retry_after: 120 }] } } : { body: { status: "ok" } };
  });
  const runtime = { now: () => time, sleep: async (ms: number) => { waits.push(ms); time += ms; } };
  const signal = new AbortController().signal;
  try {
    await bindOwnerKey(f.relay, "clst_long_delay_fixture");
    const tool = (await ownerToolsFor(f.relay, f.request))[0]!;
    const start = time;
    expect(await callOwnerApi(f.relay, tool, {}, { calls: 0 }, signal, runtime)).toMatchObject({ status: "denied", code: "rate_limited", sent: true });
    expect(arrivals).toEqual([start]); expect(waits).toEqual([]);
    limited = false; time = start + 59999;
    const peerBudget = { calls: 0 };
    expect(await callOwnerApi(f.relay, tool, {}, peerBudget, signal, runtime)).toMatchObject({ status: "denied", code: "rate_limited" });
    expect(arrivals).toEqual([start]); expect(peerBudget.calls).toBe(0);
    time = start + 60000;
    expect(await callOwnerApi(f.relay, tool, {}, { calls: 0 }, signal, runtime)).toMatchObject({ status: "ok" });
    expect(waits).toEqual([60000]); expect(arrivals).toEqual([start, start + 120000]);
  } finally { await f.close(); }
});

test("binding 429 holds proxy runs and another binding for the full delay", async () => {
  let time = Date.now(), limited = false, meCalls = 0, itemCalls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  const f = await rateFixture("binding_delay", (req) => {
    if (req.url?.endsWith("/me")) {
      meCalls++;
      return limited ? { status: 429, body: { error: [{ code: "rate_limited", retry_after: 120 }] } } : { body: { user_id: 41 } };
    }
    itemCalls++; return { body: { status: "ok" } };
  });
  const key = "clst_binding_delay_fixture", signal = new AbortController().signal;
  try {
    await bindOwnerKey(f.relay, key);
    const tool = (await ownerToolsFor(f.relay, f.request))[0]!;
    limited = true;
    await expect(bindOwnerKey(f.relay, key)).rejects.toMatchObject({ code: "rate_limited" });
    const start = time; limited = false; time += 59999;
    expect(await callOwnerApi(f.relay, tool, {}, { calls: 0 }, signal, { now: () => time, sleep: async (ms) => { time += ms; } })).toMatchObject({ status: "denied", code: "rate_limited" });
    expect(meCalls).toBe(2); expect(itemCalls).toBe(0);
    time = start + 120000;
    await bindOwnerKey(f.relay, key);
    expect(await callOwnerApi(f.relay, tool, {}, { calls: 0 }, signal)).toMatchObject({ status: "ok" });
    expect(meCalls).toBe(3); expect(itemCalls).toBe(1);
  } finally { clock.mockRestore(); await f.close(); }
});

test("concurrent binding refusals only extend the shared key deadline", async () => {
  let time = Date.now(), meCalls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  let firstSeen!: () => void, secondSeen!: () => void, releaseFirst!: () => void, releaseSecond!: () => void;
  const first = new Promise<void>((resolve) => { firstSeen = resolve; });
  const second = new Promise<void>((resolve) => { secondSeen = resolve; });
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondResponse = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const f = await rateFixture("concurrent_delay", async () => {
    const index = meCalls++;
    if (index === 0) { firstSeen(); await firstResponse; }
    if (index === 1) { secondSeen(); await secondResponse; }
    return index < 2 ? { status: 429, body: { error: [{ code: "rate_limited", retry_after: index === 0 ? 180 : 120 }] } } : { body: { user_id: 41 } };
  });
  const key = "clst_concurrent_delay_fixture";
  try {
    const a = bindOwnerKey(f.relay, key).catch((error) => error); await first;
    const b = bindOwnerKey(f.relay, key).catch((error) => error); await second;
    releaseFirst(); expect(await a).toMatchObject({ code: "rate_limited" });
    releaseSecond(); expect(await b).toMatchObject({ code: "rate_limited" });
    const start = time; time += 110000;
    await expect(bindOwnerKey(f.relay, key)).rejects.toMatchObject({ code: "rate_limited" });
    expect(meCalls).toBe(2);
    time = start + 180000; await bindOwnerKey(f.relay, key); expect(meCalls).toBe(3);
  } finally { releaseFirst(); releaseSecond(); clock.mockRestore(); await f.close(); }
});

test("bind, discover, proxy and redact only for the paired owner", async () => {
  let origin = ""; let owner = 41; let status = 200; let calls = 0; let documents = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.startsWith("/.well-known")) return { body: { features: ["owner_api"], owner_api: { api_base: `${origin}/api/public/v1`, openapi_url: `${origin}/api/public/v1/openapi.json`, key_url: `${origin}/key`, operations: ["me", "read", "write", "outside", "header"] } } };
    if (req.url?.endsWith("openapi.json")) { documents++; return { body: { paths: {
      "/api/public/v1/me": { get: { operationId: "me" } },
      "/api/public/v1/items/{id}": { get: { operationId: "read", parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }] }, put: { operationId: "write", parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } } } } } },
      "/other": { get: { operationId: "outside" } },
      "/api/public/v1/header": { get: { operationId: "header", parameters: [{ in: "header", name: "x" }] } },
    } } }; }
    expect(req.headers.authorization).toBe(`Bearer ${sentinel}`);
    if (req.url?.endsWith("/me")) return { status, body: status === 200 ? { user_id: owner } : { error: [{ code: "unauthorized" }] } };
    calls++;
    return { status, body: { echoed: sentinel } };
  }); origin = server.origin;
  const relay = { id: "owner_fixture", origin, api_base: `${origin}/api/relay/v1`, owner: { namespace: "telegram", id: "41" } } as PairedRelay;
  updateRelayStore((store) => ({ ...store, relays: [relay] }));
  const request = requestSchema.parse({ ...sampleRequest, input: { ...sampleRequest.input, requester: { key: "u", is_admin: false, is_owner: true, can_restrict_members: false, can_delete_messages: false, is_anonymous_admin: false } } });
  try {
    await expect(bindOwnerKey(relay, sentinel)).rejects.toMatchObject({ code: "owner_api_unavailable" });
    setRelaySwitch("owner_api", true);
    await bindOwnerKey(relay, sentinel);
    expect(fs.statSync(path.join(root, "external-relay/owner-keys.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await ownerApiView(relay))).not.toContain(sentinel);
    const tools = await ownerToolsFor(relay, request);
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(await ownerToolsFor(relay, request)).toEqual(tools); expect(documents).toBe(1);
    expect(await ownerToolsFor(relay, { ...request, input: { ...request.input, requester: { ...request.input.requester!, is_owner: false, is_admin: true } } })).toEqual([]);
    const budget = { calls: 0 };
    const result = await callOwnerApi(relay, tools[0]!, { path: { id: "a/b" } }, budget, new AbortController().signal);
    expect(result.output).toContain("[redacted]"); expect(result.output).not.toContain(sentinel);
    for (let i = 1; i < 20; i++) await callOwnerApi(relay, tools[0]!, { path: { id: String(i) } }, budget, new AbortController().signal);
    expect((await callOwnerApi(relay, tools[0]!, { path: { id: "last" } }, budget, new AbortController().signal)).code).toBe("too_many_calls");
    expect(calls).toBe(20);
    owner = 42;
    await expect(bindOwnerKey(relay, sentinel)).rejects.toMatchObject({ code: "owner_mismatch" });
    expect((await ownerApiView(relay))?.state).toBe("none");
    owner = 41; await bindOwnerKey(relay, sentinel); status = 401;
    expect((await callOwnerApi(relay, tools[0]!, { path: { id: "refused" } }, { calls: 0 }, new AbortController().signal)).code).toBe("unauthorized");
    expect(await ownerToolsFor(relay, request)).toEqual([]);
  } finally { forgetOwnerKey(relay.id); await server.close(); }
});

test("rate windows are shared across runs, 429 holds peers, writes never retry an unknown fate", async () => {
  let origin = "", mode = "ok", calls = 0, time = 100000;
  const arrivals: number[] = [], waits: number[] = [];
  const server = await startTestRelay((req) => {
    if (req.url?.startsWith("/.well-known")) return { body: { features: ["owner_api"], owner_api: { api_base: `${origin}/api/public/v1`, openapi_url: `${origin}/api/public/v1/openapi.json`, key_url: `${origin}/key`, operations: ["read", "write"] } } };
    if (req.url?.endsWith("openapi.json")) return { body: { paths: { "/api/public/v1/items": { get: { operationId: "read" }, post: { operationId: "write" } } } } };
    if (req.url?.endsWith("/me")) return { body: { user_id: 41 } };
    calls++; arrivals.push(time);
    if (mode === "429") return { status: 429, body: { error: [{ code: "rate_limited", retry_after: 7 }] } };
    if (mode === "drop") return { drop: true };
    if (mode === "401") return { status: 401, body: { error: [{ code: "unauthorized" }] } };
    return { body: { status: "ok" } };
  }); origin = server.origin;
  const relay = { id: "rate_fixture", origin, api_base: `${origin}/relay/v1`, owner: { namespace: "telegram", id: "41" } } as PairedRelay;
  updateRelayStore((store) => ({ ...store, relays: [relay] }));
  const request = requestSchema.parse({ ...sampleRequest, input: { ...sampleRequest.input, requester: { key: "u", is_owner: true, is_admin: false, is_anonymous_admin: false, can_restrict_members: false, can_delete_messages: false } } });
  const runtime = { now: () => time, sleep: async (ms: number) => { waits.push(ms); time += ms; } };
  const signal = new AbortController().signal;
  try {
    setRelaySwitch("owner_api", true); await bindOwnerKey(relay, "clst_rate_fixture");
    time = Date.now() + 60001;
    const tools = await ownerToolsFor(relay, request); const read = tools.find((t) => t.effect === "read")!, write = tools.find((t) => t.effect === "action")!;
    for (let i = 0; i < 61; i++) await callOwnerApi(relay, read, {}, { calls: 0 }, signal, runtime);
    expect(calls).toBe(61); expect(waits).toEqual([60000]);
    for (const at of arrivals) expect(arrivals.filter((t) => t > at - 60000 && t <= at).length).toBeLessThanOrEqual(60);
    mode = "429"; calls = 0; waits.length = 0;
    expect((await callOwnerApi(relay, read, {}, { calls: 0 }, signal, runtime)).code).toBe("rate_limited");
    expect(calls).toBe(4); expect(waits).toEqual([7000, 7000, 7000]);
    mode = "ok"; const peerTime = time; await callOwnerApi(relay, read, {}, { calls: 0 }, signal, runtime);
    expect(time - peerTime).toBe(7000);
    mode = "drop"; calls = 0;
    expect((await callOwnerApi(relay, write, {}, { calls: 0 }, signal, runtime)).status).toBe("outcome_unknown"); expect(calls).toBe(1);
    calls = 0; await callOwnerApi(relay, read, {}, { calls: 0 }, signal, runtime); expect(calls).toBe(4);
    mode = "401"; await callOwnerApi(relay, read, {}, { calls: 0 }, signal, runtime);
    expect((await ownerApiView(relay))?.state).toBe("rejected");
  } finally { forgetOwnerKey(relay.id); await server.close(); }
});

test("binding fails closed for cross-origin discovery, malformed identity and expired keys; owner change invalidates use", async () => {
  let origin = "", remoteBase = "", expires: string | null | undefined = undefined, identity: unknown = 41, mode = "good", apiCalls = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.startsWith("/.well-known")) return { body: { features: mode === "missing" ? [] : ["owner_api"], owner_api: { api_base: remoteBase || `${origin}/api/public/v1`, openapi_url: mode === "foreign-doc" ? "https://foreign.example/openapi.json" : `${origin}/api/public/v1/openapi.json`, key_url: `${origin}/key`, operations: ["read"] } } };
    apiCalls++; return { body: { user_id: identity, ...(expires === undefined ? {} : { expires_at: expires }) } };
  }); origin = server.origin;
  const relay = { id: "binding_fixture", origin, api_base: `${origin}/relay/v1`, owner: { namespace: "telegram", id: "41" } } as PairedRelay;
  updateRelayStore((store) => ({ ...store, relays: [relay] }));
  try {
    setRelaySwitch("owner_api", true);
    remoteBase = "https://foreign.example/api/public/v1";
    await expect(bindOwnerKey(relay, "clst_binding_fixture")).rejects.toMatchObject({ code: "owner_api_unavailable" }); expect(apiCalls).toBe(0);
    remoteBase = ""; mode = "foreign-doc";
    await expect(bindOwnerKey(relay, "clst_binding_fixture")).rejects.toMatchObject({ code: "owner_api_unavailable" }); expect(apiCalls).toBe(0);
    mode = "missing"; await expect(bindOwnerKey(relay, "clst_binding_fixture")).rejects.toMatchObject({ code: "owner_api_unavailable" }); expect(apiCalls).toBe(0);
    mode = "good"; expires = "2020-01-01T00:00:00Z";
    await expect(bindOwnerKey(relay, "clst_binding_fixture")).rejects.toMatchObject({ code: "key_expired" });
    identity = true; expires = null;
    await expect(bindOwnerKey(relay, "clst_binding_fixture")).rejects.toMatchObject({ code: "malformed" });
    identity = 41; expires = undefined; await bindOwnerKey(relay, "clst_binding_fixture");
    expect((await ownerApiView(relay))?.expiresAt).toBeNull();
    updateRelayStore((store) => ({ ...store, relays: [{ ...relay, owner: { ...relay.owner, id: "42" } }] }));
    expect((await ownerApiView(relay))?.state).toBe("none");
    expect(fs.readFileSync(path.join(root, "external-relay/owner-keys.json"), "utf8")).not.toContain("clst_binding_fixture");
    await expect(bindOwnerKey({ ...relay, owner: { ...relay.owner, namespace: "other" } }, "clst_binding_fixture")).rejects.toMatchObject({ code: "owner_api_unavailable" });
  } finally { forgetOwnerKey(relay.id); await server.close(); }
});
