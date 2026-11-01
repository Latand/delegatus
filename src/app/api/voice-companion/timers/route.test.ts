import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-timer-routes-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { GET, POST } = await import("./route");
const { VoiceTimers } = await import("@/lib/voiceCompanion/voiceTimers");
const { setVoiceTimersForTests } = await import("@/lib/voiceCompanion/voiceTimersServer");
const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { MEMBER_COOKIE } = await import("@/lib/team/sessions");
afterAll(() => { setVoiceTimersForTests(undefined); resetTeamStoreForTests(); fs.rmSync(root, { recursive: true, force: true }); });

const START = Date.UTC(2026, 10, 1, 8, 5);
function request(method: string, body?: unknown, extra: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/voice-companion/timers", { method, headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", "sec-fetch-site": "same-origin", ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
function installed() {
  const clock = { now: START };
  const timers = new VoiceTimers({ now: () => clock.now, schedule: () => ({ cancel() {} }), ownsTraffic: () => true, liveCall: () => false, isOperator: () => false, telegramChosen: () => false,
    timeZone: () => "Europe/Kyiv", push: async () => "none", telegram: async () => "none" });
  setVoiceTimersForTests(timers);
  return { clock, timers };
}

// Solo first: the team case below turns this install into a team for good.
test("in a solo install the operator reads and claims their timer, and a malformed claim is refused before it reads anything", async () => {
  const { clock, timers } = installed();
  for (const body of [{ action: "claim", id: "../other", locale: "en" }, { action: "claim", id: "vt_0123456789abcdef", locale: "fr" }, { action: "cancel", id: "vt_0123456789abcdef", locale: "en" }])
    expect((await POST(request("POST", body))).status).toBe(400);
  const set = await timers.set({ owner: { operator: true }, sessionId: "session_solo", callId: "call_solo", delegationId: "delegation_solo", minutes: 1, label: null, locale: "en", private: false });
  if (set.state === "limit") throw new Error("not set");
  clock.now = START + 60_000;
  timers.start();
  await timers.settled();
  expect(await (await GET(request("GET"))).json()).toEqual({ claimable: [set.timer.id], nextInMs: null });
  expect(await (await POST(request("POST", { action: "claim", id: set.timer.id, locale: "en" }))).json()).toEqual({ claimed: true, title: "Timer is up", text: "The 1-minute timer, set at 10:05, is up." });
  timers.stop();
});

test("the toast route is the owner's alone: agents and other origins are refused, a member reads and claims only their own", async () => {
  expect((await GET(request("GET", undefined, { "x-llv-spawn-capability": "fixture" }))).status).toBe(403);
  expect((await POST(request("POST", { action: "claim", id: "vt_0123456789abcdef", locale: "en" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  resetTeamStoreForTests();
  const owner = claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
  const other = redeemJoin(teamStore(), createInvite(teamStore(), owner.member, "Other").code, "Other", { surface: "desktop", browser: "chrome" });
  expect((await GET(request("GET"))).status).toBe(401);
  const { clock, timers } = installed();
  const set = await timers.set({ owner: { memberId: owner.member.id }, sessionId: "session_a", callId: "call_a", delegationId: "delegation_a", minutes: 5, label: "tea", locale: "en", private: false });
  if (set.state === "limit") throw new Error("not set");
  const mine = { cookie: `${MEMBER_COOKIE}=${owner.cookie}` };
  const theirs = { cookie: `${MEMBER_COOKIE}=${other.cookie}` };
  const before = await GET(request("GET", undefined, mine));
  expect(before.headers.get("Cache-Control")).toBe("no-store");
  expect(await before.json()).toEqual({ claimable: [], nextInMs: 300_000 });
  clock.now = START + 300_000;
  timers.start();
  await timers.settled();
  expect(await (await GET(request("GET", undefined, theirs))).json()).toEqual({ claimable: [], nextInMs: null });
  expect(await (await GET(request("GET", undefined, mine))).json()).toEqual({ claimable: [set.timer.id], nextInMs: null });
  expect(await (await POST(request("POST", { action: "claim", id: set.timer.id, locale: "en" }, theirs))).json()).toEqual({ claimed: false });
  expect(await (await POST(request("POST", { action: "claim", id: set.timer.id, locale: "uk" }, mine))).json()).toEqual({ claimed: true, title: "Таймер сплив", text: "Таймер «tea» на 5 хвилин, поставлений о 10:05, сплив." });
  expect(await (await POST(request("POST", { action: "claim", id: set.timer.id, locale: "en" }, mine))).json()).toEqual({ claimed: false });
  timers.stop();
  resetTeamStoreForTests();
});
