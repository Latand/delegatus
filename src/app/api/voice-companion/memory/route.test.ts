import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
const root = fs.mkdtempSync(path.join(os.tmpdir(),"voice-memory-routes-"));
process.env.LLV_STATE_DIR = path.join(root,"state"); process.env.XDG_CONFIG_HOME = path.join(root,"config");
const { GET, DELETE } = await import("./route");
const { companionSessions, setCompanionSessionsForTests } = await import("@/lib/voiceCompanion/server");
const { CallMemory } = await import("@/lib/voiceCompanion/callMemory");
const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { MEMBER_COOKIE } = await import("@/lib/team/sessions");
afterAll(() => { setCompanionSessionsForTests(undefined); resetTeamStoreForTests(); fs.rmSync(root,{ recursive:true,force:true }); });
function request(method: string,body?: unknown,headers: Record<string,string> = {}) { return new NextRequest("http://127.0.0.1/api/voice-companion/memory",{ method,headers: { host: "127.0.0.1","sec-fetch-site": "same-origin",...headers },...(body ? { body: JSON.stringify(body) } : {}) }); }
test("memory authority blocks agents and cross-origin requests; starter scopes reads and clears", async () => {
  expect((await GET(request("GET",undefined,{ "x-llv-spawn-capability": "fixture" }))).status).toBe(403);
  expect((await DELETE(request("DELETE",{ all:true },{ "sec-fetch-site": "cross-site" }))).status).toBe(403);
  resetTeamStoreForTests(); const owner = claimInstall(teamStore(),"Owner",{ surface: "desktop",browser: "chrome" });
  const service = companionSessions(); const session = service.admission.create({ project: "fixture",locale:"en",startedBy: { memberId: owner.member.id } });
  service.admission.record(session.id,{ id:"speech",kind:"utterance",atMs:0,data: { text:"Keep the layout.",final:true } });
  service.admission.emit(session.id,{ type:"session.closed",reason:"operator",incomplete:false }); service.admission.retire(session.id);
  const memory = new CallMemory(service.storage,service.admission.records,async () => ({ answer: { asked:["Keep the layout."],done:[],decided:[],open:[] },model:"fixture",durationMs:1,inputTokens:1,outputTokens:1 }));
  memory.trigger(session.id); await memory.drain();
  expect((await GET(request("GET"))).status).toBe(401);
  const cookie = { cookie: `${MEMBER_COOKIE}=${owner.cookie}` };
  const response = await GET(request("GET",undefined,cookie)); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await response.json()).calls).toHaveLength(1);
  // A different active member cannot clear this call by guessing its id.
  const invite = createInvite(teamStore(),owner.member,"Other");
  const other = redeemJoin(teamStore(),invite.code,"Other",{ surface:"desktop",browser:"chrome" });
  const otherCookie = { cookie: `${MEMBER_COOKIE}=${other.cookie}` };
  expect((await (await GET(request("GET",undefined,otherCookie))).json()).calls).toEqual([]);
  expect((await DELETE(request("DELETE",{ sessionId:session.id },otherCookie))).status).toBe(409);
  expect((await DELETE(request("DELETE",{ sessionId:session.id },cookie))).status).toBe(200);
  expect(service.admission.records.summary(session.id)?.state).toBe("cleared");
  expect((await DELETE(request("DELETE",{ all:true,sessionId:session.id },cookie))).status).toBe(400);
  expect((await DELETE(request("DELETE",{ all:true },cookie))).status).toBe(200);
});
