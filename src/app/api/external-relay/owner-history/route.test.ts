import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { setCallerConversationResolverForTests, internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { historyOwnerRun } from "@/lib/externalRelay/ownerHistory.caller.fixture";
import { historyDouble } from "@/lib/externalRelay/ownerHistory.fixture";
import { setRelaySwitch } from "@/lib/externalRelay/switches";
import { updateOperatorSettings } from "@/lib/operator/settings";
import { externalRelayFile } from "@/lib/externalRelay/store";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { teamStore, resetTeamStoreForTests } from "@/lib/team/store";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-route-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const double = await historyDouble();
double.relay.targets[0]!.ownerTier = true;
afterAll(async () => { setCallerConversationResolverForTests(null); resetTeamStoreForTests(); await double.close(); fs.rmSync(root, { recursive: true, force: true }); });
const request = (body: unknown = { op: "groups" }, headers: Record<string,string> = {}) => new NextRequest("http://127.0.0.1/api/external-relay/owner-history", {
  method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
/** The local operator's browser holds the session cookie its page navigation opened. */
const operator = () => ({ cookie: `llv_operator=${soloBrowserSession()}` });
function pair() {
  fs.mkdirSync(path.dirname(externalRelayFile("relays")), { recursive: true });
  fs.writeFileSync(externalRelayFile("relays"), JSON.stringify({ v: 1, relays: [double.relay], pending: [] }));
  setRelaySwitch("relay:owner_tools:enabled", true);
}
test("ordinary worker, seat, root and local operator reach real history with no-store", async () => {
  pair();
  for (const conversation of ["conversation_worker", "conversation_seat", "conversation_root", null]) {
    setCallerConversationResolverForTests(() => conversation);
    const response = await POST(request({ op: "groups" }, conversation ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) } : operator()));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text(); expect(body).toContain("Example group 1"); expect(body).not.toContain(double.credential);
  }
});
test("stored operator IANA zone drives the actual route's today window", async () => {
  pair(); setCallerConversationResolverForTests(() => null);
  expect(updateOperatorSettings({ timeZone: "Europe/Kyiv" })).not.toBeNull();
  const response = await POST(request({ op: "messages", chat: "-101", limit: 1 }, operator()));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ available: true, timeZone: "Europe/Kyiv", start: "2026-10-12T00:00:00+03:00" });
  expect(double.state.exchanges.at(-1)!.request.query).toEqual([["tz", "Europe/Kyiv"], ["limit", "1"]]);
});
test("owner-tools OFF during the real route request returns no groups or messages", async () => {
  setCallerConversationResolverForTests(() => null);
  try {
    for (const body of [{ op: "groups" }, { op: "messages", chat: "-101" }]) {
      pair();
      double.state.afterHistoryResponse = () => setRelaySwitch("relay:owner_tools:enabled", false);
      const before = double.state.requests;
      const response = await POST(request(body, operator()));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available: false, reason: "switch_off" });
      expect(double.state.requests).toBe(before + 1);
    }
  } finally { double.state.afterHistoryResponse = null; setRelaySwitch("relay:owner_tools:enabled", true); }
});
test("Telegram reply refuses at route before network and admits the same conversation after completion", async () => {
  const end = historyOwnerRun("conversation_reply"); pair();
  setCallerConversationResolverForTests(() => "conversation_reply");
  const before = double.state.requests;
  const response = await POST(request({ op: "groups" }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) }));
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "owner_history_refused" }); expect(double.state.requests).toBe(before);
  end(); expect((await POST(request({ op: "groups" }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) }))).status).toBe(200);
});
test("cross-origin, staging on both caller paths and malformed bodies refuse", async () => {
  const before = double.state.requests;
  expect((await POST(request({ op: "groups" }, { origin: "https://foreign.example" }))).status).toBe(403);
  process.env.LLV_STAGING = "1";
  try {
    for (const conversation of [null, "conversation_worker"]) {
      setCallerConversationResolverForTests(() => conversation);
      expect((await POST(request({ op: "groups" }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43), ...(conversation ? {} : operator()) }))).status).toBe(409);
    }
  } finally { delete process.env.LLV_STAGING; }
  setCallerConversationResolverForTests(() => null);
  expect((await POST(request({ op: "unknown" }, operator()))).status).toBe(400);
  expect((await POST(new NextRequest("http://127.0.0.1/api/external-relay/owner-history", { method: "POST", headers: { host: "127.0.0.1", ...operator() }, body: "broken" }))).status).toBe(400);
  expect(double.state.requests).toBe(before);
});
test("team owner and MCP service admit; anonymous and other member browsers refuse", async () => {
  resetTeamStoreForTests();
  const store = teamStore(), device = { surface: "desktop" as const, browser: "chrome" as const };
  const owner = claimInstall(store, "Example owner", device);
  const member = redeemJoin(store, createInvite(store, owner.member, "Example member").code, "Example member", device);
  setCallerConversationResolverForTests(() => null);
  const before = double.state.requests;
  for (const headers of [{}, { cookie: `${MEMBER_COOKIE}=${member.cookie}` }] as Array<Record<string, string>>) expect((await POST(request({ op: "groups" }, headers))).status).toBe(403);
  expect(double.state.requests).toBe(before);
  expect((await POST(request({ op: "groups" }, { cookie: `${MEMBER_COOKIE}=${owner.cookie}` }))).status).toBe(200);
  expect((await POST(request({ op: "groups" }, internalServiceHeaders("mcp")))).status).toBe(200);
});
