import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
let root: string;
const old = process.env.LLV_STATE_DIR;
const oldDnt = process.env.DO_NOT_TRACK;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ping-api-")); process.env.LLV_STATE_DIR = root; delete process.env.DO_NOT_TRACK; });
afterEach(() => { if (old === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = old;
  if (oldDnt === undefined) delete process.env.DO_NOT_TRACK; else process.env.DO_NOT_TRACK = oldDnt;
  fs.rmSync(root, { recursive: true, force: true }); });
function put(body: unknown, origin?: string) { return PUT(new NextRequest("http://localhost/api/telemetry", { method: "PUT", headers: { "Content-Type": "application/json", Host: "localhost", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })); }
test("real API saves switch, acknowledges notice, and environment overrides", async () => {
  expect(await (await GET()).json()).toMatchObject({ enabled: true, noticeDismissed: false });
  expect(await (await put({ enabled: false })).json()).toMatchObject({ enabled: false });
  expect(await (await GET()).json()).toMatchObject({ enabled: false });
  expect(await (await put({ noticeDismissed: true })).json()).toMatchObject({ enabled: false, noticeDismissed: true });
  process.env.DO_NOT_TRACK = "1";
  expect(await (await put({ enabled: true })).json()).toMatchObject({ enabled: false, locked: true });
});
test.each([null, [], {}, { enabled: "false" }, { noticeDismissed: 1 }, { enabled: true, id: "forbidden" }])("refuses invalid writes", async body => {
  expect((await put(body)).status).toBe(400);
});
test("refuses cross-origin changes", async () => {
  expect((await put({ enabled: false }, "https://other.example")).status).toBe(403);
  expect((await GET()).headers.get("Cache-Control")).toBe("no-store");
});

test("swarm consent defaults off, persists independently and ignores ping environment overrides", async () => {
  expect(await (await GET()).json()).toMatchObject({ swarmRules: false });
  expect(await (await put({ swarmRules: true })).json()).toMatchObject({ swarmRules: true, enabled: true });
  process.env.DO_NOT_TRACK = "1";
  expect(await (await GET()).json()).toMatchObject({ swarmRules: true, enabled: false, locked: true });
  expect(await (await put({ noticeDismissed: true })).json()).toMatchObject({ swarmRules: true, noticeDismissed: true });
  expect(await (await put({ swarmRules: false })).json()).toMatchObject({ swarmRules: false });
});

test.each([{ swarmRules: "true" }, { swarmRules: null }, { swarmRules: true, upload: true }])("invalid swarm consent changes no preference", async body => {
  const result = await put(body);
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "Invalid setting" });
  expect(await (await GET()).json()).toMatchObject({ swarmRules: false });
});

test("the origin gate refuses swarm consent and a valid origin control reaches the write", async () => {
  const denied = await put({ swarmRules: true }, "https://other.example");
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "forbidden: cross-origin request" });
  expect(await (await GET()).json()).toMatchObject({ swarmRules: false });
  expect((await put({ swarmRules: true }, "http://localhost")).status).toBe(200);
  expect(await (await GET()).json()).toMatchObject({ swarmRules: true });
});
