import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { GET, PUT } from "./route";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";

const old = process.env.LLV_STATE_DIR;
const roots: string[] = [];
afterEach(() => { resetTeamStoreForTests(); process.env.LLV_STATE_DIR = old; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function isolated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consent-route-")); roots.push(root); process.env.LLV_STATE_DIR = root; return root;
}
function request(body?: unknown, extra: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/subscription-api-consent", { method: body === undefined ? "GET" : "PUT", headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", "sec-fetch-site": "same-origin", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
test("operator consent starts off, saves exactly a boolean, and can be revoked", async () => {
  isolated(); expect(await (await GET(request())).json()).toMatchObject({ enabled: false });
  expect(await (await PUT(request({ enabled: true }))).json()).toMatchObject({ enabled: true, source: "operator" });
  expect(await (await PUT(request({ enabled: false }))).json()).toMatchObject({ enabled: false, source: "operator" });
});
test("authority is rechecked after reading the submitted body", async () => {
  const root = isolated(); const req = request({ enabled: true });
  req.json = async () => { req.headers.set(VIEWER_SPAWN_CAPABILITY_HEADER, "unregistered-agent"); return { enabled: true }; };
  expect((await PUT(req)).status).toBe(403);
  expect(fs.existsSync(path.join(root, "subscription-api-consent.json"))).toBe(false);
});
test("team members cannot change installation consent and the owner can", async () => {
  isolated(); const store = teamStore();
  const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" });
  const member = redeemJoin(store, createInvite(store, owner.member, null).code, "Member", { surface: "phone", browser: "safari" });
  const as = (cookie: string) => ({ cookie: `${MEMBER_COOKIE}=${cookie}` });
  expect((await GET(request(undefined, as(member.cookie)))).status).toBe(403);
  expect((await PUT(request({ enabled: true }, as(member.cookie)))).status).toBe(403);
  expect((await GET(request(undefined, as(owner.cookie)))).status).toBe(200);
  expect((await PUT(request({ enabled: true }, as(owner.cookie)))).status).toBe(200);
});
for (const headers of [{ host: "example.invalid" }, { origin: "https://example.invalid" }, { "sec-fetch-site": "cross-site" }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "unregistered-agent" }] as Record<string, string>[]) test(`untrusted request is refused before reading or migrating settings: ${Object.keys(headers)[0]}`, async () => {
  const root = isolated();
  expect((await GET(request(undefined, headers))).status).toBe(403);
  expect((await PUT(request({ enabled: true }, headers))).status).toBe(403);
  expect(fs.existsSync(path.join(root, "subscription-api-consent.json"))).toBe(false);
});
for (const body of [{ enabled: "true" }, { enabled: 1 }, { enabled: true, source: "migration" }, {}, [], null]) test(`invalid consent shape ${JSON.stringify(body)}`, async () => {
  const root = isolated(); expect((await PUT(request(body))).status).toBe(400);
  expect(fs.existsSync(path.join(root, "subscription-api-consent.json"))).toBe(false);
});
