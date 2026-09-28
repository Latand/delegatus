import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { NextRequest } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { claimInstall } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { proxy } from "@/proxy";

import { GET, POST } from "./route";

const names = ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "LLV_TOKEN", "LLV_PUBLIC_HOST"] as const;
const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-links-api-"));
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.LLV_STATE_DIR = path.join(root, "state");
  resetTeamStoreForTests();
  delete process.env.LLV_TOKEN;
  delete process.env.LLV_PUBLIC_HOST;
});
afterEach(() => {
  resetTeamStoreForTests();
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

test("a team owner can bootstrap the first public Host with a member session", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  const owner = claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
  const publicHost = "board.example.test";
  const settings = (method: "GET" | "POST", body?: object, cookie = owner.cookie) =>
    new NextRequest(`https://${publicHost}/api/links`, {
      method, headers: { host: publicHost, origin: `https://${publicHost}`, cookie: `${MEMBER_COOKIE}=${cookie}`,
        ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(proxy(settings("GET")).headers.get("x-middleware-next")).toBe("1");
  expect(rejectCrossOrigin(settings("GET"))?.status).toBe(403);
  expect((await GET(settings("GET"))).status).toBe(200);
  expect((await GET(settings("GET", undefined, "invalid"))).status).toBe(403);
  const saved = await POST(settings("POST", { action: "save", publicUrl: `https://${publicHost}` }));
  expect(saved.status).toBe(200);
  expect((await saved.json()).self.publicUrl).toBe(`https://${publicHost}`);
});

test("an older Save cannot overwrite a newer Save that clears the address", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  let arrived!: () => void;
  let release!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = http.createServer((incoming, response) => {
    arrived();
    void gate.then(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ host: incoming.headers.host, vouched: false }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("missing test port");
  try {
    const older = POST(request({ action: "save", publicUrl: `http://127.0.0.1:${bound.port}`, label: "older" }));
    await arrival;
    const newer = await POST(request({ action: "save", publicUrl: "", label: "newer" }));
    expect((await newer.json()).self).toMatchObject({ publicUrl: null, label: "newer", check: null });
    release();
    expect((await older).status).toBe(200);
    const current = await GET(new NextRequest("http://localhost/api/links", { headers: { host: "localhost" } }));
    expect((await current.json()).self).toMatchObject({ publicUrl: null, label: "newer", check: null });
    expect(process.env.LLV_PUBLIC_HOST).toBe("");
  } finally { release(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 10_000);

test("Save and Check finish when the self-check response closes after its headers", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  const server = http.createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
    response.write('{"host":"127.0.0.1",');
    setImmediate(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("missing test port");
  const withinFourSeconds = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("settings route stayed pending")), 4000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const saved = await withinFourSeconds(POST(request({ action: "save", publicUrl: `http://127.0.0.1:${bound.port}` })));
    expect(saved.status).toBe(200);
    expect((await saved.json()).self.check.code).toBe("unverified");
    const checked = await withinFourSeconds(POST(request({ action: "check" })));
    expect(checked.status).toBe(200);
    expect((await checked.json()).check.code).toBe("unverified");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 10_000);

test("the settings route does not report ok when reach omits or mistypes vouched", async () => {
  process.env.LLV_TOKEN = "test-access-key";
  let vouched: unknown;
  const server = http.createServer((incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ host: incoming.headers.host, ...(vouched === undefined ? {} : { vouched }) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("missing test port");
  try {
    for (vouched of [undefined, "false"]) {
      const saved = await POST(request({ action: "save", publicUrl: `http://127.0.0.1:${bound.port}` }));
      expect(saved.status).toBe(200);
      expect((await saved.json()).self.check.code).toBe("unverified");
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
