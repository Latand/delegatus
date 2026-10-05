import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/asks-you/key/route";
import { openRouterKeyPath, readOpenRouterApiKey } from "./settings";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
const previous = { ...process.env };
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-key-write-"));
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  delete process.env.OPENROUTER_API_KEY;
});
afterEach(() => {
  setCallerConversationResolverForTests(null);
  for (const key of ["XDG_CONFIG_HOME", "OPENROUTER_API_KEY"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/asks-you/key", { method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
test("operator writes and replaces the existing owner-only file; responses never echo", async () => {
  for (const key of ["fixture-first-key", "fixture-second-key"]) {
    const response = await PUT(request({ key }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ present: true, source: "file" });
    expect(readOpenRouterApiKey()).toBe(key);
    expect(fs.statSync(openRouterKeyPath()).mode & 0o777).toBe(0o600);
    expect(await (await GET()).text()).not.toContain(key);
  }
});
test("environment stays authoritative and refuses replacement without echo", async () => {
  expect((await PUT(request({ key: "fixture-file-key" }))).status).toBe(200);
  process.env.OPENROUTER_API_KEY = "test-env";
  const response = await PUT(request({ key: "fixture-replacement-key" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ present: true, source: "env", error: "environment_authoritative" });
  expect(readOpenRouterApiKey()).toBe("test-env");
  expect(fs.readFileSync(openRouterKeyPath(), "utf8")).toBe("fixture-file-key");
});
test("agents, cross-origin and invalid bodies are refused with no submitted key in responses", async () => {
  setCallerConversationResolverForTests(() => "fixture-conversation");
  const key = "fixture-secret-submitted";
  for (const [body, headers, status] of [
    [{ key }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) }, 403],
    [{ key }, { origin: "https://other.example" }, 403],
    [{ key: key + " \nmore" }, {}, 400],
    [{ key: key.repeat(1000) }, {}, 400],
  ] as const) {
    const response = await PUT(request(body, headers));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(key);
  }
  expect(fs.existsSync(openRouterKeyPath())).toBe(false);
});
test("replacing a symlink leaves its target intact and closes permissive old files", async () => {
  const filename = openRouterKeyPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const target = path.join(root, "untouched"); fs.writeFileSync(target, "fixture-old");
  fs.symlinkSync(target, filename);
  expect((await PUT(request({ key: "fixture-new" }))).status).toBe(200);
  expect(fs.readFileSync(target, "utf8")).toBe("fixture-old");
  expect(fs.lstatSync(filename).isSymbolicLink()).toBe(false);
  fs.chmodSync(filename, 0o644);
  expect((await PUT(request({ key: "fixture-newer" }))).status).toBe(200);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
});

test("filesystem write failure is generic and never echoes the key", async () => {
  const filename = openRouterKeyPath();
  fs.mkdirSync(filename, { recursive: true });
  const response = await PUT(request({ key: "fixture-unwritable-key" }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ present: false, source: null, error: "write_failed" });
  expect(fs.readdirSync(path.dirname(filename)).some(name => name.endsWith(".tmp"))).toBe(false);
});

for (const key of ["fixture\u200bkey", "fixture-ключ"]) test("non-ASCII key is refused without echo or file mutation", async () => {
  let response = await PUT(request({ key }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ present: false, source: null, error: "invalid_key" });
  expect(fs.existsSync(openRouterKeyPath())).toBe(false);
  expect((await PUT(request({ key: "fixture-existing-key" }))).status).toBe(200);
  response = await PUT(request({ key }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ present: true, source: "file", error: "invalid_key" });
  expect(fs.readFileSync(openRouterKeyPath(), "utf8")).toBe("fixture-existing-key");
});

test("the next write removes interrupted secret-bearing temporary files", async () => {
  const filename = openRouterKeyPath(), directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(filename + "." + crypto.randomUUID() + ".tmp", "fixture-crash-key", { mode: 0o600 });
  expect((await PUT(request({ key: "fixture-current-key" }))).status).toBe(200);
  expect(fs.readdirSync(directory)).toEqual(["openrouter-api-key"]);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
});
