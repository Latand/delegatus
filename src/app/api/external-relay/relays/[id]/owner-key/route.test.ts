import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { PUT, DELETE } from "./route";
import { setRelaySwitch } from "@/lib/externalRelay/switches";
import { updateRelayStore, type PairedRelay } from "@/lib/externalRelay/store";
import { startTestRelay } from "@/lib/externalRelay/testRelay";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-owner-route-")); process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const origin = "http://127.0.0.1:8899";
const request = (method: string, body?: object, foreign = false) => new NextRequest(`${origin}/api/external-relay/relays/test/owner-key`, { method, headers: { origin: foreign ? "https://foreign.example" : origin, host: "127.0.0.1:8899", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const context = { params: Promise.resolve({ id: "test" }) };
test("operator guard, dark key route and write-only binding response", async () => {
  const sentinel = "clst_route_fixture_sentinel";
  expect((await PUT(request("PUT", { key: sentinel }, true), context)).status).toBe(403);
  expect(await (await PUT(request("PUT", { key: sentinel }), context)).json()).toEqual({ error: "owner_api_unavailable" });
  let remote = "";
  const server = await startTestRelay((req) => {
    if (req.url?.startsWith("/.well-known")) return { body: { features: ["owner_api"], owner_api: { api_base: `${remote}/api/public/v1`, openapi_url: `${remote}/api/public/v1/openapi.json`, key_url: `${remote}/key`, operations: ["read"] } } };
    expect(req.headers.authorization).toBe(`Bearer ${sentinel}`); return { body: { user_id: 41 } };
  }); remote = server.origin;
  updateRelayStore((store) => ({ ...store, relays: [{ id: "test", origin: remote, api_base: `${remote}/relay/v1`, owner: { namespace: "telegram", id: "41" } } as PairedRelay] }));
  try {
    setRelaySwitch("owner_api", true);
    const response = await PUT(request("PUT", { key: sentinel }), context); const text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain(sentinel); expect(text).not.toContain("user_id"); expect(Object.keys(JSON.parse(text))).toEqual(["ownerApi"]);
    expect((await (await DELETE(request("DELETE"), context)).json()).ownerApi.state).toBe("none");
    process.env.LLV_STAGING = "1";
    expect((await PUT(request("PUT", { key: sentinel }), context)).status).toBe(409);
  } finally { delete process.env.LLV_STAGING; await server.close(); }
});
