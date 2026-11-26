import { fixtureForgeAccount, seedForgeCommitAccount } from "@/test-helpers/forgeCommitAccount";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import * as forgeCommitAccount from "@/lib/git/forgeCommitAccount";

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
const get = (query = "") => GET(new NextRequest(`${ORIGIN}/api/operator/settings${query}`));
const put = (body: unknown, origin = ORIGIN) => PUT(new NextRequest(`${ORIGIN}/api/operator/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin, host: "127.0.0.1:8899" },
  body: JSON.stringify(body),
}));

test("nothing is set until a client writes; a detection is kept until a choice replaces it, and never after", async () => {
  expect(await (await get()).json()).toMatchObject({ ok: true, locale: null, timeZone: null, commitAttribution: null, commitAccount: { state: "unresolved" } });

  const detected = await put({ locale: "en", source: "detected", timeZone: "Europe/Kyiv" });
  expect(detected.status).toBe(200);
  expect(await detected.json()).toMatchObject({ locale: { value: "en", source: "detected" }, timeZone: { value: "Europe/Kyiv" } });

  expect((await (await put({ locale: "uk", source: "chosen" })).json()).locale).toMatchObject({ value: "uk", source: "chosen" });
  expect((await (await put({ locale: "en", source: "detected" })).json()).locale).toMatchObject({ value: "uk", source: "chosen" });
  expect((await (await get()).json()).locale.value).toBe("uk");
});

test("a malformed write is refused, and so is a cross-origin one", async () => {
  expect((await put({ locale: "de" })).status).toBe(400);
  expect((await put({ timeZone: "Not/AZone" })).status).toBe(400);
  expect((await put({})).status).toBe(400);
  expect((await put({ locale: "en" }, "http://evil.invalid")).status).toBe(403);
});

test("plain settings GET serves cached account status; only an explicit refresh asks GitHub", async () => {
  seedForgeCommitAccount(SANDBOX);
  const refresh = spyOn(forgeCommitAccount, "resolveForgeCommitAccount").mockResolvedValue(fixtureForgeAccount as never);
  try {
    expect(await (await get()).json()).toMatchObject({ commitAccount: { state: "resolved", login: fixtureForgeAccount.login } });
    expect(refresh).not.toHaveBeenCalled();
    expect(await (await get("?refreshCommitAccount=1")).json()).toMatchObject({ commitAccount: { state: "resolved", login: fixtureForgeAccount.login } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ forceRefresh: true });
  } finally { refresh.mockRestore(); }
});

test("the attribution opt-out round-trips and only accepts booleans", async () => {
  expect((await put({ commitAttribution: "false" })).status).toBe(400);
  expect((await put({ commitAttribution: false }, "http://evil.invalid")).status).toBe(403);
  seedForgeCommitAccount(SANDBOX);
  const saved = await put({ commitAttribution: false });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ commitAttribution: { value: false } });
  expect(await (await get()).json()).toMatchObject({
    commitAttribution: { value: false }, commitAccount: { state: "resolved", login: fixtureForgeAccount.login },
  });
});
