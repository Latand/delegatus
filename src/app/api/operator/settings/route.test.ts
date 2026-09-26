import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* docs/design/orchestrator-reports.md §4.2: the client writes the interface
   language and the time zone here, and the server keeps a choice over a
   detection. A sandboxed state directory, pinned before the store loads. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-settings-route-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;

const { GET, PUT } = await import("./route");

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:8899";
const put = (body: unknown, origin = ORIGIN) => PUT(new NextRequest(`${ORIGIN}/api/operator/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin, host: "127.0.0.1:8899" },
  body: JSON.stringify(body),
}));

test("nothing is set until a client writes; a detection is kept until a choice replaces it, and never after", async () => {
  expect(await (await GET()).json()).toEqual({ ok: true, locale: null, timeZone: null });

  const detected = await put({ locale: "en", source: "detected", timeZone: "Europe/Kyiv" });
  expect(detected.status).toBe(200);
  expect(await detected.json()).toMatchObject({ locale: { value: "en", source: "detected" }, timeZone: { value: "Europe/Kyiv" } });

  expect((await (await put({ locale: "uk", source: "chosen" })).json()).locale).toMatchObject({ value: "uk", source: "chosen" });
  expect((await (await put({ locale: "en", source: "detected" })).json()).locale).toMatchObject({ value: "uk", source: "chosen" });
  expect((await (await GET()).json()).locale.value).toBe("uk");
});

test("a malformed write is refused, and so is a cross-origin one", async () => {
  expect((await put({ locale: "de" })).status).toBe(400);
  expect((await put({ timeZone: "Not/AZone" })).status).toBe(400);
  expect((await put({})).status).toBe(400);
  expect((await put({ locale: "en" }, "http://evil.invalid")).status).toBe(403);
});
