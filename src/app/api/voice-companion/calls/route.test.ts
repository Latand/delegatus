import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { FakeLiveProvider } from "@/lib/voiceCompanion/fakeProvider";
import { fixtureBoardReads } from "@/lib/voiceCompanion/boardReads.fixture";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-calls-route-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.OPENAI_API_KEY = "";
const { CompanionStorage } = await import("@/lib/voiceCompanion/storage");
const { CompanionAdmission } = await import("@/lib/voiceCompanion/admission");
const { CompanionLiveSessions } = await import("@/lib/voiceCompanion/liveSession");
const { setCompanionSessionsForTests } = await import("@/lib/voiceCompanion/server");
const session = await import("../session/route");
const { GET } = await import("./route");
beforeEach(() => fs.rmSync(path.join(root, "state"), { recursive: true, force: true }));
afterAll(() => { setCompanionSessionsForTests(undefined); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const provider = new FakeLiveProvider();
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected send"); }, reports: () => [] });
  const service = new CompanionLiveSessions(storage, admission, fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }),
    provider, { key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20 });
  setCompanionSessionsForTests(service);
  return { service, admission, provider };
}
const headers = (extra: Record<string, string> = {}) => ({ host: "127.0.0.1", "sec-fetch-site": "same-origin", ...extra });
const list = (extra: Record<string, string> = {}) => GET(new NextRequest("http://127.0.0.1/api/voice-companion/calls", { headers: headers(extra) }));
const start = (requestId: string, extra: Record<string, string> = {}) => session.POST(new NextRequest("http://127.0.0.1/api/voice-companion/session",
  { method: "POST", headers: headers(extra), body: JSON.stringify({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId }) }));
const transcript = (sessionId: string, extra: Record<string, string> = {}) => session.GET(new NextRequest(`http://127.0.0.1/api/voice-companion/session?sessionId=${sessionId}&view=transcript`, { headers: headers(extra) }));

test("the operator lists their retained calls without knowing an id, and each listed call opens through the session route", async () => {
  const f = fixture();
  expect(await (await list()).json()).toEqual({ calls: [] });
  const minted = await (await start("history-a")).json();
  f.admission.record(minted.sessionId, { id: "tool-read", kind: "tool", atMs: 400, data: { name: "list_tasks", callId: "read", status: "done", arguments: "{}" } });
  await f.service.close(minted.sessionId);
  const answer = await list();
  expect(answer.status).toBe(200);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  const { calls } = await answer.json();
  expect(calls).toEqual([expect.objectContaining({ sessionId: minted.sessionId, live: false, project: expect.any(String), actions: [expect.objectContaining({ kind: "tool", name: "list_tasks", status: "done" })] })]);
  const record = await transcript(calls[0].sessionId);
  expect(record.status).toBe(200);
  /* The record names its own call, so a picker shows which one is open. */
  expect(await record.json()).toMatchObject({ sessionId: minted.sessionId, entries: expect.any(Array) });
  /* Only a browser in Delegatus reads it. */
  expect((await list({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await list({ "x-llv-spawn-capability": "invalid-agent" })).status).toBe(403);
});

test("a listed call whose state row is gone still opens through the session route, to its owner only", async () => {
  const f = fixture();
  const minted = await (await start("history-journal")).json();
  f.admission.record(minted.sessionId, { id: "tool-read", kind: "tool", atMs: 400, data: { name: "list_tasks", callId: "read", status: "done", arguments: "{}" } });
  await f.service.close(minted.sessionId);
  f.service.storage.change(document => { delete document.sessions[minted.sessionId]; });
  const { calls } = await (await list()).json();
  expect(calls.map((call: { sessionId: string }) => call.sessionId)).toEqual([minted.sessionId]);
  const record = await transcript(minted.sessionId);
  expect(record.status).toBe(200);
  expect(await record.json()).toMatchObject({ sessionId: minted.sessionId, entries: expect.arrayContaining([expect.objectContaining({ id: "tool-read" })]) });
  /* Only the transcript view reads a journal alone; events need the call's state. */
  expect((await session.GET(new NextRequest(`http://127.0.0.1/api/voice-companion/session?sessionId=${minted.sessionId}&after=0`, { headers: headers() }))).status).toBe(409);
});

test("a team member lists only the calls they started; another member and an anonymous browser read none of them", async () => {
  const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { MEMBER_COOKIE } = await import("@/lib/team/sessions");
  resetTeamStoreForTests();
  try {
    const store = teamStore();
    const device = { surface: "desktop" as const, browser: "chrome" as const };
    const owner = claimInstall(store, "Owner", device);
    const starter = redeemJoin(store, createInvite(store, owner.member, null).code, "Starter", device);
    const cookie = (value: string) => ({ cookie: `${MEMBER_COOKIE}=${value}` });
    const f = fixture();
    const mine = await (await start("team-history-a", cookie(starter.cookie))).json();
    await f.service.close(mine.sessionId);
    const theirs = await (await start("team-history-b", cookie(owner.cookie))).json();
    await f.service.close(theirs.sessionId);
    /* Read from the journal alone, a call stays its starter's as well. */
    f.service.storage.change(document => { delete document.sessions[mine.sessionId]; });
    expect((await (await list(cookie(starter.cookie))).json()).calls.map((call: { sessionId: string }) => call.sessionId)).toEqual([mine.sessionId]);
    expect((await (await list(cookie(owner.cookie))).json()).calls.map((call: { sessionId: string }) => call.sessionId)).toEqual([theirs.sessionId]);
    expect(JSON.stringify(await (await list(cookie(owner.cookie))).json())).not.toContain(mine.sessionId);
    const anonymous = await list();
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ code: "MEMBER_REQUIRED" });
    /* A listed id is no authority either: the record stays its starter's. */
    expect((await transcript(mine.sessionId, cookie(owner.cookie))).status).toBe(401);
    store.updateMember({ ...starter.member, status: "revoked", revokedAt: new Date().toISOString() });
    expect((await list(cookie(starter.cookie))).status).toBe(401);
  } finally { resetTeamStoreForTests(); }
});
