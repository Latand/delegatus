import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { GET, POST } from "./route";

const names = ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "LLV_TOKEN", "LLV_PUBLIC_HOST"] as const;
const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-links-api-"));
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.LLV_STATE_DIR = path.join(root, "state");
  delete process.env.LLV_TOKEN;
  delete process.env.LLV_PUBLIC_HOST;
});
afterEach(() => {
  for (const name of names) {
    if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const request = (body: object) => new NextRequest("http://localhost/api/links", {
  method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
});

test("the settings route refuses a network address until its key is on", async () => {
  const before = await GET(new NextRequest("http://localhost/api/links", { headers: { host: "localhost" } }));
  expect(await before.json()).toMatchObject({ keyOn: false, state: "needs-access-key" });
  expect(fs.existsSync(path.join(root, "state/links/self.json"))).toBe(false);
  const refused = await POST(request({ action: "save", publicUrl: "http://169.254.0.123:8898" }));
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe("needs-access-key");
  const enabled = await POST(request({ action: "key" }));
  expect(enabled.status).toBe(200);
  expect(enabled.cookies.get("llv_auth")?.value).toBe(process.env.LLV_TOKEN);
  expect(JSON.stringify(await enabled.json())).not.toContain(process.env.LLV_TOKEN!);
  const checked = await POST(request({ action: "check" }));
  expect(await checked.json()).toMatchObject({ keyOn: true, state: null });
  const httpPublic = await POST(request({ action: "save", publicUrl: "http://203.0.113.10" }));
  expect((await httpPublic.json()).error).toBe("http-public");
});

test("an authenticated public origin bootstraps its own Host pin through Settings", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  const publicHost = "board.example.test";
  const settings = (method: "GET" | "POST", body?: object, headers: Record<string, string> = {}) =>
    new NextRequest(`https://${publicHost}/api/links`, {
      method, headers: { host: publicHost, cookie: "llv_auth=test-access-key", origin: `https://${publicHost}`, ...headers,
        ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(rejectCrossOrigin(settings("GET"))?.status).toBe(403);
  const initial = await GET(settings("GET"));
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({ self: null, keyOn: true });
  expect((await GET(settings("GET", undefined, { cookie: "" }))).status).toBe(403);
  expect((await POST(settings("POST", { action: "save", publicUrl: "https://board.example.test" },
    { origin: "https://other.example.test" }))).status).toBe(403);
  const saved = await POST(settings("POST", { action: "save", publicUrl: "https://board.example.test" }));
  expect(saved.status).toBe(200);
  expect((await saved.json()).self.publicUrl).toBe("https://board.example.test");
  expect(rejectCrossOrigin(settings("GET"))).toBeNull();
  expect((await GET(settings("GET", undefined, { host: "other.example.test" }))).status).toBe(403);
});
