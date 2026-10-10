import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-routes-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
delete process.env.OPENAI_API_KEY;
const { GET, PUT } = await import("./route");
const { PUT: keyPUT } = await import("../key/route");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function request(method: string, body?: unknown, extra: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/voice-companion/settings", { method, headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
test("settings and the write-only key route enforce operator authority and never echo a key", async () => {
  expect(await (await GET(request("GET"))).json()).toMatchObject({ enabled: false, keySource: "missing" });
  expect((await PUT(request("PUT", { enabled: true }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  expect((await keyPUT(request("PUT", { key: "synthetic-credential" }, { "x-llv-spawn-capability": "invalid-agent-claim" }))).status).toBe(403);
  const response = await keyPUT(request("PUT", { key: "synthetic-credential" }));
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("synthetic-credential");
  process.env.OPENAI_API_KEY = "env-test";
  const locked = await keyPUT(request("PUT", { key: "replacement" }));
  expect(locked.status).toBe(409);
  expect(await locked.json()).toEqual({ code: "KEY_FROM_ENV" });
  delete process.env.OPENAI_API_KEY;
  expect(await (await PUT(request("PUT", { enabled: true, monthlyCapUsd: 0 }))).json()).toMatchObject({ enabled: true, monthlyCapUsd: 0 });
});

test("no settings request can choose a simulator: a backend, the demo or the real voice by name, is refused and nothing changes", async () => {
  await PUT(request("PUT", { enabled: false, monthlyCapUsd: 20 }));
  for (const body of [{ backend: "demo" }, { enabled: true, backend: "demo" }, { backend: "official-realtime" }, { backend: "simulated" }]) {
    const response = await PUT(request("PUT", body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_SETTINGS" });
  }
  const settings = await (await GET(request("GET"))).json() as Record<string, unknown>;
  expect(settings).toMatchObject({ enabled: false, monthlyCapUsd: 20 });
  expect(settings).not.toHaveProperty("backend");
});
